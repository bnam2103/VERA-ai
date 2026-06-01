/* =========================================================================
 *  debug/voiceDebug.js — DevTools-only voice / concurrency diagnostics.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 4). Every helper below is a manual-call
 *  diagnostic — none of them runs automatically. The two top-level IIFEs
 *  preserve the EXACT load-time behaviour from app.js:
 *
 *    1. PART 11 — attaches `window.veraConcurrencyDebug()` for per-tab
 *       isolation inspection (session_ids, last_request_ids, lane
 *       state, TTS queue size, interrupt latch, etc.).
 *
 *    2. _attachVeraVoiceRuntimeDiagnostics — attaches
 *       `window.dumpVeraVoiceState()` (snapshot) and
 *       `window.resetVeraVoiceRuntimeState()` (soft TTS + interrupt
 *       teardown without a page reload).
 *
 *  Both helpers are gated only by being attached to `window` — no
 *  per-feature DEBUG flag — because the user needs them callable in
 *  any tab without setup (matches the pre-extraction app.js behaviour).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order
 *  ─────────────────────────────────────────────────────────────────────
 *  This file is loaded AFTER app.js in index.html. Rationale:
 *
 *    - Nothing inside app.js references any bare identifier defined
 *      in this file, so app.js does NOT need our names at parse time.
 *
 *    - Both IIFEs only attach `window.*` aliases at load time.
 *      Loading after app.js means the assignments are the LAST writers
 *      to those `window` slots, so any earlier code that read them
 *      (it does not — verified by grep) would not get blown away.
 *
 *    - The function bodies reference dozens of app.js runtime bindings
 *      (`workModeReasoningAbortControllers`, `mainTtsPlaybackActive`,
 *      `interruptBargeInLatched`, `_veraTtsCancelSource`, `getSessionId`,
 *      `VERA_LAST_REQUEST_IDS`, `cancelMainTtsPlayback`, …). Because
 *      classic <script> tags share a single GlobalEnvironment with
 *      a shared LexicalEnvironment for top-level `let` / `const` /
 *      `function` declarations, every bare identifier resolves at
 *      CALL TIME — which only happens after the user invokes the
 *      helper in DevTools, long after both files have finished loading.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Helpers intentionally LEFT in app.js
 *  ─────────────────────────────────────────────────────────────────────
 *    isVeraDevMode + window.isVeraDevMode  — unified gate that the
 *        barge-in overlay (still in app.js) and future dev-mode panels
 *        consume; not a DevTools-call helper.
 *    BARGE-IN DEBUG OVERLAY (the entire block at app.js:1606–~2200):
 *        - _veraBargeInDebug state object
 *        - _bargeInDebugUiEnabled / _bargeInDebugCaptureEvent
 *        - _bargeInDebugBuildState / _bargeInDebugMount / _Unmount
 *        - _bargeInDebugTick / _bargeInDebugPositionOverlay
 *        - _bargeInDebugBuildSnapshot
 *        - window.VERA_DEBUG_BARGE_IN_UI initial set
 *        - window.toggleBargeInDebugUi
 *        - window.copyBargeInDebugSnapshot
 *        - poll / auto-mount glue
 *      Why left: this is a 600-line DOM-mounting overlay with a 1-second
 *      polling loop, an MutationObserver-free reflow loop, and tight
 *      coupling to `logVeraInterruptDebug` + `logInterruptTranscriptDebug`
 *      (both still in app.js) which call `_bargeInDebugCaptureEvent`
 *      directly. The user's spec said "ONLY if safe" — moving it would
 *      require also moving the two interrupt loggers and the cancel-log
 *      hooks, which is out of scope for the Stage 4 freeze.
 *    window.dumpVeraBubbleTexts — did NOT exist in app.js before this
 *      stage. The user's spec lists it as a candidate, but creating a
 *      new helper would violate the "Do not change runtime behavior"
 *      rule. Documented here so a future stage can decide whether to
 *      add it.
 * ========================================================================= */

/* =========================================================================
 *  PART 11 — window.veraConcurrencyDebug()
 *
 *  Manual DevTools probe: returns + console.tables an isolation snapshot
 *  for THIS tab (session ids, last request ids, active reasoning streams,
 *  TTS queue size, interrupt latch). Same body as the pre-extraction
 *  IIFE; bare identifiers resolve at call time through the shared
 *  classic-script global lexical environment.
 * ========================================================================= */
try {
  window.veraConcurrencyDebug = function veraConcurrencyDebug() {
    const snap = {
      vera_session_id: (function () {
        try { return getSessionScopedId(VERA_SESSION_STORAGE_KEY) || ""; } catch (_) { return ""; }
      })(),
      bmo_session_id: (function () {
        try { return getSessionScopedId(BMO_SESSION_STORAGE_KEY) || ""; } catch (_) { return ""; }
      })(),
      last_request_ids: { ...VERA_LAST_REQUEST_IDS },
      active_reasoning_streams: (function () {
        try {
          return typeof workModeReasoningAbortControllers !== "undefined"
            ? workModeReasoningAbortControllers.size
            : 0;
        } catch (_) { return 0; }
      })(),
      reasoning_lane_busy: (function () {
        try {
          return typeof workModeReasoningLaneBusy !== "undefined"
            ? Array.from(workModeReasoningLaneBusy.entries())
            : [];
        } catch (_) { return []; }
      })(),
      tts_queue_size: (function () {
        try {
          return typeof workModeTtsQueue !== "undefined" ? workModeTtsQueue.length : null;
        } catch (_) { return null; }
      })(),
      tts_currently_playing: (function () {
        try {
          return typeof workModeTtsCurrentlyPlaying !== "undefined"
            ? !!workModeTtsCurrentlyPlaying
            : null;
        } catch (_) { return null; }
      })(),
      interrupt_state: (function () {
        try {
          return typeof interruptBargeInLatched !== "undefined" ? !!interruptBargeInLatched : null;
        } catch (_) { return null; }
      })(),
      listening: (function () {
        try { return typeof listening !== "undefined" ? !!listening : null; } catch (_) { return null; }
      })(),
      processing: (function () {
        try { return typeof processing !== "undefined" ? !!processing : null; } catch (_) { return null; }
      })(),
      url: window.location.href,
      build: "v68_multi_device_concurrency",
    };
    try { console.table(snap.last_request_ids); } catch (_) {}
    try {
      console.log("%c[VERA] concurrency debug snapshot", "color:#10b981;font-weight:bold;", snap);
    } catch (_) {}
    return snap;
  };
} catch (_) {}

