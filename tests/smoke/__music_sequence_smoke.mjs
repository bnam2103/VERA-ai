/**
 * Smoke for voice/musicSequence.js — sequencing + provider exclusivity barriers.
 * Run: node tests/smoke/__music_sequence_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

let PASS = 0;
let FAIL = 0;

function ok(cond, name) {
  if (cond) {
    PASS += 1;
    console.log(`  PASS  ${name}`);
  } else {
    FAIL += 1;
    console.log(`  FAIL  ${name}`);
  }
}

const playback = {
  activeSource: "builtin",
  isPlaying: true,
  trackTitle: "lofi mix",
  artist: "Built-in",
};
let builtinPlaying = true;
let spotifyPlaying = false;
const calls = [];

const ctx = {
  window: {
    __veraGetGlobalPlaybackState: () => ({ ...playback }),
    __veraIsBuiltinMusicAudiblyPlaying: () => builtinPlaying,
    __veraIsSpotifyMusicAudiblyPlaying: () => spotifyPlaying,
    __veraInferMusicTargetProvider: (payload, op) =>
      op === "play_builtin" ? "builtin" : "spotify",
    __veraMusicSequenceActiveProvider: null,
    veraMusicControlMeta: null,
    veraWaitForMusicPlaybackSettled: null,
    veraApplyActionPayloadsInOrder: null,
  },
  performance: { now: () => Date.now() },
  console: { warn: () => {}, info: () => {}, log: () => {} },
  setTimeout: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return id;
  },
  clearTimeout: (id) => clearTimeout(id),
};
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, "voice", "musicSequence.js"), "utf8"), ctx);

const meta = ctx.window.veraMusicControlMeta;
ok(typeof meta === "function", "veraMusicControlMeta exported");
ok(meta("play_playlist_scoped").stateBarrier === "playback_settled", "play has playback_settled barrier");

const order = [];
await ctx.window.veraApplyActionPayloadsInOrder(
  [
    { panel_type: "music_control", op: "play_playlist_by_name", playlist_name: "Peak", title: "Peak" },
    { panel_type: "music_control", op: "skip_next" },
    { panel_type: "music_control", op: "volume_delta", delta: 5 },
  ],
  async (payload, seqCtx) => {
    order.push({ op: payload.op, activeProvider: seqCtx?.activeProvider || null });
    if (payload.op === "play_playlist_by_name") {
      calls.push("stop_builtin");
      builtinPlaying = false;
      playback.activeSource = "none";
      playback.isPlaying = false;
      await new Promise((r) => setTimeout(r, 10));
      calls.push("spotify_play");
      spotifyPlaying = true;
      playback.activeSource = "spotify";
      playback.isPlaying = true;
      playback.trackTitle = "Peak";
      return { op: payload.op, targetProvider: "spotify", expectedTrack: "Peak" };
    }
    if (payload.op === "skip_next") {
      calls.push(`skip:${seqCtx?.activeProvider || "none"}`);
      return { op: payload.op, transportProvider: seqCtx?.activeProvider || "spotify" };
    }
    return { op: payload.op };
  },
  { requestId: "smoke" }
);

ok(order[0]?.op === "play_playlist_by_name", "play runs first");
ok(order[1]?.activeProvider === "spotify", "skip receives spotify as activeProvider after play");
ok(calls.includes("stop_builtin"), "builtin stop before spotify play");
ok(calls.includes("spotify_play"), "spotify play awaited");
ok(calls.includes("skip:spotify"), "skip targets spotify not builtin");
ok(!calls.some((c) => c === "skip:builtin"), "skip does not target builtin");
ok(
  order.map((x) => x.op).join(",") === "play_playlist_by_name,skip_next,volume_delta",
  "full sequence order preserved",
);

console.log(`\nPASS ${PASS}  FAIL ${FAIL}`);
process.exit(FAIL ? 1 : 0);
