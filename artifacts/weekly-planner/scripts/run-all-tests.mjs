// Runner script that runs all automated unit test suites sequentially and fast.
// Run with: node scripts/run-all-tests.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const testFiles = [
  'src/lib/recurrence.test.ts',
  'src/lib/focusSessions.test.ts',
  'src/lib/sensorFilter.test.ts',
  'src/lib/hardwareBridge.test.ts',
  'src/lib/hardwareController.test.ts',
  'src/lib/deskIntegration.test.ts',
  'src/lib/deskSensor.test.ts',
  'src/lib/deskRealism.test.ts',
  'src/lib/shortcuts.test.ts',
  'src/lib/backup.test.ts',
  'src/lib/notifications.test.ts',
  'src/lib/categories.test.ts',
  'src/lib/prayerTimes.test.ts',
  'src/lib/tasks.test.ts',
  'src/lib/taskLists.test.ts',
  'src/lib/updateLabel.test.ts',
  'src/lib/focusPeriod.test.ts',
  'src/lib/deviceSettings.test.ts',
  'src/lib/serverUserDb.test.ts',
  'src/lib/settingsSync.test.ts',
  'src/lib/useReorder.test.ts',
  'src/lib/uiHelpers.test.ts',
  'src/lib/notificationEngine.test.ts',
  'src/lib/auth.test.ts',
  'src/lib/migration.test.ts',
  'src/lib/sync.test.ts',
  'src/lib/syncBridge.test.ts',
  'src/lib/syncServer.test.ts',
  'src/lib/syncService.test.ts',
  'src/lib/syncEndpoints.test.ts',
  'src/lib/syncClient.test.ts',
  'src/lib/syncStorage.test.ts',
  'src/lib/alarmPlan.test.ts',
  'src/lib/agenda.test.ts',
  'src/lib/appDelivery.test.ts',
  'src/lib/ota.test.ts',
  'src/lib/syncTransport.test.ts',
  'src/lib/syncEquality.test.ts',
  'src/lib/syncIntegration.test.ts',
  'src/lib/syncDivergence.test.ts',
  'src/lib/syncSharing.test.ts',
  'src/lib/syncClock.test.ts',
  'src/lib/syncSetOps.test.ts',
  'src/lib/syncCursor.test.ts',
  'src/lib/syncLifecycle.test.ts',
  'src/lib/draft.test.ts',
  'src/lib/syncWaiting.test.ts',
  'src/lib/settingsScope.test.ts',
  'src/lib/settingsRoundTrip.test.ts',
  'src/lib/focusStats.test.ts',
  'src/lib/yearStats.test.ts',
  'src/lib/grid.test.ts',
  'src/lib/prayerSync.test.ts',
  'src/lib/dragGrid.test.ts',
  'src/lib/monthDrag.test.ts',
  'src/lib/occurrence.test.ts',
  'src/lib/viewPrefs.test.ts',
  'src/lib/prayerSettings.test.ts',
  'src/lib/focusTimer.test.ts',
  'src/lib/notifyCentre.test.ts',
  'src/lib/search.test.ts',
  'src/lib/taskBoard.test.ts',
  'src/lib/dragSort.test.ts',
  'src/lib/scrollLock.test.ts',
  'src/lib/overlayStack.test.ts',
  'src/lib/pendingDone.test.ts',
  'src/lib/liveMarker.test.ts',
  'src/lib/quickAdd.test.ts',
  'src/lib/dayWindows.test.ts',
  'src/lib/displaySettings.test.ts',
  'src/lib/conflictText.test.ts',
  'src/lib/focusGoals.test.ts',
  'src/lib/prefsStore.test.ts',
  'src/lib/coalesce.test.ts',
  'src/lib/dayCache.test.ts',
  'src/lib/gcalColor.test.ts',
  'src/lib/focusIntegrity.test.ts',
];

console.log(`\n======================================================`);
console.log(`   RUNNING ALL ${testFiles.length} AUTOMATED TEST SUITES`);
console.log(`======================================================\n`);

let passed = 0;
let failed = 0;
const startTotal = Date.now();

for (let i = 0; i < testFiles.length; i++) {
  const file = testFiles[i];
  const name = path.basename(file);
  process.stdout.write(`[${i + 1}/${testFiles.length}] Running ${name}... `);

  const start = Date.now();
  const res = spawnSync('npx', ['tsx', file], {
    cwd: rootDir,
    encoding: 'utf-8',
    shell: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const elapsed = Date.now() - start;

  if (res.status === 0) {
    passed++;
    console.log(`✓ PASSED (${elapsed}ms)`);
  } else {
    failed++;
    console.log(`✗ FAILED (${elapsed}ms)`);
    console.error(res.stdout);
    console.error(res.stderr);
  }
}

const totalElapsed = ((Date.now() - startTotal) / 1000).toFixed(2);

console.log(`\n======================================================`);
console.log(`SUMMARY: ${passed} passed, ${failed} failed in ${totalElapsed}s`);
console.log(`======================================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log(`ALL ${testFiles.length} TEST SUITES PASSED CLEANLY WITH 100% SUCCESS!`);
  process.exit(0);
}
