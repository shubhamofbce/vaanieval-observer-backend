from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import socket
import sqlite3
import struct
import sys
import threading
import time
import uuid
import zlib
from array import array
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import aggregate, alerts, demo, keys, metrics, onboarding, payload, pricing
from app.latency import speech_window

ROOT = Path(os.environ.get("VAANI_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
OBJECTS = ROOT / "objects"
DATABASE = ROOT / "vaani.db"
STATIC = Path(__file__).resolve().parent / "static"
STT_EVALUATION = STATIC / "stt-evaluation.html"
ALLOWED_OBJECTS = {"events.jsonl", "call.audio", "caller.audio", "agent.audio"}
# An operation that stopped because something cancelled it is not a fault: a TTS
# span aborted by barge-in is the agent behaving correctly. Only an explicit
# abort name is trustworthy — provider error text often says "cancelled" about a
# genuine failure — and the dashboard applies the same rule client side, so the
# rail's count and the call's failure KPI can never disagree.
ABORT_NAMES = ("AbortError", "CancelledError", "CancelledException")
ABORT_PLACEHOLDERS = ", ".join("?" for _ in ABORT_NAMES)
# A local safety ceiling; production should use direct object storage limits instead.
MAX_UPLOAD_BYTES = 128 * 1024 * 1024
# How many of an agent's calls a cohort comparison samples. Each member is a
# full evaluation build, so this bounds the cost of one request.
COHORT_SAMPLE_LIMIT = 25
CHALLENGER_MODELS = {
    "elevenlabs_scribe_v2": {"provider": "elevenlabs", "model": "scribe_v2", "label": "ElevenLabs Scribe v2"},
}
SEMANTIC_RISK_MODEL = os.environ.get("STT_EVAL_JUDGE_MODEL", "gpt-4o-mini")
# The work is intentionally off the request thread. Jobs are also recorded in
# SQLite, so the UI has a stable status to poll while a replay is running.
CHALLENGER_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="challenger-evaluation")
CHALLENGER_JOB_LOCK = threading.Lock()
# Signals the aggregate maintenance thread to stop. Never set in the server; it
# exists so a test or an embedding process can shut the loop down cleanly.
MAINTENANCE_STOP = threading.Event()
# How many pre-existing calls one backfill pass derives metrics for. Bounded so
# startup stays fast; the rest is picked up by later passes.
BACKFILL_STARTUP_LIMIT = 500
# How long a statement waits for the single writer before giving up. SQLite is
# single-writer, so a slow ingest must make a concurrent request wait, not fail.
SQLITE_TIMEOUT_S = 30.0
# Aggregate maintenance (backfill + rollup rebuilds) runs on this interval on a
# background thread. It is deliberately NOT on the request path: rebuilding a
# dirty bucket takes the write lock, and a GET that takes the write lock turns
# every dashboard view into a writer that can block ingest for minutes.
MAINTENANCE_INTERVAL_S = 20.0
# Dirty buckets rebuilt per maintenance pass. Bounded so one pass cannot hold
# the write lock for minutes after a metrics-version bump invalidates every
# bucket; the remainder is picked up by the next pass and the dashboard reports
# how much evidence is still pending.
MAINTENANCE_ROLLUP_LIMIT = 120
MAINTENANCE_BACKFILL_LIMIT = 100
# Wall-clock ceiling on the rollup portion of one pass. The bucket count alone
# is the wrong bound: a bucket in a busy hour costs far more to rebuild than one
# in a quiet hour, and what ingest actually feels is elapsed write time.
MAINTENANCE_ROLLUP_BUDGET_S = 5.0
# Facet pruning scans every turn row (measured at 655 ms per pass at 100k calls,
# almost always deleting nothing), so it runs on its own slow cadence instead of
# on every pass. A retired filter value lingers in a dropdown for at most this
# long, which is cosmetic; adding 655 ms of write-lock to every 20 s pass is not.
FACET_PRUNE_INTERVAL_S = 900.0
# Only one process should run maintenance. Every uvicorn worker executes the
# startup hook, so N workers would otherwise run N maintenance threads and N
# backfills against one SQLite file, multiplying the write contention they exist
# to avoid. The owner renews a lease; another process takes over only if the
# lease goes stale, so a crashed owner is replaced rather than leaving the tier
# permanently unmaintained.
# Host and pid alone are not unique: two containers both run as pid 1, and both
# would satisfy "owner == me" and renew the same lease forever. The per-process
# nonce makes the identity unique wherever the process runs.
MAINTENANCE_IDENTITY = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
MAINTENANCE_LEASE_KEY = "maintenance_owner"
MAINTENANCE_LEASE_TTL_S = MAINTENANCE_INTERVAL_S * 4
# The shortest span that can physically be a spoken reply: STT finalisation,
# a model round trip and the first TTS audio chunk. Below this, `first_audio`
# and `speech_end` are the same instant recorded twice rather than a fast agent,
# so the turn is reported as not measurable instead of as the fastest turn in
# the fleet. Applied in `group_turns` so the call page and the aggregate agree.
MIN_PLAUSIBLE_RESPONSE_MS = 250
# Default dashboard window when the caller does not supply one.
DEFAULT_RANGE_MS = 7 * 24 * 60 * 60 * 1000
MAX_RANGE_MS = 180 * 24 * 60 * 60 * 1000
# Ingest is unauthenticated by default, which is what every existing agent
# pointed at a local instance depends on: both SDKs require *some* api_key to
# upload, and the documented value is the literal string `local-dev`. Turning
# enforcement on by default would break those integrations silently at the one
# moment — mid-onboarding — when the developer is least able to tell a
# credential problem from a wiring problem. Keys are therefore always minted and
# always *recorded* when presented, and `VAANI_REQUIRE_API_KEY=1` is what turns
# that record into a gate. Read per request, not at import, so a test or an
# operator can flip it without a restart.
REQUIRE_API_KEY_ENV = "VAANI_REQUIRE_API_KEY"

# The public demo is a fixed snapshot, so "now" is a property of the data rather
# than of the visitor's clock. Resolved once at import: it must not drift
# between the KPI row and the chart under it during a single page load.
DEMO_MODE = demo.enabled()
DEMO_CONFIG: dict[str, Any] = demo.load_config(ROOT) if DEMO_MODE else {}


def demo_ga_id() -> str:
    """Measurement id for the public demo, empty when analytics is not set up."""
    return os.environ.get("VAANI_DEMO_GA_ID", "").strip()
MEDIA_LIMITER = demo.MediaLimiter()


def wall_clock_ms() -> int:
    """The moment the product should treat as "now".

    In the demo this is the newest call in the published snapshot, so a range
    control still selects calls a year after the snapshot was cut. Everywhere
    else it is the real clock.
    """
    if DEMO_MODE:
        return int(DEMO_CONFIG["demo_now_ms"])
    return round(datetime.now(UTC).timestamp() * 1000)


def now() -> str:
    return datetime.now(UTC).isoformat()


def initialize() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    OBJECTS.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, status TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS operations (
              id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation_json TEXT NOT NULL,
              started_at_ms INTEGER NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id)
            );
            CREATE INDEX IF NOT EXISTS operations_timeline ON operations(session_id, started_at_ms);
            CREATE TABLE IF NOT EXISTS challenger_evaluation_jobs (
              session_id TEXT NOT NULL, model_key TEXT NOT NULL, job_id TEXT NOT NULL,
              status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
              started_at TEXT, completed_at TEXT,
              PRIMARY KEY (session_id, model_key),
              FOREIGN KEY(session_id) REFERENCES sessions(id)
            );
            """
        )
        # turn_id and scope are promoted out of the JSON blob so grouping by turn
        # is an indexed query rather than a full-table JSON scan.
        columns = {row["name"] for row in db.execute("PRAGMA table_info(operations)")}
        if "turn_id" not in columns:
            db.execute("ALTER TABLE operations ADD COLUMN turn_id TEXT")
        if "scope" not in columns:
            db.execute("ALTER TABLE operations ADD COLUMN scope TEXT NOT NULL DEFAULT 'turn'")
        # The rail counts failures for every call it lists, so the flag is
        # promoted for the same reason turn_id was: summing a column beats
        # decoding one JSON blob per operation on every poll.
        #
        # Presence of the column is the wrong thing to key the backfill on: a
        # process that dies between the ALTER and the UPDATE would leave every
        # historical call reporting zero failures forever, and the console would
        # be confidently wrong. `user_version` records that the data — not just
        # the schema — has been migrated, so the scan runs exactly once.
        if "failed" not in columns:
            db.execute("ALTER TABLE operations ADD COLUMN failed INTEGER NOT NULL DEFAULT 0")
        if db.execute("PRAGMA user_version").fetchone()[0] < 1:
            db.execute(
                "UPDATE operations SET failed = CASE WHEN json_extract(operation_json, '$.status') = 'error' "
                f"AND COALESCE(json_extract(operation_json, '$.error.name'), '') NOT IN ({ABORT_PLACEHOLDERS}) "
                "THEN 1 ELSE 0 END",
                tuple(ABORT_NAMES),
            )
            db.execute("PRAGMA user_version = 1")
        db.execute(
            "CREATE INDEX IF NOT EXISTS operations_turns ON operations(session_id, turn_id, started_at_ms)"
        )
        aggregate.ensure_schema(db)
        keys.ensure_schema(db)
        # A local worker cannot survive a process restart. Make that explicit
        # instead of showing a permanently spinning challenger in the console.
        db.execute(
            "UPDATE challenger_evaluation_jobs SET status = 'failed', error = 'The dashboard restarted before this evaluation finished.', completed_at = ? "
            "WHERE status IN ('queued', 'in_progress')",
            (now(),),
        )


@contextmanager
def connect():
    if DEMO_MODE:
        # Immutable, not merely read-only: SQLite then never takes a lock, never
        # looks for a WAL or journal, and never writes a hot-journal recovery
        # into a directory that may not even be writable. A published snapshot
        # is a file that cannot change, and this is how you say so.
        db = sqlite3.connect(f"file:{DATABASE}?mode=ro&immutable=1", uri=True, timeout=SQLITE_TIMEOUT_S)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only = ON")
        try:
            yield db
        finally:
            db.close()
        return
    db = sqlite3.connect(DATABASE, timeout=SQLITE_TIMEOUT_S)
    db.row_factory = sqlite3.Row
    # WAL lets the dashboard read while a call is being ingested. Under the
    # default rollback journal a single upload blocks every reader, which is
    # exactly the moment someone is watching the dashboard. `busy_timeout` makes
    # a contended writer wait rather than fail the request outright.
    db.execute("PRAGMA journal_mode = WAL")
    db.execute(f"PRAGMA busy_timeout = {round(SQLITE_TIMEOUT_S * 1000)}")
    try:
        yield db
        db.commit()
    finally:
        db.close()


class SessionCreate(BaseModel):
    schema_version: str = "1.0"
    session_id: str = Field(min_length=1, max_length=160)
    agent_id: str | None = None
    started_at: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    outcome: str = "unknown"
    capture_status: dict[str, Any] = Field(default_factory=dict)
    audio: dict[str, dict[str, Any]] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    sdk: dict[str, Any] = Field(default_factory=dict)


class ObjectInfo(BaseModel):
    byte_size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


class CompleteSession(BaseModel):
    objects: dict[str, ObjectInfo] = Field(default_factory=dict)


class ChallengerEvaluationRequest(BaseModel):
    model: str


class ApiKeyCreate(BaseModel):
    # The name is a label, not an identifier: two keys may share one, and the
    # UI distinguishes them by prefix. Bounded so a paste accident cannot put a
    # megabyte of text into a row that is rendered on every page load.
    name: str = Field(default="", max_length=keys.MAX_NAME_LENGTH)


app = FastAPI(title="Vaani Observer", version="0.1.0")
app.mount("/assets", StaticFiles(directory=STATIC), name="assets")


@app.middleware("http")
async def demo_gate(request: Request, call_next):
    """The public demo's entire attack surface, in one place.

    An allowlist rather than a verb block: the risk is not that someone sends a
    POST today, it is that a read-shaped endpoint added next month becomes
    public without anyone deciding that it should.
    """
    if not DEMO_MODE:
        return await call_next(request)
    if not demo.is_allowed(request.method, request.url.path):
        return Response(
            json.dumps({"detail": "This is a read-only public demo."}),
            status_code=404,
            media_type="application/json",
            headers=demo.security_headers(request.url.path, bool(demo_ga_id())),
        )
    if demo.is_media(request.url.path) and not MEDIA_LIMITER.allow(
        demo.client_key(request), time.monotonic()
    ):
        headers = demo.security_headers(request.url.path, bool(demo_ga_id()))
        headers["Retry-After"] = "30"
        # No caching of a refusal: the next request from this visitor, a few
        # seconds later, is meant to succeed.
        headers["Cache-Control"] = "no-store"
        return Response(
            json.dumps({"detail": "Too many audio requests. Please slow down."}),
            status_code=429,
            media_type="application/json",
            headers=headers,
        )
    response = await call_next(request)
    for name, value in demo.security_headers(request.url.path, bool(demo_ga_id())).items():
        response.headers[name] = value
    return response


@app.middleware("http")
async def no_store_assets(request: Request, call_next):
    """The console is served from disk on localhost; a cached bundle just hands
    the reviewer a stale UI after an upgrade."""
    response = await call_next(request)
    if DEMO_MODE:
        # The demo is a fixed artifact behind a CDN; `no-store` there would make
        # every visitor re-download the console.
        return response
    if request.url.path.startswith("/assets") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.on_event("startup")
def startup() -> None:
    if DEMO_MODE:
        # No schema creation, no backfill, no rollup rebuild, no facet pruning
        # and no maintenance lease. Every one of those writes, and the snapshot
        # is opened immutable: the correct behaviour is to serve what was
        # published, exactly as it was published.
        return
    initialize()
    backfill_metrics(limit=BACKFILL_STARTUP_LIMIT)
    # A metrics-version bump can retire facet values (canonicalising providers
    # merged three Deepgram spellings into one). Pruning at startup means the
    # first dashboard load after an upgrade does not offer filters that match
    # nothing.
    with connect() as db:
        aggregate.prune_facets(db)
    start_maintenance()


_LAST_FACET_PRUNE = 0.0


def maintenance_pass(force_prune: bool = False) -> dict[str, int]:
    """One bounded pass of aggregate upkeep. Safe to call from anywhere.

    Each piece takes the write lock only for as long as it needs it:
    `refresh_rollups` commits per bucket under a wall-clock budget, and facet
    pruning - a full scan of every turn row - runs on its own connection and its
    own slow cadence rather than inside the rollup pass.
    """
    global _LAST_FACET_PRUNE
    built = backfill_metrics(limit=MAINTENANCE_BACKFILL_LIMIT)
    with connect() as db:
        rebuilt = aggregate.refresh_rollups(db, limit=MAINTENANCE_ROLLUP_LIMIT,
                                            budget_s=MAINTENANCE_ROLLUP_BUDGET_S)
    pruned = 0
    if force_prune or time.monotonic() - _LAST_FACET_PRUNE >= FACET_PRUNE_INTERVAL_S:
        with connect() as db:
            pruned = aggregate.prune_facets(db)
        _LAST_FACET_PRUNE = time.monotonic()
    with connect() as db:
        aggregate.set_meta(db, "maintenance_heartbeat_ms", str(int(time.time() * 1000)))
    return {"calls_built": built, "buckets_rebuilt": rebuilt, "facets_pruned": pruned}


def claim_maintenance(db: sqlite3.Connection) -> bool:
    """Take or renew the single-owner maintenance lease.

    Returns whether this process owns maintenance. An owner that stops renewing
    (crashed, killed, or stuck) loses the lease after `MAINTENANCE_LEASE_TTL_S`
    and another process picks it up, so the rollup tier cannot be orphaned.
    """
    # The claim itself is atomic; see `aggregate.claim_lease`.
    return aggregate.claim_lease(db, MAINTENANCE_LEASE_KEY, MAINTENANCE_IDENTITY,
                                 MAINTENANCE_LEASE_TTL_S * 1000, int(time.time() * 1000))


def start_maintenance() -> None:
    """Runs aggregate upkeep on a timer instead of on a reader's request.

    The first pass is deferred by a full interval: a short-lived process (a test
    run, a CLI import) should never race the work it did synchronously.
    """
    if os.environ.get("VAANI_DISABLE_MAINTENANCE") == "1":
        return

    def loop() -> None:
        while not MAINTENANCE_STOP.wait(MAINTENANCE_INTERVAL_S):
            try:
                with connect() as db:
                    owns = claim_maintenance(db)
                if owns:
                    maintenance_pass()
            except Exception:  # noqa: BLE001 - upkeep must never kill the server
                pass

    thread = threading.Thread(target=loop, name="aggregate-maintenance", daemon=True)
    thread.start()


def backfill_metrics(limit: int | None = None) -> int:
    """Derive aggregate facts for calls ingested before this feature existed.

    Bounded per pass so a large archive does not hold the first request open;
    whatever is still pending is reported in the dashboard's coverage block, so
    an under-counted total is visible rather than mistaken for a quiet week.
    """
    with connect() as db:
        return aggregate.backfill(
            db, lambda session_id: session_metric_inputs(session_id, db), limit=limit
        )


def asset_version() -> str:
    """A short stamp that changes whenever a static file changes.

    The demo serves `/assets/` with a one-year immutable cache, which is right
    for a fixed artifact and wrong without a version in the URL: a visitor who
    saw an earlier build would keep their copy of the stylesheet for a year and
    never see a correction. Stamping the references makes the long cache safe,
    because a changed file is a changed URL.

    The stamp hashes file *contents*, not size and mtime. A same-length edit
    (renaming a button from "Book a demo" to "Book a call", say) leaves both of
    those untouched, and the zip deploy carries mtimes along, so a metadata
    stamp would keep serving the old URL and every returning visitor would hold
    the stale file for the full year. Reading the bytes costs a few hundred
    kilobytes once at import and removes that whole class of silent staleness.
    """
    digest = hashlib.sha256()
    for file in sorted(STATIC.rglob("*")):
        if file.is_file():
            digest.update(file.name.encode())
            digest.update(file.read_bytes())
    return digest.hexdigest()[:12]


ASSET_VERSION = asset_version() if DEMO_MODE else ""
ASSET_REF = re.compile(r'(?P<attr>src|href)="(?P<url>/assets/[^"?]+)"')


def page(path: Path, route: str) -> Response:
    """Serve a console page, wearing the demo skin when the demo is on.

    The demo's frozen clock has to be known before the first render, not one
    fetch later: a dashboard that paints "2 minutes ago" from the real wall
    clock and then corrects itself to a 2026 sample window has already told the
    visitor the data is fake. Injecting the config into the document removes
    the round trip, and the injection is confined to demo mode so the shipped
    product serves the same static files it always did.
    """
    if not DEMO_MODE:
        return FileResponse(path)
    html = path.read_text(encoding="utf-8")
    # Read from the environment rather than the snapshot: the measurement id
    # is deployment configuration, and baking it into the snapshot would mean
    # rebuilding 250MB of media to change an analytics setting.
    config = json.dumps({
        **DEMO_CONFIG,
        "demo": True,
        "ga_id": demo_ga_id(),
    })
    injection = (
        f"<script>window.__VAANI_DEMO__={config};</script>\n"
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2'
        "?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        '">\n'
        '<link rel="icon" href="/assets/vaanieval-logo.jpg">\n'
        '<link rel="stylesheet" href="/assets/demo.css">\n'
        '<script defer src="/assets/demo.js"></script>\n'
        '<script defer src="/assets/analytics.js"></script>\n'
    )
    html = html.replace("</head>", f"{injection}</head>", 1)
    html = ASSET_REF.sub(
        lambda m: f'{m["attr"]}="{m["url"]}?v={ASSET_VERSION}"', html
    )
    return Response(html, media_type="text/html; charset=utf-8",
                    headers=demo.security_headers(route, bool(demo_ga_id())))


@app.get("/")
def console() -> Response:
    return page(STATIC / "index.html", "/")


@app.get("/dashboard")
def dashboard_page() -> Response:
    """Fleet-wide view. The call console stays on `/` so existing `#/call/...`
    links, bookmarks and the SDK's printed URLs keep working unchanged."""
    return page(STATIC / "dashboard.html", "/dashboard")


