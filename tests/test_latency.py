from app.latency import (
    barge_in,
    challenger_stream_latency,
    production_turn_latency,
    response_budget,
    speech_window,
    turn_shape,
)

# Mirrors a real captured Deepgram turn: listening opens long before the caller
# actually speaks, so the word timestamps are the only true speech onset.
OPERATION = {
    "started_at_ms": 14078,
    "ended_at_ms": 27592,
    "milestones": {
        "speech_started": {"occurred_at_ms": 14078},
        "first_partial": {"occurred_at_ms": 25883},
        "speech_ended": {"occurred_at_ms": 27308},
        "final_transcript": {"occurred_at_ms": 27592},
    },
    "request": {"endpointing_ms": 300, "utterance_end_ms": 1000, "interim_results": True},
    "response": {
        "transcript": "Okay. Bengaluru.",
        "confidence": 0.94,
        "language": "en",
        "final_reason": "speech_final",
        "words": [
            {"text": "Okay.", "start_ms": 25218, "end_ms": 25938},
            {"text": "Bengaluru.", "start_ms": 25938, "end_ms": 26738},
        ],
    },
    "samples": {"partial": {"items": [{"occurred_at_ms": 25883, "transcript": "Okay."}], "truncated": False}},
}


def test_speech_window_prefers_word_timestamps_over_the_listening_window():
    window = speech_window(OPERATION)
    assert window["start_ms"] == 25218
    assert window["end_ms"] == 26738
    assert window["listen_start_ms"] == 14078
    assert window["declared_end_ms"] == 27308
    assert window["from_word_timestamps"] is True


def test_speech_window_falls_back_to_milestones_without_words():
    operation = {**OPERATION, "response": {"transcript": "hi"}}
    window = speech_window(operation)
    assert window["start_ms"] == 14078
    assert window["end_ms"] == 27308
    assert window["from_word_timestamps"] is False


def test_first_partial_is_measured_from_real_speech_onset():
    timing = production_turn_latency(OPERATION, {})
    # 25883 - 25218, not 25883 - 14078.
    assert timing["time_to_first_partial_ms"] == 665


def test_endpoint_delay_is_measured_from_the_declared_end_of_speech():
    timing = production_turn_latency(OPERATION, {})
    assert timing["endpoint_delay_ms"] == 284
    assert timing["threshold_gap_ms"] == 284 - 300


def test_endpoint_position_error_is_positive_when_the_turn_is_declared_late():
    timing = production_turn_latency(OPERATION, {})
    assert timing["endpoint_position_error_ms"] == 27308 - 26738


def test_missing_final_is_reported_rather_than_defaulted():
    operation = {**OPERATION, "milestones": {"speech_started": {"occurred_at_ms": 1}}}
    timing = production_turn_latency(operation, {})
    assert timing["missing_final"] is True
    assert timing["endpoint_delay_ms"] is None


def test_turn_shape_only_flags_errors_beyond_the_tolerance():
    latencies = {
        "1": {"endpoint_position_error_ms": 200, "missing_final": False, "is_turn_final": True, "forced_flush": False},
        "2": {"endpoint_position_error_ms": 4000, "missing_final": False, "is_turn_final": True, "forced_flush": False},
        "3": {"endpoint_position_error_ms": -3000, "missing_final": False, "is_turn_final": True, "forced_flush": False},
    }
    shape = turn_shape([], latencies)
    assert shape["late_turn_ids"] == ["2"]
    assert shape["premature_turn_ids"] == ["3"]
    assert shape["split_or_merged_count"] == 2


def test_barge_in_ignores_short_boundary_overlap():
    events = [{"kind": "audio_chunk", "track": "agent", "occurred_at_ms": 1000, "duration_ms": 40}]
    windows = [{"turn_id": "1", "start_ms": 1020, "end_ms": 4000}]
    assert barge_in(events, windows)["count"] == 0


def test_barge_in_counts_a_real_overlap():
    events = [{"kind": "audio_chunk", "track": "agent", "occurred_at_ms": start, "duration_ms": 40} for start in range(1000, 3000, 40)]
    windows = [{"turn_id": "1", "start_ms": 1500, "end_ms": 4000}]
    result = barge_in(events, windows)
    assert result["count"] == 1
    assert result["turns"][0]["overlap_ms"] >= 300


def test_barge_in_does_not_merge_across_real_silence():
    events = [
        {"kind": "audio_chunk", "track": "agent", "occurred_at_ms": 0, "duration_ms": 40},
        {"kind": "audio_chunk", "track": "agent", "occurred_at_ms": 9000, "duration_ms": 40},
    ]
    assert barge_in(events, [])["agent_span_count"] == 2


