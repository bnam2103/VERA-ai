/* =========================================================================
 *  sandbox/sandboxCommands.js — Sandbox Commands / Custom Routines (Phase 0)
 *
 *  Experimental user-defined trigger phrases that compile into client action
 *  plans. localStorage-only; exact normalized full-utterance matching.
 *
 *  Load order — AFTER utils/storage.js, BEFORE actions/clientActionExecutor.js
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="sandbox/sandboxCommands.js?v=1"></script>
 *      <script src="actions/clientActionExecutor.js?v=1"></script>
 * ========================================================================= */

const SANDBOX_LS_ENABLED_KEY = "vera_sandbox_commands_enabled_v1";
const SANDBOX_LS_ROUTINES_KEY = "vera_sandbox_routines_v1";
const SANDBOX_SCHEMA_VERSION = 1;
const SANDBOX_MAX_ROUTINES = 20;
const SANDBOX_MAX_ACTIONS_PER_ROUTINE = 8;
const SANDBOX_MIN_TRIGGER_WORDS = 3;
const SANDBOX_MIN_TRIGGER_CHARS = 12;
const SANDBOX_VOICE_SAY_MAX_CHARS = 200;
const SANDBOX_CHECKLIST_TEXT_MAX_CHARS = 500;
const SANDBOX_MUSIC_QUERY_MAX_CHARS = 240;
const SANDBOX_TIMER_MAX_SECONDS = 86400 * 14;
const SANDBOX_PANEL_INDEX_MAX = 20;

/** @type {ReadonlySet<string>} */
const SANDBOX_ALLOWED_ACTION_TYPES = new Set([
  "work_mode.open",
  "voice.say",
  "music.play",
  "music.play_builtin",
  "timer.set",
  "checklist.add",
  "panel.open_new",
  "panel.switch",
]);

/** @type {ReadonlySet<string>} */
const SANDBOX_BUILTIN_IDS = new Set([
  "lofi_mix",
  "white_noise",
  "rain_sound",
  "brown_noise",
]);

/**
 * Normalized core command phrases that must not be used as sandbox triggers.
 * Matching is word-boundary aware via normalized substring checks.
 * @type {readonly string[]}
 */
const SANDBOX_CORE_COMMAND_BLOCKLIST = [
  "play music",
  "start timer",
  "set a timer",
  "open settings",
  "help",
  "stop",
  "cancel timer",
  "stop timer",
  "sync the plan",
  "open work mode",
  "close panel",
  "log out",
  "sign out",
];

function logSandboxDebug(tag, payload) {
  try {
    console.info(`[sandbox_${tag}]`, payload || {});
  } catch (_) {}
}

/**
 * Same normalization contract as app.js normalizeConversationalCheck.
 * @param {string} text
 * @returns {string}
 */
