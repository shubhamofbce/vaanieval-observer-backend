#!/usr/bin/env python3
"""Independently verify every latency number the dashboard publishes.

This is a deliberate second implementation. It re-derives each value straight
from `events.jsonl` and the stored challenger runs using its own arithmetic,
then asserts the served payload agrees. It does not import `app.latency`, because
a validator that reuses the code under test only proves the code is consistent
with itself.

Beyond equality it enforces three honesty rules that each caught a real defect:

  * no fabricated zero    - a duration of exactly 0 ms is only credible when the
                            two milestones were separately recorded.
  * no invented evidence  - a value must be absent when its source milestone or
                            word timestamps were never captured.
  * no silent default     - every percentile must be reproducible from exactly
                            the per-turn samples that back it.

Checks are counted by category and reported separately, because an "absence"
check on an empty session is far weaker evidence than a numeric comparison
against raw milestones, and reporting a single total would overstate coverage.

Usage:  python3 scripts/validate-latency.py [--session ID] [--json]
Exits non-zero if any published latency value is unsupported by the raw evidence.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# The payload rounds to whole milliseconds, so agreement is judged to half of one.
TOLERANCE_MS = 0.51
ENDPOINT_POSITION_TOLERANCE_MS = 1000
TURN_FINAL_REASONS = {"endpointing", "utterance_end", "speech_final", "final"}
FORCED_FLUSH_REASONS = {"timeout", "flush", "forced", "close", "eof"}
# Mirrors `app.latency.WORD_CLOCK_TOLERANCE_MS`. Restated rather than imported:
# this script is an independent recomputation, so it deliberately shares no code
# with the module it checks - only the documented rule.
WORD_CLOCK_TOLERANCE_MS = 250

# Every production aggregate the payload publishes, mapped to the per-turn field
# it must be derivable from. Listing them explicitly means a newly added block
# with no per-turn source gets reported as unverified rather than ignored.
PRODUCTION_AGGREGATES = {
    "first_partial_ms": "time_to_first_partial_ms",
    "first_stable_partial_ms": "time_to_first_stable_partial_ms",
    "endpoint_delay_ms": "endpoint_delay_ms",
    "speech_to_final_ms": "speech_to_final_ms",
    "caller_wait_ms": "caller_wait_ms",
    "configured_endpointing_ms": "configured_endpointing_ms",
    "configured_utterance_end_ms": "configured_utterance_end_ms",
    "threshold_gap_ms": "threshold_gap_ms",
    "endpoint_position_error_ms": "endpoint_position_error_ms",
    "final_from_last_word_ms": "final_from_last_word_ms",
    "llm_ms": "llm_ms",
    "tts_ms": "tts_ms",
}

# Aggregates whose per-turn source sits inside the partial-revision sub-record.
NESTED_PRODUCTION_AGGREGATES = {
    "partial_revision_rate": ("partial_revisions", "revision_rate"),
    "provisional_to_final_wer": ("partial_revisions", "provisional_to_final_wer"),
}

CHALLENGER_AGGREGATES = {
    "first_partial_ms": "time_to_first_partial_ms",
    "endpoint_delay_ms": "endpoint_delay_ms",
    "post_end_delay_ms": "post_end_delay_ms",
    "streaming_cursor_lag_ms": "streaming_cursor_lag_ms",
}

STAT_KEYS = ("p50", "p90", "p95", "min", "max", "mean")


class Findings:
    """Failures, plus an honest tally of what was actually asserted."""

    CATEGORIES = ("evidence", "aggregate", "absence", "invariant")

    def __init__(self) -> None:
        self.items: list[dict] = []
        self.counts: dict[str, dict[str, int]] = {}

    def _tally(self, session: str, category: str) -> None:
        assert category in self.CATEGORIES, category
        self.counts.setdefault(session, {key: 0 for key in self.CATEGORIES})[category] += 1

    def fail(self, session: str, field: str, detail: str, expected=None, actual=None) -> None:
        self.items.append({"session": session, "field": field, "detail": detail,
                           "expected": repr(expected), "actual": repr(actual)})

    def check(self, cond: bool, session: str, category: str, field: str, detail: str,
              expected=None, actual=None) -> bool:
        self._tally(session, category)
        if not cond:
            self.fail(session, field, detail, expected, actual)
        return bool(cond)

    def totals(self) -> dict[str, int]:
        out = {key: 0 for key in self.CATEGORIES}
        for per_session in self.counts.values():
            for key, value in per_session.items():
                out[key] += value
        return out


def load_events(session: str, findings: Findings) -> list[dict]:
    """Read the raw capture, failing loudly on missing or corrupt evidence.

    Treating an unreadable capture as "no events" would let a session validate
    perfectly by virtue of containing nothing.
    """
    path = ROOT / "data" / "objects" / session / "events.jsonl"
    if not path.exists():
        findings.fail(session, "events.jsonl",
                      "raw capture is missing, so nothing can be verified", str(path), "absent")
        return []
    out = []
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as error:
            findings.fail(session, f"events.jsonl:{number}",
                          "raw capture line is not valid JSON, so the evidence is incomplete",
                          "valid JSON", str(error))
    return out


def stt_turns(events: list[dict]) -> list[dict]:
    """Turn-scoped STT operations only.

    Connection-scope records carry `close_code`/`sent_bytes` rather than a
    transcription, and some captures omit the scope field entirely, so the shape
    of the response is checked as well as the label. The WebSocket upgrade is
    recorded the same way — an HTTP status with no transcript — and the payload
    does not count it as an exchange either.
    """
    out = []
    for event in events:
        if event.get("type") != "stt":
            continue
        if event.get("scope") == "connection":
            continue
        response = event.get("response") if isinstance(event.get("response"), dict) else {}
        if "close_code" in response or "sent_bytes" in response:
            continue
        if response.get("status") is not None and "transcript" not in response:
            continue
        out.append(event)
    return out


def spans_by_turn(events: list[dict], kind: str) -> dict[str, float]:
    """Total time a turn spent in LLM or TTS, from the raw record.

    A turn can issue several calls - tool use splits one reply into multiple
    completions - so the caller waits for their sum, not the last one.

    A model call is recorded twice, though: the agent framework times the whole
    logical call including its retries, and the HTTP instrumentation times each
    physical attempt inside it. Adding both counts the same wait twice and can
    report more model time than the turn itself lasted, so a span wholly
    enclosed by another span of the same kind and turn is skipped.
    """
    spans: dict[str, list[tuple[float, float]]] = {}
    for event in events:
        if event.get("type") != kind or event.get("scope") == "connection":
            continue
        start, end = event.get("started_at_ms"), event.get("ended_at_ms")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            spans.setdefault(str(event.get("turn_id")), []).append((start, end))

    out: dict[str, float] = {}
    for turn_id, windows in spans.items():
        total = 0.0
        for index, (start, end) in enumerate(windows):
            enclosed = any(
                other_start <= start and end <= other_end
                and (other_start, other_end) != (start, end)
                for position, (other_start, other_end) in enumerate(windows)
                if position != index
            )
            # Identical windows would each see the other as enclosing, so only
            # the first of a duplicated pair is kept.
            duplicate = any(
                (other_start, other_end) == (start, end) and position < index
                for position, (other_start, other_end) in enumerate(windows)
            )
            if enclosed or duplicate:
                continue
            total += end - start
        out[turn_id] = total
    return out


def ms(event: dict, *names: str):
    """First recorded milestone among `names`, mirroring the payload's fallbacks."""
    for name in names:
        item = (event.get("milestones") or {}).get(name)
        if isinstance(item, dict) and isinstance(item.get("occurred_at_ms"), (int, float)):
            return round(item["occurred_at_ms"])
    return None


