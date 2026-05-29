/* =========================================================================
 *  voice/interruption.js — interruption / barge-in helper layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 6). Behavior is preserved EXACTLY:
 *    - same function bodies (no logic changes),
 *    - same console labels (`[interrupt_delay_trace]`,
 *      `[voice_state_transition]`, `[tts_cancel_source_trace]`,
 *      `[interrupt_speech_entry]`, ...),
 *    - same debug-flag gates (`window.VERA_DEBUG_INTERRUPT`),
 *    - same cancel-source semantics (`_veraTtsCancelSource`).
 *  No interruption redesign. No per-turn TTS IDs. No chunking changes.
 *  No barge-in user-visible flow changes. No ASR mode changes. No
 *  Work Mode / panel / checklist / music / news behavior changes.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come AFTER voice/ttsQueue.js (so the TTS cancel
 *  API is available) and BEFORE app.js (so the moved `let` bindings
 *  are initialized before any app.js function body call-site can read
 *  or assign through the shared classic-script global lexical env).
 *
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="voice/interruption.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  TTS API consumed (provided by voice/ttsQueue.js, called from within
 *  this module's function bodies — resolved at call time):
 *    - cancelMainTtsPlayback(...)
 *    - isMainTtsPlaying()   (only used by the new getInterruptionDebugState)
 *
 *  Bare-identifier references in the moved functions (all resolved at
 *  CALL TIME through the shared global lexical env, not at module load):
 *    audioCtx-free side:  isAssistantTtsPlaying, getAudioEl,
 *                         resetAudioHandlers, setStatus, browserAsrPreferred,
 *                         cancelBrowserInterruptTtsOnly,
 *                         promoteInterruptPreviewToMainLiveBubble,
 *                         startPostInterruptBrowserRecognition,
 *                         detectInterruptSpeechEnd, MAX_INTERRUPTION_PREROLL_MS,
 *                         interruptRecording, interruptPrearmCommittedAt,
 *                         interruptPrearmStartedAt, interruptPrearmTtsId,
 *                         interruptDetectRecognition, mainBrowserRecognition,
 *                         logBargeInLatencyDebug, logInterruptTranscriptDebug,
 *                         audioStartedAt, listening, listeningMode, waveState,
 *                         activeMainTtsBufferSources, mainTtsPlaybackActive,
 *                         activeNdjsonBodyReader, _veraBargeInDebug,
 *                         _bargeInDebugCaptureEvent, _veraNewsPanelRenderInFlight.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers AND as window.* aliases)
 *  ─────────────────────────────────────────────────────────────────────
 *    debug-gate            isVeraInterruptDebugEnabled()
 *    debug-log             logVeraInterruptDebug(payload, opts)
 *    cancel-source state   _veraTtsCancelSource (let, RW)
 *    delay-trace state     _veraInterruptDelayTrace, _veraInterruptAttemptSeq
 *    delay-trace helpers   _newInterruptAttemptId(),
 *                          _resetInterruptDelayTrace(reason),
 *                          _ensureInterruptDelayTrace(startingField),
 *                          _recordInterruptTimingPoint(field, opts),
 *                          _flushInterruptDelayTrace(reason)
 *    transition / source   _logVoiceStateTransition(from, to, reason, fn, extra),
 *                          _logTtsCancelSourceTrace(fnLabel, reason, extra)
 *    fast-stop state       vadFastStopArmed (let), vadFastStopFiredAt (let),
 *                          vadFastStopTtsStoppedAt (let),
 *                          vadFastStopAsrFinalAt (let), vadFastStopTtsId (let)
 *    barge-in latch        interruptBargeInLatched (let)
 *    fast-stop reset       resetVadFastStopState(reason)
 *    voice barge-in        fastStopTtsOnVadOnly({rms, zcr, crest, vadAccumMs})
 *    single-ASR cancel     interruptSpeech()
 *    tts-id helper         interruptTranscriptNewTtsId()
 *    accessor (new)        getInterruptionDebugState()   // read-only snapshot
 *
 *  Helpers / state intentionally LEFT in app.js (and why):
 *    detectInterrupt (RAF VAD loop)          - tight DOM/analyser/RAF coupling.
 *    detectInterruptSpeechEnd                - RAF continuation of the loop above.
 *    cancelBrowserInterruptTtsOnly           - mutates many VAD/SR/UI state
 *                                              vars (interruptSpeechFrames,
 *                                              lastInterruptSpeechLikeSnapshot,
 *                                              mainBrowserLiveBubble, …).
 *    promoteInterruptPreviewToMainLiveBubble - direct DOM bubble surgery.
 *    startPostInterruptBrowserRecognition    - Web Speech API session setup.
 *    onBrowserInterruptBargeInFromDetect     - SR event handler.
 *    clearInterruptDetectionBubble           - DOM cleanup helper.
 *    interruptAssistantPipelineForTypedMessage - typed-pipeline barge-in
 *                                              touches activePipelineAbort,
 *                                              voiceUxTurn, textUxTurn,
 *                                              processing, requestInFlight,
 *                                              cancelPendingNewsStatusBubble.
 *    interrupt recorder state                 (interruptRecorder,
 *      interruptChunks, interruptRecording,
 *      interruptPrearm* group)               - touched by deep MediaRecorder
 *                                              start/stop flows + the RAF
 *                                              loop above; keeping them in
 *                                              app.js avoids reshuffling
 *                                              the recorder lifecycle.
 *    interruptSpeechFrames / Start / AccumMs / lastInterruptDetectTime
 *      / interruptLastSpeechLikeTime / lastInterruptProbe
 *      / lastInterruptSpeechLikeSnapshot / interruptLastVoiceTime
 *      / interruptVadLogLines / INTERRUPT_VAD_LOG_MAX
 *      / lastMobileVadSampleLogAt / MOBILE_VAD_SAMPLE_INTERVAL_MS
 *                                            - VAD / heuristic loop state.
 *    interruptDetectionBubbleEl, interruptDetectRecognition,
 *      interruptBrowserDetectActive,
 *      interruptPartial* (4 vars), interruptDetectNoResultWatchdogTimer,
 *      interruptBrowserMinWords
 *                                            - browser-ASR detector +
 *                                              interim transcript state.
 *    _veraInterruptRafLastAt                 - RAF gap tracker owned by
 *                                              detectInterrupt.
 *    _veraNewsPanelRenderInFlight, _veraCurrentTtsDebugContext
 *                                            - render/NDJSON trace state.
 *    Barge-in debug OVERLAY (`_veraBargeInDebug` object,
 *      `_bargeInDebugUiEnabled`, `_bargeInDebugCaptureEvent`,
 *      `window.toggleBargeInDebugUi`, `window.copyBargeInDebugSnapshot`,
 *      DOM render loop, …)                   - per Stage 4 spec, this DOM
 *                                              overlay stays in app.js
 *                                              because of its container/body
 *                                              element render coupling.
 *                                              logVeraInterruptDebug here
 *                                              still feeds it via the
 *                                              shared lexical env.
 * ========================================================================= */

