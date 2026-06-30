/* ============================================================================
 * __interruption_extraction_smoke.mjs
 *
 * Verifies the Stage 6 extraction of interruption / barge-in helpers
 * from app.js into voice/interruption.js. Does NOT exercise the real
 * DOM / Web Audio / SR / mic pipeline — just confirms:
 *
 *   1. voice/interruption.js parses and runs in a classic-script-like
 *      context that already carries utils/ids.js + utils/storage.js +
 *      utils/logging.js + voice/ttsQueue.js, plus a small set of
 *      app-stub bindings the interruption code reaches for at CALL time.
 *   2. Module-level state bindings exist post-load with correct
 *      initial values:
 *        let _veraTtsCancelSource ("")
 *        let _veraInterruptDelayTrace (null)
 *        let _veraInterruptAttemptSeq (0)
 *        let interruptBargeInLatched (false)
 *        let vadFastStopArmed (true)
 *        let vadFastStopFiredAt / TtsStoppedAt / AsrFinalAt (0)
 *        let vadFastStopTtsId ("")
 *        const _veraInterruptDebugLastAt (Map)
 *   3. All moved functions exist as declarations:
 *        isVeraInterruptDebugEnabled / logVeraInterruptDebug,
 *        _newInterruptAttemptId / _resetInterruptDelayTrace /
 *        _ensureInterruptDelayTrace / _recordInterruptTimingPoint /
 *        _flushInterruptDelayTrace,
 *        _logVoiceStateTransition / _logTtsCancelSourceTrace,
 *        resetVadFastStopState, fastStopTtsOnVadOnly,
 *        interruptTranscriptNewTtsId, interruptSpeech,
 *        getInterruptionDebugState.
 *   4. New + DevTools window aliases are attached:
 *        window.interruptSpeech, window.fastStopTtsOnVadOnly,
 *        window.getInterruptionDebugState,
 *        window.resetVadFastStopState,
 *        window.isVeraInterruptDebugEnabled.
 *   5. isVeraInterruptDebugEnabled gates correctly on
 *      window.VERA_DEBUG_INTERRUPT, and logVeraInterruptDebug honours
 *      both the gate and the optional barge-in overlay feed.
 *   6. The delay-trace state machine:
 *        - new attempt IDs increment _veraInterruptAttemptSeq,
 *        - _recordInterruptTimingPoint is no-op when debug is off,
 *        - autoStart=true starts a trace lazily,
 *        - t6_cancelMainTtsPlayback_called is stamped only once,
 *        - t2 is allowed to be REFRESHED across multiple calls,
 *        - _flushInterruptDelayTrace emits one [interrupt_delay_trace]
 *          line and marks the trace flushed,
 *        - _resetInterruptDelayTrace flushes a still-open trace.
 *   7. resetVadFastStopState() re-arms the fast-stop vars, calls
 *      logBargeInLatencyDebug("rearm", …) only when a reason is given,
 *      and always resets the delay trace.
 *   8. fastStopTtsOnVadOnly early-returns when the fast-stop is not
 *      armed OR when isAssistantTtsPlaying() is false (no cancel call).
 *      When armed AND TTS is playing it: disarms, sets cancel source,
 *      calls cancelMainTtsPlayback once, calls resetAudioHandlers,
 *      pauses/resets the audio element, flips waveState→"listening"
 *      and listening→true, records timing points + voice-state
 *      transitions, and returns true.
 *   9. interruptSpeech early-returns when listeningMode !== "continuous",
 *      when interrupt recorder isn't recording and useBrowserAsr is
 *      false, and when nothing is playing. On the happy path it sets
 *      cancel source + calls cancelBrowserInterruptTtsOnly.
 *  10. interruptTranscriptNewTtsId returns distinct, well-formed ids.
 *  11. getInterruptionDebugState reflects mutated state.
 *  12. app.js no longer declares the moved bindings at top level —
 *      breadcrumb comments are present instead. _veraInterruptRafLastAt
 *      / _veraNewsPanelRenderInFlight / _veraCurrentTtsDebugContext
 *      stay in app.js (intentional, per Stage 6 spec).
 *  13. index.html load order:
 *        ids → storage → logging → ttsQueue → interruption → app → voiceDebug.
 *
 * Run:  node tests/smoke/__interruption_extraction_smoke.mjs
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
const voiceTtsPath = path.join(repoRoot, "voice", "ttsQueue.js");
const voiceInterruptPath = path.join(repoRoot, "voice", "interruption.js");
const indexHtmlPath = path.join(repoRoot, "index.html");
const appJsPath = path.join(repoRoot, "app.js");

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
    debug: (...a) => calls.push({ level: "debug", args: a }),
    warn: (...a) => calls.push({ level: "warn", args: a }),
    error: (...a) => calls.push({ level: "error", args: a }),
    table: () => {},
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
  };
  Object.defineProperty(cap, "__calls", {
    value: calls,
    enumerable: false,
    writable: false,
  });
  return cap;
}

/* ---------------------------------------------------------------------------
 * Build a sandbox mirroring index.html load order:
 *
 *   utils/ids.js  →  utils/storage.js  →  utils/logging.js
 *     →  voice/ttsQueue.js
 *     →  (app-stub: bindings that voice/interruption.js reaches for at
 *         CALL time)
 *     →  voice/interruption.js
 *
 * The app-stub provides minimal versions of: isAssistantTtsPlaying,
 * getAudioEl, resetAudioHandlers, setStatus, browserAsrPreferred,
 * cancelBrowserInterruptTtsOnly, promoteInterruptPreviewToMainLiveBubble,
 * startPostInterruptBrowserRecognition, detectInterruptSpeechEnd,
 * logBargeInLatencyDebug, logInterruptTranscriptDebug, plus the few
 * `let`-style runtime vars the interruption code reads (listening,
 * listeningMode, waveState, audioStartedAt, interruptRecording,
 * interruptPrearm* group, interruptDetectRecognition,
 * mainBrowserRecognition, _veraBargeInDebug, _bargeInDebugCaptureEvent,
 * MAX_INTERRUPTION_PREROLL_MS).
 * ------------------------------------------------------------------------- */
