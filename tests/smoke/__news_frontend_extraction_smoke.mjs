/* ============================================================================
 * __news_frontend_extraction_smoke.mjs
 *
 * Verifies the Stage 10 extraction of frontend news helpers from app.js
 * into news/newsRouter.js + news/newsPanel.js.
 *
 * This smoke focuses on the EXTRACTION itself:
 *
 *   1. news/newsRouter.js + news/newsPanel.js both load in a
 *      classic-script-like sandbox after a minimal app.js stub that
 *      provides the bare-identifier dependencies (`addBubble`,
 *      `persistVeraChatState`, `VERA_SAFETY_LIMITS`, `uiEl`,
 *      `escapeHtml`, `runFlowModeSidePaneContentCrossfade`,
 *      `isVeraInterruptDebugEnabled`, `logVeraInterruptDebug`).
 *   2. All moved functions exist as function declarations + all moved
 *      const/let bindings exist with the correct initial values.
 *   3. Window aliases (window.getNewsRouterDebugState,
 *      window.getNewsPanelDebugState) are attached and identity-match
 *      the bare identifiers.
 *   4. Pure helpers behave exactly as before:
 *        - looksLikeNewsSearchRequest (positive + negative cases,
 *          personal/emotional suppression, "I got bad news",
 *          "saw the news my friend passed away", weak-recency gate,
 *          named-entity "did Trump go to China", music/checklist/timer
 *          negative filters, greeting suppression).
 *        - getVideoEmbedUrl (youtu.be, youtube.com?v=…, m.youtube.com,
 *          unknown host, garbage).
 *        - renderNewsResultListMarkup (empty + non-empty list, escape
 *          handling, URL "Open source" gating).
 *        - renderImageResultsMarkup (empty + non-empty).
 *        - renderVideoResultsMarkup (embed branch + thumbnail branch +
 *          neither branch).
 *   5. armPendingNewsStatusBubble / cancelPendingNewsStatusBubble /
 *      failPendingNewsStatusBubble lifecycle:
 *        - cancel before any arm is a safe no-op,
 *        - arm sets the dataset attributes + bumps token,
 *        - arm is IDEMPOTENT for the same utteranceKey,
 *        - cancel removes the bubble + bumps token + clears timer,
 *        - fail rewrites bubble text + classes + datasetStatus.
 *   6. setActiveSidePaneTab toggles only the targeted tab + panel.
 *   7. _veraNewsPanelRenderInFlight is a `let` in newsPanel.js +
 *      mutable (false → true → false) through the global scope.
 *   8. app.js no longer declares any of the moved bindings, and does
 *      NOT define a duplicate `setActiveSidePaneTab` or
 *      `renderMediaTabsPanel` etc.
 *   9. app.js still declares the intentionally-LEFT helpers
 *      (hideSidePanel, onSidePaneClick, renderFinanceChartPanel,
 *      renderProductivityPanel, toggleProductivityPanel,
 *      runFlowModeSidePaneContentCrossfade).
 *  10. index.html load order: news/newsRouter.js and news/newsPanel.js
 *      both load AFTER workmode/checklist.js and BEFORE app.js.
 *  11. Both news modules parse as classic scripts (no ESM imports /
 *      exports).
 *
 * Run:  node tests/smoke/__news_frontend_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const newsRouterPath = path.join(repoRoot, "news", "newsRouter.js");
const newsPanelPath = path.join(repoRoot, "news", "newsPanel.js");
const appJsPath = path.join(repoRoot, "app.js");
const indexHtmlPath = path.join(repoRoot, "index.html");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label}\n         expected ${e}\n         actual   ${a}`);
}
function section(title) { console.log(`\n── ${title} ──`); }

/* ── Minimal DOM stub: enough for the pending-bubble lifecycle +
 *    setActiveSidePaneTab. addBubble returns a fake element that the
 *    router can stash; cancel/fail traverse `.parentNode` / `.closest`. */
function makeFakeBubble() {
  const dataset = {};
  const classes = new Set();
  const el = {
    isConnected: true,
    textContent: "Searching news…",
    dataset,
    classList: {
      add(...cs) { for (const c of cs) classes.add(c); },
      remove(...cs) { for (const c of cs) classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, force) {
        if (force === true) classes.add(c);
        else if (force === false) classes.delete(c);
        else if (classes.has(c)) classes.delete(c);
        else classes.add(c);
      },
      get _set() { return new Set(classes); },
    },
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    closest(_sel) { return null; }, /* no row wrapper in stub */
    _detach() { this.isConnected = false; this.parentNode = null; },
    parentNode: { removeChild(c) { c._detach(); } },
  };
  return el;
}

function makeFakeSidePane() {
  const tabs = [];
  const panels = [];
  return {
    hidden: false,
    dataset: { sidePaneKind: null },
    innerHTML: "",
    _classes: new Set(["visible"]),
    classList: {
      add: function (c) { this._classes.add(c); }.bind(null),
      contains(c) { return this._classes.has(c); },
      remove(c) { this._classes.delete(c); },
    },
    /* tabs + panels keyed by `data-tab` / `data-tabPanel` for the test */
    _addTab(name) { const t = { dataset: { tab: name }, classList: makeClassList(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }; tabs.push(t); return t; },
    _addPanel(name) { const p = { dataset: { tabPanel: name }, classList: makeClassList() }; panels.push(p); return p; },
    querySelectorAll(sel) {
      if (sel === ".side-pane-tab") return tabs;
      if (sel === ".side-pane-tab-panel") return panels;
      return [];
    },
  };
}
function makeClassList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      if (force === true) set.add(c);
      else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
    },
    _set: set,
  };
}

