"""
Smoke tests for news panel UI routing + specific factual question classifier
+ follow-up resolver (spec parts 1-8).
"""

# --- bootstrap (auto-added on move to tests/smoke/) ----------------------
# This file was moved from the repo root into tests/smoke/. Add the repo
# root to sys.path so `import app` (and sibling modules) still resolves.
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))
# -----------------------------------------------------------------------
import sys
import os
import types
import json

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("OPENAI_API_KEY", "test-stub")
os.environ.setdefault("SERPER_API_KEY", "test-stub")


def _stub_module(name, attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m


_stub_module("TTS", {
    "speak_to_file": lambda *a, **k: None,
    "split_sentences_for_tts": lambda *a, **k: [],
    "pop_first_complete_segment": lambda *a, **k: None,
})

import app  # noqa: E402

failures = []
passed = 0
total = 0


def check(name, predicate, info=""):
    global passed, total
    total += 1
    if predicate:
        passed += 1
        print(f"  PASS  {name}")
    else:
        msg = f"  FAIL  {name}"
        if info:
            msg += f"   ({info})"
        failures.append(msg)
        print(msg)


print("=" * 70)
print("PART 1 — 'open the news panel' triggers news.open_panel (heuristic)")
print("=" * 70)

open_panel_yes = [
    "open the news panel",
    "show the news panel",
    "pull up the news panel",
    "bring up the news panel",
    "open news panel",
    "show news tab",
    "open the news tab",
    "can you open the news panel",
    "hey vera, can you open the news panel",
    "please show the news panel",
    "open news",                  # bare imperative, whole sentence
    "show news",
    "I want the news panel",
    "let me see the news tab",
    "reopen news panel",
    "open the news widget",
    "show news results",
]
for utt in open_panel_yes:
    r = app.heuristic_route_action(utt)
    check(
        f"open_panel YES: {utt!r}",
        r is not None and r.get("action_name") == "news.open_panel",
        info=f"got {r}",
    )

# Things that must NOT be routed to news.open_panel (they're content requests):
open_panel_no = [
    "tell me the news",
    "show me breaking news",
    "what's the latest news",
    "give me today's headlines",
    "tell me about Trump",
    "tell me the news about Trump",
    "search news about Orange County",
    "I got bad news",
    "I just saw the news my friend passed away",
]
for utt in open_panel_no:
    r = app.heuristic_route_action(utt)
    check(
        f"open_panel NO: {utt!r}",
        r is None or r.get("action_name") != "news.open_panel",
        info=f"WRONGLY routed to {r}" if r else "",
    )


print()
print("=" * 70)
print("PART 1 close — 'close the news panel' triggers news.close_panel")
print("=" * 70)

close_yes = [
    "close the news panel",
    "hide the news panel",
    "dismiss the news tab",
    "close news",
    "hide news",
    "put away the news panel",
    "minimize news",
    "can you close the news panel",
]
for utt in close_yes:
    r = app.heuristic_route_action(utt)
    check(
        f"close_panel YES: {utt!r}",
        r is not None and r.get("action_name") == "news.close_panel",
        info=f"got {r}",
    )


print()
print("=" * 70)
print("classify_news_request_type — request-type categorization")
print("=" * 70)

cases = [
    # ui open/close
    ("open the news panel", "ui_open_news_panel"),
    ("show news tab", "ui_open_news_panel"),
    ("close news", "ui_close_news_panel"),
    # broad news
    ("tell me the news", "broad_news_request"),
    ("show me breaking news", "broad_news_request"),
    ("what's the latest news", "broad_news_request"),
    ("today's headlines", "broad_news_request"),
    # specific current-event question
    ("Did Trump go to China last week?", "specific_current_event_question"),
    ("Why was he there?", "general_chat"),  # pure pronoun, no entity — resolver handles
    ("Did Elon Musk win the case against OpenAI?", "specific_current_event_question"),
    ("What happened with the LA chemical fire?", "specific_current_event_question"),
    ("Is the highway still closed?", "specific_current_event_question"),
    ("What did NPR say about the China trip?", "specific_current_event_question"),
    # personal
    ("I got bad news", "personal_news_statement"),
    ("I just saw the news my friend passed away", "emotional_context"),
    ("I heard terrible news", "personal_news_statement"),
    ("the news from my family is bad", "personal_news_statement"),
    # general
    ("how are you", "general_chat"),
    ("can you explain calculus", "general_chat"),
]
for text, expected in cases:
    cls = app.classify_news_request_type(text)
    check(
        f"classify {text!r} -> {expected}",
        cls["requestType"] == expected,
        info=f"got {cls['requestType']} reason={cls['reason']}",
    )


print()
print("=" * 70)
print("PART 4 — resolve_followup_for_news_question (pronoun continuation)")
print("=" * 70)

# Test 4 — pronoun follow-up after a Trump/China question
history = [
    {"role": "user", "content": "do you know if Trump went to China last week"},
    {"role": "assistant", "content": "Based on what I found, Trump did make a trip last week..."},
]
r = app.resolve_followup_for_news_question(
    "do you know why he was there",
    history=history,
)
check(
    "follow-up: 'why he was there' resolves with prior China trip context",
    r["followupDetected"] and r["followupKind"] == "pronoun_continuation"
    and r["shouldSearchAgain"]
    and "Trump" in r["resolvedQuestion"],
    info=f"got {r}",
)

# Test 5 — new topic introduced (Elon Musk) — fresh search, no Trump/China reuse
r2 = app.resolve_followup_for_news_question(
    "do you know if Elon Musk won the case against OpenAI",
    history=history,
)
check(
    "follow-up: new entity introduces fresh topic (Elon Musk, no Trump/China reuse)",
    r2["shouldSearchAgain"]
    and r2["resolvedQuestion"] == "do you know if Elon Musk won the case against OpenAI"
    and "Trump" not in r2["resolvedQuestion"],
    info=f"got {r2}",
)

# Pure verbatim specific question with no prior history
r3 = app.resolve_followup_for_news_question(
    "did Trump go to China last week",
    history=[],
)
check(
    "no prior context: specific question routes shouldSearchAgain=True verbatim",
    r3["shouldSearchAgain"] and r3["followupKind"] == "none",
    info=f"got {r3}",
)

# Non-news chat history with vague follow-up
r4 = app.resolve_followup_for_news_question(
    "what about it",
    history=[
        {"role": "user", "content": "I had a great day at the park"},
        {"role": "assistant", "content": "That sounds wonderful!"},
    ],
)
check(
    "no prior specific-news context: should not search",
    not r4["shouldSearchAgain"],
    info=f"got {r4}",
)


print()
print("=" * 70)
print("PART 6 — News panel commands must NOT route to Work Mode reasoning")
print("=" * 70)

# Manual emulation of finalize() post-LLM override
# The LLM might wrongly return work_mode.reasoning_open_panel for the user's
# phrase. We check that our _is_news_panel_open_request guard catches it.
for utt in [
    "open the news panel",
    "show the news panel",
    "close the news panel",
]:
    is_open = app._is_news_panel_open_request(utt)
    is_close = app._is_news_panel_close_request(utt)
    check(
        f"news panel guard catches: {utt!r}",
        is_open or is_close,
        info=f"open={is_open} close={is_close}",
    )

# Conversely, do NOT catch "open new reasoning panel"
for utt in [
    "open a new reasoning panel",
    "create a new reasoning space",
    "switch to the calculus panel",
    "open music panel",          # belongs to music
    "open the music tab",
]:
    is_open = app._is_news_panel_open_request(utt)
    is_close = app._is_news_panel_close_request(utt)
    check(
        f"news panel guard does NOT catch: {utt!r}",
        not is_open and not is_close,
        info=f"open={is_open} close={is_close}",
    )


print()
print("=" * 70)
print("Spec PART 8 — manual tests")
print("=" * 70)

# Test 1 — Open news panel
r = app.heuristic_route_action("can you open the news panel")
check(
    "spec_test_1: 'can you open the news panel' -> news.open_panel",
    r is not None and r.get("action_name") == "news.open_panel",
    info=f"got {r}",
)

# Test 2 — Broad news
cls = app.classify_news_request_type("tell me the news")
check(
    "spec_test_2: 'tell me the news' -> broad_news_request",
    cls["requestType"] == "broad_news_request",
    info=f"got {cls}",
)

# Test 3 — Specific current question
cls = app.classify_news_request_type("do you know if Trump went to China last week")
check(
    "spec_test_3: 'do you know if Trump went to China last week' -> specific_current_event_question",
    cls["requestType"] == "specific_current_event_question",
    info=f"got {cls}",
)

# Test 4 — Follow-up: resolved with prior context
r = app.resolve_followup_for_news_question(
    "do you know why he was there",
    history=[{"role": "user", "content": "did Trump go to China last week"}],
)
check(
    "spec_test_4: pronoun follow-up resolves Trump+China + searches again",
    r["followupKind"] == "pronoun_continuation"
    and r["shouldSearchAgain"]
    and "Trump" in r["resolvedQuestion"],
    info=f"got {r}",
)

# Test 5 — New topic specific question
r2 = app.resolve_followup_for_news_question(
    "do you know if Elon Musk won the case against OpenAI",
    history=[{"role": "user", "content": "did Trump go to China last week"}],
)
check(
    "spec_test_5: new entity does not reuse Trump/China sources",
    r2["resolvedQuestion"] == "do you know if Elon Musk won the case against OpenAI",
    info=f"got {r2}",
)

# Test 6 — Personal news should not search
cls = app.classify_news_request_type("I just saw the news my friend passed away")
check(
    "spec_test_6: personal/emotional news -> emotional_context",
    cls["requestType"] == "emotional_context",
    info=f"got {cls}",
)
# And no UI action either
r = app.heuristic_route_action("I just saw the news my friend passed away")
check(
    "spec_test_6b: personal news does NOT route to news.open_panel",
    r is None or r.get("action_name") not in ("news.open_panel", "news.latest"),
    info=f"got {r}",
)

# Test 7 — Research mode explicit (should NOT be intercepted as news panel)
for utt in [
    "make a detailed research brief about this in the reasoning panel",
    "put this in reasoning",
    "open a new reasoning panel",
]:
    is_news_panel = app._is_news_panel_open_request(utt) or app._is_news_panel_close_request(utt)
    check(
        f"spec_test_7: reasoning-panel request NOT intercepted as news: {utt!r}",
        not is_news_panel,
        info=f"news_panel_match={is_news_panel}",
    )


print()
print("=" * 70)
print(f"RESULT: {passed}/{total} passed, {len(failures)} failed")
print("=" * 70)
if failures:
    print()
    for f in failures:
        print(f)
    sys.exit(1)
sys.exit(0)
