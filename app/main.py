from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import struct
import sys
from array import array
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("VAANI_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
OBJECTS = ROOT / "objects"
DATABASE = ROOT / "vaani.db"
STATIC = Path(__file__).resolve().parent / "static"
ALLOWED_OBJECTS = {"events.jsonl", "caller.audio", "agent.audio"}
# A local safety ceiling; production should use direct object storage limits instead.
MAX_UPLOAD_BYTES = 128 * 1024 * 1024


def now() -> str:
    return datetime.now(UTC).isoformat()


def initialize() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    OBJECTS.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, status TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS operations (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation_json TEXT NOT NULL,
              started_at_ms INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id)
            );
            CREATE INDEX IF NOT EXISTS operations_timeline ON operations(session_id, started_at_ms);
            """
        )
        # turn_id and scope are promoted out of the JSON blob so grouping by turn
        # is an indexed query rather than a full-table JSON scan.
        columns = {row["name"] for row in db.execute("PRAGMA table_info(operations)")}
        if "turn_id" not in columns:
            db.execute("ALTER TABLE operations ADD COLUMN turn_id TEXT")
        if "scope" not in columns:
            db.execute("ALTER TABLE operations ADD COLUMN scope TEXT NOT NULL DEFAULT 'turn'")
        db.execute(
            "CREATE INDEX IF NOT EXISTS operations_turns ON operations(session_id, turn_id, started_at_ms)"
        )


@contextmanager
def connect():
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    try:
        yield db
        db.commit()
    finally:
        db.close()


class SessionCreate(BaseModel):
    schema_version: str = "1.0"
    session_id: str = Field(min_length=1, max_length=160)
    agent_id: str | None = None
    started_at: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    outcome: str = "unknown"
    capture_status: dict[str, Any] = Field(default_factory=dict)
    audio: dict[str, dict[str, Any]] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    sdk: dict[str, Any] = Field(default_factory=dict)


class ObjectInfo(BaseModel):
    byte_size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


class CompleteSession(BaseModel):
    objects: dict[str, ObjectInfo] = Field(default_factory=dict)


app = FastAPI(title="Vaani Observer", version="0.1.0")
app.mount("/assets", StaticFiles(directory=STATIC), name="assets")


@app.middleware("http")
async def no_store_assets(request: Request, call_next):
    """The console is served from disk on localhost; a cached bundle just hands
    the reviewer a stale UI after an upgrade."""
    response = await call_next(request)
    if request.url.path.startswith("/assets") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.on_event("startup")
def startup() -> None:
    initialize()


@app.get("/")
def console() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/sessions", status_code=201)
def create_session(manifest: SessionCreate, request: Request) -> dict[str, Any]:
    session_id = manifest.session_id
    # The idempotency key is deliberately advisory in this no-auth local MVP.
    if request.headers.get("idempotency-key") not in (None, session_id):
        raise HTTPException(400, "Idempotency-Key must equal session_id")
    with connect() as db:
        row = db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            db.execute(
                "INSERT INTO sessions VALUES (?, ?, 'uploading', ?, ?, NULL)",
                (session_id, manifest.model_dump_json(), now(), now()),
            )
    base_url = str(request.base_url).rstrip("/")
    return {"session_id": session_id, "upload_urls": {name: f"{base_url}/v1/uploads/{session_id}/{name}" for name in ALLOWED_OBJECTS}}


@app.put("/v1/uploads/{session_id}/{object_name}", status_code=204)
async def upload_object(session_id: str, object_name: str, request: Request) -> None:
    require_session(session_id)
    if object_name not in ALLOWED_OBJECTS:
        raise HTTPException(404, "Unsupported object name")
    target_dir = safe_session_dir(session_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Object exceeds the 128 MiB local MVP limit")
    (target_dir / object_name).write_bytes(body)


@app.post("/v1/sessions/{session_id}/complete", status_code=202)
def complete_session(session_id: str, completion: CompleteSession) -> dict[str, Any]:
    row = require_session(session_id)
    manifest = json.loads(row["manifest_json"])
    for name, info in completion.objects.items():
        if name not in ALLOWED_OBJECTS:
            raise HTTPException(400, f"Unsupported object name: {name}")
        path = safe_session_dir(session_id) / name
        if not path.is_file():
            raise HTTPException(400, f"Missing upload: {name}")
        payload = path.read_bytes()
        if len(payload) != info.byte_size or hashlib.sha256(payload).hexdigest() != info.sha256.lower():
            raise HTTPException(400, f"Checksum verification failed: {name}")
    operations = import_operations(session_id)
    status = "ready" if operations else "partial"
    with connect() as db:
        db.execute("DELETE FROM operations WHERE session_id = ?", (session_id,))
        db.executemany(
            "INSERT OR REPLACE INTO operations (id, session_id, operation_json, started_at_ms, turn_id, scope) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    op["event_id"],
                    session_id,
                    json.dumps(op),
                    op.get("started_at_ms", 0),
                    str(op["turn_id"]) if op.get("turn_id") is not None else None,
                    op.get("scope", "turn"),
                )
                for op in operations
            ],
        )
        db.execute("UPDATE sessions SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?", (status, now(), now(), session_id))
    return {"session_id": session_id, "status": status, "operation_count": len(operations), "duration_ms": manifest.get("duration_ms", 0)}


@app.get("/v1/sessions")
def list_sessions() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM sessions ORDER BY created_at DESC").fetchall()
        counts = {
            item["session_id"]: item["turn_count"]
            for item in db.execute(
                "SELECT session_id, COUNT(DISTINCT turn_id) AS turn_count FROM operations WHERE turn_id IS NOT NULL GROUP BY session_id"
            )
        }
    return [{**session_summary(row), "turn_count": counts.get(row["id"], 0)} for row in rows]


@app.get("/v1/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    row = require_session(session_id)
    manifest = json.loads(row["manifest_json"])
    with connect() as db:
        operations = [json.loads(item["operation_json"]) for item in db.execute("SELECT operation_json FROM operations WHERE session_id = ? ORDER BY started_at_ms", (session_id,))]
    turn_ops = [op for op in operations if op.get("scope", "turn") != "connection"]
    connections = [op for op in operations if op.get("scope") == "connection"]
    return {
        **session_summary(row),
        "manifest": manifest,
        "operations": operations,
        "turns": group_turns(turn_ops),
        "connections": connections,
        "recordings": recordings(session_id, manifest),
    }


def group_turns(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Groups turn-scoped operations into the unit a reviewer actually reasons about."""
    turns: dict[str, dict[str, Any]] = {}
    for op in operations:
        turn_id = op.get("turn_id")
        if turn_id is None:
            continue
        turn = turns.setdefault(str(turn_id), {"turn_id": str(turn_id), "operations": []})
        turn["operations"].append(op)
    ordered = []
    for turn in turns.values():
        ops = sorted(turn["operations"], key=lambda item: item.get("started_at_ms", 0))
        by_type = lambda kind: [op for op in ops if op.get("type") == kind]  # noqa: E731
        stt = by_type("stt")[0] if by_type("stt") else None
        tts = by_type("tts")[0] if by_type("tts") else None
        llm = by_type("llm")
        started = min((op.get("started_at_ms", 0) for op in ops), default=0)
        ended = max((op.get("ended_at_ms") or op.get("started_at_ms", 0) for op in ops), default=0)
        first_audio = (tts or {}).get("milestones", {}).get("audio_chunk", {}).get("occurred_at_ms")
        speech_end = stt.get("ended_at_ms") if stt else None
        ordered.append(
            {
                "turn_id": turn["turn_id"],
                "started_at_ms": started,
                "ended_at_ms": ended,
                "duration_ms": max(0, ended - started),
                "status": "error" if any(op.get("status") == "error" for op in ops) else ("cancelled" if any(op.get("status") == "cancelled" for op in ops) else "ok"),
                "user_speech_ms": stt.get("duration_ms") if stt else None,
                "llm_ms": sum(op.get("duration_ms") or 0 for op in llm) or None,
                "llm_calls": len(llm),
                "tts_ms": tts.get("duration_ms") if tts else None,
                # The number that matters: silence between the user stopping and
                # the first byte of the reply reaching the caller.
                "time_to_first_audio_ms": (first_audio - speech_end) if (first_audio is not None and speech_end is not None) else None,
                "operations": ops,
            }
        )
    return sorted(ordered, key=lambda item: item["started_at_ms"])


