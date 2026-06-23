/* ============================================================================
 * __tts_queue_extraction_smoke.mjs
 *
 * Verifies the Stage 5 extraction of the main-TTS playback / queue /
 * cancellation layer from app.js into voice/ttsQueue.js. Does NOT
 * exercise the real DOM / Web Audio / NDJSON network paths — instead:
 *
 *   1. voice/ttsQueue.js parses and runs in a classic-script-like
 *      context that already carries utils/ids.js + utils/storage.js
 *      + utils/logging.js + the small set of app.js bindings the
 *      cancellation paths reach for (logVeraInterruptDebug,
 *      _recordInterruptTimingPoint, _logTtsCancelSourceTrace,
 *      _veraTtsCancelSource, interruptRecording,
 *      _veraNewsPanelRenderInFlight, stopBmoTtsMouthAnimation).
 *   2. Module-level TTS state bindings exist post-load:
 *        let mainTtsPlaybackToken (0),
 *        let mainTtsPlaybackActive (false),
 *        let activeMainTtsBufferSources ([]),
 *        let activeNdjsonBodyReader (null).
 *   3. The new accessor API is correct + read-only:
 *        isMainTtsPlaying() -> false when both flag false + array empty.
 *        getTtsDebugState() snapshot reflects internal state.
 *   4. registerMainTtsBufferSource() + the onended hook drain the array.
 *   5. createTtsUrlQueue() honours push / next / end ordering and
 *      releases pending await on end().
 *   6. cancelMainTtsPlayback() bumps the token, drains the source
 *      array, clears activeNdjsonBodyReader, calls .cancel() on the
 *      stashed reader, and emits the expected logVeraInterruptDebug
 *      tags (tts_cancel_called → tts_stop_all_sources →
 *      tts_cancel_after).
 *   7. stopAllMainTtsWebAudio() calls src.stop(0) on every registered
 *      buffer source and tolerates sources that throw on stop().
 *   8. Race-close: bumping mainTtsPlaybackToken between schedule and
 *      actual src.start would be honoured (sanity check on the
 *      token-mismatch guard via the gapless / incremental signatures —
 *      we only verify they exist and are async functions; behaviour
 *      tests require a real AudioContext).
 *   9. The seven required window aliases exist after voice/ttsQueue.js
 *      load:
 *        window.cancelMainTtsPlayback
 *        window.stopAllMainTtsWebAudio
 *        window.runNdjsonTtsPlayback
 *        window.playTtsUrlSequenceIncremental
 *        window.playTtsUrlSequenceGapless
 *        window.isMainTtsPlaying
 *        window.getTtsDebugState
 *  10. app.js no longer defines the moved bindings at top level —
 *      breadcrumb comments are present instead. isAssistantTtsPlaying
 *      remains in app.js (intentional, per Stage 5 spec).
 *  11. index.html load order: utils/ids → utils/storage → utils/logging
 *      → voice/ttsQueue → app.js → debug/voiceDebug.js.
 *
 * Run:  node tests/smoke/__tts_queue_extraction_smoke.mjs
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
 * Build a sandbox mirroring index.html's load order minus app.js:
 *   utils/ids.js  →  utils/storage.js  →  utils/logging.js
 *     →  (app-stub: bindings ttsQueue.js reaches for at CALL time)
 *     →  voice/ttsQueue.js
 *
 * The "app-stub" supplies the minimum surface ttsQueue's cancellation
 * helpers consult. It is intentionally lightweight: real BMO mouth /
 * face / audio context / fetch are out of scope here.
 * ------------------------------------------------------------------------- */
