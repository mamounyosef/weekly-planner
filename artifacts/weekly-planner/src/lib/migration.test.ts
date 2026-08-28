// Tests legacy recurrence migrations, multi-user database migrations, and backup version compatibility.
// Run with: npx tsx src/lib/migration.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { migrateEvents, type RecurFields } from './recurrence';
import { migrateLegacyDatabase } from '../../server-user-db';

console.log('--- 1. MIGRATE RECURRENCE EVENTS (LEGACY SCOPE MODEL) ---');

const legacyRaw: Record<string, any> = {
  // 1. Group of scope:'all' events across 3 weekdays (Monday=1, Wednesday=3, Friday=5)
  'ev-rec-mon': { id: 'ev-rec-mon', scope: 'all', dayIndex: 1, content: 'Team Standup', startTime: '09:00', endTime: '09:30', color: '#3b82f6', gCalId: 'gcal-standup-master' },
  'ev-rec-wed': { id: 'ev-rec-wed', scope: 'all', dayIndex: 3, content: 'Team Standup', startTime: '09:00', endTime: '09:30', color: '#3b82f6', gCalId: 'gcal-standup-wed' },
  'ev-rec-fri': { id: 'ev-rec-fri', scope: 'all', dayIndex: 5, content: 'Team Standup', startTime: '09:00', endTime: '09:30', color: '#3b82f6' },

  // 2. Single event with scope:'week'
  'ev-single': { id: 'ev-single', scope: 'week', dayIndex: 2, content: 'One-off Lunch', weekKey: '2025-01-05' },

  // 3. Obsolete tombstone without Google ID -> should be dropped
  'ev-tombstone-local': { id: 'ev-tombstone-local', deleted: true, content: 'Old deleted item' },

  // 4. Tombstone with Google ID -> must be retained to delete on Google
  'ev-tombstone-gcal': { id: 'ev-tombstone-gcal', deleted: true, gCalId: 'gcal-to-delete' },
};

const migrationResult = migrateEvents(legacyRaw);
assert.equal(migrationResult.changed, true, 'Migration should detect legacy fields and flag changed');

const migrated = migrationResult.events;

// Verify standalone event
assert.ok(migrated['ev-single']);
assert.equal((migrated['ev-single'] as any).scope, undefined, 'Obsolete scope stripped');
assert.equal(migrated['ev-single'].content, 'One-off Lunch');
assert.equal(migrated['ev-single'].deleted, false);

// Verify local tombstone dropped
assert.equal(migrated['ev-tombstone-local'], undefined, 'Local bookkeeping tombstone dropped');

// Verify Google tombstone kept
assert.ok(migrated['ev-tombstone-gcal']);
assert.equal(migrated['ev-tombstone-gcal'].deleted, true);

// Verify recurring group collapsed into 1 master
// Representative should be ev-rec-mon (which has gCalId)
assert.ok(migrated['ev-rec-mon']);
assert.equal(migrated['ev-rec-mon'].deleted, false);
assert.equal(migrated['ev-rec-mon'].recur?.freq, 'weekly');
assert.deepEqual(migrated['ev-rec-mon'].recur?.byWeekday, [1, 3, 5]);

// Sibling ev-rec-wed had a gCalId -> becomes tombstone so orphan Google event gets deleted
assert.ok(migrated['ev-rec-wed']);
assert.equal(migrated['ev-rec-wed'].deleted, true);

// Sibling ev-rec-fri had NO gCalId -> dropped completely
assert.equal(migrated['ev-rec-fri'], undefined);

// Verify Idempotency: re-running on migrated events produces changed: false
const reRun = migrateEvents(migrated);
assert.equal(reRun.changed, false);
assert.deepEqual(reRun.events, migrated);

console.log('--- 2. SEVEN-DAY RECURRING GROUP BECOMES DAILY ---');
const dailyGroup: Record<string, any> = {};
for (let wd = 0; wd < 7; wd++) {
  dailyGroup[`daily-${wd}`] = { id: `daily-${wd}`, scope: 'all', dayIndex: wd, content: 'Morning Run', startTime: '06:00', endTime: '06:30' };
}

const dailyMigrated = migrateEvents(dailyGroup);
const dailyMaster = Object.values(dailyMigrated.events)[0];
assert.equal(dailyMaster.recur?.freq, 'daily', '7-weekday recurring group collapses to daily frequency');
assert.equal(dailyMaster.recur?.interval, 1);

console.log('--- 3. DATABASE DIRECTORY MIGRATION ---');
const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'planner-db-migration-test-'));
const dbDir = path.join(tmpDir, 'database');
await fsp.mkdir(dbDir, { recursive: true });

// Seed legacy files in database/
await fsp.writeFile(path.join(dbDir, 'database.json'), JSON.stringify({ 'ev-1': { id: 'ev-1', content: 'Legacy Event' } }));
await fsp.writeFile(path.join(dbDir, 'users.json'), JSON.stringify({ users: [{ username: 'mamoun', password: '123' }] }));

// Seed legacy root backups/
const rootBackups = path.join(tmpDir, 'backups');
await fsp.mkdir(rootBackups, { recursive: true });
await fsp.writeFile(path.join(rootBackups, 'planner-backup.2026-08-01.json'), JSON.stringify({ backupFormatVersion: 2 }));

// Run migration
await migrateLegacyDatabase(tmpDir);

// Verify migrated to database/users/mamoun/
const targetDb = path.join(dbDir, 'users', 'mamoun', 'database.json');
const targetBackups = path.join(dbDir, 'users', 'mamoun', 'backups', 'planner-backup.2026-08-01.json');

assert.ok(await fsp.stat(targetDb).then(() => true).catch(() => false), 'Database JSON migrated to user directory');
assert.ok(await fsp.stat(targetBackups).then(() => true).catch(() => false), 'Root backups migrated to user backups directory');

// Clean up
await fsp.rm(tmpDir, { recursive: true, force: true });

console.log('\nALL PASS (migration)');
