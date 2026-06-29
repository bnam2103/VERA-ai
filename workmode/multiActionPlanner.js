/* =========================================================================
 *  workmode/multiActionPlanner.js -- legacy frontend Work Mode multi-
 *  action planner (banner + constants + helpers + plan/should/log/
 *  maybeRun/execute).
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-06-01, Patch B-5). Verbatim move of the original
 *  "WORK MODE MULTI-ACTION PLANNER" banner section at app.js
 *  L22140..L22839 (700 LF-terminated source lines, re-terminated as
 *  CRLF here to match this file's native line endings).
 *
 *  Patch B-5 is RELOCATION ONLY. Planner decisions, the recursive
 *  dispatch via __skipMultiActionPlanner, gate behavior, debug logs
 *  ([wm_multi_action_planner] tag + payload schema), and backend
 *  planner integration are byte-identical to the pre-patch state.
 *  The frontend planner is intentionally bypassed in the typed Work
 *  Mode path -- that decision lives in the inline GATE block inside
 *  sendVeraWorkModeTypedInferTurn (still in app.js) and is preserved
 *  exactly. The "fall-through to legacy planner" fallback path,
 *  reachable when opts.__skipMultiActionPlanner === true is NOT set,
 *  is also preserved (PART 1 gate + PART 4 ordering + PART 7
 *  executor).
 *
 *  -----------------------------------------------------------------
 *  Public surface (declared as bare identifiers; visible to every
 *  later classic <script> through the shared GlobalDeclarativeRecord
 *  at CALL time):
 *    - const WORK_MODE_PLANNER_ORDINAL_TO_NUM
 *    - const WORK_MODE_PLANNER_ORDINAL_KEYS
 *    - const WORK_MODE_PLANNER_CONNECTOR_RE
 *    - const WORK_MODE_PLANNER_CONNECTOR_GLOBAL_RE
 *    - const WORK_MODE_PLANNER_IN_PANEL_RE
 *    - const WORK_MODE_PLANNER_IN_ORDINAL_PANEL_RE
 *    - const WORK_MODE_PLANNER_PANEL_NUMBER_RE
 *    - const WORK_MODE_PLANNER_ORDINAL_PANEL_RE
 *    - function _wmpResolveOrdinalOrNum(token)
 *    - function _wmpExtractPanelTarget(text)
 *    - function _wmpStripImplicitTargetPhrase(text)
 *    - function _wmpStripLeadingPoliteness(text)
 *    - function _wmpDetectActionType(segment)
 *    - function _wmpSplitOnConnectors(text)
 *    - function _wmpOrderActionsByDependency(actions)
 *    - function _wmpRiskLevelForType(actionType)
 *    - function planWorkModeMultiAction(text, context)
 *    - function shouldUseWorkModeMultiActionPlanner(text, opts)
 *    - function logWorkModeMultiActionPlannerDecision(payload)
 *    - async function maybeRunWorkModeMultiActionPlanner(text, opts)
 *    - async function executeWorkModeActionPlan(plan, context)
 *
 *  -----------------------------------------------------------------
 *  Load order
 *  -----------------------------------------------------------------
 *  This file is loaded AFTER workmode/panels.js + workmode/checklist.js
 *  and BEFORE news/* + app.js + debug/*. Rationale:
 *
 *    - The executor (executeWorkModeActionPlan) calls activateReasoning-
 *      Tab and addReasoningTab as bare identifiers; both live in
 *      workmode/panels.js. Loading after panels.js keeps the look-up
 *      reachable at call time (deferred from parse time anyway, but
 *      the order documents the dependency).
 *
 *    - The inline GATE block inside sendVeraWorkModeTypedInferTurn
 *      (still in app.js) calls shouldUseWorkModeMultiActionPlanner,
 *      planWorkModeMultiAction, logWorkModeMultiActionPlannerDecision,
 *      and executeWorkModeActionPlan as bare identifiers; loading
 *      before app.js puts our declarations in the shared global
 *      lexical env before app.js is parsed.
 *
 *  -----------------------------------------------------------------
 *  Bare-identifier references in the moved code (resolved at CALL
 *  TIME through the shared global lexical environment):
 *    isVeraWorkModeOn, appModePrefix     app.js helpers.
 *    sendVeraWorkModeTypedInferTurn      app.js (TEXT INPUT PIPELINE
 *                                        section just below the
 *                                        stub).
 *    activateReasoningTab, addReasoningTab
 *                                        workmode/panels.js.
 *    ensureChatStartedLayout, addBubble  app.js UI helpers.
 *    _wmCleanedExecutionTextsFromPlan,
 *      _wmMarkOriginalUserBubbleRendered,
 *      _wmHoldOriginalUserBubble,
 *      _wmReleaseOriginalUserBubbleHold,
 *      _wmNormalizeForSegmentMatch,
 *      _readLatestUserBubbleText,
 *      logWorkModeCommandDisplayText     app.js (L825..L1028 region).
 *
 *  -----------------------------------------------------------------
 *  Preserved invariants (Patch B-5 hard rules)
 *  -----------------------------------------------------------------
 *    - Planner decisions unchanged (regex set + verb classifier +
 *      connector split + ordering + risk + dependency edges).
 *    - Recursive dispatch via __skipMultiActionPlanner unchanged.
 *    - PART 4 ordering rule unchanged (close < select < open <
 *      content; content dependsOn last target).
 *    - Debug log tag "[wm_multi_action_planner]" + payload schema
 *      unchanged (plan_decision, planner_exception, execution_started,
 *      action_result, execution_complete, executor_exception).
 *    - Backend planner integration unchanged: the inline GATE block
 *      in sendVeraWorkModeTypedInferTurn (still in app.js) still
 *      defers typed Work Mode commands to the backend, and the
 *      legacy planner fallback at the else branch is preserved.
 *    - No behavior cleanup: dead code, comments, and breadcrumb
 *      docstrings retained verbatim.
 * ========================================================================= */

