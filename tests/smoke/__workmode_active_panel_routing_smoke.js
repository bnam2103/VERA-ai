// Work Mode active-panel routing — bare reasoning requests use the active panel.
//
// Run: node tests/smoke/__workmode_active_panel_routing_smoke.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs
  .readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8")
  .replace(/\r\n/g, "\n");

const START = "const WORK_MODE_TOPIC_STOPWORDS = new Set([";
const END = "function logWorkModeRouteTrace(tag, payload = {}) {";
const startIdx = APP_JS.indexOf(START);
const endIdx = APP_JS.indexOf(END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error("Could not slice routing helpers from app.js");
  process.exit(2);
}

const PANELS = [
  { idx: 0, title: "Panel 1", topic: "Panel 1" },
  { idx: 1, title: "Panel 2", topic: "Panel 2" },
  { idx: 2, title: "Squeeze Theorem", topic: "Squeeze Theorem" },
];

const sandboxSource = `
"use strict";
const PANELS = ${JSON.stringify(PANELS)};
function getReasoningPanelIndices() { return PANELS.map((p) => p.idx); }
function getReasoningPanelElementByLaneIdx(idx) {
  const row = PANELS.find((p) => p.idx === Number(idx));
  if (!row) return null;
  return { dataset: { laneId: "lane_" + row.idx, tabTopic: row.topic } };
}
function getReasoningTabTopicLabel(panel) {
  return String(panel?.dataset?.tabTopic || "");
}
const laneTopicSeedByIdx = {};
${APP_JS.slice(startIdx, endIdx)}
module.exports = {
  shouldReuseActiveReasoningPanel,
  detectExplicitPanelTarget,
  detectExplicitNewPanelRequest,
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "workmode-active-panel-routing.js" });
const R = moduleStub.exports;

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

section("Active panel default — no explicit target");
{
  const dec = R.shouldReuseActiveReasoningPanel({
    latestUserText: "explain squeeze theorem",
    recentVoiceContext: "",
    activePanelTitle: "Panel 3",
    activePanelExcerpt: "",
    activeLaneIdx: 2,
  });
  ok(dec.decision === "reuse_active_panel", "explain squeeze theorem → reuse active");
  ok(dec.targetLaneIdx === 2, "targets active Panel 3 (idx 2)", JSON.stringify(dec));
  ok(dec.reason === "active_panel_default_no_explicit_target", "reason is active default", dec.reason);
}

section("Explicit panel number target");
{
  const target = R.detectExplicitPanelTarget("explain squeeze theorem in panel 2");
  ok(target.matched === true, "detects explicit panel 2 reference");
  ok(target.targetLaneIdx === 1, "panel 2 → lane idx 1", JSON.stringify(target));
  const dec = R.shouldReuseActiveReasoningPanel({
    latestUserText: "explain squeeze theorem in panel 2",
    activePanelTitle: "Panel 3",
    activePanelExcerpt: "",
    activeLaneIdx: 2,
  });
  ok(dec.decision === "reuse_active_panel", "explicit panel overrides active");
  ok(dec.targetLaneIdx === 1, "routes to panel 2 not active panel 3");
}

section("Explicit new panel request");
{
  const utterance = "open a new panel and explain squeeze theorem";
  ok(R.detectExplicitNewPanelRequest(utterance) === true, "detects explicit new panel");
  const dec = R.shouldReuseActiveReasoningPanel({
    latestUserText: utterance,
    activePanelTitle: "Panel 1",
    activePanelExcerpt: "",
    activeLaneIdx: 0,
  });
  ok(dec.decision === "create_new_panel", "creates new panel for explicit new-panel ask");
}

section("Topic title on another panel must not hijack bare explain");
{
  const dec = R.shouldReuseActiveReasoningPanel({
    latestUserText: "explain squeeze theorem",
    activePanelTitle: "Panel 3",
    activePanelExcerpt: "",
    activeLaneIdx: 2,
  });
  ok(dec.decision !== "create_new_panel", "does not create panel for topic overlap alone");
  ok(dec.targetLaneIdx === 2, "stays on active panel despite Squeeze Theorem tab on panel 1");
}

section("No active panel falls back safely");
{
  const dec = R.shouldReuseActiveReasoningPanel({
    latestUserText: "explain squeeze theorem",
    activePanelTitle: "",
    activePanelExcerpt: "",
    activeLaneIdx: null,
  });
  ok(dec.decision === "create_new_panel", "no active panel → create fallback");
  ok(dec.reason === "no_active_panel_safe_fallback", "safe fallback reason", dec.reason);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
