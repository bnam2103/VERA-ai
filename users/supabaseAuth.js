/* =========================================================================
 *  users/supabaseAuth.js — Supabase Auth UI + JWT attachment (Phase 2).
 *
 *  Load order: AFTER users/signinUi.js (authApiUrl, authFetch stub,
 *  refreshVeraActiveUserLabel hook), BEFORE workmode/checklist.js and app.js.
 *
 *  Public surface:
 *    - authFetch(url, init)           via window.__veraAuthFetchImpl
 *    - getSupabaseAccessToken()
 *    - initSupabaseAuth()
 *    - wireSupabaseAccountUi()
 *    - refreshSupabaseAccountLabel()
 * ========================================================================= */

let _supabaseClient = null;
let _supabaseConfigured = false;
let _supabaseInitPromise = null;
let _lastMeSnapshot = null;
let _settingsHydratedUserId = null;
let _checklistHydratedUserId = null;
let _checklistHydrateAttempts = 0;
let _checklistHydrateRetryTimer = null;
let _workspaceHydratedUserId = null;
let _workspaceHydrateAttempts = 0;
let _workspaceHydrateRetryTimer = null;
let _supabaseWasAuthenticated = false;
let _memoriesFetchGeneration = 0;
/** @type {'login' | 'forgot' | 'reset-password'} */
let _accountAuthView = "login";
let _authUiBusy = false;

const AUTH_PASSWORD_RESET_SUCCESS_MSG =
  "If an account exists for this email, a reset link has been sent.";
const AUTH_MIN_PASSWORD_LENGTH = 6;
const AUTH_PASSWORD_UPDATED_MSG = "Password updated. You can now use your account.";
/** Deployed Vera frontend (GitHub Pages). Used for password-reset email links from local dev. */
const VERA_PROD_AUTH_ORIGIN = "https://bnam2103.github.io";
const VERA_PROD_AUTH_PATH = "/VERA-ai/";

function _isLocalDevHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

