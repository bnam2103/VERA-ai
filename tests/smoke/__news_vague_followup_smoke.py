"""
Smoke tests for the news / search routing + vague follow-up fix.

Covers:
  - PART 1: bare "news" keyword must not trigger news panel
  - PART 2: personal/emotional override beats explicit news shape
  - PART 4: vague follow-ups must resolve to recent chat context (not news panel)
  - PART 6: stale news context dropped when next message is personal/emotional
  - PART 9 spec tests 1-6
"""

# --- bootstrap (auto-added on move to tests/smoke/) ----------------------
# This file was moved from the repo root into tests/smoke/. Add the repo
# root to sys.path so `import app` (and sibling modules) still resolves.
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))
# -----------------------------------------------------------------------
import sys
import os
import json
import types

# Force UTF-8 stdout/stderr so app.py's startup banners (which contain
# unicode arrows like "Ã¢” ’") don't crash on Windows cp1252 consoles.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Patch out heavy imports so we can import app.py purely for the classifier logic.
os.environ.setdefault("OPENAI_API_KEY", "test-stub")
os.environ.setdefault("SERPER_API_KEY", "test-stub")

# Stub TTS, STT, and any other heavy modules BEFORE importing app.
def _stub_module(name: str, attrs: dict):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


_stub_module("TTS", {
    "speak_to_file": lambda *a, **k: None,
    "split_sentences_for_tts": lambda *a, **k: [],
    "pop_first_complete_segment": lambda *a, **k: None,
})

# STT/whisper too if app imports it
for mod_name in ("STT", "stt", "whisper_stt"):
    _stub_module(mod_name, {
        "transcribe_audio": lambda *a, **k: "",
        "warmup": lambda *a, **k: None,
    })

import app  # noqa: E402

failures: list[str] = []
passed = 0
total = 0


def check(name: str, predicate: bool, info: str = ""):
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
print("PART 1 — bare 'news' keyword does NOT trigger news search")
print("=" * 70)

part1_negatives = [
    "I just saw the news my friend passed away",
    "I got bad news",
    "I heard terrible news",
    "The news from my family is bad",
    "I don't know how to feel about this news",
    "My friend passed away",
]
for utterance in part1_negatives:
    intent = app.detect_news_route_intent(utterance, recent_news_context=None)
    cls = intent.get("intent_classification") or {}
    check(
        f"negative: {utterance!r}",
        intent["action"] == "skip" and (
            cls.get("personalNewsStatementDetected")
            or cls.get("emotionalContextDetected")
            or intent["reason"] in ("bare_news_keyword_no_request_shape", "current_or_recent_without_request_shape")
        ),
        info=f"action={intent['action']} reason={intent['reason']} cls.intentType={cls.get('intentType')}",
    )

part1_positives = [
    "Tell me the latest news",
    "Show me breaking news",
    "Search news about Orange County",
    "What's the latest on the LA fire?",
    "Find articles about the election",
    "Any updates on the highway closure?",
]
for utterance in part1_positives:
    intent = app.detect_news_route_intent(utterance, recent_news_context=None)
    cls = intent.get("intent_classification") or {}
    check(
        f"positive: {utterance!r}",
        intent["action"] in ("news_search", "news_category_prompt") or cls.get("shouldSearchNews"),
        info=f"action={intent['action']} reason={intent['reason']} shouldSearchNews={cls.get('shouldSearchNews')} intentType={cls.get('intentType')}",
    )


print()
print("=" * 70)
print("PART 2 — personal/emotional override beats news request shape")
print("=" * 70)

mixed = [
    # request shape + personal/emotional Ã¢” ’ suppress
    "Tell me what happened, my friend just died",
    "Search news, I just got terrible news about my dad",
    "What's the latest, my mom passed away",
]
for utterance in mixed:
    intent = app.detect_news_route_intent(utterance, recent_news_context=None)
    cls = intent.get("intent_classification") or {}
    check(
        f"override: {utterance!r}",
        intent["action"] == "skip" and (
            cls.get("personalNewsStatementDetected") or cls.get("emotionalContextDetected")
        ),
        info=f"action={intent['action']} reason={intent['reason']} cls={ {k: cls.get(k) for k in ('personalNewsStatementDetected','emotionalContextDetected','intentType')} }",
    )


