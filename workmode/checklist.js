/* =========================================================================
 *  workmode/checklist.js — Work Mode checklist UI / state / sync layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 9). Behavior is preserved EXACTLY:
 *    - same localStorage keys (`vera_wm_checklist_v1`,
 *      `vera_wm_checklist_completed_collapsed_v1`),
 *    - same debounced server PUT (`/api/work-mode/checklist`, 180ms tail),
 *    - same hydration-from-server fallback semantics,
 *    - same DOM contract (`vera-wm-checklist-pane`,
 *      `vera-wm-checklist-ongoing`, `vera-wm-checklist-completed`,
 *      `vera-wm-checklist-li`, `vera-wm-checklist-drag-handle`, etc.),
 *    - same drag-to-indent threshold (26px),
 *    - same render/persist invariants:
 *        * exactly one trailing empty ongoing row,
 *        * non-trailing empty ongoing rows are NOT auto-pruned on load
 *          (Enter relies on mid-list empties),
 *        * parent-child nesting depth capped at 1,
 *    - same SYNC CHECKLIST markdown parser (heading detection,
 *      time-title bullet preference, planish-fallback heuristic,
 *      5 main-item help-plan cap (subitems excluded), 12000-char preview
 *      cap, 80-row proposal
 *      cap, sub-item-count-by-top cap of 3),
 *    - same plan-sync preview lifecycle (Edit/Lock toggle, Apply,
 *      preview-already-empty messaging),
 *    - same console labels:
 *        [CHECKLIST_INTENT_DEBUG], [CHECKLIST_ACTION_COMMIT_DEBUG],
 *        [PLAN_SYNC_DEBUG][<kind>], [SYNC_VOICE_TURN_DEBUG][<phase>],
 *        [__veraDebugSyncState],
 *    - same NON_CANCELABLE_AFTER_COMMIT_ACTIONS set (sync_checklist,
 *      add_checklist_item, remove_checklist_items,
 *      update_checklist_item, toggle_checklist_item, set_timer),
 *    - same 4000ms recency window for
 *      `wasNonCancelableActionRecentlyCommitted`.
 *  No multi-action planner. No checklist routing changes. No add /
 *  remove / complete / toggle semantic changes. No reasoning generation
 *  changes. No ASR / TTS / interruption changes. No news / music changes.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come AFTER workmode/panels.js (so panel-related
 *  helpers used by plan-sync metadata + sync source candidate are
 *  resolvable through the shared global lexical env) and BEFORE app.js
 *  (so the moved constants, lets, and function declarations are visible
 *  when app.js parses + runs).
 *
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/asr.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="voice/interruption.js?v=1"></script>
 *      <script src="workmode/panels.js?v=1"></script>
 *      <script src="workmode/checklist.js?v=1"></script>      <-- NEW
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Bare-identifier references in the moved code (all resolved at CALL
 *  TIME through the shared global lexical environment, not at module
 *  load):
 *    Session helpers           getSessionId, authApiUrl
 *    Work Mode state checks    isVeraWorkModeOn, appModePrefix
 *    Reasoning panel helpers   (workmode/panels.js)
 *                              getReasoningTabTopicLabel,
 *                              getWorkModeReasoningLaneId
 *                              (app.js)
 *                              getActiveDomReasoningLaneId,
 *                              getReasoningPanelElementByLaneId,
 *                              getActiveReasoningScrollEl,
 *                              getWorkModeLaneTitle
 *    Boot-time accessors       (none — module exports declarations only)
 *
 *  Helpers / state intentionally LEFT in app.js (and why):
 *    finalizeWorkChecklistSyncCommandTurn   voice-turn finalizer — calls
 *                                           abortBrowserSpeechRecognizers,
 *                                           mutates audioChunks /
 *                                           mainBrowser* / interrupt* /
 *                                           voiceUxTurn / requestInFlight /
 *                                           processing / listening state;
 *                                           tightly coupled to ASR/TTS
 *                                           pipeline.
 *    maybeHandleWorkChecklistSyncShortcut   voice command routing for
 *                                           "sync" intent; calls the
 *                                           finalizer + commits the
 *                                           non-cancelable action; tied
 *                                           to ASR + TTS lifecycle.
 *    runWorkChecklistHelpPlan,
 *      maybeHandleWorkChecklistPlanShortcut entry points into the
 *                                           reasoning composer
 *                                           (streamWorkModeReasoningComposer,
 *                                           createWorkModeFrozenTurnContext);
 *                                           reasoning generation is out
 *                                           of scope for Stage 9.
 *    wireWorkModeChecklistAndComposer       wires both checklist + the
 *                                           reasoning composer + the
 *                                           left-pane layout in one go;
 *                                           depends on reasoning composer
 *                                           DOM and several reasoning-
 *                                           streaming helpers.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers AND, for a subset, as
 *  window.* aliases for DevTools)
 *  ─────────────────────────────────────────────────────────────────────
 *    storage keys              WORK_CHECKLIST_STORAGE_KEY,
 *                              WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
 *                              WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS,
 *                              WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS,
 *                              WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX
 *    server sync               markWorkChecklistLocalMutation,
 *                              readChecklistItemsFromStorage,
 *                              queueWorkChecklistSyncToServer,
 *                              syncWorkChecklistToServerNow,
 *                              flushWorkChecklistSyncBeforeCommand,
 *                              hydrateWorkChecklistFromServer
 *    ordinal / intent          CHECKLIST_ORDINAL_WORD_MAP and
 *                              all CHECKLIST_* regex constants,
 *                              _checklistWordOrDigitOrdinal,
 *                              parseChecklistOrdinals,
 *                              _checklistDomState,
 *                              logChecklistIntentDebug,
 *                              detectChecklistActionIntent,
 *                              isLikelyWorkChecklistEditIntent,
 *                              _looksLikeChecklistCommand
 *    drag / render / persist   createWorkChecklistDragHandle,
 *                              workChecklistDragSession,
 *                              readChecklistItemsFromStorageSafe,
 *                              writeChecklistItemsToStorageSafe,
 *                              isChecklistDescendant,
 *                              applyChecklistNestingFromDrag,
 *                              workChecklistInsertBeforeFromY,
 *                              persistWorkChecklistOrderFromDom,
 *                              applyWorkChecklistCompletedCollapseFromStorage,
 *                              wireWorkChecklistCompletedCollapse,
 *                              ensureWorkChecklistListDnD,
 *                              normalizeWorkChecklistLeadingPlaceholderInStorage,
 *                              pruneInteriorEmptyOngoingItems,
 *                              ensureWorkChecklistTrailingEmptyOngoing,
 *                              insertWorkChecklistEmptyOngoingAfter,
 *                              loadWorkChecklistItems,
 *                              persistWorkChecklistToggle,
 *                              persistWorkChecklistToggleWithSubtree,
 *                              persistWorkChecklistUpdateText,
 *                              persistWorkChecklistRemove
 *    non-cancelable commit     NON_CANCELABLE_AFTER_COMMIT_ACTIONS,
 *                              logChecklistActionCommitDebug,
 *                              commitNonCancelableAction,
 *                              wasNonCancelableActionRecentlyCommitted
 *    plan-sync state + parse   planSyncPreviewRows,
 *                              getPlanSyncPanelMetaForLane,
 *                              logPlanSyncDebug, logSyncVoiceTurnDebug,
 *                              veraDebugSyncStateSnapshot,
 *                              describePlanSyncActiveContext,
 *                              collectWorkChecklistOngoingTexts,
 *                              workChecklistHasAnyStoredItems,
 *                              syncWorkChecklistEraseButton,
 *                              syncWorkChecklistHelpPlanButton,
 *                              planSyncPanelGenerationInfo,
 *                              getActivePlanSyncBlockingState,
 *                              scheduleSyncPlanButtonRefresh,
 *                              syncWorkChecklistSyncPlanButton,
 *                              getLatestWorkModeReasoningMarkdown,
 *                              getLatestMarkdownInReasoningScroll,
 *                              isChecklistSyncHeadingText,
 *                              listItemsToChecklistMarkdown,
 *                              renderedChecklistMarkdownFromPanel,
 *                              getWorkModeReasoningMarkdownCandidates,
 *                              getWorkChecklistSyncSourceCandidate,
 *                              getWorkChecklistSyncSourceMarkdown,
 *                              normalizeChecklistLineText,
 *                              buildChecklistProposalFromMarkdown,
 *                              formatChecklistProposalText,
 *                              parseChecklistProposalText,
 *                              setWorkChecklistSyncPreviewEditing,
 *                              showWorkChecklistSyncPreview,
 *                              hideWorkChecklistSyncPreview,
 *                              applyWorkChecklistSyncPreview,
 *                              eraseEntireWorkChecklist,
 *                              runWorkChecklistSyncFromLatestPlan,
 *                              flashWorkChecklistPlanHint,
 *                              buildWorkChecklistHelpPlanUserMessage,
 *                              isWorkChecklistPlanShortcutIntent,
 *                              isWorkChecklistSyncCommandIntent,
 *                              queueWorkChecklistRowEnterAnimation
 *    window aliases (existing) window.__veraDebugSyncState
 *    accessor (new)            getChecklistDebugState()
 *                                // read-only snapshot of storage state,
 *                                // sync state, and DOM count
 *                              window.getChecklistDebugState
 * ========================================================================= */

/* =========================
   STORAGE KEYS + SERVER SYNC
========================= */

const WORK_CHECKLIST_STORAGE_KEY = "vera_wm_checklist_v1";
const WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY = "vera_wm_checklist_completed_collapsed_v1";
const WORK_CHECKLIST_ANON_STORAGE_KEY_PREFIX = "vera_checklist_state:anon:";
const WORK_CHECKLIST_ANON_COLLAPSED_KEY_PREFIX = "vera_checklist_state:anon_collapsed:";
const WORK_CHECKLIST_PLACEHOLDER_LABEL = "List item";
const WORK_CHECKLIST_UI_PLACEHOLDER_ID = "__vera_wm_checklist_placeholder__";
let workChecklistSyncTimer = null;
let workChecklistHydrationPromise = null;
let workChecklistLocalMutationVersion = 0;
let workChecklistSyncInFlight = null;
/** Bumped on logout so in-flight account PUTs cannot overwrite Supabase with cleared/local rows. */
let _checklistAuthWriteGeneration = 0;
let _checklistSbHydratePromise = null;

function _checklistUsesAccountLocalStorage() {
  return (
    typeof isSupabaseUserAuthenticated === "function" &&
    isSupabaseUserAuthenticated()
  );
}

function getAnonymousChecklistStorageKey() {
  const sid = typeof getSessionId === "function" ? getSessionId() : "default";
  return `${WORK_CHECKLIST_ANON_STORAGE_KEY_PREFIX}${sid}`;
}

function getAnonymousChecklistCollapsedStorageKey() {
  const sid = typeof getSessionId === "function" ? getSessionId() : "default";
  return `${WORK_CHECKLIST_ANON_COLLAPSED_KEY_PREFIX}${sid}`;
}

function _getActiveChecklistItemsStorageKey() {
  return _checklistUsesAccountLocalStorage()
    ? WORK_CHECKLIST_STORAGE_KEY
    : getAnonymousChecklistStorageKey();
}

function _getActiveChecklistCollapsedStorageKey() {
  return _checklistUsesAccountLocalStorage()
    ? WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY
    : getAnonymousChecklistCollapsedStorageKey();
}

function _serializeAnonymousChecklistBundle(items) {
  const sid = typeof getSessionId === "function" ? getSessionId() : "default";
  return JSON.stringify({
    auth_mode: "anonymous",
    session_id: sid,
    saved_at: Date.now(),
    items: stripChecklistPlaceholdersForPersist(items),
  });
}

function _parseAnonymousChecklistStorageRaw(raw) {
  if (!raw) return { ok: true, items: [], reason: "empty" };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        ok: true,
        items: stripChecklistPlaceholdersForPersist(parsed),
        reason: "legacy_array",
      };
    }
    if (parsed && typeof parsed === "object") {
      if (parsed.auth_mode && parsed.auth_mode !== "anonymous") {
        return { ok: false, items: [], reason: "account_snapshot_while_logged_out" };
      }
      const sid = typeof getSessionId === "function" ? getSessionId() : "";
      if (parsed.session_id && sid && parsed.session_id !== sid) {
        return { ok: false, items: [], reason: "session_id_mismatch" };
      }
      const items = stripChecklistPlaceholdersForPersist(
        Array.isArray(parsed.items) ? parsed.items : []
      );
      return { ok: true, items, reason: "anonymous_bundle" };
    }
  } catch (_) {
    return { ok: false, items: [], reason: "parse_error" };
  }
  return { ok: false, items: [], reason: "unsupported_shape" };
}

function _readAnonymousChecklistItemsForRestore() {
  const raw = localStorage.getItem(getAnonymousChecklistStorageKey());
  const parsed = _parseAnonymousChecklistStorageRaw(raw);
  if (!parsed.ok) {
    console.info("[checklist_restore_skipped]", { reason: parsed.reason });
    return { items: [], completed_collapsed: false };
  }
  if (parsed.reason === "legacy_array") {
    try {
      const accountRaw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
      if (accountRaw) {
        const accountItems = stripChecklistPlaceholdersForPersist(JSON.parse(accountRaw));
        if (
          accountItems.length > 0 &&
          JSON.stringify(parsed.items) === JSON.stringify(accountItems)
        ) {
          console.info("[checklist_restore_skipped]", {
            reason: "account_snapshot_while_logged_out",
          });
          return { items: [], completed_collapsed: false };
        }
      }
    } catch (_) {}
  }
  const completed_collapsed =
    localStorage.getItem(getAnonymousChecklistCollapsedStorageKey()) === "1";
  return { items: parsed.items, completed_collapsed };
}

function readAnonymousChecklistBundle() {
  return _readAnonymousChecklistItemsForRestore();
}

function _scrubPollutedAnonymousChecklistStorage() {
  try {
    const anonKey = getAnonymousChecklistStorageKey();
    const raw = localStorage.getItem(anonKey);
    if (!raw) return;
    const parsed = _parseAnonymousChecklistStorageRaw(raw);
    if (!parsed.ok) {
      localStorage.setItem(anonKey, _serializeAnonymousChecklistBundle([]));
      return;
    }
    if (parsed.reason !== "legacy_array" || parsed.items.length === 0) return;
    const accountRaw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    if (!accountRaw) return;
    const accountItems = stripChecklistPlaceholdersForPersist(JSON.parse(accountRaw));
    if (
      accountItems.length > 0 &&
      JSON.stringify(parsed.items) === JSON.stringify(accountItems)
    ) {
      localStorage.setItem(anonKey, _serializeAnonymousChecklistBundle([]));
      console.info("[checklist_restore_skipped]", {
        reason: "account_snapshot_while_logged_out",
      });
    }
  } catch (_) {}
}

function restoreAnonymousChecklistFromLocalStorage() {
  console.info("[checklist_restore_start]", {
    auth_mode: "anonymous",
    logged_in: _checklistUsesAccountLocalStorage(),
  });
  if (_checklistUsesAccountLocalStorage()) return false;
  _scrubPollutedAnonymousChecklistStorage();
  if (typeof loadWorkChecklistItems === "function") {
    loadWorkChecklistItems();
  }
  if (typeof applyWorkChecklistCompletedCollapseFromStorage === "function") {
    applyWorkChecklistCompletedCollapseFromStorage();
  }
  const itemCount = readChecklistItemsFromStorage().length;
  console.info("[checklist_anon_restore_done]", { item_count: itemCount });
  return true;
}

function _checklistCancelPendingAccountSync() {
  if (workChecklistSyncTimer) {
    window.clearTimeout(workChecklistSyncTimer);
    workChecklistSyncTimer = null;
  }
}

function _checklistBlockAccountWrites() {
  _checklistAuthWriteGeneration += 1;
  _checklistCancelPendingAccountSync();
  _checklistSbHydratePromise = null;
  try {
    localStorage.removeItem("vera_wm_checklist_supabase_unsynced_v1");
  } catch (_) {}
  try {
    if (typeof _setChecklistSupabaseSyncStatus === "function") {
      _setChecklistSupabaseSyncStatus("synced");
    }
  } catch (_) {}
}

function clearChecklistAfterLogout() {
  _checklistBlockAccountWrites();
  _scrubPollutedAnonymousChecklistStorage();
  restoreAnonymousChecklistFromLocalStorage();
  console.info("[checklist_logout_cleanup_done]", {
    anonymous_item_count: readChecklistItemsFromStorage().length,
    anonymous_storage_key: getAnonymousChecklistStorageKey(),
  });
}

function markWorkChecklistLocalMutation() {
  workChecklistLocalMutationVersion += 1;
}

function normalizeChecklistRowText(text) {
  return String(text || "").replace(/\r/g, " ").replace(/\n/g, " ").trim();
}

function isChecklistPlaceholderLabel(text) {
  return normalizeChecklistRowText(text).toLowerCase() === WORK_CHECKLIST_PLACEHOLDER_LABEL.toLowerCase();
}

function isChecklistPlaceholderItem(item) {
  if (!item || typeof item.text !== "string") return true;
  const text = normalizeChecklistRowText(item.text);
  if (!text) return true;
  if (!Boolean(item.done) && isChecklistPlaceholderLabel(text)) return true;
  return false;
}

function stripChecklistPlaceholdersForPersist(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (row) =>
      row &&
      typeof row.text === "string" &&
      String(row.id || "") !== WORK_CHECKLIST_UI_PLACEHOLDER_ID &&
      !isChecklistPlaceholderItem(row)
  );
}

function _persistChecklistItemsToStorage(items) {
  const stripped = stripChecklistPlaceholdersForPersist(items);
  markWorkChecklistLocalMutation();
  if (_checklistUsesAccountLocalStorage()) {
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(stripped));
  } else {
    localStorage.setItem(getAnonymousChecklistStorageKey(), _serializeAnonymousChecklistBundle(stripped));
  }
  queueWorkChecklistSyncToServer();
  return stripped;
}

function sanitizeChecklistStorageInPlace() {
  try {
    if (_checklistUsesAccountLocalStorage()) {
      const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
      if (!raw) return false;
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) return false;
      const stripped = stripChecklistPlaceholdersForPersist(items);
      if (JSON.stringify(stripped) === JSON.stringify(items)) return false;
      localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(stripped));
      queueWorkChecklistSyncToServer();
      return true;
    }
    const bundle = _readAnonymousChecklistItemsForRestore();
    const stripped = stripChecklistPlaceholdersForPersist(bundle.items);
    if (JSON.stringify(stripped) === JSON.stringify(bundle.items)) return false;
    localStorage.setItem(getAnonymousChecklistStorageKey(), _serializeAnonymousChecklistBundle(stripped));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

function commitWorkChecklistFromPlaceholderText(text) {
  const normalized = normalizeChecklistRowText(text);
  if (!normalized || isChecklistPlaceholderLabel(normalized)) return false;
  const items = readChecklistItemsFromStorage();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  items.push({ id, text: normalized, done: false, parent_id: null });
  _persistChecklistItemsToStorage(items);
  try {
    window.veraUsageOnChecklistMutation?.({
      op: "add",
      item_count: 1,
      source: "ui",
      client_key: id,
    });
  } catch (_) {}
  return true;
}

function focusWorkChecklistUiPlaceholder() {
  const inp = document.querySelector(
    `#vera-wm-checklist-ongoing li[data-id="${WORK_CHECKLIST_UI_PLACEHOLDER_ID}"] .vera-wm-checklist-task-input`
  );
  if (inp instanceof HTMLInputElement) {
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }
}

