"""API key minting, presentation, revocation and usage recording.

These go through the HTTP surface rather than `app.keys` directly: the property
that matters is that a key created in a browser is the same key an SDK can
authenticate with, and a unit test of the store would pass while the two halves
disagreed about the header format.
"""

from __future__ import annotations

import pytest
from conftest import jsonl, manifest, object_info, operation

from app import keys


def create_key(client, name: str = "local dev"):
    response = client.post("/v1/api-keys", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_created_key_is_returned_once_and_never_again(client):
    created = create_key(client)
    token = created["token"]
    assert token.startswith(keys.TOKEN_PREFIX)
    assert created["prefix"] == token[: keys.PREFIX_LENGTH]

    listed = client.get("/v1/api-keys").json()["keys"]
    assert len(listed) == 1
    assert "token" not in listed[0]
    # Nothing in the stored record may be enough to reconstruct the secret.
    assert token not in str(listed[0])


def test_the_plaintext_token_is_not_stored(client, api):
    token = create_key(client)["token"]
    with api.connect() as db:
        row = db.execute("SELECT * FROM api_keys").fetchone()
    assert token not in dict(row).values()
    assert row["token_sha256"] == keys.digest(token)


def test_a_blank_name_gets_a_usable_default(client):
    assert create_key(client, "")["name"] == "Default key"
    assert create_key(client, "   ")["name"] == "Default key"


def test_two_keys_never_collide(client):
    first, second = create_key(client, "a"), create_key(client, "b")
    assert first["token"] != second["token"]
    assert first["id"] != second["id"]


def test_revoking_is_a_tombstone_not_a_delete(client):
    created = create_key(client)
    revoked = client.delete(f"/v1/api-keys/{created['id']}")
    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"]

    listed = client.get("/v1/api-keys").json()["keys"]
    assert len(listed) == 1, "a revoked key stays visible so the developer can see why ingest stopped"
    assert listed[0]["revoked_at"]


def test_revoking_twice_keeps_the_first_timestamp(client):
    created = create_key(client)
    first = client.delete(f"/v1/api-keys/{created['id']}").json()
    second = client.delete(f"/v1/api-keys/{created['id']}").json()
    assert first["revoked_at"] == second["revoked_at"]


def test_revoking_an_unknown_key_is_a_404(client):
    assert client.delete("/v1/api-keys/nope").status_code == 404


def test_the_active_key_ceiling_is_enforced_and_revoking_frees_a_slot(client, api):
    ids = [create_key(client, f"key-{index}")["id"] for index in range(keys.MAX_ACTIVE_KEYS)]
    refused = client.post("/v1/api-keys", json={"name": "one too many"})
    assert refused.status_code == 409

    client.delete(f"/v1/api-keys/{ids[0]}")
    assert client.post("/v1/api-keys", json={"name": "now there is room"}).status_code == 201


def test_an_oversized_name_is_rejected_not_silently_truncated(client):
    assert client.post("/v1/api-keys", json={"name": "x" * 500}).status_code == 422


def test_ingest_records_that_a_key_was_used(client):
    created = create_key(client)
    before = client.get("/v1/api-keys").json()["keys"][0]
    assert before["last_used_at"] is None

    response = client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert response.status_code == 201

    after = client.get("/v1/api-keys").json()["keys"][0]
    assert after["last_used_at"], "the onboarding page's strongest evidence is that a key authenticated"


def test_an_unknown_key_leaves_no_usage_and_does_not_block_ingest(client):
    create_key(client)
    response = client.post(
        "/v1/sessions", json=manifest("call-1"), headers={"authorization": "Bearer local-dev"}
    )
    assert response.status_code == 201, "the documented local setup uses a literal placeholder key"
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] is None


def test_a_revoked_key_is_no_longer_recognised(client):
    created = create_key(client)
    client.delete(f"/v1/api-keys/{created['id']}")
    client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] is None


@pytest.mark.parametrize(
    "header,expected",
    [
        (f"Bearer {keys.TOKEN_PREFIX}abc", f"{keys.TOKEN_PREFIX}abc"),
        (f"bearer {keys.TOKEN_PREFIX}abc", f"{keys.TOKEN_PREFIX}abc"),
        (f"  Bearer   {keys.TOKEN_PREFIX}abc  ", f"{keys.TOKEN_PREFIX}abc"),
        (f"{keys.TOKEN_PREFIX}abc", f"{keys.TOKEN_PREFIX}abc"),
        ("Basic abc", None),
        ("Bearer", None),
        ("", None),
        (None, None),
    ],
)
def test_bearer_parsing(header, expected):
    assert keys.bearer(header) == expected


