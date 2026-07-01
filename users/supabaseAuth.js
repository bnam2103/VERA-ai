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
/** Bumps on login click, sign-out, and explicit logout — stale async refreshes must not apply. */
let _authGeneration = 0;
/** Set while Supabase client has a persisted session user id (sync cache). */
let _supabaseSessionUserId = null;
/** @type {'login' | 'forgot' | 'reset-password' | 'reset-expired'} */
let _accountAuthView = "login";
let _authUiBusy = false;
const _authBusyButtonLabels = new Map();
const AUTH_POST_LOGIN_REFRESH_WARN_MS = 3000;

function _authNowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

function _authLog(tag, extra) {
  try {
    if (extra && typeof extra === "object") {
      console.info(tag, extra);
    } else {
      console.info(tag);
    }
  } catch (_) {}
}

const AUTH_PASSWORD_RESET_SUCCESS_MSG =
  "If an account exists for this email, a reset link has been sent.";
const AUTH_MIN_PASSWORD_LENGTH = 6;
const AUTH_PASSWORD_UPDATED_MSG = "Password updated. You can now use your account.";
const AUTH_PASSWORD_RESET_EXPIRED_MSG =
  "This reset link expired or is invalid. Please request a new password reset link.";
/** Deployed Vera app entry (GitHub Pages + workwithvera.com). */
function getVeraAppBasePath() {
  try {
    const p = String(window.location?.pathname || "");
    const m = p.match(/^(.*\/app)(?:\/|$)/i);
    if (m) return m[1];
    const meta = document.querySelector('meta[name="vera-app-base"]')?.content?.trim();
    if (meta) return meta.replace(/\/$/, "");
  } catch (_) {}
  return "/app";
}

function getVeraPasswordResetRedirectUrl() {
  try {
    const origin = String(window.location?.origin || "").replace(/\/$/, "");
    if (origin && origin !== "null") {
      return `${origin}${getVeraAppBasePath()}/?mode=reset-password`;
    }
  } catch (_) {}
  return "https://workwithvera.com/app/?mode=reset-password";
}

