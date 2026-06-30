/* ============================================================================
 * __voice_debug_extraction_smoke.mjs
 *
 * Verifies the Stage 4 extraction of DevTools-only voice / concurrency
 * diagnostics from app.js into debug/voiceDebug.js. Does NOT exercise the
 * real DOM / TTS / mic pipeline — just confirms:
 *
 *   1. debug/voiceDebug.js parses and runs in a classic-script-like
 *      context that already carries the utils/ids.js + utils/storage.js
 *      + utils/logging.js + (faked) app.js runtime bindings.
 *   2. The three required window aliases exist after debug load:
 *        window.veraConcurrencyDebug
 *        window.dumpVeraVoiceState
 *        window.resetVeraVoiceRuntimeState
 *   3. Late-bound bare-identifier reads work at CALL time
 *      (workModeReasoningAbortControllers, mainTtsPlaybackActive,
 *      interruptBargeInLatched, VERA_LAST_REQUEST_IDS, getSessionScopedId,
 *      cancelMainTtsPlayback, _veraTtsCancelSource, …) — the smoke
 *      installs minimal stubs and verifies veraConcurrencyDebug() and
 *      dumpVeraVoiceState() pick them up.
 *   4. resetVeraVoiceRuntimeState() actually FLIPS its target bindings:
 *      mainTtsPlaybackActive, interruptBargeInLatched, vadFastStopArmed,
 *      interrupt accumulators, and writes _veraTtsCancelSource.
 *   5. app.js no longer defines `window.veraConcurrencyDebug =`,
 *      `window.dumpVeraVoiceState =`, or `window.resetVeraVoiceRuntimeState =`
 *      (only the breadcrumb comments remain).
 *   6. The barge-in overlay block (Stage 18 / Patch A-12, 2026-05-31)
 *      has been moved from app.js into debug/voiceDebug.js and that file
 *      now owns `_veraBargeInDebug`, `_bargeInDebugUiEnabled`,
 *      `_bargeInDebugCaptureEvent`, `_bargeInDebugBuildState`,
 *      `_bargeInDebugMount`, `_bargeInDebugUnmount`, `_bargeInDebugRender`,
 *      `_bargeInDebugBuildSnapshot`, `window.toggleBargeInDebugUi`,
 *      `window.copyBargeInDebugSnapshot`, and the polling/auto-mount glue.
 *      Hot-path callers (utils/logging.js + voice/interruption.js) wrap
 *      their `_bargeInDebugCaptureEvent` access in try/catch + typeof
 *      guards to survive the post-app load order.
 *   7. index.html load order: utils/ids → utils/storage → utils/logging
 *      → app.js → debug/voiceDebug.js.
 *
 * Run:  node tests/smoke/__voice_debug_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsIdsPath = path.join(repoRoot, "utils", "ids.js");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const utilsLoggingPath = path.join(repoRoot, "utils", "logging.js");
const debugVoicePath = path.join(repoRoot, "debug", "voiceDebug.js");
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
  };
}

function makeCapturingConsole() {
  const calls = [];
  const cap = {
    log: (...a) => calls.push({ level: "log", args: a }),
    info: (...a) => calls.push({ level: "info", args: a }),
    warn: (...a) => calls.push({ level: "warn", args: a }),
    error: (...a) => calls.push({ level: "error", args: a }),
    table: (...a) => calls.push({ level: "table", args: a }),
  };
  cap._calls = calls;
  cap._clear = () => { calls.length = 0; };
  return cap;
}

/* ----------------------------------------------------------------
 * Build a sandbox that mirrors index.html's load order:
 *   utils/ids.js  →  utils/storage.js  →  utils/logging.js
 *     →  (mini app.js stub with the bindings the debug helpers read)
 *     →  debug/voiceDebug.js
 *
 * The mini-stub uses `var` for everything reachable through the
 * shared global lexical env. Classic scripts hoist `var` onto the
 * global object; this is enough for typeof-guards in debug/voiceDebug.js
 * to find them.
 * ---------------------------------------------------------------- */
