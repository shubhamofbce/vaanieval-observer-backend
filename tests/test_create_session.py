"""POST /v1/sessions: manifest validation, idempotency and upload URL issuance."""

from __future__ import annotations

from conftest import create, manifest


def test_returns_an_upload_url_for_every_allowed_object(client, api):
    response = create(client, "call-1")
    assert response.status_code == 201
    body = response.json()
    assert body["session_id"] == "call-1"
    assert set(body["upload_urls"]) == api.ALLOWED_OBJECTS
    for name, url in body["upload_urls"].items():
        assert url.endswith(f"/v1/uploads/call-1/{name}")
        assert url.startswith("http://")


def test_advertises_the_encodings_it_can_decompress(client):
    """The SDK must not compress unless told to.

    A dashboard predating gzip ingest returns `204` for a compressed PUT, stores
    the compressed bytes, and only fails at `/complete` -- losing the recording.
    This field is the handshake that prevents a newer SDK from doing that to an
    older server.
    """
    body = create(client, "call-1").json()
    assert body["accepted_encodings"] == ["gzip"]


def test_stores_the_session_as_uploading(client):
    create(client, "call-1")
    summary = client.get("/v1/sessions").json()
    assert len(summary) == 1
    assert summary[0]["status"] == "uploading"
    assert summary[0]["agent_id"] == "support"
    assert summary[0]["duration_ms"] == 4200


def test_is_idempotent_and_keeps_the_first_manifest(client):
    create(client, "call-1")
    second = client.post("/v1/sessions", json=manifest("call-1", agent_id="changed", outcome="failed"))
    assert second.status_code == 201
    sessions = client.get("/v1/sessions").json()
    assert len(sessions) == 1
    assert sessions[0]["agent_id"] == "support", "a repeated create must not overwrite the stored manifest"


def test_accepts_an_idempotency_key_equal_to_the_session_id(client):
    response = client.post("/v1/sessions", json=manifest("call-1"), headers={"idempotency-key": "call-1"})
    assert response.status_code == 201


def test_rejects_an_idempotency_key_that_does_not_match(client):
    response = client.post("/v1/sessions", json=manifest("call-1"), headers={"idempotency-key": "call-2"})
    assert response.status_code == 400
    assert "Idempotency-Key" in response.json()["detail"]


def test_allows_an_omitted_idempotency_key(client):
    assert client.post("/v1/sessions", json=manifest("call-1")).status_code == 201


def test_requires_a_session_id(client):
    assert client.post("/v1/sessions", json={}).status_code == 422
    assert client.post("/v1/sessions", json=manifest("")).status_code == 422


def test_rejects_a_session_id_longer_than_the_limit(client):
    assert client.post("/v1/sessions", json=manifest("x" * 160)).status_code == 201
    assert client.post("/v1/sessions", json=manifest("y" * 161)).status_code == 422


def test_rejects_a_negative_duration(client):
    assert client.post("/v1/sessions", json=manifest("call-1", duration_ms=-1)).status_code == 422


def test_accepts_a_null_duration_and_agent(client):
    response = client.post("/v1/sessions", json=manifest("call-1", duration_ms=None, agent_id=None))
    assert response.status_code == 201
    summary = client.get("/v1/sessions").json()[0]
    assert summary["agent_id"] is None
    assert summary["duration_ms"] is None


def test_applies_manifest_defaults_for_a_minimal_payload(client):
    assert client.post("/v1/sessions", json={"session_id": "call-min"}).status_code == 201
    stored = client.get("/v1/sessions/call-min").json()["manifest"]
    assert stored["schema_version"] == "1.0"
    assert stored["outcome"] == "unknown"
    assert stored["capture_status"] == {}
    assert stored["audio"] == {}
    assert stored["metadata"] == {}


def test_ignores_unknown_manifest_fields(client):
    response = client.post("/v1/sessions", json=manifest("call-1", unexpected="value"))
    assert response.status_code == 201
    assert "unexpected" not in client.get("/v1/sessions/call-1").json()["manifest"]


def test_rejects_a_wrongly_typed_audio_block(client):
    assert client.post("/v1/sessions", json=manifest("call-1", audio={"caller": "not-an-object"})).status_code == 422


def test_keeps_two_sessions_independent(client):
    create(client, "call-1")
    create(client, "call-2")
    assert {row["id"] for row in client.get("/v1/sessions").json()} == {"call-1", "call-2"}
