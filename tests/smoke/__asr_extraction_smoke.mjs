/* ============================================================================
 * __asr_extraction_smoke.mjs
 *
 * Verifies the Stage 7 extraction of ASR mode + transcript helpers from
 * app.js into voice/asr.js. Complements (does NOT replace)
 * __asr_mode_smoke.mjs, which exercises the helpers' RUNTIME behavior.
 *
 * This smoke focuses on the EXTRACTION itself:
 *
 *   1. voice/asr.js loads after utils/storage.js in a classic-script-like
 *      sandbox and exposes the expected bare-identifier API.
 *   2. Settings keys + mode constants exist with the correct values.
 *   3. All moved functions exist as function declarations.
 *   4. Window aliases (decideAsrFinalizationMode, chooseBestTranscript,
 *      normalizeCommandTranscript, getVeraAsrMode, setVeraAsrMode,
 *      getAsrDebugState) are attached and identity-match the bare
 *      identifiers.
 *   5. _normalizeVeraAsrMode maps the legacy values verbatim
 *      ("single" -> "whisper", "browser" -> "streaming", garbage ->
 *      default "whisper", trimming + lowercasing).
 *   6. getVeraAsrMode + setVeraAsrMode round-trip through localStorage
 *      using the moved key VERA_SETTING_ASR_MODE_KEY
 *      ("vera_setting_asr_mode_v1") via safeSetLocalStorage (from
 *      utils/storage.js).
 *   7. Silence-ms helpers (getVeraAsrSilenceMs / setVeraAsrSilenceMs)
 *      preserve their snap-to-valid behavior (1000 / 1300 / 1600) +
 *      mutate the app.js-side `browserAsrMainSilenceMs` let via the
 *      shared lexical env.
 *   8. Partial-min-chars helpers (normalize/get/set) handle the
 *      special "inf" sentinel + snap legacy values (5/8 -> 10, 12 -> 15)
 *      + mutate the app.js-side `mainAsrPartialMinChars` let.
 *   9. browserAsrPreferred returns false when browserAsrPermanentlyDisabled
 *      (the app.js-side let), when mode is whisper, and when SR is
 *      unsupported.
 *  10. browserAsrSupported + getSpeechRecognitionLang return safe
 *      defaults under the stubbed window/navigator.
 *  11. getAsrDebugState returns a stable shape with all expected fields.
 *  12. app.js no longer declares the moved bindings; intentionally LEFT
 *      bindings (browserAsrPermanentlyDisabled, browserAsrMainSilenceMs,
 *      mainAsrPartialMinChars, MediaRecorder helpers) are still present.
 *  13. index.html load order:
 *        ids -> storage -> logging -> asr -> ttsQueue -> interruption ->
 *        app -> voiceDebug.
 *  14. voice/asr.js parses as a classic script (no ESM imports/exports).
 *
 * Run:  node tests/smoke/__asr_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const voiceAsrPath = path.join(repoRoot, "voice", "asr.js");
const appJsPath = path.join(repoRoot, "app.js");
const indexHtmlPath = path.join(repoRoot, "index.html");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}`); }
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

function buildLoadedSandbox(overrides = {}) {
  const cConsole = {
    log: () => {}, info: () => {}, debug: () => {},
    warn: () => {}, error: () => {},
  };
  const win = {
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    ...(overrides.window || {}),
  };
  const sandbox = vm.createContext({
    console: cConsole,
    window: win,
    document: { body: { classList: { contains: () => false } } },
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 12345.6 },
    location: { protocol: "http:", ...(overrides.location || {}) },
    navigator: {
      userAgent: "Mozilla/5.0",
      vendor: "Google Inc.",
      languages: ["en-US"],
      language: "en-US",
      ...(overrides.navigator || {}),
    },
    setTimeout, clearTimeout,
  });
  sandbox.globalThis = sandbox;
  // mirror window helpers onto global scope (classic-script lexical env)
  for (const k of Object.keys(win)) sandbox[k] = win[k];

  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });

  /* App-stub: bindings voice/asr.js reaches for at call time */
  vm.runInContext(
    `
    const logVeraSettings = (event, data) => { (globalThis.__settingsLog = globalThis.__settingsLog || []).push({ event: event, data: data }); };
    var browserAsrMainSilenceMs = 1300;
    var mainAsrPartialMinChars = 20;
    var browserAsrPermanentlyDisabled = false;
    `,
    sandbox,
    { filename: "tests/smoke/__asr_extraction_app_stub__" }
  );

  vm.runInContext(fs.readFileSync(voiceAsrPath, "utf8"), sandbox, { filename: "voice/asr.js" });

  return sandbox;
}

