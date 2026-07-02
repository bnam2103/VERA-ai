/* Vera /app/ shell — boot, work mode, BMO nav, ask rotator. No landing/trailer logic. */

const bmoLoadingScreen = document.getElementById("bmo-loading-screen");
const bmoPage = document.getElementById("bmo-page");
const veraApp = document.getElementById("vera-app");
const veraWorkModeBtn = document.getElementById("vera-work-mode");
const bmoLoadingDotsEl = document.querySelector(".bmo-loading-dots");
let bmoLoadingDotsInterval = null;

  function stopBmoIntro() {
    bmoPage?.classList.remove("bmo-mouth-active");
    document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-emotion");
    document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-face-track");
    const cap = document.getElementById("bmo-intro-caption");
    if (cap) {
      cap.textContent = "";
    }
  }

  function startBmoLoadingDots() {
    if (!bmoLoadingDotsEl) return;
    const frames = ["", ".", "..", "..."];
    let frameIndex = 0;

    if (bmoLoadingDotsInterval) {
      clearInterval(bmoLoadingDotsInterval);
    }

    bmoLoadingDotsEl.textContent = frames[0];
    bmoLoadingDotsInterval = setInterval(() => {
      frameIndex = (frameIndex + 1) % frames.length;
      bmoLoadingDotsEl.textContent = frames[frameIndex];
    }, 400);
  }

  function stopBmoLoadingDots() {
    if (bmoLoadingDotsInterval) {
      clearInterval(bmoLoadingDotsInterval);
      bmoLoadingDotsInterval = null;
    }
    if (bmoLoadingDotsEl) {
      bmoLoadingDotsEl.textContent = "";
    }
  }

  function pauseMusicPanelOnNavAway(reason) {
    try {
      const tag = String(reason || "nav_away");
      let paused = false;
      // 1. Spotify Web Playback SDK (primary path for the music panel).
      try {
        const sp = window.VeraSpotify;
        if (sp && typeof sp.pausePlayback === "function") {
          const result = sp.pausePlayback();
          if (result && typeof result.then === "function") {
            result.catch((err) => console.warn("[music_panel_pause] spotify pause error:", err));
          }
          paused = true;
        }
      } catch (err) {
        console.warn("[music_panel_pause] spotify pause threw:", err);
      }
      // 2. Any <audio>/<video> elements inside the Work Mode music panel
      //    (covers preview audio + future non-Spotify players).
      try {
        const root = document.getElementById("vera-wm-music-pane");
        if (root) {
          const players = root.querySelectorAll("audio, video");
          players.forEach((el) => {
            try {
              if (!el.paused) {
                el.pause();
                paused = true;
              }
            } catch (_) {}
          });
        }
      } catch (err) {
        console.warn("[music_panel_pause] media element pause threw:", err);
      }
      try {
        console.info("[music_panel_pause]", { reason: tag, paused });
      } catch (_) {}
    } catch (_) {}
  }
  window.pauseMusicPanelOnNavAway = pauseMusicPanelOnNavAway;

  function exitVeraWorkMode(opts) {
    const skipUsageSync = Boolean(opts && opts.skipUsageSync);
    if (typeof window.layoutVeraWorkModePanels === "function") {
      window.layoutVeraWorkModePanels(false);
    }
    if (typeof window.clearWorkModeReasoningPending === "function") {
      window.clearWorkModeReasoningPending();
    }
    if (typeof window.clearVeraWorkModeClientTimer === "function") {
      window.clearVeraWorkModeClientTimer();
    }
    veraApp?.classList.remove("work-mode");
    veraWorkModeBtn?.setAttribute("aria-pressed", "false");
    if (typeof window.syncVeraHeaderDateTimeForWorkMode === "function") {
      window.syncVeraHeaderDateTimeForWorkMode();
    }
    if (typeof window.ensureVeraVoiceUiActive === "function") {
      void window.ensureVeraVoiceUiActive();
    }
    if (!skipUsageSync) {
    try {
      window.veraUsageSyncModeFromDom?.({ trigger: "ui", source: "work_mode_exit" });
    } catch (_) {}
    if (typeof window.syncVeraInputEmptyState === "function") {
      window.syncVeraInputEmptyState();
    }
  }
  }

  function enterVeraWorkMode() {
    if (!veraApp || veraApp.hidden) return;
    if (window.matchMedia("(max-width: 768px)").matches) return;
    /* Apply work-mode before hideSidePanel so productivity/music can stay pinned and the side pane is not wiped. */
    veraApp.classList.add("work-mode");
    veraWorkModeBtn?.setAttribute("aria-pressed", "true");
    if (typeof window.hideSidePanel === "function") {
      window.hideSidePanel();
    }
    if (typeof window.layoutVeraWorkModePanels === "function") {
      window.layoutVeraWorkModePanels(true);
    }
    if (typeof window.loadWorkModeChecklist === "function") {
      window.loadWorkModeChecklist();
    }
    if (typeof window.hydrateWorkModeChecklistFromServer === "function") {
      void window.hydrateWorkModeChecklistFromServer();
    }
    if (typeof window.ensureVeraVoiceUiActive === "function") {
      void window.ensureVeraVoiceUiActive();
    }
    if (typeof window.syncVeraFlowVoiceDockLayoutClass === "function") {
      window.syncVeraFlowVoiceDockLayoutClass();
    }
    if (typeof window.syncVeraHeaderDateTimeForWorkMode === "function") {
      window.syncVeraHeaderDateTimeForWorkMode();
    }
    try {
      window.veraUsageSyncModeFromDom?.({ trigger: "ui", source: "work_mode_enter" });
    } catch (_) {}
    if (typeof window.syncVeraInputEmptyState === "function") {
      window.syncVeraInputEmptyState();
    }
  }

  window.setVeraWorkMode = function setVeraWorkMode(on) {
    if (!veraApp || veraApp.hidden) return false;
    if (on) enterVeraWorkMode();
    else exitVeraWorkMode();
    return true;
  };

  if (window.matchMedia("(max-width: 768px)").matches) {
    veraWorkModeBtn?.setAttribute("hidden", "");
    veraWorkModeBtn?.setAttribute("aria-hidden", "true");
  }

  veraWorkModeBtn?.addEventListener("click", () => {
    if (!veraApp || veraApp.hidden) return;
    if (veraApp.classList.contains("work-mode")) {
      exitVeraWorkMode();
      return;
    }
    enterVeraWorkMode();
  });

  function openBmoPage() {
    exitVeraWorkMode({ skipUsageSync: true });
    if (!bmoPage.hidden) {
      return;
    }
    pauseMusicPanelOnNavAway("vera_to_bmo");
    if (typeof window.resetVoiceUiToIdle === "function") {
      window.resetVoiceUiToIdle();
    }
    veraApp?.classList.remove("vera-flow-voice-docked");
    veraApp?.classList.remove("vera-flow-input-active");
    veraApp.hidden = true;
    document.body.classList.remove("vera-mode");
    try {
      window.veraUsageLeaveVeraForBmo?.({
        trigger: "ui",
        source: "vera_to_bmo",
      });
    } catch (_) {}
    document.body.classList.add("app-open", "bmo-open");
    try {
      if (typeof window.trackUsageSessionStart === "function") {
        window.trackUsageSessionStart();
      }
      window.veraUsageSyncModeFromDom?.({ trigger: "ui", source: "bmo_enter" });
    } catch (_) {}
    bmoLoadingScreen.hidden = false;
    bmoLoadingScreen.classList.remove("fade-in");
    bmoLoadingScreen.classList.add("fade-out");

    requestAnimationFrame(() => {
      bmoLoadingScreen.classList.remove("fade-out");
      bmoLoadingScreen.classList.add("fade-in");
    });
    startBmoLoadingDots();

    const bmoLoadingBar = bmoLoadingScreen.querySelector(".bmo-loading-bar");
    if (bmoLoadingBar) {
      bmoLoadingBar.style.animation = "none";
      void bmoLoadingBar.offsetWidth;
      bmoLoadingBar.style.animation = "";
    }

    setTimeout(() => {
      bmoLoadingScreen.classList.add("fade-out");

      setTimeout(() => {
        bmoLoadingScreen.hidden = true;
        bmoLoadingScreen.classList.remove("fade-in", "fade-out");
        stopBmoLoadingDots();

        bmoPage.hidden = false;
        bmoPage.classList.add("fade-out");
        bmoPage.classList.remove("bmo-animate-in");
        stopBmoIntro();

        requestAnimationFrame(() => {
          bmoPage.classList.remove("fade-out");
          bmoPage.classList.add("fade-in");
          scheduleAskRotatorLayoutSync();
          requestAnimationFrame(() => {
            bmoPage.classList.add("bmo-animate-in");
            syncAskRotatorVisibility({ resetSequence: true });
            /* BMO canvas was hidden while on VERA — buffer was never sized; CSS stretch = blurry. */
            requestAnimationFrame(() => {
              window.dispatchEvent(new Event("resize"));
            });
            setTimeout(() => window.dispatchEvent(new Event("resize")), 80);
            setTimeout(() => window.dispatchEvent(new Event("resize")), 400);
          });
        });
      }, 260);
    }, 4000);
  }

  function closeBmoPage() {
    stopBmoIntro();
    if (typeof window.resetVoiceUiToIdle === "function") {
      window.resetVoiceUiToIdle();
    }
    bmoPage.classList.add("fade-out");
    setTimeout(() => {
      bmoPage.hidden = true;
      bmoPage.classList.remove("fade-in", "fade-out", "bmo-animate-in");
      bmoLoadingScreen.hidden = true;
      bmoLoadingScreen.classList.remove("fade-in", "fade-out");
      stopBmoLoadingDots();
      document.body.classList.remove("app-open", "bmo-open", "vera-mode");
      try {
        window.veraUsageSyncModeFromDom?.({
          trigger: "ui",
          source: "bmo_exit",
          to: "home",
        });
      } catch (_) {}
      window.location.href = "../";
    }, 450);
  }

  document.getElementById("open-bmo-from-vera")?.addEventListener("click", openBmoPage);