function _parseAuthHashParams(hashOverride) {
  try {
    const raw =
      hashOverride != null
        ? String(hashOverride)
        : String(window.location?.hash || "");
    const hash = raw.replace(/^#/, "").trim();
    if (!hash) return null;
    return new URLSearchParams(hash);
  } catch (_) {
    return null;
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
    if (_hashIndicatesPasswordResetExpired(hashOverride)) return false;
    if (/(?:^|[&?])type=recovery(?:&|$)/i.test(hash)) return true;
    const params = _parseAuthHashParams(hashOverride);
    return params?.get("type") === "recovery";
  } catch (_) {
    return false;
  }
}

function _hashIndicatesPasswordResetExpired(hashOverride) {
  try {
    const raw =
      hashOverride != null
        ? String(hashOverride)
        : String(window.location?.hash || "");
    const hash = raw.replace(/^#/, "").trim();
    if (!hash) return false;
    if (/error_code=otp_expired/i.test(hash)) return true;
    if (/error=access_denied/i.test(hash)) return true;
    const params = _parseAuthHashParams(hashOverride);
    if (!params) return false;
    const error = String(params.get("error") || "").toLowerCase();
    const errorCode = String(params.get("error_code") || "").toLowerCase();
    if (errorCode === "otp_expired") return true;
    if (error === "access_denied") return true;
    return false;
  } catch (_) {
    return false;
  }
}

function _passwordResetErrorDiagnostics(error, redirectTo) {
  const err = error && typeof error === "object" ? error : {};
  return {
    message: String(err.message || error || "unknown_error"),
    status: err.status ?? null,
    name: err.name ? String(err.name) : null,
    code: err.code ? String(err.code) : null,
    redirectTo: String(redirectTo || VERA_PASSWORD_RESET_REDIRECT_URL),
  };
}

function _passwordResetUserFacingError(error) {
  const msg = String(error?.message || error || "").trim();
  return msg || "Could not send reset email. Please try again.";
}

function _logPasswordResetRedirect(redirectTo) {
  try {
    const loc = typeof window !== "undefined" ? window.location : null;
    console.info("[auth_password_reset_redirect]", {
      redirectTo: String(redirectTo || ""),
      origin: loc?.origin ?? null,
      pathname: loc?.pathname ?? null,
      hostname: loc?.hostname ?? null,
    });
  } catch (_) {
    console.info("[auth_password_reset_redirect]", {
      redirectTo: String(redirectTo || ""),
      origin: null,
      pathname: null,
      hostname: null,
    });
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

function _clearPasswordResetUrlArtifacts() {
  try {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("mode");
    const next = `${url.pathname}${url.search}`;
    window.history.replaceState({}, "", next);
  } catch (_) {}
}

function _clearResetPasswordUrlParam() {
  _clearPasswordResetUrlArtifacts();
}

function _setAuthUiBusy(busy, { signInLabel } = {}) {
  _authUiBusy = Boolean(busy);
  const signIn = document.getElementById("vera-account-sign-in");
  if (signIn instanceof HTMLButtonElement) {
    if (_authUiBusy) {
      if (!_authBusyButtonLabels.has("vera-account-sign-in")) {
        _authBusyButtonLabels.set(
          "vera-account-sign-in",
          signIn.textContent || "Log in"
        );
      }
      if (signInLabel) signIn.textContent = signInLabel;
    } else {
      const prev = _authBusyButtonLabels.get("vera-account-sign-in");
      if (prev) signIn.textContent = prev;
      _authBusyButtonLabels.delete("vera-account-sign-in");
    }
  }
  const ids = [
    "vera-account-sign-in",
    "vera-account-sign-up",
    "vera-account-forgot-password-link",
    "vera-account-send-reset",
    "vera-account-forgot-back",
    "vera-account-update-password",
    "vera-account-reset-expired-request",
    "vera-account-reset-expired-back",
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
  const expiredView = document.getElementById("vera-account-reset-expired-view");
  const view = _accountAuthView;
  if (loginView) loginView.hidden = view !== "login";
  if (forgotView) forgotView.hidden = view !== "forgot";
  if (resetView) resetView.hidden = view !== "reset-password";
  if (expiredView) expiredView.hidden = view !== "reset-expired";
}

function _openAccountSectionInSettings() {
  if (typeof window.veraOpenAccountModal === "function") {
    window.veraOpenAccountModal();
    return;
  }
  const accountModal = document.getElementById("vera-account-modal");
  if (accountModal) accountModal.removeAttribute("hidden");
}

function _enterPasswordRecoveryView() {
  _accountAuthView = "reset-password";
  _showAccountAuthView();
  _openAccountSectionInSettings();
  _clearPasswordResetUrlArtifacts();
}

function _enterPasswordResetExpiredView() {
  _accountAuthView = "reset-expired";
  _showAccountAuthView();
  _openAccountSectionInSettings();
  _clearPasswordResetUrlArtifacts();
  console.info("[auth_password_reset_expired_link]", {
    error_code: "otp_expired",
  });
}

async function _detectPasswordRecoveryOnLoad() {
  if (!_supabaseClient) return;
  try {
    if (_hashIndicatesPasswordResetExpired()) {
      _enterPasswordResetExpiredView();
      return;
    }
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
  if (meta?.configured) {
    console.info("[boot] auth config done", { source: "meta" });
    return meta;
  }
  console.info("[boot] auth config start");
  try {
    const res = await fetch(authApiUrl("/api/auth/config"), { method: "GET" });
    const data = await res.json().catch(() => ({}));
    const apiBase = String(data?.api_base_url || "").trim();
    if (apiBase && typeof window !== "undefined") {
      window.VERA_API_BASE_URL = apiBase.replace(/\/$/, "");
    }
    if (res.ok && data?.configured && data.supabase_url && data.anon_key) {
      console.info("[boot] auth config done");
      return data;
    }
    console.warn("[boot] auth config fail", { status: res.status });
  } catch (err) {
    console.error("[boot] auth config fail", err);
  }
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

function _setSidebarButtonLabel(btn, label) {
  if (!(btn instanceof HTMLButtonElement)) return;
  const labelEl = btn.querySelector(".vera-sidebar-btn-label");
  if (labelEl instanceof HTMLElement) {
    labelEl.textContent = label;
    return;
  }
  btn.textContent = label;
}

function _setAccountFabLabel(me) {
  const fab = document.getElementById("vera-account-open");
  if (!(fab instanceof HTMLButtonElement)) return;
  if (me?.authenticated) {
    _setSidebarButtonLabel(fab, _accountDisplayName(me));
    fab.classList.add("is-signed-in");
    fab.title = `Signed in as ${me.email || _accountDisplayName(me)}`;
    fab.setAttribute("aria-label", `Account — signed in as ${_accountDisplayName(me)}`);
  } else {
    _setSidebarButtonLabel(fab, "Account");
    fab.classList.remove("is-signed-in");
    fab.title = "Account — sign in or sign up";
    fab.setAttribute("aria-label", "Account");
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

async function refreshSupabaseMeFromBackend(opts = {}) {
  const genAtStart = opts.generation != null ? opts.generation : _authGeneration;
  const requestId = opts.requestId || `me_${genAtStart}_${_authNowMs()}`;
  try {
    const res = await authFetchImpl(
      authApiUrl(`/api/auth/me?session_id=${encodeURIComponent(getSessionId())}`),
      { method: "GET" }
    );
    const data = await res.json().catch(() => ({}));
    if (_authGenerationStale(genAtStart, "auth_me_response")) {
      return _mergeMeWithSessionFallback(_lastMeSnapshot);
    }
    if (res.ok) {
      const merged = _mergeMeWithSessionFallback(data);
      _lastMeSnapshot = merged;
      return merged;
    }
    _authLog("[auth_profile_fetch_fail]", {
      request_id: requestId,
      status: res.status,
    });
  } catch (err) {
    _authLog("[auth_profile_fetch_fail]", {
      request_id: requestId,
      message: String(err?.message || err),
    });
  }
  const fallback = _mergeMeWithSessionFallback({ authenticated: false });
  _lastMeSnapshot = fallback;
  return fallback;
}

function _syncSupabaseSessionCache(session) {
  const uid = session?.user?.id ? String(session.user.id).trim() : "";
  _supabaseSessionUserId = uid || null;
}

function _mergeMeWithSessionFallback(backendMe) {
  if (backendMe?.authenticated) return backendMe;
  if (_supabaseSessionUserId) {
    const sessionMe = _meFromSupabaseSession({
      user: {
        id: _supabaseSessionUserId,
        email: _lastMeSnapshot?.email || backendMe?.email || "",
      },
    });
    if (sessionMe) {
      return {
        ...sessionMe,
        email: backendMe?.email || sessionMe.email || _lastMeSnapshot?.email || null,
        profile: backendMe?.profile || _lastMeSnapshot?.profile || {},
      };
    }
  }
  if (backendMe && backendMe.authenticated === false && !_supabaseSessionUserId) {
    return backendMe;
  }
  if (_lastMeSnapshot?.authenticated) return _lastMeSnapshot;
  return { authenticated: false };
}

async function _getMeFromCurrentSupabaseSession() {
  if (!_supabaseClient) return null;
  try {
    const { data } = await _supabaseClient.auth.getSession();
    const session = data?.session || null;
    _syncSupabaseSessionCache(session);
    return session ? _meFromSupabaseSession(session) : null;
  } catch (_) {
    return null;
  }
}

function _authGenerationStale(genAtStart, reason) {
  if (genAtStart == null || genAtStart === _authGeneration) return false;
  _authLog("[auth_stale_response_ignored]", {
    request_generation: genAtStart,
    current_generation: _authGeneration,
    reason: reason || "generation_mismatch",
  });
  return true;
}
function _meFromSupabaseSession(session) {
  const user = session?.user;
  if (!user) return null;
  const userId = String(user.id || "").trim();
  if (!userId) return null;
  const email = String(user.email || "").trim() || null;
  const prevProfile =
    _lastMeSnapshot?.authenticated && _lastMeSnapshot?.user_id === userId
      ? _lastMeSnapshot.profile
      : null;
  return {
    authenticated: true,
    user_id: userId,
    email,
    profile: prevProfile || {},
  };
}

function _applyOptimisticSignedInFromSession(session) {
  _syncSupabaseSessionCache(session);
  const me = _meFromSupabaseSession(session);
  if (!me) return false;
  _applySupabaseAccountChrome(me);
  return true;
}

function _applySupabaseAccountChrome(me, opts = {}) {
  const forceSignedOut = Boolean(opts.forceSignedOut);
  let resolved = me;
  if (!forceSignedOut && !me?.authenticated && _supabaseSessionUserId) {
    resolved = _mergeMeWithSessionFallback(me);
    if (resolved?.authenticated) {
      _authLog("[auth_session_fallback_ui]", { reason: "blocked_logged_out_downgrade" });
    }
  }
  const uid = String(resolved?.user_id || "").trim();
  const nowAuthenticated = Boolean(resolved?.authenticated);
  if (_supabaseWasAuthenticated && !nowAuthenticated) {
    _runAccountLogoutCleanup();
  }
  _supabaseWasAuthenticated = nowAuthenticated;
  _lastMeSnapshot = resolved;
  _setSupabaseAccountLabel(resolved);
  _setAccountFabLabel(resolved);
  _renderAccountPanel(resolved);
  if (typeof hideLegacySignInUi === "function") {
    const legacyOn =
      typeof isLegacySignInEnabled === "function" && isLegacySignInEnabled();
    if (!legacyOn || resolved?.authenticated) {
      hideLegacySignInUi();
    }
  }
  if (!resolved?.authenticated) {
    _settingsHydratedUserId = null;
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
    _workspaceHydratedUserId = null;
    _workspaceHydrateAttempts = 0;
    if (_workspaceHydrateRetryTimer) {
      window.clearTimeout(_workspaceHydrateRetryTimer);
      _workspaceHydrateRetryTimer = null;
    }
  }
  return uid;
}

function _scheduleOptionalAuthSideEffects(me) {
  const uid = String(me?.user_id || "").trim();
  if (!me?.authenticated || !uid) return;
  if (typeof hydrateVeraSettingsFromSupabase === "function" && uid !== _settingsHydratedUserId) {
    _settingsHydratedUserId = uid;
    void hydrateVeraSettingsFromSupabase();
  }
  if (uid !== _checklistHydratedUserId) {
    void _hydrateChecklistAccountWhenReady(uid);
  }
  if (uid !== _workspaceHydratedUserId) {
    void _hydrateWorkspaceAccountWhenReady(uid);
  }
  if (typeof window.veraFeedbackOnAuthChanged === "function") {
    try {
      window.veraFeedbackOnAuthChanged();
    } catch (_) {}
  }
  try {
    window.veraRefreshUsageCredits?.();
  } catch (_) {}
  try {
    window.veraRefreshFeedbackStatus?.();
  } catch (_) {}
}

function _applySupabaseAccountUiFromMe(me) {
  _applySupabaseAccountChrome(me);
  _scheduleOptionalAuthSideEffects(me);
}

async function _runPostLoginOptionalRefresh(genAtStart) {
  const gen = genAtStart != null ? genAtStart : _authGeneration;
  const refreshStart = _authNowMs();
  _authLog("[auth_post_login_refresh_start]", { generation: gen });
  let slowWarned = false;
  const slowTimer = window.setTimeout(() => {
    slowWarned = true;
    _authLog("[auth_post_login_refresh_slow]", {
      duration_ms: Math.round(_authNowMs() - refreshStart),
      limit_ms: AUTH_POST_LOGIN_REFRESH_WARN_MS,
    });
  }, AUTH_POST_LOGIN_REFRESH_WARN_MS);

  try {
    const profileStart = _authNowMs();
    _authLog("[auth_profile_fetch_start]");
    const me = await refreshSupabaseMeFromBackend({ generation: gen });
    _authLog("[auth_profile_fetch_done]", {
      duration_ms: Math.round(_authNowMs() - profileStart),
    });
    if (_authGenerationStale(gen, "post_login_profile")) return;

    const resolved = _mergeMeWithSessionFallback(me);
    const labelStart = _authNowMs();
    _authLog("[auth_account_label_update_start]", { background: true });
    _applySupabaseAccountChrome(resolved);
    _authLog("[auth_account_label_update_done]", {
      duration_ms: Math.round(_authNowMs() - labelStart),
      background: true,
    });

    const activeStart = _authNowMs();
    _authLog("[auth_user_active_fetch_start]");
    if (typeof refreshVeraActiveUserLabel === "function") {
      await refreshVeraActiveUserLabel({ generation: gen, skipSessionFirst: true });
    }
    _authLog("[auth_user_active_fetch_done]", {
      duration_ms: Math.round(_authNowMs() - activeStart),
    });
    if (_authGenerationStale(gen, "post_login_user_active")) return;

    _scheduleOptionalAuthSideEffects(resolved);

    const creditsStart = _authNowMs();
    _authLog("[auth_credits_refresh_start]");
    try {
      await window.veraRefreshUsageCredits?.();
    } catch (_) {}
    _authLog("[auth_credits_refresh_done]", {
      duration_ms: Math.round(_authNowMs() - creditsStart),
    });

    const feedbackStart = _authNowMs();
    _authLog("[auth_feedback_refresh_start]");
    try {
      await window.veraRefreshFeedbackStatus?.();
    } catch (_) {}
    _authLog("[auth_feedback_refresh_done]", {
      duration_ms: Math.round(_authNowMs() - feedbackStart),
    });
  } catch (err) {
    _authLog("[auth_post_login_refresh_error]", {
      message: String(err?.message || err),
    });
  } finally {
    window.clearTimeout(slowTimer);
    _authLog("[auth_post_login_refresh_done]", {
      duration_ms: Math.round(_authNowMs() - refreshStart),
      slow_warned: slowWarned,
    });
  }
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
  const checklistStart = _authNowMs();
  _authLog("[auth_checklist_sync_start]");
  try {
    const merged = await hydrateFn();
    if (merged) _checklistHydratedUserId = uid;
    if (typeof retryChecklistSupabaseSyncIfUnsynced === "function") {
      void retryChecklistSupabaseSyncIfUnsynced("login");
    }
  } finally {
    _authLog("[auth_checklist_sync_done]", {
      duration_ms: Math.round(_authNowMs() - checklistStart),
    });
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

async function refreshSupabaseAccountLabel(opts = {}) {
  if (!_supabaseConfigured && !_supabaseClient) {
    return false;
  }
  const genAtStart = opts.generation != null ? opts.generation : _authGeneration;
  const labelStart = _authNowMs();
  _authLog("[auth_refresh_account_label_start]", { generation: genAtStart });

  const skipBackend = Boolean(opts.skipBackend);
  const skipOptional = Boolean(opts.skipOptionalRefresh);
  const skipSessionFirst = Boolean(opts.skipSessionFirst);
  let me = opts.meOverride || null;
  let source = me ? "override" : null;

  if (!me && !skipSessionFirst) {
    const sessionMe = await _getMeFromCurrentSupabaseSession();
    if (sessionMe?.authenticated) {
      me = sessionMe;
      source = "supabase";
      _authLog("[auth_show_signed_in_immediate]", { email: sessionMe.email });
      _applySupabaseAccountChrome(sessionMe);
      if (skipBackend) {
        _authLog("[auth_refresh_account_label_done]", {
          source,
          duration_ms: Math.round(_authNowMs() - labelStart),
        });
        return true;
      }
    }
  }

  if (!skipBackend && !opts.meOverride) {
    const profileStart = _authNowMs();
    _authLog("[auth_profile_fetch_start]");
    const backendMe = await refreshSupabaseMeFromBackend({ generation: genAtStart });
    _authLog("[auth_profile_fetch_done]", {
      duration_ms: Math.round(_authNowMs() - profileStart),
    });
    if (_authGenerationStale(genAtStart, "refresh_account_label")) {
      _authLog("[auth_refresh_account_label_done]", {
        source: "stale",
        duration_ms: Math.round(_authNowMs() - labelStart),
      });
      return Boolean(_lastMeSnapshot?.authenticated);
    }
    const resolved = _mergeMeWithSessionFallback(backendMe || me);
    me = resolved;
    source = source === "supabase" ? "supabase+backend" : resolved?.authenticated ? "backend" : "fallback";
  }

  if (!me) {
    me = _mergeMeWithSessionFallback({ authenticated: false });
    source = source || "fallback";
  }

  if (skipOptional) {
    _applySupabaseAccountChrome(me);
  } else {
    _applySupabaseAccountUiFromMe(me);
  }
  _authLog("[auth_refresh_account_label_done]", {
    source: source || "unknown",
    duration_ms: Math.round(_authNowMs() - labelStart),
  });
  return Boolean(me?.authenticated);
}

function isSupabaseUserAuthenticated() {
  return Boolean(_supabaseSessionUserId || _lastMeSnapshot?.authenticated);
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

    try {
      const { data: bootSession } = await _supabaseClient.auth.getSession();
      _syncSupabaseSessionCache(bootSession?.session || null);
    } catch (_) {}

    _supabaseClient.auth.onAuthStateChange((event, session) => {
      _authLog("[auth_state_change]", {
        event,
        has_session: Boolean(session),
        email: session?.user?.email || null,
      });
      if (event === "SIGNED_OUT") {
        _authGeneration += 1;
        _syncSupabaseSessionCache(null);
        _handleAuthStateChangeEvent(event);
        _applySupabaseAccountChrome({ authenticated: false }, { forceSignedOut: true });
        return;
      }
      _syncSupabaseSessionCache(session);
      if (event === "PASSWORD_RECOVERY") {
        _handleAuthStateChangeEvent(event);
        return;
      }
      if (session?.user) {
        const sessionMe = _meFromSupabaseSession(session);
        if (sessionMe) {
          _authLog("[auth_show_signed_in_immediate]", {
            email: sessionMe.email,
            source: "onAuthStateChange",
          });
          _applySupabaseAccountChrome(sessionMe);
        }
      }
      void refreshSupabaseAccountLabel({ skipSessionFirst: true });
    });

    await _detectPasswordRecoveryOnLoad();
    await refreshSupabaseAccountLabel();
    return true;
  })();

  return _supabaseInitPromise;
}

function wireSupabaseAccountUi() {
  const accountFab = document.getElementById("vera-account-open");

  const openAccountPanel = () => {
    if (typeof window.veraOpenAccountModal === "function") {
      window.veraOpenAccountModal();
      return;
    }
    if (typeof window.veraOpenSettingsToAccountSection === "function") {
      window.veraOpenSettingsToAccountSection();
      return;
    }
    const accountModal = document.getElementById("vera-account-modal");
    if (!accountModal) return;
    accountModal.removeAttribute("hidden");
    refreshSupabaseAccountLabel().catch(() => {});
  };

  accountFab?.addEventListener("click", openAccountPanel);

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

  document.getElementById("vera-account-reset-expired-request")?.addEventListener("click", () => {
    if (_authUiBusy) return;
    _showAccountError("");
    _clearAccountSuccess();
    const emailRow = document.getElementById("vera-account-forgot-email-row");
    const forgotActions = document.getElementById("vera-account-forgot-actions");
    if (emailRow instanceof HTMLElement) emailRow.hidden = false;
    if (forgotActions instanceof HTMLElement) forgotActions.hidden = false;
    const forgotOk = document.getElementById("vera-account-forgot-success");
    if (forgotOk instanceof HTMLElement) forgotOk.hidden = true;
    _accountAuthView = "forgot";
    _showAccountAuthView();
  });

  document.getElementById("vera-account-reset-expired-back")?.addEventListener("click", () => {
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
      console.info("[password_reset_redirect_to]", redirectTo);
      const { error } = await _supabaseClient.auth.resetPasswordForEmail(validated.email, {
        redirectTo,
      });
      if (error) {
        console.error(
          "[auth_password_reset_request_failed]",
          _passwordResetErrorDiagnostics(error, redirectTo)
        );
        _showAccountError(_passwordResetUserFacingError(error));
        return;
      }
      console.info("[auth_password_reset_request_done]", {
        redirectTo,
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
      const redirectTo = getVeraPasswordResetRedirectUrl();
      console.error(
        "[auth_password_reset_request_failed]",
        _passwordResetErrorDiagnostics(e, redirectTo)
      );
      _showAccountError(_passwordResetUserFacingError(e));
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
    _authGeneration += 1;
    const loginGen = _authGeneration;
    _authLog("[auth_login_click]");
    _authLog("[auth_login_ui_state]", { state: "logging_in" });
    _setAuthUiBusy(true, { signInLabel: "Logging in…" });
    try {
      const signInStart = _authNowMs();
      _authLog("[auth_supabase_signin_start]");
      const { data, error } = await _supabaseClient.auth.signInWithPassword({ email, password });
      let session = data?.session || null;
      if (!session) {
        try {
          const { data: sessData } = await _supabaseClient.auth.getSession();
          session = sessData?.session || null;
        } catch (_) {}
      }
      _authLog("[auth_supabase_signin_done]", {
        duration_ms: Math.round(_authNowMs() - signInStart),
        has_session: Boolean(session),
        user_email: session?.user?.email || null,
      });
      if (error) {
        _showAccountError(error.message || "Sign in failed.");
        return;
      }
      _syncSupabaseSessionCache(session);
      _applyOptimisticSignedInFromSession(session);
      _authLog("[auth_show_signed_in_immediate]", {
        email: session?.user?.email || null,
        source: "login",
      });
      _accountAuthView = "login";
      void _runPostLoginOptionalRefresh(loginGen);
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
      _authGeneration += 1;
      _syncSupabaseSessionCache(data?.session);
      _applyOptimisticSignedInFromSession(data?.session);
      _authLog("[auth_show_signed_in_immediate]", {
        email: data?.session?.user?.email || null,
        source: "signup",
      });
      void _runPostLoginOptionalRefresh(_authGeneration);
    } catch (e) {
      _showAccountError(String(e?.message || e || "Sign up failed."));
    } finally {
      _setAuthUiBusy(false);
    }
  });

  document.getElementById("vera-account-sign-out")?.addEventListener("click", async () => {
    if (!_supabaseClient) return;
    _showAccountError("");
    _authGeneration += 1;
    try {
      await _supabaseClient.auth.signOut();
      _syncSupabaseSessionCache(null);
      _lastMeSnapshot = { authenticated: false };
      _applySupabaseAccountChrome({ authenticated: false }, { forceSignedOut: true });
      if (typeof refreshVeraActiveUserLabel === "function") {
        await refreshVeraActiveUserLabel({ skipSessionFirst: true, skipBackend: true });
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
      logPasswordResetRedirect: _logPasswordResetRedirect,
      passwordResetErrorDiagnostics: _passwordResetErrorDiagnostics,
      passwordResetUserFacingError: _passwordResetUserFacingError,
      getPasswordResetExpiredMessage: () => AUTH_PASSWORD_RESET_EXPIRED_MSG,
      hashIndicatesPasswordRecovery: _hashIndicatesPasswordRecovery,
      hashIndicatesPasswordResetExpired: _hashIndicatesPasswordResetExpired,
      enterPasswordResetExpiredView: _enterPasswordResetExpiredView,
      handleAuthStateChangeEvent: _handleAuthStateChangeEvent,
      getAccountAuthView: () => _accountAuthView,
      setAccountAuthView: (v) => {
        _accountAuthView = v;
      },
      showAccountAuthView: _showAccountAuthView,
    };
  }
} catch (_) {}