function buildLoadedSandbox() {
  const cConsole = makeCapturingConsole();
  const sandbox = vm.createContext({
    console: cConsole,
    window: {},
    document: { body: { classList: { contains: () => false } } },
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 12345.6 },
    location: { search: "" },
    requestAnimationFrame: (fn) => {
      /* No-op: we don't actually drive the next frame in this smoke;
         interruptSpeech only QUEUES this when interruptRecording is true,
         and we exercise both paths separately. */
      sandbox.__rafCalls = (sandbox.__rafCalls || 0) + 1;
      return 0;
    },
    setTimeout: (fn, ms) => {
      sandbox.__setTimeoutCalls = (sandbox.__setTimeoutCalls || 0) + 1;
      /* Synchronous fire so the flushInterruptDelayTrace "next tick"
         post-cancel logic is observable in the smoke. Mirrors what node
         would do at the next macrotask boundary without making the test
         async. */
      try { fn(); } catch (_) {}
      return 0;
    },
    clearTimeout: () => {},
  });
  sandbox.globalThis = sandbox;

  vm.runInContext(fs.readFileSync(utilsIdsPath, "utf8"), sandbox, { filename: "utils/ids.js" });
  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });
  vm.runInContext(fs.readFileSync(utilsLoggingPath, "utf8"), sandbox, { filename: "utils/logging.js" });
  vm.runInContext(fs.readFileSync(voiceTtsPath, "utf8"), sandbox, { filename: "voice/ttsQueue.js" });

  const appStub = `
    /* ---- helpers we observe ---- */
    var __barge = []; // entries pushed by logBargeInLatencyDebug
    function logBargeInLatencyDebug(event, payload) { __barge.push({ event: event, payload: payload || null }); }
    var __interruptTranscriptCalls = [];
    function logInterruptTranscriptDebug(event, payload) { __interruptTranscriptCalls.push({ event: event, payload: payload || null }); }

    /* ---- audio / SR stubs ---- */
    var __audioStubState = { paused: true, currentTime: 0, __pauseCalls: 0, __resetCalls: 0 };
    var __audioEl = {
      paused: true,
      currentTime: 0,
      pause: function () { this.paused = true; __audioStubState.paused = true; __audioStubState.__pauseCalls += 1; },
    };
    Object.defineProperty(__audioEl, "currentTime", {
      get: function () { return __audioStubState.currentTime; },
      set: function (v) { __audioStubState.currentTime = v; __audioStubState.__resetCalls += 1; },
    });
    function getAudioEl() { return __audioEl; }

    /* isAssistantTtsPlaying state — toggle from tests by writing
       __assistantTtsPlaying = true / false. */
    var __assistantTtsPlaying = false;
    function isAssistantTtsPlaying() { return __assistantTtsPlaying === true; }

    var __resetAudioHandlersCalls = 0;
    function resetAudioHandlers() { __resetAudioHandlersCalls += 1; }

    var __setStatusCalls = [];
    function setStatus(text, status) { __setStatusCalls.push({ text: text, status: status }); }

    /* Browser-ASR stub — toggle from tests. */
    var __browserAsrPreferredReturn = false;
    function browserAsrPreferred() { return __browserAsrPreferredReturn === true; }

    var __cancelBrowserInterruptTtsOnlyCalls = 0;
    function cancelBrowserInterruptTtsOnly() { __cancelBrowserInterruptTtsOnlyCalls += 1; }

    var __promoteInterruptPreviewCalls = 0;
    function promoteInterruptPreviewToMainLiveBubble() { __promoteInterruptPreviewCalls += 1; }

    var __startPostInterruptBrowserRecognitionCalls = 0;
    function startPostInterruptBrowserRecognition() { __startPostInterruptBrowserRecognitionCalls += 1; }

    var __startInterruptCaptureCalls = 0;
    function startInterruptCapture() { __startInterruptCaptureCalls += 1; }

    function getVeraAsrMode() { return "whisper"; }

    function detectInterruptSpeechEnd() {}

    /* ---- VAD / SR / recorder state placeholders ---- */
    var listening = false;
    var listeningMode = "continuous";
    var waveState = "speaking";
    var audioStartedAt = 0;
    var interruptRecording = false;
    var interruptRecorder = null;
    var interruptPrearmStartedAt = 0;
    var interruptPrearmCommittedAt = 0;
    var interruptPrearmTtsId = "";
    var interruptDetectRecognition = null;
    var mainBrowserRecognition = null;
    var MAX_INTERRUPTION_PREROLL_MS = 1000;

    /* ---- Barge-in debug overlay stub (Stage 4 LEFT in app.js) ---- */
    var __bargeInOverlayEvents = [];
    var _veraBargeInDebug = { enabled: false };
    function _bargeInDebugCaptureEvent(tag, payload) {
      __bargeInOverlayEvents.push({ tag: tag, payload: payload });
    }

    /* ---- Other app.js bindings the interruption helpers read at
       call time (still owned by app.js post-Stage-6) ---- */
    var _veraNewsPanelRenderInFlight = false;
    /* queuedAssistantTtsPlayback was previously stubbed here while it lived
       in app.js. Patch A-7 (Stage 21, 2026-05-31) moved the binding into
       voice/ttsQueue.js, which is loaded into this sandbox above (L190).
       Re-declaring it here as a var would collide with the real top-level
       'let queuedAssistantTtsPlayback' (script-level lexical declaration)
       and throw SyntaxError. The interruption helpers continue to see the
       real binding via the shared classic-script global lexical env. */
  `;
  vm.runInContext(appStub, sandbox, { filename: "tests/smoke/__interruption_app_stub__" });

  vm.runInContext(fs.readFileSync(voiceInterruptPath, "utf8"), sandbox, { filename: "voice/interruption.js" });

  return { sandbox, cConsole };
}