/*
 * Suite A — voice/asr.js loads + settings keys / mode constants
 */
console.log("-- Suite A - voice/asr.js loads + constants exist --");

const A = buildLoadedSandbox();

eq(vm.runInContext("VERA_SETTING_ASR_MODE_KEY", A), "vera_setting_asr_mode_v1", "VERA_SETTING_ASR_MODE_KEY");
eq(vm.runInContext("VERA_SETTING_ASR_SILENCE_MS_KEY", A), "vera_setting_asr_silence_ms_v1", "VERA_SETTING_ASR_SILENCE_MS_KEY");
eq(vm.runInContext("VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY", A), "vera_setting_main_asr_partial_min_chars_v1", "VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY");
eq(vm.runInContext("VERA_ASR_MODE_DEFAULT", A), "whisper", "VERA_ASR_MODE_DEFAULT = 'whisper'");
eq(vm.runInContext("VERA_ASR_MODE_VALID instanceof Set", A), true, "VERA_ASR_MODE_VALID is a Set");
eq(vm.runInContext("Array.from(VERA_ASR_MODE_VALID).sort()", A), ["hybrid", "streaming", "whisper"], "VERA_ASR_MODE_VALID values");
eq(vm.runInContext("HYBRID_POLICY", A), "selective", "HYBRID_POLICY = 'selective'");
eq(vm.runInContext("MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT", A), 20, "MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT = 20");
eq(vm.runInContext("MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS", A), [10, 15, 20, 25, null], "MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS (Infinity serializes to null in JSON)");

/*
 * Suite B — function declarations exist
 */
console.log("\n-- Suite B - function declarations --");

const fns = [
  "_normalizeVeraAsrMode", "getVeraAsrMode", "setVeraAsrMode",
  "isHybridAsrMode", "isWhisperAsrMode", "isStreamingAsrMode",
  "getVeraAsrSilenceMs", "setVeraAsrSilenceMs",
  "normalizeMainAsrPartialMinChars", "getMainAsrPartialMinChars", "setMainAsrPartialMinChars",
  "browserAsrSupported", "getSpeechRecognitionLang",
  "isLikelyGoogleChrome", "isNarrowViewport", "browserAsrPreferred",
  "_splitCancelPrefix", "decideAsrFinalizationMode",
  "_normalizeForCompare", "_levenshtein", "_tokenOverlapRatio", "_looksHallucinated",
  "chooseBestTranscript", "normalizeCommandTranscript",
  "getAsrDebugState",
];
for (const name of fns) {
  eq(vm.runInContext(`typeof ${name}`, A), "function", `${name} declared (function)`);
}

/*
 * Suite C — window aliases attached
 */
console.log("\n-- Suite C - window aliases attached --");

const winAliases = [
  ["decideAsrFinalizationMode", "decideAsrFinalizationMode"],
  ["chooseBestTranscript", "chooseBestTranscript"],
  ["normalizeCommandTranscript", "normalizeCommandTranscript"],
  ["getVeraAsrMode", "getVeraAsrMode"],
  ["setVeraAsrMode", "setVeraAsrMode"],
  ["getAsrDebugState", "getAsrDebugState"],
];
for (const [winName, bareName] of winAliases) {
  eq(vm.runInContext(`typeof window.${winName}`, A), "function", `window.${winName} attached`);
  eq(vm.runInContext(`window.${winName} === ${bareName}`, A), true, `window.${winName} identity matches bare ${bareName}`);
}

