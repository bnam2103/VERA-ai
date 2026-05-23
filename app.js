/* =========================
   SESSION — VERA vs BMO (separate conversation memory on the server)
========================= */

const VERA_SESSION_STORAGE_KEY = "vera_session_id";
const BMO_SESSION_STORAGE_KEY = "bmo_session_id";

/**
 * Session ids are tab-scoped: switching pages keeps them, closing the tab clears them.
 * Migrate legacy ids from localStorage once for backward compatibility.
 */
function getSessionScopedId(key) {
  let id = "";
  try {
    id = sessionStorage.getItem(key) || "";
  } catch (_) {}
  if (id) return id;
  try {
    const legacy = localStorage.getItem(key) || "";
    if (legacy) {
      sessionStorage.setItem(key, legacy);
      localStorage.removeItem(key);
      return legacy;
    }
  } catch (_) {}
  return "";
}

function setSessionScopedId(key, id) {
  try {
    sessionStorage.setItem(key, id);
  } catch (_) {}
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}

function getSessionId() {
  const bmo = document.body.classList.contains("bmo-open");
  const key = bmo ? BMO_SESSION_STORAGE_KEY : VERA_SESSION_STORAGE_KEY;
  let id = getSessionScopedId(key);
  if (!id) {
    id = crypto.randomUUID();
    setSessionScopedId(key, id);
  }
  return id;
}

/**
 * Call when opening BMO: new backend session, empty log, voice input default, clear side panel.
 * Exposed for index.html `openBmoPage`.
 */
function resetBmoSessionAndUi() {
  const newId = crypto.randomUUID();
  setSessionScopedId(BMO_SESSION_STORAGE_KEY, newId);

  const convo = document.getElementById("bmo-conversation");
  if (convo) convo.replaceChildren();

  const textIn = document.getElementById("bmo-text-input");
  if (textIn) textIn.value = "";

  const voiceBar = document.getElementById("bmo-voice-bar");
  const keyboardBar = document.getElementById("bmo-keyboard-bar");
  const toggleBtn = document.getElementById("bmo-input-toggle");
  if (voiceBar) voiceBar.classList.remove("hidden");
  if (keyboardBar) keyboardBar.classList.add("hidden");
  if (toggleBtn) toggleBtn.textContent = "⌨️";

  const bmoAudio = document.getElementById("bmo-audio");
  if (bmoAudio) {
    bmoAudio.pause();
    bmoAudio.removeAttribute("src");
    bmoAudio.load?.();
  }

  document.getElementById("bmo-page")?.classList.remove("bmo-tts-mouth");
  document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-emotion");
  document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-face-track");

  hideSidePanel();
}

/**
 * Call when (re)entering the VERA app: new backend session, empty log, voice UI default, clear side panel.
 * Used on boot/reveal and when returning from BMO via the VERA nav control.
 */
function resetVeraSessionAndUi() {
  const prevSessionId = getSessionScopedId(VERA_SESSION_STORAGE_KEY);
  const newId = crypto.randomUUID();
  setSessionScopedId(VERA_SESSION_STORAGE_KEY, newId);

  const convo = document.getElementById("vera-conversation");
  if (convo) convo.replaceChildren();

  const textIn = document.getElementById("vera-text-input");
  if (textIn) textIn.value = "";

  const voiceBar = document.getElementById("vera-voice-bar");
  const keyboardBar = document.getElementById("vera-keyboard-bar");
  const toggleBtn = document.getElementById("vera-input-toggle");
  if (voiceBar) voiceBar.classList.remove("hidden");
  if (keyboardBar) keyboardBar.classList.add("hidden");
  if (toggleBtn) toggleBtn.textContent = "⌨️";

  const veraAudio = document.getElementById("vera-audio");
  if (veraAudio) {
    veraAudio.pause();
    veraAudio.removeAttribute("src");
    veraAudio.load?.();
  }

  /* Reset work-mode client artifacts too: checklist + reasoning panes/state. */
  try {
    localStorage.removeItem(WORK_CHECKLIST_STORAGE_KEY);
    localStorage.removeItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY);
    if (prevSessionId) {
      localStorage.removeItem(`${REASONING_TABS_STATE_STORAGE_KEY_PREFIX}:${prevSessionId}`);
    }
  } catch (_) {}
  ensureFixedReasoningLanePanels(new Map(), 0);
  renderReasoningTabStrip();
  loadWorkChecklistItems();
  flashWorkChecklistPlanHint("");
  workModeReasoningConfirmPending = null;
  clearWorkModePendingAttachments();
  closeWorkModeAttachmentPreviewModal();
  if (typeof clearVeraWorkModeClientTimer === "function") clearVeraWorkModeClientTimer();
  for (const ctl of workModeReasoningAbortControllers.values()) {
    try {
      ctl.abort();
    } catch (_) {}
  }
  workModeReasoningAbortControllers.clear();
  workModeReasoningLaneWaitQueue.length = 0;
  workModeTypedTurnQueue.length = 0;
  workModeTypedQueueDraining = false;
  workModeLastSubstantiveUserText = "";
  workModeLastSubstantiveLaneIdx = null;
  laneTopicSeedByIdx[0] = "";
  laneTopicSeedByIdx[1] = "";
  laneTopicSeedByIdx[2] = "";
  laneTopicSeedByIdx[3] = "";
  laneTopicSeedByIdx[4] = "";
  laneTopicSeedByIdx[5] = "";
  laneTopicSeedByIdx[6] = "";
  laneTopicSeedByIdx[7] = "";
  laneReasoningTurnCountByIdx[0] = 0;
  laneReasoningTurnCountByIdx[1] = 0;
  laneReasoningTurnCountByIdx[2] = 0;
  laneReasoningTurnCountByIdx[3] = 0;
  laneReasoningTurnCountByIdx[4] = 0;
  laneReasoningTurnCountByIdx[5] = 0;
  laneReasoningTurnCountByIdx[6] = 0;
  laneReasoningTurnCountByIdx[7] = 0;
  laneReasoningChainTail.clear();
  workModeTypedVoiceInferTail = Promise.resolve();
  workModeTypedVoiceInferDepth = 0;
  workModeVoiceInferPlaybackTail = Promise.resolve();
  workModeVoiceInferTurnSeq = 0;
  resetWorkModeDeferredStage2AbortController();
  resetWorkModeTurnTtsQueue();
  syncReasoningLaneBusySlotsAfterDomChange();
  syncWorkModeReasoningCancelButton();
  setWorkModeAttachmentMeta("");
  hideWorkChecklistSyncPreview();
  workChecklistSyncPlanVersion = 0;
  workChecklistSyncConsumedPlanVersion = 0;
  workChecklistSyncPendingMarkdown = "";
  workChecklistSyncPendingPlanMeta = null;
  syncWorkChecklistSyncPlanButton();

  clearWorkModeLaneRegistry();
  focusedWorkModeLaneId = "";
  focusedWorkModeLaneAt = 0;
  window.__veraLastInferLaneDebug = null;

  hideSidePanel();
}

window.resetBmoSessionAndUi = resetBmoSessionAndUi;
window.resetVeraSessionAndUi = resetVeraSessionAndUi;
window.persistVeraChatState = persistVeraChatState;

/* =========================
   GLOBAL STATE
========================= */

let micStream = null;
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;

let interruptRecorder = null;
let interruptChunks = [];
let interruptRecording = false;

let audioChunks = [];
let hasSpoken = false;
let lastVoiceTime = 0;
/* Speech-start guarded voice-duration cap. Pre-speech silence is governed
   by the existing no-speech / idle timeouts; this fires only AFTER the user
   actually starts speaking. See `armVoiceMaxDurationTimer`. */
let voiceSpeechStartedAt = 0;
let voiceMaxDurationTimerId = null;
let voiceMaxDurationLastFiredAt = 0;

/* =========================
   SAFETY LIMITS (frontend)
   Mirror the values in safety_limits.py. Tuned together if you change one.
========================= */
const VERA_SAFETY_LIMITS = Object.freeze({
  /** Char caps for typed input, by mode. Block before any /text or /infer call. */
  charLimits: Object.freeze({
    normalChat: 4000,
    workReasoning: 12000,
    checklistOrCommand: 2000
  }),
  /** Voice recording cap measured from FIRST detected speech (not from listen-start). */
  voiceMaxDurationAfterSpeechSec: 60,
  /** Standardized user-facing copy. Keep wording aligned with FallbackMessages in safety_limits.py. */
  messages: Object.freeze({
    inputTooLongKeyboard:
      "This message is too long for one request. Please shorten it or upload it as a file.",
    voiceDurationLimit:
      "I stopped recording to keep the request manageable. Use a shorter voice command or type longer details.",
    asrFailure:
      "My listening capability has malfunctioned. Please use the keyboard.",
    ttsFailure:
      "My speaking capability has malfunctioned. Please refer to the text bubble.",
    llmFailure:
      "My reasoning capability is temporarily unavailable. Please come back later.",
    musicFailure: "Music playback is not available right now.",
    weatherFailure: "Weather information is not available right now.",
    searchNewsFailure: "Search/news information is not available right now.",
    financeFailure: "Finance information is not available right now.",
    bmoStateFailure: "BMO's emotion display is temporarily unavailable."
  })
});

/**
 * Char cap for typed input given current UI mode. Centralized so all four
 * submit paths (sendTextMessage non-work, sendVeraWorkModeTypedInferTurn,
 * submitWorkModeReasoningComposer, checklist composer) share the same
 * thresholds and copy.
 *
 * `intent` values:
 *   - "normal_chat"
 *   - "work_command" (typed line in Work Mode that isn't going to reasoning)
 *   - "work_reasoning" (composer submission that opens / continues a panel)
 *   - "checklist" (checklist sync / plan command short-circuits)
 */
function veraCharLimitFor(intent) {
  switch (intent) {
    case "work_reasoning":
      return VERA_SAFETY_LIMITS.charLimits.workReasoning;
    case "checklist":
      return VERA_SAFETY_LIMITS.charLimits.checklistOrCommand;
    case "work_command":
    case "normal_chat":
    default:
      return VERA_SAFETY_LIMITS.charLimits.normalChat;
  }
}

/**
 * If `text` exceeds the limit for `intent`, log + return a block payload.
 * Returns null if the input is fine. Callers should:
 *   - NOT clear the input field (so the user can edit and retry)
 *   - addBubble(blocked.message, "vera") so the user sees the same copy
 *     that backend would otherwise return as a 413
 *   - return early before any /text or /infer call
 */
function veraCheckTypedInputLength(text, intent, feature) {
  const t = String(text || "");
  const limit = veraCharLimitFor(intent);
  if (t.length <= limit) return null;
  const out = {
    ok: false,
    reason: "input_too_long",
    char_count: t.length,
    char_limit: limit,
    estimated_tokens: Math.ceil(t.length / 4),
    message: VERA_SAFETY_LIMITS.messages.inputTooLongKeyboard,
    intent: String(intent || "normal_chat"),
    feature: String(feature || "keyboard")
  };
  try {
    console.warn("[safety_guard]", {
      reason: out.reason,
      mode: intent === "work_reasoning" || intent === "work_command"
        ? "work_mode"
        : "non_work",
      feature: out.feature,
      char_count: out.char_count,
      estimated_tokens: out.estimated_tokens,
      char_limit: out.char_limit
    });
  } catch (_) {}
  return out;
}

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

/** Inline bubble used for any safety block (length or capability failure). */
function veraShowSafetyFailureBubble(message) {
  try {
    addBubble(String(message || ""), "vera", { path: "safety-fallback" });
  } catch (e) {
    try { console.warn("[safety_guard] bubble failed", e); } catch (_) {}
  }
}

/** Status-line helper used by safety guards (kept short to fit the strip). */
function veraSetSafetyStatus(text) {
  try {
    setStatus(String(text || "").slice(0, 80), "idle");
  } catch (_) {}
}

/**
 * Inspect a failed fetch / response and surface the right user bubble.
 *  - 413 => input-too-long bubble (server enforced the same cap)
 *  - 5xx / network / parse errors => LLM-failure bubble (the model path
 *    is the user-facing surface most of these failures sit on).
 * Returns the bubble feature key actually shown, or null if nothing
 * was shown (AbortError).
 */
async function veraSurfaceLlmFetchFailure({
  feature = "llm",
  response = null,
  error = null,
  extra = null
} = {}) {
  if (error && error.name === "AbortError") return null;
  const status = response?.status ?? 0;
  if (status === 413) {
    let serverMsg = "";
    try {
      const body = await response.clone().json();
      serverMsg = String(body?.detail || body?.message || "").trim();
    } catch (_) {}
    const msg = serverMsg || VERA_SAFETY_LIMITS.messages.inputTooLongKeyboard;
    logVeraCapabilityFailure(feature, "input_too_long_server", {
      status,
      server_message: serverMsg.slice(0, 200),
      ...(extra || {})
    });
    veraShowCapabilityFailureBubble("safety_413", msg);
    return "safety_413";
  }
  logVeraCapabilityFailure(feature, "llm_fetch_failed", {
    status: status || null,
    error_name: error?.name || null,
    error_message: error ? String(error.message || error).slice(0, 200) : null,
    ...(extra || {})
  });
  veraShowCapabilityFailureBubble(
    "llm_failure",
    VERA_SAFETY_LIMITS.messages.llmFailure
  );
  return "llm_failure";
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

/**
 * Show a capability-failure bubble at most once per ~6s per (feature) so a
 * burst of failures (e.g. multiple TTS chunks erroring back-to-back) does
 * not spam the conversation with duplicate copy.
 */
const _veraCapabilityFailureLastShownAt = new Map();
function veraShowCapabilityFailureBubble(feature, message, opts = {}) {
  const now = Date.now();
  const key = String(feature || "generic");
  const last = _veraCapabilityFailureLastShownAt.get(key) || 0;
  const minMs = Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : 6000;
  if (now - last < minMs) return false;
  _veraCapabilityFailureLastShownAt.set(key, now);
  veraShowSafetyFailureBubble(message);
  return true;
}

/* =========================
   PENDING STATUS BUBBLES (slow external/tool requests)
   ========================= */

/**
 * Strong current/public-event clues. When one of these co-occurs with a
 * vague "do you know if/whether ..." opener, we treat the request as a
 * news/search ask. Without one, we leave it alone and let the backend
 * pending_tool meta arm the bubble later if it actually routes to news.
 */
const NEWS_EVENT_CLUE_RE = /\b(?:today|yesterday|last\s+(?:week|night|month|year)|earlier\s+today|tonight|this\s+(?:week|morning|afternoon|evening|month)|recent|recently|latest|current|currently|breaking|news|headline|headlines|article|articles?|report|reports?|sources?|earnings|market|election|stock|trial|lawsuit|hearing|verdict|investigation|press\s+conference|press\s+release|statement|interview|tweet|post|filing|deal|merger|acquisition|visited|sued|released|announced|won|lost|died|arrested|fired|hired|launched|signed|acquired|sold|bought|resigned|retired|elected|indicted|settled|merged|killed|attacked|crashed|hacked|leaked|revealed|appointed|nominated)\b/;

/**
 * Known public figures, companies, countries, institutions, and event series.
 * A "do you know if" or "did <X>" opener paired with any of these is a
 * strong news signal even without an explicit time/news noun.
 */
const NEWS_NAMED_ENTITY_RE = /\b(?:trump|biden|harris|obama|putin|zelensky|xi(?:\s+jinping)?|netanyahu|musk|elon|bezos|altman|sam\s+altman|pichai|nadella|zuckerberg|nvidia|apple|tesla|spacex|openai|anthropic|microsoft|google|amazon|meta|facebook|twitter|alphabet|netflix|disney|samsung|sony|intel|amd|ibm|oracle|fda|sec|fbi|cia|nasa|congress|senate|fed|federal\s+reserve|white\s+house|pentagon|supreme\s+court|israel|gaza|ukraine|russia|china|taiwan|iran|north\s+korea|syria|nato|the\s+un|the\s+eu|wnba|nba|nfl|mlb|nhl|fifa|olympics|world\s+cup|super\s+bowl)\b/;

/**
 * Heuristic for "this typed/voice utterance is going to trigger Serper /
 * news.latest / external search". Runs purely client-side BEFORE the network
 * round-trip so the pending bubble can appear immediately.
 *
 * Intentionally conservative: false negatives just mean no immediate
 * placeholder (the backend pending_tool meta can still arm the bubble at
 * TTFB). False positives are worse — they'd flash "Searching news…" on
 * personal/knowledge questions like "what do you know about me" or "do you
 * know what tennis is" — so generic "do you know" without a strong
 * current/public-event clue is NOT a trigger here.
 */
function looksLikeNewsSearchRequest(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return false;

  // Negative filter first: never show "Searching news…" for known local
  // intents. The router would (correctly) handle these without any Serper
  // round-trip, so showing a news placeholder would be misleading.
  if (
    /\b(?:music|spotify|playback|playlist|volume|mute|unmute|skip|pause|resume|play\s+(?:the\s+)?next|skip\s+next|skip\s+previous|previous\s+(?:song|track))\b/.test(
      raw
    )
  ) return false;
  if (/\b(?:checklist|to[- ]?do|tasks?\s+list|sync|sync\s+the\s+checklist)\b/.test(raw)) return false;
  if (/\b(?:timer|stopwatch|countdown|set\s+(?:a\s+)?(?:\d+|one|two|three|four|five|ten|fifteen|twenty|thirty)[- ]?minute)\b/.test(raw)) return false;
  if (/\b(?:hi|hey|hello|yo|sup|how\s+are\s+you|what'?s\s+up|good\s+(?:morning|afternoon|evening|night))\b\s*[.?!]?\s*$/.test(raw)) return false;
  if (/\b(?:thank\s+you|thanks|cool|nice|got\s+it|okay|ok|alright|sure)\b\s*[.?!]?\s*$/.test(raw)) return false;
  if (/\b(?:open|show|bring\s+up|switch\s+to|go\s+to)\s+(?:the\s+|my\s+)?(?:work\s+mode|reasoning|tab|panel|page|space|lane)\b/.test(raw)) return false;

  // Personal / general-knowledge "know" questions are NEVER news triggers.
  // Catches things like:
  //   - what do you know about me
  //   - do you know my name
  //   - do you know what tennis is
  //   - do you know how to cook pasta
  //   - do you know why people get tired
  //   - do you know what I mean
  // The bare "do you know" opener used to fall through to a generic positive
  // rule; that rule is now removed and replaced by a tight "do you know
  // if/whether ..." gate that requires a strong event clue or named entity.
  if (/\bwhat\s+do\s+you\s+know\s+about\b/.test(raw)) return false;
  if (/\bdo\s+you\s+know\s+my\b/.test(raw)) return false;
  if (/\bdo\s+you\s+know\s+(?:what|who|where|when|why|how)\s+(?:to|i|we|you|he|she|they|it|that|this|tennis|cooking|pasta|programming|coding|chess|history|math|science|people)\b/.test(raw)) return false;
  if (/\bdo\s+you\s+know\s+(?:what|who|where|when|why|how)\s+\w+\s+(?:is|are|was|were|do|does|did|can|should|means|works|tastes|feels|looks|sounds)\b/.test(raw)) return false;

  // Strong single-word/phrase triggers (user-specified vocabulary).
  if (/\bnews\b/.test(raw)) return true;
  if (/\bheadlines?\b/.test(raw)) return true;
  if (/\blatest\b/.test(raw)) return true;
  if (/\bbreaking\b/.test(raw)) return true;
  if (/\barticles?\b/.test(raw)) return true;
  if (/\bsources?\??\s*$/.test(raw)) return true;
  if (/\b(?:search|google|look\s*up|search\s*for|look\s*it\s*up)\b/.test(raw)) return true;
  if (/\b(?:current|currently)\b/.test(raw)) return true;
  if (/\b(?:today|tonight|this\s+(?:week|morning|afternoon|evening))\b/.test(raw)) return true;
  if (/\b(?:recently|recent)\b/.test(raw)) return true;

  // Phrase triggers.
  // Match "what happened", "what happens", "what's happening", "what is happening".
  if (/\bwhat(?:'?s)?(?:\s+is)?\s+happen(?:ed|ing|s)\b/.test(raw)) return true;
  // Match "what's going on", "what is going on", "what's new", "what's the latest".
  if (/\bwhat(?:'?s|\s+is)\s+(?:going\s+on|new|the\s+latest)\b/.test(raw)) return true;
  // Tight "do you know if/whether ..." rule: must co-occur with a strong
  // current/public-event clue OR a named public entity in the tail. The
  // bare opener is intentionally NOT a trigger — the personal/knowledge
  // negative filter above covers the false-positive cases.
  const dykMatch = raw.match(/\bdo\s+you\s+know\s+(?:if|whether)\s+(.+)$/);
  if (dykMatch) {
    const tail = dykMatch[1];
    if (NEWS_EVENT_CLUE_RE.test(tail) || NEWS_NAMED_ENTITY_RE.test(tail)) return true;
  }
  // "did <named public entity> ..." — strong news signal on its own.
  // Pronoun forms ("did he go", "did that happen") are intentionally NOT
  // matched: those are usually follow-ups the backend deictic resolver
  // handles, or unrelated knowledge questions.
  if (/\bdid\s+/.test(raw) && NEWS_NAMED_ENTITY_RE.test(raw)) return true;
  if (/\b(?:any|got\s+any)\s+(?:news|updates?)\b/.test(raw)) return true;
  if (/\btell\s+me\s+(?:about\s+)?(?:the\s+)?(?:news|latest|recent)\b/.test(raw)) return true;
  if (/\bshow\s+(?:me\s+)?(?:the\s+)?(?:sources?|articles?|news|headlines?|link)\b/.test(raw)) return true;
  if (/\bdo\s+you\s+have\s+(?:any\s+)?(?:sources?|links?|articles?)\b/.test(raw)) return true;
  if (/\bwhere\s+did\s+you\s+(?:get|find|read)\s+(?:that|this)\b/.test(raw)) return true;

  return false;
}

let pendingNewsStatusBubble = null;
let pendingNewsStatusTimerId = null;
let pendingNewsStatusToken = 0;
// This is a stuck-request backstop, not the normal failure path. Real network
// and server failures go through fetch/catch handlers. Keep it long enough
// that a slow-but-successful Serper + LLM turn does not briefly show a false
// red failure bubble before the final answer arrives.
const PENDING_NEWS_STATUS_TIMEOUT_MS = 90000;
const PENDING_NEWS_STATUS_TEXT = "Searching news…";

function _clearPendingNewsStatusTimer() {
  if (pendingNewsStatusTimerId != null) {
    try { clearTimeout(pendingNewsStatusTimerId); } catch (_) {}
    pendingNewsStatusTimerId = null;
  }
}

/**
 * Show a "Searching news…" bubble if `userText` looks like a news/search ask.
 * The bubble is text-only (never enqueued to TTS) and not persisted to chat
 * state (it's transient by design). A long timeout is only a stuck-request
 * backstop; normal failures are driven by fetch/catch handlers. Returns the
 * bubble element or null when nothing was shown.
 */
function armPendingNewsStatusBubble(userText, { force = false } = {}) {
  if (!force && !looksLikeNewsSearchRequest(userText)) return null;
  const utteranceKey = String(userText || "").trim().toLowerCase();
  // Idempotent: NDJSON `meta.transcript` can fire more than once with the
  // same text — keep the existing bubble (and timer) instead of flashing
  // a new one in its place.
  if (
    pendingNewsStatusBubble?.isConnected &&
    pendingNewsStatusBubble.dataset?.pendingForText === utteranceKey &&
    pendingNewsStatusBubble.dataset?.pendingStatus === "news"
  ) {
    return pendingNewsStatusBubble;
  }
  // Drop any stale pending bubble before installing a new one (e.g. a prior
  // search that never reached resolution before the user sent again).
  cancelPendingNewsStatusBubble("superseded");
  const token = ++pendingNewsStatusToken;
  try {
    pendingNewsStatusBubble = addBubble(PENDING_NEWS_STATUS_TEXT, "vera", {
      path: "pending-status-news",
      bubbleClass: "vera-pending-status vera-pending-status-news"
    });
    if (pendingNewsStatusBubble?.dataset) {
      pendingNewsStatusBubble.dataset.pendingStatus = "news";
      pendingNewsStatusBubble.dataset.pendingForText = utteranceKey;
      pendingNewsStatusBubble.dataset.pendingToken = String(token);
      pendingNewsStatusBubble.setAttribute("aria-live", "polite");
    }
  } catch (e) {
    try { console.warn("[pending_news_bubble] create failed", e); } catch (_) {}
    pendingNewsStatusBubble = null;
    return null;
  }
  try {
    console.info("[pending_status_bubble]", {
      kind: "news",
      action: "armed",
      user_text: String(userText || "").slice(0, 120)
    });
  } catch (_) {}
  _clearPendingNewsStatusTimer();
  pendingNewsStatusTimerId = setTimeout(() => {
    if (token !== pendingNewsStatusToken) return;
    pendingNewsStatusTimerId = null;
    failPendingNewsStatusBubble("timeout");
  }, PENDING_NEWS_STATUS_TIMEOUT_MS);
  return pendingNewsStatusBubble;
}

/**
 * A real assistant reply (or abort) has arrived — drop the placeholder
 * bubble without leaving any trace. Safe to call when no pending bubble
 * exists. `reason` is for log scraping.
 */
function cancelPendingNewsStatusBubble(reason = "resolved") {
  _clearPendingNewsStatusTimer();
  pendingNewsStatusToken += 1;
  const bubble = pendingNewsStatusBubble;
  pendingNewsStatusBubble = null;
  if (!bubble) return false;
  try {
    const row = bubble.closest(".message-row");
    if (row?.parentNode) row.parentNode.removeChild(row);
    else if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
  } catch (_) {}
  try {
    console.info("[pending_status_bubble]", { kind: "news", action: "cancelled", reason });
  } catch (_) {}
  try { persistVeraChatState(); } catch (_) {}
  return true;
}

/**
 * Network / server / timeout failure: rewrite the tracked bubble with the
 * standardized "Search/news information is not available right now." message.
 *
 * Important: keep `pendingNewsStatusBubble` pointing at this failed bubble.
 * If the timeout fired too early but the request later succeeds, success
 * handlers call cancelPendingNewsStatusBubble(...) before rendering the real
 * reply. That removes the red bubble and enforces:
 *
 *   pending -> success
 *   pending -> failure
 *
 * never:
 *
 *   pending -> failure + success
 */
function failPendingNewsStatusBubble(reason = "failure") {
  _clearPendingNewsStatusTimer();
  const bubble = pendingNewsStatusBubble;
  if (!bubble?.isConnected) return false;
  try {
    bubble.textContent =
      VERA_SAFETY_LIMITS?.messages?.searchNewsFailure ||
      "Search/news information is not available right now.";
    bubble.classList.remove("vera-pending-status", "vera-pending-status-news");
    bubble.classList.add("vera-pending-status-failed", "vera-safety-failure");
    if (bubble.dataset) bubble.dataset.pendingStatus = "news_failed";
  } catch (_) {}
  try {
    console.warn("[pending_status_bubble]", { kind: "news", action: "failed", reason });
  } catch (_) {}
  try { persistVeraChatState(); } catch (_) {}
  return true;
}

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

let listening = false;
let processing = false;
let rafId = null;
/** `startListening` no-speech watchdog; must be cleared when switching to PTT or the new recorder gets stopped. */
let speechWaitTimeoutId = null;
let interruptSpeechFrames = 0;
let interruptSpeechStart = 0;
/** Ms of speechLike time accumulated from RAF deltas (gaps do not add). */
let interruptSpeechAccumMs = 0;
let lastInterruptDetectTime = 0;
let interruptLastSpeechLikeTime = 0;
/** Snapshot from detectInterrupt when interruptSpeech() fires (for server interrupt_debug). */
let lastInterruptProbe = null;
/** Last frame where speechLike was true (same as trigger frame when interrupt fires). */
let lastInterruptSpeechLikeSnapshot = null;
/** Throttled VAD samples for mobile interrupt debug panel. */
let lastMobileVadSampleLogAt = 0;
const MOBILE_VAD_SAMPLE_INTERVAL_MS = 220;
const INTERRUPT_VAD_LOG_MAX = 200;
let interruptVadLogLines = [];
let pttRecording = false;
let inputMuted = false;
let suppressNextUtterance = false;

/** Web Speech API (main + interrupt + post-interrupt); mutually exclusive instances. */
let mainBrowserRecognition = null;
let mainBrowserSilenceTimer = null;
let mainBrowserFinalTranscript = "";
/** @type {HTMLElement | null} */
let mainBrowserLiveBubble = null;
/** Translucent live preview during TTS interrupt detection (browser ASR); promoted to main live bubble on interrupt. */
/** @type {HTMLElement | null} */
let interruptDetectionBubbleEl = null;

let interruptDetectRecognition = null;
let interruptBrowserDetectActive = false;
let postInterruptRecognition = null;
let interruptPartialAccumMs = 0;
let interruptPartialLastChangeAt = 0;
let interruptPartialLastText = "";
let interruptPartialRafTime = 0;
/** "main" continuous/PTT vs "interrupt" post-barge-in utterance — controls silence-timer finalize. */
let mainBrowserFinalizeKind = "main";
let mainBrowserLastInterim = "";
/** After >2 words during TTS, barge-in latched: same SR stream continues until 1.3s silence → LLM (no second SR). */
let interruptBargeInLatched = false;
/** If interrupt-detect SR never emits onresult while TTS plays, abort so heuristic fallback can run. */
let interruptDetectNoResultWatchdogTimer = null;

/** Debounce main SR onend → startListening recovery (Chrome sometimes ends the session with no error). */
let browserAsrMainEndRecoveryTimer = null;
/** Debounce tab focus/visibility → resume main SR when Chrome ended the session in background. */
let browserAsrVisibilityResumeTimer = null;

/** Opt-in via localStorage VERA_DEBUG_BROWSER_ASR_STUCK=1 — heartbeats + onend/onerror/silence-timer traces. */
let browserAsrStuckWatchdogId = null;
let browserAsrSessionStartedAt = 0;
let browserAsrLastResultAt = 0;
let browserAsrHadAnyResult = false;
let browserAsrLastResultRole = "";

let audioStartedAt = 0;
let voiceUxTurn = null;
let textUxTurn = null;
// let interruptStart = 0;
let listeningMode = "continuous"; 
let waveState = "idle";   
let waveEnergy = 0;     

let requestInFlight = false; // 🔑 NEW

/** Start of a voice UX turn: t0 for perceived latency (end of user speech in the browser). */
function beginVoiceUxTurn() {
  voiceUxTurn = {
    speechEndAt: performance.now(),
    firstAudioLogged: false,
    mainReplyLogged: false
  };
}

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

/** Set localStorage VERA_DEBUG_TRANSCRIPTS to "0" to silence [VOICE][TRANSCRIPT] logs. */
function voiceTranscriptDebugEnabled() {
  try {
    return localStorage.getItem("VERA_DEBUG_TRANSCRIPTS") !== "0";
  } catch {
    return true;
  }
}

/** Set localStorage VERA_DEBUG_PARTIAL_ASR_DONE to "0" to silence [VOICE][PARTIAL-ASR] done / segment logs. */
function voicePartialAsrDoneLogEnabled() {
  try {
    return localStorage.getItem("VERA_DEBUG_PARTIAL_ASR_DONE") !== "0";
  } catch {
    return true;
  }
}

/**
 * Verbose browser-ASR diagnostics (heartbeats, onerror, silence-timer skips). Enable with:
 *   localStorage.setItem("VERA_DEBUG_BROWSER_ASR_STUCK", "1")
 * Reload the page after setting. (Recovery from dead SR and zero-audio TTS do not require this.)
 */
function browserAsrStuckDebugEnabled() {
  try {
    return localStorage.getItem("VERA_DEBUG_BROWSER_ASR_STUCK") === "1";
  } catch {
    return false;
  }
}

function stopBrowserAsrStuckWatchdog() {
  if (browserAsrStuckWatchdogId != null) {
    clearInterval(browserAsrStuckWatchdogId);
    browserAsrStuckWatchdogId = null;
  }
}

function snapshotBrowserAsrDebugState() {
  const now = performance.now();
  const sinceSessionStart = browserAsrSessionStartedAt
    ? Math.round(now - browserAsrSessionStartedAt)
    : null;
  const sinceLastResult =
    browserAsrHadAnyResult && browserAsrLastResultAt
      ? Math.round(now - browserAsrLastResultAt)
      : null;
  return {
    listening,
    processing,
    requestInFlight,
    waveState,
    interruptBrowserDetectActive,
    interruptBargeInLatched,
    mainBrowserFinalizeKind,
    hasMainRecognizer: !!mainBrowserRecognition,
    hasInterruptRecognizer: !!interruptDetectRecognition,
    hasPostInterruptRecognizer: !!postInterruptRecognition,
    silenceTimerActive: mainBrowserSilenceTimer != null,
    speechWaitPending: speechWaitTimeoutId != null,
    sinceSessionStartMs: sinceSessionStart,
    sinceLastResultMs: sinceLastResult,
    hadAnyResult: browserAsrHadAnyResult,
    lastResultRole: browserAsrLastResultRole || null,
    transcriptPreview: ((mainBrowserFinalTranscript + mainBrowserLastInterim).trim()).slice(0, 120),
  };
}

function logBrowserAsrStuckEvent(message, extra = {}) {
  if (!browserAsrStuckDebugEnabled()) return;
  console.log("[VOICE][BROWSER-ASR-STUCK]", message, { ...extra, ...snapshotBrowserAsrDebugState() });
}

function markBrowserAsrResult(role) {
  browserAsrLastResultAt = performance.now();
  browserAsrHadAnyResult = true;
  browserAsrLastResultRole = role;
}

/**
 * Call after a SpeechRecognition `.start()` succeeds. Heartbeats every 5s; warns if no `onresult` for 8s+ after
 * at least one result, or 12s+ with zero results (Chrome sometimes stops emitting).
 */
function beginBrowserAsrStuckSession(activeRole) {
  if (!browserAsrStuckDebugEnabled()) return;
  browserAsrSessionStartedAt = performance.now();
  browserAsrLastResultAt = 0;
  browserAsrHadAnyResult = false;
  browserAsrLastResultRole = activeRole;
  stopBrowserAsrStuckWatchdog();
  browserAsrStuckWatchdogId = window.setInterval(() => {
    if (!browserAsrStuckDebugEnabled()) {
      stopBrowserAsrStuckWatchdog();
      return;
    }
    const snap = snapshotBrowserAsrDebugState();
    const anyRec =
      snap.hasMainRecognizer || snap.hasInterruptRecognizer || snap.hasPostInterruptRecognizer;
    if (!anyRec) {
      stopBrowserAsrStuckWatchdog();
      return;
    }
    console.log("[VOICE][BROWSER-ASR-STUCK] heartbeat", snap);
    if (snap.hadAnyResult && snap.sinceLastResultMs != null && snap.sinceLastResultMs > 8000) {
      console.warn(
        "[VOICE][BROWSER-ASR-STUCK] no onresult for 8s+ while recognizer still referenced",
        snap
      );
    }
    if (!snap.hadAnyResult && snap.sinceSessionStartMs != null && snap.sinceSessionStartMs > 12000) {
      console.warn("[VOICE][BROWSER-ASR-STUCK] no onresult since session start (12s+)", snap);
    }
  }, 5000);
  logBrowserAsrStuckEvent("session_started", { activeRole });
}

/** One browser-ASR utterance finished (silence gate) and will go to Thinking/infer. */
function logPartialAsrUtteranceDone(text, meta = {}) {
  if (!voicePartialAsrDoneLogEnabled()) return;
  console.log("[VOICE][PARTIAL-ASR] done", { text: text ?? "", ...meta });
}

/** Chrome emitted a final segment for this result (may be multiple per spoken phrase). */
function logPartialAsrSegmentFinal(segmentText, meta = {}) {
  if (!voicePartialAsrDoneLogEnabled()) return;
  console.log("[VOICE][PARTIAL-ASR] segment-final", {
    segment: segmentText ?? "",
    ...meta
  });
}

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

function beginTextUxTurn() {
  textUxTurn = {
    sendAt: performance.now(),
    firstAudioLogged: false,
    mainReplyLogged: false
  };
}

function logTextFirstAudio(kind) {
  if (!textUxTurn || textUxTurn.firstAudioLogged) return;
  const elapsedMs = performance.now() - textUxTurn.sendAt;
  textUxTurn.firstAudioLogged = true;
  console.log(`[UX][TEXT] Send→FirstAudio=${(elapsedMs / 1000).toFixed(3)}s (${kind})`);
}

function logTextMainReplyAudio() {
  if (!textUxTurn || textUxTurn.mainReplyLogged) return;
  const elapsedMs = performance.now() - textUxTurn.sendAt;
  textUxTurn.mainReplyLogged = true;
  console.log(`[UX][TEXT] Send→MainReplyAudio=${(elapsedMs / 1000).toFixed(3)}s`);
}

/** Server-side breakdown + optional client TTFB split — for attribution, not end-user perceived time (see SpeechEnd→MainReplyAudio). */
function logInferLatency(data, label, clientTtfbMs) {
  const L = data?.latency;
  if (!L || typeof L !== "object") return;
  const parts = [];
  if (L.short_circuit) parts.push(`short_circuit=${L.short_circuit}`);
  if (L.pre_asr_s != null) parts.push(`PreASR=${L.pre_asr_s}s`);
  if (L.asr_lock_s != null) parts.push(`ASR_lock=${L.asr_lock_s}s`);
  if (L.asr_transcribe_s != null) parts.push(`ASR_transcribe=${L.asr_transcribe_s}s`);
  if (L.bridge_s != null) parts.push(`Bridge=${L.bridge_s}s`);
  if (L.llm_s != null) parts.push(`LLM=${L.llm_s}s`);
  if (L.llm_first_token_s != null) parts.push(`LLM_first_token=${L.llm_first_token_s}s`);
  if (L.llm_first_sentence_ready_s != null)
    parts.push(`LLM_first_sentence_ready=${L.llm_first_sentence_ready_s}s`);
  if (L.post_llm_s != null) parts.push(`PostLLM=${L.post_llm_s}s`);
  if (L.tts_s != null) parts.push(`TTS=${L.tts_s}s`);
  if (L.tts_first_chunk_s != null) parts.push(`TTS_first_chunk=${L.tts_first_chunk_s}s`);
  if (L.first_tts_audio_ready_total_s != null)
    parts.push(`first_TTS_file_ready_total=${L.first_tts_audio_ready_total_s}s`);
  if (L.first_tts_audio_ready_after_pre_asr_s != null)
    parts.push(`first_TTS_file_ready_after_PreASR=${L.first_tts_audio_ready_after_pre_asr_s}s`);
  if (L.first_tts_audio_ready_after_asr_end_s != null)
    parts.push(`first_TTS_file_ready_after_ASR_end=${L.first_tts_audio_ready_after_asr_end_s}s`);
  if (L.total_s != null) parts.push(`TOTAL=${L.total_s}s`);
  if (L.sum_segments_s != null) parts.push(`Σ=${L.sum_segments_s}s`);
  if (L.drift_s != null) parts.push(`drift=${L.drift_s}s`);
  if (L.llm_internal_reported_s != null) parts.push(`llm_internal=${L.llm_internal_reported_s}s`);
  const line = parts.length ? parts.join(" | ") : JSON.stringify(L);
  console.log(`[UX][LATENCY][${label}] ${line}`, L);
  if (L.total_s != null && clientTtfbMs != null && Number.isFinite(clientTtfbMs)) {
    console.log(
      `[UX][LATENCY][split][${label}] backend total_s=${L.total_s} (server clock: infer start→end of full NDJSON stream on Python) | ` +
        `client_ttfb_ms=${Math.round(clientTtfbMs)} (browser: fetch() start→first response headers; includes body upload + Worker/proxy + network + server until it can stream)`
    );
    console.log(
      `[UX][LATENCY][hint] Backend work = ASR / LLM / TTS columns above (Python). ` +
        `Upload/proxy/internet vs backend: compare client_ttfb_ms to how “heavy” those segments are; TOTAL is not the same moment as TTFB (TOTAL waits for the whole stream to finish on the server).`
    );
  }
}

/* =========================
   CONFIG
========================= */

const IS_MOBILE = window.matchMedia("(max-width: 768px)").matches;

function hasMobileVadLogQuery() {
  try {
    return new URLSearchParams(window.location.search).get("vadlog") === "1";
  } catch {
    return false;
  }
}

/** Mobile viewport + `?vadlog=1` — inject VAD/interrupt debug UI and capture log lines. */
const MOBILE_VAD_DEBUG = IS_MOBILE && hasMobileVadLogQuery();

const VOLUME_THRESHOLD = 0.0078; // slightly lower so quieter speech starts more reliably
const SILENCE_MS = 950;     // silence before ending speech
const TRAILING_MS = 300;   // guaranteed tail
/**
 * Browser SpeechRecognition: cap before first partial (`hasSpoken` false). 0 = off (desktop Chrome can be slow).
 */
const MAX_WAIT_FOR_BROWSER_ASR_INITIAL_MS = 0;
/**
 * MediaRecorder + VAD fallback (non–secure pages, iOS Safari without Web Speech, etc.): if VAD never marks
 * speech, stop the recorder so we do not spin "Listening…" forever. Does not apply to browser ASR.
 */
const MAX_WAIT_FOR_MEDIA_RECORDER_INITIAL_MS = 60000;
const MIN_AUDIO_BYTES = 1500;
const INTERRUPT_MIN_FRAMES = 1;

/**
 * End-of-utterance (continuous listen + interrupt capture): a frame only resets the
 * silence timer if RMS and ZCR both look like voiced speech. Room tone / fan / AC often
 * stays above VOLUME_THRESHOLD but has ZCR outside this band, so the clip can still end
 * after SILENCE_MS once the user stops talking.
 */
const LISTEN_END_ZCR_MIN = 0.022;
const LISTEN_END_ZCR_MAX = 0.19;

/* Interrupt while TTS plays: RMS / ZCR / crest heuristics + sustain/gap timing (no WASM VAD). */
/* Voiced-speech band for ZCR (zero-crossings / sample). Outside this → rustle/AC/fan/clicks. */
const INTERRUPT_ZCR_MIN = 0.028;
const INTERRUPT_ZCR_MAX = 0.165;
const MAX_SPEECH_RMS = 0.078;
const INTERRUPT_RMS = 0.0105;
/**
 * Min accumulated ms where speechLike is true (wall-clock gaps and quiet frames do not count).
 * Interrupt fires only on a speechLike frame after this threshold.
 * Phone viewports use a shorter window for faster interrupt.
 */
const INTERRUPT_SUSTAIN_MS_DESKTOP = 350;
const INTERRUPT_SUSTAIN_MS_PHONE = 100;

function getInterruptSustainMs() {
  return isNarrowViewport()
    ? INTERRUPT_SUSTAIN_MS_PHONE
    : INTERRUPT_SUSTAIN_MS_DESKTOP;
}

/** Max ms without a speech-like frame before resetting the sustain counter. */
const INTERRUPT_GAP_RESET_MS = 110;
/** peak/RMS; impulsive handling noise is often very spiky vs sustained vowels. */
const INTERRUPT_MAX_CREST = 38;
const API_URL = "https://vera-api.vera-api-ned.workers.dev";

/** Request NDJSON streaming TTS from /infer and /text so the first /audio URL arrives as soon as it is synthesized. */
const DEFAULT_STREAM_TTS = true;

/** Browser Web Speech API: live partials, then 1.3s stable transcript → /infer without server ASR. */
let browserAsrMainSilenceMs = 1300;
/** Main browser-ASR only: minimum visible chars before showing partial bubble. `Infinity` = hide until utterance finalizes. */
let mainAsrPartialMinChars = 20;
/** Min accumulated ms of changing partial transcript to count as interrupt (vs VAD on audio). */
let browserAsrInterruptSustainMs = 350;
/** Reset interrupt sustain if no transcript change for this long (ms). */
let browserAsrInterruptGapMs = 120;
/** Fire interrupt when browser partial ASR reaches this many words, or when partial text is stable long enough. */
let interruptBrowserMinWords = 2;

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

/** Retries for main SR `network` errors (common on mobile data / brief offline). */
let browserAsrMainNetworkRetries = 0;
const BROWSER_ASR_MAIN_NETWORK_RETRY_MAX = 2;

const VERA_SETTING_ASR_SILENCE_MS_KEY = "vera_setting_asr_silence_ms_v1";
const VERA_SETTING_ASR_MODE_KEY = "vera_setting_asr_mode_v1";
const VERA_SETTING_WORKMODE_MUTE_KEY = "vera_setting_workmode_mute_v1";
const VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY = "vera_setting_main_asr_partial_min_chars_v1";
const VERA_SETTING_TEXT_GUIDE_ROTATOR_KEY = "vera_setting_text_guide_rotator_v1";
const VERA_SETTING_PLANNING_DEADLINE_TIMER_KEY = "vera_setting_planning_deadline_timer_v1";

function logVeraSettings(event, data = {}) {
  try {
    console.log("[SETTINGS]", event, data);
  } catch (_) {}
}

/**
 * Set true after Web Speech returns not-allowed / service-not-allowed so we stop retrying
 * (retries re-trigger permission prompts, especially on file://).
 */
let browserAsrPermanentlyDisabled = false;

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
  if (getVeraAsrMode() === "single") return false;
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
  try {
    localStorage.setItem(VERA_SETTING_ASR_SILENCE_MS_KEY, String(next));
  } catch (_) {}
  logVeraSettings("save_silence_ms", { value: next });
}

function getVeraAsrMode() {
  try {
    const v = String(localStorage.getItem(VERA_SETTING_ASR_MODE_KEY) || "").trim();
    if (v === "single" || v === "streaming") return v;
  } catch (_) {}
  return "streaming";
}

function setVeraAsrMode(mode) {
  const next = mode === "single" ? "single" : "streaming";
  try {
    localStorage.setItem(VERA_SETTING_ASR_MODE_KEY, next);
  } catch (_) {}
  logVeraSettings("save_asr_mode", { value: next });
}

const MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS = [10, 15, 20, 25, Infinity];

const MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT = 20;

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
  try {
    localStorage.setItem(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY, store);
  } catch (_) {}
  logVeraSettings("save_main_asr_partial_min_chars", { value: next === Infinity ? "inf" : next });
}

function isWorkModeMuteEnabled() {
  try {
    return localStorage.getItem(VERA_SETTING_WORKMODE_MUTE_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function setWorkModeMuteEnabled(on) {
  try {
    localStorage.setItem(VERA_SETTING_WORKMODE_MUTE_KEY, on ? "1" : "0");
  } catch (_) {}
  logVeraSettings("save_workmode_mute", { value: on ? 1 : 0 });
  applyVeraWorkModeMuteSetting();
}

function isTextGuideRotatorEnabled() {
  try {
    const raw = localStorage.getItem(VERA_SETTING_TEXT_GUIDE_ROTATOR_KEY);
    if (raw == null) return true;
    return raw === "1";
  } catch (_) {
    return true;
  }
}

function applyTextGuideRotatorSetting() {
  const on = isTextGuideRotatorEnabled();
  if (typeof window.setAskRotatorEnabled === "function") {
    window.setAskRotatorEnabled(on);
  } else {
    ["vera", "bmo"].forEach((prefix) => {
      const el = document.getElementById(`${prefix}-ask-rotator`);
      if (!el) return;
      if (on) el.classList.add("visible");
      else el.classList.remove("visible");
    });
  }
  logVeraSettings("apply_text_guide_rotator", { enabled: on ? 1 : 0 });
}

function setTextGuideRotatorEnabled(on) {
  try {
    localStorage.setItem(VERA_SETTING_TEXT_GUIDE_ROTATOR_KEY, on ? "1" : "0");
  } catch (_) {}
  logVeraSettings("save_text_guide_rotator", { value: on ? 1 : 0 });
  applyTextGuideRotatorSetting();
}

function isPlanningDeadlineTimerEnabled() {
  try {
    const raw = localStorage.getItem(VERA_SETTING_PLANNING_DEADLINE_TIMER_KEY);
    if (raw == null) return true;
    return raw === "1";
  } catch (_) {
    return true;
  }
}

function setPlanningDeadlineTimerEnabled(on) {
  try {
    localStorage.setItem(VERA_SETTING_PLANNING_DEADLINE_TIMER_KEY, on ? "1" : "0");
  } catch (_) {}
  logVeraSettings("save_planning_deadline_timer", { value: on ? 1 : 0 });
}

/** Reasoning always uses the active/frozen panel (legacy auto-route across panels removed). */
function isWorkModeReasoningAutoRouteEnabled() {
  return false;
}

function applyVeraWorkModeMuteSetting() {
  const veraAudio = document.getElementById("vera-audio");
  const inWork = Boolean(document.getElementById("vera-app")?.classList.contains("work-mode"));
  const mute = isWorkModeMuteEnabled() && inWork;
  if (veraAudio instanceof HTMLAudioElement) {
    veraAudio.muted = mute;
  }
  const vg = ttsByMode?.vera?.gain;
  if (vg && audioCtx && typeof vg.gain?.setValueAtTime === "function") {
    try {
      vg.gain.setValueAtTime(mute ? 0 : 1, audioCtx.currentTime);
    } catch (_) {}
  }
  logVeraSettings("apply_workmode_mute", {
    enabled_setting: isWorkModeMuteEnabled() ? 1 : 0,
    in_work_mode: inWork ? 1 : 0,
    effective_mute: mute ? 1 : 0,
    has_gain: vg ? 1 : 0
  });
}

function shouldStreamTts() {
  if (getVeraAsrMode() === "single") return false;
  if (!DEFAULT_STREAM_TTS) return false;
  if (listeningMode === "continuous" && inputMuted) {
    logVeraSettings("stream_tts_off_continuous_input_muted", { value: 0 });
    return false;
  }
  if (appModePrefix() === "vera" && isVeraWorkModeOn() && isWorkModeMuteEnabled()) {
    logVeraSettings("stream_tts_forced_off_workmode_mute", { value: 0 });
    return false;
  }
  return true;
}

browserAsrMainSilenceMs = getVeraAsrSilenceMs();
mainAsrPartialMinChars = getMainAsrPartialMinChars();

function disableBrowserAsrForSession(reason) {
  browserAsrPermanentlyDisabled = true;
  if (speechWaitTimeoutId != null) {
    clearTimeout(speechWaitTimeoutId);
    speechWaitTimeoutId = null;
  }
  console.warn("[BrowserASR] disabled for this session:", reason);
}

function isFatalBrowserSpeechError(code) {
  return (
    code === "not-allowed" ||
    code === "service-not-allowed" ||
    code === "audio-capture"
  );
}

function isNdjsonTtsResponse(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("ndjson") || ct.includes("x-ndjson");
}

/* =========================
   DOM — VERA vs BMO (prefix ids: vera-* / bmo-*)
========================= */

function appModePrefix() {
  return document.body.classList.contains("bmo-open") ? "bmo" : "vera";
}

function uiEl(suffix) {
  return document.getElementById(`${appModePrefix()}-${suffix}`);
}

function getAudioEl() {
  return document.getElementById(`${appModePrefix()}-audio`);
}

function getWaveCanvas() {
  return document.getElementById(`${appModePrefix()}-waveform`);
}

function getWaveCtx() {
  const c = getWaveCanvas();
  return c ? c.getContext("2d") : null;
}

const ttsByMode = {
  vera: { source: null, analyser: null, gain: null },
  bmo: { source: null, analyser: null, gain: null }
};

function getTtsAnalyser() {
  return ttsByMode[appModePrefix()]?.analyser ?? null;
}

["vera-audio", "bmo-audio"].forEach((id) => {
  const a = document.getElementById(id);
  if (a) a.crossOrigin = "anonymous";
});

let waveformData = null;
let frequencyData = null;    // Uint8Array for spectrum
let smoothedBars = null;     // smooth bar heights over time
let rippleRings = [];        // { radius, opacity } for ripple effect
let lastRippleTime = 0;
const RIPPLE_SPAWN_INTERVAL_MS = 120;
let waveformRaf = null;

function resizeWaveCanvas() {
  const canvas = getWaveCanvas();
  const waveCtx = getWaveCtx();
  if (!canvas || !waveCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  /* Hidden / not laid out yet: don't shrink buffer to 0 (avoids blurry upscale when shown). */
  if (rect.width < 4 || rect.height < 4) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  waveCtx.setTransform(1, 0, 0, 1, 0, 0);
  waveCtx.scale(dpr, dpr);
}

window.addEventListener("load", () => {
  resizeWaveCanvas();
});

window.addEventListener("resize", resizeWaveCanvas);

const serverStatusEl = document.getElementById("server-status");

const feedbackInput = document.getElementById("feedback-input");
const sendFeedbackBtn = document.getElementById("send-feedback");
const feedbackStatusEl = document.getElementById("feedback-status");

/* =========================
   SERVER HEALTH
========================= */

async function checkServer() {
  let state = "offline";

  try {
    // 🔥 NEW — check full server state
    const statusRes = await fetch(`${API_URL}/status`, {
      cache: "no-store"
    });

    if (statusRes.ok) {
      const data = await statusRes.json();
      state = data.state; // "ready" or "starting"
    } else {
      state = "offline";
    }
  } catch {
    state = "offline";
  }

  // =========================
  // KEEP YOUR OLD UI LOGIC
  // =========================

  const online = state === "ready";

  ["vera-record", "bmo-record"].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !online;
    btn.style.opacity = online ? "1" : "0.5";
  });

  if (serverStatusEl) {
    serverStatusEl.textContent =
      state === "ready"
        ? "🟢 Server Online"
        : state === "starting"
        ? "🟡 Server Starting"
        : "🔴 Server Offline";

    serverStatusEl.className =
      `server-status ${
        state === "ready"
          ? "online"
          : state === "starting"
          ? "starting"
          : "offline"
      }`;
  }

  ["vera-server-status-inline", "bmo-server-status-inline"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent =
      state === "ready"
        ? "🟢 Online"
        : state === "starting"
        ? "🟡 Starting"
        : "🔴 Offline";

    el.className =
      `server-status ${
        state === "ready"
          ? "online"
          : state === "starting"
          ? "starting"
          : "offline"
      } mobile-only`;
  });

  return state; // 🔥 IMPORTANT
}

checkServer();
setInterval(checkServer, 30_000);
/* =========================
   UI HELPERS
========================= */

/**
 * Flow (non–work) mode: dock input row (voice or keyboard) + lift corner tools when the voice bar
 * is in a docked state (listening / input-output muted) or the keyboard bar is visible.
 */
function syncVeraFlowVoiceDockLayoutClass() {
  const veraApp = document.getElementById("vera-app");
  if (!veraApp) return;
  const st = document.getElementById("vera-status");
  const voiceBar = document.getElementById("vera-voice-bar");
  const keyboardBar = document.getElementById("vera-keyboard-bar");
  if (!st || !voiceBar || !keyboardBar) return;
  const voiceVisible = !voiceBar.classList.contains("hidden");
  const keyboardVisible = !keyboardBar.classList.contains("hidden");
  if (veraApp.classList.contains("work-mode")) {
    /* Flow-mode “docked” bottom padding does not apply; keep input-active when voice/keyboard chrome is up for consistent stacking. */
    veraApp.classList.toggle("vera-flow-input-active", voiceVisible || keyboardVisible);
    veraApp.classList.remove("vera-flow-voice-docked");
    return;
  }
  /* Layer corner tools above bottom fade whenever voice or keyboard chrome is showing (e.g. Ready, not only listening). */
  veraApp.classList.toggle("vera-flow-input-active", voiceVisible || keyboardVisible);
  const rec = st.classList.contains("recording");
  const mutedIdle =
    st.classList.contains("idle") && /muted/i.test(String(st.textContent || "").trim());
  const voiceDock = voiceVisible && (rec || mutedIdle);
  const dock = voiceDock || keyboardVisible;
  veraApp.classList.toggle("vera-flow-voice-docked", dock);
  if (dock) {
    ensureChatStartedLayout();
  }
}

window.syncVeraFlowVoiceDockLayoutClass = syncVeraFlowVoiceDockLayoutClass;
/** @deprecated use syncVeraFlowVoiceDockLayoutClass */
window.syncVeraVoiceListeningLayoutClass = syncVeraFlowVoiceDockLayoutClass;

function setStatus(text, cls) {
  const statusEl = uiEl("status");
  if (!statusEl) return;
  if (cls === "thinking") {
    statusEl.innerHTML = `${text}<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
  } else {
    statusEl.textContent = text;
  }
  statusEl.className = `status ${cls}`;
  if (statusEl.id === "vera-status") {
    if (cls === "recording" && typeof window.cancelStartupTypingForVoiceEntry === "function") {
      window.cancelStartupTypingForVoiceEntry();
    }
    syncVeraFlowVoiceDockLayoutClass();
  }
}

function applyClientUiAction(actionName) {
  const action = String(actionName || "").trim().toLowerCase();
  if (!action) return;
  if (action === "work_mode_on") {
    if (typeof window.setVeraWorkMode === "function") window.setVeraWorkMode(true);
    return;
  }
  if (action === "work_mode_off") {
    if (typeof window.setVeraWorkMode === "function") window.setVeraWorkMode(false);
  }
}

let veraWorkModeTimerTimeoutId = null;
let veraLastWorkModeTimerClientId = null;
/** When set, header pill shows countdown until this epoch ms (work mode). */
let veraWorkModeTimerFireAtMs = null;
let veraWorkModeTimerUiIntervalId = null;
/** True once the scheduled timer has fired and the timer-up modal is showing.
 *  While true the header pill switches to a red overtime counter and the modal
 *  keeps ticking until the user presses Acknowledge. */
let veraWorkModeTimerExpired = false;

function formatWorkModeTimerCountdown(remainingMs) {
  const left = Math.max(0, Number(remainingMs) || 0);
  if (left < 60000) {
    return `${(left / 1000).toFixed(1)}s`;
  }
  const t = Math.floor(left / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

function formatWorkModeTimerOvertime(elapsedMs) {
  const e = Math.max(0, Number(elapsedMs) || 0);
  if (e < 60000) {
    return `-${(e / 1000).toFixed(1)}s`;
  }
  const t = Math.floor(e / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  if (h > 0) return `-${h}:${pad2(m)}:${pad2(s)}`;
  return `-${m}:${pad2(s)}`;
}

function updateWorkModeTimerHeaderFromState() {
  const wrap = document.getElementById("vera-work-mode-timer-wrap");
  const el = document.getElementById("vera-work-mode-timer");
  const dateSep = document.getElementById("vera-datetime-sep-date");
  if (!wrap || !el) return;
  const end = veraWorkModeTimerFireAtMs;
  if (end == null || !Number.isFinite(end)) {
    wrap.hidden = true;
    if (dateSep) dateSep.hidden = true;
    el.textContent = "";
    el.classList.remove("vera-work-mode-timer--overtime");
    return;
  }
  const now = Date.now();
  const left = end - now;
  wrap.hidden = false;
  if (dateSep) dateSep.hidden = false;
  if (veraWorkModeTimerExpired || left <= 0) {
    const overtime = Math.max(0, now - end);
    el.textContent = formatWorkModeTimerOvertime(overtime);
    el.classList.add("vera-work-mode-timer--overtime");
  } else {
    el.textContent = formatWorkModeTimerCountdown(left);
    el.classList.remove("vera-work-mode-timer--overtime");
  }
}

function updateWorkModeTimerUpModalFromState() {
  const modal = document.getElementById("vera-work-timer-up-modal");
  if (!modal || modal.hidden) return;
  const span = document.getElementById("vera-work-timer-up-overtime");
  if (!span) return;
  const end = veraWorkModeTimerFireAtMs;
  if (end == null || !Number.isFinite(end)) {
    span.textContent = "-0.0s";
    return;
  }
  const overtime = Math.max(0, Date.now() - end);
  span.textContent = formatWorkModeTimerOvertime(overtime);
}

function openWorkModeTimerUpModal(message) {
  const modal = document.getElementById("vera-work-timer-up-modal");
  if (!modal) return;
  const desc = document.getElementById("vera-work-timer-up-desc");
  if (desc && message) desc.textContent = String(message);
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  updateWorkModeTimerUpModalFromState();
  try {
    document
      .getElementById("vera-work-timer-up-ack")
      ?.focus({ preventScroll: true });
  } catch (_) {}
}

function closeWorkModeTimerUpModal() {
  const modal = document.getElementById("vera-work-timer-up-modal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
}

function stopWorkModeTimerUiFastRefresh() {
  if (veraWorkModeTimerUiIntervalId != null) {
    clearInterval(veraWorkModeTimerUiIntervalId);
    veraWorkModeTimerUiIntervalId = null;
  }
}

/** Sub-second updates while a short countdown is active or while we're in overtime
 *  (the modal shows tenths of a second and the header pill needs the same cadence). */
function startWorkModeTimerUiFastRefreshIfNeeded() {
  stopWorkModeTimerUiFastRefresh();
  const end = veraWorkModeTimerFireAtMs;
  if (end == null || !Number.isFinite(end)) return;
  const left = end - Date.now();
  const shouldFastRefresh =
    veraWorkModeTimerExpired || (left > 0 && left <= 120000);
  if (!shouldFastRefresh) return;
  veraWorkModeTimerUiIntervalId = window.setInterval(() => {
    updateWorkModeTimerHeaderFromState();
    updateWorkModeTimerUpModalFromState();
    if (veraWorkModeTimerFireAtMs == null) {
      stopWorkModeTimerUiFastRefresh();
      return;
    }
    /* Only stop on the countdown→zero boundary when we have NOT entered overtime yet.
       Once expired, keep ticking forever so the modal counter stays live until ack. */
    if (!veraWorkModeTimerExpired && Date.now() >= veraWorkModeTimerFireAtMs) {
      stopWorkModeTimerUiFastRefresh();
    }
  }, 100);
}

function clearVeraWorkModeClientTimer() {
  stopWorkModeTimerUiFastRefresh();
  if (veraWorkModeTimerTimeoutId != null) {
    clearTimeout(veraWorkModeTimerTimeoutId);
    veraWorkModeTimerTimeoutId = null;
  }
  veraLastWorkModeTimerClientId = null;
  veraWorkModeTimerFireAtMs = null;
  veraWorkModeTimerExpired = false;
  closeWorkModeTimerUpModal();
  updateWorkModeTimerHeaderFromState();
}

/** Only way to dismiss the timer-up modal — also stops any TTS the timer triggered. */
function acknowledgeWorkModeTimerUp() {
  try {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (_) {}
  clearVeraWorkModeClientTimer();
}

/** Server `/infer` + `/text` short-circuit: schedule a one-shot reminder in work mode only. */
function applyWorkModeTimerPayload(wm) {
  if (!wm || typeof wm !== "object") return;
  if (typeof isVeraWorkModeOn !== "function" || !isVeraWorkModeOn()) return;
  if (appModePrefix() !== "vera") return;
  if (wm.cancel === true) {
    clearVeraWorkModeClientTimer();
    return;
  }
  const id = String(wm.id || "");
  const fireMs = Number(wm.fire_at_epoch_ms);
  const message = String(wm.message || "Your work mode timer is up.");
  if (!Number.isFinite(fireMs)) return;
  if (id && id === veraLastWorkModeTimerClientId) return;
  clearVeraWorkModeClientTimer();
  veraLastWorkModeTimerClientId = id || String(fireMs);
  veraWorkModeTimerFireAtMs = fireMs;
  updateWorkModeTimerHeaderFromState();
  startWorkModeTimerUiFastRefreshIfNeeded();
  const delay = Math.max(0, fireMs - Date.now());
  const timerTtsPayload = {
    audio_url: wm.audio_url,
    audio_urls: wm.audio_urls
  };
  veraWorkModeTimerTimeoutId = window.setTimeout(() => {
    veraWorkModeTimerTimeoutId = null;
    if (typeof isVeraWorkModeOn === "function" && !isVeraWorkModeOn()) {
      clearVeraWorkModeClientTimer();
      return;
    }
    if (appModePrefix() !== "vera") {
      clearVeraWorkModeClientTimer();
      return;
    }
    /* Flip to overtime: keep fire_at set so the header pill and modal can both
       compute negative time, and restart fast-refresh so they tick together. */
    veraWorkModeTimerExpired = true;
    updateWorkModeTimerHeaderFromState();
    startWorkModeTimerUiFastRefreshIfNeeded();
    openWorkModeTimerUpModal(message);
    const urls =
      typeof resolveAudioUrls === "function" ? resolveAudioUrls(timerTtsPayload) : [];
    if (urls.length) {
      void playTtsFromApi(timerTtsPayload, {}).catch(() => {});
    } else {
      try {
        if (window.speechSynthesis) {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(message);
          u.rate = 1.0;
          window.speechSynthesis.speak(u);
        }
      } catch (_) {}
    }
    try {
      setStatus("Timer", "idle");
    } catch (_) {}
  }, delay);
}

window.clearVeraWorkModeClientTimer = clearVeraWorkModeClientTimer;

document
  .getElementById("vera-work-timer-up-ack")
  ?.addEventListener("click", acknowledgeWorkModeTimerUp);

function updateMuteInputButton() {
  const continuousMicReady = listeningMode === "continuous" && !!micStream;
  const label = !continuousMicReady
    ? "Start voice input"
    : inputMuted
    ? "Unmute input"
    : "Mute input";

  ["vera-record", "bmo-record"].forEach((id) => {
    const recordBtn = document.getElementById(id);
    if (!recordBtn) return;
    recordBtn.classList.toggle("muted", continuousMicReady && inputMuted);
    recordBtn.title = label;
    recordBtn.setAttribute("aria-label", label);
    recordBtn.setAttribute(
      "aria-pressed",
      continuousMicReady && inputMuted ? "true" : "false"
    );
  });
}

function showMutedStatusIfIdle() {
  if (listeningMode !== "continuous" || !inputMuted) return;
  if (processing || !getAudioEl()?.paused) return;

  waveState = "idle";
  setStatus("Input/output muted", "idle");
}

function setContinuousInputMuted(nextMuted) {
  inputMuted = nextMuted;
  micStream?.getAudioTracks().forEach((track) => {
    track.enabled = !inputMuted;
  });

  if (inputMuted) {
    if (speechWaitTimeoutId != null) {
      clearTimeout(speechWaitTimeoutId);
      speechWaitTimeoutId = null;
    }
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      suppressNextUtterance = true;
      mediaRecorder.stop();
    }
    if (interruptRecorder && interruptRecorder.state !== "inactive") {
      try {
        interruptRecorder.ondataavailable = null;
        interruptRecorder.onstop = null;
        interruptRecorder.stop();
      } catch {}
    }
    interruptRecorder = null;
    interruptRecording = false;
    interruptChunks = [];
    stopAllBrowserSpeechRecognizers();

    /* Same as interrupt: stop <audio>, Web Audio chunk queue, and NDJSON TTS stream. */
    resetAudioHandlers();
    cancelMainTtsPlayback();
    const a = getAudioEl();
    if (a) {
      a.pause();
      a.currentTime = 0;
    }

    processing = false;
    listening = true;
    audioChunks = [];
    hasSpoken = false;
    lastVoiceTime = 0;
    clearVoiceMaxDurationTimer();
    showMutedStatusIfIdle();
  } else if (listeningMode === "continuous" && !requestInFlight && getAudioEl()?.paused) {
    listening = true;
    startListening();
  }

  updateMuteInputButton();
}

function dismissGuide() {
  const prefix = appModePrefix();
  const guideId = prefix === "bmo" ? "bmo-guide" : "vera-guide";
  const seenKey = prefix === "bmo" ? "bmo_seen_guide" : "vera_seen_guide";
  const guide = document.getElementById(guideId);
  if (!guide) return;

  guide.classList.remove("show");
  sessionStorage.setItem(seenKey, "true");

  window.setTimeout(() => {
    if (!guide.classList.contains("show")) {
      guide.classList.add("hidden");
    }
  }, 350);
}

/** Bottom-centered input dock (same as after first LLM reply) — not only after server text. */
function ensureChatStartedLayout() {
  if (!document.body.classList.contains("chat-started")) {
    document.body.classList.add("chat-started");
    dismissGuide();
  }
}

window.ensureChatStartedLayout = ensureChatStartedLayout;

function countSpeechWords(s) {
  return String(s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function clearInterruptDetectionBubble() {
  if (!interruptDetectionBubbleEl) return;
  try {
    if (interruptDetectionBubbleEl.isConnected) {
      const row = interruptDetectionBubbleEl.closest(".message-row");
      if (row) row.remove();
      else interruptDetectionBubbleEl.remove();
    }
  } catch (_) {}
  interruptDetectionBubbleEl = null;
}

/** Live translucent user line while listening for interrupt during assistant TTS (browser ASR). */
function updateInterruptDetectionBubble(text) {
  const line = String(text ?? "").trim();
  const convo = uiEl("conversation");
  if (!convo) return;
  if (!line) return;
  if (!interruptDetectionBubbleEl?.isConnected) {
    const row = document.createElement("div");
    row.className = "message-row user";
    const bubble = document.createElement("div");
    bubble.className = "bubble user interrupt-preview";
    bubble.textContent = line;
    row.appendChild(bubble);
    convo.appendChild(row);
    interruptDetectionBubbleEl = bubble;
  } else {
    interruptDetectionBubbleEl.textContent = line;
  }
  convo.scrollTop = convo.scrollHeight;
}

function truncateVoiceUiQuoteRef(s, maxLen = 96) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Structured reply-back for Work Mode Voice UI stage-2 completions (delayed / final). */
function buildWorkModeVoiceReplyBack({ prep, userText }) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return null;
  if (!prep?.voiceTwoStage?.reasoningRouted) return null;
  const reply_to_user_text = String(userText || prep?.turnContext?.user_text || "").trim();
  if (!reply_to_user_text) return null;
  const tc = prep?.turnContext;
  return {
    reply_to_user_text,
    reply_to_turn_id: String(tc?.turn_id || "").trim(),
    reply_to_lane_id: String(tc?.turn_lane_id || "").trim(),
    reply_to_lane_title: String(tc?.turn_lane_title || "").trim(),
    stage: 2
  };
}

function replyBackQuoteText(replyBack) {
  return String(replyBack?.reply_to_user_text || "").trim();
}

function mergeReplyBackIntoBubbleMeta(meta, replyBack) {
  const opts = { ...(meta || {}) };
  if (!replyBack || typeof replyBack !== "object") return opts;
  if (Number(replyBack.stage) !== 2) return opts;
  const quote = replyBackQuoteText(replyBack);
  if (!quote) return opts;
  opts.replyBack = replyBack;
  opts.voiceQuoteReference = quote;
  opts.voiceReplyBackPreviewEligible = true;
  return opts;
}

function inferTranscriptFromFormData(formData) {
  if (!(formData instanceof FormData) || typeof formData.get !== "function") return "";
  return String(formData.get("transcript") || "").trim();
}

function addBubble(text, who, meta) {
  const convoEl = uiEl("conversation");
  if (!convoEl) return;
  if (who === "user" && voiceTranscriptDebugEnabled()) {
    logVoiceTranscript("final", text, { ...meta, via: "addBubble" });
  }
  const row = document.createElement("div");
  row.className = `message-row ${who}`;

  const replyBackRaw =
    who === "vera" && meta?.replyBack && typeof meta.replyBack === "object" ? meta.replyBack : null;
  const isStage1AckBubble =
    String(meta?.bubbleClass || "").includes("vera-work-mode-stage1-ack") ||
    Number(replyBackRaw?.stage) === 1;
  const replyBackShow =
    who === "vera" &&
    isVeraWorkModeOn() &&
    appModePrefix() === "vera" &&
    !isStage1AckBubble &&
    meta?.voiceReplyBackPreviewEligible === true &&
    replyBackRaw &&
    Number(replyBackRaw.stage) === 2 &&
    replyBackQuoteText(replyBackRaw);
  const replyBack = replyBackShow ? replyBackRaw : null;
  let quoteRaw =
    who === "vera" && !isStage1AckBubble && replyBack ? replyBackQuoteText(replyBack).trim() : "";
  if (isStage1AckBubble) quoteRaw = "";
  if (quoteRaw) {
    row.classList.add("voice-reply-back-row");
    row.dataset.voiceQuoteRef = quoteRaw;
    row.dataset.replyToUserText = quoteRaw;
    if (replyBack) {
      if (replyBack.reply_to_turn_id) row.dataset.replyToTurnId = replyBack.reply_to_turn_id;
      if (replyBack.reply_to_lane_id) row.dataset.replyToLaneId = replyBack.reply_to_lane_id;
      if (replyBack.reply_to_lane_title) row.dataset.replyToLaneTitle = replyBack.reply_to_lane_title;
      row.dataset.replyStage = String(replyBack.stage === 1 ? 1 : 2);
    }
    const ref = document.createElement("div");
    ref.className = "voice-quote-ref";
    ref.setAttribute("role", "note");
    const icon = document.createElement("span");
    icon.className = "voice-quote-ref__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↳";
    const tx = document.createElement("span");
    tx.className = "voice-quote-ref__text";
    tx.textContent = `“${truncateVoiceUiQuoteRef(quoteRaw)}”`;
    ref.appendChild(icon);
    ref.appendChild(tx);
    row.appendChild(ref);
  }

  const bubble = document.createElement("div");
  bubble.className = `bubble ${who}`;
  if (meta?.bubbleClass) {
    const extra = String(meta.bubbleClass || "").trim();
    if (extra) {
      for (const c of extra.split(/\s+/)) {
        if (c) bubble.classList.add(c);
      }
    }
  }
  if (quoteRaw) {
    bubble.classList.add("vera-work-mode-voice-reply");
    bubble.classList.add("vera-work-mode-stage2-reply");
  }
  bubble.textContent = text;

  row.appendChild(bubble);
  convoEl.appendChild(row);
  convoEl.scrollTop = convoEl.scrollHeight;
  if (!chatStateHydrating && (who === "user" || who === "vera")) {
    persistVeraChatState();
  }
  return bubble;
}

/**
 * Apply final user transcript from the server (NDJSON or JSON) without removing the partial bubble:
 * updates the same DOM node the user saw while speaking, then clears the live ref so the next
 * utterance creates a new bubble. Avoids remove-then-add flash with identical text.
 */
function commitServerUserTranscriptBubble(text, path) {
  const t = String(text ?? "").trim();
  if (!t) return;
  const live = mainBrowserLiveBubble;
  if (live?.isConnected) {
    live.textContent = t;
    mainBrowserLiveBubble = null;
    if (voiceTranscriptDebugEnabled()) {
      logVoiceTranscript("final", t, { path, via: "promote-partial-bubble" });
    }
  } else {
    const convoEl = uiEl("conversation");
    if (convoEl) {
      const rows = [...convoEl.querySelectorAll(".message-row")];
      /* Walk up from the bottom to the latest user row. Skip duplicate commit when that user line
         already matches `t` and only assistant rows follow, including a work-mode stage‑1 ack —
         i.e. NDJSON `asr` re-applying the same transcript after stage‑1 inserted a VERA bubble.
         (Do not skip when the user sends the same text again later with no stage‑1 row below.) */
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (!row.classList.contains("user")) continue;
        const b = row.querySelector(".bubble");
        if (b instanceof HTMLElement && b.classList.contains("interrupt-preview")) continue;
        const existing = ((b && b.textContent) || "").trim();
        if (existing !== t) break;
        let sawStage1Below = false;
        let anotherUserBelow = false;
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].classList.contains("user")) {
            anotherUserBelow = true;
            break;
          }
          const vb = rows[j].querySelector(".bubble");
          if (vb?.classList.contains("vera-work-mode-stage1-ack")) sawStage1Below = true;
        }
        if (sawStage1Below && !anotherUserBelow) {
          if (voiceTranscriptDebugEnabled()) {
            logVoiceTranscript("final", t, { path, via: "skip-duplicate-user-bubble-after-stage1" });
          }
          persistVeraChatState();
          ensureChatStartedLayout();
          try {
            if (typeof window !== "undefined") {
              window.__veraLastInferUserTextForLaneGuard = t;
            }
          } catch (_) {}
          return;
        }
        break;
      }
    }
    addBubble(t, "user", { path });
  }
  persistVeraChatState();
  ensureChatStartedLayout();
  try {
    if (typeof window !== "undefined") {
      window.__veraLastInferUserTextForLaneGuard = t;
    }
  } catch (_) {}
}

/** @deprecated name — use commitServerUserTranscriptBubble */
function applyNdjsonUserTranscriptBubble(text, path) {
  commitServerUserTranscriptBubble(text, path);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hideSidePanel() {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;
  const prefix = appModePrefix();
  const isProductivityPane = sidePaneEl.dataset.sidePaneKind === "productivity";
  const keepPinnedInWorkMode =
    prefix === "vera" &&
    isProductivityPane &&
    document.getElementById("vera-app")?.classList.contains("work-mode");
  if (keepPinnedInWorkMode) {
    sidePaneEl.hidden = false;
    sidePaneEl.classList.add("visible");
    document.body.classList.remove("news-panel-open");
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));
    return;
  }
  const keepProductivityMounted = isProductivityPane && shouldKeepMusicPanelMounted(prefix);
  sidePaneEl.classList.remove("visible");
  document.body.classList.remove("news-panel-open");
  if (!keepProductivityMounted) {
    delete sidePaneEl.dataset.sidePaneKind;
  }
  document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));
  window.setTimeout(() => {
    if (!sidePaneEl.classList.contains("visible")) {
      sidePaneEl.hidden = true;
      if (!keepProductivityMounted && !isVeraWorkModeOn()) {
        sidePaneEl.innerHTML = "";
      }
    }
  }, 840);
}

window.hideSidePanel = hideSidePanel;

function spotifyMiniToggleId(prefix) {
  return `${prefix}-spotify-mini-toggle`;
}

function removeSpotifyMiniButton(prefix) {
  document.getElementById(spotifyMiniToggleId(prefix))?.remove();
}

function getProductivityMusicSource(prefix) {
  const root = document.querySelector(`[data-productivity-root="${prefix}"]`);
  return String(root?.dataset.musicSource || "spotify").toLowerCase() === "builtin"
    ? "builtin"
    : "spotify";
}

function setProductivityMusicSource(prefix, source) {
  const builtin = source === "builtin";
  const root = document.querySelector(`[data-productivity-root="${prefix}"]`);
  if (root instanceof HTMLElement) root.dataset.musicSource = builtin ? "builtin" : "spotify";
  document.getElementById(`${prefix}-music-tab-spotify`)?.classList.toggle("active", !builtin);
  document.getElementById(`${prefix}-music-tab-spotify`)?.classList.add("spotify-source-tab");
  document.getElementById(`${prefix}-music-tab-builtin`)?.classList.toggle("active", builtin);
  document
    .getElementById(`${prefix}-music-tab-spotify`)
    ?.setAttribute("aria-selected", builtin ? "false" : "true");
  document
    .getElementById(`${prefix}-music-tab-builtin`)
    ?.setAttribute("aria-selected", builtin ? "true" : "false");
  const spotifyStack = document.getElementById(`${prefix}-spotify-stack`);
  const builtinStack = document.getElementById(`${prefix}-builtin-stack`);
  if (spotifyStack) spotifyStack.hidden = builtin;
  if (builtinStack) builtinStack.hidden = !builtin;
}

function freeMusicAbsUrl(path) {
  const p = String(path || "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  const preferred = String(window.__veraFreeMusicLastCatalogBase || "").replace(/\/$/, "");
  const base = (
    preferred ||
    (typeof localBackendBase === "function" ? String(localBackendBase()).replace(/\/$/, "") : "")
  ).trim();
  if (!base) return p.startsWith("/") ? p : `/${p}`;
  return p.startsWith("/") ? `${base}${p}` : `${base}/${p}`;
}

function isBuiltinFreeMusicPlaying(prefix) {
  const a = document.getElementById(`${prefix}-free-music-audio`);
  return Boolean(a && !a.paused && a.currentTime > 0 && a.src);
}

function stopBuiltinFreeMusic(prefix) {
  const a = document.getElementById(`${prefix}-free-music-audio`);
  if (!a) return;
  a.pause();
  a.removeAttribute("src");
  a.loop = false;
  a.load?.();
  window.__veraFreeMusicPlayback = null;
}

async function pauseSpotifyLayersForBuiltin(prefix) {
  const preview = document.getElementById(`${prefix}-spotify-preview-audio`);
  if (preview && !preview.paused) preview.pause();
  window.__veraSpotifyPlaybackActive = false;
  const tp = window.VeraSpotify?.pausePlayback;
  if (typeof tp === "function") {
    try {
      await tp();
    } catch (_) {
      /* ignore */
    }
  }
}

async function loadFreeMusicCatalog(prefix) {
  const bases = [];
  const push = (u) => {
    const x = String(u || "").replace(/\/$/, "").trim();
    if (x && !bases.includes(x)) bases.push(x);
  };
  /* Prefer the host that last served a catalog so voice playback matches the UI list (avoids worker vs local mismatch). */
  try {
    push(String(window.__veraFreeMusicLastCatalogBase || "").replace(/\/$/, "").trim());
  } catch (_) {}
  try {
    if (typeof localBackendBase === "function") push(localBackendBase());
  } catch (_) {}
  push(typeof API_URL !== "undefined" ? API_URL : "");
  const ordered = bases.length ? bases : ["https://vera-api.vera-api-ned.workers.dev"];
  let lastErr = null;
  for (const base of ordered) {
    try {
      const u = new URL("/api/free-music/catalog", `${base}/`);
      const res = await fetch(u.href, { cache: "no-store" });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      window.__veraFreeMusicLastCatalogBase = base;
      return data;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr || new Error("Failed to fetch");
}

async function ensureFreeMusicCatalogUi(prefix) {
  const catalogEl = document.getElementById(`${prefix}-free-music-catalog`);
  if (!catalogEl) return;
  if (catalogEl.dataset.loaded === "1") return;
  catalogEl.innerHTML = `<p class="free-music-hint">Loading library…</p>`;
  try {
    const data = await loadFreeMusicCatalog(prefix);
    window.__veraFreeMusicCatalog ||= {};
    window.__veraFreeMusicCatalog[prefix] = data;
    catalogEl.innerHTML = renderFreeMusicCatalogHtml(prefix, data);
    catalogEl.dataset.loaded = "1";
    wireFreeMusicCatalogInteractions(prefix);
  } catch (e) {
    catalogEl.innerHTML = `<p class="free-music-hint">Could not load built-in music (${escapeHtml(
      String(e?.message || e)
    )}).</p>`;
  }
}

function freeMusicNormalizeCatalogKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function findFreeMusicPlaylist(prefix, id) {
  const cat = window.__veraFreeMusicCatalog?.[prefix];
  if (!cat || id == null || String(id).trim() === "") return null;
  const playlists = Array.isArray(cat.playlists) ? cat.playlists : [];
  const want = String(id).trim();
  let hit = playlists.find((p) => String(p.id) === want);
  if (hit) return hit;
  const nWant = freeMusicNormalizeCatalogKey(want);
  if (!nWant) return null;
  hit = playlists.find((p) => freeMusicNormalizeCatalogKey(p.id) === nWant);
  if (hit) return hit;
  hit = playlists.find((p) => freeMusicNormalizeCatalogKey(p.title) === nWant);
  if (hit) return hit;
  /* Voice sends lofi_mix; server folder id may differ slightly — if there is only one playlist, use it for lofi. */
  if (nWant === "lofi_mix" && playlists.length === 1) return playlists[0];
  return null;
}

/** Canonical voice/server ids → alternate stems users may drop under ``Free_music/``. */
const FREE_MUSIC_SOUND_ROLE_KEYS = {
  brown_noise: ["brown_noise", "brownnoise", "brown"],
  white_noise: ["white_noise", "whitenoise", "white"],
  rain_sound: [
    "rain_sound",
    "rain_and_thunder",
    "rainandthunder",
    "thunderstorm",
    "thunder",
    "raining"
  ]
};

function freeMusicTrackNormKeys(t) {
  const id = freeMusicNormalizeCatalogKey(t?.id);
  const title = freeMusicNormalizeCatalogKey(t?.title);
  const fn = freeMusicNormalizeCatalogKey((t?.filename || "").replace(/\.[^.]+$/, ""));
  return new Set([id, title, fn].filter(Boolean));
}

/**
 * Resolve a root ambience track (brown / white / rain) from the catalog even when the
 * on-disk stem differs (``Brown Noise.mp3``, ``rain_and_thunder.mp3``, or a track inside a playlist).
 */
function findFreeMusicRootSound(prefix, roleId) {
  const role = freeMusicNormalizeCatalogKey(roleId);
  if (!role) return null;
  const cat = window.__veraFreeMusicCatalog?.[prefix];
  if (!cat) return null;
  const root = Array.isArray(cat.tracks) ? cat.tracks : [];
  const keysToTry = FREE_MUSIC_SOUND_ROLE_KEYS[role] || [role];

  const scoreTrack = (t) => {
    const set = freeMusicTrackNormKeys(t);
    for (const k of keysToTry) {
      const nk = freeMusicNormalizeCatalogKey(k);
      if (!nk) continue;
      for (const cand of set) {
        if (!cand) continue;
        if (cand === nk) return 100;
        if (nk.length >= 5 && cand.startsWith(`${nk}_`)) return 88;
      }
    }
    return 0;
  };

  let best = null;
  let bestScore = 0;
  for (const t of root) {
    if (!t?.url) continue;
    const sc = scoreTrack(t);
    if (sc > bestScore) {
      bestScore = sc;
      best = t;
    }
  }
  if (best?.url) return best;

  const playlists = Array.isArray(cat.playlists) ? cat.playlists : [];
  for (const pl of playlists) {
    for (const t of pl.tracks || []) {
      if (!t?.url) continue;
      const sc = scoreTrack(t);
      if (sc > bestScore) {
        bestScore = sc;
        best = t;
      }
    }
  }
  if (best?.url) return best;
  return null;
}

const FREE_MUSIC_ORDER_STORAGE_PREFIX = "vera_free_music_order_v1";

function freeMusicReadStoredOrder(prefix, playlistId) {
  try {
    const raw = localStorage.getItem(`${FREE_MUSIC_ORDER_STORAGE_PREFIX}_${prefix}_${playlistId}`);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch {
    return null;
  }
}

function freeMusicWriteStoredOrder(prefix, playlistId, urls) {
  try {
    localStorage.setItem(
      `${FREE_MUSIC_ORDER_STORAGE_PREFIX}_${prefix}_${playlistId}`,
      JSON.stringify(urls.map(String))
    );
  } catch {
    /* ignore quota */
  }
}

function freeMusicOrderedTracks(prefix, playlist) {
  const base = Array.isArray(playlist?.tracks) ? playlist.tracks.slice() : [];
  const id = String(playlist?.id || "");
  if (!base.length || !id) return base;
  const saved = freeMusicReadStoredOrder(prefix, id);
  if (!saved || saved.length !== base.length) return base;
  const byUrl = new Map(base.map((t) => [String(t.url), t]));
  const out = [];
  for (const u of saved) {
    const t = byUrl.get(String(u));
    if (t) out.push(t);
  }
  return out.length === base.length ? out : base;
}

function freeMusicPersistOrderFromDom(prefix, playlistId, tracksEl) {
  if (!tracksEl) return;
  const urls = [...tracksEl.querySelectorAll(".free-music-track-row[data-free-track-url]")]
    .map((r) => r.getAttribute("data-free-track-url") || "")
    .filter(Boolean);
  const pl = findFreeMusicPlaylist(prefix, playlistId);
  if (pl && urls.length === (pl.tracks || []).length) freeMusicWriteStoredOrder(prefix, playlistId, urls);
}

function freeMusicDomIdSafe(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function freeMusicPlaylistTrackRowsHtml(prefix, playlist) {
  const ordered = freeMusicOrderedTracks(prefix, playlist);
  return ordered
    .map((t, i) => {
      const url = escapeHtml(String(t.url || ""));
      const name = escapeHtml(String(t.name || t.filename || `Track ${i + 1}`));
      return `<div class="free-music-track-row" draggable="false" data-track-index="${i}" data-free-track-url="${url}">
        <span class="free-music-drag-handle" draggable="true" aria-label="Drag to reorder" title="Drag to reorder">
          <span class="free-music-drag-dots" aria-hidden="true"></span>
        </span>
        <button type="button" class="free-music-builtin-row-play" aria-label="Play ${name}">▶</button>
        <div class="free-music-track-row-title">${name}</div>
      </div>`;
    })
    .join("");
}

function renderFreeMusicCatalogHtml(prefix, data) {
  const playlists = Array.isArray(data?.playlists) ? data.playlists : [];
  const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
  let html = "";
  if (data?.hint) {
    html += `<p class="free-music-hint">${escapeHtml(String(data.hint))}</p>`;
  }
  if (!playlists.length && !tracks.length) {
    html += `<p class="free-music-hint">No audio found yet. On the server, add <code>Free_music/lofi_mix/</code> (playlist) and/or files like <code>white_noise.mp3</code> at <code>Free_music/</code>. See <code>Free_music/README.md</code>.</p>`;
    return html;
  }
  if (playlists.length) {
    html += `<p class="free-music-section-title free-music-section-title--playlists">Playlists</p><div class="free-music-playlist-cards">`;
    for (const p of playlists) {
      const n = p.tracks?.length || 0;
      const title = escapeHtml(String(p.title || p.id || "Playlist"));
      const pid = escapeHtml(String(p.id || ""));
      const sid = freeMusicDomIdSafe(p.id);
      const trackRows = freeMusicPlaylistTrackRowsHtml(prefix, p);
      html += `<div class="free-music-playlist-card" data-free-playlist-id="${pid}">
        <div class="free-music-playlist-head" role="button" tabindex="0" aria-expanded="false" aria-controls="${prefix}-free-pl-tracks-${sid}">
          <span class="free-music-playlist-chevron" aria-hidden="true">▶</span>
          <div class="free-music-playlist-head-text">
            <div class="free-music-playlist-title">${title}</div>
            <div class="free-music-playlist-meta">${n} track${n === 1 ? "" : "s"}</div>
          </div>
          <button type="button" class="free-music-playlist-header-play" aria-label="Play ${title}">▶</button>
        </div>
        <div class="free-music-playlist-tracks" id="${prefix}-free-pl-tracks-${sid}" hidden>${trackRows}</div>
      </div>`;
    }
    html += `</div>`;
  }
  if (tracks.length) {
    html += `<p class="free-music-section-title free-music-section-title--sounds">Sounds</p><div class="free-music-sound-list">`;
    for (const t of tracks) {
      const title = escapeHtml(String(t.title || t.id));
      const url = escapeHtml(String(t.url || ""));
      html += `<div class="free-music-sound-row" data-free-url="${url}">
        <button type="button" class="free-music-sound-row-play" aria-label="Play ${title}">▶</button>
        <span class="free-music-sound-row-title">${title}</span>
      </div>`;
    }
    html += `</div>`;
  }
  return html;
}

function wireFreeMusicCatalogInteractions(prefix) {
  const cat = document.getElementById(`${prefix}-free-music-catalog`);
  if (!cat) return;
  window.__veraFreeMusicListAbort ||= {};
  try {
    window.__veraFreeMusicListAbort[prefix]?.abort();
  } catch (_) {}
  const ac = new AbortController();
  window.__veraFreeMusicListAbort[prefix] = ac;
  const { signal } = ac;
  let dragRow = null;

  cat.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.closest(".free-music-playlist-header-play")) {
        e.preventDefault();
        const card = t.closest(".free-music-playlist-card");
        const id = card?.getAttribute("data-free-playlist-id") || "";
        const pl = findFreeMusicPlaylist(prefix, id);
        if (pl) void playFreeMusicPlaylist(prefix, pl);
        return;
      }
      if (t.closest(".free-music-builtin-row-play")) {
        e.preventDefault();
        const row = t.closest(".free-music-track-row");
        const card = row?.closest(".free-music-playlist-card");
        const id = card?.getAttribute("data-free-playlist-id") || "";
        const idx = Math.max(0, parseInt(String(row?.getAttribute("data-track-index") || "0"), 10) || 0);
        const pl = findFreeMusicPlaylist(prefix, id);
        if (pl) void playFreeMusicPlaylistFrom(prefix, pl, idx);
        return;
      }
      if (t.closest(".free-music-sound-row-play")) {
        e.preventDefault();
        const wrap = t.closest(".free-music-sound-row");
        const u = wrap?.getAttribute("data-free-url") || "";
        const title = wrap?.querySelector(".free-music-sound-row-title")?.textContent?.trim() || "Sound";
        if (u) void playFreeMusicSingle(prefix, { title, url: u }, { loop: true });
        return;
      }
      const head = t.closest(".free-music-playlist-head");
      if (head && !t.closest("button")) {
        e.preventDefault();
        const expanded = head.getAttribute("aria-expanded") === "true";
        const card = head.closest(".free-music-playlist-card");
        const tracks = card?.querySelector(".free-music-playlist-tracks");
        if (!tracks) return;
        head.setAttribute("aria-expanded", expanded ? "false" : "true");
        tracks.hidden = expanded;
        head.classList.toggle("is-expanded", !expanded);
        return;
      }
    },
    { signal }
  );

  cat.addEventListener(
    "dragstart",
    (e) => {
      const handle = e.target?.closest?.(".free-music-drag-handle");
      if (!handle || !cat.contains(handle)) return;
      const row = handle.closest(".free-music-track-row");
      if (!row || !cat.contains(row)) return;
      dragRow = row;
      row.classList.add("free-music-track-row--dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "reorder");
      } catch (_) {}
    },
    { signal }
  );
  cat.addEventListener(
    "dragend",
    () => {
      cat.querySelectorAll(".free-music-track-row--dragging").forEach((el) => {
        el.classList.remove("free-music-track-row--dragging");
      });
      dragRow = null;
    },
    { signal }
  );
  cat.addEventListener(
    "dragover",
    (e) => {
      const row = e.target?.closest?.(".free-music-track-row");
      if (!row || !cat.contains(row) || !dragRow || row === dragRow) return;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = "move";
      } catch (_) {}
    },
    { signal }
  );
  cat.addEventListener(
    "drop",
    (e) => {
      const row = e.target?.closest?.(".free-music-track-row");
      if (!row || !dragRow || row === dragRow || !cat.contains(dragRow)) return;
      e.preventDefault();
      const parent = row.parentElement;
      if (!parent || !dragRow.parentElement) return;
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      if (before) parent.insertBefore(dragRow, row);
      else parent.insertBefore(dragRow, row.nextSibling);
      const card = dragRow.closest(".free-music-playlist-card");
      const pid = card?.getAttribute("data-free-playlist-id");
      const tracksEl = card?.querySelector(".free-music-playlist-tracks");
      if (pid && tracksEl) {
        freeMusicPersistOrderFromDom(prefix, pid, tracksEl);
        [...tracksEl.querySelectorAll(".free-music-track-row")].forEach((r, i) => {
          r.setAttribute("data-track-index", String(i));
        });
      }
      dragRow = null;
    },
    { signal }
  );
}

function syncFreeMusicTransportFlags() {
  const st = window.__veraFreeMusicPlayback;
  if (!st || st.mode !== "playlist" || !st.queue?.length) {
    if (st) {
      st.canNext = false;
      st.canPrev = false;
    }
    return;
  }
  const multi = st.queue.length > 1;
  st.canNext = multi;
  st.canPrev = multi;
}

function freeMusicSyncNowFromAudio(prefix) {
  const a = document.getElementById(`${prefix}-free-music-audio`);
  const st = window.__veraFreeMusicPlayback;
  if (!a || !st) return;
  const dur = Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration * 1000) : 0;
  const pos = Math.round((a.currentTime || 0) * 1000);
  const idx = Number(st.index) || 0;
  const curName = st.queue?.[idx]?.name || "";
  const title =
    st.mode === "playlist" ? st.playlistTitle || "Playlist" : curName || st.playlistTitle || "Built-in";
  const sub =
    st.mode === "playlist"
      ? `Track ${idx + 1} of ${st.queue.length}${curName ? ` • ${curName}` : ""}`
      : st.loopOne
        ? "Looping"
        : "Built-in music";
  syncFreeMusicTransportFlags();
  spotifyUpdateNowState({
    title,
    artist: sub,
    cover_url: "",
    position_ms: pos,
    duration_ms: dur,
    paused: !!a.paused,
    active: !a.paused,
    queue_next_available: !!st.canNext,
    queue_previous_count: st.canPrev ? 1 : 0,
    disallow_skip_prev: !st.canPrev
  });
  spotifyApplyNowStateToPanel(prefix);
}

async function freeMusicPlayQueueIndex(prefix, index) {
  const st = window.__veraFreeMusicPlayback;
  const a = document.getElementById(`${prefix}-free-music-audio`);
  if (!st?.queue?.length || !a) return;
  const i = Math.max(0, Math.min(st.queue.length - 1, index));
  st.index = i;
  const item = st.queue[i];
  a.src = freeMusicAbsUrl(item.url);
  a.volume = Math.min(1, Math.max(0, spotifyGetVolume()));
  await a.play().catch(() => {});
  freeMusicSyncNowFromAudio(prefix);
}

async function playFreeMusicPlaylistFrom(prefix, playlist, startIndex) {
  await pauseSpotifyLayersForBuiltin(prefix);
  const tracks = freeMusicOrderedTracks(prefix, playlist);
  if (!tracks.length) return;
  const a = document.getElementById(`${prefix}-free-music-audio`);
  if (!a) return;
  a.loop = false;
  const i0 = Math.max(0, Math.min(tracks.length - 1, Number(startIndex) || 0));
  window.__veraFreeMusicPlayback = {
    mode: "playlist",
    playlistTitle: String(playlist.title || playlist.id || "Playlist"),
    queue: tracks.map((t) => ({ url: t.url, name: t.name || t.filename || "" })),
    index: i0,
    loopOne: false
  };
  syncFreeMusicTransportFlags();
  await freeMusicPlayQueueIndex(prefix, i0);
}

async function playFreeMusicPlaylist(prefix, playlist) {
  await playFreeMusicPlaylistFrom(prefix, playlist, 0);
}

async function playFreeMusicSingle(prefix, track, { loop }) {
  await pauseSpotifyLayersForBuiltin(prefix);
  const a = document.getElementById(`${prefix}-free-music-audio`);
  if (!a || !track?.url) return;
  a.loop = !!loop;
  window.__veraFreeMusicPlayback = {
    mode: "single",
    playlistTitle: String(track.title || "Sound"),
    queue: [{ url: track.url, name: track.title || "" }],
    index: 0,
    loopOne: !!loop
  };
  syncFreeMusicTransportFlags();
  a.src = freeMusicAbsUrl(track.url);
  a.volume = Math.min(1, Math.max(0, spotifyGetVolume()));
  await a.play().catch(() => {});
  freeMusicSyncNowFromAudio(prefix);
}

async function runBuiltinVoicePlayback(prefix, { playlistId = "", soundId = "" } = {}) {
  wireFreeMusicAudioElement(prefix);
  const prevCat = window.__veraFreeMusicCatalog?.[prefix];
  let data;
  try {
    data = await loadFreeMusicCatalog(prefix);
  } catch (e) {
    const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
    if (artistEl) {
      artistEl.textContent = `Could not load built-in library (${String(e?.message || e)}).`;
    }
    return;
  }
  const prevRich =
    prevCat &&
    ((Array.isArray(prevCat.playlists) && prevCat.playlists.length > 0) ||
      (Array.isArray(prevCat.tracks) && prevCat.tracks.length > 0));
  const fetchedEmpty =
    !(Array.isArray(data?.playlists) && data.playlists.length) &&
    !(Array.isArray(data?.tracks) && data.tracks.length);
  if (fetchedEmpty && prevRich) {
    data = prevCat;
  }
  window.__veraFreeMusicCatalog ||= {};
  window.__veraFreeMusicCatalog[prefix] = data;
  setProductivityMusicSource(prefix, "builtin");
  const pid = String(playlistId || "").trim();
  const sid = String(soundId || "").trim();
  const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
  if (pid) {
    const pl = findFreeMusicPlaylist(prefix, pid);
    if (!pl?.tracks?.length) {
      if (artistEl) {
        artistEl.textContent = `No built-in playlist “${pid.replace(/_/g, " ")}”. Add audio under Free_music/${pid}/ on the server.`;
      }
      return;
    }
    await playFreeMusicPlaylist(prefix, pl);
    return;
  }
  if (sid) {
    const tr = findFreeMusicRootSound(prefix, sid);
    if (!tr?.url) {
      if (artistEl) {
        artistEl.textContent = `No built-in sound “${sid.replace(/_/g, " ")}” in the catalog. Add a file like brown_noise.mp3 under Free_music/ on the server (see Free_music/README.md).`;
      }
      return;
    }
    await playFreeMusicSingle(prefix, { title: tr.title || tr.id || sid, url: tr.url }, { loop: true });
    return;
  }
  if (artistEl) artistEl.textContent = "Nothing to play — missing built-in target.";
}

function matchBuiltinPlaylistOrSoundNameForClient(name) {
  const raw_l = String(name || "").toLowerCase().trim();
  if (!raw_l) return null;
  if (/\b(brown\s*noise)\b/.test(raw_l)) return { soundId: "brown_noise" };
  if (/\b(white\s*noise)\b/.test(raw_l)) return { soundId: "white_noise" };
  if (
    /\b(rain\s*(?:and|,|&|n)\s*(?:thunder|storm)|rain(?:ing)?\s+sound|raining|rain\s+noise|thunder\s*storm|thunder\s+and\s+rain)\b/.test(
      raw_l
    )
  ) {
    return { soundId: "rain_sound" };
  }
  let tail = raw_l.replace(/^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:play|start|put\s+on)\s+/, "");
  tail = tail.replace(/^(?:the|a|an)\s+/, "").replace(/[.?!]+$/, "").trim();
  const lofiTails = new Set([
    "lofi mix",
    "lofi",
    "lofi music",
    "lo-fi mix",
    "lo fi mix",
    "the lofi mix",
    "lofi playlist",
    "lofi beats"
  ]);
  if (
    lofiTails.has(tail) ||
    (/\b(lofi|lo-fi|lo\s+fi)\b/.test(raw_l) && /\b(mix|playlist|beats|radio|station)\b/.test(raw_l))
  ) {
    return { playlistId: "lofi_mix" };
  }
  return null;
}

function wireFreeMusicAudioElement(prefix) {
  const a = document.getElementById(`${prefix}-free-music-audio`);
  if (!a || a.dataset.freeMusicWired === "1") return;
  a.dataset.freeMusicWired = "1";
  a.addEventListener("timeupdate", () => {
    if (getProductivityMusicSource(prefix) !== "builtin") return;
    freeMusicSyncNowFromAudio(prefix);
  });
  a.addEventListener("play", () => {
    if (getProductivityMusicSource(prefix) !== "builtin") return;
    freeMusicSyncNowFromAudio(prefix);
    spotifySyncPlayButtonUi(prefix);
  });
  a.addEventListener("pause", () => {
    if (getProductivityMusicSource(prefix) !== "builtin") return;
    freeMusicSyncNowFromAudio(prefix);
    spotifySyncPlayButtonUi(prefix);
  });
  a.addEventListener("loadedmetadata", () => {
    if (getProductivityMusicSource(prefix) !== "builtin") return;
    freeMusicSyncNowFromAudio(prefix);
  });
  a.addEventListener("ended", () => {
    if (getProductivityMusicSource(prefix) !== "builtin") return;
    const st = window.__veraFreeMusicPlayback;
    if (!st) return;
    if (st.mode === "playlist" && st.queue.length > 1) {
      const next = ((Number(st.index) || 0) + 1) % st.queue.length;
      void freeMusicPlayQueueIndex(prefix, next);
      return;
    }
    freeMusicSyncNowFromAudio(prefix);
    spotifySyncPlayButtonUi(prefix);
  });
}

function isSpotifyPlaybackActive(prefix) {
  const previewAudio = document.getElementById(`${prefix}-spotify-preview-audio`);
  if (previewAudio && !previewAudio.paused && previewAudio.currentTime > 0) return true;
  if (isBuiltinFreeMusicPlaying(prefix)) return true;
  return window.__veraSpotifyPlaybackActive === true;
}

/** Keep music DOM when paused so preview/Web position is not lost on panel close. */
function shouldKeepMusicPanelMounted(prefix) {
  if (isSpotifyPlaybackActive(prefix)) return true;
  const previewAudio = document.getElementById(`${prefix}-spotify-preview-audio`);
  if (previewAudio?.src && !previewAudio.ended) return true;
  const freeA = document.getElementById(`${prefix}-free-music-audio`);
  if (freeA?.src && !freeA.ended) return true;
  const s = spotifyEnsureNowState();
  if (window.__veraSpotifyPlayer && (s.duration_ms > 0 || s.title)) return true;
  return false;
}

function persistSpotifyResumePreview(prefix) {
  const last = window.__veraSpotifyLast || {};
  if (!last.preview_url) return;
  const a = document.getElementById(`${prefix}-spotify-preview-audio`);
  if (!a?.src || a.ended) return;
  window.__veraSpotifyResume = {
    preview_url: last.preview_url,
    currentTimeSec: a.currentTime || 0,
    paused: !!a.paused
  };
}

async function restoreSpotifyPlaybackAfterPanelRemount(prefix) {
  const resume = window.__veraSpotifyResume;
  const last = window.__veraSpotifyLast || {};
  const audio = document.getElementById(`${prefix}-spotify-preview-audio`);

  if (resume?.preview_url && last.preview_url === resume.preview_url && audio) {
    audio.volume = spotifyGetVolume();
    const targetSec = Math.max(0, Number(resume.currentTimeSec) || 0);
    const applySeek = () => {
      const dur = audio.duration;
      if (Number.isFinite(dur) && dur > 0) {
        audio.currentTime = Math.min(targetSec, Math.max(0, dur - 0.05));
      } else {
        audio.currentTime = targetSec;
      }
    };
    audio.src = resume.preview_url;
    if (audio.readyState >= 1) applySeek();
    else audio.addEventListener("loadedmetadata", applySeek, { once: true });
    spotifyUpdateNowState({
      title: last.title || "",
      artist: last.artist || "",
      position_ms: Math.round(targetSec * 1000),
      duration_ms: spotifyEnsureNowState().duration_ms,
      paused: !!resume.paused,
      active: !resume.paused
    });
    spotifySyncPlayButtonUi(prefix);
    spotifyApplyNowStateToPanel(prefix);
  }

  const wr = window.__veraSpotifyResumeWeb;
  const web = window.__veraSpotifyPlayer;
  if (web && wr && typeof web.seek === "function" && Number(wr.position_ms) > 0) {
    try {
      await web.seek(Math.floor(Number(wr.position_ms)));
    } catch (_) {
      /* ignore */
    }
    spotifyApplyNowStateToPanel(prefix);
  }
}

function restoreProductivityPanel(prefix) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;
  removeSpotifyMiniButton(prefix);
  sidePaneEl.hidden = false;
  sidePaneEl.dataset.sidePaneKind = "productivity";
  document.body.classList.add("news-panel-open");
  document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));
  document.getElementById(`${prefix}-productivity-mode`)?.classList.add("is-active");
  spotifyApplyViewMode(prefix);
  requestAnimationFrame(() => {
    sidePaneEl.classList.add("visible");
  });
}

function renderNewsResultListMarkup(results) {
  if (!results.length) {
    return `<div class="side-pane-empty">No articles available for this search.</div>`;
  }

  return `
    <div class="news-result-list">
      ${results.map((item, index) => `
        <article class="news-result-card">
          <h4 class="news-result-title">${index + 1}. ${escapeHtml(item.title)}</h4>
          <p class="news-result-snippet">${escapeHtml(item.summary)}</p>
          <div class="news-result-meta">
            <span>${escapeHtml(item.source || "Unknown source")}</span>
            <span>${escapeHtml(item.published_display || "")}</span>
          </div>
          ${item.url ? `<a class="news-result-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderImageResultsMarkup(images) {
  if (!images.length) {
    return `<div class="side-pane-empty">No images available for this search.</div>`;
  }

  return `
    <div class="media-grid">
      ${images.map((item) => `
        <article class="media-card image-card">
          <a
            class="media-link"
            href="${escapeHtml(item.url || item.image_url)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              class="media-image"
              src="${escapeHtml(item.image_url || item.thumbnail_url || "")}"
              alt="${escapeHtml(item.title || "Search result image")}"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
          </a>
          <div class="media-card-body">
            <div class="media-card-title">${escapeHtml(item.title || "Image result")}</div>
            <div class="media-card-meta">${escapeHtml(item.source || "Unknown source")}</div>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function getVideoEmbedUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const videoId = parsed.pathname.replaceAll("/", "");
      return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      const videoId = parsed.searchParams.get("v");
      return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
    }
  } catch {
    return "";
  }

  return "";
}

function renderVideoResultsMarkup(videos) {
  if (!videos.length) {
    return `<div class="side-pane-empty">No videos available for this search.</div>`;
  }

  return `
    <div class="video-result-list">
      ${videos.map((item) => {
        const embedUrl = getVideoEmbedUrl(item.url);
        return `
          <article class="media-card video-card">
            ${embedUrl ? `
              <div class="video-embed-wrap">
                <iframe
                  class="video-embed"
                  src="${escapeHtml(embedUrl)}"
                  title="${escapeHtml(item.title)}"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen
                  loading="lazy"
                  referrerpolicy="strict-origin-when-cross-origin"
                ></iframe>
              </div>
            ` : item.thumbnail_url ? `
              <a
                class="media-link"
                href="${escapeHtml(item.url)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  class="media-image"
                  src="${escapeHtml(item.thumbnail_url)}"
                  alt="${escapeHtml(item.title)}"
                  loading="lazy"
                  referrerpolicy="no-referrer"
                />
              </a>
            ` : ""}
            <div class="media-card-body">
              <div class="media-card-title">${escapeHtml(item.title)}</div>
              <div class="media-card-meta">
                <span>${escapeHtml(item.source || "Unknown source")}</span>
                <span>${escapeHtml(item.published_display || "")}</span>
              </div>
              ${item.summary ? `<p class="news-result-snippet">${escapeHtml(item.summary)}</p>` : ""}
              <a class="news-result-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open video</a>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function setActiveSidePaneTab(tabName) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  sidePaneEl.querySelectorAll(".side-pane-tab").forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  sidePaneEl.querySelectorAll(".side-pane-tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === tabName);
  });
}

function renderMediaTabsPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  const mount = () => {
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));

    const results = Array.isArray(payload?.news_results)
      ? payload.news_results
      : Array.isArray(payload?.results)
        ? payload.results
        : [];
    const images = Array.isArray(payload?.images) ? payload.images : [];
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];
    const defaultTab = payload?.default_tab || "news";

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "News Results")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.query || "Top headlines")}</div>
      </div>
      <div class="side-pane-controls">
        <div class="side-pane-tabs" role="tablist" aria-label="Search result tabs">
          <button class="side-pane-tab ${defaultTab === "news" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "news" ? "true" : "false"}" data-tab="news">News</button>
          <button class="side-pane-tab ${defaultTab === "images" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "images" ? "true" : "false"}" data-tab="images">Images</button>
          <button class="side-pane-tab ${defaultTab === "video" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "video" ? "true" : "false"}" data-tab="video">Video</button>
        </div>
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "news" ? "active" : ""}" data-tab-panel="news">
      ${renderNewsResultListMarkup(results)}
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "images" ? "active" : ""}" data-tab-panel="images">
      ${renderImageResultsMarkup(images)}
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "video" ? "active" : ""}" data-tab-panel="video">
      ${renderVideoResultsMarkup(videos)}
    </div>
  `;

    sidePaneEl.scrollTop = 0;

    requestAnimationFrame(() => {
      sidePaneEl.classList.add("visible");
    });
  };

  runFlowModeSidePaneContentCrossfade(sidePaneEl, mount);
}

function renderFinanceChartPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  const mount = () => {
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));

    const frameSrc = payload?.chart_url
      ? (payload.chart_url.startsWith("/") ? `${API_URL}${payload.chart_url}` : payload.chart_url)
      : "";

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "Stock Chart")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.query || payload?.symbol || "Quote lookup")}</div>
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="finance-chart-panel">
      ${frameSrc ? `
        <div class="finance-chart-wrap">
          <iframe
            class="finance-chart-frame"
            src="${escapeHtml(frameSrc)}"
            title="${escapeHtml(payload?.symbol || payload?.query || "Stock chart")}"
            loading="lazy"
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        </div>
      ` : `
        <div class="side-pane-empty">
          I couldn’t resolve a chart symbol for this quote yet.
          ${payload?.source_url ? `<a class="news-result-link" href="${escapeHtml(payload.source_url)}" target="_blank" rel="noopener noreferrer">Open finance source</a>` : ""}
        </div>
      `}
    </div>
  `;

    sidePaneEl.scrollTop = 0;

    requestAnimationFrame(() => {
      sidePaneEl.classList.add("visible");
    });
  };

  runFlowModeSidePaneContentCrossfade(sidePaneEl, mount);
}

/** spotify URIs -> open.spotify.com when API omits external_urls */
function spotifyUriToOpenUrl(uri) {
  const s = String(uri || "");
  const mT = s.match(/^spotify:track:([a-zA-Z0-9]+)$/);
  if (mT) return `https://open.spotify.com/track/${mT[1]}`;
  const mAr = s.match(/^spotify:artist:([a-zA-Z0-9]+)$/);
  if (mAr) return `https://open.spotify.com/artist/${mAr[1]}`;
  const mAl = s.match(/^spotify:album:([a-zA-Z0-9]+)$/);
  if (mAl) return `https://open.spotify.com/album/${mAl[1]}`;
  const mPl = s.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (mPl) return `https://open.spotify.com/playlist/${mPl[1]}`;
  return "";
}

/** Spotify catalog id from ``spotify:album:…`` / ``spotify:artist:…`` / ``spotify:track:…``. */
function spotifyEntityIdFromUri(uri, entity) {
  const p = `spotify:${entity}:`;
  const s = String(uri || "").trim();
  if (!s.startsWith(p)) return "";
  return s.slice(p.length).split(/[?#]/)[0] || "";
}

function spotifyRememberSearchSnapshot(prefix) {
  const el = document.getElementById(`${prefix}-spotify-results`);
  if (!el) return;
  window.__veraSpotifySearchSnapshot ||= {};
  window.__veraSpotifySearchSnapshot[prefix] = el.innerHTML;
}

function spotifyRestoreSearchSnapshot(prefix) {
  const el = document.getElementById(`${prefix}-spotify-results`);
  const snap = window.__veraSpotifySearchSnapshot?.[prefix];
  if (el && typeof snap === "string" && snap.length) el.innerHTML = snap;
}

function spotifyRestorePlaylistListSnapshot(prefix) {
  const root = document.getElementById(`${prefix}-spotify-playlist-root`);
  const snap = window.__veraSpotifyPlaylistSnapshot?.[prefix];
  if (root && typeof snap === "string" && snap.length) root.innerHTML = snap;
  spotifySyncPlaylistSelectionHighlight(prefix);
}

function spotifyDetailTrackRowsHtml(tracks, from, to) {
  const slice = (tracks || []).slice(from, to);
  return slice
    .map((item) => {
      const titlePlain = String(item.name ?? item.title ?? "Track");
      const titleEsc = escapeHtml(titlePlain);
      const artistEsc = escapeHtml(spotifyFormatArtists(item));
      const uri = item.uri != null ? escapeHtml(String(item.uri)) : "";
      const prev = item.preview_url != null ? escapeHtml(String(item.preview_url)) : "";
      const openRaw = String(item.open_url || spotifyUriToOpenUrl(item.uri) || "").trim();
      const openEsc = openRaw ? escapeHtml(openRaw) : "";
      return `
        <button type="button" class="spotify-detail-track-row" data-spotify-uri="${uri}" data-preview-url="${prev}" data-open-url="${openEsc}" data-display-title="${titleEsc}" data-display-sub="${artistEsc}">
          <div class="spotify-result-text">
            <div class="spotify-result-title"><span class="spotify-result-title-text">${titleEsc}</span></div>
            <div class="spotify-result-sub">${artistEsc}</div>
          </div>
        </button>`;
    })
    .join("");
}

function spotifyArtistAlbumRowsHtml(albums) {
  const list = Array.isArray(albums) ? albums : [];
  return list
    .map((item) => {
      const titlePlain = String(item.name ?? item.title ?? "Album");
      const titleEsc = escapeHtml(titlePlain);
      const subPlain =
        item.subtitle != null && String(item.subtitle).trim()
          ? String(item.subtitle).trim()
          : spotifyFormatArtists(item) || "Album";
      const subEsc = escapeHtml(subPlain);
      const uriRaw = String(item.uri || "").trim();
      const uri = escapeHtml(uriRaw);
      const thumbUrl = String(item.imageUrl || item.image || "").trim();
      const thumbEsc = thumbUrl ? escapeHtml(thumbUrl) : "";
      return `
        <button type="button" class="spotify-result-row spotify-result-row--album spotify-artist-album-row" data-spotify-album-uri="${uri}" data-display-title="${titleEsc}" data-display-sub="${subEsc}" data-thumb-url="${thumbEsc}">
          ${thumbEsc
            ? `<img class="spotify-result-thumb" src="${thumbEsc}" alt="" loading="lazy" />`
            : `<div class="spotify-result-thumb" aria-hidden="true"></div>`}
          <div class="spotify-result-text">
            <div class="spotify-result-title">
              <span class="spotify-result-kind">Album</span>
              <span class="spotify-result-title-text">${titleEsc}</span>
            </div>
            <div class="spotify-result-sub">${subEsc}</div>
          </div>
        </button>`;
    })
    .join("");
}

async function spotifyOpenAlbumSearchDetail(prefix, meta) {
  const resultsEl = document.getElementById(`${prefix}-spotify-results`);
  if (!resultsEl) return;
  const albumUri = String(meta?.albumUri || "").trim();
  const title = String(meta?.title || "Album");
  const sub = String(meta?.sub || "");
  const thumbUrl = String(meta?.thumbUrl || "").trim();
  const aid = spotifyEntityIdFromUri(albumUri, "album");
  if (!aid) return;
  resultsEl.innerHTML = `<p class="spotify-results-hint">Loading album…</p>`;
  const fn = window.VeraSpotify?.getAlbumTracks;
  if (typeof fn !== "function") {
    resultsEl.innerHTML = `<p class="spotify-results-error">Album tracks API unavailable.</p>`;
    return;
  }
  let tracks;
  try {
    tracks = await fn(aid);
  } catch (err) {
    resultsEl.innerHTML = `<p class="spotify-results-error">${escapeHtml(String(err?.message ?? err))}</p>`;
    return;
  }
  const list = Array.isArray(tracks) ? tracks : [];
  const thumb = thumbUrl
    ? `<img class="spotify-search-detail-cover" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`
    : `<div class="spotify-search-detail-cover spotify-search-detail-cover--ph" aria-hidden="true"></div>`;
  const titleEsc = escapeHtml(title);
  const subEsc = escapeHtml(sub);
  const uriEsc = escapeHtml(albumUri);
  resultsEl.innerHTML = `
    <div class="spotify-search-detail" data-spotify-detail="album">
      <button type="button" class="spotify-search-back">← Results</button>
      <div class="spotify-search-detail-head">
        ${thumb}
        <div class="spotify-search-detail-meta">
          <div class="spotify-search-detail-title">${titleEsc}</div>
          <div class="spotify-search-detail-sub">${subEsc}</div>
        </div>
        <button type="button" class="spotify-album-play-triangle" data-spotify-album-uri="${uriEsc}" aria-label="Play album">▶</button>
      </div>
      <div class="spotify-detail-tracklist">${list.length ? spotifyDetailTrackRowsHtml(list, 0, list.length) : `<p class="spotify-results-hint">No tracks on this album.</p>`}</div>
    </div>`;
}

async function spotifyOpenPlaylistSideDetail(prefix, meta) {
  const root = document.getElementById(`${prefix}-spotify-playlist-root`);
  if (!root) return;
  window.__veraSpotifyPlaylistSnapshot ||= {};
  window.__veraSpotifyPlaylistSnapshot[prefix] = root.innerHTML;

  const playlistId = String(meta?.playlistId || "").trim();
  const playlistUri = String(meta?.playlistUri || "").trim();
  const title = String(meta?.title || "Playlist");
  const sub = String(meta?.sub || "");
  const thumbUrl = String(meta?.thumbUrl || "").trim();
  if (!playlistId || !playlistUri) return;

  root.innerHTML = `<p class="spotify-results-hint">Loading tracks…</p>`;
  const fn = window.VeraSpotify?.getPlaylistTracks;
  if (typeof fn !== "function") {
    spotifyRestorePlaylistListSnapshot(prefix);
    const r = document.getElementById(`${prefix}-spotify-playlist-root`);
    if (r) {
      r.insertAdjacentHTML(
        "beforeend",
        `<p class="spotify-results-error">Playlist tracks API is unavailable.</p>`
      );
    }
    return;
  }
  let tracks;
  try {
    tracks = await fn(playlistId);
  } catch (err) {
    spotifyRestorePlaylistListSnapshot(prefix);
    const r = document.getElementById(`${prefix}-spotify-playlist-root`);
    if (r) {
      r.insertAdjacentHTML(
        "beforeend",
        `<p class="spotify-results-error">${escapeHtml(String(err?.message ?? err))}</p>`
      );
    }
    return;
  }
  const list = Array.isArray(tracks) ? tracks : [];
  const thumb = thumbUrl
    ? `<img class="spotify-search-detail-cover" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`
    : `<div class="spotify-search-detail-cover spotify-search-detail-cover--ph" aria-hidden="true"></div>`;
  const titleEsc = escapeHtml(title);
  const subEsc = escapeHtml(sub);
  const uriEsc = escapeHtml(playlistUri);
  root.innerHTML = `
    <div class="spotify-search-detail" data-spotify-detail="playlist" data-spotify-playlist-context-uri="${uriEsc}">
      <button type="button" class="spotify-search-back">← Playlists</button>
      <div class="spotify-search-detail-head">
        ${thumb}
        <div class="spotify-search-detail-meta">
          <div class="spotify-search-detail-title">${titleEsc}</div>
          <div class="spotify-search-detail-sub">${subEsc}</div>
        </div>
        <button type="button" class="spotify-album-play-triangle" data-spotify-album-uri="${uriEsc}" aria-label="Play playlist">▶</button>
      </div>
      <div class="spotify-detail-tracklist">${
        list.length
          ? spotifyDetailTrackRowsHtml(list, 0, list.length)
          : `<p class="spotify-results-hint">This playlist has no playable tracks yet.</p>`
      }</div>
    </div>`;
}

async function spotifyOpenArtistSearchDetail(prefix, meta) {
  const resultsEl = document.getElementById(`${prefix}-spotify-results`);
  if (!resultsEl) return;
  const artistUri = String(meta?.artistUri || "").trim();
  const title = String(meta?.title || "Artist");
  const thumbUrl = String(meta?.thumbUrl || "").trim();
  const arid = spotifyEntityIdFromUri(artistUri, "artist");
  if (!arid) return;
  resultsEl.innerHTML = `<p class="spotify-results-hint">Loading…</p>`;
  const fn = window.VeraSpotify?.getArtistAlbums;
  if (typeof fn !== "function") {
    resultsEl.innerHTML = `<p class="spotify-results-error">Artist albums API unavailable.</p>`;
    return;
  }
  let albums;
  try {
    albums = await fn(arid);
  } catch (err) {
    resultsEl.innerHTML = `<p class="spotify-results-error">${escapeHtml(String(err?.message ?? err))}</p>`;
    return;
  }
  const list = Array.isArray(albums) ? albums : [];
  const rows = spotifyArtistAlbumRowsHtml(list);
  const thumb = thumbUrl
    ? `<img class="spotify-search-detail-cover" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`
    : `<div class="spotify-search-detail-cover spotify-search-detail-cover--ph" aria-hidden="true"></div>`;
  const titleEsc = escapeHtml(title);
  resultsEl.innerHTML = `
    <div class="spotify-search-detail" data-spotify-detail="artist">
      <button type="button" class="spotify-search-back">← Results</button>
      <div class="spotify-search-detail-head">
        ${thumb}
        <div class="spotify-search-detail-meta">
          <div class="spotify-search-detail-title">${titleEsc}</div>
          <div class="spotify-search-detail-sub">Albums</div>
        </div>
      </div>
      <div class="spotify-detail-tracklist">${rows || `<p class="spotify-results-hint">No albums found.</p>`}</div>
    </div>`;
}

function spotifyFormatArtists(item) {
  const a = item?.artist ?? item?.artists;
  if (Array.isArray(a)) {
    return a
      .map((x) => (typeof x === "string" ? x : x?.name))
      .filter(Boolean)
      .join(", ");
  }
  return a != null ? String(a) : "";
}

function renderSpotifySearchResults(prefix, items) {
  const resultsEl = document.getElementById(`${prefix}-spotify-results`);
  if (!resultsEl) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    resultsEl.innerHTML = `<p class="spotify-results-hint">No results. If you use Spotify keys in a <strong>local</strong> <code>.env</code>, open this page from <code>http://127.0.0.1:8000</code> so search hits your FastAPI (not only the cloud worker).</p>`;
    return;
  }
  resultsEl.innerHTML = list
    .map((item, i) => {
      const kind = String(item.kind || "track").toLowerCase();
      const titlePlain = String(item.title ?? item.name ?? "Result");
      const titleEsc = escapeHtml(titlePlain);
      const subPlain =
        item.subtitle != null && String(item.subtitle).trim()
          ? String(item.subtitle).trim()
          : spotifyFormatArtists(item) || (kind === "artist" ? "Artist" : kind === "album" ? "Album" : "");
      const subEsc = escapeHtml(subPlain);
      const uri = item.uri != null ? escapeHtml(String(item.uri)) : "";
      const img = item.imageUrl ?? item.image ?? item.album?.images?.[0]?.url ?? "";
      const thumb = img
        ? `<img class="spotify-result-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" />`
        : `<div class="spotify-result-thumb" aria-hidden="true"></div>`;
      const prev = item.preview_url != null ? escapeHtml(String(item.preview_url)) : "";
      const openRaw = String(item.open_url || spotifyUriToOpenUrl(item.uri) || "").trim();
      const openEsc = openRaw ? escapeHtml(openRaw) : "";
      const kindChip =
        kind === "album" || kind === "artist"
          ? `<span class="spotify-result-kind">${kind === "album" ? "Album" : "Artist"}</span>`
          : "";
      return `
        <button type="button" class="spotify-result-row spotify-result-row--${escapeHtml(kind)}" data-spotify-kind="${escapeHtml(
        kind
      )}" data-spotify-uri="${uri}" data-spotify-index="${i}" data-preview-url="${prev}" data-open-url="${openEsc}" data-display-title="${titleEsc}" data-display-sub="${subEsc}">
          ${thumb}
          <div class="spotify-result-text">
            <div class="spotify-result-title">
              ${kindChip}
              <span class="spotify-result-title-text">${titleEsc}</span>
            </div>
            <div class="spotify-result-sub">${subEsc}</div>
          </div>
        </button>`;
    })
    .join("");
}

function renderSpotifyPlaylistResults(prefix, playlists) {
  const root = document.getElementById(`${prefix}-spotify-playlist-root`);
  if (!root) return;
  const list = Array.isArray(playlists) ? playlists : [];
  if (!list.length) {
    root.innerHTML = `<p class="spotify-results-hint">No playlists found for this account.</p>`;
    return;
  }
  root.innerHTML = list
    .map((p) => {
      const name = escapeHtml(p.name || "Playlist");
      const uri = escapeHtml(String(p.uri || ""));
      const pid = escapeHtml(String(p.id || ""));
      const total = Number(p.tracks_total) || 0;
      const owner = escapeHtml(String(p.owner_name || ""));
      const img = p.image_url
        ? `<img class="spotify-result-thumb" src="${escapeHtml(p.image_url)}" alt="" loading="lazy" />`
        : `<div class="spotify-result-thumb" aria-hidden="true"></div>`;
      return `
        <button type="button" class="spotify-result-row spotify-playlist-row" data-playlist-id="${pid}" data-playlist-uri="${uri}">
          ${img}
          <div class="spotify-result-text">
            <div class="spotify-result-title">${name}</div>
            <div class="spotify-result-sub">${total} tracks${owner ? ` • ${owner}` : ""}</div>
          </div>
        </button>
      `;
    })
    .join("");
  spotifySyncPlaylistSelectionHighlight(prefix);
}

let _veraSpotifySdkLoading = null;

function loadSpotifyWebSdkScript() {
  if (window.Spotify) return Promise.resolve();
  if (_veraSpotifySdkLoading) return _veraSpotifySdkLoading;
  _veraSpotifySdkLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.dataset.veraSpotifySdk = "1";
    window.onSpotifyWebPlaybackSDKReady = () => {
      _veraSpotifySdkLoading = null;
      resolve();
    };
    s.onerror = () => {
      _veraSpotifySdkLoading = null;
      reject(new Error("Spotify Web Playback SDK failed to load"));
    };
    document.body.appendChild(s);
  });
  return _veraSpotifySdkLoading;
}

const VERA_SPOTIFY_BEARER_STORAGE_KEY = "vera_spotify_bearer";

/** Prefer localStorage so Spotify stays “connected” across reloads and new tabs (same browser). */
function veraSpotifyGetStoredBearer() {
  try {
    return localStorage.getItem(VERA_SPOTIFY_BEARER_STORAGE_KEY) || sessionStorage.getItem(VERA_SPOTIFY_BEARER_STORAGE_KEY);
  } catch (_) {
    return null;
  }
}

function veraSpotifySetStoredBearer(token) {
  const t = String(token || "").trim();
  if (!t) return;
  try {
    localStorage.setItem(VERA_SPOTIFY_BEARER_STORAGE_KEY, t);
    sessionStorage.setItem(VERA_SPOTIFY_BEARER_STORAGE_KEY, t);
  } catch (_) {
    try {
      sessionStorage.setItem(VERA_SPOTIFY_BEARER_STORAGE_KEY, t);
    } catch (_) {
      /* ignore */
    }
  }
}

function veraSpotifyAuthHeaders() {
  const t = veraSpotifyGetStoredBearer();
  if (t) return { Authorization: `Bearer ${t}` };
  return {};
}

function clearVeraSpotifyBearer() {
  try {
    localStorage.removeItem(VERA_SPOTIFY_BEARER_STORAGE_KEY);
    sessionStorage.removeItem(VERA_SPOTIFY_BEARER_STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
  window.__veraSpotifyBearer = null;
}

async function claimSpotifyHandoff(handoff) {
  if (!handoff || typeof handoff !== "string") return;
  const base = localBackendBase();
  const res = await fetch(`${base}/api/spotify/claim-handoff`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...veraSpotifyAuthHeaders() },
    body: JSON.stringify({ handoff })
  });
  if (!res.ok) return;
  const j = await res.json().catch(() => ({}));
  if (j.bearer) {
    veraSpotifySetStoredBearer(j.bearer);
    window.__veraSpotifyBearer = j.bearer;
  }
}

async function refreshSpotifyConnectionUI(prefix) {
  const base = localBackendBase();
  const res = await fetch(`${base}/api/spotify/connection-status`, {
    credentials: "include",
    headers: { ...veraSpotifyAuthHeaders() }
  }).catch(() => null);
  const j = res?.ok ? await res.json().catch(() => ({})) : { connected: false };
  const badge = document.getElementById(`${prefix}-spotify-connected-badge`);
  const logout = document.getElementById(`${prefix}-spotify-logout`);
  const link = document.getElementById(`${prefix}-spotify-connect-link`);
  if (badge) badge.hidden = !j.connected;
  if (logout) logout.hidden = !j.connected;
  if (link) link.style.display = j.connected ? "none" : "";
}

function spotifySyncPlayButtonUi(prefix) {
  const playBtn = document.getElementById(`${prefix}-spotify-play`);
  if (!playBtn) return;
  if (getProductivityMusicSource(prefix) === "builtin") {
    const fa = document.getElementById(`${prefix}-free-music-audio`);
    if (fa?.src) {
      playBtn.textContent = fa.paused ? "▶" : "⏸";
      playBtn.setAttribute("aria-label", fa.paused ? "Play" : "Pause");
      return;
    }
    playBtn.textContent = "▶";
    playBtn.setAttribute("aria-label", "Play / pause");
    return;
  }
  if (window.__veraSpotifyPlayer) return;
  const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
  if (!audio?.src) {
    playBtn.textContent = "▶";
    playBtn.setAttribute("aria-label", "Play / pause");
    return;
  }
  playBtn.textContent = audio.paused ? "▶" : "⏸";
  playBtn.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
}

function spotifyFormatTimeMs(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const s = Math.floor(total / 1000);
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

const SPOTIFY_VOLUME_DEFAULT = 0.1;
const SPOTIFY_VOLUME_MAX = 0.35;
/** If playback is past this many ms, Previous restarts the current track (no prior track in context). */
const SPOTIFY_PREVIOUS_RESTART_MS = 3500;

function spotifyGetVolume() {
  const v = Number(window.__veraSpotifyVolume);
  if (Number.isFinite(v) && v >= 0 && v <= SPOTIFY_VOLUME_MAX) return v;
  const clamped = Number.isFinite(v) ? Math.max(0, Math.min(SPOTIFY_VOLUME_MAX, v)) : SPOTIFY_VOLUME_DEFAULT;
  window.__veraSpotifyVolume = clamped;
  return clamped;
}

function spotifyEnsureNowState() {
  if (!window.__veraSpotifyNowState) {
    window.__veraSpotifyNowState = {
      title: "",
      artist: "",
      cover_url: "",
      position_ms: 0,
      duration_ms: 0,
      paused: true,
      active: false,
      queue_next_available: false,
      queue_previous_count: 0,
      disallow_skip_prev: false
    };
  }
  return window.__veraSpotifyNowState;
}

/** Same rules as the music panel next/prev buttons (for context_snapshot + voice routing). */
function veraSpotifyTransportEligibility() {
  const s = spotifyEnsureNowState();
  const webReady = Boolean(window.__veraSpotifyPlayer && window.__veraSpotifyDeviceId);
  if (!webReady) return { next: false, prev: false };
  const prevCount = Number(s.queue_previous_count) || 0;
  const pos = Math.max(0, Number(s.position_ms) || 0);
  const blockPrev = s.disallow_skip_prev === true;
  return {
    next: Boolean(s.queue_next_available),
    /* SDK often leaves ``previous_tracks`` empty in playlist/album context; still try /previous when Spotify allows. */
    prev:
      pos > SPOTIFY_PREVIOUS_RESTART_MS ||
      (!blockPrev && (prevCount > 0 || pos <= SPOTIFY_PREVIOUS_RESTART_MS))
  };
}

/** Testing: suppress global handoff fallback + Voice excerpt in snapshot when lane handoff attaches. */
const WORK_MODE_INFER_CONTAMINATION_TEST = true;
const WORK_MODE_FOCUSED_LANE_TTL_MS = 30 * 60 * 1000;
/** User-intended reasoning lane (tab click / panel focus / composer focus), not only DOM `.is-active`. */
let focusedWorkModeLaneId = "";
let focusedWorkModeLaneAt = 0;

/** Legacy theme names → panel index (migration only). */
const WORK_MODE_LEGACY_LANE_TO_INDEX = { atlas: 0, echo: 1, nova: 2 };
let workModeStableLaneSeq = 0;
/** Stable meaningless lane ids per panel index: wm_lane_001, … */
const workModeStableLaneIdByIdx = [];

const WORK_MODE_COMPLETION_RANK = {
  ack_status: 0,
  clarification: 1,
  explanation: 2,
  calculation_table: 3,
  solution_code_proof: 4
};

function workModeCompletionRank(type) {
  return WORK_MODE_COMPLETION_RANK[String(type || "")] ?? 0;
}

function initWorkModeStableLaneIdSlots() {
  if (workModeStableLaneIdByIdx.length > 0) return;
  workModeStableLaneSeq = 3;
  workModeStableLaneIdByIdx[0] = "wm_lane_001";
  workModeStableLaneIdByIdx[1] = "wm_lane_002";
  workModeStableLaneIdByIdx[2] = "wm_lane_003";
}

function allocateWorkModeStableLaneId() {
  workModeStableLaneSeq += 1;
  return `wm_lane_${String(workModeStableLaneSeq).padStart(3, "0")}`;
}

function ensureStableLaneIdForPanelIndex(idx) {
  initWorkModeStableLaneIdSlots();
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0) return allocateWorkModeStableLaneId();
  while (workModeStableLaneIdByIdx.length <= i) {
    workModeStableLaneIdByIdx.push("");
  }
  if (!workModeStableLaneIdByIdx[i]) {
    workModeStableLaneIdByIdx[i] = allocateWorkModeStableLaneId();
  }
  return workModeStableLaneIdByIdx[i];
}

function findPanelIndexByStableLaneId(laneId) {
  const lid = String(laneId || "").trim();
  if (!lid) return null;
  if (Object.prototype.hasOwnProperty.call(WORK_MODE_LEGACY_LANE_TO_INDEX, lid)) {
    return WORK_MODE_LEGACY_LANE_TO_INDEX[lid];
  }
  const idx = workModeStableLaneIdByIdx.indexOf(lid);
  if (idx >= 0) return idx;
  const panels = document.querySelectorAll("#vera-reasoning-tab-panels .vera-reasoning-tab-panel");
  for (const panel of panels) {
    if (String(panel.dataset.laneId || "") === lid) {
      const n = Number(panel.dataset.tabIndex);
      return Number.isFinite(n) ? n : null;
    }
  }
  const m = /^lane-(\d+)$/.exec(lid);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getReasoningLaneIndexFromLaneId(laneId) {
  return findPanelIndexByStableLaneId(laneId);
}

/** Display title from panel DOM or registry — not the stable lane id. */
function getWorkModeLaneTitle(laneId) {
  const idx = findPanelIndexByStableLaneId(laneId);
  if (idx != null) {
    const panel = document.querySelector(
      `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
    );
    if (panel instanceof HTMLElement) return getReasoningTabTopicLabel(panel);
  }
  const row = workModeCompletedReasoningByLaneId[String(laneId || "").trim()];
  return String(row?.title || row?.lane_title || "").trim();
}

function syncPanelStableLaneIdsInDom() {
  document
    .querySelectorAll("#vera-reasoning-tab-panels .vera-reasoning-tab-panel")
    .forEach((panel) => {
      const idx = Number(panel.dataset.tabIndex);
      if (!Number.isFinite(idx)) return;
      const lid = ensureStableLaneIdForPanelIndex(idx);
      panel.dataset.laneId = lid;
    });
}

function migrateLegacyLaneRegistryKeys() {
  initWorkModeStableLaneIdSlots();
  const mergeLegacy = (legacyKey, stableId) => {
    const leg = workModeCompletedReasoningByLaneId[legacyKey];
    if (!leg) return;
    const stableRow = workModeCompletedReasoningByLaneId[stableId];
    const legNorm = normalizeLaneRegistryRow({ ...leg, lane_id: stableId, active_lane_id: stableId });
    const stableNorm = stableRow ? normalizeLaneRegistryRow(stableRow) : null;
    if (
      !stableNorm ||
      workModeCompletionRank(legNorm.main_context_type) >
        workModeCompletionRank(stableNorm.main_context_type)
    ) {
      workModeCompletedReasoningByLaneId[stableId] = legNorm;
    }
    delete workModeCompletedReasoningByLaneId[legacyKey];
  };
  for (const [legacy, idx] of Object.entries(WORK_MODE_LEGACY_LANE_TO_INDEX)) {
    mergeLegacy(legacy, ensureStableLaneIdForPanelIndex(idx));
  }
  for (const key of Object.keys(workModeCompletedReasoningByLaneId)) {
    const m = /^lane-(\d+)$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isFinite(idx)) continue;
    mergeLegacy(key, ensureStableLaneIdForPanelIndex(idx));
  }
}

function setFocusedWorkModeLaneFromIndex(idx) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  if (idx == null || !Number.isFinite(Number(idx))) return;
  const lid = getWorkModeReasoningLaneId(Number(idx));
  if (!lid) return;
  focusedWorkModeLaneId = lid;
  focusedWorkModeLaneAt = Date.now();
}

function setFocusedWorkModeLaneId(laneId) {
  const lid = String(laneId || "").trim();
  if (!lid) return;
  focusedWorkModeLaneId = lid;
  focusedWorkModeLaneAt = Date.now();
}

function focusedWorkModeLanePanelExists(laneId) {
  const idx = getReasoningLaneIndexFromLaneId(laneId);
  if (idx == null) return false;
  return Boolean(
    document.querySelector(
      `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
    )
  );
}

/** Recent, valid focused lane id (explicit user intent). */
function getFocusedWorkModeLaneId() {
  const lid = String(focusedWorkModeLaneId || "").trim();
  if (!lid) return "";
  if (Date.now() - (focusedWorkModeLaneAt || 0) > WORK_MODE_FOCUSED_LANE_TTL_MS) return "";
  if (!focusedWorkModeLanePanelExists(lid)) return "";
  return lid;
}

function collectWorkModeReasoningExcerptForLaneIndex(laneIdx, maxChars = 12000) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return "";
  const panel = document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${Number(laneIdx)}"]`
  );
  if (!panel) return "";
  const turns = [...panel.querySelectorAll(".vera-reasoning-turn")];
  if (!turns.length) return "";
  const chunks = [];
  const start = Math.max(0, turns.length - 4);
  for (let i = start; i < turns.length; i += 1) {
    const el = turns[i];
    const md = String(el?.dataset?.markdownAcc || "").trim();
    if (md) {
      chunks.push(md);
      continue;
    }
    const plain = String(el?.textContent || "").replace(/\s+/g, " ").trim();
    if (plain) chunks.push(plain);
  }
  let out = chunks.join("\n\n---\n\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…`;
  return out;
}

/** Tab strip `.is-active` vs panel `.is-active` — they can diverge during render races. */
function collectWorkModeLaneIdentityAtSend(formData, prep) {
  const tabSlot = document.querySelector("#vera-reasoning-tabs .vera-reasoning-tab-slot.is-active");
  const tabBtn = tabSlot?.querySelector("button.vera-reasoning-tab");
  const visibleTabTitle = String(tabBtn?.querySelector(".vera-reasoning-tab-label")?.textContent || "").trim();
  const tabStripIdx = tabBtn ? Number(tabBtn.dataset.tabIndex) : null;
  const tabStripLaneId =
    tabStripIdx != null && Number.isFinite(tabStripIdx) ? getWorkModeReasoningLaneId(tabStripIdx) : "";

  const panelActive = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active");
  const domActiveIdx = panelActive ? Number(panelActive.dataset.tabIndex) : null;
  const domActiveLaneId =
    domActiveIdx != null && Number.isFinite(domActiveIdx) ? getWorkModeReasoningLaneId(domActiveIdx) : "";
  const domActivePanelTitle =
    panelActive instanceof HTMLElement ? getReasoningTabTopicLabel(panelActive) : "";

  const submissionLane =
    formData instanceof FormData && typeof formData.get === "function"
      ? String(formData.get("work_mode_submission_lane_id") || "").trim()
      : "";

  return {
    visible_active_tab_title: visibleTabTitle,
    tab_strip_lane_id: tabStripLaneId,
    dom_is_active_lane_id: domActiveLaneId,
    dom_is_active_panel_title: domActivePanelTitle,
    tab_vs_panel_mismatch: Boolean(
      tabStripLaneId && domActiveLaneId && tabStripLaneId !== domActiveLaneId
    ),
    focused_work_mode_lane_id: getFocusedWorkModeLaneId(),
    focused_stored_raw: String(focusedWorkModeLaneId || ""),
    focused_age_ms: focusedWorkModeLaneAt ? Date.now() - focusedWorkModeLaneAt : null,
    work_mode_submission_lane_id: submissionLane,
    prep_reasoning_lane_id: String(prep?.reasoningLaneId || "").trim()
  };
}

/** Plain-text-ish excerpt from the active reasoning panel for /infer grounding (follow-ups, code requests). */
function collectWorkModeReasoningExcerptForContext(maxChars = 12000) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return "";
  const focused = getFocusedWorkModeLaneId();
  if (focused) {
    const fidx = getReasoningLaneIndexFromLaneId(focused);
    if (fidx != null) {
      const fromFocused = collectWorkModeReasoningExcerptForLaneIndex(fidx, maxChars);
      if (fromFocused) return fromFocused;
    }
  }
  const activePanel = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active");
  if (!activePanel) return "";
  const turns = [...activePanel.querySelectorAll(".vera-reasoning-turn")];
  if (!turns.length) return "";
  const chunks = [];
  const start = Math.max(0, turns.length - 4);
  for (let i = start; i < turns.length; i += 1) {
    const el = turns[i];
    const md = String(el?.dataset?.markdownAcc || "").trim();
    if (md) {
      chunks.push(md);
      continue;
    }
    const plain = String(el?.textContent || "").replace(/\s+/g, " ").trim();
    if (plain) chunks.push(plain);
  }
  let out = chunks.join("\n\n---\n\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…`;
  return out;
}

/** Recent visible Voice UI exchanges for deictic follow-ups like "this problem". */
function collectWorkModeVoiceExcerptForContext(maxChars = 3500, maxRows = 8) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return "";
  const convo = document.getElementById("vera-conversation");
  if (!(convo instanceof HTMLElement)) return "";
  const rows = [...convo.querySelectorAll(".message-row")].filter(
    (row) => row.classList.contains("user") || row.classList.contains("vera")
  );
  if (!rows.length) return "";
  const tail = rows.slice(-Math.max(2, maxRows));
  const lines = [];
  for (const row of tail) {
    const bubble = row.querySelector(".bubble");
    if (!(bubble instanceof HTMLElement)) continue;
    if (bubble.classList.contains("interrupt-preview")) continue;
    const role = row.classList.contains("user") ? "User" : "Assistant";
    const text = String(bubble.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  if (!lines.length) return "";
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…`;
  return out;
}

/**
 * Same-thread requests that still need the reasoning stream (implementation, proofs, full solves).
 * When true, isGeneralWorkModeFollowUpContinuingTask must not suppress routing.
 */
function isReasoningHeavySameThreadRequest(trimmed) {
  const low = String(trimmed || "").toLowerCase();
  if (!low) return false;

  if (
    /\b(code|implement|program(?:ming)?|script|snippet|function|class|debug|refactor)\b/i.test(low) &&
    (/\b(python|typescript|javascript|java|rust|go|kotlin|c\+\+|csharp|sql|julia|matlab|\br\b)\b/i.test(low) ||
      /\b(this|that|it|the problem|the same)\b/i.test(low))
  ) {
    return true;
  }

  if (/\b(full\s+)?proof|formal\s+proof|rigorous\s+proof|prove\s+(?:it|this|that|formally)\b/i.test(low)) {
    return true;
  }
  if (/\bderive|derivation\b/i.test(low)) return true;
  if (/\bstep[\s-]by[\s-]step\b/i.test(low)) return true;
  if (
    /\bsolv(?:e|ing)\b/i.test(low) &&
    (/\b(step|explicitly|completely|fully|all\s+steps|show\s+(?:all\s+)?work)\b/i.test(low) || /\bwork\s+it\s+out\b/i.test(low))
  ) {
    return true;
  }
  if (/\bcalculat(?:e|ing)|compute\b/i.test(low) && /\b(it|this|that|the\s+(numbers?|values?|result))\b/i.test(low)) {
    return true;
  }

  if (
    /\bexplain\b/i.test(low) &&
    /\b(math|mathematics|algebra|calculus|derivation|equation|formula|intuition|why\s+it\s+works|mechanism)\b/i.test(low)
  ) {
    return true;
  }

  return false;
}

/** User asked to stay in Voice / chat only — do not spawn reasoning for artifact follow-ups. */
function explicitVoiceOnlyWorkModeRequest(text) {
  const low = String(text || "").toLowerCase().trim();
  if (!low) return false;
  return (
    /\b(?:just|only)\s+(?:answer|reply|respond|say|tell)\b.*\b(?:here|in\s+chat|in\s+voice|verbally|aloud)\b/i.test(low) ||
    /\b(?:answer|reply)\s+(?:in|here)\s+(?:the\s+)?(?:chat|voice(?:\s+only)?)\b/i.test(low) ||
    /\bdon'?t\s+(?:put|send|use)\s+(?:that|it|this)\s+in\s+(?:the\s+)?reasoning\b/i.test(low) ||
    /\bkeep\s+(?:it\s+)?in\s+(?:the\s+)?(?:chat|voice)\b/i.test(low) ||
    /\bvoice\s+only\b/i.test(low)
  );
}

/**
 * Active homework lane, prior thread text, reasoning panel excerpt, Voice assistant line,
 * or lane registry handoff substantial enough to continue work.
 */
function hasContinuableReasoningContext(priorThreadAnchor) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return false;
  const anchor = String(priorThreadAnchor || "").trim();
  const reasoningPeek = collectWorkModeReasoningExcerptForContext(800).trim();
  const voicePeek = collectWorkModeVoiceExcerptForContext(1400, 8).trim();
  const hasAssistantVoice = /\bAssistant:\s*\S/.test(voicePeek);
  const ai = getActiveReasoningLaneIndex();
  let laneSubstance = false;
  if (ai != null && Number.isFinite(Number(ai))) {
    const lid = getWorkModeReasoningLaneId(Number(ai));
    const h = lid ? getWorkModeLaneHandoff(lid) : null;
    if (h) {
      const ex = String(h.main_context_excerpt || h.latest_final_answer_excerpt || "").trim();
      const pa = String(h.prior_problem_anchor || "").trim();
      laneSubstance = ex.length >= 28 || pa.length >= 8;
    }
  }
  return (
    anchor.length >= 6 ||
    reasoningPeek.length >= 36 ||
    hasAssistantVoice ||
    laneSubstance
  );
}

/**
 * Gated: short asks to materialize code, steps, math, tables, etc. in reasoning (not loose keywords alone).
 */
function isReasoningContentRequest(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const low = raw.toLowerCase();
  const wc = (low.match(/\S+/g) || []).length;
  if (wc > 38) return false;

  if (/\b(?:dress|morse|area|zip|postal|bar)\s+code\b/i.test(low)) return false;
  if (/\bcode\s+of\s+conduct\b/i.test(low)) return false;

  const wantsCode =
    /\b(?:the|that|your|my|this)\s+code\b/i.test(low) ||
    /\bcode\s+(?:for|in|snippet|block)\b/i.test(low) ||
    (/\bcode\b/.test(low) && /\b(show|give|send|see|get|display|paste|type|write|print|put)\b/i.test(low));
  const wantsSteps =
    /\b(?:show|give|list|walk|spell|write)\s+(?:me\s+)?(?:the\s+)?steps\b/i.test(low) ||
    /\bstep[\s-]by[\s-]step\b/i.test(low) ||
    /\bwhat\s+are\s+the\s+steps\b/i.test(low);
  const wantsFormula =
    /\b(?:the\s+)?formulae?\b/i.test(low) && !/\bformulate\s+(?:a\s+)?research\b/i.test(low);
  const wantsEquation = /\bequation(?:s)?\b/i.test(low);
  const wantsCalc =
    /\b(?:write|show|do)\s+(?:the\s+)?calculat(?:e|ing|ion)s?\b/i.test(low) ||
    /\bcalculat(?:e|ing|ion)s?\b/i.test(low) ||
    /\bcompute\b/i.test(low) ||
    /\bwork\s+(?:it\s+)?out\b/i.test(low);
  const wantsProof =
    /\b(?:the\s+)?proof\b/i.test(low) ||
    /\bprove\s+(?:it|this|that|formally)\b/i.test(low) ||
    /\bderivation\b/i.test(low) ||
    /\bderive\b/i.test(low);
  const wantsTable =
    /\b(?:put|set)\s+it\s+in\s+a\s+table\b/i.test(low) ||
    /\bin\s+a\s+table\b/i.test(low) ||
    /\bas\s+a\s+table\b/i.test(low);
  const wantsWorkShow =
    /\bshow\s+(?:me\s+)?(?:the\s+)?(?:work|working)\b/i.test(low) || /\bshow\s+work\b/i.test(low);
  const wantsMarkdown = /\bmarkdown\b/i.test(low) && wc <= 18;
  const wantsLatex = /\blatex\b/i.test(low) && wc <= 18;

  const artifact =
    wantsCode ||
    wantsSteps ||
    wantsFormula ||
    wantsEquation ||
    wantsCalc ||
    wantsProof ||
    wantsTable ||
    wantsWorkShow ||
    wantsMarkdown ||
    wantsLatex;
  if (!artifact) return false;

  const politeAsk =
    /^(?:can\s+you|could\s+you|would\s+you|will\s+you|please|pls)\b/i.test(low) ||
    /^show\s+me\b/i.test(low) ||
    /^give\s+me\b/i.test(low) ||
    /^let\s+me\s+see\b/i.test(low);
  const imperative =
    /^(?:show|give|write|put|list|print|display|type|send)\b/i.test(low.trim()) ||
    /\b(i\s+want\s+to\s+see|i\s+need\s+the)\b/i.test(low);
  const embedded =
    /\b(can\s+you|could\s+you)\s+(?:please\s+)?(?:show|give|write|put|send|type)\b/i.test(low) ||
    /\b(show|give|write|put|send|type)\s+(?:me\s+)?(?:the|that|it)\b/i.test(low);
  const definitionalShort =
    wc <= 16 &&
    (/\bwhat\s+is\s+the\s+(?:formula|equation)\b/i.test(low) ||
      /\bhow\s+do\s+i\s+(?:calculate|compute|derive)\b/i.test(low));

  if (politeAsk || imperative || embedded || definitionalShort) return true;
  if (wc <= 10 && artifact && /\b(show|give|write|put)\b/i.test(low)) return true;
  return false;
}

/**
 * Route short code/step/formula asks into the active reasoning lane when homework context exists.
 * Gated: reasoning ask + continuable context + not voice-only + not panel navigation.
 */
function shouldForceReasoningActiveLaneContentFollowUp(trimmed, priorThreadAnchor) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return false;
  const raw = String(trimmed || "").trim();
  if (!raw) return false;
  if (isExplicitWorkModePanelNavigationIntent(raw)) return false;
  if (explicitVoiceOnlyWorkModeRequest(raw)) return false;
  if (!hasContinuableReasoningContext(priorThreadAnchor)) return false;
  if (!isReasoningContentRequest(raw)) return false;
  try {
    console.info("[work_mode_route]", { mode: "continue_active_lane", snippet: raw.slice(0, 96) });
  } catch (_) {}
  return true;
}

/**
 * True → keep this turn on the main Voice /infer path and reuse snapshot context instead of
 * spawning /work_mode/reasoning_stream. Default: short deictic / continuation turns stay on the
 * active task unless the user clearly starts something new (see negative checks).
 */
function isGeneralWorkModeFollowUpContinuingTask(trimmed, priorThreadAnchor) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return false;
  const raw = String(trimmed || "").trim();
  if (!raw) return false;
  if (isReasoningHeavySameThreadRequest(raw)) return false;
  const low = raw.toLowerCase();
  const wc = (low.match(/\S+/g) || []).length;

  const anchor = String(priorThreadAnchor || "").trim();
  const reasoningPeek = collectWorkModeReasoningExcerptForContext(500).trim();
  const voicePeek = collectWorkModeVoiceExcerptForContext(900, 5).trim();
  const hasAssistantVoice = /\bAssistant:\s*\S/.test(voicePeek);
  const hasContinuableContext =
    anchor.length >= 6 || reasoningPeek.length >= 40 || hasAssistantVoice;

  if (!hasContinuableContext) return false;

  if (
    /\b(new\s+(problem|question|topic|homework|assignment)|different\s+(question|problem)|unrelated|start\s+over|forget\s+(about\s+)?(that|this)|switch\s+topics?)\b/i.test(
      low
    )
  ) {
    return false;
  }

  const deictic = /\b(this|that|these|those|it|them|same|previous|prior|earlier|above|beforehand|the\s+last|your\s+last|the\s+previous)\b/i.test(
    low
  );
  const threadRef =
    /\b(the\s+)?(answer|solution|results?|your\s+work|the\s+work|proof|derivation|approach|method|steps?|tables?|code|numbers?|final)\b/i.test(low);
  const partRef = /\bpart\s+[a-z0-9]{1,4}\b|\bsection\s+\d+|\bsubpart\b/i.test(low);
  const continuation = /\b(continue|go on|carry on|pick up|more detail|keep going|expand|elaborate|shorten|shorter|trim|summarize|recap|clarify|double[\s-]?check)\b/i.test(
    low
  );
  const materials = /\b(answer\s*sheet|rubric|attachment|uploaded|the\s+pdf|the\s+file|what i sent)\b/i.test(low);
  const formatShape = /\b(in\s+a\s+table|as\s+a\s+table|in\s+code|as\s+code|markdown|bullet points?|latex)\b/i.test(low);
  const explainPointing = /\bexplain\b.*\b(that|this|it|your|above)\b/i.test(low);
  const critique = /\b(wrong|mistake|not\s+right|doesn'?t\s+match|correct\s+that)\b/i.test(low);
  const hedgeQuestion = /\b(why|how come|what about|is that true|are you sure)\b/i.test(low);

  if (wc <= 26) {
    if (partRef || continuation || materials || formatShape || explainPointing) return true;
    if (critique && (deictic || threadRef || wc <= 14)) return true;
    if (hedgeQuestion && (deictic || threadRef || partRef)) return true;
    if (threadRef && wc <= 18) return true;
    if (deictic) return true;
  } else if (wc <= 40) {
    if (partRef) return true;
    if (explainPointing) return true;
    if ((continuation || materials || formatShape) && (deictic || threadRef)) return true;
    if (hedgeQuestion && deictic) return true;
  }
  return false;
}

/** Tab list for /infer routing (work mode reasoning spaces). */
function collectWorkModeReasoningPanelsSnapshot() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) {
    return { panels: [], panel_count: 0, max_panels: REASONING_TABS_MAX };
  }
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")]
    .map((p) => {
      const idx = Number(p.dataset.tabIndex);
      return {
        index: Number.isFinite(idx) ? idx : 0,
        label: getReasoningTabTopicLabel(p)
      };
    })
    .filter((x) => Number.isFinite(x.index))
    .sort((a, b) => a.index - b.index);
  return { panels, panel_count: panels.length, max_panels: REASONING_TABS_MAX };
}

function buildClientContextSnapshot(snapshotOpts = {}) {
  const prefix = appModePrefix();
  const inWorkMode = prefix === "vera" && isVeraWorkModeOn();
  const pinnedLaneId = String(snapshotOpts.pinnedLaneId || snapshotOpts.frozenTurnLaneId || "").trim();
  const now = spotifyEnsureNowState();
  const musicTitleDom = document.getElementById(`${prefix}-spotify-track-title`)?.textContent || "";
  const musicArtistDom = document.getElementById(`${prefix}-spotify-track-artist`)?.textContent || "";

  let checklistItems = [];
  if (inWorkMode) {
    try {
      const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY) || "[]";
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) checklistItems = parsed;
    } catch (_) {}
  }
  const ongoing = checklistItems
    .filter((x) => x && !Boolean(x.done))
    .map((x) => String(x.text || "").trim())
    .filter(Boolean);
  const completed = checklistItems
    .filter((x) => x && Boolean(x.done))
    .map((x) => String(x.text || "").trim())
    .filter(Boolean);
  const checklistSnapshotItems = checklistItems
    .filter((x) => x && String(x.text || "").trim())
    .slice(0, 120)
    .map((x) => ({
      id: String(x.id || "").slice(0, 80),
      text: String(x.text || "").trim().slice(0, 200),
      done: Boolean(x.done),
      parent_id: x.parent_id == null ? null : String(x.parent_id || "").slice(0, 80)
    }));

  const activeLaneIdx = inWorkMode ? getActiveReasoningLaneIndex() : null;
  const focusedLaneId = inWorkMode ? getFocusedWorkModeLaneId() : "";
  let reasoningExcerpt = "";
  if (inWorkMode) {
    if (pinnedLaneId) {
      const pidx = getReasoningLaneIndexFromLaneId(pinnedLaneId);
      if (pidx != null) {
        reasoningExcerpt = collectWorkModeReasoningExcerptForLaneIndex(pidx, 12000);
      }
    } else {
      reasoningExcerpt = collectWorkModeReasoningExcerptForContext();
    }
  }
  const suppressVoiceInSnapshot =
    inWorkMode && (WORK_MODE_INFER_CONTAMINATION_TEST || snapshotOpts.weakVoiceOnly === true);
  const voiceExcerpt =
    inWorkMode && !suppressVoiceInSnapshot ? collectWorkModeVoiceExcerptForContext(4500, 10) : "";
  const combinedProblemExcerpt = [reasoningExcerpt, voiceExcerpt]
    .filter((s) => String(s || "").trim())
    .join("\n\n---\n\n");

  const wmReasoningPanels =
    inWorkMode && prefix === "vera" ? collectWorkModeReasoningPanelsSnapshot() : null;

  const transportEl = veraSpotifyTransportEligibility();
  const webReady = Boolean(window.__veraSpotifyPlayer && window.__veraSpotifyDeviceId);
  const music = {
    title: String(now.title || musicTitleDom || "").trim(),
    artist: String(now.artist || musicArtistDom || "").trim(),
    is_playing: Boolean(now.active) && !Boolean(now.paused),
    paused: Boolean(now.paused),
    position_ms: Number(now.position_ms) || 0,
    duration_ms: Number(now.duration_ms) || 0
  };
  /* Only send skip hints when Web Playback is active; otherwise false looks like "no next track" to the server. */
  if (webReady) {
    music.skip_next_available = transportEl.next;
    music.skip_prev_available = transportEl.prev;
  }

  return {
    mode: inWorkMode ? "work" : "flow",
    app: prefix,
    music,
    checklist: inWorkMode
      ? {
          ongoing_count: ongoing.length,
          completed_count: completed.length,
          ongoing_items: ongoing.slice(0, 8),
          items: checklistSnapshotItems,
        }
      : null,
    reasoning:
      inWorkMode && prefix === "vera" && wmReasoningPanels
        ? {
            active_panel_index: activeLaneIdx,
            active_panel_label:
              activeLaneIdx != null && Number.isFinite(Number(activeLaneIdx))
                ? getWorkModeReasoningLaneLabel(Number(activeLaneIdx))
                : "",
            pinned_lane_id: pinnedLaneId || null,
            pinned_lane_title: pinnedLaneId
              ? String(getWorkModeLaneHandoff(pinnedLaneId)?.lane_title || "").trim() || null
              : null,
            recent_problem_excerpt: reasoningExcerpt,
            recent_voice_excerpt: voiceExcerpt || "",
            weak_voice_background_only: Boolean(snapshotOpts.weakVoiceOnly),
            excerpt_chars: combinedProblemExcerpt.length,
            focused_lane_id: focusedLaneId || "",
            contamination_test_no_voice: suppressVoiceInSnapshot,
            panels: wmReasoningPanels.panels,
            panel_count: wmReasoningPanels.panel_count,
            max_panels: wmReasoningPanels.max_panels
          }
        : null,
    planning_deadline_timer: isPlanningDeadlineTimerEnabled(),
    reasoning_auto_route: isWorkModeReasoningAutoRouteEnabled(),
  };
}

function spotifyUpdateNowState(partial = {}) {
  const cur = spotifyEnsureNowState();
  window.__veraSpotifyNowState = { ...cur, ...partial };
  return window.__veraSpotifyNowState;
}

/** After user starts a ``spotify:track:`` on Web Playback, ignore mismatched SDK metadata until catch-up (prevents title/cover flicker). */
function spotifyClearPendingSdkTrack() {
  window.__veraSpotifyPendingSdkTrack = null;
}

function spotifySetPendingSdkTrack(uri) {
  const u = String(uri || "").trim();
  if (!u.startsWith("spotify:track:")) {
    spotifyClearPendingSdkTrack();
    return;
  }
  window.__veraSpotifyPendingSdkTrack = { uri: u, until: Date.now() + 3800 };
}

function spotifySdkMetadataStaleVersusPending(sdkTrackUri) {
  const p = window.__veraSpotifyPendingSdkTrack;
  if (!p?.uri) return false;
  if (Date.now() > p.until) {
    spotifyClearPendingSdkTrack();
    return false;
  }
  const s = String(sdkTrackUri || "").trim();
  return Boolean(s) && s !== p.uri;
}

function spotifyClearPendingIfSdkMatches(sdkTrackUri) {
  const p = window.__veraSpotifyPendingSdkTrack;
  if (!p?.uri) return;
  if (Date.now() > p.until) {
    spotifyClearPendingSdkTrack();
    return;
  }
  if (String(sdkTrackUri || "").trim() === p.uri) spotifyClearPendingSdkTrack();
}

function spotifyReadWebPlaybackTransportHints(state) {
  const tw = state?.track_window || {};
  const nextTracks = Array.isArray(tw.next_tracks) ? tw.next_tracks : [];
  const prevTracks = Array.isArray(tw.previous_tracks) ? tw.previous_tracks : [];
  const dis = state?.disallows || {};
  const skipNextBlocked = dis.skipping_next === true;
  const skipPrevBlocked = dis.skipping_prev === true;
  const ctxUri = String(state?.context?.uri || "").trim();
  const hasBrowsableContext =
    ctxUri.startsWith("spotify:playlist:") ||
    ctxUri.startsWith("spotify:album:") ||
    ctxUri.startsWith("spotify:artist:");
  /** Spotify often leaves ``next_tracks`` empty while playlist/album context still advances; use context + ``disallows``. */
  const queue_next_available = nextTracks.length > 0 || (hasBrowsableContext && !skipNextBlocked);
  return {
    queue_next_available,
    queue_previous_count: prevTracks.length,
    disallow_skip_prev: skipPrevBlocked
  };
}

/** Merge Spotify Web Playback ``state`` into ``__veraSpotifyNowState`` (metadata skipped when pending URI mismatches SDK). */
function spotifySyncNowStateFromWebSdk(state) {
  if (!state) return;
  const curTrack = state.track_window?.current_track;
  const position_ms = Number(state.position) || 0;
  const paused = !!state.paused;

  if (!curTrack) {
    spotifyUpdateNowState({
      position_ms,
      paused,
      active: false,
      queue_next_available: false,
      queue_previous_count: 0,
      disallow_skip_prev: false
    });
    window.__veraSpotifyPlaybackActive = false;
    return;
  }

  const sdkUri = String(curTrack.uri || "").trim();
  const active = !paused;
  const qf = spotifyReadWebPlaybackTransportHints(state);
  if (spotifySdkMetadataStaleVersusPending(sdkUri)) {
    spotifyUpdateNowState({
      position_ms,
      paused,
      active,
      ...qf
    });
    window.__veraSpotifyPlaybackActive = active;
    return;
  }

  spotifyClearPendingIfSdkMatches(sdkUri);
  const cover = curTrack.album?.images?.[0]?.url || "";
  spotifyUpdateNowState({
    title: curTrack.name || "",
    artist: (curTrack.artists || []).map((a) => a.name).filter(Boolean).join(", "),
    cover_url: cover,
    position_ms,
    duration_ms: Number(curTrack.duration_ms) || 0,
    paused,
    active,
    ...qf
  });
  window.__veraSpotifyPlaybackActive = active;
}

function spotifyStopWebPlaybackUiTick() {
  if (window.__veraSpotifyUiTick != null) {
    window.clearInterval(window.__veraSpotifyUiTick);
    window.__veraSpotifyUiTick = null;
  }
  window.__veraSpotifyUiTickPrefix = null;
}

/**
 * While Web Playback is running, ``player_state_changed`` is sparse; poll ``getCurrentState`` so the
 * progress bar and elapsed time update smoothly (~4×/s, paused when the tab is hidden).
 */
function spotifyStartWebPlaybackUiTick(prefix) {
  spotifyStopWebPlaybackUiTick();
  const pfx = prefix || appModePrefix();
  window.__veraSpotifyUiTickPrefix = pfx;
  let inFlight = false;
  window.__veraSpotifyUiTick = window.setInterval(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (inFlight) return;
    const player = window.__veraSpotifyPlayer;
    const tickPrefix = window.__veraSpotifyUiTickPrefix || appModePrefix();
    if (!player || typeof player.getCurrentState !== "function") {
      spotifyStopWebPlaybackUiTick();
      return;
    }
    inFlight = true;
    try {
      const state = await player.getCurrentState();
      if (!state) {
        spotifyStopWebPlaybackUiTick();
        return;
      }
      spotifySyncNowStateFromWebSdk(state);
      spotifyApplyNowStateToPanel(tickPrefix);
      const curTrack = state.track_window?.current_track;
      if (state.paused || !curTrack) spotifyStopWebPlaybackUiTick();
    } catch (_) {
      spotifyStopWebPlaybackUiTick();
    } finally {
      inFlight = false;
    }
  }, 250);
}

async function spotifyRefreshWebPlaybackStateToUi(prefix) {
  const web = window.__veraSpotifyPlayer;
  const pfx = prefix || appModePrefix();
  if (!web?.getCurrentState) return;
  try {
    const st = await web.getCurrentState();
    if (st) {
      spotifySyncNowStateFromWebSdk(st);
      spotifyApplyNowStateToPanel(pfx);
    }
  } catch (_) {}
}

function spotifyApplyNowStateToPanel(prefix) {
  const s = spotifyEnsureNowState();
  const titleEl = document.getElementById(`${prefix}-spotify-track-title`);
  const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
  const ph = document.getElementById(`${prefix}-spotify-art-placeholder`);
  const progress = document.getElementById(`${prefix}-spotify-progress`);
  const elapsed = document.getElementById(`${prefix}-spotify-time-elapsed`);
  const total = document.getElementById(`${prefix}-spotify-time-total`);
  const playBtn = document.getElementById(`${prefix}-spotify-play`);

  if (titleEl) titleEl.textContent = s.title || "Nothing playing";
  if (artistEl) {
    artistEl.textContent =
      s.artist ||
      "Connect Spotify for in-browser playback, or use search + preview / Open in Spotify.";
  }
  if (ph) {
    if (s.cover_url) {
      ph.style.backgroundImage = `url(${JSON.stringify(s.cover_url)})`;
      ph.style.backgroundSize = "cover";
    } else if (getProductivityMusicSource(prefix) === "builtin") {
      ph.style.backgroundImage = "";
    }
  }
  if (elapsed) elapsed.textContent = spotifyFormatTimeMs(s.position_ms);
  if (total) total.textContent = spotifyFormatTimeMs(s.duration_ms);
  if (progress) {
    const duration = Math.max(0, Number(s.duration_ms) || 0);
    progress.max = String(duration);
    if (document.activeElement !== progress) {
      progress.value = String(Math.min(duration, Math.max(0, Number(s.position_ms) || 0)));
    }
    progress.disabled = duration <= 0;
  }
  if (playBtn) {
    playBtn.textContent = s.paused ? "▶" : "⏸";
    playBtn.setAttribute("aria-label", s.paused ? "Play" : "Pause");
  }
  const prevBtn = document.getElementById(`${prefix}-spotify-prev`);
  const nextBtn = document.getElementById(`${prefix}-spotify-next`);
  if (getProductivityMusicSource(prefix) === "builtin") {
    const st = window.__veraFreeMusicPlayback;
    const multi = Boolean(st && st.mode === "playlist" && st.queue && st.queue.length > 1);
    if (nextBtn instanceof HTMLButtonElement) {
      nextBtn.disabled = !multi;
      nextBtn.title = multi ? "Next track" : "Single track or ambience";
    }
    if (prevBtn instanceof HTMLButtonElement) {
      prevBtn.disabled = !multi;
      const pos = Math.max(0, Number(s.position_ms) || 0);
      if (multi) {
        prevBtn.title =
          pos > SPOTIFY_PREVIOUS_RESTART_MS ? "Restart from beginning" : "Previous track";
      } else {
        prevBtn.title = "Single track or ambience";
      }
    }
    return;
  }
  const webReady = Boolean(window.__veraSpotifyPlayer && window.__veraSpotifyDeviceId);
  const { next: canNextElig, prev: canPrevElig } = veraSpotifyTransportEligibility();
  const canNext = webReady && canNextElig;
  const canPrev = webReady && canPrevElig;
  if (nextBtn instanceof HTMLButtonElement) {
    nextBtn.disabled = !canNext;
    nextBtn.title = canNext
      ? "Next track"
      : webReady
        ? "At end of playlist — no further tracks"
        : "Connect in-browser playback (Premium) for skip controls";
  }
  if (prevBtn instanceof HTMLButtonElement) {
    prevBtn.disabled = !canPrev;
    const pos = Math.max(0, Number(s.position_ms) || 0);
    if (canPrev) {
      prevBtn.title =
        pos > SPOTIFY_PREVIOUS_RESTART_MS ? "Restart from beginning" : "Previous track";
    } else {
      prevBtn.title = webReady
        ? "At start of playlist — nothing to skip back to"
        : "Connect in-browser playback (Premium) for skip controls";
    }
  }
}

function spotifyEnsureUiState() {
  if (!window.__veraSpotifyUiState) {
    window.__veraSpotifyUiState = {
      view: "song",
      selectedPlaylistId: "",
      selectedPlaylistUri: "",
      selectedPlaylistName: ""
    };
  }
  return window.__veraSpotifyUiState;
}

function spotifySyncPlaylistSelectionHighlight(prefix) {
  const uiState = spotifyEnsureUiState();
  const playlistRoot = document.getElementById(`${prefix}-spotify-playlist-root`);
  if (!playlistRoot) return;
  const selId = String(uiState.selectedPlaylistId || "");
  playlistRoot.querySelectorAll(".spotify-playlist-row").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const id = String(el.dataset.playlistId || "");
    const selected = Boolean(selId && id === selId);
    el.classList.toggle("is-selected", selected);
    el.setAttribute("aria-selected", selected ? "true" : "false");
  });
}

function spotifyApplyViewMode(prefix) {
  const ui = spotifyEnsureUiState();
  const isPlaylist = ui.view === "playlist";
  const viewRoot = document.getElementById(`${prefix}-spotify-view-root`);
  const songView = document.getElementById(`${prefix}-spotify-song-view`);
  const playlistView = document.getElementById(`${prefix}-spotify-playlist-view`);
  const searchForm = document.getElementById(`${prefix}-spotify-search-form`);
  const songTab = document.getElementById(`${prefix}-spotify-tab-song`);
  const playlistTab = document.getElementById(`${prefix}-spotify-tab-playlist`);
  if (viewRoot instanceof HTMLElement) {
    viewRoot.dataset.spotifyView = isPlaylist ? "playlist" : "search";
  }
  if (songView) songView.hidden = isPlaylist;
  if (playlistView) playlistView.hidden = !isPlaylist;
  if (searchForm) {
    searchForm.hidden = isPlaylist;
    searchForm.setAttribute("aria-hidden", isPlaylist ? "true" : "false");
  }
  if (songTab) {
    songTab.classList.toggle("active", !isPlaylist);
    songTab.setAttribute("aria-selected", isPlaylist ? "false" : "true");
  }
  if (playlistTab) {
    playlistTab.classList.toggle("active", isPlaylist);
    playlistTab.setAttribute("aria-selected", isPlaylist ? "true" : "false");
  }
}

function openSpotifyConnectOAuth() {
  const u = new URL("/auth/spotify/login", `${localBackendBase()}/`);
  try {
    u.searchParams.set("opener_origin", window.location.origin);
  } catch (_) {
    /* ignore */
  }
  const w = window.open(u.href, "_blank");
  if (!w) {
    window.location.href = u.href;
    return;
  }
  const base = localBackendBase();
  clearInterval(window.__veraSpotifyOAuthPoll);
  const tick = async () => {
    if (w.closed) {
      clearInterval(window.__veraSpotifyOAuthPoll);
      window.__veraSpotifyOAuthPoll = null;
      void refreshSpotifyPanelAfterOAuthInOtherTab();
      return;
    }
    const st = await fetch(`${base}/api/spotify/connection-status`, {
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders() }
    })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .catch(() => ({ connected: false }));
    if (st.connected) {
      clearInterval(window.__veraSpotifyOAuthPoll);
      window.__veraSpotifyOAuthPoll = null;
      try {
        w.close();
      } catch (_) {
        /* ignore */
      }
      void refreshSpotifyPanelAfterOAuthInOtherTab();
    }
  };
  window.__veraSpotifyOAuthPoll = setInterval(tick, 1200);
  setTimeout(() => {
    if (window.__veraSpotifyOAuthPoll) {
      clearInterval(window.__veraSpotifyOAuthPoll);
      window.__veraSpotifyOAuthPoll = null;
    }
  }, 180000);
}

function wireSpotifyConnectLink(link) {
  if (!link || link.dataset.veraSpotifyConnectWired) return;
  link.dataset.veraSpotifyConnectWired = "1";
  link.href = "#";
  link.removeAttribute("target");
  link.removeAttribute("rel");
  link.addEventListener("click", (e) => {
    e.preventDefault();
    openSpotifyConnectOAuth();
  });
}

async function refreshSpotifyPanelAfterOAuthInOtherTab() {
  const prefix = appModePrefix();
  if (!document.getElementById(`${prefix}-spotify-connect-link`)) return;
  await refreshSpotifyConnectionUI(prefix);
  const st = await fetch(`${localBackendBase()}/api/spotify/connection-status`, {
    credentials: "include",
    headers: { ...veraSpotifyAuthHeaders() }
  })
    .then((r) => r.json())
    .catch(() => ({ connected: false }));
  if (st.connected) await ensureSpotifyWebPlayer(prefix);
}

async function waitForSpotifyDeviceId(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (window.__veraSpotifyDeviceId) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function ensureSpotifyWebPlayer(prefix) {
  const base = localBackendBase();
  if (window.__veraSpotifyPlayer && window.__veraSpotifyDeviceId) {
    // Rebind panel updates to the currently visible app (vera/bmo) when reusing the same Web Playback instance.
    const s = spotifyEnsureNowState();
    spotifyApplyNowStateToPanel(prefix);
    if (!s.paused && (Number(s.duration_ms) > 0 || String(s.title || "").trim())) {
      spotifyStartWebPlaybackUiTick(prefix);
    } else if (window.__veraSpotifyUiTickPrefix !== prefix) {
      window.__veraSpotifyUiTickPrefix = prefix;
    }
    return;
  }
  const tokRes = await fetch(`${base}/api/spotify/player-token`, {
    credentials: "include",
    headers: { ...veraSpotifyAuthHeaders() }
  });
  if (!tokRes.ok) return;
  await loadSpotifyWebSdkScript();
  const Spotify = window.Spotify;
  if (!Spotify) return;

  if (window.__veraSpotifyPlayer) {
    try {
      spotifyStopWebPlaybackUiTick();
      spotifyClearPendingSdkTrack();
      await window.__veraSpotifyPlayer.disconnect();
    } catch (_) {
      /* ignore */
    }
    window.__veraSpotifyPlayer = null;
    window.__veraSpotifyDeviceId = null;
  }

  const player = new Spotify.Player({
    name: "VERA Web",
    getOAuthToken: (cb) => {
      fetch(`${base}/api/spotify/player-token`, {
        credentials: "include",
        headers: { ...veraSpotifyAuthHeaders() }
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => cb(d.access_token))
        .catch(() => cb(""));
    },
    volume: spotifyGetVolume()
  });

  const readyPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Spotify Web Playback ready timeout")), 28000);
    player.addListener("ready", ({ device_id }) => {
      clearTimeout(t);
      window.__veraSpotifyDeviceId = device_id;
      window.__veraSpotifyPlayer = player;
      resolve(device_id);
    });
  });
  player.addListener("not_ready", () => {
    spotifyStopWebPlaybackUiTick();
    spotifyClearPendingSdkTrack();
    window.__veraSpotifyDeviceId = null;
  });
  player.addListener("authentication_error", ({ message }) => {
    console.warn("[Spotify] Web Playback authentication_error", message);
  });
  player.addListener("playback_error", ({ message }) => {
    console.warn("[Spotify] Web Playback playback_error", message);
  });
  player.addListener("player_state_changed", (state) => {
    if (!state) {
      spotifyStopWebPlaybackUiTick();
      return;
    }
    const curTrack = state?.track_window?.current_track;
    spotifySyncNowStateFromWebSdk(state);
    if (state.paused) removeSpotifyMiniButton(prefix);
    spotifyApplyNowStateToPanel(prefix);
    window.__veraSpotifyResumeWeb = {
      position_ms: Number(state.position) || 0,
      paused: !!state.paused
    };
    const playBtn = document.getElementById(`${prefix}-spotify-play`);
    if (playBtn) {
      if (!curTrack) {
        playBtn.textContent = "▶";
        playBtn.setAttribute("aria-label", "Play / pause");
      } else {
        playBtn.textContent = state.paused ? "▶" : "⏸";
        playBtn.setAttribute("aria-label", state.paused ? "Play" : "Pause");
      }
    }
    if (state && !state.paused && state.track_window?.current_track) {
      spotifyStartWebPlaybackUiTick(prefix);
    } else {
      spotifyStopWebPlaybackUiTick();
    }
  });

  const connected = await player.connect();
  if (!connected) {
    console.warn("[Spotify] player.connect returned false (Premium / browser restrictions?)");
    return;
  }
  try {
    await readyPromise;
  } catch (e) {
    console.warn("[Spotify]", e?.message || e);
  }
}

async function initSpotifyPlaybackForPanel(prefix) {
  wireSpotifyConnectLink(document.getElementById(`${prefix}-spotify-connect-link`));
  await refreshSpotifyConnectionUI(prefix);
  const st = await fetch(`${localBackendBase()}/api/spotify/connection-status`, {
    credentials: "include",
    headers: { ...veraSpotifyAuthHeaders() }
  })
    .then((r) => r.json())
    .catch(() => ({ connected: false }));
  if (st.connected) {
    await ensureSpotifyWebPlayer(prefix);
  }
}

function wireProductivityPanelEvents(prefix) {
  const uiState = spotifyEnsureUiState();
  const form = document.getElementById(`${prefix}-spotify-search-form`);
  const input = document.getElementById(`${prefix}-spotify-search-input`);
  const resultsEl = document.getElementById(`${prefix}-spotify-results`);
  const playlistRoot = document.getElementById(`${prefix}-spotify-playlist-root`);

  wireFreeMusicAudioElement(prefix);

  document.getElementById(`${prefix}-music-tab-spotify`)?.addEventListener("click", () => {
    setProductivityMusicSource(prefix, "spotify");
    spotifyApplyNowStateToPanel(prefix);
    spotifySyncPlayButtonUi(prefix);
    void spotifyRefreshWebPlaybackStateToUi(prefix);
  });
  document.getElementById(`${prefix}-music-tab-builtin`)?.addEventListener("click", async () => {
    await pauseSpotifyLayersForBuiltin(prefix);
    setProductivityMusicSource(prefix, "builtin");
    const fa = document.getElementById(`${prefix}-free-music-audio`);
    if (!fa?.src || fa.ended) {
      spotifyUpdateNowState({
        title: "Nothing playing",
        artist: "Choose a playlist or sound below.",
        cover_url: "",
        position_ms: 0,
        duration_ms: 0,
        paused: true,
        active: false,
        queue_next_available: false,
        queue_previous_count: 0,
        disallow_skip_prev: false
      });
    } else {
      freeMusicSyncNowFromAudio(prefix);
    }
    await ensureFreeMusicCatalogUi(prefix);
    spotifyApplyNowStateToPanel(prefix);
    spotifySyncPlayButtonUi(prefix);
  });

  const applyPlaylistSelectedUi = () => {
    spotifySyncPlaylistSelectionHighlight(prefix);
  };
  applyPlaylistSelectedUi();

  document.getElementById(`${prefix}-spotify-tab-song`)?.addEventListener("click", () => {
    uiState.view = "song";
    spotifyApplyViewMode(prefix);
  });
  document.getElementById(`${prefix}-spotify-tab-playlist`)?.addEventListener("click", async () => {
    uiState.view = "playlist";
    spotifyApplyViewMode(prefix);
    if (!playlistRoot) return;
    if (playlistRoot.dataset.loaded === "1") return;
    playlistRoot.innerHTML = `<p class="spotify-results-hint">Loading playlists…</p>`;
    const fn = window.VeraSpotify?.getPlaylists;
    if (typeof fn !== "function") {
      playlistRoot.innerHTML = `<p class="spotify-results-error">Playlist API is unavailable.</p>`;
      return;
    }
    try {
      const list = await fn();
      renderSpotifyPlaylistResults(prefix, list);
      playlistRoot.dataset.loaded = "1";
    } catch (err) {
      playlistRoot.innerHTML = `<p class="spotify-results-error">${escapeHtml(String(err?.message ?? err))}</p>`;
    }
  });
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = String(input?.value || "").trim();
    if (!q || !resultsEl) return;
    resultsEl.innerHTML = `<p class="spotify-results-hint">Searching…</p>`;
    const fn = window.VeraSpotify?.searchTracks;
    if (typeof fn !== "function") {
      resultsEl.innerHTML = `<p class="spotify-results-hint">Set <code>window.VeraSpotify.searchTracks</code> to a function that returns Spotify results.</p>`;
      return;
    }
    try {
      const items = await fn(q);
      renderSpotifySearchResults(prefix, items);
      spotifyRememberSearchSnapshot(prefix);
    } catch (err) {
      resultsEl.innerHTML = `<p class="spotify-results-error">${escapeHtml(String(err?.message ?? err))}</p>`;
    }
  });

  document.getElementById(`${prefix}-spotify-results`)?.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const resultsRoot = document.getElementById(`${prefix}-spotify-results`);
    if (!resultsRoot || !resultsRoot.contains(t)) return;

    if (t.closest(".spotify-search-back")) {
      spotifyRestoreSearchSnapshot(prefix);
      return;
    }
    const albumPlay = t.closest(".spotify-album-play-triangle");
    if (albumPlay instanceof HTMLElement) {
      e.preventDefault();
      e.stopPropagation();
      const albumUri = albumPlay.dataset.spotifyAlbumUri || "";
      const detail = resultsRoot.querySelector(".spotify-search-detail");
      const ttl = detail?.querySelector(".spotify-search-detail-title")?.textContent || "Album";
      const sub = detail?.querySelector(".spotify-search-detail-sub")?.textContent || "";
      if (albumUri && window.VeraSpotify?.playPlaylist) {
        window.VeraSpotify
          .playPlaylist(albumUri, { playlist_name: ttl, context_subtitle: sub })
          .catch(() => {});
      }
      return;
    }
    const artistAlbumRow = t.closest(".spotify-artist-album-row");
    if (artistAlbumRow instanceof HTMLElement) {
      e.preventDefault();
      const albumUri = artistAlbumRow.dataset.spotifyAlbumUri || "";
      const title = artistAlbumRow.dataset.displayTitle || "";
      const sub = artistAlbumRow.dataset.displaySub || "";
      const thumbUrl = artistAlbumRow.dataset.thumbUrl || "";
      if (albumUri) {
        void spotifyOpenAlbumSearchDetail(prefix, { albumUri, title, sub, thumbUrl });
      }
      return;
    }
    const drow = t.closest(".spotify-detail-track-row");
    if (drow instanceof HTMLElement) {
      const uri = drow.dataset.spotifyUri || "";
      const previewUrl = drow.dataset.previewUrl || "";
      const openUrl = drow.dataset.openUrl || "";
      const title = drow.dataset.displayTitle || "";
      const artist = drow.dataset.displaySub || "";
      const titleEl = document.getElementById(`${prefix}-spotify-track-title`);
      const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
      if (titleEl) titleEl.textContent = title || "—";
      if (artistEl) artistEl.textContent = artist || "";
      const detailRoot = drow.closest(".spotify-search-detail");
      const coverImg = detailRoot?.querySelector(".spotify-search-detail-cover[src]");
      const ph = document.getElementById(`${prefix}-spotify-art-placeholder`);
      if (coverImg instanceof HTMLImageElement && coverImg.src && ph instanceof HTMLElement) {
        ph.style.backgroundImage = `url(${JSON.stringify(coverImg.src)})`;
        ph.style.backgroundSize = "cover";
      }
      const play = window.VeraSpotify?.playTrack;
      if (typeof play === "function" && uri) {
        play(uri, { title, artist, preview_url: previewUrl, open_url: openUrl }).catch(() => {});
      }
      return;
    }

    const row = t.closest(".spotify-result-row");
    if (!row || !(row instanceof HTMLElement) || row.closest(".spotify-search-detail")) return;
    const kind = String(row.dataset.spotifyKind || "track").toLowerCase();
    const uri = row.dataset.spotifyUri || "";
    const previewUrl = row.dataset.previewUrl || "";
    const openUrl = row.dataset.openUrl || "";
    const titleEl = document.getElementById(`${prefix}-spotify-track-title`);
    const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
    const title = row.dataset.displayTitle || row.querySelector(".spotify-result-title-text")?.textContent || "";
    const artist = row.dataset.displaySub || row.querySelector(".spotify-result-sub")?.textContent || "";
    if (kind === "album" && uri) {
      const thumbImg = row.querySelector("img.spotify-result-thumb");
      void spotifyOpenAlbumSearchDetail(prefix, {
        albumUri: uri,
        title,
        sub: artist,
        thumbUrl: thumbImg instanceof HTMLImageElement ? thumbImg.src || "" : ""
      });
      return;
    }
    if (kind === "artist" && uri) {
      const thumbImg = row.querySelector("img.spotify-result-thumb");
      void spotifyOpenArtistSearchDetail(prefix, {
        artistUri: uri,
        title,
        thumbUrl: thumbImg instanceof HTMLImageElement ? thumbImg.src || "" : ""
      });
      return;
    }
    if (titleEl) titleEl.textContent = title || "—";
    if (artistEl) artistEl.textContent = artist || "";
    const coverImg = row.querySelector("img.spotify-result-thumb");
    const ph = document.getElementById(`${prefix}-spotify-art-placeholder`);
    if (coverImg?.src && ph) {
      ph.style.backgroundImage = `url(${JSON.stringify(coverImg.src)})`;
      ph.style.backgroundSize = "cover";
    }
    const play = window.VeraSpotify?.playTrack;
    if (typeof play === "function" && uri) {
      play(uri, { title, artist, preview_url: previewUrl, open_url: openUrl }).catch(() => {});
    }
  });

  playlistRoot?.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !playlistRoot.contains(t)) return;

    if (t.closest(".spotify-search-back")) {
      e.preventDefault();
      spotifyRestorePlaylistListSnapshot(prefix);
      return;
    }

    const albumPlay = t.closest(".spotify-album-play-triangle");
    if (albumPlay instanceof HTMLElement && albumPlay.closest(`#${prefix}-spotify-playlist-root`)) {
      e.preventDefault();
      e.stopPropagation();
      const uri = albumPlay.dataset.spotifyAlbumUri || "";
      const detail = playlistRoot.querySelector(".spotify-search-detail");
      const ttl = detail?.querySelector(".spotify-search-detail-title")?.textContent || "Playlist";
      const sub = detail?.querySelector(".spotify-search-detail-sub")?.textContent || "";
      if (uri && window.VeraSpotify?.playPlaylist) {
        window.VeraSpotify.playPlaylist(uri, { playlist_name: ttl, context_subtitle: sub }).catch(() => {});
      }
      return;
    }

    const drow = t.closest(".spotify-detail-track-row");
    if (drow instanceof HTMLElement && drow.closest(`[data-spotify-detail="playlist"]`)) {
      const uri = drow.dataset.spotifyUri || "";
      const previewUrl = drow.dataset.previewUrl || "";
      const openUrl = drow.dataset.openUrl || "";
      const title = drow.dataset.displayTitle || "";
      const artist = drow.dataset.displaySub || "";
      const titleEl = document.getElementById(`${prefix}-spotify-track-title`);
      const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
      if (titleEl) titleEl.textContent = title || "—";
      if (artistEl) artistEl.textContent = artist || "";
      const detailRoot = drow.closest(".spotify-search-detail");
      const coverImg = detailRoot?.querySelector(".spotify-search-detail-cover[src]");
      const ph = document.getElementById(`${prefix}-spotify-art-placeholder`);
      if (coverImg instanceof HTMLImageElement && coverImg.src && ph instanceof HTMLElement) {
        ph.style.backgroundImage = `url(${JSON.stringify(coverImg.src)})`;
        ph.style.backgroundSize = "cover";
      }
      const ctxUri = String(detailRoot?.dataset.spotifyPlaylistContextUri || uiState.selectedPlaylistUri || "").trim();
      const playFromPlaylist = window.VeraSpotify?.playPlaylistTrack;
      if (typeof playFromPlaylist === "function" && ctxUri && uri) {
        playFromPlaylist(ctxUri, uri, { title, artist, preview_url: previewUrl }).catch(() => {});
        return;
      }
      const play = window.VeraSpotify?.playTrack;
      if (typeof play === "function" && uri) {
        play(uri, { title, artist, preview_url: previewUrl, open_url: openUrl }).catch(() => {});
      }
      return;
    }

    const row = t.closest(".spotify-playlist-row");
    if (!(row instanceof HTMLElement)) return;
    const playlistId = row.dataset.playlistId || "";
    const playlistUri = row.dataset.playlistUri || "";
    const selectedName = row.querySelector(".spotify-result-title")?.textContent || "Playlist";
    const selectedSub = row.querySelector(".spotify-result-sub")?.textContent || "";
    uiState.selectedPlaylistId = playlistId;
    uiState.selectedPlaylistUri = playlistUri;
    uiState.selectedPlaylistName = selectedName;
    applyPlaylistSelectedUi();
    const thumbImg = row.querySelector("img.spotify-result-thumb");
    void spotifyOpenPlaylistSideDetail(prefix, {
      playlistId,
      playlistUri,
      title: selectedName,
      sub: selectedSub,
      thumbUrl: thumbImg instanceof HTMLImageElement ? thumbImg.src || "" : ""
    });
  });

  const playBtn = document.getElementById(`${prefix}-spotify-play`);
  playBtn?.addEventListener("click", () => {
    if (getProductivityMusicSource(prefix) === "builtin") {
      const a = document.getElementById(`${prefix}-free-music-audio`);
      if (!a?.src) return;
      if (a.paused) {
        void a.play().then(() => {
          freeMusicSyncNowFromAudio(prefix);
          spotifySyncPlayButtonUi(prefix);
        });
      } else {
        a.pause();
        freeMusicSyncNowFromAudio(prefix);
        spotifySyncPlayButtonUi(prefix);
      }
      return;
    }
    const toggle = window.VeraSpotify?.togglePlayback;
    if (typeof toggle === "function") toggle().catch(() => {});
  });

  document.getElementById(`${prefix}-spotify-next`)?.addEventListener("click", () => {
    if (getProductivityMusicSource(prefix) === "builtin") {
      const st = window.__veraFreeMusicPlayback;
      if (st?.mode === "playlist" && st.queue?.length > 1) {
        const next = ((Number(st.index) || 0) + 1) % st.queue.length;
        void freeMusicPlayQueueIndex(prefix, next);
      }
      return;
    }
    invokeSpotifyTransport("skip_next", { source: "button" });
  });
  document.getElementById(`${prefix}-spotify-prev`)?.addEventListener("click", () => {
    if (getProductivityMusicSource(prefix) === "builtin") {
      const st = window.__veraFreeMusicPlayback;
      const a = document.getElementById(`${prefix}-free-music-audio`);
      if (st?.mode === "playlist" && st.queue?.length > 1) {
        const pos = Math.round((a?.currentTime || 0) * 1000);
        if (pos > SPOTIFY_PREVIOUS_RESTART_MS && a) {
          a.currentTime = 0;
          freeMusicSyncNowFromAudio(prefix);
          return;
        }
        const prev = ((Number(st.index) || 0) + st.queue.length - 1) % st.queue.length;
        void freeMusicPlayQueueIndex(prefix, prev);
      }
      return;
    }
    invokeSpotifyTransport("skip_previous", { source: "button" });
  });

  document.getElementById(`${prefix}-spotify-logout`)?.addEventListener("click", async () => {
    const base = localBackendBase();
    await fetch(`${base}/api/spotify/logout`, {
      method: "POST",
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders(), "Content-Type": "application/json" }
    }).catch(() => {});
    clearVeraSpotifyBearer();
    try {
      await window.__veraSpotifyPlayer?.disconnect();
    } catch (_) {
      /* ignore */
    }
    window.__veraSpotifyPlayer = null;
    window.__veraSpotifyDeviceId = null;
    window.__veraSpotifyPlaybackActive = false;
    window.__veraSpotifyResume = null;
    window.__veraSpotifyResumeWeb = null;
    spotifyStopWebPlaybackUiTick();
    spotifyClearPendingSdkTrack();
    spotifyUpdateNowState({
      title: "",
      artist: "",
      cover_url: "",
      position_ms: 0,
      duration_ms: 0,
      paused: true,
      active: false,
      queue_next_available: false,
      queue_previous_count: 0,
      disallow_skip_prev: false
    });
    removeSpotifyMiniButton(prefix);
    await refreshSpotifyConnectionUI(prefix);
  });

  wireSpotifyConnectLink(document.getElementById(`${prefix}-spotify-connect-link`));

  const previewAudio = document.getElementById(`${prefix}-spotify-preview-audio`);
  if (previewAudio && !previewAudio.dataset.veraSpotifyPlayUiWired) {
    previewAudio.dataset.veraSpotifyPlayUiWired = "1";
    const onPreviewPlayState = () => {
      if (getProductivityMusicSource(prefix) === "builtin") return;
      spotifySyncPlayButtonUi(prefix);
      window.__veraSpotifyPlaybackActive = !previewAudio.paused && previewAudio.currentTime > 0;
      if (!window.__veraSpotifyPlaybackActive) {
        removeSpotifyMiniButton(prefix);
      }
      if (previewAudio.ended) {
        window.__veraSpotifyResume = null;
      } else {
        persistSpotifyResumePreview(prefix);
      }
      spotifyUpdateNowState({
        position_ms: Math.round((previewAudio.currentTime || 0) * 1000),
        duration_ms: Number.isFinite(previewAudio.duration) ? Math.round(previewAudio.duration * 1000) : 0,
        paused: !!previewAudio.paused,
        active: !previewAudio.paused,
        queue_next_available: false,
        queue_previous_count: 0,
        disallow_skip_prev: false
      });
      spotifyApplyNowStateToPanel(prefix);
    };
    const onPreviewTime = () => {
      if (getProductivityMusicSource(prefix) === "builtin") return;
      persistSpotifyResumePreview(prefix);
      spotifyUpdateNowState({
        position_ms: Math.round((previewAudio.currentTime || 0) * 1000),
        duration_ms: Number.isFinite(previewAudio.duration) ? Math.round(previewAudio.duration * 1000) : 0,
        queue_next_available: false,
        queue_previous_count: 0,
        disallow_skip_prev: false
      });
      spotifyApplyNowStateToPanel(prefix);
    };
    previewAudio.addEventListener("play", onPreviewPlayState);
    previewAudio.addEventListener("pause", onPreviewPlayState);
    previewAudio.addEventListener("ended", onPreviewPlayState);
    previewAudio.addEventListener("timeupdate", onPreviewTime);
    previewAudio.addEventListener("durationchange", onPreviewTime);
    previewAudio.addEventListener("loadedmetadata", onPreviewTime);
  }

  const progress = document.getElementById(`${prefix}-spotify-progress`);
  progress?.addEventListener("input", () => {
    const ms = Number(progress.value) || 0;
    const elapsed = document.getElementById(`${prefix}-spotify-time-elapsed`);
    if (elapsed) elapsed.textContent = spotifyFormatTimeMs(ms);
  });
  progress?.addEventListener("change", () => {
    const ms = Number(progress.value) || 0;
    if (getProductivityMusicSource(prefix) === "builtin") {
      const a = document.getElementById(`${prefix}-free-music-audio`);
      if (a && Number.isFinite(a.duration) && a.duration > 0) {
        a.currentTime = Math.min(Math.max(0, a.duration - 0.05), Math.max(0, ms / 1000));
      }
      freeMusicSyncNowFromAudio(prefix);
      return;
    }
    const seekTo = window.VeraSpotify?.seekTo;
    if (typeof seekTo === "function") seekTo(ms).catch(() => {});
  });

  const volume = document.getElementById(`${prefix}-spotify-volume`);
  if (volume) {
    volume.value = String(Math.round(spotifyGetVolume() * 100));
    const onVolumeInput = () => {
      const value = (Number(volume.value) || 0) / 100;
      window.__veraSpotifyVolume = value;
      if (getProductivityMusicSource(prefix) === "builtin") {
        const a = document.getElementById(`${prefix}-free-music-audio`);
        if (a) a.volume = Math.min(1, Math.max(0, value));
        return;
      }
      const setVolume = window.VeraSpotify?.setVolume;
      if (typeof setVolume === "function") setVolume(value).catch(() => {});
    };
    volume.addEventListener("input", onVolumeInput);
    volume.addEventListener("change", onVolumeInput);
  }

  void initSpotifyPlaybackForPanel(prefix).then(() => restoreSpotifyPlaybackAfterPanelRemount(prefix));
  spotifyApplyViewMode(prefix);
  spotifyApplyNowStateToPanel(prefix);
}

function renderProductivityPanel() {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;
  const prefix = appModePrefix();

  const mount = () => {
    sidePaneEl.hidden = false;
    sidePaneEl.dataset.sidePaneKind = "productivity";
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">Music panel</h3>
        <div class="music-source-toggle" role="tablist" aria-label="Music source">
          <button type="button" class="music-source-tab spotify-source-tab active" id="${prefix}-music-tab-spotify" data-music-source="spotify" aria-selected="true">Spotify</button>
          <button type="button" class="music-source-tab" id="${prefix}-music-tab-builtin" data-music-source="builtin" aria-selected="false">Built-in music</button>
        </div>
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="spotify-panel-body" data-productivity-root="${prefix}" data-music-source="spotify">
      <div class="spotify-now-playing">
        <div class="spotify-art-placeholder" id="${prefix}-spotify-art-placeholder" aria-hidden="true"></div>
        <div class="spotify-track-meta">
          <div class="spotify-track-title" id="${prefix}-spotify-track-title">Nothing playing</div>
          <div class="spotify-track-artist" id="${prefix}-spotify-track-artist">Connect Spotify for in-browser playback, or use search + preview / Open in Spotify.</div>
          <div class="spotify-progress-wrap">
            <span class="spotify-time-text" id="${prefix}-spotify-time-elapsed">0:00</span>
            <input
              type="range"
              class="spotify-progress"
              id="${prefix}-spotify-progress"
              min="0"
              max="0"
              step="250"
              value="0"
              aria-label="Track position"
              disabled
            />
            <span class="spotify-time-text" id="${prefix}-spotify-time-total">0:00</span>
          </div>
        </div>
        <div class="spotify-transport">
          <button type="button" class="spotify-transport-btn" id="${prefix}-spotify-prev" aria-label="Previous">⏮</button>
          <button type="button" class="spotify-transport-btn spotify-play-btn" id="${prefix}-spotify-play" aria-label="Play / pause">▶</button>
          <button type="button" class="spotify-transport-btn" id="${prefix}-spotify-next" aria-label="Next">⏭</button>
          <div class="spotify-volume-wrap" title="Volume">
            <span class="spotify-volume-icon" aria-hidden="true">🔊</span>
            <input type="range" class="spotify-volume" id="${prefix}-spotify-volume" min="0" max="35" step="1" value="10" aria-label="Volume" />
          </div>
        </div>
      </div>
      <div id="${prefix}-spotify-stack" class="music-pane-stack">
        <div id="${prefix}-spotify-view-root" data-spotify-view="search">
          <div class="spotify-connect-row" id="${prefix}-spotify-connect-row">
            <a class="spotify-connect-link" href="#" id="${prefix}-spotify-connect-link">Connect Spotify (Premium)</a>
            <button type="button" class="spotify-logout-btn" id="${prefix}-spotify-logout" hidden>Disconnect</button>
            <span class="spotify-connected-badge" id="${prefix}-spotify-connected-badge" hidden>Connected</span>
          </div>
          <div class="spotify-view-toggle" role="tablist" aria-label="Search and playlists">
            <button type="button" class="spotify-view-tab active" id="${prefix}-spotify-tab-song" data-spotify-view="song" aria-selected="true">Search</button>
            <button type="button" class="spotify-view-tab" id="${prefix}-spotify-tab-playlist" data-spotify-view="playlist" aria-selected="false">Playlist</button>
          </div>
          <form class="spotify-search-form" id="${prefix}-spotify-search-form">
            <input type="search" class="spotify-search-input" id="${prefix}-spotify-search-input" placeholder="Search tracks, artists, albums…" autocomplete="off" />
            <button type="submit" class="spotify-search-submit">Search</button>
          </form>
          <div class="spotify-song-view" id="${prefix}-spotify-song-view">
            <div class="spotify-results" id="${prefix}-spotify-results" role="listbox" aria-label="Search results"></div>
          </div>
          <div class="spotify-playlist-view" id="${prefix}-spotify-playlist-view" hidden>
            <div
              class="spotify-results spotify-playlist-root"
              id="${prefix}-spotify-playlist-root"
              role="listbox"
              aria-label="Your playlists"
            >
              <p class="spotify-results-hint">Open this tab to load your playlists.</p>
            </div>
          </div>
        </div>
        <audio id="${prefix}-spotify-preview-audio" preload="none" crossorigin="anonymous" hidden></audio>
      </div>
      <div id="${prefix}-builtin-stack" class="music-pane-stack" hidden>
        <div class="free-music-pane-inner">
          <p class="free-music-hint" id="${prefix}-free-music-hint"></p>
          <div class="free-music-catalog" id="${prefix}-free-music-catalog"></div>
        </div>
      </div>
      <audio id="${prefix}-free-music-audio" preload="metadata" crossorigin="anonymous" hidden></audio>
    </div>
  `;

    sidePaneEl.scrollTop = 0;
    requestAnimationFrame(() => {
      sidePaneEl.classList.add("visible");
    });
    removeSpotifyMiniButton(prefix);
    wireProductivityPanelEvents(prefix);
  };

  runFlowModeSidePaneContentCrossfade(sidePaneEl, mount);
}

function toggleProductivityPanel() {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;
  const prefix = appModePrefix();
  const btn = document.getElementById(`${prefix}-productivity-mode`);
  if (sidePaneEl.hidden && sidePaneEl.dataset.sidePaneKind === "productivity" && sidePaneEl.innerHTML.trim()) {
    restoreProductivityPanel(prefix);
    return;
  }
  if (!sidePaneEl.hidden && sidePaneEl.dataset.sidePaneKind === "productivity") {
    hideSidePanel();
    return;
  }
  document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));
  renderProductivityPanel();
  btn?.classList.add("is-active");
}

function wireProductivityModeButtons() {
  document.getElementById("vera-productivity-mode")?.addEventListener("click", () => {
    toggleProductivityPanel();
  });
  document.getElementById("bmo-productivity-mode")?.addEventListener("click", () => {
    toggleProductivityPanel();
  });
}

wireProductivityModeButtons();

/* =========================
   WORK MODE — layout + reasoning stream + checklist
========================= */

const WORK_CHECKLIST_STORAGE_KEY = "vera_wm_checklist_v1";
const WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY = "vera_wm_checklist_completed_collapsed_v1";
const VERA_TAB_ACTIVE_USER_KEY = "vera_active_user_tab_v1";
const WORK_LEFT_PANES_LAYOUT_KEY = "vera_wm_left_panes_layout_v1";
const REASONING_TABS_DEFAULT = 3;
const REASONING_TABS_MAX = 8;
const REASONING_UNTITLED_TAB_NAME = "Untitled";
const REASONING_TABS_STATE_STORAGE_KEY_PREFIX = "vera_reasoning_tabs_state_v2";
const WORK_MODE_STATE_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERA_CHAT_STATE_STORAGE_KEY_PREFIX = "vera_chat_state_v1";
let chatStateHydrating = false;
let workChecklistSyncTimer = null;
let workChecklistHydrationPromise = null;
let workChecklistLocalMutationVersion = 0;
let workChecklistSyncInFlight = null;

function markWorkChecklistLocalMutation() {
  workChecklistLocalMutationVersion += 1;
}

function readChecklistItemsFromStorage() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY) || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function queueWorkChecklistSyncToServer() {
  markWorkChecklistLocalMutation();
  if (workChecklistSyncTimer) window.clearTimeout(workChecklistSyncTimer);
  workChecklistSyncTimer = window.setTimeout(async () => {
    workChecklistSyncTimer = null;
    await syncWorkChecklistToServerNow();
  }, 180);
}

async function syncWorkChecklistToServerNow() {
  if (workChecklistSyncInFlight) return workChecklistSyncInFlight;
  workChecklistSyncInFlight = (async () => {
    try {
      const items = readChecklistItemsFromStorage();
      const completedCollapsed = localStorage.getItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY) === "1";
      await fetch(authApiUrl("/api/work-mode/checklist"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: getSessionId(),
          items,
          completed_collapsed: completedCollapsed
        })
      });
    } catch (_) {
      /* ignore */
    } finally {
      workChecklistSyncInFlight = null;
    }
  })();
  return workChecklistSyncInFlight;
}

async function flushWorkChecklistSyncBeforeCommand() {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  if (workChecklistSyncTimer) {
    window.clearTimeout(workChecklistSyncTimer);
    workChecklistSyncTimer = null;
    await syncWorkChecklistToServerNow();
    return;
  }
  if (workChecklistSyncInFlight) await workChecklistSyncInFlight;
}

async function hydrateWorkChecklistFromServer(force = false) {
  if (!force && workChecklistHydrationPromise) return workChecklistHydrationPromise;
  const startVersion = workChecklistLocalMutationVersion;
  workChecklistHydrationPromise = (async () => {
    try {
      const res = await fetch(
        `${authApiUrl("/api/work-mode/checklist")}?session_id=${encodeURIComponent(getSessionId())}`,
        { method: "GET" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.items)) return;
      if (!force && startVersion !== workChecklistLocalMutationVersion) return;
      localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(data.items));
      if (typeof data.completed_collapsed === "boolean") {
        localStorage.setItem(
          WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
          data.completed_collapsed ? "1" : "0"
        );
      }
      loadWorkChecklistItems();
    } catch (_) {
      /* keep local storage fallback */
    }
  })();
  await workChecklistHydrationPromise;
}

/** Same id source as `getSessionId()` for VERA — must never return "" or chat restore/save keys drift apart. */
function ensureVeraSessionIdForPersistence() {
  try {
    let id = getSessionScopedId(VERA_SESSION_STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      setSessionScopedId(VERA_SESSION_STORAGE_KEY, id);
    }
    return id;
  } catch (_) {
    return "";
  }
}

function getVeraChatStateStorageKey() {
  const id = ensureVeraSessionIdForPersistence();
  if (!id) return `${VERA_CHAT_STATE_STORAGE_KEY_PREFIX}:unknown`;
  return `${VERA_CHAT_STATE_STORAGE_KEY_PREFIX}:${id}`;
}

function migrateLegacyVeraChatStorageKey() {
  try {
    const id = ensureVeraSessionIdForPersistence();
    const modern = `${VERA_CHAT_STATE_STORAGE_KEY_PREFIX}:${id}`;
    /* Older builds used an empty session segment when the id had not been created yet. */
    const legacy = `${VERA_CHAT_STATE_STORAGE_KEY_PREFIX}:`;
    const raw = localStorage.getItem(legacy);
    if (raw && !localStorage.getItem(modern)) {
      localStorage.setItem(modern, raw);
    }
  } catch (_) {}
}

function persistVeraClientStateOnUnload() {
  persistVeraChatState();
  persistReasoningTabsState();
}

function persistVeraChatState() {
  if (chatStateHydrating) return;
  const convo = document.getElementById("vera-conversation");
  if (!convo) return;
  const messages = [];
  for (const row of convo.querySelectorAll(".message-row")) {
    const who = row.classList.contains("user") ? "user" : row.classList.contains("vera") ? "vera" : "";
    if (!who) continue;
    const bubble = row.querySelector(".bubble");
    if (!(bubble instanceof HTMLElement)) continue;
    if (bubble.classList.contains("interrupt-preview")) continue;
    // Transient pending-status bubbles ("Searching news…") are not part of
    // chat history. They live only for one in-flight request; on reload the
    // request is gone and the placeholder would have nothing to resolve to.
    if (bubble.classList.contains("vera-pending-status")) continue;
    const text = String(bubble.textContent || "").trim();
    if (!text) continue;
    const replyStage = Number(row.dataset.replyStage || 0);
    const voiceQuote = String(row.dataset.voiceQuoteRef || row.dataset.replyToUserText || "").trim();
    const replyBack =
      replyStage === 2 &&
      (voiceQuote || row.dataset.replyToTurnId || row.dataset.replyToLaneId)
        ? {
            reply_to_user_text: voiceQuote,
            reply_to_turn_id: String(row.dataset.replyToTurnId || "").trim(),
            reply_to_lane_id: String(row.dataset.replyToLaneId || "").trim(),
            reply_to_lane_title: String(row.dataset.replyToLaneTitle || "").trim(),
            stage: 2
          }
        : null;
    messages.push({
      who,
      text,
      ...(replyBack?.reply_to_user_text ? { replyBack } : {})
    });
  }
  const payload = { ts: Date.now(), messages };
  try {
    localStorage.setItem(getVeraChatStateStorageKey(), JSON.stringify(payload));
  } catch (_) {}
}

function restoreVeraChatState() {
  const convo = document.getElementById("vera-conversation");
  if (!convo) return;
  let raw = "";
  try {
    raw = localStorage.getItem(getVeraChatStateStorageKey()) || "";
  } catch (_) {
    return;
  }
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return;
  }
  const ts = Number(parsed?.ts) || 0;
  if (!ts || Date.now() - ts > WORK_MODE_STATE_TTL_MS) {
    try {
      localStorage.removeItem(getVeraChatStateStorageKey());
    } catch (_) {}
    return;
  }
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  if (!messages.length) return;
  chatStateHydrating = true;
  try {
    convo.replaceChildren();
    messages.forEach((m) => {
      const who = m?.who === "user" ? "user" : "vera";
      const text = String(m?.text || "").trim();
      if (!text) return;
      const rb =
        m?.replyBack &&
        typeof m.replyBack === "object" &&
        Number(m.replyBack.stage) === 2 &&
        String(m.replyBack.reply_to_user_text || "").trim()
          ? m.replyBack
          : null;
      addBubble(
        text,
        who,
        rb ? mergeReplyBackIntoBubbleMeta({ path: "restore-chat-state" }, rb) : { path: "restore-chat-state" }
      );
    });
    if (convo.children.length > 0) ensureChatStartedLayout();
  } finally {
    chatStateHydrating = false;
  }
}

function getReasoningTabsStateStorageKey() {
  return `${REASONING_TABS_STATE_STORAGE_KEY_PREFIX}:${getSessionId()}`;
}

function getReasoningPanelCountToEnsure(savedByIdx) {
  if (!(savedByIdx instanceof Map) || savedByIdx.size === 0) return REASONING_TABS_DEFAULT;
  let maxIdx = -1;
  for (const k of savedByIdx.keys()) {
    const n = Number(k);
    if (Number.isFinite(n)) maxIdx = Math.max(maxIdx, n);
  }
  if (maxIdx < 0) return REASONING_TABS_DEFAULT;
  return Math.min(REASONING_TABS_MAX, Math.max(REASONING_TABS_DEFAULT, maxIdx + 1));
}

function getReasoningPanelIndices() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return [0, 1, 2];
  const idxs = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")]
    .map((p) => Number(p.dataset.tabIndex))
    .filter((n) => Number.isFinite(n));
  if (!idxs.length) return [0, 1, 2];
  return idxs.sort((a, b) => a - b);
}

/** After panels are added/removed/rebuilt, keep busy flags aligned with `data-tab-index` keys. */
function syncReasoningLaneBusySlotsAfterDomChange() {
  const idxs = getReasoningPanelIndices();
  const next = new Map();
  for (const i of idxs) {
    next.set(i, Boolean(workModeReasoningLaneBusy.get(i)));
  }
  workModeReasoningLaneBusy.clear();
  for (const [k, v] of next) workModeReasoningLaneBusy.set(k, v);
  syncWorkModeReasoningCancelButton();
}

function getWorkModeReasoningLaneLabel(idx) {
  const i = Number(idx);
  const panel = document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${i}"]`
  );
  const fromDom = String(panel?.dataset?.laneLabel || "").trim();
  if (fromDom) return fromDom;
  const preset = ["Panel 1", "Panel 2", "Panel 3"];
  if (Number.isFinite(i) && i >= 0 && i < preset.length) return preset[i];
  return `Panel ${i + 1}`;
}

function getWorkModeReasoningLaneId(idx) {
  return ensureStableLaneIdForPanelIndex(Number(idx));
}

function createReasoningLanePanel(idx, html = "", isActive = false, tabMeta = {}) {
  const stableLaneId =
    String(tabMeta.laneId || "").trim() || ensureStableLaneIdForPanelIndex(idx);
  const panel = document.createElement("div");
  panel.className = "vera-reasoning-tab-panel";
  if (isActive) panel.classList.add("is-active");
  panel.dataset.tabIndex = String(idx);
  panel.dataset.laneId = stableLaneId;
  panel.dataset.tabTopic = String(tabMeta.topic || REASONING_UNTITLED_TAB_NAME);
  panel.dataset.tabTopicSet = String(tabMeta.topicSet != null ? tabMeta.topicSet : "0");
  panel.dataset.laneLabel = String(tabMeta.laneLabel || `Panel ${Number(idx) + 1}`);
  panel.id = `vera-reasoning-tab-panel-${idx}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-label", `Panel ${idx + 1}`);
  const scroll = document.createElement("div");
  scroll.className = "vera-reasoning-scroll vera-reasoning-md-panel";
  if (idx === 0) scroll.id = "vera-reasoning-md";
  scroll.setAttribute("aria-live", "polite");
  scroll.innerHTML = String(html || "");
  panel.appendChild(scroll);
  return panel;
}

function ensureFixedReasoningLanePanels(savedByIdx = new Map(), activeIdx = 0) {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const count = getReasoningPanelCountToEnsure(savedByIdx);
  panelsRoot.replaceChildren();
  for (let i = 0; i < count; i++) {
    const saved = savedByIdx.get(i) || {};
    const isActive = Number(activeIdx) === i || (i === 0 && (activeIdx == null || activeIdx === ""));
    const panel = createReasoningLanePanel(i, saved.html || "", isActive, {
      topic: saved.topic,
      topicSet: saved.topicSet,
      laneLabel: saved.laneLabel,
      laneId: saved.laneId
    });
    panelsRoot.appendChild(panel);
  }
  syncPanelStableLaneIdsInDom();
  migrateLegacyLaneRegistryKeys();
  syncReasoningLaneBusySlotsAfterDomChange();
}

function getReasoningScrollElByLane(index) {
  const panel = document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${Number(index)}"]`
  );
  return panel?.querySelector(".vera-reasoning-md-panel") || null;
}

/** Snapshot reasoning tabs to localStorage — call only on page unload (see wireReasoningTabStrip). */
function persistReasoningTabsState() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  const payload = {
    ts: Date.now(),
    tabs: panels.map((p) => ({
      idx: Number(p.dataset.tabIndex) || 0,
      laneId: String(p.dataset.laneId || "").trim() || ensureStableLaneIdForPanelIndex(Number(p.dataset.tabIndex) || 0),
      topic: String(p.dataset.tabTopic || REASONING_UNTITLED_TAB_NAME),
      topicSet: String(p.dataset.tabTopicSet || "0"),
      laneLabel: String(p.dataset.laneLabel || "").trim(),
      active: p.classList.contains("is-active"),
      html: (p.querySelector(".vera-reasoning-md-panel") || p.querySelector(".vera-reasoning-scroll"))?.innerHTML || ""
    }))
  };
  try {
    localStorage.setItem(getReasoningTabsStateStorageKey(), JSON.stringify(payload));
  } catch (_) {}
}

function restoreReasoningTabsState() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  let raw = "";
  try {
    raw = localStorage.getItem(getReasoningTabsStateStorageKey()) || "";
  } catch (_) {
    return;
  }
  if (!raw) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs.slice(0, REASONING_TABS_MAX) : [];
  initWorkModeStableLaneIdSlots();
  if (!tabs.length) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const ts = Number(parsed?.ts) || 0;
  if (!ts || Date.now() - ts > WORK_MODE_STATE_TTL_MS) {
    try {
      localStorage.removeItem(getReasoningTabsStateStorageKey());
    } catch (_) {}
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const savedByIdx = new Map();
  let activeIdx = 0;
  tabs.forEach((t) => {
    const idx = Number(t?.idx);
    if (!Number.isFinite(idx) || idx < 0 || idx >= REASONING_TABS_MAX) return;
    if (Boolean(t?.active)) activeIdx = idx;
    const laneId = String(t?.laneId || "").trim() || ensureStableLaneIdForPanelIndex(idx);
    if (laneId) workModeStableLaneIdByIdx[idx] = laneId;
    savedByIdx.set(idx, {
      html: String(t?.html || ""),
      topic: String(t?.topic || REASONING_UNTITLED_TAB_NAME),
      topicSet: String(t?.topicSet != null ? t.topicSet : "0"),
      laneLabel: String(t?.laneLabel || "").trim() || undefined,
      laneId
    });
  });
  ensureFixedReasoningLanePanels(savedByIdx, activeIdx);
}

function getActiveReasoningScrollEl() {
  const p = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active .vera-reasoning-md-panel");
  if (p) return p;
  return document.getElementById("vera-reasoning-md");
}

/** Each assistant reasoning run appends a new block inside the active space (scroll container). */
function appendReasoningTurnMount(scrollEl) {
  let el = scrollEl;
  if (!el) {
    el = document.getElementById("vera-reasoning-md");
    if (!el) return null;
  }
  if (el.querySelector(".vera-reasoning-turn")) {
    const sep = document.createElement("div");
    sep.className = "vera-reasoning-turn-sep";
    const hr = document.createElement("hr");
    hr.className = "vera-reasoning-turn-hr";
    hr.setAttribute("aria-hidden", "true");
    sep.appendChild(hr);
    el.appendChild(sep);
  }
  const turn = document.createElement("div");
  turn.className = "vera-reasoning-turn";
  el.appendChild(turn);
  return turn;
}

/** Tab / panel titles safe to replace with LLM or heuristic (user-defined titles stay). */
function isGenericAutoRenamableReasoningPanelTitle(s) {
  const t = String(s || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!t) return true;
  if (/^panel\s+\d+$/i.test(t)) return true;
  if (t.toLowerCase() === String(REASONING_UNTITLED_TAB_NAME).toLowerCase()) return true;
  if (/^new\s+panel$/i.test(t)) return true;
  return false;
}

function getReasoningTabTopicLabel(panel) {
  const laneLabel = String(panel?.dataset?.laneLabel || "").trim();
  const topic = String(panel?.dataset?.tabTopic || "").trim();
  const laneOk = laneLabel && !isGenericAutoRenamableReasoningPanelTitle(laneLabel);
  const topicOk = topic && !isGenericAutoRenamableReasoningPanelTitle(topic);
  if (laneOk) return laneLabel;
  if (topicOk) return topic;
  if (laneLabel) return laneLabel;
  return topic || REASONING_UNTITLED_TAB_NAME;
}

function toTitleCaseWord(w) {
  if (!w) return "";
  if (/^[A-Z0-9]{2,}$/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** Skip headings / tab titles that are generic assistant filler, not the task topic. */
function isBanalReasoningTopicLabel(s) {
  const t = String(s || "")
    .toLowerCase()
    .replace(/[—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  if (/^(yes|yeah|yep|sure|ok|okay|absolutely)\b/.test(t)) return true;
  if (/\b(i can help|i'll help|i will help|happy to help|let me help|here to help)\b/.test(t)) return true;
  if (/\b(work through it|help you work|walk you through)\b/.test(t) && t.split(/\s+/).length <= 8) return true;
  return false;
}

function compactTopicPhrase(text, maxWords = 4) {
  const raw = String(text || "")
    .replace(/[`*_#>[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const withoutLead = raw
    .replace(/^(here(?:'s| is)\s+)?(?:an?\s+)?(?:short\s+)?example(?:\s+of)?[:\-\s]*/i, "")
    .trim();
  const candidate = withoutLead || raw;
  const words = candidate.match(/[A-Za-z0-9][A-Za-z0-9'+-]*/g) || [];
  if (!words.length) return "";
  const badEdge = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "being", "been", "to", "of", "and", "or",
    "for", "with", "in", "on", "at", "from", "by", "as", "that", "this"
  ]);
  let start = 0;
  let end = words.length;
  while (start < end && badEdge.has(words[start].toLowerCase())) start += 1;
  while (end > start && badEdge.has(words[end - 1].toLowerCase())) end -= 1;
  const core = words.slice(start, end).slice(0, maxWords);
  if (!core.length) return "";
  const out = core.map((w) => toTitleCaseWord(w)).join(" ");
  if (isBanalReasoningTopicLabel(out)) return "";
  return out;
}

function keywordTopicFromText(text, maxWords = 4) {
  const tokens = (String(text || "").toLowerCase().match(/[a-z][a-z0-9'+-]*/g) || []);
  if (!tokens.length) return "";
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "show", "example",
    "short", "here", "there", "what", "when", "where", "which", "about", "have", "has", "had", "can",
    "could", "would", "should", "step", "steps", "then", "than", "just", "more", "most", "some", "any",
    "using", "use", "used", "also", "very", "much", "into", "onto", "over", "under",
    "yes", "yeah", "yep", "sure", "help", "i'll", "okay", "ok"
  ]);
  const counts = new Map();
  const firstPos = new Map();
  tokens.forEach((t, i) => {
    if (t.length < 3 || stop.has(t)) return;
    if (!firstPos.has(t)) firstPos.set(t, i);
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  const ranked = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || ((firstPos.get(a[0]) || 0) - (firstPos.get(b[0]) || 0)))
    .slice(0, maxWords)
    .map(([t]) => toTitleCaseWord(t));
  return ranked.join(" ");
}

function extractMarkdownBoldStandaloneTitle(markdownText) {
  const lines = String(markdownText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^\*{2}([^*]+)\*{2}\s*$/);
    if (!m) continue;
    const inner = String(m[1] || "").trim();
    if (inner.length < 6 || inner.length > 160) continue;
    if (isBanalReasoningTopicLabel(inner)) continue;
    const t = compactTopicPhrase(inner, 6);
    if (t) return t;
  }
  return "";
}

/** First substantive non-heading, non-list line (e.g. "Delta-Hedging a Short 45-Strike Call"). */
function extractFirstTitleLikeMarkdownLine(markdownText) {
  const lines = String(markdownText || "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) continue;
    if (/^>{1,3}\s+/.test(line)) continue;
    if (line.length < 12 || line.length > 160) continue;
    let cleaned = line.replace(/^\*{1,2}|\*{1,2}$/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
    if (cleaned.length < 12) continue;
    if (isBanalReasoningTopicLabel(cleaned)) continue;
    const t = compactTopicPhrase(cleaned, 10);
    if (t && t.length >= 6) return t;
  }
  return "";
}

function normalizeMarkdownLeadForHeadingExtract(markdown) {
  return String(markdown || "")
    .replace(/^\uFEFF/, "")
    .replace(/^[\u200B-\u200D\uFEFF]+/, "")
    .trimStart();
}

/**
 * First line / start of markdown begins with `#` → lane/tab title (handles heading + body on one line).
 * @returns {{ extracted_heading: string, extraction_rejected_reason: string, md_first_200: string, starts_with_hash: boolean }}
 */
function diagnoseLeadingMarkdownHeadingExtraction(markdown) {
  const mdNorm = normalizeMarkdownLeadForHeadingExtract(markdown);
  const md_first_200 = mdNorm.slice(0, 200);
  const starts_with_hash = mdNorm.startsWith("#");
  const fail = (reason) => ({
    extracted_heading: "",
    extraction_rejected_reason: reason,
    md_first_200,
    starts_with_hash
  });
  if (!mdNorm) return fail("empty_markdown");
  if (!starts_with_hash) return fail("does_not_start_with_hash_after_trimStart");
  const firstLine = mdNorm.split("\n")[0].trim();
  const m = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (!m) return fail("first_line_not_hash_heading_pattern");
  let rest = String(m[1] || "").trim();
  if (rest.includes(" ## ")) rest = rest.split(/\s+##\s+/)[0].trim();
  rest = rest.replace(/\s+#+\s*$/, "").trim();
  const mashLong = rest.match(
    /^(.+?)\s+The\s+[A-Z][a-z]+(?:\s+[a-zA-Z'’-]+){0,8}\s+(?:was|is|are|has|had|were|became)\b/i
  );
  if (mashLong) rest = mashLong[1].trim();
  else {
    const mashIt = rest.match(/^(.+?)\s+It\s+was\b/i);
    if (mashIt) rest = mashIt[1].trim();
    else {
      const mashDup = rest.match(/^(.+?)\s+The\s+(.+?)\s+(?:was|is|are)\b/i);
      if (mashDup) {
        const a = mashDup[1].trim().toLowerCase();
        const b = mashDup[2].trim().toLowerCase();
        if (b.startsWith(a) || a === b) rest = mashDup[1].trim();
      }
    }
  }
  rest = rest.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  rest = rest.replace(/\s+/g, " ").trim();
  if (rest.length < 2) return fail("heading_text_too_short_after_parse");
  let titled = rest;
  const wordCount = rest.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) {
    titled =
      compactTopicPhrase(rest, 6) ||
      rest
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
        .trim();
  }
  if (!titled || isBanalReasoningTopicLabel(titled)) return fail("banal_or_empty_topic_label");
  const out = sanitizeLlmReasoningPanelTitle(titled);
  if (!out) return fail("sanitizeLlmReasoningPanelTitle_empty");
  return {
    extracted_heading: out,
    extraction_rejected_reason: "",
    md_first_200,
    starts_with_hash: true
  };
}

function extractLeadingMarkdownHeadingAsLaneTitle(markdown) {
  return diagnoseLeadingMarkdownHeadingExtraction(markdown).extracted_heading || "";
}

function logHeadingTitleExtractAttempt(laneId, oldTitle, mdSource, markdown) {
  const diag = diagnoseLeadingMarkdownHeadingExtraction(markdown);
  try {
    console.info("[heading_title_extract_attempt]", {
      lane_id: laneId ?? null,
      old_title: String(oldTitle ?? ""),
      old_title_is_generic: isGenericAutoRenamableReasoningPanelTitle(oldTitle),
      md_source: mdSource,
      md_first_200: diag.md_first_200,
      starts_with_hash: diag.starts_with_hash,
      extracted_heading: diag.extracted_heading || "",
      extraction_rejected_reason: diag.extraction_rejected_reason || ""
    });
  } catch (_) {}
  return diag;
}

/**
 * If lane title is generic and markdown has a leading # heading, sync registry + tab DOM.
 * @returns {{ applied: boolean, allowed: boolean, reason: string, extracted_heading: string }}
 */
function maybeSyncGenericLaneTitleFromMarkdown(laneId, markdown, calledFrom) {
  const lid = String(laneId || "").trim();
  const source = String(calledFrom || "maybeSyncGenericLaneTitleFromMarkdown").trim();
  const panel = lid ? getReasoningPanelElementByLaneId(lid) : null;
  const regBefore = lid ? getWorkModeLaneHandoff(lid) : null;
  const oldFromDom = panel instanceof HTMLElement ? String(getReasoningTabTopicLabel(panel) || "").trim() : "";
  const oldFromReg = String(regBefore?.title || regBefore?.lane_title || "").trim();
  const oldTitle = oldFromDom || oldFromReg || (lid ? getWorkModeLaneTitle(lid) : "");
  const before_registry_title = oldFromReg || oldTitle;

  const mdRaw = String(markdown || "").trim();
  const mdSource = mdRaw ? "main_excerpt" : "none";
  const diag = logHeadingTitleExtractAttempt(lid, oldTitle, mdSource, mdRaw);
  const extracted = diag.extracted_heading || "";

  let allowed = false;
  let reason = "not_attempted";
  if (!lid) reason = "no_lane_id";
  else if (!extracted) reason = diag.extraction_rejected_reason || "extract_empty";
  else if (!isGenericAutoRenamableReasoningPanelTitle(oldTitle)) {
    reason = "old_title_not_generic_auto_renamable";
  } else {
    allowed = true;
    reason = "heading_sync_apply";
  }

  let domSynced = false;
  let after_registry_title = before_registry_title;

  if (allowed && extracted) {
    const row = regBefore || { lane_id: lid, active_lane_id: lid };
    setWorkModeLaneHandoff(
      lid,
      {
        ...row,
        lane_id: lid,
        active_lane_id: lid,
        title: extracted,
        lane_title: extracted
      },
      { source: `heading_title_sync:${source}`, forceSubstantive: false }
    );
  }

  const regAfter = lid ? getWorkModeLaneHandoff(lid) : null;
  after_registry_title = String(regAfter?.title || regAfter?.lane_title || "").trim() || before_registry_title;

  const panelAfter = lid ? getReasoningPanelElementByLaneId(lid) : null;
  if (allowed && extracted && panelAfter instanceof HTMLElement) {
    panelAfter.dataset.laneLabel = extracted;
    panelAfter.dataset.tabTopic = extracted;
    panelAfter.dataset.tabTopicSet = "1";
    panelAfter.dataset.reasoningLlmTitleDone = "1";
    renderReasoningTabStrip();
    try {
      persistReasoningTabsState();
    } catch (_) {}
    domSynced = true;
  } else if (allowed && extracted && !(panelAfter instanceof HTMLElement)) {
    reason = `${reason};no_panel_dom`;
  }

  const tab_text_after =
    panelAfter instanceof HTMLElement ? String(getReasoningTabTopicLabel(panelAfter) || "").trim() : "(no_panel)";

  try {
    console.info("[heading_title_apply_attempt]", {
      lane_id: lid || null,
      old_title: oldTitle,
      extracted_heading: extracted || "",
      allowed,
      reason,
      before_registry_title,
      after_registry_title,
      dom_synced: domSynced,
      tab_text_after,
      panel_dataset_lane_label_after:
        panelAfter instanceof HTMLElement ? String(panelAfter.dataset.laneLabel || "").trim() : "",
      panel_dataset_tab_topic_after:
        panelAfter instanceof HTMLElement ? String(panelAfter.dataset.tabTopic || "").trim() : "",
      called_from: source
    });
  } catch (_) {}

  return {
    applied: allowed && Boolean(extracted) && after_registry_title === extracted,
    allowed,
    reason,
    extracted_heading: extracted
  };
}

function buildReasoningTopicLabel({ summaryText = "", markdownText = "", userPrompt = "" } = {}) {
  const md = String(markdownText || "");
  const headingLines = md
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());
  for (const h of headingLines) {
    if (isBanalReasoningTopicLabel(h)) continue;
    const t = compactTopicPhrase(h, 4);
    if (t) return t;
  }
  const boldTitle = extractMarkdownBoldStandaloneTitle(md);
  if (boldTitle) return boldTitle;
  const firstLineTitle = extractFirstTitleLikeMarkdownLine(md);
  if (firstLineTitle) return firstLineTitle;
  const keywordTopic = keywordTopicFromText(`${summaryText}\n${markdownText}`, 4);
  if (keywordTopic && !isBanalReasoningTopicLabel(keywordTopic)) return keywordTopic;
  const summaryTopic = compactTopicPhrase(summaryText, 4);
  if (summaryTopic && !isBanalReasoningTopicLabel(summaryTopic)) return summaryTopic;
  const promptTopic = compactTopicPhrase(userPrompt, 4);
  if (promptTopic && !isBanalReasoningTopicLabel(promptTopic)) return promptTopic;
  return "";
}

function readPersistedReasoningTabSnapshotForLane(laneId, tabIndex) {
  let localStorage_laneLabel = "(unread)";
  let localStorage_topic = "(unread)";
  let localStorage_title = "(unread)";
  try {
    const raw = localStorage.getItem(getReasoningTabsStateStorageKey());
    if (!raw || !String(raw).trim()) {
      return { localStorage_laneLabel: "(none)", localStorage_topic: "(none)", localStorage_title: "(empty_store)" };
    }
    const parsed = JSON.parse(raw);
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    const lid = String(laneId || "").trim();
    let row = lid ? tabs.find((x) => String(x?.laneId || "").trim() === lid) : null;
    if (!row && tabIndex != null && Number.isFinite(Number(tabIndex))) {
      row = tabs.find((x) => Number(x?.idx) === Number(tabIndex));
    }
    if (!row) {
      return {
        localStorage_laneLabel: "(no_matching_tab)",
        localStorage_topic: "(no_matching_tab)",
        localStorage_title: "(no_matching_tab)"
      };
    }
    localStorage_laneLabel = String(row?.laneLabel || "").trim() || "(empty)";
    localStorage_topic = String(row?.topic || "").trim() || "(empty)";
    localStorage_title = `laneLabel=${localStorage_laneLabel}; topic=${localStorage_topic}`;
  } catch (_) {
    localStorage_title = "(localStorage_parse_failed)";
    localStorage_laneLabel = "(error)";
    localStorage_topic = "(error)";
  }
  return { localStorage_laneLabel, localStorage_topic, localStorage_title };
}

function reasoningTitleCandidateDebugLog(panel, blob) {
  try {
    const p = panel instanceof HTMLElement ? panel : null;
    const eff = p ? String(getReasoningTabTopicLabel(p) || "").trim() : "";
    console.info("[reasoning_title_candidate]", {
      turn_id: blob.turn_id ?? null,
      lane_id:
        (p ? String(p.dataset.laneId || "").trim() : String(blob.lane_id ?? "").trim()) || null,
      old_lane_label: p ? String(p.dataset.laneLabel || "").trim() : "",
      old_tab_topic: p ? String(p.dataset.tabTopic || "").trim() : "",
      effective_old_title: eff,
      is_generic_auto_renamable: p ? isGenericAutoRenamableReasoningPanelTitle(eff) : false,
      candidate_title: blob.candidate_title ?? "",
      candidate_source: blob.candidate_source ?? "",
      called_from: blob.called_from ?? "",
      ...(blob.extra && typeof blob.extra === "object" ? blob.extra : {})
    });
  } catch (_) {}
}

function reasoningTitleUpdateDebugLog(lane_id, old_title, new_title, allowed, reason) {
  try {
    console.info("[reasoning_title_update]", {
      lane_id: lane_id ?? null,
      old_title: String(old_title ?? ""),
      new_title: String(new_title ?? ""),
      allowed: Boolean(allowed),
      reason: String(reason || "")
    });
  } catch (_) {}
}

function reasoningLaneTitleSyncDebugLog(panel) {
  try {
    if (!(panel instanceof HTMLElement)) return;
    try {
      persistReasoningTabsState();
    } catch (_) {}
    const lane_id = String(panel.dataset.laneId || "").trim() || null;
    const idx = Number(panel.dataset.tabIndex);
    const tab_text = String(getReasoningTabTopicLabel(panel) || "").trim();
    const reg = lane_id ? getWorkModeLaneHandoff(lane_id) : null;
    const persisted = readPersistedReasoningTabSnapshotForLane(lane_id, idx);
    console.info("[lane_title_sync]", {
      lane_id,
      registry_title: String(reg?.title || reg?.lane_title || "").trim() || "(none)",
      tab_text,
      panel_dataset_lane_label: String(panel.dataset.laneLabel || "").trim(),
      panel_dataset_tab_topic: String(panel.dataset.tabTopic || "").trim(),
      localStorage_title: persisted.localStorage_title
    });
  } catch (_) {}
}

function reasoningLlmTitleQueueDecision(panel) {
  if (!(panel instanceof HTMLElement)) {
    return { ok: false, reason: "not_html_element", effective_title: "", detail: {} };
  }
  if (!isVeraWorkModeOn()) {
    return { ok: false, reason: "work_mode_off", effective_title: "", detail: {} };
  }
  if (panel.dataset.reasoningLlmTitleDone === "1") {
    return { ok: false, reason: "reasoningLlmTitleDone_set", effective_title: "", detail: {} };
  }
  const effective_title = String(getReasoningTabTopicLabel(panel) || "").trim();
  if (!isGenericAutoRenamableReasoningPanelTitle(effective_title)) {
    return {
      ok: false,
      reason: "effective_title_not_generic_auto_renamable",
      effective_title,
      detail: {
        reasoningLlmTitleDone: panel.dataset.reasoningLlmTitleDone || "",
        tabTopicSet: panel.dataset.tabTopicSet || ""
      }
    };
  }
  return { ok: true, reason: "eligible_for_llm_title_queue", effective_title, detail: {} };
}

function setReasoningTabTopicFromFinal(turnEl, opts = {}) {
  const calledFrom = String(opts.calledFrom ?? opts.called_from ?? "wm.reasoning_title.unknown_path").trim();
  const turnId = opts?.turnId ?? opts?.turn_id ?? null;
  try {
    console.info("[reasoning_title_path]", {
      phase: "setReasoningTabTopicFromFinal_enter",
      called_from: calledFrom,
      turn_id: turnId
    });
  } catch (_) {}

  if (!turnEl) {
    reasoningTitleCandidateDebugLog(null, {
      turn_id: turnId,
      lane_id: null,
      candidate_title: "",
      candidate_source: "(none)",
      called_from: `${calledFrom}.skip_no_turnEl`,
      extra: { note: "turnEl falsy — title path never ran" }
    });
    reasoningTitleUpdateDebugLog(null, "(n/a)", "(n/a)", false, "skip_heuristic_missing_turn_el");
    return;
  }

  const panel = turnEl.closest(".vera-reasoning-tab-panel");
  if (!(panel instanceof HTMLElement)) {
    reasoningTitleCandidateDebugLog(null, {
      turn_id: turnId,
      lane_id: null,
      candidate_title: "",
      candidate_source: "(none)",
      called_from: `${calledFrom}.skip_no_parent_panel`,
      extra: { note: ".closest vera-reasoning-tab-panel missing" }
    });
    reasoningTitleUpdateDebugLog(null, "(n/a)", "(n/a)", false, "skip_heuristic_turn_not_inside_tab_panel");
    return;
  }

  const laneId = String(panel.dataset.laneId || "").trim();
  const display = String(getReasoningTabTopicLabel(panel) || "").trim();
  if (!isGenericAutoRenamableReasoningPanelTitle(display)) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: turnId,
      candidate_title: "",
      candidate_source: "heuristic_blocked_precheck",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(
      laneId || null,
      display,
      "",
      false,
      "skip_effective_title_not_generic_auto_renamable"
    );
    return;
  }

  const topic = buildReasoningTopicLabel(opts);
  if (!topic) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: turnId,
      candidate_title: "",
      candidate_source: "heuristic_failed_no_candidate_from_content",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(
      laneId || null,
      display,
      "",
      false,
      "skip_heuristic_buildReasoningTopicLabel_empty"
    );
    return;
  }

  reasoningTitleCandidateDebugLog(panel, {
    turn_id: turnId,
    candidate_title: topic,
    candidate_source: "heuristic_from_stream_labels",
    called_from
  });

  reasoningTitleUpdateDebugLog(laneId || null, display, topic, true, "applied_heuristic_to_dom_and_registry");

  panel.dataset.laneLabel = topic;
  panel.dataset.tabTopic = topic;
  panel.dataset.tabTopicSet = "1";
  try {
    patchReasoningLaneRegistryTitle(laneId, topic, `heuristic_from_stream:${calledFrom}`);
  } catch (_) {}
  renderReasoningTabStrip();
  try {
    persistReasoningTabsState();
  } catch (_) {}
  reasoningLaneTitleSyncDebugLog(panel);
}

function isDefaultWorkModeReasoningPanelLaneLabel(label) {
  return isGenericAutoRenamableReasoningPanelTitle(label);
}

function sanitizeLlmReasoningPanelTitle(s) {
  let t = String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (t.length > 42) {
    const cut = t.slice(0, 42).replace(/\s+\S*$/, "").trim();
    t = cut || t.slice(0, 42).trim();
  }
  return t;
}

/** Same order idea as auth: local override / localhost first, then public worker (see `localBackendBase`). */
function veraWorkModeBackendBasesInTryOrder() {
  const bases = [];
  const push = (u) => {
    const x = String(u || "").replace(/\/$/, "").trim();
    if (x && !bases.includes(x)) bases.push(x);
  };
  try {
    if (typeof localBackendBase === "function") push(localBackendBase());
  } catch (_) {}
  push(API_URL);
  return bases.length ? bases : [String(API_URL).replace(/\/$/, "")];
}

async function fetchReasoningPanelTitleLlm(userPrompt, md, summ) {
  const body = JSON.stringify({
    session_id: getSessionId(),
    user_prompt: String(userPrompt || "").trim(),
    markdown_excerpt: String(md || "").trim().slice(0, 12000),
    summary_excerpt: String(summ || "").trim().slice(0, 2500)
  });
  for (const base of veraWorkModeBackendBasesInTryOrder()) {
    try {
      const res = await fetch(`${base}/work_mode/reasoning_panel_title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (!res.ok) continue;
      const j = await res.json().catch(() => ({}));
      const title = sanitizeLlmReasoningPanelTitle(String(j?.title || ""));
      if (title && !isBanalReasoningTopicLabel(title)) return title;
    } catch (_) {}
  }
  return null;
}

function heuristicReasoningPanelTitle(userPrompt, md, summ) {
  const up = String(userPrompt || "").trim();
  const mdS = String(md || "").trim();
  const sm = String(summ || "").trim();
  let t = buildReasoningTopicLabel({
    summaryText: sm,
    markdownText: mdS,
    userPrompt: up
  });
  let s = sanitizeLlmReasoningPanelTitle(t);
  if (!s || isBanalReasoningTopicLabel(s)) {
    s = sanitizeLlmReasoningPanelTitle(compactTopicPhrase(`${sm}\n${mdS}\n${up}`, 5));
  }
  if (!s || isBanalReasoningTopicLabel(s)) return "";
  return s;
}

function shouldQueueLlmReasoningPanelTitle(panel) {
  return reasoningLlmTitleQueueDecision(panel).ok;
}

/** After substantive reasoning NDJSON completes, optionally refresh tab via LLM / heuristic fallback. */
function queueLlmReasoningPanelTitleAfterFirstCompletedTurn(panel, opts = {}) {
  const calledFrom =
    String(opts.calledFrom ?? opts.called_from ?? "wm.reasoning_title.queue_unknown").trim() ||
    "wm.reasoning_title.queue_unknown";
  const tid = opts.turnId ?? opts.turn_id ?? null;
  const up0 = String(opts.userPrompt ?? "").trim();
  const md0 = String(opts.markdownText ?? "").trim();
  const summ0 = String(opts.summaryText ?? "").trim();

  if (!(panel instanceof HTMLElement)) {
    reasoningTitleCandidateDebugLog(null, {
      turn_id: tid,
      lane_id: null,
      candidate_title: "",
      candidate_source: "queue_skipped_no_panel",
      called_from: `${calledFrom}`,
      extra: { note: "panel not an HTMLElement — queue never ran" }
    });
    reasoningTitleUpdateDebugLog(null, "", "", false, "queue_skip_panel_not_html_element");
    return;
  }

  const laneRef = String(panel.dataset.laneId || "").trim();

  const qc = reasoningLlmTitleQueueDecision(panel);
  if (!qc.ok) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: tid,
      candidate_title: "",
      candidate_source: "queue_blocked_precheck",
      called_from,
      extra: {
        blocking_reason: qc.reason,
        effective_title_seen: qc.effective_title,
        ...(qc.detail || {})
      }
    });
    reasoningTitleUpdateDebugLog(
      laneRef || null,
      String(qc.effective_title || getReasoningTabTopicLabel(panel) || "").trim(),
      "",
      false,
      `skip_llm_title_queue:${qc.reason}`
    );
    return;
  }

  const effectiveAtEntry = qc.effective_title;

  if (panel.dataset.reasoningLlmTitleInFlight === "1") {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: tid,
      candidate_title: "",
      candidate_source: "queue_blocked_in_flight",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(
      laneRef || null,
      effectiveAtEntry,
      "",
      false,
      "skip_llm_title_queue_reasoningLlmTitleInFlight"
    );
    return;
  }

  const idx = Number(panel.dataset.tabIndex);
  if (!Number.isFinite(idx)) {
    reasoningTitleUpdateDebugLog(
      laneRef || null,
      effectiveAtEntry,
      "",
      false,
      "skip_llm_title_queue_invalid_panel_tab_index"
    );
    return;
  }

  if (!up0 && !md0 && !summ0) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: tid,
      candidate_title: "",
      candidate_source: "queue_skipped_empty_inputs",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(laneRef || null, effectiveAtEntry, "", false, "skip_llm_title_queue_empty_content_inputs");
    return;
  }

  try {
    console.info("[reasoning_title_path]", {
      phase: "queueLlmReasoningPanelTitleAfterFirstCompletedTurn_enter",
      called_from: calledFrom,
      turn_id: tid
    });
  } catch (_) {}

  reasoningTitleCandidateDebugLog(panel, {
    turn_id: tid,
    candidate_title: "(async_fetch_pending)",
    candidate_source: "llm_then_heuristic_queued",
    called_from,
    extra: { input_lens: { userPrompt: up0.length, markdown: md0.length, summary: summ0.length } }
  });

  panel.dataset.reasoningLlmTitleInFlight = "1";

  void (async () => {
    let chosenSource = "none";
    try {
      let title = (await fetchReasoningPanelTitleLlm(up0, md0, summ0)) || null;
      if (title) chosenSource = "llm_reasoning_panel_title_endpoint";
      if (!title) {
        title = heuristicReasoningPanelTitle(up0, md0, summ0);
        if (title) chosenSource = "heuristic_fallback_inside_queue";
      }

      const cur = document.querySelector(
        `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
      );

      if (!title) {
        const effStale = cur instanceof HTMLElement
          ? String(getReasoningTabTopicLabel(cur) || "").trim()
          : effectiveAtEntry;
        reasoningTitleCandidateDebugLog(panel, {
          turn_id: tid,
          candidate_title: "",
          candidate_source: "(none)",
          called_from: `${calledFrom}.fetch_complete`,
          extra: { outcome: "no_title_from_llm_or_heuristic" }
        });
        reasoningTitleUpdateDebugLog(laneRef || null, effStale, "", false, "no_title_from_llm_or_heuristic");
        return;
      }

      if (!(cur instanceof HTMLElement)) {
        reasoningTitleUpdateDebugLog(
          laneRef || null,
          effectiveAtEntry,
          title,
          false,
          "queue_abort_panel_removed_from_dom_before_apply"
        );
        return;
      }

      reasoningTitleCandidateDebugLog(cur, {
        turn_id: tid,
        candidate_title: title,
        candidate_source: chosenSource,
        called_from: `${calledFrom}.candidate_ready`,
      });

      if (cur.dataset.reasoningLlmTitleDone === "1") {
        const curDisplayBlocked = String(getReasoningTabTopicLabel(cur) || "").trim();
        reasoningTitleUpdateDebugLog(
          String(cur.dataset.laneId || "").trim() || null,
          curDisplayBlocked,
          title,
          false,
          "skip_apply_reasoningLlmTitleDone_race_mid_queue"
        );
        return;
      }

      const curDisplay = String(getReasoningTabTopicLabel(cur) || "").trim();
      if (!isGenericAutoRenamableReasoningPanelTitle(curDisplay)) {
        reasoningTitleUpdateDebugLog(
          String(cur.dataset.laneId || "").trim() || null,
          curDisplay,
          title,
          false,
          "title_locked_non_generic_after_stream_heuristic_may_have_renamed_panel"
        );
        return;
      }

      reasoningTitleUpdateDebugLog(
        String(cur.dataset.laneId || "").trim() || null,
        curDisplay,
        title,
        true,
        `applied_${chosenSource}`
      );

      cur.dataset.reasoningLlmTitleDone = "1";
      cur.dataset.laneLabel = title;
      cur.dataset.tabTopic = title;
      cur.dataset.tabTopicSet = "1";
      try {
        patchReasoningLaneRegistryTitle(
          String(cur.dataset.laneId || "").trim(),
          title,
          `llm_panel_title:${chosenSource}:${calledFrom}`
        );
      } catch (_) {}
      renderReasoningTabStrip();
      try {
        persistReasoningTabsState();
      } catch (_) {}
      reasoningLaneTitleSyncDebugLog(cur);
    } catch (_) {
      reasoningTitleUpdateDebugLog(laneRef || null, effectiveAtEntry, "", false, "llm_title_queue_async_throw");
    } finally {
      const curFinish = document.querySelector(
        `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
      );
      if (curFinish instanceof HTMLElement) curFinish.dataset.reasoningLlmTitleInFlight = "";
    }
  })();
}

function renderReasoningTabStrip() {
  const tabsEl = document.getElementById("vera-reasoning-tabs");
  const addBtn = document.getElementById("vera-reasoning-tab-add");
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!tabsEl || !panelsRoot) return;
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  tabsEl.replaceChildren();
  panels.forEach((panel, i) => {
    const idx = Number(panel.dataset.tabIndex);
    const slot = document.createElement("div");
    slot.className =
      "vera-reasoning-tab-slot" + (panel.classList.contains("is-active") ? " is-active" : "");
    const tabBtn = document.createElement("button");
    tabBtn.type = "button";
    tabBtn.className = "vera-reasoning-tab";
    tabBtn.setAttribute("role", "tab");
    tabBtn.setAttribute("aria-selected", panel.classList.contains("is-active") ? "true" : "false");
    tabBtn.dataset.tabIndex = String(idx);
    const tabLabel = getReasoningTabTopicLabel(panel);
    tabBtn.title = tabLabel;
    const label = document.createElement("span");
    label.className = "vera-reasoning-tab-label";
    label.textContent = tabLabel;
    tabBtn.appendChild(label);
    slot.appendChild(tabBtn);
    if (panels.length > REASONING_TABS_DEFAULT) {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "vera-reasoning-tab-close";
      closeBtn.dataset.tabIndex = String(idx);
      closeBtn.setAttribute("aria-label", `Close ${tabLabel}`);
      closeBtn.title = "Close this reasoning space";
      closeBtn.textContent = "×";
      slot.appendChild(closeBtn);
    }
    tabsEl.appendChild(slot);
  });
  if (addBtn) {
    const atMax = panels.length >= REASONING_TABS_MAX;
    addBtn.hidden = atMax;
    addBtn.setAttribute(
      "aria-label",
      atMax ? "Maximum reasoning spaces (8)" : `Add reasoning space (${panels.length} of ${REASONING_TABS_MAX})`
    );
    addBtn.title = atMax ? "Maximum 8 spaces" : `Add space (up to ${REASONING_TABS_MAX})`;
  }
}

function activateReasoningTab(index) {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").forEach((p) => {
    p.classList.toggle("is-active", Number(p.dataset.tabIndex) === index);
  });
  setFocusedWorkModeLaneFromIndex(index);
  renderReasoningTabStrip();
  syncWorkModeReasoningCancelButton();
}

function addReasoningTab() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  if (panels.length >= REASONING_TABS_MAX) return;
  const maxIdx = panels.reduce((m, p) => Math.max(m, Number(p.dataset.tabIndex) || 0), -1);
  const idx = maxIdx + 1;
  panels.forEach((p) => p.classList.remove("is-active"));
  const panel = createReasoningLanePanel(idx, "", true, {
    laneLabel: `Panel ${idx + 1}`
  });
  panelsRoot.appendChild(panel);
  syncReasoningLaneBusySlotsAfterDomChange();
  renderReasoningTabStrip();
}

function closeReasoningTab(index) {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  if (panels.length <= REASONING_TABS_DEFAULT) return;
  const victim = panels.find((p) => Number(p.dataset.tabIndex) === index);
  if (!victim) return;
  const laneIdx = Number(index);
  const ctl = workModeReasoningAbortControllers.get(laneIdx);
  if (ctl) {
    try {
      ctl.abort();
    } catch (_) {}
    workModeReasoningAbortControllers.delete(laneIdx);
  }
  workModeReasoningLaneBusy.delete(laneIdx);
  laneReasoningChainTail.delete(laneIdx);
  // Drop any pending follow-ups attached to the removed panel — they have
  // no UI host left and the originating lane index is going away.
  workModeReasoningPanelFollowUpQueue.delete(laneIdx);
  const wasActive = victim.classList.contains("is-active");
  victim.remove();
  if (wasActive) {
    const rest = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
    rest[0]?.classList.add("is-active");
  }
  syncReasoningLaneBusySlotsAfterDomChange();
  renderReasoningTabStrip();
}

function wireReasoningTabStrip() {
  wireReasoningMarkdownCodeCopy();
  const tabsEl = document.getElementById("vera-reasoning-tabs");
  const addBtn = document.getElementById("vera-reasoning-tab-add");
  if (!tabsEl || tabsEl.dataset.wiredReasoningTabs === "1") return;
  if (!document.getElementById("vera-reasoning-tab-panels")) return;
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  restoreReasoningTabsState();
  if (panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length === 0) {
    ensureFixedReasoningLanePanels(new Map(), 0);
  }
  panelsRoot?.querySelectorAll(".vera-reasoning-tab-panel").forEach((panel) => {
    if (!String(panel.dataset.laneLabel || "").trim()) {
      panel.dataset.laneLabel = getWorkModeReasoningLaneLabel(Number(panel.dataset.tabIndex || "0"));
    }
    if (!String(panel.dataset.tabTopic || "").trim()) {
      panel.dataset.tabTopic = REASONING_UNTITLED_TAB_NAME;
    }
    if (!String(panel.dataset.tabTopicSet || "").trim()) {
      panel.dataset.tabTopicSet = "0";
    }
  });
  tabsEl.dataset.wiredReasoningTabs = "1";
  tabsEl.addEventListener("click", (e) => {
    const closeBtn = e.target.closest("button.vera-reasoning-tab-close");
    if (closeBtn && closeBtn.dataset.tabIndex != null) {
      e.preventDefault();
      e.stopPropagation();
      closeReasoningTab(Number(closeBtn.dataset.tabIndex));
      return;
    }
    const tab = e.target.closest("button.vera-reasoning-tab");
    if (tab && tab.dataset.tabIndex != null) {
      activateReasoningTab(Number(tab.dataset.tabIndex));
    }
  });
  panelsRoot.addEventListener("pointerdown", (e) => {
    const panel = e.target.closest(".vera-reasoning-tab-panel");
    if (!(panel instanceof HTMLElement)) return;
    const idx = Number(panel.dataset.tabIndex);
    if (!Number.isFinite(idx)) return;
    setFocusedWorkModeLaneFromIndex(idx);
    if (!panel.classList.contains("is-active")) activateReasoningTab(idx);
  });
  const reasoningInput = document.getElementById("vera-reasoning-input");
  reasoningInput?.addEventListener("focus", () => {
    const idx = getActiveReasoningLaneIndex();
    if (idx != null) setFocusedWorkModeLaneFromIndex(idx);
  });
  const mainTextInput = document.getElementById("vera-text-input");
  mainTextInput?.addEventListener("focus", () => {
    const idx = getActiveReasoningLaneIndex();
    if (idx != null) setFocusedWorkModeLaneFromIndex(idx);
  });
  addBtn?.addEventListener("click", () => addReasoningTab());
  renderReasoningTabStrip();
  const bootActive = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active");
  if (bootActive instanceof HTMLElement) {
    const bootIdx = Number(bootActive.dataset.tabIndex);
    if (Number.isFinite(bootIdx)) setFocusedWorkModeLaneFromIndex(bootIdx);
  }
  if (window.__veraReasoningTabsUnloadHook !== "1") {
    window.__veraReasoningTabsUnloadHook = "1";
    window.addEventListener("beforeunload", persistVeraClientStateOnUnload);
    window.addEventListener("pagehide", persistVeraClientStateOnUnload);
  }
}

let __veraReasoningCodeCopyDelegation = false;
function wireReasoningMarkdownCodeCopy() {
  if (__veraReasoningCodeCopyDelegation) return;
  __veraReasoningCodeCopyDelegation = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".vera-md-code-copy");
    if (!btn) return;
    if (!document.getElementById("vera-app")?.contains(btn)) return;
    e.preventDefault();
    const frame = btn.closest(".vera-md-code-frame");
    const codeEl = frame?.querySelector("pre code");
    const text = codeEl ? String(codeEl.textContent ?? "") : "";
    const reset = (label, html) => {
      btn.innerHTML = html;
      btn.setAttribute("aria-label", label);
    };
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        reset("Copied", VERA_REASONING_CODE_COPIED_ICON);
        window.setTimeout(() => reset("Copy code", VERA_REASONING_CODE_COPY_ICON), 1600);
      } catch (_) {
        reset("Copy failed", VERA_REASONING_CODE_COPY_ICON);
        window.setTimeout(() => reset("Copy code", VERA_REASONING_CODE_COPY_ICON), 1600);
      }
    })();
  });
}

function getWorkModeLeftPaneLayout() {
  try {
    const v = localStorage.getItem(WORK_LEFT_PANES_LAYOUT_KEY);
    if (v === "music-full" || v === "checklist-full" || v === "split") return v;
  } catch (_) {}
  return "split";
}

function setWorkModeLeftPaneLayout(layout) {
  const left = document.getElementById("vera-wm-left");
  if (!left) return;
  if (layout !== "split" && layout !== "music-full" && layout !== "checklist-full") layout = "split";
  left.dataset.wmLeftLayout = layout;
  try {
    localStorage.setItem(WORK_LEFT_PANES_LAYOUT_KEY, layout);
  } catch (_) {}
}

function applyWorkModeLeftPaneLayoutFromStorage() {
  setWorkModeLeftPaneLayout(getWorkModeLeftPaneLayout());
}

function wireWorkModeLeftPaneLayout() {
  const left = document.getElementById("vera-wm-left");
  if (!left || left.dataset.wmLeftPaneWired === "1") return;
  left.dataset.wmLeftPaneWired = "1";
  left.addEventListener("click", (e) => {
    if (!isVeraWorkModeOn()) return;
    const btn = e.target.closest("[data-wm-pane-action]");
    if (!(btn instanceof HTMLElement)) return;
    const pane = btn.dataset.wmPane;
    const action = btn.dataset.wmPaneAction;
    if ((pane !== "music" && pane !== "checklist") || (action !== "expand" && action !== "collapse")) return;
    e.preventDefault();
    const cur = getWorkModeLeftPaneLayout();

    if (action === "collapse") {
      if (cur === "split") setWorkModeLeftPaneLayout(pane === "music" ? "checklist-full" : "music-full");
      else if (cur === "music-full" && pane === "music") setWorkModeLeftPaneLayout("split");
      else if (cur === "checklist-full" && pane === "checklist") setWorkModeLeftPaneLayout("split");
      return;
    }
    if (action === "expand") {
      if (cur === "split") setWorkModeLeftPaneLayout(pane === "music" ? "music-full" : "checklist-full");
      else if (cur === "music-full" && pane === "checklist") setWorkModeLeftPaneLayout("split");
      else if (cur === "checklist-full" && pane === "music") setWorkModeLeftPaneLayout("split");
    }
  });
}
let workModeReasoningConfirmPending = null;
/**
 * @typedef {{ id: string, file: File, name: string, mimeType: string, previewUrl: string, pageCount: number | null }} WorkModePendingAttachment
 * Composer queue; each item has its own object URL for the chip preview.
 */
let workModePendingAttachments = [];
/** Escape-to-close listener for the attachment preview modal (if open). */
let workModeAttachmentModalOnKeydown = null;
/** Composer hint under the attachment grid (limits, partial batch, etc.). */
let workModeAttachmentComposerHint = "";

const WORK_MODE_ATTACH_MAX_TOTAL = 5;
const WORK_MODE_ATTACH_MAX_IMAGES = 5;
const WORK_MODE_ATTACH_MAX_DOCS = 3;
/** Per-turn total bytes for all attachments combined (~45 MB). */
const WORK_MODE_ATTACH_MAX_TOTAL_BYTES = 45 * 1024 * 1024;
const WORK_MODE_ATTACH_MAX_FILE_BYTES = 25 * 1024 * 1024;

const WORK_MODE_ATTACH_MSG_MAX_FILES =
  "I can handle up to 5 files at once. Please send the rest in another message.";
const WORK_MODE_ATTACH_MSG_MAX_IMAGES =
  "I can include up to 5 images per message. Please send the rest in another message.";
const WORK_MODE_ATTACH_MSG_MAX_PDFS =
  "I can include up to 3 PDF files per message. Please send the rest in another message.";
const WORK_MODE_ATTACH_MSG_TOTAL_SIZE =
  "These attachments exceed about 45 MB for one message. Try fewer or smaller files, or split across messages.";

function workModeAttachmentKindForFile(f) {
  if (!(f instanceof File)) return "other";
  const name = (f.name || "").toLowerCase();
  const t = f.type || "";
  if (t.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(name)) return "image";
  if (name.endsWith(".pdf") || t.includes("pdf")) return "pdf";
  return "other";
}

function workModeCountPendingAttachmentsByKind() {
  let images = 0;
  let pdfs = 0;
  for (const it of workModePendingAttachments) {
    const k = workModeAttachmentKindForFile(it.file);
    if (k === "image") images += 1;
    else if (k === "pdf") pdfs += 1;
  }
  return {
    images,
    pdfs,
    total: workModePendingAttachments.length
  };
}

function workModePendingAttachmentsTotalBytes() {
  let b = 0;
  for (const it of workModePendingAttachments) {
    if (it.file?.size) b += it.file.size;
  }
  return b;
}

function closeWorkModeAttachmentPreviewModal() {
  const modal = document.getElementById("vera-wm-attachment-preview-modal");
  if (modal) {
    modal.hidden = true;
    modal.classList.remove("is-open");
    modal.querySelector(".vera-wm-attachment-preview-modal-iframe")?.removeAttribute("src");
    modal.querySelector(".vera-wm-attachment-preview-modal-img")?.removeAttribute("src");
    const body = modal.querySelector(".vera-wm-attachment-preview-modal-body");
    if (body) body.innerHTML = "";
  }
  if (workModeAttachmentModalOnKeydown) {
    document.removeEventListener("keydown", workModeAttachmentModalOnKeydown, true);
    workModeAttachmentModalOnKeydown = null;
  }
}

/**
 * @param {{ kind?: 'image'|'pdf'|'unsupported', url: string, title?: string }} opts
 */
function openWorkModeAttachmentPreviewModal(opts) {
  const u = String(opts?.url || "").trim();
  if (!u) return;
  const rawKind = opts?.kind;
  const kind = rawKind === "pdf" ? "pdf" : rawKind === "unsupported" ? "unsupported" : "image";
  let modal = document.getElementById("vera-wm-attachment-preview-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "vera-wm-attachment-preview-modal";
    modal.className = "vera-wm-attachment-preview-modal";
    modal.setAttribute("role", "presentation");
    modal.hidden = true;
    modal.innerHTML = [
      '<div class="vera-wm-attachment-preview-modal-panel" role="dialog" aria-modal="true" aria-labelledby="vera-wm-attachment-preview-modal-title">',
      '  <div class="vera-wm-attachment-preview-modal-toolbar">',
      '    <h2 id="vera-wm-attachment-preview-modal-title" class="vera-wm-attachment-preview-modal-title">Attachment</h2>',
      '    <button type="button" class="vera-wm-attachment-preview-modal-close" aria-label="Close">×</button>',
      "  </div>",
      '  <div class="vera-wm-attachment-preview-modal-body"></div>',
      "</div>"
    ].join("");
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (!e.target.closest(".vera-wm-attachment-preview-modal-panel")) closeWorkModeAttachmentPreviewModal();
    });
    modal.querySelector(".vera-wm-attachment-preview-modal-close")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeWorkModeAttachmentPreviewModal();
    });
  }
  const titleEl = modal.querySelector("#vera-wm-attachment-preview-modal-title");
  const body = modal.querySelector(".vera-wm-attachment-preview-modal-body");
  if (titleEl) titleEl.textContent = String(opts?.title || "").trim() || "Attachment";
  if (!body) return;
  body.innerHTML = "";
  if (kind === "image") {
    const img = document.createElement("img");
    img.className = "vera-wm-attachment-preview-modal-img";
    img.alt = "";
    img.decoding = "async";
    img.src = u;
    body.appendChild(img);
  } else if (kind === "pdf") {
    const wrap = document.createElement("div");
    wrap.className = "vera-wm-attachment-preview-modal-pdf-wrap";
    const iframe = document.createElement("iframe");
    iframe.className = "vera-wm-attachment-preview-modal-iframe";
    iframe.title = String(opts?.title || "PDF");
    iframe.src = u;
    wrap.appendChild(iframe);
    body.appendChild(wrap);
  } else {
    const fb = document.createElement("div");
    fb.className = "vera-wm-attachment-preview-modal-fallback";
    fb.textContent = "Preview isn't available for this file in the browser.";
    body.appendChild(fb);
  }
  modal.hidden = false;
  modal.classList.add("is-open");
  if (workModeAttachmentModalOnKeydown) {
    document.removeEventListener("keydown", workModeAttachmentModalOnKeydown, true);
  }
  workModeAttachmentModalOnKeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeWorkModeAttachmentPreviewModal();
    }
  };
  document.addEventListener("keydown", workModeAttachmentModalOnKeydown, true);
}

function generateWorkModeAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function guessMimeFromWorkModeFileName(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  return "";
}

function workModeFileLooksSupported(f) {
  const name = (f?.name || "").toLowerCase();
  const isPdf = name.endsWith(".pdf") || (f.type || "").includes("pdf");
  const isImage = (f.type || "").startsWith("image/") || /\.(png|jpe?g|webp)$/.test(name);
  return Boolean(isPdf || isImage);
}

function revokeWorkModePendingAttachmentPreview(item) {
  if (!item?.previewUrl) return;
  try {
    URL.revokeObjectURL(item.previewUrl);
  } catch (_) {}
  item.previewUrl = "";
}

function renderWorkModeComposerAttachmentChips() {
  const meta = document.getElementById("vera-reasoning-attach-meta");
  if (!meta) return;
  meta.innerHTML = "";
  if (!workModePendingAttachments.length) {
    if (workModeAttachmentComposerHint) {
      const p = document.createElement("p");
      p.className = "vera-wm-composer-attach-hint";
      p.textContent = workModeAttachmentComposerHint;
      meta.appendChild(p);
    } else {
      meta.textContent = "";
    }
    return;
  }

  const panel = document.createElement("div");
  panel.className = "vera-wm-composer-attachment-panel";
  const header = document.createElement("div");
  header.className = "vera-wm-composer-attachment-panel-header";
  const title = document.createElement("span");
  title.className = "vera-wm-composer-attachment-panel-title";
  title.textContent = "Attachments";
  const countEl = document.createElement("span");
  countEl.className = "vera-wm-composer-attachment-count-label";
  const n = workModePendingAttachments.length;
  countEl.textContent = `${n} attachment${n === 1 ? "" : "s"}`;
  header.appendChild(title);
  header.appendChild(countEl);
  panel.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "vera-wm-composer-attachments-grid";
  for (const it of workModePendingAttachments) {
    const card = document.createElement("div");
    card.className = "vera-wm-composer-attach-card";
    card.dataset.attachmentId = it.id;

    const head = document.createElement("div");
    head.className = "vera-wm-composer-attach-card-head";
    const label = document.createElement("span");
    label.className = "vera-reasoning-attach-name vera-wm-composer-attach-card-name";
    label.textContent = it.name || "file";
    label.title = it.name || "";
    const kind = workModeAttachmentKindForFile(it.file);
    const kindEl = document.createElement("span");
    kindEl.className = "vera-wm-composer-attach-kind";
    kindEl.textContent =
      kind === "image" ? "Image" : kind === "pdf" ? "PDF" : String(it.mimeType || "File").split("/").pop() || "File";
    head.appendChild(label);
    head.appendChild(kindEl);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "vera-wm-composer-attach-card-body";
    if (kind === "image" && it.previewUrl) {
      const thumb = document.createElement("img");
      thumb.className = "vera-wm-composer-attach-thumb";
      thumb.src = it.previewUrl;
      thumb.alt = "";
      thumb.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openWorkModeAttachmentPreviewModal({
          kind: "image",
          url: it.previewUrl,
          title: it.name || "Image"
        });
      });
      body.appendChild(thumb);
    } else if (kind === "pdf") {
      const tap = document.createElement("button");
      tap.type = "button";
      tap.className = "vera-wm-composer-attach-doc-tap";
      tap.setAttribute("aria-label", `Open PDF preview: ${it.name || "file"}`);
      const doc = document.createElement("div");
      doc.className = "vera-wm-composer-attach-doc-card";
      doc.setAttribute("aria-hidden", "true");
      const icon = document.createElement("span");
      icon.className = "vera-wm-composer-attach-doc-icon";
      icon.textContent = "PDF";
      const lines = document.createElement("div");
      lines.className = "vera-wm-composer-attach-doc-lines";
      lines.appendChild(document.createElement("span"));
      lines.appendChild(document.createElement("span"));
      lines.appendChild(document.createElement("span"));
      doc.appendChild(icon);
      doc.appendChild(lines);
      const sub = document.createElement("div");
      sub.className = "vera-wm-composer-attach-doc-sub";
      sub.textContent =
        it.pageCount != null ? `${it.pageCount} pages · Tap to preview` : "Tap to preview PDF";
      tap.appendChild(doc);
      tap.appendChild(sub);
      tap.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openWorkModeAttachmentPreviewModal({
          kind: "pdf",
          url: it.previewUrl,
          title: it.name || "PDF"
        });
      });
      body.appendChild(tap);
    } else {
      const fb = document.createElement("div");
      fb.className = "vera-wm-composer-attach-fallback-mini";
      fb.textContent = "Preview not available";
      body.appendChild(fb);
    }
    card.appendChild(body);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "vera-wm-composer-attach-card-remove";
    rm.setAttribute("aria-label", "Remove attachment");
    rm.textContent = "Remove";
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeWorkModePendingAttachment(it.id);
    });
    card.appendChild(rm);
    grid.appendChild(card);
  }
  panel.appendChild(grid);

  if (workModeAttachmentComposerHint) {
    const hint = document.createElement("p");
    hint.className = "vera-wm-composer-attach-hint";
    hint.textContent = workModeAttachmentComposerHint;
    panel.appendChild(hint);
  }

  meta.appendChild(panel);
}

function removeWorkModePendingAttachment(id) {
  const i = workModePendingAttachments.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [removed] = workModePendingAttachments.splice(i, 1);
  revokeWorkModePendingAttachmentPreview(removed);
  renderWorkModeComposerAttachmentChips();
  const fin = document.getElementById("vera-reasoning-file");
  if (fin && !workModePendingAttachments.length) fin.value = "";
}

function clearWorkModePendingAttachments() {
  closeWorkModeAttachmentPreviewModal();
  for (const it of workModePendingAttachments) revokeWorkModePendingAttachmentPreview(it);
  workModePendingAttachments = [];
  workModeAttachmentComposerHint = "";
  renderWorkModeComposerAttachmentChips();
  const fin = document.getElementById("vera-reasoning-file");
  if (fin) fin.value = "";
}

function workModePendingAttachmentFileNames() {
  return workModePendingAttachments.map((it) => String(it?.name || it?.file?.name || "file").trim()).filter(Boolean);
}

function logComposerAttachmentsBeforeSubmit(files, turnContext) {
  const list = Array.isArray(files) ? files.filter((f) => f instanceof File && f.size) : [];
  try {
    console.info("[composer_attachments_before_submit]", {
      count: list.length,
      file_names: list.map((f) => f.name || "file"),
      turn_id: turnContext?.turn_id ?? null,
      lane_id: turnContext?.turn_lane_id ?? null
    });
  } catch (_) {}
}

function preserveComposerAttachments(reason, turnContext) {
  try {
    console.info("[composer_attachments_preserved]", {
      reason: String(reason || "").trim() || "unknown",
      turn_id: turnContext?.turn_id ?? null,
      lane_id: turnContext?.turn_lane_id ?? null,
      count: workModePendingAttachments.length,
      file_names: workModePendingAttachmentFileNames()
    });
  } catch (_) {}
}

/**
 * Clear composer tray after the turn is committed to the reasoning lane (not on stream failure later).
 * @param {object} [turnContext]
 * @param {string} [reason]
 */
function clearComposerAttachmentsAfterSubmit(turnContext, reason) {
  const count = workModePendingAttachments.length;
  if (!count) return;
  clearWorkModePendingAttachments();
  try {
    console.info("[composer_attachments_cleared]", {
      turn_id: turnContext?.turn_id ?? null,
      lane_id: turnContext?.turn_lane_id ?? null,
      count,
      reason: String(reason || "").trim() || "submit_success"
    });
  } catch (_) {}
}

/**
 * Add one or more files to the composer queue (PDF / images only).
 * @param {File[]} files
 * @returns {number} count added
 */
function addWorkModeReasoningAttachmentFiles(files) {
  const arr = Array.isArray(files) ? files : files ? [files] : [];
  let added = 0;
  const messages = [];

  for (const f of arr) {
    if (!(f instanceof File) || !f.size) continue;
    if (!workModeFileLooksSupported(f)) {
      messages.push("Unsupported file. Use PDF or image.");
      continue;
    }
    if (f.size > WORK_MODE_ATTACH_MAX_FILE_BYTES) {
      messages.push("Each file must be 25 MB or smaller.");
      continue;
    }
    const kind = workModeAttachmentKindForFile(f);
    if (kind === "other") {
      messages.push("Unsupported file. Use PDF or image.");
      continue;
    }

    const { images, pdfs, total } = workModeCountPendingAttachmentsByKind();
    if (total >= WORK_MODE_ATTACH_MAX_TOTAL) {
      messages.push(WORK_MODE_ATTACH_MSG_MAX_FILES);
      break;
    }
    if (kind === "image" && images >= WORK_MODE_ATTACH_MAX_IMAGES) {
      messages.push(WORK_MODE_ATTACH_MSG_MAX_IMAGES);
      continue;
    }
    if (kind === "pdf" && pdfs >= WORK_MODE_ATTACH_MAX_DOCS) {
      messages.push(WORK_MODE_ATTACH_MSG_MAX_PDFS);
      continue;
    }
    const nextBytes = workModePendingAttachmentsTotalBytes() + f.size;
    if (nextBytes > WORK_MODE_ATTACH_MAX_TOTAL_BYTES) {
      messages.push(WORK_MODE_ATTACH_MSG_TOTAL_SIZE);
      break;
    }

    const mimeType = f.type || guessMimeFromWorkModeFileName(f.name);
    const id = generateWorkModeAttachmentId();
    const previewUrl = URL.createObjectURL(f);
    workModePendingAttachments.push({
      id,
      file: f,
      name: f.name || "upload",
      mimeType,
      previewUrl,
      pageCount: null
    });
    added += 1;
  }

  if (added) {
    workModeAttachmentComposerHint = messages.length ? messages[0] : "";
  } else if (messages.length) {
    workModeAttachmentComposerHint = messages[0];
  }

  renderWorkModeComposerAttachmentChips();
  return added;
}

/** @returns {File[]} */
function getWorkModePendingAttachmentFiles() {
  return workModePendingAttachments.map((x) => x.file).filter((f) => f instanceof File);
}

function normalizeReasoningUploadAttachmentArg(opts) {
  const out = [];
  if (opts?.attachments && Array.isArray(opts.attachments)) {
    for (const f of opts.attachments) if (f instanceof File && f.size) out.push(f);
  }
  if (opts?.attachment instanceof File && opts.attachment.size) out.push(opts.attachment);
  if (out.length > WORK_MODE_ATTACH_MAX_TOTAL) return out.slice(0, WORK_MODE_ATTACH_MAX_TOTAL);
  return out;
}

function insertWorkModeLaneAttachmentBlock(scrollEl, { laneId, turnId, items }) {
  if (!(scrollEl instanceof HTMLElement) || !items?.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "vera-wm-lane-attachment-block";
  wrap.dataset.laneId = String(laneId || "");
  wrap.dataset.turnId = String(turnId || "");
  const head = document.createElement("div");
  head.className = "vera-wm-lane-attachment-head";
  const titleRow = document.createElement("div");
  titleRow.className = "vera-wm-lane-attachment-head-row";
  const title = document.createElement("span");
  title.className = "vera-wm-lane-attachment-head-title";
  title.textContent = "Attachments";
  const countLab = document.createElement("span");
  countLab.className = "vera-wm-lane-attachment-count-label";
  const n = items.length;
  countLab.textContent = `${n} attachment${n === 1 ? "" : "s"}`;
  titleRow.appendChild(title);
  titleRow.appendChild(countLab);
  head.appendChild(titleRow);
  wrap.appendChild(head);
  const grid = document.createElement("div");
  grid.className = "vera-wm-lane-attachment-grid";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "vera-wm-lane-attach-card";
    card.dataset.attachmentId = it.attachment_id;
    const mime = String(it.mime_type || "").toLowerCase();
    const dispName = it.name || "file";
    const isPdf = mime.includes("pdf") || /\.pdf$/i.test(dispName);
    const isImage = mime.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(dispName);
    const typeLabel = isPdf ? "PDF" : isImage ? "Image" : (mime.split("/")[1] || "file").toUpperCase();

    const hdr = document.createElement("div");
    hdr.className = "vera-wm-lane-attach-card-head";
    const cap = document.createElement("div");
    cap.className = "vera-wm-lane-attach-card-caption";
    cap.textContent = dispName;
    const badge = document.createElement("span");
    badge.className = "vera-wm-lane-attach-type-badge";
    badge.textContent = typeLabel;
    hdr.appendChild(cap);
    hdr.appendChild(badge);
    card.appendChild(hdr);

    if (isImage && it.preview_url) {
      const tap = document.createElement("button");
      tap.type = "button";
      tap.className = "vera-wm-lane-attach-media-tap";
      tap.setAttribute("aria-label", `Open image preview: ${dispName}`);
      const scrollBox = document.createElement("div");
      scrollBox.className = "vera-wm-lane-attach-thumb-scroll";
      const img = document.createElement("img");
      img.className = "vera-wm-lane-attach-thumb";
      img.src = it.preview_url;
      img.alt = "";
      img.loading = "lazy";
      scrollBox.appendChild(img);
      tap.appendChild(scrollBox);
      tap.addEventListener("click", () =>
        openWorkModeAttachmentPreviewModal({ kind: "image", url: it.preview_url, title: dispName })
      );
      card.appendChild(tap);
      const imgMeta = document.createElement("div");
      imgMeta.className = "vera-wm-lane-attach-file-meta";
      imgMeta.textContent = it.mime_type || "image";
      card.appendChild(imgMeta);
    } else if (isPdf && it.preview_url) {
      const tap = document.createElement("button");
      tap.type = "button";
      tap.className = "vera-wm-lane-attach-pdf-tap";
      tap.setAttribute("aria-label", `Open PDF preview: ${dispName}`);
      const innerDoc = document.createElement("div");
      innerDoc.className = "vera-wm-lane-attach-pdf-card";
      innerDoc.setAttribute("aria-hidden", "true");
      const icon = document.createElement("span");
      icon.className = "vera-wm-lane-attach-pdf-card-icon";
      icon.textContent = "PDF";
      const lines = document.createElement("div");
      lines.className = "vera-wm-lane-attach-pdf-card-lines";
      lines.appendChild(document.createElement("span"));
      lines.appendChild(document.createElement("span"));
      lines.appendChild(document.createElement("span"));
      innerDoc.appendChild(icon);
      innerDoc.appendChild(lines);
      const hint = document.createElement("div");
      hint.className = "vera-wm-lane-attach-pdf-hint";
      hint.textContent = "Tap to preview";
      tap.appendChild(innerDoc);
      tap.appendChild(hint);
      tap.addEventListener("click", () =>
        openWorkModeAttachmentPreviewModal({ kind: "pdf", url: it.preview_url, title: dispName })
      );
      card.appendChild(tap);
      const metaLine = document.createElement("div");
      metaLine.className = "vera-wm-lane-attach-file-meta";
      const pagePart =
        it.page_count != null ? `${it.page_count} page${it.page_count === 1 ? "" : "s"}` : "";
      metaLine.textContent = [pagePart, it.mime_type || "application/pdf"].filter(Boolean).join(" · ");
      card.appendChild(metaLine);
    } else {
      const fb = document.createElement("div");
      fb.className = "vera-wm-lane-attach-fallback";
      fb.textContent = "Preview not available";
      card.appendChild(fb);
    }
    grid.appendChild(card);
    try {
      console.info("[file_preview_rendered]", {
        turn_id: turnId || null,
        lane_id: laneId || null,
        attachment_id: it.attachment_id,
        mime_type: it.mime_type || null
      });
    } catch (_) {}
  }
  wrap.appendChild(grid);
  scrollEl.appendChild(wrap);
  try {
    console.info("[attachment_preview_rendered]", {
      turn_id: turnId || null,
      lane_id: laneId || null,
      file_count: items.length
    });
  } catch (_) {}
  return wrap;
}

function appendWorkModeLaneAttachmentRegistryRecords(laneId, records) {
  const lid = String(laneId || "").trim();
  if (!lid || !records?.length) return;
  const cur = getWorkModeLaneHandoff(lid) || {
    lane_id: lid,
    active_lane_id: lid,
    title: getWorkModeLaneTitle(lid) || "",
    lane_title: getWorkModeLaneTitle(lid) || ""
  };
  const prev = Array.isArray(cur.attachments) ? cur.attachments : [];
  const merged = [...prev, ...records].slice(-80);
  setWorkModeLaneHandoff(
    lid,
    { ...cur, attachments: merged },
    { source: "work_mode_attachments", forceSubstantive: false }
  );
}

function buildWorkModeLaneAttachmentContextSection(laneId, currentMeta, handoff, turnId) {
  const lid = String(laneId || "").trim();
  const prior = Array.isArray(handoff?.attachments) ? handoff.attachments : [];
  const cur = Array.isArray(currentMeta) ? currentMeta : [];
  let priorExtractedLen = 0;
  const priorBits = [];
  for (const a of prior) {
    const ex = String(a?.extracted_text || "").trim();
    priorExtractedLen += ex.length;
    if (ex) {
      priorBits.push(
        `### Prior upload: ${a.name || "file"}\n${truncateWorkModeRegistryExcerpt(ex, 6000)}`
      );
    } else {
      priorBits.push(`- (prior) ${a.name || "file"} — no client-stored extract`);
    }
  }
  const curBits = cur.map((c) => `- (this turn) ${c.name}${c.mime_type ? ` [${c.mime_type}]` : ""}`);
  let section = "";
  if (priorBits.length) {
    section +=
      "LANE_PRIOR_UPLOADS (metadata and any stored extracts for this reasoning lane):\n\n" +
      priorBits.join("\n\n") +
      "\n\n";
  }
  if (curBits.length) {
    section += "CURRENT_TURN_UPLOADS (files attached this request):\n" + curBits.join("\n");
  }
  try {
    console.info("[attachment_context_merge]", {
      turn_id: turnId ?? null,
      lane_id: lid || null,
      current_files: cur.map((c) => c.name),
      prior_lane_files: prior.map((p) => p.name),
      extracted_text_len: priorExtractedLen
    });
  } catch (_) {}
  return section.trim() ? section : "";
}

function wireWorkModeReasoningAttachWrap() {
  const wrap = document.getElementById("vera-reasoning-attach-wrap");
  if (!wrap || wrap.dataset.wmAttachWrapWired === "1") return;
  wrap.dataset.wmAttachWrapWired = "1";
  wrap.addEventListener("click", (e) => {
    const rm = e.target.closest(
      ".vera-wm-composer-attach-card-remove, .vera-wm-composer-attach-chip-remove, .vera-reasoning-attach-remove"
    );
    if (!rm) return;
    e.preventDefault();
    const id = rm.closest("[data-attachment-id]")?.dataset?.attachmentId;
    if (id) removeWorkModePendingAttachment(id);
    else applyWorkModeReasoningAttachmentFile(null);
  });
}

function applyWorkModeReasoningAttachmentFile(f) {
  if (!f) {
    clearWorkModePendingAttachments();
    setWorkModeAttachmentMeta("");
    return false;
  }
  const n = addWorkModeReasoningAttachmentFiles([f]);
  return n > 0;
}

const workModeReasoningLaneBusy = new Map();
const workModeReasoningLaneWaitQueue = [];
const workModeReasoningAbortControllers = new Map();
const workModeReasoningFinalStatusByTurnId = new Map();
const workModeReasoningFinalStatusByLaneId = new Map();
/** Abort hung reasoning streams; idempotent cleanup is guarded separately. */
const WORK_MODE_REASONING_WATCHDOG_MS = 110000;
const workModeReasoningWatchdogByLaneIdx = new Map();
const workModeTypedTurnQueue = [];
const WORK_MODE_TYPED_TURN_QUEUE_MAX = 8;
/**
 * Hard cap on typed (keyboard) inputs pending in Work Mode. Matches the
 * non-work-mode "3 consecutive user turns before VERA replies" block. Counts
 * voice infer chain depth + queued typed turns; the 4th input is refused
 * with a status hint instead of being queued indefinitely.
 */
const WORK_MODE_TYPED_PENDING_MAX = 3;
/**
 * Max number of reasoning panels generating answers at the same time, even
 * if more panels exist. The 4th request lands in `workModeReasoningLaneWaitQueue`
 * and resumes when one of the three active lanes releases.
 */
const WORK_MODE_REASONING_MAX_CONCURRENT = 3;
/** Last non–example-request user text in work mode (typed or voice); steers generic “example” reasoning. */
let workModeLastSubstantiveUserText = "";
/** Panel index for the last substantive reasoning turn — generic “example” chains here. */
let workModeLastSubstantiveLaneIdx = null;
/** Per-lane topic seed for categorical routing when auto-route is enabled (same topic → same panel, queued). */
const laneTopicSeedByIdx = { 0: "", 1: "", 2: "", 3: "", 4: "", 5: "", 6: "", 7: "" };
/** How many reasoning turns have been placed on each panel (load balance new topics across panels in auto-route mode). */
const laneReasoningTurnCountByIdx = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
/** Serialize reasoning streams per panel; unrelated topics run on different lanes concurrently. */
const laneReasoningChainTail = new Map();
/** Serialize work-mode typed `/infer`+TTS while reasoning runs in parallel across lanes. */
let workModeTypedVoiceInferTail = Promise.resolve();
let workModeTypedVoiceInferDepth = 0;
const WORK_MODE_TOPIC_SIMILARITY_MERGE = 0.26;
const WORK_MODE_TYPED_VOICE_CHAIN_MAX = 12;
let workModeTypedQueueDraining = false;

function syncWorkModeReasoningCancelButton() {
  const btn = document.getElementById("vera-reasoning-cancel");
  if (!btn) return;
  const activeIdx = getActiveReasoningLaneIndex();
  btn.hidden = activeIdx == null || !workModeReasoningAbortControllers.has(Number(activeIdx));
}

function getActiveReasoningLaneIndex() {
  const panel = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active");
  if (!(panel instanceof HTMLElement)) return null;
  const idx = Number(panel.dataset.tabIndex);
  return Number.isFinite(idx) ? idx : null;
}

function setWorkModeReasoningFinalStatus({ turnId, laneId, status, reason }) {
  const row = {
    turn_id: String(turnId || "").trim(),
    lane_id: String(laneId || "").trim(),
    status: String(status || "").trim() || "unknown",
    reason: String(reason || "").trim(),
    at: Date.now()
  };
  if (row.turn_id) workModeReasoningFinalStatusByTurnId.set(row.turn_id, row);
  if (row.lane_id) workModeReasoningFinalStatusByLaneId.set(row.lane_id, row);
  return row;
}

function getWorkModeReasoningFinalStatus(prep) {
  const turnId = String(prep?.turnContext?.turn_id || "").trim();
  const laneId = String(prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || "").trim();
  let row = (turnId && workModeReasoningFinalStatusByTurnId.get(turnId)) || null;
  if (!row && laneId) row = workModeReasoningFinalStatusByLaneId.get(laneId) || null;
  if (!row && laneId) {
    const panel = getReasoningPanelElementByLaneId(laneId);
    const st = String(panel?.dataset?.generationStatus || "").trim();
    if (st) row = { turn_id: turnId, lane_id: laneId, status: st, reason: "panel_dataset", at: 0 };
  }
  return row;
}

function logStage2ReasoningStatus(prep, statusRow, stage2Text, shouldSpeak, fallbackReason = "") {
  try {
    const status = String(statusRow?.status || "").trim();
    console.info("[STAGE2_DEBUG][reasoning_status]", {
      panel_id: statusRow?.lane_id || prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || null,
      lane_id: statusRow?.lane_id || prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || null,
      reasoning_status: status || "unknown",
      was_cancelled: status === "cancelled" || status === "user_stopped",
      was_error: /failed|error|timed_out|http|throw/i.test(status),
      was_completed: status === "complete" || status === "completed",
      stage2_text: String(stage2Text || "").slice(0, 240),
      stage2_should_speak: Boolean(shouldSpeak),
      fallback_reason: String(fallbackReason || statusRow?.reason || "")
    });
  } catch (_) {}
}

function cancelWorkModeReasoningLane(idx) {
  const laneIdx = Number(idx);
  const ctl = workModeReasoningAbortControllers.get(laneIdx);
  if (!ctl) return false;
  const reasoningLaneId = getWorkModeReasoningLaneId(laneIdx);
  const turnId = workModeReasoningStreamTurnByLaneId[String(reasoningLaneId || "")];
  setWorkModeReasoningFinalStatus({
    turnId,
    laneId: reasoningLaneId,
    status: "cancelled",
    reason: "user_cancelled"
  });
  try {
    const panel = getReasoningPanelElementByLaneId(reasoningLaneId);
    if (panel instanceof HTMLElement) {
      panel.dataset.generationStatus = "cancelled";
      panel.dataset.generating = "0";
    }
  } catch (_) {}
  try {
    console.info("[turn_cancel_request]", {
      turn_id: turnId || null,
      lane_id: reasoningLaneId || null,
      lane_idx: laneIdx
    });
  } catch (_) {}
  try {
    ctl.abort();
  } catch (_) {}
  if (turnId) {
    const rec = workModeTtsTurnRegistry.get(turnId);
    if (rec) rec.canceled = true;
  }
  try {
    console.info("[turn_cancelled]", { turn_id: turnId || null, lane_id: reasoningLaneId || null });
  } catch (_) {}
  setWorkModeAttachmentMeta(`Reasoning cancelled for ${getWorkModeReasoningLaneLabel(laneIdx)}.`);
  return true;
}

function endWorkModeReasoningLaneRun(idx) {
  workModeReasoningAbortControllers.delete(Number(idx));
  releaseWorkModeReasoningLane(idx);
  syncWorkModeReasoningCancelButton();
}

function clearWorkModeReasoningWatchdog(laneIdx) {
  const key = Number(laneIdx);
  const rec = workModeReasoningWatchdogByLaneIdx.get(key);
  if (rec?.timerId) {
    try {
      window.clearTimeout(rec.timerId);
    } catch (_) {}
  }
  workModeReasoningWatchdogByLaneIdx.delete(key);
}

function startWorkModeReasoningWatchdog(laneIdx, meta, onTimeout) {
  const key = Number(laneIdx);
  clearWorkModeReasoningWatchdog(key);
  const startedAt = Date.now();
  const turnId = meta?.turn_id ?? null;
  const lane_id = meta?.lane_id ?? null;
  const timerId = window.setTimeout(() => {
    workModeReasoningWatchdogByLaneIdx.delete(key);
    try {
      console.warn("[stuck_turn_watchdog]", {
        lane_id,
        turn_id: turnId,
        age_ms: Date.now() - startedAt,
        state: "timed_out"
      });
    } catch (_) {}
    try {
      onTimeout?.();
    } catch (_) {}
  }, WORK_MODE_REASONING_WATCHDOG_MS);
  workModeReasoningWatchdogByLaneIdx.set(key, { timerId, turnId, startedAt, lane_id });
}

function logLaneBusyStateForReasoning(tag, laneIdx, turnId, streamLaneId) {
  try {
    const idx = Number(laneIdx);
    console.info("[lane_busy_state]", {
      tag: String(tag || ""),
      lane_id: streamLaneId ?? null,
      active_turn_id: turnId ?? null,
      lane_idx: idx,
      queue_len: workModeTypedTurnQueue.length,
      is_busy: workModeReasoningLaneBusy.get(idx) === true
    });
  } catch (_) {}
}

/** Number of reasoning panels currently busy (i.e. generating an answer). */
function countBusyReasoningLanes() {
  let n = 0;
  for (const idx of getReasoningPanelIndices()) {
    if (workModeReasoningLaneBusy.get(idx) === true) n += 1;
  }
  return n;
}

function isReasoningLanePoolAtCap() {
  return countBusyReasoningLanes() >= WORK_MODE_REASONING_MAX_CONCURRENT;
}

/**
 * Pick which idle panel gets a *new* topic (no merge with existing lane): the panel with the fewest reasoning
 * turns so far; ties go Panel 1 → 2 → 3 (lowest index). Categorical / similarity / thread continuation still
 * route to the same panel before this runs. Returns null when the global concurrent-reasoning cap is hit
 * even if some panels are idle — those requests queue.
 */
function pickIdleReasoningLaneIdx() {
  if (isReasoningLanePoolAtCap()) return null;
  const idleIdxs = getReasoningPanelIndices().filter((idx) => !workModeReasoningLaneBusy.get(idx));
  if (!idleIdxs.length) return null;
  let bestIdx = idleIdxs[0];
  let bestCount = laneReasoningTurnCountByIdx[bestIdx] ?? 0;
  for (const idx of idleIdxs) {
    const c = laneReasoningTurnCountByIdx[idx] ?? 0;
    if (c < bestCount || (c === bestCount && idx < bestIdx)) {
      bestCount = c;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

function acquireWorkModeReasoningLane(_forTopicText = "") {
  const picked = pickIdleReasoningLaneIdx();
  if (picked != null) {
    workModeReasoningLaneBusy.set(picked, true);
    syncWorkModeReasoningCancelButton();
    return Promise.resolve(picked);
  }
  try {
    console.info("[reasoning_pool_wait]", {
      reason: isReasoningLanePoolAtCap() ? "pool_at_max_concurrent" : "all_panels_busy",
      busy: countBusyReasoningLanes(),
      max_concurrent: WORK_MODE_REASONING_MAX_CONCURRENT,
      desired_lane_idx: null
    });
  } catch (_) {}
  return new Promise((resolve) => {
    workModeReasoningLaneWaitQueue.push({
      resolve,
      desiredLaneIdx: null,
      forTopicText: String(_forTopicText || "")
    });
  });
}

function acquireWorkModeReasoningLaneForIndex(desiredLaneIdx) {
  const idxs = getReasoningPanelIndices();
  const raw = Number(desiredLaneIdx);
  const laneIdx = Number.isFinite(raw) && idxs.includes(raw) ? raw : idxs[0] ?? 0;
  if (!workModeReasoningLaneBusy.get(laneIdx) && !isReasoningLanePoolAtCap()) {
    workModeReasoningLaneBusy.set(laneIdx, true);
    syncWorkModeReasoningCancelButton();
    return Promise.resolve(laneIdx);
  }
  try {
    console.info("[reasoning_pool_wait]", {
      reason: workModeReasoningLaneBusy.get(laneIdx)
        ? "desired_lane_busy"
        : "pool_at_max_concurrent",
      busy: countBusyReasoningLanes(),
      max_concurrent: WORK_MODE_REASONING_MAX_CONCURRENT,
      desired_lane_idx: laneIdx
    });
  } catch (_) {}
  return new Promise((resolve) => {
    workModeReasoningLaneWaitQueue.push({ resolve, desiredLaneIdx: laneIdx });
  });
}

/**
 * Walk the reasoning lane wait queue and grant capacity to as many waiters
 * as the global concurrent cap allows. Preserves FIFO ordering: a waiter for
 * a specific lane is granted as soon as that lane is idle, an "any-lane"
 * waiter takes the next idle lane (by `pickIdleReasoningLaneIdx`'s policy).
 */
function drainWorkModeReasoningLaneWaitQueue() {
  const queue = workModeReasoningLaneWaitQueue;
  let i = 0;
  while (i < queue.length) {
    if (isReasoningLanePoolAtCap()) break;
    const w = queue[i];
    if (!w) {
      queue.splice(i, 1);
      continue;
    }
    if (w.desiredLaneIdx != null) {
      const di = Number(w.desiredLaneIdx);
      if (!workModeReasoningLaneBusy.get(di)) {
        queue.splice(i, 1);
        workModeReasoningLaneBusy.set(di, true);
        const resolve = typeof w === "function" ? w : w.resolve;
        try {
          resolve(di);
        } catch (_) {}
        continue;
      }
      i += 1;
      continue;
    }
    const picked = pickIdleReasoningLaneIdx();
    if (picked == null) break;
    queue.splice(i, 1);
    workModeReasoningLaneBusy.set(picked, true);
    const resolve = typeof w === "function" ? w : w.resolve;
    try {
      resolve(picked);
    } catch (_) {}
  }
  syncWorkModeReasoningCancelButton();
}

function releaseWorkModeReasoningLane(idx) {
  const laneIdx = Number(idx);
  workModeReasoningLaneBusy.set(laneIdx, false);
  syncWorkModeReasoningCancelButton();
  drainWorkModeReasoningLaneWaitQueue();
  scheduleReasoningPanelFollowUpQueueDrain(laneIdx);
}

// Phrases that should NOT be sent to the per-panel queue, because they
// route to non-reasoning subsystems (checklist edits, panel navigation,
// music transport, plan sync) and should run immediately even while a
// panel is generating elsewhere.
function shouldQueueFollowUpForBusyReasoningPanel(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (isLikelyWorkChecklistEditIntent(t)) return false;
  if (isExplicitWorkModePanelNavigationIntent(t)) return false;
  if (/\b(?:clear|reset|erase|wipe)\s+(?:out\s+)?(?:the\s+|my\s+|all\s+)?checklist\b/.test(t)) return false;
  if (/\b(?:sync|push|send)\s+(?:the\s+)?plan\b/.test(t)) return false;
  if (/\b(play|pause|resume|skip|stop|mute|unmute|volume)\b.*\b(music|song|track|playlist|spotify)\b/.test(t)) return false;
  if (/\b(open|show|close|hide)\s+(?:the\s+)?(music|spotify|news|finance|weather)\s+(?:panel|tab)\b/.test(t)) return false;
  if (/\b(?:set|start|cancel|stop|pause)\s+(?:a\s+|the\s+)?timer\b/.test(t)) return false;
  if (/\b(undo\s+that|restore\s+the\s+checklist)\b/.test(t)) return false;
  return true;
}

// =========================
// Per-panel follow-up queue (visible in each reasoning panel)
// =========================
// Map<laneIdx (number), Array<{ id, text, opts, createdAt, panelLabel }>>.
// Distinct from the global `workModeTypedTurnQueue` and the lane wait queue:
// this queue is *visible* inside the targeted panel so the user can review,
// edit, or delete their follow-ups before the panel starts running them.
const workModeReasoningPanelFollowUpQueue = new Map();
const REASONING_PANEL_QUEUE_MAX = 6;

function getReasoningPanelFollowUpQueueForIdx(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return [];
  let q = workModeReasoningPanelFollowUpQueue.get(idx);
  if (!Array.isArray(q)) {
    q = [];
    workModeReasoningPanelFollowUpQueue.set(idx, q);
  }
  return q;
}

function newReasoningPanelQueueItemId() {
  return `wmq-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
}

function getReasoningPanelElementByLaneIdx(laneIdx) {
  return document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${Number(laneIdx)}"]`
  );
}

function renderReasoningPanelFollowUpQueueUi(laneIdx) {
  const panel = getReasoningPanelElementByLaneIdx(laneIdx);
  if (!(panel instanceof HTMLElement)) return;
  const queue = getReasoningPanelFollowUpQueueForIdx(laneIdx);
  let host = panel.querySelector(":scope > .vera-reasoning-queue-host");
  if (!queue.length) {
    if (host) host.remove();
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.className = "vera-reasoning-queue-host";
    host.setAttribute("aria-live", "polite");
    panel.insertBefore(host, panel.firstChild);
  }
  const heading = document.createElement("div");
  heading.className = "vera-reasoning-queue-heading";
  heading.textContent = `Queued (${queue.length})`;
  const list = document.createElement("ol");
  list.className = "vera-reasoning-queue-list";
  queue.forEach((item) => {
    const li = document.createElement("li");
    li.className = "vera-reasoning-queue-item";
    li.dataset.queueItemId = String(item.id || "");

    const textWrap = document.createElement("div");
    textWrap.className = "vera-reasoning-queue-item-text";
    textWrap.textContent = String(item.text || "");

    const actions = document.createElement("div");
    actions.className = "vera-reasoning-queue-item-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "vera-reasoning-queue-btn vera-reasoning-queue-btn--edit";
    editBtn.textContent = "edit";
    editBtn.title = "Edit this queued follow-up";
    editBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      beginEditReasoningPanelQueueItem(laneIdx, item.id);
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "vera-reasoning-queue-btn vera-reasoning-queue-btn--delete";
    delBtn.textContent = "delete";
    delBtn.title = "Remove this queued follow-up";
    delBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      deleteReasoningPanelQueueItem(laneIdx, item.id);
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(textWrap);
    li.appendChild(actions);
    list.appendChild(li);
  });
  host.replaceChildren(heading, list);
}

function enqueueReasoningPanelFollowUp(laneIdx, text, opts = {}) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return null;
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  if (queue.length >= REASONING_PANEL_QUEUE_MAX) {
    try {
      console.warn("[QUEUE_DEBUG][enqueue_rejected]", {
        panel_id: idx,
        reason: "panel_queue_max",
        queue_length: queue.length,
        max: REASONING_PANEL_QUEUE_MAX
      });
    } catch (_) {}
    return null;
  }
  const panel = getReasoningPanelElementByLaneIdx(idx);
  const panelLabel =
    (panel instanceof HTMLElement && getReasoningTabTopicLabel(panel)) ||
    getWorkModeReasoningLaneLabel(idx) ||
    `Panel ${idx + 1}`;
  const item = {
    id: newReasoningPanelQueueItemId(),
    text: trimmed,
    opts: { ...(opts || {}) },
    createdAt: Date.now(),
    panelLabel
  };
  queue.push(item);
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][enqueue]", {
      panel_id: idx,
      panel_title: panelLabel,
      queued_text: trimmed.slice(0, 160),
      queue_length_after: queue.length
    });
  } catch (_) {}
  return item;
}

function deleteReasoningPanelQueueItem(laneIdx, itemId) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return false;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  const beforeLen = queue.length;
  const next = queue.filter((it) => it.id !== itemId);
  if (next.length === beforeLen) return false;
  workModeReasoningPanelFollowUpQueue.set(idx, next);
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][delete]", {
      panel_id: idx,
      queue_item_id: itemId,
      queue_length_after: next.length
    });
  } catch (_) {}
  return true;
}

function editReasoningPanelQueueItem(laneIdx, itemId, newText) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return false;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  const target = queue.find((it) => it.id === itemId);
  if (!target) return false;
  const nextText = String(newText || "").trim();
  if (!nextText) {
    deleteReasoningPanelQueueItem(idx, itemId);
    return true;
  }
  const oldText = target.text;
  if (oldText === nextText) {
    renderReasoningPanelFollowUpQueueUi(idx);
    return false;
  }
  target.text = nextText;
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][edit]", {
      panel_id: idx,
      queue_item_id: itemId,
      old_text: String(oldText || "").slice(0, 160),
      new_text: nextText.slice(0, 160)
    });
  } catch (_) {}
  return true;
}

function beginEditReasoningPanelQueueItem(laneIdx, itemId) {
  const panel = getReasoningPanelElementByLaneIdx(laneIdx);
  if (!(panel instanceof HTMLElement)) return;
  const li = panel.querySelector(
    `.vera-reasoning-queue-item[data-queue-item-id="${itemId}"]`
  );
  if (!(li instanceof HTMLElement)) return;
  const textEl = li.querySelector(".vera-reasoning-queue-item-text");
  if (!(textEl instanceof HTMLElement)) return;
  if (li.classList.contains("is-editing")) return;
  li.classList.add("is-editing");
  const oldText = textEl.textContent || "";
  const input = document.createElement("textarea");
  input.className = "vera-reasoning-queue-edit-input";
  input.rows = 2;
  input.value = oldText;
  textEl.replaceWith(input);
  input.focus();
  input.select();
  const finish = (commit) => {
    if (!li.classList.contains("is-editing")) return;
    li.classList.remove("is-editing");
    if (commit) {
      editReasoningPanelQueueItem(laneIdx, itemId, input.value);
    } else {
      renderReasoningPanelFollowUpQueueUi(laneIdx);
    }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function scheduleReasoningPanelFollowUpQueueDrain(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return;
  window.setTimeout(() => drainReasoningPanelFollowUpQueue(idx), 0);
}

async function drainReasoningPanelFollowUpQueue(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return;
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  if (workModeReasoningLaneBusy.get(idx) === true) return;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  if (!queue.length) return;
  const next = queue.shift();
  workModeReasoningPanelFollowUpQueue.set(idx, queue);
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][dequeue_run]", {
      panel_id: idx,
      queue_item_id: next?.id || null,
      text: String(next?.text || "").slice(0, 160),
      queue_length_after: queue.length
    });
  } catch (_) {}
  // Switch to the originating panel so the frozen turn context picks the
  // right lane. The user can switch back manually after; this guarantees
  // the queued follow-up runs in the panel where it was queued.
  try {
    const activeIdxNow = getActiveReasoningLaneIndex();
    if (activeIdxNow !== idx && typeof activateReasoningTab === "function") {
      activateReasoningTab(idx);
    }
  } catch (_) {}
  try {
    await sendVeraWorkModeTypedInferTurn(next.text, {
      ...(next.opts || {}),
      __fromReasoningPanelQueue: true,
      __reasoningPanelQueueLaneIdx: idx
    });
  } catch (err) {
    try {
      console.warn("[QUEUE_DEBUG][dequeue_run_error]", {
        panel_id: idx,
        queue_item_id: next?.id || null,
        error: String((err && err.message) || err || "")
      });
    } catch (_) {}
  }
}

function clearReasoningPanelFollowUpQueueForIdx(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return;
  workModeReasoningPanelFollowUpQueue.delete(idx);
  renderReasoningPanelFollowUpQueueUi(idx);
}

window.workModeReasoningPanelQueue = {
  enqueue: enqueueReasoningPanelFollowUp,
  delete: deleteReasoningPanelQueueItem,
  edit: editReasoningPanelQueueItem,
  render: renderReasoningPanelFollowUpQueueUi,
  drain: drainReasoningPanelFollowUpQueue,
  clear: clearReasoningPanelFollowUpQueueForIdx,
  list: (laneIdx) =>
    getReasoningPanelFollowUpQueueForIdx(laneIdx).map((it) => ({ ...it }))
};

function workModeTypedQueueItemHasPayload(item) {
  const txt = String(item?.text ?? "").trim();
  const files = Array.isArray(item?.opts?.reasoningAttachments)
    ? item.opts.reasoningAttachments.filter((f) => f instanceof File && f.size)
    : [];
  return Boolean(txt || files.length);
}

function enqueueWorkModeTypedTurn(text, opts = {}) {
  if (workModeTypedTurnQueue.length >= WORK_MODE_TYPED_TURN_QUEUE_MAX) {
    console.warn("[WorkMode] typed queue full; dropping new request", {
      max: WORK_MODE_TYPED_TURN_QUEUE_MAX
    });
    try {
      console.info("[reasoning_queue_omitted]", {
        turn_id: null,
        lane_id: null,
        reason: "typed_turn_queue_max"
      });
    } catch (_) {}
    return false;
  }
  workModeTypedTurnQueue.push({
    text: String(text || ""),
    opts: { ...opts, __fromQueue: true }
  });
  try {
    const qFiles = Array.isArray(opts?.reasoningAttachments)
      ? opts.reasoningAttachments.filter((f) => f instanceof File && f.size)
      : [];
    console.info("[reasoning_queue_enqueue]", {
      turn_id: null,
      lane_id: null,
      has_files: qFiles.length > 0,
      file_count: qFiles.length,
      text_preview: String(text || "").slice(0, 120),
      queue_len: workModeTypedTurnQueue.length
    });
  } catch (_) {}
  return true;
}

function isWorkModeTypedTurnBlocked() {
  /* Typed lines queue only when the voice `/infer` chain is saturated; reasoning runs in parallel per panel. */
  return workModeTypedVoiceInferDepth >= WORK_MODE_TYPED_VOICE_CHAIN_MAX;
}

/** Total typed Work-Mode turns currently in flight (voice infer chain) + queued. */
function countPendingWorkModeTypedTurns() {
  return workModeTypedVoiceInferDepth + workModeTypedTurnQueue.length;
}

/**
 * True when there are already `WORK_MODE_TYPED_PENDING_MAX` typed turns in
 * flight or queued. Used to refuse a brand-new keyboard input at the entry
 * point — the same UX as the non-work-mode "3 user turns before VERA replies"
 * block (see `sendTextMessage`).
 */
function isWorkModeTypedTurnAtHardCap() {
  return countPendingWorkModeTypedTurns() >= WORK_MODE_TYPED_PENDING_MAX;
}

async function drainWorkModeTypedTurnQueue() {
  if (workModeTypedQueueDraining) return;
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  workModeTypedQueueDraining = true;
  try {
    while (workModeTypedTurnQueue.length > 0) {
      if (isWorkModeTypedTurnBlocked()) break;
      const next = workModeTypedTurnQueue.shift();
      if (!workModeTypedQueueItemHasPayload(next)) {
        try {
          console.info("[reasoning_queue_omitted]", {
            turn_id: null,
            lane_id: null,
            reason: "empty_queue_item_no_text_no_files"
          });
        } catch (_) {}
        continue;
      }
      try {
        const qFiles = Array.isArray(next.opts?.reasoningAttachments)
          ? next.opts.reasoningAttachments.filter((f) => f instanceof File && f.size)
          : [];
        console.info("[reasoning_typed_queue_drain]", {
          has_files: qFiles.length > 0,
          file_count: qFiles.length,
          text_preview: String(next.text || "").slice(0, 120)
        });
      } catch (_) {}
      await sendVeraWorkModeTypedInferTurn(next.text, next.opts || {});
    }
  } finally {
    workModeTypedQueueDraining = false;
  }
}

function scheduleWorkModeTypedQueueDrain() {
  window.setTimeout(() => {
    void drainWorkModeTypedTurnQueue();
  }, 0);
}

window.clearWorkModeReasoningPending = function clearWorkModeReasoningPending() {
  workModeReasoningConfirmPending = null;
  clearVeraWorkModeClientTimer();
};

function isVeraWorkModeOn() {
  return Boolean(document.getElementById("vera-app")?.classList.contains("work-mode"));
}

window.layoutVeraWorkModePanels = function layoutVeraWorkModePanels(on) {
  const pane = document.getElementById("vera-side-pane");
  const musicBody = document.getElementById("vera-wm-music-body");
  const chatMain = document.querySelector("#vera-app .chat-main");
  if (!pane || !musicBody || !chatMain) return;
  try {
    if (on) {
      if (pane.parentElement !== musicBody) musicBody.appendChild(pane);
      const hasProductivityMarkup =
        Boolean(pane.innerHTML.trim()) && pane.dataset.sidePaneKind === "productivity";
      if (!hasProductivityMarkup) {
        renderProductivityPanel();
      } else if (pane.hidden) {
        restoreProductivityPanel("vera");
      }
      applyWorkModeLeftPaneLayoutFromStorage();
    } else if (pane.parentElement !== chatMain) {
      chatMain.appendChild(pane);
    }
  } catch (e) {
    console.warn("[WorkMode] layout panes", e);
  }
};

window.ensureWorkModeVoiceUiActive = async function ensureWorkModeVoiceUiActive() {
  try {
    if (window.matchMedia("(max-width: 768px)").matches) return;
    if (appModePrefix() !== "vera") return;
    listeningMode = "continuous";
    inputMuted = false;
    updateMuteInputButton();
    await initMic();
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    listening = true;
    if (!processing && getAudioEl()?.paused) {
      startListening();
    }
  } catch (e) {
    console.warn("[WorkMode] ensure voice UI active", e);
  }
};
window.ensureVeraVoiceUiActive = window.ensureWorkModeVoiceUiActive;

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Models often mix Markdown **bold** with raw <strong>/<b> (sometimes spaced: `< /strong >`).
 * Convert to Markdown ** / * so the reasoning pipeline stays Markdown-only until the final HTML pass in `inline()`.
 */
function normalizeReasoningHtmlishMarkdown(raw) {
  let s = String(raw || "").replace(/\r/g, "");
  for (let pass = 0; pass < 4; pass += 1) {
    s = s
      .replace(/\*\*\s*<\s*\/\s*(strong|b)\s*>/gi, "**")
      .replace(/<\s*\/\s*(strong|b)\s*>\s*\*\*/gi, "**")
      .replace(/\*\*\s*<\s*(strong|b)\b[^>]*>/gi, "**")
      .replace(/<\s*(strong|b)\b[^>]*>\s*\*\*/gi, "**");
  }
  s = s.replace(/<\s*\/\s*(strong|b)\s*><\s*(strong|b)\b[^>]*>/gi, "**");
  for (let i = 0; i < 24; i += 1) {
    const m = s.match(/<\s*(strong|b)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/i);
    if (!m) break;
    const inner = String(m[2] || "").replace(/\*\*/g, "");
    s = `${s.slice(0, m.index)}**${inner}**${s.slice(m.index + m[0].length)}`;
  }
  for (let i = 0; i < 24; i += 1) {
    const m = s.match(/<\s*(em|i)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/i);
    if (!m) break;
    const inner = String(m[2] || "").replace(/\*/g, "");
    s = `${s.slice(0, m.index)}*${inner}*${s.slice(m.index + m[0].length)}`;
  }
  s = s.replace(/<\s*\/\s*(strong|b)\s*>/gi, "**");
  s = s.replace(/<\s*(strong|b)\b[^>]*>/gi, "**");
  s = s.replace(/<\s*\/\s*(em|i)\s*>/gi, "*");
  s = s.replace(/<\s*(em|i)\b[^>]*>/gi, "*");
  for (let j = 0; j < 16; j += 1) {
    const prev = s;
    s = s.replace(/\*{4,}/g, "**");
    if (s === prev) break;
  }
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*(\/?)\s*(strong|b|em|i)\b[^>]*$/i, "");
  return s;
}

/**
 * Last-chance cleanup before render: orphan/malformed emphasis tags → Markdown markers
 * (does not touch `<` that are not tag-like, beyond emphasis/break patterns).
 */
function defensiveReasoningMarkdownStripLooseHtml(s) {
  let t = String(s || "");
  for (let pass = 0; pass < 6; pass += 1) {
    const prev = t;
    t = t.replace(/<\s*\/\s*(strong|b)\s*>\s*<\s*(strong|b)\b[^>]*>/gi, "**");
    t = t.replace(/<\s*(strong|b)\b[^>]*>\s*<\s*\/\s*(strong|b)\s*>/gi, "**");
    t = t.replace(/<\s*\/\s*(strong|b)\s*>/gi, "**");
    t = t.replace(/<\s*(strong|b)\b[^>]*>/gi, "**");
    t = t.replace(/<\s*\/\s*(em|i)\s*>/gi, "*");
    t = t.replace(/<\s*(em|i)\b[^>]*>/gi, "*");
    t = t.replace(/<\s*br\s*\/?>/gi, "\n");
    for (let j = 0; j < 8; j += 1) {
      const p2 = t;
      t = t.replace(/\*{4,}/g, "**");
      if (t === p2) break;
    }
    if (t === prev) break;
  }
  return t;
}

function splitGfmTableRow(line) {
  let row = String(line ?? "").trim();
  if (!row.includes("|")) return [];
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((c) => c.trim());
}

function isGfmTableSeparatorRow(line) {
  const cells = splitGfmTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(String(cell).replace(/\s+/g, "")));
}

/**
 * Render a GFM-style pipe table; `rows` must include header, separator, then body lines.
 */
function renderWorkModeGfmTable(rows, inlineFn) {
  if (!rows || rows.length < 2 || !isGfmTableSeparatorRow(rows[1])) {
    return `<p>${inlineFn(rows.map((r) => String(r).trim()).join(" "))}</p>`;
  }
  const headerCells = splitGfmTableRow(rows[0]);
  const colCount = Math.max(2, headerCells.length);
  let out = '<div class="vera-md-table-wrap"><table class="vera-md-table"><thead><tr>';
  for (let i = 0; i < colCount; i++) {
    out += `<th scope="col">${inlineFn(headerCells[i] ?? "")}</th>`;
  }
  out += "</tr></thead><tbody>";
  for (let r = 2; r < rows.length; r++) {
    const cells = splitGfmTableRow(rows[r]);
    out += "<tr>";
    for (let i = 0; i < colCount; i++) {
      out += `<td>${inlineFn(cells[i] ?? "")}</td>`;
    }
    out += "</tr>";
  }
  out += "</tbody></table></div>";
  return out;
}

/** Map ```fence language id to highlight.js grammar id when registered. */
function mapReasoningFenceLangToHljs(raw) {
  const k = String(raw || "")
    .trim()
    .toLowerCase();
  if (!k) return null;
  const aliases = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    zsh: "bash",
    shell: "bash",
    yml: "yaml",
    md: "markdown",
    cpp: "cpp",
    cxx: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    fs: "fsharp",
    kt: "kotlin",
    ps1: "powershell",
    ps: "powershell"
  };
  const mapped = aliases[k] || k;
  try {
    if (typeof hljs !== "undefined" && typeof hljs.getLanguage === "function" && hljs.getLanguage(mapped)) {
      return mapped;
    }
  } catch (_) {}
  try {
    if (typeof hljs !== "undefined" && typeof hljs.getLanguage === "function" && hljs.getLanguage(k)) {
      return k;
    }
  } catch (_) {}
  return null;
}

/** SVG: overlapping rectangles (standard “copy” affordance). */
const VERA_REASONING_CODE_COPY_ICON =
  '<svg class="vera-md-code-copy-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
const VERA_REASONING_CODE_COPIED_ICON =
  '<svg class="vera-md-code-copy-icon vera-md-code-copy-icon--ok" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';

function formatReasoningCodeBlock(code, langHint) {
  const raw = String(code ?? "");
  const esc = escapeHtml(raw);
  let inner = esc;
  let codeClass = "vera-md-code";
  try {
    if (typeof hljs !== "undefined" && raw.length > 0) {
      const lang = mapReasoningFenceLangToHljs(langHint);
      if (lang) {
        const r = hljs.highlight(raw, { language: lang, ignoreIllegals: true });
        inner = r.value;
        codeClass = `hljs vera-md-code language-${lang}`;
      } else {
        const r = hljs.highlightAuto(raw, [
          "javascript",
          "typescript",
          "python",
          "json",
          "bash",
          "html",
          "xml",
          "css",
          "java",
          "go",
          "rust",
          "cpp",
          "csharp",
          "sql",
          "php",
          "ruby",
          "kotlin",
          "swift"
        ]);
        inner = r.value;
        codeClass = `hljs vera-md-code language-${r.language || "plaintext"}`;
      }
    }
  } catch (_) {
    inner = esc;
  }
  const labelRaw = String(langHint || "").trim();
  const toolbarLabel = labelRaw ? labelRaw : "auto";
  return (
    `<div class="vera-md-code-frame">` +
    `<div class="vera-md-code-toolbar">` +
    `<span class="vera-md-code-lang">${escapeHtml(toolbarLabel)}</span>` +
    `<button type="button" class="vera-md-code-copy" title="Copy code" aria-label="Copy code">${VERA_REASONING_CODE_COPY_ICON}</button></div>` +
    `<pre class="vera-md-pre"><code class="${codeClass}">${inner}</code></pre></div>`
  );
}

/** LaTeX / model habit: `\$` or `\\$` before currency — show a normal dollar in HTML. */
function unwrapTexDollars(s) {
  return String(s || "").replace(/\\+\$/g, "$");
}

/**
 * Replace `\boxed{ ... }` (balanced braces) with private-use placeholders so inner `$` does not
 * break `$...$` math splitting. Full `\boxed{...}` strings are appended to `outLatex`.
 * Extraction runs on the full markdown before paragraph/list splitting so placeholders are never orphaned.
 */
const VERA_BOXED_PH_OPEN = "\uE000";
const VERA_BOXED_PH_CLOSE = "\uE001";

/** `\boxed{...}` is math-mode; bare `$` before digits is currency and breaks KaTeX — emit `\$…`. */
function normalizeCurrencyDollarsInBoxedInner(inner) {
  return String(inner || "").replace(/\$(?=\d)/g, "\\$");
}

function extractLatexBoxedPlaceholders(s, outLatex) {
  const src = String(s || "");
  let out = "";
  let i = 0;
  const re = /\\boxed(?:\s*)\{/g;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) {
      out += src.slice(i);
      break;
    }
    const k = m.index;
    out += src.slice(i, k);
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let p = bodyStart;
    while (p < src.length && depth > 0) {
      const c = src[p++];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
    }
    if (depth !== 0) {
      out += src.slice(k, Math.min(k + m[0].length, src.length));
      i = k + m[0].length;
      continue;
    }
    const inner = normalizeCurrencyDollarsInBoxedInner(src.slice(bodyStart, p - 1));
    const full = `\\boxed{${inner}}`;
    const id = outLatex.length;
    outLatex.push(full);
    out += `${VERA_BOXED_PH_OPEN}BOX${id}${VERA_BOXED_PH_CLOSE}`;
    i = p;
  }
  return out;
}

function renderWorkModeMarkdown(el, markdown, summaryText = "") {
  if (!el) return;
  const globalBoxed = [];
  const mdNormalized = defensiveReasoningMarkdownStripLooseHtml(
    normalizeReasoningHtmlishMarkdown(String(markdown || ""))
  );
  const mdWithBoxPh = extractLatexBoxedPlaceholders(mdNormalized.replace(/\r/g, ""), globalBoxed);
  const lines = mdWithBoxPh.split("\n");
  let olItemSeq = 0;
  const katexRenderOpts = (displayMode) => ({
    throwOnError: false,
    displayMode,
    strict: "ignore",
    trust: true,
  });
  const renderMath = (src, displayMode) => {
    const normalized = String(src || "")
      .replace(/\u2019/g, "'")
      .replace(/\u2018/g, "'")
      .replace(/\u201c/g, '"')
      .replace(/\u201d/g, '"');
    const cleaned = unwrapTexDollars(normalized);
    try {
      if (window.katex && typeof window.katex.renderToString === "function") {
        return window.katex.renderToString(cleaned, katexRenderOpts(displayMode));
      }
    } catch (_) {}
    return null;
  };
  const applyInlineMath = (escapedHtml) => {
    const withDisplayMath = escapedHtml
      .replace(
        /\\\[(.+?)\\\]/g,
        (_, expr) => renderMath(expr, true) || `\\[${expr}\\]`
      )
      .replace(
        /\$\$(.+?)\$\$/g,
        (_, expr) => renderMath(expr, true) || `$$${expr}$$`
      );
    const withParenMath = withDisplayMath.replace(
      /\\\((.+?)\\\)/g,
      (_, expr) => renderMath(expr, false) || `\\(${expr}\\)`
    );
    return withParenMath.replace(
      /\$(?!\s)(.+?)(?<!\s)\$/g,
      (_, expr) => renderMath(expr, false) || `$${expr}$`
    );
  };
  const inline = (text) => {
    let t = escapeHtml(text);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `@@CODE${codes.length - 1}@@`;
    });
    t = unwrapTexDollars(t);
    /* Emphasis → HTML only inside this renderer, after escape (upstream stays Markdown-only). */
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    t = applyInlineMath(t);
    t = t.replace(/@@CODE(\d+)@@/g, (_, idx) => codes[Number(idx)] ?? "");
    return t;
  };

  // Keep summaryText for voice/history plumbing, but do not render it in the reasoning panel UI.
  let html = "";
  let inCode = false;
  let codeFenceLang = "";
  const codeLines = [];
  let listType = "";
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    if (para.length >= 2 && isGfmTableSeparatorRow(para[1])) {
      html += renderWorkModeGfmTable(para, inline);
    } else {
      html += `<p>${inline(para.join(" "))}</p>`;
    }
    para = [];
  };
  const closeList = () => {
    if (listType) {
      html += listType === "ol" ? "</ol>" : "</ul>";
      listType = "";
    }
  };

  for (let li = 0; li < lines.length; li += 1) {
    const raw = lines[li] ?? "";
    const line = raw;
    const fenceTrim = line.trim();
    if (fenceTrim.startsWith("```")) {
      flushPara();
      closeList();
      if (!inCode) {
        inCode = true;
        codeFenceLang = fenceTrim.slice(3).trim();
        codeLines.length = 0;
      } else {
        inCode = false;
        html += formatReasoningCodeBlock(codeLines.join("\n"), codeFenceLang);
        codeFenceLang = "";
        codeLines.length = 0;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const dispDollar = line.match(/^\s*\$\$(.+?)\$\$\s*$/);
    if (dispDollar) {
      flushPara();
      closeList();
      const block = renderMath(dispDollar[1], true);
      html += block || `<pre><code>${escapeHtml(unwrapTexDollars(dispDollar[1]))}</code></pre>`;
      continue;
    }
    const dispBracket = line.match(/^\s*\\\[(.+?)\\\]\s*$/);
    if (dispBracket) {
      flushPara();
      closeList();
      const block = renderMath(dispBracket[1], true);
      html += block || `<pre><code>${escapeHtml(unwrapTexDollars(dispBracket[1]))}</code></pre>`;
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      const lvl = h[1].length;
      html += `<h${lvl}>${inline(h[2].trim())}</h${lvl}>`;
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType && listType !== "ol") closeList();
      if (!listType) {
        listType = "ol";
        const startAttr = olItemSeq > 0 ? ` start="${olItemSeq + 1}"` : "";
        html += `<ol${startAttr}>`;
      }
      olItemSeq += 1;
      html += `<li>${inline(ol[1])}</li>`;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType && listType !== "ul") closeList();
      if (!listType) {
        listType = "ul";
        html += "<ul>";
      }
      html += `<li>${inline(ul[1])}</li>`;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      let continuesList = false;
      if (listType) {
        for (let j = li + 1; j < lines.length; j += 1) {
          const rawNext = lines[j] ?? "";
          const nextTrim = String(rawNext).trim();
          if (!nextTrim) continue;
          continuesList =
            listType === "ol"
              ? /^\s*\d+\.\s+/.test(rawNext)
              : listType === "ul"
                ? /^\s*[-*]\s+/.test(rawNext)
                : false;
          break;
        }
      }
      if (!continuesList) closeList();
      continue;
    }
    if (listType) closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  if (inCode) {
    html += formatReasoningCodeBlock(codeLines.join("\n"), codeFenceLang);
  }
  for (let bi = 0; bi < globalBoxed.length; bi += 1) {
    const ph = `${VERA_BOXED_PH_OPEN}BOX${bi}${VERA_BOXED_PH_CLOSE}`;
    const rendered =
      renderMath(globalBoxed[bi], false) || escapeHtml(globalBoxed[bi]);
    html = html.split(ph).join(rendered);
  }
  html = html.replace(/@@BOX\d+@@/g, "");
  el.innerHTML = html;
}

/** Only scroll to the latest content if the user is already near the bottom (so they can read upward while streaming). */
function maybeReasoningScrollToLatest(scrollHost, opts = {}) {
  const el = scrollHost;
  if (!(el instanceof HTMLElement)) return;
  const threshold = Number.isFinite(Number(opts.thresholdPx)) ? Number(opts.thresholdPx) : 96;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom <= threshold) {
    el.scrollTop = el.scrollHeight;
  }
}

async function drainReasoningNdjsonMarkdownTail(reader, initialTail, mdEl, decoder, opts = {}) {
  let buf = initialTail || "";
  let markdownAcc = mdEl?.dataset.markdownAcc || "";
  const summaryText = mdEl?.dataset.summaryText || "";
  const streamLaneId = String(opts.streamLaneId || "").trim();
  const turnContext = opts.turnContext || null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      for (;;) {
        const n = buf.indexOf("\n");
        if (n < 0) break;
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === "markdown" && o.text && mdEl) {
          if (turnContext && streamLaneId && !workModeTurnLaneGuard(turnContext, streamLaneId, "reasoning_chunk_append")) {
            continue;
          }
          if (turnContext instanceof Object) {
            const turnPanel = mdEl.closest(".vera-reasoning-tab-panel");
            if (turnPanel instanceof HTMLElement) {
              const turnDomLane = getWorkModeReasoningLaneId(Number(turnPanel.dataset.tabIndex));
              if (turnDomLane && streamLaneId && turnDomLane !== streamLaneId) {
                workModeTurnLaneGuard(turnContext, turnDomLane, "reasoning_chunk_append_dom");
                continue;
              }
            }
          }
          logWorkModeLaneInvariant("reasoning_chunk_append", turnContext?.turn_lane_id || streamLaneId, streamLaneId, {
            turn_id: turnContext?.turn_id || null,
            current_active_dom_lane_id: getActiveDomReasoningLaneId() || null
          });
          console.info("[reasoning_chunk_append]", {
            turn_id: turnContext?.turn_id || null,
            stream_lane_id: streamLaneId || null,
            current_active_dom_lane_id: getActiveDomReasoningLaneId() || null
          });
          markdownAcc += String(o.text);
          mdEl.dataset.markdownAcc = markdownAcc;
          renderWorkModeMarkdown(mdEl, markdownAcc, summaryText);
          const scrollHost = mdEl.closest(".vera-reasoning-scroll") || mdEl;
          maybeReasoningScrollToLatest(scrollHost);
        }
      }
      if (done) break;
    }
  } catch (_) {}
  if (typeof opts.onDone === "function") {
    try {
      opts.onDone({ markdownAcc, summaryText });
    } catch (_) {}
  }
}

function extractWorkModeReasoningSummaryAnswerLine(summaryText) {
  const first = String(summaryText || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return first || "";
}

function stripLegacyReasoningLaneNamesInSummary(text) {
  let s = String(text || "");
  const subs = [
    [/\bthread\s*1\s*\(\s*atlas\s*\)/gi, "Panel 1"],
    [/\bthread\s*2\s*\(\s*echo\s*\)/gi, "Panel 2"],
    [/\bthread\s*3\s*\(\s*nova\s*\)/gi, "Panel 3"],
    [/\bin\s+atlas\b/gi, "in Panel 1"],
    [/\bin\s+echo\b/gi, "in Panel 2"],
    [/\bin\s+nova\b/gi, "in Panel 3"],
    [/\bto\s+atlas\b/gi, "to Panel 1"],
    [/\bto\s+echo\b/gi, "to Panel 2"],
    [/\bto\s+nova\b/gi, "to Panel 3"],
    [/\bon\s+atlas\b/gi, "on Panel 1"],
    [/\bon\s+echo\b/gi, "on Panel 2"],
    [/\bon\s+nova\b/gi, "on Panel 3"]
  ];
  for (const [re, rep] of subs) s = s.replace(re, rep);
  return s;
}

function normalizeWorkModeReasoningSummary(summaryText, laneLabel = "", opts = {}) {
  const outputLaneIdx = opts.outputLaneIdx;
  const focusLaneIdx = opts.focusLaneIdx;
  const samePanel =
    outputLaneIdx != null &&
    focusLaneIdx != null &&
    Number(outputLaneIdx) === Number(focusLaneIdx);
  const handoffLine = samePanel
    ? ""
    : laneLabel
      ? `Opening full explanation in ${laneLabel}.`
      : "Opening full explanation now.";
  const firstRawLine = stripLegacyReasoningLaneNamesInSummary(
    String(summaryText || "")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
  let answerLine = firstRawLine.replace(/\s+/g, " ").trim();
  answerLine = answerLine.replace(/^["']+|["']+$/g, "").trim();
  answerLine = answerLine.replace(/\bI'm opening .*/i, "").trim();
  const sentenceMatch = answerLine.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) answerLine = sentenceMatch[1].trim();
  if (!answerLine) answerLine = "Here is the key idea in one line.";
  if (!/[.!?]$/.test(answerLine)) answerLine += ".";
  const text = handoffLine ? `${answerLine}\n${handoffLine}` : answerLine;
  return {
    answerLine,
    handoffLine,
    text
  };
}

/** Mirrors `app.py` `clean_action_query` for work-mode panel slot strings. */
function cleanWorkModeActionQueryUi(text) {
  let value = String(text ?? "")
    .trim()
    .replace(/^[\s'".,;:!?]+|[\s'".,;:!?]+$/g, "");
  value = value.replace(/\s+(?:right now|for me|please)\s*$/i, "").trim();
  value = value.replace(/\s+(?:also|and)\s+(?:why|what|how)\b.*$/i, "").trim();
  return value.replace(/^[\s'".,;:!?]+|[\s'".,;:!?]+$/g, "").trim();
}

/**
 * Tab-title navigation without requiring "panel" (mirrors `app.py` `_go_to_reasoning_panel_query_heuristic`).
 * Returns a short query string or null.
 */
function goToReasoningPanelQueryHeuristicUi(userText) {
  const s = String(userText ?? "").trim();
  if (!s) return null;
  const lowered = s.toLowerCase();
  let m = s.match(
    /\b(?:can you|could you|please)\s+(?:go to|jump to|switch to|change to|show|select|use|open)\s+(?:the\s+|a\s+|my\s+)?(.+?)(?:\s+(?:reasoning\s+)?(?:panel|space|tab|page))?\s*[?.!]*\s*$/i
  );
  if (!m) {
    m = s.match(
      /\b(?:go to|jump to|switch to|change to|show|select|use|open)\s+(?:the\s+|a\s+|my\s+)?(.+?)(?:\s+(?:reasoning\s+)?(?:panel|space|tab|page))?\s*[?.!]*\s*$/i
    );
  }
  if (!m) return null;
  const q = cleanWorkModeActionQueryUi(m[1]);
  if (!q || q.length < 2) return null;
  if (/^\d+$/.test(q)) return null;
  const low = q.toLowerCase().trim();
  const stop = new Set([
    "sleep",
    "bed",
    "home",
    "school",
    "dinner",
    "lunch",
    "breakfast",
    "work",
    "church",
    "google",
    "youtube",
    "spotify",
    "settings"
  ]);
  if (stop.has(low)) return null;
  if (/^(?:explain|describe|tell me|help me|what is|what's|whats|how does|how do|why does|why do)\b/i.test(q)) {
    return null;
  }
  const hadTabWord = /\b(?:reasoning|panel|tab|workspace|page)\b/i.test(lowered);
  if (!hadTabWord && !/\b(?:go\s+to|jump\s+to|switch\s+to|change\s+to)\b/i.test(lowered)) {
    return null;
  }
  if (!hadTabWord && q.length < 10) return null;
  return q;
}

/**
 * True when the user is only asking to switch reasoning tabs (mirrors `app.py` `_explicit_work_mode_panel_navigation`).
 * Used to skip `maybePrepareWorkModeReasoning` so navigation does not also spawn a reasoning stream.
 */
function isExplicitWorkModePanelNavigationIntent(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (
    /\b(?:go to|jump to|switch to|change to|show|select|use|open)\s+(?:the\s+|a\s+|my\s+)?(?:reasoning\s+)?(?:panel|space|tab|page)\s*#?\s*\d+\b/i.test(
      low
    )
  ) {
    return true;
  }
  if (
    /\b(?:go to|jump to|switch to|change to|show|select|use|open)\s+(?:the\s+|a\s+|my\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth)\s+(?:reasoning\s+)?(?:panel|space|tab|page)\b/i.test(
      low
    )
  ) {
    return true;
  }
  if (
    /\b(?:go to|jump to|switch to|change to|show|select|use|open)\b/i.test(low) &&
    /\b(?:reasoning\s+)?(?:panel|space|tab|page)\s*#?\s*\d+\b/i.test(low)
  ) {
    return true;
  }
  if (
    /\b(?:can you|could you|please)\s+(?:go to|jump to|switch to|change to|show|select|use|open)\b/i.test(s) &&
    /(?:reasoning\s+)?(?:panel|space|tab|page)\s*[?.!]*\s*$/i.test(s.trim())
  ) {
    return true;
  }
  if (
    /^(?:go to|jump to|switch to|change to|show|select|use|open)\b/i.test(s.trim()) &&
    /(?:reasoning\s+)?(?:panel|space|tab|page)\s*[?.!]*\s*$/i.test(s.trim())
  ) {
    return true;
  }
  return goToReasoningPanelQueryHeuristicUi(s) != null;
}

/** Multi-item planning / scheduling — route to reasoning and enable checklist Sync from markdown. */
function isLikelyWorkModePlanningIntent(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (isExplicitWorkModePanelNavigationIntent(raw)) return false;
  const t = raw.toLowerCase();
  if (/\b(help me plan|can you help me plan|help\s+us\s+plan|need a plan|make a plan|create a plan|come up with a plan)\b/.test(t)) {
    return true;
  }
  if (/\b(plan my|plan the|plan our|plan this week|plan my week|plan my day|weekly plan|study plan)\b/.test(t)) {
    return true;
  }
  const planningCue = /\b(plan|planning|roadmap|schedule|priorit|organi[sz]e|break\s+it\s+down|time\s*block|balance my)\b/.test(t);
  const multiWork =
    /\b(i have|i've got|i am juggling|working on|need to do|need to finish|due|homework|assignments?)\b/.test(t) &&
    /\b(and|plus|also|,)\b/.test(t);
  const workload = /\b(essay|essays|math|stat|stats|statistics|science|reading|paper|papers|exam|exams|problem sets?|projects?|classes?|courses?)\b/.test(
    t
  );
  if (planningCue && (multiWork || workload)) return true;
  if (/\bhow\s+(can|do|should)\s+i\b.*\b(schedule|plan|balance|fit\s+in|organize)\b/.test(t)) return true;
  return false;
}

/** Browser-local date/time so planning / SYNC CHECKLIST blocks are not placed in the past. */
function formatWorkModePlanningWallClockNow() {
  try {
    const d = new Date();
    const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
    const datePart = d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    let tz = "local";
    try {
      tz = new Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
    } catch (_) {}
    return `${weekday}, ${datePart} — ${timePart} (${tz})`;
  } catch (_) {
    return new Date().toString();
  }
}

function workModePlanningTimeInjectionPrefix() {
  return `[CURRENT LOCAL TIME (trust this as "now" for scheduling): ${formatWorkModePlanningWallClockNow()}]\n\n`;
}

const WORK_MODE_PLANNING_REASONING_INSTRUCTION_SUFFIX =
  "[Planning mode. Produce an ordered plan (blocks, days, or sessions as fits the user). " +
  "If CURRENT LOCAL TIME appears above, treat it as the earliest moment you may schedule work: every `[start-end]` range in ## SYNC CHECKLIST must lie entirely at or after that moment (no blocks wholly in the past), while still honoring explicit deadlines the user gave (e.g. due at 8pm). " +
  "After the main plan, add a markdown heading exactly: ## SYNC CHECKLIST\n" +
  "Under that heading use only checklist-style bullets: each top-level line must match `[start-end]: specific action` " +
  "(realistic times or dayparts, e.g. `[6:50pm-7:20pm]: Outline intro`). " +
  "Each top-level item needs 1–3 indented sub-bullets with concrete next steps. " +
  "In SYNC CHECKLIST do not include questions, question headings, or lines ending in `?`.]";

/** Matches server `app.py` `_is_generic_example_request` so short follow-ups carry Voice UI topic into reasoning. */
function isGenericExampleFollowUpText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  if (
    /\b(show(\s+me)?\s+an?\s+example|give(\s+me)?\s+an?\s+example|(can|could)\s+you\s+(show|give)(\s+me)?\s+an?\s+example|example\s+of\s+that|example\s+please|(another|one more)\s+example)\b/.test(
      t
    )
  ) {
    return true;
  }
  return /\b(need|want|got)\s+an?\s+example\b/.test(t);
}

/** Prior user line for `/infer` when this turn continues that topic (router + vague pronouns like “the north”). */
function computeWorkModeInferThreadAnchor(trimmed, priorThreadAnchor, continuePriorLane) {
  const cur = String(trimmed || "").trim();
  const prior = String(priorThreadAnchor || "").trim();
  if (!prior || prior === cur) return "";
  if (continuePriorLane) return prior;
  if (isGenericExampleFollowUpText(cur)) return prior;
  /* Classifier sometimes omits continue_prior_lane; same-thread code/proof asks still need the prior prompt for /infer. */
  if (isReasoningHeavySameThreadRequest(cur)) return prior;
  return "";
}

function workModeReasoningPrepOutcome(chainPromise, inferThreadAnchor, inferGatePromise, meta = {}) {
  const chain = chainPromise || Promise.resolve();
  const inferGate = inferGatePromise != null ? inferGatePromise : chain;
  return {
    chain,
    inferGate,
    inferThreadAnchor: String(inferThreadAnchor || "").trim(),
    reasoningHadFileUpload: Boolean(meta.reasoningHadFileUpload),
    reasoningUploadState: meta.reasoningUploadState || null,
    voiceTwoStage: meta.voiceTwoStage || { reasoningRouted: false },
    reasoningLaneId: String(meta.reasoningLaneId || "").trim(),
    turnContext: meta.turnContext || null
  };
}

/** Active reasoning lane from DOM at this instant (viewing tab / focus). */
function getActiveDomReasoningLaneId() {
  const focused = getFocusedWorkModeLaneId();
  if (focused) return focused;
  const idx = getActiveReasoningLaneIndex();
  if (idx != null && Number.isFinite(Number(idx))) {
    return getWorkModeReasoningLaneId(Number(idx)) || "";
  }
  return "";
}

/**
 * Immutable lane target for one user submission. Must be created synchronously at send time.
 * @returns {{ turn_id: string, turn_seq: number, turn_lane_id: string, turn_lane_title: string, user_text: string, submitted_at: number, source: 'keyboard'|'voice'|'upload', turn_intent: string, content_type_requested: string, stage2_completion_action: string } | null}
 */
function createWorkModeFrozenTurnContext({ userText, source, hasFiles } = {}) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return null;
  workModeTtsTurnSeqCounter += 1;
  const turn_seq = workModeTtsTurnSeqCounter;
  const turn_id = `wm-${turn_seq}`;
  const active_dom_lane_id_at_submit = getActiveDomReasoningLaneId();
  let turn_lane_id = active_dom_lane_id_at_submit || guessWorkModeTtsLaneId();
  const panel = getReasoningPanelElementByLaneId(turn_lane_id);
  if (panel instanceof HTMLElement) {
    const domLane = String(panel.dataset.laneId || "").trim();
    if (domLane) turn_lane_id = domLane;
  }
  const laneIdx = getReasoningLaneIndexFromLaneId(turn_lane_id);
  const turn_lane_title =
    panel instanceof HTMLElement
      ? getReasoningTabTopicLabel(panel)
      : getWorkModeLaneTitle(turn_lane_id) ||
        (laneIdx != null ? getWorkModeReasoningLaneLabel(laneIdx) : turn_lane_id);
  const src =
    source === "voice" || source === "upload" || source === "keyboard" ? source : "keyboard";
  const ut = String(userText || "").trim();
  const intentPack = classifyWorkModeTurnIntent(ut);
  const ctx = {
    turn_id,
    turn_seq,
    turn_lane_id,
    turn_lane_title,
    user_text: ut,
    submitted_at: Date.now(),
    source: src,
    turn_intent: intentPack.turn_intent,
    content_type_requested: intentPack.content_type_requested,
    stage2_completion_action: intentPack.stage2_completion_action
  };
  registerWorkModeFrozenTurn(ctx);
  try {
    console.info("[turn_submit]", {
      turn_id: ctx.turn_id,
      lane_id: ctx.turn_lane_id,
      has_files: Boolean(hasFiles)
    });
  } catch (_) {}
  logWorkModeLaneInvariant("turn_submit", ctx.turn_lane_id, ctx.turn_lane_id, {
    turn_id: ctx.turn_id,
    frozen_lane_title: ctx.turn_lane_title,
    active_dom_lane_id_at_submit: active_dom_lane_id_at_submit || null,
    source: ctx.source
  });
  return ctx;
}

function frozenTurnLaneIndex(turnContext) {
  if (!turnContext?.turn_lane_id) return null;
  const idx = getReasoningLaneIndexFromLaneId(turnContext.turn_lane_id);
  return idx != null && Number.isFinite(Number(idx)) ? Number(idx) : null;
}

/** @returns {boolean} true if allowed */
function workModeTurnLaneGuard(turnContext, attemptedLaneId, operation) {
  if (!turnContext?.turn_lane_id) return true;
  const frozen = String(turnContext.turn_lane_id).trim();
  const attempted = String(attemptedLaneId || "").trim();
  if (!attempted || attempted === frozen) return true;
  console.warn("[wrong_lane_guard]", {
    turn_id: turnContext.turn_id,
    frozen_lane_id: frozen,
    attempted_lane_id: attempted,
    operation: String(operation || "")
  });
  return false;
}

function workModeTtsMetaFromTurnContext(turnContext) {
  if (!turnContext?.turn_id) {
    return beginWorkModeUserTtsTurn(guessWorkModeTtsLaneId());
  }
  const lane_id = String(turnContext.turn_lane_id || "").trim() || "voice";
  workModeTtsGlobalGeneration += 1;
  workModeLatestTurnIdByLane.set(lane_id, turnContext.turn_id);
  return {
    turn_id: turnContext.turn_id,
    lane_id,
    generation_id: workModeTtsGlobalGeneration,
    turn_seq: Number(turnContext.turn_seq) || turnSeqFromTurnId(turnContext.turn_id)
  };
}

function workModeInferTurnSourceFromPath(path, hasUpload) {
  if (hasUpload) return "upload";
  const p = String(path || "").toLowerCase();
  if (p.includes("browser-asr") || p.includes("voice") || p.includes("ptt") || p.includes("asr")) {
    return "voice";
  }
  return "keyboard";
}

/** Latest completed reasoning lane snapshot for Voice `/infer` handoff (updated when NDJSON finishes). */
let activeWorkModeReasoningContext = null;
const workModeCompletedReasoningByLaneId = Object.create(null);
/** Frozen turn contexts by turn_id (submit-time lane target). */
const workModeFrozenTurnById = Object.create(null);

/**
 * Pipeline lane invariant: expected_lane_id is the frozen/submit target; actual is what the step used.
 * Logs [lane_invariant] on match and [lane_invariant_violation] on mismatch.
 */
function logWorkModeLaneInvariant(step, expectedLaneId, actualLaneId, meta = {}) {
  const expected = String(expectedLaneId || "").trim();
  const actual = String(actualLaneId || "").trim();
  const row = {
    step: String(step || ""),
    expected_lane_id: expected || null,
    actual_lane_id: actual || null,
    turn_id: meta.turn_id || null,
    routing: meta.routing || null,
    active_dom_lane_id: getActiveDomReasoningLaneId() || null,
    focused_lane_id: getFocusedWorkModeLaneId() || null,
    ...meta
  };
  if (expected && actual && expected !== actual) {
    console.warn("[lane_invariant_violation]", row);
  } else {
    console.info("[lane_invariant]", row);
  }
}

function registerWorkModeFrozenTurn(turnContext) {
  if (!turnContext?.turn_id) return;
  workModeFrozenTurnById[turnContext.turn_id] = { ...turnContext };
}

function getWorkModeFrozenTurn(turnId) {
  const id = String(turnId || "").trim();
  return id ? workModeFrozenTurnById[id] || null : null;
}

const WORK_MODE_MAIN_CONTEXT_PREVIEW_CAP = 220;

function truncateWorkModeRegistryExcerpt(text, cap = 12000) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (t.length <= cap) return t;
  return `${t.slice(0, cap)}\n…`;
}

function previewWorkModeRegistryText(text, cap = WORK_MODE_MAIN_CONTEXT_PREVIEW_CAP) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, cap);
}

/** Classify assistant completion for lane registry ranking (weaker → stronger). */
function classifyWorkModeCompletionType(text, opts = {}) {
  const t = String(text || "").trim();
  if (!t) return "ack_status";
  const low = t.toLowerCase();
  const forceCode = Boolean(opts.code_or_math_generated);

  if (
    t.length < 110 &&
    !/```/.test(t) &&
    !forceCode &&
    (/\breasoning space\b/i.test(low) ||
      /^i['']?ll\b/i.test(t) ||
      /^sure\b/i.test(low) ||
      /^got it\b/i.test(low) ||
      /^working on\b/i.test(low))
  ) {
    return "ack_status";
  }

  if (
    t.length < 420 &&
    !/```/.test(t) &&
    !forceCode &&
    (/\b(need the problem|problem statement first|please (provide|clarify|specify)|what (problem|question)|unclear|missing (info|context|details)|can't proceed without|before i can)\b/i.test(
      low
    ) ||
      (/\?\s*$/.test(t) && t.length < 300))
  ) {
    return "clarification";
  }

  if (
    forceCode ||
    /```/.test(t) ||
    (t.length > 180 &&
      (/\b(proof|qed|theorem|lemma|corollary)\b/i.test(low) ||
        /\\[\[(]/.test(t) ||
        /\$[^$\n]{2,}\$/.test(t))) ||
    (t.length > 350 &&
      /\b(black.?scholes|option price|closed[- ]form|boundary condition|numerical solution)\b/i.test(low))
  ) {
    return "solution_code_proof";
  }

  if (
    (/\|.+\|/.test(t) && /\n\|[-:| ]+\|/.test(t)) ||
    (/\b(table|matrix|spreadsheet)\b/i.test(low) && t.length > 120) ||
    (/\b(calculation|computed|numerical)\b/i.test(low) && t.length > 150 && /[=≈]/.test(t))
  ) {
    return "calculation_table";
  }

  if (t.length > 100) return "explanation";
  return "ack_status";
}

function workModeRegistryHasSubstantiveMain(row) {
  if (!row) return false;
  return workModeCompletionRank(row.main_context_type) >= workModeCompletionRank("explanation");
}

/** Substantive solution/code/proof — safe to replace prior lane handoff. */
function workModeHandoffIsSubstantive(row) {
  if (!row || typeof row !== "object") return false;
  if (workModeRegistryHasSubstantiveMain(row)) return true;
  if (Boolean(row.code_or_math_generated)) return true;
  const md = String(
    row.latest_substantive_excerpt ||
      row.main_context_excerpt ||
      row.latest_markdown_preview ||
      row.latest_final_answer_excerpt ||
      ""
  ).trim();
  if (md.length > 120 || /```/.test(md)) return true;
  const sum = String(row.latest_reasoning_summary || "").trim();
  return sum.length > 48;
}

function normalizeLaneRegistryRow(row) {
  if (!row || typeof row !== "object") return null;
  const lid = String(row.lane_id || row.active_lane_id || "").trim();
  const title = String(row.title || row.lane_title || "").trim();
  const legacyMd = String(
    row.latest_visible_markdown ||
      row.latest_markdown_preview ||
      row.latest_final_answer_excerpt ||
      ""
  ).trim();
  const legacyTurn = String(row.latest_assistant_turn || legacyMd).trim();
  let mainExcerpt = String(row.main_context_excerpt || "").trim();
  let mainType = String(row.main_context_type || "").trim();
  if (!mainExcerpt && legacyMd) {
    mainExcerpt = legacyMd;
    mainType = mainType || classifyWorkModeCompletionType(mainExcerpt, row);
  }
  if (!mainType && mainExcerpt) {
    mainType = classifyWorkModeCompletionType(mainExcerpt, row);
  }
  const turnType =
    String(row.latest_turn_type || "").trim() ||
    classifyWorkModeCompletionType(legacyTurn || legacyMd, row);
  const substantive = String(row.latest_substantive_excerpt || "").trim();
  const clarification = String(row.latest_clarification_excerpt || "").trim();
  const subRank = workModeCompletionRank("explanation");
  const turnRank = workModeCompletionRank(turnType);
  const mainRank = workModeCompletionRank(mainType);
  return {
    lane_id: lid,
    active_lane_id: lid || String(row.active_lane_id || "").trim(),
    title,
    lane_title: title,
    last_user_request: String(row.last_user_request || "").trim(),
    prior_problem_anchor: String(row.prior_problem_anchor || "").trim(),
    latest_reasoning_summary: String(row.latest_reasoning_summary || "").trim(),
    latest_visible_markdown: legacyMd,
    latest_assistant_turn: legacyTurn,
    latest_substantive_excerpt:
      substantive ||
      (turnRank >= subRank && turnType !== "clarification" && turnType !== "ack_status"
        ? legacyTurn || legacyMd
        : mainRank >= subRank
          ? mainExcerpt
          : ""),
    latest_clarification_excerpt:
      clarification || (turnType === "clarification" ? legacyTurn || legacyMd : ""),
    main_context_excerpt: mainExcerpt,
    main_context_type: mainType || "ack_status",
    latest_turn_type: turnType,
    latest_markdown_preview: String(row.latest_markdown_preview || legacyMd).trim(),
    latest_final_answer_excerpt: String(row.latest_final_answer_excerpt || legacyMd).trim(),
    code_or_math_generated: Boolean(row.code_or_math_generated),
    stream_started_lane_id: String(row.stream_started_lane_id || lid).trim(),
    updated_at: Number(row.updated_at) || Date.now(),
    attachments: Array.isArray(row.attachments) ? row.attachments : []
  };
}

function mergeLaneRegistryCommit(existing, patch, opts = {}) {
  const lid = String(patch?.lane_id || patch?.active_lane_id || existing?.lane_id || "").trim();
  const prev = existing ? normalizeLaneRegistryRow(existing) : null;
  const incomingTurnText = String(
    patch?.latest_assistant_turn ||
      patch?.latest_visible_markdown ||
      patch?.latest_markdown_preview ||
      patch?.latest_final_answer_excerpt ||
      ""
  ).trim();
  const turnType =
    String(patch?.latest_turn_type || "").trim() ||
    classifyWorkModeCompletionType(incomingTurnText, patch);
  const turnRank = workModeCompletionRank(turnType);
  const cap = Number(opts.excerptCap) || 12000;
  const visibleMd = truncateWorkModeRegistryExcerpt(
    String(patch?.latest_visible_markdown || incomingTurnText || prev?.latest_visible_markdown || "").trim(),
    cap
  );
  const assistantTurn = truncateWorkModeRegistryExcerpt(
    incomingTurnText || visibleMd || prev?.latest_assistant_turn || "",
    cap
  );

  const next = prev
    ? { ...prev }
    : normalizeLaneRegistryRow({
        lane_id: lid,
        active_lane_id: lid,
        title: patch?.title || patch?.lane_title || ""
      }) || { lane_id: lid, active_lane_id: lid, title: "" };

  next.lane_id = lid;
  next.active_lane_id = lid;
  if (patch?.title || patch?.lane_title) {
    next.title = String(patch.title || patch.lane_title).trim();
    next.lane_title = next.title;
  }
  if (patch?.last_user_request) next.last_user_request = String(patch.last_user_request).trim();
  if (patch?.prior_problem_anchor) next.prior_problem_anchor = String(patch.prior_problem_anchor).trim();
  if (patch?.latest_reasoning_summary) {
    next.latest_reasoning_summary = String(patch.latest_reasoning_summary).trim();
  }
  if (visibleMd) next.latest_visible_markdown = visibleMd;
  if (assistantTurn) next.latest_assistant_turn = assistantTurn;
  next.latest_turn_type = turnType;
  if (patch?.code_or_math_generated != null) {
    next.code_or_math_generated = Boolean(patch.code_or_math_generated);
  }
  if (visibleMd) {
    next.latest_markdown_preview = truncateWorkModeRegistryExcerpt(visibleMd, 3500);
    next.latest_final_answer_excerpt = truncateWorkModeRegistryExcerpt(visibleMd, cap);
  }

  if (turnRank >= workModeCompletionRank("explanation")) {
    next.latest_substantive_excerpt = assistantTurn || visibleMd;
  } else if (turnType === "clarification") {
    next.latest_clarification_excerpt = assistantTurn || visibleMd;
  }

  const incomingMain = String(patch?.main_context_excerpt || "").trim();
  const incomingMainType =
    String(patch?.main_context_type || "").trim() ||
    classifyWorkModeCompletionType(incomingMain || assistantTurn || visibleMd, patch);
  const incomingMainRank = workModeCompletionRank(incomingMainType);
  const existingMainRank = workModeCompletionRank(next.main_context_type);
  const hasSubstantiveMain = workModeRegistryHasSubstantiveMain(next);
  const overwriteMain =
    opts.forceMainOverwrite === true ||
    incomingMainRank >= existingMainRank ||
    !hasSubstantiveMain;

  if (incomingMain && overwriteMain) {
    next.main_context_excerpt = truncateWorkModeRegistryExcerpt(incomingMain, cap);
    next.main_context_type = incomingMainType;
  } else if ((assistantTurn || visibleMd) && overwriteMain && incomingMainRank > workModeCompletionRank("ack_status")) {
    next.main_context_excerpt = truncateWorkModeRegistryExcerpt(
      incomingMain || assistantTurn || visibleMd,
      cap
    );
    next.main_context_type = incomingMainType;
  }

  if (Array.isArray(patch?.attachments)) {
    next.attachments = patch.attachments.slice();
  }

  next.updated_at = Date.now();
  return { row: next, overwriteMain, turnType, turnRank, incomingMainRank, existingMainRank };
}

function getVisibleMarkdownForLane(laneId) {
  const idx = findPanelIndexByStableLaneId(laneId);
  if (idx == null) return "";
  const panel = document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${Number(idx)}"]`
  );
  if (!panel) return collectWorkModeReasoningExcerptForLaneIndex(idx, 14000);
  const scroll = panel.querySelector(".vera-reasoning-md-panel, .vera-reasoning-scroll");
  if (!scroll) return collectWorkModeReasoningExcerptForLaneIndex(idx, 14000);

  const turns = [...scroll.querySelectorAll(".vera-reasoning-turn")];
  const chunks = [];
  const start = turns.length ? Math.max(0, turns.length - 6) : 0;
  for (let i = start; i < turns.length; i += 1) {
    const el = turns[i];
    const md = String(el?.dataset?.markdownAcc || "").trim();
    if (md) {
      chunks.push(md);
      continue;
    }
    const plain = String(el?.innerText || el?.textContent || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (plain.length > 48) chunks.push(plain);
  }
  let fromTurns = chunks.join("\n\n---\n\n");
  if (fromTurns.length < 500) {
    const accEls = [...scroll.querySelectorAll("[data-markdown-acc]")];
    const accChunks = accEls
      .map((el) => String(el.dataset.markdownAcc || "").trim())
      .filter((s) => s.length > 48);
    if (accChunks.length) {
      const joined = accChunks.join("\n\n---\n\n");
      if (joined.length > fromTurns.length) fromTurns = joined;
    }
  }
  if (fromTurns.length < 500) {
    const panelPlain = String(scroll.innerText || scroll.textContent || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (panelPlain.length > fromTurns.length) fromTurns = panelPlain;
  }
  return truncateWorkModeRegistryExcerpt(fromTurns || collectWorkModeReasoningExcerptForLaneIndex(idx, 14000), 14000);
}

function workModeVisibleLaneHasCompletedSolution(markdown) {
  const t = String(markdown || "").trim();
  if (t.length < 80) return false;
  const low = t.toLowerCase();
  const hasFinalTable =
    /\bfinal answers?\b/i.test(t) ||
    (/\|.+\|/.test(t) && /\n\|[-:| ]+\|/.test(t) && /delta|hedge|shares|investment|overnight|profit/i.test(low));
  const hasFinanceVars =
    /\b(strike|volatility|risk[- ]?free|stock price|black-?scholes|option price)\b/i.test(low) ||
    /\b(S|K|sigma|r|T)\s*[=:]/i.test(t) ||
    /\bS\s*=\s*\d/i.test(t);
  const hasNumericResults =
    /\bdelta\b/i.test(low) &&
    (/\bshares?\b/i.test(low) || /\busd\b/i.test(low) || /\bprofit\b/i.test(low) || /\d+\.\d+/.test(t));
  return hasFinalTable || (hasFinanceVars && hasNumericResults);
}

function workModeLaneAllowsAskForMissingInfo(markdown) {
  const t = String(markdown || "").trim();
  if (!t) return true;
  if (workModeVisibleLaneHasCompletedSolution(t)) return false;
  return t.length < 120;
}

function logLaneMainContextResolve(laneId, meta = {}) {
  const row = {
    lane_id: String(laneId || "").trim(),
    title: meta.title ?? getWorkModeLaneTitle(laneId) ?? "",
    latest_turn_type: meta.latest_turn_type ?? null,
    main_context_type: meta.main_context_type ?? null,
    main_context_preview: meta.main_context_preview ?? "",
    latest_visible_markdown_preview: meta.latest_visible_markdown_preview ?? "",
    overwrite_allowed: Boolean(meta.overwrite_allowed)
  };
  console.info("[lane_main_context_resolve]", row);
  try {
    console.table([row]);
  } catch (_) {}
}

/**
 * Resync registry from DOM, build lane context for reasoning_stream, log before model call.
 */
function prepareWorkModeReasoningModelCall(opts = {}) {
  let laneId = String(opts.laneId || "").trim();
  if (Object.prototype.hasOwnProperty.call(WORK_MODE_LEGACY_LANE_TO_INDEX, laneId)) {
    laneId = ensureStableLaneIdForPanelIndex(WORK_MODE_LEGACY_LANE_TO_INDEX[laneId]);
  }
  migrateLegacyLaneRegistryKeys();
  syncPanelStableLaneIdsInDom();

  const userText = String(opts.userText || "").trim();
  const turnContext = opts.turnContext || null;
  const requestHasCodeIntent =
    opts.requestHasCodeIntent != null
      ? Boolean(opts.requestHasCodeIntent)
      : detectWorkModeRequestHasCodeVoiceIntent(userText);

  const resync = resyncLaneMainContextFromVisibleDom(laneId, { silent: true });
  const handoff = resync.row || getWorkModeLaneHandoff(laneId);
  const visible = getVisibleMarkdownForLane(laneId);
  const mainExcerpt = String(handoff?.main_context_excerpt || visible || "").trim();
  const laneTitle =
    turnContext?.turn_lane_title || handoff?.title || handoff?.lane_title || getWorkModeLaneTitle(laneId) || "";

  const parts = [];
  if (mainExcerpt) {
    parts.push(
      "ACTIVE_LANE_PRIOR_CONTEXT (authoritative — visible reasoning panel for this frozen lane; " +
        "use for all follow-ups):\n" +
        truncateWorkModeRegistryExcerpt(mainExcerpt, 14000)
    );
  } else if (visible.trim()) {
    parts.push(
      "ACTIVE_LANE_VISIBLE_MARKDOWN (from panel DOM):\n" + truncateWorkModeRegistryExcerpt(visible, 14000)
    );
  }
  if (handoff?.last_user_request && handoff.last_user_request !== userText) {
    parts.push(`Last user request on this lane:\n${handoff.last_user_request}`);
  }
  if (handoff?.prior_problem_anchor) {
    parts.push(`Prior problem / thread anchor:\n${handoff.prior_problem_anchor}`);
  }
  if (handoff?.latest_reasoning_summary) {
    parts.push(`Latest reasoning summary:\n${handoff.latest_reasoning_summary}`);
  }

  const attSection = buildWorkModeLaneAttachmentContextSection(
    laneId,
    Array.isArray(opts.currentAttachmentMeta) ? opts.currentAttachmentMeta : [],
    handoff,
    turnContext?.turn_id ?? null
  );
  if (attSection) {
    parts.push(attSection);
  }

  const solutionVisible = workModeVisibleLaneHasCompletedSolution(visible || mainExcerpt);
  if (solutionVisible) {
    let rule =
      "The active lane already contains a completed solution. Treat the user's request as a follow-up " +
      "on that solution — reuse its numbers, variables, and conclusions.";
    if (requestHasCodeIntent) {
      rule +=
        " The user wants code (e.g. Python): implement using the visible solution context. " +
        "Do not ask for the full problem statement again.";
    } else {
      rule += " Do not ask for the full problem statement unless required variables are absent from the lane context.";
    }
    parts.push(`FOLLOW_UP_RULES:\n${rule}`);
  }

  const laneClientContext = parts.filter(Boolean).join("\n\n---\n\n");
  const cap = 18000;
  const laneClientContextCapped =
    laneClientContext.length > cap ? `${laneClientContext.slice(0, cap)}\n…` : laneClientContext;

  const willAsk = workModeLaneAllowsAskForMissingInfo(visible || mainExcerpt) && !solutionVisible;
  const debugRow = {
    turn_id: turnContext?.turn_id || null,
    frozen_lane_id: laneId,
    lane_title: laneTitle,
    main_context_type: handoff?.main_context_type || null,
    main_context_excerpt_preview: previewWorkModeRegistryText(mainExcerpt),
    visible_markdown_preview: previewWorkModeRegistryText(visible),
    visible_markdown_len: visible.length,
    model_user_text: userText.slice(0, 500),
    will_ask_for_missing_info_allowed: willAsk,
    request_has_code_intent: requestHasCodeIntent,
    lane_client_context_len: laneClientContextCapped.length
  };

  if (!opts.skipLog) {
    console.info("[reasoning_model_context]", debugRow);
    try {
      console.table([debugRow]);
    } catch (_) {}
    window.__veraLastReasoningModelContext = debugRow;
    updateWorkModeInferDebugOverlay({
      ...(window.__veraLastInferHandoffDebug || {}),
      reasoning_model_context: debugRow
    });
  }

  return {
    laneId,
    handoff,
    visible,
    mainExcerpt,
    laneClientContext: laneClientContextCapped,
    modelUserText: userText,
    debug: debugRow,
    willAskForMissingInfo: willAsk
  };
}

/**
 * If the visible panel has stronger content than registry main_context, upgrade before /infer.
 */
function resyncLaneMainContextFromVisibleDom(laneId, opts = {}) {
  const lid = String(laneId || "").trim();
  if (!lid) return { synced: false, row: null };
  const visible = getVisibleMarkdownForLane(lid);
  const existing = workModeCompletedReasoningByLaneId[lid];
  const existingNorm = existing ? normalizeLaneRegistryRow(existing) : null;
  const visibleType = classifyWorkModeCompletionType(visible, {
    from_visible_dom: true,
    code_or_math_generated: /```/.test(visible) || workModeVisibleLaneHasCompletedSolution(visible)
  });
  const visibleRank = workModeCompletionRank(visibleType);
  const existingMainRank = workModeCompletionRank(existingNorm?.main_context_type);
  const hasSubstantiveMain = workModeRegistryHasSubstantiveMain(existingNorm);
  const storedMainLen = String(existingNorm?.main_context_excerpt || "").trim().length;
  const visibleStrongerByContent =
    workModeVisibleLaneHasCompletedSolution(visible) &&
    visible.length > storedMainLen + 180 &&
    visibleRank >= existingMainRank;
  const overwrite_allowed =
    Boolean(visible.trim()) &&
    visibleRank > workModeCompletionRank("ack_status") &&
    (visibleRank > existingMainRank || !hasSubstantiveMain || visibleStrongerByContent);

  if (overwrite_allowed) {
    const merged = mergeLaneRegistryCommit(existingNorm, {
      lane_id: lid,
      active_lane_id: lid,
      title: getWorkModeLaneTitle(lid) || existingNorm?.title || "",
      latest_visible_markdown: visible,
      latest_assistant_turn: visible,
      latest_turn_type: visibleType,
      main_context_excerpt: visible,
      main_context_type: visibleType,
      code_or_math_generated: /```/.test(visible) || /\$[^\s$]/.test(visible)
    }, { forceMainOverwrite: visibleRank >= existingMainRank });
    workModeCompletedReasoningByLaneId[lid] = merged.row;
    const activeDom = getActiveDomReasoningLaneId();
    const focusLane = String(getFocusedWorkModeLaneId() || "").trim();
    if (activeDom === lid || focusLane === lid) {
      activeWorkModeReasoningContext = { ...merged.row };
    }
    maybeSyncGenericLaneTitleFromMarkdown(lid, visible, "resyncLaneMainContextFromVisibleDom");
  }

  const row = getWorkModeLaneHandoff(lid);
  if (!opts.silent) {
    logLaneMainContextResolve(lid, {
      title: row?.title || row?.lane_title || "",
      latest_turn_type: row?.latest_turn_type || null,
      main_context_type: row?.main_context_type || null,
      main_context_preview: previewWorkModeRegistryText(row?.main_context_excerpt || ""),
      latest_visible_markdown_preview: previewWorkModeRegistryText(visible || row?.latest_visible_markdown || ""),
      overwrite_allowed
    });
  }
  return { synced: overwrite_allowed, row, overwrite_allowed, visibleType, visibleRank };
}

/** Canonical read for per-lane handoff (prefer over reading the map directly). */
function getWorkModeLaneHandoff(laneId) {
  const lid = String(laneId || "").trim();
  if (!lid) return null;
  let key = lid;
  if (!workModeCompletedReasoningByLaneId[key]) {
    const idx = WORK_MODE_LEGACY_LANE_TO_INDEX[lid];
    if (idx != null) key = ensureStableLaneIdForPanelIndex(idx);
  }
  const row = workModeCompletedReasoningByLaneId[key];
  return row ? normalizeLaneRegistryRow(row) : null;
}

/** Merge title into lane registry after tab auto-rename (preserves main_context and other fields). */
function patchReasoningLaneRegistryTitle(laneId, newTitle, source = "") {
  const lid = String(laneId || "").trim();
  const t = String(newTitle || "").trim();
  if (!lid || !t) return;
  const row = getWorkModeLaneHandoff(lid);
  if (!row) return;
  if (String(row.title || row.lane_title || "").trim() === t) return;
  setWorkModeLaneHandoff(
    lid,
    {
      ...row,
      title: t,
      lane_title: t
    },
    { source: source || "reasoning_title_patch", forceSubstantive: false }
  );
}

/**
 * Canonical write for per-lane handoff. Clarifications/status must not clobber main_context.
 * @returns {boolean} whether the row was updated
 */
function setWorkModeLaneHandoff(laneId, row, opts = {}) {
  const lid = String(laneId || "").trim();
  if (!lid || !row) return false;
  const existing = workModeCompletedReasoningByLaneId[lid];
  const incomingTurn = String(
    row.latest_assistant_turn ||
      row.latest_visible_markdown ||
      row.latest_markdown_preview ||
      row.latest_final_answer_excerpt ||
      row.main_context_excerpt ||
      ""
  ).trim();
  const turnType =
    String(row.latest_turn_type || "").trim() || classifyWorkModeCompletionType(incomingTurn, row);
  const turnRank = workModeCompletionRank(turnType);
  const existingNorm = existing ? normalizeLaneRegistryRow(existing) : null;
  const existingMainRank = workModeCompletionRank(existingNorm?.main_context_type);
  const hasSubstantiveMain = workModeRegistryHasSubstantiveMain(existingNorm);

  if (
    hasSubstantiveMain &&
    turnRank < existingMainRank &&
    turnType === "clarification" &&
    opts.forceSubstantive !== true
  ) {
    const mergedWeak = mergeLaneRegistryCommit(existingNorm, {
      ...row,
      lane_id: lid,
      active_lane_id: lid,
      latest_turn_type: turnType,
      main_context_excerpt: "",
      main_context_type: ""
    });
    mergedWeak.row.main_context_excerpt = existingNorm.main_context_excerpt;
    mergedWeak.row.main_context_type = existingNorm.main_context_type;
    workModeCompletedReasoningByLaneId[lid] = mergedWeak.row;
    console.info("[lane_registry] skip_weak_main_overwrite", {
      lane_id: lid,
      turn_id: opts.turn_id || null,
      kept_main_context_type: existingNorm.main_context_type
    });
    logWorkModeLaneInvariant("lane_registry_write_partial", lid, lid, {
      turn_id: opts.turn_id || null,
      substantive: true,
      registry_source: opts.source || ""
    });
    return true;
  }

  const merged = mergeLaneRegistryCommit(
    existingNorm,
    { ...row, lane_id: lid, active_lane_id: lid, latest_turn_type: turnType },
    { forceMainOverwrite: opts.forceSubstantive === true }
  );
  if (
    hasSubstantiveMain &&
    !merged.overwriteMain &&
    turnRank < existingMainRank &&
    opts.forceSubstantive !== true
  ) {
    console.info("[lane_registry] skip_non_substantive_overwrite", {
      lane_id: lid,
      turn_id: opts.turn_id || null,
      kept_prior_solution: true
    });
    return false;
  }
  workModeCompletedReasoningByLaneId[lid] = merged.row;
  logWorkModeLaneInvariant("lane_registry_write", lid, lid, {
    turn_id: opts.turn_id || null,
    substantive: workModeHandoffIsSubstantive(merged.row),
    registry_source: opts.source || "",
    main_context_type: merged.row.main_context_type
  });
  const activeDom = getActiveDomReasoningLaneId();
  const focusLane = String(getFocusedWorkModeLaneId() || "").trim();
  if (activeDom === lid || focusLane === lid) {
    activeWorkModeReasoningContext = { ...workModeCompletedReasoningByLaneId[lid] };
  }
  return true;
}

function clearWorkModeLaneRegistry() {
  for (const k of Object.keys(workModeCompletedReasoningByLaneId)) {
    delete workModeCompletedReasoningByLaneId[k];
  }
  for (const k of Object.keys(workModeFrozenTurnById)) {
    delete workModeFrozenTurnById[k];
  }
  for (const k of Object.keys(workModeStage2SameTurnByTurnId)) {
    delete workModeStage2SameTurnByTurnId[k];
  }
  workModeReasoningFinalStatusByTurnId.clear();
  workModeReasoningFinalStatusByLaneId.clear();
  activeWorkModeReasoningContext = null;
}

function getReasoningPanelElementByLaneId(laneId) {
  const idx = getReasoningLaneIndexFromLaneId(laneId);
  if (idx == null) return null;
  return document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
  );
}

/** Prior user line for the same reasoning lane only — never another lane’s global last message. */
function getWorkModeLanePriorUserRequest(laneId) {
  const lid = String(laneId || "").trim();
  if (!lid) return "";
  const row = workModeCompletedReasoningByLaneId[lid];
  if (row?.last_user_request) return String(row.last_user_request).trim();
  const idx = getReasoningLaneIndexFromLaneId(lid);
  if (idx != null && workModeLastSubstantiveLaneIdx === idx) {
    return String(workModeLastSubstantiveUserText || "").trim();
  }
  return "";
}

function buildLaneScopedReasoningStreamAugmentations(trimmed, laneId, opts = {}) {
  const { continuePriorLane = false, planningIntent = false, includeVoiceForGenericExample = false } = opts;
  const cur = String(trimmed || "").trim();
  const lanePrior = getWorkModeLanePriorUserRequest(laneId);
  const parts = [];
  if (isGenericExampleFollowUpText(cur)) {
    if (lanePrior && !isGenericExampleFollowUpText(lanePrior)) {
      parts.push(`User (most recent substantive request on this reasoning lane before this example): ${lanePrior}`);
    }
    if (includeVoiceForGenericExample) {
      const voiceCtx = buildVoiceUiRecentContextBlock(8, true);
      if (voiceCtx) parts.push(voiceCtx);
    }
  } else if (
    !planningIntent &&
    !isGenericExampleFollowUpText(cur) &&
    isReasoningHeavySameThreadRequest(cur) &&
    lanePrior &&
    lanePrior !== cur
  ) {
    parts.push(
      `User (prior request on this reasoning lane — the current message is a short follow-up): ${lanePrior}`
    );
  } else if (continuePriorLane && lanePrior && lanePrior !== cur) {
    parts.push(`User (prior request on this reasoning lane): ${lanePrior}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Persist completed reasoning for exactly one lane. Requires immutable stream_started_lane_id from stream open.
 * @returns {boolean} false if blocked by lane / DOM turn mismatch
 */
function commitActiveWorkModeReasoningContext(payload, meta = {}) {
  const streamStarted = String(
    payload.stream_started_lane_id || payload.stream_lane_id || payload.active_lane_id || ""
  ).trim();
  const commitLaneId = streamStarted;
  if (!commitLaneId) {
    console.warn("[work_mode_context_commit] skipped: missing stream_started_lane_id", meta);
    return false;
  }

  try {
    console.info("[reasoning_title_path]", {
      phase: "commitActiveWorkModeReasoningContext_enter",
      commit_lane_id: commitLaneId,
      source_function: String(meta.source_function || "").trim()
    });
  } catch (_) {}

  const frozenLaneId = String(meta.frozen_lane_id || "").trim();
  const frozenTurnId = String(meta.frozen_turn_id || "").trim();
  const currentActiveDom = getActiveDomReasoningLaneId();

  console.info("[reasoning_commit]", {
    turn_id: frozenTurnId || null,
    commit_lane_id: commitLaneId,
    current_active_dom_lane_id: currentActiveDom || null
  });

  if (frozenLaneId && frozenLaneId !== commitLaneId) {
    console.warn("[wrong_lane_guard]", {
      turn_id: frozenTurnId || null,
      frozen_lane_id: frozenLaneId,
      attempted_lane_id: commitLaneId,
      operation: "reasoning_commit"
    });
    return false;
  }

  const activeIdx = getActiveReasoningLaneIndex();
  const activeDomLaneId =
    activeIdx != null && Number.isFinite(Number(activeIdx)) ? getWorkModeReasoningLaneId(Number(activeIdx)) : "";

  const metaStreamStarted = String(meta.stream_started_lane_id || "").trim();
  if (metaStreamStarted && metaStreamStarted !== commitLaneId) {
    console.error("[work_mode_context_commit] BLOCKED: meta stream lane !== payload lane", {
      commit_lane_id: commitLaneId,
      stream_started_lane_id: metaStreamStarted,
      source_function: meta.source_function || ""
    });
    return false;
  }

  const turnEl = meta.turn_el;
  if (turnEl instanceof HTMLElement) {
    const turnPanel = turnEl.closest(".vera-reasoning-tab-panel");
    if (turnPanel instanceof HTMLElement) {
      const turnLaneId =
        String(turnPanel.dataset.laneId || "").trim() ||
        getWorkModeReasoningLaneId(Number(turnPanel.dataset.tabIndex));
      if (turnLaneId && turnLaneId !== commitLaneId) {
        console.error("[work_mode_context_commit] BLOCKED: turn DOM panel lane !== stream lane", {
          commit_lane_id: commitLaneId,
          turn_dom_lane_id: turnLaneId,
          source_function: meta.source_function || ""
        });
        return false;
      }
    }
  }

  const excerpt = truncateWorkModeRegistryExcerpt(
    String(payload.latest_final_answer_excerpt || "").trim(),
    12000
  );
  const previewIn = String(payload.latest_markdown_preview || excerpt || "").trim();
  const previewCap = 3500;
  let latest_markdown_preview = previewIn;
  if (latest_markdown_preview.length > previewCap) {
    latest_markdown_preview = `${latest_markdown_preview.slice(0, previewCap)}\n…`;
  } else if (!latest_markdown_preview && excerpt) {
    latest_markdown_preview = excerpt.length > previewCap ? `${excerpt.slice(0, previewCap)}\n…` : excerpt;
  }

  const visibleMd = excerpt || latest_markdown_preview;
  const turnType = classifyWorkModeCompletionType(visibleMd, payload);
  const title =
    String(payload.title || payload.lane_title || "").trim() || getWorkModeLaneTitle(commitLaneId);
  const mainRank = workModeCompletionRank(turnType);
  const useAsMain = mainRank >= workModeCompletionRank("explanation");

  const o = {
    lane_id: commitLaneId,
    active_lane_id: commitLaneId,
    title,
    lane_title: title,
    stream_started_lane_id: commitLaneId,
    last_user_request: String(payload.last_user_request || "").trim(),
    prior_problem_anchor: String(payload.prior_problem_anchor || "").trim(),
    latest_reasoning_summary: String(payload.latest_reasoning_summary || "").trim(),
    latest_visible_markdown: visibleMd,
    latest_assistant_turn: visibleMd,
    latest_turn_type: turnType,
    latest_final_answer_excerpt: excerpt,
    latest_markdown_preview,
    main_context_excerpt: useAsMain ? visibleMd : "",
    main_context_type: useAsMain ? turnType : "",
    code_or_math_generated: Boolean(payload.code_or_math_generated),
    updated_at: Date.now()
  };

  const oldTitleCommitted = String(o.title || "").trim();
  const mdForHeadingVisible = String(visibleMd || "").trim();
  const mdForHeadingExcerpt = String(excerpt || "").trim();
  const mdNormVisible = normalizeMarkdownLeadForHeadingExtract(mdForHeadingVisible);
  const mdNormExcerpt = normalizeMarkdownLeadForHeadingExtract(mdForHeadingExcerpt);
  const mdForHeading =
    mdNormVisible.startsWith("#")
      ? mdForHeadingVisible
      : mdNormExcerpt.startsWith("#")
        ? mdForHeadingExcerpt
        : mdForHeadingVisible || mdForHeadingExcerpt;
  const mdSource = !mdForHeading
    ? "none"
    : mdNormVisible.startsWith("#")
      ? "visibleMd"
      : mdNormExcerpt.startsWith("#")
        ? "excerpt"
        : "visibleMd_or_excerpt_merged";

  const headingDiag = logHeadingTitleExtractAttempt(commitLaneId, oldTitleCommitted, mdSource, mdForHeading);
  if (
    headingDiag.extracted_heading &&
    isGenericAutoRenamableReasoningPanelTitle(oldTitleCommitted)
  ) {
    o.title = headingDiag.extracted_heading;
    o.lane_title = headingDiag.extracted_heading;
  }

  setWorkModeLaneHandoff(commitLaneId, o, {
    turn_id: frozenTurnId,
    source: meta.source_function || "reasoning_commit",
    forceSubstantive: useAsMain || workModeHandoffIsSubstantive(o)
  });

  const headingSync = maybeSyncGenericLaneTitleFromMarkdown(
    commitLaneId,
    mdForHeading,
    `commitActiveWorkModeReasoningContext:${String(meta.source_function || "").trim()}`
  );

  const panelPost = getReasoningPanelElementByLaneId(commitLaneId);
  const regPost = getWorkModeLaneHandoff(commitLaneId);
  try {
    console.info("[lane_title_sync_after_commit]", {
      lane_id: commitLaneId,
      old_title: oldTitleCommitted,
      extracted_heading: headingSync.extracted_heading || "(none)",
      new_registry_title: String(regPost?.title || regPost?.lane_title || "").trim() || "(none)",
      tab_text:
        panelPost instanceof HTMLElement ? String(getReasoningTabTopicLabel(panelPost) || "").trim() : "(no_panel)",
      panel_dataset_lane_label:
        panelPost instanceof HTMLElement ? String(panelPost.dataset.laneLabel || "").trim() : "",
      panel_dataset_tab_topic:
        panelPost instanceof HTMLElement ? String(panelPost.dataset.tabTopic || "").trim() : "",
      allowed: headingSync.allowed,
      dom_synced: headingSync.applied,
      commit_reason: headingSync.reason,
      source_function: String(meta.source_function || "").trim(),
      active_wmr_lane_title: String(activeWorkModeReasoningContext?.lane_title || "").trim() || "(none)"
    });
  } catch (_) {}

  logWorkModeLaneInvariant("reasoning_commit", frozenLaneId || commitLaneId, commitLaneId, {
    turn_id: frozenTurnId || null,
    active_dom_lane_id: currentActiveDom || null
  });

  const mdPreviewStart = (latest_markdown_preview || excerpt).slice(0, 180);
  const commitTitleForLog = String(getWorkModeLaneHandoff(commitLaneId)?.title || o.lane_title || "").trim();
  console.log("[work_mode_context_commit]", {
    commit_lane_id: commitLaneId,
    commit_lane_title: commitTitleForLog,
    stream_started_lane_id: commitLaneId,
    active_dom_lane_id_at_commit: activeDomLaneId,
    user_request: o.last_user_request.slice(0, 500),
    markdown_preview_start: mdPreviewStart,
    final_excerpt_preview: excerpt.slice(0, 220),
    prior_problem_anchor: o.prior_problem_anchor.slice(0, 220),
    source_function: String(meta.source_function || "").trim(),
    active_dom_matches_commit: activeDomLaneId === commitLaneId
  });

  notifyWorkModeTtsReasoningCommitted(commitLaneId, o);

  if (frozenTurnId) {
    const resultPack = classifyWorkModeSameTurnReasoningResultStatus(
      excerpt,
      String(o.latest_reasoning_summary || "").trim(),
      {
        turn_intent: String(
          meta.turn_intent || classifyWorkModeTurnIntent(o.last_user_request || "").turn_intent || ""
        )
          .trim()
          .toLowerCase()
      }
    );
    workModeStage2SameTurnByTurnId[frozenTurnId] = {
      turn_id: frozenTurnId,
      lane_id: commitLaneId,
      latest_final_answer_excerpt: excerpt,
      latest_reasoning_summary: String(o.latest_reasoning_summary || "").trim(),
      latest_markdown_preview: String(latest_markdown_preview || "").trim(),
      main_context_type: String(o.main_context_type || "").trim(),
      code_or_math_generated: Boolean(o.code_or_math_generated),
      same_turn_result_status: resultPack.status,
      missing_inputs: resultPack.missing_inputs,
      same_turn_summary_preview: resultPack.same_turn_summary_preview,
      updated_at: Date.now(),
      source_function: String(meta.source_function || "").trim()
    };
    try {
      console.info("[stage2_same_turn_snapshot]", {
        turn_id: frozenTurnId,
        lane_id: commitLaneId,
        excerpt_preview: previewWorkModeRegistryText(excerpt),
        same_turn_result_status: resultPack.status,
        missing_inputs: resultPack.missing_inputs
      });
    } catch (_) {}
  }

  return true;
}

function workModeReasoningContextLooksUsable(ctx) {
  if (!ctx || typeof ctx !== "object") return false;
  const main = String(ctx.main_context_excerpt || "").trim();
  if (main && workModeCompletionRank(ctx.main_context_type) >= workModeCompletionRank("explanation")) {
    return true;
  }
  if (main && main.length > 80) return true;
  return Boolean(
    String(ctx.latest_substantive_excerpt || "").trim() ||
      String(ctx.latest_final_answer_excerpt || "").trim() ||
      String(ctx.latest_reasoning_summary || "").trim() ||
      String(ctx.last_user_request || "").trim()
  );
}

function resolveWorkModeLaneHandoffForInfer(laneId, opts = {}) {
  let lid = String(laneId || "").trim();
  if (!lid) return null;
  if (Object.prototype.hasOwnProperty.call(WORK_MODE_LEGACY_LANE_TO_INDEX, lid)) {
    lid = ensureStableLaneIdForPanelIndex(WORK_MODE_LEGACY_LANE_TO_INDEX[lid]);
  }
  migrateLegacyLaneRegistryKeys();
  syncPanelStableLaneIdsInDom();
  if (!opts.skipResync) {
    resyncLaneMainContextFromVisibleDom(lid, { silent: Boolean(opts.silentResyncLog) });
  }
  const row = getWorkModeLaneHandoff(lid);
  const mdForTitle = String(
    row?.main_context_excerpt || row?.latest_final_answer_excerpt || row?.latest_visible_markdown || ""
  ).trim();
  if (mdForTitle) {
    maybeSyncGenericLaneTitleFromMarkdown(
      lid,
      mdForTitle,
      opts.titleSyncCalledFrom || "resolveWorkModeLaneHandoffForInfer"
    );
  }
  return getWorkModeLaneHandoff(lid);
}

function pickWorkModeReasoningLaneIdFromUserMessage(userText) {
  const t = String(userText || "").toLowerCase().trim();
  if (!t) return "";
  let bestLaneId = "";
  let bestScore = 0;
  const consider = (laneId, label) => {
    const id = String(laneId || "").trim();
    const low = String(label || "").toLowerCase().trim();
    if (!id || !low) return;
    let score = 0;
    if (low.length >= 4 && t.includes(low)) score = 100;
    for (const w of low.split(/\s+/).filter((w) => w.length >= 5)) {
      if (t.includes(w)) score = Math.max(score, 72);
    }
    if (score > bestScore) {
      bestScore = score;
      bestLaneId = id;
    }
  };
  for (const p of collectWorkModeReasoningPanelsSnapshot()?.panels || []) {
    consider(getWorkModeReasoningLaneId(Number(p.index)), p.label);
  }
  for (const laneId of Object.keys(workModeCompletedReasoningByLaneId)) {
    const row = workModeCompletedReasoningByLaneId[laneId];
    consider(laneId, row?.title || row?.lane_title);
  }
  return bestScore >= 72 ? bestLaneId : "";
}

function resolveWorkModeReasoningContextForInferWithMeta(formData, userText, prep) {
  const none = { context: null, source: "none", reason: "no_usable_lane_or_global" };
  if (!isVeraWorkModeOn()) return none;
  const txt = String(userText ?? "").trim();
  const turnId = prep?.turnContext?.turn_id || null;

  function finish(ctx, source, reason, expectedLaneId) {
    const expected = String(expectedLaneId || "").trim();
    const actual = String(ctx?.active_lane_id || "").trim();
    logWorkModeLaneInvariant("infer_handoff", expected, actual, {
      turn_id: turnId,
      routing: source,
      resolution_reason: reason
    });
    return { context: ctx, source, reason };
  }

  const strictFrozen = String(prep?.turnContext?.turn_lane_id || "").trim();
  if (strictFrozen) {
    const byFrozen = resolveWorkModeLaneHandoffForInfer(strictFrozen);
    if (workModeReasoningContextLooksUsable(byFrozen)) {
      return finish(byFrozen, "frozen_turn_lane", "submit_time_frozen_turn_lane_id", strictFrozen);
    }
    const routed = String(prep?.reasoningLaneId || "").trim();
    if (routed && routed !== strictFrozen) {
      console.warn("[lane_invariant_violation]", {
        step: "infer_prep_lane_mismatch",
        expected_lane_id: strictFrozen,
        actual_lane_id: routed,
        turn_id: turnId,
        routing: "prep.reasoningLaneId"
      });
    }
    if (prep?.voiceTwoStage?.reasoningRouted && routed === strictFrozen) {
      const byRouted = resolveWorkModeLaneHandoffForInfer(routed, { silentResyncLog: true });
      if (workModeReasoningContextLooksUsable(byRouted)) {
        return finish(byRouted, "paired_routed", "same_turn_reasoning_stream_lane", strictFrozen);
      }
    }
    console.warn("[lane_invariant_violation]", {
      step: "infer_handoff_blocked",
      expected_lane_id: strictFrozen,
      turn_id: turnId,
      message: "frozen_turn_no_cross_lane_fallback"
    });
    return none;
  }

  const activeIdx = getActiveReasoningLaneIndex();
  const activeLaneId =
    activeIdx != null && Number.isFinite(Number(activeIdx)) ? getWorkModeReasoningLaneId(Number(activeIdx)) : "";
  const focusedLane = getFocusedWorkModeLaneId();
  const submissionLane =
    formData instanceof FormData && typeof formData.get === "function"
      ? String(formData.get("work_mode_submission_lane_id") || "").trim()
      : "";

  const routed = String(prep?.reasoningLaneId || "").trim();
  const inferPairedWithReasoningStream = Boolean(prep?.voiceTwoStage?.reasoningRouted && routed);
  if (inferPairedWithReasoningStream) {
    const byRouted = resolveWorkModeLaneHandoffForInfer(routed);
    if (workModeReasoningContextLooksUsable(byRouted)) {
      return finish(byRouted, "paired_routed", "same_turn_reasoning_stream_lane", submissionLane || routed);
    }
  }

  if (submissionLane) {
    const bySub = resolveWorkModeLaneHandoffForInfer(submissionLane);
    if (workModeReasoningContextLooksUsable(bySub)) {
      if (focusedLane && focusedLane !== submissionLane) {
        console.warn("[lane_invariant_violation]", {
          step: "infer_cross_lane_routing",
          expected_lane_id: submissionLane,
          actual_lane_id: focusedLane,
          routing: "skipped_focused_for_submission"
        });
      }
      return finish(bySub, "submission_lane", "work_mode_submission_lane_id_on_form", submissionLane);
    }
  }

  if (focusedLane && focusedLane !== submissionLane) {
    const byFocused = resolveWorkModeLaneHandoffForInfer(focusedLane);
    if (workModeReasoningContextLooksUsable(byFocused)) {
      console.warn("[lane_invariant_violation]", {
        step: "infer_handoff_focused_without_frozen_turn",
        expected_lane_id: submissionLane || null,
        actual_lane_id: focusedLane,
        routing: "focused_lane_fallback"
      });
      return finish(byFocused, "focused_lane", "focusedWorkModeLaneId_recent_valid", focusedLane);
    }
  }

  if (activeLaneId && activeLaneId !== submissionLane && activeLaneId !== focusedLane) {
    const byActive = resolveWorkModeLaneHandoffForInfer(activeLaneId);
    if (workModeReasoningContextLooksUsable(byActive)) {
      console.warn("[lane_invariant_violation]", {
        step: "infer_handoff_active_tab_without_frozen_turn",
        expected_lane_id: submissionLane || null,
        actual_lane_id: activeLaneId,
        routing: "active_tab_fallback"
      });
      return finish(byActive, "active_tab", "active_reasoning_tab_panel_is_active", activeLaneId);
    }
  }

  if (routed) {
    const byRouted2 = resolveWorkModeLaneHandoffForInfer(routed);
    if (workModeReasoningContextLooksUsable(byRouted2)) {
      return finish(byRouted2, "routed_lane", "prep_reasoning_lane_id", routed);
    }
  }

  const explicitLane = pickWorkModeReasoningLaneIdFromUserMessage(txt);
  if (explicitLane) {
    const byExplicit = resolveWorkModeLaneHandoffForInfer(explicitLane);
    if (workModeReasoningContextLooksUsable(byExplicit)) {
      return finish(byExplicit, "explicit_topic", "user_text_matched_panel_or_lane_title", explicitLane);
    }
  }

  if (!WORK_MODE_INFER_CONTAMINATION_TEST && workModeReasoningContextLooksUsable(activeWorkModeReasoningContext)) {
    const globalLane = String(activeWorkModeReasoningContext?.active_lane_id || "").trim();
    console.warn("[lane_invariant_violation]", {
      step: "infer_handoff_global_fallback",
      expected_lane_id: submissionLane || strictFrozen || null,
      actual_lane_id: globalLane,
      routing: "activeWorkModeReasoningContext"
    });
    return finish(
      activeWorkModeReasoningContext,
      "global_fallback",
      "activeWorkModeReasoningContext",
      submissionLane || globalLane
    );
  }
  return none;
}

/** Lane/infer debug overlay removed from the UI; the structured rows still flow to
 *  the console via the existing `[infer_reference_resolution]` log call. These
 *  helpers stay as no-ops so callers keep working without rendering anything. */
function ensureWorkModeInferDebugOverlay() {
  const stale = document.getElementById("vera-wm-infer-debug");
  if (stale) stale.remove();
  return null;
}

function updateWorkModeInferDebugOverlay(_debugRow) {
  const stale = document.getElementById("vera-wm-infer-debug");
  if (stale) stale.remove();
}

function applyWorkModeLaneDebugFromInferMeta(meta) {
  if (!meta?.work_mode_lane_debug || typeof meta.work_mode_lane_debug !== "object") return;
  window.__veraLastInferLaneDebug = meta.work_mode_lane_debug;
  if (window.__veraLastInferHandoffDebug) {
    window.__veraLastInferHandoffDebug.server_voice_included =
      meta.work_mode_lane_debug.voice_context_used_server;
    window.__veraLastInferHandoffDebug.final_server_injected_lane_title =
      meta.work_mode_lane_debug.final_server_handoff_lane_title;
    updateWorkModeInferDebugOverlay(window.__veraLastInferHandoffDebug);
  }
}

function logWorkModeInferContextDebugTrace(formData, prep, handoffPayload, resolutionMeta) {
  const identity = collectWorkModeLaneIdentityAtSend(formData, prep);
  const excerptPreview = previewWorkModeRegistryText(
    handoffPayload?.main_context_excerpt || handoffPayload?.latest_final_answer_excerpt || ""
  );
  const row = {
    visible_active_tab_title: identity.visible_active_tab_title,
    dom_is_active_lane_id: identity.dom_is_active_lane_id,
    dom_is_active_panel_title: identity.dom_is_active_panel_title,
    tab_strip_lane_id: identity.tab_strip_lane_id,
    tab_vs_panel_mismatch: identity.tab_vs_panel_mismatch,
    focused_work_mode_lane_id: identity.focused_work_mode_lane_id,
    work_mode_submission_lane_id: identity.work_mode_submission_lane_id,
    prep_reasoning_lane_id: identity.prep_reasoning_lane_id,
    selected_handoff_lane_id: handoffPayload?.active_lane_id || "",
    selected_handoff_lane_title: handoffPayload?.lane_title || "",
    _infer_context_source: handoffPayload?._infer_context_source || resolutionMeta?.source || "none",
    ACTIVE_WORK_MODE_REASONING_CONTEXT_lane_title: handoffPayload?.lane_title || "",
    main_context_type: handoffPayload?.main_context_type || "",
    main_context_excerpt_preview: excerptPreview,
    latest_final_answer_excerpt_preview: excerptPreview,
    same_turn_snapshot: Boolean(
      handoffPayload?.same_turn_reasoning_excerpt || handoffPayload?.stage2_grounding === "same_turn_stream"
    ),
    stage2_grounding: handoffPayload?.stage2_grounding || null,
    lane_background_excerpt_preview: previewWorkModeRegistryText(
      handoffPayload?.lane_background_excerpt || ""
    ),
    recent_voice_context_in_client_snapshot: Boolean(
      collectWorkModeVoiceExcerptForContext(4500, 10).trim() && !WORK_MODE_INFER_CONTAMINATION_TEST
    ),
    contamination_test_active: WORK_MODE_INFER_CONTAMINATION_TEST,
    resolution_reason: resolutionMeta?.reason || "",
    server_voice_included: window.__veraLastInferLaneDebug?.voice_context_used_server ?? null,
    final_server_injected_lane_title:
      window.__veraLastInferLaneDebug?.final_server_handoff_lane_title ?? null
  };
  console.log("[infer_lane_identity_at_send]", identity);
  console.log("[infer_reference_resolution]", row);
  try {
    console.table(row);
  } catch (_) {}
  window.__veraLastInferHandoffDebug = row;
  updateWorkModeInferDebugOverlay(row);
}

function workModeStage2SameTurnSnapshotUsable(snap) {
  if (!snap || typeof snap !== "object") return false;
  const ex = String(snap.latest_final_answer_excerpt || snap.latest_markdown_preview || "").trim();
  const sm = String(snap.latest_reasoning_summary || "").trim();
  return ex.length > 20 || sm.length > 8;
}

function attachWorkModeReasoningContextToInferFormData(formData, prep) {
  if (!isVeraWorkModeOn() || !(formData instanceof FormData)) return;
  const userText = typeof formData.get === "function" ? String(formData.get("transcript") || "").trim() : "";
  const stage2Voice = Boolean(prep?.voiceTwoStage?.reasoningRouted);
  const turnIdForSame = String(prep?.turnContext?.turn_id || "").trim();
  const sameTurnPeek =
    stage2Voice && turnIdForSame ? workModeStage2SameTurnByTurnId[turnIdForSame] || null : null;
  const resolution = resolveWorkModeReasoningContextForInferWithMeta(formData, userText, prep);
  let c = resolution.context;
  const selectedSource = resolution.source;
  const resolutionReason = resolution.reason;
  const cUsable = c && workModeReasoningContextLooksUsable(c);
  if (cUsable && c) {
    const inferLaneForTitle = String(c.active_lane_id || c.lane_id || "").trim();
    const mdInfer = String(c.main_context_excerpt || c.latest_final_answer_excerpt || "").trim();
    if (inferLaneForTitle && mdInfer) {
      maybeSyncGenericLaneTitleFromMarkdown(
        inferLaneForTitle,
        mdInfer,
        "attachWorkModeReasoningContextToInferFormData.pre_payload"
      );
      c = getWorkModeLaneHandoff(inferLaneForTitle) || c;
    }
  }
  const snapUsable = workModeStage2SameTurnSnapshotUsable(sameTurnPeek);
  if (!cUsable && !(stage2Voice && snapUsable)) {
    logWorkModeInferContextDebugTrace(formData, prep, null, resolution);
    return;
  }
  const sameTurn = stage2Voice && turnIdForSame && snapUsable ? sameTurnPeek : null;

  let primaryExcerpt = "";
  let laneBackgroundExcerpt = "";
  if (sameTurn) {
    primaryExcerpt = String(
      sameTurn.latest_final_answer_excerpt || sameTurn.latest_markdown_preview || ""
    ).trim();
  }
  const base = c || {};
  if (!primaryExcerpt && c) {
    primaryExcerpt =
      String(base.main_context_excerpt || "").trim() ||
      String(base.latest_substantive_excerpt || "").trim() ||
      String(base.latest_final_answer_excerpt || "").trim();
  } else if (c && sameTurn) {
    const bg =
      String(base.main_context_excerpt || "").trim() ||
      String(base.latest_substantive_excerpt || "").trim() ||
      String(base.latest_final_answer_excerpt || "").trim();
    if (bg && bg !== primaryExcerpt) {
      laneBackgroundExcerpt = truncateWorkModeRegistryExcerpt(bg, 8000);
    }
  }
  if (!primaryExcerpt.trim()) {
    logWorkModeInferContextDebugTrace(formData, prep, null, resolution);
    return;
  }

  const summaryMerged = sameTurn
    ? String(sameTurn.latest_reasoning_summary || base.latest_reasoning_summary || "").trim()
    : String(base.latest_reasoning_summary || "").trim();

  const codeOrMerged = sameTurn
    ? Boolean(sameTurn.code_or_math_generated)
    : Boolean(base.code_or_math_generated);
  let mainTypeMerged = sameTurn
    ? String(sameTurn.main_context_type || base.main_context_type || "").trim()
    : String(base.main_context_type || "").trim();
  if (!mainTypeMerged && primaryExcerpt) {
    mainTypeMerged = classifyWorkModeCompletionType(primaryExcerpt, {
      code_or_math_generated: codeOrMerged,
      from_visible_dom: true
    });
  }

  const laneIdPayload =
    String(base.active_lane_id || base.lane_id || "").trim() ||
    String(sameTurn?.lane_id || "").trim() ||
    String(prep?.turnContext?.turn_lane_id || "").trim() ||
    String(formData.get?.("work_mode_submission_lane_id") || "").trim();

  const titleMerged =
    (laneIdPayload ? String(getWorkModeLaneTitle(laneIdPayload) || "").trim() : "") ||
    String(base.title || base.lane_title || "").trim();

  const grounding = sameTurn ? "same_turn_stream" : "lane_registry";
  const sameTurnDup = sameTurn ? primaryExcerpt : "";
  const excerptForStatus =
    (sameTurn
      ? String(sameTurn.latest_final_answer_excerpt || sameTurn.latest_markdown_preview || "").trim()
      : "") ||
    primaryExcerpt ||
    (stage2Voice ? getWorkModeLaneMarkdownExcerptForStage2(laneIdPayload) : "");
  const resultPack = packStage2ResultStatus(
    prep,
    classifyWorkModeSameTurnReasoningResultStatus(excerptForStatus, summaryMerged, stage2ClassifyOptsFromPrep(prep)),
    "infer_attach"
  );
  prep.stage2ResultStatus = resultPack;
  prep.stage2InferExcerpt = excerptForStatus;
  if (sameTurn && turnIdForSame) {
    delete workModeStage2SameTurnByTurnId[turnIdForSame];
  }

  const payload = {
    active_lane_id: laneIdPayload,
    lane_title: titleMerged,
    title: titleMerged,
    last_user_request: String(base.last_user_request || prep?.turnContext?.user_text || userText || "").trim(),
    prior_problem_anchor: String(base.prior_problem_anchor || "").trim(),
    latest_reasoning_summary: summaryMerged,
    main_context_excerpt: primaryExcerpt,
    main_context_type: mainTypeMerged,
    latest_final_answer_excerpt: primaryExcerpt,
    latest_markdown_preview: primaryExcerpt.slice(0, 3500),
    code_or_math_generated: codeOrMerged,
    same_turn_reasoning_excerpt: sameTurnDup,
    lane_background_excerpt: laneBackgroundExcerpt,
    stage2_grounding: grounding,
    same_turn_result_status: resultPack.status,
    status_turn_id: resultPack.turn_id,
    status_lane_id: resultPack.lane_id,
    missing_inputs: resultPack.missing_inputs || [],
    same_turn_summary_preview: String(resultPack.same_turn_summary_preview || "").slice(0, 220),
    _infer_context_source: sameTurn ? `${selectedSource}+same_turn_priority` : selectedSource
  };
  const raw = JSON.stringify(payload);
  if (typeof formData.set === "function") formData.set("work_mode_reasoning_context", raw);
  else formData.append("work_mode_reasoning_context", raw);
  if (WORK_MODE_INFER_CONTAMINATION_TEST) {
    try {
      if (typeof formData.set === "function") formData.set("work_mode_strict_lane_context", "1");
      else formData.append("work_mode_strict_lane_context", "1");
    } catch (_) {
      formData.append("work_mode_strict_lane_context", "1");
    }
  }
  logWorkModeLaneInvariant(
    "infer_handoff_attached",
    prep?.turnContext?.turn_lane_id || String(formData.get?.("work_mode_submission_lane_id") || ""),
    payload.active_lane_id,
    {
      turn_id: prep?.turnContext?.turn_id,
      routing: selectedSource,
      resolution_reason: resolutionReason,
      stage2_grounding: grounding
    }
  );
  console.log("[voice_infer_context]", {
    lane_id: payload.active_lane_id,
    title: payload.lane_title,
    main_context_type: payload.main_context_type,
    stage2_grounding: grounding,
    summary_len: (payload.latest_reasoning_summary || "").length,
    main_context_len: (payload.main_context_excerpt || "").length,
    code_or_math: payload.code_or_math_generated,
    source_lane: payload.active_lane_id,
    _infer_context_source: payload._infer_context_source
  });
  logWorkModeInferContextDebugTrace(formData, prep, payload, resolution);
}

/** Pin which reasoning lane the user was on when this `/infer` was composed (frozen at submit when provided). */
function appendWorkModeSubmissionLaneToFormData(formData, frozenLaneId) {
  if (!(formData instanceof FormData) || !isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  let lid = String(frozenLaneId || "").trim();
  if (!lid) {
    lid = getActiveDomReasoningLaneId();
  }
  if (!lid) return;
  try {
    if (typeof formData.set === "function") formData.set("work_mode_submission_lane_id", lid);
    else formData.append("work_mode_submission_lane_id", lid);
  } catch (_) {
    formData.append("work_mode_submission_lane_id", lid);
  }
}

/**
 * Extra text for `/work_mode/reasoning_stream_upload`: prior lane handoff + last markdown so the server can
 * merge multi-image homework (problem statement + assumptions) before the variables pass.
 */
function buildWorkModeLaneClientMergeBlockForUpload(laneId, userText = "", uploadOpts = {}) {
  const prep = prepareWorkModeReasoningModelCall({
    laneId,
    userText,
    turnContext: uploadOpts.turnContext || null,
    requestHasCodeIntent: uploadOpts.requestHasCodeIntent,
    skipLog: true,
    currentAttachmentMeta: uploadOpts.currentAttachmentMeta || []
  });
  return prep.laneClientContext || "";
}

function detectWorkModeRequestHasCodeVoiceIntent(trimmed) {
  const t = String(trimmed || "").toLowerCase();
  return /\b(code|coding|script|snippet|python|typescript|javascript|java|c\+\+|rust|go|kotlin|sql|ruby|php|implement|program|debugger?|refactor)\b/.test(
    t
  );
}

/**
 * Submit-time intent for Stage‑2 brief voice + LLM (must follow current user line, not lane history).
 * @returns {{ turn_intent: string, content_type_requested: string, stage2_completion_action: string }}
 */
/** @typedef {'solved'|'partially_completed'|'needs_missing_info'|'clarification_required'|'failed'} WorkModeSameTurnResultStatus */

/**
 * Classify what the same-turn reasoning stream actually delivered (for Stage 2 voice).
 * @returns {{
 *   status: WorkModeSameTurnResultStatus,
 *   missing_inputs: string[],
 *   same_turn_summary_preview: string,
 *   status_reason: string,
 *   explicit_missing_info_found: boolean,
 *   explicit_partial_found: boolean,
 *   substantive_answer_detected: boolean
 * }}
 */
function detectSubstantiveWorkModeReasoningAnswer(raw, opts = {}) {
  const text = String(raw || "").trim();
  const low = text.toLowerCase();
  const turnIntent = String(opts.turn_intent || "").trim().toLowerCase();
  if (text.length < 80) return false;

  const hasHeadings = /^#{1,6}\s/m.test(text);
  const hasBullets = /^\s*[-*•]\s/m.test(text) || /^\s*\d+\.\s/m.test(text);
  const hasTable = /\|.+\|.+\|/m.test(text) || /\|\s*---+\s*\|/.test(text);
  const hasCode = /```/.test(text);
  const paragraphCount = (text.match(/\n\s*\n/g) || []).length;

  const solvedSignals = [
    /\bfinal answer\b/i,
    /\btherefore[,]?\s+/i,
    /\bconclusion\b/i,
    /\bthe (?:call|put|option) (?:is worth|price is|premium is)\b/i,
    /\b=\s*\$?[\d,]+(?:\.\d+)?/,
    /\bin one sentence\b/i,
    /\bkey terms\b/i
  ];
  if (solvedSignals.some((re) => re.test(text))) return true;
  if (hasCode && text.length >= 100) return true;
  if (hasTable && text.length >= 140) return true;

  const explainLike =
    turnIntent === "explain" ||
    turnIntent === "summarize" ||
    turnIntent === "plan" ||
    /\b(explain|overview|summary|background|timeline|essay|outline)\b/i.test(low);
  const structuredExplain =
    explainLike && text.length >= 320 && (hasHeadings || hasBullets || hasTable || paragraphCount >= 2);
  if (structuredExplain) return true;

  if (hasHeadings && hasBullets && text.length >= 220) return true;
  if (paragraphCount >= 2 && text.length >= 400) return true;
  if (text.length >= 700 && (hasHeadings || hasBullets || hasTable)) return true;

  return false;
}

function detectExplicitPartialWorkModeReasoning(raw) {
  const low = String(raw || "").toLowerCase();
  const partialPatterns = [
    /\bpartial(?:ly)? (?:complete|completed|done|finished|solved)\b/i,
    /\bpartial progress\b/i,
    /\bincomplete\b/i,
    /\bunfinished\b/i,
    /\bdraft only\b/i,
    /\bsetup only\b/i,
    /\bonly (?:the )?setup\b/i,
    /\bcannot finish yet\b/i,
    /\bnot fully finished\b/i,
    /\bnot (?:yet )?complete\b/i,
    /\bstill working on\b/i,
    /\b(incomplete|partial) (?:setup|draft|solution|answer|work)\b/i,
    /\bhave(?:n't| not) finished\b/i,
    /\bcan't finish yet\b/i
  ];
  if (partialPatterns.some((re) => re.test(raw))) return true;
  if (/\bpartial(?:ly)?\b/i.test(low) && /\b(?:need|missing|cannot|can't|without)\b/i.test(low)) {
    return false;
  }
  return false;
}

/**
 * Group the current turn into a coarse "task kind" the Stage 2 canned-line
 * gate cares about. Independent from the finer turn_intent string.
 *   - calculation       finance/options/math/numerical/model calculation
 *   - code_debug        code, debugging, stack traces, file/repo edits
 *   - planning_writing  plans, outlines, essays, drafts, study schedules
 *   - explanation       explanations, overviews, summaries, walk-throughs
 *   - general           anything else
 */
function classifyStage2TaskKind(userText, turnIntent) {
  const t = String(userText || "");
  const low = t.toLowerCase();
  const ti = String(turnIntent || "").trim().toLowerCase();
  const calcRx = /\b(calculate|computation|compute|derive|formula|equation|integral|derivative|matrix|delta|hedge|black-?scholes|option (?:price|premium|value|payoff)|greek|premium|npv|irr|var\b|expected value|probability|standard deviation|variance|regression|coefficient|eigen|determinant|cdf|pdf|monte carlo|payoff|interest rate|yield curve|bond price)\b/i;
  const codeRx = /\b(code|coding|script|snippet|implement|program|debug(?:ging)?|stack trace|traceback|exception|error message|refactor|function signature|class definition|method|file|repo|repository|pull request|commit|merge|compile|build error)\b/i;
  const planRx = /\b(plan(?:ning)?|outline|essay|paragraph|draft|write(?:-?up)?|cover letter|story|narrative|brainstorm|study (?:plan|schedule)|schedule|itinerary|agenda|to-?do|checklist|roadmap)\b/i;
  const explainRx = /\b(explain|overview|summary|summarize|background|history|timeline|describe|definition|tell me about|walk me through|how does|how do|why does|why do|what is|what are)\b/i;
  if (ti === "code" || codeRx.test(low)) return "code_debug";
  if (ti === "solve" || calcRx.test(low)) return "calculation";
  if (ti === "plan" || planRx.test(low)) return "planning_writing";
  if (ti === "explain" || ti === "summarize" || explainRx.test(low)) return "explanation";
  return "general";
}

/**
 * Stricter than explicit_missing_info_found. True only when the reasoning
 * output explicitly says it cannot finish (e.g. blocking phrases). Used to
 * keep the canned `needs_missing_info` line for non-calculation tasks only
 * when the answer is genuinely blocked.
 */
function detectExplicitBlockingMissingInfo(raw) {
  const text = String(raw || "");
  if (!text) return false;
  const blockingPatterns = [
    /\bi (?:cannot|can'?t) (?:finish|complete|solve|compute|calculate|proceed|continue|move forward)\b/i,
    /\bmissing required (?:input|parameter|value|data|field)/i,
    /\b(?:i )?need (?:the )?(?:volatility|sigma|σ|risk-?free rate|dividend yield|input values|required values|model inputs)\b/i,
    /\bplease provide [^\n.]{0,80}? before i can (?:calculate|compute|solve|finish|complete|proceed)/i,
    /\bwithout (?:these|those|that|the volatility|the risk-?free|the dividend|this input) i (?:cannot|can'?t) (?:finish|complete|compute|calculate|solve|proceed)\b/i,
    /\bcannot (?:compute|calculate|finish|complete|solve) (?:this|it|the (?:problem|calculation|model|equation))[^\n]{0,80}(?:without|until)\b/i,
    /\bunable to (?:finish|complete|compute|calculate|solve)\b[^\n]{0,80}\bwithout\b/i,
    /\bblock(?:ed|er)\b[^\n]{0,60}\b(?:missing|need|until|without)\b/i
  ];
  return blockingPatterns.some((re) => re.test(text));
}

function analyzeWorkModeSameTurnReasoningResult(markdown, summary = "", opts = {}) {
  const raw = `${String(markdown || "")}\n${String(summary || "")}`.trim();
  const low = raw.toLowerCase();
  const same_turn_summary_preview = raw.slice(0, 220);
  const missing_inputs = extractWorkModeMissingInputsFromReasoning(raw);
  const substantive_answer_detected = detectSubstantiveWorkModeReasoningAnswer(raw, opts);
  const explicit_partial_found = detectExplicitPartialWorkModeReasoning(raw);
  const explicit_blocking_missing_info = detectExplicitBlockingMissingInfo(raw);
  const task_kind = classifyStage2TaskKind(opts.user_text, opts.turn_intent);

  const needsInfoPatterns = [
    /\bmissing inputs?\b/i,
    /\bunder-?specified\b/i,
    /\bstill need\b/i,
    /\bi still need\b/i,
    /\bnot (?:shown|provided|given|included)\b/i,
    /\bwithout those\b/i,
    /\bplease (?:provide|send|supply|give)\b/i,
    /\bneed (?:the )?(?:following|missing)\b/i,
    /\bcannot (?:compute|calculate|solve|finish)\b[^\n]{0,80}\bwithout\b/i,
    /\bcan't (?:compute|calculate|solve|finish)\b[^\n]{0,80}\bwithout\b/i,
    /\bone important issue\b/i,
    /\bbefore i can (?:finish|complete|solve)\b/i,
    /\bmissing parameters?\b/i,
    /\bneed more information\b/i,
    /\bneed (?:volatility|risk-?free|dividend)\b/i,
    /\b#{1,6}\s*missing inputs?\b/i
  ];
  const explicit_missing_info_found =
    needsInfoPatterns.some((re) => re.test(raw)) ||
    (missing_inputs.length >= 1 &&
      /\b(?:missing inputs?|under-?specified|still need|cannot .{0,80} without|before i can (?:finish|complete|solve)|need (?:volatility|risk-?free|dividend))\b/i.test(
        low
      ));

  const base = {
    missing_inputs,
    same_turn_summary_preview,
    status_reason: "",
    explicit_missing_info_found,
    explicit_partial_found,
    explicit_blocking_missing_info,
    substantive_answer_detected,
    task_kind
  };

  if (!raw) {
    return { ...base, status: "failed", status_reason: "empty_output" };
  }
  if (/\b(reasoning error|stream failed|could not complete)\b/i.test(raw)) {
    return { ...base, status: "failed", status_reason: "stream_error_text" };
  }
  if (explicit_missing_info_found) {
    // Intent gate: planning/explanation tasks that already produced a useful
    // answer should not be demoted to needs_missing_info unless the reasoning
    // output is genuinely blocking. This stops Stage 2 from saying
    // "still needs a few missing model inputs" after a usable essay/study plan.
    const planningLike = task_kind === "planning_writing" || task_kind === "explanation";
    if (planningLike && substantive_answer_detected && !explicit_blocking_missing_info) {
      return {
        ...base,
        status: "solved",
        status_reason: `missing_info_overridden_by_${task_kind}_intent`
      };
    }
    return { ...base, status: "needs_missing_info", status_reason: "explicit_missing_info" };
  }
  if (
    /\b(which one|could you clarify|please confirm|do you mean|need clarification|could you specify)\b/i.test(
      low
    ) &&
    /\?/.test(raw) &&
    !substantive_answer_detected
  ) {
    return { ...base, status: "clarification_required", status_reason: "clarification_question" };
  }
  if (explicit_partial_found && !substantive_answer_detected) {
    return { ...base, status: "partially_completed", status_reason: "explicit_partial_language" };
  }
  if (substantive_answer_detected) {
    return { ...base, status: "solved", status_reason: "substantive_answer_detected" };
  }
  if (explicit_partial_found) {
    return { ...base, status: "partially_completed", status_reason: "explicit_partial_with_substance" };
  }
  if (raw.length >= 120) {
    return { ...base, status: "solved", status_reason: "default_substantive_length" };
  }
  return { ...base, status: "failed", status_reason: "insufficient_content" };
}

function classifyWorkModeSameTurnReasoningResultStatus(markdown, summary = "", opts = {}) {
  return analyzeWorkModeSameTurnReasoningResult(markdown, summary, opts);
}

function stage2ClassifyOptsFromPrep(prep) {
  return {
    turn_intent: String(prep?.turnContext?.turn_intent || "").trim().toLowerCase(),
    user_text: String(prep?.turnContext?.user_text || "").trim()
  };
}

function extractWorkModeMissingInputsFromReasoning(text) {
  const found = new Set();
  const add = (label) => {
    const s = String(label || "").trim();
    if (s) found.add(s);
  };
  const raw = String(text || "");
  if (/\bvolatility\b|\bsigma\b|σ/i.test(raw)) add("volatility σ");
  if (/\brisk-?free rate\b/i.test(raw)) add("risk-free rate r");
  if (/\bdividend yield\b/i.test(raw)) add("dividend yield q");

  const sec = raw.match(/\b#{0,6}\s*missing inputs?\b[^\n]*\n([\s\S]{0,1400})/i);
  if (sec?.[1]) {
    for (const line of sec[1].split("\n")) {
      const bullet = line
        .replace(/^[\s>*#-]+/, "")
        .replace(/\*\*/g, "")
        .trim();
      if (!bullet || bullet.length > 140) continue;
      if (
        /\b(volatility|risk-?free|dividend|sigma|rate|yield|missing)\b/i.test(bullet) ||
        /^[-*•]\s*/.test(line)
      ) {
        add(bullet.replace(/^[-*•]\s*/, ""));
      }
    }
  }
  return [...found].slice(0, 8);
}

function stage2ScopeIdsFromPrep(prep) {
  const turn_id = String(prep?.turnContext?.turn_id || "").trim();
  const lane_id = String(prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || "").trim();
  return { turn_id, lane_id };
}

function stage2StatusMatchesScope(statusPack, prep) {
  if (!statusPack?.status) return false;
  const cur = stage2ScopeIdsFromPrep(prep);
  const st = String(statusPack.turn_id || "").trim();
  const sl = String(statusPack.lane_id || "").trim();
  if (!cur.turn_id || !st || st !== cur.turn_id) return false;
  if (cur.lane_id && sl && sl !== cur.lane_id) return false;
  return true;
}

function logStage2StatusScopeCheck(prep, statusSource, statusPack, statusUsed, reason) {
  const cur = stage2ScopeIdsFromPrep(prep);
  try {
    console.info("[stage2_status_scope_check]", {
      current_turn_id: cur.turn_id || null,
      current_lane_id: cur.lane_id || null,
      status_turn_id: statusPack?.turn_id ?? null,
      status_lane_id: statusPack?.lane_id ?? null,
      status_used: Boolean(statusUsed),
      detected_status: statusPack?.status ?? null,
      missing_inputs: statusPack?.missing_inputs ?? [],
      reason: String(reason || ""),
      status_source: statusSource || null
    });
  } catch (_) {}
}

function packStage2ResultStatus(prep, classified, source = "") {
  const cur = stage2ScopeIdsFromPrep(prep);
  return {
    turn_id: cur.turn_id,
    lane_id: cur.lane_id,
    status: classified.status,
    missing_inputs: Array.isArray(classified.missing_inputs) ? classified.missing_inputs : [],
    same_turn_summary_preview: String(classified.same_turn_summary_preview || "").slice(0, 220),
    status_reason: String(classified.status_reason || ""),
    explicit_missing_info_found: Boolean(classified.explicit_missing_info_found),
    explicit_partial_found: Boolean(classified.explicit_partial_found),
    explicit_blocking_missing_info: Boolean(classified.explicit_blocking_missing_info),
    substantive_answer_detected: Boolean(classified.substantive_answer_detected),
    task_kind: String(classified.task_kind || "general"),
    _source: String(source || "")
  };
}

function getWorkModeLaneMarkdownExcerptForStage2(laneId) {
  const lid = String(laneId || "").trim();
  if (!lid) return "";
  const panel = getReasoningPanelElementByLaneId(lid);
  if (!(panel instanceof HTMLElement)) return "";
  const scroll = panel.querySelector(".vera-reasoning-md-panel, .vera-reasoning-scroll");
  if (!(scroll instanceof HTMLElement)) return "";
  const turns = [...scroll.querySelectorAll(".vera-reasoning-turn")];
  const last = turns.length ? turns[turns.length - 1] : null;
  if (last instanceof HTMLElement) {
    const md = String(last.dataset.markdownAcc || "").trim();
    if (md) return md;
    const plain = String(last.innerText || last.textContent || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (plain.length > 48) return plain;
  }
  const acc = String(scroll.dataset.markdownAcc || "").trim();
  if (acc) return acc;
  return "";
}

function resolveScopedStage2ResultStatus(prep, opts = {}) {
  const cur = stage2ScopeIdsFromPrep(prep);
  const mdIn = String(opts.markdown || "").trim();
  const smIn = String(opts.summary || "").trim();

  const tryScoped = (pack, source) => {
    if (!pack?.status) return null;
    if (stage2StatusMatchesScope(pack, prep)) {
      logStage2StatusScopeCheck(prep, source, pack, true, "scope_match");
      return pack;
    }
    logStage2StatusScopeCheck(prep, source, pack, false, "scope_mismatch");
    return null;
  };

  const fromPrep = tryScoped(prep?.stage2ResultStatus, "prep.stage2ResultStatus");
  if (fromPrep) return fromPrep;

  const snap = cur.turn_id ? workModeStage2SameTurnByTurnId[cur.turn_id] || null : null;
  if (snap) {
    const snapMd = String(
      mdIn || snap.latest_final_answer_excerpt || snap.latest_markdown_preview || ""
    ).trim();
    const snapSm = String(smIn || snap.latest_reasoning_summary || "").trim();
    const reclassified = classifyWorkModeSameTurnReasoningResultStatus(snapMd, snapSm, stage2ClassifyOptsFromPrep(prep));
    const scoped = packStage2ResultStatus(prep, reclassified, "same_turn_snapshot_reclassify");
    if (stage2StatusMatchesScope(scoped, prep)) {
      logStage2StatusScopeCheck(prep, "same_turn_snapshot_reclassify", scoped, true, "reclassified");
      return scoped;
    }
  }

  const liveMd = mdIn || getWorkModeLaneMarkdownExcerptForStage2(cur.lane_id);
  const classified = classifyWorkModeSameTurnReasoningResultStatus(liveMd, smIn, stage2ClassifyOptsFromPrep(prep));
  const scoped = packStage2ResultStatus(
    prep,
    classified,
    liveMd ? "live_lane_classify" : "neutral_fallback"
  );
  logStage2StatusScopeCheck(
    prep,
    scoped._source,
    scoped,
    Boolean(liveMd || smIn),
    liveMd ? "classified_current_markdown" : "no_markdown_neutral"
  );
  return scoped;
}

function clearPrepStage2ResultStatus(prep, reason = "") {
  if (!prep) return;
  prep.stage2ResultStatus = null;
  try {
    console.info("[stage2_result_status_cleared]", {
      turn_id: prep?.turnContext?.turn_id ?? null,
      lane_id: prep?.turnContext?.turn_lane_id ?? null,
      reason: String(reason || "")
    });
  } catch (_) {}
}

function workModeReasoningStreamAllowsStage2(prep) {
  if (!prep?.voiceTwoStage?.reasoningRouted) return true;
  const cached = prep?.stage2ResultStatus;
  if (cached?.status && stage2StatusMatchesScope(cached, prep) && cached.status !== "failed") {
    return true;
  }
  const turnId = String(prep?.turnContext?.turn_id || "").trim();
  const rec = turnId ? workModeTtsTurnRegistry.get(turnId) : null;
  if (rec) {
    return Boolean(rec.markdown_len > 20 || rec.has_substantive_reasoning);
  }
  const snap = turnId ? workModeStage2SameTurnByTurnId[turnId] || null : null;
  return workModeStage2SameTurnSnapshotUsable(snap);
}

function getWorkModeStage2ResultStatusFromPrep(prep) {
  return resolveScopedStage2ResultStatus(prep);
}

/**
 * Canned-line gate.
 *   - clarification_required / failed → always canned.
 *   - partially_completed → canned only when reasoning explicitly says partial.
 *   - needs_missing_info → canned ONLY when the task kind is calculation /
 *     code_debug, OR the reasoning output uses explicit blocking language.
 *     Planning / writing / explanation tasks should keep speaking the
 *     LLM-generated Stage 2 sentence so the user hears what was actually
 *     produced (e.g. "I made a 1-hour English essay plan in the reasoning
 *     panel") instead of "still needs a few missing model inputs".
 */
function shouldUseCannedStage2SpokenLine(status, detected = {}) {
  const st = String(status || "").trim().toLowerCase();
  if (st === "clarification_required" || st === "failed") return true;
  if (st === "needs_missing_info") {
    const tk = String(detected.task_kind || "").trim().toLowerCase();
    const calcLike = tk === "calculation" || tk === "code_debug";
    if (calcLike) return true;
    if (detected.explicit_blocking_missing_info) return true;
    return false;
  }
  if (st === "partially_completed") {
    return Boolean(detected.explicit_partial_found);
  }
  return false;
}

function logStage2StatusIntentGate(prep, detected, decision) {
  try {
    const ids = stage2ScopeIdsFromPrep(prep);
    console.info("[stage2_status_intent_gate]", {
      turn_id: ids.turn_id || null,
      lane_id: ids.lane_id || null,
      user_text: String(prep?.turnContext?.user_text || "").slice(0, 240),
      detected_intent: String(prep?.turnContext?.turn_intent || "general"),
      task_kind: String(detected?.task_kind || "general"),
      detected_status: detected?.status || null,
      substantive_answer_detected: Boolean(detected?.substantive_answer_detected),
      explicit_missing_info_found: Boolean(detected?.explicit_missing_info_found),
      explicit_blocking_missing_info: Boolean(detected?.explicit_blocking_missing_info),
      used_canned_line: Boolean(decision?.used_canned_line),
      final_stage2_reply: String(decision?.final_stage2_reply || "").slice(0, 240),
      source: String(decision?.source || "")
    });
  } catch (_) {}
}

function buildWorkModeStage2SpokenOverride(detected, prep) {
  if (!shouldUseCannedStage2SpokenLine(detected?.status, detected)) {
    logStage2StatusIntentGate(prep, detected, {
      used_canned_line: false,
      final_stage2_reply: "",
      source: "build_override_gate_open"
    });
    return "";
  }
  const line = buildWorkModeStage2SpokenLine(
    detected.status,
    detected.missing_inputs,
    detected.task_kind
  );
  logStage2StatusIntentGate(prep, detected, {
    used_canned_line: Boolean(line),
    final_stage2_reply: line,
    source: "build_override_canned"
  });
  return line;
}

function buildWorkModeStage2SpokenLine(resultStatus, missingInputs, taskKind = "general") {
  const st = String(resultStatus || "").trim().toLowerCase();
  const miss = (missingInputs || []).map((x) => String(x || "").trim()).filter(Boolean);
  const tk = String(taskKind || "").trim().toLowerCase();
  if (st === "needs_missing_info") {
    if (tk === "calculation") {
      if (miss.length) {
        const joined =
          miss.length <= 3 ? miss.join(", ") : `${miss.slice(0, 2).join(", ")}, and a few other values`;
        return `I set up the calculation, but I still need ${joined} before I can finish it.`;
      }
      return "I set up the calculation, but I still need a few required values before I can finish it.";
    }
    if (tk === "code_debug") {
      if (miss.length) {
        const joined =
          miss.length <= 3 ? miss.join(", ") : `${miss.slice(0, 2).join(", ")}, and a few other details`;
        return `I started the code in the reasoning panel, but I still need ${joined} before I can finish it.`;
      }
      return "I started the code in the reasoning panel, but I still need a few details before I can finish it.";
    }
    // Reached only when explicit blocking language forces a canned line for a
    // non-calculation task. Avoid the robotic "model inputs" phrasing here.
    if (miss.length) {
      const joined =
        miss.length <= 3 ? miss.join(", ") : `${miss.slice(0, 2).join(", ")}, and a few more details`;
      return `I started it in the reasoning panel, but I still need ${joined} before I can finish.`;
    }
    return "I started it in the reasoning panel, but I still need a few more details before I can finish.";
  }
  if (st === "clarification_required") {
    return "I started the setup, but I need a quick clarification before I can finish it in the reasoning panel.";
  }
  if (st === "partially_completed") {
    return "I made partial progress on it in the reasoning panel, but it is not fully finished yet.";
  }
  if (st === "failed") {
    return "I could not finish that in the reasoning panel — check there for what went wrong.";
  }
  return "";
}

function stage2ReplyImpliesFalseSuccess(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  return (
    /\bi (?:solved|worked out|finished solving|completed solving)\b/.test(t) ||
    /\bi(?:'ve| have) solved\b/.test(t) ||
    /\bthe full (?:answer|result|solution) is ready\b/.test(t) ||
    /\bworked out the .* (?:setup|problem|solution)\b/.test(t) ||
    /\bleft the (?:full |complete )?(?:answer|solution|result) in\b/.test(t)
  );
}

function logStage2ResultStatus(prep, detected, generatedStage2Text, usedCannedLine = false) {
  const tc = prep?.turnContext;
  try {
    console.info("[stage2_result_status]", {
      turn_id: tc?.turn_id ?? null,
      user_text: String(tc?.user_text || "").trim(),
      detected_status: detected?.status ?? null,
      status_reason: detected?.status_reason ?? null,
      explicit_missing_info_found: Boolean(detected?.explicit_missing_info_found),
      explicit_partial_found: Boolean(detected?.explicit_partial_found),
      substantive_answer_detected: Boolean(detected?.substantive_answer_detected),
      generated_stage2_text: String(generatedStage2Text ?? "").slice(0, 500),
      used_canned_line: Boolean(usedCannedLine),
      missing_inputs: detected?.missing_inputs ?? []
    });
  } catch (_) {}
}

function classifyWorkModeTurnIntent(userText) {
  const t = String(userText || "").trim();
  const low = t.toLowerCase();
  if (!t) {
    return {
      turn_intent: "general",
      content_type_requested: "general",
      stage2_completion_action: "report_work_placed"
    };
  }
  if (detectWorkModeRequestHasCodeVoiceIntent(t)) {
    return {
      turn_intent: "code",
      content_type_requested: "source_code",
      stage2_completion_action: "report_code_placed"
    };
  }
  if (/\b(summarize|summary|recap|tl;?dr|tldr|in brief|shorter|shorten|condense)\b/i.test(low)) {
    return {
      turn_intent: "summarize",
      content_type_requested: "compressed_summary",
      stage2_completion_action: "report_summary_placed"
    };
  }
  if (
    /\b(fix|fixed|wrong|mistake|error in|not right|incorrect|revise|rewrite|change your|update the)\b/i.test(low)
  ) {
    return {
      turn_intent: "revise",
      content_type_requested: "correction",
      stage2_completion_action: "report_revision_placed"
    };
  }
  if (isLikelyWorkModePlanningIntent(t)) {
    return {
      turn_intent: "plan",
      content_type_requested: "plan_or_checklist",
      stage2_completion_action: "report_plan_placed"
    };
  }
  if (
    /\b(explain|why does|why do|how does|how do|describe|what is|what are|tell me about|overview of|walk me through)\b/i.test(
      low
    )
  ) {
    return {
      turn_intent: "explain",
      content_type_requested: "narrative_explanation",
      stage2_completion_action: "report_explanation_placed"
    };
  }
  if (
    /\b(solve|solution|work through|do this|this problem|the problem|calculate|compute|derive|find the|show work|show steps)\b/i.test(
      low
    ) ||
    /\b(homework|problem set|ps\d|exercise|delta|hedge|black-?scholes|option price)\b/i.test(low)
  ) {
    return {
      turn_intent: "solve",
      content_type_requested: "solution_work",
      stage2_completion_action: "report_solution_placed"
    };
  }
  return {
    turn_intent: "general",
    content_type_requested: "general",
    stage2_completion_action: "report_work_placed"
  };
}

function buildWorkModeReasoningStage1AckText(trimmed, opts = {}) {
  const o = opts || {};
  if (o.hasUpload) return "I'll work from your file in the reasoning space.";
  if (o.planningIntent) return "I'll lay out the plan in the reasoning space.";
  if (o.requestHasCodeIntent) return "Sure — I'll put the detailed code in the reasoning space.";
  if (o.requestHasProofIntent) return "I'll work through the proof in the reasoning space.";
  if (o.requestHasDenseMathIntent) return "I'll work the full solution in the reasoning space.";
  if (o.requestHasTableIntent) return "I'll put the full table in the reasoning space.";
  return "I'll work through this in the reasoning space.";
}

/**
 * Stage-1 reasoning acknowledgement using the same server TTS as normal replies (`/text` + `tts_only`),
 * not browser speechSynthesis. Shows the ack in the Voice UI before the main `/infer` reply when possible.
 * @param {string} [userTranscript] — same line as this turn's `/infer` transcript so the user bubble appears before the stage-1 bubble (typed work mode has no live partial row).
 */
async function maybePlayWorkModeReasoningStage1VeraTts(ackText, abortSignal, userTranscript, ttsTurn) {
  const s = String(ackText || "").trim();
  if (!s) return;
  if (!isVeraWorkModeOn()) return;
  const userT = String(userTranscript ?? "").trim();
  const ensureUserBubbleBeforeStage1 = () => {
    if (!userT) return;
    commitServerUserTranscriptBubble(userT, "work-mode-stage1-user-order");
  };
  const addStage1AssistantBubble = () => {
    const convoEl = uiEl("conversation");
    if (convoEl) {
      const rows = [...convoEl.querySelectorAll(".message-row")];
      const last = rows[rows.length - 1];
      if (last?.classList.contains("vera")) {
        const b = last.querySelector(".bubble");
        if (
          b instanceof HTMLElement &&
          b.classList.contains("vera-work-mode-stage1-ack") &&
          (b.textContent || "").trim() === s
        ) {
          return;
        }
      }
    }
    addBubble(s, "vera", { path: "work-mode-reasoning-stage1", bubbleClass: "vera-work-mode-stage1-ack" });
  };
  if (isWorkModeMuteEnabled()) {
    console.info("[voice] work_mode_stage1_skip_muted", { len: s.length });
    ensureUserBubbleBeforeStage1();
    addStage1AssistantBubble();
    return;
  }
  ensureUserBubbleBeforeStage1();
  addStage1AssistantBubble();
  try {
    console.info("[voice] work_mode_stage1_vera_tts", { preview: s.slice(0, 96) });
    await enqueueWorkModeAssistantTtsPlayback(
      async () => {
        await playWorkModeTtsOnlyPhrase(s, abortSignal);
      },
      ttsTurn,
      { stage: 1, text: s }
    );
  } catch (e) {
    if (e?.name === "AbortError") return;
    console.warn("[voice] work_mode_stage1_tts_error", e);
  }
}

function attachWorkModeVoiceBriefCompletionFlag(formData, prep) {
  if (!(formData instanceof FormData)) return;
  const vs = prep?.voiceTwoStage;
  if (!vs?.reasoningRouted) return;
  prep.stage2VoiceBubble = null;
  if (!workModeReasoningStreamAllowsStage2(prep)) return;
  /* Stage‑2 voice: one short spoken summary of what is already in the Reasoning panel (not a second full answer). */
  if (typeof formData.set === "function") formData.set("work_mode_voice_brief_completion", "1");
  else formData.append("work_mode_voice_brief_completion", "1");
  const tc = prep?.turnContext;
  const detected = resolveScopedStage2ResultStatus(prep, {
    markdown: String(prep?.stage2InferExcerpt || "").trim()
  });
  prep.stage2ResultStatus = detected;
  logStage2StatusScopeCheck(prep, detected._source || "stage2_attach", detected, true, "attached_to_infer");
  if (tc?.turn_id) {
    const payload = {
      turn_id: tc.turn_id,
      lane_id: String(tc.turn_lane_id || "").trim(),
      lane_title: String(tc.turn_lane_title || "").trim(),
      current_user_text: String(tc.user_text || "").trim(),
      turn_intent: String(tc.turn_intent || "general").trim(),
      content_type_requested: String(tc.content_type_requested || "general").trim(),
      stage2_completion_action: String(tc.stage2_completion_action || "report_work_placed").trim(),
      reasoning_result_status: detected.status,
      status_turn_id: detected.turn_id,
      status_lane_id: detected.lane_id,
      missing_inputs: detected.missing_inputs || [],
      same_turn_summary_preview: detected.same_turn_summary_preview || ""
    };
    const raw = JSON.stringify(payload);
    try {
      if (typeof formData.set === "function") formData.set("work_mode_stage2_turn_json", raw);
      else formData.append("work_mode_stage2_turn_json", raw);
    } catch (_) {
      formData.append("work_mode_stage2_turn_json", raw);
    }
  }
  const spokenOverride = buildWorkModeStage2SpokenOverride(detected, prep);
  if (spokenOverride) {
    if (typeof formData.set === "function") formData.set("work_mode_stage2_spoken_override", spokenOverride);
    else formData.append("work_mode_stage2_spoken_override", spokenOverride);
    storeEffectiveStage2ReplyOnPrep(prep, {
      effective_stage2_reply: spokenOverride,
      generated_stage2_text: "",
      used_override: true,
      override_reason: "canned_status_line_attach"
    });
  }
  logStage2ResultStatus(prep, detected, spokenOverride || "", Boolean(spokenOverride));
  clearPrepStage2ResultStatus(prep, "consumed_by_stage2_attach");
}

/** Last few Voice UI lines (+ queued typed turns) so “example” requests track the latest topic. */
function buildVoiceUiRecentContextBlock(maxRows = 8, includePendingTypedQueue = false) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return "";
  const lines = [];
  if (includePendingTypedQueue && workModeTypedTurnQueue.length) {
    for (const item of workModeTypedTurnQueue) {
      const q = String(item?.text || "").trim();
      if (q) lines.push(`User (queued next): ${q}`);
    }
  }
  const convo = document.getElementById("vera-conversation");
  if (convo instanceof HTMLElement) {
    const rows = [...convo.querySelectorAll(".message-row")].filter(
      (row) => row.classList.contains("user") || row.classList.contains("vera")
    );
    const tail = rows.slice(-Math.max(2, maxRows));
    for (const row of tail) {
      const bubble = row.querySelector(".bubble");
      if (!(bubble instanceof HTMLElement)) continue;
      if (bubble.classList.contains("interrupt-preview")) continue;
      const role = row.classList.contains("user") ? "User" : "Assistant";
      let text = String(bubble.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 1400) text = `${text.slice(0, 1400)}…`;
      lines.push(`${role}: ${text}`);
    }
  }
  if (lines.length < 1) return "";
  if (lines.length === 1 && !includePendingTypedQueue) return "";
  return (
    "[Recent voice chat — the example request refers to the topic below, not a new unrelated task]\n" + lines.join("\n")
  );
}

function isLikelyWorkChecklistEditIntent(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  const hasChecklist = /\bcheck\s*list|checklist\b/.test(t);
  if (hasChecklist && /\b(add|remove)\b/.test(t)) return true;
  if (/\b(update|replace)\b/.test(t) && (/\bwith\b/.test(t) || /\bitem\s+\d+\b/.test(t))) {
    return true;
  }
  return false;
}

const WORK_MODE_TOPIC_STOPWORDS = new Set([
  "tell", "about", "explain", "what", "when", "where", "which", "how", "does", "with", "from", "into",
  "your", "you", "please", "help", "need", "want", "give", "show", "some", "more", "this", "that",
  "can", "could", "would", "should", "just", "like", "very", "much", "also", "into", "over", "after",
  "before", "during", "each", "other", "another", "example", "examples", "question", "answer"
]);

function topicTokensForWorkModeTopic(text) {
  const raw = String(text || "")
    .toLowerCase()
    .match(/[a-z][a-z0-9']{2,}/g);
  if (!raw) return [];
  return raw.filter((w) => !WORK_MODE_TOPIC_STOPWORDS.has(w));
}

function topicSimilarityScore(aText, bText) {
  const a = new Set(topicTokensForWorkModeTopic(aText));
  const b = new Set(topicTokensForWorkModeTopic(bText));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = new Set([...a, ...b]);
  return union.size ? inter / union.size : 0;
}

function runOnLaneReasoningChain(laneIdx, task) {
  const key = Number(laneIdx);
  const prev = laneReasoningChainTail.get(key) || Promise.resolve();
  const next = prev.then(() => task());
  laneReasoningChainTail.set(key, next.catch(() => {}));
  return next;
}

async function selectLaneForWorkModeReasoningTurn(trimmed, opts = {}) {
  const t = String(trimmed || "").trim();
  const autoRoute = isWorkModeReasoningAutoRouteEnabled();

  if (autoRoute) {
    if (!t) return await acquireWorkModeReasoningLane("");
    if (isGenericExampleFollowUpText(t) && Number.isFinite(Number(workModeLastSubstantiveLaneIdx))) {
      /* Follow-ups chain onto the prior substantive lane (serialized by `runOnLaneReasoningChain`);
         route through the acquirer so the global concurrent-reasoning cap is honored if that lane
         is currently busy and the pool is at capacity. */
      return await acquireWorkModeReasoningLaneForIndex(Number(workModeLastSubstantiveLaneIdx));
    }
    if (opts.continuePriorLane === true && Number.isFinite(Number(workModeLastSubstantiveLaneIdx))) {
      return await acquireWorkModeReasoningLaneForIndex(Number(workModeLastSubstantiveLaneIdx));
    }
    let bestLane = -1;
    let bestScore = 0;
    for (const idx of getReasoningPanelIndices()) {
      const seed = String(laneTopicSeedByIdx[idx] || "").trim();
      if (!seed) continue;
      const sc = topicSimilarityScore(t, seed);
      if (sc > bestScore) {
        bestScore = sc;
        bestLane = idx;
      }
    }
    if (bestScore >= WORK_MODE_TOPIC_SIMILARITY_MERGE && bestLane >= 0) {
      return await acquireWorkModeReasoningLaneForIndex(bestLane);
    }
    return await acquireWorkModeReasoningLane(t);
  }

  if (!t) return await acquireWorkModeReasoningLaneForIndex(getActiveReasoningLaneIndex() ?? 0);
  /* Active-panel mode: always the tab the user selected — no thread/example pinning or topic similarity. */
  return await acquireWorkModeReasoningLaneForIndex(getActiveReasoningLaneIndex() ?? 0);
}

function enqueueWorkModeTypedVoiceInfer(run) {
  if (workModeTypedVoiceInferDepth >= WORK_MODE_TYPED_VOICE_CHAIN_MAX) return false;
  workModeTypedVoiceInferDepth += 1;
  workModeTypedVoiceInferTail = workModeTypedVoiceInferTail
    .then(() => run())
    .catch((err) => {
      if (err?.name !== "AbortError") console.warn("[WorkMode] typed voice infer chain", err);
    })
    .finally(() => {
      workModeTypedVoiceInferDepth -= 1;
      if (workModeTypedTurnQueue.length > 0 && !isWorkModeTypedTurnBlocked()) {
        scheduleWorkModeTypedQueueDrain();
      }
    });
  return true;
}

/**
 * One global FIFO for work-mode voice turns: prep + stage‑1 ack TTS + handoff setup. When reasoning is routed,
 * stage‑2 `/infer` (spoken brief) runs after this tail so the user can speak or type another request while
 * reasoning finishes; stage‑2 audio joins the same assistant TTS queue as everything else.
 */
let workModeVoiceInferPlaybackTail = Promise.resolve();
/** Increments when a work-mode voice/typed infer turn enters the serialized tail (used for stage‑2 "Also," prefix). */
let workModeVoiceInferTurnSeq = 0;
/** Stage‑2 `/infer` uses this so normal interrupt / new-turn `activePipelineAbort` does not cancel the deferred fetch. */
let workModeDeferredStage2AbortController = new AbortController();

function resetWorkModeDeferredStage2AbortController() {
  try {
    workModeDeferredStage2AbortController.abort();
  } catch (_) {}
  workModeDeferredStage2AbortController = new AbortController();
}

function bumpWorkModeVoiceInferTurnSeq() {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  workModeVoiceInferTurnSeq += 1;
}

function enqueueWorkModeVoiceInferPlaybackTurn(run) {
  const p = workModeVoiceInferPlaybackTail.catch(() => {}).then(() => run());
  workModeVoiceInferPlaybackTail = p.catch(() => {});
  return p;
}

/* =========================
   WORK MODE TURN-BASED TTS QUEUE
========================= */
let workModeTtsTurnSeqCounter = 0;
let workModeTtsGlobalGeneration = 0;
/** @type {Map<string, string>} reasoning / submission lane_id → latest turn_id */
const workModeLatestTurnIdByLane = new Map();
/** @type {Map<string, object>} turn_id → per-turn TTS / reasoning metadata */
const workModeTtsTurnRegistry = new Map();
/** reasoning_lane_id → turn_id while stream in flight */
const workModeReasoningStreamTurnByLaneId = Object.create(null);
/** turn_id → excerpt/summary from the reasoning stream that just committed (Stage 2 must ground here first). */
const workModeStage2SameTurnByTurnId = Object.create(null);
/** @type {Array<object>} */
let workModeTtsQueue = [];
let workModeTtsDrainRunning = false;
/** @type {{ turn_id: string, lane_id: string, stage: number } | null} */
let workModeTtsCurrentlyPlaying = null;

const WORK_MODE_TTS_PRIOR_READY_PHRASE = "The earlier result is ready too.";

// Explicit replace phrases — matched against the *newer* turn's user text.
// Conservative on purpose: only clear cancel/replace language. Casual
// interjections must NOT silence a useful prior Stage 2.
const WORK_MODE_EXPLICIT_REPLACE_RX =
  /\b(?:stop|cancel|cancel\s+that|scratch\s+that|forget\s+(?:that|it)|never\s*mind|nevermind|disregard\s+that|ignore\s+that|do\s+(?:this|that)\s+instead|instead\s+do|actually\s+(?:do|use|make)|wait[, ]+stop|hold on stop|drop\s+that)\b/i;

// Same-lane topic similarity at/above this threshold counts as a true
// REFINEMENT of the older request (e.g. "actually make it 30 minutes").
// Below this is just a topic shift within the same lane bucket and must
// NOT silence the older Stage 2 (the user explicitly asked for this).
const WORK_MODE_TOPIC_REFINEMENT_MIN = Math.max(
  0.4,
  WORK_MODE_TOPIC_SIMILARITY_MERGE * 1.5
);

function userTextLooksLikeExplicitReplace(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  return WORK_MODE_EXPLICIT_REPLACE_RX.test(s);
}

function logStage2InterruptPolicy(fields) {
  try {
    console.info("[tts_stage2_interrupt_policy]", fields);
  } catch (_) {}
}

function resetWorkModeTurnTtsQueue() {
  workModeTtsTurnSeqCounter = 0;
  workModeTtsGlobalGeneration = 0;
  workModeLatestTurnIdByLane.clear();
  workModeTtsTurnRegistry.clear();
  for (const k of Object.keys(workModeReasoningStreamTurnByLaneId)) {
    delete workModeReasoningStreamTurnByLaneId[k];
  }
  for (const k of Object.keys(workModeStage2SameTurnByTurnId)) {
    delete workModeStage2SameTurnByTurnId[k];
  }
  workModeTtsQueue.length = 0;
  workModeTtsDrainRunning = false;
  workModeTtsCurrentlyPlaying = null;
}

function getWorkModeTtsTurnRecord(turnId) {
  return workModeTtsTurnRegistry.get(String(turnId || "")) || null;
}

function turnSeqFromTurnId(turnId) {
  const m = String(turnId || "").match(/^wm-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function logTtsDropStale(item, drop_reason) {
  const latest = workModeLatestTurnIdByLane.get(String(item?.lane_id || ""));
  console.info("[tts_drop_stale]", {
    turn_id: item?.turn_id,
    lane_id: item?.lane_id,
    stage: item?.stage,
    latest_turn_id_for_lane: latest || null,
    drop_reason
  });
}

function isReasoningLaneDomPresent(reasoningLaneId) {
  const lid = String(reasoningLaneId || "").trim();
  if (!lid) return true;
  const idx = getReasoningLaneIndexFromLaneId(lid);
  if (idx == null) return false;
  return Boolean(
    document.querySelector(
      `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
    )
  );
}

function newerTurnSemanticallyReplacesOlder(oldRec, newRec) {
  if (!oldRec || !newRec || oldRec.turn_id === newRec.turn_id) return false;
  if (String(oldRec.reasoning_lane_id || "") !== String(newRec.reasoning_lane_id || "")) {
    return false;
  }
  const sim = topicSimilarityScore(oldRec.user_text || "", newRec.user_text || "");
  return sim < WORK_MODE_TOPIC_SIMILARITY_MERGE;
}

function isAudioReplacedByNewerCompletion(item) {
  const lane = String(item?.lane_id || "");
  const seq = Number(item?.turn_seq) || 0;
  const playing = workModeTtsCurrentlyPlaying;
  if (
    playing?.stage === 2 &&
    String(playing.lane_id) === lane &&
    turnSeqFromTurnId(playing.turn_id) > seq
  ) {
    return true;
  }
  for (const q of workModeTtsQueue) {
    if (q.stage !== 2) continue;
    if (String(q.lane_id) !== lane) continue;
    if (Number(q.turn_seq) > seq) return true;
  }
  return false;
}

/**
 * Stage-2 playback policy.
 *
 * Policy (per "Stage 2 should keep speaking unless explicitly cancelled / replaced"):
 *   1. `rec.canceled`           -> drop audio (user explicitly cancelled). Bubble stays.
 *   2. reasoning lane DOM gone  -> text_only (lane was removed; nothing to anchor audio to).
 *   3. newer turn on a DIFFERENT lane         -> SPEAK (audio queued, not dropped).
 *   4. newer turn on the SAME lane, with explicit replace words ("stop / scratch that
 *      / do this instead" etc.) OR HIGH topic similarity (= true refinement of the same
 *      task) -> drop audio (text_only). If the older reasoning was substantive, add the
 *      short supplement so the user still hears that the earlier result is available.
 *   5. newer turn on the SAME lane but it's clearly a different topic (low similarity,
 *      no explicit replace) -> SPEAK (the older Stage 2 is still relevant).
 *   6. no newer turn                          -> SPEAK.
 *
 * The drain loop already serializes playback, so "queued behind the currently playing
 * item" naturally implements the "delay until current speech finishes" behavior the
 * user asked for; we do NOT need a separate `delay` action.
 *
 * @returns {{ action: 'play_full'|'text_only'|'text_only_with_supplement', drop_reason?: string, supplementPhrase?: string, spokenOverride?: string|null }}
 */
function evaluateWorkModeStage2Tts(item) {
  const rec = getWorkModeTtsTurnRecord(item?.turn_id);
  const lane = String(item?.lane_id || "").trim();
  const latestId = workModeLatestTurnIdByLane.get(lane);
  const latestRec = latestId ? getWorkModeTtsTurnRecord(latestId) : null;
  const isLatest = latestId && String(item?.turn_id) === String(latestId);
  const newerExists = Boolean(latestRec && !isLatest);

  const ownLane = String(rec?.reasoning_lane_id || lane || "");
  const latestLane = String(latestRec?.reasoning_lane_id || "");
  const sameLane = !latestRec || ownLane === latestLane;

  const explicitlyCancelled = Boolean(rec?.canceled);
  const explicitReplace =
    newerExists && sameLane && userTextLooksLikeExplicitReplace(latestRec?.user_text);
  const similarity = newerExists
    ? topicSimilarityScore(rec?.user_text || "", latestRec?.user_text || "")
    : 0;
  const refinement =
    newerExists && sameLane && !explicitReplace && similarity >= WORK_MODE_TOPIC_REFINEMENT_MIN;
  const supersededSameTask = explicitReplace || refinement;

  // Decide.
  let internalAction;            // "speak" | "text_only" | "text_only_with_supplement" | "drop"
  let reason;

  if (explicitlyCancelled) {
    internalAction = "drop";
    reason = "explicit_cancel";
  } else {
    const reasoningLane = String(rec?.reasoning_lane_id || lane).trim();
    if (reasoningLane && !isReasoningLaneDomPresent(reasoningLane)) {
      internalAction = "text_only";
      reason = "lane_not_active";
    } else if (supersededSameTask) {
      reason = explicitReplace ? "same_lane_explicit_replace" : "same_lane_refinement";
      internalAction = rec?.has_substantive_reasoning
        ? "text_only_with_supplement"
        : "text_only";
    } else {
      // No replacement. Different lane / different topic on same lane / no newer turn
      // all keep the audio. The queue will deliver it after any currently-playing item.
      internalAction = "speak";
      if (!newerExists) reason = "no_newer_turn";
      else if (!sameLane) reason = "different_lane_kept";
      else reason = "same_lane_topic_shift_kept";
    }
  }

  // Debug log as specified in the spec.
  logStage2InterruptPolicy({
    turn_id: item?.turn_id || null,
    lane_id: lane || null,
    stage: item?.stage ?? 2,
    latest_turn_id_for_lane: latestId || null,
    newer_turn_exists: newerExists,
    same_lane: sameLane,
    explicitly_cancelled: explicitlyCancelled,
    superseded_same_task: supersededSameTask,
    similarity: Number.isFinite(similarity) ? Number(similarity.toFixed(3)) : null,
    action:
      internalAction === "speak" ? "speak"
      : internalAction === "drop" ? "drop"
      : "text_only",
    reason
  });

  if (internalAction === "speak") {
    return { action: "play_full", spokenOverride: null };
  }
  if (internalAction === "text_only_with_supplement") {
    return {
      action: "text_only_with_supplement",
      drop_reason: reason,
      supplementPhrase: WORK_MODE_TTS_PRIOR_READY_PHRASE
    };
  }
  // "drop" and "text_only" both surface to the queue as text_only (no audio, bubble stays).
  return { action: "text_only", drop_reason: reason };
}

function registerWorkModeTtsTurnRecord(ttsTurn, prep, userText) {
  if (!ttsTurn?.turn_id) return;
  const vs = prep?.voiceTwoStage || {};
  const reasoningLane = String(
    prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || ttsTurn.lane_id || ""
  ).trim();
  workModeTtsTurnRegistry.set(ttsTurn.turn_id, {
    turn_id: ttsTurn.turn_id,
    turn_seq: ttsTurn.turn_seq,
    lane_id: reasoningLane || ttsTurn.lane_id,
    reasoning_lane_id: reasoningLane,
    user_text: String(userText || "").trim(),
    reasoning_routed: Boolean(vs.reasoningRouted),
    has_substantive_reasoning: false,
    code_or_math: false,
    canceled: false,
    markdown_len: 0
  });
  const streamLane = String(prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || reasoningLane).trim();
  if (streamLane) {
    workModeReasoningStreamTurnByLaneId[streamLane] = ttsTurn.turn_id;
  }
}

function notifyWorkModeTtsReasoningCommitted(commitLaneId, payload) {
  const turnId = workModeReasoningStreamTurnByLaneId[String(commitLaneId || "").trim()];
  if (!turnId) return;
  const rec = workModeTtsTurnRegistry.get(turnId);
  if (!rec) return;
  const md = String(
    payload?.latest_markdown_preview || payload?.latest_final_answer_excerpt || ""
  ).trim();
  const summary = String(payload?.latest_reasoning_summary || "").trim();
  rec.markdown_len = md.length;
  rec.code_or_math = Boolean(payload?.code_or_math_generated);
  rec.has_substantive_reasoning = Boolean(
    rec.code_or_math ||
      md.length > 120 ||
      summary.length > 48 ||
      /```/.test(md)
  );
}

function guessWorkModeTtsLaneId() {
  const focused = getFocusedWorkModeLaneId();
  if (focused) return focused;
  const idx = getActiveReasoningLaneIndex();
  if (idx != null && Number.isFinite(Number(idx))) {
    const lid = getWorkModeReasoningLaneId(Number(idx));
    if (lid) return lid;
  }
  return "voice";
}

/** Allocate turn metadata for a new user request (stage‑1 ack + stage‑2 completion share this). */
function beginWorkModeUserTtsTurn(laneId) {
  const lane_id = String(laneId || guessWorkModeTtsLaneId()).trim() || "voice";
  workModeTtsTurnSeqCounter += 1;
  workModeTtsGlobalGeneration += 1;
  const turn_seq = workModeTtsTurnSeqCounter;
  const turn_id = `wm-${turn_seq}`;
  workModeLatestTurnIdByLane.set(lane_id, turn_id);
  return { turn_id, lane_id, generation_id: workModeTtsGlobalGeneration, turn_seq };
}

function finalizeWorkModeTtsTurnLane(ttsTurn, laneId) {
  if (!ttsTurn) return;
  const lid = String(laneId || "").trim();
  if (!lid) return;
  ttsTurn.lane_id = lid;
  workModeLatestTurnIdByLane.set(lid, ttsTurn.turn_id);
  const rec = workModeTtsTurnRegistry.get(ttsTurn.turn_id);
  if (rec) rec.reasoning_lane_id = lid;
}

function attachWorkModeTtsTurnAfterPrep(prep, ttsTurn, userText) {
  if (!prep || !ttsTurn) return prep;
  registerWorkModeTtsTurnRecord(ttsTurn, prep, userText);
  const laneId = prep.turnContext?.turn_lane_id || prep.reasoningLaneId;
  if (laneId) finalizeWorkModeTtsTurnLane(ttsTurn, laneId);
  prep.ttsTurn = ttsTurn;
  return prep;
}

function workModeTtsSortKey(item) {
  return Number(item.turn_seq) * 10 + (item.stage === 1 ? 1 : 2);
}

function logTtsTextPreview(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

const STAGE2_TTS_SAFE_MAX_CHARS = 320;

/**
 * Stage‑2 brief‑completion lines should be one speakable sentence. If the model drifts into
 * code/tables/length, fall back to a short emergency phrase for TTS (and bubble) only.
 */
function diagnoseStage2ReplyUnsafeForTts(s) {
  const t = String(s || "");
  const reasons = [];
  if (!t.trim()) {
    return { unsafe: true, reasons: ["empty"] };
  }
  if (t.length > STAGE2_TTS_SAFE_MAX_CHARS) reasons.push("too_long");
  if (/```/.test(t)) reasons.push("code_fence");
  if (/<\s*table\b/i.test(t)) reasons.push("html_table");
  if (/^\s*\|[^\n]+\|[^\n]+\|/m.test(t) || /\n\|[^\n]+\|[^\n]+\|/.test(t) || /\|\s*---+\s*\|/.test(t)) {
    reasons.push("markdown_table");
  }
  if (/\\begin\{|\\\[|\\\(|\\\]|\$\$/m.test(t) || /\$[^$\n]{1,400}\$/m.test(t)) {
    reasons.push("latex_or_inline_math");
  }
  return { unsafe: reasons.length > 0, reasons };
}

/** Short Stage-2 lines without code fences / tables: prefer speaking them over canned handoff lines. */
function isStage2BriefProseOkDespiteLightFlags(s) {
  const t = String(s || "").trim();
  if (!t || t.length > 420) return false;
  if (/```/.test(t)) return false;
  if (/^\s*\|[^\n]+\|/.test(t) || /\|\s*---+\s*\|/.test(t)) return false;
  if (/<\s*table\b/i.test(t)) return false;
  const words = (t.match(/\S+/g) || []).length;
  return words <= 56;
}

function stage2TopicPhraseFromUserText(userText) {
  let t = String(userText || "")
    .trim()
    .replace(/[?.!]+$/g, "")
    .trim();
  if (!t) return "";
  t = t
    .replace(
      /^(please|can you|could you|would you|help me|i need you to|i want you to)\s+/i,
      ""
    )
    .replace(
      /^(explain|summarize|summarise|describe|outline|write|solve|compute|calculate|find|show)\s+/i,
      ""
    )
    .trim();
  if (t.length > 72) t = `${t.slice(0, 69).trim()}…`;
  return t;
}

/** Safe Stage-2 line when the model reply is empty or unsafe for voice/bubble. */
function buildSafeStage2FallbackLine(prep) {
  const detected = getWorkModeStage2ResultStatusFromPrep(prep);
  // Only use a canned status line when the intent gate allows it. Planning /
  // explanation tasks with substantive answers fall through to the topical
  // wording below so the user hears what actually got produced.
  if (shouldUseCannedStage2SpokenLine(detected.status, detected)) {
    const statusLine = buildWorkModeStage2SpokenLine(
      detected.status,
      detected.missing_inputs,
      detected.task_kind
    );
    if (statusLine) return statusLine;
  }
  const intent = String(prep?.turnContext?.turn_intent || "").trim().toLowerCase();
  const topic = stage2TopicPhraseFromUserText(prep?.turnContext?.user_text);
  if (intent === "code") {
    return topic
      ? `I put the code for ${topic} in the reasoning panel.`
      : "I put the code in the reasoning panel.";
  }
  if (intent === "solve") {
    return topic ? `I solved ${topic} in the reasoning panel.` : "I solved it in the reasoning panel.";
  }
  if (intent === "explain") {
    return topic
      ? `I wrote ${topic} in the reasoning panel.`
      : "I wrote the explanation in the reasoning panel.";
  }
  if (intent === "plan") {
    return topic ? `I laid out the plan for ${topic} in the reasoning panel.` : "I laid out the plan in the reasoning panel.";
  }
  if (intent === "revise") {
    return topic ? `I updated ${topic} in the reasoning panel.` : "I updated it in the reasoning panel.";
  }
  if (intent === "summarize") {
    return topic ? `I summarized ${topic} in the reasoning panel.` : "I summarized it in the reasoning panel.";
  }
  return topic
    ? `The full answer for ${topic} is in the reasoning panel.`
    : "The full answer is in the reasoning panel.";
}

/**
 * Single canonical Stage-2 sentence for Voice UI bubble and TTS.
 * @returns {{
 *   effective_stage2_reply: string,
 *   generated_stage2_text: string,
 *   used_override: boolean,
 *   override_reason: string | null
 * }}
 */
function resolveEffectiveStage2Reply(prep, generatedReply, ttsStage) {
  const generated_stage2_text = String(generatedReply ?? "").trim();
  const passthrough = {
    effective_stage2_reply: generated_stage2_text,
    generated_stage2_text,
    used_override: false,
    override_reason: null
  };
  if ((ttsStage ?? 2) !== 2 || !prep?.voiceTwoStage?.reasoningRouted) {
    return passthrough;
  }
  const finalStatus = getWorkModeReasoningFinalStatus(prep);
  const finalStatusName = String(finalStatus?.status || "").trim().toLowerCase();
  if (finalStatusName === "cancelled" || finalStatusName === "user_stopped") {
    const stopped = "I stopped that reasoning request.";
    logStage2ReasoningStatus(prep, finalStatus, stopped, false, "reasoning_cancelled");
    return {
      effective_stage2_reply: stopped,
      generated_stage2_text,
      used_override: true,
      override_reason: "reasoning_cancelled"
    };
  }
  if (finalStatusName && /failed|error|timed_out/.test(finalStatusName)) {
    const failed = VERA_SAFETY_LIMITS.messages.llmFailure;
    logStage2ReasoningStatus(prep, finalStatus, failed, false, "reasoning_failed");
    return {
      effective_stage2_reply: failed,
      generated_stage2_text,
      used_override: true,
      override_reason: "reasoning_failed"
    };
  }
  logStage2ReasoningStatus(prep, finalStatus, generated_stage2_text, true, "");
  const detected = getWorkModeStage2ResultStatusFromPrep(prep);
  if (shouldUseCannedStage2SpokenLine(detected.status, detected)) {
    const fixed = buildWorkModeStage2SpokenLine(
      detected.status,
      detected.missing_inputs,
      detected.task_kind
    );
    if (fixed) {
      logStage2StatusIntentGate(prep, detected, {
        used_canned_line: true,
        final_stage2_reply: fixed,
        source: "resolve_effective_canned"
      });
      return {
        effective_stage2_reply: fixed,
        generated_stage2_text,
        used_override: true,
        override_reason: "canned_status_line"
      };
    }
  } else {
    logStage2StatusIntentGate(prep, detected, {
      used_canned_line: false,
      final_stage2_reply: generated_stage2_text,
      source: "resolve_effective_gate_open"
    });
  }
  if (
    detected.status === "solved" &&
    stage2ReplyImpliesFalseSuccess(generated_stage2_text) &&
    detected.explicit_partial_found
  ) {
    const fixed = buildWorkModeStage2SpokenLine(
      "partially_completed",
      detected.missing_inputs,
      detected.task_kind
    );
    if (fixed) {
      return {
        effective_stage2_reply: fixed,
        generated_stage2_text,
        used_override: true,
        override_reason: "false_success_explicit_partial"
      };
    }
  }
  const diag = diagnoseStage2ReplyUnsafeForTts(generated_stage2_text);
  if (!diag.unsafe) {
    return {
      effective_stage2_reply: generated_stage2_text,
      generated_stage2_text,
      used_override: false,
      override_reason: null
    };
  }
  if (isStage2BriefProseOkDespiteLightFlags(generated_stage2_text)) {
    return {
      effective_stage2_reply: generated_stage2_text,
      generated_stage2_text,
      used_override: false,
      override_reason: "brief_prose_despite_light_flags"
    };
  }
  const fallback = buildSafeStage2FallbackLine(prep);
  return {
    effective_stage2_reply: fallback,
    generated_stage2_text,
    used_override: true,
    override_reason: diag.reasons.includes("empty") ? "empty_reply" : diag.reasons.join(",")
  };
}

function storeEffectiveStage2ReplyOnPrep(prep, pack) {
  if (!prep || !pack) return pack;
  prep.effectiveStage2Reply = pack;
  return pack;
}

function logStage2EffectiveReply(prep, pack, bubbleTextFinal, ttsTextFinal) {
  const tc = prep?.turnContext;
  try {
    console.info("[stage2_effective_reply]", {
      turn_id: tc?.turn_id ?? null,
      lane_id: tc?.turn_lane_id ?? null,
      generated_stage2_text: String(pack?.generated_stage2_text ?? "").slice(0, 500),
      effective_stage2_reply: String(pack?.effective_stage2_reply ?? "").slice(0, 500),
      bubble_text_final: String(bubbleTextFinal ?? "").slice(0, 500),
      tts_text_final: String(ttsTextFinal ?? "").slice(0, 500),
      used_override: Boolean(pack?.used_override),
      override_reason: pack?.override_reason ?? null
    });
  } catch (_) {}
}

function logStage2Debug(prep, extra = {}) {
  const tc = prep?.turnContext || {};
  const laneId = String(tc.turn_lane_id || prep?.reasoningLaneId || "").trim();
  const activeLaneId = getActiveDomReasoningLaneId();
  const reasoningContext = laneId ? resolveWorkModeLaneHandoffForInfer(laneId, { silentResyncLog: true }) : null;
  try {
    console.info("[STAGE2_DEBUG]", {
      muted_input: Boolean(inputMuted),
      work_mode_muted: Boolean(isWorkModeMuteEnabled()),
      tts_muted: Boolean(appModePrefix() === "vera" && isVeraWorkModeOn() && isWorkModeMuteEnabled()),
      user_text_present: Boolean(String(tc.user_text || "").trim()),
      user_text_length: String(tc.user_text || "").trim().length,
      transcript_present: Boolean(String(extra.transcript || tc.user_text || "").trim()),
      transcript_length: String(extra.transcript || tc.user_text || "").trim().length,
      lane_id: laneId || null,
      active_panel_id: activeLaneId || null,
      reasoning_context_present: Boolean(reasoningContext),
      reasoning_context_length: String(
        reasoningContext?.main_context_excerpt ||
          reasoningContext?.latest_final_answer_excerpt ||
          reasoningContext?.latest_markdown_preview ||
          ""
      ).length,
      reasoning_completed: Boolean(extra.reasoning_completed),
      reasoning_success: Boolean(extra.reasoning_success),
      stage2_requested: Boolean(prep?.voiceTwoStage?.reasoningRouted),
      stage2_payload_valid: Boolean(extra.stage2_payload_valid),
      stage2_text_generated: Boolean(String(extra.stage2_text || "").trim()),
      stage2_tts_requested: Boolean(extra.stage2_tts_requested),
      stage2_tts_suppressed_due_to_mute: Boolean(extra.stage2_tts_suppressed_due_to_mute),
      stage2_error: extra.stage2_error ? String(extra.stage2_error).slice(0, 300) : "",
      fallback_reason: String(extra.fallback_reason || "")
    });
  } catch (_) {}
}

function getWorkModeStage2TtsDecision(stage2Text = "") {
  const inWork = appModePrefix() === "vera" && isVeraWorkModeOn();
  const workModeMuted = inWork && isWorkModeMuteEnabled();
  const mutedInput = Boolean(inputMuted);
  const ttsMuted = Boolean(workModeMuted || (inWork && mutedInput));
  let suppressionReason = "";
  if (!String(stage2Text || "").trim()) {
    suppressionReason = "empty_stage2_text";
  } else if (workModeMuted) {
    suppressionReason = "work_mode_muted";
  } else if (mutedInput) {
    suppressionReason = "input_output_muted";
  }
  return {
    stage2_text_present: Boolean(String(stage2Text || "").trim()),
    muted_input: mutedInput,
    work_mode_muted: workModeMuted,
    tts_muted: ttsMuted,
    should_enqueue_tts: Boolean(String(stage2Text || "").trim()) && !ttsMuted,
    suppression_reason: suppressionReason
  };
}

function logStage2TtsDecision(prep, decision) {
  try {
    console.info("[STAGE2_DEBUG][tts_decision]", {
      turn_id: prep?.turnContext?.turn_id || null,
      lane_id: prep?.turnContext?.turn_lane_id || prep?.reasoningLaneId || null,
      stage2_text_present: Boolean(decision?.stage2_text_present),
      muted_input: Boolean(decision?.muted_input),
      work_mode_muted: Boolean(decision?.work_mode_muted),
      tts_muted: Boolean(decision?.tts_muted),
      should_enqueue_tts: Boolean(decision?.should_enqueue_tts),
      suppression_reason: String(decision?.suppression_reason || "")
    });
  } catch (_) {}
}

/**
 * @returns {{ text: string, effective_stage2_reply: string, usedOverride: boolean, overrideReason: string | null }}
 */
function resolveWorkModeStage2TtsChoice(prep, generatedReply, ttsStage) {
  const pack = storeEffectiveStage2ReplyOnPrep(
    prep,
    resolveEffectiveStage2Reply(prep, generatedReply, ttsStage)
  );
  return {
    text: pack.effective_stage2_reply,
    effective_stage2_reply: pack.effective_stage2_reply,
    usedOverride: pack.used_override,
    overrideReason: pack.override_reason
  };
}

/** Show the canonical Stage-2 line in Voice UI (bubble source of truth). */
function ensureStage2VoiceBubble(prep, effectiveText, replyBack = null) {
  const t = String(effectiveText || "").trim();
  if (!t) return null;
  const convoEl = uiEl("conversation");
  if (prep?.stage2VoiceBubble instanceof HTMLElement && prep.stage2VoiceBubble.isConnected) {
    prep.stage2VoiceBubble.textContent = t;
    if (convoEl) convoEl.scrollTop = convoEl.scrollHeight;
    persistVeraChatState();
    return prep.stage2VoiceBubble;
  }
  let opts = { path: "stage2-effective-reply" };
  if (replyBack) opts = mergeReplyBackIntoBubbleMeta(opts, replyBack);
  const bubble = addBubble(t, "vera", opts);
  if (prep) prep.stage2VoiceBubble = bubble;
  if (convoEl) convoEl.scrollTop = convoEl.scrollHeight;
  persistVeraChatState();
  return bubble;
}

function logStage2TtsChoice(prep, generated, choice) {
  const pack =
    prep?.effectiveStage2Reply ||
    resolveEffectiveStage2Reply(prep, generated, 2);
  logStage2EffectiveReply(
    prep,
    pack,
    choice?.effective_stage2_reply ?? choice?.text ?? pack.effective_stage2_reply,
    choice?.effective_stage2_reply ?? choice?.text ?? pack.effective_stage2_reply
  );
}

function shouldUseWorkModeTurnTtsQueue(ttsTurn) {
  return isVeraWorkModeOn() && appModePrefix() === "vera" && Boolean(ttsTurn?.turn_id);
}

function enqueueWorkModeTurnTts(item) {
  const frozen = getWorkModeFrozenTurn(item.turn_id);
  const expectedLane = frozen?.turn_lane_id || item.lane_id;
  logWorkModeLaneInvariant("tts_enqueue", expectedLane, item.lane_id, {
    turn_id: item.turn_id,
    stage: item.stage,
    text_preview: logTtsTextPreview(item.text)
  });
  console.info("[tts_enqueue]", {
    turn_id: item.turn_id,
    lane_id: item.lane_id,
    stage: item.stage,
    text_preview: logTtsTextPreview(item.text)
  });
  const key = workModeTtsSortKey(item);
  let i = 0;
  while (i < workModeTtsQueue.length && workModeTtsSortKey(workModeTtsQueue[i]) <= key) i++;
  const doneP = new Promise((resolve, reject) => {
    item._resolve = resolve;
    item._reject = reject;
  });
  workModeTtsQueue.splice(i, 0, item);
  void kickWorkModeTtsDrain();
  return doneP;
}

async function executeWorkModeTtsQueueItem(item) {
  let policy = null;
  if (item.stage === 2) {
    policy = evaluateWorkModeStage2Tts(item);
    if (policy.drop_reason && policy.drop_reason !== "text_only_due_to_code_or_math") {
      logTtsDropStale(item, policy.drop_reason);
    } else if (policy.drop_reason === "text_only_due_to_code_or_math") {
      logTtsDropStale(item, policy.drop_reason);
    }
  }

  if (item.stage === 2 && policy?.action === "text_only") {
    try {
      if (typeof item.onDrop === "function") await item.onDrop();
    } catch (e) {
      console.warn("[tts_drop_stale] onDrop", e);
    }
    return;
  }

  if (item.stage === 2 && policy?.action === "text_only_with_supplement") {
    try {
      if (typeof item.onDrop === "function") await item.onDrop();
    } catch (e) {
      console.warn("[tts_drop_stale] onDrop", e);
    }
    const phrase = String(policy.supplementPhrase || WORK_MODE_TTS_PRIOR_READY_PHRASE).trim();
    if (phrase) await playWorkModeTtsOnlyPhrase(phrase, item.abortSignal);
    return;
  }

  await item.play();
  await waitUntilAssistantTtsIdle();
}

async function kickWorkModeTtsDrain() {
  if (workModeTtsDrainRunning) return;
  workModeTtsDrainRunning = true;
  try {
    while (workModeTtsQueue.length > 0) {
      const item = workModeTtsQueue[0];
      workModeTtsQueue.shift();
      const frozenPlay = getWorkModeFrozenTurn(item.turn_id);
      const expectedPlayLane = frozenPlay?.turn_lane_id || item.lane_id;
      logWorkModeLaneInvariant("tts_play", expectedPlayLane, item.lane_id, {
        turn_id: item.turn_id,
        stage: item.stage
      });
      console.info("[tts_play]", {
        turn_id: item.turn_id,
        lane_id: item.lane_id,
        stage: item.stage
      });
      workModeTtsCurrentlyPlaying = {
        turn_id: item.turn_id,
        lane_id: item.lane_id,
        stage: item.stage
      };
      try {
        await executeWorkModeTtsQueueItem(item);
        item._resolve?.();
      } catch (e) {
        item._reject?.(e);
        if (e?.name !== "AbortError") console.warn("[tts_play] error", e);
      } finally {
        console.info("[tts_done]", {
          turn_id: item.turn_id,
          lane_id: item.lane_id,
          stage: item.stage
        });
        if (
          workModeTtsCurrentlyPlaying?.turn_id === item.turn_id &&
          workModeTtsCurrentlyPlaying?.stage === item.stage
        ) {
          workModeTtsCurrentlyPlaying = null;
        }
      }
    }
  } finally {
    workModeTtsDrainRunning = false;
    if (workModeTtsQueue.length > 0) void kickWorkModeTtsDrain();
  }
}

async function playWorkModeTtsOnlyPhrase(text, abortSignal) {
  const s = String(text || "").trim();
  if (!s || !isVeraWorkModeOn()) return;
  if (isWorkModeMuteEnabled() || inputMuted) return;
  const res = await fetch(`${API_URL}/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: s,
      session_id: getSessionId(),
      client: appModePrefix(),
      stream_tts: false,
      tts_only: true
    }),
    signal: abortSignal
  });
  if (!res.ok || abortSignal?.aborted) return;
  const data = await res.json();
  if (!resolveAudioUrls(data).length) return;
  await playTtsFromApi(data, { ephemeralAck: true });
}

/**
 * Work-mode assistant audio: turn-ordered queue with stale stage‑2 drop. Falls back to global assistant queue elsewhere.
 */
function enqueueWorkModeAssistantTtsPlayback(
  playTask,
  ttsMeta,
  { stage = 2, text = "", onDrop, prep, abortSignal } = {}
) {
  if (!shouldUseWorkModeTurnTtsQueue(ttsMeta)) {
    return enqueueAssistantTtsPlayback(playTask);
  }
  const preview =
    stage === 2 && prep ? String(text || "").slice(0, 120) || "(stage2)" : text;
  return enqueueWorkModeTurnTts({
    turn_id: ttsMeta.turn_id,
    lane_id: ttsMeta.lane_id,
    generation_id: ttsMeta.generation_id,
    turn_seq: ttsMeta.turn_seq,
    stage,
    text: preview,
    prep,
    abortSignal,
    play: playTask,
    onDrop
  });
}

/**
 * After stage‑1, wait for the reasoning gate + `/infer` without clearing in-flight assistant audio (so another
 * reply can play first). TTS for this infer is still serialized via `enqueueAssistantTtsPlayback`.
 * Fetch abort is tied to `workModeDeferredStage2AbortController` (reset on VERA session reset), not `activePipelineAbort`.
 */
function scheduleWorkModeDeferredReasoningStageTwoInfer({ formData, prep, seqAtStage1End }) {
  void (async () => {
    try {
      logStage2Debug(prep, {
        transcript: _readInferFormDataTranscript(formData),
        reasoning_completed: true,
        reasoning_success: true,
        stage2_payload_valid: formData instanceof FormData,
        stage2_tts_requested: getWorkModeStage2TtsDecision("(pending-stage2-text)").should_enqueue_tts,
        stage2_tts_suppressed_due_to_mute: getWorkModeStage2TtsDecision("(pending-stage2-text)").tts_muted
      });
      const also = workModeVoiceInferTurnSeq > seqAtStage1End;
      const prepFail = await runInferAfterWorkModeReasoningPrep(formData, prep, {
        signal: workModeDeferredStage2AbortController.signal,
        skipPreInferPlaybackReset: true,
        stage2AlsoPrefix: also
      });
      if (prepFail === "reasoning-upload-failed") {
        processing = false;
        requestInFlight = false;
        voiceUxTurn = null;
        setStatus("Ready", "idle");
        if (listeningMode === "continuous" && listening && !inputMuted) startListening();
        updateMuteInputButton();
      }
    } catch (e) {
      if (e?.name === "AbortError") return;
      logStage2Debug(prep, {
        transcript: _readInferFormDataTranscript(formData),
        reasoning_completed: true,
        reasoning_success: false,
        stage2_payload_valid: formData instanceof FormData,
        stage2_error: e?.message || e,
        fallback_reason: "deferred_stage2_throw"
      });
      console.warn("[WorkMode] deferred reasoning stage-2 infer", e);
    }
  })();
}

async function maybePrepareWorkModeReasoning(formData, trimmed, signal, opts = {}) {
  const turnContext = opts.turnContext || null;
  const noRouteMeta = { voiceTwoStage: { reasoningRouted: false }, turnContext };
  if (!isVeraWorkModeOn()) return workModeReasoningPrepOutcome(Promise.resolve(), "", undefined, noRouteMeta);
  if (isLikelyWorkChecklistEditIntent(trimmed))
    return workModeReasoningPrepOutcome(Promise.resolve(), "", undefined, noRouteMeta);
  if (isExplicitWorkModePanelNavigationIntent(trimmed)) {
    return workModeReasoningPrepOutcome(Promise.resolve(), "", undefined, noRouteMeta);
  }
  /* Snapshot before this turn mutates it — used so /classify thread anchor is the *prior* user line, not the current one. */
  const priorThreadAnchor = String(workModeLastSubstantiveUserText || "").trim();
  const forceActiveLaneReasoningContent =
    shouldForceReasoningActiveLaneContentFollowUp(trimmed, priorThreadAnchor);
  const planningIntent = isLikelyWorkModePlanningIntent(trimmed);
  let attachmentList = normalizeReasoningUploadAttachmentArg(opts);
  {
    let accBytes = 0;
    const capped = [];
    for (const f of attachmentList) {
      if (!(f instanceof File) || !f.size) continue;
      if (f.size > WORK_MODE_ATTACH_MAX_FILE_BYTES) continue;
      if (accBytes + f.size > WORK_MODE_ATTACH_MAX_TOTAL_BYTES) break;
      capped.push(f);
      accBytes += f.size;
    }
    attachmentList = capped;
  }
  const hasUpload = attachmentList.length > 0;
  const rawTrimmed = String(trimmed || "").trim();
  const effectiveUserText =
    rawTrimmed ||
    (hasUpload
      ? "[Uploaded attachment(s)] — use the attached file(s) as the problem context."
      : "");
  const textForReasoningStream = planningIntent
    ? `${workModePlanningTimeInjectionPrefix()}${effectiveUserText}\n\n${WORK_MODE_PLANNING_REASONING_INSTRUCTION_SUFFIX}`
    : effectiveUserText;

  let classifyRoute = false;
  let continuePriorLane = false;
  try {
    const classifyBody = { session_id: getSessionId(), text: effectiveUserText };
    const classifyLaneGuess =
      turnContext?.turn_lane_id ||
      getFocusedWorkModeLaneId() ||
      getActiveDomReasoningLaneId();
    const classifyAnchor =
      (classifyLaneGuess ? getWorkModeLanePriorUserRequest(classifyLaneGuess) : "") || priorThreadAnchor;
    if (
      classifyAnchor &&
      classifyAnchor !== trimmed &&
      !isGenericExampleFollowUpText(trimmed)
    ) {
      classifyBody.anchor_for_thread = classifyAnchor;
    }
    const cr = await fetch(`${API_URL}/work_mode/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(classifyBody),
      signal
    });
    if (cr.ok) {
      const cj = await cr.json();
      classifyRoute = Boolean(cj.prompt_reasoning || cj.reasoning);
      continuePriorLane = Boolean(cj.continue_prior_lane);
    }
  } catch {
    /* ignore */
  }

  let routeReasoning = Boolean(hasUpload);
  if (!hasUpload) {
    const taskFollowUpContinuing =
      !planningIntent &&
      !forceActiveLaneReasoningContent &&
      isGeneralWorkModeFollowUpContinuingTask(trimmed, priorThreadAnchor);
    const heuristicReasoning = (() => {
      const t = String(trimmed || "").toLowerCase();
      if (!t) return false;
      if (planningIntent) return true;
      const conceptWords = /\b(explain|how does|how do|derive|proof|theorem|compare|trade-?off|framework|architecture|mechanism|intuition)\b/;
      const domainWords = /\b(binomial|black-?scholes|delta|gamma|vega|volatility|probability|equation|calculus|statistics|finance|histor(y|ical)|economics|algorithm)\b/;
      const codeProblemWords =
        /\b(code|coding|program|debug|bug|error|exception|stack trace|traceback|refactor|compile|build|runtime|test failing|unit test|integration test|typescript|javascript|python|java|c\+\+|sql|api endpoint|null pointer|undefined)\b/;
      const multiPart = /(\b(step by step|in detail|deep dive|from scratch)\b)|([,:;].+[,:;])/;
      const writingTask =
        /\b(write|draft|compose|polish|rewrite)\b/.test(t) &&
        /\b(email|essay|script|speech|letter|cover letter|proposal|statement|outline)\b/.test(t);
      const guideWritingTask =
        /\b(guide|guidance|walk\s+me\s+through|coach\s+me(?:\s+on)?)\b/.test(t) &&
        /\b(writ(?:e|ing|es|er|ten)?|essay|paper|draft|paragraph|piece|composition|story|article|blog|email|script|thesis|outline|proofread|edit)\b/.test(
          t
        );
      const hasCodeSnippet =
        /```/.test(t) ||
        /\b(function|class|import|const|let|var|def|return)\b/.test(t) ||
        /[{}();]{2,}/.test(t);
      const wordCount = (t.match(/\S+/g) || []).length;
      const explainReasoningAsk =
        /\bexplain\b/.test(t) &&
        wordCount >= 3 &&
        !/^\s*explain\s+(?:yourself|vera|this\s+app)\b/i.test(String(trimmed || "").trim());
      return (
        (conceptWords.test(t) && domainWords.test(t)) ||
        domainWords.test(t) ||
        codeProblemWords.test(t) ||
        hasCodeSnippet ||
        multiPart.test(t) ||
        writingTask ||
        guideWritingTask ||
        explainReasoningAsk
      );
    })();
    routeReasoning =
      (classifyRoute || heuristicReasoning || forceActiveLaneReasoningContent) && !taskFollowUpContinuing;
    if (!routeReasoning) {
      if (!isGenericExampleFollowUpText(trimmed)) {
        workModeLastSubstantiveUserText = trimmed;
      }
      return workModeReasoningPrepOutcome(
        Promise.resolve(),
        computeWorkModeInferThreadAnchor(trimmed, priorThreadAnchor, Boolean(continuePriorLane)),
        undefined,
        noRouteMeta
      );
    }
  }

  const continueLaneForThisTurn = Boolean(continuePriorLane) || Boolean(forceActiveLaneReasoningContent);
  const requestHasCodeIntent = detectWorkModeRequestHasCodeVoiceIntent(effectiveUserText);
  const requestHasProofIntent = /\b(proof|prove|theorem|lemma|qed)\b/i.test(String(effectiveUserText || ""));
  const requestHasDenseMathIntent = /\b(black-?scholes|integral|matrix|eigen|pde|ode|latex|equation|calculus|derivative)\b/i.test(
    String(effectiveUserText || "").toLowerCase()
  );
  const requestHasTableIntent = /\b(table|tabular|spreadsheet|csv)\b/i.test(String(effectiveUserText || "").toLowerCase());
  const stage1AckText = buildWorkModeReasoningStage1AckText(effectiveUserText, {
    hasUpload,
    planningIntent,
    requestHasCodeIntent,
    requestHasProofIntent,
    requestHasDenseMathIntent,
    requestHasTableIntent
  });
  const voiceTwoStage = {
    reasoningRouted: true,
    requestHasCodeIntent,
    requestHasProofIntent,
    requestHasDenseMathIntent,
    requestHasTableIntent,
    stage1AckText,
    workModeRoutingMode: forceActiveLaneReasoningContent ? "continue_active_lane" : "default"
  };

  workModeReasoningConfirmPending = null;
  const frozenIdx = frozenTurnLaneIndex(turnContext);
  const reasoningUserFocusLaneIdx = frozenIdx != null ? frozenIdx : getActiveReasoningLaneIndex();
  const reasoningUploadState = hasUpload ? { failed: false } : null;
  const laneIdx =
    frozenIdx != null
      ? await acquireWorkModeReasoningLaneForIndex(frozenIdx)
      : forceActiveLaneReasoningContent
        ? await acquireWorkModeReasoningLaneForIndex(getActiveReasoningLaneIndex() ?? 0)
        : await selectLaneForWorkModeReasoningTurn(effectiveUserText, {
            continuePriorLane: continueLaneForThisTurn
          });
  const reasoningLaneId = turnContext?.turn_lane_id || getWorkModeReasoningLaneId(laneIdx);
  if (turnContext && reasoningLaneId !== turnContext.turn_lane_id) {
    workModeTurnLaneGuard(turnContext, reasoningLaneId, "reasoning_route_lane_mismatch");
  }
  const lanePriorForInfer = getWorkModeLanePriorUserRequest(reasoningLaneId) || priorThreadAnchor;
  const inferThreadAnchor = computeWorkModeInferThreadAnchor(
    effectiveUserText,
    lanePriorForInfer,
    continueLaneForThisTurn
  );
  if (!isGenericExampleFollowUpText(effectiveUserText)) {
    laneTopicSeedByIdx[laneIdx] = effectiveUserText;
    workModeLastSubstantiveLaneIdx = laneIdx;
    workModeLastSubstantiveUserText = rawTrimmed || effectiveUserText;
  }
  /* Voice /infer waits for the full reasoning NDJSON stream (summary + markdown + done) so handoff context is complete. */
  const chainP = runOnLaneReasoningChain(laneIdx, async () => {
    const streamLaneId = turnContext?.turn_lane_id || reasoningLaneId;
    const streamLaneTitleAtStart =
      turnContext?.turn_lane_title ||
      (() => {
        const streamPanelAtStart = getReasoningPanelElementByLaneId(streamLaneId);
        return streamPanelAtStart
          ? getReasoningTabTopicLabel(streamPanelAtStart)
          : getWorkModeReasoningLaneLabel(laneIdx);
      })();
    logWorkModeLaneInvariant("reasoning_stream_start", turnContext?.turn_lane_id || streamLaneId, streamLaneId, {
      turn_id: turnContext?.turn_id || null
    });
    console.info("[reasoning_stream_start]", {
      turn_id: turnContext?.turn_id || null,
      stream_lane_id: streamLaneId
    });
    try {
      console.info("[reasoning_queue_start]", {
        turn_id: turnContext?.turn_id || null,
        lane_id: streamLaneId || null,
        has_files: Boolean(hasUpload)
      });
    } catch (_) {}
    const streamUserRequest = effectiveUserText;
    const currentAttachmentMeta = attachmentList.map((f) => ({
      name: f.name,
      mime_type: f.type || guessMimeFromWorkModeFileName(f.name)
    }));
    let streamReasoningText = textForReasoningStream;
    const streamAugment = buildLaneScopedReasoningStreamAugmentations(trimmed, streamLaneId, {
      continuePriorLane: continueLaneForThisTurn,
      planningIntent,
      includeVoiceForGenericExample: isGenericExampleFollowUpText(trimmed) && appModePrefix() === "vera"
    });
    if (streamAugment) streamReasoningText = `${streamReasoningText}\n\n${streamAugment}`;

    const modelPrep = prepareWorkModeReasoningModelCall({
      laneId: streamLaneId,
      userText: streamUserRequest,
      turnContext,
      requestHasCodeIntent,
      planningIntent,
      currentAttachmentMeta
    });

    workModeReasoningLaneBusy.set(laneIdx, true);
    syncWorkModeReasoningCancelButton();
    const laneLabel = getWorkModeReasoningLaneLabel(laneIdx);
    const laneId = streamLaneId;
    const laneAbortController = new AbortController();
    const turnIdForLifecycle = turnContext?.turn_id ?? null;
    let reasoningLifecycleReleased = false;
    function safeReasoningLaneRelease(reason) {
      if (reasoningLifecycleReleased) return;
      reasoningLifecycleReleased = true;
      clearWorkModeReasoningWatchdog(laneIdx);
      const st = reason || (laneAbortController.signal.aborted ? "cancelled" : "completed");
      const finalStatus =
        st === "stream_completed" || st === "completed"
          ? "complete"
          : laneAbortController.signal.aborted || st === "cancelled"
            ? "cancelled"
            : /failed|error|throw|timed_out|no_|http/i.test(st)
              ? "failed"
              : st;
      setWorkModeReasoningFinalStatus({
        turnId: turnIdForLifecycle,
        laneId: streamLaneId,
        status: finalStatus,
        reason: st
      });
      try {
        const panel = getReasoningPanelElementByLaneId(streamLaneId);
        if (panel instanceof HTMLElement) {
          panel.dataset.generating = "0";
          if (String(panel.dataset.generationStatus || "") !== "complete") {
            panel.dataset.generationStatus = finalStatus;
          }
        }
      } catch (_) {}
      try {
        console.info("[turn_done]", { turn_id: turnIdForLifecycle, lane_id: streamLaneId, state: st });
        console.info("[turn_cleanup]", {
          turn_id: turnIdForLifecycle,
          lane_id: streamLaneId,
          state: st,
          cleared_busy: true
        });
        logLaneBusyStateForReasoning("cleanup", laneIdx, turnIdForLifecycle, streamLaneId);
      } catch (_) {}
      endWorkModeReasoningLaneRun(laneIdx);
    }
    startWorkModeReasoningWatchdog(
      laneIdx,
      { turn_id: turnIdForLifecycle, lane_id: streamLaneId },
      () => {
        try {
          laneAbortController.abort();
        } catch (_) {}
        safeReasoningLaneRelease("timed_out");
      }
    );
    workModeReasoningAbortControllers.set(laneIdx, laneAbortController);
    syncWorkModeReasoningCancelButton();
    try {
      console.info("[turn_start]", { turn_id: turnIdForLifecycle, lane_id: streamLaneId });
    } catch (_) {}
    const scrollEl = getReasoningScrollElByLane(laneIdx);
    if (!scrollEl) {
      preserveComposerAttachments("no_reasoning_scroll", turnContext);
      safeReasoningLaneRelease("no_scroll");
      return;
    }
    try {
      const panelAtStart = getReasoningPanelElementByLaneId(streamLaneId) || scrollEl.closest(".vera-reasoning-tab-panel");
      if (panelAtStart instanceof HTMLElement) {
        panelAtStart.dataset.generationStatus = "generating";
        panelAtStart.dataset.generating = "1";
      }
    } catch (_) {}
    try {
    if (hasUpload && turnContext?.turn_id) {
      const uploadDescriptors = attachmentList.map((file) => {
        const pending = workModePendingAttachments.find((p) => p.file === file);
        const attachment_id = pending?.id || generateWorkModeAttachmentId();
        const preview_url = URL.createObjectURL(file);
        return {
          attachment_id,
          name: file.name || "upload",
          mime_type: file.type || guessMimeFromWorkModeFileName(file.name),
          preview_url,
          page_count: null
        };
      });
      try {
        console.info("[file_upload_lane_bind]", {
          turn_id: turnContext?.turn_id ?? null,
          lane_id: streamLaneId,
          file_count: uploadDescriptors.length,
          file_names: uploadDescriptors.map((d) => d.name)
        });
      } catch (_) {}
      insertWorkModeLaneAttachmentBlock(scrollEl, {
        laneId: streamLaneId,
        turnId: turnContext?.turn_id,
        items: uploadDescriptors
      });
      appendWorkModeLaneAttachmentRegistryRecords(
        streamLaneId,
        uploadDescriptors.map((d) => ({
          attachment_id: d.attachment_id,
          name: d.name,
          mime_type: d.mime_type,
          preview_url: d.preview_url,
          extracted_text: "",
          page_count: d.page_count,
          uploaded_at: Date.now(),
          turn_id: turnContext?.turn_id || ""
        }))
      );
      clearComposerAttachmentsAfterSubmit(turnContext, "lane_attachment_block_enqueued");
    }
    laneReasoningTurnCountByIdx[laneIdx] = (laneReasoningTurnCountByIdx[laneIdx] ?? 0) + 1;

    let sr;
    try {
      if (hasUpload) {
        const fd = new FormData();
        fd.append("session_id", getSessionId());
        fd.append("text", streamReasoningText);
        fd.append("lane_id", laneId);
        for (const f of attachmentList) {
          fd.append("files", f, f.name || "upload");
        }
        const laneMerge = buildWorkModeLaneClientMergeBlockForUpload(laneId, streamUserRequest, {
          turnContext,
          requestHasCodeIntent,
          currentAttachmentMeta,
          attachments: attachmentList
        });
        if (laneMerge) fd.append("work_mode_lane_client_context", laneMerge);
        sr = await fetch(`${API_URL}/work_mode/reasoning_stream_upload`, {
          method: "POST",
          body: fd,
          signal: laneAbortController.signal
        });
        if (!sr.ok) {
          let msg = `Upload failed (${sr.status})`;
          try {
            const err = await sr.json();
            if (err?.detail) msg = String(err.detail);
          } catch {
            /* ignore */
          }
          setWorkModeAttachmentMeta(msg);
          if (reasoningUploadState) reasoningUploadState.failed = true;
          /* Lane attachment block already committed; composer tray stays cleared. */
          safeReasoningLaneRelease("upload_failed");
          /* For 413 (input/file too large) the server detail is the right
             user-facing copy. For 5xx surface the standard LLM-failure bubble. */
          if (sr.status >= 500) {
            void veraSurfaceLlmFetchFailure({
              feature: "reasoning_stream_upload",
              response: sr
            });
          } else if (sr.status === 413) {
            void veraSurfaceLlmFetchFailure({
              feature: "reasoning_stream_upload",
              response: sr
            });
          }
          return "reasoning-upload-failed";
        }
        if (!sr.body) {
          setWorkModeAttachmentMeta("Upload failed: empty response body.");
          if (reasoningUploadState) reasoningUploadState.failed = true;
          safeReasoningLaneRelease("upload_empty_body");
          return "reasoning-upload-failed";
        }
      } else {
        sr = await fetch(`${API_URL}/work_mode/reasoning_stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: getSessionId(),
            text: streamReasoningText,
            lane_id: laneId,
            work_mode_lane_client_context: modelPrep.laneClientContext || ""
          }),
          signal: laneAbortController.signal
        });
        if (!sr.ok || !sr.body) {
          safeReasoningLaneRelease("stream_http_error");
          void veraSurfaceLlmFetchFailure({
            feature: "reasoning_stream",
            response: sr
          });
          return;
        }
      }
    } catch (err) {
      if (reasoningUploadState) reasoningUploadState.failed = true;
      safeReasoningLaneRelease("fetch_throw");
      if (err?.name !== "AbortError") {
        void veraSurfaceLlmFetchFailure({
          feature: "reasoning_stream_throw",
          error: err
        });
      }
      throw err;
    }

    const turnEl = appendReasoningTurnMount(scrollEl);
    if (!turnEl) {
      preserveComposerAttachments("no_reasoning_turn_mount", turnContext);
      safeReasoningLaneRelease("no_turn_el");
      return;
    }
    if (!hasUpload) {
      clearComposerAttachmentsAfterSubmit(turnContext, "reasoning_turn_mount");
    }
    turnEl.dataset.markdownAcc = "";
    turnEl.dataset.summaryText = "";
    const reader = sr.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let foundSummary = false;
    try {
      while (!foundSummary) {
        const { done, value } = await reader.read();
        if (done && !value) break;
        if (value) lineBuf += decoder.decode(value, { stream: true });
        for (;;) {
          const n = lineBuf.indexOf("\n");
          if (n < 0) break;
          const line = lineBuf.slice(0, n).trim();
          lineBuf = lineBuf.slice(n + 1);
          if (!line) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o.type === "error") {
            logVeraCapabilityFailure("llm", "reasoning_stream_error", {
              message: String(o.message || "").slice(0, 200)
            });
            veraShowCapabilityFailureBubble(
              "llm_failure",
              VERA_SAFETY_LIMITS.messages.llmFailure
            );
            break;
          }
          if (o.type === "summary" && o.text) {
            const normalizedSummary = normalizeWorkModeReasoningSummary(String(o.text), laneLabel, {
              outputLaneIdx: laneIdx,
              focusLaneIdx: reasoningUserFocusLaneIdx
            });
            turnEl.dataset.summaryText = normalizedSummary.text;
            if (typeof formData.set === "function") {
              formData.set("reasoning_voice_coach", normalizedSummary.text);
            } else {
              formData.append("reasoning_voice_coach", normalizedSummary.text);
            }
            foundSummary = true;
            break;
          }
        }
      }
    } catch (_) {}
    if (foundSummary) {
      await drainReasoningNdjsonMarkdownTail(reader, lineBuf, turnEl, decoder, {
        turnContext,
        streamLaneId,
        onDone: ({ markdownAcc, summaryText }) => {
          const mdFromDom = String(turnEl?.dataset?.markdownAcc || "").trim();
          const mdDone = mdFromDom || String(markdownAcc || "").trim();
          const panelForTitle = getReasoningPanelElementByLaneId(streamLaneId) || turnEl.closest(".vera-reasoning-tab-panel");
          if (panelForTitle instanceof HTMLElement) {
            panelForTitle.dataset.generationStatus = "complete";
            panelForTitle.dataset.generating = "0";
            panelForTitle.dataset.latestMarkdownLength = String(mdDone.length);
            panelForTitle.dataset.lastCompletedAt = String(Date.now());
          }
          const excerptCap = 12000;
          const excerpt = mdDone.length > excerptCap ? `${mdDone.slice(0, excerptCap)}\n…` : mdDone;
          const summaryLine = extractWorkModeReasoningSummaryAnswerLine(summaryText);
          const codeOrMath = Boolean(
            mdDone &&
              (/\`\`\`/.test(mdDone) ||
                /\$[^\s$]/.test(mdDone) ||
                /\\[\[(]/.test(mdDone) ||
                /\bdef\s+\w/.test(mdDone) ||
                /\bimport\s+/.test(mdDone))
          );
          commitActiveWorkModeReasoningContext(
            {
              stream_started_lane_id: streamLaneId,
              active_lane_id: streamLaneId,
              lane_title: streamLaneTitleAtStart,
              last_user_request: streamUserRequest,
              prior_problem_anchor: streamPriorAnchor || "",
              latest_reasoning_summary: summaryLine,
              latest_final_answer_excerpt: excerpt,
              latest_markdown_preview: mdDone.slice(0, 3200),
              code_or_math_generated: codeOrMath
            },
            {
              source_function: "maybePrepareWorkModeReasoning.onDone",
              stream_started_lane_id: streamLaneId,
              frozen_lane_id: turnContext?.turn_lane_id || streamLaneId,
              frozen_turn_id: turnContext?.turn_id || "",
              turn_el: turnEl
            }
          );
          const srcTag = String(turnContext?.source || "").trim().toLowerCase();
          let titlePathLabel = "wm.maybePrepare.reasoning_ndjson_done.infer_unknown_source";
          if (hasUpload || srcTag === "upload") {
            titlePathLabel = "wm.maybePrepare.reasoning_ndjson_done.upload";
          } else if (srcTag === "keyboard") {
            titlePathLabel = "wm.maybePrepare.reasoning_ndjson_done.typed_infer_pipeline";
          } else if (srcTag === "voice") {
            titlePathLabel = "wm.maybePrepare.reasoning_ndjson_done.voice_infer_pipeline";
          } else {
            titlePathLabel = `wm.maybePrepare.reasoning_ndjson_done.source_${srcTag || "unset"}`;
          }
          setReasoningTabTopicFromFinal(turnEl, {
            summaryText: extractWorkModeReasoningSummaryAnswerLine(summaryText),
            markdownText: mdDone,
            userPrompt: streamUserRequest,
            turnId: turnContext?.turn_id ?? null,
            calledFrom: titlePathLabel
          });
          try {
            console.info("[REASONING_COMPLETE_DEBUG]", {
              panel_id:
                panelForTitle instanceof HTMLElement
                  ? String(panelForTitle.dataset.laneId || streamLaneId || "")
                  : streamLaneId || null,
              lane_id: streamLaneId || null,
              stream_done_received: true,
              generation_status:
                panelForTitle instanceof HTMLElement
                  ? String(panelForTitle.dataset.generationStatus || "")
                  : "unknown",
              markdown_length_rendered: String(panelForTitle?.textContent || "").length,
              markdown_length_stored: mdDone.length,
              has_final_chunk: Boolean(mdDone),
              has_error: false,
              marked_complete:
                panelForTitle instanceof HTMLElement &&
                panelForTitle.dataset.generationStatus === "complete",
              reason_if_incomplete: mdDone ? "" : "empty_markdown_done"
            });
          } catch (_) {}
          if (panelForTitle instanceof HTMLElement) {
            queueLlmReasoningPanelTitleAfterFirstCompletedTurn(panelForTitle, {
              userPrompt: streamUserRequest,
              markdownText: mdDone,
              summaryText: extractWorkModeReasoningSummaryAnswerLine(summaryText),
              turnId: turnContext?.turn_id ?? null,
              calledFrom: titlePathLabel
            });
          } else {
            reasoningTitleCandidateDebugLog(null, {
              turn_id: turnContext?.turn_id ?? null,
              lane_id: streamLaneId || null,
              candidate_title: "",
              candidate_source: "queue_skipped_no_panel_element",
              called_from: `${titlePathLabel}.panelForTitle_miss`,
              extra: { hint: "getReasoningPanelElementByLaneId and turnEl.closest both failed" }
            });
            reasoningTitleUpdateDebugLog(
              streamLaneId || null,
              "(unknown)",
              "",
              false,
              "skip_heuristic_followup_missing_panel_dom_for_title"
            );
          }
          if (mdDone) {
            const hasSyncHeading = /#{1,6}\s*SYNC CHECKLIST\b/i.test(mdDone);
            if (planningIntent || hasSyncHeading) {
              const rows = buildChecklistProposalFromMarkdown(mdDone);
              const panelMeta = getPlanSyncPanelMetaForLane(
                streamLaneId || turnContext?.turn_lane_id || "",
                turnContext?.turn_lane_title || ""
              );
              workChecklistSyncPlanVersion += 1;
              workChecklistSyncPendingMarkdown = mdDone;
              workChecklistSyncPendingPlanMeta = {
                ...panelMeta,
                source: "reasoning_stream_done",
                created_at: Date.now()
              };
              logPlanSyncDebug("created", {
                lane_id: panelMeta.lane_id || null,
                panel_id: panelMeta.panel_id || null,
                panel_title: panelMeta.panel_title || "",
                active_panel_id: panelMeta.active_panel_id || null,
                is_plan_detected: Boolean(planningIntent),
                syncable: rows.length > 0,
                has_sync_metadata: hasSyncHeading || rows.length > 0,
                sync_candidate_count: rows.length,
                sync_candidates_preview: planSyncPreviewRows(rows),
                reason_if_not_syncable: rows.length ? "" : "no_checklist_candidates_extracted",
                response_kind: hasSyncHeading ? "sync_checklist_markdown" : "plan_markdown",
                route_kind: planningIntent ? "planning_route" : "reasoning_route",
                source: turnContext?.source || "reasoning_route"
              });
              syncWorkChecklistSyncPlanButton();
              flashWorkChecklistPlanHint(
                planningIntent
                  ? "Plan is in reasoning — tap Sync to load checklist bullets."
                  : "Updated plan in reasoning — tap Sync to refresh checklist bullets."
              );
            }
          }
          safeReasoningLaneRelease("stream_completed");
        }
      });
    } else {
      safeReasoningLaneRelease("no_summary");
    }
    maybeReasoningScrollToLatest(scrollEl);
    } catch (lifecycleErr) {
      try {
        console.info("[turn_error]", {
          turn_id: turnIdForLifecycle,
          lane_id: streamLaneId,
          error: String(lifecycleErr?.message || lifecycleErr)
        });
      } catch (_) {}
      if (!reasoningLifecycleReleased) safeReasoningLaneRelease("error");
      throw lifecycleErr;
    } finally {
      if (!reasoningLifecycleReleased) safeReasoningLaneRelease("finally_guard");
    }
  });
  const inferGate = chainP;
  return workModeReasoningPrepOutcome(chainP, inferThreadAnchor, inferGate, {
    reasoningHadFileUpload: hasUpload,
    reasoningUploadState,
    voiceTwoStage,
    reasoningLaneId: turnContext?.turn_lane_id || reasoningLaneId,
    turnContext
  });
}

function setWorkModeAttachmentMeta(message) {
  const meta = document.getElementById("vera-reasoning-attach-meta");
  if (!meta) return;
  closeWorkModeAttachmentPreviewModal();
  const m = String(message || "");
  if (workModePendingAttachments.length) {
    const looksLikeSuccessLine =
      /^(?:\d+)\s+file\(s\)\s+attached$/i.test(m) || /^Attached:/i.test(m);
    if (looksLikeSuccessLine) workModeAttachmentComposerHint = "";
    else if (m) workModeAttachmentComposerHint = m;
    renderWorkModeComposerAttachmentChips();
    return;
  }
  workModeAttachmentComposerHint = "";
  meta.textContent = m;
}

/** Text-only reasoning stream into the reasoning panel (no `/infer`). File uploads use `maybePrepareWorkModeReasoning` + typed infer instead. */
async function streamWorkModeReasoningComposer(text, signal, opts = {}) {
  const turnContext =
    opts.turnContext || createWorkModeFrozenTurnContext({ userText: text, source: "keyboard" });
  const frozenIdx = frozenTurnLaneIndex(turnContext);
  const reasoningUserFocusLaneIdx = frozenIdx != null ? frozenIdx : getActiveReasoningLaneIndex();
  const laneIdx =
    frozenIdx != null
      ? await acquireWorkModeReasoningLaneForIndex(frozenIdx)
      : isWorkModeReasoningAutoRouteEnabled()
        ? await acquireWorkModeReasoningLane(text)
        : await acquireWorkModeReasoningLaneForIndex(reasoningUserFocusLaneIdx ?? 0);
  const streamLaneId = turnContext?.turn_lane_id || getWorkModeReasoningLaneId(laneIdx);
  const streamLaneTitleAtStart =
    turnContext?.turn_lane_title ||
    (() => {
      const streamPanelAtStart = getReasoningPanelElementByLaneId(streamLaneId);
      return streamPanelAtStart
        ? getReasoningTabTopicLabel(streamPanelAtStart)
        : getWorkModeReasoningLaneLabel(laneIdx);
    })();
  logWorkModeLaneInvariant("reasoning_stream_start", turnContext?.turn_lane_id || streamLaneId, streamLaneId, {
    turn_id: turnContext?.turn_id || null
  });
  console.info("[reasoning_stream_start]", {
    turn_id: turnContext?.turn_id || null,
    stream_lane_id: streamLaneId
  });
  const streamUserRequest = String(text || "").trim();
  const streamPriorAnchor = getWorkModeLanePriorUserRequest(streamLaneId);
  const requestHasCodeIntent = detectWorkModeRequestHasCodeVoiceIntent(streamUserRequest);
  const modelPrep = prepareWorkModeReasoningModelCall({
    laneId: streamLaneId,
    userText: streamUserRequest,
    turnContext,
    requestHasCodeIntent
  });
  const laneLabel = getWorkModeReasoningLaneLabel(laneIdx);
  const laneId = streamLaneId;
  const laneAbortController = new AbortController();
  const turnIdLc = turnContext?.turn_id ?? null;
  let composerLifecycleReleased = false;
  function safeComposerLaneRelease(reason) {
    if (composerLifecycleReleased) return;
    composerLifecycleReleased = true;
    clearWorkModeReasoningWatchdog(laneIdx);
    const st = reason || (laneAbortController.signal.aborted ? "cancelled" : "completed");
    try {
      console.info("[turn_done]", { turn_id: turnIdLc, lane_id: streamLaneId, state: st });
      console.info("[turn_cleanup]", {
        turn_id: turnIdLc,
        lane_id: streamLaneId,
        state: st,
        cleared_busy: true
      });
      logLaneBusyStateForReasoning("composer_stream", laneIdx, turnIdLc, streamLaneId);
    } catch (_) {}
    endWorkModeReasoningLaneRun(laneIdx);
  }
  startWorkModeReasoningWatchdog(
    laneIdx,
    { turn_id: turnIdLc, lane_id: streamLaneId },
    () => {
      try {
        laneAbortController.abort();
      } catch (_) {}
      safeComposerLaneRelease("timed_out");
    }
  );
  workModeReasoningAbortControllers.set(laneIdx, laneAbortController);
  syncWorkModeReasoningCancelButton();
  try {
    console.info("[turn_start]", { turn_id: turnIdLc, lane_id: streamLaneId });
  } catch (_) {}
  const scrollEl = getReasoningScrollElByLane(laneIdx);
  if (!scrollEl) {
    safeComposerLaneRelease("no_scroll");
    return;
  }
  laneReasoningTurnCountByIdx[laneIdx] = (laneReasoningTurnCountByIdx[laneIdx] ?? 0) + 1;
  let summaryText = "";
  let markdownAcc = "";
  try {
    const sr = await fetch(`${API_URL}/work_mode/reasoning_stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: getSessionId(),
        text,
        lane_id: laneId,
        work_mode_lane_client_context: modelPrep.laneClientContext || ""
      }),
      signal: laneAbortController.signal
    });
    if (!sr.ok) {
      let msg = `Reasoning failed (${sr.status})`;
      try {
        const err = await sr.json();
        if (err?.detail) msg = String(err.detail);
      } catch {
        /* ignore */
      }
      setWorkModeAttachmentMeta(msg);
      void veraSurfaceLlmFetchFailure({
        feature: "reasoning_stream_secondary",
        response: sr
      });
      return;
    }
    if (!sr.body) {
      setWorkModeAttachmentMeta("Reasoning failed: empty response body.");
      return;
    }

    const turnEl = appendReasoningTurnMount(scrollEl);
    if (!turnEl) return;
    turnEl.dataset.markdownAcc = "";
    turnEl.dataset.summaryText = "";

    const reader = sr.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        for (;;) {
          const n = buf.indexOf("\n");
          if (n < 0) break;
          const line = buf.slice(0, n).trim();
          buf = buf.slice(n + 1);
          if (!line) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o.type === "summary" && o.text) {
            summaryText = normalizeWorkModeReasoningSummary(String(o.text), laneLabel, {
              outputLaneIdx: laneIdx,
              focusLaneIdx: reasoningUserFocusLaneIdx
            }).text;
            turnEl.dataset.summaryText = summaryText;
            renderWorkModeMarkdown(turnEl, markdownAcc, summaryText);
            maybeReasoningScrollToLatest(scrollEl);
          }
          if (o.type === "markdown" && o.text) {
            if (!workModeTurnLaneGuard(turnContext, streamLaneId, "reasoning_chunk_append")) {
              continue;
            }
            const turnPanel = turnEl.closest(".vera-reasoning-tab-panel");
            if (turnPanel instanceof HTMLElement) {
              const turnDomLane = getWorkModeReasoningLaneId(Number(turnPanel.dataset.tabIndex));
              if (turnDomLane && turnDomLane !== streamLaneId) {
                workModeTurnLaneGuard(turnContext, turnDomLane, "reasoning_chunk_append_dom");
                continue;
              }
            }
            logWorkModeLaneInvariant("reasoning_chunk_append", turnContext?.turn_lane_id || streamLaneId, streamLaneId, {
              turn_id: turnContext?.turn_id || null,
              current_active_dom_lane_id: getActiveDomReasoningLaneId() || null
            });
            console.info("[reasoning_chunk_append]", {
              turn_id: turnContext?.turn_id || null,
              stream_lane_id: streamLaneId,
              current_active_dom_lane_id: getActiveDomReasoningLaneId() || null
            });
            markdownAcc += String(o.text);
            turnEl.dataset.markdownAcc = markdownAcc;
            renderWorkModeMarkdown(turnEl, markdownAcc, summaryText);
            maybeReasoningScrollToLatest(scrollEl);
          }
        }
        if (done) break;
      }
    } catch (_) {}
    const panelForTitle = getReasoningPanelElementByLaneId(streamLaneId) || turnEl.closest(".vera-reasoning-tab-panel");
    const mdDone = String(markdownAcc || "").trim();
    const excerptCap = 12000;
    const excerpt = mdDone.length > excerptCap ? `${mdDone.slice(0, excerptCap)}\n…` : mdDone;
    const summaryLine = extractWorkModeReasoningSummaryAnswerLine(summaryText);
    const codeOrMath = Boolean(
      mdDone &&
        (/\`\`\`/.test(mdDone) ||
          /\$[^\s$]/.test(mdDone) ||
          /\\[\[(]/.test(mdDone) ||
          /\bdef\s+\w/.test(mdDone) ||
          /\bimport\s+/.test(mdDone))
    );
    commitActiveWorkModeReasoningContext(
      {
        stream_started_lane_id: streamLaneId,
        active_lane_id: streamLaneId,
        lane_title: streamLaneTitleAtStart,
        last_user_request: streamUserRequest,
        prior_problem_anchor: streamPriorAnchor || "",
        latest_reasoning_summary: summaryLine,
        latest_final_answer_excerpt: excerpt,
        latest_markdown_preview: mdDone.slice(0, 3200),
        code_or_math_generated: codeOrMath
      },
      {
        source_function: "streamWorkModeReasoningComposer",
        stream_started_lane_id: streamLaneId,
        frozen_lane_id: turnContext?.turn_lane_id || streamLaneId,
        frozen_turn_id: turnContext?.turn_id || "",
        turn_el: turnEl
      }
    );
    const composerTitlePath = "wm.composer.reasoning_ndjson_done.typed";
    setReasoningTabTopicFromFinal(turnEl, {
      summaryText: extractWorkModeReasoningSummaryAnswerLine(summaryText),
      markdownText: markdownAcc,
      userPrompt: streamUserRequest,
      turnId: turnContext?.turn_id ?? null,
      calledFrom: composerTitlePath
    });
    if (panelForTitle instanceof HTMLElement) {
      queueLlmReasoningPanelTitleAfterFirstCompletedTurn(panelForTitle, {
        userPrompt: streamUserRequest,
        markdownText: markdownAcc,
        summaryText: extractWorkModeReasoningSummaryAnswerLine(summaryText),
        turnId: turnContext?.turn_id ?? null,
        calledFrom: composerTitlePath
      });
    } else {
      reasoningTitleCandidateDebugLog(null, {
        turn_id: turnContext?.turn_id ?? null,
        lane_id: streamLaneId || null,
        candidate_title: "",
        candidate_source: "queue_skipped_no_panel_element",
        called_from: `${composerTitlePath}.panelForTitle_miss`,
        extra: { hint: "getReasoningPanelElementByLaneId and turnEl.closest both failed" }
      });
      reasoningTitleUpdateDebugLog(streamLaneId || null, "(unknown)", "", false, "skip_title_panel_dom_miss_composer_path");
    }
    maybeReasoningScrollToLatest(scrollEl);
  } catch (streamErr) {
    try {
      console.info("[turn_error]", {
        turn_id: turnIdLc,
        lane_id: streamLaneId,
        error: String(streamErr?.message || streamErr)
      });
    } catch (_) {}
    if (!composerLifecycleReleased) safeComposerLaneRelease("error");
    throw streamErr;
  } finally {
    if (!composerLifecycleReleased) safeComposerLaneRelease("finally_guard");
  }
}

function createWorkChecklistDragHandle() {
  const handle = document.createElement("div");
  handle.className = "vera-wm-checklist-drag-handle";
  handle.setAttribute("aria-label", "Drag to reorder");
  const dots = document.createElement("div");
  dots.className = "vera-wm-checklist-drag-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 6; i += 1) dots.appendChild(document.createElement("span"));
  handle.appendChild(dots);
  return handle;
}

const WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX = 26;
let workChecklistDragSession = { id: "", startX: 0, lastX: 0 };

function readChecklistItemsFromStorageSafe() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeChecklistItemsToStorageSafe(items) {
  try {
    markWorkChecklistLocalMutation();
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return true;
  } catch {
    return false;
  }
}

function isChecklistDescendant(items, maybeChildId, maybeAncestorId) {
  const map = new Map(items.map((x) => [String(x?.id || ""), String(x?.parent_id || "")]));
  let cur = String(maybeChildId || "");
  const ancestor = String(maybeAncestorId || "");
  if (!cur || !ancestor) return false;
  let guard = 0;
  while (guard < 200) {
    const p = map.get(cur);
    if (!p) return false;
    if (p === ancestor) return true;
    cur = p;
    guard += 1;
  }
  return false;
}

function applyChecklistNestingFromDrag(draggedId) {
  const sid = String(draggedId || "");
  if (!sid) return false;
  const dx = Number(workChecklistDragSession.lastX) - Number(workChecklistDragSession.startX);
  if (!Number.isFinite(dx) || Math.abs(dx) < WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX) return false;
  const items = readChecklistItemsFromStorageSafe();
  const idx = items.findIndex((x) => String(x?.id || "") === sid);
  if (idx < 0) return false;
  const dragged = items[idx];
  if (!dragged || typeof dragged.text !== "string") return false;

  if (dx <= -WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX) {
    if (!dragged.parent_id) return false;
    items[idx] = { ...dragged, parent_id: null };
    return writeChecklistItemsToStorageSafe(items);
  }

  let parentCandidate = null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = items[i];
    if (!prev || String(prev.id || "") === sid) continue;
    if (Boolean(prev.done) !== Boolean(dragged.done)) continue;
    if (prev.parent_id) continue;
    parentCandidate = prev;
    break;
  }
  if (!parentCandidate?.id) return false;
  const pid = String(parentCandidate.id);
  if (pid === sid) return false;
  if (isChecklistDescendant(items, pid, sid)) return false;
  items[idx] = { ...dragged, parent_id: pid };
  return writeChecklistItemsToStorageSafe(items);
}

function workChecklistInsertBeforeFromY(container, clientY) {
  const dragging = container.querySelector(":scope > li.vera-wm-checklist-dragging");
  const lis = [...container.querySelectorAll(":scope > li")].filter((el) => el !== dragging);
  for (const child of lis) {
    const r = child.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return child;
  }
  return null;
}

function persistWorkChecklistOrderFromDom() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl) return;
  const ongoingIds = [...ongoingUl.querySelectorAll(":scope > li")].map((el) => el.dataset.id).filter(Boolean);
  const completedIds = [...completedUl.querySelectorAll(":scope > li")].map((el) => el.dataset.id).filter(Boolean);
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const map = new Map(items.map((x) => [String(x.id), x]));
    const next = [...ongoingIds, ...completedIds].map((id) => map.get(id)).filter(Boolean);
    if (next.length !== items.length) return;
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(next));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

function applyWorkChecklistCompletedCollapseFromStorage() {
  const pane = document.getElementById("vera-wm-checklist-pane");
  const btn = document.getElementById("vera-wm-checklist-completed-toggle");
  if (!pane || !btn || pane.classList.contains("vera-wm-checklist-pane--ongoing-only")) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY) === "1";
  } catch (_) {}
  pane.classList.toggle("vera-wm-checklist-pane--completed-collapsed", collapsed);
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function wireWorkChecklistCompletedCollapse() {
  const btn = document.getElementById("vera-wm-checklist-completed-toggle");
  const pane = document.getElementById("vera-wm-checklist-pane");
  if (!btn || !pane || btn.dataset.collapseWired === "1") return;
  btn.dataset.collapseWired = "1";
  btn.addEventListener("click", () => {
    if (pane.classList.contains("vera-wm-checklist-pane--ongoing-only")) return;
    const collapsed = !pane.classList.contains("vera-wm-checklist-pane--completed-collapsed");
    pane.classList.toggle("vera-wm-checklist-pane--completed-collapsed", collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    try {
      localStorage.setItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY, collapsed ? "1" : "0");
      queueWorkChecklistSyncToServer();
    } catch (_) {}
  });
}

function ensureWorkChecklistListDnD() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl || ongoingUl.dataset.checklistDnd === "1") return;
  ongoingUl.dataset.checklistDnd = "1";
  completedUl.dataset.checklistDnd = "1";

  const onDragOver = (e) => {
    const ul = e.currentTarget;
    if (!(ul instanceof HTMLElement)) return;
    e.preventDefault();
    workChecklistDragSession.lastX = Number(e.clientX) || workChecklistDragSession.lastX;
    try {
      e.dataTransfer.dropEffect = "move";
    } catch (_) {}
    const dragging = ul.querySelector(":scope > li.vera-wm-checklist-dragging");
    if (!dragging) return;
    const insertBefore = workChecklistInsertBeforeFromY(ul, e.clientY);
    if (insertBefore === null) ul.appendChild(dragging);
    else ul.insertBefore(dragging, insertBefore);
  };

  ongoingUl.addEventListener("dragover", onDragOver);
  completedUl.addEventListener("dragover", onDragOver);
}

/**
 * If the first row is an empty ongoing placeholder but completed items follow it in storage,
 * the placeholder was likely inserted at index 0 (legacy bug). Rotate it to the end so it
 * stays the trailing “new item” slot, not a stray row above completed tasks.
 */
function normalizeWorkChecklistLeadingPlaceholderInStorage() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items) || items.length < 2) return false;
    const first = items[0];
    if (!first || typeof first.text !== "string" || Boolean(first.done)) return false;
    if (String(first.text).trim() !== "") return false;
    if (!items.slice(1).some((x) => x && Boolean(x.done))) return false;
    const [head, ...rest] = items;
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify([...rest, head]));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

/** Drops empty ongoing rows except the bottom-most one (storage order among !done items). */
function pruneInteriorEmptyOngoingItems() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const valid = (x) => x && typeof x.text === "string";
    const ongoingIndices = [];
    for (let i = 0; i < items.length; i += 1) {
      if (valid(items[i]) && !Boolean(items[i].done)) ongoingIndices.push(i);
    }
    if (ongoingIndices.length <= 1) return false;
    const toRemove = [];
    for (let j = 0; j < ongoingIndices.length - 1; j += 1) {
      const i = ongoingIndices[j];
      if (String(items[i].text).trim() === "") toRemove.push(i);
    }
    if (toRemove.length === 0) return false;
    toRemove.sort((a, b) => b - a);
    for (const i of toRemove) items.splice(i, 1);
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

/** Ensures the last ongoing row is always an empty slot for new text (no separate “+” row). */
function ensureWorkChecklistTrailingEmptyOngoing() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const valid = (x) => x && typeof x.text === "string";
    let lastOngoingIndex = -1;
    for (let i = 0; i < items.length; i += 1) {
      if (valid(items[i]) && !Boolean(items[i].done)) lastOngoingIndex = i;
    }
    const lastOngoing = lastOngoingIndex >= 0 ? items[lastOngoingIndex] : null;
    const needNew =
      lastOngoingIndex < 0 || !lastOngoing || String(lastOngoing.text).trim() !== "";
    if (!needNew) return false;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    /* When there are no ongoing rows yet, append at list end — never splice(0,0) or the empty slot sits above completed items in storage order. */
    if (lastOngoingIndex < 0) {
      items.push({ id, text: "", done: false, parent_id: null });
    } else {
      items.splice(lastOngoingIndex + 1, 0, { id, text: "", done: false, parent_id: null });
    }
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

/** Insert a new empty ongoing row immediately after the given ongoing item (by storage order). */
function insertWorkChecklistEmptyOngoingAfter(afterId) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const idx = items.findIndex((x) => x && String(x.id) === String(afterId));
    if (idx < 0) return null;
    const row = items[idx];
    if (!row || typeof row.text !== "string" || Boolean(row.done)) return null;
    const nid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    items.splice(idx + 1, 0, { id: nid, text: "", done: false, parent_id: null });
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return nid;
  } catch (_) {
    return null;
  }
}

function loadWorkChecklistItems() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl) return;
  ensureWorkChecklistListDnD();
  normalizeWorkChecklistLeadingPlaceholderInStorage();
  /* Do not call pruneInteriorEmptyOngoingItems on load — it would remove intentional mid-list empties from Enter. */
  let guard = 0;
  while (ensureWorkChecklistTrailingEmptyOngoing()) {
    guard += 1;
    if (guard > 10) break;
  }
  let items = [];
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    if (raw) items = JSON.parse(raw);
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }
  const idMap = new Map(items.map((x) => [String(x?.id || ""), x]));
  const depthCache = new Map();
  const getDepth = (id) => {
    const sid = String(id || "");
    if (!sid) return 0;
    if (depthCache.has(sid)) return depthCache.get(sid);
    let depth = 0;
    let cur = idMap.get(sid);
    const visited = new Set([sid]);
    while (cur && cur.parent_id && depth < 1) {
      const pid = String(cur.parent_id || "");
      if (!pid || visited.has(pid)) break;
      const parent = idMap.get(pid);
      if (!parent || Boolean(parent.done) !== Boolean(cur.done)) break;
      visited.add(pid);
      depth += 1;
      cur = parent;
    }
    depthCache.set(sid, depth);
    return depth;
  };
  ongoingUl.replaceChildren();
  completedUl.replaceChildren();
  items.forEach((it) => {
    if (!it || typeof it.text !== "string") return;
    const id = String(it.id || "");
    const li = document.createElement("li");
    li.className = "vera-wm-checklist-li";
    if (it.done) li.classList.add("is-done");
    li.dataset.id = id;
    li.style.setProperty("--checklist-depth", String(getDepth(id)));
    li.draggable = false;

    const handle = createWorkChecklistDragHandle();
    handle.draggable = true;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "vera-wm-checklist-cb";
    cb.checked = Boolean(it.done);
    cb.setAttribute("aria-label", it.done ? "Mark as not done" : "Mark complete");
    const actions = document.createElement("div");
    actions.className = "vera-wm-checklist-li-actions";

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "vera-wm-checklist-action vera-wm-checklist-action-del";
    btnDel.textContent = "✕";
    btnDel.setAttribute("aria-label", "Delete item");
    btnDel.title = "Delete";

    actions.appendChild(btnDel);

    /* dragstart targets the draggable node; with draggable on <li>, e.target was often
       the <li> itself, so closest(handle) failed and every drag was cancelled. */
    handle.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      li.classList.add("vera-wm-checklist-dragging");
      workChecklistDragSession = {
        id,
        startX: Number(e.clientX) || 0,
        lastX: Number(e.clientX) || 0,
      };
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", id);
      } catch (_) {}
      try {
        const r = li.getBoundingClientRect();
        e.dataTransfer.setDragImage(li, Math.round(e.clientX - r.left), Math.round(e.clientY - r.top));
      } catch (_) {}
    });
    handle.addEventListener("dragend", () => {
      li.classList.remove("vera-wm-checklist-dragging");
      persistWorkChecklistOrderFromDom();
      applyChecklistNestingFromDrag(id);
      workChecklistDragSession = { id: "", startX: 0, lastX: 0 };
      const pruned = pruneInteriorEmptyOngoingItems();
      const ensured = ensureWorkChecklistTrailingEmptyOngoing();
      if (pruned || ensured) loadWorkChecklistItems();
      else loadWorkChecklistItems();
    });

    btnDel.addEventListener("click", () => {
      persistWorkChecklistRemove(id);
      loadWorkChecklistItems();
    });

    cb.addEventListener("change", () => {
      const wantDone = cb.checked;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (wantDone && !it.done) {
        const textInp = li.querySelector(".vera-wm-checklist-task-input");
        const t = textInp instanceof HTMLInputElement ? textInp.value : it.text;
        if (!String(t ?? "").trim()) {
          cb.checked = false;
          return;
        }
        if (textInp instanceof HTMLInputElement) persistWorkChecklistUpdateText(id, textInp.value);

        if (reduceMotion) {
          persistWorkChecklistToggle(id, true);
          loadWorkChecklistItems();
          return;
        }

        li.classList.add("vera-wm-checklist-li-exiting");
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          window.clearTimeout(fallbackTimer);
          li.removeEventListener("transitionend", onTransitionEnd);
          persistWorkChecklistToggle(id, true);
          loadWorkChecklistItems();
          queueWorkChecklistRowEnterAnimation("vera-wm-checklist-completed", id);
        };
        const onTransitionEnd = (ev) => {
          if (ev.target !== li) return;
          if (ev.propertyName !== "opacity" && ev.propertyName !== "filter") return;
          complete();
        };
        const fallbackTimer = window.setTimeout(complete, 420);
        li.addEventListener("transitionend", onTransitionEnd);
        return;
      }

      if (!wantDone && it.done) {
        if (reduceMotion) {
          persistWorkChecklistToggle(id, false);
          loadWorkChecklistItems();
          return;
        }

        li.classList.add("vera-wm-checklist-li-exiting");
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          window.clearTimeout(fallbackTimer);
          li.removeEventListener("transitionend", onTransitionEnd);
          persistWorkChecklistToggle(id, false);
          loadWorkChecklistItems();
          queueWorkChecklistRowEnterAnimation("vera-wm-checklist-ongoing", id);
        };
        const onTransitionEnd = (ev) => {
          if (ev.target !== li) return;
          if (ev.propertyName !== "opacity" && ev.propertyName !== "filter") return;
          complete();
        };
        const fallbackTimer = window.setTimeout(complete, 420);
        li.addEventListener("transitionend", onTransitionEnd);
        return;
      }

      persistWorkChecklistToggle(id, wantDone);
      loadWorkChecklistItems();
    });

    if (it.done) {
      const span = document.createElement("span");
      span.className = "vera-wm-checklist-task-text";
      span.textContent = it.text;
      li.appendChild(handle);
      li.appendChild(cb);
      li.appendChild(span);
      li.appendChild(actions);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "vera-wm-checklist-task-input";
      inp.placeholder = "List item";
      inp.value = it.text;
      inp.maxLength = 200;
      inp.autocomplete = "off";
      inp.draggable = false;
      inp.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
          if (!ongoingUl) return;
          const inputs = [...ongoingUl.querySelectorAll(".vera-wm-checklist-task-input")];
          const rowIdx = inputs.indexOf(inp);
          if (rowIdx < 0) return;
          const len = inp.value.length;
          const sel0 = inp.selectionStart ?? 0;
          const sel1 = inp.selectionEnd ?? 0;
          if (e.key === "ArrowDown") {
            if (sel0 !== len || sel1 !== len) return;
            const next = inputs[rowIdx + 1];
            if (next instanceof HTMLInputElement) {
              e.preventDefault();
              next.focus();
              next.setSelectionRange(0, 0);
            }
            return;
          }
          if (sel0 !== 0 || sel1 !== 0) return;
          const prev = inputs[rowIdx - 1];
          if (prev instanceof HTMLInputElement) {
            e.preventDefault();
            prev.focus();
            const pl = prev.value.length;
            prev.setSelectionRange(pl, pl);
          }
          return;
        }
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        persistWorkChecklistUpdateText(id, inp.value);
        const newId = insertWorkChecklistEmptyOngoingAfter(id);
        loadWorkChecklistItems();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const ul = document.getElementById("vera-wm-checklist-ongoing");
            const sel = newId
              ? `li[data-id="${newId}"] .vera-wm-checklist-task-input`
              : "li:last-child .vera-wm-checklist-task-input";
            const nextInp = ul?.querySelector(sel);
            if (nextInp instanceof HTMLInputElement) nextInp.focus();
          });
        });
      });
      inp.addEventListener("blur", () => {
        window.setTimeout(() => {
          const next = document.activeElement;
          if (next && li.contains(next)) {
            persistWorkChecklistUpdateText(id, inp.value);
            return;
          }
          persistWorkChecklistUpdateText(id, inp.value);
          /* replaceChildren (e.g. after Enter) detaches this row; blur still fires — do not treat as “abandon middle empty”. */
          if (!li.isConnected) return;
          const ul = document.getElementById("vera-wm-checklist-ongoing");
          const siblings = ul ? [...ul.querySelectorAll(":scope > li")] : [];
          const rowIdx = siblings.indexOf(li);
          if (rowIdx < 0) return;
          const isLastOngoing = rowIdx === siblings.length - 1;
          let removedMiddle = false;
          if (!inp.value.trim() && !isLastOngoing) {
            persistWorkChecklistRemove(id);
            removedMiddle = true;
          }
          /* Do not prune all interior empties on every blur — that removed a new Enter row when focus moved to another item. */
          const ensured = ensureWorkChecklistTrailingEmptyOngoing();
          if (removedMiddle || ensured) loadWorkChecklistItems();
        }, 0);
      });
      li.appendChild(handle);
      li.appendChild(cb);
      li.appendChild(inp);
      li.appendChild(actions);
    }
    (it.done ? completedUl : ongoingUl).appendChild(li);
  });

  const pane = document.getElementById("vera-wm-checklist-pane");
  const completedSection = document.getElementById("vera-wm-checklist-completed-section");
  /* Use rows actually rendered — items with done:true but invalid text are skipped in forEach
     but used to be counted here, which left an empty “Completed” chrome visible. */
  const completedCount = completedUl.querySelectorAll(":scope > li").length;
  const countEl = document.getElementById("vera-wm-checklist-completed-count");
  if (countEl) countEl.textContent = completedCount ? ` (${completedCount})` : "";
  if (completedSection && pane) {
    if (completedCount === 0) {
      completedSection.hidden = true;
      completedSection.classList.add("vera-wm-checklist-completed-section--empty");
      pane.classList.add("vera-wm-checklist-pane--ongoing-only");
      pane.classList.remove("vera-wm-checklist-pane--completed-collapsed");
    } else {
      completedSection.hidden = false;
      completedSection.classList.remove("vera-wm-checklist-completed-section--empty");
      pane.classList.remove("vera-wm-checklist-pane--ongoing-only");
      applyWorkChecklistCompletedCollapseFromStorage();
    }
  }
  syncWorkChecklistEraseButton();
  syncWorkChecklistHelpPlanButton();
}

function persistWorkChecklistToggle(id, done) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    items = items.map((x) =>
      String(x.id) === id ? { ...x, done: Boolean(done) } : x
    );
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

function persistWorkChecklistUpdateText(id, text) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    items = items.map((x) => (String(x.id) === id ? { ...x, text: String(text) } : x));
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

function persistWorkChecklistRemove(id) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    items = items.filter((x) => String(x.id) !== id);
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

const WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS = 24;
const WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS = 12000;
let workChecklistSyncPreviewEditing = false;
/** Bumps when reasoning finishes with a checklist-capable plan (see onDone). */
let workChecklistSyncPlanVersion = 0;
/** Last `workChecklistSyncPlanVersion` successfully applied to the checklist (Apply / voice sync); preview alone does not advance this. */
let workChecklistSyncConsumedPlanVersion = 0;
/** Markdown snapshot for the latest unsynced plan (with checklist). Survives later non-plan reasoning turns; replaced when a newer plan arrives; cleared on successful Apply. */
let workChecklistSyncPendingMarkdown = "";
let workChecklistSyncPendingPlanMeta = null;

function planSyncPreviewRows(rows, limit = 5) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((row) => String(row?.text || "").trim())
    .filter(Boolean);
}

function getPlanSyncPanelMetaForLane(laneId, fallbackTitle = "") {
  const activePanel = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active");
  let lid = String(laneId || "").trim();
  if (!lid && activePanel instanceof HTMLElement) {
    const activeIdx = Number(activePanel.dataset.tabIndex);
    if (Number.isFinite(activeIdx)) {
      lid = getWorkModeReasoningLaneId(activeIdx);
    } else {
      lid = String(activePanel.dataset.laneId || "").trim();
    }
  }
  const panel = lid ? getReasoningPanelElementByLaneId(lid) : activePanel;
  const activeLaneId =
    activePanel instanceof HTMLElement
      ? getWorkModeReasoningLaneId(Number(activePanel.dataset.tabIndex))
      : getActiveDomReasoningLaneId();
  return {
    lane_id: lid,
    panel_id: lid,
    panel_title:
      (panel instanceof HTMLElement ? getReasoningTabTopicLabel(panel) : "") ||
      String(fallbackTitle || "").trim() ||
      (lid ? getWorkModeLaneTitle(lid) : ""),
    active_panel_id: String(activeLaneId || "").trim(),
    active_panel_title:
      activePanel instanceof HTMLElement ? getReasoningTabTopicLabel(activePanel) : ""
  };
}

function logPlanSyncDebug(kind, payload = {}) {
  try {
    console.info(`[PLAN_SYNC_DEBUG][${kind}]`, payload);
  } catch (_) {}
}

function collectWorkChecklistOngoingTexts() {
  const ul = document.getElementById("vera-wm-checklist-ongoing");
  if (!ul) return [];
  const out = [];
  for (const li of ul.querySelectorAll(":scope > li")) {
    const inp = li.querySelector(".vera-wm-checklist-task-input");
    if (inp instanceof HTMLInputElement) {
      const t = inp.value.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function workChecklistHasAnyStoredItems() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) && items.length > 0;
  } catch {
    return false;
  }
}

function syncWorkChecklistEraseButton() {
  const btn = document.getElementById("vera-wm-checklist-erase-all");
  if (!(btn instanceof HTMLButtonElement)) return;
  btn.disabled = !workChecklistHasAnyStoredItems();
}

function syncWorkChecklistHelpPlanButton() {
  const btn = document.getElementById("vera-wm-checklist-help-plan");
  if (!btn) return;
  btn.disabled = collectWorkChecklistOngoingTexts().length === 0;
}

function syncWorkChecklistSyncPlanButton() {
  const btn = document.getElementById("vera-wm-checklist-sync-plan");
  if (!(btn instanceof HTMLButtonElement)) return;
  const selected = getWorkChecklistSyncSourceCandidate();
  const canUseSync = Boolean(selected?.markdown);
  btn.disabled = !canUseSync;
  logPlanSyncDebug("button", {
    lane_id: selected?.meta?.lane_id || null,
    panel_id: selected?.meta?.panel_id || null,
    panel_title: selected?.meta?.panel_title || "",
    sync_button_visible: !btn.hidden,
    sync_button_enabled: !btn.disabled,
    syncable: canUseSync,
    has_sync_metadata: Boolean(selected?.markdown),
    sync_candidate_count: selected?.rows?.length || 0,
    reason_if_disabled: canUseSync ? "" : "no_parseable_plan_candidates"
  });
}

function getLatestWorkModeReasoningMarkdown() {
  const scroll = getActiveReasoningScrollEl();
  if (!(scroll instanceof HTMLElement)) return "";
  const turns = [...scroll.querySelectorAll(".vera-reasoning-turn")];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const md = String(turns[i]?.dataset?.markdownAcc || "").trim();
    if (md) return md;
  }
  return "";
}

function getLatestMarkdownInReasoningScroll(scroll) {
  if (!(scroll instanceof HTMLElement)) return "";
  const turns = [...scroll.querySelectorAll(".vera-reasoning-turn")];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const md = String(turns[i]?.dataset?.markdownAcc || "").trim();
    if (md) return md;
  }
  return "";
}

function isChecklistSyncHeadingText(text) {
  const t = normalizeChecklistLineText(text).replace(/[:#]+$/g, "").trim().toLowerCase();
  return /^(sync\s+checklist|checklist|plan\s+checklist|tasks?)$/.test(t);
}

function listItemsToChecklistMarkdown(items) {
  const lines = [];
  for (const li of items) {
    if (!(li instanceof HTMLElement)) continue;
    const clone = li.cloneNode(true);
    if (clone instanceof HTMLElement) {
      clone.querySelectorAll("ul,ol").forEach((nested) => nested.remove());
    }
    const text = normalizeChecklistLineText(clone.textContent || li.textContent || "");
    if (!text || /\?$/.test(text)) continue;
    lines.push(`- ${text}`);
    const nested = li.querySelectorAll(":scope > ul > li, :scope > ol > li");
    for (const sub of nested) {
      const subText = normalizeChecklistLineText(sub.textContent || "");
      if (subText && !/\?$/.test(subText)) lines.push(`  - ${subText}`);
    }
  }
  return lines;
}

function renderedChecklistMarkdownFromPanel(panel) {
  if (!(panel instanceof HTMLElement)) return "";
  const scroll =
    panel.querySelector(".vera-reasoning-md-panel") ||
    panel.querySelector(".vera-reasoning-scroll") ||
    panel;
  if (!(scroll instanceof HTMLElement)) return "";

  // Preferred path: rendered markdown headings followed by UL/OL siblings.
  const headingEls = [...scroll.querySelectorAll("h1,h2,h3,h4,h5,h6,p,div,strong,b")]
    .filter((el) => el instanceof HTMLElement && isChecklistSyncHeadingText(el.textContent || ""));
  for (const heading of headingEls) {
    const lines = [];
    let node = heading instanceof HTMLElement ? heading.nextElementSibling : null;
    while (node) {
      const tag = String(node.tagName || "").toLowerCase();
      if (/^h[1-6]$/.test(tag)) break;
      if (isChecklistSyncHeadingText(node.textContent || "") && node !== heading) break;
      if (tag === "ul" || tag === "ol") {
        lines.push(...listItemsToChecklistMarkdown(node.querySelectorAll(":scope > li")));
      } else if (tag === "li") {
        lines.push(...listItemsToChecklistMarkdown([node]));
      }
      node = node.nextElementSibling;
    }
    if (lines.length) return `## SYNC CHECKLIST\n${lines.join("\n")}`;
  }

  // Fallback path for markdown rendered as plain text in the panel.
  const plain = String(scroll.innerText || scroll.textContent || "").replace(/\r/g, "");
  const lines = plain.split("\n");
  const start = lines.findIndex((line) => isChecklistSyncHeadingText(line));
  if (start >= 0) {
    const out = ["## SYNC CHECKLIST"];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = normalizeChecklistLineText(lines[i]);
      if (!line) continue;
      if (isChecklistSyncHeadingText(line) || /^#{1,6}\s+/.test(line)) break;
      if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
        out.push(lines[i]);
      } else if (/^\s*\[[^\]]+\]\s*:/.test(line) || /\b(read|open|highlight|draft|write|review|revise|submit|finish|complete|study|solve|practice)\b/i.test(line)) {
        out.push(`- ${line}`);
      }
    }
    if (out.length > 1) return out.join("\n");
  }
  return "";
}

function getWorkModeReasoningMarkdownCandidates() {
  const candidates = [];
  const seen = new Set();
  const push = (md, source, meta = {}) => {
    const text = String(md || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    candidates.push({ markdown: text, source, meta });
  };

  // Pending is the newest server-confirmed plan while the page stays alive.
  push(workChecklistSyncPendingMarkdown, "pending_plan", workChecklistSyncPendingPlanMeta || {});
  const activeLaneId = getActiveDomReasoningLaneId();
  const activePanel = activeLaneId ? getReasoningPanelElementByLaneId(activeLaneId) : null;
  const activeMeta = getPlanSyncPanelMetaForLane(activeLaneId);
  push(getLatestWorkModeReasoningMarkdown(), "active_reasoning_tab", activeMeta);
  push(renderedChecklistMarkdownFromPanel(activePanel), "active_reasoning_tab_rendered", {
    ...activeMeta,
    source_detail: "rendered_dom_fallback"
  });

  // Also scan all reasoning tabs so Sync remains available after accepting
  // once, switching lanes, or when the visible active tab is not the plan tab.
  const root = document.getElementById("vera-reasoning-tab-panels");
  if (root instanceof HTMLElement) {
    const panels = [...root.querySelectorAll(".vera-reasoning-tab-panel")];
    for (const panel of panels) {
      const idx = Number(panel.dataset.tabIndex);
      const laneId = Number.isFinite(idx) ? getWorkModeReasoningLaneId(idx) : "";
      const scroll =
        panel.querySelector(".vera-reasoning-md-panel") ||
        panel.querySelector(".vera-reasoning-scroll");
      push(getLatestMarkdownInReasoningScroll(scroll), "reasoning_tab", {
        ...getPlanSyncPanelMetaForLane(laneId),
        panel_title: getReasoningTabTopicLabel(panel)
      });
      push(renderedChecklistMarkdownFromPanel(panel), "reasoning_tab_rendered", {
        ...getPlanSyncPanelMetaForLane(laneId),
        panel_title: getReasoningTabTopicLabel(panel),
        source_detail: "rendered_dom_fallback"
      });
    }
  }

  return candidates;
}

function getWorkChecklistSyncSourceCandidate() {
  const candidates = getWorkModeReasoningMarkdownCandidates();
  for (const cand of candidates) {
    const rows = buildChecklistProposalFromMarkdown(cand.markdown);
    logPlanSyncDebug("parse", {
      panel_id: cand?.meta?.panel_id || null,
      lane_id: cand?.meta?.lane_id || null,
      panel_title: cand?.meta?.panel_title || "",
      source: cand?.source || "",
      markdown_length: String(cand?.markdown || "").length,
      has_sync_heading: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:SYNC CHECKLIST|Checklist|Plan checklist|Tasks)\b/i.test(
        String(cand?.markdown || "")
      ),
      sync_candidate_count: rows.length,
      candidates_preview: planSyncPreviewRows(rows),
      reason_if_zero: rows.length ? "" : "no_parseable_bullets_in_candidate"
    });
    if (rows.length > 0) {
      return { ...cand, rows };
    }
  }
  return null;
}

/** Markdown used for checklist Sync: first parseable pending/active/any-tab plan. */
function getWorkChecklistSyncSourceMarkdown() {
  const selected = getWorkChecklistSyncSourceCandidate();
  if (selected?.markdown) {
    return selected.markdown;
  }
  return "";
}

function normalizeChecklistLineText(text) {
  let raw = String(text || "");
  // Some rendered markdown snapshots carry HTML entities back into text
  // (`&#58;` for `:`). Decode before parsing so visible SYNC CHECKLIST bullets
  // are treated the same as original markdown bullets.
  try {
    if (/[&][a-zA-Z0-9#]+;/.test(raw) && typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.innerHTML = raw;
      raw = ta.value;
    }
  } catch (_) {}
  return raw
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildChecklistProposalFromMarkdown(markdown) {
  const full = String(markdown || "").replace(/\r/g, "");
  const syncBlockMatch =
    full.match(
      /(?:^|\n)#{1,6}\s*(?:SYNC CHECKLIST|Checklist|Plan checklist|Tasks)\s*\n([\s\S]*?)(?=\n#{1,6}\s+|\s*$)/i
    ) ||
    full.match(
      /(?:^|\n)\s*(?:SYNC CHECKLIST|Checklist|Plan checklist|Tasks)\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:#{1,6}\s+|[A-Z][A-Z0-9 \-/]{2,}:?\s*\n)|\s*$)/i
    );
  const source = syncBlockMatch ? syncBlockMatch[1] : full;
  const hasExplicitSyncBlock = Boolean(syncBlockMatch);
  const planishMarkdown = /\b(plan|schedule|outline|essay|draft|revise|revision|research|write|study|prepare|time\s*block|hour|deadline|due)\b/i.test(
    full.slice(0, 5000)
  );
  const rawLines = source.split("\n");
  const proposals = [];
  let currentTop = "";
  let inCode = false;
  let inQuestionsSection = false;
  const timeTitlePattern =
    /^\s*\[\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]+)\s*-\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]+)\s*\]\s*:\s*.+$/i;
  const subCountByTopText = new Map();
  for (const raw of rawLines) {
    const line = String(raw || "");
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      const text = normalizeChecklistLineText(heading[1]).toLowerCase();
      inQuestionsSection = /\b(question|questions|clarif|narrow)\b/.test(text);
      continue;
    }
    const listMatch = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listMatch) {
      const indent = (listMatch[1] || "").replace(/\t/g, "  ").length;
      const text = normalizeChecklistLineText(listMatch[2]);
      if (!text) continue;
      if (inQuestionsSection) continue;
      if (/\?$/.test(text) || /^(question|questions)[:\s-]/i.test(text)) continue;
      if (indent >= 2 && currentTop) {
        const topKey = currentTop.toLowerCase();
        const cur = subCountByTopText.get(topKey) || 0;
        if (cur >= 3) continue;
        proposals.push({ depth: 1, text });
        subCountByTopText.set(topKey, cur + 1);
      } else {
        // Preferred plan output has `[time-time]: task` top-level bullets, but
        // real planning turns sometimes produce normal bullets. If the markdown
        // is explicitly a sync block, or the saved pending turn is clearly a
        // plan, accept practical top-level bullets so the Sync button does not
        // disappear after a useful plan.
        if (!hasExplicitSyncBlock && !timeTitlePattern.test(text) && !planishMarkdown) continue;
        proposals.push({ depth: 0, text });
        currentTop = text;
        subCountByTopText.set(text.toLowerCase(), 0);
      }
      continue;
    }
  }
  const cleaned = [];
  const seen = new Set();
  for (const row of proposals) {
    const key = `${row.depth}|${row.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(row);
  }
  if (!cleaned.length && planishMarkdown) {
    const fallbackRows = [];
    const fallbackSeen = new Set();
    for (const raw of rawLines) {
      const line = String(raw || "").trim();
      if (!line || line.startsWith("```") || /^#{1,6}\s+/.test(line)) continue;
      if (/^\|/.test(line) || /^[-*_]{3,}$/.test(line)) continue;
      const withoutMarker = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|(?:step|part)\s+\d+\s*[:.)-]\s*)/i, "");
      const text = normalizeChecklistLineText(withoutMarker);
      if (!text || text.length < 4 || text.length > 140) continue;
      if (/\?$/.test(text)) continue;
      if (!/\b(write|read|review|finish|draft|outline|solve|practice|submit|check|revise|research|study|plan|pick|choose|organize|complete|work|start|prepare|edit|proofread|summarize)\b/i.test(text)) {
        continue;
      }
      const key = text.toLowerCase();
      if (fallbackSeen.has(key)) continue;
      fallbackSeen.add(key);
      fallbackRows.push({ depth: 0, text });
      if (fallbackRows.length >= 24) break;
    }
    return fallbackRows;
  }
  return cleaned.slice(0, 80);
}

function formatChecklistProposalText(rows) {
  return rows
    .map((row) => `${row.depth > 0 ? "  " : ""}- ${row.text}`)
    .join("\n");
}

function parseChecklistProposalText(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "));
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)(?:[-*+]\s+)(.+)$/);
    if (!m) continue;
    const indent = (m[1] || "").length;
    const clean = normalizeChecklistLineText(m[2]);
    if (!clean) continue;
    rows.push({ depth: indent >= 2 ? 1 : 0, text: clean });
  }
  if (!rows.length) return [];
  const out = [];
  let parentId = null;
  for (const row of rows) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (row.depth === 0) parentId = id;
    out.push({
      id,
      text: row.text,
      done: false,
      parent_id: row.depth > 0 ? parentId : null
    });
  }
  out.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: "",
    done: false,
    parent_id: null
  });
  return out;
}

function setWorkChecklistSyncPreviewEditing(editing) {
  const textarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  const editBtn = document.getElementById("vera-wm-checklist-sync-edit");
  workChecklistSyncPreviewEditing = Boolean(editing);
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.readOnly = !workChecklistSyncPreviewEditing;
    textarea.classList.toggle("is-editing", workChecklistSyncPreviewEditing);
    if (workChecklistSyncPreviewEditing) textarea.focus();
  }
  if (editBtn instanceof HTMLButtonElement) {
    editBtn.textContent = workChecklistSyncPreviewEditing ? "Lock" : "Edit";
  }
}

function showWorkChecklistSyncPreview(text) {
  const panel = document.getElementById("vera-wm-checklist-sync-preview");
  const textarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  const rows = parseChecklistProposalText(text);
  if (!(panel instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
    logPlanSyncDebug("preview_open", {
      preview_visible: false,
      candidate_count: rows.filter((x) => x && String(x.text || "").trim()).length,
      preview_items_preview: rows
        .filter((x) => x && String(x.text || "").trim())
        .slice(0, 6)
        .map((x) => String(x.text || "").trim()),
      reason_if_not_opened: "missing_preview_dom"
    });
    return;
  }
  textarea.value = String(text || "").slice(0, WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS);
  panel.hidden = false;
  setWorkChecklistSyncPreviewEditing(false);
  logPlanSyncDebug("preview_open", {
    preview_visible: !panel.hidden,
    candidate_count: rows.filter((x) => x && String(x.text || "").trim()).length,
    preview_items_preview: rows
      .filter((x) => x && String(x.text || "").trim())
      .slice(0, 6)
      .map((x) => String(x.text || "").trim()),
    reason_if_not_opened: panel.hidden ? "panel_hidden_after_open" : ""
  });
}

function hideWorkChecklistSyncPreview() {
  const panel = document.getElementById("vera-wm-checklist-sync-preview");
  if (panel instanceof HTMLElement) panel.hidden = true;
  setWorkChecklistSyncPreviewEditing(false);
}

function applyWorkChecklistSyncPreview() {
  const textarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    logPlanSyncDebug("accept_apply", {
      accepted: false,
      inserted_count: 0,
      checklist_count_before: readChecklistItemsFromStorageSafe().filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_after: readChecklistItemsFromStorageSafe().filter((x) => x && String(x.text || "").trim()).length,
      reason_if_failed: "missing_preview_textarea"
    });
    return false;
  }
  const beforeItems = readChecklistItemsFromStorageSafe();
  const items = parseChecklistProposalText(textarea.value);
  if (!items.length) {
    logPlanSyncDebug("accept_apply", {
      accepted: false,
      inserted_count: 0,
      checklist_count_before: beforeItems.filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_after: beforeItems.filter((x) => x && String(x.text || "").trim()).length,
      reason_if_failed: "preview_parse_empty"
    });
    flashWorkChecklistPlanHint("Nothing to apply. Keep '-' bullets in the proposal.");
    return false;
  }
  try {
    markWorkChecklistLocalMutation();
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    loadWorkChecklistItems();
    hideWorkChecklistSyncPreview();
    workChecklistSyncConsumedPlanVersion = workChecklistSyncPlanVersion;
    logPlanSyncDebug("checklist_insert", {
      inserted_count: items.filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_before: beforeItems.filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_after: items.filter((x) => x && String(x.text || "").trim()).length,
      inserted_items_preview: items
        .filter((x) => x && String(x.text || "").trim())
        .slice(0, 6)
        .map((x) => String(x.text || "").trim()),
      source_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
      source_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || ""
    });
    logPlanSyncDebug("accept_apply", {
      accepted: true,
      inserted_count: items.filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_before: beforeItems.filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_after: items.filter((x) => x && String(x.text || "").trim()).length,
      reason_if_failed: ""
    });
    workChecklistSyncPendingMarkdown = "";
    workChecklistSyncPendingPlanMeta = null;
    syncWorkChecklistSyncPlanButton();
    flashWorkChecklistPlanHint("Checklist updated from plan.");
    return true;
  } catch (err) {
    logPlanSyncDebug("accept_apply", {
      accepted: false,
      inserted_count: 0,
      checklist_count_before: beforeItems.filter((x) => x && String(x.text || "").trim()).length,
      checklist_count_after: beforeItems.filter((x) => x && String(x.text || "").trim()).length,
      reason_if_failed: String(err?.message || err || "apply_throw").slice(0, 200)
    });
    flashWorkChecklistPlanHint("Could not update checklist from plan.");
    return false;
  }
}

function eraseEntireWorkChecklist() {
  if (!workChecklistHasAnyStoredItems()) {
    flashWorkChecklistPlanHint("Checklist is already empty.");
    return;
  }
  const ok = window.confirm(
    "Erase the entire checklist? All ongoing and completed items will be removed. This cannot be undone."
  );
  if (!ok) return;
  try {
    markWorkChecklistLocalMutation();
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify([]));
    queueWorkChecklistSyncToServer();
    hideWorkChecklistSyncPreview();
    loadWorkChecklistItems();
    flashWorkChecklistPlanHint("Checklist cleared.");
    syncWorkChecklistSyncPlanButton();
  } catch (_) {
    flashWorkChecklistPlanHint("Could not erase checklist.");
  }
}

function runWorkChecklistSyncFromLatestPlan() {
  const selected = getWorkChecklistSyncSourceCandidate();
  const activeLaneId = getActiveDomReasoningLaneId();
  if (!selected?.markdown) {
    logPlanSyncDebug("button_click", {
      sync_button_enabled: !Boolean(document.getElementById("vera-wm-checklist-sync-plan")?.disabled),
      panel_id: null,
      lane_id: null,
      sync_candidate_count: 0,
      clicked: true
    });
    logPlanSyncDebug("voice_sync_request", {
      user_text: "",
      active_panel_id: activeLaneId || null,
      active_panel_title: getWorkModeLaneTitle(activeLaneId) || "",
      last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
      last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
      selected_sync_source_panel_id: null,
      selected_sync_source_panel_title: "",
      sync_candidate_count: 0,
      reason_if_failed: "no_sync_source_markdown"
    });
    flashWorkChecklistPlanHint("No checklist-ready plan found yet. Ask VERA for a plan first.");
    return false;
  }
  const rows = selected.rows || buildChecklistProposalFromMarkdown(selected.markdown);
  if (!rows.length) {
    logPlanSyncDebug("button_click", {
      sync_button_enabled: !Boolean(document.getElementById("vera-wm-checklist-sync-plan")?.disabled),
      panel_id: selected.meta?.panel_id || null,
      lane_id: selected.meta?.lane_id || null,
      sync_candidate_count: 0,
      clicked: true
    });
    logPlanSyncDebug("voice_sync_request", {
      user_text: "",
      active_panel_id: activeLaneId || null,
      active_panel_title: getWorkModeLaneTitle(activeLaneId) || "",
      last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
      last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
      selected_sync_source_panel_id: selected.meta?.panel_id || null,
      selected_sync_source_panel_title: selected.meta?.panel_title || "",
      sync_candidate_count: 0,
      reason_if_failed: "selected_source_parse_empty"
    });
    flashWorkChecklistPlanHint("Could not parse checklist bullets from the visible plan.");
    return false;
  }
  logPlanSyncDebug("button_click", {
    sync_button_enabled: !Boolean(document.getElementById("vera-wm-checklist-sync-plan")?.disabled),
    panel_id: selected.meta?.panel_id || null,
    lane_id: selected.meta?.lane_id || null,
    sync_candidate_count: rows.length,
    clicked: true
  });
  // Bind the visible/rendered fallback source as the current plan source so
  // Apply and voice-sync logs point at the panel that actually supplied rows.
  workChecklistSyncPendingMarkdown = selected.markdown;
  workChecklistSyncPendingPlanMeta = {
    ...(selected.meta || {}),
    source: selected.source || selected.meta?.source || "sync_source_candidate",
    created_at: selected.meta?.created_at || Date.now()
  };
  logPlanSyncDebug("voice_sync_request", {
    user_text: "",
    active_panel_id: activeLaneId || null,
    active_panel_title: getWorkModeLaneTitle(activeLaneId) || "",
    last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
    last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
    selected_sync_source_panel_id: selected.meta?.panel_id || null,
    selected_sync_source_panel_title: selected.meta?.panel_title || "",
    sync_candidate_count: rows.length,
    reason_if_failed: ""
  });
  showWorkChecklistSyncPreview(formatChecklistProposalText(rows));
  syncWorkChecklistSyncPlanButton();
  return true;
}

let workChecklistPlanHintTimer = null;
function flashWorkChecklistPlanHint(message) {
  const el = document.getElementById("vera-wm-checklist-plan-hint");
  if (!el) return;
  if (workChecklistPlanHintTimer) {
    window.clearTimeout(workChecklistPlanHintTimer);
    workChecklistPlanHintTimer = null;
  }
  el.textContent = message;
  workChecklistPlanHintTimer = window.setTimeout(() => {
    el.textContent = "";
    workChecklistPlanHintTimer = null;
  }, 4500);
}

function buildWorkChecklistHelpPlanUserMessage(lines) {
  const cap = lines.slice(0, WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS);
  const body = cap.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const more =
    lines.length > WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS
      ? `\n… (${lines.length - WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS} more items not shown)\n`
      : "";
  return (
    workModePlanningTimeInjectionPrefix() +
    "[Planning help. Be detailed in your reasoning output. First provide a concise plan explanation and practical tips. Then include a dedicated markdown heading exactly: '## SYNC CHECKLIST'. Under that heading, output checklist-ready bullets only with strict format: top-level bullet must be [time-time]: specific task title, and each top-level task must have 1 to 3 indented substeps (never 0, never more than 3). Substeps should be concrete and short, like focused work chunks. Schedule only at or after CURRENT LOCAL TIME unless the user implies otherwise. In the SYNC CHECKLIST section do NOT include questions, question sections, or question marks.]\n\n" +
    "Ongoing checklist (in order):\n" +
    body +
    more
  );
}

let workChecklistPlanRequestInFlight = false;

function isWorkChecklistPlanShortcutIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  const hasPlanVerb = /\b(plan|planning|roadmap|prioriti[sz]e|break\s*(it\s*)?down|organi[sz]e)\b/.test(t);
  const hasChecklistNoun = /\b(check\s*list|checklist|to-?do|todo|task list|tasks?)\b/.test(t);
  const directPhrase = /\b(help me plan|can you help me plan)\b/.test(t);
  return (hasPlanVerb && hasChecklistNoun) || (directPhrase && hasChecklistNoun);
}

/** Voice/typed: sync checklist from latest reasoning plan (## SYNC CHECKLIST etc.). Checked before plan shortcut. */
function isWorkChecklistSyncCommandIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  if (!/\b(sync|synced|synchroniz(?:e|ed|ing))\b/.test(t)) return false;
  const compact = t.replace(/\s+/g, " ");
  if (
    /^(hey\s+vera[,!\s]+)?(please\s+|can\s+you\s+|will\s+you\s+|could\s+you\s+|would\s+you\s+)?(just\s+)?sync(\s+(it|that|this|now))?\s*[.?!]*$/i.test(
      compact
    )
  ) {
    return true;
  }
  if (/^sync(\s+(it|that|this|now))?\s*[.?!]*$/i.test(compact)) return true;
  if (/\bsync\s+(that|it|this)\b/.test(t)) return true;
  const checklistWord = /\b(check\s*list|checklist|to-?do|todo|task\s*list|my\s+tasks?)\b/;
  if (checklistWord.test(t)) return true;
  if (/\b(sync|synchroniz).{0,160}\b(from|with)\s+(my\s+)?(plan|reasoning)\b/.test(t)) return true;
  if (/\b(sync|synchroniz).{0,120}\b(the\s+)?plan\b/.test(t)) return true;
  return false;
}

async function maybeHandleWorkChecklistSyncShortcut(text) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return false;
  if (!isWorkChecklistSyncCommandIntent(text)) return false;
  const activeLaneId = getActiveDomReasoningLaneId();
  const selected = getWorkChecklistSyncSourceCandidate();
  logPlanSyncDebug("voice_sync_request", {
    user_text: String(text || "").trim(),
    active_panel_id: activeLaneId || null,
    active_panel_title: getWorkModeLaneTitle(activeLaneId) || "",
    last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
    last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
    selected_sync_source_panel_id: selected?.meta?.panel_id || null,
    selected_sync_source_panel_title: selected?.meta?.panel_title || "",
    sync_candidate_count: selected?.rows?.length || 0,
    reason_if_failed: selected?.rows?.length ? "" : "no_sync_candidates_before_apply"
  });
  const ok = runWorkChecklistSyncFromLatestPlan();
  if (ok) {
    applyWorkChecklistSyncPreview();
  }
  return true;
}

async function runWorkChecklistHelpPlan({ signal } = {}) {
  if (!isVeraWorkModeOn()) return false;
  if (workChecklistPlanRequestInFlight) return true;
  const lines = collectWorkChecklistOngoingTexts();
  if (!lines.length) {
    flashWorkChecklistPlanHint("Add text to at least one ongoing item first.");
    return true;
  }
  const text = buildWorkChecklistHelpPlanUserMessage(lines);
  const helpPlanBtn = document.getElementById("vera-wm-checklist-help-plan");
  workChecklistPlanRequestInFlight = true;
  if (helpPlanBtn instanceof HTMLButtonElement) helpPlanBtn.disabled = true;
  try {
    const reasoningScroll = getActiveReasoningScrollEl();
    if (reasoningScroll instanceof HTMLElement) {
      reasoningScroll.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    const turnContext = createWorkModeFrozenTurnContext({
      userText: text,
      source: "keyboard"
    });
    await streamWorkModeReasoningComposer(text, signal, { turnContext });
    const mdAfterHelp = getLatestWorkModeReasoningMarkdown();
    if (mdAfterHelp && /#{1,6}\s*SYNC CHECKLIST\b/i.test(mdAfterHelp)) {
      const rows = buildChecklistProposalFromMarkdown(mdAfterHelp);
      const activeLaneId = getActiveDomReasoningLaneId();
      const panelMeta = getPlanSyncPanelMetaForLane(activeLaneId);
      workChecklistSyncPlanVersion += 1;
      workChecklistSyncPendingMarkdown = mdAfterHelp;
      workChecklistSyncPendingPlanMeta = {
        ...panelMeta,
        source: "checklist_help_plan",
        created_at: Date.now()
      };
      logPlanSyncDebug("created", {
        lane_id: panelMeta.lane_id || null,
        panel_id: panelMeta.panel_id || null,
        panel_title: panelMeta.panel_title || "",
        active_panel_id: panelMeta.active_panel_id || null,
        is_plan_detected: true,
        syncable: rows.length > 0,
        has_sync_metadata: true,
        sync_candidate_count: rows.length,
        sync_candidates_preview: planSyncPreviewRows(rows),
        reason_if_not_syncable: rows.length ? "" : "no_checklist_candidates_extracted",
        response_kind: "sync_checklist_markdown",
        route_kind: "checklist_help_plan",
        source: "checklist_shortcut"
      });
      syncWorkChecklistSyncPlanButton();
    }
  } finally {
    workChecklistPlanRequestInFlight = false;
    syncWorkChecklistHelpPlanButton();
  }
  return true;
}

async function maybeHandleWorkChecklistPlanShortcut(text, signal) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return false;
  if (!isWorkChecklistPlanShortcutIntent(text)) return false;
  await runWorkChecklistHelpPlan({ signal });
  return true;
}

function queueWorkChecklistRowEnterAnimation(ulId, taskId) {
  const sid = String(taskId || "");
  if (!sid || !ulId) return;
  const run = () => {
    const ul = document.getElementById(ulId);
    if (!ul) return;
    const esc =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(sid)
        : sid.replace(/["\\]/g, "");
    const moved = ul.querySelector(`:scope > li[data-id="${esc}"]`);
    if (!(moved instanceof HTMLElement)) return;
    moved.classList.add("vera-wm-checklist-li-entering");
    const done = () => {
      moved.removeEventListener("animationend", done);
      moved.classList.remove("vera-wm-checklist-li-entering");
    };
    moved.addEventListener("animationend", done, { once: true });
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(run));
}

function wireWorkModeChecklistAndComposer() {
  ensureWorkChecklistListDnD();
  wireWorkChecklistCompletedCollapse();
  wireWorkModeLeftPaneLayout();
  applyWorkModeLeftPaneLayoutFromStorage();
  wireWorkModeReasoningAttachWrap();
  const rs = document.getElementById("vera-reasoning-send");
  const cancelBtn = document.getElementById("vera-reasoning-cancel");
  const ri = document.getElementById("vera-reasoning-input");
  const attachBtn = document.getElementById("vera-reasoning-attach-btn");
  const fileInput = document.getElementById("vera-reasoning-file");
  attachBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    const list = fileInput.files ? Array.from(fileInput.files) : [];
    if (list.length) addWorkModeReasoningAttachmentFiles(list);
    fileInput.value = "";
  });

  const compose = document.querySelector(".vera-reasoning-compose");
  compose?.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  compose?.addEventListener("drop", (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt?.files?.length) return;
    addWorkModeReasoningAttachmentFiles(Array.from(dt.files));
  });

  const submitWorkModeReasoningComposer = async () => {
    const rawT = ri?.value ?? "";
    const t = rawT.trim();
    const files = getWorkModePendingAttachmentFiles();
    if (!t && !files.length) return;
    if (!isVeraWorkModeOn()) return;
    /* Safety: reasoning composer gets the larger workReasoning cap.
       Length check runs before the hard-cap so users see the proper reason. */
    if (t) {
      const modeBeforeSubmit = appModePrefix();
      const workModeBeforeSubmit = isVeraWorkModeOn();
      const lenBlock = veraCheckTypedInputLength(rawT, "work_reasoning", "keyboard");
      if (lenBlock) {
        logInputLimitDebug({
          raw_char_count: rawT.length,
          estimated_tokens: lenBlock.estimated_tokens,
          input_surface: "work_mode_reasoning_composer",
          active_mode_before_submit: modeBeforeSubmit,
          work_mode_enabled_before_submit: workModeBeforeSubmit,
          selected_limit: lenBlock.char_limit,
          blocked: true,
          block_reason: lenBlock.reason,
          route_attempted: false,
          backend_call_attempted: false,
          reasoning_panel_started: false,
          work_mode_enabled_after_submit: isVeraWorkModeOn(),
          did_toggle_work_mode: workModeBeforeSubmit !== isVeraWorkModeOn(),
          function_that_changed_work_mode: ""
        });
        veraShowSafetyFailureBubble(lenBlock.message);
        veraSetSafetyStatus("Reasoning prompt too long — shorten or upload as a file");
        preserveComposerAttachments("typed_length_cap_reached", null);
        return;
      }
    }
    if (isWorkModeTypedTurnAtHardCap()) {
      setStatus("Wait for VERA response before sending more", "idle");
      try {
        console.warn("[WorkMode] composer blocked at hard cap (reasoning-composer)", {
          pending: countPendingWorkModeTypedTurns(),
          max: WORK_MODE_TYPED_PENDING_MAX
        });
      } catch (_) {}
      return;
    }
    logComposerAttachmentsBeforeSubmit(files, null);
    if (ri) ri.value = "";
    try {
      const path = files.length ? "reasoning-composer-upload" : "reasoning-composer";
      await sendVeraWorkModeTypedInferTurn(t, { path });
    } catch (err) {
      preserveComposerAttachments("composer_submit_throw", null);
      console.warn("[WorkMode] reasoning composer", err);
    } finally {
      closeWorkModeAttachmentPreviewModal();
      setWorkModeAttachmentMeta("");
    }
  };

  rs?.addEventListener("click", () => {
    void submitWorkModeReasoningComposer();
  });
  cancelBtn?.addEventListener("click", () => {
    const activeIdx = getActiveReasoningLaneIndex();
    if (activeIdx == null) return;
    cancelWorkModeReasoningLane(activeIdx);
  });
  syncWorkModeReasoningCancelButton();
  ri?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void submitWorkModeReasoningComposer();
  });
  ri?.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    if (!cd?.items?.length) return;
    const imageFiles = [];
    for (const item of cd.items) {
      if (!item || item.kind !== "file") continue;
      if ((item.type || "").startsWith("image/")) {
        const bf = item.getAsFile();
        if (bf) imageFiles.push(bf);
      }
    }
    if (!imageFiles.length) return;
    const stamped = imageFiles.map((imf, i) => {
      const ext = (imf.type || "").includes("png")
        ? "png"
        : (imf.type || "").includes("webp")
          ? "webp"
          : "jpg";
      return new File([imf], `pasted-image-${Date.now()}-${i}.${ext}`, {
        type: imf.type || "image/png"
      });
    });
    const ok = addWorkModeReasoningAttachmentFiles(stamped) > 0;
    if (ok) e.preventDefault();
  });

  const ongoingUlPlan = document.getElementById("vera-wm-checklist-ongoing");
  if (ongoingUlPlan && ongoingUlPlan.dataset.helpPlanInput !== "1") {
    ongoingUlPlan.dataset.helpPlanInput = "1";
    ongoingUlPlan.addEventListener("input", () => {
      syncWorkChecklistHelpPlanButton();
    });
  }

  const eraseAllBtn = document.getElementById("vera-wm-checklist-erase-all");
  if (eraseAllBtn && eraseAllBtn.dataset.wiredEraseAll !== "1") {
    eraseAllBtn.dataset.wiredEraseAll = "1";
    eraseAllBtn.addEventListener("click", () => {
      eraseEntireWorkChecklist();
    });
  }
  const helpPlanBtn = document.getElementById("vera-wm-checklist-help-plan");
  if (helpPlanBtn && helpPlanBtn.dataset.wiredHelpPlan !== "1") {
    helpPlanBtn.dataset.wiredHelpPlan = "1";
    helpPlanBtn.addEventListener("click", async () => {
      try {
        await runWorkChecklistHelpPlan();
      } catch (err) {
        console.warn("[WorkMode] help me plan", err);
      }
    });
  }
  const syncPlanBtn = document.getElementById("vera-wm-checklist-sync-plan");
  const syncCancelBtn = document.getElementById("vera-wm-checklist-sync-cancel");
  const syncEditBtn = document.getElementById("vera-wm-checklist-sync-edit");
  const syncAcceptBtn = document.getElementById("vera-wm-checklist-sync-accept");
  const syncTextarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  if (syncPlanBtn && syncPlanBtn.dataset.wiredSyncPlan !== "1") {
    syncPlanBtn.dataset.wiredSyncPlan = "1";
    syncPlanBtn.addEventListener("click", () => {
      runWorkChecklistSyncFromLatestPlan();
    });
  }
  if (syncCancelBtn && syncCancelBtn.dataset.wiredSyncCancel !== "1") {
    syncCancelBtn.dataset.wiredSyncCancel = "1";
    syncCancelBtn.addEventListener("click", () => {
      hideWorkChecklistSyncPreview();
      flashWorkChecklistPlanHint("Checklist update canceled.");
    });
  }
  if (syncEditBtn && syncEditBtn.dataset.wiredSyncEdit !== "1") {
    syncEditBtn.dataset.wiredSyncEdit = "1";
    syncEditBtn.addEventListener("click", () => {
      setWorkChecklistSyncPreviewEditing(!workChecklistSyncPreviewEditing);
    });
  }
  if (syncAcceptBtn && syncAcceptBtn.dataset.wiredSyncAccept !== "1") {
    syncAcceptBtn.dataset.wiredSyncAccept = "1";
    syncAcceptBtn.addEventListener("click", () => {
      applyWorkChecklistSyncPreview();
    });
  }
  if (syncTextarea instanceof HTMLTextAreaElement && syncTextarea.dataset.wiredSyncTextarea !== "1") {
    syncTextarea.dataset.wiredSyncTextarea = "1";
    syncTextarea.addEventListener("click", () => {
      if (!workChecklistSyncPreviewEditing) setWorkChecklistSyncPreviewEditing(true);
    });
  }
  syncWorkChecklistEraseButton();
  syncWorkChecklistHelpPlanButton();
  syncWorkChecklistSyncPlanButton();
  wireWorkModeGlobalImagePaste();
}

function wireWorkModeGlobalImagePaste() {
  if (window.__veraWorkModeGlobalImagePaste === "1") return;
  window.__veraWorkModeGlobalImagePaste = "1";
  document.addEventListener(
    "paste",
    (e) => {
      if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
      const t = e.target;
      if (t instanceof Node && t instanceof HTMLElement) {
        if (t.closest("#vera-reasoning-input, #vera-reasoning-compose, #vera-reasoning-file")) return;
        if (
          t instanceof HTMLInputElement ||
          t instanceof HTMLTextAreaElement ||
          (typeof t.isContentEditable === "boolean" && t.isContentEditable)
        ) {
          return;
        }
      }
      const cd = e.clipboardData;
      if (!cd?.items?.length) return;
      const imageFiles = [];
      for (const item of cd.items) {
        if (!item || item.kind !== "file") continue;
        if ((item.type || "").startsWith("image/")) {
          const bf = item.getAsFile();
          if (bf) imageFiles.push(bf);
        }
      }
      if (!imageFiles.length) return;
      const stamped = imageFiles.map((imf, i) => {
        const ext = (imf.type || "").includes("png")
          ? "png"
          : (imf.type || "").includes("webp")
            ? "webp"
            : "jpg";
        return new File([imf], `pasted-image-${Date.now()}-${i}.${ext}`, {
          type: imf.type || "image/png"
        });
      });
      if (addWorkModeReasoningAttachmentFiles(stamped) < 1) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
}

wireWorkModeChecklistAndComposer();
loadWorkChecklistItems();
window.loadWorkModeChecklist = loadWorkChecklistItems;
window.hydrateWorkModeChecklistFromServer = hydrateWorkChecklistFromServer;
migrateLegacyVeraChatStorageKey();
restoreVeraChatState();
wireReasoningTabStrip();

let veraHeaderDateTimeTimer = null;

function stopVeraHeaderDateTime() {
  if (veraHeaderDateTimeTimer) {
    clearInterval(veraHeaderDateTimeTimer);
    veraHeaderDateTimeTimer = null;
  }
}

function wireVeraHeaderDateTime() {
  const timeEl = document.getElementById("vera-datetime-time");
  const dateEl = document.getElementById("vera-datetime-date");
  if (!timeEl || !dateEl) return;
  stopVeraHeaderDateTime();
  const tick = () => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
    dateEl.textContent = now.toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    updateWorkModeTimerHeaderFromState();
  };
  tick();
  veraHeaderDateTimeTimer = setInterval(tick, 1000);
}

/** Clock pill is work-mode only; stops the interval when leaving work mode. */
function syncVeraHeaderDateTimeForWorkMode() {
  const work = document.getElementById("vera-app")?.classList.contains("work-mode");
  if (!work) {
    stopVeraHeaderDateTime();
    return;
  }
  wireVeraHeaderDateTime();
}

window.syncVeraHeaderDateTimeForWorkMode = syncVeraHeaderDateTimeForWorkMode;

function onSidePaneClick(event) {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest(".side-pane-close")) {
    hideSidePanel();
    return;
  }

  if (target instanceof HTMLElement) {
    const tabButton = target.closest(".side-pane-tab");
    if (tabButton instanceof HTMLButtonElement) {
      setActiveSidePaneTab(tabButton.dataset.tab || "news");
    }
  }
}

["vera-side-pane", "bmo-side-pane"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", onSidePaneClick);
});

function isFlowModeSidePaneCrossfadeEnabled() {
  try {
    if (appModePrefix() === "vera" && document.getElementById("vera-app")?.classList.contains("work-mode")) {
      return false;
    }
  } catch {}
  return true;
}

/**
 * When the side pane is already visible, swap inner content with a short fade (music ↔ news / finance)
 * so innerHTML replacement does not fight the panel slide-in transition.
 */
function runFlowModeSidePaneContentCrossfade(sidePaneEl, renderCallback) {
  if (
    !sidePaneEl ||
    !isFlowModeSidePaneCrossfadeEnabled() ||
    sidePaneEl.hidden ||
    !sidePaneEl.classList.contains("visible")
  ) {
    renderCallback();
    return;
  }

  let outDone = false;
  let fallbackOut = null;
  const finishOut = () => {
    if (outDone) return;
    outDone = true;
    if (fallbackOut != null) window.clearTimeout(fallbackOut);
    sidePaneEl.removeEventListener("transitionend", onOutEnd);
    renderCallback();
    window.requestAnimationFrame(() => {
      sidePaneEl.classList.remove("side-pane-swap-hiding");
      sidePaneEl.classList.add("side-pane-swap-in");
      let fallbackIn = null;
      function clearIn() {
        if (fallbackIn != null) window.clearTimeout(fallbackIn);
        sidePaneEl.removeEventListener("animationend", onInEnd);
        sidePaneEl.classList.remove("side-pane-swap-in");
      }
      function onInEnd(ev) {
        const n = String(ev.animationName || "");
        if (!n.includes("side-pane-content-swap-in")) return;
        clearIn();
      }
      sidePaneEl.addEventListener("animationend", onInEnd);
      fallbackIn = window.setTimeout(clearIn, 480);
    });
  };

  const onOutEnd = (ev) => {
    if (ev.target !== sidePaneEl) return;
    if (ev.propertyName !== "opacity" && ev.propertyName !== "filter") return;
    finishOut();
  };

  sidePaneEl.classList.add("side-pane-swap-hiding");
  sidePaneEl.addEventListener("transitionend", onOutEnd);
  fallbackOut = window.setTimeout(finishOut, 420);
}

/** NDJSON can call ``applyActionPayload`` from ``finalizeNdjsonStreamingReply`` before first audio and again from ``onPlayStart`` — duplicate Spotify starts / skips twitch the UI. */
function musicPlaybackDedupeKey(payload, op) {
  if (!payload || payload.panel_type !== "music_control") return "";
  if (op === "play_track" && payload.uri) return `play_track:${String(payload.uri).trim()}`;
  if (op === "play_album" && payload.uri) return `play_album:${String(payload.uri).trim()}`;
  if (op === "play_playlist_by_name") {
    const n = String(payload.playlist_name || "").trim().toLowerCase();
    if (n) return `play_playlist_by_name:${n}`;
  }
  if (op === "play_builtin") {
    const p = String(payload.playlist_id || "").trim().toLowerCase();
    const s = String(payload.sound_id || "").trim().toLowerCase();
    if (p) return `play_builtin:pl:${p}`;
    if (s) return `play_builtin:snd:${s}`;
  }
  return "";
}

function isRecentSameMusicPlay(payload, op) {
  const key = musicPlaybackDedupeKey(payload, op);
  if (!key) return false;
  const prev = window.__veraMusicPlaybackDedupe;
  return !!(prev && prev.key === key && performance.now() - prev.at < 7000);
}

/** Collapse NDJSON double ``applyActionPayload`` (finalize + first audio) for skip only — short window so real repeat skips still work. */
function shouldApplyMusicTransportAction(payload, op) {
  if (op !== "skip_next" && op !== "skip_previous") return true;
  const key = `music_transport:${op}`;
  const now = performance.now();
  const prev = window.__veraMusicTransportDedupe;
  if (prev && prev.key === key && now - prev.at < 900) {
    if (op === "skip_previous") {
      console.log("[MUSIC][SKIP_PREV] dedupe-drop", { delta_ms: Math.round(now - prev.at) });
    }
    return false;
  }
  window.__veraMusicTransportDedupe = { key, at: now };
  return true;
}

function invokeSpotifyTransport(op, { source = "unknown" } = {}) {
  const fn =
    op === "skip_previous"
      ? window.VeraSpotify?.skipPrevious
      : op === "skip_next"
      ? window.VeraSpotify?.skipNext
      : null;
  if (typeof fn !== "function") {
    console.log("[MUSIC][TRANSPORT] missing-handler", { op, source });
    return false;
  }
  console.log("[MUSIC][TRANSPORT] invoke", { op, source });
  void fn();
  return true;
}

function builtinMusicTransportSkipNext(prefix) {
  const st = window.__veraFreeMusicPlayback;
  if (st?.mode === "playlist" && st.queue?.length > 1) {
    const next = ((Number(st.index) || 0) + 1) % st.queue.length;
    void freeMusicPlayQueueIndex(prefix, next);
    return true;
  }
  return false;
}

function builtinMusicTransportSkipPrevious(prefix) {
  const st = window.__veraFreeMusicPlayback;
  const a = document.getElementById(`${prefix}-free-music-audio`);
  if (st?.mode === "playlist" && st.queue?.length > 1) {
    const pos = Math.round((a?.currentTime || 0) * 1000);
    if (pos > SPOTIFY_PREVIOUS_RESTART_MS && a) {
      a.currentTime = 0;
      freeMusicSyncNowFromAudio(prefix);
      return true;
    }
    const prev = ((Number(st.index) || 0) + st.queue.length - 1) % st.queue.length;
    void freeMusicPlayQueueIndex(prefix, prev);
    return true;
  }
  return false;
}

/** Returns false when the same play was already started a few seconds ago (NDJSON finalize + first-audio both call this). */
function shouldPlayMusicThisInvocation(payload, op) {
  const key = musicPlaybackDedupeKey(payload, op);
  if (!key) return true;
  const now = performance.now();
  const prev = window.__veraMusicPlaybackDedupe;
  if (prev && prev.key === key && now - prev.at < 7000) return false;
  window.__veraMusicPlaybackDedupe = { key, at: now };
  return true;
}

/** NDJSON may invoke ``applyActionPayload`` twice (finalize + first audio) — skip duplicate reasoning ops. */
function workModeReasoningDedupeKey(payload) {
  if (!payload || payload.panel_type !== "work_mode_reasoning") return "";
  const op = String(payload.op || "");
  if (op === "open_new") return `open_new:${Math.max(1, Number(payload.count) || 1)}`;
  if (op === "activate" && payload.panel_index != null) {
    return `activate:${Number(payload.panel_index)}`;
  }
  return "";
}

/**
 * Block server-driven reasoning tab activation when the user line refers to homework ordinals
 * ("second problem") rather than UI navigation ("second panel"). Mirrors
 * `should_block_reasoning_panel_activation_for_ordinal_problem` in actions/work_mode_reasoning.py.
 */
function shouldBlockOrdinalProblemLaneActivation(userText) {
  const s = String(userText || "").trim();
  if (!s) return false;
  const low = s.toLowerCase();
  if (/\b(?:reasoning\s+)?(?:panel|tab|lane)\b/i.test(low)) return false;
  if (/\breasoning\s+space\b/i.test(low)) return false;
  if (
    /\b(?:go\s+to|jump\s+to|switch\s+to|change\s+to|open|activate|show|select|use)\b[^.?!]{0,96}\b(?:reasoning\s+)?(?:panel|tab|lane|page)\b/i.test(
      low
    )
  ) {
    return false;
  }
  if (
    /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|next|previous|last|prior)\s+(?:reasoning\s+)?(?:panel|tab|lane|page)\b/i.test(
      low
    )
  ) {
    return false;
  }
  if (/\b(?:panel|tab)\s*#?\s*\d{1,2}\b/i.test(low)) return false;
  if (
    /\b(?:first|second|third|fourth|fifth|next|previous|last|prior|other|another)\s+(?:problem|question|part|exercise)\b/i.test(
      low
    )
  ) {
    return true;
  }
  if (/\b(?:next|another)\s+(?:problem|question|part)\b/i.test(low)) return true;
  if (/\bproblem\s*(?:#|no\.?|number\s*)?\s*\d/i.test(low)) return true;
  if (/\bproblem\s*(?:#|no\.?)?\s*\d+\.\d+/i.test(low)) return true;
  if (/\b(?:ex\.?|exercise|question|q)\s*[#.]?\s*\d+/i.test(low)) return true;
  if (/\bthe\s+other\s+(?:problem|question|part)\b/i.test(low)) return true;
  if (
    /\b(?:this|that|the)\s+assignment(?:'s|s)?\s+(?:first|second|third|fourth|next|last)\s+part\b/i.test(
      low
    )
  ) {
    return true;
  }
  if (/\bpart\s*\d+\b/i.test(low)) return true;
  return false;
}

function inferUserTextForLaneActivationGuard(data) {
  return String(
    data?.transcript || (typeof window !== "undefined" && window.__veraLastInferUserTextForLaneGuard) || ""
  ).trim();
}

function shouldApplyWorkModeReasoningInvocation(payload) {
  const key = workModeReasoningDedupeKey(payload);
  if (!key) return true;
  const now = performance.now();
  const prev = window.__veraWorkModeReasoningDedupe;
  if (prev && prev.key === key && now - prev.at < 8000) return false;
  window.__veraWorkModeReasoningDedupe = { key, at: now };
  return true;
}

function applyActionPayload(data) {
  const payload = data?.action_payload;
  const lockToMusicPanel =
    isVeraWorkModeOn() && appModePrefix() === "vera";

  if (
    lockToMusicPanel &&
    (payload?.panel_type === "media_tabs" ||
      payload?.panel_type === "news_results" ||
      payload?.panel_type === "finance_chart")
  ) {
    const sidePaneEl = uiEl("side-pane");
    if (sidePaneEl) {
      const hasProductivityMarkup =
        Boolean(sidePaneEl.innerHTML.trim()) && sidePaneEl.dataset.sidePaneKind === "productivity";
      if (hasProductivityMarkup) {
        if (sidePaneEl.hidden) restoreProductivityPanel("vera");
      } else {
        renderProductivityPanel();
      }
    }
    return;
  }

  if (payload?.panel_type === "media_tabs" || payload?.panel_type === "news_results") {
    /* Large innerHTML (news + images + video embeds) can block the main thread; defer so BMO mouth RAF keeps up. */
    requestAnimationFrame(() => renderMediaTabsPanel(payload));
    return;
  }

  if (payload?.panel_type === "finance_chart") {
    renderFinanceChartPanel(payload);
    return;
  }

  if (payload?.panel_type === "checklist_control") {
    try {
      markWorkChecklistLocalMutation();
      if (Array.isArray(payload.items)) {
        localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(payload.items));
      }
      if (typeof payload.completed_collapsed === "boolean") {
        localStorage.setItem(
          WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
          payload.completed_collapsed ? "1" : "0"
        );
      }
      loadWorkChecklistItems();
      syncWorkChecklistHelpPlanButton();
    } catch (_) {}
    return;
  }

  if (payload?.panel_type === "work_mode_reasoning") {
    if (!shouldApplyWorkModeReasoningInvocation(payload)) return;
    if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
    const op = payload.op || "";
    if (op === "open_new") {
      const count = Math.max(1, Math.min(REASONING_TABS_MAX, Number(payload.count) || 1));
      for (let i = 0; i < count; i += 1) addReasoningTab();
      return;
    }
    if (op === "activate" && payload.panel_index != null) {
      const idx = Number(payload.panel_index);
      if (!Number.isFinite(idx)) return;
      const guardText = inferUserTextForLaneActivationGuard(data);
      if (shouldBlockOrdinalProblemLaneActivation(guardText)) {
        console.info("[blocked_lane_activation]", {
          user_text: guardText,
          requested_panel_index: idx,
          reason: "ordinal_problem_not_tab_navigation"
        });
        return;
      }
      const panelEl = document.querySelector(
        `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
      );
      if (panelEl) activateReasoningTab(idx);
      return;
    }
    return;
  }

  if (payload?.panel_type === "music_control") {
    const prefix = appModePrefix();
    const op = payload.op || "open_panel";
    if (op === "close_panel") {
      hideSidePanel();
      return;
    }
    if (op === "skip_next") {
      if (!shouldApplyMusicTransportAction(payload, op)) return;
      if (getProductivityMusicSource(prefix) === "builtin") {
        builtinMusicTransportSkipNext(prefix);
        return;
      }
      invokeSpotifyTransport("skip_next", { source: "command" });
      return;
    }
    if (op === "skip_previous") {
      if (!shouldApplyMusicTransportAction(payload, op)) return;
      console.log("[MUSIC][SKIP_PREV] applyActionPayload dispatch", {
        source: data?.type || "unknown",
        has_payload: Boolean(payload),
      });
      if (getProductivityMusicSource(prefix) === "builtin") {
        builtinMusicTransportSkipPrevious(prefix);
        return;
      }
      invokeSpotifyTransport("skip_previous", { source: "command" });
      return;
    }
    if (op === "pause") {
      const free = document.getElementById(`${prefix}-free-music-audio`);
      if (free && !free.paused) free.pause();
      const pause = window.VeraSpotify?.pausePlayback;
      if (typeof pause === "function") void pause();
      if (free && getProductivityMusicSource(prefix) === "builtin") {
        freeMusicSyncNowFromAudio(prefix);
        spotifySyncPlayButtonUi(prefix);
      }
      return;
    }
    if (op === "resume") {
      if (getProductivityMusicSource(prefix) === "builtin") {
        const free = document.getElementById(`${prefix}-free-music-audio`);
        if (free?.src) {
          void free.play().then(() => {
            freeMusicSyncNowFromAudio(prefix);
            spotifySyncPlayButtonUi(prefix);
          });
          return;
        }
      }
      const resume = window.VeraSpotify?.resumePlayback;
      if (typeof resume === "function") void resume();
      return;
    }
    if (op === "volume_delta") {
      const cur = typeof window.VeraSpotify?.getVolume === "function"
        ? window.VeraSpotify.getVolume()
        : spotifyGetVolume();
      const setVolume = window.VeraSpotify?.setVolume;
      const next = Math.max(0, Math.min(SPOTIFY_VOLUME_MAX, Number(cur) + (Number(payload.delta) || 0)));
      if (typeof setVolume === "function") void setVolume(next);
      else {
        window.__veraSpotifyVolume = next;
        const free = document.getElementById(`${prefix}-free-music-audio`);
        if (free) free.volume = next;
        const preview = document.getElementById(`${prefix}-spotify-preview-audio`);
        if (preview) preview.volume = next;
      }
      return;
    }
    const skipPanelRepeat = isRecentSameMusicPlay(payload, op);
    const sidePaneEl = uiEl("side-pane");
    if (sidePaneEl && !skipPanelRepeat) {
      const hasProductivityMarkup =
        Boolean(sidePaneEl.innerHTML.trim()) && sidePaneEl.dataset.sidePaneKind === "productivity";
      document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));
      if (hasProductivityMarkup) {
        if (sidePaneEl.hidden) restoreProductivityPanel(prefix);
      } else {
        renderProductivityPanel();
      }
      document.getElementById(`${prefix}-productivity-mode`)?.classList.add("is-active");
    }
    if (op === "play_builtin" && shouldPlayMusicThisInvocation(payload, op)) {
      void (async () => {
        const pfx = appModePrefix();
        await runBuiltinVoicePlayback(pfx, {
          playlistId: payload.playlist_id,
          soundId: payload.sound_id
        });
      })();
    } else if (op === "play_track" && payload.uri && shouldPlayMusicThisInvocation(payload, op)) {
      const play = window.VeraSpotify?.playTrack;
      if (typeof play === "function") {
        void play(String(payload.uri), {
          title: payload.title || "",
          artist: payload.artist || "",
          preview_url: payload.preview_url || "",
          open_url: payload.open_url || ""
        });
      }
    } else if (op === "play_album" && payload.uri && shouldPlayMusicThisInvocation(payload, op)) {
      const playCtx = window.VeraSpotify?.playPlaylist;
      if (typeof playCtx === "function") {
        void (async () => {
          const prefix = appModePrefix();
          const base = localBackendBase();
          const uri = String(payload.uri || "").trim();
          const title = payload.title || "";
          const artist = payload.artist || "";
          const sub = artist ? `"${title}" by "${artist}"` : `"${title}"`;
          const openUrl = String(payload.open_url || spotifyUriToOpenUrl(uri) || "").trim();
          const st = await fetch(`${base}/api/spotify/connection-status`, {
            credentials: "include",
            headers: { ...veraSpotifyAuthHeaders() }
          })
            .then((r) => (r.ok ? r.json() : { connected: false }))
            .catch(() => ({ connected: false }));
          const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
          if (st.connected) {
            await playCtx(uri, { playlist_name: title, context_subtitle: sub });
          } else if (openUrl) {
            window.open(openUrl, "_blank", "noopener,noreferrer");
            if (artistEl) {
              artistEl.textContent =
                `${artist ? `${artist} — ` : ""}Opened Spotify in a new tab (connect for in-page playback).`.trim();
            }
          } else if (artistEl) {
            artistEl.textContent = "Connect Spotify to play this album in VERA.";
          }
        })();
      }
    } else if (op === "play_playlist_by_name") {
      const rawName = String(payload.playlist_name || "").trim();
      if (rawName && shouldPlayMusicThisInvocation(payload, op)) {
        void (async () => {
          const prefix = appModePrefix();
          const built = matchBuiltinPlaylistOrSoundNameForClient(rawName);
          if (built) {
            await runBuiltinVoicePlayback(prefix, built);
            return;
          }
          const getLists = window.VeraSpotify?.getPlaylists;
          const playCtx = window.VeraSpotify?.playPlaylist;
          const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
          if (typeof getLists !== "function" || typeof playCtx !== "function") {
            if (artistEl) artistEl.textContent = "Playlist playback is not available.";
            return;
          }
          const lists = await getLists().catch(() => []);
          const needle = rawName.toLowerCase();
          let hit =
            lists.find((p) => String(p.name || "").toLowerCase() === needle) ||
            lists.find((p) => String(p.name || "").toLowerCase().includes(needle));
          if (!hit && needle.length >= 3) {
            hit = lists.find((p) => needle.includes(String(p.name || "").toLowerCase()));
          }
          if (!hit?.uri) {
            if (artistEl) artistEl.textContent = `No playlist in your library matched "${rawName}".`;
            return;
          }
          const disp = hit.name || rawName;
          await playCtx(hit.uri, {
            playlist_name: disp,
            context_subtitle: `"${disp}" in my playlist`
          });
        })();
      }
    }
    return;
  }

  /* Keep the music panel open across normal assistant replies unless a new panel payload replaces it. */
  const sidePaneEl = uiEl("side-pane");
  if (
    sidePaneEl &&
    !sidePaneEl.hidden &&
    sidePaneEl.dataset.sidePaneKind === "productivity"
  ) {
    return;
  }

  hideSidePanel();
}

/** News/finance side panel + assistant bubble — call when main reply audio actually starts (not when LLM JSON/meta arrives). */
function applyAssistantReplyAndPanels(data) {
  if (!data) return;
  if (data.work_mode_timer) {
    applyWorkModeTimerPayload(data.work_mode_timer);
  }
  applyActionPayload(data);
  if (data.reply == null || data.reply === "") return;
  // Real reply is taking over — drop the "Searching news…" placeholder
  // before the actual assistant bubble appears so the user only sees the
  // final answer (no double-bubble flash).
  cancelPendingNewsStatusBubble("assistant_reply_applied");
  addBubble(data.reply, "vera");
}

function createNdjsonStreamingReplyState(initialReplyBack = null, opts = {}) {
  return {
    bubble: null,
    latest: "",
    pendingVoiceQuote: replyBackQuoteText(initialReplyBack),
    pendingReplyBack: initialReplyBack,
    /** When true, ignore streamed reply_so_far until finalize sets the canonical line. */
    suppressReplyProgress: Boolean(opts.suppressReplyProgress),
    stage2EffectiveLocked: false
  };
}

/**
 * Grow one assistant bubble as each NDJSON chunk includes reply_so_far (sentence-cumulative text).
 */
function applyNdjsonStreamingReplySoFar(replySoFar, state) {
  if (replySoFar == null || replySoFar === "") return;
  if (state?.suppressReplyProgress || state?.stage2EffectiveLocked) return;
  state.latest = String(replySoFar);
  const convoEl = uiEl("conversation");
  if (!convoEl) return;
  const text = state.latest;
  if (state.bubble?.isConnected) {
    const cur = state.bubble.textContent || "";
    /* Done line can arrive before deferred first play; finalize may have filled the full reply — don't overwrite with a shorter cumulative partial. */
    if (text.length >= cur.length) {
      state.bubble.textContent = text;
    }
  } else {
    // Streaming reply is about to create the real bubble — drop the
    // "Searching news…" placeholder so they don't sit side-by-side.
    cancelPendingNewsStatusBubble("ndjson_reply_so_far");
    let opts = { path: "ndjson-reply-so-far" };
    if (state.pendingReplyBack) {
      opts = mergeReplyBackIntoBubbleMeta(opts, state.pendingReplyBack);
      state.pendingReplyBack = null;
      state.pendingVoiceQuote = null;
    }
    state.bubble = addBubble(text, "vera", opts);
  }
  convoEl.scrollTop = convoEl.scrollHeight;
  persistVeraChatState();
}

/** After NDJSON done: sync bubble to final reply, or add bubble if no streaming partials. */
function finalizeNdjsonStreamingReply(ndjsonMeta, done, state) {
  if (!done?.reply) return;
  const merged = {
    ...(ndjsonMeta && typeof ndjsonMeta === "object" ? ndjsonMeta : {}),
    ...done,
    reply: done.reply
  };
  if (
    !state.pendingReplyBack &&
    merged.work_mode_voice_brief_completion === true &&
    merged.work_mode_voice_quote != null &&
    String(merged.work_mode_voice_quote).trim()
  ) {
    const q = String(merged.work_mode_voice_quote).trim();
    if (q) {
      state.pendingVoiceQuote = q;
      state.pendingReplyBack = {
        reply_to_user_text: q,
        reply_to_turn_id: "",
        reply_to_lane_id: "",
        reply_to_lane_title: "",
        stage: 2
      };
    }
  }
  const pay = merged?.action_payload;
  const op = pay?.op;
  if (
    pay?.panel_type === "music_control" &&
    (op === "skip_next" || op === "skip_previous" || op === "play_builtin")
  ) {
    applyActionPayload(merged);
  }
  /* Work Mode Stage 2: one bubble with reply-back is created via ensureStage2VoiceBubble after resolve. */
  if (state?.suppressReplyProgress) {
    state.latest = String(done.reply || "");
    state.stage2EffectiveLocked = true;
    persistVeraChatState();
    return;
  }
  if (state.bubble?.isConnected) {
    state.bubble.textContent = done.reply;
    state.stage2EffectiveLocked = true;
    persistVeraChatState();
    return;
  }
  /* Must assign state.bubble so applyNdjsonStreamingReplySoFar doesn't add a second bubble if done arrives before first audio (defer path). */
  applyActionPayload(merged);
  // Streaming finalized without ever calling onReplyProgress (no partials),
  // so we drop the pending bubble here just before creating the final one.
  cancelPendingNewsStatusBubble("ndjson_finalize");
  let finOpts = { path: "ndjson-final" };
  if (state.pendingReplyBack) {
    finOpts = mergeReplyBackIntoBubbleMeta(finOpts, state.pendingReplyBack);
    state.pendingReplyBack = null;
    state.pendingVoiceQuote = null;
  }
  state.bubble = addBubble(done.reply, "vera", finOpts);
  state.stage2EffectiveLocked = true;
  persistVeraChatState();
}

/** Stops TTS and resets interrupt UI counters (shared by heuristic + browser barge-in). */
function cancelBrowserInterruptTtsOnly() {
  setStatus("Listening… (interrupted)", "recording");
  resetAudioHandlers();
  cancelMainTtsPlayback();
  const a = getAudioEl();
  if (a) {
    a.pause();
    a.currentTime = 0;
  }
  listening = true;
  processing = false;
  waveState = "listening";
  interruptSpeechFrames = 0;
  interruptSpeechStart = 0;
  interruptSpeechAccumMs = 0;
  lastInterruptDetectTime = 0;
  interruptLastSpeechLikeTime = 0;
  lastInterruptSpeechLikeSnapshot = null;
  interruptLastVoiceTime = performance.now();
}

function promoteInterruptPreviewToMainLiveBubble() {
  if (interruptDetectionBubbleEl?.isConnected) {
    mainBrowserLiveBubble = interruptDetectionBubbleEl;
    interruptDetectionBubbleEl = null;
    try {
      mainBrowserLiveBubble.classList.remove("interrupt-preview");
    } catch (_) {}
  }
}

/**
 * Browser ASR: >2 words ⇒ stop TTS; keep the same SpeechRecognition session and use 1.3s stable transcript → LLM.
 * (Does not start a second recognition — that was the old post-interrupt listener.)
 */
function onBrowserInterruptBargeInFromDetect(event) {
  if (interruptBargeInLatched) return;
  interruptBargeInLatched = true;
  cancelBrowserInterruptTtsOnly();
  promoteInterruptPreviewToMainLiveBubble();
  mainBrowserFinalizeKind = "interrupt";

  let interimBuf = "";
  let finalP = "";
  for (let i = 0; i < event.results.length; i++) {
    const r = event.results[i];
    if (r.isFinal) {
      const piece = r[0].transcript;
      finalP += piece;
      logPartialAsrSegmentFinal(piece.trim(), { mode: "interrupt-barge" });
    } else {
      interimBuf += r[0].transcript;
    }
  }
  mainBrowserFinalTranscript = finalP;
  mainBrowserLastInterim = interimBuf;
  const _wasSpokenInterruptOnResult = hasSpoken;
  hasSpoken =
    mainBrowserFinalTranscript.trim().length > 0 || interimBuf.trim().length > 0;
  if (hasSpoken && !_wasSpokenInterruptOnResult) {
    armVoiceMaxDurationTimer("browser_asr_first_partial_interrupt");
  }
  if (hasSpoken && speechWaitTimeoutId != null) {
    clearTimeout(speechWaitTimeoutId);
    speechWaitTimeoutId = null;
  }
  updateMainBrowserLiveBubble(mainBrowserFinalTranscript, interimBuf);
  scheduleMainBrowserEndOfUtterance();
}

function interruptSpeech() {
  if (listeningMode !== "continuous") return;
  const useBrowserAsr = browserAsrPreferred();
  if (!interruptRecording && !useBrowserAsr) return;
  const a = getAudioEl();
  const htmlPlaying = a && !a.paused;
  const webTtsPlaying =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  if (!htmlPlaying && !webTtsPlaying) return;

  cancelBrowserInterruptTtsOnly();

  if (interruptRecording) {
    requestAnimationFrame(detectInterruptSpeechEnd);
  } else if (useBrowserAsr) {
    /* No MediaRecorder interrupt path: start dedicated post-interrupt SR (e.g. phone Chrome edge cases). */
    promoteInterruptPreviewToMainLiveBubble();
    startPostInterruptBrowserRecognition();
  }
}

function detectInterrupt() {
  if (!analyser) {
    requestAnimationFrame(detectInterrupt);
    return;
  }

  /*
   * Desktop + browser ASR: while interrupt-detect SpeechRecognition is alive, barge-in is word-count only.
   * If start() failed or onend fired, fall back to heuristic so TTS is still interruptible (no silent failure).
   */
  if (
    browserAsrPreferred() &&
    !isNarrowViewport() &&
    interruptDetectRecognition
  ) {
    requestAnimationFrame(detectInterrupt);
    return;
  }

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  // RMS
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  // ZCR (voicing) + crest (reject single sharp transients from bumps/clicks)
  const zcr = computeZCR(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const crest = peak / (rms + 1e-8);

  const now = performance.now();

  // Only interrupt while main TTS is playing: single-file uses <audio>; chunked/streaming uses Web Audio BufferSources.
  const outAudio = getAudioEl();
  const htmlAudioPlaying = outAudio && !outAudio.paused;
  const webAudioMainTtsPlaying =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  if (
  listeningMode === "continuous" &&
  (htmlAudioPlaying || webAudioMainTtsPlaying)
) {
    // grace period to avoid clicks
    if (now - audioStartedAt > 200) {
      const dtRaw = lastInterruptDetectTime ? now - lastInterruptDetectTime : 0;
      const dt = Math.min(Math.max(dtRaw, 0), 80);
      lastInterruptDetectTime = now;

      const heuristicChecks = computeHeuristicInterruptChecks(rms, zcr, crest);
      const speechLike = heuristicChecks.passes;

      if (speechLike) {
        interruptSpeechAccumMs += dt;
        if (interruptSpeechFrames === 0) {
          interruptSpeechStart = now;
        }
        interruptSpeechFrames++;
        interruptLastSpeechLikeTime = now;
        lastInterruptSpeechLikeSnapshot = {
          rms,
          zcr,
          crest,
          heuristicChecks,
          at: now,
        };
      } else if (
        interruptLastSpeechLikeTime &&
        now - interruptLastSpeechLikeTime <= INTERRUPT_GAP_RESET_MS
      ) {
        // Allow tiny gaps so normal speech doesn't need a perfect uninterrupted stream (time here does not add to interruptSpeechAccumMs).
      } else {
        interruptSpeechFrames = 0;
        interruptSpeechStart = 0;
        interruptSpeechAccumMs = 0;
        interruptLastSpeechLikeTime = 0;
        lastInterruptSpeechLikeSnapshot = null;
      }

      if (
        speechLike &&
        interruptSpeechFrames >= INTERRUPT_MIN_FRAMES &&
        interruptSpeechAccumMs >= getInterruptSustainMs()
      ) {
        const gate = "heuristic";
        const snap = lastInterruptSpeechLikeSnapshot;
        logInterruptTriggerReason({
          gate,
          triggerFrame: { rms, zcr, crest, speechLike },
          lastSpeechLike: snap,
          speechAccumMs: interruptSpeechAccumMs,
          wallMsSinceFirstSpeech: interruptSpeechStart
            ? now - interruptSpeechStart
            : 0,
          rafFrames: interruptSpeechFrames,
        });
        lastInterruptProbe = {
          atTrigger: { rms, zcr, crest, speechLike },
          lastSpeechLike: snap,
          interruptGate: gate,
          interruptReason: "heuristic",
          heuristicChecks: snap?.heuristicChecks ?? heuristicChecks,
          speechAccumMs: interruptSpeechAccumMs,
          wallMsSinceFirstSpeech: interruptSpeechStart
            ? now - interruptSpeechStart
            : 0,
          frames: interruptSpeechFrames,
        };
        interruptSpeech();
        interruptSpeechFrames = 0;
        interruptSpeechStart = 0;
        interruptSpeechAccumMs = 0;
        interruptLastSpeechLikeTime = 0;
        lastInterruptSpeechLikeSnapshot = null;
      }

      if (
        MOBILE_VAD_DEBUG &&
        now - lastMobileVadSampleLogAt >= MOBILE_VAD_SAMPLE_INTERVAL_MS
      ) {
        lastMobileVadSampleLogAt = now;
        pushMobileInterruptVadLog(
          `vad rms=${rms.toFixed(4)} zcr=${zcr.toFixed(4)} crest=${crest.toFixed(2)} like=${speechLike} acc=${interruptSpeechAccumMs.toFixed(0)}ms thr=${getInterruptSustainMs()}ms`
        );
      }
    }
  } else {
    interruptSpeechFrames = 0;
    interruptSpeechStart = 0;
    interruptSpeechAccumMs = 0;
    lastInterruptDetectTime = 0;
    interruptLastSpeechLikeTime = 0;
    lastInterruptSpeechLikeSnapshot = null;
  }

  requestAnimationFrame(detectInterrupt);
}

function resetAudioHandlers() {
  const a = getAudioEl();
  if (a) {
    a.onplay = null;
    a.onended = null;
  }
}

let interruptLastVoiceTime = 0;

function detectInterruptSpeechEnd() {
  if (!interruptRecording || interruptRecorder?.state !== "recording") return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  const now = performance.now();

  if (listeningFrameIsSpeechLike(buf, rms)) {
    interruptLastVoiceTime = now;
  }

  if (
    interruptLastVoiceTime &&
    now - interruptLastVoiceTime > SILENCE_MS
  ) {
    interruptRecorder.stop(); // ✅ NOW stop
    interruptRecording = false;
    return;
  }

  requestAnimationFrame(detectInterruptSpeechEnd);
}

function computeZCR(buf) {
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] >= 0 && buf[i] < 0) ||
        (buf[i - 1] < 0 && buf[i] >= 0)) {
      crossings++;
    }
  }
  return crossings / buf.length;
}

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

/** Per-threshold flags for interrupt (RMS/ZCR/crest); all must pass for a frame to count as speech-like. */
function computeHeuristicInterruptChecks(rms, zcr, crest) {
  const rmsAboveMin = rms > INTERRUPT_RMS;
  const rmsBelowMax = rms < MAX_SPEECH_RMS;
  const zcrInRange = zcr >= INTERRUPT_ZCR_MIN && zcr <= INTERRUPT_ZCR_MAX;
  const crestOk = crest <= INTERRUPT_MAX_CREST;
  return {
    rmsAboveMin,
    rmsBelowMax,
    zcrInRange,
    crestOk,
    passes:
      rmsAboveMin && rmsBelowMax && zcrInRange && crestOk,
  };
}

function logInterruptTriggerReason({
  gate,
  triggerFrame,
  lastSpeechLike,
  speechAccumMs,
  wallMsSinceFirstSpeech,
  rafFrames,
}) {
  const base = {
    gate,
    speechAccumMs: Number(speechAccumMs.toFixed(1)),
    wallMsSinceFirstSpeech: Number(wallMsSinceFirstSpeech.toFixed(1)),
    rafFrames,
    triggerKind: `speech_frame (accumulated speechLike time ≥ ${getInterruptSustainMs()}ms)`,
    triggerFrame: {
      rms: Number(triggerFrame.rms.toFixed(5)),
      zcr: Number(triggerFrame.zcr.toFixed(5)),
      crest: Number(triggerFrame.crest.toFixed(4)),
      speechLike: triggerFrame.speechLike,
    },
  };
  const h =
    lastSpeechLike?.heuristicChecks ??
    computeHeuristicInterruptChecks(
      lastSpeechLike?.rms ?? triggerFrame.rms,
      lastSpeechLike?.zcr ?? triggerFrame.zcr,
      lastSpeechLike?.crest ?? triggerFrame.crest
    );
  const checks = [];
  if (h.rmsAboveMin) checks.push("rms_min");
  if (h.rmsBelowMax) checks.push("rms_max");
  if (h.zcrInRange) checks.push("zcr");
  if (h.crestOk) checks.push("crest");
  console.log(
    "[INTERRUPT] trigger — heuristic (RMS/ZCR/crest + sustain; all must pass on speech frames)",
    {
      ...base,
      lastSpeechLike: lastSpeechLike
        ? {
            rms: Number(lastSpeechLike.rms.toFixed(5)),
            zcr: Number(lastSpeechLike.zcr.toFixed(5)),
            crest: Number(lastSpeechLike.crest.toFixed(4)),
            heuristicChecks: checks.join("+"),
            flags: {
              rmsAboveMin: h.rmsAboveMin,
              rmsBelowMax: h.rmsBelowMax,
              zcrInRange: h.zcrInRange,
              crestOk: h.crestOk,
            },
          }
        : null,
    }
  );
  pushMobileInterruptVadLog(
    `[INTERRUPT] gate=${gate} accumMs=${speechAccumMs.toFixed(1)} rms=${triggerFrame.rms.toFixed(5)} zcr=${triggerFrame.zcr.toFixed(5)} crest=${triggerFrame.crest.toFixed(4)} checks=${checks.join("+")}`
  );
}

function pushMobileInterruptVadLog(msg) {
  if (!MOBILE_VAD_DEBUG) return;
  const t = new Date().toISOString().slice(11, 23);
  interruptVadLogLines.push(`[${t}] ${msg}`);
  if (interruptVadLogLines.length > INTERRUPT_VAD_LOG_MAX) {
    interruptVadLogLines.splice(0, interruptVadLogLines.length - INTERRUPT_VAD_LOG_MAX);
  }
  renderMobileInterruptVadLogs();
}

function renderMobileInterruptVadLogs() {
  const text = interruptVadLogLines.join("\n");
  const p1 = document.getElementById("vera-interrupt-debug-pre");
  const p2 = document.getElementById("bmo-interrupt-debug-pre");
  if (p1) p1.textContent = text;
  if (p2) p2.textContent = text;
}

function toggleInterruptDebugPanel(prefix) {
  const panel = document.getElementById(`${prefix}-interrupt-debug-panel`);
  const btn = document.getElementById(`${prefix}-interrupt-debug-toggle`);
  const headerBtn = document.getElementById(`${prefix}-interrupt-debug-header`);
  if (!panel) return;
  const opening = panel.hidden;
  panel.hidden = !opening;
  const expanded = opening ? "true" : "false";
  btn?.setAttribute("aria-expanded", expanded);
  headerBtn?.setAttribute("aria-expanded", expanded);
  if (opening) {
    requestAnimationFrame(() => {
      panel.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }
}

function injectMobileVadLogUiIfNeeded() {
  if (!MOBILE_VAD_DEBUG) return;
  document.body.classList.add("vad-log-mode");

  const veraHeader = document.querySelector("#vera-app .vera-app-header");
  const veraOpenBmo = document.getElementById("open-bmo-from-vera");
  if (veraHeader && veraOpenBmo && !document.getElementById("vera-interrupt-debug-header")) {
    const wrap = document.createElement("div");
    wrap.className = "vera-header-actions";
    const vadBtn = document.createElement("button");
    vadBtn.type = "button";
    vadBtn.id = "vera-interrupt-debug-header";
    vadBtn.className = "interrupt-debug-header-btn";
    vadBtn.setAttribute("aria-controls", "vera-interrupt-debug-panel");
    vadBtn.textContent = "VAD log";
    veraOpenBmo.parentNode.insertBefore(wrap, veraOpenBmo);
    wrap.appendChild(vadBtn);
    wrap.appendChild(veraOpenBmo);
  }

  const bmoHeader = document.querySelector("#bmo-page .bmo-chat-header");
  if (bmoHeader && !document.getElementById("bmo-interrupt-debug-header")) {
    const vadBtn = document.createElement("button");
    vadBtn.type = "button";
    vadBtn.id = "bmo-interrupt-debug-header";
    vadBtn.className = "interrupt-debug-header-btn";
    vadBtn.setAttribute("aria-controls", "bmo-interrupt-debug-panel");
    vadBtn.textContent = "VAD log";
    bmoHeader.appendChild(vadBtn);
  }

  function buildExtender(prefix) {
    const wrap = document.createElement("div");
    wrap.className = "interrupt-debug-extender";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = `${prefix}-interrupt-debug-toggle`;
    toggle.className = "interrupt-debug-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", `${prefix}-interrupt-debug-panel`);
    toggle.textContent = "Interrupt / VAD log";
    const panel = document.createElement("div");
    panel.id = `${prefix}-interrupt-debug-panel`;
    panel.className = "interrupt-debug-panel";
    panel.hidden = true;
    const pre = document.createElement("pre");
    pre.id = `${prefix}-interrupt-debug-pre`;
    pre.className = "interrupt-debug-pre";
    pre.setAttribute("aria-live", "polite");
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.id = `${prefix}-interrupt-debug-clear`;
    clearBtn.className = "interrupt-debug-clear";
    clearBtn.textContent = "Clear";
    panel.appendChild(pre);
    panel.appendChild(clearBtn);
    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    return wrap;
  }

  const veraIc = document.querySelector("#vera-app .input-container");
  if (veraIc && !document.getElementById("vera-interrupt-debug-panel")) {
    veraIc.appendChild(buildExtender("vera"));
  }

  const bmoIc = document.querySelector("#bmo-page .input-container");
  if (bmoIc && !document.getElementById("bmo-interrupt-debug-panel")) {
    bmoIc.appendChild(buildExtender("bmo"));
  }
}

function wireMobileInterruptDebugUi() {
  if (!MOBILE_VAD_DEBUG) return;
  injectMobileVadLogUiIfNeeded();
  pushMobileInterruptVadLog(
    `sustain=${getInterruptSustainMs()}ms (${INTERRUPT_SUSTAIN_MS_PHONE}ms phone / ${INTERRUPT_SUSTAIN_MS_DESKTOP}ms desktop viewport)`
  );
  ["vera", "bmo"].forEach((prefix) => {
    const btn = document.getElementById(`${prefix}-interrupt-debug-toggle`);
    const headerBtn = document.getElementById(`${prefix}-interrupt-debug-header`);
    const panel = document.getElementById(`${prefix}-interrupt-debug-panel`);
    const clearBtn = document.getElementById(`${prefix}-interrupt-debug-clear`);
    if (!panel) return;
    const toggle = () => toggleInterruptDebugPanel(prefix);
    btn?.addEventListener("click", toggle);
    headerBtn?.addEventListener("click", toggle);
    clearBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      interruptVadLogLines.length = 0;
      renderMobileInterruptVadLogs();
    });
  });
}

function startInterruptCapture() {
  if (listeningMode !== "continuous") {
    interruptRecording = false;
    interruptChunks = [];
    return;
  }
  if (inputMuted) {
    interruptRecording = false;
    interruptChunks = [];
    stopAllBrowserSpeechRecognizers();
    showMutedStatusIfIdle();
    return;
  }
  if (browserAsrPreferred() && !isNarrowViewport()) {
    startInterruptBrowserPartialDetection();
    return;
  }

  // 🔥 HARD FLUSH — stop and discard any previous capture
  if (interruptRecorder && interruptRecorder.state !== "inactive") {
    try {
      interruptRecorder.ondataavailable = null;
      interruptRecorder.onstop = null;
      interruptRecorder.stop();
    } catch {}
  }

  interruptRecorder = null;
  interruptRecording = false;
  interruptChunks = [];
  interruptSpeechFrames = 0;
  interruptSpeechStart = 0;
  interruptSpeechAccumMs = 0;
  lastInterruptDetectTime = 0;
  interruptLastSpeechLikeTime = 0;
  lastInterruptSpeechLikeSnapshot = null;

  // ---------- START FRESH RECORDER ----------
  interruptRecorder = new MediaRecorder(micStream);

  interruptRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      interruptChunks.push(e.data);
    }
  };

  interruptRecorder.onstop = () => {
    const blob = new Blob(interruptChunks, { type: "audio/webm" });

    interruptRecorder = null;
    interruptRecording = false;
    interruptChunks = [];

    handleInterruptUtterance(blob);
  };

  interruptRecorder.start();   // 🚀 clean segment start
  interruptRecording = true;
}

async function handleInterruptUtterance(blob) {
  if (blob.size < MIN_AUDIO_BYTES) {
    listening = true;
    return;
  }

  requestInFlight = true;
  processing = true;
  waveState = "idle";
  setStatus("Thinking", "thinking");

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());
  formData.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
  formData.append("mode", "interrupt"); // backend can branch if desired
  formData.append(
    "interrupt_debug",
    JSON.stringify({
      probe: lastInterruptProbe,
      thresholds: {
        INTERRUPT_RMS,
        INTERRUPT_ZCR_MIN,
        INTERRUPT_ZCR_MAX,
        INTERRUPT_SUSTAIN_MS: getInterruptSustainMs(),
        INTERRUPT_GAP_RESET_MS,
        INTERRUPT_MAX_CREST,
        MAX_SPEECH_RMS,
      },
    })
  );
  formData.append("stream_tts", shouldStreamTts() ? "1" : "0");

  await runInferInterruptPipeline(formData);
}

async function playInterruptAnswer(data) {
  const run = async () => {
    resetAudioHandlers();
    try {
      await playTtsFromApi(data, {
        onPlayStart: () => {
          logVoiceFirstAudio("main-reply");
          logVoiceMainReplyAudio();
          applyAssistantReplyAndPanels(data);
          waveState = "speaking";
          audioStartedAt = performance.now();
          setStatus("Speaking… (can only be interrupted once)", "speaking");
          processing = false;
        },
        onPlayEnd: () => {
          resumeListeningAfterInterruptPlayback();
        }
      });
    } catch (e) {
      console.warn(e);
    }
  };

  await run();
}
/* =========================
   MIC INIT
========================= */

/** Per-mode TTS <audio> through Web Audio (vera-audio / bmo-audio). */
async function ensureMainAudioTtsGraph() {
  const m = appModePrefix();
  const el = getAudioEl();
  if (!el || ttsByMode[m].source) return;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  const source = audioCtx.createMediaElementSource(el);
  source.connect(analyser);
  source.connect(gain);
  gain.connect(audioCtx.destination);
  ttsByMode[m].source = source;
  ttsByMode[m].analyser = analyser;
  ttsByMode[m].gain = gain;
  applyVeraWorkModeMuteSetting();
}

/** Prefer `audio_urls` when present (sentence-chunked TTS); else single `audio_url`. */
function resolveAudioUrls(data) {
  if (Array.isArray(data.audio_urls) && data.audio_urls.length) return data.audio_urls;
  if (data.audio_url) return [data.audio_url];
  return [];
}

/** Sentence-chunk / streaming TTS uses BufferSource → destination; `<audio>` stays paused, so interrupt must track these. */
let activeMainTtsBufferSources = [];
/** True from first main TTS chunk until last chunk ends — gaps between BufferSources have 0 active sources but TTS is still "playing". */
let mainTtsPlaybackActive = false;

function isAssistantTtsPlaying() {
  const outAudio = getAudioEl();
  const htmlAudioPlaying = outAudio && !outAudio.paused;
  const webAudioMainTtsPlaying =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  return Boolean(htmlAudioPlaying || webAudioMainTtsPlaying);
}

/** Incremented on interrupt so NDJSON read + incremental Web Audio loops exit and stop scheduling further chunks. */
let mainTtsPlaybackToken = 0;
/** Active NDJSON `res.body.getReader()`; cancelled on interrupt so the stream stops feeding the URL queue. */
let activeNdjsonBodyReader = null;

function registerMainTtsBufferSource(src, onEndedExtra) {
  activeMainTtsBufferSources.push(src);
  src.onended = () => {
    const i = activeMainTtsBufferSources.indexOf(src);
    if (i >= 0) activeMainTtsBufferSources.splice(i, 1);
    if (onEndedExtra) onEndedExtra();
  };
}

function stopAllMainTtsWebAudio() {
  mainTtsPlaybackActive = false;
  const copy = activeMainTtsBufferSources.slice();
  activeMainTtsBufferSources = [];
  for (const src of copy) {
    try {
      src.onended = null;
      src.stop(0);
    } catch (_) {
      /* already stopped */
    }
  }
  if (document.body.classList.contains("bmo-open")) {
    stopBmoTtsMouthAnimation();
  }
}

function cancelMainTtsPlayback() {
  mainTtsPlaybackToken++;
  stopAllMainTtsWebAudio();
  const r = activeNdjsonBodyReader;
  activeNdjsonBodyReader = null;
  if (r) {
    try {
      r.cancel();
    } catch (_) {
      /* ignore */
    }
  }
}

let activePipelineAbort = null;
let queuedAssistantTtsPlayback = Promise.resolve();

function attachPipelineAbortSignal() {
  activePipelineAbort?.abort();
  activePipelineAbort = new AbortController();
  return activePipelineAbort.signal;
}

function enqueueAssistantTtsPlayback(task) {
  const run = queuedAssistantTtsPlayback
    .catch(() => {})
    .then(async () => {
      await waitUntilAssistantTtsIdle();
      await task();
      await waitUntilAssistantTtsIdle();
    });
  queuedAssistantTtsPlayback = run.catch(() => {});
  return run;
}

async function waitUntilAssistantTtsIdle(maxWaitMs = 60000) {
  const start = performance.now();
  while (isAssistantTtsPlaying()) {
    if (performance.now() - start > maxWaitMs) break;
    await new Promise((resolve) => window.setTimeout(resolve, 40));
  }
}

async function waitForAssistantPlaybackEnd(onFinishHook) {
  let done = false;
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finishDone = () => {
    if (done) return;
    done = true;
    resolveDone?.();
  };
  const wrappedOnFinish = () => {
    try {
      if (typeof onFinishHook === "function") onFinishHook();
    } finally {
      finishDone();
    }
  };
  // Safety timeout in case a browser event is missed.
  const timeoutId = window.setTimeout(finishDone, 45000);
  return {
    wrappedOnFinish,
    donePromise: donePromise.finally(() => window.clearTimeout(timeoutId))
  };
}

function isMainTtsOrHtmlAudioPlaying() {
  const a = getAudioEl();
  const htmlPlaying = a && !a.paused;
  const webTts =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  return htmlPlaying || webTts;
}

function isServerPipelineBusy() {
  return (
    requestInFlight ||
    processing ||
    isMainTtsOrHtmlAudioPlaying()
  );
}

/** Typed send (flow or work mode) can replace an in-flight reply / speaking TTS. */
function isFlowModeKeyboardInterruptAllowed() {
  return true;
}

/** Abort fetch + stop main TTS so the next `/text` send can proceed (keyboard barge-in). */
function interruptAssistantPipelineForTypedMessage() {
  activePipelineAbort?.abort();
  activePipelineAbort = null;
  cancelMainTtsPlayback();
  resetAudioHandlers();
  const a = getAudioEl();
  if (a) {
    a.pause();
    a.currentTime = 0;
  }
  processing = false;
  requestInFlight = false;
  // The prior assistant request is gone — any pending "Searching news…"
  // bubble that was waiting on it would never resolve.
  cancelPendingNewsStatusBubble("pipeline_interrupted_by_typed");
  clearInterruptDetectionBubble();
  interruptBargeInLatched = false;
  voiceUxTurn = null;
  textUxTurn = null;
  if (listeningMode === "ptt") {
    listening = false;
    pttRecording = false;
    waveState = "idle";
    setStatus("Ready", "idle");
  } else {
    listening = true;
    waveState = "listening";
    if (inputMuted) showMutedStatusIfIdle();
    else setStatus("Listening…", "recording");
  }
  updateMuteInputButton();
}

function cancelVoicePipelineAndResetState() {
  activePipelineAbort?.abort();
  activePipelineAbort = null;
  cancelMainTtsPlayback();
  resetAudioHandlers();
  const a = getAudioEl();
  if (a) {
    a.pause();
    a.removeAttribute("src");
    a.load?.();
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (speechWaitTimeoutId != null) {
    clearTimeout(speechWaitTimeoutId);
    speechWaitTimeoutId = null;
  }
  if (interruptRecorder && interruptRecorder.state !== "inactive") {
    try {
      interruptRecorder.ondataavailable = null;
      interruptRecorder.onstop = null;
      interruptRecorder.stop();
    } catch {}
  }
  interruptRecorder = null;
  interruptRecording = false;
  interruptChunks = [];
  stopAllBrowserSpeechRecognizers();
  if (mediaRecorder && mediaRecorder.state === "recording") {
    suppressNextUtterance = true;
    mediaRecorder.stop();
  }
  processing = false;
  requestInFlight = false;
  voiceUxTurn = null;
  textUxTurn = null;
  pttRecording = false;
  listening = false;
  audioChunks = [];
  hasSpoken = false;
  lastVoiceTime = 0;
  waveState = "idle";
  cancelPendingNewsStatusBubble("voice_pipeline_reset");
  clearVoiceMaxDurationTimer();
  setStatus("Ready", "idle");
  updateMuteInputButton();
}

function resumeAfterAssistantReplyPlayback() {
  browserAsrMainNetworkRetries = 0;
  processing = false;
  requestInFlight = false;
  if (workModeTypedTurnQueue.length > 0) scheduleWorkModeTypedQueueDrain();
  clearInterruptDetectionBubble();
  if (listeningMode === "ptt") {
    listening = false;
    pttRecording = false;
    waveState = "idle";
    setStatus("Ready", "idle");
    updateMuteInputButton();
    return;
  }
  waveState = "listening";
  if (listeningMode === "continuous") {
    listening = true;
    if (inputMuted) {
      showMutedStatusIfIdle();
      return;
    }
    /* Defer so Web Audio / <audio> teardown and NDJSON reader finish; avoids empty SR sessions that never transcribe. */
    window.setTimeout(() => {
      if (!listening || processing || inputMuted) return;
      startListening();
    }, 80);
  }
}

function resumeListeningAfterInterruptPlayback() {
  browserAsrMainNetworkRetries = 0;
  processing = false;
  requestInFlight = false;
  clearInterruptDetectionBubble();
  if (listeningMode === "ptt") {
    listening = false;
    pttRecording = false;
    waveState = "idle";
    setStatus("Ready", "idle");
    updateMuteInputButton();
    return;
  }
  waveState = "listening";
  listening = true;
  if (inputMuted) {
    showMutedStatusIfIdle();
    return;
  }
  window.setTimeout(() => {
    if (!listening || processing || inputMuted) return;
    startListening();
  }, 80);
}

/** Same wiring as MediaElementSource → analyser + destination: chunked TTS must feed the TTS analyser or BMO mouth / VERA wave stay flat. */
function connectBufferSourceToTtsGraph(src) {
  const m = appModePrefix();
  const t = ttsByMode[m];
  if (t?.analyser) {
    src.connect(t.analyser);
  }
  if (t?.gain) src.connect(t.gain);
  else src.connect(audioCtx.destination);
}

function wrapLastChunkForBmoMouth(onLastEnd) {
  if (!onLastEnd) return undefined;
  return () => {
    mainTtsPlaybackActive = false;
    if (document.body.classList.contains("bmo-open")) {
      stopBmoTtsMouthAnimation();
    }
    onLastEnd();
  };
}

/** Mirrors `split_sentences_for_tts` / TTS.py: paragraphs, then `.!?` or newlines. */
function splitSentencesForTtsClient(text) {
  let t = (text || "").trim();
  if (!t) return [];
  t = t.replace(/\u201c/g, '"').replace(/\u201d/g, '"').replace(/\u2019/g, "'");
  t = t.replace(/\u3002/g, ".");
  t = t.replace(/(?<=[a-z])\.(?=[A-Z])/g, ". ");
  const paragraphs = t.split(/\n\s*\n+/);
  const out = [];
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    const parts = p.split(/(?<=[.!?])\s+|\n+/);
    for (const part of parts) {
      const x = part.trim();
      if (x) out.push(x);
    }
  }
  return out.length ? out : [t];
}

const BMO_TTS_SAD_HINTS =
  /\b(sorry|sad|sorrow|cry|tears|tearful|afraid|scared|fear|worried|worry|anxious|anxiety|depress|lonely|alone|hurt|hurts|pain|aching|hate|hatred|angry|rage|terrible|awful|horrible|worst|tragic|unfortunately|regret|guilt|ashamed|loss|lose|lost|die|death|dead|dying|kill|never\s+again|hopeless|despair|upset|disappoint|failed?|failure|breakdown|grief|mourn)\b/i;
const BMO_TTS_HAPPY_HINTS =
  /\b(happy|happiness|joy|joyful|great|wonderful|awesome|amazing|love|loved|celebrat|excit|excited|fun|funny|laugh|smile|cheer|yay|best|lucky|glad|proud|relief|relieved|good\s+news|victory|won|win|beautiful|perfect)\b/i;
// Playful/idiomatic phrases that contain "negative" tokens but are clearly NOT sad.
// We test these BEFORE the sad hints so "never hurt anyone" stays neutral instead of
// flipping to a sad face on the bare 'hurt'/'pain'/'sorry' tokens.
const BMO_PLAYFUL_NEGATIVE_RX =
  /\b(never\s+(?:hurt|hurts|harmed|killed|cried|failed|did\s+anything)\s+(?:anyone|anybody|anything|nobody|no\s+one|a\s+soul)|(?:doesn|don|didn|won|wouldn|couldn|shouldn|can|cannot|cant)'?t\s+hurt(?:\s+(?:to|anyone|anybody|me|us|you|it))?|no\s+harm(?:\s+done|\s+in\s+(?:that|trying|asking))?|just\s+(?:kidding|teasing|joking|playing|messing\s+with\s+you)|only\s+(?:kidding|teasing|joking)|no\s+big\s+deal|nothing\s+to\s+worry\s+about|all\s+in\s+good\s+fun|grammatical\s+weathering)\b/i;

function bmoSentenceIsPlayfulNegative(seg) {
  const s = String(seg || "").trim();
  if (!s) return false;
  return BMO_PLAYFUL_NEGATIVE_RX.test(s);
}

function normalizeBmoTtsMood(x) {
  const s = String(x || "neutral").trim().toLowerCase();
  if (s === "sad" || s === "neutral" || s === "happy") return s;
  return "neutral";
}

function classifyBmoTtsSegmentHeuristic(seg) {
  const s = (seg || "").trim();
  if (!s) return "neutral";
  // Playful idiom guard: don't let bare 'hurt'/'pain'/'sorry' force sad on a clearly
  // playful sentence ("a little weathering never hurt anyone", "no harm done", etc.).
  if (bmoSentenceIsPlayfulNegative(s)) {
    if (BMO_TTS_HAPPY_HINTS.test(s) && !BMO_TTS_SAD_HINTS.test(s)) return "happy";
    return "neutral";
  }
  if (BMO_TTS_SAD_HINTS.test(s) && !BMO_TTS_HAPPY_HINTS.test(s)) return "sad";
  if (BMO_TTS_HAPPY_HINTS.test(s) && !BMO_TTS_SAD_HINTS.test(s)) return "happy";
  if (BMO_TTS_SAD_HINTS.test(s)) return "sad";
  if (BMO_TTS_HAPPY_HINTS.test(s)) return "happy";
  return "neutral";
}

/** Strict lexicon override — always force sad regardless of user_text or LLM label.
 *  Reserved for unambiguous grief / deep apology / condolences phrasings. Generic
 *  "sorry" / "wish I could" do NOT belong here; those move to the soft set below.
 */
function bmoAssistantSegmentRequiresSadFaceStrict(seg) {
  const s = String(seg || "").trim();
  if (!s) return false;
  if (bmoSentenceIsPlayfulNegative(s)) return false;
  if (
    /\b(my\s+condolences|deepest\s+condolences|so\s+sorry\s+for\s+your\s+loss|i'?m\s+so\s+sorry\s+to\s+hear|that'?s\s+(?:so\s+)?heartbreaking|that\s+sounds\s+(?:truly|really)\s+(?:awful|devastating|heartbreaking))\b/i.test(
      s
    )
  ) {
    return true;
  }
  return false;
}

/** Soft empathy/apology — only forces sad when the USER_text shows distress. */
function bmoAssistantSegmentSoftEmpathy(seg) {
  const s = String(seg || "").trim();
  if (!s) return false;
  if (bmoSentenceIsPlayfulNegative(s)) return false;
  if (/\b(sorry|apologi[sz]e|apologies)\b/i.test(s)) return true;
  if (/\b(i\s*'?m\s+sorry|i\s+am\s+sorry|we\s*'?re\s+sorry|so\s+sorry|really\s+sorry|deeply\s+sorry)\b/i.test(s))
    return true;
  if (/\b(sorry\s+you'?re|sorry\s+to\s+hear|sorry\s+about|sorry\s+for)\b/i.test(s)) return true;
  if (
    /\b(that\s+sounds\s+(?:really\s+)?(?:hard|rough|awful|tough|difficult)|hearing\s+(?:that|you)|wish\s+i\s+could|i\s+hear\s+you|i'?m\s+here\s+for\s+you)\b/i.test(
      s
    )
  )
    return true;
  return false;
}

// Tightened user-distress hint: bare tokens like "down" / "blue" / "alone" / "hurt"
// / "pain" require accompanying "feel(ing)" or "I'm" context so casual phrasing
// like "Trump is going down to China" doesn't promote BMO to sad mode.
const BMO_USER_DISTRESS_RX =
  /\b(sad|depressed|depressing|anxious|anxiety|worried|worries|cry|crying|tearful|grief|grieving|mourning|hopeless|despair|despairing|overwhelmed|exhausted|drained|can'?t\s+cope|cannot\s+cope|cant\s+cope|not\s+ok(?:ay)?|having\s+a\s+(?:hard|tough|rough)\s+time|need\s+(?:to\s+)?(?:cry|vent|talk))\b|\bfeel(?:ing)?\s+(?:down|blue|empty|numb|lonely|alone|sad|hurt|broken|hopeless|low|terrible|awful|miserable|like\s+crap|like\s+shit)\b|\bi'?m\s+(?:hurting|hurt|in\s+pain|crying|broken|lost|done|struggling|overwhelmed|exhausted|drained|not\s+ok(?:ay)?|miserable|grieving)\b/i;

function bmoUserTextIsDistressed(userText) {
  const ut = String(userText || "").trim();
  if (!ut) return false;
  return BMO_USER_DISTRESS_RX.test(ut);
}

/** Backward-compat name still used by callers in this file. */
function bmoAssistantSegmentPrefersSadFace(seg, userText) {
  if (bmoAssistantSegmentRequiresSadFaceStrict(seg)) return true;
  if (bmoUserTextIsDistressed(userText) && bmoAssistantSegmentSoftEmpathy(seg)) return true;
  return false;
}

/**
 * If TTS is one file for many sentences, any STRICT apology (condolences, deep grief)
 * in the reply deserves the sad mouth even when modes is a single-element array.
 * SOFT empathy ("I'm sorry", "wish I could") only flips when userText is distressed.
 */
function applyBmoSadFaceLexiconOverride(sentences, faceModes, userText) {
  if (!Array.isArray(sentences) || !Array.isArray(faceModes) || !faceModes.length) return faceModes;
  const distressed = bmoUserTextIsDistressed(userText);
  const shouldOverride = (s) => {
    if (bmoAssistantSegmentRequiresSadFaceStrict(s)) return true;
    if (distressed && bmoAssistantSegmentSoftEmpathy(s)) return true;
    return false;
  };
  if (faceModes.length === 1 && sentences.length > 1) {
    if (sentences.some(shouldOverride)) return ["sad"];
    return faceModes;
  }
  return faceModes.map((mode, i) => (shouldOverride(sentences[i]) ? "sad" : mode));
}

function logBmoEmotionDecision(row) {
  try {
    console.log("[bmo_emotion_decision]", JSON.stringify(row));
  } catch {}
}

function bmoMoodToFaceMode(mood) {
  return normalizeBmoTtsMood(mood) === "sad" ? "sad" : "happy";
}

/** When the user sounded clearly distressed, do not keep empathy/apology sentences as
 *  neutral (LLM often does). Casual user phrasing must NOT trigger this — playful
 *  idioms in the assistant reply are left alone via the playful-negative guard.
 */
function boostBmoMoodsForUserDistress(userText, sentences, moods) {
  const ut = (userText || "").trim();
  if (!ut || !Array.isArray(sentences) || !Array.isArray(moods) || moods.length !== sentences.length) {
    return moods;
  }
  if (!bmoUserTextIsDistressed(ut)) return moods;
  return moods.map((m, i) => {
    const lab = normalizeBmoTtsMood(m);
    if (lab === "sad" || lab === "happy") return lab;
    const s = String(sentences[i] || "");
    if (bmoSentenceIsPlayfulNegative(s)) return lab;
    if (bmoAssistantSegmentSoftEmpathy(s) || bmoAssistantSegmentRequiresSadFaceStrict(s)) {
      return "sad";
    }
    return lab;
  });
}

function alignBmoFaceModesToChunkCount(modes, chunkCount) {
  const n = Math.max(0, chunkCount | 0);
  if (!n) return [];
  const m = Array.isArray(modes) ? modes.slice(0, n) : [];
  const last = m.length ? m[m.length - 1] : "happy";
  while (m.length < n) m.push(last);
  for (let i = 0; i < m.length; i++) {
    m[i] = m[i] === "sad" ? "sad" : "happy";
  }
  return m;
}

function bmoNewSegmentFromCumulativeReply(prevCum, newCum) {
  const p = (prevCum || "").trimEnd();
  const c = (newCum || "").trim();
  if (!c) return "";
  if (!p) return c;
  if (c === p) return "";
  if (c.startsWith(p)) return c.slice(p.length).trimStart();
  return c;
}

function setBmoTtsFaceTrack(track) {
  const svg = document.getElementById("bmo-smile-svg");
  if (!svg) return;
  if (track === "sad") svg.setAttribute("data-bmo-tts-face-track", "sad");
  else svg.removeAttribute("data-bmo-tts-face-track");
}

async function fetchBmoTtsEmotionLabels(userText, sentences) {
  const res = await fetch(`${API_URL}/tts_emotion_route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: getSessionId(),
      user_text: userText || "",
      sentences
    })
  });
  if (!res.ok) throw new Error(`emotion route HTTP ${res.status}`);
  const data = await res.json();
  const raw = data.labels;
  if (!Array.isArray(raw)) throw new Error("emotion route: missing labels");
  return sentences.map((_, i) => normalizeBmoTtsMood(raw[i]));
}

async function resolveBmoTtsSegmentFaceModesForPlayback(data, urlCount) {
  if (!document.body.classList.contains("bmo-open")) return null;
  const n = Math.max(0, urlCount | 0);
  if (!n) return null;
  const reply = String(data?.reply ?? "").trim();
  const userText = String(
    data?.transcript ?? data?.user_text ?? data?.text ?? ""
  ).trim();
  if (!reply) return alignBmoFaceModesToChunkCount([], n);
  const sentences = splitSentencesForTtsClient(reply);
  if (!sentences.length) return alignBmoFaceModesToChunkCount([], n);

  // Heuristic per sentence — always computed so we can include it in [bmo_emotion_decision].
  const heuristicLabels = sentences.map((s) => classifyBmoTtsSegmentHeuristic(s));

  // LLM labels are PRIMARY when available; heuristic is only a fallback.
  let llmLabels = null;
  try {
    llmLabels = await fetchBmoTtsEmotionLabels(userText, sentences);
  } catch (e) {
    console.warn("[BMO][TTS] emotion route", e);
    llmLabels = null;
  }
  const primary = llmLabels || heuristicLabels.slice();
  const boosted = boostBmoMoodsForUserDistress(userText, sentences, primary);

  let modes = sentences.map((_, i) => bmoMoodToFaceMode(boosted[i]));
  modes = alignBmoFaceModesToChunkCount(modes, n);
  // Lexicon override now requires either a STRICT phrase (always) or SOFT empathy
  // + a clearly distressed user (never on a single bare 'sorry' / 'hurt' alone).
  modes = applyBmoSadFaceLexiconOverride(sentences, modes, userText);

  for (let i = 0; i < sentences.length; i++) {
    const llm = llmLabels ? normalizeBmoTtsMood(llmLabels[i]) : null;
    const heur = normalizeBmoTtsMood(heuristicLabels[i]);
    const final = normalizeBmoTtsMood(boosted[i]);
    let overrideApplied = false;
    let overrideReason = "";
    if (llm && llm !== final) {
      overrideApplied = true;
      if (llm === "sad" && final !== "sad" && bmoSentenceIsPlayfulNegative(sentences[i])) {
        overrideReason = "demoted_playful_negative";
      } else if (final === "sad") {
        if (bmoAssistantSegmentRequiresSadFaceStrict(sentences[i])) {
          overrideReason = "strict_empathy_lexicon";
        } else if (bmoUserTextIsDistressed(userText) && bmoAssistantSegmentSoftEmpathy(sentences[i])) {
          overrideReason = "soft_empathy_with_user_distress";
        } else {
          overrideReason = "boost_for_user_distress";
        }
      } else {
        overrideReason = "label_changed";
      }
    } else if (!llm) {
      overrideReason = "heuristic_fallback";
    }
    logBmoEmotionDecision({
      sentence: String(sentences[i] || "").slice(0, 200),
      user_text: String(userText || "").slice(0, 200),
      llm_label: llm,
      heuristic_label: heur,
      final_label: final,
      override_applied: overrideApplied,
      override_reason: overrideReason,
    });
  }

  return modes;
}

/**
 * Schedule decoded buffers back-to-back on one AudioContext (minimal gaps vs chained <audio>).
 * Prefetches the next HTTP response while decoding/playing the current chunk.
 */
async function playTtsUrlSequenceGapless(
  baseUrl,
  relativeUrls,
  { onFirstStart, onLastEnd, sessionToken, segmentFaceModes } = {}
) {
  if (!relativeUrls?.length) return;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  await ensureMainAudioTtsGraph();
  mainTtsPlaybackActive = true;
  getAudioEl()?.pause();
  let t = audioCtx.currentTime + 0.08;
  let firstDone = false;

  let nextPromise = fetch(`${baseUrl}${relativeUrls[0]}`).then((r) => {
    if (!r.ok) throw new Error(`TTS chunk 0 HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  try {
  for (let i = 0; i < relativeUrls.length; i++) {
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const ab = await nextPromise;
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    nextPromise =
      i + 1 < relativeUrls.length
        ? fetch(`${baseUrl}${relativeUrls[i + 1]}`).then((r) => {
            if (!r.ok) throw new Error(`TTS chunk ${i + 1} HTTP ${r.status}`);
            return r.arrayBuffer();
          })
        : null;

    const audBuf = await audioCtx.decodeAudioData(ab.slice(0));
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audBuf;
    connectBufferSourceToTtsGraph(src);
    const startAt = Math.max(t, audioCtx.currentTime + 0.02);
    if (document.body.classList.contains("bmo-open")) {
      const face =
        segmentFaceModes != null && segmentFaceModes.length
          ? segmentFaceModes[Math.min(i, segmentFaceModes.length - 1)]
          : "happy";
      setBmoTtsFaceTrack(face);
    }
    src.start(startAt);
    /* BMO mouth before onFirstStart: onPlayStart applies news side panel (heavy innerHTML); blocking first would let TTS chunks finish before RAF starts — generic headlines path is slower than “breaking news”. */
    if (document.body.classList.contains("bmo-open")) {
      void startBmoTtsMouthAnimation();
    }
    if (!firstDone && onFirstStart) {
      onFirstStart();
      firstDone = true;
    }
    const isLast = i === relativeUrls.length - 1;
    registerMainTtsBufferSource(
      src,
      isLast && onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : undefined
    );
    t = startAt + audBuf.duration;
  }
  } catch (e) {
    mainTtsPlaybackActive = false;
    throw e;
  }
}

/** Single <audio> for one file; Web Audio queue when multiple sentence chunks. */
async function playTtsFromApi(data, { onPlayStart, onPlayEnd, ephemeralAck } = {}) {
  if (appModePrefix() === "vera" && isVeraWorkModeOn() && isWorkModeMuteEnabled()) {
    logVeraSettings("tts_play_suppressed_workmode_mute", { mode: "playTtsFromApi" });
    mainTtsPlaybackActive = false;
    if (typeof onPlayStart === "function") onPlayStart();
    if (typeof onPlayEnd === "function") onPlayEnd();
    return;
  }
  if (!ephemeralAck && listeningMode === "continuous" && inputMuted) {
    logVeraSettings("tts_play_suppressed_continuous_input_muted", { mode: "playTtsFromApi" });
    mainTtsPlaybackActive = false;
    if (typeof onPlayStart === "function") onPlayStart();
    waveState = "idle";
    processing = false;
    requestInFlight = false;
    showMutedStatusIfIdle();
    if (typeof onPlayEnd === "function") onPlayEnd();
    return;
  }
  const urls = resolveAudioUrls(data);
  if (!urls.length) return;

  let segmentFaceModes = null;
  if (document.body.classList.contains("bmo-open")) {
    segmentFaceModes = await resolveBmoTtsSegmentFaceModesForPlayback(data, urls.length);
  }

  if (urls.length > 1) {
    console.log(
      `[UX][TTS] ${urls.length} segments — one /text or /infer response; next: ${urls.length} GETs to /audio/...`,
      urls
    );
  }

  const sessionToken = mainTtsPlaybackToken;
  const runPlayStart = () => {
    if (onPlayStart) onPlayStart();
  };

  if (urls.length === 1) {
    const el = getAudioEl();
    if (!el) return;
    el.src = `${API_URL}${urls[0]}`;
    await ensureMainAudioTtsGraph();
    el.addEventListener(
      "play",
      () => {
        mainTtsPlaybackActive = true;
        if (document.body.classList.contains("bmo-open")) {
          const face =
            segmentFaceModes != null && segmentFaceModes.length
              ? segmentFaceModes[0]
              : "happy";
          setBmoTtsFaceTrack(face);
          void startBmoTtsMouthAnimation();
        }
        runPlayStart();
      },
      { once: true }
    );
    el.addEventListener(
      "ended",
      () => {
        mainTtsPlaybackActive = false;
        if (onPlayEnd) onPlayEnd();
      },
      { once: true }
    );
    const onSingleAudioError = (ev) => {
      try { el.removeEventListener("error", onSingleAudioError); } catch (_) {}
      logVeraCapabilityFailure("tts", "audio_element_error", {
        src: el.src,
        error_code: el.error?.code
      });
      mainTtsPlaybackActive = false;
      veraShowCapabilityFailureBubble(
        "tts_failure",
        VERA_SAFETY_LIMITS.messages.ttsFailure
      );
      if (onPlayEnd) onPlayEnd();
    };
    el.addEventListener("error", onSingleAudioError, { once: true });
    try {
      await el.play();
    } catch (err) {
      onSingleAudioError(err);
    }
    return;
  }

  await playTtsUrlSequenceGapless(API_URL, urls, {
    onFirstStart: runPlayStart,
    onLastEnd: onPlayEnd,
    sessionToken,
    segmentFaceModes
  });
}

function createTtsUrlQueue() {
  const q = [];
  const waiters = [];
  let ended = false;
  return {
    push(url) {
      q.push(url);
      const w = waiters.shift();
      if (w) w();
    },
    end() {
      ended = true;
      waiters.splice(0).forEach((w) => w());
    },
    async next() {
      for (;;) {
        if (q.length) return q.shift();
        if (ended) return null;
        await new Promise((r) => waiters.push(r));
      }
    }
  };
}

/** Gapless Web Audio playback when URLs arrive incrementally (streaming NDJSON chunks). */
async function playTtsUrlSequenceIncremental(
  baseUrl,
  nextRelFn,
  {
    onBeforeFirstPlay,
    onFirstStart,
    onLastEnd,
    sessionToken,
    segmentFaceModes,
    /** NDJSON fills this array after playback starts — call each chunk instead of freezing `segmentFaceModes`. */
    getSegmentFaceModes
  } = {}
) {
  const currentFaceModes = () =>
    typeof getSegmentFaceModes === "function" ? getSegmentFaceModes() : segmentFaceModes;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  await ensureMainAudioTtsGraph();
  let t = audioCtx.currentTime + 0.08;
  let firstDone = false;

  let curRel = await nextRelFn();
  if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
    mainTtsPlaybackActive = false;
    return;
  }
  /* NDJSON can call queue.end() before any chunk URL (e.g. done-before-chunk or empty TTS). Without this,
     onPlayEnd / resumeAfterAssistantReplyPlayback never runs → processing stays true and listening never renews. */
  if (!curRel) {
    const endFn = onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : null;
    if (endFn) endFn();
    else mainTtsPlaybackActive = false;
    return;
  }
  mainTtsPlaybackActive = true;
  getAudioEl()?.pause();
  let nextPromise = fetch(`${baseUrl}${curRel}`).then((r) => {
    if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  let chunkPlayIndex = 0;

  try {
  for (;;) {
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const ab = await nextPromise;
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const nextRel = await nextRelFn();
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    nextPromise = nextRel
      ? fetch(`${baseUrl}${nextRel}`).then((r) => {
          if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
          return r.arrayBuffer();
        })
      : null;

    const audBuf = await audioCtx.decodeAudioData(ab.slice(0));
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    if (!firstDone && onBeforeFirstPlay) {
      onBeforeFirstPlay();
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audBuf;
    connectBufferSourceToTtsGraph(src);
    const startAt = Math.max(t, audioCtx.currentTime + 0.02);
    if (document.body.classList.contains("bmo-open")) {
      const modesList = currentFaceModes();
      const face =
        modesList != null && modesList.length
          ? modesList[Math.min(chunkPlayIndex, modesList.length - 1)]
          : "happy";
      setBmoTtsFaceTrack(face);
    }
    src.start(startAt);
    chunkPlayIndex++;
    /* Same order as gapless: mouth before onPlayStart so heavy news panel does not block first tick. */
    if (document.body.classList.contains("bmo-open")) {
      void startBmoTtsMouthAnimation();
    }
    if (!firstDone && onFirstStart) {
      onFirstStart();
      firstDone = true;
    }
    const isLast = !nextRel;
    registerMainTtsBufferSource(
      src,
      isLast && onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : undefined
    );
    t = startAt + audBuf.duration;
    if (!nextRel) break;
  }
  } catch (e) {
    mainTtsPlaybackActive = false;
    throw e;
  }
}

/**
 * When NDJSON playback is queued behind prior TTS, `runNdjsonTtsPlayback` may not start until later,
 * delaying `meta` and leaving work-mode timers disarmed. Read a cloned body until `meta` and apply
 * `work_mode_timer` immediately (main infer still consumes the original `res` body).
 */
async function tryPeekApplyWorkModeTimerFromNdjsonClone(res) {
  if (!res?.body || !res.ok) return;
  let c;
  try {
    c = res.clone();
  } catch {
    return;
  }
  const reader = c.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let obj;
        try {
          obj = JSON.parse(t);
        } catch {
          continue;
        }
        if (obj.type === "asr") continue;
        if (obj.type === "meta") {
          if (obj.work_mode_timer) applyWorkModeTimerPayload(obj.work_mode_timer);
          return;
        }
        if (obj.type === "chunk" || obj.type === "done") return;
      }
    }
  } catch {
    /* ignore */
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
  }
}

/**
 * Consume application/x-ndjson: asr (optional) → meta → chunk → … → done. Prefetches the next URL while decoding/playing.
 * Each parsed line batch must be handled in stream order: meta before chunks, or the user transcript bubble
 * can appear after the assistant (same bug for main infer and interrupt NDJSON).
 * First-sentence assistant text is applied in onBeforeFirstPlay (after decode, before src.start) so it aligns with audio.
 */
async function runNdjsonTtsPlayback(
  res,
  { onMeta, onDone, onPlayStart, onPlayEnd, onReplyProgress, skipAudio, suppressReplyProgress }
) {
  const reader = res.body.getReader();
  activeNdjsonBodyReader = reader;
  const sessionToken = mainTtsPlaybackToken;
  const decoder = new TextDecoder();
  let buf = "";
  const queue = createTtsUrlQueue();
  let loggedFirstChunk = false;
  /** User bubble from transcript: once from early `asr` line or from `meta` (older servers). */
  let userTranscriptBubbleSeen = false;
  function wrapOnMeta(meta) {
    if (!onMeta || !meta) return;
    const m = { ...meta };
    if (m.transcript) {
      if (userTranscriptBubbleSeen) {
        delete m.transcript;
      } else {
        userTranscriptBubbleSeen = true;
      }
    }
    onMeta(m);
  }
  /** First-sentence text is deferred until first audio buffer is decoded (sync with playback start). */
  let pendingFirstReplySoFar = null;
  let deferFirstReply = true;
  /** Latest reply_so_far already applied via onReplyProgress (avoids onBeforeFirstPlay overwriting with shorter pending). */
  let lastEmittedReplySoFar = null;
  /** BMO: per-chunk face stack (happy vs sad); built from meta (full reply) or per chunk (LLM streaming + heuristic). */
  let ndjsonBmoFaceModes = null;
  let ndjsonBmoStreamingTts = false;
  let ndjsonBmoLastUserText = "";
  let ndjsonBmoCumulativeForSeg = "";

  async function readAll() {
    try {
      while (true) {
        if (mainTtsPlaybackToken !== sessionToken) {
          queue.end();
          return;
        }
        let readResult;
        try {
          readResult = await reader.read();
        } catch {
          queue.end();
          return;
        }
        const { value, done: rdone } = readResult;
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        const objs = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            objs.push(JSON.parse(line));
          } catch (e) {
            console.warn("[TTS][NDJSON] skip line", e);
          }
        }
        for (const obj of objs) {
          if (obj.type === "asr" && obj.transcript != null) {
            wrapOnMeta({ transcript: String(obj.transcript) });
            logVoicePipe("NDJSON asr line (user transcript early)");
          } else if (obj.type === "meta") {
            wrapOnMeta(obj);
            logVoicePipe("NDJSON meta line (UI can attach transcript)");
            if (document.body.classList.contains("bmo-open")) {
              ndjsonBmoStreamingTts = Boolean(obj.llm_streaming);
              ndjsonBmoLastUserText = String(obj.transcript || obj.user_text || "");
              const reply = String(obj.reply || "").trim();
              if (reply && !ndjsonBmoStreamingTts) {
                ndjsonBmoCumulativeForSeg = "";
                try {
                  const sentences = splitSentencesForTtsClient(reply);
                  const n = Math.max(1, Number(obj.tts_segment_count) || sentences.length);
                  let labels;
                  const ut = ndjsonBmoLastUserText;
                  try {
                    labels = await fetchBmoTtsEmotionLabels(ut, sentences);
                    labels = boostBmoMoodsForUserDistress(ut, sentences, labels);
                  } catch (e) {
                    console.warn("[BMO][TTS] NDJSON meta emotion route", e);
                    labels = sentences.map((s) => classifyBmoTtsSegmentHeuristic(s));
                    labels = boostBmoMoodsForUserDistress(ut, sentences, labels);
                  }
                  let modes = sentences.map((_, i) => bmoMoodToFaceMode(labels[i]));
                  modes = alignBmoFaceModesToChunkCount(modes, n);
                  ndjsonBmoFaceModes = applyBmoSadFaceLexiconOverride(sentences, modes, ut);
                } catch (e) {
                  console.warn("[BMO][TTS] NDJSON meta face modes", e);
                  ndjsonBmoFaceModes = null;
                }
              } else if (ndjsonBmoStreamingTts) {
                ndjsonBmoFaceModes = [];
                ndjsonBmoCumulativeForSeg = "";
              } else {
                ndjsonBmoFaceModes = null;
              }
            }
          } else if (obj.type === "chunk" && obj.url) {
            if (mainTtsPlaybackToken !== sessionToken) {
              queue.end();
              return;
            }
            if (!loggedFirstChunk) {
              loggedFirstChunk = true;
              logVoicePipe("NDJSON first chunk URL queued (GET /audio/... next)");
            }
            if (
              document.body.classList.contains("bmo-open") &&
              ndjsonBmoStreamingTts &&
              Array.isArray(ndjsonBmoFaceModes)
            ) {
              const cur = String(obj.reply_so_far || "").trim();
              const delta = bmoNewSegmentFromCumulativeReply(ndjsonBmoCumulativeForSeg, cur);
              ndjsonBmoCumulativeForSeg = cur;
              const segFor = (delta || cur).trim();
              let mood = classifyBmoTtsSegmentHeuristic(segFor);
              // Strict lexicon override stays unconditional; soft empathy requires
              // distressed user_text so casual replies don't flip to sad.
              if (bmoAssistantSegmentRequiresSadFaceStrict(segFor)) {
                mood = "sad";
              } else if (
                bmoUserTextIsDistressed(ndjsonBmoLastUserText) &&
                bmoAssistantSegmentSoftEmpathy(segFor)
              ) {
                mood = "sad";
              }
              ndjsonBmoFaceModes.push(bmoMoodToFaceMode(mood));
            }
            queue.push(obj.url);
            if (obj.reply_so_far != null && onReplyProgress && !suppressReplyProgress) {
              if (deferFirstReply) {
                pendingFirstReplySoFar = String(obj.reply_so_far);
                deferFirstReply = false;
              } else {
                onReplyProgress(obj.reply_so_far);
                lastEmittedReplySoFar = String(obj.reply_so_far);
              }
            }
          } else if (obj.type === "done") {
            if (onDone) onDone(obj);
            queue.end();
          }
        }
      }
    } finally {
      queue.end();
      if (activeNdjsonBodyReader === reader) activeNdjsonBodyReader = null;
    }
  }

  const readTask = readAll();
  const applyPendingFirstReply = () => {
    if (pendingFirstReplySoFar != null && onReplyProgress) {
      const pending = pendingFirstReplySoFar;
      pendingFirstReplySoFar = null;
      const alreadyAhead =
        lastEmittedReplySoFar != null && lastEmittedReplySoFar.length >= pending.length;
      if (!alreadyAhead) {
        onReplyProgress(pending);
        lastEmittedReplySoFar = pending;
      }
    }
  };
  try {
    if (skipAudio) {
      await readTask;
      if (!suppressReplyProgress) applyPendingFirstReply();
      if (typeof onPlayStart === "function") onPlayStart();
      if (typeof onPlayEnd === "function") onPlayEnd();
      return;
    }
    await Promise.all([
      playTtsUrlSequenceIncremental(API_URL, () => queue.next(), {
        onBeforeFirstPlay: applyPendingFirstReply,
        onFirstStart: onPlayStart,
        onLastEnd: onPlayEnd,
        sessionToken,
        getSegmentFaceModes: () => ndjsonBmoFaceModes
      }),
      readTask
    ]);
  } finally {
    if (activeNdjsonBodyReader === reader) activeNdjsonBodyReader = null;
  }
}

async function initMic() {
  if (micStream) return;

  const audioConstraints = isNarrowViewport()
    ? {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    : {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (err) {
    /* Mic capture failed (permission denied, no device, hardware in use).
       This is the strongest signal that ASR is unrecoverable for this
       session — show the standard ASR-failure bubble so the user knows
       to type instead. Re-raise so callers (PTT / continuous start) can
       reset their wave state. */
    logVeraCapabilityFailure("asr", "mic_capture_failed", {
      error_name: err?.name,
      error_message: String(err?.message || err || "").slice(0, 200)
    });
    veraShowCapabilityFailureBubble(
      "asr_failure",
      VERA_SAFETY_LIMITS.messages.asrFailure
    );
    try { setStatus("Listening unavailable — use the keyboard", "offline"); } catch (_) {}
    throw err;
  }

  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  resizeWaveCanvas();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);

  await ensureMainAudioTtsGraph();

  detectInterrupt();
  startWaveAnimation();
  updateMuteInputButton();
}
/* =========================
   WAVE ANIMATION
   - Frequency-band bars (FFT): bass → treble, amplitude per band
   - Ripple effect: concentric circles that pulse outward with amplitude
========================= */

const BARS = 48;  // frequency bands (bass on sides, treble toward center for symmetry)
const RIPPLE_EXPAND_SPEED = 2.2;
const RIPPLE_FADE_SPEED = 0.018;
const RIPPLE_SPAWN_THRESHOLD = 0.12;  // min avg magnitude to spawn ripple

function freqDataToBands(analyserRef, freqBuf, barValues) {
  if (!analyserRef || !freqBuf) return;
  analyserRef.getByteFrequencyData(freqBuf);
  const binCount = freqBuf.length;
  // Log-like band mapping: more resolution in bass/low-mids (where voice lives)
  for (let i = 0; i < BARS; i++) {
    const fracStart = Math.pow(i / BARS, 1.4);
    const fracEnd = Math.pow((i + 1) / BARS, 1.4);
    const binStart = Math.floor(fracStart * binCount);
    const binEnd = Math.min(Math.ceil(fracEnd * binCount), binCount);
    let sum = 0;
    let n = 0;
    for (let b = binStart; b < binEnd; b++) {
      sum += freqBuf[b];
      n++;
    }
    barValues[i] = n > 0 ? sum / n / 255 : 0;
  }
}

function startWaveAnimation() {
  if (waveformRaf) return;

  function draw() {
    waveformRaf = requestAnimationFrame(draw);

    const canvas = getWaveCanvas();
    const waveCtx = getWaveCtx();
    if (!canvas || !waveCtx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    waveCtx.clearRect(0, 0, width, height);

    const bmoOpen = document.body.classList.contains("bmo-open");
    /* BMO: waveform only while user is speaking (listening); TTS uses SVG mouth */
    if (bmoOpen && waveState === "speaking") {
      return;
    }

    const ttsA = getTtsAnalyser();
    let activeAnalyser = null;
    if (waveState === "listening" && analyser) activeAnalyser = analyser;
    if (waveState === "speaking" && ttsA) activeAnalyser = ttsA;

    if (!frequencyData || !activeAnalyser || frequencyData.length !== activeAnalyser.frequencyBinCount) {
      if (activeAnalyser) {
        frequencyData = new Uint8Array(activeAnalyser.frequencyBinCount);
        smoothedBars = new Float32Array(BARS);
      }
    }

    const targetEnergy = waveState === "speaking" ? 0.9 : waveState === "listening" ? 0.8 : 0;
    waveEnergy += (targetEnergy - waveEnergy) * 0.06;

    const barValues = new Float32Array(BARS);
    if (activeAnalyser && frequencyData) {
      freqDataToBands(activeAnalyser, frequencyData, barValues);
    }

    const barSpacing = width / BARS;
    const barWidth = barSpacing * 0.4;
    let avgMagnitude = 0;

    for (let i = 0; i < BARS; i++) {
      const v = barValues[i];
      avgMagnitude += v;
      const smooth = 0.25;
      if (smoothedBars) smoothedBars[i] = smoothedBars[i] * (1 - smooth) + v * smooth;
    }
    avgMagnitude /= BARS;

    const now = performance.now();
    if (waveEnergy > 0.3 && avgMagnitude > RIPPLE_SPAWN_THRESHOLD && now - lastRippleTime > RIPPLE_SPAWN_INTERVAL_MS) {
      rippleRings.push({ radius: 0, opacity: 0.5 + avgMagnitude * 0.4 });
      lastRippleTime = now;
    }

    for (let r = rippleRings.length - 1; r >= 0; r--) {
      const ring = rippleRings[r];
      ring.radius += RIPPLE_EXPAND_SPEED;
      ring.opacity -= RIPPLE_FADE_SPEED;
      if (ring.opacity <= 0) {
        rippleRings.splice(r, 1);
        continue;
      }
      const rippleAlpha = bmoOpen ? ring.opacity * 0.42 : ring.opacity * 0.35;
      const rr = bmoOpen ? 8 : 255;
      const rg = bmoOpen ? 72 : 255;
      const rb = bmoOpen ? 46 : 255;
      waveCtx.strokeStyle = `rgba(${rr},${rg},${rb},${rippleAlpha})`;
      waveCtx.lineWidth = 1.5;
      waveCtx.beginPath();
      waveCtx.arc(centerX, centerY, ring.radius, 0, Math.PI * 2);
      waveCtx.stroke();
    }

    const boost = waveState === "speaking" ? 2.8 : waveState === "listening" ? 2.8 : 0;
    const minimumBarScale = waveState === "listening" ? 0.05 : 0.03;
    const mid = BARS / 2;
    if (bmoOpen) {
      waveCtx.fillStyle = "rgba(10, 68, 42, 0.98)";
      /* Lighter shadow than VERA: mint bar + heavy blur reads as muddy / soft. */
      waveCtx.shadowBlur = 3;
      waveCtx.shadowColor = "rgba(4, 42, 26, 0.35)";
    } else {
      waveCtx.fillStyle = "rgba(255,255,255,0.95)";
      waveCtx.shadowBlur = 14;
      waveCtx.shadowColor = "rgba(255,255,255,0.7)";
    }

    for (let i = 0; i < BARS; i++) {
      const raw = (smoothedBars && waveEnergy > 0) ? smoothedBars[i] : barValues[i];
      const distance = Math.abs(i - mid) / mid;
      const envelope = Math.pow(1 - distance, 2.0);
      const barHeight =
        Math.max(minimumBarScale, raw) * height * boost * envelope * waveEnergy;

      const x = i * barSpacing + (barSpacing - barWidth) / 2;
      waveCtx.beginPath();
      waveCtx.roundRect(x, centerY - barHeight, barWidth, barHeight * 2, barWidth / 2);
      waveCtx.fill();
    }
  }

  draw();
}

/* =========================
   BMO — TTS drives SVG mouth (same shaping as intro in index.html)
========================= */

/**
 * BMO TTS mouth: idle (stroke) / surprised (O) / happy (open).
 *
 * What drives it:
 * - **Instant level** ≈ waveform RMS + a little **FFT peak** (tallest bin in the voice band).
 *   We deliberately use almost no **band average**: that stays high for all vowels and was
 *   keeping you stuck on "happy".
 * - **Happy** when **loudness spikes above a slow baseline** (syllable edges), not when level
 *   sits flat high — flat TTS used to keep `instant ≈ peakHold` forever → stuck on happy.
 * - **Surprised** during steady voiced segments (baseline catches up, “excess” drops).
 * - **Idle** when instant + speech body are low (tiny pauses).
 */
const BMO_TTS_MOUTH_ENERGY_GAIN = 4.35;
/** Voice-ish bins for ~48 kHz / 2048 FFT: bin ~4 → ~94 Hz, cap ~3 kHz. */
const BMO_TTS_FREQ_BIN_START = 4;
const BMO_TTS_FREQ_BIN_END = 128;
/** Slow baseline under instant; higher = baseline lags more → more happy vs mostly surprised. */
const BMO_TTS_BASELINE_EMA = 0.946;
/** Decay on the spike memory of (instant − baseline); lower = snappier surprised between hits. */
const BMO_TTS_EXCESS_PEAK_DECAY = 0.73;
/** Excess must be this close to its decaying peak to count as a hit (higher = shorter happy). */
const BMO_TTS_EXCESS_NEAR_PEAK_FRAC = 0.75;
/** Minimum “bump” above baseline to open happy (noise gate on spikes). */
const BMO_TTS_MIN_EXCESS_HAPPY = 0.022;
/** Slow envelope mix: speech present vs gap (surprised vs idle). */
const BMO_TTS_SPEECH_BODY_EMA = 0.86;

const bmoPageForTts = document.getElementById("bmo-page");

let bmoTtsMouthRaf = null;
let bmoTtsMouthTime = null;
let bmoTtsMouthFreq = null;
let bmoTtsBaseline = 0;
let bmoTtsExcessPeak = 0;
let bmoTtsSpeechBody = 0;
let bmoTtsEmotion = "idle";

function bmoComputeTtsInstant01(ttsA, timeBuf, freqBuf) {
  ttsA.getByteTimeDomainData(timeBuf);
  let rms = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    const v = (timeBuf[i] - 128) / 128;
    rms += v * v;
  }
  rms = Math.sqrt(rms / timeBuf.length);
  const rms01 = Math.min(1, rms * BMO_TTS_MOUTH_ENERGY_GAIN);

  ttsA.getByteFrequencyData(freqBuf);
  const i0 = Math.min(BMO_TTS_FREQ_BIN_START, freqBuf.length);
  const i1 = Math.min(BMO_TTS_FREQ_BIN_END, freqBuf.length);
  let peak = 0;
  for (let i = i0; i < i1; i++) {
    const b = freqBuf[i];
    if (b > peak) peak = b;
  }
  const bandPeak = peak / 255;

  /* RMS + FFT peak: tiny bit more peak helps happy fire on spectral hits without flattening prosody. */
  return Math.min(1, rms01 * 0.9 + bandPeak * 0.3);
}

/**
 * nearPeak: true when loudness is spiking above the slow baseline (not sustained flat).
 * speechBody: slow level for "still talking" vs tiny gaps → surprised vs idle.
 */
function bmoStepTtsEmotion(nearPeak, speechBody, instant, prev) {
  const idleCut = 0.052;
  const idleCutHyst = 0.062;

  if (prev === "happy") {
    if (speechBody < idleCut && instant < 0.06) return "idle";
    if (!nearPeak) return "surprised";
    return "happy";
  }
  if (prev === "surprised") {
    if (speechBody < idleCut && instant < 0.055) return "idle";
    if (nearPeak) return "happy";
    return "surprised";
  }
  if (speechBody > idleCutHyst || instant > 0.085) return "surprised";
  if (nearPeak) return "happy";
  return "idle";
}

function stopBmoTtsMouthAnimation() {
  if (bmoTtsMouthRaf) {
    cancelAnimationFrame(bmoTtsMouthRaf);
    bmoTtsMouthRaf = null;
  }
  bmoPageForTts?.classList.remove("bmo-tts-mouth");
  document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-emotion");
  document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-face-track");
  bmoTtsBaseline = 0;
  bmoTtsExcessPeak = 0;
  bmoTtsSpeechBody = 0;
  bmoTtsEmotion = "idle";
}

function tickBmoTtsMouth() {
  if (!bmoPageForTts?.classList.contains("bmo-tts-mouth")) {
    stopBmoTtsMouthAnimation();
    return;
  }
  if (!document.body.classList.contains("bmo-open")) {
    stopBmoTtsMouthAnimation();
    return;
  }
  const smileSvg = document.getElementById("bmo-smile-svg");
  const ttsA = ttsByMode.bmo.analyser;
  const bmoOut = document.getElementById("bmo-audio");
  if (!smileSvg || !ttsA) {
    stopBmoTtsMouthAnimation();
    return;
  }
  const webAudioTtsPlaying = activeMainTtsBufferSources.length > 0;
  if (
    !bmoOut ||
    (!webAudioTtsPlaying &&
      !mainTtsPlaybackActive &&
      (bmoOut.paused || bmoOut.ended))
  ) {
    stopBmoTtsMouthAnimation();
    return;
  }
  if (!bmoTtsMouthTime || bmoTtsMouthTime.length !== ttsA.fftSize) {
    bmoTtsMouthTime = new Uint8Array(ttsA.fftSize);
  }
  if (!bmoTtsMouthFreq || bmoTtsMouthFreq.length !== ttsA.frequencyBinCount) {
    bmoTtsMouthFreq = new Uint8Array(ttsA.frequencyBinCount);
  }

  const instant = bmoComputeTtsInstant01(ttsA, bmoTtsMouthTime, bmoTtsMouthFreq);
  bmoTtsBaseline =
    bmoTtsBaseline * BMO_TTS_BASELINE_EMA + instant * (1 - BMO_TTS_BASELINE_EMA);
  const excess = Math.max(0, instant - bmoTtsBaseline);
  bmoTtsExcessPeak = Math.max(excess, bmoTtsExcessPeak * BMO_TTS_EXCESS_PEAK_DECAY);
  const nearPeak =
    excess >= bmoTtsExcessPeak * BMO_TTS_EXCESS_NEAR_PEAK_FRAC &&
    excess >= BMO_TTS_MIN_EXCESS_HAPPY;
  bmoTtsSpeechBody =
    bmoTtsSpeechBody * BMO_TTS_SPEECH_BODY_EMA + instant * (1 - BMO_TTS_SPEECH_BODY_EMA);
  bmoTtsEmotion = bmoStepTtsEmotion(nearPeak, bmoTtsSpeechBody, instant, bmoTtsEmotion);
  smileSvg.setAttribute("data-bmo-tts-emotion", bmoTtsEmotion);

  bmoTtsMouthRaf = requestAnimationFrame(tickBmoTtsMouth);
}

async function startBmoTtsMouthAnimation() {
  if (!document.body.classList.contains("bmo-open") || !bmoPageForTts) return;
  try {
    await ensureMainAudioTtsGraph();
  } catch (e) {
    console.warn("BMO TTS graph", e);
    return;
  }
  if (!ttsByMode.bmo.analyser) return;
  bmoPageForTts.classList.add("bmo-tts-mouth");
  document.getElementById("bmo-smile-svg")?.setAttribute("data-bmo-tts-emotion", "idle");
  bmoTtsBaseline = 0;
  bmoTtsExcessPeak = 0;
  bmoTtsSpeechBody = 0;
  bmoTtsEmotion = "idle";
  if (bmoTtsMouthRaf) return;
  bmoTtsMouthRaf = requestAnimationFrame(tickBmoTtsMouth);
}

document.getElementById("bmo-audio")?.addEventListener("playing", () => {
  void startBmoTtsMouthAnimation();
});
document.getElementById("bmo-audio")?.addEventListener("pause", () => {
  /* Chunked TTS keeps <audio> paused while BufferSources play; do not kill the mouth on that pause. */
  if (activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive) return;
  stopBmoTtsMouthAnimation();
});
document.getElementById("bmo-audio")?.addEventListener("ended", () => {
  stopBmoTtsMouthAnimation();
});

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

/**
 * End continuous capture without uploading (e.g. switching to PTT). Clears the no-speech
 * timer so it cannot fire on the next `mediaRecorder` instance.
 */
function stopActiveMicCaptureSilently() {
  clearSpeechWaitTimerAndDetectRaf();
  if (mediaRecorder && mediaRecorder.state === "recording") {
    suppressNextUtterance = true;
    mediaRecorder.stop();
  }
  stopAllBrowserSpeechRecognizers();
}

/** Stop Web Speech + timers; does not remove the live partial bubble (used before /infer so we can promote the same node). */
function abortBrowserSpeechRecognizers() {
  if (interruptDetectNoResultWatchdogTimer != null) {
    clearTimeout(interruptDetectNoResultWatchdogTimer);
    interruptDetectNoResultWatchdogTimer = null;
  }
  if (browserAsrMainEndRecoveryTimer != null) {
    clearTimeout(browserAsrMainEndRecoveryTimer);
    browserAsrMainEndRecoveryTimer = null;
  }
  if (browserAsrStuckDebugEnabled()) {
    logBrowserAsrStuckEvent("abortBrowserSpeechRecognizers");
  }
  stopBrowserAsrStuckWatchdog();
  if (mainBrowserSilenceTimer != null) {
    clearTimeout(mainBrowserSilenceTimer);
    mainBrowserSilenceTimer = null;
  }
  [mainBrowserRecognition, interruptDetectRecognition, postInterruptRecognition].forEach(
    (r) => {
      if (!r) return;
      try {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.abort();
      } catch {
        try {
          r.stop();
        } catch {}
      }
    }
  );
  mainBrowserRecognition = null;
  interruptDetectRecognition = null;
  postInterruptRecognition = null;
  interruptBrowserDetectActive = false;
  interruptPartialAccumMs = 0;
  interruptPartialLastChangeAt = 0;
  interruptPartialLastText = "";
  interruptBargeInLatched = false;
  mainBrowserFinalTranscript = "";
  mainBrowserFinalizeKind = "main";
  mainBrowserLastInterim = "";
}

function stopAllBrowserSpeechRecognizers() {
  abortBrowserSpeechRecognizers();
  try {
    if (mainBrowserLiveBubble?.isConnected) {
      mainBrowserLiveBubble.remove();
    }
  } catch (_) {}
  mainBrowserLiveBubble = null;
  clearInterruptDetectionBubble();
}

/**
 * Two separate `SpeechRecognition` instances: `mainBrowserRecognition` (user turn) and
 * `interruptDetectRecognition` (barge-in while assistant speaks). Chrome only reliably allows
 * one active session at a time — they are sequenced (main aborted before /infer; interrupt starts
 * at TTS `onPlayStart`; main restarts after playback ends).
 *
 * Leaked interrupt-detect handles block main `onend` recovery; we abort stale ones only when the
 * assistant is not still in a reply (`waveState !== "speaking"` and `!isAssistantTtsPlaying()`).
 * Do not tear down between streamed TTS chunks: `waveState` stays `"speaking"` even when buffers
 * are momentarily empty.
 */
function tearDownLeakedInterruptDetectSpeechRecognitionIfIdle() {
  if (!interruptDetectRecognition || interruptBargeInLatched) return;
  if (waveState === "speaking") return;
  if (isAssistantTtsPlaying()) return;
  try {
    interruptDetectRecognition.abort();
  } catch {}
  interruptDetectRecognition = null;
  interruptBrowserDetectActive = false;
  clearInterruptDetectionBubble();
}

/** After main SR `onend` or tab visible: restart main capture if we still expect desktop browser ASR. */
function maybeResumeMainBrowserSpeechRecognition(reason) {
  if (!listening || processing || inputMuted) return;
  if (waveState === "speaking") return;
  if (isAssistantTtsPlaying()) return;
  if (listeningMode !== "continuous" || !browserAsrPreferred()) return;
  tearDownLeakedInterruptDetectSpeechRecognitionIfIdle();
  if (mainBrowserRecognition || interruptDetectRecognition || postInterruptRecognition) return;
  console.info(`[BrowserASR] resume main SpeechRecognition (${reason})`);
  startListening();
}

function scheduleMainBrowserEndOfUtterance() {
  if (inputMuted) return;
  if (mainBrowserSilenceTimer != null) {
    clearTimeout(mainBrowserSilenceTimer);
    mainBrowserSilenceTimer = null;
  }
  const snap = (mainBrowserFinalTranscript + "").trim();
  mainBrowserSilenceTimer = setTimeout(() => {
    mainBrowserSilenceTimer = null;
    const cur = (mainBrowserFinalTranscript + "").trim();
    if (cur !== snap || cur.length === 0) {
      if (browserAsrStuckDebugEnabled()) {
        logBrowserAsrStuckEvent("silence_timer_fired_no_finalize", {
          reason: cur.length === 0 ? "empty_final" : "final_transcript_changed_since_schedule",
          snapAtSchedule: snap.slice(0, 80),
          curFinalNow: cur.slice(0, 80),
          interimNow: (mainBrowserLastInterim || "").slice(0, 80),
          finalizeKind: mainBrowserFinalizeKind,
        });
      }
      return;
    }
    const finalizeNow = () => {
      const cur2 = (mainBrowserFinalTranscript + "").trim();
      if (cur2.length === 0) return;
      logPartialAsrUtteranceDone(cur2, {
        reason: "silence-timer",
        mode: mainBrowserFinalizeKind === "interrupt" ? "interrupt" : "main"
      });
      if (mainBrowserFinalizeKind === "interrupt") {
        void finalizeInterruptBrowserTranscript(cur2);
      } else {
        void finalizeMainBrowserTranscript(cur2);
      }
    };
    finalizeNow();
  }, browserAsrMainSilenceMs);
  logVeraSettings("schedule_asr_silence_timer", {
    ms: browserAsrMainSilenceMs,
    asr_mode: getVeraAsrMode()
  });
}

function updateMainBrowserLiveBubble(fullText, interim) {
  if (mainAsrPartialMinChars === Infinity) return;
  const convo = uiEl("conversation");
  if (!convo) return;
  const line = (fullText + interim).trim();
  const hasFinal = String(fullText || "").trim().length > 0;
  if (!hasFinal && line.length < mainAsrPartialMinChars) return;
  if (!line) return;
  if (!mainBrowserLiveBubble || !mainBrowserLiveBubble.isConnected) {
    mainBrowserLiveBubble = addBubble(line, "user", { path: "main-browser-partial" });
  } else {
    mainBrowserLiveBubble.textContent = line;
  }
  convo.scrollTop = convo.scrollHeight;
}

function removeMainBrowserLiveBubble() {
  if (mainBrowserLiveBubble?.isConnected) {
    mainBrowserLiveBubble.remove();
  }
  mainBrowserLiveBubble = null;
}

/** When partial min is Infinity: no live bubble during ASR; create/update once at finalize so the user sees text before /infer returns. */
function showDeferredMainBrowserUserBubbleIfNeeded(trimmed) {
  if (mainAsrPartialMinChars !== Infinity) return;
  const t = String(trimmed ?? "").trim();
  if (!t) return;
  const convo = uiEl("conversation");
  if (!convo) return;
  if (!mainBrowserLiveBubble?.isConnected) {
    mainBrowserLiveBubble = addBubble(t, "user", { path: "main-browser-partial" });
  } else {
    mainBrowserLiveBubble.textContent = t;
  }
  convo.scrollTop = convo.scrollHeight;
}

/**
 * Work-mode `/infer` after optional reasoning: infer starts once the reasoning summary (voice coach)
 * is ready, overlapping the markdown tail. Upload failures skip `/infer` after the gate opens.
 * @param {object} [inferOpts]
 * @param {boolean} [inferOpts.skipPreInferPlaybackReset] When true, do not stop ongoing stage‑1 / other reply audio
 *   before `/infer` (deferred stage‑2 after the user may already be in another response).
 * @param {boolean} [inferOpts.stage2AlsoPrefix] When true, server brief-completion prompt asks the model to begin with "Also,".
 */
async function runInferAfterWorkModeReasoningPrep(formData, prep, inferOpts = {}) {
  const p = prep || {};
  await p.inferGate;
  if (p.reasoningUploadState?.failed) return "reasoning-upload-failed";
  // Snapshot was taken before reasoning prep; after the summary gate the panel often has much more
  // markdown. Refresh so /infer grounding matches what the user sees (and Voice UI excerpts stay aligned).
  try {
    if (isVeraWorkModeOn() && formData instanceof FormData) {
      const pinned = String(p.turnContext?.turn_lane_id || "").trim();
      const snap = JSON.stringify(
        buildClientContextSnapshot({
          pinnedLaneId: pinned,
          weakVoiceOnly: Boolean(pinned),
          frozenTurnLaneId: pinned
        })
      );
      if (typeof formData.set === "function") formData.set("context_snapshot", snap);
      else {
        try {
          formData.delete("context_snapshot");
        } catch (_) {}
        formData.append("context_snapshot", snap);
      }
      attachWorkModeReasoningContextToInferFormData(formData, prep);
      attachWorkModeVoiceBriefCompletionFlag(formData, prep);
      if (inferOpts.stage2AlsoPrefix) {
        if (typeof formData.set === "function") formData.set("work_mode_stage2_also_prefix", "1");
        else formData.append("work_mode_stage2_also_prefix", "1");
      }
    }
  } catch (_) {}
  if (!inferOpts.skipPreInferPlaybackReset) {
    try {
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch (_) {}
    cancelMainTtsPlayback();
    try {
      const a = getAudioEl();
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
    } catch (_) {}
  }
  await runInferMainPipeline(formData, {
    ...inferOpts,
    ttsTurn: prep?.ttsTurn,
    prep,
    ttsStage: 2
  });
  await p.chain;
}

function maybePlayWorkModeReasoningStage1FromPrep(prep, abortSignal, userTranscript) {
  const vs = prep?.voiceTwoStage;
  if (!vs?.reasoningRouted || !vs.stage1AckText) return Promise.resolve();
  return maybePlayWorkModeReasoningStage1VeraTts(
    vs.stage1AckText,
    abortSignal,
    userTranscript,
    prep?.ttsTurn
  );
}

async function finalizeMainBrowserTranscript(text) {
  const trimmed = (text || "").trim();
  if (inputMuted) {
    stopAllBrowserSpeechRecognizers();
    processing = false;
    voiceUxTurn = null;
    showMutedStatusIfIdle();
    return;
  }
  if (!trimmed) {
    stopAllBrowserSpeechRecognizers();
    processing = false;
    voiceUxTurn = null;
    if (listeningMode === "continuous" && listening && !inputMuted) {
      startListening();
    }
    return;
  }
  if (await maybeHandleWorkChecklistSyncShortcut(trimmed)) {
    return;
  }
  if (await maybeHandleWorkChecklistPlanShortcut(trimmed)) {
    return;
  }

  /* Set before stopAll so a sync SpeechRecognition "onend" cannot restart ASR while we're entering infer. */
  processing = true;
  requestInFlight = true;
  beginVoiceUxTurn();
  waveState = "idle";
  setStatus("Thinking", "thinking");

  /* Keep partial bubble in DOM; commitServerUserTranscriptBubble updates the same node when /infer returns. */
  abortBrowserSpeechRecognizers();
  showDeferredMainBrowserUserBubbleIfNeeded(trimmed);
  // Arm pending news bubble BEFORE POST /infer using the final browser-ASR
  // transcript — the bubble appears during the search round-trip, not after
  // it. For server-ASR (audio-upload) paths, runInferMainPipeline's
  // formData fallback below still arms when the transcript becomes known.
  armPendingNewsStatusBubble(trimmed);

  const formData = new FormData();
  formData.append("transcript", trimmed);
  formData.append("use_browser_asr", "1");
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());
  formData.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
  if (listeningMode === "ptt") {
    formData.append("mode", "ptt");
  }
  formData.append("stream_tts", shouldStreamTts() ? "1" : "0");

  const voiceFiles = getWorkModePendingAttachmentFiles();
  const voiceAttach = voiceFiles[0] || null;
  const turnContext = createWorkModeFrozenTurnContext({
    userText: trimmed,
    source: voiceFiles.length ? "upload" : "voice"
  });
  appendWorkModeSubmissionLaneToFormData(formData, turnContext?.turn_lane_id);

  for (const f of voiceFiles) {
    const forInfer = f.slice(0, f.size, f.type || undefined);
    formData.append("context_files", forInfer, f.name || "upload");
  }

  logVoiceTranscript("final", trimmed, { path: "main-browser-asr" });
  logFinalTranscriptSentToLlm("main-browser-asr", trimmed);
  attachPipelineAbortSignal();
  const pipelineSig = activePipelineAbort.signal;
  logComposerAttachmentsBeforeSubmit(voiceFiles, turnContext);
  const prepP = maybePrepareWorkModeReasoning(formData, trimmed, pipelineSig, {
    attachments: voiceFiles,
    turnContext
  });
  try {
    const runTurn = async () => {
      bumpWorkModeVoiceInferTurnSeq();
      const ttsTurn = workModeTtsMetaFromTurnContext(turnContext);
      const prep = attachWorkModeTtsTurnAfterPrep(await prepP, ttsTurn, trimmed);
      if (prep?.inferThreadAnchor) formData.append("thread_follow_up_anchor", prep.inferThreadAnchor);
      if (prep?.voiceTwoStage?.reasoningRouted) {
        const stage1P = maybePlayWorkModeReasoningStage1FromPrep(prep, pipelineSig, trimmed);
        await Promise.resolve(stage1P).catch(() => {});
        const seqAtStage1End = workModeVoiceInferTurnSeq;
        scheduleWorkModeDeferredReasoningStageTwoInfer({
          formData,
          prep,
          seqAtStage1End
        });
        resumeAfterAssistantReplyPlayback();
        return undefined;
      }
      const prepFail = await runInferAfterWorkModeReasoningPrep(formData, prep, { signal: pipelineSig });
      return prepFail;
    };
    if (isVeraWorkModeOn()) {
      await enqueueWorkModeVoiceInferPlaybackTurn(runTurn);
    } else {
      await runTurn();
    }
  } catch (voiceTurnErr) {
    if (voiceFiles.length) preserveComposerAttachments("voice_turn_throw", turnContext);
    throw voiceTurnErr;
  }
}

function startMainBrowserRecognitionContinuous() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (inputMuted) {
    stopAllBrowserSpeechRecognizers();
    showMutedStatusIfIdle();
    return;
  }

  stopAllBrowserSpeechRecognizers();
  mainBrowserFinalizeKind = "main";

  mainBrowserFinalTranscript = "";
  let interimBuf = "";

  mainBrowserRecognition = new SR();
  mainBrowserRecognition.continuous = true;
  mainBrowserRecognition.interimResults = true;
  mainBrowserRecognition.lang = getSpeechRecognitionLang();

  mainBrowserRecognition.onresult = (event) => {
    if (inputMuted) {
      stopAllBrowserSpeechRecognizers();
      showMutedStatusIfIdle();
      return;
    }
    browserAsrMainNetworkRetries = 0;
    markBrowserAsrResult("main");
    interimBuf = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        const piece = r[0].transcript;
        mainBrowserFinalTranscript += piece;
        logPartialAsrSegmentFinal(piece.trim(), { mode: "main" });
      } else {
        interimBuf += r[0].transcript;
      }
    }
    mainBrowserLastInterim = interimBuf;
    const wasSpoken = hasSpoken;
    hasSpoken = mainBrowserFinalTranscript.trim().length > 0 || interimBuf.trim().length > 0;
    if (hasSpoken && !wasSpoken) {
      armVoiceMaxDurationTimer("browser_asr_first_partial_main");
    }
    if (hasSpoken && speechWaitTimeoutId != null) {
      clearTimeout(speechWaitTimeoutId);
      speechWaitTimeoutId = null;
    }
    updateMainBrowserLiveBubble(mainBrowserFinalTranscript, interimBuf);
    scheduleMainBrowserEndOfUtterance();
  };

  mainBrowserRecognition.onerror = (ev) => {
    if (browserAsrStuckDebugEnabled()) {
      logBrowserAsrStuckEvent("main onerror", { error: ev.error, message: ev.message });
    }
    if (ev.error === "aborted" || ev.error === "no-speech") return;
    if (ev.error === "network") {
      if (browserAsrMainNetworkRetries < BROWSER_ASR_MAIN_NETWORK_RETRY_MAX) {
        browserAsrMainNetworkRetries++;
        console.warn("[BrowserASR] network — retrying SpeechRecognition", browserAsrMainNetworkRetries);
        window.setTimeout(() => {
          if (!listening || processing || inputMuted) return;
          if (listeningMode !== "continuous" || !browserAsrPreferred()) return;
          startListening();
        }, 750);
        return;
      }
    }
    console.warn("[BrowserASR]", ev.error);
    if (isFatalBrowserSpeechError(ev.error)) {
      disableBrowserAsrForSession(ev.error);
      stopAllBrowserSpeechRecognizers();
      processing = false;
      voiceUxTurn = null;
      if (listeningMode === "continuous" && listening && !inputMuted) {
        setStatus("Use http://localhost or HTTPS for live captions — using mic recording", "recording");
        startListening();
      }
    }
  };

  mainBrowserRecognition.onend = () => {
    logBrowserAsrStuckEvent(
      "main onend (session ended — if unexpected while listening, partial ASR may look stuck)",
      { note: "scheduling guarded recovery if still in continuous listen mode" }
    );
    mainBrowserRecognition = null;
    /* Intentionally no synchronous restart: abort/stop during infer must not recreate SR. After natural end
       (common after long TTS gaps), renew listening once if we still expect continuous browser ASR. */
    if (browserAsrMainEndRecoveryTimer != null) {
      clearTimeout(browserAsrMainEndRecoveryTimer);
      browserAsrMainEndRecoveryTimer = null;
    }
    browserAsrMainEndRecoveryTimer = window.setTimeout(() => {
      browserAsrMainEndRecoveryTimer = null;
      maybeResumeMainBrowserSpeechRecognition("main-onend");
    }, 420);
  };

  try {
    mainBrowserRecognition.start();
    beginBrowserAsrStuckSession("main");
  } catch (e) {
    console.warn("[BrowserASR] start failed", e);
    window.setTimeout(() => {
      if (!listening || processing || inputMuted) return;
      if (listeningMode !== "continuous" || !browserAsrPreferred()) return;
      startListening();
    }, 150);
  }

  if (MAX_WAIT_FOR_BROWSER_ASR_INITIAL_MS > 0) {
    speechWaitTimeoutId = setTimeout(() => {
      speechWaitTimeoutId = null;
      if (!hasSpoken) {
        stopAllBrowserSpeechRecognizers();
        processing = false;
        voiceUxTurn = null;
      }
    }, MAX_WAIT_FOR_BROWSER_ASR_INITIAL_MS);
  }
}

function startInterruptBrowserPartialDetection() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (inputMuted) {
    stopAllBrowserSpeechRecognizers();
    showMutedStatusIfIdle();
    return;
  }

  if (interruptDetectNoResultWatchdogTimer != null) {
    clearTimeout(interruptDetectNoResultWatchdogTimer);
    interruptDetectNoResultWatchdogTimer = null;
  }

  clearInterruptDetectionBubble();
  interruptBargeInLatched = false;

  try {
    if (interruptDetectRecognition) {
      interruptDetectRecognition.abort();
    }
  } catch {}

  interruptDetectRecognition = new SR();
  interruptDetectRecognition.continuous = true;
  interruptDetectRecognition.interimResults = true;
  interruptDetectRecognition.lang = getSpeechRecognitionLang();

  let lastCombined = "";
  interruptPartialAccumMs = 0;
  interruptPartialLastChangeAt = 0;
  interruptPartialLastText = "";
  interruptPartialRafTime = performance.now();
  interruptBrowserDetectActive = true;

  let hadAnyResult = false;

  interruptDetectRecognition.onresult = (event) => {
    if (inputMuted) {
      stopAllBrowserSpeechRecognizers();
      showMutedStatusIfIdle();
      return;
    }
    if (!interruptBrowserDetectActive) return;
    hadAnyResult = true;

    if (interruptBargeInLatched) {
      markBrowserAsrResult("interrupt-live");
      let interimBuf = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          const piece = r[0].transcript;
          mainBrowserFinalTranscript += piece;
          logPartialAsrSegmentFinal(piece.trim(), { mode: "interrupt-live" });
        } else {
          interimBuf += r[0].transcript;
        }
      }
      mainBrowserLastInterim = interimBuf;
      const _wasSpokenPostInterrupt = hasSpoken;
      hasSpoken =
        mainBrowserFinalTranscript.trim().length > 0 || interimBuf.trim().length > 0;
      if (hasSpoken && !_wasSpokenPostInterrupt) {
        armVoiceMaxDurationTimer("browser_asr_first_partial_post_interrupt");
      }
      if (hasSpoken && speechWaitTimeoutId != null) {
        clearTimeout(speechWaitTimeoutId);
        speechWaitTimeoutId = null;
      }
      updateMainBrowserLiveBubble(mainBrowserFinalTranscript, interimBuf);
      interruptPartialLastText = (mainBrowserFinalTranscript + interimBuf).trim();
      scheduleMainBrowserEndOfUtterance();
      return;
    }

    let finalP = "";
    let interim = "";
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        finalP += r[0].transcript;
      } else {
        interim += r[0].transcript;
      }
    }
    const combined = (finalP + interim).trim();
    const now = performance.now();
    if (combined.length < 1) {
      if (
        interruptPartialLastChangeAt &&
        now - interruptPartialLastChangeAt > browserAsrInterruptGapMs
      ) {
        interruptPartialAccumMs = 0;
        interruptPartialLastText = "";
      }
      interruptPartialRafTime = now;
      return;
    }

    if (combined !== lastCombined) {
      if (interruptPartialLastChangeAt > 0) {
        const d = Math.min(Math.max(now - interruptPartialLastChangeAt, 0), 250);
        interruptPartialAccumMs += d;
      } else {
        interruptPartialAccumMs = 0;
      }
      interruptPartialLastChangeAt = now;
      lastCombined = combined;
      interruptPartialLastText = combined;
      markBrowserAsrResult("interrupt-detect");

      updateInterruptDetectionBubble(combined);

      const wc = countSpeechWords(combined);
      lastInterruptProbe = {
        interruptGate: "browser_partial_asr_words",
        interruptReason: "browser_partial_asr_words",
        wordCount: wc,
        minWords: interruptBrowserMinWords,
        partialAccumMs: interruptPartialAccumMs,
        sustainMs: browserAsrInterruptSustainMs,
        partialText: combined,
      };

      const wordGate = wc >= interruptBrowserMinWords;
      const sustainGate = wc >= 1 && interruptPartialAccumMs >= browserAsrInterruptSustainMs;
      if (wordGate || sustainGate) {
        onBrowserInterruptBargeInFromDetect(event);
        interruptPartialRafTime = now;
        return;
      }
    } else if (
      interruptPartialLastChangeAt &&
      now - interruptPartialLastChangeAt > browserAsrInterruptGapMs
    ) {
      interruptPartialAccumMs = 0;
    }
    interruptPartialRafTime = now;
  };

  interruptDetectRecognition.onend = () => {
    if (interruptDetectNoResultWatchdogTimer != null) {
      clearTimeout(interruptDetectNoResultWatchdogTimer);
      interruptDetectNoResultWatchdogTimer = null;
    }
    logBrowserAsrStuckEvent("interrupt_detect onend", {
      note: "detector SR ended; barge-in live stream uses same object until abort",
    });
    interruptBrowserDetectActive = false;
    interruptDetectRecognition = null;
  };

  interruptDetectRecognition.onerror = (ev) => {
    if (browserAsrStuckDebugEnabled()) {
      logBrowserAsrStuckEvent("interrupt_detect onerror", {
        error: ev.error,
        message: ev.message,
      });
    }
    if (isFatalBrowserSpeechError(ev.error)) {
      disableBrowserAsrForSession(ev.error);
      try {
        interruptDetectRecognition?.abort();
      } catch {}
      interruptDetectRecognition = null;
      interruptBrowserDetectActive = false;
    }
  };

  try {
    interruptDetectRecognition.start();
    beginBrowserAsrStuckSession("interrupt-detect");
    interruptDetectNoResultWatchdogTimer = window.setTimeout(() => {
      interruptDetectNoResultWatchdogTimer = null;
      if (hadAnyResult || interruptBargeInLatched) return;
      if (!isAssistantTtsPlaying()) return;
      if (!interruptDetectRecognition) return;
      try {
        interruptDetectRecognition.abort();
      } catch {}
      interruptBrowserDetectActive = false;
      interruptDetectRecognition = null;
    }, 4000);
  } catch (e) {
    interruptBrowserDetectActive = false;
    try {
      interruptDetectRecognition?.abort();
    } catch {}
    interruptDetectRecognition = null;
  }
}

function startPostInterruptBrowserRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  if (inputMuted) {
    stopAllBrowserSpeechRecognizers();
    showMutedStatusIfIdle();
    return;
  }

  const seedTranscript = (interruptPartialLastText || "").trim();
  abortBrowserSpeechRecognizers();
  mainBrowserFinalTranscript = seedTranscript;
  mainBrowserFinalizeKind = "interrupt";

  let interimBuf = "";

  postInterruptRecognition = new SR();
  postInterruptRecognition.continuous = true;
  postInterruptRecognition.interimResults = true;
  postInterruptRecognition.lang = getSpeechRecognitionLang();

  postInterruptRecognition.onresult = (event) => {
    if (inputMuted) {
      stopAllBrowserSpeechRecognizers();
      showMutedStatusIfIdle();
      return;
    }
    markBrowserAsrResult("post-interrupt");
    interimBuf = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        const piece = r[0].transcript;
        mainBrowserFinalTranscript += piece;
        logPartialAsrSegmentFinal(piece.trim(), { mode: "post-interrupt" });
      } else {
        interimBuf += r[0].transcript;
      }
    }
    mainBrowserLastInterim = interimBuf;
    updateMainBrowserLiveBubble(mainBrowserFinalTranscript, interimBuf);
    scheduleMainBrowserEndOfUtterance();
  };

  postInterruptRecognition.onerror = (ev) => {
    if (browserAsrStuckDebugEnabled()) {
      logBrowserAsrStuckEvent("post-interrupt onerror", {
        error: ev.error,
        message: ev.message,
      });
    }
    if (isFatalBrowserSpeechError(ev.error)) {
      disableBrowserAsrForSession(ev.error);
      stopAllBrowserSpeechRecognizers();
      listening = true;
      startListening();
    }
  };

  postInterruptRecognition.onend = () => {
    logBrowserAsrStuckEvent("post-interrupt onend", {});
    postInterruptRecognition = null;
    mainBrowserRecognition = null;
  };

  mainBrowserRecognition = postInterruptRecognition;

  try {
    postInterruptRecognition.start();
    beginBrowserAsrStuckSession("post-interrupt");
  } catch (e) {
    listening = true;
    startListening();
  }
}

async function finalizeInterruptBrowserTranscript(text) {
  const trimmed = (text || "").trim();
  if (inputMuted) {
    stopAllBrowserSpeechRecognizers();
    processing = false;
    requestInFlight = false;
    showMutedStatusIfIdle();
    return;
  }
  if (!trimmed) {
    stopAllBrowserSpeechRecognizers();
    listening = true;
    startListening();
    return;
  }

  processing = true;
  requestInFlight = true;
  waveState = "idle";
  setStatus("Thinking", "thinking");

  abortBrowserSpeechRecognizers();
  showDeferredMainBrowserUserBubbleIfNeeded(trimmed);

  const formData = new FormData();
  formData.append("transcript", trimmed);
  formData.append("use_browser_asr", "1");
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());
  formData.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
  formData.append("mode", "interrupt");
  formData.append(
    "interrupt_debug",
    JSON.stringify({
      probe: lastInterruptProbe,
      browser_partial_asr: true,
      thresholds: {
        INTERRUPT_BROWSER_MIN_WORDS: interruptBrowserMinWords,
        BROWSER_ASR_INTERRUPT_SUSTAIN_MS: browserAsrInterruptSustainMs,
        BROWSER_ASR_INTERRUPT_GAP_MS: browserAsrInterruptGapMs,
      },
    })
  );
  formData.append("stream_tts", shouldStreamTts() ? "1" : "0");

  logVoiceTranscript("final", trimmed, { path: "interrupt-browser-asr" });
  logFinalTranscriptSentToLlm("interrupt-browser-asr", trimmed);
  await runInferInterruptPipeline(formData);
}

/* =========================
   START LISTENING
========================= */

function startListening() {
  if (!listening || processing) return;
  if (listeningMode === "continuous" && inputMuted) {
    showMutedStatusIfIdle();
    updateMuteInputButton();
    return;
  }
  clearSpeechWaitTimerAndDetectRaf();

  if (listeningMode === "continuous" && browserAsrPreferred()) {
    waveState = "listening";
    audioChunks = [];
    hasSpoken = false;
    lastVoiceTime = 0;
    setStatus("Listening…", "recording");
    const stBrowser = uiEl("status");
    if (stBrowser) stBrowser.title = "";
    updateMuteInputButton();
    startMainBrowserRecognitionContinuous();
    return;
  }

  waveState = "listening";
  audioChunks = [];
  hasSpoken = false;
  lastVoiceTime = 0;

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  mediaRecorder.onstop = handleUtterance;

  mediaRecorder.start();
  detectSpeech();

  if (MAX_WAIT_FOR_MEDIA_RECORDER_INITIAL_MS > 0) {
    speechWaitTimeoutId = setTimeout(() => {
      speechWaitTimeoutId = null;
      if (!hasSpoken && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    }, MAX_WAIT_FOR_MEDIA_RECORDER_INITIAL_MS);
  }

  updateMuteInputButton();
  setStatus("Listening…", "recording");
  const stEl = uiEl("status");
  if (stEl) {
    stEl.title =
      "Partial text needs Web Speech (HTTPS + a supported browser). Otherwise audio is sent after you pause speaking.";
  }
}

/* =========================
   INFER PIPELINE (shared: recorded audio or browser transcript)
========================= */

/** Completed non-NDJSON `/infer` JSON body for the main (non-interrupt) voice pipeline. */
async function processInferMainJsonPayload(data, inferTtfbMs, opts = {}) {
  const awaitStreamingPlayback = opts.awaitStreamingPlayback !== false;
  const serializeTtsPlayback = opts.serializeTtsPlayback !== false;
  const ttsTurn = opts.ttsTurn;
  const inferPrep = opts.prep;
  const inferSignal = opts.signal;
  const ttsStage = opts.ttsStage ?? 2;
  logInferLatency(data, "main", inferTtfbMs);
  requestInFlight = false;

  if (data.skip) {
    hideSidePanel();
    processing = false;
    getAudioEl()?.pause();

    if (listeningMode === "ptt") {
      setStatus("No voice detected", "idle");
    } else if (listeningMode === "continuous") {
      startListening();
    }

    return;
  }

  if (data.client_action === "mute_input") {
    hideSidePanel();
    voiceUxTurn = null;
    getAudioEl()?.pause();
    processing = false;
    setContinuousInputMuted(true);
    return;
  }
  applyClientUiAction(data.client_action);

  commitServerUserTranscriptBubble(data.transcript, "main-json");
  if (data.work_mode_timer) {
    applyWorkModeTimerPayload(data.work_mode_timer);
  }
  let playData =
    data && typeof data === "object"
      ? data
      : { reply: "", transcript: "", audio_url: "", audio_urls: [] };
  let stage2EffectivePack = null;
  if (
    inferPrep?.voiceTwoStage?.reasoningRouted &&
    ttsStage === 2 &&
    playData &&
    typeof playData === "object"
  ) {
    stage2EffectivePack = storeEffectiveStage2ReplyOnPrep(
      inferPrep,
      resolveEffectiveStage2Reply(inferPrep, playData.reply, ttsStage)
    );
    logStage2EffectiveReply(
      inferPrep,
      stage2EffectivePack,
      stage2EffectivePack.effective_stage2_reply,
      stage2EffectivePack.effective_stage2_reply
    );
    playData = { ...playData, reply: stage2EffectivePack.effective_stage2_reply };
    const stage2ReplyBack = buildWorkModeVoiceReplyBack({
      prep: inferPrep,
      userText: String(inferPrep?.turnContext?.user_text || playData?.transcript || "").trim()
    });
    ensureStage2VoiceBubble(
      inferPrep,
      stage2EffectivePack.effective_stage2_reply,
      stage2ReplyBack
    );
  }
  const isJsonWmStage2Voice = Boolean(inferPrep?.voiceTwoStage?.reasoningRouted && ttsStage === 2);
  if (isJsonWmStage2Voice) {
    const decision = getWorkModeStage2TtsDecision(playData?.reply || "");
    logStage2TtsDecision(inferPrep, decision);
    if (!decision.should_enqueue_tts) {
      logStage2Debug(inferPrep, {
        transcript: String(inferPrep?.turnContext?.user_text || playData?.transcript || "").trim(),
        reasoning_completed: true,
        reasoning_success: true,
        stage2_payload_valid: true,
        stage2_text: playData?.reply || "",
        stage2_tts_requested: false,
        stage2_tts_suppressed_due_to_mute: Boolean(decision.tts_muted),
        fallback_reason: decision.suppression_reason
      });
      if (!(inferPrep?.stage2VoiceBubble instanceof HTMLElement && inferPrep.stage2VoiceBubble.isConnected)) {
        applyAssistantReplyAndPanels(playData);
      }
      resumeAfterAssistantReplyPlayback();
      return;
    }
  }
  const playMainAnswerPromise = (async () => {
    resetAudioHandlers();
    try {
      const playTask = async () => {
        const playbackEnd = await waitForAssistantPlaybackEnd(() => {
          resumeAfterAssistantReplyPlayback();
        });
        const onPlayStart = () => {
          logVoiceFirstAudio("main-reply");
          logVoiceMainReplyAudio();
          if (!(inferPrep?.stage2VoiceBubble instanceof HTMLElement && inferPrep.stage2VoiceBubble.isConnected)) {
            applyAssistantReplyAndPanels(playData);
          }
          waveState = "speaking";
          audioStartedAt = performance.now();
          setStatus(
            listeningMode === "ptt" ? "Speaking" : "Speaking… (Interruptible)",
            "speaking"
          );
          startInterruptCapture();
        };
        await playTtsFromApi(playData, {
          onPlayStart,
          onPlayEnd: () => {
            playbackEnd.wrappedOnFinish();
          }
        });
        await playbackEnd.donePromise;
      };
      const textPreview = String(playData?.reply || "").slice(0, 80);
      if (serializeTtsPlayback) {
        await enqueueWorkModeAssistantTtsPlayback(playTask, ttsTurn, {
          stage: opts.ttsStage ?? 2,
          text: textPreview,
          prep: inferPrep,
          abortSignal: inferSignal
        });
      } else await playTask();
    } catch (e) {
      console.warn(e);
    }
  })();

  if (awaitStreamingPlayback) await playMainAnswerPromise;
  else void playMainAnswerPromise;
}

/** Pull the user transcript from /infer FormData, if present, so the pending
 *  news bubble can be armed at pipeline entry without waiting for NDJSON
 *  `meta.transcript`. Safe on FormData-less callers (returns ""). */
function _readInferFormDataTranscript(formData) {
  try {
    if (formData && typeof formData.get === "function") {
      const t = formData.get("transcript");
      if (typeof t === "string") return t;
    }
  } catch (_) {}
  return "";
}

async function runInferMainPipeline(formData, opts = {}) {
  // Earliest possible point inside the pipeline — fires BEFORE the network
  // round-trip when the caller pushed a transcript into FormData (browser
  // ASR + typed work-mode + interrupt voice). For server-ASR audio uploads
  // there is no transcript yet; the onMeta callback below still arms when
  // the server returns `meta.transcript`. armPendingNewsStatusBubble is
  // idempotent (dedupe via dataset.pendingForText), so a later arm with the
  // same text is a no-op.
  armPendingNewsStatusBubble(_readInferFormDataTranscript(formData));
  try {
    await flushWorkChecklistSyncBeforeCommand();
    logVoicePipe("POST /infer starting (main, upload in flight)");
    const inferFetchStart = performance.now();
    const inferSignal = opts.signal ?? attachPipelineAbortSignal();
    const ttsTurn = opts.ttsTurn;
    const inferPrep = opts.prep;
    const inferUserText = inferTranscriptFromFormData(formData);
    const stage2ReplyBack =
      isVeraWorkModeOn() &&
      appModePrefix() === "vera" &&
      inferPrep?.voiceTwoStage?.reasoningRouted &&
      opts.ttsStage === 2
        ? buildWorkModeVoiceReplyBack({ prep: inferPrep, userText: inferUserText })
        : null;
    const isWmStage2Voice =
      (opts.ttsStage ?? 2) === 2 && inferPrep?.voiceTwoStage?.reasoningRouted;
    /* Default on: wait for NDJSON / sentence TTS to finish so the next infer cannot start playback on top (pass false to opt out). */
    const awaitStreamingPlayback = opts.awaitStreamingPlayback !== false;
    /* Default true: consecutive voice/work-mode turns must not start NDJSON TTS until the prior reply finishes. */
    const serializeTtsPlayback = opts.serializeTtsPlayback !== false;
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData,
      signal: inferSignal
    });
    const inferTtfbMs = performance.now() - inferFetchStart;
    logVoicePipe("POST /infer response headers (main — TTFB)");

    const responseIsNdjson = res.ok && isNdjsonTtsResponse(res);
    const ttsSuppressedDueToMute =
      isWmStage2Voice
        ? getWorkModeStage2TtsDecision("").tts_muted
        : appModePrefix() === "vera" &&
          isVeraWorkModeOn() &&
          (isWorkModeMuteEnabled() || Boolean(inputMuted));
    if (responseIsNdjson) {
      requestInFlight = false;

      let ndjsonMeta = null;
          const streamReplyState = createNdjsonStreamingReplyState(stage2ReplyBack, {
            suppressReplyProgress: isWmStage2Voice
          });
          let wmStage2EffectivePack = null;
          const ndjsonPlaybackPromise = (async () => {
            try {
              console.log("[UX][TTS] NDJSON streaming (main)");
              await tryPeekApplyWorkModeTimerFromNdjsonClone(res);
              const ndjsonOpts = {
                onMeta: (meta) => {
                  ndjsonMeta = { ...ndjsonMeta, ...meta };
                  if (
                    !streamReplyState.pendingReplyBack &&
                    meta.work_mode_voice_brief_completion === true &&
                    meta.work_mode_voice_quote != null &&
                    String(meta.work_mode_voice_quote).trim()
                  ) {
                    const q = String(meta.work_mode_voice_quote).trim();
                    streamReplyState.pendingVoiceQuote = q;
                    streamReplyState.pendingReplyBack = {
                      reply_to_user_text: q,
                      reply_to_turn_id: "",
                      reply_to_lane_id: "",
                      reply_to_lane_title: "",
                      stage: 2
                    };
                  }
                  if (meta.work_mode_timer) {
                    applyWorkModeTimerPayload(meta.work_mode_timer);
                  }
                  applyWorkModeLaneDebugFromInferMeta(meta);
                  if (meta.transcript) {
                    applyNdjsonUserTranscriptBubble(meta.transcript, "main-ndjson");
                    // Arm pending news bubble for voice — we only know the
                    // utterance once the server returns the ASR transcript.
                    // Cancelled by applyNdjsonStreamingReplySoFar /
                    // finalizeNdjsonStreamingReply when the real reply hits.
                    armPendingNewsStatusBubble(meta.transcript);
                  }
                },
                onReplyProgress: (replySoFar) => {
                  applyNdjsonStreamingReplySoFar(replySoFar, streamReplyState);
                },
                onDone: (done) => {
                  logInferLatency(done, "main", inferTtfbMs);
                  let effectiveReply = String(done?.reply || "").trim();
                  if (isWmStage2Voice) {
                    wmStage2EffectivePack = storeEffectiveStage2ReplyOnPrep(
                      inferPrep,
                      resolveEffectiveStage2Reply(inferPrep, done?.reply, opts.ttsStage ?? 2)
                    );
                    effectiveReply = wmStage2EffectivePack.effective_stage2_reply;
                    streamReplyState.stage2EffectiveLocked = true;
                    logStage2EffectiveReply(
                      inferPrep,
                      wmStage2EffectivePack,
                      effectiveReply,
                      effectiveReply
                    );
                  }
                  if (inferPrep?.voiceTwoStage?.reasoningRouted && inferPrep?.turnContext) {
                    const tc = inferPrep.turnContext;
                    const wm = getWorkModeLaneHandoff(String(tc.turn_lane_id || "").trim());
                    console.info("[stage2_voice_generation]", {
                      turn_id: tc.turn_id || null,
                      lane_id: tc.turn_lane_id || null,
                      lane_title: String(tc.turn_lane_title || "").trim() || null,
                      current_user_text: String(tc.user_text || "").trim(),
                      turn_intent: tc.turn_intent || null,
                      main_context_type: wm?.main_context_type || null,
                      reasoning_summary_preview: previewWorkModeRegistryText(
                        wm?.latest_reasoning_summary || ""
                      ),
                      generated_stage2_text: String(
                        wmStage2EffectivePack?.generated_stage2_text ?? done?.reply ?? ""
                      ).slice(0, 500),
                      effective_stage2_reply: effectiveReply,
                      used_tts_fallback: Boolean(wmStage2EffectivePack?.used_override),
                      tts_override_reason: wmStage2EffectivePack?.override_reason ?? null
                    });
                    logStage2Debug(inferPrep, {
                      transcript: inferUserText,
                      reasoning_completed: true,
                      reasoning_success: true,
                      stage2_payload_valid: true,
                      stage2_text: effectiveReply,
                      stage2_tts_requested: !ttsSuppressedDueToMute,
                      stage2_tts_suppressed_due_to_mute: ttsSuppressedDueToMute
                    });
                    try {
                      console.table([
                        {
                          turn_id: tc.turn_id,
                          lane_id: tc.turn_lane_id,
                          lane_title: String(tc.turn_lane_title || "").trim(),
                          turn_intent: tc.turn_intent,
                          main_context_type: wm?.main_context_type,
                          preview: previewWorkModeRegistryText(String(effectiveReply || ""))
                        }
                      ]);
                    } catch (_) {}
                  }
                  const replyBackForBubble =
                    streamReplyState.pendingReplyBack ||
                    stage2ReplyBack ||
                    buildWorkModeVoiceReplyBack({ prep: inferPrep, userText: inferUserText });
                  finalizeNdjsonStreamingReply(
                    ndjsonMeta,
                    { ...done, reply: effectiveReply },
                    streamReplyState
                  );
                  if (isWmStage2Voice && effectiveReply) {
                    const bubble = ensureStage2VoiceBubble(
                      inferPrep,
                      effectiveReply,
                      replyBackForBubble
                    );
                    if (bubble) streamReplyState.bubble = bubble;
                  }
                },
                onPlayStart: () => {
                  logVoiceFirstAudio("main-reply");
                  logVoiceMainReplyAudio();
                  applyActionPayload(ndjsonMeta);
                  waveState = "speaking";
                  audioStartedAt = performance.now();
                  setStatus(
                    listeningMode === "ptt" ? "Speaking" : "Speaking… (Interruptible)",
                    "speaking"
                  );
                  startInterruptCapture();
                }
              };
              const consumeNdjsonTextOnly = async () => {
                await runNdjsonTtsPlayback(res, {
                  ...ndjsonOpts,
                  skipAudio: true,
                  suppressReplyProgress: isWmStage2Voice
                });
              };
              const playTask = async () => {
                const playbackEnd = await waitForAssistantPlaybackEnd(() => {
                  resumeAfterAssistantReplyPlayback();
                });
                resetAudioHandlers();
                if (isWmStage2Voice) {
                  await runNdjsonTtsPlayback(res, {
                    ...ndjsonOpts,
                    skipAudio: true,
                    suppressReplyProgress: true
                  });
                  const phrase = String(
                    wmStage2EffectivePack?.effective_stage2_reply ||
                      inferPrep?.effectiveStage2Reply?.effective_stage2_reply ||
                      ""
                  ).trim();
                  const liveStage2TtsDecision = getWorkModeStage2TtsDecision(phrase);
                  logStage2TtsDecision(inferPrep, liveStage2TtsDecision);
                  if (phrase && liveStage2TtsDecision.should_enqueue_tts) {
                    await playWorkModeTtsOnlyPhrase(phrase, inferSignal);
                  } else if (phrase && liveStage2TtsDecision.tts_muted) {
                    logStage2Debug(inferPrep, {
                      transcript: inferUserText,
                      reasoning_completed: true,
                      reasoning_success: true,
                      stage2_payload_valid: true,
                      stage2_text: phrase,
                      stage2_tts_requested: false,
                      stage2_tts_suppressed_due_to_mute: true,
                      fallback_reason: liveStage2TtsDecision.suppression_reason
                    });
                  }
                  playbackEnd.wrappedOnFinish();
                } else if (ttsSuppressedDueToMute) {
                  await runNdjsonTtsPlayback(res, {
                    ...ndjsonOpts,
                    skipAudio: true
                  });
                  playbackEnd.wrappedOnFinish();
                } else {
                  await runNdjsonTtsPlayback(res, {
                    ...ndjsonOpts,
                    onPlayEnd: () => {
                      playbackEnd.wrappedOnFinish();
                    }
                  });
                }
                await playbackEnd.donePromise;
              };
              const textPreview = isWmStage2Voice ? "(wm-stage2)" : "";
              if (isWmStage2Voice) {
                const preDecision = getWorkModeStage2TtsDecision("(pending-stage2-text)");
                if (preDecision.tts_muted) {
                  logStage2TtsDecision(inferPrep, {
                    ...preDecision,
                    stage2_text_present: true,
                    should_enqueue_tts: false
                  });
                  await consumeNdjsonTextOnly();
                  resumeAfterAssistantReplyPlayback();
                } else if (serializeTtsPlayback) {
                  await enqueueWorkModeAssistantTtsPlayback(playTask, ttsTurn, {
                    stage: opts.ttsStage ?? 2,
                    text: textPreview,
                    prep: inferPrep,
                    onDrop: consumeNdjsonTextOnly,
                    abortSignal: inferSignal
                  });
                } else await playTask();
              } else if (serializeTtsPlayback) {
                await enqueueWorkModeAssistantTtsPlayback(playTask, ttsTurn, {
                  stage: opts.ttsStage ?? 2,
                  text: textPreview,
                  prep: inferPrep,
                  onDrop: consumeNdjsonTextOnly,
                  abortSignal: inferSignal
                });
              } else await playTask();
        } catch (e) {
          if (e?.name !== "AbortError") {
            console.warn("[UX][TTS] NDJSON main playback failed", e);
            processing = false;
            requestInFlight = false;
            voiceUxTurn = null;
            if (listeningMode === "continuous" && listening && !inputMuted) {
              setStatus("Reply playback failed — try again", "offline");
              startListening();
            } else {
              setStatus("Ready", "idle");
            }
            updateMuteInputButton();
          }
        }
      })();
      if (awaitStreamingPlayback) await ndjsonPlaybackPromise;
      else void ndjsonPlaybackPromise;
      return;
    }

    const data = await res.json();
    await processInferMainJsonPayload(data, inferTtfbMs, {
      awaitStreamingPlayback,
      serializeTtsPlayback,
      ttsTurn,
      prep: inferPrep,
      ttsStage: opts.ttsStage ?? 2,
      signal: inferSignal
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      hideSidePanel();
      processing = false;
      requestInFlight = false;
      cancelPendingNewsStatusBubble("abort");
      return;
    }
    hideSidePanel();
    processing = false;
    requestInFlight = false;
    setStatus("Server error", "offline");
    if (isWmStage2Voice) {
      logStage2Debug(inferPrep, {
        transcript: inferUserText,
        reasoning_completed: true,
        reasoning_success: false,
        stage2_payload_valid: false,
        stage2_error: e?.message || e,
        fallback_reason: "infer_main_error"
      });
    }
    if (!failPendingNewsStatusBubble("infer_main_error")) {
      void veraSurfaceLlmFetchFailure({ feature: "infer_main", error: e });
    }
  }
}

async function runInferInterruptPipeline(formData) {
  // Same early-arm policy as runInferMainPipeline so the placeholder appears
  // during the interrupt search/thinking window.
  armPendingNewsStatusBubble(_readInferFormDataTranscript(formData));
  try {
    logVoicePipe("POST /infer starting (interrupt, upload in flight)");
    const inferFetchStart = performance.now();
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData,
      signal: attachPipelineAbortSignal()
    });
    const inferTtfbMs = performance.now() - inferFetchStart;
    logVoicePipe("POST /infer response headers (interrupt)");

    if (shouldStreamTts() && res.ok && isNdjsonTtsResponse(res)) {
      requestInFlight = false;

      const runStream = async () => {
        let ndjsonMeta = null;
        const streamReplyState = createNdjsonStreamingReplyState();
        resetAudioHandlers();
        try {
          await runNdjsonTtsPlayback(res, {
            onMeta: (meta) => {
              ndjsonMeta = { ...ndjsonMeta, ...meta };
              if (
                !streamReplyState.pendingReplyBack &&
                meta.work_mode_voice_brief_completion === true &&
                meta.work_mode_voice_quote != null &&
                String(meta.work_mode_voice_quote).trim()
              ) {
                const q = String(meta.work_mode_voice_quote).trim();
                streamReplyState.pendingVoiceQuote = q;
                streamReplyState.pendingReplyBack = {
                  reply_to_user_text: q,
                  reply_to_turn_id: "",
                  reply_to_lane_id: "",
                  reply_to_lane_title: "",
                  stage: 2
                };
              }
              if (meta.work_mode_timer) {
                applyWorkModeTimerPayload(meta.work_mode_timer);
              }
              if (meta.transcript) {
                applyNdjsonUserTranscriptBubble(meta.transcript, "interrupt-ndjson");
                armPendingNewsStatusBubble(meta.transcript);
              }
            },
            onReplyProgress: (replySoFar) => {
              applyNdjsonStreamingReplySoFar(replySoFar, streamReplyState);
            },
            onDone: (done) => {
              logInferLatency(done, "interrupt", inferTtfbMs);
              finalizeNdjsonStreamingReply(ndjsonMeta, done, streamReplyState);
            },
            onPlayStart: () => {
              logVoiceFirstAudio("main-reply");
              logVoiceMainReplyAudio();
              applyActionPayload(ndjsonMeta);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus("Speaking… (can only be interrupted once)", "speaking");
              processing = false;
            },
            onPlayEnd: () => {
              resumeListeningAfterInterruptPlayback();
            }
          });
        } catch (e) {
          if (e?.name !== "AbortError") console.warn(e);
        }
      };

      await runStream();
      return;
    }

    const data = await res.json();
    logInferLatency(data, "interrupt", inferTtfbMs);

    requestInFlight = false;

    if (data.skip) {
      hideSidePanel();
      processing = false;
      getAudioEl()?.pause();
      if (listeningMode === "ptt") {
        listening = false;
        waveState = "idle";
        setStatus("Ready", "idle");
        updateMuteInputButton();
        return;
      }
      listening = true;
      startListening();
      return;
    }

    if (data.client_action === "mute_input") {
      hideSidePanel();
      getAudioEl()?.pause();
      processing = false;
      listening = true;
      setContinuousInputMuted(true);
      return;
    }
    applyClientUiAction(data.client_action);

    commitServerUserTranscriptBubble(data.transcript, "interrupt-json");
    if (data.work_mode_timer) {
      applyWorkModeTimerPayload(data.work_mode_timer);
    }

    await playInterruptAnswer(data);
  } catch (e) {
    if (e?.name === "AbortError") {
      hideSidePanel();
      requestInFlight = false;
      processing = false;
      cancelPendingNewsStatusBubble("abort");
      return;
    }
    hideSidePanel();
    requestInFlight = false;
    setStatus("Server error", "offline");
    listening = true;
    if (!failPendingNewsStatusBubble("infer_interrupt_error")) {
      void veraSurfaceLlmFetchFailure({ feature: "infer_interrupt", error: e });
    }
  }
}

/* =========================
   HANDLE UTTERANCE
========================= */

async function handleUtterance() {
  if (suppressNextUtterance) {
    suppressNextUtterance = false;
    processing = false;
    audioChunks = [];
    hasSpoken = false;
    clearVoiceMaxDurationTimer();
    voiceUxTurn = null;
    showMutedStatusIfIdle();
    return;
  }
  /* Utterance is being handled now (uploaded or sent to /infer). Cap timer
     is bound to the recording session — clear it so it cannot fire
     mid-upload and double-stop. */
  clearVoiceMaxDurationTimer();

  if (listeningMode === "continuous" && inputMuted) {
    processing = false;
    audioChunks = [];
    hasSpoken = false;
    voiceUxTurn = null;
    showMutedStatusIfIdle();
    return;
  }

  if (listeningMode === "continuous" && !hasSpoken) {
    processing = false;
    voiceUxTurn = null;
    startListening();
    return;
  }

  const blob = new Blob(audioChunks, { type: "audio/webm" });

  if (blob.size < MIN_AUDIO_BYTES) {
    processing = false;
    voiceUxTurn = null;

    if (listeningMode === "continuous") {
      startListening();
    }

    return;
  }
  requestInFlight = true;
  processing = true;
  waveState = "idle";

  setStatus("Thinking", "thinking");

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());
  formData.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));

  if (listeningMode === "ptt") {
    formData.append("mode", "ptt");
  }
  formData.append("stream_tts", shouldStreamTts() ? "1" : "0");

  appendWorkModeSubmissionLaneToFormData(formData);

  /* Server ASR (MediaRecorder) path had no transcript before `/infer`, so work-mode reasoning prep
     never ran. Preflight ASR (transcribe_only), then reuse the browser-transcript + reasoning pipeline. */
  const useWorkModeServerAsrPreflight = isVeraWorkModeOn() && appModePrefix() === "vera";
  if (useWorkModeServerAsrPreflight) {
    try {
      attachPipelineAbortSignal();
      const pipelineSig = activePipelineAbort.signal;

      const preForm = new FormData();
      preForm.append("audio", blob);
      preForm.append("session_id", getSessionId());
      preForm.append("client", appModePrefix());
      preForm.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
      if (listeningMode === "ptt") {
        preForm.append("mode", "ptt");
      }
      preForm.append("stream_tts", "0");
      preForm.append("transcribe_only", "1");

      const preFetchStart = performance.now();
      const preRes = await fetch(`${API_URL}/infer`, {
        method: "POST",
        body: preForm,
        signal: pipelineSig
      });
      const preTtfbMs = performance.now() - preFetchStart;

      if (!preRes.ok) {
        hideSidePanel();
        processing = false;
        requestInFlight = false;
        voiceUxTurn = null;
        setStatus("Server error", "offline");
        void veraSurfaceLlmFetchFailure({
          feature: "infer_preflight",
          response: preRes
        });
        if (listeningMode === "continuous" && listening && !inputMuted) {
          startListening();
        }
        return;
      }

      const ct = (preRes.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("ndjson") || ct.includes("x-ndjson")) {
        try {
          await preRes.body?.cancel?.();
        } catch (_) {}
        await runInferMainPipeline(formData, { signal: pipelineSig });
        return;
      }

      let preData;
      try {
        preData = await preRes.json();
      } catch (parseErr) {
        hideSidePanel();
        processing = false;
        requestInFlight = false;
        voiceUxTurn = null;
        setStatus("Server error", "offline");
        void veraSurfaceLlmFetchFailure({
          feature: "infer_preflight_parse",
          error: parseErr
        });
        if (listeningMode === "continuous" && listening && !inputMuted) {
          startListening();
        }
        return;
      }

      if (!preData.preflight_only) {
        await processInferMainJsonPayload(preData, preTtfbMs);
        return;
      }

      const trimmed = String(preData.transcript || "").trim();
      if (!trimmed) {
        requestInFlight = false;
        processing = false;
        voiceUxTurn = null;
        if (listeningMode === "continuous" && listening && !inputMuted) {
          startListening();
        } else {
          setStatus("Ready", "idle");
        }
        return;
      }

      if (await maybeHandleWorkChecklistSyncShortcut(trimmed)) {
        requestInFlight = false;
        processing = false;
        voiceUxTurn = null;
        setStatus("Ready", "idle");
        updateMuteInputButton();
        return;
      }
      if (await maybeHandleWorkChecklistPlanShortcut(trimmed)) {
        requestInFlight = false;
        processing = false;
        voiceUxTurn = null;
        setStatus("Ready", "idle");
        updateMuteInputButton();
        return;
      }

      ensureChatStartedLayout();
      beginVoiceUxTurn();

      const voiceAttach2Files = getWorkModePendingAttachmentFiles();
      const turnContext = createWorkModeFrozenTurnContext({
        userText: trimmed,
        source: voiceAttach2Files.length ? "upload" : "voice"
      });

      const formData2 = new FormData();
      formData2.append("transcript", trimmed);
      formData2.append("use_browser_asr", "1");
      formData2.append("session_id", getSessionId());
      formData2.append("client", appModePrefix());
      formData2.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
      formData2.append("stream_tts", shouldStreamTts() ? "1" : "0");
      if (listeningMode === "ptt") {
        formData2.append("mode", "ptt");
      }

      appendWorkModeSubmissionLaneToFormData(formData2, turnContext?.turn_lane_id);

      if (voiceAttach2Files.length) {
        for (const f of voiceAttach2Files) {
          const forInfer2 = f.slice(0, f.size, f.type || undefined);
          formData2.append("context_files", forInfer2, f.name || "upload");
        }
      }

      logVoiceTranscript("final", trimmed, { path: "work-mode-server-asr" });
      logFinalTranscriptSentToLlm("work-mode-server-asr", trimmed);
      logComposerAttachmentsBeforeSubmit(voiceAttach2Files, turnContext);
      const prepP = maybePrepareWorkModeReasoning(formData2, trimmed, pipelineSig, {
        attachments: voiceAttach2Files,
        turnContext
      });
      try {
        const runTurn = async () => {
          bumpWorkModeVoiceInferTurnSeq();
          const ttsTurn = workModeTtsMetaFromTurnContext(turnContext);
          const prepWrap = attachWorkModeTtsTurnAfterPrep(await prepP, ttsTurn, trimmed);
          if (prepWrap?.inferThreadAnchor) {
            formData2.append("thread_follow_up_anchor", prepWrap.inferThreadAnchor);
          }
          if (prepWrap?.voiceTwoStage?.reasoningRouted) {
            const stage1P = maybePlayWorkModeReasoningStage1FromPrep(prepWrap, pipelineSig, trimmed);
            await Promise.resolve(stage1P).catch(() => {});
            const seqAtStage1End = workModeVoiceInferTurnSeq;
            scheduleWorkModeDeferredReasoningStageTwoInfer({
              formData: formData2,
              prep: prepWrap,
              seqAtStage1End
            });
            resumeAfterAssistantReplyPlayback();
            return undefined;
          }
          const prepFail = await runInferAfterWorkModeReasoningPrep(formData2, prepWrap, {
            signal: pipelineSig
          });
          return prepFail;
        };
        const prepFail = isVeraWorkModeOn()
          ? await enqueueWorkModeVoiceInferPlaybackTurn(runTurn)
          : await runTurn();
        if (prepFail === "reasoning-upload-failed") {
          processing = false;
          requestInFlight = false;
          voiceUxTurn = null;
          setStatus("Ready", "idle");
          return;
        }
      } catch (serverAsrPrepErr) {
        if (voiceAttach2Files.length) {
          preserveComposerAttachments("server_asr_prep_throw", turnContext);
        }
        throw serverAsrPrepErr;
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        hideSidePanel();
        processing = false;
        requestInFlight = false;
        voiceUxTurn = null;
        return;
      }
      console.warn("[WorkMode] server-asr preflight", err);
      hideSidePanel();
      processing = false;
      requestInFlight = false;
      voiceUxTurn = null;
      setStatus("Server error", "offline");
      void veraSurfaceLlmFetchFailure({
        feature: "infer_preflight_workmode",
        error: err
      });
      if (listeningMode === "continuous" && listening && !inputMuted) {
        startListening();
      }
    }
    return;
  }

  await runInferMainPipeline(formData);
}

/* =========================
   TEXT INPUT PIPELINE
========================= */

/**
 * Work mode: typed lines use the same `/infer` path as browser-ASR voice (including optional
 * reasoning-stream prep via maybePrepareWorkModeReasoning), not the separate `/text` handler.
 */
async function sendVeraWorkModeTypedInferTurn(text, opts = {}) {
  const rawText = String(text ?? "");
  const trimmed = rawText.trim();
  const path = opts.path || "work-typed";
  const fromQueue = Boolean(opts.__fromQueue);
  const fromPanelQueue = Boolean(opts.__fromReasoningPanelQueue);
  const queuedFiles =
    Array.isArray(opts.reasoningAttachments) && opts.reasoningAttachments.length
      ? opts.reasoningAttachments.filter((f) => f instanceof File && f.size)
      : [];
  const pendingFiles =
    fromQueue || fromPanelQueue ? queuedFiles : getWorkModePendingAttachmentFiles();
  if ((!trimmed && !pendingFiles.length) || !isVeraWorkModeOn() || appModePrefix() !== "vera") return;

  const modeBeforeSubmit = appModePrefix();
  const workModeBeforeSubmit = isVeraWorkModeOn();
  const hardWorkLimit = VERA_SAFETY_LIMITS.charLimits.workReasoning;
  if (!fromQueue && !fromPanelQueue && rawText.length > hardWorkLimit) {
    logInputLimitDebug({
      raw_char_count: rawText.length,
      estimated_tokens: Math.ceil(rawText.length / 4),
      input_surface: path || "work-typed",
      active_mode_before_submit: modeBeforeSubmit,
      work_mode_enabled_before_submit: workModeBeforeSubmit,
      selected_limit: hardWorkLimit,
      blocked: true,
      block_reason: "work_mode_typed_char_limit",
      route_attempted: false,
      backend_call_attempted: false,
      reasoning_panel_started: false,
      work_mode_enabled_after_submit: isVeraWorkModeOn(),
      did_toggle_work_mode: workModeBeforeSubmit !== isVeraWorkModeOn(),
      function_that_changed_work_mode: ""
    });
    veraShowSafetyFailureBubble(VERA_SAFETY_LIMITS.messages.inputTooLongKeyboard);
    veraSetSafetyStatus("Message too long — shorten or upload as a file");
    preserveComposerAttachments("typed_length_cap_reached", null);
    return;
  }

  const statusLine = uiEl("status");
  if (statusLine?.classList.contains("offline")) {
    requestInFlight = false;
    processing = false;
    listening = false;
    setStatus("Ready", "idle");
  }

  if (await maybeHandleWorkChecklistSyncShortcut(trimmed)) {
    return;
  }
  if (await maybeHandleWorkChecklistPlanShortcut(trimmed)) {
    return;
  }

  /* If the user typed a follow-up while the panel they are looking at is
     still generating, queue it visibly inside that panel instead of racing
     for the next idle panel. The user keeps full control: they can edit or
     delete the queued item before it runs, and once the panel finishes,
     `releaseWorkModeReasoningLane` triggers the drain via
     `scheduleReasoningPanelFollowUpQueueDrain`. */
  if (!fromQueue && !fromPanelQueue && trimmed) {
    const activeIdx = getActiveReasoningLaneIndex();
    if (
      activeIdx != null &&
      Number.isFinite(Number(activeIdx)) &&
      workModeReasoningLaneBusy.get(Number(activeIdx)) === true &&
      shouldQueueFollowUpForBusyReasoningPanel(trimmed)
    ) {
      const queued = enqueueReasoningPanelFollowUp(Number(activeIdx), trimmed, {
        ...opts,
        path,
        reasoningAttachments: pendingFiles
      });
      if (queued) {
        clearComposerAttachmentsAfterSubmit(null, "reasoning_panel_followup_queue");
        const panelEl = getReasoningPanelElementByLaneIdx(Number(activeIdx));
        const labelForStatus =
          (panelEl instanceof HTMLElement && getReasoningTabTopicLabel(panelEl)) ||
          getWorkModeReasoningLaneLabel(Number(activeIdx)) ||
          `panel ${Number(activeIdx) + 1}`;
        setStatus(`Queued for ${labelForStatus}`, "idle");
        return;
      }
    }
  }

  /* Safety length cap (defense in depth for any caller that bypasses the
     UI-side guard). Use the reasoning limit when the path indicates the
     prompt is heading into a reasoning panel, otherwise the chat limit. */
  if (!fromQueue && !fromPanelQueue && trimmed) {
    const intent = "work_reasoning";
    const lenBlock = veraCheckTypedInputLength(trimmed, intent, "keyboard");
    if (lenBlock) {
      logInputLimitDebug({
        raw_char_count: rawText.length,
        estimated_tokens: lenBlock.estimated_tokens,
        input_surface: path || "work-typed",
        active_mode_before_submit: modeBeforeSubmit,
        work_mode_enabled_before_submit: workModeBeforeSubmit,
        selected_limit: lenBlock.char_limit,
        blocked: true,
        block_reason: lenBlock.reason,
        route_attempted: false,
        backend_call_attempted: false,
        reasoning_panel_started: false,
        work_mode_enabled_after_submit: isVeraWorkModeOn(),
        did_toggle_work_mode: workModeBeforeSubmit !== isVeraWorkModeOn(),
        function_that_changed_work_mode: ""
      });
      veraShowSafetyFailureBubble(lenBlock.message);
      veraSetSafetyStatus("Message too long — shorten or upload as a file");
      preserveComposerAttachments("typed_length_cap_reached", null);
      try {
        console.info("[reasoning_queue_omitted]", {
          turn_id: null,
          lane_id: null,
          reason: "typed_length_cap_reached",
          char_count: trimmed.length,
          char_limit: lenBlock.char_limit,
          intent
        });
      } catch (_) {}
      return;
    }
  }

  /* Hard cap: at most WORK_MODE_TYPED_PENDING_MAX typed turns in flight or queued.
     Matches the non-work-mode "3 user turns before VERA replies" guard. Refuse
     instead of queueing the 4th so the user gets the same clear feedback. */
  if (!fromQueue && isWorkModeTypedTurnAtHardCap()) {
    setStatus("Wait for VERA response before sending more", "idle");
    preserveComposerAttachments("typed_hard_cap_reached", null);
    try {
      console.warn("[WorkMode] typed hard cap reached — refusing input", {
        pending: countPendingWorkModeTypedTurns(),
        max: WORK_MODE_TYPED_PENDING_MAX,
        depth: workModeTypedVoiceInferDepth,
        queued: workModeTypedTurnQueue.length
      });
      console.info("[reasoning_queue_omitted]", {
        turn_id: null,
        lane_id: null,
        reason: "typed_hard_cap_reached"
      });
    } catch (_) {}
    return;
  }

  if (isWorkModeTypedTurnBlocked()) {
    if (!fromQueue) {
      const queueSnap = getWorkModePendingAttachmentFiles();
      logComposerAttachmentsBeforeSubmit(queueSnap, null);
      const queued = enqueueWorkModeTypedTurn(trimmed, {
        ...opts,
        path,
        reasoningAttachments: queueSnap
      });
      if (queued) {
        clearComposerAttachmentsAfterSubmit(null, "typed_turn_queue_enqueue");
      } else {
        setStatus(`Work queue full (max ${WORK_MODE_TYPED_TURN_QUEUE_MAX})`, "idle");
        preserveComposerAttachments("typed_turn_queue_full", null);
        try {
          console.info("[reasoning_queue_omitted]", {
            turn_id: null,
            lane_id: null,
            reason: "typed_turn_queue_full_while_voice_infer_busy"
          });
        } catch (_) {}
      }
    }
    return;
  }

  /* User bubble: do not addBubble here — /infer NDJSON first `asr` line calls commitServerUserTranscriptBubble
     (same as voice). A prior addBubble would duplicate the row in Voice UI. */
  ensureChatStartedLayout();
  // Arm pending news bubble BEFORE POST /infer so the placeholder appears
  // during the thinking/searching window, not right before the final answer.
  // Idempotent — duplicate calls for the same transcript are no-ops.
  armPendingNewsStatusBubble(trimmed);

  const transcriptLine =
    trimmed || (pendingFiles.length ? "[Uploaded attachment(s)] — see attached file(s)." : "");
  const formData = new FormData();
  formData.append("transcript", transcriptLine);
  formData.append("use_browser_asr", "1");
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());
  formData.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
  formData.append("stream_tts", shouldStreamTts() ? "1" : "0");
  for (const f of pendingFiles) {
    const forInfer = f.slice(0, f.size, f.type || undefined);
    formData.append("context_files", forInfer, f.name || "upload");
  }
  if (listeningMode === "ptt") {
    formData.append("mode", "ptt");
  }

  const hasUpload = pendingFiles.length > 0;
  const turnContext = createWorkModeFrozenTurnContext({
    userText: trimmed || transcriptLine,
    source: workModeInferTurnSourceFromPath(path, hasUpload),
    hasFiles: hasUpload
  });
  appendWorkModeSubmissionLaneToFormData(formData, turnContext?.turn_lane_id);

  logFinalTranscriptSentToLlm(path, trimmed || transcriptLine);
  logComposerAttachmentsBeforeSubmit(pendingFiles, turnContext);

  try {
    if (hasUpload) {
      console.info("[attachment_turn_submit]", {
        turn_id: turnContext?.turn_id ?? null,
        lane_id: turnContext?.turn_lane_id ?? null,
        text_len: trimmed.length,
        file_count: pendingFiles.length,
        file_names: pendingFiles.map((f) => f.name || "file"),
        path,
        from_queue: fromQueue
      });
    }
  } catch (_) {}

  /* Reasoning: parallel across panels (lane chains); voice `/infer`: one chain, does not wait on other lanes' reasoning. */
  const reasoningPrepP = maybePrepareWorkModeReasoning(formData, trimmed || transcriptLine, undefined, {
    attachments: pendingFiles,
    turnContext
  });

  const enqueued = enqueueWorkModeTypedVoiceInfer(async () => {
    try {
      listening = false;
      waveState = "idle";
      processing = true;
      requestInFlight = true;
      setStatus("Thinking", "thinking");
      beginVoiceUxTurn();

      const inferSig = attachPipelineAbortSignal();
      const runPlayback = async () => {
        bumpWorkModeVoiceInferTurnSeq();
        const ttsTurn = workModeTtsMetaFromTurnContext(turnContext);
        const prepWrap = attachWorkModeTtsTurnAfterPrep(await reasoningPrepP, ttsTurn, trimmed);
        if (prepWrap?.inferThreadAnchor) formData.append("thread_follow_up_anchor", prepWrap.inferThreadAnchor);
        if (prepWrap?.voiceTwoStage?.reasoningRouted) {
          const stage1P = maybePlayWorkModeReasoningStage1FromPrep(prepWrap, inferSig, trimmed);
          await Promise.resolve(stage1P).catch(() => {});
          const seqAtStage1End = workModeVoiceInferTurnSeq;
          scheduleWorkModeDeferredReasoningStageTwoInfer({
            formData,
            prep: prepWrap,
            seqAtStage1End
          });
          resumeAfterAssistantReplyPlayback();
          return;
        }
        const prepFail = await runInferAfterWorkModeReasoningPrep(formData, prepWrap, { signal: inferSig });
        if (prepFail === "reasoning-upload-failed") {
          processing = false;
          requestInFlight = false;
          voiceUxTurn = null;
          setStatus("Ready", "idle");
          return;
        }
      };
      if (isVeraWorkModeOn()) {
        await enqueueWorkModeVoiceInferPlaybackTurn(runPlayback);
      } else {
        await runPlayback();
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        processing = false;
        requestInFlight = false;
        voiceUxTurn = null;
        return;
      }
      console.warn("[WorkMode] typed infer", err);
      hideSidePanel();
      processing = false;
      requestInFlight = false;
      voiceUxTurn = null;
      setStatus("Server error", "offline");
      void veraSurfaceLlmFetchFailure({
        feature: "infer_workmode_typed",
        error: err
      });
    }
  });

  if (!enqueued) {
    if (!fromQueue) {
      const reQ = enqueueWorkModeTypedTurn(trimmed, {
        ...opts,
        path,
        reasoningAttachments: pendingFiles
      });
      if (!reQ) {
        try {
          console.info("[reasoning_queue_omitted]", {
            turn_id: turnContext?.turn_id ?? null,
            lane_id: turnContext?.turn_lane_id ?? null,
            reason: "typed_queue_full_after_voice_infer_full",
            file_count: pendingFiles.length
          });
        } catch (_) {}
      }
    }
    if (!fromQueue) {
      setStatus(`Voice queue full (max ${WORK_MODE_TYPED_VOICE_CHAIN_MAX}) — try again shortly`, "idle");
    }
  }
}

async function sendTextMessage() {
  const textInput = uiEl("text-input");
  const statusLine = uiEl("status");
  const rawText = textInput?.value ?? "";
  const text = rawText.trim();
  const inVeraWorkMode = isVeraWorkModeOn() && appModePrefix() === "vera";

  // 🔑 recover from offline
  if (statusLine?.classList.contains("offline")) {
    requestInFlight = false;
    processing = false;
    listening = false;
    setStatus("Ready", "idle");
  }

  if (!text) return;
  if (inVeraWorkMode) {
    /* Safety: length cap BEFORE any state mutation so the user can edit + retry. */
    const modeBeforeSubmit = appModePrefix();
    const workModeBeforeSubmit = isVeraWorkModeOn();
    const lenBlock = veraCheckTypedInputLength(rawText, "work_reasoning", "keyboard");
    if (lenBlock) {
      logInputLimitDebug({
        raw_char_count: rawText.length,
        estimated_tokens: lenBlock.estimated_tokens,
        input_surface: "main_work_mode_text_input",
        active_mode_before_submit: modeBeforeSubmit,
        work_mode_enabled_before_submit: workModeBeforeSubmit,
        selected_limit: lenBlock.char_limit,
        blocked: true,
        block_reason: lenBlock.reason,
        route_attempted: false,
        backend_call_attempted: false,
        reasoning_panel_started: false,
        work_mode_enabled_after_submit: isVeraWorkModeOn(),
        did_toggle_work_mode: workModeBeforeSubmit !== isVeraWorkModeOn(),
        function_that_changed_work_mode: ""
      });
      veraShowSafetyFailureBubble(lenBlock.message);
      veraSetSafetyStatus("Message too long — shorten or upload as a file");
      return;
    }
    if (isWorkModeTypedTurnAtHardCap()) {
      setStatus("Wait for VERA response before sending more", "idle");
      try {
        console.warn("[WorkMode] keyboard blocked at hard cap (typed-text)", {
          pending: countPendingWorkModeTypedTurns(),
          max: WORK_MODE_TYPED_PENDING_MAX
        });
      } catch (_) {}
      return;
    }
    if (textInput) textInput.value = "";
    await sendVeraWorkModeTypedInferTurn(text, { path: "typed-text" });
    return;
  }
  /* Non-work-mode keyboard: chat length cap. Bubble shows the same copy as
     the backend 413 so the UX is identical for FE-block vs BE-block. */
  const lenBlockChat = veraCheckTypedInputLength(text, "normal_chat", "keyboard");
  if (lenBlockChat) {
    veraShowSafetyFailureBubble(lenBlockChat.message);
    veraSetSafetyStatus("Message too long — shorten or upload as a file");
    return;
  }
  const consecutiveUserTail = (() => {
    const convo = uiEl("conversation");
    if (!convo) return 0;
    const rows = [...convo.querySelectorAll(".message-row")];
    let count = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (!(row instanceof HTMLElement)) continue;
      const bubble = row.querySelector(".bubble");
      if (bubble instanceof HTMLElement && bubble.classList.contains("interrupt-preview")) continue;
      if (row.classList.contains("user")) {
        count += 1;
        continue;
      }
      break;
    }
    return count;
  })();
  if (consecutiveUserTail >= 3) {
    setStatus("Wait for VERA response before sending more", "idle");
    console.warn("[Keyboard] blocked after 3 pending user turns");
    return;
  }
  if (isServerPipelineBusy() && isFlowModeKeyboardInterruptAllowed()) {
    interruptAssistantPipelineForTypedMessage();
  }

  if (isServerPipelineBusy()) return;
  if (textInput) textInput.value = "";

  beginTextUxTurn();
  listening = false;
  processing = true;
  requestInFlight = true;
  waveState = "idle";

  setStatus("Thinking", "thinking");

  addBubble(text, "user", { path: "typed-text" });
  ensureChatStartedLayout();
  // Show "Searching news…" immediately for likely Serper-backed requests.
  // Cancelled when a real reply arrives via applyAssistantReplyAndPanels /
  // applyNdjsonStreamingReplySoFar / finalizeNdjsonStreamingReply, and
  // replaced with the failure message on network/server errors or timeout.
  armPendingNewsStatusBubble(text);
  try {
    await flushWorkChecklistSyncBeforeCommand();
    const textFetchStart = performance.now();
    const res = await fetch(`${API_URL}/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        session_id: getSessionId(),
        client: appModePrefix(),
        stream_tts: shouldStreamTts(),
        context_snapshot: buildClientContextSnapshot()
      }),
      signal: attachPipelineAbortSignal()
    });
    const textTtfbMs = performance.now() - textFetchStart;

    if (shouldStreamTts() && res.ok && isNdjsonTtsResponse(res)) {
      requestInFlight = false;

      let ndjsonMeta = null;
      const streamReplyState = createNdjsonStreamingReplyState();
      void (async () => {
        try {
          console.log("[UX][TTS] NDJSON streaming (text)");
          resetAudioHandlers();
          await runNdjsonTtsPlayback(res, {
            onMeta: (meta) => {
              ndjsonMeta = { ...ndjsonMeta, ...meta };
              if (
                !streamReplyState.pendingReplyBack &&
                meta.work_mode_voice_brief_completion === true &&
                meta.work_mode_voice_quote != null &&
                String(meta.work_mode_voice_quote).trim()
              ) {
                const q = String(meta.work_mode_voice_quote).trim();
                streamReplyState.pendingVoiceQuote = q;
                streamReplyState.pendingReplyBack = {
                  reply_to_user_text: q,
                  reply_to_turn_id: "",
                  reply_to_lane_id: "",
                  reply_to_lane_title: "",
                  stage: 2
                };
              }
              if (meta.work_mode_timer) {
                applyWorkModeTimerPayload(meta.work_mode_timer);
              }
            },
            onReplyProgress: (replySoFar) => {
              applyNdjsonStreamingReplySoFar(replySoFar, streamReplyState);
            },
            onDone: (done) => {
              logInferLatency(done, "text", textTtfbMs);
              finalizeNdjsonStreamingReply(ndjsonMeta, done, streamReplyState);
            },
            onPlayStart: () => {
              logTextFirstAudio("main-reply");
              logTextMainReplyAudio();
              applyActionPayload(ndjsonMeta);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus(
                listeningMode === "ptt" ? "Speaking" : "Speaking…",
                "speaking"
              );
            },
            onPlayEnd: () => {
              resumeAfterAssistantReplyPlayback();
            }
          });
        } catch (e) {
          if (e?.name !== "AbortError") console.warn(e);
        }
      })();
      return;
    }

    const data = await res.json();
    logInferLatency(data, "text", textTtfbMs);

    requestInFlight = false;
    applyClientUiAction(data.client_action);

    const playReply = () => {
      resetAudioHandlers();
      void (async () => {
        try {
          await playTtsFromApi(data, {
            onPlayStart: () => {
              logTextFirstAudio("main-reply");
              logTextMainReplyAudio();
              applyAssistantReplyAndPanels(data);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus(
                listeningMode === "ptt" ? "Speaking" : "Speaking…",
                "speaking"
              );
            },
            onPlayEnd: () => {
              resumeAfterAssistantReplyPlayback();
            }
          });
        } catch (e) {
          console.warn(e);
        }
      })();
    };

    playReply();

  } catch (err) {
    if (err?.name === "AbortError") {
      requestInFlight = false;
      processing = false;
      textUxTurn = null;
      cancelPendingNewsStatusBubble("abort");
      return;
    }
    console.error(err);
    hideSidePanel();
    requestInFlight = false;
    processing = false;
    textUxTurn = null;
    setStatus("Server error", "offline");
    // If we had armed a "Searching news…" bubble, swap it for the standard
    // search/news failure copy (one specific bubble is better than two).
    // If no pending bubble was armed, fall back to the generic LLM-failure
    // bubble so the user still sees something.
    if (!failPendingNewsStatusBubble("text_endpoint_error")) {
      void veraSurfaceLlmFetchFailure({ feature: "text_endpoint", error: err });
    }
  }
}

/* =========================
   MIC BUTTON
========================= */
async function beginPttRecordingNow() {
  stopActiveMicCaptureSilently();
  listeningMode = "ptt";
  updateMuteInputButton();
  pttRecording = true;
  await initMic();
  micStream?.getAudioTracks().forEach((track) => {
    track.enabled = true;
  });
  listening = true;
  processing = false;
  waveState = "listening";
  audioChunks = [];
  hasSpoken = false;
  lastVoiceTime = 0;

  if (browserAsrPreferred()) {
    mainBrowserFinalizeKind = "main";
    startMainBrowserRecognitionContinuous();
    setStatus("Listening (PTT)", "recording");
    return;
  }

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
  mediaRecorder.onstop = handleUtterance;
  mediaRecorder.start();
  setStatus("Listening (PTT)", "recording");
}

async function onPttClick() {
  ensureChatStartedLayout();
  if (isServerPipelineBusy()) {
    cancelVoicePipelineAndResetState();
    await beginPttRecordingNow();
    return;
  }
  if (!pttRecording) {
    await beginPttRecordingNow();
    return;
  }
  pttRecording = false;
  listening = false;
  waveState = "idle";

  if (browserAsrPreferred()) {
    const text = (
      mainBrowserFinalTranscript + (mainBrowserLastInterim || "")
    ).trim();
    stopAllBrowserSpeechRecognizers();
    if (!text) {
      setStatus("Ready", "idle");
      updateMuteInputButton();
      return;
    }
    if (await maybeHandleWorkChecklistSyncShortcut(text)) {
      setStatus("Ready", "idle");
      updateMuteInputButton();
      return;
    }
    if (await maybeHandleWorkChecklistPlanShortcut(text)) {
      setStatus("Ready", "idle");
      updateMuteInputButton();
      return;
    }
    removeMainBrowserLiveBubble();
    beginVoiceUxTurn();
    requestInFlight = true;
    processing = true;
    waveState = "idle";
    setStatus("Thinking", "thinking");
    const formData = new FormData();
    formData.append("transcript", text);
    formData.append("use_browser_asr", "1");
    formData.append("session_id", getSessionId());
    formData.append("client", appModePrefix());
    formData.append("context_snapshot", JSON.stringify(buildClientContextSnapshot()));
    formData.append("mode", "ptt");
    formData.append("stream_tts", shouldStreamTts() ? "1" : "0");
    const turnContext = createWorkModeFrozenTurnContext({ userText: text, source: "voice" });
    appendWorkModeSubmissionLaneToFormData(formData, turnContext?.turn_lane_id);
    logVoiceTranscript("final", text, { path: "ptt-browser-asr" });
    logFinalTranscriptSentToLlm("ptt-browser-asr", text);
    void (async () => {
      try {
        attachPipelineAbortSignal();
        const pipelineSig = activePipelineAbort.signal;
        const prepP = maybePrepareWorkModeReasoning(formData, text, pipelineSig, { turnContext });
        const runTurn = async () => {
          bumpWorkModeVoiceInferTurnSeq();
          const ttsTurn = workModeTtsMetaFromTurnContext(turnContext);
          const prep = attachWorkModeTtsTurnAfterPrep(await prepP, ttsTurn, text);
          if (prep?.inferThreadAnchor) formData.append("thread_follow_up_anchor", prep.inferThreadAnchor);
          if (prep?.voiceTwoStage?.reasoningRouted) {
            const stage1P = maybePlayWorkModeReasoningStage1FromPrep(prep, pipelineSig, text);
            await Promise.resolve(stage1P).catch(() => {});
            const seqAtStage1End = workModeVoiceInferTurnSeq;
            scheduleWorkModeDeferredReasoningStageTwoInfer({
              formData,
              prep,
              seqAtStage1End
            });
            resumeAfterAssistantReplyPlayback();
            return;
          }
          await runInferAfterWorkModeReasoningPrep(formData, prep, { signal: pipelineSig });
        };
        if (isVeraWorkModeOn()) {
          await enqueueWorkModeVoiceInferPlaybackTurn(runTurn);
        } else {
          await runTurn();
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.warn("[PTT][browser-asr] infer", err);
        }
      }
    })();
    return;
  }

  if (mediaRecorder && mediaRecorder.state === "recording") {
    beginVoiceUxTurn();
    mediaRecorder.stop();
  }
}

["vera-ptt", "bmo-ptt"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", onPttClick);
});

async function onRecordClick() {
  ensureChatStartedLayout();
  browserAsrMainNetworkRetries = 0;
  listeningMode = "continuous";
  updateMuteInputButton();

  if (isServerPipelineBusy() || pttRecording) {
    cancelVoicePipelineAndResetState();
    inputMuted = false;
    await initMic();
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    listening = true;
    updateMuteInputButton();
    startListening();
    return;
  }

  if (!listening) {
    inputMuted = false;
    await initMic();
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    listening = true;
    updateMuteInputButton();
    startListening();
    return;
  }

  if (listeningMode !== "continuous" || !micStream) return;
  setContinuousInputMuted(!inputMuted);
}

["vera-record", "bmo-record"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", onRecordClick);
});

updateMuteInputButton();
wireMobileInterruptDebugUi();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (browserAsrVisibilityResumeTimer != null) {
    clearTimeout(browserAsrVisibilityResumeTimer);
    browserAsrVisibilityResumeTimer = null;
  }
  browserAsrVisibilityResumeTimer = window.setTimeout(() => {
    browserAsrVisibilityResumeTimer = null;
    maybeResumeMainBrowserSpeechRecognition("tab-visible");
  }, 280);
});

if (!IS_MOBILE) {
  ["vera", "bmo"].forEach((prefix) => {
    const sendTextBtn = document.getElementById(`${prefix}-send-text`);
    const textInput = document.getElementById(`${prefix}-text-input`);
    sendTextBtn?.addEventListener("click", sendTextMessage);
    textInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        sendTextMessage();
      }
    });
  });
}

/* =========================
   FEEDBACK
========================= */

if (sendFeedbackBtn) {
  sendFeedbackBtn.onclick = async () => {
    const text = feedbackInput.value.trim();
    if (!text) return;

    feedbackStatusEl.textContent = "Sending…";
    feedbackStatusEl.style.color = "";

    try {
      const res = await fetch(`${API_URL}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: getSessionId(),
          feedback: text,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString()
        })
      });

      if (!res.ok) throw new Error();

      feedbackInput.value = "";
      feedbackStatusEl.textContent = "Thank you for your feedback!";
      feedbackStatusEl.style.color = "#5cffb1";
    } catch {
      feedbackStatusEl.textContent = "Failed to send feedback.";
      feedbackStatusEl.style.color = "#ff6b6b";
    }
  };
}

window.resetVoiceUiToIdle = cancelVoicePipelineAndResetState;

/* =========================
   HIDDEN USER SIGN-IN (long-press VERA logo 2s)
========================= */

/**
 * Base URL for FastAPI user routes (sign-in, /api/user/active).
 * GitHub Pages / static hosts cannot serve POST /api — must use API_URL (Worker → tunnel → app.py).
 * Order: explicit override → localhost uvicorn → meta → file → API_URL for all other https origins.
 */
function localBackendBase() {
  if (typeof window !== "undefined" && window.VERA_LOCAL_BACKEND_ORIGIN) {
    return String(window.VERA_LOCAL_BACKEND_ORIGIN).replace(/\/$/, "");
  }
  const o = typeof window !== "undefined" ? window.location?.origin : "";
  if (o && o !== "null" && !o.startsWith("file:")) {
    const isLocal =
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o) ||
      /^https?:\/\/\[::1\](:\d+)?$/i.test(o);
    if (isLocal) return o.replace(/\/$/, "");
  }
  const m = document.querySelector('meta[name="vera-local-backend-origin"]');
  const meta = m?.content?.trim();
  if (meta) return meta.replace(/\/$/, "");
  if (!o || o === "null" || o.startsWith("file:")) {
    return "http://127.0.0.1:8000";
  }
  const remote = String(API_URL).replace(/\/$/, "");
  return remote || "https://vera-api.vera-api-ned.workers.dev";
}

function authApiBase() {
  return localBackendBase();
}

/** Absolute URL for user auth; never same-origin relative /api/... on GitHub Pages. */
function authApiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  let base = localBackendBase();
  if (!base || !String(base).trim()) {
    base = String(API_URL).replace(/\/$/, "") || "https://vera-api.vera-api-ned.workers.dev";
  }
  const root = String(base).replace(/\/$/, "");
  return new URL(p, `${root}/`).href;
}

function setVeraActiveUserLabel(usernameOrNull) {
  const el = document.getElementById("vera-active-user-label");
  if (!el) return;
  if (usernameOrNull == null || usernameOrNull === "") {
    el.textContent = "";
    el.setAttribute("hidden", "");
    return;
  }
  el.textContent = `user: ${usernameOrNull}`;
  el.removeAttribute("hidden");
}

async function refreshVeraActiveUserLabel() {
  const tabUser = sessionStorage.getItem(VERA_TAB_ACTIVE_USER_KEY) || "";
  if (!tabUser) {
    setVeraActiveUserLabel(null);
    try {
      await fetch(authApiUrl("/api/user/sign-out"), { method: "POST" });
    } catch {}
    return;
  }
  try {
    const res = await fetch(authApiUrl("/api/user/active"), { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setVeraActiveUserLabel(null);
      return;
    }
    const activeName = data.username != null && data.username !== "" ? String(data.username) : tabUser;
    setVeraActiveUserLabel(activeName || null);
  } catch {
    setVeraActiveUserLabel(tabUser || null);
  }
}

/** Dev-only cost-log UI: localhost, ?costdebug=1, or localStorage vera_cost_log_debug=1 */
function isVeraCostLogDevUiEnabled() {
  try {
    if (typeof URLSearchParams !== "undefined" && typeof location !== "undefined") {
      const q = new URLSearchParams(location.search);
      if (q.get("costdebug") === "1" || q.get("cost_log_debug") === "1") return true;
    }
    if (typeof localStorage !== "undefined" && localStorage.getItem("vera_cost_log_debug") === "1") {
      return true;
    }
    const o = typeof location !== "undefined" ? String(location.origin || "") : "";
    return /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o);
  } catch (_) {
    return false;
  }
}

function formatVeraCostLogStatusPayload(data) {
  if (!data || typeof data !== "object") return "(no status)";
  const lines = [
    `log_dir: ${data.log_dir || "?"}`,
    `reset_allowed: ${data.reset_allowed ? "yes" : "no"}`,
    `open_in_memory_sessions: ${data.open_in_memory_sessions ?? 0}`,
  ];
  for (const f of data.files || []) {
    lines.push(
      `${f.name}: rows=${f.row_count ?? 0} size=${f.size_bytes ?? 0}B` +
        (f.earliest_timestamp ? ` from=${f.earliest_timestamp}` : "") +
        (f.latest_timestamp ? ` to=${f.latest_timestamp}` : "")
    );
  }
  const archives = data.archives || [];
  if (archives.length) {
    lines.push(`archives (${archives.length} recent): ${archives.slice(0, 3).map((a) => a.name).join(", ")}`);
  }
  return lines.join("\n");
}

async function fetchVeraCostLogStatus() {
  const base = typeof localBackendBase === "function" ? localBackendBase() : "";
  const res = await fetch(`${base}/cost/logs/status`, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  return data;
}

async function archiveVeraCostLogsAndStartClean({ scenarioName = "" } = {}) {
  const base = typeof localBackendBase === "function" ? localBackendBase() : "";
  const archiveRes = await fetch(`${base}/cost/logs/archive`, { method: "POST" });
  const archiveData = await archiveRes.json().catch(() => ({}));
  if (!archiveRes.ok) {
    throw new Error(archiveData.detail || archiveData.message || `archive HTTP ${archiveRes.status}`);
  }
  const scenario = String(scenarioName || "").trim();
  let sessionStart = null;
  if (scenario && typeof getSessionId === "function") {
    const startRes = await fetch(`${base}/cost/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: getSessionId(), scenario_name: scenario }),
    });
    sessionStart = await startRes.json().catch(() => ({}));
    if (!startRes.ok) {
      console.warn("[cost_log] session/start after archive failed", sessionStart);
    }
  }
  return { archive: archiveData, session_start: sessionStart };
}

function wireVeraSettingsPanel() {
  const modal = document.getElementById("vera-settings-modal");
  const openVeraBtn = document.getElementById("vera-settings-open");
  const openBmoBtn = document.getElementById("bmo-settings-open");
  const closeBtn = document.getElementById("vera-settings-close");
  const silenceSlider = document.getElementById("vera-setting-silence");
  const asrStreamingBtn = document.getElementById("vera-setting-asr-streaming");
  const asrSingleBtn = document.getElementById("vera-setting-asr-single");
  const mainPartialMinSel = document.getElementById("vera-setting-main-partial-min");
  const resetSessionBtn = document.getElementById("vera-setting-reset-session");
  const costLogDevSection = document.getElementById("vera-cost-log-dev-section");
  const costArchiveBtn = document.getElementById("vera-cost-archive-clean-btn");
  const costScenarioSelect = document.getElementById("vera-cost-scenario-select");
  const costLogStatusPre = document.getElementById("vera-cost-log-status");
  const textGuideRotatorBtn = document.getElementById("vera-setting-text-guide-rotator");
  const workModeMuteBtn = document.getElementById("vera-setting-workmode-mute");
  const planningDeadlineTimerBtn = document.getElementById("vera-setting-planning-deadline-timer");
  const saveBtn = document.getElementById("vera-settings-save");
  if (!(modal instanceof HTMLElement)) return;

  const silenceOptions = [1000, 1300, 1600];
  let draftSilenceMs = getVeraAsrSilenceMs();
  let draftAsrMode = getVeraAsrMode();
  let draftTextGuideRotator = isTextGuideRotatorEnabled();
  let draftWorkModeMute = isWorkModeMuteEnabled();
  let draftPlanningDeadlineTimer = isPlanningDeadlineTimerEnabled();
  let draftMainAsrPartialMinChars = getMainAsrPartialMinChars();
  const partialMinCharOptions = MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS;
  const silenceToIndex = (ms) => {
    const idx = silenceOptions.indexOf(ms);
    return idx >= 0 ? idx : 1;
  };
  const readSliderSilenceMs = () => {
    if (!(silenceSlider instanceof HTMLInputElement)) return draftSilenceMs;
    const raw = Number(silenceSlider.value);
    const idx = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1;
    return silenceOptions[idx];
  };
  const partialMinCharsToIndex = (n) => {
    const idx = partialMinCharOptions.indexOf(normalizeMainAsrPartialMinChars(n));
    return idx >= 0 ? idx : 0;
  };
  const readSliderPartialMinChars = () => {
    if (!(mainPartialMinSel instanceof HTMLInputElement)) return draftMainAsrPartialMinChars;
    const raw = Number(mainPartialMinSel.value);
    const idx = Number.isFinite(raw) ? Math.max(0, Math.min(partialMinCharOptions.length - 1, raw)) : 2;
    return partialMinCharOptions[idx];
  };

  const applyAsrModeUi = (mode) => {
    const streamingOn = mode !== "single";
    if (asrStreamingBtn instanceof HTMLButtonElement) {
      asrStreamingBtn.classList.toggle("is-active", streamingOn);
      asrStreamingBtn.setAttribute("aria-pressed", streamingOn ? "true" : "false");
    }
    if (asrSingleBtn instanceof HTMLButtonElement) {
      asrSingleBtn.classList.toggle("is-active", !streamingOn);
      asrSingleBtn.setAttribute("aria-pressed", !streamingOn ? "true" : "false");
    }
  };

  const applyMuteUi = () => {
    const on = draftWorkModeMute;
    if (workModeMuteBtn instanceof HTMLButtonElement) {
      workModeMuteBtn.classList.toggle("is-on", on);
      workModeMuteBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  const applyTextGuideRotatorUi = () => {
    const on = draftTextGuideRotator;
    if (textGuideRotatorBtn instanceof HTMLButtonElement) {
      textGuideRotatorBtn.classList.toggle("is-on", on);
      textGuideRotatorBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  const applyPlanningDeadlineTimerUi = () => {
    const on = draftPlanningDeadlineTimer;
    if (planningDeadlineTimerBtn instanceof HTMLButtonElement) {
      planningDeadlineTimerBtn.classList.toggle("is-on", on);
      planningDeadlineTimerBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  };
  const hydrate = () => {
    draftSilenceMs = getVeraAsrSilenceMs();
    draftAsrMode = getVeraAsrMode();
    draftTextGuideRotator = isTextGuideRotatorEnabled();
    draftWorkModeMute = isWorkModeMuteEnabled();
    draftPlanningDeadlineTimer = isPlanningDeadlineTimerEnabled();
    draftMainAsrPartialMinChars = getMainAsrPartialMinChars();
    if (silenceSlider instanceof HTMLInputElement) {
      silenceSlider.value = String(silenceToIndex(draftSilenceMs));
    }
    if (mainPartialMinSel instanceof HTMLInputElement) {
      mainPartialMinSel.value = String(partialMinCharsToIndex(draftMainAsrPartialMinChars));
    }
    applyAsrModeUi(draftAsrMode);
    applyTextGuideRotatorUi();
    applyMuteUi();
    applyPlanningDeadlineTimerUi();
    applyVeraWorkModeMuteSetting();
    applyTextGuideRotatorSetting();
  };

  const refreshCostLogDevUi = async () => {
    const devOn = isVeraCostLogDevUiEnabled();
    if (costLogDevSection instanceof HTMLElement) {
      if (devOn) costLogDevSection.removeAttribute("hidden");
      else costLogDevSection.setAttribute("hidden", "");
    }
    if (!devOn || !(costLogStatusPre instanceof HTMLElement)) return;
    try {
      const status = await fetchVeraCostLogStatus();
      costLogStatusPre.textContent = formatVeraCostLogStatusPayload(status);
      costLogStatusPre.removeAttribute("hidden");
    } catch (e) {
      costLogStatusPre.textContent = `status error: ${e?.message || e}`;
      costLogStatusPre.removeAttribute("hidden");
    }
  };

  const open = () => {
    hydrate();
    void refreshCostLogDevUi();
    logVeraSettings("open_modal", {
      silence_ms: draftSilenceMs,
      asr_mode: draftAsrMode,
      text_guide_rotator: draftTextGuideRotator ? 1 : 0,
      workmode_mute: draftWorkModeMute ? 1 : 0,
      planning_deadline_timer: draftPlanningDeadlineTimer ? 1 : 0,
      main_asr_partial_min_chars: draftMainAsrPartialMinChars === Infinity ? "inf" : draftMainAsrPartialMinChars,
    });
    modal.removeAttribute("hidden");
  };
  const close = () => {
    modal.setAttribute("hidden", "");
  };

  openVeraBtn?.addEventListener("click", open);
  openBmoBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });

  const syncDraftSilenceFromSlider = () => {
    draftSilenceMs = readSliderSilenceMs();
    logVeraSettings("draft_silence_ms", { value: draftSilenceMs });
  };
  silenceSlider?.addEventListener("input", syncDraftSilenceFromSlider);
  silenceSlider?.addEventListener("change", syncDraftSilenceFromSlider);
  asrStreamingBtn?.addEventListener("click", () => {
    draftAsrMode = "streaming";
    applyAsrModeUi("streaming");
    logVeraSettings("draft_asr_mode", { value: draftAsrMode });
  });
  asrSingleBtn?.addEventListener("click", () => {
    draftAsrMode = "single";
    applyAsrModeUi("single");
    logVeraSettings("draft_asr_mode", { value: draftAsrMode });
  });
  const syncDraftPartialMinChars = () => {
    draftMainAsrPartialMinChars = readSliderPartialMinChars();
    logVeraSettings("draft_main_asr_partial_min_chars", {
      value: draftMainAsrPartialMinChars === Infinity ? "inf" : draftMainAsrPartialMinChars,
    });
  };
  mainPartialMinSel?.addEventListener("input", syncDraftPartialMinChars);
  mainPartialMinSel?.addEventListener("change", syncDraftPartialMinChars);
  textGuideRotatorBtn?.addEventListener("click", () => {
    draftTextGuideRotator = !draftTextGuideRotator;
    applyTextGuideRotatorUi();
    logVeraSettings("draft_text_guide_rotator", { value: draftTextGuideRotator ? 1 : 0 });
  });
  workModeMuteBtn?.addEventListener("click", () => {
    draftWorkModeMute = !draftWorkModeMute;
    applyMuteUi();
    logVeraSettings("draft_workmode_mute", { value: draftWorkModeMute ? 1 : 0 });
  });
  planningDeadlineTimerBtn?.addEventListener("click", () => {
    draftPlanningDeadlineTimer = !draftPlanningDeadlineTimer;
    applyPlanningDeadlineTimerUi();
    logVeraSettings("draft_planning_deadline_timer", { value: draftPlanningDeadlineTimer ? 1 : 0 });
  });
  saveBtn?.addEventListener("click", () => {
    draftSilenceMs = readSliderSilenceMs();
    draftMainAsrPartialMinChars = readSliderPartialMinChars();
    logVeraSettings("save_click", {
      silence_ms: draftSilenceMs,
      asr_mode: draftAsrMode,
      text_guide_rotator: draftTextGuideRotator ? 1 : 0,
      workmode_mute: draftWorkModeMute ? 1 : 0,
      planning_deadline_timer: draftPlanningDeadlineTimer ? 1 : 0,
      main_asr_partial_min_chars: draftMainAsrPartialMinChars === Infinity ? "inf" : draftMainAsrPartialMinChars,
    });
    setVeraAsrSilenceMs(draftSilenceMs);
    setVeraAsrMode(draftAsrMode);
    setMainAsrPartialMinChars(draftMainAsrPartialMinChars);
    setTextGuideRotatorEnabled(draftTextGuideRotator);
    setWorkModeMuteEnabled(draftWorkModeMute);
    setPlanningDeadlineTimerEnabled(draftPlanningDeadlineTimer);
    close();
  });

  resetSessionBtn?.addEventListener("click", () => {
    logVeraSettings("reset_session_click", { mode: appModePrefix() });
    const ok = window.confirm("Start a new session now? This clears current chat and work-mode checklist/reasoning state.");
    if (!ok) return;
    if (appModePrefix() === "bmo") resetBmoSessionAndUi();
    else resetVeraSessionAndUi();
    close();
  });

  costArchiveBtn?.addEventListener("click", async () => {
    if (!isVeraCostLogDevUiEnabled()) return;
    const scenario =
      costScenarioSelect instanceof HTMLSelectElement ? costScenarioSelect.value.trim() : "";
    const msg =
      "Archive current cost/credit logs to logs/archive/ and start fresh empty logs?\n\n" +
      (scenario ? `Scenario label: ${scenario}\n` : "") +
      "Old data is preserved in the archive folder.";
    if (!window.confirm(msg)) return;
    costArchiveBtn.disabled = true;
    try {
      const result = await archiveVeraCostLogsAndStartClean({ scenarioName: scenario });
      const arch = result.archive || {};
      const moved = (arch.moved || []).length;
      window.alert(
        `Archived ${moved} file(s) to:\n${arch.archive_dir || "(unknown)"}\n\n` +
          (scenario ? `Tagged session with scenario: ${scenario}\n` : "") +
          "Active logs are now empty. Cost logging is still enabled."
      );
      await refreshCostLogDevUi();
    } catch (e) {
      window.alert(`Cost log archive failed: ${e?.message || e}`);
    } finally {
      costArchiveBtn.disabled = false;
    }
  });

  const app = document.getElementById("vera-app");
  if (app && typeof MutationObserver !== "undefined") {
    const obs = new MutationObserver(() => applyVeraWorkModeMuteSetting());
    obs.observe(app, { attributes: true, attributeFilter: ["class"] });
  }
  hydrate();
}

function wireVeraUserSignInHoldAndModal() {
  const holdMs = 2000;
  /* Long-press sign-in only in VERA app (#return-home-vera), not on landing nav-home */
  const logos = [document.getElementById("return-home-vera")].filter(Boolean);

  const revealSignInButtons = () => {
    document.getElementById("vera-user-sign-in")?.removeAttribute("hidden");
  };

  logos.forEach((el) => {
    let timer = null;
    let longPress = false;
    let holding = false;
    let rafId = null;
    let holdStart = 0;

    const tick = () => {
      if (!holding) return;
      const elapsed = performance.now() - holdStart;
      const pct = Math.min(100, (elapsed / holdMs) * 100);
      el.style.setProperty("--vera-hold-pct", `${pct}%`);
      if (holding && elapsed < holdMs) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const endHoldTracking = () => {
      holding = false;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      el.style.setProperty("--vera-hold-pct", "0%");
    };

    el.addEventListener("pointerdown", () => {
      longPress = false;
      holding = true;
      holdStart = performance.now();
      timer = window.setTimeout(() => {
        longPress = true;
        revealSignInButtons();
        el.style.setProperty("--vera-hold-pct", "100%");
        holding = false;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }, holdMs);
      rafId = requestAnimationFrame(tick);
    });

    const cancelTimerAndFill = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      endHoldTracking();
    };

    el.addEventListener("pointerup", cancelTimerAndFill);
    el.addEventListener("pointerleave", cancelTimerAndFill);
    el.addEventListener("pointercancel", cancelTimerAndFill);
    el.addEventListener(
      "click",
      (e) => {
        if (longPress) {
          e.preventDefault();
          e.stopImmediatePropagation();
          longPress = false;
        }
      },
      true
    );
  });

  const modal = document.getElementById("vera-user-sign-in-modal");
  const errEl = document.getElementById("vera-sign-in-error");

  const showErr = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
  };

  const openModal = () => {
    showErr("");
    modal?.removeAttribute("hidden");
  };

  const closeModal = () => {
    modal?.setAttribute("hidden", "");
    showErr("");
  };

  document.getElementById("vera-user-sign-in")?.addEventListener("click", openModal);
  document.getElementById("vera-sign-in-cancel")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.getElementById("vera-sign-in-submit")?.addEventListener("click", async () => {
    const userEl = document.getElementById("vera-sign-in-username");
    const passEl = document.getElementById("vera-sign-in-password");
    const user = userEl?.value?.trim() ?? "";
    const pass = passEl?.value?.trim() ?? "";
    showErr("");
    try {
      const res = await fetch(authApiUrl("/api/user/sign-in"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = data.detail;
        if (Array.isArray(d) && d.length > 0 && d[0]?.msg) {
          showErr(String(d[0].msg));
          return;
        }
        showErr(typeof d === "string" ? d : "Wrong password or username.");
        return;
      }
      const name = data.username != null && data.username !== "" ? String(data.username) : null;
      if (name) sessionStorage.setItem(VERA_TAB_ACTIVE_USER_KEY, name);
      setVeraActiveUserLabel(name);
      /* Start a fresh VERA session on successful user sign-in. */
      if (typeof window.resetVeraSessionAndUi === "function") {
        window.resetVeraSessionAndUi();
      }
      await hydrateWorkChecklistFromServer(true);
      closeModal();
      if (passEl) passEl.value = "";
    } catch {
      showErr(
        "Could not reach the auth server. If you use GitHub Pages, deploy the latest app.js (cache-busted) so sign-in uses the VERA API URL, or set window.VERA_LOCAL_BACKEND_ORIGIN."
      );
    }
  });
}

wireVeraUserSignInHoldAndModal();
wireVeraSettingsPanel();
refreshVeraActiveUserLabel();

(function stripSpotifyOAuthQueryParams() {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("spotify_connected") && !u.searchParams.has("spotify_error")) return;
    const err = u.searchParams.get("spotify_error");
    u.searchParams.delete("spotify_connected");
    u.searchParams.delete("spotify_error");
    if (err) console.warn("[Spotify OAuth]", err);
    history.replaceState({}, "", u.pathname + u.search + u.hash);
    try {
      const bc = new BroadcastChannel("vera-spotify");
      bc.postMessage({ type: "spotify-oauth-done", error: err });
      bc.close();
    } catch (_) {
      /* ignore */
    }
  } catch (_) {
    /* ignore */
  }
})();

(function wireSpotifyOAuthPostMessageFromPopup() {
  if (window.__veraSpotifyOAuthPostMessageWired) return;
  window.__veraSpotifyOAuthPostMessageWired = true;
  window.addEventListener("message", (ev) => {
    if (ev.data?.type !== "vera-spotify-oauth") return;
    let apiOrigin;
    try {
      apiOrigin = new URL(localBackendBase()).origin;
    } catch (_) {
      return;
    }
    if (ev.origin !== apiOrigin) return;
    if (!ev.data.ok) {
      console.warn("[Spotify OAuth]", ev.data.error);
      return;
    }
    void (async () => {
      if (ev.data.handoff) await claimSpotifyHandoff(ev.data.handoff);
      void refreshSpotifyPanelAfterOAuthInOtherTab();
    })();
  });
})();

(function wireSpotifyOAuthOtherTabsRefresh() {
  if (window.__veraSpotifyCrossTabWired) return;
  window.__veraSpotifyCrossTabWired = true;
  try {
    const bc = new BroadcastChannel("vera-spotify");
    bc.addEventListener("message", (ev) => {
      if (ev.data?.type !== "spotify-oauth-done") return;
      void refreshSpotifyPanelAfterOAuthInOtherTab();
    });
  } catch (_) {
    /* ignore */
  }
  let focusT;
  const onVisible = () => {
    if (window.__veraSpotifyPlaybackActive) return;
    const s = window.__veraSpotifyNowState;
    if (s && (Number(s.position_ms) > 0 || Number(s.duration_ms) > 0)) return;
    if (!window.__veraSpotifyOAuthPoll) return;
    clearTimeout(focusT);
    focusT = setTimeout(() => void refreshSpotifyPanelAfterOAuthInOtherTab(), 280);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onVisible();
  });
  window.addEventListener("focus", onVisible);
})();

/**
 * Spotify: search (Client Credentials) + optional Web Playback SDK after user connects (Premium).
 */
window.__veraSpotifyLast = { preview_url: "", open_url: "", title: "", artist: "" };

window.VeraSpotify = {
  async searchTracks(query) {
    const raw = String(query || "").trim();
    if (!raw) return [];
    /* Same origin as sign-in: local http://127.0.0.1:8000 uses your .env; GitHub Pages uses API_URL via localBackendBase(). */
    const u = new URL(authApiUrl("/api/spotify/search"));
    u.searchParams.set("q", raw);
    const res = await fetch(u.href, { cache: "no-store" });
    if (!res.ok) {
      let msg = `Search failed (${res.status})`;
      try {
        const err = await res.json();
        const d = err.detail;
        if (typeof d === "string") msg = d;
        else if (Array.isArray(d) && d[0]?.msg) msg = String(d[0].msg);
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  },
  async getAlbumTracks(albumId) {
    const id = String(albumId || "").trim();
    if (!id) return [];
    const u = new URL(authApiUrl(`/api/spotify/albums/${encodeURIComponent(id)}/tracks`));
    u.searchParams.set("limit", "50");
    const res = await fetch(u.href, { cache: "no-store" });
    if (!res.ok) {
      let msg = `Album tracks failed (${res.status})`;
      try {
        const err = await res.json();
        if (typeof err.detail === "string") msg = err.detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  },
  async getArtistTopTracks(artistId) {
    const id = String(artistId || "").trim();
    if (!id) return [];
    const u = new URL(authApiUrl(`/api/spotify/artists/${encodeURIComponent(id)}/top-tracks`));
    const res = await fetch(u.href, { cache: "no-store" });
    if (!res.ok) {
      let msg = `Artist top tracks failed (${res.status})`;
      try {
        const err = await res.json();
        if (typeof err.detail === "string") msg = err.detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  },
  async getArtistAlbums(artistId) {
    const id = String(artistId || "").trim();
    if (!id) return [];
    const u = new URL(authApiUrl(`/api/spotify/artists/${encodeURIComponent(id)}/albums`));
    u.searchParams.set("limit", "200");
    const res = await fetch(u.href, { cache: "no-store" });
    if (!res.ok) {
      let msg = `Artist albums failed (${res.status})`;
      try {
        const err = await res.json();
        if (typeof err.detail === "string") msg = err.detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  },
  async getPlaylists() {
    const u = new URL(authApiUrl("/api/spotify/me/playlists"));
    u.searchParams.set("limit", "30");
    const res = await fetch(u.href, {
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders() },
      cache: "no-store"
    });
    if (!res.ok) {
      let msg = `Playlist fetch failed (${res.status})`;
      try {
        const err = await res.json();
        if (typeof err.detail === "string") msg = err.detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  },
  async getPlaylistTracks(playlistId) {
    const pid = String(playlistId || "").trim();
    if (!pid) return [];
    const u = new URL(authApiUrl(`/api/spotify/playlists/${encodeURIComponent(pid)}/tracks`));
    u.searchParams.set("limit", "100");
    const res = await fetch(u.href, {
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders() },
      cache: "no-store"
    });
    if (!res.ok) {
      let msg = `Playlist tracks fetch failed (${res.status})`;
      try {
        const err = await res.json();
        if (typeof err.detail === "string") msg = err.detail;
      } catch (_) {
        /* ignore */
      }
      throw new Error(msg);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  },
  async playTrack(uri, meta) {
    const prefix = appModePrefix();
    const base = localBackendBase();
    const preview = meta?.preview_url;
    const openUrl = String(meta?.open_url || spotifyUriToOpenUrl(uri) || "").trim();
    window.__veraSpotifyLast = {
      preview_url: preview || "",
      open_url: openUrl,
      title: meta?.title || "",
      artist: meta?.artist || ""
    };
    spotifyUpdateNowState({
      title: meta?.title || "",
      artist: meta?.artist || "",
      paused: false,
      active: true
    });
    const titleEl = document.getElementById(`${prefix}-spotify-track-title`);
    const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);

    const st = await fetch(`${base}/api/spotify/connection-status`, {
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders() }
    })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .catch(() => ({ connected: false }));
    const connectedSpotify = !!st.connected;

    if (uri && !window.__veraSpotifyDeviceId && connectedSpotify) {
      await ensureSpotifyWebPlayer(prefix);
      await waitForSpotifyDeviceId(22000);
    }

    if (uri && window.__veraSpotifyDeviceId) {
      if (String(uri).trim().startsWith("spotify:track:")) {
        spotifySetPendingSdkTrack(uri);
      }
      const res = await fetch(`${base}/api/spotify/player/play`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...veraSpotifyAuthHeaders() },
        body: JSON.stringify({ uris: [uri], device_id: window.__veraSpotifyDeviceId })
      });
      if (res.ok) {
        window.__veraSpotifyPlaybackActive = true;
        if (titleEl) titleEl.textContent = meta?.title || "";
        if (artistEl) artistEl.textContent = meta?.artist || "";
        const playBtn = document.getElementById(`${prefix}-spotify-play`);
        if (playBtn && window.__veraSpotifyPlayer) {
          playBtn.textContent = "⏸";
          playBtn.setAttribute("aria-label", "Pause");
        }
        void spotifyRefreshWebPlaybackStateToUi(prefix);
        return;
      }
      spotifyClearPendingSdkTrack();
      let detail = "";
      try {
        const j = await res.json();
        detail = typeof j.detail === "string" ? j.detail : "";
      } catch (_) {
        /* ignore */
      }
      console.warn("[Spotify] play failed", res.status, detail);
      if (artistEl) {
        artistEl.textContent =
          detail || "Couldn't start playback in the browser (Spotify Premium + Web Playback required).";
      }
      return;
    }

    if (connectedSpotify && uri) {
      spotifyClearPendingSdkTrack();
      if (artistEl) {
        artistEl.textContent =
          "Connected, but the in-browser player isn't ready. Confirm Spotify Premium and try again.";
      }
      return;
    }

    spotifyClearPendingSdkTrack();
    const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
    if (!audio) return;
    audio.volume = spotifyGetVolume();
    if (preview) {
      audio.src = preview;
      await audio.play().catch(() => {});
      spotifySyncPlayButtonUi(prefix);
      spotifyUpdateNowState({
        title: meta?.title || "",
        artist: meta?.artist || "",
        position_ms: Math.round((audio.currentTime || 0) * 1000),
        duration_ms: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
        paused: !!audio.paused,
        active: !audio.paused,
        queue_next_available: false,
        queue_previous_count: 0,
        disallow_skip_prev: false
      });
      spotifyApplyNowStateToPanel(prefix);
      if (artistEl) artistEl.textContent = meta?.artist || "";
      return;
    }
    audio.removeAttribute("src");
    if (openUrl && !connectedSpotify) {
      window.open(openUrl, "_blank", "noopener,noreferrer");
      if (artistEl) {
        artistEl.textContent =
          `${meta?.artist || ""} — Opened Spotify in a new tab (connect Spotify in this panel for in-page playback).`.trim();
      }
      return;
    }
    if (artistEl) {
      artistEl.textContent =
        "Connect Spotify (Premium) above, or pick a track with a preview / open link.";
    }
  },
  async playPlaylist(playlistUri, meta = {}) {
    const prefix = appModePrefix();
    const base = localBackendBase();
    const contextUri = String(playlistUri || "").trim();
    if (!contextUri) return;
    spotifyClearPendingSdkTrack();

    const st = await fetch(`${base}/api/spotify/connection-status`, {
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders() }
    })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .catch(() => ({ connected: false }));
    const connectedSpotify = !!st.connected;
    if (!connectedSpotify) {
      const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
      if (artistEl) artistEl.textContent = "Connect Spotify to play playlists, albums, or artists in VERA.";
      return;
    }
    if (!window.__veraSpotifyDeviceId) {
      await ensureSpotifyWebPlayer(prefix);
      await waitForSpotifyDeviceId(22000);
    }
    if (!window.__veraSpotifyDeviceId) {
      const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
      if (artistEl) artistEl.textContent = "Spotify player not ready. Try again.";
      return;
    }

    const res = await fetch(`${base}/api/spotify/player/play-context`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...veraSpotifyAuthHeaders() },
      body: JSON.stringify({
        context_uri: contextUri,
        device_id: window.__veraSpotifyDeviceId
      })
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = typeof j.detail === "string" ? j.detail : "";
      } catch (_) {
        /* ignore */
      }
      const artistEl = document.getElementById(`${prefix}-spotify-track-artist`);
      if (artistEl) artistEl.textContent = detail || "Couldn't start playback.";
      return;
    }
    let defaultSub = "Playing from playlist";
    if (contextUri.startsWith("spotify:album:")) defaultSub = "Album";
    else if (contextUri.startsWith("spotify:artist:")) defaultSub = "Artist";
    spotifyUpdateNowState({
      title: meta?.playlist_name || "Playlist",
      artist: meta?.context_subtitle || defaultSub,
      paused: false,
      active: true
    });
    spotifyApplyNowStateToPanel(prefix);
    void spotifyRefreshWebPlaybackStateToUi(prefix);
  },
  async playPlaylistTrack(playlistUri, trackUri, meta = {}) {
    const prefix = appModePrefix();
    const base = localBackendBase();
    const contextUri = String(playlistUri || "").trim();
    const offsetUri = String(trackUri || "").trim();
    if (!contextUri || !offsetUri) return;

    const st = await fetch(`${base}/api/spotify/connection-status`, {
      credentials: "include",
      headers: { ...veraSpotifyAuthHeaders() }
    })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .catch(() => ({ connected: false }));
    const connectedSpotify = !!st.connected;
    if (!connectedSpotify) {
      await this.playTrack(offsetUri, meta);
      return;
    }
    if (!window.__veraSpotifyDeviceId) {
      await ensureSpotifyWebPlayer(prefix);
      await waitForSpotifyDeviceId(22000);
    }
    if (!window.__veraSpotifyDeviceId) {
      await this.playTrack(offsetUri, meta);
      return;
    }

    if (String(offsetUri).trim().startsWith("spotify:track:")) {
      spotifySetPendingSdkTrack(offsetUri);
    }
    const res = await fetch(`${base}/api/spotify/player/play-context`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...veraSpotifyAuthHeaders() },
      body: JSON.stringify({
        context_uri: contextUri,
        offset_uri: offsetUri,
        device_id: window.__veraSpotifyDeviceId
      })
    });
    if (!res.ok) {
      await this.playTrack(offsetUri, meta);
      return;
    }
    spotifyUpdateNowState({
      title: meta?.title || "",
      artist: meta?.artist || "",
      paused: false,
      active: true
    });
    spotifyApplyNowStateToPanel(prefix);
    void spotifyRefreshWebPlaybackStateToUi(prefix);
  },
  async skipNext() {
    const base = localBackendBase();
    const prefix = appModePrefix();
    if (!window.__veraSpotifyDeviceId) return;
    const res = await fetch(`${base}/api/spotify/player/next`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...veraSpotifyAuthHeaders() },
      body: JSON.stringify({ device_id: window.__veraSpotifyDeviceId })
    });
    if (!res.ok) return;
    await spotifyRefreshWebPlaybackStateToUi(prefix);
  },
  async skipPrevious() {
    const base = localBackendBase();
    const prefix = appModePrefix();
    console.log("[MUSIC][SKIP_PREV] start", {
      has_device_id: Boolean(window.__veraSpotifyDeviceId),
      has_player: Boolean(window.__veraSpotifyPlayer),
    });
    if (!window.__veraSpotifyDeviceId) {
      await ensureSpotifyWebPlayer(prefix);
      await waitForSpotifyDeviceId(8000);
    }
    if (!window.__veraSpotifyDeviceId) {
      console.log("[MUSIC][SKIP_PREV] abort:no-device-id");
      return;
    }
    let s = spotifyEnsureNowState();
    let pos = Number(s.position_ms) || 0;
    let seekRestartDone = false;
    console.log("[MUSIC][SKIP_PREV] precheck", {
      position_ms: pos,
      disallow_skip_prev: s.disallow_skip_prev === true,
      queue_previous_count: Number(s.queue_previous_count) || 0,
    });
    if (pos > SPOTIFY_PREVIOUS_RESTART_MS) {
      try {
        await this.seekTo(0);
        seekRestartDone = true;
        console.log("[MUSIC][SKIP_PREV] seek-restart-ok");
      } catch (_) {
        /* seek can fail transiently; still refresh state */
        console.log("[MUSIC][SKIP_PREV] seek-restart-failed");
      }
      await spotifyRefreshWebPlaybackStateToUi(prefix);
      if (seekRestartDone) return;
      console.log("[MUSIC][SKIP_PREV] seek-failed-fallback-to-previous");
    }
    if (s.disallow_skip_prev === true) {
      console.log("[MUSIC][SKIP_PREV] blocked-by-disallow-before-refresh");
      await spotifyRefreshWebPlaybackStateToUi(prefix);
      s = spotifyEnsureNowState();
      pos = Number(s.position_ms) || 0;
      console.log("[MUSIC][SKIP_PREV] after-refresh", {
        position_ms: pos,
        disallow_skip_prev: s.disallow_skip_prev === true,
        queue_previous_count: Number(s.queue_previous_count) || 0,
      });
      if (pos > SPOTIFY_PREVIOUS_RESTART_MS) {
        try {
          await this.seekTo(0);
          seekRestartDone = true;
          console.log("[MUSIC][SKIP_PREV] seek-restart-after-refresh-ok");
        } catch (_) {
          /* ignore */
          console.log("[MUSIC][SKIP_PREV] seek-restart-after-refresh-failed");
        }
        await spotifyRefreshWebPlaybackStateToUi(prefix);
        if (seekRestartDone) return;
        console.log("[MUSIC][SKIP_PREV] seek-after-refresh-failed-fallback-to-previous");
      }
      if (s.disallow_skip_prev === true) {
        console.log("[MUSIC][SKIP_PREV] abort:still-disallowed");
        return;
      }
    }
    /* Do not require ``previous_tracks`` in the SDK snapshot — it is often empty while context still has a prior track. */
    const delays = [0, 220, 650];
    let moved = false;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (attempt > 0) {
        await spotifyRefreshWebPlaybackStateToUi(prefix);
        const gate = spotifyEnsureNowState();
        if (gate.disallow_skip_prev === true) {
          console.log("[MUSIC][SKIP_PREV] retry-abort-disallowed", { attempt: attempt + 1 });
          break;
        }
      }
      if (delays[attempt] > 0) {
        await new Promise((r) => window.setTimeout(r, delays[attempt]));
      }
      try {
        const res = await fetch(`${base}/api/spotify/player/previous`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...veraSpotifyAuthHeaders() },
          body: JSON.stringify({ device_id: window.__veraSpotifyDeviceId })
        });
        console.log("[MUSIC][SKIP_PREV] previous-call", {
          attempt: attempt + 1,
          ok: Boolean(res?.ok),
          status: res?.status ?? -1
        });
        if (res?.ok) {
          moved = true;
          break;
        }
      } catch (_) {
        console.log("[MUSIC][SKIP_PREV] previous-call-error", { attempt: attempt + 1 });
      }
    }
    if (!moved) {
      const web = window.__veraSpotifyPlayer;
      if (web && typeof web.previousTrack === "function") {
        try {
          await web.previousTrack();
          moved = true;
          console.log("[MUSIC][SKIP_PREV] sdk-previousTrack-ok");
        } catch (_) {
          console.log("[MUSIC][SKIP_PREV] sdk-previousTrack-failed");
        }
      }
    }
    await spotifyRefreshWebPlaybackStateToUi(prefix);
    const endState = spotifyEnsureNowState();
    console.log("[MUSIC][SKIP_PREV] end", {
      position_ms: Number(endState.position_ms) || 0,
      disallow_skip_prev: endState.disallow_skip_prev === true,
      queue_previous_count: Number(endState.queue_previous_count) || 0,
      title: String(endState.title || ""),
    });
  },
  async togglePlayback() {
    const web = window.__veraSpotifyPlayer;
    if (web) {
      await web.togglePlay();
      return;
    }
    const prefix = appModePrefix();
    const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
    const last = window.__veraSpotifyLast || {};
    if (last.preview_url && audio) {
      if (audio.paused) await audio.play().catch(() => {});
      else audio.pause();
      spotifySyncPlayButtonUi(prefix);
      return;
    }
    if (last.open_url) {
      try {
        if (veraSpotifyGetStoredBearer()) return;
      } catch (_) {
        /* ignore */
      }
      window.open(last.open_url, "_blank", "noopener,noreferrer");
    }
  },
  async seekTo(positionMs) {
    const ms = Math.max(0, Math.floor(Number(positionMs) || 0));
    const prefix = appModePrefix();
    const web = window.__veraSpotifyPlayer;
    if (web) {
      await web.seek(ms);
      spotifyUpdateNowState({ position_ms: ms });
      window.__veraSpotifyResumeWeb = {
        ...(window.__veraSpotifyResumeWeb || {}),
        position_ms: ms
      };
      spotifyApplyNowStateToPanel(prefix);
      return;
    }
    const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
    if (audio) {
      const sec = ms / 1000;
      audio.currentTime = Number.isFinite(sec) ? sec : 0;
      spotifyUpdateNowState({ position_ms: Math.round((audio.currentTime || 0) * 1000) });
      persistSpotifyResumePreview(prefix);
      spotifyApplyNowStateToPanel(prefix);
    }
  },
  async setVolume(volume01) {
    const v = Math.max(0, Math.min(SPOTIFY_VOLUME_MAX, Number(volume01) || 0));
    window.__veraSpotifyVolume = v;
    const prefix = appModePrefix();
    const web = window.__veraSpotifyPlayer;
    if (web && typeof web.setVolume === "function") {
      await web.setVolume(v);
    }
    const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
    if (audio) audio.volume = v;
    const freeMusic = document.getElementById(`${prefix}-free-music-audio`);
    if (freeMusic) freeMusic.volume = v;
    const slider = document.getElementById(`${prefix}-spotify-volume`);
    if (slider && document.activeElement !== slider) {
      slider.value = String(Math.round(v * 100));
    }
  },
  getVolume() {
    return spotifyGetVolume();
  },
  async pausePlayback() {
    const prefix = appModePrefix();
    const web = window.__veraSpotifyPlayer;
    if (web && typeof web.pause === "function") {
      await web.pause();
      spotifyUpdateNowState({ paused: true, active: false });
      spotifyApplyNowStateToPanel(prefix);
      return;
    }
    const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
    if (audio) {
      audio.pause();
      spotifySyncPlayButtonUi(prefix);
      spotifyUpdateNowState({
        position_ms: Math.round((audio.currentTime || 0) * 1000),
        duration_ms: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
        paused: true,
        active: false,
        queue_next_available: false,
        queue_previous_count: 0,
        disallow_skip_prev: false
      });
      spotifyApplyNowStateToPanel(prefix);
    }
  },
  async resumePlayback() {
    const prefix = appModePrefix();
    const web = window.__veraSpotifyPlayer;
    if (web) {
      if (typeof web.resume === "function") {
        await web.resume();
      } else if (typeof web.togglePlay === "function") {
        await web.togglePlay();
      }
      spotifyUpdateNowState({ paused: false, active: true });
      spotifyApplyNowStateToPanel(prefix);
      return;
    }
    const audio = document.getElementById(`${prefix}-spotify-preview-audio`);
    const last = window.__veraSpotifyLast || {};
    if (audio && last.preview_url && !audio.src) {
      audio.src = last.preview_url;
    }
    if (audio && audio.paused && (audio.src || last.preview_url)) {
      await audio.play().catch(() => {});
      spotifySyncPlayButtonUi(prefix);
      spotifyUpdateNowState({
        position_ms: Math.round((audio.currentTime || 0) * 1000),
        duration_ms: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
        paused: false,
        active: true,
        queue_next_available: false,
        queue_previous_count: 0,
        disallow_skip_prev: false
      });
      spotifyApplyNowStateToPanel(prefix);
    }
  }
};