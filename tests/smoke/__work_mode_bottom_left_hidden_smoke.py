"""Smoke: VERA app sidebar replaces bottom-left utility cluster.

Run:  py -3 -X utf8 tests\\smoke\\__work_mode_bottom_left_hidden_smoke.py
"""
from __future__ import annotations

import io
import os
import sys

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

passed = 0
failed = 0


def ok(cond: bool, msg: str) -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  OK  {msg}")
    else:
        failed += 1
        print(f" FAIL {msg}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


section("index.html structure")
with open(os.path.join(_ROOT, "app/index.html"), encoding="utf-8") as f:
    html = f.read()
ok('class="vera-sidebar"' in html, "left sidebar exists")
ok('class="sidebar-brand"' in html, "sidebar brand block exists")
ok('sidebar-brand-collapsed' in html, "collapsed V mark exists")
ok('sidebar-brand-expanded' in html, "expanded VERA wordmark exists")
ok('id="vera-sidebar-brand-home"' in html, "sidebar brand home link exists")
ok('return-home-vera' not in html, "legacy header VERA wordmark removed")
ok("sidebar-actions" in html, "sidebar actions at bottom")
ok('open-bmo-from-vera' not in html, "BMO header button removed")
ok('id="vera-usage-credits"' in html, "credits pill in DOM")
ok("credit-status" in html, "subtle credit status line")
ok('id="vera-explicit-feedback-btn"' in html, "feedback button in DOM")
ok('id="vera-account-open"' in html, "account button in DOM")
ok('id="vera-settings-open"' in html, "settings button in DOM")
ok("vera-bottom-left-tools" not in html, "legacy bottom-left cluster removed")
ok('id="vera-input-guide-open"' not in html, "triple-dash guide button removed")
ok('id="vera-work-mode-guide"' not in html, "work mode GUIDE button removed")
ok('id="vera-work-guide-modal"' not in html, "old work mode guide modal removed")

section("sidebar CSS")
with open(os.path.join(_ROOT, "styles.css"), encoding="utf-8") as f:
    css = f.read()
ok(".vera-sidebar" in css, "sidebar styles present")
ok("--vera-sidebar-width" in css, "sidebar width variable present")
ok("#vera-app.vera-app-shell" in css and "padding-left" in css.split("#vera-app.vera-app-shell")[1].split("}")[0], "app shell shifts with sidebar")
ok(".sidebar-brand" in css, "sidebar brand styles present")
ok("getVeraMarketingHomeUrl" in open(os.path.join(_ROOT, "app/shell.js"), encoding="utf-8").read(), "sidebar home navigation helper exists")
sidebar_z = css.split(".vera-sidebar {", 1)[1].split("}", 1)[0]
ok("z-index: 80" in sidebar_z, "sidebar sits above bottom fade layer")
fade_block = css.split("body.chat-started .chat-centered::after {", 1)[1].split("}", 1)[0]
ok("z-index: 2" in fade_block, "bottom fade stays below sidebar and input")
ok("pointer-events: none" in fade_block, "bottom fade does not block clicks")
ok(".credit-status" in css, "subtle credit status styled")
ok(
    "#vera-app.work-mode .vera-bottom-left-tools" not in css,
    "work mode no longer hides removed bottom-left cluster",
)
ok(
    "#vera-app.work-mode .vera-bottom-right-tools" in css,
    "work mode bottom-right tools rule still present",
)
ok(
    "work-mode" in open(os.path.join(_ROOT, "app/app.js"), encoding="utf-8").read(),
    "work mode class used in app.js",
)

section("manual checklist")
print("  -- Sidebar collapsed by default; expands on hover/focus-within")
print("  -- Feedback / Account / Settings open existing flows")
print("  -- Credits + no-cap appear under voice input bar")
print("  -- Work Mode: sidebar stays available; WORK/MUSIC bottom-right unchanged")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
