/**
 * Smoke: Voice UI → Work Mode deictic panel routing helpers.
 * Run: node tests/smoke/__voice_to_panel_routing_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appJs = readFileSync(path.join(ROOT, "app/app.js"), "utf8");
const appJsNorm = appJs.replace(/\r\n/g, "\n");
const start = appJsNorm.indexOf("/* ============================================================================\n * 2026-05-29 reasoning-gate helpers (Voice UI vs reasoning panel).");
const end = appJsNorm.indexOf("function isExplicitWorkModePanelNavigationIntent(text) {");
const helpersSource = appJsNorm.slice(start, end);

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL ${msg}`);
  }
}

const sandbox = { console, module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(
  `"use strict";
let workModeLastSubstantiveUserText = "";
function isGenericExampleFollowUpText() { return false; }
function getActiveDomReasoningLaneId() { return "lane-active"; }
function getFocusedWorkModeLaneId() { return "lane-active"; }
${helpersSource}
module.exports = {
  isExplicitReasoningPanelReference,
  resolveTopicForExplicitPanelReference,
  extractSubstantiveTopicBeforePanelPhrase,
  rememberWorkModeSubstantiveUserText,
  detectCompoundActionFamilies,
  setPrior(t) { workModeLastSubstantiveUserText = t; },
};
`,
  sandbox
);
const G = sandbox.module.exports;

const nixonCombined =
  "is there any connection with president nixon? can you explain it in this panel?";
const topic = G.extractSubstantiveTopicBeforePanelPhrase(nixonCombined);
ok(
  topic.toLowerCase().includes("nixon"),
  "same-utterance topic extracted before deictic panel phrase"
);

const ref = G.isExplicitReasoningPanelReference("explain it in this panel");
ok(ref.matched, "explicit panel reference matches explain it in this panel");

G.setPrior("What was the Vietnam War connection to Cambodia?");
const resolved = G.resolveTopicForExplicitPanelReference("explain it in this panel", ref);
ok(resolved.topic.toLowerCase().includes("vietnam"), "deictic follow-up resolves prior voice topic");
ok(resolved.priorTopicUsed, "deictic follow-up marks prior topic used");

const combinedResolved = G.resolveTopicForExplicitPanelReference(
  nixonCombined,
  G.isExplicitReasoningPanelReference(nixonCombined)
);
G.setPrior("");
const combinedResolvedFresh = G.resolveTopicForExplicitPanelReference(
  nixonCombined,
  G.isExplicitReasoningPanelReference(nixonCombined)
);
ok(
  combinedResolvedFresh.topic.toLowerCase().includes("nixon"),
  "combined utterance resolves topic without prior turn"
);

const compoundNixon = G.detectCompoundActionFamilies(nixonCombined);
ok(
  !compoundNixon.isCompound,
  "Nixon + in this panel is not treated as compound panel+reasoning"
);
ok(
  compoundNixon.reason === "panel_routing_directive_single_intent" ||
    compoundNixon.families.includes("reasoning"),
  "Nixon panel routing classified as single reasoning intent"
);

const simpleExplain = G.detectCompoundActionFamilies("explain it simply");
ok(!simpleExplain.families.includes("panel"), "explain it simply has no panel family");

const openPanelExplain = G.detectCompoundActionFamilies(
  "open a reasoning panel and explain Nixon connection"
);
ok(openPanelExplain.isCompound, "open panel + explain remains compound navigation");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
