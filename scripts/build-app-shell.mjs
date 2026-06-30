import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = execSync("git show HEAD:index.html", { encoding: "utf8", cwd: root });
const lines = src.split(/\r?\n/);
const slice = (a, b) => lines.slice(a - 1, b).join("\n");

const parts = [
  slice(1296, 1312),
  slice(1337, 1371),
  slice(1801, 2030),
  slice(2032, 2035),
  slice(2195, 2351),
  slice(2367, 2426),
  slice(2428, 2708),
];

let js = parts.join("\n\n");

js = js.replace(/\n  const home = document\.getElementById\("home"\);\n/, "\n");
js = js.replace(
  /\n  const navHome[\s\S]*?const typedEl = document\.getElementById\("typed-text"\);\n\n/,
  "\n"
);
js = js.replace(/\n  const bgVideo = document\.getElementById\("bg-video"\);\n\n/, "\n");
js = js.replace(/\n  const bgMusic = document\.getElementById\("bg-music"\);/, "");

js = js.replace(
  /  try \{\s*bgMusic\.pause\(\);[\s\S]*?syncMusicToggleState\(\);\n/,
  ""
);

js = js.replace(
  /document\.getElementById\("return-home-vera"\)\.onclick = async \(\) => \{[\s\S]*?goHomeFromApp\(\);\s*\}, 600\);\s*\};/,
  `document.getElementById("return-home-vera")?.addEventListener("click", async () => {
  exitVeraWorkMode();
  pauseMusicPanelOnNavAway("vera_to_home");
  if (typeof window.resetVoiceUiToIdle === "function") {
    window.resetVoiceUiToIdle();
  }
  try {
    window.veraUsageSyncModeFromDom?.({
      trigger: "ui",
      source: "vera_return_home",
      to: "home",
    });
  } catch (_) {}
  window.location.href = "../";
});`
);

js = js.replace(
  /function goHomeFromApp\(\) \{[\s\S]*?syncMusicToggleState\(\);\s*\}/,
  `function goHomeFromApp() {
  window.location.href = "../";
}`
);

js = js.replace(
  /function closeBmoPage\(\) \{[\s\S]*?home\.classList\.add\("fade-in"\);\s*\}\);\s*\}, 450\);\s*\}/,
  `function closeBmoPage() {
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
  }`
);

js = js.replace(/\s*home\.hidden = true;\n/g, "\n");

js = js.replace(
  "let hitStarting = false;\nlet appRevealed = false;",
  "let hitStarting = false;\nlet appRevealed = false;\nlet offlineBootPolls = 0;"
);

js = js.replace(
  /if \(state === "offline"\) \{\s*hitStarting = false;\s*setProgress\(0\);\s*return;\s*\}/,
  `if (state === "offline") {
    hitStarting = false;
    offlineBootPolls += 1;
    setProgress(Math.min(offlineBootPolls * 12, 48));
    if (offlineBootPolls >= 3 && !appRevealed) {
      scheduleBootReveal();
    }
    return;
  }
  offlineBootPolls = 0;`
);

const header = `/* Vera /app/ shell — boot, work mode, BMO nav, ask rotator. No landing/trailer logic. */\n`;
fs.writeFileSync(path.join(root, "app", "shell.js"), header + js.trim() + "\n");
console.log("wrote app/shell.js");
