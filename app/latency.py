"""Turn-detection and latency measurement from recorded production evidence.

Production numbers come from stream milestones the SDK captured live. Challenger
numbers come from a recorded streaming replay. Where the challenger was only run
as a batch transcription, the streaming milestones genuinely do not exist and are
reported as unavailable rather than approximated from HTTP round-trip time.
"""

from __future__ import annotations

from typing import Any, Sequence

from app.evaluation import delta, overlap_ms, percentiles

# A finalization is treated as a real end-of-turn only for these reasons;
# segment_final is mid-utterance and must not be counted (latency plan).
TURN_FINAL_REASONS = {"speech_final", "utterance_end", "endpointing", "manual_flush", "timeout"}
FORCED_FLUSH_REASONS = {"manual_flush", "timeout", "forced_flush", "flush"}

# Agent chunk receipts arrive continuously inside one utterance; a gap longer
# than this means the agent genuinely stopped speaking.
AGENT_SPAN_GAP_MS = 200
# Overlap shorter than this is turn-boundary echo, not the caller interrupting.
MIN_BARGE_IN_MS = 300
# A recognizer may emit a word whose start sits marginally before its own
# `speech_started` marker; beyond this the two values are not on the same clock
# and their difference is arithmetic on unrelated numbers.
WORD_CLOCK_TOLERANCE_MS = 250
# Declaring a turn over more than this far from the caller's last word is a
# real turn-shape defect rather than normal endpointing hangover.
ENDPOINT_POSITION_TOLERANCE_MS = 1000
# How long after a turn's speech ends a streaming partial may still be counted
# as belonging to that turn when no commit bounded it.
PARTIAL_GRACE_MS = 2000


def milestone_ms(operation: dict[str, Any], *names: str) -> int | None:
    milestones = operation.get("milestones") or {}
    for name in names:
        item = milestones.get(name)
        if isinstance(item, dict) and isinstance(item.get("occurred_at_ms"), (int, float)):
            return round(item["occurred_at_ms"])
    return None


def repeated_milestone_last_ms(operation: dict[str, Any], *names: str) -> int | None:
    """The latest instant of a milestone that was recorded more than once.

    A repeated name merges in the package format, keeping the first
    `occurred_at_ms` and the latest `last_at_ms`. Reading only the first is right
    for a milestone that happens once and is reported once, and wrong for one the
    recogniser genuinely issued several times. Returns `None` unless a name was
    seen more than once, so a milestone reported a single time is never
    reinterpreted here.
    """
    milestones = operation.get("milestones") or {}
    seen: list[int] = []
    for name in names:
        item = milestones.get(name)
        if not isinstance(item, dict) or not isinstance(item.get("count"), int) or item["count"] < 2:
            continue
        last, first = item.get("last_at_ms"), item.get("occurred_at_ms")
        if isinstance(last, (int, float)) and isinstance(first, (int, float)) and last > first:
            seen.append(round(last))
    return max(seen) if seen else None


def has_milestone(operation: dict[str, Any], *names: str) -> bool:
    milestones = operation.get("milestones") or {}
    return any(
        isinstance(milestones.get(name), dict)
        and isinstance(milestones[name].get("occurred_at_ms"), (int, float))
        for name in names
    )


def milestone_detail(operation: dict[str, Any], name: str, field: str) -> Any:
    """An extra field the SDK attached to a milestone, such as the recogniser's
    own `transcription_delay_ms` on `end_of_utterance`."""
    item = (operation.get("milestones") or {}).get(name)
    return item.get(field) if isinstance(item, dict) else None


def independent_delta(later: Any, earlier: Any) -> int | None:
    """A gap between two instants, but only when they were observed separately.

    Half of the STT spans in a real capture stamp `speech_ended` and
    `final_transcript` from the same underlying framework event, so the two
    milestones exist, look independent, and are byte-identical. Subtracting them
    yields a confident-looking `0 ms` that says the recogniser finalised
    instantaneously — which is not something that happened, it is an artefact of
    how the recording was written. Two network-observed instants landing on the
    exact same millisecond is not a fast provider, it is one timestamp reported
    twice, so the honest answer is "not measured".
    """
    if later is None or earlier is None or later == earlier:
        return None
    return delta(later, earlier)


