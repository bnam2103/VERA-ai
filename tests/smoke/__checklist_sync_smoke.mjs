/**
 * Smoke: checklist Supabase sync helpers (merge-on-login + background save).
 * Run: node tests/smoke/__checklist_sync_smoke.mjs
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
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  isSupabaseUserAuthenticated: () => false,
  getSupabaseAccessToken: async () => null,
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  readChecklistItemsFromStorage: () => {
    try {
      const raw = storage.get("vera_wm_checklist_v1") || "[]";
      return JSON.parse(raw);
    } catch {
      return [];
    }
  },
  loadWorkChecklistItems: () => {},
  applyWorkChecklistCompletedCollapseFromStorage: () => {},
  queueWorkChecklistSyncToServer: () => {},
};
sandbox.window = sandbox;
sandbox.URL = URL;

vm.createContext(sandbox);

const syncSrc = readFileSync(path.join(root, "users/checklistSupabaseSync.js"), "utf8");
vm.runInContext(syncSrc, sandbox);

let apiCalls = 0;
sandbox.authFetch = async () => {
  apiCalls += 1;
  return { ok: true, json: async () => ({ ok: true }) };
};

await sandbox.syncWorkChecklistToSupabaseNow();
ok(apiCalls === 0, "logged-out sync makes no API calls");

sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.getSupabaseAccessToken = async () => "test-token";
apiCalls = 0;
storage.set("vera_wm_checklist_v1", JSON.stringify([{ id: "1", text: "Eggs", done: false }]));
storage.set("vera_wm_checklist_completed_collapsed_v1", "0");

sandbox.authFetch = async (url, init) => {
  apiCalls += 1;
  if (url.includes("/api/checklist/merge") && init?.method === "POST") {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        items: [
          ...body.items,
          { id: "r1", text: "Remote task", done: true },
        ],
        completed_collapsed: false,
        remote_count: 0,
      }),
    };
  }
  if (url.includes("/api/checklist") && init?.method === "PUT") {
    return { ok: true, json: async () => ({ ok: true, items_count: 1 }) };
  }
  return { ok: false, json: async () => ({}) };
};

let loaded = false;
sandbox.loadWorkChecklistItems = () => {
  loaded = true;
};

await sandbox.hydrateChecklistMergeOnLogin();
const merged = JSON.parse(storage.get("vera_wm_checklist_v1") || "[]");
ok(merged.length === 2, "merge hydrate applies merged items to localStorage");
ok(loaded, "merge hydrate reloads checklist UI");
ok(!sandbox.isWorkChecklistSupabaseUnsynced(), "successful merge clears unsynced flag");

apiCalls = 0;
await sandbox.syncWorkChecklistToSupabaseNow();
ok(apiCalls === 1, "logged-in PUT saves checklist");

sandbox.isSupabaseUserAuthenticated = () => false;
apiCalls = 0;
await sandbox.syncWorkChecklistToSupabaseNow();
ok(apiCalls === 0, "logout stops Supabase writes");

sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.authFetch = async () => {
  apiCalls += 1;
  return { ok: false, json: async () => ({ detail: "fail" }) };
};
apiCalls = 0;
await sandbox.syncWorkChecklistToSupabaseNow();
ok(apiCalls === 1, "PUT attempted when logged in");
ok(sandbox.isWorkChecklistSupabaseUnsynced(), "failed PUT marks unsynced");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
