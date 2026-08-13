"""Tests for the alert rules.

The rules are the one place in the demo where the product asserts a judgement -
"this is bad enough to wake someone" - so the tests are about the judgement, not
the plumbing: that a rule stays silent when it cannot measure, that it does not
fire off two calls, and that the reported excess ranks a bad breach above a
marginal one.
"""

from __future__ import annotations

from typing import Any

from app import alerts


def summary(
    *,
    calls: int = 10,
    lag_rate: float = 0.1,
    lag_eligible: int = 40,
    lag_available: bool = True,
    failure_rate: float = 0.0,
    p95: float | None = 4000,
    p95_confident: bool = True,
    turns: int = 100,
    measured: int = 90,
) -> dict[str, Any]:
    return {
        "overview": {
            "audible_lag": {
                "available": lag_available, "rate": lag_rate,
                "eligible": lag_eligible, "reason": None if lag_available else "no timings",
            },
            "failure_impacted_calls": {"available": True, "rate": failure_rate},
            "response_latency": {
                "available": p95 is not None, "p95": p95,
                "p95_confident": p95_confident, "reason": None,
            },
        },
        "coverage": {
            "calls": calls, "turns_in_range": turns,
            "measured_response_turns": measured,
        },
    }


def rule(rule_id: str) -> alerts.Rule:
    return next(r for r in alerts.RULES if r.id == rule_id)


class TestFiring:
    def test_lag_over_threshold_fires_critical(self) -> None:
        result = alerts.evaluate(rule("audible-lag"), summary(lag_rate=0.4))
        assert result["state"] == "firing"
        assert result["severity"] == "critical"
        assert "40%" in result["observed_label"]

    def test_lag_at_threshold_does_not_fire(self) -> None:
        """The threshold is the last acceptable value, not the first bad one."""
        result = alerts.evaluate(rule("audible-lag"), summary(lag_rate=0.25))
        assert result["state"] == "ok"
        assert result["severity"] == "none"

    def test_excess_ranks_a_bad_breach_above_a_marginal_one(self) -> None:
        bad = alerts.evaluate(rule("audible-lag"), summary(lag_rate=0.50))
        marginal = alerts.evaluate(rule("audible-lag"), summary(lag_rate=0.26))
        assert bad["excess"] > marginal["excess"]

    def test_latency_rule_reports_seconds(self) -> None:
        result = alerts.evaluate(rule("worst-case-wait"), summary(p95=12000))
        assert result["state"] == "firing"
        assert result["observed_label"] == "12.0s at p95"
        assert result["threshold_label"] == "over 8.0s"


class TestSilence:
    def test_a_thin_agent_cannot_fire(self) -> None:
        """Two bad calls is an anecdote. Firing on it would teach a visitor to
        distrust the page, which costs more than the missed alert."""
        result = alerts.evaluate(rule("audible-lag"), summary(calls=2, lag_rate=0.9))
        assert result["state"] == "unknown"
        assert "2 calls" in result["reason"]

    def test_unmeasurable_lag_says_so_rather_than_reporting_zero(self) -> None:
        result = alerts.evaluate(rule("audible-lag"), summary(lag_available=False))
        assert result["state"] == "unknown"
        assert result["observed"] is None
        assert result["reason"] == "no timings"

    def test_thin_lag_sample_is_not_a_measurement(self) -> None:
        result = alerts.evaluate(rule("audible-lag"), summary(lag_eligible=4, lag_rate=1.0))
        assert result["state"] == "unknown"
        assert result["reason"] == "too few measured turns"

    def test_unstable_p95_is_withheld(self) -> None:
        result = alerts.evaluate(
            rule("worst-case-wait"), summary(p95=20000, p95_confident=False))
        assert result["state"] == "unknown"
        assert "p95" in result["reason"]

    def test_coverage_rule_needs_enough_turns(self) -> None:
        result = alerts.evaluate(
            rule("blind-turns"), summary(turns=10, measured=0))
        assert result["state"] == "unknown"


class TestShape:
    def test_every_rule_points_at_a_real_drilldown(self) -> None:
        from app import aggregate
        for each in alerts.RULES:
            assert each.selector in aggregate.DRILLDOWNS, each.id

    def test_every_rule_explains_itself_without_jargon(self) -> None:
        for each in alerts.RULES:
            assert each.question.endswith("."), each.id
            assert "p95" not in each.label.lower(), each.id

    def test_rule_ids_are_unique(self) -> None:
        ids = [each.id for each in alerts.RULES]
        assert len(ids) == len(set(ids))
