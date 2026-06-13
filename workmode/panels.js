/* =========================================================================
 *  workmode/panels.js — reasoning panel UI / close orchestration layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 8). Behavior is preserved EXACTLY:
 *    - same DOM markup (`vera-reasoning-tab-panel`, `vera-reasoning-md-panel`,
 *      `vera-reasoning-tab`, `vera-reasoning-tab-close`, `vera-reasoning-tab-slot`),
 *    - same panel labels (Panel 1 / Panel 2 / Panel 3, Untitled),
 *    - same MIN/MAX panel invariants (REASONING_TABS_DEFAULT=3,
 *      REASONING_TABS_MAX=8 — both still defined in app.js, read here
 *      via shared lexical env),
 *    - same close-refill semantics (cancel in-flight stream, snapshot
 *      to undo stack, replace closed panel with a fresh blank one,
 *      pick right-neighbor active, normalize blank labels back to
 *      "Panel N"),
 *    - same close-turn lock contract (REASONING_CLOSE_TURN_LOCK_MS=4000),
 *    - same recently-closed undo stack size (16),
 *    - same console labels (`[reasoning_close_debug]`,
 *      `[reasoning_close_polish_debug]`,
 *      `[reasoning_panel_close_debug]`,
 *      `[reasoning_close_confirmation_debug]`,
 *      `[reasoning_panel_select_debug]`,
 *      `[reasoning_stream_cancelled_due_to_panel_close]`),
 *    - same voice-confirmation phrasing (one-panel / range / current /
 *      all / other / by-title forms).
 *  No multi-action planner. No reasoning generation changes. No
 *  ASR/TTS/interruption changes. No checklist/news/music changes.
 *  Fixed user-bubble behavior for "go to panel 2 and explain X" /
 *  "explain X in panel 2" is preserved (no display-text change here).
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come AFTER voice/asr.js + voice/ttsQueue.js +
 *  voice/interruption.js (so the voice layer is initialized when this
 *  module's `renderReasoningCloseAssistantConfirmation` reaches for
 *  `enqueueAssistantTtsPlayback`, `playWorkModeTtsOnlyPhrase`,
 *  `setStatus`, listening state, etc.) and BEFORE app.js (so the moved
 *  function declarations and shared `let`/`const` bindings are visible
 *  through the classic-script global lexical env when app.js parses
 *  and runs).
 *
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/asr.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="voice/interruption.js?v=1"></script>
 *      <script src="workmode/panels.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Bare-identifier references in the moved code (all resolved at CALL
 *  TIME through the shared global lexical environment, not at module
 *  load):
 *    constants left in app.js:
 *      REASONING_TABS_MAX, REASONING_TABS_DEFAULT,
 *      REASONING_UNTITLED_TAB_NAME
 *    lane-registry helpers left in app.js:
 *      ensureStableLaneIdForPanelIndex,
 *      replaceStableLaneIdForPanelIndex,
 *      allocateWorkModeStableLaneId
 *    reasoning streaming state left in app.js:
 *      workModeReasoningAbortControllers (Map),
 *      workModeReasoningLaneBusy (Map),
 *      laneReasoningChainTail (Map),
 *      workModeReasoningPanelFollowUpQueue (Map),
 *      workModeCompletedReasoningByLaneId (object map),
 *      workModeReasoningFinalStatusByLaneId (Map),
 *      activeWorkModeReasoningContext (let),
 *      focusedWorkModeLaneId / focusedWorkModeLaneAt (let),
 *      workModeLastSubstantiveLaneIdx (let),
 *      workModeLastSubstantiveUserText (let)
 *    persistence/lookup helpers left in app.js:
 *      getReasoningTabsStateStorageKey,
 *      persistReasoningTabsState,
 *      syncReasoningLaneBusySlotsAfterDomChange,
 *      syncWorkModeReasoningCancelButton,
 *      setFocusedWorkModeLaneFromIndex
 *    voice-confirmation + lifecycle dependencies left in app.js:
 *      inputMuted (let), appModePrefix, isVeraWorkModeOn,
 *      isWorkModeMuteEnabled, addBubble,
 *      enqueueAssistantTtsPlayback, playWorkModeTtsOnlyPhrase,
 *      setStatus, listeningMode (let), processing (let),
 *      requestInFlight (let), waveState (let), voiceUxTurn (let),
 *      finishReasoningCloseVoiceTurnAfterAssistant,
 *      logReasoningCloseVoiceLifecycle
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers AND, for a subset, as
 *  window.* aliases for DevTools)
 *  ─────────────────────────────────────────────────────────────────────
 *    DOM/label helpers       getWorkModeReasoningLaneLabel,
 *                            getWorkModeReasoningLaneId,
 *                            createReasoningLanePanel,
 *                            getReasoningScrollElByLane,
 *                            getReasoningTabTopicLabel,
 *                            getReasoningTabTopicLabelSafe,
 *                            getReasoningPanelOrder
 *    predicates              isGenericAutoRenamableReasoningPanelTitle,
 *                            isDefaultWorkModeReasoningPanelLaneLabel,
 *                            _isGenericBlankReasoningPanelLabel,
 *                            _isBlankReasoningPanelElement
 *    tab strip + add/select  renderReasoningTabStrip, addReasoningTab,
 *                            activateReasoningTab,
 *                            logReasoningPanelSelectDebug
 *    close orchestration     MIN_REASONING_PANELS (const),
 *                            REASONING_RECENTLY_CLOSED_STACK_MAX (const),
 *                            recentlyClosedReasoningPanels (array),
 *                            REASONING_CLOSE_TURN_LOCK_MS (const),
 *                            _lastReasoningCloseLock (let),
 *                            _reasoningCloseLockKey,
 *                            _hasActiveReasoningCloseLock,
 *                            _setReasoningCloseLock,
 *                            _peekReasoningCloseLock,
 *                            logReasoningCloseDebug,
 *                            logReasoningClosePolishDebug,
 *                            snapshotReasoningLaneRegistryForDebug,
 *                            invalidateClosedReasoningLaneIdentity,
 *                            readPersistedReasoningPanelTitlesForDebug,
 *                            _normalizeBlankPanelNamesInOrder,
 *                            _pickActivePanelInfoAfterRefill,
 *                            snapshotReasoningPanelForUndo,
 *                            pickReplacementActivePanelInfo,
 *                            refillReasoningPanelsToMinimum,
 *                            closeReasoningPanelsByVisualIndices,
 *                            closeReasoningTab
 *    voice confirmation      _REASONING_CLOSE_COUNT_WORD_OUT,
 *                            _countWordOrNumber,
 *                            buildCloseReasoningPanelsVoiceReply,
 *                            isReasoningCloseVoiceSource,
 *                            logReasoningCloseConfirmationUiDebug,
 *                            renderReasoningCloseAssistantConfirmation
 *    accessor (new)          getReasoningPanelDebugState()
 *                              // read-only snapshot of panel order +
 *                              // recently-closed stack size
 *
 *  Helpers / state intentionally LEFT in app.js (and why):
 *    ensureFixedReasoningLanePanels       boot-time wiring; couples
 *                                         saved-state restoration with
 *                                         lane registry helpers and
 *                                         busy-slot reconciliation.
 *    persistReasoningTabsState /
 *      restoreReasoningTabsState          session-scoped storage key
 *                                         + lane-registry restore;
 *                                         tightly coupled to boot flow.
 *    wireReasoningTabStrip /
 *      wireReasoningMarkdownCodeCopy      DOM event wiring; one-time
 *                                         boot setup.
 *    getReasoningTabsStateStorageKey      session-id-scoped; lives
 *                                         with other session helpers.
 *    getReasoningPanelCountToEnsure /
 *      getReasoningPanelIndices /
 *      syncReasoningLaneBusySlotsAfterDomChange
 *                                         busy-slot reconciliation;
 *                                         tied to reasoning streaming.
 *    getReasoningPanelElementByLaneIdx /
 *      getReasoningPanelElementByLaneId   used heavily by reasoning
 *                                         streaming, follow-up queue UI,
 *                                         attachment insertion, etc.;
 *                                         left near those callers.
 *    setReasoningTabTopicFromFinal,
 *      buildReasoningTopicLabel,
 *      maybeSyncGenericLaneTitleFromMarkdown,
 *      extractLeadingMarkdownHeadingAsLaneTitle,
 *      readPersistedReasoningTabSnapshotForLane,
 *      reasoningTitleCandidateDebugLog,
 *      reasoningTitleUpdateDebugLog,
 *      reasoningLaneTitleSyncDebugLog,
 *      reasoningLlmTitleQueueDecision,
 *      sanitizeLlmReasoningPanelTitle,
 *      fetchReasoningPanelTitleLlm,
 *      heuristicReasoningPanelTitle,
 *      shouldQueueLlmReasoningPanelTitle,
 *      queueLlmReasoningPanelTitleAfterFirstCompletedTurn
 *                                         title sync / queue layer;
 *                                         tightly coupled to reasoning
 *                                         streaming + LLM call.
 *    finalizeReasoningCloseVoiceUserTurn,
 *      finishReasoningCloseVoiceTurnAfterAssistant,
 *      logReasoningCloseVoiceLifecycle,
 *      getReasoningCloseAsrModeLabel,
 *      getReasoningCloseMicStateLabel,
 *      getReasoningCloseActiveUserBubbleId,
 *      reasoningCloseVoiceLifecycleSeq
 *                                         voice-turn lifecycle helpers;
 *                                         deeply tied to ASR finalize,
 *                                         bubble commit, continuous
 *                                         listening restart.
 *    Voice/text close command parser:
 *      REASONING_CLOSE_ORDINAL_WORDS,
 *      REASONING_CLOSE_COUNT_WORDS,
 *      _looksLikeChecklistCommand,
 *      _hasReasoningCloseSubject,
 *      _explicitlyNonReasoningCloseSubject,
 *      _parseReasoningCloseRange,
 *      _parseReasoningCloseIndices,
 *      parseCloseReasoningPanelsCommand,
 *      _cleanCommandTextForClose,
 *      _extractAllCloseSpans,
 *      _pickStrongestCloseSpan,
 *      findReasoningPanelIndicesByTitleQuery,
 *      reopenLastClosedReasoningPanel,
 *      executeCloseReasoningPanelsCommand,
 *      maybeHandleCloseReasoningPanelShortcut
 *                                         command parser + router; out
 *                                         of scope for Stage 8 (will
 *                                         likely move with the routing
 *                                         module in a later stage).
 *    Reasoning streaming, lane busy, watchdog, queue, attachments,
 *      routing, LLM stage 1/2 helpers      out of scope for Stage 8.
 * ========================================================================= */

/* =========================
   LABEL HELPERS
========================= */

function getWorkModeReasoningLaneLabel(idx) {
  const i = Number(idx);
  const panel = document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${i}"]`
  );
  const fromDom = String(panel?.dataset?.laneLabel || "").trim();
  if (fromDom) return fromDom;
  const preset = ["Panel 1", "Panel 2", "Panel 3"];
  if (Number.isFinite(i) && i >= 0 && i < preset.length) return preset[i];
  return `Panel ${i + 1}`;
}

function getWorkModeReasoningLaneId(idx) {
  return ensureStableLaneIdForPanelIndex(Number(idx));
}

/* =========================
   PANEL DOM BUILDER
========================= */

function createReasoningLanePanel(idx, html = "", isActive = false, tabMeta = {}) {
  const stableLaneId =
    String(tabMeta.laneId || "").trim() || ensureStableLaneIdForPanelIndex(idx);
  const panel = document.createElement("div");
  panel.className = "vera-reasoning-tab-panel";
  if (isActive) panel.classList.add("is-active");
  panel.dataset.tabIndex = String(idx);
  panel.dataset.laneId = stableLaneId;
  panel.dataset.tabTopic = String(tabMeta.topic || REASONING_UNTITLED_TAB_NAME);
  panel.dataset.tabTopicSet = String(tabMeta.topicSet != null ? tabMeta.topicSet : "0");
  panel.dataset.laneLabel = String(tabMeta.laneLabel || `Panel ${Number(idx) + 1}`);
  panel.id = `vera-reasoning-tab-panel-${idx}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-label", `Panel ${idx + 1}`);
  const scroll = document.createElement("div");
  scroll.className = "vera-reasoning-scroll vera-reasoning-md-panel";
  if (idx === 0) scroll.id = "vera-reasoning-md";
  scroll.setAttribute("aria-live", "polite");
  scroll.innerHTML = String(html || "");
  panel.appendChild(scroll);
  return panel;
}

function getReasoningScrollElByLane(index) {
  const panel = document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${Number(index)}"]`
  );
  return panel?.querySelector(".vera-reasoning-md-panel") || null;
}

/* =========================
   TAB TITLE PREDICATES + LABEL LOOKUP
========================= */

function isGenericAutoRenamableReasoningPanelTitle(s) {
  const t = String(s || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!t) return true;
  if (/^panel\s+\d+$/i.test(t)) return true;
  if (t.toLowerCase() === String(REASONING_UNTITLED_TAB_NAME).toLowerCase()) return true;
  if (/^new\s+panel$/i.test(t)) return true;
  return false;
}

function getReasoningTabTopicLabel(panel) {
  const laneLabel = String(panel?.dataset?.laneLabel || "").trim();
  const topic = String(panel?.dataset?.tabTopic || "").trim();
  const laneOk = laneLabel && !isGenericAutoRenamableReasoningPanelTitle(laneLabel);
  const topicOk = topic && !isGenericAutoRenamableReasoningPanelTitle(topic);
  if (laneOk) return laneLabel;
  if (topicOk) return topic;
  if (laneLabel) return laneLabel;
  return topic || REASONING_UNTITLED_TAB_NAME;
}

function isDefaultWorkModeReasoningPanelLaneLabel(label) {
  return isGenericAutoRenamableReasoningPanelTitle(label);
}

/* =========================
   TAB STRIP RENDER + ACTIVATE/ADD
========================= */

function renderReasoningTabStrip() {
  const tabsEl = document.getElementById("vera-reasoning-tabs");
  const addBtn = document.getElementById("vera-reasoning-tab-add");
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!tabsEl || !panelsRoot) return;
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  tabsEl.replaceChildren();
  panels.forEach((panel, i) => {
    const idx = Number(panel.dataset.tabIndex);
    const slot = document.createElement("div");
    slot.className =
      "vera-reasoning-tab-slot" + (panel.classList.contains("is-active") ? " is-active" : "");
    const tabBtn = document.createElement("button");
    tabBtn.type = "button";
    tabBtn.className = "vera-reasoning-tab";
    tabBtn.setAttribute("role", "tab");
    tabBtn.setAttribute("aria-selected", panel.classList.contains("is-active") ? "true" : "false");
    tabBtn.dataset.tabIndex = String(idx);
    const tabLabel = getReasoningTabTopicLabel(panel);
    tabBtn.title = tabLabel;
    const label = document.createElement("span");
    label.className = "vera-reasoning-tab-label";
    label.textContent = tabLabel;
    tabBtn.appendChild(label);
    slot.appendChild(tabBtn);
    /* Always render the close X — even when only the default 3 panels are
       visible. Auto-refill keeps the workspace at MIN_REASONING_PANELS, so
       the user can close any panel and we replace it with a fresh blank one.
       The previous gate ("only render X if more than 3 panels") meant the
       X disappeared exactly when the user wanted to close one of the
       defaults, which forced them to use voice every time. */
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "vera-reasoning-tab-close";
    closeBtn.dataset.tabIndex = String(idx);
    closeBtn.dataset.laneId = String(panel.dataset.laneId || "");
    closeBtn.dataset.panelDomId = String(panel.id || "");
    closeBtn.setAttribute("aria-label", `Close ${tabLabel}`);
    closeBtn.title = "Close this reasoning space";
    closeBtn.textContent = "×";
    slot.appendChild(closeBtn);
    tabsEl.appendChild(slot);
  });
  if (addBtn) {
    const atMax = panels.length >= REASONING_TABS_MAX;
    addBtn.hidden = atMax;
    addBtn.setAttribute(
      "aria-label",
      atMax ? "Maximum reasoning spaces (8)" : `Add reasoning space (${panels.length} of ${REASONING_TABS_MAX})`
    );
    addBtn.title = atMax ? "Maximum 8 spaces" : `Add space (up to ${REASONING_TABS_MAX})`;
  }
  /* PART 4: toggle the empty-state copy. The active panel gets the
     "No reasoning in this panel yet." line when it's blank AND not
     currently generating; the dedicated "Fresh workspace ready." line
     shows only when EVERY visible panel is empty-and-idle. The actual
     visibility computation lives in ``recomputeReasoningPanelEmptyHints``
     so the same rules are applied from cheap chokepoints like
     ``syncWorkModeReasoningCancelButton`` without re-rendering the
     whole strip. */
  recomputeReasoningPanelEmptyHints();
}

function logReasoningPanelSelectDebug(payload) {
  try {
    console.info("[reasoning_panel_select_debug] " + JSON.stringify({
      tag: "reasoning_panel_select_debug",
      ...payload,
    }));
  } catch (_) {}
}

function activateReasoningTab(index, opts = {}) {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const idx = Number(index);
  const beforeOrder = getReasoningPanelOrder();
  const beforePanel = beforeOrder.find((p) => p.tabIndex === idx) || null;
  const selectedTitleBefore = beforePanel?.label || "";
  panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").forEach((p) => {
    p.classList.toggle("is-active", Number(p.dataset.tabIndex) === idx);
  });
  setFocusedWorkModeLaneFromIndex(idx);
  renderReasoningTabStrip();
  syncWorkModeReasoningCancelButton();
  const afterOrder = getReasoningPanelOrder();
  const afterPanel = afterOrder.find((p) => p.tabIndex === idx) || null;
  const selectedTitleAfter = afterPanel?.label || "";
  const requestedIndex =
    Number.isFinite(Number(opts.requestedIndex))
      ? Number(opts.requestedIndex)
      : (afterPanel?.visualIndex ?? beforePanel?.visualIndex ?? null);
  logReasoningPanelSelectDebug({
    commandText: String(
      opts.commandText ||
        (typeof window !== "undefined" ? window.__veraLastInferUserTextForLaneGuard || "" : "")
    ).slice(0, 200),
    requestedIndex,
    selectedPanelId: afterPanel?.laneId || beforePanel?.laneId || null,
    selectedTitleBefore,
    selectedTitleAfter,
    visibleTitles: afterOrder.map((p) => p.label),
    resolvedFrom: opts.resolvedFrom || "visible_order",
    staleTitleRestored:
      _isGenericBlankReasoningPanelLabel(selectedTitleBefore) &&
      !_isGenericBlankReasoningPanelLabel(selectedTitleAfter),
  });
}

/* =====================================================================
   PART 1+3+5+6 (2026-05-28): "recently opened reasoning panel" tracking.
   --------------------------------------------------------------------
   The previous addReasoningTab() set `.is-active` on the new panel but
   did NOT update `focusedWorkModeLaneId` (in app.js). Because
   getActiveDomReasoningLaneId() prefers `focusedWorkModeLaneId` over the
   DOM `.is-active` panel, the next reasoning request resolved to the
   STALE focused lane (the panel the user was on BEFORE clicking +). So
   "open a new panel" appeared to work visually but the next reasoning
   request streamed into the previous panel — exactly the bug the user
   reported.

   The fix is two layers:
   1. addReasoningTab() now also calls setFocusedWorkModeLaneFromIndex()
      so the frozen turn-lane context (createWorkModeFrozenTurnContext →
      getActiveDomReasoningLaneId) picks up the new panel by default.
   2. We track `recentlyOpenedReasoningPanel` so even non-frozen code
      paths (auto-route, lane-bucket reuse, composer-only stream) can
      bias the next reasoning request to the freshly opened panel.

   The flag is one-shot: it's consumed by the first reasoning submission
   into the workspace, and cleared by manual tab clicks, explicit panel
   references in the user text, or the TTL (3 min middle of the spec's
   2-5 min window).
   ===================================================================== */
const RECENTLY_OPENED_REASONING_PANEL_TTL_MS = 3 * 60 * 1000;
let recentlyOpenedReasoningPanel = null;
/* Shape: { laneId, tabIndex, openedAt, source, requestId, consumed: false } */

function setRecentlyOpenedReasoningPanel(laneId, tabIndex, source, requestId = "") {
  const lid = String(laneId || "").trim();
  const idx = Number(tabIndex);
  if (!lid || !Number.isFinite(idx)) return;
  recentlyOpenedReasoningPanel = {
    laneId: lid,
    tabIndex: idx,
    openedAt: Date.now(),
    source: String(source || "unknown"),
    requestId: String(requestId || "").trim(),
    consumed: false,
  };
}

function getValidRecentlyOpenedReasoningPanel() {
  const r = recentlyOpenedReasoningPanel;
  if (!r) return null;
  if (r.consumed) return null;
  if (Date.now() - r.openedAt > RECENTLY_OPENED_REASONING_PANEL_TTL_MS) return null;
  /* Panel must still exist in the DOM (could have been closed). */
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return null;
  const stillExists = panelsRoot.querySelector(
    `.vera-reasoning-tab-panel[data-tab-index="${r.tabIndex}"]`
  );
  if (!stillExists) return null;
  /* Lane id must still resolve to the same panel. */
  const sameLane = String(stillExists.dataset.laneId || "").trim() === r.laneId;
  if (!sameLane) return null;
  return {
    laneId: r.laneId,
    tabIndex: r.tabIndex,
    source: r.source,
    requestId: r.requestId || "",
    openedAt: r.openedAt,
  };
}

function consumeRecentlyOpenedReasoningPanel(reason = "consumed") {
  const snap = getValidRecentlyOpenedReasoningPanel();
  if (snap && recentlyOpenedReasoningPanel) {
    recentlyOpenedReasoningPanel.consumed = true;
    try {
      console.info("[recently_opened_reasoning_panel_consumed] " + JSON.stringify({
        lane_id: snap.laneId,
        tab_index: snap.tabIndex,
        source: snap.source,
        request_id: snap.requestId || null,
        reason,
        age_ms: Date.now() - snap.openedAt,
      }));
    } catch (_) {}
  }
  return snap;
}

function clearRecentlyOpenedReasoningPanel(reason = "cleared") {
  if (recentlyOpenedReasoningPanel) {
    try {
      console.info("[recently_opened_reasoning_panel_cleared] " + JSON.stringify({
        lane_id: recentlyOpenedReasoningPanel.laneId,
        tab_index: recentlyOpenedReasoningPanel.tabIndex,
        source: recentlyOpenedReasoningPanel.source,
        request_id: recentlyOpenedReasoningPanel.requestId || null,
        reason,
        age_ms: Date.now() - recentlyOpenedReasoningPanel.openedAt,
      }));
    } catch (_) {}
  }
  recentlyOpenedReasoningPanel = null;
}

try {
  window.getValidRecentlyOpenedReasoningPanel = getValidRecentlyOpenedReasoningPanel;
  window.consumeRecentlyOpenedReasoningPanel = consumeRecentlyOpenedReasoningPanel;
  window.clearRecentlyOpenedReasoningPanel = clearRecentlyOpenedReasoningPanel;
  window.setRecentlyOpenedReasoningPanel = setRecentlyOpenedReasoningPanel;
} catch (_) {}

