"""Assembles the complete STT evaluation payload for one recorded call.

The dashboard is a decision surface, so this module's contract is that every
field it emits is either a measured number or an explicit `{"available": false,
"reason": ...}` — a reviewer must never have to guess whether a blank means
"fast" or "we did not look".
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app import evaluation, latency as latency_module, pricing as pricing_module

PAYLOAD_VERSION = "2.0"


def unavailable(reason: str) -> dict[str, Any]:
    return {"available": False, "reason": reason}


def _challenger_key(run: dict[str, Any]) -> str:
    return f"{run.get('provider')}:{run.get('model')}:{run.get('kind')}"


def word_token_count(run: dict[str, Any] | None) -> int:
    """Real spoken tokens only. The vendor emits spacing/audio-event entries in
    the same list, so a run with nothing but a space would otherwise look like it
    had transcribed something."""
    words = ((run or {}).get("response") or {}).get("words") or []
    return sum(1 for word in words if isinstance(word, dict) and word.get("type", "word") == "word")


def select_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Pick one transcript source and one streaming-timing source.

    The transcript source is preferentially the STREAMING run, so that accuracy,
    latency and cost all describe the same model — the one that would actually be
    deployed. Scoring accuracy against the batch model while timing and pricing
    the realtime model compares two different systems: on session 37077ebf the
    two Scribe models disagree with each other by 28%, which is larger than the
    21% error the batch reference then attributed to production. A reference that
    unstable cannot support a verdict about the incumbent.

    The batch run remains a fallback so calls with no usable streaming replay
    still report something, and it is still priced separately as an offline
    evaluation cost.

    Completion is judged by status, not by whether words came back: a run that
    genuinely transcribed nothing is evidence that the challenger heard nothing,
    and discarding it would report the challenger as never having run.
    """
    complete = [run for run in runs if run.get("status", "complete") == "complete"]
    streaming_runs = [run for run in complete if run.get("kind") == "streaming"]
    with_words = [run for run in complete if word_token_count(run)]
    # Prefer the deployable streaming model when it produced words, then ANY run
    # that produced words, then an empty run so "the challenger returned nothing"
    # stays reportable rather than silently vanishing.
    transcript_run = (next((run for run in streaming_runs if word_token_count(run)), None)
                      or next(iter(with_words), None)
                      or next(iter(streaming_runs), None)
                      or next(iter(complete), None))
    streaming_run = next((run for run in runs if run.get("kind") == "streaming" and ((run.get("timing") or {}).get("receipts"))), None)
    return {"transcript": transcript_run, "streaming": streaming_run}


