/**
 * Smoke: cloud sync status UI markup + module exports.
 * Run: node tests/smoke/__cloud_sync_ui_smoke.mjs
 */
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

const html = readFileSync(path.join(root, "app/index.html"), "utf8");
const css = readFileSync(path.join(root, "styles.css"), "utf8");
const cloudJs = readFileSync(path.join(root, "users/cloudSyncStatus.js"), "utf8");
const settingsJs = readFileSync(path.join(root, "users/accountSettingsSync.js"), "utf8");
const workspaceJs = readFileSync(path.join(root, "users/../workmode/workspaceSync.js"), "utf8");
const checklistJs = readFileSync(path.join(root, "workmode/checklist.js"), "utf8");

console.log("\n== cloud sync account markup ==");
ok(html.includes('id="vera-cloud-sync-signed-in"'), "signed-in cloud sync card");
ok(html.includes('id="vera-cloud-sync-signed-out"'), "signed-out cloud sync card");
ok(html.includes('id="vera-cloud-sync-now"'), "sync now button");
ok(html.includes("No cloud sync is active for anonymous sessions"), "anonymous copy");
ok(!html.includes('id="vera-checklist-sync-status"'), "legacy checklist sync line removed");

console.log("\n== cloud sync module ==");
ok(cloudJs.includes("veraRefreshCloudSyncStatusUi"), "refresh export");
ok(cloudJs.includes("syncWorkChecklistToSupabaseNow"), "manual sync uses checklist");
ok(cloudJs.includes("syncWorkModeWorkspaceToSupabaseNow"), "manual sync uses workspace");
ok(cloudJs.includes("syncLocalVeraPrefsToSupabase"), "manual sync uses settings");

console.log("\n== sync debug hooks ==");
ok(settingsJs.includes("getVeraSettingsSyncDebugState"), "settings debug state");
ok(workspaceJs.includes("getWorkModeWorkspaceSyncDebugState"), "workspace debug state");
ok(checklistJs.includes("getChecklistSupabaseSyncDebugState"), "checklist debug state");

console.log("\n== styles ==");
ok(css.includes(".vera-cloud-sync-card"), "cloud sync card styles");
ok(css.includes(".vera-cloud-sync-icon--saved"), "saved icon styles");

console.log(`\n== summary: ${passed} passed, ${failed} failed ==`);
if (failed) process.exit(1);
