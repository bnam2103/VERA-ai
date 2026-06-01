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

/* =============================================================================
 * STAGE 15 EXTRACTION (2026-05-31): VOICE DURATION CAP
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js of two non-adjacent blocks (118 LF-terminated source
 * lines total, re-terminated as CRLF here to match this file's native line
 * endings):
 *   - app.js L240..L245 (6 lines): cap-internal state declarations
 *     (voiceSpeechStartedAt, voiceMaxDurationTimerId,
 *      voiceMaxDurationLastFiredAt) and the "Speech-start guarded
 *      voice-duration cap" doc comment that precedes them.
 *   - app.js L515..L626 (112 lines): the "VOICE DURATION CAP (60s after
 *     speech-start)" function block (clearVoiceMaxDurationTimer,
 *     armVoiceMaxDurationTimer, handleVoiceMaxDurationLimit) and its
 *     section banner.
 *
 * Symbols moved (all kept at the file's top-level so classic-script global
 * bare-identifier visibility is preserved):
 *   - let voiceSpeechStartedAt          (cap-internal state)
 *   - let voiceMaxDurationTimerId       (cap-internal state)
 *   - let voiceMaxDurationLastFiredAt   (cap-internal state)
 *   - function clearVoiceMaxDurationTimer   (idempotent reset)
 *   - function armVoiceMaxDurationTimer     (one-shot per utterance)
 *   - function handleVoiceMaxDurationLimit  (timer fire handler)
 *
 * Intentionally LEFT in app.js per Patch A-8 scope: full speech detection
 * loop, infer pipeline, handleUtterance, Work Mode TTS queue, TTS queue,
 * barge-in debug overlay. None of these were part of the cap block.
 *
 * External call sites (all in app.js, all resolve at call time):
 *   - 7 clearVoiceMaxDurationTimer() invocations (cleanup / stop / reset).
 *   - 4 armVoiceMaxDurationTimer(<reason>) invocations:
 *       "vad_speech_frame"
 *       "browser_asr_first_partial_interrupt"
 *       "browser_asr_first_partial_main"
 *       "browser_asr_first_partial_post_interrupt"
 *   - handleVoiceMaxDurationLimit has no external callers; it is only
 *     invoked from inside armVoiceMaxDurationTimer's setTimeout (which
 *     moves with it).
 *
 * Cross-file bare-identifier resolution at call time (into app.js):
 *   - VERA_SAFETY_LIMITS                (config object, app.js)
 *   - isVeraWorkModeOn                  (workmode/checklist.js, optional-chained)
 *   - mainBrowserRecognition            (let in app.js)
 *   - mediaRecorder                     (let in app.js)
 *   - listening / processing / waveState (let in app.js)
 *   - updateMuteInputButton, setStatus, veraShowCapabilityFailureBubble
 *
 * Hard-rule preservation (Patch A-8):
 *   - Max-duration value (60s) UNCHANGED.
 *   - User-facing safety message (VERA_SAFETY_LIMITS.messages.voiceDurationLimit)
 *     read by the same bare-identifier reference; wording UNCHANGED.
 *   - Recording-stop behavior (mainBrowserRecognition.stop/abort,
 *     mediaRecorder.stop, listening/processing/waveState reset) UNCHANGED.
 *   - Console log keys [voice_speech_started] and [voice_duration_limit]
 *     preserved byte-identically.
 * ============================================================================= */

/* Speech-start guarded voice-duration cap. Pre-speech silence is governed
   by the existing no-speech / idle timeouts; this fires only AFTER the user
   actually starts speaking. See `armVoiceMaxDurationTimer`. */
let voiceSpeechStartedAt = 0;
let voiceMaxDurationTimerId = null;
let voiceMaxDurationLastFiredAt = 0;

/* =========================
   VOICE DURATION CAP (60s after speech-start)
========================= */

/**
 * Clear any pending voice-duration timer. Always safe to call; no-op if
 * the timer was never armed.
 */
