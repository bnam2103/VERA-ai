"""Smoke: voice.answer + info.finance collapse and news guard for stock quotes.

Run: py tests/smoke/__finance_voice_answer_collapse_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402

import contextlib
import io

_buf = io.StringIO()
with contextlib.redirect_stdout(_buf), contextlib.redirect_stderr(_buf):
    import app  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"
PASS = 0
FAIL = 0
FAILED: list[str] = []


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}")
        if detail:
            print(f"         {detail[:600]}")


def types_of(plan: dict) -> list[str]:
    return [a["type"] for a in (plan.get("actions") or [])]


def spans_of(plan: dict) -> list[str]:
    return [str(a.get("span") or "") for a in (plan.get("actions") or [])]


section("Planner — finance quote collapse (no voice.answer prefix)")
for text in [
    "What's the latest Nvidia stock price?",
    "What's Nvidia's latest stock price?",
    "What is NVDA trading at?",
]:
    p = P.plan_user_actions(text)
    t = types_of(p)
    ok("voice.answer" not in t, f"no voice.answer: {text[:50]}", str(t))
    ok("info.finance" in t, f"has info.finance: {text[:50]}", str(spans_of(p)))
    ok("info.news" not in t, f"no info.news: {text[:50]}", str(t))

section("Planner — compound NVDA + panel + checklist")
compound = (
    "What's the latest Nvidia stock price, open a new panel, "
    "and add check portfolio to my checklist."
)
cp = P.plan_user_actions(compound)
ct = types_of(cp)
ok("voice.answer" not in ct, "compound: no voice.answer", str(ct))
ok("info.finance" in ct, "compound: info.finance", str(spans_of(cp)))
ok("panel.open" in ct, "compound: panel.open", str(ct))
ok("checklist.add" in ct, "compound: checklist.add", str(ct))
ok("info.news" not in ct, "compound: no info.news", str(ct))

section("Planner — latest Nvidia news stays news")
news_p = P.plan_user_actions("What's the latest Nvidia news?")
nt = types_of(news_p)
ok("info.news" in nt or "voice.answer" in nt, "Nvidia news has news path", str(nt))
ok(
    not (
        nt == ["info.finance"]
        or (nt.count("info.finance") == 1 and "info.news" not in nt and "voice.answer" not in nt)
    ),
    "Nvidia news is not finance-only",
    str(spans_of(news_p)),
)

section("Planner — explicit news + finance compound")
both_p = P.plan_user_actions("What's the latest news and Nvidia stock price?")
bt = types_of(both_p)
ok("info.finance" in bt, "news+finance: finance present", str(bt))
ok(
    "info.news" in bt or any("news" in s.lower() for s in spans_of(both_p)),
    "news+finance: news present",
    str(spans_of(both_p)),
)

section("News guard — bare latest blocked when finance in full turn")
ok(
    app._bare_latest_news_blocked_by_finance_anchor(
        "What's the latest",
        full_turn="What's the latest Nvidia stock price?",
    ),
    "blocks bare latest with finance in full turn",
)
_plan_token = app._planner_plan_raw_text_var.set(
    "What's the latest Nvidia stock price, open a new panel, and add check portfolio to my checklist."
)
try:
    cls_blocked = app.classify_news_search_intent("What's the latest")
finally:
    app._planner_plan_raw_text_var.reset(_plan_token)
ok(
    not cls_blocked.get("shouldSearchNews"),
    "classify_news_search_intent blocks bare latest fragment",
    str(cls_blocked.get("reason")),
)

section("News guard — real news requests still allowed")
for text in [
    "What's the latest news?",
]:
    cls = app.classify_news_search_intent(text)
    ok(cls.get("shouldSearchNews") is True, f"news allowed: {text}", str(cls.get("reason")))

ok(
    app.is_explicit_general_news_intent("What are the latest headlines?"),
    "headlines route via explicit general news intent",
)

ok(
    not app._bare_latest_news_blocked_by_finance_anchor("What's the latest news?"),
    "latest news span not blocked by finance guard",
)

print(f"\n{PASS} passed, {FAIL} failed")
if FAILED:
    print("Failed:", ", ".join(FAILED))
    sys.exit(1)