function buildLoadedSandbox() {
  const cConsole = {
    log: () => {}, info: () => {}, debug: () => {},
    warn: () => {}, error: () => {},
  };
  const win = { isSecureContext: true, setTimeout, clearTimeout };
  const doc = {
    body: { _classes: new Set(), classList: {
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    } },
    querySelectorAll: (sel) => {
      /* renderMediaTabsPanel does
         `document.querySelectorAll(".productivity-mode-btn")` inside
         its mount() — returning an empty list is fine for the smoke. */
      void sel;
      return [];
    },
  };
  const sandbox = vm.createContext({
    console: cConsole,
    window: win,
    document: doc,
    performance: { now: () => 12345.6 },
    setTimeout,
    clearTimeout,
    URL,
    AbortController,
  });
  sandbox.globalThis = sandbox;
  for (const k of Object.keys(win)) sandbox[k] = win[k];

  /* App-stub: the bare names the news modules reach for at call time
     through the shared global lexical env. Mirrors app.js helpers. */
  vm.runInContext(
    `
    var __veraBubbles = [];
    var __veraPersistCount = 0;
    var __veraSidePane = null;
    function setVeraSidePane(p) { __veraSidePane = p; }
    function getVeraSidePane() { return __veraSidePane; }
    function addBubble(text, who, meta) {
      const b = globalThis.__makeFakeBubble();
      b.textContent = text;
      b._who = who;
      b._meta = meta;
      __veraBubbles.push(b);
      return b;
    }
    function persistVeraChatState() { __veraPersistCount += 1; }
    function uiEl(_kind) { return __veraSidePane; }
    function escapeHtml(s) {
      return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\\"", "&quot;")
        .replaceAll("'", "&#39;");
    }
    function runFlowModeSidePaneContentCrossfade(_el, fn) { fn(); }
    function isVeraInterruptDebugEnabled() { return false; }
    function logVeraInterruptDebug(_payload) {}
    function isLikelyRequestShape(s) {
      const raw = String(s || "").toLowerCase();
      return /\\b(?:tell|give|show|read|bring|fetch|find|search|look|open|grab|pull|get|update|what|when|where|did|do|does|is|are|any|how)\\b/.test(raw);
    }
    var VERA_SAFETY_LIMITS = {
      messages: {
        searchNewsFailure: "Search/news information is not available right now."
      }
    };
    `,
    sandbox,
    { filename: "tests/smoke/__news_frontend_extraction_app_stub__" }
  );

  /* Expose makeFakeBubble inside the sandbox so addBubble can mint
     synthetic elements without leaking the helper to production code. */
  sandbox.__makeFakeBubble = makeFakeBubble;

  vm.runInContext(fs.readFileSync(newsRouterPath, "utf8"), sandbox, { filename: "news/newsRouter.js" });
  vm.runInContext(fs.readFileSync(newsPanelPath, "utf8"), sandbox, { filename: "news/newsPanel.js" });

  return sandbox;
}

/* ────────────────────────────────────────────────────────────────────── */

section("Suite A — modules load + window aliases attached");
let sandbox;
try {
  sandbox = buildLoadedSandbox();
  ok(true, "news/newsRouter.js + news/newsPanel.js evaluate in the sandbox");
} catch (e) {
  ok(false, `news modules load — ${e && e.stack}`);
  process.exit(1);
}
ok(typeof sandbox.window.getNewsRouterDebugState === "function", "window.getNewsRouterDebugState attached");
ok(typeof sandbox.window.getNewsPanelDebugState === "function", "window.getNewsPanelDebugState attached");
ok(
  sandbox.window.getNewsRouterDebugState === vm.runInContext("getNewsRouterDebugState", sandbox),
  "window.getNewsRouterDebugState identity-matches bare identifier"
);
ok(
  sandbox.window.getNewsPanelDebugState === vm.runInContext("getNewsPanelDebugState", sandbox),
  "window.getNewsPanelDebugState identity-matches bare identifier"
);

