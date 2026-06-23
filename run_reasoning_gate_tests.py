#!/usr/bin/env python3
"""
Batch-test VERA reasoning gate.

Preferred endpoint:
  POST /debug/reasoning_gate

Fallback endpoint:
  POST /work_mode/classify

Usage:
  py -3 run_reasoning_gate_tests.py --base-url http://127.0.0.1:8000 --file reasoning_gate_test_cases.jsonl
  py -3 run_reasoning_gate_tests.py --base-url http://127.0.0.1:8000 --file reasoning_gate_test_cases.jsonl --endpoint /work_mode/classify
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, Optional

import requests


def normalize_route(data: Dict[str, Any]) -> str:
    # New debug shape
    route = data.get("route") or data.get("reasoning_gate_result")
    if route:
        return str(route)

    # Existing classifier shape
    if data.get("prompt_reasoning") is True or data.get("route_reasoning") is True:
        return "reasoning_panel"
    if data.get("prompt_reasoning") is False or data.get("route_reasoning") is False:
        return "voice_ui"

    diagnostics = data.get("diagnostics") or {}
    route = diagnostics.get("reasoning_gate_result") or diagnostics.get("route")
    if route:
        return str(route)

    return "unknown"


def normalize_reason(data: Dict[str, Any]) -> Optional[str]:
    diagnostics = data.get("diagnostics") or {}
    return (
        data.get("reason")
        or data.get("reasoning_gate_reason")
        or diagnostics.get("reasoning_gate_reason")
        or data.get("category")
        or data.get("source")
    )


def normalize_topic(data: Dict[str, Any]) -> Optional[str]:
    diagnostics = data.get("diagnostics") or {}
    return data.get("resolved_topic") or diagnostics.get("resolved_topic") or data.get("topic")


def normalize_target_panel(data: Dict[str, Any]) -> Optional[int]:
    diagnostics = data.get("diagnostics") or {}
    val = data.get("target_panel", diagnostics.get("target_panel"))
    try:
        return int(val) if val is not None else None
    except Exception:
        return None


def post_case(base_url: str, endpoint: str, case: Dict[str, Any]) -> Dict[str, Any]:
    url = f"{base_url.rstrip('/')}{endpoint}"
    payload = {
        "text": case["text"],
        "transcript": case["text"],
        "active_work_mode": "1",
        "previous_user_text": case.get("previous_user_text", ""),
        "active_panel_index": str(case.get("active_panel_index", "")),
    }

    # Try JSON first.
    r = requests.post(url, json=payload, timeout=60)
    try:
        data = r.json()
    except Exception:
        # Retry form data because some endpoints are form-only.
        r = requests.post(url, data=payload, timeout=60)
        try:
            data = r.json()
        except Exception:
            data = {"raw_text": r.text[:2000]}

    return {"status_code": r.status_code, "data": data}


def check_case(case: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    route = normalize_route(data)
    reason = normalize_reason(data)
    topic = normalize_topic(data)
    target = normalize_target_panel(data)

    expected_route = case.get("expected_route")
    route_pass = (route == expected_route) if expected_route else None

    reason_pass = None
    if case.get("expected_reason") and reason:
        # loose, because reason names may vary.
        reason_pass = case["expected_reason"] in str(reason)

    topic_pass = None
    if case.get("expected_resolved_topic"):
        topic_pass = case["expected_resolved_topic"].lower() in str(topic or "").lower()

    target_pass = None
    if case.get("expected_target_panel") is not None:
        target_pass = target == int(case["expected_target_panel"])

    pass_flags = [x for x in (route_pass, reason_pass, topic_pass, target_pass) if x is not None]
    passed = all(pass_flags) if pass_flags else None

    return {
        "pass": passed,
        "expected_route": expected_route,
        "actual_route": route,
        "expected_reason": case.get("expected_reason"),
        "actual_reason": reason,
        "expected_resolved_topic": case.get("expected_resolved_topic"),
        "actual_resolved_topic": topic,
        "expected_target_panel": case.get("expected_target_panel"),
        "actual_target_panel": target,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--endpoint", default="/debug/reasoning_gate")
    ap.add_argument("--file", default="reasoning_gate_test_cases.jsonl")
    ap.add_argument("--out", default="reasoning_gate_test_results.jsonl")
    ap.add_argument("--delay", type=float, default=0.1)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--stop-on-fail", action="store_true")
    args = ap.parse_args()

    cases = [json.loads(x) for x in Path(args.file).read_text(encoding="utf-8").splitlines() if x.strip()]
    pass_count = fail_count = advisory_count = 0

    with Path(args.out).open("w", encoding="utf-8") as out:
        for case in cases:
            print(f"[{case['id']}] {case['text']}")
            if args.dry_run:
                result = {"case": case, "dry_run": True}
                print("  expected:", case.get("expected_route"), case.get("expected_reason", ""))
            else:
                try:
                    response = post_case(args.base_url, args.endpoint, case)
                    match = check_case(case, response["data"])
                    if match["pass"] is True:
                        pass_count += 1
                    elif match["pass"] is False:
                        fail_count += 1
                    else:
                        advisory_count += 1

                    result = {"case": case, "response": response, "match": match}
                    print("  route:", match["actual_route"])
                    print("  reason:", match["actual_reason"])
                    print("  topic:", match["actual_resolved_topic"])
                    print("  target:", match["actual_target_panel"])
                    print("  match:", "PASS" if match["pass"] else "FAIL" if match["pass"] is False else "ADVISORY")

                    if args.stop_on_fail and match["pass"] is False:
                        out.write(json.dumps(result, ensure_ascii=False) + "\n")
                        break
                except Exception as e:
                    result = {"case": case, "error": repr(e)}
                    fail_count += 1
                    print("  ERROR:", repr(e))
                    if args.stop_on_fail:
                        break

            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            time.sleep(args.delay)

    print(f"\nSaved results to {args.out}")
    print(f"Summary: {pass_count} pass, {fail_count} fail, {advisory_count} advisory")


if __name__ == "__main__":
    main()
