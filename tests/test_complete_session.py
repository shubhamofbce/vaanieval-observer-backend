"""POST /v1/sessions/{id}/complete: verification, event import and re-completion."""

from __future__ import annotations

import hashlib

import pytest

from conftest import create, jsonl, object_info, operation, upload


def complete(client, session_id="call-1", objects=None):
    return client.post(f"/v1/sessions/{session_id}/complete", json={"objects": objects or {}})


def test_marks_a_session_ready_when_operations_were_imported(client):
    create(client, "call-1")
    events = jsonl(operation(started_at_ms=0), operation(event_id="op-2", type_="tts", started_at_ms=20))
    upload(client, "call-1", "events.jsonl", events)
    response = complete(client, objects={"events.jsonl": object_info(events)})
    assert response.status_code == 202
    assert response.json() == {"session_id": "call-1", "status": "ready", "operation_count": 2, "duration_ms": 4200}


def test_marks_a_session_partial_when_no_events_were_uploaded(client):
    create(client, "call-1")
    response = complete(client)
    assert response.status_code == 202
    assert response.json()["status"] == "partial"
    assert response.json()["operation_count"] == 0


def test_marks_a_session_partial_when_events_contain_no_operations(client):
    create(client, "call-1")
    events = jsonl({"kind": "audio_chunk", "track": "caller", "byte_length": 4})
    upload(client, "call-1", "events.jsonl", events)
    assert complete(client, objects={"events.jsonl": object_info(events)}).json()["status"] == "partial"


def test_rejects_completion_for_an_unknown_session(client):
    assert complete(client, "missing").status_code == 404


def test_rejects_an_object_name_outside_the_allow_list(client):
    create(client, "call-1")
    response = complete(client, objects={"manifest.json": object_info(b"x")})
    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported object name: manifest.json"


def test_rejects_an_object_that_was_never_uploaded(client):
    create(client, "call-1")
    response = complete(client, objects={"caller.audio": object_info(b"x")})
    assert response.status_code == 400
    assert response.json()["detail"] == "Missing upload: caller.audio"


def test_rejects_a_checksum_mismatch(client):
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"real-bytes")
    tampered = {"byte_size": len(b"real-bytes"), "sha256": hashlib.sha256(b"other").hexdigest()}
    response = complete(client, objects={"caller.audio": tampered})
    assert response.status_code == 400
    assert response.json()["detail"] == "Checksum verification failed: caller.audio"


def test_rejects_a_byte_size_mismatch(client):
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"real-bytes")
    info = object_info(b"real-bytes") | {"byte_size": 99}
    assert complete(client, objects={"caller.audio": info}).status_code == 400


def test_accepts_an_uppercase_digest(client):
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"payload")
    info = object_info(b"payload")
    info["sha256"] = info["sha256"].upper()
    assert complete(client, objects={"caller.audio": info}).status_code == 202


def test_verifies_an_empty_object(client):
    create(client, "call-1")
    upload(client, "call-1", "agent.audio", b"")
    assert complete(client, objects={"agent.audio": object_info(b"")}).status_code == 202


@pytest.mark.parametrize("digest", ["", "abc", "z" * 64, "0" * 63, "0" * 65])
def test_rejects_a_malformed_digest(client, digest):
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"payload")
    response = complete(client, objects={"caller.audio": {"byte_size": 7, "sha256": digest}})
    assert response.status_code == 422


def test_rejects_a_negative_byte_size(client):
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"payload")
    info = object_info(b"payload") | {"byte_size": -1}
    assert complete(client, objects={"caller.audio": info}).status_code == 422


def test_verifies_every_declared_object(client):
    create(client, "call-1")
    events = jsonl(operation())
    upload(client, "call-1", "events.jsonl", events)
    upload(client, "call-1", "caller.audio", b"\x00\x01")
    response = complete(
        client,
        objects={"events.jsonl": object_info(events), "caller.audio": object_info(b"\x00\x01")},
    )
    assert response.status_code == 202


