/**
 * workmode/workspaceSync.js — account-backed Work Mode reasoning workspace sync.
 *
 * Persists reasoning tab structure/content to Supabase for logged-in users.
 * Voice UI chat is intentionally excluded.
 *
 * Load after workmode/panels.js + workmode/checklist.js, before app.js.
 */
/* global REASONING_TABS_MAX, MIN_REASONING_PANELS, REASONING_UNTITLED_TAB_NAME */

const WORKSPACE_UNSYNCED_KEY = "vera_wm_workspace_unsynced_v1";
const WORKSPACE_SAVE_DEBOUNCE_MS = 3000;
const WORKSPACE_MAX_MESSAGES = 30;
const WORKSPACE_MAX_MESSAGE_TEXT = 8000;
const WORKSPACE_HYDRATE_FETCH_TIMEOUT_MS = 8000;
const WORKSPACE_HYDRATE_BOOT_GUARD_MS = 2500;
const WORKSPACE_HYDRATE_AUTH_WAIT_MS = 4000;
const WORKSPACE_HYDRATE_BOOT_AUTH_WAIT_MS = 1500;

let _workspaceSaveTimer = null;
let _workspaceSaveInFlight = null;
let _workspaceHydratePromise = null;
let _workspaceHydratedUserId = null;
let _workspaceClientRevision = 0;
let _workspaceSyncStatus = "synced";

function _workspaceIsLoggedIn() {
  return (
    typeof isSupabaseUserAuthenticated === "function" &&
    isSupabaseUserAuthenticated()
  );
}

function _workspaceIsVeraWorkModeContext() {
  try {
    return typeof appModePrefix === "function" && appModePrefix() === "vera";
  } catch (_) {
    return true;
  }
}

async function _workspaceAwaitAuthToken(maxWaitMs = 4000) {
  if (typeof getSupabaseAccessToken !== "function") return null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const token = await getSupabaseAccessToken();
    if (token) return token;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return null;
}

function _workspaceMaxTabs() {
  return typeof REASONING_TABS_MAX === "number" ? REASONING_TABS_MAX : 8;
}

function _workspaceMinPanels() {
  return typeof MIN_REASONING_PANELS === "number" ? MIN_REASONING_PANELS : 3;
}

function _markWorkspaceUnsynced(unsynced) {
  try {
    if (unsynced) localStorage.setItem(WORKSPACE_UNSYNCED_KEY, "1");
    else localStorage.removeItem(WORKSPACE_UNSYNCED_KEY);
  } catch (_) {}
  _workspaceSyncStatus = unsynced ? "unsynced" : "synced";
}