/*
 * Suite D — _normalizeVeraAsrMode (legacy mapping)
 */
console.log("\n-- Suite D - _normalizeVeraAsrMode --");

eq(vm.runInContext(`_normalizeVeraAsrMode("single")`, A), "whisper", "'single' -> 'whisper'");
eq(vm.runInContext(`_normalizeVeraAsrMode("browser")`, A), "streaming", "'browser' -> 'streaming'");
eq(vm.runInContext(`_normalizeVeraAsrMode("HYBRID")`, A), "hybrid", "'HYBRID' case-insensitive -> 'hybrid'");
eq(vm.runInContext(`_normalizeVeraAsrMode("  Streaming  ")`, A), "streaming", "trimming + lowercase");
eq(vm.runInContext(`_normalizeVeraAsrMode("garbage")`, A), "whisper", "garbage -> default 'whisper'");
eq(vm.runInContext(`_normalizeVeraAsrMode("")`, A), "whisper", "empty -> default 'whisper'");
eq(vm.runInContext(`_normalizeVeraAsrMode(null)`, A), "whisper", "null -> default 'whisper'");
eq(vm.runInContext(`_normalizeVeraAsrMode(undefined)`, A), "whisper", "undefined -> default 'whisper'");

/*
 * Suite E — getVeraAsrMode / setVeraAsrMode round-trip + key
 */
console.log("\n-- Suite E - getVeraAsrMode / setVeraAsrMode --");

vm.runInContext(`localStorage.removeItem(VERA_SETTING_ASR_MODE_KEY);`, A);
eq(vm.runInContext("getVeraAsrMode()", A), "whisper", "default mode is 'whisper'");
vm.runInContext(`setVeraAsrMode("hybrid");`, A);
eq(vm.runInContext("localStorage.getItem(VERA_SETTING_ASR_MODE_KEY)", A), "hybrid", "set writes to localStorage key");
eq(vm.runInContext("getVeraAsrMode()", A), "hybrid", "round-trip 'hybrid'");
vm.runInContext(`setVeraAsrMode("streaming");`, A);
eq(vm.runInContext("getVeraAsrMode()", A), "streaming", "round-trip 'streaming'");
vm.runInContext(`setVeraAsrMode("whisper");`, A);
eq(vm.runInContext("getVeraAsrMode()", A), "whisper", "round-trip 'whisper'");
vm.runInContext(`setVeraAsrMode("garbage");`, A);
eq(vm.runInContext("getVeraAsrMode()", A), "whisper", "garbage -> default 'whisper'");

/* Mode predicates */
vm.runInContext(`setVeraAsrMode("whisper");`, A);
eq(vm.runInContext("isWhisperAsrMode()", A), true, "isWhisperAsrMode() true");
eq(vm.runInContext("isStreamingAsrMode()", A), false, "isStreamingAsrMode() false");
eq(vm.runInContext("isHybridAsrMode()", A), false, "isHybridAsrMode() false");
vm.runInContext(`setVeraAsrMode("hybrid");`, A);
eq(vm.runInContext("isHybridAsrMode()", A), true, "isHybridAsrMode() true after switch");

/*
 * Suite F — silence-ms helpers
 */
console.log("\n-- Suite F - getVeraAsrSilenceMs / setVeraAsrSilenceMs --");

vm.runInContext(`localStorage.removeItem(VERA_SETTING_ASR_SILENCE_MS_KEY);`, A);
eq(vm.runInContext("getVeraAsrSilenceMs()", A), 1300, "default silence ms = 1300");

vm.runInContext(`setVeraAsrSilenceMs(1000);`, A);
eq(vm.runInContext("getVeraAsrSilenceMs()", A), 1000, "round-trip 1000");
eq(vm.runInContext("browserAsrMainSilenceMs", A), 1000, "browserAsrMainSilenceMs (app.js let) updated via shared lexical env");

