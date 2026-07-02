// Visual panel targeting — stable tab index vs user-facing panel number.
//
// Run: node tests/smoke/__panel_visual_targeting_smoke.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PANELS_JS = fs.readFileSync(
  path.resolve(__dirname, "../../workmode/panels.js"),
  "utf8"
).replace(/\r\n/g, "\n");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YEL = "\x1b[33m";
const RST = "\x1b[0m";
let pass = 0;
let fail = 0;
const failed = [];

function section(label) {
  console.log(`\n${YEL}-- ${label} --${RST}`);
}
function ok(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ${GREEN}PASS${RST}  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  ${RED}FAIL${RST}  ${name}`);
    if (detail) console.log(`         ${String(detail).slice(0, 600)}`);
  }
}

function makePanelEl(spec) {
  return {
    classList: {
      contains() {
        return Boolean(spec.active);
      },
      toggle() {},
      remove() {},
      add() {},
    },
    dataset: {
      tabIndex: String(spec.tabIndex),
      laneId: spec.laneId || `lane_${spec.tabIndex}`,
      laneLabel: spec.label || "",
      tabTopic: spec.topic || "Untitled",
      tabTopicSet: "0",
    },
    querySelector() {
      return { innerHTML: "" };
    },
  };
}

function bootPanelsApi(panelSpecs) {
  const panelEls = panelSpecs.map(makePanelEl);
  const root = {
    querySelectorAll() {
      return panelEls;
    },
    querySelector(sel) {
      const m = /data-tab-index="(\d+)"/.exec(sel || "");
      if (!m) return null;
      return panelEls.find((p) => p.dataset.tabIndex === m[1]) || null;
    },
    appendChild() {},
  };
  const ctx = {
    module: { exports: {} },
    exports: {},
    document: {
      getElementById(id) {
        return id === "vera-reasoning-tab-panels" ? root : null;
      },
      querySelector(sel) {
        return root.querySelector(sel);
      },
    },
    console,
    REASONING_TABS_MAX: 8,
    REASONING_TABS_DEFAULT: 3,
    MIN_REASONING_PANELS: 3,
    REASONING_UNTITLED_TAB_NAME: "Untitled",
    setFocusedWorkModeLaneFromIndex() {},
    renderReasoningTabStrip() {},
    syncReasoningLaneBusySlotsAfterDomChange() {},
    syncWorkModeReasoningCancelButton() {},
    logReasoningPanelSelectDebug() {},
    setRecentlyOpenedReasoningPanel() {},
    repairDuplicateReasoningPanelDisplayTitles() {
      return { repaired: false };
    },
    addReasoningTab() {
      return null;
    },
    _isGenericBlankReasoningPanelLabel(label) {
      return /^panel\s+\d+$/i.test(String(label || "").trim()) || !String(label || "").trim();
    },
    _isBlankReasoningPanelElement() {
      return true;
    },
  };
  vm.createContext(ctx);
  const sliceStart = PANELS_JS.indexOf("function isGenericAutoRenamableReasoningPanelTitle(s)");
  const sliceEnd = PANELS_JS.indexOf("function closeReasoningPanelsByVisualIndices");
  if (sliceStart < 0 || sliceEnd < 0) {
    throw new Error("Could not slice panels.js helpers");
  }
  const helperBlock = PANELS_JS.slice(sliceStart, sliceEnd);
  vm.runInContext(
    `${helperBlock}
module.exports = {
  getReasoningPanelOrder,
  resolveReasoningPanelTabIndexFromVisual1,
  reasoningVisualPanelExists,
  resolveReasoningTabIndexForPanelPayload,
};`,
    ctx,
    { filename: "panel-visual-targeting-helpers.js" }
  );
  return ctx.module.exports;
}

section("Visual index maps to stable tab index when gaps exist");
const P = bootPanelsApi([
  { tabIndex: 0, label: "Panel 1" },
  { tabIndex: 2, label: "Panel 2" },
  { tabIndex: 5, label: "Vietnam War", topic: "Vietnam War" },
  { tabIndex: 7, label: "Panel 4", active: true },
]);
ok(P.resolveReasoningPanelTabIndexFromVisual1(4) === 7, "visual panel 4 → tabIndex 7 (not 3)");
ok(P.resolveReasoningPanelTabIndexFromVisual1(3) === 5, "visual panel 3 → tabIndex 5");
ok(P.reasoningVisualPanelExists(4) === true, "panel 4 exists in visual order");
ok(P.reasoningVisualPanelExists(5) === false, "panel 5 does not exist yet");

section("Payload resolver reuses existing panel without using 0based as tabIndex");
const resolved = P.resolveReasoningTabIndexForPanelPayload(
  { target_panel_index_1based: 4, target_panel_index_0based: 3 },
  { allowCreate: false }
);
ok(resolved.tabIndex === 7, "payload panel 4 resolves to tabIndex 7", JSON.stringify(resolved));
ok(resolved.existedBefore === true, "existing panel reused");
ok(resolved.createdPanel === false, "no new panel created");

section("Ordinal + numeric panel references (app gate helpers)");
const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8").replace(/\r\n/g, "\n");
const HELPER_START = "/* ============================================================================\n * 2026-05-29 reasoning-gate helpers (Voice UI vs reasoning panel).";
const HELPER_END = "function _panelNavOrdinalTokenToVisual1(tok) {";
const helpersSource = APP_JS.slice(APP_JS.indexOf(HELPER_START), APP_JS.indexOf(HELPER_END));
const gateCtx = { module: { exports: {} }, exports: {}, console };
vm.createContext(gateCtx);
vm.runInContext(
  `"use strict";
let workModeLastSubstantiveUserText = "";
function detectMoveLatestVoiceTaskToReasoningIntent() { return { matched: false }; }
function isExplicitWorkModePanelNavigationIntent() { return false; }
function isPureWorkModePanelOpenRequest() { return false; }
function cleanWorkModeActionQueryUi(t) { return String(t||"").trim(); }
${helpersSource}
module.exports = { isExplicitReasoningPanelReference, resolveTopicForExplicitPanelReference };
`,
  gateCtx,
  { filename: "panel-visual-gate.js" }
);
const G = gateCtx.module.exports;
const binomial = G.isExplicitReasoningPanelReference("explain the binomial lattice in panel 4");
ok(binomial.matched && binomial.targetPanel === 4, "binomial lattice → panel 4", JSON.stringify(binomial));
const panelTwo = G.isExplicitReasoningPanelReference("write this in panel two");
ok(panelTwo.matched && panelTwo.targetPanel === 2, "panel two → panel 2", JSON.stringify(panelTwo));
const vietnam = G.resolveTopicForExplicitPanelReference(
  "explain the Vietnam War in panel 3",
  G.isExplicitReasoningPanelReference("explain the Vietnam War in panel 3")
);
ok(String(vietnam.topic || "").toLowerCase().includes("vietnam war"), "Vietnam War topic extracted", JSON.stringify(vietnam));

console.log(`\nTotal: ${pass + fail}   ${GREEN}PASS=${pass}${RST}   ${fail ? RED : ""}FAIL=${fail}${RST}`);
if (failed.length) {
  console.log("Failing tests:");
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