function buildLoadedSandbox() {
  const cConsole = makeCapturingConsole();
  /* Fake `document.body.classList.contains("bmo-open")` -> false always,
     so stopBmoTtsMouthAnimation is NOT invoked from stopAllMainTtsWebAudio. */
  const docStub = {
    body: { classList: { contains: () => false } },
  };
  const sandbox = vm.createContext({
    console: cConsole,
    window: {},
    document: docStub,
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 12345.6 },
    /* Globals utils/logging.js looks at: */
    location: { search: "" },
    /* Logging helpers logVeraInterruptDebug etc. resolve through
       utils/logging.js — but that module only defines the per-namespace
       loggers in app.js. So we stub them ourselves: */
  });
  sandbox.globalThis = sandbox;

  vm.runInContext(fs.readFileSync(utilsIdsPath, "utf8"), sandbox, { filename: "utils/ids.js" });
  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });
  vm.runInContext(fs.readFileSync(utilsLoggingPath, "utf8"), sandbox, { filename: "utils/logging.js" });

  /* App-stub: bindings that voice/ttsQueue.js function bodies reach
     for at CALL time. Declared as `var` so they live on globalThis and
     are observable to test assertions. Side-effects are recorded in
     arrays we can inspect. */
  const appStub = `
    var __interruptDebugCalls = [];
    function logVeraInterruptDebug(payload, opts) {
      __interruptDebugCalls.push({ payload: payload, opts: opts || null });
    }
    var __timingPoints = [];
    function _recordInterruptTimingPoint(label, opts) {
      __timingPoints.push({ label: label, opts: opts || null });
    }
    var __cancelSourceTraceCalls = [];
    function _logTtsCancelSourceTrace(where, source) {
      __cancelSourceTraceCalls.push({ where: where, source: source });
    }
    var _veraTtsCancelSource = "";
    var interruptRecording = false;
    var _veraNewsPanelRenderInFlight = false;
    var __stopBmoMouthCalls = 0;
    function stopBmoTtsMouthAnimation() { __stopBmoMouthCalls += 1; }
  `;
  vm.runInContext(appStub, sandbox, { filename: "tests/smoke/__tts_queue_app_stub__" });

  vm.runInContext(fs.readFileSync(voiceTtsPath, "utf8"), sandbox, { filename: "voice/ttsQueue.js" });

  return { sandbox, cConsole };
}

/*
 * Suite A — voice/ttsQueue.js loads and declares the right bindings
 */
console.log("-- Suite A - voice/ttsQueue.js loads + state bindings exist --");

const A = buildLoadedSandbox();

eq(vm.runInContext("typeof mainTtsPlaybackToken", A.sandbox), "number", "mainTtsPlaybackToken declared (number)");
eq(vm.runInContext("mainTtsPlaybackToken", A.sandbox), 0, "mainTtsPlaybackToken initial value 0");
eq(vm.runInContext("typeof mainTtsPlaybackActive", A.sandbox), "boolean", "mainTtsPlaybackActive declared (boolean)");
eq(vm.runInContext("mainTtsPlaybackActive", A.sandbox), false, "mainTtsPlaybackActive initial value false");
eq(vm.runInContext("Array.isArray(activeMainTtsBufferSources)", A.sandbox), true, "activeMainTtsBufferSources declared (array)");
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "activeMainTtsBufferSources empty");
eq(vm.runInContext("activeNdjsonBodyReader", A.sandbox), null, "activeNdjsonBodyReader initial value null");

/*
 * Suite B — function declarations exist and have expected types
 */
console.log("\n-- Suite B - function declarations + types --");

const fns = [
  ["registerMainTtsBufferSource", "function"],
  ["stopAllMainTtsWebAudio", "function"],
  ["cancelMainTtsPlayback", "function"],
  ["createTtsUrlQueue", "function"],
  ["playTtsUrlSequenceGapless", "function"],
  ["playTtsUrlSequenceIncremental", "function"],
  ["runNdjsonTtsPlayback", "function"],
  ["isMainTtsPlaying", "function"],
  ["getTtsDebugState", "function"],
];
for (const [name, t] of fns) {
  eq(vm.runInContext(`typeof ${name}`, A.sandbox), t, `${name} declared (${t})`);
}

/* Async functions: their .constructor.name is "AsyncFunction". */
for (const name of ["playTtsUrlSequenceGapless", "playTtsUrlSequenceIncremental", "runNdjsonTtsPlayback"]) {
  eq(
    vm.runInContext(`${name}.constructor.name`, A.sandbox),
    "AsyncFunction",
    `${name} is async`
  );
}

/*
 * Suite C — window aliases attached
 */
console.log("\n-- Suite C - window aliases attached --");

const winAliases = [
  "cancelMainTtsPlayback",
  "stopAllMainTtsWebAudio",
  "runNdjsonTtsPlayback",
  "playTtsUrlSequenceIncremental",
  "playTtsUrlSequenceGapless",
  "isMainTtsPlaying",
  "getTtsDebugState",
];
for (const name of winAliases) {
  eq(
    vm.runInContext(`typeof window.${name}`, A.sandbox),
    "function",
    `window.${name} attached after ttsQueue load`
  );
  eq(
    vm.runInContext(`window.${name} === ${name}`, A.sandbox),
    true,
    `window.${name} identity matches bare ${name}`
  );
}

