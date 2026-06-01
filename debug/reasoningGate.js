/* =========================================================================
 *  debug/reasoningGate.js -- DevTools-only reasoning-gate dry-run probe.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-06-01, Patch B-2 option b). The only public surface is
 *  window.debugReasoningGate(text, opts) -- a manual-call diagnostic
 *  that NEVER opens /work_mode/reasoning_stream, NEVER mutates a
 *  panel, NEVER plays TTS. It is the dry-run mirror of the
 *  deterministic short-circuits inside maybePrepareWorkModeReasoning,
 *  with an optional secondary round-trip to /debug/reasoning_gate so
 *  an operator can compare frontend and backend (LLM tier) decisions
 *  in one call.
 *
 *  This file contains NO live-routing code. The patch B-2 option b
 *  contract is explicitly:
 *    - move only window.debugReasoningGate and its dev-only probe
 *      code from app.js,
 *    - do NOT duplicate production helpers,
 *    - keep helpers like isExplicitReasoningPanelReference,
 *      isSimpleDefinitionQuestion, detectBroadComplexTopicFrontend,
 *      detectCompoundActionFamilies and similar live-routing helpers
 *      in app.js.
 *
 *  -----------------------------------------------------------------
 *  Load order
 *  -----------------------------------------------------------------
 *  This file is loaded AFTER app.js in index.html (same pattern as
 *  debug/voiceDebug.js). Rationale:
 *
 *    - Nothing inside app.js references debugReasoningGate at parse
 *      time. The window.debugReasoningGate alias was only set after
 *      the function declaration anyway, and live routing does not
 *      depend on it.
 *
 *    - The function body references several app.js-side identifiers:
 *        isExplicitReasoningPanelReference, isBriefExplanationModifier,
 *        isSimpleDefinitionQuestion, detectBroadComplexTopicFrontend,
 *        detectCompoundActionFamilies, workModeLastSubstantiveUserText,
 *        API_URL.
 *      Each is declared at the top level of app.js as a function or
 *      const / let, so it lives in the shared GlobalEnvironment that
 *      classic <script> tags split between themselves. Because we
 *      load AFTER app.js, every bare identifier is reachable at call
 *      time (the call only happens when the operator invokes
 *      window.debugReasoningGate from DevTools, long after both
 *      files have finished loading).
 *
 *  -----------------------------------------------------------------
 *  Preserved invariants (Patch B-2 option b hard rules)
 *  -----------------------------------------------------------------
 *    - Public name window.debugReasoningGate unchanged.
 *    - Output shape unchanged: same property set, same property
 *      names, same default values, same opts merging order.
 *    - All debug log labels unchanged (single label here is the
 *      console.info("[debug_reasoning_gate]", out) emission).
 *    - Network behaviour unchanged: still POSTs form-encoded body
 *      to `${API_URL}/debug/reasoning_gate` exactly when
 *      options.includeBackend !== false, with the same fields
 *      (text, previous_user_text, active_work_mode,
 *      active_panel_index) and the same .ok / .json fallback to
 *      null + .catch fallback to null.
 *    - Decision precedence unchanged:
 *        explicit panel ref (+ pronoun + prior topic fallback) ->
 *        brief modifier -> simple definition -> compound action ->
 *        complex task -> broad-topic-with-explain join -> backend
 *        defer.
 *    - Live routing untouched: maybePrepareWorkModeReasoning,
 *      handleUtterance, the infer pipeline, Work Mode panel
 *      routing, and the deterministic short-circuits inside app.js
 *      were not modified.
 * ========================================================================= */

/* ============================================================================
 * 2026-05-29 spec PART 2 — window.debugReasoningGate(text, opts)
 *
 * Dry-run mirror of maybePrepareWorkModeReasoning's deterministic
 * short-circuits. NEVER opens /work_mode/reasoning_stream, NEVER mutates
 * any panel, NEVER plays TTS.
 *
 * Returns a plain object with the route decision plus the diagnostic flags
 * the spec asks for. When opts.includeBackend !== false the helper also
 * POSTs to /debug/reasoning_gate so an operator can compare frontend
 * deterministic decisions against the backend (LLM tier) decision in one
 * call.
 *
 * Usage from DevTools:
 *
 *   await window.debugReasoningGate("what is tennis?")
 *   await window.debugReasoningGate("explain the Vietnam War")
 *   await window.debugReasoningGate(
 *     "can you explain that in the reasoning panel?",
 *     { previousUserText: "what is tennis?" }
 *   )
 * ========================================================================== */