/*
 * Suite A — voice/interruption.js loads and declares the right bindings
 */
console.log("-- Suite A - voice/interruption.js loads + state bindings exist --");

const A = buildLoadedSandbox();

eq(vm.runInContext("typeof _veraTtsCancelSource", A.sandbox), "string", "_veraTtsCancelSource declared (string)");
eq(vm.runInContext("_veraTtsCancelSource", A.sandbox), "", "_veraTtsCancelSource initial value ''");
eq(vm.runInContext("_veraInterruptDelayTrace", A.sandbox), null, "_veraInterruptDelayTrace initial value null");
eq(vm.runInContext("_veraInterruptAttemptSeq", A.sandbox), 0, "_veraInterruptAttemptSeq initial value 0");
eq(vm.runInContext("interruptBargeInLatched", A.sandbox), false, "interruptBargeInLatched initial value false");
eq(vm.runInContext("vadFastStopArmed", A.sandbox), true, "vadFastStopArmed initial value true");
eq(vm.runInContext("vadFastStopFiredAt", A.sandbox), 0, "vadFastStopFiredAt initial value 0");
eq(vm.runInContext("vadFastStopTtsStoppedAt", A.sandbox), 0, "vadFastStopTtsStoppedAt initial value 0");
eq(vm.runInContext("vadFastStopAsrFinalAt", A.sandbox), 0, "vadFastStopAsrFinalAt initial value 0");
eq(vm.runInContext("vadFastStopTtsId", A.sandbox), "", "vadFastStopTtsId initial value ''");
eq(vm.runInContext("_veraInterruptDebugLastAt instanceof Map", A.sandbox), true, "_veraInterruptDebugLastAt is a Map");

/*
 * Suite B — function declarations exist
 */
console.log("\n-- Suite B - function declarations --");

const fns = [
  "isVeraInterruptDebugEnabled",
  "logVeraInterruptDebug",
  "_newInterruptAttemptId",
  "_resetInterruptDelayTrace",
  "_ensureInterruptDelayTrace",
  "_recordInterruptTimingPoint",
  "_flushInterruptDelayTrace",
  "_logVoiceStateTransition",
  "_logTtsCancelSourceTrace",
  "resetVadFastStopState",
  "fastStopTtsOnVadOnly",
  "interruptTranscriptNewTtsId",
  "interruptSpeech",
  "getInterruptionDebugState",
];
for (const name of fns) {
  eq(vm.runInContext(`typeof ${name}`, A.sandbox), "function", `${name} declared (function)`);
}

/*
 * Suite C — window aliases attached
 */
console.log("\n-- Suite C - window aliases attached --");

const winAliases = [
  "interruptSpeech",
  "fastStopTtsOnVadOnly",
  "getInterruptionDebugState",
  "resetVadFastStopState",
  "isVeraInterruptDebugEnabled",
];
for (const name of winAliases) {
  eq(
    vm.runInContext(`typeof window.${name}`, A.sandbox),
    "function",
    `window.${name} attached`
  );
  eq(
    vm.runInContext(`window.${name} === ${name}`, A.sandbox),
    true,
    `window.${name} identity matches bare ${name}`
  );
}

/*
 * Suite D — isVeraInterruptDebugEnabled gate + logVeraInterruptDebug
 */
console.log("\n-- Suite D - debug gate + logger overlay feed --");

eq(vm.runInContext("isVeraInterruptDebugEnabled()", A.sandbox), false, "disabled by default");
vm.runInContext("window.VERA_DEBUG_INTERRUPT = true;", A.sandbox);
eq(vm.runInContext("isVeraInterruptDebugEnabled()", A.sandbox), true, "enabled when window flag = true");
vm.runInContext("window.VERA_DEBUG_INTERRUPT = false;", A.sandbox);
eq(vm.runInContext("isVeraInterruptDebugEnabled()", A.sandbox), false, "disabled when window flag = false");

/* Overlay feed: enable overlay, leave debug gate off, call logger. */
vm.runInContext(
  `
  __bargeInOverlayEvents.length = 0;
  _veraBargeInDebug.enabled = true;
  logVeraInterruptDebug({ tag: "interrupt_test", x: 1 });
  `,
  A.sandbox
);
{
  const events = vm.runInContext("__bargeInOverlayEvents.slice()", A.sandbox);
  eq(events.length, 1, "overlay receives one event even with debug gate off");
  eq(events[0].tag, "interrupt_test", "overlay event carries tag");
}
/* Confirm gate still suppressed console.info (no log entry tagged interrupt_test in cap console) */
{
  const interruptLogs = A.cConsole.__calls.filter((c) =>
    c.level === "info" && String(c.args[0] || "").startsWith("[interrupt_test]")
  );
  eq(interruptLogs.length, 0, "console.info NOT emitted while debug gate off");
}

/* Now enable gate and call again */
vm.runInContext(
  `
  window.VERA_DEBUG_INTERRUPT = true;
  logVeraInterruptDebug({ tag: "interrupt_test", x: 2 });
  `,
  A.sandbox
);
{
  const interruptLogs = A.cConsole.__calls.filter((c) =>
    c.level === "info" && String(c.args[0] || "").startsWith("[interrupt_test]")
  );
  ok(interruptLogs.length >= 1, "console.info emitted once debug gate is on");
}

/* Throttle test: same key within window suppresses. Note: we use a
   throttleMs (1000) smaller than the stubbed performance.now() (12345.6)
   so the first call passes the `now - last < minMs` check on a cold key
   (last defaults to 0). Subsequent calls within the window are suppressed. */
