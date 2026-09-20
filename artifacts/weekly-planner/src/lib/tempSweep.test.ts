// Tests for the orphaned atomic-write temp sweep.
//
// What is actually at stake: this deletes files out of the database folder.
// Every durable write in the planner is "write temp, rename over the real
// file", so at any instant a temp file on disk is either abandoned debris or
// the in-flight half of somebody's save. Deleting the second kind loses data.
//
// So the properties below are safety properties, not tidiness ones:
//
//   - a young temp file is NEVER touched, whatever it is called
//   - a real store file is NEVER touched, however old
//   - the backups folder is never even entered
//   - failures cannot propagate out and break a server startup
//
// Run with: npx tsx src/lib/tempSweep.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sweepOrphanedTemps } from '../../server-user-db';

const HOUR = 60 * 60 * 1000;

/** Build a throwaway database tree and return its root. */
async function makeTree(files: Record<string, { ageMs: number }>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'planner-sweep-'));
  const now = Date.now();
  for (const [rel, meta] of Object.entries(files)) {
    const full = path.join(root, 'database', rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, 'x', 'utf-8');
    const when = new Date(now - meta.ageMs);
    await fsp.utimes(full, when, when);
  }
  return root;
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true; } catch { return false; }
}

async function main() {
  console.log('--- 1. OLD ORPHANS OF BOTH SHAPES ARE REMOVED ---');
  {
    const root = await makeTree({
      // write-file-atomic's shape: .<name>.<pid>.<random>.tmp
      'users/mamoun/.notifications.json.24032.0lo6gv.tmp': { ageMs: 5 * HOUR },
      // the sync service's own shape
      'users/mamoun/database.json.sync.tmp': { ageMs: 5 * HOUR },
    });
    const removed = await sweepOrphanedTemps(root);
    assert.equal(removed.length, 2, 'both shapes recognised');
    assert.equal(await exists(path.join(root, 'database/users/mamoun/.notifications.json.24032.0lo6gv.tmp')), false);
    assert.equal(await exists(path.join(root, 'database/users/mamoun/database.json.sync.tmp')), false);
    console.log('  ok');
  }

  console.log('--- 2. A WRITE IN FLIGHT IS NEVER DELETED ---');
  {
    // THE safety property. A temp file seconds old belongs to a save that is
    // very likely still happening; deleting it destroys that save.
    const root = await makeTree({
      'users/mamoun/.database.json.999.abcdef.tmp': { ageMs: 2000 },
      'users/mamoun/database.json.sync.tmp': { ageMs: 0 },
    });
    const removed = await sweepOrphanedTemps(root);
    assert.deepEqual(removed, [], 'nothing young was touched');
    assert.equal(await exists(path.join(root, 'database/users/mamoun/.database.json.999.abcdef.tmp')), true);
    assert.equal(await exists(path.join(root, 'database/users/mamoun/database.json.sync.tmp')), true);
    console.log('  ok');
  }

  console.log('--- 3. REAL STORE FILES ARE NEVER TOUCHED, HOWEVER OLD ---');
  {
    const root = await makeTree({
      'users/mamoun/database.json': { ageMs: 500 * HOUR },
      'users/mamoun/settings.json': { ageMs: 500 * HOUR },
      'users/mamoun/sync-oplog.json': { ageMs: 500 * HOUR },
      'users.json': { ageMs: 500 * HOUR },
      'vapid.json': { ageMs: 500 * HOUR },
    });
    const removed = await sweepOrphanedTemps(root);
    assert.deepEqual(removed, []);
    for (const f of ['users/mamoun/database.json', 'users/mamoun/settings.json', 'vapid.json']) {
      assert.equal(await exists(path.join(root, 'database', f)), true, `${f} survived`);
    }
    console.log('  ok');
  }

  console.log('--- 4. A FILE MERELY CONTAINING ".tmp" IS NOT A TEMP FILE ---');
  {
    // Matching loosely here would delete real data. "tmp" must be the
    // EXTENSION, and the dotted form must actually start with a dot.
    const root = await makeTree({
      'users/mamoun/my.tmp.notes.json': { ageMs: 500 * HOUR },
      'users/mamoun/tmp-scratch.json': { ageMs: 500 * HOUR },
      'users/mamoun/database.json.sync.tmp.bak': { ageMs: 500 * HOUR },
    });
    const removed = await sweepOrphanedTemps(root);
    assert.deepEqual(removed, [], 'no false positives');
    console.log('  ok');
  }

  console.log('--- 5. THE BACKUPS FOLDER IS NEVER ENTERED ---');
  {
    // These are the user's restorable copies. Even a correctly-identified temp
    // file in there is left alone, because nothing in a tidy-up routine should
    // have the power to reach into backups at all.
    const root = await makeTree({
      'users/mamoun/backups/.snapshot.json.1.aaaaaa.tmp': { ageMs: 500 * HOUR },
      'users/mamoun/backups/backup-2026-01-01.json': { ageMs: 500 * HOUR },
    });
    const removed = await sweepOrphanedTemps(root);
    assert.deepEqual(removed, []);
    assert.equal(await exists(path.join(root, 'database/users/mamoun/backups/.snapshot.json.1.aaaaaa.tmp')), true);
    console.log('  ok');
  }

  console.log('--- 6. THE AGE BOUNDARY IS RESPECTED EXACTLY ---');
  {
    const now = Date.now();
    const root = await makeTree({
      'users/a/.x.json.1.aaaaaa.tmp': { ageMs: HOUR + 60_000 },   // comfortably older
      'users/a/.y.json.1.bbbbbb.tmp': { ageMs: HOUR - 60_000 },   // comfortably younger
    });
    const removed = await sweepOrphanedTemps(root, { minAgeMs: HOUR, now });
    assert.equal(removed.length, 1, 'only the older one');
    assert.ok(removed[0].endsWith('.x.json.1.aaaaaa.tmp'));
    assert.equal(await exists(path.join(root, 'database/users/a/.y.json.1.bbbbbb.tmp')), true);
    console.log('  ok');
  }

  console.log('--- 7. IT SWEEPS EVERY ACCOUNT, NOT JUST THE FIRST ---');
  {
    const root = await makeTree({
      'users/mamoun/.a.json.1.aaaaaa.tmp': { ageMs: 5 * HOUR },
      'users/mays/.b.json.2.bbbbbb.tmp': { ageMs: 5 * HOUR },
      'users/guest/.c.json.3.cccccc.tmp': { ageMs: 5 * HOUR },
      '.top-level.json.4.dddddd.tmp': { ageMs: 5 * HOUR },
    });
    const removed = await sweepOrphanedTemps(root);
    assert.equal(removed.length, 4, 'all accounts and the database root itself');
    console.log('  ok');
  }

  console.log('--- 8. A MISSING DATABASE FOLDER IS NOT AN ERROR ---');
  {
    // A first run, or a fresh clone. Startup must not fail.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'planner-sweep-empty-'));
    const removed = await sweepOrphanedTemps(root);
    assert.deepEqual(removed, []);
    console.log('  ok');
  }

  console.log('--- 9. AN UNREADABLE SUBFOLDER DOES NOT ABORT THE WHOLE SWEEP ---');
  {
    // Resilience: one bad directory must not stop the others being cleaned,
    // and must not throw into the server's startup path.
    const root = await makeTree({
      'users/mamoun/.a.json.1.aaaaaa.tmp': { ageMs: 5 * HOUR },
    });
    // A path that exists as a FILE where the walk expects to recurse is the
    // portable way to provoke a readdir failure without needing permissions.
    const trap = path.join(root, 'database', 'users', 'trap');
    await fsp.writeFile(trap, 'not a directory', 'utf-8');
    const removed = await sweepOrphanedTemps(root);
    assert.equal(removed.length, 1, 'the good account was still swept');
    assert.equal(await exists(trap), true, 'the odd file was left alone');
    console.log('  ok');
  }

  console.log('--- 10. IT IS IDEMPOTENT ---');
  {
    const root = await makeTree({
      'users/mamoun/.a.json.1.aaaaaa.tmp': { ageMs: 5 * HOUR },
    });
    const first = await sweepOrphanedTemps(root);
    const second = await sweepOrphanedTemps(root);
    assert.equal(first.length, 1);
    assert.deepEqual(second, [], 'a second pass finds nothing and does nothing');
    console.log('  ok');
  }

  console.log('\nAll temp sweep tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