function clearVoiceMaxDurationTimer() {
  if (voiceMaxDurationTimerId != null) {
    try { clearTimeout(voiceMaxDurationTimerId); } catch (_) {}
    voiceMaxDurationTimerId = null;
  }
  voiceSpeechStartedAt = 0;
}

/**
 * Arm the 60s post-speech-start cap exactly once per utterance. Safe to
 * call from every spot where `hasSpoken` flips to true (browser ASR
 * partial / MediaRecorder VAD speech-frame); subsequent calls during the
 * same utterance are no-ops.
 *
 * When the timer fires it gracefully stops whichever recorder is alive:
 *   - For browser SpeechRecognition continuous: lets the current partial
 *     turn finalize via the normal end-of-utterance scheduling so a
 *     substantive transcript is not lost. If there is no transcript yet,
 *     just stops the recognizer and shows the duration bubble.
 *   - For MediaRecorder: calls `.stop()` which routes through the normal
 *     `handleUtterance` upload path, then shows the bubble.
 *
 * The fallback bubble appears at most once per ~5s to avoid duplicates
 * when both paths happen to be alive.
 */
function armVoiceMaxDurationTimer(reason) {
  if (voiceMaxDurationTimerId != null) return; // already armed
  voiceSpeechStartedAt = Date.now();
  const ms = Math.max(
    5000,
    Number(VERA_SAFETY_LIMITS.voiceMaxDurationAfterSpeechSec) * 1000
  );
  try {
    console.info("[voice_speech_started]", {
      reason: String(reason || "first_partial"),
      max_duration_sec: VERA_SAFETY_LIMITS.voiceMaxDurationAfterSpeechSec
    });
  } catch (_) {}
  voiceMaxDurationTimerId = setTimeout(() => {
    voiceMaxDurationTimerId = null;
    handleVoiceMaxDurationLimit();
  }, ms);
}

function handleVoiceMaxDurationLimit() {
  const now = Date.now();
  // Burst guard — only one fallback per 5s even if both pipes trip.
  if (now - voiceMaxDurationLastFiredAt < 5000) return;
  voiceMaxDurationLastFiredAt = now;
  try {
    console.warn("[voice_duration_limit]", {
      reason: "voice_duration_limit",
      mode: isVeraWorkModeOn?.() ? "work_mode" : "non_work",
      feature: "voice",
      max_duration_sec: VERA_SAFETY_LIMITS.voiceMaxDurationAfterSpeechSec
    });
  } catch (_) {}

  // 1) Try to stop the Web Speech recognizer cleanly, preserving any
  //    accumulated transcript so the normal /infer flow can still run.
  let webStopped = false;
  try {
    if (typeof mainBrowserRecognition !== "undefined" && mainBrowserRecognition) {
      try { mainBrowserRecognition.stop(); } catch (_) {
        try { mainBrowserRecognition.abort(); } catch (_) {}
      }
      webStopped = true;
    }
  } catch (_) {}

  // 2) Stop active MediaRecorder so its `onstop` fires `handleUtterance`.
  let mediaStopped = false;
  try {
    if (typeof mediaRecorder !== "undefined" && mediaRecorder &&
        mediaRecorder.state === "recording") {
      try { mediaRecorder.stop(); } catch (_) {}
      mediaStopped = true;
    }
  } catch (_) {}

  // 3) Reset wave / listening UI so the strip cannot appear stuck.
  try {
    listening = false;
    processing = false;
    waveState = "idle";
    if (typeof updateMuteInputButton === "function") updateMuteInputButton();
    setStatus("Ready", "idle");
  } catch (_) {}

  /* 4) Bubble — keep wording exactly to spec; voice + work-mode both show
        this in the conversation strip (not inside the reasoning panel).
        Skip if no recorder was actually stopped: the recording session
        must have ended cleanly while the timer was still scheduled (e.g.
        normal silence-stop landed milliseconds before the cap fired). */
  if (webStopped || mediaStopped) {
    veraShowCapabilityFailureBubble(
      "voice_duration_limit",
      VERA_SAFETY_LIMITS.messages.voiceDurationLimit,
      { minIntervalMs: 5000 }
    );
  }
  clearVoiceMaxDurationTimer();
}