vm.runInContext(`setVeraAsrSilenceMs(1600);`, A);
eq(vm.runInContext("getVeraAsrSilenceMs()", A), 1600, "round-trip 1600");

vm.runInContext(`setVeraAsrSilenceMs(99999);`, A);
eq(vm.runInContext("getVeraAsrSilenceMs()", A), 1300, "snap invalid to 1300 default");

/*
 * Suite G — partial-min-chars helpers
 */
console.log("\n-- Suite G - partial-min-chars helpers --");

eq(vm.runInContext("normalizeMainAsrPartialMinChars(10)", A), 10, "normalize 10 -> 10");
eq(vm.runInContext("normalizeMainAsrPartialMinChars(25)", A), 25, "normalize 25 -> 25");
eq(vm.runInContext("normalizeMainAsrPartialMinChars(5)", A), 10, "normalize 5 -> 10 (legacy snap)");
eq(vm.runInContext("normalizeMainAsrPartialMinChars(8)", A), 10, "normalize 8 -> 10 (legacy snap)");
eq(vm.runInContext("normalizeMainAsrPartialMinChars(12)", A), 15, "normalize 12 -> 15 (legacy snap)");
eq(vm.runInContext("normalizeMainAsrPartialMinChars('inf')", A), null, "normalize 'inf' -> Infinity (JSON null)");
eq(vm.runInContext("normalizeMainAsrPartialMinChars('infinity')", A), null, "normalize 'infinity' -> Infinity");
eq(vm.runInContext("normalizeMainAsrPartialMinChars(99)", A), 20, "normalize 99 -> 20 (default)");

vm.runInContext(`localStorage.removeItem(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY);`, A);
eq(vm.runInContext("getMainAsrPartialMinChars()", A), 20, "default partial-min-chars = 20");

vm.runInContext(`setMainAsrPartialMinChars(15);`, A);
eq(vm.runInContext("getMainAsrPartialMinChars()", A), 15, "round-trip 15");
eq(vm.runInContext("mainAsrPartialMinChars", A), 15, "mainAsrPartialMinChars (app.js let) updated via shared lexical env");
eq(vm.runInContext("localStorage.getItem(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY)", A), "15", "localStorage stores numeric string");

vm.runInContext(`setMainAsrPartialMinChars("inf");`, A);
eq(vm.runInContext("localStorage.getItem(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY)", A), "inf", "localStorage stores 'inf' sentinel");
eq(vm.runInContext("getMainAsrPartialMinChars() === Infinity", A), true, "round-trip Infinity");

vm.runInContext(`setMainAsrPartialMinChars(99);`, A);
eq(vm.runInContext("getMainAsrPartialMinChars()", A), 20, "snap invalid -> 20 default");

/*
 * Suite H — browser-ASR support detection
 */
console.log("\n-- Suite H - browserAsrSupported / getSpeechRecognitionLang --");

eq(vm.runInContext("browserAsrSupported()", A), false, "browserAsrSupported() false when SR APIs missing");
eq(vm.runInContext("getSpeechRecognitionLang()", A), "en-US", "getSpeechRecognitionLang() returns navigator.language");
eq(vm.runInContext("isNarrowViewport()", A), false, "isNarrowViewport() false on stubbed matchMedia");
eq(vm.runInContext("isLikelyGoogleChrome()", A), false, "isLikelyGoogleChrome() false on bare 'Mozilla/5.0' UA (no Chrome/\\d)");

/* Build a sandbox with a real Chrome UA + Google vendor */
const Bchrome = buildLoadedSandbox({
  navigator: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    vendor: "Google Inc.",
    languages: ["en-US"],
    language: "en-US",
  },
});
eq(vm.runInContext("isLikelyGoogleChrome()", Bchrome), true, "isLikelyGoogleChrome() true on real Chrome UA + Google vendor");

