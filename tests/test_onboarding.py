"""Onboarding status.

The single property under test throughout: a step reports `verified` only when
this instance holds the row that proves it. Every test therefore drives the
real ingest endpoints and then asserts on what the setup page would say, rather
than asserting on a computation over data a test inserted by hand.
"""

from __future__ import annotations

from conftest import jsonl, manifest, object_info, operation


def uninstrumented() -> bytes:
    """An events file from an agent whose `endpoints` list matched nothing.

    Audio still lands — the SDK tees that unconditionally — but no provider
    request was timed, so nothing in the file is an operation. This is the exact
    file the `capture` step exists to diagnose, and it is why the test does not
    just upload an empty file: an empty package would also be produced by a
    thousand unrelated faults.
    """
    return jsonl(
        {"event_id": "chunk-1", "session_id": "call-1", "type": "audio_chunk",
         "track": "caller", "occurred_at_ms": 0, "byte_count": 640},
    )


def steps(client) -> dict:
    response = client.get("/v1/onboarding/status")
    assert response.status_code == 200
    payload = response.json()
    return {step["id"]: step for step in payload["steps"]}, payload


def ingest(client, session_id: str = "call-1", events: bytes | None = None, **overrides):
    """Create, upload and complete one call the way an SDK does."""
    created = client.post("/v1/sessions", json=manifest(session_id, **overrides))
    assert created.status_code == 201
    if events is None:
        return created
    path = created.json()["upload_urls"]["events.jsonl"].split("http://testserver", 1)[1]
    assert client.put(path, content=events).status_code == 204
    completed = client.post(
        f"/v1/sessions/{session_id}/complete",
        json={"objects": {"events.jsonl": object_info(events)}},
    )
    assert completed.status_code == 202
    return completed


def test_a_fresh_instance_claims_nothing(client):
    by_id, payload = steps(client)
    assert payload["complete"] is False
    assert payload["verified_steps"] == 0
    assert [step["state"] for step in payload["steps"]] == ["waiting"] * 4
    # A step that is not done must carry the reason, never an evidence string.
    for step in payload["steps"]:
        assert step["evidence"] is None
        assert step["waiting"]
    assert payload["ingest"]["sessions"] == 0
    assert payload["ingest"]["uploaded_without_operations"] == 0


def test_only_the_install_step_may_be_self_reported(client):
    _, payload = steps(client)
    assert [step["id"] for step in payload["steps"] if step["self_reportable"]] == ["install"]


def test_creating_a_key_verifies_only_the_key_step(client):
    client.post("/v1/api-keys", json={"name": "local"})
    by_id, payload = steps(client)
    assert by_id["api-key"]["state"] == "verified"
    assert payload["verified_steps"] == 1
    assert by_id["install"]["state"] == "waiting"
    # "A key exists" is a far weaker claim than "a key authenticated", and the
    # page must not conflate them.
    assert "not yet seen" in by_id["api-key"]["evidence"]
    assert by_id["api-key"]["detail"]["authenticated"] is False


def test_a_used_key_upgrades_the_evidence(client):
    created = client.post("/v1/api-keys", json={"name": "local"}).json()
    client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    by_id, _ = steps(client)
    assert "authenticated an ingest request" in by_id["api-key"]["evidence"]
    assert by_id["api-key"]["detail"]["authenticated"] is True


def test_revoking_the_last_key_un_verifies_the_step(client):
    created = client.post("/v1/api-keys", json={"name": "local"}).json()
    client.delete(f"/v1/api-keys/{created['id']}")
    by_id, _ = steps(client)
    assert by_id["api-key"]["state"] == "waiting"


def test_an_uploaded_call_verifies_install_and_instrument(client):
    ingest(client, "call-1")
    by_id, payload = steps(client)
    assert by_id["install"]["state"] == "verified"
    assert "0.1.0" in by_id["install"]["evidence"]
    assert by_id["install"]["self_reportable"] is False, "real evidence retires the self-report"
    assert by_id["instrument"]["state"] == "verified"
    assert "1 call started" in by_id["instrument"]["evidence"]
    assert "support" in by_id["instrument"]["evidence"]
    assert payload["ingest"]["first"]["runtime"] == "Node.js"


def test_a_manifest_without_an_sdk_block_does_not_verify_install(client):
    """A hand-rolled `curl` upload proves a call arrived, not that the SDK ran."""
    ingest(client, "call-1", sdk={})
    by_id, _ = steps(client)
    assert by_id["install"]["state"] == "waiting"
    assert by_id["instrument"]["state"] == "verified"


def test_a_call_that_captured_nothing_is_diagnosed_not_celebrated(client):
    """The failure this page exists to catch: the upload works and the
    `endpoints` list matched none of the agent's provider URLs."""
    ingest(client, "call-1", events=uninstrumented())
    by_id, payload = steps(client)
    assert by_id["instrument"]["state"] == "verified"
    assert by_id["capture"]["state"] == "waiting"
    assert payload["complete"] is False
    assert "recorded no operations" in by_id["capture"]["waiting"]
    assert "endpoints" in by_id["capture"]["waiting"]
    assert by_id["capture"]["detail"]["uploaded_without_operations"] == 1


