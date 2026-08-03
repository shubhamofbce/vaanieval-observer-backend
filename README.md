# vaanieval-observer-backend

FastAPI backend for the Vaani Observer voice-call observability platform. It ingests
session metadata, audio tracks and event streams uploaded by the
[`vaanieval-observer-nodejs-sdk`](https://github.com/shubhamofbce/vaanieval-observer-nodejs-sdk),
persists them locally, and serves a small dashboard for inspecting recorded calls.

## Requirements

- Python 3.11+

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-dev.txt   # for tests
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

The dashboard is served at `http://localhost:8000/`.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `POST` | `/v1/sessions` | Create a session |
| `PUT` | `/v1/uploads/{session_id}/{object_name}` | Upload an audio/event object |
| `POST` | `/v1/sessions/{session_id}/complete` | Mark a session complete |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/{session_id}` | Session detail |
| `GET` | `/v1/sessions/{session_id}/audio/{track}` | Stream an audio track |

## Tests

```bash
pytest
```

## Storage

Runtime state lives in `data/` (SQLite database plus uploaded objects). That
directory is gitignored and created on first run.

## License

MIT
