/* ============================================================================
 * __reasoning_destination_after_open_smoke.mjs  (2026-05-28)
 *
 * Bug guard: "After opening a new reasoning panel (voice / typed /
 * + button), the NEXT reasoning request must stream into the newly
 * opened/selected panel — not the previous active panel."
 *
 * The pre-fix behaviour was:
 *   - addReasoningTab() set `.is-active` on the new panel
 *   - but did NOT update `focusedWorkModeLaneId`
 *   - getActiveDomReasoningLaneId() prefers focusedWorkModeLaneId
 *   - so createWorkModeFrozenTurnContext() captured the STALE lane
 *   - and the next reasoning request streamed into the previous panel
 *
 * The fix added in workmode/panels.js + app.js:
 *   - addReasoningTab(opts) calls setFocusedWorkModeLaneFromIndex(newIdx)
 *   - addReasoningTab(opts) sets a "recentlyOpenedReasoningPanel" flag
 *     that biases the next reasoning destination resolver
 *   - the flag is one-shot: consumed by first reasoning submission,
 *     cleared by manual tab switch or explicit panel reference,
 *     auto-expires after RECENTLY_OPENED_REASONING_PANEL_TTL_MS
 *
 * This smoke verifies all of those invariants in a sandboxed
 * classic-script env with a minimal but functional DOM stub.
 *
 * Run:  node tests/smoke/__reasoning_destination_after_open_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const panelsPath = path.join(repoRoot, "workmode", "panels.js");

let pass = 0;
let fail = 0;
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

/* ------------------------------------------------------------------ *
 *  Tiny functional DOM stub.
 *
 *  addReasoningTab() only needs:
 *    - document.getElementById("vera-reasoning-tab-panels") → root
 *    - root.querySelectorAll(".vera-reasoning-tab-panel") → []
 *    - document.createElement("div") with classList + dataset + setAttribute + appendChild + innerHTML
 *    - root.appendChild(panel)
 *  renderReasoningTabStrip() needs:
 *    - document.getElementById("vera-reasoning-tabs") → tabsEl OR null
 *    - document.getElementById("vera-reasoning-tab-add") → addBtn OR null
 *  Our stub keeps a registry of nodes by id and supports basic
 *  attribute-selector queries used by addReasoningTab + the
 *  recently-opened helpers.
 * ------------------------------------------------------------------ */
