/* ============================================================================
 * __workmode_checklist_extraction_smoke.mjs
 *
 * Verifies the Stage 9 extraction of Work Mode checklist helpers from
 * app.js into workmode/checklist.js.
 *
 * This smoke focuses on the EXTRACTION itself:
 *
 *   1. workmode/checklist.js loads in a classic-script-like sandbox after
 *      utils/storage.js + an app.js stub for shared bindings (session
 *      helpers, mode probes, reasoning-panel accessors, etc.).
 *   2. All moved functions exist as function declarations + all moved
 *      const/let bindings exist with the correct initial values.
 *   3. Window aliases (window.__veraDebugSyncState, window.getChecklistDebugState)
 *      are attached and identity-match the bare identifiers.
 *   4. Pure helpers behave exactly as before:
 *        - _looksLikeChecklistCommand
 *        - _checklistWordOrDigitOrdinal
 *        - parseChecklistOrdinals
 *        - isWorkChecklistPlanShortcutIntent
 *        - isWorkChecklistSyncCommandIntent
 *        - normalizeChecklistLineText
 *        - buildChecklistProposalFromMarkdown
 *        - formatChecklistProposalText
 *        - parseChecklistProposalText
 *        - planSyncPreviewRows
 *        - commitNonCancelableAction +
 *          wasNonCancelableActionRecentlyCommitted
 *        - readChecklistItemsFromStorage / readChecklistItemsFromStorageSafe
 *          (round-trips against the in-memory localStorage stub)
 *   5. app.js no longer declares any of the moved bindings, but DOES
 *      still declare the intentionally-LEFT integration helpers
 *      (finalizeWorkChecklistSyncCommandTurn,
 *       maybeHandleWorkChecklistSyncShortcut, runWorkChecklistHelpPlan,
 *       maybeHandleWorkChecklistPlanShortcut,
 *       wireWorkModeChecklistAndComposer).
 *   6. index.html load order: checklist.js comes after workmode/panels.js
 *      and before app.js.
 *   7. workmode/checklist.js parses as a classic script (no ESM imports
 *      or exports).
 *
 * Run:  node tests/smoke/__workmode_checklist_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const checklistPath = path.join(repoRoot, "workmode", "checklist.js");
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    confirm: () => true,
    matchMedia: () => ({ matches: false }),
  };
  /* Minimal DOM stub. Real DOM-driven behavior (drag, render, etc.) is
     covered by manual tests in the browser; the smoke focuses on pure
     logic + storage + intent detection. */
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
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
    setTimeout,
    clearTimeout,
    HTMLElement: class HTMLElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLButtonElement: class HTMLButtonElement {},
    HTMLInputElement: class HTMLInputElement {},
    AbortController,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    CSS: { escape: (s) => String(s).replace(/["\\]/g, "") },
  });
  sandbox.globalThis = sandbox;
  for (const k of Object.keys(win)) sandbox[k] = win[k];

  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });

  /* App-stub: bindings workmode/checklist.js reaches for at call time via
     the shared classic-script global lexical env. Mirrors the names
     declared in app.js (session helpers, mode probes, reasoning-panel
     accessors). */
  vm.runInContext(
    `
    function getSessionId() { return "session_smoke"; }
    function authApiUrl(p) { return "https://example.invalid" + p; }
    function appModePrefix() { return "vera"; }
    function isVeraWorkModeOn() { return true; }
    function getActiveDomReasoningLaneId() { return ""; }
    function getReasoningPanelElementByLaneId(_laneId) { return null; }
    function getActiveReasoningScrollEl() { return null; }
    function getWorkModeLaneTitle(_laneId) { return ""; }
    function getWorkModeReasoningLaneId(_idx) { return ""; }
    function getReasoningTabTopicLabel(_idx) { return ""; }
    function getActiveReasoningLaneIndex() { return null; }
    function workModePlanningTimeInjectionPrefix() { return ""; }
    var workModeReasoningPanelGenerationState = new Map();
    var workModeReasoningLastSyncableMarkdownByLane = new Map();
    `,
    sandbox,
    { filename: "tests/smoke/__workmode_checklist_extraction_app_stub__" }
  );

  vm.runInContext(fs.readFileSync(checklistPath, "utf8"), sandbox, { filename: "workmode/checklist.js" });
  return sandbox;
}

/* ────────────────────────────────────────────────────────────────────── */

