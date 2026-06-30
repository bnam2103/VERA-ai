/**
 * Smoke: checklist Supabase unsynced retry (Phase 4c).
 * Run: node tests/smoke/__checklist_sync_retry_smoke.mjs
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
let putCalls = 0;
let online = true;
let loggedIn = false;
let authToken = null;

const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  navigator: { onLine: true },
  document: {
    visibilityState: "visible",
    addEventListener: () => {},
    getElementById: () => null,
  },
  window: { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {} },
  isSupabaseUserAuthenticated: () => loggedIn,
  getSupabaseAccessToken: async () => authToken,
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  readChecklistItemsFromStorage: () => [{ id: "a", text: "A", done: false }],
  authFetch: async (url, init) => {
    if (url.includes("/api/checklist") && init?.method === "PUT") {
      putCalls += 1;
      if (putCalls === 1) {
        return { ok: false, json: async () => ({ detail: "fail" }) };
      }
      return { ok: true, json: async () => ({ ok: true, items_count: 1 }) };
    }
    return { ok: false, json: async () => ({}) };
  },
};
sandbox.window = sandbox;

vm.createContext(sandbox);

const helperSrc = `
const WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY = "vera_wm_completed";
const WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY = "vera_wm_checklist_supabase_unsynced_v1";
let _checklistSbRetryInFlight = false;
let _checklistSbSaveInFlight = null;
let _checklistSbSyncStatus = "synced";

function _checklistSbIsLoggedIn() { return isSupabaseUserAuthenticated(); }
function _checklistSbIsOnline() { return navigator.onLine !== false; }
function _readLocalChecklistBundleForSupabase() {
  return { items: readChecklistItemsFromStorage(), completed_collapsed: false };
}
function isWorkChecklistSupabaseUnsynced() {
  return localStorage.getItem(WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY) === "1";
}
function _markChecklistSupabaseUnsynced(unsynced) {
  if (unsynced) localStorage.setItem(WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY, "1");
  else localStorage.removeItem(WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY);
}
function _setChecklistSupabaseSyncStatus() {}
function _checklistSbSyncDebugCounts() {
  return { local_count: readChecklistItemsFromStorage().length, unsynced: isWorkChecklistSupabaseUnsynced(), auth_present: true, status: _checklistSbSyncStatus };
}
async function syncWorkChecklistToSupabaseNow() {
  if (!_checklistSbIsLoggedIn()) return false;
  const token = await getSupabaseAccessToken();
  if (!token) { _markChecklistSupabaseUnsynced(true); return false; }
  const bundle = _readLocalChecklistBundleForSupabase();
  const res = await authFetch(authApiUrl("/api/checklist"), { method: "PUT", headers: {}, body: JSON.stringify(bundle) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { _markChecklistSupabaseUnsynced(true); return false; }
  _markChecklistSupabaseUnsynced(false);
  return true;
}
function _checklistSbCanRetry() {
  if (!_checklistSbIsLoggedIn()) return false;
  if (!_checklistSbIsOnline()) return false;
  if (!isWorkChecklistSupabaseUnsynced()) return false;
  return true;
}
async function retryChecklistSupabaseSyncIfUnsynced(reason) {
  if (!_checklistSbCanRetry()) return false;
  if (_checklistSbRetryInFlight) return false;
  _checklistSbRetryInFlight = true;
  try { return await syncWorkChecklistToSupabaseNow(); }
  finally { _checklistSbRetryInFlight = false; }
}
`;

vm.runInContext(helperSrc, sandbox);

loggedIn = true;
authToken = "tok";
putCalls = 0;
await sandbox.syncWorkChecklistToSupabaseNow();
ok(sandbox.isWorkChecklistSupabaseUnsynced(), "failed PUT sets unsynced flag");

const retryOk = await sandbox.retryChecklistSupabaseSyncIfUnsynced("login");
ok(retryOk === true, "login retry clears unsynced on success");
ok(!sandbox.isWorkChecklistSupabaseUnsynced(), "unsynced flag cleared after retry");

storage.set("vera_wm_checklist_supabase_unsynced_v1", "1");
loggedIn = false;
putCalls = 0;
const loggedOutRetry = await sandbox.retryChecklistSupabaseSyncIfUnsynced("login");
ok(loggedOutRetry === false, "retry does not run while logged out");
ok(putCalls === 0, "no PUT while logged out");

loggedIn = true;
authToken = "tok";
sandbox.navigator.onLine = false;
putCalls = 0;
const offlineRetry = await sandbox.retryChecklistSupabaseSyncIfUnsynced("online");
ok(offlineRetry === false, "retry does not run while offline");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
