/* =========================================================================
 *  utils/logging.js — pure console / debug-log helpers.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 3). Every helper below is a thin wrapper
 *  around `console.log` / `console.info` / `console.warn` with a stable
 *  bracketed tag. Behavior is preserved exactly:
 *    - same console label,
 *    - same payload shape,
 *    - same gating flag (where applicable),
 *    - same silent-fail try/catch surround.
 *
 *  Load order — MUST come BEFORE app.js (after utils/ids.js + storage.js):
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *
 *  Bare-identifier references to runtime state living in app.js
 *  (`voiceUxTurn`, `voiceTranscriptDebugEnabled`, `_readLatestUserBubbleText`,
 *  `appModePrefix`, `_veraBargeInDebug`, `_bargeInDebugCaptureEvent`) are
 *  resolved at CALL time via the shared classic-script global lexical
 *  environment. None of these helpers fire at module-load time, so the
 *  late-binding is safe even though utils/logging.js loads first.
 *
 *  Contents:
 *    INPUT / CAPABILITY
 *      - logInputLimitDebug
 *      - logVeraCapabilityFailure
 *      - logCapabilityFallbackDebug
 *    INTERRUPT / BARGE-IN
 *      - logBargeInLatencyDebug
 *      - logInterruptTranscriptDebug
 *    VOICE UX TIMING
 *      - logVoiceFirstAudio
 *      - logVoiceMainReplyAudio
 *      - logVoicePipe
 *    VOICE TRANSCRIPT
 *      - logVoiceTranscript
 *      - logFinalTranscriptSentToLlm
 *    TURN TEXT INTEGRITY (cohesive bundle)
 *      - _turnTextIntegrityEnabled
 *      - _veraTurnSeq + _nextVeraTurnId
 *      - logTurnTextIntegrity (+ window alias)
 *
 *  NOT moved (intentionally — too tightly coupled or domain-specific):
 *    logVeraInterruptDebug          (throttle cache + overlay capture)
 *    logBrowserAsrStuckEvent        (snapshots many ASR globals)
 *    logPartialAsrUtteranceDone     (paired with browser-ASR session state)
 *    logPartialAsrSegmentFinal      (same)
 *    logTextFirstAudio              (textUxTurn lifecycle, not voice)
 *    logTextMainReplyAudio          (same)
 *    logInferLatency                (server payload parser; large)
 *    logVeraSettings                (settings UI side-effect)
 *    logMusicPlaybackDebug          (music transport state)
 *    logFreeMusicQueueDebug         (free-music queue state)
 *    logMoveLatestVoiceTaskToReasoningDebug
 *    logHeadingTitleExtractAttempt  (reasoning panel internals)
 *    logReasoning*                  (reasoning panel lifecycle)
 *    logComposerAttachmentsBeforeSubmit
 *    logStage2*                     (Work Mode stage-2 internals)
 *    logLane*                       (Work Mode lane invariants)
 *    logWorkMode*                   (Work Mode internals, e.g. planner)
 *    logArithmeticFastPathDebug
 *    logChecklist*
 *    logReasoningPanelRouteDebug
 *    logTtsDropStale / logTtsTextPreview
 *    logPlanSyncDebug / logSyncVoiceTurnDebug
 *    logInterruptTriggerReason      (reads cross-module timestamps)
 *    logBmoEmotionDecision          (BMO emotion engine)
 *    logWorkModeCommandDisplayText  (cohesive with bubble-preservation block)
 *
 *  All `_readLatestUserBubbleText` callers remain in app.js (DOM helper
 *  is reused by 4 non-logger sites), so the helper itself stays there.
 * ========================================================================= */

/* =========================
   INPUT / CAPABILITY
========================= */

function logInputLimitDebug(fields = {}) {
  try {
    console.info("[INPUT_LIMIT_DEBUG]", {
      raw_char_count: Number(fields.raw_char_count) || 0,
      estimated_tokens: Number(fields.estimated_tokens) || 0,
      input_surface: String(fields.input_surface || "keyboard"),
      active_mode_before_submit: String(fields.active_mode_before_submit || appModePrefix() || ""),
      work_mode_enabled_before_submit: Boolean(fields.work_mode_enabled_before_submit),
      selected_limit: Number(fields.selected_limit) || 0,
      blocked: Boolean(fields.blocked),
      block_reason: String(fields.block_reason || ""),
      route_attempted: Boolean(fields.route_attempted),
      backend_call_attempted: Boolean(fields.backend_call_attempted),
      reasoning_panel_started: Boolean(fields.reasoning_panel_started),
      work_mode_enabled_after_submit: Boolean(fields.work_mode_enabled_after_submit),
      did_toggle_work_mode: Boolean(fields.did_toggle_work_mode),
      function_that_changed_work_mode: String(fields.function_that_changed_work_mode || "")
    });
  } catch (_) {}
}