/*
 * Suite D — read-only accessors
 */
console.log("\n-- Suite D - isMainTtsPlaying + getTtsDebugState read-only --");

eq(vm.runInContext("isMainTtsPlaying()", A.sandbox), false, "isMainTtsPlaying() false when idle");
{
  const snap = vm.runInContext("getTtsDebugState()", A.sandbox);
  eq(snap.mainTtsPlaybackActive, false, "snapshot.mainTtsPlaybackActive false");
  eq(snap.mainTtsPlaybackToken, 0, "snapshot.mainTtsPlaybackToken 0");
  eq(snap.activeMainTtsBufferSourcesCount, 0, "snapshot.activeMainTtsBufferSourcesCount 0");
  eq(snap.activeNdjsonBodyReaderPresent, false, "snapshot.activeNdjsonBodyReaderPresent false");
}

/* Flip mainTtsPlaybackActive directly to confirm isMainTtsPlaying reflects it */
vm.runInContext("mainTtsPlaybackActive = true;", A.sandbox);
eq(vm.runInContext("isMainTtsPlaying()", A.sandbox), true, "isMainTtsPlaying() true when mainTtsPlaybackActive flips");
vm.runInContext("mainTtsPlaybackActive = false;", A.sandbox);
eq(vm.runInContext("isMainTtsPlaying()", A.sandbox), false, "isMainTtsPlaying() false after flip back");

/* Push a fake source — isMainTtsPlaying should report true via array.length */
vm.runInContext(
  `
  var __srcStops = 0;
  var __srcDisconnects = 0;
  var __testSrc1 = {
    onended: null,
    stop: function () { __srcStops += 1; },
    disconnect: function () { __srcDisconnects += 1; },
  };
  registerMainTtsBufferSource(__testSrc1);
  `,
  A.sandbox
);
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 1, "registerMainTtsBufferSource pushed source");
eq(vm.runInContext("isMainTtsPlaying()", A.sandbox), true, "isMainTtsPlaying() true when array has source");
/* Synthesize the natural onended — should remove from array */
vm.runInContext("__testSrc1.onended && __testSrc1.onended();", A.sandbox);
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "onended removes source from array");
eq(vm.runInContext("isMainTtsPlaying()", A.sandbox), false, "isMainTtsPlaying() false after natural end");

/*
 * Suite E — createTtsUrlQueue ordering + end()
 */
console.log("\n-- Suite E - createTtsUrlQueue push/next/end --");

await (async () => {
  const queue = vm.runInContext("createTtsUrlQueue()", A.sandbox);
  queue.push("/audio/a");
  queue.push("/audio/b");
  eq(await queue.next(), "/audio/a", "queue.next() returns first push");
  eq(await queue.next(), "/audio/b", "queue.next() returns second push");
  /* No more items, then end() — next() should resolve with null */
  const pending = queue.next();
  queue.end();
  eq(await pending, null, "queue.next() pending await resolves to null on end()");
  /* Subsequent next() returns null immediately */
  eq(await queue.next(), null, "queue.next() after end() returns null immediately");
})();

/*
 * Suite F — cancelMainTtsPlayback bumps token, drains, cancels reader
 */
console.log("\n-- Suite F - cancelMainTtsPlayback behaviour --");

/* Set up: token=0, register a couple of fake sources, and a fake reader */
vm.runInContext(
  `
  // Reset state via direct assignments (debug-style)
  mainTtsPlaybackToken = 0;
  mainTtsPlaybackActive = true;
  activeMainTtsBufferSources.length = 0;
  __interruptDebugCalls.length = 0;
  __timingPoints.length = 0;
  __cancelSourceTraceCalls.length = 0;
  _veraTtsCancelSource = "smoke_test_source";

  var __readerCancelCalls = 0;
  activeNdjsonBodyReader = {
    cancel: function () { __readerCancelCalls += 1; }
  };

  var __srcAStops = 0, __srcBStops = 0;
  var __srcA = { onended: null, stop: function () { __srcAStops += 1; }, disconnect: function () {} };
  var __srcB = {
    onended: null,
    stop: function () { __srcBStops += 1; throw new Error("already stopped"); },
    disconnect: function () {}
  };
  registerMainTtsBufferSource(__srcA);
  registerMainTtsBufferSource(__srcB);
  `,
  A.sandbox
);

eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 2, "2 sources registered pre-cancel");

vm.runInContext("cancelMainTtsPlayback();", A.sandbox);

eq(vm.runInContext("mainTtsPlaybackToken", A.sandbox), 1, "mainTtsPlaybackToken bumped to 1");
eq(vm.runInContext("mainTtsPlaybackActive", A.sandbox), false, "mainTtsPlaybackActive flipped to false");
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "buffer sources array drained");
eq(vm.runInContext("activeNdjsonBodyReader", A.sandbox), null, "activeNdjsonBodyReader cleared");
eq(vm.runInContext("__readerCancelCalls", A.sandbox), 1, "active NDJSON reader .cancel() called once");
eq(vm.runInContext("__srcAStops", A.sandbox), 1, "buffer source A .stop(0) called");
eq(vm.runInContext("__srcBStops", A.sandbox), 1, "buffer source B .stop(0) called (even though it throws)");
eq(vm.runInContext("_veraTtsCancelSource", A.sandbox), "", "_veraTtsCancelSource cleared after cancel");

/* Expected debug-log tags from cancelMainTtsPlayback path */
const debugTags = vm.runInContext("__interruptDebugCalls.map(c => c.payload && c.payload.tag)", A.sandbox);
ok(debugTags.includes("tts_cancel_called"), "logVeraInterruptDebug emitted tts_cancel_called");
ok(debugTags.includes("tts_stop_all_sources"), "logVeraInterruptDebug emitted tts_stop_all_sources");
ok(debugTags.includes("tts_cancel_after"), "logVeraInterruptDebug emitted tts_cancel_after");

/* Cancel + stop timing points */
const timingLabels = vm.runInContext("__timingPoints.map(p => p.label)", A.sandbox);
ok(timingLabels.includes("t6_cancelMainTtsPlayback_called"), "_recordInterruptTimingPoint t6 captured");
ok(timingLabels.includes("t7_stopAllMainTtsWebAudio_called"), "_recordInterruptTimingPoint t7 captured");
ok(timingLabels.includes("t10_audio_sources_zero"), "_recordInterruptTimingPoint t10 captured (sources zero after cancel)");

/* Cancel-source trace */
const cancelTraceWheres = vm.runInContext("__cancelSourceTraceCalls.map(c => c.where)", A.sandbox);
ok(cancelTraceWheres.includes("cancelMainTtsPlayback"), "_logTtsCancelSourceTrace cancelMainTtsPlayback recorded");
ok(cancelTraceWheres.includes("stopAllMainTtsWebAudio"), "_logTtsCancelSourceTrace stopAllMainTtsWebAudio recorded");

/* Second cancel — should keep bumping token from 1 -> 2 and no longer throw */
vm.runInContext("cancelMainTtsPlayback();", A.sandbox);
eq(vm.runInContext("mainTtsPlaybackToken", A.sandbox), 2, "second cancelMainTtsPlayback bumps token again");

/*
 * Suite G — stopAllMainTtsWebAudio tolerates empty + non-empty arrays
 */
console.log("\n-- Suite G - stopAllMainTtsWebAudio tolerance --");

/* Reset state to empty */
vm.runInContext(
  `
  activeMainTtsBufferSources.length = 0;
  mainTtsPlaybackActive = false;
  __interruptDebugCalls.length = 0;
  `,
  A.sandbox
);

vm.runInContext("stopAllMainTtsWebAudio();", A.sandbox);
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "stopAllMainTtsWebAudio safe on empty array");
const emptyStopTags = vm.runInContext("__interruptDebugCalls.map(c => c.payload && c.payload.tag)", A.sandbox);
ok(emptyStopTags.includes("tts_stop_all_sources"), "stopAllMainTtsWebAudio emits tts_stop_all_sources tag even on empty");

