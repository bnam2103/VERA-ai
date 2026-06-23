/**
 * Frontend acceptance smoke for the 2026-06-01 multi-panel / multi-action
 * patch — verifies the regex / lane-acquisition changes inside app.js without
 * booting the full bundle.
 *
 * Checks:
 *   - _WMC_REASONING_FAMILY_RE now matches "help me plan|draft|outline" and
 *     bare "plan my X" so compound utterances trip the family detector and
 *     defer to the backend planner.
 *   - The reasoning-prep block reads opts.__reasoningGateTargetPanel and
 *     uses it to prefer an explicit-lane index over the frozen turn lane.
 *   - applyWorkModeReasoningOpenAndStreamPayload threads
 *     __reasoningGateTargetPanel into the recursive submit so the cleaned-
 *     prompt re-dispatch lands in the same panel the planner picked.
 *
 * Run: node tests/smoke/__multi_panel_frontend_smoke.mjs
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

// --------------------------------------------------------------------------
// Suite A: reasoning family regex now sees "help me plan" / bare "plan my X"
// --------------------------------------------------------------------------
section("A — _WMC_REASONING_FAMILY_RE covers plan / help-me-plan");

const reFamilyMatch = APP_JS.match(
  /const _WMC_REASONING_FAMILY_RE\s*=\s*(\/[^\n]+\/i);/
);
ok(reFamilyMatch != null, "found _WMC_REASONING_FAMILY_RE definition in app.js");
let reasoningFamilyRe = null;
if (reFamilyMatch) {
  try {
    // eslint-disable-next-line no-eval
    reasoningFamilyRe = eval(reFamilyMatch[1]);
  } catch (e) {
    ok(false, "_WMC_REASONING_FAMILY_RE compiles as a JS regex", String(e?.message || e));
  }
}

if (reasoningFamilyRe) {
  const positive = [
    "help me plan an English essay",
    "help me draft a response to my professor",
    "help me outline a paper",
    "help me brainstorm ideas",
    "plan my essay about climate change",
    "plan an English essay",
    "plan the project roadmap",
    "plan out my study schedule for tomorrow",
    // existing verbs still anchor
    "explain the Vietnam War",
    "summarize this article",
    "compare the two approaches",
  ];
  for (const text of positive) {
    ok(reasoningFamilyRe.test(text), `'${text}' is reasoning family`,
       `text=${text}`);
  }

  // Negative: noun-only "plan" usages must not anchor.
  const negative = [
    "follow the plan",
    "the plan looks good",
    "ok let's check the plan",
    "I love this plan",
    "the checklist plan is done",
  ];
  for (const text of negative) {
    ok(!reasoningFamilyRe.test(text), `'${text}' is NOT reasoning family`,
       `text=${text}`);
  }
}

// --------------------------------------------------------------------------
// Suite B: maybePrepareWorkModeReasoning reads __reasoningGateTargetPanel
// --------------------------------------------------------------------------
section("B — lane acquisition prefers __reasoningGateTargetPanel over frozen lane");

// Slice out the maybePrepareWorkModeReasoning lane-acquisition block so we
// can grep for the new priority chain. The block lives just above the
// runOnLaneReasoningChain call.
const fnIdx = APP_JS.indexOf("async function maybePrepareWorkModeReasoning(");
ok(fnIdx > 0, "maybePrepareWorkModeReasoning function present");

// Find the lane-acquisition snippet (cheap heuristic: the chained ternary
// that calls acquireWorkModeReasoningLaneForIndex). We grab a window large
// enough to include the new priority logic.
const laneBlockStart = APP_JS.indexOf("const frozenIdx = frozenTurnLaneIndex(turnContext)", fnIdx);
ok(laneBlockStart > 0, "lane-acquisition block found inside the function");
const laneBlock = laneBlockStart > 0
  ? APP_JS.slice(laneBlockStart - 1800, laneBlockStart + 2500)
  : "";

ok(/explicitTargetLaneIdx\s*=\s*null/.test(laneBlock),
   "lane-acquisition declares explicitTargetLaneIdx (default null)",
   laneBlock.slice(0, 240));
ok(/opts\s*&&\s*opts\.__reasoningGateTargetPanel/.test(laneBlock),
   "lane-acquisition reads opts.__reasoningGateTargetPanel",
   laneBlock.slice(0, 240));
ok(/getReasoningPanelIndices\s*\(\s*\)/.test(laneBlock),
   "lane-acquisition resolves visual panel index via getReasoningPanelIndices()",
   laneBlock.slice(0, 240));
ok(/explicitTargetLaneIdx\s*!=\s*null\s*\?\s*await\s+acquireWorkModeReasoningLaneForIndex\(explicitTargetLaneIdx\)/.test(laneBlock),
   "explicit lane index wins over frozenIdx in the ternary",
   laneBlock.slice(0, 240));

// --------------------------------------------------------------------------
// Suite C: open_and_stream dispatcher threads target panel through recursion
// --------------------------------------------------------------------------
section("C — open_and_stream dispatcher forwards __reasoningGateTargetPanel");

const oasIdx = APP_JS.indexOf("function applyWorkModeReasoningOpenAndStreamPayload(");
ok(oasIdx > 0, "applyWorkModeReasoningOpenAndStreamPayload found in app.js");
const oasBlock = oasIdx > 0 ? APP_JS.slice(oasIdx, oasIdx + 12000) : "";
ok(/sendVeraWorkModeTypedInferTurn\(promptClean,\s*\{[\s\S]{0,1200}__reasoningGateTargetPanel\s*:/m.test(oasBlock),
   "open_and_stream forwards __reasoningGateTargetPanel into the recursive turn",
   oasBlock.slice(0, 400));

// --------------------------------------------------------------------------
// Suite D: sendVeraWorkModeTypedInferTurn forwards target panel to prep
// --------------------------------------------------------------------------
section("D — sendVeraWorkModeTypedInferTurn forwards target panel to prep");

const stitIdx = APP_JS.indexOf("async function sendVeraWorkModeTypedInferTurn(");
ok(stitIdx > 0, "sendVeraWorkModeTypedInferTurn found in app.js");
const stitBlock = stitIdx > 0 ? APP_JS.slice(stitIdx, stitIdx + 20000) : "";
ok(/_forwardedTargetPanel\s*=\s*Number\.isFinite\(Number\(opts\s*&&\s*opts\.__reasoningGateTargetPanel\)\)/.test(stitBlock),
   "sendVeraWorkModeTypedInferTurn reads opts.__reasoningGateTargetPanel",
   stitBlock.slice(0, 600));
ok(/maybePrepareWorkModeReasoning\([^]*?__reasoningGateTargetPanel\s*:\s*_forwardedTargetPanel/m.test(stitBlock),
   "sendVeraWorkModeTypedInferTurn forwards target panel to maybePrepareWorkModeReasoning",
   stitBlock.slice(0, 600));

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail) {
  console.log("Failures:");
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
} else {
  console.log("All multi-panel frontend smoke checks passed.");
  process.exit(0);
}
