// Implicit checklist mutation routing — no literal "checklist" required.
// Run: node tests/smoke/__implicit_checklist_routing_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CHECKLIST_JS = fs.readFileSync(path.resolve(__dirname, "../../workmode/checklist.js"), "utf8");
const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8");

const blockStart = CHECKLIST_JS.indexOf("const CHECKLIST_IMPLICIT_BLOCK_RES");
const blockEnd = CHECKLIST_JS.indexOf("try { window.detectImplicitChecklistMutation");
const implicitBlock = CHECKLIST_JS.slice(blockStart, blockEnd);

const compoundStart = APP_JS.indexOf("const _WMC_PANEL_FAMILY_RE =");
const compoundEnd = APP_JS.indexOf("try { window.detectCompoundActionFamilies");
const compoundBlock = APP_JS.slice(compoundStart, compoundEnd);

const ctx = { window: {}, module: { exports: {} }, exports: {}, console };
vm.createContext(ctx);
vm.runInContext(
  `"use strict";
  const CHECKLIST_NOUN_RE = /\\b(?:checklist|check\\s+list|to-?do(?:\\s+list)?|item|items|task|tasks)\\b/i;
  const CHECKLIST_NON_OBJECT_NOUN_RE = /\\b(?:paragraph|sentence|argument|example|essay|panel|timer|volume|minute|minutes|detail|evidence)\\b/i;
  const CHECKLIST_UNCOMPLETE_VERB_RE = /\\b(?:uncheck|undo\\s+complete|mark\\b.*\\bincomplete\\b)/i;
  ${implicitBlock}
  function isLikelyWorkChecklistEditIntent(text) {
    const implicit = detectImplicitChecklistMutation(text);
    return Boolean(implicit?.detected && implicit.count >= 1);
  }
  ${compoundBlock}
  module.exports = {
    detectImplicitChecklistMutation,
    isLikelyWorkChecklistEditIntent,
    detectCompoundActionFamilies,
  };
  `,
  ctx,
  { filename: "implicit-checklist-routing.js" }
);

const { detectImplicitChecklistMutation, isLikelyWorkChecklistEditIntent, detectCompoundActionFamilies } =
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

console.log("\n-- 1. Compound add + mark without checklist word --");
{
  const text = "can you add stat homework and mark milk and eggs complete?";
  const implicit = detectImplicitChecklistMutation(text);
  ok(implicit.detected === true, "implicit mutation detected");
  ok(implicit.count === 2, `mutation count=${implicit.count}`);
  ok(isLikelyWorkChecklistEditIntent(text) === true, "reasoning gate skips checklist edit");
  const compound = detectCompoundActionFamilies(text);
  ok(compound.isCompound === true, "compound defers to backend planner");
}

console.log("\n-- 2. Explicit checklist wording still works --");
{
  const text =
    "can you add stat homework and mark milk and eggs complete in the checklist?";
  ok(detectImplicitChecklistMutation(text).detected === true, "implicit still detected");
  ok(isLikelyWorkChecklistEditIntent(text) === true, "checklist edit intent");
}

console.log("\n-- 3-5. Single implicit mutations --");
ok(detectImplicitChecklistMutation("add milk and eggs").detected === true, "add milk and eggs");
ok(
  detectImplicitChecklistMutation("mark milk and eggs complete").detected === true,
  "mark milk and eggs complete"
);
ok(detectImplicitChecklistMutation("remove milk and eggs").detected === true, "remove milk and eggs");

console.log("\n-- 6-10. Negative routing guards --");
ok(detectImplicitChecklistMutation("add 3 minutes to the timer").detected === false, "timer extend");
ok(detectImplicitChecklistMutation("remove panel 4").detected === false, "panel close");
ok(
  detectImplicitChecklistMutation("add more detail to the explanation").detected === false,
  "reasoning refinement add detail"
);
ok(
  detectImplicitChecklistMutation("add evidence to my essay in panel 3").detected === false,
  "panel reasoning add evidence"
);
ok(detectImplicitChecklistMutation("complete this explanation").detected === false, "complete explanation");

console.log(`\nTotal: ${pass + fail}  PASS=${pass}  FAIL=${fail}`);
process.exit(fail ? 1 : 0);