function buildSandbox() {
  const cap = makeCapturingConsole();
  const sandbox = {
    window: {},
    console: cap,
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 1000 },
    crypto: {
      randomUUID: () => "test-uuid-" + Math.random().toString(36).slice(2, 10),
      getRandomValues: (buf) => {
        for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 0xffffffff) >>> 0;
        return buf;
      },
    },
    location: { origin: "http://example.test", href: "http://example.test/" },
    /* Stage 18 / Patch A-12: the BARGE-IN DEBUG OVERLAY block (moved from
     * app.js into debug/voiceDebug.js) installs a 1 Hz setInterval polling
     * loop and a setTimeout(0) auto-mount handler at file-load time, and
     * its mount path calls document.createElement / document.body.appendChild
     * once the overlay is enabled. Stub just enough for those calls to run
     * without throwing — the overlay only actually mounts when the flag is
     * enabled, which the suite below toggles deliberately. */
    document: {
      hidden: false,
      visibilityState: "visible",
      readyState: "complete",
      addEventListener: () => {},
      body: { appendChild: () => {}, removeChild: () => {} },
      head: { appendChild: () => {} },
      createElement: () => ({
        style: { cssText: "" },
        innerHTML: "",
        querySelector: () => null,
        addEventListener: () => {},
        appendChild: () => {},
        get isConnected() { return false; },
        parentNode: null,
      }),
    },
    navigator: {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, _ms) => { try { if (typeof fn === "function") fn(); } catch (_) {} return 1; },
    clearTimeout: () => {},
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.setInterval = sandbox.setInterval;
  sandbox.window.clearInterval = sandbox.clearInterval;
  sandbox.window.setTimeout = sandbox.setTimeout;
  sandbox.window.clearTimeout = sandbox.clearTimeout;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.sessionStorage = sandbox.sessionStorage;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(utilsIdsPath, "utf8"), sandbox, { filename: "utils/ids.js" });
  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });
  vm.runInContext(fs.readFileSync(utilsLoggingPath, "utf8"), sandbox, { filename: "utils/logging.js" });
  return { sandbox, console: cap };
}

/* ------------------------------------------------------------------
 * Suite A — debug/voiceDebug.js loads in the post-app classic-script env
 * ------------------------------------------------------------------ */
console.log("-- Suite A - debug/voiceDebug.js attaches window helpers --");

const A = buildSandbox();
/* Mini-stub for the runtime bindings debug/voiceDebug.js needs at
 * CALL time. `var` so they hoist onto `globalThis`. */
vm.runInContext(`
  var workModeReasoningAbortControllers = new Set();
  workModeReasoningAbortControllers.add({});
  var workModeReasoningLaneBusy = new Map();
  workModeReasoningLaneBusy.set("L1", true);
  var workModeTtsQueue = ["a", "b"];
  var workModeTtsCurrentlyPlaying = true;
  var interruptBargeInLatched = false;
  var listening = true;
  var processing = false;
  var mainTtsPlaybackActive = true;
  var mainTtsPlaybackToken = 7;
  var activeMainTtsBufferSources = [{}, {}, {}];
  var activeNdjsonBodyReader = { stub: true };
  var interruptRecording = true;
  var interruptPrearmRecorder = { state: "recording" };
  var vadFastStopArmed = true;
  var interruptPrearmTtsId = "tts-1";
  var interruptPrearmTurnId = "turn-1";
  var listeningMode = "continuous";
  var inputMuted = false;
  var pttRecording = false;
  var requestInFlight = false;
  var hasSpoken = false;
  var waveState = "wave-on";
  var interruptSpeechFrames = 3;
  var interruptSpeechStart = 100;
  var interruptSpeechAccumMs = 250.7;
  var interruptPartialAccumMs = 99.2;
  var interruptPartialLastChangeAt = 12345;
  var interruptPartialLastText = "this is a partial transcript snippet";
  var interruptDetectRecognition = { state: "running" };
  var mainBrowserRecognition = null;
  var browserAsrPermanentlyDisabled = false;
  var audioCtx = { state: "running" };
  var micStream = { active: true };
  var _veraNewsPanelRenderInFlight = false;
  var _veraInterruptDelayTrace = { interruptAttemptId: "att-42" };
  var _veraTtsCancelSource = "";
  function isVeraWorkModeOn() { return true; }
  function isWorkModeMuteEnabled() { return false; }
  function getVeraAsrMode() { return "streaming"; }
  function browserAsrPreferred() { return true; }
  function appModePrefix() { return "voice"; }
  /* TTS cleanup hooks observable by the smoke. */
  var __cancelMainTtsCalls = 0;
  function cancelMainTtsPlayback() { __cancelMainTtsCalls += 1; }
  var __stopWebAudioCalls = 0;
  function stopAllMainTtsWebAudio() { __stopWebAudioCalls += 1; }
  var __resetInterruptDelayCalls = [];
  function _resetInterruptDelayTrace(reason) { __resetInterruptDelayCalls.push(reason); }
  var __audioEl = { paused: false, currentTime: 7.5,
                    pause() { this.paused = true; },
                    set currentTime(v) { this._t = v; }, get currentTime() { return this._t || 0; } };
  function getAudioEl() { return __audioEl; }
`, A.sandbox, { filename: "test-app-stub.js" });

