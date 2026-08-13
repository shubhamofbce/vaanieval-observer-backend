#!/usr/bin/env python3
"""Build the public demo snapshot.

The demo is a separate artifact, never the live data directory. This script
reads a working Observer data directory and writes a standalone one that is
safe to publish and cheap to serve:

  python scripts/build_demo_snapshot.py --source data --target demo-data

What it does, and why each step exists:

* Curates a fixed number of calls. Publishing everything means publishing
  whatever happened to be uploaded last, including half-finished experiments.
* Rewrites when the calls happened. A snapshot with every call inside two real
  hours produces a dashboard that is two spikes and five empty days - true, and
  a bad demonstration of a product whose value is the shape of a week. Only the
  call's absolute start moves; every timing *inside* a call is relative to that
  start, so no latency, no percentile and no waveform alignment changes.
* Fills in the dimensions a single test agent leaves empty. Environment, agent
  version and model are null in the source data, so every fleet filter on the
  public page would be an empty dropdown.
* Redacts. Captured LLM request bodies contain whole system prompts, and
  headers can contain credentials. This removes secrets outright and reports
  anything that looks like personal data so a human can decide before launch.
* Pre-renders audio and waveforms, so a public visitor scrubbing a 37 MB call
  reads a file instead of making the server rebuild it from PCM.
* Rebuilds every derived table from the rewritten evidence, so no KPI, chart or
  drill-down can disagree with the calls behind it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import sqlite3
import sys
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

DEFAULT_CALL_COUNT = 30
# The published window. Long enough that the default "last 7 days" view is a
# full week of shape, short enough that 30 calls do not look like a dead fleet.
WINDOW_DAYS = 14
# Share of the published calls placed in the older half of the window, so the
# default 7-day view is full and its comparison period is not empty.
BASELINE_SHARE = 0.3
# Everything the demo must not carry into public. Tables that hold credentials,
# job state or backup copies are recreated empty rather than copied.
DROPPED_TABLES = ("api_keys", "challenger_evaluation_jobs", "rollup_dirty")
DERIVED_TABLES = ("call_metrics", "turn_metrics", "tool_metrics", "failure_metrics",
                  "interval_rollups", "metric_rollups", "tool_rollups", "failure_rollups",
                  "metric_facets", "rollup_meta")

# Keys whose values are credentials wherever they appear.
SECRET_KEY_PATTERN = re.compile(
    r"(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|"
    r"bearer|x-api-key|cookie|set-cookie|credential|private[_-]?key|session[_-]?token)",
    re.IGNORECASE,
)
# Value shapes that are credentials whatever they are called.
SECRET_VALUE_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{12,}", re.IGNORECASE),
    re.compile(r"\bghp_[A-Za-z0-9]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{12,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
)
# Shapes that are probably personal data. These are *reported*, not silently
# removed: a false positive that deletes a transcript word would make the demo
# lie about what the product captured.
PII_PATTERNS = (
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("phone", re.compile(r"(?<!\d)(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){9,13}\d(?!\d)")),
    ("card", re.compile(r"(?<!\d)(?:\d[ -]?){13,16}(?!\d)")),
    ("aadhaar", re.compile(r"(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)")),
)
REDACTED = "[redacted for the public demo]"

# The fleet dimensions the source data leaves null. A single test agent produces
# one environment, one version and one model, so every dashboard filter on the
# public page would offer nothing to filter by. These are assigned
# deterministically per call, so a rebuild produces the identical snapshot.
ENVIRONMENTS = (("production", 0.78), ("staging", 0.22))
AGENT_VERSIONS = (("2.5.0", 0.55), ("2.4.1", 0.45))

# The published fleet.
# ---------------------------------------------------------------------------
# Every captured call is the same India travel assistant, so the agents here are
# its delivery channels rather than invented products: the transcript a visitor
# reads is plausible under any of these names, which would not be true if the
# fleet were padded out with a billing bot or a claims agent.
#
# The assignment is not random. Calls are graded by how bad they are and the
# worst are concentrated in one channel, because an agent filter that spreads
# failure evenly across four agents answers nothing - the visitor clicks it,
# sees four identical rows, and learns that the filter works. Concentrated,
# the same click produces the finding the product exists to deliver: one
# channel is dragging the fleet down.
FLAGSHIP_AGENT = "india-travel-agent"
DEGRADED_AGENT = "india-travel-agent-whatsapp"
FLEET = (
    # (agent id, share of calls, share of the *worst* calls it should absorb)
    (FLAGSHIP_AGENT, 0.40, 0.30),
    (DEGRADED_AGENT, 0.23, 0.60),
    ("india-travel-agent-web", 0.24, 0.10),
    ("trip-cost-estimator", 0.13, 0.00),
)

# Models the captured spans do not name. Derived from the endpoint the call
# actually used, so this labels the traffic rather than inventing it.
ENDPOINT_MODELS = {
    "azure-openai": "gpt-4o",
    "deepgram-tts": "aura-2",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the public demo snapshot")
    parser.add_argument("--source", default="data", type=Path, help="Working data directory to read")
    parser.add_argument("--target", default="demo-data", type=Path, help="Snapshot directory to write")
    parser.add_argument("--calls", default=DEFAULT_CALL_COUNT, type=int, help="How many calls to publish")
    parser.add_argument("--seed", default=20260813, type=int, help="Seed, so the build is reproducible")
    parser.add_argument("--keep-existing", action="store_true", help="Do not delete an existing target")
    parser.add_argument("--site-url", default="https://www.vaanieval.com")
    parser.add_argument("--booking-url", default="https://calendar.app.google/5cNH8hB13LoC39Qk7")
    return parser.parse_args()


# ------------------------------------------------------------------ selection

def select_sessions(db: sqlite3.Connection, wanted: int) -> list[sqlite3.Row]:
    """Choose the calls worth showing a stranger.

    Strict recency would publish whatever was uploaded last - here, a run of
    twelve-second smoke tests - and a public dashboard of twelve-second calls
    demonstrates nothing. Preference is given to calls with conversation in
    them, then to recency, and a deliberate minority of calls that went wrong
    is kept: a demo where nothing ever fails is not an observability product.
    """
    rows = list(db.execute(
        "SELECT s.*, COALESCE(c.turn_count, 0) AS turn_count, "
        "COALESCE(c.failed_op_count, 0) AS failed_op_count, "
        "COALESCE(c.duration_ms, 0) AS duration_ms "
        "FROM sessions s LEFT JOIN call_metrics c ON c.session_id = s.id "
        "WHERE s.status = 'ready' ORDER BY s.created_at DESC"
    ))
    usable = [row for row in rows if row["turn_count"] >= 1 and row["duration_ms"] >= 5000]
    interesting = [row for row in usable if row["failed_op_count"] > 0]
    ranked = sorted(usable, key=lambda row: (row["turn_count"], row["duration_ms"]), reverse=True)

    chosen: dict[str, sqlite3.Row] = {}
    # Failures first: they are scarce, and they are what the product is for.
    # The count is capped near the source's own rate (5 in 68 calls). Publishing
    # every failure the capture holds would put a fifth of the demo in error and
    # describe a fleet that does not exist - failed calls are also long, so the
    # ranking below would re-admit them if the cap were not enforced there too.
    quota = max(2, wanted // 10)
    for row in interesting[:quota]:
        chosen[row["id"]] = row
    for row in ranked:
        if len(chosen) >= wanted:
            break
        if row["failed_op_count"] > 0 and row["id"] not in chosen:
            continue
        chosen.setdefault(row["id"], row)
    return list(chosen.values())[:wanted]


# --------------------------------------------------------------- sanitisation

def looks_like_prose(value: str) -> bool:
    """Whether a string is human text rather than a machine payload.

    Scanning every string in a captured payload for phone numbers matches byte
    counts, sample rates, stream ids and content-filter blobs thousands of
    times, and a review report with three thousand false positives does not get
    read. Personal data arrives either inside something a person said or wrote,
    or as a bare identifier - so those are the two things this looks at.
    """
    stripped = value.strip()
    if not stripped:
        return False
    if stripped.startswith(("data:", "{", "[")) or '{"' in stripped:
        return False
    letters = sum(character.isalpha() for character in stripped)
    if " " in stripped and letters >= 3:
        # Punctuation-dense strings are serialized structures that happened to
        # survive the JSON parse, not sentences.
        symbols = sum(character in '{}[]":,\\/' for character in stripped)
        return symbols * 4 < letters
    digits = sum(character.isdigit() for character in stripped)
    return 9 <= digits <= 19 and digits >= len(stripped) - 3


def scrub(value: Any, findings: dict[str, int], key: str | None = None) -> Any:
    """Remove credentials and record anything that looks personal.

    Walks the whole captured payload rather than a list of known fields:
    request and response bodies are provider-shaped and nested, and a demo that
    only cleaned the fields we remembered would publish the ones we forgot.
    Strings that are themselves JSON - which is how the SDK captures a provider
    request body, system prompt and all - are parsed and walked rather than
    treated as opaque text, so a credential or a name nested three levels inside
    a captured body is still found.
    """
    if isinstance(value, dict):
        return {name: scrub(item, findings, name) for name, item in value.items()}
    if isinstance(value, list):
        return [scrub(item, findings, key) for item in value]
    if not isinstance(value, str):
        return value
    if key and SECRET_KEY_PATTERN.search(key) and value.strip():
        findings["secret_key"] += 1
        return REDACTED
    embedded = parse_embedded(value)
    if embedded is not None:
        return json.dumps(scrub(embedded, findings, key), separators=(",", ":"))
    cleaned = value
    for pattern in SECRET_VALUE_PATTERNS:
        cleaned, count = pattern.subn(REDACTED, cleaned)
        if count:
            findings["secret_value"] += count
    if looks_like_prose(cleaned):
        for name, pattern in PII_PATTERNS:
            found = pattern.findall(cleaned)
            if found:
                findings[f"possible_{name}"] += len(found)
    return cleaned


def parse_embedded(value: str) -> Any:
    """A captured body that is JSON, decoded so it can be walked."""
    stripped = value.strip()
    if len(stripped) < 2 or stripped[0] not in "{[" or stripped[-1] not in "}]":
        return None
    try:
        parsed = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return None
    return parsed if isinstance(parsed, (dict, list)) else None


def enrich_operation(op: dict[str, Any]) -> dict[str, Any]:
    """Label spans the SDK captured without a model name.

    The provider is already recoverable from `endpoint_id`; the model is not
    recorded at all for these spans, which leaves the dashboard's model filter
    empty and its per-model comparison unusable. The value is taken from the
    endpoint the call really used, so this names traffic rather than inventing
    it.
    """
    if not op.get("model"):
        model = ENDPOINT_MODELS.get(str(op.get("endpoint_id") or ""))
        if model:
            op["model"] = model
    return op


def severity(row: sqlite3.Row) -> tuple[float, float]:
    """How bad a call is, worst first.

    Failures dominate, then how long the caller waited per turn. Duration alone
    would rank a long healthy conversation as the worst call in the fleet.
    """
    turns = max(int(row["turn_count"] or 0), 1)
    return (float(row["failed_op_count"] or 0), float(row["duration_ms"] or 0) / turns)


def assign_agents(ordered: list[sqlite3.Row], featured_id: str) -> dict[str, str]:
    """Spread the calls over the published fleet, worst calls concentrated.

    Capacities are apportioned by largest remainder so the shares hold exactly
    at 30 calls and still hold if the call count changes. The worst calls are
    handed out first, to whichever agent has the most unmet appetite for them,
    so `DEGRADED_AGENT` ends up visibly worse than the fleet average instead of
    the four agents converging on the same numbers.
    """
    total = len(ordered)
    exact = {agent: share * total for agent, share, _ in FLEET}
    caps = {agent: int(value) for agent, value in exact.items()}
    for agent in sorted(exact, key=lambda a: exact[a] - caps[a], reverse=True):
        if sum(caps.values()) >= total:
            break
        caps[agent] += 1

    worst_first = sorted(ordered, key=severity, reverse=True)
    # How many calls are treated as "the bad ones" for placement purposes. Every
    # call with a failure counts, and at least a third of the set, so the
    # concentration is visible even in a snapshot that happens to be healthy.
    bad_count = max(sum(1 for row in ordered if row["failed_op_count"] > 0), total // 3)
    appetite = {agent: bad * bad_count for agent, _, bad in FLEET}

    assigned: dict[str, str] = {}
    remaining = dict(caps)
    for index, row in enumerate(worst_first):
        open_agents = [agent for agent in remaining if remaining[agent] > 0]
        if index < bad_count and any(appetite[agent] > 0 for agent in open_agents):
            agent = max(open_agents, key=lambda a: (appetite[a], remaining[a], a))
            appetite[agent] -= 1
        else:
            agent = max(open_agents, key=lambda a: (remaining[a], a))
        remaining[agent] -= 1
        assigned[row["id"]] = agent

    # The landing page links to the featured call, so it must open on the agent
    # the rest of the story is told about. Swapping keeps every capacity intact.
    if assigned.get(featured_id) != FLAGSHIP_AGENT:
        displaced = assigned[featured_id]
        partner = next(sid for sid, agent in assigned.items()
                       if agent == FLAGSHIP_AGENT and sid != featured_id)
        assigned[featured_id], assigned[partner] = FLAGSHIP_AGENT, displaced
    return assigned


# ----------------------------------------------------------------- the clock
def arrange(ordered: list[sqlite3.Row]) -> list[sqlite3.Row]:
    """Spread the failed calls evenly through the publication order.

    The selection deliberately over-samples failures relative to the source
    (they are scarce and they are the reason the product exists). Left in one
    run they also land in one part of the window, which shows the visitor an
    error rate several times the real one on whichever range they open, and
    puts every incident on the same two days. Interleaving keeps the same
    calls and the same evidence while the rate any single window reports stays
    close to the fleet's actual one.
    """
    failed = [row for row in ordered if row["failed_op_count"] > 0]
    clean = [row for row in ordered if row["failed_op_count"] == 0]
    if not failed or len(clean) < 2:
        return ordered
    # The last call is the newest one, and it is what the landing page links
    # to. It stays pinned: the first thing a visitor opens should be a full
    # conversation, not an incident.
    featured = clean[-1]
    body = clean[:-1]
    step = len(body) / len(failed)
    result = list(body)
    for index, row in enumerate(failed):
        # Walk from the end so earlier insertions do not shift later targets.
        result.insert(len(body) - round(index * step), row)
    return [*result, featured]


def spread_starts(count: int, demo_now: datetime, rng: random.Random) -> list[datetime]:
    """Place the published calls across the demo window like real traffic.

    Real voice traffic is not uniform: it clusters in working hours and thins
    out at night and at the weekend. A flat distribution reads as synthetic at a
    glance, and the charts it produces have no shape to explain.
    """
    # Business-hours weighting, in the fleet's local working day.
    hour_weights = [1, 1, 1, 1, 1, 2, 4, 7, 11, 14, 15, 14, 12, 13, 15, 14, 12, 9, 7, 5, 4, 3, 2, 1]
    starts: list[datetime] = []
    # The console opens on "last 7 days". Most calls therefore belong in that
    # half of the window, or the demo's first screen shows a third of the data
    # it shipped. The remainder sits in the preceding 7 days so the
    # period-over-period deltas have a real baseline to compare against
    # instead of reporting "no comparison available" on every KPI.
    baseline = max(1, round(count * BASELINE_SHARE))
    recent = count - baseline
    half = WINDOW_DAYS // 2
    for index in range(count):
        # Spread the days deterministically so no day in the window is empty,
        # then jitter within the day. An empty column in a 14-day chart looks
        # like an outage the demo cannot explain.
        if index < baseline:
            day = index * half // baseline
        else:
            day = half + (index - baseline) * half // max(1, recent)
        hour = rng.choices(range(24), weights=hour_weights, k=1)[0]
        moment = demo_now - timedelta(days=WINDOW_DAYS) + timedelta(
            days=day, hours=hour, minutes=rng.randrange(60), seconds=rng.randrange(60))
        # Never publish a call from the future relative to the frozen clock.
        starts.append(min(moment, demo_now - timedelta(minutes=4)))
    return sorted(starts)


def weighted_choice(options: tuple[tuple[str, float], ...], seed: str) -> str:
    """A stable per-call assignment, so rebuilding produces the same snapshot."""
    digest = int(hashlib.sha256(seed.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    cumulative = 0.0
    for value, weight in options:
        cumulative += weight
        if digest <= cumulative:
            return value
    return options[-1][0]


# ------------------------------------------------------------------ the build

def build() -> int:
    args = parse_args()
    source = args.source.resolve()
    target = args.target.resolve()
    if not (source / "vaani.db").is_file():
        print(f"No database at {source / 'vaani.db'}", file=sys.stderr)
        return 1
    if target.exists() and not args.keep_existing:
        shutil.rmtree(target)
    (target / "objects").mkdir(parents=True, exist_ok=True)

    rng = random.Random(args.seed)
    findings: dict[str, int] = defaultdict(int)

    read = sqlite3.connect(f"file:{source / 'vaani.db'}?mode=ro", uri=True)
    read.row_factory = sqlite3.Row
    selected = select_sessions(read, args.calls)
    if not selected:
        print("No publishable calls found", file=sys.stderr)
        return 1
    print(f"Selected {len(selected)} calls from {source}")

    # The frozen clock: a round moment near the newest published call, so the
    # dashboard's "now" is stable and explainable rather than an odd timestamp.
    demo_now = datetime.now(UTC).replace(hour=18, minute=0, second=0, microsecond=0)
    starts = spread_starts(len(selected), demo_now, rng)

    # Longest calls last: the newest call is the one the landing page links to,
    # and it should be the richest conversation in the set.
    ordered = arrange(sorted(selected, key=lambda row: (row["turn_count"], row["duration_ms"])))
    agents = assign_agents(ordered, ordered[-1]["id"])

    write = sqlite3.connect(target / "vaani.db")
    write.row_factory = sqlite3.Row
    write.executescript("".join(
        f"{row['sql']};\n" for row in read.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    ))
    for table in DROPPED_TABLES:
        write.execute(f"DELETE FROM {table}")

    published: list[dict[str, Any]] = []
    for index, row in enumerate(ordered):
        session_id = row["id"]
        started = starts[index]
        manifest = json.loads(row["manifest_json"])
        manifest = scrub(manifest, findings)
        manifest["started_at"] = started.isoformat().replace("+00:00", "Z")
        manifest["agent_id"] = agents[session_id]
        metadata = manifest.get("metadata") if isinstance(manifest.get("metadata"), dict) else {}
        metadata["environment"] = weighted_choice(ENVIRONMENTS, f"env:{session_id}")
        metadata["agent_version"] = weighted_choice(AGENT_VERSIONS, f"ver:{session_id}")
        metadata.setdefault("region", "ap-south-1")
        manifest["metadata"] = metadata
        ended = started + timedelta(milliseconds=int(manifest.get("duration_ms") or 0))
        stamp = ended.isoformat().replace("+00:00", "Z")

        write.execute(
            "INSERT INTO sessions (id, manifest_json, status, created_at, updated_at, completed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, json.dumps(manifest), row["status"],
             started.isoformat().replace("+00:00", "Z"), stamp, stamp),
        )
        copy_operations(read, write, session_id, findings)
        copy_objects(source, target, session_id, findings)
        has_evaluation = copy_evaluation(source, target, session_id, findings)
        published.append({"id": session_id, "started": started, "manifest": manifest,
                          "has_evaluation": has_evaluation,
                          "turns": row["turn_count"], "duration_ms": row["duration_ms"]})

    write.commit()
    read.close()

    # Derived tables are rebuilt from the rewritten evidence rather than copied,
    # so every number on the public dashboard is reproducible from the 30 calls
    # a visitor can open.
    rebuild_aggregates(source, target, write)
    write.close()

    prerender(source, target, published)
    write_config(target, published, demo_now, args)
    report(findings, published, target)
    return 0


def copy_evaluation(source: Path, target: Path, session_id: str, findings: dict[str, int]) -> bool:
    """Publish a completed STT comparison, if this call has one.

    Only finished results travel. Nothing here lets a visitor *start* an
    evaluation: that would spend real provider credits on anonymous traffic.
    """
    src = source / "evaluations" / session_id
    if not src.is_dir():
        return False
    dst = target / "evaluations" / session_id
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.rglob("*"):
        if not item.is_file():
            continue
        out = dst / item.relative_to(src)
        out.parent.mkdir(parents=True, exist_ok=True)
        if item.suffix == ".json":
            try:
                out.write_text(json.dumps(scrub(json.loads(item.read_text(encoding="utf-8")), findings)),
                               encoding="utf-8")
                continue
            except json.JSONDecodeError:
                pass
        shutil.copy2(item, out)
    return True


def copy_operations(read: sqlite3.Connection, write: sqlite3.Connection, session_id: str,
                    findings: dict[str, int]) -> int:
    """Publish one call's captured spans, cleaned and labelled.

    The console and every derived metric read spans from this table, not from
    the uploaded events file - a snapshot without it is a set of calls with no
    transcript, no trace and no latency.
    """
    copied = 0
    for row in read.execute(
        "SELECT id, session_id, operation_json, started_at_ms, turn_id, scope, failed "
        "FROM operations WHERE session_id = ? ORDER BY started_at_ms", (session_id,)
    ):
        op = enrich_operation(scrub(json.loads(row["operation_json"]), findings))
        write.execute(
            "INSERT INTO operations (id, session_id, operation_json, started_at_ms, turn_id, scope, failed) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (row["id"], row["session_id"], json.dumps(op), row["started_at_ms"],
             row["turn_id"], row["scope"], row["failed"]),
        )
        copied += 1
    return copied


def served_tracks(manifest: dict[str, Any], has_evaluation: bool) -> list[str]:
    """The tracks the product will actually ask for, and no others.

    The console plays exactly one source per call - the stereo recording if
    there is one, otherwise a mix - and the STT comparison page plays the
    caller channel. Publishing all four renders of every call triples the
    artifact for audio no visitor can reach.
    """
    audio = manifest.get("audio", {})
    uploaded = [name for name in ("call", "caller", "agent") if name in audio]
    if "call" in audio:
        primary = "call"
    elif len(uploaded) > 1:
        primary = "mixed"
    elif uploaded:
        primary = uploaded[0]
    else:
        return []
    tracks = [primary]
    if has_evaluation and "caller" != primary:
        tracks.append("caller")
    return tracks


def copy_objects(source: Path, target: Path, session_id: str, findings: dict[str, int]) -> None:
    """Copy one call's captured events, cleaned. Media is published separately.

    The raw PCM package is deliberately *not* copied: the published WAV is the
    same audio with a header, so shipping both would double the artifact to
    serve bytes nothing requests.
    """
    src = source / "objects" / session_id
    dst = target / "objects" / session_id
    dst.mkdir(parents=True, exist_ok=True)
    events = src / "events.jsonl"
    if events.is_file():
        lines = []
        for line in events.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("kind") == "audio_chunk":
                lines.append(json.dumps(event))
                continue
            lines.append(json.dumps(enrich_operation(scrub(event, findings))))
        (dst / "events.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def rebuild_aggregates(source: Path, target: Path, db: sqlite3.Connection) -> None:
    """Re-derive every metric and rollup from the published calls."""
    os.environ["VAANI_DATA_DIR"] = str(target)
    os.environ["VAANI_DISABLE_MAINTENANCE"] = "1"
    os.environ.pop("VAANI_DEMO_MODE", None)
    for module in [name for name in list(sys.modules) if name.startswith("app.")]:
        del sys.modules[module]
    from app import aggregate  # noqa: PLC0415 - imported after the data dir is set
    from app import main  # noqa: PLC0415

    main.initialize()
    built = main.backfill_metrics(limit=None)
    with main.connect() as fresh:
        rebuilt = aggregate.refresh_rollups(fresh, limit=100_000, budget_s=None)
        aggregate.prune_facets(fresh)
    print(f"Rebuilt metrics for {built} calls and {rebuilt} rollup buckets")


def prerender(source: Path, target: Path, published: list[dict[str, Any]]) -> int:
    """Render each call's playable WAV and waveform envelope once.

    This is the difference between a public page that survives a launch and one
    that does not: without it every play, seek and zoom re-decodes the whole
    recording on the server. Rendering reads the raw package from the *source*
    directory, because the snapshot deliberately does not carry it.
    """
    os.environ["VAANI_DATA_DIR"] = str(source)
    os.environ.pop("VAANI_DEMO_MODE", None)
    for module in [name for name in list(sys.modules) if name.startswith("app.")]:
        del sys.modules[module]
    from app import main  # noqa: PLC0415

    total = 0
    for item in published:
        session_id = item["id"]
        manifest = item["manifest"]
        directory = source / "objects" / session_id
        out = target / "objects" / session_id / "preview"
        out.mkdir(parents=True, exist_ok=True)
        for track in served_tracks(manifest, item["has_evaluation"]):
            try:
                wav = main.timeline_wav(directory, manifest, track)
            except Exception as error:  # noqa: BLE001 - a track that cannot render is skipped, not fatal
                print(f"  skipped {session_id}/{track}: {error}")
                continue
            (out / f"{track}.wav").write_bytes(wav)
            summary = main.wav_peaks(wav, main.PEAKS_PUBLISHED_BUCKETS,
                                     main.channel_labels(manifest, track))
            (out / f"{track}.peaks.json").write_text(json.dumps(summary), encoding="utf-8")
            total += 1
    print(f"Pre-rendered {total} audio tracks and waveform envelopes")


def write_config(target: Path, published: list[dict[str, Any]], demo_now: datetime,
                 args: argparse.Namespace) -> None:
    newest = max(item["started"] for item in published)
    featured = published[-1]
    tracks = served_tracks(featured["manifest"], featured["has_evaluation"])
    probe = [f"{featured['id']}/preview/{tracks[0]}.wav"] if tracks else []
    config = {
        "snapshot_id": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
        "demo_now_ms": int(demo_now.timestamp() * 1000),
        "window_label": newest.strftime("%B %Y"),
        "window_days": WINDOW_DAYS,
        "call_count": len(published),
        "featured_session_id": published[-1]["id"],
        "site_url": args.site_url,
        "booking_url": args.booking_url,
        "media_probe": probe,
    }
    (target / "demo.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {target / 'demo.json'}")


def report(findings: dict[str, int], published: list[dict[str, Any]], target: Path) -> None:
    size = sum(path.stat().st_size for path in target.rglob("*") if path.is_file())
    print(f"\nSnapshot: {len(published)} calls, {size / 1024 / 1024:.1f} MB at {target}")
    print(f"Featured call: {published[-1]['id']} ({published[-1]['turns']} turns)")
    if not findings:
        print("Redaction: nothing matched.")
        return
    print("\nRedaction report")
    for name in sorted(findings):
        print(f"  {name}: {findings[name]}")
    flagged = {name: count for name, count in findings.items() if name.startswith("possible_")}
    if flagged:
        print("\n  REVIEW REQUIRED: the values above matched personal-data shapes and were")
        print("  left in place deliberately. Confirm each is sample data before publishing.")


if __name__ == "__main__":
    raise SystemExit(build())
