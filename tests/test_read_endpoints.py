"""GET endpoints: session list, session detail, audio preview and the console shell."""

from __future__ import annotations

import io
import wave

import pytest

from conftest import create, jsonl, manifest, object_info, operation, upload


def test_health_reports_ok(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_serves_the_console_shell(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "<html" in response.text.lower()


def test_serves_static_assets(client):
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/assets/missing.js").status_code == 404


def test_lists_no_sessions_before_any_are_created(client):
    assert client.get("/v1/sessions").json() == []


def test_lists_sessions_newest_first(client):
    for index in range(3):
        create(client, f"call-{index}")
    assert [row["id"] for row in client.get("/v1/sessions").json()] == ["call-2", "call-1", "call-0"]


def test_summarizes_each_session_with_manifest_derived_fields(client):
    create(client, "call-1", outcome="failed", started_at="2026-02-01T10:00:00+00:00")
    summary = client.get("/v1/sessions").json()[0]
    assert summary == {
        "id": "call-1",
        "agent_id": "support",
        "duration_ms": 4200,
        "outcome": "failed",
        "status": "uploading",
        "started_at": "2026-02-01T10:00:00+00:00",
        "created_at": summary["created_at"],
        "turn_count": 0,
        "error_count": 0,
    }
    assert summary["created_at"].startswith("20")


def test_falls_back_to_defaults_for_a_sparse_manifest(client):
    client.post("/v1/sessions", json={"session_id": "call-min"})
    summary = client.get("/v1/sessions").json()[0]
    assert summary["agent_id"] is None
    assert summary["duration_ms"] is None
    assert summary["outcome"] == "unknown"
    assert summary["started_at"] is None


def test_counts_failed_operations_per_session_but_not_aborted_ones(client):
    create(client, "call-1")
    events = jsonl(
        operation(event_id="op-1"),
        operation(event_id="op-2", status="error", error={"name": "TypeError", "message": "boom"}),
        operation(event_id="op-3", status="error", error={"name": "HTTPError", "message": "502"}),
        # Barge-in stopped this one; the agent behaved correctly, so it is not a failure.
        operation(event_id="op-4", status="error", error={"name": "AbortError", "message": "aborted"}),
    )
    upload(client, "call-1", "events.jsonl", events)
    client.post("/v1/sessions/call-1/complete", json={"objects": {"events.jsonl": object_info(events)}})

    assert client.get("/v1/sessions").json()[0]["error_count"] == 2


def test_returns_404_for_an_unknown_session(client):
    assert client.get("/v1/sessions/missing").status_code == 404


def test_returns_the_manifest_and_an_empty_timeline_before_completion(client):
    create(client, "call-1")
    body = client.get("/v1/sessions/call-1").json()
    assert body["manifest"]["session_id"] == "call-1"
    assert body["manifest"]["metadata"] == {"env": "test"}
    assert body["operations"] == []
    assert body["recordings"] == []
    assert body["status"] == "uploading"


def test_returns_production_only_stt_evidence_without_inventing_a_challenger(client):
    create(client, "call-1")
    stt = operation(
        event_id="stt-1",
        type_="stt",
        started_at_ms=100,
        turn_id="4",
        scope="turn",
        endpoint_id="deepgram-stt",
        provider="deepgram",
        model="nova-3",
        milestones={
            "speech_started": {"occurred_at_ms": 100},
            "first_partial": {"occurred_at_ms": 380},
            "speech_ended": {"occurred_at_ms": 920},
            "final_transcript": {"occurred_at_ms": 1240},
        },
        request={"endpointing_ms": 300, "utterance_end_ms": 1000},
        response={"transcript": "Need help with a trip", "confidence": 0.94, "words": [{"text": "Need"}], "final_reason": "speech_final"},
        samples={"partial": {"items": [{"transcript": "Need"}, {"transcript": "Need help"}]}},
    )
    upload(client, "call-1", "events.jsonl", jsonl(stt))
    client.post("/v1/sessions/call-1/complete", json={"objects": {}})

    body = client.get("/v1/sessions/call-1/stt-evaluation").json()

    assert body["production"]["provider"] == "deepgram"
    assert body["production"]["model"] == "nova-3"
    assert body["production"]["model_recorded"] is True
    assert body["production"]["request"]["endpointing_ms"] == 300
    assert body["production"]["capabilities"]["confidence_scores"] is True
    assert body["challenger"] is None
    assert body["accuracy"]["available"] is False
    assert body["accuracy"]["reason"] == "no_challenger"
    assert body["accuracy"]["call_estimated_wer"] is None
    assert body["risk"]["available"] is False
    assert body["risk"]["reason"] == "no_challenger"
    assert body["coverage"]["call_turns"] == 1
    assert body["coverage"]["stt_turns"] == 1
    assert body["coverage"]["transcript_turns"] == 1
    assert body["latency"]["production"]["first_partial_ms"]["count"] == 1
    assert body["latency"]["production"]["first_partial_ms"]["p50"] == 280
    assert body["latency"]["production"]["endpoint_delay_ms"]["p50"] == 320
    assert body["latency"]["challenger"]["available"] is False
    assert body["turns"][0]["production"]["transcript"] == "Need help with a trip"
    assert body["turns"][0]["production"]["partial_count"] == 2
    assert body["turns"][0]["challenger"] is None


def test_queues_one_scribe_challenger_evaluation_and_reports_its_status(client, api, monkeypatch):
    from app import challenger

    create(client, "call-1")
    submitted = []
    monkeypatch.setattr(api.CHALLENGER_EXECUTOR, "submit", lambda fn, *args: submitted.append((fn, args)))
    monkeypatch.setattr(challenger, "load_api_key", lambda: None)

    started = client.post("/v1/sessions/call-1/challenger-evaluation", json={"model": "elevenlabs_scribe_v2"})
    assert started.status_code == 202
    body = started.json()
    assert body["status"] == "queued"
    assert body["label"] == "ElevenLabs Scribe v2"
    assert len(submitted) == 1

    repeated = client.post("/v1/sessions/call-1/challenger-evaluation", json={"model": "elevenlabs_scribe_v2"})
    assert repeated.status_code == 202
    assert repeated.json()["job_id"] == body["job_id"]
    assert len(submitted) == 1
    assert client.get("/v1/sessions/call-1/challenger-evaluation").json()["status"] == "queued"

    submitted[0][0](*submitted[0][1])
    failed = client.get("/v1/sessions/call-1/challenger-evaluation").json()
    assert failed["status"] == "failed"
    assert "ELEVENLABS_API_KEY" in failed["error"]


def test_rejects_an_unknown_challenger_model(client):
    create(client, "call-1")
    response = client.post("/v1/sessions/call-1/challenger-evaluation", json={"model": "not-a-model"})
    assert response.status_code == 422
    assert response.json()["detail"] == "Unsupported challenger model"


def test_orders_operations_by_start_time(client):
    create(client, "call-1")
    upload(
        client,
        "call-1",
        "events.jsonl",
        jsonl(
            operation(event_id="third", started_at_ms=300),
            operation(event_id="first", started_at_ms=10),
            operation(event_id="second", started_at_ms=120),
        ),
    )
    client.post("/v1/sessions/call-1/complete", json={"objects": {}})
    body = client.get("/v1/sessions/call-1").json()
    assert [op["event_id"] for op in body["operations"]] == ["first", "second", "third"]
    assert body["operations"][0]["duration_ms"] == 10


def test_reports_recordings_from_the_manifest_audio_block(client):
    audio = {
        "call": {
            "file": "call.audio",
            "encoding": "pcm_s16le",
            "sample_rate_hz": 24000,
            "channels": 2,
            "channel_layout": {"left": "agent", "right": "caller"},
        },
    }
    client.post("/v1/sessions", json=manifest("call-1", audio=audio))
    upload(client, "call-1", "call.audio", b"\x01\x02\x03\x04")
    recordings = {item["track"]: item for item in client.get("/v1/sessions/call-1").json()["recordings"]}
    assert recordings["call"]["uploaded"] is True
    assert recordings["call"]["size_bytes"] == 4
    assert recordings["call"]["sample_rate_hz"] == 24000
    assert recordings["call"]["channel_layout"] == {"left": "agent", "right": "caller"}


def test_defaults_the_recording_filename_when_the_manifest_omits_it(client):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": {"encoding": "pcm_s16le"}}))
    upload(client, "call-1", "caller.audio", b"\x01")
    recording = client.get("/v1/sessions/call-1").json()["recordings"][0]
    assert recording["uploaded"] is True
    assert recording["size_bytes"] == 1




PCM_AUDIO = {"file": "caller.audio", "encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}


def wav_of(response):
    with wave.open(io.BytesIO(response.content)) as reader:
        return {
            "channels": reader.getnchannels(),
            "sample_width": reader.getsampwidth(),
            "frame_rate": reader.getframerate(),
            "frames": reader.getnframes(),
            "data": reader.readframes(reader.getnframes()),
        }


def test_downloads_the_raw_track_by_default(client):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    upload(client, "call-1", "caller.audio", b"\x01\x02")
    response = client.get("/v1/sessions/call-1/audio/caller")
    assert response.status_code == 200
    assert response.content == b"\x01\x02"
    assert response.headers["content-type"] == "application/octet-stream"
    assert "caller.audio" in response.headers["content-disposition"]


def test_downloads_a_raw_track_even_without_manifest_audio_metadata(client):
    create(client, "call-1")
    upload(client, "call-1", "agent.audio", b"\x01\x02")
    assert client.get("/v1/sessions/call-1/audio/agent").content == b"\x01\x02"


def test_serves_an_empty_raw_track(client):
    create(client, "call-1")
    upload(client, "call-1", "caller.audio", b"")
    response = client.get("/v1/sessions/call-1/audio/caller")
    assert response.status_code == 200
    assert response.content == b""


def test_wraps_a_pcm_track_in_a_wav_container_on_request(client):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    payload = bytes([1, 2, 3, 4, 5, 6])
    upload(client, "call-1", "caller.audio", payload)
    response = client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["content-disposition"] == 'inline; filename="caller.wav"'
    assert wav_of(response) == {"channels": 1, "sample_width": 2, "frame_rate": 16000, "frames": 3, "data": payload}


def test_previews_each_track_with_its_own_format(client):
    audio = {"agent": {"file": "agent.audio", "encoding": "pcm_s16le", "sample_rate_hz": 24000, "channels": 2}}
    client.post("/v1/sessions", json=manifest("call-1", audio=audio))
    upload(client, "call-1", "agent.audio", bytes(8))
    decoded = wav_of(client.get("/v1/sessions/call-1/audio/agent", params={"preview": "wav"}))
    assert decoded["frame_rate"] == 24000
    assert decoded["channels"] == 2
    assert decoded["frames"] == 2


def test_previews_an_empty_track_as_a_valid_but_empty_wav(client):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    upload(client, "call-1", "caller.audio", b"")
    response = client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert response.status_code == 200
    assert wav_of(response)["frames"] == 0


def test_preview_leaves_the_stored_object_untouched(client, api):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    upload(client, "call-1", "caller.audio", b"\x01\x02")
    client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert (api.OBJECTS / "call-1" / "caller.audio").read_bytes() == b"\x01\x02"


def test_returns_404_when_the_track_was_not_uploaded(client):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    response = client.get("/v1/sessions/call-1/audio/caller")
    assert response.status_code == 404
    assert response.json()["detail"] == "Audio track not uploaded"


def test_returns_404_for_audio_of_an_unknown_session(client):
    assert client.get("/v1/sessions/missing/audio/caller").status_code == 404


def test_checks_upload_presence_before_the_encoding(client):
    create(client, "call-1")
    assert client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"}).status_code == 404


@pytest.mark.parametrize("audio", [{}, {"caller": {}}, {"caller": {"encoding": "opus", "sample_rate_hz": 16000, "channels": 1}}])
def test_refuses_to_preview_a_track_that_is_not_pcm_s16le(client, audio):
    client.post("/v1/sessions", json=manifest("call-1", audio=audio))
    upload(client, "call-1", "caller.audio", b"\x01\x02")
    response = client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert response.status_code == 415
    assert response.json()["detail"] == "Only pcm_s16le tracks can be previewed"
    assert client.get("/v1/sessions/call-1/audio/caller").status_code == 200, "raw download stays available"


@pytest.mark.parametrize(
    "overrides",
    [
        {"sample_rate_hz": 0},
        {"sample_rate_hz": -16000},
        {"sample_rate_hz": "16000"},
        {"sample_rate_hz": None},
        {"channels": 0},
        {"channels": -1},
        {"channels": None},
    ],
)
def test_rejects_a_preview_without_a_usable_sample_rate_or_channel_count(client, overrides):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO | overrides}))
    upload(client, "call-1", "caller.audio", b"\x01\x02")
    response = client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert response.status_code == 422
    assert response.json()["detail"] == "Audio track is missing a valid sample rate or channel count"


def test_preview_tolerates_a_trailing_partial_frame(client):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    upload(client, "call-1", "caller.audio", b"\x01\x02\x03")
    response = client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert response.status_code == 200
    assert wav_of(response)["frames"] == 1


@pytest.mark.parametrize("preview", ["mp3", "raw", ""])
def test_rejects_an_unsupported_preview_format(client, preview):
    client.post("/v1/sessions", json=manifest("call-1", audio={"caller": PCM_AUDIO}))
    upload(client, "call-1", "caller.audio", b"\x01\x02")
    assert client.get("/v1/sessions/call-1/audio/caller", params={"preview": preview}).status_code == 422


@pytest.mark.parametrize("track", ["Caller", "events"])
def test_rejects_an_unsupported_track_name(client, track):
    create(client, "call-1")
    assert client.get(f"/v1/sessions/call-1/audio/{track}").status_code == 422
