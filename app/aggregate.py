"""Aggregate dashboard: fact tables, ingest-time extraction, and the summary query.

Why fact tables rather than aggregating `operations` directly: a dashboard panel
that answers "P95 time to first audio for this agent, last 7 days" over the raw
table has to JSON-decode every span in range. At the current 68 calls that is
free. At the 100k calls this is being built for it is roughly 4M JSON blobs per
panel, per refresh. The extraction is therefore done once per call at ingest and
written to flat, indexed, numeric columns; the dashboard reads only those.

The tables are a derived cache, never a source of truth. `events.jsonl` and
`operations` remain authoritative, and `rebuild_session` can regenerate any row
from them, which is what makes changing a measurement definition safe: bump
`METRICS_VERSION`, and every stale row is rebuilt rather than silently mixed
with rows built under the old contract.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Callable, Iterable, Sequence

from app import metrics
from app import sketch as sketch_module
from app.metrics import (
    AUDIBLE_LAG_MS,
    METRICS_VERSION,
    MIN_SAMPLE_DELTA,
    MIN_TOOL_INVOCATIONS,
    distribution,
    rate,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS call_metrics (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT,
  environment TEXT,
  agent_version TEXT,
  sdk_language TEXT,
  sdk_version TEXT,
  started_at TEXT,
  started_at_epoch_ms INTEGER,
  duration_ms INTEGER,
  outcome TEXT,
  status TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  failed_op_count INTEGER NOT NULL DEFAULT 0,
  stt_failed INTEGER NOT NULL DEFAULT 0,
  llm_failed INTEGER NOT NULL DEFAULT 0,
  tts_failed INTEGER NOT NULL DEFAULT 0,
  tool_failed INTEGER NOT NULL DEFAULT 0,
  audible_lag_turns INTEGER NOT NULL DEFAULT 0,
  measured_response_turns INTEGER NOT NULL DEFAULT 0,
  missing_final_turns INTEGER NOT NULL DEFAULT 0,
  max_response_latency_ms INTEGER,
  capture_incomplete INTEGER NOT NULL DEFAULT 0,
  inferred_reply_turns INTEGER NOT NULL DEFAULT 0,
  metrics_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS call_metrics_time ON call_metrics(started_at_epoch_ms);
CREATE INDEX IF NOT EXISTS call_metrics_agent_time ON call_metrics(agent_id, started_at_epoch_ms);

CREATE TABLE IF NOT EXISTS turn_metrics (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  started_at_epoch_ms INTEGER,
  response_latency_ms INTEGER,
  stt_first_partial_ms INTEGER,
  stt_endpoint_delay_ms INTEGER,
  stt_final_ms INTEGER,
  llm_ttft_ms INTEGER,
  llm_completion_ms INTEGER,
  llm_input_tokens INTEGER,
  llm_output_tokens INTEGER,
  tts_first_audio_ms INTEGER,
  tts_synthesis_ms INTEGER,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tool_total_ms INTEGER,
  stt_ops INTEGER NOT NULL DEFAULT 0,
  llm_ops INTEGER NOT NULL DEFAULT 0,
  tts_ops INTEGER NOT NULL DEFAULT 0,
  tool_ops INTEGER NOT NULL DEFAULT 0,
  stt_failed INTEGER NOT NULL DEFAULT 0,
  llm_failed INTEGER NOT NULL DEFAULT 0,
  tts_failed INTEGER NOT NULL DEFAULT 0,
  tool_failed INTEGER NOT NULL DEFAULT 0,
  tts_interrupted INTEGER NOT NULL DEFAULT 0,
  stt_missing_final INTEGER NOT NULL DEFAULT 0,
  stt_forced_flush INTEGER NOT NULL DEFAULT 0,
  -- Set when this row is the second half of one caller message we had to
  -- record as two turns. It stays a row, because it carries real measurements
  -- of real audio, but it must not be counted as a second exchange.
  is_continuation INTEGER NOT NULL DEFAULT 0,
  -- Set on the *first* half instead, because "this exchange was split" is a
  -- fact about the exchange, and an exchange belongs to the bucket it started
  -- in -- the same rule calls already follow when they span an hour. Kept on
  -- the continuation, an hour holding only the second half reported zero
  -- exchanges while also reporting one of them was split.
  has_continuation INTEGER NOT NULL DEFAULT 0,
  -- Set per stage on that same first half when both halves ran that stage, so
  -- the stage really is measured twice for one exchange. Only stages that ran
  -- on both halves inflate their own denominator, and which ones those are
  -- cannot be recovered from range totals: a range can hold as many stage rows
  -- as exchanges and still be double counting one of them. Decided at ingest,
  -- where both halves are in hand.
  stt_split INTEGER NOT NULL DEFAULT 0,
  llm_split INTEGER NOT NULL DEFAULT 0,
  tts_split INTEGER NOT NULL DEFAULT 0,
  tool_split INTEGER NOT NULL DEFAULT 0,
  stt_provider TEXT, stt_model TEXT,
  llm_provider TEXT, llm_model TEXT,
  tts_provider TEXT, tts_model TEXT,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS turn_metrics_time ON turn_metrics(started_at_epoch_ms);

CREATE TABLE IF NOT EXISTS tool_metrics (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  duration_ms INTEGER,
  failed INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  started_at_epoch_ms INTEGER,
  PRIMARY KEY (session_id, turn_id, seq)
);
CREATE INDEX IF NOT EXISTS tool_metrics_name ON tool_metrics(tool_name);
CREATE INDEX IF NOT EXISTS tool_metrics_time ON tool_metrics(started_at_epoch_ms);

CREATE TABLE IF NOT EXISTS failure_metrics (
  session_id TEXT NOT NULL,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  started_at_epoch_ms INTEGER,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS failure_metrics_fingerprint ON failure_metrics(fingerprint);
CREATE INDEX IF NOT EXISTS failure_metrics_time ON failure_metrics(started_at_epoch_ms);

-- Hourly rollups. Percentiles are not summable, so each bucket keeps a
-- mergeable DDSketch per metric alongside the exactly-summable counters. This
-- is what lets a 30-day view answer in milliseconds instead of sorting a
-- million rows per panel.
CREATE TABLE IF NOT EXISTS interval_rollups (
  bucket_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  split_turns INTEGER NOT NULL DEFAULT 0,
  measured_response_turns INTEGER NOT NULL DEFAULT 0,
  audible_lag_turns INTEGER NOT NULL DEFAULT 0,
  failing_calls INTEGER NOT NULL DEFAULT 0,
  capture_incomplete_calls INTEGER NOT NULL DEFAULT 0,
  completed_calls INTEGER NOT NULL DEFAULT 0,
  incomplete_calls INTEGER NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  stt_ops INTEGER NOT NULL DEFAULT 0, llm_ops INTEGER NOT NULL DEFAULT 0,
  tts_ops INTEGER NOT NULL DEFAULT 0, tool_ops INTEGER NOT NULL DEFAULT 0,
  stt_failed INTEGER NOT NULL DEFAULT 0, llm_failed INTEGER NOT NULL DEFAULT 0,
  tts_failed INTEGER NOT NULL DEFAULT 0, tool_failed INTEGER NOT NULL DEFAULT 0,
  stt_calls_impacted INTEGER NOT NULL DEFAULT 0, llm_calls_impacted INTEGER NOT NULL DEFAULT 0,
  tts_calls_impacted INTEGER NOT NULL DEFAULT 0, tool_calls_impacted INTEGER NOT NULL DEFAULT 0,
  tts_interrupted INTEGER NOT NULL DEFAULT 0,
  stt_missing_final INTEGER NOT NULL DEFAULT 0,
  stt_forced_flush INTEGER NOT NULL DEFAULT 0,
  stt_split_turns INTEGER NOT NULL DEFAULT 0,
  llm_split_turns INTEGER NOT NULL DEFAULT 0,
  tts_split_turns INTEGER NOT NULL DEFAULT 0,
  tool_split_turns INTEGER NOT NULL DEFAULT 0,
  stt_turns INTEGER NOT NULL DEFAULT 0,
  llm_turns INTEGER NOT NULL DEFAULT 0,
  tts_turns INTEGER NOT NULL DEFAULT 0,
  tool_turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_ms, agent_id)
);
CREATE INDEX IF NOT EXISTS interval_rollups_time ON interval_rollups(bucket_ms);

CREATE TABLE IF NOT EXISTS metric_rollups (
  bucket_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,
  sketch BLOB NOT NULL,
  PRIMARY KEY (bucket_ms, agent_id, metric)
);
CREATE INDEX IF NOT EXISTS metric_rollups_time ON metric_rollups(bucket_ms);

CREATE TABLE IF NOT EXISTS tool_rollups (
  bucket_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL,
  invocations INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  failed_calls INTEGER NOT NULL DEFAULT 0,
  sketch BLOB NOT NULL,
  PRIMARY KEY (bucket_ms, agent_id, tool_name)
);

CREATE TABLE IF NOT EXISTS failure_rollups (
  bucket_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_ms, agent_id, stage, fingerprint)
);

-- Buckets whose raw rows changed since they were last rolled up. Recomputing a
-- marked bucket from `turn_metrics` is idempotent, which is what makes a
-- re-uploaded call safe: an incremental merge would double-count it.
CREATE TABLE IF NOT EXISTS rollup_dirty (
  bucket_ms INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (bucket_ms, agent_id)
);

-- Filter values that exist in the data. Maintained at ingest because
-- `SELECT DISTINCT provider FROM turn_metrics` is a full scan of every turn
-- ever recorded, and it was measured at 562 ms on a 1.1M-turn table - paid on
-- every dashboard load, to render six dropdowns.
CREATE TABLE IF NOT EXISTS metric_facets (
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  last_seen_ms INTEGER,
  PRIMARY KEY (dimension, value)
);

-- Format markers for the derived tier. A stored value that no longer matches
-- the code means every rollup in the database was written under different
-- rules, and the tier is rebuilt rather than read.
CREATE TABLE IF NOT EXISTS rollup_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

TURN_COLUMNS = (
    "session_id", "turn_id", "started_at_epoch_ms", "response_latency_ms",
    "stt_first_partial_ms", "stt_endpoint_delay_ms", "stt_final_ms",
    "llm_ttft_ms", "llm_completion_ms", "llm_input_tokens", "llm_output_tokens",
    "tts_first_audio_ms", "tts_synthesis_ms", "tool_count", "tool_total_ms",
    "stt_ops", "llm_ops", "tts_ops", "tool_ops",
    "stt_failed", "llm_failed", "tts_failed", "tool_failed", "tts_interrupted",
    "stt_missing_final", "stt_forced_flush", "is_continuation", "has_continuation",
    "stt_split", "llm_split", "tts_split", "tool_split", "inferred_reply",
    "stt_provider", "stt_model", "llm_provider", "llm_model", "tts_provider", "tts_model",
)

# Bucket widths offered for the trend chart, chosen so a range always renders
# between ~24 and ~120 points. Fewer hides an incident; more is noise.
BUCKET_LADDER_MS = (
    60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000,
    6 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000,
)
TARGET_BUCKETS = 48

# A triage list nobody scrolls is a list nobody uses. Twenty-five is roughly one
# screen; the response reports how many more matched so the count is never a
# silent truncation.
ATTENTION_LIMIT = 25

# Rollup bucket width. One hour is the finest grain a 30-day view needs and the
# coarsest a same-day investigation tolerates.
ROLLUP_BUCKET_MS = 60 * 60 * 1000
# Above this many turns in range, exact percentiles stop being a dashboard.
# The limit is a latency budget, not a row count: the exact path materialises
# and sorts every turn in Python, and was measured at 518 ms for 37k turns and
# 2,432 ms for 196k. 50k keeps the worst exact answer under ~700 ms; beyond it
# the sketch tier answers in milliseconds with a stated 1% relative error bound.
EXACT_TURN_LIMIT = 50_000
# The rollup row that answers an unfiltered dashboard in one read. Without it,
# an unfiltered 30-day view has to merge one sketch per agent per hour per
# metric - measured at 78,000 sketch merges and 1.7 s for twelve agents, and it
# gets linearly worse with every agent onboarded. With it, the same view merges
# 720. Real agent ids are namespaced by the SDK's manifest and cannot collide
# with this sentinel.
ALL_AGENTS = "__all__"
# Every latency column that gets an hourly sketch.
SKETCH_METRICS = (
    "response_latency_ms",
    "stt_first_partial_ms", "stt_endpoint_delay_ms", "stt_final_ms",
    "llm_ttft_ms", "llm_completion_ms",
    "tts_first_audio_ms", "tts_synthesis_ms",
    "tool_total_ms",
)


# Columns added after the first release. An existing install has the table
# already, so `CREATE TABLE IF NOT EXISTS` alone would silently leave it on the
# old shape and every rollup read would fail on a missing column.
ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("interval_rollups", "llm_turns", "INTEGER NOT NULL DEFAULT 0"),
    ("interval_rollups", "tts_turns", "INTEGER NOT NULL DEFAULT 0"),
    ("interval_rollups", "tool_turns", "INTEGER NOT NULL DEFAULT 0"),
    # Added when split exchanges started being recorded as two rows. Without
    # these two entries an existing database keeps the old table definition,
    # and the very next rebuild - which the METRICS_VERSION bump forces on
    # every upgrade - dies on "no such column" with the console already live.
    ("turn_metrics", "is_continuation", "INTEGER NOT NULL DEFAULT 0"),
    # Added when the reply-attribution caveat started being counted. An
    # existing database keeps its old table definition, and the rebuild the
    # METRICS_VERSION bump forces on upgrade would die on "no such column"
    # with the console already live.
    ("turn_metrics", "inferred_reply", "INTEGER NOT NULL DEFAULT 0"),
    ("call_metrics", "inferred_reply_turns", "INTEGER NOT NULL DEFAULT 0"),
    ("turn_metrics", "has_continuation", "INTEGER NOT NULL DEFAULT 0"),
    ("interval_rollups", "split_turns", "INTEGER NOT NULL DEFAULT 0"),
    # Added when the split caveat stopped being inferred from range totals. The
    # inference was wrong at the boundary where a stage ran on both halves of a
    # split while an unrelated turn kept the totals level, which hid a real
    # double count behind a clean "100% covered".
    *((table, f"{stage}_split{suffix}", "INTEGER NOT NULL DEFAULT 0")
      for table, suffix in (("turn_metrics", ""), ("interval_rollups", "_turns"))
      for stage in ("stt", "llm", "tts", "tool")),
)


# The attention queue's predicate is a chain of ORs, which no ordinary index can
# serve: it degrades to a full scan of every call ever recorded, twice per
# dashboard load (once to count, once to fetch). A partial index stores only the
# rows that can ever appear on the list - a small minority of a healthy fleet.
# Built from the same string `_attention` uses, because SQLite silently declines
# to use a partial index whose WHERE clause is not matched by the query's.
def _attention_index_sql() -> str:
    predicate = ATTENTION_PREDICATE.replace("c.", "")
    return (f"CREATE INDEX IF NOT EXISTS {ATTENTION_INDEX} "
            f"ON call_metrics(started_at_epoch_ms) WHERE {predicate}")


def ensure_schema(db: sqlite3.Connection) -> None:
    db.executescript(SCHEMA)
    # A predicate change renames the index, so the stale one is dropped rather
    # than left behind to be maintained on every write and never read.
    for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'index' "
                          "AND tbl_name = 'call_metrics' AND name LIKE 'call_metrics_attention%'").fetchall():
        if row["name"] != ATTENTION_INDEX:
            db.execute(f"DROP INDEX IF EXISTS {row['name']}")
    db.execute(_attention_index_sql())
    for table, column, declaration in ADDED_COLUMNS:
        present = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
        if column not in present:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
    _ensure_sketch_format(db)


ROLLUP_TABLES = ("interval_rollups", "metric_rollups", "tool_rollups", "failure_rollups")


def get_meta(db: sqlite3.Connection, key: str) -> str | None:
    row = db.execute("SELECT value FROM rollup_meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(db: sqlite3.Connection, key: str, value: str) -> None:
    db.execute("INSERT OR REPLACE INTO rollup_meta (key, value) VALUES (?, ?)", (key, value))
    db.commit()


def release_lease(db: sqlite3.Connection, key: str, identity: str) -> bool:
    """Give up a lease, but only if it is still ours.

    Ownership is re-checked in the delete predicate rather than trusted from
    memory: a worker whose pass overran the TTL may have already been replaced,
    and an unconditional delete would then evict the live owner and put two
    workers back on the same work — the exact thing the lease exists to stop.

    Called on the failure path. Without it a worker that crashed mid-pass left
    its name on the lease, and the process that replaced it skipped the work
    until the TTL expired, so a failure silently became a stall.
    """
    cur = db.execute(
        "DELETE FROM rollup_meta WHERE key = ? AND "
        "substr(value, instr(value, '@') + 1) = ?", (key, identity))
    db.commit()
    return cur.rowcount > 0


def claim_lease(db: sqlite3.Connection, key: str, identity: str,
                ttl_ms: int, now_ms: int) -> bool:
    """Take or renew a single-owner lease, atomically.

    One statement, so the read of the incumbent and the write of the new owner
    happen under the same write lock. A read-then-write version lets two
    processes both observe an empty lease and both claim it - which is exactly
    what happens at startup, when every worker's deferred first pass fires at
    the same moment.

    Ownership is "this statement changed the row". `value` is `ms@identity`,
    timestamp first because SQLite's `instr` finds the FIRST separator: with the
    identity first, an identity containing '@' parsed as a different owner and
    could never renew its own lease. The incumbent keeps the lease while it
    renews and loses it `ttl_ms` after it stops. A value with no separator at
    all (truncated, hand-edited) is treated as free rather than jamming
    maintenance forever.
    """
    cutoff = now_ms - ttl_ms
    cur = db.execute(
        "INSERT INTO rollup_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE "
        # same owner renewing, or the incumbent stopped renewing long enough ago
        "  substr(rollup_meta.value, instr(rollup_meta.value, '@') + 1) = ? "
        "  OR instr(rollup_meta.value, '@') = 0 "
        "  OR CAST(substr(rollup_meta.value, 1, instr(rollup_meta.value, '@') - 1) AS INTEGER) < ?",
        (key, f"{now_ms}@{identity}", identity, cutoff))
    db.commit()
    return cur.rowcount > 0


def _ensure_sketch_format(db: sqlite3.Connection) -> None:
    """Discard the rollup tier if it was written under a different sketch format.

    A DDSketch bucket index only means anything relative to the gamma it was
    written with, so merging blobs across a change of `RELATIVE_ERROR` would
    produce plausible-looking but wrong percentiles. Rather than trust the
    operator to remember, the stored tag is compared on every open and the
    affected hours are queued for recomputation from `turn_metrics`, which is
    the source of truth and unaffected.
    """
    row = db.execute("SELECT value FROM rollup_meta WHERE key = 'sketch_format'").fetchone()
    stored = row["value"] if row else None
    if stored == sketch_module.FORMAT_TAG:
        return
    for table in ROLLUP_TABLES:
        db.execute(f"DELETE FROM {table}")
    for scope in ("", ALL_AGENTS):
        db.execute(
            "INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) "
            "SELECT DISTINCT (t.started_at_epoch_ms / ?) * ?, "
            "  CASE WHEN ? = '' THEN COALESCE(c.agent_id, '') ELSE ? END "
            "FROM turn_metrics t JOIN call_metrics c ON c.session_id = t.session_id "
            "WHERE t.started_at_epoch_ms IS NOT NULL",
            (ROLLUP_BUCKET_MS, ROLLUP_BUCKET_MS, scope, scope),
        )
    db.execute(
        "INSERT OR REPLACE INTO rollup_meta (key, value) VALUES ('sketch_format', ?)",
        (sketch_module.FORMAT_TAG,),
    )
    db.commit()


# --------------------------------------------------------------------------
# Ingest
# --------------------------------------------------------------------------

def rebuild_session(
    db: sqlite3.Connection,
    session_row: sqlite3.Row | dict[str, Any],
    turns: Sequence[dict[str, Any]],
    operations: Sequence[dict[str, Any]],
) -> None:
    """Replace every derived row for one call. Idempotent by construction.

    Delete-then-insert rather than upsert: a re-uploaded call can have *fewer*
    turns than the previous attempt, and an upsert would leave the extra turns
    behind to be counted forever.
    """
    session_id = session_row["id"]
    manifest = json.loads(session_row["manifest_json"]) if isinstance(session_row["manifest_json"], str) else session_row["manifest_json"]
    metadata = manifest.get("metadata") if isinstance(manifest.get("metadata"), dict) else {}
    sdk = manifest.get("sdk") if isinstance(manifest.get("sdk"), dict) else {}
    capture = manifest.get("capture_status") if isinstance(manifest.get("capture_status"), dict) else {}
    started_epoch = metrics.epoch_ms(manifest.get("started_at"))

    rows = [metrics.turn_metrics(turn, started_epoch) for turn in turns]
    # `is_continuation` is what the exact counts, the time series and the
    # hourly rollup all subtract, so it carries the same present-parent rule
    # the call rollup and the browser use. Derived once here, not re-derived
    # per query, so the six counters cannot drift apart again.
    metrics.resolve_split_columns(rows)
    rollup = metrics.call_metrics(rows)

    # Captured BEFORE the delete. A re-upload can correct a call's clock and
    # move it to a different hour; deriving dirty buckets only from the new rows
    # would leave the hour it used to occupy holding its old contribution for
    # ever, and no later pass would ever notice.
    previous_buckets = _session_buckets(db, session_id)

    db.execute("DELETE FROM turn_metrics WHERE session_id = ?", (session_id,))
    db.execute("DELETE FROM tool_metrics WHERE session_id = ?", (session_id,))
    db.execute("DELETE FROM failure_metrics WHERE session_id = ?", (session_id,))
    db.execute("DELETE FROM call_metrics WHERE session_id = ?", (session_id,))

    if rows:
        db.executemany(
            f"INSERT INTO turn_metrics ({', '.join(TURN_COLUMNS)}) "
            f"VALUES ({', '.join('?' for _ in TURN_COLUMNS)})",
            [tuple([session_id] + [row.get(column) for column in TURN_COLUMNS[1:]]) for row in rows],
        )

    tools: list[tuple[Any, ...]] = []
    for turn in turns:
        turn_started = metrics.turn_metrics(turn, started_epoch)["started_at_epoch_ms"] if started_epoch else None
        for seq, tool in enumerate(metrics.tool_rows(turn)):
            tools.append((session_id, tool["turn_id"], seq, tool["tool_name"],
                          tool["duration_ms"], tool["failed"], tool["timed_out"], turn_started))
    if tools:
        db.executemany(
            "INSERT INTO tool_metrics (session_id, turn_id, seq, tool_name, duration_ms, failed, timed_out, started_at_epoch_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            tools,
        )

    failures: list[tuple[Any, ...]] = []
    for seq, op in enumerate(operations):
        fingerprint = metrics.error_fingerprint(op)
        if not fingerprint:
            continue
        at = op.get("started_at_ms")
        failures.append((
            session_id,
            str(op.get("turn_id")) if op.get("turn_id") is not None else None,
            seq,
            str(op.get("type")),
            fingerprint,
            (started_epoch + at) if started_epoch is not None and isinstance(at, (int, float)) else None,
        ))
    if failures:
        db.executemany(
            "INSERT INTO failure_metrics (session_id, turn_id, seq, stage, fingerprint, started_at_epoch_ms) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            failures,
        )

    capture_incomplete = 1 if (
        capture.get("events_complete") is False
        or capture.get("audio_complete") is False
        or (capture.get("dropped_event_count") or 0) > 0
        or (capture.get("dropped_audio_chunk_count") or 0) > 0
    ) else 0

    db.execute(
        "INSERT INTO call_metrics (session_id, agent_id, environment, agent_version, sdk_language, sdk_version, "
        "started_at, started_at_epoch_ms, duration_ms, outcome, status, turn_count, failed_op_count, "
        "stt_failed, llm_failed, tts_failed, tool_failed, audible_lag_turns, measured_response_turns, "
        "missing_final_turns, max_response_latency_ms, capture_incomplete, inferred_reply_turns, "
        "metrics_version) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session_id,
            manifest.get("agent_id"),
            _text(metadata.get("environment") or metadata.get("env")),
            _text(metadata.get("agent_version") or metadata.get("version")),
            _text(sdk.get("language")), _text(sdk.get("version")),
            manifest.get("started_at"), started_epoch,
            manifest.get("duration_ms"), manifest.get("outcome"), session_row["status"],
            rollup["turn_count"], rollup["failed_op_count"],
            rollup["stt_failed"], rollup["llm_failed"], rollup["tts_failed"], rollup["tool_failed"],
            rollup["audible_lag_turns"], rollup["measured_response_turns"],
            rollup["missing_final_turns"], rollup["max_response_latency_ms"],
            capture_incomplete, rollup["inferred_reply_turns"], METRICS_VERSION,
        ),
    )
    _mark_dirty(db, session_id, manifest.get("agent_id"), previous_buckets)
    _record_facets(db, manifest, sdk, rows, started_epoch)


def _record_facets(db: sqlite3.Connection, manifest: dict[str, Any], sdk: dict[str, Any],
                   rows: Sequence[dict[str, Any]], started_epoch: int | None) -> None:
    seen: set[tuple[str, str]] = set()
    for dimension, value in (
        ("agent_id", manifest.get("agent_id")),
        ("sdk_language", _text(sdk.get("language"))),
    ):
        if value:
            seen.add((dimension, str(value)))
    for row in rows:
        for stage in ("stt", "llm", "tts"):
            if row.get(f"{stage}_provider"):
                seen.add(("provider", row[f"{stage}_provider"]))
            if row.get(f"{stage}_model"):
                seen.add(("model", row[f"{stage}_model"]))
    if seen:
        db.executemany(
            "INSERT INTO metric_facets (dimension, value, last_seen_ms) VALUES (?, ?, ?) "
            "ON CONFLICT(dimension, value) DO UPDATE SET last_seen_ms = MAX(COALESCE(last_seen_ms, 0), excluded.last_seen_ms)",
            [(dimension, value, started_epoch or 0) for dimension, value in sorted(seen)],
        )


def prune_facets(db: sqlite3.Connection) -> int:
    """Drop facet values no call carries any more.

    `metric_facets` is an append-only index, so a value survives the call that
    introduced it. That is correct for a deleted call but wrong after a
    definition change: canonicalising providers left `deepgram-stt` and `stt`
    offered in the dropdown next to the `deepgram` they had been merged into, and
    selecting one returned nothing. Filters must only offer values that match
    something.
    """
    live = "SELECT DISTINCT %s AS v FROM %s WHERE %s IS NOT NULL"
    sources = {
        "agent_id": [live % ("agent_id", "call_metrics", "agent_id")],
        "sdk_language": [live % ("sdk_language", "call_metrics", "sdk_language")],
        "provider": [live % (f"{stage}_provider", "turn_metrics", f"{stage}_provider")
                     for stage in metrics.STAGES if stage != "tool"],
        "model": [live % (f"{stage}_model", "turn_metrics", f"{stage}_model")
                  for stage in metrics.STAGES if stage != "tool"],
    }
    removed = 0
    for dimension, queries in sources.items():
        current = {row["v"] for query in queries for row in db.execute(query)}
        stored = [row["value"] for row in db.execute(
            "SELECT value FROM metric_facets WHERE dimension = ?", (dimension,))]
        gone = [value for value in stored if value not in current]
        for value in gone:
            db.execute("DELETE FROM metric_facets WHERE dimension = ? AND value = ?", (dimension, value))
        removed += len(gone)
    return removed


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def stale_session_count(db: sqlite3.Connection) -> int:
    """How many calls still need deriving. Counted, not listed.

    The summary only ever reported `len()` of the id list, and materialising
    every stale id into Python to do that is unbounded work on the request path:
    right after a `METRICS_VERSION` bump, every call in the archive is stale.
    """
    return db.execute(
        "SELECT COUNT(*) AS pending FROM sessions s LEFT JOIN call_metrics c ON c.session_id = s.id "
        "WHERE c.session_id IS NULL OR c.metrics_version < ?",
        (METRICS_VERSION,),
    ).fetchone()["pending"]


def incompatible_session_count(db: sqlite3.Connection) -> int:
    """Calls derived by a *newer* contract than this process understands.

    Neither stale nor current. A rolling deployment, or a rollback, briefly puts
    two versions on one database; the newer worker's rows then outlive it. The
    backlog queries look only for missing or *older* rows, so such a row was
    invisible: it counted toward total turns and every latency panel, counted
    zero toward figures scoped to the current contract, and counted zero toward
    pending — a real caveat turning into a healthy-looking zero with nothing on
    the page to say so, which is the exact shape this audit exists to remove.

    Deliberately not rebuilt. Older code cannot reproduce newer semantics, and
    overwriting the row would destroy work the newer worker did correctly. It is
    reported instead, so the contract-scoped figures are read as partial.
    """
    return db.execute(
        "SELECT COUNT(*) AS ahead FROM call_metrics WHERE metrics_version > ?",
        (METRICS_VERSION,),
    ).fetchone()["ahead"]


def unbuilt_session_count(db: sqlite3.Connection) -> int:
    """Calls with no derived row at all — the ones genuinely absent from every number.

    Split out from `stale_session_count` because the two halves of "pending"
    affect the page in opposite ways and were being reported as one. A call with
    no `call_metrics` row contributes nothing anywhere. A call whose row was
    built by an older contract contributes to every count, duration and latency
    panel on the page; it is only missing from figures the newer contract
    added. Telling a reader that both are "missing from every number" is false
    for the second kind, and false in the reassuring direction.
    """
    return db.execute(
        "SELECT COUNT(*) AS pending FROM sessions s LEFT JOIN call_metrics c ON c.session_id = s.id "
        "WHERE c.session_id IS NULL",
    ).fetchone()["pending"]


def stale_session_ids(db: sqlite3.Connection) -> list[str]:
    """Calls whose derived rows are missing or were built by an older contract."""
    return [
        row["id"]
        for row in db.execute(
            "SELECT s.id FROM sessions s LEFT JOIN call_metrics c ON c.session_id = s.id "
            "WHERE c.session_id IS NULL OR c.metrics_version < ? ORDER BY s.created_at",
            (METRICS_VERSION,),
        )
    ]


def backfill(db: sqlite3.Connection, load: Callable[[str], tuple[Any, Sequence[dict], Sequence[dict]]],
             limit: int | None = None, on_progress: Callable[[], None] | None = None) -> int:
    """Rebuild stale calls. Returns how many were rebuilt.

    Bounded by `limit` so a cold start against a large archive does not block
    the first request; the remainder is picked up on subsequent passes and the
    dashboard reports how many calls are still pending rather than quietly
    under-reporting traffic.
    """
    pending = stale_session_ids(db)
    if limit is not None:
        pending = pending[:limit]
    built = 0
    for session_id in pending:
        try:
            session_row, turns, operations = load(session_id)
        except Exception:  # noqa: BLE001 - one unreadable call must not stop the rest
            continue
        rebuild_session(db, session_row, turns, operations)
        built += 1
        if on_progress is not None:
            # A pass is bounded by call count, not by time, and one call can
            # hold an unbounded number of operations. The caller uses this to
            # renew a lease it would otherwise let expire while still working,
            # which would admit a second worker onto the same rows.
            on_progress()
    return built


# --------------------------------------------------------------------------
# Rollups
# --------------------------------------------------------------------------

def _session_buckets(db: sqlite3.Connection, session_id: str) -> list[int]:
    """The hour buckets this call's derived turns currently sit in."""
    return [
        row["bucket_ms"]
        for row in db.execute(
            "SELECT DISTINCT (started_at_epoch_ms / ?) * ? AS bucket_ms FROM turn_metrics "
            "WHERE session_id = ? AND started_at_epoch_ms IS NOT NULL",
            (ROLLUP_BUCKET_MS, ROLLUP_BUCKET_MS, session_id),
        )
    ]


