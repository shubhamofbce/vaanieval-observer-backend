"""Onboarding status: what this instance can actually prove about a setup.

The page this feeds tells a developer which of four steps they have finished.
Every claim it makes is derived from a row that ingest wrote — never from a
checkbox, a heuristic, or the absence of an error:

| Step | The evidence, and nothing weaker |
| --- | --- |
| `api-key` | A row in `api_keys` with no `revoked_at`. Upgraded to "authenticated" only once some request actually presented that key. |
| `install` | A manifest arrived carrying `sdk.name` / `sdk.version`. A library that never ran cannot stamp a version into a manifest. |
| `instrument` | A `sessions` row exists. That proves the observer was constructed, a session was started and the upload protocol completed its handshake. |
| `capture` | A session reached `ready` with at least one operation. This is the only step that proves the *endpoints* config is right. |

Splitting the last two matters more than it looks. The single most common way a
correct-looking integration fails is that the call uploads fine and captures
nothing, because no configured endpoint rule matched the URLs the agent calls.
Collapsed into one step that reads "first call received ✓", the developer
declares victory over an empty dashboard. Kept apart, the page can say the call
arrived, no operation was recorded, and here is the config line to fix.

Nothing here reports "0" for something it did not measure: a step that this
service cannot observe returns `waiting` with the reason, and the UI renders
the reason.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

# Runtimes the onboarding page can render instructions for. The key is the
# `sdk.language` value each SDK stamps into its manifest
# (`vaani_observer.session.SDK`, `nodejs-sdk/src/session.js`), so a language the
# page cannot teach is still reported honestly rather than dropped.
RUNTIMES = {
    "python": "Python",
    "nodejs": "Node.js",
}
# How many recent calls the "recent activity" strip shows. Small on purpose:
# this is a setup page, and the fleet view already exists for volume.
RECENT_LIMIT = 5


def _manifest(row: sqlite3.Row) -> dict[str, Any]:
    try:
        value = json.loads(row["manifest_json"])
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _sdk(manifest: dict[str, Any]) -> dict[str, Any]:
    """The SDK block, always in the same shape.

    A manifest written by an older build, a hand-rolled `curl` upload or a row
    corrupted in place must produce three explicit `None`s rather than an empty
    object, so a consumer reading `sdk.version` gets "not reported" instead of a
    key error on the one page a broken instance is read from.
    """
    sdk = manifest.get("sdk")
    if not isinstance(sdk, dict):
        sdk = {}
    return {
        "name": sdk.get("name") if isinstance(sdk.get("name"), str) else None,
        "version": sdk.get("version") if isinstance(sdk.get("version"), str) else None,
        "language": sdk.get("language") if isinstance(sdk.get("language"), str) else None,
    }


def _call(row: sqlite3.Row, operation_count: int | None = None) -> dict[str, Any]:
    manifest = _manifest(row)
    sdk = _sdk(manifest)
    agent_id = manifest.get("agent_id")
    return {
        "session_id": row["id"],
        "agent_id": agent_id if isinstance(agent_id, str) else None,
        "status": row["status"],
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
        "sdk": sdk,
        "runtime": RUNTIMES.get(sdk.get("language") or "", sdk.get("language")),
        "operation_count": operation_count,
    }


def key_state(db: sqlite3.Connection) -> dict[str, Any]:
    """Counts and the strongest usage evidence available.

    `last_used_at` is the point of this block. "A key exists" only proves
    someone clicked a button in this browser; "a key was presented at 14:02"
    proves the credential reached the agent process and back.
    """
    row = db.execute(
        "SELECT COUNT(*) AS total, SUM(revoked_at IS NULL) AS active FROM api_keys"
    ).fetchone()
    used = db.execute(
        "SELECT id, name, prefix, last_used_at, revoked_at FROM api_keys"
        " WHERE last_used_at IS NOT NULL ORDER BY last_used_at DESC LIMIT 1"
    ).fetchone()
    return {
        "total": row["total"] or 0,
        "active": row["active"] or 0,
        "last_used_at": used["last_used_at"] if used else None,
        "last_used_key": (
            {
                "id": used["id"],
                "name": used["name"],
                "prefix": used["prefix"],
                "revoked": used["revoked_at"] is not None,
            }
            if used
            else None
        ),
    }


def ingest_state(db: sqlite3.Connection) -> dict[str, Any]:
    """Everything the onboarding page knows about calls that actually arrived.

    Every query here is bounded or index-served. The obvious implementation —
    read every session row and fold over it — is correct on the instance a
    developer onboards against and quietly turns the setup page into the most
    expensive endpoint in the product on the instance they grow into. This page
    is also the one most likely to be left open and polling.
    """
    total = db.execute("SELECT COUNT(*) AS total FROM sessions").fetchone()["total"]
    if not total:
        return {
            "sessions": 0,
            "first": None,
            "latest": None,
            "recent": [],
            "captured": None,
            "installed": None,
            "uploaded_without_operations": 0,
            "in_flight": 0,
        }

    first_row = db.execute("SELECT * FROM sessions ORDER BY created_at ASC LIMIT 1").fetchone()
    recent_rows = db.execute(
        "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?", (RECENT_LIMIT,)
    ).fetchall()
    # The first call with any operation on it. `operations` is indexed by
    # session_id, so this stops at the first match rather than counting the
    # table.
    captured_row = db.execute(
        "SELECT * FROM sessions AS s WHERE EXISTS"
        " (SELECT 1 FROM operations AS o WHERE o.session_id = s.id)"
        " ORDER BY s.created_at ASC LIMIT 1"
    ).fetchone()
    # The first call that actually reported an SDK version — which is not
    # necessarily the first call at all. A `curl` smoke test sends no `sdk`
    # block, and it is a very normal first thing to do. Reading the install step
    # off `first` alone froze it at "nothing has run this SDK" for the life of
    # the instance while the step below it read "1 operation captured" — the
    # exact self-contradiction this module exists to prevent. The step's
    # contract is "*a* manifest arrived carrying a version", so ask that.
    installed_row = db.execute(
        "SELECT * FROM sessions"
        " WHERE json_valid(manifest_json)"
        " AND json_extract(manifest_json, '$.sdk.version') IS NOT NULL"
        " ORDER BY created_at ASC LIMIT 1"
    ).fetchone()

    wanted = {row["id"] for row in recent_rows} | {first_row["id"]}
    if captured_row is not None:
        wanted.add(captured_row["id"])
    if installed_row is not None:
        wanted.add(installed_row["id"])
    placeholders = ",".join("?" for _ in wanted)
    counts = {
        row["session_id"]: row["operation_count"]
        for row in db.execute(
            f"SELECT session_id, COUNT(*) AS operation_count FROM operations"
            f" WHERE session_id IN ({placeholders}) GROUP BY session_id",
            tuple(wanted),
        )
    }

    # Only meaningful while nothing has been captured — and in exactly that case
    # it is a plain count, because "no session has an operation" makes every
    # finished upload one that recorded nothing. Once one call has captured
    # spans the step is verified and this number is not rendered, so it is not
    # computed.
    empty = 0
    in_flight = 0
    if captured_row is None:
        empty = db.execute(
            "SELECT COUNT(*) AS empty FROM sessions WHERE status != 'uploading'"
        ).fetchone()["empty"]
        # A session row appears at the POST /v1/sessions handshake, before any
        # object has been uploaded. Without counting these separately the page
        # would say "1 call received" and "nothing has been uploaded" at the same
        # time, and a developer whose upload died mid-way would be told two
        # contradictory things and trust neither.
        in_flight = db.execute(
            "SELECT COUNT(*) AS live FROM sessions WHERE status = 'uploading'"
        ).fetchone()["live"]

    return {
        "sessions": total,
        "first": _call(first_row, counts.get(first_row["id"], 0)),
        "latest": _call(recent_rows[0], counts.get(recent_rows[0]["id"], 0)),
        "recent": [_call(row, counts.get(row["id"], 0)) for row in recent_rows],
        "captured": _call(captured_row, counts.get(captured_row["id"], 0)) if captured_row else None,
        "installed": _call(installed_row, counts.get(installed_row["id"], 0)) if installed_row else None,
        "uploaded_without_operations": empty,
        "in_flight": in_flight,
    }


def _step(
    step_id: str,
    title: str,
    verified: bool,
    *,
    evidence: str | None = None,
    waiting: str | None = None,
    self_reportable: bool = False,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One step. `evidence` is rendered *only* when `verified`.

    The two strings are separate fields rather than one "message" because they
    are different kinds of claim: `evidence` states a fact this service
    observed, `waiting` states what it is still waiting to observe. A single
    field invites a future edit that shows a waiting message where a fact
    belongs, which is precisely how a status page starts lying.
    """
    return {
        "id": step_id,
        "title": title,
        "state": "verified" if verified else "waiting",
        "evidence": evidence if verified else None,
        "waiting": None if verified else waiting,
        "self_reportable": self_reportable and not verified,
        "detail": detail or {},
    }


