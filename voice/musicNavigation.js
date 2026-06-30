/* =========================================================================
 *  voice/musicNavigation.js — shared manual track navigation dedupe/guards
 *
 *  Load BEFORE app.js (after utils/logging.js). Used by button clicks,
 *  voice music_control payloads, and builtin playlist transport.
 * ========================================================================= */

const MUSIC_NAV_ACTION_ID_TTL_MS = 30000;
const MUSIC_NAV_SOURCE_DIRECTION_DEDUPE_MS = 450;
const MUSIC_NAV_TIMESTAMP_FALLBACK_MS = 400;
const FREE_MUSIC_ENDED_SUPPRESS_MS = 700;
/** Per-request music transport (skip/volume) — survives NDJSON meta→done gap. */
const MUSIC_TRANSPORT_ACTION_ID_TTL_MS = 30000;

function musicNavigationDirectionLabel(delta) {
  return Number(delta) >= 0 ? "next" : "previous";
}

function musicNavigationDeltaFromDirection(direction) {
  return direction === "previous" ? -1 : 1;
}

function createMusicNavigationState() {
  return {
    lastNav: null,
    handledActionIds: new Map(),
    suppressFreeMusicEndedUntil: 0,
  };
}

function ensureMusicNavigationState() {
  if (typeof window === "undefined") return createMusicNavigationState();
  if (!window.__veraMusicNavState) {
    window.__veraMusicNavState = createMusicNavigationState();
  }
  return window.__veraMusicNavState;
}

function pruneMusicNavigationActionIds(state, nowMs) {
  if (!state?.handledActionIds) return;
  for (const [id, expiresAt] of state.handledActionIds.entries()) {
    if (nowMs >= expiresAt) state.handledActionIds.delete(id);
  }
}

function logMusicNavigation(tag, payload) {
  try {
    console.info(`[music_navigation_${tag}]`, payload || {});
  } catch (_) {}
}

/**
 * @param {ReturnType<typeof createMusicNavigationState>} state
 * @param {{ delta: number, source: string, actionId?: string|null, nowMs: number }} opts
 */
function shouldIgnoreMusicNavigationDuplicate(state, opts) {
  const direction = musicNavigationDirectionLabel(opts.delta);
  const source = String(opts.source || "unknown");
  const nowMs = Number(opts.nowMs) || 0;
  const actionId = opts.actionId ? String(opts.actionId).trim() : "";

  pruneMusicNavigationActionIds(state, nowMs);

  if (actionId) {
    const expiresAt = state.handledActionIds.get(actionId);
    if (expiresAt && nowMs < expiresAt) {
      return { ignore: true, reason: "action_id", direction, source, actionId };
    }
  }

  const last = state.lastNav;
  if (
    last &&
    last.direction === direction &&
    last.source === source &&
    nowMs - last.atMs < MUSIC_NAV_SOURCE_DIRECTION_DEDUPE_MS
  ) {
    return { ignore: true, reason: "source_direction_window", direction, source };
  }

  if (
    last &&
    last.direction === direction &&
    source !== "audio_ended" &&
    nowMs - last.atMs < MUSIC_NAV_TIMESTAMP_FALLBACK_MS
  ) {
    return { ignore: true, reason: "timestamp_fallback", direction, source };
  }

  return { ignore: false, direction, source };
}

/**
 * @param {ReturnType<typeof createMusicNavigationState>} state
 * @param {{ delta: number, source: string, actionId?: string|null, nowMs: number }} opts
 */
function markMusicNavigationExecuted(state, opts) {
  const direction = musicNavigationDirectionLabel(opts.delta);
  const nowMs = Number(opts.nowMs) || 0;
  const actionId = opts.actionId ? String(opts.actionId).trim() : "";
  state.lastNav = {
    direction,
    source: String(opts.source || "unknown"),
    atMs: nowMs,
    actionId: actionId || null,
  };
  if (actionId) {
    state.handledActionIds.set(actionId, nowMs + MUSIC_NAV_ACTION_ID_TTL_MS);
  }
  state.suppressFreeMusicEndedUntil = nowMs + FREE_MUSIC_ENDED_SUPPRESS_MS;
}

function isFreeMusicEndedNavigationSuppressed(state, nowMs) {
  return nowMs < Number(state?.suppressFreeMusicEndedUntil || 0);
}

function buildMusicNavigationActionId(payload, data, op) {
  const id = buildMusicTransportActionId(payload, data, op);
  if (id) return id;
  const fromPayload =
    payload?.navigation_action_id ||
    payload?.action_plan_id ||
    data?.action_plan_id ||
    data?.request_id ||
    "";
  const base = String(fromPayload || "").trim();
  if (!base) return "";
  return `${base}:${String(op || "").trim()}`;
}

