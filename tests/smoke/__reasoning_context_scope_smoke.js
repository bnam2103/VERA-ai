// Smoke for Work Mode reasoning context scoping (explicit panel + deictic policy).
//
// Run:  node tests/smoke/__reasoning_context_scope_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS_PATH = path.resolve(__dirname, "../../app/app.js");
const APP_JS = fs.readFileSync(APP_JS_PATH, "utf8").replace(/\r\n/g, "\n");

const SCOPE_START = "/** Voice UI → Reasoning Panel context handoff (Phase 1, 2026-06-15). */";
const SCOPE_END = "function buildVoiceToPanelContextPacket(opts = {}) {";

const scopeStartIdx = APP_JS.indexOf(SCOPE_START);
const scopeEndIdx = APP_JS.indexOf(SCOPE_END);

if (scopeStartIdx < 0 || scopeEndIdx < 0) {
  console.error("Could not locate context-scope helpers in app.js");
  process.exit(2);
}

const scopeSource = APP_JS.slice(scopeStartIdx, scopeEndIdx);

const TABLE_PRIOR =
  "From the attached image, compare the two counts in the table. Which row has the larger if part?";

const sandboxSource = `
"use strict";
let workModeLastSubstantiveUserText = "";
let mockVoiceTurns = [];
let mockActiveLaneId = "lane-panel-4";

function workModeVisibleLaneHasCompletedSolution() {
  return false;
}
function getActiveDomReasoningLaneId() {
  return mockActiveLaneId;
}
function topicTokensForWorkModeTopic(text) {
  const raw = String(text || "")
    .toLowerCase()
    .match(/[a-z][a-z0-9']{2,}/g);
  return raw ? raw.filter((w) => w.length > 2) : [];
}
const WORK_MODE_TOPIC_STOPWORDS = new Set(["the", "and", "for", "that", "this", "with", "from", "about"]);
function topicSimilarityScore(aText, bText) {
  const a = new Set(topicTokensForWorkModeTopic(aText));
  const b = new Set(topicTokensForWorkModeTopic(bText));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = new Set([...a, ...b]);
  return union.size ? inter / union.size : 0;
}
function topicCoverageScore(needleText, hayText) {
  const needle = new Set(topicTokensForWorkModeTopic(needleText));
  const hay = new Set(topicTokensForWorkModeTopic(hayText));
  if (!needle.size || !hay.size) return 0;
  let hit = 0;
  for (const x of needle) if (hay.has(x)) hit += 1;
  return hit / needle.size;
}
function detectNewDeliverableIntent(text) {
  const low = String(text || "").toLowerCase();
  return {
    detected: /\\b(?:explain|describe|write about|tell me about)\\b/i.test(low),
  };
}
function extractSubstantiveTopicBeforePanelPhrase(text) {
  const s = String(text || "").trim();
  const m = s.match(/\\bin\\s+panel\\s+(\\d+)\\s*$/i);
  if (!m) return "";
  const before = s.slice(0, m.index).trim().replace(/[?,;.]+\\s*$/u, "").trim();
  return before.length >= 8 ? before : "";
}

${scopeSource}

function collectRecentVoiceTurnPairs(maxPairs) {
  const n = Number(maxPairs) > 0 ? Number(maxPairs) : 3;
  return mockVoiceTurns.slice(0, n);
}

module.exports = {
  buildReasoningContextScope,
  shouldIncludeVoiceContextForPanel,
  shouldBlockLanePriorContextForScope,
  setPriorTopic(t) { workModeLastSubstantiveUserText = t; },
  setVoiceTurns(turns) { mockVoiceTurns = turns; },
  setActiveLane(id) { mockActiveLaneId = id; },
};
`;

