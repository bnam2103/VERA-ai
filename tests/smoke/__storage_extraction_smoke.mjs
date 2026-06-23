/* ============================================================================
 * __storage_extraction_smoke.mjs
 *
 * Verifies the Stage 2 extraction of safe Storage / JSON wrappers from
 * app.js into utils/storage.js. Does NOT exercise the real DOM / fetch
 * pipeline — just confirms:
 *   1. utils/storage.js parses and runs in a classic-script-like context.
 *   2. All wrappers required by the spec are exported as both bare
 *      identifiers (shared script scope) and `window.*` aliases.
 *   3. Each wrapper's return-value contract matches the pre-extraction
 *      try/catch shape used by app.js (silent-fail, fallback-on-throw).
 *   4. `safeJsonParse` / `safeJsonStringify` handle bad input the same
 *      way the in-file callers used to.
 *   5. index.html loads utils/storage.js AFTER utils/ids.js and BEFORE
 *      app.js (load-order contract for shared global lexical bindings).
 *   6. app.js no longer carries the easy try/catch storage patterns
 *      that were converted (only the converted set — complex / coupled
 *      sites are intentionally left).
 *
 * Run:  node tests/smoke/__storage_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
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
    _bag: bag,
  };
}

function makeThrowingStorage() {
  return {
    getItem: () => { throw new DOMException("SecurityError"); },
    setItem: () => { throw new DOMException("QuotaExceededError"); },
    removeItem: () => { throw new DOMException("SecurityError"); },
  };
}

function loadStorageInto({ localStorage, sessionStorage }) {
  const src = fs.readFileSync(utilsStoragePath, "utf8");
  const sandbox = {
    window: {},
    console,
    localStorage,
    sessionStorage,
  };
  sandbox.window.localStorage = localStorage;
  sandbox.window.sessionStorage = sessionStorage;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "utils/storage.js" });
  return sandbox;
}

/* ------------------------------------------------------------------
 * Suite A — utils/storage.js loads in a classic-script-like context
 * ------------------------------------------------------------------ */
console.log("-- Suite A - utils/storage.js loads in a classic-script-like context --");

const ls = makeMemoryStorage();
const ss = makeMemoryStorage();
const sbA = loadStorageInto({ localStorage: ls, sessionStorage: ss });

const REQUIRED_HELPERS = [
  "safeGetLocalStorage",
  "safeSetLocalStorage",
  "safeRemoveLocalStorage",
  "safeGetSessionStorage",
  "safeSetSessionStorage",
  "safeRemoveSessionStorage",
  "safeJsonParse",
  "safeJsonStringify",
  "safeGetJsonLocalStorage",
  "safeSetJsonLocalStorage",
  "safeGetJsonSessionStorage",
  "safeSetJsonSessionStorage",
];
for (const name of REQUIRED_HELPERS) {
  ok(
    typeof sbA.window[name] === "function",
    `window.${name} is a function after utils/storage.js load`
  );
}
for (const name of REQUIRED_HELPERS) {
  ok(
    vm.runInContext(`typeof ${name}`, sbA) === "function",
    `bare ${name} resolves via shared global lexical env`
  );
}

/* ------------------------------------------------------------------
 * Suite B — get / set / remove round-trips (localStorage)
 * ------------------------------------------------------------------ */
console.log("\n-- Suite B - get / set / remove round-trips (localStorage) --");

eq(sbA.window.safeGetLocalStorage("missing"), null, "missing key returns null by default");
eq(sbA.window.safeGetLocalStorage("missing", "fallback"), "fallback", "missing key returns supplied default");
eq(sbA.window.safeSetLocalStorage("k1", "v1"), true, "safeSetLocalStorage returns true on success");
eq(sbA.window.safeGetLocalStorage("k1"), "v1", "round-trip value");
eq(sbA.window.safeSetLocalStorage("k1", ""), true, "empty string value persists");
eq(sbA.window.safeGetLocalStorage("k1"), "", "empty string round-trips");
eq(sbA.window.safeGetLocalStorage("k1", "fallback"), "", "empty stored value does NOT trigger fallback (mirrors getItem === '')");
eq(sbA.window.safeRemoveLocalStorage("k1"), true, "safeRemoveLocalStorage returns true on success");
eq(sbA.window.safeGetLocalStorage("k1"), null, "after remove, value is null");

/* ------------------------------------------------------------------
 * Suite C — get / set / remove round-trips (sessionStorage)
 * ------------------------------------------------------------------ */
console.log("\n-- Suite C - get / set / remove round-trips (sessionStorage) --");

