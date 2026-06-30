/**
 * Smoke: built-in / Spotify preview audio survives news panel renders and TTS
 * does not explicitly pause music. Provider exclusivity + explicit pause still work.
 *
 * Run: node tests/smoke/__music_survives_panel_tts_smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "app/app.js"), "utf8");
const NEWS_PANEL_JS = fs.readFileSync(path.join(ROOT, "news", "newsPanel.js"), "utf8");

let pass = 0;
let fail = 0;
function ok(cond, name, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  OK  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function carve(src, start, end) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`start marker not found: ${start}`);
  const j = src.indexOf(end, i);
  if (j < 0) throw new Error(`end marker not found: ${end}`);
  return src.slice(i, j);
}

class FakeAudio {
  constructor(id) {
    this.id = id;
    this.tagName = "AUDIO";
    this.paused = true;
    this.ended = false;
    this.src = "";
    this.currentTime = 0;
    this.volume = 1;
    this.hidden = true;
    this.dataset = {};
    this.parentElement = null;
    this.isConnected = true;
    this.readyState = 0;
    this._pauseCalls = 0;
    this._playCalls = 0;
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  pause() {
    this._pauseCalls += 1;
    this.paused = true;
  }
  play() {
    this._playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
  removeAttribute() {}
  load() {}
  addEventListener() {}
}

function buildDomSandbox() {
  const allElements = [];
  const bodyClassList = {
    _classes: new Set(),
    add(c) { this._classes.add(c); },
    remove(c) { this._classes.delete(c); },
    contains(c) { return this._classes.has(c); },
  };
  const body = {
    _classes: new Set(),
    appendChild(el) { el.parentElement = body; },
    classList: bodyClassList,
  };
  const veraMain = { appendChild(el) { el.parentElement = veraMain; allElements.push(el); } };
  const doc = {
    body,
    querySelector(sel) {
      if (sel === "main.chat-centered") return veraMain;
      if (sel === "main.bmo-shell") return null;
      return null;
    },
    querySelectorAll() { return []; },
    createElement(tag) {
      if (tag === "audio") {
        const el = new FakeAudio("");
        allElements.push(el);
        return el;
      }
      if (tag === "div") {
        const el = {
          id: "",
          className: "",
          hidden: false,
          children: [],
          appendChild(c) {
            c.parentElement = el;
            el.children.push(c);
          },
          setAttribute(k, v) {
            if (k === "aria-hidden") return;
            el[k] = v;
          },
          parentElement: null,
        };
        allElements.push(el);
        return el;
      }
      return {};
    },
    getElementById(id) {
      return allElements.find((e) => e.id === id) || null;
    },
  };

  const win = {
    isSecureContext: true,
    setTimeout,
    clearTimeout,
    __veraSpotifyNowState: { active: false, paused: true, title: "" },
    __veraSpotifyPlaybackActive: false,
    __veraFreeMusicPlayback: { queue: [{ name: "lofi" }], index: 0, mode: "playlist" },
    VeraSpotify: {
      pausePlayback: async function pausePlayback() {
        win._spotifyPauseCalls = (win._spotifyPauseCalls || 0) + 1;
        win.__veraSpotifyPlaybackActive = false;
        win.__veraSpotifyNowState = { ...win.__veraSpotifyNowState, paused: true, active: false };
      },
    },
  };

  const sandbox = vm.createContext({
    console: { info() {}, warn() {}, error() {}, log() {} },
    window: win,
    document: doc,
    performance: { now: () => 1000 },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => fn(),
    Number,
    Math,
    Promise,
  });
  doc.body = body;
  sandbox.document = doc;
  sandbox.globalThis = sandbox;
  sandbox.window = win;

  const hostSrc = carve(
    APP_JS,
    "function ensurePersistentMusicAudioHost(prefix)",
    "function musicPlaybackDiagSnapshot(prefix)"
  );
  const diagSrc = carve(APP_JS, "function musicPlaybackDiagSnapshot(prefix)", "function initPersistentMusicAudioHosts()");

  const playbackHelpers = carve(
    APP_JS,
    "function getActivePlaybackSource(prefix)",
    "async function ensureSingleActiveMusicProvider(targetProvider, opts = {})"
  );

  const pauseHelpers = carve(
    APP_JS,
    "async function pauseSpotifyLayersForBuiltin(prefix, opts = {})",
    "/* PART 6 — call this BEFORE starting any Spotify playback"
  );

  const stopBuiltin = carve(APP_JS, "function stopBuiltinFreeMusic(prefix)", "async function pauseSpotifyLayersForBuiltin");

  const exclusiveStart = APP_JS.indexOf("async function ensureSingleActiveMusicProvider(targetProvider, opts = {})");
  const exclusiveEnd = APP_JS.indexOf("function resolveMusicTransportProvider(prefix, seqCtx = {})");
  const exclusiveSrc = APP_JS.slice(exclusiveStart, exclusiveEnd);

  vm.runInContext(
    `
    function appModePrefix() { return "vera"; }
    function veraMusicSourceState() {
      if (!window.__veraMusicSourceState) {
        window.__veraMusicSourceState = {
          active: "builtin",
          builtin: { state: "playing", paused: false },
          spotify: { state: "idle", paused: true },
        };
      }
      return window.__veraMusicSourceState;
    }
    function isBuiltinMusicAudiblyPlaying(prefix) {
      const a = document.getElementById((prefix || "vera") + "-free-music-audio");
      return Boolean(a && a.src && !a.paused && a.currentTime > 0);
    }
    function isSpotifyMusicAudiblyPlaying() {
      return window.__veraSpotifyPlaybackActive === true;
    }
    function spotifyGetVolume() { return 0.1; }
    function freeMusicSyncNowFromAudio() {}
    function spotifySyncPlayButtonUi() {}
    function stopCurrentMusicPlaybackBeforeNewPlay() {}
    function waitUntilMusicProviderExclusive() { return Promise.resolve({ ok: true }); }
    function _veraSpotifyAcquirePlayback() {}
    function logMusicPlaybackDebug() {}
    ${hostSrc}
    ${diagSrc}
    ${playbackHelpers}
    ${pauseHelpers}
    ${stopBuiltin}
    ${exclusiveSrc}
    globalThis.__exp = {
      ensurePersistentMusicAudioHost,
      musicPlaybackDiag,
      getActivePlaybackSource,
      pauseSpotifyLayersForBuiltin,
      stopBuiltinFreeMusic,
      ensureSingleActiveMusicProvider,
    };
    `,
    sandbox,
    { filename: "music-survives-harness" }
  );

  vm.runInContext(
    `
    function uiEl() {
      return globalThis.__sidePane;
    }
    function escapeHtml(s) {
      return String(s ?? "");
    }
    function runFlowModeSidePaneContentCrossfade(_el, fn) { fn(); }
    function requestAnimationFrame(fn) { fn(); }
    function isVeraInterruptDebugEnabled() { return false; }
    function logVeraInterruptDebug() {}
    function appModePrefix() { return "vera"; }
    ${NEWS_PANEL_JS}
    globalThis.__news = { renderMediaTabsPanel };
    `,
    sandbox,
    { filename: "news-panel-harness" }
  );

  return sandbox;
}

console.log("\n== persistent audio host ==");
const sb = buildDomSandbox();
const exp = sb.__exp;

exp.ensurePersistentMusicAudioHost("vera");
const host = sb.document.getElementById("vera-persistent-music-audio-host");
const builtin = sb.document.getElementById("vera-free-music-audio");
const preview = sb.document.getElementById("vera-spotify-preview-audio");
ok(Boolean(host), "persistent host created");
ok(Boolean(builtin), "builtin audio created in host");
ok(Boolean(preview), "spotify preview audio created in host");
ok(builtin.parentElement === host, "builtin audio parent is persistent host");

console.log("\n== builtin survives news panel innerHTML ==");
builtin.src = "https://example.com/lofi.mp3";
builtin.paused = false;
builtin.currentTime = 12;
const sidePane = {
  hidden: false,
  dataset: {},
  innerHTML: "",
  scrollTop: 0,
  classList: { add() {}, remove() {} },
};
sb.globalThis.__sidePane = sidePane;
const pauseBefore = builtin._pauseCalls;
sb.__news.renderMediaTabsPanel({
  panel_type: "news_results",
  title: "News Results",
  query: "headlines",
  news_results: [{ title: "Story", url: "https://example.com" }],
});
ok(sb.document.getElementById("vera-free-music-audio") === builtin, "same builtin node after news render");
ok(builtin.parentElement?.id === "vera-persistent-music-audio-host", "builtin still in persistent host");
ok(!builtin.paused, "builtin still playing after news render");
ok(builtin._pauseCalls === pauseBefore, "news render did not call builtin.pause");

console.log("\n== explicit pause music ==");
if (!sb.window.__veraMusicSourceState) {
  sb.window.__veraMusicSourceState = {
    active: "builtin",
    builtin: { state: "playing", paused: false },
    spotify: { state: "idle", paused: true },
  };
}
sb.window.__veraMusicSourceState.active = "builtin";
builtin.paused = false;
sb.globalThis.musicPlaybackDiag = exp.musicPlaybackDiag;
const logs = [];
sb.console.info = (tag, payload) => logs.push({ tag, payload });
exp.musicPlaybackDiag("[music_pause_called]", { reason: "test", source: "smoke" });
ok(logs.some((l) => l.tag === "[music_pause_called]"), "music_pause_called log shape");
builtin.pause();
ok(builtin._pauseCalls > pauseBefore, "explicit pause still pauses builtin");

console.log("\n== provider switch spotify -> builtin ==");
builtin.paused = false;
builtin.currentTime = 5;
builtin.src = "https://example.com/lofi.mp3";
sb.window.__veraSpotifyPlaybackActive = true;
sb.window.__veraMusicSourceState = {
  active: "spotify",
  builtin: { state: "suspended_for_spotify", paused: true },
  spotify: { state: "playing", paused: false },
};
sb.window._spotifyPauseCalls = 0;
await exp.ensureSingleActiveMusicProvider("builtin", { reason: "play_builtin", prefix: "vera" });
ok(sb.window._spotifyPauseCalls >= 1, "switching to builtin pauses Spotify");

console.log("\n== provider switch builtin -> spotify ==");
builtin.paused = false;
builtin.currentTime = 8;
sb.window.__veraMusicSourceState = {
  active: "builtin",
  builtin: { state: "playing", paused: false },
  spotify: { state: "idle", paused: true },
};
const builtinPausesBefore = builtin._pauseCalls;
await exp.ensureSingleActiveMusicProvider("spotify", { reason: "play_track", prefix: "vera" });
ok(builtin._pauseCalls > builtinPausesBefore, "switching to spotify pauses builtin");

console.log("\n== TTS does not call music pause helpers ==");
builtin.paused = false;
builtin.currentTime = 3;
const spotifyBeforeTts = sb.window._spotifyPauseCalls || 0;
const builtinBeforeTts = builtin._pauseCalls;
// Simulate TTS start/end diagnostics only — no music pause side effects.
exp.musicPlaybackDiag("[music_state_before_tts]", { source: "smoke_tts" });
exp.musicPlaybackDiag("[tts_audio_start]", { source: "smoke_tts", tts_chunk_index: 0 });
exp.musicPlaybackDiag("[tts_audio_end]", { source: "smoke_tts" });
exp.musicPlaybackDiag("[music_state_after_tts]", { source: "smoke_tts" });
ok(sb.window._spotifyPauseCalls === spotifyBeforeTts, "TTS diag did not call Spotify pause");
ok(builtin._pauseCalls === builtinBeforeTts, "TTS diag did not call builtin pause");
ok(!builtin.paused, "builtin still playing after TTS diag sequence");

console.log(`\n== summary ==\n\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
