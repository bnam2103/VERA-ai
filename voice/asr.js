/* =========================================================================
 *  voice/asr.js — ASR mode + transcript helper layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 7). Behavior is preserved EXACTLY:
 *    - same default ASR mode ("whisper"),
 *    - same backcompat mapping ("single" → "whisper", "browser" → "streaming"),
 *    - same hybrid-policy selector ("selective"),
 *    - same transcript regex set (risky-vocab, ordinals, accurate,
 *      state-changing, cancel-only, cancel-prefix),
 *    - same chooseBestTranscript scoring (Levenshtein + token overlap +
 *      hallucination + truncation heuristics),
 *    - same normalizeCommandTranscript known-vocabulary mishears,
 *    - same window.* aliases (decideAsrFinalizationMode,
 *      chooseBestTranscript, normalizeCommandTranscript,
 *      getVeraAsrMode, setVeraAsrMode).
 *  No streaming/whisper/hybrid behavior changes. No browser
 *  recognition lifecycle changes. No interruption changes. No TTS
 *  changes. No Work Mode routing changes. No user-bubble changes.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come AFTER utils/storage.js (uses
 *  safeSetLocalStorage) and BEFORE voice/ttsQueue.js +
 *  voice/interruption.js + app.js so the moved bare identifiers
 *  resolve from the shared classic-script global lexical env. Stage 6's
 *  voice/interruption.js calls `browserAsrPreferred()` (now here) from
 *  function bodies; loading asr.js first means the reference is
 *  reachable at call time.
 *
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/asr.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="voice/interruption.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Bare-identifier references in the moved code (all resolved at CALL
 *  TIME through the shared global lexical environment, not at module
 *  load):
 *    safeSetLocalStorage      (utils/storage.js — Stage 2)
 *    logVeraSettings          (app.js — generic settings logger; used
 *                              by many non-ASR setters too)
 *    browserAsrPermanentlyDisabled
 *                             (let in app.js; mutated by Web Speech
 *                              error handlers that we are NOT moving)
 *    browserAsrMainSilenceMs  (let in app.js; setVeraAsrSilenceMs
 *                              writes through the shared lexical env)
 *    mainAsrPartialMinChars   (let in app.js; setMainAsrPartialMinChars
 *                              writes through the shared lexical env)
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers AND, for a subset, as
 *  window.* aliases for DevTools)
 *  ─────────────────────────────────────────────────────────────────────
 *    settings keys           VERA_SETTING_ASR_SILENCE_MS_KEY,
 *                            VERA_SETTING_ASR_MODE_KEY,
 *                            VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY
 *    mode constants          VERA_ASR_MODE_DEFAULT, VERA_ASR_MODE_VALID,
 *                            HYBRID_POLICY
 *    transcript regexes      ASR_RISKY_VOCAB_RE, ASR_ORDINAL_OR_RANGE_RE,
 *                            ASR_EXPLICIT_ACCURATE_RE, ASR_STATE_CHANGING_RE,
 *                            ASR_CANCEL_ONLY_RE, ASR_CANCEL_PREFIX_RE,
 *                            ASR_COMMAND_NORMALIZATIONS
 *    partial-min constants   MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS,
 *                            MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT
 *    mode helpers            _normalizeVeraAsrMode, getVeraAsrMode,
 *                            setVeraAsrMode, isHybridAsrMode,
 *                            isWhisperAsrMode, isStreamingAsrMode
 *    silence-ms helpers      getVeraAsrSilenceMs, setVeraAsrSilenceMs
 *    partial-min helpers     normalizeMainAsrPartialMinChars,
 *                            getMainAsrPartialMinChars,
 *                            setMainAsrPartialMinChars
 *    browser-ASR support     isLikelyGoogleChrome, isNarrowViewport,
 *                            browserAsrSupported,
 *                            getSpeechRecognitionLang,
 *                            browserAsrPreferred
 *    finalization classifier _splitCancelPrefix,
 *                            decideAsrFinalizationMode
 *    transcript selector     _normalizeForCompare, _levenshtein,
 *                            _tokenOverlapRatio, _looksHallucinated,
 *                            chooseBestTranscript
 *    transcript normalizer   normalizeCommandTranscript
 *    accessor (new)          getAsrDebugState()   // read-only snapshot
 *
 *  Helpers / state intentionally LEFT in app.js (and why):
 *    let browserAsrPermanentlyDisabled
 *                            mutated by Web Speech `not-allowed` /
 *                            `service-not-allowed` error handlers and
 *                            other SR lifecycle code.
 *    let browserAsrMainSilenceMs / let mainAsrPartialMinChars /
 *      let browserAsrInterruptSustainMs / let browserAsrInterruptGapMs /
 *      let interruptBrowserMinWords
 *                            SR partial / interrupt tunable state read
 *                            by the recognition lifecycle on every
 *                            partial event.
 *    let browserAsrMainNetworkRetries /
 *      const BROWSER_ASR_MAIN_NETWORK_RETRY_MAX
 *                            SR retry counters owned by the SR error
 *                            handler.
 *    Browser SR LIFECYCLE (mainBrowserRecognition session start/stop,
 *      interruptDetectRecognition, postInterruptRecognition,
 *      onresult/onerror/onend handlers, recovery debounces, watchdogs)
 *                            ~thousands of lines, deeply coupled to
 *                            voice UX, UI bubbles, intent routing,
 *                            and the RAF / VAD loop. Per Stage 7 spec,
 *                            recognition lifecycle stays in app.js.
 *    MediaRecorder helpers (VERA_RECORDER_BITS_PER_SECOND,
 *      VERA_RECORDER_MIME_PREFS, _pickRecorderMime, createVeraMediaRecorder)
 *                            Recorder construction — not an ASR-mode
 *                            decision; coupled to the recorder lifecycle.
 *    Hybrid sidecar recorder (hybridSidecarRecorder, hybridSidecarChunks,
 *      hybridSidecarMimeType, hybridSidecarStartedAt,
 *      isHybridSidecarRunning, _stopAndCollectHybridSidecar,
 *      _discardHybridSidecar, startHybridSidecarRecorderIfNeeded)
 *                            MediaRecorder lifecycle that runs in
 *                            parallel with the SR session. Coupled to
 *                            mic stream, hybrid policy state, and the
 *                            /infer multipart pipeline.
 *    function logVeraSettings
 *                            generic settings logger used by many
 *                            non-ASR setters (work-mode mute, text
 *                            guide rotator, planning deadline timer,
 *                            …). Leaving it in app.js so non-ASR
 *                            setters still find it via the shared
 *                            lexical env.
 * ========================================================================= */

