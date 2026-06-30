/**
 * Smoke: music next/previous must execute once per request (NDJSON meta + done).
 *
 * Run: node tests/smoke/__music_transport_skip_dedupe_smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const NAV_JS = fs.readFileSync(path.join(ROOT, "voice", "musicNavigation.js"), "utf8");
const APP_JS = fs.readFileSync(path.join(ROOT, "app/app.js"), "utf8");

let _now = 5000;
const fakeWindow = {};
const ctx = vm.createContext({
  console: { info() {}, warn() {}, error() {}, log() {} },
  window: fakeWindow,
  performance: { now: () => _now },
  Number,
  Math,
  String,
});
ctx.window = fakeWindow;

vm.runInContext(NAV_JS, ctx, { filename: "musicNavigation.js" });

const START_MARKER = "/**\n * Collapse duplicate music transport dispatch";
const END_MARKER = "async function invokeSpotifyTransport(";
const i = APP_JS.indexOf(START_MARKER);
const j = APP_JS.indexOf(END_MARKER, i);
if (i < 0 || j < 0) throw new Error("could not carve shouldApplyMusicTransportAction");
const helperSrc = APP_JS.slice(i, j);
vm.runInContext(`${helperSrc}\nglobalThis.__exp = { shouldApplyMusicTransportAction };`, ctx);

const exp = ctx.__exp;
const data = { request_id: "req_abc", type: "meta" };
const payload = { panel_type: "music_control", op: "skip_next" };

let pass = 0;
let fail = 0;
function check(cond, name) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
}
function reset() {
  _now = 5000;
  delete fakeWindow.__veraMusicTransportDedupe;
  delete fakeWindow.__veraAppliedMusicTransportIds;
}

console.log("── request-scoped skip_next ──");
reset();
check(exp.shouldApplyMusicTransportAction(payload, "skip_next", data) === true, "meta onPlayStart applies skip_next once");
check(
  exp.shouldApplyMusicTransportAction(payload, "skip_next", { ...data, type: "done" }) === false,
  "done event blocked for same request_id (simulates NDJSON duplicate)"
);
_now += 5000;
check(
  exp.shouldApplyMusicTransportAction(payload, "skip_next", { ...data, type: "done" }) === false,
  "finalize path still blocked 5s later (30s action_id TTL)"
);
check(
  exp.shouldApplyMusicTransportAction(payload, "skip_next", { request_id: "req_xyz", type: "done" }) === true,
  "separate user turn (new request_id) applies again"
);

console.log("\n── compound plan indices ──");
reset();
const volUp = { panel_type: "music_control", op: "volume_delta", delta: 0.05, planner_action_index: 1 };
const skip = { panel_type: "music_control", op: "skip_next", planner_action_index: 0 };
const req = { request_id: "req_compound", type: "multi_action" };
check(exp.shouldApplyMusicTransportAction(skip, "skip_next", req) === true, "compound: skip_next applies");
check(exp.shouldApplyMusicTransportAction(volUp, "volume_delta", req) === true, "compound: volume up applies");
check(exp.shouldApplyMusicTransportAction(skip, "skip_next", req) === false, "compound: duplicate skip blocked");
check(exp.shouldApplyMusicTransportAction(volUp, "volume_delta", req) === false, "compound: duplicate volume blocked");

console.log("\n── skip_previous ──");
reset();
const prevPayload = { panel_type: "music_control", op: "skip_previous" };
const prevData = { request_id: "req_prev", type: "meta" };
check(exp.shouldApplyMusicTransportAction(prevPayload, "skip_previous", prevData) === true, "previous: first applies");
check(exp.shouldApplyMusicTransportAction(prevPayload, "skip_previous", prevData) === false, "previous: duplicate blocked");

console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
