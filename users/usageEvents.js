/**
 * users/usageEvents.js — lightweight behavioral analytics (MVP slice).
 * Load AFTER utils/ids.js + users/supabaseAuth.js, BEFORE app.js.
 */
(function () {
  "use strict";

  const SESSION_START_KEY_PREFIX = "vera_usage_session_start:";
  const REPLY_DONE_KEY_PREFIX = "vera_usage_reply_done:";
  const FORBIDDEN_PROP_KEYS = new Set([
    "text",
    "transcript",
    "reply",
    "audio",
    "token",
    "note",
    "excerpt",
    "password",
    "email",
    "content",
    "message",
    "body",
    "assistant_response",
    "user_input",
  ]);
  const _pendingByRequest = new Map();

  function sanitizeClientProps(props) {
    if (!props || typeof props !== "object") return props;
    const out = {};
    for (const [rawKey, rawVal] of Object.entries(props)) {
      const key = String(rawKey || "").trim().toLowerCase();
      if (!key || FORBIDDEN_PROP_KEYS.has(key)) continue;
      if (
        typeof rawVal === "boolean" ||
        typeof rawVal === "number" ||
        typeof rawVal === "string"
      ) {
        out[key] = rawVal;
      }
    }
    return out;
  }

  function isVeraTrackingContext() {
    try {
      return (
        document.body.classList.contains("vera-mode") &&
        !document.body.classList.contains("bmo-open")
      );
    } catch (_) {
      return false;
    }
  }

  function isChatHydrating() {
    try {
      if (typeof window.veraIsChatStateHydrating === "function") {
        return window.veraIsChatStateHydrating();
      }
    } catch (_) {}
    return false;
  }

  function isAuthenticated() {
    return (
      typeof isSupabaseUserAuthenticated === "function" &&
      isSupabaseUserAuthenticated()
    );
  }

  function workModeOn() {
    return typeof isVeraWorkModeOn === "function" && isVeraWorkModeOn();
  }

  function buildBody(eventType, props, requestId) {
    const body = {
      session_id: getSessionId(),
      event_type: eventType,
    };
    const rid = String(requestId || "").trim();
    if (rid) body.request_id = rid;
    if (props && typeof props === "object" && Object.keys(props).length) {
      body.event_props = sanitizeClientProps(props);
    }
    return body;
  }

  async function postUsageEvent(body, { beacon = false } = {}) {
    if (typeof authApiUrl !== "function") return;
    const url = authApiUrl("/api/usage/events");
    const json = JSON.stringify(body);
    if (beacon) {
      try {
        const headers = { "Content-Type": "application/json" };
        if (typeof getSupabaseAccessToken === "function") {
          const token = await getSupabaseAccessToken();
          if (token) headers.Authorization = `Bearer ${token}`;
        }
        if (typeof fetch === "function") {
          void fetch(url, {
            method: "POST",
            headers,
            body: json,
            keepalive: true,
          }).catch(() => {});
          return;
        }
      } catch (_) {}
      try {
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([json], { type: "application/json" }));
        }
      } catch (_) {}
      return;
    }
    if (typeof authFetch !== "function") return;
    void authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
    }).catch(() => {});
  }

  function trackUsageEvent(eventType, props, opts) {
    if (!isVeraTrackingContext()) return;
    if (typeof getSessionId !== "function") return;
    if (isChatHydrating()) return;
    const options = opts && typeof opts === "object" ? opts : {};
    const body = buildBody(eventType, props, options.requestId);
    void postUsageEvent(body, { beacon: Boolean(options.beacon) });
  }

  function trackUsageSessionStart() {
    if (!isVeraTrackingContext()) return;
    if (typeof getSessionId !== "function") return;
    const sid = getSessionId();
    const key = SESSION_START_KEY_PREFIX + sid;
    try {
      if (sessionStorage.getItem(key) === "1") return;
      sessionStorage.setItem(key, "1");
    } catch (_) {}
    trackUsageEvent("session_start", {
      page: "vera",
      authenticated: isAuthenticated(),
    });
  }

  function veraUsageOnMessageSent(ctx) {
    if (isChatHydrating()) return;
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const requestId = String(c.requestId || "").trim();
    const source = String(c.source || "unknown").slice(0, 32);
    const inputChars = Number(c.inputChars) || 0;
    if (requestId) {
      _pendingByRequest.set(requestId, {
        sendAt: performance.now(),
        source,
      });
    }
    trackUsageEvent(
      "message_sent",
      {
        source,
        input_chars: inputChars,
        work_mode_on: workModeOn(),
        authenticated: isAuthenticated(),
      },
      { requestId }
    );
  }

  function veraUsageOnAssistantReplyDone(bubbleEl, ctx) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const requestId = String(c.requestId || "").trim();
    if (requestId) {
      const dedupeKey = REPLY_DONE_KEY_PREFIX + getSessionId() + ":" + requestId;
      try {
        if (sessionStorage.getItem(dedupeKey) === "1") return;
        sessionStorage.setItem(dedupeKey, "1");
      } catch (_) {}
    }
    let latencyMs = c.latencyMs;
    const pending = requestId ? _pendingByRequest.get(requestId) : null;
    if (latencyMs == null && pending) {
      latencyMs = Math.round(performance.now() - pending.sendAt);
    }
    const source =
      String(c.source || pending?.source || "unknown").slice(0, 32);
    let responseChars = Number(c.responseChars);
    if (!Number.isFinite(responseChars) && bubbleEl) {
      responseChars = String(bubbleEl.textContent || "").length;
    }
    const props = {
      source,
      response_chars: Number.isFinite(responseChars) ? responseChars : 0,
      work_mode_on: workModeOn(),
    };
    if (latencyMs != null && Number.isFinite(latencyMs)) {
      props.latency_ms = latencyMs;
    }
    trackUsageEvent("assistant_reply_done", props, { requestId });
    if (requestId) _pendingByRequest.delete(requestId);
  }

  function veraUsageOnAssistantReplyFailed(ctx) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const source = String(c.source || "unknown").slice(0, 32);
    const props = {
      source,
      work_mode_on: workModeOn(),
    };
    const errorCode = String(c.errorCode || "").trim().slice(0, 64);
    if (errorCode) props.error_code = errorCode;
    const httpStatus = Number(c.httpStatus);
    if (Number.isFinite(httpStatus) && httpStatus > 0) {
      props.http_status = httpStatus;
    }
    trackUsageEvent("assistant_reply_failed", props, {
      requestId: c.requestId,
    });
  }

  function sendPageHidden() {
    if (!isVeraTrackingContext()) return;
    if (typeof getSessionId !== "function") return;
    const body = buildBody("page_hidden", {
      visibility_state: document.visibilityState || "hidden",
    });
    void postUsageEvent(body, { beacon: true });
  }

  function wirePageLifecycle() {
    if (window.__veraUsageLifecycleHook === "1") return;
    window.__veraUsageLifecycleHook = "1";
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") sendPageHidden();
    });
    window.addEventListener("pagehide", sendPageHidden);
  }

  wirePageLifecycle();

  try {
    if (typeof window !== "undefined") {
      window.trackUsageEvent = trackUsageEvent;
      window.trackUsageSessionStart = trackUsageSessionStart;
      window.veraUsageOnMessageSent = veraUsageOnMessageSent;
      window.veraUsageOnAssistantReplyDone = veraUsageOnAssistantReplyDone;
      window.veraUsageOnAssistantReplyFailed = veraUsageOnAssistantReplyFailed;
    }
  } catch (_) {}
})();
