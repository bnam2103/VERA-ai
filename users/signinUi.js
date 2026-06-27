/* =========================================================================
 *  users/signinUi.js -- hidden user sign-in / long-press VERA logo UI.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-06-01, Patch B-4). The original block lived under the
 *  banner "HIDDEN USER SIGN-IN (long-press VERA logo 2s)" at
 *  app.js L23919..L24008, plus the separate function
 *  wireVeraUserSignInHoldAndModal() at app.js L24331..L24474.
 *
 *  Public surface (declared as bare identifiers at the top level of
 *  this classic <script>, so they are visible to every later script
 *  through the shared GlobalDeclarativeRecord at CALL time):
 *    - function localBackendBase()
 *    - function authApiBase()
 *    - function authApiUrl(path)
 *    - function setVeraActiveUserLabel(usernameOrNull)
 *    - async function refreshVeraActiveUserLabel()
 *    - function wireVeraUserSignInHoldAndModal()
 *
 *  -----------------------------------------------------------------
 *  Load order
 *  -----------------------------------------------------------------
 *  This file is loaded AFTER utils/logging.js and BEFORE voice/asr.js
 *  in index.html. Rationale:
 *
 *    - workmode/checklist.js references authApiUrl as a bare
 *      identifier (e.g. await fetch(authApiUrl("/api/work-mode/
 *      checklist"), ...)); loading users/signinUi.js first puts the
 *      declaration in the shared global lexical environment before
 *      workmode/checklist.js is parsed.
 *
 *    - workmode/panels.js references localBackendBase in the same
 *      way for the multi-tier base-URL fallback.
 *
 *    - app.js itself uses localBackendBase / authApiUrl in many
 *      Spotify, cost-log, and tools-server code paths; the load
 *      order keeps every one of those bare-identifier lookups
 *      reachable at call time.
 *
 *  -----------------------------------------------------------------
 *  Bare-identifier references in the moved code (resolved at CALL
 *  TIME through the shared global lexical environment, not at this
 *  module's parse time):
 *    API_URL                      const in app.js (L1265).
 *    VERA_TAB_ACTIVE_USER_KEY     const in app.js (L6170).
 *    getSessionId                 function in utils/ids.js (loaded
 *                                 before this file).
 *    hydrateWorkChecklistFromServer
 *                                 function in workmode/checklist.js
 *                                 (loaded AFTER this file, but the
 *                                 call only fires when the user
 *                                 submits the sign-in modal, long
 *                                 after every <script> has parsed).
 *    window.resetVeraSessionAndUi
 *                                 set in app.js L189 (loaded AFTER
 *                                 this file; checked via
 *                                 typeof === "function" at submit
 *                                 time).
 *
 *  -----------------------------------------------------------------
 *  Preserved invariants (Patch B-4 hard rules)
 *  -----------------------------------------------------------------
 *    - Public function names unchanged (localBackendBase,
 *      authApiBase, authApiUrl, setVeraActiveUserLabel,
 *      refreshVeraActiveUserLabel, wireVeraUserSignInHoldAndModal).
 *    - Endpoint paths unchanged (/api/user/sign-in,
 *      /api/user/sign-out, /api/user/active).
 *    - sessionStorage key VERA_TAB_ACTIVE_USER_KEY unchanged (the
 *      const still lives in app.js so all writers and readers see
 *      the same value through the shared global lex env).
 *    - Long-press hold duration unchanged (const holdMs = 2000).
 *    - Modal UI behaviour unchanged (open / close / cancel / submit
 *      event wiring; error placeholder; password clearing on
 *      success).
 *    - Active-user label behaviour unchanged (hidden + cleared
 *      textContent for null; "user: ${name}" otherwise).
 *    - Base-URL fallback order unchanged (window.VERA_LOCAL_BACKEND_
 *      ORIGIN override -> localhost detection -> meta tag ->
 *      127.0.0.1:8000 default for file: origins -> API_URL fallback).
 *    - All logs preserved byte-identically (the auth-server error
 *      string and the spotify-OAuth warning that lives outside this
 *      block).
 *
 *  Bootstrap invocations (`wireVeraUserSignInHoldAndModal();`,
 *  `refreshVeraActiveUserLabel();`) remain in app.js. The wire
 *  function would otherwise be invoked from this file at parse
 *  time, before app.js had declared VERA_TAB_ACTIVE_USER_KEY at
 *  L6170; running the invocations from app.js keeps the original
 *  ordering and avoids any temporal-dead-zone risk.
 * ========================================================================= */

/* =========================
   HIDDEN USER SIGN-IN (long-press VERA logo 2s)
========================= */

