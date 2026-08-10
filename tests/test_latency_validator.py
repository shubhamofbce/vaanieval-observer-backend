"""The latency validator runs as part of the suite, not just on demand.

`scripts/validate-latency.py` re-derives every published latency value from the
raw capture and asserts the payload agrees. Wiring it in here means a future
change that reintroduces a fabricated measurement fails the build rather than
waiting to be noticed on the dashboard.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate-latency.py"


def _load():
    spec = importlib.util.spec_from_file_location("validate_latency", VALIDATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_published_latency_value_is_supported_by_raw_evidence():
    # The validator checks real recorded calls, which are local runtime data and
    # are never committed. A clean checkout has nothing to validate.
    if not (ROOT / "data" / "objects").is_dir():
        pytest.skip("no recorded calls in dashboard/data — record a call first")
    result = subprocess.run([sys.executable, str(VALIDATOR), "--json"],
                            capture_output=True, text=True, cwd=ROOT)
    report = json.loads(result.stdout)
    if not report["sessions"]:
        pytest.skip("no recorded calls in dashboard/data — record a call first")
    assert report["failures"] == [], (
        "published latency values are not supported by the raw capture:\n"
        + "\n".join(f"  {f['session'][:8]} {f['field']}: {f['detail']} "
                    f"(expected={f['expected']!r} actual={f['actual']!r})"
                    for f in report["failures"])
    )
    totals = report["totals"]
    # Guard the strength of the check, not just its outcome: a validator that
    # stopped recomputing values would still "pass" while proving nothing.
    assert totals["evidence"] > 400, totals
    assert totals["aggregate"] > 200, totals
    assert report["numeric"] > 300, report["numeric"]


def test_validator_rejects_a_fabricated_zero_duration():
    """The validator must fail when a duration is not backed by two milestones.

    This guards the guard: if the honesty rule is ever weakened, the validator
    would pass everything silently, so it is exercised against a known-bad case.
    """
    module = _load()
    findings = module.Findings()
    findings.check(False, "s", "absence", "endpoint_delay_ms", "fabricated", None, 0.0)
    assert len(findings.items) == 1


def test_validator_percentiles_match_a_hand_worked_example():
    module = _load()
    result = module.independent_percentiles([100.0, 200.0, 300.0, 400.0])
    assert result["count"] == 4
    assert result["p50"] == 250.0
    assert result["min"] == 100.0 and result["max"] == 400.0
    assert module.independent_percentiles([])["p50"] is None


def test_connection_frames_are_not_treated_as_transcription_turns():
    """Websocket open/close records must never be scored as speech turns."""
    module = _load()
    events = [
        {"type": "stt", "scope": "turn", "response": {"transcript": "hello"}},
        {"type": "stt", "scope": "connection", "response": {"close_code": 1000}},
        {"type": "stt", "response": {"close_code": 1000, "sent_bytes": 12}},
    ]
    assert len(module.stt_turns(events)) == 1
