// Smoke: panel-open count parsing must not route to reasoning or title navigation.
//
// Run: node tests/smoke/__panel_open_parse_smoke.mjs

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8").replace(/\r\n/g, "\n");

const GO_TO_START = "function goToReasoningPanelQueryHeuristicUi(userText) {";
const HELPER_START =
  "/* ============================================================================\n * 2026-05-29 reasoning-gate helpers (Voice UI vs reasoning panel).";
const HELPER_END = "function isLikelyRequestShape(text) {";
const goStart = APP_JS.indexOf(GO_TO_START);
const startIdx = APP_JS.indexOf(HELPER_START);
const endIdx = APP_JS.indexOf(HELPER_END);

if (goStart < 0 || startIdx < 0 || endIdx < 0) {
  console.error("Could not locate panel open helpers in app.js");
  process.exit(2);
}

const goToSource = APP_JS.slice(goStart, startIdx);
const helpersSource = APP_JS.slice(startIdx, endIdx);

const sandboxSource = `
"use strict";
let workModeLastSubstantiveUserText = "";
const REASONING_TABS_MAX = 8;
function detectMoveLatestVoiceTaskToReasoningIntent() { return { matched: false }; }
function detectImplicitChecklistMutation() { return null; }
function cleanWorkModeActionQueryUi(q) { return String(q || "").replace(/^the\\s+/i, "").trim(); }
function getReasoningPanelOrder() { return []; }
function getActiveReasoningLaneIndex() { return null; }
function resolveReasoningPanelTabIndexFromVisual1() { return null; }
function findReasoningPanelIndicesByTitleQuery() { return []; }
${goToSource}
${helpersSource}
function panelOpenShortcutWouldConsumeLocally(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (!parseWorkModePanelOpenRequest(raw)) return false;
  if (shouldDeferPanelOpenShortcutForMultiAction(raw)) return false;
  return true;
}
module.exports = {
  parseWorkModePanelOpenRequest,
  isPureWorkModePanelOpenRequest,
  isExplicitWorkModePanelNavigationIntent,
  isExplicitReasoningPanelReference,
  goToReasoningPanelQueryHeuristicUi,
  shouldDeferPanelOpenShortcutForMultiAction,
  isCompoundActionUtterance,
  detectPanelShortcutClauses,
  isSinglePanelShortcutActionClause,
  panelOpenShortcutWouldConsumeLocally,
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "panel-open-parse-helpers.js" });
const G = moduleStub.exports;

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

section("Pure panel open count parsing");
const openCases = [
  ["Can you open two panels?", 2],
  ["Can you open two new panels?", 2],
  ["open 2 new panels", 2],
  ["create two new panels", 2],
  ["add two new panels", 2],
  ["open a new panel", 1],
  ["Can you open up two new panels?", 2],
];
for (const [phrase, want] of openCases) {
  const parsed = G.parseWorkModePanelOpenRequest(phrase);
  ok(parsed?.count === want, `${phrase} -> count ${want}`, JSON.stringify(parsed));
  ok(G.isPureWorkModePanelOpenRequest(phrase), `pure open: ${phrase}`);
  ok(!G.isExplicitWorkModePanelNavigationIntent(phrase), `not navigation: ${phrase}`);
  ok(G.goToReasoningPanelQueryHeuristicUi(phrase) == null, `no title nav: ${phrase}`);
}

section("Reasoning/deictic targets are not pure panel.open");
{
  ok(!G.isPureWorkModePanelOpenRequest("Open this in panel 1."), "open this in panel 1 not pure open");
  const ref = G.isExplicitReasoningPanelReference("Open this in panel 1.");
  ok(ref.matched && ref.wasPronoun, "open this in panel 1 is deictic reasoning", JSON.stringify(ref));
  ok(!G.isPureWorkModePanelOpenRequest("Open the explanation in a new panel."), "content in new panel not pure open");
}

section("Compound panel open defers local shortcut");
{
  const multiPanel = "Open two new panels and close panel 2";
  ok(G.isSinglePanelShortcutActionClause("Open two new panels"), "open clause is panel action");
  ok(G.isSinglePanelShortcutActionClause("close panel 2"), "close clause is panel action");
  ok(G.shouldDeferPanelOpenShortcutForMultiAction(multiPanel), "multi-panel compound defers");
  ok(!G.panelOpenShortcutWouldConsumeLocally(multiPanel), "multi-panel compound does not consume locally");
}

section("Single panel open is not deferred");
{
  const single = "open a new panel";
  ok(G.parseWorkModePanelOpenRequest(single)?.count === 1, "single open parses");
  ok(!G.shouldDeferPanelOpenShortcutForMultiAction(single), "single open does not defer");
  ok(G.panelOpenShortcutWouldConsumeLocally(single), "single open consumes locally");
}

section("Cross-family compounds defer panel-open shortcut");
const deferCases = [
  "open a new panel and add check portfolio to my checklist",
  "What's the latest Nvidia stock price, open a new panel, and add check portfolio to my checklist.",
  "open a new panel, close panel 2, and switch to Vietnam War",
];
for (const phrase of deferCases) {
  ok(G.isCompoundActionUtterance(phrase), `compound detected: ${phrase.slice(0, 60)}`);
  ok(G.shouldDeferPanelOpenShortcutForMultiAction(phrase), `defer open shortcut: ${phrase.slice(0, 60)}`);
  ok(!G.panelOpenShortcutWouldConsumeLocally(phrase), `does not consume locally: ${phrase.slice(0, 60)}`);
}

section("Single-action panel open regressions");
for (const phrase of ["can you open two panels", "can you open two new panels"]) {
  const parsed = G.parseWorkModePanelOpenRequest(phrase);
  ok(parsed?.count === 2, `${phrase} -> count 2`, JSON.stringify(parsed));
  ok(!G.shouldDeferPanelOpenShortcutForMultiAction(phrase), `${phrase} does not defer`);
  ok(G.panelOpenShortcutWouldConsumeLocally(phrase), `${phrase} consumes locally`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