/* =============================================================================
 * STAGE 16 EXTRACTION (2026-05-31): HYBRID SIDECAR RECORDER
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js L1937..L2039 (103 LF-terminated source lines,
 * re-terminated as CRLF here to match this file's native line endings).
 *
 * Stage 7 (2026-05-27) deliberately left this block in app.js because its
 * MediaRecorder lifecycle is coupled to the mic stream and the /infer
 * multipart upload pipeline. Patch A-9 (this stage) reverses that decision:
 * the block is now alongside the other ASR-mode helpers in voice/asr.js,
 * and the two cross-file references it still makes into app.js
 * (createVeraMediaRecorder, _pickRecorderMime) resolve at call time via
 * the shared classic-script global lexical environment. Stage 7's "left
 * in app.js" justification for createVeraMediaRecorder and _pickRecorderMime
 * is preserved -- those helpers themselves were NOT moved.
 *
 * Symbols moved (all kept at file top-level so classic-script global
 * bare-identifier visibility is preserved):
 *   - let hybridSidecarRecorder            (state: active sidecar)
 *   - let hybridSidecarChunks              (state: collected blobs)
 *   - let hybridSidecarMimeType            (state: negotiated MIME)
 *   - let hybridSidecarStartedAt           (state: start time, perf.now())
 *   - function isHybridSidecarRunning     (cheap "is sidecar live?" gate)
 *   - function _stopAndCollectHybridSidecar (async stop + collect blob)
 *   - function _discardHybridSidecar      (fire-and-forget cleanup)
 *   - function startHybridSidecarRecorderIfNeeded
 *     (one-shot arm when ASR mode === "hybrid"; chunked recording with
 *      250 ms timeslice; emits [asr_mode_debug] log entries)
 *
 * Intentionally LEFT in app.js per Patch A-9 scope: full speech detection
 * loop, infer pipeline, handleUtterance, TTS code, Work Mode TTS queue,
 * debug overlay code. Stage 7-era helpers also remain in app.js:
 * createVeraMediaRecorder, _pickRecorderMime, VERA_RECORDER_BITS_PER_SECOND,
 * VERA_RECORDER_MIME_PREFS, logVeraSettings.
 *
 * External call sites (all in app.js, all resolve at call time):
 *   - isHybridSidecarRunning()           (1 gate in /infer finalize)
 *   - _stopAndCollectHybridSidecar()     (1 site in /infer finalize)
 *   - _discardHybridSidecar()            (2 sites in /infer finalize)
 *   - startHybridSidecarRecorderIfNeeded (1 site in mic-arming path)
 *
 * Cross-file bare-identifier resolution at call time (into app.js):
 *   - createVeraMediaRecorder            (recorder ctor wrapper)
 *   - _pickRecorderMime                  (preferred MIME picker)
 *
 * Hard-rule preservation (Patch A-9):
 *   - ASR mode selection logic UNCHANGED (still gated by isHybridAsrMode).
 *   - Whisper / browser / hybrid behavior UNCHANGED.
 *   - Recorder options (250 ms timeslice, MIME selection) UNCHANGED.
 *   - [asr_mode_debug] log entries (hybrid_sidecar_started,
 *     hybrid_sidecar_error, hybrid_sidecar_start_failed) preserved
 *     byte-identically.
 * ============================================================================= */

/* =========================================================================
   PART 5 + 7 — Hybrid sidecar recorder
   --------------------------------------------------------------------------
   When the ASR mode is "hybrid", we run the existing browser SpeechRecognition
   path AND record the same microphone audio in parallel. On finalization,
   decideAsrFinalizationMode() inspects the browser transcript. If a Whisper
   verification is warranted, we send BOTH the browser transcript AND the
   recorded audio blob to /infer with request_whisper_verify=1. Otherwise
   the blob is discarded.
   ========================================================================= */
let hybridSidecarRecorder = null;
let hybridSidecarChunks = [];
let hybridSidecarMimeType = "";
let hybridSidecarStartedAt = 0;