/* =========================================================================
 *  TAB-LOCAL VOICE-RUNTIME DIAGNOSTICS
 *
 *  Two devtools commands for triaging the "broken tab vs working tab"
 *  interruption symptom. Neither is called automatically — they exist
 *  purely so a human can dump and reset state between tabs.
 *
 *    window.dumpVeraVoiceState()
 *      Snapshots all the runtime flags / handles that govern voice
 *      interrupt + TTS behaviour in this tab. Returns an object and
 *      also console.warn's it under [vera_voice_state_dump] so it
 *      shows up in the saved DevTools log.
 *
 *    window.resetVeraVoiceRuntimeState()
 *      Synchronous "soft" teardown of TTS + interrupt flags so a tab
 *      that has drifted into a stale state can be re-tested without a
 *      full page reload. Does NOT touch backend session, recorders,
 *      localStorage, or the checklist/timer.
 *
 *  Both are gated only by being attached to window — no DEBUG flag —
 *  because the user needs them available in any tab without setup.
 * ========================================================================= */
(function _attachVeraVoiceRuntimeDiagnostics() {
  if (typeof window === "undefined") return;

  const _safe = (fn) => {
    try { return fn(); } catch (_) { return null; }
  };

  window.dumpVeraVoiceState = function dumpVeraVoiceState(opts = {}) {
    const snapshot = {
      tag: "vera_voice_state_dump",
      at: new Date().toISOString(),
      perfNow: Number(performance.now().toFixed(1)),

      /* ---- session / mode (user-spec'd fields) ---- */
      sessionId: _safe(() => (typeof getSessionId === "function" ? getSessionId() : null)),
      asrMode: _safe(() => (typeof getVeraAsrMode === "function" ? getVeraAsrMode() : null)),
      browserAsrPreferred: _safe(() =>
        typeof browserAsrPreferred === "function" ? browserAsrPreferred() : null
      ),
      listeningMode: _safe(() => (typeof listeningMode !== "undefined" ? listeningMode : null)),
      /* "micState" / "continuousListeningEnabled" don't exist verbatim —
         expose the equivalent flags so cross-tab diffs are meaningful. */
      micState: _safe(() => {
        if (typeof inputMuted !== "undefined" && inputMuted) return "muted";
        if (typeof pttRecording !== "undefined" && pttRecording) return "ptt_recording";
        if (typeof listening !== "undefined" && listening) return "listening";
        return "idle";
      }),
      continuousListeningEnabled: _safe(() =>
        typeof listeningMode !== "undefined" && listeningMode === "continuous"
      ),

      /* ---- TTS playback runtime ---- */
      mainTtsPlaybackActive: _safe(() =>
        typeof mainTtsPlaybackActive !== "undefined" ? mainTtsPlaybackActive : null
      ),
      mainTtsPlaybackToken: _safe(() =>
        typeof mainTtsPlaybackToken !== "undefined" ? mainTtsPlaybackToken : null
      ),
      activeMainTtsBufferSourcesCount: _safe(() =>
        typeof activeMainTtsBufferSources !== "undefined"
          ? activeMainTtsBufferSources.length
          : null
      ),
      activeNdjsonBodyReaderPresent: _safe(() =>
        typeof activeNdjsonBodyReader !== "undefined" && Boolean(activeNdjsonBodyReader)
      ),

      /* ---- interrupt capture ---- */
      interruptRecording: _safe(() =>
        typeof interruptRecording !== "undefined" ? interruptRecording : null
      ),
      interruptPrearmRecorderState: _safe(() =>
        typeof interruptPrearmRecorder !== "undefined" && interruptPrearmRecorder
          ? interruptPrearmRecorder.state
          : null
      ),
      vadFastStopArmed: _safe(() =>
        typeof vadFastStopArmed !== "undefined" ? vadFastStopArmed : null
      ),

      /* ---- ids (best-effort: app uses interruptPrearmTtsId/TurnId) ---- */
      currentTtsId: _safe(() => window.currentTtsId || (typeof interruptPrearmTtsId !== "undefined" ? interruptPrearmTtsId : null) || null),
      currentTurnId: _safe(() => window.currentTurnId || (typeof interruptPrearmTurnId !== "undefined" ? interruptPrearmTurnId : null) || null),
      currentRequestId: _safe(() => window.currentRequestId || null),

      /* ---- workmode mute / effective mute ---- */
      workModeOn: _safe(() =>
        typeof isVeraWorkModeOn === "function" ? isVeraWorkModeOn() : null
      ),
      workModeMuteEnabled: _safe(() =>
        typeof isWorkModeMuteEnabled === "function" ? isWorkModeMuteEnabled() : null
      ),
      inputMuted: _safe(() => (typeof inputMuted !== "undefined" ? inputMuted : null)),

      /* ---- extras useful for diffing a stuck vs healthy tab ---- */
      extras: {
        listening: _safe(() => (typeof listening !== "undefined" ? listening : null)),
        processing: _safe(() => (typeof processing !== "undefined" ? processing : null)),
        requestInFlight: _safe(() =>
          typeof requestInFlight !== "undefined" ? requestInFlight : null
        ),
        pttRecording: _safe(() =>
          typeof pttRecording !== "undefined" ? pttRecording : null
        ),
        hasSpoken: _safe(() => (typeof hasSpoken !== "undefined" ? hasSpoken : null)),
        waveState: _safe(() => (typeof waveState !== "undefined" ? waveState : null)),
        interruptBargeInLatched: _safe(() =>
          typeof interruptBargeInLatched !== "undefined" ? interruptBargeInLatched : null
        ),
        interruptSpeechFrames: _safe(() =>
          typeof interruptSpeechFrames !== "undefined" ? interruptSpeechFrames : null
        ),
        interruptSpeechAccumMs: _safe(() =>
          typeof interruptSpeechAccumMs !== "undefined"
            ? Number(Number(interruptSpeechAccumMs).toFixed(1))
            : null
        ),
        interruptPartialAccumMs: _safe(() =>
          typeof interruptPartialAccumMs !== "undefined"
            ? Number(Number(interruptPartialAccumMs).toFixed(1))
            : null
        ),
        interruptPartialLastText: _safe(() =>
          typeof interruptPartialLastText !== "undefined"
            ? String(interruptPartialLastText || "").slice(0, 80)
            : null
        ),
        interruptDetectRecognitionPresent: _safe(() =>
          typeof interruptDetectRecognition !== "undefined" && Boolean(interruptDetectRecognition)
        ),
        mainBrowserRecognitionPresent: _safe(() =>
          typeof mainBrowserRecognition !== "undefined" && Boolean(mainBrowserRecognition)
        ),
        browserAsrPermanentlyDisabled: _safe(() =>
          typeof browserAsrPermanentlyDisabled !== "undefined"
            ? browserAsrPermanentlyDisabled
            : null
        ),
        audioCtxState: _safe(() =>
          typeof audioCtx !== "undefined" && audioCtx ? audioCtx.state : null
        ),
        micStreamActive: _safe(() =>
          typeof micStream !== "undefined" && micStream ? Boolean(micStream.active) : null
        ),
        appModePrefix: _safe(() =>
          typeof appModePrefix === "function" ? appModePrefix() : null
        ),
        appHidden: typeof document !== "undefined" ? document.hidden : null,
        appVisibilityState: typeof document !== "undefined" ? document.visibilityState : null,
        location: typeof location !== "undefined" ? location.href : null,
        veraDebugInterrupt: _safe(() =>
          typeof window !== "undefined" ? Boolean(window.VERA_DEBUG_INTERRUPT) : null
        ),
        duringNewsRender: _safe(() =>
          typeof _veraNewsPanelRenderInFlight !== "undefined"
            ? _veraNewsPanelRenderInFlight
            : null
        ),
        currentInterruptAttemptId: _safe(() =>
          _veraInterruptDelayTrace ? _veraInterruptDelayTrace.interruptAttemptId : null
        ),
      },
    };
    try {
      if (!opts.silent) console.warn(`[${snapshot.tag}]`, snapshot);
    } catch (_) {}
    return snapshot;
  };

  window.debugTtsState = function debugTtsState(opts = {}) {
    const a = _safe(() => (typeof getAudioEl === "function" ? getAudioEl() : null));
    const snapshot = {
      API_URL: _safe(() => (typeof API_URL !== "undefined" ? API_URL : null)),
      workMode: _safe(() => (typeof isVeraWorkModeOn === "function" ? isVeraWorkModeOn() : null)),
      workModeMute: _safe(() => (typeof isWorkModeMuteEnabled === "function" ? isWorkModeMuteEnabled() : null)),
      inputMuted: _safe(() => (typeof inputMuted !== "undefined" ? inputMuted : null)),
      listeningMode: _safe(() => (typeof listeningMode !== "undefined" ? listeningMode : null)),
      waveState: _safe(() => (typeof waveState !== "undefined" ? waveState : null)),
      mainTtsPlaybackActive: _safe(() =>
        typeof mainTtsPlaybackActive !== "undefined" ? mainTtsPlaybackActive : null
      ),
      activeMainTtsBufferSourcesCount: _safe(() =>
        typeof activeMainTtsBufferSources !== "undefined" ? activeMainTtsBufferSources.length : null
      ),
      isAssistantTtsPlaying: _safe(() =>
        typeof isAssistantTtsPlaying === "function" ? isAssistantTtsPlaying() : null
      ),
      requestInFlight: _safe(() => (typeof requestInFlight !== "undefined" ? requestInFlight : null)),
      processing: _safe(() => (typeof processing !== "undefined" ? processing : null)),
      workModeTtsQueueLength: _safe(() =>
        typeof workModeTtsQueue !== "undefined" ? workModeTtsQueue.length : null
      ),
      workModeTtsDrainActive: _safe(() =>
        typeof workModeTtsDrainRunning !== "undefined" ? workModeTtsDrainRunning : null
      ),
      currentWorkModeTtsItem: _safe(() =>
        typeof workModeTtsCurrentlyPlaying !== "undefined" ? workModeTtsCurrentlyPlaying : null
      ),
      audioCtxState: _safe(() => (typeof audioCtx !== "undefined" && audioCtx ? audioCtx.state : null)),
      audioElPaused: _safe(() => (a ? a.paused : null)),
      audioElSrc: _safe(() => (a ? a.currentSrc || a.src || "" : null)),
      audioElReadyState: _safe(() => (a ? a.readyState : null)),
      audioElErrorCode: _safe(() => (a ? a.error?.code ?? null : null)),
      lastTtsCancelSource: _safe(() =>
        typeof _veraTtsCancelSource !== "undefined" ? _veraTtsCancelSource || null : null
      )
    };
    try {
      if (!opts.silent) console.warn("[debug_tts_state]", snapshot);
    } catch (_) {}
    return snapshot;
  };

  /**
   * Soft reset of TTS + interrupt flags so a stale tab can be re-tested.
   *
   * Does NOT:
   *   - abort the active /infer fetch
   *   - stop MediaRecorders or browser SpeechRecognition sessions
   *   - touch localStorage, the checklist, the work-mode timer,
   *     or session state
   *
   * Does:
   *   - call cancelMainTtsPlayback (bumps token, stops Web Audio
   *     buffer sources, cancels the NDJSON body reader)
   *   - pause the <audio> element
   *   - clear our local interrupt accumulators / one-shot flags
   *   - leave vadFastStopArmed=false per spec; the next TTS turn will
   *     re-arm it via resetVadFastStopState("main_tts_start")
   *
   * Returns the post-reset dumpVeraVoiceState() snapshot for
   * before/after comparison.
   */
  window.resetVeraVoiceRuntimeState = function resetVeraVoiceRuntimeState(opts = {}) {
    const beforeSnap = window.dumpVeraVoiceState
      ? window.dumpVeraVoiceState({ silent: true })
      : null;
    try {
      _veraTtsCancelSource = "manual_reset_voice_runtime_state";
    } catch (_) {}
    try { if (typeof cancelMainTtsPlayback === "function") cancelMainTtsPlayback(); } catch (_) {}
    /* Belt + suspenders — cancelMainTtsPlayback already calls
       stopAllMainTtsWebAudio internally, but call again in case the
       function fails partway through. */
    try { if (typeof stopAllMainTtsWebAudio === "function") stopAllMainTtsWebAudio(); } catch (_) {}
    try {
      if (typeof activeMainTtsBufferSources !== "undefined") {
        activeMainTtsBufferSources.length = 0;
      }
    } catch (_) {}
    try { activeNdjsonBodyReader = null; } catch (_) {}
    try { mainTtsPlaybackActive = false; } catch (_) {}
    try {
      if (typeof getAudioEl === "function") {
        const a = getAudioEl();
        if (a) {
          try { a.pause(); } catch (_) {}
          try { a.currentTime = 0; } catch (_) {}
        }
      }
    } catch (_) {}
    try { interruptRecording = false; } catch (_) {}
    /* Per spec: leave fast-stop disarmed. The next TTS turn naturally
       re-arms it through resetVadFastStopState("main_tts_start"). */
    try { vadFastStopArmed = false; } catch (_) {}
    try { interruptBargeInLatched = false; } catch (_) {}
    try { interruptSpeechFrames = 0; } catch (_) {}
    try { interruptSpeechStart = 0; } catch (_) {}
    try { interruptSpeechAccumMs = 0; } catch (_) {}
    try { interruptPartialAccumMs = 0; } catch (_) {}
    try { interruptPartialLastChangeAt = 0; } catch (_) {}
    try { interruptPartialLastText = ""; } catch (_) {}
    try { _resetInterruptDelayTrace("manual_reset_voice_runtime_state"); } catch (_) {}

    const afterSnap = window.dumpVeraVoiceState
      ? window.dumpVeraVoiceState({ silent: true })
      : null;
    try {
      console.warn("[vera_voice_runtime_reset]", {
        at: new Date().toISOString(),
        opts,
        before: beforeSnap,
        after: afterSnap,
      });
    } catch (_) {}
    return { before: beforeSnap, after: afterSnap };
  };
})();

