/**
 * Smoke: account settings sync helpers (local collect + hydrate policy).
 * Run: node tests/smoke/__account_settings_sync_smoke.mjs
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
  authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
  document: { querySelector: () => null },
  authFetch: async () => ({ ok: true, json: async () => ({ vera_prefs_v1: {}, empty: true }) }),
  setVeraAsrMode: (m) => storage.set("vera_setting_asr_mode_v1", m),
  setVeraAsrSilenceMs: (n) => storage.set("vera_setting_asr_silence_ms_v1", String(n)),
  setWorkModeMuteEnabled: (on) => storage.set("vera_setting_workmode_mute_v1", on ? "1" : "0"),
  setTextGuideRotatorEnabled: (on) => storage.set("vera_setting_text_guide_rotator_v1", on ? "1" : "0"),
  setMainAsrPartialMinChars: (n) =>
    storage.set("vera_setting_main_asr_partial_min_chars_v1", n === Infinity ? "inf" : String(n)),
  setWorkModeLeftPaneLayout: (l) => storage.set("vera_wm_left_panes_layout_v1", l),
};
sandbox.window = sandbox;
sandbox.URL = URL;

vm.createContext(sandbox);

const syncSrc = readFileSync(path.join(root, "users/accountSettingsSync.js"), "utf8");
vm.runInContext(syncSrc, sandbox);

storage.set("vera_setting_asr_mode_v1", "hybrid");
storage.set("vera_setting_asr_silence_ms_v1", "1300");
storage.set("vera_setting_workmode_mute_v1", "1");
storage.set("vera_setting_text_guide_rotator_v1", "0");
storage.set("vera_setting_main_asr_partial_min_chars_v1", "2");
storage.set("vera_wm_left_panes_layout_v1", "split");

const local = sandbox.collectLocalVeraPrefs();
ok(local.asr_mode === "hybrid", "collectLocalVeraPrefs reads asr_mode");
ok(local.workmode_mute === true, "collectLocalVeraPrefs reads workmode_mute");
ok(local.text_guide_rotator === false, "collectLocalVeraPrefs reads text_guide_rotator");

let patchCalls = 0;
sandbox.isSupabaseUserAuthenticated = () => true;
sandbox.authFetch = async (url, init) => {
  if (url.includes("/api/settings") && init?.method === "GET") {
    return {
      ok: true,
      json: async () => ({
        vera_prefs_v1: { asr_mode: "whisper", asr_silence_ms: 1600, workmode_mute: false },
        empty: false,
      }),
    };
  }
  if (url.includes("/api/settings") && init?.method === "PATCH") {
    patchCalls += 1;
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: false, json: async () => ({}) };
};

await sandbox.hydrateVeraSettingsFromSupabase();
ok(storage.get("vera_setting_asr_mode_v1") === "whisper", "hydrate applies remote asr_mode to localStorage");
ok(patchCalls === 0, "hydrate with remote prefs does not PATCH");

patchCalls = 0;
sandbox.authFetch = async (url, init) => {
  if (init?.method === "GET") {
    return { ok: true, json: async () => ({ vera_prefs_v1: {}, empty: true }) };
  }
  if (init?.method === "PATCH") {
    patchCalls += 1;
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return { ok: false, json: async () => ({}) };
};
await sandbox.hydrateVeraSettingsFromSupabase();
ok(patchCalls === 1, "empty remote seeds from local via PATCH");

sandbox.isSupabaseUserAuthenticated = () => false;
patchCalls = 0;
await sandbox.syncLocalVeraPrefsToSupabase("test");
ok(patchCalls === 0, "logged out does not PATCH");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
