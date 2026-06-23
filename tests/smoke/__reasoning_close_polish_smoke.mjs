/* Smoke tests for the reasoning-panel CLOSE/REFILL POLISH layer.
 *
 * What this covers (auto, Node-only — no browser):
 *   - PART 6: `_cleanCommandTextForClose` strips trailing "can you hear me",
 *     "hello", stuttered "I I I", and "and you/and i" tails — but only when
 *     the input already looks like a close command (close + panel/tab).
 *   - PART 1: `_extractAllCloseSpans` finds multiple close spans inside one
 *     compound utterance, and `_pickStrongestCloseSpan` returns the highest
 *     rank (range > specific_indices_single, etc.). For ties on rank, the
 *     later span wins so the user's most recently-spoken phrasing is used.
 *   - PART 1+6 together: `parseCloseReasoningPanelsCommand` on the original
 *     spec example ("can you close the first panel and you close the first
 *     two panel I can you hear me") collapses to exactly ONE close intent
 *     with closeScope=range_first_n, indices=[1,2], and the suppressed
 *     "close the first panel" / "close panel ... I" stragglers are logged.
 *   - PART 2: `buildCloseReasoningPanelsVoiceReply` produces the single
 *     expected confirmation string for each scope.
 *   - PART 3: `_isGenericBlankReasoningPanelLabel` correctly classifies
 *     "Panel 6" / "New Panel" / "Untitled" / "" as renamable, and refuses
 *     to mark meaningful titles ("English Essay Plan", "Ticket Complaint
 *     Email", "Asian Option Calculation") as renamable.
 *
 * Run:   node __reasoning_close_polish_smoke.mjs
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const APP_JS_PATH = resolvePath(process.cwd(), "app.js");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let pass = 0;
let fail = 0;
const failed = [];

function ok(cond, name, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ${GREEN}PASS${RESET}  ${name}`);
  } else {
    fail += 1;
    failed.push(name);
    console.log(`  ${RED}FAIL${RESET}  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${YELLOW}── ${title} ──${RESET}`);
}

// ---------------------------------------------------------------------------
// Carve a self-contained chunk from workmode/panels.js (Stage 11+) that
// defines the helpers and the parser. We slice between two sentinel markers
// that bound the close-block (kept stable as long as the spec-comment
// headers don't change).
// ---------------------------------------------------------------------------
const SRC = readFileSync(APP_JS_PATH, "utf-8");
/* Stage 8 (2026-05-27): buildCloseReasoningPanelsVoiceReply moved from
   app.js to workmode/panels.js. Voice-reply region is carved from that
   file.
   Stage 11 (2026-05-30): the Voice/text close command parser (PART 14),
   ASR noise cleanup (PART 6), span ranker (PART 1), title fuzzy match,
   reopen executor, and `maybeHandleCloseReasoningPanelShortcut` ALSO
   moved from app.js to workmode/panels.js. The parser region is now
   carved from the same file. */
const PANELS_JS_PATH = resolvePath(process.cwd(), "workmode", "panels.js");
const PANELS_SRC = readFileSync(PANELS_JS_PATH, "utf-8");
const START_SENTINEL = "/* ===== Voice/text close command parser (spec PART 14) ============= */";
const TITLE_HELPER_SENTINEL = "/* Title fuzzy match. Returns array of 1-based visual indices that match. */";
const REOPEN_SENTINEL = "/* Re-open the most recently closed panel (PART 11). */";
const EXECUTOR_SENTINEL = "/* High-level executor used by both the voice/text shortcut and the";
const VOICE_REPLY_SENTINEL = "/* Build the user-facing voice confirmation (spec PART 15 + polish PART 2).";
const VOICE_REPLY_END_SENTINEL = "function isReasoningCloseVoiceSource(";

function carve(src, startMarker, endMarker) {
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error(`startMarker not found: ${startMarker}`);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (endIdx < 0) throw new Error(`endMarker not found: ${endMarker}`);
  return src.slice(startIdx, endIdx);
}

/* Carve two regions, both from workmode/panels.js post-Stage-11:
     - the parser block (PART 1 + PART 6 helpers + parser itself), and
     - the voice-reply builder (PART 2).
   We deliberately skip the executor and reopen functions — they touch
   DOM/window globals we don't want to mock here. */