function addReasoningTab(opts) {
  const opts_ = opts && typeof opts === "object" ? opts : {};
  const source = String(opts_.source || "ui_plus_button");
  const requestId = String(opts_.requestId || opts_.panelOpenRequestId || "").trim();
  try {
    console.info("[open_panel_route_called] " + JSON.stringify({
      source,
    }));
  } catch (_) {}
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return null;
  const panelsBefore = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  if (panelsBefore.length >= REASONING_TABS_MAX) return null;
  const activeBeforeEl = panelsBefore.find((p) => p.classList.contains("is-active")) || null;
  const activeBeforeLaneId = activeBeforeEl
    ? String(activeBeforeEl.dataset.laneId || "")
    : "";
  const maxIdx = panelsBefore.reduce(
    (m, p) => Math.max(m, Number(p.dataset.tabIndex) || 0),
    -1
  );
  const idx = maxIdx + 1;
  panelsBefore.forEach((p) => p.classList.remove("is-active"));
  const panel = createReasoningLanePanel(idx, "", true, {
    laneLabel: `Panel ${idx + 1}`
  });
  panelsRoot.appendChild(panel);
  syncReasoningLaneBusySlotsAfterDomChange();
  renderReasoningTabStrip();

  /* PART 1+5+6 fix — update destination state so the NEW panel becomes
     the actual routing target, not just the visually selected tab.
     setFocusedWorkModeLaneFromIndex lives in app.js; it's looked up at
     call time so the cross-module reference is safe even though
     workmode/panels.js loads before app.js. */
  const newLaneId = String(panel.dataset.laneId || "").trim();
  try {
    if (typeof setFocusedWorkModeLaneFromIndex === "function") {
      setFocusedWorkModeLaneFromIndex(idx);
    }
  } catch (_) {}

  setRecentlyOpenedReasoningPanel(newLaneId, idx, source, requestId);

  /* PART 7: structured open-panel log with before/after state so the
     console can audit which tab was active before the open and confirm
     the destination state updated for the new panel. */
  try {
    console.info("[panel_open_requested] " + JSON.stringify({
      source,
      new_panel_id: newLaneId,
      new_tab_index: idx,
      new_panel_title: String(panel.dataset.laneLabel || `Panel ${idx + 1}`),
      active_panel_before: activeBeforeLaneId,
      active_panel_after: newLaneId,
      selected_panel_after: newLaneId,
      current_reasoning_target_after: newLaneId,
      recently_opened_panel_flag_set: true,
      panel_open_request_id: requestId || null,
      panel_count_after: panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length,
    }));
  } catch (_) {}

  return { laneId: newLaneId, tabIndex: idx };
}

/* =========================================================================
   REASONING PANEL CLOSE/REFILL/UNDO
   --------------------------------------------------------------------------
   The workspace contract is: keep MIN_REASONING_PANELS visible at all times.
   When the user closes panel(s) — via UI X button OR voice/text command —
   we:
     1. RESOLVE ALL TARGETS FROM THE ORIGINAL VISUAL ORDER before touching
        the DOM. Indices must not shift mid-close.
     2. Cancel each closed panel's in-flight reasoning stream and emit a
        `[reasoning_stream_cancelled_due_to_panel_close]` log so orphan
        chunks never write into a closed (or replacement) panel.
     3. Snapshot the closed panel(s) to a recently-closed stack so the user
        can "undo close" / "reopen last panel".
     4. Pick the correct surviving active panel (prefer right-neighbor of
        the closed active, then left, then the first new blank).
     5. Auto-refill with blank panels until we're back to MIN_REASONING_PANELS.
     6. Emit a single structured `[reasoning_close_debug]` log with all the
        fields PART 16 of the spec asks for.
   ========================================================================= */

/* Inlined literal (mirrors REASONING_TABS_DEFAULT in app.js). Do NOT
   reference REASONING_TABS_DEFAULT directly here: this script loads
   BEFORE app.js, so a top-level `const X = REASONING_TABS_DEFAULT;`
   throws a ReferenceError during panels.js load. That throw aborts
   the rest of the top-level body, which silently leaves every
   subsequent let/const (including recentlyClosedReasoningPanels just
   below) permanently in TDZ — function declarations are still hoisted
   and callable, so the UI looks fine until the first close/refill
   attempt blows up with "Cannot access 'recentlyClosedReasoningPanels'
   before initialization", which is what bug-reproducer screenshot for
   the seamless-close issue showed. Keep this in sync with
   REASONING_TABS_DEFAULT in app.js. */
const MIN_REASONING_PANELS = 3;
const REASONING_RECENTLY_CLOSED_STACK_MAX = 16;
const recentlyClosedReasoningPanels = [];

function logReasoningCloseDebug(payload) {
  try {
    console.warn(
      "[reasoning_close_debug] " + JSON.stringify(payload, null, 0)
    );
  } catch (_) {
    try {
      console.warn("[reasoning_close_debug] log_serialization_failed");
    } catch (_) {}
  }
}

/* PART 7: polish-layer log (separate channel so it's easy to grep without
   getting flooded by the lower-level mutation log). */
function logReasoningClosePolishDebug(payload) {
  try {
    console.info(
      "[reasoning_close_polish_debug] " + JSON.stringify(payload, null, 0)
    );
  } catch (_) {
    try {
      console.info("[reasoning_close_polish_debug] log_serialization_failed");
    } catch (_) {}
  }
}

/* PART 2: per-turn close-action lock. Multiple input pipelines (interrupt
   ASR, main browser ASR, /infer round-trip) can all try to handle the same
   close command from the same user utterance — they used to each fire a
   bubble + an execution. We now record a small fingerprint of the last
   close action and short-circuit duplicates within REASONING_CLOSE_TURN_LOCK_MS. */
const REASONING_CLOSE_TURN_LOCK_MS = 4000;
let _lastReasoningCloseLock = null; // {at, scope, indicesKey, confirmation, source}

function _reasoningCloseLockKey(scope, indices) {
  const idxKey = Array.isArray(indices) ? indices.join(",") : "";
  return `${scope || ""}|${idxKey}`;
}
function _hasActiveReasoningCloseLock() {
  if (!_lastReasoningCloseLock) return false;
  return (Date.now() - _lastReasoningCloseLock.at) <= REASONING_CLOSE_TURN_LOCK_MS;
}
function _setReasoningCloseLock(info) {
  _lastReasoningCloseLock = {
    at: Date.now(),
    scope: String(info?.scope || ""),
    indicesKey: _reasoningCloseLockKey(info?.scope, info?.indices),
    confirmation: String(info?.confirmation || ""),
    source: String(info?.source || ""),
  };
}
function _peekReasoningCloseLock() {
  return _lastReasoningCloseLock;
}

/* PART 3: detect generic, auto-renamable blank panel labels (mirrors the
   server-side rule). User-set titles like "English Essay Plan" are NOT
   renamed; "Panel 6" / "New Panel" / "Untitled" / empty are renamed in
   _normalizeBlankPanelNamesInOrder. */
function _isGenericBlankReasoningPanelLabel(label) {
  const t = String(label || "").trim();
  if (!t) return true;
  if (/^panel\s+\d+$/i.test(t)) return true;
  if (/^new\s+panel(\s+\d+)?$/i.test(t)) return true;
  if (/^fresh\s+panel(\s+\d+)?$/i.test(t)) return true;
  if (t.toLowerCase() === String(REASONING_UNTITLED_TAB_NAME || "untitled").toLowerCase()) return true;
  return false;
}

function _isBlankReasoningPanelElement(panelEl) {
  if (!(panelEl instanceof HTMLElement)) return false;
  const scroll =
    panelEl.querySelector(".vera-reasoning-md-panel") ||
    panelEl.querySelector(".vera-reasoning-scroll");
  const html = String(scroll?.innerHTML || "").trim();
  return !html;
}

/* 2026-06-01 — empty-placeholder visibility fix.
   A reasoning panel may have ZERO innerHTML and yet be "active" because
   we just kicked off a reasoning stream for it. In that window the
   first chunk hasn't landed yet, but the user has already requested
   work — showing "No reasoning in this panel yet. Ask VERA to work
   through something, or type below." over a generating panel looks
   broken and overlaps with content the moment it arrives.

   We treat a panel as generating whenever its tab index is marked
   busy in the global ``workModeReasoningLaneBusy`` map (declared in
   app.js, populated by the lane acquire/release helpers, and toggled
   by the stream lifecycle). Both files share the classic-script
   global scope. */
function _panelIsCurrentlyGenerating(panelEl) {
  if (!(panelEl instanceof HTMLElement)) return false;
  try {
    if (typeof workModeReasoningLaneBusy === "undefined" || !workModeReasoningLaneBusy) {
      return false;
    }
    const idx = Number(panelEl.dataset?.tabIndex);
    if (!Number.isFinite(idx)) return false;
    return workModeReasoningLaneBusy.get(idx) === true;
  } catch (_) {
    return false;
  }
}

/* The empty-placeholder must hide whenever the panel is generating OR
   has any reasoning content. Spec rule:
       placeholderVisible = !panel.isGenerating && !panel.hasReasoningContent
   Implemented as: blank-by-content AND not-currently-generating. */
function _panelShouldShowEmptyHint(panelEl) {
  if (!(panelEl instanceof HTMLElement)) return false;
  if (_panelIsCurrentlyGenerating(panelEl)) return false;
  return _isBlankReasoningPanelElement(panelEl);
}

/* Recompute the two empty-state hints ("No reasoning in this panel
   yet." per-panel and "Fresh workspace ready." workspace-wide).
   Exposed as its own helper so app.js can call it on the cheap
   chokepoints — busy-state toggles, stream start, stream end — without
   re-rendering the entire tab strip. ``renderReasoningTabStrip``
   below also calls into this so the strip path stays correct. */
function recomputeReasoningPanelEmptyHints() {
  try {
    const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
    if (!panelsRoot) return;
    const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
    const root = document.getElementById("vera-reasoning-pane") || document;
    const hintPerPanel = root.querySelector(".vera-wm-empty-hint--reasoning");
    const hintFresh = root.querySelector(".vera-wm-empty-hint--fresh");
    /* "All blank" is computed using the same hint-visibility rule so
       that a single generating panel keeps the workspace-fresh hint
       hidden too — the workspace isn't fresh, it's actively working. */
    const allBlank =
      panels.length > 0 && panels.every((p) => _panelShouldShowEmptyHint(p));
    const activePanel =
      panels.find((p) => p.classList.contains("is-active")) || panels[0];
    const activeBlank = activePanel ? _panelShouldShowEmptyHint(activePanel) : true;
    if (hintFresh) {
      hintFresh.hidden = !allBlank;
    }
    if (hintPerPanel) {
      hintPerPanel.hidden = !(!allBlank && activeBlank);
    }
  } catch (_) {}
}

function snapshotReasoningLaneRegistryForDebug(laneIds = []) {
  const ids = Array.isArray(laneIds)
    ? laneIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const out = {};
  for (const id of ids) {
    const row = workModeCompletedReasoningByLaneId[id];
    out[id] = row
      ? {
          title: String(row.title || row.lane_title || "").trim(),
          lane_title: String(row.lane_title || "").trim(),
          main_context_type: String(row.main_context_type || "").trim(),
          latest_turn_type: String(row.latest_turn_type || "").trim(),
          updated_at: Number(row.updated_at) || null,
        }
      : null;
  }
  return out;
}

function invalidateClosedReasoningLaneIdentity(panelInfo) {
  const laneId = String(panelInfo?.laneId || "").trim();
  const tabIndex = Number(panelInfo?.tabIndex);
  if (laneId) {
    try { delete workModeCompletedReasoningByLaneId[laneId]; } catch (_) {}
    try { workModeReasoningFinalStatusByLaneId.delete(laneId); } catch (_) {}
    try {
      if (
        activeWorkModeReasoningContext &&
        String(activeWorkModeReasoningContext.lane_id || activeWorkModeReasoningContext.active_lane_id || "").trim() === laneId
      ) {
        activeWorkModeReasoningContext = null;
      }
    } catch (_) {}
    try {
      if (String(focusedWorkModeLaneId || "").trim() === laneId) {
        focusedWorkModeLaneId = "";
        focusedWorkModeLaneAt = 0;
      }
    } catch (_) {}
  }
  if (Number.isFinite(tabIndex)) {
    try { workModeReasoningAbortControllers.delete(tabIndex); } catch (_) {}
    try { workModeReasoningLaneBusy.delete(tabIndex); } catch (_) {}
    try { laneReasoningChainTail.delete(tabIndex); } catch (_) {}
    try { workModeReasoningPanelFollowUpQueue.delete(tabIndex); } catch (_) {}
    try {
      if (workModeLastSubstantiveLaneIdx === tabIndex) {
        workModeLastSubstantiveLaneIdx = null;
        workModeLastSubstantiveUserText = "";
      }
    } catch (_) {}
    return replaceStableLaneIdForPanelIndex(tabIndex);
  }
  return allocateWorkModeStableLaneId();
}

function readPersistedReasoningPanelTitlesForDebug() {
  try {
    const raw = localStorage.getItem(getReasoningTabsStateStorageKey()) || "";
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    return tabs.map((t) => ({
      idx: Number(t?.idx),
      laneId: String(t?.laneId || "").trim(),
      topic: String(t?.topic || "").trim(),
      laneLabel: String(t?.laneLabel || "").trim(),
    }));
  } catch (_) {
    return [];
  }
}

/* Walk panels in visual order; for every panel that is BOTH blank in
   content AND has a generic auto-renamable title, rewrite its title to
   "Panel <visual+1>". Meaningful titles (English Essay Plan, etc.) are
   preserved. Returns {before, after, renamedCount}. */
function _normalizeBlankPanelNamesInOrder() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return { before: [], after: [], renamedCount: 0 };
  const els = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  const before = els.map((p, i) => String(p.dataset.laneLabel || `Panel ${i + 1}`).trim());
  let renamed = 0;
  els.forEach((panel, visualIdx) => {
    const current = String(panel.dataset.laneLabel || "").trim();
    const targetLabel = `Panel ${visualIdx + 1}`;
    const blankContent = _isBlankReasoningPanelElement(panel);
    const genericLabel = _isGenericBlankReasoningPanelLabel(current);
    /* Rule (PART 3):
        - Only rename when the label is generic AND (the panel is blank
          OR the existing label is just a misleading-numbered "Panel N"
          carried over from before the close).
        - Never rename a user/LLM-set meaningful title. */
    if (!genericLabel) return;
    if (!blankContent && /^panel\s+\d+$/i.test(current) === false) return;
    if (current === targetLabel) return;
    panel.dataset.laneLabel = targetLabel;
    panel.dataset.tabTopic = panel.dataset.tabTopic && !_isGenericBlankReasoningPanelLabel(panel.dataset.tabTopic)
      ? panel.dataset.tabTopic
      : REASONING_UNTITLED_TAB_NAME;
    renamed += 1;
  });
  const after = els.map((p, i) => String(p.dataset.laneLabel || `Panel ${i + 1}`).trim());
  return { before, after, renamedCount: renamed };
}

/* PART 5: pick the active panel AFTER refill + rename. Preference:
     1. previous active if it survived close
     2. nearest right neighbor of closed active that survived
     3. nearest left neighbor of closed active that survived
     4. any surviving "meaningful" original (non-generic label, non-empty)
     5. the first blank refill panel
   This avoids leaving the user on a random "Panel 8" blank when a
   meaningful "English Essay Plan" panel still exists. */
function _pickActivePanelInfoAfterRefill(prevOrder, closedTabIndexSet, currentOrder) {
  if (!Array.isArray(currentOrder) || !currentOrder.length) return null;
  const activeBefore = prevOrder.find((p) => p.isActive);
  if (activeBefore && !closedTabIndexSet.has(activeBefore.tabIndex)) {
    const stillThere = currentOrder.find((p) => p.tabIndex === activeBefore.tabIndex);
    if (stillThere) return stillThere;
  }
  if (activeBefore) {
    const activeVisualIdx = activeBefore.visualIndex; // 1-based
    for (let v = activeVisualIdx + 1; v <= prevOrder.length; v += 1) {
      const cand = prevOrder[v - 1];
      if (!cand || closedTabIndexSet.has(cand.tabIndex)) continue;
      const stillThere = currentOrder.find((p) => p.tabIndex === cand.tabIndex);
      if (stillThere) return stillThere;
    }
    for (let v = activeVisualIdx - 1; v >= 1; v -= 1) {
      const cand = prevOrder[v - 1];
      if (!cand || closedTabIndexSet.has(cand.tabIndex)) continue;
      const stillThere = currentOrder.find((p) => p.tabIndex === cand.tabIndex);
      if (stillThere) return stillThere;
    }
  }
  /* Prefer any surviving "meaningful" original. */
  const meaningfulOriginal = currentOrder.find((p) => {
    const survivedTabIdx = prevOrder.some((pp) => pp.tabIndex === p.tabIndex && !closedTabIndexSet.has(pp.tabIndex));
    if (!survivedTabIdx) return false;
    const genericLabel = _isGenericBlankReasoningPanelLabel(p.label);
    return !genericLabel;
  });
  if (meaningfulOriginal) return meaningfulOriginal;
  /* Otherwise: first blank panel (which after _normalizeBlankPanelNamesInOrder
     is "Panel 1"). */
  return currentOrder[0] || null;
}

function getReasoningPanelOrder() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return [];
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  return panels.map((p, visualIdx) => {
    const tabIdx = Number(p.dataset.tabIndex);
    return {
      visualIndex: visualIdx + 1, // 1-based
      tabIndex: Number.isFinite(tabIdx) ? tabIdx : visualIdx,
      laneId: String(p.dataset.laneId || "") || `lane_${tabIdx}`,
      label: getReasoningTabTopicLabel(p) || `Panel ${visualIdx + 1}`,
      topic: String(p.dataset.tabTopic || ""),
      topicSet: String(p.dataset.tabTopicSet || "0"),
      laneLabel: String(p.dataset.laneLabel || ""),
      isActive: p.classList.contains("is-active"),
      element: p,
    };
  });
}

function getReasoningTabTopicLabelSafe(panel) {
  try {
    return getReasoningTabTopicLabel(panel) || "";
  } catch (_) {
    return "";
  }
}

function snapshotReasoningPanelForUndo(panelInfo) {
  const el = panelInfo?.element;
  if (!el) return null;
  const scrollEl =
    el.querySelector(".vera-reasoning-md-panel") ||
    el.querySelector(".vera-reasoning-scroll");
  return {
    closedAt: Date.now(),
    tabIndex: panelInfo.tabIndex,
    laneId: panelInfo.laneId,
    label: panelInfo.label,
    topic: panelInfo.topic,
    topicSet: panelInfo.topicSet,
    laneLabel: panelInfo.laneLabel,
    html: String(scrollEl?.innerHTML || ""),
  };
}

function pickReplacementActivePanelInfo(prevOrder, closedTabIndexSet) {
  /* prevOrder is the BEFORE-close visual order. The active panel may or
     may not be in closedTabIndexSet. We always want a surviving panel to
     be active after the close. Preference order per spec PART 1+9:
        1. previous active if it survived
        2. nearest right neighbor of the closed active that survived
        3. nearest left neighbor of the closed active that survived
        4. first surviving original
        5. caller will fall back to "first blank" after refill */
  const survivors = prevOrder.filter((p) => !closedTabIndexSet.has(p.tabIndex));
  if (!survivors.length) return null;
  const activeBefore = prevOrder.find((p) => p.isActive);
  if (activeBefore && !closedTabIndexSet.has(activeBefore.tabIndex)) {
    return activeBefore;
  }
  if (activeBefore) {
    const activeVisualIdx = activeBefore.visualIndex; // 1-based
    for (let v = activeVisualIdx + 1; v <= prevOrder.length; v += 1) {
      const cand = prevOrder[v - 1];
      if (cand && !closedTabIndexSet.has(cand.tabIndex)) return cand;
    }
    for (let v = activeVisualIdx - 1; v >= 1; v -= 1) {
      const cand = prevOrder[v - 1];
      if (cand && !closedTabIndexSet.has(cand.tabIndex)) return cand;
    }
  }
  return survivors[0];
}

function refillReasoningPanelsToMinimum() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return 0;
  let created = 0;
  while (true) {
    const cur = panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length;
    if (cur >= MIN_REASONING_PANELS) break;
    if (cur >= REASONING_TABS_MAX) break;
    addReasoningTab();
    created += 1;
    /* Safety: addReasoningTab is a no-op once we hit REASONING_TABS_MAX, so
       this loop is bounded — but belt-and-suspenders against future edits. */
    if (created > REASONING_TABS_MAX + 1) break;
  }
  return created;
}

