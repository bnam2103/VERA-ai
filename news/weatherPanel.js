/* news/weatherPanel.js — forecast side panel renderer (v2). */

function deriveWeatherSummaryCard(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const primary = rows[0];
  const highs = rows
    .map((r) => Number(r?.high_f))
    .filter((v) => Number.isFinite(v));
  const lows = rows
    .map((r) => Number(r?.low_f))
    .filter((v) => Number.isFinite(v));
  const high =
    primary?.high_f != null && Number.isFinite(Number(primary.high_f))
      ? Number(primary.high_f)
      : highs.length
        ? Math.max(...highs)
        : null;
  const low =
    primary?.low_f != null && Number.isFinite(Number(primary.low_f))
      ? Number(primary.low_f)
      : lows.length
        ? Math.min(...lows)
        : null;
  return {
    condition: String(primary?.condition || "").trim(),
    high_f: high,
    low_f: low,
    rain_percent: primary?.rain_percent,
    wind_mph: primary?.wind_mph,
  };
}

function renderWeatherSummaryCardMarkup(summary) {
  if (!summary) return "";
  const high =
    summary.high_f != null && Number.isFinite(Number(summary.high_f))
      ? `${Math.round(Number(summary.high_f))}°`
      : "—";
  const low =
    summary.low_f != null && Number.isFinite(Number(summary.low_f))
      ? `${Math.round(Number(summary.low_f))}°`
      : "—";
  const rain =
    summary.rain_percent != null && Number.isFinite(Number(summary.rain_percent))
      ? `${Math.round(Number(summary.rain_percent))}%`
      : "—";
  const wind =
    summary.wind_mph != null && Number.isFinite(Number(summary.wind_mph))
      ? `${Math.round(Number(summary.wind_mph))} mph`
      : "—";
  const condition = summary.condition
    ? escapeHtml(
        String(summary.condition)
          .trim()
          .replace(/\b([a-z])/g, (m) => m.toUpperCase())
      )
    : "Mixed conditions";

  return `
    <div class="weather-summary-card">
      <div class="weather-summary-temps" aria-label="High and low temperature">
        <span class="weather-summary-high">${escapeHtml(high)}</span>
        <span class="weather-summary-sep">/</span>
        <span class="weather-summary-low">${escapeHtml(low)}</span>
      </div>
      <div class="weather-summary-condition">${condition}</div>
      <div class="weather-summary-meta">
        <span>Rain ${escapeHtml(rain)}</span>
        <span class="weather-summary-meta-dot" aria-hidden="true">·</span>
        <span>Wind ${escapeHtml(wind)}</span>
      </div>
    </div>
  `;
}

function renderWeatherForecastPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  const workModeActive =
    typeof isVeraWorkModeOn === "function" &&
    isVeraWorkModeOn() &&
    typeof appModePrefix === "function" &&
    appModePrefix() === "vera";
  const musicPanelExistsBefore =
    sidePaneEl.dataset.sidePaneKind === "productivity" &&
    Boolean(String(sidePaneEl.innerHTML || "").trim());

  try {
    console.info("[weather_panel_render_requested]", {
      action_name: "weather.forecast",
      work_mode_active: workModeActive,
      target_container_id: sidePaneEl.id || "side-pane",
      music_panel_exists_before: musicPanelExistsBefore,
    });
    console.info("[weather_panel_target_container]", {
      target_container_id: sidePaneEl.id || "side-pane",
      side_pane_kind: sidePaneEl.dataset.sidePaneKind || null,
    });
  } catch (_) {}

  if (workModeActive && musicPanelExistsBefore) {
    try {
      console.info("[music_panel_overwrite_blocked]", {
        action_name: "weather_forecast_panel",
        work_mode_active: true,
        target_container_id: sidePaneEl.id || "side-pane",
        music_panel_exists_before: true,
        music_panel_exists_after: true,
        reason: "work_mode_productivity_pinned",
      });
      console.info("[music_panel_preserved]", {
        action_name: "weather_forecast_panel",
        music_panel_exists_after: true,
        reason: "weather_forecast_deferred_from_music_slot",
      });
    } catch (_) {}
    return;
  }

  try {
    console.info("[weather_forecast_panel]", {
      stage: "frontend_render",
      location: payload?.location || null,
      time_range_label: payload?.time_range_label || null,
      row_count: Array.isArray(payload?.rows) ? payload.rows.length : 0,
    });
  } catch (_) {}

  const mount = () => {
    document.querySelectorAll(".productivity-mode-btn").forEach((b) => b.classList.remove("is-active"));

    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const summaryCard = deriveWeatherSummaryCard(rows);
    const rowHtml = rows.length
      ? rows
          .map(
            (row) => `
        <tr>
          <td>${escapeHtml(String(row?.label || ""))}</td>
          <td>${escapeHtml(String(row?.condition || ""))}</td>
          <td class="weather-forecast-temp-cell">${row?.high_f != null ? `${escapeHtml(String(row.high_f))}°` : "—"}</td>
          <td class="weather-forecast-temp-cell">${row?.low_f != null ? `${escapeHtml(String(row.low_f))}°` : "—"}</td>
          <td>${row?.rain_percent != null ? `${escapeHtml(String(row.rain_percent))}%` : "—"}</td>
          <td>${row?.wind_mph != null ? `${escapeHtml(String(row.wind_mph))} mph` : "—"}</td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="6" class="weather-forecast-empty">No forecast rows available.</td></tr>`;

    const locationLine = escapeHtml(String(payload?.location || "").trim());
    const timeLine = payload?.time_range_label
      ? escapeHtml(String(payload.time_range_label).trim())
      : "";
    const subtitle = [locationLine, timeLine].filter(Boolean).join(" · ");

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "Weather forecast")}</h3>
        ${subtitle ? `<div class="side-pane-subtitle">${subtitle}</div>` : ""}
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="weather-forecast-panel">
      ${renderWeatherSummaryCardMarkup(summaryCard)}
      ${
        rows.length
          ? `
      <div class="weather-forecast-details">
        <div class="weather-forecast-details-label">Daily breakdown</div>
        <div class="weather-forecast-table-wrap">
          <table class="weather-forecast-table weather-forecast-table--secondary">
            <thead>
              <tr>
                <th>When</th>
                <th>Conditions</th>
                <th>High</th>
                <th>Low</th>
                <th>Rain</th>
                <th>Wind</th>
              </tr>
            </thead>
            <tbody>${rowHtml}</tbody>
          </table>
        </div>
      </div>`
          : `<p class="weather-forecast-empty">No forecast rows available.</p>`
      }
      ${payload?.notes ? `<p class="weather-forecast-note">${escapeHtml(payload.notes)}</p>` : ""}
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
  window.renderWeatherForecastPanel = renderWeatherForecastPanel;
  window.deriveWeatherSummaryCard = deriveWeatherSummaryCard;
} catch (_) {}
