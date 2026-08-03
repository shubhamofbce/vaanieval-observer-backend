"""PUT /v1/uploads/{session_id}/{object_name}: naming, overwrite, limits and path safety."""

from __future__ import annotations

import pytest

from conftest import create, manifest, upload


def test_writes_the_object_to_the_session_directory(client, api):
    create(client, "call-1")
    response = upload(client, "call-1", "caller.audio", b"\x01\x02\x03")
    assert response.status_code == 204
    assert response.content == b""
    assert (api.OBJECTS / "call-1" / "caller.audio").read_bytes() == b"\x01\x02\x03"


@pytest.mark.parametrize("name", ["events.jsonl", "caller.audio", "agent.audio"])
def test_accepts_every_allowed_object_name(client, name):
    create(client, "call-1")
    assert upload(client, "call-1", name, b"payload").status_code == 204


@pytest.mark.parametrize("name", ["manifest.json", "caller.wav", "notes.txt", "CALLER.AUDIO"])
def test_rejects_object_names_outside_the_allow_list(client, name):
    create(client, "call-1")
    response = upload(client, "call-1", name, b"payload")
    assert response.status_code == 404
    assert response.json()["detail"] == "Unsupported object name"


def test_rejects_an_upload_for_an_unknown_session(client):
    response = upload(client, "missing", "caller.audio", b"payload")
    assert response.status_code == 404
    assert response.json()["detail"] == "Session not found"


def test_checks_the_session_before_the_object_name(client):
    assert upload(client, "missing", "not-allowed", b"payload").status_code == 404


def test_overwrites_a_previously_uploaded_object(client, api):
    create(client, "call-1")
    upload(client, "call-1", "agent.audio", b"first-and-longer")
    upload(client, "call-1", "agent.audio", b"second")
    assert (api.OBJECTS / "call-1" / "agent.audio").read_bytes() == b"second"


def test_accepts_an_empty_body(client, api):
    create(client, "call-1")
    assert upload(client, "call-1", "events.jsonl", b"").status_code == 204
    assert (api.OBJECTS / "call-1" / "events.jsonl").read_bytes() == b""


def test_preserves_binary_payloads_byte_for_byte(client, api):
    create(client, "call-1")
    payload = bytes(range(256)) * 8
    upload(client, "call-1", "caller.audio", payload)
    assert (api.OBJECTS / "call-1" / "caller.audio").read_bytes() == payload


def test_rejects_a_body_above_the_local_ceiling(client, api, monkeypatch):
    monkeypatch.setattr(api, "MAX_UPLOAD_BYTES", 16)
    create(client, "call-1")
    assert upload(client, "call-1", "caller.audio", b"x" * 16).status_code == 204
    response = upload(client, "call-1", "caller.audio", b"x" * 17)
    assert response.status_code == 413
    assert "128 MiB" in response.json()["detail"]


def test_does_not_persist_an_over_sized_body(client, api, monkeypatch):
    monkeypatch.setattr(api, "MAX_UPLOAD_BYTES", 4)
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"toolong")
    assert not (api.OBJECTS / "call-1" / "caller.audio").exists()


@pytest.mark.parametrize("session_id", ["..", "../evil", "a/b", "./x", "..%2Fevil"])
def test_never_writes_outside_the_object_directory(client, api, session_id, tmp_path):
    """Traversal attempts are rejected by routing or by the session guard, never written."""
    client.post("/v1/sessions", json=manifest(session_id))
    response = client.put(f"/v1/uploads/{session_id}/caller.audio", content=b"payload")
    assert response.status_code in {400, 404}, response.text
    assert list(tmp_path.rglob("caller.audio")) == []


def test_rejects_a_traversal_session_id_that_reaches_the_handler(client, api):
    """A single-segment id that is not its own basename is refused by safe_session_dir."""
    with pytest.raises(Exception) as error:
        api.safe_session_dir("../evil")
    assert error.value.status_code == 400
    assert error.value.detail == "Invalid session id"


def test_creates_the_session_directory_lazily(client, api):
    create(client, "call-1")
    assert not (api.OBJECTS / "call-1").exists()
    upload(client, "call-1", "caller.audio", b"x")
    assert (api.OBJECTS / "call-1").is_dir()


def test_keeps_objects_of_two_sessions_apart(client, api):
    create(client, "call-1")
    create(client, "call-2")
    upload(client, "call-1", "caller.audio", b"one")
    upload(client, "call-2", "caller.audio", b"two")
    assert (api.OBJECTS / "call-1" / "caller.audio").read_bytes() == b"one"
    assert (api.OBJECTS / "call-2" / "caller.audio").read_bytes() == b"two"