function isHybridSidecarRunning() {
  return !!hybridSidecarRecorder && hybridSidecarRecorder.state === "recording";
}

function _stopAndCollectHybridSidecar() {
  return new Promise((resolve) => {
    const rec = hybridSidecarRecorder;
    if (!rec) {
      resolve({ blob: null, mimeType: "", durationMs: 0, chunkCount: 0 });
      return;
    }
    const startedAt = hybridSidecarStartedAt;
    const mimeType = hybridSidecarMimeType || rec.mimeType || "audio/webm";
    const finalize = () => {
      try {
        const blob = hybridSidecarChunks.length
          ? new Blob(hybridSidecarChunks, { type: mimeType })
          : null;
        resolve({
          blob,
          mimeType,
          durationMs: startedAt ? Math.max(0, performance.now() - startedAt) : 0,
          chunkCount: hybridSidecarChunks.length,
        });
      } catch (_) {
        resolve({ blob: null, mimeType, durationMs: 0, chunkCount: 0 });
      } finally {
        hybridSidecarChunks = [];
        hybridSidecarRecorder = null;
        hybridSidecarStartedAt = 0;
        hybridSidecarMimeType = "";
      }
    };
    if (rec.state === "inactive") { finalize(); return; }
    const prev = rec.onstop;
    rec.onstop = (e) => {
      try { if (typeof prev === "function") prev(e); } catch (_) {}
      finalize();
    };
    try { rec.stop(); } catch (_) { finalize(); }
  });
}

function _discardHybridSidecar() {
  const rec = hybridSidecarRecorder;
  if (!rec) return;
  try { if (rec.state !== "inactive") rec.stop(); } catch (_) {}
  hybridSidecarChunks = [];
  hybridSidecarRecorder = null;
  hybridSidecarStartedAt = 0;
  hybridSidecarMimeType = "";
}

function startHybridSidecarRecorderIfNeeded(micStream) {
  if (!isHybridAsrMode()) return false;
  if (!micStream || !micStream.active) return false;
  if (typeof MediaRecorder === "undefined") return false;
  if (isHybridSidecarRunning()) return true;
  try {
    const rec = createVeraMediaRecorder(micStream);
    hybridSidecarChunks = [];
    hybridSidecarMimeType = rec.mimeType || _pickRecorderMime() || "audio/webm";
    rec.ondataavailable = (e) => {
      if (e && e.data && e.data.size > 0) hybridSidecarChunks.push(e.data);
    };
    rec.onerror = (e) => {
      try {
        console.warn("[asr_mode_debug]", { stage: "hybrid_sidecar_error", error: String(e?.error || e) });
      } catch (_) {}
    };
    /* Request periodic chunks so we don't lose anything if the recorder is
       stopped before the browser ASR final settles. 250ms is plenty for
       short commands and small enough that interrupt path is responsive. */
    rec.start(250);
    hybridSidecarRecorder = rec;
    hybridSidecarStartedAt = performance.now();
    try {
      console.info("[asr_mode_debug]", { stage: "hybrid_sidecar_started", mimeType: hybridSidecarMimeType });
    } catch (_) {}
    return true;
  } catch (e) {
    try {
      console.warn("[asr_mode_debug]", { stage: "hybrid_sidecar_start_failed", error: String(e?.message || e) });
    } catch (_) {}
    return false;
  }
}