def test_usage_stamps_are_coalesced_but_never_missed(client, api):
    """The first use must be recorded immediately — the onboarding page is
    waiting on exactly that event — while a fleet uploading calls must not take
    the single SQLite write lock twice per call to rewrite a timestamp."""
    created = create_key(client)
    headers = {"authorization": f"Bearer {created['token']}"}
    client.post("/v1/sessions", json=manifest("call-1"), headers=headers)
    first = client.get("/v1/api-keys").json()["keys"][0]["last_used_at"]
    assert first

    client.post("/v1/sessions", json=manifest("call-2"), headers=headers)
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] == first

    # Once the interval has passed the stamp moves again, so a key that stopped
    # being used is distinguishable from one that never was.
    with api.connect() as db:
        db.execute("UPDATE api_keys SET last_used_at = '2020-01-01T00:00:00+00:00'")
    client.post("/v1/sessions", json=manifest("call-3"), headers=headers)
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] != "2020-01-01T00:00:00+00:00"


def test_a_stamp_from_the_future_is_corrected(client, api):
    """A restored backup or an NTP correction must not pin `last_used_at`
    forever, which is what a one-sided 'is it older than a minute' check does."""
    created = create_key(client)
    with api.connect() as db:
        db.execute("UPDATE api_keys SET last_used_at = '2999-01-01T00:00:00+00:00'")
    client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] < "2999"


def test_enforcement_is_off_by_default(client):
    assert client.post("/v1/sessions", json=manifest("call-1")).status_code == 201


def test_enforcement_rejects_unknown_keys_when_switched_on(client, monkeypatch, api):
    created = create_key(client)
    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")

    missing = client.post("/v1/sessions", json=manifest("call-1"))
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"

    wrong = client.post(
        "/v1/sessions", json=manifest("call-1"), headers={"authorization": "Bearer local-dev"}
    )
    assert wrong.status_code == 401

    allowed = client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert allowed.status_code == 201


def test_enforcement_also_covers_completion(client, monkeypatch, api):
    created = create_key(client)
    headers = {"authorization": f"Bearer {created['token']}"}
    assert client.post("/v1/sessions", json=manifest("call-1"), headers=headers).status_code == 201
    events = jsonl(operation())
    assert client.put("/v1/uploads/call-1/events.jsonl", content=events).status_code == 204

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    body = {"objects": {"events.jsonl": object_info(events)}}
    assert client.post("/v1/sessions/call-1/complete", json=body).status_code == 401
    assert client.post("/v1/sessions/call-1/complete", json=body, headers=headers).status_code == 202


def test_object_uploads_stay_unauthenticated_under_enforcement(client, monkeypatch, api):
    created = create_key(client)
    headers = {"authorization": f"Bearer {created['token']}"}
    assert client.post("/v1/sessions", json=manifest("call-1"), headers=headers).status_code == 201

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    assert client.put("/v1/uploads/call-1/events.jsonl", content=jsonl(operation())).status_code == 204


def test_minting_a_key_cannot_walk_through_the_enforcement_gate(client, monkeypatch, api):
    """The gate has to be worth more than one unauthenticated request. If anyone
    who can reach ingest can also mint a key, enforcement buys nothing."""
    create_key(client)
    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")

    refused = client.post(
        "/v1/api-keys", json={"name": "self-issued"}, headers={"x-forwarded-for": "10.0.0.9"}
    )
    assert refused.status_code == 401
    assert refused.headers["www-authenticate"] == "Bearer"


def test_revocation_is_guarded_too_under_enforcement(client, monkeypatch, api):
    """An unauthenticated caller must not be able to take a fleet's ingest down."""
    created = create_key(client)
    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")

    refused = client.delete(f"/v1/api-keys/{created['id']}", headers={"x-forwarded-for": "10.0.0.9"})
    assert refused.status_code == 401
    assert client.get("/v1/api-keys").json()["keys"][0]["revoked_at"] is None

    allowed = client.delete(
        f"/v1/api-keys/{created['id']}", headers={"authorization": f"Bearer {created['token']}"}
    )
    assert allowed.status_code == 200