function normalizeSandboxTrigger(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _wordCount(normalized) {
  if (!normalized) return 0;
  return normalized.split(" ").filter(Boolean).length;
}

function _safeGetJson(key, fallback) {
  if (typeof safeGetJsonLocalStorage === "function") {
    return safeGetJsonLocalStorage(key, fallback);
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === "") return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function _safeSetJson(key, value) {
  if (typeof safeSetJsonLocalStorage === "function") {
    return safeSetJsonLocalStorage(key, value);
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

function _safeGetFlag(key) {
  if (typeof safeGetLocalStorage === "function") {
    return safeGetLocalStorage(key, "0");
  }
  try {
    return localStorage.getItem(key) || "0";
  } catch (_) {
    return "0";
  }
}

function _safeSetFlag(key, on) {
  const val = on ? "1" : "0";
  if (typeof safeSetLocalStorage === "function") {
    return safeSetLocalStorage(key, val);
  }
  try {
    localStorage.setItem(key, val);
    return true;
  } catch (_) {
    return false;
  }
}

function isSandboxCommandsEnabled() {
  return _safeGetFlag(SANDBOX_LS_ENABLED_KEY) === "1";
}

function setSandboxCommandsEnabled(on) {
  return _safeSetFlag(SANDBOX_LS_ENABLED_KEY, Boolean(on));
}

/**
 * @returns {Array<Record<string, unknown>>}
 */
function loadSandboxRoutines() {
  const raw = _safeGetJson(SANDBOX_LS_ROUTINES_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * @param {Array<Record<string, unknown>>} routines
 * @returns {boolean}
 */
function saveSandboxRoutines(routines) {
  return _safeSetJson(SANDBOX_LS_ROUTINES_KEY, Array.isArray(routines) ? routines : []);
}

function createSandboxRoutineId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `routine_${Date.now().toString(36)}_${rand}`;
}

/**
 * @param {Record<string, unknown>} partial
 * @returns {Record<string, unknown>}
 */
function createSandboxRoutine(partial = {}) {
  const now = new Date().toISOString();
  return {
    id: String(partial.id || createSandboxRoutineId()),
    enabled: partial.enabled !== false,
    name: String(partial.name || "").trim(),
    trigger: String(partial.trigger || "").trim(),
    match_mode: "exact",
    created_at: partial.created_at || now,
    updated_at: partial.updated_at || now,
    actions: Array.isArray(partial.actions) ? partial.actions.slice() : [],
  };
}

/**
 * @param {string} normalized
 * @returns {boolean}
 */
function sandboxTriggerOverlapsCoreCommand(normalized) {
  const n = normalizeSandboxTrigger(normalized);
  if (!n) return false;
  for (const blocked of SANDBOX_CORE_COMMAND_BLOCKLIST) {
    const b = normalizeSandboxTrigger(blocked);
    if (!b) continue;
    if (n === b) return true;
    if (n.includes(` ${b} `) || n.startsWith(`${b} `) || n.endsWith(` ${b}`)) return true;
  }
  return false;
}

/**
 * @param {string} trigger
 * @param {{ excludeRoutineId?: string, routines?: Array<Record<string, unknown>> }} [opts]
 * @returns {{ ok: boolean, reason?: string, normalized?: string }}
 */
function validateSandboxTrigger(trigger, opts = {}) {
  const normalized = normalizeSandboxTrigger(trigger);
  if (!normalized) {
    return { ok: false, reason: "empty_trigger" };
  }
  const words = _wordCount(normalized);
  if (words < SANDBOX_MIN_TRIGGER_WORDS && normalized.length < SANDBOX_MIN_TRIGGER_CHARS) {
    return {
      ok: false,
      reason: "trigger_too_short",
      normalized,
    };
  }
  if (sandboxTriggerOverlapsCoreCommand(normalized)) {
    return { ok: false, reason: "core_command_overlap", normalized };
  }
  const routines = Array.isArray(opts.routines) ? opts.routines : loadSandboxRoutines();
  const excludeId = opts.excludeRoutineId ? String(opts.excludeRoutineId) : "";
  for (const routine of routines) {
    if (!routine || typeof routine !== "object") continue;
    if (excludeId && String(routine.id || "") === excludeId) continue;
    const otherNorm = normalizeSandboxTrigger(routine.trigger);
    if (otherNorm && otherNorm === normalized) {
      return { ok: false, reason: "duplicate_trigger", normalized, duplicateRoutineId: routine.id };
    }
  }
  return { ok: true, normalized };
}

/**
 * @param {Record<string, unknown>} action
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateSandboxAction(action) {
  if (!action || typeof action !== "object") {
    return { ok: false, reason: "invalid_action" };
  }
  const type = String(action.type || "").trim();
  if (!SANDBOX_ALLOWED_ACTION_TYPES.has(type)) {
    return { ok: false, reason: "action_not_allowed" };
  }

  switch (type) {
    case "work_mode.open":
    case "panel.open_new":
      return { ok: true };

    case "voice.say": {
      const text = String(action.text || "").trim();
      if (!text) return { ok: false, reason: "voice_say_missing_text" };
      if (text.length > SANDBOX_VOICE_SAY_MAX_CHARS) {
        return { ok: false, reason: "voice_say_text_too_long" };
      }
      return { ok: true };
    }

    case "music.play": {
      const query = String(action.query || "").trim();
      if (!query) return { ok: false, reason: "music_play_missing_query" };
      if (query.length > SANDBOX_MUSIC_QUERY_MAX_CHARS) {
        return { ok: false, reason: "music_play_query_too_long" };
      }
      return { ok: true };
    }

    case "music.play_builtin": {
      const builtinId = normalizeSandboxTrigger(String(action.builtin_id || action.playlist_id || action.sound_id || ""))
        .replace(/\s+/g, "_");
      if (!builtinId) return { ok: false, reason: "music_play_builtin_missing_id" };
      if (!SANDBOX_BUILTIN_IDS.has(builtinId)) {
        return { ok: false, reason: "music_play_builtin_unknown_id" };
      }
      return { ok: true };
    }

    case "timer.set": {
      const seconds = Number(action.duration_seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, reason: "timer_set_invalid_duration" };
      }
      if (seconds > SANDBOX_TIMER_MAX_SECONDS) {
        return { ok: false, reason: "timer_set_duration_too_long" };
      }
      return { ok: true };
    }

    case "checklist.add": {
      const text = String(action.text || "").trim();
      if (!text) return { ok: false, reason: "checklist_add_missing_text" };
      if (text.length > SANDBOX_CHECKLIST_TEXT_MAX_CHARS) {
        return { ok: false, reason: "checklist_add_text_too_long" };
      }
      return { ok: true };
    }

    case "panel.switch": {
      const panelIndex = Number(action.panel_index);
      if (!Number.isFinite(panelIndex) || panelIndex < 1 || panelIndex > SANDBOX_PANEL_INDEX_MAX) {
        return { ok: false, reason: "panel_switch_invalid_index" };
      }
      return { ok: true };
    }

    default:
      return { ok: false, reason: "action_not_allowed" };
  }
}

/**
 * @param {Record<string, unknown>} routine
 * @param {{ excludeRoutineId?: string, routines?: Array<Record<string, unknown>> }} [opts]
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function validateSandboxRoutine(routine, opts = {}) {
  const reasons = [];
  if (!routine || typeof routine !== "object") {
    return { ok: false, reasons: ["invalid_routine"] };
  }
  if (!String(routine.id || "").trim()) {
    reasons.push("missing_id");
  }
  const triggerCheck = validateSandboxTrigger(routine.trigger, {
    excludeRoutineId: opts.excludeRoutineId || routine.id,
    routines: opts.routines,
  });
  if (!triggerCheck.ok) {
    reasons.push(triggerCheck.reason || "invalid_trigger");
  }
  const actions = Array.isArray(routine.actions) ? routine.actions : [];
  if (actions.length < 1) {
    reasons.push("no_actions");
  }
  if (actions.length > SANDBOX_MAX_ACTIONS_PER_ROUTINE) {
    reasons.push("too_many_actions");
  }
  for (let i = 0; i < actions.length; i += 1) {
    const check = validateSandboxAction(actions[i]);
    if (!check.ok) {
      reasons.push(`${check.reason || "invalid_action"}@${i}`);
    }
  }
  if (String(routine.match_mode || "exact") !== "exact") {
    reasons.push("unsupported_match_mode");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * @param {Record<string, unknown>} routine
 * @param {{ routines?: Array<Record<string, unknown>> }} [opts]
 * @returns {{ ok: boolean, reasons?: string[], routines?: Array<Record<string, unknown>> }}
 */
function upsertSandboxRoutine(routine, opts = {}) {
  const next = createSandboxRoutine(routine);
  next.updated_at = new Date().toISOString();
  const routines = Array.isArray(opts.routines) ? opts.routines.slice() : loadSandboxRoutines();
  const idx = routines.findIndex((r) => String(r?.id || "") === String(next.id));
  const validation = validateSandboxRoutine(next, {
    excludeRoutineId: next.id,
    routines,
  });
  if (!validation.ok) {
    return { ok: false, reasons: validation.reasons };
  }
  if (idx >= 0) {
    next.created_at = routines[idx].created_at || next.created_at;
    routines[idx] = next;
  } else {
    if (routines.length >= SANDBOX_MAX_ROUTINES) {
      return { ok: false, reasons: ["max_routines_reached"] };
    }
    routines.push(next);
  }
  if (!Array.isArray(opts.routines)) {
    saveSandboxRoutines(routines);
  }
  return { ok: true, routines, routine: next };
}

/**
 * @param {string} routineId
 * @returns {boolean}
 */
function removeSandboxRoutine(routineId) {
  const id = String(routineId || "").trim();
  if (!id) return false;
  const routines = loadSandboxRoutines().filter((r) => String(r?.id || "") !== id);
  return saveSandboxRoutines(routines);
}

/**
 * @param {string} rawText
 * @param {{ enabled?: boolean, routines?: Array<Record<string, unknown>> }} [opts]
 * @returns {Record<string, unknown>|null}
 */
function matchSandboxRoutine(rawText, opts = {}) {
  const enabled = typeof opts.enabled === "boolean" ? opts.enabled : isSandboxCommandsEnabled();
  const normalizedInput = normalizeSandboxTrigger(rawText);
  if (!enabled) {
    return null;
  }
  if (!normalizedInput) {
    logSandboxDebug("routine_no_match", { normalized_text: normalizedInput, reason: "empty" });
    return null;
  }
  const routines = Array.isArray(opts.routines) ? opts.routines : loadSandboxRoutines();
  for (const routine of routines) {
    if (!routine || typeof routine !== "object") continue;
    if (routine.enabled === false) continue;
    const normalizedTrigger = normalizeSandboxTrigger(routine.trigger);
    if (!normalizedTrigger) continue;
    if (normalizedInput === normalizedTrigger) {
      logSandboxDebug("routine_match", {
        trigger: String(routine.trigger || "").slice(0, 160),
        routine_id: routine.id,
        normalized_text: normalizedInput,
      });
      return routine;
    }
  }
  logSandboxDebug("routine_no_match", { normalized_text: normalizedInput });
  return null;
}

/**
 * @param {Record<string, unknown>} action
 * @returns {Record<string, unknown>}
 */
function _compileSandboxActionPayload(action) {
  const type = String(action.type || "").trim();
  switch (type) {
    case "work_mode.open":
    case "panel.open_new":
      return {};
    case "voice.say":
      return { text: String(action.text || "").trim() };
    case "music.play":
      return { query: String(action.query || "").trim() };
    case "music.play_builtin": {
      const builtinId = normalizeSandboxTrigger(
        String(action.builtin_id || action.playlist_id || action.sound_id || "")
      ).replace(/\s+/g, "_");
      if (builtinId === "lofi_mix") {
        return { playlist_id: "lofi_mix", op: "play_builtin" };
      }
      return { sound_id: builtinId, op: "play_builtin" };
    }
    case "timer.set":
      return {
        duration_seconds: Math.floor(Number(action.duration_seconds)),
        message: String(action.message || "Your timer is up.").trim(),
      };
    case "checklist.add":
      return { text: String(action.text || "").trim() };
    case "panel.switch":
      return { panel_index: Math.floor(Number(action.panel_index)) };
    default:
      return {};
  }
}

/**
 * Compile a stored routine into a client action plan compatible with
 * executeClientActionPlan().
 *
 * @param {Record<string, unknown>} routine
 * @returns {Record<string, unknown>}
 */
function compileRoutineToActionPlan(routine) {
  const routineId = String(routine?.id || "unknown");
  const actions = Array.isArray(routine?.actions) ? routine.actions : [];
  return {
    source: "sandbox_routine",
    routine_id: routineId,
    trigger: String(routine?.trigger || "").trim(),
    is_multi_action: actions.length > 1,
    actions: actions.map((action, index) => ({
      id: `sandbox_${routineId}_${index}`,
      type: String(action?.type || "").trim(),
      payload: _compileSandboxActionPayload(action),
    })),
  };
}

/**
 * @param {string} rawText
 * @param {{ enabled?: boolean, routines?: Array<Record<string, unknown>> }} [opts]
 * @returns {{ matched: boolean, routine?: Record<string, unknown>, plan?: Record<string, unknown> }}
 */
function tryCompileSandboxRoutinePlan(rawText, opts = {}) {
  const routine = matchSandboxRoutine(rawText, opts);
  if (!routine) {
    return { matched: false };
  }
  return {
    matched: true,
    routine,
    plan: compileRoutineToActionPlan(routine),
  };
}

if (typeof window !== "undefined") {
  window.SANDBOX_LS_ENABLED_KEY = SANDBOX_LS_ENABLED_KEY;
  window.SANDBOX_LS_ROUTINES_KEY = SANDBOX_LS_ROUTINES_KEY;
  window.normalizeSandboxTrigger = normalizeSandboxTrigger;
  window.isSandboxCommandsEnabled = isSandboxCommandsEnabled;
  window.setSandboxCommandsEnabled = setSandboxCommandsEnabled;
  window.loadSandboxRoutines = loadSandboxRoutines;
  window.saveSandboxRoutines = saveSandboxRoutines;
  window.createSandboxRoutine = createSandboxRoutine;
  window.validateSandboxTrigger = validateSandboxTrigger;
  window.validateSandboxAction = validateSandboxAction;
  window.validateSandboxRoutine = validateSandboxRoutine;
  window.upsertSandboxRoutine = upsertSandboxRoutine;
  window.removeSandboxRoutine = removeSandboxRoutine;
  window.matchSandboxRoutine = matchSandboxRoutine;
  window.compileRoutineToActionPlan = compileRoutineToActionPlan;
  window.tryCompileSandboxRoutinePlan = tryCompileSandboxRoutinePlan;
  window.sandboxTriggerOverlapsCoreCommand = sandboxTriggerOverlapsCoreCommand;
  window.SANDBOX_ALLOWED_ACTION_TYPES = SANDBOX_ALLOWED_ACTION_TYPES;
}
