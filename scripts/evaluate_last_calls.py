#!/usr/bin/env python3
"""Evaluate the two most recent completed calls with ElevenLabs Scribe v2.

This is a focused Stage 1 evaluator from docs/wer-evaluation-plan.md. It sends
the complete caller track once per call, maps Scribe's word timestamps to the
recorded production turns, and prints a compact Markdown report.

Usage:
    python dashboard/scripts/evaluate_last_calls.py
    python dashboard/scripts/evaluate_last_calls.py --data-dir dashboard/data
    s_API_KEY=... python dashboard/scripts/evaluate_last_calls.py

The script also looks for the key in a sibling ../livekit/.env, which matches
the local workspace layout used during development. The key is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DASHBOARD_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(DASHBOARD_DIR))

from app.main import timeline_wav  # noqa: E402


API_URL = "https://api.elevenlabs.io/v1/speech-to-text"
MODEL = "scribe_v2"
MAPPING_TOLERANCE_MS = 150


@dataclass(frozen=True)
class Token:
    text: str
    start_ms: int
    end_ms: int


def load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE dotenv entries without exposing their values."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def normalize(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("₹", " rupees ")
    text = re.sub(r"[^\w\s'-]", " ", text, flags=re.UNICODE)
    text = re.sub(r"\s+", " ", text).strip()
    return text.split() if text else []


def transcript_from_response(response: dict[str, Any]) -> str:
    for key in ("transcript", "text"):
        if isinstance(response.get(key), str):
            return response[key]
    try:
        return response["results"]["channels"][0]["alternatives"][0]["transcript"]
    except (KeyError, IndexError, TypeError):
        return ""


def production_transcript(operation: dict[str, Any], llm_operations: list[dict[str, Any]] | None = None) -> tuple[str, str]:
    response = operation.get("response") or {}
    direct = transcript_from_response(response) if isinstance(response, dict) else ""
    if direct:
        return direct, "stt_response"
    # Legacy packages captured char_count but not the STT text. The plan permits
    # an unambiguous fallback from the current turn's captured LLM request.
    candidates: list[str] = []
    for llm in llm_operations or []:
        body = (llm.get("request") or {}).get("body")
        if not isinstance(body, str):
            continue
        try:
            messages = json.loads(body).get("messages", [])
        except (json.JSONDecodeError, TypeError):
            continue
        users = [item.get("content") for item in messages if isinstance(item, dict) and item.get("role") == "user" and isinstance(item.get("content"), str)]
        if users:
            candidates.append(users[-1])
    if len(candidates) == 1:
        return candidates[0], "llm_history_inferred"
    return "", "unavailable"


def milestone_ms(operation: dict[str, Any], names: tuple[str, ...]) -> int | None:
    milestones = operation.get("milestones") or {}
    for name in names:
        item = milestones.get(name)
        if isinstance(item, dict):
            value = item.get("occurred_at_ms")
            if isinstance(value, (int, float)):
                return round(value)
    return None


def turn_window(operation: dict[str, Any]) -> tuple[int, int] | None:
    start = milestone_ms(operation, ("speech_started", "speech_start", "audio_started"))
    end = milestone_ms(operation, ("speech_ended", "speech_end", "audio_ended"))
    start = start if start is not None else operation.get("started_at_ms")
    end = end if end is not None else operation.get("ended_at_ms")
    if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
        return round(start), round(end)
    return None


def challenger_tokens(payload: dict[str, Any]) -> list[Token]:
    result: list[Token] = []
    for item in payload.get("words", []):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        start = item.get("start")
        end = item.get("end")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            result.append(Token(item["text"], round(start * 1000), round(end * 1000)))
    return result


def multipart_request(audio: bytes, api_key: str) -> dict[str, Any]:
    boundary = "----VaaniScribeBoundary"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model_id\"\r\n\r\n{MODEL}\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"caller.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode() + audio + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    request = urllib.request.Request(
        API_URL,
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


def mapping_windows(turns: list[dict[str, Any]]) -> list[tuple[str, int, int]]:
    """Build turn windows from neighboring turn boundaries, not STT finals.

    A streaming STT operation starts after the first caller audio has already
    arrived and ends after the caller has stopped. Using those operation times
    as speech windows drops the beginning of otherwise correctly transcribed
    utterances. Midpoints between adjacent production operations are stable
    separators because turns are chronological and caller-only audio contains
    no agent speech.
    """
    ordered = sorted(turns, key=lambda item: item["stt"].get("started_at_ms", 0))
    windows: list[tuple[str, int, int]] = []
    for index, turn in enumerate(ordered):
        current = turn["stt"]
        current_start = current.get("started_at_ms")
        current_end = current.get("ended_at_ms") or current_start
        if not isinstance(current_start, (int, float)) or not isinstance(current_end, (int, float)):
            continue
        if index == 0:
            left = 0
        else:
            previous_end = ordered[index - 1]["stt"].get("ended_at_ms")
            previous_start = ordered[index - 1]["stt"].get("started_at_ms")
            previous_end = previous_end if isinstance(previous_end, (int, float)) else previous_start
            left = round((previous_end + current_start) / 2) if isinstance(previous_end, (int, float)) else round(current_start - MAPPING_TOLERANCE_MS)
        if index + 1 < len(ordered):
            next_start = ordered[index + 1]["stt"].get("started_at_ms")
            right = round((current_end + next_start) / 2) if isinstance(next_start, (int, float)) else round(current_end + MAPPING_TOLERANCE_MS)
        else:
            right = round(current_end + MAPPING_TOLERANCE_MS)
        windows.append((turn["turn_id"], left, max(left, right)))
    return windows


def map_tokens(tokens: list[Token], turns: list[dict[str, Any]]) -> tuple[dict[str, list[Token]], set[str]]:
    windows = mapping_windows(turns)
    mapped: dict[str, list[Token]] = {turn["turn_id"]: [] for turn in turns}
    ambiguous: set[str] = set()
    for token in tokens:
        midpoint = (token.start_ms + token.end_ms) / 2
        matches = [turn_id for turn_id, start, end in windows if start <= midpoint < end]
        if len(matches) == 1:
            mapped[matches[0]].append(token)
        elif len(matches) > 1:
            ambiguous.update(matches)
    return mapped, ambiguous


def align(production: list[str], challenger: list[str]) -> tuple[int, int, int, list[dict[str, Any]]]:
    rows = len(production) + 1
    cols = len(challenger) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            dp[i][j] = min(
                dp[i - 1][j - 1] + (production[i - 1] != challenger[j - 1]),
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
            )
    entries: list[dict[str, Any]] = []
    i, j = len(production), len(challenger)
    while i or j:
        if i and j and dp[i][j] == dp[i - 1][j - 1] + (production[i - 1] != challenger[j - 1]):
            operation = "match" if production[i - 1] == challenger[j - 1] else "substitution"
            entries.append({"production_word": production[i - 1], "challenger_word": challenger[j - 1], "operation": operation, "production_index": i - 1, "challenger_index": j - 1})
            i, j = i - 1, j - 1
        elif i and dp[i][j] == dp[i - 1][j] + 1:
            entries.append({"production_word": production[i - 1], "challenger_word": None, "operation": "deletion", "production_index": i - 1, "challenger_index": None})
            i -= 1
        else:
            entries.append({"production_word": None, "challenger_word": challenger[j - 1], "operation": "insertion", "production_index": None, "challenger_index": j - 1})
            j -= 1
    entries.reverse()
    substitutions = sum(item["operation"] == "substitution" for item in entries)
    deletions = sum(item["operation"] == "deletion" for item in entries)
    insertions = sum(item["operation"] == "insertion" for item in entries)
    return substitutions, deletions, insertions, entries


def evaluate_turn(turn: dict[str, Any], mapped: list[Token], ambiguous: bool) -> dict[str, Any]:
    production_text, provenance = production_transcript(turn["stt"], turn.get("llm", []))
    challenger_text = " ".join(item.text for item in mapped)
    if ambiguous:
        return {"status": "challenger_mapping_ambiguous", "production": production_text, "production_provenance": provenance, "challenger": challenger_text}
    if not production_text and not challenger_text and provenance == "unavailable":
        return {"status": "ineligible_transcript_unavailable", "production": "", "production_provenance": provenance, "challenger": challenger_text}
    production = normalize(production_text)
    challenger = normalize(challenger_text)
    if not production and not challenger:
        return {"status": "no_speech", "production": production_text, "production_provenance": provenance, "challenger": challenger_text}
    if not challenger and production:
        return {"status": "challenger_empty", "production": production_text, "production_provenance": provenance, "challenger": challenger_text}
    if not production and challenger:
        return {"status": "possible_missed_speech", "production": production_text, "production_provenance": provenance, "challenger": challenger_text, "estimated_wer": 1.0, "substitutions": 0, "deletions": 0, "insertions": len(challenger), "diff": []}
    substitutions, deletions, insertions, diff = align(production, challenger)
    errors = substitutions + deletions + insertions
    return {"status": "evaluated", "production": production_text, "production_provenance": provenance, "challenger": challenger_text, "estimated_wer": errors / len(challenger), "substitutions": substitutions, "deletions": deletions, "insertions": insertions, "diff": diff}


def load_calls(data_dir: Path) -> list[tuple[dict[str, Any], Path]]:
    database = data_dir / "vaani.db"
    if not database.is_file():
        return []
    with sqlite3.connect(database) as db:
        rows = db.execute("SELECT id, manifest_json FROM sessions ORDER BY created_at DESC LIMIT 2").fetchall()
    return [(json.loads(manifest), data_dir / "objects" / session_id) for session_id, manifest in rows]


def report_call(manifest: dict[str, Any], directory: Path, api_key: str) -> dict[str, Any]:
    session_id = manifest.get("session_id") or directory.name
    events_path = directory / "events.jsonl"
    operations = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()] if events_path.is_file() else []
    turns = []
    for turn_id in sorted({str(op.get("turn_id")) for op in operations if op.get("turn_id") is not None}, key=lambda value: next((op.get("started_at_ms", 0) for op in operations if str(op.get("turn_id")) == value), 0)):
        turn_operations = [op for op in operations if str(op.get("turn_id")) == turn_id]
        stt = next((op for op in turn_operations if op.get("type") == "stt" and op.get("scope", "turn") != "connection"), None)
        if stt:
            turns.append({"turn_id": turn_id, "stt": stt, "llm": [op for op in turn_operations if op.get("type") == "llm"]})
    turns.sort(key=lambda item: item["stt"].get("started_at_ms", 0))
    caller = directory / manifest.get("audio", {}).get("caller", {}).get("file", "caller.audio")
    if not caller.is_file():
        return {"session_id": session_id, "status": "ineligible_audio_unavailable", "turns": []}
    audio = timeline_wav(directory, manifest, "caller")
    payload = multipart_request(audio, api_key)
    tokens = challenger_tokens(payload)
    mapped, ambiguous = map_tokens(tokens, turns)
    results = [{"turn_id": turn["turn_id"], **evaluate_turn(turn, mapped[turn["turn_id"]], turn["turn_id"] in ambiguous)} for turn in turns]
    evaluated = [item for item in results if item["status"] == "evaluated"]
    wers = sorted(item["estimated_wer"] for item in evaluated)
    median = wers[len(wers) // 2] if wers and len(wers) % 2 else ((wers[len(wers) // 2 - 1] + wers[len(wers) // 2]) / 2 if wers else None)
    return {"session_id": session_id, "status": "complete", "challenger": "ElevenLabs Scribe v2", "turn_count": len(results), "evaluated_turn_count": len(evaluated), "median_estimated_wer": median, "moderate_or_high": sum(bool(item.get("estimated_wer") is not None and item["estimated_wer"] >= 0.10) for item in results), "high": sum(bool(item.get("estimated_wer") is not None and item["estimated_wer"] > 0.25) for item in results), "unavailable": sum(item["status"] != "evaluated" for item in results), "turns": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=DASHBOARD_DIR / "data")
    parser.add_argument("--env-file", type=Path, default=None)
    args = parser.parse_args()
    if args.env_file:
        load_env_file(args.env_file)
    else:
        load_env_file(DASHBOARD_DIR / ".env")
        load_env_file(DASHBOARD_DIR.parent.parent / "livekit" / ".env")
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    if not api_key:
        print("Missing ELEVENLABS_API_KEY. Set it or pass --env-file.", file=sys.stderr)
        return 2
    calls = load_calls(args.data_dir)
    if not calls:
        print(f"No calls found in {args.data_dir}.")
        return 0
    print("# STT challenger report — ElevenLabs Scribe v2\n")
    print("> This is estimated WER/model disagreement using the challenger as a pseudo-reference; it is not human-ground-truth accuracy. Semantic-risk analysis was not run.\n")
    for manifest, directory in calls:
        try:
            result = report_call(manifest, directory, api_key)
        except Exception as error:  # Keep the second call evaluable if one fails.
            result = {"session_id": manifest.get("session_id", directory.name), "status": "challenger_request_failed", "error": str(error)}
        print(f"## Call `{result['session_id']}`")
        if result["status"] != "complete":
            print(f"- Status: **{result['status']}**{f' — {result.get('error')}' if result.get('error') else ''}\n")
            continue
        median = result["median_estimated_wer"]
        print(f"- Evaluated turns: **{result['evaluated_turn_count']}/{result['turn_count']}**")
        print(f"- Median estimated WER: **{median:.2%}**" if median is not None else "- Median estimated WER: **unavailable**")
        print(f"- Moderate/high disagreement turns: **{result['moderate_or_high']}**; high (>25%): **{result['high']}**")
        print(f"- Mapping/unavailable turns: **{result['unavailable']}**")
        notable = [item for item in result["turns"] if item.get("estimated_wer", 0) >= 0.10 or item["status"] != "evaluated"]
        for item in notable[:5]:
            print(f"\n### Turn {item['turn_id']} — {item['status']}")
            if item.get("estimated_wer") is not None:
                print(f"WER: **{item['estimated_wer']:.2%}** | substitutions {item.get('substitutions', 0)}, deletions {item.get('deletions', 0)}, insertions {item.get('insertions', 0)}")
            print(f"Production: {item.get('production') or '(empty)'}")
            print(f"Challenger: {item.get('challenger') or '(empty)'}")
            changes = [f"{d.get('production_word') or '∅'} → {d.get('challenger_word') or '∅'} ({d['operation']})" for d in item.get("diff", []) if d["operation"] != "match"]
            if changes:
                print("Diff: " + "; ".join(changes[:12]))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
