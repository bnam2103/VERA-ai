# VERA Cleanup & Stabilization Report

**Date:** 2026-05-27
**Scope:** Inventory + low-risk dev/smoke cleanup only.
**Rule:** No changes to runtime behavior, ASR/TTS routing, Work Mode, UI, or fallbacks.

---

## 1. Top 20 largest source files

(media files like `*.mp4`, `*.mp3`, `*.wav`, `*.png`, `*.jpg` excluded)

|     Bytes  | Path                                  |
| ---------: | ------------------------------------- |
|  1,232,851 | `app.js` (after this pass)            |
|    742,078 | `app.py` (after this pass)            |
|    171,668 | `styles.css`                          |
|    107,209 | `index.html`                          |
|     76,165 | `actions/checklist.py`                |
|     54,765 | `bmo-emotions-test.html`              |
|     49,476 | `CHAT_REASONING.py`                   |
|     34,775 | `actions/finance.py`                  |
|     34,470 | `CHAT3.py`                            |
|     29,330 | `TTS.py`                              |
|     27,934 | `CHAT2.py`                            |
|     24,882 | `actions/news.py`                     |
|     23,625 | `CHAT_REASONING_DEEP.py`              |
|     20,287 | `.vera_spotify_bearers.json` (state)  |
|     18,961 | `actions/work_mode_reasoning.py`      |
|     18,834 | `actions/music.py`                    |
|     17,883 | `actions/spotify_search.py`           |
|     13,296 | `actions/check_time.py`               |
|     10,476 | `LLM.py` (legacy)                     |
|      9,874 | `LLM.py` size after header (~same)    |

The two outliers — `app.js` (~1.2 MB) and `app.py` (~720 KB) — are the
correct first targets for the eventual modularization in §6.

---

## 2. Smoke / test / debug files at repo root (BEFORE cleanup)

All of these were sitting directly next to `app.py` / `index.html`.
None of them were referenced by the runtime; they were leftover smoke
runners and standalone test pages from previous spec passes.

