/**
 * Node smoke test for the music-transport dedupe fix.
 *
 * Bug:
 *   NDJSON calls ``applyActionPayload`` twice — once from
 *   ``finalizeNdjsonStreamingReply`` (before first audio) and once from
 *   ``onPlayStart`` (when first audio plays). For idempotent ops
 *   (``pause`` / ``resume``) the double-fire is harmless. For
 *   ``skip_next`` / ``skip_previous`` it was already guarded by
 *   ``shouldApplyMusicTransportAction``. ``volume_delta`` was NOT
 *   guarded, so "turn up the music" applied +5% twice (=+10%) per
 *   command — visible as an oversized jump on the Spotify volume bar.
 *
 * Fix:
 *   ``shouldApplyMusicTransportAction`` now also dedupes ``volume_delta``
 *   keyed by sign-of-delta (so "volume up then volume down" within the
 *   900 ms window still applies both directions). The handler in
 *   ``applyActionPayload`` calls the guard before mutating the volume.
 *
 * This test:
 *   * Parses out shouldApplyMusicTransportAction + dedupe key helper
 *     into a Node VM context.
 *   * Asserts the spec'd behavior:
 *     - skip_next / skip_previous still dedupe within 900 ms (regression).
 *     - volume_delta dedupes a second SAME-DIRECTION call within 900 ms.
 *     - volume_delta does NOT dedupe an OPPOSITE-DIRECTION call inside
 *       the window (user really did say "volume up" then "volume down").
 *     - After the 900 ms window expires, the same direction fires again.
 *     - pause / resume / open_panel still always fire (idempotent).
 *     - zero / NaN deltas pass through (no dedupe state poisoning).
 *
 * Run with:  node __music_volume_dedupe_smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// Path adjusted on move to tests/smoke/: app.js lives at the repo root (two levels up).
const ROOT = path.join(__dirname, "..", "..");
const NAV_JS = fs.readFileSync(path.join(ROOT, "voice", "musicNavigation.js"), "utf8");
const APP_JS = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

// --- mock browser-ish context --------------------------------------------
let _now = 1000;
const fakeWindow = {};
const ctx = vm.createContext({
  console: { info() {}, warn() {}, error() {}, log() {} },
  window: fakeWindow,
  performance: { now: () => _now },
  Number,
  Math,
});
ctx.window = fakeWindow;
ctx.performance = { now: () => _now };

vm.runInContext(NAV_JS, ctx, { filename: "musicNavigation.js" });

// --- carve out shouldApplyMusicTransportAction ---------------------------
const START_MARKER = "/**\n * Collapse duplicate music transport dispatch";
const END_MARKER = "async function invokeSpotifyTransport(";
function carve(src, start, end) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`start marker not found: ${start}`);
  const j = src.indexOf(end, i);
  if (j < 0) throw new Error(`end marker not found: ${end}`);
  return src.slice(i, j);
}
const helperSrc = carve(APP_JS, START_MARKER, END_MARKER);

const harness = `
${helperSrc}
globalThis.__exp = { shouldApplyMusicTransportAction };
`;
vm.runInContext(harness, ctx);
const exp = ctx.__exp;

let pass = 0, fail = 0;
const failed = [];
function check(cond, name, detail = "") {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; failed.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function advanceMs(ms) { _now += ms; }
function resetDedupe() {
  delete fakeWindow.__veraMusicTransportDedupe;
  _now = 1000;
}

console.log("── Suite A — volume_delta dedupe (the actual bug) ──");
resetDedupe();
let r1 = exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
check(r1 === true, "first volume_delta (+0.05) applies");
let r2 = exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
check(r2 === false, "second IDENTICAL volume_delta (+0.05) within 0ms is deduped — fixes 'turn up music happens twice'");
// Same SIGN, different magnitude — still deduped (it's the NDJSON
// double-dispatch of the same command).
r1 = exp.shouldApplyMusicTransportAction({ delta: +0.10 }, "volume_delta");
check(r1 === false, "same-direction volume_delta (+0.10) within window also deduped");

console.log("\n── Suite B — opposite-direction volume still fires ──");
resetDedupe();
exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
advanceMs(100);
const opp = exp.shouldApplyMusicTransportAction({ delta: -0.05 }, "volume_delta");
check(opp === true, "opposite direction (-0.05) after +0.05 within window still fires (legit user 'up then down')");
advanceMs(100);
const opp2 = exp.shouldApplyMusicTransportAction({ delta: -0.05 }, "volume_delta");
check(opp2 === false, "second -0.05 within 100ms after -0.05 is deduped");

console.log("\n── Suite C — dedupe window expires after 900ms ──");
resetDedupe();
exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
advanceMs(901);
const afterWindow = exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
check(afterWindow === true, "same direction +0.05 after 901ms fires again");

console.log("\n── Suite D — skip_next / skip_previous regression ──");
resetDedupe();
check(exp.shouldApplyMusicTransportAction({}, "skip_next") === true, "skip_next: first fires");
check(exp.shouldApplyMusicTransportAction({}, "skip_next") === false, "skip_next: duplicate within window deduped");
resetDedupe();
check(exp.shouldApplyMusicTransportAction({}, "skip_previous") === true, "skip_previous: first fires");
check(exp.shouldApplyMusicTransportAction({}, "skip_previous") === false, "skip_previous: duplicate within window deduped");
// skip_next then skip_previous in quick succession — they use different
// keys so both should fire (user really did press both in sequence).
resetDedupe();
exp.shouldApplyMusicTransportAction({}, "skip_next");
const sp = exp.shouldApplyMusicTransportAction({}, "skip_previous");
check(sp === true, "skip_next then skip_previous within window both fire (different keys)");

console.log("\n── Suite E — idempotent ops always pass through ──");
resetDedupe();
check(exp.shouldApplyMusicTransportAction({}, "pause") === true, "pause: never deduped (idempotent)");
check(exp.shouldApplyMusicTransportAction({}, "pause") === true, "pause: still fires immediately again (idempotent)");
check(exp.shouldApplyMusicTransportAction({}, "resume") === true, "resume: never deduped (idempotent)");
check(exp.shouldApplyMusicTransportAction({}, "resume") === true, "resume: still fires immediately again (idempotent)");
check(exp.shouldApplyMusicTransportAction({}, "open_panel") === true, "open_panel: passthrough");
check(exp.shouldApplyMusicTransportAction({}, "close_panel") === true, "close_panel: passthrough");
check(exp.shouldApplyMusicTransportAction({}, "play_track") === true, "play_track: passthrough (handled by shouldPlayMusicThisInvocation)");

console.log("\n── Suite F — defensive: zero/NaN delta does not poison the dedupe slot ──");
resetDedupe();
const zero = exp.shouldApplyMusicTransportAction({ delta: 0 }, "volume_delta");
check(zero === true, "delta=0 → passthrough (no-op, doesn't reserve a dedupe slot)");
// After delta=0, a real volume_delta should still apply (the slot wasn't poisoned).
const real = exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
check(real === true, "real +0.05 after delta=0 still fires (slot not poisoned)");
resetDedupe();
const nan = exp.shouldApplyMusicTransportAction({ delta: NaN }, "volume_delta");
check(nan === true, "delta=NaN → passthrough");
const real2 = exp.shouldApplyMusicTransportAction({ delta: -0.05 }, "volume_delta");
check(real2 === true, "real -0.05 after delta=NaN still fires");
resetDedupe();
const missing = exp.shouldApplyMusicTransportAction({}, "volume_delta");
check(missing === true, "no payload.delta → passthrough");

console.log("\n── Suite G — sanity: the dedupe key includes the direction ──");
resetDedupe();
exp.shouldApplyMusicTransportAction({ delta: +0.05 }, "volume_delta");
const slot = fakeWindow.__veraMusicTransportDedupe;
check(typeof slot?.key === "string" && /volume_delta:\+1$/.test(slot.key),
      "dedupe slot key encodes +1 direction",
      slot ? JSON.stringify(slot) : "no slot");
resetDedupe();
exp.shouldApplyMusicTransportAction({ delta: -0.05 }, "volume_delta");
const slotNeg = fakeWindow.__veraMusicTransportDedupe;
check(typeof slotNeg?.key === "string" && /volume_delta:-1$/.test(slotNeg.key),
      "dedupe slot key encodes -1 direction",
      slotNeg ? JSON.stringify(slotNeg) : "no slot");

console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (failed.length) {
  console.log("\nFailed:");
  for (const n of failed) console.log("  -", n);
  process.exit(1);
}
process.exit(0);