function isWorkModeWorkspaceUnsynced() {
  try {
    return localStorage.getItem(WORKSPACE_UNSYNCED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function _sanitizeRegistryForSave(row) {
  if (!row || typeof row !== "object") return {};
  const keys = [
    "lane_id",
    "active_lane_id",
    "title",
    "lane_title",
    "last_user_request",
    "prior_problem_anchor",
    "latest_reasoning_summary",
    "latest_visible_markdown",
    "latest_assistant_turn",
    "latest_substantive_excerpt",
    "latest_clarification_excerpt",
    "main_context_excerpt",
    "main_context_type",
    "latest_turn_type",
    "latest_final_answer_excerpt",
    "latest_markdown_preview",
    "code_or_math_generated",
    "updated_at",
  ];
  const out = {};
  for (const k of keys) {
    if (row[k] == null) continue;
    out[k] = row[k];
  }
  return out;
}

function _extractMessagesFromScroll(scrollEl) {
  if (!(scrollEl instanceof HTMLElement)) return [];
  const turns = [...scrollEl.querySelectorAll(".vera-reasoning-turn")];
  const messages = [];
  if (turns.length) {
    for (const turn of turns.slice(-WORKSPACE_MAX_MESSAGES)) {
      const text = String(turn.textContent || "").trim();
      if (!text) continue;
      messages.push({
        role: "assistant",
        text: text.slice(0, WORKSPACE_MAX_MESSAGE_TEXT),
        kind: "reasoning",
      });
    }
    return messages.slice(-WORKSPACE_MAX_MESSAGES);
  }
  const text = String(scrollEl.textContent || "").trim();
  if (text) {
    messages.push({
      role: "assistant",
      text: text.slice(0, WORKSPACE_MAX_MESSAGE_TEXT),
      kind: "reasoning",
    });
  }
  return messages;
}

function _registryHasWorkspaceContent(registry) {
  if (!registry || typeof registry !== "object") return false;
  const main = String(registry.main_context_excerpt || registry.latest_visible_markdown || "").trim();
  const req = String(registry.last_user_request || "").trim();
  return Boolean(main || req);
}

function _tabHasWorkspaceContent(tab) {
  if (!tab || typeof tab !== "object") return false;
  if (_registryHasWorkspaceContent(tab.registry)) return true;
  const html = String(tab.rendered_html || "").trim();
  if (html && !html.includes("vera-reasoning-empty-hint")) return true;
  if (String(tab.summary || "").trim()) return true;
  return false;
}

function _panelHasWorkspaceContent(panel, registry) {
  if (_registryHasWorkspaceContent(registry)) return true;
  if (!(panel instanceof HTMLElement)) return false;
  const scroll = panel.querySelector(".vera-reasoning-md-panel");
  const html = String(scroll?.innerHTML || "").trim();
  if (html && html.length > 0 && !html.includes("vera-reasoning-empty-hint")) return true;
  if (String(panel.dataset.tabTopicSet || "") === "1") return true;
  if (
    typeof isGenericAutoRenamableReasoningPanelTitle === "function" &&
    !isGenericAutoRenamableReasoningPanelTitle(getReasoningTabTopicLabel(panel))
  ) {
    return true;
  }
  return false;
}

function buildWorkModeWorkspaceSnapshot() {
  if (!_workspaceIsVeraWorkModeContext()) return null;
  const order =
    typeof getReasoningPanelOrder === "function" ? getReasoningPanelOrder() : [];
  const activeLane = order.find((p) => p.isActive)?.laneId || "";
  const tabs = order.slice(0, _workspaceMaxTabs()).map((p, i) => {
    const panel =
      typeof getReasoningPanelElementByLaneId === "function"
        ? getReasoningPanelElementByLaneId(p.laneId)
        : document.querySelector(
            `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-lane-id="${p.laneId}"]`
          );
    const scroll = panel?.querySelector?.(".vera-reasoning-md-panel") || null;
    const laneId = String(p.laneId || "").trim();
    const registry =
      typeof workModeCompletedReasoningByLaneId !== "undefined" &&
      workModeCompletedReasoningByLaneId &&
      workModeCompletedReasoningByLaneId[laneId]
        ? _sanitizeRegistryForSave(workModeCompletedReasoningByLaneId[laneId])
        : {};
    const hasContent = _panelHasWorkspaceContent(panel, registry);
    const closed = Boolean(panel?.dataset?.closedLaneId) || !hasContent;
    const title =
      (panel && typeof getReasoningTabTopicLabel === "function"
        ? getReasoningTabTopicLabel(panel)
        : p.label) || REASONING_UNTITLED_TAB_NAME;
    return {
      lane_id: laneId,
      sort_order: i,
      title: String(title || REASONING_UNTITLED_TAB_NAME).slice(0, 120),
      lane_label: String(p.label || title || "").slice(0, 120),
      is_active: Boolean(p.isActive),
      closed,
      summary: String(registry.latest_reasoning_summary || "").slice(0, 4000),
      registry,
      messages: closed ? [] : _extractMessagesFromScroll(scroll),
      rendered_html: closed ? "" : String(scroll?.innerHTML || ""),
      last_opened_at: p.isActive ? new Date().toISOString() : undefined,
      updated_at: new Date().toISOString(),
    };
  });
  _workspaceClientRevision = Math.max(_workspaceClientRevision + 1, Date.now());
  return {
    client_revision: _workspaceClientRevision,
    active_lane_id: activeLane || null,
    tabs,
  };
}

function _hydrateRegistryRow(tab) {
  const reg = tab?.registry && typeof tab.registry === "object" ? tab.registry : {};
  const laneId = String(tab?.lane_id || reg.lane_id || "").trim();
  if (!laneId) return null;
  const row = {
    ...reg,
    lane_id: laneId,
    active_lane_id: laneId,
    title: String(tab?.title || reg.title || reg.lane_title || "").trim(),
    lane_title: String(tab?.title || reg.lane_title || "").trim(),
    latest_reasoning_summary: String(tab?.summary || reg.latest_reasoning_summary || "").trim(),
    latest_visible_markdown: String(reg.latest_visible_markdown || tab?.rendered_html || "").trim(),
    main_context_excerpt: String(
      reg.main_context_excerpt || reg.latest_visible_markdown || tab?.rendered_html || ""
    ).trim(),
    updated_at: Date.now(),
  };
  if (typeof normalizeLaneRegistryRow === "function") {
    return normalizeLaneRegistryRow(row);
  }
  return row;
}

function applyWorkModeWorkspaceSnapshot(data) {
  if (!_workspaceIsVeraWorkModeContext()) return false;
  try {
    const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
    if (!panelsRoot) return false;
    const tabs = Array.isArray(data?.tabs) ? data.tabs.slice(0, _workspaceMaxTabs()) : [];
    const activeLaneId = String(data?.active_lane_id || "").trim();

    if (typeof initWorkModeStableLaneIdSlots === "function") {
      initWorkModeStableLaneIdSlots();
    }

    const savedByIdx = new Map();
    let activeIdx = 0;
    let nextIdx = 0;

    const sorted = tabs
      .filter((t) => t && !t.closed)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));

    for (const tab of sorted) {
      if (!_tabHasWorkspaceContent(tab)) {
        continue;
      }
      if (nextIdx >= _workspaceMaxTabs()) break;
      const laneId = String(tab.lane_id || "").trim();
      if (!laneId) continue;
      if (typeof workModeStableLaneIdByIdx !== "undefined") {
        workModeStableLaneIdByIdx[nextIdx] = laneId;
      }
      const topic = String(tab.title || REASONING_UNTITLED_TAB_NAME);
      const topicGeneric =
        typeof isGenericAutoRenamableReasoningPanelTitle === "function" &&
        isGenericAutoRenamableReasoningPanelTitle(topic);
      savedByIdx.set(nextIdx, {
        html: String(tab.rendered_html || ""),
        topic,
        topicSet: topicGeneric ? "0" : "1",
        laneLabel: String(tab.lane_label || topic || `Panel ${nextIdx + 1}`),
        laneId,
      });
      const reg = _hydrateRegistryRow(tab);
      if (reg && typeof workModeCompletedReasoningByLaneId !== "undefined") {
        workModeCompletedReasoningByLaneId[laneId] = reg;
      }
      if (laneId === activeLaneId || tab.is_active) activeIdx = nextIdx;
      nextIdx += 1;
    }

    if (typeof ensureFixedReasoningLanePanels === "function") {
      ensureFixedReasoningLanePanels(savedByIdx, activeIdx);
    }
    if (typeof renderReasoningTabStrip === "function") {
      renderReasoningTabStrip();
    }
    if (typeof syncReasoningLaneBusySlotsAfterDomChange === "function") {
      syncReasoningLaneBusySlotsAfterDomChange();
    }
    return true;
  } catch (err) {
    console.warn("[workspace_hydrate_failed]", {
      phase: "apply_snapshot",
      error: String(err?.message || err),
    });
    if (typeof ensureFixedReasoningLanePanels === "function") {
      try {
        ensureFixedReasoningLanePanels(new Map(), 0);
      } catch (_) {}
    }
    return false;
  }
}

async function syncWorkModeWorkspaceToSupabaseNow() {
  if (!_workspaceIsLoggedIn() || !_workspaceIsVeraWorkModeContext()) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;

  const token = await _workspaceAwaitAuthToken();
  if (!token) {
    _markWorkspaceUnsynced(true);
    return false;
  }

  const snapshot = buildWorkModeWorkspaceSnapshot();
  if (!snapshot) return false;

  const run = async () => {
    try {
      const res = await authFetch(authApiUrl("/api/work-mode/workspace"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[workspace_sync] PUT failed", data);
        _markWorkspaceUnsynced(true);
        return false;
      }
      _markWorkspaceUnsynced(false);
      console.info("[workspace_sync]", {
        phase: "saved",
        tab_count: Array.isArray(snapshot.tabs) ? snapshot.tabs.length : 0,
        client_revision: snapshot.client_revision,
      });
      return true;
    } catch (err) {
      console.warn("[workspace_sync] PUT error", err);
      _markWorkspaceUnsynced(true);
      return false;
    }
  };

  if (_workspaceSaveInFlight) {
    try {
      await _workspaceSaveInFlight;
    } catch (_) {}
  }
  _workspaceSaveInFlight = run();
  try {
    return await _workspaceSaveInFlight;
  } finally {
    _workspaceSaveInFlight = null;
  }
}

function queueWorkModeWorkspaceSync(opts = {}) {
  if (!_workspaceIsLoggedIn() || !_workspaceIsVeraWorkModeContext()) return;
  if (opts.immediate) {
    if (_workspaceSaveTimer) {
      window.clearTimeout(_workspaceSaveTimer);
      _workspaceSaveTimer = null;
    }
    void syncWorkModeWorkspaceToSupabaseNow();
    return;
  }
  if (_workspaceSaveTimer) window.clearTimeout(_workspaceSaveTimer);
  _workspaceSaveTimer = window.setTimeout(() => {
    _workspaceSaveTimer = null;
    void syncWorkModeWorkspaceToSupabaseNow();
  }, WORKSPACE_SAVE_DEBOUNCE_MS);
}

async function hydrateWorkModeWorkspaceFromServer(force = false, opts = {}) {
  const source = String(opts.source || "unknown");
  const authWaitMs =
    Number(opts.authWaitMs) > 0 ? Number(opts.authWaitMs) : WORKSPACE_HYDRATE_AUTH_WAIT_MS;
  const fetchTimeoutMs =
    Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : WORKSPACE_HYDRATE_FETCH_TIMEOUT_MS;

  if (!_workspaceIsLoggedIn() || !_workspaceIsVeraWorkModeContext()) {
    console.info("[workspace_hydrate_done]", { source, outcome: "skip_not_logged_in" });
    return false;
  }
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") {
    console.info("[workspace_hydrate_done]", { source, outcome: "skip_no_auth_fetch" });
    return false;
  }

  if (_workspaceHydratePromise && !force) return _workspaceHydratePromise;

  console.info("[workspace_hydrate_start]", { source, force });

  _workspaceHydratePromise = (async () => {
    let outcome = "failed";
    try {
      const token = await _workspaceAwaitAuthToken(authWaitMs);
      if (!token) {
        outcome = "no_token";
        console.info("[workspace_hydrate_done]", { source, outcome });
        return false;
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const fetchTimer =
        controller && typeof window.setTimeout === "function"
          ? window.setTimeout(() => {
              try {
                controller.abort();
              } catch (_) {}
            }, fetchTimeoutMs)
          : null;

      let res;
      try {
        res = await authFetch(authApiUrl("/api/work-mode/workspace"), {
          method: "GET",
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (err) {
        if (err && err.name === "AbortError") {
          outcome = "timeout";
          console.warn("[workspace_hydrate_timeout]", { source, fetchTimeoutMs });
          _markWorkspaceUnsynced(true);
          return false;
        }
        throw err;
      } finally {
        if (fetchTimer) window.clearTimeout(fetchTimer);
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        outcome = `http_${res.status}`;
        console.warn("[workspace_hydrate_failed]", { source, status: res.status, data });
        if (res.status === 401 || res.status === 403) {
          _markWorkspaceUnsynced(false);
        } else {
          _markWorkspaceUnsynced(true);
        }
        return false;
      }
      if (data.empty || !Array.isArray(data.tabs) || !data.tabs.length) {
        outcome = "empty";
        console.info("[workspace_hydrate_empty]", { source });
        return false;
      }
      _workspaceClientRevision = Number(data.client_revision) || 0;
      const applied = applyWorkModeWorkspaceSnapshot(data);
      outcome = applied ? "applied" : "apply_skipped";
      console.info("[workspace_hydrate_done]", {
        source,
        outcome,
        tab_count: data.tabs.length,
        active_lane_id: data.active_lane_id || null,
      });
      return applied;
    } catch (err) {
      outcome = "error";
      console.warn("[workspace_hydrate_failed]", {
        source,
        error: String(err?.message || err),
      });
      _markWorkspaceUnsynced(true);
      if (typeof ensureFixedReasoningLanePanels === "function") {
        try {
          ensureFixedReasoningLanePanels(new Map(), 0);
        } catch (_) {}
      }
      return false;
    } finally {
      _workspaceHydratePromise = null;
      if (outcome === "failed") {
        console.info("[workspace_hydrate_done]", { source, outcome });
      }
    }
  })();

  return _workspaceHydratePromise;
}

function scheduleWorkModeWorkspaceHydrateBestEffort(source = "boot") {
  if (!_workspaceIsLoggedIn() || !_workspaceIsVeraWorkModeContext()) return;
  void (async () => {
    const guardMs = WORKSPACE_HYDRATE_BOOT_GUARD_MS;
    let guardFired = false;
    const guard = new Promise((resolve) => {
      window.setTimeout(() => {
        guardFired = true;
        console.warn("[workspace_hydrate_timeout]", { source, kind: "boot_guard", guardMs });
        resolve(false);
      }, guardMs);
    });
    try {
      await Promise.race([
        hydrateWorkModeWorkspaceFromServer(false, {
          source,
          authWaitMs: WORKSPACE_HYDRATE_BOOT_AUTH_WAIT_MS,
          maxWaitMs: WORKSPACE_HYDRATE_FETCH_TIMEOUT_MS,
        }),
        guard,
      ]);
    } catch (err) {
      console.warn("[workspace_hydrate_failed]", {
        source,
        kind: "boot_guard_race",
        error: String(err?.message || err),
      });
      if (typeof ensureFixedReasoningLanePanels === "function") {
        try {
          ensureFixedReasoningLanePanels(new Map(), 0);
        } catch (_) {}
      }
    } finally {
      if (guardFired) {
        console.info("[app_reveal_forced_after_workspace_timeout]", { source, guardMs });
      }
    }
  })();
}

async function retryWorkModeWorkspaceSyncIfUnsynced(reason) {
  if (!_workspaceIsLoggedIn()) return false;
  if (!isWorkModeWorkspaceUnsynced()) return false;
  if (_workspaceSaveInFlight) return false;
  console.info("[workspace_retry]", { reason });
  return syncWorkModeWorkspaceToSupabaseNow();
}

function wireWorkModeWorkspaceSupabaseListeners() {
  if (typeof window === "undefined" || window.__veraWorkspaceSbRetryWired) return;
  window.__veraWorkspaceSbRetryWired = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      queueWorkModeWorkspaceSync({ immediate: true });
      return;
    }
    void retryWorkModeWorkspaceSyncIfUnsynced("visibility");
  });

  window.addEventListener("pagehide", () => {
    queueWorkModeWorkspaceSync({ immediate: true });
  });

  window.addEventListener("online", () => {
    void retryWorkModeWorkspaceSyncIfUnsynced("online");
  });
}

function shouldSkipLocalReasoningTabsRestoreForCloud() {
  return _workspaceIsLoggedIn() && _workspaceIsVeraWorkModeContext();
}

function scheduleDeferredVeraChatRestoreIfAnonymous() {
  const tryRestore = () => {
    if (typeof isSupabaseUserAuthenticated === "function" && isSupabaseUserAuthenticated()) {
      return;
    }
    if (typeof restoreVeraChatState === "function") {
      restoreVeraChatState();
    }
  };
  if (typeof initSupabaseAuth === "function") {
    void initSupabaseAuth().then(tryRestore).catch(tryRestore);
  } else {
    tryRestore();
  }
}

try {
  window.buildWorkModeWorkspaceSnapshot = buildWorkModeWorkspaceSnapshot;
  window.applyWorkModeWorkspaceSnapshot = applyWorkModeWorkspaceSnapshot;
  window.syncWorkModeWorkspaceToSupabaseNow = syncWorkModeWorkspaceToSupabaseNow;
  window.queueWorkModeWorkspaceSync = queueWorkModeWorkspaceSync;
  window.hydrateWorkModeWorkspaceFromServer = hydrateWorkModeWorkspaceFromServer;
  window.scheduleWorkModeWorkspaceHydrateBestEffort = scheduleWorkModeWorkspaceHydrateBestEffort;
  window.retryWorkModeWorkspaceSyncIfUnsynced = retryWorkModeWorkspaceSyncIfUnsynced;
  window.isWorkModeWorkspaceUnsynced = isWorkModeWorkspaceUnsynced;
  window.shouldSkipLocalReasoningTabsRestoreForCloud = shouldSkipLocalReasoningTabsRestoreForCloud;
  window.scheduleDeferredVeraChatRestoreIfAnonymous = scheduleDeferredVeraChatRestoreIfAnonymous;
  wireWorkModeWorkspaceSupabaseListeners();
  console.info("[workspace_supabase_sync_ready]", {
    hydrate: typeof window.hydrateWorkModeWorkspaceFromServer,
    put: typeof window.syncWorkModeWorkspaceToSupabaseNow,
  });
} catch (_) {}
