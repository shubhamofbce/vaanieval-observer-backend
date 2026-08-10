"""Repair spans that older SDK builds mislabelled.

Two recording bugs wrote a wrong `status` onto spans that were actually healthy.
Both are fixed in the SDK, but a fix there only applies to calls recorded after
it, so every call already in the database keeps reporting the failure. This
rewrites those spans in place.

1. A session error closed *every* open span in the turn, so an LLM timeout
   marked the turn's completed transcription as a failed STT. Those spans are
   restored to `ok`, and their end is moved back to the final transcript --
   which is where the recorder would have ended them -- because the error's
   arrival time had stretched the span by tens of seconds and that duration is
   what the dashboard reports as user speech.

2. A provider socket still open when a call ended was always recorded as
   `cancelled`. A streaming STT socket is *meant* to stay open for the whole
   call, so every healthy completed call looked like it had lost its provider
   connection. Those are restored to `ok`.

Both the database and the `events.jsonl` package on disk are rewritten, so a
re-ingest cannot bring the old values back.

Usage:
    python scripts/backfill_misattributed_statuses.py --dry-run
    python scripts/backfill_misattributed_statuses.py --apply
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "vaani.db"
OBJECTS = ROOT / "data" / "objects"

# The recorder attributes a stage failure using LiveKit's own error type.
LLM_ERROR_MARKER = "llm_error"


def stage_error_was_misattributed(event: dict) -> bool:
    """An STT or TTS span failed by an error that belongs to the LLM stage."""
    if event.get("type") not in {"stt", "tts"} or event.get("status") != "error":
        return False
    message = ((event.get("error") or {}).get("message")) or ""
    return LLM_ERROR_MARKER in message


def socket_was_closed_by_teardown(event: dict, outcome: str | None) -> bool:
    """A connection span cancelled only because the call it belonged to ended."""
    return (
        event.get("scope") == "connection"
        and event.get("status") == "cancelled"
        and outcome == "completed"
    )


def true_end_of(event: dict) -> int | None:
    """Where the recorder would have ended this span, had the error not closed it.

    `_end_stt` ends an STT span at the final transcript, which is the milestone
    recorded here. Without this the span keeps the timestamp of an unrelated
    LLM timeout and reports that gap as user speech.
    """
    milestone = (event.get("milestones") or {}).get("final_transcript") or {}
    return milestone.get("occurred_at_ms")


def repair(event: dict, outcome: str | None) -> list[str]:
    """Correct `event` in place. Returns a description of what changed."""
    changes: list[str] = []
    if stage_error_was_misattributed(event):
        changes.append(f"status {event['status']} -> ok (error belonged to the LLM stage)")
        event["status"] = "ok"
        event["error"] = None
        ended = true_end_of(event)
        started = event.get("started_at_ms") or 0
        if ended is not None and ended >= started and ended != event.get("ended_at_ms"):
            changes.append(f"ended_at_ms {event.get('ended_at_ms')} -> {ended}")
            event["ended_at_ms"] = ended
            event["duration_ms"] = max(0, ended - started)
    elif socket_was_closed_by_teardown(event, outcome):
        changes.append("status cancelled -> ok (socket closed by teardown of a completed call)")
        event["status"] = "ok"
    return changes


def rewrite_package(session_id: str, outcome: str | None, apply: bool) -> int:
    """Repair the on-disk events.jsonl so a re-ingest cannot undo the fix."""
    path = OBJECTS / session_id / "events.jsonl"
    if not path.is_file():
        return 0
    lines = path.read_text(encoding="utf-8").splitlines()
    repaired = 0
    out: list[str] = []
    for line in lines:
        if not line.strip():
            out.append(line)
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            out.append(line)
            continue
        if repair(event, outcome):
            repaired += 1
            out.append(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
        else:
            out.append(line)
    if repaired and apply:
        path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return repaired


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true", help="report what would change")
    group.add_argument("--apply", action="store_true", help="write the corrections")
    parser.add_argument("--session", help="limit to one session id")
    args = parser.parse_args()

    if not DB.is_file():
        print(f"No database at {DB}", file=sys.stderr)
        return 1

    if args.apply:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = DB.with_name(f"{DB.name}.backup-{stamp}")
        shutil.copy2(DB, backup)
        print(f"Backed up database to {backup.name}\n")

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    outcomes = {
        row["id"]: (json.loads(row["manifest_json"]) or {}).get("outcome")
        for row in db.execute("SELECT id, manifest_json FROM sessions")
    }

    query = "SELECT id, session_id, operation_json FROM operations"
    params: tuple = ()
    if args.session:
        query += " WHERE session_id = ?"
        params = (args.session,)

    updates: list[tuple[str, str]] = []
    touched_sessions: set[str] = set()
    for row in db.execute(query, params):
        event = json.loads(row["operation_json"])
        changes = repair(event, outcomes.get(row["session_id"]))
        if not changes:
            continue
        touched_sessions.add(row["session_id"])
        updates.append((json.dumps(event, ensure_ascii=False, separators=(",", ":")), row["id"]))
        print(f"{row['session_id'][:8]} {row['id'][:8]} {event.get('type'):4} turn={event.get('turn_id') or '-':7}")
        for change in changes:
            print(f"    {change}")

    if args.apply and updates:
        db.executemany("UPDATE operations SET operation_json = ? WHERE id = ?", updates)
        db.commit()
    db.close()

    packages = sum(
        rewrite_package(session_id, outcomes.get(session_id), args.apply)
        for session_id in sorted(touched_sessions)
    )

    verb = "Repaired" if args.apply else "Would repair"
    print(f"\n{verb} {len(updates)} span(s) across {len(touched_sessions)} session(s).")
    print(f"{verb} {packages} span(s) in on-disk events.jsonl packages.")
    if not args.apply:
        print("\nRe-run with --apply to write these changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
