"""Per-turn and per-call metric extraction for the aggregate dashboard.

Everything here is derived from the *same* functions the single-call view uses -
`group_turns` for the turn shape and `app.latency.production_turn_latency` for
the STT timings - so an aggregate percentile can always be traced back to the
operations a reviewer sees on the call page. A dashboard that computes its own
version of "time to first audio" will eventually disagree with the call it links
to, and at that point neither number can be trusted.

The other rule this module enforces is that a measurement that was not captured
is *absent*, never zero. Every stage metric returns either a number or `None`
with a reason code from `UNAVAILABLE_REASONS`, because milestone coverage varies
by SDK build: on the current corpus `first_token` exists on 50 of 393 LLM spans.
Treating the other 343 as "0 ms to first token" would report a fabricated,
excellent P50.
"""

from __future__ import annotations

import re

import math
from datetime import UTC, datetime
from typing import Any, Container, Iterable, Sequence

from app.latency import milestone_ms, production_turn_latency

# Metric-extraction schema version. Bumped when a stage definition changes so
# `initialize()` can detect rows built by an older definition and rebuild them
# instead of silently mixing two measurement contracts in one percentile.
METRICS_VERSION = 4

# An operation that stopped because something cancelled it is not a fault.
ABORT_NAMES = ("AbortError", "CancelledError", "CancelledException")

# Reasons a stage metric is unavailable. These are machine-readable so the UI can
# explain *why* a percentile is missing rather than rendering an empty cell.
UNAVAILABLE_REASONS = {
    "no_eligible_turns": "No turns in range produced this stage.",
    "milestone_not_captured": "This SDK build did not record the milestone this metric needs.",
    "not_independently_observed": "The start and end marks came from one event, so the gap would be fabricated.",
    "speech_onset_not_observed": "Word timestamps were not captured, so the caller's first word is unknown.",
    "below_minimum_sample": "Too few measured samples to report this value.",
    "stage_absent": "No operations of this stage were recorded in range.",
    "range_too_large_for_filter": "This filter is computed from raw turns, and the range holds too many "
                                  "to answer without a multi-second scan. Narrow the range.",
}

# P95 over a handful of samples is the maximum wearing a percentile's name. Below
# this the value is reported but flagged low-confidence; below MIN_SAMPLE_ANY
# nothing is reported at all.
MIN_SAMPLE_ANY = 1
MIN_SAMPLE_P50 = 5
MIN_SAMPLE_P95 = 20
MIN_SAMPLE_P95_STABLE = 100
# Period-over-period movement needs both sides to be stable before it is a claim
# about the agent rather than about the sample.
MIN_SAMPLE_DELTA = 30
# A turn whose reply took at least this long is one the caller noticed.
AUDIBLE_LAG_MS = 3000
# A tool needs this many invocations before it can be ranked "slowest".
MIN_TOOL_INVOCATIONS = 5

STAGES = ("stt", "llm", "tts", "tool")


def is_abort(op: dict[str, Any]) -> bool:
    error = op.get("error")
    name = error.get("name") if isinstance(error, dict) else None
    return name in ABORT_NAMES


def has_failed(op: dict[str, Any]) -> bool:
    """A genuine fault. A span aborted by barge-in is the agent behaving well."""
    return op.get("status") == "error" and not is_abort(op)


def is_interrupted(op: dict[str, Any]) -> bool:
    """Deliberate interruption: reported separately, never as a failure."""
    return op.get("status") == "cancelled" or (op.get("status") == "error" and is_abort(op))


PERCENTILE_METHOD = "nearest_rank"


def percentile(sorted_values: Sequence[float], fraction: float) -> float | None:
    """Nearest-rank on an ascending list: rank = ceil(p * n), 1-indexed.

    Every value this returns is a turn that actually happened. Interpolation
    would report "P95 = 2,840 ms" for a pair of turns that took 2,600 ms and
    3,100 ms - a number no caller experienced, on a dashboard whose entire job
    is to send a developer to the specific call behind it. Nearest-rank keeps
    "P95 = 3,100 ms" clickable and reproducible from the raw operations, which
    is what `/v1/dashboard/audit` verifies.

    The known cost is that at small n the P95 collapses onto the maximum. That
    is not hidden: `p95_confident` is false below MIN_SAMPLE_P95, and the UI
    labels it. The single-call STT view keeps its interpolating
    `app.evaluation.percentiles` because it is describing one call's ~11 turns
    rather than a fleet; the two are different scopes and the API states which
    method produced each number.
    """
    if not sorted_values:
        return None
    count = len(sorted_values)
    # Rounded before the ceiling because `fraction * count` is a binary float
    # and can land a hair above an integer: `0.017 * 3000` is 51.00000000000001,
    # so a raw `ceil` returns rank 52 instead of 51. None of the four fractions
    # this module currently publishes (0.5, 0.9, 0.95, 0.99) trip it at any n up
    # to a million - verified in tests/test_metrics.py - but the guard is what
    # keeps that true for whatever percentile is added next. A metric whose
    # definition shifts by a rank depending on how many turns happened would be
    # diagnosed as a flaky dashboard rather than as an arithmetic error.
    rank = math.ceil(round(fraction * count, 9))
    return float(sorted_values[max(1, min(count, rank)) - 1])


