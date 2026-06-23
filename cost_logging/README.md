# Vera cost logging (local, API-only)

Local-only telemetry for **provider** cost: OpenAI, Fish/BMO TTS, and Serper.
RunPod / server hosting cost is **not** included here.

## Files

```
cost_logging/
  pricing.py                  # central pricing config (defaults)
  pricing.json                # auto-created on first run; EDIT freely
  credits.py                  # credit-action classifier + config loader
  credit_config.json          # auto-created on first run; EDIT freely
  logger.py                   # request/session/event recording
  openai_instrumentation.py   # auto-captures OpenAI usage
  report.py                   # CLI: aggregated cost report
logs/
  cost_events.jsonl           # one paid provider call per line
  request_cost_summary.jsonl  # one user-facing request per line
  session_cost_summary.jsonl  # one row per explicitly ended session
```

The pricing file location can be overridden with `COST_PRICING_FILE=/abs/path`.
The log directory can be overridden with `COST_LOG_DIR=/abs/path`.

## Editing prices

Open `cost_logging/pricing.json` and change any number. Unknown prices can be
left as `null` — the logger will still record raw usage and report
`estimated_cost_usd: null` for that field instead of crashing.

```jsonc
{
  "openai": {
    "gpt-4o-mini": {
      "input_per_1m_tokens":         0.15,
      "cached_input_per_1m_tokens":  0.075,
      "output_per_1m_tokens":        0.60,
      "reasoning_per_1m_tokens":     null
    }
  },
  "fish_audio": {
    // Fish Audio HTTP TTS API: billed strictly per UTF-8 byte of the
    // text submitted. Web-playground "credits" / free-tier knobs are
    // intentionally not modeled. Override per model_name (s1, s2-pro).
    "default": {
      "billing_unit":            "utf8_byte",
      "cost_per_1m_utf8_bytes":   15.0,
      "cost_per_utf8_byte":       0.000015,
      "cost_per_1000_utf8_bytes": 0.015
    },
    "s1": {
      "billing_unit":            "utf8_byte",
      "cost_per_1m_utf8_bytes":   15.0,
      "cost_per_utf8_byte":       0.000015,
      "cost_per_1000_utf8_bytes": 0.015
    },
    "s2-pro": {
      "billing_unit":            "utf8_byte",
      "cost_per_1m_utf8_bytes":   15.0,
      "cost_per_utf8_byte":       0.000015,
      "cost_per_1000_utf8_bytes": 0.015
    }
  },
  "serper": {
    "default": { "cost_per_search_call": 0.001 }
  }
}
```

## Credit metering (measurement-only)

In addition to the dollar-cost estimate, every `request_cost_summary` row now
carries a `credit_action`, `credits_used`, and `credit_reason`. Every
`session_cost_summary` row carries `total_credits_used` and
`credits_by_action`. **No request is ever blocked or rate-limited by this —
it is measurement only.** Credit values come from `credit_config.json`:

```jsonc
{
  "state_sync":                 0,
  "local_command":              0,
  "failed_request":             0,
  "simple_llm_command":         1,
  "normal_chat_short":          2,
  "normal_chat_long":           4,
  "checklist_generation":       3,
  "checklist_edit_local":       0,
  "checklist_edit_llm":         1,
  "work_mode_reasoning_short":  5,
  "work_mode_reasoning_long":  10,
  "serper_search_bundle":       3,
  "image_file_reasoning":      15,
  "bmo_tts":                    0
}
```

The classifier (`cost_logging/credits.py::classify_credit_action`) inspects
`mode`, `request_type`, the HTTP path captured in `extra.http_path`, the
provider event list, and the success flag. Edit the integers in
`credit_config.json` and they take effect the next time the module reloads
(or call `reload_credit_config()` from Python).

Thresholds in `credits.py` you can tune without touching call sites:

| Constant | Default | What it controls |
|---|---|---|
| `SIMPLE_LLM_OUTPUT_TOKEN_MAX` | 80 | Command-style turn at/below this output → `simple_llm_command` |
| `NORMAL_CHAT_LONG_OUTPUT_TOKEN_MIN` | 600 | Plain chat at/above this output → `normal_chat_long` |
| `REASONING_LONG_TOKEN_MIN` | 2000 | Work-mode reasoning at/above (output+reasoning) → `work_mode_reasoning_long` |

## Session finalization flow

`session_cost_summary.jsonl` is only written on **explicit** session end.
Browser tab close, mobile app background, network drops, and `Ctrl+C` all do
NOT count — the canonical path is a `POST /cost/session/end` call from the
client (or `end_session(...)` from Python).

**Per-request rows are still real-time:** every `/infer` and `/text` writes a
`request_cost_summary.jsonl` row as soon as the request finishes (including
its streaming TTS body). So per-request cost is always available without
ending the session — the explicit end is just what produces the rolled-up
per-session row.

### HTTP endpoints

