"""Smoke tests for the configurable-ASR-mode pipeline (PART 17 of the spec).

What this covers (auto):
  * choose_best_transcript — full PART 9 selection matrix (browser-only,
    whisper-only, both, hallucination guard, truncated guard, low-confidence
    guard, default-prefer-whisper)
  * normalize_command_transcript — full PART 10 known-vocab corrections
    (sync, news panel, reasoning panel, checklist, work mode, openai)
  * /infer endpoint signature — confirms the new hybrid params
    (asr_mode, request_whisper_verify, hybrid_browser_transcript,
    asr_finalization_mode, asr_finalization_reason) are accepted
  * Edit-distance / token-overlap math against canonical PART 9 examples
    from the spec

What is NOT covered here (manual UI):
  * Test 1, 2, 3 — Settings UI radio behavior (Streaming/Whisper/Hybrid)
  * Test 4, 5, 9, 11, 12, 13 — Live microphone flows
  * Test 14 — End-to-end logs from a real browser turn
"""

from __future__ import annotations

# --- bootstrap (auto-added on move to tests/smoke/) ----------------------
# This file was moved from the repo root into tests/smoke/. Add the repo
# root to sys.path so `import app` (and sibling modules) still resolves.
# Bootstrap must come AFTER `from __future__` to satisfy the Python rule
# that __future__ imports be the first statement (fixed 2026-05-28).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))
# -----------------------------------------------------------------------

import inspect
import io
import json
import os
import sys
import types

# --- environment hardening ------------------------------------------------
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# --- stub heavy modules ---------------------------------------------------
_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init",
    "transcribe", "transcribe_long", "load_model", "warmup",
    "speak_to_file", "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

import app  # type: ignore  # noqa: E402


GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"


PASS = 0
FAIL = 0
FAILED: list[str] = []