section("Suite B — moved function/const declarations");
const declCheck = vm.runInContext(`({
  NEWS_EVENT_CLUE_RE_source: NEWS_EVENT_CLUE_RE.source,
  NEWS_NAMED_ENTITY_RE_source: NEWS_NAMED_ENTITY_RE.source,
  PENDING_NEWS_STATUS_TIMEOUT_MS,
  PENDING_NEWS_STATUS_TEXT,
  pendingNewsStatusBubble_initial: pendingNewsStatusBubble === null,
  pendingNewsStatusTimerId_initial: pendingNewsStatusTimerId === null,
  pendingNewsStatusToken_initial: pendingNewsStatusToken,
  _clearPendingNewsStatusTimer: typeof _clearPendingNewsStatusTimer,
  looksLikeNewsSearchRequest: typeof looksLikeNewsSearchRequest,
  armPendingNewsStatusBubble: typeof armPendingNewsStatusBubble,
  cancelPendingNewsStatusBubble: typeof cancelPendingNewsStatusBubble,
  failPendingNewsStatusBubble: typeof failPendingNewsStatusBubble,
  _veraNewsPanelRenderInFlight_initial: _veraNewsPanelRenderInFlight,
  renderNewsResultListMarkup: typeof renderNewsResultListMarkup,
  renderImageResultsMarkup: typeof renderImageResultsMarkup,
  getVideoEmbedUrl: typeof getVideoEmbedUrl,
  renderVideoResultsMarkup: typeof renderVideoResultsMarkup,
  setActiveSidePaneTab: typeof setActiveSidePaneTab,
  renderMediaTabsPanel: typeof renderMediaTabsPanel,
  getNewsRouterDebugState: typeof getNewsRouterDebugState,
  getNewsPanelDebugState: typeof getNewsPanelDebugState,
})`, sandbox);

ok(declCheck.PENDING_NEWS_STATUS_TIMEOUT_MS === 90000, "PENDING_NEWS_STATUS_TIMEOUT_MS === 90000");
ok(declCheck.PENDING_NEWS_STATUS_TEXT === "Searching news…", "PENDING_NEWS_STATUS_TEXT preserved");
ok(declCheck.pendingNewsStatusBubble_initial === true, "pendingNewsStatusBubble initial null");
ok(declCheck.pendingNewsStatusTimerId_initial === true, "pendingNewsStatusTimerId initial null");
ok(declCheck.pendingNewsStatusToken_initial === 0, "pendingNewsStatusToken initial 0");
ok(declCheck._veraNewsPanelRenderInFlight_initial === false, "_veraNewsPanelRenderInFlight initial false");
ok(declCheck.NEWS_EVENT_CLUE_RE_source.includes("breaking"), "NEWS_EVENT_CLUE_RE.source contains 'breaking'");
ok(declCheck.NEWS_NAMED_ENTITY_RE_source.includes("trump"), "NEWS_NAMED_ENTITY_RE.source contains 'trump'");
ok(declCheck.NEWS_NAMED_ENTITY_RE_source.includes("nvidia"), "NEWS_NAMED_ENTITY_RE.source contains 'nvidia'");

const expectedFns = [
  "_clearPendingNewsStatusTimer",
  "looksLikeNewsSearchRequest",
  "armPendingNewsStatusBubble",
  "cancelPendingNewsStatusBubble",
  "failPendingNewsStatusBubble",
  "renderNewsResultListMarkup",
  "renderImageResultsMarkup",
  "getVideoEmbedUrl",
  "renderVideoResultsMarkup",
  "setActiveSidePaneTab",
  "renderMediaTabsPanel",
  "getNewsRouterDebugState",
  "getNewsPanelDebugState",
];
for (const fn of expectedFns) {
  ok(declCheck[fn] === "function", `${fn} is function (got ${declCheck[fn]})`);
}

section("Suite C — looksLikeNewsSearchRequest (POSITIVE)");
const lln = (s) => vm.runInContext(`looksLikeNewsSearchRequest(${JSON.stringify(s)})`, sandbox);
eq(lln("tell me the news"), true, "'tell me the news' → true");
eq(lln("latest news about NVIDIA"), true, "'latest news about NVIDIA' → true");
eq(lln("breaking news"), true, "'breaking news' → true");
eq(lln("any news about Apple"), true, "'any news about Apple' → true");
eq(lln("did Trump go to China last week"), true, "'did Trump go to China last week' → true");
eq(lln("what happened today"), true, "'what happened today' → true");
eq(lln("what's going on"), true, "'what's going on' → true");
eq(lln("show me the sources"), true, "'show me the sources' → true");
eq(lln("headlines"), true, "'headlines' → true");
eq(lln("articles"), true, "'articles' → true");
eq(lln("search for tesla earnings"), true, "'search for tesla earnings' → true");
eq(lln("do you know if Putin met Xi today"), true, "'do you know if Putin met Xi today' → true");

section("Suite D — looksLikeNewsSearchRequest (NEGATIVE — personal / emotional / loss)");
eq(lln("I got bad news"), false, "'I got bad news' → false");
eq(lln("I have terrible news"), false, "'I have terrible news' → false");
eq(lln("I just saw the news my friend passed away"), false, "'I just saw the news my friend passed away' → false");
eq(lln("sad news from my family"), false, "'sad news from my family' → false");
eq(lln("news from my mom"), false, "'news from my mom' → false");
eq(lln("we got the news that my grandpa died"), false, "'we got the news that my grandpa died' → false");

section("Suite E — looksLikeNewsSearchRequest (NEGATIVE — personal/general knowledge + local intents)");
eq(lln("what do you know about me"), false, "'what do you know about me' → false");
eq(lln("do you know my name"), false, "'do you know my name' → false");
eq(lln("do you know what tennis is"), false, "'do you know what tennis is' → false");
eq(lln("do you know how to cook pasta"), false, "'do you know how to cook pasta' → false");
eq(lln("play the next song"), false, "music intent → false");
eq(lln("sync the checklist"), false, "checklist intent → false");
eq(lln("set a five minute timer"), false, "timer intent → false");
eq(lln("hello vera"), false, "greeting → false");
eq(lln("thanks"), false, "thanks → false");
eq(lln("open the work mode panel"), false, "open work-mode panel → false");
eq(lln(""), false, "empty string → false");
eq(lln(null), false, "null → false");

