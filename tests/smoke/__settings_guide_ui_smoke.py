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
ok("Pause before VERA responds" in html, "voice timing label uses user-facing copy")
ok("vera-settings-asr-section" in html, "speech recognition is its own settings section")
ok("Speech recognition" in settings_modal, "ASR section has dedicated heading")
ok("vera-settings-session-section" in html, "session section exists for destructive reset")
ok('id="vera-setting-reset-session"' in settings_modal, "reset session button in settings modal")
voice_timing_section = settings_modal.split('vera-settings-voice-timing-section', 1)[1].split('vera-settings-asr-section', 1)[0]
ok('id="vera-setting-reset-session"' not in voice_timing_section, "reset session removed from voice timing section")
ok('id="vera-setting-asr-streaming"' in settings_modal.split('vera-settings-asr-section', 1)[1].split('vera-settings-work-mode-section', 1)[0], "ASR mode buttons live in speech recognition section")
ok("Mute spoken responses in Work Mode" in html, "work mode mute uses clarified label")
ok('id="vera-setting-main-partial-min"' not in html, "main streaming ASR control removed from settings")
ok('id="vera-setting-text-guide-rotator"' not in html, "text guide rotator removed from settings")
ok('id="vera-setting-planning-deadline-timer"' not in html, "planning deadline timer removed from settings")
ok("setMainAsrPartialMinChars(draftMainAsrPartialMinChars)" not in app_js, "save no longer writes hidden main ASR partial setting")
ok("syncVeraInputEmptyState" in app_js and "markVeraConversationActive" in app_js, "empty-state input helpers exist")
ok('id="vera-empty-greeting"' in html and "Ready when you are." in html, "centered empty greeting present")
ok("vera-input-stage" in html and "vera-input-shell" in html, "input stage wraps greeting rotator and bar")
ok("vera-headset-hint" in html and "VERA works best with a headset or AirPods." in html, "bottom headset guidance present")
with open(os.path.join(_ROOT, "styles.css"), encoding="utf-8") as f:
    css = f.read()
ok("is-startup-empty" in css and "is-active-session" in css, "startup/active session layout classes styled")
ok(".vera-input-stage" in css and ".guide-text-rotator" in css, "fixed input stage and rotator column styled")
ok("closeSettings();" in app_js and "saveBtn.textContent = \"Saved\"" in app_js, "save settings shows confirmation and closes modal")

section("settings save button styles")
with open(os.path.join(_ROOT, "styles.css"), encoding="utf-8") as f:
    css = f.read()
ok(".vera-settings-save-btn.is-saved" in css, "saved state styled on save button")
ok("vera-settings-asr-options" in css, "ASR options use prominent card layout styles")

section("manual checklist")
print("  -- Account button opens account-only modal")
print("  -- Settings button opens settings-only modal")
print("  -- Voice timing section contains only pause slider")
print("  -- Speech recognition is a separate prominent section")
print("  -- Session section contains Reset session (immediate, with confirm)")
print("  -- Save settings persists voice timing, ASR mode, and work mode mute")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