@app.get("/v1/sessions/{session_id}/audio/{track}")
def get_audio(session_id: str, request: Request, track: Literal["caller", "agent", "mixed"], preview: Literal["wav"] | None = None) -> Response:
    row = require_session(session_id)
    directory = safe_session_dir(session_id)
    path = directory / f"{track}.audio"
    if track != "mixed" and not path.is_file():
        raise HTTPException(404, "Audio track not uploaded")
    if preview is None:
        if track == "mixed":
            raise HTTPException(400, "The mixed track is available only as a WAV preview")
        return FileResponse(path, media_type="application/octet-stream", filename=path.name)
    manifest = json.loads(row["manifest_json"])
    wav = timeline_wav(directory, manifest, track)
    total = len(wav)
    headers = {
        "Content-Disposition": f'inline; filename="{track}.wav"',
        "Accept-Ranges": "bytes",
    }

    # Safari (and iOS media playback generally) refuses to play a media response that
    # does not honour Range requests, so the on-demand wrapper must serve 206 slices.
    start, end = parse_range(request.headers.get("range"), total)
    status = 200
    if (start, end) != (0, total - 1):
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    headers["Content-Length"] = str(end - start + 1)
    return Response(wav[start : end + 1], status_code=status, media_type="audio/wav", headers=headers)


