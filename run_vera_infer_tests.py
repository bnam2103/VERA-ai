#!/usr/bin/env python3
"""
Run VERA /infer test cases from a JSONL file.

Usage:
  python run_vera_infer_tests.py --base-url http://127.0.0.1:8000 --file vera_infer_test_cases.jsonl
  python run_vera_infer_tests.py --base-url http://127.0.0.1:8000 --file vera_infer_test_cases.jsonl --dry-run
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, List

import requests


def build_payload(case, session_id):
    text = case["text"]
    return {
        "transcript": text,
        "browser_transcript": text,
        "text": text,
        "session_id": session_id,
        "client": "vera",
        "input_source": "keyboard",
        "typed": "1",

        # important: force /infer to treat this as an already-transcribed text turn
        "use_browser_asr": "1",
        "skip_asr": "1",
        "transcript_source": "browser",
    }


def parse_ndjson_or_json(resp_text: str) -> List[Dict[str, Any]]:
    events = []
    stripped = resp_text.strip()
    if not stripped:
        return events
    try:
        obj = json.loads(stripped)
        return [obj] if isinstance(obj, dict) else obj
    except Exception:
        pass

    decoder = json.JSONDecoder()
    i = 0
    n = len(resp_text)
    while i < n:
        while i < n and resp_text[i].isspace():
            i += 1
        if i >= n:
            break
        try:
            obj, j = decoder.raw_decode(resp_text, i)
            if isinstance(obj, dict):
                events.append(obj)
            i = j
        except json.JSONDecodeError:
            line_end = resp_text.find("\n", i)
            if line_end == -1:
                break
            line = resp_text[i:line_end].strip()
            if line:
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict):
                        events.append(obj)
                except Exception:
                    pass
            i = line_end + 1
    return events


def summarize_events(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    final = {}
    for ev in events:
        if ev.get("type") in ("done", "meta"):
            final.update(ev)
        elif "action_type" in ev or "planner_actions" in ev:
            final.update(ev)

    payloads = final.get("action_payloads") or []
    if not payloads and final.get("action_payload"):
        payloads = [final["action_payload"]]

    return {
        "reply": final.get("reply"),
        "action_type": final.get("action_type"),
        "planner_actions": final.get("planner_actions"),
        "payload_ops": [p.get("op") for p in payloads if isinstance(p, dict)],
        "payload_types": [p.get("panel_type") for p in payloads if isinstance(p, dict)],
        "work_mode_timer": bool(final.get("work_mode_timer")),
        "raw_final": final,
    }


def expected_match(case: Dict[str, Any], summary: Dict[str, Any]) -> Dict[str, Any]:
    expected = case.get("expected_actions")
    actual = summary.get("planner_actions") or []
    if expected:
        # loose: exact list if present, otherwise require each expected family somewhere
        exact = actual == expected
        contains = all(x in actual for x in expected)
        return {"pass": bool(exact or contains), "expected": expected, "actual": actual}
    if "expected_route" in case:
        # route is usually visible through action_type/reasoning flags, so this is advisory
        return {"pass": None, "expected_route": case["expected_route"], "action_type": summary.get("action_type")}
    return {"pass": None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--file", default="vera_infer_test_cases.jsonl")
    ap.add_argument("--session-id", default=f"test_{int(time.time())}")
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="vera_infer_test_results.jsonl")
    args = ap.parse_args()

    cases = [json.loads(line) for line in Path(args.file).read_text(encoding="utf-8").splitlines() if line.strip()]
    out_path = Path(args.out)

    pass_count = 0
    fail_count = 0

    with out_path.open("w", encoding="utf-8") as out:
        for case in cases:
            payload = build_payload(case, args.session_id)
            print(f"[{case['id']}] {case['text']}")

            if args.dry_run:
                result = {"case": case, "payload": payload, "dry_run": True}
            else:
                try:
                    r = requests.post(f"{args.base_url.rstrip('/')}/infer", data=payload, timeout=120)
                    events = parse_ndjson_or_json(r.text)
                    summary = summarize_events(events)
                    match = expected_match(case, summary)
                    if match.get("pass") is True:
                        pass_count += 1
                    elif match.get("pass") is False:
                        fail_count += 1
                    result = {
                        "case": case,
                        "status_code": r.status_code,
                        "summary": summary,
                        "match": match,
                        "events": events,
                    }
                    print("  action_type:", summary.get("action_type"))
                    print("  planner_actions:", summary.get("planner_actions"))
                    print("  payload_ops:", summary.get("payload_ops"))
                    print("  reply:", summary.get("reply"))
                    if match.get("pass") is not None:
                        print("  match:", "PASS" if match.get("pass") else "FAIL")
                except Exception as e:
                    result = {"case": case, "error": repr(e)}
                    fail_count += 1
                    print("  ERROR:", repr(e))

            out.write(json.dumps(result, ensure_ascii=False) + "\n")
            out.flush()
            time.sleep(args.delay)

    print(f"\nSaved results to {out_path}")
    print(f"Checked action-list expectations: {pass_count} pass, {fail_count} fail")


if __name__ == "__main__":
    main()
