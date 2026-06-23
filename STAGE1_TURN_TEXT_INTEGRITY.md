# Stage 1 — `[TURN_TEXT_INTEGRITY]` log

Single-line diagnostic added 2026-05-27 to verify that, for every voice/typed
turn, the displayed user bubble, the router input, and the backend payload
contain the same text. No control flow was touched — this is pure
instrumentation.

## What fires, and where

Each user turn produces exactly **one** `[TURN_TEXT_INTEGRITY]` log line.
The log is emitted at the latest point where all four text values are known
locally.

| `source`     | `path`                       | Triggered by                                                                              | Emit site (line)            |
| ------------ | ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| `browser_asr`| `main-browser-asr`           | Continuous browser-ASR final transcript → `/infer` (use_browser_asr=1)                    | inside `finalizeMainBrowserTranscript` |
| `browser_asr`| `interrupt-browser-asr`      | Barge-in browser-ASR final transcript → `/infer` (mode=interrupt)                         | interrupt dispatch          |
| `browser_asr`| `ptt-browser-asr`            | Push-to-talk browser-ASR → `/infer` (mode=ptt)                                            | PTT release handler         |
| `typed`      | `typed-text`                 | Non-work-mode keyboard input → `/text`                                                    | `sendTextMessage`           |
| `typed`      | `work-typed` (or caller path)| Work-mode keyboard input → `/infer` (use_browser_asr=1)                                   | `sendVeraWorkModeTypedInferTurn` |
| `whisper`    | `work-mode-server-asr`       | Work-mode voice with `transcribe_only` preflight → second `/infer`                        | `handleUtterance` work-mode branch |
| `whisper`    | `main-ndjson-whisper`        | Pure Whisper /infer (no client transcript) — fires when NDJSON `meta.transcript` arrives  | NDJSON `onMeta` callback    |
| `whisper`    | `interrupt-ndjson-whisper`   | Pure Whisper interrupt /infer (rare)                                                      | NDJSON `onMeta` interrupt   |

The whisper NDJSON sites are **gated** on `inferTranscriptFromFormData(formData) === ""`
so they cannot double-log when the client already pre-supplied the transcript.

## Log payload

```js
{
  tag: "TURN_TEXT_INTEGRITY",
  turn_id: "turn_<base36>_<seq>",          // per-call id, generated on the fly
  source: "browser_asr" | "whisper" | "typed",
  raw_asr_text: string | null,             // SR result before normalization (browser_asr only)
  normalized_text: string | null,          // after trim / cancel-prefix strip / etc.
  displayed_user_bubble_text: string | null, // read from DOM at emit time
  router_input_text: string | null,        // what the client routes / would have routed
  backend_payload_text: string | null,     // what the network body carries
  request_id: string | null,               // when the fetch's request_id is known at emit time
  path: string | null,                     // grep tag, see table above
  intercepted_by: string | null,           // reserved for future shortcut-intercept logs
  timestamp: ISO8601,
  bubble_eq_router: true | false | null,   // pre-computed for quick triage
  router_eq_backend: true | false | null,
  all_three_eq: boolean,                   // true only when both eq checks are true
}
```

## How to read it for the user's 5 manual tests

For all five tests the expected result is **`all_three_eq: true`** (or at least
`bubble_eq_router: true && router_eq_backend: true`). Anything else is the
bug we are hunting.

### 1. "play the lo-fi mix and remove the first item from your checklist"

Likely path: browser-ASR continuous. Watch for:

```
[TURN_TEXT_INTEGRITY] {
  source: "browser_asr",
  path:   "main-browser-asr",
  raw_asr_text:              "play the lo-fi mix and remove the first item from your checklist",
  normalized_text:           "play the lo-fi mix and remove the first item from your checklist",
  displayed_user_bubble_text:"play the lo-fi mix and remove the first item from your checklist",
  router_input_text:         "play the lo-fi mix and remove the first item from your checklist",
  backend_payload_text:      "play the lo-fi mix and remove the first item from your checklist",
  all_three_eq: true
}
```

If `displayed_user_bubble_text` is just `"play the lo-fi mix"` or just
`"remove the first item from your checklist"`, the bubble is being truncated
before the router runs — this rules out the planner/router as the bug
location and points at the bubble-finalize step.

If `displayed_user_bubble_text` matches but `router_input_text` does not, the
router input is being cut down between the bubble and the planner — likely a
client-side shortcut intercepting before the planner sees the full text.

If everything matches and only the executed *action* is partial, the bug is
inside the multi-action planner / shortcut dispatch (which is frozen — do
not modify; just file the case with the captured log).

### 2. "go to panel 2 and explain the Vietnam War"

Same expectations. The planner is supposed to split this into a
panel-switch + reasoning turn. Two `[TURN_TEXT_INTEGRITY]` lines may appear
(one per sub-action). Their `turn_id` values will differ — that's a normal
signal of multi-action dispatch.

### 3. "can you remove the first and third checklist item"

Single shortcut command. Expect ONE log, `all_three_eq: true`, with
`path: "main-browser-asr"`.

### 4. "explain the Vietnam War in panel 2"

Same as test 2 but inverted order. Same expectations.

### 5. "can you hear me"

Tiny non-command. Expect ONE log, `all_three_eq: true`. This is the
"sanity baseline" — if even this turn shows divergence the bug is in the
bubble plumbing, not the router.

## Silencing

```js
localStorage.setItem("VERA_DEBUG_TURN_TEXT", "0");  // off
localStorage.removeItem("VERA_DEBUG_TURN_TEXT");    // on (default)
```

The log fires at most once per user turn, so the noise floor is bounded by
how fast a user can speak/type.

## Calling it manually from DevTools

```js
window.logTurnTextIntegrity({
  source: "browser_asr",
  raw_asr_text: "hello world",
  normalized_text: "hello world",
  router_input_text: "hello world",
  backend_payload_text: "hello world",
  path: "manual-test",
});
// → "[TURN_TEXT_INTEGRITY]" line with all_three_eq=true
```

## What is NOT covered

These very rare paths still have no `[TURN_TEXT_INTEGRITY]` log because they
do not have `formData` in scope at the JSON-commit point:

- Non-NDJSON whisper main JSON path (`processInferMainJsonPayload` reached
  only when `stream_tts=0` AND the server-returned response is JSON).
- Non-NDJSON whisper interrupt JSON path (`commitServerUserTranscriptBubble(data.transcript, "interrupt-json")` at the bottom of `runInferInterruptPipeline`).

If a future bug report comes in for one of those paths, threading `formData`
through `processInferMainJsonPayload`'s opts is a 2-line change.

## Cross-checking against the backend

The client log captures what the client *sent*. The server's existing
`[REQ start ... transcript="..."]` line captures what the server *received*.
Pair them by `request_id` (or the `X-Vera-Request-Id` header on the request)
to confirm the wire didn't drop anything.
