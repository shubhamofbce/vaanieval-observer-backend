"""Waveform peaks, the summary the browser draws instead of decoding megabytes."""

from __future__ import annotations

import struct

from conftest import create, upload


def _stereo(client, frames):
    audio = {
        "call": {
            "file": "call.audio",
            "encoding": "pcm_s16le",
            "sample_rate_hz": 24000,
            "channels": 2,
            "channel_layout": {"left": "agent", "right": "caller"},
        }
    }
    create(client, "call-1", audio=audio)
    upload(client, "call-1", "call.audio", b"".join(struct.pack("<2h", *pair) for pair in frames))


def test_summarises_each_channel_under_its_speaker_name(client):
    # Two frames per bucket, at the smallest resolution the endpoint will serve.
    _stereo(client, [(3000, 100), (-9000, -200)] + [(1000, 50), (2000, 300)] * 31)

    peaks = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=32").json()

    assert [channel["name"] for channel in peaks["channels"]] == ["agent", "caller"]
    assert peaks["sample_rate_hz"] == 24000
    assert peaks["buckets"] == 32
    # A bucket reports the loudest excursion in it, so a transient never vanishes
    # between two quiet neighbours the way an average would let it.
    assert peaks["channels"][0]["peaks"][0] == 274
    assert peaks["channels"][0]["peaks"][1] == 61
    assert peaks["channels"][1]["peaks"][0] == 6
    assert peaks["channels"][1]["peaks"][1] == 9


def test_clamps_absurd_bucket_counts(client):
    _stereo(client, [(1000, 1000)] * 8)

    peaks = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=99999").json()

    assert peaks["buckets"] <= 4000
    assert len(peaks["channels"][0]["peaks"]) == peaks["buckets"]


def test_never_asks_for_more_buckets_than_there_are_frames(client):
    """A three-frame clip cannot fill 500 columns, and padding them would lie."""
    _stereo(client, [(1000, 500), (2000, 250), (300, 100)])

    peaks = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=500").json()

    assert peaks["buckets"] == 3
    assert len(peaks["channels"][0]["peaks"]) == 3


def test_reuses_the_cached_summary(client):
    """The second read comes off disk, because a recording never changes."""
    _stereo(client, [(1000, 500)] * 64)

    first = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=32")
    second = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=32")

    assert first.json() == second.json()


def test_summarises_a_mono_track_as_one_lane(client):
    audio = {"caller": {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}}
    create(client, "call-1", audio=audio)
    upload(client, "call-1", "caller.audio", struct.pack("<4h", 1000, -2000, 500, 100))

    peaks = client.get("/v1/sessions/call-1/audio/caller/peaks?buckets=32").json()

    assert [channel["name"] for channel in peaks["channels"]] == ["caller"]
    assert peaks["channels"][0]["peaks"] == [30, 61, 15, 3]


def test_refuses_a_session_that_does_not_exist(client):
    assert client.get("/v1/sessions/nobody/audio/call/peaks").status_code == 404


def test_forgets_the_summary_when_the_recording_is_replaced(client):
    """A session is browsable mid-upload, so peaks can describe a stale render."""
    _stereo(client, [(1000, 500)] * 64)
    before = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=32").json()

    upload(client, "call-1", "call.audio", b"".join(struct.pack("<2h", 9000, 9000) for _ in range(64)))
    after = client.get("/v1/sessions/call-1/audio/call/peaks?buckets=32").json()

    assert before["channels"][0]["peaks"] != after["channels"][0]["peaks"]
    assert after["channels"][0]["peaks"][0] == 274