@app.get("/alerts")
def alerts_page() -> Response:
    """Fleet alerts. Fixed rules, evaluated against the same aggregate the
    dashboard reads, so every alert is followed by the calls that caused it."""
    return page(STATIC / "alerts.html", "/alerts")


@app.get("/stt-evaluation")
def stt_evaluation() -> Response:
    """The full per-call STT comparison workspace.

    It deliberately lives beside the existing call console: a reviewer first
    uses the fast operational view, then opens this focused, decision-heavy
    surface only when they choose a challenger comparison.
    """
    return page(STT_EVALUATION, "/stt-evaluation")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, Any]:
    """Readiness for the public demo: is there actually a dataset to serve?

    A container that boots with an empty disk mount would otherwise pass a
    liveness check and serve an empty dashboard to visitors. This fails
    instead, so the platform holds traffic on the previous release.
    """
    if not DEMO_MODE:
        return {"status": "ok", "demo": False}
    problems: list[str] = []
    if not DATABASE.is_file():
        problems.append("database missing")
    calls = 0
    if not problems:
        try:
            with connect() as db:
                calls = db.execute("SELECT COUNT(*) FROM sessions WHERE status = 'ready'").fetchone()[0]
        except sqlite3.Error as error:
            problems.append(f"database unreadable: {error}")
    if calls == 0 and not problems:
        problems.append("snapshot contains no ready calls")
    missing = [name for name in DEMO_CONFIG.get("media_probe", []) if not (OBJECTS / name).is_file()]
    if missing:
        problems.append(f"missing media: {', '.join(missing[:3])}")
    if problems:
        raise HTTPException(503, "; ".join(problems))
    return {"status": "ok", "demo": True, "calls": calls,
            "demo_now_ms": DEMO_CONFIG.get("demo_now_ms"),
            "snapshot": DEMO_CONFIG.get("snapshot_id")}


