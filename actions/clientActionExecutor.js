/* =========================================================================
 *  actions/clientActionExecutor.js — client-only allowlisted action executor
 *
 *  Runs typed action plans sequentially without /infer. Used by Sandbox
 *  Commands (Phase 0+) and reusable for other deterministic client plans.
 *
 *  Load order — AFTER sandbox/sandboxCommands.js and app-side helpers when
 *  wired in production; executor resolves handlers from ctx.deps first.
 * ========================================================================= */

/** @type {ReadonlySet<string>} */
const CLIENT_ACTION_ALLOWLIST = new Set([
  "work_mode.open",
  "voice.say",
  "music.play",
  "music.play_builtin",
  "timer.set",
  "checklist.add",
  "panel.open_new",
  "panel.switch",
]);

function logClientActionDebug(tag, payload) {
  try {
    console.info(`[sandbox_routine_${tag}]`, payload || {});
  } catch (_) {}
}

function _resolveDeps(ctx) {
  const injected = ctx && typeof ctx.deps === "object" && ctx.deps ? ctx.deps : {};
  const w = typeof window !== "undefined" ? window : {};
  return {
    setVeraWorkMode:
      injected.setVeraWorkMode ||
      (typeof w.setVeraWorkMode === "function" ? w.setVeraWorkMode.bind(w) : null),
    applyActionPayload:
      injected.applyActionPayload ||
      (typeof applyActionPayload === "function" ? applyActionPayload : null),
    applyWorkModeTimerPayload:
      injected.applyWorkModeTimerPayload ||
      (typeof applyWorkModeTimerPayload === "function" ? applyWorkModeTimerPayload : null),
    addReasoningTab:
      injected.addReasoningTab ||
      (typeof addReasoningTab === "function" ? addReasoningTab : null),
    activateReasoningTab:
      injected.activateReasoningTab ||
      (typeof activateReasoningTab === "function" ? activateReasoningTab : null),
    commitChecklistAdd:
      injected.commitChecklistAdd ||
      (typeof commitWorkChecklistFromPlaceholderText === "function"
        ? commitWorkChecklistFromPlaceholderText
        : null),
    speakText: injected.speakText || null,
    nowMs: typeof injected.nowMs === "function" ? injected.nowMs : () => Date.now(),
    generateTimerId:
      typeof injected.generateTimerId === "function"
        ? injected.generateTimerId
        : () => `sandbox_timer_${Date.now().toString(36)}`,
  };
}

/**
 * @param {Record<string, unknown>} action
 * @param {Record<string, unknown>} ctx
 * @param {ReturnType<typeof _resolveDeps>} deps
 * @returns {Promise<{ ok: boolean, error?: string, detail?: Record<string, unknown> }>}
 */