def status(db: sqlite3.Connection, *, require_api_key: bool) -> dict[str, Any]:
    keys = key_state(db)
    ingest = ingest_state(db)

    if keys["last_used_at"]:
        key_evidence = (
            f"Key {keys['last_used_key']['prefix']}… authenticated an ingest request"
        )
    elif keys["active"]:
        key_evidence = (
            f"{keys['active']} active key{'s' if keys['active'] != 1 else ''}"
            " — not yet seen on an ingest request"
        )
    else:
        key_evidence = None

    first = ingest["first"]
    # Whichever call reported a version — see `ingest_state`. Falling back to
    # `first` only to describe the "a call arrived but declared nothing" case,
    # which is the honest reading when no call ever carried one.
    installed = ingest["installed"]
    sdk = (installed or {}).get("sdk") or {}
    if sdk.get("version"):
        install_evidence = (
            f"{installed['runtime'] or sdk.get('language')} SDK {sdk['version']}"
            " reported by an uploaded call"
        )
    elif first:
        install_evidence = "A call arrived, but its manifest declared no SDK version"
    else:
        install_evidence = None

    captured = ingest["captured"]
    steps = [
        _step(
            "api-key",
            "Create an API key",
            keys["active"] > 0,
            evidence=key_evidence,
            waiting="No active key on this instance yet.",
            detail={
                "active": keys["active"],
                "total": keys["total"],
                "authenticated": bool(keys["last_used_at"]),
                "last_used_at": keys["last_used_at"],
                "required": require_api_key,
            },
        ),
        _step(
            "install",
            "Install the SDK",
            bool(sdk.get("version")),
            evidence=install_evidence,
            waiting="Nothing has run this SDK against this instance yet, so it cannot be confirmed from here. Mark it done yourself once the install finishes.",
            self_reportable=True,
            detail={
                "sdk": sdk,
                "installed": installed,
                "latest_runtime": (ingest["latest"] or {}).get("runtime"),
            },
        ),
        _step(
            "instrument",
            "Instrument your agent and upload a call",
            ingest["sessions"] > 0,
            evidence=(
                # "started", not "received": the row exists from the handshake,
                # and the upload it opened may still be in flight or may have
                # died. Claiming receipt here is what would contradict the step
                # below.
                f"{ingest['sessions']} call{'s' if ingest['sessions'] != 1 else ''} started"
                + (f" · first from agent “{first['agent_id']}”" if first and first.get("agent_id") else "")
                if first
                else None
            ),
            waiting="Waiting for the first call. This page updates itself the moment one lands.",
            detail={"first": first, "latest": ingest["latest"], "recent": ingest["recent"]},
        ),
        _step(
            "capture",
            "Confirm spans were captured",
            captured is not None,
            evidence=(
                f"{captured['operation_count']} operation"
                f"{'s' if captured['operation_count'] != 1 else ''} captured on call {captured['session_id']}"
                if captured
                else None
            ),
            waiting=(
                # The distinction the whole page turns on. A call landing with no
                # operations is a *specific* misconfiguration, not an absence of
                # progress, and saying so is the difference between a five-minute
                # fix and an afternoon.
                f"{ingest['uploaded_without_operations']} uploaded call"
                f"{'s' if ingest['uploaded_without_operations'] != 1 else ''} recorded no operations."
                " The call reached this dashboard, so the credential and transport are fine —"
                " what did not match is the endpoints list. Every provider URL your agent calls"
                " must be listed there, or the SDK deliberately leaves it untouched."
                if ingest["uploaded_without_operations"]
                # A started-but-unfinished upload is its own diagnosis, and a
                # different one: the package never completed, so there is nothing
                # to have captured spans from yet.
                else (
                    f"{ingest['in_flight']} call{'s' if ingest['in_flight'] != 1 else ''} started uploading"
                    " but never finished. The SDK uploads after the call ends — if this stays here,"
                    " the process exited before upload_package finished, or an object PUT failed."
                    if ingest["in_flight"]
                    else "No call has been uploaded yet, so there is nothing to check."
                )
            ),
            detail={
                "captured": captured,
                "uploaded_without_operations": ingest["uploaded_without_operations"],
                "in_flight": ingest["in_flight"],
            },
        ),
    ]

    complete = all(step["state"] == "verified" for step in steps)
    return {
        "complete": complete,
        "verified_steps": sum(step["state"] == "verified" for step in steps),
        "total_steps": len(steps),
        "steps": steps,
        "keys": keys,
        "ingest": ingest,
        "enforcement": {
            "required": require_api_key,
            "env_var": "VAANI_REQUIRE_API_KEY",
        },
    }
