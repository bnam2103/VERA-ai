/* ============================================================================
 * __ids_extraction_smoke.mjs
 *
 * Verifies the stabilization-stage extraction of session-id + request-id
 * helpers from app.js into utils/ids.js. Does NOT exercise the real DOM /
 * fetch pipeline — just confirms:
 *   1. utils/ids.js parses and runs in a classic-script-like context.
 *   2. It exports the expected names on the global / window.
 *   3. The bare-identifier and window.* paths produce the same values.
 *   4. ?session=new handling clears + regenerates the session id.
 *   5. veraConcurrencyDebug()-style probes (now in debug/voiceDebug.js,
 *      Stage 4) can still read
 *      VERA_LAST_REQUEST_IDS, VERA_SESSION_STORAGE_KEY, BMO_SESSION_STORAGE_KEY,
 *      getSessionScopedId — i.e. the extracted symbols stay reachable from
 *      app.js code via the same global-script lexical environment.
 *
 * Run:  node tests/smoke/__ids_extraction_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsIdsPath = path.join(repoRoot, "utils", "ids.js");
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

/* ------------------------------------------------------------------
 * Suite A — utils/ids.js + boot side effects
 * ------------------------------------------------------------------ */
console.log("-- Suite A - utils/ids.js loads in a classic-script-like context --");

function makeSessionStorageBag() {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
    _bag: bag,
  };
}

function loadIdsInto(sandbox, { sessionQuery = "" } = {}) {
  const src = fs.readFileSync(utilsIdsPath, "utf8");
  /* Mimic a classic <script> top-level scope so top-level `const`/`let`
   * become script-scoped bindings. node:vm achieves this by NOT wrapping
   * the script in a function. */
  vm.createContext(sandbox);
  /* utils/ids.js references window.location.search at load time for ?session=new.
   * We control the URL via the search string above. */
  sandbox.window.location = {
    search: sessionQuery,
    pathname: "/",
    hash: "",
    href: "https://test.example/" + (sessionQuery || ""),
  };
  sandbox.history = sandbox.window.history = { replaceState: () => {} };
  vm.runInContext(src, sandbox, { filename: "utils/ids.js" });
  return sandbox;
}

function makeBaseSandbox() {
  const sessionStorage = makeSessionStorageBag();
  const localStorage = makeSessionStorageBag();
  const documentBody = {
    classList: {
      _set: new Set(),
      contains(c) { return this._set.has(c); },
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
    },
  };
  const win = {
    location: { search: "", pathname: "/", hash: "", href: "https://test/" },
    history: { replaceState: () => {} },
  };
  /* Same crypto stub as the browser: deterministic-ish UUIDs for the test. */
  let seq = 0;
  const cryptoStub = {
    randomUUID: () => "uuid-" + (++seq),
    getRandomValues: (buf) => {
      for (let i = 0; i < buf.length; i++) {
        seq += 1;
        buf[i] = (seq * 0x9e3779b1) >>> 0;
      }
      return buf;
    },
  };
  const sandbox = {
    window: win,
    document: { body: documentBody },
    sessionStorage,
    localStorage,
    crypto: cryptoStub,
    console,
    URLSearchParams,
  };
  win.crypto = cryptoStub;
  win.sessionStorage = sessionStorage;
  win.localStorage = localStorage;
  return sandbox;
}

const sbA = loadIdsInto(makeBaseSandbox());
ok(typeof sbA.window.getSessionId === "function", "window.getSessionId is a function after utils/ids.js load");
ok(typeof sbA.window.newVeraRequestId === "function", "window.newVeraRequestId is a function");
ok(typeof sbA.window.recordVeraRequestId === "function", "window.recordVeraRequestId is a function");
ok(typeof sbA.window.resetVeraAndBmoSessionIdsForTab === "function", "window.resetVeraAndBmoSessionIdsForTab is a function");
ok(typeof sbA.window.getSessionScopedId === "function", "window.getSessionScopedId is a function");
ok(typeof sbA.window.setSessionScopedId === "function", "window.setSessionScopedId is a function");
ok(sbA.window.VERA_SESSION_STORAGE_KEY === "vera_session_id", "window.VERA_SESSION_STORAGE_KEY preserved value");
ok(sbA.window.BMO_SESSION_STORAGE_KEY === "bmo_session_id", "window.BMO_SESSION_STORAGE_KEY preserved value");
ok(sbA.window.VERA_LAST_REQUEST_IDS && typeof sbA.window.VERA_LAST_REQUEST_IDS === "object", "window.VERA_LAST_REQUEST_IDS preserved");