function closeReasoningPanelsByVisualIndices(visualIndices1Based, opts = {}) {
  /* The single source of truth for closing 1..N reasoning panels.
     `visualIndices1Based` is an array of 1-based positions in the CURRENT
     visual tab order. We resolve those to stable tabIndex/laneId BEFORE
     mutating anything so closing panels 1+3 of [A,B,C,D] always means
     closing A and C — never "close 1, then close 3 of [B,C,D] which is D". */
  const opts_ = opts && typeof opts === "object" ? opts : {};
  const reason = String(opts_.reason || "unspecified");
  const refillToMinimum = opts_.refillToMinimum !== false;
  const closeScope = String(opts_.closeScope || "specific_indices");
  const userText = String(opts_.userText || "");

  /* [close_core_called] PART 9: single instrumentation point for every close,
     regardless of entry point (UI X / typed / voice / programmatic). Lets
     us prove the core actually ran and see panel counts before vs after. */
  const _orderAtEntry = (() => { try { return getReasoningPanelOrder(); } catch (_) { return []; } })();
  try {
    console.info("[close_core_called] " + JSON.stringify({
      source: reason,
      close_scope: closeScope,
      requested_visual_indices: Array.isArray(visualIndices1Based) ? visualIndices1Based.slice() : [],
      refill_to_minimum: refillToMinimum,
      panel_count_before: _orderAtEntry.length,
      active_panel_id_before: _orderAtEntry.find((p) => p.isActive)?.laneId || null,
      user_text_preview: userText.slice(0, 80),
    }));
  } catch (_) {}

  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) {
    logReasoningCloseDebug({
      latest_user_text: userText.slice(0, 200),
      close_reasoning_panel_intent_detected: true,
      close_scope: closeScope,
      parsed_range_type: closeScope,
      parsed_indices: Array.isArray(visualIndices1Based) ? visualIndices1Based.slice() : [],
      close_completed: false,
      failure_reason: "no_panels_root",
    });
    return { ok: false, failureReason: "no_panels_root", closedTitles: [], closedCount: 0, createdBlankCount: 0 };
  }

  const prevOrder = getReasoningPanelOrder();
  const totalBefore = prevOrder.length;
  const requested = Array.isArray(visualIndices1Based)
    ? [...new Set(visualIndices1Based.map((n) => Number(n)).filter(Number.isFinite))]
    : [];
  /* PART 10: if user asks for indices beyond what exists, just close what's
     available. Caller (parser) decides "ask vs close-best-effort" semantics
     via opts.invalidPolicy. */
  const validIdx = requested.filter((n) => n >= 1 && n <= totalBefore);
  const invalidIdx = requested.filter((n) => n < 1 || n > totalBefore);

  if (!validIdx.length) {
    logReasoningCloseDebug({
      latest_user_text: userText.slice(0, 200),
      close_reasoning_panel_intent_detected: true,
      close_scope: closeScope,
      parsed_range_type: closeScope,
      parsed_indices: requested,
      panel_count_before: totalBefore,
      panel_order_before: prevOrder.map((p) => ({ tabIndex: p.tabIndex, label: p.label, visualIndex: p.visualIndex })),
      target_panel_ids_resolved_before_mutation: [],
      target_panel_titles_resolved_before_mutation: [],
      active_panel_id_before: prevOrder.find((p) => p.isActive)?.laneId || null,
      close_completed: false,
      failure_reason: invalidIdx.length ? "all_requested_indices_out_of_range" : "no_indices",
      invalid_indices: invalidIdx,
    });
    return {
      ok: false,
      failureReason: invalidIdx.length ? "all_requested_indices_out_of_range" : "no_indices",
      closedTitles: [],
      closedCount: 0,
      createdBlankCount: 0,
      totalBefore,
      invalidIndices: invalidIdx,
    };
  }

  /* RESOLVE TARGETS BEFORE MUTATING. */
  const targets = validIdx
    .sort((a, b) => a - b)
    .map((vi) => prevOrder[vi - 1])
    .filter(Boolean);
  const closedTabIndexSet = new Set(targets.map((t) => t.tabIndex));
  const activeBefore = prevOrder.find((p) => p.isActive) || null;
  const activeWasClosed = activeBefore ? closedTabIndexSet.has(activeBefore.tabIndex) : false;
  const registryBeforeClose = snapshotReasoningLaneRegistryForDebug(targets.map((t) => t.laneId));

  const closedTitles = [];
  const closedLaneIds = [];
  const closedSnapshots = [];
  const replacementLaneIdByTabIndex = new Map();
  let streamsCancelled = 0;
  let anyStreamCancelled = false;

  for (const t of targets) {
    closedTitles.push(t.label);
    closedLaneIds.push(t.laneId);

    /* PART 2: cancel in-flight reasoning stream BEFORE we drop the DOM node
       so the streaming code's next chunk write can't find a stale element
       and crash, and so orphan chunks don't accidentally land in a
       replacement panel that happens to take this lane index later. */
    const laneIdx = t.tabIndex;
    const ctl = workModeReasoningAbortControllers.get(laneIdx);
    if (ctl) {
      anyStreamCancelled = true;
      streamsCancelled += 1;
      try { ctl.abort(); } catch (_) {}
      workModeReasoningAbortControllers.delete(laneIdx);
      try {
        console.info("[reasoning_stream_cancelled_due_to_panel_close]", {
          lane_idx: laneIdx,
          lane_id: t.laneId,
          label: t.label,
          reason,
        });
      } catch (_) {}
    }
    workModeReasoningLaneBusy.delete(laneIdx);
    laneReasoningChainTail.delete(laneIdx);
    workModeReasoningPanelFollowUpQueue.delete(laneIdx);

    const snap = snapshotReasoningPanelForUndo(t);
    if (snap) {
      closedSnapshots.push(snap);
    }

    /* PART 2: closing a panel invalidates its old identity. Replacements
       reuse the visible slot/tabIndex for UI continuity, but they get a NEW
       stable lane id and all old lane registry/context/title metadata is
       deleted before a fresh blank panel can be created. */
    const replacementLaneId = invalidateClosedReasoningLaneIdentity(t);
    replacementLaneIdByTabIndex.set(t.tabIndex, replacementLaneId);

    /* DOM removal. */
    try { t.element.remove(); } catch (_) {}
  }

  if (closedSnapshots.length) {
    recentlyClosedReasoningPanels.push({
      closedAt: Date.now(),
      reason,
      userText: userText.slice(0, 200),
      activeWasClosed,
      panels: closedSnapshots,
    });
    while (recentlyClosedReasoningPanels.length > REASONING_RECENTLY_CLOSED_STACK_MAX) {
      recentlyClosedReasoningPanels.shift();
    }
  }

  /* PART 1+9: pick the surviving active panel BEFORE refilling so the new
     active is one of the originals (if any). */
  const replacementActive = pickReplacementActivePanelInfo(prevOrder, closedTabIndexSet);
  if (replacementActive) {
    const stillThere = panelsRoot.querySelector(
      `.vera-reasoning-tab-panel[data-tab-index="${replacementActive.tabIndex}"]`
    );
    if (stillThere) {
      panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").forEach((p) => p.classList.remove("is-active"));
      stillThere.classList.add("is-active");
    }
  }

  const panelCountAfterCloseBeforeRefill = panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length;

  let createdBlankCount = 0;
  const createdPanelIds = [];
  const createdPanelTitles = [];
  if (refillToMinimum) {
    const remainingCount = panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length;
    const blankNeeded = Math.max(0, Math.min(REASONING_TABS_MAX, MIN_REASONING_PANELS) - remainingCount);
    const prevVisualByTabIndex = new Map(prevOrder.map((p) => [p.tabIndex, p.visualIndex]));
    const replacementTargets = targets
      .slice()
      .sort((a, b) => a.visualIndex - b.visualIndex)
      .slice(0, blankNeeded);
    for (const target of replacementTargets) {
      const label = `Panel ${target.visualIndex}`;
      const laneId = replacementLaneIdByTabIndex.get(target.tabIndex) || replaceStableLaneIdForPanelIndex(target.tabIndex);
      const freshPanel = createReasoningLanePanel(target.tabIndex, "", false, {
        laneId,
        laneLabel: label,
        topic: REASONING_UNTITLED_TAB_NAME,
        topicSet: "0",
      });
      freshPanel.dataset.reasoningFreshReplacement = "1";
      freshPanel.dataset.closedLaneId = String(target.laneId || "");
      const beforeEl = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")].find((p) => {
        const idx = Number(p.dataset.tabIndex);
        const prevVisual = prevVisualByTabIndex.get(idx);
        return Number.isFinite(prevVisual) && prevVisual > target.visualIndex;
      });
      panelsRoot.insertBefore(freshPanel, beforeEl || null);
      createdBlankCount += 1;
      createdPanelIds.push(laneId);
      createdPanelTitles.push(label);
    }
    if (panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length < MIN_REASONING_PANELS) {
      const beforeFallback = getReasoningPanelOrder().map((p) => p.laneId);
      createdBlankCount += refillReasoningPanelsToMinimum();
      const afterFallback = getReasoningPanelOrder();
      for (const p of afterFallback) {
        if (!beforeFallback.includes(p.laneId) && !createdPanelIds.includes(p.laneId)) {
          createdPanelIds.push(p.laneId);
          createdPanelTitles.push(p.label);
        }
      }
    }
  }

  /* PART 3: rename auto-refilled blank panels back to clean "Panel 1/2/3"
     names so the workspace looks reset, not "accumulating". Meaningful
     titled panels (English Essay Plan, Ticket Complaint Email, …) keep
     their titles. */
  const panelOrderAfterRefillBeforeRename = getReasoningPanelOrder().map((p) => ({
    tabIndex: p.tabIndex, laneId: p.laneId, label: p.label, visualIndex: p.visualIndex,
  }));
  const renameInfo = _normalizeBlankPanelNamesInOrder();

  /* PART 5: smarter active-tab pick AFTER refill+rename. Prefer a meaningful
     original survivor over a random blank refill panel. */
  syncReasoningLaneBusySlotsAfterDomChange();
  const afterOrderForActive = getReasoningPanelOrder();
  const chosenActive = _pickActivePanelInfoAfterRefill(prevOrder, closedTabIndexSet, afterOrderForActive);
  if (chosenActive) {
    afterOrderForActive.forEach((p) => p.element?.classList?.remove("is-active"));
    const el = afterOrderForActive.find((p) => p.tabIndex === chosenActive.tabIndex)?.element;
    if (el) el.classList.add("is-active");
  } else {
    /* Belt-and-suspenders fallback. */
    const first = panelsRoot.querySelector(".vera-reasoning-tab-panel");
    if (first) first.classList.add("is-active");
  }

  renderReasoningTabStrip();
  const renderTabsCalled = true;
  try {
    console.info("[render_tabs_called] " + JSON.stringify({
      source: reason,
      active_panel_before: activeBefore?.laneId || null,
      closed_panel_ids: closedLaneIds,
      panel_count_after_refill: panelsRoot.querySelectorAll(".vera-reasoning-tab-panel").length,
    }));
  } catch (_) {}
  try {
    persistReasoningTabsState();
  } catch (_) {}

  let afterOrder = getReasoningPanelOrder();
  let activeAfter = afterOrder.find((p) => p.isActive) || null;
  let renderActivePanelCalled = false;
  if (activeAfter && Number.isFinite(Number(activeAfter.tabIndex))) {
    try {
      setFocusedWorkModeLaneFromIndex(Number(activeAfter.tabIndex));
      /* Mirror the working open/switch lifecycle: `activateReasoningTab`
         is the central path that reconciles active DOM class, focused lane,
         tab strip render, cancel-button state, and select diagnostics. Close
         used to manually toggle/focus only, which could leave the visible tab
         strip stale until the next click in some browsers. */
      if (typeof activateReasoningTab === "function") {
        activateReasoningTab(Number(activeAfter.tabIndex), {
          resolvedFrom: "close_core_reconcile",
          requestedIndex: activeAfter.visualIndex,
          commandText: userText,
        });
        afterOrder = getReasoningPanelOrder();
        activeAfter = afterOrder.find((p) => p.isActive) || activeAfter;
      }
      renderActivePanelCalled = true;
    } catch (_) {}
  }
  try {
    console.info("[render_active_panel_called] " + JSON.stringify({
      source: reason,
      called: renderActivePanelCalled,
      active_panel_before: activeBefore?.laneId || null,
      active_panel_after: activeAfter?.laneId || null,
      active_tab_index_after: activeAfter?.tabIndex ?? null,
    }));
  } catch (_) {}
  const registryAfterClose = snapshotReasoningLaneRegistryForDebug([
    ...closedLaneIds,
    ...createdPanelIds,
  ]);
  const persistedTitlesAfter = readPersistedReasoningPanelTitlesForDebug();

  try {
    console.info("[reasoning_panel_close_debug] " + JSON.stringify({
      tag: "reasoning_panel_close_debug",
      action: "close_refill",
      closedPanelIds: closedLaneIds,
      closedPanelTitles: closedTitles,
      createdPanelIds,
      createdPanelTitles,
      panelTitlesBefore: prevOrder.map((p) => p.label),
      panelTitlesAfter: afterOrder.map((p) => p.label),
      laneRegistryBefore: registryBeforeClose,
      laneRegistryAfter: registryAfterClose,
      persistedTitlesAfter,
      activePanelAfter: activeAfter?.laneId || null,
    }));
  } catch (_) {}

  logReasoningCloseDebug({
    latest_user_text: userText.slice(0, 200),
    close_reasoning_panel_intent_detected: true,
    raw_panel_index_phrase: opts_.rawIndexPhrase || "",
    parsed_indices: requested,
    parsed_range_type: closeScope,
    close_scope: closeScope,
    panel_count_before: totalBefore,
    panel_order_before: prevOrder.map((p) => ({ tabIndex: p.tabIndex, laneId: p.laneId, label: p.label, visualIndex: p.visualIndex })),
    target_panel_ids_resolved_before_mutation: closedLaneIds,
    target_panel_titles_resolved_before_mutation: closedTitles,
    active_panel_id_before: activeBefore?.laneId || null,
    active_panel_was_closed: activeWasClosed,
    panel_had_active_stream: anyStreamCancelled,
    stream_cancelled: anyStreamCancelled,
    streams_cancelled_count: streamsCancelled,
    panel_count_after_close_before_refill: panelCountAfterCloseBeforeRefill,
    refill_enabled: refillToMinimum,
    min_panel_count: MIN_REASONING_PANELS,
    blank_panels_created_count: createdBlankCount,
    created_panel_ids: createdPanelIds,
    created_panel_titles: createdPanelTitles,
    recently_closed_stack_size: recentlyClosedReasoningPanels.length,
    panel_order_after: afterOrder.map((p) => ({ tabIndex: p.tabIndex, laneId: p.laneId, label: p.label, visualIndex: p.visualIndex })),
    active_panel_id_after: activeAfter?.laneId || null,
    close_completed: true,
    failure_reason: "",
    invalid_indices: invalidIdx,
    reason,
  });

  /* PART 7: high-level polish-layer log (separate channel so it's easy to
     grep without getting flooded by the lower-level mutation log). */
  logReasoningClosePolishDebug({
    raw_user_text: userText.slice(0, 200),
    cleaned_command_text: String(opts_.cleanedCommandText || "").slice(0, 200),
    close_phrases_detected: Array.isArray(opts_.allCloseSpans) ? opts_.allCloseSpans.map((s) => s.phrase) : [],
    selected_close_phrase: opts_.selectedClosePhrase || "",
    suppressed_close_phrases: Array.isArray(opts_.suppressedCloseSpans) ? opts_.suppressedCloseSpans.map((s) => s.phrase) : [],
    close_action_executed_once: true,
    confirmation_generated_once: true,
    panel_titles_before: prevOrder.map((p) => p.label),
    target_panel_ids: closedLaneIds,
    target_panel_titles: closedTitles,
    closed_count: targets.length,
    created_blank_count: createdBlankCount,
    panel_titles_after_before_normalization: panelOrderAfterRefillBeforeRename.map((p) => p.label),
    panel_titles_after_normalization: afterOrder.map((p) => p.label),
    blank_renames_applied: renameInfo.renamedCount,
    active_panel_after: activeAfter?.label || null,
    active_panel_was_closed: activeWasClosed,
    reason,
  });

  /* [close_core_completed] PART 9: terminal log on the success path so the
     console clearly shows entry → completion for every close. */
  try {
    console.info("[close_core_completed] " + JSON.stringify({
      source: reason,
      ok: true,
      closed_count: targets.length,
      closed_titles: closedTitles,
      targetPanelIds: closedLaneIds,
      activePanelBefore: activeBefore?.laneId || null,
      activePanelAfter: activeAfter?.laneId || null,
      renderTabsCalled,
      renderActivePanelCalled,
      closeCompleted: true,
      created_blank_count: createdBlankCount,
      panel_count_final: afterOrder.length,
      active_panel_id_after: activeAfter?.laneId || null,
    }));
  } catch (_) {}

  return {
    ok: true,
    closedTitles,
    closedLaneIds,
    closedCount: targets.length,
    createdBlankCount,
    totalBefore,
    invalidIndices: invalidIdx,
    activeAfter: activeAfter?.label || null,
    activeAfterLaneId: activeAfter?.laneId || null,
    activeWasClosed,
    renderTabsCalled,
    renderActivePanelCalled,
    panelTitlesAfter: afterOrder.map((p) => p.label),
    blankRenamesApplied: renameInfo.renamedCount,
  };
}

/* Backward-compat: the existing UI close button path still calls this name.
   It now delegates to the indices-based closer with refill enabled and an
   index lookup by tabIndex (not visual index) since that's what the click
   handler hands us.

   2026-05-28: clicking the X used to feel like a no-op because the
   close → refill happens in one tick and the replacement blank panel
   takes the same visual slot, so the strip looks identical to the user.
   The VOICE/TEXT close path renders an assistant-bubble confirmation
   ("Closed the Vietnam War 1955-1975 panel and opened a fresh one.")
   via buildCloseReasoningPanelsVoiceReply +
   renderReasoningCloseAssistantConfirmation, but the X-button path
   skipped all of that. We now mirror the same confirmation here so the
   user SEES the close happen, AND we set the close lock so a stale
   trailing voice command in the same turn does not double-fire. */
function closeReasoningTab(tabIndex) {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const order = getReasoningPanelOrder();
  const target = order.find((p) => p.tabIndex === Number(tabIndex));
  if (!target) return;
  const result = closeReasoningPanelsByVisualIndices([target.visualIndex], {
    reason: "ui_close_button",
    closeScope: "current_panel",
    refillToMinimum: true,
  });
  try {
    if (result && result.ok) {
      /* Synthetic "parsed" shaped like the voice/text close-by-title path
         so buildCloseReasoningPanelsVoiceReply uses the panel's actual
         title when available ("Closed the Vietnam War 1955-1975 panel
         and opened a fresh one.") and falls back to "Closed this panel
         and opened a fresh one." for blank Panel-N slots. */
      const titleForReply = String(target.label || "").trim();
      const isMeaningfulTitle =
        titleForReply && !_isGenericBlankReasoningPanelLabel(titleForReply);
      const syntheticParsed = isMeaningfulTitle
        ? {
            intent: "close_reasoning_panels",
            closeScope: "by_title",
            titleQuery: titleForReply,
            indices: [target.visualIndex],
          }
        : {
            intent: "close_reasoning_panels",
            closeScope: "current_panel",
            indices: [target.visualIndex],
          };
      const reply = buildCloseReasoningPanelsVoiceReply(result, syntheticParsed);
      _setReasoningCloseLock({
        scope: syntheticParsed.closeScope,
        indices: syntheticParsed.indices,
        confirmation: reply,
        source: "ui_close_button",
      });
      renderReasoningCloseAssistantConfirmation(reply, {
        path: "close-reasoning-panel",
        source: "ui_close_button",
        isVoice: false,
        stage: "ui_close_button_confirmation",
        closeActionCompleted: true,
        resumeListeningAfter: false,
      });
    }
  } catch (e) {
    try {
      console.warn("[ui_close_button_confirmation_failed]", String(e && e.message || e));
    } catch (_) {}
  }
  return result;
}

function closeReasoningTabByLaneId(laneId, opts = {}) {
  const lid = String(laneId || "").trim();
  if (!lid) return null;
  const order = getReasoningPanelOrder();
  const target = order.find((p) => String(p.laneId || "").trim() === lid);
  if (!target) return null;
  return closeReasoningTab(target.tabIndex);
}

/* =========================
   VOICE CONFIRMATION REPLY BUILDER
========================= */

/* Build the user-facing voice confirmation (spec PART 15 + polish PART 2).
   The reply is one short sentence; multi-panel/range/title/all variants
   exist so the voice UX matches the action the user actually took. */
const _REASONING_CLOSE_COUNT_WORD_OUT = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight",
];
function _countWordOrNumber(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0) return String(n);
  return _REASONING_CLOSE_COUNT_WORD_OUT[k] || String(k);
}
function buildCloseReasoningPanelsVoiceReply(execResult, parsed) {
  if (!execResult) return "I couldn't close that reasoning panel.";
  if (!execResult.ok && execResult.failureReason === "all_indices_out_of_range") {
    const n = Number(execResult.totalBefore);
    const count = Number.isFinite(n) && n >= 0 ? n : 0;
    return `I only see ${count} ${count === 1 ? "panel" : "panels"}.`;
  }
  if (execResult.ok) {
    const created = execResult.createdBlankCount || 0;
    const titles = execResult.closedTitles || [];
    const count = titles.length;
    const trailMulti = created > 0 ? " and opened fresh ones." : ".";
    const trailSingle = created > 0 ? " and opened a fresh one." : ".";
    const trail = count > 1 ? trailMulti : trailSingle;
    if (parsed?.closeScope === "all_panels") {
      return "Closed all panels and opened fresh ones.";
    }
    if (parsed?.closeScope === "other_panels") {
      return "Closed the other reasoning panels.";
    }
    if (parsed?.closeScope === "current_panel") {
      return `Closed this panel${trail}`;
    }
    if (parsed?.closeScope === "by_title" && titles.length === 1) {
      return `Closed the ${titles[0]} panel.`;
    }
    if (parsed?.closeScope === "range_first_n") {
      return `Closed the first ${_countWordOrNumber(count)} panels${trailMulti}`;
    }
    if (parsed?.closeScope === "range_last_n") {
      return `Closed the last ${_countWordOrNumber(count)} panels${trailMulti}`;
    }
    if (parsed?.closeScope === "range") {
      return `Closed panels ${parsed.indices?.[0]} through ${parsed.indices?.[parsed.indices.length - 1]}${trailMulti}`;
    }
    if (count === 1) {
      const onlyTitle = titles[0];
      /* Prefer the panel's title if it's a meaningful one. Otherwise fall
         back to the ordinal phrasing the user spoke. */
      if (onlyTitle && !_isGenericBlankReasoningPanelLabel(onlyTitle)) {
        return `Closed the ${onlyTitle} panel${trail}`;
      }
      const isOrdinal = parsed?.closeScope === "specific_indices" && Array.isArray(parsed?.indices) && parsed.indices.length === 1;
      return isOrdinal
        ? `Closed panel ${parsed.indices[0]}${trail}`
        : `Closed one panel${trail}`;
    }
    return `Closed ${_countWordOrNumber(count)} panels${trailMulti}`;
  }
  /* Failure paths. */
  if (execResult.failureReason === "all_indices_out_of_range") {
    return `I only see ${execResult.totalBefore} reasoning panel${execResult.totalBefore === 1 ? "" : "s"}.`;
  }
  if (execResult.failureReason === "no_title_match") {
    return "I couldn't find that panel.";
  }
  if (execResult.failureReason === "ambiguous_title") {
    const opts = (execResult.matchedTitles || []).slice(0, 3).join(", ");
    return opts ? `Which one — ${opts}?` : "Which reasoning panel do you mean?";
  }
  if (execResult.failureReason === "no_panels_exist") {
    return "There are no reasoning panels open.";
  }
  return "I couldn't close that reasoning panel.";
}

function isReasoningCloseVoiceSource(source, explicitIsVoice = null) {
  if (explicitIsVoice === true) return true;
  if (explicitIsVoice === false) return false;
  const s = String(source || "").toLowerCase();
  if (!s) return false;
  if (/(?:^|[-_\s])(?:typed|text-input|work-typed|main-work-text)(?:$|[-_\s])/.test(s)) return false;
  return /(?:^|[-_\s])(?:asr|voice|ptt|interruption|microphone|speech)(?:$|[-_\s])/.test(s);
}

function logReasoningCloseConfirmationUiDebug(payload) {
  try {
    console.info(
      "[reasoning_close_confirmation_debug] " + JSON.stringify(payload, null, 0)
    );
  } catch (_) {
    try {
      console.info("[reasoning_close_confirmation_debug] log_serialization_failed");
    } catch (_) {}
  }
}

function renderReasoningCloseAssistantConfirmation(reply, opts = {}) {
  const text = String(reply || "").trim();
  const source = String(opts.source || opts.reason || "");
  const isVoice = isReasoningCloseVoiceSource(source, opts.isVoice);
  const muted = Boolean(
    inputMuted ||
    (appModePrefix() === "vera" && isVeraWorkModeOn() && isWorkModeMuteEnabled())
  );
  let renderPath = "unknown";
  let ttsEnqueued = false;
  let playbackPromise = null;
  if (text) {
    try {
      if (typeof addBubble === "function") {
        addBubble(text, "vera", { path: opts.path || "close-reasoning-panel" });
        renderPath = "assistant_bubble";
      }
    } catch (_) {
      renderPath = "unknown";
    }
    if (isVoice && !muted && typeof enqueueAssistantTtsPlayback === "function") {
      ttsEnqueued = true;
      processing = true;
      requestInFlight = false;
      waveState = "speaking";
      try {
        setStatus(listeningMode === "ptt" ? "Speaking" : "Speaking… (Interruptible)", "speaking");
      } catch (_) {}
      playbackPromise = enqueueAssistantTtsPlayback(async () => {
        const ac = new AbortController();
        await playWorkModeTtsOnlyPhrase(text, ac.signal);
      });
      if (opts.resumeListeningAfter) {
        void playbackPromise.finally(() => {
          finishReasoningCloseVoiceTurnAfterAssistant({
            lifecycle: opts.lifecycle,
            source,
          });
        });
      } else {
        void playbackPromise.finally(() => {
          processing = false;
          requestInFlight = false;
          voiceUxTurn = null;
        });
      }
    }
  }
  if (isVoice && opts.resumeListeningAfter && !ttsEnqueued) {
    window.setTimeout(() => {
      finishReasoningCloseVoiceTurnAfterAssistant({
        lifecycle: opts.lifecycle,
        source,
      });
    }, 0);
  }
  logReasoningCloseConfirmationUiDebug({
    stage: opts.stage || "render_confirmation",
    close_panel_intent_detected: true,
    close_action_completed: Boolean(opts.closeActionCompleted),
    confirmation_text: text,
    confirmation_render_path: renderPath,
    confirmation_tts_enqueued: ttsEnqueued,
    confirmation_tts_skipped_reason: !text
      ? "empty_confirmation"
      : (!isVoice ? "text_only_or_non_voice_source" : (muted ? "muted" : "")),
    duplicate_confirmation_suppressed: Boolean(opts.duplicateConfirmationSuppressed),
    action_result_consumed_by_normal_reply_pipeline: renderPath === "assistant_bubble",
    source,
  });
  if (opts.lifecycle) {
    logReasoningCloseVoiceLifecycle({
      stage: "assistant_response",
      lifecycle_id: opts.lifecycle.lifecycleId || "",
      action_name: "reasoning.close_panel",
      assistant_bubble_rendered: renderPath === "assistant_bubble",
      confirmation_text: text,
      tts_enqueued: ttsEnqueued,
      should_resume_listening: Boolean(opts.lifecycle.shouldResumeListening),
      source,
    });
  }
  return { renderPath, ttsEnqueued };
}

