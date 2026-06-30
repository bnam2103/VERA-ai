/* ============================================================================
 * __reasoning_panel_empty_placeholder_smoke.mjs
 *
 * Patch 2026-06-01: Fix the empty Work Mode reasoning-panel placeholder UI.
 *
 *   Bug: the placeholder
 *
 *     "No reasoning in this panel yet. Ask VERA to work through something,
 *      or type below."
 *
 *   stayed visible WHILE a panel was generating, and overlapped with
 *   streamed content the moment the first chunk landed.
 *
 *   Fix: placeholder visibility now follows
 *
 *     placeholderVisible = !panel.isGenerating && !panel.hasReasoningContent
 *
 *   "Generating" is sourced from the global workModeReasoningLaneBusy
 *   Map declared in app.js (keyed by tab index). Because panels.js and
 *   app.js share a classic-script global scope, panels.js reads the
 *   map at call time.
 *
 *   The recompute is centralized in
 *     recomputeReasoningPanelEmptyHints()
 *   and is invoked from
 *     - renderReasoningTabStrip (existing tab strip render path)
 *     - syncWorkModeReasoningCancelButton (called on every lane busy
 *       toggle in app.js: acquire / acquireForIndex / drainWaitQueue /
 *       release, plus the direct stream-start at L14137)
 *
 * Acceptance scenarios covered (per user spec):
 *   1. Open a new empty panel → placeholder appears.
 *   2. Ask VERA to reason in that panel → placeholder hides on busy=true.
 *   3. Reasoning content appears (innerHTML populated) → stays hidden.
 *   4. Generation finishes (busy=false) → does not come back (content
 *      keeps it hidden).
 *   5. Switch to another empty panel → placeholder appears there.
 *   6. Switch back to the completed panel → placeholder stays hidden.
 *   7. Clear a panel (innerHTML cleared, not busy) → placeholder
 *      appears again.
 *
 * Run:  node tests/smoke/__reasoning_panel_empty_placeholder_smoke.mjs
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

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}`); }
}
function section(title) { console.log(`\n── ${title} ──`); }

/* ─────────────────────────  fake DOM helpers ───────────────────────── */

function makeClassList(initial) {
  const set = new Set(String(initial || "").split(/\s+/).filter(Boolean));
  return {
    _set: set,
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    toggle(c, force) {
      if (force === true) set.add(c);
      else if (force === false) set.delete(c);
      else if (set.has(c)) set.delete(c);
      else set.add(c);
    },
    contains(c) { return set.has(c); },
  };
}

function makeElement(opts = {}) {
  const self = {
    _tag: opts.tag || "div",
    id: opts.id || "",
    className: opts.className || "",
    classList: makeClassList(opts.className),
    dataset: { ...(opts.dataset || {}) },
    innerHTML: opts.innerHTML != null ? String(opts.innerHTML) : "",
    hidden: false,
    _children: [],
    _parent: null,
  };
  self.appendChild = function (child) {
    child._parent = self;
    self._children.push(child);
    return child;
  };
  self.querySelector = function (sel) {
    const all = self.querySelectorAll(sel);
    return all[0] || null;
  };
  self.querySelectorAll = function (sel) {
    const out = [];
    const queue = [...self._children];
    while (queue.length) {
      const c = queue.shift();
      if (matchesSelector(c, sel)) out.push(c);
      if (c._children?.length) queue.push(...c._children);
    }
    return out;
  };
  self.setAttribute = function (k, v) { self[k] = v; };
  self.getAttribute = function (k) { return self[k] != null ? String(self[k]) : null; };
  return self;
}

function matchesSelector(el, sel) {
  if (!el) return false;
  /* Handles simple selectors only:
       .cls   .a.b   #id   tag (lowercased)
     This is enough for what panels.js queries inside the visibility
     recompute path (.vera-reasoning-tab-panel, .vera-reasoning-md-panel,
     .vera-reasoning-scroll, .vera-wm-empty-hint--reasoning,
     .vera-wm-empty-hint--fresh, #vera-reasoning-tab-panels). */
  const parts = String(sel || "").trim().split(/\s+/);
  if (parts.length > 1) {
    // last-token check; treat as descendant of any ancestor — we just
    // check the leaf token against the element itself. The DOM walk in
    // querySelectorAll already iterates all descendants so a leaf match
    // is enough for the selectors used by the production code path.
    return matchesSimpleToken(el, parts[parts.length - 1]);
  }
  return matchesSimpleToken(el, parts[0]);
}