def timeline_wav(directory: Path, manifest: dict[str, Any], track: str) -> bytes:
    """Render PCM against the call clock, inserting silence for capture gaps."""
    audio = manifest.get("audio", {})
    required = ("caller", "agent") if track == "mixed" else (track,)
    metadata = {name: audio.get(name, {}) for name in required}
    for name, item in metadata.items():
        if item.get("encoding") != "pcm_s16le":
            raise HTTPException(415, "Only pcm_s16le tracks can be previewed")
        if not isinstance(item.get("sample_rate_hz"), int) or item["sample_rate_hz"] <= 0 or not isinstance(item.get("channels"), int) or item["channels"] <= 0:
            raise HTTPException(422, "Audio track is missing a valid sample rate or channel count")
        if not (directory / item.get("file", f"{name}.audio")).is_file():
            raise HTTPException(404, f"Audio track not uploaded: {name}")
    # Preserve byte-for-byte legacy previews until a package includes the timing
    # events needed for alignment. That keeps old recordings playable unchanged.
    if track != "mixed" and not audio_events(directory, track):
        item = metadata[track]
        raw = (directory / item.get("file", f"{track}.audio")).read_bytes()
        return wav_header(item["sample_rate_hz"], item["channels"], len(raw)) + raw
    rate = max(item["sample_rate_hz"] for item in metadata.values())
    duration_ms = max(0, int(manifest.get("duration_ms") or 0))
    tracks = {name: render_track(directory, manifest, name, item, rate, duration_ms) for name, item in metadata.items()}
    frames = max((len(samples) for samples in tracks.values()), default=0)
    if track == "mixed":
        output = array("h", (max(-32768, min(32767, sum(samples[index] if index < len(samples) else 0 for samples in tracks.values()))) for index in range(frames)))
    else:
        output = tracks[track]
    payload = output.tobytes()
    if sys.byteorder != "little":
        output.byteswap()
        payload = output.tobytes()
    return wav_header(rate, 1, len(payload)) + payload


