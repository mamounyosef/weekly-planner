// Tests the stateful sync service: request validation against hostile input,
// the per-user serialising queue, file write-back, conflict resolution from
// either device, and recovery when a request throws mid-flight.
//
// The queue tests are the important ones. Node being single threaded does NOT
// make read-modify-write safe when `await` sits in the middle, and the failure
// mode is silent data loss, so concurrency here is exercised by actually firing
// overlapping requests rather than by reasoning about them.
//
// Run with: npx tsx src/lib/syncService.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyState, makeOps, mergeOps, type SyncOp } from './sync';
import { snapshotToOps, type Snapshot } from './syncBridge';
import {
  createSyncService,
  storeFileOf,
  validateCursor,
  validateDeviceId,
  validateOp,
  validatePush,
  type UserSyncPaths,
} from '../../sync-service';

const USER = 'mamoun';
const PH = 'phone-android';
let tmpRoot = '';

async function freshUser(label: string, seed: Snapshot = {}, tasks: Snapshot = {}) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
  };
  await fsp.writeFile(paths.dbPath, JSON.stringify(seed, null, 2), 'utf-8');
  await fsp.writeFile(paths.tasksPath, JSON.stringify(tasks, null, 2), 'utf-8');
  return paths;
}

const readFile = async (f: string) => JSON.parse(await fsp.readFile(f, 'utf-8'));

/**
 * A phone that has actually synced, built the way the real app does: pull the
 * log and merge it, so its lamport clock and every field's base stamp match the
 * server's. Editing from a hand-rolled empty state instead would produce ops
 * that legitimately LOSE every conflict, which tests nothing real.
 */
async function syncedPhone(svc: any, paths: UserSyncPaths, deviceId: string) {
  const pulled = await svc.pull(USER, paths, deviceId, 0);
  const state = mergeOps(emptyState(), pulled.ops).state;
  return { state, cursor: pulled.cursor };
}

/** A well-formed op, for validation tests to mutate one field of at a time. */
const goodOp = (): Record<string, unknown> => ({
  opId: 'phone-android:7',
  store: 'events',
  entityId: 'ev1',
  field: 'title',
  value: 'Physics',
  device: 'phone-android',
  lamport: 7,
  at: 1_700_000_000_000,
});

/**
 * What `/api/events` actually does: write the whole file, then ask the service
 * to fold it in. Ingest reads the FILE, not the body, because between the two
 * Google sync may have written as well -- so a test that only handed over a body
 * would be testing a path that does not exist.
 */