def test_a_live_key_can_mint_under_enforcement(client, monkeypatch, api):
    created = create_key(client)
    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    headers = {"authorization": f"Bearer {created['token']}"}
    assert client.post("/v1/api-keys", json={"name": "second"}, headers=headers).status_code == 201


def test_a_revoked_key_cannot_mint_its_own_replacement(client, monkeypatch, api):
    first = create_key(client, "first")
    create_key(client, "second")   # so the loopback bootstrap cannot apply
    client.delete(f"/v1/api-keys/{first['id']}")
    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")

    refused = client.post(
        "/v1/api-keys",
        json={"name": "resurrected"},
        headers={"authorization": f"Bearer {first['token']}"},
    )
    assert refused.status_code == 401


def test_the_first_key_can_still_be_created_from_the_host(data_dir, monkeypatch, api):
    """Otherwise an operator who switches enforcement on before minting a key is
    locked out of ever minting one."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    with TestClient(api.app, client=("127.0.0.1", 51234)) as client:
        bootstrap = client.post("/v1/api-keys", json={"name": "bootstrap"})
        assert bootstrap.status_code == 201

        # The exception closes the moment it is used: a second key needs the first.
        assert client.post("/v1/api-keys", json={"name": "second"}).status_code == 401
        assert client.post(
            "/v1/api-keys",
            json={"name": "second"},
            headers={"authorization": f"Bearer {bootstrap.json()['token']}"},
        ).status_code == 201


def test_a_proxied_request_is_never_treated_as_local(data_dir, monkeypatch, api):
    """Behind a reverse proxy every visitor arrives as 127.0.0.1, so a peer
    address alone must not open the bootstrap path."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    with TestClient(api.app, client=("127.0.0.1", 51234)) as client:
        for header in api.FORWARDING_HEADERS:
            refused = client.post("/v1/api-keys", json={"name": "proxied"}, headers={header: "10.0.0.9"})
            assert refused.status_code == 401, header


def test_a_remote_peer_never_gets_the_bootstrap_exception(data_dir, monkeypatch, api):
    from fastapi.testclient import TestClient

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    with TestClient(api.app, client=("10.0.0.9", 51234)) as client:
        assert client.post("/v1/api-keys", json={"name": "remote"}).status_code == 401


def test_key_management_stays_open_when_enforcement_is_off(client):
    """The default local-first setup must not grow a login screen."""
    assert client.post("/v1/api-keys", json={"name": "local"}).status_code == 201
    assert client.get("/v1/api-keys").status_code == 200


def test_a_naive_stamp_does_not_break_ingest_under_enforcement(client, monkeypatch, api):
    """A hand-edited or imported row can hold an offset-naive timestamp.
    Subtracting it from an aware `now()` raises TypeError, and under enforcement
    `authenticate` re-raises — turning a cosmetic timestamp refresh into a failed
    upload. A stamp it cannot read must simply be refreshed."""
    created = create_key(client)
    with api.connect() as db:
        db.execute("UPDATE api_keys SET last_used_at = '2020-01-01T00:00:00'")   # no offset

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    accepted = client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert accepted.status_code == 201
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] > "2020"


def test_an_unparseable_stamp_is_refreshed_rather_than_fatal(client, api):
    created = create_key(client)
    with api.connect() as db:
        db.execute("UPDATE api_keys SET last_used_at = 'not a timestamp'")
    client.post(
        "/v1/sessions",
        json=manifest("call-1"),
        headers={"authorization": f"Bearer {created['token']}"},
    )
    assert client.get("/v1/api-keys").json()["keys"][0]["last_used_at"] != "not a timestamp"


def test_a_dual_stack_host_still_gets_the_bootstrap(data_dir, monkeypatch, api):
    """A dual-stack listener reports an IPv4 client as ::ffff:127.0.0.1. Matching
    literal strings would refuse the operator standing on the host the one
    request that can ever create a first key."""
    from fastapi.testclient import TestClient

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    with TestClient(api.app, client=("::ffff:127.0.0.1", 51234)) as client:
        assert client.post("/v1/api-keys", json={"name": "bootstrap"}).status_code == 201


def test_a_malformed_peer_address_is_not_local(data_dir, monkeypatch, api):
    from fastapi.testclient import TestClient

    monkeypatch.setenv(api.REQUIRE_API_KEY_ENV, "1")
    with TestClient(api.app, client=("not-an-address", 51234)) as client:
        assert client.post("/v1/api-keys", json={"name": "nope"}).status_code == 401
