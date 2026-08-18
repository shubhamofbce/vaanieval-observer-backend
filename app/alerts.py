"""Fleet alerts, evaluated from the same aggregate the dashboard reads.

The alternative was a page of invented incidents. It would have been quicker and
it would have been worthless: the moment a visitor clicked an alert and found
calls that did not match it, every other number on the site becomes suspect.

So an alert here is a question asked of the real data. The rules are fixed - a
visitor cannot create one, because the demo takes no writes - but each one is
evaluated per agent over the published window, and the calls it links to are the
calls that actually breached it. An alert that says a channel answers late is
followed by the recordings of it answering late.

Rules are intentionally few. A page of thirty thresholds is a monitoring product
nobody reads; these four are the ones a voice team is woken up for.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

# How long an agent must have been breaching before the rule is considered
# firing rather than noisy. Expressed in calls, not minutes: a voice fleet with
# four calls an hour cannot support a five-minute window.
MINIMUM_CALLS = 3


@dataclass(frozen=True)
class Rule:
    id: str
    label: str
    """What the rule watches, in the words an on-call engineer would use."""
    question: str
    """Why it matters, one sentence, no jargon."""
    threshold: float
    unit: str
    severity: str
    """`critical` pages someone; `warning` waits for the morning."""
    selector: str
    """Which call list answers "show me the ones that did this"."""
    read: Callable[[dict[str, Any]], tuple[float | None, str | None]]
    """Pulls the observed value out of a dashboard summary, or says why it can't."""
    describe: Callable[[float], str]


def _rate(value: float) -> str:
    return f"{value * 100:.0f}%"


def _seconds(value: float) -> str:
    return f"{value / 1000:.1f}s"


def _read_lag(summary: dict[str, Any]) -> tuple[float | None, str | None]:
    block = summary["overview"]["audible_lag"]
    if not block.get("available"):
        return None, block.get("reason") or "not measurable"
    if int(block.get("eligible") or 0) < 10:
        return None, "too few measured turns"
    return float(block["rate"]), None


def _read_failures(summary: dict[str, Any]) -> tuple[float | None, str | None]:
    block = summary["overview"]["failure_impacted_calls"]
    if not block.get("available"):
        return None, block.get("reason") or "not measurable"
    return float(block["rate"]), None


def _read_p95(summary: dict[str, Any]) -> tuple[float | None, str | None]:
    block = summary["overview"]["response_latency"]
    if not block.get("available") or block.get("p95") is None:
        return None, block.get("reason") or "not measurable"
    if not block.get("p95_confident"):
        return None, "not enough measured turns for a p95"
    return float(block["p95"]), None


def _read_unmeasurable(summary: dict[str, Any]) -> tuple[float | None, str | None]:
    """Share of turns the SDK could not time.

    This one is about the instrumentation, not the agent. A team that cannot
    see its own latency has a bigger problem than a slow reply, and it is the
    failure mode most often discovered far too late.
    """
    coverage = summary["coverage"]
    turns = int(coverage.get("turns_in_range") or 0)
    measured = int(coverage.get("measured_response_turns") or 0)
    if turns < 20:
        return None, "too few turns in range"
    return (turns - measured) / turns, None


RULES: tuple[Rule, ...] = (
    Rule(
        id="audible-lag",
        label="Callers waiting more than 3 seconds",
        question="Silence on a phone line is the failure a caller actually notices.",
        threshold=0.25, unit="rate", severity="critical", selector="audible_lag",
        read=_read_lag, describe=lambda v: f"{_rate(v)} of measured turns",
    ),
    Rule(
        id="failed-calls",
        label="Calls hitting a provider error",
        question="A failed model or speech call is a conversation that broke mid-sentence.",
        threshold=0.05, unit="rate", severity="critical", selector="failures",
        read=_read_failures, describe=lambda v: f"{_rate(v)} of calls",
    ),
    Rule(
        id="worst-case-wait",
        label="Worst-case reply wait over 8 seconds",
        question="The tail is what gets escalated, not the average.",
        threshold=8000, unit="ms", severity="warning", selector="slowest",
        read=_read_p95, describe=lambda v: f"{_seconds(v)} at p95",
    ),
    Rule(
        id="blind-turns",
        label="Turns the SDK could not time",
        question="An agent you cannot measure is an agent you cannot fix.",
        threshold=0.40, unit="rate", severity="warning", selector="unmeasured",
        read=_read_unmeasurable, describe=lambda v: f"{_rate(v)} of turns",
    ),
)


def evaluate(rule: Rule, summary: dict[str, Any]) -> dict[str, Any]:
    """Apply one rule to one agent's summary."""
    observed, reason = rule.read(summary)
    calls = int(summary["coverage"].get("calls") or 0)
    if observed is None or calls < MINIMUM_CALLS:
        state = "unknown"
        if calls < MINIMUM_CALLS and observed is not None:
            reason = f"only {calls} call{'s' if calls != 1 else ''} in range"
    else:
        state = "firing" if observed > rule.threshold else "ok"
    return {
        "rule_id": rule.id,
        "label": rule.label,
        "question": rule.question,
        "severity": rule.severity if state == "firing" else "none",
        "state": state,
        "reason": reason,
        "observed": observed,
        "observed_label": rule.describe(observed) if observed is not None else None,
        "threshold": rule.threshold,
        "threshold_label": (
            f"over {_rate(rule.threshold)}" if rule.unit == "rate"
            else f"over {_seconds(rule.threshold)}"
        ),
        "unit": rule.unit,
        "selector": rule.selector,
        # How far past the line it is, so the page can sort by "how bad" rather
        # than by rule order and put the worst breach at the top.
        "excess": (
            (observed - rule.threshold) / rule.threshold
            if state == "firing" and rule.threshold else None
        ),
        "calls_in_range": calls,
    }