def _mark_dirty(db: sqlite3.Connection, session_id: str, agent_id: str | None,
                extra_buckets: Sequence[int] = ()) -> None:
    """Mark every hour this call touched for recomputation.

    Read from `turn_metrics` after the rebuild rather than derived from the call
    start, because a long call spans several hours and rolling up only the first
    would leave the later ones permanently stale.
    """
    for scope in (agent_id or "", ALL_AGENTS):
        db.execute(
            "INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) "
            "SELECT DISTINCT (started_at_epoch_ms / ?) * ?, ? FROM turn_metrics "
            "WHERE session_id = ? AND started_at_epoch_ms IS NOT NULL",
            (ROLLUP_BUCKET_MS, ROLLUP_BUCKET_MS, scope, session_id),
        )
    # A call whose rows were just deleted still has to invalidate the buckets it
    # used to occupy, or a removed call keeps being counted forever.
    db.execute(
        "INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) "
        "SELECT DISTINCT bucket_ms, agent_id FROM interval_rollups WHERE agent_id IN (?, ?) AND bucket_ms IN "
        "(SELECT (started_at_epoch_ms / ?) * ? FROM turn_metrics WHERE session_id = ?)",
        (agent_id or "", ALL_AGENTS, ROLLUP_BUCKET_MS, ROLLUP_BUCKET_MS, session_id),
    )
    # Hours the call occupied before this rebuild, which its new rows may no
    # longer touch.
    for bucket in extra_buckets:
        for scope in (agent_id or "", ALL_AGENTS):
            db.execute("INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) VALUES (?, ?)",
                       (bucket, scope))


