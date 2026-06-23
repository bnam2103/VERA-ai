/* ============================================================================
 * __workmode_conversational_guard_smoke.mjs
 *
 * Verifies the FRONTEND half of the narrow Work Mode conversational / check-in
 * guard added 2026-06-13. The detector lives in app.js as:
 *
 *   const _CONVERSATIONAL_EXPLICIT_TRIGGER_RE = ...
 *   const _CONVERSATIONAL_MAX_WORDS = ...
 *   const _CONVERSATIONAL_PHRASES = [ ... ]
 *   function normalizeConversationalCheck(text) { ... }
 *   function detectWorkModeConversationalCheck(text) { ... }
 *
 * We slice that self-contained block out of app.js and eval it in an isolated
 * vm context (no DOM / network needed), then assert it mirrors the backend
 * CHAT_REASONING._detect_conversational_check verdicts.
 *
 * Run:  node tests/smoke/__workmode_conversational_guard_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const appJsPath = path.join(repoRoot, "app.js");
const appSrc = fs.readFileSync(appJsPath, "utf8");

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
  }
}

const START = "const _CONVERSATIONAL_EXPLICIT_TRIGGER_RE =";
const END = "function isBriefExplanationModifier(text) {";
const startIdx = appSrc.indexOf(START);
const endIdx = appSrc.indexOf(END);
if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
  console.log(
    `  FAIL  could not locate conversational guard block in app.js ` +
      `(startIdx=${startIdx} endIdx=${endIdx})`
  );
  process.exit(1);
}
const blockSrc = appSrc.slice(startIdx, endIdx);

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  blockSrc +
    "\nthis.detectWorkModeConversationalCheck = detectWorkModeConversationalCheck;" +
    "\nthis.normalizeConversationalCheck = normalizeConversationalCheck;",
  ctx
);

const detect = ctx.detectWorkModeConversationalCheck;
ok(typeof detect === "function", "detectWorkModeConversationalCheck extracted");

/* 1) False positives — must be caught (-> Voice UI). */
console.log("\n[1] conversational false-positives detected");
const falsePositives = [
  "hello",
  "hi",
  "hey",
  "can you hear me?",
  "hello hello can you hear me?",
  "Hello, hello, hello. Can you hear me?",
  "are you there?",
  "testing",
  "test test",
  "can you read me?",
  "do you hear me?",
  "what's up?",
  "thank you",
  "thanks",
  "okay",
  "ok",
  "got it"
];
for (const phrase of falsePositives) {
  ok(detect(phrase) === true, `detected: ${JSON.stringify(phrase)}`);
}

/* 2) Explicit Work Mode requests — must NOT be caught (explicit wins). */
console.log("\n[2] explicit Work Mode requests NOT caught");
const explicit = [
  "explain the Vietnam War in a new panel",
  "can you explain the Vietnam War in a new panel?",
  "compare BFS and DFS in panel 2",
  "use work mode to outline this project",
  "plan my study schedule in the reasoning panel",
  "open a new panel and explain dynamic programming"
];
for (const phrase of explicit) {
  ok(detect(phrase) === false, `not caught: ${JSON.stringify(phrase)}`);
}

/* 3) Real "can you ..." requests — must NOT be swallowed. */
console.log("\n[3] real requests NOT swallowed by guard");
const realRequests = [
  "can you solve this?",
  "can you explain the Vietnam War?",
  "can you make a plan?",
  "can you write an essay outline?",
  "can you compare BFS and DFS?",
  "can you add milk to my checklist?",
  "can you start a 10 minute timer?",
  "can you play music?",
  "can you turn up the volume?",
  "can you open a new panel?"
];
for (const phrase of realRequests) {
  ok(detect(phrase) === false, `not swallowed: ${JSON.stringify(phrase)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