/* =============================================================================
 * STAGE 17 EXTRACTION (2026-05-31): MEDIARECORDER CONSTRUCTION HELPER
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js L1894..L1936 (43 LF-terminated source lines,
 * re-terminated as CRLF here to match this file's native line endings).
 *
 * Stage 7 (2026-05-27) left these helpers in app.js with the rationale
 * "Recorder construction - not an ASR-mode decision; coupled to the recorder
 * lifecycle." Patch A-9 (Stage 16, 2026-05-31) moved the hybrid sidecar
 * recorder into voice/asr.js but kept these helpers in app.js. Patch A-10
 * (this stage) finishes the consolidation: the recorder ctor helpers now
 * live alongside the sidecar recorder that is one of their primary clients,
 * so the intra-file calls from startHybridSidecarRecorderIfNeeded (Stage 16)
 * to createVeraMediaRecorder and _pickRecorderMime become local rather than
 * cross-file.
 *
 * Symbols moved (all kept at file top-level so classic-script global
 * bare-identifier visibility is preserved):
 *   - const VERA_RECORDER_BITS_PER_SECOND   (64 kbps default for Opus)
 *   - const VERA_RECORDER_MIME_PREFS        (preference order, length 4)
 *   - function _pickRecorderMime           (probe MediaRecorder.isTypeSupported)
 *   - function createVeraMediaRecorder     (ctor wrapper with bare-ctor fallback)
 *
 * Intentionally LEFT in app.js per Patch A-10 scope: full speech detection
 * loop, infer pipeline, handleUtterance, TTS code. (The sidecar recorder
 * is already in this file as of Stage 16 / Patch A-9.)
 *
 * External call sites (all in app.js, all resolve at call time):
 *   - createVeraMediaRecorder(micStream) x 4 sites:
 *       * interruptRecorder       = createVeraMediaRecorder(micStream)
 *       * interruptPrearmRecorder = createVeraMediaRecorder(micStream)
 *       * mediaRecorder           = createVeraMediaRecorder(micStream)  (main arm)
 *       * mediaRecorder           = createVeraMediaRecorder(micStream)  (re-arm)
 *   - _pickRecorderMime has no external callers (only used by the moved
 *     createVeraMediaRecorder and by startHybridSidecarRecorderIfNeeded,
 *     which already lives in this file).
 *
 * Cross-file bare-identifier resolution at call time:
 *   - The moved block calls into NO app.js helpers (only browser-built-in
 *     MediaRecorder + MediaRecorder.isTypeSupported). Pure self-contained
 *     extraction.
 *
 * Hard-rule preservation (Patch A-10):
 *   - MIME-type selection order UNCHANGED: ["audio/webm;codecs=opus",
 *     "audio/ogg;codecs=opus", "audio/webm", ""].
 *   - Empty-string sentinel still means "fall back to browser default".
 *   - audioBitsPerSecond default (64_000) UNCHANGED.
 *   - Bare-ctor fallback chain UNCHANGED (new MediaRecorder(stream, init)
 *     -> new MediaRecorder(stream, { mimeType }) -> new MediaRecorder(stream)).
 *   - opts overrides (opts.mimeType, opts.audioBitsPerSecond) UNCHANGED.
 * ============================================================================= */

/* =========================================================================
   PART 12 — MediaRecorder construction helper
   --------------------------------------------------------------------------
   Centralizes mimeType + audioBitsPerSecond preference order so every
   recording path (main, interrupt-prearm, hybrid sidecar) gets the best
   format the browser supports. Opus is widely supported, decodes cleanly
   on the server via pydub/ffmpeg, and survives small chunk drops better
   than legacy webm. The 64 kbps default is plenty for Whisper accuracy on
   a single voice mic.
   ========================================================================= */
const VERA_RECORDER_BITS_PER_SECOND = 64_000;
const VERA_RECORDER_MIME_PREFS = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "", // browser default
];
function _pickRecorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const isSupported = typeof MediaRecorder.isTypeSupported === "function";
  if (!isSupported) return "";
  for (const m of VERA_RECORDER_MIME_PREFS) {
    if (!m) return "";
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return "";
}
function createVeraMediaRecorder(stream, opts = {}) {
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder unavailable");
  const mimeType = opts.mimeType != null ? opts.mimeType : _pickRecorderMime();
  const audioBitsPerSecond = opts.audioBitsPerSecond != null ? opts.audioBitsPerSecond : VERA_RECORDER_BITS_PER_SECOND;
  const init = {};
  if (mimeType) init.mimeType = mimeType;
  if (audioBitsPerSecond) init.audioBitsPerSecond = audioBitsPerSecond;
  try {
    return new MediaRecorder(stream, init);
  } catch (_) {
    /* Some browsers throw on unknown init keys. Fall back to bare ctor. */
    try { return new MediaRecorder(stream, mimeType ? { mimeType } : undefined); }
    catch (_) { return new MediaRecorder(stream); }
  }
}