section("Suite A — module loads cleanly + window aliases attached");
let sandbox;
try {
  sandbox = buildLoadedSandbox();
  ok(true, "workmode/checklist.js evaluates in the sandbox");
} catch (e) {
  ok(false, `workmode/checklist.js evaluates in the sandbox — ${e && e.stack}`);
  process.exit(1);
}
ok(typeof sandbox.window.__veraDebugSyncState === "function", "window.__veraDebugSyncState attached");
ok(typeof sandbox.window.getChecklistDebugState === "function", "window.getChecklistDebugState attached (new Stage 9 accessor)");
ok(
  sandbox.window.__veraDebugSyncState === vm.runInContext("veraDebugSyncStateSnapshot", sandbox),
  "window.__veraDebugSyncState identity-matches veraDebugSyncStateSnapshot"
);
ok(
  sandbox.window.getChecklistDebugState === vm.runInContext("getChecklistDebugState", sandbox),
  "window.getChecklistDebugState identity-matches bare identifier"
);

section("Suite B — moved function/const declarations");
const declCheck = vm.runInContext(`({
  WORK_CHECKLIST_STORAGE_KEY,
  WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
  WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS,
  WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT,
  WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS,
  WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX,
  markWorkChecklistLocalMutation: typeof markWorkChecklistLocalMutation,
  readChecklistItemsFromStorage: typeof readChecklistItemsFromStorage,
  queueWorkChecklistSyncToServer: typeof queueWorkChecklistSyncToServer,
  syncWorkChecklistToServerNow: typeof syncWorkChecklistToServerNow,
  flushWorkChecklistSyncBeforeCommand: typeof flushWorkChecklistSyncBeforeCommand,
  hydrateWorkChecklistFromServer: typeof hydrateWorkChecklistFromServer,
  _looksLikeChecklistCommand: typeof _looksLikeChecklistCommand,
  CHECKLIST_ORDINAL_WORD_MAP_first: CHECKLIST_ORDINAL_WORD_MAP.first,
  CHECKLIST_ORDINAL_WORD_MAP_twelfth: CHECKLIST_ORDINAL_WORD_MAP.twelfth,
  _checklistWordOrDigitOrdinal: typeof _checklistWordOrDigitOrdinal,
  parseChecklistOrdinals: typeof parseChecklistOrdinals,
  _checklistDomState: typeof _checklistDomState,
  logChecklistIntentDebug: typeof logChecklistIntentDebug,
  detectChecklistActionIntent: typeof detectChecklistActionIntent,
  isLikelyWorkChecklistEditIntent: typeof isLikelyWorkChecklistEditIntent,
  createWorkChecklistDragHandle: typeof createWorkChecklistDragHandle,
  readChecklistItemsFromStorageSafe: typeof readChecklistItemsFromStorageSafe,
  writeChecklistItemsToStorageSafe: typeof writeChecklistItemsToStorageSafe,
  isChecklistDescendant: typeof isChecklistDescendant,
  applyChecklistNestingFromDrag: typeof applyChecklistNestingFromDrag,
  workChecklistInsertBeforeFromY: typeof workChecklistInsertBeforeFromY,
  persistWorkChecklistOrderFromDom: typeof persistWorkChecklistOrderFromDom,
  applyWorkChecklistCompletedCollapseFromStorage: typeof applyWorkChecklistCompletedCollapseFromStorage,
  wireWorkChecklistCompletedCollapse: typeof wireWorkChecklistCompletedCollapse,
  ensureWorkChecklistListDnD: typeof ensureWorkChecklistListDnD,
  normalizeWorkChecklistLeadingPlaceholderInStorage: typeof normalizeWorkChecklistLeadingPlaceholderInStorage,
  pruneInteriorEmptyOngoingItems: typeof pruneInteriorEmptyOngoingItems,
  ensureWorkChecklistTrailingEmptyOngoing: typeof ensureWorkChecklistTrailingEmptyOngoing,
  insertWorkChecklistEmptyOngoingAfter: typeof insertWorkChecklistEmptyOngoingAfter,
  loadWorkChecklistItems: typeof loadWorkChecklistItems,
  persistWorkChecklistToggle: typeof persistWorkChecklistToggle,
  persistWorkChecklistToggleWithSubtree: typeof persistWorkChecklistToggleWithSubtree,
  persistWorkChecklistUpdateText: typeof persistWorkChecklistUpdateText,
  persistWorkChecklistRemove: typeof persistWorkChecklistRemove,
  NON_CANCELABLE_AFTER_COMMIT_ACTIONS_size: NON_CANCELABLE_AFTER_COMMIT_ACTIONS.size,
  logChecklistActionCommitDebug: typeof logChecklistActionCommitDebug,
  commitNonCancelableAction: typeof commitNonCancelableAction,
  wasNonCancelableActionRecentlyCommitted: typeof wasNonCancelableActionRecentlyCommitted,
  planSyncPreviewRows: typeof planSyncPreviewRows,
  getPlanSyncPanelMetaForLane: typeof getPlanSyncPanelMetaForLane,
  logPlanSyncDebug: typeof logPlanSyncDebug,
  logSyncVoiceTurnDebug: typeof logSyncVoiceTurnDebug,
  veraDebugSyncStateSnapshot: typeof veraDebugSyncStateSnapshot,
  describePlanSyncActiveContext: typeof describePlanSyncActiveContext,
  collectWorkChecklistOngoingTexts: typeof collectWorkChecklistOngoingTexts,
  workChecklistHasAnyStoredItems: typeof workChecklistHasAnyStoredItems,
  syncWorkChecklistEraseButton: typeof syncWorkChecklistEraseButton,
  syncWorkChecklistHelpPlanButton: typeof syncWorkChecklistHelpPlanButton,
  planSyncPanelGenerationInfo: typeof planSyncPanelGenerationInfo,
  getActivePlanSyncBlockingState: typeof getActivePlanSyncBlockingState,
  scheduleSyncPlanButtonRefresh: typeof scheduleSyncPlanButtonRefresh,
  syncWorkChecklistSyncPlanButton: typeof syncWorkChecklistSyncPlanButton,
  getLatestWorkModeReasoningMarkdown: typeof getLatestWorkModeReasoningMarkdown,
  getLatestMarkdownInReasoningScroll: typeof getLatestMarkdownInReasoningScroll,
  isChecklistSyncHeadingText: typeof isChecklistSyncHeadingText,
  listItemsToChecklistMarkdown: typeof listItemsToChecklistMarkdown,
  renderedChecklistMarkdownFromPanel: typeof renderedChecklistMarkdownFromPanel,
  getWorkModeReasoningMarkdownCandidates: typeof getWorkModeReasoningMarkdownCandidates,
  getWorkChecklistSyncSourceCandidate: typeof getWorkChecklistSyncSourceCandidate,
  getWorkChecklistSyncSourceMarkdown: typeof getWorkChecklistSyncSourceMarkdown,
  normalizeChecklistLineText: typeof normalizeChecklistLineText,
  buildChecklistProposalFromMarkdown: typeof buildChecklistProposalFromMarkdown,
  formatChecklistProposalText: typeof formatChecklistProposalText,
  parseChecklistProposalText: typeof parseChecklistProposalText,
  setWorkChecklistSyncPreviewEditing: typeof setWorkChecklistSyncPreviewEditing,
  showWorkChecklistSyncPreview: typeof showWorkChecklistSyncPreview,
  hideWorkChecklistSyncPreview: typeof hideWorkChecklistSyncPreview,
  applyWorkChecklistSyncPreview: typeof applyWorkChecklistSyncPreview,
  eraseEntireWorkChecklist: typeof eraseEntireWorkChecklist,
  runWorkChecklistSyncFromLatestPlan: typeof runWorkChecklistSyncFromLatestPlan,
  flashWorkChecklistPlanHint: typeof flashWorkChecklistPlanHint,
  buildWorkChecklistHelpPlanUserMessage: typeof buildWorkChecklistHelpPlanUserMessage,
  isWorkChecklistPlanShortcutIntent: typeof isWorkChecklistPlanShortcutIntent,
  isWorkChecklistSyncCommandIntent: typeof isWorkChecklistSyncCommandIntent,
  queueWorkChecklistRowEnterAnimation: typeof queueWorkChecklistRowEnterAnimation,
  getChecklistDebugState: typeof getChecklistDebugState,
})`, sandbox);

