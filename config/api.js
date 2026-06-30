/**
 * Vera API base URL — single production default for the frontend.
 * Load before signinUi.js and app.js (see app/index.html).
 */
(function (global) {
  "use strict";

  const PRODUCTION_API_BASE = "https://api.workwithvera.com";

  function readMeta(name) {
    try {
      const el =
        typeof document !== "undefined" &&
        document.querySelector(`meta[name="${name}"]`);
      const v = el && String(el.content || "").trim();
      return v || "";
    } catch (_) {
      return "";
    }
  }

  function isLocalDevOrigin(origin) {
    if (!origin || origin === "null") return false;
    return /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
  }

  /** Meta override → localhost same-origin → production API. */
  function resolveVeraDefaultApiBase() {
    const meta = readMeta("vera-api-base-url");
    if (meta) return meta.replace(/\/$/, "");

    const o = typeof global.location !== "undefined" ? global.location.origin : "";
    if (isLocalDevOrigin(o)) return "";

    return PRODUCTION_API_BASE;
  }

  global.VERA_API_PRODUCTION_BASE = PRODUCTION_API_BASE;
  global.resolveVeraDefaultApiBase = resolveVeraDefaultApiBase;
})(typeof window !== "undefined" ? window : globalThis);
