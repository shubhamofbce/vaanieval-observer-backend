"""The percentile and distribution contract.

These are unit tests on `app.metrics` because the whole dashboard rests on
them: every percentile on the page, in both the exact and the sketch path,
resolves to `metrics.percentile`. A silent change here would move numbers on
every panel at once with nothing to catch it.
"""

from __future__ import annotations

import math

import pytest

from app import metrics


def test_percentile_uses_nearest_rank_not_interpolation():
    values = [10.0, 20.0, 30.0, 40.0]
    # Nearest rank returns a value that was actually observed. Interpolation
    # would return 25 for the median here - a latency no turn ever had.
    assert metrics.percentile(values, 0.5) == 20
    assert metrics.percentile(values, 0.95) == 40
    assert metrics.percentile(values, 0.0) == 10
    assert metrics.percentile(values, 1.0) == 40


def test_percentile_float_guard_is_real_but_never_fires_for_shipped_fractions():
    """Two claims, both of which have to stay true.

    First, the guard is not superstition: `fraction * count` is a binary float
    and can land a hair above an integer, which would silently shift the
    reported rank by one for particular sample sizes only.

    Second - and this is the claim that protects today's numbers - none of the
    fractions this module actually publishes trips it at any sample size a
    fleet will reach. If a future percentile is added and this test starts
    failing on the second half, that percentile needs the guard.
    """
    assert repr(0.017 * 3000) == "51.00000000000001"
    assert math.ceil(0.017 * 3000) == 52  # the trap
    assert math.ceil(round(0.017 * 3000, 9)) == 51  # what the code does

    for fraction in (0.5, 0.9, 0.95, 0.99):
        for n in (5, 20, 40, 100, 999, 1000, 10_000, 99_999, 1_000_000):
            assert math.ceil(fraction * n) == math.ceil(round(fraction * n, 9)), (fraction, n)


def test_distribution_is_order_independent():
    """`percentile` takes a pre-sorted sequence; `distribution` is the sorter.

    Since the exact path builds its list by scanning rows in whatever order
    SQLite returns them, the guarantee that matters is at this level.
    """
    import random

    values = [float(i) for i in range(1, 201)]
    shuffled = values[:]
    random.Random(7).shuffle(shuffled)
    assert metrics.distribution(shuffled)["p95"] == metrics.distribution(values)["p95"]
    assert metrics.distribution(shuffled)["p50"] == metrics.distribution(values)["p50"]


def test_percentile_of_empty_is_none_not_zero():
    assert metrics.percentile([], 0.5) is None


def test_distribution_reports_unavailable_rather_than_zero():
    result = metrics.distribution([])
    assert result["available"] is False
    # The caller supplies the reason; the default says the milestone was never
    # recorded, which is the common case for a partially instrumented SDK.
    assert result["reason"] == "milestone_not_captured"
    assert result["reason"] in metrics.UNAVAILABLE_REASONS
    # The point of the whole design: no key claims a value of 0.
    assert result.get("p50") is None
    assert result.get("p95") is None


def test_distribution_confidence_flags_track_the_thresholds():
    small = metrics.distribution([1.0] * (metrics.MIN_SAMPLE_P50 - 1))
    assert small["available"] is True
    assert small["p50_confident"] is False
    assert small["p95_confident"] is False

    mid = metrics.distribution([1.0] * metrics.MIN_SAMPLE_P95)
    assert mid["p50_confident"] is True
    assert mid["p95_confident"] is True
    assert mid["p95_stable"] is False

    large = metrics.distribution([1.0] * metrics.MIN_SAMPLE_P95_STABLE)
    assert large["p95_stable"] is True


def test_distribution_carries_the_caller_supplied_reason():
    result = metrics.distribution([], reason="stage_absent")
    assert result["available"] is False
    assert result["reason"] == "stage_absent"


def test_distribution_reports_the_method_it_used():
    result = metrics.distribution([1.0, 2.0, 3.0, 4.0, 5.0])
    assert result["method"] == "nearest_rank"


def test_rate_of_empty_population_is_unavailable_not_zero():
    """0/0 is not 0%.

    A stage with no operations has no failure rate. Rendering one as "0.0%"
    tells a developer their TTS is healthy when in fact it never ran.
    """
    result = metrics.rate(0, 0)
    assert result["available"] is False
    assert result["rate"] is None

    real = metrics.rate(1, 4)
    assert real["available"] is True
    assert real["rate"] == pytest.approx(0.25)
    assert real["count"] == 1
    assert real["eligible"] == 4


def test_abort_is_not_a_failure():
    """Barge-in cancellation is the pipeline working, not breaking.

    If deliberate cancellation counted as an error, an agent that interrupts
    well would look like an agent that is failing, and the failure rate would
    stop meaning anything.
    """
    for name in metrics.ABORT_NAMES:
        cancelled = {"status": "error", "error": {"name": name, "message": "cancelled"}}
        assert metrics.is_abort(cancelled) is True
        assert metrics.has_failed(cancelled) is False

    genuine = {"status": "error", "error": {"name": "ReadTimeout", "message": "upstream timeout"}}
    assert metrics.is_abort(genuine) is False
    assert metrics.has_failed(genuine) is True


def test_error_fingerprint_excludes_provider_message_text():
    """Fingerprints are stage plus error type only.

    Provider messages carry transcript fragments and unbounded cardinality;
    both belong nowhere near an aggregate table that has no per-call access
    control.
    """
    op = {"type": "llm", "status": "error",
          "error": {"name": "ReadTimeout",
                    "message": "timed out while the caller said 'my card number is 4111'"}}
    fingerprint = metrics.error_fingerprint(op)
    assert fingerprint == "llm:ReadTimeout"
    assert "card" not in fingerprint
    assert "4111" not in fingerprint


def test_provider_names_collapse_to_one_vendor_per_row():
    """A provider filter is useless if one vendor appears under five names.

    The capture carries whatever the integration happened to set: a stage name,
    a full Azure host, a vendor-plus-stage suffix. All of those are the same
    vendor to the person reading the dashboard, and splitting them silently
    divides that vendor's traffic across rows that each look small.
    """
    assert metrics.canonical_provider("deepgram-tts") == "deepgram"
    assert metrics.canonical_provider("Deepgram STT") == "deepgram"
    assert metrics.canonical_provider("azure openai") == "azure-openai"
    assert metrics.canonical_provider("my-demo-resource.openai.azure.com") == "azure-openai"

    # Azure Speech and Azure OpenAI are different services with different
    # latency characteristics; merging them would hide a regression in one.
    assert metrics.canonical_provider("azure") == "azure"

    # A stage name is not a vendor, and neither is an unattributable host.
    assert metrics.canonical_provider("stt") is None
    assert metrics.canonical_provider("llm") is None
    assert metrics.canonical_provider("") is None

    # An unrecognised vendor keeps its own identity - onboarding a new provider
    # must not require a code change to appear on the dashboard.
    assert metrics.canonical_provider("Cartesia") == "cartesia"
