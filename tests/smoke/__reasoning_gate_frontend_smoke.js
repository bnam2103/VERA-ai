// 2026-05-29 frontend reasoning-gate smoke.
//
// We extract the deterministic helpers (isExplicitReasoningPanelReference,
// isBriefExplanationModifier, isSimpleDefinitionQuestion,
// detectBroadComplexTopicFrontend) from app.js and run them in a vm sandbox
// against the spec's 13 test cases. The sandbox stub provides
// `workModeLastSubstantiveUserText` so the pronoun-resolution path can also
// be exercised.
//
// Run:  node tests/smoke/__reasoning_gate_frontend_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS_PATH = path.resolve(__dirname, "../../app.js");
const APP_JS = fs.readFileSync(APP_JS_PATH, "utf8");

// Slice out the helpers block we added (from the cluster header to the
// closing function that introduces the legacy navigation detector). That
// gives us the regexes + helpers without dragging in DOM/network code.
const HELPER_START = "/* ============================================================================\n * 2026-05-29 reasoning-gate helpers";
const HELPER_END = "function isExplicitWorkModePanelNavigationIntent(text) {";
const startIdx = APP_JS.indexOf(HELPER_START);
const endIdx = APP_JS.indexOf(HELPER_END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error("Could not locate reasoning-gate helpers block in app.js");
  process.exit(2);
}
const helpersSource = APP_JS.slice(startIdx, endIdx);

// Build a tiny sandbox: declare workModeLastSubstantiveUserText (the helpers
// read it directly), then eval the helpers, then export the symbols we want
// to inspect.
const sandboxSource = `
"use strict";
let workModeLastSubstantiveUserText = "";
${helpersSource}
module.exports = {
  isBriefExplanationModifier,
  isSimpleDefinitionQuestion,
  isExplicitReasoningPanelReference,
  detectBroadComplexTopicFrontend,
  resolveReasoningPanelTopicFromContext,
  setPriorTopic(t) { workModeLastSubstantiveUserText = t; },
  getPriorTopic() { return workModeLastSubstantiveUserText; }
};
`;
const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "reasoning-gate-helpers.js" });
const G = moduleStub.exports;