function readChecklistItemsFromStorage() {
  if (!_checklistUsesAccountLocalStorage()) {
    return _readAnonymousChecklistItemsForRestore().items;
  }
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY) || "[]";
    const parsed = JSON.parse(raw);
    return stripChecklistPlaceholdersForPersist(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function readChecklistItemsFromStorageSafe() {
  return readChecklistItemsFromStorage();
}

/** Normalize server/voice full-state checklist rows for canonical local storage. */
function normalizeChecklistControlItems(items) {
  if (!Array.isArray(items)) return [];
  return stripChecklistPlaceholdersForPersist(
    items
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        id: String(row.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        text: String(row.text || "").trim(),
        done: Boolean(row.done),
        parent_id:
          row.parent_id == null || String(row.parent_id || "").trim() === ""
            ? null
            : String(row.parent_id)
      }))
      .filter((row) => String(row.text || "").trim())
  );
}

const CHECKLIST_UNDO_SNAPSHOT_SESSION_KEY = "vera_checklist_undo_snapshot_v1";
const CHECKLIST_UNDO_TTL_MS = 120000;

function _checklistUndoItemTitles(items) {
  return (items || [])
    .map((row) => String(row?.text || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function isChecklistUndoFollowupIntent(text) {
  const q = String(text || "").trim().toLowerCase();
  if (!q) return false;
  if (
    /^(?:the\s+)?(?:check\s*list|checklist|to-?do(?:\s+list)?|my\s+(?:check\s*list|checklist)|tasks?|list)\.?$/.test(
      q
    )
  ) {
    return true;
  }
  if (
    /(?:^|[\s,.!?;:])(?:you\s+)?(?:can\s+(?:you|u)\s+)?(?:please\s+)?(?:undo|restore|revert)\b/.test(
      q
    )
  ) {
    return true;
  }
  if (
    /\b(?:undo|restore|revert|bring\s+(?:it|them|that|those)\s+back|bring\s+back|put\s+(?:it|them|that|those)\s+back|get\s+(?:it|them|that|those)\s+back|restore\s+(?:the\s+)?(?:checklist|list|tasks?))\b/.test(
      q
    )
  ) {
    return true;
  }
  return false;
}

function readChecklistUndoSnapshotFromStorage() {
  try {
    const raw = sessionStorage.getItem(CHECKLIST_UNDO_SNAPSHOT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const items = normalizeChecklistControlItems(parsed.items);
    if (!items.length) return null;
    const createdMs = Number(parsed.created_at_ms || parsed.created_at || 0);
    if (createdMs > 0 && Date.now() - createdMs > CHECKLIST_UNDO_TTL_MS) {
      sessionStorage.removeItem(CHECKLIST_UNDO_SNAPSHOT_SESSION_KEY);
      return null;
    }
    return {
      snapshot_id: String(parsed.snapshot_id || ""),
      items,
      completed_collapsed: Boolean(parsed.completed_collapsed),
      created_at_ms: createdMs || Date.now(),
      source: String(parsed.source || "checklist.clear"),
      valid: true,
      expires_at_ms: Number(parsed.expires_at_ms || createdMs + CHECKLIST_UNDO_TTL_MS)
    };
  } catch (_) {
    return null;
  }
}

function clearChecklistUndoSnapshot() {
  try {
    sessionStorage.removeItem(CHECKLIST_UNDO_SNAPSHOT_SESSION_KEY);
  } catch (_) {}
}

function armChecklistUndoSnapshotFromItems(items, source = "checklist.clear") {
  const normalized = normalizeChecklistControlItems(items);
  if (!normalized.length) return null;
  const createdAtMs = Date.now();
  const snapshot = {
    snapshot_id: `cu-${createdAtMs}-${Math.abs(getSessionId?.()?.length || 0) % 100000}`,
    items: normalized,
    completed_collapsed:
      localStorage.getItem(_getActiveChecklistCollapsedStorageKey()) === "1",
    created_at_ms: createdAtMs,
    source,
    valid: true,
    expires_at_ms: createdAtMs + CHECKLIST_UNDO_TTL_MS
  };
  try {
    sessionStorage.setItem(CHECKLIST_UNDO_SNAPSHOT_SESSION_KEY, JSON.stringify(snapshot));
  } catch (_) {
    return null;
  }
  try {
    console.info("[checklist_undo_snapshot_created]", {
      session_id: String(getSessionId?.() || "").slice(0, 64),
      snapshot_id: snapshot.snapshot_id,
      snapshot_item_count: normalized.length,
      snapshot_titles: _checklistUndoItemTitles(normalized),
      created_at_ms: createdAtMs,
      expires_at_ms: snapshot.expires_at_ms
    });
    console.info("[checklist_undo_context_set]", {
      session_id: String(getSessionId?.() || "").slice(0, 64),
      snapshot_id: snapshot.snapshot_id,
      snapshot_item_count: normalized.length,
      ttl_ms: CHECKLIST_UNDO_TTL_MS
    });
  } catch (_) {}
  return snapshot;
}

/**
 * Apply backend checklist_control voice payload to canonical storage + UI.
 * @returns {{ ok: boolean, beforeCount: number, afterCount: number, reason: string }}
 */
function applyChecklistControlVoicePayload(payload = {}) {
  const op = String(payload.op || payload.action || "checklist_control").trim();
  const before = readChecklistItemsFromStorage();
  const beforeCount = before.filter((x) => String(x?.text || "").trim()).length;
  const isClearOp = /\bclear_all\b/i.test(op);
  const isUndoOp = /\bundo_clear\b/i.test(op);
  if (isClearOp && beforeCount > 0) {
    try {
      console.info("[checklist_clear_requested]", {
        session_id: String(getSessionId?.() || "").slice(0, 64),
        mode: isVeraWorkModeOn?.() ? "work" : "flow",
        item_count_before_clear: beforeCount,
        item_titles_before_clear: _checklistUndoItemTitles(before)
      });
    } catch (_) {}
    armChecklistUndoSnapshotFromItems(before, "checklist.clear");
  }
  try {
    console.info("[checklist_client_mutation_start]", {
      action: op,
      before_count: beforeCount,
      payload_item_count: Array.isArray(payload.items) ? payload.items.length : 0
    });
  } catch (_) {}

  if (!Array.isArray(payload.items)) {
    try {
      console.warn("[checklist_client_mutation_missing]", {
        reason: "missing_items_array",
        action: op
      });
    } catch (_) {}
    return { ok: false, beforeCount, afterCount: beforeCount, reason: "missing_items_array" };
  }

  const normalized = normalizeChecklistControlItems(payload.items);
  _persistChecklistItemsToStorage(normalized);
  if (typeof payload.completed_collapsed === "boolean") {
    try {
      localStorage.setItem(
        _getActiveChecklistCollapsedStorageKey(),
        payload.completed_collapsed ? "1" : "0"
      );
      queueWorkChecklistSyncToServer();
    } catch (_) {}
  }
  loadWorkChecklistItems();
  applyWorkChecklistCompletedCollapseFromStorage();
  syncWorkChecklistEraseButton();
  syncWorkChecklistHelpPlanButton();
  scheduleSyncPlanButtonRefresh(0);

  const after = readChecklistItemsFromStorage();
  const afterCount = after.filter((x) => String(x?.text || "").trim()).length;
  let ongoingDom = 0;
  try {
    const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
    ongoingDom = ongoingUl
      ? [...ongoingUl.querySelectorAll(":scope > li")].filter(
          (el) => el.dataset.id !== WORK_CHECKLIST_UI_PLACEHOLDER_ID
        ).length
      : 0;
  } catch (_) {}
  try {
    console.info("[checklist_client_mutation_done]", {
      action: op,
      before_count: beforeCount,
      after_count: afterCount
    });
    console.info("[checklist_render_after_voice_action]", {
      action: op,
      stored_count: afterCount,
      ongoing_dom_count: ongoingDom
    });
  } catch (_) {}

  if (isClearOp) {
    try {
      console.info("[checklist_cleared]", {
        session_id: String(getSessionId?.() || "").slice(0, 64),
        item_count_after_clear: afterCount
      });
    } catch (_) {}
  }
  if (isUndoOp && afterCount > 0) {
    clearChecklistUndoSnapshot();
    try {
      console.info("[checklist_undo_restored]", {
        session_id: String(getSessionId?.() || "").slice(0, 64),
        restored_item_count: afterCount,
        restored_titles: _checklistUndoItemTitles(after)
      });
    } catch (_) {}
  }

  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (!changed && op && !/undo|clear/i.test(op)) {
    try {
      console.warn("[checklist_client_mutation_missing]", {
        reason: "no_state_change",
        action: op
      });
    } catch (_) {}
    return { ok: false, beforeCount, afterCount, reason: "no_state_change" };
  }
  return { ok: true, beforeCount, afterCount, reason: "" };
}

function queueWorkChecklistSyncToServer() {
  markWorkChecklistLocalMutation();
  if (!_checklistUsesAccountLocalStorage()) return;
  if (workChecklistSyncTimer) window.clearTimeout(workChecklistSyncTimer);
  workChecklistSyncTimer = window.setTimeout(async () => {
    workChecklistSyncTimer = null;
    await syncWorkChecklistToServerNow();
  }, 180);
}

async function syncWorkChecklistToServerNow() {
  if (!_checklistUsesAccountLocalStorage()) return;
  if (workChecklistSyncInFlight) return workChecklistSyncInFlight;
  workChecklistSyncInFlight = (async () => {
    try {
      /* Session/voice-planner checklist (per tab session_id). Not account durable storage. */
      const items = readChecklistItemsFromStorage();
      const completedCollapsed =
        localStorage.getItem(_getActiveChecklistCollapsedStorageKey()) === "1";
      const sessionPut = authFetch(authApiUrl("/api/work-mode/checklist"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: getSessionId(),
          items,
          completed_collapsed: completedCollapsed
        })
      }).catch(() => {});
      const supabasePut =
        typeof syncWorkChecklistToSupabaseNow === "function"
          ? syncWorkChecklistToSupabaseNow()
          : Promise.resolve();
      await Promise.allSettled([sessionPut, supabasePut]);
    } catch (_) {
      /* ignore */
    } finally {
      workChecklistSyncInFlight = null;
    }
  })();
  return workChecklistSyncInFlight;
}

async function flushWorkChecklistSyncBeforeCommand() {
  if (!isVeraWorkModeOn() || appModePrefix() !== "vera") return;
  if (workChecklistSyncTimer) {
    window.clearTimeout(workChecklistSyncTimer);
    workChecklistSyncTimer = null;
    await syncWorkChecklistToServerNow();
    return;
  }
  if (workChecklistSyncInFlight) await workChecklistSyncInFlight;
}

async function hydrateWorkChecklistFromServer(force = false) {
  if (
    typeof isSupabaseUserAuthenticated === "function" &&
    isSupabaseUserAuthenticated()
  ) {
    return;
  }
  if (!force && workChecklistHydrationPromise) return workChecklistHydrationPromise;
  workChecklistHydrationPromise = (async () => {
    try {
      restoreAnonymousChecklistFromLocalStorage();
    } catch (_) {
      /* keep local storage fallback */
    } finally {
      workChecklistHydrationPromise = null;
    }
  })();
  await workChecklistHydrationPromise;
}

/* =========================
   IMPLICIT CHECKLIST MUTATION DETECTION
   Route checklist edits by mutation verb + item-like targets without
   requiring the literal word "checklist". Conservative blocklist keeps
   timer / panel / reasoning-refinement phrasing out of checklist routing.
========================= */

const CHECKLIST_IMPLICIT_BLOCK_RES = [
  /\b(?:add|append)\s+\d+\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\s+to\s+(?:the\s+)?timer\b/i,
  /\b(?:add|append)\s+(?:more\s+)?(?:detail|details|evidence|context|information|depth)\b/i,
  /\b(?:remove|delete|close|clear|hide|dismiss)\s+(?:the\s+)?(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|\d+(?:st|nd|rd|th)?)\s+)?(?:reasoning\s+)?(?:panel|tab)s?\b/i,
  /\bcomplete\s+(?:this|the|that)\s+(?:explanation|answer|response|essay|draft|paragraph|section|problem|question)\b/i,
  /\b(?:add|put|move|place)\s+(?:this|that|it|the\s+(?:answer|explanation|evidence|response|content))\s+(?:to|in|into)\s+(?:the\s+)?(?:panel|reasoning)\b/i,
  /\b(?:add|append)\s+.+\s+in\s+(?:the\s+)?panel\s+\d+\b/i,
  /\bmark\s+(?:this|the|that)\s+(?:paragraph|sentence|section|line|page|word)\b/i,
  /\b(?:add|turn\s+up|increase)\s+(?:the\s+)?volume\b/i,
];

function _stripChecklistCommandPoliteness(text) {
  return String(text || "")
    .trim()
    .replace(/^\s*(?:please\s+|pls\s+|kindly\s+)+/i, "")
    .replace(/^\s*(?:can|could|would|will)\s+you\b[\s,]+/i, "")
    .replace(/^\s*(?:hey\s+vera|hey|ok|okay|alright)\b[\s,]+/i, "")
    .trim();
}

function _detectChecklistNonObjectCollision(text) {
  const latest = String(text || "");
  const nonMatch = CHECKLIST_NON_OBJECT_NOUN_RE.exec(latest);
  if (!nonMatch) return null;
  if (CHECKLIST_NOUN_RE.test(latest)) return null;
  return nonMatch[0].toLowerCase();
}

function _isBlockedImplicitChecklistCommand(text) {
  const t = String(text || "").trim();
  if (!t) return { blocked: true, reason: "empty" };
  for (const re of CHECKLIST_IMPLICIT_BLOCK_RES) {
    if (re.test(t)) return { blocked: true, reason: re.source.slice(0, 48) };
  }
  const collision = _detectChecklistNonObjectCollision(t);
  if (collision) return { blocked: true, reason: `non_checklist_object:${collision}` };
  return { blocked: false, reason: "" };
}

function _classifyImplicitChecklistMutationClause(clause) {
  const raw = _stripChecklistCommandPoliteness(clause);
  if (!raw) return null;
  const low = raw.toLowerCase();
  const block = _isBlockedImplicitChecklistCommand(raw);
  if (block.blocked) return null;

  if (
    /\b(?:add|append|insert)\b/.test(low) &&
    !/\bto\s+the\s+timer\b/.test(low) &&
    !/\b(?:to|in|into)\s+(?:the\s+)?(?:panel|reasoning)\b/.test(low)
  ) {
    const m = raw.match(/\b(?:add|append|insert)\s+(?:the\s+)?(.+?)\s*$/i);
    const body = String(m?.[1] || "").trim().replace(/[?.!]+$/, "").trim();
    if (body && !/\b(?:panel|tab|timer|volume|minute|minutes|detail|evidence)\b/i.test(body)) {
      return { action: "add", clause: raw, reason: "implicit_add_verb_with_item_target" };
    }
  }

  if (
    (/\b(?:mark|complete|check\s+off|tick\s+off)\b/i.test(raw) &&
      /\b(?:complete|completed|done)\b/i.test(raw)) ||
    /\bmark\s+.+\s+(?:complete|completed|done)\b/i.test(raw) ||
    /\b(?:check\s+off|tick\s+off)\s+\S/i.test(raw)
  ) {
    return { action: "complete", clause: raw, reason: "implicit_complete_verb_with_item_target" };
  }

  if (
    /\b(?:remove|delete|cross\s+off)\b/i.test(raw) &&
    !/\b(?:panel|tab|reasoning)\b/i.test(raw)
  ) {
    return { action: "remove", clause: raw, reason: "implicit_remove_verb_with_item_target" };
  }

  if (CHECKLIST_UNCOMPLETE_VERB_RE.test(raw)) {
    return { action: "uncomplete", clause: raw, reason: "implicit_uncomplete_verb_with_item_target" };
  }

  return null;
}

function _splitImplicitChecklistClauses(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  const parts = [];
  let cursor = 0;
  const re = /\s+(?:and|then|also)\s+/gi;
  let match;
  while ((match = re.exec(s)) != null) {
    const before = s.slice(cursor, match.index).trim();
    const after = s.slice(match.index + match[0].length).trim();
    if (!before || !after) continue;
    const rhsHit = _classifyImplicitChecklistMutationClause(after);
    if (!rhsHit) continue;
    parts.push(before);
    cursor = match.index + match[0].length;
  }
  const tail = s.slice(cursor).trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [s];
}

function detectImplicitChecklistMutation(text) {
  const raw = String(text || "").trim();
  const empty = { detected: false, mutations: [], count: 0, reason: "empty" };
  if (!raw) return empty;
  const block = _isBlockedImplicitChecklistCommand(raw);
  if (block.blocked) return { ...empty, reason: block.reason };

  const scan = _splitImplicitChecklistClauses(raw);
  const mutations = [];
  const seen = new Set();
  for (const clause of scan) {
    const hit = _classifyImplicitChecklistMutationClause(clause);
    if (!hit) continue;
    const key = `${hit.action}:${hit.clause.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mutations.push(hit);
  }
  if (!mutations.length) return { ...empty, reason: "no_implicit_mutation" };
  try {
    console.info("[checklist_implicit_action_detected]", {
      raw_text: raw.slice(0, 240),
      reason: mutations.length > 1 ? "multi_implicit_checklist_mutation" : mutations[0].reason,
      actions: mutations.map((m) => m.action),
      mutation_count: mutations.length,
    });
  } catch (_) {}
  return {
    detected: true,
    mutations,
    count: mutations.length,
    reason: mutations.length > 1 ? "multi_implicit_checklist_mutation" : mutations[0].reason,
  };
}

try { window.detectImplicitChecklistMutation = detectImplicitChecklistMutation; } catch (_) {}

/* =========================
   CLOSE-PANEL DISAMBIGUATION HELPER (Spec PART 13)
   Phrases that look like checklist mutations should not trigger panel
   closes. Used by the reasoning-panel close-shortcut path in app.js.
========================= */
function _looksLikeChecklistCommand(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (detectImplicitChecklistMutation(text).detected) return true;
  /* Explicit reasoning-panel subject wins over ordinal+remove heuristics
     ("remove the fourth panel" is panel.close, not checklist.remove). */
  if (
    /\b(?:remove|delete|close|clear|hide|dismiss|get\s+rid\s+of)\b/.test(t) &&
    /\b(?:reasoning\s+(?:panel|tab|space|lane|page)s?|panels?|tabs?|reasoning\s+space|reasoning\s+lane|reasoning)\b/.test(t)
  ) {
    return false;
  }
  /* "remove/delete/mark/check ... item/task/bullet/checklist ..." */
  if (/\b(?:remove|delete|cross\s+off|check\s+off|uncheck|tick|check|mark)\s+(?:the\s+)?(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)?\s*(?:and\s+(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s*)?(?:item|task|bullet|checklist|to[- ]?do|todo|step)s?\b/.test(t)) {
    return true;
  }
  if (/\b(?:remove|delete)\s+items?\s+\d+/.test(t)) return true;
  if (/\b(?:items?|tasks?|bullets?|to[- ]?dos?|todos?|steps?)\b.*\b(?:from|in|on)\s+(?:the\s+)?(?:checklist|list|todo)\b/.test(t)) {
    return true;
  }
  return false;
}

/* =========================
   CHECKLIST INTENT DETECTION

   Replaces the previous brittle gate that only fired when the literal word
   "checklist" appeared alongside add/remove. The general detector accepts:

     - ordinal-word lists: "remove first and third item",
       "remove first, third, and fifth item", "remove the first through third"
     - digit lists: "delete items 2 and 4", "remove items 1, 3, and 5",
       "remove item 2"
     - bare ordinals when paired with item/task/bullet/row/step
     - sub-item / whole-section qualifiers
     - removal verbs: remove, delete, take out, clear, get rid of, erase, drop
     - add / complete / update verbs

   Refuses checklist routing when the text clearly names a competing object
   ("paragraph", "sentence", "argument", "example", …) and does NOT also
   mention a checklist-flavored noun.

   The detector returns the structured shape the spec calls out:
     { isChecklistAction, action, indices, scope, confidence, reason,
       detectedObjectType, removalVerbDetected,
       explicitNonChecklistObjectDetected, checklistExists, checklistVisible }
========================= */

const CHECKLIST_ORDINAL_WORD_MAP = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12
};

const CHECKLIST_ORDINAL_WORD_RE_FRAG =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth";

const CHECKLIST_REMOVAL_VERB_RE =
  /\b(?:remove|delete|erase|take\s+out|get\s+rid\s+of|clear|drop)\b/i;
const CHECKLIST_ADD_VERB_RE = /\b(?:add|append|create|insert)\b/i;
const CHECKLIST_COMPLETE_AUX_RE =
  /\b(?:complete|completed|finish|finished|check\s+off|tick\s+off|mark\s+complete)\b/i;
const CHECKLIST_UNCOMPLETE_VERB_RE =
  /\b(?:uncheck|undo\s+complete|mark\b.*\bincomplete\b|move\b.*\bongoing\b|mark\b.*\bnot\s+done\b)/i;
const CHECKLIST_STATUS_REVIEW_RE =
  /\bcheck\s+(?:my|the|our|this|that)?\s*(?:check\s*list|checklist|to-?do(?:\s+list)?|list|plan)\b|\bcheck\s+(?:if|whether)\b|\bcheck\s+(?:what|how\s+many)\b/i;
const CHECKLIST_UPDATE_VERB_RE = /\b(?:update|replace|rename|change)\b/i;

function _isChecklistCompleteVerb(text, hasItemTarget) {
  const latest = String(text || "");
  if (!latest.trim() || CHECKLIST_STATUS_REVIEW_RE.test(latest)) return false;
  if (CHECKLIST_COMPLETE_AUX_RE.test(latest)) return true;
  if (/\bmark\b/i.test(latest) && /\b(?:complete|completed|done)\b/i.test(latest)) return true;
  if (hasItemTarget && /\b(?:tick|check)\b/i.test(latest)) return true;
  if (hasItemTarget && /\bdone\b/i.test(latest)) return true;
  return false;
}

const CHECKLIST_NOUN_RE =
  /\b(?:checklist|check\s+list|to-?do(?:\s+list)?|task\s*list|item|items|task|tasks|bullet|bullets|row|rows|step|steps|sub-?item|sub-?items|sub-?bullet|sub-?bullets)\b/i;

const CHECKLIST_NON_OBJECT_NOUN_RE =
  /\b(?:paragraph|paragraphs|sentence|sentences|line\s+of\s+code|code\s+line|line\s+of\s+the\s+code|argument|arguments|example|examples|section\s+of\s+the\s+(?:essay|article|draft|paper|story|email|letter|response|reply|chapter|message|piece|post)|chapter|verse|footnote|slide|page|word\s+count|photo|photos|image|images|attachment|attachments|file|files|document|documents|note|notes)\b/i;

const CHECKLIST_WHOLE_SECTION_RE =
  /\b(?:whole|entire)\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|group|section|thing|item|bullet|task|block)\b|\b(?:including|together\s+with|along\s+with|and)\s+(?:its|the)?\s*(?:sub-?items?|children|nested|sub-?bullets?|sub-?points?|bullets?|points?)\b|\b(?:and|with)\s+everything\s+under\b/i;

const CHECKLIST_SUB_ITEM_RE =
  /\bsub-?item|sub-?items|sub-?bullet|sub-?bullets|nested\s+(?:item|bullet|row|task)|child\s+(?:item|bullet|row|task)|\bunder\s+["']?[^"']{1,80}["']?/i;

function _checklistWordOrDigitOrdinal(token) {
  const s = String(token || "").trim().toLowerCase();
  if (!s) return null;
  if (/^\d{1,3}(?:st|nd|rd|th)?$/.test(s)) {
    const n = Number(s.replace(/[a-z]+$/i, ""));
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return CHECKLIST_ORDINAL_WORD_MAP[s] || null;
}

/**
 * General ordinal parser for checklist commands.
 *   "remove first and third item"           → [1, 3]
 *   "first, third, and fifth"               → [1, 3, 5]
 *   "items 1 and 3"                         → [1, 3]
 *   "remove the first through third"        → [1, 2, 3]
 *   "remove 1, 3, 5"                        → [1, 3, 5] (paired with noun)
 * Returns sorted, deduped 1-based indices.
 */
function parseChecklistOrdinals(text) {
  const raw = String(text || "");
  if (!raw.trim()) return [];
  const lower = raw.toLowerCase();
  const candidates = [];

  /* Range form: "first through third", "first to fifth". */
  const rangeWord = lower.match(
    new RegExp(`\\b(${CHECKLIST_ORDINAL_WORD_RE_FRAG}|\\d{1,3}(?:st|nd|rd|th)?)\\s+(?:through|to)\\s+(${CHECKLIST_ORDINAL_WORD_RE_FRAG}|\\d{1,3}(?:st|nd|rd|th)?)\\b`, "i")
  );
  if (rangeWord) {
    const a = _checklistWordOrDigitOrdinal(rangeWord[1]);
    const b = _checklistWordOrDigitOrdinal(rangeWord[2]);
    if (a && b && a <= b && b - a < 24) {
      for (let i = a; i <= b; i += 1) candidates.push(i);
    }
  }

  /* "items 1, 3, and 5" / "items 1 and 3" / "items 1 3 5" (plural form). */
  const pluralBlocks = lower.matchAll(
    /\b(?:checklist\s+)?(?:items|tasks|bullets|rows|steps|sub-?items|sub-?bullets|todos|to-?dos)\s+([^.?!,;]+)/gi
  );
  for (const m of pluralBlocks) {
    const tail = String(m[1] || "");
    for (const tokenMatch of tail.matchAll(
      new RegExp(`(${CHECKLIST_ORDINAL_WORD_RE_FRAG}|\\d{1,3}(?:st|nd|rd|th)?)`, "gi")
    )) {
      const n = _checklistWordOrDigitOrdinal(tokenMatch[1]);
      if (n) candidates.push(n);
    }
  }

  /* "first, third, and fifth (items)" / "1st and 3rd item" / multi-ordinal
     bare lists. Walk the text and collect ordinal tokens whenever they're
     joined by comma / and / & / + / or. Require ≥2 ordinals OR an explicit
     trailing noun (item/task/bullet/etc.). */
  const tokenRe = new RegExp(
    `\\b(${CHECKLIST_ORDINAL_WORD_RE_FRAG}|\\d{1,3}(?:st|nd|rd|th)?)\\b`,
    "gi"
  );
  const ordinalTokens = [...lower.matchAll(tokenRe)].map((m) => ({
    idx: m.index ?? 0,
    raw: m[1],
    n: _checklistWordOrDigitOrdinal(m[1])
  })).filter((t) => t.n);
  if (ordinalTokens.length >= 2) {
    const between = lower.slice(
      ordinalTokens[0].idx + ordinalTokens[0].raw.length,
      ordinalTokens[ordinalTokens.length - 1].idx
    );
    const sequencey = /(?:,|\band\b|\bor\b|&|\+)/.test(between);
    if (sequencey) {
      for (const t of ordinalTokens) candidates.push(t.n);
    }
  }

  /* Single ordinal forms — "first item", "item 3", "delete item two". */
  for (const m of lower.matchAll(
    new RegExp(
      `\\b(${CHECKLIST_ORDINAL_WORD_RE_FRAG}|\\d{1,3}(?:st|nd|rd|th)?)\\s+(?:checklist\\s+)?(?:item|items|task|tasks|bullet|bullets|row|rows|step|steps|sub-?item|sub-?items|sub-?bullet|sub-?bullets|to-?do|todos)\\b`,
      "gi"
    )
  )) {
    const n = _checklistWordOrDigitOrdinal(m[1]);
    if (n) candidates.push(n);
  }
  for (const m of lower.matchAll(
    new RegExp(
      `\\b(?:checklist\\s+)?(?:item|task|bullet|row|step|to-?do)s?\\s+(\\d{1,3}|${CHECKLIST_ORDINAL_WORD_RE_FRAG})\\b`,
      "gi"
    )
  )) {
    const n = _checklistWordOrDigitOrdinal(m[1]);
    if (n) candidates.push(n);
  }

  const unique = [...new Set(candidates)].filter((n) => n > 0 && n < 200);
  unique.sort((a, b) => a - b);
  return unique;
}

function _checklistDomState() {
  let exists = false;
  let visible = false;
  try {
    const pane = document.getElementById("vera-wm-checklist-pane");
    if (pane instanceof HTMLElement) {
      const rect = pane.getBoundingClientRect();
      visible = !pane.hidden && rect.width > 0 && rect.height > 0;
    }
    const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
    const completedUl = document.getElementById("vera-wm-checklist-completed");
    const ongoingItems = ongoingUl ? ongoingUl.querySelectorAll(":scope > li").length : 0;
    const completedItems = completedUl ? completedUl.querySelectorAll(":scope > li").length : 0;
    exists = ongoingItems + completedItems > 0;
    if (!exists) {
      exists = readChecklistItemsFromStorage().length > 0;
    }
  } catch (_) {}
  return { exists, visible };
}

function logChecklistIntentDebug(payload) {
  try {
    console.warn("[CHECKLIST_INTENT_DEBUG]", payload);
  } catch (_) {}
}

/**
 * General checklist action intent detector. Returns the structured shape
 * the spec defines plus a confidence score so the caller can pick between
 * direct execution, deferral, or clarification.
 */
function detectChecklistActionIntent(opts = {}) {
  const latest = String(opts.latestUserText || "").trim();
  const lower = latest.toLowerCase();
  const dom = _checklistDomState();
  const checklistExists = opts.checklistExists != null ? Boolean(opts.checklistExists) : dom.exists;
  const checklistVisible = opts.checklistVisible != null ? Boolean(opts.checklistVisible) : dom.visible;
  const recentChecklistContext = Boolean(opts.recentChecklistContext);
  const base = {
    isChecklistAction: false,
    action: null,
    indices: [],
    scope: "unknown",
    confidence: 0,
    reason: "no_match",
    detectedObjectType: "unknown",
    removalVerbDetected: false,
    explicitNonChecklistObjectDetected: false,
    checklistExists,
    checklistVisible,
    recentChecklistContext
  };
  if (!latest) return { ...base, reason: "empty_text" };

  if (
    /\b(?:remove|delete|close|clear|hide|dismiss|get\s+rid\s+of)\b/.test(lower) &&
    /\b(?:reasoning\s+(?:panel|tab|space|lane|page)s?|panels?|tabs?|reasoning\s+space|reasoning\s+lane|reasoning)\b/.test(lower)
  ) {
    return { ...base, reason: "explicit_reasoning_panel_close_subject" };
  }

  if (CHECKLIST_STATUS_REVIEW_RE.test(latest)) {
    return { ...base, reason: "checklist_status_review" };
  }

  const implicitMutation = detectImplicitChecklistMutation(latest);
  if (implicitMutation.detected) {
    const primary = implicitMutation.mutations[0];
    return {
      ...base,
      isChecklistAction: true,
      action: primary?.action || "add",
      indices: [],
      scope: "top_level",
      confidence: implicitMutation.count >= 2 ? 0.9 : 0.8,
      reason: implicitMutation.reason,
      detectedObjectType: "checklist_item",
    };
  }

  const nonChecklistMatch = CHECKLIST_NON_OBJECT_NOUN_RE.exec(latest);
  const checklistNounMatch = CHECKLIST_NOUN_RE.exec(latest);
  if (nonChecklistMatch && !checklistNounMatch) {
    return {
      ...base,
      reason: `explicit_non_checklist_object:${nonChecklistMatch[0].toLowerCase()}`,
      detectedObjectType: nonChecklistMatch[0].toLowerCase().replace(/\s+/g, "_"),
      explicitNonChecklistObjectDetected: true
    };
  }

  const removalVerb = CHECKLIST_REMOVAL_VERB_RE.test(latest);
  const addVerb = CHECKLIST_ADD_VERB_RE.test(latest);
  const indices = parseChecklistOrdinals(latest);
  const hasItemTarget = indices.length >= 1;
  const completeVerb = _isChecklistCompleteVerb(latest, hasItemTarget);
  const uncompleteVerb = CHECKLIST_UNCOMPLETE_VERB_RE.test(latest);
  const updateVerb = CHECKLIST_UPDATE_VERB_RE.test(latest);
  const wholeSection = CHECKLIST_WHOLE_SECTION_RE.test(latest);
  const subItem = CHECKLIST_SUB_ITEM_RE.test(latest);
  const scope = wholeSection ? "whole_section" : (subItem ? "sub_item" : (indices.length || checklistNounMatch ? "top_level" : "unknown"));
  const explicitChecklistWord = /\bcheck\s*list|checklist\b/i.test(latest);

  /* "remove the whole first section" etc. — strong signal regardless of noun. */
  if (removalVerb && wholeSection) {
    return {
      ...base,
      isChecklistAction: true,
      action: "remove",
      indices,
      scope: "whole_section",
      confidence: 0.9,
      reason: "removal_verb_plus_whole_section_qualifier",
      detectedObjectType: "checklist_item",
      removalVerbDetected: true
    };
  }

  const hasContext = checklistExists || checklistVisible || recentChecklistContext;

  if (removalVerb && indices.length >= 1) {
    const confidence = explicitChecklistWord
      ? 0.95
      : checklistNounMatch
        ? (hasContext ? 0.9 : 0.75)
        : (hasContext ? 0.7 : 0.4);
    return {
      ...base,
      isChecklistAction: confidence >= 0.6,
      action: "remove",
      indices,
      scope,
      confidence,
      reason: explicitChecklistWord
        ? "removal_verb_plus_ordinal_plus_checklist_word"
        : checklistNounMatch
          ? "removal_verb_plus_ordinal_plus_checklist_noun"
          : "removal_verb_plus_ordinal_no_noun",
      detectedObjectType: "checklist_item",
      removalVerbDetected: true
    };
  }

  if (removalVerb && checklistNounMatch && hasContext) {
    return {
      ...base,
      isChecklistAction: true,
      action: "remove",
      indices,
      scope,
      confidence: 0.7,
      reason: "removal_verb_plus_checklist_noun_with_context",
      detectedObjectType: "checklist_item",
      removalVerbDetected: true
    };
  }

  if (addVerb && (explicitChecklistWord || (checklistNounMatch && hasContext))) {
    return {
      ...base,
      isChecklistAction: true,
      action: "add",
      indices,
      scope,
      confidence: explicitChecklistWord ? 0.85 : 0.65,
      reason: explicitChecklistWord ? "add_verb_plus_checklist_word" : "add_verb_plus_checklist_noun_with_context",
      detectedObjectType: "checklist_item"
    };
  }

  if (uncompleteVerb && (explicitChecklistWord || (checklistNounMatch && hasContext) || indices.length >= 1)) {
    return {
      ...base,
      isChecklistAction: true,
      action: "uncomplete",
      indices,
      scope,
      confidence: explicitChecklistWord ? 0.85 : 0.7,
      reason: explicitChecklistWord ? "uncomplete_verb_plus_checklist_word" : "uncomplete_verb_plus_context",
      detectedObjectType: "checklist_item"
    };
  }

  if (completeVerb && (explicitChecklistWord || (checklistNounMatch && hasContext) || indices.length >= 1)) {
    return {
      ...base,
      isChecklistAction: true,
      action: "toggle",
      indices,
      scope,
      confidence: explicitChecklistWord ? 0.85 : 0.7,
      reason: explicitChecklistWord ? "complete_verb_plus_checklist_word" : "complete_verb_plus_context",
      detectedObjectType: "checklist_item"
    };
  }

  if (updateVerb && (explicitChecklistWord || /\bitem\s+\d+\b/i.test(latest) || /\bwith\b/i.test(latest))) {
    return {
      ...base,
      isChecklistAction: true,
      action: "edit",
      indices,
      scope,
      confidence: explicitChecklistWord ? 0.8 : 0.55,
      reason: explicitChecklistWord ? "update_verb_plus_checklist_word" : "update_verb_with_item_or_with",
      detectedObjectType: "checklist_item"
    };
  }

  return {
    ...base,
    reason: removalVerb ? "removal_verb_no_target" : "no_matching_pattern",
    removalVerbDetected: removalVerb,
    indices,
    scope
  };
}

/**
 * Backwards-compatible boolean gate used by callers that just need to
 * decide "skip the reasoning-prep path?". A medium-confidence detection
 * is enough — the actual mutation still flows through the existing
 * backend `is_checklist_action_request` path which now also generalizes
 * the ordinal recognizer (see actions/checklist.py).
 *
 * Always emits a `[CHECKLIST_INTENT_DEBUG]` row so the routing decision
 * is auditable even when the gate returns false.
 */
function isLikelyWorkChecklistEditIntent(text) {
  const detection = detectChecklistActionIntent({ latestUserText: text });
  logChecklistIntentDebug({
    latest_user_text: String(text || "").slice(0, 240),
    checklist_exists: detection.checklistExists,
    checklist_visible: detection.checklistVisible,
    recent_checklist_context: detection.recentChecklistContext,
    removal_verb_detected: detection.removalVerbDetected,
    ordinal_indices_detected: detection.indices,
    explicit_non_checklist_object_detected: detection.explicitNonChecklistObjectDetected,
    detected_object_type: detection.detectedObjectType,
    is_checklist_action: detection.isChecklistAction,
    action: detection.action,
    confidence: Number((detection.confidence || 0).toFixed(2)),
    checklist_scope: detection.scope,
    reason: detection.reason
  });
  return detection.isChecklistAction && detection.confidence >= 0.6;
}

/* =========================
   DRAG HANDLE + DnD + RENDER
========================= */

function createWorkChecklistDragHandle() {
  const handle = document.createElement("div");
  handle.className = "vera-wm-checklist-drag-handle";
  handle.setAttribute("aria-label", "Drag to reorder");
  const dots = document.createElement("div");
  dots.className = "vera-wm-checklist-drag-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 6; i += 1) dots.appendChild(document.createElement("span"));
  handle.appendChild(dots);
  return handle;
}

const WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX = 26;
let workChecklistDragSession = { id: "", startX: 0, lastX: 0 };

function writeChecklistItemsToStorageSafe(items) {
  try {
    _persistChecklistItemsToStorage(items);
    return true;
  } catch {
    return false;
  }
}

function isChecklistDescendant(items, maybeChildId, maybeAncestorId) {
  const map = new Map(items.map((x) => [String(x?.id || ""), String(x?.parent_id || "")]));
  let cur = String(maybeChildId || "");
  const ancestor = String(maybeAncestorId || "");
  if (!cur || !ancestor) return false;
  let guard = 0;
  while (guard < 200) {
    const p = map.get(cur);
    if (!p) return false;
    if (p === ancestor) return true;
    cur = p;
    guard += 1;
  }
  return false;
}

function applyChecklistNestingFromDrag(draggedId) {
  const sid = String(draggedId || "");
  if (!sid) return false;
  const dx = Number(workChecklistDragSession.lastX) - Number(workChecklistDragSession.startX);
  if (!Number.isFinite(dx) || Math.abs(dx) < WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX) return false;
  const items = readChecklistItemsFromStorageSafe();
  const idx = items.findIndex((x) => String(x?.id || "") === sid);
  if (idx < 0) return false;
  const dragged = items[idx];
  if (!dragged || typeof dragged.text !== "string") return false;

  if (dx <= -WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX) {
    if (!dragged.parent_id) return false;
    items[idx] = { ...dragged, parent_id: null };
    return writeChecklistItemsToStorageSafe(items);
  }

  let parentCandidate = null;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = items[i];
    if (!prev || String(prev.id || "") === sid) continue;
    if (Boolean(prev.done) !== Boolean(dragged.done)) continue;
    if (prev.parent_id) continue;
    parentCandidate = prev;
    break;
  }
  if (!parentCandidate?.id) return false;
  const pid = String(parentCandidate.id);
  if (pid === sid) return false;
  if (isChecklistDescendant(items, pid, sid)) return false;
  items[idx] = { ...dragged, parent_id: pid };
  return writeChecklistItemsToStorageSafe(items);
}

function workChecklistInsertBeforeFromY(container, clientY) {
  const dragging = container.querySelector(":scope > li.vera-wm-checklist-dragging");
  const lis = [...container.querySelectorAll(":scope > li")].filter((el) => el !== dragging);
  for (const child of lis) {
    const r = child.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return child;
  }
  return null;
}

function persistWorkChecklistOrderFromDom() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl) return;
  const ongoingIds = [...ongoingUl.querySelectorAll(":scope > li")]
    .map((el) => el.dataset.id)
    .filter((id) => id && id !== WORK_CHECKLIST_UI_PLACEHOLDER_ID);
  const completedIds = [...completedUl.querySelectorAll(":scope > li")].map((el) => el.dataset.id).filter(Boolean);
  try {
    const map = new Map(readChecklistItemsFromStorage().map((x) => [String(x.id), x]));
    const persisted = stripChecklistPlaceholdersForPersist([...map.values()]);
    const next = stripChecklistPlaceholdersForPersist(
      [...ongoingIds, ...completedIds].map((id) => map.get(id)).filter(Boolean)
    );
    if (next.length !== persisted.length) return;
    _persistChecklistItemsToStorage(next);
  } catch (_) {}
}

function applyWorkChecklistCompletedCollapseFromStorage() {
  const pane = document.getElementById("vera-wm-checklist-pane");
  const btn = document.getElementById("vera-wm-checklist-completed-toggle");
  if (!pane || !btn || pane.classList.contains("vera-wm-checklist-pane--ongoing-only")) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(_getActiveChecklistCollapsedStorageKey()) === "1";
  } catch (_) {}
  pane.classList.toggle("vera-wm-checklist-pane--completed-collapsed", collapsed);
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function wireWorkChecklistCompletedCollapse() {
  const btn = document.getElementById("vera-wm-checklist-completed-toggle");
  const pane = document.getElementById("vera-wm-checklist-pane");
  if (!btn || !pane || btn.dataset.collapseWired === "1") return;
  btn.dataset.collapseWired = "1";
  btn.addEventListener("click", () => {
    if (pane.classList.contains("vera-wm-checklist-pane--ongoing-only")) return;
    const collapsed = !pane.classList.contains("vera-wm-checklist-pane--completed-collapsed");
    pane.classList.toggle("vera-wm-checklist-pane--completed-collapsed", collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    try {
      localStorage.setItem(_getActiveChecklistCollapsedStorageKey(), collapsed ? "1" : "0");
      queueWorkChecklistSyncToServer();
    } catch (_) {}
  });
}

function ensureWorkChecklistListDnD() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl || ongoingUl.dataset.checklistDnd === "1") return;
  ongoingUl.dataset.checklistDnd = "1";
  completedUl.dataset.checklistDnd = "1";

  const onDragOver = (e) => {
    const ul = e.currentTarget;
    if (!(ul instanceof HTMLElement)) return;
    e.preventDefault();
    workChecklistDragSession.lastX = Number(e.clientX) || workChecklistDragSession.lastX;
    try {
      e.dataTransfer.dropEffect = "move";
    } catch (_) {}
    const dragging = ul.querySelector(":scope > li.vera-wm-checklist-dragging");
    if (!dragging) return;
    const insertBefore = workChecklistInsertBeforeFromY(ul, e.clientY);
    if (insertBefore === null) ul.appendChild(dragging);
    else ul.insertBefore(dragging, insertBefore);
  };

  ongoingUl.addEventListener("dragover", onDragOver);
  completedUl.addEventListener("dragover", onDragOver);
}

/**
 * If the first row is an empty ongoing placeholder but completed items follow it in storage,
 * the placeholder was likely inserted at index 0 (legacy bug). Rotate it to the end so it
 * stays the trailing “new item” slot, not a stray row above completed tasks.
 */
function normalizeWorkChecklistLeadingPlaceholderInStorage() {
  return sanitizeChecklistStorageInPlace();
}

/** Drops empty / placeholder ongoing rows from persisted storage. */
function pruneInteriorEmptyOngoingItems() {
  return sanitizeChecklistStorageInPlace();
}

/** UI-only trailing row is appended in loadWorkChecklistItems; storage stays real-items-only. */
function ensureWorkChecklistTrailingEmptyOngoing() {
  return sanitizeChecklistStorageInPlace();
}

/** @deprecated Mid-list empties are no longer persisted; Enter focuses the trailing placeholder. */
function insertWorkChecklistEmptyOngoingAfter(afterId) {
  void afterId;
  focusWorkChecklistUiPlaceholder();
  return WORK_CHECKLIST_UI_PLACEHOLDER_ID;
}

function appendWorkChecklistUiPlaceholderRow(ongoingUl) {
  if (!ongoingUl) return;
  ongoingUl.querySelector(`:scope > li[data-id="${WORK_CHECKLIST_UI_PLACEHOLDER_ID}"]`)?.remove();

  const id = WORK_CHECKLIST_UI_PLACEHOLDER_ID;
  const li = document.createElement("li");
  li.className = "vera-wm-checklist-li vera-wm-checklist-li--placeholder";
  li.dataset.id = id;
  li.style.setProperty("--checklist-depth", "0");
  li.draggable = false;

  const handle = createWorkChecklistDragHandle();
  handle.draggable = false;
  handle.setAttribute("aria-hidden", "true");
  handle.style.visibility = "hidden";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "vera-wm-checklist-cb";
  cb.checked = false;
  cb.disabled = true;
  cb.tabIndex = -1;
  cb.setAttribute("aria-hidden", "true");

  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "vera-wm-checklist-task-input";
  inp.placeholder = WORK_CHECKLIST_PLACEHOLDER_LABEL;
  inp.value = "";
  inp.maxLength = 200;
  inp.autocomplete = "off";
  inp.draggable = false;

  const actions = document.createElement("div");
  actions.className = "vera-wm-checklist-li-actions";
  const btnDel = document.createElement("button");
  btnDel.type = "button";
  btnDel.className = "vera-wm-checklist-action vera-wm-checklist-action-del";
  btnDel.textContent = "✕";
  btnDel.setAttribute("aria-label", "Clear new item");
  btnDel.title = "Clear";
  btnDel.addEventListener("click", () => {
    inp.value = "";
    inp.focus();
  });
  actions.appendChild(btnDel);

  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const inputs = [...ongoingUl.querySelectorAll(".vera-wm-checklist-task-input")];
      const rowIdx = inputs.indexOf(inp);
      if (rowIdx < 0) return;
      const len = inp.value.length;
      const sel0 = inp.selectionStart ?? 0;
      const sel1 = inp.selectionEnd ?? 0;
      if (e.key === "ArrowDown") {
        if (sel0 !== len || sel1 !== len) return;
        return;
      }
      if (sel0 !== 0 || sel1 !== 0) return;
      const prev = inputs[rowIdx - 1];
      if (prev instanceof HTMLInputElement) {
        e.preventDefault();
        prev.focus();
        const pl = prev.value.length;
        prev.setSelectionRange(pl, pl);
      }
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (commitWorkChecklistFromPlaceholderText(inp.value)) {
      inp.value = "";
      loadWorkChecklistItems();
      focusWorkChecklistUiPlaceholder();
    }
  });

  inp.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!li.isConnected) return;
      if (commitWorkChecklistFromPlaceholderText(inp.value)) {
        inp.value = "";
        loadWorkChecklistItems();
      }
    }, 0);
  });

  li.appendChild(handle);
  li.appendChild(cb);
  li.appendChild(inp);
  li.appendChild(actions);
  ongoingUl.appendChild(li);
}

function loadWorkChecklistItems() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl) return;
  ensureWorkChecklistListDnD();
  sanitizeChecklistStorageInPlace();
  let items = readChecklistItemsFromStorage();
  const idMap = new Map(items.map((x) => [String(x?.id || ""), x]));
  const depthCache = new Map();
  const getDepth = (id) => {
    const sid = String(id || "");
    if (!sid) return 0;
    if (depthCache.has(sid)) return depthCache.get(sid);
    let depth = 0;
    let cur = idMap.get(sid);
    const visited = new Set([sid]);
    while (cur && cur.parent_id && depth < 1) {
      const pid = String(cur.parent_id || "");
      if (!pid || visited.has(pid)) break;
      const parent = idMap.get(pid);
      if (!parent || Boolean(parent.done) !== Boolean(cur.done)) break;
      visited.add(pid);
      depth += 1;
      cur = parent;
    }
    depthCache.set(sid, depth);
    return depth;
  };
  ongoingUl.replaceChildren();
  completedUl.replaceChildren();
  items.forEach((it) => {
    if (!it || typeof it.text !== "string") return;
    if (isChecklistPlaceholderItem(it)) return;
    if (String(it.id || "") === WORK_CHECKLIST_UI_PLACEHOLDER_ID) return;
    const id = String(it.id || "");
    const li = document.createElement("li");
    li.className = "vera-wm-checklist-li";
    if (it.done) li.classList.add("is-done");
    li.dataset.id = id;
    li.style.setProperty("--checklist-depth", String(getDepth(id)));
    li.draggable = false;

    const handle = createWorkChecklistDragHandle();
    handle.draggable = true;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "vera-wm-checklist-cb";
    cb.checked = Boolean(it.done);
    cb.setAttribute("aria-label", it.done ? "Mark as not done" : "Mark complete");
    const actions = document.createElement("div");
    actions.className = "vera-wm-checklist-li-actions";

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "vera-wm-checklist-action vera-wm-checklist-action-del";
    btnDel.textContent = "✕";
    btnDel.setAttribute("aria-label", "Delete item");
    btnDel.title = "Delete";

    actions.appendChild(btnDel);

    /* dragstart targets the draggable node; with draggable on <li>, e.target was often
       the <li> itself, so closest(handle) failed and every drag was cancelled. */
    handle.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      li.classList.add("vera-wm-checklist-dragging");
      workChecklistDragSession = {
        id,
        startX: Number(e.clientX) || 0,
        lastX: Number(e.clientX) || 0,
      };
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", id);
      } catch (_) {}
      try {
        const r = li.getBoundingClientRect();
        e.dataTransfer.setDragImage(li, Math.round(e.clientX - r.left), Math.round(e.clientY - r.top));
      } catch (_) {}
    });
    handle.addEventListener("dragend", () => {
      li.classList.remove("vera-wm-checklist-dragging");
      persistWorkChecklistOrderFromDom();
      applyChecklistNestingFromDrag(id);
      workChecklistDragSession = { id: "", startX: 0, lastX: 0 };
      const pruned = pruneInteriorEmptyOngoingItems();
      const ensured = ensureWorkChecklistTrailingEmptyOngoing();
      if (pruned || ensured) loadWorkChecklistItems();
      else loadWorkChecklistItems();
    });

    btnDel.addEventListener("click", () => {
      persistWorkChecklistRemove(id);
      loadWorkChecklistItems();
    });

    cb.addEventListener("change", () => {
      const wantDone = cb.checked;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      /* 2026-06-01 — manual checkbox cascade. When the user clicks the
         checkbox for a TOP-LEVEL item, the whole subtree (parent + every
         sub-item) must toggle in lockstep so a partially-checked group is
         never visually orphaned in the opposite list. Sub-item clicks stay
         single-row so the user can still check off individual substeps.
         Voice/text "mark first item complete" continues to flow through
         the backend executor's cascade and is unaffected by this change. */
      if (wantDone && !it.done) {
        const textInp = li.querySelector(".vera-wm-checklist-task-input");
        const t = textInp instanceof HTMLInputElement ? textInp.value : it.text;
        if (!String(t ?? "").trim()) {
          cb.checked = false;
          return;
        }
        if (textInp instanceof HTMLInputElement) persistWorkChecklistUpdateText(id, textInp.value);

        if (reduceMotion) {
          persistWorkChecklistToggleWithSubtree(id, true);
          loadWorkChecklistItems();
          return;
        }

        li.classList.add("vera-wm-checklist-li-exiting");
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          window.clearTimeout(fallbackTimer);
          li.removeEventListener("transitionend", onTransitionEnd);
          persistWorkChecklistToggleWithSubtree(id, true);
          loadWorkChecklistItems();
          queueWorkChecklistRowEnterAnimation("vera-wm-checklist-completed", id);
        };
        const onTransitionEnd = (ev) => {
          if (ev.target !== li) return;
          if (ev.propertyName !== "opacity" && ev.propertyName !== "filter") return;
          complete();
        };
        const fallbackTimer = window.setTimeout(complete, 420);
        li.addEventListener("transitionend", onTransitionEnd);
        return;
      }

      if (!wantDone && it.done) {
        if (reduceMotion) {
          persistWorkChecklistToggleWithSubtree(id, false);
          loadWorkChecklistItems();
          return;
        }

        li.classList.add("vera-wm-checklist-li-exiting");
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          window.clearTimeout(fallbackTimer);
          li.removeEventListener("transitionend", onTransitionEnd);
          persistWorkChecklistToggleWithSubtree(id, false);
          loadWorkChecklistItems();
          queueWorkChecklistRowEnterAnimation("vera-wm-checklist-ongoing", id);
        };
        const onTransitionEnd = (ev) => {
          if (ev.target !== li) return;
          if (ev.propertyName !== "opacity" && ev.propertyName !== "filter") return;
          complete();
        };
        const fallbackTimer = window.setTimeout(complete, 420);
        li.addEventListener("transitionend", onTransitionEnd);
        return;
      }

      persistWorkChecklistToggleWithSubtree(id, wantDone);
      loadWorkChecklistItems();
    });

    if (it.done) {
      const span = document.createElement("span");
      span.className = "vera-wm-checklist-task-text";
      span.textContent = it.text;
      li.appendChild(handle);
      li.appendChild(cb);
      li.appendChild(span);
      li.appendChild(actions);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "vera-wm-checklist-task-input";
      inp.placeholder = "List item";
      inp.value = it.text;
      inp.maxLength = 200;
      inp.autocomplete = "off";
      inp.draggable = false;
      inp.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
          if (!ongoingUl) return;
          const inputs = [...ongoingUl.querySelectorAll(".vera-wm-checklist-task-input")];
          const rowIdx = inputs.indexOf(inp);
          if (rowIdx < 0) return;
          const len = inp.value.length;
          const sel0 = inp.selectionStart ?? 0;
          const sel1 = inp.selectionEnd ?? 0;
          if (e.key === "ArrowDown") {
            if (sel0 !== len || sel1 !== len) return;
            const next = inputs[rowIdx + 1];
            if (next instanceof HTMLInputElement) {
              e.preventDefault();
              next.focus();
              next.setSelectionRange(0, 0);
            }
            return;
          }
          if (sel0 !== 0 || sel1 !== 0) return;
          const prev = inputs[rowIdx - 1];
          if (prev instanceof HTMLInputElement) {
            e.preventDefault();
            prev.focus();
            const pl = prev.value.length;
            prev.setSelectionRange(pl, pl);
          }
          return;
        }
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        persistWorkChecklistUpdateText(id, inp.value);
        loadWorkChecklistItems();
        focusWorkChecklistUiPlaceholder();
      });
      inp.addEventListener("blur", () => {
        window.setTimeout(() => {
          const next = document.activeElement;
          if (next && li.contains(next)) {
            persistWorkChecklistUpdateText(id, inp.value);
            return;
          }
          persistWorkChecklistUpdateText(id, inp.value);
          if (!li.isConnected) return;
          loadWorkChecklistItems();
        }, 0);
      });
      li.appendChild(handle);
      li.appendChild(cb);
      li.appendChild(inp);
      li.appendChild(actions);
    }
    (it.done ? completedUl : ongoingUl).appendChild(li);
  });

  appendWorkChecklistUiPlaceholderRow(ongoingUl);

  const pane = document.getElementById("vera-wm-checklist-pane");
  const completedSection = document.getElementById("vera-wm-checklist-completed-section");
  /* Use rows actually rendered — items with done:true but invalid text are skipped in forEach
     but used to be counted here, which left an empty “Completed” chrome visible. */
  const completedCount = completedUl.querySelectorAll(":scope > li").length;
  const countEl = document.getElementById("vera-wm-checklist-completed-count");
  if (countEl) countEl.textContent = completedCount ? ` (${completedCount})` : "";
  if (completedSection && pane) {
    if (completedCount === 0) {
      completedSection.hidden = true;
      completedSection.classList.add("vera-wm-checklist-completed-section--empty");
      pane.classList.add("vera-wm-checklist-pane--ongoing-only");
      pane.classList.remove("vera-wm-checklist-pane--completed-collapsed");
    } else {
      completedSection.hidden = false;
      completedSection.classList.remove("vera-wm-checklist-completed-section--empty");
      pane.classList.remove("vera-wm-checklist-pane--ongoing-only");
      applyWorkChecklistCompletedCollapseFromStorage();
    }
  }
  syncWorkChecklistEraseButton();
  syncWorkChecklistHelpPlanButton();
  scheduleSyncPlanButtonRefresh(0);
}

function persistWorkChecklistToggle(id, done) {
  try {
    let items = readChecklistItemsFromStorage();
    items = items.map((x) =>
      String(x.id) === id ? { ...x, done: Boolean(done) } : x
    );
    _persistChecklistItemsToStorage(items);
  } catch (_) {}
}

/**
 * Cascade variant of ``persistWorkChecklistToggle`` for manual checkbox
 * clicks in the UI.
 *
 * Behavior (2026-06-01 patch):
 *   - If the clicked item is a TOP-LEVEL row (no ``parent_id``), toggle the
 *     parent AND every descendant under it. This matches the user's mental
 *     model that "Apply to internships" includes its substeps; checking the
 *     parent should not leave the substeps in a half-checked state.
 *   - If the clicked item is a SUB-ITEM, toggle only that row — substeps
 *     are still independently checkable so the user can mark one step done
 *     without consuming the whole group.
 *
 * Sub-items are gathered by walking the ``parent_id`` graph (BFS) so deeper
 * grandchildren (today the depth cap is 1, but the data model allows more)
 * would also cascade correctly if the indent rules ever loosen. The bare
 * ``persistWorkChecklistToggle`` is deliberately left untouched so external
 * callers (server sync, voice/text action executor, debug tools) continue
 * to operate on a single row — the voice/text "remove/complete the first
 * item" path already cascades inside ``apply_checklist_action`` on the
 * backend, so cascading here only changes the UI checkbox click path.
 */
function persistWorkChecklistToggleWithSubtree(id, done) {
  try {
    const sid = String(id || "");
    if (!sid) return;
    let items = readChecklistItemsFromStorage();

    const target = items.find((x) => String(x?.id || "") === sid);
    const wantDone = Boolean(done);

    // Default: toggle just the clicked row. For a top-level parent we
    // also gather every descendant under it; sub-items stay single-row.
    const idsToToggle = new Set([sid]);
    const isTopLevel = !target || !target.parent_id;
    if (isTopLevel) {
      const queue = [sid];
      let guard = 0;
      while (queue.length && guard < 5000) {
        guard += 1;
        const cur = queue.shift();
        for (const it of items) {
          const childId = String(it?.id || "");
          if (!childId || idsToToggle.has(childId)) continue;
          if (String(it?.parent_id || "") === cur) {
            idsToToggle.add(childId);
            queue.push(childId);
          }
        }
      }
    }

    items = items.map((x) =>
      idsToToggle.has(String(x?.id || "")) ? { ...x, done: wantDone } : x
    );
    _persistChecklistItemsToStorage(items);
    try {
      window.veraUsageOnChecklistMutation?.({
        op: wantDone ? "complete" : "uncomplete",
        item_count: idsToToggle.size,
        batch_size: idsToToggle.size,
        source: "ui",
        client_key: sid,
      });
    } catch (_) {}
  } catch (_) {}
}

function persistWorkChecklistUpdateText(id, text) {
  try {
    if (String(id) === WORK_CHECKLIST_UI_PLACEHOLDER_ID) {
      if (commitWorkChecklistFromPlaceholderText(text)) loadWorkChecklistItems();
      return;
    }
    let items = readChecklistItemsFromStorage();
    items = items.map((x) => (String(x.id) === id ? { ...x, text: String(text) } : x));
    _persistChecklistItemsToStorage(items);
  } catch (_) {}
}

function persistWorkChecklistRemove(id) {
  try {
    if (String(id) === WORK_CHECKLIST_UI_PLACEHOLDER_ID) return;
    let items = readChecklistItemsFromStorage();
    items = items.filter((x) => String(x.id) !== id);
    _persistChecklistItemsToStorage(items);
    try {
      window.veraUsageOnChecklistMutation?.({
        op: "delete",
        item_count: 1,
        source: "ui",
        client_key: String(id || ""),
      });
    } catch (_) {}
  } catch (_) {}
}

/* =========================
   NON-CANCELABLE-AFTER-COMMIT BOOKKEEPING

   Sync, add, remove, update, toggle, and timer actions persist BEFORE the
   spoken confirmation. Interrupting the confirmation must NEVER walk back
   the already-committed state — only the spoken audio is cancelled.
========================= */

const WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS = 24;
const WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT = 5;
const WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS = 12000;
let workChecklistSyncPreviewEditing = false;
/** Bumps when reasoning finishes with a checklist-capable plan (see onDone). */
let workChecklistSyncPlanVersion = 0;
/** Last `workChecklistSyncPlanVersion` successfully applied to the checklist (Apply / voice sync); preview alone does not advance this. */
let workChecklistSyncConsumedPlanVersion = 0;
/** Markdown snapshot for the latest unsynced plan (with checklist). Survives later non-plan reasoning turns; replaced when a newer plan arrives; cleared on successful Apply. */
let workChecklistSyncPendingMarkdown = "";
let workChecklistSyncPendingPlanMeta = null;
let workChecklistSyncCommandSeq = 0;
let activeWorkChecklistSyncCommand = "";
let lastCompletedWorkChecklistSyncCommandTurn = null;

/**
 * Policy: actions in this set are committed to state BEFORE TTS speaks
 * the confirmation, and a user interrupt during that confirmation must
 * NEVER roll them back. Interruption only cancels the spoken response.
 *
 * Only `cancel that` / `undo that` / `revert that` style commands are
 * allowed to walk back a non-cancelable action — and those go through
 * the regular undo snapshot path (see `is_checklist_undo_request`).
 */
const NON_CANCELABLE_AFTER_COMMIT_ACTIONS = new Set([
  "sync_checklist",
  "add_checklist_item",
  "remove_checklist_items",
  "update_checklist_item",
  "toggle_checklist_item",
  "set_timer"
]);

let lastCommittedNonCancelableAction = null;

function logChecklistActionCommitDebug(payload = {}) {
  try {
    console.warn("[CHECKLIST_ACTION_COMMIT_DEBUG]", {
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (_) {}
}

/**
 * Stamp a non-cancelable action as committed. Call this AFTER the state
 * mutation has been persisted to localStorage / pushed to the server
 * and BEFORE the spoken confirmation is enqueued. The interrupt pipeline
 * uses the resulting record to decide that the network/state should NOT
 * be torn down — only the spoken audio.
 */
function commitNonCancelableAction(actionType, payload = {}) {
  const type = String(actionType || "").trim();
  if (!type || !NON_CANCELABLE_AFTER_COMMIT_ACTIONS.has(type)) {
    return null;
  }
  const record = {
    action_type: type,
    committed_at: Date.now(),
    payload: payload && typeof payload === "object" ? { ...payload } : {}
  };
  lastCommittedNonCancelableAction = record;
  logChecklistActionCommitDebug({
    phase: "commit",
    action_type: type,
    payload_keys: Object.keys(record.payload),
    notes: "state already persisted; interrupt may only cancel TTS"
  });
  return record;
}

/**
 * Returns `true` when a non-cancelable action was committed within the
 * recent window (default: last 4 seconds). Interrupt handlers consult
 * this so they leave already-applied checklist/timer mutations alone.
 */
function wasNonCancelableActionRecentlyCommitted(opts = {}) {
  if (!lastCommittedNonCancelableAction) return false;
  const windowMs = Number.isFinite(opts.withinMs) ? Number(opts.withinMs) : 4000;
  return Date.now() - lastCommittedNonCancelableAction.committed_at <= windowMs;
}

/* =========================
   PLAN-SYNC PREVIEW + MARKDOWN PARSE + BUTTON STATE
========================= */

function planSyncPreviewRows(rows, limit = 5) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((row) => String(row?.text || "").trim())
    .filter(Boolean);
}

function getPlanSyncPanelMetaForLane(laneId, fallbackTitle = "") {
  const activePanel = document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active");
  let lid = String(laneId || "").trim();
  if (!lid && activePanel instanceof HTMLElement) {
    const activeIdx = Number(activePanel.dataset.tabIndex);
    if (Number.isFinite(activeIdx)) {
      lid = getWorkModeReasoningLaneId(activeIdx);
    } else {
      lid = String(activePanel.dataset.laneId || "").trim();
    }
  }
  const panel = lid ? getReasoningPanelElementByLaneId(lid) : activePanel;
  const activeLaneId =
    activePanel instanceof HTMLElement
      ? getWorkModeReasoningLaneId(Number(activePanel.dataset.tabIndex))
      : getActiveDomReasoningLaneId();
  return {
    lane_id: lid,
    panel_id: lid,
    panel_title:
      (panel instanceof HTMLElement ? getReasoningTabTopicLabel(panel) : "") ||
      String(fallbackTitle || "").trim() ||
      (lid ? getWorkModeLaneTitle(lid) : ""),
    active_panel_id: String(activeLaneId || "").trim(),
    active_panel_title:
      activePanel instanceof HTMLElement ? getReasoningTabTopicLabel(activePanel) : ""
  };
}

function logPlanSyncDebug(kind, payload = {}) {
  try {
    const enriched = { timestamp: new Date().toISOString(), ...payload };
    // console.warn (not info) so the DevTools "Default" level filter cannot
    // hide these — Chrome hides Info entries when "Info" is toggled off but
    // always shows Warnings. Bright yellow row in the console UI.
    console.warn(`[PLAN_SYNC_DEBUG][${kind}]`, enriched);
  } catch (_) {}
}

function logSyncVoiceTurnDebug(phase, payload = {}) {
  try {
    console.warn(`[SYNC_VOICE_TURN_DEBUG][${phase}]`, {
      timestamp: new Date().toISOString(),
      ...payload
    });
  } catch (_) {}
}

/** Manual one-shot debug helper. Returns AND console.tables the full sync
 *  state without mutating anything. Usage in DevTools:
 *      window.__veraDebugSyncState()
 *  Safe to call any time — does not touch checklist or panel state. */
function veraDebugSyncStateSnapshot() {
  const ctx = describePlanSyncActiveContext();
  const activePanel = ctx.active_panel_id
    ? getReasoningPanelElementByLaneId(ctx.active_panel_id)
    : null;
  const activeMarkdown =
    activePanel instanceof HTMLElement
      ? String(
          activePanel.querySelector(".vera-reasoning-turn:last-of-type")?.dataset?.markdownAcc ||
            activePanel.innerText ||
            ""
        )
      : "";
  const selected = getWorkChecklistSyncSourceCandidate();
  const rows = selected?.rows || [];
  const btn = document.getElementById("vera-wm-checklist-sync-plan");
  const previewPanel = document.getElementById("vera-wm-checklist-sync-preview");
  let checklistCount = 0;
  try {
    checklistCount = readChecklistItemsFromStorage().filter((x) => x && String(x.text || "").trim()).length;
  } catch (_) {}
  const snapshot = {
    timestamp: new Date().toISOString(),
    active_panel_id: ctx.active_panel_id,
    active_panel_title: ctx.active_panel_title,
    active_lane_id: ctx.active_lane_id,
    last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
    last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
    current_panel_markdown_length: activeMarkdown.length,
    current_panel_markdown_preview_first_500: activeMarkdown.slice(0, 500),
    selected_source: selected?.source || "",
    selected_source_panel_id: selected?.meta?.panel_id || null,
    selected_source_panel_title: selected?.meta?.panel_title || "",
    selected_source_markdown_length: String(selected?.markdown || "").length,
    sync_candidate_count: rows.length,
    sync_candidates_preview: planSyncPreviewRows(rows, 12),
    sync_button_visible: btn instanceof HTMLButtonElement ? !btn.hidden : null,
    sync_button_enabled: btn instanceof HTMLButtonElement ? !btn.disabled : null,
    preview_open: previewPanel instanceof HTMLElement ? !previewPanel.hidden : null,
    checklist_item_count: checklistCount
  };
  try {
    console.group("[__veraDebugSyncState]");
    console.table([
      {
        active_panel_id: snapshot.active_panel_id,
        active_panel_title: snapshot.active_panel_title,
        last_plan_panel_id: snapshot.last_plan_panel_id,
        last_plan_panel_title: snapshot.last_plan_panel_title,
        markdown_len: snapshot.current_panel_markdown_length,
        sync_candidate_count: snapshot.sync_candidate_count,
        sync_button_enabled: snapshot.sync_button_enabled,
        preview_open: snapshot.preview_open,
        checklist_item_count: snapshot.checklist_item_count
      }
    ]);
    if (snapshot.sync_candidates_preview.length) {
      console.table(snapshot.sync_candidates_preview.map((t, i) => ({ idx: i, text: t })));
    }
    console.info("[full]", snapshot);
    console.groupEnd();
  } catch (_) {}
  return snapshot;
}

try {
  window.__veraDebugSyncState = veraDebugSyncStateSnapshot;
  // Confirm the helper is wired and callable. If you see this line in the
  // console but typing `window.__veraDebugSyncState()` says "not a function",
  // you are inspecting a different frame than the page (check the DevTools
  // context dropdown — it must be "top" / the page, not an iframe).
  console.warn(
    "%c[VERA] window.__veraDebugSyncState() is ready — typeof: " +
      typeof window.__veraDebugSyncState,
    "color:#06d6a0;font-weight:bold;"
  );
} catch (_) {}

/** Snapshot of "where am I right now" used by sync debug logs and the
 *  window.__veraDebugSyncState() helper. Pure read — no mutation. */
function describePlanSyncActiveContext() {
  const activeLaneId = getActiveDomReasoningLaneId();
  const activePanel =
    document.querySelector("#vera-reasoning-tab-panels .vera-reasoning-tab-panel.is-active") ||
    (activeLaneId ? getReasoningPanelElementByLaneId(activeLaneId) : null);
  const activeLaneIdResolved =
    activePanel instanceof HTMLElement
      ? getWorkModeReasoningLaneId(Number(activePanel.dataset.tabIndex)) || activeLaneId
      : activeLaneId;
  const activePanelTitle =
    activePanel instanceof HTMLElement ? getReasoningTabTopicLabel(activePanel) : "";
  return {
    active_panel_id: activeLaneIdResolved || null,
    active_panel_title: activePanelTitle || "",
    active_lane_id: activeLaneIdResolved || null
  };
}

function logChecklistPlanDebug(kind, payload) {
  try {
    console.info(`[checklist_plan_${kind}]`, payload || {});
  } catch (_) {}
}

function buildChecklistPlanHierarchyFromStorage() {
  let items = [];
  try {
    items = readChecklistItemsFromStorage();
  } catch (_) {
    items = [];
  }
  const ongoing = items.filter(
    (x) =>
      x &&
      !Boolean(x.done) &&
      String(x.text || "").trim() &&
      !isChecklistPlaceholderItem(x) &&
      String(x.id || "") !== WORK_CHECKLIST_UI_PLACEHOLDER_ID
  );
  const mainById = new Map();
  const orderedMain = [];
  for (const row of ongoing) {
    const pid =
      row.parent_id == null || String(row.parent_id || "").trim() === ""
        ? null
        : String(row.parent_id);
    if (pid) continue;
    const id = String(row.id || "");
    const main = {
      id,
      text: String(row.text || "").trim(),
      done: false,
      children: [],
    };
    mainById.set(id, main);
    orderedMain.push(main);
  }
  for (const row of ongoing) {
    const pid =
      row.parent_id == null || String(row.parent_id || "").trim() === ""
        ? null
        : String(row.parent_id);
    if (!pid || !mainById.has(pid)) continue;
    mainById.get(pid).children.push({
      id: String(row.id || ""),
      text: String(row.text || "").trim(),
      done: false,
    });
  }
  const subitemCount = orderedMain.reduce((n, m) => n + (m.children?.length || 0), 0);
  const hierarchyLog = orderedMain.map((m) => ({
    parent_id: null,
    text: m.text.slice(0, 80),
    child_count: m.children.length,
  }));
  logChecklistPlanDebug("hierarchy", hierarchyLog);
  return {
    main_items: orderedMain,
    main_count: orderedMain.length,
    subitem_count: subitemCount,
  };
}

function getChecklistPlanLimitMessage(mainCount) {
  const n = Number(mainCount) || 0;
  return `I can make a plan for up to ${WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT} main checklist items. You currently have ${n}. Please remove or group a few first.`;
}

function validateChecklistPlanRequest(planContext) {
  const ctx =
    planContext && Array.isArray(planContext.main_items)
      ? planContext
      : buildChecklistPlanHierarchyFromStorage();
  logChecklistPlanDebug("build", {
    main_count: ctx.main_count,
    subitem_count: ctx.subitem_count,
  });
  logChecklistPlanDebug("context", {
    main_items_preview: (ctx.main_items || []).slice(0, 8).map((m) => ({
      text: m.text,
      child_count: (m.children || []).length,
      children: (m.children || []).slice(0, 4).map((c) => c.text),
    })),
  });
  if (!ctx.main_count) {
    return {
      ok: false,
      reason: "no_main_items",
      message: "Add text to at least one ongoing item first.",
      main_count: 0,
    };
  }
  if (ctx.main_count > WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT) {
    logChecklistPlanDebug("limit_exceeded", {
      main_count: ctx.main_count,
      limit: WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT,
    });
    logChecklistPlanDebug("request_blocked", {
      reason: "too_many_main_items",
      main_count: ctx.main_count,
    });
    return {
      ok: false,
      reason: "too_many_main_items",
      message: getChecklistPlanLimitMessage(ctx.main_count),
      main_count: ctx.main_count,
    };
  }
  return { ok: true, context: ctx };
}

function collectWorkChecklistOngoingTexts() {
  return buildChecklistPlanHierarchyFromStorage().main_items.map((m) => m.text);
}

function workChecklistHasAnyStoredItems() {
  try {
    return readChecklistItemsFromStorage().length > 0;
  } catch {
    return false;
  }
}

function syncWorkChecklistEraseButton() {
  const btn = document.getElementById("vera-wm-checklist-erase-all");
  if (!(btn instanceof HTMLButtonElement)) return;
  btn.disabled = !workChecklistHasAnyStoredItems();
}

function syncWorkChecklistHelpPlanButton() {
  const btn = document.getElementById("vera-wm-checklist-help-plan");
  if (!btn) return;
  btn.disabled = buildChecklistPlanHierarchyFromStorage().main_count === 0;
}

function planSyncPanelGenerationInfo(panel) {
  if (!(panel instanceof HTMLElement)) {
    return {
      source_panel_generating: false,
      source_panel_generation_status: "unknown",
      reason_if_disabled: "no_parseable_plan_candidates"
    };
  }
  const generating = String(panel.dataset.generating || "") === "1";
  const rawStatus = String(panel.dataset.generationStatus || "").trim();
  const hasMarkdown = Boolean(getLatestMarkdownInReasoningScroll(panel).trim());
  const status = rawStatus || (generating ? "generating" : hasMarkdown ? "complete" : "unknown");
  let reason = "";
  if (generating || status === "generating") reason = "panel_still_generating";
  else if (status === "cancelled" || status === "user_stopped") reason = "panel_cancelled";
  else if (/failed|error|timed_out|http|throw/i.test(status)) reason = "panel_failed";
  return {
    source_panel_generating: generating || status === "generating",
    source_panel_generation_status: status,
    reason_if_disabled: reason
  };
}

function getActivePlanSyncBlockingState() {
  const activeLaneId = getActiveDomReasoningLaneId();
  const panel = activeLaneId ? getReasoningPanelElementByLaneId(activeLaneId) : null;
  if (!(panel instanceof HTMLElement)) return null;
  const info = planSyncPanelGenerationInfo(panel);
  if (info.reason_if_disabled) {
    const markdown = getLatestMarkdownInReasoningScroll(panel) || renderedChecklistMarkdownFromPanel(panel);
    return {
      ...info,
      panel,
      source_panel_id: activeLaneId,
      source_panel_title: getReasoningTabTopicLabel(panel),
      markdown_length: String(markdown || "").trim().length
    };
  }
  return null;
}

/** Throttled refresh so chunk appends / tab switches don't spam the button state.
 *  During generation this only logs/keeps disabled; parsing happens after the
 *  panel is marked complete. */
let __syncPlanButtonRefreshTimer = null;
function scheduleSyncPlanButtonRefresh(delayMs = 250) {
  if (__syncPlanButtonRefreshTimer) return;
  __syncPlanButtonRefreshTimer = window.setTimeout(() => {
    __syncPlanButtonRefreshTimer = null;
    try {
      syncWorkChecklistSyncPlanButton();
    } catch (_) {}
  }, Math.max(0, delayMs));
}

function syncWorkChecklistSyncPlanButton() {
  const btn = document.getElementById("vera-wm-checklist-sync-plan");
  if (!(btn instanceof HTMLButtonElement)) return;
  const ctx = describePlanSyncActiveContext();
  const blocked = getActivePlanSyncBlockingState();
  if (blocked) {
    btn.disabled = true;
    btn.title =
      blocked.reason_if_disabled === "panel_still_generating"
        ? "Available after the plan finishes."
        : "No completed checklist-ready plan available.";
    logPlanSyncDebug("button", {
      sync_button_visible: !btn.hidden,
      sync_button_enabled: false,
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      active_lane_id: ctx.active_lane_id,
      source_panel_id: blocked.source_panel_id || null,
      source_panel_title: blocked.source_panel_title || "",
      source_panel_generating: blocked.source_panel_generating,
      source_panel_generation_status: blocked.source_panel_generation_status,
      markdown_length: blocked.markdown_length,
      sync_candidate_count: 0,
      reason_if_disabled: blocked.reason_if_disabled,
      lane_id: blocked.source_panel_id || null,
      panel_id: blocked.source_panel_id || null,
      panel_title: blocked.source_panel_title || "",
      syncable: false,
      has_sync_metadata: false
    });
    return;
  }
  const selected = getWorkChecklistSyncSourceCandidate();
  const canUseSync = Boolean(selected?.markdown);
  btn.disabled = !canUseSync;
  btn.title = canUseSync ? "Sync checklist from latest completed plan" : "No completed checklist-ready plan available.";
  const sourcePanelId = selected?.meta?.panel_id || null;
  const sourcePanel =
    sourcePanelId ? getReasoningPanelElementByLaneId(sourcePanelId) : null;
  const sourceInfo = planSyncPanelGenerationInfo(sourcePanel);
  logPlanSyncDebug("button", {
    sync_button_visible: !btn.hidden,
    sync_button_enabled: !btn.disabled,
    active_panel_id: ctx.active_panel_id,
    active_panel_title: ctx.active_panel_title,
    active_lane_id: ctx.active_lane_id,
    source_panel_id: sourcePanelId,
    source_panel_title: selected?.meta?.panel_title || "",
    source_panel_generating: sourceInfo.source_panel_generating,
    source_panel_generation_status: sourceInfo.source_panel_generation_status,
    markdown_length: String(selected?.markdown || "").length,
    sync_candidate_count: selected?.rows?.length || 0,
    reason_if_disabled: canUseSync ? "" : "no_parseable_plan_candidates",
    /* Legacy fields kept for older tooling that already filters on these. */
    lane_id: selected?.meta?.lane_id || null,
    panel_id: selected?.meta?.panel_id || null,
    panel_title: selected?.meta?.panel_title || "",
    syncable: canUseSync,
    has_sync_metadata: Boolean(selected?.markdown)
  });
}

function getLatestWorkModeReasoningMarkdown() {
  const scroll = getActiveReasoningScrollEl();
  if (!(scroll instanceof HTMLElement)) return "";
  const turns = [...scroll.querySelectorAll(".vera-reasoning-turn")];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const md = String(turns[i]?.dataset?.markdownAcc || "").trim();
    if (md) return md;
  }
  return "";
}

function getLatestMarkdownInReasoningScroll(scroll) {
  if (!(scroll instanceof HTMLElement)) return "";
  const turns = [...scroll.querySelectorAll(".vera-reasoning-turn")];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const md = String(turns[i]?.dataset?.markdownAcc || "").trim();
    if (md) return md;
  }
  return "";
}

function isChecklistSyncHeadingText(text) {
  const t = normalizeChecklistLineText(text).replace(/[:#]+$/g, "").trim().toLowerCase();
  return /^(sync\s+checklist|checklist|plan\s+checklist|tasks?)$/.test(t);
}

function listItemsToChecklistMarkdown(items) {
  const lines = [];
  for (const li of items) {
    if (!(li instanceof HTMLElement)) continue;
    const clone = li.cloneNode(true);
    if (clone instanceof HTMLElement) {
      clone.querySelectorAll("ul,ol").forEach((nested) => nested.remove());
    }
    const text = normalizeChecklistLineText(clone.textContent || li.textContent || "");
    if (!text || /\?$/.test(text)) continue;
    lines.push(`- ${text}`);
    const nested = li.querySelectorAll(":scope > ul > li, :scope > ol > li");
    for (const sub of nested) {
      const subText = normalizeChecklistLineText(sub.textContent || "");
      if (subText && !/\?$/.test(subText)) lines.push(`  - ${subText}`);
    }
  }
  return lines;
}

function renderedChecklistMarkdownFromPanel(panel) {
  if (!(panel instanceof HTMLElement)) return "";
  const scroll =
    panel.querySelector(".vera-reasoning-md-panel") ||
    panel.querySelector(".vera-reasoning-scroll") ||
    panel;
  if (!(scroll instanceof HTMLElement)) return "";

  // Preferred path: rendered markdown headings followed by UL/OL siblings.
  const headingEls = [...scroll.querySelectorAll("h1,h2,h3,h4,h5,h6,p,div,strong,b")]
    .filter((el) => el instanceof HTMLElement && isChecklistSyncHeadingText(el.textContent || ""));
  for (const heading of headingEls) {
    const lines = [];
    let node = heading instanceof HTMLElement ? heading.nextElementSibling : null;
    while (node) {
      const tag = String(node.tagName || "").toLowerCase();
      if (/^h[1-6]$/.test(tag)) break;
      if (isChecklistSyncHeadingText(node.textContent || "") && node !== heading) break;
      if (tag === "ul" || tag === "ol") {
        lines.push(...listItemsToChecklistMarkdown(node.querySelectorAll(":scope > li")));
      } else if (tag === "li") {
        lines.push(...listItemsToChecklistMarkdown([node]));
      }
      node = node.nextElementSibling;
    }
    if (lines.length) return `## SYNC CHECKLIST\n${lines.join("\n")}`;
  }

  // Fallback path for markdown rendered as plain text in the panel.
  const plain = String(scroll.innerText || scroll.textContent || "").replace(/\r/g, "");
  const lines = plain.split("\n");
  const start = lines.findIndex((line) => isChecklistSyncHeadingText(line));
  if (start >= 0) {
    const out = ["## SYNC CHECKLIST"];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = normalizeChecklistLineText(lines[i]);
      if (!line) continue;
      if (isChecklistSyncHeadingText(line) || /^#{1,6}\s+/.test(line)) break;
      if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
        out.push(lines[i]);
      } else if (/^\s*\[[^\]]+\]\s*:/.test(line) || /\b(read|open|highlight|draft|write|review|revise|submit|finish|complete|study|solve|practice)\b/i.test(line)) {
        out.push(`- ${line}`);
      }
    }
    if (out.length > 1) return out.join("\n");
  }
  return "";
}