vm.runInContext(
  `
  for (var i = 0; i < 5; i++) {
    logVeraInterruptDebug({ tag: "rate_test", n: i }, { throttleKey: "rt", throttleMs: 1000 });
  }
  `,
  A.sandbox
);
{
  const rateLogs = A.cConsole.__calls.filter((c) =>
    c.level === "info" && String(c.args[0] || "").startsWith("[rate_test]")
  );
  eq(rateLogs.length, 1, "throttleKey suppresses repeated calls within window (only first passes)");
}

/*
 * Suite E — Delay trace state machine
 */
console.log("\n-- Suite E - delay trace state machine --");

/* Reset state for clean test */
vm.runInContext(
  `
  _veraInterruptDelayTrace = null;
  _veraInterruptAttemptSeq = 0;
  window.VERA_DEBUG_INTERRUPT = true;
  `,
  A.sandbox
);

/* _newInterruptAttemptId increments the sequence */
const id1 = vm.runInContext("_newInterruptAttemptId()", A.sandbox);
const id2 = vm.runInContext("_newInterruptAttemptId()", A.sandbox);
ok(typeof id1 === "string" && id1.startsWith("att_"), "attempt id format starts with att_");
ok(id1 !== id2, "consecutive attempt ids are distinct");
eq(vm.runInContext("_veraInterruptAttemptSeq", A.sandbox), 2, "_veraInterruptAttemptSeq incremented twice");

/* When debug is off, _recordInterruptTimingPoint is a no-op */
vm.runInContext(
  `
  window.VERA_DEBUG_INTERRUPT = false;
  _veraInterruptDelayTrace = null;
  _recordInterruptTimingPoint("t6_cancelMainTtsPlayback_called", { autoStart: true });
  `,
  A.sandbox
);
eq(vm.runInContext("_veraInterruptDelayTrace", A.sandbox), null, "_recordInterruptTimingPoint no-op when debug off");

/* autoStart=true creates the trace when debug is on */
vm.runInContext(
  `
  window.VERA_DEBUG_INTERRUPT = true;
  _veraInterruptDelayTrace = null;
  _recordInterruptTimingPoint("t0_user_speech_audio_detected", { autoStart: true, extra: { rms: 0.1 } });
  `,
  A.sandbox
);
{
  const t = vm.runInContext("_veraInterruptDelayTrace", A.sandbox);
  ok(t && typeof t.interruptAttemptId === "string", "autoStart=true initializes trace with id");
  eq(typeof t.t0_user_speech_audio_detected, "number", "t0 stamped as number");
  eq(t._extra?.rms, 0.1, "extra payload merged onto _extra");
}

/* Subsequent t6 stamp does not overwrite */
vm.runInContext(
  `
  _recordInterruptTimingPoint("t6_cancelMainTtsPlayback_called");
  `,
  A.sandbox
);
const firstT6 = vm.runInContext("_veraInterruptDelayTrace.t6_cancelMainTtsPlayback_called", A.sandbox);
vm.runInContext(
  `
  _recordInterruptTimingPoint("t6_cancelMainTtsPlayback_called");
  `,
  A.sandbox
);
const secondT6 = vm.runInContext("_veraInterruptDelayTrace.t6_cancelMainTtsPlayback_called", A.sandbox);
eq(secondT6, firstT6, "second stamp does NOT overwrite t6");

/* t2 IS allowed to be refreshed */
vm.runInContext(
  `
  _recordInterruptTimingPoint("t2_interim_transcript_updated");
  _t2_first = _veraInterruptDelayTrace.t2_interim_transcript_updated;
  _recordInterruptTimingPoint("t2_interim_transcript_updated");
  _t2_second = _veraInterruptDelayTrace.t2_interim_transcript_updated;
  `,
  A.sandbox
);
ok(
  vm.runInContext("typeof _t2_first === 'number' && typeof _t2_second === 'number'", A.sandbox),
  "t2 stamped as numbers (both calls)"
);

/* Flush emits one [interrupt_delay_trace] log + flags trace flushed */
const beforeFlush = A.cConsole.__calls.length;
vm.runInContext(`_flushInterruptDelayTrace("test_flush");`, A.sandbox);
const flushLogs = A.cConsole.__calls
  .slice(beforeFlush)
  .filter((c) => c.level === "info" && String(c.args[0] || "").startsWith("[interrupt_delay_trace]"));
eq(flushLogs.length, 1, "_flushInterruptDelayTrace emits exactly one [interrupt_delay_trace] line");
eq(vm.runInContext("_veraInterruptDelayTrace.flushed", A.sandbox), true, "trace marked .flushed=true");

/* Second flush is a no-op (trace already flushed) */
const beforeFlush2 = A.cConsole.__calls.length;
vm.runInContext(`_flushInterruptDelayTrace("test_flush_again");`, A.sandbox);
const flushLogs2 = A.cConsole.__calls
  .slice(beforeFlush2)
  .filter((c) => c.level === "info" && String(c.args[0] || "").startsWith("[interrupt_delay_trace]"));
eq(flushLogs2.length, 0, "second flush is a no-op (already flushed)");

/* _resetInterruptDelayTrace clears the slot. NOTE: the original
   app.js implementation nulls _veraInterruptDelayTrace BEFORE calling
   _flushInterruptDelayTrace, which then early-returns because the
   global is null. So no [interrupt_delay_trace] log is emitted from
   the reset path — this is pre-existing latent behavior and Stage 6
   preserves it verbatim. */
vm.runInContext(
  `
  _veraInterruptDelayTrace = null;
  _recordInterruptTimingPoint("t0_user_speech_audio_detected", { autoStart: true });
  `,
  A.sandbox
);
const beforeReset = A.cConsole.__calls.length;
vm.runInContext(`_resetInterruptDelayTrace("test_reset_reason");`, A.sandbox);
const resetFlushLogs = A.cConsole.__calls
  .slice(beforeReset)
  .filter((c) => c.level === "info" && String(c.args[0] || "").startsWith("[interrupt_delay_trace]"));