eq(sbA.window.safeGetSessionStorage("missing"), null, "missing session key returns null by default");
eq(sbA.window.safeGetSessionStorage("missing", "fallback"), "fallback", "missing session key returns supplied default");
eq(sbA.window.safeSetSessionStorage("s1", "v"), true, "safeSetSessionStorage returns true");
eq(sbA.window.safeGetSessionStorage("s1"), "v", "session round-trip");
eq(sbA.window.safeRemoveSessionStorage("s1"), true, "safeRemoveSessionStorage returns true");
eq(sbA.window.safeGetSessionStorage("s1"), null, "after remove, session value is null");

/* ------------------------------------------------------------------
 * Suite D — silent-fail when Storage API throws
 * ------------------------------------------------------------------ */
console.log("\n-- Suite D - silent-fail when Storage API throws --");

const throwLs = makeThrowingStorage();
const throwSs = makeThrowingStorage();
const sbThrow = loadStorageInto({ localStorage: throwLs, sessionStorage: throwSs });
eq(sbThrow.window.safeGetLocalStorage("any"), null, "getItem throw → default null");
eq(sbThrow.window.safeGetLocalStorage("any", "fb"), "fb", "getItem throw → supplied default");
eq(sbThrow.window.safeSetLocalStorage("any", "v"), false, "setItem throw → false");
eq(sbThrow.window.safeRemoveLocalStorage("any"), false, "removeItem throw → false");
eq(sbThrow.window.safeGetSessionStorage("any"), null, "session getItem throw → default null");
eq(sbThrow.window.safeSetSessionStorage("any", "v"), false, "session setItem throw → false");
eq(sbThrow.window.safeRemoveSessionStorage("any"), false, "session removeItem throw → false");

/* ------------------------------------------------------------------
 * Suite E — safeJsonParse / safeJsonStringify edge cases
 * ------------------------------------------------------------------ */
console.log("\n-- Suite E - safeJsonParse / safeJsonStringify edge cases --");

eq(sbA.window.safeJsonParse(null), null, "safeJsonParse(null) → fallback null");
eq(sbA.window.safeJsonParse(""), null, "safeJsonParse('') → fallback null");
eq(sbA.window.safeJsonParse(undefined), null, "safeJsonParse(undefined) → fallback null");
eq(sbA.window.safeJsonParse(null, []), [], "safeJsonParse(null, []) → fallback []");
eq(sbA.window.safeJsonParse('{"x":1}'), { x: 1 }, "safeJsonParse valid JSON");
eq(sbA.window.safeJsonParse('not-json', { ok: 0 }), { ok: 0 }, "safeJsonParse bad JSON → fallback");

eq(sbA.window.safeJsonStringify({ a: 1 }), '{"a":1}', "safeJsonStringify roundtrip");
const cyc = {};
cyc.self = cyc;
eq(sbA.window.safeJsonStringify(cyc), null, "safeJsonStringify circular → null fallback");
eq(sbA.window.safeJsonStringify(undefined), null, "safeJsonStringify(undefined) → null (matches JSON.stringify undefined → undefined)");

/* ------------------------------------------------------------------
 * Suite F — safeGetJsonLocalStorage / safeSetJsonLocalStorage
 * ------------------------------------------------------------------ */
console.log("\n-- Suite F - safe Json Local / Session storage helpers --");

eq(sbA.window.safeSetJsonLocalStorage("json1", { id: 7, items: ["a", "b"] }), true, "JSON set localStorage");
eq(sbA.window.safeGetJsonLocalStorage("json1"), { id: 7, items: ["a", "b"] }, "JSON get localStorage round-trip");
eq(sbA.window.safeGetJsonLocalStorage("does-not-exist", []), [], "missing JSON key → fallback");
ls.setItem("corrupt", "{not json");
eq(sbA.window.safeGetJsonLocalStorage("corrupt", { ok: false }), { ok: false }, "corrupt JSON → fallback");
eq(sbA.window.safeSetJsonSessionStorage("json2", { hello: "world" }), true, "JSON set sessionStorage");
eq(sbA.window.safeGetJsonSessionStorage("json2"), { hello: "world" }, "JSON get sessionStorage round-trip");

/* ------------------------------------------------------------------
 * Suite G — load order in index.html + cache busters
 * ------------------------------------------------------------------ */
console.log("\n-- Suite G - index.html load order + cache busters --");

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

/* ------------------------------------------------------------------
 * Suite H — app.js call-site conversions (representative sample)
 * ------------------------------------------------------------------ */
console.log("\n-- Suite H - app.js call sites use the wrappers --");

const appSrc = fs.readFileSync(appJsPath, "utf8");