/* Force a deterministic session id so veraConcurrencyDebug snapshot has
 * something predictable. */
vm.runInContext(`
  setSessionScopedId(VERA_SESSION_STORAGE_KEY, "sess-vera-1");
  setSessionScopedId(BMO_SESSION_STORAGE_KEY,  "sess-bmo-1");
  recordVeraRequestId("infer", "req-infer-1");
  recordVeraRequestId("text",  "req-text-1");
`, A.sandbox);

vm.runInContext(fs.readFileSync(debugVoicePath, "utf8"), A.sandbox, {
  filename: "debug/voiceDebug.js",
});

const REQUIRED_WINDOW_HELPERS = [
  "veraConcurrencyDebug",
  "dumpVeraVoiceState",
  "debugTtsState",
  "resetVeraVoiceRuntimeState",
];
for (const name of REQUIRED_WINDOW_HELPERS) {
  ok(
    typeof A.sandbox.window[name] === "function",
    `window.${name} attached after debug/voiceDebug.js load`
  );
}

/* ------------------------------------------------------------------
 * Suite B — veraConcurrencyDebug() returns a coherent snapshot
 * ------------------------------------------------------------------ */
console.log("\n-- Suite B - veraConcurrencyDebug snapshot --");

A.console._clear();
const snap = A.sandbox.window.veraConcurrencyDebug();
ok(snap && typeof snap === "object", "snapshot is an object");
eq(snap.vera_session_id, "sess-vera-1", "vera_session_id read via getSessionScopedId");
eq(snap.bmo_session_id, "sess-bmo-1", "bmo_session_id read via getSessionScopedId");
eq(snap.last_request_ids.infer, "req-infer-1", "last_request_ids snapshot includes infer");
eq(snap.last_request_ids.text, "req-text-1", "last_request_ids snapshot includes text");
eq(snap.active_reasoning_streams, 1, "active_reasoning_streams reads .size");
eq(snap.reasoning_lane_busy.length, 1, "reasoning_lane_busy is an array of entries");
eq(snap.reasoning_lane_busy[0][0], "L1", "reasoning_lane_busy entry key preserved");
eq(snap.tts_queue_size, 2, "tts_queue_size reads .length");
eq(snap.tts_currently_playing, true, "tts_currently_playing coerced to boolean");
eq(snap.interrupt_state, false, "interrupt_state reflects interruptBargeInLatched");
eq(snap.listening, true, "listening flag carried through");
eq(snap.processing, false, "processing flag carried through");
ok(typeof snap.url === "string", "snapshot includes a url field");
eq(snap.build, "v68_multi_device_concurrency", "snapshot includes the legacy build label");