def mapping_windows(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Widen turns whose speech region could only be guessed from milestones.

    When production returned no word timestamps — including when it transcribed
    nothing at all — the only region available is the recognizer's listening
    window, which opens AFTER the caller has already started speaking. Matching
    challenger words against it strands them as unmapped and makes a total
    production failure look like "no speech happened", which is the opposite of
    the truth.

    For those turns the window is extended back to the end of the previous turn.
    Nothing is invented: the recognizer was listening across that span, the span
    is not claimed by any other turn, and turns with real word timestamps keep
    their exact regions.

    The widened regions are returned as COPIES and the caller's own windows keep
    their true speech bounds. The widened span is precisely the stretch where
    the agent was talking, so using it as a speech region would report barge-ins
    that never happened and would credit the previous turn's partials to this
    one. Widening is a device for collecting words and nothing else.
    """
    widened: list[dict[str, Any]] = []
    previous_end: int | None = None
    for window in windows:
        start, end = window.get("start_ms"), window.get("end_ms")
        if start is None or end is None:
            widened.append(dict(window))
            continue
        # The onset is what latency is measured from, so it must never move.
        # Widening is a mapping device for collecting words; using the widened
        # start as a timing origin would charge the challenger for silence that
        # preceded the caller and make it look seconds slower than it is.
        window.setdefault("onset_ms", start)
        window["onset_reliable"] = bool(window.get("from_word_timestamps"))
        region = dict(window)
        if not window.get("from_word_timestamps"):
            floor = previous_end if previous_end is not None else 0
            if floor < start:
                region["start_ms"] = floor
                region["widened"] = True
        widened.append(region)
        previous_end = end
    return widened


def length_agreement(turn_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """How closely the two transcripts agree in length, for redacted captures.

    When the capture recorded a character count but not the text, accuracy cannot
    be scored. The count is still real evidence: if production returned 25
    characters where the challenger returned 27, production plainly heard the
    utterance, which rules out the "production heard nothing" reading that an
    unrecorded transcript otherwise invites. It is a sanity check on whether
    speech was captured at all, never a substitute for word error rate.
    """
    pairs = [
        (row["score"]["production_char_count"], row["score"]["challenger_char_count"])
        for row in turn_rows
        if row["score"].get("status") == "production_transcript_not_captured"
        and isinstance(row["score"].get("production_char_count"), int)
        and isinstance(row["score"].get("challenger_char_count"), int)
    ]
    if not pairs:
        return {"available": False, "reason": "no_length_only_turns", "turns": 0,
                "production_chars": None, "challenger_chars": None, "ratio": None}
    production_chars = sum(left for left, _ in pairs)
    challenger_chars = sum(right for _, right in pairs)
    return {
        "available": True,
        "reason": None,
        "turns": len(pairs),
        "production_chars": production_chars,
        "challenger_chars": challenger_chars,
        "ratio": (production_chars / challenger_chars) if challenger_chars else None,
        "method": "character counts only; the capture did not record the text, so this "
                  "shows whether production heard comparable speech, not whether it was correct",
    }


def build(session: dict[str, Any], runs: list[dict[str, Any]], risk_store: dict[str, Any] | None,
          audio_events: list[dict[str, Any]], data_dir: Path, cohort: dict[str, Any] | None = None) -> dict[str, Any]:
    manifest = session.get("manifest") or {}
    session_id = session["id"] if "id" in session else session.get("session_id")
    turns = session.get("turns") or []

    production_turns: list[dict[str, Any]] = []
    windows: list[dict[str, Any]] = []
    for turn in turns:
        operation = next(
            (op for op in turn.get("operations", []) if op.get("type") == "stt" and op.get("scope", "turn") != "connection"),
            None,
        )
        if not operation:
            continue
        timing = latency_module.production_turn_latency(operation, turn)
        response = operation.get("response") if isinstance(operation.get("response"), dict) else {}
        production_turns.append({
            "turn_id": str(turn["turn_id"]),
            "status": operation.get("status"),
            "started_at_ms": operation.get("started_at_ms"),
            "timing": timing,
            "transcript": response.get("transcript"),
            "confidence": response.get("confidence"),
            "language": response.get("language"),
            "final_reason": response.get("final_reason"),
            "words": response.get("words") or [],
            "provider": operation.get("provider") or operation.get("endpoint_id"),
            # No endpoint_id fallback: the endpoint id is a wiring name, not a
            # model name, and echoing it as the model would present a fabricated
            # answer to "which model ran in production?".
            "model": operation.get("model") or (operation.get("request") or {}).get("model"),
            "request": operation.get("request") or {},
        })
        windows.append({
            "turn_id": str(turn["turn_id"]),
            "start_ms": timing["speech_start_ms"],
            "end_ms": timing["speech_end_ms"],
            "from_word_timestamps": timing.get("region_from_word_timestamps", True),
            "listen_start_ms": timing.get("listen_start_ms"),
        })

    # Widened regions collect the challenger's words; every timing consumer below
    # keeps the true speech bounds.
    mapping_regions = mapping_windows(windows)

    selected = select_runs(runs)
    transcript_run, streaming_run = selected["transcript"], selected["streaming"]

    mapping = evaluation.map_words_to_turns((transcript_run or {}).get("response", {}).get("words") or [], mapping_regions) if transcript_run else None
    risk_turns = (risk_store or {}).get("turns") or {}
    risk_skipped = (risk_store or {}).get("skipped") or {}

    stream_latency = latency_module.challenger_stream_latency(streaming_run, windows) if streaming_run else {"available": False, "reason": "no_streaming_replay", "turns": {}}

    turn_rows: list[dict[str, Any]] = []
    scored_pairs: list[tuple[str, dict[str, Any]]] = []
    for turn in production_turns:
        turn_id = turn["turn_id"]
        challenger_words = (mapping or {}).get("mapped", {}).get(turn_id) or []
        ambiguous = turn_id in ((mapping or {}).get("ambiguous_turn_ids") or [])
        challenger_text = evaluation.words_to_text(challenger_words) if challenger_words else ""

        # A missing production transcript is a property of the capture and holds
        # whether or not a challenger ran, so it is decided first. The other
        # order blames a gap in the recording on a missing evaluation and throws
        # away the character counts that are the only remaining evidence
        # production heard anything at all.
        if not turn["timing"]["capture"]["transcript_recorded"]:
            score = {"status": "production_transcript_not_captured", "estimated_wer": None, "band": "unavailable",
                     "diff": [], "substitutions": 0, "deletions": 0, "insertions": 0, "matches": 0, "errors": 0,
                     "production_word_count": 0, "challenger_word_count": len(challenger_words),
                     "production_char_count": turn["timing"]["capture"]["char_count"],
                     "challenger_char_count": len(challenger_text) or None}
        elif not transcript_run:
            score = {"status": "challenger_not_run", "estimated_wer": None, "band": "unavailable", "diff": [],
                     "substitutions": 0, "deletions": 0, "insertions": 0, "matches": 0, "errors": 0,
                     "production_word_count": len(evaluation.tokenize(turn["transcript"])), "challenger_word_count": 0}
        elif ambiguous:
            score = {"status": "challenger_mapping_ambiguous", "estimated_wer": None, "band": "unavailable", "diff": [],
                     "substitutions": 0, "deletions": 0, "insertions": 0, "matches": 0, "errors": 0,
                     "production_word_count": len(evaluation.tokenize(turn["transcript"])), "challenger_word_count": len(challenger_words)}
        else:
            score = evaluation.score_pair(turn["transcript"], challenger_text)
        scored_pairs.append((turn_id, score))

        risk = risk_turns.get(turn_id)
        if not risk:
            reason = risk_skipped.get(turn_id) or ("challenger_not_run" if not transcript_run else "not_evaluated")
            risk = {"risk": "none" if reason == "identical_transcripts" else "unavailable", "status": "skipped", "reason": reason,
                    "intent_changed": False, "critical_values_changed": [], "rationale": {
                        "identical_transcripts": "Both models produced the same words, so there is nothing that could change meaning.",
                    }.get(reason, "Not evaluated for this turn.")}

        turn_rows.append({
            "turn_id": turn_id,
            "status": turn["status"],
            "started_at_ms": turn["started_at_ms"],
            "speech_started_at_ms": turn["timing"]["speech_start_ms"],
            "speech_ended_at_ms": turn["timing"]["speech_end_ms"],
            "first_partial_ms": turn["timing"]["time_to_first_partial_ms"],
            "finalization_ms": turn["timing"]["endpoint_delay_ms"],
            "capture": turn["timing"]["capture"],
            "region_from_word_timestamps": turn["timing"]["region_from_word_timestamps"],
            "endpoint_measurable": turn["timing"]["endpoint_measurable"],
            "endpoint_unmeasurable_reason": turn["timing"]["endpoint_unmeasurable_reason"],
            "caller_wait_ms": turn["timing"]["caller_wait_ms"],
            "production": {
                "provider": turn["provider"], "model": turn["model"], "transcript": turn["transcript"],
                "confidence": turn["confidence"], "language": turn["language"], "final_reason": turn["final_reason"],
                "words": turn["words"], "word_count": len(turn["words"]),
                "partial_count": turn["timing"]["partial_count"],
                "partials_truncated": turn["timing"]["partials_truncated"],
                "request": turn["request"], "timing": turn["timing"],
            },
            "challenger": {
                "transcript": challenger_text or None, "words": challenger_words,
                "word_count": len(challenger_words),
                "timing": stream_latency.get("turns", {}).get(turn_id) or unavailable(stream_latency.get("reason", "no_streaming_replay")),
            } if transcript_run else None,
            "score": score,
            "estimated_wer": score.get("estimated_wer"),
            "band": score.get("band"),
            "cer": evaluation.character_error_rate(turn["transcript"], challenger_text) if transcript_run and challenger_text else None,
            "risk": risk,
            "diff": score.get("diff") or [],
        })

    production_latencies = {turn["turn_id"]: turn["timing"] for turn in production_turns}
    shape = latency_module.turn_shape(windows, production_latencies)
    budget = latency_module.response_budget(production_latencies, stream_latency.get("turns"))
    barge = latency_module.barge_in(audio_events, windows)

    wers = [row["estimated_wer"] for row in turn_rows if isinstance(row["estimated_wer"], (int, float))]
    call_wer = call_level_wer(turn_rows)
    risk_counts = {level: sum(1 for row in turn_rows if (row["risk"] or {}).get("risk") == level) for level in evaluation_risk_levels()}
    # A turn where production returned nothing while the challenger heard speech
    # is a measured result, not a gap: it is the single most damaging failure the
    # comparison can surface, so it counts toward the score rather than being
    # filed away as "not comparable".
    scored = [row for row in turn_rows if row["score"].get("status") in {"evaluated", "possible_missed_speech"}]
    no_text = [row["turn_id"] for row in turn_rows if not row["production"]["transcript"]]
    challenger_no_text = [row["turn_id"] for row in turn_rows if row["challenger"] and not row["challenger"]["transcript"]]

    duration_ms = manifest.get("duration_ms") or 0
    call_minutes = (duration_ms / 60000) if duration_ms else ((transcript_run or {}).get("audio", {}).get("duration_secs", 0) / 60 or None)
    pricing = pricing_module.load_pricing(data_dir)
    production_key = next((turn["model"] or turn["provider"] for turn in production_turns if turn.get("model") or turn.get("provider")), None)
    # Production runs streaming, so the honest switch comparison is against the
    # challenger's streaming model. The batch model only ever priced the offline
    # evaluation, and quoting it as the run-cost would overstate the bill ~8x.
    # Production streams, so the switch comparison must always be priced against
    # the challenger's STREAMING rate. Falling back to the batch model when only
    # batch evidence exists would quote a rate ~8x the real cost of switching.
    challenger_key = (streaming_run or {}).get("model") or pricing_module.STREAMING_EQUIVALENT.get(
        (transcript_run or {}).get("model")
    ) or (transcript_run or {}).get("model")
    evaluator_usage = (risk_store or {}).get("usage")
    cost = pricing_module.cost_model(pricing, production_key, challenger_key, call_minutes, evaluator_usage)
    cost["evaluation"] = pricing_module.evaluation_cost(pricing, transcript_run, streaming_run, evaluator_usage)

    production_model = next((turn["model"] for turn in production_turns if turn.get("model")), None)
    production_provider = next((turn["provider"] for turn in production_turns if turn.get("provider")), None)
    # The SDK does not always record a model name. The matched pricing entry is a
    # billing assumption, not evidence of which model ran, so it is surfaced as
    # `priced_as` instead of being substituted for the model.
    priced_label = (cost.get("production") or {}).get("label")
    production_label = production_model or production_provider or "production STT"

    return {
        "payload_version": PAYLOAD_VERSION,
        "session_id": session_id,
        "state": session.get("status"),
        "started_at": manifest.get("started_at") or session.get("created_at"),
        "completed_at": session.get("completed_at"),
        "duration_ms": duration_ms or None,
        "call_minutes": call_minutes,
        "agent_id": manifest.get("agent_id"),
        "outcome": manifest.get("outcome"),
        "run": run_metadata(session_id, transcript_run, streaming_run, risk_store, turn_rows),
        "production": {
            "provider": production_provider, "model": production_model,
            "model_recorded": production_model is not None,
            "model_unavailable_reason": None if production_model else "not_recorded_by_sdk",
            "priced_as": priced_label,
            "label": production_label,
            "request": next((turn["request"] for turn in production_turns if turn.get("request")), {}),
            "capabilities": production_capabilities(production_turns),
        },
        "challenger": challenger_summary(transcript_run, streaming_run, mapping, stream_latency),
        "coverage": {
            "call_turns": len(turns), "stt_turns": len(turn_rows),
            "transcript_turns": sum(bool(row["production"]["transcript"]) for row in turn_rows),
            "scored_turns": len(scored),
            "unscored_turns": len(turn_rows) - len(scored),
            "paired_timing_turns": sum(1 for row in turn_rows if (row.get("challenger") or {}).get("timing", {}).get("endpoint_delay_ms") is not None),
            "production_no_text_turn_ids": no_text,
            "challenger_no_text_turn_ids": challenger_no_text,
            "risk_evaluated_turns": sum(1 for row in turn_rows if (row["risk"] or {}).get("status") == "ok"),
        },
        "accuracy": {
            "call_estimated_wer": call_wer["wer"],
            "call_band": evaluation.band(call_wer["wer"]),
            "errors": call_wer["errors"],
            "reference_words": call_wer["reference_words"],
            "substitutions": call_wer["substitutions"],
            "deletions": call_wer["deletions"],
            "insertions": call_wer["insertions"],
            "matches": call_wer["matches"],
            "turn_wer": evaluation.percentiles(wers),
            "cer": evaluation.percentiles([row["cer"] for row in turn_rows]),
            "bands": {name: sum(1 for row in turn_rows if row["band"] == name) for name in ("low", "moderate", "high", "unavailable")},
            "disagreed_words": evaluation.disagreed_words(scored_pairs)[:12],
            "worst_turn_ids": [row["turn_id"] for row in sorted(scored, key=lambda item: -(item["estimated_wer"] or 0))[:5]],
            "available": bool(scored),
            "reason": None if scored else ("no_challenger" if not transcript_run else "no_comparable_turns"),
            "length_agreement": length_agreement(turn_rows),
        },
        "risk": {
            "counts": risk_counts,
            "outcome_risk_turns": risk_counts.get("high", 0) + risk_counts.get("medium", 0),
            "high_turn_ids": [row["turn_id"] for row in turn_rows if (row["risk"] or {}).get("risk") == "high"],
            "medium_turn_ids": [row["turn_id"] for row in turn_rows if (row["risk"] or {}).get("risk") == "medium"],
            "evaluator": (risk_store or {}).get("evaluator"),
            "critical_terms": (risk_store or {}).get("critical_terms"),
            "available": bool(risk_store),
            "reason": None if risk_store else ("no_challenger" if not transcript_run else "not_evaluated"),
        },
        "latency": {
            "production": {
                "first_partial_ms": evaluation.percentiles([t["time_to_first_partial_ms"] for t in production_latencies.values()]),
                "first_stable_partial_ms": evaluation.percentiles([t["time_to_first_stable_partial_ms"] for t in production_latencies.values()]),
                "endpoint_delay_ms": evaluation.percentiles([t["endpoint_delay_ms"] for t in production_latencies.values()]),
                "final_from_last_word_ms": evaluation.percentiles([t["final_from_last_word_ms"] for t in production_latencies.values()]),
                "speech_to_final_ms": evaluation.percentiles([t["speech_to_final_ms"] for t in production_latencies.values()]),
                "caller_wait_ms": evaluation.percentiles([t["caller_wait_ms"] for t in production_latencies.values()]),
                "configured_endpointing_ms": evaluation.percentiles([t["configured_endpointing_ms"] for t in production_latencies.values()]),
                "configured_utterance_end_ms": evaluation.percentiles([t["configured_utterance_end_ms"] for t in production_latencies.values()]),
                "threshold_gap_ms": evaluation.percentiles([t["threshold_gap_ms"] for t in production_latencies.values()]),
                "endpoint_position_error_ms": evaluation.percentiles([t["endpoint_position_error_ms"] for t in production_latencies.values()]),
                "partial_revision_rate": evaluation.percentiles([t["partial_revisions"]["revision_rate"] for t in production_latencies.values()]),
                "provisional_to_final_wer": evaluation.percentiles([t["partial_revisions"]["provisional_to_final_wer"] for t in production_latencies.values()]),
                "llm_ms": evaluation.percentiles([t["llm_ms"] for t in production_latencies.values()]),
                "tts_ms": evaluation.percentiles([t["tts_ms"] for t in production_latencies.values()]),
                "final_reasons": count_by([t["final_reason"] for t in production_latencies.values()]),
            },
            "challenger": challenger_latency_summary(stream_latency),
            "delta": latency_delta(production_latencies, stream_latency.get("turns") or {}),
            "shape": shape,
            "barge_in": barge,
            "budget": budget,
        },
        "cost": cost,
        "cohort": cohort or unavailable("cross_call_cohort_not_built"),
        "turns": turn_rows,
    }


def evaluation_risk_levels() -> tuple[str, ...]:
    return ("none", "low", "medium", "high", "unavailable")


def count_by(values: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        key = str(value) if value is not None else "not_captured"
        counts[key] = counts.get(key, 0) + 1
    return counts


def call_level_wer(turn_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """One WER for the call: total errors over total reference words.

    Pooling the counts rather than averaging per-turn rates stops a two-word turn
    from carrying the same weight as a thirty-word one."""
    totals = {"substitutions": 0, "deletions": 0, "insertions": 0, "matches": 0, "reference_words": 0}
    for row in turn_rows:
        score = row["score"]
        if score.get("status") not in {"evaluated", "possible_missed_speech"}:
            continue
        totals["substitutions"] += score.get("substitutions", 0)
        totals["deletions"] += score.get("deletions", 0)
        totals["insertions"] += score.get("insertions", 0)
        totals["matches"] += score.get("matches", 0)
        totals["reference_words"] += score.get("challenger_word_count", 0)
    errors = totals["substitutions"] + totals["deletions"] + totals["insertions"]
    return {**totals, "errors": errors, "wer": errors / totals["reference_words"] if totals["reference_words"] else None}


def production_capabilities(production_turns: list[dict[str, Any]]) -> dict[str, Any]:
    """Capability facts read off the recorded spans, not a vendor datasheet."""
    request = next((turn["request"] for turn in production_turns if turn.get("request")), {})
    languages = {turn["language"] for turn in production_turns if turn.get("language")}
    return {
        "streaming_partials": bool(request.get("interim_results")) or any(turn["timing"]["partial_count"] for turn in production_turns),
        "word_timestamps": any(turn["words"] for turn in production_turns),
        "vad_events": bool(request.get("vad_events")),
        "confidence_scores": any(turn.get("confidence") is not None for turn in production_turns),
        "languages": sorted(languages),
        "multilingual_turns": len(languages) > 1,
        "sample_rate_hz": request.get("sample_rate_hz"),
    }


def challenger_summary(transcript_run: dict[str, Any] | None, streaming_run: dict[str, Any] | None,
                       mapping: dict[str, Any] | None, stream_latency: dict[str, Any]) -> dict[str, Any] | None:
    if not transcript_run and not streaming_run:
        return None
    run = transcript_run or streaming_run
    response = (run or {}).get("response") or {}
    words = response.get("words") or []
    return {
        "provider": run.get("provider"),
        "model": run.get("model"),
        "label": run.get("model") or run.get("provider"),
        "kind": run.get("kind"),
        "created_at": run.get("created_at"),
        "request": run.get("request"),
        "audio": run.get("audio"),
        "usage": run.get("usage"),
        "transcript": response.get("text"),
        "language_code": response.get("language_code"),
        "language_probability": response.get("language_probability"),
        "transcription_id": response.get("transcription_id"),
        "word_count": sum(1 for word in words if word.get("type") in (None, "word")),
        "mapping_summary": (mapping or {}).get("summary"),
        "capabilities": {
            "streaming_partials": bool(stream_latency.get("available")),
            "word_timestamps": bool(words),
            "vad_events": bool(streaming_run),
            "confidence_scores": any(word.get("logprob") is not None for word in words),
            "languages": [response.get("language_code")] if response.get("language_code") else [],
        },
        "streaming": {
            "available": bool(stream_latency.get("available")),
            "model": (streaming_run or {}).get("model"),
            "wall_clock_ms": stream_latency.get("wall_clock_ms"),
            "receipt_count": stream_latency.get("receipt_count"),
            "reason": stream_latency.get("reason"),
        },
    }


def challenger_latency_summary(stream_latency: dict[str, Any]) -> dict[str, Any]:
    turns = stream_latency.get("turns") or {}
    if not stream_latency.get("available") or not turns:
        return {"available": False, "reason": stream_latency.get("reason", "no_streaming_replay")}
    values = [item for item in turns.values() if item.get("available")]
    return {
        "available": True,
        "first_partial_ms": evaluation.percentiles([item.get("time_to_first_partial_ms") for item in values]),
        "endpoint_delay_ms": evaluation.percentiles([item.get("endpoint_delay_ms") for item in values]),
        "post_end_delay_ms": evaluation.percentiles([item.get("post_end_delay_ms") for item in values]),
        "streaming_cursor_lag_ms": evaluation.percentiles([item.get("streaming_cursor_lag_ms") for item in values]),
        "partial_count": evaluation.percentiles([item.get("partial_count") for item in values]),
        "missing_final_count": sum(1 for item in values if item.get("missing_final")),
        "measured_turns": len(values),
    }


def latency_delta(production: dict[str, dict[str, Any]], challenger: dict[str, Any]) -> dict[str, Any]:
    """Paired per-turn deltas, computed only where both sides measured the turn."""
    # Both sides must be measured from the same instant. The challenger's
    # endpoint delay is already measured from the caller's last word, so
    # production is paired on `final_from_last_word_ms` rather than its own
    # hangover-adjusted `endpoint_delay_ms`.
    pairs = {
        "first_partial_ms": ("time_to_first_partial_ms", "time_to_first_partial_ms"),
        "endpoint_delay_ms": ("final_from_last_word_ms", "endpoint_delay_ms"),
    }
    result: dict[str, Any] = {"paired_turns": 0}
    paired_ids: set[str] = set()
    for name, (production_key, challenger_key) in pairs.items():
        deltas = []
        for turn_id, production_turn in production.items():
            challenger_turn = challenger.get(turn_id) or {}
            left, right = production_turn.get(production_key), challenger_turn.get(challenger_key)
            if isinstance(left, (int, float)) and isinstance(right, (int, float)):
                deltas.append(right - left)
                paired_ids.add(turn_id)
        result[name] = evaluation.percentiles(deltas) if deltas else {"count": 0, "p50": None, "p90": None, "p95": None, "max": None, "min": None, "mean": None}
    result["paired_turns"] = len(paired_ids)
    result["available"] = bool(paired_ids)
    return result


def run_metadata(session_id: str, transcript_run: dict[str, Any] | None, streaming_run: dict[str, Any] | None,
                 risk_store: dict[str, Any] | None, turn_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Provenance a reviewer needs before trusting anything on the page."""
    eligible = len(turn_rows)
    completed = sum(1 for row in turn_rows if row["score"].get("status") == "evaluated")
    if not transcript_run and not streaming_run:
        state = "not_run"
    elif completed == 0:
        state = "failed"
    elif completed < eligible:
        state = "partial"
    else:
        state = "ready"
    runs = [run for run in (transcript_run, streaming_run) if run]
    return {
        "id": f"{session_id[:8]}-{(transcript_run or streaming_run or {}).get('created_at', '')[:19]}",
        "state": state,
        "immutable": True,
        "eligible_turns": eligible,
        "completed_turns": completed,
        "started_at": min((run.get("created_at") for run in runs if run.get("created_at")), default=None),
        "completed_at": max((run.get("created_at") for run in runs if run.get("created_at")), default=None),
        "normalization_version": evaluation.NORMALIZATION_VERSION,
        "alignment_version": evaluation.ALIGNMENT_VERSION,
        "payload_version": PAYLOAD_VERSION,
        "mapping_tolerance_ms": evaluation.MAPPING_TOLERANCE_MS,
        "evaluator": (risk_store or {}).get("evaluator"),
        "runs": [{"provider": run.get("provider"), "model": run.get("model"), "kind": run.get("kind"),
                  "status": run.get("status", "complete"), "created_at": run.get("created_at")} for run in runs],
    }


def build_cohort(payloads: list[dict[str, Any]], current_session_id: str, sample_limit: int | None = None) -> dict[str, Any]:
    """Cross-call typicality: is this call normal for this agent, or an outlier?"""
    others = [payload for payload in payloads if payload["session_id"] != current_session_id]
    if not others:
        return unavailable("only_one_recorded_call")
    current = next((payload for payload in payloads if payload["session_id"] == current_session_id), None)

    def collect(path: list[str], source: list[dict[str, Any]]) -> list[Any]:
        values = []
        for payload in source:
            node: Any = payload
            for key in path:
                node = (node or {}).get(key) if isinstance(node, dict) else None
            if isinstance(node, (int, float)):
                values.append(node)
        return values

    metrics = {
        "caller_wait_ms": ["latency", "production", "caller_wait_ms", "p50"],
        "endpoint_delay_ms": ["latency", "production", "endpoint_delay_ms", "p50"],
        "first_partial_ms": ["latency", "production", "first_partial_ms", "p50"],
        "estimated_wer": ["accuracy", "call_estimated_wer"],
    }
    summary: dict[str, Any] = {}
    for name, path in metrics.items():
        cohort_values = collect(path, payloads)
        current_value: Any = current
        for key in path:
            current_value = (current_value or {}).get(key) if isinstance(current_value, dict) else None
        stats = evaluation.percentiles(cohort_values)
        rank = None
        if isinstance(current_value, (int, float)) and cohort_values:
            rank = sum(1 for value in cohort_values if value <= current_value) / len(cohort_values)
        summary[name] = {"call": current_value, "cohort": stats, "percentile_rank": rank,
                         "typical": rank is not None and 0.1 <= rank <= 0.9}
    return {
        "available": True,
        "call_count": len(payloads),
        "agent_id": (current or {}).get("agent_id"),
        "window": (
            f"the {len(payloads)} most recent calls for this agent"
            if sample_limit is not None and len(payloads) >= sample_limit
            else "every recorded call for this agent"
        ),
        "metrics": summary,
    }
