/* ============================================================================
 * __checklist_checkbox_cascade_smoke.mjs
 *
 * Acceptance smoke for the 2026-06-01 checkbox-cascade patch in
 * workmode/checklist.js. When the user manually clicks the checkbox for a
 * TOP-LEVEL checklist item, the parent AND every descendant must toggle in
 * lockstep. Sub-item clicks must remain single-row so a user can complete
 * a single substep without losing the rest.
 *
 * Acceptance tests:
 *   1. Top-level + sub-items: check parent → parent and all sub-items become done.
 *   2. Top-level + sub-items: uncheck parent → parent and all sub-items become not-done.
 *   3. Sub-item click toggles only that sub-item.
 *   4. Top-level item with no sub-items toggles normally.
 *   5. Voice/text command path (persistWorkChecklistToggle) stays single-row.
 *
 * Run:  node tests/smoke/__checklist_checkbox_cascade_smoke.mjs
 * ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const utilsStoragePath = path.join(repoRoot, "utils", "storage.js");
const checklistPath = path.join(repoRoot, "workmode", "checklist.js");
const appJsPath = path.join(repoRoot, "app.js");

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
}
function section(t) { console.log(`\n── ${t} ──`); }

function makeMemoryStorage() {
  const bag = new Map();
  return {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => bag.set(k, String(v)),
    removeItem: (k) => bag.delete(k),
    clear: () => bag.clear(),
  };
}

function buildSandbox() {
  const cConsole = { log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
  const win = {
    isSecureContext: true,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    matchMedia: () => ({ matches: false }),
  };
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ classList: { add() {}, remove() {} }, dataset: {}, style: {}, appendChild() {}, setAttribute() {}, replaceChildren() {} }),
  };
  const sandbox = vm.createContext({
    console: cConsole,
    window: win,
    document: doc,
    localStorage: makeMemoryStorage(),
    sessionStorage: makeMemoryStorage(),
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    HTMLElement: class HTMLElement {},
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    HTMLButtonElement: class HTMLButtonElement {},
    AbortController,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    CSS: { escape: (s) => String(s).replace(/["\\]/g, "") },
  });
  sandbox.globalThis = sandbox;
  for (const k of Object.keys(win)) sandbox[k] = win[k];

  vm.runInContext(fs.readFileSync(utilsStoragePath, "utf8"), sandbox, { filename: "utils/storage.js" });
  vm.runInContext(`
    function getSessionId() { return "smoke"; }
    function authApiUrl(p) { return "https://example.invalid" + p; }
    function appModePrefix() { return "vera"; }
    function isVeraWorkModeOn() { return true; }
    function getActiveDomReasoningLaneId() { return ""; }
    function getReasoningPanelElementByLaneId() { return null; }
    function getActiveReasoningScrollEl() { return null; }
    function getWorkModeLaneTitle() { return ""; }
    function getWorkModeReasoningLaneId() { return ""; }
    function getReasoningTabTopicLabel() { return ""; }
    function getActiveReasoningLaneIndex() { return null; }
    function workModePlanningTimeInjectionPrefix() { return ""; }
    var workModeReasoningPanelGenerationState = new Map();
    var workModeReasoningLastSyncableMarkdownByLane = new Map();
  `, sandbox, { filename: "stub.js" });
  vm.runInContext(fs.readFileSync(checklistPath, "utf8"), sandbox, { filename: "workmode/checklist.js" });
  return sandbox;
}

function seedItems(sandbox, items) {
  vm.runInContext(
    `localStorage.setItem(WORK_CHECKLIST_STORAGE_KEY, ${JSON.stringify(JSON.stringify(items))});`,
    sandbox
  );
}
function readItems(sandbox) {
  return JSON.parse(vm.runInContext(`localStorage.getItem(WORK_CHECKLIST_STORAGE_KEY)`, sandbox) || "[]");
}
function call(sandbox, expr) {
  return vm.runInContext(expr, sandbox);
}

// ────────────────────────────────────────────────────────────────────────────
// Suite A — function presence
// ────────────────────────────────────────────────────────────────────────────
section("Suite A — persistWorkChecklistToggleWithSubtree is exported");
const sb0 = buildSandbox();
ok(call(sb0, `typeof persistWorkChecklistToggleWithSubtree`) === "function",
   "persistWorkChecklistToggleWithSubtree is a function");
ok(call(sb0, `typeof persistWorkChecklistToggle`) === "function",
   "persistWorkChecklistToggle (single-row, untouched) still a function");

// ────────────────────────────────────────────────────────────────────────────
// Suite B — Acceptance 1: clicking top-level checks parent + descendants
// ────────────────────────────────────────────────────────────────────────────
section("Suite B — AT-1: top-level click cascades to all sub-items");
const sb1 = buildSandbox();
seedItems(sb1, [
  { id: "p1", text: "Apply to internships", done: false, parent_id: null },
  { id: "c1a", text: "update resume",       done: false, parent_id: "p1" },
  { id: "c1b", text: "write cover letter",   done: false, parent_id: "p1" },
  { id: "c1c", text: "submit application",   done: false, parent_id: "p1" },
  { id: "p2", text: "Buy groceries",         done: false, parent_id: null },
]);
call(sb1, `persistWorkChecklistToggleWithSubtree("p1", true)`);
let items1 = readItems(sb1);
const byId1 = Object.fromEntries(items1.map((x) => [x.id, x]));
ok(byId1.p1.done === true, "parent 'p1' is done");
ok(byId1.c1a.done === true, "sub 'update resume' is done");
ok(byId1.c1b.done === true, "sub 'write cover letter' is done");
ok(byId1.c1c.done === true, "sub 'submit application' is done");
ok(byId1.p2.done === false, "unrelated parent 'p2' (Buy groceries) untouched");

// ────────────────────────────────────────────────────────────────────────────
// Suite C — Acceptance 2: unchecking top-level cascades back to false
// ────────────────────────────────────────────────────────────────────────────
section("Suite C — AT-2: unchecking the top-level cascades to all sub-items");
call(sb1, `persistWorkChecklistToggleWithSubtree("p1", false)`);
let items2 = readItems(sb1);
const byId2 = Object.fromEntries(items2.map((x) => [x.id, x]));
ok(byId2.p1.done === false, "parent 'p1' is un-done");
ok(byId2.c1a.done === false, "sub 'update resume' is un-done");
ok(byId2.c1b.done === false, "sub 'write cover letter' is un-done");
ok(byId2.c1c.done === false, "sub 'submit application' is un-done");
ok(byId2.p2.done === false, "unrelated parent 'p2' (Buy groceries) untouched");

// ────────────────────────────────────────────────────────────────────────────
// Suite D — Acceptance 3: clicking a sub-item only changes that sub-item
// ────────────────────────────────────────────────────────────────────────────
section("Suite D — AT-3: sub-item click only toggles that sub-item");
const sb3 = buildSandbox();
seedItems(sb3, [
  { id: "p1", text: "Apply to internships", done: false, parent_id: null },
  { id: "c1a", text: "update resume",       done: false, parent_id: "p1" },
  { id: "c1b", text: "write cover letter",   done: false, parent_id: "p1" },
  { id: "c1c", text: "submit application",   done: false, parent_id: "p1" },
]);
call(sb3, `persistWorkChecklistToggleWithSubtree("c1b", true)`);
let items3 = readItems(sb3);
const byId3 = Object.fromEntries(items3.map((x) => [x.id, x]));
ok(byId3.p1.done === false, "parent 'p1' stays un-done when a sub-item is checked");
ok(byId3.c1a.done === false, "sibling 'update resume' stays un-done");
ok(byId3.c1b.done === true,  "clicked sub-item 'write cover letter' is done");
ok(byId3.c1c.done === false, "sibling 'submit application' stays un-done");

// Sub-item uncheck stays single-row too.
call(sb3, `persistWorkChecklistToggleWithSubtree("c1b", false)`);
let items3b = readItems(sb3);
const byId3b = Object.fromEntries(items3b.map((x) => [x.id, x]));
ok(byId3b.c1b.done === false, "sub-item uncheck reverts only that sub-item");
ok(byId3b.p1.done === false && byId3b.c1a.done === false && byId3b.c1c.done === false,
   "sub-item uncheck does not touch parent/siblings");

// ────────────────────────────────────────────────────────────────────────────
// Suite E — Acceptance 4: top-level item with no children still toggles
// ────────────────────────────────────────────────────────────────────────────
section("Suite E — AT-4: top-level without sub-items still toggles normally");
const sb4 = buildSandbox();
seedItems(sb4, [
  { id: "p2", text: "Buy groceries", done: false, parent_id: null },
]);
call(sb4, `persistWorkChecklistToggleWithSubtree("p2", true)`);
let items4 = readItems(sb4);
ok(items4[0].done === true, "single top-level item toggles to done");
call(sb4, `persistWorkChecklistToggleWithSubtree("p2", false)`);
let items4b = readItems(sb4);
ok(items4b[0].done === false, "single top-level item toggles back to un-done");

// ────────────────────────────────────────────────────────────────────────────
// Suite F — Acceptance 5: voice/text path (persistWorkChecklistToggle) stays
//            single-row, so the earlier subtree complete/remove patch (which
//            cascades inside the backend executor before persisting) remains
//            the source of truth for voice commands.
// ────────────────────────────────────────────────────────────────────────────
section("Suite F — AT-5: persistWorkChecklistToggle (voice/text path) is single-row");
const sb5 = buildSandbox();
seedItems(sb5, [
  { id: "p1", text: "Apply to internships", done: false, parent_id: null },
  { id: "c1a", text: "update resume",       done: false, parent_id: "p1" },
  { id: "c1b", text: "write cover letter",   done: false, parent_id: "p1" },
]);
call(sb5, `persistWorkChecklistToggle("p1", true)`);
let items5 = readItems(sb5);
const byId5 = Object.fromEntries(items5.map((x) => [x.id, x]));
ok(byId5.p1.done === true, "persistWorkChecklistToggle toggled the parent");
ok(byId5.c1a.done === false && byId5.c1b.done === false,
   "persistWorkChecklistToggle did NOT touch the children (backend cascade still owns voice/text)");

// ────────────────────────────────────────────────────────────────────────────
// Suite G — edge cases (deep tree, unknown id, missing parent_id key)
// ────────────────────────────────────────────────────────────────────────────
section("Suite G — defensive edge cases");
const sb6 = buildSandbox();
seedItems(sb6, [
  { id: "p1", text: "Project alpha", done: false, parent_id: null },
  { id: "c1", text: "milestone",     done: false, parent_id: "p1" },
  { id: "g1", text: "deep substep",  done: false, parent_id: "c1" },
]);
call(sb6, `persistWorkChecklistToggleWithSubtree("p1", true)`);
let items6 = readItems(sb6);
const byId6 = Object.fromEntries(items6.map((x) => [x.id, x]));
ok(byId6.p1.done && byId6.c1.done && byId6.g1.done,
   "BFS cascade reaches grandchildren too (defensive — current UI caps depth at 1, but data model allows deeper)");

const sb7 = buildSandbox();
seedItems(sb7, [
  { id: "p1", text: "Standalone", done: false, parent_id: null },
]);
call(sb7, `persistWorkChecklistToggleWithSubtree("does-not-exist", true)`);
let items7 = readItems(sb7);
ok(items7[0].done === false, "unknown id does not corrupt storage");

const sb8 = buildSandbox();
seedItems(sb8, [
  { id: "p1", text: "Lone item", done: false }, // no parent_id key at all
]);
call(sb8, `persistWorkChecklistToggleWithSubtree("p1", true)`);
let items8 = readItems(sb8);
ok(items8[0].done === true, "item with no parent_id key is treated as top-level and toggles");

// Empty id is a no-op.
const sb9 = buildSandbox();
seedItems(sb9, [
  { id: "p1", text: "Lone", done: false, parent_id: null },
]);
call(sb9, `persistWorkChecklistToggleWithSubtree("", true)`);
let items9 = readItems(sb9);
ok(items9[0].done === false, "empty id is a no-op");

// ────────────────────────────────────────────────────────────────────────────
// Suite H — checkbox change handler in app.js source uses the cascade helper
// ────────────────────────────────────────────────────────────────────────────
section("Suite H — change-handler call sites use persistWorkChecklistToggleWithSubtree");
const checklistSrc = fs.readFileSync(checklistPath, "utf8");
const handlerStart = checklistSrc.indexOf("cb.addEventListener(\"change\"");
ok(handlerStart > 0, "checkbox change handler block found in workmode/checklist.js");
const handlerBlockEnd = checklistSrc.indexOf("if (it.done) {", handlerStart);
ok(handlerBlockEnd > handlerStart, "checkbox change handler block has a terminating render branch");
const handlerBlock = handlerBlockEnd > 0 ? checklistSrc.slice(handlerStart, handlerBlockEnd) : "";

const cascadeCount = (handlerBlock.match(/persistWorkChecklistToggleWithSubtree\(/g) || []).length;
const legacyCount = (handlerBlock.match(/persistWorkChecklistToggle\(/g) || []).length;
ok(cascadeCount === 5,
   `change handler calls persistWorkChecklistToggleWithSubtree 5 times (got ${cascadeCount})`);
ok(legacyCount === 0,
   `change handler no longer calls bare persistWorkChecklistToggle (got ${legacyCount})`);

// Defense in depth: every call site passes ``id, true|false|wantDone``.
const callSites = handlerBlock.match(/persistWorkChecklistToggleWithSubtree\(([^)]+)\)/g) || [];
ok(callSites.every((s) => /\bid\b/.test(s)),
   "every cascade call passes the row id as the first arg");

// app.js itself should NOT reference the cascade helper (it lives only in
// workmode/checklist.js); the legacy persistWorkChecklistToggle is just a
// banner mention.
const appSrc = fs.readFileSync(appJsPath, "utf8");
ok(!/persistWorkChecklistToggleWithSubtree\b/.test(appSrc),
   "app.js does not depend on persistWorkChecklistToggleWithSubtree (frontend wiring stays inside the module)");

// ────────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────────
console.log("");
console.log(`Total: ${pass + fail}   Pass: ${pass}   Fail: ${fail}`);
if (fail) {
  console.log("Failures:");
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
} else {
  console.log("All checklist checkbox cascade smoke tests passed.");
  process.exit(0);
}