/* =========================
   SETTINGS KEYS + CONSTANTS
========================= */

const VERA_SETTING_ASR_SILENCE_MS_KEY = "vera_setting_asr_silence_ms_v1";
const VERA_SETTING_ASR_MODE_KEY = "vera_setting_asr_mode_v1";
const VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY = "vera_setting_main_asr_partial_min_chars_v1";

/* PART 1 of the ASR-mode spec.
 *
 *   "streaming"  → fastest, browser ASR is the final transcript
 *                  (current default; matches the demo's existing flow).
 *   "whisper"    → most accurate, MediaRecorder → server Whisper is the
 *                  final transcript; browser ASR is not used for routing.
 *   "hybrid"     → live browser captions PLUS MediaRecorder in parallel.
 *                  decideAsrFinalizationMode() decides per-utterance
 *                  whether to route immediately from the browser transcript
 *                  (low-risk requests) or wait for selective Whisper
 *                  verification (state-changing or vocabulary-sensitive
 *                  requests).
 *
 * Backward compatibility (PART 1 spec):
 *   "single"  → mapped to "whisper"
 *   "browser" → mapped to "streaming"
 */
const VERA_ASR_MODE_DEFAULT = "whisper";
const VERA_ASR_MODE_VALID = new Set(["streaming", "whisper", "hybrid"]);