const parserBlock = carve(PANELS_SRC, START_SENTINEL, TITLE_HELPER_SENTINEL);
const voiceReplyBlock = carve(PANELS_SRC, VOICE_REPLY_SENTINEL, VOICE_REPLY_END_SENTINEL);
const carved = `${parserBlock}\n${voiceReplyBlock}\n`;

/* The carved block uses constants defined elsewhere in app.js. Re-create
   the minimum set so the chunk can be eval'd standalone. */
const PRELUDE = `
const REASONING_UNTITLED_TAB_NAME = "Untitled";
const REASONING_TABS_DEFAULT = 3;
const REASONING_TABS_MAX = 8;
`;

/* Provide a tiny `_isGenericBlankReasoningPanelLabel` ahead of the carved
   block too, because it lives further up in app.js outside our carved
   region but is referenced by the close section. Stage 9 (2026-05-27):
   also stub `_looksLikeChecklistCommand`, which the close-command parser
   calls to disambiguate "remove the first item" / "delete item 2" from
   panel-close phrasing — that helper now lives in workmode/checklist.js. */
const HELPER_PRELUDE = `
function _isGenericBlankReasoningPanelLabel(label) {
  const t = String(label || "").trim();
  if (!t) return true;
  if (/^panel\\s+\\d+$/i.test(t)) return true;
  if (/^new\\s+panel(\\s+\\d+)?$/i.test(t)) return true;
  if (t.toLowerCase() === String(REASONING_UNTITLED_TAB_NAME || "untitled").toLowerCase()) return true;
  return false;
}
function _looksLikeChecklistCommand(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  if (/\\b(?:remove|delete|cross\\s+off|check\\s+off|uncheck|mark)\\s+(?:the\\s+)?(?:first|second|third|fourth|fifth|last|\\d+(?:st|nd|rd|th)?)?\\s*(?:and\\s+(?:first|second|third|fourth|fifth|last|\\d+(?:st|nd|rd|th)?)\\s*)?(?:item|task|bullet|checklist|to[- ]?do|todo|step)s?\\b/.test(t)) return true;
  if (/\\b(?:remove|delete)\\s+items?\\s+\\d+/.test(t)) return true;
  if (/\\b(?:items?|tasks?|bullets?|to[- ]?dos?|todos?|steps?)\\b.*\\b(?:from|in|on)\\s+(?:the\\s+)?(?:checklist|list|todo)\\b/.test(t)) return true;
  return false;
}
`;

/* Export the symbols we want to assert on via global assignment. */
const POSTLUDE = `
globalThis._cleanCommandTextForClose = _cleanCommandTextForClose;
globalThis._extractAllCloseSpans = _extractAllCloseSpans;
globalThis._pickStrongestCloseSpan = _pickStrongestCloseSpan;
globalThis.parseCloseReasoningPanelsCommand = parseCloseReasoningPanelsCommand;
globalThis.buildCloseReasoningPanelsVoiceReply = buildCloseReasoningPanelsVoiceReply;
globalThis._isGenericBlankReasoningPanelLabel = _isGenericBlankReasoningPanelLabel;
`;

const SANDBOX_SRC = `${PRELUDE}\n${HELPER_PRELUDE}\n${carved}\n${POSTLUDE}`;

try {
  /* eslint-disable no-new-func */
  // eslint-disable-next-line no-new-func
  new Function(SANDBOX_SRC)();
} catch (err) {
  console.error("Failed to evaluate carved app.js helpers:", err);
  process.exit(2);
}

// =========================================================================
// SUITE A — _cleanCommandTextForClose (PART 6)
// =========================================================================
section("A. PART 6 — ASR noise tail cleanup");

const cleanCases = [
  {
    name: "trailing 'can you hear me' on close command stripped",
    input: "close the first two panel I can you hear me",
    expect: /^close the first two panel(s)?$/i,
  },
  {
    name: "stutter 'I I' tail stripped after close command",
    input: "close the first two panels I I",
    expect: /^close the first two panels$/i,
  },
  {
    name: "leading filler 'hey vera,' removed",
    input: "hey vera, close the first panel",
    expect: /^close the first panel$/i,
  },
  {
    name: "trailing 'and you' fragment removed (after close command)",
    input: "close the first two panels and you",
    expect: /^close the first two panels$/i,
  },
  {
    name: "non-command text is NOT mangled — general chat preserved",
    input: "I really like the new design, can you hear me?",
    /* Cleaner refuses to strip when there's no close-verb + subject combo. */
    expect: /can you hear me/i,
  },
];
for (const tc of cleanCases) {
  const out = globalThis._cleanCommandTextForClose(tc.input);
  ok(tc.expect.test(out), tc.name, `got "${out}"`);
}