/* Same bare-identifier resolution path that app.js uses. */
ok(vm.runInContext("typeof getSessionId", sbA) === "function", "bare getSessionId resolves via shared global lexical env");
ok(vm.runInContext("typeof VERA_SESSION_STORAGE_KEY", sbA) === "string", "bare VERA_SESSION_STORAGE_KEY resolves");
ok(vm.runInContext("typeof VERA_LAST_REQUEST_IDS", sbA) === "object", "bare VERA_LAST_REQUEST_IDS resolves");

/* ------------------------------------------------------------------
 * Suite B — getSessionId() generates and persists a uuid
 * ------------------------------------------------------------------ */
console.log("\n-- Suite B - getSessionId() generates and persists a uuid --");

const id1 = sbA.window.getSessionId();
ok(typeof id1 === "string" && id1.length > 0, "getSessionId returns a non-empty string");
const id2 = sbA.window.getSessionId();
eq(id2, id1, "subsequent calls return the same id");
eq(sbA.sessionStorage.getItem("vera_session_id"), id1, "session id persisted in sessionStorage");

/* BMO mode toggle through the body class. */
sbA.document.body.classList.add("bmo-open");
const bmoId = sbA.window.getSessionId();
ok(bmoId && bmoId !== id1, "bmo session id is distinct from vera session id");
eq(sbA.sessionStorage.getItem("bmo_session_id"), bmoId, "bmo session id persisted");
sbA.document.body.classList.remove("bmo-open");

/* ------------------------------------------------------------------
 * Suite C — ?session=new wipes and re-creates the session id
 * ------------------------------------------------------------------ */
console.log("\n-- Suite C - ?session=new wipes and re-creates the session id --");

const sbC = loadIdsInto(makeBaseSandbox(), { sessionQuery: "?session=new" });
/* After ?session=new the storage already has fresh ids from the boot handler. */
const veraFreshAfterReset = sbC.sessionStorage.getItem("vera_session_id");
const bmoFreshAfterReset = sbC.sessionStorage.getItem("bmo_session_id");
ok(veraFreshAfterReset && veraFreshAfterReset.length > 0, "vera session id created by ?session=new handler");
ok(bmoFreshAfterReset && bmoFreshAfterReset.length > 0, "bmo session id created by ?session=new handler");
ok(veraFreshAfterReset !== bmoFreshAfterReset, "?session=new produced distinct vera vs bmo ids");

/* ------------------------------------------------------------------
 * Suite D — request id generator + slot tracker
 * ------------------------------------------------------------------ */
console.log("\n-- Suite D - request id generator + slot tracker --");

const slots = ["infer", "text", "reasoning_stream", "reasoning_stream_upload", "reasoning_panel_title", "tts_emotion_route", "other"];
for (const s of slots) {
  ok(s in sbA.window.VERA_LAST_REQUEST_IDS, `VERA_LAST_REQUEST_IDS has slot "${s}"`);
}

const r1 = sbA.window.newVeraRequestId();
ok(typeof r1 === "string" && r1.startsWith("req_") && r1.length > 5, "newVeraRequestId returns req_<chars> string");
const r2 = sbA.window.newVeraRequestId();
ok(r1 !== r2, "subsequent newVeraRequestId calls produce different ids");

const recorded = sbA.window.recordVeraRequestId("infer", r1);
eq(recorded, r1, "recordVeraRequestId returns the id unchanged");
eq(sbA.window.VERA_LAST_REQUEST_IDS.infer, r1, "recordVeraRequestId stores the id in the right slot");

/* Edge cases that the original guards required: invalid slot/id are no-ops. */
eq(sbA.window.recordVeraRequestId("", r2), r2, "empty slot still returns the id (no-op store)");
eq(sbA.window.VERA_LAST_REQUEST_IDS.infer, r1, "infer slot unchanged after empty-slot record");
eq(sbA.window.recordVeraRequestId("text", ""), "", "empty id returns empty (no-op store)");
eq(sbA.window.VERA_LAST_REQUEST_IDS.text, null, "text slot still null after empty-id record");