/* =========================
   READ-ONLY ACCESSOR  (new, additive — Stage 8)

   Mirrors getTtsDebugState() / getInterruptionDebugState() /
   getAsrDebugState(). Returns a small named snapshot of the panel
   workspace + close-lock state so DevTools / future routing code
   can inspect without reaching into private state.
========================= */

function getReasoningPanelDebugState() {
  let order = [];
  try {
    order = getReasoningPanelOrder().map((p) => ({
      visualIndex: p.visualIndex,
      tabIndex: p.tabIndex,
      laneId: p.laneId,
      label: p.label,
      laneLabel: p.laneLabel,
      isActive: p.isActive,
    }));
  } catch (_) {}
  let lockActive = false;
  let lockSnapshot = null;
  try {
    lockActive = _hasActiveReasoningCloseLock();
    lockSnapshot = _peekReasoningCloseLock();
  } catch (_) {}
  return {
    panelCount: order.length,
    minPanels: MIN_REASONING_PANELS,
    maxPanels: typeof REASONING_TABS_MAX !== "undefined" ? REASONING_TABS_MAX : null,
    panelOrder: order,
    activePanel: order.find((p) => p.isActive) || null,
    recentlyClosedStackSize: recentlyClosedReasoningPanels.length,
    closeLockActive: lockActive,
    closeLockTurnLockMs: REASONING_CLOSE_TURN_LOCK_MS,
    closeLockSnapshot: lockSnapshot
      ? {
          atAgeMs: Date.now() - Number(lockSnapshot.at || 0),
          scope: lockSnapshot.scope,
          indicesKey: lockSnapshot.indicesKey,
          source: lockSnapshot.source,
        }
      : null,
  };
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Pre-extraction `app.js` did NOT attach these helpers to `window`. We
 *  add a curated set of aliases here purely for DevTools convenience —
 *  matches the additive pattern from Stages 5/6/7 (getTtsDebugState,
 *  getInterruptionDebugState, getAsrDebugState). All other usages
 *  continue to call through the bare identifiers in the shared
 *  classic-script global lexical env.
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.closeReasoningPanelsByVisualIndices = closeReasoningPanelsByVisualIndices;
    window.closeReasoningTab = closeReasoningTab;
    window.closeReasoningTabByLaneId = closeReasoningTabByLaneId;
    window.buildCloseReasoningPanelsVoiceReply = buildCloseReasoningPanelsVoiceReply;
    window.renderReasoningCloseAssistantConfirmation = renderReasoningCloseAssistantConfirmation;
    window.getReasoningPanelOrder = getReasoningPanelOrder;
    window.getReasoningPanelDebugState = getReasoningPanelDebugState;
  }
} catch (_) {}
/* =========================================================================
 *  STAGE 11 (2026-05-30) â€” Voice/text close command parser, ranker,
 *  recently-closed undo/refill executor, and the high-level shortcut
 *  handler â€” all moved here from app.js. The Stage 8 header above
 *  already listed every symbol below as "out of scope for Stage 8 (will
 *  likely move with the routing module in a later stage)". This is that
 *  later stage. Behavior is preserved EXACTLY:
 *
 *    - same regex sources (REASONING_CLOSE_ORDINAL_WORDS,
 *      REASONING_CLOSE_COUNT_WORDS, _REASONING_CLOSE_NOISE_TAIL_RES,
 *      _REASONING_CLOSE_NOISE_PREFIX_RES),
 *    - same span-extraction + ranking semantics (_scoreCloseScopeRank
 *      = 5/4/3/2/1, ties broken by later end-position),
 *    - same ASR noise-cleanup behavior of _cleanCommandTextForClose
 *      (PART 6 â€” only strips when the input already looks like a
 *      close command),
 *    - same console labels: [reasoning_close_debug],
 *      [reasoning_panel_close_debug], [reasoning_close_polish_debug],
 *      [reasoning_close_confirmation_debug],
 *      [reasoning_panel_select_debug],
 *      [reasoning_stream_cancelled_due_to_panel_close],
 *    - same try { window.* = ... } catch (_) {} aliases at end of block
 *      (parseCloseReasoningPanelsCommand, executeCloseReasoningPanelsCommand,
 *       closeReasoningPanelsByVisualIndices, reopenLastClosedReasoningPanel,
 *       findReasoningPanelIndicesByTitleQuery, getReasoningPanelOrder,
 *       maybeHandleCloseReasoningPanelShortcut).
 *
 *  Bare-identifier references the moved code resolves at CALL TIME
 *  through the shared classic-script global lexical environment:
 *    helpers still owned by app.js:
 *      finalizeReasoningCloseVoiceUserTurn,
 *      finishReasoningCloseVoiceTurnAfterAssistant,
 *      logReasoningCloseVoiceLifecycle,
 *      addBubble, setStatus, uiEl, commitServerUserTranscriptBubble,
 *      isVeraWorkModeOn, isLikelyRequestShape, VERA_SAFETY_LIMITS,
 *      mainBrowserLiveBubble, mainBrowserAsrTurnSeq,
 *      mainBrowserFinalTranscript, mainBrowserLastInterim,
 *      mainBrowserFinalizeKind, listening, listeningMode, inputMuted,
 *      voiceUxTurn, requestInFlight, processing, waveState,
 *      pttRecording, hasSpoken, audioChunks, interruptPartialLastText,
 *      interruptBargeInLatched, mainBrowserRecognition,
 *      interruptDetectRecognition, postInterruptRecognition,
 *      clearVoiceMaxDurationTimer, abortBrowserSpeechRecognizers,
 *      startListening, updateMuteInputButton, showMutedStatusIfIdle,
 *      browserAsrPreferred, getVeraAsrMode, REASONING_TABS_MAX,
 *      REASONING_TABS_DEFAULT, REASONING_UNTITLED_TAB_NAME.
 *    helpers already in this module (Stage 8):
 *      _hasActiveReasoningCloseLock, _setReasoningCloseLock,
 *      _peekReasoningCloseLock, _reasoningCloseLockKey,
 *      MIN_REASONING_PANELS, REASONING_RECENTLY_CLOSED_STACK_MAX,
 *      recentlyClosedReasoningPanels, logReasoningCloseDebug,
 *      logReasoningClosePolishDebug, snapshotReasoningPanelForUndo,
 *      pickReplacementActivePanelInfo, refillReasoningPanelsToMinimum,
 *      closeReasoningPanelsByVisualIndices, closeReasoningTab,
 *      buildCloseReasoningPanelsVoiceReply,
 *      renderReasoningCloseAssistantConfirmation,
 *      snapshotReasoningLaneRegistryForDebug,
 *      invalidateClosedReasoningLaneIdentity,
 *      readPersistedReasoningPanelTitlesForDebug,
 *      _normalizeBlankPanelNamesInOrder,
 *      _pickActivePanelInfoAfterRefill, getReasoningPanelOrder,
 *      getReasoningTabTopicLabelSafe, _isGenericBlankReasoningPanelLabel,
 *      _isBlankReasoningPanelElement.
 *    helpers already in workmode/checklist.js (Stage 9):
 *      _looksLikeChecklistCommand.
 *
 *  No routing changes. No regex changes. No log changes. No new
 *  side-effects. Pure code relocation.
 * ========================================================================= */
/* ===== Voice/text close command parser (spec PART 14) ============= */

const REASONING_CLOSE_ORDINAL_WORDS = new Map([
  ["first", 1], ["1st", 1],
  ["second", 2], ["2nd", 2],
  ["third", 3], ["3rd", 3],
  ["fourth", 4], ["4th", 4],
  ["fifth", 5], ["5th", 5],
  ["sixth", 6], ["6th", 6],
  ["seventh", 7], ["7th", 7],
  ["eighth", 8], ["8th", 8],
]);

const REASONING_CLOSE_COUNT_WORDS = new Map([
  ["one", 1], ["two", 2], ["three", 3], ["four", 4],
  ["five", 5], ["six", 6], ["seven", 7], ["eight", 8],
]);

/* Spec PART 13: phrases that look like checklist mutations, not panel closes.
 * _looksLikeChecklistCommand moved to workmode/checklist.js
 * (Stage 9, 2026-05-27). */

function _hasReasoningCloseSubject(text) {
  /* Panel/tab/reasoning/lane — the close intent must clearly mention one. */
  return /\b(?:reasoning\s+(?:panel|tab|space|lane|page)s?|panels?|tabs?|reasoning\s+space|reasoning\s+lane|reasoning)\b/i.test(text || "");
}

function _explicitlyNonReasoningCloseSubject(text) {
  const t = String(text || "").toLowerCase();
  if (/\bnews\s+(?:panel|tab|results?)?\b/.test(t)) return "news";
  if (/\b(?:music|spotify|playback)\s+(?:panel|tab|controls?|player|window)?\b/.test(t)) return "music";
  if (/\bfinance\s+(?:panel|tab|chart)?\b/.test(t)) return "finance";
  if (/\bsettings?\s+(?:panel|tab|page|menu)?\b/.test(t)) return "settings";
  if (/\bchecklist\s+(?:panel|tab)?\b/.test(t)) return "checklist";
  if (/\bbrowser\s+tab\b/.test(t)) return "browser_tab";
  return "";
}

function _parseReasoningCloseRange(text) {
  /* Returns { indices, scope } when matched, else null. */
  const t = String(text || "").toLowerCase();

  /* "close panels 1 through 3" / "close panels 1 to 3" */
  let m = t.match(/\bclose\s+(?:the\s+)?(?:reasoning\s+)?(?:panels?|tabs?|reasoning\s+(?:panels?|tabs?|spaces?|lanes?))\s+(\d+)\s+(?:through|thru|to|-)\s+(\d+)\b/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b) && a <= b) {
      const out = [];
      for (let i = a; i <= b; i += 1) out.push(i);
      return { indices: out, scope: "range" };
    }
  }

  /* "close the first two/three panels" / "close the first 2 panels" */
  m = t.match(/\bclose\s+(?:the\s+)?first\s+(\d+|one|two|three|four|five|six|seven|eight)\s+(?:reasoning\s+)?(?:panels?|tabs?|spaces?|lanes?|reasoning\s+(?:panels?|tabs?))\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : REASONING_CLOSE_COUNT_WORDS.get(m[1]) || 0;
    if (n > 0) {
      const out = [];
      for (let i = 1; i <= n; i += 1) out.push(i);
      return { indices: out, scope: "range_first_n", rangeN: n };
    }
  }

  /* "close the last two panels" */
  m = t.match(/\bclose\s+(?:the\s+)?last\s+(\d+|one|two|three|four|five|six|seven|eight)\s+(?:reasoning\s+)?(?:panels?|tabs?|spaces?|lanes?)\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : REASONING_CLOSE_COUNT_WORDS.get(m[1]) || 0;
    if (n > 0) {
      return { indices: null, scope: "range_last_n", rangeN: n };
    }
  }
  return null;
}

function _parseReasoningCloseIndices(text) {
  /* Extract numeric ordinals and word ordinals (spec PART 5+6).
     Returns { indices: [1-based], scope } or null. */
  const t = String(text || "").toLowerCase();
  const found = [];
  let sawSomething = false;

  /* "close the first and third panel" / "close first, second, and fourth panels" */
  const ordWordRe = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|last)\b/g;
  let m;
  while ((m = ordWordRe.exec(t)) !== null) {
    if (m[1] === "last") {
      found.push("LAST");
    } else {
      const n = REASONING_CLOSE_ORDINAL_WORDS.get(m[1]);
      if (n) found.push(n);
    }
    sawSomething = true;
  }

  /* "close panel 2" / "close panels 1, 2, and 3" / "close the 2nd panel" */
  const numRe = /\b(?:panels?|tabs?|reasoning\s+(?:panel|tab|space|lane)s?)\s+#?\s*(\d+(?:\s*(?:,\s*and|,\s*or|and|or|,|&)\s*\d+){0,8})\b/g;
  while ((m = numRe.exec(t)) !== null) {
    const nums = String(m[1]).split(/\s*(?:,\s*and|,\s*or|and|or|,|&)\s*/).map((x) => parseInt(x, 10)).filter(Number.isFinite);
    for (const n of nums) found.push(n);
    sawSomething = true;
  }
  /* Bare numbers after "close": "close 2 and 3" (only when followed by panel/tab keyword somewhere).
     We don't run this in isolation — _hasReasoningCloseSubject already gates the parser. */
  const bareRe = /\bclose\s+(\d+(?:\s*(?:,|and|or|&)\s*\d+){0,8})\b(?:[^.?!]*\b(?:panel|tab|reasoning)\b)?/g;
  while ((m = bareRe.exec(t)) !== null) {
    if (/\bitem|task|bullet|checklist|step\b/.test(t)) continue;
    const nums = String(m[1]).split(/\s*(?:,|and|or|&)\s*/).map((x) => parseInt(x, 10)).filter(Number.isFinite);
    for (const n of nums) found.push(n);
    sawSomething = true;
  }

  if (!sawSomething || !found.length) return null;
  return { indices: found, scope: "specific_indices" };
}

/* =========================================================================
   PART 6 — ASR noise cleanup for close commands
   --------------------------------------------------------------------------
   Browser ASR often appends tail noise after a finalized close command:
     - "can you hear me", "are you there", "hello"
     - stuttered self-corrections like "I I" / "I can you"
     - "you know" / "um" / "uh" repeats
   Stripping these noise tails before parsing prevents the parser from
   misreading a stray "I" as part of a different command and avoids the
   "Closed Panel 1 ... Closed the first two panels" double-fire problem.
   This is INTENTIONALLY only applied to close-command parsing — general
   chat must keep the user's exact words.
   ========================================================================= */
const _REASONING_CLOSE_NOISE_TAIL_RES = [
  /\s+(?:can\s+you\s+hear\s+me|are\s+you\s+there|hello|hey\s+vera|vera|hello\?+|are\s+you\s+listening)\s*[?!.,]*\s*$/i,
  /\s+(?:um+|uh+|ah+|er+|hmm+|you\s+know|like\s+yeah)\s*[?!.,]*\s*$/i,
];
const _REASONING_CLOSE_NOISE_PREFIX_RES = [
  /^\s*(?:hey\s+vera[, ]+|vera[, ]+|so[, ]+|um[, ]+|uh[, ]+|like[, ]+|you\s+know[, ]+)/i,
];
function _cleanCommandTextForClose(rawText) {
  const original = String(rawText || "").trim();
  if (!original) return "";
  /* PART 6 hard rule: only mangle text that already looks like a close
     command. General chat ("I really like the design, can you hear me?")
     must come back UNCHANGED, otherwise we'd accidentally lose the user's
     actual question whenever they said the words "can you hear me". */
  const looksLikeClose =
    /\b(?:close|clear|hide|dismiss|remove|delete|get\s+rid\s+of)\b/i.test(original)
    && /\b(?:panels?|tabs?|reasoning)\b/i.test(original);
  if (!looksLikeClose) return original;
  let t = original;
  /* Strip leading filler */
  for (const re of _REASONING_CLOSE_NOISE_PREFIX_RES) {
    t = t.replace(re, "");
  }
  /* Strip trailing noise tails, repeatedly (because two noise tails can
     stack: "... close the first two panel. I. can you hear me"). */
  let changed = true;
  let guard = 0;
  while (changed && guard < 6) {
    changed = false;
    guard += 1;
    for (const re of _REASONING_CLOSE_NOISE_TAIL_RES) {
      const next = t.replace(re, "");
      if (next !== t) {
        t = next;
        changed = true;
      }
    }
  }
  /* Collapse pronoun stutters like "I I I" or repeated "I" with no verb.
     Safe to do unconditionally now that the whole function is gated on
     looksLikeClose above. */
  t = t.replace(/\s+\bi\b(?:\s+\bi\b)*\s*[?!.,]*\s*$/i, "");
  /* Also collapse "and you" / "and i" trailing stutters left over after
     a duplicate-command run that we'll later collapse via the ranker. */
  t = t.replace(/\s+\band\s+(?:you|i)\b\s*[?!.,]*\s*$/i, "");
  return t.trim();
}

/* =========================================================================
   PART 1 — detect ALL candidate close-command spans, rank, pick one
   --------------------------------------------------------------------------
   A real user utterance can contain several overlapping close phrasings,
   either because the user self-corrected mid-sentence ("close the first
   panel and you close the first two panels") or because the browser ASR
   doubled a word. Rather than firing on the first match (which used to
   produce 2-3 close confirmations), we collect every plausible close span
   and pick the strongest by spec rank:
        5 → close all panels
        4 → close all other panels
        3 → range (first/last N, "1 through 3")
        2 → multiple specific indices
        1 → single specific index / current_panel / by_title
   Ties broken by latest end position (the more recently-spoken phrase
   wins). The unselected spans are emitted as suppressed_close_phrases for
   the spec PART 7 debug log.
   ========================================================================= */

function _scoreCloseScopeRank(scope) {
  switch (scope) {
    case "all_panels": return 5;
    case "other_panels": return 4;
    case "range":
    case "range_first_n":
    case "range_last_n":
      return 3;
    case "specific_indices_multi":
      return 2;
    default:
      return 1;
  }
}

/* Return [{scope, indices, rangeN, phrase, end}] for every close-target span
   we can see in `text`. The end position is the regex.lastIndex of the
   match (used as a tiebreaker so the LATEST occurrence wins). */
function _extractAllCloseSpans(text, panelCount) {
  const t = String(text || "").toLowerCase();
  if (!t) return [];
  const spans = [];

  const push = (scope, indices, rangeN, phrase, end) => {
    spans.push({
      scope,
      indices: Array.isArray(indices) ? indices.slice() : null,
      rangeN: Number.isFinite(rangeN) ? rangeN : null,
      phrase: String(phrase || "").trim(),
      end: Number.isFinite(end) ? end : t.length,
      rank: _scoreCloseScopeRank(scope === "specific_indices" && indices && indices.length > 1 ? "specific_indices_multi" : scope),
    });
  };

  /* all_panels variants */
  const allRe = /\b(?:close|clear)\s+(?:all\s+the\s+|all\s+|every\s+)?(?:reasoning\s+)?panels?\b/g;
  let m;
  while ((m = allRe.exec(t)) !== null) {
    /* Filter out "all other" — that's other_panels, handled below. */
    if (/\ball\s+other\b|\ball\s+the\s+other\b|\bother\b|\bevery\s+other\b/.test(m[0])) continue;
    /* Must look like "all/every" or be the only panels noun in the cmd. */
    if (/\b(?:all|every)\b/.test(m[0])) {
      push("all_panels", null, null, m[0], allRe.lastIndex);
    }
  }
  /* other_panels: "close all other panels" / "keep this one and close the rest" */
  const otherRe = /\b(?:close|clear|hide|dismiss|remove)\s+(?:all\s+other\s+|all\s+the\s+other\s+|every\s+other\s+|the\s+other\s+|inactive\s+|other\s+)(?:reasoning\s+)?(?:panels?|tabs?)\b|\bkeep\s+this\s+one\s+(?:and\s+(?:close|hide|dismiss|remove)\s+)?(?:the\s+)?(?:rest|others?|other\s+panels?)\b/g;
  while ((m = otherRe.exec(t)) !== null) {
    push("other_panels", null, null, m[0], otherRe.lastIndex);
  }
  /* range "1 through 3" */
  const rangeRe = /\bclose\s+(?:the\s+)?(?:reasoning\s+)?(?:panels?|tabs?)\s+(\d+)\s+(?:through|thru|to|-)\s+(\d+)\b/g;
  while ((m = rangeRe.exec(t)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b) && a <= b) {
      const idx = [];
      for (let i = a; i <= b; i += 1) idx.push(i);
      push("range", idx, b - a + 1, m[0], rangeRe.lastIndex);
    }
  }
  /* range_first_n */
  const firstNRe = /\bclose\s+(?:the\s+)?first\s+(\d+|one|two|three|four|five|six|seven|eight)\s+(?:reasoning\s+)?(?:panels?|tabs?|spaces?|lanes?)\b/g;
  while ((m = firstNRe.exec(t)) !== null) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (REASONING_CLOSE_COUNT_WORDS.get(m[1]) || 0);
    if (n > 0) {
      const idx = [];
      for (let i = 1; i <= n; i += 1) idx.push(i);
      push("range_first_n", idx, n, m[0], firstNRe.lastIndex);
    }
  }
  /* range_last_n */
  const lastNRe = /\bclose\s+(?:the\s+)?last\s+(\d+|one|two|three|four|five|six|seven|eight)\s+(?:reasoning\s+)?(?:panels?|tabs?|spaces?|lanes?)\b/g;
  while ((m = lastNRe.exec(t)) !== null) {
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (REASONING_CLOSE_COUNT_WORDS.get(m[1]) || 0);
    if (n > 0) {
      const N = Math.max(0, Number(panelCount) || 0);
      const k = Math.min(n, N);
      const idx = [];
      for (let i = N - k + 1; i <= N; i += 1) idx.push(i);
      push("range_last_n", idx, n, m[0], lastNRe.lastIndex);
    }
  }
  /* current_panel: "close this panel", "close current reasoning tab" */
  const curRe = /\bclose\s+(?:this|the\s+current|current)\s+(?:reasoning\s+)?(?:panel|tab|space|lane)\b/g;
  while ((m = curRe.exec(t)) !== null) {
    push("current_panel", null, null, m[0], curRe.lastIndex);
  }
  /* current_panel: bare local close commands like "close panel" / "close tab".
     Claim these before reasoning classification; otherwise local UI actions can
     fall through to Work Mode reasoning and show the generic unavailable bubble. */
  const barePanelRe = /\bclose\s+(?:the\s+)?(?:reasoning\s+)?(?:panel|tab|space|lane)\b/g;
  while ((m = barePanelRe.exec(t)) !== null) {
    push("current_panel", null, null, m[0], barePanelRe.lastIndex);
  }
  /* specific_indices via ordinal words AND via "panel N" numerics */
  const ordWordRe = /\bclose\s+(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|last)(?:\s+(?:and|or|,)\s+(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|last)){0,7}\s+(?:reasoning\s+)?(?:panels?|tabs?|spaces?|lanes?)\b/g;
  while ((m = ordWordRe.exec(t)) !== null) {
    const phrase = m[0];
    const idx = [];
    const wordsRe = /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|sixth|6th|seventh|7th|eighth|8th|last)\b/g;
    let w;
    while ((w = wordsRe.exec(phrase)) !== null) {
      if (w[1] === "last") {
        const N = Math.max(0, Number(panelCount) || 0);
        if (N > 0) idx.push(N);
      } else {
        const n = REASONING_CLOSE_ORDINAL_WORDS.get(w[1]);
        if (n) idx.push(n);
      }
    }
    const dedup = [...new Set(idx)].sort((a, b) => a - b);
    if (dedup.length) push("specific_indices", dedup, null, phrase, ordWordRe.lastIndex);
  }
  const numRe = /\bclose\s+(?:the\s+)?(?:reasoning\s+)?(?:panels?|tabs?)\s+#?\s*(\d+(?:\s*(?:,\s*and|,\s*or|and|or|,|&)\s*\d+){0,8})\b/g;
  while ((m = numRe.exec(t)) !== null) {
    const phrase = m[0];
    const nums = String(m[1]).split(/\s*(?:,\s*and|,\s*or|and|or|,|&)\s*/).map((x) => parseInt(x, 10)).filter(Number.isFinite);
    const dedup = [...new Set(nums)].sort((a, b) => a - b);
    if (dedup.length) push("specific_indices", dedup, null, phrase, numRe.lastIndex);
  }
  return spans;
}

function _pickStrongestCloseSpan(spans) {
  if (!Array.isArray(spans) || !spans.length) return null;
  /* Sort: higher rank first; ties → later end position first. */
  const sorted = spans.slice().sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return b.end - a.end;
  });
  return sorted[0];
}