/* Build a fresh sandbox with SpeechRecognition stubbed in */
const Bsr = buildLoadedSandbox({ window: { SpeechRecognition: function () {} } });
eq(vm.runInContext("browserAsrSupported()", Bsr), true, "browserAsrSupported() true when SpeechRecognition exists");

/*
 * Suite I — browserAsrPreferred
 */
console.log("\n-- Suite I - browserAsrPreferred --");

const Bp = buildLoadedSandbox({ window: { SpeechRecognition: function () {} } });

/* mode = streaming -> true on desktop */
vm.runInContext(`setVeraAsrMode("streaming");`, Bp);
eq(vm.runInContext("browserAsrPreferred()", Bp), true, "streaming + desktop + SR supported -> true");

/* mode = whisper -> false */
vm.runInContext(`setVeraAsrMode("whisper");`, Bp);
eq(vm.runInContext("browserAsrPreferred()", Bp), false, "whisper mode -> false");

/* permanently disabled -> false (even on streaming) */
vm.runInContext(`setVeraAsrMode("streaming"); browserAsrPermanentlyDisabled = true;`, Bp);
eq(vm.runInContext("browserAsrPreferred()", Bp), false, "browserAsrPermanentlyDisabled = true -> false");
vm.runInContext(`browserAsrPermanentlyDisabled = false;`, Bp);

/* localStorage VERA_BROWSER_ASR = "0" -> false */
vm.runInContext(`localStorage.setItem("VERA_BROWSER_ASR", "0");`, Bp);
eq(vm.runInContext("browserAsrPreferred()", Bp), false, "VERA_BROWSER_ASR=0 -> false");
vm.runInContext(`localStorage.removeItem("VERA_BROWSER_ASR");`, Bp);

/* file:// protocol -> false */
const Bfile = buildLoadedSandbox({
  window: { SpeechRecognition: function () {} },
  location: { protocol: "file:" },
});
vm.runInContext(`setVeraAsrMode("streaming");`, Bfile);
eq(vm.runInContext("browserAsrPreferred()", Bfile), false, "file:// protocol -> false");

/*
 * Suite J — getAsrDebugState shape
 */
console.log("\n-- Suite J - getAsrDebugState --");

vm.runInContext(`setVeraAsrMode("hybrid");`, A);
vm.runInContext(`setVeraAsrSilenceMs(1600);`, A);
vm.runInContext(`setMainAsrPartialMinChars("inf");`, A);
{
  const snap = vm.runInContext("getAsrDebugState()", A);
  eq(snap.mode, "hybrid", "snap.mode");
  eq(snap.isHybrid, true, "snap.isHybrid");
  eq(snap.isStreaming, false, "snap.isStreaming");
  eq(snap.isWhisper, false, "snap.isWhisper");
  eq(snap.hybridPolicy, "selective", "snap.hybridPolicy");
  eq(snap.silenceMs, 1600, "snap.silenceMs");
  eq(snap.partialMinChars, "inf", "snap.partialMinChars 'inf' sentinel preserved");
  eq(snap.browserSupported, false, "snap.browserSupported");
  eq(typeof snap.browserPreferred, "boolean", "snap.browserPreferred is boolean");
  eq(snap.browserPermanentlyDisabled, false, "snap.browserPermanentlyDisabled");
  eq(snap.narrowViewport, false, "snap.narrowViewport");
  eq(snap.likelyGoogleChrome, false, "snap.likelyGoogleChrome (bare 'Mozilla/5.0' UA)");
}

/*
 * Suite K — app.js cleanup verification
 */
console.log("\n-- Suite K - app.js cleanup verification --");

const appSrc = fs.readFileSync(appJsPath, "utf8");