def dirty_bucket_count(db: sqlite3.Connection) -> int:
    """Rollup buckets awaiting a rebuild. Reported so a lagging maintenance
    thread shows up as stated staleness rather than as quietly wrong history."""
    return db.execute("SELECT COUNT(*) AS n FROM rollup_dirty").fetchone()["n"]


def refresh_rollups(db: sqlite3.Connection, limit: int = 500, budget_s: float | None = None) -> int:
    """Recompute dirty hour buckets from the raw turn rows. Idempotent.

    Oldest first. Newest-first ordering starves the backlog whenever churn
    outruns one pass - and the starved buckets are precisely the historical ones
    a 30-day view reads, so the long range would stay wrong indefinitely while
    the last hour looked healthy.

    **One commit per bucket.** A single transaction around the whole pass was
    measured holding SQLite's write lock for 27.5 s at 100k calls, projecting to
    ~4.6 minutes at 1M - long past the ingest connection's busy timeout, so a
    call being uploaded during a pass would fail outright. Each bucket's
    delete-recompute-insert still commits as one unit, which is what keeps a
    rebuild atomic; only the pass as a whole is now interruptible. A reader
    landing mid-pass sees some hours refreshed and some not, which the tier
    already reports through `pending_rollup_buckets`.

    `budget_s` bounds wall-clock rather than bucket count, because lock-hold
    time is what ingest actually feels: a bucket in a busy hour costs far more
    to rebuild than one in a quiet hour.
    """
    dirty = db.execute(
        "SELECT bucket_ms, agent_id FROM rollup_dirty ORDER BY bucket_ms ASC LIMIT ?", (limit,)
    ).fetchall()
    started = time.monotonic()
    done = 0
    for row in dirty:
        _rebuild_bucket(db, row["bucket_ms"], row["agent_id"])
        db.execute("DELETE FROM rollup_dirty WHERE bucket_ms = ? AND agent_id = ?",
                   (row["bucket_ms"], row["agent_id"]))
        db.commit()
        done += 1
        if budget_s is not None and time.monotonic() - started >= budget_s:
            break
    return done