// ---- Tiny assertion harness ----
const RED = "\x1b[31m", GREEN = "\x1b[32m", YEL = "\x1b[33m", RST = "\x1b[0m";
let pass = 0, fail = 0;
const failed = [];
function section(label) { console.log(`\n${YEL}-- ${label} --${RST}`); }
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RST}  ${name}`); }
  else { fail++; failed.push(name); console.log(`  ${RED}FAIL${RST}  ${name}`); if (detail) console.log(`         ${String(detail).slice(0, 600)}`); }
}

// Mirror the routing logic from maybePrepareWorkModeReasoning's short-circuits
// so a single helper returns the gate decision the way the frontend would
// before consulting the backend.
function frontendGate(text) {
  const ref = G.isExplicitReasoningPanelReference(text);
  if (ref.matched) {
    let resolvedTopic = ref.topic || null;
    let priorUsed = false;
    if (!resolvedTopic && ref.wasPronoun) {
      const fromContext = G.resolveReasoningPanelTopicFromContext();
      if (fromContext) { resolvedTopic = fromContext; priorUsed = true; }
      else return { route: "voice_ui", reason: "explicit_panel_pronoun_without_prior_topic", resolved_topic: null, target_panel: null };
    }
    return { route: "reasoning_panel", reason: "explicit_panel_reference", resolved_topic: resolvedTopic, target_panel: ref.targetPanel ?? null, prior_topic_used: priorUsed };
  }
  if (G.isBriefExplanationModifier(text)) {
    return { route: "voice_ui", reason: "brief_explanation", resolved_topic: null, target_panel: null };
  }
  const simple = G.isSimpleDefinitionQuestion(text);
  if (simple.matched) {
    return { route: "voice_ui", reason: "simple_definition", resolved_topic: simple.topic || null, target_panel: null };
  }
  return null; // defer to backend classifier + heuristic
}

// ---- 13 SPEC TEST CASES ----
section("Spec cases — frontend deterministic short-circuits");
const CASES = [
  // utterance, expected_route, expected_reason (or null when deferred), expected_target_panel?
  ["can you tell me what tennis is?",                  "voice_ui",        "simple_definition",       null],
  ["what is tennis?",                                  "voice_ui",        "simple_definition",       null],
  ["explain tennis",                                   null,              null,                      null], // deferred — backend LLM will say voice_ui
  ["can you explain tennis in the reasoning panel?",   "reasoning_panel", "explicit_panel_reference", null],
  ["put an explanation of tennis in panel 2",          "reasoning_panel", "explicit_panel_reference", 2],
  ["explain the Vietnam War",                          null,              null,                      null], // deferred — backend's deterministic explain-with-complexity branch handles this
  ["briefly explain the Vietnam War",                  "voice_ui",        "brief_explanation",       null],
  ["what was the Vietnam War?",                        "voice_ui",        "simple_definition",       null],
  ["give me a detailed explanation of the Vietnam War",null,              null,                      null], // deferred — backend will return reasoning_panel
  ["solve this probability problem",                   null,              null,                      null], // deferred — backend complex_task_verb branch
  ["explain this step by step",                        null,              null,                      null], // deferred — heuristic + backend will route
  ["can you briefly explain inflation?",               "voice_ui",        "brief_explanation",       null],
  ["who is Serena Williams?",                          "voice_ui",        "simple_definition",       null]
];
for (const [utt, expectedRoute, expectedReason, expectedTarget] of CASES) {
  const result = frontendGate(utt);
  if (expectedRoute === null) {
    ok(result === null, `${JSON.stringify(utt)} → deferred to backend`, JSON.stringify(result));
    continue;
  }
  ok(result && result.route === expectedRoute,
     `${JSON.stringify(utt)} → ${expectedRoute}/${expectedReason}`,
     JSON.stringify(result));
  if (expectedReason && result) {
    ok(result.reason === expectedReason,
       `${JSON.stringify(utt)} → reason=${expectedReason}`,
       JSON.stringify(result));
  }
  if (expectedTarget != null && result) {
    ok(result.target_panel === expectedTarget,
       `${JSON.stringify(utt)} → target_panel=${expectedTarget}`,
       JSON.stringify(result));
  }
}

// ---- Pronoun resolution ----
section("Spec case 6 — pronoun resolution");
G.setPriorTopic("tennis");
const res6 = frontendGate("can you explain that in the reasoning panel?");
ok(res6 && res6.route === "reasoning_panel" && res6.reason === "explicit_panel_reference",
   "pronoun utterance → reasoning_panel",
   JSON.stringify(res6));
ok(res6 && res6.resolved_topic === "tennis",
   "pronoun resolves to 'tennis' from workModeLastSubstantiveUserText",
   JSON.stringify(res6));
ok(res6 && res6.prior_topic_used === true,
   "prior_topic_used=true",
   JSON.stringify(res6));

G.setPriorTopic("");
const res6b = frontendGate("explain that in the panel");
ok(res6b && res6b.route === "voice_ui" && res6b.reason === "explicit_panel_pronoun_without_prior_topic",
   "explicit-panel pronoun with no prior topic → voice_ui clarification",
   JSON.stringify(res6b));

// ---- Broad-topic detector ----
section("detectBroadComplexTopicFrontend recognizes broad topics");
for (const [text, expected] of [
  ["vietnam war",                        "history"],
  ["world war 2",                        "history"],
  ["french revolution",                  "history"],
  ["binomial lattice",                   "quant"],
  ["black-scholes",                      "quant"],
  ["climate change",                     "science"],
  ["theory of relativity",               "science"],
  ["the great depression of the 1930s",  "economics"],
  ["tennis",                             null],
  ["lasagna",                            null]
]) {
  const got = G.detectBroadComplexTopicFrontend(text);
  ok(got === expected, `detectBroadComplexTopicFrontend(${JSON.stringify(text)}) === ${JSON.stringify(expected)}`, `got ${JSON.stringify(got)}`);
}

// ---- Final tally ----
console.log(`\n${"=".repeat(60)}`);
console.log(`Total: ${pass + fail}   ${GREEN}PASS=${pass}${RST}   ${RED}FAIL=${fail}${RST}`);
if (failed.length) {
  console.log("\nFailing tests:");
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("All frontend reasoning-gate smoke tests passed.");