| Endpoint | Use it for |
|---|---|
| `POST /cost/session/start` `{session_id, scenario_name}` | (Optional) tag a session with a scenario label up front |
| `GET  /cost/session/live?session_id=...` | Inspect totals at any time **without** finalizing |
| `POST /cost/session/end` `{session_id, scenario_name?}` | Finalize: append one row to `session_cost_summary.jsonl` |
| `GET  /cost/report` (optional `?session=` / `?since=` filters) | Full aggregated report across all sessions on disk |
| `GET  /cost/logs/status` | Active log paths, row counts, sizes, earliest/latest timestamps |
| `POST /cost/logs/archive` | Move active JSONL files to `logs/archive/<timestamp>/`, recreate empty logs |
| `POST /cost/logs/reset` | Truncate active logs (dev only — see below) |

`/cost/scenario/{start,end}` are kept as aliases for the original names so
older scripts keep working.

### Clean test runs (archive / reset)

**Prefer archive over reset.** Archive preserves old data under
`logs/archive/2026-05-22_04-30-00/` (local timestamp) and recreates empty
active files. Cost logging stays enabled; nothing runs automatically on
startup.

```bash
# Inspect current logs
curl http://localhost:PORT/cost/logs/status

# Archive + start fresh (safe — old files moved, not deleted)
curl -X POST http://localhost:PORT/cost/logs/archive

# Hard reset (development only)
export ENVIRONMENT=development
# or: export COST_LOG_ALLOW_RESET=true
curl -X POST http://localhost:PORT/cost/logs/reset
```

In the Vera UI settings panel, **Cost logging (dev)** appears on localhost
(or with `?costdebug=1`). Use **Archive logs and start clean test** to archive
and optionally tag the session with a scenario label.

### Scenario labels

`POST /cost/session/start` accepts any `scenario_name` string. Recommended
labels for pricing/credit experiments:

- `light_session`
- `normal_work_mode_session`
- `heavy_reasoning_session`
- `search_heavy_session`
- `voice_heavy_session`
- `file_upload_session`
- `image_upload_session`

Once set, `scenario_name` is attached to every provider event, request
summary, and session summary for that `session_id` (including rows written
after archive when you re-tag via session start).

**Example HTTP flow:**

```bash
# 1. (optional) tag the run
curl -X POST http://localhost:PORT/cost/session/start \
  -H "Content-Type: application/json" \
  -d '{"session_id":"<your session id>", "scenario_name":"heavy_study_session"}'

# 2. use Vera normally (each /infer or /text writes a request row immediately)

# 3. peek totals while still active — does NOT finalize
curl "http://localhost:PORT/cost/session/live?session_id=<your session id>"

# 4. finalize — appends to logs/session_cost_summary.jsonl
curl -X POST http://localhost:PORT/cost/session/end \
  -H "Content-Type: application/json" \
  -d '{"session_id":"<your session id>", "scenario_name":"heavy_study_session"}'
```

`end_session` works even when `start_session` was never called: it
reconstructs the per-session totals from `request_cost_summary.jsonl` on
disk. The written row's `source` field tells you which path was used:
`in_memory_state`, `reconstructed_from_jsonl`, or
`in_memory_state_no_jsonl_yet`.

### Python (scripted simulations)

```python
from cost_logging import begin_session, end_session, compute_live_session_totals

begin_session("sim-001", scenario_name="voice_heavy_session")
# … drive Vera ...
print(compute_live_session_totals("sim-001"))   # live, no write
end_session("sim-001")                          # writes the session row
```

### Backup: shutdown flush

The server registers a FastAPI `shutdown` handler that, on graceful
`Ctrl+C`/`SIGTERM`, calls `end_session` for every session that still has
in-memory state. This is a **best-effort backup** — if uvicorn is killed
forcefully (`kill -9`) the flush won't run. Always prefer the explicit
`POST /cost/session/end` call from the client.

## Running the report

```bash
py -m cost_logging.report                              # full report
py -m cost_logging.report --json                       # raw JSON
py -m cost_logging.report --session <session_id>       # focus one session
py -m cost_logging.report --since 2026-05-21T00:00:00Z # drop earlier rows
py -m cost_logging.report --logs /alt/logs/path
```

What it prints:

* total API-only cost across all logged sessions
* total cost by provider
* total cost by request_type
* average cost per request_type
* highest-cost request (anywhere)
* per-session breakdown (requests, total, avg/request, per-provider)

## Mode taxonomy

`request_type` is set by the request handler. The supported values are:

```
work_mode, nonwork_mode, command, voice, file_image, checklist,
reasoning, bmo_tts, serper_search
```

`mode` mirrors whether Work Mode was on; `request_type` is the workload class.

## Safety guarantees

* Logging never re-raises into Vera. If pricing math fails or a disk write
  fails the error is printed and the original request continues.
* If a provider response has no usage block, the row is still written with
  `estimated_cost_usd: null` so you can audit what calls happened.
* User content is **not** logged. Only metadata + token counts + provider
  raw usage are written. The Serper row includes a 140-char `query_preview`
  for traceability; remove that field if you want zero query text on disk.
* Files are append-only JSONL.