def word_span(event: dict):
    words = (event.get("response") or {}).get("words") or []
    starts = [w["start_ms"] for w in words if isinstance(w.get("start_ms"), (int, float))]
    ends = [w["end_ms"] for w in words if isinstance(w.get("end_ms"), (int, float))]
    return (round(min(starts)) if starts else None, round(max(ends)) if ends else None)


def independent_percentiles(values: list) -> dict:
    """Linear-interpolated percentiles, written from the definition."""
    usable = [float(v) for v in values
              if isinstance(v, (int, float)) and not isinstance(v, bool)]
    if not usable:
        return {"count": 0, "p50": None, "p90": None, "p95": None,
                "min": None, "max": None, "mean": None}
    ordered = sorted(usable)

    def at(pct: float):
        if len(ordered) == 1:
            return float(ordered[0])
        position = (len(ordered) - 1) * pct
        low, high = int(position), min(int(position) + 1, len(ordered) - 1)
        return float(ordered[low] + (ordered[high] - ordered[low]) * (position - low))

    return {"count": len(ordered), "p50": at(0.50), "p90": at(0.90), "p95": at(0.95),
            "min": float(ordered[0]), "max": float(ordered[-1]),
            "mean": sum(ordered) / len(ordered)}


def close(a, b, tol=TOLERANCE_MS) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    return abs(float(a) - float(b)) <= tol


