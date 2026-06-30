// Smoke: non–Work Mode keyboard submit wiring + gate logic.
//
// Run:  node tests/smoke/__normal_keyboard_submit_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8").replace(/\r\n/g, "\n");

const FN_START = "function normalFlowKeyboardSubmitBlockReason(";
const FN_END = "async function sendTextMessage()";
const fnStart = APP_JS.indexOf(FN_START);
const fnEnd = APP_JS.indexOf(FN_END);
if (fnStart < 0 || fnEnd < 0 || fnEnd <= fnStart) {
  console.error("Could not locate normalFlowKeyboardSubmitBlockReason in app.js");
  process.exit(2);
}
const gateSource = APP_JS.slice(fnStart, fnEnd);

const sandboxSource = `
"use strict";
${gateSource}
module.exports = { normalFlowKeyboardSubmitBlockReason };
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "normal-keyboard-gate.js" });
const { normalFlowKeyboardSubmitBlockReason } = moduleStub.exports;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RST = "\x1b[0m";
let pass = 0;
let fail = 0;

function ok(label) {
  pass += 1;
  console.log(`${GREEN}PASS${RST} ${label}`);
}

function bad(label, detail) {
  fail += 1;
  console.log(`${RED}FAIL${RST} ${label}${detail ? ` — ${detail}` : ""}`);
}

function assertBlockReason(opts, expected, label) {
  const got = normalFlowKeyboardSubmitBlockReason(opts);
  if (got === expected) ok(label);
  else bad(label, `expected "${expected}", got "${got}"`);
}

// --- Gate logic ---
assertBlockReason(
  { text: "hello", serverPipelineBusy: true },
  "server_pipeline_busy",
  "busy pipeline blocks normal chat"
);
assertBlockReason(
  { text: "hello", serverPipelineBusy: false },
  "",
  "non-work hello allowed when pipeline idle"
);
assertBlockReason(
  { text: "  hi  ", serverPipelineBusy: false },
  "",
  "trimmed text allowed"
);
assertBlockReason({ text: "" }, "empty_text", "empty text blocked");
assertBlockReason(
  { text: "hello", inVeraWorkMode: true, serverPipelineBusy: false },
  "work_mode_branch",
  "work mode uses separate branch"
);
assertBlockReason(
  { text: "hello", consecutiveUserTail: 3, serverPipelineBusy: false },
  "consecutive_user_tail",
  "three pending user turns blocked"
);
assertBlockReason(
  { text: "hello", consecutiveUserTail: 2, serverPipelineBusy: true },
  "server_pipeline_busy",
  "busy pipeline blocked after interrupt attempt"
);

// --- Wiring contract (source-level) ---
if (APP_JS.includes("function wireNormalKeyboardSubmitHandlers()")) {
  ok("wireNormalKeyboardSubmitHandlers is defined");
} else {
  bad("wireNormalKeyboardSubmitHandlers is defined");
}

if (APP_JS.includes("wireNormalKeyboardSubmitHandlers();")) {
  ok("wireNormalKeyboardSubmitHandlers is invoked at boot");
} else {
  bad("wireNormalKeyboardSubmitHandlers is invoked at boot");
}

if (/if\s*\(\s*!IS_MOBILE\s*\)\s*\{[\s\S]{0,400}sendTextMessage/.test(APP_JS)) {
  bad("keyboard submit still gated on !IS_MOBILE");
} else {
  ok("keyboard submit not gated on !IS_MOBILE");
}

if (APP_JS.includes('e.preventDefault()') && APP_JS.includes("wireNormalKeyboardSubmitHandlers")) {
  ok("Enter keydown uses preventDefault in keyboard wiring");
} else {
  bad("Enter keydown uses preventDefault in keyboard wiring");
}

if (APP_JS.includes("authFetch(`${API_URL}/text`")) {
  ok("non-work keyboard still posts to /text");
} else {
  bad("non-work keyboard still posts to /text");
}

if (APP_JS.includes('[Keyboard] blocked: server pipeline busy')) {
  ok("busy pipeline gives user-visible feedback");
} else {
  bad("busy pipeline gives user-visible feedback");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