def _rebuild_bucket(db: sqlite3.Connection, bucket_ms: int, agent_id: str) -> None:
    end_ms = bucket_ms + ROLLUP_BUCKET_MS
    # The all-agents row covers every call; a per-agent row covers one.
    everyone = agent_id == ALL_AGENTS
    scope = ("SELECT session_id FROM call_metrics" if everyone
             else "SELECT session_id FROM call_metrics WHERE COALESCE(agent_id, '') = ?")
    scope_params: list[Any] = [] if everyone else [agent_id]
    for table in ("interval_rollups", "metric_rollups", "tool_rollups", "failure_rollups"):
        db.execute(f"DELETE FROM {table} WHERE bucket_ms = ? AND agent_id = ?", (bucket_ms, agent_id))

    rows = db.execute(
        f"SELECT {', '.join(SKETCH_METRICS)}, session_id, stt_ops, llm_ops, tts_ops, tool_ops, "
        "stt_failed, llm_failed, tts_failed, tool_failed, tts_interrupted, "
        "stt_missing_final, stt_forced_flush, is_continuation, has_continuation, "
        "stt_split, llm_split, tts_split, tool_split "
        f"FROM turn_metrics WHERE started_at_epoch_ms >= ? AND started_at_epoch_ms < ? AND session_id IN ({scope})",
        [bucket_ms, end_ms] + scope_params,
    ).fetchall()
    if not rows:
        return

    sketches = {metric: sketch_module.Sketch() for metric in SKETCH_METRICS}
    counters = {name: 0 for name in (
        "turns", "split_turns", "measured_response_turns", "audible_lag_turns", "stt_ops", "llm_ops", "tts_ops",
        "tool_ops", "stt_failed", "llm_failed", "tts_failed", "tool_failed", "tts_interrupted",
        "stt_missing_final", "stt_forced_flush",
        "stt_turns", "llm_turns", "tts_turns", "tool_turns",
        "stt_split_turns", "llm_split_turns", "tts_split_turns", "tool_split_turns")}
    impacted: dict[str, set[str]] = {stage: set() for stage in metrics.STAGES}
    sessions: set[str] = set()

    for row in rows:
        # A continuation is counted for its measurements, but not as a second
        # exchange; the exchange itself is counted where it started.
        if not row["is_continuation"]:
            counters["turns"] += 1
        if row["has_continuation"]:
            counters["split_turns"] += 1
        sessions.add(row["session_id"])
        for metric in SKETCH_METRICS:
            if row[metric] is not None:
                sketches[metric].add(float(row[metric]))
        if row["response_latency_ms"] is not None:
            counters["measured_response_turns"] += 1
            if row["response_latency_ms"] >= AUDIBLE_LAG_MS:
                counters["audible_lag_turns"] += 1
        for stage in metrics.STAGES:
            counters[f"{stage}_ops"] += row[f"{stage}_ops"] or 0
            failed = row[f"{stage}_failed"] or 0
            counters[f"{stage}_failed"] += failed
            if failed:
                impacted[stage].add(row["session_id"])
        counters["tts_interrupted"] += row["tts_interrupted"] or 0
        counters["stt_missing_final"] += row["stt_missing_final"] or 0
        counters["stt_forced_flush"] += row["stt_forced_flush"] or 0
        for stage in metrics.STAGES:
            if (row[f"{stage}_ops"] or 0) > 0:
                counters[f"{stage}_turns"] += 1
            counters[f"{stage}_split_turns"] += row[f"{stage}_split"] or 0

    # Call-level counts are attributed to the bucket the call *started* in, so a
    # call is counted exactly once no matter how many hours it spans. Turn-level
    # counts stay in the bucket the turn happened in, which is what makes the
    # trend chart show when latency actually degraded.
    call_row = db.execute(
        "SELECT COUNT(*) AS calls, "
        "SUM(CASE WHEN failed_op_count > 0 THEN 1 ELSE 0 END) AS failing, "
        "SUM(CASE WHEN capture_incomplete = 1 THEN 1 ELSE 0 END) AS capture_incomplete, "
        "SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed, "
        "SUM(CASE WHEN status != 'ready' THEN 1 ELSE 0 END) AS incomplete, "
        "SUM(COALESCE(duration_ms, 0)) AS duration "
        "FROM call_metrics WHERE started_at_epoch_ms >= ? AND started_at_epoch_ms < ?"
        + ("" if everyone else " AND COALESCE(agent_id, '') = ?"),
        [bucket_ms, end_ms] + scope_params,
    ).fetchone()

    db.execute(
        "INSERT INTO interval_rollups (bucket_ms, agent_id, calls, turns, split_turns, measured_response_turns, "
        "audible_lag_turns, failing_calls, capture_incomplete_calls, completed_calls, incomplete_calls, "
        "total_duration_ms, stt_ops, llm_ops, tts_ops, tool_ops, stt_failed, llm_failed, tts_failed, "
        "tool_failed, stt_calls_impacted, llm_calls_impacted, tts_calls_impacted, tool_calls_impacted, "
        "tts_interrupted, stt_missing_final, stt_forced_flush, stt_turns, llm_turns, tts_turns, "
        "tool_turns, stt_split_turns, llm_split_turns, tts_split_turns, tool_split_turns) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
        "?, ?, ?, ?, ?)",
        (bucket_ms, agent_id, call_row["calls"] or 0, counters["turns"], counters["split_turns"],
         counters["measured_response_turns"], counters["audible_lag_turns"],
         call_row["failing"] or 0, call_row["capture_incomplete"] or 0,
         call_row["completed"] or 0, call_row["incomplete"] or 0, call_row["duration"] or 0,
         counters["stt_ops"], counters["llm_ops"], counters["tts_ops"], counters["tool_ops"],
         counters["stt_failed"], counters["llm_failed"], counters["tts_failed"], counters["tool_failed"],
         len(impacted["stt"]), len(impacted["llm"]), len(impacted["tts"]), len(impacted["tool"]),
         counters["tts_interrupted"], counters["stt_missing_final"], counters["stt_forced_flush"],
         counters["stt_turns"], counters["llm_turns"], counters["tts_turns"],
         counters["tool_turns"],
         counters["stt_split_turns"], counters["llm_split_turns"],
         counters["tts_split_turns"], counters["tool_split_turns"]),
    )
    db.executemany(
        "INSERT INTO metric_rollups (bucket_ms, agent_id, metric, sketch) VALUES (?, ?, ?, ?)",
        [(bucket_ms, agent_id, metric, sketches[metric].encode())
         for metric in SKETCH_METRICS if sketches[metric].count],
    )

    tools: dict[str, dict[str, Any]] = {}
    for row in db.execute(
        f"SELECT tool_name, duration_ms, failed, timed_out, session_id FROM tool_metrics "
        f"WHERE started_at_epoch_ms >= ? AND started_at_epoch_ms < ? AND session_id IN ({scope})",
        [bucket_ms, end_ms] + scope_params,
    ):
        item = tools.setdefault(row["tool_name"], {
            "sketch": sketch_module.Sketch(), "invocations": 0, "failed": 0,
            "timed_out": 0, "calls": set(), "failed_calls": set()})
        item["invocations"] += 1
        item["failed"] += row["failed"] or 0
        item["timed_out"] += row["timed_out"] or 0
        item["calls"].add(row["session_id"])
        if row["failed"]:
            item["failed_calls"].add(row["session_id"])
        if row["duration_ms"] is not None:
            item["sketch"].add(float(row["duration_ms"]))
    if tools:
        db.executemany(
            "INSERT INTO tool_rollups (bucket_ms, agent_id, tool_name, invocations, failed, timed_out, "
            "calls, failed_calls, sketch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(bucket_ms, agent_id, name, item["invocations"], item["failed"], item["timed_out"],
              len(item["calls"]), len(item["failed_calls"]), item["sketch"].encode())
             for name, item in tools.items()],
        )

    db.execute(
        "INSERT INTO failure_rollups (bucket_ms, agent_id, stage, fingerprint, count, calls) "
        "SELECT ?, ?, stage, fingerprint, COUNT(*), COUNT(DISTINCT session_id) FROM failure_metrics "
        f"WHERE started_at_epoch_ms >= ? AND started_at_epoch_ms < ? AND session_id IN ({scope}) "
        "GROUP BY stage, fingerprint",
        [bucket_ms, agent_id, bucket_ms, end_ms] + scope_params,
    )


# --------------------------------------------------------------------------
# Query
# --------------------------------------------------------------------------
#
# Two paths answer the same questions:
#
#   exact  - reads the raw turn rows and sorts them. Every number is the value
#            of a turn that happened, reproducible from `operations`.
#   rollup - merges hourly DDSketches. Percentiles carry a 1% relative error
#            bound; counts stay exact because they are summable.
#
# The exact path was measured at ~4 s for 1.1M turns, which is not a dashboard,
# so the range decides: at or below EXACT_TURN_LIMIT turns the answer is exact,
# above it the sketch tier answers in milliseconds and the response says so.
# Provider, model, environment and version filters are not rollup dimensions -
# adding them would multiply the bucket count by every combination - so a
# filtered view always takes the exact path and is refused with a clear reason
# if the range is too large to answer honestly.


class Filters:
    """Dashboard filter set, translated once into SQL for every panel."""

    def __init__(self, *, start_ms: int, end_ms: int, agent_id: str | None = None,
                 environment: str | None = None, agent_version: str | None = None,
                 provider: str | None = None, model: str | None = None,
                 sdk_language: str | None = None) -> None:
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.agent_id = agent_id
        self.environment = environment
        self.agent_version = agent_version
        self.provider = provider
        self.model = model
        self.sdk_language = sdk_language

    @property
    def rollup_eligible(self) -> bool:
        """Whether hourly rollups can answer this filter set.

        Rollups are keyed by agent only. Keeping provider, model, environment
        and version out of the key is a deliberate cardinality decision: with
        6 providers, 8 models, 3 environments and 20 versions live at once,
        materialising every combination is ~2,880 rows per hour per agent, and
        almost all of them empty.
        """
        return not (self.provider or self.model or self.environment
                    or self.agent_version or self.sdk_language)

    def call_conditions(self) -> tuple[list[str], list[Any]]:
        """Dimension predicates on `call_metrics c`, without any time bound."""
        clauses: list[str] = []
        params: list[Any] = []
        for column, value in (("c.agent_id", self.agent_id), ("c.environment", self.environment),
                              ("c.agent_version", self.agent_version), ("c.sdk_language", self.sdk_language)):
            if value:
                clauses.append(f"{column} = ?")
                params.append(value)
        # Provider and model are recorded per operation, not per call, so a call
        # matches when any of its turns used them. A call that switched provider
        # mid-run therefore appears under both, which is stated rather than
        # silently resolved to whichever one happened to be first.
        if self.provider:
            clauses.append(
                "EXISTS (SELECT 1 FROM turn_metrics t WHERE t.session_id = c.session_id "
                "AND ? IN (t.stt_provider, t.llm_provider, t.tts_provider))")
            params.append(self.provider)
        if self.model:
            clauses.append(
                "EXISTS (SELECT 1 FROM turn_metrics t WHERE t.session_id = c.session_id "
                "AND ? IN (t.stt_model, t.llm_model, t.tts_model))")
            params.append(self.model)
        return clauses, params

    def call_where(self, *, start_ms: int | None = None, end_ms: int | None = None) -> tuple[str, list[Any]]:
        """Predicate selecting *calls that started* inside the window.

        Call-level counts are attributed to the call's start. Turn-level metrics
        are attributed to the turn's own timestamp (see `turn_where`); a
        long-running call therefore contributes its late turns to the hour they
        actually happened in, which is what makes the trend chart point at the
        moment latency degraded rather than at the moment the call began.
        """
        clauses = ["c.started_at_epoch_ms IS NOT NULL",
                   "c.started_at_epoch_ms >= ?", "c.started_at_epoch_ms < ?"]
        params: list[Any] = [start_ms if start_ms is not None else self.start_ms,
                             end_ms if end_ms is not None else self.end_ms]
        extra_clauses, extra_params = self.call_conditions()
        return " AND ".join(clauses + extra_clauses), params + extra_params

    def turn_where(self, *, start_ms: int | None = None, end_ms: int | None = None,
                   alias: str = "t") -> tuple[str, list[Any]]:
        """Predicate selecting *turns* inside the window, with call dimensions."""
        clauses = [f"{alias}.started_at_epoch_ms >= ?", f"{alias}.started_at_epoch_ms < ?"]
        params: list[Any] = [start_ms if start_ms is not None else self.start_ms,
                             end_ms if end_ms is not None else self.end_ms]
        extra_clauses, extra_params = self.call_conditions()
        if extra_clauses:
            clauses.append(
                f"{alias}.session_id IN (SELECT c.session_id FROM call_metrics c WHERE "
                + " AND ".join(extra_clauses) + ")")
            params += extra_params
        return " AND ".join(clauses), params

    def as_dict(self) -> dict[str, Any]:
        return {
            "from_ms": self.start_ms, "to_ms": self.end_ms, "agent_id": self.agent_id,
            "environment": self.environment, "agent_version": self.agent_version,
            "provider": self.provider, "model": self.model, "sdk_language": self.sdk_language,
        }