ok(declCheck.WORK_CHECKLIST_STORAGE_KEY === "vera_wm_checklist_v1", "WORK_CHECKLIST_STORAGE_KEY === 'vera_wm_checklist_v1'");
ok(declCheck.WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY === "vera_wm_checklist_completed_collapsed_v1", "WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY preserved");
ok(declCheck.WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT === 5, "WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT === 5");
ok(declCheck.WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS === 12000, "WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS === 12000");
ok(declCheck.WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX === 26, "WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX === 26");
ok(declCheck.CHECKLIST_ORDINAL_WORD_MAP_first === 1, "CHECKLIST_ORDINAL_WORD_MAP.first === 1");
ok(declCheck.CHECKLIST_ORDINAL_WORD_MAP_twelfth === 12, "CHECKLIST_ORDINAL_WORD_MAP.twelfth === 12");
ok(declCheck.NON_CANCELABLE_AFTER_COMMIT_ACTIONS_size === 6, "NON_CANCELABLE_AFTER_COMMIT_ACTIONS has 6 entries");

section("Suite R — checklist plan hierarchy + 5 main-item limit");
function setChecklistItemsForPlan(items) {
  vm.runInContext(
    `localStorage.setItem(getAnonymousChecklistStorageKey(), ${JSON.stringify(
      JSON.stringify({
        auth_mode: "anonymous",
        session_id: "session_smoke",
        saved_at: Date.now(),
        items,
      })
    )});`,
    sandbox
  );
}
setChecklistItemsForPlan([
  { id: "m1", text: "english homework", done: false, parent_id: null },
  { id: "s1", text: "essay about odyssey", done: false, parent_id: "m1" },
]);
const planA = vm.runInContext("buildChecklistPlanHierarchyFromStorage()", sandbox);
eq(planA.main_count, 1, "parent/subitem → main_count = 1");
eq(planA.subitem_count, 1, "parent/subitem → subitem_count = 1");
const planAMsg = vm.runInContext(
  `buildWorkChecklistHelpPlanUserMessage(${JSON.stringify(planA)})`,
  sandbox
);
ok(planAMsg.includes("english homework"), "plan prompt includes main task");
ok(planAMsg.includes("essay about odyssey"), "plan prompt includes sub-detail as bullet");
ok(!/1\. english homework[\s\S]*2\. essay about odyssey/.test(planAMsg), "subitem not second numbered main");