function getWorkModeReasoningMarkdownCandidates() {
  if (getActivePlanSyncBlockingState()) return [];
  const candidates = [];
  const seen = new Set();
  const push = (md, source, meta = {}) => {
    const text = String(md || "").trim();
    if (!text || seen.has(text)) return;
    const status = String(meta.source_panel_generation_status || meta.generation_status || "").trim();
    if (status && status !== "complete" && status !== "completed") return;
    seen.add(text);
    candidates.push({ markdown: text, source, meta });
  };

  // Pending is the newest server-confirmed plan while the page stays alive.
  push(workChecklistSyncPendingMarkdown, "pending_plan", workChecklistSyncPendingPlanMeta || {});
  const activeLaneId = getActiveDomReasoningLaneId();
  const activePanel = activeLaneId ? getReasoningPanelElementByLaneId(activeLaneId) : null;
  const activeStatus = planSyncPanelGenerationInfo(activePanel);
  const activeMeta = {
    ...getPlanSyncPanelMetaForLane(activeLaneId),
    source_panel_generating: activeStatus.source_panel_generating,
    source_panel_generation_status: activeStatus.source_panel_generation_status
  };
  push(getLatestWorkModeReasoningMarkdown(), "active_reasoning_tab", activeMeta);
  push(renderedChecklistMarkdownFromPanel(activePanel), "active_reasoning_tab_rendered", {
    ...activeMeta,
    source_detail: "rendered_dom_fallback"
  });

  // Also scan all reasoning tabs so Sync remains available after accepting
  // once, switching lanes, or when the visible active tab is not the plan tab.
  const root = document.getElementById("vera-reasoning-tab-panels");
  if (root instanceof HTMLElement) {
    const panels = [...root.querySelectorAll(".vera-reasoning-tab-panel")];
    for (const panel of panels) {
      const idx = Number(panel.dataset.tabIndex);
      const laneId = Number.isFinite(idx) ? getWorkModeReasoningLaneId(idx) : "";
      const scroll =
        panel.querySelector(".vera-reasoning-md-panel") ||
        panel.querySelector(".vera-reasoning-scroll");
      const panelStatus = planSyncPanelGenerationInfo(panel);
      const panelMeta = {
        ...getPlanSyncPanelMetaForLane(laneId),
        panel_title: getReasoningTabTopicLabel(panel),
        source_panel_generating: panelStatus.source_panel_generating,
        source_panel_generation_status: panelStatus.source_panel_generation_status
      };
      push(getLatestMarkdownInReasoningScroll(scroll), "reasoning_tab", {
        ...panelMeta
      });
      push(renderedChecklistMarkdownFromPanel(panel), "reasoning_tab_rendered", {
        ...panelMeta,
        source_detail: "rendered_dom_fallback"
      });
    }
  }

  return candidates;
}

