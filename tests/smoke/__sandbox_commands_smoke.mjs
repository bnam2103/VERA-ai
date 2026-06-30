/* ============================================================================
 * __sandbox_commands_smoke.mjs — Phase 0 Sandbox Commands core module tests
 *
 * Run:  node tests/smoke/__sandbox_commands_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const storagePath = path.join(repoRoot, "utils", "storage.js");
const sandboxPath = path.join(repoRoot, "sandbox", "sandboxCommands.js");
const executorPath = path.join(repoRoot, "actions", "clientActionExecutor.js");

let pass = 0;
let fail = 0;
const failed = [];

function ok(cond, label, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failed.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, label, a !== e ? `expected ${e} got ${a}` : "");
}

function makeMemoryStorage() {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
    clear: () => bag.clear(),
    _bag: bag,
  };
}

function loadModules() {
  const localStorage = makeMemoryStorage();
  const srcStorage = fs.readFileSync(storagePath, "utf8");
  const srcSandbox = fs.readFileSync(sandboxPath, "utf8");
  const srcExecutor = fs.readFileSync(executorPath, "utf8");
  const sandbox = {
    window: {},
    console,
    localStorage,
    sessionStorage: makeMemoryStorage(),
  };
  sandbox.window.localStorage = localStorage;
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  vm.createContext(sandbox);
  vm.runInContext(srcStorage, sandbox, { filename: "utils/storage.js" });
  vm.runInContext(srcSandbox, sandbox, { filename: "sandbox/sandboxCommands.js" });
  vm.runInContext(srcExecutor, sandbox, { filename: "actions/clientActionExecutor.js" });
  return sandbox;
}

console.log("-- Sandbox Commands Phase 0 smoke tests --\n");

const sb = loadModules();
const {
  normalizeSandboxTrigger,
  setSandboxCommandsEnabled,
  saveSandboxRoutines,
  validateSandboxTrigger,
  validateSandboxRoutine,
  upsertSandboxRoutine,
  matchSandboxRoutine,
  compileRoutineToActionPlan,
  tryCompileSandboxRoutinePlan,
  executeClientActionPlan,
} = sb.window;

ok(typeof normalizeSandboxTrigger === "function", "normalizeSandboxTrigger exported");
ok(typeof executeClientActionPlan === "function", "executeClientActionPlan exported");

const EXAMPLE_ROUTINE = {
  id: "routine_test_home",
  enabled: true,
  name: "Daddy's home",
  trigger: "chop chop daddy's home",
  match_mode: "exact",
  actions: [
    { type: "work_mode.open" },
    { type: "voice.say", text: "Welcome back, sir." },
    { type: "music.play", query: "Back in Black by AC/DC" },
  ],
};

console.log("\n-- Normalization --");
eq(
  normalizeSandboxTrigger("Chop Chop! Daddy's Home"),
  "chop chop daddys home",
  "punctuation/case-insensitive normalization"
);

console.log("\n-- Trigger validation --");
const validTrigger = validateSandboxTrigger(EXAMPLE_ROUTINE.trigger);
ok(validTrigger.ok, "example trigger passes validation");
const shortTrigger = validateSandboxTrigger("go home");
ok(!shortTrigger.ok && shortTrigger.reason === "trigger_too_short", "short trigger rejected");
const coreTrigger = validateSandboxTrigger("play music now");
ok(!coreTrigger.ok && coreTrigger.reason === "core_command_overlap", "core command trigger rejected");

console.log("\n-- Duplicate trigger rejection --");
saveSandboxRoutines([EXAMPLE_ROUTINE]);
const dup = validateSandboxTrigger(EXAMPLE_ROUTINE.trigger, { excludeRoutineId: "other_id" });
ok(!dup.ok && dup.reason === "duplicate_trigger", "duplicate trigger rejected");

console.log("\n-- Exact match --");
setSandboxCommandsEnabled(true);
const matched = matchSandboxRoutine("Chop Chop! Daddy's home");
ok(matched && matched.id === EXAMPLE_ROUTINE.id, "exact trigger matches normalized input");

console.log("\n-- Non-match cases --");
ok(matchSandboxRoutine("what does chop chop mean?") === null, "unrelated phrase does not trigger");
ok(matchSandboxRoutine("chop chop") === null, "partial phrase does not trigger");

const disabledRoutine = { ...EXAMPLE_ROUTINE, id: "routine_disabled", enabled: false, trigger: "alpha beta gamma delta" };
saveSandboxRoutines([EXAMPLE_ROUTINE, disabledRoutine]);
ok(matchSandboxRoutine("alpha beta gamma delta") === null, "disabled routine does not trigger");

setSandboxCommandsEnabled(false);
ok(matchSandboxRoutine("chop chop daddy's home") === null, "master toggle OFF prevents match");
setSandboxCommandsEnabled(true);

console.log("\n-- Routine validation + upsert --");
const upsertOk = upsertSandboxRoutine({
  id: "routine_new",
  trigger: "alpha bravo charlie delta",
  actions: [{ type: "work_mode.open" }],
});
ok(upsertOk.ok, "upsert valid routine");
const upsertDup = upsertSandboxRoutine({
  id: "routine_dup",
  trigger: EXAMPLE_ROUTINE.trigger,
  actions: [{ type: "work_mode.open" }],
});
ok(!upsertDup.ok && upsertDup.reasons?.includes("duplicate_trigger"), "upsert rejects duplicate trigger");

console.log("\n-- Compile action plan --");
const plan = compileRoutineToActionPlan(EXAMPLE_ROUTINE);
ok(plan.source === "sandbox_routine", "plan source is sandbox_routine");
ok(plan.routine_id === EXAMPLE_ROUTINE.id, "plan carries routine_id");
eq(
  plan.actions.map((a) => a.type),
  ["work_mode.open", "voice.say", "music.play"],
  "compiled actions preserve order and types"
);
ok(plan.actions[1].payload.text === "Welcome back, sir.", "voice.say payload compiled");
ok(plan.actions[2].payload.query === "Back in Black by AC/DC", "music.play payload compiled");

const compiledTry = tryCompileSandboxRoutinePlan("chop chop daddy's home");
ok(compiledTry.matched && compiledTry.plan?.actions?.length === 3, "tryCompileSandboxRoutinePlan matches + compiles");

console.log("\n-- Executor sequential + partial failure --");
const calls = [];
const execPlan = {
  source: "sandbox_routine",
  routine_id: "routine_exec_test",
  actions: [
    { id: "a0", type: "work_mode.open", payload: {} },
    {
      id: "a1",
      type: "voice.say",
      payload: { text: "Welcome back, sir." },
    },
    { id: "a2", type: "music.play", payload: { query: "Back in Black" } },
  ],
};

const execResult = await executeClientActionPlan(execPlan, {
  deps: {
    setVeraWorkMode: (on) => {
      calls.push({ type: "work_mode.open", on });
    },
    speakText: (text) => {
      calls.push({ type: "voice.say", text });
    },
    applyActionPayload: async (data) => {
      calls.push({ type: "music.play", query: data?.action_payload?.query || null });
      throw new Error("music_failed");
    },
  },
});

ok(calls.length === 3, "executor invoked three handlers in order", `calls=${JSON.stringify(calls.map((c) => c.type))}`);
eq(
  calls.map((c) => c.type),
  ["work_mode.open", "voice.say", "music.play"],
  "executor runs actions in order"
);
ok(execResult.successes === 2, "two actions succeeded", `successes=${execResult.successes}`);
ok(execResult.failures === 1, "one action failed", `failures=${execResult.failures}`);
ok(execResult.results[2].ok === false, "failed action recorded");
ok(execResult.results[0].ok === true && execResult.results[1].ok === true, "independent actions still succeed");

console.log("\n-- Full routine compile + execute (mock) --");
const fullPlan = compileRoutineToActionPlan(EXAMPLE_ROUTINE);
const fullCalls = [];
const fullExec = await executeClientActionPlan(fullPlan, {
  deps: {
    setVeraWorkMode: () => fullCalls.push("work_mode.open"),
    speakText: (text) => fullCalls.push(`voice.say:${text}`),
    applyActionPayload: async () => fullCalls.push("music.play"),
  },
});
ok(fullExec.ok, "full example routine executes cleanly with mocks");
eq(
  fullCalls,
  ["work_mode.open", "voice.say:Welcome back, sir.", "music.play"],
  "full routine order: work_mode.open + voice.say + music.play"
);

console.log("\n============================================================");
console.log(`Total: ${pass + fail}   PASS=${pass}   FAIL=${fail}`);
if (fail === 0) {
  console.log("All Sandbox Commands Phase 0 smoke tests passed.");
} else {
  console.log("Failed:");
  for (const name of failed) console.log(`  - ${name}`);
  process.exit(1);
}