const bootLoader = document.getElementById("boot-loader");
const bootBar = document.getElementById("boot-bar");
const bootPercent = document.getElementById("boot-percent");
const bootLabelEl = document.querySelector("#boot-loader .boot-label");
const bootNoteEl = document.querySelector("#boot-loader .boot-note");

let currentProgress = 0;
let bootPollInterval = null;
let bootRevealTimer = null;
let bootTimeoutTimer = null;
const BOOT_POLL_MS = 2000;
const BOOT_STALL_LOG_MS = 30000;

function setBootStatusMessage(label, note) {
  if (bootLabelEl && label) bootLabelEl.textContent = label;
  if (bootNoteEl && note !== undefined) bootNoteEl.textContent = note;
}

function setProgress(value) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  currentProgress = clamped;
  bootBar.style.width = clamped + "%";
  bootPercent.textContent = clamped + "%";
}

let hitStarting = false;
let appRevealed = false;
let bootStarted = false;
let offlineBootPolls = 0;

function stopBootPolling() {
  if (bootPollInterval) {
    clearInterval(bootPollInterval);
    bootPollInterval = null;
  }
}

function scheduleBootReveal() {
  if (appRevealed || bootRevealTimer) return;

  stopBootPolling();
  bootRevealTimer = setTimeout(() => {
    setProgress(100);
    bootRevealTimer = setTimeout(() => {
      revealApp();
      bootRevealTimer = null;
    }, 500);
  }, 500);
}

