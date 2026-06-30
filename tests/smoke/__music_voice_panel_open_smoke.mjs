/**
 * Smoke: voice built-in music play always opens the full Music panel surface.
 * Run: node tests/smoke/__music_voice_panel_open_smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

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

const layoutSrc = carve(APP_JS, "function getWorkModeLeftPaneLayout()", "function wireWorkModeLeftPaneLayout()");
const ensureSrc = carve(
  APP_JS,
  "function ensureMusicPanelOpenForVoicePlayback(reason = \"voice_music_play\")",
  "function logMusicRenderState(prefix, extra = {})"
);
const renderSrc = carve(APP_JS, "function renderProductivityPanel(opts = {})", "function toggleProductivityPanel()");

const sandbox = vm.createContext({
  console: { info() {}, warn() {}, error() {}, log() {} },
  document: {
    body: { classList: { add() {}, remove() {}, contains: () => false } },
    querySelectorAll: () => [],
    getElementById: (id) => sandbox.__ids.get(id) || null,
  },
  window: {
    layoutVeraWorkModePanelsCalls: 0,
    layoutVeraWorkModePanels(on) {
      sandbox.window.layoutVeraWorkModePanelsCalls += 1;
      if (on) {
        const pane = sandbox.__ids.get("vera-side-pane");
        const body = sandbox.__ids.get("vera-wm-music-body");
        if (pane && body) body.appendChild(pane);
      }
    },
    __veraMusicSourceState: {
      active: "none",
      builtin: { state: "idle", title: "", paused: true },
      spotify: { state: "idle", title: "", paused: true },
    },
  },
  localStorage: {
    _m: new Map(),
    getItem(k) {
      return this._m.get(k) ?? null;
    },
    setItem(k, v) {
      this._m.set(k, String(v));
    },
  },
  requestAnimationFrame(fn) {
    fn();
  },
  performance: { now: () => 1000 },
  setTimeout,
  clearTimeout,
  Number,
  String,
  Boolean,
  Math,
  Promise,
});

sandbox.__ids = new Map();
sandbox.__renderCalls = 0;

const sidePane = {
  id: "vera-side-pane",
  hidden: true,
  innerHTML: "",
  dataset: {},
  classList: {
    _c: new Set(),
    add(...xs) {
      xs.forEach((x) => this._c.add(x));
    },
    remove(...xs) {
      xs.forEach((x) => this._c.delete(x));
    },
    contains(x) {
      return this._c.has(x);
    },
  },
  parentElement: null,
};
const musicBody = { id: "vera-wm-music-body", appendChild(el) { el.parentElement = musicBody; } };
const wmLeft = { id: "vera-wm-left", dataset: { wmLeftLayout: "checklist-full" } };
const prodBtn = { id: "vera-productivity-mode", classList: { add() {}, remove() {} } };

sandbox.__ids.set("vera-side-pane", sidePane);
sandbox.__ids.set("vera-wm-music-body", musicBody);
sandbox.__ids.set("vera-wm-left", wmLeft);
sandbox.__ids.set("vera-productivity-mode", prodBtn);
sandbox.__ids.set("vera-app", { classList: { contains: (c) => c === "work-mode" } });

vm.runInContext(
  `
  const WORK_LEFT_PANES_LAYOUT_KEY = "vera_wm_left_panes_layout_v1";
  function appModePrefix() { return "vera"; }
  function uiEl(suffix) { return document.getElementById("vera-" + suffix); }
  function isVeraWorkModeOn() { return true; }
  function removeSpotifyMiniButton() {}
  function spotifyApplyViewMode() {}
  function restoreProductivityPanel(prefix) {
    const el = uiEl("side-pane");
    if (!el) return;
    el.hidden = false;
    el.dataset.sidePaneKind = "productivity";
    el.classList.add("visible");
  }
  function renderProductivityPanel(opts = {}) {
    globalThis.__renderCalls += 1;
    const el = uiEl("side-pane");
    el.hidden = false;
    el.dataset.sidePaneKind = "productivity";
    el.innerHTML = "<div data-productivity-root=vera></div>";
    el.classList.add("visible");
  }
  function getActivePlaybackSource() { return "none"; }
  function getProductivityMusicSource() { return "spotify"; }
  function getGlobalPlaybackState() { return { isPlaying: false, trackTitle: "" }; }
  function veraMusicSourceState() { return window.__veraMusicSourceState; }
  function safeSetLocalStorage(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  ${layoutSrc}
  ${ensureSrc}
  globalThis.__ensureMusicPanelOpenForVoicePlayback = ensureMusicPanelOpenForVoicePlayback;
  `,
  sandbox,
  { filename: "music-voice-panel-open-harness" }
);

console.log("\n== empty state — mounts productivity panel ==");
sidePane.hidden = true;
sidePane.innerHTML = "";
delete sidePane.dataset.sidePaneKind;
sidePane.classList._c.clear();
sandbox.__renderCalls = 0;
sandbox.__ensureMusicPanelOpenForVoicePlayback("voice_music_play");
ok(sandbox.__renderCalls === 1, "renderProductivityPanel called from empty state");
ok(sidePane.dataset.sidePaneKind === "productivity", "side pane marked productivity");
ok(sidePane.classList.contains("visible"), "side pane visible class set");

console.log("\n== work mode checklist-full — expands music body ==");
wmLeft.dataset.wmLeftLayout = "checklist-full";
try {
  sandbox.localStorage.setItem("vera_wm_left_panes_layout_v1", "checklist-full");
} catch (_) {}
sandbox.__ensureMusicPanelOpenForVoicePlayback("voice_music_play");
ok(wmLeft.dataset.wmLeftLayout === "split", "checklist-full → split so music body is shown");
ok(sandbox.window.layoutVeraWorkModePanelsCalls >= 1, "layoutVeraWorkModePanels(true) called");

console.log("\n" + "=".repeat(60));
console.log(`Total: ${pass + fail}   PASS=${pass}   FAIL=${fail}`);
if (fail) process.exit(1);
console.log("All music voice panel open smoke tests passed.");