def capture_profile(operation: dict[str, Any]) -> dict[str, Any]:
    """What this capture actually recorded, independent of what it observed.

    Sessions come from different SDK builds. Some record the full transcript,
    word timestamps and a first-partial milestone; privacy-redacted builds record
    only a character count and a single `speech_final` milestone. Without this
    distinction an unrecorded transcript is indistinguishable from a recognizer
    that heard nothing, and the dashboard reports a total production failure
    where the real answer is "the capture did not include the text".
    """
    response = operation.get("response") if isinstance(operation.get("response"), dict) else {}
    transcript = response.get("transcript")
    words = response.get("words") or []
    return {
        "transcript_recorded": isinstance(transcript, str),
        "text_length_only": not isinstance(transcript, str) and isinstance(response.get("char_count"), int),
        "char_count": response.get("char_count") if isinstance(response.get("char_count"), int) else None,
        "words_recorded": bool(words),
        "partials_recorded": has_milestone(operation, "first_partial")
                             or bool(((operation.get("samples") or {}).get("partial") or {}).get("items")),
        "speech_end_recorded": has_milestone(operation, "speech_ended", "speech_end", "audio_ended"),
        "final_recorded": has_milestone(operation, "final_transcript"),
        "confidence_recorded": isinstance(response.get("confidence"), (int, float)),
    }


def word_bounds(operation: dict[str, Any]) -> tuple[int | None, int | None]:
    """First and last word timestamps on the call timeline, in milliseconds."""
    words = ((operation.get("response") or {}) if isinstance(operation.get("response"), dict) else {}).get("words") or []
    starts, ends = [], []
    for word in words:
        start, end = word.get("start_ms"), word.get("end_ms")
        if start is None and isinstance(word.get("start"), (int, float)):
            start = word["start"] * 1000
        if end is None and isinstance(word.get("end"), (int, float)):
            end = word["end"] * 1000
        if isinstance(start, (int, float)):
            starts.append(round(start))
        if isinstance(end, (int, float)):
            ends.append(round(end))
    return (min(starts) if starts else None, max(ends) if ends else None)


def speech_window(operation: dict[str, Any]) -> dict[str, Any]:
    """The canonical region where the caller actually spoke.

    `speech_started` marks when the recognizer opened its listening window, not
    when the caller began talking — on this data it can precede the first word by
    more than ten seconds. Word timestamps are the only evidence of real speech
    onset, so they define the region and the milestones are only a fallback.
    Every latency number is measured against this region so production and the
    challenger are scored on the same boundaries.
    """
    listen_start = milestone_ms(operation, "speech_started", "speech_start", "audio_started")
    declared_end = milestone_ms(operation, "speech_ended", "speech_end", "audio_ended")
    if listen_start is None:
        listen_start = operation.get("started_at_ms")
    if declared_end is None:
        declared_end = operation.get("ended_at_ms")
    # `speech_ended` comes from the voice activity detector, which ends the
    # window at the caller's first pause. When a provider delivers one message as
    # several finals, LiveKit merges them into a single committed turn and every
    # final after that pause is evidence the caller was still talking. Measured
    # on a real call: a three-final turn spanning 2975 ms reported 950 ms of
    # speech, a 68% undercount of the caller and, since replies are timed from
    # the end of this window, an equally wrong reply latency. A final arrives
    # after the audio it describes, so the recogniser's own transcription delay
    # is removed when it reported one rather than crediting the caller with it.
    late_final = repeated_milestone_last_ms(operation, "final_transcript", "speech_final")
    end_from_finals = False
    if late_final is not None:
        delay = milestone_detail(operation, "end_of_utterance", "transcription_delay_ms")
        spoke_until = late_final - delay if isinstance(delay, (int, float)) else late_final
        span_end = operation.get("ended_at_ms")
        if isinstance(span_end, (int, float)):
            spoke_until = min(spoke_until, span_end)
        if not isinstance(declared_end, (int, float)) or spoke_until > declared_end:
            declared_end, end_from_finals = round(spoke_until), True
    first_word, last_word = word_bounds(operation)
    # A word cannot begin before the recognizer opened its microphone. When it
    # appears to, the word timestamps are on a different time base than the
    # milestones (observed in production: every affected turn reported its first
    # word starting at ~6 s regardless of when the turn actually happened, while
    # the word END aligned with the recognizer clock). Subtracting a milestone
    # instant from a word-clock instant fabricated first-partial values of 4-9 s
    # and inflated the fleet P95 3.6x, so the word onset is rejected here and the
    # milestone is used instead.
    cross_clock = (
        first_word is not None
        and isinstance(listen_start, (int, float))
        and first_word < listen_start - WORD_CLOCK_TOLERANCE_MS
    )
    if cross_clock:
        first_word = None
    start = first_word if first_word is not None else listen_start
    end = last_word if last_word is not None else declared_end
    return {
        "start_ms": round(start) if isinstance(start, (int, float)) else None,
        "end_ms": round(end) if isinstance(end, (int, float)) else None,
        "listen_start_ms": round(listen_start) if isinstance(listen_start, (int, float)) else None,
        "declared_end_ms": round(declared_end) if isinstance(declared_end, (int, float)) else None,
        "from_word_timestamps": first_word is not None and last_word is not None,
        "word_clock_mismatch": cross_clock,
        "end_from_repeated_finals": end_from_finals and last_word is None,
    }