/* =========================
   DEBUG GATE + LOGGER
========================= */

/* Single-ASR interruption debug instrumentation.
 *   Enable from devtools:  window.VERA_DEBUG_INTERRUPT = true
 *   No control-flow changes — only console.info via the helper below.
 *   Logs are gated and high-frequency calls (per VAD frame) support
 *   throttleKey/throttleMs so the console stays readable. */
const _veraInterruptDebugLastAt = new Map();

function isVeraInterruptDebugEnabled() {
  try {
    return typeof window !== "undefined" && window.VERA_DEBUG_INTERRUPT === true;
  } catch (_) {
    return false;
  }
}

function logVeraInterruptDebug(payload, opts = {}) {
  /* Feed the barge-in debug overlay timeline BEFORE any gating so the
   * overlay works without requiring VERA_DEBUG_INTERRUPT to also be on.
   * Hot-path cost when overlay is off: a single boolean check. */
  try {
    if (_veraBargeInDebug?.enabled) {
      const tag = payload?.tag || "interrupt_debug";
      _bargeInDebugCaptureEvent(tag, payload);
    }
  } catch (_) {}
  if (!isVeraInterruptDebugEnabled()) return;
  try {
    const tag = payload?.tag || "interrupt_debug";
    if (opts.throttleKey) {
      const minMs = Number(opts.throttleMs) > 0 ? Number(opts.throttleMs) : 250;
      const nowMs = performance.now();
      const last = _veraInterruptDebugLastAt.get(opts.throttleKey) || 0;
      if (nowMs - last < minMs) return;
      _veraInterruptDebugLastAt.set(opts.throttleKey, nowMs);
    }
    console.info(`[${tag}]`, payload);
  } catch (_) {}
}