async function dispatchClientAction(action, ctx, deps) {
  const type = String(action?.type || "").trim();
  const payload = action?.payload && typeof action.payload === "object" ? action.payload : {};

  switch (type) {
    case "work_mode.open": {
      if (typeof deps.setVeraWorkMode !== "function") {
        return { ok: false, error: "setVeraWorkMode_unavailable" };
      }
      deps.setVeraWorkMode(true);
      return { ok: true };
    }

    case "voice.say": {
      const text = String(payload.text || "").trim();
      if (!text) return { ok: false, error: "voice_say_empty_text" };
      if (typeof deps.speakText === "function") {
        await Promise.resolve(deps.speakText(text, ctx));
      }
      return { ok: true, detail: { text } };
    }

    case "music.play": {
      const query = String(payload.query || "").trim();
      if (!query) return { ok: false, error: "music_play_missing_query" };
      if (typeof deps.applyActionPayload !== "function") {
        return { ok: false, error: "applyActionPayload_unavailable" };
      }
      await Promise.resolve(
        deps.applyActionPayload({
          action_payload: {
            panel_type: "music_control",
            op: "play",
            query,
            source: "sandbox_routine",
          },
          type: "sandbox_routine",
        })
      );
      return { ok: true, detail: { query } };
    }

    case "music.play_builtin": {
      const playlistId = String(payload.playlist_id || "").trim();
      const soundId = String(payload.sound_id || "").trim();
      if (!playlistId && !soundId) {
        return { ok: false, error: "music_play_builtin_missing_target" };
      }
      if (typeof deps.applyActionPayload !== "function") {
        return { ok: false, error: "applyActionPayload_unavailable" };
      }
      await Promise.resolve(
        deps.applyActionPayload({
          action_payload: {
            panel_type: "music_control",
            op: "play_builtin",
            playlist_id: playlistId,
            sound_id: soundId,
            source: "sandbox_routine",
          },
          type: "sandbox_routine",
        })
      );
      return { ok: true, detail: { playlist_id: playlistId || null, sound_id: soundId || null } };
    }

    case "timer.set": {
      const durationSeconds = Math.floor(Number(payload.duration_seconds));
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return { ok: false, error: "timer_set_invalid_duration" };
      }
      if (typeof deps.applyWorkModeTimerPayload !== "function") {
        return { ok: false, error: "applyWorkModeTimerPayload_unavailable" };
      }
      const fireAt = deps.nowMs() + durationSeconds * 1000;
      deps.applyWorkModeTimerPayload({
        id: deps.generateTimerId(),
        duration_seconds: durationSeconds,
        fire_at_epoch_ms: fireAt,
        message: String(payload.message || "Your timer is up.").trim(),
      });
      return { ok: true, detail: { duration_seconds: durationSeconds, fire_at_epoch_ms: fireAt } };
    }

    case "checklist.add": {
      const text = String(payload.text || "").trim();
      if (!text) return { ok: false, error: "checklist_add_missing_text" };
      if (typeof deps.commitChecklistAdd === "function") {
        const added = deps.commitChecklistAdd(text);
        if (!added) return { ok: false, error: "checklist_add_failed" };
        return { ok: true, detail: { text } };
      }
      if (typeof deps.applyActionPayload === "function") {
        await Promise.resolve(
          deps.applyActionPayload({
            action_payload: {
              panel_type: "checklist_control",
              op: "add",
              payload_mode: "append_item",
              text,
              source: "sandbox_routine",
            },
            type: "sandbox_routine",
          })
        );
        return { ok: true, detail: { text, via: "applyActionPayload" } };
      }
      return { ok: false, error: "checklist_add_unavailable" };
    }

    case "panel.open_new": {
      if (typeof deps.addReasoningTab !== "function") {
        return { ok: false, error: "addReasoningTab_unavailable" };
      }
      deps.addReasoningTab({ source: "sandbox_routine" });
      return { ok: true };
    }

    case "panel.switch": {
      const panelIndex = Math.floor(Number(payload.panel_index));
      if (!Number.isFinite(panelIndex) || panelIndex < 1) {
        return { ok: false, error: "panel_switch_invalid_index" };
      }
      if (typeof deps.activateReasoningTab !== "function") {
        return { ok: false, error: "activateReasoningTab_unavailable" };
      }
      deps.activateReasoningTab(panelIndex - 1, {
        commandText: "",
        requestedIndex: panelIndex,
        resolvedFrom: "sandbox_routine",
      });
      return { ok: true, detail: { panel_index: panelIndex } };
    }

    default:
      return { ok: false, error: "action_not_allowed" };
  }
}

/**
 * Execute a client-only action plan sequentially. Independent actions continue
 * after failures.
 *
 * @param {Record<string, unknown>} plan
 * @param {Record<string, unknown>} [ctx]
 * @returns {Promise<{ ok: boolean, results: Array<Record<string, unknown>>, successes: number, failures: number }>}
 */
async function executeClientActionPlan(plan, ctx = {}) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const routineId = String(plan?.routine_id || plan?.source_id || "unknown");
  const deps = _resolveDeps(ctx);
  const results = [];
  let successes = 0;
  let failures = 0;

  logClientActionDebug("execute_start", {
    routine_id: routineId,
    action_count: actions.length,
    source: plan?.source || null,
  });

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const actionType = String(action?.type || "").trim();
    if (!CLIENT_ACTION_ALLOWLIST.has(actionType)) {
      const blocked = {
        id: action?.id || null,
        type: actionType,
        ok: false,
        error: "action_not_allowed",
        index,
      };
      results.push(blocked);
      failures += 1;
      logClientActionDebug("action_done", {
        action_type: actionType,
        success: false,
        error: blocked.error,
        index,
      });
      continue;
    }

    logClientActionDebug("action_start", {
      action_type: actionType,
      index,
      routine_id: routineId,
    });

    let result;
    try {
      result = await dispatchClientAction(action, ctx, deps);
    } catch (err) {
      result = {
        ok: false,
        error: String(err?.message || err || "executor_exception").slice(0, 200),
      };
    }

    const entry = {
      id: action?.id || null,
      type: actionType,
      ok: result?.ok === true,
      error: result?.ok ? null : result?.error || "unknown_error",
      detail: result?.detail || null,
      index,
    };
    results.push(entry);
    if (entry.ok) successes += 1;
    else failures += 1;

    logClientActionDebug("action_done", {
      action_type: actionType,
      success: entry.ok,
      error: entry.error,
      index,
    });
  }

  logClientActionDebug("execute_done", {
    routine_id: routineId,
    successes,
    failures,
    action_count: actions.length,
  });

  return {
    ok: failures === 0,
    results,
    successes,
    failures,
  };
}

if (typeof window !== "undefined") {
  window.CLIENT_ACTION_ALLOWLIST = CLIENT_ACTION_ALLOWLIST;
  window.executeClientActionPlan = executeClientActionPlan;
  window.dispatchClientAction = dispatchClientAction;
}
