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
  }
}

async function refreshSupabaseMemoriesList() {
  const wrap = document.getElementById("vera-account-memories-wrap");
  const list = document.getElementById("vera-account-memories-list");
  if (!(wrap instanceof HTMLElement) || !(list instanceof HTMLElement)) return;
  if (!_lastMeSnapshot?.authenticated) {
    wrap.setAttribute("hidden", "");
    list.innerHTML = "";
    return;
  }

  try {
    const res = await authFetchImpl(authApiUrl("/api/memories"), { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      wrap.setAttribute("hidden", "");
      return;
    }
    wrap.removeAttribute("hidden");
    const memories = Array.isArray(data.memories) ? data.memories : [];
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

async function refreshSupabaseAccountLabel() {
  if (!_supabaseConfigured && !_supabaseClient) {
    return false;
  }
  const me = await refreshSupabaseMeFromBackend();
  const uid = String(me?.user_id || "").trim();
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

    _supabaseClient.auth.onAuthStateChange(() => {
      refreshSupabaseAccountLabel().catch(() => {});
    });

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
    try {
      const { error } = await _supabaseClient.auth.signInWithPassword({ email, password });
      if (error) {
        _showAccountError(error.message || "Sign in failed.");
        return;
      }
      await refreshSupabaseAccountLabel();
    } catch (e) {
      _showAccountError(String(e?.message || e || "Sign in failed."));
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
    if (password.length < 6) {
      _showAccountError("Password must be at least 6 characters.");
      return;
    }
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
      await refreshSupabaseAccountLabel();
    } catch (e) {
      _showAccountError(String(e?.message || e || "Sign up failed."));
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
  }
} catch (_) {}