def bucket_size_ms(span_ms: int) -> int:
    for size in BUCKET_LADDER_MS:
        if span_ms / size <= TARGET_BUCKETS:
            return size
    return BUCKET_LADDER_MS[-1]


# Columns pulled for the exact path. Only what a panel reads: fetching all 32
# turn columns instead of these 22 was measured at ~1.7x the cost, and SQLite
# materialises every one of them per row.
_EXACT_COLUMNS = (
    "session_id", "started_at_epoch_ms",
    "response_latency_ms", "stt_first_partial_ms", "stt_endpoint_delay_ms", "stt_final_ms",
    "llm_ttft_ms", "llm_completion_ms", "tts_first_audio_ms", "tts_synthesis_ms", "tool_total_ms",
    "stt_ops", "llm_ops", "tts_ops", "tool_ops",
    "stt_failed", "llm_failed", "tts_failed", "tool_failed",
    "tts_interrupted", "stt_missing_final", "stt_forced_flush", "is_continuation",
    "has_continuation", "stt_split", "llm_split", "tts_split", "tool_split",
)
_INDEX = {name: position for position, name in enumerate(_EXACT_COLUMNS)}


def _fetch_turns(db: sqlite3.Connection, filters: Filters,
                 start_ms: int | None = None, end_ms: int | None = None) -> list[tuple]:
    where, params = filters.turn_where(start_ms=start_ms, end_ms=end_ms)
    cursor = db.execute(
        f"SELECT {', '.join(_EXACT_COLUMNS)} FROM turn_metrics t WHERE {where}", params)
    # Plain tuples, not sqlite3.Row: row objects cost roughly a third of the
    # query time at a million rows and every access here is positional anyway.
    cursor.row_factory = None
    return cursor.fetchall()


def _count_turns(db: sqlite3.Connection, filters: Filters) -> int:
    where, params = filters.turn_where()
    # Continuations are excluded here and everywhere else a turn is counted, so
    # the exact count, the rollups and the session list cannot disagree about
    # how many exchanges a call had.
    return db.execute(
        f"SELECT COUNT(*) FROM turn_metrics t WHERE {where} AND t.is_continuation = 0",
        params,
    ).fetchone()[0]


def _values(rows: Sequence[tuple], name: str) -> list[Any]:
    position = _INDEX[name]
    return [row[position] for row in rows]


# The stage cards. One declarative table so the API, the UI and the tests all
# describe a metric the same way, and adding a stage metric cannot ship without
# a definition a reviewer can read.
STAGE_METRICS: dict[str, dict[str, Any]] = {
    "stt": {
        "label": "Speech to text",
        "metrics": [
            {"key": "stt_first_partial_ms", "label": "First partial",
             "definition": "Caller's first word to the first usable partial transcript. Reported only where "
                           "word timestamps were captured; without them the recogniser's listening window "
                           "starts seconds before the caller speaks and the metric would be fiction."},
            {"key": "stt_endpoint_delay_ms", "label": "Endpoint delay",
             "definition": "The recogniser's own declared end of speech to its finalisation signal. Counted "
                           "only where both marks were observed independently."},
            {"key": "stt_final_ms", "label": "Final transcript",
             "definition": "Caller's last word to the final transcript."},
        ],
    },
    "llm": {
        "label": "Language model",
        # Completion first, deliberately. Only SDK builds that stream record
        # `first_token`, so time-to-first-token is measured on a subset and can
        # read *higher* than completion measured over everything - which, listed
        # first, looks like an impossible claim rather than two populations.
        "metrics": [
            {"key": "llm_completion_ms", "label": "Completion",
             "definition": "Request start to response completion. Not a substitute for first token: the same "
                           "2 s completion can be 200 ms of wait or 1.9 s of silence."},
            {"key": "llm_ttft_ms", "label": "Time to first token",
             "definition": "Request start to the first streamed output token. Only streaming SDK builds record "
                           "this, so it often covers a different, smaller set of turns than Completion above."},
        ],
    },
    "tool": {
        "label": "Tools",
        "metrics": [
            {"key": "tool_total_ms", "label": "Tool time per turn",
             "definition": "Total time a turn spent inside tool calls. Per-tool detail is in the table below."},
        ],
    },
    "tts": {
        "label": "Text to speech",
        "metrics": [
            {"key": "tts_first_audio_ms", "label": "First audio",
             "definition": "Request start to the first playable audio chunk."},
            {"key": "tts_synthesis_ms", "label": "Synthesis",
             "definition": "Request start to synthesis completion. Excludes playback duration."},
        ],
    },
}
STAGE_EXTRA = {
    "stt": [
        {"key": "stt_missing_final", "label": "Missing final transcript", "over": "stt_turns",
         "definition": "Turns where the recogniser never returned a final transcript."},
        {"key": "stt_forced_flush", "label": "Forced flush", "over": "stt_turns",
         "definition": "Turns finalised by a timeout or manual flush rather than by endpointing."},
    ],
    "tts": [
        {"key": "tts_interrupted", "label": "Interrupted by barge-in", "over": "tts_ops",
         "definition": "Synthesis deliberately stopped because the caller spoke. Correct behaviour, "
                       "reported separately and never counted as a failure."},
    ],
}


def _delta(current: dict[str, Any], previous: dict[str, Any] | None, key: str = "p50") -> dict[str, Any]:
    """Period-over-period movement, or an explicit refusal to claim one.

    A 40% jump computed from nine turns against six is noise with a percentage
    sign on it. Both sides must clear MIN_SAMPLE_DELTA before this is a claim.
    """
    if not previous or not current.get("available") or not previous.get("available"):
        return {"available": False, "reason": "no_previous_period"}
    if current["count"] < MIN_SAMPLE_DELTA or previous["count"] < MIN_SAMPLE_DELTA:
        return {"available": False, "reason": "below_minimum_sample", "minimum": MIN_SAMPLE_DELTA,
                "count": current["count"], "previous_count": previous["count"]}
    before, after = previous.get(key), current.get(key)
    if before in (None, 0) or after is None:
        return {"available": False, "reason": "no_previous_period"}
    return {"available": True, "reason": None, "previous": before, "current": after,
            "absolute": after - before, "relative": (after - before) / before}


def _unanswerable(reason: str) -> dict[str, Any]:
    """A rate that was never computed, said so.

    `rate(0, 0)` reports `stage_absent` - "no operations of this stage in
    range" - which on a refused range is a claim the server never checked. A
    fabricated zero next to a refusal banner is worse than a dash.
    """
    return {"available": False, "reason": reason, "rate": None, "count": None, "eligible": None}


def _stage_panels(distributions: dict[str, dict[str, Any]],
                  previous: dict[str, dict[str, Any]],
                  counters: dict[str, int],
                  impacted: dict[str, dict[str, Any]],
                  eligible_turns: int,
                  unanswerable_reason: str | None = None) -> dict[str, Any]:
    """Assemble the four stage cards from already-computed distributions.

    Kept free of any database access so the exact path and the rollup path
    produce byte-identical panel structures from their different sources.
    """
    panels = {}
    for stage, spec in STAGE_METRICS.items():
        eligible_ops = counters.get(f"{stage}_ops", 0)
        # Coverage is stated against the turns that ran THIS stage, not against
        # every turn in range. A tool metric measured on 40 of the 45 turns that
        # actually called a tool is 89% covered; reporting it as 40 of 283 turns
        # reads as 14% and invites a developer to distrust a metric that in fact
        # covers nearly all of its population.
        stage_turns = counters.get(f"{stage}_turns", 0)
        # A split exchange is one turn carrying two recognised utterances, but
        # only the stages that ran on both halves are affected: applying the
        # caveat to every stage told a reader that a language model panel
        # showing "1 of 1" was somehow counting utterances.
        #
        # Which stages those are was previously inferred by asking whether this
        # stage measured more populations than the range has turns. That is a
        # pigeonhole test, so it proves double counting but cannot detect it:
        # one split speech-to-text exchange plus one unrelated reply-only turn
        # leaves the totals level, and a stage measured twice for one exchange
        # was published as "2 turns, 100% covered". The count is now carried
        # from ingest, where both halves of the split were in hand.
        stage_split_turns = counters.get(f"{stage}_split_turns", 0)
        stage_is_split = stage_split_turns > 0
        panel_metrics = []
        for item in spec["metrics"]:
            dist = distributions.get(item["key"]) or distribution([], reason="stage_absent")
            if not dist["available"] and eligible_ops == 0:
                # On a refused range every counter is zero by construction, so
                # the "stage absent" inference would be a statement about data
                # nobody looked at.
                dist = {**dist, "reason": unanswerable_reason or "stage_absent"}
            panel_metrics.append({
                **item,
                "distribution": dist,
                "coverage": {"measured": dist["count"], "eligible": stage_turns,
                             "ratio": (dist["count"] / stage_turns) if stage_turns else None,
                             "turns_in_range": eligible_turns,
                             "split_turns": stage_split_turns if stage_is_split else 0,
                             "population": (
                                 f"turns that used {spec['label'].lower()}" if not stage_is_split
                                 else f"recognised utterances that used {spec['label'].lower()}; "
                                      f"{stage_split_turns:,} turn(s) in range carry more than one")},
                "change": _delta(dist, previous.get(item["key"])),
            })
        panel = {
            "stage": stage,
            "label": spec["label"],
            "metrics": panel_metrics,
            "eligible_operations": None if unanswerable_reason else eligible_ops,
            "failure_rate": (_unanswerable(unanswerable_reason) if unanswerable_reason
                             else rate(counters.get(f"{stage}_failed", 0), eligible_ops)),
            "calls_impacted": impacted.get(stage, rate(0, 0)),
        }
        extras = []
        for item in STAGE_EXTRA.get(stage, []):
            extras.append({"key": item["key"], "label": item["label"], "definition": item["definition"],
                           **(_unanswerable(unanswerable_reason) if unanswerable_reason
                              else rate(counters.get(item["key"], 0), counters.get(item["over"], 0)))})
        if extras:
            panel["extra"] = extras
        panels[stage] = panel
    return panels


def _facets(db: sqlite3.Connection) -> dict[str, Any]:
    """Which filters actually have values in the captured data.

    Read from the maintained `metric_facets` table, not from a `SELECT DISTINCT`
    over every turn ever recorded: the scan version was measured at 562 ms on a
    1.1M-turn table and would be paid on every dashboard load to populate six
    dropdowns.

    The plan asks for environment and agent-version filters. No SDK build writes
    them today, so they are returned as empty lists with a reason rather than as
    dead controls: a filter that silently matches nothing is worse than an
    absent one.
    """
    stored: dict[str, list[str]] = {}
    for row in db.execute("SELECT dimension, value FROM metric_facets ORDER BY dimension, value"):
        stored.setdefault(row["dimension"], []).append(row["value"])
    environments = [row["environment"] for row in db.execute(
        "SELECT DISTINCT environment FROM call_metrics WHERE environment IS NOT NULL")]
    versions = [row["agent_version"] for row in db.execute(
        "SELECT DISTINCT agent_version FROM call_metrics WHERE agent_version IS NOT NULL")]
    return {
        "agent_id": {"values": stored.get("agent_id", []), "reason": None},
        "environment": {"values": environments,
                        "reason": None if environments else "not_captured_by_sdk"},
        "agent_version": {"values": versions,
                          "reason": None if versions else "not_captured_by_sdk"},
        "provider": {"values": stored.get("provider", []), "reason": None},
        "model": {"values": stored.get("model", []), "reason": None},
        "sdk_language": {"values": stored.get("sdk_language", []), "reason": None},
    }


