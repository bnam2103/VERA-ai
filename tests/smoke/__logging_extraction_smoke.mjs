/* ============================================================================
 * __logging_extraction_smoke.mjs
 *
 * Verifies the Stage 3 extraction of pure console / debug-log helpers from
 * app.js into utils/logging.js. Does NOT exercise the real DOM / fetch
 * pipeline — just confirms:
 *   1. utils/logging.js parses and runs in a classic-script-like context.
 *   2. The 11 helpers required by the spec are exported as both bare
 *      identifiers (shared script scope) and `window.*` aliases.
 *   3. Each helper preserves its EXACT console label and gating flag.
 *   4. Late-bound bare-identifier references in app.js
 *      (`voiceUxTurn`, `voiceTranscriptDebugEnabled`, `_readLatestUserBubbleText`,
 *      `appModePrefix`, `_veraBargeInDebug`, `_bargeInDebugCaptureEvent`)
 *      resolve through the shared global lexical environment at CALL time.
 *   5. `_turnTextIntegrityEnabled` reads via safeGetLocalStorage (so
 *      utils/storage.js is a required dependency at load order).
 *   6. `_nextVeraTurnId` produces unique, monotonic IDs.
 *   7. `logTurnTextIntegrity` computes `bubble_eq_router`, `router_eq_backend`,
 *      `all_three_eq` correctly and returns the turn_id.
 *   8. app.js no longer defines the moved functions (must-not-match).
 *   9. index.html loads utils/logging.js AFTER utils/storage.js and BEFORE
 *      app.js (load-order contract for shared global lexical bindings).
 *
 * Run:  node tests/smoke/__logging_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const utilsLoggingPath = path.join(repoRoot, "utils", "logging.js");
const indexHtmlPath = path.join(repoRoot, "app/index.html");
const appJsPath = path.join(repoRoot, "app/app.js");

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
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label}\n         expected ${e}\n         actual   ${a}`);
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

function makeCapturingConsole() {
  const calls = [];
  const cap = {
    log: (...args) => calls.push({ level: "log", args }),
    info: (...args) => calls.push({ level: "info", args }),
    warn: (...args) => calls.push({ level: "warn", args }),
    error: (...args) => calls.push({ level: "error", args }),
  };
  cap._calls = calls;
  cap._clear = () => { calls.length = 0; };
  return cap;
}

function makeSandbox({ storage = makeMemoryStorage(), session = makeMemoryStorage(), now = 1000 } = {}) {
  const cap = makeCapturingConsole();
  const sandbox = {
    window: {},
    console: cap,
    localStorage: storage,
    sessionStorage: session,
    performance: { now: () => now },
    /* Late-bound runtime state that the moved loggers expect to find via
     * the shared global lexical environment AT CALL TIME. The sandbox
     * starts these as null/undefined and the tests fill them in before
     * exercising the helpers (mirrors real-world app.js load order). */
    voiceUxTurn: null,
    voiceTranscriptDebugEnabled: () => true,
    _readLatestUserBubbleText: () => null,
    appModePrefix: () => "",
    _veraBargeInDebug: null,
    _bargeInDebugCaptureEvent: () => {},
  };
  sandbox.window.localStorage = storage;
  sandbox.window.sessionStorage = session;
  vm.createContext(sandbox);
  /* utils/storage.js must load FIRST because _turnTextIntegrityEnabled
   * inside utils/logging.js calls safeGetLocalStorage. */
  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, {
    filename: "utils/storage.js",
  });
  vm.runInContext(fs.readFileSync(utilsLoggingPath, "utf8"), sandbox, {
    filename: "utils/logging.js",
  });
  return { sandbox, console: cap };
}

/* ------------------------------------------------------------------
 * Suite A — utils/logging.js loads in a classic-script-like context
 * ------------------------------------------------------------------ */
console.log("-- Suite A - utils/logging.js loads in a classic-script-like context --");

const REQUIRED_HELPERS = [
  "logInputLimitDebug",
  "logVeraCapabilityFailure",
  "logCapabilityFallbackDebug",
  "logBargeInLatencyDebug",
  "logInterruptTranscriptDebug",
  "logVoiceFirstAudio",
  "logVoiceMainReplyAudio",
  "logVoicePipe",
  "logVoiceTranscript",
  "logFinalTranscriptSentToLlm",
  "logTurnTextIntegrity",
];
/* The cohesive turn-text-integrity bundle came over with logTurnTextIntegrity. */
const REQUIRED_INTERNAL_BARE = [
  "_turnTextIntegrityEnabled",
  "_nextVeraTurnId",
  "_veraTurnSeq",
];

