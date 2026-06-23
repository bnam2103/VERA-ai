/* =========================================================================
 *  users/checklistSupabaseSync.js — Supabase account checklist sync (Phase 4b).
 *
 *  Load order: AFTER workmode/checklist.js (readChecklistItemsFromStorage,
 *  loadWorkChecklistItems) and users/supabaseAuth.js (authFetch).
 *
 *  Logged-out: localStorage only (no API calls).
 *  Logged-in: localStorage is UI cache; Supabase is durable account storage.
 *
 *  Login: POST /api/checklist/merge (local + remote dedupe, done wins).
 *  Mutations: PUT /api/checklist in background via syncWorkChecklistToSupabaseNow.
 * ========================================================================= */

const LS_CHECKLIST_KEY = "vera_wm_checklist_v1";
const LS_COLLAPSED_KEY = "vera_wm_checklist_completed_collapsed_v1";
const LS_UNSYNCED_KEY = "vera_wm_checklist_supabase_unsynced_v1";

let _hydratePromise = null;
let _saveInFlight = null;

function _isLoggedIn() {
  return (
    typeof isSupabaseUserAuthenticated === "function" &&
    isSupabaseUserAuthenticated()
  );
}

function _readLocalChecklistBundle() {
  const items =
    typeof readChecklistItemsFromStorage === "function"
      ? readChecklistItemsFromStorage()
      : [];
  const completed_collapsed = localStorage.getItem(LS_COLLAPSED_KEY) === "1";
  return { items, completed_collapsed };
}

function _markChecklistUnsynced(unsynced) {
  try {
    if (unsynced) localStorage.setItem(LS_UNSYNCED_KEY, "1");
    else localStorage.removeItem(LS_UNSYNCED_KEY);
  } catch (_) {}
}

function isWorkChecklistSupabaseUnsynced() {
  try {
    return localStorage.getItem(LS_UNSYNCED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function _applyChecklistBundleToLocal(items, completed_collapsed) {
  try {
    localStorage.setItem(LS_CHECKLIST_KEY, JSON.stringify(Array.isArray(items) ? items : []));
    if (typeof completed_collapsed === "boolean") {
      localStorage.setItem(LS_COLLAPSED_KEY, completed_collapsed ? "1" : "0");
    }
  } catch (_) {
    return false;
  }
  if (typeof loadWorkChecklistItems === "function") {
    loadWorkChecklistItems();
  }
  if (typeof applyWorkChecklistCompletedCollapseFromStorage === "function") {
    applyWorkChecklistCompletedCollapseFromStorage();
  }
  return true;
}

async function syncWorkChecklistToSupabaseNow() {
  if (!_isLoggedIn()) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;

  const bundle = _readLocalChecklistBundle();
  const run = async () => {
    try {
      const res = await authFetch(authApiUrl("/api/checklist"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[VERA][CHECKLIST] supabase PUT failed", data);
        _markChecklistUnsynced(true);
        return false;
      }
      _markChecklistUnsynced(false);
      return true;
    } catch (err) {
      console.warn("[VERA][CHECKLIST] supabase PUT error", err);
      _markChecklistUnsynced(true);
      return false;
    }
  };

  if (_saveInFlight) {
    _saveInFlight = _saveInFlight.then(run, run);
  } else {
    _saveInFlight = run();
  }
  try {
    return await _saveInFlight;
  } finally {
    _saveInFlight = null;
  }
}

async function hydrateChecklistMergeOnLogin() {
  if (!_isLoggedIn()) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;
  if (_hydratePromise) return _hydratePromise;

  _hydratePromise = (async () => {
    try {
      const local = _readLocalChecklistBundle();
      const res = await authFetch(authApiUrl("/api/checklist/merge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[VERA][CHECKLIST] merge hydrate failed", data);
        return false;
      }
      if (Array.isArray(data.items)) {
        _applyChecklistBundleToLocal(data.items, data.completed_collapsed);
      }
      _markChecklistUnsynced(false);
      if (typeof queueWorkChecklistSyncToServer === "function") {
        queueWorkChecklistSyncToServer();
      }
      return true;
    } catch (err) {
      console.warn("[VERA][CHECKLIST] merge hydrate error", err);
      return false;
    } finally {
      _hydratePromise = null;
    }
  })();

  return _hydratePromise;
}

try {
  if (typeof window !== "undefined") {
    window.syncWorkChecklistToSupabaseNow = syncWorkChecklistToSupabaseNow;
    window.hydrateChecklistMergeOnLogin = hydrateChecklistMergeOnLogin;
    window.isWorkChecklistSupabaseUnsynced = isWorkChecklistSupabaseUnsynced;
  }
} catch (_) {}
