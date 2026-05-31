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

  // PART 2 (2026-05-28) — historical / educational / explanatory queries are
  // NEVER news searches. Mirrors backend `_is_historical_or_educational_question`.
  // Catches:
  //   - "Can you explain the Vietnam War?"
  //   - "What caused the Cold War?"
  //   - "Tell me about Napoleon."
  //   - "Explain the French Revolution."
  //   - "Who founded OpenAI?" (educational, stable bg fact)
  // Override: if the message ALSO contains "news/headlines/today/latest/
  // breaking/release date/announce/launch/debut", let downstream rules
  // handle it — e.g. "Latest news about the Vietnam War documentary" is
  // legitimate news, not history.
  const histEduNewsOverride =
    /\b(?:news|headlines?|breaking|today|yesterday|last\s+week|recently|currently|right\s+now|just\s+(?:released|announced|launched)|latest\s+(?:on|about|update|news)|new\s+(?:episode|season|series|documentary|movie|film|book|trailer|game)|upcoming|premiere|release\s+date|announce(?:s|d|ment)|launch(?:es|ed)?|debut(?:s|ed)?)\b/.test(
      raw
    );
  if (!histEduNewsOverride) {
    const histTopicNoun =
      /\b(?:vietnam\s+war|world\s+war\s+(?:i|ii|one|two|1|2)|world\s+wars?|cold\s+war|korean\s+war|civil\s+war|gulf\s+war|iraq\s+war|afghanistan\s+war|napoleonic\s+wars?|crimean\s+war|french\s+revolution|american\s+revolution|russian\s+revolution|industrial\s+revolution|roman\s+empire|byzantine\s+empire|ottoman\s+empire|british\s+empire|holy\s+roman\s+empire|persian\s+empire|mongol\s+empire|ming\s+dynasty|qing\s+dynasty|han\s+dynasty|tang\s+dynasty|ancient\s+(?:rome|greece|egypt|china|persia|mesopotamia|india)|medieval\s+(?:europe|england|france|japan|china)|renaissance|enlightenment|reformation|middle\s+ages|dark\s+ages|stone\s+age|bronze\s+age|iron\s+age|victorian\s+era|edwardian\s+era|elizabethan\s+era|holocaust|cuban\s+missile\s+crisis|berlin\s+wall|soviet\s+union|ussr|bolshevik\s+revolution|manhattan\s+project|slavery|abolition|civil\s+rights\s+movement|napoleon|julius\s+caesar|alexander\s+the\s+great|genghis\s+khan|cleopatra|theorem|equation|formula|theory\s+of\s+(?:relativity|evolution|gravity)|big\s+bang|black\s+hole|photosynthesis|mitosis|dna|shakespeare|odyssey|iliad|physics|chemistry|biology|calculus|algebra|geometry)\b/.test(
        raw
      );
    if (histTopicNoun) return false;
    const histEduLead =
      /^\s*(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?(?:explain|describe|summari[sz]e|teach\s+me\s+about|tell\s+me\s+(?:about|the\s+history\s+of|more\s+about)|give\s+me\s+(?:a\s+)?(?:summary|overview|background|brief|primer|explanation|history)\s+of|walk\s+me\s+through)\b/.test(
        raw
      );
    if (histEduLead) return false;
  }

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
   PART 1+14 (2026-05-28): frontend 8-category route classifier + log
========================= */

/* Classify the current user turn into one of the 8 spec categories so the
 * frontend can emit `[news_router_route]` for log parity with the backend.
 * The frontend does NOT execute search; this is instrumentation + the
 * gate for the pending bubble + Work-Mode reasoning veto. The backend
 * (`classify_current_info_intent`) is the authoritative router.
 *
 * Returns one of:
 *   "personal_or_emotional"
 *   "utility_time_weather_finance_or_app_action"
 *   "historical_or_educational_explanation"
 *   "explicit_news_request"
 *   "current_fact_search"
 *   "interpretive_followup_llm"
 *   "fresh_or_source_followup_search"
 *   "general_llm"
 */

/* Personal/emotional uses of the word "news" (mirrors backend
 * `_is_personal_news_statement` + `_is_emotional_distress_statement`). */
const _NEWS_ROUTER_PERSONAL_NEWS_RE = /\b(?:bad|sad|terrible|awful|tragic|heavy|hard|difficult|devastating|heartbreaking|grim|rough|tough|big|personal|family)\s+news\b|\bnews\s+(?:from|about)\s+(?:my|our|the|a)\s+(?:friend|family|mom|mother|dad|father|brother|sister|wife|husband|girlfriend|boyfriend|partner|parent|son|daughter|kid|baby|cousin|aunt|uncle|grandma|grandpa|grandmother|grandfather|coworker|colleague|boss|neighbor|doctor|relative)/i;

const _NEWS_ROUTER_PERSONAL_GRIEF_RE = /\bnews\b[\s\S]{0,80}\b(?:passed\s+away|died|funeral|in\s+the\s+hospital|got\s+(?:hurt|hit|injured)|in\s+a\s+(?:coma|wreck|crash)|diagnosed|cancer|miscarriage|stroke|heart\s+attack)\b|\b(?:passed\s+away|died|funeral|diagnosed|miscarriage)\b[\s\S]{0,80}\bnews\b/i;

/* Utility detectors (time/weather/finance/app-action). Frontend only needs
 * to RECOGNIZE these so the route log is right — backend already dispatches
 * them via dedicated handlers ahead of news routing. */
const _NEWS_ROUTER_TIME_QUERY_RE = /\bwhat(?:'?s| is)?\s+(?:the\s+)?(?:time|date|day)\b|\bwhat\s+time\s+is\s+it\b|\btell\s+me\s+the\s+time\b/i;
const _NEWS_ROUTER_WEATHER_QUERY_RE = /\b(?:weather|forecast|temperature|rain(?:ing|y)?|snow(?:ing|y)?|sunny|cloudy|humid(?:ity)?|wind(?:y)?)\b/i;
const _NEWS_ROUTER_FINANCE_QUERY_RE = /\b(?:price\s+of|trading\s+at|stock\s+price|share\s+price|market\s+cap|earnings|dividend|p\/e|drawdown|sharpe|volatility|return\s+of|ticker)\b|\$[A-Z]{1,5}\b/i;
const _NEWS_ROUTER_APP_ACTION_RE = /\b(?:close|open|sync|remove|set\s+(?:a\s+)?timer|set\s+(?:a\s+)?reminder|play|pause|skip|mute|unmute|volume|switch\s+to|bring\s+up|show)\s+(?:the\s+|my\s+|a\s+)?(?:panel|tab|news\s+panel|reasoning|work\s+mode|checklist|timer|reminder|item|task|playlist|music|song|track|page|view)\b/i;

/* Historical/educational topic noun (mirrors backend
 * `_HIST_EDU_TOPIC_NOUN_RE`). */
const _NEWS_ROUTER_HIST_EDU_TOPIC_RE = /\b(?:vietnam\s+war|world\s+war\s+(?:i|ii|one|two|1|2)|cold\s+war|korean\s+war|civil\s+war|napoleonic\s+wars?|french\s+revolution|american\s+revolution|russian\s+revolution|industrial\s+revolution|roman\s+empire|byzantine\s+empire|ottoman\s+empire|british\s+empire|holy\s+roman\s+empire|persian\s+empire|mongol\s+empire|ming\s+dynasty|qing\s+dynasty|han\s+dynasty|tang\s+dynasty|ancient\s+(?:rome|greece|egypt|china|persia|mesopotamia|india)|medieval\s+(?:europe|england|france|japan|china)|renaissance|enlightenment|reformation|middle\s+ages|dark\s+ages|stone\s+age|bronze\s+age|iron\s+age|victorian\s+era|edwardian\s+era|elizabethan\s+era|holocaust|cuban\s+missile\s+crisis|berlin\s+wall|soviet\s+union|ussr|bolshevik\s+revolution|manhattan\s+project|slavery|abolition|civil\s+rights\s+movement|napoleon|julius\s+caesar|alexander\s+the\s+great|genghis\s+khan|cleopatra|theorem|equation|formula|theory\s+of\s+(?:relativity|evolution|gravity)|big\s+bang|black\s+hole|photosynthesis|mitosis|dna|shakespeare|odyssey|iliad|physics|chemistry|biology|calculus|algebra|geometry)\b/i;
const _NEWS_ROUTER_HIST_EDU_LEAD_RE = /^\s*(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|please\s+)?(?:explain|describe|summari[sz]e|teach\s+me\s+about|tell\s+me\s+(?:about|the\s+history\s+of|more\s+about)|give\s+me\s+(?:a\s+)?(?:summary|overview|background|brief|primer|explanation|history)\s+of|walk\s+me\s+through)\b/i;
const _NEWS_ROUTER_HIST_EDU_NEWS_OVERRIDE_RE = /\b(?:news|headlines?|breaking|today|yesterday|last\s+week|recently|currently|right\s+now|just\s+(?:released|announced|launched)|latest\s+(?:on|about|update|news)|new\s+(?:episode|season|series|documentary|movie|film|book|trailer|game)|upcoming|premiere|release\s+date|announce(?:s|d|ment)|launch(?:es|ed)?|debut(?:s|ed)?)\b/i;

/* Pronoun/deictic markers for follow-up classification. */
const _NEWS_ROUTER_PRONOUN_DEICTIC_RE = /\b(?:he|she|they|him|her|them|his|hers|theirs|it|that|this|there|then|after\s+that)\b/i;

/* Interpretive follow-up phrasings (PART 9). */
const _NEWS_ROUTER_INTERPRETIVE_FOLLOWUP_RE = /\b(?:why\s+(?:was|did|is|were)|why\s+(?:he|she|they)|what\s+does\s+(?:that|this|it)\s+mean|why\s+is\s+(?:that|this|it)\s+important|is\s+(?:that|this|it)\s+(?:bad|good|important|relevant|true)|can\s+you\s+explain|what\s+was\s+the\s+reason|what\s+caused\s+(?:that|this|it))\b/i;

/* Fresh/source/new-fact follow-up phrasings (PART 10). */
const _NEWS_ROUTER_FRESH_FOLLOWUP_RE = /\b(?:any\s+updates?|what'?s\s+the\s+latest|was\s+(?:that|this|it)\s+(?:confirmed|verified)|what\s+happened\s+(?:after|next)|who\s+else\s+was\s+there|when\s+exactly|where\s+exactly|what\s+does\s+(?:reuters|bloomberg|associated\s+press|ap|cnn|bbc|nyt|new\s+york\s+times|wsj|wall\s+street\s+journal)\s+say|find\s+more\s+(?:sources?|articles?)|verify\s+(?:that|this|it)|can\s+you\s+verify)\b/i;

function _newsRouterDetectNamedEntity(raw) {
  return NEWS_NAMED_ENTITY_RE.test(raw);
}

function _newsRouterDetectQuestionShape(raw) {
  return /^\s*(?:did|do|does|is|are|was|were|has|have|will|can|could|would|should|who|what|when|where|why|how)\b/.test(raw);
}

function _newsRouterDetectRecentMarker(raw) {
  return /\b(?:today|tonight|yesterday|right\s+now|now|currently|recently|just\s+now|earlier|last\s+(?:week|night|month|year|hour|day)|this\s+(?:week|morning|afternoon|evening|month|year)|past\s+(?:week|month|year|24|few\s+days|two\s+weeks|14\s+days|30\s+days)|latest|newest|most\s+recent|breaking)\b/i.test(raw);
}

/* Explicit "news/headlines/articles" keyword in a request shape. Distinct
 * from current-fact "did X happen" — that uses score_current_fact_question. */
const _NEWS_ROUTER_EXPLICIT_NEWS_KW_RE = /\b(?:news|headlines?|articles?|stor(?:y|ies)|coverage|breaking)\b/i;

/* "did/was/is <NAMED-ENTITY-OR-NOT> ... predicate" — current-fact shape.
 * Used when there is no explicit news keyword but the user asked a yes/no
 * factual question that VERA should verify externally. */
function _newsRouterIsCurrentFactShape(raw) {
  return /^\s*(?:did|do|does|is|are|was|were|has|have)\b/i.test(raw)
      || /\b(?:do\s+you\s+know\s+if|is\s+it\s+true\s+that|was\s+it\s+confirmed|what\s+happened\s+with)\b/i.test(raw);
}

/* Question that LEADS with a pronoun ("was he", "did she", "is it",
 * "have they"). When ctx exists this is a follow-up regardless of any
 * later-in-sentence named entity (PART 11). */
function _newsRouterStartsWithPronounQuestion(raw) {
  return /^\s*(?:did|do|does|is|are|was|were|has|have|will|can|could|would|should)\s+(?:he|she|they|him|her|them|it)\b/i.test(raw)
      || /^\s*(?:why|where|when|how|what)\s+(?:was|were|did|do|does|is|are|has|have)\s+(?:he|she|they|him|her|them|it)\b/i.test(raw)
      || /^\s*(?:why|where|when|how|what)\s+(?:he|she|they|him|her|them|it)\b/i.test(raw);
}

function classifyVeraTurnRoute(text, opts = {}) {
  const raw = String(text || "").trim();
  const recentNewsCtx = opts && opts.recentNewsContext;
  const hasCtx = Boolean(recentNewsCtx && typeof recentNewsCtx === "object" && Object.keys(recentNewsCtx).length);
  const signals = {
    personal_emotional_detected: false,
    utility_query_detected: false,
    historical_or_educational_detected: false,
    explicit_news_request_detected: false,
    current_fact_search_detected: false,
    question_shape_detected: false,
    named_entity_in_current_message: false,
    recent_or_change_marker_detected: false,
    pronoun_or_deictic_detected: false,
    followup_detected: false,
    followup_type: "none",
    previous_news_context_available: hasCtx,
    blocked_news_reason: "",
  };
  if (!raw) {
    return { route: "general_llm", shouldSearchNews: false, shouldOpenNewsPanel: false, signals, searchQuerySource: "none", searchQueryGenerated: "" };
  }
  const low = raw.toLowerCase();

  // 1. Personal/emotional ALWAYS wins.
  if (_NEWS_ROUTER_PERSONAL_NEWS_RE.test(low) || _NEWS_ROUTER_PERSONAL_GRIEF_RE.test(low)) {
    signals.personal_emotional_detected = true;
    signals.blocked_news_reason = "personal_emotional";
    return { route: "personal_or_emotional", shouldSearchNews: false, shouldOpenNewsPanel: false, signals, searchQuerySource: "none", searchQueryGenerated: "" };
  }
  // 2. Utility (time/weather/finance/app-action) beats news.
  if (
    _NEWS_ROUTER_TIME_QUERY_RE.test(low) ||
    _NEWS_ROUTER_WEATHER_QUERY_RE.test(low) ||
    _NEWS_ROUTER_FINANCE_QUERY_RE.test(low) ||
    _NEWS_ROUTER_APP_ACTION_RE.test(low)
  ) {
    signals.utility_query_detected = true;
    signals.blocked_news_reason = "utility_query";
    return { route: "utility_time_weather_finance_or_app_action", shouldSearchNews: false, shouldOpenNewsPanel: false, signals, searchQuerySource: "none", searchQueryGenerated: "" };
  }
  // 3. Historical/educational explanation (unless news override).
  // Topic noun is REQUIRED — the lead verb alone ("can you explain?",
  // "why did he do that?") is too generic and usually maps to a follow-up
  // over stored news context, not a history lesson. Mirrors the backend
  // tightening in `_is_historical_or_educational_question` (2026-05-28).
  if (!_NEWS_ROUTER_HIST_EDU_NEWS_OVERRIDE_RE.test(low)) {
    const histTopic = _NEWS_ROUTER_HIST_EDU_TOPIC_RE.test(low);
    if (histTopic) {
      signals.historical_or_educational_detected = true;
      signals.blocked_news_reason = "historical_or_educational";
      return { route: "historical_or_educational_explanation", shouldSearchNews: false, shouldOpenNewsPanel: false, signals, searchQuerySource: "none", searchQueryGenerated: "" };
    }
  }
  // Compute shared signals once.
  const pronounOrDeictic = _NEWS_ROUTER_PRONOUN_DEICTIC_RE.test(low);
  const startsWithPronounQ = _newsRouterStartsWithPronounQuestion(raw);
  const hasNamedEntity = _newsRouterDetectNamedEntity(low);
  const hasQuestionShape = _newsRouterDetectQuestionShape(low);
  const hasRecentMarker = _newsRouterDetectRecentMarker(low);
  const hasExplicitNewsKw = _NEWS_ROUTER_EXPLICIT_NEWS_KW_RE.test(low);
  signals.pronoun_or_deictic_detected = pronounOrDeictic;
  signals.named_entity_in_current_message = hasNamedEntity;
  signals.question_shape_detected = hasQuestionShape;
  signals.recent_or_change_marker_detected = hasRecentMarker;

  // PART 11: a question whose SUBJECT is a pronoun ("was he", "why did she",
  // "what about them") is a follow-up even if a named entity appears later
  // as a supporting noun ("was HE part of the OPENAI team?"). The CURRENT-
  // SUBJECT named-entity test must also see the entity early in the
  // sentence, otherwise treat as follow-up.
  const isStandaloneFactual = hasNamedEntity && hasQuestionShape && !startsWithPronounQ;

  // 4. Follow-up classification when stored context exists.
  // 4a. Fresh-update / source-specific follow-up: explicit "any updates",
  //     "what does Reuters say", etc. These can fire without a pronoun.
  if (hasCtx && _NEWS_ROUTER_FRESH_FOLLOWUP_RE.test(low) && !isStandaloneFactual) {
    signals.followup_detected = true;
    signals.followup_type = "fresh_update";
    return { route: "fresh_or_source_followup_search", shouldSearchNews: true, shouldOpenNewsPanel: false, signals, searchQuerySource: "resolved_followup", searchQueryGenerated: raw };
  }
  // 4b. Interpretive follow-up: pronoun/deictic question over stored ctx,
  //     and the current message is NOT a standalone factual question with
  //     its own named-entity subject.
  if (hasCtx && (startsWithPronounQ || (pronounOrDeictic && !isStandaloneFactual))) {
    signals.followup_detected = true;
    if (_NEWS_ROUTER_INTERPRETIVE_FOLLOWUP_RE.test(low)) {
      signals.followup_type = "interpretive";
    } else {
      signals.followup_type = "interpretive";
    }
    signals.blocked_news_reason = "interpretive_followup_answer_from_stored_ctx";
    return { route: "interpretive_followup_llm", shouldSearchNews: false, shouldOpenNewsPanel: false, signals, searchQuerySource: "none", searchQueryGenerated: "" };
  }
  // 5. Explicit news request: requires the literal `news/headlines/articles`
  //    keyword in a request/info shape (covered by looksLikeNewsSearchRequest
  //    when paired with one of those nouns). Yes/no current-fact questions
  //    like "Did Trump go to China last week?" fall through to category 6,
  //    NOT here — even though looksLikeNewsSearchRequest also returns true
  //    for them, they are CURRENT-FACT-SEARCH per PART 6, not EXPLICIT-NEWS.
  if (hasExplicitNewsKw && looksLikeNewsSearchRequest(raw)) {
    signals.explicit_news_request_detected = true;
    return { route: "explicit_news_request", shouldSearchNews: true, shouldOpenNewsPanel: false, signals, searchQuerySource: "current_user_text", searchQueryGenerated: raw };
  }
  // 6. Current fact search: yes/no factual question shape + named-entity
  //    subject (the standalone-factual gate from PART 11 already excludes
  //    pronoun-led follow-ups). User chose current_fact_search default for
  //    stable named-entity questions (PART 12) so we don't gate on
  //    hasRecentMarker — any named-entity factual question triggers.
  if (isStandaloneFactual && _newsRouterIsCurrentFactShape(raw)) {
    signals.current_fact_search_detected = true;
    return { route: "current_fact_search", shouldSearchNews: true, shouldOpenNewsPanel: false, signals, searchQuerySource: "current_user_text", searchQueryGenerated: raw };
  }
  // 7. Fall-through: general LLM.
  signals.blocked_news_reason = "general_chat_no_news_signal";
  return { route: "general_llm", shouldSearchNews: false, shouldOpenNewsPanel: false, signals, searchQuerySource: "none", searchQueryGenerated: "" };
}

/* PART 14 — emit the structured route log from the frontend so it shows
 * up in the browser DevTools console alongside the backend's matching
 * [news_router_route] line. The two lines should agree on `route`. */
function logNewsRouterRouteFrontend(text, classification) {
  try {
    const c = classification || {};
    const s = c.signals || {};
    console.info("[news_router_route] " + JSON.stringify({
      side: "frontend",
      latest_user_text: String(text || "").slice(0, 200),
      route: c.route || "general_llm",
      shouldSearchNews: Boolean(c.shouldSearchNews),
      shouldOpenNewsPanel: Boolean(c.shouldOpenNewsPanel),
      explicit_news_request_detected: Boolean(s.explicit_news_request_detected),
      current_fact_search_detected: Boolean(s.current_fact_search_detected),
      historical_or_educational_detected: Boolean(s.historical_or_educational_detected),
      utility_query_detected: Boolean(s.utility_query_detected),
      personal_emotional_detected: Boolean(s.personal_emotional_detected),
      followup_detected: Boolean(s.followup_detected),
      followup_type: String(s.followup_type || "none"),
      pronoun_or_deictic_detected: Boolean(s.pronoun_or_deictic_detected),
      named_entity_in_current_message: Boolean(s.named_entity_in_current_message),
      previous_news_context_available: Boolean(s.previous_news_context_available),
      search_query_generated: String(c.searchQueryGenerated || "").slice(0, 200),
      search_query_source: String(c.searchQuerySource || "none"),
      blocked_news_reason: String(s.blocked_news_reason || ""),
    }));
  } catch (_) {}
}

try {
  window.classifyVeraTurnRoute = classifyVeraTurnRoute;
  window.logNewsRouterRouteFrontend = logNewsRouterRouteFrontend;
} catch (_) {}

/* ============================================================================
 * 2026-05-28 — beta info-tool router (frontend mirror).
 *
 * `classifyInfoTool` returns the same shape the backend's
 * `app.classify_info_tool` returns, so the browser console gets an
 * `[info_tool_route]` log line on every typed/voice turn that lines up
 * with the backend log. The backend is the authoritative router; this
 * function is purely instrumentation + a hook for future frontend pending
 * bubbles ("searching the web…").
 *
 * Schema:
 *   {
 *     route, tool, query, entities[], metric, timeframe,
 *     required_context[], confidence, reason
 *   }
 *
 * Routes mirror the backend enum verbatim:
 *   time_tool | weather_tool | finance_quote_tool | finance_search_tool |
 *   news_search_tool | general_web_search_tool | llm_only |
 *   followup_llm | followup_search | clarification_needed | uncertain
 * ========================================================================== */

const _INFO_TOOL_TIME_RE = /\b(?:what(?:'s|s|\s+is)?|whats|tell\s+me|current|do\s+you\s+know)\b[^?]*?\b(?:time|hour|clock)\b/i;
const _INFO_TOOL_DATE_RE = /\b(?:what(?:'s|s|\s+is)?|whats|tell\s+me|today(?:'s|s)?)\b[^?]*?\b(?:day|date)\b(?!\s+(?:of\s+the\s+week\s+did|that))/i;
const _INFO_TOOL_WEATHER_RE = /\b(?:weather|forecast|temperature|temp|raining|rain|snow(?:ing)?|sunny|cloudy|windy|humid(?:ity)?|how(?:'s|s|\s+is)?\s+the\s+weather)\b/i;
const _INFO_TOOL_FINANCE_QUOTE_RE = /\b(?:stock\s+price|share\s+price|price\s+of|quote\s+for|trading\s+at|market\s+cap|how\s+much\s+is|how(?:'s|s|\s+is)\s+(?:[a-z]+\s+)?stock|how(?:'s|s|\s+is)\s+(?:[a-z]+\s+)?doing\s+today)\b/i;
const _INFO_TOOL_FINANCE_ANALYTICS_RE = /\b(?:max(?:imum)?\s+drawdown|biggest\s+drawdown|worst\s+drawdown|drawdown|historical\s+return|annualized?\s+return|cagr|rolling\s+return|trailing\s+return|\d+[- ]?year\s+performance|\d+[- ]?year\s+return|volatility|sharpe|sortino|beta|alpha|year-over-year|52[-\s]?week)\b/i;
const _INFO_TOOL_SPORTS_TEAM_RE = /\b(?:lakers|clippers|warriors|celtics|knicks|heat|bulls|spurs|nets|sixers|76ers|raptors|bucks|mavericks|nuggets|suns|kings|pelicans|jazz|wizards|hawks|hornets|magic|grizzlies|thunder|rockets|timberwolves|trail\s*blazers|pacers|pistons|cavaliers|cavs|yankees|red\s*sox|dodgers|giants|cubs|astros|mets|braves|phillies|orioles|nationals|cardinals|brewers|padres|angels|royals|tigers|chiefs|patriots|eagles|cowboys|49ers|niners|packers|bears|bills|steelers|ravens|broncos|raiders|chargers|jets|saints|falcons|panthers|buccaneers|seahawks|rams|vikings|lions|liverpool|arsenal|chelsea|manchester|man\s+city|man\s+utd|barcelona|real\s+madrid|psg|bayern|juventus|inter|milan)\b/i;
const _INFO_TOOL_SPORTS_VERB_RE = /\b(?:win|won|lose|lost|beat|beating|score|scored|game|games|match|matches|play(?:ing|ed)?|tonight|last\s+night|yesterday)\b/i;

/* =========================================================================
 *  Sport-aware classifier — JS port of actions/sports.classify_sports_intent.
 *
 *  The full structured router lives in Python (actions/sports.py). This port
 *  exists so the frontend pre-router can:
 *    (a) recognize tennis players, tournaments, and follow-ups BEFORE the
 *        backend round-trip,
 *    (b) keep panel labeling honest ("Sports Results" / "Tournament Results"
 *        instead of "Search Results"),
 *    (c) emit the same `[sports_intent]` shape so frontend logs match backend.
 *
 *  Entity catalogs are intentionally a compact alias index keyed by lowercase
 *  surface form. Longest aliases first so multi-word names ("manchester united")
 *  beat sub-substrings ("manchester"). Adding a new player/team only requires
 *  pushing a row into the catalog — NO routing changes anywhere else.
 * ========================================================================= */

const VERA_SPORTS_ENTITIES = (function () {
  const teams = [];
  const players = [];
  const tournaments = [];
  function pushTeams(rows) {
    for (const r of rows) {
      const [canonical, sport, aliases] = r;
      for (const a of aliases) {
        teams.push({ alias: a.toLowerCase(), canonical, entity_type: "team", sport, tournament_or_league: "" });
      }
    }
  }
  function pushPlayers(rows) {
    for (const r of rows) {
      const [canonical, sport, aliases] = r;
      for (const a of aliases) {
        players.push({ alias: a.toLowerCase(), canonical, entity_type: "player", sport, tournament_or_league: "" });
      }
    }
  }
  function pushTournaments(rows) {
    for (const r of rows) {
      const [canonical, sport, tournament, aliases] = r;
      for (const a of aliases) {
        tournaments.push({ alias: a.toLowerCase(), canonical, entity_type: "tournament", sport, tournament_or_league: tournament });
      }
    }
  }
  pushTeams([
    ["Lakers", "nba", ["los angeles lakers", "la lakers", "lakers"]],
    ["Clippers", "nba", ["los angeles clippers", "la clippers", "clippers"]],
    ["Warriors", "nba", ["golden state warriors", "warriors", "dubs"]],
    ["Celtics", "nba", ["boston celtics", "celtics"]],
    ["Knicks", "nba", ["new york knicks", "ny knicks", "knicks"]],
    ["Heat", "nba", ["miami heat", "heat"]],
    ["Bulls", "nba", ["chicago bulls", "bulls"]],
    ["76ers", "nba", ["philadelphia 76ers", "sixers", "76ers"]],
    ["Raptors", "nba", ["toronto raptors", "raptors"]],
    ["Bucks", "nba", ["milwaukee bucks", "bucks"]],
    ["Mavericks", "nba", ["dallas mavericks", "mavericks", "mavs"]],
    ["Nuggets", "nba", ["denver nuggets", "nuggets"]],
    ["Suns", "nba", ["phoenix suns", "suns"]],
    ["Trail Blazers", "nba", ["portland trail blazers", "trail blazers", "blazers"]],
    ["Timberwolves", "nba", ["minnesota timberwolves", "timberwolves", "wolves"]],
    ["Cavaliers", "nba", ["cleveland cavaliers", "cavaliers", "cavs"]],
    ["Thunder", "nba", ["oklahoma city thunder", "okc thunder", "thunder"]],
    ["49ers", "nfl", ["san francisco 49ers", "49ers", "niners"]],
    ["Patriots", "nfl", ["new england patriots", "patriots", "pats"]],
    ["Eagles", "nfl", ["philadelphia eagles", "eagles"]],
    ["Cowboys", "nfl", ["dallas cowboys", "cowboys"]],
    ["Chiefs", "nfl", ["kansas city chiefs", "kc chiefs", "chiefs"]],
    ["Packers", "nfl", ["green bay packers", "packers"]],
    ["Bills", "nfl", ["buffalo bills", "bills"]],
    ["Rams", "nfl", ["los angeles rams", "la rams", "rams"]],
    ["Yankees", "mlb", ["new york yankees", "ny yankees", "yankees"]],
    ["Red Sox", "mlb", ["boston red sox", "red sox"]],
    ["Dodgers", "mlb", ["los angeles dodgers", "la dodgers", "dodgers"]],
    ["Cubs", "mlb", ["chicago cubs", "cubs"]],
    ["Mets", "mlb", ["new york mets", "ny mets", "mets"]],
    ["Astros", "mlb", ["houston astros", "astros"]],
    ["Braves", "mlb", ["atlanta braves", "braves"]],
    ["Real Madrid", "soccer_laliga", ["real madrid"]],
    ["Barcelona", "soccer_laliga", ["fc barcelona", "barcelona", "barca", "barça"]],
    ["Liverpool", "soccer_epl", ["liverpool fc", "liverpool"]],
    ["Arsenal", "soccer_epl", ["arsenal fc", "arsenal"]],
    ["Chelsea", "soccer_epl", ["chelsea fc", "chelsea"]],
    ["Manchester United", "soccer_epl", ["manchester united", "man united", "man utd"]],
    ["Manchester City", "soccer_epl", ["manchester city", "man city"]],
    ["Tottenham", "soccer_epl", ["tottenham hotspur", "tottenham"]],
    ["Bayern Munich", "soccer_bundesliga", ["bayern munich", "bayern münchen", "bayern"]],
    ["PSG", "soccer_ligue1", ["paris saint-germain", "paris saint germain", "psg"]],
    ["Juventus", "soccer_seriea", ["juventus", "juve"]],
    ["Inter Milan", "soccer_seriea", ["inter milan", "internazionale"]],
    ["AC Milan", "soccer_seriea", ["ac milan", "milan"]],
  ]);
  pushPlayers([
    ["Novak Djokovic", "tennis_atp", ["novak djokovic", "djokovic", "novak"]],
    ["Carlos Alcaraz", "tennis_atp", ["carlos alcaraz", "alcaraz"]],
    ["Jannik Sinner", "tennis_atp", ["jannik sinner", "sinner"]],
    ["Daniil Medvedev", "tennis_atp", ["daniil medvedev", "medvedev"]],
    ["Alexander Zverev", "tennis_atp", ["alexander zverev", "zverev"]],
    ["Stefanos Tsitsipas", "tennis_atp", ["stefanos tsitsipas", "tsitsipas"]],
    ["Holger Rune", "tennis_atp", ["holger rune", "rune"]],
    ["Casper Ruud", "tennis_atp", ["casper ruud", "ruud"]],
    ["Iga Swiatek", "tennis_wta", ["iga swiatek", "iga świątek", "swiatek"]],
    ["Aryna Sabalenka", "tennis_wta", ["aryna sabalenka", "sabalenka"]],
    ["Coco Gauff", "tennis_wta", ["coco gauff", "gauff"]],
    ["Elena Rybakina", "tennis_wta", ["elena rybakina", "rybakina"]],
    ["Naomi Osaka", "tennis_wta", ["naomi osaka", "osaka"]],
    ["Lionel Messi", "soccer", ["lionel messi", "messi"]],
    ["Cristiano Ronaldo", "soccer", ["cristiano ronaldo", "ronaldo"]],
    ["Kylian Mbappe", "soccer", ["kylian mbappe", "kylian mbappé", "mbappe", "mbappé"]],
    ["Erling Haaland", "soccer", ["erling haaland", "haaland"]],
    ["Mohamed Salah", "soccer", ["mohamed salah", "salah"]],
    ["Harry Kane", "soccer", ["harry kane", "kane"]],
    ["Jude Bellingham", "soccer", ["jude bellingham", "bellingham"]],
    ["Bukayo Saka", "soccer", ["bukayo saka", "saka"]],
  ]);
  pushTournaments([
    ["Roland Garros", "tennis", "Roland Garros", ["roland garros", "french open"]],
    ["Wimbledon", "tennis", "Wimbledon", ["wimbledon"]],
    ["US Open (Tennis)", "tennis", "US Open", ["us open tennis", "us open"]],
    ["Australian Open", "tennis", "Australian Open", ["australian open", "aussie open"]],
    ["ATP Finals", "tennis_atp", "ATP Finals", ["atp finals"]],
    ["WTA Finals", "tennis_wta", "WTA Finals", ["wta finals"]],
    ["UEFA Champions League", "soccer", "UEFA Champions League", ["champions league", "uefa champions league", "ucl"]],
    ["UEFA Europa League", "soccer", "UEFA Europa League", ["europa league"]],
    ["FIFA World Cup", "soccer", "FIFA World Cup", ["fifa world cup", "world cup"]],
    ["Premier League", "soccer_epl", "Premier League", ["english premier league", "premier league", "epl"]],
    ["La Liga", "soccer_laliga", "La Liga", ["la liga", "laliga"]],
    ["Serie A", "soccer_seriea", "Serie A", ["serie a"]],
    ["Bundesliga", "soccer_bundesliga", "Bundesliga", ["bundesliga"]],
    ["Ligue 1", "soccer_ligue1", "Ligue 1", ["ligue 1", "ligue un"]],
    ["NBA Finals", "nba", "NBA Finals", ["nba finals"]],
    ["NBA Playoffs", "nba", "NBA Playoffs", ["nba playoffs"]],
    ["Super Bowl", "nfl", "Super Bowl", ["super bowl", "superbowl"]],
    ["World Series", "mlb", "World Series", ["world series"]],
    ["Stanley Cup", "nhl", "Stanley Cup", ["stanley cup"]],
    ["Masters Tournament", "golf", "Masters Tournament", ["the masters", "masters tournament"]],
    ["Formula 1", "f1", "Formula 1", ["formula 1", "formula one", "f1"]],
  ]);
  const all = teams.concat(players).concat(tournaments);
  all.sort((a, b) => b.alias.length - a.alias.length);
  return all;
})();

const VERA_SPORTS_SAFETY_REQUIRED = new Set(["sinner", "kane", "saka", "haaland"]);

const VERA_SPORTS_LATEST_RESULT_RE = /\b(?:did\s+(?:the\s+)?\S[^?]{0,60}?\s+(?:win|won|lose|lost|beat|tie|tied|draw|drew)|how\s+did\s+\S[^?]{0,40}?\s+(?:do|play|score)|(?:final|game|match)\s+score|did\s+\S[^?]{0,40}?\s+game|(?:results?|final\s+score|box\s+score)\s+(?:of|for)|(?:won|lost|beat|score(?:d)?)\s+(?:the\s+)?(?:game|match|series|fixture)|recent\s+game)/i;
const VERA_SPORTS_TOURNAMENT_STATUS_RE = /\b(?:(?:still|already|finally)\s+in|(?:still|already)\s+(?:in|playing|alive)\s+(?:the\s+)?(?:draw|tournament|playoffs|finals?|bracket)|in\s+the\s+(?:draw|tournament|playoffs|finals?|bracket)|(?:out\s+of|knocked\s+out|eliminated\s+from|exited\s+from|crashed\s+out\s+of)\s+(?:the\s+)?|(?:advanced?|advance|through)\s+to\s+the\s+(?:next\s+round|round\s+of|quarter|semis?|semifinals?|final|finals)|(?:lose|lost|beaten|defeated|knocked\s+out)\s+(?:in|at)\s+(?:the\s+)?(?:first\s+round|second\s+round|third\s+round|fourth\s+round|round\s+of\s+(?:16|32|64|128)|quarter|quarters|quarterfinals?|semis?|semifinals?|final|finals)|reach(?:ed)?\s+(?:the\s+)?(?:quarter|semi|final)|(?:tournament|draw|bracket)\s+status)/i;
const VERA_SPORTS_SCHEDULE_RE = /\b(?:(?:who|when|where)\s+(?:does|do)\s+\S[^?]{0,40}?\s+play(?:\s+next)?|play(?:s|ing)?\s+next|next\s+(?:match|game|fixture|opponent|round)|when\s+is\s+(?:the\s+)?(?:next\s+)?(?:match|game|fixture)|(?:upcoming|schedule)\s+(?:match|game|fixture|games?|matches)|(?:fixture|schedule)\s+for\s+)/i;
const VERA_SPORTS_STANDINGS_RE = /\b(?:standings?|league\s+table|league\s+position|league\s+standings?|table\s+position|where\s+(?:does|do)\s+\S[^?]{0,40}?\s+stand|how\s+(?:are|is)\s+\S[^?]{0,40}?\s+doing\s+in\s+the\s+(?:standings?|league|table))/i;
const VERA_SPORTS_NEWS_RE = /\b(?:(?:any\s+)?news\s+(?:on|about)\s+\S|update[s]?\s+(?:on|about)\s+\S|what(?:'?s|s|\s+is)\s+(?:the\s+)?(?:latest|news)\s+(?:on|about)\s+\S)/i;
const VERA_SPORTS_PLAYER_STATUS_RE = /\b(?:(?:is|are)\s+\S[^?]{0,40}?\s+(?:playing|injured|fit|back|out|active|starting|benched)|injury\s+status|injury\s+update|status\s+of\s+\S|out\s+for\s+(?:the\s+)?season)/i;
const VERA_SPORTS_PRONOUN_RE = /^\s*(?:and\s+|but\s+|so\s+|what\s+about\s+|how\s+about\s+)?(?:he|she|they|them|him|her|his|hers|their|that|this|those|these|it)\b/i;
const VERA_SPORTS_HOW_ABOUT_RE = /^\s*(?:and|but|so)?\s*(?:how|what)\s+about\s+(?<rest>[^?.,;:!]+)\??\s*$/i;
const VERA_SPORTS_BARE_PRONOUN_FOLLOWUP_RE = /\b(?:did|does|do|is|was|were|has|have)\s+(?:they|he|she|it|them|him|her)\b/i;

function _veraSportsAliasPassesSafetyCheck(alias, low) {
  if (!VERA_SPORTS_SAFETY_REQUIRED.has(alias)) return true;
  return (
    VERA_SPORTS_LATEST_RESULT_RE.test(low) ||
    VERA_SPORTS_TOURNAMENT_STATUS_RE.test(low) ||
    VERA_SPORTS_SCHEDULE_RE.test(low) ||
    VERA_SPORTS_STANDINGS_RE.test(low) ||
    VERA_SPORTS_PLAYER_STATUS_RE.test(low) ||
    VERA_SPORTS_ENTITIES.some(
      (r) =>
        r.entity_type === "tournament" &&
        r.alias !== alias &&
        new RegExp("\\b" + r.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b").test(low)
    )
  );
}

function _veraResolveSportsEntity(text, opts) {
  if (!text) return null;
  opts = opts || {};
  const allowUnsafe = Boolean(opts.allowUnsafeShortAliases);
  const low = String(text).toLowerCase();
  /* Two passes: player/team first (longest within group), then tournaments.
   * Matches actions.sports._resolve_entity_in_text so "Is Djokovic still in
   * Roland Garros?" resolves to Djokovic, not Roland Garros. */
  const playerTeamRows = VERA_SPORTS_ENTITIES.filter(
    (r) => r.entity_type === "team" || r.entity_type === "player"
  );
  const tournamentRows = VERA_SPORTS_ENTITIES.filter((r) => r.entity_type === "tournament");
  for (const row of playerTeamRows) {
    const re = new RegExp("\\b" + row.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b");
    if (!re.test(low)) continue;
    if (!allowUnsafe && !_veraSportsAliasPassesSafetyCheck(row.alias, low)) continue;
    return row;
  }
  for (const row of tournamentRows) {
    const re = new RegExp("\\b" + row.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b");
    if (!re.test(low)) continue;
    return row;
  }
  return null;
}

function _veraSportsDetectQueryType(text, tournamentInText) {
  if (!text) return "";
  const low = String(text).toLowerCase();
  if (VERA_SPORTS_NEWS_RE.test(low)) return "news";
  if (VERA_SPORTS_TOURNAMENT_STATUS_RE.test(low)) return "tournament_status";
  if (VERA_SPORTS_SCHEDULE_RE.test(low)) return "schedule";
  if (VERA_SPORTS_STANDINGS_RE.test(low)) return "standings";
  if (VERA_SPORTS_LATEST_RESULT_RE.test(low)) {
    if (tournamentInText && /\bwon\s+(?:the\s+)?(?:title|trophy|championship|cup|final|finals)\b/.test(low)) {
      return "tournament_status";
    }
    return "latest_result";
  }
  if (VERA_SPORTS_PLAYER_STATUS_RE.test(low)) return "player_status";
  return "";
}

function veraClassifySportsIntent(text, opts) {
  opts = opts || {};
  const ctx = opts.recentSportsContext && typeof opts.recentSportsContext === "object" ? opts.recentSportsContext : null;
  const out = {
    is_sports: false,
    sport: "",
    entity: "",
    entity_type: "",
    tournament_or_league: "",
    query_type: "",
    confidence: 0.0,
    reason: "no_signal",
    followup_used: false,
    needs_clarification: false,
    clarification_reason: "",
    context_before: ctx ? Object.assign({}, ctx) : null,
  };
  const raw = String(text || "").trim();
  if (!raw) { out.reason = "empty_text"; return out; }
  const low = raw.toLowerCase();
  let hit = _veraResolveSportsEntity(raw);

  const howAbout = VERA_SPORTS_HOW_ABOUT_RE.exec(raw);
  const barePronounFollowup = VERA_SPORTS_BARE_PRONOUN_FOLLOWUP_RE.test(low);
  const pronounLead = VERA_SPORTS_PRONOUN_RE.test(raw);
  const isFollowupShape = Boolean(howAbout) || pronounLead || barePronounFollowup;

  if (howAbout && !hit) {
    const candidate = String((howAbout.groups && howAbout.groups.rest) || "").trim().replace(/[?.,!]+$/, "");
    if (candidate) {
      const allowUnsafe = Boolean(ctx) || _veraSportsAliasPassesSafetyCheck("sinner", low);
      hit = _veraResolveSportsEntity(candidate, { allowUnsafeShortAliases: allowUnsafe });
      if (hit) out.followup_used = true;
    }
  }

  if (!hit && ctx && (pronounLead || barePronounFollowup)) {
    const ctxEntity = String(ctx.entity || "").trim();
    if (ctxEntity) {
      hit = {
        canonical: ctxEntity,
        entity_type: ctx.entity_type || "team",
        sport: ctx.sport || "",
        tournament_or_league: ctx.tournament_or_league || "",
        alias: ctxEntity.toLowerCase(),
      };
      out.followup_used = true;
    }
  }

  if (!hit && ctx && howAbout) {
    const candidate = String((howAbout.groups && howAbout.groups.rest) || "").trim().replace(/[?.,!]+$/, "");
    if (candidate) {
      hit = {
        canonical: candidate.replace(/\b\w/g, (c) => c.toUpperCase()),
        entity_type: "player",
        sport: ctx.sport || "",
        tournament_or_league: ctx.tournament_or_league || "",
        alias: candidate.toLowerCase(),
      };
      out.followup_used = true;
      out.reason = "how_about_followup_inherited_ctx";
    }
  }

  if (!hit && howAbout) {
    const candidate = String((howAbout.groups && howAbout.groups.rest) || "").trim().replace(/[?.,!]+$/, "").toLowerCase();
    if (!ctx && new Set(["him", "her", "them", "they", "it"]).has(candidate)) {
      out.is_sports = true;
      out.needs_clarification = true;
      out.clarification_reason = "pronoun_followup_without_context";
      out.confidence = 0.6;
      out.reason = "how_about_pronoun_no_context";
      return out;
    }
  }

  if (!hit && (pronounLead || barePronounFollowup) && !ctx) {
    /* Only flag as sports clarification when the message is sports-shaped.
       Without this guard, "what time is it?" / "is it raining?" would match
       the bare-pronoun followup regex and get a sports clarification bubble. */
    const looksSportsShaped =
      VERA_SPORTS_LATEST_RESULT_RE.test(low) ||
      VERA_SPORTS_TOURNAMENT_STATUS_RE.test(low) ||
      VERA_SPORTS_SCHEDULE_RE.test(low) ||
      VERA_SPORTS_STANDINGS_RE.test(low) ||
      VERA_SPORTS_PLAYER_STATUS_RE.test(low) ||
      /\b(?:win|won|lose|lost|beat|beating|score|scored|game|games|match|matches|play(?:ing|ed)?|tournament|draw|round|fixture|playoff|playoffs|final|finals|semifinal|quarterfinal)\b/i.test(low);
    if (looksSportsShaped) {
      out.is_sports = true;
      out.needs_clarification = true;
      out.clarification_reason = "pronoun_followup_without_context";
      out.confidence = 0.6;
      out.reason = "ambiguous_pronoun_followup_no_context";
      return out;
    }
    return out;
  }

  if (!hit) return out;

  if (isFollowupShape && !out.followup_used) {
    out.followup_used = true;
  }

  if ((hit.entity_type === "player" || hit.entity_type === "team") && !hit.tournament_or_league) {
    for (const row of VERA_SPORTS_ENTITIES) {
      if (row.entity_type !== "tournament") continue;
      const re = new RegExp("\\b" + row.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b");
      if (re.test(low)) { hit.tournament_or_league = row.tournament_or_league || ""; break; }
    }
  }

  let tournamentInText = Boolean(hit.tournament_or_league);
  if (!tournamentInText) {
    for (const row of VERA_SPORTS_ENTITIES) {
      if (row.entity_type !== "tournament") continue;
      const re = new RegExp("\\b" + row.alias.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b");
      if (re.test(low)) { tournamentInText = true; break; }
    }
  }

  let queryType = _veraSportsDetectQueryType(raw, tournamentInText);
  if (!queryType && out.followup_used && ctx) {
    queryType = String(ctx.query_type || "");
  }
  if (!queryType) {
    if (tournamentInText || (hit.entity_type === "player" && ctx && (ctx.tournament_or_league || ""))) {
      queryType = "tournament_status";
    } else {
      queryType = "latest_result";
    }
  }

  let confidence = 0.7;
  let reason = "entity_only";
  if (out.followup_used) {
    confidence = 0.75;
    reason = out.reason || "followup_with_ctx";
  } else if (tournamentInText && (hit.entity_type === "player" || hit.entity_type === "team")) {
    confidence = 0.92;
    reason = "entity_plus_tournament";
  } else if (queryType === "tournament_status" || queryType === "schedule" || queryType === "standings") {
    confidence = 0.88;
    reason = "entity_plus_query_phrasing";
  } else if (queryType === "latest_result") {
    confidence = 0.86;
    reason = "entity_plus_result_shape";
  }

  if (hit.entity_type === "tournament" && (queryType === "" || queryType === "latest_result")) {
    queryType = "tournament_status";
  }

  out.is_sports = true;
  out.sport = hit.sport || "";
  out.entity = hit.canonical || "";
  out.entity_type = hit.entity_type || "";
  out.tournament_or_league = hit.tournament_or_league ||
    (ctx && out.followup_used ? (ctx.tournament_or_league || "") : "") || "";
  out.query_type = queryType;
  out.confidence = confidence;
  out.reason = reason;
  return out;
}

try {
  window.veraClassifySportsIntent = veraClassifySportsIntent;
} catch (_) {}
const _INFO_TOOL_SHOPPING_RE = /\b(?:best|top|cheap(?:est)?|good|recommended)\s+[a-z0-9\- ]{2,40}\s+(?:under|below|less\s+than|for\s+under)\s*\$?\s*\d|\bbest\s+[a-z0-9\- ]{2,40}\s+(?:for|to|in)\s+[a-z0-9\- ]{2,40}|\b(?:reviews?\s+of|reviews?\s+for|review\s+of)\b|\bcompare\s+[a-z0-9\- ]{1,30}\s+(?:vs|versus|and|to)\s+[a-z0-9\- ]{1,30}|\b[a-z0-9\- ]{1,20}\s+(?:vs|versus)\s+[a-z0-9\- ]{1,20}\b/i;
const _INFO_TOOL_NEAR_ME_RE = /\b(?:near\s+me|nearby|around\s+here|around\s+me|close\s+to\s+me|what(?:'s|s)\s+open\s+(?:near|nearby|around))\b/i;
const _INFO_TOOL_VENUE_RE = /\b(?:coffee\s+shop|coffee\s+shops|cafe|cafes|caf[eé]s?|restaurant|restaurants|gym|gyms|bar|bars|pub|pubs|gas\s+station|gas\s+stations|grocery|supermarket|pharmacy|pharmacies|atm|atms|hotel|hotels|park|parks|hospital|hospitals|library|libraries|bookstore|bookstores)\b/i;
const _INFO_TOOL_SHOW_RE = /\b(?:how\s+many\s+(?:episodes|seasons|chapters|volumes)|what\s+season|when\s+does\s+(?:season|episode)|release\s+date|release\s+dates?\s+of)\b/i;
const _INFO_TOOL_EXPLICIT_NEWS_RE = /\b(?:tell\s+me\s+(?:the\s+)?news|what(?:'s|s)?\s+(?:the\s+)?(?:latest\s+)?news|breaking\s+news|today(?:'s|s)?\s+headlines|news\s+about|any\s+(?:news|updates?)\s+(?:on|about)|latest\s+(?:news\s+)?(?:on|about)|any\s+(?:news|updates?)\b|show\s+me\s+(?:the\s+)?news|headlines)\b/i;
const _INFO_TOOL_PRONOUN_RE = /\b(?:he|she|they|him|her|them|his|hers|their|that|this|those|these|after\s+that|then|there|right\s+after)\b/i;
const _INFO_TOOL_FRESH_FOLLOWUP_RE = /\b(?:any\s+updates?|what(?:'s|s)?\s+the\s+latest|latest\s+(?:on|with|about)|who\s+else|what(?:'s|s)?\s+(?:next|after\s+that)|when\s+exactly|can\s+you\s+verify|verify\s+that|what\s+does\s+(?:reuters|bloomberg|ap|the\s+(?:new\s+york\s+)?times|cnn|bbc|nbc|cnbc|wsj|the\s+wall\s+street\s+journal|wapo)\s+say|find\s+more\s+sources?|more\s+sources?)\b/i;

function classifyInfoTool(text, opts = {}) {
  const raw = String(text || "").trim();
  const locationAvailable = Boolean(opts && opts.locationAvailable);
  const recentNewsCtx = opts && opts.recentNewsContext;
  const hasCtx = Boolean(recentNewsCtx && typeof recentNewsCtx === "object" && Object.keys(recentNewsCtx).length);
  const out = {
    route: "uncertain",
    tool: "none",
    query: raw,
    entities: [],
    metric: null,
    timeframe: null,
    required_context: null,
    confidence: 0.0,
    reason: "",
  };
  if (!raw) {
    out.reason = "empty_text";
    return out;
  }
  const low = raw.toLowerCase();

  /* Personal/emotional — never search. */
  if (_NEWS_ROUTER_PERSONAL_NEWS_RE.test(low) || _NEWS_ROUTER_PERSONAL_GRIEF_RE.test(low)) {
    out.route = "llm_only";
    out.confidence = 0.95;
    out.reason = "personal_or_emotional_news_statement";
    return out;
  }
  /* Time / date — utility beats news. */
  if (_INFO_TOOL_TIME_RE.test(raw)) {
    out.route = "time_tool"; out.tool = "time"; out.confidence = 0.95;
    out.reason = "explicit_time_question"; return out;
  }
  if (_INFO_TOOL_DATE_RE.test(raw)) {
    out.route = "time_tool"; out.tool = "time"; out.confidence = 0.9;
    out.reason = "explicit_date_question"; return out;
  }
  /* Weather. */
  if (_INFO_TOOL_WEATHER_RE.test(raw)) {
    out.route = "weather_tool"; out.tool = "weather"; out.confidence = 0.95;
    out.reason = "explicit_weather_question";
    /* If no location is named or available, mark clarification context. */
    const hasInCity = /\b(?:in|around|near)\s+(?:the\s+)?[A-Z][a-zA-Z]+/.test(raw);
    if (!hasInCity && !locationAvailable) {
      out.required_context = ["location"];
    }
    return out;
  }
  /* Historical/educational. */
  if (
    !_NEWS_ROUTER_HIST_EDU_NEWS_OVERRIDE_RE.test(low)
    && _NEWS_ROUTER_HIST_EDU_TOPIC_RE.test(low)
  ) {
    out.route = "llm_only"; out.confidence = 0.9;
    out.reason = "historical_or_educational_explanation"; return out;
  }
  /* Finance — quote vs analytics. */
  if (_INFO_TOOL_FINANCE_QUOTE_RE.test(low) && !_INFO_TOOL_FINANCE_ANALYTICS_RE.test(low)) {
    out.route = "finance_quote_tool"; out.tool = "finance_quote"; out.confidence = 0.9;
    out.reason = "explicit_finance_quote_request"; return out;
  }
  if (_INFO_TOOL_FINANCE_ANALYTICS_RE.test(low)) {
    out.route = "finance_search_tool"; out.tool = "web_search"; out.confidence = 0.85;
    out.reason = "finance_historical_or_analytics_question"; return out;
  }
  /* Explicit news. */
  if (_INFO_TOOL_EXPLICIT_NEWS_RE.test(low)) {
    out.route = "news_search_tool"; out.tool = "news"; out.confidence = 0.9;
    out.reason = "explicit_news_request"; return out;
  }
  /* Sports — sport-aware classifier first; legacy team regex stays as
     a last-resort safety net. The classifier returns the structured intent
     when it fires (so the panel can render Sports/Tournament Results); the
     fallback below keeps the legacy generic web-search reason. */
  try {
    const sportsCtx = (opts && opts.recentSportsContext) || null;
    const sportsIntent = veraClassifySportsIntent(raw, { recentSportsContext: sportsCtx });
    if (sportsIntent && sportsIntent.is_sports) {
      if (sportsIntent.needs_clarification) {
        out.route = "sports_clarification_needed";
        out.tool = "none";
        out.confidence = Number(sportsIntent.confidence || 0.6);
        out.reason = sportsIntent.reason || "sports_pronoun_no_context";
        out.sports_intent = sportsIntent;
        return out;
      }
      out.route = "sports_tool";
      out.tool = "sports";
      out.confidence = Number(sportsIntent.confidence || 0.85);
      out.reason = sportsIntent.reason || "sports_intent_detected";
      out.sports_intent = sportsIntent;
      return out;
    }
  } catch (e) {
    try { console.warn("[sports_router] classifier_exception", e); } catch (_) {}
  }
  if (_INFO_TOOL_SPORTS_TEAM_RE.test(low) && _INFO_TOOL_SPORTS_VERB_RE.test(low)) {
    out.route = "general_web_search_tool"; out.tool = "web_search"; out.confidence = 0.85;
    out.reason = "sports_team_question_web_search_fallback_legacy"; return out;
  }
  /* Shopping / recommendation. */
  if (_INFO_TOOL_SHOPPING_RE.test(low)) {
    out.route = "general_web_search_tool"; out.tool = "web_search"; out.confidence = 0.85;
    out.reason = "shopping_or_recommendation_web_search"; return out;
  }
  /* Show / episode / factoid. */
  if (_INFO_TOOL_SHOW_RE.test(low)) {
    out.route = "general_web_search_tool"; out.tool = "web_search"; out.confidence = 0.8;
    out.reason = "show_or_episode_question_web_search"; return out;
  }
  /* Local — venue + near-me without location → clarification. */
  if (_INFO_TOOL_VENUE_RE.test(low)) {
    const nearMe = _INFO_TOOL_NEAR_ME_RE.test(low);
    const hasInCity = /\b(?:in|around|near)\s+(?:the\s+)?[A-Z][a-zA-Z]+/.test(raw);
    if (nearMe && !hasInCity && !locationAvailable) {
      out.route = "clarification_needed"; out.confidence = 0.9;
      out.reason = "local_venue_query_missing_location";
      out.required_context = ["location"];
      return out;
    }
    out.route = "general_web_search_tool"; out.tool = "web_search"; out.confidence = 0.85;
    out.reason = "local_venue_query_web_search"; return out;
  }
  /* Follow-ups when ctx exists. */
  const pronounLead = _INFO_TOOL_PRONOUN_RE.test(low);
  const freshMarker = _INFO_TOOL_FRESH_FOLLOWUP_RE.test(low);
  if (hasCtx && pronounLead) {
    if (freshMarker) {
      out.route = "followup_search"; out.tool = "news"; out.confidence = 0.75;
      out.reason = "fresh_source_followup_with_pronoun"; return out;
    }
    out.route = "followup_llm"; out.confidence = 0.8;
    out.reason = "interpretive_pronoun_followup"; return out;
  }
  /* Default: let the legacy pipeline decide. */
  out.reason = "no_confident_pick_falls_through";
  return out;
}

function logInfoToolRouteFrontend(text, classification) {
  try {
    const c = classification || {};
    console.info("[info_tool_route] " + JSON.stringify({
      side: "frontend",
      raw_user_text: String(text || "").slice(0, 200),
      selected_route: String(c.route || ""),
      selected_tool: String(c.tool || ""),
      query: String(c.query || "").slice(0, 200),
      entities: Array.isArray(c.entities) ? c.entities.slice(0, 8) : [],
      metric: c.metric || null,
      timeframe: c.timeframe || null,
      required_context: Array.isArray(c.required_context) ? c.required_context : [],
      clarification_needed: c.route === "clarification_needed",
      confidence: Number(c.confidence || 0),
      reason: String(c.reason || ""),
    }));
  } catch (_) {}
}

try {
  window.classifyInfoTool = classifyInfoTool;
  window.logInfoToolRouteFrontend = logInfoToolRouteFrontend;
} catch (_) {}

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