def distribution(values: Iterable[Any], *, reason: str = "milestone_not_captured") -> dict[str, Any]:
    """P50/P95 plus the sample size that earns them, or an explicit absence."""
    measured = sorted(
        float(value)
        for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0
    )
    if len(measured) < MIN_SAMPLE_ANY:
        return {
            "available": False, "reason": reason, "count": 0, "method": PERCENTILE_METHOD,
            "p50": None, "p95": None, "p99": None, "p90": None, "max": None, "min": None, "mean": None,
            "p50_confident": False, "p95_confident": False, "p95_stable": False,
        }
    return {
        "available": True,
        "reason": None,
        "count": len(measured),
        "method": PERCENTILE_METHOD,
        "p50": round(percentile(measured, 0.5)),
        "p95": round(percentile(measured, 0.95)),
        "p99": round(percentile(measured, 0.99)),
        "p90": round(percentile(measured, 0.9)),
        "max": round(measured[-1]),
        "min": round(measured[0]),
        "mean": round(sum(measured) / len(measured)),
        # A P95 from 6 samples is the 6th-worst turn, not a tail estimate. Below
        # the stable floor the honest range for the tail is [p90, max], which the
        # UI shows instead of a single confident-looking number.
        "p50_confident": len(measured) >= MIN_SAMPLE_P50,
        "p95_confident": len(measured) >= MIN_SAMPLE_P95,
        "p95_stable": len(measured) >= MIN_SAMPLE_P95_STABLE,
    }


def rate(numerator: int, denominator: int) -> dict[str, Any]:
    if not denominator:
        return {"available": False, "reason": "stage_absent", "rate": None, "count": numerator, "eligible": 0}
    return {
        "available": True, "reason": None,
        "rate": numerator / denominator, "count": numerator, "eligible": denominator,
    }


def epoch_ms(started_at: Any) -> int | None:
    if not isinstance(started_at, str) or not started_at:
        return None
    try:
        text = started_at.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return round(parsed.timestamp() * 1000)


def _tokens(op: dict[str, Any], *names: str) -> int | None:
    response = op.get("response")
    if not isinstance(response, dict):
        return None
    for name in names:
        value = response.get(name)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return round(value)
    return None


def _first(ops: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    return ops[0] if ops else None


# Vendors seen in capture. A token match against this list is what collapses
# `deepgram-stt`, `Deepgram` and `deepgram-tts` into one series, and what pulls
# the vendor out of an Azure host name. An unrecognised vendor still passes
# through under its own normalised name, so onboarding a new provider does not
# require a code change - the list only decides what gets *merged*.
KNOWN_PROVIDERS = (
    "deepgram", "elevenlabs", "openai", "azure", "sarvam", "google", "anthropic",
    "cartesia", "assemblyai", "groq", "aws", "whisper", "rime", "playht", "resemble",
)
# Endpoint ids that name a pipeline stage rather than a vendor. Publishing these
# as providers puts "llm" in a provider filter next to "openai", which reads as
# authoritative and is not.
GENERIC_ENDPOINT_IDS = {"llm", "stt", "tts", "asr", "speech", "voice", "tool", "agent", "default"}
# Checked before the single-vendor match, because these values name a vendor
# combination. Azure OpenAI is not OpenAI: same models, different region,
# different queue, materially different latency - merging them into `openai`
# would hide a regression in one behind healthy traffic from the other.
PROVIDER_ALIASES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("azure", "openai"), "azure-openai"),
    (("cognitive", "microsoft"), "azure-openai"),
)


