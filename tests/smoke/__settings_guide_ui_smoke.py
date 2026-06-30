"""Smoke: Settings guide placement + removed floating guide controls.

Run:  py -3 -X utf8 tests\\smoke\\__settings_guide_ui_smoke.py
"""
from __future__ import annotations

import io
import os
import re
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


section("settings modal section order")
with open(os.path.join(_ROOT, "app/index.html"), encoding="utf-8") as f:
    html = f.read()
modal = html.split('id="vera-settings-modal"', 1)[1].split("</div>\n</div>", 1)[0]
account_pos = modal.find('id="vera-account-section"')
guide_pos = modal.find('id="vera-settings-guide-section"')
universal_pos = modal.find("<h3>Universal</h3>")
ok(account_pos >= 0 and guide_pos > account_pos, "How to use Vera follows Account")
ok(guide_pos >= 0 and universal_pos > guide_pos, "Universal follows How to use Vera")

section("removed guide entry points")
ok("vera-input-guide-open" not in html, "no triple-dash guide button in HTML")
ok("vera-work-mode-guide" not in html, "no work mode GUIDE button in HTML")
ok("vera-work-guide-modal" not in html, "no floating work mode guide modal")

section("app.js settings open behavior")
with open(os.path.join(_ROOT, "app.js"), encoding="utf-8") as f:
    app_js = f.read()
ok("window.veraOpenSettingsModal = () => open()" in app_js, "settings opens via veraOpenSettingsModal")
ok(
    "window.veraOpenSettingsToAccountSection = () => open({ scrollTo: \"account\" })"
    in app_js,
    "account opens settings scrolled to account",
)
ok("veraOpenSettingsToGuideSection" not in app_js, "old scroll-to-bottom guide hook removed")
ok("scrollToGuide" not in app_js, "no auto-scroll to old guide section")

section("manual checklist")
print("  -- Voice UI: Settings + Account visible; no triple-dash button")
print("  -- Work Mode: Work + Music visible; no GUIDE button")
print("  -- Settings: Account then How to use Vera near top")
print("  -- Account: opens Settings with login fields in view")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
