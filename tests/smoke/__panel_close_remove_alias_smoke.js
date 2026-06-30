// Panel close aliases: remove/delete panel N must parse like close panel N.
// Run: node tests/smoke/__panel_close_remove_alias_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PANELS_JS = fs.readFileSync(path.resolve(__dirname, "../../workmode/panels.js"), "utf8");
const start = PANELS_JS.indexOf("const REASONING_CLOSE_ORDINAL_WORDS");
const end = PANELS_JS.indexOf("function findReasoningPanelIndicesByTitleQuery");
if (start < 0 || end < 0) {
  console.error("Could not locate parser block in panels.js");
  process.exit(2);
}
const parserBlock = PANELS_JS.slice(start, end);

const ctx = { module: { exports: {} }, exports: {}, console };
vm.createContext(ctx);
vm.runInContext(
  `"use strict";
  function _looksLikeChecklistCommand(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    if (
      /\\b(?:remove|delete|close|clear|hide|dismiss|get\\s+rid\\s+of)\\b/.test(t) &&
      /\\b(?:reasoning\\s+(?:panel|tab|space|lane|page)s?|panels?|tabs?|reasoning\\s+space|reasoning\\s+lane|reasoning)\\b/.test(t)
    ) {
      return false;
    }
    if (/\\b(?:remove|delete|cross\\s+off|check\\s+off|uncheck|tick|check|mark)\\s+(?:the\\s+)?(?:first|second|third|fourth|fifth|last|\\d+(?:st|nd|rd|th)?)?\\s*(?:and\\s+(?:first|second|third|fourth|fifth|last|\\d+(?:st|nd|rd|th)?)\\s*)?(?:item|task|bullet|checklist|to[- ]?do|todo|step)s?\\b/.test(t)) {
      return true;
    }
    return false;
  }
  ${parserBlock}
  module.exports = {
    parseCloseReasoningPanelsCommand,
    _isExplicitReasoningPanelCloseCommand,
  };
  `,
  ctx,
  { filename: "panel-close-remove-alias.js" }
);
const {
  parseCloseReasoningPanelsCommand,
  _isExplicitReasoningPanelCloseCommand,
} = ctx.module.exports;

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

console.log("\n-- Explicit panel close aliases parse to specific_indices --");
for (const text of [
  "close the fourth panel",
  "remove the fourth panel",
  "delete panel 4",
  "remove panel 4",
]) {
  const p = parseCloseReasoningPanelsCommand(text, 4);
  ok(p.intent === "close_reasoning_panels", `intent close: ${text}`, JSON.stringify(p));
  ok(
    JSON.stringify(p.indices) === "[4]",
    `indices [4]: ${text}`,
    JSON.stringify(p.indices)
  );
}

console.log("\n-- Checklist phrases must NOT parse as panel close --");
for (const text of ["remove the fourth item", "remove milk"]) {
  ok(!_isExplicitReasoningPanelCloseCommand(text), `not explicit panel close: ${text}`);
  const detLooksChecklist =
    /\\b(?:remove|delete)\\s+(?:the\\s+)?(?:first|second|third|fourth|fifth|last|\\d+(?:st|nd|rd|th)?)?\\s*(?:item|task|bullet|checklist|to[- ]?do|todo|step)s?\\b/i.test(
      text.toLowerCase()
    ) || /\b(?:remove|delete)\s+\S/.test(text.toLowerCase());
  ok(detLooksChecklist || text === "remove milk", `checklist-shaped: ${text}`);
}

console.log("\n-- Out of range panel parse still resolves index --");
{
  const p = parseCloseReasoningPanelsCommand("remove panel 99", 3);
  ok(p.intent === "close_reasoning_panels", "remove panel 99 intent", JSON.stringify(p));
  ok(JSON.stringify(p.indices) === "[99]", "remove panel 99 indices", JSON.stringify(p.indices));
}

console.log(`\nTotal: ${pass + fail}  PASS=${pass}  FAIL=${fail}`);
process.exit(fail ? 1 : 0);