function buildDom() {
  const idRegistry = new Map();

  function makeEl(tag) {
    const el = {
      tagName: String(tag || "").toUpperCase(),
      _tag: String(tag || "").toLowerCase(),
      _className: "",
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); el._syncClassNameFromSet(); },
        remove(c) { this._set.delete(c); el._syncClassNameFromSet(); },
        toggle(c, force) {
          if (force === true) this._set.add(c);
          else if (force === false) this._set.delete(c);
          else if (this._set.has(c)) this._set.delete(c);
          else this._set.add(c);
          el._syncClassNameFromSet();
        },
        contains(c) { return this._set.has(c); },
      },
      _syncClassNameFromSet() {
        this._className = [...this.classList._set].join(" ");
      },
      _syncSetFromClassName(s) {
        this.classList._set = new Set(String(s || "").trim().split(/\s+/).filter(Boolean));
      },
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      parentNode: null,
      hidden: false,
      innerHTML: "",
      id: "",
      appendChild(c) {
        if (c.parentNode) {
          const old = c.parentNode;
          old.children = old.children.filter((x) => x !== c);
        }
        this.children.push(c);
        c.parentNode = this;
        if (c.id) idRegistry.set(c.id, c);
        for (const desc of _walkAll(c)) {
          if (desc.id) idRegistry.set(desc.id, desc);
        }
        return c;
      },
      replaceChildren() {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c);
        c.parentNode = null;
        return c;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
        if (k === "id") {
          this.id = String(v);
          idRegistry.set(this.id, this);
        }
      },
      getAttribute(k) { return this.attributes[k]; },
      querySelector(sel) {
        const all = this.querySelectorAll(sel);
        return all.length ? all[0] : null;
      },
      querySelectorAll(sel) {
        const matches = [];
        for (const desc of _walkAll(this)) {
          if (desc === this) continue;
          if (_selectorMatches(desc, sel)) matches.push(desc);
        }
        return matches;
      },
      closest(sel) {
        let n = this;
        while (n) {
          if (_selectorMatches(n, sel)) return n;
          n = n.parentNode;
        }
        return null;
      },
    };
    /* `id` setter syncs the registry. */
    Object.defineProperty(el, "id", {
      get() { return el._id || ""; },
      set(v) {
        el._id = String(v || "");
        if (el._id) idRegistry.set(el._id, el);
      },
    });
    /* `className` setter syncs the classList. */
    Object.defineProperty(el, "className", {
      get() { return el._className; },
      set(v) {
        el._className = String(v || "");
        el._syncSetFromClassName(el._className);
      },
    });
    return el;
  }

  function* _walkAll(root) {
    yield root;
    for (const c of root.children) {
      for (const d of _walkAll(c)) yield d;
    }
  }

  function _selectorMatches(el, sel) {
    /* Support a small subset:
       - tag        → "div"
       - .class     → ".vera-reasoning-tab-panel"
       - [attr="v"] → '[data-tab-index="2"]'
       - combos     → '.vera-reasoning-tab-panel[data-tab-index="0"]'
       - descendant → '#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="0"]'
       For descendant selectors we split on spaces and only check the
       LAST segment against el (we are already iterating from a root).
     */
    const s = String(sel || "").trim();
    if (!s) return false;
    const parts = s.split(/\s+/);
    const last = parts[parts.length - 1];
    return _atomMatches(el, last);
  }

  function _atomMatches(el, atom) {
    /* split into tag/.class/[attr] tokens. */
    const tokens = atom.match(/([.#]?[\w-]+|\[[^\]]+\])/g) || [];
    for (const tok of tokens) {
      if (tok.startsWith(".")) {
        if (!el.classList.contains(tok.slice(1))) return false;
      } else if (tok.startsWith("#")) {
        if (el.id !== tok.slice(1)) return false;
      } else if (tok.startsWith("[")) {
        const m = tok.match(/\[([\w-]+)\s*=\s*"([^"]*)"\]/);
        if (!m) return false;
        const k = m[1];
        const v = m[2];
        const dsKey = k.startsWith("data-")
          ? k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
          : null;
        const actual = dsKey ? el.dataset[dsKey] : el.attributes[k];
        if (String(actual) !== v) return false;
      } else {
        if (el._tag !== tok.toLowerCase()) return false;
      }
    }
    return true;
  }

  /* Bootstrap: a root with the panelsRoot id and an empty initial set
     of panels. We do NOT create the tabsEl, so renderReasoningTabStrip
     no-ops harmlessly. */
  const panelsRoot = makeEl("div");
  panelsRoot.id = "vera-reasoning-tab-panels";

  const document = {
    _registry: idRegistry,
    getElementById(id) { return idRegistry.get(String(id)) || null; },
    createElement(tag) { return makeEl(tag); },
    querySelector(sel) { return panelsRoot.querySelector(sel); },
    querySelectorAll(sel) { return panelsRoot.querySelectorAll(sel); },
  };

  return { document, panelsRoot };
}

function buildLoadedSandbox(domSeed) {
  const cConsole = {
    log: () => {}, info: () => {}, debug: () => {},
    warn: () => {}, error: () => {},
  };
  const win = {
    isSecureContext: true,
    setTimeout, clearTimeout,
  };
  const { document, panelsRoot } = domSeed;

  let focusedFromIndexCalls = [];

  const sandbox = vm.createContext({
    console: cConsole,
    window: win,
    document,
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 12345.6 },
    setTimeout, clearTimeout,
    HTMLElement: class HTMLElement {},
    AbortController,
    __focusedFromIndexCalls: focusedFromIndexCalls,
  });
  sandbox.globalThis = sandbox;
  for (const k of Object.keys(win)) sandbox[k] = win[k];

  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });

  vm.runInContext(
    `
    /* Stage 20 / Patch A-4 (2026-05-31): REASONING_TABS_DEFAULT,
     * REASONING_TABS_MAX, REASONING_UNTITLED_TAB_NAME moved from app.js
     * to workmode/panels.js — declared at the top level of panels.js
     * itself. Stub declarations were removed from this sandbox because
     * the loaded panels.js would now collide. */

    var _stableLaneIdCounter = 0;
    function ensureStableLaneIdForPanelIndex(idx) { return "lane_" + Number(idx); }
    function replaceStableLaneIdForPanelIndex(idx) { _stableLaneIdCounter += 1; return "lane_repl_" + idx + "_" + _stableLaneIdCounter; }
    function allocateWorkModeStableLaneId() { _stableLaneIdCounter += 1; return "lane_alloc_" + _stableLaneIdCounter; }

    const workModeReasoningAbortControllers = new Map();
    const workModeReasoningLaneBusy = new Map();
    const laneReasoningChainTail = new Map();
    /* Stage 12 (2026-05-31): workModeReasoningPanelFollowUpQueue moved
       to workmode/panels.js along with the per-panel follow-up queue
       helpers. panels.js now declares the Map itself; we no longer
       pre-stub it here (would collide with panels.js's own declaration). */
    const workModeReasoningFinalStatusByLaneId = new Map();
    const workModeCompletedReasoningByLaneId = Object.create(null);
    var activeWorkModeReasoningContext = null;
    var focusedWorkModeLaneId = "";
    var focusedWorkModeLaneAt = 0;
    var workModeLastSubstantiveLaneIdx = null;
    var workModeLastSubstantiveUserText = "";

    function getReasoningTabsStateStorageKey() { return "vera_reasoning_tabs_state:session_smoke"; }
    function persistReasoningTabsState() {}
    function syncReasoningLaneBusySlotsAfterDomChange() {}
    function syncWorkModeReasoningCancelButton() {}
    /* The fix in panels.js calls this — we record the calls so the
       smoke can assert addReasoningTab updates the focused lane. */
    function setFocusedWorkModeLaneFromIndex(idx) {
      __focusedFromIndexCalls.push(Number(idx));
      focusedWorkModeLaneId = "lane_" + Number(idx);
      focusedWorkModeLaneAt = Date.now();
    }

    var inputMuted = false;
    function appModePrefix() { return "vera"; }
    function isVeraWorkModeOn() { return true; }
    function isWorkModeMuteEnabled() { return false; }
    function addBubble() { return null; }
    function enqueueAssistantTtsPlayback() { return Promise.resolve(); }
    async function playWorkModeTtsOnlyPhrase() {}
    function setStatus() {}
    var processing = false;
    var requestInFlight = false;
    var waveState = "idle";
    var voiceUxTurn = null;
    var listeningMode = "continuous";
    function finishReasoningCloseVoiceTurnAfterAssistant() {}
    function logReasoningCloseVoiceLifecycle() {}
    `,
    sandbox,
    { filename: "tests/smoke/__reasoning_destination_after_open_app_stub__" }
  );

  vm.runInContext(fs.readFileSync(panelsPath, "utf8"), sandbox, { filename: "workmode/panels.js" });
  return { sandbox, panelsRoot, focusedFromIndexCalls };
}

