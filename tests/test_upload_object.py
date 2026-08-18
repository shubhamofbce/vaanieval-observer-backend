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


@pytest.mark.parametrize("name", ["events.jsonl", "call.audio", "caller.audio", "agent.audio"])
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


# ----------------------------------------------- gzipped uploads (SDK P0-2 fix)


def test_accepts_a_gzipped_body_and_stores_the_decompressed_object(client, api):
    """Raw PCM is the largest object and the most compressible.

    The SDK gzips it in transit so a shutdown hook has a chance of finishing.
    What lands on disk must still be the raw object, because every consumer --
    Range requests, waveform peaks, WAV clipping, the STT challenger -- seeks it
    by sample offset.
    """
    import gzip

    create(client, "call-1")
    payload = b"\x01\x02\x03\x04" * 5000
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=gzip.compress(payload),
        headers={"content-encoding": "gzip"},
    )
    assert response.status_code == 204
    assert (api.OBJECTS / "call-1" / "call.audio").read_bytes() == payload


def test_an_identity_encoding_is_still_stored_verbatim(client, api):
    create(client, "call-1")
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=b"\x01\x02\x03",
        headers={"content-encoding": "identity"},
    )
    assert response.status_code == 204
    assert (api.OBJECTS / "call-1" / "call.audio").read_bytes() == b"\x01\x02\x03"


def test_rejects_an_encoding_it_cannot_decode(client):
    create(client, "call-1")
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=b"\x01\x02\x03",
        headers={"content-encoding": "br"},
    )
    assert response.status_code == 415


def test_rejects_a_malformed_gzip_body_instead_of_storing_garbage(client, api):
    create(client, "call-1")
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=b"this is not gzip at all",
        headers={"content-encoding": "gzip"},
    )
    assert response.status_code == 400
    assert not (api.OBJECTS / "call-1" / "call.audio").exists()


def test_rejects_a_truncated_gzip_body_rather_than_storing_a_prefix(client, api):
    """`decompressobj.flush()` does not raise on a stream that simply stops.

    The CRC and length trailer are never reached, so nothing disagrees and the
    decompressed prefix would be renamed over the target with a `204`.
    """
    import gzip

    body = gzip.compress(b"\x01\x00" * 10000)
    create(client, "call-1")
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=body[: len(body) // 2],
        headers={"content-encoding": "gzip"},
    )
    assert response.status_code == 400
    assert not (api.OBJECTS / "call-1" / "call.audio").exists()


def test_a_truncated_gzip_body_cannot_destroy_an_already_verified_object(client, api):
    """Unverified bytes must never replace verified ones."""
    import gzip

    good = b"\x01\x00" * 10000
    create(client, "call-1")
    assert client.put(
        "/v1/uploads/call-1/call.audio",
        content=gzip.compress(good),
        headers={"content-encoding": "gzip"},
    ).status_code == 204
    stored = api.OBJECTS / "call-1" / "call.audio"
    assert stored.read_bytes() == good

    truncated = gzip.compress(good)
    client.put(
        "/v1/uploads/call-1/call.audio",
        content=truncated[: len(truncated) // 2],
        headers={"content-encoding": "gzip"},
    )
    assert stored.read_bytes() == good, "a failed re-upload must leave the object intact"


def test_two_uploads_of_one_object_do_not_share_a_partial_file(client, api, monkeypatch):
    """An in-process upload and a spool drainer can race on the same URL.

    A single `call.audio.part` would interleave their writes, and the loser's
    cleanup would delete the winner's temp file.
    """
    import gzip

    import threading

    create(client, "call-1")
    payload = b"\x02\x00" * 10000
    seen: list[str] = []
    real_open = api.Path.open

    def watching_open(self, *args, **kwargs):
        if self.name.endswith(".part"):
            seen.append(self.name)
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(api.Path, "open", watching_open)

    errors: list[BaseException] = []

    def upload():
        try:
            response = client.put(
                "/v1/uploads/call-1/call.audio",
                content=gzip.compress(payload),
                headers={"content-encoding": "gzip"},
            )
            assert response.status_code == 204, response.text
        except BaseException as error:  # noqa: BLE001 - re-raised on the main thread
            errors.append(error)

    threads = [threading.Thread(target=upload) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors, errors
    # The load-bearing assertion: each concurrent upload must get its *own*
    # temp file. Sharing one `call.audio.part` interleaves their writes and the
    # loser's cleanup deletes the winner's file.
    assert len(seen) == 4, seen
    assert len(set(seen)) == 4, f"concurrent uploads shared a temp file: {seen}"

    leftovers = list((api.OBJECTS / "call-1").glob("*.part"))
    assert leftovers == [], f"partial files must not survive: {leftovers}"
    assert (api.OBJECTS / "call-1" / "call.audio").read_bytes() == payload


def test_a_failed_re_upload_does_not_destroy_the_stored_object(client, api):
    """The second attempt must not be able to damage a verified object.

    `zlib`'s `flush()` does not raise on a truncated stream — the CRC trailer is
    simply never reached — so a truncated body once looked like a clean upload
    and replaced good bytes with short ones.
    """
    import gzip

    create(client, "call-1")
    payload = b"\x02\x00" * 10000
    assert client.put(
        "/v1/uploads/call-1/call.audio",
        content=gzip.compress(payload),
        headers={"content-encoding": "gzip"},
    ).status_code == 204

    truncated = gzip.compress(payload)[: -len(gzip.compress(payload)) // 2]
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=truncated,
        headers={"content-encoding": "gzip"},
    )

    assert response.status_code == 400, response.text
    assert (api.OBJECTS / "call-1" / "call.audio").read_bytes() == payload
    assert list((api.OBJECTS / "call-1").glob("*.part")) == []


def test_the_size_ceiling_applies_to_the_decompressed_object(client, api, monkeypatch):
    """Otherwise a tiny gzip bomb writes gigabytes to disk."""
    import gzip

    monkeypatch.setattr(api, "MAX_UPLOAD_BYTES", 1024)
    create(client, "call-1")
    response = client.put(
        "/v1/uploads/call-1/call.audio",
        content=gzip.compress(b"\x00" * (64 * 1024)),
        headers={"content-encoding": "gzip"},
    )
    assert response.status_code == 413
    assert not (api.OBJECTS / "call-1" / "call.audio").exists()
