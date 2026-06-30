/**
 * Smoke: usageEvents.js tracking helper (Phase 0+1 + boundary fix).
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

function createDocument(domState) {
  return {
    body: {
      classList: {
        contains(cls) {
          if (cls === "vera-mode") return domState.veraMode;
          if (cls === "bmo-open") return domState.bmoOpen;
          if (cls === "app-open") return domState.appOpen;
          return false;
        },
      },
    },
    visibilityState: "visible",
    getElementById(id) {
      if (id === "vera-app") {
        return {
          hidden: domState.veraHidden,
          classList: {
            contains: (c) => c === "work-mode" && domState.workMode,
          },
        };
      }
      return null;
    },
    addEventListener() {},
  };
}

function makeSandbox({
  authenticated = false,
  hydrating = false,
  veraMode = true,
  bmoOpen = false,
  appOpen = true,
  workMode = false,
  veraHidden = false,
  perfNow = 5000,
} = {}) {
  const fetchBodies = [];
  const domState = {
    veraMode,
    bmoOpen,
    appOpen,
    workMode,
    veraHidden,
  };
  let perf = perfNow;
  const sandbox = {
    window: {},
    document: createDocument(domState),
    domState,
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
    performance: {
      now: () => perf,
      advance(ms) {
        perf += ms;
      },
    },
    getSessionId: () =>
      domState.bmoOpen ? "sess-bmo-usage" : "sess-vera-usage",
    authApiUrl: (p) => `http://127.0.0.1:8000${p}`,
    authFetch: async (_url, init) => {
      fetchBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, id: "ue-1" }) };
    },
    getSupabaseAccessToken: async () => (authenticated ? "jwt-test" : null),
    isSupabaseUserAuthenticated: () => authenticated,
    isVeraWorkModeOn: () => domState.workMode,
    veraIsChatStateHydrating: () => hydrating,
    fetch: async () => ({ ok: true }),
    crypto: {
      randomUUID: () => "11111111-2222-4333-8444-555555555555",
    },
    setInterval(fn, ms) {
      return 1;
    },
    clearInterval() {},
    console,
    _fetchBodies: fetchBodies,
    addEventListener() {},
    refreshDocument() {
      sandbox.document = createDocument(domState);
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = sandbox.addEventListener;
  vm.createContext(sandbox);
  const src = readFileSync(path.join(root, "users/usageEvents.js"), "utf8");
  vm.runInContext(src, sandbox);
  return sandbox;
}

function assertFlushConsistency(flush, label) {
  ok(flush != null, `${label}: flush exists`);
  if (!flush) return;
  ok(flush.event_props?.mode === flush.event_props?.ui_mode, `${label}: mode matches ui_mode`);
  ok(
    flush.event_props?.app_surface === "vera"
      ? flush.event_props?.ui_mode !== "bmo"
      : flush.event_props?.app_surface === "bmo"
        ? flush.event_props?.ui_mode === "bmo"
        : true,
    `${label}: app_surface/ui_mode not mixed`
  );
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
    },
    { requestId: "req_msg_1" }
  );
  ok(sb._fetchBodies.length === 1, "trackUsageEvent invokes authFetch");
  const body = sb._fetchBodies[0];
  ok(body.session_id === "sess-vera-usage", "session_id included");
  ok(body.event_type === "message_sent", "event_type included");
  ok(body.request_id === "req_msg_1", "request_id included");
  ok(body.client_event_id, "client_event_id included");
  ok(body.event_props?.input_chars === 10, "props included");
  ok(body.event_props?.app_surface === "vera", "app_surface envelope");
  ok(body.event_props?.ui_mode === "voice_ui", "ui_mode envelope");

  section("BMO tracking enabled");
  sessionStore.clear();
  const sbBmo = makeSandbox({ veraMode: false, bmoOpen: true, appOpen: true });
  sbBmo.trackUsageEvent("page_hidden", { visibility_state: "hidden" });
  ok(sbBmo._fetchBodies.length >= 1, "page_hidden works in BMO context");
  const bmoHidden = sbBmo._fetchBodies.find((b) => b.event_type === "page_hidden");
  ok(bmoHidden?.event_props?.app_surface === "bmo", "BMO app_surface on page_hidden");

  section("session_start dedupe per surface");
  sessionStore.clear();
  const sb2 = makeSandbox();
  sb2.trackUsageSessionStart();
  sb2.trackUsageSessionStart();
  ok(sb2._fetchBodies.length === 1, "session_start deduped for same surface+session");
  ok(
    !sb2._fetchBodies.some((b) => b.event_type === "mode_duration_flush"),
    "session_start does not trigger mode sync flush"
  );

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
    { feedback_rating: "down", source: "main_chat", note: "secret", playlist_name: "x" },
    { requestId: "req_fb" }
  );
  const fbBody = sb5._fetchBodies[0];
  ok(fbBody.event_type === "feedback_submitted", "feedback_submitted event");
  ok(fbBody.event_props?.feedback_rating === "down", "feedback_rating in props");
  ok(!("note" in (fbBody.event_props || {})), "note not included client-side");
  ok(!("playlist_name" in (fbBody.event_props || {})), "playlist_name stripped client-side");

  section("mode tracker work_mode transition");
  sessionStore.clear();
  const sbMode = makeSandbox({ workMode: false });
  sbMode.veraUsageSyncModeFromDom({ trigger: "ui", source: "boot" });
  const bootEvents = sbMode._fetchBodies.map((b) => b.event_type);
  ok(!bootEvents.includes("work_mode_entered"), "boot does not emit work_mode_entered");

  sbMode.domState.workMode = true;
  sbMode.refreshDocument();
  sbMode.veraUsageSyncModeFromDom({ trigger: "ui", source: "work_mode_enter" });
  ok(
    sbMode._fetchBodies.some((b) => b.event_type === "work_mode_entered"),
    "work_mode_entered emitted"
  );
  ok(
    sbMode._fetchBodies.some((b) => b.event_type === "mode_changed"),
    "mode_changed emitted"
  );

  section("mode_duration_flush on sync exit");
  sessionStore.clear();
  const sbFlush = makeSandbox({ workMode: true });
  sbFlush.performance.advance(2500);
  sbFlush.veraUsageSyncModeFromDom({ trigger: "ui", source: "work_mode_enter" });
  sbFlush.domState.workMode = false;
  sbFlush.refreshDocument();
  sbFlush.performance.advance(1500);
  sbFlush.veraUsageSyncModeFromDom({ trigger: "ui", source: "work_mode_exit" });
  const flush = sbFlush._fetchBodies.find((b) => b.event_type === "mode_duration_flush");
  assertFlushConsistency(flush, "work_mode exit");
  ok(flush?.session_id === "sess-vera-usage", "flush uses pinned Vera session id");
  ok(flush?.event_props?.mode === "work_mode", "flush records previous mode");
  ok(flush?.event_props?.duration_ms >= 1500, "flush duration_ms from visible segment");

  section("Vera voice_ui to BMO boundary");
  sessionStore.clear();
  const sbVeraToBmo = makeSandbox({ workMode: false });
  sbVeraToBmo.performance.advance(5000);
  sbVeraToBmo.domState.veraHidden = true;
  sbVeraToBmo.domState.veraMode = false;
  sbVeraToBmo.refreshDocument();
  sbVeraToBmo.veraUsageLeaveVeraForBmo({ trigger: "ui", source: "vera_to_bmo" });
  sbVeraToBmo.domState.bmoOpen = true;
  sbVeraToBmo.domState.veraMode = false;
  sbVeraToBmo.refreshDocument();
  sbVeraToBmo.trackUsageSessionStart();
  sbVeraToBmo.veraUsageSyncModeFromDom({ trigger: "ui", source: "bmo_enter" });

  const veraFlush = sbVeraToBmo._fetchBodies.find(
    (b) => b.event_type === "mode_duration_flush"
  );
  assertFlushConsistency(veraFlush, "vera_to_bmo flush");
  ok(veraFlush?.session_id === "sess-vera-usage", "vera flush uses Vera session id");
  ok(veraFlush?.event_props?.mode === "voice_ui", "vera flush mode is voice_ui");
  ok(veraFlush?.event_props?.app_surface === "vera", "vera flush app_surface is vera");
  ok(
    !(
      veraFlush?.event_props?.app_surface === "vera" &&
      veraFlush?.event_props?.ui_mode === "bmo"
    ),
    "no mixed vera surface + bmo ui_mode on flush"
  );

  const modeChanged = sbVeraToBmo._fetchBodies.find((b) => b.event_type === "mode_changed");
  ok(modeChanged?.session_id === "sess-bmo-usage", "mode_changed uses BMO session id");
  ok(modeChanged?.event_props?.from_mode === "voice_ui", "mode_changed from voice_ui");
  ok(modeChanged?.event_props?.to_mode === "bmo", "mode_changed to bmo");

  const bmoEntered = sbVeraToBmo._fetchBodies.find(
    (b) => b.event_type === "bmo_mode_entered"
  );
  ok(bmoEntered?.session_id === "sess-bmo-usage", "bmo_mode_entered uses BMO session id");

  section("Work Mode to BMO boundary");
  sessionStore.clear();
  const sbWmToBmo = makeSandbox({ workMode: true });
  sbWmToBmo.performance.advance(4000);
  sbWmToBmo.domState.workMode = false;
  sbWmToBmo.domState.veraHidden = true;
  sbWmToBmo.domState.veraMode = false;
  sbWmToBmo.refreshDocument();
  sbWmToBmo.veraUsageLeaveVeraForBmo({ trigger: "ui", source: "vera_to_bmo" });
  sbWmToBmo.domState.bmoOpen = true;
  sbWmToBmo.refreshDocument();
  sbWmToBmo.trackUsageSessionStart();
  sbWmToBmo.veraUsageSyncModeFromDom({ trigger: "ui", source: "bmo_enter" });

  const wmFlush = sbWmToBmo._fetchBodies.find(
    (b) => b.event_type === "mode_duration_flush"
  );
  assertFlushConsistency(wmFlush, "work_mode to bmo flush");
  ok(wmFlush?.session_id === "sess-vera-usage", "work_mode flush uses Vera session id");
  ok(wmFlush?.event_props?.mode === "work_mode", "work_mode flush mode is work_mode");
  ok(
    !sbWmToBmo._fetchBodies.some(
      (b) =>
        b.session_id === "sess-bmo-usage" &&
        b.event_type === "mode_duration_flush" &&
        b.event_props?.mode === "voice_ui" &&
        (b.event_props?.duration_ms || 0) < 50
    ),
    "no tiny voice_ui flush under BMO session"
  );
  ok(
    sbWmToBmo._fetchBodies.some(
      (b) =>
        b.event_type === "mode_changed" &&
        b.event_props?.from_mode === "work_mode" &&
        b.event_props?.to_mode === "bmo"
    ),
    "mode_changed work_mode to bmo"
  );

  section("summary");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

await main();
