"""Smoke: Settings guide placement + separate Account/Settings modals.

Run:  py -3 -X utf8 tests\\smoke\\__settings_guide_ui_smoke.py
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


section("separate account/settings modals")
with open(os.path.join(_ROOT, "app/index.html"), encoding="utf-8") as f:
    html = f.read()
account_modal = html.split('id="vera-account-modal"', 1)[1].split('id="vera-settings-modal"', 1)[0]
settings_modal = html.split('id="vera-settings-modal"', 1)[1].split('<script src="../config/api.js', 1)[0]
ok('id="vera-account-modal"' in html, "account modal exists")
ok('id="vera-settings-modal"' in html, "settings modal exists")
ok('id="vera-account-section"' in account_modal, "account section lives in account modal")
ok('id="vera-account-section"' not in settings_modal, "account section removed from settings modal")
ok('id="vera-settings-guide-section"' in settings_modal, "guide section lives in settings modal")
ok('id="vera-settings-guide-section"' not in account_modal, "guide section removed from account modal")
ok("How to use VERA" in settings_modal, "guide title uses VERA branding")

section("removed guide entry points")
ok("vera-input-guide-open" not in html, "no triple-dash guide button in HTML")
ok("vera-work-mode-guide" not in html, "no work mode GUIDE button in HTML")
ok("vera-work-guide-modal" not in html, "no floating work mode guide modal")

section("app.js settings open behavior")
with open(os.path.join(_ROOT, "app/app.js"), encoding="utf-8") as f:
    app_js = f.read()
ok("window.veraOpenSettingsModal = () => openSettings()" in app_js, "settings opens via veraOpenSettingsModal")
ok("window.veraOpenAccountModal = () => openAccount()" in app_js, "account opens via veraOpenAccountModal")
ok("window.veraOpenSettingsToAccountSection = () => openAccount()" in app_js, "legacy account hook maps to account modal")
ok("scrollToGuide" not in app_js, "no auto-scroll to old guide section")

section("manual checklist")
print("  -- Account button opens account-only modal")
print("  -- Settings button opens settings-only modal")
print("  -- Guide cards use SVG icons, not emoji glyphs")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
