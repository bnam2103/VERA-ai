/**
 * users/usageCredits.js — daily credit usage pill (read-only) + dev no-cap toggle.
 * Load AFTER users/supabaseAuth.js + users/usageFeatureEvents.js, BEFORE app.js.
 */
(function () {
  "use strict";

  let _refreshInFlight = null;
  let _noCapActive = false;
  let _noCapToggleEnabled = false;
  let _noCapToggleInFlight = false;

  function hideUsagePill() {
    const textEl = document.getElementById("vera-usage-credits-text");
    if (textEl instanceof HTMLElement) textEl.textContent = "";
  }

  function readNoCapToggleEnabled(payload) {
    const v = payload?.no_cap_toggle_enabled;
    if (v === true || v === 1) return true;
    const s = String(v ?? "").trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "on";
  }

  function readNoCapActive(payload) {
    const v = payload?.no_cap_active;
    if (v === true || v === 1) return true;
    const s = String(v ?? "").trim().toLowerCase();
    return s === "true" || s === "1";
  }

  function logNoCapState(payload, tag) {
    try {
      console.info("[usageCredits]", tag || "state", {
        no_cap_toggle_enabled: readNoCapToggleEnabled(payload),
        no_cap_active: readNoCapActive(payload),
        raw_toggle: payload?.no_cap_toggle_enabled,
        raw_active: payload?.no_cap_active
      });
    } catch (_) {}
  }

  function syncNoCapToggleButton(payload) {
    const btn = document.getElementById("vera-no-cap-toggle");
    const sep = document.getElementById("vera-credit-status-sep");
    if (!(btn instanceof HTMLButtonElement)) return;
    const enabled = readNoCapToggleEnabled(payload);
    logNoCapState(payload, enabled ? "toggle_visible" : "toggle_hidden");
    _noCapToggleEnabled = enabled;
    if (sep instanceof HTMLElement) sep.hidden = !enabled;
    if (!enabled) {
      btn.hidden = true;
      btn.classList.remove("is-on", "is-off");
      btn.textContent = "No cap: Off";
      _noCapActive = false;
      return;
    }
    _noCapActive = readNoCapActive(payload);
    btn.hidden = false;
    btn.classList.toggle("is-on", _noCapActive);
    btn.classList.toggle("is-off", !_noCapActive);
    btn.textContent = _noCapActive ? "No cap: On" : "No cap: Off";
    btn.setAttribute(
      "aria-pressed",
      _noCapActive ? "true" : "false"
    );
  }

  function formatUsageTooltip(authMode, bonusCredits, noCapActive) {
    if (noCapActive) {
      return "Testing mode: credit cap enforcement is off; usage is still logged.";
    }
    const bonus = Number(bonusCredits) || 0;
    if (bonus > 0) {
      return `Includes +${bonus} feedback bonus today.`;
    }
    if (authMode === "authenticated") {
      return "Daily Vera usage resets tomorrow. Give feedback to unlock +50 credits.";
    }
    return "Daily free usage resets tomorrow. Give feedback to unlock +50 credits.";
  }

  function renderUsageCreditsDisplay(payload) {
    const wrap = document.getElementById("vera-usage-credits");
    const textEl = document.getElementById("vera-usage-credits-text");
    if (!(wrap instanceof HTMLElement) || !(textEl instanceof HTMLElement)) return;
    syncNoCapToggleButton(payload);
    if (!payload || payload.ok !== true) {
      hideUsagePill();
      return;
    }
    const used = Number(payload.credits_used) || 0;
    const cap = Number(payload.credits_cap) || 0;
    const bonus = Number(payload.bonus_credits) || 0;
    const authMode = payload.auth_mode === "authenticated" ? "authenticated" : "anonymous";
    const noCapActive = readNoCapActive(payload);
    if (noCapActive) {
      textEl.textContent =
        authMode === "authenticated"
          ? `Credits: ${used} used`
          : `Free credits: ${used} used`;
    } else {
      textEl.textContent =
        authMode === "authenticated"
          ? `Credits: ${used} / ${cap}`
          : `Free credits: ${used} / ${cap}`;
    }
    wrap.title = formatUsageTooltip(authMode, bonus, noCapActive);
  }

  async function toggleNoCapTesting() {
    if (_noCapToggleInFlight || !_noCapToggleEnabled) return;
    if (typeof getSessionId !== "function" || typeof authApiUrl !== "function") return;
    const sid = String(getSessionId() || "").trim();
    if (!sid) return;
    const fetchFn = typeof authFetch === "function" ? authFetch : fetch;
    _noCapToggleInFlight = true;
    try {
      const res = await fetchFn(authApiUrl("/api/dev/no-cap/set"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid, active: !_noCapActive })
      });
      if (!res.ok) return;
      await refreshUsageCreditsToday();
    } catch (_) {
      /* ignore */
    } finally {
      _noCapToggleInFlight = false;
    }
  }

  function wireNoCapToggleButton() {
    const btn = document.getElementById("vera-no-cap-toggle");
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void toggleNoCapTesting();
    });
  }

  async function refreshUsageCreditsToday() {
    if (typeof getSessionId !== "function" || typeof authApiUrl !== "function") {
      hideUsagePill();
      return null;
    }
    if (_refreshInFlight) return _refreshInFlight;
    const sid = String(getSessionId() || "").trim();
    if (!sid) {
      hideUsagePill();
      return null;
    }
    const url = authApiUrl(
      `/api/usage/credits/today?session_id=${encodeURIComponent(sid)}`
    );
    const fetchFn = typeof authFetch === "function" ? authFetch : fetch;
    _refreshInFlight = (async () => {
      try {
        const res = await fetchFn(url, { method: "GET" });
        if (!res.ok) {
          hideUsagePill();
          syncNoCapToggleButton(null);
          return null;
        }
        const data = await res.json().catch(() => null);
        if (!data || data.ok !== true) {
          hideUsagePill();
          syncNoCapToggleButton(null);
          return null;
        }
        renderUsageCreditsDisplay(data);
        logNoCapState(data, "credits_today_ok");
        return data;
      } catch (_) {
        hideUsagePill();
        syncNoCapToggleButton(null);
        return null;
      } finally {
        _refreshInFlight = null;
      }
    })();
    return _refreshInFlight;
  }

  function wireUsageCreditsRefreshHooks() {
    const prevReplyDone = window.veraUsageOnAssistantReplyDone;
    window.veraUsageOnAssistantReplyDone = function (bubbleEl, ctx) {
      try {
        if (typeof prevReplyDone === "function") prevReplyDone(bubbleEl, ctx);
      } catch (_) {}
      void refreshUsageCreditsToday();
    };

    const prevReasoningDone = window.veraUsageOnReasoningPanelReplyDone;
    window.veraUsageOnReasoningPanelReplyDone = function (opts) {
      try {
        if (typeof prevReasoningDone === "function") prevReasoningDone(opts);
      } catch (_) {}
      void refreshUsageCreditsToday();
    };
  }

  wireNoCapToggleButton();
  wireUsageCreditsRefreshHooks();

  /* Initial refresh runs from app.js after initSupabaseAuth().finally() to
     avoid sending a stale Bearer token during Supabase session restore. */

  try {
    if (typeof window !== "undefined") {
      window.veraRefreshUsageCredits = refreshUsageCreditsToday;
      window.renderUsageCreditsDisplay = renderUsageCreditsDisplay;
    }
  } catch (_) {}
})();