function clearBootTimeout() {
  if (bootTimeoutTimer) {
    clearTimeout(bootTimeoutTimer);
    bootTimeoutTimer = null;
  }
}

function scheduleBootStallFallback() {
  clearBootTimeout();
  bootTimeoutTimer = setTimeout(() => {
    if (appRevealed) return;
    console.warn("[boot] still waiting for backend after", BOOT_STALL_LOG_MS, "ms");
    setBootStatusMessage(
      "Retrying connection…",
      "Still waiting for Vera backend. Checking again…"
    );
    scheduleBootStallFallback();
  }, BOOT_STALL_LOG_MS);
}

async function pollBootStatus() {
  if (typeof checkServer !== "function") {
    console.error("[boot] checkServer unavailable — app.js may not have loaded");
    offlineBootPolls += 1;
    setBootStatusMessage(
      offlineBootPolls > 1 ? "Retrying connection…" : "Waiting for Vera backend…",
      "App scripts are still loading. Retrying…"
    );
    setProgress(0);
    return;
  }
  let state = "offline";
  try {
    state = await checkServer();
  } catch (err) {
    console.error("[boot] server health check fail", err);
    offlineBootPolls += 1;
    setBootStatusMessage(
      "Retrying connection…",
      "Could not reach Vera backend. Checking again…"
    );
    setProgress(Math.min(offlineBootPolls * 8, 40));
    return;
  }

  if (state === "offline") {
    hitStarting = false;
    offlineBootPolls += 1;
    setBootStatusMessage(
      offlineBootPolls > 1 ? "Retrying connection…" : "Waiting for Vera backend…",
      "The server is offline or waking up. Checking again…"
    );
    setProgress(Math.min(offlineBootPolls * 8, 40));
    return;
  }

  offlineBootPolls = 0;

  if (state === "starting") {
    hitStarting = true;
    setBootStatusMessage(
      "Starting Vera backend…",
      "First launch from idle may take 10–30 seconds while the server wakes up."
    );
    setProgress(Math.min(Math.max(currentProgress, 0) + 12, 85));
    return;
  }

  if (state === "ready" && !appRevealed) {
    if (bootRevealTimer) return;
    setBootStatusMessage("VERA is ready", "");
    setProgress(Math.max(currentProgress, 90));
    scheduleBootReveal();
  }
}