function getWorkChecklistSyncSourceCandidate() {
  const candidates = getWorkModeReasoningMarkdownCandidates();
  const ctx = describePlanSyncActiveContext();
  for (const cand of candidates) {
    const rows = buildChecklistProposalFromMarkdown(cand.markdown);
    const md = String(cand?.markdown || "");
    const headingMatch = md.match(
      /(?:^|\n)\s*(?:#{1,6}\s*)?(SYNC CHECKLIST|Checklist|Plan checklist|Tasks)\b[^\n]*/i
    );
    logPlanSyncDebug("parse", {
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      active_lane_id: ctx.active_lane_id,
      panel_id: cand?.meta?.panel_id || null,
      lane_id: cand?.meta?.lane_id || null,
      panel_title: cand?.meta?.panel_title || "",
      source: cand?.source || "",
      source_panel_generating: Boolean(cand?.meta?.source_panel_generating),
      source_panel_generation_status: cand?.meta?.source_panel_generation_status || "",
      markdown_length: md.length,
      markdown_preview_first_500: md.slice(0, 500),
      has_sync_heading: Boolean(headingMatch),
      sync_heading_matched: headingMatch ? headingMatch[0].trim().slice(0, 120) : "",
      sync_candidate_count: rows.length,
      sync_candidates_preview: planSyncPreviewRows(rows),
      candidates_preview: planSyncPreviewRows(rows),
      reason_if_zero: rows.length ? "" : "no_parseable_bullets_in_candidate"
    });
    if (rows.length > 0) {
      return { ...cand, rows };
    }
  }
  return null;
}

/** Markdown used for checklist Sync: first parseable pending/active/any-tab plan. */
function getWorkChecklistSyncSourceMarkdown() {
  const selected = getWorkChecklistSyncSourceCandidate();
  if (selected?.markdown) {
    return selected.markdown;
  }
  return "";
}

function normalizeChecklistLineText(text) {
  let raw = String(text || "");
  // Some rendered markdown snapshots carry HTML entities back into text
  // (`&#58;` for `:`). Decode before parsing so visible SYNC CHECKLIST bullets
  // are treated the same as original markdown bullets.
  try {
    if (/[&][a-zA-Z0-9#]+;/.test(raw) && typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.innerHTML = raw;
      raw = ta.value;
    }
  } catch (_) {}
  return raw
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildChecklistProposalFromMarkdown(markdown) {
  const full = String(markdown || "").replace(/\r/g, "");
  const syncBlockMatch =
    full.match(
      /(?:^|\n)#{1,6}\s*(?:SYNC CHECKLIST|Checklist|Plan checklist|Tasks)\s*\n([\s\S]*?)(?=\n#{1,6}\s+|\s*$)/i
    ) ||
    full.match(
      /(?:^|\n)\s*(?:SYNC CHECKLIST|Checklist|Plan checklist|Tasks)\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:#{1,6}\s+|[A-Z][A-Z0-9 \-/]{2,}:?\s*\n)|\s*$)/i
    );
  const hasExplicitSyncBlock = Boolean(syncBlockMatch);
  const hasTimePlanBullets =
    /\[\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]+)\s*-\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]+)\s*\]\s*:/i.test(
      full
    );
  const planishMarkdown =
    hasExplicitSyncBlock ||
    /\b(?:study\s+plan|task\s+list|to-?do\s+list|plan\s+checklist|sync\s+checklist)\b/i.test(full.slice(0, 5000)) ||
    (hasTimePlanBullets &&
      /\b(plan|schedule|outline|deadline|time\s*block)\b/i.test(full.slice(0, 5000)));
  const source = syncBlockMatch
    ? syncBlockMatch[1]
    : planishMarkdown && (hasExplicitSyncBlock || hasTimePlanBullets)
      ? full
      : "";
  if (!source.trim()) return [];
  const rawLines = source.split("\n");
  const proposals = [];
  let currentTop = "";
  let inCode = false;
  let inQuestionsSection = false;
  const timeTitlePattern =
    /^\s*\[\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]+)\s*-\s*(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]+)\s*\]\s*:\s*.+$/i;
  const subCountByTopText = new Map();
  for (const raw of rawLines) {
    const line = String(raw || "");
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) {
      const text = normalizeChecklistLineText(heading[1]).toLowerCase();
      inQuestionsSection = /\b(question|questions|clarif|narrow)\b/.test(text);
      continue;
    }
    const listMatch = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (listMatch) {
      const indent = (listMatch[1] || "").replace(/\t/g, "  ").length;
      const text = normalizeChecklistLineText(listMatch[2]);
      if (!text) continue;
      if (inQuestionsSection) continue;
      if (/\?$/.test(text) || /^(question|questions)[:\s-]/i.test(text)) continue;
      if (indent >= 2 && currentTop) {
        const topKey = currentTop.toLowerCase();
        const cur = subCountByTopText.get(topKey) || 0;
        if (cur >= 3) continue;
        proposals.push({ depth: 1, text });
        subCountByTopText.set(topKey, cur + 1);
      } else {
        // Accept top-level bullets only from explicit sync blocks, time-titled
        // plan rows, or clearly plan-shaped markdown — not general explanatory lists.
        if (!hasExplicitSyncBlock && !timeTitlePattern.test(text)) continue;
        proposals.push({ depth: 0, text });
        currentTop = text;
        subCountByTopText.set(text.toLowerCase(), 0);
      }
      continue;
    }
  }
  const cleaned = [];
  const seen = new Set();
  for (const row of proposals) {
    const key = `${row.depth}|${row.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(row);
  }
  if (!cleaned.length && planishMarkdown && hasExplicitSyncBlock) {
    const fallbackRows = [];
    const fallbackSeen = new Set();
    for (const raw of rawLines) {
      const line = String(raw || "").trim();
      if (!line || line.startsWith("```") || /^#{1,6}\s+/.test(line)) continue;
      if (/^\|/.test(line) || /^[-*_]{3,}$/.test(line)) continue;
      const withoutMarker = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|(?:step|part)\s+\d+\s*[:.)-]\s*)/i, "");
      const text = normalizeChecklistLineText(withoutMarker);
      if (!text || text.length < 4 || text.length > 140) continue;
      if (/\?$/.test(text)) continue;
      if (!/\b(write|read|review|finish|draft|outline|solve|practice|submit|check|revise|research|study|plan|pick|choose|organize|complete|work|start|prepare|edit|proofread|summarize)\b/i.test(text)) {
        continue;
      }
      const key = text.toLowerCase();
      if (fallbackSeen.has(key)) continue;
      fallbackSeen.add(key);
      fallbackRows.push({ depth: 0, text });
      if (fallbackRows.length >= 24) break;
    }
    return fallbackRows;
  }
  return cleaned.slice(0, 80);
}