/* Default hybrid policy. "selective" routes low-risk requests instantly from
 * the browser transcript and only waits for Whisper on state-changing /
 * vocabulary-sensitive commands. PART 5+15: must NOT default to
 * "always_verify" because that's basically Whisper-only latency. */
const HYBRID_POLICY = "selective";

/* Risky vocabulary: domain words that are commonly misheard by Web Speech
 * and that gate state-changing actions. Hearing any of these increases the
 * value of a Whisper verification pass. */
const ASR_RISKY_VOCAB_RE = /\b(?:sync|reasoning\s+panel|news\s+panel|checklist|work\s+mode|vera|bmo|openai|serper|asr|tts|whisper|panel\s+\d|tab\s+\d)\b/i;

/* Ordinal/range markers — phrases that drive checklist/panel index ops. A
 * one-character slip ("sing" vs "sync", "fifth" vs "fifth", "third" vs
 * "turd") flips the intent or breaks the parser, so we verify. */
const ASR_ORDINAL_OR_RANGE_RE = /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|first\s+(?:two|three|four|five)|last\s+(?:two|three|four|five)|\d+\s+(?:through|thru|to|-)\s+\d+)\b/i;

/* Explicit user request for high-accuracy transcription. */
const ASR_EXPLICIT_ACCURATE_RE = /\b(?:accurate|accuracy|transcribe|transcription|write\s+(?:this|that)\s+down|dictate|dictation)\b/i;

/* State-changing verbs paired with an object the user is mutating. */
const ASR_STATE_CHANGING_RE = /\b(?:sync|create|delete|remove|update|rename|cancel|schedule|set|change|move|copy|email|send|save|file|attach|upload|download|run|execute|start|stop|pause|resume|reset|toggle|enable|disable|export|import)\b/i;

/* Cancel-only utterances. These never carry intent beyond "stop talking",
 * so we don't need Whisper verification — we just want TTS to stop. */
const ASR_CANCEL_ONLY_RE = /^\s*(?:stop|cancel|pause|wait|shut\s+up|stop\s+talking|quiet|hush|that's\s+enough|nevermind|never\s+mind|hold\s+on)[\s.!,?]*$/i;

/* "stop, sync the plan" / "wait, remove the first item" — strip the
 * leading cancel verb and route the residue. */
const ASR_CANCEL_PREFIX_RE = /^\s*(?:stop|cancel|pause|wait|shut\s+up|hold\s+on|nevermind|never\s+mind)[\s,;:.\-—]+/i;

const ASR_COMMAND_NORMALIZATIONS = [
  /* [pattern, replacement, reason]. Patterns are case-insensitive whole-word
     matches against the normalized transcript. The replacement preserves
     surrounding context. */
  [/\b(?:sing|sink|seing|saink|cinq|seink)\s+the\s+plan\b/gi, "sync the plan", "sync_plan_mishear"],
  [/\bsing\s+(?:my|the)\s+(?:plan|tasks|todo)\b/gi, "sync the plan", "sync_plan_mishear"],
  [/\bnew\s+spanel\b/gi, "news panel", "news_panel_mishear"],
  [/\bnews\s+spanel\b/gi, "news panel", "news_panel_mishear"],
  [/\b(?:recent|reason|raisen|raising)\s+panel\b/gi, "reasoning panel", "reasoning_panel_mishear"],
  [/\breason(?:ing)?\s+pan\b/gi, "reasoning panel", "reasoning_panel_mishear"],
  [/\bcheck\s+list\b/gi, "checklist", "checklist_word_split"],
  [/\bwork\s+(?:mood|moods|moot)\b/gi, "Work Mode", "work_mode_mishear"],
  [/\bopen\s*a\s*i\b/gi, "OpenAI", "openai_word_split"],
  [/\bbeem\s+o\b/gi, "BMO", "bmo_mishear"],
  [/\bvera\s+(?:mood|moot)\b/gi, "Vera Mode", "vera_mode_mishear"],
];

const MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS = [10, 15, 20, 25, Infinity];
const MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT = 20;

/* =========================
   MODE HELPERS
========================= */

function _normalizeVeraAsrMode(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "single") return "whisper";
  if (v === "browser") return "streaming";
  if (VERA_ASR_MODE_VALID.has(v)) return v;
  return VERA_ASR_MODE_DEFAULT;
}