def render_track(directory: Path, manifest: dict[str, Any], track: str, metadata: dict[str, Any], output_rate: int, call_duration_ms: int) -> array:
    source_rate, channels = metadata["sample_rate_hz"], metadata["channels"]
    raw = (directory / metadata.get("file", f"{track}.audio")).read_bytes()
    events = audio_events(directory, track)
    # Old packages have no usable chunk timings; retain their legacy contiguous playback.
    if not events:
        events = [(0, len(raw))]
    segments: list[tuple[int, bytes]] = []
    offset = 0
    for occurred_at, size in events:
        data = raw[offset : offset + size]
        offset += len(data)
        if data:
            segments.append((occurred_at, data))
    if offset < len(raw):
        segments.append((0 if not segments else segments[-1][0], raw[offset:]))
    final_frames = max(round(call_duration_ms * output_rate / 1000), max((round((at + len(data) * 1000 / (source_rate * channels * 2)) * output_rate / 1000) for at, data in segments), default=0))
    output = array("h", [0]) * final_frames
    for at, data in segments:
        source = array("h")
        source.frombytes(data[: len(data) - (len(data) % 2)])
        if sys.byteorder != "little":
            source.byteswap()
        mono = [sum(source[index : index + channels]) // channels for index in range(0, len(source) - channels + 1, channels)]
        start = round(at * output_rate / 1000)
        for index, sample in enumerate(mono):
            target_start = start + round(index * output_rate / source_rate)
            target_end = start + round((index + 1) * output_rate / source_rate)
            for target in range(max(0, target_start), min(final_frames, max(target_start + 1, target_end))):
                output[target] = sample
    return output


def audio_events(directory: Path, track: str) -> list[tuple[int, int]]:
    path = directory / "events.jsonl"
    if not path.is_file():
        return []
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("kind") == "audio_chunk" and event.get("track") == track and isinstance(event.get("occurred_at_ms"), (int, float)) and isinstance(event.get("byte_length"), int):
            events.append((max(0, round(event["occurred_at_ms"])), max(0, event["byte_length"])))
    return events


def wav_header(sample_rate: int, channels: int, data_size: int) -> bytes:
    """Canonical 44-byte PCM WAV header, so the audio body can stream straight from disk."""
    block_align = channels * 2
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        16,
        b"data",
        data_size,
    )


def parse_range(header: str | None, total: int) -> tuple[int, int]:
    if not header or not header.startswith("bytes="):
        return 0, total - 1
    first, _, last = header[len("bytes=") :].split(",")[0].strip().partition("-")
    try:
        if not first:
            # Suffix range: the final N bytes.
            start, end = max(0, total - int(last)), total - 1
        else:
            start = int(first)
            end = min(int(last), total - 1) if last else total - 1
    except ValueError:
        return 0, total - 1
    if start >= total or start > end:
        raise HTTPException(416, "Requested range is not satisfiable", headers={"Content-Range": f"bytes */{total}"})
    return start, end


def read_wav_range(header: bytes, path: Path, start: int, end: int, chunk: int = 64 * 1024) -> Iterator[bytes]:
    remaining = end - start + 1
    if start < len(header):
        piece = header[start : start + remaining]
        remaining -= len(piece)
        yield piece
        offset = 0
    else:
        offset = start - len(header)
    if remaining <= 0:
        return
    with path.open("rb") as source:
        source.seek(offset)
        while remaining > 0:
            data = source.read(min(chunk, remaining))
            if not data:
                return
            remaining -= len(data)
            yield data


def require_session(session_id: str) -> sqlite3.Row:
    with connect() as db:
        row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    return row


def safe_session_dir(session_id: str) -> Path:
    # A bare ".." keeps its own basename, so relative components need an explicit check.
    if not session_id or session_id in {".", ".."} or Path(session_id).name != session_id:
        raise HTTPException(400, "Invalid session id")
    return OBJECTS / session_id


def import_operations(session_id: str) -> list[dict[str, Any]]:
    events = safe_session_dir(session_id) / "events.jsonl"
    if not events.exists():
        return []
    imported: list[dict[str, Any]] = []
    for line_number, line in enumerate(events.read_text(encoding="utf-8").splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise HTTPException(400, f"Invalid events.jsonl on line {line_number}") from error
        if event.get("session_id") == session_id and event.get("type") in {"stt", "llm", "tts", "tool"} and event.get("event_id"):
            imported.append(event)
    return imported


def recordings(session_id: str, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for track, metadata in manifest.get("audio", {}).items():
        path = safe_session_dir(session_id) / metadata.get("file", f"{track}.audio")
        result.append({"track": track, "uploaded": path.is_file(), "size_bytes": path.stat().st_size if path.is_file() else 0, **metadata})
    return result


def session_summary(row: sqlite3.Row) -> dict[str, Any]:
    manifest = json.loads(row["manifest_json"])
    return {"id": row["id"], "agent_id": manifest.get("agent_id"), "duration_ms": manifest.get("duration_ms", 0), "outcome": manifest.get("outcome"), "status": row["status"], "started_at": manifest.get("started_at"), "created_at": row["created_at"]}
