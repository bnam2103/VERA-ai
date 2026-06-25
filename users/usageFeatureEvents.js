/**
 * users/usageFeatureEvents.js — Phase 2 behavioral feature events (metadata only).
 * Load AFTER users/usageEvents.js, BEFORE app.js.
 */
(function () {
  "use strict";

  const FEATURE_DEDUPE_PREFIX = "vera_usage_feature_dedupe:";
  const _memoryDedupe = new Set();
  const PRIVACY_FORBIDDEN = new Set([
    "text",
    "transcript",
    "reply",
    "audio",
    "content",
    "message",
    "body",
    "note",
    "title",
    "query",
    "playlist_name",
    "song",
    "lyrics",
    "checklist_item",
    "panel_content",
    "markdown",
    "uri",
    "prompt",
    "user_input",
    "assistant_response",
  ]);

  function sanitizeFeatureProps(props) {
    if (!props || typeof props !== "object") return {};
    const out = {};
    for (const [rawKey, rawVal] of Object.entries(props)) {
      const key = String(rawKey || "").trim().toLowerCase();
      if (!key || PRIVACY_FORBIDDEN.has(key)) continue;
      if (
        typeof rawVal === "boolean" ||
        typeof rawVal === "number" ||
        typeof rawVal === "string"
      ) {
        out[key] = rawVal;
      }
    }
    return out;
  }

  function newClientEventId() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (_) {}
    return `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function shouldDedupe(clientEventId) {
    const id = String(clientEventId || "").trim();
    if (!id) return false;
    if (_memoryDedupe.has(id)) return true;
    const key = FEATURE_DEDUPE_PREFIX + id;
    try {
      if (sessionStorage.getItem(key) === "1") {
        _memoryDedupe.add(id);
        return true;
      }
      sessionStorage.setItem(key, "1");
    } catch (_) {}
    _memoryDedupe.add(id);
    return false;
  }

  function emitFeatureEvent(eventType, props, clientEventId) {
    if (typeof trackUsageEvent !== "function") return;
    const cid = String(clientEventId || newClientEventId()).trim().slice(0, 128);
    if (shouldDedupe(cid)) return;
    trackUsageEvent(eventType, sanitizeFeatureProps(props), { clientEventId: cid });
  }

  function categorizePayload(payload) {
    const panelType = String(payload?.panel_type || "").trim();
    const op = String(payload?.op || "").trim();
    if (panelType === "music_control") {
      return { action_type: `music.${op || "unknown"}`, action_category: "music", op, panel_type: panelType };
    }
    if (panelType === "work_mode_reasoning") {
      return { action_type: `reasoning.${op || "unknown"}`, action_category: "reasoning", op, panel_type: panelType };
    }
    if (panelType === "checklist_control") {
      return { action_type: "checklist.control", action_category: "checklist", op: op || "mutate", panel_type: panelType };
    }
    if (panelType === "news_panel_ui") {
      return { action_type: `news_panel.${op || "open"}`, action_category: "news", op, panel_type: panelType };
    }
    return {
      action_type: panelType || op || "unknown",
      action_category: panelType ? "panel" : "action",
      op,
      panel_type: panelType || undefined,
    };
  }

  function plannerActionIndexForEvent(payload, meta) {
    const m = meta && typeof meta === "object" ? meta : {};
    if (Number.isFinite(Number(m.orderIndex))) return Number(m.orderIndex);
    if (Number.isFinite(Number(payload?.planner_action_index))) {
      return Number(payload.planner_action_index);
    }
    return undefined;
  }

  function actionClientEventId(payload, meta) {
    const m = meta && typeof meta === "object" ? meta : {};
    const planId = String(payload?.action_plan_id || m.actionPlanId || "").trim();
    const reqId = String(m.requestId || payload?.request_id || "").trim();
    const idx = plannerActionIndexForEvent(payload, meta);
    const idxSeg = idx != null ? String(idx) : "";
    const cat = categorizePayload(payload);
    return `action:${reqId}:${planId}:${idxSeg}:${cat.action_type}:${cat.op}`;
  }

  function musicPlayKind(op) {
    if (op === "play_builtin") return "builtin";
    if (op === "play_album") return "album";
    if (op === "play_playlist_by_name" || op === "play_playlist_scoped") return "playlist";
    if (op === "play_track") return "track";
    return "unknown";
  }

  function musicTransportOp(op, payload) {
    if (op === "skip_next") return "skip_next";
    if (op === "skip_previous") return "skip_previous";
    if (op === "pause") return "pause";
    if (op === "resume") return "resume";
    if (op === "volume_delta") {
      const d = Number(payload?.delta) || 0;
      if (d > 0) return "volume_up";
      if (d < 0) return "volume_down";
      return "volume_delta";
    }
    if (op === "play_track" || op === "play_builtin" || op === "play_album" || op === "play_playlist_by_name" || op === "play_playlist_scoped") {
      return "play";
    }
    return op || "unknown";
  }

  function veraUsageOnActionExecuted(payload, meta, extra) {
    if (!payload || typeof payload !== "object") return;
    const m = meta && typeof meta === "object" ? meta : {};
    const e = extra && typeof extra === "object" ? extra : {};
    const cat = categorizePayload(payload);
    const plannerIdx = plannerActionIndexForEvent(payload, m);
    if (payload.panel_type === "checklist_control" && plannerIdx == null) {
      return;
    }
    emitFeatureEvent(
      e.success === false ? "action_failed" : "action_executed",
      {
        ...cat,
        action_plan_id: String(payload.action_plan_id || m.actionPlanId || "").slice(0, 64) || undefined,
        planner_action_index: plannerIdx,
        source: String(m.source || "unknown").slice(0, 32),
        success: e.success !== false,
        error_code: e.error_code ? String(e.error_code).slice(0, 64) : undefined,
      },
      actionClientEventId(payload, m)
    );
  }

  function veraUsageOnMusicControlApplied(payload, meta, applyResult) {
    if (!payload || payload.panel_type !== "music_control") return;
    const m = meta && typeof meta === "object" ? meta : {};
    const op = String(payload.op || "");
    const provider = String(
      applyResult?.targetProvider || applyResult?.transportProvider || "unknown"
    ).slice(0, 32);
    const transportOp = musicTransportOp(op, payload);
    const playKind = musicPlayKind(op);
    const planId = String(payload.action_plan_id || m.actionPlanId || "").slice(0, 64);
    const stepIndex = Number.isFinite(Number(m.orderIndex)) ? Number(m.orderIndex) : undefined;
    const source = String(m.source || "unknown").slice(0, 32);
    const baseId = `music:${planId}:${stepIndex}:${op}:${provider}:${transportOp}`;

    veraUsageOnActionExecuted(payload, m, { success: true });

    if (["skip_next", "skip_previous", "pause", "resume", "volume_delta"].includes(op)) {
      emitFeatureEvent(
        "music_transport_used",
        { provider, transport_op: transportOp, play_kind: playKind, source, action_plan_id: planId || undefined, step_index: stepIndex },
        `${baseId}:transport`
      );
      return;
    }

    if (op.startsWith("play_")) {
      emitFeatureEvent(
        "music_action_executed",
        { provider, transport_op: transportOp, play_kind: playKind, source, action_plan_id: planId || undefined, step_index: stepIndex },
        `${baseId}:action`
      );
      emitFeatureEvent(
        "music_play_started",
        { provider, play_kind: playKind, source, action_plan_id: planId || undefined, step_index: stepIndex },
        `${baseId}:play_start`
      );
    } else {
      emitFeatureEvent(
        "music_action_executed",
        { provider, transport_op: transportOp, play_kind: playKind, source, action_plan_id: planId || undefined, step_index: stepIndex },
        `${baseId}:action`
      );
    }
  }

  function veraUsageOnMusicProviderSwitched(fromProvider, toProvider, meta) {
    const m = meta && typeof meta === "object" ? meta : {};
    emitFeatureEvent(
      "music_provider_switched",
      {
        from_provider: String(fromProvider || "none").slice(0, 32),
        to_provider: String(toProvider || "none").slice(0, 32),
        source: String(m.source || "unknown").slice(0, 32),
      },
      `music_provider:${fromProvider}:${toProvider}:${m.requestId || ""}`
    );
  }

  function veraUsageOnMultiActionPlanStart(payloads, meta) {
    const m = meta && typeof meta === "object" ? meta : {};
    const planId = String(m.actionPlanId || m.requestId || "plan").slice(0, 64);
    emitFeatureEvent(
      "multi_action_plan_executed",
      {
        action_plan_id: planId,
        step_count: Array.isArray(payloads) ? payloads.length : 0,
        source: String(m.source || "multi_action").slice(0, 32),
        success: true,
      },
      `multi_plan:${planId}:start`
    );
  }

  function veraUsageOnMultiActionStep(payload, meta, extra) {
    const m = meta && typeof meta === "object" ? meta : {};
    const e = extra && typeof extra === "object" ? extra : {};
    const cat = categorizePayload(payload);
    const planId = String(payload?.action_plan_id || m.actionPlanId || "").slice(0, 64);
    const stepIndex = Number.isFinite(Number(m.orderIndex)) ? Number(m.orderIndex) : undefined;
    emitFeatureEvent(
      "multi_action_step_executed",
      {
        action_plan_id: planId || undefined,
        step_index: stepIndex,
        action_type: cat.action_type,
        action_category: cat.action_category,
        source: String(m.source || "multi_action").slice(0, 32),
        success: e.success !== false,
        error_code: e.error_code ? String(e.error_code).slice(0, 64) : undefined,
      },
      `multi_step:${planId}:${stepIndex}:${cat.action_type}`
    );
  }

  function veraUsageOnActionSequenceFailed(meta, errorCode) {
    const m = meta && typeof meta === "object" ? meta : {};
    const planId = String(m.actionPlanId || m.requestId || "").slice(0, 64);
    emitFeatureEvent(
      "action_sequence_failed",
      {
        action_plan_id: planId || undefined,
        failed_step_index: Number.isFinite(Number(m.failedStepIndex)) ? Number(m.failedStepIndex) : undefined,
        source: String(m.source || "multi_action").slice(0, 32),
        success: false,
        error_code: String(errorCode || "sequence_failed").slice(0, 64),
      },
      `multi_fail:${planId}:${m.failedStepIndex}`
    );
  }

  function veraUsageOnMusicSequenceExecuted(payloads, meta) {
    const m = meta && typeof meta === "object" ? meta : {};
    const planId = String(m.actionPlanId || m.requestId || "").slice(0, 64);
    emitFeatureEvent(
      "music_sequence_executed",
      {
        action_plan_id: planId || undefined,
        step_count: Array.isArray(payloads) ? payloads.length : 0,
        source: String(m.source || "multi_action").slice(0, 32),
        success: true,
      },
      `music_seq:${planId}`
    );
  }

  function veraUsageOnChecklistMutation(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const op = String(o.op || "mutate").slice(0, 32);
    const eventMap = {
      add: "checklist_item_added",
      complete: "checklist_item_completed",
      uncomplete: "checklist_item_completed",
      delete: "checklist_item_deleted",
      sync: "checklist_batch_action_executed",
    };
    const eventType = eventMap[op] || "checklist_batch_action_executed";
    if (op === "sync_start") {
      emitFeatureEvent(
        "checklist_sync_started",
        {
          sync_kind: String(o.sync_kind || "unknown").slice(0, 32),
          item_count: Number(o.item_count) || 0,
          source: String(o.source || "ui").slice(0, 32),
          success: true,
        },
        `checklist_sync_start:${o.sync_kind}:${Date.now()}`
      );
      return;
    }
    if (op === "sync_done") {
      emitFeatureEvent(
        o.success === false ? "checklist_sync_failed" : "checklist_sync_completed",
        {
          sync_kind: String(o.sync_kind || "unknown").slice(0, 32),
          item_count: Number(o.item_count) || 0,
          batch_size: Number(o.batch_size) || undefined,
          source: String(o.source || "ui").slice(0, 32),
          success: o.success !== false,
          error_code: o.error_code ? String(o.error_code).slice(0, 64) : undefined,
        },
        `checklist_sync_done:${o.sync_kind}:${o.client_key || ""}`
      );
      return;
    }
    emitFeatureEvent(
      eventType,
      {
        op,
        item_count: Number(o.item_count) || 1,
        batch_size: Number(o.batch_size) || undefined,
        source: String(o.source || "ui").slice(0, 32),
        sync_kind: o.sync_kind ? String(o.sync_kind).slice(0, 32) : undefined,
        success: o.success !== false,
        error_code: o.error_code ? String(o.error_code).slice(0, 64) : undefined,
      },
      `checklist:${op}:${o.client_key || o.item_count || ""}`
    );
  }

  let _lastReasoningFocusAt = 0;
  let _lastReasoningFocusLane = "";

  function veraUsageOnReasoningPanelOpened(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const laneId = String(o.lane_id || "").slice(0, 64);
    emitFeatureEvent(
      "reasoning_panel_opened",
      {
        lane_id: laneId || undefined,
        panel_index: Number.isFinite(Number(o.panel_index)) ? Number(o.panel_index) : undefined,
        source: String(o.source || "ui").slice(0, 32),
        success: true,
      },
      `reasoning_open:${laneId}:${o.panel_open_request_id || o.request_id || ""}`
    );
  }

  function veraUsageOnReasoningPanelClosed(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    emitFeatureEvent(
      "reasoning_panel_closed",
      {
        lane_id: String(o.lane_id || "").slice(0, 64) || undefined,
        panel_index: Number.isFinite(Number(o.panel_index)) ? Number(o.panel_index) : undefined,
        source: String(o.source || "ui").slice(0, 32),
        success: true,
      },
      `reasoning_close:${o.lane_id || ""}:${o.closed_count || 1}`
    );
  }

  function veraUsageOnReasoningPanelFocused(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const laneId = String(o.lane_id || "");
    const now = performance.now();
    if (laneId && laneId === _lastReasoningFocusLane && now - _lastReasoningFocusAt < 300) return;
    _lastReasoningFocusLane = laneId;
    _lastReasoningFocusAt = now;
    emitFeatureEvent(
      "reasoning_panel_focused",
      {
        lane_id: laneId.slice(0, 64) || undefined,
        panel_index: Number.isFinite(Number(o.panel_index)) ? Number(o.panel_index) : undefined,
        from_panel_index: Number.isFinite(Number(o.from_panel_index)) ? Number(o.from_panel_index) : undefined,
        source: String(o.source || "ui").slice(0, 32),
        success: true,
      },
      `reasoning_focus:${laneId}:${o.panel_index}`
    );
  }

  function veraUsageOnReasoningPanelMessageSent(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const rid = String(o.request_id || "").trim();
    emitFeatureEvent(
      "reasoning_panel_message_sent",
      {
        lane_id: String(o.lane_id || "").slice(0, 64) || undefined,
        panel_index: Number.isFinite(Number(o.panel_index)) ? Number(o.panel_index) : undefined,
        source: String(o.source || "reasoning").slice(0, 32),
        input_chars: Number(o.input_chars) || 0,
        success: true,
      },
      rid ? `reasoning_msg:${rid}` : `reasoning_msg:${o.lane_id}:${Date.now()}`
    );
  }

  function veraUsageOnReasoningPanelReplyDone(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const rid = String(o.request_id || "").trim();
    emitFeatureEvent(
      "reasoning_panel_reply_done",
      {
        lane_id: String(o.lane_id || "").slice(0, 64) || undefined,
        panel_index: Number.isFinite(Number(o.panel_index)) ? Number(o.panel_index) : undefined,
        source: String(o.source || "reasoning").slice(0, 32),
        latency_ms: Number.isFinite(Number(o.latency_ms)) ? Number(o.latency_ms) : undefined,
        response_chars: Number.isFinite(Number(o.response_chars)) ? Number(o.response_chars) : undefined,
        success: o.success !== false,
        error_code: o.error_code ? String(o.error_code).slice(0, 64) : undefined,
      },
      rid ? `reasoning_done:${rid}` : `reasoning_done:${o.lane_id}`
    );
  }

  function veraUsageOnInterruptQa(stage, detail, fields) {
    const s = String(stage || "");
    const f = fields && typeof fields === "object" ? fields : {};
    const attemptId = String(f.interruptAttemptId || f.interrupt_attempt_id || "").slice(0, 64);
    const asrMode = f.asrMode || f.asr_mode;
    const gate = f.gate;
    const source = f.source || "voice";

    if (s === "INTERRUPT_CANDIDATE") {
      emitFeatureEvent(
        "interrupt_candidate_detected",
        sanitizeFeatureProps({
          asr_mode: asrMode,
          gate,
          interrupt_attempt_id: attemptId || undefined,
          source,
        }),
        `interrupt:${attemptId}:candidate`
      );
      return;
    }
    if (s === "INTERRUPT_CANDIDATE_SUBMITTED_TO_WHISPER" || s === "INTERRUPT_CANDIDATE_PIPELINE_ENTER") {
      emitFeatureEvent(
        "interrupt_candidate_submitted",
        sanitizeFeatureProps({
          asr_mode: asrMode,
          interrupt_attempt_id: attemptId || undefined,
          source,
        }),
        `interrupt:${attemptId}:submitted`
      );
      return;
    }
    if (s === "INTERRUPT_CONFIRMED") {
      emitFeatureEvent(
        "interrupt_confirmed",
        sanitizeFeatureProps({
          asr_mode: asrMode,
          gate,
          confirm_reason: f.confirmReason || f.confirm_reason || detail,
          interrupt_attempt_id: attemptId || undefined,
          source,
          success: true,
        }),
        `interrupt:${attemptId}:confirmed`
      );
      return;
    }
    if (s === "INTERRUPT_REJECTED") {
      emitFeatureEvent(
        "interrupt_rejected",
        sanitizeFeatureProps({
          asr_mode: asrMode,
          gate,
          reject_reason: f.rejectReason || f.reject_reason || detail,
          interrupt_attempt_id: attemptId || undefined,
          source,
          success: false,
          word_count: Number.isFinite(Number(f.word_count)) ? Number(f.word_count) : undefined,
        }),
        `interrupt:${attemptId}:rejected:${detail || ""}`
      );
      return;
    }
    if (s === "INTERRUPT_REJECTED_CLEANUP_DONE") {
      emitFeatureEvent(
        "interrupt_cleanup_done",
        sanitizeFeatureProps({
          asr_mode: asrMode,
          interrupt_attempt_id: attemptId || undefined,
          source,
          success: true,
        }),
        `interrupt:${attemptId}:cleanup`
      );
    }
  }

  try {
    if (typeof window !== "undefined") {
      window.veraUsageOnActionExecuted = veraUsageOnActionExecuted;
      window.veraUsageOnMusicControlApplied = veraUsageOnMusicControlApplied;
      window.veraUsageOnMusicProviderSwitched = veraUsageOnMusicProviderSwitched;
      window.veraUsageOnMultiActionPlanStart = veraUsageOnMultiActionPlanStart;
      window.veraUsageOnMultiActionStep = veraUsageOnMultiActionStep;
      window.veraUsageOnActionSequenceFailed = veraUsageOnActionSequenceFailed;
      window.veraUsageOnMusicSequenceExecuted = veraUsageOnMusicSequenceExecuted;
      window.veraUsageOnChecklistMutation = veraUsageOnChecklistMutation;
      window.veraUsageOnReasoningPanelOpened = veraUsageOnReasoningPanelOpened;
      window.veraUsageOnReasoningPanelClosed = veraUsageOnReasoningPanelClosed;
      window.veraUsageOnReasoningPanelFocused = veraUsageOnReasoningPanelFocused;
      window.veraUsageOnReasoningPanelMessageSent = veraUsageOnReasoningPanelMessageSent;
      window.veraUsageOnReasoningPanelReplyDone = veraUsageOnReasoningPanelReplyDone;
      window.veraUsageOnInterruptQa = veraUsageOnInterruptQa;
      window.__veraUsageSanitizeFeatureProps = sanitizeFeatureProps;
      window.__veraUsageEmitFeatureEvent = emitFeatureEvent;
    }
  } catch (_) {}
})();
