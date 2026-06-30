/* ============================================================================
 * __workmode_panels_extraction_smoke.mjs
 *
 * Verifies the Stage 8 extraction of reasoning-panel UI / close-orchestration
 * helpers from app.js into workmode/panels.js. Complements (does NOT replace)
 * __reasoning_close_polish_smoke.mjs (PART 2 voice-reply phrasing),
 * __reasoning_close_confirmation_ui_smoke.mjs (assistant-bubble + TTS path),
 * and __reasoning_close_voice_lifecycle_smoke.mjs (lifecycle staging).
 *
 * This smoke focuses on the EXTRACTION itself:
 *
 *   1. workmode/panels.js loads in a classic-script-like sandbox after
 *      utils/storage.js + an app.js stub for shared lets/maps.
 *   2. All moved functions exist as function declarations + all moved
 *      const/let bindings exist with the correct initial values.
 *   3. Window aliases (closeReasoningPanelsByVisualIndices, closeReasoningTab,
 *      buildCloseReasoningPanelsVoiceReply, renderReasoningCloseAssistantConfirmation,
 *      getReasoningPanelOrder, getReasoningPanelDebugState) are attached and
 *      identity-match the bare identifiers.
 *   4. Pure helpers behave exactly as before:
 *        - _countWordOrNumber + _REASONING_CLOSE_COUNT_WORD_OUT
 *        - isReasoningCloseVoiceSource matching
 *        - _isGenericBlankReasoningPanelLabel +
 *          isGenericAutoRenamableReasoningPanelTitle
 *        - isDefaultWorkModeReasoningPanelLaneLabel
 *        - close-lock helpers (key, set, has, peek)
 *        - snapshotReasoningPanelForUndo (pure data)
 *        - pickReplacementActivePanelInfo (pure data)
 *        - _pickActivePanelInfoAfterRefill (pure data)
 *        - snapshotReasoningLaneRegistryForDebug (reads the
 *          workModeCompletedReasoningByLaneId stub)
 *        - getReasoningPanelDebugState returns sensible defaults
 *   5. app.js no longer declares any of the moved bindings.
 *   6. index.html load order: panels.js comes after voice/interruption.js
 *      and before app.js.
 *   7. workmode/panels.js parses as a classic script (no ESM imports/exports).
 *
 * Run:  node tests/smoke/__workmode_panels_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const panelsPath = path.join(repoRoot, "workmode", "panels.js");
const appJsPath = path.join(repoRoot, "app/app.js");
const indexHtmlPath = path.join(repoRoot, "app/index.html");

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

function makeMemoryStorage() {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
    clear: () => bag.clear(),
  };
}

function buildLoadedSandbox() {
  const cConsole = {
    log: () => {}, info: () => {}, debug: () => {},
    warn: () => {}, error: () => {},
  };
  const win = {
    isSecureContext: true,
    setTimeout, clearTimeout,
  };
  /* Minimal DOM stub. We don't try to fake a working panelsRoot —
     close-orchestration tests that need a real DOM are covered by the
     specialized close smokes. */
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => ({
      tagName: String(tag || "").toUpperCase(),
      className: "",
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, force) {
          if (force === true) this._set.add(c);
          else if (force === false) this._set.delete(c);
          else if (this._set.has(c)) this._set.delete(c);
          else this._set.add(c);
        },
        contains(c) { return this._set.has(c); },
      },
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      hidden: false,
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this.attributes[k] = v; },
      replaceChildren() { this.children = []; },
      querySelector: () => null,
      querySelectorAll: () => [],
    }),
  };
  const sandbox = vm.createContext({
    console: cConsole,
    window: win,
    document: doc,
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 12345.6 },
    setTimeout, clearTimeout,
    HTMLElement: class HTMLElement {},
    AbortController,
  });
  sandbox.globalThis = sandbox;
  for (const k of Object.keys(win)) sandbox[k] = win[k];

  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });

  /* App-stub: bindings workmode/panels.js reaches for at call time via the
     shared classic-script global lexical env. Mirrors the names declared
     in app.js (constants + lane-registry helpers + reasoning streaming
     maps + voice/TTS state + voice-confirmation helpers). */
  vm.runInContext(
    `
    /* Stage 20 / Patch A-4 (2026-05-31): REASONING_TABS_DEFAULT,
     * REASONING_TABS_MAX, REASONING_UNTITLED_TAB_NAME moved from app.js
     * to workmode/panels.js — declared at the top level of panels.js
     * itself. Stub declarations were removed from this sandbox because
     * the loaded panels.js would now collide. */

    /* Lane-registry helpers that stay in app.js. */
    var _stableLaneId = 0;
    function ensureStableLaneIdForPanelIndex(idx) { return "lane_" + Number(idx); }
    function replaceStableLaneIdForPanelIndex(idx) { _stableLaneId += 1; return "lane_repl_" + idx + "_" + _stableLaneId; }
    function allocateWorkModeStableLaneId() { _stableLaneId += 1; return "lane_alloc_" + _stableLaneId; }

    /* Reasoning streaming Maps + lets (app.js-owned).
       Stage 12 (2026-05-31): workModeReasoningPanelFollowUpQueue moved
       to workmode/panels.js along with the per-panel follow-up queue
       UI/state helpers. panels.js now declares the Map itself; we no
       longer pre-stub it here (would collide). The Suite L test that
       exercises invalidateClosedReasoningLaneIdentity at L483/L491 below
       continues to work because the Map identifier still resolves in the
       sandbox — it's just defined by panels.js's own evaluation now. */
    const workModeReasoningAbortControllers = new Map();
    const workModeReasoningLaneBusy = new Map();
    const laneReasoningChainTail = new Map();
    const workModeReasoningFinalStatusByLaneId = new Map();
    const workModeCompletedReasoningByLaneId = Object.create(null);
    var activeWorkModeReasoningContext = null;
    var focusedWorkModeLaneId = "";
    var focusedWorkModeLaneAt = 0;
    var workModeLastSubstantiveLaneIdx = null;
    var workModeLastSubstantiveUserText = "";

    /* Persistence + DOM-sync helpers that stay in app.js. */
    function getReasoningTabsStateStorageKey() { return "vera_reasoning_tabs_state:session_smoke"; }
    function persistReasoningTabsState() { globalThis.__persistCalls = (globalThis.__persistCalls || 0) + 1; }
    function syncReasoningLaneBusySlotsAfterDomChange() { globalThis.__syncCalls = (globalThis.__syncCalls || 0) + 1; }
    function syncWorkModeReasoningCancelButton() { globalThis.__syncCancelCalls = (globalThis.__syncCancelCalls || 0) + 1; }
    function setFocusedWorkModeLaneFromIndex(idx) { focusedWorkModeLaneId = "lane_" + Number(idx); focusedWorkModeLaneAt = Date.now(); }

    /* Voice / TTS state + helpers that stay in app.js. */
    var inputMuted = false;
    function appModePrefix() { return "vera"; }
    function isVeraWorkModeOn() { return true; }
    function isWorkModeMuteEnabled() { return false; }
    globalThis.__bubbles = [];
    function addBubble(text, who, meta) { globalThis.__bubbles.push({ text: text, who: who, meta: meta || null }); return { text: text, who: who }; }
    globalThis.__ttsTasks = [];
    function enqueueAssistantTtsPlayback(task) { globalThis.__ttsTasks.push(task); return Promise.resolve(); }
    async function playWorkModeTtsOnlyPhrase(text, signal) { globalThis.__lastTtsPhrase = text; }
    function setStatus(msg, mode) { globalThis.__lastStatus = { msg: msg, mode: mode }; }
    var processing = false;
    var requestInFlight = false;
    var waveState = "idle";
    var voiceUxTurn = null;
    var listeningMode = "continuous";
    function finishReasoningCloseVoiceTurnAfterAssistant(opts) { globalThis.__finishCalls = (globalThis.__finishCalls || []); globalThis.__finishCalls.push(opts || null); }
    function logReasoningCloseVoiceLifecycle(payload) { globalThis.__lifecycleLogs = (globalThis.__lifecycleLogs || []); globalThis.__lifecycleLogs.push(payload); }
    `,
    sandbox,
    { filename: "tests/smoke/__workmode_panels_extraction_app_stub__" }
  );

  vm.runInContext(fs.readFileSync(panelsPath, "utf8"), sandbox, { filename: "workmode/panels.js" });
  return sandbox;
}