def diff_or_none(later, earlier, allow_negative: bool = False):
    if not isinstance(later, (int, float)) or not isinstance(earlier, (int, float)):
        return None
    value = later - earlier
    if value < 0 and not allow_negative:
        return None
    return value


def independent_diff(later, earlier):
    """A gap between two instants that were genuinely observed apart.

    Half of the STT spans in a real capture stamp `speech_ended` and
    `final_transcript` from the same framework event, so both milestones are
    present and byte-identical. Their difference is a fabricated 0 ms, not a
    recogniser that finalised instantly, and two network-observed instants
    landing on the same millisecond is one timestamp reported twice.
    """
    if not isinstance(later, (int, float)) or not isinstance(earlier, (int, float)):
        return None
    if later == earlier:
        return None
    return diff_or_none(later, earlier)


def milestone_field(event: dict, name: str, field: str):
    item = (event.get("milestones") or {}).get(name)
    return item.get(field) if isinstance(item, dict) else None


def validate_aggregate_block(findings: Findings, session: str, label: str,
                             block, samples: list) -> None:
    """A percentile block must be reproducible from the per-turn values behind it."""
    if not isinstance(block, dict):
        findings.check(False, session, "aggregate", label,
                       "published aggregate block is missing or not an object, so the figure "
                       "shown on the dashboard has no verifiable source",
                       "object", type(block).__name__)
        return
    expected = independent_percentiles(samples)
    findings.check(block.get("count") == expected["count"], session, "aggregate", f"{label}.count",
                   "aggregate claims a different number of samples than the per-turn values provide",
                   expected["count"], block.get("count"))
    for key in STAT_KEYS:
        empty = expected["count"] == 0
        findings.check(close(block.get(key), expected[key]),
                       session, "absence" if empty else "aggregate", f"{label}.{key}",
                       "reported a statistic with no samples behind it" if empty
                       else "does not match an independent recomputation from the per-turn values",
                       expected[key], block.get(key))