// =========================================================================
// SUITE B — _extractAllCloseSpans / _pickStrongestCloseSpan (PART 1)
// =========================================================================
section("B. PART 1 — multi-span detection + ranking");

{
  /* Compound utterance: should detect at least one specific_indices span
     AND a range_first_n span, then pick the range as winner. */
  const text = "close the first panel and close the first two panels";
  const spans = globalThis._extractAllCloseSpans(text, 3);
  ok(spans.length >= 2, "B1. extracts ≥2 close spans from compound", `got ${spans.length}`);
  const pick = globalThis._pickStrongestCloseSpan(spans);
  ok(pick && pick.scope === "range_first_n", "B2. range_first_n wins over specific_indices", JSON.stringify(pick));
  ok(pick && Array.isArray(pick.indices) && pick.indices.join(",") === "1,2",
     "B3. range_first_n indices=[1,2]", JSON.stringify(pick?.indices));
}

{
  /* all_panels outranks every other scope. */
  const text = "close panel 2 and close all panels";
  const spans = globalThis._extractAllCloseSpans(text, 3);
  const pick = globalThis._pickStrongestCloseSpan(spans);
  ok(pick && pick.scope === "all_panels", "B4. all_panels outranks specific_indices", JSON.stringify(pick));
}

{
  /* other_panels outranks specific_indices. */
  const text = "close the first panel, actually close all other panels";
  const spans = globalThis._extractAllCloseSpans(text, 3);
  const pick = globalThis._pickStrongestCloseSpan(spans);
  ok(pick && pick.scope === "other_panels", "B5. other_panels outranks specific_indices", JSON.stringify(pick));
}

{
  /* Range explicit "1 through 3" beats single index. */
  const text = "close panel 1, close panels 1 through 3";
  const spans = globalThis._extractAllCloseSpans(text, 5);
  const pick = globalThis._pickStrongestCloseSpan(spans);
  ok(pick && pick.scope === "range" && pick.indices?.join(",") === "1,2,3",
     "B6. range '1 through 3' wins, indices=[1,2,3]", JSON.stringify(pick));
}

// =========================================================================
// SUITE C — parseCloseReasoningPanelsCommand integration (PART 1+6)
// =========================================================================
section("C. parser integration (PART 1+6)");

{
  /* The exact spec example. */
  const text = "can you close the first panel and you close the first two panel I can you hear me";
  const parsed = globalThis.parseCloseReasoningPanelsCommand(text, 3);
  ok(parsed.intent === "close_reasoning_panels", "C1. intent=close_reasoning_panels", parsed.intent);
  ok(parsed.closeScope === "range_first_n", "C2. closeScope=range_first_n (not specific_indices)", parsed.closeScope);
  ok(Array.isArray(parsed.indices) && parsed.indices.join(",") === "1,2",
     "C3. indices=[1,2]", JSON.stringify(parsed.indices));
  ok(Array.isArray(parsed.allCloseSpans) && parsed.allCloseSpans.length >= 2,
     "C4. allCloseSpans logged (≥2 entries)", `count=${parsed.allCloseSpans?.length}`);
  ok(Array.isArray(parsed.suppressedCloseSpans) && parsed.suppressedCloseSpans.length >= 1,
     "C5. suppressedCloseSpans logged (the dropped duplicates)", `count=${parsed.suppressedCloseSpans?.length}`);
  ok(typeof parsed.rawCommandText === "string" && parsed.rawCommandText.length > 0 && !/can you hear me/i.test(parsed.rawCommandText),
     "C6. rawCommandText was ASR-cleaned (no 'can you hear me')", parsed.rawCommandText);
}

{
  /* Single-phrase, simple case still works. */
  const parsed = globalThis.parseCloseReasoningPanelsCommand("close the first panel", 3);
  ok(parsed.intent === "close_reasoning_panels", "C7. single 'close the first panel' → close_reasoning_panels");
  ok(parsed.closeScope === "specific_indices" && parsed.indices?.join(",") === "1",
     "C8. single → specific_indices [1]", JSON.stringify(parsed.indices));
}

