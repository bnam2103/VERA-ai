/* =========================================================================
 *  news/newsRouter.js — frontend news intent + pending status bubble layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 10). Behavior is preserved EXACTLY:
 *    - same `NEWS_EVENT_CLUE_RE` and `NEWS_NAMED_ENTITY_RE` regex sources
 *      (used both here and indirectly by app.js at call time),
 *    - same `looksLikeNewsSearchRequest()` heuristic — every negative
 *      filter, "do you know" gate, personal/emotional guard, recency
 *      gate, and named-entity check is byte-for-byte preserved,
 *    - same pending status bubble lifecycle (arm → cancel / fail), same
 *      90s stuck-request backstop (`PENDING_NEWS_STATUS_TIMEOUT_MS`),
 *      same placeholder copy "Searching news…",
 *    - same dataset attributes on the bubble element
 *      (`pendingStatus="news"`, `pendingForText=<utterance>`,
 *      `pendingToken=<n>`),
 *    - same bubble class names
 *      (`vera-pending-status vera-pending-status-news` while pending;
 *      `vera-pending-status-failed vera-safety-failure` on failure),
 *    - same idempotency rule (NDJSON `meta.transcript` can fire multiple
 *      times — the same utterance keeps the existing bubble + timer),
 *    - same console labels: `[pending_status_bubble]`,
 *      `[pending_news_bubble]`.
 *  Personal / emotional / loss-grief "news" suppression remains exactly
 *  as in app.js (e.g. "I got bad news", "saw the news my friend passed
 *  away"). No new news routing rules. No backend changes. No
 *  current-fact routing changes. No personal-news classifier changes.
 *  No Work Mode routing changes. No time / weather / finance routing
 *  changes.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come BEFORE app.js (so the moved `let`/`const`
 *  declarations and `function` declarations are visible to app.js
 *  callers through the shared classic-script global lexical env when
 *  app.js parses and runs). Order relative to news/newsPanel.js does
 *  not matter — neither module calls into the other; both end up as
 *  bare-identifier declarations in the same global lexical env.
 *
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/asr.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="voice/interruption.js?v=1"></script>
 *      <script src="workmode/panels.js?v=1"></script>
 *      <script src="workmode/checklist.js?v=1"></script>
 *      <script src="news/newsRouter.js?v=1"></script>      <-- NEW
 *      <script src="news/newsPanel.js?v=1"></script>       <-- NEW
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Bare-identifier references resolved at CALL time through the shared
 *  global lexical env (NOT at module load):
 *    addBubble                  (app.js)
 *    persistVeraChatState       (app.js)
 *    isLikelyRequestShape       (app.js — optional, the call is guarded
 *                                by `typeof ... === "function"`)
 *    VERA_SAFETY_LIMITS         (app.js)
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers in the global lexical env)
 *  ─────────────────────────────────────────────────────────────────────
 *    regex constants            NEWS_EVENT_CLUE_RE, NEWS_NAMED_ENTITY_RE
 *    pending-bubble constants   PENDING_NEWS_STATUS_TIMEOUT_MS,
 *                               PENDING_NEWS_STATUS_TEXT
 *    pending-bubble state       pendingNewsStatusBubble,
 *                               pendingNewsStatusTimerId,
 *                               pendingNewsStatusToken
 *    intent classifier          looksLikeNewsSearchRequest(text)
 *    pending-bubble lifecycle   _clearPendingNewsStatusTimer(),
 *                               armPendingNewsStatusBubble(userText, opts),
 *                               cancelPendingNewsStatusBubble(reason),
 *                               failPendingNewsStatusBubble(reason)
 *    window aliases (new)       window.getNewsRouterDebugState()
 *                                   read-only snapshot of pending bubble
 *                                   state, classifier wiring, last-armed
 *                                   utterance, current timer status.
 * ========================================================================= */

