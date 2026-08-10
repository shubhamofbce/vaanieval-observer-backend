from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


RISK_SCHEMA_VERSION = "1.1"
PROMPT_VERSION = "v1"
RISK_LEVELS = ("none", "low", "medium", "high", "unavailable")
DEFAULT_CRITICAL_TERMS = (
    "amounts",
    "prices",
    "currency",
    "dates",
    "times",
    "city names",
    "origin",
    "destination",
    "phone digits",
    "account digits",
    "booking ids",
    "passenger names",
    "traveller names",
    "counts",
    "number of travellers",
    "duration",
    "yes/no",
    "negation",
    "cancellations",
    "stop requests",
)

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
MAPPING_PADDING_MS = 160


def default_env_files() -> list[Path]:
    """Dotenv locations searched only when `OPENAI_API_KEY` is not exported.

    Resolved per call rather than at import so `VAANI_ENV_FILE` works regardless
    of import order. It is `os.pathsep`-separated, which lets a developer point
    at a key stored outside this checkout without editing source.
    """
    configured = os.environ.get("VAANI_ENV_FILE", "")
    return [
        *(Path(item) for item in configured.split(os.pathsep) if item),
        Path(__file__).resolve().parents[1] / ".env",
    ]


@dataclass(frozen=True)
class Word:
    text: str
    start_ms: int
    end_ms: int


class ModelNotFound(RuntimeError):
    pass


def load_api_key(env_files: list[Path] | None = None) -> str | None:
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    for path in env_files or default_env_files():
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() != "OPENAI_API_KEY":
                continue
            value = value.strip()
            if value[:1] in {"'", '"'} and value[-1:] == value[:1]:
                value = value[1:-1]
            return value or None
    return None


def classify_turn(
    production_text: str,
    challenger_text: str,
    diff: list[dict],
    api_key: str,
    model: str = "gpt-4o-mini",
    critical_terms: tuple[str, ...] = DEFAULT_CRITICAL_TERMS,
) -> dict:
    try:
        payload = _chat_payload(production_text, challenger_text, diff, model, critical_terms)
        try:
            data = _openai_json(OPENAI_CHAT_URL, api_key, payload)
            evaluator_model = model
        except ModelNotFound:
            evaluator_model = _choose_available_model(api_key, model)
            payload["model"] = evaluator_model
            data = _openai_json(OPENAI_CHAT_URL, api_key, payload)
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        result = _validated_result(parsed, evaluator_model)
        result["usage"] = _usage_from_response(data)
        return result
    except Exception as error:
        return _unavailable(str(error), model)


def evaluate_session(
    session_id: str,
    turns: list[dict],
    data_dir: Path,
    api_key: str,
    model: str = "gpt-4o-mini",
    force: bool = False,
) -> dict:
    existing = load_store(session_id, data_dir) or {}
    existing_turns = existing.get("turns") if isinstance(existing.get("turns"), dict) else {}
    critical_terms = tuple(existing.get("critical_terms") or DEFAULT_CRITICAL_TERMS)
    store = _empty_store(session_id, model, critical_terms)
    if isinstance(existing.get("created_at"), str):
        store["created_at"] = existing["created_at"]
    store["usage"] = _store_usage(existing.get("usage"))
    used_models: list[str] = []

    for turn in turns:
        turn_id = str(turn.get("turn_id", ""))
        production = str(turn.get("production") or "")
        challenger = str(turn.get("challenger") or "")
        diff = turn.get("diff") if isinstance(turn.get("diff"), list) else []
        wer = turn.get("wer")
        skip_reason = turn.get("skip_reason") or _skip_reason(production, challenger, diff, wer)
        if skip_reason:
            store["skipped"][turn_id] = skip_reason
            store["turns"].pop(turn_id, None)
            continue
        fingerprint = _fingerprint(production, challenger, model, PROMPT_VERSION)
        cached = existing_turns.get(turn_id)
        if not force and _cache_usable(cached, fingerprint):
            result = dict(cached)
            store["usage"]["cached_turns"] += 1
        else:
            result = classify_turn(production, challenger, diff, api_key, model, critical_terms)
            result["fingerprint"] = fingerprint
            _add_usage(store["usage"], result.get("usage"), api_call=True)
        result["production_text"] = production
        result["challenger_text"] = challenger
        result["changed_words"] = _changed_words(diff)
        store["turns"][turn_id] = result
        if result.get("evaluator_model"):
            used_models.append(str(result["evaluator_model"]))

    if used_models:
        store["evaluator"]["model"] = used_models[0]
    _summarize(store)
    save_store(store, data_dir)
    return store


