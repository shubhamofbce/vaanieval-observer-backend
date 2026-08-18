"""Synthetic scale check for the aggregate dashboard fact tables.

Writes N calls of realistic shape into a throwaway database and times the
summary query. This exists so the tier-1 / tier-2 / tier-3 decision in
docs/aggregate-dashboard-architecture.md is made from measurement rather than
from an opinion about how fast SQLite is.

  .venv/bin/python scripts/scale_check.py 100000
"""
from __future__ import annotations

import random
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import aggregate  # noqa: E402

AGENTS = [f"agent-{index}" for index in range(12)]
PROVIDERS = ["deepgram", "sarvam", "elevenlabs"]
MODELS = ["nova-3", "gpt-4o", "bulbul:v3"]
TOOLS = [f"tool_{index}" for index in range(8)]


def build(path: Path, calls: int, turns_per_call: int = 11) -> None:
    if path.exists():
        path.unlink()
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    aggregate.ensure_schema(db)
    db.execute("PRAGMA journal_mode = WAL")
    rng = random.Random(7)
    now_ms = int(time.time() * 1000)
    span = 30 * 24 * 3600 * 1000

    call_rows, turn_rows, tool_rows, failure_rows = [], [], [], []
    for index in range(calls):
        session_id = f"s{index:07d}"
        agent = AGENTS[index % len(AGENTS)]
        started = now_ms - rng.randrange(span)
        failed_total = 0
        lag = 0
        measured = 0
        worst = 0
        for turn in range(turns_per_call):
            at = started + turn * 9000
            response = max(1, int(rng.lognormvariate(7.9, 0.55)))
            has_response = rng.random() < 0.85
            failed = 1 if rng.random() < 0.004 else 0
            failed_total += failed
            if has_response:
                measured += 1
                worst = max(worst, response)
                if response >= 3000:
                    lag += 1
            turn_rows.append((
                session_id, f"t{turn}", at, response if has_response else None,
                int(rng.lognormvariate(6.2, 0.4)), int(rng.lognormvariate(5.7, 0.3)), int(rng.lognormvariate(6.0, 0.3)),
                int(rng.lognormvariate(6.4, 0.5)), int(rng.lognormvariate(7.2, 0.5)), rng.randrange(200, 3000), rng.randrange(20, 400),
                int(rng.lognormvariate(6.1, 0.4)), int(rng.lognormvariate(6.9, 0.4)),
                1 if rng.random() < 0.3 else 0, int(rng.lognormvariate(5.5, 0.6)),
                1, 1, 1, 1,
                0, failed, 0, 0, 1 if rng.random() < 0.08 else 0,
                1 if rng.random() < 0.02 else 0, 0,
                PROVIDERS[0], MODELS[0], PROVIDERS[1], MODELS[1], PROVIDERS[2], MODELS[2],
            ))
            if rng.random() < 0.3:
                tool_rows.append((session_id, f"t{turn}", 0, TOOLS[rng.randrange(len(TOOLS))],
                                  int(rng.lognormvariate(5.5, 0.8)), 0, 0, at))
            if failed:
                failure_rows.append((session_id, f"t{turn}", turn, "llm", "llm:ReadTimeout", at))
        call_rows.append((
            session_id, agent, None, None, "python", "0.1.0", None, started, turns_per_call * 9000,
            "completed", "ready", turns_per_call, failed_total, 0, failed_total, 0, 0,
            lag, measured, 0, worst or None, 0, aggregate.METRICS_VERSION,
        ))
        if len(call_rows) >= 2000:
            flush(db, call_rows, turn_rows, tool_rows, failure_rows)
            call_rows, turn_rows, tool_rows, failure_rows = [], [], [], []
    flush(db, call_rows, turn_rows, tool_rows, failure_rows)
    db.commit()
    db.execute("ANALYZE")
    db.commit()
    return db


def flush(db, call_rows, turn_rows, tool_rows, failure_rows):
    if call_rows:
        db.executemany(f"INSERT INTO call_metrics VALUES ({','.join('?' * 23)})", call_rows)
    if turn_rows:
        db.executemany(
            f"INSERT INTO turn_metrics ({', '.join(aggregate.TURN_COLUMNS)}) "
            f"VALUES ({','.join('?' * len(aggregate.TURN_COLUMNS))})", turn_rows)
    if tool_rows:
        db.executemany("INSERT INTO tool_metrics VALUES (?,?,?,?,?,?,?,?)", tool_rows)
    if failure_rows:
        db.executemany("INSERT INTO failure_metrics VALUES (?,?,?,?,?,?)", failure_rows)


def main() -> None:
    calls = int(sys.argv[1]) if len(sys.argv) > 1 else 100_000
    path = Path("/tmp/vaani-scale.db")
    print(f"building {calls} calls ...")
    started = time.time()
    db = build(path, calls)
    print(f"  built in {time.time() - started:.1f}s, {path.stat().st_size / 1e6:.0f} MB")

    started = time.time()
    db.execute("INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) "
               "SELECT DISTINCT (t.started_at_epoch_ms / ?) * ?, COALESCE(c.agent_id, '') "
               "FROM turn_metrics t JOIN call_metrics c ON c.session_id = t.session_id",
               (aggregate.ROLLUP_BUCKET_MS, aggregate.ROLLUP_BUCKET_MS))
    db.execute("INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) "
               "SELECT DISTINCT (started_at_epoch_ms / ?) * ?, ? FROM turn_metrics",
               (aggregate.ROLLUP_BUCKET_MS, aggregate.ROLLUP_BUCKET_MS, aggregate.ALL_AGENTS))
    db.commit()
    pending = db.execute("SELECT COUNT(*) FROM rollup_dirty").fetchone()[0]
    aggregate.refresh_rollups(db, limit=10**9)
    db.commit()
    print(f"  rolled up {pending} buckets in {time.time() - started:.1f}s")

    now_ms = int(time.time() * 1000)
    for label, window_ms in (("1 hour", 3600_000), ("24 hours", 86_400_000),
                             ("7 days", 7 * 86_400_000), ("30 days", 30 * 86_400_000)):
        filters = aggregate.Filters(start_ms=now_ms - window_ms, end_ms=now_ms)
        timings = []
        for _ in range(3):
            begin = time.time()
            result = aggregate.summary(db, filters)
            timings.append((time.time() - begin) * 1000)
        print(f"  {label:9s} calls={result['coverage']['calls']:>7,} turns={result['coverage']['turns_in_range']:>8,} "
              f"summary={min(timings):7.0f}ms  exact={result['accuracy']['exact']}")


if __name__ == "__main__":
    main()