function matchesSimpleToken(el, token) {
  /* split into id, class[], tag */
  let tag = "";
  let id = "";
  const cls = [];
  let buf = "";
  let mode = "tag";
  const flush = () => {
    if (!buf) { return; }
    if (mode === "tag") tag = buf;
    else if (mode === "id") id = buf;
    else if (mode === "cls") cls.push(buf);
    buf = "";
  };
  for (const ch of String(token || "")) {
    if (ch === "#") { flush(); mode = "id"; }
    else if (ch === ".") { flush(); mode = "cls"; }
    else { buf += ch; }
  }
  flush();
  if (tag && el._tag !== tag) return false;
  if (id && el.id !== id) return false;
  for (const c of cls) if (!el.classList.contains(c)) return false;
  return Boolean(tag || id || cls.length);
}

function buildDocument({ panels, hintPerPanel, hintFresh, panelsRoot }) {
  /* Track all elements by id and provide queryable roots. */
  const idIndex = new Map();
  function registerById(el) {
    if (el?.id) idIndex.set(el.id, el);
    if (el?._children) for (const c of el._children) registerById(c);
  }
  registerById(panelsRoot);
  /* Top-level document root that aggregates panelsRoot + the two hints
     (the production HTML keeps the hints as siblings of
     #vera-reasoning-tab-panels inside .vera-wm-reasoning-body-wrap). */
  const docRoot = makeElement({ tag: "div", className: "vera-wm-reasoning-body-wrap" });
  docRoot.appendChild(panelsRoot);
  if (hintPerPanel) docRoot.appendChild(hintPerPanel);
  if (hintFresh) docRoot.appendChild(hintFresh);
  return {
    getElementById(id) { return idIndex.get(id) || null; },
    querySelector(sel) { return docRoot.querySelector(sel); },
    querySelectorAll(sel) { return docRoot.querySelectorAll(sel); },
    _root: docRoot,
  };
}

function makePanel({ tabIndex, html = "", active = false }) {
  const panel = makeElement({
    tag: "div",
    className: "vera-reasoning-tab-panel" + (active ? " is-active" : ""),
    dataset: { tabIndex: String(tabIndex) },
  });
  panel.id = `vera-reasoning-tab-panel-${tabIndex}`;
  const scroll = makeElement({
    tag: "div",
    className: "vera-reasoning-scroll vera-reasoning-md-panel",
    innerHTML: html,
  });
  panel.appendChild(scroll);
  return panel;
}

function makeHint(modifier) {
  const hint = makeElement({
    tag: "p",
    className: `vera-wm-empty-hint vera-wm-empty-hint--${modifier}`,
  });
  hint.hidden = false;
  return hint;
}

/* ─────────────────────────  sandbox loader  ───────────────────────── */

function makeMemoryStorage() {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
    clear: () => bag.clear(),
  };
}