/* =========================
   CANCEL-SOURCE LABEL
========================= */

/** Module-level "next cancellation source" label for cancelMainTtsPlayback.
 *  Callers may set this synchronously immediately before calling cancel so
 *  the cancel log can record who initiated it without changing function
 *  signatures. Consumed on read. */
let _veraTtsCancelSource = "";

/* =========================
   DELAYED-INTERRUPTION TIMING TRACE
========================= */

/* Delayed-interruption timing instrumentation (additive only).
 *
 * Enable from devtools:  window.VERA_DEBUG_INTERRUPT = true
 *
 * Tracks the timeline of a single interruption attempt:
 *   t0  first speech-like VAD frame detected (audio energy)
 *   t1  first non-empty interim transcript from the browser SR
 *   t2  latest interim transcript update (continuously refreshed)
 *   t3  first final transcript fragment from the browser SR
 *   t4  interrupt intent detected (gate passed: VAD threshold or
 *       browser-ASR word/sustain gate)
 *   t5  interruptSpeech / fastStopTtsOnVadOnly / barge-in handler entered
 *   t6  cancelMainTtsPlayback called
 *   t7  stopAllMainTtsWebAudio called
 *   t8  UI status set to "Listening… (interrupted)" (speaking → interrupted)
 *   t9  voice state flipped to listening (waveState/listening flags)
 *   t10 active Web Audio buffer source count reached zero
 *   t11 audio element paused and reset (audibly silenced)
 *
 * No control-flow changes: these helpers are read-only side effects that
 * push entries onto a per-turn object and emit a single
 * [interrupt_delay_trace] log when the cancel pipeline finishes.
 *
 * Reset hook lives in resetVadFastStopState() so every TTS turn start
 * (main reply, ndjson, action TTS, interrupt reply) clears any
 * leftover trace from the previous turn. */
let _veraInterruptDelayTrace = null;
let _veraInterruptAttemptSeq = 0;

function _newInterruptAttemptId() {
  _veraInterruptAttemptSeq++;
  const ts = (Date.now() % 1_000_000).toString(36);
  return `att_${ts}_${_veraInterruptAttemptSeq}`;
}

function _resetInterruptDelayTrace(reason = "") {
  const had = _veraInterruptDelayTrace;
  _veraInterruptDelayTrace = null;
  if (!isVeraInterruptDebugEnabled()) return;
  try {
    if (had && !had.flushed) {
      _flushInterruptDelayTrace("reset_before_flush:" + reason);
    }
  } catch (_) {}
}

function _ensureInterruptDelayTrace(startingField) {
  if (!isVeraInterruptDebugEnabled()) return null;
  if (!_veraInterruptDelayTrace || _veraInterruptDelayTrace.flushed) {
    _veraInterruptDelayTrace = {
      interruptAttemptId: _newInterruptAttemptId(),
      flushed: false,
      _startedByField: startingField || null,
      _createdAt: Number(performance.now().toFixed(1)),
    };
  }
  return _veraInterruptDelayTrace;
}

function _recordInterruptTimingPoint(field, opts = {}) {
  if (!isVeraInterruptDebugEnabled()) return;
  const allowAutoStart = opts.autoStart === true;
  try {
    let t = _veraInterruptDelayTrace;
    if (!t || t.flushed) {
      if (!allowAutoStart) return;
      t = _ensureInterruptDelayTrace(field);
    }
    if (!t) return;
    const now = Number(performance.now().toFixed(1));
    if (field === "t2_interim_transcript_updated") {
      t.t2_interim_transcript_updated = now;
    } else if (t[field] == null) {
      t[field] = now;
    }
    if (opts.extra && typeof opts.extra === "object") {
      t._extra = t._extra || {};
      Object.assign(t._extra, opts.extra);
    }
  } catch (_) {}
}