section("Suite F — looksLikeNewsSearchRequest (weak-recency gate)");
/* Bare recency-only utterances must NOT trigger the bubble. */
eq(lln("I have a lot of homework today"), false, "'I have a lot of homework today' → false");
eq(lln("I'm tired today"), false, "'I'm tired today' → false");
/* Strong tail with weak recency: still triggers via the news-noun rule. */
eq(lln("today's news"), true, "'today's news' (news-noun rule) → true");

section("Suite F2 — looksLikeNewsSearchRequest (PART 2: historical/educational suppression)");
/* PART 2 (2026-05-28): historical/educational explanatory queries must NOT
 * trigger the pending news bubble. Mirrors backend
 * `_is_historical_or_educational_question`. */
eq(lln("Can you explain the Vietnam War?"), false, "'Can you explain the Vietnam War?' → false (hist)");
eq(lln("What caused the Vietnam War?"), false, "'What caused the Vietnam War?' → false (hist)");
eq(lln("Who won World War II?"), false, "'Who won World War II?' → false (hist)");
eq(lln("Explain the Cold War."), false, "'Explain the Cold War.' → false (hist)");
eq(lln("What was the Roman Empire?"), false, "'What was the Roman Empire?' → false (hist)");
eq(lln("Why did the Soviet Union collapse?"), false, "'Why did the Soviet Union collapse?' → false (hist)");
eq(lln("Tell me about Napoleon."), false, "'Tell me about Napoleon.' → false (hist)");
eq(lln("Explain the French Revolution."), false, "'Explain the French Revolution.' → false (hist)");
eq(lln("Tell me about the Industrial Revolution"), false, "'Industrial Revolution' explainer → false");
eq(lln("Explain photosynthesis"), false, "'Explain photosynthesis' → false (educational)");
/* PART 2 OVERRIDE: news verb / today / latest about a historical topic IS legitimate news. */
eq(lln("Latest news about the Vietnam War documentary"), true, "'Latest news about Vietnam War documentary' → true (override)");
eq(lln("Did Netflix release a Cold War series today"), true, "'Netflix Cold War series today' → true (override)");

section("Suite G — getVideoEmbedUrl");
const ge = (u) => vm.runInContext(`getVideoEmbedUrl(${JSON.stringify(u)})`, sandbox);
eq(ge("https://youtu.be/abc123"), "https://www.youtube.com/embed/abc123", "youtu.be → embed");
eq(ge("https://www.youtube.com/watch?v=xyz"), "https://www.youtube.com/embed/xyz", "youtube.com?v= → embed");
eq(ge("https://m.youtube.com/watch?v=abc"), "https://www.youtube.com/embed/abc", "m.youtube.com?v= → embed");
eq(ge("https://example.com/video.mp4"), "", "unknown host → ''");
eq(ge("not-a-url"), "", "garbage → ''");
eq(ge(""), "", "empty → ''");
eq(ge(null), "", "null → ''");

section("Suite H — renderNewsResultListMarkup");
const rnList = (rs) => vm.runInContext(`renderNewsResultListMarkup(${JSON.stringify(rs)})`, sandbox);
ok(rnList([]).includes("No articles available"), "empty list → 'No articles available'");
const sampleHtml = rnList([
  { title: "Nvidia hits record", summary: "Stock soars", source: "Reuters", published_display: "Today", url: "https://x.test" },
  { title: "Apple keynote", summary: "WWDC", source: "Apple", published_display: "Yesterday", url: "" },
]);
ok(sampleHtml.includes("Nvidia hits record"), "renders first title");
ok(sampleHtml.includes("Apple keynote"), "renders second title");
ok(sampleHtml.includes("Open source"), "renders Open source link when url present");
ok(sampleHtml.match(/Open source/g).length === 1, "Open source link only appears once (only first item has url)");
ok(sampleHtml.includes("class=\"news-result-list\""), "wraps with .news-result-list");

section("Suite I — renderImageResultsMarkup + renderVideoResultsMarkup");
const ri = (xs) => vm.runInContext(`renderImageResultsMarkup(${JSON.stringify(xs)})`, sandbox);
ok(ri([]).includes("No images available"), "empty image list");
const imgHtml = ri([{ url: "https://im.test/a", image_url: "https://im.test/a.jpg", title: "Alpha", source: "TestSrc" }]);
ok(imgHtml.includes("Alpha") && imgHtml.includes("TestSrc"), "image card renders title + source");

