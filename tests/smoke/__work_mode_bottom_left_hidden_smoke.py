"""Smoke: Work Mode hides bottom-left global controls.

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
with open(os.path.join(_ROOT, "index.html"), encoding="utf-8") as f:
    html = f.read()
ok("vera-bottom-left-tools" in html, "bottom-left tools container exists")
ok('id="vera-usage-credits"' in html, "credits pill in DOM")
ok('id="vera-explicit-feedback-btn"' in html, "feedback button in DOM")
ok('id="vera-account-open"' in html, "account button in DOM")
ok('id="vera-settings-open"' in html, "settings button in DOM")
ok('id="vera-input-guide-open"' not in html, "triple-dash guide button removed")
ok('id="vera-work-mode-guide"' not in html, "work mode GUIDE button removed")
ok('id="vera-work-guide-modal"' not in html, "old work mode guide modal removed")

section("work mode CSS hides bottom-left tools")
with open(os.path.join(_ROOT, "styles.css"), encoding="utf-8") as f:
    css = f.read()
ok(
    "#vera-app.work-mode .vera-bottom-left-tools" in css
    and "display: none" in css.split("#vera-app.work-mode .vera-bottom-left-tools")[1].split("}")[0],
    "work mode hides vera-bottom-left-tools",
)
ok(
    "#vera-app.work-mode .vera-bottom-right-tools" in css,
    "work mode bottom-right tools rule still present",
)
ok(
    "enterVeraWorkMode" in html and "classList.add(\"work-mode\")" in html,
    "work mode toggled via #vera-app.work-mode class",
)

section("manual checklist")
print("  -- Normal Voice UI: bottom-left credits/feedback/account/settings visible (no guide button)")
print("  -- Enter Work Mode: bottom-left cluster hidden; WORK/MUSIC still visible")
print("  -- Exit Work Mode: bottom-left cluster returns")
print("  -- After exit: credit pill still refreshes on reply")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
