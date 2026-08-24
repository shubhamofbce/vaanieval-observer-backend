-- The metric schema exactly as it shipped, kept as a fixture so the
-- upgrade path is tested against a real released database rather than
-- against whatever the current code happens to produce. Do not edit to
-- match a new schema: adding a column here would delete the very
-- difference the test exists to detect.

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