setChecklistItemsForPlan([
  { id: "m1", text: "english homework", done: false, parent_id: null },
  { id: "s1", text: "essay about odyssey", done: false, parent_id: "m1" },
  { id: "m2", text: "physics homework", done: false, parent_id: null },
  { id: "s2", text: "chapter 5 problems", done: false, parent_id: "m2" },
]);
const planB = vm.runInContext("buildChecklistPlanHierarchyFromStorage()", sandbox);
eq(planB.main_count, 2, "two main items with subdetails");
eq(planB.subitem_count, 2, "two subitems total");

setChecklistItemsForPlan(
  Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    text: `task ${i + 1}`,
    done: false,
    parent_id: null,
  }))
);
ok(vm.runInContext("validateChecklistPlanRequest().ok", sandbox), "five main items → plan allowed");

setChecklistItemsForPlan(
  Array.from({ length: 6 }, (_, i) => ({
    id: `m${i}`,
    text: `task ${i + 1}`,
    done: false,
    parent_id: null,
  }))
);
const planD = vm.runInContext("validateChecklistPlanRequest()", sandbox);
ok(!planD.ok, "six main items → blocked");
eq(planD.reason, "too_many_main_items", "six main items blocked reason");

setChecklistItemsForPlan([
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `m${i}`,
    text: `main ${i + 1}`,
    done: false,
    parent_id: null,
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    text: `sub ${i + 1}`,
    done: false,
    parent_id: `m${i % 4}`,
  })),
]);
const planE = vm.runInContext("validateChecklistPlanRequest()", sandbox);
ok(planE.ok, "four mains + ten subitems → allowed");
eq(planE.context.main_count, 4, "four mains + subs → main_count 4");

setChecklistItemsForPlan([
  { id: "m1", text: "english homework", done: false, parent_id: null },
  { id: "s1", text: "essay about odyssey", done: false, parent_id: "m1" },
]);
eq(vm.runInContext("collectWorkChecklistOngoingTexts()", sandbox), ["english homework"], "collectWorkChecklistOngoingTexts is main-only");

const expectedFns = [
  "markWorkChecklistLocalMutation",
  "readChecklistItemsFromStorage",
  "queueWorkChecklistSyncToServer",
  "syncWorkChecklistToServerNow",
  "flushWorkChecklistSyncBeforeCommand",
  "hydrateWorkChecklistFromServer",
  "_looksLikeChecklistCommand",
  "_checklistWordOrDigitOrdinal",
  "parseChecklistOrdinals",
  "_checklistDomState",
  "logChecklistIntentDebug",
  "detectChecklistActionIntent",
  "isLikelyWorkChecklistEditIntent",
  "createWorkChecklistDragHandle",
  "readChecklistItemsFromStorageSafe",
  "writeChecklistItemsToStorageSafe",
  "isChecklistDescendant",
  "applyChecklistNestingFromDrag",
  "workChecklistInsertBeforeFromY",
  "persistWorkChecklistOrderFromDom",
  "applyWorkChecklistCompletedCollapseFromStorage",
  "wireWorkChecklistCompletedCollapse",
  "ensureWorkChecklistListDnD",
  "normalizeWorkChecklistLeadingPlaceholderInStorage",
  "pruneInteriorEmptyOngoingItems",
  "ensureWorkChecklistTrailingEmptyOngoing",
  "insertWorkChecklistEmptyOngoingAfter",
  "loadWorkChecklistItems",
  "persistWorkChecklistToggle",
  "persistWorkChecklistToggleWithSubtree",
  "persistWorkChecklistUpdateText",
  "persistWorkChecklistRemove",
  "logChecklistActionCommitDebug",
  "commitNonCancelableAction",
  "wasNonCancelableActionRecentlyCommitted",
  "planSyncPreviewRows",
  "getPlanSyncPanelMetaForLane",
  "logPlanSyncDebug",
  "logSyncVoiceTurnDebug",
  "veraDebugSyncStateSnapshot",
  "describePlanSyncActiveContext",
  "collectWorkChecklistOngoingTexts",
  "workChecklistHasAnyStoredItems",
  "syncWorkChecklistEraseButton",
  "syncWorkChecklistHelpPlanButton",
  "planSyncPanelGenerationInfo",
  "getActivePlanSyncBlockingState",
  "scheduleSyncPlanButtonRefresh",
  "syncWorkChecklistSyncPlanButton",
  "getLatestWorkModeReasoningMarkdown",
  "getLatestMarkdownInReasoningScroll",
  "isChecklistSyncHeadingText",
  "listItemsToChecklistMarkdown",
  "renderedChecklistMarkdownFromPanel",
  "getWorkModeReasoningMarkdownCandidates",
  "getWorkChecklistSyncSourceCandidate",
  "getWorkChecklistSyncSourceMarkdown",
  "normalizeChecklistLineText",
  "buildChecklistProposalFromMarkdown",
  "formatChecklistProposalText",
  "parseChecklistProposalText",
  "setWorkChecklistSyncPreviewEditing",
  "showWorkChecklistSyncPreview",
  "hideWorkChecklistSyncPreview",
  "applyWorkChecklistSyncPreview",
  "eraseEntireWorkChecklist",
  "runWorkChecklistSyncFromLatestPlan",
  "flashWorkChecklistPlanHint",
  "buildWorkChecklistHelpPlanUserMessage",
  "isWorkChecklistPlanShortcutIntent",
  "isWorkChecklistSyncCommandIntent",
  "queueWorkChecklistRowEnterAnimation",
  "getChecklistDebugState",
];
for (const fn of expectedFns) {
  ok(declCheck[fn] === "function", `${fn} is function (got ${declCheck[fn]})`);
}