function getVeraAsrMode() {
  try {
    const raw = localStorage.getItem(VERA_SETTING_ASR_MODE_KEY) || "";
    return _normalizeVeraAsrMode(raw);
  } catch (_) {
    return VERA_ASR_MODE_DEFAULT;
  }
}

function setVeraAsrMode(mode) {
  const next = _normalizeVeraAsrMode(mode);
  safeSetLocalStorage(VERA_SETTING_ASR_MODE_KEY, next);
  logVeraSettings("save_asr_mode", { value: next });
  try {
    console.info("[asr_mode_debug]", { stage: "save", asr_mode: next, hybrid_policy: HYBRID_POLICY });
  } catch (_) {}
}

function isHybridAsrMode() {
  return getVeraAsrMode() === "hybrid";
}
function isWhisperAsrMode() {
  return getVeraAsrMode() === "whisper";
}
function isStreamingAsrMode() {
  return getVeraAsrMode() === "streaming";
}

/* =========================
   SILENCE-MS HELPERS
========================= */

function getVeraAsrSilenceMs() {
  try {
    const v = Number(localStorage.getItem(VERA_SETTING_ASR_SILENCE_MS_KEY));
    if (v === 1000 || v === 1300 || v === 1600) return v;
  } catch (_) {}
  return 1300;
}

function setVeraAsrSilenceMs(v) {
  const next = v === 1000 || v === 1300 || v === 1600 ? v : 1300;
  browserAsrMainSilenceMs = next;
  safeSetLocalStorage(VERA_SETTING_ASR_SILENCE_MS_KEY, String(next));
  logVeraSettings("save_silence_ms", { value: next });
}

/* =========================
   PARTIAL-MIN-CHARS HELPERS
========================= */

function normalizeMainAsrPartialMinChars(v) {
  if (v === Infinity || v === "inf" || v === "infinity") return Infinity;
  const n = Number(v);
  if (n === 10 || n === 15 || n === 20 || n === 25) return n;
  if (n === 5 || n === 8) return 10;
  if (n === 12) return 15;
  return MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT;
}

function getMainAsrPartialMinChars() {
  try {
    const raw = String(localStorage.getItem(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY) ?? "")
      .trim()
      .toLowerCase();
    if (raw === "inf" || raw === "infinity") return Infinity;
    const v = Number(raw);
    if (Number.isFinite(v)) return normalizeMainAsrPartialMinChars(v);
  } catch (_) {}
  return MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT;
}

function setMainAsrPartialMinChars(v) {
  let next = MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT;
  let store = String(MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT);
  const normalized = normalizeMainAsrPartialMinChars(v);
  if (normalized === Infinity) {
    next = Infinity;
    store = "inf";
  } else if (normalized === 10 || normalized === 15 || normalized === 20 || normalized === 25) {
    next = normalized;
    store = String(next);
  }
  mainAsrPartialMinChars = next;
  safeSetLocalStorage(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY, store);
  logVeraSettings("save_main_asr_partial_min_chars", { value: next === Infinity ? "inf" : next });
}

/* =========================
   BROWSER-ASR SUPPORT DETECTION
========================= */

function browserAsrSupported() {
  return typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === "function";
}

/** Match device locale (Chrome/Android works better than a hardcoded en-US for many users). */
function getSpeechRecognitionLang() {
  try {
    const lang = (navigator.languages && navigator.languages[0]) || navigator.language;
    if (lang && typeof lang === "string" && lang.length >= 2) return lang;
  } catch {}
  return "en-US";
}

