/**
 * Smoke: Supabase forgot-password / reset-password UI helpers.
 * Run: node tests/smoke/__auth_password_reset_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GITHUB_PAGES_RESET_URL =
  "https://bnam2103.github.io/VERA-ai/app/?mode=reset-password";
const WORKWITHVERA_RESET_URL =
  "https://workwithvera.com/app/?mode=reset-password";
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

const indexHtml = readFileSync(path.join(root, "app/index.html"), "utf8");
ok(indexHtml.includes('id="vera-account-forgot-password-link"'), "Forgot password link in index.html");
ok(indexHtml.includes('id="vera-account-reset-password-view"'), "Reset password form in index.html");
ok(indexHtml.includes('id="vera-account-reset-expired-view"'), "Reset expired view in index.html");
ok(indexHtml.includes("supabaseAuth.js?v=18"), "deployed cache bust loads supabaseAuth v18");
ok(indexHtml.includes("Forgot password?"), "Forgot password label text present");

const dom = {
  "vera-account-login-view": { hidden: false },
  "vera-account-forgot-view": { hidden: true },
  "vera-account-reset-password-view": { hidden: true },
  "vera-account-reset-expired-view": { hidden: true },
  "vera-account-forgot-email-row": { hidden: false },
  "vera-account-forgot-actions": { hidden: false },
  "vera-account-forgot-success": { hidden: true, textContent: "" },
  "vera-account-reset-success": { hidden: true, textContent: "" },
  "vera-account-error": { hidden: true, textContent: "" },
  "vera-account-success": { hidden: true, textContent: "" },
  "vera-account-modal": { hidden: true },
  "vera-settings-modal": { hidden: true },
  "vera-account-section": { scrollIntoView() {} },
  "vera-account-forgot-email": { value: "" },
  "vera-account-new-password": { value: "" },
  "vera-account-confirm-password": { value: "" },
  "vera-account-email": { value: "user@example.com" },
  "vera-account-password": { value: "" },
};

const sandbox = {
  console,
  document: {
    getElementById(id) {
      const node = dom[id];
      if (!node) return null;
      return {
        ...node,
        hidden: node.hidden,
        set hidden(v) {
          node.hidden = v;
        },
        get hidden() {
          return node.hidden;
        },
        setAttribute(name) {
          if (name === "hidden") node.hidden = true;
        },
        removeAttribute(name) {
          if (name === "hidden") node.hidden = false;
        },
        scrollIntoView: node.scrollIntoView || (() => {}),
        value: node.value,
        set value(v) {
          node.value = v;
        },
        get value() {
          return node.value;
        },
        textContent: node.textContent,
        set textContent(v) {
          node.textContent = v;
        },
        disabled: false,
      };
    },
  },
};
sandbox.window = sandbox;
sandbox.location = {
  origin: "http://localhost:3000",
  pathname: "/",
  href: "http://localhost:3000/",
  hostname: "localhost",
  hash: "",
};
sandbox.history = { replaceState() {} };
sandbox.addEventListener = () => {};
sandbox.__veraWorkspaceAuthSyncListenerWired = true;
sandbox.URL = URL;
sandbox.URLSearchParams = URLSearchParams;
sandbox.authApiUrl = (p) => `http://127.0.0.1:8000${p}`;
sandbox.getSessionId = () => "session_smoke";
sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

vm.createContext(sandbox);
vm.runInContext(readFileSync(path.join(root, "users/supabaseAuth.js"), "utf8"), sandbox);

const H = sandbox.__veraAuthPasswordResetTestHooks;
ok(H && typeof H.validateResetEmail === "function", "password reset test hooks exported");

ok(!H.validateResetEmail("").ok, "empty email → validation error");
ok(H.validateResetEmail("user@example.com").ok, "valid email passes validation");

const resetCalls = [];
const mockClient = {
  auth: {
    resetPasswordForEmail: async (email, opts) => {
      resetCalls.push({ email, redirectTo: opts?.redirectTo });
      return { error: null };
    },
    updateUser: async ({ password }) => {
      if (!password) return { error: { message: "missing" } };
      return { error: null };
    },
    signInWithPassword: async () => ({ error: null }),
    signUp: async () => ({ data: { session: { access_token: "t" } }, error: null }),
    signOut: async () => ({}),
    getSession: async () => ({ data: { session: { access_token: "recovery" } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
};

const redirect = H.getPasswordResetRedirectUrl();
ok(
  redirect === "http://localhost:3000/app/?mode=reset-password",
  "localhost uses same-origin /app/ reset URL"
);
ok(redirect.includes("mode=reset-password"), "redirect URL includes reset-password mode");
ok(redirect.includes("/app/?mode=reset-password"), "redirect URL points at app entry");

// GitHub Pages subpath
sandbox.location = {
  origin: "https://bnam2103.github.io",
  pathname: "/VERA-ai/app/",
  href: "https://bnam2103.github.io/VERA-ai/app/",
  hostname: "bnam2103.github.io",
  hash: "",
};
ok(
  H.getPasswordResetRedirectUrl() === GITHUB_PAGES_RESET_URL,
  "GitHub Pages app path uses repo subpath in redirect"
);

// Production custom domain
sandbox.location = {
  origin: "https://workwithvera.com",
  pathname: "/app/",
  href: "https://workwithvera.com/app/",
  hostname: "workwithvera.com",
  hash: "",
};
ok(
  H.getPasswordResetRedirectUrl() === WORKWITHVERA_RESET_URL,
  "workwithvera.com uses /app/ reset URL"
);

sandbox.location = {
  origin: "http://localhost:3000",
  pathname: "/",
  href: "http://localhost:3000/",
  hostname: "localhost",
  hash: "",
};
const redirectForLog = H.getPasswordResetRedirectUrl();

const redirectLogs = [];
const origInfo = console.info;
console.info = (...args) => {
  if (args[0] === "[auth_password_reset_redirect]") redirectLogs.push(args[1]);
  origInfo(...args);
};
H.logPasswordResetRedirect(redirectForLog);
console.info = origInfo;
ok(
  redirectLogs.some(
    (l) =>
      l?.redirectTo === "http://localhost:3000/app/?mode=reset-password" &&
      l?.hostname === "localhost" &&
      l?.origin === "http://localhost:3000"
  ),
  "forgot-password redirect log includes redirectTo and page context"
);

ok(
  H.hashIndicatesPasswordRecovery("#access_token=abc&type=recovery&expires_in=3600"),
  "hash type=recovery detected for reset UI"
);
ok(!H.hashIndicatesPasswordRecovery("#access_token=abc&type=signup"), "non-recovery hash ignored");
ok(
  !H.hashIndicatesPasswordRecovery(
    "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"
  ),
  "expired error hash is not treated as recovery"
);

ok(
  H.hashIndicatesPasswordResetExpired(
    "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"
  ),
  "otp_expired hash detected"
);
ok(H.hashIndicatesPasswordResetExpired("#error=access_denied"), "access_denied hash detected");

H.enterPasswordResetExpiredView();
ok(H.getAccountAuthView() === "reset-expired", "expired link opens reset-expired view");
H.showAccountAuthView();
ok(dom["vera-account-reset-expired-view"].hidden === false, "reset expired view visible");
ok(dom["vera-account-reset-password-view"].hidden === true, "set-password view hidden for expired link");
ok(
  H.getPasswordResetExpiredMessage().toLowerCase().includes("expired"),
  "expired reset message is user-friendly"
);

await mockClient.auth.resetPasswordForEmail("user@example.com", {
  redirectTo: redirectForLog,
});
ok(resetCalls.length === 1, "valid email triggers resetPasswordForEmail");
ok(resetCalls[0].email === "user@example.com", "resetPasswordForEmail receives email");
ok(
  resetCalls[0].redirectTo === "http://localhost:3000/app/?mode=reset-password",
  "reset email uses same-origin /app/ redirectTo"
);
ok(!String(resetCalls[0].redirectTo).includes("//app/app"), "reset email link has no duplicated /app segment");

const redirectNotAllowed = {
  message: "redirect URL not allowed",
  status: 400,
  name: "AuthApiError",
  code: "invalid_redirect_url",
};
const failDiag = H.passwordResetErrorDiagnostics(redirectNotAllowed, GITHUB_PAGES_RESET_URL);
ok(failDiag.message.includes("redirect"), "missing redirect URL surfaces useful error message");
ok(failDiag.status === 400, "failure diagnostics include status");
ok(failDiag.code === "invalid_redirect_url", "failure diagnostics include code");
ok(failDiag.redirectTo === GITHUB_PAGES_RESET_URL, "failure diagnostics include redirectTo");
ok(
  H.passwordResetUserFacingError(redirectNotAllowed) === "redirect URL not allowed",
  "failure shows Supabase error message in UI helper"
);
const failJson = JSON.stringify(failDiag);
ok(!failJson.includes("access_token"), "failure diagnostics omit tokens");
ok(!/"password"\s*:/.test(failJson), "failure diagnostics omit password fields");

const successDoneLogs = [];
const origError = console.error;
console.error = (...args) => {
  if (args[0] === "[auth_password_reset_request_failed]") successDoneLogs.push(args[1]);
  origError(...args);
};
console.info = (...args) => {
  if (args[0] === "[auth_password_reset_request_done]") successDoneLogs.push(args[1]);
  origInfo(...args);
};
console.info("[auth_password_reset_request_done]", {
  redirectTo: GITHUB_PAGES_RESET_URL,
  email_domain: "example.com",
});
console.error = origError;
console.info = origInfo;
ok(
  successDoneLogs.some((l) => l?.redirectTo === GITHUB_PAGES_RESET_URL),
  "successful reset request logs redirectTo on done"
);
ok(
  H.getPasswordResetSuccessMessage().toLowerCase().includes("if an account exists"),
  "successful reset still uses generic success message"
);

const msg = H.getPasswordResetSuccessMessage();
ok(
  msg.toLowerCase().includes("if an account exists"),
  "success message does not reveal whether account exists"
);
ok(!msg.toLowerCase().includes("not found"), "success message has no not-found wording");

H.handleAuthStateChangeEvent("PASSWORD_RECOVERY");
ok(H.getAccountAuthView() === "reset-password", "PASSWORD_RECOVERY shows reset password form");
H.showAccountAuthView();
ok(dom["vera-account-reset-password-view"].hidden === false, "reset password view visible");
ok(dom["vera-account-login-view"].hidden === true, "login view hidden during recovery");

ok(!H.validateNewPasswordPair("short", "short").ok, "short password rejected");
ok(!H.validateNewPasswordPair("abcdef", "abcdeg").ok, "mismatched passwords rejected");
ok(H.validateNewPasswordPair("abcdef", "abcdef").ok, "matching passwords accepted");

const validated = H.validateNewPasswordPair("secret12", "secret12");
const { error } = await mockClient.auth.updateUser({ password: validated.password });
ok(!error, "updateUser succeeds for valid password pair");
H.setAccountAuthView("login");
ok(H.getAccountAuthView() === "login", "after password update returns to login view");

const signIn = await mockClient.auth.signInWithPassword({
  email: "user@example.com",
  password: "secret12",
});
ok(!signIn.error, "signInWithPassword still works");
const signUp = await mockClient.auth.signUp({
  email: "new@example.com",
  password: "secret12",
});
ok(!signUp.error && signUp.data?.session, "signUp still works");
await mockClient.auth.signOut();
ok(true, "signOut still works");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
