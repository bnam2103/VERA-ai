import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("app/index.html", "utf8");
const checks = [
  ["no bg-video", !html.includes('id="bg-video"')],
  ["no bg-music", !html.includes('id="bg-music"')],
  ["has shell.js", html.includes("shell.js")],
  ["has vera-app", html.includes('id="vera-app"')],
  ["has boot-loader", html.includes('id="boot-loader"')],
  ["has veraAppDirectBoot", html.includes("startBootSequence")],
  ["no inline landing nav", !html.includes('id="nav-home"')],
];
for (const [name, ok] of checks) {
  console.log(ok ? "OK" : "FAIL", name);
}

const dom = {
  hidden: true,
  classList: {
    add() {},
    remove() {},
    contains() {
      return false;
    },
    toggle() {},
  },
  style: {},
  setAttribute() {},
};

const sandbox = {
  document: {
    getElementById(id) {
      const nodes = {
        "boot-loader": {
          classList: { contains: () => false, add() {}, remove() {} },
          ...dom,
        },
        "boot-bar": { style: {} },
        "boot-percent": { textContent: "" },
        "vera-app": { ...dom, hidden: true },
        "bmo-page": { ...dom, hidden: true },
        "bmo-loading-screen": { ...dom, hidden: true },
        "vera-work-mode": { setAttribute() {} },
        "return-home-vera": { addEventListener() {} },
        "return-home": { onclick: null },
        "open-bmo-from-vera": { addEventListener() {} },
        "vera-ask-rotator": {
          textContent: "",
          classList: dom.classList,
          closest: () => null,
        },
        "bmo-ask-rotator": {
          textContent: "",
          classList: dom.classList,
          closest: () => null,
        },
      };
      return nodes[id] || null;
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
  },
  window: {},
  console,
  setTimeout(fn) {
    fn();
    return 0;
  },
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame(fn) {
    fn();
  },
  getComputedStyle: () => ({
    animationDuration: "0s",
    animationDelay: "0s",
    transitionDuration: "0s",
    transitionDelay: "0s",
  }),
  matchMedia: () => ({ matches: false }),
  location: { href: "" },
  sessionStorage: { getItem: () => null, setItem() {} },
  ResizeObserver: class {
    observe() {}
  },
};
sandbox.window = sandbox;

vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync("app/shell.js", "utf8"), sandbox);
  console.log("OK shell.js loads in vm");
  console.log(
    "OK startBootSequence",
    typeof sandbox.startBootSequence === "function"
  );
  if (typeof sandbox.startBootSequence === "function") {
    await sandbox.startBootSequence();
    console.log("OK startBootSequence ran without throw");
  }
} catch (e) {
  console.error("FAIL shell.js runtime", e);
  process.exit(1);
}
