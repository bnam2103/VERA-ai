/**
 * Move landing-only CSS from styles.css to product.css (production branch).
 * product.css is only linked from root index.html — /app/ never loads it.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const stylesPath = path.join(root, "styles.css");
const productPath = path.join(root, "product.css");

const lines = fs.readFileSync(stylesPath, "utf8").split(/\r?\n/);

const moveRanges = [
  [22, 24],
  [37, 40],
  [98, 179],
  [260, 271],
  [299, 412],
  [413, 1586],
];

function inMoveRange(n) {
  return moveRanges.some(([a, b]) => n >= a && n <= b);
}

const kept = [];
const extracted = [];

for (let i = 0; i < lines.length; i++) {
  (inMoveRange(i + 1) ? extracted : kept).push(lines[i]);
}

const header = `/* =============================================================================
 * product.css — workwithvera.com landing page only (https://workwithvera.com/)
 * Loaded from root index.html after styles.css. NOT linked from app/index.html.
 * Edit this file on the production branch for product landing redesigns.
 * App UI (/app/) uses ../styles.css only.
 * ============================================================================= */

`;

const productCss =
  header +
  extracted.join("\n") +
  "\n";

const bridge = `/* Landing page styles moved to product.css (production index.html only). */

`;

let keptText = kept.join("\n");
const anchor = "body.vera-app-route #bg-video";
const idx = keptText.indexOf(anchor);
if (idx !== -1) {
  keptText = keptText.slice(0, idx) + bridge + keptText.slice(idx);
}

fs.writeFileSync(productPath, productCss);
fs.writeFileSync(stylesPath, keptText);
console.log("product.css:", extracted.length, "lines");
console.log("styles.css updated");
