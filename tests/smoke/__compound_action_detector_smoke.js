// 2026-05-29 frontend compound-action-families detector smoke.
//
// Extracts detectCompoundActionFamilies + its supporting regexes from
// app.js and runs them in a vm sandbox against the spec's 7 manual test
// cases plus negative/single-family controls. This is the frontend gate
// that decides whether to defer to the backend deterministic planner
// instead of letting the legacy planWorkModeMultiAction or the reasoning
// gate consume a compound transcript.
//
// Run:  node tests/smoke/__compound_action_detector_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS_PATH = path.resolve(__dirname, "../../app.js");
const APP_JS = fs.readFileSync(APP_JS_PATH, "utf8");

// Slice the compound-detector block out of app.js.
const HELPER_START = "/**\n * 2026-05-29 spec PART 4 — compound-action-families detector.";
const HELPER_END = "try { window.detectCompoundActionFamilies";
const startIdx = APP_JS.indexOf(HELPER_START);
const endIdx = APP_JS.indexOf(HELPER_END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.error("Could not locate compound-detector block in app.js");
  process.exit(2);
}
const helpersSource = APP_JS.slice(startIdx, endIdx);

const sandboxSource = `
"use strict";
${helpersSource}
module.exports = { detectCompoundActionFamilies };
`;
const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "compound-detector.js" });
const { detectCompoundActionFamilies } = moduleStub.exports;

// ---- Tiny assertion harness ----
const RED = "\x1b[31m", GREEN = "\x1b[32m", YEL = "\x1b[33m", RST = "\x1b[0m";
let pass = 0, fail = 0;
const failed = [];
function section(label) { console.log(`\n${YEL}-- ${label} --${RST}`); }
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RST}  ${name}`); }
  else { fail++; failed.push(name); console.log(`  ${RED}FAIL${RST}  ${name}`); if (detail) console.log(`         ${String(detail).slice(0, 600)}`); }
}

// ---- Spec PART 4 manual cases (compound = MUST defer) ----
section("Compound transcripts (PART 4 spec cases) — defer to backend planner");
const COMPOUND_CASES = [
  {
    text: "Can you go to panel 2, explain the Vietnam War and play the lo-fi mix?",
    expected_families_subset: ["panel", "reasoning", "music"],
  },
  {
    text: "Go to panel 3, explain the squeeze theorem, and play lo-fi.",
    expected_families_subset: ["panel", "reasoning", "music"],
  },
  {
    text: "Explain the Vietnam War in panel 2 and play lo-fi.",
    expected_families_subset: ["panel", "reasoning", "music"],
  },
  {
    text: "Play lo-fi and explain the Vietnam War in panel 2.",
    expected_families_subset: ["panel", "reasoning", "music"],
  },
  {
    text: "Can you play the lo-fi mix? Also explain the Vietnam War to me.",
    expected_families_subset: ["music", "reasoning"],
  },
  {
    text: "Go to panel 2 and explain the Vietnam War.",
    expected_families_subset: ["panel", "reasoning"],
  },
  {
    text: "Explain the Vietnam War and play lo-fi.",
    expected_families_subset: ["reasoning", "music"],
  },
];
for (const c of COMPOUND_CASES) {
  const r = detectCompoundActionFamilies(c.text);
  ok(r.isCompound === true, `compound=true: ${c.text.slice(0, 60)}…`, JSON.stringify(r));
  for (const fam of c.expected_families_subset) {
    ok(r.families.includes(fam), `  includes family "${fam}"`, JSON.stringify(r.families));
  }
}

// ---- Negative controls (single-family = MUST NOT defer) ----
section("Single-family transcripts — must NOT defer");
const SINGLE_CASES = [
  // Pure reasoning
  { text: "Explain the Vietnam War", expectedFamilies: ["reasoning"] },
  { text: "What is tennis?", expectedFamilies: [] }, // no action verbs
  { text: "Tell me about tennis", expectedFamilies: ["reasoning"] },
  // Pure panel
  { text: "Go to panel 2", expectedFamilies: ["panel"] },
  { text: "Open a new panel", expectedFamilies: ["panel"] },
  { text: "Close panel 1", expectedFamilies: ["panel"] },
  // Pure music
  { text: "Play Feather by Sabrina Carpenter", expectedFamilies: ["music"] },
  { text: "Pause the music", expectedFamilies: ["music"] },
  { text: "Turn up the volume", expectedFamilies: ["music"] },
  // Pure timer
  { text: "Set a timer for 10 seconds", expectedFamilies: ["timer"] },
  { text: "Cancel the timer", expectedFamilies: ["timer"] },
  // Pure checklist
  { text: "Add milk to the checklist", expectedFamilies: ["checklist"] },
  { text: "Remove the first item from the checklist", expectedFamilies: ["checklist"] },
];
for (const c of SINGLE_CASES) {
  const r = detectCompoundActionFamilies(c.text);
  ok(r.isCompound === false, `compound=false: ${c.text.slice(0, 60)}…`, JSON.stringify(r));
  ok(JSON.stringify([...r.families].sort()) === JSON.stringify([...c.expectedFamilies].sort()),
     `  families == ${JSON.stringify(c.expectedFamilies)}`,
     JSON.stringify(r.families));
}

// ---- Edge cases that historically tripped legacy splitters ----
section("Edge cases — must NOT false-split");
const FALSE_POSITIVES = [
  // "and" inside a music title isn't compound.
  "Play rock and roll",
  // "and" inside a description isn't compound.
  "What is supply and demand?",
  // Reasoning topic that mentions panels/music conceptually but isn't a command.
  "Explain how Spotify recommendation works",
];
for (const text of FALSE_POSITIVES) {
  const r = detectCompoundActionFamilies(text);
  // We allow it to flag 1 family; we just don't want isCompound=true.
  ok(r.isCompound === false || r.families.length <= 1,
     `compound=false (or only 1 family): ${text.slice(0, 60)}`,
     JSON.stringify(r));
}

// ---- Implicit panel via "in panel N" ----
section("Implicit panel via 'in panel N' suffix");
const r1 = detectCompoundActionFamilies("Explain the Vietnam War in panel 2");
ok(r1.isCompound === true, "'explain X in panel 2' is compound (reasoning + panel)", JSON.stringify(r1));
ok(r1.families.includes("panel"), "  includes 'panel' (implicit)", JSON.stringify(r1.families));
ok(r1.families.includes("reasoning"), "  includes 'reasoning'", JSON.stringify(r1.families));

// ---- Final tally ----
console.log(`\n${"=".repeat(60)}`);
console.log(`Total: ${pass + fail}   ${GREEN}PASS=${pass}${RST}   ${RED}FAIL=${fail}${RST}`);
if (failed.length) {
  console.log("\nFailing tests:");
  for (const n of failed) console.log(`  - ${n}`);
  process.exit(1);
}
process.exit(0);