/* ────────────────────────────────────────────────────────────────────── */

section("Suite A — module loads cleanly + window aliases attached");
let sandbox;
try {
  sandbox = buildLoadedSandbox();
  ok(true, "workmode/panels.js evaluates in the sandbox");
} catch (e) {
  ok(false, `workmode/panels.js evaluates in the sandbox — ${e && e.stack}`);
  process.exit(1);
}
ok(typeof sandbox.window.closeReasoningPanelsByVisualIndices === "function", "window.closeReasoningPanelsByVisualIndices attached");
ok(typeof sandbox.window.closeReasoningTab === "function", "window.closeReasoningTab attached");
ok(typeof sandbox.window.buildCloseReasoningPanelsVoiceReply === "function", "window.buildCloseReasoningPanelsVoiceReply attached");
ok(typeof sandbox.window.renderReasoningCloseAssistantConfirmation === "function", "window.renderReasoningCloseAssistantConfirmation attached");
ok(typeof sandbox.window.getReasoningPanelOrder === "function", "window.getReasoningPanelOrder attached");
ok(typeof sandbox.window.getReasoningPanelDebugState === "function", "window.getReasoningPanelDebugState attached (new Stage 8 accessor)");
ok(
  sandbox.window.closeReasoningPanelsByVisualIndices === vm.runInContext("closeReasoningPanelsByVisualIndices", sandbox),
  "window alias identity-matches bare identifier (closeReasoningPanelsByVisualIndices)"
);
ok(
  sandbox.window.buildCloseReasoningPanelsVoiceReply === vm.runInContext("buildCloseReasoningPanelsVoiceReply", sandbox),
  "window alias identity-matches bare identifier (buildCloseReasoningPanelsVoiceReply)"
);

section("Suite B — moved function/const declarations");
const declCheck = vm.runInContext(`({
  getWorkModeReasoningLaneLabel: typeof getWorkModeReasoningLaneLabel,
  getWorkModeReasoningLaneId: typeof getWorkModeReasoningLaneId,
  createReasoningLanePanel: typeof createReasoningLanePanel,
  getReasoningScrollElByLane: typeof getReasoningScrollElByLane,
  isGenericAutoRenamableReasoningPanelTitle: typeof isGenericAutoRenamableReasoningPanelTitle,
  getReasoningTabTopicLabel: typeof getReasoningTabTopicLabel,
  isDefaultWorkModeReasoningPanelLaneLabel: typeof isDefaultWorkModeReasoningPanelLaneLabel,
  renderReasoningTabStrip: typeof renderReasoningTabStrip,
  logReasoningPanelSelectDebug: typeof logReasoningPanelSelectDebug,
  activateReasoningTab: typeof activateReasoningTab,
  addReasoningTab: typeof addReasoningTab,
  MIN_REASONING_PANELS: MIN_REASONING_PANELS,
  REASONING_RECENTLY_CLOSED_STACK_MAX: REASONING_RECENTLY_CLOSED_STACK_MAX,
  recentlyClosedReasoningPanels_type: Array.isArray(recentlyClosedReasoningPanels) ? "array" : typeof recentlyClosedReasoningPanels,
  REASONING_CLOSE_TURN_LOCK_MS: REASONING_CLOSE_TURN_LOCK_MS,
  _lastReasoningCloseLock_init: _lastReasoningCloseLock,
  logReasoningCloseDebug: typeof logReasoningCloseDebug,
  logReasoningClosePolishDebug: typeof logReasoningClosePolishDebug,
  _reasoningCloseLockKey: typeof _reasoningCloseLockKey,
  _hasActiveReasoningCloseLock: typeof _hasActiveReasoningCloseLock,
  _setReasoningCloseLock: typeof _setReasoningCloseLock,
  _peekReasoningCloseLock: typeof _peekReasoningCloseLock,
  _isGenericBlankReasoningPanelLabel: typeof _isGenericBlankReasoningPanelLabel,
  _isBlankReasoningPanelElement: typeof _isBlankReasoningPanelElement,
  snapshotReasoningLaneRegistryForDebug: typeof snapshotReasoningLaneRegistryForDebug,
  invalidateClosedReasoningLaneIdentity: typeof invalidateClosedReasoningLaneIdentity,
  readPersistedReasoningPanelTitlesForDebug: typeof readPersistedReasoningPanelTitlesForDebug,
  _normalizeBlankPanelNamesInOrder: typeof _normalizeBlankPanelNamesInOrder,
  _pickActivePanelInfoAfterRefill: typeof _pickActivePanelInfoAfterRefill,
  getReasoningPanelOrder: typeof getReasoningPanelOrder,
  getReasoningTabTopicLabelSafe: typeof getReasoningTabTopicLabelSafe,
  snapshotReasoningPanelForUndo: typeof snapshotReasoningPanelForUndo,
  pickReplacementActivePanelInfo: typeof pickReplacementActivePanelInfo,
  refillReasoningPanelsToMinimum: typeof refillReasoningPanelsToMinimum,
  closeReasoningPanelsByVisualIndices: typeof closeReasoningPanelsByVisualIndices,
  closeReasoningTab: typeof closeReasoningTab,
  _REASONING_CLOSE_COUNT_WORD_OUT_isArray: Array.isArray(_REASONING_CLOSE_COUNT_WORD_OUT),
  _countWordOrNumber: typeof _countWordOrNumber,
  buildCloseReasoningPanelsVoiceReply: typeof buildCloseReasoningPanelsVoiceReply,
  isReasoningCloseVoiceSource: typeof isReasoningCloseVoiceSource,
  logReasoningCloseConfirmationUiDebug: typeof logReasoningCloseConfirmationUiDebug,
  renderReasoningCloseAssistantConfirmation: typeof renderReasoningCloseAssistantConfirmation,
  getReasoningPanelDebugState: typeof getReasoningPanelDebugState,
})`, sandbox);