/* =========================
   WORK MODE MULTI-ACTION PLANNER
   ----------------------------------------------------------------------
   Spec: compound commands like "go to panel 2 and explain the Vietnam
   War" used to lose the second action because the panel-navigation
   route in the backend action router would match first and return,
   dropping the reasoning generation. The planner runs BEFORE the
   existing Work Mode single-action shortcuts and the backend /infer
   router so it can split a compound request into ordered actions and
   dispatch each one through the existing handlers.

   Scope is intentionally narrow:
     - Only fires inside Work Mode (sendVeraWorkModeTypedInferTurn).
     - Only fires when planUserCommand returns isMultiAction:true.
     - Recursive calls from the executor pass __skipMultiActionPlanner
       so a segment never re-enters the planner.

   Design choices:
     - Pure regex / heuristic split (no LLM): preserves latency budget
       and avoids a new network hop for what is fundamentally a
       client-side dispatch problem.
     - The executor reuses existing single-action handlers
       (activateReasoningTab, addReasoningTab, sendVeraWorkModeTypedInferTurn
       with planner bypass). It does NOT re-implement checklist /
       music / news / reasoning routes — each segment goes through the
       existing pipeline so behaviour stays consistent.
     - Per PART 4 ordering rules, target/navigation actions
       (panel.select/open/close, news.open_panel) run before content
       actions (reasoning.generate, news.search), and dependsOn is
       added from the content action to the latest target action.
========================= */

const WORK_MODE_PLANNER_ORDINAL_TO_NUM = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
};

const WORK_MODE_PLANNER_ORDINAL_KEYS = Object.keys(WORK_MODE_PLANNER_ORDINAL_TO_NUM).join("|");

/* Connector regex used to split a compound command into ordered segments.
   Conservative on purpose — bare commas are NOT treated as connectors
   unless a second-segment verb is present (see _wmpSplitOnConnectors). */
const WORK_MODE_PLANNER_CONNECTOR_RE = new RegExp(
  "\\s*\\b(?:and(?:\\s+then)?|then|after(?:\\s+that)?|also|while\\s+you'?re\\s+at\\s+it|plus|next)\\b\\s*",
  "i"
);

const WORK_MODE_PLANNER_CONNECTOR_GLOBAL_RE = new RegExp(
  WORK_MODE_PLANNER_CONNECTOR_RE.source,
  "gi"
);