print()
print("=" * 70)
print("PART 4 — vague follow-up phrase classifier")
print("=" * 70)

vague_yes = [
    "I'm not sure how I should feel about this",
    "I don't know what to think",
    "What should I do",
    "What should I do now?",
    "what now?",
    "how should I feel",
    "about this",
    "about that?",
    "this",
    "I'm so lost",
    "I'm overwhelmed",
    "why do I feel like this",
]
for utterance in vague_yes:
    check(
        f"vague YES: {utterance!r}",
        app._is_vague_followup_phrase(utterance),
        info=f"phrase did not match vague regex",
    )

vague_no = [
    "Tell me the latest news",
    "Search news about Orange County",
    "Summarize the first result",
    "What about result 2?",
    "Open the article",
]
for utterance in vague_no:
    check(
        f"vague NO: {utterance!r}",
        not app._is_vague_followup_phrase(utterance),
        info="phrase wrongly flagged as vague",
    )


print()
print("=" * 70)
print("PART 4/5 — resolveVagueFollowupTarget routes vague follow-ups to chat context")
print("=" * 70)

# Recent chat: user shared personal grief Ã¢” ’ vague follow-up must route to recent_chat_context
history_grief = [
    {"role": "user", "content": "Wait nvm I just saw the news my friend just passed away"},
    {"role": "assistant", "content": "I'm so sorry. That's devastating."},
]

scenarios = [
    {
        "name": "vague follow-up + grief in chat Ã¢” ’ recent_chat_context",
        "text": "I'm not sure how I should feel about this",
        "history": history_grief,
        "news_ctx": {"topic": "LA fire", "entities": ["LA"], "timeframe": "today"},
        "expected_target": "recent_chat_context",
        "expected_allowed": False,
    },
    {
        "name": "vague follow-up + no personal chat + news panel Ã¢” ’ may use side panel",
        "text": "What about that?",
        "history": [{"role": "user", "content": "Tell me the latest news on the election"}],
        "news_ctx": {"topic": "election", "entities": ["Trump"], "timeframe": "today"},
        "expected_target": "active_news_panel",
        "expected_allowed": True,
    },
    {
        "name": "explicit side-panel reference always wins (even with grief in chat)",
        "text": "Summarize the first result",
        "history": history_grief,
        "news_ctx": {"topic": "LA fire", "entities": ["LA"], "timeframe": "today"},
        "expected_target": "active_news_panel",
        "expected_allowed": True,
    },
    {
        "name": "non-vague conversational reply with no news ctx Ã¢” ’ default recent_chat_context",
        "text": "I feel sad today",
        "history": [],
        "news_ctx": None,
        "expected_target": "recent_chat_context",
        "expected_allowed": False,
    },
]

for sc in scenarios:
    vt = app.resolve_vague_followup_target(
        sc["text"],
        recent_news_context=sc["news_ctx"],
        history=sc["history"],
        active_side_panel=("news" if sc["news_ctx"] else ""),
    )
    check(
        sc["name"],
        vt["target"] == sc["expected_target"]
        and bool(vt.get("activeSidePanelAllowedAsContext")) == sc["expected_allowed"],
        info=f"got target={vt.get('target')} allowed={vt.get('activeSidePanelAllowedAsContext')} reason={vt.get('reason')}",
    )


print()
print("=" * 70)
print("Recent chat personal/emotional detector")
print("=" * 70)