for (const [k, expected] of [
  ["getWorkModeReasoningLaneLabel", "function"],
  ["getWorkModeReasoningLaneId", "function"],
  ["createReasoningLanePanel", "function"],
  ["getReasoningScrollElByLane", "function"],
  ["isGenericAutoRenamableReasoningPanelTitle", "function"],
  ["getReasoningTabTopicLabel", "function"],
  ["isDefaultWorkModeReasoningPanelLaneLabel", "function"],
  ["renderReasoningTabStrip", "function"],
  ["logReasoningPanelSelectDebug", "function"],
  ["activateReasoningTab", "function"],
  ["addReasoningTab", "function"],
  ["logReasoningCloseDebug", "function"],
  ["logReasoningClosePolishDebug", "function"],
  ["_reasoningCloseLockKey", "function"],
  ["_hasActiveReasoningCloseLock", "function"],
  ["_setReasoningCloseLock", "function"],
  ["_peekReasoningCloseLock", "function"],
  ["_isGenericBlankReasoningPanelLabel", "function"],
  ["_isBlankReasoningPanelElement", "function"],
  ["snapshotReasoningLaneRegistryForDebug", "function"],
  ["invalidateClosedReasoningLaneIdentity", "function"],
  ["readPersistedReasoningPanelTitlesForDebug", "function"],
  ["_normalizeBlankPanelNamesInOrder", "function"],
  ["_pickActivePanelInfoAfterRefill", "function"],
  ["getReasoningPanelOrder", "function"],
  ["getReasoningTabTopicLabelSafe", "function"],
  ["snapshotReasoningPanelForUndo", "function"],
  ["pickReplacementActivePanelInfo", "function"],
  ["refillReasoningPanelsToMinimum", "function"],
  ["closeReasoningPanelsByVisualIndices", "function"],
  ["closeReasoningTab", "function"],
  ["_countWordOrNumber", "function"],
  ["buildCloseReasoningPanelsVoiceReply", "function"],
  ["isReasoningCloseVoiceSource", "function"],
  ["logReasoningCloseConfirmationUiDebug", "function"],
  ["renderReasoningCloseAssistantConfirmation", "function"],
  ["getReasoningPanelDebugState", "function"],
]) {
  ok(declCheck[k] === expected, `${k} is ${expected} (got ${declCheck[k]})`);
}
ok(declCheck.MIN_REASONING_PANELS === 3, "MIN_REASONING_PANELS === REASONING_TABS_DEFAULT (3)");
ok(declCheck.REASONING_RECENTLY_CLOSED_STACK_MAX === 16, "REASONING_RECENTLY_CLOSED_STACK_MAX === 16");
ok(declCheck.recentlyClosedReasoningPanels_type === "array", "recentlyClosedReasoningPanels is an array");
ok(declCheck.REASONING_CLOSE_TURN_LOCK_MS === 4000, "REASONING_CLOSE_TURN_LOCK_MS === 4000");
ok(declCheck._lastReasoningCloseLock_init === null, "_lastReasoningCloseLock initial value === null");
ok(declCheck._REASONING_CLOSE_COUNT_WORD_OUT_isArray === true, "_REASONING_CLOSE_COUNT_WORD_OUT is an array");

section("Suite C — _countWordOrNumber");
const cwn = (n) => vm.runInContext(`_countWordOrNumber(${JSON.stringify(n)})`, sandbox);
eq(cwn(0), "0", "_countWordOrNumber(0) === '0'");
eq(cwn(1), "one", "_countWordOrNumber(1) === 'one'");
eq(cwn(2), "two", "_countWordOrNumber(2) === 'two'");
eq(cwn(3), "three", "_countWordOrNumber(3) === 'three'");
eq(cwn(8), "eight", "_countWordOrNumber(8) === 'eight'");
eq(cwn(9), "9", "_countWordOrNumber(9) → numeric fallback ('9')");
eq(cwn(-1), "-1", "_countWordOrNumber(-1) → numeric fallback ('-1')");
eq(cwn("foo"), "foo", "_countWordOrNumber('foo') → 'foo'");