@app.get("/v1/demo/config")
def demo_config() -> dict[str, Any]:
    """What the browser needs to render the demo honestly.

    The frozen clock has to reach the client: the dashboard computes its own
    range windows, and a client using the real `Date.now()` against a fixed
    dataset would ask for a week that contains no calls.
    """
    if not DEMO_MODE:
        return {"demo": False}
    return {
        "demo": True,
        "demo_now_ms": DEMO_CONFIG["demo_now_ms"],
        "window_label": DEMO_CONFIG.get("window_label", ""),
        "call_count": DEMO_CONFIG.get("call_count", 0),
        "snapshot_id": DEMO_CONFIG.get("snapshot_id", ""),
        # The console is the demo's strongest artifact and a visitor who only
        # sees the dashboard never reaches it, so the chrome needs somewhere
        # concrete to point them.
        "featured_session_id": DEMO_CONFIG.get("featured_session_id", ""),
        "site_url": DEMO_CONFIG.get("site_url", "https://www.vaanieval.com"),
        "booking_url": DEMO_CONFIG.get("booking_url", "https://calendar.app.google/5cNH8hB13LoC39Qk7"),
    }


def require_api_key() -> bool:
    """Whether ingest must present a key this instance knows."""
    return os.environ.get(REQUIRE_API_KEY_ENV) == "1"


def authenticate(request: Request) -> str | None:
    """Record — and, when enforced, check — the key on an ingest request.

    Called at the top of every write endpoint an SDK touches. It has two jobs
    and they are deliberately independent:

    * It always stamps `last_used_at` on a recognised key. That single write is
      what lets the onboarding page distinguish "a key was created in a browser"
      from "an agent authenticated", which is the only version of that step
      worth showing a developer.
    * It rejects the request *only* when `VAANI_REQUIRE_API_KEY=1`. Off by
      default, because the documented local setup uses the literal key
      `local-dev` and quietly 401-ing those agents would break every existing
      integration.

    Object `PUT`s are exempt by design: both SDKs strip the Authorization header
    from them, because the upload URL is meant to be a pre-signed object-store
    URL and re-sending the API key would hand it to that third party. The URL is
    the capability; the session it names was created under an authenticated
    request.

    A failure to *record* usage must never fail ingest — the call is intact and
    the timestamp is cosmetic — but a failure to *enforce* must, or the gate is
    not a gate.
    """
    token = keys.bearer(request.headers.get("authorization"))
    enforced = require_api_key()
    try:
        with connect() as db:
            key_id = keys.record_use(db, token, now())
    except Exception:  # noqa: BLE001 - usage telemetry is never worth a failed upload
        if not enforced:
            return None
        raise
    if enforced and key_id is None:
        # The two failures are told apart because they have different fixes, and
        # neither reveals anything an unauthenticated caller does not already
        # know: that this instance requires a key.
        raise HTTPException(
            401,
            "Missing API key. Send `Authorization: Bearer <key>`; create one on the dashboard's Onboarding page."
            if token is None
            else "Unknown or revoked API key. Create a new one on the dashboard's Onboarding page.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return key_id


@app.get("/onboarding")
def onboarding_page() -> FileResponse:
    """The first screen a new developer should see: install, instrument, verify.

    It is a separate surface from the dashboard rather than an empty-state
    banner on it, because onboarding is not finished the moment the first call
    lands — the step that catches a wrongly configured `endpoints` list is the
    one *after* that — and a banner that vanishes on first data takes the
    diagnosis with it.
    """
    return FileResponse(STATIC / "onboarding.html")


@app.get("/v1/onboarding/status")
def onboarding_status(request: Request) -> dict[str, Any]:
    """Everything this instance can prove about a developer's setup.

    The ingest endpoint is echoed back from the request rather than configured,
    so the snippet the page renders is copy-pasteable as-is from wherever the
    dashboard is actually being reached — `localhost:8000`, a LAN address or a
    tunnel — instead of being right only on the machine that started it.
    """
    with connect() as db:
        state = onboarding.status(db, require_api_key=require_api_key())
    state["endpoint"] = str(request.base_url).rstrip("/")
    state["generated_at"] = now()
    return state


@app.get("/v1/api-keys")
def list_api_keys() -> dict[str, Any]:
    """Key metadata — names, prefixes, usage. Never a secret, and deliberately
    as open as every other read endpoint on this console, which has never had
    authentication. Gating this one list while `/v1/sessions` and the whole
    dashboard stay open would be theatre that locks an operator out of their own
    key table without protecting anything."""
    with connect() as db:
        return {"keys": keys.listing(db)}


def authorize_key_admin(request: Request) -> None:
    """Guard the two endpoints that mint and retire credentials.

    Unguarded, these defeat the very gate they exist to serve: an actor who can
    reach ingest can `POST /v1/api-keys`, receive a live token and walk straight
    through `VAANI_REQUIRE_API_KEY=1`. The gate has to be worth more than one
    unauthenticated request.

    So with enforcement on, minting or revoking requires an existing live key —
    with exactly one exception, because otherwise an operator who switches
    enforcement on before creating a key can never create one: a request from
    the loopback interface may mint the *first* key when no active key exists.

    Trusting a source address is normally the wrong instinct, and it is wrong
    here too if a reverse proxy sits in front of this service: every remote
    visitor would arrive as 127.0.0.1. Two things keep it narrow. A request
    carrying any forwarding header is not treated as local, which covers every
    proxy that annotates what it forwards; and the exception applies only while
    zero active keys exist, so it closes permanently the moment it is used.
    An operator terminating TLS on a proxy that strips *and* does not annotate
    should mint the first key on the host itself.
    """
    if not require_api_key():
        return
    token = keys.bearer(request.headers.get("authorization"))
    with connect() as db:
        if keys.verify(db, token) is not None:
            return
        active = db.execute("SELECT COUNT(*) AS live FROM api_keys WHERE revoked_at IS NULL").fetchone()["live"]
    if not active and is_loopback(request):
        return
    raise HTTPException(
        401,
        "This instance requires an API key to manage keys. Send `Authorization: Bearer <live key>`,"
        " or create the first key from the host itself.",
        headers={"WWW-Authenticate": "Bearer"},
    )


# Headers a proxy adds to say "this request is not mine". Any of them means the
# peer address belongs to the proxy, not the client, so it proves nothing.
FORWARDING_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded")


def is_loopback(request: Request) -> bool:
    if any(request.headers.get(name) for name in FORWARDING_HEADERS):
        return False
    host = request.client.host if request.client else None
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        # A dual-stack listener reports an IPv4 client as `::ffff:127.0.0.1`.
        # Matching literal strings would refuse the bootstrap to an operator
        # standing on the host — locking them out of ever minting a first key.
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@app.post("/v1/api-keys", status_code=201)
def create_api_key(body: ApiKeyCreate, request: Request) -> dict[str, Any]:
    """Mint a key. The `token` field in this response is the only time it exists
    outside the caller's clipboard — the server keeps a SHA-256 digest and
    cannot reproduce it."""
    authorize_key_admin(request)
    with connect() as db:
        try:
            record, token = keys.mint(db, body.name, now())
        except keys.KeyLimitExceeded as error:
            raise HTTPException(409, str(error)) from error
    return {**record, "token": token}


@app.delete("/v1/api-keys/{key_id}")
def revoke_api_key(key_id: str, request: Request) -> dict[str, Any]:
    authorize_key_admin(request)
    with connect() as db:
        record = keys.revoke(db, key_id, now())
    if record is None:
        raise HTTPException(404, "Unknown API key")
    return record


@app.post("/v1/sessions", status_code=201)
def create_session(manifest: SessionCreate, request: Request) -> dict[str, Any]:
    authenticate(request)
    session_id = manifest.session_id
    # The idempotency key is deliberately advisory in this no-auth local MVP.
    if request.headers.get("idempotency-key") not in (None, session_id):
        raise HTTPException(400, "Idempotency-Key must equal session_id")
    with connect() as db:
        row = db.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            db.execute(
                "INSERT INTO sessions VALUES (?, ?, 'uploading', ?, ?, NULL)",
                (session_id, manifest.model_dump_json(), now(), now()),
            )
    base_url = str(request.base_url).rstrip("/")
    return {
        "session_id": session_id,
        "upload_urls": {name: f"{base_url}/v1/uploads/{session_id}/{name}" for name in ALLOWED_OBJECTS},
        # Capability advertisement. An SDK must not compress unless the server
        # says it can decompress: a dashboard predating gzip support stores the
        # compressed bytes verbatim and then fails verification at /complete,
        # losing the whole recording. Absent field means "identity only".
        "accepted_encodings": ["gzip"],
    }


@app.put("/v1/uploads/{session_id}/{object_name}", status_code=204)
async def upload_object(session_id: str, object_name: str, request: Request) -> None:
    require_session(session_id)
    if object_name not in ALLOWED_OBJECTS:
        raise HTTPException(404, "Unsupported object name")
    target_dir = safe_session_dir(session_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    # Call audio is raw PCM, which is both the largest object and the most
    # compressible. Accepting it gzipped cuts the upload roughly threefold
    # without changing a single byte of what lands on disk, so every consumer
    # that seeks by sample offset keeps working unchanged.
    encoding = (request.headers.get("content-encoding") or "").strip().lower()
    if encoding not in ("", "identity", "gzip"):
        raise HTTPException(415, f"Unsupported Content-Encoding: {encoding}")
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == "gzip" else None
    declared = request.headers.get("content-length")
    # Only meaningful when the body is the object itself; a compressed body is
    # bounded by the decompressed count below instead.
    if (
        decompressor is None
        and declared
        and declared.isdigit()
        and int(declared) > MAX_UPLOAD_BYTES
    ):
        raise HTTPException(413, "Object exceeds the 128 MiB local MVP limit")
    # Reading the whole body first would let an oversized upload exhaust memory
    # before the ceiling could reject it, so it is streamed and counted as it
    # lands. The partial file is named apart so a rejected upload can never be
    # mistaken for a complete one, and uniquely so two uploaders racing on the
    # same object -- an in-process upload and a spool drainer, say -- cannot
    # interleave their writes into one temp file or delete each other's.
    target = target_dir / object_name
    partial = target.with_name(f"{object_name}.{uuid.uuid4().hex}.part")
    written = 0
    try:
        with partial.open("wb") as handle:
            async for chunk in request.stream():
                if decompressor is not None:
                    try:
                        # Bounded so one chunk of a gzip bomb cannot be expanded
                        # in memory before the ceiling below gets to reject it;
                        # zlib's ratio tops out near 1032:1, which turns a 64 KiB
                        # socket read into ~66 MB.
                        chunk = decompressor.decompress(chunk, MAX_UPLOAD_BYTES - written + 1)
                    except zlib.error as error:
                        raise HTTPException(400, f"Malformed gzip body: {error}") from error
                    if decompressor.unconsumed_tail:
                        raise HTTPException(413, "Object exceeds the 128 MiB local MVP limit")
                if not chunk:
                    continue
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "Object exceeds the 128 MiB local MVP limit")
                handle.write(chunk)
            if decompressor is not None:
                try:
                    tail = decompressor.flush()
                except zlib.error as error:
                    raise HTTPException(400, f"Malformed gzip body: {error}") from error
                if tail:
                    written += len(tail)
                    if written > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "Object exceeds the 128 MiB local MVP limit")
                    handle.write(tail)
                # `flush()` does not raise on a stream that simply stops early:
                # the CRC and length trailer are never reached, so nothing
                # disagrees. Without this check a truncated body is answered 204
                # and renamed over a previously verified object -- destroying
                # good data with unverified data, which is worse than the
                # identity path, where a short body dies as a ClientDisconnect.
                if not decompressor.eof:
                    raise HTTPException(400, "Truncated gzip body")
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