const A = makeSandbox();
for (const name of REQUIRED_HELPERS) {
  ok(
    typeof A.sandbox.window[name] === "function",
    `window.${name} is a function after utils/logging.js load`
  );
}
for (const name of REQUIRED_HELPERS) {
  ok(
    vm.runInContext(`typeof ${name}`, A.sandbox) === "function",
    `bare ${name} resolves via shared global lexical env`
  );
}
for (const name of REQUIRED_INTERNAL_BARE) {
  const t = vm.runInContext(`typeof ${name}`, A.sandbox);
  ok(
    t === "function" || t === "number",
    `internal ${name} also resolved bare-name (typeof=${t})`
  );
}

/* ------------------------------------------------------------------
 * Suite B — logVeraCapabilityFailure label + payload merge
 * ------------------------------------------------------------------ */
console.log("\n-- Suite B - logVeraCapabilityFailure label + payload merge --");

A.console._clear();
A.sandbox.window.logVeraCapabilityFailure("listening", "mic_blocked", { code: 42, feature: "ignored" });
const capRows = A.console._calls;
eq(capRows.length, 1, "exactly one console row");
eq(capRows[0].level, "warn", "uses console.warn");
eq(capRows[0].args[0], "[capability_failure]", "exact bracketed label preserved");
eq(capRows[0].args[1].feature, "listening", "feature wins over extra-collision");
eq(capRows[0].args[1].reason, "mic_blocked", "reason carried through");
eq(capRows[0].args[1].code, 42, "extra fields merged in");

/* ------------------------------------------------------------------
 * Suite C — logCapabilityFallbackDebug structure
 * ------------------------------------------------------------------ */
console.log("\n-- Suite C - logCapabilityFallbackDebug structure --");

A.console._clear();
A.sandbox.window.logCapabilityFallbackDebug({
  capability: "reasoning",
  failure_kind: "api_error",
  should_show_bubble: true,
  turn_id: "turn_x",
  source_function: "test",
  raw_error_message: "HTTP 413",
});
const fbRows = A.console._calls;
eq(fbRows.length, 1, "exactly one console row");
eq(fbRows[0].args[0], "[CAPABILITY_FALLBACK_DEBUG]", "exact bracketed label preserved");
eq(fbRows[0].args[1].capability, "reasoning", "capability passed through");
eq(fbRows[0].args[1].should_show_bubble, true, "boolean coerced");
eq(fbRows[0].args[1].turn_id, "turn_x", "turn_id passed through");
eq(fbRows[0].args[1].raw_error_message, "HTTP 413", "raw_error_message truncated to 200 chars");

/* Defaults when fields missing. */
A.console._clear();
A.sandbox.window.logCapabilityFallbackDebug();
eq(A.console._calls[0].args[1].capability, "", "missing capability becomes ''");
eq(A.console._calls[0].args[1].turn_id, null, "missing turn_id becomes null");
eq(A.console._calls[0].args[1].raw_error_message, null, "missing raw_error_message becomes null");

/* ------------------------------------------------------------------
 * Suite D — logBargeInLatencyDebug + logInterruptTranscriptDebug labels
 * ------------------------------------------------------------------ */
console.log("\n-- Suite D - barge-in + interrupt-transcript labels --");

A.console._clear();
A.sandbox.window.logBargeInLatencyDebug("vad_fire", { dt_ms: 17 });
eq(A.console._calls[0].args[0], "[BARGE_IN_LATENCY_DEBUG][vad_fire]", "barge-in tag uses [phase] suffix");
eq(A.console._calls[0].args[1].dt_ms, 17, "barge-in extra field carried through");
ok(typeof A.console._calls[0].args[1].timestamp === "string", "barge-in includes ISO timestamp");

A.console._clear();
A.sandbox.window.logInterruptTranscriptDebug("classification", { kind: "cancel_only" });
eq(A.console._calls[0].args[0], "[INTERRUPT_TRANSCRIPT_DEBUG][classification]", "interrupt-transcript tag uses [phase] suffix");
eq(A.console._calls[0].args[1].kind, "cancel_only", "interrupt-transcript extra field carried through");

/* Late-bound bridge to _veraBargeInDebug overlay capture. */
let captured = null;
A.sandbox._veraBargeInDebug = { enabled: true };
A.sandbox._bargeInDebugCaptureEvent = (phase, payload) => { captured = { phase, payload }; };
A.console._clear();
A.sandbox.window.logInterruptTranscriptDebug("post_asr", { text: "hi" });
ok(captured && captured.phase === "post_asr", "overlay capture invoked when _veraBargeInDebug.enabled is true");
A.sandbox._veraBargeInDebug = null;