section("Suite D — buildCloseReasoningPanelsVoiceReply phrasing");
function buildReply(execResult, parsed) {
  return vm.runInContext(`buildCloseReasoningPanelsVoiceReply(${JSON.stringify(execResult)}, ${JSON.stringify(parsed)})`, sandbox);
}
eq(buildReply(null, null), "I couldn't close that reasoning panel.", "null execResult → polite error");
eq(buildReply({ ok: true, closedTitles: ["Panel 1", "Panel 2"], createdBlankCount: 2 }, { closeScope: "range_first_n", indices: [1, 2] }),
   "Closed the first two panels and opened fresh ones.", "range_first_n → 'Closed the first two panels and opened fresh ones.'");
eq(buildReply({ ok: true, closedTitles: ["Panel 1", "Panel 2"], createdBlankCount: 2 }, { closeScope: "range_last_n", indices: [1, 2] }),
   "Closed the last two panels and opened fresh ones.", "range_last_n → 'Closed the last two panels and opened fresh ones.'");
eq(buildReply({ ok: true, closedTitles: ["English Essay Plan"], createdBlankCount: 1 }, { closeScope: "specific_indices", indices: [1] }),
   "Closed the English Essay Plan panel and opened a fresh one.", "meaningful title (specific_indices) → 'Closed the English Essay Plan panel and opened a fresh one.'");
eq(buildReply({ ok: true, closedTitles: ["Panel 1"], createdBlankCount: 1 }, { closeScope: "specific_indices", indices: [1] }),
   "Closed panel 1 and opened a fresh one.", "generic 'Panel 1' (specific_indices) → 'Closed panel 1 and opened a fresh one.'");
eq(buildReply({ ok: true, closedTitles: ["Panel 1", "Panel 2", "Panel 3"], createdBlankCount: 3 }, { closeScope: "all_panels" }),
   "Closed all panels and opened fresh ones.", "all_panels → 'Closed all panels and opened fresh ones.'");
eq(buildReply({ ok: true, closedTitles: ["Panel 2"], createdBlankCount: 0 }, { closeScope: "other_panels" }),
   "Closed the other reasoning panels.", "other_panels → 'Closed the other reasoning panels.'");
eq(buildReply({ ok: true, closedTitles: ["Panel 1"], createdBlankCount: 1 }, { closeScope: "current_panel" }),
   "Closed this panel and opened a fresh one.", "current_panel → 'Closed this panel and opened a fresh one.'");
eq(buildReply({ ok: false, failureReason: "all_indices_out_of_range", totalBefore: 3 }, null),
   "I only see 3 panels.", "failure: all_indices_out_of_range");
eq(buildReply({ ok: false, failureReason: "no_title_match" }, null),
   "I couldn't find that panel.", "failure: no_title_match");

section("Suite E — isReasoningCloseVoiceSource matching");
const isVoice = (s, x) => vm.runInContext(`isReasoningCloseVoiceSource(${JSON.stringify(s)}, ${x === undefined ? "null" : JSON.stringify(x)})`, sandbox);
eq(isVoice("main-browser-asr", null), true, "main-browser-asr → voice");
eq(isVoice("voice_interruption", null), true, "voice_interruption → voice");
eq(isVoice("ptt-browser-asr", null), true, "ptt-browser-asr → voice");
eq(isVoice("work-typed", null), false, "work-typed → text-only");
eq(isVoice("main-work-text-input", null), false, "main-work-text-input → text-only");
eq(isVoice("anything", true), true, "explicit isVoice=true overrides source");
eq(isVoice("main-browser-asr", false), false, "explicit isVoice=false overrides source");
eq(isVoice("", null), false, "empty source → not voice");

section("Suite F — _isGenericBlankReasoningPanelLabel + isGenericAutoRenamableReasoningPanelTitle + isDefaultWorkModeReasoningPanelLaneLabel");
const isBlank = (l) => vm.runInContext(`_isGenericBlankReasoningPanelLabel(${JSON.stringify(l)})`, sandbox);
const isRenam = (l) => vm.runInContext(`isGenericAutoRenamableReasoningPanelTitle(${JSON.stringify(l)})`, sandbox);
const isDefault = (l) => vm.runInContext(`isDefaultWorkModeReasoningPanelLaneLabel(${JSON.stringify(l)})`, sandbox);
const renamable = ["Panel 1", "Panel 6", "Panel 7", "Panel 8", "New Panel", "New Panel 2", "Untitled", ""];
const keep = ["English Essay Plan", "Ticket Complaint Email", "Asian Option Calculation", "Lofi Mix Notes", "1099 Tax Strategy"];
for (const label of renamable) ok(isBlank(label) === true, `_isGenericBlankReasoningPanelLabel("${label}") === true`);
for (const label of keep) ok(isBlank(label) === false, `_isGenericBlankReasoningPanelLabel("${label}") === false`);
ok(isRenam("Panel 1") === true, "isGenericAutoRenamableReasoningPanelTitle('Panel 1') === true");
ok(isRenam("Untitled") === true, "isGenericAutoRenamableReasoningPanelTitle('Untitled') === true");
ok(isRenam("New Panel") === true, "isGenericAutoRenamableReasoningPanelTitle('New Panel') === true");
ok(isRenam("English Essay Plan") === false, "isGenericAutoRenamableReasoningPanelTitle('English Essay Plan') === false");
ok(isDefault("Panel 1") === true, "isDefaultWorkModeReasoningPanelLaneLabel('Panel 1') === true");
ok(isDefault("English Essay Plan") === false, "isDefaultWorkModeReasoningPanelLaneLabel('English Essay Plan') === false");

