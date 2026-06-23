/**
 * Smoke: legacy users_files sign-in UI is off by default (Supabase Account only).
 * Run: node tests/smoke/__legacy_signin_ui_smoke.mjs
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

function makeDom() {
  const nodes = new Map();
  const ensure = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, hidden: true, attrs: new Map([["hidden", ""]]) });
    }
    return nodes.get(id);
  };
  return {
    nodes,
    document: {
      querySelector: (sel) => {
        const m = sel.match(/meta\[name="([^"]+)"\]/);
        if (m) return null;
        return null;
      },
      getElementById: (id) => {
        const el = ensure(id);
        return {
          id,
          setAttribute(name, value) {
            el.attrs.set(name, value);
            if (name === "hidden") el.hidden = true;
          },
          removeAttribute(name) {
            el.attrs.delete(name);
            if (name === "hidden") el.hidden = false;
          },
          get hidden() {
            return el.hidden;
          },
          set hidden(v) {
            el.hidden = v;
          },
          addEventListener() {},
          style: { setProperty() {} },
        };
      },
    },
  };
}

function loadSigninUi(extra = {}) {
  const dom = makeDom();
  const sandbox = {
    ...dom,
    window: { ...extra.window },
    console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    getSessionId: () => "sess-test",
    authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
    localBackendBase: () => "http://127.0.0.1:8000",
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    hydrateWorkChecklistFromServer: async () => {},
    setVeraActiveUserLabel: () => {},
    refreshSupabaseAccountLabel: async () => false,
    isSupabaseUserAuthenticated: () => false,
    ...extra,
  };
  sandbox.window = sandbox.window || sandbox;
  vm.createContext(sandbox);
  const signinSrc = readFileSync(path.join(root, "users/signinUi.js"), "utf8");
  vm.runInContext(signinSrc, sandbox);
  return sandbox;
}

// Default: legacy disabled
{
  const sb = loadSigninUi();
  ok(sb.isLegacySignInEnabled() === false, "legacy sign-in disabled by default");
  sb.wireVeraUserSignInHoldAndModal();
  const btn = sb.document.getElementById("vera-user-sign-in");
  ok(btn.hidden === true, "SIGN IN nav stays hidden after wire (default off)");
  const modal = sb.document.getElementById("vera-user-sign-in-modal");
  ok(modal.hidden === true, "legacy modal stays hidden after wire (default off)");
}

// Dev flag enables legacy
{
  const sb = loadSigninUi({ window: { VERA_ENABLE_LEGACY_SIGNIN: true } });
  ok(sb.isLegacySignInEnabled() === true, "VERA_ENABLE_LEGACY_SIGNIN=true enables legacy");
}

// Supabase session blocks legacy reveal even when flag on
{
  const sb = loadSigninUi({
    window: { VERA_ENABLE_LEGACY_SIGNIN: true },
    isSupabaseUserAuthenticated: () => true,
  });
  sb.wireVeraUserSignInHoldAndModal();
  sb.hideLegacySignInUi();
  const btnBefore = sb.document.getElementById("vera-user-sign-in");
  ok(btnBefore.hidden === true, "hideLegacySignInUi keeps SIGN IN hidden");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