async function pcSave(svc: any, paths: UserSyncPaths, store: 'events' | 'tasks', snapshot: Snapshot, baseId?: string) {
  const file = store === 'events' ? paths.dbPath : paths.tasksPath;
  await fsp.writeFile(file, JSON.stringify(snapshot, null, 2), 'utf-8');
  return svc.ingestFile(USER, paths, store, snapshot, baseId);
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-service-test-'));

  console.log('--- 1. STORE → FILE MAPPING ---');
  {
    const p: UserSyncPaths = { dbDir: 'd', dbPath: 'd/database.json', tasksPath: 'd/tasks.json' };
    assert.equal(storeFileOf(p, 'events'), 'd/database.json');
    assert.equal(storeFileOf(p, 'tasks'), 'd/tasks.json');
    assert.equal(storeFileOf(p, 'settings'), null, 'Settings are not written by this path yet');
    assert.equal(storeFileOf(p, 'categories'), null, 'Categories live inside settings.json');
  }

  console.log('--- 2. OP VALIDATION ACCEPTS THE GOOD ---');
  {
    const op = validateOp(goodOp());
    assert.ok(op, 'A well-formed op is accepted');
    assert.equal(op!.opId, 'phone-android:7');
    assert.equal(op!.value, 'Physics');

    // Optional fields.
    assert.ok(validateOp({ ...goodOp(), baseLamport: 3, baseDevice: 'pc-desktop' }));
    assert.ok(validateOp({ ...goodOp(), present: true, field: 'exdates', value: '2026-09-01' }));
    assert.ok(validateOp({ ...goodOp(), value: undefined }), 'A clear (undefined value) is valid');
    assert.ok(validateOp({ ...goodOp(), value: null }), 'null is a legitimate value');
    assert.ok(validateOp({ ...goodOp(), value: { nested: { deep: [1, 2] } } }), 'Objects are fine');
    assert.ok(validateOp({ ...goodOp(), lamport: 0 }), 'Lamport 0 is valid');
    assert.ok(validateOp({ ...goodOp(), at: 0 }), 'Epoch 0 is a valid timestamp');
    assert.ok(validateOp({ ...goodOp(), at: -1 }), 'A negative clock is odd but not structurally invalid');
  }

  console.log('--- 3. OP VALIDATION REJECTS EVERYTHING ELSE ---');
  {
    const bad: [string, unknown][] = [
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not an op'],
      ['a number', 42],
      ['an array', []],
      ['empty object', {}],
      ['missing opId', { ...goodOp(), opId: undefined }],
      ['empty opId', { ...goodOp(), opId: '' }],
      ['opId too long', { ...goodOp(), opId: 'x'.repeat(201) }],
      ['numeric opId', { ...goodOp(), opId: 7 }],
      ['unknown store', { ...goodOp(), store: 'passwords' }],
      ['prototype store', { ...goodOp(), store: '__proto__' }],
      ['numeric store', { ...goodOp(), store: 1 }],
      ['empty entityId', { ...goodOp(), entityId: '' }],
      ['entityId too long', { ...goodOp(), entityId: 'x'.repeat(401) }],
      ['missing field', { ...goodOp(), field: undefined }],
      ['empty field', { ...goodOp(), field: '' }],
      ['field too long', { ...goodOp(), field: 'x'.repeat(201) }],
      ['empty device', { ...goodOp(), device: '' }],
      ['device too long', { ...goodOp(), device: 'x'.repeat(201) }],
      ['lamport NaN', { ...goodOp(), lamport: NaN }],
      ['lamport Infinity', { ...goodOp(), lamport: Infinity }],
      ['lamport negative', { ...goodOp(), lamport: -1 }],
      ['lamport fractional', { ...goodOp(), lamport: 1.5 }],
      ['lamport as string', { ...goodOp(), lamport: '7' }],
      ['at NaN', { ...goodOp(), at: NaN }],
      ['at Infinity', { ...goodOp(), at: Infinity }],
      ['at as string', { ...goodOp(), at: 'now' }],
      ['baseLamport as string', { ...goodOp(), baseLamport: '3' }],
      ['baseDevice as number', { ...goodOp(), baseDevice: 3 }],
      ['present as string', { ...goodOp(), present: 'yes' }],
    ];
    for (const [label, input] of bad) {
      assert.equal(validateOp(input), null, `Must reject: ${label}`);
    }

    // A prototype-pollution attempt must not survive validation into the log.
    const polluted = validateOp({ ...goodOp(), entityId: '__proto__', field: 'polluted' });
    assert.ok(polluted, 'An odd but structurally valid id is allowed through');
    assert.equal(({} as any).polluted, undefined, 'and nothing leaked onto Object.prototype');
  }

  console.log('--- 4. PUSH BATCH VALIDATION ---');
  {
    assert.deepEqual(validatePush('nope'), { error: 'ops must be an array' });
    assert.deepEqual(validatePush(null), { error: 'ops must be an array' });
    assert.deepEqual(validatePush({ ops: [] }), { error: 'ops must be an array' });

    const empty = validatePush([]) as { ops: SyncOp[]; rejected: number };
    assert.deepEqual(empty.ops, [], 'An empty batch is valid, not an error');
    assert.equal(empty.rejected, 0);

    const mixed = validatePush([goodOp(), 'garbage', null, { ...goodOp(), opId: 'phone-android:8' }]);
    const m = mixed as { ops: SyncOp[]; rejected: number };
    assert.equal(m.ops.length, 2, 'The sound ops survive');
    assert.equal(m.rejected, 2, 'and the rest are counted, not silently dropped');

    const huge = validatePush(Array.from({ length: 5_001 }, () => goodOp()));
    assert.ok('error' in huge, 'An absurd batch is refused outright');

    const atLimit = validatePush(Array.from({ length: 5_000 }, (_, i) => ({
      ...goodOp(), opId: `phone-android:${i}`, lamport: i,
    })));
    assert.ok(!('error' in atLimit), 'Exactly at the limit is allowed');
  }

  console.log('--- 5. DEVICE ID AND CURSOR VALIDATION ---');
  {
    assert.equal(validateDeviceId('phone-android'), 'phone-android');
    assert.equal(validateDeviceId('  phone-android  '), 'phone-android', 'Trimmed');
    assert.equal(validateDeviceId('Pixel_7a.v2-x'), 'Pixel_7a.v2-x');
    assert.equal(validateDeviceId('phone\n'), 'phone',
      'Surrounding whitespace and newlines are trimmed, not rejected');

    for (const bad of [
      null, undefined, 42, {}, [], '', 'ab', 'x'.repeat(129),
      'phone android', 'phone/../etc', 'phone:1', 'phone%00', '../../escape',
      'phone\u0000id', 'phone\tid', 'phone#1', 'phone?x=1', 'phone\back',
      'phone id\n2', 'صلاة', '💪', 'phone;drop', 'phone=1', 'phone+plus',
    ]) {
      assert.equal(validateDeviceId(bad), null, `Must reject device id: ${JSON.stringify(bad)}`);
    }

    assert.equal(validateCursor(42), 42);
    assert.equal(validateCursor(42.9), 42, 'Fractional cursors are floored');
    assert.equal(validateCursor(0), 0);
    for (const bad of [-1, NaN, Infinity, -Infinity, '5', null, undefined, {}]) {
      assert.equal(validateCursor(bad), 0, `Bad cursor becomes 0: ${String(bad)}`);
    }
  }

  console.log('--- 6. FIRST CONTACT SEEDS THE EXISTING PLANNER ---');
  {
    const paths = await freshUser('seed', {
      ev1: { title: 'Lecture', startTime: '09:00' },
      ev2: { title: 'Gym', allDay: true },
    }, { t1: { title: 'Read chapter 4' } });

    const svc = createSyncService({ now: () => 1_000 });
    const snap = await svc.snapshot(USER, paths, PH);
    assert.equal(Object.keys(snap.stores.events!).length, 2,
      'A brand-new phone receives the whole existing planner');
    assert.equal(Object.keys(snap.stores.tasks!).length, 1);
    assert.ok(snap.cursor > 0, 'and a cursor to resume from');
    assert.deepEqual(snap.conflicts, []);
  }

  console.log('--- 7. PUSH WRITES THE FILE, AND ONLY THE RIGHT FILE ---');
  {
    const paths = await freshUser('write', { ev1: { title: 'Physics', startTime: '18:00' } },
      { t1: { title: 'Task' } });
    const changed: string[][] = [];
    const svc = createSyncService({
      now: () => 2_000,
      onStoresChanged: (_u, stores) => changed.push(stores),
    });

    const tasksBefore = await fsp.readFile(paths.tasksPath, 'utf-8');
    const phone = await syncedPhone(svc, paths, PH);

    const ops = makeOps(phone.state, {
      store: 'events', entityId: 'ev1', device: PH, at: 2_000,
      changes: { startTime: '20:00' },
    });
    const res = await svc.push(USER, paths, { deviceId: PH, ops, platform: 'android' });
    assert.equal(res.accepted, 1);
    assert.equal(res.ignored, 0);

    const onDisk = await readFile(paths.dbPath);
    assert.equal(onDisk.ev1.startTime, '20:00', "The phone's edit reached database.json");
    assert.equal(onDisk.ev1.title, 'Physics', 'and the untouched field is intact');

    assert.equal(await fsp.readFile(paths.tasksPath, 'utf-8'), tasksBefore,
      'tasks.json was NOT rewritten by an event edit');
    assert.deepEqual(changed, [['events']], 'Only the events store was announced as changed');
  }

  console.log('--- 8. AN UNCHANGED PUSH DOES NOT TOUCH THE FILE ---');
  {
    const paths = await freshUser('quiet', { ev1: { title: 'a' } });
    const changed: string[][] = [];
    const svc = createSyncService({ now: () => 3_000, onStoresChanged: (_u, s) => changed.push(s) });
    await svc.snapshot(USER, paths, PH);

    const before = await fsp.stat(paths.dbPath);
    const empty = await svc.push(USER, paths, { deviceId: PH, ops: [] });
    assert.equal(empty.accepted, 0);
    const after = await fsp.stat(paths.dbPath);
    assert.equal(after.mtimeMs, before.mtimeMs, 'An empty push must not rewrite the file');
    assert.equal(changed.length, 0, 'and must not wake the open windows');
  }

  console.log('--- 9. THE QUEUE: OVERLAPPING PUSHES CANNOT LOSE EACH OTHER ---');
  {
    const paths = await freshUser('race', { ev1: { title: 'base' } });
    const svc = createSyncService({ now: () => 4_000 });
    await svc.snapshot(USER, paths, PH);

    // Twelve devices push simultaneously, each creating its own event. If the
    // queue did not serialise, the later saves would overwrite the earlier ones
    // and most of these would simply vanish.
    const pushes = Array.from({ length: 12 }, (_, i) => {
      const ops = makeOps(emptyState(), {
        store: 'events', entityId: `race-${i}`, device: `dev-${i}`,
        at: 4_000 + i, changes: { title: `from ${i}` },
      });
      return svc.push(USER, paths, { deviceId: `dev-${i}`, ops });
    });
    const results = await Promise.all(pushes);
    assert.ok(results.every(r => r.accepted === 1), 'Every push was accepted');

    const onDisk = await readFile(paths.dbPath);
    for (let i = 0; i < 12; i++) {
      assert.equal(onDisk[`race-${i}`]?.title, `from ${i}`,
        `Concurrent push ${i} survived — no lost update`);
    }
    assert.equal(onDisk.ev1.title, 'base', 'and the pre-existing event is untouched');

    const status = await svc.status(USER, paths);
    assert.equal(status.devices.length, 13, '12 pushers plus the phone that took a snapshot');
  }

  console.log('--- 10. THE QUEUE: A FAILING REQUEST DOES NOT WEDGE THE USER ---');
  {
    const paths = await freshUser('wedge', { ev1: { title: 'a' } });
    const svc = createSyncService({ now: () => 5_000 });
    await svc.snapshot(USER, paths, PH);

    // Force a failure by pointing at an unwritable directory mid-queue.
    const broken: UserSyncPaths = { ...paths, dbDir: path.join(paths.dbDir, 'nope', 'deeper') };
    await assert.rejects(
      () => svc.push(USER, broken, {
        deviceId: 'dev-x',
        ops: makeOps(emptyState(), {
          store: 'events', entityId: 'x', device: 'dev-x', at: 1, changes: { title: 'x' },
        }),
      }),
      'A save to a missing directory must reject rather than corrupt state',
    );

    // The very next request for the same user must still work.
    const after = await svc.push(USER, paths, {
      deviceId: 'dev-y',
      ops: makeOps(emptyState(), {
        store: 'events', entityId: 'y', device: 'dev-y', at: 2, changes: { title: 'y' },
      }),
    });
    assert.equal(after.accepted, 1, 'The queue recovered after a failed request');
    assert.equal((await readFile(paths.dbPath)).y?.title, 'y');
  }

  console.log('--- 11. TWO USERS NEVER BLOCK OR SEE EACH OTHER ---');
  {
    const alice = await freshUser('alice', { a1: { title: 'alice event' } });
    const bob = await freshUser('bob', { b1: { title: 'bob event' } });
    const svc = createSyncService({ now: () => 6_000 });

    const [aSnap, bSnap] = await Promise.all([
      svc.snapshot('alice', alice, 'a-phone'),
      svc.snapshot('bob', bob, 'b-phone'),
    ]);
    assert.deepEqual(Object.keys(aSnap.stores.events!), ['a1']);
    assert.deepEqual(Object.keys(bSnap.stores.events!), ['b1'], "Bob cannot see Alice's planner");

    await svc.push('alice', alice, {
      deviceId: 'a-phone',
      ops: makeOps(emptyState(), {
        store: 'events', entityId: 'a2', device: 'a-phone', at: 1, changes: { title: 'new' },
      }),
    });
    assert.equal((await readFile(bob.dbPath)).a2, undefined, "Alice's edit did not reach Bob's file");
  }

  console.log('--- 12. RESOLVING A CONFLICT, INCLUDING TWICE ---');
  {
    const paths = await freshUser('resolve', { ev1: { startTime: '18:00' } });
    const svc = createSyncService({ now: () => 7_000 });
    // The phone edits from the state it holds; the PC edits the same field.
    const phone = await syncedPhone(svc, paths, PH);
    const phoneOps = makeOps(phone.state, {
      store: 'events', entityId: 'ev1', device: PH, at: 7_100,
      changes: { startTime: '20:00' },
    });
    await pcSave(svc, paths, 'events', { ev1: { startTime: '18:30' } });
    const pushed = await svc.push(USER, paths, { deviceId: PH, ops: phoneOps });
    assert.equal(pushed.conflicts.length, 1, 'The same field from two directions conflicts');

    const open = await svc.conflicts(USER, paths);
    assert.equal(open.length, 1, 'and the card is queued for the sidebar');
    const card = open[0];

    const r1 = await svc.resolve(USER, paths, { conflictId: card.id, choice: 'loser', deviceId: PH });
    assert.equal(r1.ok, true);
    assert.equal(r1.alreadyResolved, false);
    assert.equal(r1.conflicts.length, 0, 'The card is closed');

    const onDisk = await readFile(paths.dbPath);
    assert.equal(onDisk.ev1.startTime, card.loser.value, 'The chosen value reached the file');

    // The other device answers the same card a moment later. This must be a
    // benign no-op, not an error the user has to look at.
    const r2 = await svc.resolve(USER, paths, { conflictId: card.id, choice: 'winner', deviceId: 'pc-desktop' });
    assert.equal(r2.ok, true);
    assert.equal(r2.alreadyResolved, true, 'Answering an already-answered card is not an error');
    assert.equal((await readFile(paths.dbPath)).ev1.startTime, card.loser.value,
      'and it did not overwrite the answer that was already given');

    // An id that never existed behaves the same way.
    const r3 = await svc.resolve(USER, paths, { conflictId: 'nonsense', choice: 'winner', deviceId: PH });
    assert.equal(r3.alreadyResolved, true);
  }

  console.log('--- 13. PULL / ACK CYCLE AND STATUS ---');
  {
    const paths = await freshUser('cycle', { ev1: { title: 'a' } });
    const svc = createSyncService({ now: () => 8_000 });
    const snap = await svc.snapshot(USER, paths, PH);

    await pcSave(svc, paths, 'events', { ev1: { title: 'a' }, ev2: { title: 'b' } });

    const pull = await svc.pull(USER, paths, PH, snap.cursor);
    assert.ok(pull.ops.length > 0, 'The phone sees the new event');
    assert.ok(pull.ops.every(o => o.device !== PH), 'and none of its own ops');
    assert.equal(pull.needsFullResync, false);

    await svc.ack(USER, paths, PH, pull.cursor);
    const status = await svc.status(USER, paths);
    const dev = status.devices.find(d => d.deviceId === PH)!;
    assert.equal(dev.behind, 0, 'After acknowledging, the phone is fully caught up');
    assert.equal(status.openConflicts, 0);

    // Pulling again yields nothing — no busy-loop.
    const again = await svc.pull(USER, paths, PH, pull.cursor);
    assert.equal(again.ops.length, 0, 'A caught-up phone polls for nothing');
  }

  console.log('--- 14. STATE SURVIVES A SERVICE RESTART ---');
  {
    const paths = await freshUser('restart', { ev1: { title: 'original' } });
    const svc1 = createSyncService({ now: () => 9_000 });
    await svc1.snapshot(USER, paths, PH);
    await svc1.push(USER, paths, {
      deviceId: PH,
      ops: makeOps(emptyState(), {
        store: 'events', entityId: 'ev2', device: PH, at: 9_000, changes: { title: 'from phone' },
      }),
    });

    // A completely fresh service, as after restarting the dev server.
    const svc2 = createSyncService({ now: () => 10_000 });
    const status = await svc2.status(USER, paths);
    assert.ok(status.devices.some(d => d.deviceId === PH), 'The device is remembered across a restart');

    const pull = await svc2.pull(USER, paths, 'another-phone', 0);
    const ids = new Set(pull.ops.map(o => o.entityId));
    assert.ok(ids.has('ev2'), "The phone's op is still in the log after a restart");
  }

  console.log('--- 15. A DELETE FROM THE PHONE REMOVES THE RECORD FROM THE FILE ---');
  {
    const paths = await freshUser('delete', { ev1: { title: 'a' }, ev2: { title: 'b' } });
    const svc = createSyncService({ now: () => 11_000 });
    // The phone's view must be real, so the delete carries a proper base stamp.
    const phone = await syncedPhone(svc, paths, PH);
    const ops = makeOps(phone.state, {
      store: 'events', entityId: 'ev2', device: PH, at: 11_100, changes: { __deleted: true },
    });
    await svc.push(USER, paths, { deviceId: PH, ops });

    const onDisk = await readFile(paths.dbPath);
    assert.equal(onDisk.ev2, undefined, 'The deleted event is gone from database.json');
    assert.equal(onDisk.ev1.title, 'a', 'and the other one is untouched');
  }

  console.log('--- 16. GOOGLE BOOKKEEPING IS NEVER CLOBBERED BY A PHONE WRITE ---');
  {
    const paths = await freshUser('gcal', {
      ev1: { title: 'Lecture', startTime: '09:00', gCalETag: '"abc"', lastSyncedAt: 555 },
    });
    const svc = createSyncService({ now: () => 12_000 });
    const phone = await syncedPhone(svc, paths, PH);
    await svc.push(USER, paths, {
      deviceId: PH,
      ops: makeOps(phone.state, {
        store: 'events', entityId: 'ev1', device: PH, at: 12_100, changes: { startTime: '11:00' },
      }),
    });

    const onDisk = await readFile(paths.dbPath);
    assert.equal(onDisk.ev1.startTime, '11:00', "The phone's move landed");
    assert.equal(onDisk.ev1.gCalETag, '"abc"', 'and the Google ETag survived');
    assert.equal(onDisk.ev1.lastSyncedAt, 555, 'as did the sync timestamp');
  }

  console.log('--- 17. HOSTILE OPS THAT PASS VALIDATION STILL CANNOT CORRUPT THE FILE ---');
  {
    const paths = await freshUser('hostile', { ev1: { title: 'a' } });
    const svc = createSyncService({ now: () => 13_000 });
    await svc.snapshot(USER, paths, PH);

    // Structurally valid but semantically absurd: an enormous lamport, a huge
    // value, an id shaped like an occurrence, and a field named like a getter.
    const ops: SyncOp[] = [
      { opId: 'x:1', store: 'events', entityId: 'ev::2026-09-01', field: 'title',
        value: 'y'.repeat(50_000), device: 'x', lamport: 999_999_999, at: 1 },
      { opId: 'x:2', store: 'events', entityId: 'ev1', field: 'constructor',
        value: 'not a constructor', device: 'x', lamport: 999_999_998, at: 1 },
      { opId: 'x:3', store: 'events', entityId: '__proto__', field: 'polluted',
        value: true, device: 'x', lamport: 999_999_997, at: 1 },
    ];
    const res = await svc.push(USER, paths, { deviceId: 'weird-device', ops });
    assert.equal(res.accepted, 3, 'They are structurally valid, so they are accepted');

    const onDisk = await readFile(paths.dbPath);
    assert.equal(onDisk['ev::2026-09-01'].title.length, 50_000, 'The huge value round-tripped');
    assert.equal(onDisk.ev1.constructor, 'not a constructor', 'A field named constructor is just data');
    assert.equal(({} as any).polluted, undefined, 'Object.prototype was not polluted');
    assert.equal(onDisk.ev1.title, 'a', 'and the original data is intact');

    // The absurd lamport must not break subsequent ordering.
    const after = await svc.push(USER, paths, {
      deviceId: PH,
      ops: makeOps(emptyState(), {
        store: 'events', entityId: 'ev1', device: PH, at: 2, changes: { title: 'later' },
      }),
    });
    assert.equal(after.accepted, 1, 'The service still works afterwards');
  }

  console.log('--- 18. INGEST FROM THE PC IS SAFE TO CALL ON EVERY SAVE ---');
  {
    const paths = await freshUser('ingest', { ev1: { title: 'a' } });
    const svc = createSyncService({ now: () => 14_000 });
    await svc.snapshot(USER, paths, PH);

    for (let i = 0; i < 20; i++) {
      const r = await pcSave(svc, paths, 'events', { ev1: { title: 'a' } });
      assert.equal(r.ops, 0, `Identical save ${i} produced no ops`);
    }
    const changed = await pcSave(svc, paths, 'events', { ev1: { title: 'b' } });
    assert.equal(changed.ops, 1, 'A real change produces exactly one op');

    const status = await svc.status(USER, paths);
    assert.ok(status.logSize < 10, 'and the log did not balloon');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (sync service: validation, queue, write-back, resolution)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
