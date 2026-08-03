"""Shared fixtures. Every test runs against an isolated data directory and database."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setattr(main, "OBJECTS", tmp_path / "objects")
    monkeypatch.setattr(main, "DATABASE", tmp_path / "vaani.db")
    main.initialize()
    return tmp_path


@pytest.fixture
def client(data_dir) -> TestClient:
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture
def api():
    return main


def manifest(session_id: str = "call-1", **overrides) -> dict:
    payload = {
        "schema_version": "1.0",
        "sdk": {"name": "@vaanieal/observer", "language": "nodejs", "version": "0.1.0"},
        "session_id": session_id,
        "agent_id": "support",
        "metadata": {"env": "test"},
        "started_at": "2026-01-01T00:00:00+00:00",
        "duration_ms": 4200,
        "outcome": "completed",
        "capture_status": {"events_complete": True},
        "audio": {},
    }
    payload.update(overrides)
    return payload


def object_info(payload: bytes) -> dict:
    return {"byte_size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}


def operation(
    session_id: str = "call-1",
    event_id: str = "op-1",
    type_: str = "llm",
    started_at_ms: int = 0,
    **extra,
) -> dict:
    event = {
        "event_id": event_id,
        "session_id": session_id,
        "turn_id": None,
        "type": type_,
        "endpoint_id": "llm",
        "transport": "http",
        "started_at_ms": started_at_ms,
        "ended_at_ms": started_at_ms + 10,
        "duration_ms": 10,
        "status": "ok",
        "milestones": {},
        "request": {},
        "response": {},
        "error": None,
    }
    event.update(extra)
    return event


def jsonl(*events: dict) -> bytes:
    return ("\n".join(json.dumps(event) for event in events) + "\n").encode("utf-8")


def create(client, session_id: str = "call-1", **overrides):
    return client.post("/v1/sessions", json=manifest(session_id, **overrides))


def upload(client, session_id: str, name: str, payload: bytes):
    return client.put(f"/v1/uploads/{session_id}/{name}", content=payload)