def test_challenger_stream_latency_is_unavailable_without_receipts():
    result = challenger_stream_latency({"timing": {"receipts": []}}, [])
    assert result["available"] is False
    assert result["reason"] == "no_streaming_receipts"


def test_challenger_stream_latency_matches_a_commit_to_its_turn():
    run = {
        "timing": {
            "receipts": [
                {"kind": "partial_transcript", "at_ms": 5300, "text": "hello"},
                {"kind": "committed_transcript_with_timestamps", "at_ms": 6100, "text": "hello there"},
            ],
            "commits": [{"at_ms": 6100, "audio_start_ms": 5000, "audio_end_ms": 5800, "text": "hello there"}],
        }
    }
    windows = [{"turn_id": "1", "start_ms": 5000, "end_ms": 5800}]
    result = challenger_stream_latency(run, windows)
    turn = result["turns"]["1"]
    assert turn["time_to_first_partial_ms"] == 300
    assert turn["endpoint_delay_ms"] == 300
    assert turn["endpoint_position_error_ms"] == 0
    assert turn["missing_final"] is False


def test_challenger_commit_is_not_reused_across_turns():
    run = {
        "timing": {
            "receipts": [{"kind": "committed_transcript_with_timestamps", "at_ms": 6100, "text": "hello"}],
            "commits": [{"at_ms": 6100, "audio_start_ms": 5000, "audio_end_ms": 5800, "text": "hello"}],
        }
    }
    windows = [
        {"turn_id": "1", "start_ms": 5000, "end_ms": 5800},
        {"turn_id": "2", "start_ms": 5900, "end_ms": 6200},
    ]
    turns = challenger_stream_latency(run, windows)["turns"]
    assert turns["1"]["missing_final"] is False
    assert turns["2"]["missing_final"] is True


def test_response_budget_counterfactual_swaps_only_the_stt_segment():
    production = {"1": {"endpoint_delay_ms": 600, "llm_ms": 400, "tts_ms": 200, "caller_wait_ms": 1200}}
    challenger = {"1": {"endpoint_delay_ms": 500}}
    budget = response_budget(production, challenger)
    assert budget["turns"]["1"]["counterfactual_wait_ms"] == 1100
    assert budget["turns"]["1"]["stt_share"] == 600 / 1200
    assert budget["counterfactual_available"] is True


def test_response_budget_reports_no_counterfactual_without_a_challenger():
    production = {"1": {"endpoint_delay_ms": 600, "llm_ms": 400, "tts_ms": 200, "caller_wait_ms": 1200}}
    budget = response_budget(production, None)
    assert budget["counterfactual_available"] is False
    assert budget["turns"]["1"]["counterfactual_wait_ms"] is None


def test_challenger_first_partial_is_not_borrowed_from_the_next_turn():
    run = {
        "timing": {
            "receipts": [
                {"kind": "committed_transcript_with_timestamps", "at_ms": 5900, "text": "hello"},
                {"kind": "partial_transcript", "at_ms": 20000, "text": "much later"},
            ],
            "commits": [{"at_ms": 5900, "audio_start_ms": 5000, "audio_end_ms": 5800, "text": "hello"}],
        }
    }
    turn = challenger_stream_latency(run, [{"turn_id": "1", "start_ms": 5000, "end_ms": 5800}])["turns"]["1"]
    assert turn["time_to_first_partial_ms"] is None
    assert turn["partial_count"] == 0


def test_barge_in_without_agent_audio_is_unavailable_not_zero():
    result = barge_in([], [{"turn_id": "1", "start_ms": 0, "end_ms": 1000}])
    assert result["available"] is False
    assert result["reason"] == "no_agent_audio_events"
    assert result["count"] is None
    assert result["agent_speaking_ms"] is None


def test_barge_in_rejects_chunks_without_a_usable_duration():
    events = [{"kind": "audio_chunk", "track": "agent", "occurred_at_ms": 0}]
    result = barge_in(events, [])
    assert result["available"] is False
    assert result["reason"] == "no_usable_agent_chunk_durations"
    assert result["unusable_chunk_count"] == 1


def test_truncated_partial_history_does_not_report_revision_metrics():
    from app.latency import partial_revisions

    result = partial_revisions([{"transcript": "a"}, {"transcript": "a b"}], "a b c", truncated=True)
    assert result["available"] is False
    assert result["reason"] == "partial_history_truncated"
    assert result["revision_count"] is None