function parseCloseReasoningPanelsCommand(text, panelCount) {
  /* Spec PART 14 returns:
       {
         intent: "close_reasoning_panels" | "reopen_last_reasoning_panel" | null,
         closeScope: "specific_indices" | "range_first_n" | "range_last_n" |
                     "range" | "all_panels" | "other_panels" |
                     "by_title" | "current_panel" | "unresolved",
         indices: [1-based, 1-based, ...] | null,
         titleQuery: "..." | "",
         refillToMinimum: true,
         reason: "...",
         failureReason: "" | "needs_clarification" | "non_reasoning_subject" |
                        "looks_like_checklist" | "invalid_index" | "no_match",
         parsedRangeType: same as closeScope,
         rawCommandText: cleaned-and-stripped command text that was parsed,
         allCloseSpans: [{scope, phrase, indices, rangeN, rank, end}, …],
         suppressedCloseSpans: spans skipped in favor of the selected one,
         selectedSpan: the chosen span (PART 1),
       }
     `panelCount` is the current number of visible reasoning panels (so we
     can resolve "last N" deterministically here). */
  const out = {
    intent: null,
    closeScope: "unresolved",
    indices: null,
    titleQuery: "",
    refillToMinimum: true,
    reason: "",
    failureReason: "",
    parsedRangeType: "unresolved",
    rawIndexPhrase: "",
    rawCommandText: "",
    allCloseSpans: [],
    suppressedCloseSpans: [],
    selectedSpan: null,
  };
  const original = String(text || "").trim();
  if (!original) {
    out.failureReason = "empty_text";
    return out;
  }
  /* PART 6: strip noisy ASR tails BEFORE parsing so we don't get a stray
     "I" or "can you hear me" fragment dragging the parser into a different
     scope than the user spoke. */
  const raw = _cleanCommandTextForClose(original) || original;
  out.rawCommandText = raw;
  const t = raw.toLowerCase();

  /* Undo / reopen */
  if (/\b(?:undo\s+close|reopen\s+(?:the\s+)?(?:last\s+)?(?:reasoning\s+)?panel|restore\s+(?:the\s+)?(?:last\s+)?closed\s+(?:reasoning\s+)?panel|bring\s+back\s+(?:the\s+)?(?:last|previous)\s+(?:reasoning\s+)?panel)\b/.test(t)) {
    out.intent = "reopen_last_reasoning_panel";
    out.closeScope = "reopen_last";
    out.parsedRangeType = "reopen_last";
    out.reason = "undo_or_reopen_keyword";
    return out;
  }

  /* Must say "close" (or "clear/remove/delete/get rid of" + panel/tab/reasoning). */
  const hasCloseVerb = /\b(?:close|clear|hide|dismiss|remove|delete|get\s+rid\s+of)\b/.test(t);
  if (!hasCloseVerb) {
    out.failureReason = "no_close_verb";
    return out;
  }

  /* Spec PART 13: don't eat checklist commands. */
  if (_looksLikeChecklistCommand(raw)) {
    out.failureReason = "looks_like_checklist";
    out.reason = "checklist_pattern_match_blocks_panel_close";
    return out;
  }

  /* Spec PART 3+17: route news/music/finance/settings panel closes elsewhere. */
  const otherSubject = _explicitlyNonReasoningCloseSubject(raw);
  if (otherSubject) {
    out.failureReason = "non_reasoning_subject";
    out.reason = `subject_is_${otherSubject}_panel`;
    return out;
  }

  /* Must mention reasoning/panel/tab. Bare "close this" with no subject is
     too risky — could mean "close this email", "close this email tab", etc.
     We accept "close this panel/tab" though. Exception: "keep this one and
     close the rest" / "close the others" implies the reasoning workspace
     because that phrasing doesn't fit other surfaces (music tracks, news
     headlines, etc.). */
  const closeOthersImplicit = /\b(?:close|hide|dismiss|remove)\s+(?:all\s+)?(?:the\s+)?(?:rest|others?|other\s+ones?)\b|\bkeep\s+this\s+one\s+(?:and\s+(?:close|hide|dismiss|remove)\s+)?(?:the\s+)?(?:rest|others?)\b/.test(t);
  if (!_hasReasoningCloseSubject(raw) && !closeOthersImplicit) {
    out.failureReason = "no_panel_subject";
    out.reason = "no_panel_or_tab_or_reasoning_keyword";
    return out;
  }

  /* PART 1: scan ALL candidate close spans, pick strongest+latest, log
     the suppressed siblings. This collapses repeated phrases ("close the
     first panel and you close the first two panels") into one execution. */
  const allSpans = _extractAllCloseSpans(raw, panelCount);
  out.allCloseSpans = allSpans.map((s) => ({
    scope: s.scope, phrase: s.phrase, indices: s.indices, rangeN: s.rangeN, rank: s.rank, end: s.end,
  }));
  const selected = _pickStrongestCloseSpan(allSpans);
  if (selected) {
    out.selectedSpan = {
      scope: selected.scope, phrase: selected.phrase, indices: selected.indices, rangeN: selected.rangeN, rank: selected.rank, end: selected.end,
    };
    out.suppressedCloseSpans = allSpans
      .filter((s) => s !== selected)
      .map((s) => ({ scope: s.scope, phrase: s.phrase, indices: s.indices, rangeN: s.rangeN, rank: s.rank, end: s.end }));
    out.intent = "close_reasoning_panels";
    out.closeScope = selected.scope;
    out.parsedRangeType = selected.scope;
    out.reason = "ranked_pick";
    if (selected.scope === "all_panels") {
      out.rawIndexPhrase = "all_panels";
      return out;
    }
    if (selected.scope === "other_panels") {
      out.rawIndexPhrase = "other_panels";
      return out;
    }
    if (selected.scope === "current_panel") {
      out.rawIndexPhrase = "current_panel";
      return out;
    }
    if (selected.scope === "range" || selected.scope === "range_first_n" || selected.scope === "range_last_n") {
      out.indices = Array.isArray(selected.indices) ? selected.indices.slice() : [];
      out.rawIndexPhrase = `${selected.scope}:${selected.rangeN ?? "n/a"}`;
      if (!out.indices.length) {
        out.failureReason = "invalid_range";
      }
      return out;
    }
    if (selected.scope === "specific_indices") {
      out.indices = Array.isArray(selected.indices) ? selected.indices.slice() : [];
      out.rawIndexPhrase = out.indices.join(",");
      if (!out.indices.length) {
        out.failureReason = "no_indices";
      }
      return out;
    }
  }

  /* "close the X panel" — by title */
  const titleMatch = raw.match(/\bclose\s+(?:the\s+)?(.+?)\s+(?:reasoning\s+)?(?:panel|tab|space|lane)\b/i);
  if (titleMatch) {
    const candidate = String(titleMatch[1] || "").trim();
    /* Filter out generic words like "this/that/current/other/new/blank". */
    if (candidate && !/^(?:this|that|the|a|an|current|other|inactive|new|blank|first|second|third|fourth|fifth|last|right|left|next|previous|prior|active|focused|selected)$/i.test(candidate)) {
      out.intent = "close_reasoning_panels";
      out.closeScope = "by_title";
      out.parsedRangeType = "by_title";
      out.titleQuery = candidate;
      out.reason = "by_title_phrase";
      out.rawIndexPhrase = `title:${candidate}`;
      return out;
    }
  }

  out.failureReason = "unresolved";
  out.reason = "could_not_parse_close_target";
  return out;
}

/* Title fuzzy match. Returns array of 1-based visual indices that match. */
function findReasoningPanelIndicesByTitleQuery(query) {
  const q = String(query || "").trim().toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ");
  if (!q) return [];
  const order = getReasoningPanelOrder();
  const hits = [];
  for (const p of order) {
    const lab = String(p.label || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ");
    if (!lab) continue;
    if (lab.includes(q) || q.includes(lab)) {
      hits.push(p.visualIndex);
      continue;
    }
    /* Token-overlap fallback. */
    const qToks = q.split(" ").filter((w) => w.length >= 3);
    const lToks = lab.split(" ").filter(Boolean);
    if (qToks.length) {
      const hit = qToks.filter((w) => lToks.includes(w)).length;
      if (hit / qToks.length >= 0.6) hits.push(p.visualIndex);
    }
  }
  return [...new Set(hits)].sort((a, b) => a - b);
}

/* Re-open the most recently closed panel (PART 11). */
function reopenLastClosedReasoningPanel(opts = {}) {
  const last = recentlyClosedReasoningPanels.pop();
  if (!last) {
    return { ok: false, failureReason: "stack_empty" };
  }
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return { ok: false, failureReason: "no_panels_root" };

  /* If we're at the cap, we can't add. Pop one blank first if any blanks
     exist (a blank is one with no html content and a default-shaped
     laneLabel). */
  const cur = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  if (cur.length >= REASONING_TABS_MAX) {
    const blankCandidate = cur.find((p) => {
      const html = (p.querySelector(".vera-reasoning-md-panel") || p.querySelector(".vera-reasoning-scroll"))?.innerHTML || "";
      const isDefaultLabel = /^Panel\s+\d+$/i.test(String(p.dataset.laneLabel || ""));
      return !html.trim() && isDefaultLabel;
    });
    if (blankCandidate) {
      try { blankCandidate.remove(); } catch (_) {}
    } else {
      /* Push back; user has to manually close something first. */
      recentlyClosedReasoningPanels.push(last);
      return { ok: false, failureReason: "at_max_panels" };
    }
  }

  /* Restore each closed panel from the snapshot bundle (usually 1, but if
     a single "close all" was undone we restore them in original order). */
  for (const snap of last.panels) {
    /* Reuse addReasoningTab to allocate a new tabIndex, then rewrite the
       lane metadata and inner HTML to the saved state. */
    addReasoningTab();
    const all = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
    const newest = all[all.length - 1];
    if (!newest) continue;
    newest.dataset.tabTopic = snap.topic || REASONING_UNTITLED_TAB_NAME;
    newest.dataset.tabTopicSet = snap.topicSet || "0";
    if (snap.laneLabel) newest.dataset.laneLabel = snap.laneLabel;
    const scroll =
      newest.querySelector(".vera-reasoning-md-panel") ||
      newest.querySelector(".vera-reasoning-scroll");
    if (scroll) scroll.innerHTML = String(snap.html || "");
  }

  /* If auto-refill earlier created surplus blanks beyond MIN_REASONING_PANELS,
     trim the trailing blanks (only blanks, never user content). */
  const order = getReasoningPanelOrder();
  if (order.length > MIN_REASONING_PANELS) {
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const p = order[i].element;
      const scroll = p.querySelector(".vera-reasoning-md-panel") || p.querySelector(".vera-reasoning-scroll");
      const empty = !((scroll?.innerHTML || "").trim());
      const isDefaultLabel = /^Panel\s+\d+$/i.test(String(p.dataset.laneLabel || ""));
      if (empty && isDefaultLabel) {
        try { p.remove(); } catch (_) {}
        const afterCount = document.querySelectorAll("#vera-reasoning-tab-panels .vera-reasoning-tab-panel").length;
        if (afterCount <= MIN_REASONING_PANELS) break;
      }
    }
  }
  syncReasoningLaneBusySlotsAfterDomChange();
  renderReasoningTabStrip();
  logReasoningCloseDebug({
    latest_user_text: String(opts?.userText || "").slice(0, 200),
    close_reasoning_panel_intent_detected: false,
    parsed_range_type: "reopen_last",
    close_scope: "reopen_last",
    reopened_titles: last.panels.map((p) => p.label),
    recently_closed_stack_size: recentlyClosedReasoningPanels.length,
    refill_enabled: true,
    min_panel_count: MIN_REASONING_PANELS,
    close_completed: true,
    failure_reason: "",
  });
  return { ok: true, reopenedTitles: last.panels.map((p) => p.label) };
}

/* High-level executor used by both the voice/text shortcut and the
   backend action payload. Returns a small object the caller can use to
   say something back to the user. */
function executeCloseReasoningPanelsCommand(parsed, opts = {}) {
  const userText = String(opts.userText || "");
  if (!parsed || parsed.intent !== "close_reasoning_panels") {
    return { ok: false, failureReason: parsed?.failureReason || "no_intent" };
  }
  const order = getReasoningPanelOrder();
  const N = order.length;
  if (!N) {
    return { ok: false, failureReason: "no_panels_exist" };
  }

  let indices = [];
  let closeScope = parsed.closeScope || "specific_indices";
  let invalidIndices = [];

  if (closeScope === "all_panels") {
    indices = order.map((p) => p.visualIndex);
  } else if (closeScope === "other_panels") {
    const active = order.find((p) => p.isActive);
    if (!active) {
      indices = order.map((p) => p.visualIndex);
    } else {
      indices = order.filter((p) => !p.isActive).map((p) => p.visualIndex);
    }
  } else if (closeScope === "current_panel") {
    const active = order.find((p) => p.isActive);
    indices = active ? [active.visualIndex] : [order[0].visualIndex];
  } else if (closeScope === "by_title") {
    const hits = findReasoningPanelIndicesByTitleQuery(parsed.titleQuery);
    if (!hits.length) {
      return { ok: false, failureReason: "no_title_match", titleQuery: parsed.titleQuery };
    }
    if (hits.length > 1) {
      /* PART 4: ambiguous title — ask clarification. */
      return {
        ok: false,
        failureReason: "ambiguous_title",
        titleQuery: parsed.titleQuery,
        matchedVisualIndices: hits,
        matchedTitles: hits.map((vi) => order[vi - 1]?.label).filter(Boolean),
      };
    }
    indices = hits;
  } else {
    /* specific_indices, range_first_n, range_last_n, range — parser already
       expanded these to absolute 1-based indices. */
    indices = Array.isArray(parsed.indices) ? parsed.indices.slice() : [];
    invalidIndices = indices.filter((n) => n < 1 || n > N);
    if (invalidIndices.length && !indices.some((n) => n >= 1 && n <= N)) {
      /* PART 10: all out of range — explicit refuse, do not guess. */
      return {
        ok: false,
        failureReason: "all_indices_out_of_range",
        invalidIndices,
        totalBefore: N,
        closeScope,
      };
    }
  }

  /* PART 10: filter to in-range and dedupe; we keep going on partial overlap
     ("close first five panels" when only 3 exist → close 1,2,3). */
  indices = [...new Set(indices.filter((n) => n >= 1 && n <= N))];
  if (!indices.length) {
    return { ok: false, failureReason: "no_valid_indices", invalidIndices, totalBefore: N };
  }

  const result = closeReasoningPanelsByVisualIndices(indices, {
    reason: opts.reason || "voice_or_text_command",
    closeScope,
    refillToMinimum: parsed.refillToMinimum !== false,
    userText,
    rawIndexPhrase: parsed.rawIndexPhrase || "",
    cleanedCommandText: String(parsed.rawCommandText || ""),
    allCloseSpans: Array.isArray(parsed.allCloseSpans) ? parsed.allCloseSpans : [],
    suppressedCloseSpans: Array.isArray(parsed.suppressedCloseSpans) ? parsed.suppressedCloseSpans : [],
    selectedClosePhrase: parsed.selectedSpan?.phrase || "",
  });
  const final = {
    ...result,
    closeScope,
    invalidIndices,
    totalBefore: N,
  };
  /* PART 2: centralize confirmation generation. ANY caller that wants a
     user-visible confirmation MUST use exec.confirmation — neither the
     bubble layer nor the voice layer should produce its own phrasing. */
  final.confirmation = buildCloseReasoningPanelsVoiceReply(final, parsed);
  return final;
}

/* _REASONING_CLOSE_COUNT_WORD_OUT, _countWordOrNumber,
 * buildCloseReasoningPanelsVoiceReply, isReasoningCloseVoiceSource,
 * logReasoningCloseConfirmationUiDebug,
 * renderReasoningCloseAssistantConfirmation
 * → moved to workmode/panels.js (Stage 8, 2026-05-27). */

/* Try to handle a voice/text command client-side. Returns true when handled. */
function maybeHandleCloseReasoningPanelShortcut(text, opts = {}) {
  if (!text) return false;
  const source = opts.reason || "client_shortcut";
  const inputSource = opts && opts.isVoice ? "voice" : "typed";
  /* [typed_close_panel_route / voice_close_panel_route] PART 3+4+9: log
     entry to the shortcut for every typed/voice attempt, including the
     gate state so we can see WHY a close didn't fire (e.g. not in Work
     Mode, intent not detected, parse returned a different scope). Tag
     is voice-vs-typed via opts.isVoice. */
  const _gateWorkMode = (() => { try { return Boolean(isVeraWorkModeOn()); } catch (_) { return null; } })();
  const _gateModePrefix = (() => { try { return appModePrefix(); } catch (_) { return null; } })();
  const order = (() => { try { return getReasoningPanelOrder(); } catch (_) { return []; } })();
  const parsed = parseCloseReasoningPanelsCommand(text, order.length);
  const closePanelIntentDetected =
    parsed?.intent === "close_reasoning_panels" ||
    parsed?.intent === "reopen_last_reasoning_panel";
  const finalRoute = closePanelIntentDetected ? "local_app_action" : "not_close_panel";
  const gatePassed = Boolean(_gateWorkMode && _gateModePrefix === "vera");
  const hasReasoningPanelDom = order.length > 0;
  if (closePanelIntentDetected) {
    try {
      console.info("[close_panel_route_called] " + JSON.stringify({
        raw_text: String(text || ""),
        input_source: inputSource,
        source,
        finalRoute,
      }));
    } catch (_) {}
  }
  /* Mirror open-panel robustness: the close command is a local UI action if
     reasoning panels are present. Do not let stale mode/app-prefix state make
     a detected close fall through into Work Mode reasoning generation. */
  if (!gatePassed && (!closePanelIntentDetected || !hasReasoningPanelDom)) {
    try {
      console.info(
        ((opts && opts.isVoice) ? "[voice_close_panel_route] " : "[typed_close_panel_route] ") +
        JSON.stringify({
          text_preview: String(text).slice(0, 80),
          source,
          gate_work_mode_on: _gateWorkMode,
          gate_mode_prefix: _gateModePrefix,
          gate_passed: false,
          closePanelIntentDetected,
          finalRoute,
          panel_count_before: order.length,
          reason_skipped: "not_in_vera_work_mode",
        })
      );
    } catch (_) {}
    if (closePanelIntentDetected) {
      try {
        console.info("[route_continued_after_close] " + JSON.stringify({
          raw_text: String(text || ""),
          input_source: inputSource,
          source,
          closePanelIntentDetected,
          reason: "no_reasoning_panels_present",
        }));
      } catch (_) {}
    }
    return false;
  }
  try {
    console.info(
      (opts && opts.isVoice ? "[voice_close_panel_route] " : "[typed_close_panel_route] ") +
      JSON.stringify({
        raw_text: String(text || ""),
        text_preview: String(text).slice(0, 80),
        input_source: inputSource,
        source,
        gate_passed: gatePassed,
        gate_overridden_for_local_close: !gatePassed && closePanelIntentDetected && hasReasoningPanelDom,
        closePanelIntentDetected,
        intent_detected: parsed?.intent || null,
        finalRoute,
        reasoningRouteSkipped: closePanelIntentDetected,
        action_name: parsed?.intent === "close_reasoning_panels" ? "reasoning.close_panel"
                    : parsed?.intent === "reopen_last_reasoning_panel" ? "reasoning.reopen_last_panel"
                    : null,
        parsed_close_scope: parsed?.closeScope || null,
        parsed_indices: parsed?.indices || [],
        panel_count_before: order.length,
        actionHandlerFound: typeof executeCloseReasoningPanelsCommand === "function",
        action_handler_found: typeof executeCloseReasoningPanelsCommand === "function",
      })
    );
  } catch (_) {}

  if (parsed.intent === "reopen_last_reasoning_panel") {
    if (_hasActiveReasoningCloseLock()) {
      logReasoningClosePolishDebug({
        stage: "shortcut_dedup_skip_reopen",
        reason: "lock_active",
        source: opts.reason || "client_shortcut",
        prev_lock: _peekReasoningCloseLock(),
        latest_user_text: String(text || "").slice(0, 200),
      });
      try {
        console.info("[close_panel_handled_return_value] " + JSON.stringify({
          raw_text: String(text || ""),
          input_source: inputSource,
          source,
          handled: true,
          reason: "dedup_lock_active_reopen",
        }));
      } catch (_) {}
      return true;
    }
    const lifecycle = finalizeReasoningCloseVoiceUserTurn(text, {
      ...opts,
      source,
      path: "reopen-reasoning-panel-user",
    });
    const r = reopenLastClosedReasoningPanel({ userText: text });
    if (r.ok) {
      const title = r.reopenedTitles?.[0] || "that panel";
      const reply = `Reopened ${title}.`;
      _setReasoningCloseLock({ scope: "reopen_last", indices: null, confirmation: reply, source });
      renderReasoningCloseAssistantConfirmation(reply, {
        path: "reopen-reasoning-panel",
        source,
        isVoice: opts.isVoice,
        stage: "shortcut_reopen_success",
        closeActionCompleted: true,
        lifecycle,
        resumeListeningAfter: true,
      });
      try {
        console.info("[close_panel_handled_return_value] " + JSON.stringify({
          raw_text: String(text || ""),
          input_source: inputSource,
          source,
          handled: true,
          reason: "reopen_success",
        }));
      } catch (_) {}
      return true;
    }
    if (r.failureReason === "stack_empty") {
      const reply = "I don't have a recently closed panel to reopen.";
      renderReasoningCloseAssistantConfirmation(reply, {
        path: "reopen-reasoning-panel-empty",
        source,
        isVoice: opts.isVoice,
        stage: "shortcut_reopen_empty",
        closeActionCompleted: false,
        lifecycle,
        resumeListeningAfter: true,
      });
      try {
        console.info("[close_panel_handled_return_value] " + JSON.stringify({
          raw_text: String(text || ""),
          input_source: inputSource,
          source,
          handled: true,
          reason: "reopen_stack_empty",
        }));
      } catch (_) {}
      return true;
    }
    try {
      console.info("[route_continued_after_close] " + JSON.stringify({
        raw_text: String(text || ""),
        input_source: inputSource,
        source,
        closePanelIntentDetected: true,
        reason: "reopen_failed_unhandled",
      }));
    } catch (_) {}
    return false;
  }

  if (parsed.intent !== "close_reasoning_panels") {
    return false;
  }

  /* PART 2: per-turn lock. If we already handled a close action in the
     same user turn (from an earlier ASR interrupt finalize, e.g.), do not
     execute again and do not double-bubble. We DO claim the shortcut as
     handled so the /infer round-trip doesn't pile on another execution. */
  if (_hasActiveReasoningCloseLock()) {
    logReasoningCloseConfirmationUiDebug({
      stage: "shortcut_dedup_skip_close",
      close_panel_intent_detected: true,
      close_action_completed: true,
      confirmation_text: String(_peekReasoningCloseLock()?.confirmation || ""),
      confirmation_render_path: "assistant_bubble",
      confirmation_tts_enqueued: false,
      duplicate_confirmation_suppressed: true,
      action_result_consumed_by_normal_reply_pipeline: true,
      source: opts.reason || "client_shortcut",
    });
    logReasoningClosePolishDebug({
      stage: "shortcut_dedup_skip_close",
      reason: "lock_active",
      source: opts.reason || "client_shortcut",
      prev_lock: _peekReasoningCloseLock(),
      latest_user_text: String(text || "").slice(0, 200),
      parsed_close_scope: parsed.closeScope,
      parsed_indices: parsed.indices || [],
    });
    try {
      console.info("[close_panel_handled_return_value] " + JSON.stringify({
        raw_text: String(text || ""),
        input_source: inputSource,
        source,
        handled: true,
        reason: "dedup_lock_active_close",
      }));
    } catch (_) {}
    return true;
  }

  /* Log the parse decision regardless of execute outcome. */
  logReasoningCloseDebug({
    latest_user_text: String(text || "").slice(0, 200),
    close_reasoning_panel_intent_detected: true,
    parsed_range_type: parsed.parsedRangeType,
    close_scope: parsed.closeScope,
    parsed_indices: parsed.indices || [],
    raw_panel_index_phrase: parsed.rawIndexPhrase,
    panel_count_before: order.length,
    stage: "client_shortcut_parsed",
    cleaned_command_text: String(parsed.rawCommandText || "").slice(0, 200),
    selected_close_phrase: parsed.selectedSpan?.phrase || "",
    suppressed_close_phrases: Array.isArray(parsed.suppressedCloseSpans) ? parsed.suppressedCloseSpans.map((s) => s.phrase) : [],
  });

  const lifecycle = finalizeReasoningCloseVoiceUserTurn(text, {
    ...opts,
    source,
    path: "close-reasoning-panel-user",
  });

  const exec = executeCloseReasoningPanelsCommand(parsed, {
    userText: text,
    reason: source,
  });
  logReasoningCloseVoiceLifecycle({
    stage: "action",
    lifecycle_id: lifecycle.lifecycleId || "",
    action_name: "reasoning.close_panel",
    close_action_completed: Boolean(exec?.ok),
    target_panel_ids: Array.isArray(exec?.closedPanels)
      ? exec.closedPanels.map((p) => p?.id || p?.panel_id || p?.label || "").filter(Boolean)
      : (parsed.indices || []),
    panels_after: getReasoningPanelOrder().map((p) => p?.label || p?.id || "").filter(Boolean),
    source,
  });
  /* PART 2: use the single centralized confirmation. */
  const reply = exec?.confirmation || buildCloseReasoningPanelsVoiceReply(exec, parsed);
  _setReasoningCloseLock({
    scope: parsed.closeScope,
    indices: parsed.indices || null,
    confirmation: reply,
    source,
  });
  renderReasoningCloseAssistantConfirmation(reply, {
    path: "close-reasoning-panel",
    source,
    isVoice: opts.isVoice,
    stage: "shortcut_close_confirmation",
    closeActionCompleted: Boolean(exec?.ok),
    lifecycle,
    resumeListeningAfter: true,
  });
  try {
    console.info("[close_panel_handled_return_value] " + JSON.stringify({
      raw_text: String(text || ""),
      input_source: inputSource,
      source,
      handled: true,
      close_completed: Boolean(exec?.ok),
      confirmation: String(reply || ""),
    }));
  } catch (_) {}
  return true;
}

