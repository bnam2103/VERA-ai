/* =========================================================================
 *  utils/ids.js — pure session-id + request-id helpers.
 *
 *  Extracted from app.js during the stabilization-stage modularization pass
 *  (2026-05-27). All identifiers below were previously top-level in
 *  app.js; nothing here changes runtime semantics. The classic-script
 *  global lexical environment is shared with app.js so bare-name
 *  references (`getSessionId()`, `VERA_SESSION_STORAGE_KEY`, …) keep
 *  resolving exactly the way they did before.
 *
 *  Load order — MUST come BEFORE app.js:
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *
 *  Contents:
 *    - Session storage keys           (VERA_SESSION_STORAGE_KEY, BMO_…)
 *    - getSessionScopedId / setSessionScopedId / getSessionId
 *    - resetVeraAndBmoSessionIdsForTab + ?session=new URL handler
 *    - Per-tab session verification log    (PART 2)
 *    - Per-request id generator + slot tracker  (PART 10)
 *        VERA_LAST_REQUEST_IDS, newVeraRequestId, recordVeraRequestId
 *
 *  NOT moved (intentionally — too tightly coupled to app.js):
 *    - window.veraConcurrencyDebug  (reads Work Mode / ASR runtime state)
 *    - resetBmoSessionAndUi / resetVeraSessionAndUi  (DOM-mutating)
 *    - isVeraDevMode                (groups with other UI dev gates)
 * ========================================================================= */

/* =========================
   SESSION — VERA vs BMO (separate conversation memory on the server)
========================= */

const VERA_SESSION_STORAGE_KEY = "vera_session_id";
const BMO_SESSION_STORAGE_KEY = "bmo_session_id";

/**
 * Session ids are tab-scoped: switching pages keeps them, closing the tab clears them.
 * Migrate legacy ids from localStorage once for backward compatibility.
 */
function getSessionScopedId(key) {
  let id = "";
  try {
    id = sessionStorage.getItem(key) || "";
  } catch (_) {}
  if (id) return id;
  try {
    const legacy = localStorage.getItem(key) || "";
    if (legacy) {
      sessionStorage.setItem(key, legacy);
      localStorage.removeItem(key);
      return legacy;
    }
  } catch (_) {}
  return "";
}

function setSessionScopedId(key, id) {
  try {
    sessionStorage.setItem(key, id);
  } catch (_) {}
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}

function getSessionId() {
  const bmo = document.body.classList.contains("bmo-open");
  const key = bmo ? BMO_SESSION_STORAGE_KEY : VERA_SESSION_STORAGE_KEY;
  let id = getSessionScopedId(key);
  if (!id) {
    id = crypto.randomUUID();
    setSessionScopedId(key, id);
  }
  return id;
}

/* =========================
   MULTI-DEVICE CONCURRENCY — PART 2 + PART 10 + PART 11
   - PART 2: Verify session_id generation. Each browser/tab gets a unique
     UUID stored in sessionStorage; we ALSO accept ?session=new on the URL
     for explicit testing of two distinct sessions from the same browser.
   - PART 10: Per-tab request_id generator so /infer, /text, and reasoning
     stream calls each carry their own id (visible in backend [REQ start]
     logs paired with the session_id).
   - PART 11: window.veraConcurrencyDebug() prints a one-shot snapshot of
     this tab's session_id, last request_id, and active reasoning/audio
     state so a tester can quickly confirm two devices are isolated.
     (Defined in app.js — it reads Work Mode runtime state.)
========================= */

const _VERA_SESSION_STORAGE_KEYS_ALL = [VERA_SESSION_STORAGE_KEY, BMO_SESSION_STORAGE_KEY];

/** Force a brand-new session id for ALL clients (VERA + BMO) in THIS tab. */
function resetVeraAndBmoSessionIdsForTab() {
  for (const key of _VERA_SESSION_STORAGE_KEYS_ALL) {
    try {
      const fresh = crypto.randomUUID();
      sessionStorage.setItem(key, fresh);
      localStorage.removeItem(key);
    } catch (_) {}
  }
}

/* Handle ?session=new in the URL: useful for opening two browser windows
   on the same device and intentionally giving each one a separate session.
   Without this, sessionStorage is per-window-target so duplicate windows
   already get separate sessions; ?session=new is the explicit escape hatch. */
try {
  const _qp = new URLSearchParams(window.location.search || "");
  if ((_qp.get("session") || "").toLowerCase() === "new") {
    resetVeraAndBmoSessionIdsForTab();
    _qp.delete("session");
    const cleanQs = _qp.toString();
    const cleanUrl =
      window.location.pathname + (cleanQs ? "?" + cleanQs : "") + window.location.hash;
    try { history.replaceState(null, "", cleanUrl); } catch (_) {}
    try { console.warn("[VERA][SESSION] ?session=new applied → fresh session_id for this tab"); } catch (_) {}
  }
} catch (_) {}

/* PART 2 verification log. Visible in DevTools on every tab so a two-device
   tester can confirm at a glance that the sessions differ. */
try {
  const _veraSid = getSessionScopedId(VERA_SESSION_STORAGE_KEY) || getSessionId();
  console.log("[VERA][SESSION]", { vera_session_id: _veraSid });
} catch (_) {}

/* PART 10: per-request id. We send this with EVERY backend call so the
   server [REQ start] / [REQ end] logs pair up unambiguously even if the
   same session has multiple in-flight requests (typed input vs voice vs
   reasoning panel). The server also generates its own request_id; ours is
   informational for debugging. */
const VERA_LAST_REQUEST_IDS = {
  infer: null,
  text: null,
  reasoning_stream: null,
  reasoning_stream_upload: null,
  reasoning_panel_title: null,
  tts_emotion_route: null,
  other: null,
};
function newVeraRequestId() {
  /* req_<10 base36 chars> — short, grep-friendly, low collision in practice
     since per-tab it's bounded to a few hundred requests. */
  let r = "";
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buf = new Uint32Array(2);
      crypto.getRandomValues(buf);
      r = (buf[0].toString(36) + buf[1].toString(36)).slice(0, 10);
    }
  } catch (_) {}
  if (!r) {
    r = Math.random().toString(36).slice(2, 12);
  }
  return "req_" + r;
}
function recordVeraRequestId(slot, requestId) {
  if (!slot || !requestId) return requestId;
  try {
    VERA_LAST_REQUEST_IDS[slot] = requestId;
  } catch (_) {}
  return requestId;
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Some `typeof window.X === "function"` callers (in `local_vera/app.js`,
 *  potential future SDK consumers, DevTools snippets) expect these names
 *  to be reachable through `window`. The bare-identifier references in
 *  app.js already resolve through the shared global lexical environment;
 *  these aliases are purely additive insurance.
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.VERA_SESSION_STORAGE_KEY = VERA_SESSION_STORAGE_KEY;
    window.BMO_SESSION_STORAGE_KEY = BMO_SESSION_STORAGE_KEY;
    window.getSessionScopedId = getSessionScopedId;
    window.setSessionScopedId = setSessionScopedId;
    window.getSessionId = getSessionId;
    window.resetVeraAndBmoSessionIdsForTab = resetVeraAndBmoSessionIdsForTab;
    window.VERA_LAST_REQUEST_IDS = VERA_LAST_REQUEST_IDS;
    window.newVeraRequestId = newVeraRequestId;
    window.recordVeraRequestId = recordVeraRequestId;
  }
} catch (_) {}