@app.post("/v1/sessions/{session_id}/complete", status_code=202)
def complete_session(session_id: str, completion: CompleteSession, request: Request) -> dict[str, Any]:
    authenticate(request)
    row = require_session(session_id)
    manifest = json.loads(row["manifest_json"])
    for name, info in completion.objects.items():
        if name not in ALLOWED_OBJECTS:
            raise HTTPException(400, f"Unsupported object name: {name}")
        path = safe_session_dir(session_id) / name
        if not path.is_file():
            raise HTTPException(400, f"Missing upload: {name}")
        payload = path.read_bytes()
        if len(payload) != info.byte_size or hashlib.sha256(payload).hexdigest() != info.sha256.lower():
            raise HTTPException(400, f"Checksum verification failed: {name}")
    operations = import_operations(session_id)
    # A call the SDK could prove it did not fully capture is not "ready". The
    # check lives here, not only in the SDK, so an older SDK that learns to
    # report a gap is believed without the dashboard needing to be redeployed
    # in lockstep -- and so a gap can never be presented as a healthy call.
    fully_covered = manifest.get("capture_status", {}).get("coverage_complete", True) is not False
    status = "ready" if operations and fully_covered else "partial"
    with connect() as db:
        db.execute("DELETE FROM operations WHERE session_id = ?", (session_id,))
        db.executemany(
            "INSERT OR REPLACE INTO operations (id, session_id, operation_json, started_at_ms, turn_id, scope, failed) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    op["event_id"],
                    session_id,
                    json.dumps(op),
                    op.get("started_at_ms", 0),
                    str(op["turn_id"]) if op.get("turn_id") is not None else None,
                    op.get("scope", "turn"),
                    int(has_failed(op)),
                )
                for op in operations
            ],
        )
        db.execute("UPDATE sessions SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?", (status, now(), now(), session_id))
        # Aggregate facts are extracted once, here, so the dashboard never has to
        # JSON-decode a call's spans to answer a fleet-wide question. A failure
        # to derive them must not fail the upload: the call itself is intact and
        # the row is rebuilt by the next backfill pass.
        try:
            rebuild_session_metrics(db, session_id)
        except Exception:  # noqa: BLE001
            pass
    return {"session_id": session_id, "status": status, "operation_count": len(operations), "duration_ms": manifest.get("duration_ms", 0)}


def session_metric_inputs(session_id: str, db: sqlite3.Connection) -> tuple[sqlite3.Row, list[dict[str, Any]], list[dict[str, Any]]]:
    """The exact inputs the call detail view is built from.

    The aggregate is derived from `group_turns` and the same presentation
    windows the call page renders, rather than from a parallel reimplementation.
    That is the only reason a dashboard percentile and the call it links to can
    be relied on to describe the same event.
    """
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Unknown session")
    operations = [
        json.loads(item["operation_json"])
        for item in db.execute(
            "SELECT operation_json FROM operations WHERE session_id = ? ORDER BY started_at_ms", (session_id,)
        )
    ]
    chunk_events = audio_chunk_events(session_id)
    attach_presentation_windows(operations, chunk_events)
    turn_ops = [op for op in operations if op.get("scope", "turn") != "connection"]
    agent_audio_ms = sorted(
        event["occurred_at_ms"]
        for event in chunk_events
        if event.get("track") == "agent" and isinstance(event.get("occurred_at_ms"), (int, float))
    )
    return row, group_turns(turn_ops, agent_audio_ms), operations


def rebuild_session_metrics(db: sqlite3.Connection, session_id: str) -> None:
    row, turns, operations = session_metric_inputs(session_id, db)
    aggregate.rebuild_session(db, row, turns, operations)


@app.get("/v1/sessions")
def list_sessions() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM sessions ORDER BY created_at DESC").fetchall()
        counts = {
            item["session_id"]: item["turn_count"]
            for item in db.execute(
                "SELECT session_id, COUNT(DISTINCT turn_id) AS turn_count FROM operations WHERE turn_id IS NOT NULL GROUP BY session_id"
            )
        }
        failures = {
            item["session_id"]: item["error_count"]
            for item in db.execute("SELECT session_id, SUM(failed) AS error_count FROM operations GROUP BY session_id")
        }
    return [
        {**session_summary(row), "turn_count": counts.get(row["id"], 0), "error_count": failures.get(row["id"], 0) or 0}
        for row in rows
    ]


