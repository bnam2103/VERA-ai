// Smoke: checklist help-plan voice/typed routing must not defer to casual /infer chat.
//
// Run:  node tests/smoke/__checklist_plan_route_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8").replace(/\r\n/g, "\n");
const CHECKLIST_JS = fs.readFileSync(path.resolve(__dirname, "../../workmode/checklist.js"), "utf8").replace(/\r\n/g, "\n");

const COMPOUND_START = "const _WMC_PANEL_FAMILY_RE =";
const COMPOUND_END = "try { window.detectCompoundActionFamilies = detectCompoundActionFamilies; } catch (_) {}";
const cStart = APP_JS.indexOf(COMPOUND_START);
const cEnd = APP_JS.indexOf(COMPOUND_END);
if (cStart < 0 || cEnd < 0) {
  console.error("Could not locate compound detector in app.js");
  process.exit(2);
}
const compoundSource = APP_JS.slice(cStart, cEnd + COMPOUND_END.length);

const PLAN_START = "const WORK_CHECKLIST_PLAN_SHORTCUT_RE =";
const PLAN_END = "async function executeChecklistPlanAction";
const pStart = CHECKLIST_JS.indexOf(PLAN_START);
const pEnd = CHECKLIST_JS.indexOf(PLAN_END);
if (pStart < 0 || pEnd < 0) {
  console.error("Could not locate checklist plan helpers in checklist.js");
  process.exit(2);
}
const planSource = CHECKLIST_JS.slice(pStart, pEnd);

const sandboxSource = `
"use strict";
function logChecklistPlanDebug() {}
const _REASONING_PANEL_IN_RE = /\\bin\\s+(?:the\\s+)?panel\\s+\\d+\\b/i;
function detectImplicitChecklistMutation() { return { detected: false, count: 0, mutations: [] }; }
function extractSubstantiveTopicBeforePanelPhrase() { return ""; }
${compoundSource}
${planSource}
module.exports = {
  detectCompoundActionFamilies,
  isWorkChecklistPlanShortcutIntent,
  shouldDeferChecklistPlanShortcut,
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "checklist-plan-route-helpers.js" });
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

const PHRASES = [
  "Can you help me plan using the checklist?",
  "Plan my checklist.",
  "Use the checklist to make a plan.",
  "make a plan from my checklist",
  "plan using the checklist",
  "help me plan using the checklist",
];

section("Intent detection");
for (const p of PHRASES) {
  ok(G.isWorkChecklistPlanShortcutIntent(p), `intent: ${p}`);
}
ok(!G.isWorkChecklistPlanShortcutIntent("sync the plan"), "sync the plan is not plan intent");

section("Single-intent must not defer (regression: reasoning+checklist_plan overlap)");
{
  const p = "Can you help me plan using the checklist?";
  const compound = G.detectCompoundActionFamilies(p);
  ok(!compound.isCompound, "not compound", JSON.stringify(compound));
  ok(!G.shouldDeferChecklistPlanShortcut(p), "shortcut not deferred");
}

section("Compound plan + music still defers");
{
  const p = "Plan using the checklist and play lofi.";
  const compound = G.detectCompoundActionFamilies(p);
  ok(compound.isCompound, "compound detected", JSON.stringify(compound.families));
  ok(G.shouldDeferChecklistPlanShortcut(p), "shortcut deferred for compound");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
