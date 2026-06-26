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

  function formatFeatureTooltip(features, authMode) {
    const f = features && typeof features === "object" ? features : {};
    const wm = f.work_mode || {};
    const search = f.search || {};
    const img = f.image_pdf || {};
    const lines = [
      `Work Mode: ${Number(wm.used) || 0} / ${Number(wm.cap) || 0}`,
      `Search: ${Number(search.used) || 0} / ${Number(search.cap) || 0}`,
      `Image/PDF: ${Number(img.used) || 0} / ${Number(img.cap) || 0}`,
    ];
    if (authMode === "anonymous") {
      lines.push("Sign in for higher daily limits.");
    }
    return lines.join("\n");
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
    const cap = Number(payload.credits_cap) || 0;
    const authMode = payload.auth_mode === "authenticated" ? "authenticated" : "anonymous";
    textEl.textContent =
      authMode === "authenticated"
        ? `Credits: ${used} / ${cap}`
        : `Free credits: ${used} / ${cap}`;
    wrap.title = formatFeatureTooltip(payload.features, authMode);
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