try {
  window.parseCloseReasoningPanelsCommand = parseCloseReasoningPanelsCommand;
  window.executeCloseReasoningPanelsCommand = executeCloseReasoningPanelsCommand;
  window.closeReasoningPanelsByVisualIndices = closeReasoningPanelsByVisualIndices;
  window.reopenLastClosedReasoningPanel = reopenLastClosedReasoningPanel;
  window.findReasoningPanelIndicesByTitleQuery = findReasoningPanelIndicesByTitleQuery;
  window.getReasoningPanelOrder = getReasoningPanelOrder;
  window.maybeHandleCloseReasoningPanelShortcut = maybeHandleCloseReasoningPanelShortcut;
} catch (_) {}
/* =========================================================================
 *  STAGE 12 (2026-05-31) â€” Per-panel follow-up queue (visible in each
 *  reasoning panel) moved here from app.js. The Map + queue cap, plus the
 *  full enqueue/edit/delete/drain/clear surface and the
 *  `window.workModeReasoningPanelQueue` debug-export object, came over
 *  together. Behavior is preserved EXACTLY:
 *
 *    - same `workModeReasoningPanelFollowUpQueue` Map<laneIdx, items[]>
 *      (distinct from the global `workModeTypedTurnQueue` and the lane
 *      wait queue),
 *    - same REASONING_PANEL_QUEUE_MAX = 6 cap, same enqueue/dequeue order,
 *    - same `[QUEUE_DEBUG][enqueue|delete|edit|dequeue_run|dequeue_run_error|enqueue_rejected]`
 *      console-log labels (byte-identical),
 *    - same `window.workModeReasoningPanelQueue = { enqueue, delete, edit,
 *      render, drain, clear, list }` debug export.
 *
 *  Bare-identifier references that resolve at CALL TIME through the
 *  shared classic-script global lexical environment:
 *    helpers already in this module (Stage 8):
 *      getReasoningTabTopicLabel, getWorkModeReasoningLaneLabel,
 *      activateReasoningTab.
 *    helpers already in workmode/checklist.js (Stage 9):
 *      isVeraWorkModeOn.
 *    helpers still owned by app.js:
 *      appModePrefix, workModeReasoningLaneBusy (lane busy-queue),
 *      getActiveReasoningLaneIndex, sendVeraWorkModeTypedInferTurn
 *      (the typed-turn infer entry, deliberately out of scope for 1B).
 *
 *  No routing changes. No regex changes. No log changes. Pure relocation.
 * ========================================================================= */
// =========================
// Per-panel follow-up queue (visible in each reasoning panel)
// =========================
// Map<laneIdx (number), Array<{ id, text, opts, createdAt, panelLabel }>>.
// Distinct from the global `workModeTypedTurnQueue` and the lane wait queue:
// this queue is *visible* inside the targeted panel so the user can review,
// edit, or delete their follow-ups before the panel starts running them.
const workModeReasoningPanelFollowUpQueue = new Map();
const REASONING_PANEL_QUEUE_MAX = 6;

function getReasoningPanelFollowUpQueueForIdx(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return [];
  let q = workModeReasoningPanelFollowUpQueue.get(idx);
  if (!Array.isArray(q)) {
    q = [];
    workModeReasoningPanelFollowUpQueue.set(idx, q);
  }
  return q;
}

function newReasoningPanelQueueItemId() {
  return `wmq-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
}

function getReasoningPanelElementByLaneIdx(laneIdx) {
  return document.querySelector(
    `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${Number(laneIdx)}"]`
  );
}

function renderReasoningPanelFollowUpQueueUi(laneIdx) {
  const panel = getReasoningPanelElementByLaneIdx(laneIdx);
  if (!(panel instanceof HTMLElement)) return;
  const queue = getReasoningPanelFollowUpQueueForIdx(laneIdx);
  let host = panel.querySelector(":scope > .vera-reasoning-queue-host");
  if (!queue.length) {
    if (host) host.remove();
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.className = "vera-reasoning-queue-host";
    host.setAttribute("aria-live", "polite");
    panel.insertBefore(host, panel.firstChild);
  }
  const heading = document.createElement("div");
  heading.className = "vera-reasoning-queue-heading";
  heading.textContent = `Queued (${queue.length})`;
  const list = document.createElement("ol");
  list.className = "vera-reasoning-queue-list";
  queue.forEach((item) => {
    const li = document.createElement("li");
    li.className = "vera-reasoning-queue-item";
    li.dataset.queueItemId = String(item.id || "");

    const textWrap = document.createElement("div");
    textWrap.className = "vera-reasoning-queue-item-text";
    textWrap.textContent = String(item.text || "");

    const actions = document.createElement("div");
    actions.className = "vera-reasoning-queue-item-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "vera-reasoning-queue-btn vera-reasoning-queue-btn--edit";
    editBtn.textContent = "edit";
    editBtn.title = "Edit this queued follow-up";
    editBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      beginEditReasoningPanelQueueItem(laneIdx, item.id);
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "vera-reasoning-queue-btn vera-reasoning-queue-btn--delete";
    delBtn.textContent = "delete";
    delBtn.title = "Remove this queued follow-up";
    delBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      deleteReasoningPanelQueueItem(laneIdx, item.id);
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(textWrap);
    li.appendChild(actions);
    list.appendChild(li);
  });
  host.replaceChildren(heading, list);
}

function enqueueReasoningPanelFollowUp(laneIdx, text, opts = {}) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return null;
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  if (queue.length >= REASONING_PANEL_QUEUE_MAX) {
    try {
      console.warn("[QUEUE_DEBUG][enqueue_rejected]", {
        panel_id: idx,
        reason: "panel_queue_max",
        queue_length: queue.length,
        max: REASONING_PANEL_QUEUE_MAX
      });
    } catch (_) {}
    return null;
  }
  const panel = getReasoningPanelElementByLaneIdx(idx);
  const panelLabel =
    (panel instanceof HTMLElement && getReasoningTabTopicLabel(panel)) ||
    getWorkModeReasoningLaneLabel(idx) ||
    `Panel ${idx + 1}`;
  const item = {
    id: newReasoningPanelQueueItemId(),
    text: trimmed,
    opts: { ...(opts || {}) },
    createdAt: Date.now(),
    panelLabel
  };
  queue.push(item);
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][enqueue]", {
      panel_id: idx,
      panel_title: panelLabel,
      queued_text: trimmed.slice(0, 160),
      queue_length_after: queue.length
    });
  } catch (_) {}
  return item;
}

function deleteReasoningPanelQueueItem(laneIdx, itemId) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return false;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  const beforeLen = queue.length;
  const next = queue.filter((it) => it.id !== itemId);
  if (next.length === beforeLen) return false;
  workModeReasoningPanelFollowUpQueue.set(idx, next);
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][delete]", {
      panel_id: idx,
      queue_item_id: itemId,
      queue_length_after: next.length
    });
  } catch (_) {}
  return true;
}

function editReasoningPanelQueueItem(laneIdx, itemId, newText) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return false;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  const target = queue.find((it) => it.id === itemId);
  if (!target) return false;
  const nextText = String(newText || "").trim();
  if (!nextText) {
    deleteReasoningPanelQueueItem(idx, itemId);
    return true;
  }
  const oldText = target.text;
  if (oldText === nextText) {
    renderReasoningPanelFollowUpQueueUi(idx);
    return false;
  }
  target.text = nextText;
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][edit]", {
      panel_id: idx,
      queue_item_id: itemId,
      old_text: String(oldText || "").slice(0, 160),
      new_text: nextText.slice(0, 160)
    });
  } catch (_) {}
  return true;
}

function beginEditReasoningPanelQueueItem(laneIdx, itemId) {
  const panel = getReasoningPanelElementByLaneIdx(laneIdx);
  if (!(panel instanceof HTMLElement)) return;
  const li = panel.querySelector(
    `.vera-reasoning-queue-item[data-queue-item-id="${itemId}"]`
  );
  if (!(li instanceof HTMLElement)) return;
  const textEl = li.querySelector(".vera-reasoning-queue-item-text");
  if (!(textEl instanceof HTMLElement)) return;
  if (li.classList.contains("is-editing")) return;
  li.classList.add("is-editing");
  const oldText = textEl.textContent || "";
  const input = document.createElement("textarea");
  input.className = "vera-reasoning-queue-edit-input";
  input.rows = 2;
  input.value = oldText;
  textEl.replaceWith(input);
  input.focus();
  input.select();
  const finish = (commit) => {
    if (!li.classList.contains("is-editing")) return;
    li.classList.remove("is-editing");
    if (commit) {
      editReasoningPanelQueueItem(laneIdx, itemId, input.value);
    } else {
      renderReasoningPanelFollowUpQueueUi(laneIdx);
    }
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function scheduleReasoningPanelFollowUpQueueDrain(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return;
  window.setTimeout(() => drainReasoningPanelFollowUpQueue(idx), 0);
}

async function drainReasoningPanelFollowUpQueue(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return;
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  if (workModeReasoningLaneBusy.get(idx) === true) return;
  const queue = getReasoningPanelFollowUpQueueForIdx(idx);
  if (!queue.length) return;
  const next = queue.shift();
  workModeReasoningPanelFollowUpQueue.set(idx, queue);
  renderReasoningPanelFollowUpQueueUi(idx);
  try {
    console.info("[QUEUE_DEBUG][dequeue_run]", {
      panel_id: idx,
      queue_item_id: next?.id || null,
      text: String(next?.text || "").slice(0, 160),
      queue_length_after: queue.length
    });
  } catch (_) {}
  // Switch to the originating panel so the frozen turn context picks the
  // right lane. The user can switch back manually after; this guarantees
  // the queued follow-up runs in the panel where it was queued.
  try {
    const activeIdxNow = getActiveReasoningLaneIndex();
    if (activeIdxNow !== idx && typeof activateReasoningTab === "function") {
      activateReasoningTab(idx);
    }
  } catch (_) {}
  try {
    await sendVeraWorkModeTypedInferTurn(next.text, {
      ...(next.opts || {}),
      __fromReasoningPanelQueue: true,
      __reasoningPanelQueueLaneIdx: idx
    });
  } catch (err) {
    try {
      console.warn("[QUEUE_DEBUG][dequeue_run_error]", {
        panel_id: idx,
        queue_item_id: next?.id || null,
        error: String((err && err.message) || err || "")
      });
    } catch (_) {}
  }
}

function clearReasoningPanelFollowUpQueueForIdx(laneIdx) {
  const idx = Number(laneIdx);
  if (!Number.isFinite(idx)) return;
  workModeReasoningPanelFollowUpQueue.delete(idx);
  renderReasoningPanelFollowUpQueueUi(idx);
}

window.workModeReasoningPanelQueue = {
  enqueue: enqueueReasoningPanelFollowUp,
  delete: deleteReasoningPanelQueueItem,
  edit: editReasoningPanelQueueItem,
  render: renderReasoningPanelFollowUpQueueUi,
  drain: drainReasoningPanelFollowUpQueue,
  clear: clearReasoningPanelFollowUpQueueForIdx,
  list: (laneIdx) =>
    getReasoningPanelFollowUpQueueForIdx(laneIdx).map((it) => ({ ...it }))
};

/* =============================================================================
 * STAGE 13 EXTRACTION (2026-05-31): MOVE LATEST VOICE RESULT -> REASONING PANEL
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js L5217..L5436 (220 LF-terminated source lines,
 * re-terminated as CRLF here to match this file's native line endings).
 * The block implements the "do that in the panel" / "put that in reasoning" /
 * "make a panel for that" handler that lifts the latest Voice UI assistant
 * answer into a reasoning panel: an existing one if topic similarity is high
 * (>= REASONING_PANEL_ROUTE_REUSE_FLOOR, defined in app.js), otherwise a
 * brand-new panel.
 *
 * Symbols moved (all kept at the file's top-level so classic-script global
 * bare-identifier visibility is preserved):
 *   - MOVE_LATEST_VOICE_TASK_TO_REASONING_RE     (regex const)
 *   - detectMoveLatestVoiceTaskToReasoningIntent (intent detector)
 *   - collectLatestRelevantVoiceAssistantOutput  (DOM scrape, newest VERA bubble)
 *   - inferVoiceTaskPanelTitle                   (heuristic panel-title chooser)
 *   - buildMovedVoiceTaskMarkdown                (markdown body builder)
 *   - findRelatedReasoningLaneForVoiceTask       (existing-lane similarity match)
 *   - logMoveLatestVoiceTaskToReasoningDebug     ([MOVE_LATEST_VOICE_TASK_TO_REASONING_DEBUG] log)
 *   - maybeHandleMoveLatestVoiceTaskToReasoning  (async entry point)
 *
 * Intentionally LEFT in app.js per Patch A-3 scope: infer pipeline,
 * handleUtterance, voice/TTS/audio code (incl. playWorkModeTtsOnlyPhrase),
 * Work Mode TTS queue, reasoning gate, checklist logic, music logic. The
 * playWorkModeTtsOnlyPhrase call inside maybeHandleMoveLatestVoiceTaskToReasoning
 * is preserved as a bare-identifier call into app.js.
 *
 * External call sites (all in app.js, all resolve at call time):
 *   - app.js: 4 await maybeHandleMoveLatestVoiceTaskToReasoning(...) sites
 *     in the typed-input and voice/ASR handlers.
 *   - app.js: 2 detectMoveLatestVoiceTaskToReasoningIntent(s).matched gates.
 *
 * Debug log marker [MOVE_LATEST_VOICE_TASK_TO_REASONING_DEBUG] is preserved
 * byte-identically.
 * ============================================================================= */

/* =========================
   MOVE LATEST VOICE RESULT → REASONING PANEL

   Important distinction:
     - "go back to the English essay panel" = panel navigation.
     - "put that in the panel" / "do that in reasoning" = move the latest
       Voice UI answer/task into reasoning. "that" is a task reference, not a
       panel title.
========================= */
const MOVE_LATEST_VOICE_TASK_TO_REASONING_RE =
  /\b(?:do|put|move|show|open|copy|send|transfer|continue|expand|make)\s+(?:that|this|it|the\s+(?:email|draft|answer|response|reply|version|full\s+version))\s+(?:in|into|to|on)\s+(?:the\s+)?(?:reasoning(?:\s+(?:panel|space|tab))?|panel|space|tab)\b|\b(?:make|create|open|start)\s+(?:a\s+)?(?:reasoning\s+)?panel\s+for\s+(?:that|this|it|the\s+(?:email|draft|answer|response|reply))\b|\b(?:can\s+you|could\s+you|please)\s+(?:do|put|move|show|open|copy|send|transfer|continue|expand)\s+(?:that|this|it|the\s+(?:email|draft|answer|response|reply|version|full\s+version))\s+(?:in|into|to|on)\s+(?:the\s+)?(?:reasoning(?:\s+(?:panel|space|tab))?|panel|space|tab)\b|\b(?:put|show)\s+(?:the\s+)?(?:email|draft|answer|response|reply|full\s+version)\s+(?:in|into|to|on)\s+(?:the\s+)?(?:reasoning(?:\s+(?:panel|space|tab))?|panel|space|tab)\b/i;

function detectMoveLatestVoiceTaskToReasoningIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return { matched: false, deictic: false };
  const matched = MOVE_LATEST_VOICE_TASK_TO_REASONING_RE.test(raw);
  return {
    matched,
    deictic: /\b(that|this|it|there)\b/i.test(raw)
  };
}

function collectLatestRelevantVoiceAssistantOutput(maxChars = 6000) {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return "";
  const convo = document.getElementById("vera-conversation");
  if (!(convo instanceof HTMLElement)) return "";
  const rows = [...convo.querySelectorAll(".message-row")];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row?.classList?.contains("vera")) continue;
    const bubble = row.querySelector(".bubble");
    if (!(bubble instanceof HTMLElement)) continue;
    if (
      bubble.classList.contains("vera-work-mode-stage1-ack") ||
      bubble.classList.contains("vera-pending-status") ||
      bubble.classList.contains("interrupt-preview")
    ) {
      continue;
    }
    const text = String(bubble.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 12) continue;
    if (/^I(?:'ll| will)\s+work\b/i.test(text)) continue;
    if (/^Done\s+[—-]\s+I (?:put|moved|created)\b/i.test(text)) continue;
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return "";
}

function inferVoiceTaskPanelTitle({ latestVoiceOutput = "", recentVoiceContext = "", latestUserText = "" } = {}) {
  const hay = `${latestUserText}\n${latestVoiceOutput}\n${recentVoiceContext}`.toLowerCase();
  if (/\b(ticket|traffic\s+stop|pulled\s+over|police|officer|complain|complaint|dispute|citation)\b/.test(hay)) {
    if (/\b(email|draft|letter|message)\b/.test(hay)) return "Ticket Complaint Email";
    return "Police Ticket Review";
  }
  if (/\b(homework|assignment|essay|teacher|professor|extension|deadline)\b/.test(hay) && /\b(email|draft|letter|message)\b/.test(hay)) {
    return "Homework Extension Email";
  }
  if (/\b(resume|résumé|cv)\b/.test(hay) && /\b(bullet|revision|rewrite|edit)\b/.test(hay)) {
    return "Resume Bullet Revisions";
  }
  if (/\b(travel|trip|itinerary|flight|hotel|vacation)\b/.test(hay)) return "Travel Plan";
  if (/\b(email|draft|letter|message)\b/.test(hay)) return "Email Draft";
  if (/\b(plan|schedule|timeline|roadmap)\b/.test(hay)) return "Planning Draft";
  const tokens = topicTokensForWorkModeTopic(`${latestVoiceOutput} ${recentVoiceContext}`)
    .filter((w) => !/^(assistant|user|would|could|should|there|their|about)$/.test(w))
    .slice(0, 4);
  if (tokens.length) return tokens.map(toTitleCaseWord).join(" ");
  return "Voice Answer";
}

function buildMovedVoiceTaskMarkdown({ title, latestVoiceOutput, recentVoiceContext } = {}) {
  const t = String(title || "Voice Answer").trim();
  const out = String(latestVoiceOutput || "").trim();
  const ctx = String(recentVoiceContext || "").trim();
  const contextLines = ctx
    .split(/\n+/)
    .filter((line) => /^User:\s*/i.test(line))
    .slice(-3)
    .map((line) => line.replace(/^User:\s*/i, "").trim())
    .filter(Boolean);
  const contextBlock = contextLines.length
    ? contextLines.map((line) => `- ${line}`).join("\n")
    : "- Moved from the recent Voice UI conversation.";
  return [
    `# ${t}`,
    "",
    "## Context",
    contextBlock,
    "",
    "## Draft / Answer From Voice UI",
    out || "_I could not find a recent Voice UI answer to move._",
    "",
    "## Notes",
    "If you want, I can revise this here with a firmer, more formal, or shorter version."
  ].join("\n");
}

function findRelatedReasoningLaneForVoiceTask(seedText) {
  const seed = String(seedText || "").trim();
  if (!seed) return { laneIdx: null, score: 0, title: "" };
  let best = { laneIdx: null, score: 0, title: "" };
  for (const idx of getReasoningPanelIndices()) {
    const panel = getReasoningPanelElementByLaneIdx(idx);
    const title = panel instanceof HTMLElement ? getReasoningTabTopicLabel(panel) : "";
    const excerpt = collectWorkModeReasoningExcerptForLaneIndex(idx, 1200);
    const score = Math.max(
      topicSimilarityScore(seed, `${title} ${excerpt}`),
      topicCoverageScore(seed, `${title} ${excerpt}`)
    );
    if (score > best.score) best = { laneIdx: idx, score, title };
  }
  return best;
}

function logMoveLatestVoiceTaskToReasoningDebug(payload) {
  try {
    console.warn("[MOVE_LATEST_VOICE_TASK_TO_REASONING_DEBUG]", payload);
  } catch (_) {}
}

async function maybeHandleMoveLatestVoiceTaskToReasoning(trimmed, opts = {}) {
  const text = String(trimmed || "").trim();
  const intent = detectMoveLatestVoiceTaskToReasoningIntent(text);
  if (!intent.matched || !isVeraWorkModeOn() || appModePrefix() !== "vera") return false;

  const latestVoiceOutput = collectLatestRelevantVoiceAssistantOutput(7000);
  const recentVoiceContext = collectWorkModeVoiceExcerptForContext(2500, 8);
  const activeIdx = getActiveReasoningLaneIndex();
  const activePanel = activeIdx != null ? getReasoningPanelElementByLaneIdx(activeIdx) : null;
  const activePanelTitle = activePanel instanceof HTMLElement ? getReasoningTabTopicLabel(activePanel) : "";

  if (!latestVoiceOutput) {
    const reply = "Do you want me to move the latest answer into a new panel, or switch to an existing panel?";
    commitServerUserTranscriptBubble(text, opts.path || "move-voice-task-unresolved");
    addBubble(reply, "vera", { path: "move-latest-voice-task-clarify" });
    logMoveLatestVoiceTaskToReasoningDebug({
      latest_user_text: text.slice(0, 240),
      detected_intent: "move_latest_voice_task_to_reasoning",
      deictic_reference_detected: intent.deictic,
      deictic_resolution: "unresolved",
      latest_voice_output_excerpt: "",
      recent_voice_context_excerpt: recentVoiceContext.slice(0, 240),
      active_panel_title: activePanelTitle,
      selected_panel_id: null,
      create_new_panel: false,
      new_panel_title: "",
      reason_for_decision: "no_recent_voice_assistant_output"
    });
    return true;
  }

  const title = inferVoiceTaskPanelTitle({ latestVoiceOutput, recentVoiceContext, latestUserText: text });
  const seedText = `${title}\n${latestVoiceOutput}\n${recentVoiceContext}`;
  const related = findRelatedReasoningLaneForVoiceTask(seedText);
  const reuseExisting = related.laneIdx != null && related.score >= REASONING_PANEL_ROUTE_REUSE_FLOOR;
  const laneIdx = reuseExisting
    ? await acquireWorkModeReasoningLaneForIndex(related.laneIdx)
    : await acquireWorkModeReasoningLane(seedText);
  const laneId = getWorkModeReasoningLaneId(laneIdx);
  const panel = getReasoningPanelElementByLaneIdx(laneIdx);
  const scrollEl = getReasoningScrollElByLane(laneIdx);
  const markdown = buildMovedVoiceTaskMarkdown({ title, latestVoiceOutput, recentVoiceContext });

  try {
    activateReasoningTab(laneIdx);
    if (panel instanceof HTMLElement) {
      panel.dataset.laneLabel = title;
      panel.dataset.tabTopic = title;
      panel.dataset.tabTopicSet = "1";
      panel.dataset.reasoningLlmTitleDone = "1";
    }
    try {
      if (laneId) patchReasoningLaneRegistryTitle(laneId, title, "move_latest_voice_task_to_reasoning");
    } catch (_) {}
    laneTopicSeedByIdx[laneIdx] = seedText;
    laneReasoningTurnCountByIdx[laneIdx] = (laneReasoningTurnCountByIdx[laneIdx] ?? 0) + 1;
    const turnEl = appendReasoningTurnMount(scrollEl);
    if (turnEl) {
      turnEl.dataset.markdownAcc = markdown;
      turnEl.dataset.summaryText = "";
      renderWorkModeMarkdown(turnEl, markdown, "");
      maybeReasoningScrollToLatest(scrollEl);
      scheduleSyncPlanButtonRefresh(0);
    }
    renderReasoningTabStrip();
    persistReasoningTabsState();
  } finally {
    endWorkModeReasoningLaneRun(laneIdx);
  }

  const itemKind = /\b(email|subject:|dear\s+)/i.test(latestVoiceOutput) ? "email draft" : "answer";
  const reply = reuseExisting
    ? `Done — I moved the ${itemKind} into the reasoning panel.`
    : `Done — I put the ${itemKind} in a new reasoning panel.`;
  commitServerUserTranscriptBubble(text, opts.path || "move-latest-voice-task");
  addBubble(reply, "vera", { path: "move-latest-voice-task-success" });
  if (opts.isVoice) {
    try {
      await playWorkModeTtsOnlyPhrase(reply, opts.signal);
    } catch (_) {}
  }
  setStatus("Ready", "idle");
  logMoveLatestVoiceTaskToReasoningDebug({
    latest_user_text: text.slice(0, 240),
    detected_intent: "move_latest_voice_task_to_reasoning",
    deictic_reference_detected: intent.deictic,
    deictic_resolution: "latest_voice_output",
    latest_voice_output_excerpt: latestVoiceOutput.slice(0, 240),
    recent_voice_context_excerpt: recentVoiceContext.slice(0, 240),
    active_panel_title: activePanelTitle,
    selected_panel_id: laneId || null,
    selected_panel_index: laneIdx,
    create_new_panel: !reuseExisting,
    new_panel_title: title,
    related_panel_score: Number((related.score || 0).toFixed(3)),
    reason_for_decision: reuseExisting ? "existing_related_panel_high_similarity" : "no_related_panel_create_new"
  });
  return true;
}

/* =============================================================================
 * STAGE 20 EXTRACTION (2026-05-31): WORK MODE REASONING STREAM + TAB CONSTANTS
 * -----------------------------------------------------------------------------
 * Verbatim move from app.js (the "WORK MODE - layout + reasoning stream +
 * checklist" section). 4 constants moved from app.js L6172..L6175 and 1,055
 * lines of functions moved from app.js L6311..L7365 (re-terminated as CRLF
 * here to match this file's native line endings).
 *
 * Stage 8 (2026-05-27) extracted the reasoning-panel DOM/UI helpers
 * (createReasoningLanePanel, renderReasoningTabStrip, etc.) but deliberately
 * LEFT the per-tab constants and the tab-state persistence helpers in app.js
 * because at that time panels.js loaded BEFORE app.js and top-level
 * `const X = REASONING_TABS_DEFAULT;` in panels.js would have hit TDZ. Stage
 * 20 completes the move: every reasoning-stream / tab-title / persistence
 * symbol now lives in this file. The Stage 8 "Inlined literal" comment near
 * MIN_REASONING_PANELS describes the historical constraint; that constraint
 * no longer applies to constants declared in this stage, but
 * MIN_REASONING_PANELS = 3 stays as a literal for byte-identity.
 *
 * Constants moved (placed first so any top-level code in this file that
 * references them at parse time would resolve cleanly -- in practice all
 * references in this file are inside function bodies, so call-time lookup
 * already worked):
 *   - const REASONING_TABS_DEFAULT = 3
 *   - const REASONING_TABS_MAX = 8
 *   - const REASONING_UNTITLED_TAB_NAME = "Untitled"
 *   - const REASONING_TABS_STATE_STORAGE_KEY_PREFIX = "vera_reasoning_tabs_state_v2"
 *
 * Function declarations moved (33 total; verbatim from app.js, function
 * declarations hoist within this file so inter-function call order does not
 * matter):
 *   tab-state / ensure / restore:
 *     getReasoningTabsStateStorageKey, getReasoningPanelCountToEnsure,
 *     getReasoningPanelIndices, syncReasoningLaneBusySlotsAfterDomChange,
 *     ensureFixedReasoningLanePanels, persistReasoningTabsState,
 *     restoreReasoningTabsState
 *   reasoning stream / scroll mount:
 *     getActiveReasoningScrollEl, appendReasoningTurnMount
 *   title heuristics + extraction:
 *     toTitleCaseWord, isBanalReasoningTopicLabel, compactTopicPhrase,
 *     keywordTopicFromText, extractMarkdownBoldStandaloneTitle,
 *     extractFirstTitleLikeMarkdownLine, normalizeMarkdownLeadForHeadingExtract,
 *     diagnoseLeadingMarkdownHeadingExtraction,
 *     extractLeadingMarkdownHeadingAsLaneTitle, logHeadingTitleExtractAttempt,
 *     maybeSyncGenericLaneTitleFromMarkdown, buildReasoningTopicLabel,
 *     readPersistedReasoningTabSnapshotForLane
 *   debug-log helpers:
 *     reasoningTitleCandidateDebugLog, reasoningTitleUpdateDebugLog,
 *     reasoningLaneTitleSyncDebugLog, reasoningLlmTitleQueueDecision
 *   tab-topic application + LLM/heuristic fallback:
 *     setReasoningTabTopicFromFinal, sanitizeLlmReasoningPanelTitle,
 *     veraWorkModeBackendBasesInTryOrder, fetchReasoningPanelTitleLlm,
 *     heuristicReasoningPanelTitle, shouldQueueLlmReasoningPanelTitle,
 *     queueLlmReasoningPanelTitleAfterFirstCompletedTurn
 *
 * Intentionally LEFT in app.js per Patch A-4 scope:
 *   - VERA chat-state persistence: ensureVeraSessionIdForPersistence,
 *     getVeraChatStateStorageKey, migrateLegacyVeraChatStorageKey,
 *     persistVeraClientStateOnUnload, persistVeraChatState,
 *     restoreVeraChatState (these handle the main conversation bubble
 *     store, not the reasoning stream).
 *   - State: chatStateHydrating (let).
 *   - Constants: WORK_MODE_STATE_TTL_MS, VERA_CHAT_STATE_STORAGE_KEY_PREFIX
 *     (consumed by chat-state restore), VERA_TAB_ACTIVE_USER_KEY
 *     (consumed by user-tab activation in another section),
 *     WORK_LEFT_PANES_LAYOUT_KEY (consumed by setWorkModeLeftPaneLayout
 *     in the next section, which is out of scope for Patch A-4).
 *   - Infer pipeline, handleUtterance, Work Mode TTS queue, voice/TTS/
 *     audio code, multi-action planner, reasoning gate, music logic
 *     (all explicit "Do not move" items in the patch hard rules).
 *
 * External bare-identifier references still resolved via shared global
 * lexical env at call time:
 *   - addBubble, mergeReplyBackIntoBubbleMeta, ensureChatStartedLayout
 *     stay in app.js and are called from moved code at runtime.
 *   - workModeReasoningLaneBusy (Map), workModeReasoningAbortControllers
 *     (Set/Map), getSessionId, VERA_SESSION_STORAGE_KEY all stay in their
 *     existing files.
 *   - syncWorkModeReasoningCancelButton + the Stage 8 panels.js helpers
 *     are now intra-file calls (same lexical scope) for moved code.
 *
 * Hard-rule preservation (Patch A-4):
 *   - Constants preserved byte-identically (3, 8, "Untitled",
 *     "vera_reasoning_tabs_state_v2").
 *   - Console log keys [reasoning_title_candidate_debug],
 *     [reasoning_title_update_debug], [reasoning_lane_title_sync_debug],
 *     [reasoning_llm_title_queue_decision] preserved byte-identically.
 *   - LLM fetch URL paths preserved.
 *   - DOM IDs / selectors (vera-reasoning-tab-panels,
 *     .vera-reasoning-tab-panel, .vera-reasoning-md-panel) preserved.
 *   - Heuristic word-list / banal-label / generic-noun arrays preserved.
 *   - Function names + signatures preserved.
 * ============================================================================= */

const REASONING_TABS_DEFAULT = 3;
const REASONING_TABS_MAX = 8;
const REASONING_UNTITLED_TAB_NAME = "Untitled";
const REASONING_TABS_STATE_STORAGE_KEY_PREFIX = "vera_reasoning_tabs_state_v2";

function getReasoningTabsStateStorageKey() {
  return `${REASONING_TABS_STATE_STORAGE_KEY_PREFIX}:${getSessionId()}`;
}

function getReasoningPanelCountToEnsure(savedByIdx) {
  if (!(savedByIdx instanceof Map) || savedByIdx.size === 0) return REASONING_TABS_DEFAULT;
  let maxIdx = -1;
  for (const k of savedByIdx.keys()) {
    const n = Number(k);
    if (Number.isFinite(n)) maxIdx = Math.max(maxIdx, n);
  }
  if (maxIdx < 0) return REASONING_TABS_DEFAULT;
  return Math.min(REASONING_TABS_MAX, Math.max(REASONING_TABS_DEFAULT, maxIdx + 1));
}

function getReasoningPanelIndices() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return [0, 1, 2];
  const idxs = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")]
    .map((p) => Number(p.dataset.tabIndex))
    .filter((n) => Number.isFinite(n));
  if (!idxs.length) return [0, 1, 2];
  return idxs.sort((a, b) => a - b);
}

/** After panels are added/removed/rebuilt, keep busy flags aligned with `data-tab-index` keys. */
function syncReasoningLaneBusySlotsAfterDomChange() {
  const idxs = getReasoningPanelIndices();
  const next = new Map();
  for (const i of idxs) {
    next.set(i, Boolean(workModeReasoningLaneBusy.get(i)));
  }
  workModeReasoningLaneBusy.clear();
  for (const [k, v] of next) workModeReasoningLaneBusy.set(k, v);
  syncWorkModeReasoningCancelButton();
}

/* getWorkModeReasoningLaneLabel, getWorkModeReasoningLaneId,
 * createReasoningLanePanel → moved to workmode/panels.js
 * (Stage 8, 2026-05-27). */

function ensureFixedReasoningLanePanels(savedByIdx = new Map(), activeIdx = 0) {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const count = getReasoningPanelCountToEnsure(savedByIdx);
  panelsRoot.replaceChildren();
  for (let i = 0; i < count; i++) {
    const saved = savedByIdx.get(i) || {};
    const isActive = Number(activeIdx) === i || (i === 0 && (activeIdx == null || activeIdx === ""));
    const panel = createReasoningLanePanel(i, saved.html || "", isActive, {
      topic: saved.topic,
      topicSet: saved.topicSet,
      laneLabel: saved.laneLabel,
      laneId: saved.laneId
    });
    panelsRoot.appendChild(panel);
  }
  syncPanelStableLaneIdsInDom();
  migrateLegacyLaneRegistryKeys();
  syncReasoningLaneBusySlotsAfterDomChange();
}

/* getReasoningScrollElByLane → moved to workmode/panels.js
 * (Stage 8, 2026-05-27). */

/** Snapshot reasoning tabs to localStorage — call only on page unload (see wireReasoningTabStrip). */
function persistReasoningTabsState() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  const panels = [...panelsRoot.querySelectorAll(".vera-reasoning-tab-panel")];
  const payload = {
    ts: Date.now(),
    tabs: panels.map((p) => ({
      idx: Number(p.dataset.tabIndex) || 0,
      laneId: String(p.dataset.laneId || "").trim() || ensureStableLaneIdForPanelIndex(Number(p.dataset.tabIndex) || 0),
      topic: String(p.dataset.tabTopic || REASONING_UNTITLED_TAB_NAME),
      topicSet: String(p.dataset.tabTopicSet || "0"),
      laneLabel: String(p.dataset.laneLabel || "").trim(),
      active: p.classList.contains("is-active"),
      html: (p.querySelector(".vera-reasoning-md-panel") || p.querySelector(".vera-reasoning-scroll"))?.innerHTML || ""
    }))
  };
  try {
    localStorage.setItem(getReasoningTabsStateStorageKey(), JSON.stringify(payload));
  } catch (_) {}
}

