/**
 * Split original combined index.html into root landing + app/index.html.
 * Source: scripts/_combined-source.html (from git HEAD:index.html).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = path.join(root, "scripts", "_combined-source.html");
const lines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/);

function slice(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

function joinSlices(ranges) {
  return ranges.map(([a, b]) => slice(a, b)).join("\n");
}

function toAppPaths(html) {
  return html
    .replaceAll('href="styles.css', 'href="../styles.css')
    .replaceAll('src="utils/', 'src="../utils/')
    .replaceAll('src="users/', 'src="../users/')
    .replaceAll('src="voice/', 'src="../voice/')
    .replaceAll('src="workmode/', 'src="../workmode/')
    .replaceAll('src="news/', 'src="../news/')
    .replaceAll('src="debug/', 'src="../debug/')
    .replaceAll('src="app.js', 'src="app.js')
    .replaceAll('src="background.mp4"', 'src="../background.mp4"')
    .replaceAll('src="VERA_commercial_2.mp4"', 'src="../VERA_commercial_2.mp4"')
    .replaceAll('poster="vera_poster.jpg"', 'poster="../vera_poster.jpg"')
    .replaceAll('src="background-music.mp3"', 'src="../background-music.mp3"')
    .replaceAll('src="me.jpg"', 'src="../me.jpg"')
    .replace(
      'window.VERA_LOCAL_BACKEND_ORIGIN = "https://vera-api.vera-api-ned.workers.dev"',
      'window.VERA_LOCAL_BACKEND_ORIGIN = (window.VERA_API_PRODUCTION_BASE || "https://api.workwithvera.com")'
    );
}

// --- Landing ---
const landingTop = joinSlices([[15, 55], [69, 71]]);
const landingHome = slice(75, 618);

let landingScript = joinSlices([
  [1292, 1638],
  [1643, 1841],
  [2036, 2180],
]);

landingScript = landingScript.replace(
  /heroLabel\?\.addEventListener\("click", unlockAudio\);/,
  `heroLabel?.addEventListener("click", unlockAudio);
launchVeraHomeBtn?.addEventListener("click", async () => {
  await unlockAudio();
  window.location.href = "app/";
});`
);

const landingHtml = `${slice(1, 14)}
${landingTop}
${landingHome}
<script>
${landingScript}
</script>
</body>
</html>
`;

// --- App ---
// Skip trailer overlay (lines 29–55); /app/ boots directly into Vera UI.
const appTop = toAppPaths(joinSlices([[15, 28], [56, 71]]));
const appShell = toAppPaths(slice(623, 1286));
const appModals = slice(2711, 2999);

let appInline = slice(1292, 2709);

appInline = appInline.replace(
  /const intro = document\.getElementById\("intro"\);[\s\S]*?const disclaimer = document\.querySelector\("\.intro-disclaimer"\);\n\n/,
  ""
);

appInline = appInline.replace(
  /\/\* =========================[\s\S]*?INTRO LOGIC \(FINAL\)[\s\S]*?if \(sessionStorage\.getItem\(INTRO_SEEN_KEY\)\) \{[\s\S]*?setTimeout\(\(\) => \{ void startBootSequence\(\); \}, 60\);\s*\}\n\n/,
  ""
);

appInline = appInline.replace(
  /launchVeraHomeBtn\?\.addEventListener\("click", async \(\) => \{\s*await unlockAudio\(\);\s*startBootSequence\(\);\s*\}\);/,
  ""
);

appInline = appInline.replace(/\s*home\.hidden = true;\n/g, "\n");

appInline = appInline.replace(
  /function showHomeLanding\(options = \{\}\) \{[\s\S]*?syncMusicToggleState\(\);\s*\}/,
  `function showHomeLanding() {
  window.location.href = "../";
}`
);

appInline = appInline.replace(
  /function goHomeFromApp\(\) \{[\s\S]*?syncMusicToggleState\(\);\s*\}/,
  `function goHomeFromApp() {
  window.location.href = "../";
}`
);

appInline = appInline.replace(
  /observer\.observe\(aboutVeraSection\)/,
  "if (aboutVeraSection) observer.observe(aboutVeraSection)"
);

// Landing-only use-case panel wiring (elements absent on /app/)
appInline = appInline.replace(
  /\/\* =========================\s*MOBILE NAV LOGIC[\s\S]*?patchVersions\.forEach\(details => \{[\s\S]*?\}\);\n/,
  ""
);

appInline = appInline.replace(
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

appInline = appInline.replace(
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

let appScripts = slice(3001, 3232);
appScripts = toAppPaths(appScripts);
appScripts = appScripts.replace(
  '<script>\n(function () {',
  '<script src="../config/api.js?v=1"></script>\n<script>\n(function () {'
);
appScripts = appScripts.replace(
  /\(function veraBootScriptsLoadedProbe\(\) \{[\s\S]*?\}\)\(\);\s*<\/script>/,
  `(function veraBootScriptsLoadedProbe() {
  const missing = ["checkServer", "getSessionId", "authApiUrl"].filter(
    (name) => typeof window[name] !== "function"
  );
  if (missing.length) {
    console.error("[boot] scripts loaded with missing globals:", missing.join(", "));
  } else {
    console.info("[boot] scripts loaded");
  }
})();
(function veraAppDirectBoot() {
  if (typeof startBootSequence !== "function") {
    console.error("[boot] startBootSequence missing — inline app shell did not load");
    return;
  }
  void startBootSequence();
})();
</script>`
);

const appHtml = `${toAppPaths(slice(1, 14))}
${appTop}
${appShell}
<script>
${appInline}
</script>
${appModals}
${appScripts}
</body>
</html>
`;

fs.writeFileSync(path.join(root, "index.html"), landingHtml);
fs.writeFileSync(path.join(root, "app", "index.html"), appHtml);
console.log("Split complete: index.html (landing) + app/index.html (vera app)");
