// NOTE: console.log here goes to Cloudflare Workers logs (wrangler tail / dashboard), not the browser DevTools.

/**
 * fetch(..., credentials: "include") requires a concrete Access-Control-Allow-Origin
 * (not *) plus Access-Control-Allow-Credentials: true. Wildcard + cookies is invalid per spec.
 */
function corsAllowedOrigin(origin) {
  if (!origin) return null
  try {
    const u = new URL(origin)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
    const h = u.hostname.toLowerCase()
    if (h === "localhost" || h === "127.0.0.1") return origin
    if (h.endsWith(".github.io") || h === "github.io") return origin
    return null
  } catch {
    return null
  }
}

function stripAccessControlHeaders(headers) {
  const drop = []
  for (const k of headers.keys()) {
    if (k.toLowerCase().startsWith("access-control-")) drop.push(k)
  }
  for (const k of drop) headers.delete(k)
}

function applyCorsHeaders(headers, request) {
  stripAccessControlHeaders(headers)
  const origin = request.headers.get("Origin")
  const allowed = corsAllowedOrigin(origin)
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", allowed)
    headers.set("Access-Control-Allow-Credentials", "true")
  } else {
    headers.set("Access-Control-Allow-Origin", "*")
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
  const ach = request.headers.get("Access-Control-Request-Headers")
  headers.set("Access-Control-Allow-Headers", ach || "*")
  headers.set("Access-Control-Expose-Headers", "*")
  headers.set("Access-Control-Max-Age", "86400")
  headers.set("Cross-Origin-Resource-Policy", "cross-origin")
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const h = new Headers()
      applyCorsHeaders(h, request)
      return new Response(null, { status: 204, headers: h })
    }

    const url = new URL(request.url)

    // Configure via Worker secret / wrangler var VERA_TUNNEL_URL (never commit real URLs).
    const TUNNEL_URL = String(env?.VERA_TUNNEL_URL || "").replace(/\/$/, "")
    if (!TUNNEL_URL) {
      return new Response("VERA_TUNNEL_URL is not configured on this Worker.", { status: 503 })
    }

    const targetUrl = TUNNEL_URL + url.pathname + url.search

    const headers = new Headers(request.headers)
    const proto = url.protocol.replace(":", "")
    headers.set("X-Forwarded-Host", url.host)
    headers.set("X-Forwarded-Proto", proto)
    headers.set("X-Vera-Public-Host", url.host)
    headers.set("X-Vera-Public-Proto", proto)

    // Must not follow redirects: FastAPI returns 307 Location → accounts.spotify.com so the
    // *browser* re-POSTs with Spotify cookies. If we follow here, the Worker replays POST
    // without those cookies → 400/500 and broken OAuth/OTC.
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual"
    })

    const outHeaders = new Headers(response.headers)
    applyCorsHeaders(outHeaders, request)

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders
    })
  }
}