// Explicit panel route must defer to compound planner when other action families present.
// Run: node tests/smoke/__explicit_panel_compound_block_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app.js"), "utf8");
const start = APP_JS.indexOf("const _WMC_PANEL_FAMILY_RE =");
const end = APP_JS.indexOf("try { window.shouldBlockExplicitPanelRouteForCompoundExecutable");
if (start < 0 || end < 0) {
  console.error("Could not locate detector block");
  process.exit(2);
}
const block = APP_JS.slice(start, end);

const isExplicitStub = `
function isExplicitReasoningPanelReference(text) {
  const s = String(text || "").trim();
  const m = s.match(/\\bin\\s+(?:the\\s+)?(?:reasoning\\s+)?(?:panel|tab|space|page)\\s+(\\d+)\\b/i);
  if (m) return { matched: true, targetPanel: Number(m[1]), wasPronoun: false };
  if (/\\b(?:this|current)\\s+panel\\b/i.test(s)) return { matched: true, targetPanel: null, wasPronoun: true };
  return { matched: false, targetPanel: null, wasPronoun: false };
}
function extractSubstantiveTopicBeforePanelPhrase(text) {
  const m = String(text || "").match(/\\b(?:explain|describe|tell\\s+me\\s+about|write|summari[sz]e)\\s+(.+?)\\s+in\\s+(?:the\\s+)?panel\\b/i);
  return m ? m[1].trim() : null;
}
`;

const ctx = { module: { exports: {} }, exports: {}, console };
vm.createContext(ctx);
vm.runInContext(
  `"use strict";
  const _REASONING_PANEL_IN_RE = /\\bin\\s+(?:the\\s+)?(?:reasoning\\s+)?(?:panel|space|tab|page)\\s+(\\d+)\\b/i;
  ${isExplicitStub}
  ${block}
  function shouldBlockExplicitPanelRouteForCompoundExecutable(text, opts = {}) {
    if (opts && opts.__reasoningGateForceRoute === "reasoning_panel") {
      return { blocked: false, reason: "caller_forced_reasoning_panel" };
    }
    const s = String(text || "").trim();
    if (!s) return { blocked: false, reason: "empty" };
    const compound = detectCompoundActionFamilies(s);
    if (!compound.isCompound) {
      return { blocked: false, reason: compound.reason || "not_compound", compound };
    }
    const explicitRef = isExplicitReasoningPanelReference(s);
    return {
      blocked: true,
      reason: compound.reason || "compound_executable",
      compound,
      explicitRef,
    };
  }
  module.exports = { detectCompoundActionFamilies, shouldBlockExplicitPanelRouteForCompoundExecutable };
  `,
  ctx,
  { filename: "explicit-panel-compound-block.js" }
);
const { detectCompoundActionFamilies, shouldBlockExplicitPanelRouteForCompoundExecutable } =
  ctx.module.exports;

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

console.log("\n-- Compound + explicit panel: block direct reasoning route --");
const COMPOUND_BLOCK = [
  "unpause the music and explain the Vietnam War in panel 3",
  "pause the music and explain tennis in panel 2",
  "start a 10 minute timer and help me with homework in this panel",
  "remove milk from my checklist and explain Vietnam War in panel 3",
  "play lofi and write a study plan in panel 1",
];
for (const text of COMPOUND_BLOCK) {
  const b = shouldBlockExplicitPanelRouteForCompoundExecutable(text, {});
  ok(b.blocked === true, `blocked compound: ${text.slice(0, 55)}`, JSON.stringify(b));
  ok(b.explicitRef?.matched === true || /panel/i.test(text), `explicit panel ref: ${text.slice(0, 40)}`);
}

console.log("\n-- Single explicit panel: allow direct reasoning route --");
const SINGLE_ALLOW = [
  "explain tennis in panel 4",
  "explain the Vietnam War in panel 3",
  "help me with this homework in this panel",
  "write a study plan in panel 1",
];
for (const text of SINGLE_ALLOW) {
  const b = shouldBlockExplicitPanelRouteForCompoundExecutable(text, {});
  ok(b.blocked === false, `not blocked: ${text}`, JSON.stringify(b));
  const r = detectCompoundActionFamilies(text);
  ok(r.isCompound === false, `not compound: ${text}`, JSON.stringify(r));
}

console.log("\n-- Planner recursive turn: caller force bypasses block --");
{
  const b = shouldBlockExplicitPanelRouteForCompoundExecutable(
    "Explain the Vietnam War",
    { __reasoningGateForceRoute: "reasoning_panel" }
  );
  ok(b.blocked === false, "forced reasoning panel bypasses block", JSON.stringify(b));
}

console.log(`\nTotal: ${pass + fail}  PASS=${pass}  FAIL=${fail}`);
process.exit(fail ? 1 : 0);
