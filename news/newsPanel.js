/* =========================================================================
 *  news/newsPanel.js — frontend news / media-tabs side-panel render layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 10). Behavior is preserved EXACTLY:
 *    - same DOM markup for the media-tabs panel
 *      (`side-pane-header`, `side-pane-tabs`, `side-pane-tab-panel`,
 *      `news-result-list`, `news-result-card`, `news-result-title`,
 *      `news-result-snippet`, `news-result-meta`, `news-result-link`,
 *      `media-grid`, `media-card`, `image-card`, `media-image`,
 *      `video-result-list`, `video-card`, `video-embed-wrap`,
 *      `video-embed`),
 *    - same default tab fallback ("news"),
 *    - same body class toggle (`news-panel-open` added by the media-tabs
 *      panel — the global remove path stays in app.js's hideSidePanel),
 *    - same YouTube embed normalization (`youtu.be/<id>` →
 *      `youtube.com/embed/<id>`, `youtube.com?v=<id>` →
 *      `youtube.com/embed/<id>`),
 *    - same render-timing telemetry hooks
 *      (`_veraNewsPanelRenderInFlight`, `news_panel_render_start`,
 *      `news_panel_render_end`) — the flag is also read by the
 *      interruption RAF tracker in app.js / voice/interruption.js
 *      (`duringNewsRender`) and remains visible there at CALL time
 *      through the shared classic-script global lexical env,
 *    - same side-pane tab click handler contract
 *      (`setActiveSidePaneTab(tabName)` toggles `.side-pane-tab.active`
 *      and `.side-pane-tab-panel.active`),
 *    - same cross-fade integration: when the side pane is already
 *      visible, content swap goes through `runFlowModeSidePaneContentCrossfade`
 *      (still in app.js — touches Flow Mode + Work Mode predicates).
 *  No backend news routing changes. No personal-news suppression
 *  changes. No current-fact routing changes. No time / weather /
 *  finance routing changes. No Work Mode routing changes.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come BEFORE app.js so the moved
 *  declarations are visible to app.js callers through the shared
 *  classic-script global lexical env when app.js parses + runs:
 *    - `renderMediaTabsPanel` is called from the side-panel dispatch in
 *      app.js (`panel_type === "media_tabs"` / `"news_results"` /
 *      `"news_panel_ui"`),
 *    - `setActiveSidePaneTab` is called from app.js's `onSidePaneClick`,
 *    - `_veraNewsPanelRenderInFlight` is read inside the interruption
 *      RAF tracker in app.js (and voice/interruption.js).
 *
 *  Order relative to news/newsRouter.js does not matter (neither
 *  module calls into the other).
 *
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/asr.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="voice/interruption.js?v=1"></script>
 *      <script src="workmode/panels.js?v=1"></script>
 *      <script src="workmode/checklist.js?v=1"></script>
 *      <script src="news/newsRouter.js?v=1"></script>
 *      <script src="news/newsPanel.js?v=1"></script>      <-- NEW
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Bare-identifier references resolved at CALL time through the shared
 *  global lexical env (NOT at module load):
 *    uiEl                                  (app.js)
 *    escapeHtml                            (app.js)
 *    runFlowModeSidePaneContentCrossfade   (app.js — Flow Mode +
 *                                           Work Mode aware)
 *    isVeraInterruptDebugEnabled           (voice/interruption.js)
 *    logVeraInterruptDebug                 (voice/interruption.js)
 *    performance                           (global)
 *
 *  Helpers intentionally LEFT in app.js (and why):
 *    hideSidePanel                         touches productivity
 *                                          (music) + Work Mode pin
 *                                          predicates; not news-only.
 *    renderFinanceChartPanel               finance side-panel, not
 *                                          news-owned. (Stage 10 only
 *                                          moves news/media tabs.)
 *    renderProductivityPanel /
 *      toggleProductivityPanel /
 *      restoreProductivityPanel /
 *      wireProductivityPanelEvents         music side-panel, not
 *                                          news-owned.
 *    runFlowModeSidePaneContentCrossfade   used by both news/media,
 *                                          finance, and productivity
 *                                          panels; lives in app.js.
 *    onSidePaneClick                       routes generic close-button
 *                                          clicks AND tab clicks; only
 *                                          the tab branch reaches
 *                                          setActiveSidePaneTab.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers in the global lexical env)
 *  ─────────────────────────────────────────────────────────────────────
 *    render-time flag           _veraNewsPanelRenderInFlight
 *    list/grid renderers        renderNewsResultListMarkup(results),
 *                               renderImageResultsMarkup(images),
 *                               renderVideoResultsMarkup(videos)
 *    embed normalizer           getVideoEmbedUrl(url)
 *    tab state mutator          setActiveSidePaneTab(tabName)
 *    panel renderer             renderMediaTabsPanel(payload)
 *    window aliases (new)       window.getNewsPanelDebugState()
 *                                   read-only snapshot of panel render
 *                                   state, last render telemetry, and
 *                                   DOM presence.
 * ========================================================================= */