/**
 * Base URL for FastAPI user routes (sign-in, /api/user/active).
 * GitHub Pages / static hosts cannot serve POST /api — must use API_URL (Worker → tunnel → app.py).
 * Order: explicit override → localhost uvicorn → meta → file → API_URL for all other https origins.
 */
function localBackendBase() {
  if (typeof window !== "undefined" && window.VERA_LOCAL_BACKEND_ORIGIN) {
    return String(window.VERA_LOCAL_BACKEND_ORIGIN).replace(/\/$/, "");
  }
  const o = typeof window !== "undefined" ? window.location?.origin : "";
  if (o && o !== "null" && !o.startsWith("file:")) {
    const isLocal =
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o) ||
      /^https?:\/\/\[::1\](:\d+)?$/i.test(o);
    if (isLocal) return o.replace(/\/$/, "");
  }
  const m = document.querySelector('meta[name="vera-local-backend-origin"]');
  const meta = m?.content?.trim();
  if (meta) return meta.replace(/\/$/, "");
  if (!o || o === "null" || o.startsWith("file:")) {
    return "http://127.0.0.1:8000";
  }
  const remote = String(API_URL).replace(/\/$/, "");
  return remote || "https://vera-api.vera-api-ned.workers.dev";
}

function authApiBase() {
  return localBackendBase();
}

/** Absolute URL for user auth; never same-origin relative /api/... on GitHub Pages. */
function authApiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  let base = localBackendBase();
  if (!base || !String(base).trim()) {
    base = String(API_URL).replace(/\/$/, "") || "https://vera-api.vera-api-ned.workers.dev";
  }
  const root = String(base).replace(/\/$/, "");
  return new URL(p, `${root}/`).href;
}

/**
 * fetch() with optional Supabase Authorization header when logged in.
 * Implemented in users/supabaseAuth.js when Supabase is configured; otherwise
 * falls through to plain fetch (anonymous Vera still works).
 */
async function authFetch(url, init) {
  if (typeof window !== "undefined" && typeof window.__veraAuthFetchImpl === "function") {
    return window.__veraAuthFetchImpl(url, init);
  }
  return fetch(url, init);
}

/**
 * Legacy users_files sign-in (long-press logo + SIGN IN nav). Disabled by
 * default — Supabase Account is the normal login path (Phase 2+).
 * Set window.VERA_ENABLE_LEGACY_SIGNIN=true or meta vera-enable-legacy-signin
 * to re-enable for local/dev testing only.
 */
function isLegacySignInEnabled() {
  if (typeof window !== "undefined") {
    const flag = window.VERA_ENABLE_LEGACY_SIGNIN;
    if (flag === true) return true;
    if (String(flag || "").trim().toLowerCase() === "true") return true;
  }
  const meta = document.querySelector('meta[name="vera-enable-legacy-signin"]');
  return (meta?.content || "").trim().toLowerCase() === "true";
}

function hideLegacySignInUi() {
  document.getElementById("vera-user-sign-in")?.setAttribute("hidden", "");
  document.getElementById("vera-user-sign-in-modal")?.setAttribute("hidden", "");
  const errEl = document.getElementById("vera-sign-in-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.hidden = true;
  }
}

function setVeraActiveUserLabel(usernameOrNull) {
  const el = document.getElementById("vera-active-user-label");
  if (!el) return;
  if (usernameOrNull == null || usernameOrNull === "") {
    el.textContent = "";
    el.setAttribute("hidden", "");
    return;
  }
  el.textContent = `user: ${usernameOrNull}`;
  el.removeAttribute("hidden");
}

async function refreshVeraActiveUserLabel(opts = {}) {
  if (typeof refreshSupabaseAccountLabel === "function") {
    const supabaseHandled = await refreshSupabaseAccountLabel(opts);
    if (supabaseHandled) return;
  }
  const tabUser = sessionStorage.getItem(VERA_TAB_ACTIVE_USER_KEY) || "";
  if (!tabUser) {
    setVeraActiveUserLabel(null);
    try {
      /* PART 7: scoped sign-out so we don't clobber other devices that are
         signed in as different users. */
      await fetch(authApiUrl("/api/user/sign-out"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: getSessionId() }),
      });
    } catch {}
    return;
  }
  try {
    /* PART 7: include session_id so the backend returns THIS session's
       active user, not whatever was last set process-wide. */
    console.info("[boot] user active start");
    const res = await fetch(
      authApiUrl(`/api/user/active?session_id=${encodeURIComponent(getSessionId())}`),
      { method: "GET" }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[boot] user active fail", { status: res.status });
      setVeraActiveUserLabel(null);
      return;
    }
    const activeName = data.username != null && data.username !== "" ? String(data.username) : tabUser;
    setVeraActiveUserLabel(activeName || null);
    console.info("[boot] user active done");
  } catch (err) {
    console.error("[boot] user active fail", err);
    setVeraActiveUserLabel(tabUser || null);
  }
}