{
  /* Non-reasoning subject still falls through. */
  const parsed = globalThis.parseCloseReasoningPanelsCommand("close the news panel", 3);
  ok(parsed.intent === null, "C9. 'close the news panel' is NOT a reasoning close");
  ok(parsed.failureReason === "non_reasoning_subject", `C10. failureReason=non_reasoning_subject`, parsed.failureReason);
}

{
  /* Bare "close panel" is a local UI close, not a reasoning prompt. */
  const parsed = globalThis.parseCloseReasoningPanelsCommand("close panel", 3);
  ok(parsed.intent === "close_reasoning_panels", "C11. bare 'close panel' → close_reasoning_panels");
  ok(parsed.closeScope === "current_panel", "C12. bare 'close panel' → current_panel", parsed.closeScope);
}

// =========================================================================
// SUITE D — buildCloseReasoningPanelsVoiceReply (PART 2)
// =========================================================================
section("D. PART 2 — one centralized confirmation");

{
  const reply = globalThis.buildCloseReasoningPanelsVoiceReply(
    { ok: true, closedTitles: ["Panel 1", "Panel 2"], createdBlankCount: 2 },
    { closeScope: "range_first_n", indices: [1, 2] }
  );
  ok(/^Closed the first two panels and opened fresh ones\.$/.test(reply),
     "D1. range_first_n → 'Closed the first two panels and opened fresh ones.'", reply);
}

{
  const reply = globalThis.buildCloseReasoningPanelsVoiceReply(
    { ok: true, closedTitles: ["English Essay Plan"], createdBlankCount: 1 },
    { closeScope: "specific_indices", indices: [1] }
  );
  ok(/^Closed the English Essay Plan panel( and opened a fresh one\.)?$/.test(reply),
     "D2. single meaningful title → 'Closed the English Essay Plan panel and opened a fresh one.'", reply);
}

{
  const reply = globalThis.buildCloseReasoningPanelsVoiceReply(
    { ok: true, closedTitles: ["Panel 1"], createdBlankCount: 1 },
    { closeScope: "specific_indices", indices: [1] }
  );
  ok(/^Closed panel 1 and opened a fresh one\.$/.test(reply),
     "D3. single generic 'Panel 1' → 'Closed panel 1 and opened a fresh one.'", reply);
}

{
  const reply = globalThis.buildCloseReasoningPanelsVoiceReply(
    { ok: true, closedTitles: ["Panel 1", "Panel 2", "Panel 3"], createdBlankCount: 3 },
    { closeScope: "all_panels" }
  );
  ok(/^Closed all panels and opened fresh ones\.$/.test(reply),
     "D4. all_panels confirmation", reply);
}

{
  const reply = globalThis.buildCloseReasoningPanelsVoiceReply(
    { ok: false, failureReason: "all_indices_out_of_range", totalBefore: 3 },
    { closeScope: "specific_indices", indices: [9] }
  );
  ok(reply === "I only see 3 panels.",
     "D5. out-of-range close target gives local app-action clarification", reply);
}

// =========================================================================
// SUITE E — _isGenericBlankReasoningPanelLabel (PART 3)
// =========================================================================
section("E. PART 3 — generic-blank label classifier");

const renamable = ["Panel 1", "Panel 6", "Panel 7", "Panel 8", "New Panel", "New Panel 2", "Untitled", ""];
const keep = ["English Essay Plan", "Ticket Complaint Email", "Asian Option Calculation", "Lofi Mix Notes", "1099 Tax Strategy"];
for (const label of renamable) {
  ok(globalThis._isGenericBlankReasoningPanelLabel(label) === true,
     `E. "${label}" is renamable`);
}
for (const label of keep) {
  ok(globalThis._isGenericBlankReasoningPanelLabel(label) === false,
     `E. "${label}" is NOT renamable (preserves meaningful titles)`);
}

// =========================================================================
// SUMMARY
// =========================================================================
console.log("\n" + "─".repeat(60));
if (fail === 0) {
  console.log(`${GREEN}ALL ${pass} TESTS PASSED${RESET}`);
  process.exit(0);
} else {
  console.log(`${RED}${fail} TEST(S) FAILED${RESET} (${pass} passed)`);
  for (const name of failed) console.log(`  - ${name}`);
  process.exit(1);
}