const rv = (xs) => vm.runInContext(`renderVideoResultsMarkup(${JSON.stringify(xs)})`, sandbox);
ok(rv([]).includes("No videos available"), "empty video list");
const vidHtml = rv([
  { url: "https://youtu.be/aa", title: "Embed clip", source: "YT", thumbnail_url: "https://thumb/aa.jpg", summary: "" },
  { url: "https://example.com/foo.mp4", title: "Thumb clip", source: "ExampleVids", thumbnail_url: "https://thumb/foo.jpg", summary: "Summary here" },
  { url: "https://example.com/bar.mp4", title: "Bare clip", source: "ExampleVids", thumbnail_url: "", summary: "" },
]);
ok(vidHtml.includes("video-embed-wrap"), "embed branch present for YouTube URL");
ok(vidHtml.includes("Thumb clip") && vidHtml.includes("https://thumb/foo.jpg"), "thumbnail branch for non-embed video");
ok(vidHtml.includes("Bare clip"), "third video still renders without embed or thumbnail");

section("Suite J — pending status bubble lifecycle (arm / cancel / fail)");
/* cancel before arm is a safe no-op (returns false). Note that cancel
 * still bumps `pendingNewsStatusToken` defensively — that's the same
 * behavior as in app.js (a defensive `++` on every cancel so a late
 * timer callback for a no-longer-tracked bubble cannot win the race). */
const tokBeforeInitialCancel = vm.runInContext(`pendingNewsStatusToken`, sandbox);
eq(vm.runInContext(`cancelPendingNewsStatusBubble("initial")`, sandbox), false, "cancel before arm → false");
ok(
  vm.runInContext(`pendingNewsStatusToken`, sandbox) === tokBeforeInitialCancel + 1,
  "defensive cancel bumps token by 1 even with no live bubble"
);

/* arm with a positive utterance.
 * arm() internally calls cancelPendingNewsStatusBubble("superseded") to
 * drop any stale bubble, then does `const token = ++pendingNewsStatusToken;`
 * — so a fresh arm bumps the counter by 2 relative to the pre-arm value
 * (one from the defensive cancel, one from the ++). */
const tokBeforeFirstArm = vm.runInContext(`pendingNewsStatusToken`, sandbox);
const armed = vm.runInContext(`armPendingNewsStatusBubble("tell me the news")`, sandbox);
ok(armed && typeof armed === "object", "armPendingNewsStatusBubble returned a bubble");
ok(armed.dataset.pendingStatus === "news", "armed bubble dataset.pendingStatus === 'news'");
ok(armed.dataset.pendingForText === "tell me the news", "armed bubble dataset.pendingForText preserved");
ok(armed.textContent === "Searching news…", "armed bubble textContent === 'Searching news…'");
const tokAfterFirstArm = vm.runInContext(`pendingNewsStatusToken`, sandbox);
ok(
  tokAfterFirstArm === tokBeforeFirstArm + 2,
  `token bumped by 2 after first arm (defensive cancel + ++): before=${tokBeforeFirstArm} after=${tokAfterFirstArm}`
);
ok(armed.dataset.pendingToken === String(tokAfterFirstArm), "armed bubble dataset.pendingToken matches token counter");

/* arm idempotency: same utterance → same bubble, no re-create, no token bump */
const armedAgain = vm.runInContext(`armPendingNewsStatusBubble("tell me the news")`, sandbox);
ok(armedAgain === armed, "armPendingNewsStatusBubble is idempotent for same utteranceKey");
ok(
  vm.runInContext(`pendingNewsStatusToken`, sandbox) === tokAfterFirstArm,
  "token NOT bumped on idempotent arm"
);

/* fail rewrites class + text */
ok(vm.runInContext(`failPendingNewsStatusBubble("net-error")`, sandbox) === true, "failPendingNewsStatusBubble returns true on connected bubble");
ok(armed.textContent.includes("not available"), "failed bubble text mentions 'not available'");
ok(armed.classList.contains("vera-pending-status-failed"), "failed bubble has vera-pending-status-failed class");
ok(armed.classList.contains("vera-safety-failure"), "failed bubble has vera-safety-failure class");
ok(armed.dataset.pendingStatus === "news_failed", "failed bubble dataset.pendingStatus === 'news_failed'");

/* arm + cancel removes the bubble + bumps token.
 * Note: the failed bubble above is still "tracked" by the router (so that
 * a late-success can clear the red bubble). The next arm() therefore
 * calls cancelPendingNewsStatusBubble("superseded") first — that drops
 * the old failed bubble + bumps token, then the ++ inside arm() bumps
 * token a second time. So the second arm also bumps by 2 relative to
 * the pre-arm token. */
const tokBeforeSecondArm = vm.runInContext(`pendingNewsStatusToken`, sandbox);
const armed2 = vm.runInContext(`armPendingNewsStatusBubble("latest news about NVIDIA")`, sandbox);
ok(armed2 && armed2 !== armed, "second arm produced a NEW bubble (different utterance)");
ok(
  vm.runInContext(`pendingNewsStatusToken`, sandbox) === tokBeforeSecondArm + 2,
  "second arm also bumps token by 2 (defensive cancel of stale failed bubble + ++)"
);
const tokenBeforeFinalCancel = vm.runInContext(`pendingNewsStatusToken`, sandbox);
ok(vm.runInContext(`cancelPendingNewsStatusBubble("done")`, sandbox) === true, "cancel returns true on connected bubble");
ok(armed2.isConnected === false, "cancelled bubble was detached");
ok(
  vm.runInContext(`pendingNewsStatusToken`, sandbox) === tokenBeforeFinalCancel + 1,
  "explicit cancel bumps token by 1"
);