const removed = [
  /^const\s+VERA_SETTING_ASR_MODE_KEY\b/m,
  /^const\s+VERA_SETTING_ASR_SILENCE_MS_KEY\b/m,
  /^const\s+VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY\b/m,
  /^const\s+VERA_ASR_MODE_DEFAULT\b/m,
  /^const\s+VERA_ASR_MODE_VALID\b/m,
  /^const\s+HYBRID_POLICY\b/m,
  /^const\s+ASR_RISKY_VOCAB_RE\b/m,
  /^const\s+ASR_ORDINAL_OR_RANGE_RE\b/m,
  /^const\s+ASR_EXPLICIT_ACCURATE_RE\b/m,
  /^const\s+ASR_STATE_CHANGING_RE\b/m,
  /^const\s+ASR_CANCEL_ONLY_RE\b/m,
  /^const\s+ASR_CANCEL_PREFIX_RE\b/m,
  /^const\s+ASR_COMMAND_NORMALIZATIONS\b/m,
  /^const\s+MAIN_ASR_PARTIAL_MIN_CHAR_OPTIONS\b/m,
  /^const\s+MAIN_ASR_PARTIAL_MIN_CHARS_DEFAULT\b/m,
  /^function\s+_normalizeVeraAsrMode\b/m,
  /^function\s+getVeraAsrMode\b/m,
  /^function\s+setVeraAsrMode\b/m,
  /^function\s+isHybridAsrMode\b/m,
  /^function\s+isWhisperAsrMode\b/m,
  /^function\s+isStreamingAsrMode\b/m,
  /^function\s+getVeraAsrSilenceMs\b/m,
  /^function\s+setVeraAsrSilenceMs\b/m,
  /^function\s+browserAsrPreferred\b/m,
  /^function\s+browserAsrSupported\b/m,
  /^function\s+getSpeechRecognitionLang\b/m,
  /^function\s+isLikelyGoogleChrome\b/m,
  /^function\s+isNarrowViewport\b/m,
  /^function\s+_splitCancelPrefix\b/m,
  /^function\s+decideAsrFinalizationMode\b/m,
  /^function\s+chooseBestTranscript\b/m,
  /^function\s+normalizeCommandTranscript\b/m,
  /^function\s+normalizeMainAsrPartialMinChars\b/m,
  /^function\s+getMainAsrPartialMinChars\b/m,
  /^function\s+setMainAsrPartialMinChars\b/m,
  /^function\s+_normalizeForCompare\b/m,
  /^function\s+_levenshtein\b/m,
  /^function\s+_tokenOverlapRatio\b/m,
  /^function\s+_looksHallucinated\b/m,
  /* Stage 16 (Patch A-9, 2026-05-31): hybrid sidecar recorder moved out of app.js. */
  /^let\s+hybridSidecarRecorder\b/m,
  /^let\s+hybridSidecarChunks\b/m,
  /^let\s+hybridSidecarMimeType\b/m,
  /^let\s+hybridSidecarStartedAt\b/m,
  /^function\s+isHybridSidecarRunning\b/m,
  /^function\s+_stopAndCollectHybridSidecar\b/m,
  /^function\s+_discardHybridSidecar\b/m,
  /^function\s+startHybridSidecarRecorderIfNeeded\b/m,
  /* Stage 17 (Patch A-10, 2026-05-31): MediaRecorder construction helper moved out of app.js. */
  /^const\s+VERA_RECORDER_BITS_PER_SECOND\b/m,
  /^const\s+VERA_RECORDER_MIME_PREFS\b/m,
  /^function\s+_pickRecorderMime\b/m,
  /^function\s+createVeraMediaRecorder\b/m,
];
for (const re of removed) {
  ok(!re.test(appSrc), `app.js no longer declares ${re.source}`);
}

/* Intentionally LEFT in app.js per Stage 7 spec */
const left = [
  [/^let\s+browserAsrPermanentlyDisabled\b/m, "browserAsrPermanentlyDisabled intentionally left in app.js (SR error-handler mutated)"],
  [/^let\s+browserAsrMainSilenceMs\b/m, "browserAsrMainSilenceMs intentionally left in app.js"],
  [/^let\s+mainAsrPartialMinChars\b/m, "mainAsrPartialMinChars intentionally left in app.js"],
  [/^let\s+browserAsrInterruptSustainMs\b/m, "browserAsrInterruptSustainMs intentionally left in app.js"],
  [/^let\s+browserAsrInterruptGapMs\b/m, "browserAsrInterruptGapMs intentionally left in app.js"],
  [/^function\s+logVeraSettings\b/m, "logVeraSettings intentionally left in app.js (generic settings logger)"],
];
for (const [re, label] of left) {
  ok(re.test(appSrc), label);
}

