import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:3456/app/";
const browser = await chromium.launch();
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errs.push(`console: ${m.text()}`);
});
const failed = [];
page.on("response", (res) => {
  if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
});
page.on("requestfailed", (req) => {
  failed.push(`${req.url()} — ${req.failure()?.errorText}`);
});

await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
await page.waitForTimeout(8000);

const state = await page.evaluate(() => ({
  hasBgVideo: !!document.getElementById("bg-video"),
  bootActive: document.getElementById("boot-loader")?.classList.contains("active"),
  bootOpacity: getComputedStyle(document.getElementById("boot-loader")).opacity,
  veraHidden: document.getElementById("vera-app")?.hidden,
  micBar: !!document.getElementById("vera-voice-bar"),
  workBtn: !!document.getElementById("vera-work-mode"),
  settingsBtn: !!document.getElementById("vera-settings-open"),
  bodyClasses: document.body.className,
  startBoot: typeof window.startBootSequence,
}));

console.log(JSON.stringify({ url, state, errs, failed }, null, 2));
await browser.close();
