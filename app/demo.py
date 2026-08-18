"""Public demo mode.

The demo publishes a fixed, curated snapshot of recorded calls to anonymous
visitors. It is the same application a customer runs, with three properties
that a public deployment needs and a private one does not:

1. It cannot be written to. The database is opened immutable and every route
   that mutates - or could later be made to mutate - is refused by an explicit
   allowlist rather than by blocking verbs. A future read-shaped admin endpoint
   must be added to the allowlist deliberately; it cannot become public by
   being written.
2. It has a fixed clock. A snapshot ages, and "last 7 days" computed from the
   visitor's wall clock would show an empty dashboard a week after publication.
   The demo pins "now" to the newest call in the snapshot, so every range
   control, comparison and relative label keeps meaning what it meant on the
   day the snapshot was built.
3. It says what it is. A visitor is told, on the page, that these are sample
   calls from a fixed month - not their own traffic and not live data.

Everything here is inert unless `VAANI_DEMO_MODE=1`, so the normal product is
unaffected by its presence.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

ENV_FLAG = "VAANI_DEMO_MODE"
CONFIG_NAME = "demo.json"

# Exact paths a visitor may reach. Anything not listed is refused.
ALLOWED_PATHS = frozenset({
    "/",
    "/dashboard",
    "/alerts",
    "/stt-evaluation",
    "/health",
    "/ready",
    "/v1/demo/config",
    "/v1/sessions",
    "/v1/alerts",
    "/v1/dashboard/summary",
    "/v1/dashboard/calls",
    "/v1/pricing",
})

# Path shapes a visitor may reach. Session ids are opaque, so these have to be
# patterns; each is anchored so a crafted path cannot widen the surface.
ALLOWED_PATTERNS = (
    re.compile(r"^/assets/[A-Za-z0-9._/-]+$"),
    re.compile(r"^/v1/sessions/[A-Za-z0-9._-]+$"),
    re.compile(r"^/v1/sessions/[A-Za-z0-9._-]+/stt-evaluation$"),
    re.compile(r"^/v1/sessions/[A-Za-z0-9._-]+/challenger-evaluation$"),
    re.compile(r"^/v1/sessions/[A-Za-z0-9._-]+/audio/(call|caller|agent|mixed)$"),
    re.compile(r"^/v1/sessions/[A-Za-z0-9._-]+/audio/(call|caller|agent|mixed)/peaks$"),
)

ALLOWED_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Long, because a published snapshot never changes: a new dataset is a new
# deployment, not an edit of this one.
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
MEDIA_CACHE = "public, max-age=604800"
API_CACHE = "public, max-age=300"
PAGE_CACHE = "public, max-age=300"

# Inline styles and handlers exist in the console today, so `unsafe-inline` is
# required for the demo to render at all. Everything else is locked to self:
# no third-party script, no remote frame, no plugin.
# Analytics hosts are added only when a measurement id is configured. An
# unconfigured deployment keeps the tight policy and can load no third-party
# script at all, which is the posture the demo should have by default.
_GA_SCRIPT = "https://www.googletagmanager.com"
_GA_CONNECT = (
    "https://www.google-analytics.com https://analytics.google.com "
    "https://region1.google-analytics.com https://stats.g.doubleclick.net"
)


def csp(analytics: bool = False) -> str:
    """The demo's content policy, widened only for configured analytics."""
    script = "'self' 'unsafe-inline'" + (f" {_GA_SCRIPT}" if analytics else "")
    connect = "'self'" + (f" {_GA_CONNECT} {_GA_SCRIPT}" if analytics else "")
    img = "'self' data:" + (f" {_GA_CONNECT} {_GA_SCRIPT}" if analytics else "")
    return (
        "default-src 'self'; "
        f"script-src {script}; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        f"img-src {img}; "
        "media-src 'self' blob:; "
        f"connect-src {connect}; "
        "frame-ancestors 'self' https://www.vaanieval.com https://vaanieval.com; "
        "base-uri 'self'; "
        "form-action 'none'; "
        "object-src 'none'"
    )


CSP = csp()


def enabled() -> bool:
    """Whether this process is serving the public demo."""
    return os.environ.get(ENV_FLAG) == "1"


def config_path(root: Path) -> Path:
    return root / CONFIG_NAME


