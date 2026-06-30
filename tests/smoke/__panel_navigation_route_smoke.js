// Smoke: panel navigation phrases must not route to reasoning/open_and_stream.
//
// Run:  node tests/smoke/__panel_navigation_route_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8").replace(/\r\n/g, "\n");

const GO_TO_START = "function goToReasoningPanelQueryHeuristicUi(userText) {";
const HELPER_START = "/* ============================================================================\n * 2026-05-29 reasoning-gate helpers (Voice UI vs reasoning panel).";
const HELPER_END = "function isLikelyRequestShape(text) {";
const goStart = APP_JS.indexOf(GO_TO_START);
const startIdx = APP_JS.indexOf(HELPER_START);
const endIdx = APP_JS.indexOf(HELPER_END);
if (goStart < 0 || startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error("Could not locate panel navigation helpers in app.js");
  process.exit(2);
}
const goToSource = APP_JS.slice(goStart, startIdx);
const helpersSource = APP_JS.slice(startIdx, endIdx);

const MOCK_PANELS = [
  { visualIndex: 1, tabIndex: 0, label: "Two-Hour English Essay Plan" },
  { visualIndex: 2, tabIndex: 1, label: "Vietnam War" },
  { visualIndex: 3, tabIndex: 2, label: "Panel 3" },
];

