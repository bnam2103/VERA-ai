// Duplicate reasoning stream idempotency — multi-action open_and_stream dedupe.
// Run: node tests/smoke/__reasoning_duplicate_dedup_smoke.js

"use strict";
const fs = require("fs");
const path = require("path");

const APP_JS = fs.readFileSync(path.resolve(__dirname, "../../app/app.js"), "utf8");

const FINALIZE_START = "function _usageSkipFinalizeActionApply(payload, merged)";
const FINALIZE_END = "async function applyActionPayload(data, seqCtx = {})";
const finStart = APP_JS.indexOf(FINALIZE_START);
const finEnd = APP_JS.indexOf(FINALIZE_END);
if (finStart < 0 || finEnd < 0) {
  console.error("_usageSkipFinalizeActionApply block missing");
  process.exit(2);
}
// eslint-disable-next-line no-eval
const { _usageSkipFinalizeActionApply } = eval(
  `(function() { ${APP_JS.slice(finStart, finEnd)} return { _usageSkipFinalizeActionApply }; })()`
);

const VERA_REASONING_REQUEST_DEDUPE_TTL_MS = 120000;

function cleanReasoningTaskForDedupe(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function resolveReasoningTargetPanelKey(payload) {
  if (!payload || typeof payload !== "object") return "active";
  if (payload.target_panel === "new" || payload.target_new_panel === true) return "new";
  const t1 = Number(payload.target_panel_index_1based);
  if (Number.isFinite(t1) && t1 >= 1) return `panel:${t1}`;
  const t0 = Number(payload.target_panel_index_0based);
  if (Number.isFinite(t0) && t0 >= 0) return `panel:${t0 + 1}`;
  return "active";
}

function makeReasoningRequestStableIds(payload) {
  const requestId = String(payload?.reasoning_request_id || payload?.request_id || "").trim();
  const actionId = String(payload?.action_id || "").trim();
  const actionPlanId = String(payload?.action_plan_id || "").trim();
  const plannerIdx = Number(payload?.planner_action_index);
  const parentTurnId = String(payload?.parent_turn_id || "").trim();
  return { requestId, actionId, actionPlanId, plannerIdx, parentTurnId };
}

function makeReasoningRequestDedupeKeys(payload) {
  const ids = makeReasoningRequestStableIds(payload);
  const task = cleanReasoningTaskForDedupe(payload?.prompt || payload?.content_task || "");
  const panel = resolveReasoningTargetPanelKey(payload);
  const keys = [];
  if (ids.requestId) keys.push(`req:${ids.requestId}`);
  if (ids.actionId) keys.push(`act:${ids.actionId}`);
  if (ids.actionPlanId && Number.isFinite(ids.plannerIdx)) {
    keys.push(`plan:${ids.actionPlanId}:${ids.plannerIdx}:open_and_stream`);
  }
  if (ids.parentTurnId && task) keys.push(`turn:${ids.parentTurnId}:${panel}:${task}`);
  return keys;
}

function veraReasoningRequestDedupeStore(win) {
  if (!win.__veraReasoningRequestDedupe || !(win.__veraReasoningRequestDedupe instanceof Map)) {
    win.__veraReasoningRequestDedupe = new Map();
  }
  return win.__veraReasoningRequestDedupe;
}

function shouldStartReasoningOpenAndStream(payload, win, opts = {}) {
  const allowRerun =
    opts.allowRerun === true ||
    payload?.reasoning_rerun === true ||
    payload?.reasoning_refinement === true ||
    payload?.reasoning_follow_up === true;
  if (allowRerun) return { allow: true, keys: [] };
  const store = veraReasoningRequestDedupeStore(win);
  const now = Date.now();
  for (const [k, at] of store.entries()) {
    if (now - Number(at || 0) > VERA_REASONING_REQUEST_DEDUPE_TTL_MS) store.delete(k);
  }
  const keys = makeReasoningRequestDedupeKeys(payload);
  if (!keys.length) return { allow: true, keys: [] };
  for (const key of keys) {
    if (store.has(key)) {
      return { allow: false, reason: `duplicate_key:${key}`, dedupeKey: key, keys };
    }
  }
  for (const key of keys) store.set(key, now);
  return { allow: true, keys };
}

function workModeReasoningDedupeKey(payload) {
  if (!payload || payload.panel_type !== "work_mode_reasoning") return "";
  const op = String(payload.op || "");
  if (op === "open_and_stream") {
    const ids = makeReasoningRequestStableIds(payload);
    if (ids.requestId) return `open_and_stream:req:${ids.requestId}`;
    if (ids.actionId) return `open_and_stream:act:${ids.actionId}`;
    const prompt = cleanReasoningTaskForDedupe(payload.prompt);
    const panel = resolveReasoningTargetPanelKey(payload);
    if (ids.parentTurnId && prompt) return `open_and_stream:turn:${ids.parentTurnId}:${panel}:${prompt}`;
    if (ids.actionPlanId && Number.isFinite(ids.plannerIdx)) {
      return `open_and_stream:plan:${ids.actionPlanId}:${ids.plannerIdx}`;
    }
    return "";
  }
  return "";
}

function shouldApplyWorkModeReasoningInvocation(payload, win) {
  const key = workModeReasoningDedupeKey(payload);
  if (!key) return true;
  const now = Date.now();
  const prev = win.__veraWorkModeReasoningDedupe;
  if (prev && prev.key === key && now - prev.at < 8000) return false;
  win.__veraWorkModeReasoningDedupe = { key, at: now };
  return true;
}

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

function basePayload(overrides = {}) {
  return {
    panel_type: "work_mode_reasoning",
    op: "open_and_stream",
    prompt: "explain this question",
    target_panel_index_1based: 4,
    target_panel_index_0based: 3,
    action_plan_id: "plan_abc123",
    planner_action_index: 1,
    action_id: "plan_abc123:1",
    reasoning_request_id: "plan_abc123:reasoning:1",
    request_id: "plan_abc123:reasoning:1",
    parent_turn_id: "turn_voice_001",
    explicit_panel_destination: true,
    ...overrides,
  };
}

console.log("\n-- 1. Stable dedupe keys for panel-targeted reasoning (no new_panel_request_id) --");
{
  const p = basePayload();
  const keys = makeReasoningRequestDedupeKeys(p);
  ok(keys.includes("req:plan_abc123:reasoning:1"), "request_id key present");
  ok(keys.includes("act:plan_abc123:1"), "action_id key present");
  ok(keys.includes("turn:turn_voice_001:panel:4:explain this question"), "semantic turn key present");
  const dedupeKey = workModeReasoningDedupeKey(p);
  ok(dedupeKey === "open_and_stream:req:plan_abc123:reasoning:1", `workModeReasoningDedupeKey=${dedupeKey}`);
}

console.log("\n-- 2. Duplicate payload simulation — second apply blocked --");
{
  const win = {};
  const p = basePayload();
  ok(shouldApplyWorkModeReasoningInvocation(p, win) === true, "first applyActionPayload invocation allowed");
  ok(shouldApplyWorkModeReasoningInvocation(p, win) === false, "second applyActionPayload invocation blocked");
  const first = shouldStartReasoningOpenAndStream(p, win);
  ok(first.allow === true, "first open_and_stream allowed");
  const second = shouldStartReasoningOpenAndStream(p, win);
  ok(second.allow === false, "second open_and_stream blocked");
  ok(String(second.reason || "").startsWith("duplicate_key:"), `dedupe reason=${second.reason}`);
}

console.log("\n-- 3. Same parent turn semantic dedup without request_id --");
{
  const win = {};
  const p = {
    panel_type: "work_mode_reasoning",
    op: "open_and_stream",
    prompt: "explain this question",
    target_panel_index_1based: 4,
    parent_turn_id: "turn_semantic_1",
  };
  ok(shouldStartReasoningOpenAndStream(p, win).allow === true, "first semantic stream allowed");
  ok(shouldStartReasoningOpenAndStream(p, win).allow === false, "duplicate semantic stream blocked");
}

console.log("\n-- 4. Refinement / rerun flags allow a second stream --");
{
  const win = {};
  const p = basePayload();
  shouldStartReasoningOpenAndStream(p, win);
  const rerun = shouldStartReasoningOpenAndStream({ ...p, reasoning_rerun: true }, win);
  ok(rerun.allow === true, "reasoning_rerun bypasses dedupe");
}

console.log("\n-- 5. Finalize skips when action_payloads already applied on done --");
{
  const merged = {
    action_payloads: [{ panel_type: "music_control", op: "play_builtin" }],
    action_payload: { panel_type: "work_mode_reasoning", op: "open_and_stream" },
  };
  ok(
    _usageSkipFinalizeActionApply(merged.action_payload, merged) === true,
    "finalize does not re-apply multi-action payloads"
  );
  ok(
    _usageSkipFinalizeActionApply({ panel_type: "music_control" }, { reply: "ok" }) === false,
    "single-action finalize still applies"
  );
}

console.log("\n-- 6. Regression — single explicit panel command gets stable key --");
{
  const p = basePayload({ planner_action_index: 0, action_id: "plan_x:0", reasoning_request_id: "plan_x:reasoning:0" });
  ok(workModeReasoningDedupeKey(p).includes("plan_x:reasoning:0"), "single reasoning stream key");
}

console.log("\n-- 7. New user turn (different parent_turn_id) allowed --");
{
  const win = {};
  const p1 = basePayload({ parent_turn_id: "turn_a" });
  const p2 = basePayload({
    parent_turn_id: "turn_b",
    action_plan_id: "plan_xyz789",
    action_id: "plan_xyz789:1",
    reasoning_request_id: "plan_xyz789:reasoning:1",
    request_id: "plan_xyz789:reasoning:1",
  });
  ok(shouldStartReasoningOpenAndStream(p1, win).allow === true, "turn_a stream starts");
  ok(shouldStartReasoningOpenAndStream(p2, win).allow === true, "turn_b stream allowed (explicit again)");
}

console.log(`\nTotal: ${pass + fail}  PASS=${pass}  FAIL=${fail}`);
process.exit(fail ? 1 : 0);