section("Suite G — close-lock helpers");
vm.runInContext(`_lastReasoningCloseLock = null;`, sandbox);
eq(vm.runInContext(`_hasActiveReasoningCloseLock()`, sandbox), false, "_hasActiveReasoningCloseLock() === false when unset");
eq(vm.runInContext(`_peekReasoningCloseLock()`, sandbox), null, "_peekReasoningCloseLock() === null when unset");
eq(vm.runInContext(`_reasoningCloseLockKey("specific_indices", [1, 2])`, sandbox), "specific_indices|1,2", "_reasoningCloseLockKey('specific_indices', [1,2]) === 'specific_indices|1,2'");
eq(vm.runInContext(`_reasoningCloseLockKey("all_panels", null)`, sandbox), "all_panels|", "_reasoningCloseLockKey('all_panels', null) === 'all_panels|'");
vm.runInContext(`_setReasoningCloseLock({ scope: "specific_indices", indices: [1, 2], confirmation: "Closed two panels.", source: "main-browser-asr" });`, sandbox);
eq(vm.runInContext(`_hasActiveReasoningCloseLock()`, sandbox), true, "_hasActiveReasoningCloseLock() === true after set");
const lockSnap = vm.runInContext(`(() => { const l = _peekReasoningCloseLock(); return { scope: l.scope, indicesKey: l.indicesKey, confirmation: l.confirmation, source: l.source }; })()`, sandbox);
eq(lockSnap, { scope: "specific_indices", indicesKey: "specific_indices|1,2", confirmation: "Closed two panels.", source: "main-browser-asr" }, "_peekReasoningCloseLock() returns the saved snapshot");

section("Suite H — snapshotReasoningPanelForUndo (pure data)");
const undoSnap = vm.runInContext(`snapshotReasoningPanelForUndo({
  element: { querySelector: () => ({ innerHTML: "<p>hello</p>" }) },
  tabIndex: 4, laneId: "lane_xyz", label: "English Essay Plan",
  topic: "English Essay Plan", topicSet: "1", laneLabel: "English Essay Plan",
})`, sandbox);
ok(undoSnap !== null && typeof undoSnap === "object", "snapshotReasoningPanelForUndo returns an object");
ok(undoSnap.tabIndex === 4, "snapshot.tabIndex preserved");
ok(undoSnap.laneId === "lane_xyz", "snapshot.laneId preserved");
ok(undoSnap.label === "English Essay Plan", "snapshot.label preserved");
ok(undoSnap.topic === "English Essay Plan", "snapshot.topic preserved");
ok(undoSnap.topicSet === "1", "snapshot.topicSet preserved");
ok(undoSnap.laneLabel === "English Essay Plan", "snapshot.laneLabel preserved");
ok(undoSnap.html === "<p>hello</p>", "snapshot.html captures innerHTML");
ok(typeof undoSnap.closedAt === "number" && undoSnap.closedAt > 0, "snapshot.closedAt is a positive number");
eq(vm.runInContext(`snapshotReasoningPanelForUndo(null)`, sandbox), null, "snapshotReasoningPanelForUndo(null) === null");
eq(vm.runInContext(`snapshotReasoningPanelForUndo({})`, sandbox), null, "snapshotReasoningPanelForUndo({}) === null (no .element)");

section("Suite I — pickReplacementActivePanelInfo (pure data)");
function prevOrderFixture() {
  return [
    { visualIndex: 1, tabIndex: 0, laneId: "A", label: "Panel 1", isActive: false },
    { visualIndex: 2, tabIndex: 1, laneId: "B", label: "Panel 2", isActive: true },
    { visualIndex: 3, tabIndex: 2, laneId: "C", label: "Panel 3", isActive: false },
  ];
}
function pickRA(closedTabIdxs) {
  return vm.runInContext(`pickReplacementActivePanelInfo(${JSON.stringify(prevOrderFixture())}, new Set(${JSON.stringify(closedTabIdxs)}))`, sandbox);
}
ok(pickRA([])?.tabIndex === 1, "active survives → returns active (tabIndex=1)");
ok(pickRA([1])?.tabIndex === 2, "close active → returns right neighbor (tabIndex=2)");
ok(pickRA([1, 2])?.tabIndex === 0, "close active + right → returns left neighbor (tabIndex=0)");
eq(pickRA([0, 1, 2]), null, "close all → returns null");

section("Suite J — _pickActivePanelInfoAfterRefill (pure data)");
function pickAfter(prev, closed, current) {
  return vm.runInContext(`_pickActivePanelInfoAfterRefill(${JSON.stringify(prev)}, new Set(${JSON.stringify(closed)}), ${JSON.stringify(current)})`, sandbox);
}
const prev = prevOrderFixture();
const currentAfterClosingActive = [
  { visualIndex: 1, tabIndex: 0, laneId: "A", label: "Panel 1", isActive: false },
  { visualIndex: 2, tabIndex: 2, laneId: "C", label: "Panel 3", isActive: false },
  { visualIndex: 3, tabIndex: 9, laneId: "fresh", label: "Panel 3", isActive: false },
];
ok(pickAfter(prev, [1], currentAfterClosingActive)?.tabIndex === 2, "close active → right-neighbor 'Panel 3' (tabIndex=2)");
const currentAfterClosingFirst = [
  { visualIndex: 1, tabIndex: 1, laneId: "B", label: "Panel 2", isActive: true },
  { visualIndex: 2, tabIndex: 2, laneId: "C", label: "Panel 3", isActive: false },
  { visualIndex: 3, tabIndex: 9, laneId: "fresh", label: "Panel 3", isActive: false },
];
ok(pickAfter(prev, [0], currentAfterClosingFirst)?.tabIndex === 1, "close non-active → previous active survives (tabIndex=1)");
const prevWithMeaningful = [
  { visualIndex: 1, tabIndex: 0, laneId: "A", label: "Panel 1", isActive: false },
  { visualIndex: 2, tabIndex: 1, laneId: "B", label: "Panel 2", isActive: false },
  { visualIndex: 3, tabIndex: 2, laneId: "C", label: "English Essay Plan", isActive: false },
];
const currentWithMeaningful = [
  { visualIndex: 1, tabIndex: 0, laneId: "A", label: "Panel 1", isActive: false },
  { visualIndex: 2, tabIndex: 2, laneId: "C", label: "English Essay Plan", isActive: false },
  { visualIndex: 3, tabIndex: 9, laneId: "fresh", label: "Panel 3", isActive: false },
];
ok(pickAfter(prevWithMeaningful, [1], currentWithMeaningful)?.tabIndex === 2,
   "prefers surviving meaningful original ('English Essay Plan') over fresh blank");

