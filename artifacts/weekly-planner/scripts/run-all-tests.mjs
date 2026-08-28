// Runner script that runs all 20 automated unit test suites sequentially and fast.
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
  'src/lib/shortcuts.test.ts',
  'src/lib/backup.test.ts',
  'src/lib/notifications.test.ts',
  'src/lib/categories.test.ts',
  'src/lib/prayerTimes.test.ts',
  'src/lib/tasks.test.ts',
  'src/lib/deviceSettings.test.ts',
  'src/lib/serverUserDb.test.ts',
  'src/lib/settingsSync.test.ts',
  'src/lib/useReorder.test.ts',
  'src/lib/uiHelpers.test.ts',
  'src/lib/notificationEngine.test.ts',
  'src/lib/auth.test.ts',
  'src/lib/migration.test.ts',
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
  console.log('ALL 20 TEST SUITES PASSED CLEANLY WITH 100% SUCCESS!');
  process.exit(0);
}
