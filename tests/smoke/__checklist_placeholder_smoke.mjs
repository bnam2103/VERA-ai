/**
 * Smoke: checklist placeholder rows are UI-only and excluded from persistence.
 * Run: node tests/smoke/__checklist_placeholder_smoke.mjs
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK  ${msg}`);
  } else {
    failed += 1;
    console.log(` FAIL ${msg}`);
  }
}

const storage = new Map();
const sandbox = {
  console,
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  document: {
    getElementById: () => null,
    querySelector: () => null,
  },
  window: {},
};
sandbox.window = sandbox;

vm.createContext(sandbox);

const helperSrc = `
const WORK_CHECKLIST_STORAGE_KEY = "vera_wm_checklist_v1";
const WORK_CHECKLIST_PLACEHOLDER_LABEL = "List item";
const WORK_CHECKLIST_UI_PLACEHOLDER_ID = "__vera_wm_checklist_placeholder__";
function normalizeChecklistRowText(text) {
  return String(text || "").replace(/\\r/g, " ").replace(/\\n/g, " ").trim();
}
function isChecklistPlaceholderLabel(text) {
  return normalizeChecklistRowText(text).toLowerCase() === WORK_CHECKLIST_PLACEHOLDER_LABEL.toLowerCase();
}
function isChecklistPlaceholderItem(item) {
  if (!item || typeof item.text !== "string") return true;
  const text = normalizeChecklistRowText(item.text);
  if (!text) return true;
  if (!Boolean(item.done) && isChecklistPlaceholderLabel(text)) return true;
  return false;
}
function stripChecklistPlaceholdersForPersist(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (row) =>
      row &&
      typeof row.text === "string" &&
      String(row.id || "") !== WORK_CHECKLIST_UI_PLACEHOLDER_ID &&
      !isChecklistPlaceholderItem(row)
  );
}
function _persistChecklistItemsToStorage(items) {
  const stripped = stripChecklistPlaceholdersForPersist(items);
  localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, JSON.stringify(stripped));
  return stripped;
}
function readChecklistItemsFromStorage() {
  try {
    const raw = localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY) || "[]";
    const parsed = JSON.parse(raw);
    return stripChecklistPlaceholdersForPersist(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}
`;

vm.runInContext(helperSrc, sandbox);

const items = [
  { id: "a", text: "A", done: false },
  { id: "p1", text: "", done: false },
  { id: "c", text: "C", done: false },
  { id: "p2", text: "List item", done: false },
];

const stripped = vm.runInContext(`stripChecklistPlaceholdersForPersist(${JSON.stringify(items)})`, sandbox);
ok(stripped.length === 2, "strip removes empty and placeholder-label rows");
ok(stripped.map((x) => x.text).join(",") === "A,C", "strip keeps real items only");

vm.runInContext(`_persistChecklistItemsToStorage(${JSON.stringify(items)})`, sandbox);
const stored = JSON.parse(storage.get("vera_wm_checklist_v1"));
ok(stored.length === 2, "localStorage excludes placeholder rows");
ok(!stored.some((x) => !String(x.text || "").trim()), "localStorage has no empty text rows");

const readBack = vm.runInContext(`readChecklistItemsFromStorage()`, sandbox);
ok(readBack.length === 2, "readChecklistItemsFromStorage returns real items only");

console.log(`\n${"=".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed) process.exit(1);