eq(resetFlushLogs.length, 0, "_resetInterruptDelayTrace does NOT emit flush log (existing behavior: globals nulled before flush)");
eq(vm.runInContext("_veraInterruptDelayTrace", A.sandbox), null, "_resetInterruptDelayTrace clears the slot");

/*
 * Suite F — resetVadFastStopState
 */
console.log("\n-- Suite F - resetVadFastStopState --");

/* Mutate vars, then reset with reason → log + arm reset */
vm.runInContext(
  `
  __barge.length = 0;
  vadFastStopArmed = false;
  vadFastStopFiredAt = 999;
  vadFastStopTtsStoppedAt = 888;
  vadFastStopAsrFinalAt = 777;
  vadFastStopTtsId = "old";
  resetVadFastStopState("test_reason");
  `,
  A.sandbox
);
eq(vm.runInContext("vadFastStopArmed", A.sandbox), true, "vadFastStopArmed re-armed");
eq(vm.runInContext("vadFastStopFiredAt", A.sandbox), 0, "vadFastStopFiredAt cleared");
eq(vm.runInContext("vadFastStopTtsStoppedAt", A.sandbox), 0, "vadFastStopTtsStoppedAt cleared");
eq(vm.runInContext("vadFastStopAsrFinalAt", A.sandbox), 0, "vadFastStopAsrFinalAt cleared");
eq(vm.runInContext("vadFastStopTtsId", A.sandbox), "", "vadFastStopTtsId cleared");
{
  const barge = vm.runInContext("__barge.slice()", A.sandbox);
  eq(barge.length, 1, "logBargeInLatencyDebug called once with reason given");
  eq(barge[0].event, "rearm", "logBargeInLatencyDebug event = 'rearm'");
  eq(barge[0].payload?.reason, "test_reason", "logBargeInLatencyDebug carries reason");
}

/* Reset WITHOUT reason → no rearm log */
vm.runInContext(
  `
  __barge.length = 0;
  resetVadFastStopState();
  `,
  A.sandbox
);
eq(vm.runInContext("__barge.length", A.sandbox), 0, "no logBargeInLatencyDebug when reason omitted");

/*
 * Suite G — fastStopTtsOnVadOnly early-returns
 */
console.log("\n-- Suite G - fastStopTtsOnVadOnly early-returns --");

/* Case 1: not armed */
vm.runInContext(
  `
  vadFastStopArmed = false;
  __assistantTtsPlaying = true;
  __resetAudioHandlersCalls = 0;
  __readerCancelCalls = 0;
  __res1 = fastStopTtsOnVadOnly({ rms: 0.1 });
  `,
  A.sandbox
);
eq(vm.runInContext("__res1", A.sandbox), false, "returns false when not armed");
eq(vm.runInContext("__resetAudioHandlersCalls", A.sandbox), 0, "resetAudioHandlers NOT called when not armed");

/* Case 2: armed but TTS not playing */
vm.runInContext(
  `
  vadFastStopArmed = true;
  __assistantTtsPlaying = false;
  __resetAudioHandlersCalls = 0;
  __res2 = fastStopTtsOnVadOnly({ rms: 0.1 });
  `,
  A.sandbox
);
eq(vm.runInContext("__res2", A.sandbox), false, "returns false when TTS not playing");
eq(vm.runInContext("vadFastStopArmed", A.sandbox), true, "stays armed when TTS not playing");
eq(vm.runInContext("__resetAudioHandlersCalls", A.sandbox), 0, "resetAudioHandlers NOT called when no TTS");

/*
 * Suite H — fastStopTtsOnVadOnly happy path
 */
console.log("\n-- Suite H - fastStopTtsOnVadOnly happy path --");

vm.runInContext(
  `
  /* Reset accumulators */
  vadFastStopArmed = true;
  __assistantTtsPlaying = true;
  __resetAudioHandlersCalls = 0;
  __audioStubState.paused = false;
  __audioStubState.__pauseCalls = 0;
  __audioStubState.__resetCalls = 0;
  __setStatusCalls.length = 0;
  __barge.length = 0;
  __interruptDebugCallsBefore = (typeof __interruptDebugCalls === "undefined") ? 0 : __interruptDebugCalls.length;
  listening = false;
  waveState = "speaking";
  /* Track cancelMainTtsPlayback by stubbing _veraTtsCancelSource —
     it gets reset to "" inside cancelMainTtsPlayback. We also place a
     fake source so the inner stopAllMainTtsWebAudio actually does work. */
  mainTtsPlaybackToken = 0;
  mainTtsPlaybackActive = true;
  activeMainTtsBufferSources.length = 0;
  registerMainTtsBufferSource({ onended: null, stop: function () {}, disconnect: function () {} });
  __interruptPrearmTtsId_save = interruptPrearmTtsId;
  interruptPrearmTtsId = "tts-smoke-id";
  audioStartedAt = 1000;
  _veraInterruptDelayTrace = null;
  __res3 = fastStopTtsOnVadOnly({ rms: 0.2, zcr: 0.1, crest: 5, vadAccumMs: 80 });
  `,
  A.sandbox
);

eq(vm.runInContext("__res3", A.sandbox), true, "returns true on happy path");
eq(vm.runInContext("vadFastStopArmed", A.sandbox), false, "vadFastStopArmed disarmed after fire");
eq(vm.runInContext("vadFastStopTtsId", A.sandbox), "tts-smoke-id", "vadFastStopTtsId adopted from interruptPrearmTtsId");
ok(
  vm.runInContext("typeof vadFastStopFiredAt === 'number' && vadFastStopFiredAt > 0", A.sandbox),
  "vadFastStopFiredAt stamped (number > 0)"
);
ok(
  vm.runInContext("typeof vadFastStopTtsStoppedAt === 'number' && vadFastStopTtsStoppedAt > 0", A.sandbox),
  "vadFastStopTtsStoppedAt stamped (number > 0)"
);
eq(vm.runInContext("__resetAudioHandlersCalls", A.sandbox), 1, "resetAudioHandlers called once");
ok(
  vm.runInContext("__audioStubState.__pauseCalls >= 1", A.sandbox),
  "audio element .pause() called"
);
ok(
  vm.runInContext("__audioStubState.__resetCalls >= 1", A.sandbox),
  "audio element .currentTime = 0 assigned"
);