function ensureAppliedMusicTransportIds() {
  if (typeof window === "undefined") return new Map();
  if (!window.__veraAppliedMusicTransportIds || !(window.__veraAppliedMusicTransportIds instanceof Map)) {
    window.__veraAppliedMusicTransportIds = new Map();
  }
  return window.__veraAppliedMusicTransportIds;
}

function pruneAppliedMusicTransportIds(nowMs) {
  const store = ensureAppliedMusicTransportIds();
  for (const [id, expiresAt] of store.entries()) {
    if (nowMs >= expiresAt) store.delete(id);
  }
}

function wasMusicTransportActionApplied(actionId, nowMs) {
  const id = String(actionId || "").trim();
  if (!id) return false;
  const now = Number(nowMs) || 0;
  pruneAppliedMusicTransportIds(now);
  const expiresAt = ensureAppliedMusicTransportIds().get(id);
  return Boolean(expiresAt && now < expiresAt);
}

function markMusicTransportActionApplied(actionId, nowMs) {
  const id = String(actionId || "").trim();
  if (!id) return;
  const now = Number(nowMs) || 0;
  pruneAppliedMusicTransportIds(now);
  ensureAppliedMusicTransportIds().set(id, now + MUSIC_TRANSPORT_ACTION_ID_TTL_MS);
}

/**
 * Stable per-turn id for music skip/volume dedupe across NDJSON meta, done,
 * and finalize paths. Returns "" when no request/plan context (caller may
 * fall back to short-window op dedupe).
 */
function buildMusicTransportActionId(payload, data, op) {
  const opName = String(op || "").trim();
  if (!opName) return "";
  const req = String(
    data?.request_id || data?.client_request_id || data?.requestId || ""
  ).trim();
  const planId = String(
    payload?.navigation_action_id ||
      payload?.action_id ||
      payload?.action_plan_id ||
      data?.action_plan_id ||
      ""
  ).trim();
  const base = req || planId;
  if (!base) return "";
  const seqIdx = Number.isFinite(Number(payload?.planner_action_index))
    ? Number(payload.planner_action_index)
    : 0;
  if (opName === "volume_delta") {
    const rawDelta = Number((payload && payload.delta) || 0);
    const dir = rawDelta > 0 ? "+1" : rawDelta < 0 ? "-1" : "0";
    return `${base}:music_transport:volume_delta:${dir}:${seqIdx}`;
  }
  return `${base}:music_transport:${opName}:${seqIdx}`;
}

function wireMusicTransportButtonOnce(btn, buttonName, handler) {
  if (!(btn instanceof HTMLButtonElement)) return false;
  const prev = Number(btn.dataset.veraMusicNavBindCount || "0");
  const count = prev + 1;
  btn.dataset.veraMusicNavBindCount = String(count);
  try {
    console.info("[music_button_listener_bound]", { button: buttonName, count });
  } catch (_) {}
  if (prev > 0) return false;
  btn.addEventListener("click", handler);
  return true;
}

if (typeof window !== "undefined") {
  window.MUSIC_NAV_SOURCE_DIRECTION_DEDUPE_MS = MUSIC_NAV_SOURCE_DIRECTION_DEDUPE_MS;
  window.MUSIC_NAV_TIMESTAMP_FALLBACK_MS = MUSIC_NAV_TIMESTAMP_FALLBACK_MS;
  window.FREE_MUSIC_ENDED_SUPPRESS_MS = FREE_MUSIC_ENDED_SUPPRESS_MS;
  window.musicNavigationDirectionLabel = musicNavigationDirectionLabel;
  window.musicNavigationDeltaFromDirection = musicNavigationDeltaFromDirection;
  window.createMusicNavigationState = createMusicNavigationState;
  window.ensureMusicNavigationState = ensureMusicNavigationState;
  window.shouldIgnoreMusicNavigationDuplicate = shouldIgnoreMusicNavigationDuplicate;
  window.markMusicNavigationExecuted = markMusicNavigationExecuted;
  window.isFreeMusicEndedNavigationSuppressed = isFreeMusicEndedNavigationSuppressed;
  window.logMusicNavigation = logMusicNavigation;
  window.buildMusicNavigationActionId = buildMusicNavigationActionId;
  window.buildMusicTransportActionId = buildMusicTransportActionId;
  window.ensureAppliedMusicTransportIds = ensureAppliedMusicTransportIds;
  window.wasMusicTransportActionApplied = wasMusicTransportActionApplied;
  window.markMusicTransportActionApplied = markMusicTransportActionApplied;
  window.MUSIC_TRANSPORT_ACTION_ID_TTL_MS = MUSIC_TRANSPORT_ACTION_ID_TTL_MS;
  window.wireMusicTransportButtonOnce = wireMusicTransportButtonOnce;
}
