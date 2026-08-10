"""Deterministic STT evaluation logic.

Every function here is pure: it takes recorded evidence and returns derived
numbers. Nothing calls a provider, reads a clock, or mutates global state, so a
value shown on the dashboard can always be recomputed from the stored call.

The rules implemented here follow docs/wer-and-semantic-risk-logic.md,
docs/stt-evaluation-plan.md and docs/stt-turn-detection-latency-plan.md.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable, Sequence

NORMALIZATION_VERSION = "v1"
ALIGNMENT_VERSION = "v1"

# A challenger word is attributed to a production turn only when its midpoint
# falls inside the turn's speech window widened by this tolerance. Anything that
# lands in two widened windows is ambiguous and is never guessed.
MAPPING_TOLERANCE_MS = 160

# docs/wer-and-semantic-risk-logic.md banding.
WER_MODERATE = 0.10
WER_HIGH = 0.25

_NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18",
    "nineteen": "19", "twenty": "20", "thirty": "30", "forty": "40",
    "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80", "ninety": "90",
}
_CURRENCY = {"₹": " rupees ", "$": " dollars ", "€": " euros ", "£": " pounds "}
_DEVANAGARI = re.compile(r"[\u0900-\u097F]")


def has_devanagari(text: str) -> bool:
    return bool(_DEVANAGARI.search(text or ""))


def normalize(text: Any) -> str:
    """NFKC + lowercase + punctuation and currency folding, order preserved.

    Characters are dropped by Unicode category rather than by a `\\w` whitelist:
    Devanagari vowel signs are combining marks, which `\\w` excludes, so a
    whitelist silently rewrites "नौ" as "न" and manufactures a word error on
    every Hindi turn.

    English number words are folded to digits, so "eight" and "8" compare equal.
    Digit sequences are deliberately NOT merged: "nine one" stays two tokens and
    does not equal "91", because merging would also collapse "nine one" in
    "nine one-way tickets". Spoken digit strings therefore still register as a
    disagreement, which is the safe direction for phone and booking numbers.
    That transform is unsafe for Devanagari, so it is
    skipped whenever the text contains Devanagari characters.
    """
    if not isinstance(text, str):
        return ""
    value = unicodedata.normalize("NFKC", text).lower()
    for symbol, word in _CURRENCY.items():
        value = value.replace(symbol, word)
    kept = []
    for char in value:
        if char in "'-" or char.isspace():
            kept.append(char)
            continue
        category = unicodedata.category(char)
        # Letters (L*), marks (M*) and numbers (N*) carry spoken content;
        # punctuation and symbols do not.
        kept.append(char if category[0] in {"L", "M", "N"} else " ")
    return re.sub(r"\s+", " ", "".join(kept)).strip()


def tokenize(text: Any) -> list[str]:
    return tokenize_with_surface(text)[0]


def tokenize_with_surface(text: Any) -> tuple[list[str], list[str]]:
    """Comparison tokens plus the surface word each token came from.

    Folding "eight" to "8" is right for scoring but wrong for evidence: a
    reviewer reading "production said 8, challenger said it" cannot tell that the
    caller actually said "eight". The surface list keeps the pre-folding word so
    the dashboard can show what was spoken while still scoring on folded tokens.
    Folding is strictly one token in, one token out, so the lists stay aligned.
    """
    normalized = normalize(text)
    if not normalized:
        return [], []
    surfaces = normalized.split()
    if has_devanagari(normalized):
        return list(surfaces), surfaces
    return [_NUMBER_WORDS.get(token, token) for token in surfaces], surfaces


def align(production: Sequence[str], challenger: Sequence[str]) -> list[dict[str, Any]]:
    """Levenshtein alignment with unit costs, preferring match then substitution.

    Operations are named from the challenger-as-reference perspective used by the
    WER convention: a challenger word with no production counterpart is a
    DELETION (production missed it), and a production word with no challenger
    counterpart is an INSERTION (production added it). Naming these the other way
    round leaves the total error count correct but reports the S/D/I breakdown
    inverted, which reverses the story the dashboard tells about the model.
    """
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
            same = production[i - 1] == challenger[j - 1]
            entries.append({
                "production_word": production[i - 1], "challenger_word": challenger[j - 1],
                "operation": "match" if same else "substitution",
                "production_index": i - 1, "challenger_index": j - 1,
            })
            i, j = i - 1, j - 1
        elif i and dp[i][j] == dp[i - 1][j] + 1:
            entries.append({"production_word": production[i - 1], "challenger_word": None, "operation": "insertion", "production_index": i - 1, "challenger_index": None})
            i -= 1
        else:
            entries.append({"production_word": None, "challenger_word": challenger[j - 1], "operation": "deletion", "production_index": None, "challenger_index": j - 1})
            j -= 1
    entries.reverse()
    return entries


def _with_surface(diff: list[dict[str, Any]], production_surface: Sequence[str],
                  challenger_surface: Sequence[str]) -> list[dict[str, Any]]:
    """Attach the words as actually spoken to each alignment entry."""
    for entry in diff:
        production_index, challenger_index = entry["production_index"], entry["challenger_index"]
        entry["production_surface"] = production_surface[production_index] if production_index is not None else None
        entry["challenger_surface"] = challenger_surface[challenger_index] if challenger_index is not None else None
    return diff


def score_pair(production_text: Any, challenger_text: Any) -> dict[str, Any]:
    """Estimated WER for one turn against the challenger as pseudo-reference.

    The denominator is the challenger token count, so the value answers "how much
    of what the challenger heard did production get wrong". It is deliberately
    not clamped at 100%: an over-transcribing production turn should read above
    100% rather than silently look merely bad.
    """
    production, production_surface = tokenize_with_surface(production_text)
    challenger, challenger_surface = tokenize_with_surface(challenger_text)
    has_production = isinstance(production_text, str) and production_text.strip() != ""
    has_challenger = isinstance(challenger_text, str) and challenger_text.strip() != ""

    base = {
        "production_word_count": len(production), "challenger_word_count": len(challenger),
        "substitutions": 0, "deletions": 0, "insertions": 0, "matches": 0,
        "errors": 0, "estimated_wer": None, "band": "unavailable", "diff": [],
    }
    if not has_production and not has_challenger:
        return {**base, "status": "no_speech"}
    if not has_challenger:
        return {**base, "status": "challenger_empty"}
    if not has_production:
        diff = _with_surface(align([], challenger), production_surface, challenger_surface)
        return {**base, "status": "possible_missed_speech", "deletions": len(challenger),
                "errors": len(challenger), "estimated_wer": 1.0, "band": band(1.0), "diff": diff}

    diff = _with_surface(align(production, challenger), production_surface, challenger_surface)
    substitutions = sum(item["operation"] == "substitution" for item in diff)
    deletions = sum(item["operation"] == "deletion" for item in diff)
    insertions = sum(item["operation"] == "insertion" for item in diff)
    matches = sum(item["operation"] == "match" for item in diff)
    errors = substitutions + deletions + insertions
    wer = errors / len(challenger) if challenger else None
    return {
        "status": "evaluated", "production_word_count": len(production),
        "challenger_word_count": len(challenger), "substitutions": substitutions,
        "deletions": deletions, "insertions": insertions, "matches": matches,
        "errors": errors, "estimated_wer": wer, "band": band(wer), "diff": diff,
    }


def band(wer: float | None) -> str:
    if wer is None:
        return "unavailable"
    if wer < WER_MODERATE:
        return "low"
    if wer <= WER_HIGH:
        return "moderate"
    return "high"


def character_error_rate(production_text: Any, challenger_text: Any) -> float | None:
    """CER, required alongside WER wherever Devanagari or code-switching appears."""
    left, right = normalize(production_text), normalize(challenger_text)
    if not right:
        return None
    previous = list(range(len(right) + 1))
    for index, char in enumerate(left, start=1):
        current = [index]
        for other_index, other in enumerate(right, start=1):
            current.append(min(current[-1] + 1, previous[other_index] + 1, previous[other_index - 1] + (char != other)))
        previous = current
    return previous[-1] / len(right)


def disagreed_words(turn_scores: Iterable[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Group non-matching alignment pairs so a reviewer sees repeat offenders.

    Grouping uses the comparison tokens so "eight" and "8" collapse together, but
    the displayed words are the surface forms so the evidence reads as spoken.
    """
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for turn_id, score in turn_scores:
        for entry in score.get("diff") or []:
            operation = entry["operation"]
            if operation == "match":
                continue
            key = (entry.get("production_word") or "(missed)", entry.get("challenger_word") or "(extra)")
            group = groups.setdefault(key, {
                "production_word": entry.get("production_surface") or key[0],
                "challenger_word": entry.get("challenger_surface") or key[1],
                "operation": operation, "count": 0, "turns": [],
            })
            group["count"] += 1
            if turn_id not in group["turns"]:
                group["turns"].append(turn_id)
    ordered = sorted(groups.values(), key=lambda item: (-item["count"], item["turns"][0] if item["turns"] else ""))
    return ordered


