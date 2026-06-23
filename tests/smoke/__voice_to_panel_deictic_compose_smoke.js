// Smoke for deictic Voice UI → Reasoning Panel task composition (2026-06-21).
//
// Run:  node tests/smoke/__voice_to_panel_deictic_compose_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS_PATH = path.resolve(__dirname, "../../app.js");
const APP_JS = fs.readFileSync(APP_JS_PATH, "utf8");

const HELPER_START = "function detectVoiceToPanelDeictic(text) {";
const HELPER_END = "function detectVoiceToPanelActionReference(text) {";
const startIdx = APP_JS.indexOf(HELPER_START);
const endIdx = APP_JS.indexOf(HELPER_END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error("Could not locate deictic compose helpers in app.js");
  process.exit(2);
}
const helpersSource = APP_JS.slice(startIdx, endIdx);

const sandboxSource = `
"use strict";
let workModeLastSubstantiveUserText = "";
${helpersSource}
module.exports = {
  detectVoiceToPanelDeicticWritingHandoff,
  composeDeicticVoiceToPanelReasoningTask,
  extractSupplementalDetailsFromDeicticHandoff,
  setPriorTopic(t) { workModeLastSubstantiveUserText = t; }
};
`;
const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "deictic-compose-helpers.js" });
const G = moduleStub.exports;

const RED = "\x1b[31m", GREEN = "\x1b[32m", YEL = "\x1b[33m", RST = "\x1b[0m";
let pass = 0, fail = 0;
const failed = [];
function section(label) { console.log(`\n${YEL}-- ${label} --${RST}`); }
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RST}  ${name}`); }
  else { fail++; failed.push(name); console.log(`  ${RED}FAIL${RST}  ${name}`); if (detail) console.log(`         ${String(detail).slice(0, 600)}`); }
}

const TICKET_PRIOR =
  "I just got a ticket for speeding from a police officer. I feel like it was really unfair and thinking of filing a complaint.";
const LANDLORD_PRIOR =
  "My landlord charged me a cleaning fee that I think is unfair. I want to dispute it politely.";
const PROFESSOR_PRIOR =
  "I need to email my professor because I was sick and missed class.";
const LANTERN_PRIOR =
  "I'm working on a project called Blue Lantern. It is a study assistant with flashcards and spaced repetition.";

section("Case A — speeding ticket + CA-73 location");
G.setPriorTopic(TICKET_PRIOR);
const caseA = G.composeDeicticVoiceToPanelReasoningTask({
  userText:
    "can you help me write that in the reasoning space? location was on the highway ca73",
  resolvedReferent: TICKET_PRIOR,
  topicAnchor: TICKET_PRIOR
});
ok(Boolean(caseA), "Case A composes");
ok(/prior Voice UI context/i.test(caseA.composedTask), "Case A cites prior context");
ok(/ticket|speeding|complaint|police/i.test(caseA.composedTask), "Case A includes ticket referent");
ok(/ca-?73|highway/i.test(caseA.composedTask), "Case A includes location detail");
ok(!/^location was/i.test(caseA.composedTask.trim()), "Case A task is not location-only");

section("Case B — cleaning fee dispute + apartment detail");
G.setPriorTopic(LANDLORD_PRIOR);
const caseB = G.composeDeicticVoiceToPanelReasoningTask({
  userText: "Can you draft that in panel 1? Mention that I left the apartment clean.",
  resolvedReferent: LANDLORD_PRIOR,
  topicAnchor: LANDLORD_PRIOR
});
ok(Boolean(caseB), "Case B composes");
ok(/cleaning fee|dispute|landlord/i.test(caseB.composedTask), "Case B includes fee referent");
ok(/apartment clean/i.test(caseB.composedTask), "Case B includes apartment detail");

section("Case C — professor email, short tone");
G.setPriorTopic(PROFESSOR_PRIOR);
const caseC = G.composeDeicticVoiceToPanelReasoningTask({
  userText: "Write that in the reasoning panel. Keep it short.",
  resolvedReferent: PROFESSOR_PRIOR,
  topicAnchor: PROFESSOR_PRIOR
});
ok(Boolean(caseC), "Case C composes");
ok(/professor|sick|missed class/i.test(caseC.composedTask), "Case C includes email referent");
ok(/keep it short/i.test(caseC.composedTask), "Case C includes short-tone detail");

section("Case D — Blue Lantern architecture explain");
G.setPriorTopic(LANTERN_PRIOR);
const caseD = G.composeDeicticVoiceToPanelReasoningTask({
  userText: "Open the reasoning panel and explain that architecture more deeply.",
  resolvedReferent: LANTERN_PRIOR,
  topicAnchor: LANTERN_PRIOR
});
ok(Boolean(caseD), "Case D composes");
ok(/Blue Lantern|study assistant|flashcards/i.test(caseD.composedTask), "Case D includes project referent");
ok(/architecture/i.test(caseD.composedTask), "Case D keeps architecture focus");

section("Regression — should NOT compose");
G.setPriorTopic(TICKET_PRIOR);
ok(
  !G.composeDeicticVoiceToPanelReasoningTask({
    userText: "location was CA-73",
    resolvedReferent: TICKET_PRIOR
  }),
  "location-only follow-up does not compose"
);
ok(
  !G.detectVoiceToPanelDeicticWritingHandoff("write a location statement in panel 1"),
  "explicit location-only panel task is not deictic handoff"
);
ok(
  G.detectVoiceToPanelDeicticWritingHandoff(
    "can you help me write that in the reasoning space? location was on the highway ca73"
  ),
  "Case A utterance is detected as deictic handoff"
);

section("Supplemental detail extraction");
const sup = G.extractSupplementalDetailsFromDeicticHandoff(
  "can you help me write that in the reasoning space? location was on the highway ca73"
);
ok(/highway ca73/i.test(sup), "extracts location clause after question mark");

console.log(`\n${YEL}Summary:${RST} ${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log(`${RED}Failed:${RST}`);
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`${GREEN}All tests passed.${RST}`);
