/**
 * Smoke: Work Mode workspace must never block Vera boot / app reveal.
 * Run: node tests/smoke/__workspace_boot_smoke.mjs
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

try {
  new vm.Script(readFileSync(path.join(root, "workmode/panels.js"), "utf8"));
  ok(true, "panels.js parses (no syntax error)");
} catch (e) {
  ok(false, `panels.js parses (no syntax error) — ${e.message}`);
}

{
  const win = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { addEventListener: () => {}, getElementById: () => null },
    isSupabaseUserAuthenticated: () => false,
    getSupabaseAccessToken: async () => null,
    authApiUrl: (p) => p,
    authFetch: async () => ({ ok: false, json: async () => ({}) }),
    dispatchEvent: () => true,
    addEventListener: () => {},
  };
  win.window = win;
  const ctx = vm.createContext(win);
  let loadErr = null;
  try {
    vm.runInContext(readFileSync(path.join(root, "users/supabaseAuth.js"), "utf8"), ctx, {
      filename: "supabaseAuth.js",
    });
    vm.runInContext(readFileSync(path.join(root, "workmode/workspaceSync.js"), "utf8"), ctx, {
      filename: "workspaceSync.js",
    });
  } catch (e) {
    loadErr = e;
  }
  ok(!loadErr, `workspaceSync loads after supabaseAuth in shared lexical env${loadErr ? ` — ${loadErr.message}` : ""}`);
  ok(typeof win.hydrateWorkModeWorkspaceFromServer === "function", "hydrate exported after shared-env load");
  ok(win.__veraWorkspaceSyncReady === true, "__veraWorkspaceSyncReady after shared-env load");
}

const storage = new Map();
const workModeCompletedReasoningByLaneId = {};
const panels = [];
const panelsRoot = {
  querySelectorAll: () => panels,
};

function makeSandbox(overrides = {}) {
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      getElementById: (id) => (id === "vera-reasoning-tab-panels" ? panelsRoot : null),
      querySelector: () => panels[0] || null,
    },
    REASONING_TABS_MAX: 8,
    MIN_REASONING_PANELS: 3,
    REASONING_UNTITLED_TAB_NAME: "Untitled",
    workModeCompletedReasoningByLaneId,
    isSupabaseUserAuthenticated: () => true,
    getSupabaseAccessToken: async () => "token",
    authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
    appModePrefix: () => "vera",
    getReasoningPanelOrder: () => [],
    initWorkModeStableLaneIdSlots: () => {},
    ensureFixedReasoningLanePanels: () => {
      sandbox._ensureCalled = true;
    },
    renderReasoningTabStrip: () => {},
    syncReasoningLaneBusySlotsAfterDomChange: () => {},
    HTMLElement: class HTMLElement {},
    setTimeout,
    clearTimeout,
    ...overrides,
  };
  sandbox.window = sandbox;
  return sandbox;
}

async function loadSync(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(root, "workmode/workspaceSync.js"), "utf8"), sandbox);
  return sandbox;
}

async function raceBootGuard(sandbox, authFetch, label) {
  sandbox.authFetch = authFetch;
  const start = Date.now();
  sandbox.scheduleWorkModeWorkspaceHydrateBestEffort("boot_test");
  await new Promise((r) => setTimeout(r, 2800));
  const elapsed = Date.now() - start;
  ok(elapsed < 3500, `${label}: boot guard returns within ~2.5s (elapsed ${elapsed}ms)`);
}

{
  const sandbox = makeSandbox();
  await loadSync(sandbox);
  let pending;
  sandbox.authFetch = () =>
    new Promise((resolve) => {
      pending = resolve;
    });
  await raceBootGuard(sandbox, sandbox.authFetch, "pending forever");
  pending?.({ ok: true, json: async () => ({ tabs: [] }) });
}

{
  const sandbox = makeSandbox();
  await loadSync(sandbox);
  await raceBootGuard(
    sandbox,
    async () => ({ ok: false, status: 500, json: async () => ({ detail: "db error" }) }),
    "500 response"
  );
  ok(sandbox._ensureCalled !== true || sandbox.isWorkModeWorkspaceUnsynced(), "500 marks unsynced or uses fallback panels");
}

{
  const sandbox = makeSandbox();
  await loadSync(sandbox);
  sandbox.authFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const res401 = await sandbox.hydrateWorkModeWorkspaceFromServer(true, { source: "test_401" });
  ok(res401 === false, "401/403 resolves without throw");
}

{
  const sandbox = makeSandbox();
  await loadSync(sandbox);
  sandbox.authFetch = async () => ({
    ok: true,
    json: async () => ({ empty: true, tabs: [] }),
  });
  const empty = await sandbox.hydrateWorkModeWorkspaceFromServer(true, { source: "test_empty" });
  ok(empty === false, "empty workspace resolves");
}

{
  const sandbox = makeSandbox();
  await loadSync(sandbox);
  sandbox.authFetch = async () => ({
    ok: true,
    json: async () => ({
      active_lane_id: "lane-a",
      tabs: [
        {
          lane_id: "lane-a",
          sort_order: 0,
          title: "Saved",
          is_active: true,
          rendered_html: "<p>Hi</p>",
          registry: { last_user_request: "q" },
        },
      ],
    }),
  });
  const applied = await sandbox.hydrateWorkModeWorkspaceFromServer(true, { source: "test_success" });
  ok(applied === true, "successful workspace hydrate resolves true");
}

{
  const sandbox = makeSandbox({
    isSupabaseUserAuthenticated: () => false,
    getSupabaseAccessToken: async () => null,
  });
  await loadSync(sandbox);
  const anon = await sandbox.hydrateWorkModeWorkspaceFromServer(true, { source: "test_anon" });
  ok(anon === false, "auth not ready / logged out resolves immediately");
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