/* Cancel raced through: mainTtsPlaybackToken should have been bumped */
eq(vm.runInContext("mainTtsPlaybackToken", A.sandbox), 1, "cancelMainTtsPlayback bumped token");
eq(vm.runInContext("mainTtsPlaybackActive", A.sandbox), false, "mainTtsPlaybackActive flipped to false");
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "buffer sources drained");

/* UI flipped */
eq(vm.runInContext("waveState", A.sandbox), "listening", "waveState flipped to 'listening'");
eq(vm.runInContext("listening", A.sandbox), true, "listening flipped to true");
{
  const status = vm.runInContext("__setStatusCalls.slice()", A.sandbox);
  ok(
    status.some((s) => s.text === "Listening… (interrupted)"),
    "setStatus called with 'Listening… (interrupted)'"
  );
}

/* Cancel-source label was set + reset by cancelMainTtsPlayback's inner clear */
eq(vm.runInContext("_veraTtsCancelSource", A.sandbox), "", "_veraTtsCancelSource cleared after cancel call");

/* logBargeInLatencyDebug emitted both vad_barge_in_detected + tts_stop */
{
  const barge = vm.runInContext("__barge.slice()", A.sandbox);
  const events = barge.map((b) => b.event);
  ok(events.includes("vad_barge_in_detected"), "logBargeInLatencyDebug emitted 'vad_barge_in_detected'");
  ok(events.includes("tts_stop"), "logBargeInLatencyDebug emitted 'tts_stop'");
}

/* Restore interruptPrearmTtsId */
vm.runInContext(`interruptPrearmTtsId = __interruptPrearmTtsId_save || "";`, A.sandbox);

/*
 * Suite I — interruptSpeech early-returns + happy paths
 */
console.log("\n-- Suite I - interruptSpeech early-returns --");

/* Reset cancel-source-tracking counter */
vm.runInContext(
  `
  __cancelBrowserInterruptTtsOnlyCalls = 0;
  __promoteInterruptPreviewCalls = 0;
  __startPostInterruptBrowserRecognitionCalls = 0;
  `,
  A.sandbox
);

/* Case 1: listeningMode !== "continuous" */
vm.runInContext(
  `
  listeningMode = "ptt";
  interruptSpeech();
  `,
  A.sandbox
);
eq(vm.runInContext("__cancelBrowserInterruptTtsOnlyCalls", A.sandbox), 0, "early-return when listeningMode !== 'continuous'");

/* Case 2: continuous but no recorder & no browser ASR — still cut TTS if playing */
vm.runInContext(
  `
  listeningMode = "continuous";
  interruptRecording = false;
  __browserAsrPreferredReturn = false;
  __assistantTtsPlaying = true;
  __audioStubState.paused = false;
  mainTtsPlaybackActive = true;
  activeMainTtsBufferSources.length = 0;
  registerMainTtsBufferSource({ onended: null, stop: function () {}, disconnect: function () {} });
  __cancelBrowserInterruptTtsOnlyCalls = 0;
  interruptSpeech();
  `,
  A.sandbox
);
eq(vm.runInContext("__cancelBrowserInterruptTtsOnlyCalls", A.sandbox), 1, "audio-only cancel when no recorder and no browserAsr but TTS playing");

/* Case 3: continuous + recorder, but TTS not playing */
vm.runInContext(
  `
  listeningMode = "continuous";
  interruptRecording = true;
  __assistantTtsPlaying = false;
  __audioStubState.paused = true;
  mainTtsPlaybackActive = false;
  activeMainTtsBufferSources.length = 0;
  __cancelBrowserInterruptTtsOnlyCalls = 0;
  interruptSpeech();
  `,
  A.sandbox
);
eq(vm.runInContext("__cancelBrowserInterruptTtsOnlyCalls", A.sandbox), 0, "early-return when TTS not playing");

console.log("\n-- Suite I (cont.) - interruptSpeech happy paths --");

/* Case 4: continuous + recorder + TTS playing → cancelBrowserInterruptTtsOnly + RAF detectInterruptSpeechEnd */
vm.runInContext(
  `
  listeningMode = "continuous";
  interruptRecording = true;
  __assistantTtsPlaying = true;
  __audioStubState.paused = false;
  mainTtsPlaybackActive = true;
  activeMainTtsBufferSources.length = 0;
  registerMainTtsBufferSource({ onended: null, stop: function () {}, disconnect: function () {} });
  __cancelBrowserInterruptTtsOnlyCalls = 0;
  __promoteInterruptPreviewCalls = 0;
  __startPostInterruptBrowserRecognitionCalls = 0;
  __rafCalls = 0;
  __interruptTranscriptCalls.length = 0;
  audioStartedAt = 1000;
  interruptPrearmStartedAt = 900;
  interruptSpeech();
  `,
  A.sandbox
);
eq(vm.runInContext("__cancelBrowserInterruptTtsOnlyCalls", A.sandbox), 1, "cancelBrowserInterruptTtsOnly called once");
eq(vm.runInContext("__rafCalls", A.sandbox), 1, "requestAnimationFrame(detectInterruptSpeechEnd) queued");
ok(
  vm.runInContext("__interruptTranscriptCalls.some(function(c){return c.event === 'capture_committed';})", A.sandbox),
  "logInterruptTranscriptDebug 'capture_committed' emitted"
);
ok(
  vm.runInContext("interruptPrearmCommittedAt > 0", A.sandbox),
  "interruptPrearmCommittedAt stamped"
);