function _flushInterruptDelayTrace(reason = "") {
  if (!isVeraInterruptDebugEnabled()) return;
  const t = _veraInterruptDelayTrace;
  if (!t || t.flushed) return;
  try {
    t.flushed = true;
    const d = (a, b) =>
      typeof t[a] === "number" && typeof t[b] === "number"
        ? Number((t[b] - t[a]).toFixed(1))
        : null;
    const firstTranscript = (typeof t.t1_interim_transcript_started === "number"
      ? t.t1_interim_transcript_started
      : typeof t.t2_interim_transcript_updated === "number"
        ? t.t2_interim_transcript_updated
        : null);
    const payload = {
      tag: "interrupt_delay_trace",
      interruptAttemptId: t.interruptAttemptId,
      reason,
      t0_user_speech_audio_detected: t.t0_user_speech_audio_detected ?? null,
      t1_interim_transcript_started: t.t1_interim_transcript_started ?? null,
      t2_interim_transcript_updated: t.t2_interim_transcript_updated ?? null,
      t3_final_transcript_available: t.t3_final_transcript_available ?? null,
      t4_interrupt_intent_detected: t.t4_interrupt_intent_detected ?? null,
      t5_interruptSpeech_entered: t.t5_interruptSpeech_entered ?? null,
      t6_cancelMainTtsPlayback_called: t.t6_cancelMainTtsPlayback_called ?? null,
      t7_stopAllMainTtsWebAudio_called: t.t7_stopAllMainTtsWebAudio_called ?? null,
      t8_ui_state_set_interrupted: t.t8_ui_state_set_interrupted ?? null,
      t9_ui_state_set_listening: t.t9_ui_state_set_listening ?? null,
      t10_audio_sources_zero: t.t10_audio_sources_zero ?? null,
      t11_audio_audibly_stopped: t.t11_audio_audibly_stopped ?? null,
      delta_transcript_to_cancel:
        firstTranscript != null && typeof t.t6_cancelMainTtsPlayback_called === "number"
          ? Number((t.t6_cancelMainTtsPlayback_called - firstTranscript).toFixed(1))
          : null,
      delta_cancel_to_ui_interrupted: d(
        "t6_cancelMainTtsPlayback_called",
        "t8_ui_state_set_interrupted"
      ),
      delta_cancel_to_audio_stop: d(
        "t6_cancelMainTtsPlayback_called",
        "t11_audio_audibly_stopped"
      ),
      delta_transcript_to_ui_interrupted:
        firstTranscript != null && typeof t.t8_ui_state_set_interrupted === "number"
          ? Number((t.t8_ui_state_set_interrupted - firstTranscript).toFixed(1))
          : null,
      delta_t0_to_cancel: d(
        "t0_user_speech_audio_detected",
        "t6_cancelMainTtsPlayback_called"
      ),
      delta_t0_to_ui_interrupted: d(
        "t0_user_speech_audio_detected",
        "t8_ui_state_set_interrupted"
      ),
      delta_t0_to_audio_stop: d(
        "t0_user_speech_audio_detected",
        "t11_audio_audibly_stopped"
      ),
      delta_t3_final_to_cancel: d(
        "t3_final_transcript_available",
        "t6_cancelMainTtsPlayback_called"
      ),
      startedByField: t._startedByField || null,
      createdAt: t._createdAt || null,
      extra: t._extra || null,
    };
    console.info(`[${payload.tag}]`, payload);
  } catch (_) {}
}