section("Suite C — _looksLikeChecklistCommand");
const llcc = (s) => vm.runInContext(`_looksLikeChecklistCommand(${JSON.stringify(s)})`, sandbox);
eq(llcc("remove the first item"), true, "'remove the first item' → true");
eq(llcc("delete second task"), true, "'delete second task' → true");
eq(llcc("uncheck the first checklist"), true, "'uncheck the first checklist' → true");
eq(llcc("remove items 1 and 3"), true, "'remove items 1 and 3' → true");
eq(llcc("delete items 2"), true, "'delete items 2' → true");
eq(llcc("close panel"), false, "'close panel' → false");
eq(llcc("hello vera"), false, "'hello vera' → false");
eq(llcc(""), false, "empty string → false");
eq(llcc(null), false, "null → false");

section("Suite D — _checklistWordOrDigitOrdinal");
const wd = (t) => vm.runInContext(`_checklistWordOrDigitOrdinal(${JSON.stringify(t)})`, sandbox);
eq(wd("first"), 1, "'first' → 1");
eq(wd("third"), 3, "'third' → 3");
eq(wd("twelfth"), 12, "'twelfth' → 12");
eq(wd("1"), 1, "'1' → 1");
eq(wd("3rd"), 3, "'3rd' → 3");
eq(wd("21st"), 21, "'21st' → 21");
eq(wd("0"), null, "'0' → null");
eq(wd(""), null, "empty → null");
eq(wd("hello"), null, "'hello' → null");

section("Suite E — parseChecklistOrdinals");
const pco = (t) => vm.runInContext(`parseChecklistOrdinals(${JSON.stringify(t)})`, sandbox);
eq(pco("remove first and third item"), [1, 3], "'first and third item' → [1,3]");
eq(pco("first, third, and fifth items"), [1, 3, 5], "'first, third, and fifth items' → [1,3,5]");
eq(pco("items 1 and 3"), [1, 3], "'items 1 and 3' → [1,3]");
eq(pco("delete items 2 and 4"), [2, 4], "'delete items 2 and 4' → [2,4]");
eq(pco("remove the first through third"), [1, 2, 3], "'first through third' → [1,2,3]");
eq(pco("remove item 2"), [2], "'remove item 2' → [2]");
eq(pco("just random text"), [], "no ordinals → []");

section("Suite F — isWorkChecklistPlanShortcutIntent");
const wpi = (t) => vm.runInContext(`isWorkChecklistPlanShortcutIntent(${JSON.stringify(t)})`, sandbox);
eq(wpi("help me plan my tasks"), true, "'help me plan my tasks' → true");
eq(wpi("can you help me plan my checklist"), true, "'can you help me plan my checklist' → true");
eq(wpi("plan the checklist"), true, "'plan the checklist' → true");
eq(wpi("plan my to-do list"), true, "'plan my to-do list' → true");
eq(wpi("plan a roadmap"), false, "'plan a roadmap' (no checklist noun) → false");
eq(wpi("help me with the essay"), false, "'help me with the essay' → false");
eq(wpi(""), false, "empty → false");