/**
 * Google Chrome (desktop + Android + iOS shell): Web Speech partials are the intended path.
 * Other mobile browsers (Safari, Firefox, Samsung Internet, …) default to MediaRecorder + server ASR.
 *
 * Overrides:
 * - localStorage VERA_BROWSER_ASR = "0" → never use browser ASR (any device).
 * - Narrow viewports (max-width 768px): default to MediaRecorder + server ASR (more reliable than Web Speech on phones).
 * - localStorage VERA_BROWSER_ASR_PHONE = "1" → opt in to Web Speech on narrow viewports (Chrome only).
 * - localStorage VERA_BROWSER_ASR_PHONE = "0" → force server ASR on narrow viewports (same as default).
 */
function isLikelyGoogleChrome() {
  try {
    const ua = navigator.userAgent || "";
    if (/Edg\/|OPR\/|Opera\/|SamsungBrowser/i.test(ua)) return false;
    if (/CriOS\//.test(ua)) return true;
    return /Chrome\/\d/.test(ua) && String(navigator.vendor || "").includes("Google");
  } catch {
    return false;
  }
}

/** Matches browserAsrPreferred() narrow branch: phone-sized layout vs desktop. */
function isNarrowViewport() {
  try {
    return window.matchMedia("(max-width: 768px)").matches;
  } catch {
    return false;
  }
}

function browserAsrPreferred() {
  if (browserAsrPermanentlyDisabled) return false;
  /* PART 2 of the ASR-mode spec: Whisper-only mode must never use browser
     ASR as the final transcript. Streaming + Hybrid both keep browser ASR
     enabled — Hybrid layers Whisper verification on top for risky commands
     (see decideAsrFinalizationMode below). */
  const mode = getVeraAsrMode();
  if (mode === "whisper") return false;
  /* Opening index.html as file:// is unstable for Web Speech + permissions; use http://localhost or HTTPS. */
  if (typeof location !== "undefined" && location.protocol === "file:") {
    return false;
  }
  /* Web Speech API requires a secure context (HTTPS or localhost). */
  if (typeof window.isSecureContext !== "undefined" && !window.isSecureContext) {
    return false;
  }
  if (!browserAsrSupported()) return false;
  try {
    if (localStorage.getItem("VERA_BROWSER_ASR") === "0") return false;
  } catch {}
  try {
    if (isNarrowViewport()) {
      try {
        if (localStorage.getItem("VERA_BROWSER_ASR_PHONE") === "0") return false;
      } catch {}
      try {
        if (localStorage.getItem("VERA_BROWSER_ASR_PHONE") === "1") {
          return isLikelyGoogleChrome();
        }
      } catch {}
      return false;
    }
  } catch {}
  return true;
}

/* =========================================================================
   PART 6 — decideAsrFinalizationMode
   --------------------------------------------------------------------------
   Pure classifier that turns a finalized browser transcript (plus context)
   into one of three outcomes:
     - "browser_immediate"      → route the browser transcript right now
     - "whisper_verify"         → wait for Whisper to confirm/correct
     - "cancel_only_immediate"  → fast-path TTS stop; no LLM routing
   The classifier is called in hybrid mode AND from the interrupt path so
   barge-in / state-changing commands wait for the most accurate transcript
   without forcing single-Whisper latency on every utterance.
   ========================================================================= */

function _splitCancelPrefix(transcript) {
  const t = String(transcript || "").trim();
  if (!t) return { cancelPrefix: false, residue: "" };
  if (ASR_CANCEL_ONLY_RE.test(t)) return { cancelPrefix: true, residue: "" };
  const m = t.match(ASR_CANCEL_PREFIX_RE);
  if (!m) return { cancelPrefix: false, residue: t };
  const residue = t.slice(m[0].length).trim();
  return { cancelPrefix: true, residue };
}

function decideAsrFinalizationMode(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const browserTranscript = String(o.browserTranscript || "").trim();
  const browserConfidence = Number.isFinite(o.browserConfidence) ? Number(o.browserConfidence) : null;
  const isInterruption = !!o.isInterruption;
  const recentUiContext = o.recentUiContext || {};

  if (!browserTranscript) {
    return { mode: "browser_immediate", reason: "empty_browser_transcript", residueText: "" };
  }

  /* Mode gate. */
  const mode = getVeraAsrMode();
  if (mode === "streaming") {
    /* PART 3 + PART 13 of spec: streaming always routes browser-immediate;
       no Whisper round-trip. Cancel-only fast-path still detected so the
       UI can stop TTS without round-tripping. */
    if (ASR_CANCEL_ONLY_RE.test(browserTranscript)) {
      return { mode: "cancel_only_immediate", reason: "streaming_cancel_only_phrase", residueText: "" };
    }
    return { mode: "browser_immediate", reason: "streaming_mode", residueText: browserTranscript };
  }
  if (mode === "whisper") {
    /* PART 4: whisper-only mode never routes from the browser transcript.
       Even cancel-only commands wait for the (fast) Whisper pass when the
       user explicitly opted in. */
    return { mode: "whisper_verify", reason: "whisper_mode", residueText: browserTranscript };
  }

  /* hybrid mode ---------------------------------------------------------- */

  const { cancelPrefix, residue } = _splitCancelPrefix(browserTranscript);

  /* Pure cancel-only: stop TTS, do not route. */
  if (cancelPrefix && !residue) {
    return { mode: "cancel_only_immediate", reason: "cancel_only_phrase", residueText: "" };
  }
  /* "stop, sync the plan" — strip "stop", verify the residue with Whisper
     because the leftover command is state-changing. */
  if (cancelPrefix && residue) {
    return {
      mode: "whisper_verify",
      reason: "cancel_prefix_with_state_changing_residue",
      residueText: residue,
      cancelPrefixStripped: true,
    };
  }

  if (ASR_EXPLICIT_ACCURATE_RE.test(browserTranscript)) {
    return { mode: "whisper_verify", reason: "explicit_accurate_request", residueText: browserTranscript };
  }
  if (ASR_RISKY_VOCAB_RE.test(browserTranscript)) {
    return { mode: "whisper_verify", reason: "risky_vocabulary", residueText: browserTranscript };
  }
  if (ASR_ORDINAL_OR_RANGE_RE.test(browserTranscript)) {
    return { mode: "whisper_verify", reason: "ordinal_or_range_phrase", residueText: browserTranscript };
  }
  if (ASR_STATE_CHANGING_RE.test(browserTranscript) && browserTranscript.length >= 18) {
    return { mode: "whisper_verify", reason: "state_changing_verb_long_utterance", residueText: browserTranscript };
  }
  if (browserTranscript.length > 160) {
    return { mode: "whisper_verify", reason: "long_dictation", residueText: browserTranscript };
  }
  if (browserConfidence !== null && browserConfidence < 0.5) {
    return { mode: "whisper_verify", reason: "low_browser_confidence", residueText: browserTranscript };
  }
  if (isInterruption) {
    /* Interruption with a non-cancel residue is, by definition, mutating
       something the user was waiting on. Verify. */
    return { mode: "whisper_verify", reason: "interruption_non_cancel", residueText: browserTranscript };
  }
  /* Default for hybrid: browser_immediate. */
  return { mode: "browser_immediate", reason: "hybrid_low_risk", residueText: browserTranscript };
}

/* =========================================================================
   PART 9 — chooseBestTranscript
   --------------------------------------------------------------------------
   Conservative selector. Prefers Whisper unless it looks degenerate
   (empty, truncated, hallucinatory) or much shorter than the browser
   transcript. Returns { selected, source, edit_distance, length_ratio,
   token_overlap, reason }.
   ========================================================================= */
function _normalizeForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function _levenshtein(a, b) {
  /* O(|a|*|b|) Levenshtein. Capped to inputs under 1000 chars (long
     dictation rarely benefits from edit distance — token overlap is
     better, see below). */
  const A = String(a || "");
  const B = String(b || "");
  if (A.length === 0) return B.length;
  if (B.length === 0) return A.length;
  if (A.length > 1000 || B.length > 1000) return Math.max(A.length, B.length);
  let prev = new Array(B.length + 1);
  let curr = new Array(B.length + 1);
  for (let j = 0; j <= B.length; j += 1) prev[j] = j;
  for (let i = 1; i <= A.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= B.length; j += 1) {
      const cost = A.charCodeAt(i - 1) === B.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[B.length];
}
function _tokenOverlapRatio(a, b) {
  const at = new Set(_normalizeForCompare(a).split(" ").filter(Boolean));
  const bt = new Set(_normalizeForCompare(b).split(" ").filter(Boolean));
  if (!at.size || !bt.size) return 0;
  let hit = 0;
  for (const w of at) if (bt.has(w)) hit += 1;
  return hit / Math.max(at.size, bt.size);
}
function _looksHallucinated(s) {
  /* Whisper sometimes emits "Thank you. Thank you. Thank you." or "..."
     on near-silent inputs. Detect short transcripts with very low entropy. */
  const t = _normalizeForCompare(s);
  if (!t) return false;
  const toks = t.split(" ");
  if (toks.length < 3) return false;
  const uniq = new Set(toks);
  return uniq.size / toks.length < 0.34;
}

function chooseBestTranscript(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const browser = String(o.browserTranscript || "").trim();
  const whisper = String(o.whisperTranscript || "").trim();
  const whisperConfidence = Number.isFinite(o.whisperConfidence) ? Number(o.whisperConfidence) : null;

  if (!browser && !whisper) {
    return { selected: "", source: "empty_both", edit_distance: 0, length_ratio: 0, token_overlap: 0, reason: "both_empty" };
  }
  if (browser && !whisper) {
    return { selected: browser, source: "hybrid_browser", edit_distance: browser.length, length_ratio: 0, token_overlap: 0, reason: "whisper_empty" };
  }
  if (whisper && !browser) {
    return { selected: whisper, source: "hybrid_whisper", edit_distance: whisper.length, length_ratio: 0, token_overlap: 0, reason: "browser_empty" };
  }

  const nb = _normalizeForCompare(browser);
  const nw = _normalizeForCompare(whisper);
  const ed = _levenshtein(nb, nw);
  const lenRatio = nb.length ? nw.length / nb.length : (nw.length ? Infinity : 1);
  const overlap = _tokenOverlapRatio(nb, nw);

  /* Degenerate-Whisper escape hatches. */
  if (_looksHallucinated(whisper)) {
    return { selected: browser, source: "hybrid_browser", edit_distance: ed, length_ratio: lenRatio, token_overlap: overlap, reason: "whisper_looks_hallucinated" };
  }
  if (whisperConfidence !== null && whisperConfidence < 0.35 && lenRatio < 0.6) {
    return { selected: browser, source: "hybrid_browser", edit_distance: ed, length_ratio: lenRatio, token_overlap: overlap, reason: "whisper_low_conf_and_short" };
  }
  /* Whisper is much shorter than browser AND captures fewer tokens — likely
     truncated. */
  if (lenRatio < 0.55 && overlap < 0.55 && nb.length > 18) {
    return { selected: browser, source: "hybrid_browser", edit_distance: ed, length_ratio: lenRatio, token_overlap: overlap, reason: "whisper_truncated" };
  }
  /* Default: prefer Whisper. */
  return { selected: whisper, source: "hybrid_whisper", edit_distance: ed, length_ratio: lenRatio, token_overlap: overlap, reason: "prefer_whisper_default" };
}

/* =========================================================================
   PART 10 — conservative command normalization
   --------------------------------------------------------------------------
   When the selected transcript still doesn't parse as a known command but
   is close to one (small edit distance / known mishears), apply a targeted
   rewrite so the action router sees the intended command. This must NEVER
   touch general conversation — only known-vocabulary mishears.
   ========================================================================= */

function normalizeCommandTranscript(text, opts = {}) {
  const t = String(text || "");
  if (!t) {
    return { normalized: t, applied: false, corrections: [], reason: "empty" };
  }
  /* Self-authorize when the input itself is a known-vocabulary mishear:
     the *corrected* form ("sync the plan", "news panel", ...) IS a command
     by construction, so the gate would otherwise discard the very cases
     this normalizer exists to fix. We also retain the explicit command
     verb gates for general state-changing language. */
  const matchesKnownMishear = ASR_COMMAND_NORMALIZATIONS.some(([pat]) => {
    pat.lastIndex = 0;
    return pat.test(t);
  });
  const looksLikeCommand =
    matchesKnownMishear
    || ASR_STATE_CHANGING_RE.test(t)
    || /\b(?:open|close|show|hide|switch|select|play|pause|resume|skip|mute|unmute|delete|remove|cross\s+off|sync|create|add|new|next|previous|continue|go\s+to|jump\s+to)\b/i.test(t)
    || (opts && opts.forceCommandContext === true);
  if (!looksLikeCommand) {
    return { normalized: t, applied: false, corrections: [], reason: "no_command_context" };
  }
  let out = t;
  const corrections = [];
  for (const [pat, repl, why] of ASR_COMMAND_NORMALIZATIONS) {
    pat.lastIndex = 0;
    if (pat.test(out)) {
      const before = out;
      out = out.replace(pat, repl);
      if (out !== before) {
        corrections.push({ pattern: String(pat), replacement: repl, why });
      }
    }
  }
  return {
    normalized: out,
    applied: corrections.length > 0,
    corrections,
    reason: corrections.length ? "command_vocab_correction" : "no_match",
  };
}

/* =========================
   READ-ONLY ACCESSOR  (new, additive — Stage 7)

   Small named snapshot that mirrors getTtsDebugState() /
   getInterruptionDebugState(). Returns the current persisted ASR
   settings and derived predicates without touching any state.
========================= */

function getAsrDebugState() {
  let mode;
  try { mode = getVeraAsrMode(); } catch (_) { mode = VERA_ASR_MODE_DEFAULT; }
  let silenceMs;
  try { silenceMs = getVeraAsrSilenceMs(); } catch (_) { silenceMs = 1300; }
  let partialMinChars;
  try { partialMinChars = getMainAsrPartialMinChars(); } catch (_) { partialMinChars = MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT; }
  let browserPreferred = null;
  try { browserPreferred = browserAsrPreferred(); } catch (_) {}
  let browserSupported = null;
  try { browserSupported = browserAsrSupported(); } catch (_) {}
  let narrowViewport = null;
  try { narrowViewport = isNarrowViewport(); } catch (_) {}
  let likelyGoogleChrome = null;
  try { likelyGoogleChrome = isLikelyGoogleChrome(); } catch (_) {}
  let permanentlyDisabled = null;
  try {
    if (typeof browserAsrPermanentlyDisabled !== "undefined") {
      permanentlyDisabled = !!browserAsrPermanentlyDisabled;
    }
  } catch (_) {}
  return {
    mode,
    isStreaming: mode === "streaming",
    isWhisper: mode === "whisper",
    isHybrid: mode === "hybrid",
    hybridPolicy: HYBRID_POLICY,
    silenceMs,
    partialMinChars: partialMinChars === Infinity ? "inf" : partialMinChars,
    browserSupported,
    browserPreferred,
    browserPermanentlyDisabled: permanentlyDisabled,
    narrowViewport,
    likelyGoogleChrome,
  };
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Preserve the pre-extraction exports verbatim (decideAsrFinalizationMode,
 *  chooseBestTranscript, normalizeCommandTranscript, getVeraAsrMode,
 *  setVeraAsrMode). The new accessor `getAsrDebugState` is additive and
 *  exposed under `window.getAsrDebugState` for DevTools snippets.
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.decideAsrFinalizationMode = decideAsrFinalizationMode;
    window.chooseBestTranscript = chooseBestTranscript;
    window.normalizeCommandTranscript = normalizeCommandTranscript;
    window.getVeraAsrMode = getVeraAsrMode;
    window.setVeraAsrMode = setVeraAsrMode;
    window.getAsrDebugState = getAsrDebugState;
  }
} catch (_) {}