check(
    "recent chat detects 'passed away'",
    app._recent_chat_has_personal_emotional_context([
        {"role": "user", "content": "My friend passed away"},
        {"role": "assistant", "content": "I'm so sorry"},
    ])["detected"],
)
check(
    "recent chat detects 'I got bad news'",
    app._recent_chat_has_personal_emotional_context([
        {"role": "user", "content": "I got bad news today"},
        {"role": "assistant", "content": "What happened?"},
    ])["detected"],
)
check(
    "recent chat does NOT flag news-search history as personal",
    not app._recent_chat_has_personal_emotional_context([
        {"role": "user", "content": "Tell me the latest news"},
        {"role": "assistant", "content": "Here are today's top stories: ..."},
    ])["detected"],
)
check(
    "recent chat handles empty history",
    not app._recent_chat_has_personal_emotional_context([])["detected"],
)
check(
    "recent chat handles None",
    not app._recent_chat_has_personal_emotional_context(None)["detected"],
)


print()
print("=" * 70)
print("PART 9 spec tests — 6 manual scenarios from the spec")
print("=" * 70)

# Spec Test 1 — Personal bad news should not search
t1 = app.detect_news_route_intent(
    "Wait nvm I just saw the news my friend just passed away", recent_news_context=None
)
check(
    "spec_test_1: 'Wait nvm I just saw the news my friend just passed away' Ã¢” ’ skip",
    t1["action"] == "skip"
    and (t1["intent_classification"].get("personalNewsStatementDetected")
         or t1["intent_classification"].get("emotionalContextDetected")),
    info=f"action={t1['action']} reason={t1['reason']}",
)

# Spec Test 2 — Follow-up uses grief context
vt2 = app.resolve_vague_followup_target(
    "I'm not sure how I should feel about this",
    recent_news_context={"topic": "stale topic", "entities": []},  # stale news panel still open
    history=[
        {"role": "user", "content": "My friend passed away"},
        {"role": "assistant", "content": "I'm so sorry"},
    ],
    active_side_panel="news",
)
check(
    "spec_test_2: vague follow-up after grief Ã¢” ’ recent_chat_context, news panel NOT allowed",
    vt2["target"] == "recent_chat_context"
    and vt2["activeSidePanelAllowedAsContext"] is False,
    info=f"target={vt2['target']} allowed={vt2.get('activeSidePanelAllowedAsContext')} reason={vt2.get('reason')}",
)

# Spec Test 3 — Explicit news request still searches
t3 = app.detect_news_route_intent("Tell me the latest news", recent_news_context=None)
check(
    "spec_test_3: 'Tell me the latest news' Ã¢” ’ news_search",
    t3["action"] == "news_search"
    or t3["intent_classification"].get("shouldSearchNews"),
    info=f"action={t3['action']} reason={t3['reason']}",
)

# Spec Test 4 — Explicit side panel follow-up: "Summarize the first result"
vt4 = app.resolve_vague_followup_target(
    "Summarize the first result",
    recent_news_context={"topic": "election", "entities": ["Trump"]},
    history=[{"role": "user", "content": "Show me breaking news"}],
    active_side_panel="news",
)
check(
    "spec_test_4: 'Summarize the first result' Ã¢” ’ active_news_panel",
    vt4["target"] == "active_news_panel"
    and vt4["activeSidePanelAllowedAsContext"] is True,
    info=f"target={vt4['target']} allowed={vt4.get('activeSidePanelAllowedAsContext')} reason={vt4.get('reason')}",
)

# Spec Test 5 — Vague follow-up after news panel but personal chat is latest
vt5 = app.resolve_vague_followup_target(
    "What should I do now?",
    recent_news_context={"topic": "earlier search", "entities": []},
    history=[
        {"role": "user", "content": "Tell me the latest news"},
        {"role": "assistant", "content": "Here are some headlines"},
        {"role": "user", "content": "My friend passed away"},
        {"role": "assistant", "content": "I'm so sorry"},
    ],
    active_side_panel="news",
)
check(
    "spec_test_5: vague follow-up with personal grief as LATEST Ã¢” ’ recent_chat_context",
    vt5["target"] == "recent_chat_context"
    and vt5["activeSidePanelAllowedAsContext"] is False,
    info=f"target={vt5['target']} allowed={vt5.get('activeSidePanelAllowedAsContext')} reason={vt5.get('reason')}",
)

