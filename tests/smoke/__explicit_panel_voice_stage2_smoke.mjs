/**
 * Smoke: grounded Stage 2 voice final brief for explicit panel-directed Work Mode.
 *
 * Verifies app.js wiring without booting the full bundle:
 *   A. Explicit numeric panel ("panel 4") enables grounded Stage 2 after stream
 *   B. Ordinal explicit panel ("first panel") stores target on prep
 *   C. Normal voice-routed Work Mode still uses grounded /voice_final_brief path
 *   D. Compound open_and_stream still threads explicit panel flags for Stage 2
 *   E. Stale-lane guard hard-skips when explicit target lane != stream lane
 *
 * Run: node tests/smoke/__explicit_panel_voice_stage2_smoke.mjs
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
  }
}

function section(label) {
  console.log(`\n-- ${label} --`);
}

section("A — explicit panel destination does not skip grounded Stage 2");

const prepFnIdx = APP_JS.indexOf("async function maybePrepareWorkModeReasoning(");
ok(prepFnIdx > 0, "maybePrepareWorkModeReasoning present");

const voiceTwoStageBlock = prepFnIdx > 0
  ? APP_JS.slice(
      APP_JS.indexOf("const voiceTwoStage = {", prepFnIdx),
      APP_JS.indexOf("const voiceTwoStage = {", prepFnIdx) + 900
    )
  : "";

ok(
  /skipStage2Infer:\s*false/.test(voiceTwoStageBlock),
  "voiceTwoStage.skipStage2Infer is false (grounded Stage 2 runs for explicit panel too)",
  voiceTwoStageBlock.slice(0, 280)
);
ok(
  /explicitPanelDestination:\s*Boolean\(opts\.__explicitPanelDestinationConsumed\)/.test(voiceTwoStageBlock),
  "explicitPanelDestination flag still set from consumed explicit panel ref",
  voiceTwoStageBlock.slice(0, 280)
);

const scheduleIdx = APP_JS.indexOf("function scheduleWorkModeDeferredReasoningStageTwoInfer(");
const scheduleBlock = scheduleIdx > 0 ? APP_JS.slice(scheduleIdx, scheduleIdx + 1200) : "";
ok(
  !/explicit_panel_destination_ack_only/.test(scheduleBlock),
  "scheduleWorkModeDeferredReasoningStageTwoInfer no longer bails on explicit panel ack-only",
  scheduleBlock.slice(0, 280)
);
ok(
  /if\s*\(\s*!prep\?\.voiceTwoStage\?\.reasoningRouted\s*\)\s*return/.test(scheduleBlock),
  "deferred Stage 2 requires reasoningRouted only",
  scheduleBlock.slice(0, 280)
);

section("B — explicit panel target stored on prep for markdown snapshot");

const prepReturnIdx = APP_JS.indexOf("return workModeReasoningPrepOutcome(chainP, inferThreadAnchor, inferGate, {");
ok(prepReturnIdx > 0, "maybePrepareWorkModeReasoning return block found");
const prepReturnBlock = prepReturnIdx > 0 ? APP_JS.slice(prepReturnIdx, prepReturnIdx + 600) : "";
ok(/explicitPanelTarget:\s*explicitTargetPanel1Based/.test(prepReturnBlock),
   "prep carries explicitPanelTarget (1-based panel index)",
   prepReturnBlock.slice(0, 280));
ok(/explicitTargetLaneId:/.test(prepReturnBlock),
   "prep carries explicitTargetLaneId (stable stream lane)",
   prepReturnBlock.slice(0, 280));

const outcomeIdx = APP_JS.indexOf("function workModeReasoningPrepOutcome(");
const outcomeBlock = outcomeIdx > 0 ? APP_JS.slice(outcomeIdx, outcomeIdx + 900) : "";
ok(/explicitPanelTarget:/.test(outcomeBlock), "workModeReasoningPrepOutcome exposes explicitPanelTarget");
ok(/explicitTargetLaneId:/.test(outcomeBlock), "workModeReasoningPrepOutcome exposes explicitTargetLaneId");

section("C — normal Work Mode voice still uses grounded Stage 2 path");

const runInferIdx = APP_JS.indexOf("async function runInferAfterWorkModeReasoningPrep(");
const runInferBlock = runInferIdx > 0 ? APP_JS.slice(runInferIdx, runInferIdx + 900) : "";
ok(
  /if\s*\(\s*p\?\.voiceTwoStage\?\.reasoningRouted\s*\)\s*\{[\s\S]{0,200}runWorkModeGroundedVoiceFinalAfterReasoningPrep/.test(
    runInferBlock
  ),
  "runInferAfterWorkModeReasoningPrep routes all reasoningRouted turns to grounded Stage 2",
  runInferBlock.slice(0, 320)
);

const groundedIdx = APP_JS.indexOf("async function runWorkModeGroundedVoiceFinalAfterReasoningPrep(");
const groundedBlock = groundedIdx > 0 ? APP_JS.slice(groundedIdx, groundedIdx + 700) : "";
ok(
  !/vs\.skipStage2Infer/.test(groundedBlock),
  "runWorkModeGroundedVoiceFinalAfterReasoningPrep does not gate on skipStage2Infer",
  groundedBlock.slice(0, 280)
);
ok(
  /\/work_mode\/voice_final_brief/.test(APP_JS),
  "fetchWorkModeGroundedVoiceFinalBrief still calls /work_mode/voice_final_brief"
);

section("D — compound open_and_stream threads explicit panel for recursive Stage 2");

const oasIdx = APP_JS.indexOf("function applyWorkModeReasoningOpenAndStreamPayload(");
const oasBlock = oasIdx > 0 ? APP_JS.slice(oasIdx, oasIdx + 12000) : "";
ok(
  /__explicitPanelDestinationConsumed:\s*explicitPanelDestination/.test(oasBlock),
  "compound open_and_stream forwards __explicitPanelDestinationConsumed",
  oasBlock.slice(0, 400)
);
ok(
  /__reasoningGateTargetPanel:/.test(oasBlock),
  "compound open_and_stream forwards __reasoningGateTargetPanel",
  oasBlock.slice(0, 400)
);

section("E — stale lane guard hard-skips explicit panel mismatches");

const resolveIdx = APP_JS.indexOf("function resolveGroundedVoiceFinalPanelMarkdown(");
const resolveBlock = resolveIdx > 0 ? APP_JS.slice(resolveIdx, resolveIdx + 4500) : "";
ok(
  /explicit_target_stream_lane_mismatch/.test(resolveBlock),
  "resolveGroundedVoiceFinalPanelMarkdown hard-skips stream vs explicit target lane mismatch",
  resolveBlock.slice(0, 400)
);
ok(
  /snapshot_lane_mismatch/.test(resolveBlock) &&
    /if\s*\(\s*explicitPanel\s*\)\s*\{[\s\S]{0,120}return\s*\{[\s\S]{0,80}skipReason:\s*"snapshot_lane_mismatch"/.test(
      resolveBlock
    ),
  "explicit panel snapshot lane mismatch returns skip (no wrong-panel summary)",
  resolveBlock.slice(0, 500)
);
const laneHandoffIdx = APP_JS.indexOf("function logLaneHandoffForVoiceFinal(");
const laneHandoffBlock =
  laneHandoffIdx > 0
    ? APP_JS.slice(laneHandoffIdx, APP_JS.indexOf("\nfunction ", laneHandoffIdx + 1))
    : "";
ok(/target_panel:/.test(laneHandoffBlock), "[lane_handoff] log includes target_panel");
ok(
  /explicit_panel_destination:/.test(groundedBlock),
  "[voice_final_brief_attempt] includes explicit_panel_destination",
  groundedBlock.slice(0, 400)
);

section("summary");
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failed:", failures.join(", "));
  process.exit(1);
}
console.log("All smoke checks passed.");