async function startBootSequence() {
  if (bootStarted) return;
  bootStarted = true;
  console.info("[boot] start");
  appRevealed = false;
  stopBootPolling();
  document.body.classList.add("vera-mode");
  document.body.classList.remove("bmo-open");
  bootLoader.classList.add("active");
  veraApp.hidden = true;
  setBootStatusMessage(
    "Initializing VERA…",
    "Waiting for Vera backend…"
  );
  setProgress(0);
  hitStarting = false;
  if (bootRevealTimer) {
    clearTimeout(bootRevealTimer);
    bootRevealTimer = null;
  }

  scheduleBootStallFallback();
  try {
    await pollBootStatus();
  } catch (err) {
    console.error("[boot] initial poll fail", err);
  }
  if (!appRevealed) {
    bootPollInterval = setInterval(pollBootStatus, BOOT_POLL_MS);
  }
}

function revealApp() {
  if (appRevealed) return;
  appRevealed = true;
  clearBootTimeout();

  setTimeout(() => {
    exitVeraWorkMode();
    if (typeof window.resetVoiceUiToIdle === "function") {
      window.resetVoiceUiToIdle();
    }
    /* Do not call resetVeraSessionAndUi here: it assigns a new session id and clears the chat log,
       which wipes client-restored Voice UI history right after reload/boot reveal. */
    bootLoader.classList.remove("active");
    bmoPage.hidden = true;
    veraApp.hidden = false;
    veraApp.classList.remove("fade-out");
    document.body.classList.add("app-open");
    document.body.classList.remove("bmo-open");
    document.body.classList.add("vera-mode");
    try {
      if (typeof window.trackUsageSessionStart === "function") {
        window.trackUsageSessionStart();
      }
      window.veraUsageSyncModeFromDom?.({ trigger: "ui", source: "vera_reveal" });
    } catch (_) {}

    requestAnimationFrame(() => {
      veraApp.classList.add("fade-in");
      scheduleAskRotatorLayoutSync();
      syncAskRotatorVisibility({ resetSequence: true });
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
        if (typeof window.ensureVeraVoiceUiActive === "function") {
          void window.ensureVeraVoiceUiActive();
        }
      });
    });
  }, 500);
}

document.getElementById("return-home")?.addEventListener("click", async () => {
  stopBmoIntro();
  if (typeof window.resetVoiceUiToIdle === "function") {
    window.resetVoiceUiToIdle();
  }
  bmoPage.classList.add("fade-out");

  setTimeout(() => {
    bmoPage.hidden = true;
    bmoPage.classList.remove("fade-out", "fade-in", "bmo-animate-in");

    document.body.classList.remove("bmo-open");
    document.body.classList.add("app-open");
    document.body.classList.add("vera-mode");

    veraApp.hidden = false;
    veraApp.classList.remove("fade-out");
    veraApp.classList.add("fade-in");

    window.dispatchEvent(new Event("resize"));
    if (typeof window.ensureVeraVoiceUiActive === "function") {
      void window.ensureVeraVoiceUiActive();
    }
    try {
      window.veraUsageSyncModeFromDom?.({
        trigger: "ui",
        source: "bmo_return_home",
        to: "voice_ui",
      });
    } catch (_) {}
  }, 600);
});

function getVeraMarketingHomeUrl() {
  try {
    const host = String(window.location?.hostname || "");
    if (host === "workwithvera.com" || host.endsWith(".workwithvera.com")) {
      return "/";
    }
    const path = String(window.location?.pathname || "");
    if (/\/app\/?$/i.test(path)) {
      return "../";
    }
  } catch (_) {}
  return "/";
}

