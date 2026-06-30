// Smoke: UI erase clears server session checklist (source contracts).
//
// Run:  node tests/smoke/__checklist_ui_erase_sync_smoke.mjs

"use strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKLIST_JS = fs
  .readFileSync(path.resolve(__dirname, "../../workmode/checklist.js"), "utf8")
  .replace(/\r\n/g, "\n");
const INDEX_HTML = fs
  .readFileSync(path.resolve(__dirname, "../../app/index.html"), "utf8")
  .replace(/\r\n/g, "\n");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const RST = "\x1b[0m";
let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log(`  ${GREEN}PASS${RST}  ${name}`);
  } else {
    fail++;
    console.log(`  ${RED}FAIL${RST}  ${name}`);
  }
}

console.log(`\n${YEL}-- UI erase server sync contracts --${RST}`);
ok(CHECKLIST_JS.includes("async function eraseEntireWorkChecklist"), "eraseEntireWorkChecklist is async");
ok(
  CHECKLIST_JS.includes("async function clearWorkChecklistServerAfterUiErase"),
  "clearWorkChecklistServerAfterUiErase helper present"
);
ok(
  CHECKLIST_JS.includes("async function syncWorkChecklistSessionToServerNow"),
  "syncWorkChecklistSessionToServerNow helper present"
);
ok(
  CHECKLIST_JS.includes("await clearWorkChecklistServerAfterUiErase()"),
  "UI erase awaits server clear"
);
ok(CHECKLIST_JS.includes("[checklist_ui_erase_requested]"), "ui erase requested log");
ok(CHECKLIST_JS.includes("[checklist_ui_erase_local_cleared]"), "ui erase local cleared log");
ok(CHECKLIST_JS.includes("[checklist_ui_erase_server_clear_start]"), "ui erase server clear start log");
ok(CHECKLIST_JS.includes("[checklist_ui_erase_server_clear_done]"), "ui erase server clear done log");
ok(CHECKLIST_JS.includes("[checklist_add_apply_start]"), "checklist add apply start log");
ok(CHECKLIST_JS.includes("[checklist_add_apply_done]"), "checklist add apply done log");
ok(CHECKLIST_JS.includes("[checklist_precommand_sync_snapshot]"), "precommand sync snapshot log");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