/* =============================================================================
 * STAGE 18 EXTRACTION (2026-05-31): BARGE-IN DEBUG OVERLAY
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js L648..L1207 (560 LF-terminated source lines,
 * re-terminated as CRLF here to match this file's native line endings).
 *
 * Stage 4 (2026-05-27) created this file and explicitly listed the entire
 * "BARGE-IN DEBUG OVERLAY" block as a future-move candidate (see the
 * header docstring above). Patch A-12 (this stage) completes that move.
 *
 * Symbols moved (all kept at file top-level so classic-script global
 * bare-identifier visibility is preserved):
 *   - const _veraBargeInDebug             (overlay state object)
 *   - function _bargeInDebugUiEnabled    (checks window flag + localStorage)
 *   - function _bargeInDebugCaptureEvent (hot-path event push; ring buffer)
 *   - function _bargeInDebugBuildState   (snapshots state for overlay/export)
 *   - function _bargeInDebugPositionOverlay (DOM positioning helper)
 *   - function _bargeInDebugMount        (creates overlay + render loop)
 *   - function _bargeInDebugUnmount      (tears down overlay + clears intervals)
 *   - function _bargeInDebugRender       (paints overlay innerHTML)
 *   - function _bargeInDebugBuildSnapshot (returns JSON snapshot for clipboard)
 *   - window.VERA_DEBUG_BARGE_IN_UI      (session flag echo)
 *   - window.toggleBargeInDebugUi         (imperative toggle + mount/unmount)
 *   - window.copyBargeInDebugSnapshot     (clipboard JSON dump)
 *   - 1 Hz polling setInterval            (watches the flag from any tab/tool)
 *   - setTimeout(0) auto-mount            (resumes overlay on page load)
 *
 * Intentionally LEFT in app.js per Patch A-12 scope: core interruption/
 * barge-in runtime, ASR code, TTS queue code, Work Mode TTS queue, infer
 * pipeline, handleUtterance. The hot-path state _veraInterruptRafLastAt
 * and _veraCurrentTtsDebugContext also stay in app.js (they are written
 * by the RAF detectInterrupt loop and NDJSON TTS playback, neither of
 * which is part of the overlay contract).
 *
 * External call sites (resolved via shared classic-script global lexical
 * environment at call time):
 *   - utils/logging.js logVeraInterruptDebug    (~1 call per interrupt event)
 *   - utils/logging.js logInterruptTranscriptDebug (per ASR transcript event)
 *   - voice/interruption.js logVeraInterruptDebug (re-export pathway)
 *
 * Hot-path safety: debug/voiceDebug.js loads AFTER app.js per index.html.
 * Each external call site is wrapped in try/catch AND uses a
 * `typeof _veraBargeInDebug !== "undefined"` +
 * `typeof _bargeInDebugCaptureEvent === "function"` guard so that an
 * in-flight ASR / TTS / interrupt event arriving before this file has
 * executed cannot throw a ReferenceError. typeof on an undeclared
 * global returns "undefined" without throwing, so the guard is safe in
 * both the pre-load and post-load states.
 *
 * Hard-rule preservation (Patch A-12):
 *   - window.toggleBargeInDebugUi          attachment UNCHANGED.
 *   - window.copyBargeInDebugSnapshot      attachment UNCHANGED.
 *   - window.VERA_DEBUG_BARGE_IN_UI        attachment UNCHANGED.
 *   - localStorage key "vera_debug_barge_in_ui" semantics UNCHANGED.
 *   - Overlay HTML markup + inline CSS preserved byte-identically.
 *   - 1 Hz polling interval + setTimeout(0) auto-mount preserved.
 *   - Console log keys [barge_in_debug_ui_toggled] and
 *     [barge_in_debug_snapshot_copied] preserved.
 *   - Ring-buffer cap (events.maxEvents) preserved.
 * ============================================================================= */

