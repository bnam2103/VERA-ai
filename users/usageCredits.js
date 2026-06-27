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
    const el = document.getElementById("vera-usage-credits");
    if (el instanceof HTMLElement) el.hidden = true;
  }

  function syncNoCapToggleButton(payload) {
    const btn = document.getElementById("vera-no-cap-toggle");
    if (!(btn instanceof HTMLButtonElement)) return;
    const enabled = Boolean(payload?.no_cap_toggle_enabled);
    _noCapToggleEnabled = enabled;
    if (!enabled) {
      btn.hidden = true;
      btn.classList.remove("is-on");
      btn.textContent = "No cap: OFF";
      _noCapActive = false;
      return;
    }
    _noCapActive = Boolean(payload?.no_cap_active);
    btn.hidden = false;
    btn.classList.toggle("is-on", _noCapActive);
    btn.textContent = _noCapActive ? "No cap: ON" : "No cap: OFF";
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
    const noCapActive = Boolean(payload.no_cap_active);
    if (noCapActive) {
      textEl.textContent =
        authMode === "authenticated"
          ? `Credits: ${used} used · No cap`
          : `Free credits: ${used} used · No cap`;
    } else {
      textEl.textContent =
        authMode === "authenticated"
          ? `Credits: ${used} / ${cap}`
          : `Free credits: ${used} / ${cap}`;
    }
    wrap.title = formatUsageTooltip(authMode, bonus, noCapActive);
    wrap.hidden = false;
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

  try {
    if (typeof window !== "undefined") {
      window.veraRefreshUsageCredits = refreshUsageCreditsToday;
      window.renderUsageCreditsDisplay = renderUsageCreditsDisplay;
    }
  } catch (_) {}
})();
