"""Unit tests for the module level helpers that back the HTTP layer."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime

import pytest
from fastapi import HTTPException

from conftest import jsonl, operation


def test_now_returns_an_iso_utc_timestamp(api):
    value = api.now()
    parsed = datetime.fromisoformat(value)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset().total_seconds() == 0


def test_initialize_is_idempotent(api, data_dir):
    api.initialize()
    api.initialize()
    assert (data_dir / "objects").is_dir()
    with api.connect() as db:
        tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"sessions", "operations"} <= tables


def test_connect_commits_and_closes(api, data_dir):
    with api.connect() as db:
        db.execute("INSERT INTO sessions VALUES ('a', '{}', 'uploading', 'now', 'now', NULL)")
    with api.connect() as db:
        assert db.execute("SELECT COUNT(*) AS total FROM sessions").fetchone()["total"] == 1


def test_connect_closes_the_connection_on_error(api, data_dir):
    with pytest.raises(sqlite3.OperationalError):
        with api.connect() as db:
            db.execute("SELECT * FROM does_not_exist")


def test_safe_session_dir_accepts_a_plain_id(api, data_dir):
    assert api.safe_session_dir("call-1") == api.OBJECTS / "call-1"


@pytest.mark.parametrize("session_id", ["..", "../evil", "a/b", ".", "", "dir/"])
def test_safe_session_dir_rejects_anything_that_is_not_a_bare_name(api, session_id):
    with pytest.raises(HTTPException) as error:
        api.safe_session_dir(session_id)
    assert error.value.status_code == 400
    assert error.value.detail == "Invalid session id"


def test_require_session_raises_for_an_unknown_id(api, data_dir):
    with pytest.raises(HTTPException) as error:
        api.require_session("missing")
    assert error.value.status_code == 404


def test_import_operations_returns_empty_when_the_file_is_absent(api, data_dir):
    assert api.import_operations("call-1") == []


def write_events(api, session_id: str, payload: bytes) -> None:
    directory = api.OBJECTS / session_id
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "events.jsonl").write_bytes(payload)


def test_import_operations_keeps_only_well_formed_matching_operations(api, data_dir):
    write_events(
        api,
        "call-1",
        jsonl(
            operation(event_id="keep-llm", type_="llm"),
            operation(event_id="keep-stt", type_="stt"),
            operation(event_id="keep-tts", type_="tts"),
            operation(event_id="wrong-session", session_id="call-2"),
            operation(event_id="wrong-type", type_="websocket"),
            {"event_id": "no-type", "session_id": "call-1"},
            {"session_id": "call-1", "type": "llm"},
            {"kind": "audio_chunk", "session_id": "call-1"},
        ),
    )
    assert [op["event_id"] for op in api.import_operations("call-1")] == ["keep-llm", "keep-stt", "keep-tts"]


def test_import_operations_preserves_input_order(api, data_dir):
    write_events(api, "call-1", jsonl(operation(event_id="b", started_at_ms=90), operation(event_id="a", started_at_ms=1)))
    assert [op["event_id"] for op in api.import_operations("call-1")] == ["b", "a"]


def test_import_operations_reports_the_offending_line_number(api, data_dir):
    write_events(api, "call-1", jsonl(operation(), operation(event_id="op-2")) + b"oops\n")
    with pytest.raises(HTTPException) as error:
        api.import_operations("call-1")
    assert error.value.status_code == 400
    assert error.value.detail == "Invalid events.jsonl on line 3"


def test_import_operations_accepts_an_empty_file(api, data_dir):
    write_events(api, "call-1", b"")
    assert api.import_operations("call-1") == []


def test_recordings_reports_uploaded_state_and_size(api, data_dir):
    directory = api.OBJECTS / "call-1"
    directory.mkdir(parents=True)
    (directory / "caller.audio").write_bytes(b"1234")
    result = api.recordings("call-1", {"audio": {"caller": {"file": "caller.audio", "channels": 1}, "agent": {"file": "agent.audio"}}})
    assert result == [
        {"track": "caller", "uploaded": True, "size_bytes": 4, "file": "caller.audio", "channels": 1},
        {"track": "agent", "uploaded": False, "size_bytes": 0, "file": "agent.audio"},
    ]


def test_recordings_is_empty_without_an_audio_block(api, data_dir):
    assert api.recordings("call-1", {}) == []


def test_session_summary_reads_manifest_fields_from_the_row(api, data_dir):
    payload = {"agent_id": "support", "duration_ms": 12, "outcome": "completed", "started_at": "2026-01-01T00:00:00+00:00"}
    with api.connect() as db:
        db.execute("INSERT INTO sessions VALUES ('call-1', ?, 'ready', 'created', 'updated', 'done')", (json.dumps(payload),))
        row = db.execute("SELECT * FROM sessions WHERE id = 'call-1'").fetchone()
    assert api.session_summary(row) == {
        "id": "call-1",
        "agent_id": "support",
        "duration_ms": 12,
        "outcome": "completed",
        "status": "ready",
        "started_at": "2026-01-01T00:00:00+00:00",
        "created_at": "created",
    }


def test_session_summary_defaults_a_missing_duration_to_zero(api, data_dir):
    with api.connect() as db:
        db.execute("INSERT INTO sessions VALUES ('call-1', '{}', 'uploading', 'created', 'updated', NULL)")
        row = db.execute("SELECT * FROM sessions WHERE id = 'call-1'").fetchone()
    summary = api.session_summary(row)
    assert summary["duration_ms"] == 0
    assert summary["agent_id"] is None
    assert summary["outcome"] is None


def test_object_allow_list_matches_the_sdk_package_layout(api):
    assert api.ALLOWED_OBJECTS == {"events.jsonl", "call.audio", "caller.audio", "agent.audio"}
    assert api.MAX_UPLOAD_BYTES == 128 * 1024 * 1024


# ------------------------------------------------- LLM call de-duplication


def _llm(event_id: str, started: int, ended: int, **extra) -> dict:
    op = operation(event_id=event_id, type_="llm", started_at_ms=started, turn_id="turn-1", **extra)
    op["ended_at_ms"] = ended
    op["duration_ms"] = ended - started
    return op


def test_a_model_call_recorded_by_both_the_framework_and_the_transport_counts_once(api):
    """The framework span and the HTTP request that served it are one call, not two."""
    framework = _llm("fw", 39914, 46907, response={"total_tokens": 6587, "ttft_ms": 6954})
    transport = _llm("http", 39916, 46691, response={"status": 200, "body": {"_truncated": True}})
    turn = api.group_turns([framework, transport])[0]
    assert turn["llm_calls"] == 1
    assert turn["llm_ms"] == 6993
    # The transport span still has to be reachable: it is the only place the
    # request body was captured.
    assert len(turn["operations"]) == 2


def test_the_retries_a_framework_span_covers_do_not_inflate_the_call_count(api):
    framework = _llm("fw", 51299, 72466, response={"total_tokens": 7159})
    attempt = _llm("a1", 51302, 61990, status="error", response={})
    retry = _llm("a2", 62103, 72051, response={"status": 200})
    turn = api.group_turns([framework, attempt, retry])[0]
    assert turn["llm_calls"] == 1
    assert turn["llm_ms"] == 21167


def test_an_attempt_no_framework_span_covers_is_still_its_own_call(api):
    """A call that only ever failed emits no metrics, so the HTTP span is all there is."""
    framework = _llm("fw", 92968, 101370, response={"total_tokens": 7079})
    covered = _llm("a1", 92971, 101054, response={"status": 200})
    orphan = _llm("a2", 101379, 112043, status="error", response={})
    turn = api.group_turns([framework, covered, orphan])[0]
    assert turn["llm_calls"] == 2


def test_turns_without_framework_metrics_keep_every_transport_span(api):
    only_http = [
        _llm("a1", 100, 200, status="error", response={}),
        _llm("a2", 300, 400, status="error", response={}),
    ]
    assert api.group_turns(only_http)[0]["llm_calls"] == 2


def test_model_time_can_never_exceed_the_turn_it_happened_in(api):
    """The bug this guards: summing both span classes reported more model time than the turn lasted."""
    ops = [
        _llm("fw", 0, 7000, response={"total_tokens": 10}),
        _llm("http", 2, 6800, response={"status": 200}),
    ]
    turn = api.group_turns(ops)[0]
    assert turn["llm_ms"] <= turn["duration_ms"]


def _stt(ended: int, turn: str = "turn-1") -> dict:
    op = operation(event_id=f"stt-{turn}", type_="stt", started_at_ms=0, turn_id=turn)
    op["ended_at_ms"] = ended
    return op


def _tts(started: int, ended: int, turn: str = "turn-1", **extra) -> dict:
    op = operation(event_id=f"tts-{turn}", type_="tts", started_at_ms=started, turn_id=turn, **extra)
    op["ended_at_ms"] = ended
    op["duration_ms"] = ended - started
    return op


def test_first_audio_falls_back_to_the_agent_track_when_the_span_lacks_the_milestone(api):
    """The bug this guards: the headline response KPIs were blank on every real call.

    The SDK stamped the `audio_chunk` milestone only when the TTS span already
    existed, but the frames are synthesized before the metrics that open it, so
    the milestone was never written and `time_to_first_audio_ms` was always None.
    """
    ops = [_stt(13941), _tts(21187, 23516)]
    assert api.group_turns(ops)[0]["time_to_first_audio_ms"] is None
    turn = api.group_turns(ops, [634.0, 21438.0, 21458.0, 50557.0])[0]
    assert turn["time_to_first_audio_ms"] == 21438 - 13941


def test_the_milestone_still_wins_over_the_agent_track(api):
    ops = [
        _stt(1000),
        _tts(2000, 3000, milestones={"audio_chunk": {"occurred_at_ms": 2100}}),
    ]
    turn = api.group_turns(ops, [2500.0])[0]
    assert turn["time_to_first_audio_ms"] == 1100


def test_a_turn_whose_reply_never_came_does_not_claim_the_next_turns_audio(api):
    """A turn with no TTS span produced no audio; borrowing the next reply's
    first frame would report a wait the caller never experienced."""
    ops = [_stt(60884, "turn-4"), _stt(63491, "turn-5"), _tts(70778, 74067, "turn-5")]
    turns = {turn["turn_id"]: turn for turn in api.group_turns(ops, [71056.0])}
    assert turns["turn-4"]["time_to_first_audio_ms"] is None
    assert turns["turn-5"]["time_to_first_audio_ms"] == 71056 - 63491


def test_audio_that_precedes_the_speech_mark_is_not_a_negative_wait(api):
    """Agent audio still playing when the caller stopped is the previous reply,
    not an instantaneous one; it must not report a negative response time."""
    ops = [_stt(5000), _tts(1000, 8000)]
    assert api.group_turns(ops, [1200.0])[0]["time_to_first_audio_ms"] is None


def test_presentation_windows_prefer_real_speech_and_tts_pcm_playout(api):
    stt = _stt(15000, "turn-3")
    stt["response"] = {"words": [{"text": "hello", "start_ms": 20368, "end_ms": 20800}]}
    stt["milestones"] = {"speech_started": {"occurred_at_ms": 11959}, "speech_ended": {"occurred_at_ms": 21100}}
    tts = _tts(12000, 15444, "turn-2", response={"audio_ms": 7120})
    tts["event_id"] = "tts-2"
    api.attach_presentation_windows([stt, tts], [
        {"kind": "audio_chunk", "track": "agent", "operation_id": "tts-2", "playout_at_ms": 12226, "duration_ms": 7120},
    ])
    assert stt["presentation_window"] == {
        "from_ms": 20368, "to_ms": 20800, "track": "caller", "kind": "speech", "source": "word_timestamps", "confidence": "observed",
        "provider_span": {"from_ms": 0, "to_ms": 15000},
    }
    assert tts["presentation_window"]["from_ms"] == 12226
    assert tts["presentation_window"]["to_ms"] == 19346
    assert tts["presentation_window"]["confidence"] == "exact"


def test_tts_presentation_fallback_uses_pcm_duration_not_provider_completion(api):
    tts = _tts(12000, 15444, response={"audio_ms": 7120}, milestones={"audio_chunk": {"occurred_at_ms": 12226, "last_at_ms": 15444}})
    api.attach_presentation_windows([tts], [])
    assert tts["presentation_window"]["to_ms"] == 19346
    assert tts["presentation_window"]["source"] == "inferred_response_audio_duration"


def test_attributed_tts_keeps_disjoint_playout_segments(api):
    tts = _tts(100, 500, response={"audio_ms": 300})
    api.attach_presentation_windows([tts], [
        {"kind": "audio_chunk", "track": "agent", "operation_id": tts["event_id"], "playout_at_ms": 200, "duration_ms": 100},
        {"kind": "audio_chunk", "track": "agent", "operation_id": tts["event_id"], "playout_at_ms": 600, "duration_ms": 200},
    ])
    window = tts["presentation_window"]
    assert window["segments"] == [{"from_ms": 200, "to_ms": 300}, {"from_ms": 600, "to_ms": 800}]
    assert (window["from_ms"], window["to_ms"]) == (200, 800)


def test_a_turn_the_agent_declined_to_answer_says_so(api):
    """A turn with a transcript, a real model bill and no speech out is not
    self-explanatory. It is either an agent that deliberately ignored the
    caller or a TTS that never sounded -- one is a product decision, the other
    is an incident, and an operator cannot act on the number without knowing
    which. The SDK records the difference, so the timeline must carry it."""
    heard = operation(event_id="stt-1", type_="stt", started_at_ms=100, turn_id="turn-1",
                      response={"transcript": "what is the baggage allowance",
                                "reply_skipped": "stop_response"})
    billed = _llm("http", 200, 900, response={"total_tokens": 429})
    turn = api.group_turns([heard, billed])[0]
    assert turn["reply_skipped"] == "stop_response"
    assert turn["audible_tts_ms"] is None
    assert turn["llm_calls"] == 1, "the tokens were really spent, so they are really billed"


def test_an_ordinary_unanswered_turn_is_not_labelled_as_declined(api):
    """The label has to mean something: it must come from the agent saying so,
    not from the absence of a reply, or it would excuse every silent failure."""
    heard = operation(event_id="stt-2", type_="stt", started_at_ms=100, turn_id="turn-1",
                      response={"transcript": "hello"})
    assert api.group_turns([heard])[0]["reply_skipped"] is None


def test_a_crashed_turn_callback_is_not_reported_as_a_decision(api):
    """An agent that *chose* not to answer and one whose callback raised look
    identical in the numbers, and LiveKit swallows the exception either way.
    One is a product decision, the other is an outage, so the reason has to
    survive to the timeline rather than being flattened to "no reply"."""
    heard = operation(event_id="stt-3", type_="stt", started_at_ms=100, turn_id="turn-1",
                      response={"transcript": "is my card blocked",
                                "reply_skipped": "callback_error"})
    assert api.group_turns([heard])[0]["reply_skipped"] == "callback_error"


def test_a_split_turn_carries_the_link_back_to_the_half_it_continues(api):
    """Two turns, one message. The reader has to be able to tell.

    The SDK splits a caller's utterance only when merging would drop words, and
    it says so. If we drop that on the floor here, the dashboard shows two
    ordinary turns -- one of which looks like a caller talking to an agent that
    never answered -- and every per-turn average is computed over halves.
    """
    turns = api.group_turns([
        operation(turn_id="turn-1", type="stt",
                  response={"transcript": "Thanks."}),
        operation(turn_id="turn-2", type="stt",
                  response={"transcript": "That is all I needed.",
                            "continues_turn": "turn-1",
                            "split_reason": "earlier_words_already_published"}),
    ])
    by_id = {t["turn_id"]: t for t in turns}
    assert by_id["turn-2"]["continues_turn"] == "turn-1"
    # And an ordinary turn must not be labelled as anyone's continuation.
    assert by_id["turn-1"].get("continues_turn") is None


def test_a_crashed_turn_callback_is_an_incident_not_a_quiet_turn(api):
    """LiveKit swallows the exception, so nothing else will ever say this failed.

    No operation reports an error -- the agent simply never replied -- so the
    turn renders green and the call stays `ready`. An agent whose turn callback
    is throwing on every call is then indistinguishable, on this page, from one
    having a quiet minute. The recorded reason is the only evidence there is.
    """
    crashed = api.group_turns([
        operation(turn_id="turn-1", type="stt", status="ok",
                  response={"transcript": "What is the fare?",
                            "reply_skipped": "callback_error"}),
    ])[0]
    assert crashed["status"] == "error"

    # A deliberate decline is the opposite case and must stay green: it needs no
    # response, and treating it as an incident trains operators to ignore both.
    declined = api.group_turns([
        operation(turn_id="turn-2", type="stt", status="ok",
                  response={"transcript": "Ignore me.",
                            "reply_skipped": "stop_response"}),
    ])[0]
    assert declined["status"] == "ok"
