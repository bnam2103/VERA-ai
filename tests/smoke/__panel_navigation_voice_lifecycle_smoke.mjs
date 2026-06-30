/**
 * Smoke: panel navigation voice shortcut must preserve transcript + listening lifecycle.
 *
 * Run: node tests/smoke/__panel_navigation_voice_lifecycle_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const SRC = readFileSync(resolvePath(process.cwd(), "app.js"), "utf8");

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

function blockBetween(start, end) {
  const i = SRC.indexOf(start);
  if (i < 0) throw new Error(`start marker not found: ${start}`);
  const j = SRC.indexOf(end, i);
  if (j < 0) throw new Error(`end marker not found: ${end}`);
  return SRC.slice(i, j);
}

function windowAfter(marker, chars = 280) {
  const i = SRC.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return SRC.slice(i, i + chars);
}

console.log("-- Panel navigation shortcut lifecycle --");
const shortcutBlock = blockBetween(
  "function maybeHandleWorkModePanelNavigationShortcut(text, opts = {}) {",
  "/** Multi-item planning / scheduling — route to reasoning and enable checklist Sync from markdown."
);
ok(shortcutBlock.includes("finalizeReasoningCloseVoiceUserTurn(raw"), "voice path finalizes user transcript before navigation");
ok(shortcutBlock.includes("resumeListeningAfter: isVoice"), "confirmation requests listening resume for voice");
ok(shortcutBlock.includes("[panel_navigation_transcript_rendered]"), "transcript rendered log exists");
ok(shortcutBlock.includes("[panel_navigation_listening_resume]"), "listening resume log exists");
ok(shortcutBlock.includes("[panel_navigation_voice_lifecycle_preserved]"), "lifecycle preserved log exists");
ok(shortcutBlock.includes("[panel_navigation_target_resolved]"), "target resolved log exists");

console.log("\n-- Ordinal token must not strip th from third --");
const ordBlock = blockBetween(
  "function _panelNavOrdinalTokenToVisual1(tok) {",
  "function _stripPanelSuffixFromTitleQuery(q) {"
);
ok(ordBlock.includes("_REASONING_PANEL_ORD_MAP[t]"), "ordinal map lookup happens before numeric suffix strip");
ok(
  ordBlock.indexOf("_REASONING_PANEL_ORD_MAP[t]") < ordBlock.indexOf("replace(/(?:st|nd|rd|th)$/i"),
  "word ordinals resolve before digit suffix strip"
);

console.log("\n-- Voice call sites must not force Ready immediately --");
const mainBrowserWindow = windowAfter(
  'maybeHandleWorkModePanelNavigationShortcut(trimmed, { reason: "main-browser-asr", isVoice: true })',
  120
);
ok(!mainBrowserWindow.includes('setStatus("Ready", "idle")'), "main-browser nav path does not force Ready");

const serverWindow = windowAfter(
  'maybeHandleWorkModePanelNavigationShortcut(trimmed, { reason: "server-asr-preflight", isVoice: true })',
  120
);
ok(!serverWindow.includes('setStatus("Ready", "idle")'), "server-ASR nav path does not force Ready");

const pttWindow = windowAfter(
  'maybeHandleWorkModePanelNavigationShortcut(text, { reason: "ptt-browser-asr", isVoice: true })',
  120
);
ok(!pttWindow.includes('setStatus("Ready", "idle")'), "PTT nav path does not force Ready");

console.log(`\nTotal: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (failed.length) {
  console.log("\nFailed:");
  for (const f of failed) console.log("  -", f);
  process.exit(1);
}
process.exit(0);
