from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from datetime import UTC, datetime
from array import array
from io import BytesIO
from pathlib import Path
from typing import Any

from app.main import timeline_wav


CHALLENGER_SCHEMA_VERSION = "2.0"
BATCH_URL = "https://api.elevenlabs.io/v1/speech-to-text"
STREAMING_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"


def load_api_key(env_files: list[Path] | None = None) -> str | None:
    if env_files is None:
        # `VAANI_ENV_FILE` (os.pathsep-separated) points at keys kept outside
        # this checkout; the dashboard's own .env is the conventional fallback.
        configured = os.environ.get("VAANI_ENV_FILE", "")
        env_files = [
            *(Path(item) for item in configured.split(os.pathsep) if item),
            Path(__file__).resolve().parents[1] / ".env",
        ]
    for path in env_files:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
                value = value[1:-1]
            os.environ.setdefault(key, value)
    return os.environ.get("ELEVENLABS_API_KEY")


def collect_batch(session_id: str, data_dir: Path, api_key: str, model: str = "scribe_v2", track: str = "caller") -> dict:
    started = time.monotonic()
    request = {"model_id": model, "timestamps_granularity": "word", "diarize": "false"}
    try:
        audio = _load_audio(session_id, data_dir, track)
        payload = _post_batch(audio["wav"], api_key, request)
        wall_clock_ms = round((time.monotonic() - started) * 1000)
        run = _base_run(session_id, model, "batch", request, audio)
        run.update(
            {
                "status": "complete",
                "response": _response_from_payload(payload),
                "timing": _empty_timing(wall_clock_ms),
                "usage": _usage(audio["duration_secs"]),
            }
        )
        return run
    except Exception as error:
        return _failed_run(session_id, model, "batch", request, str(error), started)


def collect_streaming(
    session_id: str,
    data_dir: Path,
    api_key: str,
    model: str = "scribe_v2_realtime",
    track: str = "caller",
    *,
    commit_strategy: str = "vad",
    vad_silence_threshold_secs: float = 0.3,
    min_speech_duration_ms: int = 100,
    min_silence_duration_ms: int = 300,
    chunk_ms: int = 100,
    language_code: str | None = None,
) -> dict:
    candidates = [model]
    if model != "scribe_v2_realtime":
        candidates.append("scribe_v2_realtime")
    last: dict | None = None
    for candidate in dict.fromkeys(candidates):
        last = asyncio.run(
            _collect_streaming_once(
                session_id,
                data_dir,
                api_key,
                candidate,
                track,
                commit_strategy=commit_strategy,
                vad_silence_threshold_secs=vad_silence_threshold_secs,
                min_speech_duration_ms=min_speech_duration_ms,
                min_silence_duration_ms=min_silence_duration_ms,
                chunk_ms=chunk_ms,
                language_code=language_code,
            )
        )
        if last.get("status") == "complete":
            return last
    return last or _failed_run(session_id, model, "streaming", {"model_id": model}, "streaming failed", time.monotonic())