/* "in panel 2" / "in the reasoning panel 2" / "in the second panel" — the
   implicit target preposition that turns a single segment like
   "explain the Vietnam War in panel 2" into a multi-action plan. */
const WORK_MODE_PLANNER_IN_PANEL_RE = new RegExp(
  "\\bin\\s+(?:the\\s+)?(?:reasoning\\s+)?(?:panel|space|tab|page)\\s*#?\\s*(\\d+|" +
    WORK_MODE_PLANNER_ORDINAL_KEYS +
    ")\\b",
  "i"
);

const WORK_MODE_PLANNER_IN_ORDINAL_PANEL_RE = new RegExp(
  "\\bin\\s+(?:the\\s+)?(" +
    WORK_MODE_PLANNER_ORDINAL_KEYS +
    ")\\s+(?:reasoning\\s+)?(?:panel|space|tab|page)\\b",
  "i"
);

const WORK_MODE_PLANNER_PANEL_NUMBER_RE = new RegExp(
  "\\b(?:reasoning\\s+)?(?:panel|space|tab|page)\\s*#?\\s*(\\d+|" +
    WORK_MODE_PLANNER_ORDINAL_KEYS +
    ")\\b",
  "i"
);

const WORK_MODE_PLANNER_ORDINAL_PANEL_RE = new RegExp(
  "\\b(" +
    WORK_MODE_PLANNER_ORDINAL_KEYS +
    ")\\s+(?:reasoning\\s+)?(?:panel|space|tab|page)\\b",
  "i"
);

function _wmpResolveOrdinalOrNum(token) {
  const s = String(token || "").toLowerCase().trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return WORK_MODE_PLANNER_ORDINAL_TO_NUM[s] || null;
}

/** Returns 1-based panel index parsed from "panel 2" / "second panel" / "panel #3". */
function _wmpExtractPanelTarget(text) {
  const s = String(text || "");
  let m = s.match(WORK_MODE_PLANNER_PANEL_NUMBER_RE);
  if (m) {
    const n = _wmpResolveOrdinalOrNum(m[1]);
    if (n) return n;
  }
  m = s.match(WORK_MODE_PLANNER_ORDINAL_PANEL_RE);
  if (m) {
    const n = _wmpResolveOrdinalOrNum(m[1]);
    if (n) return n;
  }
  return null;
}

/** Remove the trailing "in panel 2" / "in the second panel" phrase so the residual
 *  text becomes a clean content prompt for reasoning.generate. */
function _wmpStripImplicitTargetPhrase(text) {
  return String(text || "")
    .replace(WORK_MODE_PLANNER_IN_PANEL_RE, "")
    .replace(WORK_MODE_PLANNER_IN_ORDINAL_PANEL_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([?.!,;:])/g, "$1")
    .replace(/^[\s'".,;:!?]+|[\s'".,;:!?]+$/g, "")
    .trim();
}

/** Strip leading politeness ("can you", "could you", "would you", "please")
 *  so the verb classifier can see the actual command word. Mirrors the
 *  same pattern app.py uses for its router shortcuts. */
function _wmpStripLeadingPoliteness(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  /* Run twice — handles "please can you" or "would you please". */
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/^\s*(?:please|kindly)\b[\s,]+/i, "")
      .replace(/^\s*(?:can|could|would|will)\s+you\b[\s,]+/i, "")
      .replace(/^\s*(?:hey\s+vera|hey|ok|okay|alright)\b[\s,]+/i, "");
  }
  return s.trim();
}

/** Classify a single segment into a PlannedAction.type using verb prefixes.
 *  Returns "unknown" / "general.reply" for non-actionable segments so the
 *  caller can decide whether to abort multi-action planning. */
