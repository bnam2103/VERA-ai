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

  /** Remove every feedback bar from the conversation (previous replies). */
  function clearActiveFeedbackBars() {
    const convo = feedbackConversationEl();
    if (!convo) return;
    convo.querySelectorAll(".vera-feedback-bar").forEach((bar) => {
      bar.remove();
    });
    _activeRow = null;
  }

  function getBarParts(bar) {
    if (!(bar instanceof HTMLElement)) return {};
    return {
      controls: bar.querySelector(".vera-feedback-controls"),
      upBtn: bar.querySelector(".vera-feedback-btn--up"),
      downBtn: bar.querySelector(".vera-feedback-btn--down"),
      noteWrap: bar.querySelector(".vera-feedback-note-wrap"),
      noteInput: bar.querySelector(".vera-feedback-note"),
      noteSubmit: bar.querySelector(".vera-feedback-note-submit"),
      thanks: bar.querySelector(".vera-feedback-thanks"),
    };
  }

  function isNoteEditorOpen(bar) {
    const { noteWrap } = getBarParts(bar);
    return Boolean(
      noteWrap instanceof HTMLElement &&
        !noteWrap.hidden &&
        noteWrap.classList.contains("is-open")
    );
  }

  function closeNoteEditor(bar) {
    const { noteWrap, noteInput, upBtn, downBtn } = getBarParts(bar);
    if (!(noteWrap instanceof HTMLElement)) return;
    noteWrap.hidden = true;
    noteWrap.classList.remove("is-open");
    if (noteInput instanceof HTMLInputElement) noteInput.value = "";
    if (upBtn instanceof HTMLButtonElement) upBtn.disabled = false;
    if (downBtn instanceof HTMLButtonElement) downBtn.disabled = false;
  }

  function showThanksState(bar) {
    if (!(bar instanceof HTMLElement)) return;
    closeNoteEditor(bar);
    const { controls, thanks, upBtn, downBtn, noteSubmit } = getBarParts(bar);
    if (controls instanceof HTMLElement) {
      controls.hidden = true;
      controls.setAttribute("aria-hidden", "true");
    }
    if (upBtn instanceof HTMLButtonElement) upBtn.disabled = true;
    if (downBtn instanceof HTMLButtonElement) downBtn.disabled = true;
    if (noteSubmit instanceof HTMLButtonElement) noteSubmit.disabled = true;
    if (thanks instanceof HTMLElement) {
      thanks.hidden = false;
      thanks.removeAttribute("aria-hidden");
    }
    bar.classList.add("is-submitted");
  }

  function finishDownSubmit(bar) {
    if (!(bar instanceof HTMLElement)) return;
    closeNoteEditor(bar);
    const { controls, upBtn, downBtn, noteSubmit } = getBarParts(bar);
    if (upBtn instanceof HTMLButtonElement) upBtn.disabled = true;
    if (downBtn instanceof HTMLButtonElement) downBtn.disabled = true;
    if (noteSubmit instanceof HTMLButtonElement) noteSubmit.disabled = true;
    bar.classList.add("is-submitted");
    if (controls instanceof HTMLElement) {
      controls.hidden = true;
      controls.setAttribute("aria-hidden", "true");
    }
  }

  function submitFeedback(row, rating, note) {
    if (!(row instanceof HTMLElement)) return;
    if (row.dataset.feedbackSubmitted === "1") return;
    if (!feedbackAuthenticated()) return;
    if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return;
    if (typeof getSessionId !== "function") return;

    const bubble = row.querySelector(".bubble.vera");
    const bar = row.querySelector(".vera-feedback-bar");
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
    if (rating === "up") {
      showThanksState(bar);
    } else {
      finishDownSubmit(bar);
    }

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

    const controls = document.createElement("div");
    controls.className = "vera-feedback-controls";

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

    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "vera-feedback-note";
    noteInput.maxLength = MAX_NOTE;
    noteInput.placeholder = "What went wrong? (optional)";
    noteInput.setAttribute("aria-label", "Optional feedback note");

    const noteSubmit = document.createElement("button");
    noteSubmit.type = "button";
    noteSubmit.className = "vera-feedback-note-submit";
    noteSubmit.textContent = "Send";

    noteWrap.appendChild(noteInput);
    noteWrap.appendChild(noteSubmit);

    const thanks = document.createElement("span");
    thanks.className = "vera-feedback-thanks";
    thanks.hidden = true;
    thanks.setAttribute("aria-hidden", "true");
    thanks.textContent = "Thanks";

    upBtn.addEventListener("click", () => {
      if (row.dataset.feedbackSubmitted === "1") return;
      if (isNoteEditorOpen(bar)) {
        closeNoteEditor(bar);
        return;
      }
      submitFeedback(row, "up", null);
    });

    downBtn.addEventListener("click", () => {
      if (row.dataset.feedbackSubmitted === "1") return;
      noteWrap.hidden = false;
      noteWrap.classList.add("is-open");
      noteInput.focus();
    });

    noteSubmit.addEventListener("click", () => {
      submitFeedback(row, "down", noteInput.value);
    });

    noteInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitFeedback(row, "down", noteInput.value);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeNoteEditor(bar);
      }
    });

    controls.appendChild(upBtn);
    controls.appendChild(downBtn);
    controls.appendChild(noteWrap);
    bar.appendChild(controls);
    bar.appendChild(thanks);
    row.appendChild(bar);
    return bar;
  }

  function showFeedbackForRow(row) {
    if (!(row instanceof HTMLElement)) return;
    if (row.dataset.feedbackSubmitted === "1") return;
    if (!feedbackAuthenticated()) {
      clearActiveFeedbackBars();
      return;
    }
    clearActiveFeedbackBars();
    _activeRow = row;
    const bar = buildFeedbackBar(row);
    bar.hidden = false;
    bar.removeAttribute("aria-hidden");
  }

  function veraFeedbackSetPendingUser(text) {
    _pendingUserExcerpt = truncateText(text, MAX_EXCERPT);
  }

  function veraFeedbackOnNewUserMessage() {
    clearActiveFeedbackBars();
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
    clearActiveFeedbackBars();
  }

  try {
    if (typeof window !== "undefined") {
      window.veraFeedbackSetPendingUser = veraFeedbackSetPendingUser;
      window.veraFeedbackOnNewUserMessage = veraFeedbackOnNewUserMessage;
      window.veraFeedbackMarkFinal = veraFeedbackMarkFinal;
      window.veraFeedbackOnAuthChanged = veraFeedbackOnAuthChanged;
    }
  } catch (_) {}
})();