/* arming with a negative utterance returns null (no force) */
eq(vm.runInContext(`armPendingNewsStatusBubble("hello vera")`, sandbox), null, "armPendingNewsStatusBubble('hello vera') → null");

/* force=true overrides the heuristic */
const forced = vm.runInContext(`armPendingNewsStatusBubble("hello vera", { force: true })`, sandbox);
ok(forced && forced.dataset.pendingStatus === "news", "force:true overrides heuristic and creates bubble");
vm.runInContext(`cancelPendingNewsStatusBubble("cleanup")`, sandbox);

section("Suite K — setActiveSidePaneTab");
/* Build a stub side pane and wire it through uiEl(). */
const sp = makeFakeSidePane();
sp._addTab("news");
sp._addTab("images");
sp._addTab("video");
sp._addPanel("news");
sp._addPanel("images");
sp._addPanel("video");
sandbox.__veraSidePane = sp;
vm.runInContext(`setVeraSidePane(globalThis.__veraSidePane)`, sandbox);
vm.runInContext(`setActiveSidePaneTab("images")`, sandbox);
const tabsActive = sp.querySelectorAll(".side-pane-tab").map((t) => ({ tab: t.dataset.tab, active: t.classList.contains("active") }));
const panelsActive = sp.querySelectorAll(".side-pane-tab-panel").map((p) => ({ tab: p.dataset.tabPanel, active: p.classList.contains("active") }));
eq(tabsActive, [
  { tab: "news", active: false },
  { tab: "images", active: true },
  { tab: "video", active: false },
], "setActiveSidePaneTab('images') sets only images tab active");
eq(panelsActive, [
  { tab: "news", active: false },
  { tab: "images", active: true },
  { tab: "video", active: false },
], "setActiveSidePaneTab('images') sets only images panel active");

section("Suite L — _veraNewsPanelRenderInFlight mutability");
ok(vm.runInContext(`_veraNewsPanelRenderInFlight`, sandbox) === false, "default false");
vm.runInContext(`_veraNewsPanelRenderInFlight = true`, sandbox);
ok(vm.runInContext(`_veraNewsPanelRenderInFlight`, sandbox) === true, "writable via bare-identifier reassignment");
vm.runInContext(`_veraNewsPanelRenderInFlight = false`, sandbox);
ok(vm.runInContext(`_veraNewsPanelRenderInFlight`, sandbox) === false, "writable back to false");

section("Suite M — getNewsRouterDebugState + getNewsPanelDebugState shape");
const dbgRouter = vm.runInContext(`getNewsRouterDebugState()`, sandbox);
ok(dbgRouter && typeof dbgRouter === "object", "getNewsRouterDebugState returns object");
ok(dbgRouter.pending_news_status_timeout_ms === 90000, "router debug timeout preserved");
ok(dbgRouter.pending_news_status_text === "Searching news…", "router debug text preserved");
ok(typeof dbgRouter.pending_token_counter === "number", "router debug pending_token_counter is number");
ok(dbgRouter.looks_like_news_search_request_typeof === "function", "router debug looks_like_news_search_request_typeof === 'function'");
ok(typeof dbgRouter.news_event_clue_re_source === "string" && dbgRouter.news_event_clue_re_source.includes("breaking"), "router debug news_event_clue_re_source has 'breaking'");

const dbgPanel = vm.runInContext(`getNewsPanelDebugState()`, sandbox);
ok(dbgPanel && typeof dbgPanel === "object", "getNewsPanelDebugState returns object");
ok(dbgPanel.news_panel_render_in_flight === false, "panel debug news_panel_render_in_flight === false");
ok(dbgPanel.render_media_tabs_panel_typeof === "function", "panel debug render_media_tabs_panel_typeof === 'function'");
ok(dbgPanel.render_news_result_list_markup_typeof === "function", "panel debug render_news_result_list_markup_typeof === 'function'");
ok(dbgPanel.set_active_side_pane_tab_typeof === "function", "panel debug set_active_side_pane_tab_typeof === 'function'");

section("Suite N — app.js no longer declares the moved bindings");
const appSrc = fs.readFileSync(appJsPath, "utf8");
for (const name of [
  "NEWS_EVENT_CLUE_RE",
  "NEWS_NAMED_ENTITY_RE",
  "PENDING_NEWS_STATUS_TIMEOUT_MS",
  "PENDING_NEWS_STATUS_TEXT",
  "pendingNewsStatusBubble",
  "pendingNewsStatusTimerId",
  "pendingNewsStatusToken",
  "_veraNewsPanelRenderInFlight",
]) {
  const declRe = new RegExp(String.raw`^(let|const|var)\s+${name}\b`, "m");
  ok(!declRe.test(appSrc), `app.js no longer declares ${name}`);
}
for (const name of [
  "_clearPendingNewsStatusTimer",
  "looksLikeNewsSearchRequest",
  "armPendingNewsStatusBubble",
  "cancelPendingNewsStatusBubble",
  "failPendingNewsStatusBubble",
  "renderNewsResultListMarkup",
  "renderImageResultsMarkup",
  "getVideoEmbedUrl",
  "renderVideoResultsMarkup",
  "setActiveSidePaneTab",
  "renderMediaTabsPanel",
]) {
  const declRe = new RegExp(String.raw`^(async\s+)?function\s+${name}\b`, "m");
  ok(!declRe.test(appSrc), `app.js no longer declares function ${name}`);
}