def production_turn_latency(operation: dict[str, Any], turn: dict[str, Any]) -> dict[str, Any]:
    """Per-turn production timing, each value measured or explicitly absent."""
    window = speech_window(operation)
    first_partial = milestone_ms(operation, "first_partial")
    first_stable = milestone_ms(operation, "first_stable_partial", "stable_partial")
    # The instant that closed the message. When one message arrived as several
    # finals, that is the last of them: pairing the FIRST final with an end of
    # speech that the later finals moved forward would report a negative
    # finalisation delay.
    final = repeated_milestone_last_ms(operation, "final_transcript", "speech_final")
    if final is None:
        final = milestone_ms(operation, "final_transcript", "speech_final")
    request = operation.get("request") or {}
    response = operation.get("response") if isinstance(operation.get("response"), dict) else {}
    samples = ((operation.get("samples") or {}).get("partial") or {})
    partials = samples.get("items") or []
    final_reason = response.get("final_reason")

    configured = request.get("endpointing_ms")
    speech_end = window["end_ms"]
    declared_end = window["declared_end_ms"]
    profile = capture_profile(operation)
    # Finalization is measured from the recognizer's own declared end of speech,
    # which is what the endpointing setting governs. It is only a measurement
    # when BOTH ends were genuinely recorded: a redacted capture carries a single
    # `speech_final` milestone, and falling back to the operation's own end time
    # makes both sides the same instant and reports a fabricated 0 ms.
    measurable_endpoint = profile["final_recorded"] and profile["speech_end_recorded"]
    # Both milestones can be written from the SAME framework event, in which case
    # they carry one timestamp twice and their difference is fabricated. The
    # recogniser's own `transcription_delay_ms` is an independent observation, so
    # prefer it; without it, say the value was not measured rather than claim a
    # finalisation that took no time at all.
    reported_delay = milestone_detail(operation, "end_of_utterance", "transcription_delay_ms")
    if measurable_endpoint:
        endpoint_delay = independent_delta(final, declared_end)
        if endpoint_delay is None:
            if isinstance(reported_delay, (int, float)):
                endpoint_delay = round(reported_delay)
            else:
                measurable_endpoint = False
    else:
        endpoint_delay = None
    words = response.get("words") or []

    return {
        "speech_start_ms": window["start_ms"],
        "speech_end_ms": speech_end,
        "listen_start_ms": window["listen_start_ms"],
        "declared_end_ms": declared_end,
        "region_from_word_timestamps": window["from_word_timestamps"],
        "first_partial_at_ms": first_partial,
        "first_stable_partial_at_ms": first_stable,
        "final_at_ms": final,
        "time_to_first_partial_ms": independent_delta(first_partial, window["start_ms"]),
        "time_to_first_stable_partial_ms": independent_delta(first_stable, window["start_ms"]),
        "endpoint_delay_ms": endpoint_delay,
        "speech_to_final_ms": delta(final, window["start_ms"]) if window["from_word_timestamps"] else None,
        "configured_endpointing_ms": configured if isinstance(configured, (int, float)) else None,
        "configured_utterance_end_ms": request.get("utterance_end_ms") if isinstance(request.get("utterance_end_ms"), (int, float)) else None,
        "threshold_gap_ms": (endpoint_delay - configured) if isinstance(endpoint_delay, (int, float)) and isinstance(configured, (int, float)) else None,
        "final_reason": final_reason,
        "is_turn_final": final_reason in TURN_FINAL_REASONS if final_reason else None,
        "forced_flush": final_reason in FORCED_FLUSH_REASONS if final_reason else False,
        "missing_final": final is None,
        "capture": profile,
        # The comparable finalisation metric. `endpoint_delay_ms` is measured from
        # the recogniser's OWN declared end of speech, which on this data lags the
        # caller's last word by 280-4960 ms of VAD hangover. The challenger is
        # measured from the last word, so comparing the two directly hands
        # production a free pass on its own hangover and can invert the result.
        # Measuring both from the caller's last word is the like-for-like view.
        "final_from_last_word_ms": (delta(final, speech_end)
                                    if window["from_word_timestamps"] and final is not None else None),
        "endpoint_measurable": measurable_endpoint,
        "endpoint_unmeasurable_reason": None if measurable_endpoint else (
            "speech_end_milestone_not_recorded" if not profile["speech_end_recorded"]
            else "final_transcript_milestone_not_recorded"
        ),
        "partial_count": len(partials),
        "partials_truncated": bool(samples.get("truncated")),
        "partial_revisions": partial_revisions(partials, response.get("transcript"), bool(samples.get("truncated"))),
        "result_audio_end_ms": speech_end,
        # Positive means the turn was declared over later than the caller's last
        # word; negative means the recognizer cut the caller off. This needs two
        # independent sources - word timestamps for the last word, and a recorded
        # speech-end milestone. Without them both sides collapse onto the same
        # fallback timestamp and the error is trivially, and falsely, 0 ms.
        "endpoint_position_error_ms": (
            delta(declared_end, speech_end, allow_negative=True)
            if profile["words_recorded"] and profile["speech_end_recorded"] else None),
        "position_error_measurable": profile["words_recorded"] and profile["speech_end_recorded"],
        # The listening window is not the caller's speech; without word
        # timestamps its duration says nothing about how long they spoke.
        "speech_duration_ms": delta(speech_end, window["start_ms"]) if window["from_word_timestamps"] else None,
        "caller_wait_ms": turn.get("time_to_first_audio_ms"),
        "llm_ms": turn.get("llm_ms"),
        "tts_ms": turn.get("tts_ms"),
        "confidence": response.get("confidence"),
        "language": response.get("language"),
        "word_count": len(words),
    }