def load_config(root: Path) -> dict[str, Any]:
    """The snapshot's own description of itself.

    Written by the snapshot builder and read at startup. A demo deployment
    without it is a misconfiguration - the frozen clock has no value to use -
    so this raises rather than quietly falling back to the wall clock and
    showing an empty dashboard.
    """
    path = config_path(root)
    if not path.is_file():
        raise RuntimeError(
            f"{ENV_FLAG}=1 but {path} is missing. Build a snapshot with "
            "scripts/build_demo_snapshot.py and point VAANI_DATA_DIR at it."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data.get("demo_now_ms"), int):
        raise RuntimeError(f"{path} has no integer demo_now_ms")
    return data


def is_allowed(method: str, path: str) -> bool:
    """Whether a public visitor may make this request."""
    if method.upper() not in ALLOWED_METHODS:
        return False
    # A trailing slash is the same resource; normalising here stops `/health/`
    # from being read as an unknown path and refused.
    normalised = path.rstrip("/") or "/"
    # A dot segment is never legitimate here, and the character classes below
    # would otherwise accept one inside an asset or session path. The server
    # and the static file handler both resolve traversal safely today, so this
    # is defence in depth - but the allowlist is meant to be the one place a
    # reader can check what is public, and it should not depend on that.
    if any(segment in {".", ".."} for segment in normalised.split("/")):
        return False
    if normalised in ALLOWED_PATHS:
        return True
    return any(pattern.match(normalised) for pattern in ALLOWED_PATTERNS)


def cache_control(path: str) -> str | None:
    """How long a response for this path may be reused."""
    if path.startswith("/assets/"):
        return IMMUTABLE_CACHE
    if "/audio/" in path:
        return MEDIA_CACHE
    if path.startswith("/v1/"):
        return API_CACHE
    if path in {"/", "/dashboard", "/alerts", "/stt-evaluation"}:
        return PAGE_CACHE
    return None


def is_media(path: str) -> bool:
    """Whether this path serves audio bytes rather than JSON or markup."""
    return "/audio/" in path and not path.endswith("/peaks")


class MediaLimiter:
    """A per-client budget on audio requests.

    Every other response in the demo is a few kilobytes of cached JSON. A call
    recording is tens of megabytes read off the App Service disk, so media is
    the only route where an anonymous visitor can cost real egress and I/O. The
    limit is deliberately generous - a visitor scrubbing through several calls
    stays well inside it - and it is a token bucket rather than a fixed window
    so that normal seeking, which arrives in bursts of range requests, is not
    punished for being bursty.

    This is in-process and therefore per-worker, which is the honest tradeoff:
    it is a cost ceiling and an accident guard, not a defence against a
    distributed attacker. A real one needs the limit at the CDN edge. It is
    also memory-bounded, because an unbounded dict keyed by client address is
    itself a way to exhaust the host.
    """

    __slots__ = ("_burst", "_clients", "_max_clients", "_rate")

    def __init__(self, burst: int = 60, per_second: float = 0.5, max_clients: int = 4096) -> None:
        self._burst = float(burst)
        self._rate = per_second
        self._max_clients = max_clients
        self._clients: dict[str, tuple[float, float]] = {}

    def allow(self, client: str, now: float) -> bool:
        tokens, seen = self._clients.get(client, (self._burst, now))
        tokens = min(self._burst, tokens + (now - seen) * self._rate)
        if tokens < 1.0:
            self._clients[client] = (tokens, now)
            return False
        if client not in self._clients and len(self._clients) >= self._max_clients:
            # Drop the least recently seen caller rather than grow without
            # bound. Evicting a stranger only refunds them their full budget.
            oldest = min(self._clients, key=lambda key: self._clients[key][1])
            del self._clients[oldest]
        self._clients[client] = (tokens - 1.0, now)
        return True


def client_key(request: Any) -> str:
    """Best-effort identity for rate limiting.

    Behind Vercel and App Service the socket address is a proxy, so the
    forwarded chain is used when present. It is spoofable, which is why this
    limiter is described above as a cost ceiling and not a security control.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = getattr(request, "client", None)
    return getattr(client, "host", "") or "unknown"


def security_headers(path: str, analytics: bool = False) -> dict[str, str]:
    """Headers applied to every demo response."""
    headers = {
        "Content-Security-Policy": csp(analytics),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
        # Transcripts and raw call detail are sample data, but they should not
        # become search results that outrank the product pages.
        "X-Robots-Tag": "noindex, nofollow",
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    }
    cache = cache_control(path)
    if cache:
        headers["Cache-Control"] = cache
    return headers