def save_store(store: dict, data_dir: Path) -> Path:
    session_id = str(store["session_id"])
    path = data_dir / "evaluations" / session_id / "semantic-risk.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(store, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def load_store(session_id: str, data_dir: Path) -> dict | None:
    path = data_dir / "evaluations" / session_id / "semantic-risk.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) and data.get("session_id") == session_id else None


def _chat_payload(
    production_text: str,
    challenger_text: str,
    diff: list[dict],
    model: str,
    critical_terms: tuple[str, ...],
) -> dict[str, Any]:
    system = (
        "You are a semantic-risk evaluator for speech-to-text transcript disagreements. "
        "Do not decide which transcript is correct. Independently extract intent and critical facts "
        "from each transcript, compare those extractions, and return only strict JSON."
    )
    user = {
        "instructions": [
            "You are not given WER and must not infer correctness.",
            "Risk levels: none=wording differs but intent and critical values agree; "
            "low=minor ambiguity with no critical value changed; "
            "medium=intent or a non-critical slot may differ; "
            "high=intent differs or a critical value is missing/changed; "
            "unavailable=only if the input cannot be evaluated.",
            "Return exactly: risk, intent_changed, critical_values_changed, rationale.",
            "critical_values_changed must list short field names, not transcript sides.",
            "rationale must be one sentence.",
        ],
        "critical_terms": list(critical_terms),
        "production_transcript": production_text,
        "challenger_transcript": challenger_text,
        "alignment_diff": diff,
    }
    return {
        "model": model,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
    }


def _openai_json(url: str, api_key: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Authorization": f"Bearer {api_key}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method="GET" if body is None else "POST")
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            if error.code == 404 and payload is not None:
                raise ModelNotFound(f"OpenAI model not found: {payload.get('model')}") from error
            if error.code not in {429, 500, 502, 503, 504} or attempt == 2:
                raise RuntimeError(f"OpenAI HTTP {error.code}: {detail}") from error
            last_error = error
        except urllib.error.URLError as error:
            if attempt == 2:
                raise RuntimeError(f"OpenAI request failed: {error.reason}") from error
            last_error = error
        time.sleep(0.75 * (2**attempt))
    raise RuntimeError(str(last_error))


def _choose_available_model(api_key: str, requested: str) -> str:
    data = _openai_json(OPENAI_MODELS_URL, api_key)
    ids = sorted(str(item.get("id")) for item in data.get("data", []) if isinstance(item, dict) and item.get("id"))
    preferred = [
        "gpt-4o-mini",
        "gpt-4.1-mini",
        "gpt-4o",
        "gpt-4.1",
        "gpt-3.5-turbo",
    ]
    for candidate in preferred:
        if candidate != requested and candidate in ids:
            return candidate
    for candidate in ids:
        if candidate.startswith(("gpt-4", "gpt-3.5")) and "transcribe" not in candidate and "tts" not in candidate:
            return candidate
    raise RuntimeError("No suitable OpenAI chat model is available")


def _validated_result(parsed: dict[str, Any], evaluator_model: str) -> dict[str, Any]:
    if not isinstance(parsed, dict):
        raise ValueError("model returned non-object JSON")
    risk = parsed.get("risk")
    if risk not in RISK_LEVELS or risk == "unavailable":
        raise ValueError("model returned invalid risk")
    intent_changed = parsed.get("intent_changed")
    if not isinstance(intent_changed, bool):
        raise ValueError("model returned invalid intent_changed")
    changed = parsed.get("critical_values_changed")
    if changed is None and isinstance(parsed.get("changed_fields"), list):
        changed = parsed["changed_fields"]
    if not isinstance(changed, list) or not all(isinstance(item, str) for item in changed):
        raise ValueError("model returned invalid critical_values_changed")
    rationale = parsed.get("rationale") or parsed.get("reason")
    if not isinstance(rationale, str) or not rationale.strip():
        raise ValueError("model returned invalid rationale")
    return {
        "risk": risk,
        "intent_changed": intent_changed,
        "critical_values_changed": changed,
        "rationale": _one_sentence(rationale),
        "status": "ok",
        "error": None,
        "evaluator_model": evaluator_model,
        "prompt_version": PROMPT_VERSION,
    }