section("Suite K — snapshotReasoningLaneRegistryForDebug + readPersistedReasoningPanelTitlesForDebug");
vm.runInContext(`
  workModeCompletedReasoningByLaneId["lane_a"] = {
    title: "English Essay Plan",
    lane_title: "English Essay Plan",
    main_context_type: "essay",
    latest_turn_type: "answer",
    updated_at: 1700000000,
  };
`, sandbox);
const reg = vm.runInContext(`snapshotReasoningLaneRegistryForDebug(["lane_a", "lane_missing"])`, sandbox);
ok(reg.lane_a && reg.lane_a.title === "English Essay Plan", "snapshotReasoningLaneRegistryForDebug returns row data for known lane");
ok(reg.lane_missing === null, "snapshotReasoningLaneRegistryForDebug returns null for unknown lane");
eq(vm.runInContext(`readPersistedReasoningPanelTitlesForDebug()`, sandbox), [], "readPersistedReasoningPanelTitlesForDebug() returns [] when no persisted state");

section("Suite L — getReasoningPanelDebugState shape (no panels stub)");
const dbg = vm.runInContext(`getReasoningPanelDebugState()`, sandbox);
ok(dbg && typeof dbg === "object", "getReasoningPanelDebugState returns object");
ok(dbg.panelCount === 0, "panelCount === 0 (no DOM panels)");
ok(dbg.minPanels === 3, "minPanels === 3");
ok(dbg.maxPanels === 8, "maxPanels === 8");
ok(Array.isArray(dbg.panelOrder), "panelOrder is an array");
ok(dbg.activePanel === null, "activePanel === null when no panels");
ok(typeof dbg.recentlyClosedStackSize === "number", "recentlyClosedStackSize is a number");
ok(dbg.closeLockTurnLockMs === 4000, "closeLockTurnLockMs === 4000");
ok(typeof dbg.closeLockActive === "boolean", "closeLockActive is a boolean");

section("Suite M — invalidateClosedReasoningLaneIdentity mutates app.js-side state");
const beforeAbortHas = vm.runInContext(`(() => { workModeReasoningAbortControllers.set(7, { abort: () => {} }); workModeReasoningLaneBusy.set(7, true); laneReasoningChainTail.set(7, "tail"); workModeReasoningPanelFollowUpQueue.set(7, ["q"]); workModeCompletedReasoningByLaneId["lane_x"] = { title: "x" }; focusedWorkModeLaneId = "lane_x"; return workModeReasoningAbortControllers.has(7); })()`, sandbox);
ok(beforeAbortHas === true, "pre-invalidate: abort controller present for tabIdx=7");
const replacedLaneId = vm.runInContext(`invalidateClosedReasoningLaneIdentity({ laneId: "lane_x", tabIndex: 7 })`, sandbox);
ok(typeof replacedLaneId === "string" && replacedLaneId.startsWith("lane_repl_7_"), "invalidate returns replaceStableLaneIdForPanelIndex output");
const after = vm.runInContext(`({
  abortHas: workModeReasoningAbortControllers.has(7),
  busyHas: workModeReasoningLaneBusy.has(7),
  chainHas: laneReasoningChainTail.has(7),
  queueHas: workModeReasoningPanelFollowUpQueue.has(7),
  laneRowKept: !!workModeCompletedReasoningByLaneId["lane_x"],
  focusedCleared: focusedWorkModeLaneId === "",
})`, sandbox);
eq(after, { abortHas: false, busyHas: false, chainHas: false, queueHas: false, laneRowKept: false, focusedCleared: true }, "all per-tabIndex state cleared + lane registry row deleted + focused lane cleared");