/* =========================
   NEWS INTENT REGEXES
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

  // Personal / emotional uses of the word "news" must NEVER trigger the
  // "Searching news…" placeholder. Catches phrases like:
  //   - "i got bad news"
  //   - "i have terrible news"
  //   - "sad news from my family"
  //   - "i just saw the news my friend passed away"
  //   - "news from my mom"
  // Mirrors the backend personal/emotional guard so the UI and router agree.
  if (
    /\b(?:bad|sad|terrible|awful|tragic|heavy|hard|difficult|devastating|heartbreaking|grim|rough|tough|big|personal|family)\s+news\b/.test(
      raw
    )
  ) return false;
  if (
    /\bnews\s+(?:from|about)\s+(?:my|our|the|a)\s+(?:friend|friends|family|mom|mother|dad|father|brother|sister|wife|husband|girlfriend|boyfriend|partner|parent|parents|son|daughter|kid|kids|baby|cousin|aunt|uncle|grandma|grandpa|grandmother|grandfather|coworker|colleague|boss|neighbor|doctor|relative|relatives)\b/.test(
      raw
    )
  ) return false;
  if (
    /\b(?:got|have|received|hearing|heard|just\s+(?:got|received|heard|saw|read))\s+(?:some\s+|the\s+|this\s+)?(?:bad|sad|terrible|awful|tragic|heavy|hard|difficult|devastating|heartbreaking|grim|rough|tough|big|personal|crazy)\s+news\b/.test(
      raw
    )
  ) return false;
  if (
    /\b(?:saw|heard|read|got)\s+(?:the|some|that|this|on\s+the)\s+news\s+(?:that\s+)?(?:my|our|a)\s*(?:friend|family|mom|mother|dad|father|brother|sister|wife|husband|girlfriend|boyfriend|partner|parent|son|daughter|relative|coworker|colleague|neighbor|grandma|grandpa|grandmother|grandfather|kid|baby)\b/.test(
      raw
    )
  ) return false;
  // Loss / grief co-occurrence with "news" — never a news search.
  if (
    /\bnews\b[\s\S]{0,80}\b(?:passed\s+away|died|funeral|in\s+the\s+hospital|got\s+(?:hurt|hit|injured)|in\s+a\s+(?:coma|wreck|crash)|diagnosed|cancer|miscarriage|stroke|heart\s+attack)\b/.test(
      raw
    )
  ) return false;
  if (
    /\b(?:passed\s+away|died|funeral|diagnosed|miscarriage)\b[\s\S]{0,80}\bnews\b/.test(
      raw
    )
  ) return false;

  // Explicit news asks. The bare word "news" is intentionally NOT a trigger
  // on its own (too many false positives like "bad news", "I saw the news
  // my friend passed away"). It only fires here when paired with a clear
  // request verb, a topic phrase, or a recency adjective.
  if (
    /\b(?:tell|give|show|read|bring|fetch|find|search\s+for|look\s+up|look\s+at|open|grab|pull\s+up|get|update\s+me\s+on)\s+(?:me\s+|us\s+)?(?:the\s+|some\s+|today'?s\s+|latest\s+|breaking\s+|recent\s+)?(?:news|headlines?)\b/.test(
      raw
    )
  ) return true;
  if (/\bnews\s+(?:about|on|regarding|covering|of)\s+\S/.test(raw)) return true;
  if (
    /\b(?:breaking|latest|recent|today'?s|tonight'?s|this\s+(?:morning|afternoon|evening|week)'?s?)\s+news\b/.test(
      raw
    )
  ) return true;
  if (/\bany\s+news\s+(?:about|on|regarding)\s+\S/.test(raw)) return true;
  if (/\b(?:headline|news)\s+(?:search|searches|panel|page|tab)\b/.test(raw)) return true;
  if (/\bheadlines?\b/.test(raw)) return true;
  if (/\blatest\b/.test(raw)) return true;
  if (/\bbreaking\b/.test(raw)) return true;
  if (/\barticles?\b/.test(raw)) return true;
  if (/\bsources?\??\s*$/.test(raw)) return true;
  if (/\b(?:search|google|look\s*up|search\s*for|look\s*it\s*up)\b/.test(raw)) return true;

  // Weak recency words (today / tonight / this week / current(ly) / recent(ly))
  // are NOT triggers on their own — that produced false positives like
  // "I have a lot of homework today" or "I'm tired today" flashing
  // "Searching news…". Require BOTH a real request shape AND a STRONG
  // public-news indicator (news verb, news noun, or named public entity)
  // before arming the bubble. We intentionally use a stricter regex than
  // NEWS_EVENT_CLUE_RE because that pattern includes the recency words
  // themselves (otherwise "today" would gate itself).
  const hasWeakRecency = /\b(?:today|tonight|this\s+(?:week|morning|afternoon|evening)|current(?:ly)?|recent(?:ly)?)\b/.test(
    raw
  );
  if (hasWeakRecency) {
    const isRequest =
      typeof isLikelyRequestShape === "function" ? isLikelyRequestShape(raw) : false;
    const strongNewsTail =
      /\b(?:news|headlines?|articles?|reports?|stor(?:y|ies)|coverage|press|earnings|election|stock|market|trial|lawsuit|investigation|interview|filing|deal|merger|acquisition|launched|announced|released|sued|arrested|fired|hired|signed|elected|indicted|won|lost|died|killed|attacked|crashed|hacked|leaked|revealed|appointed|nominated|happened|happening|going\s+on)\b/.test(
        raw
      );
    const hasPublicNewsIntent = strongNewsTail || NEWS_NAMED_ENTITY_RE.test(raw);
    if (isRequest && hasPublicNewsIntent) return true;
    /* Otherwise fall through — the strong rules below may still match
       (e.g. "what happened today"), but bare recency alone does NOT trigger. */
  }

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

