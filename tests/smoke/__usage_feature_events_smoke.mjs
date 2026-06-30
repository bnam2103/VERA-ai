/**
 * Smoke: usageFeatureEvents.js Phase 2 feature interaction analytics.
 * Run: node tests/smoke/__usage_feature_events_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0;
let failed = 0;

const PRIVACY_KEYS = [
  "transcript",
  "text",
  "message",
  "content",
  "checklist_item",
  "song",
  "playlist_name",
  "uri",
  "panel_content",
  "title",
  "query",
  "prompt",
];

function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL ${msg}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function assertNoPrivacyKeys(props, label) {
  if (!props || typeof props !== "object") return;
  for (const k of PRIVACY_KEYS) {
    ok(!(k in props), `${label}: no ${k} in event_props`);
  }
}

const sessionStore = new Map();

function createDocument(domState) {
  return {
    body: {
      classList: {
        contains(cls) {
          if (cls === "vera-mode") return domState.veraMode;
          if (cls === "bmo-open") return domState.bmoOpen;
          if (cls === "app-open") return domState.appOpen;
          return false;
        },
      },
    },
    visibilityState: "visible",
    getElementById(id) {
      if (id === "vera-app") {
        return {
          hidden: domState.veraHidden,
          classList: {
            contains: (c) => c === "work-mode" && domState.workMode,
          },
        };
      }
      return null;
    },
    addEventListener() {},
  };
}

function makeSandbox() {
  const fetchBodies = [];
  const domState = { veraMode: true, bmoOpen: false, appOpen: true, workMode: true, veraHidden: false };
  const sandbox = {
    window: {},
    document: createDocument(domState),
    navigator: { sendBeacon: () => true },
    sessionStorage: {
      getItem: (k) => sessionStore.get(k) ?? null,
      setItem: (k, v) => sessionStorage.set(k, String(v)),
    },
    performance: { now: () => 1000 },
    getSessionId: () => "sess-feature-usage",
    authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
    authFetch: async (_url, init) => {
      fetchBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, id: "ue-f" }) };
    },
    getSupabaseAccessToken: async () => null,
    isSupabaseUserAuthenticated: () => false,
    isVeraWorkModeOn: () => domState.workMode,
    veraIsChatStateHydrating: () => false,
    crypto: { randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    setInterval: () => 1,
    clearInterval: () => {},
    console,
    _fetchBodies: fetchBodies,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = sandbox.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(root, "users/usageEvents.js"), "utf8"), sandbox);
  vm.runInContext(readFileSync(path.join(root, "users/usageFeatureEvents.js"), "utf8"), sandbox);
  return sandbox;
}

function bodiesOfType(sb, type) {
  return sb._fetchBodies.filter((b) => b.event_type === type);
}

async function main() {
  section("action_executed dedupe");
  sessionStore.clear();
  const sb = makeSandbox();
  const payload = {
    panel_type: "news_panel_ui",
    op: "open",
    action_plan_id: "plan-1",
    title: "secret title",
    query: "secret query",
  };
  sb.veraUsageOnActionExecuted(payload, { requestId: "req-a", orderIndex: 0, source: "done" });
  sb.veraUsageOnActionExecuted(payload, { requestId: "req-a", orderIndex: 0, source: "meta" });
  ok(bodiesOfType(sb, "action_executed").length === 1, "action_executed emits once after dedupe key");
  const actionBody = bodiesOfType(sb, "action_executed")[0];
  ok(actionBody.client_event_id, "action_executed has client_event_id");
  assertNoPrivacyKeys(actionBody.event_props, "action_executed");

  section("multi-action plan + steps");
  sessionStore.clear();
  const sbMulti = makeSandbox();
  const steps = [
    { panel_type: "music_control", op: "skip_next", action_plan_id: "mp-1" },
    { panel_type: "music_control", op: "volume_delta", delta: 5, action_plan_id: "mp-1" },
  ];
  sbMulti.veraUsageOnMultiActionPlanStart(steps, {
    actionPlanId: "mp-1",
    requestId: "req-mp",
    source: "multi_action",
  });
  steps.forEach((p, i) => {
    sbMulti.veraUsageOnMultiActionStep(p, { orderIndex: i, actionPlanId: "mp-1", source: "multi_action" });
  });
  ok(bodiesOfType(sbMulti, "multi_action_plan_executed").length === 1, "one plan event");
  ok(bodiesOfType(sbMulti, "multi_action_step_executed").length === 2, "one step event per unique step");

  section("music transport dedupe in sequence");
  sessionStore.clear();
  const sbMusic = makeSandbox();
  const musicPayload = { panel_type: "music_control", op: "skip_next", action_plan_id: "ms-1" };
  const meta = { orderIndex: 1, actionPlanId: "ms-1", source: "multi_action", requestId: "req-ms" };
  sbMusic.veraUsageOnMusicControlApplied(musicPayload, meta, { op: "skip_next", transportProvider: "spotify" });
  sbMusic.veraUsageOnMusicControlApplied(musicPayload, meta, { op: "skip_next", transportProvider: "spotify" });
  ok(bodiesOfType(sbMusic, "music_transport_used").length === 1, "music skip emits once");
  ok(bodiesOfType(sbMusic, "action_executed").length === 1, "action_executed once for skip");

  section("checklist voice action_executed dedupe");
  sessionStore.clear();
  const sbClDedupe = makeSandbox();
  const checklistPayload = {
    panel_type: "checklist_control",
    op: "checklist.add_item",
    action_plan_id: "plan-cl",
  };
  sbClDedupe.veraUsageOnChecklistMutation({
    op: "sync",
    item_count: 2,
    batch_size: 2,
    source: "voice",
    client_key: "req-cl",
  });
  sbClDedupe.veraUsageOnActionExecuted(checklistPayload, { requestId: "req-cl", source: "done" });
  sbClDedupe.veraUsageOnActionExecuted(
    { ...checklistPayload, planner_action_index: 0 },
    { requestId: "req-cl", orderIndex: 0, source: "done" }
  );
  ok(bodiesOfType(sbClDedupe, "checklist_batch_action_executed").length === 1, "checklist_batch once");
  ok(bodiesOfType(sbClDedupe, "action_executed").length === 1, "checklist action_executed once");
  const clAction = bodiesOfType(sbClDedupe, "action_executed")[0];
  ok(clAction?.event_props?.planner_action_index === 0, "action_executed keeps planner_action_index");
  ok(
    !sbClDedupe._fetchBodies.some(
      (b) => b.event_type === "action_executed" && String(b.client_event_id || "").includes(":-1:")
    ),
    "no action_executed with -1 planner index in client_event_id"
  );
  ok(
    !sbClDedupe._fetchBodies.some(
      (b) =>
        b.event_type === "action_executed" &&
        String(b.client_event_id || "").endsWith(":checklist.control:checklist.add_item") &&
        !String(b.client_event_id || "").includes(":0:")
    ),
    "no unindexed checklist action_executed row"
  );

  section("checklist batch metadata only");
  sessionStore.clear();
  const sbCl = makeSandbox();
  sbCl.veraUsageOnChecklistMutation({
    op: "add",
    item_count: 3,
    batch_size: 3,
    source: "voice",
    client_key: "batch-1",
    checklist_item: "buy milk",
    text: "buy milk",
  });
  const addEvt = bodiesOfType(sbCl, "checklist_item_added")[0];
  ok(addEvt?.event_props?.item_count === 3, "checklist item_count stored");
  ok(!("text" in (addEvt?.event_props || {})), "checklist item text stripped");
  ok(!("checklist_item" in (addEvt?.event_props || {})), "checklist_item key stripped");

  section("reasoning panel lifecycle");
  sessionStore.clear();
  const sbRp = makeSandbox();
  sbRp.veraUsageOnReasoningPanelOpened({
    lane_id: "lane-abc",
    panel_index: 2,
    source: "ui",
    request_id: "open-req-1",
  });
  sbRp.veraUsageOnReasoningPanelFocused({
    lane_id: "lane-abc",
    panel_index: 2,
    source: "ui",
  });
  sbRp.veraUsageOnReasoningPanelMessageSent({
    lane_id: "lane-abc",
    panel_index: 2,
    request_id: "turn-99",
    input_chars: 42,
    message: "user secret",
  });
  sbRp.veraUsageOnReasoningPanelReplyDone({
    lane_id: "lane-abc",
    panel_index: 2,
    request_id: "turn-99",
    latency_ms: 1200,
    response_chars: 800,
    content: "assistant secret",
  });
  sbRp.veraUsageOnReasoningPanelClosed({ lane_id: "lane-abc", closed_count: 1, source: "ui" });
  ok(bodiesOfType(sbRp, "reasoning_panel_opened").length === 1, "reasoning_panel_opened");
  ok(bodiesOfType(sbRp, "reasoning_panel_focused").length === 1, "reasoning_panel_focused");
  ok(bodiesOfType(sbRp, "reasoning_panel_message_sent").length === 1, "reasoning_panel_message_sent");
  ok(bodiesOfType(sbRp, "reasoning_panel_reply_done").length === 1, "reasoning_panel_reply_done");
  ok(bodiesOfType(sbRp, "reasoning_panel_closed").length === 1, "reasoning_panel_closed");
  for (const b of sbRp._fetchBodies) {
    assertNoPrivacyKeys(b.event_props, b.event_type);
  }
  const msgEvt = bodiesOfType(sbRp, "reasoning_panel_message_sent")[0];
  ok(msgEvt?.event_props?.input_chars === 42, "input_chars numeric only");

  section("interrupt lifecycle without transcript");
  sessionStore.clear();
  const sbInt = makeSandbox();
  sbInt.veraUsageOnInterruptQa("INTERRUPT_CANDIDATE", "whisper_sustain", {
    interruptAttemptId: "int-1",
    asrMode: "whisper",
    gate: "whisper_sustain",
    transcript: "stop playing music",
    text: "stop playing music",
  });
  sbInt.veraUsageOnInterruptQa("INTERRUPT_CANDIDATE_PIPELINE_ENTER", "handleInterruptUtterance", {
    interruptAttemptId: "int-1",
    asrMode: "whisper",
  });
  sbInt.veraUsageOnInterruptQa("INTERRUPT_REJECTED", "low_word_count", {
    interruptAttemptId: "int-1",
    rejectReason: "low_word_count",
    transcript: "uh",
  });
  sbInt.veraUsageOnInterruptQa("INTERRUPT_REJECTED_CLEANUP_DONE", null, {
    interruptAttemptId: "int-1",
  });
  const candidate = bodiesOfType(sbInt, "interrupt_candidate_detected")[0];
  ok(candidate?.event_props?.gate === "whisper_sustain", "candidate has gate");
  ok(!("reject_reason" in (candidate?.event_props || {})), "candidate has no reject_reason");
  ok(!("confirm_reason" in (candidate?.event_props || {})), "candidate has no confirm_reason");
  const submitted = bodiesOfType(sbInt, "interrupt_candidate_submitted")[0];
  ok(submitted?.event_props?.asr_mode === "whisper", "submitted has asr_mode");
  ok(!("reject_reason" in (submitted?.event_props || {})), "submitted has no reject_reason");
  ok(!("confirm_reason" in (submitted?.event_props || {})), "submitted has no confirm_reason");
  const rejected = bodiesOfType(sbInt, "interrupt_rejected")[0];
  ok(rejected?.event_props?.reject_reason === "low_word_count", "interrupt reject_reason kept");
  ok(!("transcript" in (rejected?.event_props || {})), "transcript not stored");
  ok(bodiesOfType(sbInt, "interrupt_cleanup_done").length === 1, "interrupt_cleanup_done");

  section("privacy sweep all feature events");
  sessionStore.clear();
  const sbAll = makeSandbox();
  sbAll.veraUsageOnMusicControlApplied(
    { panel_type: "music_control", op: "play_track", title: "Song", uri: "spotify:track:x" },
    { orderIndex: 0, source: "voice" },
    { op: "play_track", targetProvider: "spotify" }
  );
  for (const b of sbAll._fetchBodies) {
    assertNoPrivacyKeys(b.event_props, b.event_type);
  }

  section("summary");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

await main();