async function navigateVeraAppToHome(source) {
  exitVeraWorkMode();
  pauseMusicPanelOnNavAway("vera_to_home");
  if (typeof window.resetVoiceUiToIdle === "function") {
    window.resetVoiceUiToIdle();
  }
  try {
    window.veraUsageSyncModeFromDom?.({
      trigger: "ui",
      source: source || "vera_return_home",
      to: "home",
    });
  } catch (_) {}
  window.location.href = getVeraMarketingHomeUrl();
}

document.getElementById("vera-sidebar-brand-home")?.addEventListener("click", async (e) => {
  e.preventDefault();
  await navigateVeraAppToHome("vera_sidebar_home");
});

let startupTypingOuterTimer = null;
let startupTypingCharTimer = null;
let startupAudioScheduleTimer = null;

function clearStartupTypingTimers() {
  if (startupTypingOuterTimer != null) {
    clearTimeout(startupTypingOuterTimer);
    startupTypingOuterTimer = null;
  }
  if (startupTypingCharTimer != null) {
    clearTimeout(startupTypingCharTimer);
    startupTypingCharTimer = null;
  }
  if (startupAudioScheduleTimer != null) {
    clearTimeout(startupAudioScheduleTimer);
    startupAudioScheduleTimer = null;
  }
}

/** Legacy hook kept for compatibility. Startup line/audio are disabled. */
function cancelStartupTypingForVoiceEntry() {
  clearStartupTypingTimers();
}

window.cancelStartupTypingForVoiceEntry = cancelStartupTypingForVoiceEntry;

function typeStartup(options = {}) {
  return;
}

function getActiveInputBar(prefix) {
  const keyboardBar = document.getElementById(`${prefix}-keyboard-bar`);
  const voiceBar = document.getElementById(`${prefix}-voice-bar`);
  if (prefix === "bmo") {
    const bmoVisibleBar = document.querySelector("#bmo-page .bmo-input-dock-row .input-bar:not(.hidden)");
    if (bmoVisibleBar) return bmoVisibleBar;
  }
  return keyboardBar && !keyboardBar.classList.contains("hidden")
    ? keyboardBar
    : voiceBar;
}

const veraAskRotatorEl = document.getElementById("vera-ask-rotator");
const bmoAskRotatorEl = document.getElementById("bmo-ask-rotator");

const ASK_ROTATOR_LINES = [
  { text: "\"Hey Vera, can you hear me?\"", isPrompt: true },
  { text: "\"What time is it?\"", isPrompt: true },
  { text: "\"How many days until Christmas?\"", isPrompt: true },
  { text: "\"What's on the news today?\"", isPrompt: true },
  { text: "\"What's Apple's stock price?\"", isPrompt: true },
  { text: "Sign in with Spotify, then try: \"Play Feather by Sabrina Carpenter\".", isPrompt: false },
  { text: "Press on the headset to mute and deafen VERA.", isPrompt: false },
  { text: "\"Tease me\"", isPrompt: true },
  { text: "While VERA is speaking, interrupt with: \"Can you mute?\"", isPrompt: false },
];

let askRotatorIndex = 0;
let askRotatorTimer = null;
let askRotatorEnabled = true;

function renderAskRotatorLine() {
  const entry = ASK_ROTATOR_LINES[askRotatorIndex];
  const line = entry.isPrompt ? `Try asking: ${entry.text}` : entry.text;
  if (veraAskRotatorEl) {
    veraAskRotatorEl.textContent = line;
  }
  if (bmoAskRotatorEl) {
    bmoAskRotatorEl.textContent = line;
  }
  scheduleAskRotatorLayoutSync();
}

function startAskRotator() {
  if (!askRotatorEnabled) return;
  if (askRotatorTimer) return;
  renderAskRotatorLine();
  askRotatorTimer = setInterval(() => {
    askRotatorIndex = (askRotatorIndex + 1) % ASK_ROTATOR_LINES.length;
    renderAskRotatorLine();
  }, 5000);
}

function restartAskRotatorFromFirstLine() {
  if (askRotatorTimer) {
    clearInterval(askRotatorTimer);
    askRotatorTimer = null;
  }
  askRotatorIndex = 0;
  startAskRotator();
}

function stopAskRotator() {
  if (!askRotatorTimer) return;
  clearInterval(askRotatorTimer);
  askRotatorTimer = null;
}