const consoleHasTable = A.console._calls.some((c) => c.level === "table");
const consoleHasLog = A.console._calls.some((c) => c.level === "log");
ok(consoleHasTable, "veraConcurrencyDebug calls console.table on last_request_ids");
ok(consoleHasLog, "veraConcurrencyDebug calls console.log with the snapshot");

/* ------------------------------------------------------------------
 * Suite C — dumpVeraVoiceState() reads late-bound bindings
 * ------------------------------------------------------------------ */
console.log("\n-- Suite C - dumpVeraVoiceState snapshot --");

A.console._clear();
const vs = A.sandbox.window.dumpVeraVoiceState({ silent: false });
ok(vs && vs.tag === "vera_voice_state_dump", "dump tag preserved");
ok(typeof vs.at === "string" && vs.at.includes("T"), "dump includes ISO timestamp");
eq(vs.asrMode, "streaming", "asrMode pulled from getVeraAsrMode()");
eq(vs.browserAsrPreferred, true, "browserAsrPreferred pulled from helper");
eq(vs.listeningMode, "continuous", "listeningMode read via bare identifier");
eq(vs.micState, "listening", "micState classifies via listening flag");
eq(vs.continuousListeningEnabled, true, "continuousListeningEnabled derived");
eq(vs.mainTtsPlaybackActive, true, "TTS active flag carried through");
eq(vs.mainTtsPlaybackToken, 7, "TTS token carried through");
eq(vs.activeMainTtsBufferSourcesCount, 3, "buffer source count reads .length");
eq(vs.activeNdjsonBodyReaderPresent, true, "ndjson reader presence Booleanified");
eq(vs.interruptRecording, true, "interruptRecording carried through");
eq(vs.interruptPrearmRecorderState, "recording", "prearm recorder state carried through");
eq(vs.vadFastStopArmed, true, "vadFastStopArmed carried through");
eq(vs.currentTtsId, "tts-1", "currentTtsId falls back to interruptPrearmTtsId");
eq(vs.currentTurnId, "turn-1", "currentTurnId falls back to interruptPrearmTurnId");
eq(vs.workModeOn, true, "workModeOn carried through from helper");
eq(vs.workModeMuteEnabled, false, "workModeMuteEnabled carried through from helper");
eq(vs.extras.audioCtxState, "running", "extras.audioCtxState carried through");
eq(vs.extras.micStreamActive, true, "extras.micStreamActive carried through");
eq(vs.extras.appModePrefix, "voice", "extras.appModePrefix carried through");
eq(vs.extras.currentInterruptAttemptId, "att-42", "extras.currentInterruptAttemptId carried through");

const dumpHasWarn = A.console._calls.some(
  (c) => c.level === "warn" && String(c.args[0] || "") === "[vera_voice_state_dump]"
);
ok(dumpHasWarn, "non-silent dump logs [vera_voice_state_dump] via console.warn");

/* Silent dump must NOT log. */
A.console._clear();
A.sandbox.window.dumpVeraVoiceState({ silent: true });
const silentHadWarn = A.console._calls.some(
  (c) => c.level === "warn" && String(c.args[0] || "") === "[vera_voice_state_dump]"
);
ok(!silentHadWarn, "silent dump suppresses the console.warn");

/* ------------------------------------------------------------------
 * Suite C2 — debugTtsState() exposes exact TTS triage fields
 * ------------------------------------------------------------------ */
console.log("\n-- Suite C2 - debugTtsState snapshot --");