const sandboxSource = `
"use strict";
let workModeLastSubstantiveUserText = "";
function detectMoveLatestVoiceTaskToReasoningIntent() { return { matched: false }; }
function cleanWorkModeActionQueryUi(q) {
  return String(q || "").replace(/^the\\s+/i, "").trim();
}
function getReasoningPanelOrder() { return MOCK_PANELS.slice(); }
function getActiveReasoningLaneIndex() { return 2; }
function resolveReasoningPanelTabIndexFromVisual1(v) {
  const e = MOCK_PANELS[v - 1];
  return e ? e.tabIndex : null;
}
function findReasoningPanelIndicesByTitleQuery(q) {
  const low = String(q || "").toLowerCase();
  const hits = MOCK_PANELS.filter(p => p.label.toLowerCase().includes(low)).map(p => p.visualIndex);
  return hits;
}
function activateReasoningTab() {}
function addReasoningTab() { return { dataset: { tabIndex: 3 } }; }
function isVeraWorkModeOn() { return true; }
function appModePrefix() { return "vera"; }
function detectImplicitChecklistMutation() { return { detected: false, count: 0, mutations: [] }; }
const MOCK_PANELS = ${JSON.stringify(MOCK_PANELS)};
${goToSource}
${helpersSource}
module.exports = {
  isExplicitWorkModePanelNavigationIntent,
  isExplicitReasoningPanelReference,
  parseWorkModePanelNavigationTarget,
  shouldDeferPanelNavigationShortcutForMultiAction,
  detectCompoundActionFamilies,
  isCompoundActionUtterance,
  detectPanelShortcutClauses,
  isSinglePanelShortcutActionClause,
  extractSubstantiveTopicBeforePanelPhrase,
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "panel-navigation-route-helpers.js" });
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

const NAV_PHRASES = [
  "go to the first panel",
  "move to the first panel",
  "switch to the first panel",
  "open the first panel",
  "go to panel 1",
  "switch to panel 2",
  "move to the second panel",
  "go back to the previous panel",
  "next panel",
  "previous panel",
  "Can you move to the first panel?",
  "Go to panel 2.",
  "Switch to the Vietnam War panel.",
];

section("Navigation intent detection");
for (const p of NAV_PHRASES) {
  ok(G.isExplicitWorkModePanelNavigationIntent(p), `nav intent: ${p}`);
}

section("Navigation must NOT become explicit panel reasoning target");
for (const p of NAV_PHRASES) {
  const ref = G.isExplicitReasoningPanelReference(p);
  ok(!ref.matched, `no reasoning ref: ${p}`, JSON.stringify(ref));
}
ok(
  G.extractSubstantiveTopicBeforePanelPhrase("Can you move to the first panel?") === "",
  "no substantive topic extracted from navigation phrase"
);

section("Parse navigation targets against mock panels");
{
  ok(
    G.parseWorkModePanelNavigationTarget("Go to panel 1.")?.visualIndex1Based === 1,
    "panel 1 -> visual 1 (Essay Plan slot)"
  );
  ok(
    G.isExplicitWorkModePanelNavigationIntent("Can you move to the first panel?") &&
      !G.isExplicitReasoningPanelReference("Can you move to the first panel?").matched,
    "Can you move to the first panel? classifies as navigation-only"
  );

  const tFirst = G.parseWorkModePanelNavigationTarget("Can you move to the first panel?");
  ok(tFirst?.kind === "switch" && tFirst.visualIndex1Based === 1, "first panel -> visual 1", JSON.stringify(tFirst));

  const tThird = G.parseWorkModePanelNavigationTarget("Can you go to third panel?");
  ok(tThird?.kind === "switch" && tThird.visualIndex1Based === 3, "third panel -> visual 3", JSON.stringify(tThird));

  const t2 = G.parseWorkModePanelNavigationTarget("Go to panel 2.");
  ok(t2?.kind === "switch" && t2.visualIndex1Based === 2, "panel 2 -> visual 2", JSON.stringify(t2));

  const tSwitch2 = G.parseWorkModePanelNavigationTarget("Can you switch to panel 2?");
  ok(tSwitch2?.kind === "switch" && tSwitch2.visualIndex1Based === 2, "switch to panel 2 -> visual 2", JSON.stringify(tSwitch2));

  const t3 = G.parseWorkModePanelNavigationTarget("Switch to the Vietnam War panel.");
  ok(t3?.kind === "switch" && t3.visualIndex1Based === 2, "title Vietnam War -> visual 2", JSON.stringify(t3));

  const t4 = G.parseWorkModePanelNavigationTarget("Open a new reasoning panel.");
  ok(t4?.kind === "open_new", "open new panel", JSON.stringify(t4));
}

section("Ordinal panel navigation (go/move/switch/open)");
{
  const ordinalPhrases = [
    ["Can you go to the second panel?", 2],
    ["Can you go to second panel?", 2],
    ["Can you move to the second panel?", 2],
    ["Can you switch to the second panel?", 2],
    ["Can you open the second panel?", 2],
    ["Can you go to panel 2?", 2],
  ];
  for (const [phrase, want] of ordinalPhrases) {
    ok(G.isExplicitWorkModePanelNavigationIntent(phrase), `nav intent: ${phrase}`);
    const t = G.parseWorkModePanelNavigationTarget(phrase);
    ok(
      t?.kind === "switch" && t.visualIndex1Based === want,
      `${phrase} -> visual ${want}`,
      JSON.stringify(t)
    );
  }
  const title = G.parseWorkModePanelNavigationTarget("Can you go to the Vietnam War panel?");
  ok(
    title?.kind === "switch" && title.visualIndex1Based === 2,
    "Vietnam War title -> visual 2",
    JSON.stringify(title)
  );
}

section("Reasoning targets must not become local navigation");
{
  ok(!G.isExplicitWorkModePanelNavigationIntent("Explain tennis in panel 3."), "explain in panel 3 not nav");
  const r1 = G.isExplicitReasoningPanelReference("Explain tennis in panel 3.");
  ok(r1.matched && r1.targetPanel === 3, "explain tennis in panel 3 is reasoning target", JSON.stringify(r1));

  ok(!G.isExplicitWorkModePanelNavigationIntent("Open this in panel 1."), "open this in panel 1 not nav");
  const r2 = G.isExplicitReasoningPanelReference("Open this in panel 1.");
  ok(r2.matched && r2.wasPronoun, "open this in panel 1 is deictic reasoning", JSON.stringify(r2));
  ok(G.parseWorkModePanelNavigationTarget("Open this in panel 1.") == null, "open this in panel 1 parse is null");
}

console.log(`\n${pass} passed, ${fail} failed`);
{
  const p = "Switch to panel 2 and play lofi.";
  ok(G.isExplicitWorkModePanelNavigationIntent(p), "compound still has nav intent");
  ok(G.shouldDeferPanelNavigationShortcutForMultiAction(p), "compound defers shortcut");
  ok(G.isCompoundActionUtterance(p), "compound utterance detected");
  const compound = G.detectCompoundActionFamilies(p);
  ok(compound.isCompound, "compound families detected", JSON.stringify(compound.families));
}

section("Single-action panel shortcuts are not deferred");
{
  const singles = [
    "Open a new panel.",
    "Can you open a new panel?",
    "Switch to the Vietnam War panel.",
    "Can you move to the first panel?",
    "Close panel 2.",
    "Can you go to third panel?",
  ];
  for (const p of singles) {
    ok(!G.shouldDeferPanelNavigationShortcutForMultiAction(p), `single not deferred: ${p}`);
    ok(!G.isCompoundActionUtterance(p), `not compound: ${p}`);
  }
}

section("Multi-panel compound commands defer local shortcut");
{
  const compounds = [
    "Open a new panel and close panel 2",
    "Open a new panel, close second panel and switch to Vietnam War panel",
    "Close panel 1 then open panel 3",
  ];
  for (const p of compounds) {
    ok(G.shouldDeferPanelNavigationShortcutForMultiAction(p), `compound defers: ${p}`);
    ok(G.isCompoundActionUtterance(p), `compound utterance: ${p}`);
    const clauses = G.detectPanelShortcutClauses(p);
    ok(clauses.length >= 2, `split into clauses: ${p}`, JSON.stringify(clauses));
    const panelActions = clauses.filter(G.isSinglePanelShortcutActionClause);
    ok(panelActions.length >= 2, `>=2 panel actions: ${p}`, JSON.stringify(panelActions));
  }
}

section("Cross-family compound defers (panel + search)");
{
  const p = "Open a new panel and search for weather in Seattle";
  ok(G.shouldDeferPanelNavigationShortcutForMultiAction(p), "panel + search defers");
  ok(G.isCompoundActionUtterance(p), "panel + search is compound");
}

section("Reasoning-in-panel is not compound navigation");
{
  ok(!G.isExplicitWorkModePanelNavigationIntent("Explain tennis in panel 3."), "explain in panel is not nav-only");
  ok(!G.isCompoundActionUtterance("Explain tennis in panel 3."), "explain in panel not compound nav");
  ok(!G.isExplicitWorkModePanelNavigationIntent("Open this in panel 1."), "open this in panel is not nav");
}
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
