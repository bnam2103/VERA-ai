/**
 * users/explicitFeedback.js — explicit feedback form (+50 bonus credits / day).
 * Load AFTER users/usageCredits.js and users/supabaseAuth.js, BEFORE app.js.
 */
(function () {
  "use strict";

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

  function $(id) {
    return document.getElementById(id);
  }

  function showError(msg) {
    const el = $("vera-explicit-feedback-error");
    if (!(el instanceof HTMLElement)) return;
    el.textContent = msg || "";
    el.hidden = !msg;
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
    const btn = $("vera-explicit-feedback-btn");
    if (!(btn instanceof HTMLButtonElement)) return;
  btn.textContent = "Give feedback +50 credits";
    if (_alreadyClaimed) {
      btn.disabled = true;
      btn.title = "Feedback bonus already claimed today.";
      btn.textContent = "Feedback bonus claimed today";
    } else {
      btn.disabled = false;
      btn.title = "Share feedback and unlock +50 bonus credits for today.";
    }
    btn.hidden = false;
  }

  function renderCategoryBubbles() {
    const wrap = $("vera-explicit-feedback-categories");
    if (!(wrap instanceof HTMLElement)) return;
    wrap.innerHTML = "";
    for (const opt of CATEGORY_OPTIONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "vera-feedback-category-chip";
      chip.dataset.category = opt.key;
      chip.textContent = opt.label;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const on = chip.classList.toggle("is-selected");
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
          b.classList.remove("is-selected");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("is-selected");
        btn.setAttribute("aria-pressed", "true");
      });
    });
  }

  function openModal() {
    const modal = $("vera-explicit-feedback-modal");
    if (!(modal instanceof HTMLElement)) return;
    showError("");
    showSuccess("");
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

  async function refreshFeedbackStatus() {
    if (typeof getSessionId !== "function" || typeof authApiUrl !== "function") return;
    const sid = String(getSessionId() || "").trim();
    if (!sid) return;
    const fetchFn = typeof authFetch === "function" ? authFetch : fetch;
    try {
      const res = await fetchFn(
        authApiUrl(`/api/feedback/status?session_id=${encodeURIComponent(sid)}`),
        { method: "GET" }
      );
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) return;
      _alreadyClaimed = Boolean(data.already_claimed);
      _eligible = Boolean(data.eligible);
      _statusLoaded = true;
      updateFeedbackButton();
    } catch (_) {
      /* non-blocking */
    }
  }

  async function submitFeedback() {
    showError("");
    showSuccess("");
    const rating = selectedRating();
    const reasonEl = $("vera-explicit-feedback-reason");
    const reason = reasonEl instanceof HTMLTextAreaElement ? reasonEl.value.trim() : "";
    if (!rating) {
      showError("Please choose a rating from 1 to 5.");
      return;
    }
    if (!reason) {
      showError("Please tell us why you chose this rating.");
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
            : "Could not submit feedback. Please try again later."
        );
        return;
      }
      const granted = Number(data.granted_bonus_credits) || 0;
      if (granted > 0) {
        showSuccess("Thanks — 50 bonus credits unlocked for today.");
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
    } catch (_) {
      showError("Could not reach the server. Your feedback was not saved.");
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  }

  function wireModal() {
    $("vera-explicit-feedback-btn")?.addEventListener("click", () => {
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
  }

  function initExplicitFeedback() {
    renderCategoryBubbles();
    wireRatingButtons();
    wireModal();
    updateFeedbackButton();
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