function restoreReasoningTabsState() {
  const panelsRoot = document.getElementById("vera-reasoning-tab-panels");
  if (!panelsRoot) return;
  let raw = "";
  try {
    raw = localStorage.getItem(getReasoningTabsStateStorageKey()) || "";
  } catch (_) {
    return;
  }
  if (!raw) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs.slice(0, REASONING_TABS_MAX) : [];
  initWorkModeStableLaneIdSlots();
  if (!tabs.length) {
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const ts = Number(parsed?.ts) || 0;
  if (!ts || Date.now() - ts > WORK_MODE_STATE_TTL_MS) {
    try {
      localStorage.removeItem(getReasoningTabsStateStorageKey());
    } catch (_) {}
    ensureFixedReasoningLanePanels(new Map(), 0);
    return;
  }
  const savedByIdx = new Map();
  let activeIdx = 0;
  tabs.forEach((t) => {
    const idx = Number(t?.idx);
    if (!Number.isFinite(idx) || idx < 0 || idx >= REASONING_TABS_MAX) return;
    if (Boolean(t?.active)) activeIdx = idx;
    const laneId = String(t?.laneId || "").trim() || ensureStableLaneIdForPanelIndex(idx);
    if (laneId) workModeStableLaneIdByIdx[idx] = laneId;
    savedByIdx.set(idx, {
      html: String(t?.html || ""),
      topic: String(t?.topic || REASONING_UNTITLED_TAB_NAME),
      topicSet: String(t?.topicSet != null ? t.topicSet : "0"),
      laneLabel: String(t?.laneLabel || "").trim() || undefined,
      laneId
    });
  });
  ensureFixedReasoningLanePanels(savedByIdx, activeIdx);
}

function getActiveReasoningScrollEl() {
  const p = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active .vera-reasoning-md-panel");
  if (p) return p;
  return document.getElementById("vera-reasoning-md");
}

/** Each assistant reasoning run appends a new block inside the active space (scroll container). */
function appendReasoningTurnMount(scrollEl) {
  let el = scrollEl;
  if (!el) {
    el = document.getElementById("vera-reasoning-md");
    if (!el) return null;
  }
  if (el.querySelector(".vera-reasoning-turn")) {
    const sep = document.createElement("div");
    sep.className = "vera-reasoning-turn-sep";
    const hr = document.createElement("hr");
    hr.className = "vera-reasoning-turn-hr";
    hr.setAttribute("aria-hidden", "true");
    sep.appendChild(hr);
    el.appendChild(sep);
  }
  const turn = document.createElement("div");
  turn.className = "vera-reasoning-turn";
  el.appendChild(turn);
  return turn;
}

/** Tab / panel titles safe to replace with LLM or heuristic (user-defined titles stay). */
/* isGenericAutoRenamableReasoningPanelTitle + getReasoningTabTopicLabel
 * → moved to workmode/panels.js (Stage 8, 2026-05-27). */

function toTitleCaseWord(w) {
  if (!w) return "";
  if (/^[A-Z0-9]{2,}$/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/** Skip headings / tab titles that are generic assistant filler, not the task topic. */
function isBanalReasoningTopicLabel(s) {
  const t = String(s || "")
    .toLowerCase()
    .replace(/[—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return true;
  if (/^(yes|yeah|yep|sure|ok|okay|absolutely)\b/.test(t)) return true;
  if (/\b(i can help|i'll help|i will help|happy to help|let me help|here to help)\b/.test(t)) return true;
  if (/\b(work through it|help you work|walk you through)\b/.test(t) && t.split(/\s+/).length <= 8) return true;
  return false;
}

function compactTopicPhrase(text, maxWords = 4) {
  const raw = String(text || "")
    .replace(/[`*_#>[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const withoutLead = raw
    .replace(/^(here(?:'s| is)\s+)?(?:an?\s+)?(?:short\s+)?example(?:\s+of)?[:\-\s]*/i, "")
    .trim();
  const candidate = withoutLead || raw;
  const words = candidate.match(/[A-Za-z0-9][A-Za-z0-9'+-]*/g) || [];
  if (!words.length) return "";
  const badEdge = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "being", "been", "to", "of", "and", "or",
    "for", "with", "in", "on", "at", "from", "by", "as", "that", "this"
  ]);
  let start = 0;
  let end = words.length;
  while (start < end && badEdge.has(words[start].toLowerCase())) start += 1;
  while (end > start && badEdge.has(words[end - 1].toLowerCase())) end -= 1;
  const core = words.slice(start, end).slice(0, maxWords);
  if (!core.length) return "";
  const out = core.map((w) => toTitleCaseWord(w)).join(" ");
  if (isBanalReasoningTopicLabel(out)) return "";
  return out;
}

function keywordTopicFromText(text, maxWords = 4) {
  const tokens = (String(text || "").toLowerCase().match(/[a-z][a-z0-9'+-]*/g) || []);
  if (!tokens.length) return "";
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "show", "example",
    "short", "here", "there", "what", "when", "where", "which", "about", "have", "has", "had", "can",
    "could", "would", "should", "step", "steps", "then", "than", "just", "more", "most", "some", "any",
    "using", "use", "used", "also", "very", "much", "into", "onto", "over", "under",
    "yes", "yeah", "yep", "sure", "help", "i'll", "okay", "ok"
  ]);
  const counts = new Map();
  const firstPos = new Map();
  tokens.forEach((t, i) => {
    if (t.length < 3 || stop.has(t)) return;
    if (!firstPos.has(t)) firstPos.set(t, i);
    counts.set(t, (counts.get(t) || 0) + 1);
  });
  const ranked = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || ((firstPos.get(a[0]) || 0) - (firstPos.get(b[0]) || 0)))
    .slice(0, maxWords)
    .map(([t]) => toTitleCaseWord(t));
  return ranked.join(" ");
}

function extractMarkdownBoldStandaloneTitle(markdownText) {
  const lines = String(markdownText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^\*{2}([^*]+)\*{2}\s*$/);
    if (!m) continue;
    const inner = String(m[1] || "").trim();
    if (inner.length < 6 || inner.length > 160) continue;
    if (isBanalReasoningTopicLabel(inner)) continue;
    const t = compactTopicPhrase(inner, 6);
    if (t) return t;
  }
  return "";
}

/** First substantive non-heading, non-list line (e.g. "Delta-Hedging a Short 45-Strike Call"). */
function extractFirstTitleLikeMarkdownLine(markdownText) {
  const lines = String(markdownText || "").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) continue;
    if (/^>{1,3}\s+/.test(line)) continue;
    if (line.length < 12 || line.length > 160) continue;
    let cleaned = line.replace(/^\*{1,2}|\*{1,2}$/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
    if (cleaned.length < 12) continue;
    if (isBanalReasoningTopicLabel(cleaned)) continue;
    const t = compactTopicPhrase(cleaned, 10);
    if (t && t.length >= 6) return t;
  }
  return "";
}

function normalizeMarkdownLeadForHeadingExtract(markdown) {
  return String(markdown || "")
    .replace(/^\uFEFF/, "")
    .replace(/^[\u200B-\u200D\uFEFF]+/, "")
    .trimStart();
}

/**
 * First line / start of markdown begins with `#` → lane/tab title (handles heading + body on one line).
 * @returns {{ extracted_heading: string, extraction_rejected_reason: string, md_first_200: string, starts_with_hash: boolean }}
 */
function diagnoseLeadingMarkdownHeadingExtraction(markdown) {
  const mdNorm = normalizeMarkdownLeadForHeadingExtract(markdown);
  const md_first_200 = mdNorm.slice(0, 200);
  const starts_with_hash = mdNorm.startsWith("#");
  const fail = (reason) => ({
    extracted_heading: "",
    extraction_rejected_reason: reason,
    md_first_200,
    starts_with_hash
  });
  if (!mdNorm) return fail("empty_markdown");
  if (!starts_with_hash) return fail("does_not_start_with_hash_after_trimStart");
  const firstLine = mdNorm.split("\n")[0].trim();
  const m = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (!m) return fail("first_line_not_hash_heading_pattern");
  let rest = String(m[1] || "").trim();
  if (rest.includes(" ## ")) rest = rest.split(/\s+##\s+/)[0].trim();
  rest = rest.replace(/\s+#+\s*$/, "").trim();
  const mashLong = rest.match(
    /^(.+?)\s+The\s+[A-Z][a-z]+(?:\s+[a-zA-Z'’-]+){0,8}\s+(?:was|is|are|has|had|were|became)\b/i
  );
  if (mashLong) rest = mashLong[1].trim();
  else {
    const mashIt = rest.match(/^(.+?)\s+It\s+was\b/i);
    if (mashIt) rest = mashIt[1].trim();
    else {
      const mashDup = rest.match(/^(.+?)\s+The\s+(.+?)\s+(?:was|is|are)\b/i);
      if (mashDup) {
        const a = mashDup[1].trim().toLowerCase();
        const b = mashDup[2].trim().toLowerCase();
        if (b.startsWith(a) || a === b) rest = mashDup[1].trim();
      }
    }
  }
  rest = rest.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  rest = rest.replace(/\s+/g, " ").trim();
  if (rest.length < 2) return fail("heading_text_too_short_after_parse");
  let titled = rest;
  const wordCount = rest.split(/\s+/).filter(Boolean).length;
  if (wordCount > 8) {
    titled =
      compactTopicPhrase(rest, 6) ||
      rest
        .split(/\s+/)
        .slice(0, 6)
        .join(" ")
        .trim();
  }
  if (!titled || isBanalReasoningTopicLabel(titled)) return fail("banal_or_empty_topic_label");
  const out = sanitizeLlmReasoningPanelTitle(titled);
  if (!out) return fail("sanitizeLlmReasoningPanelTitle_empty");
  return {
    extracted_heading: out,
    extraction_rejected_reason: "",
    md_first_200,
    starts_with_hash: true
  };
}

function extractLeadingMarkdownHeadingAsLaneTitle(markdown) {
  return diagnoseLeadingMarkdownHeadingExtraction(markdown).extracted_heading || "";
}

function logHeadingTitleExtractAttempt(laneId, oldTitle, mdSource, markdown) {
  const diag = diagnoseLeadingMarkdownHeadingExtraction(markdown);
  try {
    console.info("[heading_title_extract_attempt]", {
      lane_id: laneId ?? null,
      old_title: String(oldTitle ?? ""),
      old_title_is_generic: isGenericAutoRenamableReasoningPanelTitle(oldTitle),
      md_source: mdSource,
      md_first_200: diag.md_first_200,
      starts_with_hash: diag.starts_with_hash,
      extracted_heading: diag.extracted_heading || "",
      extraction_rejected_reason: diag.extraction_rejected_reason || ""
    });
  } catch (_) {}
  return diag;
}

/**
 * If lane title is generic and markdown has a leading # heading, sync registry + tab DOM.
 * @returns {{ applied: boolean, allowed: boolean, reason: string, extracted_heading: string }}
 */
function maybeSyncGenericLaneTitleFromMarkdown(laneId, markdown, calledFrom) {
  const lid = String(laneId || "").trim();
  const source = String(calledFrom || "maybeSyncGenericLaneTitleFromMarkdown").trim();
  const panel = lid ? getReasoningPanelElementByLaneId(lid) : null;
  const regBefore = lid ? getWorkModeLaneHandoff(lid) : null;
  const oldFromDom = panel instanceof HTMLElement ? String(getReasoningTabTopicLabel(panel) || "").trim() : "";
  const oldFromReg = String(regBefore?.title || regBefore?.lane_title || "").trim();
  const oldTitle = oldFromDom || oldFromReg || (lid ? getWorkModeLaneTitle(lid) : "");
  const before_registry_title = oldFromReg || oldTitle;

  const mdRaw = String(markdown || "").trim();
  const mdSource = mdRaw ? "main_excerpt" : "none";
  const diag = logHeadingTitleExtractAttempt(lid, oldTitle, mdSource, mdRaw);
  const extracted = diag.extracted_heading || "";

  let allowed = false;
  let reason = "not_attempted";
  if (!lid) reason = "no_lane_id";
  else if (!extracted) reason = diag.extraction_rejected_reason || "extract_empty";
  else if (!isGenericAutoRenamableReasoningPanelTitle(oldTitle)) {
    reason = "old_title_not_generic_auto_renamable";
  } else {
    allowed = true;
    reason = "heading_sync_apply";
  }

  let domSynced = false;
  let after_registry_title = before_registry_title;

  if (allowed && extracted) {
    const row = regBefore || { lane_id: lid, active_lane_id: lid };
    setWorkModeLaneHandoff(
      lid,
      {
        ...row,
        lane_id: lid,
        active_lane_id: lid,
        title: extracted,
        lane_title: extracted
      },
      { source: `heading_title_sync:${source}`, forceSubstantive: false }
    );
  }

  const regAfter = lid ? getWorkModeLaneHandoff(lid) : null;
  after_registry_title = String(regAfter?.title || regAfter?.lane_title || "").trim() || before_registry_title;

  const panelAfter = lid ? getReasoningPanelElementByLaneId(lid) : null;
  if (allowed && extracted && panelAfter instanceof HTMLElement) {
    panelAfter.dataset.laneLabel = extracted;
    panelAfter.dataset.tabTopic = extracted;
    panelAfter.dataset.tabTopicSet = "1";
    panelAfter.dataset.reasoningLlmTitleDone = "1";
    renderReasoningTabStrip();
    try {
      persistReasoningTabsState();
    } catch (_) {}
    domSynced = true;
  } else if (allowed && extracted && !(panelAfter instanceof HTMLElement)) {
    reason = `${reason};no_panel_dom`;
  }

  const tab_text_after =
    panelAfter instanceof HTMLElement ? String(getReasoningTabTopicLabel(panelAfter) || "").trim() : "(no_panel)";

  try {
    console.info("[heading_title_apply_attempt]", {
      lane_id: lid || null,
      old_title: oldTitle,
      extracted_heading: extracted || "",
      allowed,
      reason,
      before_registry_title,
      after_registry_title,
      dom_synced: domSynced,
      tab_text_after,
      panel_dataset_lane_label_after:
        panelAfter instanceof HTMLElement ? String(panelAfter.dataset.laneLabel || "").trim() : "",
      panel_dataset_tab_topic_after:
        panelAfter instanceof HTMLElement ? String(panelAfter.dataset.tabTopic || "").trim() : "",
      called_from: source
    });
  } catch (_) {}

  return {
    applied: allowed && Boolean(extracted) && after_registry_title === extracted,
    allowed,
    reason,
    extracted_heading: extracted
  };
}

function buildReasoningTopicLabel({ summaryText = "", markdownText = "", userPrompt = "" } = {}) {
  const md = String(markdownText || "");
  const headingLines = md
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim());
  for (const h of headingLines) {
    if (isBanalReasoningTopicLabel(h)) continue;
    const t = compactTopicPhrase(h, 4);
    if (t) return t;
  }
  const boldTitle = extractMarkdownBoldStandaloneTitle(md);
  if (boldTitle) return boldTitle;
  const firstLineTitle = extractFirstTitleLikeMarkdownLine(md);
  if (firstLineTitle) return firstLineTitle;
  const keywordTopic = keywordTopicFromText(`${summaryText}\n${markdownText}`, 4);
  if (keywordTopic && !isBanalReasoningTopicLabel(keywordTopic)) return keywordTopic;
  const summaryTopic = compactTopicPhrase(summaryText, 4);
  if (summaryTopic && !isBanalReasoningTopicLabel(summaryTopic)) return summaryTopic;
  const promptTopic = compactTopicPhrase(userPrompt, 4);
  if (promptTopic && !isBanalReasoningTopicLabel(promptTopic)) return promptTopic;
  return "";
}

function readPersistedReasoningTabSnapshotForLane(laneId, tabIndex) {
  let localStorage_laneLabel = "(unread)";
  let localStorage_topic = "(unread)";
  let localStorage_title = "(unread)";
  try {
    const raw = localStorage.getItem(getReasoningTabsStateStorageKey());
    if (!raw || !String(raw).trim()) {
      return { localStorage_laneLabel: "(none)", localStorage_topic: "(none)", localStorage_title: "(empty_store)" };
    }
    const parsed = JSON.parse(raw);
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : [];
    const lid = String(laneId || "").trim();
    let row = lid ? tabs.find((x) => String(x?.laneId || "").trim() === lid) : null;
    if (!row && tabIndex != null && Number.isFinite(Number(tabIndex))) {
      row = tabs.find((x) => Number(x?.idx) === Number(tabIndex));
    }
    if (!row) {
      return {
        localStorage_laneLabel: "(no_matching_tab)",
        localStorage_topic: "(no_matching_tab)",
        localStorage_title: "(no_matching_tab)"
      };
    }
    localStorage_laneLabel = String(row?.laneLabel || "").trim() || "(empty)";
    localStorage_topic = String(row?.topic || "").trim() || "(empty)";
    localStorage_title = `laneLabel=${localStorage_laneLabel}; topic=${localStorage_topic}`;
  } catch (_) {
    localStorage_title = "(localStorage_parse_failed)";
    localStorage_laneLabel = "(error)";
    localStorage_topic = "(error)";
  }
  return { localStorage_laneLabel, localStorage_topic, localStorage_title };
}

function reasoningTitleCandidateDebugLog(panel, blob) {
  try {
    const p = panel instanceof HTMLElement ? panel : null;
    const eff = p ? String(getReasoningTabTopicLabel(p) || "").trim() : "";
    console.info("[reasoning_title_candidate]", {
      turn_id: blob.turn_id ?? null,
      lane_id:
        (p ? String(p.dataset.laneId || "").trim() : String(blob.lane_id ?? "").trim()) || null,
      old_lane_label: p ? String(p.dataset.laneLabel || "").trim() : "",
      old_tab_topic: p ? String(p.dataset.tabTopic || "").trim() : "",
      effective_old_title: eff,
      is_generic_auto_renamable: p ? isGenericAutoRenamableReasoningPanelTitle(eff) : false,
      candidate_title: blob.candidate_title ?? "",
      candidate_source: blob.candidate_source ?? "",
      called_from: blob.called_from ?? "",
      ...(blob.extra && typeof blob.extra === "object" ? blob.extra : {})
    });
  } catch (_) {}
}

function reasoningTitleUpdateDebugLog(lane_id, old_title, new_title, allowed, reason) {
  try {
    console.info("[reasoning_title_update]", {
      lane_id: lane_id ?? null,
      old_title: String(old_title ?? ""),
      new_title: String(new_title ?? ""),
      allowed: Boolean(allowed),
      reason: String(reason || "")
    });
  } catch (_) {}
}

function reasoningLaneTitleSyncDebugLog(panel) {
  try {
    if (!(panel instanceof HTMLElement)) return;
    try {
      persistReasoningTabsState();
    } catch (_) {}
    const lane_id = String(panel.dataset.laneId || "").trim() || null;
    const idx = Number(panel.dataset.tabIndex);
    const tab_text = String(getReasoningTabTopicLabel(panel) || "").trim();
    const reg = lane_id ? getWorkModeLaneHandoff(lane_id) : null;
    const persisted = readPersistedReasoningTabSnapshotForLane(lane_id, idx);
    console.info("[lane_title_sync]", {
      lane_id,
      registry_title: String(reg?.title || reg?.lane_title || "").trim() || "(none)",
      tab_text,
      panel_dataset_lane_label: String(panel.dataset.laneLabel || "").trim(),
      panel_dataset_tab_topic: String(panel.dataset.tabTopic || "").trim(),
      localStorage_title: persisted.localStorage_title
    });
  } catch (_) {}
}

function reasoningLlmTitleQueueDecision(panel) {
  if (!(panel instanceof HTMLElement)) {
    return { ok: false, reason: "not_html_element", effective_title: "", detail: {} };
  }
  if (!isVeraWorkModeOn()) {
    return { ok: false, reason: "work_mode_off", effective_title: "", detail: {} };
  }
  if (panel.dataset.reasoningLlmTitleDone === "1") {
    return { ok: false, reason: "reasoningLlmTitleDone_set", effective_title: "", detail: {} };
  }
  const effective_title = String(getReasoningTabTopicLabel(panel) || "").trim();
  if (!isGenericAutoRenamableReasoningPanelTitle(effective_title)) {
    return {
      ok: false,
      reason: "effective_title_not_generic_auto_renamable",
      effective_title,
      detail: {
        reasoningLlmTitleDone: panel.dataset.reasoningLlmTitleDone || "",
        tabTopicSet: panel.dataset.tabTopicSet || ""
      }
    };
  }
  return { ok: true, reason: "eligible_for_llm_title_queue", effective_title, detail: {} };
}

function setReasoningTabTopicFromFinal(turnEl, opts = {}) {
  const calledFrom = String(opts.calledFrom ?? opts.called_from ?? "wm.reasoning_title.unknown_path").trim();
  const turnId = opts?.turnId ?? opts?.turn_id ?? null;
  try {
    console.info("[reasoning_title_path]", {
      phase: "setReasoningTabTopicFromFinal_enter",
      called_from: calledFrom,
      turn_id: turnId
    });
  } catch (_) {}

  if (!turnEl) {
    reasoningTitleCandidateDebugLog(null, {
      turn_id: turnId,
      lane_id: null,
      candidate_title: "",
      candidate_source: "(none)",
      called_from: `${calledFrom}.skip_no_turnEl`,
      extra: { note: "turnEl falsy — title path never ran" }
    });
    reasoningTitleUpdateDebugLog(null, "(n/a)", "(n/a)", false, "skip_heuristic_missing_turn_el");
    return;
  }

  const panel = turnEl.closest(".vera-reasoning-tab-panel");
  if (!(panel instanceof HTMLElement)) {
    reasoningTitleCandidateDebugLog(null, {
      turn_id: turnId,
      lane_id: null,
      candidate_title: "",
      candidate_source: "(none)",
      called_from: `${calledFrom}.skip_no_parent_panel`,
      extra: { note: ".closest vera-reasoning-tab-panel missing" }
    });
    reasoningTitleUpdateDebugLog(null, "(n/a)", "(n/a)", false, "skip_heuristic_turn_not_inside_tab_panel");
    return;
  }

  const laneId = String(panel.dataset.laneId || "").trim();
  const panelIdx = Number(panel.dataset.tabIndex);
  if (!panel.isConnected) {
    reasoningTitleUpdateDebugLog(
      laneId || null,
      String(getReasoningTabTopicLabel(panel) || "").trim(),
      "",
      false,
      "skip_heuristic_panel_removed_from_dom_before_title_apply"
    );
    return;
  }
  if (Number.isFinite(panelIdx)) {
    const currentPanelForIndex = document.querySelector(
      `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${panelIdx}"]`
    );
    const currentLaneId = String(currentPanelForIndex?.dataset?.laneId || "").trim();
    if (currentPanelForIndex && currentLaneId && laneId && currentLaneId !== laneId) {
      reasoningTitleUpdateDebugLog(
        laneId || null,
        String(getReasoningTabTopicLabel(panel) || "").trim(),
        "",
        false,
        "skip_heuristic_panel_identity_changed_before_title_apply"
      );
      try {
        console.info("[reasoning_title_stale_apply_blocked]", {
          original_lane_id: laneId,
          current_lane_id: currentLaneId,
          tab_index: panelIdx,
          candidate_title: "",
          called_from: calledFrom,
        });
      } catch (_) {}
      return;
    }
  }
  const display = String(getReasoningTabTopicLabel(panel) || "").trim();
  if (!isGenericAutoRenamableReasoningPanelTitle(display)) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: turnId,
      candidate_title: "",
      candidate_source: "heuristic_blocked_precheck",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(
      laneId || null,
      display,
      "",
      false,
      "skip_effective_title_not_generic_auto_renamable"
    );
    return;
  }

  const topic = buildReasoningTopicLabel(opts);
  if (!topic) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: turnId,
      candidate_title: "",
      candidate_source: "heuristic_failed_no_candidate_from_content",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(
      laneId || null,
      display,
      "",
      false,
      "skip_heuristic_buildReasoningTopicLabel_empty"
    );
    return;
  }

  reasoningTitleCandidateDebugLog(panel, {
    turn_id: turnId,
    candidate_title: topic,
    candidate_source: "heuristic_from_stream_labels",
    called_from
  });

  reasoningTitleUpdateDebugLog(laneId || null, display, topic, true, "applied_heuristic_to_dom_and_registry");

  panel.dataset.laneLabel = topic;
  panel.dataset.tabTopic = topic;
  panel.dataset.tabTopicSet = "1";
  try {
    patchReasoningLaneRegistryTitle(laneId, topic, `heuristic_from_stream:${calledFrom}`);
  } catch (_) {}
  renderReasoningTabStrip();
  try {
    persistReasoningTabsState();
  } catch (_) {}
  reasoningLaneTitleSyncDebugLog(panel);
}

/* isDefaultWorkModeReasoningPanelLaneLabel → moved to workmode/panels.js
 * (Stage 8, 2026-05-27). */

function sanitizeLlmReasoningPanelTitle(s) {
  let t = String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  if (t.length > 42) {
    const cut = t.slice(0, 42).replace(/\s+\S*$/, "").trim();
    t = cut || t.slice(0, 42).trim();
  }
  return t;
}

/** Same order idea as auth: local override / localhost first, then public worker (see `localBackendBase`). */
function veraWorkModeBackendBasesInTryOrder() {
  const bases = [];
  const push = (u) => {
    const x = String(u || "").replace(/\/$/, "").trim();
    if (x && !bases.includes(x)) bases.push(x);
  };
  try {
    if (typeof localBackendBase === "function") push(localBackendBase());
  } catch (_) {}
  push(API_URL);
  return bases.length ? bases : [String(API_URL).replace(/\/$/, "")];
}

async function fetchReasoningPanelTitleLlm(userPrompt, md, summ) {
  const body = JSON.stringify({
    session_id: getSessionId(),
    user_prompt: String(userPrompt || "").trim(),
    markdown_excerpt: String(md || "").trim().slice(0, 12000),
    summary_excerpt: String(summ || "").trim().slice(0, 2500)
  });
  for (const base of veraWorkModeBackendBasesInTryOrder()) {
    try {
      const res = await fetch(`${base}/work_mode/reasoning_panel_title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      if (!res.ok) continue;
      const j = await res.json().catch(() => ({}));
      const title = sanitizeLlmReasoningPanelTitle(String(j?.title || ""));
      if (title && !isBanalReasoningTopicLabel(title)) return title;
    } catch (_) {}
  }
  return null;
}

function heuristicReasoningPanelTitle(userPrompt, md, summ) {
  const up = String(userPrompt || "").trim();
  const mdS = String(md || "").trim();
  const sm = String(summ || "").trim();
  let t = buildReasoningTopicLabel({
    summaryText: sm,
    markdownText: mdS,
    userPrompt: up
  });
  let s = sanitizeLlmReasoningPanelTitle(t);
  if (!s || isBanalReasoningTopicLabel(s)) {
    s = sanitizeLlmReasoningPanelTitle(compactTopicPhrase(`${sm}\n${mdS}\n${up}`, 5));
  }
  if (!s || isBanalReasoningTopicLabel(s)) return "";
  return s;
}

function shouldQueueLlmReasoningPanelTitle(panel) {
  return reasoningLlmTitleQueueDecision(panel).ok;
}

/** After substantive reasoning NDJSON completes, optionally refresh tab via LLM / heuristic fallback. */
function queueLlmReasoningPanelTitleAfterFirstCompletedTurn(panel, opts = {}) {
  const calledFrom =
    String(opts.calledFrom ?? opts.called_from ?? "wm.reasoning_title.queue_unknown").trim() ||
    "wm.reasoning_title.queue_unknown";
  const tid = opts.turnId ?? opts.turn_id ?? null;
  const up0 = String(opts.userPrompt ?? "").trim();
  const md0 = String(opts.markdownText ?? "").trim();
  const summ0 = String(opts.summaryText ?? "").trim();

  if (!(panel instanceof HTMLElement)) {
    reasoningTitleCandidateDebugLog(null, {
      turn_id: tid,
      lane_id: null,
      candidate_title: "",
      candidate_source: "queue_skipped_no_panel",
      called_from: `${calledFrom}`,
      extra: { note: "panel not an HTMLElement — queue never ran" }
    });
    reasoningTitleUpdateDebugLog(null, "", "", false, "queue_skip_panel_not_html_element");
    return;
  }

  const laneRef = String(panel.dataset.laneId || "").trim();

  const qc = reasoningLlmTitleQueueDecision(panel);
  if (!qc.ok) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: tid,
      candidate_title: "",
      candidate_source: "queue_blocked_precheck",
      called_from,
      extra: {
        blocking_reason: qc.reason,
        effective_title_seen: qc.effective_title,
        ...(qc.detail || {})
      }
    });
    reasoningTitleUpdateDebugLog(
      laneRef || null,
      String(qc.effective_title || getReasoningTabTopicLabel(panel) || "").trim(),
      "",
      false,
      `skip_llm_title_queue:${qc.reason}`
    );
    return;
  }

  const effectiveAtEntry = qc.effective_title;

  if (panel.dataset.reasoningLlmTitleInFlight === "1") {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: tid,
      candidate_title: "",
      candidate_source: "queue_blocked_in_flight",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(
      laneRef || null,
      effectiveAtEntry,
      "",
      false,
      "skip_llm_title_queue_reasoningLlmTitleInFlight"
    );
    return;
  }

  const idx = Number(panel.dataset.tabIndex);
  if (!Number.isFinite(idx)) {
    reasoningTitleUpdateDebugLog(
      laneRef || null,
      effectiveAtEntry,
      "",
      false,
      "skip_llm_title_queue_invalid_panel_tab_index"
    );
    return;
  }

  if (!up0 && !md0 && !summ0) {
    reasoningTitleCandidateDebugLog(panel, {
      turn_id: tid,
      candidate_title: "",
      candidate_source: "queue_skipped_empty_inputs",
      called_from,
      extra: {}
    });
    reasoningTitleUpdateDebugLog(laneRef || null, effectiveAtEntry, "", false, "skip_llm_title_queue_empty_content_inputs");
    return;
  }

  try {
    console.info("[reasoning_title_path]", {
      phase: "queueLlmReasoningPanelTitleAfterFirstCompletedTurn_enter",
      called_from: calledFrom,
      turn_id: tid
    });
  } catch (_) {}

  reasoningTitleCandidateDebugLog(panel, {
    turn_id: tid,
    candidate_title: "(async_fetch_pending)",
    candidate_source: "llm_then_heuristic_queued",
    called_from,
    extra: { input_lens: { userPrompt: up0.length, markdown: md0.length, summary: summ0.length } }
  });

  panel.dataset.reasoningLlmTitleInFlight = "1";

  void (async () => {
    let chosenSource = "none";
    try {
      let title = (await fetchReasoningPanelTitleLlm(up0, md0, summ0)) || null;
      if (title) chosenSource = "llm_reasoning_panel_title_endpoint";
      if (!title) {
        title = heuristicReasoningPanelTitle(up0, md0, summ0);
        if (title) chosenSource = "heuristic_fallback_inside_queue";
      }

      const cur = document.querySelector(
        `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
      );

      if (!title) {
        const effStale = cur instanceof HTMLElement
          ? String(getReasoningTabTopicLabel(cur) || "").trim()
          : effectiveAtEntry;
        reasoningTitleCandidateDebugLog(panel, {
          turn_id: tid,
          candidate_title: "",
          candidate_source: "(none)",
          called_from: `${calledFrom}.fetch_complete`,
          extra: { outcome: "no_title_from_llm_or_heuristic" }
        });
        reasoningTitleUpdateDebugLog(laneRef || null, effStale, "", false, "no_title_from_llm_or_heuristic");
        return;
      }

      if (!(cur instanceof HTMLElement)) {
        reasoningTitleUpdateDebugLog(
          laneRef || null,
          effectiveAtEntry,
          title,
          false,
          "queue_abort_panel_removed_from_dom_before_apply"
        );
        return;
      }

      const curLaneId = String(cur.dataset.laneId || "").trim();
      if (laneRef && curLaneId && curLaneId !== laneRef) {
        reasoningTitleUpdateDebugLog(
          laneRef || null,
          effectiveAtEntry,
          title,
          false,
          "queue_abort_panel_identity_changed_before_title_apply"
        );
        try {
          console.info("[reasoning_title_stale_apply_blocked]", {
            turn_id: tid,
            original_lane_id: laneRef,
            current_lane_id: curLaneId,
            tab_index: idx,
            candidate_title: title,
            called_from: calledFrom,
          });
        } catch (_) {}
        return;
      }

      reasoningTitleCandidateDebugLog(cur, {
        turn_id: tid,
        candidate_title: title,
        candidate_source: chosenSource,
        called_from: `${calledFrom}.candidate_ready`,
      });

      if (cur.dataset.reasoningLlmTitleDone === "1") {
        const curDisplayBlocked = String(getReasoningTabTopicLabel(cur) || "").trim();
        reasoningTitleUpdateDebugLog(
          String(cur.dataset.laneId || "").trim() || null,
          curDisplayBlocked,
          title,
          false,
          "skip_apply_reasoningLlmTitleDone_race_mid_queue"
        );
        return;
      }

      const curDisplay = String(getReasoningTabTopicLabel(cur) || "").trim();
      if (!isGenericAutoRenamableReasoningPanelTitle(curDisplay)) {
        reasoningTitleUpdateDebugLog(
          String(cur.dataset.laneId || "").trim() || null,
          curDisplay,
          title,
          false,
          "title_locked_non_generic_after_stream_heuristic_may_have_renamed_panel"
        );
        return;
      }

      reasoningTitleUpdateDebugLog(
        String(cur.dataset.laneId || "").trim() || null,
        curDisplay,
        title,
        true,
        `applied_${chosenSource}`
      );

      cur.dataset.reasoningLlmTitleDone = "1";
      cur.dataset.laneLabel = title;
      cur.dataset.tabTopic = title;
      cur.dataset.tabTopicSet = "1";
      try {
        patchReasoningLaneRegistryTitle(
          String(cur.dataset.laneId || "").trim(),
          title,
          `llm_panel_title:${chosenSource}:${calledFrom}`
        );
      } catch (_) {}
      renderReasoningTabStrip();
      try {
        persistReasoningTabsState();
      } catch (_) {}
      reasoningLaneTitleSyncDebugLog(cur);
    } catch (_) {
      reasoningTitleUpdateDebugLog(laneRef || null, effectiveAtEntry, "", false, "llm_title_queue_async_throw");
    } finally {
      const curFinish = document.querySelector(
        `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
      );
      if (
        curFinish instanceof HTMLElement &&
        String(curFinish.dataset.laneId || "").trim() === laneRef
      ) {
        curFinish.dataset.reasoningLlmTitleInFlight = "";
      }
    }
  })();
}