section("Suite G — isWorkChecklistSyncCommandIntent");
const wsi = (t) => vm.runInContext(`isWorkChecklistSyncCommandIntent(${JSON.stringify(t)})`, sandbox);
eq(wsi("sync"), true, "'sync' → true");
eq(wsi("sync that"), true, "'sync that' → true");
eq(wsi("hey vera sync"), true, "'hey vera sync' → true");
eq(wsi("sync the plan"), true, "'sync the plan' → true");
eq(wsi("sync the checklist"), true, "'sync the checklist' → true");
eq(wsi("synchronize my checklist"), true, "'synchronize my checklist' → true");
eq(wsi("apply that to my checklist"), true, "'apply that to my checklist' → true");
eq(wsi("create a checklist from the plan"), true, "'create a checklist from the plan' → true");
eq(wsi("hello vera"), false, "'hello vera' → false");
eq(wsi("sing it"), false, "'sing it' → false");

section("Suite H — normalizeChecklistLineText");
const ncl = (t) => vm.runInContext(`normalizeChecklistLineText(${JSON.stringify(t)})`, sandbox);
eq(ncl("  hello   world  "), "hello world", "collapse whitespace");
eq(ncl("**bold text**"), "bold text", "strip bold markers");
eq(ncl("*italic text*"), "italic text", "strip italic markers");
eq(ncl("`code text`"), "code text", "strip inline-code markers");
eq(ncl("[Link](http://x)"), "Link", "strip markdown link, keep label only");
eq(ncl(""), "", "empty → empty");

section("Suite I — buildChecklistProposalFromMarkdown + parseChecklistProposalText round-trip");
const md = "## SYNC CHECKLIST\n- [9:00-9:30]: Outline\n  - Draft intro\n  - Note key points\n- [9:30-10:30]: Write body\n";
const rows = vm.runInContext(`buildChecklistProposalFromMarkdown(${JSON.stringify(md)})`, sandbox);
ok(Array.isArray(rows), "buildChecklistProposalFromMarkdown returns an array");
ok(rows.length >= 4, `proposal has at least 4 rows (got ${rows.length})`);
ok(rows[0] && rows[0].depth === 0 && rows[0].text.startsWith("[9:00-9:30]"), "first row is depth=0, [9:00-9:30] task");
ok(rows.some((r) => r.depth === 1 && r.text === "Draft intro"), "contains 'Draft intro' as depth=1 sub-item");

const proposalText = vm.runInContext(`formatChecklistProposalText(${JSON.stringify(rows)})`, sandbox);
ok(typeof proposalText === "string" && proposalText.includes("- [9:00-9:30]: Outline"), "formatChecklistProposalText keeps top-level format");
ok(proposalText.includes("  - Draft intro"), "formatChecklistProposalText keeps sub-item indentation");

const parsed = vm.runInContext(`parseChecklistProposalText(${JSON.stringify(proposalText)})`, sandbox);
ok(Array.isArray(parsed) && parsed.length >= rows.length, "parseChecklistProposalText round-trips");
ok(parsed[0] && parsed[0].parent_id === null && parsed[0].text.startsWith("[9:00-9:30]"), "parsed[0] has parent_id=null");
const child = parsed.find((p) => p.text === "Draft intro");
ok(child && child.parent_id != null, "child item 'Draft intro' has non-null parent_id");
const lastRow = parsed[parsed.length - 1];
ok(lastRow && lastRow.text === "" && lastRow.done === false, "trailing row is an empty placeholder");

section("Suite J — planSyncPreviewRows");
const psp = vm.runInContext(`planSyncPreviewRows([{text:"A"},{text:" B "},{text:""},{text:"C"},{text:"D"},{text:"E"},{text:"F"}], 5)`, sandbox);
/* slice(0,5) first, then trim/filter — so the blank slot at index 2
 * is dropped after the cap, yielding 4 non-blank labels. */
eq(psp, ["A", "B", "C", "D"], "planSyncPreviewRows caps to limit (post-slice trim+filter)");
eq(vm.runInContext(`planSyncPreviewRows(null)`, sandbox), [], "planSyncPreviewRows(null) === []");
eq(vm.runInContext(`planSyncPreviewRows([{text:"X"},{text:"Y"},{text:"Z"}])`, sandbox), ["X", "Y", "Z"], "planSyncPreviewRows default limit returns all under cap");

section("Suite K — commitNonCancelableAction + wasNonCancelableActionRecentlyCommitted");
const record = vm.runInContext(`commitNonCancelableAction("sync_checklist", { items_inserted: 3 })`, sandbox);
ok(record && record.action_type === "sync_checklist", "commit returns record for known action");
ok(vm.runInContext(`wasNonCancelableActionRecentlyCommitted()`, sandbox) === true, "was-recently-committed === true immediately after commit");
ok(vm.runInContext(`wasNonCancelableActionRecentlyCommitted({ withinMs: 0 })`, sandbox) === false, "was-recently-committed false with windowMs=0");
const rejected = vm.runInContext(`commitNonCancelableAction("not_a_known_action")`, sandbox);
eq(rejected, null, "commitNonCancelableAction rejects unknown action types");