/* Non-empty path */
vm.runInContext(
  `
  __interruptDebugCalls.length = 0;
  mainTtsPlaybackActive = true;
  var __stopThrow1 = 0, __stopThrow2 = 0;
  var __throwSrc = { onended: function () {}, stop: function () { __stopThrow1 += 1; throw new Error("boom"); }, disconnect: function () {} };
  var __cleanSrc = { onended: function () {}, stop: function () { __stopThrow2 += 1; }, disconnect: function () {} };
  registerMainTtsBufferSource(__throwSrc);
  registerMainTtsBufferSource(__cleanSrc);
  stopAllMainTtsWebAudio();
  `,
  A.sandbox
);
eq(vm.runInContext("__stopThrow1", A.sandbox), 1, "stopAllMainTtsWebAudio called throwing-source.stop once");
eq(vm.runInContext("__stopThrow2", A.sandbox), 1, "stopAllMainTtsWebAudio called clean-source.stop once");
eq(vm.runInContext("activeMainTtsBufferSources.length", A.sandbox), 0, "stopAllMainTtsWebAudio drained the array");
eq(vm.runInContext("mainTtsPlaybackActive", A.sandbox), false, "stopAllMainTtsWebAudio flips mainTtsPlaybackActive to false");

/*
 * Suite H — getTtsDebugState reflects mutated state
 */
console.log("\n-- Suite H - getTtsDebugState reflects mutations --");

vm.runInContext(
  `
  mainTtsPlaybackToken = 42;
  mainTtsPlaybackActive = true;
  activeMainTtsBufferSources.length = 0;
  var __srcX = { onended: null, stop: function () {}, disconnect: function () {} };
  registerMainTtsBufferSource(__srcX);
  activeNdjsonBodyReader = { cancel: function () {} };
  `,
  A.sandbox
);
{
  const snap = vm.runInContext("getTtsDebugState()", A.sandbox);
  eq(snap.mainTtsPlaybackToken, 42, "snapshot reflects token=42");
  eq(snap.mainTtsPlaybackActive, true, "snapshot reflects active=true");
  eq(snap.activeMainTtsBufferSourcesCount, 1, "snapshot reflects 1 active source");
  eq(snap.activeNdjsonBodyReaderPresent, true, "snapshot reflects active reader");
}

/*
 * Suite I — app.js no longer declares the moved bindings; breadcrumbs present
 */
console.log("\n-- Suite I - app.js cleanup verification --");

const appJsSource = fs.readFileSync(appJsPath, "utf8");

const removedDeclPatterns = [
  /^let\s+activeMainTtsBufferSources\b/m,
  /^let\s+mainTtsPlaybackActive\b/m,
  /^let\s+mainTtsPlaybackToken\b/m,
  /^let\s+activeNdjsonBodyReader\b/m,
  /^function\s+registerMainTtsBufferSource\b/m,
  /^function\s+stopAllMainTtsWebAudio\b/m,
  /^function\s+cancelMainTtsPlayback\b/m,
  /^function\s+createTtsUrlQueue\b/m,
  /^async\s+function\s+playTtsUrlSequenceGapless\b/m,
  /^async\s+function\s+playTtsUrlSequenceIncremental\b/m,
  /^async\s+function\s+runNdjsonTtsPlayback\b/m,
  /* Patch A-7 (Stage 21, 2026-05-31): residual main-TTS bookkeeping moved. */
  /^function\s+isAssistantTtsPlaying\b/m,
  /^let\s+activePipelineAbort\b/m,
  /^let\s+queuedAssistantTtsPlayback\b/m,
  /^function\s+attachPipelineAbortSignal\b/m,
  /^function\s+enqueueAssistantTtsPlayback\b/m,
  /^async\s+function\s+waitUntilAssistantTtsIdle\b/m,
];
for (const re of removedDeclPatterns) {
  ok(!re.test(appJsSource), `app.js no longer declares ${re.source}`);
}

/* Patch A-7 (Stage 21, 2026-05-31): residual main-TTS bookkeeping
 * now lives in voice/ttsQueue.js (loaded before app.js per index.html). */
const movedToTtsQueuePatterns = [
  [/^function\s+isAssistantTtsPlaying\b/m,    "voice/ttsQueue.js declares function isAssistantTtsPlaying (Patch A-7)"],
  [/^let\s+activePipelineAbort\b/m,           "voice/ttsQueue.js declares let activePipelineAbort (Patch A-7)"],
  [/^let\s+queuedAssistantTtsPlayback\b/m,    "voice/ttsQueue.js declares let queuedAssistantTtsPlayback (Patch A-7)"],
  [/^function\s+attachPipelineAbortSignal\b/m,"voice/ttsQueue.js declares function attachPipelineAbortSignal (Patch A-7)"],
  [/^function\s+enqueueAssistantTtsPlayback\b/m,"voice/ttsQueue.js declares function enqueueAssistantTtsPlayback (Patch A-7)"],
  [/^async\s+function\s+waitUntilAssistantTtsIdle\b/m,"voice/ttsQueue.js declares async function waitUntilAssistantTtsIdle (Patch A-7)"],
];
const ttsSourceForMovedCheck = fs.readFileSync(voiceTtsPath, "utf8");
for (const [re, label] of movedToTtsQueuePatterns) {
  ok(re.test(ttsSourceForMovedCheck), label);
}