# Spec Test 6 — Personal news phrase
t6 = app.detect_news_route_intent("I got bad news today", recent_news_context=None)
check(
    "spec_test_6: 'I got bad news today' Ã¢” ’ skip (personal_news_statement)",
    t6["action"] == "skip"
    and t6["intent_classification"].get("personalNewsStatementDetected"),
    info=f"action={t6['action']} reason={t6['reason']}",
)


print()
print("=" * 70)
print("news-followup personal/emotional guard suppresses follow-up resolvers")
print("=" * 70)

# This is the key end-to-end path: the bad first message would set news_ctx,
# then the follow-up "I'm not sure how I should feel about this" hits
# try_resolve_news_followup_corrective. The guard must short-circuit it.
class _DummySession:
    sid = "test-session-x"

# Seed stale news context
app.recent_news_context[_DummySession.sid] = {
    "topic": "stale news topic", "entities": [], "timeframe": "today",
    "result_titles": [], "result_sources": [], "original_user_query": "old query",
}

suppressed = app._news_followup_personal_emotional_guard(
    _DummySession.sid,
    "I'm not sure how I should feel about this",
    [
        {"role": "user", "content": "Wait nvm I just saw the news my friend just passed away"},
        {"role": "assistant", "content": "I'm so sorry"},
    ],
    flow="test",
)
check(
    "guard suppresses follow-up when recent chat is personal/emotional",
    suppressed is True,
)
check(
    "guard ALSO drops stale recent_news_context",
    _DummySession.sid not in app.recent_news_context,
)

# Re-seed and try with an EXPLICIT side-panel reference — guard must NOT suppress.
app.recent_news_context[_DummySession.sid] = {
    "topic": "election", "entities": ["Trump"], "timeframe": "today",
    "result_titles": ["Headline"], "result_sources": ["AP"], "original_user_query": "election",
}
not_suppressed = app._news_followup_personal_emotional_guard(
    _DummySession.sid,
    "Summarize the first result",
    [{"role": "user", "content": "Tell me the latest news"}],
    flow="test",
)
check(
    "guard does NOT suppress explicit side-panel reference",
    not_suppressed is False,
)
check(
    "guard did NOT drop news_ctx for explicit side-panel reference",
    _DummySession.sid in app.recent_news_context,
)

# New message itself is personal Ã¢” ’ guard MUST suppress even if chat is empty.
suppressed_new = app._news_followup_personal_emotional_guard(
    _DummySession.sid,
    "I just heard terrible news, my dad died",
    [],
    flow="test",
)
check(
    "guard suppresses when new message itself is personal/emotional",
    suppressed_new is True,
)


print()
print("=" * 70)
print("Regression checks from previous turn (the three tricky cases)")
print("=" * 70)

regressions = [
    # (text, expected_intent_type_or_action, expected_personal_or_emotional)
    ("I have breaking news for you", "personal_news_statement", True),
    ("after my nap I wanted some news eventually", "personal_news_statement", True),
    ("Tell me a joke", "general_chat", False),
]
for text, expected_type, expected_personal in regressions:
    cls = app.classify_news_search_intent(text)
    if expected_personal:
        ok = (
            cls.get("personalNewsStatementDetected") or cls.get("emotionalContextDetected")
        ) and not cls.get("shouldSearchNews")
    else:
        ok = not cls.get("shouldSearchNews") and not (
            cls.get("personalNewsStatementDetected") or cls.get("emotionalContextDetected")
        )
    check(
        f"regression: {text!r} -> {expected_type}",
        ok,
        info=f"intentType={cls.get('intentType')} shouldSearch={cls.get('shouldSearchNews')} personal={cls.get('personalNewsStatementDetected')} emotional={cls.get('emotionalContextDetected')}",
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