def test_imports_only_operations_belonging_to_the_session(client):
    create(client, "call-1")
    events = jsonl(
        operation(event_id="keep"),
        operation(event_id="other-session", session_id="call-2"),
        operation(event_id="", type_="llm"),
        operation(event_id="bad-type", type_="websocket"),
        {"kind": "audio_chunk", "session_id": "call-1", "track": "caller"},
    )
    upload(client, "call-1", "events.jsonl", events)
    assert complete(client, objects={"events.jsonl": object_info(events)}).json()["operation_count"] == 1
    assert [op["event_id"] for op in client.get("/v1/sessions/call-1").json()["operations"]] == ["keep"]


def test_imports_operations_even_when_the_object_was_not_declared(client):
    create(client, "call-1")
    upload(client, "call-1", "events.jsonl", jsonl(operation()))
    assert complete(client).json()["operation_count"] == 1


def test_rejects_an_events_file_with_an_invalid_json_line(client):
    create(client, "call-1")
    payload = jsonl(operation()) + b"{not json}\n"
    upload(client, "call-1", "events.jsonl", payload)
    response = complete(client, objects={"events.jsonl": object_info(payload)})
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid events.jsonl on line 2"


def test_rejects_an_events_file_containing_a_blank_line(client):
    create(client, "call-1")
    payload = jsonl(operation()) + b"\n" + jsonl(operation(event_id="op-2"))
    upload(client, "call-1", "events.jsonl", payload)
    response = complete(client, objects={"events.jsonl": object_info(payload)})
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid events.jsonl on line 2"


def test_accepts_an_events_file_without_a_trailing_newline(client):
    create(client, "call-1")
    payload = jsonl(operation()).rstrip(b"\n")
    upload(client, "call-1", "events.jsonl", payload)
    assert complete(client, objects={"events.jsonl": object_info(payload)}).json()["operation_count"] == 1


def test_treats_a_completely_empty_events_file_as_no_operations(client):
    create(client, "call-1")
    upload(client, "call-1", "events.jsonl", b"")
    assert complete(client, objects={"events.jsonl": object_info(b"")}).json()["status"] == "partial"


def test_replaces_operations_instead_of_duplicating_them_on_recompletion(client):
    create(client, "call-1")
    upload(client, "call-1", "events.jsonl", jsonl(operation(), operation(event_id="op-2")))
    assert complete(client).json()["operation_count"] == 2

    upload(client, "call-1", "events.jsonl", jsonl(operation(event_id="op-3")))
    second = complete(client)
    assert second.json()["operation_count"] == 1
    assert [op["event_id"] for op in client.get("/v1/sessions/call-1").json()["operations"]] == ["op-3"]


def test_downgrades_status_when_a_recompletion_finds_no_operations(client):
    create(client, "call-1")
    upload(client, "call-1", "events.jsonl", jsonl(operation()))
    assert complete(client).json()["status"] == "ready"
    upload(client, "call-1", "events.jsonl", b"")
    assert complete(client).json()["status"] == "partial"
    assert client.get("/v1/sessions/call-1").json()["status"] == "partial"


def test_records_a_completion_timestamp(client, api):
    create(client, "call-1")
    complete(client)
    with api.connect() as db:
        row = db.execute("SELECT completed_at, updated_at FROM sessions WHERE id = 'call-1'").fetchone()
    assert row["completed_at"] is not None
    assert row["updated_at"] is not None


def test_reports_a_missing_duration_as_zero(client):
    create(client, "call-1", duration_ms=None)
    assert complete(client).json()["duration_ms"] is None


def test_defaults_the_objects_map_to_empty(client):
    create(client, "call-1")
    assert client.post("/v1/sessions/call-1/complete", json={}).status_code == 202


def test_rejects_a_malformed_objects_payload(client):
    create(client, "call-1")
    assert client.post("/v1/sessions/call-1/complete", json={"objects": "nope"}).status_code == 422