A.console._clear();
const ts = A.sandbox.window.debugTtsState({ silent: false });
ok(ts && typeof ts === "object", "debugTtsState returns an object");
eq(ts.API_URL, null, "API_URL absent in sandbox returns null");
eq(ts.workMode, true, "workMode carried through");
eq(ts.workModeMute, false, "workModeMute carried through");
eq(ts.inputMuted, false, "inputMuted carried through");
eq(ts.listeningMode, "continuous", "listeningMode carried through");
eq(ts.waveState, "wave-on", "waveState carried through");
eq(ts.mainTtsPlaybackActive, true, "mainTtsPlaybackActive carried through");
eq(ts.activeMainTtsBufferSourcesCount, 3, "active source count carried through");
eq(ts.requestInFlight, false, "requestInFlight carried through");
eq(ts.processing, false, "processing carried through");
eq(ts.workModeTtsQueueLength, 2, "workModeTtsQueueLength carried through");
eq(ts.workModeTtsDrainActive, null, "missing workModeTtsDrainRunning returns null");
eq(ts.audioCtxState, "running", "audioCtxState carried through");
eq(ts.audioElPaused, false, "audioElPaused carried through");
const ttsDebugLogged = A.console._calls.some(
  (c) => c.level === "warn" && String(c.args[0] || "") === "[debug_tts_state]"
);
ok(ttsDebugLogged, "debugTtsState logs [debug_tts_state] via console.warn");

/* ------------------------------------------------------------------
 * Suite D — resetVeraVoiceRuntimeState() actually flips state
 * ------------------------------------------------------------------ */
console.log("\n-- Suite D - resetVeraVoiceRuntimeState mutates target bindings --");

A.console._clear();
const result = A.sandbox.window.resetVeraVoiceRuntimeState({ source: "smoke" });
ok(result && result.before && result.after, "reset returns { before, after } snapshots");

eq(vm.runInContext("__cancelMainTtsCalls", A.sandbox), 1, "cancelMainTtsPlayback was called");
eq(vm.runInContext("__stopWebAudioCalls", A.sandbox), 1, "stopAllMainTtsWebAudio was called (belt+suspenders)");
eq(vm.runInContext("_veraTtsCancelSource", A.sandbox), "manual_reset_voice_runtime_state", "cancel source written");
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "buffer sources array drained");
eq(vm.runInContext("activeNdjsonBodyReader", A.sandbox), null, "ndjson reader cleared");
eq(vm.runInContext("mainTtsPlaybackActive", A.sandbox), false, "TTS active flag flipped");
eq(vm.runInContext("interruptRecording", A.sandbox), false, "interruptRecording cleared");
eq(vm.runInContext("vadFastStopArmed", A.sandbox), false, "vadFastStopArmed left disarmed per spec");
eq(vm.runInContext("interruptBargeInLatched", A.sandbox), false, "interruptBargeInLatched cleared");
eq(vm.runInContext("interruptSpeechFrames", A.sandbox), 0, "interruptSpeechFrames zeroed");
eq(vm.runInContext("interruptSpeechAccumMs", A.sandbox), 0, "interruptSpeechAccumMs zeroed");
eq(vm.runInContext("interruptPartialAccumMs", A.sandbox), 0, "interruptPartialAccumMs zeroed");
eq(vm.runInContext("interruptPartialLastText", A.sandbox), "", "interruptPartialLastText cleared");
ok(
  vm.runInContext("__resetInterruptDelayCalls", A.sandbox).includes("manual_reset_voice_runtime_state"),
  "_resetInterruptDelayTrace called with manual_reset reason"
);

const audio = vm.runInContext("__audioEl", A.sandbox);
ok(audio.paused === true, "<audio> element paused via getAudioEl()");
eq(vm.runInContext("__audioEl.currentTime", A.sandbox), 0, "<audio> element rewound to 0");

const resetWarn = A.console._calls.some(
  (c) => c.level === "warn" && String(c.args[0] || "") === "[vera_voice_runtime_reset]"
);
ok(resetWarn, "reset emits [vera_voice_runtime_reset] via console.warn");

/* ------------------------------------------------------------------
 * Suite E — app.js no longer attaches the moved window aliases
 * ------------------------------------------------------------------ */
console.log("\n-- Suite E - app.js no longer attaches moved window aliases --");

const appSrc = fs.readFileSync(appJsPath, "utf8");