| File                                                | Kind                              | Action taken                                  |
| --------------------------------------------------- | --------------------------------- | --------------------------------------------- |
| `__asr_mode_smoke.mjs`                              | Node smoke test                   | Moved → `tests/smoke/`                        |
| `__asr_mode_smoke.py`                               | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__multi_device_concurrency_smoke.py`               | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__music_volume_dedupe_smoke.mjs`                   | Node smoke test                   | Moved → `tests/smoke/`                        |
| `__news_current_fact_routing_smoke.py`              | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__news_intent_router_smoke.py`                     | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__news_panel_routing_smoke.py`                     | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__news_routing_polish_smoke.py`                    | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__news_vague_followup_smoke.py`                    | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__reasoning_close_confirmation_ui_smoke.mjs`       | Node smoke test                   | Moved → `tests/smoke/`                        |
| `__reasoning_close_polish_smoke.mjs`                | Node smoke test                   | Moved → `tests/smoke/`                        |
| `__reasoning_close_smoke.py`                        | Python smoke test                 | Moved → `tests/smoke/`                        |
| `__reasoning_close_voice_lifecycle_smoke.mjs`       | Node smoke test                   | Moved → `tests/smoke/`                        |
| `convo_tester.py`                                   | Stand-alone CLI REPL on `LLM.py`  | Moved → `debug/`                              |
| `bmo-emotions-test.html`                            | Stand-alone HTML reference        | **Left in place** — referenced from `index.html` "Implementation notes" panel as a code path string. Marked as debug in §3. |
| `static/searching.js`                               | Prototype: side-panel mock search | Moved → `debug/static-search-prototype/`      |
| `static/test-search.html`                           | Test harness for `searching.js`   | Moved → `debug/static-search-prototype/`      |

Python smoke files had a `sys.path` bootstrap added so `import app`
still resolves from the new location; both `.mjs` files that used
`path.join(__dirname, "app.js")` were updated to climb two levels up.
The other three `.mjs` smoke files use `process.cwd()` and continue to
work unchanged when run from the repo root.

---

## 3. Files imported by the production runtime

These are the modules the live server actually loads.

### From `app.py` (top-level imports)

```
actions.check_time   actions.finance   actions.news   actions.weather
actions.checklist    actions.spotify_search   actions.music
actions.work_mode_reasoning
intent      ASR     TTS     bmo_tts     safety_limits
CHAT3 (VeraAI)       CHAT_REASONING (ReasoningAI)
CHAT_REASONING_DEEP (ReasoningDeepAI)
math_code_executor
cost_logging.*       (optional, wrapped in try/except)
```

### Transitive

- `CHAT_REASONING.py` imports from `CHAT2` (`admin_info_path`,
  `build_profile_context`, `load_profile_info`, `active_user_info_path`).
  → `CHAT2.py` is therefore an **active dependency**, not removable.
- `CHAT_REASONING_DEEP.py` imports from `CHAT_REASONING` and from
  `math_code_executor`.

### From `index.html` (script tags)

Only one runtime script:

```html
<script src="app.js?v=74"></script>
```

Plus two CDN libraries (KaTeX, Highlight.js). No other JS file in the
repo is loaded by `index.html`. `static/test-search.html` and
`bmo-emotions-test.html` were never reachable from the live app.

### Served statically

```
app.mount("/static",  StaticFiles(directory="static"),  name="static")
app.mount("/assets",  StaticFiles(directory="assets"),  name="assets")  # if present
```

After this pass, `static/` contains only runtime assets
(`vad/`, `fillers/`, `tradingview_chart.html`). The two test files are
out.

---

## 4. Files NOT imported anywhere

| File                          | Last referenced by         | Classification         |
| ----------------------------- | -------------------------- | ---------------------- |
| `CHAT.py`                     | `docker/app.py` only       | dev-only keep (legacy) |
| `LLM.py`                      | `debug/convo_tester.py`    | dev-only keep (legacy) |
| `QWEN.py`                     | nobody (all imports commented out in `app.py`, `local_vera/app.py`, `docker/app.py`) | probably removable     |
| `audio_cleaning.py`           | nobody (defines `cleanup_old_tts` but it's never called) | probably removable     |
| `2.0/app.js`                  | nobody                     | legacy archive — keep, marked |
| `old_UX_design/app.js`        | nobody                     | legacy archive — keep, marked |
| `old_UX_design/index.html`    | nobody                     | legacy archive — keep, marked |
| `old_UX_design/styles.css`    | nobody                     | legacy archive — keep, marked |
| `local_vera/*`                | self-contained local build | dev-only keep (separate runtime) |
| `docker/*`                    | self-contained docker build| dev-only keep (separate runtime) |

`CHAT.py`, `LLM.py`, `QWEN.py`, `audio_cleaning.py`, `2.0/app.js` and
`old_UX_design/app.js` now carry header comments marking their status
so anyone opening them sees the warning immediately.

---

## 5. Debug globals exposed on `window`

Found in `app.js`:

| Symbol                              | Purpose                                                                                          | Gating today                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `window.VERA_DEV_MODE` (NEW)        | Unified dev-mode flag                                                                            | Off by default. Set via `window.VERA_DEV_MODE = true` or `localStorage.vera_dev_mode = "1"`. |
| `window.isVeraDevMode` (NEW)        | Predicate that reads the unified flag                                                            | Always defined; cheap call.                                                  |
| `window.veraConcurrencyDebug()`     | Snapshot per-tab session_id, request_ids, reasoning/audio state                                  | Always defined (devtools entry point).                                       |
| `window.dumpVeraVoiceState()`       | Snapshot every voice/TTS runtime flag                                                            | Always defined (devtools entry point).                                       |
| `window.resetVeraVoiceRuntimeState()` | Soft teardown of TTS + interrupt flags                                                         | Always defined (devtools entry point).                                       |
| `window.toggleBargeInDebugUi()`     | Mount/unmount the barge-in overlay                                                               | Always defined.                                                              |
| `window.copyBargeInDebugSnapshot()` | Clipboard-copy a snapshot JSON                                                                   | Always defined.                                                              |
| `window.__veraDebugSyncState()`     | Pure-read snapshot of checklist sync internals                                                   | Always defined.                                                              |
| `window.VERA_DEBUG_INTERRUPT`       | Verbose interrupt-pipeline logs                                                                  | Off by default; set via devtools.                                            |
| `window.VERA_DEBUG_BARGE_IN_UI`     | Mount the barge-in overlay                                                                       | Off by default; set via devtools, `localStorage.vera_debug_barge_in_ui`, OR the new `isVeraDevMode()`. |
| `localStorage.VERA_DEBUG_TRANSCRIPTS` | Silence `[VOICE][TRANSCRIPT]` logs when `"0"`                                                  | Default on (logs visible). Set `"0"` to silence.                             |
| `localStorage.VERA_DEBUG_PARTIAL_ASR_DONE` | Silence `[VOICE][PARTIAL-ASR]` logs when `"0"`                                            | Default on. Set `"0"` to silence.                                            |
| `localStorage.VERA_DEBUG_BROWSER_ASR_STUCK` | Extra Web Speech heartbeats when `"1"`                                                  | Off by default.                                                              |
| `window.__vera*` state holders      | Music/Spotify/free-music runtime state (`__veraSpotifyPlaybackActive`, `__veraSpotifyNowState`, `__veraFreeMusicPlayback`, etc.) | Production state — **not** debug; do not gate. |

### Why we are not hard-gating the dev entry points yet

The window helpers (`dumpVeraVoiceState`, `veraConcurrencyDebug`, etc.)
are *function definitions* with no background work. They cost nothing
unless a human calls them from DevTools — which is exactly when you
*want* them available. Hard-gating them behind `VERA_DEV_MODE` would
mean a power user who already set `VERA_DEBUG_INTERRUPT = true` could
not also call the dump helper, which would be a real regression.

The barge-in overlay has its own `setInterval` poll and DOM mount.
That overlay is still gated by `_bargeInDebugUiEnabled()`, and that
function now ALSO returns `true` when `isVeraDevMode()` is on — so the
unified switch turns it on, but the existing per-feature flag still
works for someone who only wants the overlay without all the rest.

---

## 6. Backup / duplicate files

| Path                                  | Status                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `2.0/app.js`                          | Legacy prototype copy (8 KB). Marked LEGACY in a header comment.        |
| `2.1/`                                | Empty directory. **Deleted.**                                           |
| `old_UX_design/{app.js,index.html,styles.css}` | Old UX archive. Marked LEGACY in a header comment.             |
| `local_vera/`                         | Separate self-contained local build (Electron + own `app.py`/`app.js`). Keep as-is. |
| `docker/`                             | Separate self-contained docker build. Keep as-is.                       |
| `__pycache__/` (5 directories)        | Always-regenerable Python bytecode. **Deleted** + added to `.gitignore`. |
| `chat_log/`                           | Per-session text dumps (~82 KB). Added to `.gitignore`. Keep on disk.    |
| `logs/`                               | Per-session cost summaries (~2 MB). Added to `.gitignore`. Keep on disk. |
| `tts_outputs/`                        | **8,297 cache files (~1.7 GB).** Added to `.gitignore`. Not deleted automatically because removing it forces TTS regeneration; flag for manual `audio_cleaning.cleanup_old_tts(days=3)` or a shell `Remove-Item` whenever space matters. |

---

## 7. Classification table (re-stated per spec)

| Item                                              | Classification             |
| ------------------------------------------------- | -------------------------- |
| `__*smoke*.{py,mjs}` (13 files)                   | move to `tests/smoke/`     |
| `convo_tester.py`                                 | move to `debug/`           |
| `static/searching.js` + `static/test-search.html` | move to `debug/`           |
| `bmo-emotions-test.html`                          | dev-only keep (left in place — referenced from index.html docs panel; safe to move later when that line is updated) |
| `_bargeInDebug*` overlay (in `app.js`)            | dev-only keep, gated       |
| `window.veraConcurrencyDebug`, `dumpVeraVoiceState`, `__veraDebugSyncState`, etc. | dev-only keep (cheap), available in any tab |
| `CHAT.py`                                         | dev-only keep (legacy; docker only) |
| `LLM.py`                                          | dev-only keep (legacy; `convo_tester` only) |
| `QWEN.py`                                         | probably removable         |
| `audio_cleaning.py`                               | probably removable         |
| `2.0/app.js`                                      | dev-only keep (legacy archive) |
| `2.1/`                                            | removable — empty (DONE)   |
| `old_UX_design/`                                  | dev-only keep (legacy archive) |
| `local_vera/`, `docker/`, `vera-api/`             | production-needed (separate deployments) |
| `__pycache__/`                                    | removable, regenerable (DONE) |
| `tts_outputs/`                                    | uncertain — runtime cache, large; left alone, gitignored |
| `chat_log/`, `logs/`                              | dev-only keep, gitignored  |
| `cost_logging/`                                   | production-needed (imported by app.py via try/except) |

---

## 8. Active-path map

For each user-visible flow, the function names below are the **first
entry points** in `app.js` / `app.py`. They are the safe anchors for
the future modularization in §10.

### 8.1 Normal voice input (continuous mode)

| Layer    | Symbol                                            | File / line       |
| -------- | ------------------------------------------------- | ----------------- |
| Mic gate | `startListening()`                                | `app.js` L≈27761  |
| Server submit (voice) | `fetch(${API_URL}/infer, …)`         | `app.js` L≈28018, L≈28328, L≈28557 |
| Server route | `@app.post("/infer")` → `async def infer(...)` | `app.py` L≈13779–13780 |
| Reply playback | `runNdjsonTtsPlayback`, `playTtsUrlSequenceIncremental` | `app.js` L≈25795, L≈25521 |

### 8.2 Browser streaming ASR (Web Speech API)

| Layer    | Symbol                                                       | File / line       |
| -------- | ------------------------------------------------------------ | ----------------- |
| Recognition session | `startMainBrowserRecognitionContinuous()`         | `app.js` L≈27043  |
| Stuck-session watchdog | `stopBrowserAsrStuckWatchdog()` + flag `localStorage.VERA_DEBUG_BROWSER_ASR_STUCK` | `app.js` L≈2506, L≈2495 |
| Mode selection | `getVeraAsrMode()`, `setVeraAsrMode()` (PART 1 region in `app.js`, near L≈3020) | `app.js` |
| Hybrid → server | `/infer` with `asr_mode=streaming` + `hybrid_browser_transcript` form fields | `app.py` `infer(...)` |

### 8.3 Single-shot Whisper ASR

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Mode selection | `getVeraAsrMode()` returning `"whisper"` (back-compat: `"single"` → `"whisper"`) | `app.js` PART 1   |
| Audio post  | Same `fetch(${API_URL}/infer)` call but with `audio` blob + `asr_mode=whisper` | `app.js` L≈28018 |
| Server transcribe | `ASR.transcribe_long(...)`                       | `app.py` import L≈74, used in `infer(...)` |
| Confirmation routing | `normalize_command_transcript`, `choose_best_transcript` (PARTS 9–10) | `app.py` |

### 8.4 Interruption / barge-in

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Fast VAD stop | `fastStopTtsOnVadOnly({rms, zcr, crest, vadAccumMs})` | `app.js` L≈2308 |
| Single-ASR detect | `interruptSpeech()`                                | `app.js` L≈23533  |
| Cancel TTS  | `cancelMainTtsPlayback()`                             | `app.js` L≈24639  |
| Timing trace | `_recordInterruptTimingPoint(...)`, `_flushInterruptDelayTrace(...)` | `app.js` L≈1310–1402 |
| Debug overlay | `_bargeInDebugMount`, `_bargeInDebugRender`         | `app.js` L≈2021, L≈2120 |

### 8.5 TTS streaming (NDJSON pipeline)

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Producer  | `TTS.speak_to_file`, `TTS.split_sentences_for_tts`, `TTS.pop_first_complete_segment` | `TTS.py` (imports at `app.py` L≈76) |
| Server stream  | `infer(...)` writes NDJSON when `stream_tts=1`     | `app.py` `infer` |
| Client decode  | `runNdjsonTtsPlayback(...)`                        | `app.js` L≈25795  |
| Sequenced playback | `playTtsUrlSequenceIncremental(...)` / `playTtsUrlSequenceGapless(...)` | `app.js` L≈25521, L≈25272 |
| Audio file route | `@app.get("/audio/{session_id}/{date}/{filename}")` | `app.py` L≈14725 |

### 8.6 Work Mode reasoning

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Classify intent | `@app.post("/work_mode/classify")`                | `app.py` L≈16832  |
| Reasoning stream (typed/voice) | `@app.post("/work_mode/reasoning_stream")` | `app.py` L≈17074 |
| Reasoning stream with upload | `@app.post("/work_mode/reasoning_stream_upload")` | `app.py` L≈17243 |
| Per-panel title generation | `@app.post("/work_mode/reasoning_panel_title")` | `app.py` L≈17479 |
| Frontend kick-off  | `fetch(${API_URL}/work_mode/classify)`            | `app.js` L≈19059  |
| Stage-1 ack TTS    | `fetch(${API_URL}/text, … tts_only)` (see L≈16976 docstring) | `app.js` L≈18885 |
| Lane bookkeeping   | `workModeReasoningAbortControllers`, `workModeReasoningLaneBusy`, `workModeTtsQueue` | `app.js` (referenced in `veraConcurrencyDebug`) |
| Module             | `actions/work_mode_reasoning.py`                       | imports at `app.py` L≈174 |

### 8.7 Panel open / close / switch

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Generic hide  | `hideSidePanel()`                                  | `app.js` L≈4494   |
| Reasoning lane mount | `createReasoningLanePanel(idx, html, isActive, tabMeta)` | `app.js` L≈8905 |
| Reasoning tab strip | `renderReasoningTabStrip()`, `addReasoningTab()` | `app.js` L≈9967, L≈10086 |
| Close by index    | `closeReasoningPanelsByVisualIndices(...)`, `closeReasoningTab(...)` | `app.js` L≈10626, L≈10951 |
| Close voice reply | `buildCloseReasoningPanelsVoiceReply(...)`, `renderReasoningCloseAssistantConfirmation(...)` | `app.js` L≈11670, L≈11752 |
| News panel render | `renderNewsResultListMarkup(...)`                 | `app.js` L≈5630   |
| Media tabs panel  | `renderMediaTabsPanel(...)`, `renderFinanceChartPanel(...)` | `app.js` L≈5778, L≈5863 |
| Productivity panel| `renderProductivityPanel()`, `toggleProductivityPanel()` | `app.js` L≈8471, L≈8587 |

### 8.8 Checklist actions

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Drag handle build | `createWorkChecklistDragHandle()`                 | `app.js` L≈20197  |
| Insert empty row  | `insertWorkChecklistEmptyOngoingAfter(afterId)`   | `app.js` L≈20448  |
| Serialize         | `renderedChecklistMarkdownFromPanel(panel)`       | `app.js` L≈21245  |
| Parse model proposal | `buildChecklistProposalFromMarkdown(markdown)` | `app.js` L≈21419  |
| Help-plan request | `buildWorkChecklistHelpPlanUserMessage(lines)`    | `app.js` L≈21853  |
| Sync preview UI   | `showWorkChecklistSyncPreview(text)`, `hideWorkChecklistSyncPreview()` | `app.js` L≈21570, L≈21600 |
| Server load       | `GET /api/work-mode/checklist`                     | `app.py` L≈15503  |
| Server module     | `actions/checklist.py` (76 KB)                     | imports at `app.py` L≈139 |

### 8.9 News / current-info routing

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Intent guess     | `looksLikeNewsSearchRequest(text)`                | `app.js` L≈712    |
| Status bubble    | `armPendingNewsStatusBubble(...)`, `cancelPendingNewsStatusBubble(...)`, `failPendingNewsStatusBubble(...)` | `app.js` L≈886, L≈940, L≈974 |
| Route from intent| `build_route_from_news_intent(...)`               | `app.py` L≈8229   |
| Streaming messages | `prepare_news_streaming_messages(...)`          | `app.py` import L≈64 |
| Server module    | `actions/news.py`                                  | imports at `app.py` L≈64, L≈138 |
| Panel open/close | `handle_news_request`, `handle_news_open_panel`, `handle_news_close_panel` | `app.py` import L≈138 |

### 8.10 Music actions

| Layer    | Symbol                                                  | File / line       |
| -------- | ------------------------------------------------------- | ----------------- |
| Now-playing state | `__veraSpotifyNowState`, `__veraSpotifyPlaybackActive`, `__veraFreeMusicPlayback` | `app.js` various |
| Catalog HTML     | `renderFreeMusicCatalogHtml(prefix, data)`        | `app.js` L≈5038   |
| Spotify search snapshot | `__veraSpotifySearchSnapshot`, `__veraSpotifyPlaylistSnapshot` | `app.js` L≈5943–6062 |
| Volume helpers   | window state + transport actions (PART 6 region)  | `app.js` L≈4739   |
| Server routes    | `/api/free-music/*`, `/api/spotify/*`, `/auth/spotify/*` | `app.py` L≈15556–16650 |
| Server module    | `actions/music.py`, `actions/spotify_search.py`   | imports at `app.py` L≈146, L≈155 |

---

## 9. Cleanup actions performed in THIS pass

(Listed so you can verify in `git status`.)

1. Created `tests/smoke/` and moved 13 `__*smoke*.{py,mjs}` files into it.
   - Added a `sys.path` bootstrap to every Python smoke file so `import app`
     still resolves.
   - Updated `.mjs` files that used `__dirname + "app.js"` to climb two
     directories up to the repo root.
   - Wrote `tests/smoke/README.md`.
2. Created `debug/` and moved:
   - `convo_tester.py` → `debug/convo_tester.py`
   - `static/searching.js` → `debug/static-search-prototype/searching.js`
   - `static/test-search.html` → `debug/static-search-prototype/test-search.html`
   - Wrote `debug/README.md`.
3. Deleted `__pycache__/` (5 directories total) and the empty `2.1/` folder.
4. Updated `.gitignore` to cover `__pycache__/`, `*.pyc`, `tts_outputs/`,
   `logs/`, `chat_log/`.
5. Added unified dev-mode helper:
   - **JS:** `isVeraDevMode()` + `window.VERA_DEV_MODE` /
     `localStorage.vera_dev_mode` in `app.js`.
   - **Python:** `VERA_DEV_MODE = os.environ.get("VERA_DEV_MODE", ...)`
     in `app.py`.
   - Extended `_bargeInDebugUiEnabled()` to also return `true` when
     `isVeraDevMode()` is on (additive — pre-existing flags still work).
6. Added LEGACY/UNUSED header comments to:
   - `CHAT.py`, `LLM.py`, `QWEN.py`, `audio_cleaning.py`,
     `2.0/app.js`, `old_UX_design/app.js`.

### Actions explicitly NOT taken (per spec)

- No split of `app.js` or `app.py`.
- No deletion of `CHAT.py`, `LLM.py`, `QWEN.py`, `audio_cleaning.py`,
  `2.0/`, `old_UX_design/` (all marked legacy but kept).
- No removal of any fallback code path or compatibility wrapper.
- No change to ASR/TTS routing, Work Mode logic, UI behaviour.
- `bmo-emotions-test.html` left in place because the index.html docs
  panel mentions its filename — moving it would either leave a stale
  reference or require a UI-text edit.
- `tts_outputs/` (1.7 GB) left in place; only gitignored. Removing it
  forces TTS regeneration and could be perceived as a behavior change
  on the next turn.

---

## 10. Suggested modularization plan (DO NOT execute yet)

The goal is to break `app.js` (~1.2 MB) and `app.py` (~720 KB) into the
smallest possible **functional slices** without changing any runtime
behaviour. Each slice should land in its own PR with a smoke test.

### Frontend (`app.js`)

```
voice/
  asr.js            getVeraAsrMode/setVeraAsrMode, normalizeCommandTranscript,
                    chooseBestTranscript, hybrid params, browser-ASR session,
                    Whisper post.            (anchors: PARTS 1, 6, 9, 10)
  ttsQueue.js       runNdjsonTtsPlayback, playTtsUrlSequenceIncremental,
                    playTtsUrlSequenceGapless, cancelMainTtsPlayback,
                    activeMainTtsBufferSources bookkeeping.
  interruption.js   fastStopTtsOnVadOnly, interruptSpeech, RAF gap tracker,
                    interrupt timing trace (t0..t11), barge-in latched state.
  voiceState.js     startListening, mic stream lifecycle, listeningMode,
                    inputMuted, vadFastStop*, beginVoiceUxTurn, log helpers.

workmode/
  panels.js         createReasoningLanePanel, renderReasoningTabStrip,
                    addReasoningTab, closeReasoningPanelsByVisualIndices,
                    closeReasoningTab, renderReasoningCloseAssistantConfirmation.
  checklist.js      createWorkChecklistDragHandle, renderedChecklistMarkdown,
                    buildChecklistProposalFromMarkdown, sync preview helpers.
  actionPlanner.js  workModeReasoningPrepOutcome, lane guard, stage-1 ack,
                    workModeReasoningContextLooksUsable.
  routing.js        workModeAttachmentKindForFile, workModeFileLooksSupported,
                    workModeInferTurnSourceFromPath, workModeTtsMetaFromTurnContext.

news/
  newsRouter.js     looksLikeNewsSearchRequest, current_info_intent classification,
                    pending-status bubble lifecycle.
  newsPanel.js      renderNewsResultListMarkup, render scaffolding,
                    news-panel render timing.

debug/
  voiceDebug.js     dumpVeraVoiceState, resetVeraVoiceRuntimeState,
                    veraConcurrencyDebug, interrupt-debug logger,
                    interrupt timing trace, __veraDebugSyncState.
  smokeTests.js     thin browser-side runner that, when isVeraDevMode() is on,
                    can fetch and exec individual `tests/smoke/*.mjs` checks.
                    (Optional — most smoke tests stay in tests/smoke/.)

ui/
  bubbles.js        addBubble, updateInterruptDetectionBubble,
                    showDeferredMainBrowserUserBubbleIfNeeded,
                    updateMainBrowserLiveBubble, removeMainBrowserLiveBubble.
  sidePanels.js     hideSidePanel, renderMediaTabsPanel, renderFinanceChartPanel,
                    renderProductivityPanel, toggleProductivityPanel,
                    side-panel snapshot save/restore.

utils/
  logging.js        logVeraInterruptDebug, logInterruptTranscriptDebug,
                    logBargeInLatencyDebug, logVoicePipe, logVoiceFirstAudio,
                    logCapabilityFallbackDebug, logInputLimitDebug.
  ids.js            newVeraRequestId, getSessionId, getSessionScopedId,
                    setSessionScopedId, resetVeraAndBmoSessionIdsForTab,
                    recordVeraRequestId.
  storage.js        Wrappers around localStorage / sessionStorage with safe
                    try/catch (avoids the dozens of inline try/catch blocks
                    around storage access in app.js).
```

### Recommended migration order (smallest blast radius first)

1. `utils/ids.js` — pure functions, zero coupling.
2. `utils/storage.js` — purely wraps existing patterns.
3. `utils/logging.js` — pure functions, gated on `isVeraDevMode()`.
4. `debug/voiceDebug.js` — pull out the window-attached helpers; do not
   touch hot paths.
5. `voice/asr.js` (PARTS 1, 6, 9, 10) — already smoke-tested as a
   carve-out via `tests/smoke/__asr_mode_smoke.mjs`.
6. `voice/ttsQueue.js`, `voice/interruption.js`, `voice/voiceState.js`.
7. `workmode/*`.
8. `news/*`.
9. `ui/*` last (they reach into the rest the most).

### Backend (`app.py`)

`app.py` should follow the same slicing logic but is *not* in the
scope of this pass. Suggested slices (record now, do later):

```
server/
  bootstrap.py        FastAPI app factory, middleware, mounts, env loading.
  routes/
    infer.py          /infer + /command + transcript helpers.
    text.py           /text + /tts_emotion_route.
    work_mode.py      /work_mode/*.
    spotify.py        /api/spotify/* + /auth/spotify/*.
    free_music.py     /api/free-music/*.
    cost.py           /cost/* + /metrics + /api/diag/sessions.
    user.py           /api/user/* + Google/OTC login.
    health.py         /status + /health/*.
  session/
    ids.py            _new_request_id, _current_request_id_var, REQ start/end logging.
    capacity.py       MAX_ACTIVE_USERS, cleanup_sessions, user_last_seen.
  pipeline/
    asr_route.py      choose_best_transcript, normalize_command_transcript.
    intent_route.py   classify_current_info_intent + downstream.
    stream_tts.py     NDJSON writer + filler logic.
```

---

## 11. Open questions for the next pass

These do not block this PR; flag them when scheduling the modularization.

1. **`bmo-emotions-test.html`** — keep at root, move to `debug/`, or
   inline its content into the documentation panel? Currently the
   "Implementation notes" panel in `index.html` mentions its filename
   in `<code>` tags.
2. **`QWEN.py` / `audio_cleaning.py`** — confirm we never want to bring
   these back, then delete.
3. **`local_vera/` and `docker/`** — these are full sibling builds with
   their own `app.py` / `app.js`. They were not touched in this pass.
   Decide whether they remain maintained or should be moved into a
   `_archive/` tree.
4. **`tts_outputs/`** — adopt `audio_cleaning.cleanup_old_tts(days=3)`
   on server startup, or set up a scheduled job?
5. **`CHAT2.py`** — currently only used by `CHAT_REASONING` (which uses
   it for profile-context helpers). Worth pulling those helpers into a
   `profile.py` module so `CHAT2` can also be retired.