/* Breadcrumb comments confirming the move. */
const breadcrumbs = [
  ["moved to voice/ttsQueue.js", "app.js carries 'moved to voice/ttsQueue.js' breadcrumb"],
  ["MAIN-TTS RUNTIME STATE", "app.js carries the MAIN-TTS RUNTIME STATE removal banner"],
];
for (const [needle, label] of breadcrumbs) {
  ok(appJsSource.includes(needle), label);
}

/* Specific moved-function breadcrumbs */
const fnBreadcrumbs = [
  "playTtsUrlSequenceGapless → moved to voice/ttsQueue.js",
  "createTtsUrlQueue → moved to voice/ttsQueue.js",
  "playTtsUrlSequenceIncremental → moved to voice/ttsQueue.js",
  "runNdjsonTtsPlayback → moved to voice/ttsQueue.js",
];
for (const needle of fnBreadcrumbs) {
  ok(appJsSource.includes(needle), `app.js carries breadcrumb: ${needle}`);
}

/*
 * Suite J — index.html load order
 */
console.log("\n-- Suite J - index.html load order --");

const idx = fs.readFileSync(indexHtmlPath, "utf8");
const iIds = idx.indexOf('<script src="utils/ids.js?v=');
const iStorage = idx.indexOf('<script src="utils/storage.js?v=');
const iLogging = idx.indexOf('<script src="utils/logging.js?v=');
const iTts = idx.indexOf('<script src="voice/ttsQueue.js?v=');
const iApp = idx.indexOf('<script src="app.js?v=');
const iVoiceDebug = idx.indexOf('<script src="debug/voiceDebug.js?v=');

ok(iIds > -1, "index.html loads utils/ids.js");
ok(iStorage > -1, "index.html loads utils/storage.js");
ok(iLogging > -1, "index.html loads utils/logging.js");
ok(iTts > -1, "index.html loads voice/ttsQueue.js");
ok(iApp > -1, "index.html loads app.js");
ok(iVoiceDebug > -1, "index.html loads debug/voiceDebug.js");

ok(iIds < iStorage, "utils/ids.js loaded before utils/storage.js");
ok(iStorage < iLogging, "utils/storage.js loaded before utils/logging.js");
ok(iLogging < iTts, "utils/logging.js loaded before voice/ttsQueue.js");
ok(iTts < iApp, "voice/ttsQueue.js loaded BEFORE app.js (Stage 5 load order)");
ok(iApp < iVoiceDebug, "app.js loaded BEFORE debug/voiceDebug.js (Stage 4 load order preserved)");

/*
 * Suite K — voice/ttsQueue.js parses as classic script
 */
console.log("\n-- Suite K - voice/ttsQueue.js classic-script syntax --");

const ttsSource = fs.readFileSync(voiceTtsPath, "utf8");

ok(!/\bimport\s+/m.test(ttsSource), "voice/ttsQueue.js has no ESM imports");
ok(!/\bexport\s+/m.test(ttsSource), "voice/ttsQueue.js has no ESM exports");
ok(/\blet\s+mainTtsPlaybackToken\s*=/.test(ttsSource), "voice/ttsQueue.js declares let mainTtsPlaybackToken");
ok(/\bfunction\s+isMainTtsPlaying\b/.test(ttsSource), "voice/ttsQueue.js declares function isMainTtsPlaying");
ok(/\bfunction\s+getTtsDebugState\b/.test(ttsSource), "voice/ttsQueue.js declares function getTtsDebugState");
ok(
  /window\.cancelMainTtsPlayback\s*=\s*cancelMainTtsPlayback/.test(ttsSource),
  "voice/ttsQueue.js attaches window.cancelMainTtsPlayback alias"
);

/* ---------------------------------------------------------------------------
 * Summary
 * ------------------------------------------------------------------------- */
console.log(`\n=========  PASS: ${pass}  FAIL: ${fail}  =========`);
process.exit(fail === 0 ? 0 : 1);