/* ------------------------------------------------------------------
 * Suite E — voice UX timing helpers respect voiceUxTurn lifecycle
 * ------------------------------------------------------------------ */
console.log("\n-- Suite E - voice UX timing helpers --");

/* No voiceUxTurn → silent no-op. */
A.console._clear();
A.sandbox.voiceUxTurn = null;
A.sandbox.window.logVoiceFirstAudio("main-reply");
A.sandbox.window.logVoiceMainReplyAudio();
A.sandbox.window.logVoicePipe("first-chunk");
eq(A.console._calls.length, 0, "no logs when voiceUxTurn is null");

/* With voiceUxTurn → emits expected labels, sets one-shot flags. Use
 * speechEndAt=1 (truthy) because logVoicePipe gates on `!speechEndAt`
 * and would silently skip a strict-0 value (preserved app.js behavior). */
A.sandbox.voiceUxTurn = {
  speechEndAt: 1,
  firstAudioLogged: false,
  mainReplyLogged: false,
};
A.console._clear();
A.sandbox.window.logVoiceFirstAudio("main-reply");
A.sandbox.window.logVoiceFirstAudio("main-reply"); /* second call must no-op (idempotent) */
eq(A.console._calls.length, 1, "logVoiceFirstAudio is one-shot per turn");
ok(
  String(A.console._calls[0].args[0]).startsWith("[UX][VOICE] SpeechEnd→FirstAudio="),
  "logVoiceFirstAudio uses the SpeechEnd→FirstAudio label"
);

A.console._clear();
A.sandbox.window.logVoiceMainReplyAudio();
A.sandbox.window.logVoiceMainReplyAudio();
eq(A.console._calls.length, 1, "logVoiceMainReplyAudio is one-shot per turn");
ok(
  String(A.console._calls[0].args[0]).startsWith("[UX][VOICE] SpeechEnd→MainReplyAudio="),
  "logVoiceMainReplyAudio uses the SpeechEnd→MainReplyAudio label"
);

A.console._clear();
A.sandbox.window.logVoicePipe("first-chunk-decoded");
ok(
  String(A.console._calls[0].args[0]).startsWith("[UX][VOICE][PIPE] first-chunk-decoded"),
  "logVoicePipe uses the [UX][VOICE][PIPE] label with the provided phase"
);

/* ------------------------------------------------------------------
 * Suite F — voice transcript loggers respect voiceTranscriptDebugEnabled
 * ------------------------------------------------------------------ */
console.log("\n-- Suite F - voice transcript loggers respect gate --");

A.sandbox.voiceTranscriptDebugEnabled = () => false;
A.console._clear();
A.sandbox.window.logVoiceTranscript("final", "hello", { path: "main-ndjson" });
A.sandbox.window.logFinalTranscriptSentToLlm("ndjson", "hello");
eq(A.console._calls.length, 0, "gate=false suppresses both transcript loggers");

A.sandbox.voiceTranscriptDebugEnabled = () => true;
A.console._clear();
A.sandbox.window.logVoiceTranscript("final", "hello", { path: "main-ndjson" });
A.sandbox.window.logFinalTranscriptSentToLlm("ndjson", "hello");
eq(A.console._calls.length, 2, "gate=true allows both transcript loggers");
eq(A.console._calls[0].args[0], "[VOICE][TRANSCRIPT]", "logVoiceTranscript uses [VOICE][TRANSCRIPT] label");
eq(A.console._calls[0].args[1].phase, "final", "logVoiceTranscript carries phase");
eq(A.console._calls[0].args[1].path, "main-ndjson", "logVoiceTranscript carries meta path");
eq(A.console._calls[0].args[1].text, "hello", "logVoiceTranscript carries text");
eq(A.console._calls[1].args[0], "[VOICE][LLM-INPUT]", "logFinalTranscriptSentToLlm uses [VOICE][LLM-INPUT] label");
eq(A.console._calls[1].args[1].path, "ndjson", "logFinalTranscriptSentToLlm carries path");

/* ------------------------------------------------------------------
 * Suite G — logInputLimitDebug normalization + appModePrefix bridge
 * ------------------------------------------------------------------ */
console.log("\n-- Suite G - logInputLimitDebug normalization --");

