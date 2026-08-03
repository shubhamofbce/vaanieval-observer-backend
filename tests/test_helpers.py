"""Unit tests for the module level helpers that back the HTTP layer."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime

import pytest
from fastapi import HTTPException

from conftest import jsonl, operation


def test_now_returns_an_iso_utc_timestamp(api):
    value = api.now()
    parsed = datetime.fromisoformat(value)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset().total_seconds() == 0


def test_initialize_is_idempotent(api, data_dir):
    api.initialize()
    api.initialize()
    assert (data_dir / "objects").is_dir()
    with api.connect() as db:
        tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"sessions", "operations"} <= tables


def test_connect_commits_and_closes(api, data_dir):
    with api.connect() as db:
        db.execute("INSERT INTO sessions VALUES ('a', '{}', 'uploading', 'now', 'now', NULL)")
    with api.connect() as db:
        assert db.execute("SELECT COUNT(*) AS total FROM sessions").fetchone()["total"] == 1


def test_connect_closes_the_connection_on_error(api, data_dir):
    with pytest.raises(sqlite3.OperationalError):
        with api.connect() as db:
            db.execute("SELECT * FROM does_not_exist")


def test_safe_session_dir_accepts_a_plain_id(api, data_dir):
    assert api.safe_session_dir("call-1") == api.OBJECTS / "call-1"


@pytest.mark.parametrize("session_id", ["..", "../evil", "a/b", ".", "", "dir/"])
def test_safe_session_dir_rejects_anything_that_is_not_a_bare_name(api, session_id):
    with pytest.raises(HTTPException) as error:
        api.safe_session_dir(session_id)
    assert error.value.status_code == 400
    assert error.value.detail == "Invalid session id"


def test_require_session_raises_for_an_unknown_id(api, data_dir):
    with pytest.raises(HTTPException) as error:
        api.require_session("missing")
    assert error.value.status_code == 404


def test_import_operations_returns_empty_when_the_file_is_absent(api, data_dir):
    assert api.import_operations("call-1") == []


def write_events(api, session_id: str, payload: bytes) -> None:
    directory = api.OBJECTS / session_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "events.jsonl").write_bytes(payload)


def test_import_operations_keeps_only_well_formed_matching_operations(api, data_dir):
    write_events(
        api,
        "call-1",
        jsonl(
            operation(event_id="keep-llm", type_="llm"),
            operation(event_id="keep-stt", type_="stt"),
            operation(event_id="keep-tts", type_="tts"),
            operation(event_id="wrong-session", session_id="call-2"),
            operation(event_id="wrong-type", type_="websocket"),
            {"event_id": "no-type", "session_id": "call-1"},
            {"session_id": "call-1", "type": "llm"},
            {"kind": "audio_chunk", "session_id": "call-1"},
        ),
    )
    assert [op["event_id"] for op in api.import_operations("call-1")] == ["keep-llm", "keep-stt", "keep-tts"]


def test_import_operations_preserves_input_order(api, data_dir):
    write_events(api, "call-1", jsonl(operation(event_id="b", started_at_ms=90), operation(event_id="a", started_at_ms=1)))
    assert [op["event_id"] for op in api.import_operations("call-1")] == ["b", "a"]


def test_import_operations_reports_the_offending_line_number(api, data_dir):
    write_events(api, "call-1", jsonl(operation(), operation(event_id="op-2")) + b"oops\n")
    with pytest.raises(HTTPException) as error:
        api.import_operations("call-1")
    assert error.value.status_code == 400
    assert error.value.detail == "Invalid events.jsonl on line 3"


def test_import_operations_accepts_an_empty_file(api, data_dir):
    write_events(api, "call-1", b"")
    assert api.import_operations("call-1") == []


def test_recordings_reports_uploaded_state_and_size(api, data_dir):
    directory = api.OBJECTS / "call-1"
    directory.mkdir(parents=True)
    (directory / "caller.audio").write_bytes(b"1234")
    result = api.recordings("call-1", {"audio": {"caller": {"file": "caller.audio", "channels": 1}, "agent": {"file": "agent.audio"}}})
    assert result == [
        {"track": "caller", "uploaded": True, "size_bytes": 4, "file": "caller.audio", "channels": 1},
        {"track": "agent", "uploaded": False, "size_bytes": 0, "file": "agent.audio"},
    ]


def test_recordings_is_empty_without_an_audio_block(api, data_dir):
    assert api.recordings("call-1", {}) == []


def test_session_summary_reads_manifest_fields_from_the_row(api, data_dir):
    payload = {"agent_id": "support", "duration_ms": 12, "outcome": "completed", "started_at": "2026-01-01T00:00:00+00:00"}
    with api.connect() as db:
        db.execute("INSERT INTO sessions VALUES ('call-1', ?, 'ready', 'created', 'updated', 'done')", (json.dumps(payload),))
        row = db.execute("SELECT * FROM sessions WHERE id = 'call-1'").fetchone()
    assert api.session_summary(row) == {
        "id": "call-1",
        "agent_id": "support",
        "duration_ms": 12,
        "outcome": "completed",
        "status": "ready",
        "started_at": "2026-01-01T00:00:00+00:00",
        "created_at": "created",
    }


def test_session_summary_defaults_a_missing_duration_to_zero(api, data_dir):
    with api.connect() as db:
        db.execute("INSERT INTO sessions VALUES ('call-1', '{}', 'uploading', 'created', 'updated', NULL)")
        row = db.execute("SELECT * FROM sessions WHERE id = 'call-1'").fetchone()
    summary = api.session_summary(row)
    assert summary["duration_ms"] == 0
    assert summary["agent_id"] is None
    assert summary["outcome"] is None


def test_object_allow_list_matches_the_sdk_package_layout(api):
    assert api.ALLOWED_OBJECTS == {"events.jsonl", "caller.audio", "agent.audio"}
    assert api.MAX_UPLOAD_BYTES == 128 * 1024 * 1024