/* ────────────────────────────────────────────────────────────────────── */

section("Suite A — window aliases for the new recently-opened helpers");
const { sandbox, panelsRoot, focusedFromIndexCalls } = buildLoadedSandbox(buildDom());

ok(typeof sandbox.window.getValidRecentlyOpenedReasoningPanel === "function",
   "window.getValidRecentlyOpenedReasoningPanel attached");
ok(typeof sandbox.window.consumeRecentlyOpenedReasoningPanel === "function",
   "window.consumeRecentlyOpenedReasoningPanel attached");
ok(typeof sandbox.window.clearRecentlyOpenedReasoningPanel === "function",
   "window.clearRecentlyOpenedReasoningPanel attached");
ok(typeof sandbox.window.setRecentlyOpenedReasoningPanel === "function",
   "window.setRecentlyOpenedReasoningPanel attached");

ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() === null,
   "no recently-opened flag set at startup");

section("Suite B — addReasoningTab updates destination state + recently-opened flag");

const beforeFocusCalls = focusedFromIndexCalls.length;
const result1 = vm.runInContext(`addReasoningTab({ source: "ui_plus_button" })`, sandbox);

ok(result1 && typeof result1 === "object", "addReasoningTab returns an info object");
ok(Number.isFinite(result1?.tabIndex), "result has numeric tabIndex");
ok(typeof result1?.laneId === "string" && result1.laneId.length > 0, "result has non-empty laneId");

eq(focusedFromIndexCalls.length, beforeFocusCalls + 1,
   "addReasoningTab called setFocusedWorkModeLaneFromIndex exactly once");
eq(focusedFromIndexCalls[focusedFromIndexCalls.length - 1], result1.tabIndex,
   "setFocusedWorkModeLaneFromIndex called with the new panel's index");

const focusedAfter = vm.runInContext("focusedWorkModeLaneId", sandbox);
eq(focusedAfter, "lane_" + result1.tabIndex,
   "focusedWorkModeLaneId now points at the new panel");

const flag1 = sandbox.window.getValidRecentlyOpenedReasoningPanel();
ok(flag1 && flag1.laneId === result1.laneId, "recently-opened flag laneId matches new panel");
ok(flag1 && flag1.tabIndex === result1.tabIndex, "recently-opened flag tabIndex matches new panel");
ok(flag1 && flag1.source === "ui_plus_button", "recently-opened flag source preserved");

