/**
 * Smoke tests for close-reasoning-panel voice turn lifecycle.
 *
 * This covers the regression where the close-panel shortcut mutated the panel
 * but skipped the normal voice turn boundary:
 *   - live browser-ASR user bubble was not promoted/finalized
 *   - ASR buffers were left attached to the old bubble
 *   - continuous listening could be left at Ready instead of Listening
 *
 * Run: node __reasoning_close_voice_lifecycle_smoke.mjs
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const SRC = readFileSync(resolvePath(process.cwd(), "app.js"), "utf-8");
/* Stage 8 (2026-05-27): renderReasoningCloseAssistantConfirmation moved
 * from app.js to workmode/panels.js. The render-block carve below now
 * reads from the new module file. */
const PANELS_SRC = readFileSync(resolvePath(process.cwd(), "workmode", "panels.js"), "utf-8");

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

function panelsBlockBetween(start, end) {
  const i = PANELS_SRC.indexOf(start);
  if (i < 0) throw new Error(`start marker not found in panels.js: ${start}`);
  const j = PANELS_SRC.indexOf(end, i);
  if (j < 0) throw new Error(`end marker not found in panels.js: ${end}`);
  return PANELS_SRC.slice(i, j);
}

function windowAfter(marker, chars = 500) {
  const i = SRC.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  return SRC.slice(i, i + chars);
}

console.log("-- Suite A - lifecycle helper exists and finalizes ASR state --");
const lifecycleBlock = blockBetween(
  "function finalizeReasoningCloseVoiceUserTurn(",
  "function finishReasoningCloseVoiceTurnAfterAssistant("
);
ok(lifecycleBlock.includes("commitServerUserTranscriptBubble("), "finalizer promotes/commits the user bubble");
ok(lifecycleBlock.includes("abortBrowserSpeechRecognizers();"), "finalizer aborts browser ASR recognizers");
ok(lifecycleBlock.includes('mainBrowserFinalTranscript = "";'), "finalizer clears final transcript buffer");
ok(lifecycleBlock.includes('mainBrowserLastInterim = "";'), "finalizer clears interim transcript buffer");
ok(lifecycleBlock.includes("mainBrowserAsrTurnSeq += 1;"), "finalizer increments browser ASR turn sequence");
ok(lifecycleBlock.includes('"stage": "before_command"') || lifecycleBlock.includes('stage: "before_command"'), "before-command lifecycle log is emitted");
ok(lifecycleBlock.includes('stage: "finalization"'), "finalization lifecycle log is emitted");
ok(lifecycleBlock.includes("user_bubble_finalized"), "finalization log includes user_bubble_finalized");
ok(lifecycleBlock.includes("active_user_bubble_id_after_finalize"), "finalization log includes active_user_bubble_id_after_finalize");
ok(lifecycleBlock.includes("turn_seq_incremented"), "finalization log includes turn_seq_incremented");

console.log("\n-- Suite B - confirmation/TTS resumes like normal app commands --");
/* Stage 8 (2026-05-27): renderReasoningCloseAssistantConfirmation moved
 * to workmode/panels.js. The new bottom marker is the accessor
 * `function getReasoningPanelDebugState(` introduced by Stage 8. */
const renderBlock = panelsBlockBetween(
  "function renderReasoningCloseAssistantConfirmation(",
  "function getReasoningPanelDebugState("
);
ok(renderBlock.includes("addBubble(text, \"vera\""), "confirmation renders as normal VERA assistant bubble");
ok(renderBlock.includes("enqueueAssistantTtsPlayback"), "voice confirmation uses assistant TTS queue");
ok(renderBlock.includes("playbackPromise.finally"), "resume is chained after TTS playback promise");
ok(renderBlock.includes("finishReasoningCloseVoiceTurnAfterAssistant"), "confirmation path calls lifecycle resume helper");
ok(renderBlock.includes('stage: "assistant_response"'), "assistant-response lifecycle log is emitted");
ok(renderBlock.includes("tts_enqueued"), "assistant-response log records tts_enqueued");

/* Stage 8 (2026-05-27): the close-lock helpers (_reasoningCloseLockKey
 * etc.) moved to workmode/panels.js. The next stable marker after
 * finishReasoningCloseVoiceTurnAfterAssistant in app.js is the
 * "_reasoningCloseLockKey, _hasActiveReasoningCloseLock, ... →
 * moved to workmode/panels.js" breadcrumb comment. */
const finishBlock = blockBetween(
  "function finishReasoningCloseVoiceTurnAfterAssistant(",
  "/* _reasoningCloseLockKey, _hasActiveReasoningCloseLock,"
);
ok(finishBlock.includes("resumeAfterAssistantReplyPlayback") === false, "close lifecycle has scoped resume helper, not a global reset");
ok(finishBlock.includes("setStatus(\"Listening…\", \"recording\")"), "continuous mode sets mic state back to Listening");
ok(finishBlock.includes("startListening();"), "continuous mode restarts listening loop");
ok(finishBlock.includes("listeningMode === \"ptt\""), "PTT mode is allowed to return to Ready");
ok(finishBlock.includes("next_user_bubble_ready"), "after-action log records next_user_bubble_ready");
ok(finishBlock.includes("browser_recognition_active_after"), "after-action log records browser recognition state");

