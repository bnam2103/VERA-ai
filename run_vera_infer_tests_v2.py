#!/usr/bin/env python3
"""
Run expanded VERA /infer tests from JSONL.

Examples:
  py -3 run_vera_infer_tests_v2.py --base-url http://127.0.0.1:8000 --file vera_infer_test_cases_expanded.jsonl
  py -3 run_vera_infer_tests_v2.py --base-url http://127.0.0.1:8000 --file vera_infer_test_cases_expanded.jsonl --category music_volume_variant
  py -3 run_vera_infer_tests_v2.py --dry-run --file vera_infer_test_cases_expanded.jsonl

This runner uses the typed/browser-ASR shape so /infer does not short-circuit on bytes_too_small.
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
import requests


ALIASES = {
    # Allow old/current names to match future names.
    "voice.answer": {"voice.answer", "info.time", "info.weather", "info.finance", "info.search", "info.news", "info.sports", "info.product", "info.location"},
    "weather_or_voice.answer": {"voice.answer", "info.weather"},
}


def build_payload(case: Dict[str, Any], session_id: str) -> Dict[str, str]:
    text = case["text"]
    return {
        "transcript": text,
        "browser_transcript": text,
        "raw_text": text,
        "text": text,
        "session_id": session_id,
        "client": "vera",
        "input_source": "keyboard",
        "typed": "1",
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
    final: Dict[str, Any] = {}
    for ev in events:
        if ev.get("type") in ("done", "meta"):
            final.update(ev)
        elif "action_type" in ev or "planner_actions" in ev:
            final.update(ev)

    payloads = final.get("action_payloads") or []
    if not payloads and final.get("action_payload"):
        payloads = [final["action_payload"]]

    reasoning_prompts = []
    for p in payloads:
        if isinstance(p, dict) and p.get("panel_type") == "work_mode_reasoning":
            for key in ("prompt", "text", "reasoning_prompt"):
                if p.get(key):
                    reasoning_prompts.append(p.get(key))

    return {
        "reply": final.get("reply"),
        "action_type": final.get("action_type"),
        "planner_actions": final.get("planner_actions") or [],
        "payload_ops": [p.get("op") for p in payloads if isinstance(p, dict)],
        "payload_types": [p.get("panel_type") for p in payloads if isinstance(p, dict)],
        "reasoning_prompts": reasoning_prompts,
        "work_mode_timer": bool(final.get("work_mode_timer")),
        "raw_final": final,
    }


def action_matches(expected: str, actual: str) -> bool:
    if expected == actual:
        return True
    if expected in ALIASES:
        return actual in ALIASES[expected]
    if expected.startswith("info.") and actual == "voice.answer":
        return True
    return False


def expected_match(case: Dict[str, Any], summary: Dict[str, Any]) -> Dict[str, Any]:
    expected = case.get("expected_actions")
    actual = summary.get("planner_actions") or []

    prompt_ok: Optional[bool] = None
    expected_prompt = case.get("expected_clean_reasoning_prompt")
    if expected_prompt:
        prompts = summary.get("reasoning_prompts") or []
        if prompts:
            prompt_ok = any(expected_prompt.lower() in str(p).lower() for p in prompts)
        else:
            # Cannot verify if backend only returns a trigger payload without prompt.
            prompt_ok = None

    if expected:
        matched = []
        used = [False] * len(actual)
        for exp in expected:
            found = False
            for idx, act in enumerate(actual):
                if not used[idx] and action_matches(exp, act):
                    used[idx] = True
                    found = True
                    matched.append((exp, act))
                    break
            if not found:
                return {
                    "pass": False,
                    "expected": expected,
                    "actual": actual,
                    "matched": matched,
                    "prompt_ok": prompt_ok,
                    "known_gap": case.get("known_gap"),
                }
        return {
            "pass": True if prompt_ok is not False else False,
            "expected": expected,
            "actual": actual,
            "matched": matched,
            "prompt_ok": prompt_ok,
            "known_gap": case.get("known_gap"),
        }

    if "expected_route" in case:
        return {"pass": None, "expected_route": case["expected_route"], "action_type": summary.get("action_type")}
    return {"pass": None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--file", default="vera_infer_test_cases_expanded.jsonl")
    ap.add_argument("--session-id", default=f"test_{int(time.time())}")
    ap.add_argument("--delay", type=float, default=0.25)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="vera_infer_test_results_expanded.jsonl")
    ap.add_argument("--category", action="append", help="Run only selected category. Can repeat.")
    ap.add_argument("--id", action="append", help="Run only selected test id. Can repeat.")
    ap.add_argument("--stop-on-fail", action="store_true")
    args = ap.parse_args()

    cases = [json.loads(line) for line in Path(args.file).read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.category:
        cats = set(args.category)
        cases = [c for c in cases if c.get("category") in cats]
    if args.id:
        ids = set(args.id)
        cases = [c for c in cases if c.get("id") in ids]

    out_path = Path(args.out)
    pass_count = fail_count = advisory_count = 0

    with out_path.open("w", encoding="utf-8") as out:
        for case in cases:
            payload = build_payload(case, args.session_id)
            print(f"[{case['id']}] {case['text']}")

            if args.dry_run:
                result = {"case": case, "payload": payload, "dry_run": True}
                print("  DRY RUN payload prepared")
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
                    else:
                        advisory_count += 1

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
                    if match.get("known_gap"):
                        print("  known_gap:", match.get("known_gap"))
                    if match.get("pass") is not None:
                        print("  match:", "PASS" if match.get("pass") else "FAIL")
                    else:
                        print("  match: ADVISORY")

                    if args.stop_on_fail and match.get("pass") is False:
                        out.write(json.dumps(result, ensure_ascii=False) + "\n")
                        print("Stopping on first failure.")
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

    print(f"\nSaved results to {out_path}")
    print(f"Summary: {pass_count} pass, {fail_count} fail, {advisory_count} advisory")


if __name__ == "__main__":
    main()