section("Suite N — app.js no longer declares the moved bindings");
const appSrc = fs.readFileSync(appJsPath, "utf8");
for (const name of [
  "MIN_REASONING_PANELS",
  "REASONING_RECENTLY_CLOSED_STACK_MAX",
  "REASONING_CLOSE_TURN_LOCK_MS",
  "_REASONING_CLOSE_COUNT_WORD_OUT",
  "recentlyClosedReasoningPanels",
  "_lastReasoningCloseLock",
  /* Stage 11 (2026-05-30) — close-command parser regex constants
   * moved from app.js to workmode/panels.js along with the parser
   * functions in Suite N's function loop below. */
  "REASONING_CLOSE_ORDINAL_WORDS",
  "REASONING_CLOSE_COUNT_WORDS",
  "_REASONING_CLOSE_NOISE_TAIL_RES",
  "_REASONING_CLOSE_NOISE_PREFIX_RES",
  /* Stage 12 (2026-05-31) — per-panel follow-up queue Map + cap moved
   * from app.js to workmode/panels.js along with the helpers below. */
  "workModeReasoningPanelFollowUpQueue",
  "REASONING_PANEL_QUEUE_MAX",
  /* Stage 20 / Patch A-4 (2026-05-31) — reasoning-tab constants moved
   * from app.js to workmode/panels.js so that panels.js (which loads
   * before app.js) owns its own constants instead of relying on the
   * shared global lexical env at call time. */
  "REASONING_TABS_DEFAULT",
  "REASONING_TABS_MAX",
  "REASONING_UNTITLED_TAB_NAME",
  "REASONING_TABS_STATE_STORAGE_KEY_PREFIX",
]) {
  const declRe = new RegExp(String.raw`^(let|const|var)\s+${name}\b`, "m");
  ok(!declRe.test(appSrc), `app.js no longer declares ${name}`);
}
for (const name of [
  "getWorkModeReasoningLaneLabel",
  "getWorkModeReasoningLaneId",
  "createReasoningLanePanel",
  "getReasoningScrollElByLane",
  "isGenericAutoRenamableReasoningPanelTitle",
  "getReasoningTabTopicLabel",
  "isDefaultWorkModeReasoningPanelLaneLabel",
  "renderReasoningTabStrip",
  "logReasoningPanelSelectDebug",
  "activateReasoningTab",
  "addReasoningTab",
  "logReasoningCloseDebug",
  "logReasoningClosePolishDebug",
  "_reasoningCloseLockKey",
  "_hasActiveReasoningCloseLock",
  "_setReasoningCloseLock",
  "_peekReasoningCloseLock",
  "_isGenericBlankReasoningPanelLabel",
  "_isBlankReasoningPanelElement",
  "snapshotReasoningLaneRegistryForDebug",
  "invalidateClosedReasoningLaneIdentity",
  "readPersistedReasoningPanelTitlesForDebug",
  "_normalizeBlankPanelNamesInOrder",
  "_pickActivePanelInfoAfterRefill",
  "getReasoningPanelOrder",
  "getReasoningTabTopicLabelSafe",
  "snapshotReasoningPanelForUndo",
  "pickReplacementActivePanelInfo",
  "refillReasoningPanelsToMinimum",
  "closeReasoningPanelsByVisualIndices",
  "closeReasoningTab",
  "_countWordOrNumber",
  "buildCloseReasoningPanelsVoiceReply",
  "isReasoningCloseVoiceSource",
  "logReasoningCloseConfirmationUiDebug",
  "renderReasoningCloseAssistantConfirmation",
  /* Stage 11 (2026-05-30) — close-command parser, ranker, executor,
   * and shortcut helper moved from app.js to workmode/panels.js. The
   * Stage-8 banner already listed every name below as "out of scope
   * for Stage 8 (will likely move with the routing module in a later
   * stage)". The voice-turn lifecycle helpers
   * (finalize/finishReasoningCloseVoiceUserTurn, etc.) remain in
   * app.js (asserted in Suite O below). */
  "_hasReasoningCloseSubject",
  "_explicitlyNonReasoningCloseSubject",
  "_parseReasoningCloseRange",
  "_parseReasoningCloseIndices",
  "_cleanCommandTextForClose",
  "_scoreCloseScopeRank",
  "_extractAllCloseSpans",
  "_pickStrongestCloseSpan",
  "parseCloseReasoningPanelsCommand",
  "findReasoningPanelIndicesByTitleQuery",
  "reopenLastClosedReasoningPanel",
  "executeCloseReasoningPanelsCommand",
  "maybeHandleCloseReasoningPanelShortcut",
  /* Stage 12 (2026-05-31) — per-panel follow-up queue UI/state
   * helpers moved from app.js to workmode/panels.js. The
   * `window.workModeReasoningPanelQueue = { ... }` debug-export
   * object moved with them. */
  "getReasoningPanelFollowUpQueueForIdx",
  "newReasoningPanelQueueItemId",
  "getReasoningPanelElementByLaneIdx",
  "renderReasoningPanelFollowUpQueueUi",
  "enqueueReasoningPanelFollowUp",
  "deleteReasoningPanelQueueItem",
  "editReasoningPanelQueueItem",
  "beginEditReasoningPanelQueueItem",
  "scheduleReasoningPanelFollowUpQueueDrain",
  "drainReasoningPanelFollowUpQueue",
  "clearReasoningPanelFollowUpQueueForIdx",
  /* Stage 20 / Patch A-4 (2026-05-31) — WORK MODE reasoning stream +
   * tab-title pipeline moved from app.js to workmode/panels.js. VERA
   * chat-state persistence (persistVeraChatState, restoreVeraChatState,
   * etc.) intentionally LEFT in app.js because it manages the main
   * conversation bubble store, not the reasoning stream. */
  "getReasoningTabsStateStorageKey",
  "getReasoningPanelCountToEnsure",
  "getReasoningPanelIndices",
  "syncReasoningLaneBusySlotsAfterDomChange",
  "ensureFixedReasoningLanePanels",
  "persistReasoningTabsState",
  "restoreReasoningTabsState",
  "getActiveReasoningScrollEl",
  "appendReasoningTurnMount",
  "toTitleCaseWord",
  "isBanalReasoningTopicLabel",
  "compactTopicPhrase",
  "keywordTopicFromText",
  "extractMarkdownBoldStandaloneTitle",
  "extractFirstTitleLikeMarkdownLine",
  "normalizeMarkdownLeadForHeadingExtract",
  "diagnoseLeadingMarkdownHeadingExtraction",
  "extractLeadingMarkdownHeadingAsLaneTitle",
  "logHeadingTitleExtractAttempt",
  "maybeSyncGenericLaneTitleFromMarkdown",
  "buildReasoningTopicLabel",
  "readPersistedReasoningTabSnapshotForLane",
  "reasoningTitleCandidateDebugLog",
  "reasoningTitleUpdateDebugLog",
  "reasoningLaneTitleSyncDebugLog",
  "reasoningLlmTitleQueueDecision",
  "setReasoningTabTopicFromFinal",
  "sanitizeLlmReasoningPanelTitle",
  "veraWorkModeBackendBasesInTryOrder",
  "fetchReasoningPanelTitleLlm",
  "heuristicReasoningPanelTitle",
  "shouldQueueLlmReasoningPanelTitle",
  "queueLlmReasoningPanelTitleAfterFirstCompletedTurn",
]) {
  const declRe = new RegExp(String.raw`^(async\s+)?function\s+${name}\b`, "m");
  ok(!declRe.test(appSrc), `app.js no longer declares function ${name}`);
}

section("Suite O — app.js still declares the intentionally-LEFT bindings");
/* Stage 11 (2026-05-30): parseCloseReasoningPanelsCommand,
 * executeCloseReasoningPanelsCommand, maybeHandleCloseReasoningPanelShortcut,
 * findReasoningPanelIndicesByTitleQuery, and reopenLastClosedReasoningPanel
 * moved from app.js to workmode/panels.js. They are now in Suite N's
 * no-longer-declared loop. The voice-turn lifecycle helpers below
 * (finalize/finish ReasoningCloseVoice*, getReasoningCloseAsrModeLabel,
 * getReasoningCloseMicStateLabel, getReasoningCloseActiveUserBubbleId)
 * REMAIN in app.js because they couple to the ASR finalize path and
 * continuous-listening restart. */