def partial_revisions(partials: Sequence[dict[str, Any]], final_text: Any,
                      truncated: bool = False) -> dict[str, Any]:
    """How much interim text churned before the final. Unavailable when the
    captured partial history was truncated, since a capped list understates it."""
    from app.evaluation import align, tokenize

    if truncated:
        return {"available": False, "reason": "partial_history_truncated",
                "revision_count": None, "revision_rate": None,
                "provisional_to_final_wer": None, "hypothesis_count": len(partials)}
    texts = [item.get("transcript") for item in partials if isinstance(item.get("transcript"), str)]
    if not texts:
        return {"available": False, "reason": "no_partials", "revision_count": None,
                "revision_rate": None, "provisional_to_final_wer": None, "hypothesis_count": 0}
    revisions = 0
    for previous, current in zip(texts, texts[1:]):
        diff = align(tokenize(previous), tokenize(current))
        revisions += sum(item["operation"] != "match" for item in diff)
    final_tokens = tokenize(final_text)
    first_tokens = tokenize(texts[0])
    provisional_wer = None
    if final_tokens:
        diff = align(first_tokens, final_tokens)
        provisional_wer = sum(item["operation"] != "match" for item in diff) / len(final_tokens)
    return {
        "available": True,
        "revision_count": revisions,
        "revision_rate": revisions / len(final_tokens) if final_tokens else None,
        "provisional_to_final_wer": provisional_wer,
        "hypothesis_count": len(texts),
    }