const moduleStub = { exports: {} };
const ctx = { module: moduleStub, exports: moduleStub.exports, console };
vm.createContext(ctx);
vm.runInContext(sandboxSource, ctx, { filename: "reasoning-context-scope-helpers.js" });
const G = moduleStub.exports;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YEL = "\x1b[33m";
const RST = "\x1b[0m";
let pass = 0;
let fail = 0;
const failed = [];
function section(label) {
  console.log(`\n${YEL}-- ${label} --${RST}`);
}
function ok(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ${GREEN}PASS${RST}  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  ${RED}FAIL${RST}  ${name}`);
    if (detail) console.log(`         ${String(detail).slice(0, 600)}`);
  }
}

G.setPriorTopic(TABLE_PRIOR);
G.setVoiceTurns([{ role: "user", content: TABLE_PRIOR }]);
G.setActiveLane("lane-panel-4");

section("A — keyboard explicit target, non-deictic (tennis / panel 3)");
{
  const scope = G.buildReasoningContextScope({
    userText: "can you explain tennis in panel 3?",
    inputSource: "keyboard",
    explicitPanelTarget: 3,
    targetLaneId: "lane-panel-3",
    activeLaneId: "lane-panel-4",
  });
  ok(scope.explicit_panel_target === true, "A explicit panel target");
  ok(scope.is_deictic === false, "A not deictic");
  ok(scope.is_fresh_topic === true, "A fresh topic");
  ok(scope.block_voice_context === true, "A blocks voice context");
  const policy = G.shouldIncludeVoiceContextForPanel({
    cleanedPanelTask: "explain tennis",
    userText: "explain tennis",
    topicAnchor: TABLE_PRIOR,
    mainExcerpt: "",
    visible: "",
    inputSource: "keyboard",
    explicitPanelTarget: 3,
    contextScope: scope,
  });
  ok(policy.include === false, "A no voice context injection", policy.reasons);
}

section("B — keyboard explicit target, active panel different (photosynthesis / panel 2)");
{
  const scope = G.buildReasoningContextScope({
    userText: "explain photosynthesis in panel 2",
    inputSource: "keyboard",
    explicitPanelTarget: 2,
    targetLaneId: "lane-panel-2",
    activeLaneId: "lane-panel-4",
  });
  ok(scope.target_panel === 2, "B target panel 2");
  ok(scope.block_voice_context === true, "B blocks unrelated voice");
  const laneBlock = G.shouldBlockLanePriorContextForScope(
    scope,
    "table-reading question about counts",
    "",
    "explain photosynthesis"
  );
  ok(laneBlock.block === true, "B blocks unrelated lane body on fresh topic");
}

section("C — keyboard explicit target, deictic (this question / panel 3)");
{
  const scope = G.buildReasoningContextScope({
    userText: "explain this question in panel 3",
    inputSource: "keyboard",
    explicitPanelTarget: 3,
    targetLaneId: "lane-panel-3",
    activeLaneId: "lane-panel-4",
  });
  ok(scope.is_deictic === true, "C deictic detected");
  ok(scope.block_voice_context === false, "C allows voice context");
  const policy = G.shouldIncludeVoiceContextForPanel({
    cleanedPanelTask: "explain this question",
    userText: "explain this question",
    topicAnchor: TABLE_PRIOR,
    mainExcerpt: "",
    visible: "",
    inputSource: "keyboard",
    explicitPanelTarget: 3,
    contextScope: scope,
  });
  ok(policy.include === true, "C may include voice context", policy.reasons);
}

section("D — voice explicit target, deictic (write that / panel 4)");
{
  const scope = G.buildReasoningContextScope({
    userText: "write that in panel 4",
    inputSource: "voice",
    explicitPanelTarget: 4,
    targetLaneId: "lane-panel-4",
    activeLaneId: "lane-panel-4",
  });
  ok(scope.is_deictic === true, "D deictic");
  ok(scope.block_voice_context === false, "D allows voice context");
  const policy = G.shouldIncludeVoiceContextForPanel({
    cleanedPanelTask: "write that",
    userText: "write that in panel 4",
    topicAnchor: TABLE_PRIOR,
    mainExcerpt: "",
    visible: "",
    inputSource: "voice",
    explicitPanelTarget: 4,
    contextScope: scope,
  });
  ok(policy.include === true, "D includes prior voice context", policy.reasons);
}

section("E — voice explicit target, non-deictic (tennis / panel 3)");
{
  const scope = G.buildReasoningContextScope({
    userText: "explain tennis in panel 3",
    inputSource: "voice",
    explicitPanelTarget: 3,
    targetLaneId: "lane-panel-3",
    activeLaneId: "lane-panel-4",
  });
  ok(scope.block_voice_context === true, "E blocks unrelated voice on fresh explicit topic");
  const policy = G.shouldIncludeVoiceContextForPanel({
    cleanedPanelTask: "explain tennis",
    userText: "explain tennis",
    topicAnchor: TABLE_PRIOR,
    mainExcerpt: "",
    visible: "",
    inputSource: "voice",
    explicitPanelTarget: 3,
    contextScope: scope,
  });
  ok(policy.include === false, "E no unrelated prior voice context", policy.reasons);
}

section("F — no explicit target, deictic follow-up");
{
  const scope = G.buildReasoningContextScope({
    userText: "explain it more simply",
    inputSource: "keyboard",
    targetLaneId: "lane-panel-4",
    activeLaneId: "lane-panel-4",
  });
  ok(scope.explicit_panel_target === false, "F no explicit panel");
  ok(scope.is_deictic === true, "F deictic it");
  ok(scope.block_voice_context === false, "F allows recent context");
  const policy = G.shouldIncludeVoiceContextForPanel({
    cleanedPanelTask: "explain it more simply",
    userText: "explain it more simply",
    topicAnchor: TABLE_PRIOR,
    mainExcerpt: "prior panel answer about the table",
    visible: "prior panel answer about the table",
    inputSource: "keyboard",
    contextScope: scope,
  });
  ok(policy.include === true, "F includes context via deictic follow-up", policy.reasons);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
