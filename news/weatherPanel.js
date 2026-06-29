/* news/weatherPanel.js — forecast side panel renderer (v1). */

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
    const rowHtml = rows.length
      ? rows
          .map(
            (row) => `
        <tr>
          <td>${escapeHtml(String(row?.label || ""))}</td>
          <td>${escapeHtml(String(row?.condition || ""))}</td>
          <td>${row?.high_f != null ? `${escapeHtml(String(row.high_f))}°` : "—"}</td>
          <td>${row?.low_f != null ? `${escapeHtml(String(row.low_f))}°` : "—"}</td>
          <td>${row?.rain_percent != null ? `${escapeHtml(String(row.rain_percent))}%` : "—"}</td>
          <td>${row?.wind_mph != null ? `${escapeHtml(String(row.wind_mph))} mph` : "—"}</td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="6" class="weather-forecast-empty">No forecast rows available.</td></tr>`;

    sidePaneEl.hidden = false;
    delete sidePaneEl.dataset.sidePaneKind;
    document.body.classList.add("news-panel-open");

    sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "Weather forecast")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.location || "")}${payload?.time_range_label ? ` · ${escapeHtml(payload.time_range_label)}` : ""}</div>
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="weather-forecast-panel">
      ${payload?.summary ? `<p class="weather-forecast-summary">${escapeHtml(payload.summary)}</p>` : ""}
      <div class="weather-forecast-table-wrap">
        <table class="weather-forecast-table">
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
} catch (_) {}
