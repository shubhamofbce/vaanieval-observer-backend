"""API keys: minting, presentation, revocation and usage recording.

The key a developer pastes into an SDK is the single credential this product
asks for, so the rules around it are deliberately narrow:

* **The secret is returned exactly once, at creation.** Nothing else in the
  process can read it back, because nothing stores it — only a SHA-256 digest
  is persisted. A dashboard that can re-display a key is a dashboard whose
  database is the key, and every backup of it is a credential leak.
* **A key is identified in the UI by `name` + `prefix` + `created_at`.** The
  prefix is the first `PREFIX_LENGTH` characters of the secret, which is what a
  developer can see in their own `.env` without pasting the whole thing back
  into a web page. It is not a secret and is safe to log.
* **Revocation is a tombstone, not a delete.** "Which key ingested this call,
  and when did we stop trusting it" is the first question asked after a leak,
  and a deleted row cannot answer it.
* **Usage is observed, not asserted.** `last_used_at` is written only when a
  request actually presents that key. It is what lets the onboarding page say
  "your agent authenticated at 14:02" instead of the far weaker "a key exists".

Verification hashes the presented token and looks the digest up, rather than
comparing candidates one at a time. The token carries 256 bits of entropy from
`secrets.token_urlsafe`, so a fast unsalted digest is the right primitive here:
there is no low-entropy secret for an offline attacker to grind, and a slow KDF
would put a deliberate delay on every ingest request instead.
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
from datetime import datetime
from typing import Any

# Every key is prefixed so it is recognisable in a diff, a log line or a leaked
# `.env` — the same reason Stripe and GitHub do it. Secret scanners key off a
# fixed, unusual prefix; `sk-` alone is not distinctive enough to be one.
TOKEN_PREFIX = "vaani_sk_"
# Characters of the full token retained in clear for display. Long enough to be
# unambiguous across the handful of keys one instance holds, short enough that
# the displayed fragment is useless on its own.
PREFIX_LENGTH = len(TOKEN_PREFIX) + 6
# Bytes of entropy behind each token. 32 bytes is 256 bits: not brute-forceable,
# and `token_urlsafe` renders it without characters that break shell quoting or
# `.env` parsing.
TOKEN_ENTROPY_BYTES = 32
MAX_NAME_LENGTH = 80
# A ceiling on live keys. Not a security control — it stops a retrying script
# from filling the table, and it keeps the onboarding key list a list rather
# than a scroll. Revoked keys do not count against it.
MAX_ACTIVE_KEYS = 25
# How often a key's `last_used_at` is actually rewritten. Ingest is the one path
# in this service that must stay cheap, and SQLite serialises writers; refreshing
# a timestamp on every request would put two extra write-lock acquisitions on
# every uploaded call to record something read at minute granularity.
USE_STAMP_INTERVAL_S = 60.0


class KeyLimitExceeded(Exception):
    """Raised when an instance already holds `MAX_ACTIVE_KEYS` live keys."""


def ensure_schema(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prefix TEXT NOT NULL,
          token_sha256 TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS api_keys_active ON api_keys(revoked_at, created_at);
        """
    )


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint(db: sqlite3.Connection, name: str, created_at: str) -> tuple[dict[str, Any], str]:
    """Create one key. Returns `(record, token)`; the token is never stored.

    The caller is responsible for handing the token to the user and then
    forgetting it. `record` is safe to persist, log and re-render.
    """
    label = (name or "").strip()[:MAX_NAME_LENGTH] or "Default key"
    active = db.execute("SELECT COUNT(*) AS live FROM api_keys WHERE revoked_at IS NULL").fetchone()["live"]
    if active >= MAX_ACTIVE_KEYS:
        raise KeyLimitExceeded(
            f"This instance already has {MAX_ACTIVE_KEYS} active keys. Revoke one before creating another."
        )
    token = f"{TOKEN_PREFIX}{secrets.token_urlsafe(TOKEN_ENTROPY_BYTES)}"
    key_id = secrets.token_hex(8)
    db.execute(
        "INSERT INTO api_keys (id, name, prefix, token_sha256, created_at, last_used_at, revoked_at)"
        " VALUES (?, ?, ?, ?, ?, NULL, NULL)",
        (key_id, label, token[:PREFIX_LENGTH], digest(token), created_at),
    )
    record = {
        "id": key_id,
        "name": label,
        "prefix": token[:PREFIX_LENGTH],
        "created_at": created_at,
        "last_used_at": None,
        "revoked_at": None,
    }
    return record, token