section("Suite O — app.js still declares the intentionally-LEFT side-panel helpers");
const leftBindings = [
  /^function\s+hideSidePanel\b/m,
  /^function\s+onSidePaneClick\b/m,
  /^function\s+renderFinanceChartPanel\b/m,
  /^function\s+renderProductivityPanel\b/m,
  /^function\s+toggleProductivityPanel\b/m,
  /^function\s+runFlowModeSidePaneContentCrossfade\b/m,
];
for (const re of leftBindings) {
  ok(re.test(appSrc), `app.js still has ${re.source}`);
}

section("Suite P — index.html load order");
const htmlSrc = fs.readFileSync(indexHtmlPath, "utf8");
const orderTags = [
  "utils/ids.js",
  "utils/storage.js",
  "utils/logging.js",
  "voice/asr.js",
  "voice/ttsQueue.js",
  "voice/interruption.js",
  "workmode/panels.js",
  "workmode/checklist.js",
  "news/newsRouter.js",
  "news/newsPanel.js",
  "app.js",
  "debug/voiceDebug.js",
];
let lastIdx = -1;
for (const tag of orderTags) {
  const i = htmlSrc.indexOf(`<script src="${tag}`);
  ok(i > lastIdx, `index.html loads ${tag} after the previous script (at offset ${i})`);
  lastIdx = i;
}
ok(/<script src="app\.js\?v=\d+"><\/script>/.test(htmlSrc), "app.js cache-buster present");

section("Suite Q — news modules parse as classic scripts");
const routerSrc = fs.readFileSync(newsRouterPath, "utf8");
const panelSrc = fs.readFileSync(newsPanelPath, "utf8");
ok(!/^\s*import\s/m.test(routerSrc), "newsRouter.js has no ESM import statements");
ok(!/^\s*export\s/m.test(routerSrc), "newsRouter.js has no ESM export statements");
ok(!/^\s*import\s/m.test(panelSrc), "newsPanel.js has no ESM import statements");
ok(!/^\s*export\s/m.test(panelSrc), "newsPanel.js has no ESM export statements");

section("Suite R — classifyVeraTurnRoute (PART 1+15 — 8-category router)");
/* New strict 8-category frontend router. Mirrors backend
 * classify_current_info_intent for log parity. */
ok(typeof sandbox.window.classifyVeraTurnRoute === "function", "window.classifyVeraTurnRoute attached");
ok(typeof sandbox.window.logNewsRouterRouteFrontend === "function", "window.logNewsRouterRouteFrontend attached");
const route = (s, opts) => vm.runInContext(`classifyVeraTurnRoute(${JSON.stringify(s)}, ${JSON.stringify(opts || {})})`, sandbox);

/* PART 4 / Test 9: personal news suppresses news routing */
eq(route("I just saw the news my friend passed away").route, "personal_or_emotional", "personal news → personal_or_emotional");
eq(route("I got bad news today").route, "personal_or_emotional", "'bad news today' → personal_or_emotional");
eq(route("I just saw the news my friend passed away").shouldSearchNews, false, "personal → shouldSearchNews=false");
eq(route("I just saw the news my friend passed away").signals.blocked_news_reason, "personal_emotional", "blocked_news_reason=personal_emotional");

/* PART 3 / Test 2: utility queries beat news */
eq(route("What time is it in Tokyo?").route, "utility_time_weather_finance_or_app_action", "time query → utility");
eq(route("What's the weather in Tokyo?").route, "utility_time_weather_finance_or_app_action", "weather → utility");
eq(route("What's the price of VGT?").route, "utility_time_weather_finance_or_app_action", "finance → utility");
eq(route("Close panel 1").route, "utility_time_weather_finance_or_app_action", "close panel → utility");
eq(route("Open the news panel").route, "utility_time_weather_finance_or_app_action", "open news panel → utility");
eq(route("What time is it in Tokyo?").shouldSearchNews, false, "time → shouldSearchNews=false");
eq(route("What time is it in Tokyo?").signals.blocked_news_reason, "utility_query", "blocked_news_reason=utility_query");

/* PART 2 / Test 1: historical/educational routes to general LLM */
eq(route("Can you explain the Vietnam War?").route, "historical_or_educational_explanation", "Vietnam War explain → hist/edu");
eq(route("What caused the Cold War?").route, "historical_or_educational_explanation", "Cold War cause → hist/edu");
eq(route("Tell me about Napoleon").route, "historical_or_educational_explanation", "Napoleon → hist/edu");
eq(route("Explain the French Revolution").route, "historical_or_educational_explanation", "French Revolution → hist/edu");
eq(route("Explain photosynthesis").route, "historical_or_educational_explanation", "photosynthesis → hist/edu");
eq(route("Who won World War II?").route, "historical_or_educational_explanation", "WW2 winner → hist/edu");
eq(route("Can you explain the Vietnam War?").shouldSearchNews, false, "hist → shouldSearchNews=false");
eq(route("Can you explain the Vietnam War?").signals.blocked_news_reason, "historical_or_educational", "blocked_news_reason=historical_or_educational");
/* PART 2 OVERRIDE: explicit news intent on historical topic IS news */
eq(route("Latest news about the Vietnam War documentary").route, "explicit_news_request", "Vietnam War documentary news → news (override)");

