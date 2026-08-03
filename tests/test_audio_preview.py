"""Browser audio preview endpoints."""

from __future__ import annotations

import wave
import struct
from io import BytesIO

from conftest import create, upload


def test_wraps_pcm_track_in_a_playable_wav(client):
    audio = {"caller": {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}}
    create(client, "call-1", audio=audio)
    upload(client, "call-1", "caller.audio", b"\x00\x00\x01\x00")

    response = client.get("/v1/sessions/call-1/audio/caller?preview=wav")

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    with wave.open(BytesIO(response.content)) as preview:
        assert preview.getnchannels() == 1
        assert preview.getframerate() == 16000
        assert preview.readframes(2) == b"\x00\x00\x01\x00"


def test_rejects_unplayable_pcm_metadata(client):
    create(client, "call-1", audio={"caller": {"encoding": "pcm_s16le"}})
    upload(client, "call-1", "caller.audio", b"\x00\x00")

    response = client.get("/v1/sessions/call-1/audio/caller?preview=wav")

    assert response.status_code == 422


def test_rejects_unsupported_audio_encoding(client):
    create(client, "call-1", audio={"caller": {"encoding": "opus", "sample_rate_hz": 16000, "channels": 1}})
    upload(client, "call-1", "caller.audio", b"bytes")

    response = client.get("/v1/sessions/call-1/audio/caller?preview=wav")

    assert response.status_code == 415


def test_advertises_range_support_for_full_previews(client):
    audio = {"caller": {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}}
    create(client, "call-1", audio=audio)
    upload(client, "call-1", "caller.audio", b"\x00\x00\x01\x00")

    response = client.get("/v1/sessions/call-1/audio/caller?preview=wav")

    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == str(44 + 4)


def test_serves_partial_content_for_range_requests(client):
    """Safari refuses to play media unless the server honours Range requests."""
    audio = {"caller": {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}}
    create(client, "call-1", audio=audio)
    upload(client, "call-1", "caller.audio", b"\x00\x00\x01\x00")
    full = client.get("/v1/sessions/call-1/audio/caller?preview=wav").content

    probe = client.get("/v1/sessions/call-1/audio/caller?preview=wav", headers={"Range": "bytes=0-1"})
    tail = client.get("/v1/sessions/call-1/audio/caller?preview=wav", headers={"Range": "bytes=44-"})

    assert probe.status_code == 206
    assert probe.headers["content-range"] == f"bytes 0-1/{len(full)}"
    assert probe.content == full[:2]
    assert tail.status_code == 206
    assert tail.content == b"\x00\x00\x01\x00"


def test_rejects_unsatisfiable_ranges(client):
    audio = {"caller": {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}}
    create(client, "call-1", audio=audio)
    upload(client, "call-1", "caller.audio", b"\x00\x00\x01\x00")

    response = client.get("/v1/sessions/call-1/audio/caller?preview=wav", headers={"Range": "bytes=9999-"})

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */48"


def test_renders_equal_length_timeline_tracks_and_a_combined_track(client):
    audio = {
        "caller": {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 1000, "channels": 1},
        "agent": {"file": "agent.audio", "encoding": "pcm_s16le", "sample_rate_hz": 1000, "channels": 1},
    }
    create(client, "call-1", audio=audio, duration_ms=10)
    upload(client, "call-1", "caller.audio", struct.pack("<h", 1000))
    upload(client, "call-1", "agent.audio", struct.pack("<h", 2000))
    upload(
        client,
        "call-1",
        "events.jsonl",
        b'{"kind":"audio_chunk","track":"caller","occurred_at_ms":0,"byte_length":2}\n'
        b'{"kind":"audio_chunk","track":"agent","occurred_at_ms":5,"byte_length":2}\n',
    )

    caller = client.get("/v1/sessions/call-1/audio/caller?preview=wav").content
    agent = client.get("/v1/sessions/call-1/audio/agent?preview=wav").content
    mixed = client.get("/v1/sessions/call-1/audio/mixed?preview=wav").content
    with wave.open(BytesIO(caller)) as decoded_caller, wave.open(BytesIO(agent)) as decoded_agent, wave.open(BytesIO(mixed)) as decoded_mixed:
        assert [decoded_caller.getnframes(), decoded_agent.getnframes(), decoded_mixed.getnframes()] == [10, 10, 10]
        caller_samples = struct.unpack("<10h", decoded_caller.readframes(10))
        agent_samples = struct.unpack("<10h", decoded_agent.readframes(10))
        mixed_samples = struct.unpack("<10h", decoded_mixed.readframes(10))
    assert caller_samples[0] == mixed_samples[0] == 1000
    assert agent_samples[5] == mixed_samples[5] == 2000
