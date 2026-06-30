/* =========================================================================
 *  users/accountSettingsSync.js — Supabase account prefs sync (Phase 4).
 *
 *  Load order: AFTER users/supabaseAuth.js (authFetch), BEFORE app.js.
 *
 *  Hydration policy (logged-in):
 *    - GET /api/settings after auth restore
 *    - If server vera_prefs_v1 is non-empty → apply to localStorage + UI
 *    - If server empty → seed Supabase from current localStorage (no overwrite)
 *
 *  Save policy (logged-in):
 *    - User changes apply to localStorage immediately (existing setters)
 *    - PATCH /api/settings in background with vera_prefs_v1 snapshot
 *
 *  Logged-out: localStorage only (no API calls).
 *  Logout boundary (Phase 4d):
 *    - Cancel/block pending PATCH; restore anonymous snapshot or safe defaults.
 *    - Never PATCH account settings after logout cleanup.
 * ========================================================================= */

const VERA_PREFS_API_KEY = "vera_prefs_v1";
const VERA_PREFS_ANON_SNAPSHOT_KEY_PREFIX = "vera_prefs_anon_snapshot_v1:";

const LS_ASR_MODE = "vera_setting_asr_mode_v1";
const LS_ASR_SILENCE_MS = "vera_setting_asr_silence_ms_v1";
const LS_MAIN_PARTIAL_MIN = "vera_setting_main_asr_partial_min_chars_v1";
const LS_WORKMODE_MUTE = "vera_setting_workmode_mute_v1";
const LS_TEXT_GUIDE = "vera_setting_text_guide_rotator_v1";
const LS_LEFT_PANES_LAYOUT = "vera_wm_left_panes_layout_v1";

let _hydratePromise = null;
let _patchInFlight = null;
/** Bumped on logout so in-flight account PATCHes cannot overwrite Supabase. */
let _settingsAuthWriteGeneration = 0;

function _isLoggedIn() {
  return (
    typeof isSupabaseUserAuthenticated === "function" &&
    isSupabaseUserAuthenticated()
  );
}

function getAnonymousVeraPrefsSnapshotKey() {
  const sid = typeof getSessionId === "function" ? getSessionId() : "default";
  return `${VERA_PREFS_ANON_SNAPSHOT_KEY_PREFIX}${sid}`;
}

function _safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function _normalizeAsrMode(raw) {
  const mode = String(raw || "").trim().toLowerCase();
  if (mode === "streaming" || mode === "whisper" || mode === "hybrid") return mode;
  if (mode === "browser") return "streaming";
  if (mode === "single") return "whisper";
  return null;
}

function getSafeDefaultVeraPrefs() {
  return {
    asr_mode: "whisper",
    asr_silence_ms: 1300,
    workmode_mute: false,
    text_guide_rotator: true,
    main_asr_partial_min_chars: 20,
    work_left_panes_layout: "split",
  };
}

function collectLocalVeraPrefs() {
  const prefs = {};
  const asrMode = _normalizeAsrMode(_safeGet(LS_ASR_MODE));
  if (asrMode) prefs.asr_mode = asrMode;

  const silence = Number(_safeGet(LS_ASR_SILENCE_MS));
  if ([1000, 1300, 1600].includes(silence)) prefs.asr_silence_ms = silence;

  const muteRaw = _safeGet(LS_WORKMODE_MUTE);
  if (muteRaw === "0" || muteRaw === "1") prefs.workmode_mute = muteRaw === "1";

  const guideRaw = _safeGet(LS_TEXT_GUIDE);
  if (guideRaw === "0" || guideRaw === "1") prefs.text_guide_rotator = guideRaw === "1";
  else if (guideRaw == null) prefs.text_guide_rotator = true;

  const partialRaw = _safeGet(LS_MAIN_PARTIAL_MIN);
  if (partialRaw === "inf") {
    prefs.main_asr_partial_min_chars = "inf";
  } else if (partialRaw != null && partialRaw !== "") {
    const partial = Number(partialRaw);
    if (Number.isFinite(partial) && partial >= 0 && partial <= 4) {
      prefs.main_asr_partial_min_chars = partial;
    }
  }

  const layout = String(_safeGet(LS_LEFT_PANES_LAYOUT) || "").trim();
  if (layout === "split" || layout === "music-full" || layout === "checklist-full") {
    prefs.work_left_panes_layout = layout;
  }

  return prefs;
}

function _prefsIsEmpty(prefs) {
  return !prefs || typeof prefs !== "object" || !Object.keys(prefs).length;
}

function saveAnonymousVeraPrefsSnapshot(prefs) {
  const snap = prefs && !_prefsIsEmpty(prefs) ? prefs : collectLocalVeraPrefs();
  if (_prefsIsEmpty(snap)) return;
  try {
    localStorage.setItem(getAnonymousVeraPrefsSnapshotKey(), JSON.stringify(snap));
  } catch (_) {}
}

