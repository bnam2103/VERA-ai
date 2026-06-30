// Smoke: checklist planning Stage-1 ack + generic unavailable suppression.
//
// Run:  node tests/smoke/__checklist_plan_ack_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8").replace(/\r\n/g, "\n");
const CHECKLIST_JS = fs
  .readFileSync(path.resolve(__dirname, "../../workmode/checklist.js"), "utf8")
  .replace(/\r\n/g, "\n");

const ACK_START = "function buildWorkModeReasoningStage1AckText(trimmed, opts = {}) {";
const ACK_END = "const MATH_ROUTER_ENABLED = false;";
const aStart = APP_JS.indexOf(ACK_START);
const aEnd = APP_JS.indexOf(ACK_END);
if (aStart < 0 || aEnd < 0) {
  console.error("Could not locate buildWorkModeReasoningStage1AckText in app.js");
  process.exit(2);
}
const ackSource = APP_JS.slice(aStart, aEnd);

const PLAN_START = "let activeChecklistPlanContext = null;";
const PLAN_END = "/** Voice/typed checklist help-plan";
const pStart = CHECKLIST_JS.indexOf(PLAN_START);
const pEnd = CHECKLIST_JS.indexOf(PLAN_END);
if (pStart < 0 || pEnd < 0) {
  console.error("Could not locate checklist plan context helpers in checklist.js");
  process.exit(2);
}
const planCtxSource = CHECKLIST_JS.slice(pStart, pEnd);

const sandboxSource = `
"use strict";
function classifyWorkModeTurnIntent() {
  return { turn_intent: "general" };
}
function extractExplicitPanelTopicLabelForAck() { return ""; }
${ackSource}
${planCtxSource}
module.exports = {
  buildWorkModeReasoningStage1AckText,
  beginActiveChecklistPlanContext,
  markChecklistPlanValidationFailed,
  markChecklistPlanRendered,
  markChecklistPlanAccepted,
  shouldSuppressChecklistPlanGenericUnavailable,
  resetActiveChecklistPlanContext,
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "checklist-plan-ack-helpers.js" });
const G = moduleStub.exports;

const GENERIC_UNAVAILABLE =
  "Reasoning is temporarily unavailable. Please try again later.";

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

section("Stage-1 ack text");
{
  const essay =
    "Can you help me plan an English essay that is due in two hours?";
  const checklist = "Can you help me plan using the checklist?";
  const essayAck = G.buildWorkModeReasoningStage1AckText(essay, { planningIntent: true });
  const checklistAck = G.buildWorkModeReasoningStage1AckText(checklist, {
    checklistPlanIntent: true,
  });
  ok(essayAck === "Let me lay out a plan.", "general essay planning ack", essayAck);
  ok(
    checklistAck === "Let me lay out a plan from your checklist.",
    "checklist planning ack",
    checklistAck
  );
  ok(
    checklistAck !== GENERIC_UNAVAILABLE,
    "checklist ack is not generic unavailable",
    checklistAck
  );
}

section("Generic unavailable suppression context");
{
  G.resetActiveChecklistPlanContext();
  ok(!G.shouldSuppressChecklistPlanGenericUnavailable(), "no context -> no suppress");

  G.beginActiveChecklistPlanContext({
    source: "test",
    userText: "plan using the checklist",
    isVoice: true,
  });
  G.markChecklistPlanAccepted();
  ok(G.shouldSuppressChecklistPlanGenericUnavailable(), "accepted plan suppresses generic unavailable");

  G.resetActiveChecklistPlanContext();
  G.beginActiveChecklistPlanContext({
    source: "test",
    userText: "plan using the checklist",
    isVoice: true,
  });
  G.markChecklistPlanValidationFailed(
    "I can make a plan for up to 5 main checklist items. You currently have 6. Please remove or group a few first."
  );
  ok(
    G.shouldSuppressChecklistPlanGenericUnavailable(),
    "validation failure suppresses generic unavailable"
  );

  G.resetActiveChecklistPlanContext();
  G.beginActiveChecklistPlanContext({
    source: "test",
    userText: "plan my checklist",
    isVoice: false,
  });
  G.markChecklistPlanAccepted();
  G.markChecklistPlanRendered();
  ok(
    G.shouldSuppressChecklistPlanGenericUnavailable(),
    "rendered plan suppresses generic unavailable"
  );
}

section("Failure copy is checklist-specific");
{
  const failMsg = "I couldn't create the checklist plan. Please try again.";
  ok(failMsg !== GENERIC_UNAVAILABLE, "checklist failure is not generic unavailable");
  ok(
    APP_JS.includes("CHECKLIST_PLAN_FAILURE_MESSAGE"),
    "app.js defines checklist-specific failure constant"
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