/* =============================================================================
 * STAGE 22 EXTRACTION (2026-05-31): SPEECH DETECTION (MAIN VAD LOOP)
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js:
 *   - L18051..L18064 (14 LF-terminated source lines): the
 *     listeningFrameIsSpeechLike RMS + ZCR voiced-band gate (its JSDoc
 *     "RMS + ZCR voiced band" one-line JSDoc included verbatim).
 *   - L19951..L20009 (59 LF-terminated source lines): the original
 *     "SPEECH DETECTION" banner + function detectSpeech (main RAF
 *     VAD loop) + function clearSpeechWaitTimerAndDetectRaf (RAF +
 *     no-speech-timeout teardown that also drops the voice-duration
 *     cap that Stage 15 already lives in this file).
 * Re-terminated as CRLF here to match this file's native line endings.
 *
 * Symbols moved (function declarations hoist within this file; bare-
 * identifier references resolve at CALL TIME through the shared global
 * lexical environment, the same pattern Stages 7 / 15 / 16 / 17 already
 * rely on for the rest of the ASR layer):
 *   - function listeningFrameIsSpeechLike(buf, rms)
 *       reads computeZCR (LEFT in app.js -- pure helper also used by
 *       the interrupt VAD loop at app.js L17761), IS_MOBILE (const in
 *       app.js), VOLUME_THRESHOLD, LISTEN_END_ZCR_MIN, LISTEN_END_ZCR_MAX
 *       (const thresholds in app.js -- per hard rule, NOT moved).
 *   - function detectSpeech() (main RAF VAD loop)
 *       reads/mutates app.js-owned state: mediaRecorder, analyser,
 *       inputMuted, suppressNextUtterance, hasSpoken, lastVoiceTime,
 *       rafId; reads thresholds SILENCE_MS + TRAILING_MS (const in
 *       app.js); calls bare identifiers showMutedStatusIfIdle,
 *       getAudioEl, beginVoiceUxTurn (all LEFT in app.js per scope --
 *       beginVoiceUxTurn is tightly coupled to the /infer pipeline);
 *       calls armVoiceMaxDurationTimer (already in this file -- Stage
 *       15) when the first speech-like frame arrives; chains itself
 *       via requestAnimationFrame(detectSpeech). The trigger condition
 *       (hasSpoken AND now - lastVoiceTime > SILENCE_MS + TRAILING_MS
 *       AND (getAudioEl()?.paused ?? true)) and the side-effects
 *       (beginVoiceUxTurn() THEN mediaRecorder.stop()) are preserved
 *       byte-identically.
 *   - function clearSpeechWaitTimerAndDetectRaf()
 *       clears speechWaitTimeoutId (let in app.js, mutated cross-file
 *       through shared global lex env) and rafId (let in app.js),
 *       then calls clearVoiceMaxDurationTimer (already in this file --
 *       Stage 15) to drop the voice-duration cap that is bound to an
 *       active recording session.
 *
 * Intentionally LEFT in app.js per Patch A-11 scope:
 *   - function computeZCR(buf)               pure helper; shared with
 *                                            the interrupt VAD loop.
 *   - function detectInterruptSpeechEnd()    barge-in detection loop
 *                                            (explicitly excluded by
 *                                            patch scope -- "Do not
 *                                            move: barge-in debug
 *                                            overlay" and the broader
 *                                            interrupt detection).
 *   - function beginVoiceUxTurn()            tightly coupled to the
 *                                            /infer pipeline; patch
 *                                            scope explicitly says
 *                                            "leave it in app.js
 *                                            unless moving it is
 *                                            clearly safe".
 *   - const VOLUME_THRESHOLD, SILENCE_MS, TRAILING_MS,
 *     LISTEN_END_ZCR_MIN, LISTEN_END_ZCR_MAX (RMS/ZCR/silence
 *     thresholds -- byte-identity required by hard rule).
 *   - let mediaRecorder, analyser, hasSpoken, lastVoiceTime, rafId,
 *     speechWaitTimeoutId, inputMuted, suppressNextUtterance (state
 *     mutated by many app.js code paths beyond the VAD loop).
 *
 * External call sites (all in app.js; all resolve via shared classic-
 * script global lexical environment at call time):
 *   - detectSpeech():                                 app.js L21327
 *                                                     (initial RAF kick
 *                                                     after start-of-
 *                                                     listening).
 *   - listeningFrameIsSpeechLike():                   app.js L18024
 *                                                     (inside the
 *                                                     interrupt VAD
 *                                                     loop, NOT moved).
 *   - clearSpeechWaitTimerAndDetectRaf():             app.js L20016
 *                                                     (stopActiveMicCa
 *                                                     ptureSilently) +
 *                                                     app.js L21296.
 *
 * Hard-rule preservation (Patch A-11):
 *   - Function names + signatures unchanged.
 *   - RMS / ZCR / silence thresholds NOT touched (kept in app.js).
 *   - The when-mediaRecorder.stop()-fires condition is unchanged:
 *     hasSpoken && (now - lastVoiceTime) > SILENCE_MS + TRAILING_MS
 *     && (getAudioEl()?.paused ?? true), with beginVoiceUxTurn() called
 *     immediately before mediaRecorder.stop().
 *   - Wave / listening UI behavior unchanged (showMutedStatusIfIdle is
 *     still called inside detectSpeech for the muted branch).
 *   - VAD debug logs / armVoiceMaxDurationTimer("vad_speech_frame")
 *     trace event preserved byte-identically.
 *   - "restartSpeechDetection" was named in the patch scope but does
 *     not exist in app.js (grep confirmed); no symbol invented.
 * ============================================================================= */

