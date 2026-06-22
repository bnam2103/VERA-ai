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
 *      24-item help-plan cap, 12000-char preview cap, 80-row proposal
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
let workChecklistSyncTimer = null;
let workChecklistHydrationPromise = null;
let workChecklistLocalMutationVersion = 0;
let workChecklistSyncInFlight = null;

function markWorkChecklistLocalMutation() {
  workChecklistLocalMutationVersion += 1;
}

function readChecklistItemsFromStorage() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY) || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function queueWorkChecklistSyncToServer() {
  markWorkChecklistLocalMutation();
  if (workChecklistSyncTimer) window.clearTimeout(workChecklistSyncTimer);
  workChecklistSyncTimer = window.setTimeout(async () => {
    workChecklistSyncTimer = null;
    await syncWorkChecklistToServerNow();
  }, 180);
}

async function syncWorkChecklistToServerNow() {
  if (workChecklistSyncInFlight) return workChecklistSyncInFlight;
  workChecklistSyncInFlight = (async () => {
    try {
      const items = readChecklistItemsFromStorage();
      const completedCollapsed = localStorage.getItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY) === "1";
      await authFetch(authApiUrl("/api/work-mode/checklist"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: getSessionId(),
          items,
          completed_collapsed: completedCollapsed
        })
      });
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
  if (!force && workChecklistHydrationPromise) return workChecklistHydrationPromise;
  const startVersion = workChecklistLocalMutationVersion;
  workChecklistHydrationPromise = (async () => {
    try {
      const res = await authFetch(
        `${authApiUrl("/api/work-mode/checklist")}?session_id=${encodeURIComponent(getSessionId())}`,
        { method: "GET" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.items)) return;
      if (!force && startVersion !== workChecklistLocalMutationVersion) return;
      localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(data.items));
      if (typeof data.completed_collapsed === "boolean") {
        localStorage.setItem(
          WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
          data.completed_collapsed ? "1" : "0"
        );
      }
      loadWorkChecklistItems();
    } catch (_) {
      /* keep local storage fallback */
    }
  })();
  await workChecklistHydrationPromise;
}

/* =========================
   CLOSE-PANEL DISAMBIGUATION HELPER (Spec PART 13)
   Phrases that look like checklist mutations should not trigger panel
   closes. Used by the reasoning-panel close-shortcut path in app.js.
========================= */
function _looksLikeChecklistCommand(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  /* "remove/delete/mark/check ... item/task/bullet/checklist ..." */
  if (/\b(?:remove|delete|cross\s+off|check\s+off|uncheck|mark)\s+(?:the\s+)?(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)?\s*(?:and\s+(?:first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th)?)\s*)?(?:item|task|bullet|checklist|to[- ]?do|todo|step)s?\b/.test(t)) {
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
const CHECKLIST_COMPLETE_VERB_RE =
  /\b(?:complete|completed|done|finish|finished|mark|check\s+off|tick\s+off)\b/i;
const CHECKLIST_UPDATE_VERB_RE = /\b(?:update|replace|rename|change)\b/i;

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
      try {
        const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
        const items = raw ? JSON.parse(raw) : [];
        exists = Array.isArray(items) && items.length > 0;
      } catch (_) {}
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
  const completeVerb = CHECKLIST_COMPLETE_VERB_RE.test(latest);
  const updateVerb = CHECKLIST_UPDATE_VERB_RE.test(latest);
  const indices = parseChecklistOrdinals(latest);
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

function readChecklistItemsFromStorageSafe() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeChecklistItemsToStorageSafe(items) {
  try {
    markWorkChecklistLocalMutation();
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
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
  const ongoingIds = [...ongoingUl.querySelectorAll(":scope > li")].map((el) => el.dataset.id).filter(Boolean);
  const completedIds = [...completedUl.querySelectorAll(":scope > li")].map((el) => el.dataset.id).filter(Boolean);
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const map = new Map(items.map((x) => [String(x.id), x]));
    const next = [...ongoingIds, ...completedIds].map((id) => map.get(id)).filter(Boolean);
    if (next.length !== items.length) return;
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(next));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

function applyWorkChecklistCompletedCollapseFromStorage() {
  const pane = document.getElementById("vera-wm-checklist-pane");
  const btn = document.getElementById("vera-wm-checklist-completed-toggle");
  if (!pane || !btn || pane.classList.contains("vera-wm-checklist-pane--ongoing-only")) return;
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY) === "1";
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
      localStorage.setItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY, collapsed ? "1" : "0");
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
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items) || items.length < 2) return false;
    const first = items[0];
    if (!first || typeof first.text !== "string" || Boolean(first.done)) return false;
    if (String(first.text).trim() !== "") return false;
    if (!items.slice(1).some((x) => x && Boolean(x.done))) return false;
    const [head, ...rest] = items;
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify([...rest, head]));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