/* Breadcrumbs */
const breadcrumbs = [
  "moved to voice/asr.js (Stage 7",
  "_normalizeVeraAsrMode,\n * getVeraAsrMode, setVeraAsrMode",
  "_splitCancelPrefix, decideAsrFinalizationMode",
];
for (const needle of breadcrumbs) {
  ok(appSrc.includes(needle), `app.js carries breadcrumb: ${JSON.stringify(needle)}`);
}

/*
 * Suite L — index.html load order
 */
console.log("\n-- Suite L - index.html load order --");

const idx = fs.readFileSync(indexHtmlPath, "utf8");
const iIds = idx.indexOf('<script src="utils/ids.js?v=');
const iStorage = idx.indexOf('<script src="utils/storage.js?v=');
const iLogging = idx.indexOf('<script src="utils/logging.js?v=');
const iAsr = idx.indexOf('<script src="voice/asr.js?v=');
const iTts = idx.indexOf('<script src="voice/ttsQueue.js?v=');
const iInt = idx.indexOf('<script src="voice/interruption.js?v=');
const iApp = idx.indexOf('<script src="app.js?v=');
const iVoiceDebug = idx.indexOf('<script src="debug/voiceDebug.js?v=');

ok(iIds > -1, "index.html loads utils/ids.js");
ok(iStorage > -1, "index.html loads utils/storage.js");
ok(iLogging > -1, "index.html loads utils/logging.js");
ok(iAsr > -1, "index.html loads voice/asr.js");
ok(iTts > -1, "index.html loads voice/ttsQueue.js");
ok(iInt > -1, "index.html loads voice/interruption.js");
ok(iApp > -1, "index.html loads app.js");
ok(iVoiceDebug > -1, "index.html loads debug/voiceDebug.js");

ok(iStorage < iAsr, "utils/storage.js loaded BEFORE voice/asr.js (asr uses safeSetLocalStorage)");
ok(iLogging < iAsr, "utils/logging.js loaded BEFORE voice/asr.js");
ok(iAsr < iTts, "voice/asr.js loaded BEFORE voice/ttsQueue.js (Stage 7 load order)");
ok(iAsr < iInt, "voice/asr.js loaded BEFORE voice/interruption.js (interruption calls browserAsrPreferred)");
ok(iAsr < iApp, "voice/asr.js loaded BEFORE app.js (Stage 7 load order)");
ok(iApp < iVoiceDebug, "app.js loaded BEFORE debug/voiceDebug.js (Stage 4 load order preserved)");

/*
 * Suite M — voice/asr.js parses as classic script
 */
console.log("\n-- Suite M - voice/asr.js classic-script syntax --");

const asrSrc = fs.readFileSync(voiceAsrPath, "utf8");

ok(!/^\s*import\s+/m.test(asrSrc), "voice/asr.js has no ESM imports");
ok(!/^\s*export\s+/m.test(asrSrc), "voice/asr.js has no ESM exports");
ok(/\bfunction\s+getAsrDebugState\b/.test(asrSrc), "voice/asr.js declares getAsrDebugState");
ok(/window\.getVeraAsrMode\s*=\s*getVeraAsrMode/.test(asrSrc), "voice/asr.js attaches window.getVeraAsrMode alias");
ok(/window\.getAsrDebugState\s*=\s*getAsrDebugState/.test(asrSrc), "voice/asr.js attaches window.getAsrDebugState alias");

/* ---------------------------------------------------------------------------
 * Summary
 * ------------------------------------------------------------------------- */
console.log(`\n=========  PASS: ${pass}  FAIL: ${fail}  =========`);
process.exit(fail === 0 ? 0 : 1);