def canonical_provider(raw: Any) -> str | None:
    """One provider name per vendor, or nothing when the value names no vendor.

    Capture is dirty in three specific ways, all observed in production: the
    same vendor arrives as `deepgram`, `deepgram-stt` and `deepgram-tts`; Azure
    arrives as a host name (`eastus.api.cognitive.microsoft.com`); and some spans
    carry only a stage name (`llm`). Left alone, a `provider=deepgram` filter
    silently drops the 170 turns filed under the other two spellings - a filter
    that quietly returns the wrong population is worse than one that is empty.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = re.sub(r"[^a-z0-9]+", " ", raw.strip().lower()).strip()
    if not text:
        return None
    tokens = text.split()
    for needles, canonical in PROVIDER_ALIASES:
        if all(any(needle in token for token in tokens) for needle in needles):
            return canonical
    for vendor in KNOWN_PROVIDERS:
        if vendor in tokens or any(vendor in token for token in tokens):
            return vendor
    if set(tokens) & GENERIC_ENDPOINT_IDS and len(tokens) == 1:
        return None
    # A host name that names no known vendor is an endpoint address, not a
    # provider identity, and would add one facet value per deployment.
    if "." in raw and len(tokens) > 1:
        return None
    return "-".join(tokens)


def _identity(op: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """Provider and model, canonicalized so one vendor is one series.

    `endpoint_id` is used only when it names a real vendor. Falling back to it
    unconditionally kept every span in a named group, but did so by inventing
    providers called `llm` and `stt` and by splitting Deepgram three ways.
    """
    if not op:
        return None, None
    provider = canonical_provider(op.get("provider")) or canonical_provider(op.get("endpoint_id"))
    model = op.get("model")
    model = model.strip().lower() if isinstance(model, str) and model.strip() else None
    return provider, model


def llm_ttft_ms(op: dict[str, Any]) -> int | None:
    """Request start to first streamed token, only where the milestone exists.

    `duration_ms` is not a stand-in. A 2 s completion can be 200 ms to first
    token with a long stream, or 1.9 s of silence then a burst; those are
    opposite experiences for the caller and the dashboard must not merge them.
    """
    at = milestone_ms(op, "first_token", "first_output_token")
    start = op.get("started_at_ms")
    if at is None or not isinstance(start, (int, float)) or at < start:
        return None
    return round(at - start)


def tts_first_audio_ms(op: dict[str, Any]) -> int | None:
    """Request start to the first playable audio chunk.

    `first_byte` is accepted as a fallback because on websocket TTS the first
    inbound frame *is* the first audio; `speak` is not, because it is the
    outbound request frame and would report the network write, not the wait.
    """
    at = milestone_ms(op, "audio_chunk", "first_byte")
    start = op.get("started_at_ms")
    if at is None or not isinstance(start, (int, float)) or at < start:
        return None
    return round(at - start)


def tts_synthesis_ms(op: dict[str, Any]) -> int | None:
    """How long the provider took to synthesize, or nothing.

    A *derived* span is reconstructed by the SDK when the TTS plugin emitted no
    metric at all, and its extent is the reply's playout window -- seconds of
    the caller listening, not the provider working. Charting that as synthesis
    latency would report a p95 an order of magnitude above the truth, in the
    same column as real measurements and indistinguishable from them. A missing
    value is read as "not measured", which is exactly what it is.
    """
    if (op.get("request") or {}).get("derived_from"):
        return None
    duration = op.get("duration_ms")
    return duration if isinstance(duration, (int, float)) else None


def turn_metrics(turn: dict[str, Any], call_started_epoch_ms: int | None) -> dict[str, Any]:
    """One flat, indexable row of measurements for a single turn.

    `response_latency_ms` is taken straight from `group_turns`, which is the same
    value the call page prints beside the turn. It is deliberately not recomputed
    here.
    """
    ops = [op for op in turn.get("operations", []) if op.get("scope", "turn") != "connection"]
    stt_ops = [op for op in ops if op.get("type") == "stt"]
    llm_ops = [op for op in ops if op.get("type") == "llm"]
    tts_ops = [op for op in ops if op.get("type") == "tts"]
    tool_ops = [op for op in ops if op.get("type") == "tool"]

    stt = _first(stt_ops)
    tts = _first(tts_ops)
    # Framework spans carry TTFT and tokens; transport spans do not. Prefer a
    # span that actually has the milestone so an HTTP-only duplicate does not
    # hide a measured first-token value behind an unmeasured one.
    llm = next((op for op in llm_ops if llm_ttft_ms(op) is not None), _first(llm_ops))

    stt_latency = production_turn_latency(stt, turn) if stt else {}
    stt_provider, stt_model = _identity(stt)
    llm_provider, llm_model = _identity(llm)
    tts_provider, tts_model = _identity(tts)

    started_at_ms = turn.get("started_at_ms") or 0
    tool_durations = [op.get("duration_ms") for op in tool_ops if isinstance(op.get("duration_ms"), (int, float))]

    return {
        "turn_id": str(turn.get("turn_id")),
        # Carried so the call rollup can tell one exchange we recorded as two
        # rows from two exchanges. Without it the split is visible on the page
        # and invisible in every number derived from the page.
        "continues_turn": turn.get("continues_turn"),
        "is_continuation": 1 if turn.get("continues_turn") else 0,
        "started_at_ms": started_at_ms,
        "started_at_epoch_ms": (call_started_epoch_ms + started_at_ms) if call_started_epoch_ms is not None else None,
        "duration_ms": turn.get("duration_ms"),
        # Overall: caller stops speaking -> first audible agent audio.
        "response_latency_ms": turn.get("time_to_first_audio_ms"),
        # STT, from the shared per-turn measurement used by the call page.
        # First-partial is only reported when the speech region came from word
        # timestamps. Without them the region starts where the recogniser opened
        # its listening window, which on this corpus precedes the caller's first
        # word by up to ten seconds - the metric would read as a catastrophically
        # slow recogniser when nothing was slow at all.
        "stt_first_partial_ms": (
            stt_latency.get("time_to_first_partial_ms")
            if stt_latency.get("region_from_word_timestamps") else None
        ),
        "stt_first_partial_unmeasurable_reason": (
            None if stt_latency.get("region_from_word_timestamps")
            else ("speech_onset_not_observed" if stt else "stage_absent")
        ),
        "stt_endpoint_delay_ms": stt_latency.get("endpoint_delay_ms"),
        "stt_final_ms": stt_latency.get("final_from_last_word_ms"),
        "stt_missing_final": 1 if stt and stt_latency.get("missing_final") else 0,
        "stt_forced_flush": 1 if stt and stt_latency.get("forced_flush") else 0,
        "stt_endpoint_unmeasurable_reason": stt_latency.get("endpoint_unmeasurable_reason"),
        # LLM.
        "llm_ttft_ms": llm_ttft_ms(llm) if llm else None,
        "llm_completion_ms": llm.get("duration_ms") if llm else None,
        "llm_input_tokens": _tokens(llm, "prompt_tokens", "input_tokens") if llm else None,
        "llm_output_tokens": _tokens(llm, "completion_tokens", "output_tokens") if llm else None,
        # TTS: synthesis is the provider span, never playback duration.
        "tts_first_audio_ms": tts_first_audio_ms(tts) if tts else None,
        "tts_synthesis_ms": tts_synthesis_ms(tts) if tts else None,
        # Tools.
        "tool_count": len(tool_ops),
        "tool_total_ms": round(sum(tool_durations)) if tool_durations else None,
        # Reliability, per stage, counted over the operations that ran.
        "stt_ops": len(stt_ops), "llm_ops": len(llm_ops), "tts_ops": len(tts_ops), "tool_ops": len(tool_ops),
        "stt_failed": sum(1 for op in stt_ops if has_failed(op)),
        "llm_failed": sum(1 for op in llm_ops if has_failed(op)),
        "tts_failed": sum(1 for op in tts_ops if has_failed(op)),
        "tool_failed": sum(1 for op in tool_ops if has_failed(op)),
        "tts_interrupted": sum(1 for op in tts_ops if is_interrupted(op)),
        "stt_provider": stt_provider, "stt_model": stt_model,
        "llm_provider": llm_provider, "llm_model": llm_model,
        "tts_provider": tts_provider, "tts_model": tts_model,
    }


def tool_rows(turn: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for op in turn.get("operations", []):
        if op.get("type") != "tool" or op.get("scope") == "connection":
            continue
        request = op.get("request") if isinstance(op.get("request"), dict) else {}
        name = request.get("name") or op.get("endpoint_id") or "unnamed"
        result.append({
            "turn_id": str(turn.get("turn_id")),
            "tool_name": str(name)[:120],
            "duration_ms": op.get("duration_ms") if isinstance(op.get("duration_ms"), (int, float)) else None,
            "failed": 1 if has_failed(op) else 0,
            "timed_out": 1 if _is_timeout(op) else 0,
        })
    return result


def _is_timeout(op: dict[str, Any]) -> bool:
    error = op.get("error")
    if not isinstance(error, dict) or not has_failed(op):
        return False
    name = str(error.get("name") or "").lower()
    message = str(error.get("message") or "").lower()
    return "timeout" in name or "timedout" in name or "timed out" in message or "etimedout" in message


def error_fingerprint(op: dict[str, Any]) -> str | None:
    """A low-cardinality label for a failure.

    Only the error *name* and stage are kept. Provider messages routinely embed
    request ids, prompts and phone numbers; grouping on them would both explode
    cardinality and copy call content into an aggregate table that has none of
    the per-call access controls.
    """
    if not has_failed(op):
        return None
    error = op.get("error") if isinstance(op.get("error"), dict) else {}
    name = str(error.get("name") or "").strip() or "UnknownError"
    return f"{op.get('type')}:{name}"[:120]


def folds_into_present_parent(continues_turn: Any, present_turn_ids: Container[str]) -> bool:
    """Whether a row is a half of a split we can actually put back together.

    The SDK marks the second half of a turn it split because the caller's
    earlier words were already published. Every counter then subtracts those
    halves so one exchange is counted once. That is only right when the first
    half is present: a package that lost a span, or any view showing a slice of
    a call, leaves a continuation whose parent is nowhere. Subtracting it there
    reported a call with a turn as having no turns -- which also hid the call
    from the unmeasured-call check, since that keys off `turn_count > 0`.

    One rule in one place, because the browser, the call rollup and the ingest
    columns every SQL counter reads all have to reach the same answer. They
    disagreed once already, which is worse than the bug it was fixing.
    """
    return bool(continues_turn) and str(continues_turn) in present_turn_ids


def resolve_split_columns(rows: Sequence[dict[str, Any]]) -> Sequence[dict[str, Any]]:
    """Fill in the columns that can only be decided by looking at sibling rows.

    `turn_metrics` sees one turn at a time, but whether a row folds into
    another -- and which stages that doubles -- are facts about a pair. Deriving
    them at ingest and nowhere else meant the drift audit, which recomputes row
    by row, reported every split call as permanently tampered. One function, so
    the cache and the check that proves the cache still agree by construction.
    """
    by_id = {str(row["turn_id"]): row for row in rows if row.get("turn_id")}
    for row in rows:
        parent = (by_id.get(str(row["continues_turn"]))
                  if folds_into_present_parent(row.get("continues_turn"), by_id) else None)
        row["is_continuation"] = int(parent is not None)
        # A stage inflates its own denominator only if it ran on both halves.
        # The first half of a split is usually speech-to-text and nothing else,
        # but it can carry a filler reply, so which stages doubled is a fact
        # about these two rows rather than something to assume.
        for stage in STAGES:
            row[f"{stage}_split"] = int(
                parent is not None
                and (row.get(f"{stage}_ops") or 0) > 0
                and (parent.get(f"{stage}_ops") or 0) > 0)
    return rows


def call_metrics(turns: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Call-level rollups derived from the turn rows, so the two always agree."""
    # A turn we split because the earlier half was already published is one
    # exchange, not two. Counting the physical rows inflated `turn_count` and
    # every per-turn average derived from it -- the UI already labels the split,
    # but a label does not fix a denominator.
    #
    # A row only folds into a row we actually have. Subtracting every
    # continuation unconditionally meant a package whose first half was missing
    # reported `turn_count: 0` for a call that plainly had a turn, which also
    # hid it from the unmeasured-call check -- that keys off `turn_count > 0`.
    present = {str(turn["turn_id"]) for turn in turns if turn.get("turn_id")}
    continuations = sum(
        1 for turn in turns
        if folds_into_present_parent(turn.get("continues_turn"), present)
    )
    return {
        "turn_count": len(turns) - continuations,
        "split_turn_count": continuations,
        "stt_failed": sum(turn["stt_failed"] for turn in turns),
        "llm_failed": sum(turn["llm_failed"] for turn in turns),
        "tts_failed": sum(turn["tts_failed"] for turn in turns),
        "tool_failed": sum(turn["tool_failed"] for turn in turns),
        "failed_op_count": sum(
            turn["stt_failed"] + turn["llm_failed"] + turn["tts_failed"] + turn["tool_failed"] for turn in turns
        ),
        "audible_lag_turns": sum(
            1 for turn in turns
            if isinstance(turn["response_latency_ms"], (int, float)) and turn["response_latency_ms"] >= AUDIBLE_LAG_MS
        ),
        "measured_response_turns": sum(
            1 for turn in turns if isinstance(turn["response_latency_ms"], (int, float))
        ),
        "missing_final_turns": sum(turn["stt_missing_final"] for turn in turns),
        "max_response_latency_ms": max(
            (turn["response_latency_ms"] for turn in turns
             if isinstance(turn["response_latency_ms"], (int, float))),
            default=None,
        ),
    }