function _wmpDetectActionType(segment) {
  const raw = String(segment || "").trim();
  if (!raw) return "unknown";
  const s = _wmpStripLeadingPoliteness(raw);
  if (!s) return "unknown";
  const t = s.toLowerCase();

  if (
    /^(?:go\s+(?:back\s+)?to|jump\s+to|switch\s+to|change\s+to|show|select|use)\s+(?:the\s+|a\s+|my\s+)?(?:reasoning\s+)?(?:panel|space|tab|page)\b/i.test(s) ||
    /^(?:go\s+(?:back\s+)?to|jump\s+to|switch\s+to|change\s+to|show|select|use)\s+(?:the\s+|a\s+|my\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth)\s+(?:reasoning\s+)?(?:panel|space|tab|page)\b/i.test(s)
  ) {
    return "panel.select";
  }
  if (/^(?:open(?:\s+up)?|create|make|add)\s+(?:(?:\d{1,2}|a|an|one|two|three|four|five|six|seven|eight)\s+)?(?:new\s+)?(?:reasoning\s+)?(?:panels?|spaces?|tabs?|pages?)\b/i.test(s)) {
    return "panel.open";
  }
  if (/^(?:open|create|make|add|new)\s+(?:a\s+)?(?:new\s+)?(?:reasoning\s+)?(?:panel|space|tab|page)\b/i.test(s)) {
    return "panel.open";
  }
  if (
    /^(?:close|hide|dismiss|get\s+rid\s+of)\s+(?:the\s+|a\s+|my\s+|all\s+)?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|current|active|last|this)?\s*(?:reasoning\s+)?(?:panel|space|tab|page)s?\b/i.test(s)
  ) {
    return "panel.close";
  }
  if (/^(?:open|show|bring\s+up|pull\s+up)\s+(?:the\s+)?news\s+(?:panel|tab|page|results)\b/i.test(s)) {
    return "news.open_panel";
  }
  if (/^(?:search|look\s+up|find|google)\s+(?:for\s+)?(?:news\s+(?:about|on|for)\s+)?/i.test(s)) {
    return "news.search";
  }
  if (/^(?:pause|stop|mute)\s+(?:the\s+)?music\b/i.test(s)) {
    return "music.pause";
  }
  if (/^(?:play|resume|start|unpause)\s+(?:the\s+|some\s+)?music\b/i.test(s)) {
    return "music.play";
  }
  if (/^add\s+.+?\s+(?:to\s+(?:the\s+|my\s+)?)?(?:checklist|plan|todo|to-do|to\s+do|list)\b/i.test(s)) {
    return "checklist.add";
  }
  if (/^(?:remove|delete|cross\s+off|check\s+off)\s+/i.test(s) && /\b(?:checklist|plan|todo|to-do|to\s+do|list|item|task|first|second|third|fourth|fifth)\b/i.test(t)) {
    return "checklist.remove";
  }
  if (/^(?:sync|update|push|refresh)\s+(?:the\s+|my\s+)?(?:plan|checklist|reasoning\s+plan)\b/i.test(s)) {
    return "checklist.sync";
  }
  if (/^(?:put|move|drop)\s+(?:that|this|it|the\s+(?:answer|last|latest|previous))\s+(?:in|into|to)\s+/i.test(s)) {
    return "reasoning.move_latest_voice_answer";
  }
  if (
    /^(?:explain|describe|tell\s+me\s+about|summari[sz]e|write|draft|compose|outline|analy[sz]e|compare|derive|prove|walk\s+me\s+through|break\s+down|teach\s+me)\b/i.test(s)
  ) {
    return "reasoning.generate";
  }
  return "general.reply";
}

/** Conservative connector split. Splits on " and "/" then "/etc., but only
 *  when the resulting right-hand side starts with a recognized action verb
 *  — avoids slicing "the cat and the dog" into two segments. */