function _normalizeVeraProdPath(path) {
  let p = String(path || "/").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

function getVeraPasswordResetRedirectUrl() {
  const prodOrigin = VERA_PROD_AUTH_ORIGIN;
  const prodPath = _normalizeVeraProdPath(VERA_PROD_AUTH_PATH);
  const prodUrl = `${prodOrigin}${prodPath}?mode=reset-password`;

  try {
    if (typeof window === "undefined" || !window.location) return prodUrl;
    const host = String(window.location.hostname || "").toLowerCase();

    /* Never send reset emails to localhost — links must open deployed Vera. */
    if (_isLocalDevHostname(host)) {
      return prodUrl;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("mode", "reset-password");
    url.hash = "";
    return `${url.origin}${url.pathname}${url.search}`;
  } catch (_) {
    return prodUrl;
  }
}

function _hashIndicatesPasswordRecovery(hashOverride) {
  try {
    const raw =
      hashOverride != null
        ? String(hashOverride)
        : String(window.location?.hash || "");
    const hash = raw.replace(/^#/, "").trim();
    if (!hash) return false;
    if (/(?:^|[&?])type=recovery(?:&|$)/i.test(hash)) return true;
    const params = new URLSearchParams(hash);
    return params.get("type") === "recovery";
  } catch (_) {
    return false;
  }
}

function _logPasswordResetRedirect(redirectTo) {
  try {
    const u = new URL(String(redirectTo || ""));
    console.info("[auth_password_reset_redirect]", {
      origin: u.origin,
      pathname: u.pathname,
      mode: u.searchParams.get("mode"),
    });
  } catch (_) {
    console.info("[auth_password_reset_redirect]", { origin: null, pathname: null, mode: "reset-password" });
  }
}

function _validateResetEmail(email) {
  const e = String(email || "").trim();
  if (!e) return { ok: false, error: "Enter your email address." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  return { ok: true, email: e };
}

function _validateNewPasswordPair(password, confirm) {
  const p = String(password || "");
  const c = String(confirm || "");
  if (!p || !c) return { ok: false, error: "Enter and confirm your new password." };
  if (p.length < AUTH_MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${AUTH_MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (p !== c) return { ok: false, error: "Passwords do not match." };
  return { ok: true, password: p };
}

function _clearResetPasswordUrlParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("mode")) return;
    url.searchParams.delete("mode");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", next);
  } catch (_) {}
}

function _setAuthUiBusy(busy) {
  _authUiBusy = Boolean(busy);
  const ids = [
    "vera-account-sign-in",
    "vera-account-sign-up",
    "vera-account-forgot-password-link",
    "vera-account-send-reset",
    "vera-account-forgot-back",
    "vera-account-update-password",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el instanceof HTMLButtonElement) el.disabled = _authUiBusy;
  }
}

function _showAccountSuccess(msg) {
  const el = document.getElementById("vera-account-success");
  if (el instanceof HTMLElement) {
    el.textContent = msg || "";
    el.hidden = !msg;
  }
  _showAccountError("");
}

function _clearAccountSuccess() {
  const el = document.getElementById("vera-account-success");
  if (el instanceof HTMLElement) {
    el.textContent = "";
    el.hidden = true;
  }
  const forgotOk = document.getElementById("vera-account-forgot-success");
  if (forgotOk instanceof HTMLElement) {
    forgotOk.textContent = "";
    forgotOk.hidden = true;
  }
  const resetOk = document.getElementById("vera-account-reset-success");
  if (resetOk instanceof HTMLElement) {
    resetOk.textContent = "";
    resetOk.hidden = true;
  }
}

function _showAccountAuthView() {
  const loginView = document.getElementById("vera-account-login-view");
  const forgotView = document.getElementById("vera-account-forgot-view");
  const resetView = document.getElementById("vera-account-reset-password-view");
  const view = _accountAuthView;
  if (loginView) loginView.hidden = view !== "login";
  if (forgotView) forgotView.hidden = view !== "forgot";
  if (resetView) resetView.hidden = view !== "reset-password";
}

function _openAccountSectionInSettings() {
  const settingsModal = document.getElementById("vera-settings-modal");
  const accountSection = document.getElementById("vera-account-section");
  if (settingsModal) settingsModal.removeAttribute("hidden");
  accountSection?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function _enterPasswordRecoveryView() {
  _accountAuthView = "reset-password";
  _showAccountAuthView();
  _openAccountSectionInSettings();
  _clearResetPasswordUrlParam();
}

async function _detectPasswordRecoveryOnLoad() {
  if (!_supabaseClient) return;
  try {
    const params = new URLSearchParams(window.location.search);
    const modeReset = params.get("mode") === "reset-password";
    const hashRecovery = _hashIndicatesPasswordRecovery();
    if (!modeReset && !hashRecovery) return;
    const { data } = await _supabaseClient.auth.getSession();
    if (data?.session || hashRecovery) _enterPasswordRecoveryView();
  } catch (_) {}
}

function _handleAuthStateChangeEvent(event) {
  if (event === "PASSWORD_RECOVERY") _enterPasswordRecoveryView();
}

function _readMetaSupabaseConfig() {
  const urlMeta = document.querySelector('meta[name="vera-supabase-url"]');
  const anonMeta = document.querySelector('meta[name="vera-supabase-anon-key"]');
  const url = urlMeta?.content?.trim() || "";
  const anon = anonMeta?.content?.trim() || "";
  if (url && anon) return { configured: true, supabase_url: url, anon_key: anon };
  return null;
}

async function _loadSupabaseClientConfig() {
  const meta = _readMetaSupabaseConfig();
  if (meta?.configured) return meta;
  try {
    const res = await fetch(authApiUrl("/api/auth/config"), { method: "GET" });
    const data = await res.json().catch(() => ({}));
    const apiBase = String(data?.api_base_url || "").trim();
    if (apiBase && typeof window !== "undefined") {
      window.VERA_API_BASE_URL = apiBase.replace(/\/$/, "");
    }
    if (res.ok && data?.configured && data.supabase_url && data.anon_key) {
      return data;
    }
  } catch (_) {}
  return { configured: false };
}

async function getSupabaseAccessToken() {
  if (!_supabaseClient) return null;
  try {
    const { data } = await _supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    return token ? String(token) : null;
  } catch (_) {
    return null;
  }
}

async function _mergeAuthHeaders(init) {
  const base = init && typeof init === "object" ? { ...init } : {};
  const headers = new Headers(base.headers || {});
  const token = await getSupabaseAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  base.headers = headers;
  return base;
}

async function authFetchImpl(url, init) {
  return fetch(url, await _mergeAuthHeaders(init));
}

function _accountDisplayName(me) {
  const profileName = String(me?.profile?.display_name || "").trim();
  if (profileName) return profileName;
  const email = String(me?.email || "").trim();
  if (email && email.includes("@")) return email.split("@")[0];
  return email || "Account";
}

function _setAccountFabLabel(me) {
  const fab = document.getElementById("vera-account-open");
  if (!(fab instanceof HTMLButtonElement)) return;
  if (me?.authenticated) {
    fab.textContent = _accountDisplayName(me);
    fab.classList.add("is-signed-in");
    fab.title = `Signed in as ${me.email || _accountDisplayName(me)}`;
  } else {
    fab.textContent = "Account";
    fab.classList.remove("is-signed-in");
    fab.title = "Account — sign in or sign up";
  }
}

function _setSupabaseAccountLabel(me) {
  const el = document.getElementById("vera-active-user-label");
  if (!(el instanceof HTMLElement)) return;
  if (me?.authenticated) {
    const label = me.email || _accountDisplayName(me);
    el.textContent = `account: ${label}`;
    el.removeAttribute("hidden");
    return;
  }
  el.textContent = "";
  el.setAttribute("hidden", "");
}

function _renderAccountPanel(me) {
  const statusEl = document.getElementById("vera-account-status");
  const signedOut = document.getElementById("vera-account-signed-out");
  const signedIn = document.getElementById("vera-account-signed-in");
  const emailIn = document.getElementById("vera-account-email");
  const passIn = document.getElementById("vera-account-password");
  const displayIn = document.getElementById("vera-account-display-name");
  const errEl = document.getElementById("vera-account-error");
  const memoriesWrap = document.getElementById("vera-account-memories-wrap");

  if (errEl instanceof HTMLElement) {
    errEl.textContent = "";
    errEl.hidden = true;
  }

  if (_accountAuthView === "reset-password") {
    if (statusEl) statusEl.textContent = "Set a new password to finish resetting your account.";
    signedOut?.removeAttribute("hidden");
    signedIn?.setAttribute("hidden", "");
    memoriesWrap?.setAttribute("hidden", "");
    _showAccountAuthView();
    return;
  }

  if (!_supabaseConfigured) {
    if (statusEl) statusEl.textContent = "Supabase auth is not configured on this server.";
    signedOut?.setAttribute("hidden", "");
    signedIn?.setAttribute("hidden", "");
    memoriesWrap?.setAttribute("hidden", "");
    return;
  }

  if (me?.authenticated) {
    if (statusEl) {
      statusEl.textContent = `Signed in as ${me.email || me.user_id || "user"}`;
    }
    signedOut?.setAttribute("hidden", "");
    signedIn?.removeAttribute("hidden");
    if (displayIn instanceof HTMLInputElement) {
      displayIn.value = String(me.profile?.display_name || "").trim();
    }
    refreshSupabaseMemoriesList().catch(() => {});
  } else {
    if (statusEl) statusEl.textContent = "Not signed in — Vera works anonymously.";
    signedOut?.removeAttribute("hidden");
    signedIn?.setAttribute("hidden", "");
    memoriesWrap?.setAttribute("hidden", "");
    if (emailIn instanceof HTMLInputElement) emailIn.value = "";
    if (passIn instanceof HTMLInputElement) passIn.value = "";
    const list = document.getElementById("vera-account-memories-list");
    if (list) list.innerHTML = "";
    if (_accountAuthView !== "reset-password") {
      _accountAuthView = "login";
    }
    _showAccountAuthView();
    _clearAccountSuccess();
  }
}

async function refreshSupabaseMemoriesList() {
  const wrap = document.getElementById("vera-account-memories-wrap");
  const list = document.getElementById("vera-account-memories-list");
  if (!(wrap instanceof HTMLElement) || !(list instanceof HTMLElement)) return;
  const genAtStart = _memoriesFetchGeneration;
  if (!_lastMeSnapshot?.authenticated) {
    wrap.setAttribute("hidden", "");
    list.innerHTML = "";
    return;
  }

  try {
    const res = await authFetchImpl(authApiUrl("/api/memories"), { method: "GET" });
    if (genAtStart !== _memoriesFetchGeneration) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !_lastMeSnapshot?.authenticated) {
      wrap.setAttribute("hidden", "");
      return;
    }
    wrap.removeAttribute("hidden");
    const memories = Array.isArray(data.memories) ? data.memories : [];
    if (genAtStart !== _memoriesFetchGeneration) return;
    list.innerHTML = "";
    if (!memories.length) {
      const empty = document.createElement("li");
      empty.className = "vera-account-memories-empty";
      empty.textContent = "No saved memories yet.";
      list.appendChild(empty);
      return;
    }
    for (const row of memories) {
      const content = String(row?.display_content || row?.content || "").trim();
      if (!content) continue;
      const li = document.createElement("li");
      li.className = "vera-account-memories-item";
      const text = document.createElement("span");
      text.className = "vera-account-memories-text";
      text.textContent = content;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "vera-account-memories-delete";
      del.textContent = "Delete";
      del.dataset.memoryId = String(row.id || "");
      del.title = "Delete this memory";
      li.appendChild(text);
      li.appendChild(del);
      list.appendChild(li);
    }
  } catch (_) {
    wrap.setAttribute("hidden", "");
  }
}

function clearMemoriesAfterLogout() {
  _memoriesFetchGeneration += 1;
  const wrap = document.getElementById("vera-account-memories-wrap");
  const list = document.getElementById("vera-account-memories-list");
  if (wrap instanceof HTMLElement) wrap.setAttribute("hidden", "");
  if (list instanceof HTMLElement) list.innerHTML = "";
}

function _resolveLogoutCleanupFn(fnName) {
  if (fnName === "clearMemoriesAfterLogout") return clearMemoriesAfterLogout;
  if (typeof window !== "undefined" && typeof window[fnName] === "function") {
    return window[fnName];
  }
  return null;
}

function _runAccountLogoutCleanup() {
  try {
    console.info("[account_logout_cleanup_start]");
  } catch (_) {}
  const components = [
    ["workspace", "clearWorkModeWorkspaceAfterLogout"],
    ["checklist", "clearChecklistAfterLogout"],
    ["settings", "clearSettingsAfterLogout"],
    ["memories", "clearMemoriesAfterLogout"],
  ];
  for (const [component, fnName] of components) {
    const fn = _resolveLogoutCleanupFn(fnName);
    if (!fn) continue;
    try {
      fn();
    } catch (err) {
      try {
        console.warn("[account_logout_cleanup_failed]", {
          component,
          error: String(err?.message || err),
        });
      } catch (_) {}
    }
  }
  try {
    console.info("[account_logout_cleanup_done]");
  } catch (_) {}
}

async function refreshSupabaseMeFromBackend() {
  try {
    const res = await authFetchImpl(
      authApiUrl(`/api/auth/me?session_id=${encodeURIComponent(getSessionId())}`),
      { method: "GET" }
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      _lastMeSnapshot = data;
      return data;
    }
  } catch (_) {}
  _lastMeSnapshot = { authenticated: false };
  return _lastMeSnapshot;
}

function _resolveChecklistMergeHydrateFn() {
  if (typeof hydrateChecklistMergeOnLogin === "function") {
    return hydrateChecklistMergeOnLogin;
  }
  if (typeof window !== "undefined" && typeof window.hydrateChecklistMergeOnLogin === "function") {
    return window.hydrateChecklistMergeOnLogin;
  }
  return null;
}

async function _hydrateChecklistAccountWhenReady(userId) {
  const uid = String(userId || "").trim();
  if (!uid || uid === _checklistHydratedUserId) return;

  const hydrateFn = _resolveChecklistMergeHydrateFn();
  if (!hydrateFn) {
    if (_checklistHydrateAttempts === 0) {
      console.warn(
        "[VERA][CHECKLIST] hydrateChecklistMergeOnLogin missing — waiting for workmode/checklist.js supabase sync"
      );
    }
    if (_checklistHydrateAttempts < 50) {
      _checklistHydrateAttempts += 1;
      if (_checklistHydrateRetryTimer) window.clearTimeout(_checklistHydrateRetryTimer);
      _checklistHydrateRetryTimer = window.setTimeout(() => {
        _checklistHydrateRetryTimer = null;
        void _hydrateChecklistAccountWhenReady(uid);
      }, 100);
      return;
    }
    console.warn(
      "[VERA][CHECKLIST] hydrateChecklistMergeOnLogin missing — account checklist sync not in checklist.js. " +
        "Hard-refresh (Ctrl+Shift+R) to load workmode/checklist.js?v=4+."
    );
    return;
  }

  _checklistHydrateAttempts = 0;
  if (_checklistHydrateRetryTimer) {
    window.clearTimeout(_checklistHydrateRetryTimer);
    _checklistHydrateRetryTimer = null;
  }
  const merged = await hydrateFn();
  if (merged) _checklistHydratedUserId = uid;
  if (typeof retryChecklistSupabaseSyncIfUnsynced === "function") {
    void retryChecklistSupabaseSyncIfUnsynced("login");
  }
}

function _resolveWorkspaceHydrateFn() {
  if (typeof hydrateWorkModeWorkspaceFromServer === "function") {
    return hydrateWorkModeWorkspaceFromServer;
  }
  if (typeof window !== "undefined" && typeof window.hydrateWorkModeWorkspaceFromServer === "function") {
    return window.hydrateWorkModeWorkspaceFromServer;
  }
  return null;
}

async function _hydrateWorkspaceAccountWhenReady(userId) {
  const uid = String(userId || "").trim();
  if (!uid || uid === _workspaceHydratedUserId) return;

  const hydrateFn = _resolveWorkspaceHydrateFn();
  if (!hydrateFn) {
    if (_workspaceHydrateAttempts === 0) {
      console.warn(
        "[VERA][WORKSPACE] hydrateWorkModeWorkspaceFromServer missing — waiting for workmode/workspaceSync.js"
      );
    }
    if (_workspaceHydrateAttempts < 200) {
      _workspaceHydrateAttempts += 1;
      if (_workspaceHydrateRetryTimer) window.clearTimeout(_workspaceHydrateRetryTimer);
      _workspaceHydrateRetryTimer = window.setTimeout(() => {
        _workspaceHydrateRetryTimer = null;
        void _hydrateWorkspaceAccountWhenReady(uid);
      }, 100);
      return;
    }
    console.warn(
      "[VERA][WORKSPACE] hydrateWorkModeWorkspaceFromServer missing — account workspace sync not loaded."
    );
    return;
  }

  _workspaceHydrateAttempts = 0;
  if (_workspaceHydrateRetryTimer) {
    window.clearTimeout(_workspaceHydrateRetryTimer);
    _workspaceHydrateRetryTimer = null;
  }
  const applied = await hydrateFn(false, { source: "auth_login" });
  if (applied) _workspaceHydratedUserId = uid;
  if (typeof retryWorkModeWorkspaceSyncIfUnsynced === "function") {
    void retryWorkModeWorkspaceSyncIfUnsynced("login");
  } else if (typeof window.retryWorkModeWorkspaceSyncIfUnsynced === "function") {
    void window.retryWorkModeWorkspaceSyncIfUnsynced("login");
  }
}

function _onWorkspaceSyncReadyForAuth() {
  const uid = String(_lastMeSnapshot?.user_id || "").trim();
  if (!uid || !_lastMeSnapshot?.authenticated) return;
  _workspaceHydrateAttempts = 0;
  if (_workspaceHydrateRetryTimer) {
    window.clearTimeout(_workspaceHydrateRetryTimer);
    _workspaceHydrateRetryTimer = null;
  }
  void _hydrateWorkspaceAccountWhenReady(uid);
}

if (typeof window !== "undefined" && !window.__veraWorkspaceAuthSyncListenerWired) {
  window.__veraWorkspaceAuthSyncListenerWired = true;
  window.addEventListener("vera:workspace-sync-ready", () => {
    _onWorkspaceSyncReadyForAuth();
  });
  if (window.__veraWorkspaceSyncReady === true) {
    _onWorkspaceSyncReadyForAuth();
  }
}

async function refreshSupabaseAccountLabel() {
  if (!_supabaseConfigured && !_supabaseClient) {
    return false;
  }
  const me = await refreshSupabaseMeFromBackend();
  const uid = String(me?.user_id || "").trim();
  const nowAuthenticated = Boolean(me?.authenticated);
  if (_supabaseWasAuthenticated && !nowAuthenticated) {
    _runAccountLogoutCleanup();
  }
  _supabaseWasAuthenticated = nowAuthenticated;
  _setSupabaseAccountLabel(me);
  _setAccountFabLabel(me);
  _renderAccountPanel(me);
  if (typeof hideLegacySignInUi === "function") {
    const legacyOn =
      typeof isLegacySignInEnabled === "function" && isLegacySignInEnabled();
    if (!legacyOn || me?.authenticated) {
      hideLegacySignInUi();
    }
  }
  if (me?.authenticated && typeof hydrateVeraSettingsFromSupabase === "function") {
    if (uid && uid !== _settingsHydratedUserId) {
      _settingsHydratedUserId = uid;
      void hydrateVeraSettingsFromSupabase();
    }
  } else {
    _settingsHydratedUserId = null;
  }
  if (me?.authenticated && uid && uid !== _checklistHydratedUserId) {
    void _hydrateChecklistAccountWhenReady(uid);
  } else if (!me?.authenticated) {
    _checklistHydratedUserId = null;
    _checklistHydrateAttempts = 0;
    if (_checklistHydrateRetryTimer) {
      window.clearTimeout(_checklistHydrateRetryTimer);
      _checklistHydrateRetryTimer = null;
    }
    const syncEl = document.getElementById("vera-checklist-sync-status");
    if (syncEl instanceof HTMLElement) {
      syncEl.hidden = true;
      syncEl.textContent = "";
    }
  }
  if (me?.authenticated && uid && uid !== _workspaceHydratedUserId) {
    void _hydrateWorkspaceAccountWhenReady(uid);
  } else if (!me?.authenticated) {
    _workspaceHydratedUserId = null;
    _workspaceHydrateAttempts = 0;
    if (_workspaceHydrateRetryTimer) {
      window.clearTimeout(_workspaceHydrateRetryTimer);
      _workspaceHydrateRetryTimer = null;
    }
  }
  if (typeof window.veraFeedbackOnAuthChanged === "function") {
    try {
      window.veraFeedbackOnAuthChanged();
    } catch (_) {}
  }
  return Boolean(me?.authenticated);
}

function isSupabaseUserAuthenticated() {
  return Boolean(_lastMeSnapshot?.authenticated);
}

function _showAccountError(msg) {
  const errEl = document.getElementById("vera-account-error");
  if (!(errEl instanceof HTMLElement)) return;
  errEl.textContent = msg || "";
  errEl.hidden = !msg;
}

async function initSupabaseAuth() {
  if (_supabaseInitPromise) return _supabaseInitPromise;

  _supabaseInitPromise = (async () => {
    if (typeof supabase === "undefined" || !supabase?.createClient) {
      console.warn("[VERA][AUTH] @supabase/supabase-js not loaded — account UI disabled.");
      _supabaseConfigured = false;
      return false;
    }

    const cfg = await _loadSupabaseClientConfig();
    _supabaseConfigured = Boolean(cfg?.configured);
    if (!_supabaseConfigured) {
      console.warn("[VERA][AUTH] Supabase not configured (set SUPABASE_URL + SUPABASE_ANON_KEY on backend).");
      return false;
    }

    _supabaseClient = supabase.createClient(cfg.supabase_url, cfg.anon_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    _supabaseClient.auth.onAuthStateChange((event) => {
      _handleAuthStateChangeEvent(event);
      refreshSupabaseAccountLabel().catch(() => {});
    });

    await _detectPasswordRecoveryOnLoad();
    await refreshSupabaseAccountLabel();
    return true;
  })();

  return _supabaseInitPromise;
}

function wireSupabaseAccountUi() {
  const accountFab = document.getElementById("vera-account-open");
  const settingsModal = document.getElementById("vera-settings-modal");
  const accountSection = document.getElementById("vera-account-section");

  const openAccountInSettings = () => {
    if (!(settingsModal instanceof HTMLElement)) return;
    settingsModal.removeAttribute("hidden");
    accountSection?.scrollIntoView({ block: "start", behavior: "smooth" });
    refreshSupabaseAccountLabel().catch(() => {});
  };

  accountFab?.addEventListener("click", openAccountInSettings);

  document.getElementById("vera-account-forgot-password-link")?.addEventListener("click", () => {
    if (_authUiBusy) return;
    _showAccountError("");
    _clearAccountSuccess();
    const loginEmail = document.getElementById("vera-account-email")?.value?.trim() || "";
    const forgotEmail = document.getElementById("vera-account-forgot-email");
    if (forgotEmail instanceof HTMLInputElement && loginEmail) forgotEmail.value = loginEmail;
    const emailRow = document.getElementById("vera-account-forgot-email-row");
    const forgotActions = document.getElementById("vera-account-forgot-actions");
    if (emailRow instanceof HTMLElement) emailRow.hidden = false;
    if (forgotActions instanceof HTMLElement) forgotActions.hidden = false;
    const forgotOk = document.getElementById("vera-account-forgot-success");
    if (forgotOk instanceof HTMLElement) forgotOk.hidden = true;
    _accountAuthView = "forgot";
    _showAccountAuthView();
  });

  document.getElementById("vera-account-forgot-back")?.addEventListener("click", () => {
    if (_authUiBusy) return;
    _accountAuthView = "login";
    _showAccountAuthView();
    _showAccountError("");
    _clearAccountSuccess();
  });

  document.getElementById("vera-account-send-reset")?.addEventListener("click", async () => {
    if (!_supabaseClient) {
      _showAccountError("Supabase auth is not available.");
      return;
    }
    if (_authUiBusy) return;
    _showAccountError("");
    _clearAccountSuccess();
    const emailRaw = document.getElementById("vera-account-forgot-email")?.value || "";
    const validated = _validateResetEmail(emailRaw);
    if (!validated.ok) {
      _showAccountError(validated.error);
      return;
    }
    _setAuthUiBusy(true);
    try {
      console.info("[auth_password_reset_request_start]", {
        email_domain: String(validated.email).split("@")[1] || null,
      });
      const redirectTo = getVeraPasswordResetRedirectUrl();
      _logPasswordResetRedirect(redirectTo);
      const { error } = await _supabaseClient.auth.resetPasswordForEmail(validated.email, {
        redirectTo,
      });
      if (error) {
        console.warn("[auth_password_reset_request_failed]", {
          message: String(error.message || error),
        });
        _showAccountError("Could not send reset email. Please try again.");
        return;
      }
      console.info("[auth_password_reset_request_done]", {
        email_domain: String(validated.email).split("@")[1] || null,
      });
      const forgotOk = document.getElementById("vera-account-forgot-success");
      if (forgotOk instanceof HTMLElement) {
        forgotOk.textContent = AUTH_PASSWORD_RESET_SUCCESS_MSG;
        forgotOk.hidden = false;
      }
      const emailRow = document.getElementById("vera-account-forgot-email-row");
      const forgotActions = document.getElementById("vera-account-forgot-actions");
      if (emailRow instanceof HTMLElement) emailRow.hidden = true;
      if (forgotActions instanceof HTMLElement) forgotActions.hidden = true;
    } catch (e) {
      console.warn("[auth_password_reset_request_failed]", {
        message: String(e?.message || e),
      });
      _showAccountError("Could not send reset email. Please try again.");
    } finally {
      _setAuthUiBusy(false);
    }
  });

  document.getElementById("vera-account-update-password")?.addEventListener("click", async () => {
    if (!_supabaseClient) {
      _showAccountError("Supabase auth is not available.");
      return;
    }
    if (_authUiBusy) return;
    _showAccountError("");
    _clearAccountSuccess();
    const password = document.getElementById("vera-account-new-password")?.value || "";
    const confirm = document.getElementById("vera-account-confirm-password")?.value || "";
    const validated = _validateNewPasswordPair(password, confirm);
    if (!validated.ok) {
      _showAccountError(validated.error);
      return;
    }
    _setAuthUiBusy(true);
    try {
      console.info("[auth_password_update_start]");
      const { error } = await _supabaseClient.auth.updateUser({ password: validated.password });
      if (error) {
        console.warn("[auth_password_update_failed]", {
          message: String(error.message || error),
        });
        _showAccountError(error.message || "Could not update password.");
        return;
      }
      console.info("[auth_password_update_done]");
      const newPass = document.getElementById("vera-account-new-password");
      const confirmPass = document.getElementById("vera-account-confirm-password");
      if (newPass instanceof HTMLInputElement) newPass.value = "";
      if (confirmPass instanceof HTMLInputElement) confirmPass.value = "";
      const resetOk = document.getElementById("vera-account-reset-success");
      if (resetOk instanceof HTMLElement) {
        resetOk.textContent = AUTH_PASSWORD_UPDATED_MSG;
        resetOk.hidden = false;
      }
      _accountAuthView = "login";
      _clearResetPasswordUrlParam();
      await refreshSupabaseAccountLabel();
    } catch (e) {
      console.warn("[auth_password_update_failed]", {
        message: String(e?.message || e),
      });
      _showAccountError(String(e?.message || e || "Could not update password."));
    } finally {
      _setAuthUiBusy(false);
    }
  });

  document.getElementById("vera-account-sign-in")?.addEventListener("click", async () => {
    if (!_supabaseClient) {
      _showAccountError("Supabase auth is not available.");
      return;
    }
    const email = document.getElementById("vera-account-email")?.value?.trim() || "";
    const password = document.getElementById("vera-account-password")?.value || "";
    _showAccountError("");
    if (!email || !password) {
      _showAccountError("Enter email and password.");
      return;
    }
    if (_authUiBusy) return;
    _setAuthUiBusy(true);
    try {
      const { error } = await _supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        _showAccountError(error.message || "Sign in failed.");
        return;
      }
      _accountAuthView = "login";
      await refreshSupabaseAccountLabel();
    } catch (e) {
      _showAccountError(String(e?.message || e || "Sign in failed."));
    } finally {
      _setAuthUiBusy(false);
    }
  });

  document.getElementById("vera-account-sign-up")?.addEventListener("click", async () => {
    if (!_supabaseClient) {
      _showAccountError("Supabase auth is not available.");
      return;
    }
    const email = document.getElementById("vera-account-email")?.value?.trim() || "";
    const password = document.getElementById("vera-account-password")?.value || "";
    _showAccountError("");
    if (!email || !password) {
      _showAccountError("Enter email and password.");
      return;
    }
    if (password.length < AUTH_MIN_PASSWORD_LENGTH) {
      _showAccountError(`Password must be at least ${AUTH_MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (_authUiBusy) return;
    _setAuthUiBusy(true);
    try {
      const { data, error } = await _supabaseClient.auth.signUp({ email, password });
      if (error) {
        _showAccountError(error.message || "Sign up failed.");
        return;
      }
      if (!data?.session) {
        _showAccountError("Check your email to confirm your account, then sign in.");
        return;
      }
      _accountAuthView = "login";
      await refreshSupabaseAccountLabel();
    } catch (e) {
      _showAccountError(String(e?.message || e || "Sign up failed."));
    } finally {
      _setAuthUiBusy(false);
    }
  });

  document.getElementById("vera-account-sign-out")?.addEventListener("click", async () => {
    if (!_supabaseClient) return;
    _showAccountError("");
    try {
      await _supabaseClient.auth.signOut();
      _lastMeSnapshot = { authenticated: false };
      await refreshSupabaseAccountLabel();
      if (typeof refreshVeraActiveUserLabel === "function") {
        await refreshVeraActiveUserLabel();
      }
    } catch (e) {
      _showAccountError(String(e?.message || e || "Sign out failed."));
    }
  });

  document.getElementById("vera-account-memories-list")?.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.(".vera-account-memories-delete");
    if (!(btn instanceof HTMLButtonElement)) return;
    const memoryId = btn.dataset.memoryId || "";
    if (!memoryId) return;
    btn.disabled = true;
    try {
      const res = await authFetchImpl(authApiUrl(`/api/memories/${encodeURIComponent(memoryId)}`), {
        method: "DELETE",
      });
      if (!res.ok) {
        _showAccountError("Could not delete that memory.");
        btn.disabled = false;
        return;
      }
      await refreshSupabaseMemoriesList();
    } catch (e) {
      _showAccountError(String(e?.message || e || "Could not delete memory."));
      btn.disabled = false;
    }
  });

  document.getElementById("vera-account-save-profile")?.addEventListener("click", async () => {
    const displayName = document.getElementById("vera-account-display-name")?.value?.trim() || "";
    _showAccountError("");
    if (!displayName) {
      _showAccountError("Enter a display name.");
      return;
    }
    try {
      const res = await authFetchImpl(authApiUrl("/api/profile"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        _showAccountError(typeof data.detail === "string" ? data.detail : "Could not save profile.");
        return;
      }
      await refreshSupabaseAccountLabel();
    } catch (e) {
      _showAccountError(String(e?.message || e || "Could not save profile."));
    }
  });
}

try {
  if (typeof window !== "undefined") {
    window.__veraAuthFetchImpl = authFetchImpl;
    window.getSupabaseAccessToken = getSupabaseAccessToken;
    window.initSupabaseAuth = initSupabaseAuth;
    window.wireSupabaseAccountUi = wireSupabaseAccountUi;
    window.refreshSupabaseAccountLabel = refreshSupabaseAccountLabel;
    window.refreshSupabaseMemoriesList = refreshSupabaseMemoriesList;
    window.isSupabaseUserAuthenticated = isSupabaseUserAuthenticated;
    window.authFetch = authFetchImpl;
    window.clearMemoriesAfterLogout = clearMemoriesAfterLogout;
    window._runAccountLogoutCleanup = _runAccountLogoutCleanup;
    window.getVeraPasswordResetRedirectUrl = getVeraPasswordResetRedirectUrl;
    window.__veraAuthPasswordResetTestHooks = {
      validateResetEmail: _validateResetEmail,
      validateNewPasswordPair: _validateNewPasswordPair,
      getPasswordResetSuccessMessage: () => AUTH_PASSWORD_RESET_SUCCESS_MSG,
      getPasswordUpdatedMessage: () => AUTH_PASSWORD_UPDATED_MSG,
      getPasswordResetRedirectUrl: getVeraPasswordResetRedirectUrl,
      hashIndicatesPasswordRecovery: _hashIndicatesPasswordRecovery,
      handleAuthStateChangeEvent: _handleAuthStateChangeEvent,
      getAccountAuthView: () => _accountAuthView,
      setAccountAuthView: (v) => {
        _accountAuthView = v;
      },
      showAccountAuthView: _showAccountAuthView,
    };
  }
} catch (_) {}
