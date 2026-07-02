/**
 * Smoke: Work Mode workspace Supabase sync (reasoning tabs only).
 * Run: node tests/smoke/__workspace_sync_smoke.mjs
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
      if (sel === ".vera-reasoning-md-panel") return scroll;
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
  MIN_REASONING_PANELS: 3,
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
  ensureFixedReasoningLanePanels: (savedByIdx, activeIdx) => {
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
  },
  renderReasoningTabStrip: () => {},
  syncReasoningLaneBusySlotsAfterDomChange: () => {},
  restoreVeraChatState: () => {
    sandbox._chatRestored = true;
  },
  initSupabaseAuth: async () => true,
};
sandbox.window = sandbox;
sandbox.URL = URL;
sandbox.HTMLElement = class HTMLElement {};
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;

const MIN_REASONING_PANELS = sandbox.MIN_REASONING_PANELS;

vm.createContext(sandbox);

const syncSrc = readFileSync(path.join(root, "workmode/workspaceSync.js"), "utf8");
vm.runInContext(syncSrc, sandbox);

ok(sandbox.__veraWorkspaceSyncReady === true, "__veraWorkspaceSyncReady after load");
ok(typeof sandbox.hydrateWorkModeWorkspaceFromServer === "function", "hydrate exported on window");

let apiCalls = 0;
let lastPutBody = null;
sandbox.authFetch = async (url, init) => {
  apiCalls += 1;
  if (url.includes("/api/work-mode/workspace") && init?.method === "PUT") {
    lastPutBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ ok: true, tab_count: lastPutBody.tabs?.length || 0 }) };
  }
  return { ok: false, json: async () => ({}) };
};

await sandbox.syncWorkModeWorkspaceToSupabaseNow();
ok(apiCalls === 0, "logged-out sync makes no API calls");

sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "test-token";
panels.push(
  makePanel("lane-1", 0, { active: true, html: "<p>One</p>", title: "First" }),
  makePanel("lane-2", 1, { html: "<p>Two</p>", title: "Second" })
);
workModeCompletedReasoningByLaneId["lane-1"] = {
  lane_id: "lane-1",
  last_user_request: "explain one",
  main_context_excerpt: "answer one",
};
for (let i = 2; i < 10; i += 1) {
  panels.push(makePanel(`lane-extra-${i}`, i, { title: `Tab ${i}` }));
}

apiCalls = 0;
await sandbox.syncWorkModeWorkspaceToSupabaseNow();
ok(apiCalls === 1, "logged-in PUT saves workspace");
ok(Array.isArray(lastPutBody?.tabs), "PUT body includes tabs");
ok(lastPutBody.tabs.length <= sandbox.REASONING_TABS_MAX, "snapshot caps tabs at REASONING_TABS_MAX");
ok(lastPutBody.active_lane_id === "lane-1", "active lane included in snapshot");

const contentTab = lastPutBody.tabs.find((t) => t.lane_id === "lane-1");
ok(contentTab && contentTab.closed === false, "content tab not marked closed");

sandbox.isSupabaseUserAuthenticated = () => false;
sandbox._chatRestored = false;
await sandbox.scheduleDeferredVeraChatRestoreIfAnonymous();
ok(sandbox._chatRestored === true, "anonymous user restores voice chat");

sandbox.isSupabaseUserAuthenticated = () => true;
sandbox._chatRestored = false;
await sandbox.scheduleDeferredVeraChatRestoreIfAnonymous();
ok(sandbox._chatRestored !== true, "logged-in user skips voice chat restore");

ok(sandbox.shouldSkipLocalReasoningTabsRestoreForCloud() === true, "logged-in skips local tab restore");

apiCalls = 0;
let hydrateApplied = false;
sandbox.ensureFixedReasoningLanePanels = (savedByIdx, activeIdx) => {
  hydrateApplied = savedByIdx.size > 0;
  sandbox.ensureFixedReasoningLanePanels = sandbox.ensureFixedReasoningLanePanels;
};
sandbox.authFetch = async (url, init) => {
  apiCalls += 1;
  if (url.includes("/api/work-mode/workspace") && (!init || init.method === "GET")) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        empty: false,
        active_lane_id: "lane-z",
        client_revision: 5,
        tabs: [
          {
            lane_id: "lane-z",
            sort_order: 0,
            title: "Cloud Topic",
            is_active: true,
            registry: { last_user_request: "cloud q", main_context_excerpt: "cloud a" },
            rendered_html: "<p>Cloud</p>",
          },
        ],
      }),
    };
  }
  return { ok: false, json: async () => ({}) };
};

panels.length = 0;
const applied = await sandbox.hydrateWorkModeWorkspaceFromServer(true);
ok(applied === true, "cloud hydrate applies workspace");
ok(workModeCompletedReasoningByLaneId["lane-z"]?.last_user_request === "cloud q", "registry hydrated for follow-up");

panels.length = 0;
sandbox.authFetch = async () => ({
  ok: true,
  json: async () => ({
    ok: true,
    empty: false,
    active_lane_id: "lane-z",
    tabs: [
      {
        lane_id: "lane-z",
        sort_order: 0,
        title: "Cloud Topic",
        is_active: true,
        closed: true,
        registry: {},
        rendered_html: "",
      },
    ],
  }),
});
await sandbox.hydrateWorkModeWorkspaceFromServer(true);
const snapAfterClose = sandbox.buildWorkModeWorkspaceSnapshot();
const closedOnly = (snapAfterClose?.tabs || []).filter((t) => t.lane_id === "lane-z");
ok(!closedOnly.length || closedOnly[0].closed === true, "closed tab saved as closed");

sandbox.authFetch = async () => ({ ok: false, json: async () => ({ detail: "fail" }) });
apiCalls = 0;
await sandbox.syncWorkModeWorkspaceToSupabaseNow();
ok(sandbox.isWorkModeWorkspaceUnsynced(), "failed PUT marks unsynced");
ok(sandbox.getWorkModeWorkspaceSyncDebugState().status === "failed", "failed PUT sets failed status");

sandbox.getSupabaseAccessToken = async () => null;
storage.delete("vera_wm_workspace_unsynced_v1");
await sandbox.syncWorkModeWorkspaceToSupabaseNow();
ok(sandbox.isWorkModeWorkspaceUnsynced(), "missing token marks unsynced");

sandbox.getSupabaseAccessToken = async () => "test-token";
sandbox.authFetch = async (url, init) => {
  if (url.includes("/api/work-mode/workspace") && init?.method === "PUT") {
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
      json: async () => ({ ok: true }),
    };
  }
  return { ok: false, text: async () => "{}", json: async () => ({}) };
};
storage.delete("vera_wm_workspace_unsynced_v1");
sandbox.queueWorkModeWorkspaceSync();
ok(sandbox.isWorkModeWorkspaceUnsynced(), "queueWorkModeWorkspaceSync marks pending unsynced");
await sandbox.syncWorkModeWorkspaceToSupabaseNow();
ok(!sandbox.isWorkModeWorkspaceUnsynced(), "successful sync clears unsynced");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
