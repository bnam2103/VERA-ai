/**
 * Smoke: weather forecast must not replace the music panel in Work Mode.
 *
 * Run: node tests/smoke/__weather_music_panel_guard_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const APP = readFileSync(resolvePath(process.cwd(), "app.js"), "utf8");
const WEATHER = readFileSync(resolvePath(process.cwd(), "news", "weatherPanel.js"), "utf8");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let pass = 0;
let fail = 0;
const failed = [];
function ok(cond, name, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ${GREEN}PASS${RESET}  ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`  ${RED}FAIL${RESET}  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function blockBetween(src, start, end) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`start not found: ${start}`);
  const j = src.indexOf(end, i);
  if (j < 0) throw new Error(`end not found: ${end}`);
  return src.slice(i, j);
}

console.log("-- applyActionPayload Work Mode music guard --");
const guardBlock = blockBetween(
  APP,
  "const _INFO_PANEL_TYPES_THAT_MUST_NOT_REPLACE_MUSIC = new Set([",
  "async function applyActionPayload(data, seqCtx = {})"
);
ok(guardBlock.includes('"weather_forecast_panel"'), "weather_forecast_panel in pinned info panel set");
ok(guardBlock.includes("[music_panel_overwrite_blocked]"), "music_panel_overwrite_blocked log in guard");
ok(guardBlock.includes("[music_panel_preserved]"), "music_panel_preserved log in guard");
ok(guardBlock.includes("_blockInfoPanelOverwriteMusicInWorkMode(payload)"), "applyActionPayload calls music guard");

console.log("\n-- weatherPanel.js defensive render guard --");
ok(WEATHER.includes("[weather_panel_render_requested]"), "weather_panel_render_requested log");
ok(WEATHER.includes("[weather_panel_target_container]"), "weather_panel_target_container log");
ok(WEATHER.includes("work_mode_productivity_pinned"), "weather renderer blocks overwrite in Work Mode");
ok(
  WEATHER.indexOf("workModeActive && musicPanelExistsBefore") <
    WEATHER.indexOf('sidePaneEl.innerHTML = `'),
  "weather guard runs before side-pane innerHTML replace"
);

console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (failed.length) {
  console.log("\nFailed:");
  for (const f of failed) console.log("  -", f);
  process.exit(1);
}
process.exit(0);
