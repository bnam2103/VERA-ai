/**
 * users/feedback.js — thumbs up/down on the latest main-chat Vera reply (MVP).
 * Load AFTER users/supabaseAuth.js (authFetch, isSupabaseUserAuthenticated).
 */
(function () {
  "use strict";

  const MAX_EXCERPT = 500;
  const MAX_NOTE = 500;

  let _pendingUserExcerpt = "";
  let _activeRow = null;

  function truncateText(text, max) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (t.length <= max) return t;
    return t.slice(0, max);
  }

  function feedbackAuthenticated() {
    return (
      typeof isSupabaseUserAuthenticated === "function" &&
      isSupabaseUserAuthenticated()
    );
  }

  function feedbackConversationEl() {
    return document.getElementById("vera-conversation");
  }

  function isEligibleVeraBubble(bubble) {
    if (!(bubble instanceof HTMLElement)) return false;
    if (bubble.classList.contains("vera-pending-status")) return false;
    if (bubble.classList.contains("interrupt-preview")) return false;
    if (bubble.classList.contains("vera-work-mode-stage1-ack")) return false;
    const row = bubble.closest(".message-row.vera");
    if (!row) return false;
    const convo = feedbackConversationEl();
    return Boolean(convo && convo.contains(row));
  }

  function hideAllFeedbackBars() {
    const convo = feedbackConversationEl();
    if (!convo) return;
    convo.querySelectorAll(".vera-feedback-bar").forEach((bar) => {
      bar.hidden = true;
      bar.setAttribute("aria-hidden", "true");
    });
  }

  function disableFeedbackBar(row) {
    const bar = row?.querySelector?.(".vera-feedback-bar");
    if (!(bar instanceof HTMLElement)) return;
    bar.querySelectorAll("button, textarea").forEach((el) => {
      if (el instanceof HTMLButtonElement || el instanceof HTMLTextAreaElement) {
        el.disabled = true;
      }
    });
    bar.classList.add("is-submitted");
  }

  function submitFeedback(row, rating, note) {
    if (!(row instanceof HTMLElement)) return;
    if (row.dataset.feedbackSubmitted === "1") return;
    if (!feedbackAuthenticated()) return;
    if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return;
    if (typeof getSessionId !== "function") return;

    const bubble = row.querySelector(".bubble.vera");
    const payload = {
      rating,
      note: rating === "down" ? truncateText(note, MAX_NOTE) || null : null,
      session_id: getSessionId(),
      request_id: String(row.dataset.feedbackRequestId || "").trim() || null,
      turn_id: String(row.dataset.feedbackTurnId || "").trim() || null,
      user_input_excerpt:
        String(row.dataset.feedbackUserExcerpt || _pendingUserExcerpt || "").trim() ||
        null,
      assistant_response_excerpt:
        truncateText(bubble?.textContent || "", MAX_EXCERPT) || null,
      source: "main_chat",
    };

    row.dataset.feedbackSubmitted = "1";
    disableFeedbackBar(row);

    void authFetch(authApiUrl("/api/feedback"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  function buildFeedbackBar(row) {
    let bar = row.querySelector(".vera-feedback-bar");
    if (bar instanceof HTMLElement) return bar;

    bar = document.createElement("div");
    bar.className = "vera-feedback-bar";
    bar.hidden = true;
    bar.setAttribute("aria-hidden", "true");
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Rate this response");

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "vera-feedback-btn vera-feedback-btn--up";
    upBtn.title = "Helpful";
    upBtn.setAttribute("aria-label", "Thumbs up");
    upBtn.textContent = "👍";

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "vera-feedback-btn vera-feedback-btn--down";
    downBtn.title = "Not helpful";
    downBtn.setAttribute("aria-label", "Thumbs down");
    downBtn.textContent = "👎";

    const noteWrap = document.createElement("div");
    noteWrap.className = "vera-feedback-note-wrap";
    noteWrap.hidden = true;

    const noteInput = document.createElement("textarea");
    noteInput.className = "vera-feedback-note";
    noteInput.rows = 2;
    noteInput.maxLength = MAX_NOTE;
    noteInput.placeholder = "What went wrong? (optional)";
    noteInput.setAttribute("aria-label", "Optional feedback note");

    const noteSubmit = document.createElement("button");
    noteSubmit.type = "button";
    noteSubmit.className = "vera-feedback-note-submit";
    noteSubmit.textContent = "Send";

    noteWrap.appendChild(noteInput);
    noteWrap.appendChild(noteSubmit);

    upBtn.addEventListener("click", () => {
      submitFeedback(row, "up", null);
    });

    downBtn.addEventListener("click", () => {
      if (row.dataset.feedbackSubmitted === "1") return;
      noteWrap.hidden = false;
      downBtn.disabled = true;
      upBtn.disabled = true;
      noteInput.focus();
    });

    noteSubmit.addEventListener("click", () => {
      submitFeedback(row, "down", noteInput.value);
    });

    noteInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        submitFeedback(row, "down", noteInput.value);
      }
    });

    bar.appendChild(upBtn);
    bar.appendChild(downBtn);
    bar.appendChild(noteWrap);
    row.appendChild(bar);
    return bar;
  }

  function showFeedbackForRow(row) {
    if (!(row instanceof HTMLElement)) return;
    if (row.dataset.feedbackSubmitted === "1") return;
    if (!feedbackAuthenticated()) {
      hideAllFeedbackBars();
      return;
    }
    hideAllFeedbackBars();
    _activeRow = row;
    const bar = buildFeedbackBar(row);
    bar.hidden = false;
    bar.removeAttribute("aria-hidden");
  }

  function veraFeedbackSetPendingUser(text) {
    _pendingUserExcerpt = truncateText(text, MAX_EXCERPT);
  }

  function veraFeedbackMarkFinal(bubbleEl, ctx) {
    if (!isEligibleVeraBubble(bubbleEl)) return;
    const row = bubbleEl.closest(".message-row.vera");
    if (!(row instanceof HTMLElement)) return;

    const context = ctx && typeof ctx === "object" ? ctx : {};
    const requestId = String(context.requestId || "").trim();
    const turnId = String(context.turnId || "").trim();
    if (requestId) row.dataset.feedbackRequestId = requestId;
    if (turnId) row.dataset.feedbackTurnId = turnId;

    const userExcerpt = String(context.userExcerpt || "").trim();
    if (userExcerpt) {
      row.dataset.feedbackUserExcerpt = truncateText(userExcerpt, MAX_EXCERPT);
    } else if (_pendingUserExcerpt) {
      row.dataset.feedbackUserExcerpt = _pendingUserExcerpt;
    }

    showFeedbackForRow(row);
  }

  function veraFeedbackOnAuthChanged() {
    if (
      _activeRow &&
      _activeRow.isConnected &&
      _activeRow.dataset.feedbackSubmitted !== "1" &&
      feedbackAuthenticated()
    ) {
      const bubble = _activeRow.querySelector(".bubble.vera");
      if (isEligibleVeraBubble(bubble)) {
        showFeedbackForRow(_activeRow);
        return;
      }
    }
    hideAllFeedbackBars();
  }

  try {
    if (typeof window !== "undefined") {
      window.veraFeedbackSetPendingUser = veraFeedbackSetPendingUser;
      window.veraFeedbackMarkFinal = veraFeedbackMarkFinal;
      window.veraFeedbackOnAuthChanged = veraFeedbackOnAuthChanged;
    }
  } catch (_) {}
})();