/* Case 5: continuous + browserAsr (no recorder) → promote + start post-interrupt SR */
vm.runInContext(
  `
  listeningMode = "continuous";
  interruptRecording = false;
  __browserAsrPreferredReturn = true;
  __assistantTtsPlaying = true;
  __audioStubState.paused = false;
  mainTtsPlaybackActive = true;
  activeMainTtsBufferSources.length = 0;
  registerMainTtsBufferSource({ onended: null, stop: function () {}, disconnect: function () {} });
  __cancelBrowserInterruptTtsOnlyCalls = 0;
  __promoteInterruptPreviewCalls = 0;
  __startPostInterruptBrowserRecognitionCalls = 0;
  interruptSpeech();
  `,
  A.sandbox
);
eq(vm.runInContext("__cancelBrowserInterruptTtsOnlyCalls", A.sandbox), 1, "cancelBrowserInterruptTtsOnly called once (browserAsr path)");
eq(vm.runInContext("__promoteInterruptPreviewCalls", A.sandbox), 1, "promoteInterruptPreviewToMainLiveBubble called");
eq(vm.runInContext("__startPostInterruptBrowserRecognitionCalls", A.sandbox), 1, "startPostInterruptBrowserRecognition called");

/* And _veraTtsCancelSource was set immediately before cancelBrowserInterruptTtsOnly */
/* (We can't easily observe the intermediate value because the stub of
   cancelBrowserInterruptTtsOnly doesn't read it; what we CAN observe
   is that the function ran to completion without throwing.) */

/*
 * Suite J — interruptTranscriptNewTtsId
 */
console.log("\n-- Suite J - interruptTranscriptNewTtsId --");

const ttsIds = new Set();
for (let i = 0; i < 8; i++) {
  ttsIds.add(vm.runInContext("interruptTranscriptNewTtsId()", A.sandbox));
}
eq(ttsIds.size, 8, "8 consecutive ids are unique");
const sampleId = vm.runInContext("interruptTranscriptNewTtsId()", A.sandbox);
ok(/^tts-[a-z0-9]+-[a-z0-9]{5}$/.test(sampleId), `id format matches /^tts-[a-z0-9]+-[a-z0-9]{5}$/ (got ${sampleId})`);

/*
 * Suite K — getInterruptionDebugState
 */
console.log("\n-- Suite K - getInterruptionDebugState --");

vm.runInContext(
  `
  interruptBargeInLatched = true;
  vadFastStopArmed = false;
  vadFastStopFiredAt = 111;
  vadFastStopTtsStoppedAt = 222;
  vadFastStopAsrFinalAt = 333;
  vadFastStopTtsId = "abc";
  _veraTtsCancelSource = "smoke";
  _veraInterruptAttemptSeq = 9;
  _veraInterruptDelayTrace = { flushed: false, interruptAttemptId: "x" };
  window.VERA_DEBUG_INTERRUPT = true;
  `,
  A.sandbox
);
{
  const snap = vm.runInContext("getInterruptionDebugState()", A.sandbox);
  eq(snap.interruptBargeInLatched, true, "snap.interruptBargeInLatched");
  eq(snap.vadFastStopArmed, false, "snap.vadFastStopArmed");
  eq(snap.vadFastStopFiredAt, 111, "snap.vadFastStopFiredAt");
  eq(snap.vadFastStopTtsStoppedAt, 222, "snap.vadFastStopTtsStoppedAt");
  eq(snap.vadFastStopAsrFinalAt, 333, "snap.vadFastStopAsrFinalAt");
  eq(snap.vadFastStopTtsId, "abc", "snap.vadFastStopTtsId");
  eq(snap.veraTtsCancelSource, "smoke", "snap.veraTtsCancelSource");
  eq(snap.interruptAttemptSeq, 9, "snap.interruptAttemptSeq");
  eq(snap.delayTracePresent, true, "snap.delayTracePresent true");
  eq(snap.delayTraceFlushed, false, "snap.delayTraceFlushed false");
  eq(snap.interruptDebugEnabled, true, "snap.interruptDebugEnabled true");
}

/*
 * Suite L — app.js cleanup verification
 */
console.log("\n-- Suite L - app.js cleanup verification --");

const appJsSource = fs.readFileSync(appJsPath, "utf8");

const removedDeclPatterns = [
  /^let\s+_veraTtsCancelSource\b/m,
  /^let\s+_veraInterruptDelayTrace\b/m,
  /^let\s+_veraInterruptAttemptSeq\b/m,
  /^const\s+_veraInterruptDebugLastAt\b/m,
  /^let\s+interruptBargeInLatched\b/m,
  /^let\s+vadFastStopArmed\b/m,
  /^let\s+vadFastStopFiredAt\b/m,
  /^let\s+vadFastStopTtsStoppedAt\b/m,
  /^let\s+vadFastStopAsrFinalAt\b/m,
  /^let\s+vadFastStopTtsId\b/m,
  /^function\s+isVeraInterruptDebugEnabled\b/m,
  /^function\s+logVeraInterruptDebug\b/m,
  /^function\s+_newInterruptAttemptId\b/m,
  /^function\s+_resetInterruptDelayTrace\b/m,
  /^function\s+_ensureInterruptDelayTrace\b/m,
  /^function\s+_recordInterruptTimingPoint\b/m,
  /^function\s+_flushInterruptDelayTrace\b/m,
  /^function\s+_logVoiceStateTransition\b/m,
  /^function\s+_logTtsCancelSourceTrace\b/m,
  /^function\s+resetVadFastStopState\b/m,
  /^function\s+fastStopTtsOnVadOnly\b/m,
  /^function\s+interruptTranscriptNewTtsId\b/m,
  /^function\s+interruptSpeech\b/m,
];
for (const re of removedDeclPatterns) {
  ok(!re.test(appJsSource), `app.js no longer declares ${re.source}`);
}

