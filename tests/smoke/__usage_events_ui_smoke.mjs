/**
 * Smoke: usageEvents.js tracking helper (MVP slice).
 * Run: node tests/smoke/__usage_events_ui_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL ${msg}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

const sessionStore = new Map();

function makeSandbox({
  authenticated = false,
  hydrating = false,
  veraMode = true,
  bmoOpen = false,
} = {}) {
  const fetchBodies = [];
  const sandbox = {
    window: {},
    document: {
      body: {
        classList: {
          contains(cls) {
            if (cls === "vera-mode") return veraMode;
            if (cls === "bmo-open") return bmoOpen;
            return false;
          },
        },
      },
      visibilityState: "visible",
      addEventListener() {},
    },
    navigator: {
      sendBeacon() {
        return true;
      },
    },
    sessionStorage: {
      getItem(k) {
        return sessionStore.get(k) ?? null;
      },
      setItem(k, v) {
        sessionStore.set(k, String(v));
      },
    },
    performance: { now: () => 5000 },
    getSessionId: () => "sess-ui-usage",
    authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
    authFetch: async (_url, init) => {
      fetchBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, id: "ue-1" }) };
    },
    getSupabaseAccessToken: async () => (authenticated ? "jwt-test" : null),
    isSupabaseUserAuthenticated: () => authenticated,
    isVeraWorkModeOn: () => false,
    veraIsChatStateHydrating: () => hydrating,
    fetch: async () => ({ ok: true }),
    console,
    _fetchBodies: fetchBodies,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = sandbox.addEventListener;
  vm.createContext(sandbox);
  const src = readFileSync(path.join(root, "users/usageEvents.js"), "utf8");
  vm.runInContext(src, sandbox);
  return sandbox;
}

async function main() {
  section("trackUsageEvent payload");
  sessionStore.clear();
  const sb = makeSandbox({ authenticated: true });
  sb.trackUsageEvent(
    "message_sent",
    {
      source: "text",
      input_chars: 10,
      work_mode_on: false,
      authenticated: true,
    },
    { requestId: "req_msg_1" }
  );
  ok(sb._fetchBodies.length === 1, "trackUsageEvent invokes authFetch");
  const body = sb._fetchBodies[0];
  ok(body.session_id === "sess-ui-usage", "session_id included");
  ok(body.event_type === "message_sent", "event_type included");
  ok(body.request_id === "req_msg_1", "request_id included");
  ok(body.event_props?.input_chars === 10, "props included");

  section("session_start dedupe");
  sessionStore.clear();
  const sb2 = makeSandbox();
  sb2.trackUsageSessionStart();
  sb2.trackUsageSessionStart();
  ok(sb2._fetchBodies.length === 1, "session_start deduped for same session_id");

  section("message_sent skipped during hydration");
  sessionStore.clear();
  const sb3 = makeSandbox({ hydrating: true });
  sb3.veraUsageOnMessageSent({ source: "text", requestId: "req_h", inputChars: 5 });
  ok(sb3._fetchBodies.length === 0, "message_sent not sent during chat restore");

  section("assistant_reply_done includes request_id");
  sessionStore.clear();
  const sb4 = makeSandbox();
  sb4.veraUsageOnMessageSent({ source: "text", requestId: "req_done", inputChars: 4 });
  const bubble = { textContent: "Hello world." };
  sb4.veraUsageOnAssistantReplyDone(bubble, { requestId: "req_done", source: "text" });
  ok(sb4._fetchBodies.length === 2, "message_sent + assistant_reply_done sent");
  const doneBody = sb4._fetchBodies[1];
  ok(doneBody.event_type === "assistant_reply_done", "assistant_reply_done event");
  ok(doneBody.request_id === "req_done", "assistant_reply_done request_id");
  ok(doneBody.event_props?.response_chars === 12, "response_chars metadata only");
  sb4.veraUsageOnAssistantReplyDone(bubble, { requestId: "req_done", source: "text" });
  ok(sb4._fetchBodies.length === 2, "assistant_reply_done deduped by session+request");

  section("feedback_submitted via trackUsageEvent");
  sessionStore.clear();
  const sb5 = makeSandbox();
  sb5.trackUsageEvent(
    "feedback_submitted",
    { feedback_rating: "down", source: "main_chat", note: "secret" },
    { requestId: "req_fb" }
  );
  const fbBody = sb5._fetchBodies[0];
  ok(fbBody.event_type === "feedback_submitted", "feedback_submitted event");
  ok(fbBody.event_props?.feedback_rating === "down", "feedback_rating in props");
  ok(!("note" in (fbBody.event_props || {})), "note not included client-side");

  section("summary");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

await main();