def _assert(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' — ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}Ã¢”â‚¬Ã¢”â‚¬ {title} Ã¢”â‚¬Ã¢”â‚¬{RESET}")


# ---------------------------------------------------------------------------
# Suite A — choose_best_transcript: empty/edge cases
# ---------------------------------------------------------------------------
section("A. choose_best_transcript — empty/edge cases")

r = app.choose_best_transcript("", "")
_assert(r["selected"] == "" and r["source"] == "empty_both", "both empty Ã¢” ’ empty_both")

r = app.choose_best_transcript("hello", "")
_assert(r["selected"] == "hello" and r["source"] == "hybrid_browser" and r["reason"] == "whisper_empty",
        "whisper empty Ã¢” ’ browser")

r = app.choose_best_transcript("", "hello")
_assert(r["selected"] == "hello" and r["source"] == "hybrid_whisper" and r["reason"] == "browser_empty",
        "browser empty Ã¢” ’ whisper")


# ---------------------------------------------------------------------------
# Suite B — choose_best_transcript: canonical spec PART 9 examples
# ---------------------------------------------------------------------------
section("B. choose_best_transcript — PART 9 examples (prefer Whisper)")

# Example 1: "can you sing the plan" vs "can you sync the plan"
r = app.choose_best_transcript("can you sing the plan", "can you sync the plan")
_assert(
    r["selected"] == "can you sync the plan" and r["source"] == "hybrid_whisper",
    "'sing' vs 'sync' Ã¢” ’ whisper preferred",
    detail=f"source={r['source']!r} reason={r['reason']!r}",
)

# Example 2: "remove first dirt and fifth item" vs "remove first, third, and fifth item"
r = app.choose_best_transcript(
    "remove first dirt and fifth item",
    "remove first, third, and fifth item",
)
_assert(
    r["selected"] == "remove first, third, and fifth item" and r["source"] == "hybrid_whisper",
    "ordinal mishear Ã¢” ’ whisper preferred",
    detail=f"source={r['source']!r}",
)

# Example 3: "open the new spanel" vs "open the news panel"
r = app.choose_best_transcript("open the new spanel", "open the news panel")
_assert(
    r["selected"] == "open the news panel" and r["source"] == "hybrid_whisper",
    "'new spanel' vs 'news panel' Ã¢” ’ whisper preferred",
    detail=f"source={r['source']!r}",
)


# ---------------------------------------------------------------------------
# Suite C — choose_best_transcript: hallucination/truncation guards
# ---------------------------------------------------------------------------
section("C. choose_best_transcript — Whisper degenerate guards")

# Hallucinated Whisper: short, repetitive
r = app.choose_best_transcript(
    "schedule a meeting tomorrow at noon",
    "thank you thank you thank you",
)
_assert(
    r["source"] == "hybrid_browser" and r["reason"] == "whisper_looks_hallucinated",
    "repetitive whisper Ã¢” ’ browser preferred",
    detail=f"reason={r['reason']!r}",
)

# Truncated Whisper: much shorter, low overlap, browser is long
r = app.choose_best_transcript(
    "draft an email to Alex about the Q3 marketing plan and shipping date",
    "draft an email",
)
_assert(
    r["source"] == "hybrid_browser" and r["reason"] == "whisper_truncated",
    "truncated whisper Ã¢” ’ browser preferred",
    detail=f"reason={r['reason']!r} len_ratio={r['length_ratio']!r}",
)

# Low confidence + short = browser
r = app.choose_best_transcript(
    "send the report to Jordan tomorrow",
    "send",
    whisper_confidence=0.1,
)
_assert(
    r["source"] == "hybrid_browser" and r["reason"] == "whisper_low_conf_and_short",
    "low conf + short whisper Ã¢” ’ browser preferred",
    detail=f"reason={r['reason']!r}",
)

# Default-prefer-whisper: small edit distance, normal length
r = app.choose_best_transcript(
    "let's go to the park",
    "lets go to the park",
)
_assert(
    r["source"] == "hybrid_whisper" and r["reason"] == "prefer_whisper_default",
    "small diff Ã¢” ’ whisper default",
    detail=f"reason={r['reason']!r}",
)


# ---------------------------------------------------------------------------
# Suite D — normalize_command_transcript (PART 10)
# ---------------------------------------------------------------------------
section("D. normalize_command_transcript — PART 10 corrections")


def assert_norm(text: str, expected_substring: str, should_apply: bool) -> None:
    r = app.normalize_command_transcript(text)
    if should_apply:
        ok = r["applied"] and expected_substring.lower() in (r["normalized"] or "").lower()
    else:
        ok = (not r["applied"]) and r["normalized"] == text
    _assert(
        ok,
        f"normalize: {text!r} Ã¢” ’ {('applies' if should_apply else 'no-op')} "
        f"contains={expected_substring!r}",
        detail=f"applied={r['applied']} normalized={r['normalized']!r}",
    )


# Mishears that should be corrected (in command context)
assert_norm("can you sing the plan", "sync the plan", True)
assert_norm("sink the plan now", "sync the plan", True)
assert_norm("open the new spanel", "news panel", True)
assert_norm("open the news spanel", "news panel", True)
assert_norm("open the recent panel", "reasoning panel", True)
assert_norm("close the reason panel", "reasoning panel", True)
assert_norm("remove the first item from the check list", "checklist", True)
assert_norm("enable work mood", "Work Mode", True)
assert_norm("ask open a i to help", "OpenAI", True)

# Phrases that should NOT be normalized (no command context)
r = app.normalize_command_transcript("I like singing the plan a lot of music")
# Has "open"... wait, no. It has "singing" but not the exact "sing the plan" pattern
_assert(not r["applied"], "no command context Ã¢” ’ not normalized")

# Command context but unrelated phrasing Ã¢” ’ no correction
r = app.normalize_command_transcript("close the door please")
_assert(not r["applied"], "command verb without VERA vocab Ã¢” ’ no correction")


# ---------------------------------------------------------------------------
# Suite E — /infer endpoint accepts hybrid params
# ---------------------------------------------------------------------------
section("E. /infer signature includes hybrid params")

sig = inspect.signature(app.infer)
params = set(sig.parameters.keys())
for required in (
    "asr_mode",
    "request_whisper_verify",
    "hybrid_browser_transcript",
    "asr_finalization_mode",
    "asr_finalization_reason",
):
    _assert(required in params, f"/infer accepts {required}")


# ---------------------------------------------------------------------------
# Suite F — getVeraAsrMode backwards compatibility (PART 1)
# ---------------------------------------------------------------------------
section("F. ASR-mode JS backcompat patterns")

# We can't run JS here, but we CAN verify the JS source has the right
# backcompat mapping by reading app.js and grep'ing for the strings.
app_js_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.js")
with open(app_js_path, "r", encoding="utf-8") as fh:
    app_js = fh.read()

_assert(
    'if (v === "single") return "whisper";' in app_js,
    "JS: single Ã¢” ’ whisper backcompat mapping present",
)
_assert(
    'if (v === "browser") return "streaming";' in app_js,
    "JS: browser Ã¢” ’ streaming backcompat mapping present",
)
_assert(
    'VERA_ASR_MODE_DEFAULT = "streaming"' in app_js,
    "JS: default mode is streaming (PART 1)",
)
_assert(
    'isHybridAsrMode' in app_js and 'isWhisperAsrMode' in app_js and 'isStreamingAsrMode' in app_js,
    "JS: mode predicate helpers present",
)
_assert(
    'decideAsrFinalizationMode' in app_js,
    "JS: decideAsrFinalizationMode classifier present (PART 6)",
)
_assert(
    'chooseBestTranscript' in app_js,
    "JS: chooseBestTranscript present (PART 9)",
)
_assert(
    'normalizeCommandTranscript' in app_js,
    "JS: normalizeCommandTranscript present (PART 10)",
)
_assert(
    'HYBRID_POLICY = "selective"' in app_js,
    "JS: default hybrid policy is selective (PART 5+15)",
)


# ---------------------------------------------------------------------------
# Suite G — Settings UI HTML wiring (PART 1)
# ---------------------------------------------------------------------------
section("G. Settings UI HTML has 3 ASR modes")

index_html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
with open(index_html_path, "r", encoding="utf-8") as fh:
    html = fh.read()

_assert(
    'id="vera-setting-asr-streaming"' in html and 'data-asr-mode="streaming"' in html,
    "settings: Streaming radio present",
)
_assert(
    'id="vera-setting-asr-whisper"' in html and 'data-asr-mode="whisper"' in html,
    "settings: Whisper radio present",
)
_assert(
    'id="vera-setting-asr-hybrid"' in html and 'data-asr-mode="hybrid"' in html,
    "settings: Hybrid radio present",
)
_assert(
    "Fast / Streaming" in html,
    "settings: Streaming label uses spec wording",
)
_assert(
    "Accurate / Whisper" in html,
    "settings: Whisper label uses spec wording",
)


# ---------------------------------------------------------------------------
# Suite H — PART 17 scenario walkthroughs (testable subset)
# ---------------------------------------------------------------------------
section("H. PART 17 scenario walkthroughs (testable subset)")

# Test 6 — "sing the plan" vs "sync the plan" Ã¢” ’ final = sync
r = app.choose_best_transcript("sing the plan", "sync the plan")
sel = r["selected"]
norm = app.normalize_command_transcript(sel)
final = (norm["normalized"] or sel).lower()
_assert(
    "sync the plan" in final,
    "Test 6 — misheard sync resolves to 'sync the plan'",
    detail=f"selected={sel!r} final={final!r}",
)

# Test 7 — "remove first, third, and fifth item" ordinal preservation
r = app.choose_best_transcript(
    "remove first dirt and fifth item",
    "remove first, third, and fifth item",
)
_assert(
    "third" in r["selected"] and "fifth" in r["selected"],
    "Test 7 — ordinals preserved after selection",
)

# Test 8 — "close the first two panels" — whisper preferred when same
r = app.choose_best_transcript("close the first two panels", "close the first two panels")
_assert(
    r["source"] == "hybrid_whisper" and r["selected"] == "close the first two panels",
    "Test 8 — identical transcripts: whisper still chosen by default",
)

# Test 9 — "open the new spanel" Ã¢” ’ "open the news panel" via either selector
# or normalizer
r = app.choose_best_transcript("open the new spanel", "open the news panel")
sel = r["selected"]
norm = app.normalize_command_transcript(sel)
final = (norm["normalized"] or sel).lower()
_assert(
    "news panel" in final,
    "Test 9 — 'new spanel' resolves to 'news panel'",
    detail=f"final={final!r}",
)
# Even without whisper, normalize_command_transcript should catch it
r2 = app.normalize_command_transcript("open the new spanel")
_assert(
    "news panel" in (r2["normalized"] or "").lower(),
    "Test 9b — normalizer alone catches 'new spanel' (browser-only fallback)",
    detail=f"normalized={r2['normalized']!r}",
)


# ---------------------------------------------------------------------------
section("Summary")
total = PASS + FAIL
print(f"\n  Total: {total}   {GREEN}Pass: {PASS}{RESET}   {(RED if FAIL else RESET)}Fail: {FAIL}{RESET}")
if FAIL:
    print(f"\n  {RED}Failed cases:{RESET}")
    for n in FAILED:
        print(f"    - {n}")

print(
    "\nMANUAL UI TESTS (browser/mic required):\n"
    "  Test 1  — Defaults: fresh user/settings Ã¢” ’ ASR mode is 'streaming',\n"
    "             browser ASR is used when supported.\n"
    "  Test 2  — Toggle Whisper: select 'Accurate / Whisper'; browser ASR\n"
    "             is not used; MediaRecorder Ã¢” ’ /infer.\n"
    "  Test 3  — Toggle Hybrid: live captions appear; risky commands trigger\n"
    "             whisper_verify; low-risk commands route immediately.\n"
    "  Test 4  — Hybrid casual: say 'continue'; expect browser_immediate\n"
    "             (no Whisper wait, see [asr_finalization_debug] log).\n"
    "  Test 5  — Hybrid sync: say 'sync the plan'; expect whisper_verify;\n"
    "             checklist sync runs after server returns selected transcript.\n"
    "  Test 11 — Cancel-only barge-in: while VERA speaks, say 'stop'.\n"
    "             TTS stops immediately, no /infer round-trip.\n"
    "  Test 12 — Cancel-prefix barge-in: 'wait, sync the plan'. TTS stops;\n"
    "             residue 'sync the plan' is whisper-verified.\n"
    "  Test 13 — Streaming stays fast: ASR mode = streaming, say anything;\n"
    "             /infer log shows asr_finalization_mode=browser_immediate.\n"
    "  Test 14 — Logs: open DevTools console, observe [asr_mode_debug],\n"
    "             [asr_finalization_debug] (client) and [asr_pipeline_debug]\n"
    "             (server) on each turn.\n"
)

sys.exit(0 if FAIL == 0 else 1)