def _unavailable(error: str, evaluator_model: str) -> dict[str, Any]:
    return {
        "risk": "unavailable",
        "intent_changed": False,
        "critical_values_changed": [],
        "rationale": "Semantic risk could not be evaluated.",
        "evaluator_model": evaluator_model,
        "prompt_version": PROMPT_VERSION,
        "status": "unavailable",
        "error": error,
        "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
    }


def _one_sentence(text: str) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    match = re.match(r"^(.+?[.!?])(?:\s|$)", compact)
    return match.group(1) if match else compact


def _empty_store(session_id: str, model: str, critical_terms: tuple[str, ...]) -> dict[str, Any]:
    return {
        "schema_version": RISK_SCHEMA_VERSION,
        "session_id": session_id,
        "created_at": datetime.now(UTC).isoformat(),
        "evaluator": {"provider": "openai", "model": model, "prompt_version": PROMPT_VERSION},
        "critical_terms": list(critical_terms),
        "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "api_calls": 0, "cached_turns": 0},
        "turns": {},
        "skipped": {},
        "summary": {level: 0 for level in RISK_LEVELS} | {"evaluated": 0, "skipped": 0},
    }


def _usage_from_response(data: dict[str, Any]) -> dict[str, int]:
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    input_tokens = _nonnegative_int(usage.get("prompt_tokens"))
    output_tokens = _nonnegative_int(usage.get("completion_tokens"))
    total_tokens = _nonnegative_int(usage.get("total_tokens")) or input_tokens + output_tokens
    return {"input_tokens": input_tokens, "output_tokens": output_tokens, "total_tokens": total_tokens}


def _store_usage(value: Any) -> dict[str, int]:
    usage = value if isinstance(value, dict) else {}
    return {
        "input_tokens": _nonnegative_int(usage.get("input_tokens")),
        "output_tokens": _nonnegative_int(usage.get("output_tokens")),
        "total_tokens": _nonnegative_int(usage.get("total_tokens")),
        "api_calls": _nonnegative_int(usage.get("api_calls")),
        "cached_turns": _nonnegative_int(usage.get("cached_turns")),
    }


def _add_usage(store_usage: dict[str, int], turn_usage: Any, api_call: bool) -> None:
    usage = turn_usage if isinstance(turn_usage, dict) else {}
    store_usage["input_tokens"] += _nonnegative_int(usage.get("input_tokens"))
    store_usage["output_tokens"] += _nonnegative_int(usage.get("output_tokens"))
    store_usage["total_tokens"] += _nonnegative_int(usage.get("total_tokens"))
    if api_call:
        store_usage["api_calls"] += 1


def _nonnegative_int(value: Any) -> int:
    return int(value) if isinstance(value, int) and value >= 0 else 0


def _cache_usable(cached: Any, fingerprint: str) -> bool:
    if not isinstance(cached, dict) or cached.get("fingerprint") != fingerprint:
        return False
    usage = cached.get("usage")
    return (
        isinstance(cached.get("production_text"), str)
        and isinstance(cached.get("challenger_text"), str)
        and isinstance(cached.get("changed_words"), list)
        and isinstance(usage, dict)
        and isinstance(usage.get("input_tokens"), int)
        and isinstance(usage.get("output_tokens"), int)
    )


def _changed_words(diff: list[dict]) -> list[dict[str, str | None]]:
    changes: list[dict[str, str | None]] = []
    for item in diff:
        if not isinstance(item, dict) or item.get("operation") == "match":
            continue
        changes.append(
            {
                "from": item.get("production_word") if isinstance(item.get("production_word"), str) else None,
                "to": item.get("challenger_word") if isinstance(item.get("challenger_word"), str) else None,
                "operation": str(item.get("operation") or ""),
            }
        )
    return changes


def _skip_reason(production: str, challenger: str, diff: list[dict], wer: Any) -> str | None:
    if not isinstance(wer, (int, float)):
        return "wer_unavailable"
    if not diff:
        return "diff_unavailable"
    if wer == 0:
        return "identical_transcripts"
    if production.strip() == challenger.strip():
        return "identical_transcripts"
    return None