const newPanelEl = panelsRoot.querySelector(`.vera-reasoning-tab-panel[data-tab-index="${result1.tabIndex}"]`);
ok(newPanelEl, "new panel was appended to panelsRoot");
ok(newPanelEl && newPanelEl.classList.contains("is-active"), "new panel has .is-active class");

section("Suite C — second open replaces the recently-opened flag (latest wins)");

const result2 = vm.runInContext(`addReasoningTab({ source: "multi_action_planner_open_command" })`, sandbox);
ok(result2 && result2.tabIndex > result1.tabIndex, "second open allocates a higher tabIndex");
const flag2 = sandbox.window.getValidRecentlyOpenedReasoningPanel();
ok(flag2 && flag2.laneId === result2.laneId, "flag now points at the SECOND new panel");
ok(flag2 && flag2.source === "multi_action_planner_open_command", "flag source updated to typed/voice");

/* And the FIRST panel must no longer be active (`.is-active` only on latest). */
const firstPanelEl = panelsRoot.querySelector(`.vera-reasoning-tab-panel[data-tab-index="${result1.tabIndex}"]`);
ok(firstPanelEl && !firstPanelEl.classList.contains("is-active"),
   "first opened panel no longer has .is-active");
const secondPanelEl = panelsRoot.querySelector(`.vera-reasoning-tab-panel[data-tab-index="${result2.tabIndex}"]`);
ok(secondPanelEl && secondPanelEl.classList.contains("is-active"),
   "second opened panel has .is-active");

section("Suite D — consumeRecentlyOpenedReasoningPanel returns snapshot and clears");

const consumedSnap = sandbox.window.consumeRecentlyOpenedReasoningPanel("first_reasoning_submission");
ok(consumedSnap && consumedSnap.laneId === result2.laneId,
   "consume returns the most-recent snapshot");
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() === null,
   "after consume, getValidRecentlyOpenedReasoningPanel returns null");
ok(sandbox.window.consumeRecentlyOpenedReasoningPanel("second_call") === null,
   "second consume returns null (one-shot)");

section("Suite E — clearRecentlyOpenedReasoningPanel cancels the bias");

const result3 = vm.runInContext(`addReasoningTab({ source: "backend_open_panel_action" })`, sandbox);
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() !== null,
   "fresh open re-arms the flag");
sandbox.window.clearRecentlyOpenedReasoningPanel("manual_tab_switch");
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() === null,
   "clear immediately drops the flag");

section("Suite F — TTL expiry invalidates the flag");

/* We simulate TTL by manually setting openedAt back beyond TTL using the
   internal setter (the helper validates against Date.now()). */
vm.runInContext(`setRecentlyOpenedReasoningPanel("lane_test", 7, "ttl_test")`, sandbox);
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() === null,
   "panel with non-existent index in DOM is invalid (no lane_test panel)");

/* Now open a real panel, then mutate the openedAt back beyond TTL. */
const result4 = vm.runInContext(`addReasoningTab({ source: "ui_plus_button" })`, sandbox);
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() !== null,
   "fresh open returns valid flag before TTL");

vm.runInContext(
  `recentlyOpenedReasoningPanel.openedAt = Date.now() - (RECENTLY_OPENED_REASONING_PANEL_TTL_MS + 1000)`,
  sandbox
);
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() === null,
   "after backdating beyond TTL, flag returns null");

section("Suite G — flag invalidated when panel no longer exists");

const result5 = vm.runInContext(`addReasoningTab({ source: "ui_plus_button" })`, sandbox);
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() !== null,
   "fresh open returns valid flag");

/* Remove the new panel from the DOM and re-check. */
const removeTarget = panelsRoot.querySelector(`.vera-reasoning-tab-panel[data-tab-index="${result5.tabIndex}"]`);
ok(removeTarget, "newly opened panel is queryable");
panelsRoot.removeChild(removeTarget);
ok(sandbox.window.getValidRecentlyOpenedReasoningPanel() === null,
   "flag is null after the panel is removed from the DOM");

section("Suite H — load order: panels.js is loaded before app.js in index.html");
const indexHtml = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
const panelsIdx = indexHtml.indexOf("workmode/panels.js");
const appIdx = indexHtml.indexOf("app.js?v=");
ok(panelsIdx > 0 && appIdx > 0, "both script tags present in index.html");
ok(panelsIdx < appIdx, "workmode/panels.js loads BEFORE app.js (cross-module forward ref works)");

console.log("\n=========");
console.log(`PASS: ${pass}   FAIL: ${fail}`);
console.log("=========");
process.exit(fail === 0 ? 0 : 1);