function buildSandbox({ panels, hintPerPanel, hintFresh }) {
  const panelsRoot = makeElement({
    tag: "div",
    className: "vera-reasoning-tab-panels",
  });
  panelsRoot.id = "vera-reasoning-tab-panels";
  for (const p of panels) panelsRoot.appendChild(p);

  const doc = buildDocument({ panels, hintPerPanel, hintFresh, panelsRoot });

  const cConsole = {
    log: () => {}, info: () => {}, debug: () => {},
    warn: () => {}, error: () => {},
  };
  const win = { isSecureContext: true, setTimeout, clearTimeout };
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

  /* Production HTMLElement check uses ``instanceof HTMLElement``. Our
     fake panel objects are plain objects, so we monkey-patch the
     sandbox's HTMLElement to be a class whose static [Symbol.hasInstance]
     accepts anything that "looks like" a panel/hint element (has a
     classList + appendChild). */
  const HE = sandbox.HTMLElement;
  Object.defineProperty(HE, Symbol.hasInstance, {
    value: function (obj) {
      return Boolean(obj && obj.classList && typeof obj.appendChild === "function");
    },
  });

  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, {
    filename: "utils/storage.js",
  });

  /* App-stub: bindings panels.js touches at call time. We instantiate
     workModeReasoningLaneBusy here so the test (and the panel
     visibility helper) can read/mutate the same Map. */
  vm.runInContext(
    `
    var _stableLaneId = 0;
    function ensureStableLaneIdForPanelIndex(idx) { return "lane_" + Number(idx); }
    function replaceStableLaneIdForPanelIndex(idx) { _stableLaneId += 1; return "lane_repl_" + idx + "_" + _stableLaneId; }
    function allocateWorkModeStableLaneId() { _stableLaneId += 1; return "lane_alloc_" + _stableLaneId; }

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

    function getReasoningTabsStateStorageKey() { return "vera_reasoning_tabs_state:session_smoke"; }
    function persistReasoningTabsState() {}
    function syncReasoningLaneBusySlotsAfterDomChange() {}
    function syncWorkModeReasoningCancelButton() {
      if (typeof recomputeReasoningPanelEmptyHints === "function") {
        recomputeReasoningPanelEmptyHints();
      }
    }
    function setFocusedWorkModeLaneFromIndex(idx) { focusedWorkModeLaneId = "lane_" + Number(idx); }

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
    { filename: "tests/smoke/__panel_empty_placeholder_app_stub__" }
  );

  vm.runInContext(fs.readFileSync(panelsPath, "utf8"), sandbox, {
    filename: "workmode/panels.js",
  });

  return { sandbox, panelsRoot, doc };
}

/* ─────────────────────────  helpers for assertions  ───────────────────────── */

function recompute(sandbox) {
  vm.runInContext("recomputeReasoningPanelEmptyHints()", sandbox);
}

function setBusy(sandbox, idx, busy) {
  vm.runInContext(
    `workModeReasoningLaneBusy.set(${Number(idx)}, ${Boolean(busy)})`,
    sandbox
  );
  /* The production patch piggy-backs the recompute onto
     syncWorkModeReasoningCancelButton. Mirror that here to exercise
     the chokepoint behaviour. */
  vm.runInContext("syncWorkModeReasoningCancelButton()", sandbox);
}

function activate(panels, idx) {
  for (const p of panels) {
    if (Number(p.dataset.tabIndex) === Number(idx)) p.classList.add("is-active");
    else p.classList.remove("is-active");
  }
}

/* ============================================================================
 * Suite A — module loads cleanly and exposes the new helpers
 * ============================================================================ */
section("Suite A — module loads cleanly + new helpers exist");
{
  const panel0 = makePanel({ tabIndex: 0, active: true });
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panel0], hintPerPanel: hp, hintFresh: hf });
  const declCheck = vm.runInContext(
    `({
       recomputeReasoningPanelEmptyHints: typeof recomputeReasoningPanelEmptyHints,
       _panelIsCurrentlyGenerating: typeof _panelIsCurrentlyGenerating,
       _panelShouldShowEmptyHint: typeof _panelShouldShowEmptyHint,
       _isBlankReasoningPanelElement: typeof _isBlankReasoningPanelElement,
    })`,
    sandbox
  );
  ok(declCheck.recomputeReasoningPanelEmptyHints === "function", "recomputeReasoningPanelEmptyHints is declared as a function");
  ok(declCheck._panelIsCurrentlyGenerating === "function", "_panelIsCurrentlyGenerating helper exists");
  ok(declCheck._panelShouldShowEmptyHint === "function", "_panelShouldShowEmptyHint helper exists");
  ok(declCheck._isBlankReasoningPanelElement === "function", "_isBlankReasoningPanelElement helper still exists");
}

/* ============================================================================
 * Suite B — Acceptance test 1: open a new empty panel → placeholder appears
 * ============================================================================ */
section("Suite B — Acceptance 1: new empty panel shows placeholder");
{
  const panel0 = makePanel({ tabIndex: 0, active: true });
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panel0], hintPerPanel: hp, hintFresh: hf });
  /* Initial recompute mirrors page load. Per current production rule:
       hintFresh shows when allBlank.
       hintPerPanel shows when !allBlank && activeBlank.
     With a single empty idle panel, allBlank=true → fresh hint visible,
     per-panel hint hidden. This is intentional workspace-style messaging
     when nothing has run yet. The Acceptance-1 "placeholder appears"
     guarantee is honoured by EITHER hint being visible on a brand-new
     empty workspace; the per-panel hint takes over once at least one
     panel has content (covered below). */
  recompute(sandbox);
  ok(hp.hidden === true, "single-panel empty workspace: per-panel hint hidden (fresh hint takes over)");
  ok(hf.hidden === false, "fresh hint visible when every panel is empty + idle (workspace-fresh state)");

  /* Add a second empty idle panel → still allBlank=true → fresh wins,
     per-panel hidden. */
  const panel1 = makePanel({ tabIndex: 1, active: false });
  vm.runInContext("document.getElementById('vera-reasoning-tab-panels').appendChild", sandbox); // sanity, no-op
  sandbox.document.getElementById("vera-reasoning-tab-panels").appendChild(panel1);
  recompute(sandbox);
  ok(hf.hidden === false, "fresh hint still visible after second empty panel added (both blank+idle)");
  ok(hp.hidden === true, "per-panel hint hidden when fresh hint is showing (mutually exclusive)");

  /* Now populate panel0 → allBlank becomes false (panel0 has content,
     panel1 still empty). Active panel0 has content so its hint
     should hide; active being empty would be the per-panel trigger. */
  panel0.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>thinking…</p>";
  recompute(sandbox);
  ok(hf.hidden === true, "fresh hint hidden when at least one panel has content");
  ok(hp.hidden === true, "per-panel hint hidden because active panel has content");

  /* Activate the still-empty panel1 → per-panel hint should appear. */
  activate([panel0, panel1], 1);
  recompute(sandbox);
  ok(hf.hidden === true, "fresh hint still hidden because not all panels are blank");
  ok(hp.hidden === false, "per-panel hint visible on the empty active panel (Acceptance 1 satisfied)");
}

/* ============================================================================
 * Suite C — Acceptance 2 + 3: generation start hides placeholder, content keeps it hidden
 * ============================================================================ */
section("Suite C — Acceptance 2 + 3: gen start hides placeholder; content keeps it hidden");
{
  const panel0 = makePanel({ tabIndex: 0, active: true });
  const panel1 = makePanel({ tabIndex: 1, active: false });
  /* Pre-populate panel1 so allBlank=false and the per-panel hint will be
     in play for panel0 (otherwise fresh hint takes over). */
  panel1.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>old</p>";
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panel0, panel1], hintPerPanel: hp, hintFresh: hf });

  recompute(sandbox);
  ok(hp.hidden === false, "before generation: per-panel hint visible on empty active panel 0");
  ok(hf.hidden === true, "before generation: fresh hint hidden because panel 1 has content");

  /* Acceptance 2: ask VERA to reason → busy=true for tabIndex 0. */
  setBusy(sandbox, 0, true);
  ok(hp.hidden === true, "Acceptance 2: per-panel hint hidden immediately when generation starts (busy=true)");
  ok(hf.hidden === true, "fresh hint still hidden (one panel generating, one has content)");

  /* Acceptance 3: streamed content lands in the panel mid-generation.
     The hint must remain hidden. */
  panel0.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>chunk 1…</p>";
  recompute(sandbox);
  ok(hp.hidden === true, "Acceptance 3: per-panel hint stays hidden when content streams in while still generating");
}

/* ============================================================================
 * Suite D — Acceptance 4: generation finishes, placeholder does not come back
 * ============================================================================ */
section("Suite D — Acceptance 4: gen finishes; placeholder stays hidden if content present");
{
  const panel0 = makePanel({ tabIndex: 0, active: true });
  const panel1 = makePanel({ tabIndex: 1, active: false });
  panel1.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>other</p>";
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panel0, panel1], hintPerPanel: hp, hintFresh: hf });

  setBusy(sandbox, 0, true);
  panel0.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>final result</p>";
  /* Generation ends → busy=false. With content present, hint must stay hidden. */
  setBusy(sandbox, 0, false);
  ok(hp.hidden === true, "Acceptance 4: per-panel hint stays hidden after generation finishes because panel has content");
  ok(hf.hidden === true, "fresh hint stays hidden because no panel is empty+idle");

  /* Edge case: generation produces NO content (aborted before any chunk),
     busy goes false, panel is empty + idle → hint must reappear. */
  const panel2 = makePanel({ tabIndex: 2, active: false });
  sandbox.document.getElementById("vera-reasoning-tab-panels").appendChild(panel2);
  activate([panel0, panel1, panel2], 2);
  setBusy(sandbox, 2, true);
  ok(hp.hidden === true, "no-content active generating panel: hint hidden");
  setBusy(sandbox, 2, false);
  ok(hp.hidden === false, "no-content aborted generation: hint reappears on empty idle panel");
}

/* ============================================================================
 * Suite E — Acceptance 5 + 6: tab switching between empty + completed panels
 * ============================================================================ */
section("Suite E — Acceptance 5 + 6: tab switch recomputes visibility");
{
  const panelA = makePanel({ tabIndex: 0, active: true });
  panelA.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>completed work</p>";
  const panelB = makePanel({ tabIndex: 1, active: false });
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panelA, panelB], hintPerPanel: hp, hintFresh: hf });

  recompute(sandbox);
  ok(hp.hidden === true, "active completed panel: hint hidden (content present)");
  ok(hf.hidden === true, "fresh hint hidden because panel A has content");

  /* Acceptance 5: switch to empty panel B → hint should appear there. */
  activate([panelA, panelB], 1);
  recompute(sandbox);
  ok(hp.hidden === false, "Acceptance 5: switching to an empty idle panel shows the per-panel hint");
  ok(hf.hidden === true, "fresh hint still hidden because panel A has content");

  /* Acceptance 6: switch back to the completed panel → hint stays hidden. */
  activate([panelA, panelB], 0);
  recompute(sandbox);
  ok(hp.hidden === true, "Acceptance 6: switching back to the completed panel keeps the hint hidden");
}

/* ============================================================================
 * Suite F — Acceptance 7: clearing a panel restores the placeholder
 * ============================================================================ */
section("Suite F — Acceptance 7: clear panel restores placeholder");
{
  const panelA = makePanel({ tabIndex: 0, active: true });
  panelA.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>some result</p>";
  const panelB = makePanel({ tabIndex: 1, active: false });
  panelB.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>other</p>";
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panelA, panelB], hintPerPanel: hp, hintFresh: hf });

  recompute(sandbox);
  ok(hp.hidden === true, "before clear: per-panel hint hidden (active has content)");
  ok(hf.hidden === true, "before clear: fresh hint hidden (no empty panel)");

  /* Clear active panel content. */
  panelA.querySelector(".vera-reasoning-md-panel").innerHTML = "";
  recompute(sandbox);
  ok(hp.hidden === false, "Acceptance 7: per-panel hint reappears after clearing content on the active panel");
  ok(hf.hidden === true, "fresh hint still hidden because panel B still has content");

  /* Clear both panels. */
  panelB.querySelector(".vera-reasoning-md-panel").innerHTML = "";
  recompute(sandbox);
  ok(hf.hidden === false, "all-blank workspace after clearing every panel → fresh hint visible");
  ok(hp.hidden === true, "per-panel hint hidden when fresh hint is visible");
}

/* ============================================================================
 * Suite G — Generating state takes precedence even on the "blank by content" check
 * ============================================================================ */
section("Suite G — generating state suppresses both hints (workspace busy)");
{
  const panel0 = makePanel({ tabIndex: 0, active: true });
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panel0], hintPerPanel: hp, hintFresh: hf });

  recompute(sandbox);
  ok(hf.hidden === false, "single empty idle panel: fresh hint visible");
  setBusy(sandbox, 0, true);
  ok(hf.hidden === true, "single empty GENERATING panel: fresh hint hidden (workspace not idle)");
  ok(hp.hidden === true, "single empty GENERATING panel: per-panel hint hidden (Acceptance 2 holds)");

  /* And once busy clears, the empty idle workspace is back. */
  setBusy(sandbox, 0, false);
  ok(hf.hidden === false, "after busy clears with no content produced: fresh hint reappears");
}

/* ============================================================================
 * Suite H — _panelShouldShowEmptyHint pure-function rule
 * ============================================================================ */
section("Suite H — pure helper _panelShouldShowEmptyHint behaviour");
{
  const panel0 = makePanel({ tabIndex: 0, active: true });
  const panel1 = makePanel({ tabIndex: 1, active: false });
  panel1.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>x</p>";
  const hp = makeHint("reasoning");
  const hf = makeHint("fresh");
  const { sandbox } = buildSandbox({ panels: [panel0, panel1], hintPerPanel: hp, hintFresh: hf });

  /* Expose direct evaluation via a sandbox closure. */
  function evalShould(idx) {
    return vm.runInContext(
      `(function(){
         var panels = document.getElementById("vera-reasoning-tab-panels");
         var arr = [].concat([...(panels._children || [])]);
         var p = arr.find(function(x){ return Number(x.dataset.tabIndex) === ${Number(idx)}; });
         return _panelShouldShowEmptyHint(p);
       })()`,
      sandbox
    );
  }

  ok(evalShould(0) === true, "empty + idle panel returns true (hint should show)");
  ok(evalShould(1) === false, "content-bearing panel returns false");

  setBusy(sandbox, 0, true);
  ok(evalShould(0) === false, "empty + generating panel returns false (Acceptance rule)");
  setBusy(sandbox, 0, false);
  panel0.querySelector(".vera-reasoning-md-panel").innerHTML = "<p>y</p>";
  ok(evalShould(0) === false, "filled panel returns false even when idle");
  panel0.querySelector(".vera-reasoning-md-panel").innerHTML = "";
  ok(evalShould(0) === true, "back to empty + idle returns true");
}

/* ============================================================================
 * Suite I — Static checks against panels.js source
 * ============================================================================ */
section("Suite I — static source checks");
{
  const src = fs.readFileSync(panelsPath, "utf8");
  ok(
    /function\s+recomputeReasoningPanelEmptyHints\s*\(/.test(src),
    "panels.js declares recomputeReasoningPanelEmptyHints"
  );
  ok(
    /function\s+_panelIsCurrentlyGenerating\s*\(/.test(src),
    "panels.js declares _panelIsCurrentlyGenerating"
  );
  ok(
    /function\s+_panelShouldShowEmptyHint\s*\(/.test(src),
    "panels.js declares _panelShouldShowEmptyHint"
  );
  ok(
    /recomputeReasoningPanelEmptyHints\s*\(\s*\)\s*;/.test(src),
    "panels.js calls recomputeReasoningPanelEmptyHints() (used by renderReasoningTabStrip)"
  );
  /* Old inline visibility block must be gone (we only keep the call). */
  ok(
    !/const\s+activeBlank\s*=\s*activePanel\s*\?\s*_isBlankReasoningPanelElement/.test(src),
    "panels.js no longer holds the old inline activeBlank computation (factored into helper)"
  );
}

/* ============================================================================
 * Suite J — Static checks against app.js source (chokepoint wired)
 * ============================================================================ */
section("Suite J — app.js wires the recompute into the lane busy chokepoint");
{
  const src = fs.readFileSync(appJsPath, "utf8");
  const sync = src.match(/function syncWorkModeReasoningCancelButton\(\)[\s\S]*?\n}/);
  ok(Boolean(sync), "syncWorkModeReasoningCancelButton function block found");
  if (sync) {
    ok(
      /recomputeReasoningPanelEmptyHints\(\)/.test(sync[0]),
      "syncWorkModeReasoningCancelButton calls recomputeReasoningPanelEmptyHints() (chokepoint hook)"
    );
    ok(
      /typeof\s+recomputeReasoningPanelEmptyHints\s*===\s*["']function["']/.test(sync[0]),
      "syncWorkModeReasoningCancelButton guards the call against panels.js absence (typeof check)"
    );
  }
  /* Ensure the original cancel-button hidden logic still runs (we didn't
     accidentally drop it). */
  ok(
    /btn\.hidden\s*=\s*activeIdx\s*==\s*null\s*\|\|\s*!workModeReasoningAbortControllers\.has\(Number\(activeIdx\)\)/.test(src),
    "syncWorkModeReasoningCancelButton still updates btn.hidden (cancel button logic preserved)"
  );
}

console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail > 0) process.exit(1);