/** Drops empty ongoing rows except the bottom-most one (storage order among !done items). */
function pruneInteriorEmptyOngoingItems() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const valid = (x) => x && typeof x.text === "string";
    const ongoingIndices = [];
    for (let i = 0; i < items.length; i += 1) {
      if (valid(items[i]) && !Boolean(items[i].done)) ongoingIndices.push(i);
    }
    if (ongoingIndices.length <= 1) return false;
    const toRemove = [];
    for (let j = 0; j < ongoingIndices.length - 1; j += 1) {
      const i = ongoingIndices[j];
      if (String(items[i].text).trim() === "") toRemove.push(i);
    }
    if (toRemove.length === 0) return false;
    toRemove.sort((a, b) => b - a);
    for (const i of toRemove) items.splice(i, 1);
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

/** Ensures the last ongoing row is always an empty slot for new text (no separate “+” row). */
function ensureWorkChecklistTrailingEmptyOngoing() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const valid = (x) => x && typeof x.text === "string";
    let lastOngoingIndex = -1;
    for (let i = 0; i < items.length; i += 1) {
      if (valid(items[i]) && !Boolean(items[i].done)) lastOngoingIndex = i;
    }
    const lastOngoing = lastOngoingIndex >= 0 ? items[lastOngoingIndex] : null;
    const needNew =
      lastOngoingIndex < 0 || !lastOngoing || String(lastOngoing.text).trim() !== "";
    if (!needNew) return false;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    /* When there are no ongoing rows yet, append at list end — never splice(0,0) or the empty slot sits above completed items in storage order. */
    if (lastOngoingIndex < 0) {
      items.push({ id, text: "", done: false, parent_id: null });
    } else {
      items.splice(lastOngoingIndex + 1, 0, { id, text: "", done: false, parent_id: null });
    }
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return true;
  } catch (_) {
    return false;
  }
}

/** Insert a new empty ongoing row immediately after the given ongoing item (by storage order). */
function insertWorkChecklistEmptyOngoingAfter(afterId) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    const idx = items.findIndex((x) => x && String(x.id) === String(afterId));
    if (idx < 0) return null;
    const row = items[idx];
    if (!row || typeof row.text !== "string" || Boolean(row.done)) return null;
    const nid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    items.splice(idx + 1, 0, { id: nid, text: "", done: false, parent_id: null });
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
    return nid;
  } catch (_) {
    return null;
  }
}

function loadWorkChecklistItems() {
  const ongoingUl = document.getElementById("vera-wm-checklist-ongoing");
  const completedUl = document.getElementById("vera-wm-checklist-completed");
  if (!ongoingUl || !completedUl) return;
  ensureWorkChecklistListDnD();
  normalizeWorkChecklistLeadingPlaceholderInStorage();
  /* Do not call pruneInteriorEmptyOngoingItems on load — it would remove intentional mid-list empties from Enter. */
  let guard = 0;
  while (ensureWorkChecklistTrailingEmptyOngoing()) {
    guard += 1;
    if (guard > 10) break;
  }
  let items = [];
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    if (raw) items = JSON.parse(raw);
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }
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
        const newId = insertWorkChecklistEmptyOngoingAfter(id);
        loadWorkChecklistItems();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            const ul = document.getElementById("vera-wm-checklist-ongoing");
            const sel = newId
              ? `li[data-id="${newId}"] .vera-wm-checklist-task-input`
              : "li:last-child .vera-wm-checklist-task-input";
            const nextInp = ul?.querySelector(sel);
            if (nextInp instanceof HTMLInputElement) nextInp.focus();
          });
        });
      });
      inp.addEventListener("blur", () => {
        window.setTimeout(() => {
          const next = document.activeElement;
          if (next && li.contains(next)) {
            persistWorkChecklistUpdateText(id, inp.value);
            return;
          }
          persistWorkChecklistUpdateText(id, inp.value);
          /* replaceChildren (e.g. after Enter) detaches this row; blur still fires — do not treat as “abandon middle empty”. */
          if (!li.isConnected) return;
          const ul = document.getElementById("vera-wm-checklist-ongoing");
          const siblings = ul ? [...ul.querySelectorAll(":scope > li")] : [];
          const rowIdx = siblings.indexOf(li);
          if (rowIdx < 0) return;
          const isLastOngoing = rowIdx === siblings.length - 1;
          let removedMiddle = false;
          if (!inp.value.trim() && !isLastOngoing) {
            persistWorkChecklistRemove(id);
            removedMiddle = true;
          }
          /* Do not prune all interior empties on every blur — that removed a new Enter row when focus moved to another item. */
          const ensured = ensureWorkChecklistTrailingEmptyOngoing();
          if (removedMiddle || ensured) loadWorkChecklistItems();
        }, 0);
      });
      li.appendChild(handle);
      li.appendChild(cb);
      li.appendChild(inp);
      li.appendChild(actions);
    }
    (it.done ? completedUl : ongoingUl).appendChild(li);
  });

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
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    items = items.map((x) =>
      String(x.id) === id ? { ...x, done: Boolean(done) } : x
    );
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
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
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];

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
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

function persistWorkChecklistUpdateText(id, text) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    items = items.map((x) => (String(x.id) === id ? { ...x, text: String(text) } : x));
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