section("Suite L — readChecklistItemsFromStorage round-trip");
vm.runInContext(`localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify([{ id: "a", text: "Task A", done: false, parent_id: null }, { id: "b", text: "Task B", done: true, parent_id: null }]));`, sandbox);
const stored = vm.runInContext(`readChecklistItemsFromStorage()`, sandbox);
ok(Array.isArray(stored) && stored.length === 2, "readChecklistItemsFromStorage returns 2 items");
ok(stored[0].text === "Task A" && stored[0].done === false, "first item round-trips");
ok(stored[1].text === "Task B" && stored[1].done === true, "second item round-trips");

const safe = vm.runInContext(`readChecklistItemsFromStorageSafe()`, sandbox);
ok(Array.isArray(safe) && safe.length === 2, "readChecklistItemsFromStorageSafe returns 2 items");

vm.runInContext(`localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, "not valid json");`, sandbox);
eq(vm.runInContext(`readChecklistItemsFromStorage()`, sandbox), [], "readChecklistItemsFromStorage returns [] on invalid JSON");
eq(vm.runInContext(`readChecklistItemsFromStorageSafe()`, sandbox), [], "readChecklistItemsFromStorageSafe returns [] on invalid JSON");

section("Suite M — getChecklistDebugState shape");
vm.runInContext(`localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify([{ id: "a", text: "X", done: false, parent_id: null }, { id: "b", text: "Y", done: true, parent_id: null }, { id: "c", text: "", done: false, parent_id: null }]));`, sandbox);
const dbg = vm.runInContext(`getChecklistDebugState()`, sandbox);
ok(dbg && typeof dbg === "object", "getChecklistDebugState returns object");
ok(dbg.storage_key === "vera_wm_checklist_v1", "storage_key preserved");
ok(dbg.completed_collapsed_key === "vera_wm_checklist_completed_collapsed_v1", "completed_collapsed_key preserved");
ok(dbg.help_plan_max_main_items === 5, "help_plan_max_main_items === 5");
ok(dbg.sync_preview_max_chars === 12000, "sync_preview_max_chars === 12000");
ok(dbg.subitem_indent_threshold_px === 26, "subitem_indent_threshold_px === 26");
ok(dbg.stored_item_count === 3, `stored_item_count === 3 (got ${dbg.stored_item_count})`);
ok(dbg.non_blank_stored_count === 2, `non_blank_stored_count === 2 (got ${dbg.non_blank_stored_count})`);
ok(dbg.completed_stored_count === 1, `completed_stored_count === 1 (got ${dbg.completed_stored_count})`);
ok(typeof dbg.sync_timer_active === "boolean", "sync_timer_active is boolean");
ok(typeof dbg.local_mutation_version === "number", "local_mutation_version is number");
ok(Array.isArray(dbg.non_cancelable_after_commit_actions) && dbg.non_cancelable_after_commit_actions.length === 6, "non_cancelable_after_commit_actions is array length 6");