function _logVoiceStateTransition(from, to, reason, functionName, extra = {}) {
  if (!isVeraInterruptDebugEnabled()) return;
  try {
    const tr = _veraInterruptDelayTrace;
    const att = tr ? tr.interruptAttemptId : null;
    let stackHint = null;
    try {
      const stk = new Error().stack || "";
      stackHint = stk
        .split("\n")
        .slice(2, 6)
        .map((s) => s.trim())
        .join(" | ");
    } catch (_) {}
    console.info("[voice_state_transition]", {
      from,
      to,
      reason,
      interruptAttemptId: att,
      ttsPlaying: (function () {
        try { return typeof isAssistantTtsPlaying === "function" ? isAssistantTtsPlaying() : null; } catch (_) { return null; }
      })(),
      transcriptActive: Boolean(
        (typeof interruptDetectRecognition !== "undefined" && interruptDetectRecognition) ||
        (typeof mainBrowserRecognition !== "undefined" && mainBrowserRecognition) ||
        (typeof interruptRecording !== "undefined" && interruptRecording)
      ),
      functionName,
      stackHint,
      now: Number(performance.now().toFixed(1)),
      ...extra,
    });
  } catch (_) {}
}

function _logTtsCancelSourceTrace(fnLabel, reason, extra = {}) {
  if (!isVeraInterruptDebugEnabled()) return;
  try {
    const tr = _veraInterruptDelayTrace;
    const att = tr ? tr.interruptAttemptId : null;
    console.info("[tts_cancel_source_trace]", {
      interruptAttemptId: att,
      calledAt: Number(performance.now().toFixed(1)),
      calledBy: fnLabel,
      reason:
        reason ||
        (typeof _veraTtsCancelSource === "string" ? _veraTtsCancelSource : ""),
      activeSourcesBefore:
        typeof activeMainTtsBufferSources !== "undefined"
          ? activeMainTtsBufferSources.length
          : null,
      mainTtsPlaybackActiveBefore:
        typeof mainTtsPlaybackActive !== "undefined"
          ? mainTtsPlaybackActive
          : null,
      activeNdjsonBodyReaderPresent: Boolean(
        typeof activeNdjsonBodyReader !== "undefined" && activeNdjsonBodyReader
      ),
      queuedAssistantTtsPlaybackPending:
        typeof queuedAssistantTtsPlayback !== "undefined",
      currentVoiceState: typeof waveState !== "undefined" ? waveState : null,
      interruptRecording:
        typeof interruptRecording !== "undefined" ? interruptRecording : null,
      duringNewsRender:
        typeof _veraNewsPanelRenderInFlight !== "undefined"
          ? _veraNewsPanelRenderInFlight
          : null,
      ...extra,
    });
  } catch (_) {}
}

/* =========================
   FAST VAD BARGE-IN STATE + RESET
========================= */

/* Fast VAD barge-in (decoupled from final ASR).
 *
 * On desktop browser-ASR mode, Chrome's Web Speech API typically needs
 * 300-700 ms before it emits its first interim result. Waiting for that
 * before stopping TTS made the user feel like VERA "kept talking over"
 * them. The fast VAD path runs the existing RMS / ZCR / crest heuristic
 * IN PARALLEL with the browser-ASR detector: as soon as a sustained
 * speech-like frame is seen we cut audio playback, while leaving the
 * Web Speech API session alive so it can deliver the actual transcript
 * for intent classification.
 *
 * The flag is one-shot per TTS turn (re-armed on the next audioStartedAt)
 * to keep the loop from re-cancelling an already-stopped playback. */
let vadFastStopArmed = true;
let vadFastStopFiredAt = 0;
let vadFastStopTtsStoppedAt = 0;
let vadFastStopAsrFinalAt = 0;
let vadFastStopTtsId = "";

/* After >2 words during TTS, barge-in latched: same SR stream continues
 * until 1.3s silence → LLM (no second SR). */
let interruptBargeInLatched = false;

function resetVadFastStopState(reason = "") {
  vadFastStopArmed = true;
  vadFastStopFiredAt = 0;
  vadFastStopTtsStoppedAt = 0;
  vadFastStopAsrFinalAt = 0;
  vadFastStopTtsId = "";
  if (reason) {
    logBargeInLatencyDebug("rearm", { reason });
  }
  /* PART 1 — interruption timing diagnostics: a new TTS turn invalidates
     any previous attempt trace. If the prior trace was never flushed (e.g.
     interruption that did not fully complete because TTS ended naturally),
     emit it now so we don't lose the timestamps. */
  _resetInterruptDelayTrace(reason || "new_tts_turn");
}

