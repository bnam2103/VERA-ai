/**
 * users/usageEvents.js — behavioral analytics (Phase 0+1: foundation + mode tracking).
 * Load AFTER utils/ids.js + users/supabaseAuth.js, BEFORE app.js.
 */
(function () {
  "use strict";

  const SESSION_START_KEY_PREFIX = "vera_usage_session_start:";
  const REPLY_DONE_KEY_PREFIX = "vera_usage_reply_done:";
  const MODE_HEARTBEAT_MS = 60000;
  const TINY_TRANSITION_FLUSH_MS = 50;
  const TRANSITION_FLUSH_SOURCES = new Set([
    "mode_change",
    "surface_exit",
    "vera_to_bmo",
  ]);
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
    "user_input_excerpt",
    "assistant_response_excerpt",
    "title",
    "query",
    "playlist_name",
    "song",
    "lyrics",
    "checklist_item",
    "panel_content",
    "markdown",
    "uri",
  ]);
  const _pendingByRequest = new Map();
  const _modeTracker = {
    uiMode: null,
    appSurface: null,
    sessionId: null,
    visibleSegmentStart: null,
    segmentId: null,
    heartbeatTimer: null,
  };
  let _segmentCounter = 0;
  let _veraLeavePending = null;

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
    try {
      const veraApp = document.getElementById("vera-app");
      if (veraApp?.classList?.contains) {
        return veraApp.classList.contains("work-mode");
      }
    } catch (_) {}
    return typeof isVeraWorkModeOn === "function" && isVeraWorkModeOn();
  }

  function isPageVisible() {
    try {
      return document.visibilityState !== "hidden";
    } catch (_) {
      return true;
    }
  }

  function resolveModeFromDom() {
    try {
      if (document.body.classList.contains("bmo-open")) {
        return { uiMode: "bmo", appSurface: "bmo" };
      }
      const veraApp = document.getElementById("vera-app");
      if (
        document.body.classList.contains("vera-mode") &&
        document.body.classList.contains("app-open") &&
        veraApp &&
        !veraApp.hidden
      ) {
        const work = workModeOn();
        return {
          uiMode: work ? "work_mode" : "voice_ui",
          appSurface: "vera",
        };
      }
    } catch (_) {}
    return null;
  }

  function isTrackingContext() {
    return resolveModeFromDom() !== null;
  }

  function resolveAppSurfaceFallback() {
    try {
      if (document.body.classList.contains("bmo-open")) return "bmo";
    } catch (_) {}
    return "vera";
  }

  function newSegmentId() {
    _segmentCounter += 1;
    let rand = "";
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        rand = crypto.randomUUID().slice(0, 8);
      }
    } catch (_) {}
    if (!rand) {
      rand = Math.random().toString(36).slice(2, 10);
    }
    return `seg_${_segmentCounter}_${rand}`;
  }

  function newClientEventId() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (_) {}
    return `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function startVisibleSegment() {
    _modeTracker.segmentId = newSegmentId();
    _modeTracker.visibleSegmentStart = performance.now();
    if (typeof getSessionId === "function") {
      _modeTracker.sessionId = getSessionId();
    }
  }

  function clearVisibleSegment() {
    _modeTracker.visibleSegmentStart = null;
  }

  function elapsedVisibleMs() {
    if (_modeTracker.visibleSegmentStart == null) return 0;
    return Math.max(0, Math.round(performance.now() - _modeTracker.visibleSegmentStart));
  }

  function buildEnvelopeProps(extra) {
    const mode = resolveModeFromDom();
    const base = {
      authenticated: isAuthenticated(),
      app_surface: mode?.appSurface || resolveAppSurfaceFallback(),
      ui_mode: mode?.uiMode || _modeTracker.uiMode || "unknown",
    };
    return sanitizeClientProps({ ...base, ...(extra && typeof extra === "object" ? extra : {}) });
  }

  function buildBody(eventType, props, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const body = {
      session_id: getSessionId(),
      event_type: eventType,
    };
    const rid = String(options.requestId || "").trim();
    if (rid) body.request_id = rid;
    const clientEventId = String(options.clientEventId || newClientEventId()).trim();
    if (clientEventId) body.client_event_id = clientEventId.slice(0, 128);
    const merged = buildEnvelopeProps(props);
    if (merged && typeof merged === "object" && Object.keys(merged).length) {
      body.event_props = merged;
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
    if (typeof getSessionId !== "function") return;
    const options = opts && typeof opts === "object" ? opts : {};
    const chatScoped =
      eventType === "message_sent" ||
      eventType === "assistant_reply_done" ||
      eventType === "assistant_reply_failed";
    if (chatScoped) {
      if (isChatHydrating()) return;
      if (!isTrackingContext()) return;
    } else if (
      eventType !== "page_hidden" &&
      eventType !== "mode_duration_flush" &&
      !isTrackingContext()
    ) {
      return;
    }
    const body = buildBody(eventType, props, options);
    void postUsageEvent(body, { beacon: Boolean(options.beacon) });
  }

  function emitModeDurationFlush(source, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const ms = elapsedVisibleMs();
    if (ms <= 0 || !_modeTracker.uiMode) return;

    const sourceKey = String(source || "unknown").slice(0, 32);
    if (
      options.skipTinyTransitionArtifact &&
      ms < TINY_TRANSITION_FLUSH_MS &&
      TRANSITION_FLUSH_SOURCES.has(sourceKey)
    ) {
      clearVisibleSegment();
      return;
    }

    const pinnedMode = _modeTracker.uiMode;
    const pinnedSurface = _modeTracker.appSurface || resolveAppSurfaceFallback();
    const pinnedSessionId =
      _modeTracker.sessionId ||
      (typeof getSessionId === "function" ? getSessionId() : "");
    const segmentId = _modeTracker.segmentId;
    clearVisibleSegment();

    if (!pinnedSessionId || !pinnedMode) return;

    const body = {
      session_id: pinnedSessionId,
      event_type: "mode_duration_flush",
      client_event_id: newClientEventId().slice(0, 128),
      event_props: sanitizeClientProps({
        mode: pinnedMode,
        ui_mode: pinnedMode,
        app_surface: pinnedSurface,
        duration_ms: ms,
        source: sourceKey,
        visible: options.visible !== false,
        segment_id: segmentId,
        authenticated: isAuthenticated(),
      }),
    };
    void postUsageEvent(body, { beacon: Boolean(options.beacon) });
  }

  function stopModeHeartbeat() {
    if (_modeTracker.heartbeatTimer != null) {
      clearInterval(_modeTracker.heartbeatTimer);
      _modeTracker.heartbeatTimer = null;
    }
  }

  function startModeHeartbeat() {
    stopModeHeartbeat();
    _modeTracker.heartbeatTimer = setInterval(() => {
      if (!isPageVisible() || !_modeTracker.uiMode) return;
      emitModeDurationFlush("heartbeat");
      if (_modeTracker.uiMode && isPageVisible()) {
        startVisibleSegment();
      }
    }, MODE_HEARTBEAT_MS);
  }

  function clearModeTrackerState() {
    _modeTracker.uiMode = null;
    _modeTracker.appSurface = null;
    _modeTracker.sessionId = null;
    clearVisibleSegment();
    stopModeHeartbeat();
  }

  function enterBmoModeFromPending(opts) {
    const pending = _veraLeavePending;
    const options = opts && typeof opts === "object" ? opts : {};
    const trigger = String(
      options.trigger || pending?.trigger || "ui"
    ).slice(0, 32);
    const prevMode = pending?.prevMode || null;
    const prevSurface = pending?.prevSurface || "vera";
    _veraLeavePending = null;

    if (prevMode) {
      trackUsageEvent(
        "mode_changed",
        {
          from_mode: prevMode,
          to_mode: "bmo",
          trigger,
          from_app_surface: prevSurface,
          to_app_surface: "bmo",
        },
        { clientEventId: newClientEventId() }
      );
    }
    trackUsageEvent(
      "bmo_mode_entered",
      { trigger, from: prevSurface },
      { clientEventId: newClientEventId() }
    );
    _modeTracker.uiMode = "bmo";
    _modeTracker.appSurface = "bmo";
    if (isPageVisible()) {
      startVisibleSegment();
    } else {
      clearVisibleSegment();
    }
    startModeHeartbeat();
  }

  function veraUsageLeaveVeraForBmo(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const trigger = String(options.trigger || "ui").slice(0, 32);
    const prevMode = _modeTracker.uiMode;
    const prevSurface = _modeTracker.appSurface || "vera";

    if (prevMode) {
      emitModeDurationFlush(options.source || "vera_to_bmo", {
        skipTinyTransitionArtifact: true,
        visible: isPageVisible(),
        beacon: Boolean(options.beacon),
      });
    }

    _veraLeavePending = {
      prevMode,
      prevSurface,
      trigger,
    };
    clearModeTrackerState();
  }

  function transitionToMode(newUiMode, newAppSurface, opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const trigger = String(options.trigger || "system").slice(0, 32);
    const prevMode = _modeTracker.uiMode;
    const prevSurface = _modeTracker.appSurface;

    if (newUiMode === "bmo" && newAppSurface === "bmo" && _veraLeavePending) {
      enterBmoModeFromPending(options);
      return;
    }

    if (!newUiMode) {
      if (!prevMode) return;
      emitModeDurationFlush(options.source || "surface_exit", {
        visible: isPageVisible(),
        beacon: Boolean(options.beacon),
        skipTinyTransitionArtifact: Boolean(options.skipTinyTransitionArtifact),
      });
      if (prevMode === "work_mode") {
        trackUsageEvent("work_mode_exited", { trigger }, { clientEventId: newClientEventId() });
      }
      if (prevMode === "bmo") {
        trackUsageEvent(
          "bmo_mode_exited",
          { trigger, to: String(options.to || "home").slice(0, 32) },
          { clientEventId: newClientEventId() }
        );
      }
      clearModeTrackerState();
      return;
    }

    if (prevMode === newUiMode && prevSurface === newAppSurface) {
      return;
    }

    if (prevMode) {
      emitModeDurationFlush(options.source || "mode_change", {
        visible: isPageVisible(),
        beacon: Boolean(options.beacon),
        skipTinyTransitionArtifact: Boolean(options.skipTinyTransitionArtifact),
      });
    }

    if (prevMode) {
      trackUsageEvent(
        "mode_changed",
        {
          from_mode: prevMode,
          to_mode: newUiMode,
          trigger,
          from_app_surface: prevSurface || resolveAppSurfaceFallback(),
          to_app_surface: newAppSurface,
        },
        { clientEventId: newClientEventId() }
      );
    }

    if (newUiMode === "work_mode" && prevMode !== "work_mode") {
      trackUsageEvent("work_mode_entered", { trigger }, { clientEventId: newClientEventId() });
    }
    if (prevMode === "work_mode" && newUiMode !== "work_mode") {
      trackUsageEvent("work_mode_exited", { trigger }, { clientEventId: newClientEventId() });
    }
    if (newUiMode === "bmo" && prevMode !== "bmo") {
      trackUsageEvent(
        "bmo_mode_entered",
        { trigger, from: prevSurface || "vera" },
        { clientEventId: newClientEventId() }
      );
    }
    if (prevMode === "bmo" && newUiMode !== "bmo") {
      trackUsageEvent(
        "bmo_mode_exited",
        { trigger, to: newUiMode || "home" },
        { clientEventId: newClientEventId() }
      );
    }

    _modeTracker.uiMode = newUiMode;
    _modeTracker.appSurface = newAppSurface;
    if (isPageVisible()) {
      startVisibleSegment();
    } else {
      clearVisibleSegment();
    }
    startModeHeartbeat();
  }

  function syncModeFromDom(opts) {
    const target = resolveModeFromDom();
    if (!target) {
      transitionToMode(null, null, opts);
      return;
    }
    transitionToMode(target.uiMode, target.appSurface, opts);
  }

  function trackUsageSessionStart() {
    if (typeof getSessionId !== "function") return;
    const mode = resolveModeFromDom();
    const surface = mode?.appSurface || resolveAppSurfaceFallback();
    const sid = getSessionId();
    const key = SESSION_START_KEY_PREFIX + surface + ":" + sid;
    try {
      if (sessionStorage.getItem(key) === "1") return;
      sessionStorage.setItem(key, "1");
    } catch (_) {}
    trackUsageEvent(
      "session_start",
      {
        app_surface: surface,
        authenticated: isAuthenticated(),
      },
      { clientEventId: newClientEventId() }
    );
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
      },
      { requestId, clientEventId: newClientEventId() }
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
    trackUsageEvent("assistant_reply_done", props, {
      requestId,
      clientEventId: newClientEventId(),
    });
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
      clientEventId: newClientEventId(),
    });
  }

  function sendPageHidden() {
    if (typeof getSessionId !== "function") return;
    emitModeDurationFlush("page_hidden", { visible: true, beacon: true });
    const body = buildBody("page_hidden", {
      visibility_state: document.visibilityState || "hidden",
    });
    void postUsageEvent(body, { beacon: true });
  }

  function wirePageLifecycle() {
    if (window.__veraUsageLifecycleHook === "1") return;
    window.__veraUsageLifecycleHook = "1";
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        sendPageHidden();
        return;
      }
      if (_modeTracker.uiMode && isTrackingContext()) {
        startVisibleSegment();
      }
    });
    window.addEventListener("pagehide", sendPageHidden);
  }

  wirePageLifecycle();

  try {
    if (typeof window !== "undefined") {
      window.trackUsageEvent = trackUsageEvent;
      window.trackUsageSessionStart = trackUsageSessionStart;
      window.veraUsageSyncModeFromDom = syncModeFromDom;
      window.veraUsageLeaveVeraForBmo = veraUsageLeaveVeraForBmo;
      window.veraUsageOnMessageSent = veraUsageOnMessageSent;
      window.veraUsageOnAssistantReplyDone = veraUsageOnAssistantReplyDone;
      window.veraUsageOnAssistantReplyFailed = veraUsageOnAssistantReplyFailed;
      window.veraUsageResolveModeFromDom = resolveModeFromDom;
      if (isTrackingContext()) {
        syncModeFromDom({ trigger: "boot", source: "boot" });
      }
    }
  } catch (_) {}
})();