section("Suite N — app.js no longer declares the moved bindings");
const appSrc = fs.readFileSync(appJsPath, "utf8");
for (const name of [
  "WORK_CHECKLIST_STORAGE_KEY",
  "WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY",
  "WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS",
  "WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS",
  "WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX",
  "CHECKLIST_ORDINAL_WORD_MAP",
  "CHECKLIST_ORDINAL_WORD_RE_FRAG",
  "CHECKLIST_REMOVAL_VERB_RE",
  "CHECKLIST_ADD_VERB_RE",
  "CHECKLIST_COMPLETE_VERB_RE",
  "CHECKLIST_UPDATE_VERB_RE",
  "CHECKLIST_NOUN_RE",
  "CHECKLIST_NON_OBJECT_NOUN_RE",
  "CHECKLIST_WHOLE_SECTION_RE",
  "CHECKLIST_SUB_ITEM_RE",
  "NON_CANCELABLE_AFTER_COMMIT_ACTIONS",
  "workChecklistDragSession",
  "workChecklistSyncTimer",
  "workChecklistHydrationPromise",
  "workChecklistLocalMutationVersion",
  "workChecklistSyncInFlight",
  "workChecklistSyncPreviewEditing",
  "workChecklistSyncPlanVersion",
  "workChecklistSyncConsumedPlanVersion",
  "workChecklistSyncPendingMarkdown",
  "workChecklistSyncPendingPlanMeta",
  "workChecklistSyncCommandSeq",
  "activeWorkChecklistSyncCommand",
  "lastCompletedWorkChecklistSyncCommandTurn",
  "lastCommittedNonCancelableAction",
  "workChecklistPlanHintTimer",
  "workChecklistPlanRequestInFlight",
  "__syncPlanButtonRefreshTimer",
]) {
  const declRe = new RegExp(String.raw`^(let|const|var)\s+${name}\b`, "m");
  ok(!declRe.test(appSrc), `app.js no longer declares ${name}`);
}
for (const name of [
  "markWorkChecklistLocalMutation",
  "readChecklistItemsFromStorage",
  "queueWorkChecklistSyncToServer",
  "syncWorkChecklistToServerNow",
  "flushWorkChecklistSyncBeforeCommand",
  "hydrateWorkChecklistFromServer",
  "_looksLikeChecklistCommand",
  "_checklistWordOrDigitOrdinal",
  "parseChecklistOrdinals",
  "_checklistDomState",
  "logChecklistIntentDebug",
  "detectChecklistActionIntent",
  "isLikelyWorkChecklistEditIntent",
  "createWorkChecklistDragHandle",
  "readChecklistItemsFromStorageSafe",
  "writeChecklistItemsToStorageSafe",
  "isChecklistDescendant",
  "applyChecklistNestingFromDrag",
  "workChecklistInsertBeforeFromY",
  "persistWorkChecklistOrderFromDom",
  "applyWorkChecklistCompletedCollapseFromStorage",
  "wireWorkChecklistCompletedCollapse",
  "ensureWorkChecklistListDnD",
  "normalizeWorkChecklistLeadingPlaceholderInStorage",
  "pruneInteriorEmptyOngoingItems",
  "ensureWorkChecklistTrailingEmptyOngoing",
  "insertWorkChecklistEmptyOngoingAfter",
  "loadWorkChecklistItems",
  "persistWorkChecklistToggle",
  "persistWorkChecklistToggleWithSubtree",
  "persistWorkChecklistUpdateText",
  "persistWorkChecklistRemove",
  "logChecklistActionCommitDebug",
  "commitNonCancelableAction",
  "wasNonCancelableActionRecentlyCommitted",
  "planSyncPreviewRows",
  "getPlanSyncPanelMetaForLane",
  "logPlanSyncDebug",
  "logSyncVoiceTurnDebug",
  "veraDebugSyncStateSnapshot",
  "describePlanSyncActiveContext",
  "collectWorkChecklistOngoingTexts",
  "workChecklistHasAnyStoredItems",
  "syncWorkChecklistEraseButton",
  "syncWorkChecklistHelpPlanButton",
  "planSyncPanelGenerationInfo",
  "getActivePlanSyncBlockingState",
  "scheduleSyncPlanButtonRefresh",
  "syncWorkChecklistSyncPlanButton",
  "getLatestWorkModeReasoningMarkdown",
  "getLatestMarkdownInReasoningScroll",
  "isChecklistSyncHeadingText",
  "listItemsToChecklistMarkdown",
  "renderedChecklistMarkdownFromPanel",
  "getWorkModeReasoningMarkdownCandidates",
  "getWorkChecklistSyncSourceCandidate",
  "getWorkChecklistSyncSourceMarkdown",
  "normalizeChecklistLineText",
  "buildChecklistProposalFromMarkdown",
  "formatChecklistProposalText",
  "parseChecklistProposalText",
  "setWorkChecklistSyncPreviewEditing",
  "showWorkChecklistSyncPreview",
  "hideWorkChecklistSyncPreview",
  "applyWorkChecklistSyncPreview",
  "eraseEntireWorkChecklist",
  "runWorkChecklistSyncFromLatestPlan",
  "flashWorkChecklistPlanHint",
  "buildWorkChecklistHelpPlanUserMessage",
  "buildChecklistPlanHierarchyFromStorage",
  "validateChecklistPlanRequest",
  "getChecklistPlanLimitMessage",
  "isWorkChecklistPlanShortcutIntent",
  "isWorkChecklistSyncCommandIntent",
  "queueWorkChecklistRowEnterAnimation",
]) {
  const declRe = new RegExp(String.raw`^(async\s+)?function\s+${name}\b`, "m");
  ok(!declRe.test(appSrc), `app.js no longer declares function ${name}`);
}

section("Suite O — app.js still declares the intentionally-LEFT integration helpers");
const leftBindings = [
  /^function\s+finalizeWorkChecklistSyncCommandTurn\b/m,
  /^async\s+function\s+maybeHandleWorkChecklistSyncShortcut\b/m,
  /^async\s+function\s+runWorkChecklistHelpPlan\b/m,
  /^async\s+function\s+maybeHandleWorkChecklistPlanShortcut\b/m,
  /^function\s+wireWorkModeChecklistAndComposer\b/m,
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

section("Suite Q — workmode/checklist.js parses as a classic script");
const checklistSrc = fs.readFileSync(checklistPath, "utf8");
ok(!/^\s*import\s/m.test(checklistSrc), "checklist.js has no ESM import statements");
ok(!/^\s*export\s/m.test(checklistSrc), "checklist.js has no ESM export statements");

console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