function syncAskRotatorLayout() {
  ["vera", "bmo"].forEach((prefix) => {
    const askEl = document.getElementById(`${prefix}-ask-rotator`);
    if (!askEl) return;
    if (prefix === "vera") {
      askEl.style.left = "";
      askEl.style.width = "";
      return;
    }
    const container = askEl.closest(".input-container");
    if (!container) return;

    const activeBar = getActiveInputBar(prefix);
    if (!activeBar) return;

    const barRect = activeBar.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!barRect.width) return;

    const centerX = barRect.left - containerRect.left + barRect.width / 2;
    askEl.style.left = `${Math.round(centerX)}px`;
    askEl.style.width = `${Math.round(barRect.width)}px`;
  });
}

const askRotatorRevealTimers = new Map();
const askRotatorHasRevealed = new Map();

function parseMaxCssTimeMs(value) {
  if (!value) return 0;
  return value
    .split(",")
    .map((part) => part.trim())
    .map((part) => {
      if (!part) return 0;
      if (part.endsWith("ms")) return Number.parseFloat(part) || 0;
      if (part.endsWith("s")) return (Number.parseFloat(part) || 0) * 1000;
      return 0;
    })
    .reduce((max, n) => Math.max(max, n), 0);
}

function revealAskRotatorAfterBarAnimation(prefix, options = {}) {
  const resetSequence = Boolean(options.resetSequence);
  const askEl = document.getElementById(`${prefix}-ask-rotator`);
  const pageEl = document.getElementById(prefix === "bmo" ? "bmo-page" : "vera-app");
  const activeBar = getActiveInputBar(prefix);
  if (!askEl || !activeBar || !pageEl || pageEl.hidden) return;
  if (!askRotatorEnabled) {
    const oldTimer = askRotatorRevealTimers.get(prefix);
    if (oldTimer) clearTimeout(oldTimer);
    askRotatorRevealTimers.delete(prefix);
    askEl.classList.remove("visible");
    return;
  }

  if (resetSequence) {
    askRotatorHasRevealed.set(prefix, false);
  }

  if (askRotatorHasRevealed.get(prefix) && !resetSequence) {
    syncAskRotatorLayout();
    if (!askRotatorTimer) {
      startAskRotator();
    }
    return;
  }

  const oldTimer = askRotatorRevealTimers.get(prefix);
  if (oldTimer && !resetSequence) {
    return;
  }
  if (oldTimer) {
    clearTimeout(oldTimer);
  }
  askEl.classList.remove("visible");

  const computed = getComputedStyle(activeBar);
  const animMs =
    parseMaxCssTimeMs(computed.animationDuration) +
    parseMaxCssTimeMs(computed.animationDelay);
  const transMs =
    parseMaxCssTimeMs(computed.transitionDuration) +
    parseMaxCssTimeMs(computed.transitionDelay);
  let waitMs = Math.max(animMs, transMs, 0);

  // BMO uses delayed dock/container animation on page enter; ensure reveal waits for it.
  if (prefix === "bmo") {
    const container = askEl.closest(".input-container");
    if (container) {
      const c = getComputedStyle(container);
      const containerAnimMs =
        parseMaxCssTimeMs(c.animationDuration) + parseMaxCssTimeMs(c.animationDelay);
      waitMs = Math.max(waitMs, containerAnimMs);
    }
  }

  const timer = setTimeout(() => {
    syncAskRotatorLayout();
    askEl.classList.add("visible");
    askRotatorHasRevealed.set(prefix, true);
    if (resetSequence) {
      restartAskRotatorFromFirstLine();
    } else if (!askRotatorTimer) {
      startAskRotator();
    }
    askRotatorRevealTimers.delete(prefix);
  }, waitMs > 0 ? waitMs + 40 : 40);
  askRotatorRevealTimers.set(prefix, timer);
}

function syncAskRotatorVisibility(options = {}) {
  if (!askRotatorEnabled) {
    stopAskRotator();
    ["vera", "bmo"].forEach((prefix) => {
      const askEl = document.getElementById(`${prefix}-ask-rotator`);
      if (askEl) askEl.classList.remove("visible");
      const oldTimer = askRotatorRevealTimers.get(prefix);
      if (oldTimer) clearTimeout(oldTimer);
      askRotatorRevealTimers.delete(prefix);
    });
    return;
  }
  ["vera", "bmo"].forEach((prefix) => {
    revealAskRotatorAfterBarAnimation(prefix, options);
  });
}