const MUST_NOT_MATCH_IN_APP = [
  [/window\.veraConcurrencyDebug\s*=\s*function/, "no window.veraConcurrencyDebug assignment in app.js"],
  [/window\.dumpVeraVoiceState\s*=\s*function/, "no window.dumpVeraVoiceState assignment in app.js"],
  [/window\.resetVeraVoiceRuntimeState\s*=\s*function/, "no window.resetVeraVoiceRuntimeState assignment in app.js"],
];
for (const [re, label] of MUST_NOT_MATCH_IN_APP) {
  ok(!re.test(appSrc), `app.js: ${label}`);
}

/* The breadcrumb comments must still be present so future readers know
 * where the helpers went. */
const MUST_MATCH_IN_APP = [
  ["moved to debug/voiceDebug.js", "app.js carries a 'moved to debug/voiceDebug.js' breadcrumb"],
  ["see debug/voiceDebug.js", "app.js carries a 'see debug/voiceDebug.js' breadcrumb"],
];
for (const [needle, label] of MUST_MATCH_IN_APP) {
  ok(appSrc.includes(needle), `app.js: ${label}`);
}

/* Other references in app.js are window.* call sites — those stay and
 * resolve at call time. */
ok(
  appSrc.includes("window.dumpVeraVoiceState"),
  "app.js still REFERENCES window.dumpVeraVoiceState at call sites (barge-in overlay etc.)"
);
ok(
  appSrc.includes("window.resetVeraVoiceRuntimeState"),
  "app.js still REFERENCES window.resetVeraVoiceRuntimeState at call sites"
);
ok(
  appSrc.includes("window.copyBargeInDebugSnapshot"),
  "app.js still REFERENCES window.copyBargeInDebugSnapshot (barge-in overlay left in place)"
);

/* ------------------------------------------------------------------
 * Suite F — barge-in overlay extraction (Stage 18 / Patch A-12)
 * ------------------------------------------------------------------ */
console.log("\n-- Suite F - barge-in overlay moved from app.js to debug/voiceDebug.js (Patch A-12) --");

const debugVoiceSrc = fs.readFileSync(debugVoicePath, "utf8");