/** Generic capability-failure logger used by frontend service-error handlers. */
function logVeraCapabilityFailure(feature, reason, extra) {
  try {
    const payload = { feature, reason };
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (!(k in payload)) payload[k] = v;
      }
    }
    console.warn("[capability_failure]", payload);
  } catch (_) {}
}

/** Structured fallback-debug log used to verify whether a fallback bubble
 *  was suppressed (permission/setup state) or actually surfaced (module
 *  failure). One log per fallback decision; emitted for both bubble and
 *  no-bubble paths so the cause is visible in the console. */
function logCapabilityFallbackDebug(fields = {}) {
  try {
    console.warn("[CAPABILITY_FALLBACK_DEBUG]", {
      capability: String(fields.capability || ""),
      failure_kind: String(fields.failure_kind || ""),
      should_show_bubble: Boolean(fields.should_show_bubble),
      turn_id: fields.turn_id || fields.user_message_id || null,
      source_function: String(fields.source_function || ""),
      raw_error_message: fields.raw_error_message
        ? String(fields.raw_error_message).slice(0, 200)
        : null
    });
  } catch (_) {}
}

/* =========================
   INTERRUPT / BARGE-IN
========================= */

function logBargeInLatencyDebug(phase, payload = {}) {
  try {
    console.warn(`[BARGE_IN_LATENCY_DEBUG][${phase}]`, {
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (_) {}
}

function logInterruptTranscriptDebug(phase, payload = {}) {
  /* debug/voiceDebug.js loads AFTER app.js per index.html, so `_veraBargeInDebug`
   * and `_bargeInDebugCaptureEvent` may be undeclared if a transcript event
   * fires before that script has executed. `typeof X !== "undefined"` does not
   * throw on an undeclared global, and the outer try/catch is a belt-and-
   * suspenders fallback for any TDZ window that could appear mid-script. */
  try {
    if (
      typeof _veraBargeInDebug !== "undefined" &&
      _veraBargeInDebug?.enabled &&
      typeof _bargeInDebugCaptureEvent === "function"
    ) {
      _bargeInDebugCaptureEvent(phase, payload);
    }
  } catch (_) {}
  try {
    console.warn(`[INTERRUPT_TRANSCRIPT_DEBUG][${phase}]`, {
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (_) {}
}

/* =========================
   VOICE UX TIMING
========================= */

/** First *any* audio in this turn (typically main `(main-reply)`). */
function logVoiceFirstAudio(kind) {
  if (!voiceUxTurn || voiceUxTurn.firstAudioLogged) return;
  const elapsedMs = performance.now() - voiceUxTurn.speechEndAt;
  voiceUxTurn.firstAudioLogged = true;
  console.log(`[UX][VOICE] SpeechEnd→FirstAudio=${(elapsedMs / 1000).toFixed(3)}s (${kind})`);
}

/**
 * Primary perceived voice metric: end of user speech → first main reply TTS playback.
 * (Not server `latency.total_s`, not `[UX][PIPE]` — those are diagnostics only.)
 */
function logVoiceMainReplyAudio() {
  if (!voiceUxTurn || voiceUxTurn.mainReplyLogged) return;
  const elapsedMs = performance.now() - voiceUxTurn.speechEndAt;
  voiceUxTurn.mainReplyLogged = true;
  console.log(`[UX][VOICE] SpeechEnd→MainReplyAudio=${(elapsedMs / 1000).toFixed(3)}s`);
}

/** Debug: seconds from speech end — use to see upload vs TTFB vs first chunk vs decode (server TOTAL is a different clock). */
function logVoicePipe(label) {
  if (!voiceUxTurn?.speechEndAt) return;
  const s = ((performance.now() - voiceUxTurn.speechEndAt) / 1000).toFixed(3);
  console.log(`[UX][VOICE][PIPE] ${label}  +${s}s from SpeechEnd`);
}

/* =========================
   VOICE TRANSCRIPT
========================= */

/**
 * @param {"final"} phase — committed user line (bubble) from `/infer`.
 * @param {Record<string, unknown>} [meta] — e.g. { path: "main-ndjson" }
 */
function logVoiceTranscript(phase, text, meta = {}) {
  if (!voiceTranscriptDebugEnabled()) return;
  console.log("[VOICE][TRANSCRIPT]", { phase, ...meta, text: text ?? "" });
}

function logFinalTranscriptSentToLlm(path, text) {
  if (!voiceTranscriptDebugEnabled()) return;
  console.log("[VOICE][LLM-INPUT]", { path, text: text ?? "" });
}

/* =========================================================================
 *  TURN TEXT INTEGRITY  (Stabilization Stage 1, 2026-05-27)
 *
 *  Diagnostic-only. Emits a single `[TURN_TEXT_INTEGRITY]` line per turn so
 *  we can verify, for compound voice/typed commands, that:
 *
 *    raw_asr_text   →   normalized_text   →   displayed_user_bubble_text
 *                                            ≡ router_input_text
 *                                            ≡ backend_payload_text
 *
 *  Equality is allowed to fail on intentional normalization (case, leading
 *  cancel-prefix strip, trim, smart-quote folding). Any other divergence is
 *  a bug to investigate.
 *
 *  ZERO behavior change: this only logs.
 *
 *  Silence with:  localStorage.setItem("VERA_DEBUG_TURN_TEXT", "0")
 *  Re-enable with: localStorage.removeItem("VERA_DEBUG_TURN_TEXT")
 *  (Default ON because the log fires at most once per user turn — low volume.)
 *
 *  `_readLatestUserBubbleText` remains in app.js because four non-logger
 *  sites (Work Mode bubble-preservation block) also call it. It resolves
 *  here via the shared global lexical environment.
 * ========================================================================= */

function _turnTextIntegrityEnabled() {
  return safeGetLocalStorage("VERA_DEBUG_TURN_TEXT") !== "0";
}

let _veraTurnSeq = 0;
function _nextVeraTurnId() {
  _veraTurnSeq += 1;
  let r = "";
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      r = buf[0].toString(36);
    }
  } catch (_) {}
  if (!r) r = Math.random().toString(36).slice(2, 10);
  return `turn_${r}_${_veraTurnSeq}`;
}

/** Emit the single `[TURN_TEXT_INTEGRITY]` diagnostic line. All fields are
 *  optional — pass what you know at the call site; missing fields are
 *  recorded as `null`. The caller decides WHEN (typically right before the
 *  network fetch, OR right after a server NDJSON `meta.transcript` for
 *  whisper turns).
 *
 *  Wrapped in try/catch so a malformed payload can never break a real turn.
 */
function logTurnTextIntegrity(fields = {}) {
  if (!_turnTextIntegrityEnabled()) return null;
  try {
    const turn_id = fields.turn_id || _nextVeraTurnId();
    const displayed =
      fields.displayed_user_bubble_text !== undefined
        ? fields.displayed_user_bubble_text
        : _readLatestUserBubbleText();
    const norm = (v) => (v == null ? null : String(v));
    const payload = {
      tag: "TURN_TEXT_INTEGRITY",
      turn_id,
      source: fields.source || null,
      raw_asr_text: norm(fields.raw_asr_text ?? null),
      normalized_text: norm(fields.normalized_text ?? null),
      displayed_user_bubble_text: norm(displayed ?? null),
      router_input_text: norm(fields.router_input_text ?? null),
      backend_payload_text: norm(fields.backend_payload_text ?? null),
      request_id: fields.request_id || null,
      path: fields.path || null,
      intercepted_by: fields.intercepted_by || null,
      timestamp: new Date().toISOString(),
    };
    /* Divergence shorthand so the user can grep just the failing turns:
     *   displayed === router === backend  (modulo case/punctuation) ?      */
    const eq = (a, b) => {
      if (a == null || b == null) return null;
      return String(a).trim() === String(b).trim();
    };
    payload.bubble_eq_router = eq(payload.displayed_user_bubble_text, payload.router_input_text);
    payload.router_eq_backend = eq(payload.router_input_text, payload.backend_payload_text);
    payload.all_three_eq =
      payload.bubble_eq_router === true && payload.router_eq_backend === true;
    console.info("[TURN_TEXT_INTEGRITY]", payload);
    return turn_id;
  } catch (e) {
    try { console.warn("[TURN_TEXT_INTEGRITY] log failed", e); } catch (_) {}
    return null;
  }
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Mirror of the patterns used by utils/ids.js + utils/storage.js. The
 *  bare-identifier references in app.js already resolve through the shared
 *  classic-script global lexical environment; these aliases are purely
 *  additive insurance for DevTools snippets and `typeof window.X` callers.
 *  `window.logTurnTextIntegrity` specifically was already exposed before
 *  this extraction (Stage 1) — preserved verbatim.
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.logInputLimitDebug = logInputLimitDebug;
    window.logVeraCapabilityFailure = logVeraCapabilityFailure;
    window.logCapabilityFallbackDebug = logCapabilityFallbackDebug;
    window.logBargeInLatencyDebug = logBargeInLatencyDebug;
    window.logInterruptTranscriptDebug = logInterruptTranscriptDebug;
    window.logVoiceFirstAudio = logVoiceFirstAudio;
    window.logVoiceMainReplyAudio = logVoiceMainReplyAudio;
    window.logVoicePipe = logVoicePipe;
    window.logVoiceTranscript = logVoiceTranscript;
    window.logFinalTranscriptSentToLlm = logFinalTranscriptSentToLlm;
    window.logTurnTextIntegrity = logTurnTextIntegrity;
  }
} catch (_) {}
