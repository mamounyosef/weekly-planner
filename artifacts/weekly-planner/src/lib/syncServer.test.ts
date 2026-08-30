// Tests the durable server-side sync engine: the operation log on disk, device
// cursors, log trimming, conflict bookkeeping, file rebuilds, and recovery from
// every broken-file state a crash or a hand edit can leave behind.
//
// This suite uses the REAL filesystem in a temp directory rather than a mock,
// because the failures worth catching here are crash-and-restart failures, and a
// mock that always behaves would prove nothing about them.
//
// Run with: npx tsx src/lib/syncServer.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeOps, readStore, makeOps, emptyState } from './sync';
import { opsToSnapshot, snapshotToOps, type Snapshot } from './syncBridge';
import {
  LOG_SLACK,
  PC_DEVICE_ID,
  acknowledge,
  addConflicts,
  clearResolvedConflicts,
  getSyncPaths,
  ingestSnapshot,
  loadBundle,
  pullOps,
  pushOps,
  rebuildStoreFile,
  saveBundle,
  seedFromFiles,
  trimLog,
  type SyncBundle,
} from '../../sync-server';

const PH = 'phone-android';
let tmpRoot = '';

async function freshDir(label: string): Promise<string> {
  const dir = path.join(tmpRoot, label);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

const emptyBundle = (): SyncBundle => ({
  state: emptyState(), log: [], conflicts: [], devices: {}, seq: 0, trimmedBelow: 0,
});

/** Ops a phone would produce locally, without touching the server bundle. */
function phoneOps(base: SyncBundle, snapshot: Snapshot, at: number, store: any = 'events') {
  const local = structuredClone(base.state);
  return snapshotToOps(local, { store, snapshot, device: PH, at, detectDeletes: false });
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-server-test-'));

  console.log('--- 1. PATHS ---');
  {
    const p = getSyncPaths('C:/app/database/users/alice');
    assert.ok(p.statePath.endsWith('sync-state.json'));
    assert.ok(p.logPath.endsWith('sync-oplog.json'));
    assert.ok(p.conflictsPath.endsWith('sync-conflicts.json'));
    assert.ok(p.devicesPath.endsWith('sync-devices.json'));
    // Two users must never share a sync file.
    const q = getSyncPaths('C:/app/database/users/bob');
    assert.notEqual(p.statePath, q.statePath, 'Per-user isolation');
  }

  console.log('--- 2. LOADING WHEN NOTHING EXISTS ---');
  {
    const dir = await freshDir('empty');
    const b = await loadBundle(dir);
    assert.deepEqual(b.log, [], 'A first run starts with an empty log');
    assert.deepEqual(b.conflicts, []);
    assert.deepEqual(b.devices, {});
    assert.equal(b.state.lamport, 0);
    assert.deepEqual(b.state.entities, {});
  }

  console.log('--- 3. RECOVERY FROM CORRUPT AND HOSTILE FILES ---');
  {
    // Every one of these has actually happened to somebody: a half-written file
    // from a power cut, a hand edit, a file truncated to nothing.
    const cases: [string, string][] = [
      ['truncated', '{"entities":{"events":{"ev1"'],
      ['empty-file', ''],
      ['null-json', 'null'],
      ['wrong-shape', '[1,2,3]'],
      ['no-entities', '{"lamport":5}'],
      ['garbage', 'not json at all'],
    ];
    for (const [label, content] of cases) {
      const dir = await freshDir(`corrupt-${label}`);
      const p = getSyncPaths(dir);
      await fsp.writeFile(p.statePath, content, 'utf-8');
      await fsp.writeFile(p.logPath, content, 'utf-8');
      await fsp.writeFile(p.conflictsPath, content, 'utf-8');
      await fsp.writeFile(p.devicesPath, content, 'utf-8');

      const b = await loadBundle(dir);
      assert.ok(b.state.entities, `${label}: state recovers to a usable shape`);
      assert.ok(Array.isArray(b.log), `${label}: log recovers to an array`);
      assert.ok(Array.isArray(b.conflicts), `${label}: conflicts recover to an array`);
      assert.equal(typeof b.devices, 'object', `${label}: devices recover to an object`);
      // And it must still be WRITABLE afterwards, not poisoned.
      const r = ingestSnapshot(b, { store: 'events', snapshot: { e: { title: 't' } }, at: 1 });
      assert.equal(r.ops.length, 1, `${label}: the engine still works after recovery`);
    }
  }

  console.log('--- 4. SAVE / LOAD ROUND TRIP IS EXACT ---');
  {
    const dir = await freshDir('roundtrip');
    let b = emptyBundle();
    b = ingestSnapshot(b, {
      store: 'events',
      snapshot: { ev1: { title: 'Physics', startTime: '18:00', exdates: ['2026-09-01'] } },
      at: 1_000,
    }).bundle;
    await saveBundle(dir, b);

    const back = await loadBundle(dir);
    assert.deepEqual(readStore(back.state, 'events'), readStore(b.state, 'events'),
      'State survives a restart byte for byte');
    assert.equal(back.log.length, b.log.length, 'and so does the log');
    assert.equal(back.state.lamport, b.state.lamport, 'and the lamport clock');

    // No temp files left behind by the atomic write.
    const files = await fsp.readdir(dir);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0, 'No .tmp litter');
  }

  console.log('--- 5. INGEST: UNCHANGED SAVES STAY SILENT ---');
  {
    let b = emptyBundle();
    const snap: Snapshot = { ev1: { title: 'a', startTime: '09:00' } };
    b = ingestSnapshot(b, { store: 'events', snapshot: snap, at: 1_000 }).bundle;
    assert.equal(b.log.length, 2);

    for (let i = 0; i < 25; i++) {
      const r = ingestSnapshot(b, { store: 'events', snapshot: snap, at: 2_000 + i });
      assert.equal(r.ops.length, 0, `Autosave ${i} must not grow the log`);
      b = r.bundle;
    }
    assert.equal(b.log.length, 2, 'The log did not grow across 25 identical saves');
    assert.equal(b.ops === undefined, true);
  }

  console.log('--- 6. PUSH: A RESENT BATCH IS HARMLESS ---');
  {
    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { title: 'a' } }, at: 1_000 }).bundle;

    const ops = phoneOps(b, { ev1: { title: 'a', startTime: '10:00' } }, 2_000);
    const first = pushOps(b, { ops, deviceId: PH, at: 2_000 });
    b = first.bundle;
    assert.equal(first.ignored, 0);
    assert.deepEqual(first.dirtyStores, ['events']);
    assert.equal(b.log.length, 2, "One op for the title, one for the phone's startTime");

    // The phone never got the response and resends the same batch. Twice.
    for (let i = 0; i < 2; i++) {
      const again = pushOps(b, { ops, deviceId: PH, at: 3_000 + i });
      assert.equal(again.ignored, ops.length, 'Every op is recognised as already applied');
      assert.equal(again.dirtyStores.length, 0, 'and nothing is marked dirty');
      assert.equal(again.bundle.log.length, 2, 'and the log does not grow');
      b = again.bundle;
    }
    assert.equal(readStore(b.state, 'events').ev1.startTime, '10:00', 'The edit is still there');
  }

  console.log('--- 7. PUSH: OUT-OF-ORDER AND INTERLEAVED BATCHES ---');
  {
    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { title: 'a' } }, at: 1_000 }).bundle;

    // The phone made three edits offline; the network delivers them backwards.
    const local = structuredClone(b.state);
    const o1 = makeOps(local, { store: 'events', entityId: 'ev1', device: PH, at: 2_000, changes: { startTime: '10:00' } });
    const o2 = makeOps(local, { store: 'events', entityId: 'ev1', device: PH, at: 2_100, changes: { startTime: '11:00' } });
    const o3 = makeOps(local, { store: 'events', entityId: 'ev1', device: PH, at: 2_200, changes: { endTime: '12:00' } });

    let shuffled = emptyBundle();
    shuffled = ingestSnapshot(shuffled, { store: 'events', snapshot: { ev1: { title: 'a' } }, at: 1_000 }).bundle;
    shuffled = pushOps(shuffled, { ops: [...o3, ...o1, ...o2], deviceId: PH, at: 3_000 }).bundle;

    let inOrder = emptyBundle();
    inOrder = ingestSnapshot(inOrder, { store: 'events', snapshot: { ev1: { title: 'a' } }, at: 1_000 }).bundle;
    inOrder = pushOps(inOrder, { ops: [...o1, ...o2, ...o3], deviceId: PH, at: 3_000 }).bundle;

    assert.deepEqual(readStore(shuffled.state, 'events'), readStore(inOrder.state, 'events'),
      'Arrival order must not change the outcome');
    assert.equal(readStore(shuffled.state, 'events').ev1.startTime, '11:00',
      'The last of the chained edits wins');
  }

  console.log('--- 8. PULL: A DEVICE DOES GET ITS OWN OPS BACK ---');
  {
    // This used to filter a device's own ops out to save bandwidth. It cost far
    // more than it saved: a phone that cleared its local database, or was
    // reinstalled onto the same device id, could never recover anything it had
    // written itself -- the server held those ops and refused to hand them over.
    // Merging is idempotent, so receiving them again is free.
    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { title: 'a' } }, at: 1_000 }).bundle;
    const ops = phoneOps(b, { ev1: { title: 'a', startTime: '10:00' } }, 2_000);
    b = pushOps(b, { ops, deviceId: PH, at: 2_000 }).bundle;

    const pulled = pullOps(b, { deviceId: PH, since: 0 });
    assert.ok(pulled.ops.some(o => o.device === PH),
      'A device must be able to recover its own history after a local wipe');
    assert.equal(pulled.ops.length, b.log.length, 'From zero it gets the whole log');
    assert.equal(pulled.needsFullResync, false);

    // A caught-up device gets nothing at all.
    const caught = pullOps(b, { deviceId: PH, since: pulled.cursor });
    assert.equal(caught.ops.length, 0, 'A caught-up device pulls nothing');
    assert.equal(caught.cursor, pulled.cursor, 'and its cursor does not move');
  }

  console.log('--- 9. PULL: A DEVICE BEHIND A PRUNED LOG IS TOLD TO FULL-RESYNC ---');
  {
    let b = emptyBundle();
    for (let i = 0; i < 50; i++) {
      b = ingestSnapshot(b, {
        store: 'events',
        snapshot: Object.fromEntries(
          Array.from({ length: i + 1 }, (_, k) => [`ev${k}`, { title: `t${k}-${i}` }]),
        ),
        at: 1_000 + i,
      }).bundle;
    }
    // Simulate a log trimmed long ago: drop everything at or below position 100.
    const trimmed: SyncBundle = {
      ...b, log: b.log.filter(o => (o.seq ?? 0) > 100), trimmedBelow: 100,
    };

    const stale = pullOps(trimmed, { deviceId: 'old-phone', since: 5 });
    assert.equal(stale.needsFullResync, true,
      'A gap the log cannot cover must be reported, never silently skipped');
    assert.equal(stale.ops.length, 0,
      'and nothing is handed over, so a half-answer cannot be mistaken for the whole');

    const current = pullOps(trimmed, { deviceId: 'old-phone', since: 400 });
    assert.equal(current.needsFullResync, false, 'A device inside the log is fine');

    // A BRAND-NEW device against a trimmed log must resync too. This used to
    // return "no resync needed" and then hand over only the surviving tail, so a
    // fresh install (or a phone whose local data had been cleared) silently
    // showed a fraction of the planner and looked like sync half-working.
    const brandNew = pullOps(trimmed, { deviceId: 'new-phone', since: 0 });
    assert.equal(brandNew.needsFullResync, true,
      'A first sync against a trimmed log must take a snapshot, not the tail');

    // With nothing trimmed, a first sync is an ordinary pull.
    const untrimmed = pullOps(b, { deviceId: 'new-phone', since: 0 });
    assert.equal(untrimmed.needsFullResync, false, 'A first sync is not a "resync"');
    assert.equal(untrimmed.ops.length, b.log.length, 'and it gets everything');
  }

  console.log('--- 10. ACKNOWLEDGE NEVER MOVES A CURSOR BACKWARDS ---');
  {
    // The head has to exist: a device cannot acknowledge a position the server
    // has never written, and `acknowledge` clamps to the head for exactly that
    // reason -- a cursor past the head would make the device skip the next ops.
    let b: SyncBundle = { ...emptyBundle(), seq: 200 };
    b = acknowledge(b, { deviceId: PH, cursor: 100, at: 1_000 });
    assert.equal(b.devices[PH].cursor, 100);

    // A delayed duplicate of an OLD acknowledgement arrives late.
    b = acknowledge(b, { deviceId: PH, cursor: 20, at: 1_100 });
    assert.equal(b.devices[PH].cursor, 100,
      'A stale ack must not un-acknowledge ops the device already has');
    assert.equal(b.devices[PH].lastSeen, 1_100, 'but it still counts as contact');

    b = acknowledge(b, { deviceId: PH, cursor: 150, at: 1_200 });
    assert.equal(b.devices[PH].cursor, 150, 'Forward progress still works');

    b = acknowledge(b, { deviceId: PH, cursor: 9_999, at: 1_300 });
    assert.equal(b.devices[PH].cursor, 200,
      'An impossible cursor is clamped to the head rather than trusted');
  }

  console.log('--- 11. LOG TRIMMING RESPECTS THE SLOWEST DEVICE ---');
  {
    const log = Array.from({ length: 2_000 }, (_, i) => ({
      opId: `d:${i + 1}`, store: 'events' as const, entityId: 'e', field: 'title',
      value: i, device: 'd', lamport: i + 1, at: 0, seq: i + 1,
    }));

    // No devices known yet: keep everything. Trimming here would strand a phone
    // that has simply not connected for the first time.
    assert.equal(trimLog(log, {}).log.length, 2_000, 'Nothing is trimmed with no known devices');
    assert.equal(trimLog(log, {}).trimmedBelow, 0, 'and nothing is reported as lost');

    const devices = {
      a: { deviceId: 'a', cursor: 1_900, lastSeen: 0 },
      b: { deviceId: 'b', cursor: 1_200, lastSeen: 0 },
    };
    const trimmed = trimLog(log, devices);
    assert.ok(trimmed.log.every(o => (o.seq ?? 0) > 1_200 - LOG_SLACK),
      'Trimmed below the slowest device minus slack');
    assert.ok(trimmed.log.some(o => o.seq === 1_201),
      'Everything the slowest device still needs is kept');
    assert.equal(trimmed.log.length, 2_000 - (1_200 - LOG_SLACK), 'Exact retained count');
    assert.equal(trimmed.trimmedBelow, 1_200 - LOG_SLACK,
      'The watermark is recorded so a device below it is told to resync');

    // One device that has never synced holds the whole log.
    const withNewbie = trimLog(log, { ...devices, c: { deviceId: 'c', cursor: 0, lastSeen: 0 } });
    assert.equal(withNewbie.log.length, 2_000, 'A device at cursor 0 pins the entire log');
    assert.equal(withNewbie.trimmedBelow, 0);
  }

  console.log('--- 12. CONFLICT BOOKKEEPING ---');
  {
    const mk = (field: string, at: number, id: string) => ({
      id, kind: 'field' as const, store: 'events' as const, entityId: 'ev1', field,
      winner: { value: 'w', device: 'a', at, lamport: at },
      loser: { value: 'l', device: 'b', at, lamport: at },
      detectedAt: at,
    });

    let open = addConflicts([], [mk('title', 100, 'c1')]);
    assert.equal(open.length, 1);

    // The same field disagreeing again REPLACES the card instead of stacking.
    open = addConflicts(open, [mk('title', 200, 'c2')]);
    assert.equal(open.length, 1, 'One card per field, still');
    assert.equal(open[0].id, 'c2', 'and it is the newer one');

    // An OLDER detection does not overwrite a newer card.
    open = addConflicts(open, [mk('title', 50, 'c0')]);
    assert.equal(open[0].id, 'c2', 'A late-arriving older conflict does not regress the card');

    // A different field is a separate card.
    open = addConflicts(open, [mk('startTime', 300, 'c3')]);
    assert.equal(open.length, 2);

    // Answering writes an op for that field, which clears exactly that card.
    const answer = makeOps(emptyState(), {
      store: 'events', entityId: 'ev1', device: 'a', at: 400, changes: { title: 'chosen' },
    });
    const after = clearResolvedConflicts(open, answer);
    assert.equal(after.length, 1, 'The answered card is gone');
    assert.equal(after[0].field, 'startTime', 'and the unanswered one remains');

    // A delete card is cleared by any write to the tombstone.
    const delCard = { ...mk('__deleted', 500, 'c4'), kind: 'delete' as const };
    const delAnswer = makeOps(emptyState(), {
      store: 'events', entityId: 'ev1', device: 'a', at: 600, changes: { __deleted: true },
    });
    assert.equal(clearResolvedConflicts([delCard], delAnswer).length, 0,
      'Answering a delete card closes it');

    // Clearing against unrelated ops changes nothing.
    const unrelated = makeOps(emptyState(), {
      store: 'tasks', entityId: 'other', device: 'a', at: 700, changes: { title: 'x' },
    });
    assert.equal(clearResolvedConflicts([delCard], unrelated).length, 1,
      'An unrelated write does not close a card');
  }

  console.log('--- 13. A REAL CONFLICT SURVIVES A RESTART ---');
  {
    const dir = await freshDir('conflict-restart');
    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { startTime: '18:00' } }, at: 1_000 }).bundle;

    const ops = phoneOps(b, { ev1: { startTime: '20:00' } }, 2_000);
    // The PC edits the same field before the phone's batch lands.
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { startTime: '18:30' } }, at: 2_001 }).bundle;
    const res = pushOps(b, { ops, deviceId: PH, at: 2_002 });
    b = res.bundle;

    assert.equal(res.conflicts.length, 1, 'The race is detected');
    assert.equal(b.conflicts.length, 1, 'and stored on the bundle');

    await saveBundle(dir, b);
    const back = await loadBundle(dir);
    assert.equal(back.conflicts.length, 1, 'The card is still there after a restart');
    assert.equal(back.conflicts[0].field, 'startTime');
    const vals = [back.conflicts[0].winner.value, back.conflicts[0].loser.value].sort();
    assert.deepEqual(vals, ['18:30', '20:00'], 'Both values survived the restart');
  }

  console.log('--- 14. REBUILDING A FILE, AND NOT REBUILDING IT ---');
  {
    const dir = await freshDir('rebuild');
    const file = path.join(dir, 'database.json');
    const disk: Snapshot = { ev1: { title: 'Physics', startTime: '18:00', gCalETag: '"e1"' } };
    await fsp.writeFile(file, JSON.stringify(disk, null, 2), 'utf-8');

    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: disk, at: 1_000 }).bundle;

    // Nothing changed → must return null so the db-stream does not fire.
    assert.equal(await rebuildStoreFile(file, b, 'events'), null,
      'An unchanged store must NOT be rewritten');

    const ops = phoneOps(b, { ev1: { title: 'Physics', startTime: '20:00' } }, 2_000);
    b = pushOps(b, { ops, deviceId: PH, at: 2_000 }).bundle;

    const next = await rebuildStoreFile(file, b, 'events');
    assert.ok(next, 'A phone edit does produce new file content');
    const parsed = JSON.parse(next!);
    assert.equal(parsed.ev1.startTime, '20:00', "The phone's edit is in the file");
    assert.equal(parsed.ev1.gCalETag, '"e1"', 'and the Google ETag was preserved');
    assert.equal(parsed.ev1.title, 'Physics');

    // Writing it and rebuilding again is a no-op — no oscillation.
    await fsp.writeFile(file, next!, 'utf-8');
    assert.equal(await rebuildStoreFile(file, b, 'events'), null,
      'After writing, a rebuild is idempotent');

    // A missing file rebuilds from scratch rather than throwing.
    const gone = path.join(dir, 'not-there.json');
    const fresh = await rebuildStoreFile(gone, b, 'events');
    assert.ok(fresh, 'A missing file is rebuilt, not an error');
    assert.equal(JSON.parse(fresh!).ev1.gCalETag, undefined,
      'with no ETag to preserve, since there was no disk copy');
  }

  console.log('--- 15. SEEDING FROM AN EXISTING PLANNER ---');
  {
    const dir = await freshDir('seed');
    const dbFile = path.join(dir, 'database.json');
    const tasksFile = path.join(dir, 'tasks.json');
    await fsp.writeFile(dbFile, JSON.stringify({
      ev1: { title: 'Lecture', startTime: '09:00' },
      ev2: { title: 'Gym', allDay: true },
    }), 'utf-8');
    await fsp.writeFile(tasksFile, JSON.stringify({
      t1: { title: 'Read chapter 4', listId: 'uni' },
    }), 'utf-8');

    const b = await seedFromFiles(emptyBundle(), { events: dbFile, tasks: tasksFile }, 1_000);
    assert.equal(Object.keys(readStore(b.state, 'events')).length, 2,
      'Existing events appear without any migration');
    assert.equal(Object.keys(readStore(b.state, 'tasks')).length, 1, 'and existing tasks');
    assert.ok(b.log.every(o => o.device === PC_DEVICE_ID), 'Seeded ops are attributed to the PC');

    // Seeding twice must not duplicate anything.
    const twice = await seedFromFiles(b, { events: dbFile, tasks: tasksFile }, 2_000);
    assert.equal(twice.log.length, b.log.length, 'Re-seeding an unchanged planner adds nothing');

    // Seeding from missing files is not an error.
    const missing = await seedFromFiles(emptyBundle(), {
      events: path.join(dir, 'nope.json'), tasks: path.join(dir, 'nope2.json'),
    }, 1_000);
    assert.equal(missing.log.length, 0, 'Missing files seed nothing and do not throw');
  }

  console.log('--- 16. END TO END THROUGH THE DISK, WITH A RESTART IN THE MIDDLE ---');
  {
    const dir = await freshDir('e2e');
    const file = path.join(dir, 'database.json');
    await fsp.writeFile(file, JSON.stringify({
      ev1: { title: 'Physics', startTime: '18:00', categoryId: 'uni' },
    }), 'utf-8');

    let b = await seedFromFiles(await loadBundle(dir), { events: file }, 1_000);
    await saveBundle(dir, b);

    // The phone syncs down, goes offline, and moves the event.
    const down = pullOps(b, { deviceId: PH, since: 0 });
    let phone = mergeOps(emptyState(), down.ops).state;
    assert.equal(readStore(phone, 'events').ev1.startTime, '18:00', 'Phone starts in step');

    const offline = snapshotToOps(phone, {
      store: 'events',
      snapshot: { ev1: { ...readStore(phone, 'events').ev1, startTime: '20:00' } },
      device: PH, at: 5_000, detectDeletes: false,
    });
    phone = mergeOps(phone, offline).state;

    // Meanwhile the PC renames it and the server restarts before the phone returns.
    b = ingestSnapshot(b, {
      store: 'events',
      snapshot: { ev1: { title: 'Physics revision', startTime: '18:00', categoryId: 'uni' } },
      at: 5_001,
    }).bundle;
    await saveBundle(dir, b);
    b = await loadBundle(dir); // ← the restart

    // The phone comes back and pushes.
    const push = pushOps(b, { ops: offline, deviceId: PH, at: 6_000, platform: 'android' });
    b = push.bundle;
    assert.equal(push.conflicts.length, 0, 'Different fields, so no card');
    assert.deepEqual(push.dirtyStores, ['events']);

    const rebuilt = await rebuildStoreFile(file, b, 'events');
    assert.ok(rebuilt);
    await fsp.writeFile(file, rebuilt!, 'utf-8');
    const onDisk = JSON.parse(await fsp.readFile(file, 'utf-8'));
    assert.equal(onDisk.ev1.startTime, '20:00', "The phone's offline move survived a restart");
    assert.equal(onDisk.ev1.title, 'Physics revision', "and so did the PC's rename");
    assert.equal(onDisk.ev1.categoryId, 'uni', 'and the untouched field is intact');

    // The phone pulls the rename back and the two agree.
    const back = pullOps(b, { deviceId: PH, since: down.cursor });
    phone = mergeOps(phone, back.ops).state;
    assert.deepEqual(readStore(phone, 'events'), readStore(b.state, 'events'),
      'Phone and server hold identical planners');

    assert.equal(b.devices[PH].platform, 'android', 'The device was recorded');
    assert.ok(b.devices[PH].lastSeen === 6_000);
  }

  console.log('--- 17. MANY DEVICES, LONG RUN, NO UNBOUNDED GROWTH ---');
  {
    let b = emptyBundle();
    const ids = ['phone-a', 'phone-b', 'tablet-c'];

    for (let round = 0; round < 40; round++) {
      b = ingestSnapshot(b, {
        store: 'events',
        snapshot: { ev1: { title: `pc-${round}` } },
        at: 10_000 + round,
      }).bundle;

      for (const id of ids) {
        const local = structuredClone(b.state);
        const ops = makeOps(local, {
          store: 'events', entityId: `ev-${id}`, device: id,
          at: 10_000 + round, changes: { title: `${id}-${round}` },
        });
        b = pushOps(b, { ops, deviceId: id, at: 10_000 + round }).bundle;
        const pulled = pullOps(b, { deviceId: id, since: b.devices[id]?.cursor ?? 0 });
        b = acknowledge(b, { deviceId: id, cursor: pulled.cursor, at: 10_000 + round });
      }
    }

    // With every device acknowledged, the log must be bounded by the slack, not
    // by how long the planner has been in use.
    assert.ok(b.log.length <= LOG_SLACK + 20,
      `Log must stay bounded once devices acknowledge (was ${b.log.length})`);
    assert.equal(Object.keys(b.devices).length, 3);
    assert.equal(Object.keys(readStore(b.state, 'events')).length, 4,
      'All the data is still there — only the log was trimmed');
    assert.equal(readStore(b.state, 'events').ev1.title, 'pc-39');
  }

  console.log('--- 18. DEGENERATE PUSHES ---');
  {
    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { title: 'a' } }, at: 1_000 }).bundle;

    const empty = pushOps(b, { ops: [], deviceId: PH, at: 2_000 });
    assert.equal(empty.dirtyStores.length, 0, 'An empty push marks nothing dirty');
    assert.equal(empty.bundle.log.length, b.log.length, 'and does not grow the log');
    assert.equal(empty.bundle.devices[PH].cursor, 0, 'but does register the device');
    assert.equal(empty.bundle.devices[PH].lastSeen, 2_000, 'and its last-seen time');

    // An ingest of an empty snapshot deletes everything — that IS the meaning of
    // an empty file, and it must be a normal tombstone, not a crash.
    const wiped = ingestSnapshot(b, { store: 'events', snapshot: {}, at: 3_000 });
    assert.equal(wiped.ops.length, 1);
    assert.equal(wiped.ops[0].field, '__deleted');
    assert.deepEqual(readStore(wiped.bundle.state, 'events'), {});
  }

  console.log('--- 19. UNICODE, HUGE VALUES AND AWKWARD IDS SURVIVE THE DISK ---');
  {
    const dir = await freshDir('unicode');
    const snapshot: Snapshot = {
      'ev:with:colons': { title: 'صلاة الفجر', notes: 'مذاكرة فيزياء' },
      'ev::occurrence::2026-09-01': { title: 'Occurrence-shaped id' },
      'ev-emoji': { title: 'Gym 💪🏋️', notes: 'x'.repeat(20_000) },
      'ev-newline': { title: 'line one\nline two\ttabbed' },
      'ev-quotes': { title: 'He said "hello" and \\escaped\\' },
    };
    let b = ingestSnapshot(emptyBundle(), { store: 'events', snapshot, at: 1_000 }).bundle;
    await saveBundle(dir, b);
    b = await loadBundle(dir);

    assert.deepEqual(opsToSnapshot(b.state, 'events'), snapshot,
      'Arabic, emoji, newlines, quotes, colon-laden ids and a 20k string all survive');

    // Colons in ids must not collide with the `${lamport}:${device}` stamp format.
    const r = ingestSnapshot(b, {
      store: 'events',
      snapshot: { ...snapshot, 'ev:with:colons': { title: 'changed', notes: 'مذاكرة فيزياء' } },
      at: 2_000,
    });
    assert.equal(r.ops.length, 1, 'A colon-laden id still diffs to exactly one op');
    assert.equal(r.ops[0].entityId, 'ev:with:colons');
  }

  console.log('--- 20. CROSS-STORE PUSH MARKS ONLY THE RIGHT FILES DIRTY ---');
  {
    let b = emptyBundle();
    b = ingestSnapshot(b, { store: 'events', snapshot: { ev1: { title: 'e' } }, at: 1_000 }).bundle;
    b = ingestSnapshot(b, { store: 'tasks', snapshot: { t1: { title: 't' } }, at: 1_000 }).bundle;

    const local = structuredClone(b.state);
    const ops = makeOps(local, {
      store: 'tasks', entityId: 't1', device: PH, at: 2_000, changes: { title: 't2' },
    });
    const res = pushOps(b, { ops, deviceId: PH, at: 2_000 });
    assert.deepEqual(res.dirtyStores, ['tasks'],
      'Editing a task must not cause database.json to be rewritten');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (server sync engine: durability, cursors, trimming, recovery)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