function formatChecklistProposalText(rows) {
  return rows
    .map((row) => `${row.depth > 0 ? "  " : ""}- ${row.text}`)
    .join("\n");
}

function materializeChecklistItemsFromProposalRows(rows) {
  const out = [];
  let parentId = null;
  for (const row of rows) {
    const text = normalizeChecklistRowText(row?.text);
    if (!text || isChecklistPlaceholderLabel(text)) continue;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (Number(row?.depth) > 0) {
      out.push({ id, text, done: false, parent_id: parentId });
    } else {
      parentId = id;
      out.push({ id, text, done: false, parent_id: null });
    }
  }
  return out;
}

function parseChecklistProposalText(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "));
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)(?:[-*+]\s+)(.+)$/);
    if (!m) continue;
    const indent = (m[1] || "").length;
    const clean = normalizeChecklistLineText(m[2]);
    if (!clean) continue;
    rows.push({ depth: indent >= 2 ? 1 : 0, text: clean });
  }
  return materializeChecklistItemsFromProposalRows(rows);
}

function setWorkChecklistSyncPreviewEditing(editing) {
  const textarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  const editBtn = document.getElementById("vera-wm-checklist-sync-edit");
  workChecklistSyncPreviewEditing = Boolean(editing);
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.readOnly = !workChecklistSyncPreviewEditing;
    textarea.classList.toggle("is-editing", workChecklistSyncPreviewEditing);
    if (workChecklistSyncPreviewEditing) textarea.focus();
  }
  if (editBtn instanceof HTMLButtonElement) {
    editBtn.textContent = workChecklistSyncPreviewEditing ? "Lock" : "Edit";
  }
}