@app.get("/v1/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    row = require_session(session_id)
    manifest = json.loads(row["manifest_json"])
    with connect() as db:
        operations = [json.loads(item["operation_json"]) for item in db.execute("SELECT operation_json FROM operations WHERE session_id = ? ORDER BY started_at_ms", (session_id,))]
    chunk_events = audio_chunk_events(session_id)
    attach_presentation_windows(operations, chunk_events)
    turn_ops = [op for op in operations if op.get("scope", "turn") != "connection"]
    connections = [op for op in operations if op.get("scope") == "connection"]
    agent_audio_ms = sorted(
        event["occurred_at_ms"]
        for event in chunk_events
        if event.get("track") == "agent" and isinstance(event.get("occurred_at_ms"), (int, float))
    )
    return {
        **session_summary(row),
        "manifest": manifest,
        "operations": operations,
        "turns": group_turns(turn_ops, agent_audio_ms),
        "connections": connections,
        "recordings": recordings(session_id, manifest),
    }


@app.get("/v1/sessions/{session_id}/stt-evaluation")
def get_stt_evaluation(session_id: str) -> dict[str, Any]:
    """Every measured production and challenger value for one recorded call."""
    return evaluation_payload(session_id, with_cohort=True)


@app.get("/v1/sessions/{session_id}/challenger-evaluation")
def get_challenger_evaluation_status(session_id: str) -> dict[str, Any]:
    require_session(session_id)
    with connect() as db:
        row = db.execute(
            "SELECT session_id, model_key, job_id, status, error, created_at, started_at, completed_at "
            "FROM challenger_evaluation_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    return _challenger_job_payload(row)


@app.post("/v1/sessions/{session_id}/challenger-evaluation", status_code=202)
def start_challenger_evaluation(session_id: str, request: ChallengerEvaluationRequest) -> dict[str, Any]:
    """Queue one recorded caller track for an allowed challenger STT model."""
    require_session(session_id)
    if request.model not in CHALLENGER_MODELS:
        raise HTTPException(422, "Unsupported challenger model")

    with CHALLENGER_JOB_LOCK:
        with connect() as db:
            active = db.execute(
                "SELECT session_id, model_key, job_id, status, error, created_at, started_at, completed_at "
                "FROM challenger_evaluation_jobs WHERE session_id = ? AND model_key = ? "
                "AND status IN ('queued', 'in_progress')",
                (session_id, request.model),
            ).fetchone()
            if active:
                return _challenger_job_payload(active)
            job_id = uuid.uuid4().hex
            created_at = now()
            db.execute(
                "INSERT INTO challenger_evaluation_jobs "
                "(session_id, model_key, job_id, status, error, created_at, started_at, completed_at) "
                "VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL) "
                "ON CONFLICT(session_id, model_key) DO UPDATE SET "
                "job_id = excluded.job_id, status = excluded.status, error = NULL, "
                "created_at = excluded.created_at, started_at = NULL, completed_at = NULL",
                (session_id, request.model, job_id, created_at),
            )
    CHALLENGER_EXECUTOR.submit(run_challenger_evaluation, session_id, request.model, job_id)
    return {
        "session_id": session_id,
        "model": request.model,
        "label": CHALLENGER_MODELS[request.model]["label"],
        "job_id": job_id,
        "status": "queued",
        "error": None,
        "created_at": created_at,
        "started_at": None,
        "completed_at": None,
    }


def _challenger_job_payload(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {"status": "not_started", "job_id": None, "model": None, "label": None, "error": None}
    data = dict(row)
    config = CHALLENGER_MODELS.get(data["model_key"], {})
    return {
        "session_id": data["session_id"],
        "model": data["model_key"],
        "label": config.get("label", data["model_key"]),
        "job_id": data["job_id"],
        "status": data["status"],
        "error": data["error"],
        "created_at": data["created_at"],
        "started_at": data["started_at"],
        "completed_at": data["completed_at"],
    }


def run_challenger_evaluation(session_id: str, model_key: str, job_id: str) -> None:
    """Execute a replay without keeping the API request open."""
    config = CHALLENGER_MODELS[model_key]
    with connect() as db:
        updated = db.execute(
            "UPDATE challenger_evaluation_jobs SET status = 'in_progress', started_at = ? "
            "WHERE session_id = ? AND model_key = ? AND job_id = ? AND status = 'queued'",
            (now(), session_id, model_key, job_id),
        ).rowcount
    if not updated:
        return
    try:
        from app import challenger, risk

        api_key = challenger.load_api_key()
        if not api_key:
            raise RuntimeError("ELEVENLABS_API_KEY is not configured on this dashboard.")
        run = challenger.collect_batch(session_id, ROOT, api_key, model=config["model"], track="caller")
        challenger.save_run(run, ROOT)
        if run.get("status") != "complete":
            raise RuntimeError(str(run.get("error") or "The challenger did not complete."))
    except Exception as error:
        status, message = "failed", str(error)
    else:
        # Risk is deliberately evaluated from the exact persisted challenger
        # run and deterministic dashboard diff. That keeps the per-turn risk
        # rationale aligned with the transcript comparison the reviewer sees.
        try:
            evaluator_key = risk.load_api_key()
            if not evaluator_key:
                raise RuntimeError("OPENAI_API_KEY is not configured on this dashboard.")
            comparison = evaluation_payload(session_id)
            risk_turns = [
                {
                    "turn_id": turn["turn_id"],
                    "production": (turn.get("production") or {}).get("transcript") or "",
                    "challenger": (turn.get("challenger") or {}).get("transcript") or "",
                    "diff": turn.get("diff") or [],
                    "wer": turn.get("estimated_wer"),
                }
                for turn in comparison.get("turns") or []
            ]
            risk.evaluate_session(session_id, risk_turns, ROOT, evaluator_key, model=SEMANTIC_RISK_MODEL)
        except Exception as error:
            status, message = "partial", f"Challenger transcription finished, but semantic risk evaluation failed: {error}"
        else:
            status, message = "completed", None
    with connect() as db:
        db.execute(
            "UPDATE challenger_evaluation_jobs SET status = ?, error = ?, completed_at = ? "
            "WHERE session_id = ? AND model_key = ? AND job_id = ?",
            (status, message, now(), session_id, model_key, job_id),
        )


def evaluation_payload(session_id: str, with_cohort: bool = False) -> dict[str, Any]:
    # Imported here because the collectors depend on this module's audio
    # rendering; a top-level import would close the cycle.
    from app import challenger, risk

    session = get_session(session_id)
    runs = challenger.load_runs(session_id, ROOT)
    risk_store = risk.load_store(session_id, ROOT)
    events = audio_chunk_events(session_id)
    result = payload.build(session, runs, risk_store, events, ROOT)
    if with_cohort:
        result["cohort"] = cohort_for(session_id, result)
    return result


def cohort_for(session_id: str, current: dict[str, Any]) -> dict[str, Any]:
    """Compare this call against other recorded calls for the same agent.

    The agent filter is applied in SQL, before the sample limit. Limiting first
    and filtering afterwards silently compares an agent against whatever
    happened to be recorded most recently, and returns "only one recorded call"
    for any agent whose calls are not among the newest few.

    Cohort members are built without their own cohort, so this never recurses.
    """
    with connect() as db:
        rows = [
            item["id"]
            for item in db.execute(
                # `IS` rather than `=` so an agent-less manifest matches other
                # agent-less manifests instead of matching nothing.
                "SELECT id FROM sessions WHERE json_extract(manifest_json, '$.agent_id') IS ? "
                "ORDER BY created_at DESC LIMIT ?",
                (current.get("agent_id"), COHORT_SAMPLE_LIMIT),
            )
        ]
    payloads = [current]
    for other_id in rows:
        if other_id == session_id:
            continue
        try:
            payloads.append(evaluation_payload(other_id, with_cohort=False))
        except HTTPException:
            continue
    same_agent = [item for item in payloads if item.get("agent_id") == current.get("agent_id")] or payloads
    return payload.build_cohort(same_agent, session_id, sample_limit=COHORT_SAMPLE_LIMIT)


def audio_chunk_events(session_id: str) -> list[dict[str, Any]]:
    """Raw per-chunk audio receipts, the only evidence of who was talking when."""
    events = safe_session_dir(session_id) / "events.jsonl"
    if not events.is_file():
        return []
    result: list[dict[str, Any]] = []
    for line in events.read_text(encoding="utf-8").splitlines():
        if '"audio_chunk"' not in line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("kind") == "audio_chunk":
            result.append(event)
    return result


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def attach_presentation_windows(operations: list[dict[str, Any]], events: list[dict[str, Any]]) -> None:
    """Attach the review window without rewriting a provider operation span.

    Provider spans answer when a service was working. Presentation windows answer
    when a person could be heard. Keeping both prevents a TTS request completing
    before its queued PCM finishes from truncating playback or faking a barge-in.
    """
    agent = [event for event in events if event.get("kind") == "audio_chunk" and event.get("track") == "agent"]
    for op in operations:
        if op.get("scope") == "connection" or op.get("type") not in {"stt", "tts"}:
            continue
        if op.get("type") == "stt":
            window = speech_window(op)
            start, end = window["start_ms"], window["end_ms"]
            if start is not None and end is not None and end >= start:
                op["presentation_window"] = {
                    "from_ms": start, "to_ms": end, "track": "caller", "kind": "speech",
                    "source": "word_timestamps" if window["from_word_timestamps"] else "speech_milestones",
                    "confidence": "observed" if window["from_word_timestamps"] else "inferred",
                    "provider_span": {"from_ms": op.get("started_at_ms"), "to_ms": op.get("ended_at_ms")},
                }
            continue

        # Ownership metadata is authoritative and preserves actual gaps between
        # streamed PCM chunks. Do not guess ownership from proximity alone.
        owned = [event for event in agent if str(event.get("operation_id")) == str(op.get("event_id"))]
        if not owned and op.get("turn_id") is not None:
            owned = [event for event in agent if event.get("operation_id") is None and str(event.get("turn_id")) == str(op.get("turn_id"))]
        segments = []
        for event in owned:
            start = _number(event.get("playout_at_ms"))
            if start is None:
                start = _number(event.get("occurred_at_ms"))
            duration = _number(event.get("duration_ms"))
            if start is not None and duration is not None and duration > 0:
                segments.append({"from_ms": round(start), "to_ms": round(start + duration)})
        if segments:
            segments.sort(key=lambda item: item["from_ms"])
            op["presentation_window"] = {
                "from_ms": segments[0]["from_ms"], "to_ms": max(item["to_ms"] for item in segments),
                "track": "agent", "kind": "playout", "source": "attributed_audio_chunks", "confidence": "exact",
                "segments": segments,
                "provider_span": {"from_ms": op.get("started_at_ms"), "to_ms": op.get("ended_at_ms")},
            }
            continue
        marks = op.get("milestones") or {}
        first = _number((marks.get("audio_chunk") or {}).get("occurred_at_ms"))
        if first is None:
            first = _number((marks.get("first_byte") or {}).get("occurred_at_ms"))
        rendered = _number((op.get("response") or {}).get("audio_ms"))
        if first is not None and rendered is not None and rendered > 0:
            op["presentation_window"] = {
                "from_ms": round(first), "to_ms": round(first + rendered), "track": "agent", "kind": "playout",
                "source": "inferred_response_audio_duration", "confidence": "inferred",
                "provider_span": {"from_ms": op.get("started_at_ms"), "to_ms": op.get("ended_at_ms")},
            }


@app.get("/v1/dashboard/summary")
def dashboard_summary(
    from_ms: int | None = None,
    to_ms: int | None = None,
    agent_id: str | None = None,
    environment: str | None = None,
    agent_version: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    sdk_language: str | None = None,
    compare: bool = True,
) -> dict[str, Any]:
    """One server-side aggregate for the whole dashboard.

    Deliberately a single request: six panels fetching their own slice would
    each pick a slightly different moment for "now", and the KPI row would stop
    matching the chart under it during an incident - exactly when a developer is
    reading both.
    """
    end = to_ms if to_ms is not None else wall_clock_ms()
    start = from_ms if from_ms is not None else end - DEFAULT_RANGE_MS
    if start >= end:
        raise HTTPException(422, "from_ms must be earlier than to_ms")
    if end - start > MAX_RANGE_MS:
        raise HTTPException(422, "Requested range is larger than the supported window")
    filters = aggregate.Filters(
        start_ms=start, end_ms=end, agent_id=agent_id, environment=environment,
        agent_version=agent_version, provider=provider, model=model, sdk_language=sdk_language,
    )
    # Read-only on purpose. Deriving metrics or rebuilding rollups here would
    # make every dashboard view take SQLite's single write lock; that work runs
    # on the maintenance thread instead, and what it has not caught up on yet is
    # reported below rather than silently missing.
    with connect() as db:
        remaining = aggregate.stale_session_count(db)
        stale_buckets = aggregate.dirty_bucket_count(db)
        result = aggregate.summary(db, filters, compare=compare, pending_calls=remaining)
    result["coverage"]["pending_rollup_buckets"] = stale_buckets
    result["generated_at"] = now()
    return result


@app.get("/v1/alerts")
def alerts_feed(
    from_ms: int | None = None,
    to_ms: int | None = None,
) -> dict[str, Any]:
    """Every rule, evaluated per agent, worst breach first.

    One request rather than one per agent: the rules compare agents against each
    other, and four independently-timed summaries would let two agents be
    measured over different windows and then ranked as if they were not.
    """
    end = to_ms if to_ms is not None else wall_clock_ms()
    start = from_ms if from_ms is not None else end - DEFAULT_RANGE_MS
    if start >= end:
        raise HTTPException(422, "from_ms must be earlier than to_ms")

    with connect() as db:
        agent_ids = [row[0] for row in db.execute(
            "SELECT DISTINCT agent_id FROM call_metrics "
            "WHERE started_at_epoch_ms >= ? AND started_at_epoch_ms < ? AND agent_id IS NOT NULL "
            "ORDER BY agent_id", (start, end))]
        scopes: list[tuple[str | None, dict[str, Any]]] = []
        for agent_id in [None, *agent_ids]:
            filters = aggregate.Filters(start_ms=start, end_ms=end, agent_id=agent_id)
            scopes.append((agent_id, aggregate.summary(db, filters, compare=False)))

        firing: list[dict[str, Any]] = []
        quiet: list[dict[str, Any]] = []
        for agent_id, summary in scopes:
            for rule in alerts.RULES:
                result = alerts.evaluate(rule, summary)
                result["agent_id"] = agent_id
                result["scope"] = "fleet" if agent_id is None else "agent"
                if result["state"] == "firing":
                    # The calls that caused it, so the alert is one click from
                    # its own evidence rather than from a filter form.
                    drilldown = aggregate.calls(
                        db, aggregate.Filters(start_ms=start, end_ms=end, agent_id=agent_id),
                        result["selector"], limit=3)
                    result["evidence"] = drilldown["items"]
                    result["evidence_total"] = drilldown["total"]
                    if not drilldown["total"]:
                        # A rate computed over turns can cross its threshold
                        # while no single call qualifies for the call-level
                        # drilldown behind it. Publishing that would be an alert
                        # whose "show me" link opens an empty list — the exact
                        # thing that makes a monitoring page stop being trusted.
                        # It is reported as unmeasurable instead of as a breach.
                        result["state"] = "unknown"
                        result["severity"] = "none"
                        result["reason"] = "spread across turns, no single call qualifies"
                        quiet.append(result)
                        continue
                    firing.append(result)
                else:
                    quiet.append(result)

    # Fleet-wide breaches lead, then agents by how far past the line they are:
    # a channel at 60% over threshold is the story, not the one at 2%.
    firing.sort(key=lambda item: (
        item["scope"] != "fleet",
        item["severity"] != "critical",
        -(item["excess"] or 0),
    ))
    # The quiet list is a reference, so it reads in a stable order - fleet, then
    # agents alphabetically, rules in declaration order - rather than in whatever
    # order the breaches happened to leave behind.
    rule_order = {rule.id: index for index, rule in enumerate(alerts.RULES)}
    quiet.sort(key=lambda item: (
        item["scope"] != "fleet",
        item["agent_id"] or "",
        rule_order.get(item["rule_id"], 99),
    ))
    return {
        "range": {"from_ms": start, "to_ms": end},
        "agents": agent_ids,
        "firing": firing,
        "quiet": quiet,
        "rules": [
            {"id": rule.id, "label": rule.label, "question": rule.question,
             "threshold": rule.threshold, "unit": rule.unit, "severity": rule.severity}
            for rule in alerts.RULES
        ],
        "generated_at": now(),
    }


@app.get("/v1/dashboard/calls")
def dashboard_calls(
    selector: str = "all",
    from_ms: int | None = None,
    to_ms: int | None = None,
    agent_id: str | None = None,
    environment: str | None = None,
    agent_version: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    sdk_language: str | None = None,
    tool_name: str | None = None,
    fingerprint: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """The calls behind one dashboard number.

    Every KPI, chart bucket, stage failure rate and tool row links here with the
    dashboard's own filters attached, so a developer never has to reconstruct
    "which calls was that?" by hand.
    """
    end = to_ms if to_ms is not None else wall_clock_ms()
    start = from_ms if from_ms is not None else end - DEFAULT_RANGE_MS
    filters = aggregate.Filters(
        start_ms=start, end_ms=end, agent_id=agent_id, environment=environment,
        agent_version=agent_version, provider=provider, model=model, sdk_language=sdk_language)
    with connect() as db:
        return aggregate.calls(db, filters, selector, tool_name=tool_name, fingerprint=fingerprint,
                               limit=max(1, min(limit, 500)), offset=max(0, offset))


@app.get("/v1/dashboard/audit")
def dashboard_audit(limit: int = 25) -> dict[str, Any]:
    """Recompute stored turn metrics from the raw operations and report drift.

    The aggregate tables are a cache. This is what proves the cache still says
    the same thing as the evidence: a definition change, a partial backfill or a
    re-uploaded call would otherwise leave the dashboard confidently reporting
    numbers no call can reproduce.
    """
    mismatches: list[dict[str, Any]] = []
    compared = 0
    with connect() as db:
        session_ids = [row["id"] for row in db.execute(
            "SELECT id FROM sessions ORDER BY created_at DESC LIMIT ?", (limit,))]
        for session_id in session_ids:
            stored = {
                row["turn_id"]: row
                for row in db.execute("SELECT * FROM turn_metrics WHERE session_id = ?", (session_id,))
            }
            try:
                row, turns, _ = session_metric_inputs(session_id, db)
            except HTTPException:
                continue
            started = metrics.epoch_ms(json.loads(row["manifest_json"]).get("started_at"))
            for turn in turns:
                compared += 1
                fresh = metrics.turn_metrics(turn, started)
                found = stored.get(fresh["turn_id"])
                if found is None:
                    mismatches.append({"session_id": session_id, "turn_id": fresh["turn_id"],
                                       "field": "*", "stored": None, "recomputed": "present"})
                    continue
                for column in aggregate.TURN_COLUMNS:
                    if column in ("session_id", "turn_id"):
                        continue
                    if found[column] != fresh.get(column):
                        mismatches.append({
                            "session_id": session_id, "turn_id": fresh["turn_id"], "field": column,
                            "stored": found[column], "recomputed": fresh.get(column),
                        })
    return {
        "sessions_checked": len(session_ids), "turns_compared": compared,
        "mismatch_count": len(mismatches), "mismatches": mismatches[:100],
        "consistent": not mismatches,
    }


@app.post("/v1/dashboard/rebuild", status_code=202)
def dashboard_rebuild() -> dict[str, Any]:
    """Force a full re-derivation. Used after a measurement definition changes."""
    with connect() as db:
        db.execute("UPDATE call_metrics SET metrics_version = -1")
    return {"rebuilt": backfill_metrics(limit=None)}


@app.get("/v1/pricing")
def get_pricing() -> dict[str, Any]:
    return pricing.load_pricing(ROOT)


@app.put("/v1/pricing")
def put_pricing(update: dict[str, Any]) -> dict[str, Any]:
    """Let a reviewer supply real contracted rates instead of list price."""
    ROOT.mkdir(parents=True, exist_ok=True)
    current = pricing.load_pricing(ROOT)
    for key, value in (update or {}).items():
        if isinstance(value, dict) and isinstance(current.get(key), dict):
            current[key].update(value)
        else:
            current[key] = value
    (ROOT / "pricing.json").write_text(json.dumps(current, indent=2))
    return current


def delta(end: Any, start: Any) -> int | None:
    if not isinstance(end, (int, float)) or not isinstance(start, (int, float)) or end < start:
        return None
    return round(end - start)


def metric_summary(values: list[Any]) -> dict[str, int | None]:
    measured = sorted(round(value) for value in values if isinstance(value, (int, float)) and value >= 0)
    if not measured:
        return {"count": 0, "p50": None, "p90": None, "max": None}
    def percentile_value(fraction: float) -> int:
        rank = max(1, round(len(measured) * fraction + 0.499999))
        return measured[min(len(measured) - 1, rank - 1)]
    return {"count": len(measured), "p50": percentile_value(0.5), "p90": percentile_value(0.9), "max": measured[-1]}


def _op_window(op: dict[str, Any]) -> tuple[int, int]:
    started = op.get("started_at_ms") or 0
    return started, (op.get("ended_at_ms") or started)


def _has_token_accounting(op: dict[str, Any]) -> bool:
    """Whether an LLM span came from the agent framework rather than the transport.

    Only the framework reports tokens and TTFT; the HTTP instrumentation reports
    a status code and a captured body. The two are not interchangeable, so this
    is what tells a logical call apart from the requests that served it.
    """
    response = op.get("response") or {}
    return any(
        response.get(field) is not None
        for field in ("total_tokens", "completion_tokens", "tokens_per_second", "ttft_ms")
    )


def logical_llm_calls(llm_ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One entry per LLM call, not per HTTP request that served it.

    A voice agent records the same model call twice: once by the framework
    (tokens, TTFT, and spanning any retries) and once by the HTTP
    instrumentation (status and request body, one span per attempt). Counting
    both double-counts every call — a turn could report more model time than the
    turn itself lasted. The framework span wins where it exists, and the
    attempts it covers are folded into it; an attempt no framework span covers
    is a real call the framework never got metrics for, so it still counts.
    """
    framework = [op for op in llm_ops if _has_token_accounting(op)]
    if not framework:
        return list(llm_ops)
    windows = [_op_window(op) for op in framework]
    covered = {
        id(op)
        for op in llm_ops
        if not _has_token_accounting(op)
        and any(start <= _op_window(op)[0] <= end for start, end in windows)
    }
    return [op for op in llm_ops if id(op) not in covered]


def first_agent_audio_ms(tts: dict[str, Any] | None, agent_audio_ms: list[float] | None) -> float | None:
    """Recover the first-audio mark from the agent track when the span lacks it.

    The TTS span is supposed to carry an `audio_chunk` milestone, but an SDK
    that stamped it only when the span already existed never wrote one: the
    frames are synthesized before the framework reports the metrics that open
    the span. Those calls are already recorded, so the milestone cannot be
    recovered from the span — but the agent's own audio receipts are the same
    evidence, and every package has them.

    The search is bounded to the span that produced the audio. Without that
    bound a turn whose reply never came — an LLM that errored before synthesis —
    would claim the *next* turn's first frame and report a wait the caller never
    experienced.
    """
    if not agent_audio_ms or not tts:
        return None
    start = tts.get("started_at_ms")
    end = tts.get("ended_at_ms")
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        return None
    return next((at for at in agent_audio_ms if start <= at <= end), None)


def group_turns(
    operations: list[dict[str, Any]], agent_audio_ms: list[float] | None = None
) -> list[dict[str, Any]]:
    """Groups turn-scoped operations into the unit a reviewer actually reasons about."""
    turns: dict[str, dict[str, Any]] = {}
    for op in operations:
        turn_id = op.get("turn_id")
        if turn_id is None:
            continue
        turn = turns.setdefault(str(turn_id), {"turn_id": str(turn_id), "operations": []})
        turn["operations"].append(op)
    ordered = []
    for turn in turns.values():
        ops = sorted(turn["operations"], key=lambda item: item.get("started_at_ms", 0))
        by_type = lambda kind: [op for op in ops if op.get("type") == kind]  # noqa: E731
        stt = by_type("stt")[0] if by_type("stt") else None
        tts = by_type("tts")[0] if by_type("tts") else None
        llm = logical_llm_calls(by_type("llm"))
        started = min((op.get("started_at_ms", 0) for op in ops), default=0)
        ended = max((op.get("ended_at_ms") or op.get("started_at_ms", 0) for op in ops), default=0)
        first_audio = (tts or {}).get("presentation_window", {}).get("from_ms")
        if first_audio is None:
            first_audio = (tts or {}).get("milestones", {}).get("audio_chunk", {}).get("occurred_at_ms")
        if first_audio is None:
            first_audio = first_agent_audio_ms(tts, agent_audio_ms)
        speech_end = (stt or {}).get("presentation_window", {}).get("to_ms")
        if speech_end is None:
            speech_end = stt.get("ended_at_ms") if stt else None
        ordered.append(
            {
                "turn_id": turn["turn_id"],
                "started_at_ms": started,
                "ended_at_ms": ended,
                "duration_ms": max(0, ended - started),
                "status": "error" if any(op.get("status") == "error" for op in ops) else ("cancelled" if any(op.get("status") == "cancelled" for op in ops) else "ok"),
                "user_speech_ms": (
                    (stt["presentation_window"]["to_ms"] - stt["presentation_window"]["from_ms"])
                    if stt and stt.get("presentation_window") else (stt.get("duration_ms") if stt else None)
                ),
                "llm_ms": sum(op.get("duration_ms") or 0 for op in llm) or None,
                "llm_calls": len(llm),
                # Keep the provider span as the legacy operational metric. The
                # audible value is separate, so old reports remain comparable
                # and reviewers can still see queued PCM drain after completion.
                "tts_ms": tts.get("duration_ms") if tts else None,
                "audible_tts_ms": (
                    (tts["presentation_window"]["to_ms"] - tts["presentation_window"]["from_ms"])
                    if tts and tts.get("presentation_window") else None
                ),
                # The number that matters: silence between the user stopping and
                # the first byte of the reply reaching the caller. First audio at
                # or before the speech mark is not a fast reply — it is one
                # timestamp recorded twice, or audio that belongs to the previous
                # reply still playing over the caller. A real reply has to clear
                # STT finalisation, the model and TTS, so only a strictly later
                # mark is a wait anyone actually experienced.
                # A strictly-later mark is necessary but not sufficient: the
                # floor below rejects spans too short for a real STT-final ->
                # model -> TTS round trip. Without it, two marks recorded a
                # millisecond apart are published as a 1 ms reply, which both
                # drags a fleet percentile down and inflates the denominator of
                # the audible-lag rate.
                "time_to_first_audio_ms": (
                    (first_audio - speech_end)
                    if (first_audio is not None and speech_end is not None
                        and first_audio - speech_end >= MIN_PLAUSIBLE_RESPONSE_MS)
                    else None
                ),
                "operations": ops,
            }
        )
    return sorted(ordered, key=lambda item: item["started_at_ms"])


PRERENDERED_DIR = "preview"


def prerendered_wav(session_id: str, track: str) -> Path | None:
    """The published WAV for this track, if the snapshot builder made one.

    The on-demand path decodes the raw PCM package and assembles a call-clock
    WAV in memory on every request - tens of megabytes per listener, per seek.
    That is the right trade for a single reviewer on a laptop and the wrong one
    for a public page, where a handful of concurrent visitors scrubbing a
    waveform would spend the whole CPU budget rendering audio that never
    changes. In the demo the render is done once, at build time.
    """
    if not DEMO_MODE:
        return None
    path = OBJECTS / session_id / PRERENDERED_DIR / f"{track}.wav"
    return path if path.is_file() else None


@app.get("/v1/sessions/{session_id}/audio/{track}")
def get_audio(
    session_id: str,
    request: Request,
    track: Literal["call", "caller", "agent", "mixed"],
    preview: Literal["wav"] | None = None,
    from_ms: int | None = None,
    to_ms: int | None = None,
) -> Response:
    row = require_session(session_id)
    directory = safe_session_dir(session_id)
    manifest = json.loads(row["manifest_json"])
    metadata = manifest.get("audio", {}).get(track, {})
    path = directory / track_file(manifest, track)
    virtual_stereo_channel = (
        track in {"caller", "agent"} and "call" in manifest.get("audio", {})
    )
    published = prerendered_wav(session_id, track)
    if published is None and track != "mixed" and not path.is_file() and not virtual_stereo_channel:
        raise HTTPException(404, "Audio track not uploaded")
    if preview is None:
        if track == "mixed":
            raise HTTPException(400, "The mixed track is available only as a WAV preview")
        if not path.is_file():
            if virtual_stereo_channel:
                raise HTTPException(400, "Stereo channels are available only as WAV previews")
        return FileResponse(path, media_type="application/octet-stream", filename=path.name)
    if published is not None and from_ms is None and to_ms is None:
        return published_wav_response(published, request, f"{track}.wav")
    wav = read_bytes_or_render(published, directory, manifest, track)
    name = f"{track}.wav"
    if from_ms is not None or to_ms is not None:
        # A reviewer sharing evidence wants the eight seconds that went wrong,
        # not a 38 MB call with an instruction to skip to 3:14. Cutting on the
        # server keeps the clip a real WAV rather than a byte range the browser
        # would have to reassemble a header for.
        wav = clip_wav(wav, from_ms, to_ms)
        name = f"{track}-{max(0, from_ms or 0)}-{to_ms if to_ms is not None else 'end'}.wav"
    total = len(wav)
    headers = {
        "Content-Disposition": f'inline; filename="{name}"',
        "Accept-Ranges": "bytes",
    }

    # Safari (and iOS media playback generally) refuses to play a media response that
    # does not honour Range requests, so the on-demand wrapper must serve 206 slices.
    start, end = parse_range(request.headers.get("range"), total)
    status = 200
    if (start, end) != (0, total - 1):
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    headers["Content-Length"] = str(end - start + 1)
    return Response(wav[start : end + 1], status_code=status, media_type="audio/wav", headers=headers)


def read_bytes_or_render(published: Path | None, directory: Path, manifest: dict[str, Any], track: str) -> bytes:
    """Prefer the published render; fall back to building one on demand."""
    if published is not None:
        return published.read_bytes()
    return timeline_wav(directory, manifest, track)


def published_wav_response(path: Path, request: Request, name: str) -> Response:
    """Stream a published WAV straight off disk, honouring Range.

    Streamed rather than read whole: a 37 MB call played by several visitors at
    once should cost the process a 64 KB buffer each, not 37 MB each. Safari
    will not play media at all unless ranges are answered, so the 206 path is
    not optional.
    """
    total = path.stat().st_size
    start, end = parse_range(request.headers.get("range"), total)
    headers = {
        "Content-Disposition": f'inline; filename="{name}"',
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    }
    status = 200
    if (start, end) != (0, total - 1):
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(read_wav_range(b"", path, start, end), status_code=status,
                             media_type="audio/wav", headers=headers)


def clip_wav(wav: bytes, from_ms: int | None, to_ms: int | None) -> bytes:
    """Cut a WAV to a millisecond window, rewriting its header to match."""
    channels = struct.unpack_from("<H", wav, 22)[0] or 1
    rate = struct.unpack_from("<I", wav, 24)[0] or 1
    block = 2 * channels
    body = wav[44:]
    frames = len(body) // block
    start = min(frames, max(0, round((from_ms or 0) * rate / 1000)))
    end = frames if to_ms is None else min(frames, max(start, round(to_ms * rate / 1000)))
    if end <= start:
        raise HTTPException(422, "The requested clip is empty")
    cut = body[start * block : end * block]
    header = bytearray(wav[:44])
    struct.pack_into("<I", header, 4, 36 + len(cut))
    struct.pack_into("<I", header, 40, len(cut))
    return bytes(header) + cut


# Peaks are drawn as bars a few pixels wide, so a couple of thousand buckets is
# already finer than any screen can show; the cap keeps a crafted query string
# from asking the server to summarise a call one sample at a time.
PEAK_SCALE = 1000
MAX_PEAK_BUCKETS = 4000


PEAKS_PUBLISHED_BUCKETS = MAX_PEAK_BUCKETS


def downsample_peaks(source: dict[str, Any], buckets: int) -> dict[str, Any]:
    """Derive a coarser envelope from a published fine one.

    The waveform asks for one bucket per few pixels, so the bucket count is a
    function of window width and zoom - a continuum, not a fixed set that could
    be pre-rendered. Publishing one high-resolution envelope per track and
    reducing it here answers every zoom level from a few kilobytes of JSON
    instead of re-reading tens of megabytes of PCM. Taking the maximum of the
    covered source buckets preserves transients, so a click or a clipped
    syllable does not vanish as the reviewer zooms out.
    """
    available = int(source.get("buckets") or 0)
    if buckets >= available:
        return source
    reduced = []
    for channel in source.get("channels", []):
        peaks = channel.get("peaks") or []
        output = []
        for bucket in range(buckets):
            start = bucket * available // buckets
            end = max(start + 1, (bucket + 1) * available // buckets)
            window = peaks[start:end]
            output.append(max(window) if window else 0)
        reduced.append({**channel, "peaks": output})
    return {**source, "buckets": buckets, "channels": reduced}


def published_peaks(session_id: str, track: str) -> dict[str, Any] | None:
    if not DEMO_MODE:
        return None
    path = OBJECTS / session_id / PRERENDERED_DIR / f"{track}.peaks.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


@app.get("/v1/sessions/{session_id}/audio/{track}/peaks")
def get_audio_peaks(
    session_id: str,
    track: Literal["call", "caller", "agent", "mixed"],
    buckets: int = 1200,
) -> dict[str, Any]:
    """The amplitude envelope of the preview WAV, one entry per pixel column.

    Drawing a waveform in the browser otherwise means downloading tens of
    megabytes of PCM a second time and decoding it into float32 — several
    hundred megabytes of heap for a long call. Summarising server side sends a
    few kilobytes instead, and the answer is cached on disk because the
    recording it describes never changes.
    """
    buckets = max(32, min(MAX_PEAK_BUCKETS, buckets))
    fine = published_peaks(session_id, track)
    if fine is not None:
        return downsample_peaks(fine, buckets)
    row = require_session(session_id)
    directory = safe_session_dir(session_id)
    manifest = json.loads(row["manifest_json"])
    cache = directory / "peaks" / f"{track}-{buckets}-{peaks_revision(directory, manifest, track)}.json"
    if cache.is_file():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cache.unlink(missing_ok=True)
    summary = wav_peaks(timeline_wav(directory, manifest, track), buckets, channel_labels(manifest, track))
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        # Written through a temporary name so a concurrent reader can never see
        # a half-flushed document and cache it as corrupt.
        temporary = cache.with_name(f"{cache.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(summary), encoding="utf-8")
        temporary.replace(cache)
    except OSError:
        pass
    return summary


def peaks_revision(directory: Path, manifest: dict[str, Any], track: str) -> str:
    """A short fingerprint of everything `timeline_wav` reads for this track.

    A session is browsable while it is still uploading, so peaks can be computed
    from audio whose `events.jsonl` has not landed yet — a contiguous render
    rather than the call-clock one. Keying the cache on the size and mtime of
    every input means the stale answer is simply never found again once the
    package completes or an object is re-uploaded, instead of a waveform that
    silently disagrees with the audio being played.
    """
    inputs = [directory / "events.jsonl"]
    audio = manifest.get("audio", {})
    for name in ({"call"} if "call" in audio else set(audio)) if track != "mixed" else set(audio):
        try:
            inputs.append(directory / track_file(manifest, name))
        except HTTPException:
            continue
    stamp = hashlib.blake2b(digest_size=6)
    for path in sorted(inputs):
        try:
            info = path.stat()
            stamp.update(f"{path.name}:{info.st_size}:{info.st_mtime_ns}".encode())
        except OSError:
            stamp.update(f"{path.name}:absent".encode())
    return stamp.hexdigest()


def channel_labels(manifest: dict[str, Any], track: str) -> list[str]:
    """Who each channel of the preview belongs to, in interleaved order."""
    if track != "call":
        return [track]
    metadata = manifest.get("audio", {}).get("call") or {}
    if metadata.get("channels") != 2:
        return ["call"]
    layout = metadata.get("channel_layout") or {"left": "agent", "right": "caller"}
    return [str(layout.get("left") or "left"), str(layout.get("right") or "right")]


def wav_peaks(wav: bytes, buckets: int, labels: list[str]) -> dict[str, Any]:
    channels = struct.unpack_from("<H", wav, 22)[0] or 1
    rate = struct.unpack_from("<I", wav, 24)[0] or 1
    body = wav[44:]
    samples = array("h")
    block = 2 * channels
    samples.frombytes(body[: len(body) - (len(body) % block)])
    if sys.byteorder != "little":
        samples.byteswap()
    frames = len(samples) // channels
    buckets = max(1, min(buckets, frames or 1))
    names = labels if len(labels) == channels else [labels[0] if labels else "call"] * channels

    tracks = []
    for index in range(channels):
        channel = samples[index::channels] if channels > 1 else samples
        peaks = []
        for bucket in range(buckets):
            start = bucket * frames // buckets
            end = max(start + 1, (bucket + 1) * frames // buckets)
            window = channel[start:end]
            if not window:
                peaks.append(0)
                continue
            loudest = max(max(window), -min(window))
            peaks.append(min(PEAK_SCALE, loudest * PEAK_SCALE // 32768))
        tracks.append({"name": names[index], "peaks": peaks})

    return {
        "buckets": buckets,
        "scale": PEAK_SCALE,
        "sample_rate_hz": rate,
        "duration_ms": round(frames * 1000 / rate),
        "channels": tracks,
    }


def timeline_wav(directory: Path, manifest: dict[str, Any], track: str) -> bytes:
    """Render PCM against the call clock, inserting silence for capture gaps."""
    audio = manifest.get("audio", {})
    if "call" in audio:
        return stereo_call_wav(directory, manifest, track)
    if track == "call":
        raise HTTPException(404, "Audio track not uploaded")
    required = ("caller", "agent") if track == "mixed" else (track,)
    metadata = {name: audio.get(name, {}) for name in required}
    for name, item in metadata.items():
        if item.get("encoding") != "pcm_s16le":
            raise HTTPException(415, "Only pcm_s16le tracks can be previewed")
        if not isinstance(item.get("sample_rate_hz"), int) or item["sample_rate_hz"] <= 0 or not isinstance(item.get("channels"), int) or item["channels"] <= 0:
            raise HTTPException(422, "Audio track is missing a valid sample rate or channel count")
        if not (directory / track_file(manifest, name)).is_file():
            raise HTTPException(404, f"Audio track not uploaded: {name}")
    # Preserve byte-for-byte legacy previews until a package includes the timing
    # events needed for alignment. That keeps old recordings playable unchanged.
    if track != "mixed" and not audio_events(directory, track):
        item = metadata[track]
        raw = (directory / track_file(manifest, track)).read_bytes()
        return wav_header(item["sample_rate_hz"], item["channels"], len(raw)) + raw
    rate = max(item["sample_rate_hz"] for item in metadata.values())
    duration_ms = max(0, int(manifest.get("duration_ms") or 0))
    tracks = {name: render_track(directory, manifest, name, item, rate, duration_ms) for name, item in metadata.items()}
    frames = max((len(samples) for samples in tracks.values()), default=0)
    if track == "mixed":
        output = mix_tracks(tracks, frames)
    else:
        output = tracks[track]
    payload = output.tobytes()
    if sys.byteorder != "little":
        output.byteswap()
        payload = output.tobytes()
    return wav_header(rate, 1, len(payload)) + payload


def stereo_call_wav(directory: Path, manifest: dict[str, Any], track: str) -> bytes:
    """Wrap the stored stereo call or expose one channel for STT review."""
    metadata = manifest.get("audio", {}).get("call") or {}
    if metadata.get("encoding") != "pcm_s16le":
        raise HTTPException(415, "Only pcm_s16le tracks can be previewed")
    rate = metadata.get("sample_rate_hz")
    if not isinstance(rate, int) or rate <= 0 or metadata.get("channels") != 2:
        raise HTTPException(422, "Stereo call audio requires a valid sample rate and two channels")
    path = directory / track_file(manifest, "call")
    if not path.is_file():
        raise HTTPException(404, "Audio track not uploaded")
    raw = path.read_bytes()
    if track == "call":
        return wav_header(rate, 2, len(raw)) + raw
    if track not in {"caller", "agent", "mixed"}:
        raise HTTPException(404, "Audio track not uploaded")

    samples = array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 4)])
    if sys.byteorder != "little":
        samples.byteswap()
    layout = metadata.get("channel_layout") or {"left": "agent", "right": "caller"}
    positions = {layout.get("left"): 0, layout.get("right"): 1}
    output = array("h")
    if track == "mixed":
        for index in range(0, len(samples), 2):
            active = [sample for sample in samples[index : index + 2] if sample != 0]
            output.append(round(sum(active) / len(active)) if active else 0)
    else:
        channel = positions.get(track)
        if channel is None:
            raise HTTPException(422, f"Stereo call audio does not identify the {track} channel")
        output.extend(samples[index + channel] for index in range(0, len(samples), 2))
    if sys.byteorder != "little":
        output.byteswap()
    payload = output.tobytes()
    return wav_header(rate, 1, len(payload)) + payload


def mix_tracks(tracks: dict[str, array], frames: int) -> array:
    """Mix call-clock tracks without changing the level of solo speech.

    A raw sum makes overlapping caller/agent speech 6 dB louder and can clip
    badly even though each source track is clean. Average only the tracks that
    have a non-zero sample at a frame: solo speech keeps its original level,
    while overlap is blended without one speaker overwhelming the other.
    """
    output = array("h")
    for index in range(frames):
        active = [samples[index] for samples in tracks.values() if index < len(samples) and samples[index] != 0]
        if not active:
            output.append(0)
            continue
        output.append(max(-32768, min(32767, round(sum(active) / len(active)))))
    return output


def render_track(directory: Path, manifest: dict[str, Any], track: str, metadata: dict[str, Any], output_rate: int, call_duration_ms: int) -> array:
    source_rate, channels = metadata["sample_rate_hz"], metadata["channels"]
    raw = (directory / track_file(manifest, track)).read_bytes()
    events = audio_events(directory, track)
    # Old packages have no usable chunk timings; retain their legacy contiguous playback.
    if not events:
        events = [(0, len(raw))]
    segments: list[tuple[int, bytes]] = []
    offset = 0
    for occurred_at, size in events:
        data = raw[offset : offset + size]
        offset += len(data)
        if data:
            segments.append((occurred_at, data))
    if offset < len(raw):
        segments.append((0 if not segments else segments[-1][0], raw[offset:]))
    final_frames = max(round(call_duration_ms * output_rate / 1000), max((round((at + len(data) * 1000 / (source_rate * channels * 2)) * output_rate / 1000) for at, data in segments), default=0))
    output = array("h", [0]) * final_frames
    for at, data in segments:
        source = array("h")
        source.frombytes(data[: len(data) - (len(data) % 2)])
        if sys.byteorder != "little":
            source.byteswap()
        mono = [sum(source[index : index + channels]) // channels for index in range(0, len(source) - channels + 1, channels)]
        start = round(at * output_rate / 1000)
        for index, sample in enumerate(mono):
            target_start = start + round(index * output_rate / source_rate)
            target_end = start + round((index + 1) * output_rate / source_rate)
            for target in range(max(0, target_start), min(final_frames, max(target_start + 1, target_end))):
                output[target] = sample
    return output


def audio_events(directory: Path, track: str) -> list[tuple[int, int]]:
    path = directory / "events.jsonl"
    if not path.is_file():
        return []
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("kind") == "audio_chunk" and event.get("track") == track and isinstance(event.get("occurred_at_ms"), (int, float)) and isinstance(event.get("byte_length"), int):
            events.append((max(0, round(event["occurred_at_ms"])), max(0, event["byte_length"])))
    return events


def wav_header(sample_rate: int, channels: int, data_size: int) -> bytes:
    """Canonical 44-byte PCM WAV header, so the audio body can stream straight from disk."""
    block_align = channels * 2
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        16,
        b"data",
        data_size,
    )


def parse_range(header: str | None, total: int) -> tuple[int, int]:
    if not header or not header.startswith("bytes="):
        return 0, total - 1
    first, _, last = header[len("bytes=") :].split(",")[0].strip().partition("-")
    try:
        if not first:
            # Suffix range: the final N bytes.
            start, end = max(0, total - int(last)), total - 1
        else:
            start = int(first)
            end = min(int(last), total - 1) if last else total - 1
    except ValueError:
        return 0, total - 1
    if start >= total or start > end:
        raise HTTPException(416, "Requested range is not satisfiable", headers={"Content-Range": f"bytes */{total}"})
    return start, end


def read_wav_range(header: bytes, path: Path, start: int, end: int, chunk: int = 64 * 1024) -> Iterator[bytes]:
    remaining = end - start + 1
    if start < len(header):
        piece = header[start : start + remaining]
        remaining -= len(piece)
        yield piece
        offset = 0
    else:
        offset = start - len(header)
    if remaining <= 0:
        return
    with path.open("rb") as source:
        source.seek(offset)
        while remaining > 0:
            data = source.read(min(chunk, remaining))
            if not data:
                return
            remaining -= len(data)
            yield data


def require_session(session_id: str) -> sqlite3.Row:
    with connect() as db:
        row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    return row


def safe_session_dir(session_id: str) -> Path:
    # A bare ".." keeps its own basename, so relative components need an explicit check.
    if not session_id or session_id in {".", ".."} or Path(session_id).name != session_id:
        raise HTTPException(400, "Invalid session id")
    return OBJECTS / session_id


def track_file(manifest: dict[str, Any], track: str) -> str:
    """The file name of an audio track, as a name and never as a path.

    A manifest is uploaded by the client, so `audio.<track>.file` is untrusted.
    Joining it onto the session directory unchecked lets an absolute path
    replace the base entirely — `Path("/objects/x") / "/etc/passwd"` is
    `/etc/passwd` — which would turn the audio preview into an arbitrary file
    read. The same rule `safe_session_dir` applies to the id applies here.
    """
    metadata = manifest.get("audio", {}).get(track) or {}
    name = metadata.get("file") or f"{track}.audio"
    if not isinstance(name, str) or name in {"", ".", ".."} or Path(name).name != name:
        raise HTTPException(400, f"Invalid audio file name for the {track} track")
    return name


def import_operations(session_id: str) -> list[dict[str, Any]]:
    events = safe_session_dir(session_id) / "events.jsonl"
    if not events.exists():
        return []
    imported: list[dict[str, Any]] = []
    for line_number, line in enumerate(events.read_text(encoding="utf-8").splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise HTTPException(400, f"Invalid events.jsonl on line {line_number}") from error
        if event.get("session_id") == session_id and event.get("type") in {"stt", "llm", "tts", "tool"} and event.get("event_id"):
            imported.append(event)
    return imported


def recordings(session_id: str, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for track, metadata in manifest.get("audio", {}).items():
        path = safe_session_dir(session_id) / track_file(manifest, track)
        uploaded, size = path.is_file(), path.stat().st_size if path.is_file() else 0
        if not uploaded:
            # The demo snapshot ships the published render instead of the raw
            # PCM package - the same audio, minus a second copy of it. The
            # recording is still present and still playable, so reporting it as
            # missing would hide the player from the one page the visitor came
            # to see.
            published = prerendered_wav(session_id, track)
            if published is not None:
                uploaded, size = True, published.stat().st_size
        result.append({"track": track, "uploaded": uploaded, "size_bytes": size, **metadata})
    return result


def has_failed(op: dict[str, Any]) -> bool:
    """Whether an operation should be counted as a failure.

    A cancelled span is not a fault, so an abort is excluded here exactly as the
    dashboard excludes it client side.
    """
    if op.get("status") != "error":
        return False
    error = op.get("error")
    name = error.get("name") if isinstance(error, dict) else None
    return name not in ABORT_NAMES


def session_summary(row: sqlite3.Row) -> dict[str, Any]:
    manifest = json.loads(row["manifest_json"])
    return {"id": row["id"], "agent_id": manifest.get("agent_id"), "duration_ms": manifest.get("duration_ms", 0), "outcome": manifest.get("outcome"), "status": row["status"], "started_at": manifest.get("started_at"), "created_at": row["created_at"]}