def map_words_to_turns(words: Sequence[dict[str, Any]], windows: Sequence[dict[str, Any]],
                       tolerance_ms: int = MAPPING_TOLERANCE_MS) -> dict[str, Any]:
    """Attribute challenger words to production turns by timestamp only.

    Words are anchored on their ONSET, not their midpoint. Speech-to-text
    engines routinely stretch the last word of an utterance across the trailing
    silence — in this data "Bangalore." is reported as spanning 6 seconds — so a
    midpoint anchor throws that word past the end of its own turn and reports it
    as speech production missed. Onset is the reliable end of a word's span.

    A word landing in two widened windows is left unmapped and its turns are
    flagged ambiguous, because guessing here would silently manufacture a
    transcript difference that the audio does not support.
    """
    mapped: dict[str, list[dict[str, Any]]] = {str(window["turn_id"]): [] for window in windows}
    ambiguous: set[str] = set()
    unmapped: list[dict[str, Any]] = []
    for word in words:
        if word.get("type") not in (None, "word"):
            continue
        start = word.get("start_ms")
        end = word.get("end_ms")
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            unmapped.append(word)
            continue
        matches = [
            str(window["turn_id"]) for window in windows
            if window.get("start_ms") is not None and window.get("end_ms") is not None
            and window["start_ms"] - tolerance_ms <= start < window["end_ms"] + tolerance_ms
        ]
        if len(matches) == 1:
            mapped[matches[0]].append(word)
        elif len(matches) > 1:
            ambiguous.update(matches)
            unmapped.append(word)
        else:
            unmapped.append(word)
    total_words = sum(1 for word in words if word.get("type") in (None, "word"))
    return {
        "mapped": mapped,
        "ambiguous_turn_ids": sorted(ambiguous),
        "summary": {
            "word_count": total_words,
            "mapped_word_count": total_words - len(unmapped),
            "unmapped_word_count": len(unmapped),
            "ambiguous_turn_count": len(ambiguous),
            "tolerance_ms": tolerance_ms,
        },
    }


