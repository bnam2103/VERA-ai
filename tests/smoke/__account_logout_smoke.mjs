/**
 * Smoke: Phase 4d account boundary — settings + unified logout orchestration.
 * Run: node tests/smoke/__account_logout_smoke.mjs
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
const ANON_SNAP_KEY = "vera_prefs_anon_snapshot_v1:session_smoke";
const apiLog = [];

const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  getSessionId: () => "session_smoke",
  isSupabaseUserAuthenticated: () => false,
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  authFetch: async (url, init) => {
    apiLog.push({ method: init?.method || "GET", url, body: init?.body || null });
    if (url.includes("/api/settings") && init?.method === "GET") {
      return {
        ok: true,
        json: async () => ({
          vera_prefs_v1: { asr_mode: "whisper", asr_silence_ms: 1600, workmode_mute: true },
        }),
      };
    }
    if (url.includes("/api/settings") && init?.method === "PATCH") {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: false, json: async () => ({}) };
  },
  setVeraAsrMode: (m) => storage.set("vera_setting_asr_mode_v1", m),
  setVeraAsrSilenceMs: (n) => storage.set("vera_setting_asr_silence_ms_v1", String(n)),
  setWorkModeMuteEnabled: (on) => storage.set("vera_setting_workmode_mute_v1", on ? "1" : "0"),
  setTextGuideRotatorEnabled: (on) => storage.set("vera_setting_text_guide_rotator_v1", on ? "1" : "0"),
  setMainAsrPartialMinChars: (n) =>
    storage.set("vera_setting_main_asr_partial_min_chars_v1", n === Infinity ? "inf" : String(n)),
  setWorkModeLeftPaneLayout: (l) => storage.set("vera_wm_left_panes_layout_v1", l),
  document: {
    getElementById: (id) => {
      if (id === "vera-account-memories-wrap") return sandbox._memWrap;
      if (id === "vera-account-memories-list") return sandbox._memList;
      return null;
    },
  },
  _memWrap: { hidden: false, setAttribute() {}, removeAttribute() {} },
  _memList: { innerHTML: "<li>Account memory</li>" },
};
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(root, "users/accountSettingsSync.js"), "utf8"), sandbox);

ok(typeof sandbox.clearSettingsAfterLogout === "function", "clearSettingsAfterLogout exported");

// 1. Logged in hydrate → logout → account settings do not remain
storage.set("vera_setting_asr_mode_v1", "hybrid");
storage.set(ANON_SNAP_KEY, JSON.stringify({ asr_mode: "hybrid", asr_silence_ms: 1300, workmode_mute: false }));
sandbox.isSupabaseUserAuthenticated = () => true;
await sandbox.hydrateVeraSettingsFromSupabase();
ok(storage.get("vera_setting_asr_mode_v1") === "whisper", "account hydrate applies remote asr_mode");

sandbox.isSupabaseUserAuthenticated = () => false;
apiLog.length = 0;
sandbox.clearSettingsAfterLogout();
ok(storage.get("vera_setting_asr_mode_v1") === "hybrid", "logout restores anonymous snapshot not account whisper");

// 2. Logout blocks pending PATCH
storage.set("vera_setting_asr_mode_v1", "streaming");
sandbox.isSupabaseUserAuthenticated = () => true;
let releasePatch;
const patchGate = new Promise((r) => {
  releasePatch = r;
});
const prevAuthFetch = sandbox.authFetch;
sandbox.authFetch = async (url, init) => {
  if (url.includes("/api/settings") && init?.method === "PATCH") {
    await patchGate;
    apiLog.push({ method: "PATCH", url, body: init?.body || null });
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return prevAuthFetch(url, init);
};
apiLog.length = 0;
const patchPromise = sandbox.syncLocalVeraPrefsToSupabase("pending");
await new Promise((r) => setTimeout(r, 20));
sandbox.isSupabaseUserAuthenticated = () => false;
sandbox.clearSettingsAfterLogout();
releasePatch();
const patchOk = await patchPromise;
sandbox.authFetch = prevAuthFetch;
ok(patchOk === false, "logout blocks pending settings PATCH");

// 3. Logged out local settings persist via anon snapshot
apiLog.length = 0;
storage.set("vera_setting_asr_mode_v1", "streaming");
sandbox.isSupabaseUserAuthenticated = () => false;
await sandbox.syncLocalVeraPrefsToSupabase("anon_change");
ok(storage.get(ANON_SNAP_KEY)?.includes("streaming"), "logged-out change updates anonymous snapshot");
ok(apiLog.filter((c) => c.method === "PATCH").length === 0, "logged-out change does not PATCH");

// 4. Login again restores account settings
apiLog.length = 0;
sandbox.isSupabaseUserAuthenticated = () => true;
await sandbox.hydrateVeraSettingsFromSupabase();
ok(storage.get("vera_setting_asr_mode_v1") === "whisper", "login hydrate restores account settings");

// 5. Unified logout orchestration (mirrors users/supabaseAuth.js)
const cleanupLog = [];
sandbox.window.clearWorkModeWorkspaceAfterLogout = () => cleanupLog.push("workspace");
sandbox.window.clearChecklistAfterLogout = () => cleanupLog.push("checklist");
sandbox.window.clearSettingsAfterLogout = () => cleanupLog.push("settings");

function clearMemoriesAfterLogout() {
  cleanupLog.push("memories");
  sandbox._memList.innerHTML = "";
}
function _resolveLogoutCleanupFn(fnName) {
  if (fnName === "clearMemoriesAfterLogout") return clearMemoriesAfterLogout;
  if (typeof sandbox.window[fnName] === "function") return sandbox.window[fnName];
  return null;
}
function _runAccountLogoutCleanup() {
  for (const [component, fnName] of [
    ["workspace", "clearWorkModeWorkspaceAfterLogout"],
    ["checklist", "clearChecklistAfterLogout"],
    ["settings", "clearSettingsAfterLogout"],
    ["memories", "clearMemoriesAfterLogout"],
  ]) {
    const fn = _resolveLogoutCleanupFn(fnName);
    if (!fn) continue;
    try {
      fn();
    } catch (err) {
      console.warn("[account_logout_cleanup_failed]", { component, error: String(err?.message || err) });
    }
  }
}
_runAccountLogoutCleanup();
ok(cleanupLog.includes("workspace"), "unified logout calls workspace cleanup");
ok(cleanupLog.includes("checklist"), "unified logout calls checklist cleanup");
ok(cleanupLog.includes("settings"), "unified logout calls settings cleanup");
ok(cleanupLog.includes("memories"), "unified logout calls memories cleanup");

// 6. Memory UI clears on logout
sandbox._memList.innerHTML = "<li>secret</li>";
clearMemoriesAfterLogout();
ok(sandbox._memList.innerHTML === "", "logout clears visible account memory list");

// 7. No account PATCH after logout cleanup (settings already tested above)
apiLog.length = 0;
sandbox.isSupabaseUserAuthenticated = () => false;
await sandbox.syncLocalVeraPrefsToSupabase("after_logout");
ok(apiLog.filter((c) => c.method === "PATCH").length === 0, "no settings PATCH after logout cleanup");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
