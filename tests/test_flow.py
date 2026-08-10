"""End-to-end coverage of the SDK's create -> upload -> complete -> read flow."""

from __future__ import annotations

import io
import struct
import wave

from conftest import jsonl, manifest, object_info, operation


AUDIO = {
    "call": {
        "file": "call.audio",
        "encoding": "pcm_s16le",
        "sample_rate_hz": 24000,
        "channels": 2,
        "channel_layout": {"left": "agent", "right": "caller"},
    },
}


def test_full_ingestion_flow(client):
    call = struct.pack("<4h", 3000, 1000, 4000, 2000)
    events = jsonl(
        operation(event_id="stt-1", type_="stt", started_at_ms=0),
        operation(event_id="llm-1", type_="llm", started_at_ms=40),
        operation(event_id="tts-1", type_="tts", started_at_ms=90),
        {"kind": "audio_chunk", "session_id": "call-1", "track": "caller", "byte_length": 4},
    )

    created = client.post(
        "/v1/sessions",
        json=manifest("call-1", audio=AUDIO),
        headers={"idempotency-key": "call-1"},
    )
    assert created.status_code == 201
    urls = created.json()["upload_urls"]

    for name, payload in {"events.jsonl": events, "call.audio": call}.items():
        path = urls[name].split("http://testserver", 1)[1]
        assert client.put(path, content=payload).status_code == 204

    completed = client.post(
        "/v1/sessions/call-1/complete",
        json={
            "objects": {
                "events.jsonl": object_info(events),
                "call.audio": object_info(call),
            }
        },
        headers={"idempotency-key": "call-1"},
    )
    assert completed.status_code == 202
    assert completed.json() == {"session_id": "call-1", "status": "ready", "operation_count": 3, "duration_ms": 4200}

    detail = client.get("/v1/sessions/call-1").json()
    assert detail["status"] == "ready"
    assert [op["type"] for op in detail["operations"]] == ["stt", "llm", "tts"]
    assert {item["track"]: item["size_bytes"] for item in detail["recordings"]} == {"call": 8}

    downloaded = client.get("/v1/sessions/call-1/audio/call")
    assert downloaded.content == call
    stereo = client.get("/v1/sessions/call-1/audio/call", params={"preview": "wav"})
    with wave.open(io.BytesIO(stereo.content)) as reader:
        assert reader.getnchannels() == 2
        assert reader.readframes(reader.getnframes()) == call
    preview = client.get("/v1/sessions/call-1/audio/caller", params={"preview": "wav"})
    assert preview.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(preview.content)) as reader:
        assert reader.getframerate() == 24000
        assert struct.unpack("<2h", reader.readframes(reader.getnframes())) == (1000, 2000)

    assert client.get("/v1/sessions").json()[0]["status"] == "ready"


def test_replaying_the_whole_flow_is_safe(client):
    events = jsonl(operation(event_id="llm-1"))
    for _ in range(2):
        assert client.post("/v1/sessions", json=manifest("call-1")).status_code == 201
        assert client.put("/v1/uploads/call-1/events.jsonl", content=events).status_code == 204
        assert client.post(
            "/v1/sessions/call-1/complete",
            json={"objects": {"events.jsonl": object_info(events)}},
        ).json()["operation_count"] == 1

    assert len(client.get("/v1/sessions").json()) == 1
    assert len(client.get("/v1/sessions/call-1").json()["operations"]) == 1


def test_two_sessions_do_not_share_operations_or_audio(client):
    for session_id in ("call-1", "call-2"):
        events = jsonl(operation(session_id=session_id, event_id=f"op-{session_id}"))
        client.post("/v1/sessions", json=manifest(session_id, audio={"call": AUDIO["call"]}))
        client.put(f"/v1/uploads/{session_id}/events.jsonl", content=events)
        payload = struct.pack("<2h", 0, int(session_id[-1]))
        client.put(f"/v1/uploads/{session_id}/call.audio", content=payload)
        client.post(f"/v1/sessions/{session_id}/complete", json={"objects": {"events.jsonl": object_info(events)}})

    for session_id in ("call-1", "call-2"):
        detail = client.get(f"/v1/sessions/{session_id}").json()
        assert [op["event_id"] for op in detail["operations"]] == [f"op-{session_id}"]
        preview = client.get(f"/v1/sessions/{session_id}/audio/caller", params={"preview": "wav"})
        with wave.open(io.BytesIO(preview.content)) as reader:
            assert struct.unpack("<h", reader.readframes(reader.getnframes())) == (int(session_id[-1]),)


def test_a_partial_upload_keeps_the_session_uploading(client):
    client.post("/v1/sessions", json=manifest("call-1", audio=AUDIO))
    client.put("/v1/uploads/call-1/call.audio", content=b"\x01")
    assert client.get("/v1/sessions/call-1").json()["status"] == "uploading"
    response = client.post(
        "/v1/sessions/call-1/complete",
        json={"objects": {"call.audio": object_info(b"\x01"), "events.jsonl": object_info(b"\x02")}},
    )
    assert response.status_code == 400
    assert client.get("/v1/sessions/call-1").json()["status"] == "uploading"
