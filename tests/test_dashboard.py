"""End-to-end coverage of the aggregate dashboard.

Every test here uploads real calls through the same SDK-facing endpoints an
agent would use, then asserts on what the dashboard reports. That is
deliberate: the aggregate tables are a cache of the raw operations, and a test
that populated them directly would happily pass while the ingest path that
actually fills them was broken.
"""

from __future__ import annotations

import json

import pytest

from conftest import jsonl, manifest, object_info, operation

from app import aggregate, main, metrics


def ingest(client, session_id: str, events: bytes, **overrides):
    """Create, upload and complete one call the way the SDK does."""
    created = client.post("/v1/sessions", json=manifest(session_id, **overrides))
    assert created.status_code == 201
    path = created.json()["upload_urls"]["events.jsonl"].split("http://testserver", 1)[1]
    assert client.put(path, content=events).status_code == 204
    completed = client.post(
        f"/v1/sessions/{session_id}/complete",
        json={"objects": {"events.jsonl": object_info(events)}},
    )
    assert completed.status_code == 202
    return completed


def turn(index: int, base_ms: int, *, llm_error: str | None = None,
         first_audio_offset: int = 400, session_id: str = "call-1") -> list[dict]:
    """One realistic turn: caller speaks, STT finalises, LLM answers, TTS speaks.

    Event ids are namespaced by session because `operations.id` is a global
    primary key: two calls reusing `stt-1` would silently reassign each other's
    operations, and the resulting test would be measuring that bug rather than
    whatever it meant to measure. The event's own `session_id` must match the
    call it is uploaded under too, or ingest rejects the row and the call
    completes as `partial` with zero operations.
    """
    turn_id = f"turn-{index}"
    prefix = f"{session_id}-"
    stt = operation(
        event_id=f"{prefix}stt-{index}", type_="stt", session_id=session_id, turn_id=turn_id, endpoint_id="deepgram",
        provider="deepgram", model="nova-3", started_at_ms=base_ms,
        ended_at_ms=base_ms + 900, duration_ms=900,
        milestones={
            "speech_started": {"occurred_at_ms": base_ms},
            "first_partial": {"occurred_at_ms": base_ms + 300},
            "speech_ended": {"occurred_at_ms": base_ms + 800},
            "final_transcript": {"occurred_at_ms": base_ms + 900},
        },
        response={"transcript": "hello", "is_final": True,
                  "words": [{"word": "hello", "start_ms": base_ms + 100, "end_ms": base_ms + 800}]},
    )
    llm = operation(
        event_id=f"{prefix}llm-{index}", type_="llm", session_id=session_id, turn_id=turn_id, endpoint_id="openai",
        provider="openai", model="gpt-4o", started_at_ms=base_ms + 900,
        ended_at_ms=base_ms + 1500, duration_ms=600,
        status="error" if llm_error else "ok",
        error={"name": llm_error, "message": "upstream said no"} if llm_error else None,
        milestones={"first_token": {"occurred_at_ms": base_ms + 1100}},
    )
    tts = operation(
        event_id=f"{prefix}tts-{index}", type_="tts", session_id=session_id, turn_id=turn_id, endpoint_id="sarvam",
        provider="sarvam", model="bulbul:v3", started_at_ms=base_ms + 1500,
        ended_at_ms=base_ms + 2200, duration_ms=700,
        milestones={
            "first_byte": {"occurred_at_ms": base_ms + 1500 + first_audio_offset // 2},
            "audio_chunk": {"occurred_at_ms": base_ms + 1500 + first_audio_offset},
        },
    )
    return [stt, llm, tts]


def call_events(turns: int = 3, session_id: str = "call-1", **kwargs) -> bytes:
    events: list[dict] = []
    for index in range(1, turns + 1):
        events.extend(turn(index, (index - 1) * 3000, session_id=session_id, **kwargs))
    return jsonl(*events)


# The fixture manifests start at 2026-01-01, which is outside the endpoint's
# default "last 7 days". Tests state the window explicitly so they assert on the
# dashboard's behaviour rather than on what today's date happens to be.
# Kept inside the endpoint's 180-day cap on purpose: a test that quietly asked
# for a two-year range would only ever exercise the rejection path.
WINDOW = {"from_ms": 1_764_633_600_000, "to_ms": 1_769_817_600_000}  # 2025-12-02 .. 2026-01-31


def summary(client, **params):
    response = client.get("/v1/dashboard/summary", params={**WINDOW, **params})
    assert response.status_code == 200, response.text
    return response.json()


def drilldown(client, **params):
    response = client.get("/v1/dashboard/calls", params={**WINDOW, **params})
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------- basics


def test_dashboard_page_is_served(client):
    assert client.get("/dashboard").status_code == 200


def test_summary_of_an_empty_install_is_empty_not_broken(client):
    """A fresh install has no calls, and must say so rather than 500.

    This is the first screen every new user sees.
    """
    payload = summary(client)
    assert payload["coverage"]["calls"] == 0
    assert payload["overview"]["calls"]["total"] == 0
    assert payload["overview"]["response_latency"]["available"] is False
    assert payload["attention"]["items"] == []


def test_uploaded_call_appears_in_the_summary(client):
    ingest(client, "call-1", call_events(turns=3))
    payload = summary(client)
    assert payload["overview"]["calls"]["total"] == 1
    assert payload["overview"]["calls"]["turns"] == 3
    assert payload["accuracy"]["exact"] is True


# ------------------------------------------------------- accuracy guarantees


def test_dashboard_latency_matches_the_call_detail_view(client, api):
    """The whole point of deriving both from `group_turns`.

    If these two ever disagree, a developer clicks a P95 and lands on a call
    whose own page reports a different number, and stops trusting the page.
    """
    ingest(client, "call-1", call_events(turns=4))

    with api.connect() as db:
        _, session_turns, _ = api.session_metric_inputs("call-1", db)
        stored = db.execute(
            "SELECT turn_id, response_latency_ms FROM turn_metrics WHERE session_id = ? ORDER BY turn_id",
            ("call-1",),
        ).fetchall()

    # `group_turns` is what the call page renders, and `time_to_first_audio_ms`
    # is the field it renders as the turn's response latency.
    from_detail = {
        item["turn_id"]: item.get("time_to_first_audio_ms") for item in session_turns
    }
    # Assert the fixture actually measures something first: two nulls compare
    # equal, so without this the test would pass against a capture that lost
    # every milestone - which is exactly how this fixture was once broken.
    assert any(value is not None for value in from_detail.values()), "fixture produced no latency"
    for row in stored:
        assert row["response_latency_ms"] == from_detail[row["turn_id"]], row["turn_id"]


def test_abort_is_excluded_from_the_failure_rate(client):
    """A cancelled TTS is the agent yielding to the caller, not an error."""
    events = jsonl(*[
        *turn(1, 0),
        operation(event_id="tts-abort", type_="tts", turn_id="turn-1", started_at_ms=2500,
                  ended_at_ms=2600, duration_ms=100, status="error",
                  error={"name": sorted(metrics.ABORT_NAMES)[0], "message": "barge-in"}),
    ])
    ingest(client, "call-1", events)

    payload = summary(client)
    assert payload["overview"]["failure_impacted_calls"]["count"] == 0
    assert payload["stages"]["tts"]["failure_rate"]["count"] == 0
    interrupted = {item["key"]: item for item in payload["stages"]["tts"]["extra"]}
    assert interrupted["tts_interrupted"]["count"] == 1


def test_genuine_failure_is_counted_and_reaches_the_attention_queue(client):
    ingest(client, "call-1", call_events(turns=2, llm_error="ReadTimeout"))

    payload = summary(client)
    assert payload["stages"]["llm"]["failure_rate"]["count"] == 2
    assert payload["overview"]["failure_impacted_calls"]["count"] == 1
    assert payload["failures"][0]["fingerprint"] == "llm:ReadTimeout"

    queue = payload["attention"]
    assert queue["items"][0]["session_id"] == "call-1"
    assert queue["items"][0]["severity"] == aggregate.SEVERITY_BROKEN
    # The list must point at the turn that broke, not just at the call.
    assert queue["items"][0]["focus_turn_id"] is not None


def test_missing_milestone_is_unavailable_with_a_reason_never_zero(client):
    """An SDK build that never emitted `llm.first_token` has no TTFT.

    Reporting 0 ms would tell a developer their model is instant.
    """
    events = jsonl(*[
        operation(event_id="stt-1", type_="stt", turn_id="turn-1", started_at_ms=0,
                  ended_at_ms=900, duration_ms=900,
                  milestones={"speech_ended": {"occurred_at_ms": 800},
                              "final_transcript": {"occurred_at_ms": 900}},
                  response={"transcript": "hi", "is_final": True}),
        operation(event_id="llm-1", type_="llm", turn_id="turn-1", started_at_ms=900,
                  ended_at_ms=1500, duration_ms=600, milestones={}),
    ])
    ingest(client, "call-1", events)

    ttft = next(m for m in summary(client)["stages"]["llm"]["metrics"] if m["key"] == "llm_ttft_ms")
    assert ttft["distribution"]["available"] is False
    assert ttft["distribution"].get("p50") is None
    assert ttft["distribution"]["reason"] in metrics.UNAVAILABLE_REASONS


def test_facets_say_why_a_dimension_is_empty(client):
    """No SDK records an agent version, so that filter must explain itself.

    An empty dropdown with no reason reads as "you have no production traffic",
    which is a very different claim from "we never received this field".
    """
    ingest(client, "call-1", call_events(turns=1))
    facets = summary(client)["facets"]
    assert facets["agent_version"]["values"] == []
    assert facets["agent_version"]["reason"] == "not_captured_by_sdk"
    # Dimensions the upload really carried are offered, with no excuse attached.
    assert facets["environment"]["values"] == ["test"]
    assert facets["environment"]["reason"] is None
    assert "deepgram" in facets["provider"]["values"]


# ------------------------------------------------------------------- drilldown


def test_every_kpi_selector_resolves_to_calls(client):
    """A number you cannot open is trivia.

    Guards against a selector being renamed on one side only, which would
    silently fall back to "all calls" and show the wrong list.
    """
    ingest(client, "call-1", call_events(turns=2, llm_error="ReadTimeout"))
    for selector in aggregate.DRILLDOWNS:
        listed = drilldown(client, selector=selector)
        assert listed["selector"] == selector, selector


def test_drilldown_count_matches_the_kpi_it_came_from(client):
    ingest(client, "call-1", call_events(turns=2, llm_error="ReadTimeout"))
    ingest(client, "call-2", call_events(turns=2, session_id="call-2"))

    payload = summary(client)
    failing = payload["overview"]["failure_impacted_calls"]["count"]
    listed = drilldown(client, selector="failures")
    assert listed["total"] == failing == 1
    assert listed["items"][0]["session_id"] == "call-1"


def test_unknown_selector_is_rejected_rather_than_silently_widened(client):
    ingest(client, "call-1", call_events(turns=1))
    listed = drilldown(client, selector="nonsense")
    # Falling back to "all" is the documented behaviour, and the response says
    # so - the client is never told it is looking at a filtered list when it
    # is not.
    assert listed["selector"] == "all"


# ------------------------------------------------------------------ integrity


def test_reupload_replaces_rather_than_duplicates(client):
    """A retried upload must not double the fleet's turn count."""
    ingest(client, "call-1", call_events(turns=3))
    first = summary(client)["overview"]["calls"]

    ingest(client, "call-1", call_events(turns=3))
    second = summary(client)["overview"]["calls"]

    assert second["total"] == first["total"] == 1
    assert second["turns"] == first["turns"] == 3


def test_reupload_with_fewer_turns_strands_nothing(client):
    """Delete-then-insert, not upsert.

    An upsert would leave the extra turn rows from the longer first upload in
    place, inflating every denominator on the page forever.
    """
    ingest(client, "call-1", call_events(turns=4))
    ingest(client, "call-1", call_events(turns=2))
    assert summary(client)["overview"]["calls"]["turns"] == 2


def test_backfill_is_idempotent(client, api):
    ingest(client, "call-1", call_events(turns=3))
    before = summary(client)["overview"]["calls"]
    assert api.backfill_metrics() == 0  # nothing left stale after ingest
    assert summary(client)["overview"]["calls"] == before


def test_audit_reports_no_drift_for_freshly_ingested_calls(client):
    """The aggregate tables are a cache; this is what proves it is not lying."""
    ingest(client, "call-1", call_events(turns=3))
    ingest(client, "call-2", call_events(turns=2, llm_error="ReadTimeout", session_id="call-2"))

    report = client.get("/v1/dashboard/audit").json()
    assert report["sessions_checked"] == 2
    assert report["turns_compared"] == 5
    assert report["consistent"] is True, report["mismatches"]


def test_an_upgrade_stops_an_orphan_continuation_subtracting_a_turn_it_has(client):
    """The stored bit was a claim, not a checked fact.

    The previous release backfilled `operations.is_continuation` from whether
    the SDK said a turn continues another one, without asking whether that other
    one is here. A call whose first half was lost arrives with a continuation
    and nothing to fold into, and the bit then subtracted an exchange that was
    never counted -- so the session rail showed no turns while every aggregate
    showed one. Ingest re-decides this now, but rows written before that keep
    the old answer and the rail reads them directly, so the upgrade has to
    revisit them.
    """
    orphan = [event for event in
              (json.loads(line) for line in
               unanswered_split_events().decode().splitlines())
              if event.get("turn_id") == "turn-2"]
    ingest(client, "call-1", jsonl(*orphan))

    # The state the previous release leaves behind: `user_version` says its
    # unconditional backfill ran, so nothing would revisit the row.
    with main.connect() as db:
        db.execute("UPDATE operations SET is_continuation = 1")
        db.execute("PRAGMA user_version = 2")
        db.commit()

    main.initialize()

    rail = next(row for row in client.get("/v1/sessions").json()
                if row["id"] == "call-1")["turn_count"]
    assert rail == 1, (
        "an exchange with no first half in the package is the only exchange "
        "there is, and the rail must count it"
    )
    with main.connect() as db:
        assert db.execute(
            "SELECT is_continuation FROM operations").fetchone()[0] == 0, (
            "the derived bit still claims a parent the call does not contain"
        )


def test_an_upgrade_rebuilds_split_facts_instead_of_calling_them_tampered(
        client, api):
    """A migrated column starts at its default, which for a stored split is wrong.

    The per-stage split columns are recomputed by the audit, so an existing
    database that gained them at DEFAULT 0 would have every already-stored split
    call reported as tampered with -- permanently, since nothing rewrites a row
    the audit merely complains about. The METRICS_VERSION bump is what makes the
    difference, so this test drives the upgrade rather than trusting it: it puts
    the row back into the state a migration leaves it in and then re-runs the
    rebuild the bump forces.
    """
    ingest(client, "call-1", split_call_events())
    with api.connect() as db:
        stored = db.execute(
            "SELECT stt_split FROM turn_metrics WHERE session_id = ? "
            "AND stt_split = 1", ("call-1",)).fetchall()
        assert stored, "guard: this call must actually carry a split stage"
        # Exactly what an upgraded database looks like: the column exists,
        # every row has its default, and the version is behind.
        db.execute("UPDATE turn_metrics SET stt_split = 0, llm_split = 0, "
                   "tts_split = 0, tool_split = 0")
        # 4 literally, not `METRICS_VERSION - 1`: the point is that the
        # version these columns arrived in is treated as stale. Relative to
        # whatever the constant happens to say, the test would pass even if the
        # bump were forgotten -- which is the mistake it exists to catch.
        db.execute("UPDATE call_metrics SET metrics_version = 4")
        db.commit()

    assert api.backfill_metrics() == 1, (
        "a row built by an older definition must be rebuilt, not kept"
    )
    report = client.get("/v1/dashboard/audit").json()
    assert report["consistent"] is True, report["mismatches"]
    with api.connect() as db:
        assert db.execute(
            "SELECT stt_split FROM turn_metrics WHERE session_id = ? "
            "AND stt_split = 1", ("call-1",)).fetchall(), (
            "the rebuild must restore the split fact, not just silence the audit"
        )


def test_audit_detects_tampered_metrics(client, api):
    """If the audit cannot catch a wrong stored value, it is decoration."""
    ingest(client, "call-1", call_events(turns=3))
    with api.connect() as db:
        db.execute("UPDATE turn_metrics SET response_latency_ms = 999999 WHERE session_id = ?",
                   ("call-1",))
        db.commit()

    report = client.get("/v1/dashboard/audit").json()
    assert report["consistent"] is False
    assert report["mismatch_count"] == 3  # one per tampered turn
    assert report["mismatches"][0]["field"] == "response_latency_ms"
    assert report["mismatches"][0]["stored"] == 999999


# ------------------------------------------------------------ exact vs sketch


def test_rollup_percentiles_agree_with_exact_within_the_stated_error(client, api):
    """Narrowing a time range must not visibly move a number.

    The sketch path answers wide ranges and the exact path answers narrow ones;
    if they disagreed by more than the published bound, a developer zooming in
    on an incident would watch the P95 jump and not know which to believe.
    """
    for index in range(6):
        ingest(client, f"call-{index}", call_events(turns=4, session_id=f"call-{index}"))

    with api.connect() as db:
        aggregate.refresh_rollups(db)
        filters = aggregate.Filters(start_ms=WINDOW["from_ms"], end_ms=WINDOW["to_ms"])
        exact = aggregate._exact(db, filters, aggregate.ROLLUP_BUCKET_MS, compare=False)
        rolled = aggregate._rollup(db, filters, aggregate.ROLLUP_BUCKET_MS, compare=False)

    # The two paths deliberately expose different counter shapes - the exact
    # path can hold distinct session sets, the rollup path can only hold
    # pre-summed counts - so the contract is that every counter they share
    # agrees. Comparing only the intersection is not enough on its own: a
    # counter the rollup path simply forgot to select drops out of the
    # intersection and is never checked, which is how three stage-turn
    # denominators once went missing on wide ranges. Every counter the panels
    # actually read must therefore be present on both sides.
    required = {
        f"{stage}_{suffix}"
        for stage in ("stt", "llm", "tts", "tool")
        for suffix in ("ops", "turns", "failed")
    }
    for side, counters in (("exact", exact["counters"]), ("rollup", rolled["counters"])):
        missing = sorted(required - set(counters))
        assert not missing, f"{side} path is missing counters the dashboard reads: {missing}"

    shared = set(rolled["counters"]) & set(exact["counters"])
    assert shared, "the two query paths share no counters at all"
    for name in sorted(shared):
        assert rolled["counters"][name] == exact["counters"][name], name
    for metric, exact_dist in exact["distributions"].items():
        rolled_dist = rolled["distributions"][metric]
        assert rolled_dist["available"] == exact_dist["available"], metric
        if not exact_dist["available"]:
            continue
        assert rolled_dist["count"] == exact_dist["count"], metric
        for quantile in ("p50", "p95", "p99"):
            expected, actual = exact_dist[quantile], rolled_dist[quantile]
            if not expected:
                continue
            error = abs(actual - expected) / expected
            assert error <= aggregate.sketch_module.RELATIVE_ERROR, (metric, quantile, expected, actual)


# ------------------------------------------------------- definitions and drift


def test_a_response_faster_than_physically_possible_is_not_published(client, api):
    """A "1 ms response" is a clock artefact, not an achievement.

    Speech end and first audio come from different subsystems, and a capture
    that reports the agent answering the instant the caller stopped talking has
    mismeasured something. Publishing it would drag the fleet P50 down and make
    a genuinely fast agent look impossible to match. The floor lives in
    `group_turns`, so the call page and the dashboard drop the same turn.
    """
    events = jsonl(*[
        *turn(1, 0),
        # Second turn: TTS audio lands 20 ms after the caller stops speaking.
        operation(event_id="call-1-stt-2", type_="stt", session_id="call-1", turn_id="turn-2",
                  provider="deepgram", model="nova-3", started_at_ms=5000,
                  ended_at_ms=5900, duration_ms=900,
                  milestones={"speech_started": {"occurred_at_ms": 5000},
                              "speech_ended": {"occurred_at_ms": 5800},
                              "final_transcript": {"occurred_at_ms": 5900}},
                  response={"transcript": "hi", "is_final": True,
                            "words": [{"word": "hi", "start_ms": 5100, "end_ms": 5800}]}),
        operation(event_id="call-1-tts-2", type_="tts", session_id="call-1", turn_id="turn-2",
                  provider="sarvam", model="bulbul:v3", started_at_ms=5810,
                  ended_at_ms=5900, duration_ms=90,
                  milestones={"audio_chunk": {"occurred_at_ms": 5820}}),
    ])
    ingest(client, "call-1", events)

    with api.connect() as db:
        stored = {row["turn_id"]: row["response_latency_ms"] for row in db.execute(
            "SELECT turn_id, response_latency_ms FROM turn_metrics WHERE session_id = 'call-1'")}
    assert stored["turn-2"] is None, "an implausible 20 ms response was published"
    assert stored["turn-1"] is not None, "the plausible turn was dropped too"


def test_retired_provider_names_stop_being_offered_as_filters(client, api):
    """`metric_facets` is append-only, so it needs an explicit reaper.

    Every value in the dropdown is a promise that selecting it returns calls.
    """
    ingest(client, "call-1", call_events(turns=1))
    with api.connect() as db:
        db.execute("INSERT OR REPLACE INTO metric_facets (dimension, value, last_seen_ms) "
                   "VALUES ('provider', 'deepgram-stt', 1)")
        db.commit()
        assert "deepgram-stt" in summary(client)["facets"]["provider"]["values"]
        aggregate.prune_facets(db)
        db.commit()

    values = summary(client)["facets"]["provider"]["values"]
    assert "deepgram-stt" not in values
    assert "deepgram" in values


def test_stage_coverage_is_measured_against_that_stage_own_turns(client):
    """A stage that ran in half the turns is not 50%% covered.

    Dividing by every turn in range would report a fully instrumented TTS stage
    as half broken purely because some turns had no TTS at all, and send the
    reader hunting for a capture bug that does not exist.
    """
    events = jsonl(*[
        *turn(1, 0),
        # A turn with STT only - the caller spoke and the agent stayed silent.
        operation(event_id="call-1-stt-solo", type_="stt", session_id="call-1", turn_id="turn-9",
                  provider="deepgram", model="nova-3", started_at_ms=9000,
                  ended_at_ms=9900, duration_ms=900,
                  milestones={"speech_started": {"occurred_at_ms": 9000},
                              "first_partial": {"occurred_at_ms": 9300},
                              "speech_ended": {"occurred_at_ms": 9800},
                              "final_transcript": {"occurred_at_ms": 9900}},
                  response={"transcript": "hello?", "is_final": True,
                            "words": [{"word": "hello", "start_ms": 9100, "end_ms": 9800}]}),
    ])
    ingest(client, "call-1", events)

    stages = summary(client)["stages"]
    tts = next(m for m in stages["tts"]["metrics"] if m["key"] == "tts_first_audio_ms")
    # One of two turns had TTS, and that one turn was fully measured.
    assert tts["coverage"]["measured"] == 1
    assert tts["coverage"]["eligible"] == 1
    assert tts["coverage"]["ratio"] == 1.0
    # The wider population is still reported, so the reader can see the stage
    # only ran in half the traffic - it is just not used as the denominator.
    assert tts["coverage"]["turns_in_range"] == 2


def test_changing_the_sketch_error_bound_rebuilds_instead_of_mis_merging(client, api):
    """Bucket indexes only mean anything relative to the gamma that wrote them.

    Reading a blob written under a different relative error yields percentiles
    that look plausible and are wrong, which is the worst failure mode this
    dashboard has. The format tag makes it detectable.
    """
    ingest(client, "call-1", call_events(turns=3))
    with api.connect() as db:
        aggregate.refresh_rollups(db)
        db.commit()
        assert db.execute("SELECT COUNT(*) c FROM metric_rollups").fetchone()["c"] > 0

        db.execute("UPDATE rollup_meta SET value = 'v0-e50' WHERE key = 'sketch_format'")
        db.commit()
        aggregate.ensure_schema(db)

        assert db.execute("SELECT COUNT(*) c FROM metric_rollups").fetchone()["c"] == 0
        assert db.execute("SELECT COUNT(*) c FROM rollup_dirty").fetchone()["c"] > 0
        assert db.execute(
            "SELECT value FROM rollup_meta WHERE key = 'sketch_format'"
        ).fetchone()["value"] == aggregate.sketch_module.FORMAT_TAG

        # And the rebuilt tier agrees with the raw rows again.
        aggregate.refresh_rollups(db)
        db.commit()
        assert db.execute("SELECT COUNT(*) c FROM metric_rollups").fetchone()["c"] > 0


def test_fixtures_only_emit_milestone_names_the_code_reads():
    """Guards the whole suite against silently measuring nothing.

    These fixtures once used names like `stt.first_partial`, which no SDK emits
    and nothing in `app/latency.py` looks up. Every latency the dashboard
    derived from them was therefore `None`, and the tests that compared the
    aggregate against the call detail passed by comparing `None` to `None`.
    The vocabulary is read out of the source rather than hard-coded so it
    cannot drift away from what the code actually accepts.
    """
    import re
    from pathlib import Path

    source = "".join(
        (Path(__file__).resolve().parents[1] / "app" / name).read_text()
        for name in ("latency.py", "metrics.py")
    )
    recognised = {
        name
        for call in re.findall(r"(?:milestone_ms|has_milestone|milestone_detail)\((.*?)\)", source, re.S)
        for name in re.findall(r'"([a-z_]+)"', call)
    }
    used = {
        name
        for name in re.findall(r'"([a-z_]+)"\s*:\s*\{"occurred_at_ms"', Path(__file__).read_text())
    }
    assert used, "the fixture scan found no milestones at all"
    unknown = used - recognised
    assert not unknown, f"fixtures emit milestones nothing reads: {sorted(unknown)}"


def test_a_filtered_range_that_is_too_large_refuses_instead_of_scanning(client, api, monkeypatch):
    """The refusal must actually refuse.

    Provider and model are not rollup dimensions, so a wide filtered range can
    only be answered by sorting every raw turn in it - measured at ten seconds
    for a filtered month at a million turns. The banner used to say "narrow the
    range" while the server did the ten seconds of work anyway.
    """
    ingest(client, "call-1", call_events(turns=3))
    monkeypatch.setattr(aggregate, "EXACT_TURN_LIMIT", 1)

    calls_made = []
    original = aggregate._exact
    monkeypatch.setattr(aggregate, "_exact",
                        lambda *a, **k: calls_made.append(1) or original(*a, **k))

    payload = summary(client, provider="deepgram")
    assert payload["accuracy"]["refused"]["reason"] == "range_too_large_for_filter"
    assert not calls_made, "the refused request still ran the exact scan it refused"
    assert payload["overview"]["response_latency"]["reason"] == "range_too_large_for_filter"

    # An unfiltered range of the same size is still answered, from the rollups.
    with api.connect() as db:
        aggregate.refresh_rollups(db)
        db.commit()
    unfiltered = summary(client)
    assert unfiltered["accuracy"].get("refused") is None


def test_a_refused_range_reports_no_number_it_did_not_compute(client, monkeypatch):
    """A refusal that still prints "0 of 64 calls affected" is worse than a dash.

    Every per-stage counter is zero on the refused path by construction, so any
    rate derived from them is fabricated - and it sat directly beside
    `failure_impacted_calls`, which IS computed from the cheap call-level row
    and said something different.
    """
    ingest(client, "call-1", call_events(turns=3, llm_error="RateLimitError"))
    monkeypatch.setattr(aggregate, "EXACT_TURN_LIMIT", 1)

    payload = summary(client, provider="deepgram")
    assert payload["accuracy"]["refused"]["reason"] == "range_too_large_for_filter"

    for stage, panel in payload["stages"].items():
        assert panel["calls_impacted"]["available"] is False, stage
        assert panel["calls_impacted"]["reason"] == "range_too_large_for_filter", stage
        assert panel["calls_impacted"]["count"] is None, stage
        assert panel["failure_rate"]["available"] is False, stage
        assert panel["failure_rate"]["reason"] == "range_too_large_for_filter", stage
        # "0 operations" in the card header is the same fabrication in a
        # quieter place: nobody counted this stage's operations either.
        assert panel["eligible_operations"] is None, stage
        for extra in panel.get("extra", []):
            assert extra["available"] is False, (stage, extra["key"])
        for metric in panel["metrics"]:
            # Not "stage_absent": nobody looked at whether the stage ran.
            assert metric["distribution"]["reason"] == "range_too_large_for_filter", metric["key"]

    # The panels that would need the same refused scan are empty, not guessed.
    assert payload["tools"]["items"] == []
    assert payload["failures"] == []

    # A run of zero buckets is not "no traffic", it is "nobody counted". Left as
    # zeros it drew an empty trend chart and a notice reading "no turn had a
    # measurable response latency - stage metrics below are still valid", both
    # of which contradict the refusal banner and the real call counts beside it.
    # The accuracy block must not advertise a computation that did not happen:
    # `exact: true` beside `refused: {...}` reads as "trust the percentiles".
    accuracy = payload["accuracy"]
    assert accuracy["exact"] is False
    assert accuracy["method"] is None
    assert accuracy["percentile_rule"] is None
    assert accuracy["relative_error"] is None
    assert accuracy["note"] is None

    assert payload["timeseries"] == []
    assert payload["coverage"]["measured_response_turns"] is None
    assert payload["overview"]["audible_lag"]["available"] is False
    assert payload["overview"]["audible_lag"]["reason"] == "range_too_large_for_filter"

    # What genuinely was computed stays computed: the call-level row is cheap.
    assert payload["overview"]["calls"]["total"] > 0
    assert payload["coverage"]["turns"] > 0
    assert payload["overview"]["failure_impacted_calls"]["available"] is True


def test_rollup_failure_call_counts_are_flagged_as_an_upper_bound(client, api, monkeypatch):
    """Summed hourly distinct counts cannot deduplicate a call that spans hours.

    The panel links to a drill-down that returns the true distinct count, so an
    unflagged sum makes the summary disagree with the list it opens.
    """
    ingest(client, "call-1", call_events(turns=2, llm_error="RateLimitError"))
    with api.connect() as db:
        aggregate.refresh_rollups(db)
        db.commit()

    monkeypatch.setattr(aggregate, "EXACT_TURN_LIMIT", 0)
    payload = summary(client)
    assert payload["accuracy"]["exact"] is False
    assert payload["failures"], "the rollup path returned no failure signatures"
    total_calls = payload["overview"]["calls"]["total"]
    for item in payload["failures"]:
        assert item["calls_are_upper_bound"] is True, item["fingerprint"]
        # Clamped: a merged sum must never claim more calls than exist in range.
        assert item["calls"] <= total_calls, item["fingerprint"]


def test_only_one_process_can_hold_the_maintenance_lease(api, data_dir):
    """Two workers starting together both saw an empty lease and both claimed it.

    Read-then-write is not a claim, it is a suggestion. Every uvicorn worker
    runs the startup hook, so the deferred first passes all fire at the same
    moment - the exact case the lease exists to prevent.
    """
    from app import main as app_main

    now_ms = 1_700_000_000_000
    ttl_ms = 60_000
    with api.connect() as reset:
        reset.execute("DELETE FROM rollup_meta WHERE key = 'test_lease'")
        reset.commit()
    with api.connect() as first, api.connect() as second:
        contenders = [(first, "host-a:1:aaaa"), (second, "host-b:1:bbbb")]
        claims = [(identity, aggregate.claim_lease(db, "test_lease", identity, ttl_ms, now_ms))
                  for db, identity in contenders]
        winners = [identity for identity, won in claims if won]
        assert len(winners) == 1, f"both processes claimed the same lease: {claims}"

        owner = winners[0]
        loser_db, loser = next((db, i) for db, i in contenders if i != owner)
        owner_db = next(db for db, i in contenders if i == owner)

        # The owner keeps renewing; the loser stays locked out while it does.
        assert aggregate.claim_lease(owner_db, "test_lease", owner, ttl_ms, now_ms + 1_000) is True
        assert aggregate.claim_lease(loser_db, "test_lease", loser, ttl_ms, now_ms + 1_000) is False

        # An owner that stops renewing loses it, so maintenance is never orphaned.
        assert aggregate.claim_lease(loser_db, "test_lease", loser,
                                     ttl_ms, now_ms + ttl_ms + 2_000) is True

        # The lease value stores the timestamp first, because SQLite's `instr`
        # finds the FIRST separator: with the identity first, an identity
        # containing the separator parsed as a different owner and could never
        # renew, locking maintenance out until every TTL expiry.
        with api.connect() as third:
            third.execute("DELETE FROM rollup_meta WHERE key = 'test_lease'")
            third.commit()
            assert aggregate.claim_lease(third, "test_lease", "host@x:1:cccc", ttl_ms, now_ms) is True
            assert aggregate.claim_lease(third, "test_lease", "host@x:1:cccc", ttl_ms, now_ms + 1) is True
            assert aggregate.claim_lease(third, "test_lease", "other:1:dddd", ttl_ms, now_ms + 1) is False

            # A value with no separator at all must not jam maintenance forever.
            third.execute("UPDATE rollup_meta SET value = 'garbage' WHERE key = 'test_lease'")
            third.commit()
            assert aggregate.claim_lease(third, "test_lease", "other:1:dddd", ttl_ms, now_ms) is True

    # Two containers both running as pid 1 must not both own it.
    assert app_main.MAINTENANCE_IDENTITY.count(":") == 2
    assert app_main.MAINTENANCE_IDENTITY.split(":")[-1]


def test_a_one_second_probe_call_does_not_outrank_a_slow_real_call(client):
    """Triage is ordered by what is worth opening, not by class alone.

    A sub-second call with no measurable latency is a hang-up or a smoke test.
    Ranking every one of them above genuinely slow calls - which is what a pure
    class order does - puts noise at the top of the one list that exists to say
    "open this first".
    """
    probe = jsonl(*[
        operation(event_id="probe-tts", type_="tts", session_id="probe", turn_id="turn-1",
                  provider="sarvam", model="bulbul:v3", started_at_ms=0, ended_at_ms=700,
                  duration_ms=700, milestones={"audio_chunk": {"occurred_at_ms": 100}}),
    ])
    ingest(client, "probe", probe)
    # A real call, slow enough to breach the audible-lag threshold.
    ingest(client, "slow", call_events(turns=3, session_id="slow", first_audio_offset=6000))

    items = summary(client)["attention"]["items"]
    listed = [item["session_id"] for item in items]
    assert "slow" in listed
    assert "probe" not in listed, "a sub-second probe was promoted into the triage queue"


def split_call_events() -> bytes:
    """A two-turn call whose second turn the SDK marked as a continuation of the
    first - the shape LiveKit produces when the caller's earlier words were
    already published before the reply arrived."""
    marked = []
    for line in call_events(turns=2).decode().splitlines():
        payload = json.loads(line)
        if payload["type"] == "stt" and payload["turn_id"] == "turn-2":
            payload["response"] = {
                **payload["response"],
                "continues_turn": "turn-1",
                "split_reason": "earlier_words_already_published",
            }
        marked.append(payload)
    return jsonl(*marked)


def unanswered_split_events() -> bytes:
    """A split whose first half is unanswered, which is the only shape the SDK
    actually produces: it sets `continues_turn` precisely when the turn it
    carries never got a reply. So the first half has speech-to-text on it and
    nothing else, and every later stage ran once, on the answer."""
    events = []
    for line in call_events(turns=2).decode().splitlines():
        payload = json.loads(line)
        if payload["turn_id"] == "turn-1" and payload["type"] != "stt":
            continue
        if payload["type"] == "stt" and payload["turn_id"] == "turn-2":
            payload["response"] = {
                **payload["response"],
                "continues_turn": "turn-1",
                "split_reason": "earlier_words_already_published",
            }
        events.append(payload)
    return jsonl(*events)


def test_a_split_turn_is_not_counted_twice_anywhere_in_the_summary(client):
    """One correction is worthless if the other three paths disagree with it.

    A turn we split because the caller's earlier words were already published is
    one exchange. The call rollup, the exact count, the hourly sketch rollup and
    the session rail each count turns independently, so correcting one of them
    produced a console that contradicted itself: the overview said 2 and the
    call page said 1, with nothing on screen to say which was right.
    """
    ingest(client, "call-1", split_call_events())

    payload = summary(client)
    assert payload["overview"]["calls"]["turns"] == 1, (
        "LiveKit committed one message; the overview must agree"
    )
    assert payload["accuracy"]["exact"] is True
    # The exact path counts turn rows itself rather than reading the rollup, so
    # it is a genuinely independent second opinion on the same question.
    assert payload["coverage"]["turns_in_range"] == 1, (
        "the exact path reached a different number from the rollup"
    )
    listed = next(row for row in client.get("/v1/sessions").json()
                  if row["id"] == "call-1")
    assert listed["turn_count"] == 1

    # And the hourly sketch rollup, which serves every range too wide to count
    # exactly, is the third path that must not disagree.
    with main.connect() as db:
        aggregate.refresh_rollups(db)
        rolled = db.execute(
            "SELECT SUM(turns) AS turns FROM interval_rollups "
            "WHERE agent_id = ?", (aggregate.ALL_AGENTS,)).fetchone()["turns"]
    assert rolled == 1, "the hourly rollup still counted both halves"


def test_a_split_straddling_an_hour_is_still_one_exchange_measured_twice(client):
    """Turn counts live in the bucket the turn happened in, so the two halves of
    one exchange can land in different hours.

    The exchange must still be counted once and its doubled stage counted once
    across a range covering both, rather than the flag being lost with the
    bucket it was not in or counted again in the bucket it was.
    """
    ingest(client, "call-1", unanswered_split_events())
    with main.connect() as db:
        rows = db.execute(
            "SELECT turn_id, is_continuation, stt_split, started_at_epoch_ms "
            "FROM turn_metrics WHERE session_id = 'call-1' "
            "ORDER BY started_at_epoch_ms").fetchall()
        assert [r["is_continuation"] for r in rows] == [0, 1], (
            "guard: this test needs a first half and a continuation"
        )
        assert sum(r["stt_split"] or 0 for r in rows) == 1, (
            "guard: the split stage must have been recorded before it is moved"
        )
        # Push the continuation into the next hour, which is all that separates
        # a straddling split from an ordinary one.
        db.execute(
            "UPDATE turn_metrics SET started_at_epoch_ms = started_at_epoch_ms + ? "
            "WHERE session_id = 'call-1' AND is_continuation = 1",
            (aggregate.ROLLUP_BUCKET_MS,))
        db.execute("DELETE FROM interval_rollups")
        db.execute("DELETE FROM rollup_dirty")
        for row in db.execute(
                "SELECT DISTINCT started_at_epoch_ms / ? * ? AS bucket_ms "
                "FROM turn_metrics WHERE session_id = 'call-1'",
                (aggregate.ROLLUP_BUCKET_MS, aggregate.ROLLUP_BUCKET_MS)):
            for agent in (aggregate.ALL_AGENTS, ""):
                db.execute("INSERT OR IGNORE INTO rollup_dirty (bucket_ms, agent_id) "
                           "VALUES (?, ?)", (row["bucket_ms"], agent))
        db.commit()
        aggregate.refresh_rollups(db)
        buckets = db.execute(
            "SELECT COUNT(*) AS n, SUM(turns) AS turns, SUM(split_turns) AS splits, "
            "SUM(stt_split_turns) AS stt_splits FROM interval_rollups "
            "WHERE agent_id = ?", (aggregate.ALL_AGENTS,)).fetchone()

    assert buckets["n"] == 2, "guard: the halves did not end up in separate hours"
    assert buckets["turns"] == 1, (
        "one committed message became two exchanges once an hour boundary fell "
        "between its halves"
    )
    assert buckets["splits"] == 1
    assert buckets["stt_splits"] == 1, (
        "the doubled stage was either lost with the bucket it was not in or "
        "counted once per bucket"
    )

    with main.connect() as db:
        per_bucket = db.execute(
            "SELECT turns, split_turns, stt_split_turns FROM interval_rollups "
            "WHERE agent_id = ? ORDER BY bucket_ms", (aggregate.ALL_AGENTS,)
        ).fetchall()

    # An exchange belongs to the hour it started in, the same rule a call
    # spanning an hour already follows. The second hour still charts the
    # recogniser latency measured in it -- that is when the audio happened --
    # but it must not claim an exchange it is not counting.
    assert (per_bucket[0]["turns"], per_bucket[0]["split_turns"],
            per_bucket[0]["stt_split_turns"]) == (1, 1, 1)
    assert (per_bucket[1]["turns"], per_bucket[1]["split_turns"],
            per_bucket[1]["stt_split_turns"]) == (0, 0, 0), (
        "an hour holding only the second half reported no exchanges while also "
        "reporting that one of them carried more than one utterance"
    )


def test_a_stage_panel_explains_why_it_measured_more_than_there_are_turns(client):
    """Excluding a split half from the STT percentiles would throw away a real
    recogniser latency measured on real audio - and it is systematically the
    slow half, because it is the one that went final late. So both are kept and
    the panel states the population instead. What it must never do is show
    "2 measured" beside "1 turn in range" with nothing to reconcile them.
    """
    ingest(client, "call-1", unanswered_split_events())
    payload = summary(client)
    stt = payload["stages"]["stt"]["metrics"][0]["coverage"]

    assert stt["measured"] == 2, "a real STT measurement was discarded"
    assert payload["overview"]["calls"]["turns"] == 1
    assert stt["split_turns"] == 1, (
        "the panel measured more utterances than there are turns and said nothing"
    )
    assert "utterance" in stt["population"]



def test_a_call_with_no_split_does_not_carry_the_utterance_caveat(client):
    """The caveat has to be rare to be read. If every panel carried it, readers
    would learn to skip it well before the day it changes their conclusion."""
    ingest(client, "call-1", call_events(turns=2))

    coverage = summary(client)["stages"]["stt"]["metrics"][0]["coverage"]

    assert coverage["split_turns"] == 0
    assert "utterance" not in coverage["population"]


def test_the_volume_chart_counts_the_same_turns_the_kpi_above_it_counts(client):
    """A KPI and the chart beneath it are read as one statement.

    Both the headline number and the volume bars claim to count turns, and they
    are computed by different code over the same rows. When only the KPI learned
    to exclude continuations, one screen said "1 turn" above a bar of height 2 --
    the console disagreeing with itself, which is worse than either number being
    wrong on its own, because it gives a reader no way to decide what to trust.
    """
    ingest(client, "call-1", unanswered_split_events())

    payload = summary(client)
    charted = sum(bucket["turns"] for bucket in payload["timeseries"])

    assert payload["overview"]["calls"]["turns"] == 1
    assert charted == 1, (
        f"the KPI counts 1 exchange and the chart counts {charted}"
    )
    # The measurement itself is untouched: it is real recogniser latency on real
    # audio, and dropping it to make two numbers agree would be the wrong fix.
    assert payload["stages"]["stt"]["metrics"][0]["coverage"]["measured"] == 2


def test_only_the_stage_that_ran_twice_carries_the_utterance_caveat(client):
    """The caveat explains a specific contradiction, so it belongs only where
    that contradiction exists.

    A split's first half is unanswered by construction: it carries speech-to-text
    and nothing else. The language model, speech synthesis and tools all ran once,
    on the answer. Stamping the range-wide split count onto every panel produced
    a language-model card reading "1 of 1" while announcing that it was counting
    recognised utterances -- a caveat that was not true of that panel, attached to
    numbers that needed no explaining.
    """
    ingest(client, "call-1", unanswered_split_events())

    stages = summary(client)["stages"]

    stt = stages["stt"]["metrics"][0]["coverage"]
    assert stt["split_turns"] == 1 and "utterance" in stt["population"], (
        "speech-to-text really did measure two utterances across one turn"
    )
    for stage in ("llm", "tts", "tool"):
        coverage = stages[stage]["metrics"][0]["coverage"]
        assert coverage["split_turns"] == 0, (
            f"{stage} ran once; it has no split to disclose"
        )
        assert "utterance" not in coverage["population"], (
            f"{stage} population reads as utterances: {coverage['population']!r}"
        )


def test_a_greeting_elsewhere_cannot_hide_a_stage_that_was_measured_twice(client):
    """The caveat used to be inferred by pigeonhole, which cannot detect.

    Asking whether a stage measured more populations than the range has turns
    proves a double count but never rules one out. One split speech-to-text
    exchange contributes two speech-to-text rows and one turn; a single
    reply-only turn anywhere else in the range adds a turn without adding a
    speech-to-text row, and the totals sit level at two and two. The caveat
    vanished and the panel published "2 turns that used speech to text, 100%
    covered" for one exchange that was measured twice -- a green number with
    the explanation removed, which is the failure this product exists to stop.

    Which stages a split doubled is now carried from ingest, where both halves
    were in hand, so an unrelated turn cannot cancel it out.
    """
    ingest(client, "call-1", unanswered_split_events())
    ingest(client, "call-2", reply_only_events())

    payload = summary(client)
    assert payload["accuracy"]["exact"] is True
    assert payload["coverage"]["turns_in_range"] == 2, (
        "guard: the boundary needs the split exchange plus one other turn"
    )
    stt = payload["stages"]["stt"]["metrics"][0]["coverage"]
    assert stt["eligible"] == 2, (
        "guard: speech-to-text must still be measured on both halves here"
    )
    assert stt["split_turns"] == 1 and "utterance" in stt["population"], (
        f"the double count was published without its caveat: {stt}"
    )
    for stage in ("llm", "tts", "tool"):
        coverage = payload["stages"][stage]["metrics"][0]["coverage"]
        assert coverage["split_turns"] == 0, (
            f"{stage} ran once per exchange; it has no split to disclose"
        )


def reply_only_events(session_id: str = "call-2") -> bytes:
    """A turn that replies without a recognised utterance, e.g. a greeting."""
    return jsonl(*[
        payload for payload in
        (json.loads(line) for line in
         call_events(turns=1, session_id=session_id).decode().splitlines())
        if payload.get("type") != "stt"
    ])


def test_a_split_turn_does_not_push_a_range_over_the_exact_limit(client, monkeypatch):
    """The size estimate that chooses exact-vs-approximate must measure the same
    turns the answer will report. If it counts a split exchange twice it will
    hand a user approximate percentiles - or refuse their filter outright - for
    a workload that was always small enough to answer exactly."""
    ingest(client, "call-1", split_call_events())
    monkeypatch.setattr(aggregate, "EXACT_TURN_LIMIT", 1)

    payload = summary(client, provider="openai")

    assert payload["accuracy"]["refused"] is None, (
        "a one-turn call was refused as if it were two"
    )
    assert payload["coverage"]["turns_in_range"] == 1


def test_every_schema_column_added_since_release_has_a_migration(client):
    """The specific columns are less important than the class of mistake.

    `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
    table, so a column added to the schema string reaches new installs and never
    reaches existing ones. Nothing fails until the first write - and a
    METRICS_VERSION bump forces a full rebuild on exactly the upgrades where
    that write happens with the console already serving traffic.

    So this compares a database built from the schema as it *shipped*, then
    upgraded, against a database built fresh. Any future column added without a
    matching `ADDED_COLUMNS` entry fails here rather than in production.
    """
    import pathlib
    import sqlite3

    shipped = (pathlib.Path(__file__).parent / "fixtures" / "shipped_schema.sql").read_text()

    upgraded = sqlite3.connect(":memory:")
    upgraded.row_factory = sqlite3.Row
    upgraded.executescript(shipped)
    aggregate.ensure_schema(upgraded)

    fresh = sqlite3.connect(":memory:")
    fresh.row_factory = sqlite3.Row
    aggregate.ensure_schema(fresh)

    def columns(db):
        return {row["name"]: {c["name"] for c in db.execute(f"PRAGMA table_info({row['name']})")}
                for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}

    want, got = columns(fresh), columns(upgraded)
    missing = {table: sorted(cols - got.get(table, set()))
               for table, cols in want.items() if cols - got.get(table, set())}
    assert not missing, (
        f"added to the schema string but not to ADDED_COLUMNS: {missing}. "
        "An existing install would crash on the next rebuild."
    )


def test_an_existing_database_gains_the_split_columns_instead_of_crashing(client):
    """Every column added to the schema string has to be added to the migration
    list too. `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already
    has the table, so an upgrade keeps the old definition - and the rebuild that
    a METRICS_VERSION bump forces on every upgrade then dies on the first write,
    with the console already serving traffic.
    """
    import sqlite3

    with main.connect() as db:
        for table, column in (("turn_metrics", "is_continuation"),
                              ("interval_rollups", "split_turns")):
            db.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        db.commit()
        with pytest.raises(sqlite3.OperationalError):
            db.execute("SELECT is_continuation FROM turn_metrics")

        aggregate.ensure_schema(db)
        db.execute("SELECT is_continuation FROM turn_metrics").fetchall()
        db.execute("SELECT split_turns FROM interval_rollups").fetchall()

    # And the upgraded database still answers, rather than merely not throwing.
    ingest(client, "call-1", split_call_events())
    assert summary(client)["overview"]["calls"]["turns"] == 1


def test_opening_a_call_does_not_change_the_turn_count_the_list_showed(client):
    """The two screens must not disagree about the same call.

    One LiveKit message committed as two turn rows is one exchange, and the
    session list counts it that way. The call view builds its headline from the
    detail payload, so that payload has to keep saying which rows continue
    another -- otherwise the only honest count available to the UI is the row
    count, and opening a one-turn call silently shows two.
    """
    ingest(client, "call-1", split_call_events())

    rail = next(row for row in client.get("/v1/sessions").json()
                if row["id"] == "call-1")
    turns = client.get("/v1/sessions/call-1").json()["turns"]

    assert len(turns) == 2, "both physical rows stay, because the inspector needs them"
    continuations = [t for t in turns if t.get("continues_turn")]
    assert len(continuations) == 1, (
        "the detail payload must mark the continuing row; app.js counts "
        "exchanges with exactly this field"
    )
    assert len(turns) - len(continuations) == rail["turn_count"], (
        "the count the call view derives has to match the one the list showed"
    )


def test_every_counter_agrees_about_a_call_whose_first_half_is_missing(client):
    """Four independent counters, one rule -- proven through ingest, not in one function.

    The present-parent rule first landed in `call_metrics` and `app.js` only.
    The rail, the exact range count, the overview and the hourly rollup each
    derive their own count from the stored `is_continuation` column, so they
    kept subtracting the orphan and an adopter could open a call listed as zero
    turns, read one turn in its headline, and see zero again in range. Four
    trusted numbers disagreeing is worse than the single wrong one it replaced,
    so the rule now lives at ingest where every counter inherits it.
    """
    events = [
        payload for payload in
        (json.loads(line) for line in unanswered_split_events().decode().splitlines())
        if payload.get("turn_id") == "turn-2"
    ]
    assert events, "guard: the fixture must still contain the continuing row"
    ingest(client, "call-1", jsonl(*events))

    rail = next(row for row in client.get("/v1/sessions").json()
                if row["id"] == "call-1")
    detail = client.get("/v1/sessions/call-1").json()["turns"]
    overview = summary(client)

    counts = {
        "rail": rail["turn_count"],
        "call rollup": metrics.call_metrics(
            [metrics.turn_metrics(turn, 0) for turn in detail])["turn_count"],
        "overview": overview["overview"]["calls"]["turns"],
        "exact range": overview["coverage"]["turns_in_range"],
    }
    assert set(counts.values()) == {1}, (
        f"every counter must see the surviving row as one turn: {counts}"
    )


def test_a_call_whose_first_half_is_missing_still_reports_a_turn():
    """A continuation only folds into a row we actually have.

    Subtracting every continuation unconditionally assumed the first half is
    always present. It is not: a package can lose a span, and any future view
    that shows a slice of a call breaks the same assumption. The survivor is
    then the only evidence that exchange happened, so discarding it reported
    `turn_count: 0` for a call that plainly had a turn -- which also hid the
    call from the unmeasured-call check, because that keys off `turn_count > 0`.

    app.js applies the same present-parent rule, so this pins the two together.
    """
    from app import metrics

    orphan = metrics.call_metrics([
        _blank_turn_row("turn-2", continues_turn="turn-1"),
    ])
    assert orphan["turn_count"] == 1, (
        "a row whose parent is absent is the only record of that exchange"
    )
    assert orphan["split_turn_count"] == 0, (
        "nothing was folded, so nothing should be reported as folded"
    )

    paired = metrics.call_metrics([
        _blank_turn_row("turn-1"),
        _blank_turn_row("turn-2", continues_turn="turn-1"),
    ])
    assert paired["turn_count"] == 1, "a real split is still one exchange"
    assert paired["split_turn_count"] == 1


def _blank_turn_row(turn_id, continues_turn=None):
    """A real turn_metrics row, so this test cannot drift from the producer."""
    from app import metrics

    return metrics.turn_metrics(
        {"turn_id": turn_id, "continues_turn": continues_turn,
         "started_at_ms": 0, "duration_ms": 0, "operations": []},
        0,
    )
