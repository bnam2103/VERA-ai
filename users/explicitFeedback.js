/**
 * users/explicitFeedback.js — explicit feedback form (+50 bonus credits / day).
 * Load AFTER users/usageCredits.js and users/supabaseAuth.js, BEFORE app.js.
 */
(function () {
  "use strict";

  const LOG_PREFIX = "[explicitFeedback]";
  const STATUS_RETRY_MS = 2500;
  const STATUS_RETRY_MAX = 4;

  const CATEGORY_OPTIONS = [
    { key: "work_mode", label: "Work Mode" },
    { key: "voice_assistant", label: "Voice assistant" },
    { key: "latency", label: "Latency" },
    { key: "response_quality", label: "Response quality" },
    { key: "search_news", label: "Search/news" },
    { key: "memory_context", label: "Memory/context" },
    { key: "ui_ux", label: "UI/UX" },
    { key: "bugs", label: "Bugs" },
    { key: "credit_limits", label: "Credit limits" },
    { key: "other", label: "Other" },
  ];

  let _statusLoaded = false;
  let _alreadyClaimed = false;
  let _eligible = true;
  let _statusRetryCount = 0;
  let _statusRetryTimer = null;
  let _wired = false;

  function logInfo(...args) {
    try {
      console.log(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  function logWarn(...args) {
    try {
      console.warn(LOG_PREFIX, ...args);
    } catch (_) {}
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setFeedbackSidebarLabel(btn) {
    if (!(btn instanceof HTMLButtonElement)) return;
    let labelEl = btn.querySelector(".vera-sidebar-btn-label");
    if (!(labelEl instanceof HTMLElement)) {
      labelEl = document.createElement("span");
      labelEl.className = "vera-sidebar-btn-label vera-sidebar-btn-label--feedback";
      btn.appendChild(labelEl);
    }
    labelEl.className = "vera-sidebar-btn-label vera-sidebar-btn-label--feedback";
    labelEl.innerHTML =
      '<span class="sidebar-feedback-text">Feedback</span>' +
      '<span class="sidebar-reward">+50 credits</span>';
  }

  function ensureFeedbackButtonDom() {
    let btn = $("vera-explicit-feedback-btn");
    if (btn instanceof HTMLButtonElement) return btn;
    const nav = document.querySelector(".vera-sidebar-nav");
    if (!(nav instanceof HTMLElement)) {
      logWarn("sidebar nav missing; feedback button not mounted");
      return null;
    }
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "vera-explicit-feedback-btn";
    btn.className = "vera-sidebar-btn vera-sidebar-btn--feedback vera-explicit-feedback-btn";
    btn.setAttribute("aria-label", "Give feedback and earn 50 credits");
    btn.innerHTML =
      '<span class="vera-sidebar-btn-icon" aria-hidden="true">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
      "</svg></span>" +
      '<span class="vera-sidebar-btn-label vera-sidebar-btn-label--feedback">' +
      '<span class="sidebar-feedback-text">Feedback</span>' +
      '<span class="sidebar-reward">+50 credits</span>' +
      "</span>";
    nav.prepend(btn);
    logInfo("created feedback button in sidebar");
    return btn;
  }

  function showError(msg) {
    const el = $("vera-explicit-feedback-error");
    if (!(el instanceof HTMLElement)) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function showRatingError(msg) {
    const el = $("vera-explicit-feedback-rating-error");
    if (!(el instanceof HTMLElement)) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function clearRatingError() {
    showRatingError("");
  }

  function showSuccess(msg) {
    const el = $("vera-explicit-feedback-success");
    if (!(el instanceof HTMLElement)) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function setFormVisible(visible) {
    const form = $("vera-explicit-feedback-form");
    if (form instanceof HTMLElement) form.hidden = !visible;
  }

  function updateFeedbackButton() {
    const btn = ensureFeedbackButtonDom();
    if (!(btn instanceof HTMLButtonElement)) return;
    setFeedbackSidebarLabel(btn);
    btn.setAttribute("aria-label", "Give feedback and earn 50 credits");
    btn.hidden = false;
    btn.style.display = "";
    btn.removeAttribute("aria-hidden");
    if (_alreadyClaimed) {
      btn.disabled = true;
      btn.title = "Feedback bonus already claimed today.";
    } else {
      btn.disabled = false;
      btn.title = _statusLoaded
        ? "Share feedback and unlock +50 bonus credits for today."
        : "Share feedback and unlock +50 bonus credits for today. (Checking bonus status…)";
    }
  }

  function renderCategoryBubbles() {
    const wrap = $("vera-explicit-feedback-categories");
    if (!(wrap instanceof HTMLElement)) return;
    wrap.innerHTML = "";
    for (const opt of CATEGORY_OPTIONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "vera-feedback-category-chip category-chip";
      chip.dataset.category = opt.key;
      chip.textContent = opt.label;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const on = chip.classList.toggle("is-selected");
        chip.classList.toggle("active", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      });
      wrap.appendChild(chip);
    }
  }

  function selectedCategories() {
    const wrap = $("vera-explicit-feedback-categories");
    if (!(wrap instanceof HTMLElement)) return [];
    return Array.from(wrap.querySelectorAll(".vera-feedback-category-chip.is-selected"))
      .map((el) => String(el.dataset.category || "").trim())
      .filter(Boolean);
  }

  function selectedRating() {
    const active = document.querySelector(".vera-feedback-rating-btn.is-selected");
    if (!active) return 0;
    return Number(active.dataset.rating) || 0;
  }

  function wireRatingButtons() {
    const wrap = $("vera-explicit-feedback-rating");
    if (!(wrap instanceof HTMLElement)) return;
    wrap.querySelectorAll(".vera-feedback-rating-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        wrap.querySelectorAll(".vera-feedback-rating-btn").forEach((b) => {
          b.classList.remove("is-selected", "active");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("is-selected", "active");
        btn.setAttribute("aria-pressed", "true");
        clearRatingError();
      });
    });
  }

  function openModal() {
    const modal = $("vera-explicit-feedback-modal");
    if (!(modal instanceof HTMLElement)) {
      logWarn("feedback modal markup missing");
      return;
    }
    showError("");
    showSuccess("");
    clearRatingError();
    setFormVisible(true);
    const contactWrap = $("vera-explicit-feedback-contact-wrap");
    const signedIn =
      typeof isSupabaseUserAuthenticated === "function" &&
      isSupabaseUserAuthenticated();
    if (contactWrap instanceof HTMLElement) {
      contactWrap.hidden = !signedIn;
    }
    if (_alreadyClaimed) {
      showSuccess("Feedback bonus already claimed today. You can still send more feedback.");
    }
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    const modal = $("vera-explicit-feedback-modal");
    if (!(modal instanceof HTMLElement)) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function scheduleStatusRetry(reason) {
    if (_statusRetryCount >= STATUS_RETRY_MAX) {
      logWarn("status check gave up after retries:", reason);
      return;
    }
    if (_statusRetryTimer != null) return;
    _statusRetryCount += 1;
    _statusRetryTimer = window.setTimeout(() => {
      _statusRetryTimer = null;
      void refreshFeedbackStatus();
    }, STATUS_RETRY_MS);
  }

  async function refreshFeedbackStatus() {
    updateFeedbackButton();
    if (typeof getSessionId !== "function" || typeof authApiUrl !== "function") {
      logWarn("session/auth helpers not ready yet; will retry");
      scheduleStatusRetry("helpers-missing");
      return;
    }
    const sid = String(getSessionId() || "").trim();
    if (!sid) {
      logWarn("session_id empty; will retry");
      scheduleStatusRetry("missing-session-id");
      return;
    }
    const fetchFn = typeof authFetch === "function" ? authFetch : fetch;
    try {
      const res = await fetchFn(
        authApiUrl(`/api/feedback/status?session_id=${encodeURIComponent(sid)}`),
        { method: "GET" }
      );
      if (!res.ok) {
        logWarn("status HTTP", res.status, res.statusText || "");
        scheduleStatusRetry(`http-${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) {
        logWarn("status payload invalid", data);
        scheduleStatusRetry("bad-payload");
        return;
      }
      _alreadyClaimed = Boolean(data.already_claimed);
      _eligible = Boolean(data.eligible);
      _statusLoaded = true;
      _statusRetryCount = 0;
      updateFeedbackButton();
      logInfo("status ok", {
        already_claimed: _alreadyClaimed,
        eligible: _eligible,
        bonus_credits: data.bonus_credits,
      });
    } catch (err) {
      logWarn("status fetch failed", err);
      scheduleStatusRetry("network-error");
    }
  }

  async function submitFeedback() {
    showError("");
    showSuccess("");
    clearRatingError();
    const rating = selectedRating();
    const reasonEl = $("vera-explicit-feedback-reason");
    const reason = reasonEl instanceof HTMLTextAreaElement ? reasonEl.value.trim() : "";
    if (!rating) {
      showRatingError("Please choose a rating from 1 to 5.");
      return;
    }
    if (!reason) {
      showError("Please tell us what should improve.");
      return;
    }
    const sid = typeof getSessionId === "function" ? String(getSessionId() || "").trim() : "";
    if (!sid) {
      showError("Session unavailable. Please refresh and try again.");
      return;
    }
    const submitBtn = $("vera-explicit-feedback-submit");
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    const contactEl = $("vera-explicit-feedback-contact");
    const body = {
      session_id: sid,
      rating,
      reason,
      categories: selectedCategories(),
      contact_ok: contactEl instanceof HTMLInputElement ? contactEl.checked : false,
      route_context: window.location?.pathname || "",
      app_version: "vera-web",
    };
    const fetchFn = typeof authFetch === "function" ? authFetch : fetch;
    try {
      const res = await fetchFn(authApiUrl("/api/feedback/submit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.detail;
        showError(
          typeof detail === "string"
            ? detail
            : "Could not submit feedback. Please try again."
        );
        logWarn("submit failed", res.status, detail || data);
        return;
      }
      const granted = Number(data.granted_bonus_credits) || 0;
      if (granted > 0) {
        showSuccess("Thanks — +50 credits unlocked.");
        _alreadyClaimed = true;
        _eligible = false;
        setFormVisible(false);
      } else if (data.already_claimed) {
        showSuccess("Thanks for your feedback. Bonus already claimed today.");
        _alreadyClaimed = true;
        setFormVisible(false);
      } else {
        showSuccess("Thanks for your feedback.");
        setFormVisible(false);
      }
      updateFeedbackButton();
      try {
        window.veraRefreshUsageCredits?.();
      } catch (_) {}
      await refreshFeedbackStatus();
    } catch (err) {
      showError("Could not reach the server. Your feedback was not saved.");
      logWarn("submit network error", err);
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  }

  function wireModal() {
    if (_wired) return;
    _wired = true;
    ensureFeedbackButtonDom()?.addEventListener("click", () => {
      void refreshFeedbackStatus().finally(openModal);
    });
    $("vera-explicit-feedback-close")?.addEventListener("click", closeModal);
    $("vera-explicit-feedback-cancel")?.addEventListener("click", closeModal);
    $("vera-explicit-feedback-modal")?.addEventListener("click", (ev) => {
      if (ev.target instanceof HTMLElement && ev.target.classList.contains("vera-explicit-feedback-backdrop")) {
        closeModal();
      }
    });
    $("vera-explicit-feedback-submit")?.addEventListener("click", () => {
      void submitFeedback();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      const modal = $("vera-explicit-feedback-modal");
      if (!(modal instanceof HTMLElement) || modal.hidden) return;
      closeModal();
    });
  }

  function watchVeraAppVisibility() {
    const app = $("vera-app");
    if (!(app instanceof HTMLElement)) return;
    const onVisible = () => {
      if (app.hidden) return;
      updateFeedbackButton();
      void refreshFeedbackStatus();
    };
    onVisible();
    try {
      const obs = new MutationObserver(onVisible);
      obs.observe(app, { attributes: true, attributeFilter: ["hidden"] });
    } catch (_) {}
  }

  function initExplicitFeedback() {
    logInfo("loaded");
    renderCategoryBubbles();
    wireRatingButtons();
    wireModal();
    updateFeedbackButton();
    watchVeraAppVisibility();
    void refreshFeedbackStatus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initExplicitFeedback);
  } else {
    initExplicitFeedback();
  }

  try {
    if (typeof window !== "undefined") {
      window.veraRefreshFeedbackStatus = refreshFeedbackStatus;
    }
  } catch (_) {}
})();
