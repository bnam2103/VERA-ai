// Smoke: Work Mode keyboard-only queue gate — must not use reasoning/TTS/global locks.
//
// Run:  node tests/smoke/__keyboard_queue_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8").replace(/\r\n/g, "\n");

const START = "function getKeyboardQueueBusyReason(fromQueue) {";
const END = "function countPendingWorkModeTypedTurns() {";
const s = APP_JS.indexOf(START);
const e = APP_JS.indexOf(END);
if (s < 0 || e < 0 || e <= s) {
  console.error("Could not locate keyboard queue helpers in app.js");
  process.exit(2);
}
const helpersSource = APP_JS.slice(s, e);

const sandboxSource = `
"use strict";
let keyboardSubmitInFlight = 0;
let normalInferInFlightForKeyboardGate = 0;
let workModeTypedVoiceInferDepth = 0;
const WORK_MODE_TYPED_VOICE_CHAIN_MAX = 12;
${helpersSource}
function simulate(opts = {}) {
  keyboardSubmitInFlight = Number(opts.keyboardSubmitInFlight) || 0;
  normalInferInFlightForKeyboardGate = Number(opts.normalInferInFlight) || 0;
  workModeTypedVoiceInferDepth = keyboardSubmitInFlight;
  const fromQueue = Boolean(opts.fromQueue);
  return {
    shouldQueue: shouldQueueKeyboardSubmit(fromQueue),
    busyReason: getKeyboardQueueBusyReason(fromQueue),
    chainSaturated: isWorkModeTypedVoiceInferChainSaturated(),
    keyboardSubmitInFlight,
    normalInferInFlight: normalInferInFlightForKeyboardGate,
  };
}
module.exports = { simulate, shouldQueueKeyboardSubmit, getKeyboardQueueBusyReason };
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "keyboard-queue-gate.js" });
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

section("1 — Idle typed message submits normally");
{
  const r = G.simulate({});
  ok(!r.shouldQueue, "idle: no queue", JSON.stringify(r));
}

section("2 — Normal /infer busy → keyboard queues");
{
  const r = G.simulate({ normalInferInFlight: 1 });
  ok(r.shouldQueue, "infer in flight: queue", JSON.stringify(r));
  ok(r.busyReason === "normal_infer_in_flight", "busy reason is infer", JSON.stringify(r));
}

section("3 — Reasoning panel generating does not gate keyboard queue");
{
  const r = G.simulate({});
  ok(!r.shouldQueue, "reasoning-only busy not in gate", JSON.stringify(r));
}

section("4 — Keyboard queued does not imply infer busy");
{
  const r = G.simulate({});
  ok(!r.shouldQueue, "queued alone does not block new submit gate", JSON.stringify(r));
}

section("5 — Multiple typed: chain tracks keyboard submit in flight");
{
  const r = G.simulate({ keyboardSubmitInFlight: 1 });
  ok(r.shouldQueue, "keyboard submit in flight queues next", JSON.stringify(r));
}

section("6 — Chain saturation is separate from queue gate");
{
  const idle = G.simulate({});
  const saturated = G.simulate({ keyboardSubmitInFlight: 12 });
  ok(!idle.chainSaturated, "idle chain not saturated");
  ok(saturated.chainSaturated, "depth 12 chain saturated");
  ok(saturated.shouldQueue, "saturated chain still queues (not immediate)");
}

section("7 — fromQueue bypasses queue gate");
{
  const r = G.simulate({ keyboardSubmitInFlight: 1, fromQueue: true });
  ok(!r.shouldQueue, "dequeued item may submit", JSON.stringify(r));
}

section("Source contracts — voice lifecycle untouched by queue enqueue");
const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
{
  ok(
    APP_JS.includes("[keyboard_queue_does_not_block_voice]"),
    "keyboard_queue_does_not_block_voice log present"
  );
  ok(
    APP_JS.includes("[voice_lifecycle_unchanged_check]"),
    "voice_lifecycle_unchanged_check log present"
  );
  ok(
    !/shouldQueueKeyboardSubmit\([\s\S]{0,200}workModeReasoningLaneBusy/.test(APP_JS),
    "queue gate does not read reasoning lane busy"
  );
  ok(
    !/shouldQueueKeyboardSubmit\([\s\S]{0,400}reasoningStreamActive/.test(APP_JS),
    "queue gate does not read reasoningStreamActive"
  );
  ok(
    APP_JS.includes("Do not set listening=false"),
    "typed submit does not force listening=false"
  );
  ok(
    INDEX_HTML.includes('id="vera-keyboard-queue-host"'),
    "keyboard queue host in index.html"
  );
  ok(
    /normalInferInFlightForKeyboardGate/.test(APP_JS),
    "normalInferInFlightForKeyboardGate counter present"
  );
  ok(
    /scheduleWorkModeKeyboardQueueDrainIfReady/.test(APP_JS),
    "drain tied to infer completion not reasoning stream"
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