def save_run(run: dict, data_dir: Path) -> Path:
    _validate_run(run)
    directory = data_dir / "evaluations" / run["session_id"]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{_safe_name(run['provider'])}-{_safe_name(run['model'])}-{_safe_name(run['kind'])}.json"
    path.write_text(json.dumps(run, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_runs(session_id: str, data_dir: Path) -> list[dict]:
    directory = data_dir / "evaluations" / session_id
    if not directory.is_dir():
        return []
    runs: list[tuple[float, dict]] = []
    for path in directory.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            run = _upgrade_run(payload, path.stat().st_mtime)
            _validate_run(run)
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            continue
        if run.get("session_id") == session_id:
            runs.append((path.stat().st_mtime, run))
    return [run for _, run in sorted(runs, key=lambda item: item[0], reverse=True)]


def collect_all(session_id: str, data_dir: Path, api_key: str, track: str = "caller") -> list[dict]:
    runs = [collect_batch(session_id, data_dir, api_key, track=track), collect_streaming(session_id, data_dir, api_key, track=track)]
    for run in runs:
        save_run(run, data_dir)
    return runs


async def _collect_streaming_once(
    session_id: str,
    data_dir: Path,
    api_key: str,
    model: str,
    track: str,
    *,
    commit_strategy: str,
    vad_silence_threshold_secs: float,
    min_speech_duration_ms: int,
    min_silence_duration_ms: int,
    chunk_ms: int,
    language_code: str | None,
) -> dict:
    import websockets

    started = time.monotonic()
    request = {
        "model_id": model,
        "include_timestamps": True,
        "include_language_detection": True,
        "commit_strategy": commit_strategy,
        "vad_silence_threshold_secs": vad_silence_threshold_secs,
        "min_speech_duration_ms": min_speech_duration_ms,
        "min_silence_duration_ms": min_silence_duration_ms,
        "audio_format": "pcm_16000",
        "sample_rate": 16000,
        "chunk_ms": chunk_ms,
    }
    if language_code:
        request["language_code"] = language_code
    try:
        audio = _load_audio(session_id, data_dir, track)
        chunk_bytes = max(2, round(32_000 * chunk_ms / 1000))
        chunk_bytes -= chunk_bytes % 2
        receipts: list[dict[str, Any]] = []
        committed_ts: list[dict[str, Any]] = []
        final_ts: list[dict[str, Any]] = []
        committed_texts: list[str] = []
        commits: list[dict[str, Any]] = []
        first_partial_at_ms: int | None = None
        first_final_at_ms: int | None = None
        last_committed_at_ms: int | None = None
        audio_started_at: float | None = None
        audio_cursor_ms = 0
        got_timestamps = asyncio.Event()
        last_message_at = time.monotonic()
        query = urllib.parse.urlencode({key: str(value).lower() if isinstance(value, bool) else value for key, value in request.items() if key != "chunk_ms"})

        async with websockets.connect(
            f"{STREAMING_URL}?{query}",
            additional_headers={"xi-api-key": api_key},
            max_size=8 * 1024 * 1024,
        ) as websocket:
            connected_at_ms = round((time.monotonic() - started) * 1000)

            async def receive() -> None:
                nonlocal first_partial_at_ms, first_final_at_ms, last_committed_at_ms, last_message_at
                async for message in websocket:
                    now = time.monotonic()
                    last_message_at = now
                    payload = json.loads(message)
                    kind = str(payload.get("message_type") or "unknown")
                    at_ms = 0 if audio_started_at is None else round((now - audio_started_at) * 1000)
                    text = payload.get("text") if isinstance(payload.get("text"), str) else None
                    words = _words_with_ms(payload.get("words") if isinstance(payload.get("words"), list) else [])
                    result_audio_end_ms = max((item["end_ms"] for item in words if isinstance(item.get("end_ms"), int)), default=None)
                    receipt = {
                        "kind": kind,
                        "at_ms": at_ms,
                        "audio_cursor_ms": audio_cursor_ms,
                        "text": text,
                        "word_count": len(text.split()) if text else 0,
                        "result_audio_end_ms": result_audio_end_ms,
                    }
                    for key in ("session_id", "model_id"):
                        if key in payload:
                            receipt[key] = payload[key]
                    receipts.append(receipt)
                    if kind == "partial_transcript" and first_partial_at_ms is None:
                        first_partial_at_ms = at_ms
                    if kind.startswith("final_transcript") and first_final_at_ms is None:
                        first_final_at_ms = at_ms
                    if kind.startswith("committed_transcript"):
                        last_committed_at_ms = at_ms
                        if kind == "committed_transcript" and text:
                            committed_texts.append(text)
                    if kind == "committed_transcript_with_timestamps":
                        segment = {"text": text or "", "words": words, "at_ms": at_ms, "audio_cursor_ms": audio_cursor_ms}
                        committed_ts.append(segment)
                        commits.append(_commit_summary(segment))
                        got_timestamps.set()
                    elif kind == "final_transcript_with_timestamps":
                        final_ts.append({"text": text or "", "words": words, "at_ms": at_ms, "audio_cursor_ms": audio_cursor_ms})
                        got_timestamps.set()

            receiver = asyncio.create_task(receive())
            audio_started_at = time.monotonic()
            for index, offset in enumerate(range(0, len(audio["pcm"]), chunk_bytes)):
                chunk = audio["pcm"][offset : offset + chunk_bytes]
                await websocket.send(
                    json.dumps(
                        {
                            "message_type": "input_audio_chunk",
                            "audio_base_64": base64.b64encode(chunk).decode("ascii"),
                            "commit": False,
                            "sample_rate": 16000,
                        }
                    )
                )
                audio_cursor_ms = round(min(len(audio["pcm"]), offset + len(chunk)) / 32)
                next_send_at = audio_started_at + ((index + 1) * chunk_ms / 1000)
                await asyncio.sleep(max(0, next_send_at - time.monotonic()))
            await websocket.send(
                json.dumps(
                    {
                        "message_type": "input_audio_chunk",
                        "audio_base_64": "",
                        "commit": True,
                        "sample_rate": 16000,
                    }
                )
            )
            receipt_count_at_final_commit = len(receipts)
            final_wait_started = time.monotonic()
            while time.monotonic() - final_wait_started < 15:
                await asyncio.sleep(0.25)
                if len(receipts) > receipt_count_at_final_commit and time.monotonic() - last_message_at >= 2:
                    break
            await websocket.close()
            with contextlib.suppress(Exception):
                await receiver

        committed_ts = _absolute_segments(committed_ts, min_silence_duration_ms)
        final_ts = _absolute_segments(final_ts, min_silence_duration_ms)
        commits = [_commit_summary(segment) for segment in committed_ts]
        response = _streaming_response(committed_ts, final_ts, committed_texts, audio["duration_secs"])
        run = _base_run(session_id, model, "streaming", request, audio)
        run.update(
            {
                "status": "complete",
                "response": response,
                "timing": {
                    "wall_clock_ms": round((time.monotonic() - started) * 1000),
                    "connected_at_ms": connected_at_ms,
                    "audio_started_at_ms": round((audio_started_at - started) * 1000) if audio_started_at else None,
                    "first_partial_at_ms": first_partial_at_ms,
                    "first_final_at_ms": first_final_at_ms,
                    "last_committed_at_ms": last_committed_at_ms,
                    "receipts": receipts,
                    "commits": commits,
                },
                "usage": _usage(audio["duration_secs"]),
            }
        )
        return run
    except Exception as error:
        return _failed_run(session_id, model, "streaming", request, str(error), started)


def _load_audio(session_id: str, data_dir: Path, track: str) -> dict[str, Any]:
    manifest = _load_manifest(session_id, data_dir)
    wav = timeline_wav(data_dir / "objects" / session_id, manifest, track)
    with wave.open(BytesIO(wav), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        channels = wav_file.getnchannels()
        frames = wav_file.getnframes()
        sample_width = wav_file.getsampwidth()
        pcm = wav_file.readframes(frames)
    if sample_rate <= 0 or channels != 1 or sample_width != 2:
        raise ValueError(f"expected mono 16-bit WAV, got {sample_rate} Hz, {channels} channels, {sample_width} bytes")
    return {
        "wav": wav,
        # Batch transcription accepts the original WAV, so retaining its native
        # rate avoids an unnecessary quality-changing conversion. The realtime
        # protocol is explicitly pcm_16000, so only that replay input is
        # converted below.
        "pcm": _resample_pcm_mono(pcm, sample_rate, 16_000),
        "track": track,
        "sample_rate_hz": sample_rate,
        "channels": channels,
        "duration_secs": round(frames / sample_rate, 3),
    }


def _resample_pcm_mono(pcm: bytes, source_rate: int, target_rate: int) -> bytes:
    """Small dependency-free linear PCM resampler for the realtime replay."""
    if source_rate == target_rate:
        return pcm
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return b""
    output = array("h")
    output_count = max(1, round(len(samples) * target_rate / source_rate))
    for index in range(output_count):
        position = index * source_rate / target_rate
        left = min(int(position), len(samples) - 1)
        right = min(left + 1, len(samples) - 1)
        fraction = position - left
        output.append(round(samples[left] + (samples[right] - samples[left]) * fraction))
    if sys.byteorder != "little":
        output.byteswap()
    return output.tobytes()


def _load_manifest(session_id: str, data_dir: Path) -> dict[str, Any]:
    with sqlite3.connect(data_dir / "vaani.db") as db:
        row = db.execute("SELECT manifest_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise ValueError(f"session not found: {session_id}")
    return json.loads(row[0])


def _post_batch(audio: bytes, api_key: str, request_fields: dict[str, Any]) -> dict[str, Any]:
    boundary = "----VaaniChallengerBoundary"
    parts = [
        _form_part(boundary, "model_id", request_fields["model_id"]),
        _form_part(boundary, "timestamps_granularity", request_fields["timestamps_granularity"]),
        _form_part(boundary, "diarize", request_fields["diarize"]),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"caller.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode()
        + audio
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    request = urllib.request.Request(
        BATCH_URL,
        data=b"".join(parts),
        headers={"xi-api-key": api_key, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"ElevenLabs returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"ElevenLabs request failed: {error.reason}") from error


def _form_part(boundary: str, name: str, value: Any) -> bytes:
    return f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()


def _base_run(session_id: str, model: str, kind: str, request: dict[str, Any], audio: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "schema_version": CHALLENGER_SCHEMA_VERSION,
        "session_id": session_id,
        "created_at": datetime.now(UTC).isoformat(),
        "provider": "elevenlabs",
        "model": model,
        "kind": kind,
        "status": "failed",
        "error": None,
        "request": request,
        "audio": _audio_metadata(audio),
        "response": _empty_response(),
        "timing": _empty_timing(None),
        "usage": _usage(0),
    }


def _failed_run(session_id: str, model: str, kind: str, request: dict[str, Any], message: str, started: float) -> dict[str, Any]:
    run = _base_run(session_id, model, kind, request)
    run["error"] = message
    run["timing"]["wall_clock_ms"] = round((time.monotonic() - started) * 1000)
    return run


def _audio_metadata(audio: dict[str, Any] | None) -> dict[str, Any]:
    if not audio:
        return {"track": None, "sample_rate_hz": 16000, "channels": 1, "duration_secs": 0}
    return {
        "track": audio["track"],
        "sample_rate_hz": audio["sample_rate_hz"],
        "channels": audio["channels"],
        "duration_secs": audio["duration_secs"],
    }


def _response_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "language_code": payload.get("language_code"),
        "language_probability": payload.get("language_probability"),
        "text": payload.get("text") or "",
        "words": _words_with_ms(payload.get("words") if isinstance(payload.get("words"), list) else []),
        "transcription_id": payload.get("transcription_id"),
        "audio_duration_secs": payload.get("audio_duration_secs"),
    }


def _streaming_response(committed_ts: list[dict[str, Any]], final_ts: list[dict[str, Any]], committed_texts: list[str], duration_secs: float) -> dict[str, Any]:
    source = committed_ts or final_ts
    if source:
        text = " ".join(item["text"] for item in source if item.get("text")).strip()
        words = [word for item in source for word in item.get("words", [])]
    else:
        text = " ".join(committed_texts).strip()
        words = []
    return {
        "language_code": None,
        "language_probability": None,
        "text": text,
        "words": _words_with_ms(words),
        "transcription_id": None,
        "audio_duration_secs": duration_secs,
    }


def _absolute_segments(segments: list[dict[str, Any]], min_silence_duration_ms: int) -> list[dict[str, Any]]:
    if not segments:
        return []
    starts = [_first_word_ms(segment.get("words", [])) for segment in segments]
    ends = [_last_word_ms(segment.get("words", [])) for segment in segments]
    observed_absolute = all(
        start is None or previous_end is None or start >= previous_end - 500
        for start, previous_end in zip(starts[1:], ends[:-1], strict=False)
    )
    if observed_absolute:
        return segments
    absolute: list[dict[str, Any]] = []
    previous_end = 0
    for segment in segments:
        words = segment.get("words", [])
        raw_end = _last_word_ms(words)
        cursor = segment.get("audio_cursor_ms")
        offset = previous_end
        if isinstance(raw_end, int) and isinstance(cursor, int):
            offset = max(previous_end, cursor - raw_end - min_silence_duration_ms)
        adjusted = {**segment, "words": [_offset_word(word, offset) for word in words]}
        previous_end = max(previous_end, _last_word_ms(adjusted["words"]) or previous_end)
        absolute.append(adjusted)
    return absolute


def _commit_summary(segment: dict[str, Any]) -> dict[str, Any]:
    words = segment.get("words", [])
    word_count = sum(item.get("type") == "word" for item in words if isinstance(item, dict))
    return {
        "at_ms": segment.get("at_ms"),
        "audio_cursor_ms": segment.get("audio_cursor_ms"),
        "text": segment.get("text") or "",
        "audio_start_ms": _first_word_ms(words),
        "audio_end_ms": _last_word_ms(words),
        "word_count": word_count,
    }


def _first_word_ms(words: list[Any]) -> int | None:
    values = [item.get("start_ms") for item in words if isinstance(item, dict) and item.get("type") == "word" and isinstance(item.get("start_ms"), int)]
    return min(values, default=None)


def _last_word_ms(words: list[Any]) -> int | None:
    values = [item.get("end_ms") for item in words if isinstance(item, dict) and item.get("type") == "word" and isinstance(item.get("end_ms"), int)]
    return max(values, default=None)


def _offset_word(word: dict[str, Any], offset_ms: int) -> dict[str, Any]:
    adjusted = dict(word)
    if isinstance(adjusted.get("start"), (int, float)):
        adjusted["start"] = adjusted["start"] + offset_ms / 1000
    if isinstance(adjusted.get("end"), (int, float)):
        adjusted["end"] = adjusted["end"] + offset_ms / 1000
    return _words_with_ms([adjusted])[0]


def _empty_response() -> dict[str, Any]:
    return {"language_code": None, "language_probability": None, "text": "", "words": [], "transcription_id": None, "audio_duration_secs": None}


def _empty_timing(wall_clock_ms: int | None) -> dict[str, Any]:
    return {
        "wall_clock_ms": wall_clock_ms,
        "connected_at_ms": None,
        "audio_started_at_ms": None,
        "first_partial_at_ms": None,
        "first_final_at_ms": None,
        "last_committed_at_ms": None,
        "receipts": [],
        "commits": [],
    }


def _usage(duration_secs: float | int | None) -> dict[str, Any]:
    seconds = float(duration_secs or 0)
    return {"audio_seconds": seconds, "billable_minutes": round(seconds / 60, 3), "request_count": 1}


def _words_with_ms(words: list[Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in words:
        if not isinstance(item, dict):
            continue
        word = dict(item)
        start = word.get("start")
        end = word.get("end")
        if isinstance(start, (int, float)):
            word["start_ms"] = round(start * 1000)
        if isinstance(end, (int, float)):
            word["end_ms"] = round(end * 1000)
        output.append(word)
    return output


def _upgrade_run(payload: dict[str, Any], mtime: float) -> dict[str, Any]:
    if payload.get("schema_version") == CHALLENGER_SCHEMA_VERSION:
        payload = dict(payload)
        payload["response"] = _response_from_payload(payload.get("response") or {})
        payload.setdefault("timing", _empty_timing(None))
        payload["timing"].setdefault("commits", [])
        return payload
    if payload.get("schema_version") != "1.0" or payload.get("provider") != "elevenlabs":
        raise ValueError("unsupported challenger run schema")
    audio = payload.get("audio") if isinstance(payload.get("audio"), dict) else {}
    duration = float(audio.get("duration_secs") or payload.get("response", {}).get("audio_duration_secs") or 0)
    return {
        "schema_version": CHALLENGER_SCHEMA_VERSION,
        "session_id": payload.get("session_id"),
        "created_at": payload.get("created_at") or datetime.fromtimestamp(mtime, UTC).isoformat(),
        "provider": "elevenlabs",
        "model": payload.get("model") or "scribe_v1",
        "kind": "batch",
        "status": payload.get("status") or "complete",
        "error": payload.get("error"),
        "request": payload.get("request") or {},
        "audio": {
            "track": audio.get("track", "caller"),
            "sample_rate_hz": audio.get("sample_rate_hz", 16000),
            "channels": audio.get("channels", 1),
            "duration_secs": duration,
        },
        "response": _response_from_payload(payload.get("response") or {}),
        "timing": _empty_timing(None),
        "usage": _usage(duration),
    }


def _validate_run(run: dict[str, Any]) -> None:
    required = {"schema_version", "session_id", "created_at", "provider", "model", "kind", "status", "error", "request", "audio", "response", "timing", "usage"}
    if not required.issubset(run):
        raise ValueError("challenger run is missing required fields")
    if run["schema_version"] != CHALLENGER_SCHEMA_VERSION or run["provider"] != "elevenlabs":
        raise ValueError("unsupported challenger run")
    if run["kind"] not in {"batch", "streaming"} or run["status"] not in {"complete", "failed"}:
        raise ValueError("invalid challenger run status")
    run["response"]["words"] = _words_with_ms(run.get("response", {}).get("words") or [])


def _safe_name(value: str) -> str:
    return "".join(character if character.isalnum() or character in {"-", "_"} else "-" for character in value.lower())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--kind", choices=("batch", "streaming", "all"), default="all")
    args = parser.parse_args()
    api_key = load_api_key()
    if not api_key:
        print("Missing ELEVENLABS_API_KEY.")
        return 2
    if args.kind == "batch":
        runs = [collect_batch(args.session, args.data_dir, api_key)]
    elif args.kind == "streaming":
        runs = [collect_streaming(args.session, args.data_dir, api_key)]
    else:
        runs = [collect_batch(args.session, args.data_dir, api_key), collect_streaming(args.session, args.data_dir, api_key)]
    for run in runs:
        path = save_run(run, args.data_dir)
        receipts = run.get("timing", {}).get("receipts") or []
        commits = len(run.get("timing", {}).get("commits") or [])
        print(
            f"{run['kind']}: {run['status']} words={len(run['response'].get('words') or [])} "
            f"wall={run['timing'].get('wall_clock_ms')}ms first_partial={run['timing'].get('first_partial_at_ms')}ms "
            f"commits={commits} saved={path}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