# Severity classes for the attention queue, highest first. Ordering by class
# and only then by magnitude is what keeps the list actionable: a single score
# mixing "6 failures" with "3.2 s" needs weights nobody can defend, and the
# first version of this query sorted by the *count* of turns over the threshold,
# which put a call with two 3.2 s turns above a call with one 11 s turn.
def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


# A call too short to have held a conversation and with nothing else wrong is a
# probe, a hang-up or a smoke test - not a missing measurement worth opening.
# Below this duration, "no response latency could be measured" stops promoting a
# call into the queue, because a triage list whose top rows are one-second test
# calls sends the reader past the eleven-second real ones underneath.
MIN_ATTENTION_DURATION_MS = 5_000
UNMEASURED_SQL = ("c.turn_count > 0 AND c.measured_response_turns = 0 "
                  f"AND COALESCE(c.duration_ms, 0) >= {MIN_ATTENTION_DURATION_MS}")
ATTENTION_PREDICATE = ("c.failed_op_count > 0 OR c.audible_lag_turns > 0 OR c.missing_final_turns > 0 "
                       f"OR c.capture_incomplete = 1 OR ({UNMEASURED_SQL})")
# Versioned by predicate: see `_attention_index_sql`.
ATTENTION_INDEX = "call_metrics_attention_v2"
SEVERITY_BROKEN = 3   # the caller heard an error
SEVERITY_BLIND = 2    # we cannot tell what the caller heard
SEVERITY_SLOW = 1     # the caller waited


def _attention(db: sqlite3.Connection, filters: Filters) -> dict[str, Any]:
    """Calls worth opening, each with the evidence that put it on the list.

    Three ranks, in this order: calls that failed, calls whose evidence is
    incomplete, and calls that were merely slow. Within a rank the worst
    magnitude wins - failure count for the first two, slowest turn for the last.
    """
    where, params = filters.call_where()
    severity = (
        f"(CASE WHEN c.failed_op_count > 0 THEN {SEVERITY_BROKEN} "
        f"      WHEN c.capture_incomplete = 1 OR c.missing_final_turns > 0 "
        f"           OR ({UNMEASURED_SQL}) THEN {SEVERITY_BLIND} "
        f"      ELSE {SEVERITY_SLOW} END)"
    )
    predicate = f"{where} AND ({ATTENTION_PREDICATE})"
    total = db.execute(f"SELECT COUNT(*) FROM call_metrics c WHERE {predicate}", params).fetchone()[0]
    rows = db.execute(
        "SELECT c.*, "
        "(SELECT t.turn_id FROM turn_metrics t WHERE t.session_id = c.session_id "
        " AND t.response_latency_ms IS NOT NULL ORDER BY t.response_latency_ms DESC LIMIT 1) AS slowest_turn_id, "
        "(SELECT f.turn_id FROM failure_metrics f WHERE f.session_id = c.session_id "
        " AND f.turn_id IS NOT NULL ORDER BY f.seq LIMIT 1) AS first_failed_turn_id, "
        "(SELECT group_concat(DISTINCT f.fingerprint) FROM failure_metrics f "
        " WHERE f.session_id = c.session_id) AS fingerprints "
        f", {severity} AS severity FROM call_metrics c WHERE {predicate} "
        "ORDER BY severity DESC, c.failed_op_count DESC, "
        "COALESCE(c.max_response_latency_ms, 0) DESC, c.started_at_epoch_ms DESC LIMIT ?",
        params + [ATTENTION_LIMIT],
    ).fetchall()

    result = []
    for row in rows:
        reasons = []
        if row["failed_op_count"]:
            for stage in metrics.STAGES:
                count = row[f"{stage}_failed"]
                if count:
                    reasons.append({"kind": "failure", "stage": stage, "count": count,
                                    "label": f"{count} {stage.upper()} failure{'s' if count > 1 else ''}"})
        if row["audible_lag_turns"]:
            reasons.append({"kind": "slow", "stage": "overall", "count": row["audible_lag_turns"],
                            "label": _plural(row["audible_lag_turns"], "turn") + f" over {AUDIBLE_LAG_MS // 1000}s"})
        if row["missing_final_turns"]:
            reasons.append({"kind": "missing_final", "stage": "stt", "count": row["missing_final_turns"],
                            "label": _plural(row["missing_final_turns"], "turn") + " with no final transcript"})
        if row["turn_count"] and not row["measured_response_turns"]:
            reasons.append({"kind": "unmeasured", "stage": "overall", "count": row["turn_count"],
                            "label": "No response latency could be measured"})
        if row["capture_incomplete"]:
            reasons.append({"kind": "capture", "stage": "capture", "count": 1,
                            "label": "Capture incomplete - evidence may be missing"})
        result.append({
            "severity": row["severity"],
            "session_id": row["session_id"], "agent_id": row["agent_id"],
            "started_at": row["started_at"], "duration_ms": row["duration_ms"],
            "turn_count": row["turn_count"],
            "max_response_latency_ms": row["max_response_latency_ms"],
            "failed_op_count": row["failed_op_count"], "reasons": reasons,
            "focus_turn_id": row["first_failed_turn_id"] or row["slowest_turn_id"],
            "error_fingerprints": (row["fingerprints"] or "").split(",") if row["fingerprints"] else [],
        })
    return {"items": result, "total": total, "limit": ATTENTION_LIMIT}


def _calls_started_per_bucket(db: sqlite3.Connection, filters: Filters, bucket_ms: int) -> dict[int, int]:
    """Calls whose start time falls in each bucket, on the call-attributed clock."""
    where, params = filters.call_where()
    return {
        row["slot"]: row["calls"]
        for row in db.execute(
            f"SELECT (c.started_at_epoch_ms / ?) * ? AS slot, COUNT(*) AS calls FROM call_metrics c "
            f"WHERE {where} GROUP BY slot",
            [bucket_ms, bucket_ms] + params,
        )
    }


