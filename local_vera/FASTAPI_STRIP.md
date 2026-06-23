# Phased plan: WebVERA → local Electron without FastAPI

Working copies of the server and client live here as **`app.py`** and **`app.js`**. Edit these for local-only refactors; sync from `../app.py` and `../app.js` when you need a fresh baseline.

**Constraint:** Keep `../app.py` and `../app.js` stable for WebVERA until you deliberately merge changes.

---

## What the browser talks to today

| HTTP | Role |
|------|------|
| `POST /infer` | Voice + NDJSON streaming TTS (main path) |
| `POST /text` | Typed text + same streaming behavior |
| `GET /status` | Session / server status |
| `GET /audio/{session_id}/{date}/{filename}` | TTS file playback URLs returned inside NDJSON |
| `POST /feedback` | User feedback upload |
| `GET /health`, `/health/*`, `/metrics` | Ops / Electron readiness (optional for local-only) |

Other routes (`/command`, `/thinking_allowed`, etc.) exist in `app.py`; confirm with `grep ^@app` if you trim dead code.

---

## Phase 1 — Thin the HTTP layer (still FastAPI)

Goal: **Route handlers become one-liners** that call plain async functions in a new module (e.g. `vera_engine.py` next to `app.py`, or `local_vera/vera_engine.py` while experimenting).

- Move Pydantic models, session dicts, locks, and the bodies of `infer` / `text_input` / `feedback` into **`async def run_infer(...)`**-style functions that return the same structures you already stream (`StreamingResponse` can wrap an `AsyncIterator` built in the engine).
- Keep **file paths for TTS** and **NDJSON framing** in one place so later you can swap HTTP for IPC without rewriting the LLM/TTS pipeline.
- **Do not** change `app.js` yet.

Success: `app.py` imports `vera_engine`; routes only parse request → call engine → map to `StreamingResponse` / JSON.

---

## Phase 2 — One transport, two backends (bridge)

Goal: **Same engine**, callable from HTTP *or* from a non-HTTP channel.

Pick one bridge (both are common):

1. **Loopback HTTP** — Electron spawns Python with uvicorn only on `127.0.0.1` (what you have today). Minimal change; you can delete CORS and most routes when IPC is ready.
2. **stdio or Unix socket** — Python reads NDJSON lines from stdin / socket; replies with NDJSON. Electron `spawn` + `child.stdin/stdout` or a small Node net client.

Implement **one adapter** that turns “infer request dict” → engine → “same NDJSON bytes you send today.”

Success: a tiny script (no FastAPI) can run `run_infer` and print NDJSON to stdout for a fixture request.

---

## Phase 3 — Electron owns the UI shell

Goal: **No browser `fetch` to Python** for core chat.

- Serve UI with `loadFile` / `file://` or `loadURL` to static assets; **or** keep a micro static server if you must.
- Replace `fetch(\`${API_URL}/infer\`)` with `ipcRenderer.invoke('infer', payload)` and in `main.js` forward to the Python child (stdio or loopback).
- **`API_URL` in `app.js`:** introduce something like `const API = window.veraIpc ?? httpApi` so one codebase can still target Workers in production and IPC locally.

Success: local build works with FastAPI removed; WebVERA still uses the parent `app.js` + Workers until you merge the IPC abstraction.

---

## Phase 4 — Delete FastAPI

- Remove `FastAPI()`, `CORSMiddleware`, `StaticFiles` mounts from the local copy once Electron serves assets and IPC carries API traffic.
- Keep **one** long-lived Python process (model load is expensive).

---

## Practical order of operations

1. Grep `app.py` for `async def infer` / `text_input` and list every dependency (globals, `vera`, file paths).
2. Extract **read-only** helpers first (formatting, NDJSON lines).
3. Extract **streaming** second (`AsyncIterator` of NDJSON chunks).
4. Add **integration tests** or a CLI that calls the engine without HTTP.
5. Wire IPC and only then delete routes.

---

## Path gotcha (local `app.py` copy)

The repo `app.py` uses paths relative to **process current working directory** (`static/`, audio output dirs). When you run from `local_vera/` only, mounts may break. Prefer **`os.chdir` to repo root** in your launcher (as in earlier `launcher.py` designs) or replace string paths with `Path(__file__).resolve().parent.parent / "static"` in the forked file when you start stripping.