/* =========================
   FAST-STOP TTS ON VAD ONLY
========================= */

/**
 * Stop TTS playback IMMEDIATELY on a fast VAD trigger, without
 * aborting the in-flight Web Speech API session and without touching
 * any committed checklist/timer/action state (those are protected by
 * NON_CANCELABLE_AFTER_COMMIT_ACTIONS — see commitNonCancelableAction).
 *
 * The browser-ASR detector continues running so the user's actual words
 * are still captured for intent classification. If the SR never
 * delivers a meaningful transcript, the existing 4 s no-result watchdog
 * will recover (continuous mode resumes listening on its own).
 */
function fastStopTtsOnVadOnly({ rms = null, zcr = null, crest = null, vadAccumMs = 0 } = {}) {
  if (!vadFastStopArmed) {
    logVeraInterruptDebug({
      tag: "interrupt_speech_entry",
      gatePath: "browser_asr_parallel",
      outcome: "early_return",
      reasonIfReturn: "vad_fast_stop_not_armed",
      now: Number(performance.now().toFixed(1)),
    });
    return false;
  }
  if (!isAssistantTtsPlaying()) {
    logVeraInterruptDebug({
      tag: "interrupt_speech_entry",
      gatePath: "browser_asr_parallel",
      outcome: "early_return",
      reasonIfReturn: "no_tts_playing",
      now: Number(performance.now().toFixed(1)),
    });
    return false;
  }

  vadFastStopArmed = false;
  vadFastStopFiredAt = performance.now();
  vadFastStopTtsId = interruptPrearmTtsId || vadFastStopTtsId;

  /* PART 1 — record interrupt intent + entry into the fast-stop path. */
  _recordInterruptTimingPoint("t4_interrupt_intent_detected", { autoStart: true });
  _recordInterruptTimingPoint("t5_interruptSpeech_entered", {
    extra: { gatePath: "fast_stop_vad_browser_asr_parallel" },
  });

  logVeraInterruptDebug({
    tag: "interrupt_speech_entry",
    gatePath: "browser_asr_parallel",
    outcome: "proceed_cancel_tts",
    now: Number(vadFastStopFiredAt.toFixed(1)),
    mainTtsPlaybackActive,
    activeMainTtsBufferSourcesCount: activeMainTtsBufferSources.length,
    activeNdjsonBodyReaderPresent: Boolean(activeNdjsonBodyReader),
    interruptRecording,
    rms: rms != null ? Number(Number(rms).toFixed(5)) : null,
    zcr: zcr != null ? Number(Number(zcr).toFixed(4)) : null,
    crest: crest != null ? Number(Number(crest).toFixed(2)) : null,
    vadAccumMs: Number(Number(vadAccumMs || 0).toFixed(1)),
    duringNewsRender: _veraNewsPanelRenderInFlight,
  });

  _veraTtsCancelSource = "fast_stop_vad_browser_asr_parallel";

  logBargeInLatencyDebug("vad_barge_in_detected", {
    tts_playing: true,
    tts_id: vadFastStopTtsId || null,
    time_since_tts_start_ms: Number(
      ((audioStartedAt ? vadFastStopFiredAt - audioStartedAt : 0)).toFixed(1)
    ),
    rms: rms != null ? Number(Number(rms).toFixed(5)) : null,
    zcr: zcr != null ? Number(Number(zcr).toFixed(4)) : null,
    crest: crest != null ? Number(Number(crest).toFixed(2)) : null,
    vad_accum_ms: Number(Number(vadAccumMs || 0).toFixed(1)),
    sr_alive: !!interruptDetectRecognition
  });

  // Audio-only cancellation. cancelMainTtsPlayback() flips
  // mainTtsPlaybackActive=false and stops every active Web Audio buffer
  // source. The <audio> element is paused separately. NEITHER touches
  // localStorage, the checklist, the timer, or the network pipeline —
  // so any non-cancelable action that was just committed (see
  // commitNonCancelableAction) is preserved.
  try { resetAudioHandlers(); } catch (_) {}
  try { _veraTtsCancelSource = "fast_stop_vad_browser_asr_parallel_inline"; cancelMainTtsPlayback(); } catch (_) {}
  const a = getAudioEl();
  if (a) {
    try { a.pause(); } catch (_) {}
    try { a.currentTime = 0; } catch (_) {}
  }
  /* PART 1 — t11: audio element paused, no scheduled buffer sources left. */
  _recordInterruptTimingPoint("t11_audio_audibly_stopped", {
    extra: { path: "fast_stop_vad_browser_asr_parallel" },
  });
  // Re-flag UI so the user sees we are listening, without aborting the
  // SR or starting a fresh recognition session.
  /* PART 1/3 — t8: UI flipped from speaking → interrupted. */
  _recordInterruptTimingPoint("t8_ui_state_set_interrupted");
  _logVoiceStateTransition("speaking", "interrupted", "fast_stop_vad_browser_asr_parallel", "fastStopTtsOnVadOnly");
  try { setStatus("Listening… (interrupted)", "recording"); } catch (_) {}
  /* PART 1/3 — t9: voice state flipped to listening. */
  _logVoiceStateTransition("interrupted", "listening", "fast_stop_vad_browser_asr_parallel", "fastStopTtsOnVadOnly");
  waveState = "listening";
  listening = true;
  _recordInterruptTimingPoint("t9_ui_state_set_listening");

  /* PART 1 — flush the consolidated trace on next tick so any pending
     onended events (and t10) get a chance to land. */
  try {
    setTimeout(() => _flushInterruptDelayTrace("fast_stop_vad_complete"), 0);
  } catch (_) {}

  vadFastStopTtsStoppedAt = performance.now();
  logBargeInLatencyDebug("tts_stop", {
    tts_playing: false,
    delay_vad_to_tts_stop_ms: Number(
      (vadFastStopTtsStoppedAt - vadFastStopFiredAt).toFixed(2)
    ),
    sr_alive: !!interruptDetectRecognition,
    note: "audio-only cancel; checklist/timer mutations preserved"
  });
  return true;
}

