/**
 * Smoke: checklist logout / account boundary + reload restore.
 * Run: node tests/smoke/__checklist_logout_smoke.mjs
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
const ACCOUNT_KEY = "vera_wm_checklist_v1";
const ANON_KEY = "vera_checklist_state:anon:session_smoke";
const ACCOUNT_COLLAPSED = "vera_wm_checklist_completed_collapsed_v1";
const UNSYNCED_KEY = "vera_wm_checklist_supabase_unsynced_v1";

const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  isSupabaseUserAuthenticated: () => false,
  getSupabaseAccessToken: async () => null,
  getSessionId: () => "session_smoke",
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  stripChecklistPlaceholdersForPersist: (items) =>
    Array.isArray(items) ? items.filter((row) => row && row.text) : [],
  loadWorkChecklistItems: () => {
    sandbox._uiLoaded = true;
    sandbox.uiItems = sandbox.readChecklistItemsFromStorage();
  },
  applyWorkChecklistCompletedCollapseFromStorage: () => {},
  document: {
    addEventListener: () => {},
    visibilityState: "visible",
    getElementById: () => null,
  },
  setTimeout,
  clearTimeout,
  window: null,
  _uiLoaded: false,
  uiItems: [],
};
sandbox.window = sandbox;

vm.createContext(sandbox);

const checklistSrc = readFileSync(path.join(root, "workmode/checklist.js"), "utf8").replace(/\r\n/g, "\n");
const storageStart = checklistSrc.indexOf('const WORK_CHECKLIST_STORAGE_KEY = "vera_wm_checklist_v1";');
const storageEnd = checklistSrc.indexOf("/* =========================\n   CLOSE-PANEL DISAMBIGUATION");
const syncStart = checklistSrc.indexOf('console.info("[checklist_supabase_sync_loaded]");');
const syncEnd = checklistSrc.indexOf("wireChecklistSupabaseRetryListeners();");
if (storageStart < 0 || storageEnd < 0 || syncStart < 0 || syncEnd < 0) {
  console.error("Could not locate checklist blocks for smoke harness");
  process.exit(2);
}

vm.runInContext(
  checklistSrc.slice(storageStart, storageEnd) +
    checklistSrc.slice(syncStart, syncEnd) +
    `
try {
  window.clearChecklistAfterLogout = clearChecklistAfterLogout;
  window.hydrateWorkChecklistFromServer = hydrateWorkChecklistFromServer;
  window.restoreAnonymousChecklistFromLocalStorage = restoreAnonymousChecklistFromLocalStorage;
  window._persistChecklistItemsToStorage = _persistChecklistItemsToStorage;
  window._applyChecklistBundleToLocalForSupabase = _applyChecklistBundleToLocalForSupabase;
} catch (_) {}
`,
  sandbox
);

ok(typeof sandbox.clearChecklistAfterLogout === "function", "clearChecklistAfterLogout available");
ok(typeof sandbox.hydrateWorkChecklistFromServer === "function", "hydrateWorkChecklistFromServer available");

let cloudStore = [{ id: "acc-1", text: "Account task", done: false }];
const apiLog = [];
sandbox.authFetch = async (url, init) => {
  const method = init?.method || "GET";
  apiLog.push({ method, url, body: init?.body || null });
  if (url.includes("/api/work-mode/checklist") && method === "GET") {
    return {
      ok: true,
      json: async () => ({ items: cloudStore, completed_collapsed: false }),
    };
  }
  if (url.includes("/api/checklist") && method === "DELETE") {
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (url.includes("/api/checklist/merge") && method === "POST") {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        items: [...body.items, ...cloudStore],
        completed_collapsed: false,
        remote_count: cloudStore.length,
      }),
    };
  }
  if (url.includes("/api/checklist") && method === "PUT") {
    cloudStore = JSON.parse(init.body).items;
    return { ok: true, json: async () => ({ ok: true, items_count: cloudStore.length }) };
  }
  return { ok: false, json: async () => ({}) };
};

function anonBundle(items) {
  return JSON.stringify({
    auth_mode: "anonymous",
    session_id: "session_smoke",
    saved_at: Date.now(),
    items,
  });
}

// 1. Logged in → account checklist visible → logout → disappears
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "token";
storage.set(ACCOUNT_KEY, JSON.stringify(cloudStore));
sandbox.loadWorkChecklistItems();
ok(sandbox.readChecklistItemsFromStorage().length === 1, "account checklist visible when logged in");

sandbox.isSupabaseUserAuthenticated = () => false;
sandbox.getSupabaseAccessToken = async () => null;
storage.set(ANON_KEY, anonBundle([]));
apiLog.length = 0;
sandbox.clearChecklistAfterLogout();
ok(sandbox.readChecklistItemsFromStorage().length === 0, "logout clears visible account checklist");
ok(!apiLog.some((c) => c.method === "DELETE"), "logout does not DELETE checklist rows");

// 2. Logout → reload while logged out → account checklist does not reappear
storage.set(ACCOUNT_KEY, JSON.stringify(cloudStore));
storage.set(ANON_KEY, JSON.stringify(cloudStore));
apiLog.length = 0;
await sandbox.hydrateWorkChecklistFromServer();
ok(sandbox.readChecklistItemsFromStorage().length === 0, "reload restore ignores polluted anon account snapshot");
ok(!apiLog.some((c) => c.url.includes("/api/work-mode/checklist")), "logged-out boot does not GET session checklist");

// 7. Old shared account snapshot with auth_mode !== anonymous is ignored
storage.set(
  ANON_KEY,
  JSON.stringify({
    auth_mode: "account",
    session_id: "session_smoke",
    items: cloudStore,
  })
);
await sandbox.restoreAnonymousChecklistFromLocalStorage();
ok(sandbox.readChecklistItemsFromStorage().length === 0, "account auth_mode snapshot ignored while logged out");

// 3–4. Anonymous local persists, no Supabase writes
storage.clear();
apiLog.length = 0;
sandbox.isSupabaseUserAuthenticated = () => false;
storage.set(ANON_KEY, anonBundle([{ id: "loc-1", text: "Local eggs", done: false }]));
sandbox.loadWorkChecklistItems();
ok(sandbox.readChecklistItemsFromStorage()[0]?.text === "Local eggs", "anonymous checklist restores");
ok(!storage.has(ACCOUNT_KEY), "anonymous items not stored in account localStorage key");
apiLog.length = 0;
await sandbox.syncWorkChecklistToSupabaseNow();
ok(!apiLog.some((c) => c.method === "PUT"), "logged-out checklist does not PUT to Supabase");

// reload anonymous item
sandbox.loadWorkChecklistItems();
await sandbox.hydrateWorkChecklistFromServer();
ok(sandbox.readChecklistItemsFromStorage()[0]?.text === "Local eggs", "anonymous checklist survives reload hydrate");

// Logout blocks pending PUT
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "token";
storage.set(ACCOUNT_KEY, JSON.stringify(cloudStore));
const cloudBefore = JSON.parse(JSON.stringify(cloudStore));
sandbox.queueWorkChecklistSyncToServer();
sandbox.isSupabaseUserAuthenticated = () => false;
sandbox.clearChecklistAfterLogout();
await new Promise((r) => setTimeout(r, 250));
await sandbox.syncWorkChecklistToSupabaseNow();
const putsAfterLogout = apiLog.filter((c) => c.method === "PUT");
ok(putsAfterLogout.length === 0, "logout blocks pending account checklist PUT");
ok(cloudStore[0]?.text === cloudBefore[0]?.text, "Supabase checklist unchanged after logout");

// 6. Account hydrate does not write to anonymous localStorage key
storage.clear();
cloudStore = [{ id: "acc-1", text: "Account task", done: false }];
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "token";
sandbox._applyChecklistBundleToLocalForSupabase(cloudStore, false);
ok(storage.has(ACCOUNT_KEY), "account hydrate writes account key");
const anonAfterHydrate = storage.get(ANON_KEY);
ok(!anonAfterHydrate || !anonAfterHydrate.includes("Account task"), "account hydrate does not write anonymous key");

// 5. Login restores account checklist; anon kept separate
storage.set(ANON_KEY, anonBundle([{ id: "loc-2", text: "Local only", done: false }]));
cloudStore = [{ id: "acc-1", text: "Account task", done: false }];
apiLog.length = 0;
await sandbox.hydrateChecklistMergeOnLogin();
const afterLogin = JSON.parse(storage.get(ACCOUNT_KEY) || "[]");
ok(afterLogin.some((r) => r.text === "Account task"), "login restores account checklist");
ok(
  sandbox.readChecklistItemsFromStorage().some((r) => r.text === "Account task"),
  "logged-in active view serves account checklist"
);
ok(storage.get(ANON_KEY)?.includes("Local only"), "anonymous snapshot kept separate from account key");
ok(cloudStore.some((r) => r.text === "Account task"), "original cloud checklist intact");

// logged-out persist uses anonymous bundle format
sandbox.isSupabaseUserAuthenticated = () => false;
sandbox._persistChecklistItemsToStorage([{ id: "loc-3", text: "Fresh anon", done: false }]);
const anonPersisted = JSON.parse(storage.get(ANON_KEY) || "{}");
ok(anonPersisted.auth_mode === "anonymous", "logged-out persist writes anonymous bundle auth_mode");
ok(anonPersisted.items?.[0]?.text === "Fresh anon", "logged-out persist stores items in anonymous bundle");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