def test_a_call_still_uploading_is_named_as_in_flight_not_as_broken(client):
    """The handshake row exists before any object is uploaded. The page used to
    say "1 call received" and "nothing has been uploaded" at the same time; a
    developer whose upload died mid-way was told two contradictory things and
    could trust neither."""
    client.post("/v1/sessions", json=manifest("call-1"))
    by_id, _ = steps(client)

    assert by_id["capture"]["detail"]["uploaded_without_operations"] == 0
    assert by_id["capture"]["detail"]["in_flight"] == 1
    assert "started uploading but never finished" in by_id["capture"]["waiting"]
    # And it must not blame the endpoints list, which is a different failure.
    assert "endpoints" not in by_id["capture"]["waiting"]
    assert "started" in by_id["instrument"]["evidence"]


def test_no_call_at_all_says_there_is_nothing_to_check(client):
    by_id, _ = steps(client)
    assert by_id["capture"]["detail"]["in_flight"] == 0
    assert "nothing to check" in by_id["capture"]["waiting"]


def test_a_captured_call_completes_the_setup(client):
    client.post("/v1/api-keys", json={"name": "local"})
    ingest(client, "call-1", events=jsonl(operation()))

    by_id, payload = steps(client)
    assert payload["complete"] is True
    assert payload["verified_steps"] == payload["total_steps"] == 4
    assert by_id["capture"]["state"] == "verified"
    assert "1 operation captured" in by_id["capture"]["evidence"]
    assert by_id["capture"]["detail"]["captured"]["session_id"] == "call-1"


def test_one_good_call_survives_a_bad_one(client):
    """A later empty call must not un-verify a step already proven."""
    ingest(client, "call-good", events=jsonl(operation(session_id="call-good")))
    ingest(client, "call-empty", events=uninstrumented())
    by_id, _ = steps(client)
    assert by_id["capture"]["state"] == "verified"
    assert by_id["capture"]["detail"]["captured"]["session_id"] == "call-good"


def test_the_endpoint_is_echoed_from_the_request(client):
    """The snippet must be copy-pasteable from wherever the dashboard was
    reached, not from wherever it was started."""
    _, payload = steps(client)
    assert payload["endpoint"] == "http://testserver"

    forwarded = client.get("/v1/onboarding/status", headers={"host": "observer.internal:9000"})
    assert forwarded.json()["endpoint"] == "http://observer.internal:9000"


def test_recent_calls_are_bounded_and_newest_first(client):
    from app import onboarding

    for index in range(onboarding.RECENT_LIMIT + 3):
        ingest(client, f"call-{index}")
    _, payload = steps(client)
    recent = payload["ingest"]["recent"]
    assert len(recent) == onboarding.RECENT_LIMIT
    assert recent[0]["session_id"] == payload["ingest"]["latest"]["session_id"]
    assert payload["ingest"]["first"]["session_id"] == "call-0"
    assert payload["ingest"]["sessions"] == onboarding.RECENT_LIMIT + 3


def test_enforcement_state_is_reported(client, monkeypatch, api):
    _, payload = steps(client)
    assert payload["enforcement"] == {"required": False, "env_var": api.REQUIRE_API_KEY_ENV}

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    _, payload = steps(client)
    assert payload["enforcement"]["required"] is True


def test_a_corrupt_manifest_does_not_break_the_page(client, api):
    """A row written by an older build must degrade to 'unknown', not a 500 —
    this is the one page a broken instance is read from."""
    client.post("/v1/sessions", json=manifest("call-1"))
    with api.connect() as db:
        db.execute("UPDATE sessions SET manifest_json = 'not json' WHERE id = 'call-1'")

    by_id, payload = steps(client)
    assert payload["ingest"]["first"]["sdk"] == {"name": None, "version": None, "language": None}
    assert by_id["install"]["state"] == "waiting"
    assert by_id["instrument"]["state"] == "verified"


def test_the_page_and_its_assets_are_served(client):
    assert client.get("/onboarding").status_code == 200
    for asset in ("onboarding.css", "onboarding.js", "nav.js"):
        assert client.get(f"/assets/{asset}").status_code == 200, asset


def test_a_curl_smoke_test_before_the_sdk_does_not_freeze_the_install_step(client):
    """Reading `install` off the *earliest* call froze it at "nothing has run
    this SDK" for the life of the instance once anyone poked the API with curl
    first — while the step below it read "operations captured". The contract is
    "*a* manifest carried a version", not "the first one did"."""
    client.post("/v1/api-keys", json={"name": "local"})
    ingest(client, "curl-probe", sdk={})            # no SDK block, arrives first
    ingest(client, "real-call", events=jsonl(operation(session_id="real-call")))

    by_id, payload = steps(client)
    assert by_id["install"]["state"] == "verified"
    assert "SDK 0.1.0" in by_id["install"]["evidence"]
    assert by_id["install"]["detail"]["installed"]["session_id"] == "real-call"
    # And the page as a whole can now actually finish.
    assert payload["complete"] is True


def test_install_evidence_names_the_call_that_reported_the_version(client):
    ingest(client, "curl-probe", sdk={})
    ingest(client, "node-call", sdk={"name": "@vaanieal/observer", "language": "nodejs", "version": "0.2.0"})

    by_id, _ = steps(client)
    assert "Node.js SDK 0.2.0" in by_id["install"]["evidence"]
    assert by_id["install"]["detail"]["sdk"]["version"] == "0.2.0"


def test_a_call_that_never_declared_a_version_still_says_so(client):
    """The fallback must stay honest when *no* call carried a version."""
    ingest(client, "curl-probe", sdk={})
    by_id, _ = steps(client)
    assert by_id["install"]["state"] == "waiting"
    assert by_id["install"]["detail"]["installed"] is None