/* Each entry: a regex that must MATCH (wrappers are in use). */
const MUST_MATCH = [
  [/function voiceTranscriptDebugEnabled\(\) \{\s*return safeGetLocalStorage\("VERA_DEBUG_TRANSCRIPTS"\) !== "0";\s*\}/, "voiceTranscriptDebugEnabled uses safeGetLocalStorage"],
  [/function voicePartialAsrDoneLogEnabled\(\) \{\s*return safeGetLocalStorage\("VERA_DEBUG_PARTIAL_ASR_DONE"\) !== "0";\s*\}/, "voicePartialAsrDoneLogEnabled uses safeGetLocalStorage"],
  [/function browserAsrStuckDebugEnabled\(\) \{\s*return safeGetLocalStorage\("VERA_DEBUG_BROWSER_ASR_STUCK"\) === "1";\s*\}/, "browserAsrStuckDebugEnabled uses safeGetLocalStorage"],
  /* _turnTextIntegrityEnabled was moved to utils/logging.js during Stage 3
   * (2026-05-27); see __logging_extraction_smoke.mjs for that assertion. */
  [/return safeGetLocalStorage\("VERA_DEBUG_WM_DISPLAY"\) !== "0";/, "_workModeCommandDisplayTextEnabled uses safeGetLocalStorage"],
  /* setVeraAsrSilenceMs / setVeraAsrMode / setMainAsrPartialMinChars were
   * moved to voice/asr.js during Stage 7 (2026-05-27). Their
   * safeSetLocalStorage call-sites are now asserted against voice/asr.js
   * below (see Suite H2). */
  [/function isWorkModeMuteEnabled\(\) \{\s*return safeGetLocalStorage\(VERA_SETTING_WORKMODE_MUTE_KEY\) === "1";\s*\}/, "isWorkModeMuteEnabled uses safeGetLocalStorage"],
  [/safeSetLocalStorage\(VERA_SETTING_WORKMODE_MUTE_KEY, on \? "1" : "0"\);/, "setWorkModeMuteEnabled uses safeSetLocalStorage"],
  [/safeSetLocalStorage\(VERA_SETTING_TEXT_GUIDE_ROTATOR_KEY, on \? "1" : "0"\);/, "setTextGuideRotatorEnabled uses safeSetLocalStorage"],
  [/safeSetLocalStorage\(VERA_SETTING_PLANNING_DEADLINE_TIMER_KEY, on \? "1" : "0"\);/, "setPlanningDeadlineTimerEnabled uses safeSetLocalStorage"],
  [/safeSetLocalStorage\(WORK_LEFT_PANES_LAYOUT_KEY, layout\);/, "setWorkModeLeftPaneLayout uses safeSetLocalStorage"],
  /* barge-in close handler + toggleBargeInDebugUi were moved to
   * debug/voiceDebug.js during Stage 18 / Patch A-12 (2026-05-31). Their
   * safeRemoveLocalStorage / safeSetLocalStorage call-sites are now asserted
   * against debug/voiceDebug.js below (see Suite H3). */
];
for (const [re, label] of MUST_MATCH) {
  ok(re.test(appSrc), `app.js: ${label}`);
}

/* -----------------------------------------------------------------------
 * Suite H2 — voice/asr.js call sites use the safe wrappers
 *   ASR setters were moved out of app.js during Stage 7 (2026-05-27).
 *   This suite preserves the wrapper-usage guarantee against the new
 *   location.
 * ---------------------------------------------------------------------- */
console.log("\n-- Suite H2 - voice/asr.js call sites use the wrappers --");
const asrSrc = fs.readFileSync(path.join(repoRoot, "voice", "asr.js"), "utf8");
const ASR_MUST_MATCH = [
  [/safeSetLocalStorage\(VERA_SETTING_ASR_SILENCE_MS_KEY, String\(next\)\);/, "setVeraAsrSilenceMs uses safeSetLocalStorage"],
  [/safeSetLocalStorage\(VERA_SETTING_ASR_MODE_KEY, next\);/, "setVeraAsrMode uses safeSetLocalStorage"],
  [/safeSetLocalStorage\(VERA_SETTING_MAIN_ASR_PARTIAL_MIN_CHARS_KEY, store\);/, "setMainAsrPartialMinChars uses safeSetLocalStorage"],
];
for (const [re, label] of ASR_MUST_MATCH) {
  ok(re.test(asrSrc), `voice/asr.js: ${label}`);
}

/* -----------------------------------------------------------------------
 * Suite H3 — debug/voiceDebug.js call sites use the safe wrappers
 *   The BARGE-IN DEBUG OVERLAY block was moved out of app.js during
 *   Stage 18 / Patch A-12 (2026-05-31). This suite preserves the
 *   wrapper-usage guarantee against the new location.
 * ---------------------------------------------------------------------- */