A.sandbox.appModePrefix = () => "voice";
A.console._clear();
A.sandbox.window.logInputLimitDebug({
  raw_char_count: "42",
  estimated_tokens: 10,
  blocked: 1,
  selected_limit: 280,
});
const ilRow = A.console._calls[0];
eq(ilRow.level, "info", "uses console.info");
eq(ilRow.args[0], "[INPUT_LIMIT_DEBUG]", "exact label preserved");
eq(ilRow.args[1].raw_char_count, 42, "raw_char_count coerced via Number(...)");
eq(ilRow.args[1].estimated_tokens, 10, "estimated_tokens coerced via Number(...)");
eq(ilRow.args[1].blocked, true, "blocked coerced via Boolean(...)");
eq(ilRow.args[1].input_surface, "keyboard", "default input_surface");
eq(ilRow.args[1].active_mode_before_submit, "voice", "falls back to appModePrefix() when not provided");

/* ------------------------------------------------------------------
 * Suite H — logTurnTextIntegrity: gate, ID generation, equality fields
 * ------------------------------------------------------------------ */
console.log("\n-- Suite H - logTurnTextIntegrity --");

/* Default gate is ON (only "0" disables). */
const stG = makeMemoryStorage();
const G = makeSandbox({ storage: stG });
G.sandbox.voiceUxTurn = null;
G.sandbox._readLatestUserBubbleText = () => "go to panel 2 and explain the Vietnam War";

G.console._clear();
const turnId1 = G.sandbox.window.logTurnTextIntegrity({
  source: "browser_asr",
  raw_asr_text: "go to panel 2 and explain the vietnam war",
  normalized_text: "go to panel 2 and explain the Vietnam War",
  router_input_text: "go to panel 2 and explain the Vietnam War",
  backend_payload_text: "go to panel 2 and explain the Vietnam War",
});
ok(typeof turnId1 === "string" && turnId1.startsWith("turn_"), "logTurnTextIntegrity returned a turn_ id");
eq(G.console._calls.length, 1, "default gate=ON emits exactly one row");
eq(G.console._calls[0].level, "info", "uses console.info");
eq(G.console._calls[0].args[0], "[TURN_TEXT_INTEGRITY]", "exact label preserved");
const p1 = G.console._calls[0].args[1];
eq(p1.tag, "TURN_TEXT_INTEGRITY", "tag field present");
eq(p1.source, "browser_asr", "source carried through");
eq(p1.displayed_user_bubble_text, "go to panel 2 and explain the Vietnam War", "_readLatestUserBubbleText fallback used");
eq(p1.bubble_eq_router, true, "bubble_eq_router=true when texts identical");
eq(p1.router_eq_backend, true, "router_eq_backend=true when texts identical");
eq(p1.all_three_eq, true, "all_three_eq=true when all match");

/* Divergence detection (cleaned segment vs original). */
G.console._clear();
G.sandbox.window.logTurnTextIntegrity({
  router_input_text: "explain the Vietnam War",
  backend_payload_text: "explain the Vietnam War",
  displayed_user_bubble_text: "go to panel 2 and explain the Vietnam War",
});
const p2 = G.console._calls[0].args[1];
eq(p2.bubble_eq_router, false, "bubble_eq_router=false when bubble differs from router");
eq(p2.router_eq_backend, true, "router_eq_backend=true when router == backend");
eq(p2.all_three_eq, false, "all_three_eq=false when any pair diverges");

/* Gate OFF → no log emitted, returns null. */
stG.setItem("VERA_DEBUG_TURN_TEXT", "0");
G.console._clear();
const r3 = G.sandbox.window.logTurnTextIntegrity({});
eq(r3, null, "logTurnTextIntegrity returns null when gate is OFF");
eq(G.console._calls.length, 0, "no console row when gate is OFF");
stG.removeItem("VERA_DEBUG_TURN_TEXT");

/* Sequential IDs are monotonic. */
const seqBefore = vm.runInContext("_veraTurnSeq", G.sandbox);
const id1 = vm.runInContext("_nextVeraTurnId()", G.sandbox);
const id2 = vm.runInContext("_nextVeraTurnId()", G.sandbox);
const seqAfter = vm.runInContext("_veraTurnSeq", G.sandbox);
ok(id1 !== id2, "_nextVeraTurnId yields distinct IDs");
ok(seqAfter === seqBefore + 2, "_veraTurnSeq advanced by exactly 2");
ok(id1.endsWith(`_${seqBefore + 1}`), "_nextVeraTurnId ID embeds the sequence number");

/* Window alias for logTurnTextIntegrity (pre-existed in Stage 1). */
ok(
  typeof G.sandbox.window.logTurnTextIntegrity === "function",
  "window.logTurnTextIntegrity preserved after extraction"
);

/* ------------------------------------------------------------------
 * Suite I — app.js no longer carries the moved definitions
 * ------------------------------------------------------------------ */
console.log("\n-- Suite I - app.js no longer carries the moved definitions --");

const appSrc = fs.readFileSync(appJsPath, "utf8");