/* =========================
   TINY HELPERS
========================= */

function interruptTranscriptNewTtsId() {
  return `tts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* =========================
   SINGLE-ASR INTERRUPT ENTRY
========================= */

function interruptSpeech() {
  /* DEBUG: log entry + every early-return reason so we can distinguish
     between "detectInterrupt never fired" and "fired but was gated out". */
  const _dbgEntry = (extra) => ({
    tag: "interrupt_speech_entry",
    now: Number(performance.now().toFixed(1)),
    listeningMode,
    useBrowserAsr: (function () { try { return browserAsrPreferred(); } catch (_) { return null; } })(),
    interruptRecording,
    mainTtsPlaybackActive,
    activeMainTtsBufferSourcesCount: activeMainTtsBufferSources.length,
    activeNdjsonBodyReaderPresent: Boolean(activeNdjsonBodyReader),
    vadFastStopArmed,
    duringNewsRender: _veraNewsPanelRenderInFlight,
    ...(extra || {})
  });

  if (listeningMode !== "continuous") {
    logVeraInterruptDebug(_dbgEntry({ outcome: "early_return", reasonIfReturn: "not_continuous" }));
    return;
  }
  const useBrowserAsr = browserAsrPreferred();
  if (!interruptRecording && !useBrowserAsr) {
    logVeraInterruptDebug(_dbgEntry({
      outcome: "early_return",
      reasonIfReturn: "interrupt_recording_false_single_asr",
      useBrowserAsr,
    }));
    return;
  }
  const a = getAudioEl();
  const htmlPlaying = a && !a.paused;
  const webTtsPlaying =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  if (!htmlPlaying && !webTtsPlaying) {
    logVeraInterruptDebug(_dbgEntry({
      outcome: "early_return",
      reasonIfReturn: "no_tts_playing",
      htmlPlaying: Boolean(htmlPlaying),
      webTtsPlaying: Boolean(webTtsPlaying),
    }));
    return;
  }

  logVeraInterruptDebug(_dbgEntry({
    outcome: "proceed_cancel_tts",
    htmlPlaying: Boolean(htmlPlaying),
    webTtsPlaying: Boolean(webTtsPlaying),
  }));

  /* PART 1 — t4/t5 markers for the single-ASR / heuristic VAD path. */
  _recordInterruptTimingPoint("t4_interrupt_intent_detected", { autoStart: true });
  _recordInterruptTimingPoint("t5_interruptSpeech_entered", {
    extra: { gatePath: "interrupt_speech_single_asr" },
  });

  _veraTtsCancelSource = "interrupt_speech_single_asr";
  cancelBrowserInterruptTtsOnly();

  if (interruptRecording) {
    interruptPrearmCommittedAt = performance.now();
    logInterruptTranscriptDebug("capture_committed", {
      included_preroll_ms: interruptPrearmStartedAt
        ? Number(Math.min(MAX_INTERRUPTION_PREROLL_MS, interruptPrearmCommittedAt - interruptPrearmStartedAt).toFixed(1))
        : Number(Math.min(MAX_INTERRUPTION_PREROLL_MS, interruptPrearmCommittedAt - (audioStartedAt || interruptPrearmCommittedAt)).toFixed(1)),
      live_capture_started_at_ms: Number((interruptPrearmStartedAt || audioStartedAt || interruptPrearmCommittedAt).toFixed(1)),
      bubble_created_at_ms: null,
      asr_request_started_at_ms: null
    });
    requestAnimationFrame(detectInterruptSpeechEnd);
  } else if (useBrowserAsr) {
    /* No MediaRecorder interrupt path: start dedicated post-interrupt SR (e.g. phone Chrome edge cases). */
    promoteInterruptPreviewToMainLiveBubble();
    startPostInterruptBrowserRecognition();
  }
}

/* =========================
   READ-ONLY ACCESSOR  (new, additive — Stage 6)

   Small named snapshot that mirrors getTtsDebugState()'s style. Does
   NOT replace any existing in-app diagnostic — `dumpVeraVoiceState`
   continues to reach all of these bindings directly via shared
   lexical env. This is just a stable named API for future migration.
========================= */

function getInterruptionDebugState() {
  return {
    interruptBargeInLatched,
    vadFastStopArmed,
    vadFastStopFiredAt,
    vadFastStopTtsStoppedAt,
    vadFastStopAsrFinalAt,
    vadFastStopTtsId,
    veraTtsCancelSource: _veraTtsCancelSource,
    interruptAttemptSeq: _veraInterruptAttemptSeq,
    delayTracePresent: Boolean(_veraInterruptDelayTrace),
    delayTraceFlushed: _veraInterruptDelayTrace
      ? Boolean(_veraInterruptDelayTrace.flushed)
      : null,
    interruptDebugEnabled: isVeraInterruptDebugEnabled(),
  };
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Mirror of the pattern used by utils/* + voice/ttsQueue.js +
 *  debug/voiceDebug.js. Pre-extraction `app.js` did NOT attach these
 *  helpers to `window`; we add the aliases here as belt-and-braces
 *  insurance for DevTools snippets and `typeof window.X` callers. The
 *  bare identifiers continue to be the primary calling convention.
 *
 *  Debug flags preserved unchanged:
 *    window.VERA_DEBUG_INTERRUPT
 *    window.VERA_DEBUG_BARGE_IN_UI
 *    localStorage.vera_debug_barge_in_ui
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.interruptSpeech = interruptSpeech;
    window.fastStopTtsOnVadOnly = fastStopTtsOnVadOnly;
    window.getInterruptionDebugState = getInterruptionDebugState;
    /* These two are useful in DevTools to manually force a re-arm or
     * flush during ad-hoc debugging. They are NOT exposed pre-extraction
     * either, so this is purely additive. */
    window.resetVadFastStopState = resetVadFastStopState;
    window.isVeraInterruptDebugEnabled = isVeraInterruptDebugEnabled;
  }
} catch (_) {}
