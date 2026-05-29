/* =========================================================================
 *  utils/storage.js — safe localStorage / sessionStorage wrappers.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 2). All wrappers below preserve the existing
 *  silent-fail behavior used everywhere in app.js: any failure inside
 *  the Storage API (security exceptions, quota errors, private-mode
 *  rejections, JSON parse / stringify exceptions) returns the supplied
 *  fallback / default instead of throwing.
 *
 *  Load order — MUST come BEFORE app.js (after utils/ids.js):
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *
 *  Helpers (kept minimal — no convenience features beyond the spec):
 *    - safeGetLocalStorage(key, defaultValue=null)
 *    - safeSetLocalStorage(key, value)            -> boolean (true=stored)
 *    - safeRemoveLocalStorage(key)                -> boolean
 *    - safeGetSessionStorage(key, defaultValue=null)
 *    - safeSetSessionStorage(key, value)          -> boolean
 *    - safeRemoveSessionStorage(key)              -> boolean
 *    - safeJsonParse(raw, fallback=null)
 *    - safeJsonStringify(value, fallback=null)
 *    - safeGetJsonLocalStorage(key, fallback=null)
 *    - safeSetJsonLocalStorage(key, value)        -> boolean
 *    - safeGetJsonSessionStorage(key, fallback=null)
 *    - safeSetJsonSessionStorage(key, value)      -> boolean
 *
 *  Behavior contract — read carefully before swapping a call site:
 *    1. `safeGetLocalStorage(key)` returns either the stored string or
 *       `defaultValue`. A missing key returns `defaultValue` (NOT "").
 *       This mirrors the previous pattern
 *           `try { return localStorage.getItem(k); } catch { return null; }`
 *       Callers that previously used `... || ""` for fallback should
 *       pass `""` explicitly as the second arg, OR keep the `|| ""`
 *       after the call.
 *    2. `safeSetLocalStorage`/`safeRemoveLocalStorage` return `true`
 *       when the underlying call succeeded, `false` on error or when
 *       the Storage API is unavailable. Most callers ignore the return
 *       value (matches the previous `try {...} catch (_) {}` shape).
 *    3. `safeJsonParse` treats `null`, `undefined`, and the empty
 *       string as "no data" and returns `fallback` without invoking
 *       `JSON.parse` — matches the previous
 *           `if (!raw) return fallback; try { JSON.parse(raw); } catch ...`
 *       pattern used in the chat-state / reasoning-tabs persisters.
 *
 *  Intentional non-features:
 *    - No write-through caching, no batching, no schema validation.
 *      Stage 2 is purely about centralizing the try/catch boilerplate.
 *    - No `typeof window === "undefined"` cleverness beyond what the
 *      existing call sites already do. Callers that need that guard
 *      should keep it; the wrappers themselves handle storage
 *      unavailability via try/catch.
 * ========================================================================= */

function safeGetLocalStorage(key, defaultValue = null) {
  try {
    if (typeof localStorage === "undefined") return defaultValue;
    const v = localStorage.getItem(key);
    return v == null ? defaultValue : v;
  } catch (_) {
    return defaultValue;
  }
}

function safeSetLocalStorage(key, value) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function safeRemoveLocalStorage(key) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

function safeGetSessionStorage(key, defaultValue = null) {
  try {
    if (typeof sessionStorage === "undefined") return defaultValue;
    const v = sessionStorage.getItem(key);
    return v == null ? defaultValue : v;
  } catch (_) {
    return defaultValue;
  }
}

function safeSetSessionStorage(key, value) {
  try {
    if (typeof sessionStorage === "undefined") return false;
    sessionStorage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function safeRemoveSessionStorage(key) {
  try {
    if (typeof sessionStorage === "undefined") return false;
    sessionStorage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

function safeJsonParse(raw, fallback = null) {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeJsonStringify(value, fallback = null) {
  try {
    const s = JSON.stringify(value);
    return s == null ? fallback : s;
  } catch (_) {
    return fallback;
  }
}

function safeGetJsonLocalStorage(key, fallback = null) {
  return safeJsonParse(safeGetLocalStorage(key), fallback);
}

function safeSetJsonLocalStorage(key, value) {
  const s = safeJsonStringify(value);
  if (s == null) return false;
  return safeSetLocalStorage(key, s);
}

function safeGetJsonSessionStorage(key, fallback = null) {
  return safeJsonParse(safeGetSessionStorage(key), fallback);
}

function safeSetJsonSessionStorage(key, value) {
  const s = safeJsonStringify(value);
  if (s == null) return false;
  return safeSetSessionStorage(key, s);
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Mirror of the pattern used by utils/ids.js: the shared classic-script
 *  global lexical environment already exposes these names to app.js via
 *  bare-identifier references, but a `window.*` alias keeps every helper
 *  reachable from DevTools and from any `typeof window.X === "function"`
 *  callers.
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.safeGetLocalStorage = safeGetLocalStorage;
    window.safeSetLocalStorage = safeSetLocalStorage;
    window.safeRemoveLocalStorage = safeRemoveLocalStorage;
    window.safeGetSessionStorage = safeGetSessionStorage;
    window.safeSetSessionStorage = safeSetSessionStorage;
    window.safeRemoveSessionStorage = safeRemoveSessionStorage;
    window.safeJsonParse = safeJsonParse;
    window.safeJsonStringify = safeJsonStringify;
    window.safeGetJsonLocalStorage = safeGetJsonLocalStorage;
    window.safeSetJsonLocalStorage = safeSetJsonLocalStorage;
    window.safeGetJsonSessionStorage = safeGetJsonSessionStorage;
    window.safeSetJsonSessionStorage = safeSetJsonSessionStorage;
  }
} catch (_) {}
