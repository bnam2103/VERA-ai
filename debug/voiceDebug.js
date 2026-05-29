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