/* Symbol set now lives in debug/voiceDebug.js. */
ok(
  /^const _veraBargeInDebug\s*=\s*\{/m.test(debugVoiceSrc),
  "_veraBargeInDebug state object now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugUiEnabled\(/m.test(debugVoiceSrc),
  "_bargeInDebugUiEnabled now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugCaptureEvent\(/m.test(debugVoiceSrc),
  "_bargeInDebugCaptureEvent now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugBuildState\(/m.test(debugVoiceSrc),
  "_bargeInDebugBuildState now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugMount\(/m.test(debugVoiceSrc),
  "_bargeInDebugMount now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugUnmount\(/m.test(debugVoiceSrc),
  "_bargeInDebugUnmount now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugRender\(/m.test(debugVoiceSrc),
  "_bargeInDebugRender now defined in debug/voiceDebug.js"
);
ok(
  /^function _bargeInDebugBuildSnapshot\(/m.test(debugVoiceSrc),
  "_bargeInDebugBuildSnapshot now defined in debug/voiceDebug.js"
);
ok(
  /window\.toggleBargeInDebugUi\s*=\s*function/.test(debugVoiceSrc),
  "window.toggleBargeInDebugUi attached inside debug/voiceDebug.js"
);
ok(
  /window\.copyBargeInDebugSnapshot\s*=\s*function/.test(debugVoiceSrc),
  "window.copyBargeInDebugSnapshot attached inside debug/voiceDebug.js"
);
ok(
  /window\.VERA_DEBUG_BARGE_IN_UI\s*=\s*_bargeInDebugUiEnabled\(\)/.test(debugVoiceSrc),
  "window.VERA_DEBUG_BARGE_IN_UI session-flag echo attached inside debug/voiceDebug.js"
);

/* Symbols are NO LONGER declared in app.js. */
ok(
  !/^const _veraBargeInDebug\s*=\s*\{/m.test(appSrc),
  "_veraBargeInDebug state object removed from app.js"
);
ok(
  !/^function _bargeInDebugUiEnabled\(/m.test(appSrc),
  "_bargeInDebugUiEnabled removed from app.js"
);
ok(
  !/^function _bargeInDebugCaptureEvent\(/m.test(appSrc),
  "_bargeInDebugCaptureEvent removed from app.js"
);
ok(
  !/window\.toggleBargeInDebugUi\s*=\s*function/.test(appSrc),
  "window.toggleBargeInDebugUi attachment removed from app.js"
);
ok(
  !/window\.copyBargeInDebugSnapshot\s*=\s*function/.test(appSrc),
  "window.copyBargeInDebugSnapshot attachment removed from app.js"
);

/* Breadcrumb stub in app.js documents the move. */
ok(
  /moved to debug\/voiceDebug\.js[\s\S]{0,120}Stage 18/.test(appSrc),
  "app.js carries 'moved to debug/voiceDebug.js (Stage 18 / Patch A-12)' breadcrumb"
);

/* Live in this realm: after debug/voiceDebug.js has loaded into the sandbox,
 * the window aliases must exist (the hard-rule of the patch). */
ok(
  typeof A.sandbox.window.toggleBargeInDebugUi === "function",
  "window.toggleBargeInDebugUi exists at runtime after debug/voiceDebug.js loads"
);
ok(
  typeof A.sandbox.window.copyBargeInDebugSnapshot === "function",
  "window.copyBargeInDebugSnapshot exists at runtime after debug/voiceDebug.js loads"
);

/* Hot-path callers in utils/logging.js + voice/interruption.js wrap the
 * `_veraBargeInDebug?.enabled` / `_bargeInDebugCaptureEvent` access in
 * try/catch + typeof guards so events that arrive before debug/voiceDebug.js
 * has loaded cannot throw a ReferenceError. */
const utilsLoggingSrc = fs.readFileSync(utilsLoggingPath, "utf8");
ok(
  /typeof _veraBargeInDebug !== "undefined"[\s\S]{0,200}typeof _bargeInDebugCaptureEvent === "function"/.test(utilsLoggingSrc),
  "utils/logging.js logInterruptTranscriptDebug wraps overlay capture in typeof guards"
);
const interruptionSrcForGuards = fs.readFileSync(path.join(repoRoot, "voice", "interruption.js"), "utf8");
ok(
  /typeof _veraBargeInDebug !== "undefined"[\s\S]{0,200}typeof _bargeInDebugCaptureEvent === "function"/.test(interruptionSrcForGuards),
  "voice/interruption.js logVeraInterruptDebug wraps overlay capture in typeof guards"
);

/* ------------------------------------------------------------------
 * Suite G — index.html load order
 * ------------------------------------------------------------------ */
console.log("\n-- Suite G - index.html load order --");

const idx = fs.readFileSync(indexHtmlPath, "utf8");
const iIds = idx.indexOf('<script src="utils/ids.js?v=');
const iStorage = idx.indexOf('<script src="utils/storage.js?v=');
const iLogging = idx.indexOf('<script src="utils/logging.js?v=');
const iApp = idx.indexOf('<script src="app.js?v=');
const iVoiceDebug = idx.indexOf('<script src="debug/voiceDebug.js?v=');
ok(iIds > -1, "index.html loads utils/ids.js");
ok(iStorage > -1, "index.html loads utils/storage.js");
ok(iLogging > -1, "index.html loads utils/logging.js");
ok(iApp > -1, "index.html loads app.js");
ok(iVoiceDebug > -1, "index.html loads debug/voiceDebug.js");
ok(iIds < iStorage, "utils/ids.js loaded before utils/storage.js");
ok(iStorage < iLogging, "utils/storage.js loaded before utils/logging.js");
ok(iLogging < iApp, "utils/logging.js loaded before app.js");
ok(iApp < iVoiceDebug, "app.js loaded BEFORE debug/voiceDebug.js (Stage 4 load order)");

/* ------------------------------------------------------------------ */
console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail > 0) process.exit(1);