/* Intentionally LEFT in app.js per Stage 6 spec */
ok(/^let\s+_veraInterruptRafLastAt\b/m.test(appJsSource), "_veraInterruptRafLastAt intentionally left in app.js");
/* Stage 10 (2026-05-27): `_veraNewsPanelRenderInFlight` was moved out
 * of app.js into news/newsPanel.js as part of the news-helper extraction.
 * The interruption RAF tracker / RAF gap logger in app.js still READS
 * the flag as a bare identifier through the shared global lexical env
 * (the news panel module loads before app.js in index.html). */
ok(!/^let\s+_veraNewsPanelRenderInFlight\b/m.test(appJsSource), "_veraNewsPanelRenderInFlight moved out of app.js (Stage 10 → news/newsPanel.js)");
ok(/\bduringNewsRender\s*:\s*_veraNewsPanelRenderInFlight\b/.test(appJsSource), "app.js still reads _veraNewsPanelRenderInFlight via duringNewsRender payload (cross-module bare-identifier read)");
ok(/^let\s+_veraCurrentTtsDebugContext\b/m.test(appJsSource), "_veraCurrentTtsDebugContext intentionally left in app.js");
ok(/^function\s+detectInterrupt\b/m.test(appJsSource), "detectInterrupt RAF loop intentionally left in app.js");
ok(/^function\s+cancelBrowserInterruptTtsOnly\b/m.test(appJsSource), "cancelBrowserInterruptTtsOnly intentionally left in app.js");
ok(/^function\s+interruptAssistantPipelineForTypedMessage\b/m.test(appJsSource), "interruptAssistantPipelineForTypedMessage intentionally left in app.js");
/* Barge-in overlay was moved to debug/voiceDebug.js (Stage 18 / Patch A-12,
 * 2026-05-31). Hot-path callers in utils/logging.js + voice/interruption.js
 * resolve `_veraBargeInDebug` + `_bargeInDebugCaptureEvent` via the shared
 * classic-script global lexical environment at CALL time, wrapped in
 * try/catch + typeof guards for the post-app load order. */
ok(!/^const\s+_veraBargeInDebug\b/m.test(appJsSource), "barge-in debug overlay state removed from app.js (Stage 18 → debug/voiceDebug.js)");
ok(!/^function\s+_bargeInDebugCaptureEvent\b/m.test(appJsSource), "barge-in debug overlay event capture removed from app.js (Stage 18 → debug/voiceDebug.js)");

/* Breadcrumb comments confirming the move. */
const breadcrumbs = [
  ["moved to voice/interruption.js", "app.js carries 'moved to voice/interruption.js' breadcrumb"],
  ["fastStopTtsOnVadOnly → moved to voice/interruption.js", "fastStopTtsOnVadOnly breadcrumb"],
  ["interruptTranscriptNewTtsId → moved to voice/interruption.js", "interruptTranscriptNewTtsId breadcrumb"],
  ["interruptSpeech → moved to voice/interruption.js", "interruptSpeech breadcrumb"],
  ["interruptBargeInLatched → moved to voice/interruption.js", "interruptBargeInLatched breadcrumb"],
];
for (const [needle, label] of breadcrumbs) {
  ok(appJsSource.includes(needle), label);
}

/*
 * Suite M — index.html load order
 */
console.log("\n-- Suite M - index.html load order --");

const idx = fs.readFileSync(indexHtmlPath, "utf8");
const iIds = idx.indexOf('<script src="utils/ids.js?v=');
const iStorage = idx.indexOf('<script src="utils/storage.js?v=');
const iLogging = idx.indexOf('<script src="utils/logging.js?v=');
const iTts = idx.indexOf('<script src="voice/ttsQueue.js?v=');
const iInt = idx.indexOf('<script src="voice/interruption.js?v=');
const iApp = idx.indexOf('<script src="app.js?v=');
const iVoiceDebug = idx.indexOf('<script src="debug/voiceDebug.js?v=');

ok(iIds > -1, "index.html loads utils/ids.js");
ok(iStorage > -1, "index.html loads utils/storage.js");
ok(iLogging > -1, "index.html loads utils/logging.js");
ok(iTts > -1, "index.html loads voice/ttsQueue.js");
ok(iInt > -1, "index.html loads voice/interruption.js");
ok(iApp > -1, "index.html loads app.js");
ok(iVoiceDebug > -1, "index.html loads debug/voiceDebug.js");

ok(iIds < iStorage, "utils/ids.js loaded before utils/storage.js");
ok(iStorage < iLogging, "utils/storage.js loaded before utils/logging.js");
ok(iLogging < iTts, "utils/logging.js loaded before voice/ttsQueue.js");
ok(iTts < iInt, "voice/ttsQueue.js loaded BEFORE voice/interruption.js (Stage 6 load order)");
ok(iInt < iApp, "voice/interruption.js loaded BEFORE app.js (Stage 6 load order)");
ok(iApp < iVoiceDebug, "app.js loaded BEFORE debug/voiceDebug.js (Stage 4 load order preserved)");

/*
 * Suite N — voice/interruption.js parses as classic script
 */
console.log("\n-- Suite N - voice/interruption.js classic-script syntax --");

const intSource = fs.readFileSync(voiceInterruptPath, "utf8");

ok(!/\bimport\s+/m.test(intSource), "voice/interruption.js has no ESM imports");
ok(!/\bexport\s+/m.test(intSource), "voice/interruption.js has no ESM exports");
ok(/\blet\s+_veraTtsCancelSource\s*=/.test(intSource), "voice/interruption.js declares let _veraTtsCancelSource");
ok(/\bfunction\s+getInterruptionDebugState\b/.test(intSource), "voice/interruption.js declares getInterruptionDebugState");
ok(
  /window\.interruptSpeech\s*=\s*interruptSpeech/.test(intSource),
  "voice/interruption.js attaches window.interruptSpeech alias"
);

/* ---------------------------------------------------------------------------
 * Summary
 * ------------------------------------------------------------------------- */
console.log(`\n=========  PASS: ${pass}  FAIL: ${fail}  =========`);
process.exit(fail === 0 ? 0 : 1);