console.log("\n-- Suite C - close shortcut uses lifecycle before action mutation --");
/* Stage 11 (2026-05-30): maybeHandleCloseReasoningPanelShortcut moved
 * from app.js to workmode/panels.js along with the entire close-command
 * parser block. The original end sentinel used a literal `\n` to anchor
 * the `try { ... }` window-alias trailer; that only worked against the
 * LF-encoded app.js. workmode/panels.js uses CRLF, so we anchor instead
 * on a single-line, line-ending-agnostic substring that only appears in
 * the window-alias trailer (`window.parseCloseReasoningPanelsCommand
 * = parseCloseReasoningPanelsCommand`). */
const shortcutBlock = panelsBlockBetween(
  "function maybeHandleCloseReasoningPanelShortcut(",
  "window.parseCloseReasoningPanelsCommand = parseCloseReasoningPanelsCommand"
);
const closeFinalizeIdx = shortcutBlock.indexOf("const lifecycle = finalizeReasoningCloseVoiceUserTurn(text");
const closeExecIdx = shortcutBlock.indexOf("const exec = executeCloseReasoningPanelsCommand(parsed");
ok(closeFinalizeIdx >= 0, "close shortcut calls finalizeReasoningCloseVoiceUserTurn");
ok(closeExecIdx >= 0, "close shortcut still executes close mutation");
ok(closeFinalizeIdx >= 0 && closeExecIdx >= 0 && closeFinalizeIdx < closeExecIdx, "user bubble finalizes before close action executes");
ok(shortcutBlock.includes('stage: "action"'), "close action lifecycle log is emitted");
ok(shortcutBlock.includes("target_panel_ids"), "action log records target_panel_ids");
ok(shortcutBlock.includes("panels_after"), "action log records panels_after");
ok(shortcutBlock.includes("resumeListeningAfter: true"), "close confirmation requests listening resume");

console.log("\n-- Suite D - voice call sites no longer force Ready immediately --");
const mainBrowserWindow = windowAfter('maybeHandleCloseReasoningPanelShortcut(trimmed, { reason: "main-browser-asr", isVoice: true })', 260);
ok(!mainBrowserWindow.includes('setStatus("Ready", "idle")'), "main-browser close path does not force Ready immediately");
ok(!mainBrowserWindow.includes("waveState = \"idle\""), "main-browser close path does not force idle immediately");

const serverWindow = windowAfter('maybeHandleCloseReasoningPanelShortcut(trimmed, { reason: "server-asr-preflight", isVoice: true })', 260);
ok(!serverWindow.includes('setStatus("Ready", "idle")'), "server-ASR close path does not force Ready immediately");
ok(!serverWindow.includes("processing = false;"), "server-ASR close path leaves lifecycle helper to finish processing");

const pttWindow = windowAfter('maybeHandleCloseReasoningPanelShortcut(text, { reason: "ptt-browser-asr", isVoice: true })', 220);
ok(!pttWindow.includes('setStatus("Ready", "idle")'), "PTT close path does not force Ready before confirmation/TTS path");

console.log("\n-- Suite E - browser ASR turn boundary rejects late events --");
const startBrowserBlock = blockBetween(
  "function startMainBrowserRecognitionContinuous()",
  "function startInterruptBrowserPartialDetection()"
);
ok(SRC.includes("let mainBrowserAsrTurnSeq = 0;"), "browser ASR turn sequence state exists");
ok(startBrowserBlock.includes("const asrTurnSeq = ++mainBrowserAsrTurnSeq;"), "new browser-ASR session captures a turn sequence");
ok(startBrowserBlock.includes("if (asrTurnSeq !== mainBrowserAsrTurnSeq) return;"), "late browser-ASR callbacks are guarded by turn sequence");

console.log("\n-- Suite F - required debug log fields are present --");
/* Stage 8 (2026-05-27): the assistant_response stage of
 * logReasoningCloseVoiceLifecycle (including the assistant_bubble_rendered
 * field) is now emitted from workmode/panels.js's
 * renderReasoningCloseAssistantConfirmation. Look there for it; the
 * other lifecycle fields are still emitted from app.js. */
const COMBINED = `${SRC}\n${PANELS_SRC}`;
[
  "action_name",
  "asr_mode",
  "listening_mode",
  "mic_state_before",
  "active_user_bubble_id_before",
  "current_turn_id_before",
  "browser_final_transcript_before",
  "interim_transcript_before",
  "user_bubble_finalized",
  "finalized_bubble_id",
  "finalized_text",
  "asr_buffers_cleared",
  "active_user_bubble_id_after_finalize",
  "turn_seq_incremented",
  "close_action_completed",
  "assistant_bubble_rendered",
  "confirmation_text",
  "tts_enqueued",
  "should_resume_listening",
  "mic_state_after",
  "browser_recognition_active_after",
  "next_user_bubble_ready",
].forEach((field) => {
  ok(COMBINED.includes(field), `debug field exists: ${field}`);
});

console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (failed.length) {
  console.log("\nFailed:");
  for (const f of failed) console.log("  -", f);
  process.exit(1);
}
process.exit(0);