function persistWorkChecklistRemove(id) {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    let items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) items = [];
    items = items.filter((x) => String(x.id) !== id);
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
  } catch (_) {}
}

/* =========================
   NON-CANCELABLE-AFTER-COMMIT BOOKKEEPING

   Sync, add, remove, update, toggle, and timer actions persist BEFORE the
   spoken confirmation. Interrupting the confirmation must NEVER walk back
   the already-committed state — only the spoken audio is cancelled.
========================= */

const WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS = 24;
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
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    checklistCount = Array.isArray(items)
      ? items.filter((x) => x && String(x.text || "").trim()).length
      : 0;
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

function collectWorkChecklistOngoingTexts() {
  const ul = document.getElementById("vera-wm-checklist-ongoing");
  if (!ul) return [];
  const out = [];
  for (const li of ul.querySelectorAll(":scope > li")) {
    const inp = li.querySelector(".vera-wm-checklist-task-input");
    if (inp instanceof HTMLInputElement) {
      const t = inp.value.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function workChecklistHasAnyStoredItems() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) && items.length > 0;
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
  btn.disabled = collectWorkChecklistOngoingTexts().length === 0;
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
  const source = syncBlockMatch ? syncBlockMatch[1] : full;
  const hasExplicitSyncBlock = Boolean(syncBlockMatch);
  const planishMarkdown = /\b(plan|schedule|outline|essay|draft|revise|revision|research|write|study|prepare|time\s*block|hour|deadline|due)\b/i.test(
    full.slice(0, 5000)
  );
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
        // Preferred plan output has `[time-time]: task` top-level bullets, but
        // real planning turns sometimes produce normal bullets. If the markdown
        // is explicitly a sync block, or the saved pending turn is clearly a
        // plan, accept practical top-level bullets so the Sync button does not
        // disappear after a useful plan.
        if (!hasExplicitSyncBlock && !timeTitlePattern.test(text) && !planishMarkdown) continue;
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
  if (!cleaned.length && planishMarkdown) {
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
  if (!rows.length) return [];
  const out = [];
  let parentId = null;
  for (const row of rows) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (row.depth === 0) parentId = id;
    out.push({
      id,
      text: row.text,
      done: false,
      parent_id: row.depth > 0 ? parentId : null
    });
  }
  out.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: "",
    done: false,
    parent_id: null
  });
  return out;
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
    markWorkChecklistLocalMutation();
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(items));
    queueWorkChecklistSyncToServer();
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
  try {
    markWorkChecklistLocalMutation();
    localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify([]));
    queueWorkChecklistSyncToServer();
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

function buildWorkChecklistHelpPlanUserMessage(lines) {
  const cap = lines.slice(0, WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS);
  const body = cap.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const more =
    lines.length > WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS
      ? `\n… (${lines.length - WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS} more items not shown)\n`
      : "";
  return (
    workModePlanningTimeInjectionPrefix() +
    "[Planning help. Be detailed in your reasoning output. First provide a concise plan explanation and practical tips. Then include a dedicated markdown heading exactly: '## SYNC CHECKLIST'. Under that heading, output checklist-ready bullets only with strict format: top-level bullet must be [time-time]: specific task title, and each top-level task must have 1 to 3 indented substeps (never 0, never more than 3). Substeps should be concrete and short, like focused work chunks. Schedule only at or after CURRENT LOCAL TIME unless the user implies otherwise. In the SYNC CHECKLIST section do NOT include questions, question sections, or question marks.]\n\n" +
    "Ongoing checklist (in order):\n" +
    body +
    more
  );
}

let workChecklistPlanRequestInFlight = false;

function isWorkChecklistPlanShortcutIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;
  const hasPlanVerb = /\b(plan|planning|roadmap|prioriti[sz]e|break\s*(it\s*)?down|organi[sz]e)\b/.test(t);
  const hasChecklistNoun = /\b(check\s*list|checklist|to-?do|todo|task list|tasks?)\b/.test(t);
  const directPhrase = /\b(help me plan|can you help me plan)\b/.test(t);
  return (hasPlanVerb && hasChecklistNoun) || (directPhrase && hasChecklistNoun);
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
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY);
    const items = raw ? JSON.parse(raw) : [];
    if (Array.isArray(items)) {
      storedItemCount = items.length;
      for (const it of items) {
        if (!it || typeof it.text !== "string") continue;
        if (String(it.text).trim()) nonBlankStoredCount += 1;
        if (it.done) completedStoredCount += 1;
      }
    }
  } catch (_) {}
  try {
    completedCollapsed = localStorage.getItem(WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY) === "1";
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
    storage_key: WORK_CHECKLIST_STORAGE_KEY,
    completed_collapsed_key: WORK_CHECKLIST_COMPLETED_COLLAPSED_KEY,
    help_plan_max_items: WORK_CHECKLIST_HELP_PLAN_MAX_ITEMS,
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

try {
  window.getChecklistDebugState = getChecklistDebugState;
} catch (_) {}