function wireVeraUserSignInHoldAndModal() {
  hideLegacySignInUi();
  if (!isLegacySignInEnabled()) {
    return;
  }

  const holdMs = 2000;
  /* Long-press sign-in only in VERA app (#return-home-vera), not on landing nav-home */
  const logos = [document.getElementById("return-home-vera")].filter(Boolean);

  const revealSignInButtons = () => {
    if (!isLegacySignInEnabled()) return;
    if (
      typeof isSupabaseUserAuthenticated === "function" &&
      isSupabaseUserAuthenticated()
    ) {
      return;
    }
    document.getElementById("vera-user-sign-in")?.removeAttribute("hidden");
  };

  logos.forEach((el) => {
    let timer = null;
    let longPress = false;
    let holding = false;
    let rafId = null;
    let holdStart = 0;

    const tick = () => {
      if (!holding) return;
      const elapsed = performance.now() - holdStart;
      const pct = Math.min(100, (elapsed / holdMs) * 100);
      el.style.setProperty("--vera-hold-pct", `${pct}%`);
      if (holding && elapsed < holdMs) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const endHoldTracking = () => {
      holding = false;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      el.style.setProperty("--vera-hold-pct", "0%");
    };

    el.addEventListener("pointerdown", () => {
      longPress = false;
      holding = true;
      holdStart = performance.now();
      timer = window.setTimeout(() => {
        longPress = true;
        revealSignInButtons();
        el.style.setProperty("--vera-hold-pct", "100%");
        holding = false;
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }, holdMs);
      rafId = requestAnimationFrame(tick);
    });

    const cancelTimerAndFill = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      endHoldTracking();
    };

    el.addEventListener("pointerup", cancelTimerAndFill);
    el.addEventListener("pointerleave", cancelTimerAndFill);
    el.addEventListener("pointercancel", cancelTimerAndFill);
    el.addEventListener(
      "click",
      (e) => {
        if (longPress) {
          e.preventDefault();
          e.stopImmediatePropagation();
          longPress = false;
        }
      },
      true
    );
  });

  const modal = document.getElementById("vera-user-sign-in-modal");
  const errEl = document.getElementById("vera-sign-in-error");

  const showErr = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg || "";
    errEl.hidden = !msg;
  };

  const openModal = () => {
    if (!isLegacySignInEnabled()) return;
    if (
      typeof isSupabaseUserAuthenticated === "function" &&
      isSupabaseUserAuthenticated()
    ) {
      return;
    }
    showErr("");
    modal?.removeAttribute("hidden");
  };

  const closeModal = () => {
    modal?.setAttribute("hidden", "");
    showErr("");
  };

  document.getElementById("vera-user-sign-in")?.addEventListener("click", openModal);
  document.getElementById("vera-sign-in-cancel")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.getElementById("vera-sign-in-submit")?.addEventListener("click", async () => {
    const userEl = document.getElementById("vera-sign-in-username");
    const passEl = document.getElementById("vera-sign-in-password");
    const user = userEl?.value?.trim() ?? "";
    const pass = passEl?.value?.trim() ?? "";
    showErr("");
    try {
      const res = await fetch(authApiUrl("/api/user/sign-in"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /* PART 7: pass session_id so the backend can scope the active user
           PER SESSION instead of overwriting the process-global field. Two
           devices signing in as different users will each have their own
           checklist / known-facts isolation. */
        body: JSON.stringify({ username: user, password: pass, session_id: getSessionId() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = data.detail;
        if (Array.isArray(d) && d.length > 0 && d[0]?.msg) {
          showErr(String(d[0].msg));
          return;
        }
        showErr(typeof d === "string" ? d : "Wrong password or username.");
        return;
      }
      const name = data.username != null && data.username !== "" ? String(data.username) : null;
      if (name) sessionStorage.setItem(VERA_TAB_ACTIVE_USER_KEY, name);
      setVeraActiveUserLabel(name);
      /* Start a fresh VERA session on successful user sign-in. */
      if (typeof window.resetVeraSessionAndUi === "function") {
        window.resetVeraSessionAndUi();
      }
      await hydrateWorkChecklistFromServer(true);
      closeModal();
      if (passEl) passEl.value = "";
    } catch {
      showErr(
        "Could not reach the auth server. If you use GitHub Pages, deploy the latest app.js (cache-busted) so sign-in uses the VERA API URL, or set window.VERA_LOCAL_BACKEND_ORIGIN."
      );
    }
  });
}

try {
  if (typeof window !== "undefined") {
    window.isLegacySignInEnabled = isLegacySignInEnabled;
    window.hideLegacySignInUi = hideLegacySignInUi;
  }
} catch (_) {}
