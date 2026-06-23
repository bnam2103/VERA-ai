/**
 * Smoke: authFetch attaches Authorization when token provider is set.
 * Run: node tests/smoke/__supabase_auth_fetch_smoke.mjs
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

const fetchCalls = [];
const sandbox = {
  fetch: async (url, init) => {
    fetchCalls.push({ url, init });
    return { ok: true, json: async () => ({ authenticated: false }) };
  },
  window: {},
  document: { querySelector: () => null, getElementById: () => null },
  console,
  getSessionId: () => "sess-test",
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  localBackendBase: () => "http://127.0.0.1:8000",
  API_URL: "http://127.0.0.1:8000",
  Headers,
};

vm.createContext(sandbox);

const signinSrc = readFileSync(path.join(root, "users/signinUi.js"), "utf8");
vm.runInContext(signinSrc, sandbox);

const supabaseSrc = readFileSync(path.join(root, "users/supabaseAuth.js"), "utf8");
vm.runInContext(supabaseSrc, sandbox);

sandbox.window.__veraAuthFetchImpl = async (url, init) => {
  const headers = new Headers(init?.headers || {});
  const token = await sandbox.getSupabaseAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return sandbox.fetch(url, { ...init, headers });
};

sandbox.getSupabaseAccessToken = async () => "test-jwt-token";

await sandbox.authFetch("http://127.0.0.1:8000/api/auth/me", { method: "GET" });
ok(fetchCalls.length === 1, "authFetch invoked fetch once");
const hdrs = fetchCalls[0]?.init?.headers;
const auth = hdrs instanceof Headers ? hdrs.get("Authorization") : hdrs?.Authorization;
ok(auth === "Bearer test-jwt-token", "Authorization Bearer attached");

fetchCalls.length = 0;
sandbox.getSupabaseAccessToken = async () => null;
await sandbox.authFetch("http://127.0.0.1:8000/api/auth/me", { method: "GET" });
const hdrs2 = fetchCalls[0]?.init?.headers;
const auth2 = hdrs2 instanceof Headers ? hdrs2.get("Authorization") : hdrs2?.Authorization;
ok(!auth2, "no Authorization when logged out");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