def validate_session(session: str, findings: Findings) -> dict:
    from app.main import evaluation_payload

    payload = evaluation_payload(session)
    events = load_events(session, findings)
    operations = stt_turns(events)
    by_turn = {str(op.get("turn_id")): op for op in operations}
    llm_spans, tts_spans = spans_by_turn(events, "llm"), spans_by_turn(events, "tts")

    rows = payload.get("turns") or []
    findings.check(len(rows) == len(operations), session, "invariant", "turns.count",
                   "published turn count must match the turn-scoped STT operations in the raw capture",
                   len(operations), len(rows))

    collected: dict[str, list] = {field: [] for field in PRODUCTION_AGGREGATES.values()}
    nested: dict[str, list] = {label: [] for label in NESTED_PRODUCTION_AGGREGATES}
    # Challenger values aligned positionally with `collected`, so the paired
    # delta can be rebuilt turn by turn.
    challenger_paired: dict[str, list] = {field: [] for field in CHALLENGER_AGGREGATES.values()}
    paired_index: list[tuple] = []
    challenger_collected: dict[str, list] = {field: [] for field in CHALLENGER_AGGREGATES.values()}
    numeric = 0

    for row in rows:
        turn_id = str(row.get("turn_id"))
        op = by_turn.get(turn_id)
        if op is None:
            findings.fail(session, f"turn[{turn_id}]",
                          "published turn has no matching raw STT operation")
            continue

        timing = ((row.get("production") or {}).get("timing")) or {}
        if not findings.check(bool(timing), session, "invariant",
                              f"turn[{turn_id}].production.timing",
                              "turn publishes no timing record, so its latency cannot be verified",
                              "object", timing):
            continue

        response = op.get("response") if isinstance(op.get("response"), dict) else {}
        request = op.get("request") or {}
        samples = ((op.get("samples") or {}).get("partial") or {})
        partials = samples.get("items") or []

        transcript_recorded = isinstance(response.get("transcript"), str)
        speech_end_at = ms(op, "speech_ended", "speech_end", "audio_ended")

        # One message can arrive as several final transcripts, which LiveKit
        # merges into a single committed turn. Every final after the voice
        # detector's first pause is evidence the caller was still talking, so
        # the end of speech moves forward and the final that closed the message
        # is the last one. Recomputed here from the raw milestone counters
        # rather than by calling the published implementation.
        late_final = None
        for repeated in ("final_transcript", "speech_final"):
            item = (op.get("milestones") or {}).get(repeated)
            if not isinstance(item, dict) or not isinstance(item.get("count"), int) or item["count"] < 2:
                continue
            last, first = item.get("last_at_ms"), item.get("occurred_at_ms")
            if isinstance(last, (int, float)) and isinstance(first, (int, float)) and last > first:
                late_final = round(last) if late_final is None else max(late_final, round(last))

        final_transcript_at = ms(op, "final_transcript")
        measurable_endpoint = final_transcript_at is not None and speech_end_at is not None
        first_word, last_word = word_span(op)
        words_recorded = bool((response.get("words") or []))

        listen_start = ms(op, "speech_started", "speech_start", "audio_started")
        if listen_start is None:
            listen_start = op.get("started_at_ms")
        declared_end = speech_end_at if speech_end_at is not None else op.get("ended_at_ms")
        if late_final is not None:
            delay = milestone_field(op, "end_of_utterance", "transcription_delay_ms")
            spoke_until = late_final - delay if isinstance(delay, (int, float)) else late_final
            if isinstance(op.get("ended_at_ms"), (int, float)):
                spoke_until = min(spoke_until, op["ended_at_ms"])
            if not isinstance(declared_end, (int, float)) or spoke_until > declared_end:
                declared_end = round(spoke_until)
        # A word cannot start before the recognizer began listening. When it
        # appears to, the word timestamps are on a different clock than the
        # milestones and their difference is not a measurement. Kept identical
        # to `latency.speech_window`, since this file's job is to recompute the
        # published numbers from raw evidence, not to invent a second rule.
        if (first_word is not None and isinstance(listen_start, (int, float))
                and first_word < listen_start - WORD_CLOCK_TOLERANCE_MS):
            first_word = None
        start = first_word if first_word is not None else listen_start
        end = last_word if last_word is not None else declared_end
        from_words = first_word is not None and last_word is not None

        first_partial_at = ms(op, "first_partial")
        first_stable_at = ms(op, "first_stable_partial", "stable_partial")
        final_at = late_final if late_final is not None else ms(op, "final_transcript", "speech_final")
        configured = request.get("endpointing_ms")
        configured = configured if isinstance(configured, (int, float)) else None
        utterance_end = request.get("utterance_end_ms")
        utterance_end = utterance_end if isinstance(utterance_end, (int, float)) else None

        expected_endpoint = None
        if measurable_endpoint:
            expected_endpoint = independent_diff(final_at, declared_end)
            if expected_endpoint is None:
                # The recogniser's own measurement, which is independent of how
                # the milestones were stamped.
                reported = milestone_field(op, "end_of_utterance", "transcription_delay_ms")
                expected_endpoint = round(reported) if isinstance(reported, (int, float)) else None
        # A collapsed pair is not a measurement, so the published flag has to
        # agree with whether a value actually survived the honesty rule.
        measurable_endpoint = expected_endpoint is not None
        final_reason = response.get("final_reason")

        expectations = {
            "speech_start_ms": start,
            "speech_end_ms": end,
            "listen_start_ms": listen_start,
            "declared_end_ms": declared_end,
            "region_from_word_timestamps": from_words,
            "speech_duration_ms": diff_or_none(end, start) if from_words else None,
            "first_partial_at_ms": first_partial_at,
            "first_stable_partial_at_ms": first_stable_at,
            "final_at_ms": final_at,
            "time_to_first_partial_ms": independent_diff(first_partial_at, start),
            "time_to_first_stable_partial_ms": independent_diff(first_stable_at, start),
            "endpoint_delay_ms": expected_endpoint,
            "speech_to_final_ms": diff_or_none(final_at, start) if from_words else None,
            # Comparable finalisation: both vendors measured from the last word.
            "final_from_last_word_ms": (diff_or_none(final_at, end)
                                        if from_words and final_at is not None else None),
            "configured_endpointing_ms": configured,
            "configured_utterance_end_ms": utterance_end,
            "threshold_gap_ms": (expected_endpoint - configured)
                                if isinstance(expected_endpoint, (int, float)) and configured is not None
                                else None,
            # Requires two independent sources. Without word timestamps AND a
            # recorded speech-end, both operands collapse onto the same fallback
            # timestamp and the "error" is a fabricated 0 ms.
            "endpoint_position_error_ms": (diff_or_none(declared_end, end, allow_negative=True)
                                           if words_recorded and speech_end_at is not None else None),
            "position_error_measurable": words_recorded and speech_end_at is not None,
            "result_audio_end_ms": end,
            "partial_count": len(partials),
            "partials_truncated": bool(samples.get("truncated")),
            "missing_final": final_at is None,
            "final_reason": final_reason,
            "is_turn_final": (final_reason in TURN_FINAL_REASONS) if final_reason else None,
            "forced_flush": (final_reason in FORCED_FLUSH_REASONS) if final_reason else False,
            "endpoint_measurable": measurable_endpoint,
            "word_count": len(response.get("words") or []),
            "confidence": response.get("confidence"),
            "language": response.get("language"),
            "llm_ms": llm_spans.get(turn_id),
            "tts_ms": tts_spans.get(turn_id),
        }

        for field, expected in expectations.items():
            actual = timing.get(field)
            absent = expected is None
            if not absent and isinstance(expected, (int, float)) and not isinstance(expected, bool):
                numeric += 1
            findings.check(close(actual, expected), session,
                           "absence" if absent else "evidence", f"turn[{turn_id}].{field}",
                           "must be absent because the capture holds no evidence for it" if absent
                           else "does not match an independent recomputation from the raw capture",
                           expected, actual)

        # The flattened fields the turn table binds must agree with the detailed
        # record; a mismatch means the UI shows a different number than the data.
        for flat, source in (("first_partial_ms", "time_to_first_partial_ms"),
                             ("finalization_ms", "endpoint_delay_ms"),
                             ("speech_started_at_ms", "speech_start_ms"),
                             ("speech_ended_at_ms", "speech_end_ms")):
            findings.check(close(row.get(flat), timing.get(source)), session, "invariant",
                           f"turn[{turn_id}].{flat}",
                           "value bound by the turn table disagrees with the detailed timing record",
                           timing.get(source), row.get(flat))

        if not measurable_endpoint:
            findings.check(timing.get("endpoint_delay_ms") is None, session, "absence",
                           f"turn[{turn_id}].endpoint_delay_ms",
                           "reported a finalisation time although the capture lacks a separately "
                           "recorded speech-end or final milestone - a fabricated measurement",
                           None, timing.get("endpoint_delay_ms"))
            findings.check(timing.get("endpoint_unmeasurable_reason") is not None, session,
                           "invariant", f"turn[{turn_id}].endpoint_unmeasurable_reason",
                           "an unmeasurable endpoint must state why, so the gap stays visible",
                           "a reason", timing.get("endpoint_unmeasurable_reason"))

        capture = timing.get("capture") or {}
        findings.check(capture.get("transcript_recorded") == transcript_recorded, session,
                       "evidence", f"turn[{turn_id}].capture.transcript_recorded",
                       "capture profile disagrees with whether the raw record holds a transcript",
                       transcript_recorded, capture.get("transcript_recorded"))

        score = row.get("score") or {}
        if not transcript_recorded:
            findings.check(score.get("status") == "production_transcript_not_captured", session,
                           "invariant", f"turn[{turn_id}].score.status",
                           "capture stored no transcript, so the turn must be reported as not "
                           "captured rather than scored as an error",
                           "production_transcript_not_captured", score.get("status"))
            findings.check(score.get("estimated_wer") is None, session, "absence",
                           f"turn[{turn_id}].score.estimated_wer",
                           "WER published for a turn whose production text was never recorded",
                           None, score.get("estimated_wer"))

        for field in ("speech_duration_ms", "endpoint_delay_ms", "time_to_first_partial_ms",
                      "speech_to_final_ms", "caller_wait_ms", "llm_ms", "tts_ms",
                      "endpoint_position_error_ms"):
            value = timing.get(field)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if field != "endpoint_position_error_ms":
                    findings.check(value >= 0, session, "invariant", f"turn[{turn_id}].{field}",
                                   "duration is negative, so the milestones are ordered impossibly",
                                   ">= 0", value)
                # A span of exactly zero is the signature of a metric whose two
                # operands collapsed onto the same fallback timestamp. Real
                # recognisers do not finalise in literally no time, so an exact
                # zero must be backed by independently recorded evidence.
                if value == 0:
                    # The recogniser reporting its own finalisation delay is
                    # independent evidence, so a genuine zero there stands.
                    reported_zero = (field == "endpoint_delay_ms"
                                     and milestone_field(op, "end_of_utterance", "transcription_delay_ms") == 0)
                    # `endpoint_position_error_ms` compares the declared end of
                    # speech to the LAST word, so a rejected first-word clock
                    # does not weaken it. Requiring the full word region here
                    # would flag a genuinely evidenced zero.
                    words_independent = (last_word is not None if field == "endpoint_position_error_ms"
                                         else from_words)
                    findings.check((words_independent and speech_end_at is not None) or reported_zero, session,
                                   "invariant", f"turn[{turn_id}].{field}",
                                   "reports exactly 0 ms without word timestamps and a recorded "
                                   "speech-end to prove it - both operands most likely collapsed "
                                   "onto the same fallback timestamp",
                                   "independent evidence for a zero span", value)

        if isinstance(timing.get("final_at_ms"), (int, float)) and isinstance(start, (int, float)):
            findings.check(timing["final_at_ms"] >= start, session, "invariant",
                           f"turn[{turn_id}].final_at_ms",
                           "the final was recorded before speech began",
                           f">= {start}", timing["final_at_ms"])

        for field in PRODUCTION_AGGREGATES.values():
            collected[field].append(timing.get(field))
        for label, (parent, child) in NESTED_PRODUCTION_AGGREGATES.items():
            nested[label].append((timing.get(parent) or {}).get(child))
        row_challenger = ((row.get("challenger") or {}).get("timing")) or {}
        for field in CHALLENGER_AGGREGATES.values():
            challenger_paired[field].append(
                row_challenger.get(field) if row_challenger.get("available") else None)
        for field in ("time_to_first_partial_ms", "endpoint_delay_ms"):
            paired_index.append((turn_id, timing.get(field),
                                 row_challenger.get(field) if row_challenger.get("available") else None))

        challenger_timing = ((row.get("challenger") or {}).get("timing")) or {}
        if challenger_timing.get("available"):
            # The challenger is measured against the same speech region as
            # production, so its values must reconcile with that region.
            # Without word timestamps there is no trustworthy speech onset - the
            # recogniser's listening window can open many seconds before the
            # caller speaks - so the challenger must decline to report rather
            # than be charged for silence it did not cause.
            expected_ttfp = (diff_or_none(challenger_timing.get("first_partial_at_ms"), start)
                             if from_words else None)
            findings.check(close(challenger_timing.get("time_to_first_partial_ms"), expected_ttfp),
                           session, "evidence" if from_words else "absence",
                           f"turn[{turn_id}].challenger.time_to_first_partial_ms",
                           "challenger first-partial must be measured from the same speech onset "
                           "as production, or the comparison is not like-for-like" if from_words
                           else "reported a first-partial latency with no reliable speech onset "
                                "to measure it from",
                           expected_ttfp, challenger_timing.get("time_to_first_partial_ms"))
            expected_endpoint_c = diff_or_none(challenger_timing.get("final_at_ms"), end)
            findings.check(close(challenger_timing.get("endpoint_delay_ms"), expected_endpoint_c),
                           session, "evidence", f"turn[{turn_id}].challenger.endpoint_delay_ms",
                           "challenger finalisation must be measured from the same speech end as production",
                           expected_endpoint_c, challenger_timing.get("endpoint_delay_ms"))
            findings.check(challenger_timing.get("missing_final")
                           == (challenger_timing.get("final_at_ms") is None),
                           session, "invariant", f"turn[{turn_id}].challenger.missing_final",
                           "missing-final flag disagrees with whether a commit was recorded",
                           challenger_timing.get("final_at_ms") is None,
                           challenger_timing.get("missing_final"))
            numeric += 2
            for field in CHALLENGER_AGGREGATES.values():
                challenger_collected[field].append(challenger_timing.get(field))

    latency = payload.get("latency") or {}
    production = latency.get("production")
    if not isinstance(production, dict):
        findings.check(False, session, "aggregate", "latency.production",
                       "the production latency section is missing entirely", "object", production)
        production = {}

    for label, source in PRODUCTION_AGGREGATES.items():
        validate_aggregate_block(findings, session, f"latency.production.{label}",
                                 production.get(label), collected[source])
    for label in NESTED_PRODUCTION_AGGREGATES:
        validate_aggregate_block(findings, session, f"latency.production.{label}",
                                 production.get(label), nested[label])

    # Any percentile block we have no per-turn source for is unverified, and
    # must be reported as such rather than quietly passing.
    for label, block in production.items():
        if label in PRODUCTION_AGGREGATES or label in NESTED_PRODUCTION_AGGREGATES \
                or not isinstance(block, dict):
            continue
        if set(STAT_KEYS).issubset(block.keys()):
            findings.check(False, session, "invariant", f"latency.production.{label}",
                           "publishes a percentile block with no per-turn source the validator "
                           "can rebuild it from, so its figures are unverified",
                           "a known per-turn source", "unmapped")

    challenger = latency.get("challenger") or {}
    if challenger.get("available"):
        for label, source in CHALLENGER_AGGREGATES.items():
            if isinstance(challenger.get(label), dict):
                validate_aggregate_block(findings, session, f"latency.challenger.{label}",
                                         challenger[label], challenger_collected[source])

    # The headline comparison is a PAIRED median: the median of per-turn
    # differences over turns both sides measured, which is not the same as the
    # difference of the two medians and is the statistically sound choice.
    delta = latency.get("delta") or {}
    if delta.get("available"):
        for label, source in (("first_partial_ms", "time_to_first_partial_ms"),
                              ("endpoint_delay_ms", "final_from_last_word_ms")):
            challenger_source = "endpoint_delay_ms" if source == "final_from_last_word_ms" else source
            paired = [c - p for p, c in zip(collected[source], challenger_paired[challenger_source])
                      if isinstance(p, (int, float)) and isinstance(c, (int, float))]
            validate_aggregate_block(findings, session, f"latency.delta.{label}",
                                     delta.get(label), paired)
            numeric += len(paired)
        expected_pairs = len({
            turn_id for turn_id, prod, chal in paired_index
            if isinstance(prod, (int, float)) and isinstance(chal, (int, float))
        })
        findings.check(delta.get("paired_turns") == expected_pairs, session, "aggregate",
                       "latency.delta.paired_turns",
                       "claims a different number of turns where both sides measured the turn",
                       expected_pairs, delta.get("paired_turns"))

    # The wait breakdown must not claim a share of a total it cannot see.
    budget = latency.get("budget") or {}
    for turn_id, item in (budget.get("turns") or {}).items():
        share = item.get("stt_share")
        parts = [item.get("stt_ms"), item.get("llm_ms"), item.get("tts_ms")]
        if share is not None:
            complete = all(isinstance(p, (int, float)) for p in parts)
            findings.check(complete, session, "invariant",
                           f"latency.budget.turns[{turn_id}].stt_share",
                           "publishes an STT share of the caller's wait without all three "
                           "components measured", "stt, llm and tts all measured", parts)
            if complete and sum(parts) > 0:
                findings.check(close(share, parts[0] / sum(parts), tol=1e-6), session, "aggregate",
                               f"latency.budget.turns[{turn_id}].stt_share",
                               "STT share does not equal the endpoint delay over the measured total",
                               parts[0] / sum(parts), share)
                numeric += 1
        if item.get("counterfactual_wait_ms") is not None:
            findings.check(isinstance(item.get("caller_wait_ms"), (int, float))
                           and isinstance(item.get("stt_ms"), (int, float)),
                           session, "invariant",
                           f"latency.budget.turns[{turn_id}].counterfactual_wait_ms",
                           "projects a counterfactual wait without a measured wait and endpoint "
                           "delay to base it on",
                           "measured wait and stt", (item.get("caller_wait_ms"), item.get("stt_ms")))

    # Turn-shape counts are claims about the turn table and must match it.
    shape = latency.get("shape") or {}
    if shape:
        def position_errors():
            for row in rows:
                value = (((row.get("production") or {}).get("timing")) or {}).get("endpoint_position_error_ms")
                if isinstance(value, (int, float)):
                    yield value

        premature = sum(1 for v in position_errors() if v < -ENDPOINT_POSITION_TOLERANCE_MS)
        late = sum(1 for v in position_errors() if v > ENDPOINT_POSITION_TOLERANCE_MS)
        missing = sum(1 for row in rows
                      if (((row.get("production") or {}).get("timing")) or {}).get("missing_final"))
        for label, expected in (("premature_count", premature), ("late_count", late),
                                ("missing_final_count", missing), ("measured_turns", len(rows))):
            findings.check(shape.get(label) == expected, session, "aggregate",
                           f"latency.shape.{label}",
                           "turn-shape count disagrees with the published turn table",
                           expected, shape.get(label))

    # Risk must never judge a turn whose production text was missing.
    for turn_id, verdict in ((payload.get("risk") or {}).get("turns") or {}).items():
        op = by_turn.get(str(turn_id))
        if op is None:
            continue
        findings.check(isinstance((op.get("response") or {}).get("transcript"), str), session,
                       "invariant", f"risk.turns[{turn_id}]",
                       "a semantic-risk verdict exists for a turn whose production transcript was "
                       "never captured, so the model judged an empty string",
                       "a captured transcript", (verdict or {}).get("risk"))

    return {"session": session, "operations": len(operations), "numeric": numeric,
            **findings.counts.get(session, {key: 0 for key in Findings.CATEGORIES})}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    # A clean checkout has no recorded calls: report zero sessions rather than
    # crashing, so the suite can skip instead of failing on a missing data dir.
    objects = ROOT / "data" / "objects"
    if args.session:
        sessions = [args.session]
    elif objects.is_dir():
        sessions = sorted(p.name for p in objects.iterdir() if p.is_dir())
    else:
        sessions = []

    findings = Findings()
    summaries = [validate_session(s, findings) for s in sessions]
    totals = findings.totals()

    if args.json:
        print(json.dumps({"sessions": summaries, "totals": totals,
                          "numeric": sum(s["numeric"] for s in summaries),
                          "failures": findings.items}, indent=2))
        return 1 if findings.items else 0

    print(f"{'session':10}{'turns':>6}{'evidence':>10}{'aggregate':>11}"
          f"{'absence':>9}{'invariant':>11}")
    for summary in summaries:
        print(f"{summary['session'][:8]:10}{summary['operations']:>6}{summary['evidence']:>10}"
              f"{summary['aggregate']:>11}{summary['absence']:>9}{summary['invariant']:>11}")

    print(f"\n{sum(totals.values())} checks across {len(summaries)} sessions:")
    print(f"  {totals['evidence']:>5} recomputed from the raw capture")
    print(f"  {totals['aggregate']:>5} aggregates rebuilt from the per-turn values")
    print(f"  {totals['absence']:>5} confirmed absent where no evidence exists")
    print(f"  {totals['invariant']:>5} internal-consistency rules")
    print(f"  {sum(s['numeric'] for s in summaries):>5} of these compare an actual measured number")

    if findings.items:
        print(f"\n{len(findings.items)} FAILED:\n")
        for item in findings.items:
            print(f"  [{item['session'][:8]}] {item['field']}")
            print(f"      {item['detail']}")
            print(f"      expected={item['expected']} actual={item['actual']}")
        return 1

    print("\nEvery published latency value is supported by the raw evidence.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
