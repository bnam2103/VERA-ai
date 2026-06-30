"""Smoke: Work Mode layout survives image/PDF reasoning upload lifecycle.

Run:  py -3 -X utf8 tests\\smoke\\__work_mode_upload_layout_smoke.py
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


section("app.js layout recalc hook")
with open(os.path.join(_ROOT, "app.js"), encoding="utf-8") as f:
    app_js = f.read()
ok("function scheduleRecalcWorkModeLayoutAfterReasoning" in app_js, "layout recalc helper defined")
ok(
    "window.scheduleRecalcWorkModeLayoutAfterReasoning = scheduleRecalcWorkModeLayoutAfterReasoning"
    in app_js,
    "layout recalc helper exported on window",
)
ok(
    "scheduleRecalcWorkModeLayoutAfterReasoning(st)" in app_js,
    "safeReasoningLaneRelease schedules layout recalc",
)
ok("function logWmUploadLayoutDebug" in app_js, "gated upload layout debug logger")
ok(
    "window.__veraWmUploadLayoutDebug" in app_js,
    "debug logs gated behind __veraWmUploadLayoutDebug",
)
ok(
    re.search(
        r"function safeReasoningLaneRelease[\s\S]{0,2200}closeWorkModeAttachmentPreviewModal\(\)",
        app_js,
    ),
    "preview modal closed on reasoning lane release",
)

section("styles.css narrow + center column")
with open(os.path.join(_ROOT, "styles.css"), encoding="utf-8") as f:
    css = f.read()
ok(
    "grid-template-rows: auto minmax(0, 1.15fr) minmax(0, 1fr)" in css,
    "narrow work mode grid gives center row fractional height",
)
ok(
    re.search(
        r"#vera-app\.work-mode \.vera-wm-center\s*\{[^}]*overflow:\s*hidden",
        css,
        re.S,
    ),
    "work mode center column contains flex children (overflow hidden)",
)
ok(
    "#vera-app.work-mode .vera-wm-left,\n#vera-app.work-mode .vera-wm-center,\n#vera-app.work-mode .vera-wm-right" in css,
    "grid children stretch with min-height: 0",
)

section("manual checklist")
print("  1. Open Work Mode (viewport > 768px wide)")
print("  2. Upload an image/photo in the reasoning composer")
print("  3. Ask Vera to analyze it; wait for completion")
print("  4. Confirm music/checklist/reasoning panels remain visible (not stuck at top)")
print("  5. Confirm reasoning scroll area has height; composer still usable")
print("  6. Confirm bottom-left credits/feedback/account stay hidden in Work Mode")
print("  7. Force error (disconnect backend or hit 429): friendly error, layout intact")
print("  8. Exit and re-enter Work Mode: layout normal")
print("  Optional: set window.__veraWmUploadLayoutDebug = true and watch [wm_upload_layout] logs")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
