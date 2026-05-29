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
     "No reasoning in this panel yet." line when it's blank, and the
     dedicated "Fresh workspace ready." line shows only when EVERY visible
     panel is blank (so the user sees a workspace-style reset, not a
     stale/failed feel). */
  try {
    const root = document.getElementById("vera-reasoning-pane") || document;
    const hintPerPanel = root.querySelector(".vera-wm-empty-hint--reasoning");
    const hintFresh = root.querySelector(".vera-wm-empty-hint--fresh");
    const allBlank = panels.length > 0 && panels.every((p) => _isBlankReasoningPanelElement(p));
    const activePanel = panels.find((p) => p.classList.contains("is-active")) || panels[0];
    const activeBlank = activePanel ? _isBlankReasoningPanelElement(activePanel) : true;
    if (hintFresh) {
      const shouldShowFresh = allBlank;
      hintFresh.hidden = !shouldShowFresh;
    }
    if (hintPerPanel) {
      const shouldShowPerPanel = !allBlank && activeBlank;
      hintPerPanel.hidden = !shouldShowPerPanel;
    }
  } catch (_) {}
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
/* Shape: { laneId, tabIndex, openedAt, source, consumed: false } */

function setRecentlyOpenedReasoningPanel(laneId, tabIndex, source) {
  const lid = String(laneId || "").trim();
  const idx = Number(tabIndex);
  if (!lid || !Number.isFinite(idx)) return;
  recentlyOpenedReasoningPanel = {
    laneId: lid,
    tabIndex: idx,
    openedAt: Date.now(),
    source: String(source || "unknown"),
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
  return { laneId: r.laneId, tabIndex: r.tabIndex, source: r.source, openedAt: r.openedAt };
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

  setRecentlyOpenedReasoningPanel(newLaneId, idx, source);

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

const MIN_REASONING_PANELS = REASONING_TABS_DEFAULT;
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
    persistReasoningTabsState();
  } catch (_) {}

  const afterOrder = getReasoningPanelOrder();
  const activeAfter = afterOrder.find((p) => p.isActive) || null;
  let renderActivePanelCalled = false;
  if (activeAfter && Number.isFinite(Number(activeAfter.tabIndex))) {
    try {
      setFocusedWorkModeLaneFromIndex(Number(activeAfter.tabIndex));
      renderActivePanelCalled = true;
    } catch (_) {}
  }
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