/* =========================================================================
 *  BARGE-IN DEBUG OVERLAY (dev-only diagnostic UI)
 *
 *  Goal: make voice-interruption gating visible in real time so we can see
 *  whether the bug is "VAD didn't fire", "barge-in gate blocked", "TTS
 *  cancel never fired", or "cancel fired but queued audio kept playing".
 *
 *  Enable:
 *    window.VERA_DEBUG_BARGE_IN_UI = true        // session-only
 *    localStorage.setItem("vera_debug_barge_in_ui", "1")  // persisted
 *    window.toggleBargeInDebugUi(true|false)     // imperative
 *
 *  Snapshot:
 *    window.copyBargeInDebugSnapshot()           // copies JSON to clipboard
 *
 *  The overlay is hidden when both the window flag and the localStorage flag
 *  are off, so normal users never see it. It piggybacks on existing
 *  logVeraInterruptDebug + logInterruptTranscriptDebug calls — no extra
 *  instrumentation is added to barge-in hot paths.
 * ========================================================================= */
const _veraBargeInDebug = {
  /* Cached enabled flag — flipped by the polling tick / toggle so hot-path
   * event capture is a single boolean check. */
  enabled: false,

  /* Ring buffer of the last few interruption-related events. */
  events: [],
  maxEvents: 14,

  /* Latched timestamps for the cancel-delay summary line. */
  ttsStartedAt: 0,
  lastSpeechDetectedAt: 0,
  lastTtsCancelCalledAt: 0,
  lastInterruptEntryAt: 0,
  lastEarlyReturnReason: null,
  lastCancelSource: null,

  /* Last render-blocking timings (filled when news_panel_render_end /
   * interrupt_raf_gap fire). */
  lastNewsRenderDurationMs: 0,
  lastRafGapMs: 0,

  /* DOM + render loop. */
  containerEl: null,
  bodyEl: null,
  renderIntervalId: null,
  pollIntervalId: null,
};

function _bargeInDebugUiEnabled() {
  try {
    if (typeof window !== "undefined" && window.VERA_DEBUG_BARGE_IN_UI === true) return true;
  } catch (_) {}
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("vera_debug_barge_in_ui") === "1") return true;
  } catch (_) {}
  /* Cleanup-pass additive gate: anyone in unified dev mode also sees the
   * overlay. Pre-existing per-feature flags above keep working unchanged. */
  try {
    if (typeof isVeraDevMode === "function" && isVeraDevMode()) return true;
  } catch (_) {}
  return false;
}