function readAnonymousVeraPrefsSnapshot() {
  try {
    const raw = localStorage.getItem(getAnonymousVeraPrefsSnapshotKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return _prefsIsEmpty(parsed) ? null : parsed;
  } catch (_) {
    return null;
  }
}

function applyVeraPrefsToLocal(prefs) {
  if (_prefsIsEmpty(prefs)) return;

  if (prefs.asr_mode && typeof setVeraAsrMode === "function") {
    setVeraAsrMode(prefs.asr_mode);
  }
  if (
    typeof prefs.asr_silence_ms === "number" &&
    typeof setVeraAsrSilenceMs === "function"
  ) {
    setVeraAsrSilenceMs(prefs.asr_silence_ms);
  }
  if (typeof prefs.workmode_mute === "boolean" && typeof setWorkModeMuteEnabled === "function") {
    setWorkModeMuteEnabled(prefs.workmode_mute);
  }
  if (
    typeof prefs.text_guide_rotator === "boolean" &&
    typeof setTextGuideRotatorEnabled === "function"
  ) {
    setTextGuideRotatorEnabled(prefs.text_guide_rotator);
  }
  if (prefs.main_asr_partial_min_chars != null && typeof setMainAsrPartialMinChars === "function") {
    const v = prefs.main_asr_partial_min_chars;
    setMainAsrPartialMinChars(v === "inf" ? Infinity : Number(v));
  }
  if (
    prefs.work_left_panes_layout &&
    typeof setWorkModeLeftPaneLayout === "function"
  ) {
    setWorkModeLeftPaneLayout(prefs.work_left_panes_layout);
  } else if (
    prefs.work_left_panes_layout &&
    typeof applyWorkModeLeftPaneLayoutFromStorage === "function"
  ) {
    try {
      localStorage.setItem(LS_LEFT_PANES_LAYOUT, prefs.work_left_panes_layout);
    } catch (_) {}
    applyWorkModeLeftPaneLayoutFromStorage();
  }
}

function _settingsCancelPendingAccountSync() {
  _patchInFlight = null;
  _hydratePromise = null;
}

function _settingsBlockAccountWrites() {
  _settingsAuthWriteGeneration += 1;
  _settingsCancelPendingAccountSync();
}

async function patchVeraPrefsToSupabase(prefs, { reason } = {}) {
  if (!_isLoggedIn() || _prefsIsEmpty(prefs)) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;

  const genAtStart = _settingsAuthWriteGeneration;
  const body = { vera_prefs_v1: prefs };
  const run = async () => {
    if (genAtStart !== _settingsAuthWriteGeneration) return false;
    try {
      const res = await authFetch(authApiUrl("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (genAtStart !== _settingsAuthWriteGeneration) return false;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[VERA][SETTINGS] patch failed", reason || "", data);
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[VERA][SETTINGS] patch error", reason || "", err);
      return false;
    }
  };

  if (_patchInFlight) {
    _patchInFlight = _patchInFlight.then(run, run);
  } else {
    _patchInFlight = run();
  }
  try {
    return await _patchInFlight;
  } finally {
    _patchInFlight = null;
  }
}

async function syncLocalVeraPrefsToSupabase(reason) {
  if (!_isLoggedIn()) {
    saveAnonymousVeraPrefsSnapshot();
    return false;
  }
  return patchVeraPrefsToSupabase(collectLocalVeraPrefs(), { reason: reason || "local_change" });
}

async function hydrateVeraSettingsFromSupabase() {
  if (!_isLoggedIn()) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;

  if (_hydratePromise) return _hydratePromise;

  const genAtStart = _settingsAuthWriteGeneration;
  _hydratePromise = (async () => {
    try {
      saveAnonymousVeraPrefsSnapshot();
      if (genAtStart !== _settingsAuthWriteGeneration) return false;

      const res = await authFetch(authApiUrl("/api/settings"), { method: "GET" });
      if (genAtStart !== _settingsAuthWriteGeneration) return false;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[VERA][SETTINGS] hydrate GET failed", data);
        return false;
      }

      const remote = data?.vera_prefs_v1 || data?.settings?.[VERA_PREFS_API_KEY] || {};
      if (!_prefsIsEmpty(remote)) {
        if (genAtStart !== _settingsAuthWriteGeneration) return false;
        applyVeraPrefsToLocal(remote);
        return true;
      }

      const local = collectLocalVeraPrefs();
      if (!_prefsIsEmpty(local)) {
        if (genAtStart !== _settingsAuthWriteGeneration) return false;
        await patchVeraPrefsToSupabase(local, { reason: "seed_from_local" });
      }
      return genAtStart === _settingsAuthWriteGeneration;
    } catch (err) {
      console.warn("[VERA][SETTINGS] hydrate error", err);
      return false;
    } finally {
      _hydratePromise = null;
    }
  })();

  return _hydratePromise;
}

function clearSettingsAfterLogout() {
  console.info("[settings_logout_cleanup]", { phase: "start" });
  _settingsBlockAccountWrites();
  const anon = readAnonymousVeraPrefsSnapshot();
  const restore = anon || getSafeDefaultVeraPrefs();
  applyVeraPrefsToLocal(restore);
  try {
    console.info("[settings_logout_cleanup]", {
      phase: "done",
      restored_from: anon ? "anonymous_snapshot" : "safe_defaults",
      asr_mode: restore.asr_mode || null,
    });
  } catch (_) {}
}

try {
  if (typeof window !== "undefined") {
    window.collectLocalVeraPrefs = collectLocalVeraPrefs;
    window.applyVeraPrefsToLocal = applyVeraPrefsToLocal;
    window.hydrateVeraSettingsFromSupabase = hydrateVeraSettingsFromSupabase;
    window.syncLocalVeraPrefsToSupabase = syncLocalVeraPrefsToSupabase;
    window.clearSettingsAfterLogout = clearSettingsAfterLogout;
    window.saveAnonymousVeraPrefsSnapshot = saveAnonymousVeraPrefsSnapshot;
    window.readAnonymousVeraPrefsSnapshot = readAnonymousVeraPrefsSnapshot;
    window.getSafeDefaultVeraPrefs = getSafeDefaultVeraPrefs;
    window.getAnonymousVeraPrefsSnapshotKey = getAnonymousVeraPrefsSnapshotKey;
  }
} catch (_) {}