def _fingerprint(production: str, challenger: str, model: str, prompt_version: str) -> str:
    payload = json.dumps(
        {"production": production, "challenger": challenger, "model": model, "prompt_version": prompt_version},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _summarize(store: dict[str, Any]) -> None:
    summary = {level: 0 for level in RISK_LEVELS}
    for item in store["turns"].values():
        risk = item.get("risk")
        if risk in summary:
            summary[risk] += 1
    summary["evaluated"] = len(store["turns"])
    summary["skipped"] = len(store["skipped"])
    store["summary"] = summary


def _normalize(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).lower().replace("₹", " rupees ")
    text = re.sub(r"[^\w\s'-]", " ", text, flags=re.UNICODE)
    text = re.sub(r"\s+", " ", text).strip()
    return text.split() if text else []


def _align(production: list[str], challenger: list[str]) -> tuple[int, int, int, list[dict[str, Any]]]:
    rows, cols = len(production) + 1, len(challenger) + 1
    dp = [[0] * cols for _ in range(rows)]
    for i in range(rows):
        dp[i][0] = i
    for j in range(cols):
        dp[0][j] = j
    for i in range(1, rows):
        for j in range(1, cols):
            dp[i][j] = min(
                dp[i - 1][j - 1] + (production[i - 1] != challenger[j - 1]),
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
            )
    entries: list[dict[str, Any]] = []
    i, j = len(production), len(challenger)
    while i or j:
        if i and j and dp[i][j] == dp[i - 1][j - 1] + (production[i - 1] != challenger[j - 1]):
            operation = "match" if production[i - 1] == challenger[j - 1] else "substitution"
            entries.append(
                {
                    "production_word": production[i - 1],
                    "challenger_word": challenger[j - 1],
                    "operation": operation,
                    "production_index": i - 1,
                    "challenger_index": j - 1,
                }
            )
            i, j = i - 1, j - 1
        elif i and dp[i][j] == dp[i - 1][j] + 1:
            entries.append(
                {
                    "production_word": production[i - 1],
                    "challenger_word": None,
                    "operation": "deletion",
                    "production_index": i - 1,
                    "challenger_index": None,
                }
            )
            i -= 1
        else:
            entries.append(
                {
                    "production_word": None,
                    "challenger_word": challenger[j - 1],
                    "operation": "insertion",
                    "production_index": None,
                    "challenger_index": j - 1,
                }
            )
            j -= 1
    entries.reverse()
    substitutions = sum(item["operation"] == "substitution" for item in entries)
    deletions = sum(item["operation"] == "deletion" for item in entries)
    insertions = sum(item["operation"] == "insertion" for item in entries)
    return substitutions, deletions, insertions, entries


def _load_cli_turns(session_id: str, data_dir: Path) -> list[dict[str, Any]]:
    from app import latency

    challenger_run = _load_challenger_run(session_id, data_dir)
    production_ops = _load_production_stt(session_id, data_dir)
    words = _challenger_words(challenger_run)
    words_by_turn = _map_words_to_operations(words, production_ops)
    turns: list[dict[str, Any]] = []
    for op in production_ops:
        turn_id = str(op.get("turn_id"))
        if not latency.capture_profile(op)["transcript_recorded"]:
            # Never ask the model to compare against a transcript the capture did
            # not record. It reliably answers "the intent changed" because one
            # side is empty, producing a confident, expensive, meaningless verdict.
            turns.append({"turn_id": turn_id, "production": "", "challenger": "",
                          "wer": None, "diff": [],
                          "skip_reason": "production_transcript_not_captured"})
            continue
        production = ((op.get("response") or {}).get("transcript") or "").strip()
        mapped = words_by_turn.get(turn_id, [])
        challenger = " ".join(word.text for word in mapped).strip()
        production_tokens, challenger_tokens = _normalize(production), _normalize(challenger)
        if not production_tokens and not challenger_tokens:
            wer = None
            diff: list[dict[str, Any]] = []
        elif not challenger_tokens and production_tokens:
            wer = None
            diff = []
        elif not production_tokens and challenger_tokens:
            wer = 1.0
            diff = [
                {
                    "production_word": None,
                    "challenger_word": token,
                    "operation": "insertion",
                    "production_index": None,
                    "challenger_index": index,
                }
                for index, token in enumerate(challenger_tokens)
            ]
        else:
            substitutions, deletions, insertions, diff = _align(production_tokens, challenger_tokens)
            wer = (substitutions + deletions + insertions) / len(challenger_tokens)
        turns.append({"turn_id": turn_id, "production": production, "challenger": challenger, "wer": wer, "diff": diff})
    return turns


def _load_challenger_run(session_id: str, data_dir: Path) -> dict[str, Any]:
    """Pick the same transcript run the dashboard scores against.

    The evaluator must judge the exact text the dashboard displays; selecting a
    different run here silently produces verdicts that do not match the diff a
    reviewer is looking at.
    """
    from app import challenger as challenger_module
    from app import payload as payload_module

    runs = challenger_module.load_runs(session_id, data_dir)
    transcript_run = payload_module.select_runs(runs)["transcript"]
    if not transcript_run:
        raise RuntimeError(f"No challenger run JSON found for {session_id}")
    return transcript_run


def _load_production_stt(session_id: str, data_dir: Path) -> list[dict[str, Any]]:
    path = data_dir / "objects" / session_id / "events.jsonl"
    if not path.is_file():
        raise RuntimeError(f"Missing production events: {path}")
    operations = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            op = json.loads(line)
        except json.JSONDecodeError:
            continue
        if op.get("type") == "stt" and op.get("scope", "turn") != "connection" and op.get("turn_id") is not None:
            operations.append(op)
    return sorted(operations, key=lambda item: item.get("started_at_ms", 0))


def _challenger_words(challenger_run: dict[str, Any]) -> list[Word]:
    raw_words = ((challenger_run.get("response") or {}).get("words") or [])
    words: list[Word] = []
    for item in raw_words:
        if not isinstance(item, dict) or item.get("type", "word") != "word" or not isinstance(item.get("text"), str):
            continue
        start = item.get("start_ms", item.get("start"))
        end = item.get("end_ms", item.get("end"))
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            if start < 1000 and end < 1000:
                start, end = start * 1000, end * 1000
            words.append(Word(item["text"], round(start), round(end)))
    return words


def _map_words_to_operations(words: list[Word], operations: list[dict[str, Any]]) -> dict[str, list[Word]]:
    """Attribute challenger words to production turns using the same canonical
    speech windows the rest of the pipeline uses.

    `speech_started` is when the recognizer opened its listening window, not when
    the caller spoke, so mapping on it pulls in words from a neighbouring turn.
    Mapping each turn independently also lets two padded windows claim the same
    word; the shared mapper resolves both by deriving the window from word
    timestamps and refusing to guess on genuine ambiguity.
    """
    from app import evaluation, latency

    from app import payload as payload_module

    windows = []
    for operation in operations:
        window = latency.speech_window(operation)
        windows.append({
            "turn_id": str(operation.get("turn_id")),
            "start_ms": window.get("start_ms"),
            "end_ms": window.get("end_ms"),
            "from_word_timestamps": window.get("from_word_timestamps"),
            "listen_start_ms": window.get("listen_start_ms"),
        })
    windows = payload_module.mapping_windows(windows)
    payload_words = [
        {"text": word.text, "start_ms": word.start_ms, "end_ms": word.end_ms, "type": "word"}
        for word in words
    ]
    mapped = evaluation.map_words_to_turns(payload_words, windows, tolerance_ms=MAPPING_PADDING_MS)["mapped"]
    return {
        turn_id: [Word(item["text"], item["start_ms"], item["end_ms"]) for item in items]
        for turn_id, items in mapped.items()
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--model", default="gpt-4o-mini")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    api_key = load_api_key()
    if not api_key:
        print("Missing OPENAI_API_KEY.", file=sys.stderr)
        return 2
    turns = _load_cli_turns(args.session, args.data_dir)
    before = load_store(args.session, args.data_dir) or {"turns": {}}
    store = evaluate_session(args.session, turns, args.data_dir, api_key, args.model, force=args.force)
    path = args.data_dir / "evaluations" / args.session / "semantic-risk.json"
    cached = sum(
        1
        for turn_id, result in store["turns"].items()
        if not args.force
        and isinstance(before.get("turns"), dict)
        and isinstance(before["turns"].get(turn_id), dict)
        and before["turns"][turn_id].get("fingerprint") == result.get("fingerprint")
    )
    print(f"Wrote {path}")
    print(f"Evaluator model: {store['evaluator']['model']}")
    print(f"Evaluated: {store['summary']['evaluated']} (cache hits: {cached}); skipped: {store['summary']['skipped']}")
    for turn_id in sorted(store["turns"], key=lambda value: int(value) if value.isdigit() else value):
        print(f"Turn {turn_id}: {store['turns'][turn_id]['risk']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