def challenger_stream_latency(run: dict[str, Any], windows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Derive per-turn streaming milestones from a recorded replay's receipts.

    The replay is paced in real time against the original caller track, so a
    receipt's `at_ms` sits on the same call timeline as the production spans and
    the two turn-detection behaviours are directly comparable.

    A turn's challenger "final" is the first VAD-declared commit whose audio ends
    inside the turn's speech region: that is where the challenger decided the
    caller had stopped. Falling back to the next commit of any kind would measure
    the commit cadence rather than turn detection, so it is not done.
    """
    timing = run.get("timing") or {}
    receipts = timing.get("receipts") or []
    if not receipts:
        return {"available": False, "reason": "no_streaming_receipts", "turns": {}}

    commits = timing.get("commits") or []
    partials = [
        item for item in receipts
        if item.get("kind") == "partial_transcript"
        and isinstance(item.get("at_ms"), (int, float)) and str(item.get("text") or "").strip()
    ]
    commit_receipts = [
        item for item in receipts
        if item.get("kind") in {"committed_transcript_with_timestamps", "committed_transcript",
                                "final_transcript_with_timestamps", "final_transcript"}
        and isinstance(item.get("at_ms"), (int, float)) and str(item.get("text") or "").strip()
    ]

    turns: dict[str, dict[str, Any]] = {}
    matched_commits: set[Any] = set()
    for window in windows:
        turn_id = str(window["turn_id"])
        start, end = window.get("start_ms"), window.get("end_ms")
        # Words are collected across the (possibly widened) mapping window, but
        # latency is measured from the caller's real speech onset.
        onset = window.get("onset_ms", start)
        onset_reliable = window.get("onset_reliable", True)
        if start is None or end is None:
            turns[turn_id] = {"available": False, "reason": "no_speech_window"}
            continue

        commit = None
        commit_index = None
        for index, item in enumerate(commits):
            audio_end = item.get("audio_end_ms")
            if index in matched_commits or not isinstance(audio_end, (int, float)):
                continue
            if start - 400 <= audio_end <= end + 1500:
                commit, commit_index = item, index
                break
        if commit is None and not commits:
            # Only when no commit carries audio bounds. Otherwise the receipt list
            # is the same set of commits and would hand a turn a commit that an
            # earlier turn already claimed.
            for index, item in enumerate(commit_receipts):
                key = ("receipt", index)
                if key in matched_commits:
                    continue
                if start <= item["at_ms"] <= end + 3000:
                    commit, commit_index = item, key
                    break
        if commit_index is not None:
            matched_commits.add(commit_index)

        commit_at = commit.get("at_ms") if commit else None
        commit_audio_end = commit.get("audio_end_ms") if commit else None

        # A partial only belongs to this turn if it arrives before the turn is
        # committed. Without the upper bound a silent turn adopts the NEXT turn's
        # partial and reports a fabricated multi-second first-partial latency.
        upper_bound = commit_at if commit_at is not None else end + PARTIAL_GRACE_MS
        previous = ""
        first_partial = None
        for item in partials:
            text = str(item.get("text") or "").strip()
            if item["at_ms"] > upper_bound:
                break
            if item["at_ms"] >= start and text != previous:
                first_partial = item
                break
            previous = text

        in_turn = [item for item in partials if start <= item["at_ms"] <= upper_bound]
        cursor_lags = [
            item["audio_cursor_ms"] - item["result_audio_end_ms"]
            for item in in_turn
            if isinstance(item.get("audio_cursor_ms"), (int, float)) and isinstance(item.get("result_audio_end_ms"), (int, float))
        ]
        turns[turn_id] = {
            "available": True,
            "first_partial_at_ms": first_partial["at_ms"] if first_partial else None,
            "time_to_first_partial_ms": (delta(first_partial["at_ms"], onset)
                                         if first_partial and onset_reliable else None),
            "first_partial_unmeasurable_reason": None if onset_reliable else "no_reliable_speech_onset",
            "final_at_ms": commit_at,
            "endpoint_delay_ms": delta(commit_at, end) if commit_at is not None else None,
            "endpoint_position_error_ms": delta(commit_audio_end, end, allow_negative=True) if commit_audio_end is not None else None,
            "post_end_delay_ms": delta(next((item["at_ms"] for item in sorted(partials + commit_receipts, key=lambda x: x["at_ms"]) if end <= item["at_ms"] <= upper_bound), None), end),
            "partial_count": len(in_turn),
            "streaming_cursor_lag_ms": round(sum(cursor_lags) / len(cursor_lags)) if cursor_lags else None,
            "transcript": str((commit or {}).get("text") or "").strip() or None,
            "missing_final": commit is None,
        }
    return {
        "available": True,
        "connected_at_ms": timing.get("connected_at_ms"),
        "audio_started_at_ms": timing.get("audio_started_at_ms"),
        "wall_clock_ms": timing.get("wall_clock_ms"),
        "first_partial_at_ms": timing.get("first_partial_at_ms"),
        "receipt_count": len(receipts),
        "commit_count": len(commits) or len(commit_receipts),
        "configured": run.get("request") or {},
        "turns": turns,
    }



def barge_in(audio_events: Sequence[dict[str, Any]], windows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Turns where the caller talked over agent audio that was still playing.

    Chunk receipts are contiguous within an utterance, so spans are merged only
    across gaps shorter than a chunk; merging across real silence would make the
    agent look like it never stopped talking and flag every turn as a barge-in.
    A short overlap is normal echo at a turn boundary, so a turn counts only when
    the caller overlapped agent audio for more than `MIN_BARGE_IN_MS`.
    """
    agent_spans: list[tuple[int, int]] = []
    saw_agent_chunk = False
    unusable_durations = 0
    for event in audio_events:
        if event.get("track") != "agent" or event.get("kind") != "audio_chunk":
            continue
        saw_agent_chunk = True
        start = event.get("occurred_at_ms")
        duration = event.get("duration_ms")
        if not isinstance(start, (int, float)) or not isinstance(duration, (int, float)) or duration < 0:
            # Treating an absent duration as zero would silently shrink the
            # agent's speaking time and under-report barge-ins.
            unusable_durations += 1
            continue
        agent_spans.append((round(start), round(start + duration)))
    if not agent_spans:
        return {
            "available": False,
            "reason": "no_agent_audio_events" if not saw_agent_chunk else "no_usable_agent_chunk_durations",
            "turn_ids": [], "turns": [], "count": None, "measured_turns": 0,
            "agent_span_count": 0, "agent_speaking_ms": None,
            "unusable_chunk_count": unusable_durations, "threshold_ms": MIN_BARGE_IN_MS,
        }
    agent_spans.sort()
    merged: list[list[int]] = []
    for start, end in agent_spans:
        if merged and start - merged[-1][1] <= AGENT_SPAN_GAP_MS:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    overlapping: list[dict[str, Any]] = []
    for window in windows:
        start, end = window.get("start_ms"), window.get("end_ms")
        if start is None or end is None:
            continue
        total = sum(overlap_ms((start, end), (span[0], span[1])) for span in merged)
        if total >= MIN_BARGE_IN_MS:
            overlapping.append({"turn_id": str(window["turn_id"]), "overlap_ms": total})
    return {
        "available": True,
        "turn_ids": [item["turn_id"] for item in overlapping],
        "turns": overlapping,
        "count": len(overlapping),
        "measured_turns": sum(1 for w in windows if w.get("start_ms") is not None and w.get("end_ms") is not None),
        "agent_span_count": len(merged),
        "agent_speaking_ms": sum(span[1] - span[0] for span in merged),
        "threshold_ms": MIN_BARGE_IN_MS,
    }



def turn_shape(windows: Sequence[dict[str, Any]], latencies: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Split, merged and missing-final counts across the call."""
    missing_final = [turn_id for turn_id, item in latencies.items() if item.get("missing_final")]
    not_turn_final = [turn_id for turn_id, item in latencies.items() if item.get("is_turn_final") is False]
    premature = [
        turn_id for turn_id, item in latencies.items()
        if isinstance(item.get("endpoint_position_error_ms"), (int, float)) and item["endpoint_position_error_ms"] < -ENDPOINT_POSITION_TOLERANCE_MS
    ]
    late = [
        turn_id for turn_id, item in latencies.items()
        if isinstance(item.get("endpoint_position_error_ms"), (int, float)) and item["endpoint_position_error_ms"] > ENDPOINT_POSITION_TOLERANCE_MS
    ]
    forced = [turn_id for turn_id, item in latencies.items() if item.get("forced_flush")]
    return {
        "missing_final_turn_ids": missing_final, "missing_final_count": len(missing_final),
        "non_turn_final_turn_ids": not_turn_final, "non_turn_final_count": len(not_turn_final),
        "premature_turn_ids": premature, "premature_count": len(premature),
        "late_turn_ids": late, "late_count": len(late),
        "split_or_merged_count": len(premature) + len(late),
        "forced_flush_turn_ids": forced, "forced_flush_count": len(forced),
        "measured_turns": len(latencies),
    }


def response_budget(latencies: dict[str, dict[str, Any]], challenger_turns: dict[str, Any] | None) -> dict[str, Any]:
    """Where the caller's wait actually goes, and what it would be on the challenger.

    The counterfactual substitutes only the challenger's measured endpoint delay
    and holds the same turn's LLM and TTS times fixed. It is arithmetic on
    recorded spans, not a replayed conversation, and is labelled as such.
    """
    stt_shares, counterfactuals, waits = [], [], []
    per_turn: dict[str, dict[str, Any]] = {}
    for turn_id, item in latencies.items():
        endpoint = item.get("endpoint_delay_ms")
        llm = item.get("llm_ms")
        tts = item.get("tts_ms")
        wait = item.get("caller_wait_ms")
        components = [value for value in (endpoint, llm, tts) if isinstance(value, (int, float))]
        share = None
        if isinstance(endpoint, (int, float)) and len(components) == 3 and sum(components) > 0:
            share = endpoint / sum(components)
            stt_shares.append(share)
        counterfactual = None
        challenger_endpoint = ((challenger_turns or {}).get(turn_id) or {}).get("endpoint_delay_ms")
        if isinstance(challenger_endpoint, (int, float)) and isinstance(wait, (int, float)) and isinstance(endpoint, (int, float)):
            counterfactual = round(wait - endpoint + challenger_endpoint)
            counterfactuals.append(counterfactual)
        if isinstance(wait, (int, float)):
            waits.append(wait)
        per_turn[turn_id] = {
            "caller_wait_ms": wait, "stt_ms": endpoint, "llm_ms": llm, "tts_ms": tts,
            "stt_share": share, "counterfactual_wait_ms": counterfactual,
        }
    return {
        "turns": per_turn,
        "stt_share": percentiles(stt_shares),
        "caller_wait_ms": percentiles(waits),
        "counterfactual_wait_ms": percentiles(counterfactuals),
        "counterfactual_available": bool(counterfactuals),
        "method": "measured endpoint delay substituted; LLM and TTS held fixed",
    }