def as_record(row: sqlite3.Row) -> dict[str, Any]:
    """The public shape of a key. `token_sha256` is never included: it is not a
    secret an attacker can reverse, but it is a value that only ever needs to
    exist inside this module, and shipping it to a browser invites someone to
    build a client-side comparison against it."""
    return {
        "id": row["id"],
        "name": row["name"],
        "prefix": row["prefix"],
        "created_at": row["created_at"],
        "last_used_at": row["last_used_at"],
        "revoked_at": row["revoked_at"],
    }


def listing(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Active keys first, then revoked ones, newest first within each group.

    Revoked keys stay visible so a developer whose agent suddenly stopped
    ingesting can see that the key they are using was revoked, rather than
    finding an empty list and concluding the feature is broken.
    """
    rows = db.execute(
        "SELECT * FROM api_keys ORDER BY (revoked_at IS NOT NULL), created_at DESC"
    ).fetchall()
    return [as_record(row) for row in rows]


def revoke(db: sqlite3.Connection, key_id: str, revoked_at: str) -> dict[str, Any] | None:
    """Retire a key. Returns the updated record, or `None` if no such key.

    Revoking an already-revoked key keeps the original timestamp: the moment
    trust was withdrawn is the fact worth preserving, and a second click on a
    stale page must not rewrite it.
    """
    row = db.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    if row is None:
        return None
    if row["revoked_at"] is None:
        db.execute("UPDATE api_keys SET revoked_at = ? WHERE id = ?", (revoked_at, key_id))
        row = db.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    return as_record(row)


def verify(db: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    """The active key matching this token, or `None`.

    A revoked key returns `None` — the row is kept for audit, not for access.
    """
    if not token:
        return None
    return db.execute(
        "SELECT * FROM api_keys WHERE token_sha256 = ? AND revoked_at IS NULL", (digest(token),)
    ).fetchone()


def record_use(db: sqlite3.Connection, token: str | None, used_at: str) -> str | None:
    """Stamp `last_used_at` if this token is a live key. Returns the key id.

    An unknown token is not an error here. This instance does not require a key
    by default (see `main.require_api_key`), so ingest from an agent configured
    with `local-dev` must keep working — it simply never earns the "your key
    authenticated" evidence the onboarding page reports.

    The write is coalesced to at most once per `USE_STAMP_INTERVAL_S`, because
    SQLite has one writer and ingest is the path that must never queue behind
    bookkeeping: a fleet uploading calls would otherwise take the write lock
    twice per call to overwrite a timestamp with a nearly identical one. The
    question this column answers — "is this key live traffic or a forgotten
    string" — is not made better by second-level precision.
    """
    row = verify(db, token)
    if row is None:
        return None
    if _stale(row["last_used_at"], used_at):
        db.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (used_at, row["id"]))
    return row["id"]


def _stale(previous: str | None, now: str) -> bool:
    """Whether `last_used_at` is old enough to be worth rewriting.

    An unparseable or absent stamp is always refreshed: the first use of a key
    is the one the onboarding page is waiting on, and a row written by some
    future format must not pin the timestamp forever.
    """
    if not previous:
        return True
    try:
        elapsed = (
            datetime.fromisoformat(now) - datetime.fromisoformat(previous)
        ).total_seconds()
    except (ValueError, TypeError):
        # TypeError is the naive-vs-aware subtraction: every stamp this module
        # writes is tz-aware, but a hand-edited or imported row need only fail
        # open on a cosmetic timestamp — not turn an upload into a 500 under
        # enforcement, where `authenticate` re-raises what this leaks.
        return True
    # A clock that moved backwards (NTP correction, a restored backup) would
    # otherwise leave the stamp frozen in the future until it caught up.
    return not 0 <= elapsed < USE_STAMP_INTERVAL_S


def bearer(authorization: str | None) -> str | None:
    """Extract a bearer token from an `Authorization` header.

    Both SDKs send `Authorization: Bearer <key>`. A bare token with no scheme is
    also accepted, because that is the mistake a developer makes once with curl
    and it costs nothing to understand; anything with a *different* scheme
    (Basic, Digest) is rejected rather than treated as an opaque secret.
    """
    if not authorization:
        return None
    value = authorization.strip()
    if not value:
        return None
    scheme, _, rest = value.partition(" ")
    if not rest:
        return value if value.startswith(TOKEN_PREFIX) else None
    if scheme.lower() != "bearer":
        return None
    return rest.strip() or None