/** Hot-path event capture. Called from logVeraInterruptDebug and
 *  logInterruptTranscriptDebug *before* any gating, so timeline events are
 *  recorded whenever the debug overlay is on (independent of
 *  VERA_DEBUG_INTERRUPT). */
function _bargeInDebugCaptureEvent(eventName, payload) {
  if (!_veraBargeInDebug.enabled) return;
  try {
    const nowMs = performance.now();
    const name = String(eventName || "event");
    const p = payload && typeof payload === "object" ? payload : { value: payload };

    if (name === "tts_start") _veraBargeInDebug.ttsStartedAt = nowMs;
    if (name === "speech_detected") _veraBargeInDebug.lastSpeechDetectedAt = nowMs;
    if (name === "tts_cancel_called") {
      _veraBargeInDebug.lastTtsCancelCalledAt = nowMs;
      if (p?.source) _veraBargeInDebug.lastCancelSource = p.source;
    }
    if (name === "interrupt_speech_entry") {
      if (p?.outcome === "early_return") {
        _veraBargeInDebug.lastEarlyReturnReason = p?.reasonIfReturn || "early_return";
      } else if (p?.outcome === "proceed_cancel_tts") {
        _veraBargeInDebug.lastInterruptEntryAt = nowMs;
        _veraBargeInDebug.lastEarlyReturnReason = null;
      }
    }
    if (name === "news_panel_render_end" && Number.isFinite(p?.durationMs)) {
      _veraBargeInDebug.lastNewsRenderDurationMs = Number(p.durationMs);
    }
    if (name === "interrupt_raf_gap" && Number.isFinite(p?.gapMs)) {
      _veraBargeInDebug.lastRafGapMs = Number(p.gapMs);
    }

    const sinceTtsStartMs =
      _veraBargeInDebug.ttsStartedAt > 0
        ? Number((nowMs - _veraBargeInDebug.ttsStartedAt).toFixed(1))
        : null;

    _veraBargeInDebug.events.push({
      event: name,
      perfNow: Number(nowMs.toFixed(1)),
      sinceTtsStartMs,
      payload: p,
    });
    if (_veraBargeInDebug.events.length > _veraBargeInDebug.maxEvents) {
      _veraBargeInDebug.events.shift();
    }
  } catch (_) {}
}

function _bargeInDebugBuildState() {
  const base =
    typeof window !== "undefined" && typeof window.dumpVeraVoiceState === "function"
      ? window.dumpVeraVoiceState({ silent: true })
      : {};
  const extras = base?.extras || {};

  const ttsPlaying = Boolean(
    base.mainTtsPlaybackActive ||
      (base.activeMainTtsBufferSourcesCount || 0) > 0 ||
      (typeof isAssistantTtsPlaying === "function" && isAssistantTtsPlaying())
  );
  const useBrowserAsr = base.browserAsrPreferred === true;
  const recorderReady =
    Boolean(base.interruptRecording) ||
    extras.interruptDetectRecognitionPresent === true;
  const continuous = base.continuousListeningEnabled === true;
  const micActive = extras.micStreamActive === true;
  const vadArmed = base.vadFastStopArmed === true;
  const latched = extras.interruptBargeInLatched === true;
  const audioCtxState = extras.audioCtxState || null;

  /* Reflect the *actual* gate logic. Order matters — first failing gate wins
   * so the displayed reason matches what the runtime would reject on. */
  let allowed = true;
  let reason = "allowed";
  if (!continuous) {
    allowed = false;
    reason = "not_continuous";
  } else if (!ttsPlaying) {
    allowed = false;
    reason = "no_tts_playing";
  } else if (extras.appHidden === true) {
    allowed = false;
    reason = "app_hidden_or_throttled";
  } else if (!micActive) {
    allowed = false;
    reason = "mic_stream_inactive";
  } else if (audioCtxState && audioCtxState !== "running") {
    allowed = false;
    reason = `audio_ctx_${audioCtxState}`;
  } else if (latched) {
    allowed = false;
    reason = "already_latched";
  } else if (!vadArmed) {
    allowed = false;
    reason = "vad_not_armed";
  } else if (!useBrowserAsr && !recorderReady) {
    /* The suspected single-ASR bug gate — gets surfaced verbatim. */
    allowed = false;
    reason = "interrupt_recording_false_single_asr";
  } else if (useBrowserAsr && extras.interruptDetectRecognitionPresent !== true) {
    allowed = false;
    reason = "interrupt_detect_recognition_missing";
  }

  const speechAt = _veraBargeInDebug.lastSpeechDetectedAt;
  const cancelAt = _veraBargeInDebug.lastTtsCancelCalledAt;
  const cancelDelayMs =
    speechAt > 0 && cancelAt >= speechAt
      ? Number((cancelAt - speechAt).toFixed(1))
      : null;

  return {
    timestamp: new Date().toISOString(),
    bargeIn: {
      allowed,
      reason,
      vadArmed,
      latched,
      useBrowserAsr,
      continuous,
      micActive,
      ttsPlaying,
      recorderReady,
    },
    voice: {
      asrMode: base.asrMode,
      listeningMode: base.listeningMode,
      micState: base.micState,
      inputMuted: base.inputMuted,
      workModeOn: base.workModeOn,
      workModeMuteEnabled: base.workModeMuteEnabled,
    },
    tts: {
      playing: ttsPlaying,
      mainTtsPlaybackActive: base.mainTtsPlaybackActive,
      bufferSources: base.activeMainTtsBufferSourcesCount,
      ndjsonReaderPresent: base.activeNdjsonBodyReaderPresent,
      ttsId: base.currentTtsId,
      token: base.mainTtsPlaybackToken,
    },
    vad: {
      armed: vadArmed,
      speechFrames: extras.interruptSpeechFrames,
      speechAccumMs: extras.interruptSpeechAccumMs,
      partialAccumMs: extras.interruptPartialAccumMs,
      partialLastText: extras.interruptPartialLastText,
      sinceTtsStartMs:
        _veraBargeInDebug.ttsStartedAt > 0
          ? Number((performance.now() - _veraBargeInDebug.ttsStartedAt).toFixed(0))
          : null,
    },
    capture: {
      interruptRecording: base.interruptRecording,
      prearmRecorderState: base.interruptPrearmRecorderState,
      detectRecognitionPresent: extras.interruptDetectRecognitionPresent,
      mainBrowserRecognitionPresent: extras.mainBrowserRecognitionPresent,
      browserAsrPermanentlyDisabled: extras.browserAsrPermanentlyDisabled,
    },
    cancel: {
      lastSpeechDetectedPerfNow: speechAt > 0 ? Number(speechAt.toFixed(1)) : null,
      lastTtsCancelCalledPerfNow: cancelAt > 0 ? Number(cancelAt.toFixed(1)) : null,
      cancelDelayMs,
      lastInterruptEntryPerfNow:
        _veraBargeInDebug.lastInterruptEntryAt > 0
          ? Number(_veraBargeInDebug.lastInterruptEntryAt.toFixed(1))
          : null,
      lastEarlyReturnReason: _veraBargeInDebug.lastEarlyReturnReason,
      lastCancelSource:
        _veraBargeInDebug.lastCancelSource ||
        (typeof _veraTtsCancelSource !== "undefined" ? _veraTtsCancelSource : null) ||
        null,
    },
    newsRender: {
      duringNewsRender: extras.duringNewsRender,
      lastNewsRenderDurationMs: _veraBargeInDebug.lastNewsRenderDurationMs,
      lastRafGapMs: _veraBargeInDebug.lastRafGapMs,
      appHidden: extras.appHidden,
      appVisibilityState: extras.appVisibilityState,
      audioCtxState,
    },
    events: _veraBargeInDebug.events.slice().reverse(),
    underlyingDump: base,
  };
}