/* PART 5 / Test 3: explicit news requests */
eq(route("Tell me the news").route, "explicit_news_request", "'tell me the news' → explicit_news_request");
eq(route("What's the latest news?").route, "explicit_news_request", "'latest news' → explicit_news_request");
eq(route("Show me breaking news").route, "explicit_news_request", "'breaking news' → explicit_news_request");
eq(route("Latest news about OpenAI").route, "explicit_news_request", "'latest news about X' → explicit_news_request");
eq(route("Tell me the news").shouldSearchNews, true, "explicit_news → shouldSearchNews=true");
eq(route("Tell me the news").searchQuerySource, "current_user_text", "explicit_news → query from current_user_text");

/* PART 6 / Test 3: current fact search */
eq(route("Did Donald Trump go to China last week?").route, "current_fact_search", "Trump China last week → current_fact_search");
eq(route("Did Donald Trump go to China last week?").shouldSearchNews, true, "current_fact → shouldSearchNews=true");
eq(route("Did Donald Trump go to China last week?").searchQuerySource, "current_user_text", "current_fact → query from current_user_text");
eq(route("Did Donald Trump go to China last week?").searchQueryGenerated, "Did Donald Trump go to China last week?", "current_fact → exact user text as query");

/* PART 11/12 / Test 6: stable named-entity factual question.
 * User chose current_fact_search default — any named-entity question routes to search. */
eq(route("Was Elon Musk part of the OpenAI team?").route, "current_fact_search", "Musk OpenAI team → current_fact_search (user chose this default)");
eq(route("Was Elon Musk part of the OpenAI team?").searchQuerySource, "current_user_text", "stable fact → query from current_user_text");
eq(route("Was Elon Musk part of the OpenAI team?").searchQueryGenerated, "Was Elon Musk part of the OpenAI team?", "stable fact → exact user text");

/* PART 9 / Test 4: interpretive follow-up uses LLM (no new search) */
const interpCtx = { topic: "Trump China visit", entities: ["Trump", "China"] };
eq(route("Why was he there?", { recentNewsContext: interpCtx }).route, "interpretive_followup_llm", "'why was he there' → interpretive_followup_llm");
eq(route("Why was he there?", { recentNewsContext: interpCtx }).shouldSearchNews, false, "interpretive → shouldSearchNews=false");
eq(route("Why was he there?", { recentNewsContext: interpCtx }).signals.followup_type, "interpretive", "followup_type=interpretive");

/* PART 10 / Test 5: fresh-update follow-up triggers search */
eq(route("Any updates today?", { recentNewsContext: interpCtx }).route, "fresh_or_source_followup_search", "'any updates today' → fresh_followup");
eq(route("Any updates today?", { recentNewsContext: interpCtx }).shouldSearchNews, true, "fresh follow-up → shouldSearchNews=true");
eq(route("Any updates today?", { recentNewsContext: interpCtx }).signals.followup_type, "fresh_update", "followup_type=fresh_update");
eq(route("What does Reuters say?", { recentNewsContext: interpCtx }).route, "fresh_or_source_followup_search", "'what does Reuters say' → fresh_followup");

/* PART 11 / Test 7: named-entity-overrides-followup.
 * "Was he part of the OpenAI team?" with pronoun + ctx → interpretive follow-up.
 * "Was Elon Musk part of the OpenAI team?" with named entity → current_fact_search NOT follow-up. */
const muskSueCtx = { topic: "Elon Musk sue OpenAI", entities: ["Elon Musk", "OpenAI"] };
eq(route("Was he part of the OpenAI team?", { recentNewsContext: muskSueCtx }).route, "interpretive_followup_llm", "'was he part of OpenAI' (pronoun) → interpretive");
eq(route("Was Elon Musk part of the OpenAI team?", { recentNewsContext: muskSueCtx }).route, "current_fact_search", "'was ELON MUSK part of OpenAI' (named entity) → current_fact_search NOT followup");
eq(route("Was Elon Musk part of the OpenAI team?", { recentNewsContext: muskSueCtx }).searchQueryGenerated, "Was Elon Musk part of the OpenAI team?", "named-entity question uses CURRENT text not prior topic");
eq(route("Was Elon Musk part of the OpenAI team?", { recentNewsContext: muskSueCtx }).signals.followup_detected, false, "named-entity question NOT marked as follow-up");

/* PART 13: recent_news_context should NOT hijack unrelated new topics */
eq(route("Can you explain the Vietnam War?", { recentNewsContext: interpCtx }).route, "historical_or_educational_explanation", "Vietnam War with prior Trump ctx → still hist/edu");
eq(route("What time is it in Tokyo?", { recentNewsContext: interpCtx }).route, "utility_time_weather_finance_or_app_action", "time query with prior Trump ctx → still utility");
eq(route("Can you explain the Vietnam War?", { recentNewsContext: interpCtx }).signals.previous_news_context_available, true, "prior ctx still flagged as available");

console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
