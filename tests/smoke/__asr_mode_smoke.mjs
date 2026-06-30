/**
 * Node smoke test for the JS-side ASR-mode helpers (PARTS 1, 6, 9, 10).
 *
 * After Stage 7 (2026-05-27), these helpers live in voice/asr.js — this
 * harness now loads utils/storage.js (so `safeSetLocalStorage` is
 * defined, fixing the post-Stage-2 ReferenceError) and voice/asr.js
 * directly, instead of carving the helper region out of app.js.
 *
 * Also matches the current default mode (`whisper`) which has been the
 * default since well before Stage 7 — the earlier `streaming` expectation
 * was stale.
 *
 * Run with:  node tests/smoke/__asr_mode_smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const voiceAsrPath = path.join(repoRoot, "voice", "asr.js");

// --- mock browser-ish context ---------------------------------------------
const localStorageBag = {};
const localStorage = {
  getItem: (k) => (k in localStorageBag ? localStorageBag[k] : null),
  setItem: (k, v) => { localStorageBag[k] = String(v); },
  removeItem: (k) => { delete localStorageBag[k]; },
};
const sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const fakeWindow = {
  isSecureContext: true,
  matchMedia: () => ({ matches: false }),
  setTimeout, clearTimeout,
  SpeechRecognition: undefined,
  webkitSpeechRecognition: undefined,
};
const ctx = vm.createContext({
  console: { info() {}, warn() {}, error() {}, log() {} },
  window: fakeWindow,
  localStorage,
  sessionStorage,
  navigator: { userAgent: "Mozilla/5.0", vendor: "Google Inc.", languages: ["en-US"], language: "en-US" },
  location: { protocol: "http:" },
  performance: { now: () => Date.now() },
});
// expose helpers onto the global scope (matches classic-script lexical env)
for (const k of Object.keys(fakeWindow)) ctx[k] = fakeWindow[k];

// --- load the real source files in the same order index.html does --------
// 1) utils/storage.js — provides safeSetLocalStorage (Stage 2 fix)
vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), ctx, { filename: "utils/storage.js" });

// 2) app-side bare bindings the ASR helpers reach at call time
vm.runInContext(
  `
  const logVeraSettings = () => {};
  /* mutable lets that setVeraAsrSilenceMs / setMainAsrPartialMinChars
     write to via the shared classic-script lexical env in production. */
  var browserAsrMainSilenceMs = 1300;
  var mainAsrPartialMinChars = 20;
  var browserAsrPermanentlyDisabled = false;
  `,
  ctx,
  { filename: "tests/smoke/__asr_mode_app_stub__" },
);

// 3) voice/asr.js — the extracted helpers (Stage 7)
vm.runInContext(fs.readFileSync(voiceAsrPath, "utf8"), ctx, { filename: "voice/asr.js" });

// Pin our exports for easy access
vm.runInContext(
  `
  globalThis.__exp = {
    getVeraAsrMode, setVeraAsrMode, _normalizeVeraAsrMode,
    decideAsrFinalizationMode, chooseBestTranscript, normalizeCommandTranscript,
    isHybridAsrMode, isStreamingAsrMode, isWhisperAsrMode,
    getVeraAsrSilenceMs, setVeraAsrSilenceMs,
    getMainAsrPartialMinChars, setMainAsrPartialMinChars,
    getAsrDebugState,
  };
  `,
  ctx,
);
const exp = ctx.__exp;

let pass = 0, fail = 0;
const failed = [];
function check(cond, name, detail = "") {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; failed.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("-- Suite A - Mode getter/setter + backcompat (PART 1) --");
delete localStorageBag.vera_setting_asr_mode_v1;
// Current default is "whisper" (changed long before Stage 7; the old
// "streaming" expectation was stale).
check(exp.getVeraAsrMode() === "whisper", "default mode is 'whisper'");
exp.setVeraAsrMode("hybrid");
check(exp.getVeraAsrMode() === "hybrid", "set+get round-trips 'hybrid'");
exp.setVeraAsrMode("whisper");
check(exp.getVeraAsrMode() === "whisper", "set+get round-trips 'whisper'");
exp.setVeraAsrMode("streaming");
check(exp.getVeraAsrMode() === "streaming", "set+get round-trips 'streaming'");
// Backcompat
localStorageBag.vera_setting_asr_mode_v1 = "single";
check(exp.getVeraAsrMode() === "whisper", "backcompat: 'single' -> 'whisper'");
localStorageBag.vera_setting_asr_mode_v1 = "browser";
check(exp.getVeraAsrMode() === "streaming", "backcompat: 'browser' -> 'streaming'");
localStorageBag.vera_setting_asr_mode_v1 = "garbage";
check(exp.getVeraAsrMode() === "whisper", "unknown value -> default 'whisper'");
check(exp._normalizeVeraAsrMode("HYBRID") === "hybrid", "_normalize is case-insensitive");

console.log("\n-- Suite B - decideAsrFinalizationMode (PART 6) --");
// streaming mode
exp.setVeraAsrMode("streaming");
let d = exp.decideAsrFinalizationMode({ browserTranscript: "sync the plan" });
check(d.mode === "browser_immediate" && d.reason === "streaming_mode", "streaming: routes browser_immediate");
d = exp.decideAsrFinalizationMode({ browserTranscript: "stop" });
check(d.mode === "cancel_only_immediate", "streaming + 'stop' -> cancel_only_immediate");
d = exp.decideAsrFinalizationMode({ browserTranscript: "" });
check(d.mode === "browser_immediate" && d.reason === "empty_browser_transcript", "empty transcript -> browser_immediate");

// whisper mode
exp.setVeraAsrMode("whisper");
d = exp.decideAsrFinalizationMode({ browserTranscript: "anything goes here" });
check(d.mode === "whisper_verify" && d.reason === "whisper_mode", "whisper mode always verifies");

// hybrid mode
exp.setVeraAsrMode("hybrid");
d = exp.decideAsrFinalizationMode({ browserTranscript: "continue" });
check(d.mode === "browser_immediate" && d.reason === "hybrid_low_risk", "hybrid + 'continue' -> browser_immediate (Test 4)");
d = exp.decideAsrFinalizationMode({ browserTranscript: "yes" });
check(d.mode === "browser_immediate", "hybrid + 'yes' -> browser_immediate");
d = exp.decideAsrFinalizationMode({ browserTranscript: "sync the plan" });
check(d.mode === "whisper_verify", "hybrid + 'sync the plan' -> whisper_verify (Test 5)");
d = exp.decideAsrFinalizationMode({ browserTranscript: "open the news panel" });
check(d.mode === "whisper_verify" && d.reason === "risky_vocabulary", "hybrid + 'news panel' vocab -> whisper_verify");
d = exp.decideAsrFinalizationMode({ browserTranscript: "close the first two panels" });
check(d.mode === "whisper_verify", "hybrid + 'first two panels' -> whisper_verify (Test 8)");
d = exp.decideAsrFinalizationMode({ browserTranscript: "remove first, third, and fifth item" });
check(d.mode === "whisper_verify", "hybrid + ordinals -> whisper_verify (Test 7)");
d = exp.decideAsrFinalizationMode({ browserTranscript: "please transcribe this accurately" });
check(d.mode === "whisper_verify" && d.reason === "explicit_accurate_request", "hybrid + 'transcribe accurately' -> whisper_verify");
d = exp.decideAsrFinalizationMode({ browserTranscript: "stop" });
check(d.mode === "cancel_only_immediate", "hybrid + pure 'stop' -> cancel_only_immediate (Test 11)");
d = exp.decideAsrFinalizationMode({ browserTranscript: "stop, sync the plan" });
check(
  d.mode === "whisper_verify" && d.residueText === "sync the plan" && d.cancelPrefixStripped === true,
  "hybrid + 'stop, sync the plan' -> whisper_verify with residue (Test 12)",
  `mode=${d.mode} residue=${JSON.stringify(d.residueText)}`,
);
d = exp.decideAsrFinalizationMode({ browserTranscript: "wait, remove the first item" });
check(
  d.mode === "whisper_verify" && /remove the first item/.test(d.residueText) && d.cancelPrefixStripped === true,
  "hybrid + 'wait, remove the first item' -> whisper_verify with residue",
);
d = exp.decideAsrFinalizationMode({ browserTranscript: "x".repeat(180) });
check(d.mode === "whisper_verify" && d.reason === "long_dictation", "hybrid + long utterance -> whisper_verify (Test 10)");
d = exp.decideAsrFinalizationMode({ browserTranscript: "hello there", isInterruption: true });
check(d.mode === "whisper_verify" && d.reason === "interruption_non_cancel", "hybrid interruption (non-cancel) -> whisper_verify");

console.log("\n-- Suite C - chooseBestTranscript (PART 9) --");
let r = exp.chooseBestTranscript({ browserTranscript: "", whisperTranscript: "" });
check(r.source === "empty_both", "both empty");
r = exp.chooseBestTranscript({ browserTranscript: "hi", whisperTranscript: "" });
check(r.source === "hybrid_browser" && r.reason === "whisper_empty", "whisper empty -> browser");
r = exp.chooseBestTranscript({ browserTranscript: "", whisperTranscript: "hi" });
check(r.source === "hybrid_whisper" && r.reason === "browser_empty", "browser empty -> whisper");
r = exp.chooseBestTranscript({ browserTranscript: "can you sing the plan", whisperTranscript: "can you sync the plan" });
check(r.source === "hybrid_whisper" && r.selected === "can you sync the plan", "sing->sync prefers whisper");
r = exp.chooseBestTranscript({ browserTranscript: "open the new spanel", whisperTranscript: "open the news panel" });
check(r.source === "hybrid_whisper" && r.selected === "open the news panel", "new spanel->news panel prefers whisper");
r = exp.chooseBestTranscript({
  browserTranscript: "schedule a meeting tomorrow at noon",
  whisperTranscript: "thank you thank you thank you",
});
check(r.source === "hybrid_browser" && r.reason === "whisper_looks_hallucinated", "hallucinated whisper -> browser");
r = exp.chooseBestTranscript({
  browserTranscript: "draft an email to Alex about the Q3 marketing plan and shipping date",
  whisperTranscript: "draft an email",
});
check(r.source === "hybrid_browser" && r.reason === "whisper_truncated", "truncated whisper -> browser");
r = exp.chooseBestTranscript({
  browserTranscript: "send the report to Jordan tomorrow",
  whisperTranscript: "send",
  whisperConfidence: 0.1,
});
check(r.source === "hybrid_browser" && r.reason === "whisper_low_conf_and_short", "low conf + short -> browser");
r = exp.chooseBestTranscript({ browserTranscript: "lets go to the park", whisperTranscript: "let's go to the park" });
check(r.source === "hybrid_whisper", "small diff -> whisper default");

console.log("\n-- Suite D - normalizeCommandTranscript (PART 10) --");
function nc(text, expect) {
  const result = exp.normalizeCommandTranscript(text);
  check(
    expect.applied === result.applied && (!expect.contains || (result.normalized || "").toLowerCase().includes(expect.contains.toLowerCase())),
    `normalize ${JSON.stringify(text)} -> applied=${expect.applied} contains=${JSON.stringify(expect.contains || "")}`,
    `got applied=${result.applied} normalized=${JSON.stringify(result.normalized)}`,
  );
}
nc("can you sing the plan", { applied: true, contains: "sync the plan" });
nc("sink the plan now", { applied: true, contains: "sync the plan" });
nc("open the new spanel", { applied: true, contains: "news panel" });
nc("open the recent panel", { applied: true, contains: "reasoning panel" });
nc("close the reason panel", { applied: true, contains: "reasoning panel" });
nc("remove the first item from the check list", { applied: true, contains: "checklist" });
nc("enable work mood", { applied: true, contains: "Work Mode" });
nc("ask open a i to help", { applied: true, contains: "OpenAI" });
nc("close the door please", { applied: false });
nc("we should be singing all night", { applied: false });

console.log("\n-- Summary --");
const total = pass + fail;
console.log(`  Total: ${total}   Pass: ${pass}   Fail: ${fail}`);
if (fail) {
  console.log("\n  Failed cases:");
  for (const n of failed) console.log(`    - ${n}`);
  process.exit(1);
}
process.exit(0);
