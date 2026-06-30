/**
 * Smoke: Work Mode workspace logout cleanup.
 * Run: node tests/smoke/__workspace_logout_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL ${msg}`);
  }
}

const storage = new Map();
const workModeCompletedReasoningByLaneId = {};
const workModeStableLaneIdByIdx = {};
const ANON_KEY = "vera_reasoning_tabs_state_v2:session_smoke";

function makePanel(laneId, idx, { active = false, html = "", title = "Untitled" } = {}) {
  const scroll = {
    innerHTML: html,
    textContent: html.replace(/<[^>]+>/g, ""),
    querySelectorAll: () => [],
  };
  return {
    dataset: {
      laneId,
      tabIndex: String(idx),
      tabTopic: title,
      tabTopicSet: title === "Untitled" ? "0" : "1",
      laneLabel: title,
      closedLaneId: "",
    },
    classList: {
      _set: new Set(active ? ["is-active"] : []),
      contains(c) {
        return this._set.has(c);
      },
      toggle(c, force) {
        if (force) this._set.add(c);
        else this._set.delete(c);
      },
    },
    querySelector(sel) {
      if (sel === ".vera-reasoning-md-panel" || sel === ".vera-reasoning-scroll") return scroll;
      return null;
    },
  };
}

const panels = [];
const panelsRoot = {
  querySelectorAll(sel) {
    if (sel === ".vera-reasoning-tab-panel") return panels;
    return [];
  },
};

const MIN_REASONING_PANELS = 3;

function ensureFixedReasoningLanePanels(savedByIdx = new Map(), activeIdx = 0) {
  panels.length = 0;
  const count = Math.max(MIN_REASONING_PANELS, savedByIdx.size || MIN_REASONING_PANELS);
  for (let i = 0; i < count; i += 1) {
    const saved = savedByIdx.get(i);
    const laneId = saved?.laneId || `lane-slot-${i}`;
    const panel = makePanel(laneId, i, {
      active: i === activeIdx,
      html: saved?.html || "",
      title: saved?.topic || "Untitled",
    });
    if (saved?.topicSet) panel.dataset.tabTopicSet = saved.topicSet;
    panels.push(panel);
  }
}

function getReasoningTabsStateStorageKey() {
  return ANON_KEY;
}

function restoreReasoningTabsState() {
  let raw = "";
  try {
    raw = storage.get(ANON_KEY) || "";
  } catch (_) {
    return;
  }
  if (!raw) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
  if (!tabs.length) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const savedByIdx = new Map();
  let activeIdx = 0;
  tabs.forEach((t) => {
    const idx = Number(t?.idx);
    if (!Number.isFinite(idx)) return;
    if (Boolean(t?.active)) activeIdx = idx;
    savedByIdx.set(idx, {
      html: String(t?.html || ""),
      topic: String(t?.topic || "Untitled"),
      topicSet: String(t?.topicSet != null ? t.topicSet : "0"),
      laneLabel: String(t?.laneLabel || "").trim() || undefined,
      laneId: String(t?.laneId || "").trim(),
    });
  });
  ensureFixedReasoningLanePanels(savedByIdx, activeIdx);
}

function persistReasoningTabsState() {
  const payload = {
    ts: Date.now(),
    tabs: panels.map((p) => ({
      idx: Number(p.dataset.tabIndex) || 0,
      laneId: p.dataset.laneId,
      topic: p.dataset.tabTopic,
      topicSet: p.dataset.tabTopicSet,
      laneLabel: p.dataset.laneLabel,
      active: p.classList.contains("is-active"),
      html: p.querySelector(".vera-reasoning-md-panel")?.innerHTML || "",
    })),
  };
  storage.set(ANON_KEY, JSON.stringify(payload));
  if (typeof sandbox.queueWorkModeWorkspaceSync === "function") {
    sandbox.queueWorkModeWorkspaceSync();
  }
}

let registryCleared = false;
function clearWorkModeLaneRegistry() {
  registryCleared = true;
  for (const k of Object.keys(workModeCompletedReasoningByLaneId)) {
    delete workModeCompletedReasoningByLaneId[k];
  }
}

const pendingTimers = [];
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  document: {
    addEventListener: () => {},
    getElementById(id) {
      if (id === "vera-reasoning-tab-panels") return panelsRoot;
      return null;
    },
    querySelector(sel) {
      if (sel.startsWith("#vera-reasoning-tab-panels")) {
        return panels.find((p) => p.classList.contains("is-active")) || panels[0] || null;
      }
      return null;
    },
  },
  REASONING_TABS_MAX: 8,
  MIN_REASONING_PANELS,
  REASONING_UNTITLED_TAB_NAME: "Untitled",
  workModeCompletedReasoningByLaneId,
  workModeStableLaneIdByIdx,
  isSupabaseUserAuthenticated: () => false,
  getSupabaseAccessToken: async () => null,
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  appModePrefix: () => "vera",
  getReasoningPanelOrder: () =>
    panels.map((p, i) => ({
      laneId: p.dataset.laneId,
      tabIndex: Number(p.dataset.tabIndex),
      label: p.dataset.tabTopic,
      isActive: p.classList.contains("is-active"),
      visualIndex: i + 1,
    })),
  getReasoningPanelElementByLaneId: (laneId) =>
    panels.find((p) => p.dataset.laneId === laneId) || null,
  getReasoningTabTopicLabel: (panel) => panel?.dataset?.tabTopic || "Untitled",
  isGenericAutoRenamableReasoningPanelTitle: (t) => t === "Untitled" || /^Panel \d+$/i.test(String(t || "")),
  initWorkModeStableLaneIdSlots: () => {},
  ensureFixedReasoningLanePanels,
  restoreReasoningTabsState,
  persistReasoningTabsState,
  getReasoningTabsStateStorageKey,
  renderReasoningTabStrip: () => {},
  syncReasoningLaneBusySlotsAfterDomChange: () => {},
  clearWorkModeLaneRegistry,
  restoreVeraChatState: () => {},
  initSupabaseAuth: async () => true,
  setTimeout(fn, ms) {
    const id = { fn, ms, cancelled: false };
    pendingTimers.push(id);
    return id;
  },
  clearTimeout(id) {
    if (id && typeof id === "object") id.cancelled = true;
  },
};
sandbox.window = sandbox;
sandbox.URL = URL;
sandbox.HTMLElement = class HTMLElement {};

vm.createContext(sandbox);

const syncSrc = readFileSync(path.join(root, "workmode/workspaceSync.js"), "utf8");
vm.runInContext(syncSrc, sandbox);

ok(typeof sandbox.clearWorkModeWorkspaceAfterLogout === "function", "clearWorkModeWorkspaceAfterLogout exported");

let cloudStore = {
  client_revision: 10,
  active_lane_id: "cloud-lane-1",
  tabs: [
    {
      lane_id: "cloud-lane-1",
      sort_order: 0,
      title: "Cloud Tab",
      is_active: true,
      registry: { last_user_request: "cloud question", main_context_excerpt: "cloud answer" },
      rendered_html: "<p>Cloud content</p>",
    },
  ],
};

const apiLog = [];
sandbox.authFetch = async (url, init) => {
  const method = init?.method || "GET";
  apiLog.push({ method, url, body: init?.body || null });
  if (url.includes("/api/work-mode/workspace") && method === "DELETE") {
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (url.includes("/api/work-mode/workspace") && method === "PUT") {
    cloudStore = JSON.parse(init.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, tab_count: cloudStore.tabs?.length || 0 }),
      json: async () => ({ ok: true, tab_count: cloudStore.tabs?.length || 0 }),
    };
  }
  if (url.includes("/api/work-mode/workspace") && method === "GET") {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        empty: false,
        client_revision: cloudStore.client_revision,
        active_lane_id: cloudStore.active_lane_id,
        tabs: cloudStore.tabs,
      }),
    };
  }
  return { ok: false, json: async () => ({}) };
};

function flushDebounceTimers() {
  const due = pendingTimers.filter((t) => !t.cancelled);
  pendingTimers.length = 0;
  for (const t of due) {
    try {
      t.fn();
    } catch (_) {}
  }
}

function panelHtmlForLane(laneId) {
  const panel = panels.find((p) => p.dataset.laneId === laneId);
  return panel?.querySelector(".vera-reasoning-md-panel")?.innerHTML || "";
}

// 1. Logged in → cloud workspace visible → logout → cloud content disappears
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "token";
panels.length = 0;
await sandbox.hydrateWorkModeWorkspaceFromServer(true);
ok(panelHtmlForLane("cloud-lane-1").includes("Cloud content"), "logged-in cloud tab visible after hydrate");

sandbox.isSupabaseUserAuthenticated = () => false;
sandbox.getSupabaseAccessToken = async () => null;
registryCleared = false;
apiLog.length = 0;
sandbox.clearWorkModeWorkspaceAfterLogout();
ok(registryCleared, "logout clears lane registry");
ok(!workModeCompletedReasoningByLaneId["cloud-lane-1"], "cloud registry row removed");
ok(!panelHtmlForLane("cloud-lane-1").includes("Cloud content"), "cloud tab HTML cleared after logout");
ok(!apiLog.some((c) => c.method === "DELETE"), "logout does not DELETE workspace");

// 3. Logout cancels pending PUT and does not overwrite Supabase with empty panels
const cloudBeforeLogout = JSON.parse(JSON.stringify(cloudStore));
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "token";
panels.length = 0;
await sandbox.hydrateWorkModeWorkspaceFromServer(true);
apiLog.length = 0;
sandbox.queueWorkModeWorkspaceSync();
sandbox.isSupabaseUserAuthenticated = () => false;
sandbox.getSupabaseAccessToken = async () => null;
sandbox.clearWorkModeWorkspaceAfterLogout();
flushDebounceTimers();
await sandbox.syncWorkModeWorkspaceToSupabaseNow();
const putsAfterLogout = apiLog.filter((c) => c.method === "PUT");
ok(putsAfterLogout.length === 0, "logout cancels pending debounced PUT");
ok(cloudStore.tabs[0]?.rendered_html?.includes("Cloud content"), "Supabase cloud workspace unchanged after logout");

// 4. Logged out → anonymous content → reload restores anonymous workspace
storage.clear();
panels.length = 0;
ensureFixedReasoningLanePanels(new Map(), 0);
panels[0].dataset.laneId = "anon-lane-1";
panels[0].dataset.tabTopic = "Local Tab";
panels[0].querySelector(".vera-reasoning-md-panel").innerHTML = "<p>Local reasoning</p>";
panels[0].classList.toggle("is-active", true);
persistReasoningTabsState();
panels.length = 0;
ensureFixedReasoningLanePanels(new Map(), 0);
restoreReasoningTabsState();
ok(panelHtmlForLane("anon-lane-1").includes("Local reasoning"), "anonymous local workspace restores after reload");

// 5. Logged-out anonymous content does not write to Supabase
apiLog.length = 0;
sandbox.isSupabaseUserAuthenticated = () => false;
persistReasoningTabsState();
flushDebounceTimers();
await sandbox.syncWorkModeWorkspaceToSupabaseNow();
ok(!apiLog.some((c) => c.method === "PUT"), "logged-out persist does not PUT to Supabase");

// 6 + 7. Log back in → cloud replaces anonymous; original cloud intact
const originalCloudHtml = cloudBeforeLogout.tabs[0]?.rendered_html || "";
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "token";
panels.length = 0;
await sandbox.hydrateWorkModeWorkspaceFromServer(true);
ok(panelHtmlForLane("cloud-lane-1").includes("Cloud content"), "login hydrates cloud workspace over anonymous");
ok(!panelHtmlForLane("anon-lane-1").includes("Local reasoning"), "anonymous tab replaced by cloud on login");
ok(cloudStore.tabs[0]?.rendered_html === originalCloudHtml, "original cloud workspace still intact after logout/login");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