window.setAskRotatorEnabled = function setAskRotatorEnabled(on) {
  askRotatorEnabled = on !== false;
  if (!askRotatorEnabled) {
    syncAskRotatorVisibility();
    return;
  }
  syncAskRotatorVisibility({ resetSequence: true });
};

window.syncAskRotatorVisibility = syncAskRotatorVisibility;

window.isAskRotatorEnabled = function isAskRotatorEnabled() {
  return askRotatorEnabled;
};

function scheduleAskRotatorLayoutSync() {
  requestAnimationFrame(() => {
    syncAskRotatorLayout();
    setTimeout(syncAskRotatorLayout, 80);
    setTimeout(syncAskRotatorLayout, 260);
    setTimeout(syncAskRotatorLayout, 900);
    setTimeout(syncAskRotatorLayout, 3000);
  });
}

function wireInputModeToggles() {
  ["vera", "bmo"].forEach((prefix) => {
    const toggleBtn = document.getElementById(`${prefix}-input-toggle`);
    const voiceBar = document.getElementById(`${prefix}-voice-bar`);
    const keyboardBar = document.getElementById(`${prefix}-keyboard-bar`);
    if (!toggleBtn || !voiceBar || !keyboardBar) return;
    toggleBtn.addEventListener("click", () => {
      if (typeof window.ensureChatStartedLayout === "function") {
        window.ensureChatStartedLayout();
      }
      const keyboardVisible = !keyboardBar.classList.contains("hidden");
      const showKeyboard = !keyboardVisible;
      voiceBar.classList.toggle("hidden", showKeyboard);
      keyboardBar.classList.toggle("hidden", !showKeyboard);
      toggleBtn.textContent = showKeyboard ? "🎙️" : "⌨️";
      if (showKeyboard) {
        document.getElementById(`${prefix}-text-input`)?.focus();
      }
      if (prefix === "vera" && typeof window.syncVeraFlowVoiceDockLayoutClass === "function") {
        window.syncVeraFlowVoiceDockLayoutClass();
      }
      scheduleAskRotatorLayoutSync();
      revealAskRotatorAfterBarAnimation(prefix);
    });
  });
}

wireInputModeToggles();
scheduleAskRotatorLayoutSync();
syncAskRotatorVisibility({ resetSequence: true });

function positionGuideNearTarget(itemSelector, targetSelector, gap = 18) {
  const item = document.querySelector(itemSelector);
  const target = document.querySelector(targetSelector);
  if (!item || !target) return;

  const targetRect = target.getBoundingClientRect();
  const itemWidth = item.offsetWidth || 220;
  const left = Math.max(
    16,
    Math.min(
      window.innerWidth - itemWidth - 16,
      targetRect.left + targetRect.width / 2 - itemWidth / 2
    )
  );

  item.style.left = `${left}px`;
  item.style.top = `${targetRect.bottom + gap}px`;
}

function positionGuideTargets() {
  if (document.body.classList.contains("bmo-open")) {
    positionGuideNearTarget(".guide-headset", "#bmo-record");
    positionGuideNearTarget(".guide-ptt", "#bmo-ptt");
  } else {
    positionGuideNearTarget(".guide-headset", "#vera-record");
    positionGuideNearTarget(".guide-ptt", "#vera-ptt");
  }
}

window.addEventListener("resize", () => {
  scheduleAskRotatorLayoutSync();
  ["vera-guide", "bmo-guide"].forEach((id) => {
    const guide = document.getElementById(id);
    if (guide?.classList.contains("show")) positionGuideTargets();
  });
});

if (typeof ResizeObserver !== "undefined") {
  const askLayoutObserver = new ResizeObserver(() => {
    scheduleAskRotatorLayoutSync();
  });
  ["vera-voice-bar", "vera-keyboard-bar", "bmo-voice-bar", "bmo-keyboard-bar"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) askLayoutObserver.observe(el);
  });
}

document.addEventListener("click", () => {
  const bmo = document.body.classList.contains("bmo-open");
  const guide = document.getElementById(bmo ? "bmo-guide" : "vera-guide");
  const seenKey = bmo ? "bmo_seen_guide" : "vera_seen_guide";
  if (!guide) return;

  if (!guide.classList.contains("show")) return;

  guide.classList.remove("show");

  setTimeout(() => {
    guide.classList.add("hidden");
  }, 350);

  sessionStorage.setItem(seenKey, "true");
});

window.startBootSequence = startBootSequence;
void startBootSequence();
