/**
 * users/cloudSyncStatus.js — Account panel cloud sync status + manual sync.
 * Load AFTER supabaseAuth.js, accountSettingsSync.js, checklist.js, workspaceSync.js.
 */
(function () {
  "use strict";

  const ROWS = [
    { key: "checklist", label: "Checklist" },
    { key: "workspace", label: "Work Mode panels" },
    { key: "memories", label: "Memories" },
    { key: "settings", label: "Settings" },
  ];

  let _manualSyncInFlight = false;
  let _lastSyncedAt = null;
  let _banner = { type: "", text: "" };
  let _pollTimer = null;
  let _wired = false;

  function $(id) {
    return document.getElementById(id);
  }

  function isSignedIn() {
    return (
      typeof isSupabaseUserAuthenticated === "function" &&
      isSupabaseUserAuthenticated()
    );
  }

  function readChecklistSyncDebug() {
    if (typeof getChecklistSupabaseSyncDebugState === "function") {
      return getChecklistSupabaseSyncDebugState();
    }
    if (typeof getChecklistDebugState === "function") {
      const dbg = getChecklistDebugState();
      return {
        status: dbg.supabase_status || (dbg.unsynced ? "unsynced" : "synced"),
        unsynced: Boolean(dbg.unsynced),
        syncing: Boolean(dbg.supabase_syncing),
      };
    }
    return null;
  }

  function readWorkspaceSyncDebug() {
    if (typeof getWorkModeWorkspaceSyncDebugState === "function") {
      return getWorkModeWorkspaceSyncDebugState();
    }
    if (typeof isWorkModeWorkspaceUnsynced === "function") {
      return {
        unsynced: isWorkModeWorkspaceUnsynced(),
        syncing: false,
        pending: false,
        status: isWorkModeWorkspaceUnsynced() ? "unsynced" : "synced",
      };
    }
    return null;
  }

  function readSettingsSyncDebug() {
    if (typeof getVeraSettingsSyncDebugState === "function") {
      return getVeraSettingsSyncDebugState();
    }
    return null;
  }

  function mapDomainState(key) {
    if (!isSignedIn()) return "local";

    if (key === "checklist") {
      const dbg = readChecklistSyncDebug();
      if (!dbg) return "unknown";
      if (dbg.syncing || dbg.status === "retrying") return "syncing";
      if (dbg.status === "failed") return "failed";
      if (dbg.pending || dbg.status === "unsynced" || dbg.unsynced) return "pending";
      return "saved";
    }

    if (key === "workspace") {
      const dbg = readWorkspaceSyncDebug();
      if (!dbg) return "unknown";
      if (dbg.syncing) return "syncing";
      if (dbg.status === "failed") return "failed";
      if (dbg.pending || dbg.unsynced || dbg.status === "unsynced") return "pending";
      return "saved";
    }

    if (key === "settings") {
      const dbg = readSettingsSyncDebug();
      if (!dbg) return "unknown";
      if (dbg.syncing) return "syncing";
      if (dbg.status === "failed") return "failed";
      if (dbg.unsynced || dbg.status === "unsynced") return "pending";
      return "saved";
    }

    if (key === "memories") {
      return "saved";
    }

    return "unknown";
  }

  function statusLabel(state) {
    switch (state) {
      case "saved":
        return "Saved to account";
      case "syncing":
        return "Syncing…";
      case "pending":
        return "Pending sync";
      case "failed":
        return "Sync failed";
      case "local":
        return "Saved locally";
      case "unknown":
        return "Not yet synced automatically";
      default:
        return "—";
    }
  }

  function statusIconClass(state) {
    switch (state) {
      case "saved":
        return "vera-cloud-sync-icon vera-cloud-sync-icon--saved";
      case "syncing":
        return "vera-cloud-sync-icon vera-cloud-sync-icon--syncing";
      case "pending":
        return "vera-cloud-sync-icon vera-cloud-sync-icon--pending";
      case "failed":
        return "vera-cloud-sync-icon vera-cloud-sync-icon--failed";
      case "local":
        return "vera-cloud-sync-icon vera-cloud-sync-icon--local";
      default:
        return "vera-cloud-sync-icon vera-cloud-sync-icon--unknown";
    }
  }

  function formatRelativeTime(ts) {
    if (!ts) return "—";
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 12) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 48) return `${hr}h ago`;
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return "—";
    }
  }

  function ensureRows(listEl) {
    if (!(listEl instanceof HTMLElement)) return;
    if (listEl.children.length === ROWS.length) return;
    listEl.innerHTML = "";
    for (const row of ROWS) {
      const li = document.createElement("li");
      li.className = "vera-cloud-sync-row";
      li.dataset.syncKey = row.key;
      li.innerHTML =
        `<span class="vera-cloud-sync-row-label">${row.label}</span>` +
        `<span class="vera-cloud-sync-row-status">` +
        `<span class="vera-cloud-sync-icon vera-cloud-sync-icon--unknown" aria-hidden="true"></span>` +
        `<span class="vera-cloud-sync-row-text"></span>` +
        `</span>`;
      listEl.appendChild(li);
    }
  }

  function updateBanner() {
    const banner = $("vera-cloud-sync-banner");
    if (!(banner instanceof HTMLElement)) return;
    if (!_banner.text) {
      banner.hidden = true;
      banner.textContent = "";
      banner.className = "vera-cloud-sync-banner";
      return;
    }
    banner.hidden = false;
    banner.textContent = _banner.text;
    banner.className =
      "vera-cloud-sync-banner" +
      (_banner.type === "error"
        ? " vera-cloud-sync-banner--error"
        : _banner.type === "success"
          ? " vera-cloud-sync-banner--success"
          : "");
  }

  function refreshCloudSyncUi() {
    const signedInCard = $("vera-cloud-sync-signed-in");
    const signedOutCard = $("vera-cloud-sync-signed-out");
    const legacy = $("vera-checklist-sync-status");
    if (legacy instanceof HTMLElement) {
      legacy.hidden = true;
      legacy.textContent = "";
    }

    if (!isSignedIn()) {
      signedInCard?.setAttribute("hidden", "");
      signedOutCard?.removeAttribute("hidden");
      stopPolling();
      return;
    }

    signedOutCard?.setAttribute("hidden", "");
    signedInCard?.removeAttribute("hidden");

    const listEl = $("vera-cloud-sync-list");
    ensureRows(listEl);
    if (listEl instanceof HTMLElement) {
      for (const li of listEl.querySelectorAll(".vera-cloud-sync-row")) {
        const key = String(li.dataset.syncKey || "");
        const state = mapDomainState(key);
        const icon = li.querySelector(".vera-cloud-sync-icon");
        const text = li.querySelector(".vera-cloud-sync-row-text");
        if (icon instanceof HTMLElement) {
          icon.className = statusIconClass(state);
        }
        if (text instanceof HTMLElement) {
          text.textContent = statusLabel(state);
          text.dataset.syncState = state;
        }
      }
    }

    const lastEl = $("vera-cloud-sync-last");
    if (lastEl instanceof HTMLElement) {
      lastEl.textContent = `Last synced: ${formatRelativeTime(_lastSyncedAt)}`;
    }

    const syncBtn = $("vera-cloud-sync-now");
    if (syncBtn instanceof HTMLButtonElement) {
      syncBtn.disabled = _manualSyncInFlight;
      syncBtn.textContent = _manualSyncInFlight ? "Syncing…" : "Sync now";
      syncBtn.setAttribute("aria-busy", _manualSyncInFlight ? "true" : "false");
    }

    updateBanner();
  }

  async function runManualSync() {
    if (!isSignedIn() || _manualSyncInFlight) return;
    _manualSyncInFlight = true;
    _banner = { type: "", text: "" };
    refreshCloudSyncUi();

    const attempts = [];
    let anyAttempt = false;

    try {
      if (typeof syncWorkChecklistToSupabaseNow === "function") {
        anyAttempt = true;
        attempts.push(await syncWorkChecklistToSupabaseNow());
      }
      if (typeof syncWorkModeWorkspaceToSupabaseNow === "function") {
        anyAttempt = true;
        attempts.push(await syncWorkModeWorkspaceToSupabaseNow());
      }
      if (typeof syncLocalVeraPrefsToSupabase === "function") {
        anyAttempt = true;
        attempts.push(await syncLocalVeraPrefsToSupabase("account_sync_now"));
      }
      if (typeof syncWorkChecklistToServerNow === "function") {
        try {
          await syncWorkChecklistToServerNow();
        } catch (_) {}
      }

      const anyFail = attempts.some((r) => r === false);
      if (!anyAttempt) {
        _banner = {
          type: "error",
          text: "Cloud sync is not available in this build.",
        };
      } else if (anyFail) {
        _banner = {
          type: "error",
          text: "Some data could not sync. Try again.",
        };
      } else {
        _lastSyncedAt = Date.now();
        _banner = { type: "success", text: "Synced just now." };
      }
    } catch (_) {
      _banner = {
        type: "error",
        text: "Some data could not sync. Try again.",
      };
    } finally {
      _manualSyncInFlight = false;
      refreshCloudSyncUi();
      if (_banner.text) {
        window.setTimeout(() => {
          if (_banner.type === "success" || _banner.type === "error") {
            _banner = { type: "", text: "" };
            refreshCloudSyncUi();
          }
        }, 4500);
      }
    }
  }

  function startPolling() {
    if (_pollTimer != null) return;
    _pollTimer = window.setInterval(() => {
      const modal = $("vera-account-modal");
      if (!(modal instanceof HTMLElement) || modal.hasAttribute("hidden")) {
        stopPolling();
        return;
      }
      refreshCloudSyncUi();
    }, 1500);
  }

  function stopPolling() {
    if (_pollTimer == null) return;
    window.clearInterval(_pollTimer);
    _pollTimer = null;
  }

  function onAccountPanelOpened() {
    refreshCloudSyncUi();
    if (isSignedIn()) startPolling();
  }

  function wireCloudSyncUi() {
    if (_wired) return;
    _wired = true;
    $("vera-cloud-sync-now")?.addEventListener("click", () => {
      void runManualSync();
    });

    document.addEventListener("vera:cloud-sync-changed", () => {
      refreshCloudSyncUi();
    });

    if (typeof window !== "undefined") {
      const origOpen = window.veraOpenAccountModal;
      window.veraOpenAccountModal = function () {
        if (typeof origOpen === "function") origOpen();
        onAccountPanelOpened();
      };
    }
  }

  function initCloudSyncStatus() {
    wireCloudSyncUi();
    refreshCloudSyncUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCloudSyncStatus);
  } else {
    initCloudSyncStatus();
  }

  try {
    if (typeof window !== "undefined") {
      window.veraRefreshCloudSyncStatusUi = refreshCloudSyncUi;
      window.veraOnAccountPanelOpened = onAccountPanelOpened;
      window.veraRunAccountCloudSyncNow = runManualSync;
    }
  } catch (_) {}
})();