function showWorkChecklistSyncPreview(text) {
  const panel = document.getElementById("vera-wm-checklist-sync-preview");
  const textarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  const rows = parseChecklistProposalText(text);
  const nonEmpty = rows.filter((x) => x && String(x.text || "").trim());
  const previewItemsPreview = nonEmpty.slice(0, 6).map((x) => String(x.text || "").trim());
  if (!(panel instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
    logPlanSyncDebug("preview_open", {
      preview_visible: false,
      candidate_count: nonEmpty.length,
      preview_items_preview: previewItemsPreview,
      reason_if_not_opened: !panel
        ? "missing_panel_dom"
        : !textarea
          ? "missing_textarea_dom"
          : "missing_preview_dom"
    });
    return;
  }
  textarea.value = String(text || "").slice(0, WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS);
  panel.hidden = false;
  setWorkChecklistSyncPreviewEditing(false);
  logPlanSyncDebug("preview_open", {
    preview_visible: !panel.hidden,
    candidate_count: nonEmpty.length,
    preview_items_preview: previewItemsPreview,
    reason_if_not_opened: panel.hidden ? "panel_hidden_after_open" : ""
  });
}

function hideWorkChecklistSyncPreview() {
  const panel = document.getElementById("vera-wm-checklist-sync-preview");
  if (panel instanceof HTMLElement) panel.hidden = true;
  setWorkChecklistSyncPreviewEditing(false);
}

function applyWorkChecklistSyncPreview() {
  const textarea = document.getElementById("vera-wm-checklist-sync-preview-text");
  const safeBeforeCount = () =>
    readChecklistItemsFromStorageSafe().filter((x) => x && String(x.text || "").trim()).length;
  if (!(textarea instanceof HTMLTextAreaElement)) {
    const before = safeBeforeCount();
    logPlanSyncDebug("accept_apply", {
      accepted: false,
      candidate_count: 0,
      inserted_count: 0,
      checklist_count_before: before,
      checklist_count_after: before,
      reason_if_failed: "missing_preview_textarea"
    });
    return false;
  }
  const beforeItems = readChecklistItemsFromStorageSafe();
  const beforeCount = beforeItems.filter((x) => x && String(x.text || "").trim()).length;
  const items = parseChecklistProposalText(textarea.value);
  const candidateCount = items.filter((x) => x && String(x.text || "").trim()).length;
  if (!items.length) {
    logPlanSyncDebug("accept_apply", {
      accepted: false,
      candidate_count: candidateCount,
      inserted_count: 0,
      checklist_count_before: beforeCount,
      checklist_count_after: beforeCount,
      reason_if_failed: "preview_parse_empty"
    });
    flashWorkChecklistPlanHint("Nothing to apply. Keep '-' bullets in the proposal.");
    return false;
  }
  try {
    _persistChecklistItemsToStorage(items);
    loadWorkChecklistItems();
    hideWorkChecklistSyncPreview();
    workChecklistSyncConsumedPlanVersion = workChecklistSyncPlanVersion;
    const insertedCount = items.filter((x) => x && String(x.text || "").trim()).length;
    logPlanSyncDebug("checklist_insert", {
      inserted_count: insertedCount,
      checklist_count_before: beforeCount,
      checklist_count_after: insertedCount,
      inserted_items_preview: items
        .filter((x) => x && String(x.text || "").trim())
        .slice(0, 6)
        .map((x) => String(x.text || "").trim()),
      source_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
      source_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || ""
    });
    logPlanSyncDebug("accept_apply", {
      accepted: true,
      candidate_count: candidateCount,
      inserted_count: insertedCount,
      checklist_count_before: beforeCount,
      checklist_count_after: insertedCount,
      reason_if_failed: ""
    });
    workChecklistSyncPendingMarkdown = "";
    workChecklistSyncPendingPlanMeta = null;
    syncWorkChecklistSyncPlanButton();
    flashWorkChecklistPlanHint("Checklist updated from plan.");
    try {
      window.veraUsageOnChecklistMutation?.({
        op: "sync",
        item_count: insertedCount,
        batch_size: insertedCount,
        source: "ui",
        sync_kind: "plan",
        client_key: `plan_apply_${workChecklistSyncConsumedPlanVersion}`,
      });
    } catch (_) {}
    return true;
  } catch (err) {
    logPlanSyncDebug("accept_apply", {
      accepted: false,
      candidate_count: candidateCount,
      inserted_count: 0,
      checklist_count_before: beforeCount,
      checklist_count_after: beforeCount,
      reason_if_failed: String(err?.message || err || "apply_throw").slice(0, 200)
    });
    flashWorkChecklistPlanHint("Could not update checklist from plan.");
    return false;
  }
}

function eraseEntireWorkChecklist() {
  if (!workChecklistHasAnyStoredItems()) {
    flashWorkChecklistPlanHint("Checklist is already empty.");
    return;
  }
  const ok = window.confirm(
    "Erase the entire checklist? All ongoing and completed items will be removed. This cannot be undone."
  );
  if (!ok) return;
  const beforeErase = readChecklistItemsFromStorage();
  const beforeEraseCount = beforeErase.filter((x) => String(x?.text || "").trim()).length;
  if (beforeEraseCount > 0) {
    armChecklistUndoSnapshotFromItems(beforeErase, "checklist.clear");
  }
  try {
    _persistChecklistItemsToStorage([]);
    hideWorkChecklistSyncPreview();
    loadWorkChecklistItems();
    flashWorkChecklistPlanHint("Checklist cleared.");
    syncWorkChecklistSyncPlanButton();
  } catch (_) {
    flashWorkChecklistPlanHint("Could not erase checklist.");
  }
}

function runWorkChecklistSyncFromLatestPlan(opts = {}) {
  const triggerSource = String(opts.triggerSource || "button");
  const userText = String(opts.userText || "");
  const ctx = describePlanSyncActiveContext();
  const btnEnabled = !Boolean(
    document.getElementById("vera-wm-checklist-sync-plan")?.disabled
  );
  const blocked = getActivePlanSyncBlockingState();
  if (blocked) {
    logPlanSyncDebug("button_click", {
      clicked: true,
      sync_button_enabled: false,
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      source_panel_id: blocked.source_panel_id || null,
      source_panel_title: blocked.source_panel_title || "",
      source_panel_generating: blocked.source_panel_generating,
      source_panel_generation_status: blocked.source_panel_generation_status,
      markdown_length: blocked.markdown_length,
      sync_candidate_count: 0,
      candidates_preview: [],
      reason_if_ignored: blocked.reason_if_disabled
    });
    flashWorkChecklistPlanHint(
      blocked.reason_if_disabled === "panel_still_generating"
        ? "Sync is available after the plan finishes."
        : "No completed checklist-ready plan available."
    );
    syncWorkChecklistSyncPlanButton();
    return false;
  }
  const selected = getWorkChecklistSyncSourceCandidate();
  if (!selected?.markdown) {
    logPlanSyncDebug("button_click", {
      clicked: true,
      sync_button_enabled: btnEnabled,
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      source_panel_id: null,
      source_panel_title: "",
      sync_candidate_count: 0,
      candidates_preview: [],
      reason_if_ignored: "no_sync_source_markdown"
    });
    logPlanSyncDebug("voice_sync_request", {
      user_text: userText,
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
      last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
      selected_source_panel_id: null,
      selected_source_panel_title: "",
      sync_candidate_count: 0,
      opened_preview: false,
      auto_applied: false,
      reason_if_failed: "no_sync_source_markdown",
      trigger_source: triggerSource
    });
    flashWorkChecklistPlanHint("No checklist-ready plan found yet. Ask VERA for a plan first.");
    return false;
  }
  const rows = selected.rows || buildChecklistProposalFromMarkdown(selected.markdown);
  const candidatesPreview = planSyncPreviewRows(rows);
  if (!rows.length) {
    logPlanSyncDebug("button_click", {
      clicked: true,
      sync_button_enabled: btnEnabled,
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      source_panel_id: selected.meta?.panel_id || null,
      source_panel_title: selected.meta?.panel_title || "",
      sync_candidate_count: 0,
      candidates_preview: [],
      reason_if_ignored: "selected_source_parse_empty"
    });
    logPlanSyncDebug("voice_sync_request", {
      user_text: userText,
      active_panel_id: ctx.active_panel_id,
      active_panel_title: ctx.active_panel_title,
      last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
      last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
      selected_source_panel_id: selected.meta?.panel_id || null,
      selected_source_panel_title: selected.meta?.panel_title || "",
      sync_candidate_count: 0,
      opened_preview: false,
      auto_applied: false,
      reason_if_failed: "selected_source_parse_empty",
      trigger_source: triggerSource
    });
    flashWorkChecklistPlanHint("Could not parse checklist bullets from the visible plan.");
    return false;
  }
  logPlanSyncDebug("button_click", {
    clicked: true,
    sync_button_enabled: btnEnabled,
    active_panel_id: ctx.active_panel_id,
    active_panel_title: ctx.active_panel_title,
    source_panel_id: selected.meta?.panel_id || null,
    source_panel_title: selected.meta?.panel_title || "",
    sync_candidate_count: rows.length,
    candidates_preview: candidatesPreview,
    reason_if_ignored: ""
  });
  // Bind the visible/rendered fallback source as the current plan source so
  // Apply and voice-sync logs point at the panel that actually supplied rows.
  workChecklistSyncPendingMarkdown = selected.markdown;
  workChecklistSyncPendingPlanMeta = {
    ...(selected.meta || {}),
    source: selected.source || selected.meta?.source || "sync_source_candidate",
    created_at: selected.meta?.created_at || Date.now()
  };
  showWorkChecklistSyncPreview(formatChecklistProposalText(rows));
  const previewPanel = document.getElementById("vera-wm-checklist-sync-preview");
  const previewOpened = previewPanel instanceof HTMLElement ? !previewPanel.hidden : false;
  logPlanSyncDebug("voice_sync_request", {
    user_text: userText,
    active_panel_id: ctx.active_panel_id,
    active_panel_title: ctx.active_panel_title,
    last_plan_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
    last_plan_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
    selected_source_panel_id: selected.meta?.panel_id || null,
    selected_source_panel_title: selected.meta?.panel_title || "",
    sync_candidate_count: rows.length,
    opened_preview: previewOpened,
    auto_applied: false,
    reason_if_failed: previewOpened ? "" : "preview_did_not_open",
    trigger_source: "voice_or_typed_shortcut_completed"
  });
  syncWorkChecklistSyncPlanButton();
  return true;
}

let workChecklistPlanHintTimer = null;
function flashWorkChecklistPlanHint(message) {
  const el = document.getElementById("vera-wm-checklist-plan-hint");
  if (!el) return;
  if (workChecklistPlanHintTimer) {
    window.clearTimeout(workChecklistPlanHintTimer);
    workChecklistPlanHintTimer = null;
  }
  el.textContent = message;
  workChecklistPlanHintTimer = window.setTimeout(() => {
    el.textContent = "";
    workChecklistPlanHintTimer = null;
  }, 4500);
}

function buildWorkChecklistHelpPlanUserMessage(planContext) {
  const ctx =
    planContext && Array.isArray(planContext.main_items)
      ? planContext
      : buildChecklistPlanHierarchyFromStorage();
  const cap = (ctx.main_items || []).slice(0, WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT);
  const bodyParts = [];
  for (let i = 0; i < cap.length; i += 1) {
    const main = cap[i];
    bodyParts.push(`${i + 1}. ${main.text}`);
    for (const child of main.children || []) {
      bodyParts.push(`   - ${child.text}`);
    }
  }
  const body = bodyParts.join("\n");
  return (
    workModePlanningTimeInjectionPrefix() +
    "[Planning help. Be detailed in your reasoning output. First provide a concise plan explanation and practical tips. Then include a dedicated markdown heading exactly: '## SYNC CHECKLIST'. Under that heading, output checklist-ready bullets only with strict format: top-level bullet must be [time-time]: specific task title, and each top-level task must have 1 to 3 indented substeps (never 0, never more than 3). Substeps should be concrete and short, like focused work chunks. Schedule only at or after CURRENT LOCAL TIME unless the user implies otherwise. In the SYNC CHECKLIST section do NOT include questions, question sections, or question marks.]\n\n" +
    "CHECKLIST HIERARCHY RULES:\n" +
    "- Top-level items below are the MAIN tasks for scheduling (max one time block per main task).\n" +
    "- Indented sub-items are details, constraints, or substeps of their parent — NOT separate main tasks.\n" +
    "- Do NOT give sub-items their own top-level time blocks unless the user explicitly asked to split them out.\n" +
    "- When planning, combine parent + sub-items in wording (e.g. 'English homework — Odyssey essay').\n\n" +
    "Ongoing checklist (main items with sub-details):\n" +
    body
  );
}

let workChecklistPlanRequestInFlight = false;
let activeChecklistPlanContext = null;

function resetActiveChecklistPlanContext() {
  activeChecklistPlanContext = null;
}

function beginActiveChecklistPlanContext({ source, userText, isVoice } = {}) {
  activeChecklistPlanContext = {
    requested: true,
    accepted: false,
    rendered: false,
    validationFailed: false,
    suppressGenericUnavailable: false,
    userFacingMessage: "",
    isVoice: Boolean(isVoice),
    source: String(source || ""),
    userText: String(userText || "").slice(0, 240),
  };
  try {
    console.info("[checklist_plan_requested]", {
      source: activeChecklistPlanContext.source,
      is_voice: activeChecklistPlanContext.isVoice,
      raw_text: activeChecklistPlanContext.userText,
    });
  } catch (_) {}
  return activeChecklistPlanContext;
}

function markChecklistPlanAccepted() {
  if (!activeChecklistPlanContext) return;
  activeChecklistPlanContext.accepted = true;
  activeChecklistPlanContext.suppressGenericUnavailable = true;
}

function markChecklistPlanRendered() {
  if (!activeChecklistPlanContext) return;
  activeChecklistPlanContext.rendered = true;
  activeChecklistPlanContext.suppressGenericUnavailable = true;
}

function markChecklistPlanValidationFailed(message) {
  if (!activeChecklistPlanContext) return;
  activeChecklistPlanContext.validationFailed = true;
  activeChecklistPlanContext.suppressGenericUnavailable = true;
  activeChecklistPlanContext.userFacingMessage = String(message || "").slice(0, 400);
  try {
    console.info("[checklist_plan_validation_failed]", {
      message: activeChecklistPlanContext.userFacingMessage,
      raw_text: activeChecklistPlanContext.userText,
    });
  } catch (_) {}
}

function shouldSuppressChecklistPlanGenericUnavailable() {
  const ctx = activeChecklistPlanContext;
  if (!ctx) return false;
  if (ctx.validationFailed) return true;
  if (ctx.rendered) return true;
  if (ctx.accepted && ctx.suppressGenericUnavailable) return true;
  return false;
}

/** Voice/typed checklist help-plan (same intent family as backend checklist.plan). */
const WORK_CHECKLIST_PLAN_SHORTCUT_RE =
  /(?:\b(?:help\s+me\s+)?(?:can\s+you\s+|could\s+you\s+|will\s+you\s+|please\s+)?(?:plan|planning|roadmap|prioriti[sz]e|break\s*(?:it\s*)?down|organi[sz]e|make\s+a\s+plan|create\s+a\s+plan)\b.{0,80}?\b(?:check\s*list|checklist|to-?do|todo|task\s*list|tasks?)\b|\bplan\s+(?:using|with|from)\s+(?:the\s+|my\s+)?(?:check\s*list|checklist|to-?do|todo|task\s*list)\b|\b(?:help\s+me\s+)?plan\s+my\s+(?:check\s*list|checklist|to-?do|todo|tasks?)\b|\buse\s+(?:the\s+|my\s+)?(?:check\s*list|checklist|to-?do|todo|task\s*list)\s+to\s+(?:make|create)\s+a\s+plan\b)/i;

function isWorkChecklistPlanShortcutIntent(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/\bsync\s+(?:the\s+)?(?:plan|checklist|list|reasoning(?:\s+plan)?)\b/i.test(raw)) return false;
  if (WORK_CHECKLIST_PLAN_SHORTCUT_RE.test(raw)) return true;
  const t = raw.toLowerCase();
  const hasPlanVerb = /\b(plan|planning|roadmap|prioriti[sz]e|break\s*(it\s*)?down|organi[sz]e|make\s+a\s+plan|create\s+a\s+plan)\b/.test(t);
  const hasChecklistNoun = /\b(check\s*list|checklist|to-?do|todo|task list|tasks?)\b/.test(t);
  return hasPlanVerb && hasChecklistNoun;
}