/** RMS + ZCR voiced band — used so background noise alone does not stall end-of-speech. */
function listeningFrameIsSpeechLike(buf, rms) {
  const zcr = computeZCR(buf);
  if (IS_MOBILE) {
    /* Phone mics (Bluetooth, handset, AGC off) are often quieter and ZCR sits outside desktop bands. */
    const th = VOLUME_THRESHOLD * 0.55;
    if (rms <= th) return false;
    const zLo = LISTEN_END_ZCR_MIN * 0.55;
    const zHi = Math.min(0.28, LISTEN_END_ZCR_MAX * 1.35);
    return zcr >= zLo && zcr <= zHi;
  }
  if (rms <= VOLUME_THRESHOLD) return false;
  return zcr >= LISTEN_END_ZCR_MIN && zcr <= LISTEN_END_ZCR_MAX;
}

/* =========================
   SPEECH DETECTION
========================= */

function detectSpeech() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  if (inputMuted) {
    suppressNextUtterance = true;
    try {
      mediaRecorder.stop();
    } catch {}
    showMutedStatusIfIdle();
    return;
  }

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  const now = performance.now();

  if (listeningFrameIsSpeechLike(buf, rms)) {
    if (!hasSpoken) {
      armVoiceMaxDurationTimer("vad_speech_frame");
    }
    hasSpoken = true;
    lastVoiceTime = now;
  }

  if (
    hasSpoken &&
    now - lastVoiceTime > SILENCE_MS + TRAILING_MS &&
    (getAudioEl()?.paused ?? true) // 🔑 only stop when not speaking
  ) {
    beginVoiceUxTurn();
    mediaRecorder.stop();
    return;
  }

  rafId = requestAnimationFrame(detectSpeech);
}

function clearSpeechWaitTimerAndDetectRaf() {
  if (speechWaitTimeoutId != null) {
    clearTimeout(speechWaitTimeoutId);
    speechWaitTimeoutId = null;
  }
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  /* Voice-duration cap is bound to an active recording session. When the
     session is torn down (silence stop, abort, pipeline reset, PTT switch,
     etc.) the timer must not survive into the next utterance. */
  clearVoiceMaxDurationTimer();
}