const MUST_NOT_MATCH_IN_APP = [
  [/^function logInputLimitDebug\(/m, "logInputLimitDebug definition removed from app.js"],
  [/^function logVeraCapabilityFailure\(/m, "logVeraCapabilityFailure definition removed from app.js"],
  [/^function logCapabilityFallbackDebug\(/m, "logCapabilityFallbackDebug definition removed from app.js"],
  [/^function logBargeInLatencyDebug\(/m, "logBargeInLatencyDebug definition removed from app.js"],
  [/^function logInterruptTranscriptDebug\(/m, "logInterruptTranscriptDebug definition removed from app.js"],
  [/^function logVoiceFirstAudio\(/m, "logVoiceFirstAudio definition removed from app.js"],
  [/^function logVoiceMainReplyAudio\(/m, "logVoiceMainReplyAudio definition removed from app.js"],
  [/^function logVoicePipe\(/m, "logVoicePipe definition removed from app.js"],
  [/^function logVoiceTranscript\(/m, "logVoiceTranscript definition removed from app.js"],
  [/^function logFinalTranscriptSentToLlm\(/m, "logFinalTranscriptSentToLlm definition removed from app.js"],
  [/^function logTurnTextIntegrity\(/m, "logTurnTextIntegrity definition removed from app.js"],
  [/^function _turnTextIntegrityEnabled\(/m, "_turnTextIntegrityEnabled definition removed from app.js"],
  [/^function _nextVeraTurnId\(/m, "_nextVeraTurnId definition removed from app.js"],
  [/^let _veraTurnSeq\s*=/m, "_veraTurnSeq let-binding removed from app.js"],
];
for (const [re, label] of MUST_NOT_MATCH_IN_APP) {
  ok(!re.test(appSrc), `app.js: ${label}`);
}

/* Sanity: confirm app.js still references the moved loggers (call sites
 * remain — they will resolve via shared global lexical env). */
const MUST_STILL_REFERENCE_IN_APP = [
  ["logInputLimitDebug(", "app.js still calls logInputLimitDebug"],
  ["logVeraCapabilityFailure(", "app.js still calls logVeraCapabilityFailure"],
  ["logCapabilityFallbackDebug(", "app.js still calls logCapabilityFallbackDebug"],
  ["logBargeInLatencyDebug(", "app.js still calls logBargeInLatencyDebug"],
  ["logInterruptTranscriptDebug(", "app.js still calls logInterruptTranscriptDebug"],
  ["logVoiceFirstAudio(", "app.js still calls logVoiceFirstAudio"],
  ["logVoiceMainReplyAudio(", "app.js still calls logVoiceMainReplyAudio"],
  ["logVoicePipe(", "app.js still calls logVoicePipe"],
  ["logVoiceTranscript(", "app.js still calls logVoiceTranscript"],
  ["logFinalTranscriptSentToLlm(", "app.js still calls logFinalTranscriptSentToLlm"],
  ["logTurnTextIntegrity(", "app.js still calls logTurnTextIntegrity"],
];
for (const [needle, label] of MUST_STILL_REFERENCE_IN_APP) {
  ok(appSrc.includes(needle), `app.js: ${label}`);
}

/* _readLatestUserBubbleText must STILL be defined in app.js (it's reused
 * by 4 non-logger Work-Mode sites and only borrowed by the moved logger
 * via the shared lexical env). */
ok(
  /^function _readLatestUserBubbleText\(/m.test(appSrc),
  "_readLatestUserBubbleText definition intentionally left in app.js"
);

/* ------------------------------------------------------------------
 * Suite J — index.html load order: ids → storage → logging → app
 * ------------------------------------------------------------------ */
console.log("\n-- Suite J - index.html load order --");

const idx = fs.readFileSync(indexHtmlPath, "utf8");
const iIds = idx.indexOf('<script src="utils/ids.js?v=');
const iStorage = idx.indexOf('<script src="utils/storage.js?v=');
const iLogging = idx.indexOf('<script src="utils/logging.js?v=');
const iApp = idx.indexOf('<script src="app.js?v=');
ok(iIds > -1, "index.html loads utils/ids.js");
ok(iStorage > -1, "index.html loads utils/storage.js");
ok(iLogging > -1, "index.html loads utils/logging.js");
ok(iApp > -1, "index.html loads app.js");
ok(iIds < iStorage, "utils/ids.js loaded before utils/storage.js");
ok(iStorage < iLogging, "utils/storage.js loaded before utils/logging.js");
ok(iLogging < iApp, "utils/logging.js loaded before app.js");

/* ------------------------------------------------------------------ */
console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail > 0) process.exit(1);