/** Defer the frontend plan shortcut when the utterance is compound (plan + music/timer/etc.). */
function shouldDeferChecklistPlanShortcut(text) {
  if (!isWorkChecklistPlanShortcutIntent(text)) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  if (typeof detectCompoundActionFamilies === "function") {
    const compound = detectCompoundActionFamilies(t);
    if (compound.isCompound) {
      const families = Array.isArray(compound.families) ? compound.families : [];
      const deferFamilies = families.filter((f) => f !== "checklist_plan" && f !== "reasoning");
      if (!deferFamilies.length) {
        return false;
      }
      logChecklistPlanDebug("shortcut_deferred", {
        reason: "compound_action",
        raw_text: t.slice(0, 240),
        families,
        defer_families: deferFamilies,
      });
      return true;
    }
  }
  const hasConnector = /\b(?:and|then|also|plus|next)\b/i.test(t);
  if (
    hasConnector &&
    /\b(?:play|pause|resume|skip|start|set|cancel|sync|switch|go\s+to|open|close|navigate|jump)\b/i.test(t)
  ) {
    logChecklistPlanDebug("shortcut_deferred", {
      reason: "connector_with_secondary_action",
      raw_text: t.slice(0, 240),
    });
    return true;
  }
  return false;
}

/**
 * Shared checklist.plan execution (Plan button, voice shortcut, planner ui_payload).
 * Returns { ok, reason?, message? }.
 */
async function executeChecklistPlanAction({ signal, isVoice, source, userText } = {}) {
  const raw = String(userText || "").trim();
  const src = String(source || (isVoice ? "voice" : "typed"));
  beginActiveChecklistPlanContext({ source: src, userText: raw, isVoice });
  logChecklistPlanDebug("action_detected", { raw_text: raw.slice(0, 240), source: src });
  if (!isVeraWorkModeOn()) {
    resetActiveChecklistPlanContext();
    return { ok: false, reason: "not_work_mode" };
  }
  if (workChecklistPlanRequestInFlight) {
    resetActiveChecklistPlanContext();
    return { ok: true, reason: "already_in_flight" };
  }
  const validation =
    typeof validateChecklistPlanRequest === "function"
      ? validateChecklistPlanRequest()
      : { ok: collectWorkChecklistOngoingTexts().length > 0, context: null, message: "Add text to at least one ongoing item first." };
  logChecklistPlanDebug("context", {
    main_count: validation.context?.main_count ?? validation.main_count ?? null,
    subitem_count: validation.context?.subitem_count ?? null,
    ok: validation.ok,
  });
  if (!validation.ok) {
    if (validation.reason === "too_many_main_items") {
      logChecklistPlanDebug("limit_exceeded", {
        main_count: validation.main_count,
        limit: WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT,
      });
    }
    markChecklistPlanValidationFailed(validation.message);
    flashWorkChecklistPlanHint(validation.message);
    if (isVoice) {
      finalizeWorkChecklistPlanBlockedTurn({
        transcript: raw || "plan my checklist",
        source: src,
        isVoice: true,
        message: validation.message,
      });
    } else {
      resetActiveChecklistPlanContext();
    }
    return { ok: false, reason: validation.reason || "validation_failed", message: validation.message };
  }
  const planContext = validation.context;
  const text = buildWorkChecklistHelpPlanUserMessage(planContext);
  const helpPlanBtn = document.getElementById("vera-wm-checklist-help-plan");
  workChecklistPlanRequestInFlight = true;
  if (helpPlanBtn instanceof HTMLButtonElement) helpPlanBtn.disabled = true;
  markChecklistPlanAccepted();
  const ackText =
    typeof getChecklistPlanStage1AckText === "function"
      ? getChecklistPlanStage1AckText(raw || "plan my checklist")
      : "Let me lay out a plan from your checklist.";
  try {
    console.info("[checklist_plan_ack_selected]", {
      ack_text: ackText,
      source: src,
      is_voice: Boolean(isVoice),
      main_count: planContext?.main_count ?? null,
    });
    console.info("[checklist_plan_reasoning_started]", {
      source: src,
      is_voice: Boolean(isVoice),
      main_count: planContext?.main_count ?? null,
    });
  } catch (_) {}
  logChecklistPlanDebug("action_start", { source: src, main_count: planContext?.main_count ?? null });
  try {
    if (isVoice && typeof beginChecklistPlanVoiceTurn === "function") {
      await beginChecklistPlanVoiceTurn({
        transcript: raw || "plan my checklist",
        source: src,
        ackText,
        signal,
      });
    }
    const reasoningScroll = getActiveReasoningScrollEl();
    if (reasoningScroll instanceof HTMLElement) {
      reasoningScroll.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    const turnContext = createWorkModeFrozenTurnContext({
      userText: text,
      source: isVoice ? "voice" : "keyboard",
    });
    await streamWorkModeReasoningComposer(text, signal, {
      turnContext,
      isChecklistPlanRequest: true,
    });
    const mdAfterHelp = getLatestWorkModeReasoningMarkdown();
    if (mdAfterHelp && /#{1,6}\s*SYNC CHECKLIST\b/i.test(mdAfterHelp)) {
      markChecklistPlanRendered();
      const rows = buildChecklistProposalFromMarkdown(mdAfterHelp);
      const activeLaneId = getActiveDomReasoningLaneId();
      const panelMeta = getPlanSyncPanelMetaForLane(activeLaneId);
      workChecklistSyncPlanVersion += 1;
      workChecklistSyncPendingMarkdown = mdAfterHelp;
      workChecklistSyncPendingPlanMeta = {
        ...panelMeta,
        source: "checklist_help_plan",
        created_at: Date.now(),
      };
      logPlanSyncDebug("created", {
        lane_id: panelMeta.lane_id || null,
        panel_id: panelMeta.panel_id || null,
        panel_title: panelMeta.panel_title || "",
        active_panel_id: panelMeta.active_panel_id || null,
        is_plan_detected: true,
        syncable: rows.length > 0,
        has_sync_metadata: true,
        sync_candidate_count: rows.length,
        sync_candidates_preview: planSyncPreviewRows(rows),
        reason_if_not_syncable: rows.length ? "" : "no_checklist_candidates_extracted",
        response_kind: "sync_checklist_markdown",
        route_kind: "checklist_help_plan",
        source: src,
      });
      syncWorkChecklistSyncPlanButton();
    }
    logChecklistPlanDebug("action_done", {
      success: true,
      source: src,
      panel_lane: getActiveDomReasoningLaneId?.() || null,
    });
    if (!isVoice) {
      resetActiveChecklistPlanContext();
    }
    return { ok: true };
  } catch (err) {
    logChecklistPlanDebug("action_done", {
      success: false,
      source: src,
      error: String(err?.message || err || "").slice(0, 200),
    });
    try {
      console.info("[checklist_plan_failed]", {
        source: src,
        is_voice: Boolean(isVoice),
        error: String(err?.message || err || "").slice(0, 200),
      });
    } catch (_) {}
    const failMsg =
      typeof CHECKLIST_PLAN_FAILURE_MESSAGE === "string"
        ? CHECKLIST_PLAN_FAILURE_MESSAGE
        : "I couldn't create the checklist plan. Please try again.";
    if (isVoice && typeof finalizeChecklistPlanVoiceTurn === "function") {
      finalizeChecklistPlanVoiceTurn({
        transcript: raw || "plan my checklist",
        source: src,
        isVoice: true,
        success: false,
        message: failMsg,
      });
    } else {
      flashWorkChecklistPlanHint(failMsg);
      resetActiveChecklistPlanContext();
    }
    return { ok: false, reason: "planner_failed", message: failMsg };
  } finally {
    workChecklistPlanRequestInFlight = false;
    syncWorkChecklistHelpPlanButton();
  }
}

/** Voice/typed: sync checklist from latest reasoning plan (## SYNC CHECKLIST etc.). Checked before plan shortcut. */
function isWorkChecklistSyncCommandIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  const compact = t.replace(/\s+/g, " ");
  const hasSyncVerb = /\b(sync|synced|synchroniz(?:e|ed|ing))\b/.test(t);
  const hasChecklistWord = /\b(check\s*list|checklist|to-?do|todo|task\s*list|my\s+tasks?)\b/.test(t);
  const hasPlanWord = /\b(plan|planning|reasoning|schedule|tasks?)\b/.test(t);
  const hasApplyVerb = /\b(add|apply|copy|load|import|move|pull|put|send|turn|transfer|update|use)\b/.test(t);
  if (
    /^(hey\s+vera[,!\s]+)?(please\s+|can\s+you\s+|will\s+you\s+|could\s+you\s+|would\s+you\s+)?(just\s+)?sync(\s+(it|that|this|now))?\s*[.?!]*$/i.test(
      compact
    )
  ) {
    return true;
  }
  if (/^sync(\s+(it|that|this|now))?\s*[.?!]*$/i.test(compact)) return true;
  if (/\bsync\s+(that|it|this)\b/.test(t)) return true;
  if (hasSyncVerb && (hasChecklistWord || hasPlanWord)) return true;
  if (hasSyncVerb && /\b(from|with)\s+(my\s+)?(plan|reasoning)\b/.test(t)) return true;
  if (hasSyncVerb && /\b(the\s+)?plan\b/.test(t)) return true;
  if (hasApplyVerb && hasChecklistWord && /\b(plan|reasoning|that|this|it)\b/.test(t)) return true;
  if (/\b(make|create|fill|populate)\b.{0,80}\b(check\s*list|checklist|to-?do|todo|task\s*list)\b.{0,80}\b(from|with|using)\b.{0,40}\b(plan|reasoning|that|this|it)\b/.test(t)) {
    return true;
  }
  return false;
}