/* ------------------------------------------------------------------
 * Suite E — app.js still references the extracted symbols by bare name
 *           and the comment forwarder is in place
 * ------------------------------------------------------------------ */
console.log("\n-- Suite E - app.js forwarder + cross-references --");

const appSrc = fs.readFileSync(appJsPath, "utf8");
ok(
  /SESSION \+ REQUEST IDS — see utils\/ids\.js/.test(appSrc),
  "app.js carries the utils/ids.js forwarder banner"
);
ok(
  appSrc.includes("getSessionId()") && appSrc.includes("recordVeraRequestId(\"infer\""),
  "app.js still references bare getSessionId() and recordVeraRequestId(...)"
);
/* veraConcurrencyDebug moved to debug/voiceDebug.js during Stage 4
 * (2026-05-27); see __voice_debug_extraction_smoke.mjs for the matching
 * "debug/voiceDebug.js still references VERA_LAST_REQUEST_IDS via the
 * shared global lexical env" assertion. app.js itself no longer needs
 * the binding at top level. */
ok(
  !appSrc.includes("function getSessionScopedId(") &&
  !appSrc.includes("function setSessionScopedId(") &&
  !appSrc.includes("function getSessionId(") &&
  !appSrc.includes("function newVeraRequestId(") &&
  !appSrc.includes("function recordVeraRequestId(") &&
  !appSrc.includes("function resetVeraAndBmoSessionIdsForTab("),
  "app.js no longer redeclares the extracted helper functions"
);
ok(
  !/^const VERA_SESSION_STORAGE_KEY = /m.test(appSrc) &&
  !/^const BMO_SESSION_STORAGE_KEY = /m.test(appSrc) &&
  !/^const VERA_LAST_REQUEST_IDS = \{/m.test(appSrc),
  "app.js no longer redeclares the extracted constants"
);

const idxSrc = fs.readFileSync(indexHtmlPath, "utf8");
ok(
  idxSrc.includes('<script src="utils/ids.js?v=1"></script>'),
  "index.html loads utils/ids.js"
);
ok(
  idxSrc.indexOf('<script src="utils/ids.js?v=1"></script>') <
    idxSrc.indexOf('<script src="app.js?v='),
  "utils/ids.js is loaded BEFORE app.js"
);

/* ------------------------------------------------------------------
 * Suite F — veraConcurrencyDebug from app.js (simulated) can still
 *           read the extracted symbols (proves no lexical-env drift)
 * ------------------------------------------------------------------ */
console.log("\n-- Suite F - simulated veraConcurrencyDebug reads extracted symbols --");

/* We inline a trimmed mimic of the app.js veraConcurrencyDebug body that
 * references the bindings utils/ids.js defines. If the lexical env worked
 * in the browser, it'll work here too (Node vm uses the same script-scope
 * rules as a classic <script>). */
const probeSrc = `
  (function () {
    var snap = {
      vera_session_id: (function () {
        try { return getSessionScopedId(VERA_SESSION_STORAGE_KEY) || ""; } catch (_) { return ""; }
      })(),
      bmo_session_id: (function () {
        try { return getSessionScopedId(BMO_SESSION_STORAGE_KEY) || ""; } catch (_) { return ""; }
      })(),
      last_request_ids: Object.assign({}, VERA_LAST_REQUEST_IDS),
    };
    return snap;
  })();
`;
const probe = vm.runInContext(probeSrc, sbA);
ok(probe.vera_session_id && probe.vera_session_id.length > 0, "veraConcurrencyDebug-style probe reads vera_session_id via bare identifiers");
ok(probe.bmo_session_id && probe.bmo_session_id.length > 0, "veraConcurrencyDebug-style probe reads bmo_session_id via bare identifiers");
ok(probe.last_request_ids.infer === r1, "veraConcurrencyDebug-style probe sees the recorded infer request_id");

/* ------------------------------------------------------------------ */
console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail > 0) process.exit(1);