const leftBindings = [
  /^let\s+reasoningCloseVoiceLifecycleSeq\b/m,
  /^function\s+logReasoningCloseVoiceLifecycle\b/m,
  /^function\s+finalizeReasoningCloseVoiceUserTurn\b/m,
  /^function\s+finishReasoningCloseVoiceTurnAfterAssistant\b/m,
  /^function\s+getReasoningCloseAsrModeLabel\b/m,
  /^function\s+getReasoningCloseMicStateLabel\b/m,
  /^function\s+getReasoningCloseActiveUserBubbleId\b/m,
  /^function\s+wireReasoningTabStrip\b/m,
  /* Stage 20 / Patch A-4 (2026-05-31): ensureFixedReasoningLanePanels,
   * persistReasoningTabsState, restoreReasoningTabsState,
   * syncReasoningLaneBusySlotsAfterDomChange, REASONING_TABS_MAX,
   * REASONING_TABS_DEFAULT, REASONING_UNTITLED_TAB_NAME all moved to
   * workmode/panels.js — now asserted as absent in Suite N's "no
   * longer declares" loops above. */
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

section("Suite Q — workmode/panels.js parses as a classic script");
const panelsSrc = fs.readFileSync(panelsPath, "utf8");
ok(!/^\s*import\s/m.test(panelsSrc), "panels.js has no ESM import statements");
ok(!/^\s*export\s/m.test(panelsSrc), "panels.js has no ESM export statements");

section("Suite R — no top-level let/const initializer references an app.js-side identifier");
/* Why this suite exists:
 *
 *   Classic scripts share a single global lexical environment, but top-level
 *   `const X = Y;` evaluates Y *at script load time*. workmode/panels.js
 *   loads BEFORE app.js, so if any top-level initializer here references a
 *   binding that lives in app.js (e.g. `const MIN = REASONING_TABS_DEFAULT;`),
 *   the script throws ReferenceError at load. That throw aborts the rest of
 *   panels.js's top-level body, which silently leaves every subsequent
 *   let/const in TDZ — function declarations stay hoisted/callable, so the
 *   UI still boots and opens panels fine, but the first close/refill access
 *   to one of the dead consts (e.g. `recentlyClosedReasoningPanels`) throws
 *   "Cannot access ... before initialization" and the close mutation halts
 *   mid-flight. That's the exact regression that caused the "X click only
 *   visually closes after another click" report.
 *
 *   Function bodies are fine — bare identifiers there resolve at call time
 *   (which is always after app.js has finished loading), so this guard only
 *   inspects column-0 `const`/`let`/`var` declarations. */
const APP_JS_SIDE_IDENTIFIERS = new Set([
  /* Stage 20 / Patch A-4 (2026-05-31): REASONING_TABS_MAX,
   * REASONING_TABS_DEFAULT, REASONING_UNTITLED_TAB_NAME,
   * REASONING_TABS_STATE_STORAGE_KEY_PREFIX moved from app.js to
   * workmode/panels.js — declared at the top level of panels.js
   * itself, so they're no longer "app.js-side" identifiers and may
   * appear in panels.js top-level initializers without TDZ risk. */
  /* Lane-registry helpers left in app.js. */
  "ensureStableLaneIdForPanelIndex",
  "replaceStableLaneIdForPanelIndex",
  "allocateWorkModeStableLaneId",
  /* Reasoning streaming state left in app.js. */
  "workModeReasoningAbortControllers",
  "workModeReasoningLaneBusy",
  "laneReasoningChainTail",
  /* Stage 12 (2026-05-31): workModeReasoningPanelFollowUpQueue moved
   * from app.js to workmode/panels.js. No longer an app.js-side
   * identifier — declared at the top level of panels.js itself. */
  "workModeCompletedReasoningByLaneId",
  "workModeReasoningFinalStatusByLaneId",
  "activeWorkModeReasoningContext",
  "focusedWorkModeLaneId",
  "focusedWorkModeLaneAt",
  "workModeLastSubstantiveLaneIdx",
  "workModeLastSubstantiveUserText",
  /* Persistence / lookup helpers (Stage 20 / Patch A-4 (2026-05-31):
   * getReasoningTabsStateStorageKey, persistReasoningTabsState, and
   * syncReasoningLaneBusySlotsAfterDomChange all moved into
   * workmode/panels.js, so they may appear in panels.js top-level
   * initializers without TDZ risk). */
  "syncWorkModeReasoningCancelButton",
  "setFocusedWorkModeLaneFromIndex",
  /* Voice + lifecycle dependencies left in app.js. */
  "inputMuted",
  "appModePrefix",
  "isVeraWorkModeOn",
  "isWorkModeMuteEnabled",
  "addBubble",
  "enqueueAssistantTtsPlayback",
  "playWorkModeTtsOnlyPhrase",
  "setStatus",
  "listeningMode",
  "processing",
  "requestInFlight",
  "waveState",
  "voiceUxTurn",
  "finishReasoningCloseVoiceTurnAfterAssistant",
  "logReasoningCloseVoiceLifecycle",
]);

/* Walk every column-0 const/let/var declaration line and pull out
 * the RHS up to the terminating semicolon on the same line. Multiline
 * initializers (object literals, template strings spanning lines) are
 * conservatively included verbatim — false positives are easy to fix
 * by either inlining the value or wrapping access in a function. */
const topLevelDeclLines = [];
const declRe = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*?);\s*(?:\/\/.*)?$/gm;
let dm;
while ((dm = declRe.exec(panelsSrc)) !== null) {
  /* Only column-0 matches (i.e. true top-level declarations) — skip
   * declarations indented inside a function body. */
  const lineStart = panelsSrc.lastIndexOf("\n", dm.index) + 1;
  if (dm.index !== lineStart) continue;
  topLevelDeclLines.push({
    name: dm[1],
    rhs: dm[2],
    line: panelsSrc.slice(0, dm.index).split("\n").length,
  });
}

ok(topLevelDeclLines.length > 0, "static scan found at least one top-level let/const declaration");

for (const decl of topLevelDeclLines) {
  const idRe = /\b([A-Za-z_$][\w$]*)\b/g;
  const offenders = [];
  let mm;
  while ((mm = idRe.exec(decl.rhs)) !== null) {
    if (APP_JS_SIDE_IDENTIFIERS.has(mm[1])) {
      offenders.push(mm[1]);
    }
  }
  ok(
    offenders.length === 0,
    `top-level ${decl.name} (line ${decl.line}) does not reference any app.js-side identifier (offenders: ${offenders.join(", ") || "none"})`
  );
}

console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