/** News-panel render timing — flag spans where the main thread is busy
 *  rendering the news side panel right after onPlayStart. Read by the
 *  interruption RAF tracker (app.js + voice/interruption.js) to flag
 *  any RAF stalls that overlap a news-panel render. */
let _veraNewsPanelRenderInFlight = false;

/* =========================
   LIST / GRID MARKUP RENDERERS
========================= */

function renderNewsResultListMarkup(results) {
  if (!results.length) {
    return `<div class="side-pane-empty">No articles available for this search.</div>`;
  }

  return `
    <div class="news-result-list">
      ${results.map((item, index) => `
        <article class="news-result-card">
          <h4 class="news-result-title">${index + 1}. ${escapeHtml(item.title)}</h4>
          <p class="news-result-snippet">${escapeHtml(item.summary)}</p>
          <div class="news-result-meta">
            <span>${escapeHtml(item.source || "Unknown source")}</span>
            <span>${escapeHtml(item.published_display || "")}</span>
          </div>
          ${item.url ? `<a class="news-result-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderImageResultsMarkup(images) {
  if (!images.length) {
    return `<div class="side-pane-empty">No images available for this search.</div>`;
  }

  return `
    <div class="media-grid">
      ${images.map((item) => `
        <article class="media-card image-card">
          <a
            class="media-link"
            href="${escapeHtml(item.url || item.image_url)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              class="media-image"
              src="${escapeHtml(item.image_url || item.thumbnail_url || "")}"
              alt="${escapeHtml(item.title || "Search result image")}"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
          </a>
          <div class="media-card-body">
            <div class="media-card-title">${escapeHtml(item.title || "Image result")}</div>
            <div class="media-card-meta">${escapeHtml(item.source || "Unknown source")}</div>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function getVideoEmbedUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const videoId = parsed.pathname.replaceAll("/", "");
      return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      const videoId = parsed.searchParams.get("v");
      return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
    }
  } catch {
    return "";
  }

  return "";
}

function renderVideoResultsMarkup(videos) {
  if (!videos.length) {
    return `<div class="side-pane-empty">No videos available for this search.</div>`;
  }

  return `
    <div class="video-result-list">
      ${videos.map((item) => {
        const embedUrl = getVideoEmbedUrl(item.url);
        return `
          <article class="media-card video-card">
            ${embedUrl ? `
              <div class="video-embed-wrap">
                <iframe
                  class="video-embed"
                  src="${escapeHtml(embedUrl)}"
                  title="${escapeHtml(item.title)}"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen
                  loading="lazy"
                  referrerpolicy="strict-origin-when-cross-origin"
                ></iframe>
              </div>
            ` : item.thumbnail_url ? `
              <a
                class="media-link"
                href="${escapeHtml(item.url)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  class="media-image"
                  src="${escapeHtml(item.thumbnail_url)}"
                  alt="${escapeHtml(item.title)}"
                  loading="lazy"
                  referrerpolicy="no-referrer"
                />
              </a>
            ` : ""}
            <div class="media-card-body">
              <div class="media-card-title">${escapeHtml(item.title)}</div>
              <div class="media-card-meta">
                <span>${escapeHtml(item.source || "Unknown source")}</span>
                <span>${escapeHtml(item.published_display || "")}</span>
              </div>
              ${item.summary ? `<p class="news-result-snippet">${escapeHtml(item.summary)}</p>` : ""}
              <a class="news-result-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open video</a>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

/* =========================
   TAB STATE + MEDIA-TABS PANEL RENDER
========================= */

function setActiveSidePaneTab(tabName) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  sidePaneEl.querySelectorAll(".side-pane-tab").forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  sidePaneEl.querySelectorAll(".side-pane-tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === tabName);
  });
}

function renderMediaTabsPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  /* DEBUG: time the panel render so we can correlate main-thread stalls
     with interrupt_raf_gap logs. Hot path on news responses. */
  const _veraDbgRenderStart = isVeraInterruptDebugEnabled() ? performance.now() : 0;
  if (isVeraInterruptDebugEnabled()) {
    _veraNewsPanelRenderInFlight = true;
    logVeraInterruptDebug({
      tag: "news_panel_render_start",
      now: Number(_veraDbgRenderStart.toFixed(1)),
      panelType: payload?.panel_type || null,
      hasNewsResults: Array.isArray(payload?.news_results) ? payload.news_results.length : 0,
      hasImages: Array.isArray(payload?.images) ? payload.images.length : 0,
      hasVideos: Array.isArray(payload?.videos) ? payload.videos.length : 0,
    });
  }

  const mount = () => {
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));

    const results = Array.isArray(payload?.news_results)
      ? payload.news_results
      : Array.isArray(payload?.results)
        ? payload.results
        : [];
    const images = Array.isArray(payload?.images) ? payload.images : [];
    const videos = Array.isArray(payload?.videos) ? payload.videos : [];
    const defaultTab = payload?.default_tab || "news";

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "News Results")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.query || "Top headlines")}</div>
      </div>
      <div class="side-pane-controls">
        <div class="side-pane-tabs" role="tablist" aria-label="Search result tabs">
          <button class="side-pane-tab ${defaultTab === "news" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "news" ? "true" : "false"}" data-tab="news">News</button>
          <button class="side-pane-tab ${defaultTab === "images" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "images" ? "true" : "false"}" data-tab="images">Images</button>
          <button class="side-pane-tab ${defaultTab === "video" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "video" ? "true" : "false"}" data-tab="video">Video</button>
        </div>
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "news" ? "active" : ""}" data-tab-panel="news">
      ${renderNewsResultListMarkup(results)}
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "images" ? "active" : ""}" data-tab-panel="images">
      ${renderImageResultsMarkup(images)}
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "video" ? "active" : ""}" data-tab-panel="video">
      ${renderVideoResultsMarkup(videos)}
    </div>
  `;

    sidePaneEl.scrollTop = 0;

    requestAnimationFrame(() => {
      sidePaneEl.classList.add("visible");
    });
  };

  const _veraDbgWrappedMount = isVeraInterruptDebugEnabled()
    ? () => {
        try { mount(); } finally {
          const endAt = performance.now();
          _veraNewsPanelRenderInFlight = false;
          logVeraInterruptDebug({
            tag: "news_panel_render_end",
            now: Number(endAt.toFixed(1)),
            durationMs: Number((endAt - _veraDbgRenderStart).toFixed(1)),
            panelType: payload?.panel_type || null,
          });
        }
      }
    : mount;
  runFlowModeSidePaneContentCrossfade(sidePaneEl, _veraDbgWrappedMount);
}

/* =========================
   2026-05-28 — product & location panel renderers (additive).
   Same `side-pane-*` markup family as renderMediaTabsPanel so the existing
   close button, Work Mode lock predicate, and crossfade work unchanged.
========================= */

/* 2026-05-28 — product card layout normalization.
 * - Hard-cap the visible rank to 3 (backend already trims, but defend
 *   against payload drift during streaming).
 * - Always render a fixed-ratio image container so a tall mic photo and a
 *   wide webcam photo line up in the same grid row. Image uses
 *   object-fit: contain (CSS) so logos / cropped shots aren't squashed.
 * - Show a placeholder square when the Serper card has no imageUrl
 *   instead of letting the card collapse.
 * - Stamp a rank badge ("Best overall" / "Best value" / "Alternative")
 *   from `payload.rank_labels` or `item.rank_label`; falls back to the
 *   index if neither is present. */
const PRODUCT_RANK_BADGE_FALLBACK = ["Best overall", "Best value", "Alternative"];
const PRODUCT_VISIBLE_LIMIT = 3;

function renderProductResultListMarkup(products, payloadHints) {
  if (!Array.isArray(products) || !products.length) {
    return `<div class="side-pane-empty">No product results came back from the search.</div>`;
  }
  const rankLabels = Array.isArray(payloadHints?.rank_labels)
    ? payloadHints.rank_labels
    : PRODUCT_RANK_BADGE_FALLBACK;
  const visible = products.slice(0, PRODUCT_VISIBLE_LIMIT);
  return `
    <div class="news-result-list product-result-list">
      ${visible.map((item, index) => {
        const img = (item.image_url || "").trim();
        const price = (item.price || "").trim();
        const rating = (item.rating || "").trim();
        const source = (item.source || "Unknown source").trim();
        const summary = (item.summary || "").trim();
        const url = (item.url || "").trim();
        const rankLabel = (item.rank_label || rankLabels[index] || `#${index + 1}`).trim();
        const rankClass = `product-rank-badge product-rank-${index + 1}`;
        return `
          <article class="news-result-card product-result-card">
            <div class="${rankClass}">${escapeHtml(rankLabel)}</div>
            <div class="product-image-wrap">
              ${img ? `
                <img
                  class="product-image"
                  src="${escapeHtml(img)}"
                  alt="${escapeHtml(item.title || "Product image")}"
                  loading="lazy"
                  referrerpolicy="no-referrer"
                  onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'product-image-placeholder',textContent:'No image'}))"
                />
              ` : `
                <div class="product-image-placeholder">No image</div>
              `}
            </div>
            <h4 class="news-result-title product-result-title">${escapeHtml(item.title || "Product")}</h4>
            <div class="product-result-meta-row">
              ${price ? `<span class="product-result-price">${escapeHtml(price)}</span>` : ""}
              ${rating ? `<span class="product-result-rating">★ ${escapeHtml(rating)}</span>` : ""}
            </div>
            ${summary ? `<p class="news-result-snippet">${escapeHtml(summary)}</p>` : ""}
            <div class="news-result-meta">
              <span>${escapeHtml(source)}</span>
            </div>
            ${url ? `<a class="news-result-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open product</a>` : ""}
          </article>
        `;
      }).join("")}
      ${
        products.length > PRODUCT_VISIBLE_LIMIT || (payloadHints?.extras_count || 0) > 0
          ? `<div class="product-result-extras-note">
               ${escapeHtml(
                 String(
                   Math.max(
                     products.length - PRODUCT_VISIBLE_LIMIT,
                     Number(payloadHints?.extras_count || 0),
                   )
                 )
               )} more results not shown
             </div>`
          : ""
      }
    </div>
  `;
}

function renderProductResultsPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  const mount = () => {
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));

    const products = Array.isArray(payload?.products) ? payload.products : [];

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "Shopping Results")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.query || "")}</div>
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="side-pane-tab-panel active" data-tab-panel="products">
      ${renderProductResultListMarkup(products, payload)}
    </div>
  `;

    sidePaneEl.scrollTop = 0;

    requestAnimationFrame(() => {
      sidePaneEl.classList.add("visible");
    });
  };

  runFlowModeSidePaneContentCrossfade(sidePaneEl, mount);
}

/* 2026-05-28 — location/map panel layout.
 * - Always render a top "map placeholder" strip (real Leaflet/Mapbox swap
 *   is a follow-up; spec explicitly says "show place cards now and leave a
 *   map placeholder").
 * - If `payload.map_pins` carries coordinates, render lightweight numbered
 *   pin chips inside the placeholder so the user can tell how many places
 *   were geocoded vs. address-only.
 * - Each place card mirrors the spec fields (name, address, rating,
 *   open state, category, source, link, directions). */
function renderLocationMapPlaceholderMarkup(payload) {
  const pins = Array.isArray(payload?.map_pins) ? payload.map_pins : [];
  const placeCount = Number(payload?.place_count || (payload?.places?.length ?? 0));
  const summary = pins.length
    ? `${pins.length} place${pins.length === 1 ? "" : "s"} pinned · ${placeCount} result${placeCount === 1 ? "" : "s"}`
    : placeCount
      ? `${placeCount} result${placeCount === 1 ? "" : "s"} (no coordinates yet — addresses below)`
      : `No places to show yet.`;
  const pinChips = pins.slice(0, 12).map((pin, i) => `
    <span class="location-map-pin" title="${escapeHtml(pin?.name || "")}${pin?.address ? ' — ' + escapeHtml(pin.address) : ""}">
      <span class="location-map-pin-index">${i + 1}</span>
      ${escapeHtml((pin?.name || "Pin").slice(0, 32))}
    </span>
  `).join("");
  return `
    <div class="location-map-placeholder" data-map-pins="${pins.length}">
      <div class="location-map-placeholder-label">Map preview</div>
      <div class="location-map-placeholder-summary">${escapeHtml(summary)}</div>
      ${pinChips ? `<div class="location-map-pin-list">${pinChips}</div>` : ""}
    </div>
  `;
}

function renderLocationPlaceListMarkup(places) {
  if (!Array.isArray(places) || !places.length) {
    return `<div class="side-pane-empty">No places came back from the search.</div>`;
  }
  return `
    <div class="news-result-list location-result-list">
      ${places.map((item, index) => {
        const name = (item.name || "").trim();
        const address = (item.address || "").trim();
        const rating = (item.rating || "").trim();
        const openState = (item.open_state || "").trim();
        const category = (item.category || "").trim();
        const source = (item.source || "Unknown source").trim();
        const url = (item.url || "").trim();
        const directions = (item.directions_url || "").trim();
        const hasCoords =
          typeof item.latitude === "number" && typeof item.longitude === "number";
        return `
          <article class="news-result-card location-result-card">
            <h4 class="news-result-title">
              <span class="location-result-pin">${index + 1}</span>
              ${escapeHtml(name)}
            </h4>
            ${category ? `<div class="location-result-category">${escapeHtml(category)}</div>` : ""}
            ${address ? `<div class="location-result-address">${escapeHtml(address)}</div>` : ""}
            <div class="location-result-meta-row">
              ${rating ? `<span class="location-result-rating">★ ${escapeHtml(rating)}</span>` : ""}
              ${openState ? `<span class="location-result-open">${escapeHtml(openState)}</span>` : ""}
              ${hasCoords ? `<span class="location-result-geocoded">Geocoded</span>` : ""}
            </div>
            <div class="news-result-meta">
              <span>${escapeHtml(source)}</span>
            </div>
            <div class="location-result-links">
              ${url ? `<a class="news-result-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
              ${
                directions
                  ? `<a class="news-result-link" href="${escapeHtml(directions)}" target="_blank" rel="noopener noreferrer">Directions</a>`
                  : address
                    ? `<a class="news-result-link" href="${escapeHtml('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(name + ' ' + address))}" target="_blank" rel="noopener noreferrer">Directions</a>`
                    : ""
              }
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderLocationMapPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  const mount = () => {
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));

    const places = Array.isArray(payload?.places) ? payload.places : [];
    const subtitle = (payload?.location || payload?.query || "").trim();

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "Places")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(subtitle)}</div>
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="side-pane-tab-panel active" data-tab-panel="places">
      ${renderLocationMapPlaceholderMarkup(payload)}
      ${renderLocationPlaceListMarkup(places)}
    </div>
  `;

    sidePaneEl.scrollTop = 0;

    requestAnimationFrame(() => {
      sidePaneEl.classList.add("visible");
    });
  };

  runFlowModeSidePaneContentCrossfade(sidePaneEl, mount);
}

try {
  window.renderProductResultsPanel = renderProductResultsPanel;
  window.renderLocationMapPanel = renderLocationMapPanel;
  window.renderProductResultListMarkup = renderProductResultListMarkup;
  window.renderLocationPlaceListMarkup = renderLocationPlaceListMarkup;
  window.renderLocationMapPlaceholderMarkup = renderLocationMapPlaceholderMarkup;
} catch (_) {}

/* =========================
   STAGE 10 (additive): read-only debug accessor
========================= */

function getNewsPanelDebugState() {
  let sidePaneVisible = false;
  let sidePaneHidden = true;
  let sidePaneKind = null;
  let sidePaneHasContent = false;
  let bodyHasNewsPanelOpen = false;
  try {
    const sidePaneEl = (typeof uiEl === "function") ? uiEl("side-pane") : null;
    if (sidePaneEl) {
      sidePaneVisible = sidePaneEl.classList?.contains("visible") || false;
      sidePaneHidden = Boolean(sidePaneEl.hidden);
      sidePaneKind = sidePaneEl.dataset?.sidePaneKind || null;
      sidePaneHasContent =
        typeof sidePaneEl.innerHTML === "string" && sidePaneEl.innerHTML.trim().length > 0;
    }
    bodyHasNewsPanelOpen =
      typeof document !== "undefined" &&
      document.body?.classList?.contains?.("news-panel-open") === true;
  } catch (_) {}
  return {
    news_panel_render_in_flight: _veraNewsPanelRenderInFlight,
    side_pane_visible: sidePaneVisible,
    side_pane_hidden: sidePaneHidden,
    side_pane_kind: sidePaneKind,
    side_pane_has_content: sidePaneHasContent,
    body_news_panel_open: bodyHasNewsPanelOpen,
    render_news_result_list_markup_typeof: typeof renderNewsResultListMarkup,
    render_image_results_markup_typeof: typeof renderImageResultsMarkup,
    render_video_results_markup_typeof: typeof renderVideoResultsMarkup,
    get_video_embed_url_typeof: typeof getVideoEmbedUrl,
    set_active_side_pane_tab_typeof: typeof setActiveSidePaneTab,
    render_media_tabs_panel_typeof: typeof renderMediaTabsPanel
  };
}

try {
  window.getNewsPanelDebugState = getNewsPanelDebugState;
} catch (_) {}