def words_to_text(words: Sequence[dict[str, Any]]) -> str:
    return " ".join(str(word.get("text", "")).strip() for word in words if str(word.get("text", "")).strip())


def percentiles(values: Iterable[Any]) -> dict[str, Any]:
    """p50/p90/p95/max over the values that were actually measured.

    `count` is reported alongside so the UI can distinguish "measured and fast"
    from "barely measured", which a bare percentile hides.
    """
    measured = sorted(float(value) for value in values if isinstance(value, (int, float)) and not isinstance(value, bool))
    if not measured:
        return {"count": 0, "p50": None, "p90": None, "p95": None, "max": None, "min": None, "mean": None}

    def pick(fraction: float) -> float:
        # Linear interpolation between closest ranks (the "exclusive-free" method
        # numpy calls 'linear'). Nearest-rank collapses p90 and p95 onto the
        # maximum for the ~11-turn samples this dashboard works with, which makes
        # the tail look artificially flat.
        if len(measured) == 1:
            return measured[0]
        position = (len(measured) - 1) * fraction
        lower = int(position)
        upper = min(lower + 1, len(measured) - 1)
        weight = position - lower
        return measured[lower] + (measured[upper] - measured[lower]) * weight

    return {
        "count": len(measured), "p50": pick(0.5), "p90": pick(0.9), "p95": pick(0.95),
        "max": measured[-1], "min": measured[0], "mean": sum(measured) / len(measured),
    }


def delta(end: Any, start: Any, allow_negative: bool = False) -> int | None:
    if not isinstance(end, (int, float)) or not isinstance(start, (int, float)):
        return None
    value = end - start
    if value < 0 and not allow_negative:
        return None
    return round(value)


def overlap_ms(first: tuple[int, int], second: tuple[int, int]) -> int:
    return max(0, min(first[1], second[1]) - max(first[0], second[0]))