def _exact(db: sqlite3.Connection, filters: Filters, bucket_ms: int,
           compare: bool) -> dict[str, Any]:
    """One scan of the raw turn rows answers every latency panel and the chart.

    The trend series is derived from the same rows rather than re-queried: a
    second pass cost 1.6 s at a million turns and, worse, could disagree with
    the KPI above it if a call landed between the two queries.
    """
    rows = _fetch_turns(db, filters)
    span_ms = filters.end_ms - filters.start_ms
    previous_rows = _fetch_turns(db, filters, filters.start_ms - span_ms, filters.start_ms) if compare else []

    distributions = {metric: distribution(_values(rows, metric)) for metric in SKETCH_METRICS}
    previous = {metric: distribution(_values(previous_rows, metric)) for metric in SKETCH_METRICS} if compare else {}

    counters = {name: 0 for name in (
        "stt_ops", "llm_ops", "tts_ops", "tool_ops", "stt_failed", "llm_failed", "tts_failed",
        "tool_failed", "tts_interrupted", "stt_missing_final", "stt_forced_flush",
        "stt_turns", "llm_turns", "tts_turns", "tool_turns", "split_turns",
        "stt_split_turns", "llm_split_turns", "tts_split_turns", "tool_split_turns")}
    impacted_sessions: dict[str, set[str]] = {stage: set() for stage in metrics.STAGES}
    buckets: dict[int, dict[str, Any]] = {}
    lagging = 0

    session_index, time_index, response_index = _INDEX["session_id"], _INDEX["started_at_epoch_ms"], _INDEX["response_latency_ms"]
    # The `*_turns` counters count turns, not operations, so they are not summed
    # from a column; they are derived below.
    turn_counters = ({f"{stage}_turns" for stage in metrics.STAGES} | {"split_turns"}
                     | {f"{stage}_split_turns" for stage in metrics.STAGES})
    stage_index = {name: _INDEX[name] for name in counters if name not in turn_counters}
    ops_index = {stage: _INDEX[f"{stage}_ops"] for stage in metrics.STAGES}
    for row in rows:
        for name, position in stage_index.items():
            counters[name] += row[position] or 0
        for stage, position in ops_index.items():
            if (row[position] or 0) > 0:
                counters[f"{stage}_turns"] += 1
            counters[f"{stage}_split_turns"] += row[_INDEX[f"{stage}_split"]] or 0
        # A split exchange is one turn carrying two recognised utterances, so
        # the stage denominators above legitimately exceed the turn count. The
        # difference is published rather than left to read as "2 of 1 turns".
        if row[_INDEX["has_continuation"]]:
            counters["split_turns"] += 1
        for stage in metrics.STAGES:
            if row[_INDEX[f"{stage}_failed"]]:
                impacted_sessions[stage].add(row[session_index])
        at = row[time_index]
        if at is None:
            continue
        key = (at // bucket_ms) * bucket_ms
        bucket = buckets.setdefault(key, {"values": [], "turns": 0, "failures": 0, "lag": 0})
        # The chart's turn count is a count of *exchanges*, the same thing the
        # KPI above it counts, so a continuation must not add to it -- the two
        # sit on one screen and disagreeing by one is the console contradicting
        # itself. Its latency, failures and lag are still real measurements on
        # real audio and stay in the bucket; only the denominator is logical.
        if not row[_INDEX["is_continuation"]]:
            bucket["turns"] += 1
        bucket["failures"] += sum(row[_INDEX[f"{stage}_failed"]] or 0 for stage in metrics.STAGES)
        response = row[response_index]
        if response is not None:
            bucket["values"].append(float(response))
            if response >= AUDIBLE_LAG_MS:
                bucket["lag"] += 1
                lagging += 1

    # A bucket's call count is calls that STARTED in it - the same definition
    # the rollup path stores and the same one the drill-down filters on. Counting
    # calls merely *active* in the bucket instead would make the chart tooltip
    # and the list it opens disagree for every call that spans an hour boundary.
    started = _calls_started_per_bucket(db, filters, bucket_ms)

    series = []
    start = (filters.start_ms // bucket_ms) * bucket_ms
    while start < filters.end_ms:
        bucket = buckets.get(start)
        if bucket:
            dist = distribution(bucket["values"])
            series.append({"from_ms": start, "to_ms": start + bucket_ms,
                           "calls": started.get(start, 0),
                           "turns": bucket["turns"], "failures": bucket["failures"],
                           "measured": dist["count"], "p50": dist["p50"], "p95": dist["p95"],
                           "audible_lag_turns": bucket["lag"]})
        else:
            series.append({"from_ms": start, "to_ms": start + bucket_ms,
                           "calls": started.get(start, 0), "turns": 0,
                           "failures": 0, "measured": 0, "p50": None, "p95": None, "audible_lag_turns": 0})
        start += bucket_ms

    return {
        "exact": True,
        "turns": sum(1 for row in rows if not row[_INDEX["is_continuation"]]), "distributions": distributions, "previous": previous,
        "counters": counters, "impacted_sessions": impacted_sessions,
        "timeseries": series, "audible_lag_turns": lagging,
        "measured_response_turns": distributions["response_latency_ms"]["count"],
    }


def _refused(bucket_ms: int, filters: Filters, turn_count: int) -> dict[str, Any]:
    """The shape `_exact` returns, with every panel marked unanswerable.

    The refusal used to be advisory only: the banner said "narrow the range"
    while the server went ahead and materialised and sorted every turn in it
    anyway - measured at 9,969 ms for a filtered 30-day range over 1.1M turns,
    which is precisely the cost `EXACT_TURN_LIMIT` exists to prevent. Refusing
    means refusing.
    """
    empty = distribution([], reason="range_too_large_for_filter")
    # No timeseries at all, rather than a run of zero buckets. The filter is a
    # turn-level one, so even the cheap call-level volume cannot be attributed
    # to it without the scan this path exists to refuse - and a flat line of
    # zeros beside a KPI row reading 64 calls is a worse answer than none.
    return {
        "exact": True, "turns": turn_count, "refused": True,
        "distributions": {metric: dict(empty) for metric in SKETCH_METRICS},
        "previous": {},
        "counters": {name: 0 for name in (
            "stt_ops", "llm_ops", "tts_ops", "tool_ops", "stt_failed", "llm_failed", "tts_failed",
            "tool_failed", "tts_interrupted", "stt_missing_final", "stt_forced_flush",
            "stt_turns", "llm_turns", "tts_turns", "tool_turns",
            "stt_split_turns", "llm_split_turns", "tts_split_turns", "tool_split_turns")},
        "impacted_sessions": {stage: set() for stage in metrics.STAGES},
        "timeseries": [], "audible_lag_turns": None, "measured_response_turns": None,
    }


def _rollup(db: sqlite3.Connection, filters: Filters, bucket_ms: int, compare: bool) -> dict[str, Any]:
    """Hourly sketches and counters, merged. Percentiles carry a 1% error bound."""
    bucket_ms = max(bucket_ms, ROLLUP_BUCKET_MS)
    # Exactly one rollup scope is read, never a sum over agents: summing
    # per-agent rows would re-merge every sketch on every request, which is the
    # cost the all-agents row exists to remove.
    agent_clause, agent_params = "AND agent_id = ?", [filters.agent_id or ALL_AGENTS]

    counter_columns = ("turns", "split_turns", "measured_response_turns", "audible_lag_turns", "stt_ops", "llm_ops",
                       "tts_ops", "tool_ops", "stt_failed", "llm_failed", "tts_failed", "tool_failed",
                       "tts_interrupted", "stt_missing_final", "stt_forced_flush",
                       # Every stage's turn count, not just STT: these are the
                       # denominators `_stage_panels` states coverage against,
                       # and omitting one made that stage's coverage silently
                       # disappear on exactly the wide ranges this path serves.
                       "stt_turns", "llm_turns", "tts_turns", "tool_turns",
                       # Which stages a split actually doubled. Derived where
                       # both halves were in hand; a range total cannot recover
                       # it, which is how a real double count once hid.
                       "stt_split_turns", "llm_split_turns", "tts_split_turns", "tool_split_turns",
                       "stt_calls_impacted", "llm_calls_impacted", "tts_calls_impacted", "tool_calls_impacted")
    totals = db.execute(
        f"SELECT {', '.join(f'COALESCE(SUM({column}), 0) AS {column}' for column in counter_columns)} "
        f"FROM interval_rollups WHERE bucket_ms >= ? AND bucket_ms < ? {agent_clause}",
        [filters.start_ms, filters.end_ms] + agent_params,
    ).fetchone()
    counters = {column: totals[column] for column in counter_columns}

    def merged(start_ms: int, end_ms: int) -> dict[str, dict[str, Any]]:
        sketches: dict[str, sketch_module.Sketch] = {}
        for row in db.execute(
            f"SELECT metric, sketch FROM metric_rollups WHERE bucket_ms >= ? AND bucket_ms < ? {agent_clause}",
            [start_ms, end_ms] + agent_params,
        ):
            sketches.setdefault(row["metric"], sketch_module.Sketch()).merge(sketch_module.Sketch.decode(row["sketch"]))
        return {metric: (sketches[metric].summary() if metric in sketches
                         else {**distribution([]), "exact": False, "method": "ddsketch",
                               "relative_error": sketch_module.RELATIVE_ERROR})
                for metric in SKETCH_METRICS}

    span_ms = filters.end_ms - filters.start_ms
    distributions = merged(filters.start_ms, filters.end_ms)
    previous = merged(filters.start_ms - span_ms, filters.start_ms) if compare else {}

    series = []
    rows = db.execute(
        "SELECT (bucket_ms / ?) * ? AS slot, SUM(calls) AS calls, SUM(turns) AS turns, "
        "SUM(stt_failed + llm_failed + tts_failed + tool_failed) AS failures, "
        "SUM(measured_response_turns) AS measured, SUM(audible_lag_turns) AS lag "
        f"FROM interval_rollups WHERE bucket_ms >= ? AND bucket_ms < ? {agent_clause} GROUP BY slot",
        [bucket_ms, bucket_ms, filters.start_ms, filters.end_ms] + agent_params,
    ).fetchall()
    counts = {row["slot"]: row for row in rows}
    sketch_rows: dict[int, sketch_module.Sketch] = {}
    for row in db.execute(
        "SELECT (bucket_ms / ?) * ? AS slot, sketch FROM metric_rollups "
        f"WHERE metric = 'response_latency_ms' AND bucket_ms >= ? AND bucket_ms < ? {agent_clause}",
        [bucket_ms, bucket_ms, filters.start_ms, filters.end_ms] + agent_params,
    ):
        sketch_rows.setdefault(row["slot"], sketch_module.Sketch()).merge(sketch_module.Sketch.decode(row["sketch"]))

    start = (filters.start_ms // bucket_ms) * bucket_ms
    while start < filters.end_ms:
        row = counts.get(start)
        sketch = sketch_rows.get(start)
        series.append({
            "from_ms": start, "to_ms": start + bucket_ms,
            "calls": row["calls"] if row else 0, "turns": row["turns"] if row else 0,
            "failures": row["failures"] if row else 0,
            "measured": sketch.count if sketch else 0,
            "p50": round(sketch.quantile(0.5)) if sketch and sketch.count else None,
            "p95": round(sketch.quantile(0.95)) if sketch and sketch.count else None,
            "audible_lag_turns": row["lag"] if row else 0,
        })
        start += bucket_ms

    return {
        "exact": False, "turns": counters["turns"], "distributions": distributions, "previous": previous,
        "counters": counters,
        "impacted_counts": {stage: counters[f"{stage}_calls_impacted"] for stage in metrics.STAGES},
        "timeseries": series, "audible_lag_turns": counters["audible_lag_turns"],
        "measured_response_turns": counters["measured_response_turns"],
    }


def _tools_exact(db: sqlite3.Connection, filters: Filters) -> list[dict[str, Any]]:
    where, params = filters.turn_where(alias="tm")
    rows = db.execute(
        f"SELECT tool_name, duration_ms, failed, timed_out, session_id FROM tool_metrics tm WHERE {where}",
        params).fetchall()
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = grouped.setdefault(row["tool_name"], {
            "name": row["tool_name"], "values": [], "invocations": 0, "failed": 0,
            "timed_out": 0, "calls": set(), "failed_calls": set()})
        item["invocations"] += 1
        item["failed"] += row["failed"] or 0
        item["timed_out"] += row["timed_out"] or 0
        item["calls"].add(row["session_id"])
        if row["failed"]:
            item["failed_calls"].add(row["session_id"])
        if row["duration_ms"] is not None:
            item["values"].append(float(row["duration_ms"]))
    return [
        {"name": item["name"], "invocations": item["invocations"],
         "calls": len(item["calls"]), "calls_affected": len(item["failed_calls"]),
         "timeout_count": item["timed_out"],
         "failure_rate": rate(item["failed"], item["invocations"]),
         **_tool_distribution(distribution(item["values"]))}
        for item in grouped.values()
    ]


def _tools_rollup(db: sqlite3.Connection, filters: Filters) -> list[dict[str, Any]]:
    agent_clause, agent_params = "AND agent_id = ?", [filters.agent_id or ALL_AGENTS]
    grouped: dict[str, dict[str, Any]] = {}
    for row in db.execute(
        "SELECT tool_name, invocations, failed, timed_out, calls, failed_calls, sketch FROM tool_rollups "
        f"WHERE bucket_ms >= ? AND bucket_ms < ? {agent_clause}",
        [filters.start_ms, filters.end_ms] + agent_params,
    ):
        item = grouped.setdefault(row["tool_name"], {
            "name": row["tool_name"], "sketch": sketch_module.Sketch(), "invocations": 0,
            "failed": 0, "timed_out": 0, "calls": 0, "failed_calls": 0})
        item["invocations"] += row["invocations"]
        item["failed"] += row["failed"]
        item["timed_out"] += row["timed_out"]
        # Distinct-call counts cannot be summed across buckets without
        # double-counting a call that spanned two hours. Reported as an upper
        # bound rather than as a precise figure, and labelled as such.
        item["calls"] += row["calls"]
        item["failed_calls"] += row["failed_calls"]
        item["sketch"].merge(sketch_module.Sketch.decode(row["sketch"]))
    return [
        {"name": item["name"], "invocations": item["invocations"],
         "calls": item["calls"], "calls_affected": item["failed_calls"],
         "calls_are_upper_bound": True,
         "timeout_count": item["timed_out"],
         "failure_rate": rate(item["failed"], item["invocations"]),
         **_tool_distribution(item["sketch"].summary())}
        for item in grouped.values()
    ]


def _tool_distribution(dist: dict[str, Any]) -> dict[str, Any]:
    return {"p50": dist["p50"], "p95": dist["p95"], "measured": dist["count"],
            "p95_confident": dist["p95_confident"], "exact": dist.get("exact", True)}


def _failures_exact(db: sqlite3.Connection, filters: Filters) -> list[dict[str, Any]]:
    where, params = filters.turn_where(alias="f")
    return [dict(row) for row in db.execute(
        "SELECT fingerprint, stage, COUNT(*) AS count, COUNT(DISTINCT session_id) AS calls "
        f"FROM failure_metrics f WHERE {where} GROUP BY fingerprint, stage ORDER BY count DESC LIMIT 12",
        params)]


def _failures_rollup(db: sqlite3.Connection, filters: Filters) -> list[dict[str, Any]]:
    agent_clause, agent_params = "AND agent_id = ?", [filters.agent_id or ALL_AGENTS]
    return [dict(row) for row in db.execute(
        "SELECT fingerprint, stage, SUM(count) AS count, SUM(calls) AS calls FROM failure_rollups "
        f"WHERE bucket_ms >= ? AND bucket_ms < ? {agent_clause} "
        "GROUP BY fingerprint, stage ORDER BY count DESC LIMIT 12",
        [filters.start_ms, filters.end_ms] + agent_params)]


def summary(db: sqlite3.Connection, filters: Filters, *, compare: bool = True,
            pending_calls: int = 0, unbuilt_calls: int = 0,
            incompatible_calls: int = 0) -> dict[str, Any]:
    """Everything the aggregate dashboard renders, computed server side.

    Deliberately one request: six panels fetching their own slice would each
    pick a slightly different moment for "now", and the KPI row would stop
    matching the chart under it during an incident - exactly when a developer is
    reading both.
    """
    span_ms = max(1, filters.end_ms - filters.start_ms)
    bucket_ms = bucket_size_ms(span_ms)

    turn_count = _count_turns(db, filters)
    use_rollup = turn_count > EXACT_TURN_LIMIT and filters.rollup_eligible
    refused = None
    if turn_count > EXACT_TURN_LIMIT and not filters.rollup_eligible:
        # Answering this exactly would take seconds; answering it from rollups
        # would be answering a different question, because provider and model
        # are not rollup dimensions. Saying so beats either.
        refused = {
            "reason": "range_too_large_for_filter",
            "message": "Provider, model, environment and version filters are computed from raw turns. "
                       "Narrow the time range to use them at this volume.",
            "turns": turn_count, "limit": EXACT_TURN_LIMIT,
        }

    computed = (_refused(bucket_ms, filters, turn_count) if refused
                else _rollup(db, filters, bucket_ms, compare) if use_rollup
                else _exact(db, filters, bucket_ms, compare))

    where, params = filters.call_where()
    calls_row = db.execute(
        "SELECT COUNT(*) AS calls, "
        "SUM(CASE WHEN c.outcome = 'completed' THEN 1 ELSE 0 END) AS completed, "
        "SUM(CASE WHEN c.status != 'ready' THEN 1 ELSE 0 END) AS incomplete, "
        "SUM(CASE WHEN c.failed_op_count > 0 THEN 1 ELSE 0 END) AS failing_calls, "
        "SUM(CASE WHEN c.capture_incomplete = 1 THEN 1 ELSE 0 END) AS capture_incomplete, "
        # Turns, not calls: one flagged exchange in a hundred is a footnote,
        # and half of them is a different conversation about whether these
        # numbers can be quoted at all.
        #
        # Both the count and the turns it was counted over are restricted to
        # rows built by the current contract. A column added in a version bump
        # defaults to 0 on every row built before it, and the backfill is
        # deliberately bounded, so during an upgrade window the archive holds
        # rows that were never examined for this flag. Summing the flag over
        # all rows while dividing by all turns reported those unexamined rows
        # as *clean*: a call whose every reply was inferred published a 50%
        # share while the raw evidence said 100%. Counting both over the same
        # rows means the share answers a question the data can support, and the
        # pending count says how much of the range is still outside it.
        "SUM(CASE WHEN c.metrics_version = ? THEN c.inferred_reply_turns ELSE 0 END) "
        "AS inferred_reply_turns, "
        "SUM(CASE WHEN c.metrics_version = ? THEN c.turn_count ELSE 0 END) "
        "AS inferred_reply_scope_turns, "
        "SUM(c.turn_count) AS turns, SUM(c.duration_ms) AS total_duration_ms "
        f"FROM call_metrics c WHERE {where}",
        (METRICS_VERSION, METRICS_VERSION, *params)).fetchone()
    calls = calls_row["calls"] or 0

    if refused:
        # Nothing per-stage was computed. Reporting `0 / 64` here would
        # contradict `failure_impacted_calls`, which IS computed (it comes from
        # the cheap call-level row), and would do so on the one view whose whole
        # point is to say it did not answer.
        impacted = {stage: {**_unanswerable(refused["reason"]), "upper_bound": False}
                    for stage in metrics.STAGES}
    elif "impacted_sessions" in computed:
        # Exact path: a real distinct count of calls with a failing turn.
        impacted = {stage: {**rate(len(computed["impacted_sessions"][stage]), calls),
                            "upper_bound": False}
                    for stage in metrics.STAGES}
    else:
        # Rollup path: each hour bucket stored its OWN distinct call count, and
        # those cannot be summed - a call whose failures straddle two hours is
        # counted in both. Clamped to the call total so the rate can never read
        # above 100%, and flagged so the UI states it as an upper bound rather
        # than presenting a possibly inflated reliability number as precise.
        impacted = {}
        for stage in metrics.STAGES:
            summed = computed["impacted_counts"][stage]
            bounded = min(summed, calls) if calls else summed
            impacted[stage] = {**rate(bounded, calls), "upper_bound": True}

    response = computed["distributions"]["response_latency_ms"]
    previous_response = computed["previous"].get("response_latency_ms") if compare else None
    measured = computed["measured_response_turns"]

    # A refused range refuses all the way down: these are filtered scans over
    # the same turns the refusal exists to avoid touching.
    tools = ([] if refused
             else _tools_rollup(db, filters) if computed["exact"] is False
             else _tools_exact(db, filters))
    for item in tools:
        item["rankable"] = item["invocations"] >= MIN_TOOL_INVOCATIONS
    tools.sort(key=lambda item: (item["rankable"], item["p95"] or 0), reverse=True)

    if refused:
        failures = []
    elif computed["exact"]:
        failures = _failures_exact(db, filters)
    else:
        # Each hourly row stored its own COUNT(DISTINCT session_id); a call
        # whose failures straddle an hour is counted in both, so the sum is an
        # upper bound. Clamped to the range's call total and flagged, exactly as
        # the tool and stage-impacted counts already are - otherwise this panel
        # claims more affected calls than the drill-down it opens can show.
        failures = _failures_rollup(db, filters)
        for item in failures:
            item["calls"] = min(item["calls"], calls) if calls else item["calls"]
            item["calls_are_upper_bound"] = True

    freshness = db.execute(
        "SELECT MAX(started_at_epoch_ms) AS newest, MIN(started_at_epoch_ms) AS oldest FROM call_metrics"
    ).fetchone()

    return {
        "filters": filters.as_dict(),
        "facets": _facets(db),
        "range": {"from_ms": filters.start_ms, "to_ms": filters.end_ms, "bucket_ms": bucket_ms,
                  "previous_from_ms": filters.start_ms - span_ms, "previous_to_ms": filters.start_ms},
        # `_refused` reports `exact: True` as an internal sentinel, but nothing on
        # the refused branch reads it - and left in `accuracy` it claimed the
        # view had been computed exactly from raw turn rows, beside a refusal
        # saying no turn was read. A consumer of the raw payload would have seen
        # `exact: true` next to `refused: {...}`.
        "accuracy": {
            "exact": False if refused else computed["exact"],
            "method": None if refused else (
                "raw turn rows" if computed["exact"] else "merged hourly DDSketch"),
            "relative_error": None if refused or computed["exact"] else sketch_module.RELATIVE_ERROR,
            "exact_turn_limit": EXACT_TURN_LIMIT,
            "percentile_rule": None if refused else "nearest rank, ceil(p x n) over eligible operations",
            "refused": refused,
            "note": None if refused or computed["exact"] else (
                "Counts are exact. Percentiles are merged from hourly sketches and are within "
                f"{sketch_module.RELATIVE_ERROR:.0%} of the true value. Narrow the range below "
                f"{EXACT_TURN_LIMIT:,} turns for exact percentiles."),
        },
        "coverage": {
            "calls": calls,
            "turns": calls_row["turns"] or 0,
            "turns_in_range": computed["turns"],
            "measured_response_turns": measured,
            "capture_incomplete_calls": calls_row["capture_incomplete"] or 0,
            # The SDK marks a reply it could not prove belonged to the turn it
            # was filed under. Every latency, token and cost figure derived
            # from that turn inherits the doubt, and until this was counted the
            # caveat lived only on the raw span -- so a fleet view could move
            # because a reply was placed by reading rather than by evidence,
            # and say nothing.
            "inferred_reply_turns": calls_row["inferred_reply_turns"] or 0,
            # The turns that count was taken over. During an upgrade window
            # this is smaller than `turns`, because a bounded backfill leaves
            # rows the current contract has not examined -- and those rows
            # cannot be assumed clean just because the column defaults to 0.
            "inferred_reply_scope_turns": calls_row["inferred_reply_scope_turns"] or 0,
            "pending_metric_builds": pending_calls,
            # The half of `pending_metric_builds` that is genuinely absent from
            # every number, as opposed to present but built by an older
            # contract. Published separately so the badge can say which.
            "unbuilt_calls": unbuilt_calls,
            # Rows a newer contract wrote, which this process counts in the
            # totals but cannot interpret for contract-scoped figures. Neither
            # stale nor current, so nothing else would have mentioned them.
            "incompatible_calls": incompatible_calls,
            "newest_call_ms": freshness["newest"], "oldest_call_ms": freshness["oldest"],
            "minimum_sample_p95": metrics.MIN_SAMPLE_P95,
            "minimum_sample_change": MIN_SAMPLE_DELTA,
        },
        "overview": {
            "calls": {"total": calls, "completed": calls_row["completed"] or 0,
                      "incomplete": calls_row["incomplete"] or 0, "turns": calls_row["turns"] or 0,
                      "total_duration_ms": calls_row["total_duration_ms"] or 0},
            "response_latency": {**response, "change": _delta(response, previous_response),
                                 "change_p95": _delta(response, previous_response, key="p95")},
            # Eligibility is turns whose response latency could be measured at
            # all. Dividing by every turn would silently credit unmeasurable
            # turns as fast ones.
            "audible_lag": {**(_unanswerable(refused["reason"]) if refused
                               else rate(computed["audible_lag_turns"], measured)),
                            "threshold_ms": AUDIBLE_LAG_MS},
            "failure_impacted_calls": rate(calls_row["failing_calls"] or 0, calls),
        },
        "timeseries": computed["timeseries"],
        "stages": _stage_panels(computed["distributions"], computed["previous"] if compare else {},
                                computed["counters"], impacted, computed["turns"],
                                refused["reason"] if refused else None),
        "tools": {"items": tools, "minimum_invocations_to_rank": MIN_TOOL_INVOCATIONS},
        "failures": failures,
        "attention": _attention(db, filters),
        "definitions": {
            "unavailable_reasons": metrics.UNAVAILABLE_REASONS,
            "audible_lag_threshold_ms": AUDIBLE_LAG_MS,
            "notes": [
                "Stage latencies overlap because the pipeline streams; they do not sum to response latency.",
                "Cancelled synthesis from barge-in is reported separately and never counted as a failure.",
                "A metric with no captured milestone is unavailable, never zero.",
                "Call counts use the call's start time; turn metrics use the turn's own time.",
            ],
        },
    }


# Which calls sit behind a number. Every KPI, chart bucket, stage failure and
# tool row on the dashboard maps to one of these, so a developer can always get
# from "P95 is 4.2 s" to the specific call that was slow without leaving the page.
DRILLDOWNS = {
    "all": "Calls in range",
    "audible_lag": "Calls with a turn over the audible-lag threshold",
    "failures": "Calls with at least one genuine failure",
    "capture_incomplete": "Calls whose capture was incomplete",
    "unmeasured": "Calls where no response latency could be measured",
    "stt_failures": "Calls with an STT failure",
    "llm_failures": "Calls with an LLM failure",
    "tts_failures": "Calls with a TTS failure",
    "tool_failures": "Calls with a tool failure",
    "missing_final": "Calls with a turn that never got a final transcript",
    "slowest": "Calls ranked by their slowest turn",
}

_DRILLDOWN_SQL = {
    "all": "1 = 1",
    "audible_lag": "c.audible_lag_turns > 0",
    "failures": "c.failed_op_count > 0",
    "capture_incomplete": "c.capture_incomplete = 1",
    "unmeasured": UNMEASURED_SQL,
    "stt_failures": "c.stt_failed > 0",
    "llm_failures": "c.llm_failed > 0",
    "tts_failures": "c.tts_failed > 0",
    "tool_failures": "c.tool_failed > 0",
    "missing_final": "c.missing_final_turns > 0",
    "slowest": "c.max_response_latency_ms IS NOT NULL",
}


def calls(db: sqlite3.Connection, filters: Filters, selector: str = "all", *,
          tool_name: str | None = None, fingerprint: str | None = None,
          limit: int = 100, offset: int = 0) -> dict[str, Any]:
    """The calls behind one dashboard number, newest or worst first."""
    if selector not in _DRILLDOWN_SQL:
        selector = "all"
    where, params = filters.call_where()
    clauses = [where, _DRILLDOWN_SQL[selector]]
    if tool_name:
        clauses.append("EXISTS (SELECT 1 FROM tool_metrics tm WHERE tm.session_id = c.session_id AND tm.tool_name = ?)")
        params.append(tool_name)
    if fingerprint:
        clauses.append("EXISTS (SELECT 1 FROM failure_metrics fm WHERE fm.session_id = c.session_id AND fm.fingerprint = ?)")
        params.append(fingerprint)
    predicate = " AND ".join(clauses)
    order = ("COALESCE(c.max_response_latency_ms, 0) DESC" if selector in ("slowest", "audible_lag")
             else "c.failed_op_count DESC, c.started_at_epoch_ms DESC" if selector.endswith("failures")
             else "c.started_at_epoch_ms DESC")
    total = db.execute(f"SELECT COUNT(*) FROM call_metrics c WHERE {predicate}", params).fetchone()[0]
    rows = db.execute(
        "SELECT c.session_id, c.agent_id, c.started_at, c.duration_ms, c.turn_count, "
        "c.failed_op_count, c.audible_lag_turns, c.missing_final_turns, c.max_response_latency_ms, "
        "c.capture_incomplete, c.outcome, "
        "(SELECT t.turn_id FROM turn_metrics t WHERE t.session_id = c.session_id "
        " AND t.response_latency_ms IS NOT NULL ORDER BY t.response_latency_ms DESC LIMIT 1) AS slowest_turn_id, "
        "(SELECT f.turn_id FROM failure_metrics f WHERE f.session_id = c.session_id "
        " AND f.turn_id IS NOT NULL ORDER BY f.seq LIMIT 1) AS first_failed_turn_id "
        f"FROM call_metrics c WHERE {predicate} ORDER BY {order} LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    return {
        "selector": selector, "label": DRILLDOWNS[selector], "total": total,
        "limit": limit, "offset": offset,
        "items": [{**dict(row), "focus_turn_id": row["first_failed_turn_id"] or row["slowest_turn_id"]}
                  for row in rows],
    }