function queueWorkChecklistRowEnterAnimation(ulId, taskId) {
  const sid = String(taskId || "");
  if (!sid || !ulId) return;
  const run = () => {
    const ul = document.getElementById(ulId);
    if (!ul) return;
    const esc =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(sid)
        : sid.replace(/["\\]/g, "");
    const moved = ul.querySelector(`:scope > li[data-id="${esc}"]`);
    if (!(moved instanceof HTMLElement)) return;
    moved.classList.add("vera-wm-checklist-li-entering");
    const done = () => {
      moved.removeEventListener("animationend", done);
      moved.classList.remove("vera-wm-checklist-li-entering");
    };
    moved.addEventListener("animationend", done, { once: true });
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(run));
}

/* =========================
   STAGE 9 (additive): read-only debug accessor
========================= */

function getChecklistDebugState() {
  let storedItemCount = 0;
  let nonBlankStoredCount = 0;
  let completedStoredCount = 0;
  let completedCollapsed = false;
  try {
    const items = readChecklistItemsFromStorage();
    storedItemCount = items.length;
    for (const it of items) {
      if (!it || typeof it.text !== "string") continue;
      if (String(it.text).trim()) nonBlankStoredCount += 1;
      if (it.done) completedStoredCount += 1;
    }
  } catch (_) {}
  try {
    completedCollapsed = localStorage.getItem(_getActiveChecklistCollapsedStorageKey()) === "1";
  } catch (_) {}
  let ongoingDomCount = 0;
  let completedDomCount = 0;
  try {
    const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
    const completedUl = document.getElementById("vera-wm-checklist-completed");
    ongoingDomCount = ongoingUl ? ongoingUl.querySelectorAll(":scope > li").length : 0;
    completedDomCount = completedUl ? completedUl.querySelectorAll(":scope > li").length : 0;
  } catch (_) {}
  return {
    storage_key: _getActiveChecklistItemsStorageKey(),
    completed_collapsed_key: _getActiveChecklistCollapsedStorageKey(),
    account_storage_key: WORK_CHECKLIST_STORAGE_KEY,
    anonymous_storage_key: getAnonymousChecklistStorageKey(),
    help_plan_max_items: WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS,
    help_plan_max_main_items: WORK_CHECKLIST_PLAN_MAIN_ITEM_LIMIT,
    sync_preview_max_chars: WORK_CHECKLIST_SYNC_PREVIEW_MAX_CHARS,
    subitem_indent_threshold_px: WORK_CHECKLIST_SUBITEM_INDENT_THRESHOLD_PX,
    stored_item_count: storedItemCount,
    non_blank_stored_count: nonBlankStoredCount,
    completed_stored_count: completedStoredCount,
    completed_collapsed: completedCollapsed,
    ongoing_dom_count: ongoingDomCount,
    completed_dom_count: completedDomCount,
    drag_session: { ...workChecklistDragSession },
    sync_timer_active: workChecklistSyncTimer !== null,
    sync_inflight: workChecklistSyncInFlight !== null,
    local_mutation_version: workChecklistLocalMutationVersion,
    plan_sync_pending_has_markdown: Boolean(workChecklistSyncPendingMarkdown),
    plan_sync_pending_panel_id: workChecklistSyncPendingPlanMeta?.panel_id || null,
    plan_sync_pending_panel_title: workChecklistSyncPendingPlanMeta?.panel_title || "",
    plan_sync_plan_version: workChecklistSyncPlanVersion,
    plan_sync_consumed_plan_version: workChecklistSyncConsumedPlanVersion,
    plan_sync_preview_editing: workChecklistSyncPreviewEditing,
    plan_request_in_flight: workChecklistPlanRequestInFlight,
    active_sync_command: activeWorkChecklistSyncCommand || "",
    last_completed_sync_command_turn_id:
      lastCompletedWorkChecklistSyncCommandTurn?.turn_id || null,
    non_cancelable_after_commit_actions: [...NON_CANCELABLE_AFTER_COMMIT_ACTIONS],
    last_committed_non_cancelable_action_type:
      lastCommittedNonCancelableAction?.action_type || null,
    last_committed_non_cancelable_action_age_ms:
      lastCommittedNonCancelableAction
        ? Date.now() - lastCommittedNonCancelableAction.committed_at
        : null
  };
}

/* =========================
   SUPABASE ACCOUNT CHECKLIST SYNC (Phase 4b + 4c hardening)
   Canonical copy — also mirrored in users/checklistSupabaseSync.js for smoke tests.

   API split:
     /api/work-mode/checklist — session-scoped; voice planner compatibility.
     /api/checklist           — Supabase account persistence (durable source of truth when logged in).
========================= */

console.info("[checklist_supabase_sync_loaded]");

const WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY = "vera_wm_checklist_supabase_unsynced_v1";
const WORK_CHECKLIST_SB_RETRY_INTERVAL_MS = 45000;
let _checklistSbSaveInFlight = null;
let _checklistSbRetryInFlight = false;
let _checklistSbRetryTimer = null;
let _checklistSbSyncStatus = "synced";

function _checklistSbIsLoggedIn() {
  return (
    typeof isSupabaseUserAuthenticated === "function" &&
    isSupabaseUserAuthenticated()
  );
}

async function _checklistSbAwaitAuthToken(maxWaitMs = 4000) {
  if (typeof getSupabaseAccessToken !== "function") return null;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const token = await getSupabaseAccessToken();
    if (token) return token;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return null;
}

function _readLocalChecklistBundleForSupabase() {
  return {
    items: (() => {
      try {
        const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY) || "[]";
        const parsed = JSON.parse(raw);
        return stripChecklistPlaceholdersForPersist(Array.isArray(parsed) ? parsed : []);
      } catch (_) {
        return [];
      }
    })(),
    completed_collapsed: localStorage.getItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY) === "1",
  };
}

function _checklistSbCanRetry() {
  if (!_checklistSbIsLoggedIn()) return false;
  if (!_checklistSbIsOnline()) return false;
  if (!isWorkChecklistSupabaseUnsynced()) return false;
  return true;
}

async function retryChecklistSupabaseSyncIfUnsynced(reason) {
  if (!_checklistSbCanRetry()) return false;
  if (_checklistSbRetryInFlight || _checklistSbSaveInFlight) return false;

  _checklistSbRetryInFlight = true;
  _setChecklistSupabaseSyncStatus("retrying");
  const debug = _checklistSbSyncDebugCounts();
  console.info("[checklist_retry]", {
    reason: reason || "unknown",
    ...debug,
  });

  try {
    const ok = await syncWorkChecklistToSupabaseNow();
    if (ok) {
      _setChecklistSupabaseSyncStatus("synced");
      console.info("[checklist_retry]", {
        reason: reason || "unknown",
        outcome: "success",
        ..._checklistSbSyncDebugCounts(),
      });
    } else {
      _setChecklistSupabaseSyncStatus("failed");
      console.info("[checklist_retry]", {
        reason: reason || "unknown",
        outcome: "failed",
        ..._checklistSbSyncDebugCounts(),
      });
    }
    return ok;
  } finally {
    _checklistSbRetryInFlight = false;
  }
}

function wireChecklistSupabaseRetryListeners() {
  if (typeof window === "undefined" || window.__veraChecklistSbRetryWired) return;
  window.__veraChecklistSbRetryWired = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void retryChecklistSupabaseSyncIfUnsynced("visibility");
  });

  window.addEventListener("online", () => {
    void retryChecklistSupabaseSyncIfUnsynced("online");
  });

  if (_checklistSbRetryTimer) window.clearInterval(_checklistSbRetryTimer);
  _checklistSbRetryTimer = window.setInterval(() => {
    void retryChecklistSupabaseSyncIfUnsynced("interval");
  }, WORK_CHECKLIST_SB_RETRY_INTERVAL_MS);
}

function _checklistSbAuthPresent() {
  return Boolean(
    typeof getSupabaseAccessToken === "function" && _checklistSbIsLoggedIn()
  );
}

function _checklistSbIsOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function _checklistSbSyncDebugCounts() {
  const bundle = _readLocalChecklistBundleForSupabase();
  return {
    local_count: bundle.items.length,
    unsynced: isWorkChecklistSupabaseUnsynced(),
    auth_present: _checklistSbAuthPresent(),
    status: _checklistSbSyncStatus,
  };
}

function _setChecklistSupabaseSyncStatus(status) {
  _checklistSbSyncStatus = status;
  const el = document.getElementById("vera-checklist-sync-status");
  if (!(el instanceof HTMLElement)) return;
  if (!_checklistSbIsLoggedIn()) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const labels = {
    synced: "Checklist: synced to account",
    unsynced: "Checklist: not synced — will retry",
    retrying: "Checklist: syncing…",
    failed: "Checklist: sync failed — will retry",
  };
  const text = labels[status] || labels.unsynced;
  el.textContent = text;
  el.hidden = false;
  el.dataset.syncState = status;
}

function _markChecklistSupabaseUnsynced(unsynced) {
  try {
    if (unsynced) localStorage.setItem(WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY, "1");
    else localStorage.removeItem(WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY);
  } catch (_) {}
  _setChecklistSupabaseSyncStatus(unsynced ? "unsynced" : "synced");
}

function isWorkChecklistSupabaseUnsynced() {
  try {
    return localStorage.getItem(WORK_CHECKLIST_SUPABASE_UNSYNCED_KEY) === "1";
  } catch (_) {
    return false;
  }
}

function _applyChecklistBundleToLocalForSupabase(items, completed_collapsed) {
  if (!_checklistSbIsLoggedIn()) return false;
  const rows = stripChecklistPlaceholdersForPersist(Array.isArray(items) ? items : []);
  try {
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(rows));
    if (typeof completed_collapsed === "boolean") {
      localStorage.setItem(
        WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
        completed_collapsed ? "1" : "0"
      );
    }
  } catch (_) {
    return false;
  }
  loadWorkChecklistItems();
  applyWorkChecklistCompletedCollapseFromStorage();
  console.info("[checklist_account_hydrate_done]", { item_count: rows.length });
  return true;
}

async function syncWorkChecklistToSupabaseNow() {
  if (!_checklistSbIsLoggedIn()) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;

  const writeGen = _checklistAuthWriteGeneration;
  const token = await _checklistSbAwaitAuthToken();
  if (!token || writeGen !== _checklistAuthWriteGeneration || !_checklistSbIsLoggedIn()) {
    if (token && _checklistSbIsLoggedIn()) _markChecklistSupabaseUnsynced(true);
    return false;
  }

  const bundle = _readLocalChecklistBundleForSupabase();
  const itemCount = Array.isArray(bundle.items) ? bundle.items.length : 0;
  try {
    window.veraUsageOnChecklistMutation?.({
      op: "sync_start",
      sync_kind: "supabase",
      item_count: itemCount,
      source: "sync",
    });
  } catch (_) {}
  const run = async () => {
    if (writeGen !== _checklistAuthWriteGeneration || !_checklistSbIsLoggedIn()) return false;
    try {
      const res = await authFetch(authApiUrl("/api/checklist"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[VERA][CHECKLIST] supabase PUT failed", data);
        _markChecklistSupabaseUnsynced(true);
        try {
          window.veraUsageOnChecklistMutation?.({
            op: "sync_done",
            sync_kind: "supabase",
            item_count: itemCount,
            source: "sync",
            success: false,
            error_code: String(data?.detail || res.status).slice(0, 64),
            client_key: getSessionId(),
          });
        } catch (_) {}
        return false;
      }
      console.info("[checklist_put]", {
        item_count: bundle.items.length,
        saved_count: data.items_count,
        unsynced: false,
        auth_present: true,
      });
      _markChecklistSupabaseUnsynced(false);
      try {
        window.veraUsageOnChecklistMutation?.({
          op: "sync_done",
          sync_kind: "supabase",
          item_count: itemCount,
          source: "sync",
          success: true,
          client_key: getSessionId(),
        });
      } catch (_) {}
      return true;
    } catch (err) {
      console.warn("[VERA][CHECKLIST] supabase PUT error", err);
      _markChecklistSupabaseUnsynced(true);
      try {
        window.veraUsageOnChecklistMutation?.({
          op: "sync_done",
          sync_kind: "supabase",
          item_count: itemCount,
          source: "sync",
          success: false,
          error_code: String(err?.message || err || "sync_error").slice(0, 64),
          client_key: getSessionId(),
        });
      } catch (_) {}
      return false;
    }
  };

  if (_checklistSbSaveInFlight) {
    _checklistSbSaveInFlight = _checklistSbSaveInFlight.then(run, run);
  } else {
    _checklistSbSaveInFlight = run();
  }
  try {
    return await _checklistSbSaveInFlight;
  } finally {
    _checklistSbSaveInFlight = null;
  }
}

async function hydrateChecklistMergeOnLogin() {
  if (!_checklistSbIsLoggedIn()) return false;
  if (typeof authFetch !== "function" || typeof authApiUrl !== "function") return false;
  if (_checklistSbHydratePromise) return _checklistSbHydratePromise;

  _checklistSbHydratePromise = (async () => {
    try {
      const token = await _checklistSbAwaitAuthToken();
      if (!token) {
        console.warn("[VERA][CHECKLIST] merge hydrate skipped — no auth token");
        return false;
      }

      const local = readAnonymousChecklistBundle();
      console.info("[checklist_hydrate]", {
        phase: "request",
        local_count: local.items.length,
        merge_source: "anonymous_local_snapshot",
      });

      const res = await authFetch(authApiUrl("/api/checklist/merge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(local),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn("[VERA][CHECKLIST] merge hydrate failed", data);
        return false;
      }

      const appliedCount = Array.isArray(data.items) ? data.items.length : 0;
      console.info("[checklist_hydrate]", {
        phase: "response",
        local_count: local.items.length,
        remote_count: Number(data.remote_count) || 0,
        applied_count: appliedCount,
        unsynced: false,
        auth_present: true,
      });

      if (Array.isArray(data.items)) {
        _applyChecklistBundleToLocalForSupabase(data.items, data.completed_collapsed);
      }
      _markChecklistSupabaseUnsynced(false);
      queueWorkChecklistSyncToServer();
      return true;
    } catch (err) {
      console.warn("[VERA][CHECKLIST] merge hydrate error", err);
      return false;
    } finally {
      _checklistSbHydratePromise = null;
    }
  })();

  return _checklistSbHydratePromise;
}

wireChecklistSupabaseRetryListeners();

try {
  window.getChecklistDebugState = getChecklistDebugState;
  window.syncWorkChecklistToSupabaseNow = syncWorkChecklistToSupabaseNow;
  window.hydrateChecklistMergeOnLogin = hydrateChecklistMergeOnLogin;
  window.retryChecklistSupabaseSyncIfUnsynced = retryChecklistSupabaseSyncIfUnsynced;
  window.isWorkChecklistSupabaseUnsynced = isWorkChecklistSupabaseUnsynced;
  window.wireChecklistSupabaseRetryListeners = wireChecklistSupabaseRetryListeners;
  window.clearChecklistAfterLogout = clearChecklistAfterLogout;
  window.getAnonymousChecklistStorageKey = getAnonymousChecklistStorageKey;
  window.shouldSuppressChecklistPlanGenericUnavailable = shouldSuppressChecklistPlanGenericUnavailable;
  window.resetActiveChecklistPlanContext = resetActiveChecklistPlanContext;
  window.markChecklistPlanValidationFailed = markChecklistPlanValidationFailed;
  window.markChecklistPlanRendered = markChecklistPlanRendered;
  if (isWorkChecklistSupabaseUnsynced()) {
    _setChecklistSupabaseSyncStatus("unsynced");
  }
  console.info("[checklist_supabase_sync_ready]", {
    hydrate: typeof window.hydrateChecklistMergeOnLogin,
    put: typeof window.syncWorkChecklistToSupabaseNow,
    retry: typeof window.retryChecklistSupabaseSyncIfUnsynced,
  });
} catch (_) {}
