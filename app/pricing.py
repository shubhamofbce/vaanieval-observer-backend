"""Cost model for an STT switch decision.

Rates are configuration, never inference. They live in `pricing.json` beside the
data directory so a reviewer can correct them, and every figure carries a
provenance flag so "estimated at list price" is never mistaken for an invoice.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PRICING_VERSION = "2026-08-08"

# Published list prices, retrieved 2026-08-08. Amounts are per minute of audio in
# the stated currency. These are defaults; pricing.json overrides them.
DEFAULT_PRICING: dict[str, Any] = {
    "version": PRICING_VERSION,
    "currency": "INR",
    "usd_to_inr": 83.0,
    "source": "Published list pricing retrieved 2026-08-08 (deepgram.com/pricing, elevenlabs.io/pricing).",
    "volume": {"calls_per_month": 42000, "average_call_minutes": 3.8, "configured": False},
    "providers": {
        "deepgram-stt": {"label": "Deepgram Nova streaming", "usd_per_minute": 0.0048, "billing": "streaming", "hosting": "included / managed API", "source": "deepgram.com/pricing 2026-08-08 (promotional streaming rate)"},
        "deepgram-nova-3": {"label": "Deepgram Nova-3 streaming", "usd_per_minute": 0.0048, "billing": "streaming", "hosting": "included / managed API", "source": "deepgram.com/pricing 2026-08-08"},
        "scribe_v2": {"label": "ElevenLabs Scribe v2 (batch)", "usd_per_minute": 0.054, "billing": "batch", "hosting": "included / managed API", "source": "elevenlabs.io/pricing 2026-08-08, Pro credit rate"},
        "scribe_v2_realtime": {"label": "ElevenLabs Scribe v2 Realtime", "usd_per_minute": 0.0065, "billing": "streaming", "hosting": "included / managed API", "source": "elevenlabs.io/pricing 2026-08-08, $0.39/hour"},
        "scribe_v1": {"label": "ElevenLabs Scribe v1 (batch)", "usd_per_minute": 0.054, "billing": "batch", "hosting": "included / managed API", "source": "elevenlabs.io/pricing 2026-08-08"},
    },
    "evaluator": {"model": "gpt-4o-mini", "usd_per_1k_input_tokens": 0.00015, "usd_per_1k_output_tokens": 0.0006, "source": "openai.com/api/pricing 2026-08-08"},
}

# A batch model is only ever used to produce the evaluation transcript. Pricing a
# live switch on a batch rate would overstate the bill several-fold, so the
# switch comparison substitutes the vendor's streaming equivalent.
STREAMING_EQUIVALENT: dict[str, str] = {
    "scribe_v2": "scribe_v2_realtime",
    "scribe_v1": "scribe_v2_realtime",
}


def load_pricing(data_dir: Path) -> dict[str, Any]:
    """Merge operator-supplied rates over the published defaults."""
    path = data_dir / "pricing.json"
    pricing = json.loads(json.dumps(DEFAULT_PRICING))
    if path.is_file():
        try:
            override = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return pricing
        if isinstance(override, dict):
            for key, value in override.items():
                if isinstance(value, dict) and isinstance(pricing.get(key), dict):
                    pricing[key].update(value)
                else:
                    pricing[key] = value
    return pricing


def rate_for(pricing: dict[str, Any], key: str | None) -> dict[str, Any] | None:
    """The published rate for a provider key, or nothing when it is unknown.

    There is deliberately no substring fallback. `turn["provider"]` falls back to
    the generic wiring name — `"stt"` in real captures — and `"stt"` is a
    substring of `"deepgram-stt"`, so a loose match prices an unidentified vendor
    at Deepgram's promotional rate and labels it as Deepgram in the UI. An
    invented rate that looks sourced is worse than no rate at all, because the
    monthly and yearly switch-saving figures are computed from it.
    """
    if not key:
        return None
    providers = pricing.get("providers") or {}
    if key in providers:
        return providers[key]
    aliases = pricing.get("aliases") or {}
    alias = aliases.get(str(key).lower())
    return providers.get(alias) if isinstance(alias, str) else None


def fx_rate(pricing: dict[str, Any]) -> float | None:
    """USD to display currency. Never defaults to 1.0: a missing rate silently
    turns dollars into rupees and understates every figure ~83x."""
    value = pricing.get("usd_to_inr")
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def per_minute(pricing: dict[str, Any], rate: dict[str, Any] | None) -> float | None:
    fx = fx_rate(pricing)
    if not rate or not isinstance(rate.get("usd_per_minute"), (int, float)) or fx is None:
        return None
    return rate["usd_per_minute"] * fx


def cost_model(pricing: dict[str, Any], production_key: str | None, challenger_key: str | None,
               call_minutes: float | None, evaluator_usage: dict[str, Any] | None = None) -> dict[str, Any]:
    """Per-call, per-month and per-year comparison plus the price of the test itself."""
    production_rate = rate_for(pricing, production_key)
    challenger_rate = rate_for(pricing, challenger_key)
    production_per_minute = per_minute(pricing, production_rate)
    challenger_per_minute = per_minute(pricing, challenger_rate)
    volume = pricing.get("volume") or {}
    calls = volume.get("calls_per_month")
    average_minutes = volume.get("average_call_minutes")
    monthly_minutes = calls * average_minutes if isinstance(calls, (int, float)) and isinstance(average_minutes, (int, float)) else None

    def scale(rate: float | None, minutes: float | None) -> float | None:
        return rate * minutes if isinstance(rate, (int, float)) and isinstance(minutes, (int, float)) else None

    call_production = scale(production_per_minute, call_minutes)
    call_challenger = scale(challenger_per_minute, call_minutes)
    monthly_production = scale(production_per_minute, monthly_minutes)
    monthly_challenger = scale(challenger_per_minute, monthly_minutes)
    monthly_saving = monthly_production - monthly_challenger if isinstance(monthly_production, (int, float)) and isinstance(monthly_challenger, (int, float)) else None

    evaluator_cost = evaluator_amount(pricing, evaluator_usage)

    # A missing evaluator rate must not quietly contribute zero to the test cost;
    # the total is only reportable when every component priced.
    test_cost = None
    if isinstance(call_challenger, (int, float)) and (evaluator_usage is None or isinstance(evaluator_cost, (int, float))):
        test_cost = call_challenger + (evaluator_cost or 0.0)

    return {
        "currency": pricing.get("currency", "INR"),
        "pricing_version": pricing.get("version"),
        "pricing_source": pricing.get("source"),
        "provenance": "estimated_list_price" if not volume.get("configured") else "configured",
        "production": {
            "key": production_key, "label": (production_rate or {}).get("label"),
            "per_minute": production_per_minute, "per_call": call_production,
            "per_month": monthly_production, "hosting": (production_rate or {}).get("hosting"),
            "billing": (production_rate or {}).get("billing"), "source": (production_rate or {}).get("source"),
        },
        "challenger": {
            "key": challenger_key, "label": (challenger_rate or {}).get("label"),
            "per_minute": challenger_per_minute, "per_call": call_challenger,
            "per_month": monthly_challenger, "hosting": (challenger_rate or {}).get("hosting"),
            "billing": (challenger_rate or {}).get("billing"), "source": (challenger_rate or {}).get("source"),
        },
        "difference": {
            "per_minute": (challenger_per_minute - production_per_minute) if isinstance(production_per_minute, (int, float)) and isinstance(challenger_per_minute, (int, float)) else None,
            "per_minute_percent": ((challenger_per_minute - production_per_minute) / production_per_minute) if isinstance(production_per_minute, (int, float)) and production_per_minute and isinstance(challenger_per_minute, (int, float)) else None,
            "per_call": (call_challenger - call_production) if isinstance(call_production, (int, float)) and isinstance(call_challenger, (int, float)) else None,
            "per_month": -monthly_saving if isinstance(monthly_saving, (int, float)) else None,
            "per_year": -monthly_saving * 12 if isinstance(monthly_saving, (int, float)) else None,
        },
        "volume": {"calls_per_month": calls, "average_call_minutes": average_minutes, "monthly_minutes": monthly_minutes, "configured": bool(volume.get("configured"))},
        "call_minutes": call_minutes,
        "test": {"challenger_cost": call_challenger, "evaluator_cost": evaluator_cost, "total": test_cost},
    }


def evaluator_amount(pricing: dict[str, Any], evaluator_usage: dict[str, Any] | None) -> float | None:
    """Cost of the LLM risk evaluator. Returns None rather than 0 when either
    the token usage or a token rate is missing, so an unpriced run is never
    presented as a free one."""
    if not evaluator_usage:
        return None
    rates = pricing.get("evaluator") or {}
    fx = fx_rate(pricing)
    input_tokens = evaluator_usage.get("input_tokens")
    output_tokens = evaluator_usage.get("output_tokens")
    input_rate = rates.get("usd_per_1k_input_tokens")
    output_rate = rates.get("usd_per_1k_output_tokens")
    if fx is None or not all(isinstance(v, (int, float)) for v in (input_tokens, output_tokens, input_rate, output_rate)):
        return None
    return ((input_tokens / 1000) * float(input_rate) + (output_tokens / 1000) * float(output_rate)) * fx


def evaluation_cost(pricing: dict[str, Any], transcript_run: dict[str, Any] | None,
                    streaming_run: dict[str, Any] | None, evaluator_usage: dict[str, Any] | None) -> dict[str, Any]:
    """What running this evaluation itself cost, split by component.

    Kept separate from the switch comparison: a transcription done purely for
    review is a one-off expense, not a rate you would pay in production.

    The transcript and the timing source are now normally the SAME streaming run,
    so they are de-duplicated by identity. Billing one API call twice would
    overstate the evaluation cost by 2x.
    """
    components: list[dict[str, Any]] = []
    roles: list[tuple[dict[str, Any] | None, str]] = [(transcript_run, "challenger transcript")]
    if streaming_run is not None and streaming_run is not transcript_run:
        roles.append((streaming_run, "streaming replay"))
    elif streaming_run is not None:
        roles = [(streaming_run, "challenger transcript and timing (one run)")]
    for run, role in roles:
        if not run:
            continue
        minutes = ((run.get("usage") or {}).get("billable_minutes")
                   or (run.get("audio") or {}).get("duration_secs", 0) / 60)
        rate = rate_for(pricing, run.get("model"))
        amount = per_minute(pricing, rate)
        components.append({
            "role": role, "model": run.get("model"), "minutes": round(minutes, 3) if minutes else None,
            "amount": amount * minutes if isinstance(amount, (int, float)) and minutes else None,
            "provenance": "estimated_list_price",
        })
    amount = evaluator_amount(pricing, evaluator_usage)
    components.append({"role": "semantic-risk evaluator", "model": (pricing.get("evaluator") or {}).get("model"),
                       "minutes": None, "amount": amount,
                       "provenance": "estimated_list_price" if amount is not None else "usage_not_reported"})
    amounts = [item["amount"] for item in components if isinstance(item.get("amount"), (int, float))]
    return {"currency": pricing.get("currency", "INR"), "components": components,
            "total": sum(amounts) if amounts else None, "complete": len(amounts) == len(components)}
