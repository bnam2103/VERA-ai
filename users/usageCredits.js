/**
 * users/usageCredits.js — daily credit usage pill (read-only).
 * Load AFTER users/supabaseAuth.js + users/usageFeatureEvents.js, BEFORE app.js.
 */
(function () {
  "use strict";

  let _refreshInFlight = null;

  function hideUsagePill() {
    const el = document.getElementById("vera-usage-credits");
    if (el instanceof HTMLElement) el.hidden = true;
  }

  function formatUsageTooltip(authMode, bonusCredits, isDevUnlimited) {
    if (isDevUnlimited) {
      return "Developer unlimited credits (testing). Usage is still logged.";
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
    if (!payload || payload.ok !== true) {
      hideUsagePill();
      return;
    }
    const used = Number(payload.credits_used) || 0;
    const cap = payload.credits_cap;
    const bonus = Number(payload.bonus_credits) || 0;
    const authMode = payload.auth_mode === "authenticated" ? "authenticated" : "anonymous";
    const isDevUnlimited = payload.is_dev_unlimited === true;
    if (isDevUnlimited) {
      textEl.textContent = `Developer — Credits: ${used} / ∞`;
    } else if (authMode === "authenticated") {
      textEl.textContent = `Credits: ${used} / ${Number(cap) || 0}`;
    } else {
      textEl.textContent = `Free credits: ${used} / ${Number(cap) || 0}`;
    }
    wrap.title = formatUsageTooltip(authMode, bonus, isDevUnlimited);
    wrap.hidden = false;
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
          return null;
        }
        const data = await res.json().catch(() => null);
        if (!data || data.ok !== true) {
          hideUsagePill();
          return null;
        }
        renderUsageCreditsDisplay(data);
        return data;
      } catch (_) {
        hideUsagePill();
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

  wireUsageCreditsRefreshHooks();

  try {
    if (typeof window !== "undefined") {
      window.veraRefreshUsageCredits = refreshUsageCreditsToday;
      window.renderUsageCreditsDisplay = renderUsageCreditsDisplay;
    }
  } catch (_) {}
})();
