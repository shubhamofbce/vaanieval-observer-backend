# vaanieval-observer-backend

FastAPI ingestion service, browser console and **STT evaluation engine** for the
Vaani Observer voice-call observability platform.

It ingests the session packages (`manifest.json`, `events.jsonl`, `call.audio`)
uploaded by either capture SDK — the
[Node.js SDK](https://github.com/shubhamofbce/vaanieval-observer-nodejs-sdk) or
the [Python SDK](https://github.com/shubhamofbce/vaanieval-observer-python-sdk),
which emit a byte-compatible format — persists them locally, and answers two
questions about a completed call:

1. **Where did production STT disagree with a stronger challenger transcript,
   and should I listen to the audio?**
2. **Did the production model detect and finalize caller turns quickly and
   reliably enough for a live agent?**

It is normally checked out as `dashboard/` next to `nodejs-sdk/` and
`python-sdk/` in a `vaanieval-observer` working directory.

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

The console is served at `http://localhost:8000/` and the per-call STT
evaluation workspace at `/stt-evaluation?session=<id>`.

There is **no authentication** and no tenant isolation: this is a development
tool. Point an SDK at it with `endpoint: 'http://localhost:8000'` and any
non-empty API key — the local service intentionally does not validate it.

## What it does

**Console** — a calls rail, a trace view, an all-spans table, an audio player
with server-rendered waveform peaks, and a transcript panel that follows
playback. Audio is stored once as the SDK's raw PCM; the console requests an
on-demand WAV wrapper for browser playback rather than storing a second copy.
The wrapper streams and honours HTTP `Range`, which Safari requires before it
will play any media response.

**STT evaluation (Stage 1)** — a manual, post-call comparison of one recorded
call against one challenger model:

| Module | Responsibility |
| --- | --- |
| `app/evaluation.py` | Pure deterministic scoring: normalization, word alignment, estimated WER, S/D/I counts, word-to-turn mapping. No clock, no provider, no global state — every displayed value can be recomputed from the stored call. |
| `app/latency.py` | Turn detection and latency: first partial, endpoint delay, final-from-last-word, endpoint position error, barge-in, forced flushes, splits/merges/missing finals. |
| `app/challenger.py` | Batch and streaming challenger runs against the recorded caller track. |
| `app/risk.py` | LLM judge that classifies whether a transcript disagreement could change the conversation. Cached by content fingerprint. |
| `app/pricing.py` | Per-minute list pricing with provenance, batch→streaming substitution for switch decisions, monthly savings estimate. |
| `app/payload.py` | Assembles the single evaluation payload the UI reads, including the same-agent cohort. |

Three interpretation rules are enforced throughout:

- The challenger is a **pseudo-reference, not ground truth**. The score is
  labelled *estimated WER* / *model disagreement*, never accuracy.
- **Unavailable is shown as `—` with a reason** — never `0`, and never inferred
  from an operation's start/end time or a batch HTTP round trip.
- **A session-long STT websocket is a connection span, not an utterance**, and
  is never scored as a turn.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `POST` | `/v1/sessions` | Create a session from a manifest |
| `PUT` | `/v1/uploads/{session_id}/{object_name}` | Upload `events.jsonl`, `call.audio`, `caller.audio` or `agent.audio` |
| `POST` | `/v1/sessions/{session_id}/complete` | Mark a session complete with byte sizes and digests |
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/{session_id}` | Session detail |
| `GET` | `/v1/sessions/{session_id}/audio/{track}` | Stream an audio track; `?preview=wav` wraps raw PCM, `&from_ms=&to_ms=` cuts a clip |
| `GET` | `/v1/sessions/{session_id}/audio/{track}/peaks` | Waveform envelope for the player, one peak per pixel column |
| `GET` | `/v1/sessions/{session_id}/stt-evaluation` | Every measured production and challenger value for the call |
| `GET`/`POST` | `/v1/sessions/{session_id}/challenger-evaluation` | Poll / queue a challenger run (executed off the request thread, status tracked in SQLite) |
| `GET`/`PUT` | `/v1/pricing` | Read or override the cost model |

## Configuration

| Variable | Purpose |
| --- | --- |
| `VAANI_DATA_DIR` | Runtime data directory (default `./data`) |
| `ELEVENLABS_API_KEY` | Challenger transcription; required to run an evaluation |
| `OPENAI_API_KEY` | Semantic risk judge |
| `STT_EVAL_JUDGE_MODEL` | Judge model (default `gpt-4o-mini`) |
| `VAANI_ENV_FILE` | `os.pathsep`-separated dotenv paths to read keys from when they are not exported. Falls back to `./.env`, which is gitignored. |

Never commit provider keys. `.env` and `data/` are both gitignored.

## Tests

```bash
pytest
```

Tests run against a temporary data directory and SQLite file per test, so they
never touch `data/`.

`scripts/validate-latency.py` is a deliberate **second implementation**: it
re-derives every published latency value straight from `events.jsonl` using its
own arithmetic and asserts the payload agrees. It is wired into the suite, so a
change that reintroduces a fabricated measurement fails the build. It needs
recorded calls in `data/`, so that test skips on a clean checkout.

## Storage

Runtime state lives in `data/` (SQLite database plus uploaded objects). That
directory is gitignored and created on first run — recorded calls contain
customer audio and transcripts and are never committed.

## Scaling implications

Deliberate limits, stated so they are not mistaken for production readiness:

- **SQLite plus local files, single-process uploads capped at 128 MiB.** Fine for
  one machine and a developer loop; production needs object storage, Postgres
  and async audio processing.
- **No authentication and no multi-tenant isolation.** Do not expose this.
- **Audio dominates storage.** Two raw 16-bit PCM tracks are ~64 KB/s of call at
  16 kHz. Production needs retention policies and, realistically, Opus.
- **Challenger jobs run on a two-worker in-process thread pool**, bounded by that
  pool and by provider rate limits. A real deployment wants a separate queue.
- **Evaluation costs money per run** — challenger transcription and the judge
  both bill per call. Cost figures are published list prices with provenance,
  not invoices.
- **WER here is a disagreement score, not accuracy**, until a human-reviewed
  reference transcript exists.

## License

MIT
