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
  window.wireMusicTransportButtonOnce = wireMusicTransportButtonOnce;
}