function _wmpSplitOnConnectors(text) {
  const s = String(text || "").trim();
  if (!s) return [];
  const parts = [];
  let cursor = 0;
  WORK_MODE_PLANNER_CONNECTOR_GLOBAL_RE.lastIndex = 0;
  let match;
  while ((match = WORK_MODE_PLANNER_CONNECTOR_GLOBAL_RE.exec(s)) != null) {
    const before = s.slice(cursor, match.index).trim();
    const after = s.slice(match.index + match[0].length).trim();
    if (!before || !after) continue;
    /* Only treat this connector as a real split if the right-hand side
       starts with a recognizable Work Mode action verb. Otherwise leave
       it joined so phrasings like "the rise and fall of Rome" do not
       fragment unrelated noun phrases. */
    const rhsType = _wmpDetectActionType(after);
    if (rhsType === "unknown") continue;
    parts.push(before);
    cursor = match.index + match[0].length;
  }
  const tail = s.slice(cursor).trim();
  if (tail) parts.push(tail);
  if (!parts.length) return [s];
  return parts.map((p) => p.replace(/^[\s'".,;:!?]+|[\s'".,;:!?]+$/g, "").trim()).filter(Boolean);
}

/** Apply PART 4 ordering rules. Stable: target/navigation actions go first,
 *  then content actions; within each bucket text order is preserved. */
function _wmpOrderActionsByDependency(actions) {
  const TARGET_FIRST = new Set([
    "panel.close",
    "panel.open",
    "panel.select",
    "news.open_panel",
  ]);
  const CONTENT = new Set([
    "reasoning.generate",
    "reasoning.move_latest_voice_answer",
    "news.search",
    "general.reply",
  ]);

  const targets = [];
  const content = [];
  const other = [];
  for (const a of actions) {
    if (TARGET_FIRST.has(a.type)) targets.push(a);
    else if (CONTENT.has(a.type)) content.push(a);
    else other.push(a);
  }

  /* Within target bucket: close before select before open. This handles
     "close panel 1 and open a new one" cleanly. */
  const targetOrder = (t) =>
    t === "panel.close" ? 0 : t === "panel.select" ? 1 : t === "panel.open" ? 2 : 3;
  targets.sort((a, b) => {
    const da = targetOrder(a.type);
    const db = targetOrder(b.type);
    if (da !== db) return da - db;
    return 0; // stable
  });

  const ordered = [...targets, ...content, ...other];

  /* Add dependsOn from content actions to the LAST target action so the
     executor can stop content if navigation fails. Independent app
     actions (checklist+music) get no dependsOn — they execute in
     text order without blocking each other. */
  if (targets.length && content.length) {
    const lastTargetId = targets[targets.length - 1].id;
    for (const c of content) {
      if (!Array.isArray(c.dependsOn)) c.dependsOn = [];
      if (!c.dependsOn.includes(lastTargetId)) c.dependsOn.push(lastTargetId);
    }
  }

  return ordered;
}

/** PART 10: risk classification for an action type. */
function _wmpRiskLevelForType(actionType) {
  if (actionType === "panel.close" || actionType === "checklist.remove") return "medium";
  return "low";
}

/**
 * planUserCommand({ text, context }) — see PART 2/3 of the spec.
 *
 * Returns null when the request is single-action (or empty) so the
 * caller can fall through to the existing single-action router.
 * Returns a plan object otherwise.
 */
function planWorkModeMultiAction(text, context = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const segments = _wmpSplitOnConnectors(raw);

  /* Build a flat action list from segments. Each segment can produce
     one action, or two when it carries an implicit panel target
     ("explain X in panel 2" -> panel.select + reasoning.generate). */
  const built = [];
  let counter = 1;
  for (const seg of segments) {
    if (!seg) continue;
    const implicitTarget = _wmpExtractPanelTarget(seg);
    const baseType = _wmpDetectActionType(seg);
    if (
      implicitTarget != null &&
      baseType === "reasoning.generate" &&
      /\bin\s+/i.test(seg)
    ) {
      built.push({
        id: `a${counter++}`,
        type: "panel.select",
        target: { panelIndex: implicitTarget },
        segmentText: `go to panel ${implicitTarget}`,
        riskLevel: _wmpRiskLevelForType("panel.select"),
      });
      const promptText = _wmpStripImplicitTargetPhrase(seg) || seg;
      built.push({
        id: `a${counter++}`,
        type: "reasoning.generate",
        payload: { prompt: promptText },
        segmentText: promptText,
        riskLevel: _wmpRiskLevelForType("reasoning.generate"),
      });
    } else {
      built.push({
        id: `a${counter++}`,
        type: baseType,
        target: implicitTarget != null ? { panelIndex: implicitTarget } : undefined,
        segmentText: seg,
        riskLevel: _wmpRiskLevelForType(baseType),
      });
    }
  }

  /* If every segment we built is "general.reply" / "unknown", this is not
     really a multi-action request — bail and let the normal router handle
     the original text as a single intent. */
  const actionable = built.filter(
    (a) => a.type !== "general.reply" && a.type !== "unknown"
  );
  if (actionable.length < 2) return null;

  const ordered = _wmpOrderActionsByDependency(built);

  /* Drop trailing "general.reply" tails — they're typically noise from a
     comma or trailing pleasantry. Keep them if they're the only content. */
  const finalActions = ordered.filter(
    (a) => a.type !== "general.reply" && a.type !== "unknown"
  );
  if (finalActions.length < 2) return null;

  const triggerReason =
    segments.length === 1 ? "implicit_target_panel" : "explicit_connector";

  return {
    isMultiAction: true,
    confidence: triggerReason === "implicit_target_panel" ? 0.9 : 0.85,
    triggerReason,
    executionMode: "sequential",
    actions: finalActions,
    userFacingSummary: null, // executor builds the final confirmation
  };
}

/** Gate per PART 1 — Work Mode only, recursive bypass aware. */
function shouldUseWorkModeMultiActionPlanner(text, opts = {}) {
  if (opts && opts.__skipMultiActionPlanner === true) return false;
  if (typeof isVeraWorkModeOn !== "function" || !isVeraWorkModeOn()) return false;
  if (typeof appModePrefix !== "function" || appModePrefix() !== "vera") return false;
  /* Future extension: when called from normal-mode chat with explicit
     Work Mode references (PART 11), we'd return true and surface a
     prompt to enable Work Mode. Out of scope for this pass. */
  return true;
}

/** Structured log helper. Stable schema for grep + future analyzers. */
function logWorkModeMultiActionPlannerDecision(payload) {
  try {
    console.info("[wm_multi_action_planner]", {
      tag: payload?.tag || "plan_decision",
      ts: new Date().toISOString(),
      ...payload,
    });
  } catch (_) {}
}

async function maybeRunWorkModeMultiActionPlanner(text, opts = {}) {
  const trimmed = String(text || "").trim();
  if (!shouldUseWorkModeMultiActionPlanner(trimmed, opts)) return false;

  const path = opts.path || opts.source || "work-mode";
  let plan = null;
  try {
    plan = planWorkModeMultiAction(trimmed, { source: path, isVoice: Boolean(opts.isVoice) });
  } catch (e) {
    try {
      console.warn("[wm_multi_action_planner]", {
        tag: "planner_exception",
        error: String(e?.message || e || "").slice(0, 200),
        text_preview: String(trimmed || "").slice(0, 120),
        path,
        is_voice: Boolean(opts.isVoice),
      });
    } catch (_) {}
    plan = null;
  }

  logWorkModeMultiActionPlannerDecision({
    tag: "plan_decision",
    latest_user_text: String(trimmed || "").slice(0, 200),
    work_mode_active: true,
    work_mode_multi_action_planner_allowed: true,
    work_mode_scope_reason: "active_work_mode",
    multi_action_candidate: Boolean(plan && plan.isMultiAction),
    planner_used: Boolean(plan && Array.isArray(plan.actions) && plan.actions.length > 1),
    planner_confidence: plan?.confidence ?? null,
    actions_detected: Array.isArray(plan?.actions) ? plan.actions.map((a) => a.type) : [],
    action_order: Array.isArray(plan?.actions) ? plan.actions.map((a) => a.type) : [],
    dependency_edges: Array.isArray(plan?.actions)
      ? plan.actions.flatMap((a) =>
          Array.isArray(a.dependsOn) ? a.dependsOn.map((d) => [d, a.id]) : []
        )
      : [],
    single_router_bypassed: Boolean(
      plan && Array.isArray(plan.actions) && plan.actions.length > 1
    ),
    trigger_reason: plan?.triggerReason || null,
    path,
    is_voice: Boolean(opts.isVoice),
  });

  if (!plan || !Array.isArray(plan.actions) || plan.actions.length <= 1) return false;

  /* Preserve the original full-command bubble BEFORE the executor runs.
   * For voice turns, `finalizeMainBrowserTranscript` (and friends) have
   * already mounted a live partial bubble showing the full original text.
   * We tag that row if it still matches; otherwise create a fresh bubble.
   * The hold flag prevents each sub-action's cleaned segment text from
   * overwriting the bubble via `commitServerUserTranscriptBubble`. */
  const originalFullUserText = trimmed;
  const cleanedExecutionTexts = _wmCleanedExecutionTextsFromPlan(plan);
  let bubbleAlreadyMatched = false;
  try {
    const latestBubbleText = _readLatestUserBubbleText();
    if (
      latestBubbleText
      && _wmNormalizeForSegmentMatch(latestBubbleText) === _wmNormalizeForSegmentMatch(originalFullUserText)
    ) {
      bubbleAlreadyMatched = true;
      try {
        const conv = document.getElementById("conversation")
          || document.getElementById("bmo-conversation");
        const rows = conv?.querySelectorAll(".message-row.user");
        if (rows && rows.length) {
          const row = rows[rows.length - 1];
          if (row instanceof HTMLElement) {
            row.dataset.veraWorkModePreservedOriginal = "1";
            const b = row.querySelector(".bubble");
            if (b instanceof HTMLElement) {
              try { b.dataset.originalFullUserText = originalFullUserText; } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  if (!bubbleAlreadyMatched) {
    try {
      ensureChatStartedLayout();
      const b = addBubble(originalFullUserText, "user", {
        path: `wm-multi-action-original-${opts.isVoice ? "voice" : "typed"}`,
      });
      if (b) {
        const row = b.closest(".message-row");
        if (row instanceof HTMLElement) row.dataset.veraWorkModePreservedOriginal = "1";
        try { b.dataset.originalFullUserText = originalFullUserText; } catch (_) {}
      }
    } catch (_) {}
  }
  _wmMarkOriginalUserBubbleRendered(
    originalFullUserText,
    cleanedExecutionTexts,
    `wm-multi-action-pre-execute:${opts.isVoice ? "voice" : "typed"}`
  );

  try {
    logWorkModeCommandDisplayText({
      originalFullUserText,
      cleanedExecutionText: cleanedExecutionTexts.join(" | ") || null,
      renderedUserBubbleText: _readLatestUserBubbleText(),
      duplicateUserBubbleSuppressed: false,
      usedCleanedTextAsInternalPromptOnly: true,
      commandLooksMultiAction: true,
      source: `wm-multi-action-pre-execute:${opts.isVoice ? "voice" : "typed"}`,
    });
  } catch (_) {}

  _wmHoldOriginalUserBubble(originalFullUserText);
  try {
    await executeWorkModeActionPlan(plan, { source: path, isVoice: Boolean(opts.isVoice) });
    return true;
  } catch (e) {
    console.warn("[wm_multi_action_planner]", {
      tag: "execution_exception",
      error: String(e?.message || e || "").slice(0, 200),
      path,
      is_voice: Boolean(opts.isVoice),
    });
    return true;
  } finally {
    _wmReleaseOriginalUserBubbleHold();
  }
}

/**
 * executeActionPlan(plan, context) — see PART 7.
 *
 * Runs actions sequentially. For panel.select / panel.open we call
 * existing in-process handlers directly (no bubble). For every other
 * action type we re-enter sendVeraWorkModeTypedInferTurn with
 * __skipMultiActionPlanner so the existing shortcuts and /infer route
 * handle the segment exactly the way they would for a single command.
 */
async function executeWorkModeActionPlan(plan, context = {}) {
  if (!plan || !Array.isArray(plan.actions) || plan.actions.length < 1) {
    return { ok: false, results: [], reason: "empty_plan" };
  }

  logWorkModeMultiActionPlannerDecision({
    tag: "execution_started",
    action_count: plan.actions.length,
    actions: plan.actions.map((a) => a.type),
    trigger_reason: plan.triggerReason || null,
    confidence: plan.confidence ?? null,
  });

  const results = [];
  const lookupResult = (id) => results.find((r) => r.id === id);

  for (const action of plan.actions) {
    /* Dependency check (PART 4 F + PART 7). */
    if (Array.isArray(action.dependsOn) && action.dependsOn.length) {
      const failedDep = action.dependsOn.find((depId) => {
        const dep = lookupResult(depId);
        return dep && dep.ok === false;
      });
      if (failedDep) {
        const skipResult = {
          id: action.id,
          type: action.type,
          ok: false,
          skipped_due_to_dependency: true,
          error: `dep_failed:${failedDep}`,
        };
        results.push(skipResult);
        logWorkModeMultiActionPlannerDecision({
          tag: "action_result",
          action_id: action.id,
          action_type: action.type,
          ok: false,
          skipped_due_to_dependency: true,
          dep_failed: failedDep,
        });
        continue;
      }
    }

    let ok = false;
    let error = null;
    const extra = {};

    try {
      switch (action.type) {
        case "panel.select": {
          const oneBased = Number(action?.target?.panelIndex);
          if (!Number.isFinite(oneBased) || oneBased < 1) {
            error = "invalid_panel_index";
            break;
          }
          const idx = oneBased - 1;
          const panelEl = document.querySelector(
            `#vera-reasoning-tab-panels .vera-reasoning-tab-panel[data-tab-index="${idx}"]`
          );
          if (!panelEl) {
            error = "panel_not_found_or_closed";
            break;
          }
          if (typeof activateReasoningTab !== "function") {
            error = "activateReasoningTab_unavailable";
            break;
          }
          activateReasoningTab(idx, {
            commandText: action.segmentText || "",
            requestedIndex: oneBased,
            resolvedFrom: "wm_multi_action_planner",
          });
          extra.target_panel_id =
            panelEl.dataset.laneId || `panel_${oneBased}`;
          extra.reasoning_generation_started = false;
          ok = true;
          break;
        }

        case "panel.open": {
          if (typeof addReasoningTab !== "function") {
            error = "addReasoningTab_unavailable";
            break;
          }
          /* PART 5+6 (2026-05-28): pass the voice/typed source so the
             new panel is tracked as "recently opened" and any next
             reasoning request biases to it. */
          addReasoningTab({ source: "multi_action_planner_open_command" });
          ok = true;
          break;
        }

        case "reasoning.generate": {
          /* Reasoning generation MUST go through the normal Work Mode
             infer pipeline so the active panel context (just selected
             by an earlier action.select) is honored. */
          const promptText =
            String(action?.payload?.prompt || action.segmentText || "").trim();
          if (!promptText) {
            error = "empty_reasoning_prompt";
            break;
          }
          try {
            await sendVeraWorkModeTypedInferTurn(promptText, {
              path: `wm-multi-action:reasoning.generate`,
              __skipMultiActionPlanner: true,
            });
            extra.dispatched_via = "sendVeraWorkModeTypedInferTurn";
            extra.reasoning_generation_started = true;
            ok = true;
          } catch (e) {
            error = String(e?.message || e || "dispatch_error").slice(0, 200);
          }
          break;
        }

        case "panel.close":
        case "checklist.add":
        case "checklist.remove":
        case "checklist.sync":
        case "music.pause":
        case "music.play":
        case "news.open_panel":
        case "news.search":
        case "reasoning.move_latest_voice_answer":
        default: {
          /* All remaining action types are forwarded through the normal
             Work Mode entry. Each will hit its corresponding existing
             frontend shortcut (close panel, sync plan, move-latest)
             or fall through to backend /infer (checklist mutations,
             music control, news ops). The planner bypass flag prevents
             re-entry. */
          try {
            await sendVeraWorkModeTypedInferTurn(action.segmentText || "", {
              path: `wm-multi-action:${action.type}`,
              __skipMultiActionPlanner: true,
            });
            extra.dispatched_via = "sendVeraWorkModeTypedInferTurn";
            ok = true;
          } catch (e) {
            error = String(e?.message || e || "dispatch_error").slice(0, 200);
          }
          break;
        }
      }
    } catch (e) {
      error = String(e?.message || e || "executor_exception").slice(0, 200);
    }

    const result = { id: action.id, type: action.type, ok, error, ...extra };
    results.push(result);
    logWorkModeMultiActionPlannerDecision({
      tag: "action_result",
      action_id: action.id,
      action_type: action.type,
      ok,
      error,
      ...extra,
    });
  }

  logWorkModeMultiActionPlannerDecision({
    tag: "execution_complete",
    results_summary: results.map((r) => ({
      id: r.id,
      type: r.type,
      ok: r.ok,
      skipped: Boolean(r.skipped_due_to_dependency),
    })),
  });

  return { ok: results.every((r) => r.ok), results };
}
