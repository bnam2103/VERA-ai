// Architecture audit regression — compound routing + panel close replies.
// Run: node tests/smoke/__compound_routing_audit_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8");
const PANELS_JS = fs.readFileSync(path.resolve(__dirname, "../../workmode/panels.js"), "utf8");

const HELPER_START = "const _WMC_PANEL_FAMILY_RE =";
const HELPER_END = "try { window.detectCompoundActionFamilies";
const startIdx = APP_JS.indexOf(HELPER_START);
const endIdx = APP_JS.indexOf(HELPER_END);
if (startIdx < 0 || endIdx < 0) {
  console.error("compound detector block missing");
  process.exit(2);
}
const detectorSource = APP_JS.slice(startIdx, endIdx);

const closeReplyStart = PANELS_JS.indexOf("function buildCloseReasoningPanelsVoiceReply");
const closeReplyEnd = PANELS_JS.indexOf("function isReasoningCloseVoiceSource", closeReplyStart);
const closeReplySource = PANELS_JS.slice(closeReplyStart, closeReplyEnd);

const ctx = { module: { exports: {} }, exports: {}, console };
vm.createContext(ctx);
vm.runInContext(
  `"use strict";
  const _REASONING_PANEL_IN_RE = /\\bin\\s+(?:the\\s+)?(?:reasoning\\s+)?(?:panel|space|tab|page)\\s+(\\d+)\\b/i;
  function extractSubstantiveTopicBeforePanelPhrase(text) {
    const m = String(text || "").match(/\\b(?:explain|describe|tell\\s+me\\s+about)\\s+(.+?)\\s+in\\s+(?:the\\s+)?panel\\b/i);
    return m ? m[1].trim() : null;
  }
  ${detectorSource}
  ${closeReplySource}
  module.exports = { detectCompoundActionFamilies, buildCloseReasoningPanelsVoiceReply };
  `,
  ctx,
  { filename: "compound-routing-audit.js" }
);
const { detectCompoundActionFamilies, buildCloseReasoningPanelsVoiceReply } = ctx.module.exports;

let pass = 0;
let fail = 0;
function ok(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

console.log("\n-- Compound routing (audit scenarios) --");
const COMPOUND = [
  "Can you unpause the music and explain the Vietnam War in panel 3?",
  "unpause the music and explain the Vietnam War in panel 3",
  "Can you unpause the music, help me do this homework in this panel, and start a 10 minute timer?",
  "Can you remove stat homework and pause the music?",
  "Can you remove milk and eggs and play lofi",
];
for (const text of COMPOUND) {
  const r = detectCompoundActionFamilies(text);
  ok(r.isCompound === true, `compound: ${text.slice(0, 70)}`, JSON.stringify(r));
}

console.log("\n-- Single reasoning with explicit panel stays non-compound when alone --");
{
  const r = detectCompoundActionFamilies("explain the Vietnam War in panel 3");
  ok(r.isCompound === false, "single panel+reasoning collapses to reasoning-only", JSON.stringify(r));
}

console.log("\n-- Panel close reply out of range --");
{
  const reply = buildCloseReasoningPanelsVoiceReply(
    { ok: false, failureReason: "all_indices_out_of_range", totalBefore: 3 },
    { closeScope: "specific_indices", indices: [4] }
  );
  ok(reply === "I don't see a panel 4.", `reply="${reply}"`);
}

console.log(`\nTotal: ${pass + fail}  PASS=${pass}  FAIL=${fail}`);
process.exit(fail ? 1 : 0);
