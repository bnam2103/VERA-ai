/**
 * Smoke tests for shared music track navigation dedupe + ended suppression.
 *
 * Run: node tests/smoke/__music_navigation_smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const NAV_PATH = path.join(ROOT, "voice", "musicNavigation.js");

let pass = 0;
let fail = 0;
const failed = [];

function ok(cond, name, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let now = 1000;
const fakeWindow = {};
const ctx = vm.createContext({
  console,
  window: fakeWindow,
  performance: { now: () => now },
});
ctx.window = fakeWindow;

vm.runInContext(fs.readFileSync(NAV_PATH, "utf8"), ctx, { filename: "voice/musicNavigation.js" });

const {
  createMusicNavigationState,
  shouldIgnoreMusicNavigationDuplicate,
  markMusicNavigationExecuted,
  isFreeMusicEndedNavigationSuppressed,
  musicNavigationDirectionLabel,
} = ctx.window;

ok(typeof musicNavigationDirectionLabel === "function", "exports loaded");

console.log("\n-- Direction labels --");
ok(musicNavigationDirectionLabel(1) === "next", "delta +1 → next");
ok(musicNavigationDirectionLabel(-1) === "previous", "delta -1 → previous");

console.log("\n-- Dedup: action_id --");
const state = createMusicNavigationState();
markMusicNavigationExecuted(state, { delta: 1, source: "voice", actionId: "plan_abc:skip_next", nowMs: now });
const dupAction = shouldIgnoreMusicNavigationDuplicate(state, {
  delta: 1,
  source: "voice",
  actionId: "plan_abc:skip_next",
  nowMs: now + 50,
});
ok(dupAction.ignore && dupAction.reason === "action_id", "duplicate action_id ignored");

console.log("\n-- Dedup: same source + direction window --");
const state2 = createMusicNavigationState();
markMusicNavigationExecuted(state2, { delta: 1, source: "button_next", actionId: null, nowMs: now });
const dupSource = shouldIgnoreMusicNavigationDuplicate(state2, {
  delta: 1,
  source: "button_next",
  actionId: null,
  nowMs: now + 100,
});
ok(dupSource.ignore && dupSource.reason === "source_direction_window", "same source+direction within 450ms ignored");

console.log("\n-- Opposite direction allowed --");
const opp = shouldIgnoreMusicNavigationDuplicate(state2, {
  delta: -1,
  source: "button_next",
  actionId: null,
  nowMs: now + 100,
});
ok(!opp.ignore, "opposite direction not blocked by next dedupe");

console.log("\n-- Timestamp fallback --");
const state3 = createMusicNavigationState();
markMusicNavigationExecuted(state3, { delta: -1, source: "music_control_payload", actionId: null, nowMs: now });
const dupTs = shouldIgnoreMusicNavigationDuplicate(state3, {
  delta: -1,
  source: "other_source",
  actionId: null,
  nowMs: now + 200,
});
ok(dupTs.ignore && dupTs.reason === "timestamp_fallback", "same direction timestamp fallback");

console.log("\n-- After window expires --");
now = now + 500;
const allowLater = shouldIgnoreMusicNavigationDuplicate(state3, {
  delta: -1,
  source: "other_source",
  actionId: null,
  nowMs: now,
});
ok(!allowLater.ignore, "navigation allowed after dedupe window");

console.log("\n-- Ended suppression --");
const state4 = createMusicNavigationState();
markMusicNavigationExecuted(state4, { delta: 1, source: "button_next", actionId: null, nowMs: 1000 });
ok(isFreeMusicEndedNavigationSuppressed(state4, 1200), "ended suppressed shortly after manual nav");
ok(!isFreeMusicEndedNavigationSuppressed(state4, 2000), "ended not suppressed after guard expires");

console.log("\n============================================================");
console.log(`Total: ${pass + fail}   PASS=${pass}   FAIL=${fail}`);
if (fail) {
  for (const name of failed) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("All music navigation smoke tests passed.");
