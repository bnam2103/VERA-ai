// Smoke: rant/emotional vent must not enter Work Mode reasoning via multiPart or vent veto.
//
// Run:  node tests/smoke/__reasoning_gate_vent_route_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8").replace(/\r\n/g, "\n");

const START = "function isLikelyRequestShape(text) {";
const END = "function logReasoningRouteDebug(payload) {";
const s = APP_JS.indexOf(START);
const e = APP_JS.indexOf(END);
if (s < 0 || e < 0 || e <= s) {
  console.error("Could not locate vent gate helpers in app.js");
  process.exit(2);
}
const helpersSource = APP_JS.slice(s, e);

const sandboxSource = `
"use strict";
function detectBroadComplexTopicFrontend() { return null; }
function isLikelyWorkModePlanningIntent(text) {
  const t = String(text || "").toLowerCase();
  return /\\b(help me plan|make a plan|create a plan)\\b/.test(t);
}
${helpersSource}
function computeHeuristicReasoning(trimmed) {
  const t = String(trimmed || "").toLowerCase();
  if (!t) return false;
  if (isLikelyWorkModePlanningIntent(trimmed)) return true;
  const multiPart = /\\b(step\\s+by\\s+step|in\\s+detail|deep\\s+dive|from\\s+scratch)\\b/i;
  const codeProblemWords =
    /\\b(code|coding|program|debug|bug|error|exception|stack trace|traceback|refactor|compile|build|runtime|test failing|unit test|integration test|typescript|javascript|python|java|c\\+\\+|sql|api endpoint|null pointer|undefined)\\b/;
  const writingTask =
    /\\b(write|draft|compose|polish|rewrite)\\b/.test(t) &&
    /\\b(email|essay|script|speech|letter|cover letter|proposal|statement|outline)\\b/.test(t);
  return multiPart.test(t) || codeProblemWords.test(t) || writingTask;
}
function simulateGate(trimmed, opts = {}) {
  const classifyRoute = Boolean(opts.classifyRoute);
  const gateForced = Boolean(opts.gateForced);
  const explicitPanel = Boolean(opts.explicitPanel);
  const artifact = hasExplicitWorkArtifactIntent(trimmed);
  const vent = looksLikePersonalStatementOrVenting(trimmed);
  const disclosure = looksLikePersonalDisclosureStatement(trimmed);
  const isRequest = isLikelyRequestShape(trimmed);
  const adjusted = vent.score + (isRequest ? 0 : 1);
  const adjustedIsVenting = adjusted >= 2;
  const personalNoTaskSignal = disclosure.isPersonalStatement || adjustedIsVenting;
  const explicitWorkModeTarget = gateForced || explicitPanel;
  const heuristicReasoning =
    opts.heuristicReasoning !== undefined
      ? Boolean(opts.heuristicReasoning)
      : computeHeuristicReasoning(trimmed);
  let effectiveClassifyRoute = classifyRoute;
  if (
    effectiveClassifyRoute &&
    personalNoTaskSignal &&
    !artifact.hasIntent &&
    !explicitWorkModeTarget
  ) {
    effectiveClassifyRoute = false;
  }
  let routeReasoning =
    gateForced || effectiveClassifyRoute || heuristicReasoning;
  const personalNoTaskBlocks =
    !gateForced &&
    personalNoTaskSignal &&
    !artifact.hasIntent &&
    !explicitWorkModeTarget;
  if (personalNoTaskBlocks && routeReasoning) {
    routeReasoning = false;
  }
  const oldMultiPartComma = /([,:;].+[,:;])/.test(String(trimmed || "").toLowerCase());
  return {
    routeReasoning,
    personalNoTaskBlocks,
    adjustedIsVenting,
    personalDisclosure: disclosure.isPersonalStatement,
    hasArtifact: artifact.hasIntent,
    oldMultiPartComma,
    heuristicReasoning,
  };
}
module.exports = {
  simulateGate,
  hasExplicitWorkArtifactIntent,
  looksLikePersonalStatementOrVenting,
  looksLikePersonalDisclosureStatement,
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "reasoning-gate-vent-helpers.js" });
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

const ORIGINAL_RANT =
  "That doesn't sound very exciting. Honestly, I was kind of thinking about going back to my country because I don't know, I just feel like I've been in the state for too long. I've been studying, working, and it's just very exhausting.";

section("A — Rant/emotional stays Voice UI");
const RANT_CASES = [
  "I'm exhausted and I kind of want to go back to my country.",
  "I've been studying and working nonstop and I feel burned out.",
  "I was thinking about going home because I'm tired.",
  "I don't know, I just feel tired of staying here.",
  "I'm annoyed with my project.",
];
for (const utt of RANT_CASES) {
  const r = G.simulateGate(utt, { classifyRoute: true, heuristicReasoning: true });
  ok(!r.routeReasoning, `no reasoning: ${utt.slice(0, 72)}`, JSON.stringify(r));
}
for (const utt of RANT_CASES) {
  const h = G.simulateGate(utt, { classifyRoute: false });
  ok(!h.heuristicReasoning, `comma clause does not heuristic-route: ${utt.slice(0, 48)}`);
  ok(!h.oldMultiPartComma, `old comma regex would not match: ${utt.slice(0, 48)}`);
}
{
  const short = G.simulateGate("That doesn't sound very exciting.", { classifyRoute: false });
  ok(!short.routeReasoning && !short.heuristicReasoning, "short complaint: no heuristic, no backend");
}

section("B — Explicit decide/plan/task enters Work Mode");
const ALLOW_CASES = [
  ["Can you help me decide whether I should go back to my country?", { classifyRoute: true }],
  ["Can you think through the pros and cons of going back home?", { classifyRoute: true }],
  ["Make a plan for what I should do if I'm burned out.", { classifyRoute: false }],
  ["Help me plan my essay.", { classifyRoute: false }],
  ["Explain this homework question.", { classifyRoute: true }],
  ["Debug my project error.", { classifyRoute: true }],
];
for (const [utt, opts] of ALLOW_CASES) {
  const r = G.simulateGate(utt, opts);
  ok(r.routeReasoning, `reasoning allowed: ${utt.slice(0, 72)}`, JSON.stringify(r));
}

section("C — Action commands (no artifact / no panel) blocked when venting");
{
  const r = G.simulateGate("Can you play lofi?", { classifyRoute: true, heuristicReasoning: false });
  ok(!r.routeReasoning || !r.adjustedIsVenting, "play lofi not vent-blocked incorrectly", JSON.stringify(r));
}

section("D — School mention without task verb stays Voice UI");
{
  const r = G.simulateGate("I have an essay.", { classifyRoute: true, heuristicReasoning: false });
  ok(!r.routeReasoning, "I have an essay — no auto reasoning", JSON.stringify(r));
}

section("Original rant regression");
{
  const r = G.simulateGate(ORIGINAL_RANT, { classifyRoute: true, heuristicReasoning: true });
  ok(!r.routeReasoning, "original rant stays Voice UI", JSON.stringify(r));
  ok(r.personalNoTaskBlocks, "personal/vent block would fire", JSON.stringify(r));
}

section("E — Personal disclosure / preference stays Voice UI");
const PERSONAL_BLOCK_CASES = [
  "I just want to let you know I love playing tennis and cooking.",
  "I like tennis.",
  "Just so you know, I'm interested in AI.",
  "I'm tired today.",
];
for (const utt of PERSONAL_BLOCK_CASES) {
  const r = G.simulateGate(utt, { classifyRoute: true, heuristicReasoning: true });
  ok(!r.routeReasoning, `Voice UI only: ${utt.slice(0, 72)}`, JSON.stringify(r));
  ok(r.personalDisclosure || r.adjustedIsVenting, `disclosure/vent detected: ${utt.slice(0, 48)}`, JSON.stringify(r));
}

section("F — Personal statement + task intent enters Work Mode");
const PERSONAL_ALLOW_CASES = [
  "I love tennis and cooking. Can you help me make a schedule for both?",
  "Compare tennis and cooking as hobbies.",
  "Write a paragraph about why I like tennis.",
];
for (const utt of PERSONAL_ALLOW_CASES) {
  const r = G.simulateGate(utt, { classifyRoute: true, heuristicReasoning: false });
  ok(r.routeReasoning, `Work Mode allowed: ${utt.slice(0, 72)}`, JSON.stringify(r));
  ok(r.hasArtifact, `artifact intent: ${utt.slice(0, 48)}`, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