/* =========================
   PENDING NEWS STATUS BUBBLE LIFECYCLE
========================= */

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
   STAGE 10 (additive): read-only debug accessor
========================= */

function getNewsRouterDebugState() {
  let bubbleConnected = false;
  let bubbleStatus = null;
  let bubbleForText = null;
  let bubbleToken = null;
  try {
    if (pendingNewsStatusBubble) {
      bubbleConnected = Boolean(pendingNewsStatusBubble.isConnected);
      bubbleStatus = pendingNewsStatusBubble.dataset?.pendingStatus || null;
      bubbleForText = pendingNewsStatusBubble.dataset?.pendingForText || null;
      const tok = pendingNewsStatusBubble.dataset?.pendingToken;
      bubbleToken = tok != null ? Number(tok) : null;
    }
  } catch (_) {}
  return {
    pending_news_status_text: PENDING_NEWS_STATUS_TEXT,
    pending_news_status_timeout_ms: PENDING_NEWS_STATUS_TIMEOUT_MS,
    pending_bubble_present: pendingNewsStatusBubble != null,
    pending_bubble_connected: bubbleConnected,
    pending_bubble_status: bubbleStatus,
    pending_bubble_for_text: bubbleForText,
    pending_bubble_token: bubbleToken,
    pending_token_counter: pendingNewsStatusToken,
    pending_timer_active: pendingNewsStatusTimerId != null,
    looks_like_news_search_request_typeof: typeof looksLikeNewsSearchRequest,
    arm_pending_news_status_bubble_typeof: typeof armPendingNewsStatusBubble,
    cancel_pending_news_status_bubble_typeof: typeof cancelPendingNewsStatusBubble,
    fail_pending_news_status_bubble_typeof: typeof failPendingNewsStatusBubble,
    news_event_clue_re_source: NEWS_EVENT_CLUE_RE.source,
    news_named_entity_re_source: NEWS_NAMED_ENTITY_RE.source
  };
}

try {
  window.getNewsRouterDebugState = getNewsRouterDebugState;
} catch (_) {}
