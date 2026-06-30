import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "index.html");
let h = fs.readFileSync(p, "utf8");
const startNeedle = "</section>\n<script>\n  /* =========================\n     DOM REFERENCES";
const endNeedle = '</script>\n</script>\n<div id="vera-user-sign-in-modal"';
const start = h.indexOf(startNeedle);
const end = h.indexOf(endNeedle);
if (start < 0 || end < 0) {
  console.error("markers not found", { start, end });
  process.exit(1);
}
const insertAt = h.indexOf("<script>", start);
h =
  h.slice(0, insertAt) +
  '<script src="shell.js?v=1"></script>\n' +
  h.slice(end + "</script>\n</script>\n".length);
fs.writeFileSync(p, h);
console.log("patched app/index.html");