function _bargeInDebugPositionOverlay() {
  if (!_veraBargeInDebug.containerEl) return;
  /* Anchor to the left of the active record/mic button when one is
   * mounted (VERA + BMO modes). Fallback to fixed bottom-right corner. */
  let anchor = null;
  try {
    const candidates = ["vera-record", "bmo-record"];
    for (const id of candidates) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        anchor = { el: btn, rect };
        break;
      }
    }
  } catch (_) {}

  const el = _veraBargeInDebug.containerEl;
  el.style.position = "fixed";
  el.style.left = "auto";
  if (anchor) {
    const overlayW = el.offsetWidth || 320;
    const leftPx = Math.max(8, anchor.rect.left - overlayW - 12);
    const topPx = Math.max(8, anchor.rect.top - el.offsetHeight + anchor.rect.height);
    el.style.left = `${leftPx}px`;
    el.style.top = `${topPx}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  } else {
    el.style.right = "16px";
    el.style.bottom = "16px";
    el.style.top = "auto";
  }
}

function _bargeInDebugMount() {
  if (typeof document === "undefined") return;
  if (!_bargeInDebugUiEnabled()) return;
  if (_veraBargeInDebug.containerEl && _veraBargeInDebug.containerEl.isConnected) return;

  const el = document.createElement("div");
  el.id = "vera-barge-in-debug-overlay";
  el.setAttribute("data-vera-dev-overlay", "barge-in");
  el.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "width:320px",
    "max-height:70vh",
    "overflow:auto",
    "background:rgba(8,12,18,0.96)",
    "color:#d8e1ea",
    "font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "border:1px solid rgba(120,135,160,0.4)",
    "border-radius:8px",
    "padding:8px 10px 10px 10px",
    "z-index:2147483646",
    "box-shadow:0 4px 14px rgba(0,0,0,0.4)",
    "pointer-events:auto",
    "user-select:text",
  ].join(";");
  el.innerHTML =
    '<div data-bd-header style="display:flex;align-items:center;justify-content:space-between;margin:-2px -2px 6px;gap:6px;">' +
    '  <strong style="font-size:11px;letter-spacing:.04em;color:#79c8ff;">BARGE-IN DEBUG <span style="color:#666;font-weight:400;">(dev)</span></strong>' +
    '  <span style="display:flex;gap:4px;">' +
    '    <button data-bd-copy  type="button" title="Copy snapshot to clipboard" style="background:#1a2433;color:#cfe;border:1px solid #325;padding:2px 6px;border-radius:4px;font:11px/1 inherit;cursor:pointer;">Copy</button>' +
    '    <button data-bd-reset type="button" title="Dev reset of voice runtime state" style="background:#3a1a1a;color:#fcc;border:1px solid #532;padding:2px 6px;border-radius:4px;font:11px/1 inherit;cursor:pointer;">Reset</button>' +
    '    <button data-bd-close type="button" title="Hide overlay" style="background:transparent;color:#9aa;border:1px solid #555;padding:2px 6px;border-radius:4px;font:11px/1 inherit;cursor:pointer;">×</button>' +
    '  </span>' +
    '</div>' +
    '<div data-bd-body></div>';
  document.body.appendChild(el);
  _veraBargeInDebug.containerEl = el;
  _veraBargeInDebug.bodyEl = el.querySelector("[data-bd-body]");

  el.querySelector("[data-bd-copy]").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { window.copyBargeInDebugSnapshot(); } catch (_) {}
  });
  el.querySelector("[data-bd-reset]").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window.resetVeraVoiceRuntimeState === "function") {
      try {
        window.resetVeraVoiceRuntimeState({ source: "barge_in_debug_overlay" });
      } catch (_) {}
    } else {
      try { console.warn("[barge_in_debug] resetVeraVoiceRuntimeState not available"); } catch (_) {}
    }
  });
  el.querySelector("[data-bd-close]").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    /* Closing the overlay disables the flag so it doesn't re-mount on the
     * next polling tick. The user can re-enable with toggleBargeInDebugUi(true). */
    try { window.VERA_DEBUG_BARGE_IN_UI = false; } catch (_) {}
    safeRemoveLocalStorage("vera_debug_barge_in_ui");
    _bargeInDebugUnmount();
  });

  if (_veraBargeInDebug.renderIntervalId == null) {
    _veraBargeInDebug.renderIntervalId = setInterval(() => {
      if (!_bargeInDebugUiEnabled()) {
        _bargeInDebugUnmount();
        return;
      }
      _bargeInDebugRender();
    }, 200);
  }
  _bargeInDebugRender();
}

function _bargeInDebugUnmount() {
  if (_veraBargeInDebug.renderIntervalId != null) {
    try { clearInterval(_veraBargeInDebug.renderIntervalId); } catch (_) {}
    _veraBargeInDebug.renderIntervalId = null;
  }
  if (_veraBargeInDebug.containerEl && _veraBargeInDebug.containerEl.parentNode) {
    try { _veraBargeInDebug.containerEl.parentNode.removeChild(_veraBargeInDebug.containerEl); } catch (_) {}
  }
  _veraBargeInDebug.containerEl = null;
  _veraBargeInDebug.bodyEl = null;
}

function _bargeInDebugEscapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _bargeInDebugRender() {
  if (!_veraBargeInDebug.bodyEl) return;
  let s;
  try { s = _bargeInDebugBuildState(); } catch (_) { return; }

  const colAllowed = s.bargeIn.allowed ? "#7fe39a" : "#ff6b6b";
  const colTts = s.tts.playing ? "#7fe39a" : "#9aa";
  const sentinelRed = s.tts.mainTtsPlaybackActive && (s.tts.bufferSources || 0) === 0;
  const colSentinel = sentinelRed ? "#ff6b6b" : "#9aa";

  /* Cancel-delay color: green if cancel fired within 80 ms of speech detect,
   * yellow up to 250 ms, red beyond that or if no cancel after a recent
   * speech_detected. */
  let colCancel = "#9aa";
  let cancelText = "—";
  if (s.cancel.cancelDelayMs != null) {
    cancelText = `${s.cancel.cancelDelayMs}ms`;
    if (s.cancel.cancelDelayMs <= 80) colCancel = "#7fe39a";
    else if (s.cancel.cancelDelayMs <= 250) colCancel = "#f3d36b";
    else colCancel = "#ff6b6b";
  } else if (
    s.cancel.lastSpeechDetectedPerfNow != null &&
    s.tts.playing &&
    performance.now() - s.cancel.lastSpeechDetectedPerfNow > 200
  ) {
    colCancel = "#ff6b6b";
    cancelText = "none (TTS still playing)";
  }

  /* VAD color: green if armed + speech accum > 0, yellow if accumulating but
   * threshold not yet passed (rough proxy: speechAccumMs > 0 but no
   * speech_detected this turn). */
  let colVad = "#9aa";
  if (s.vad.armed) {
    if ((s.vad.speechAccumMs || 0) > 0) colVad = "#f3d36b";
    else colVad = "#7fe39a";
  } else {
    /* If TTS is playing but VAD is not armed, that's actually a red flag —
     * caller would be blocked. */
    colVad = s.tts.playing ? "#ff6b6b" : "#9aa";
  }

  const esc = _bargeInDebugEscapeHtml;
  const eventsHtml = s.events.slice(0, 10).map((ev) => {
    const sinceTts =
      ev.sinceTtsStartMs != null ? `+${Math.round(ev.sinceTtsStartMs)}ms` : "—";
    const extras = [];
    if (ev.payload?.outcome) extras.push(`outcome=${ev.payload.outcome}`);
    if (ev.payload?.reasonIfReturn) extras.push(`reason=${ev.payload.reasonIfReturn}`);
    if (ev.payload?.event) extras.push(`event=${ev.payload.event}`);
    if (ev.payload?.source) extras.push(`src=${ev.payload.source}`);
    if (Number.isFinite(ev.payload?.durationMs)) extras.push(`dur=${Math.round(ev.payload.durationMs)}ms`);
    if (Number.isFinite(ev.payload?.gapMs)) extras.push(`gap=${Math.round(ev.payload.gapMs)}ms`);
    if (ev.payload?.gatePath) extras.push(`gate=${ev.payload.gatePath}`);
    const extraStr = extras.length
      ? ` <span style="color:#9aa;">${esc(extras.join(" "))}</span>`
      : "";
    return (
      `<div style="display:flex;gap:6px;line-height:1.35;">` +
      `<span style="color:#79c8ff;min-width:64px;font-variant-numeric:tabular-nums;">${esc(sinceTts)}</span>` +
      `<span style="color:#d8e1ea;">${esc(ev.event)}${extraStr}</span>` +
      `</div>`
    );
  }).join("");

  const ttsIdShort = s.tts.ttsId ? String(s.tts.ttsId).slice(0, 22) : "—";
  const tokShort = s.tts.token == null ? "—" : String(s.tts.token);

  _veraBargeInDebug.bodyEl.innerHTML =
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:2px 8px;">' +
      `<div style="color:#9aa;">ASR</div><div>${esc(s.voice.asrMode || "?")} <span style="color:#9aa;">(${esc(s.voice.listeningMode || "?")})</span></div>` +
      `<div style="color:#9aa;">Mic</div><div>${esc(s.voice.micState || "?")}${s.voice.inputMuted ? ' <span style="color:#f3d36b;">(muted)</span>' : ""}</div>` +
      `<div style="color:#9aa;">TTS</div><div style="color:${colTts};">${s.tts.playing ? "playing" : "idle"} <span style="color:#9aa;">srcs=${esc(s.tts.bufferSources ?? "?")} rdr=${s.tts.ndjsonReaderPresent ? "y" : "n"}</span></div>` +
      `<div style="color:#9aa;">Ids</div><div style="color:#9aa;font-size:10px;">tts=${esc(ttsIdShort)} tok=${esc(tokShort)}</div>` +
      `<div style="color:#9aa;">Sentinel</div><div style="color:${colSentinel};">${s.tts.mainTtsPlaybackActive ? "active" : "inactive"}${sentinelRed ? ' <span style="color:#ff6b6b;">(no tracked srcs!)</span>' : ""}</div>` +
      `<div style="color:#9aa;">Barge-in</div><div style="color:${colAllowed};font-weight:600;">${s.bargeIn.allowed ? "ALLOWED" : "BLOCKED"} <span style="color:#9aa;font-weight:400;">(${esc(s.bargeIn.reason)})</span></div>` +
      `<div style="color:#9aa;">VAD</div><div style="color:${colVad};">armed=${s.vad.armed ? "y" : "n"} speech=${esc(s.vad.speechAccumMs ?? 0)}ms partial=${esc(s.vad.partialAccumMs ?? 0)}ms</div>` +
      `<div style="color:#9aa;">Frames</div><div>frames=${esc(s.vad.speechFrames ?? 0)} sinceTts=${esc(s.vad.sinceTtsStartMs ?? "—")}ms</div>` +
      `<div style="color:#9aa;">Capture</div><div>recIntr=${s.capture.interruptRecording ? "y" : "n"} prearm=${esc(s.capture.prearmRecorderState ?? "—")} detect=${s.capture.detectRecognitionPresent ? "y" : "n"}</div>` +
      `<div style="color:#9aa;">Cancel</div><div style="color:${colCancel};">delay=${esc(cancelText)} <span style="color:#9aa;">early=${esc(s.cancel.lastEarlyReturnReason ?? "—")} src=${esc(s.cancel.lastCancelSource ?? "—")}</span></div>` +
      `<div style="color:#9aa;">Render</div><div>news=${s.newsRender.duringNewsRender ? "y" : "n"} hidden=${s.newsRender.appHidden ? "y" : "n"} actx=${esc(s.newsRender.audioCtxState ?? "—")} nrDur=${esc(Math.round(s.newsRender.lastNewsRenderDurationMs || 0))}ms rafGap=${esc(Math.round(s.newsRender.lastRafGapMs || 0))}ms</div>` +
    '</div>' +
    '<div style="margin-top:6px;border-top:1px solid rgba(120,135,160,0.25);padding-top:5px;">' +
      '<div style="color:#9aa;margin-bottom:2px;">Events (most recent first):</div>' +
      (eventsHtml || '<div style="color:#666;">(no events yet — start a TTS turn and speak over it)</div>') +
    '</div>';

  /* Re-anchor after layout changes (mic button position can shift between
   * VERA and BMO modes or when the side panel opens). */
  try { _bargeInDebugPositionOverlay(); } catch (_) {}
}

function _bargeInDebugBuildSnapshot() {
  let snap = null;
  try { snap = _bargeInDebugBuildState(); } catch (_) {}
  return snap;
}

if (typeof window !== "undefined") {
  try {
    window.VERA_DEBUG_BARGE_IN_UI = _bargeInDebugUiEnabled();
  } catch (_) {}

  /* Imperative toggle — flips both the in-memory flag and the localStorage
   * persistence, then mounts/unmounts immediately. */
  window.toggleBargeInDebugUi = function toggleBargeInDebugUi(force) {
    const next = typeof force === "boolean" ? force : !_bargeInDebugUiEnabled();
    try { window.VERA_DEBUG_BARGE_IN_UI = next; } catch (_) {}
    if (next) safeSetLocalStorage("vera_debug_barge_in_ui", "1");
    else safeRemoveLocalStorage("vera_debug_barge_in_ui");
    _veraBargeInDebug.enabled = next;
    if (next) {
      if (typeof document !== "undefined" && document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _bargeInDebugMount, { once: true });
      } else {
        _bargeInDebugMount();
      }
    } else {
      _bargeInDebugUnmount();
    }
    try {
      console.warn("[barge_in_debug_ui_toggled]", { enabled: next });
    } catch (_) {}
    return next;
  };

  /* Clipboard snapshot — usable from devtools without the overlay open. */
  window.copyBargeInDebugSnapshot = function copyBargeInDebugSnapshot() {
    const snap = _bargeInDebugBuildSnapshot();
    const text = JSON.stringify(snap, null, 2);
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand("copy"); } catch (_) {}
        document.body.removeChild(ta);
      }
    } catch (_) {}
    try { console.info("[barge_in_debug_snapshot_copied]", snap); } catch (_) {}
    return snap;
  };

  /* Low-frequency polling so the user can flip
   *   window.VERA_DEBUG_BARGE_IN_UI = true
   * (or set the localStorage key from another tab) and have the overlay
   * appear without an explicit toggle call. Stops itself once mounted. */
  if (_veraBargeInDebug.pollIntervalId == null) {
    _veraBargeInDebug.pollIntervalId = setInterval(() => {
      const wantOn = _bargeInDebugUiEnabled();
      const isOn = !!_veraBargeInDebug.containerEl;
      if (wantOn !== _veraBargeInDebug.enabled) _veraBargeInDebug.enabled = wantOn;
      if (wantOn && !isOn) _bargeInDebugMount();
      if (!wantOn && isOn) _bargeInDebugUnmount();
    }, 1000);
  }

  /* Auto-mount if a previous session left the flag set. */
  setTimeout(() => {
    if (_bargeInDebugUiEnabled()) {
      _veraBargeInDebug.enabled = true;
      if (typeof document !== "undefined" && document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _bargeInDebugMount, { once: true });
      } else {
        _bargeInDebugMount();
      }
    }
  }, 0);
}


/* =============================================================================
 * STAGE 19 EXTRACTION (2026-05-31): UNIFIED DEV-MODE FLAG
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js L47..L79 (33 LF-terminated source lines,
 * re-terminated as CRLF here to match this file's native line endings).
 *
 * The cleanup pass on 2026-05-27 introduced `isVeraDevMode()` as the unified
 * dev-only gate that future overlays / dump commands should branch on instead
 * of inventing a new per-feature flag. _bargeInDebugUiEnabled() (this file)
 * already consumes it as the additive dev-mode override above the existing
 * window.VERA_DEBUG_BARGE_IN_UI + localStorage "vera_debug_barge_in_ui" gates.
 *
 * Symbols moved (function declaration so it hoists within this file, plus
 * the window attachment guarded by `typeof window !== "undefined"`):
 *   - function isVeraDevMode()                  (3 sources: window.VERA_DEV_MODE,
 *                                                localStorage "vera_dev_mode", false)
 *   - window.isVeraDevMode = isVeraDevMode      (DevTools-friendly alias)
 *
 * No other module in this codebase calls `isVeraDevMode` as of Patch A-13.
 * The only caller is _bargeInDebugUiEnabled in this same file, which uses
 * `typeof isVeraDevMode === "function" && isVeraDevMode()` as a defensive
 * guard â€” that pattern is kept as a same-file lookup so it continues to be
 * safe even before the function declaration is reached during execution.
 *
 * Hard-rule preservation (Patch A-13):
 *   - localStorage key "vera_dev_mode" semantics UNCHANGED.
 *   - window.VERA_DEV_MODE === true short-circuit UNCHANGED.
 *   - window.isVeraDevMode attachment UNCHANGED (DevTools alias preserved).
 *   - Existing per-feature debug flags (VERA_DEBUG_INTERRUPT,
 *     VERA_DEBUG_BARGE_IN_UI, VERA_DEBUG_TRANSCRIPTS, ...) UNCHANGED.
 *   - The backend env-var contract (VERA_DEV_MODE=1 in app.py) UNCHANGED.
 * ============================================================================= */

/* =========================
   UNIFIED DEV-MODE FLAG  (added during cleanup pass, 2026-05-27)

   `isVeraDevMode()` is the single switch that gates ALL future
   dev-only overlays, console timelines, dump commands and smoke
   runners. Today it is purely additive — existing per-feature flags
   like `VERA_DEBUG_INTERRUPT` and `VERA_DEBUG_BARGE_IN_UI` continue
   to work unchanged. New diagnostics added after this date should
   key off `isVeraDevMode()` instead of inventing a new per-feature
   flag.

   Enable for the session:
     window.VERA_DEV_MODE = true
   Persist across reloads:
     localStorage.setItem("vera_dev_mode", "1")

   The matching backend env var is VERA_DEV_MODE=1 — checked in
   `app.py` if/when we move smoke runners or dev endpoints under it.
========================= */
function isVeraDevMode() {
  try {
    if (typeof window !== "undefined" && window.VERA_DEV_MODE === true) return true;
  } catch (_) {}
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("vera_dev_mode") === "1") return true;
  } catch (_) {}
  return false;
}
try {
  if (typeof window !== "undefined") {
    window.isVeraDevMode = isVeraDevMode;
  }
} catch (_) {}