console.log("\n-- Suite H3 - debug/voiceDebug.js call sites use the wrappers --");
const dbgVoiceSrc = fs.readFileSync(path.join(repoRoot, "debug", "voiceDebug.js"), "utf8");
const DBG_MUST_MATCH = [
  [/safeRemoveLocalStorage\("vera_debug_barge_in_ui"\);/, "barge-in close handler uses safeRemoveLocalStorage"],
  [/if \(next\) safeSetLocalStorage\("vera_debug_barge_in_ui", "1"\);\s*else safeRemoveLocalStorage\("vera_debug_barge_in_ui"\);/, "toggleBargeInDebugUi uses safe wrappers"],
];
for (const [re, label] of DBG_MUST_MATCH) {
  ok(re.test(dbgVoiceSrc), `debug/voiceDebug.js: ${label}`);
}

/* Each entry: a regex that must NOT match anymore (old pattern removed). */
const MUST_NOT_MATCH = [
  [/try\s*\{\s*return localStorage\.getItem\("VERA_DEBUG_TRANSCRIPTS"\) !== "0"/, "old try/catch VERA_DEBUG_TRANSCRIPTS getItem removed"],
  [/try\s*\{\s*return localStorage\.getItem\("VERA_DEBUG_PARTIAL_ASR_DONE"\) !== "0"/, "old try/catch VERA_DEBUG_PARTIAL_ASR_DONE getItem removed"],
  [/try\s*\{\s*return localStorage\.getItem\("VERA_DEBUG_BROWSER_ASR_STUCK"\) === "1"/, "old try/catch VERA_DEBUG_BROWSER_ASR_STUCK getItem removed"],
  [/try\s*\{\s*return localStorage\.getItem\("VERA_DEBUG_TURN_TEXT"\) !== "0"/, "old try/catch VERA_DEBUG_TURN_TEXT getItem removed"],
  [/try\s*\{\s*localStorage\.setItem\(VERA_SETTING_ASR_SILENCE_MS_KEY/, "old try/catch ASR_SILENCE_MS setItem removed"],
  [/try\s*\{\s*localStorage\.setItem\(VERA_SETTING_ASR_MODE_KEY, next\);\s*\}\s*catch \(_\) \{\}/, "old try/catch ASR_MODE setItem removed"],
  [/try\s*\{\s*localStorage\.setItem\(VERA_SETTING_WORKMODE_MUTE_KEY/, "old try/catch WORKMODE_MUTE setItem removed"],
  [/try\s*\{\s*localStorage\.setItem\(WORK_LEFT_PANES_LAYOUT_KEY, layout\);\s*\}\s*catch \(_\) \{\}/, "old try/catch WORK_LEFT_PANES_LAYOUT setItem removed"],
];
for (const [re, label] of MUST_NOT_MATCH) {
  ok(!re.test(appSrc), `app.js: ${label}`);
}

/* Sanity: confirm we left the complex/coupled patterns alone. */
ok(
  /sessionStorage\.setItem\(seenKey, "true"\)/.test(appSrc),
  "raw sessionStorage.setItem(seenKey,...) intentionally left (was never wrapped)"
);
ok(
  /localStorage\.getItem\(WORK_CHECKLIST_STORAGE_KEY\)/.test(appSrc),
  "WORK_CHECKLIST_STORAGE_KEY direct reads intentionally left (JSON-coupled)"
);
ok(
  /localStorage\.getItem\(VERA_SPOTIFY_BEARER_STORAGE_KEY\)/.test(appSrc),
  "Spotify bearer fallback chain intentionally left (multi-store fallback)"
);
ok(
  /getReasoningTabsStateStorageKey\(\)/.test(dbgVoiceSrc) ? false : true,
  "Reasoning-tabs persistence call-site not in debug/voiceDebug.js"
);
/* Stage 20 / Patch A-4 (2026-05-31): getReasoningTabsStateStorageKey
 * (and its call-sites within persistReasoningTabsState +
 * restoreReasoningTabsState) moved from app.js to workmode/panels.js.
 * The JSON-coupled persistence pattern (direct localStorage.getItem +
 * JSON.parse) is intentionally left as-is in that new home — the
 * smoke just asserts the function still exists somewhere and that the
 * pattern is intact. */
const panelsSrcForReasoningPersistence = fs.readFileSync(path.join(repoRoot, "workmode", "panels.js"), "utf8");
ok(
  /getReasoningTabsStateStorageKey\(\)/.test(panelsSrcForReasoningPersistence),
  "Reasoning-tabs persistence intentionally left as JSON-coupled (now in workmode/panels.js)"
);

/* ------------------------------------------------------------------ */
console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail > 0) process.exit(1);