async function debugReasoningGate(text, opts) {
  const safeText = String(text || "").trim();
  const options = Object.assign({
    includeBackend: true,
    previousUserText: null,
    activePanelIndex: null,
    activeWorkMode: true,
    log: true
  }, opts || {});
  const previousUserText =
    typeof options.previousUserText === "string"
      ? options.previousUserText
      : String(options.previousUserText || "");
  const priorTopicAvailable =
    Boolean(previousUserText.trim() || String(workModeLastSubstantiveUserText || "").trim());

  /* Step 1 — explicit panel reference is always strongest. */
  const explicit = isExplicitReasoningPanelReference(safeText);
  /* Step 2 — brief modifier always wins over simple definition / heuristic. */
  const briefModifier = isBriefExplanationModifier(safeText);
  /* Step 3 — simple definitional question. */
  const simpleDef = isSimpleDefinitionQuestion(safeText);
  /* Step 4 — broad/complex topic name catalog (history/quant/science/econ). */
  const broadTopic = detectBroadComplexTopicFrontend(safeText);
  /* Step 5 — compound action families ⇒ defer to backend planner. */
  const compound = detectCompoundActionFamilies(safeText);

  /* Cheap mirror of the complex-task verb branch in the backend gate. */
  const complexTask =
    /\b(solve|prove|derive|simulate|debug|refactor|compute|calculate|evaluate|analy[sz]e|outline|summari[sz]e|compare|review|draft|compose|polish|rewrite|write\s+(?:a|an|the|me|us|my|some|this|that))\b/i.test(
      safeText
    );

  const out = {
    text: safeText,
    route: null,
    reason: null,
    resolvedTopic: null,
    targetPanel: null,
    promptReasoning: false,
    explicitPanelReference: Boolean(explicit.matched),
    simpleDefinitionDetected: Boolean(simpleDef.matched),
    briefExplanationDetected: Boolean(briefModifier),
    broadComplexTopicDetected: Boolean(broadTopic),
    complexTaskDetected: Boolean(complexTask),
    compoundActionFamiliesDetected: compound.isCompound ? compound.families : [],
    priorTopicUsed: false,
    activeWorkMode: Boolean(options.activeWorkMode),
    activePanelIndex: options.activePanelIndex,
    previousUserText,
    routeSource: "frontend_dry_run",
    backend: null
  };

  function finalize() {
    /* Optional secondary call to the backend so the caller can compare
       frontend and backend decisions in one round trip. The deterministic
       branches above already cover most cases without the network call. */
    if (options.includeBackend === false) {
      if (options.log !== false) {
        try {
          console.info("[debug_reasoning_gate]", out);
        } catch (_) {}
      }
      return out;
    }
    const formBody = new URLSearchParams();
    formBody.set("text", safeText);
    if (previousUserText) formBody.set("previous_user_text", previousUserText);
    formBody.set("active_work_mode", options.activeWorkMode ? "1" : "0");
    if (options.activePanelIndex != null && options.activePanelIndex !== "") {
      formBody.set("active_panel_index", String(options.activePanelIndex));
    }
    return fetch(`${API_URL}/debug/reasoning_gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString()
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((backend) => {
        if (backend && typeof backend === "object") {
          out.backend = backend;
          /* Stamp the spec-required fields onto the top-level result from
             whichever side decided — frontend deterministic branches keep
             precedence so the dry-run reflects what production would do. */
          if (!out.route) {
            out.route = backend.route || null;
            out.reason = backend.reason || null;
            out.resolvedTopic = backend.resolved_topic || out.resolvedTopic;
            out.targetPanel = backend.target_panel ?? out.targetPanel;
            out.promptReasoning = out.route === "reasoning_panel";
            out.routeSource = "backend_debug";
          }
        } else if (!out.route) {
          out.route = "voice_ui";
          out.reason = "backend_unavailable_default_voice";
          out.routeSource = "frontend_dry_run_default";
        }
        if (options.log !== false) {
          try {
            console.info("[debug_reasoning_gate]", out);
          } catch (_) {}
        }
        return out;
      });
  }

  if (explicit.matched) {
    /* Pronoun-only explicit panel ref + prior topic ⇒ reasoning_panel.
       Pronoun-only + no prior topic ⇒ clarification. */
    let resolvedTopic = explicit.topic || null;
    if (!resolvedTopic && explicit.wasPronoun) {
      const prior =
        previousUserText.trim() ||
        String(workModeLastSubstantiveUserText || "").trim();
      if (prior) {
        resolvedTopic = prior;
        out.priorTopicUsed = true;
      } else {
        out.route = "clarification";
        out.reason = "explicit_panel_pronoun_without_prior_topic";
        out.targetPanel = explicit.targetPanel ?? null;
        out.promptReasoning = false;
        return finalize();
      }
    }
    out.route = "reasoning_panel";
    out.reason = "explicit_panel_reference";
    out.resolvedTopic = resolvedTopic || null;
    out.targetPanel = explicit.targetPanel ?? null;
    out.promptReasoning = true;
    return finalize();
  }

  if (briefModifier) {
    out.route = "voice_ui";
    out.reason = "brief_explanation";
    return finalize();
  }

  if (simpleDef.matched) {
    out.route = "voice_ui";
    out.reason = "simple_definition";
    out.resolvedTopic = simpleDef.topic || null;
    return finalize();
  }

  if (compound.isCompound) {
    /* Mirrors the frontend "defer to backend planner" branch — the live
       gate returns voice_ui here so /infer routes the compound through
       the backend deterministic planner. The dry-run reports the same
       decision so a tester can confirm the compound was detected. */
    out.route = "voice_ui";
    out.reason = "compound_defer_to_backend_planner";
    return finalize();
  }

  if (complexTask) {
    out.route = "reasoning_panel";
    out.reason = "complex_task";
    out.promptReasoning = true;
    return finalize();
  }

  if (broadTopic) {
    /* The backend gate only opens the panel for broad topics when the
       text ALSO contains "explain"/"explanation" or a detailed-wording
       modifier. The dry-run mirrors that join so "what is tennis?" does
       not show up as reasoning_panel just because tennis falls in a
       broad-topic family. */
    if (/\b(?:explain(?:s|ed|ing)?|explanation(?:s)?|in\s+detail|detailed(?:ly)?|step[-\s]*by[-\s]*step|deep[-\s]*dive|thorough(?:ly)?)\b/i.test(safeText)) {
      out.route = "reasoning_panel";
      out.reason = "broad_complex_topic";
      out.promptReasoning = true;
      return finalize();
    }
  }

  /* No deterministic short-circuit fired — defer to the backend. */
  return finalize();
}

try {
  window.debugReasoningGate = debugReasoningGate;
} catch (_) {}
