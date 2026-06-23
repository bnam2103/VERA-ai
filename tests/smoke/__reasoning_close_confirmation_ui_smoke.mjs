/**
 * Smoke test for close-reasoning-panel confirmation rendering/TTS.
 *
 * Verifies the regression described by the user:
 * close-panel confirmations must render as normal VERA assistant bubbles,
 * not raw/plain text or the legacy "assistant" role, and voice-originated
 * confirmations should enqueue TTS unless muted/text-only.
 *
 * Run:  node __reasoning_close_confirmation_ui_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/* Stage 8 (2026-05-27): isReasoningCloseVoiceSource +
 * renderReasoningCloseAssistantConfirmation moved from app.js to
 * workmode/panels.js. SRC now reads from the new module. */
const SRC = readFileSync(resolvePath(process.cwd(), "workmode", "panels.js"), "utf-8");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const hostConsole = globalThis.console;

let pass = 0;
let fail = 0;
const failed = [];
function ok(cond, name, detail = "") {
  if (cond) {
    pass += 1;
    hostConsole.log(`  ${GREEN}PASS${RESET}  ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    hostConsole.log(`  ${RED}FAIL${RESET}  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function carve(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`startMarker not found: ${startMarker}`);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error(`endMarker not found: ${endMarker}`);
  return src.slice(i, j);
}

/* Stage 8: post-move, the workmode/panels.js helper block runs from
 * `function isReasoningCloseVoiceSource(` to the new accessor
 * `function getReasoningPanelDebugState(`. */
const helperBlock = carve(
  SRC,
  "function isReasoningCloseVoiceSource(",
  "function getReasoningPanelDebugState("
);

let inputMuted = false;
let workMuted = false;
const bubbles = [];
const ttsTasks = [];
const ttsPlayed = [];
const logs = [];

function addBubble(text, who, meta) {
  bubbles.push({ text, who, meta });
  return { textContent: text, className: `bubble ${who}` };
}
function appModePrefix() { return "vera"; }
function isVeraWorkModeOn() { return true; }
function isWorkModeMuteEnabled() { return workMuted; }
function enqueueAssistantTtsPlayback(task) {
  ttsTasks.push(task);
  return Promise.resolve();
}
async function playWorkModeTtsOnlyPhrase(text) {
  ttsPlayed.push(text);
}

const console = {
  info(...args) { logs.push(args.join(" ")); },
  warn() {},
  error() {},
  log() {},
};

const SANDBOX = `
${helperBlock}
globalThis.isReasoningCloseVoiceSource = isReasoningCloseVoiceSource;
globalThis.renderReasoningCloseAssistantConfirmation = renderReasoningCloseAssistantConfirmation;
`;

// eslint-disable-next-line no-new-func
new Function(
  "inputMuted",
  "appModePrefix",
  "isVeraWorkModeOn",
  "isWorkModeMuteEnabled",
  "addBubble",
  "enqueueAssistantTtsPlayback",
  "playWorkModeTtsOnlyPhrase",
  "AbortController",
  "console",
  `${SANDBOX}; return { isReasoningCloseVoiceSource, renderReasoningCloseAssistantConfirmation };`
);

const exp = new Function(
  "inputMutedRef",
  "appModePrefix",
  "isVeraWorkModeOn",
  "isWorkModeMuteEnabled",
  "addBubble",
  "enqueueAssistantTtsPlayback",
  "playWorkModeTtsOnlyPhrase",
  "AbortController",
  "console",
  `
  let inputMuted = inputMutedRef.value;
  function __setInputMuted(v) { inputMuted = Boolean(v); }
  ${helperBlock}
  return { isReasoningCloseVoiceSource, renderReasoningCloseAssistantConfirmation, __setInputMuted };
  `
)(
  { value: inputMuted },
  appModePrefix,
  isVeraWorkModeOn,
  isWorkModeMuteEnabled,
  addBubble,
  enqueueAssistantTtsPlayback,
  playWorkModeTtsOnlyPhrase,
  AbortController,
  console
);

function reset() {
  inputMuted = false;
  workMuted = false;
  exp.__setInputMuted(false);
  bubbles.length = 0;
  ttsTasks.length = 0;
  ttsPlayed.length = 0;
  logs.length = 0;
}

hostConsole.log("── Suite A — source classification ──");
ok(exp.isReasoningCloseVoiceSource("main-browser-asr") === true, "main-browser-asr is voice");
ok(exp.isReasoningCloseVoiceSource("voice_interruption") === true, "voice_interruption is voice");
ok(exp.isReasoningCloseVoiceSource("ptt-browser-asr") === true, "ptt-browser-asr is voice");
ok(exp.isReasoningCloseVoiceSource("work-typed") === false, "work-typed is text-only");
ok(exp.isReasoningCloseVoiceSource("main-work-text-input") === false, "main-work-text-input is text-only");
ok(exp.isReasoningCloseVoiceSource("anything", true) === true, "explicit isVoice=true wins");
ok(exp.isReasoningCloseVoiceSource("main-browser-asr", false) === false, "explicit isVoice=false wins");

hostConsole.log("\n── Suite B — normal assistant bubble + TTS for voice ──");
reset();
const resVoice = exp.renderReasoningCloseAssistantConfirmation("Closed Panel 1 and opened a fresh one.", {
  path: "close-reasoning-panel",
  source: "main-browser-asr",
  isVoice: true,
  closeActionCompleted: true,
});
ok(resVoice.renderPath === "assistant_bubble", "render path is assistant_bubble");
ok(bubbles.length === 1, "exactly one bubble inserted");
ok(bubbles[0]?.who === "vera", "bubble uses normal VERA assistant role");
ok(bubbles[0]?.who !== "assistant", "bubble does not use legacy/plain assistant role");
ok(bubbles[0]?.text === "Closed Panel 1 and opened a fresh one.", "bubble text is confirmation");
ok(ttsTasks.length === 1 && resVoice.ttsEnqueued === true, "TTS enqueued for voice confirmation");
ok(logs.some((l) => l.includes("[reasoning_close_confirmation_debug]")), "debug log emitted");
ok(logs.some((l) => l.includes('"confirmation_render_path":"assistant_bubble"')), "debug log records assistant_bubble render path");
ok(logs.some((l) => l.includes('"confirmation_tts_enqueued":true')), "debug log records TTS enqueued");
ok(logs.some((l) => l.includes('"action_result_consumed_by_normal_reply_pipeline":true')), "debug log records normal reply pipeline consumption");

hostConsole.log("\n── Suite C — text-only path renders but does not TTS ──");
reset();
const resTyped = exp.renderReasoningCloseAssistantConfirmation("Closed Panel 1 and opened a fresh one.", {
  path: "close-reasoning-panel",
  source: "work-typed",
  isVoice: false,
  closeActionCompleted: true,
});
ok(resTyped.renderPath === "assistant_bubble", "typed path still renders assistant bubble");
ok(bubbles.length === 1 && bubbles[0]?.who === "vera", "typed path uses VERA bubble");
ok(ttsTasks.length === 0 && resTyped.ttsEnqueued === false, "typed/text-only path does not enqueue TTS");
ok(logs.some((l) => l.includes('"confirmation_tts_enqueued":false')), "typed debug log records no TTS");

hostConsole.log("\n── Suite D — muted voice path renders but skips TTS ──");
reset();
workMuted = true;
const resMuted = exp.renderReasoningCloseAssistantConfirmation("Closed this panel and opened a fresh one.", {
  path: "close-reasoning-panel",
  source: "main-browser-asr",
  isVoice: true,
  closeActionCompleted: true,
});
ok(resMuted.renderPath === "assistant_bubble", "muted voice still renders assistant bubble");
ok(bubbles.length === 1 && bubbles[0]?.who === "vera", "muted voice uses VERA bubble");
ok(ttsTasks.length === 0 && resMuted.ttsEnqueued === false, "muted voice skips TTS");
ok(logs.some((l) => l.includes('"confirmation_tts_skipped_reason":"muted"')), "muted debug log explains TTS skip");

hostConsole.log("\n── Suite E — static regression checks ──");
ok(!/addBubble\([^\\n]+,\\s*"assistant"/.test(SRC), "no close confirmation path uses addBubble(..., \"assistant\")");
ok(SRC.includes("function renderReasoningCloseAssistantConfirmation"), "central helper exists");
ok(SRC.includes("confirmation_render_path"), "debug field confirmation_render_path exists");
ok(SRC.includes("confirmation_tts_enqueued"), "debug field confirmation_tts_enqueued exists");
ok(SRC.includes("duplicate_confirmation_suppressed"), "debug field duplicate_confirmation_suppressed exists");

hostConsole.log("");
hostConsole.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (failed.length) {
  hostConsole.log("\nFailed:");
  for (const f of failed) hostConsole.log("  -", f);
  process.exit(1);
}
process.exit(0);
