// Tests the /api/sync request layer: routing, method handling, hostile bodies,
// status codes, and the full phone lifecycle driven purely through requests.
//
// These run against `handleSyncRequest`, which is the exact function the dev
// server middleware calls — the middleware itself is a ten-line adapter that
// parses a URL and writes JSON, so everything that can actually be wrong is
// covered here rather than being untestable inside vite.config.ts.
//
// Run with: npx tsx src/lib/syncEndpoints.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyState, makeOps, mergeOps, type SyncOp } from './sync';
import {
  createSyncService,
  handleSyncRequest,
  type SyncService,
  type UserSyncPaths,
} from '../../sync-service';

const USER = 'mamoun';
const PH = 'phone-android';
let tmpRoot = '';

async function freshUser(label: string, seed: Record<string, unknown> = {}) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
  };
  await fsp.writeFile(paths.dbPath, JSON.stringify(seed, null, 2), 'utf-8');
  await fsp.writeFile(paths.tasksPath, '{}', 'utf-8');
  return paths;
}

const readDb = async (p: UserSyncPaths) => JSON.parse(await fsp.readFile(p.dbPath, 'utf-8'));

/** Fire a request the way the middleware does. */
function call(
  svc: SyncService,
  paths: UserSyncPaths,
  action: string,
  method: string,
  body?: unknown,
) {
  return handleSyncRequest(svc, USER, paths, { action, method, body });
}

const post = (svc: SyncService, p: UserSyncPaths, a: string, b: unknown) => call(svc, p, a, 'POST', b);
const get = (svc: SyncService, p: UserSyncPaths, a: string) => call(svc, p, a, 'GET');

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
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-endpoints-test-'));

  console.log('--- 1. ROUTING: UNKNOWN PATHS FALL THROUGH ---');
  {
    const paths = await freshUser('routing');
    const svc = createSyncService({ now: () => 1_000 });

    for (const action of ['', 'nonsense', 'push/extra', 'events', 'notifications']) {
      const r = await post(svc, paths, action, { deviceId: PH });
      assert.equal(r.handled, false,
        `"${action}" must fall through to the next middleware, not 404 the request`);
    }

    // A known action with the wrong method also falls through, so a browser
    // hitting /api/sync/push in the address bar does not get a confusing error.
    assert.equal((await get(svc, paths, 'push')).handled, false, 'GET /push falls through');
    assert.equal((await call(svc, paths, 'status', 'POST', { deviceId: PH })).handled, false,
      'POST /status falls through');
    assert.equal((await call(svc, paths, 'pull', 'DELETE', {})).handled, false);
    assert.equal((await call(svc, paths, 'pull', 'PUT', {})).handled, false);
  }

  console.log('--- 2. ROUTING: SLASHES AND CASING ARE NORMALISED ---');
  {
    const paths = await freshUser('slashes');
    const svc = createSyncService({ now: () => 1_000 });

    for (const action of ['snapshot', '/snapshot', 'snapshot/', '//snapshot//']) {
      const r = await post(svc, paths, action, { deviceId: PH });
      assert.equal(r.handled, true, `"${action}" routes to snapshot`);
      assert.equal(r.status, 200);
    }
    // Lower-case methods (some HTTP clients) still work.
    assert.equal((await call(svc, paths, 'status', 'get')).status, 200, 'A lowercase method works');
  }

  console.log('--- 3. DEVICE ID IS REQUIRED AND VALIDATED ON EVERY WRITE ROUTE ---');
  {
    const paths = await freshUser('device');
    const svc = createSyncService({ now: () => 1_000 });

    for (const action of ['snapshot', 'pull', 'ack', 'push', 'resolve']) {
      for (const deviceId of [undefined, null, '', 'ab', 42, {}, [], 'has space', '../escape']) {
        const r = await post(svc, paths, action, { deviceId });
        assert.equal(r.status, 400,
          `${action} with deviceId ${JSON.stringify(deviceId)} must be refused`);
        assert.ok(
          String((r.payload as any).error).includes('deviceId'),
          'and the error must say which field is wrong',
        );
      }
    }

    // A completely absent body is refused the same way, not a crash.
    for (const body of [undefined, null, {}, 'a string', 42]) {
      const r = await post(svc, paths, 'push', body);
      assert.equal(r.status, 400, `A body of ${JSON.stringify(body)} is refused cleanly`);
    }

    // The read-only routes need no device id at all.
    assert.equal((await get(svc, paths, 'status')).status, 200);
    assert.equal((await get(svc, paths, 'conflicts')).status, 200);
  }

  console.log('--- 4. PUSH BODY VALIDATION ---');
  {
    const paths = await freshUser('push');
    const svc = createSyncService({ now: () => 1_000 });

    for (const ops of [undefined, null, 'nope', 42, {}, { ops: [] }]) {
      const r = await post(svc, paths, 'push', { deviceId: PH, ops });
      assert.equal(r.status, 400, `ops of ${JSON.stringify(ops)} is refused`);
      assert.equal((r.payload as any).error, 'ops must be an array');
    }

    // An empty array is legal — it is how a phone registers itself and polls.
    const empty = await post(svc, paths, 'push', { deviceId: PH, ops: [] });
    assert.equal(empty.status, 200);
    assert.equal((empty.payload as any).accepted, 0);
    assert.equal((empty.payload as any).rejected, 0);

    // Malformed ops are counted and reported, never silently swallowed.
    const junk = await post(svc, paths, 'push', {
      deviceId: PH,
      ops: [null, 'garbage', { opId: 'x' }, { store: 'passwords' }],
    });
    assert.equal(junk.status, 200);
    assert.equal((junk.payload as any).accepted, 0);
    assert.equal((junk.payload as any).rejected, 4,
      'The phone is told its ops were rejected so the bug is visible');

    // Absurd batch sizes are refused outright rather than processed.
    const flood = await post(svc, paths, 'push', {
      deviceId: PH,
      ops: Array.from({ length: 6_000 }, (_, i) => ({
        opId: `d:${i}`, store: 'events', entityId: 'e', field: 'title',
        value: i, device: 'd', lamport: i + 1, at: 0,
      })),
    });
    assert.equal(flood.status, 400, 'A 6000-op push is refused');
    assert.ok(String((flood.payload as any).error).includes('too many'));
  }

  console.log('--- 5. NAME AND PLATFORM ARE TRUNCATED, NOT TRUSTED ---');
  {
    const paths = await freshUser('labels');
    const svc = createSyncService({ now: () => 1_000 });

    await post(svc, paths, 'push', {
      deviceId: PH,
      ops: [],
      name: 'N'.repeat(500),
      platform: 'P'.repeat(500),
    });
    const status = await get(svc, paths, 'status');
    const dev = (status.payload as any).devices.find((d: any) => d.deviceId === PH);
    assert.equal(dev.name.length, 80, 'A 500-character device name is cut to 80');
    assert.equal(dev.platform.length, 40, 'and the platform to 40');

    // Non-string labels are ignored rather than stored as objects.
    await post(svc, paths, 'push', { deviceId: PH, ops: [], name: { evil: true }, platform: 42 });
    const status2 = await get(svc, paths, 'status');
    const dev2 = (status2.payload as any).devices.find((d: any) => d.deviceId === PH);
    assert.equal(dev2.name.length, 80, 'A non-string name does not overwrite the good one');
  }

  console.log('--- 6. RESOLVE BODY VALIDATION ---');
  {
    const paths = await freshUser('resolve-validate');
    const svc = createSyncService({ now: () => 1_000 });

    for (const choice of [undefined, null, '', 'yes', 'WINNER', 42, {}, ['loser']]) {
      const r = await post(svc, paths, 'resolve', { deviceId: PH, choice, conflictId: 'c1' });
      assert.equal(r.status, 400, `choice ${JSON.stringify(choice)} is refused`);
      assert.ok(String((r.payload as any).error).includes('choice'));
    }
    for (const conflictId of [undefined, null, '', 42, {}]) {
      const r = await post(svc, paths, 'resolve', { deviceId: PH, choice: 'winner', conflictId });
      assert.equal(r.status, 400, `conflictId ${JSON.stringify(conflictId)} is refused`);
      assert.ok(String((r.payload as any).error).includes('conflictId'));
    }
    // A valid shape naming a card that does not exist is a 200 no-op.
    const missing = await post(svc, paths, 'resolve', {
      deviceId: PH, choice: 'winner', conflictId: 'never-existed',
    });
    assert.equal(missing.status, 200);
    assert.equal((missing.payload as any).alreadyResolved, true);
  }

  console.log('--- 7. THE FULL PHONE LIFECYCLE, ENTIRELY THROUGH REQUESTS ---');
  {
    const paths = await freshUser('lifecycle', {
      ev1: { title: 'Physics', startTime: '18:00', categoryId: 'uni' },
      ev2: { title: 'Gym', allDay: true },
    });
    const svc = createSyncService({ now: () => 2_000 });

    // (a) First launch: take a snapshot.
    const snap = await post(svc, paths, 'snapshot', { deviceId: PH, platform: 'android' });
    const snapBody = snap.payload as any;
    assert.equal(Object.keys(snapBody.stores.events).length, 2, 'The phone gets the whole planner');
    assert.ok(snapBody.cursor > 0);
    assert.deepEqual(snapBody.conflicts, []);

    // (b) It builds its local state from a pull, then goes offline and edits.
    const pull = await post(svc, paths, 'pull', { deviceId: PH, since: 0 });
    const phone = mergeOps(emptyState(), (pull.payload as any).ops as SyncOp[]).state;
    const offline = makeOps(phone, {
      store: 'events', entityId: 'ev1', device: PH, at: 3_000,
      changes: { startTime: '20:00' },
    });

    // (c) Meanwhile the PC renames it.
    await pcSave(svc, paths, 'events', {
      ev1: { title: 'Physics revision', startTime: '18:00', categoryId: 'uni' },
      ev2: { title: 'Gym', allDay: true },
    });

    // (d) The phone comes back and pushes.
    const push = await post(svc, paths, 'push', { deviceId: PH, ops: offline, platform: 'android' });
    assert.equal(push.status, 200);
    assert.equal((push.payload as any).accepted, 1);
    assert.equal((push.payload as any).conflicts.length, 0, 'Different fields merge silently');

    const onDisk = await readDb(paths);
    assert.equal(onDisk.ev1.startTime, '20:00', "The phone's offline move reached the file");
    assert.equal(onDisk.ev1.title, 'Physics revision', "and the PC's rename survived");

    // (e) It pulls the rename back and acknowledges.
    const pull2 = await post(svc, paths, 'pull', { deviceId: PH, since: (pull.payload as any).cursor });
    assert.ok((pull2.payload as any).ops.length > 0);
    const ack = await post(svc, paths, 'ack', { deviceId: PH, cursor: (pull2.payload as any).cursor });
    assert.equal(ack.status, 200);

    // (f) It is now fully caught up and polling costs nothing.
    const idle = await post(svc, paths, 'pull', { deviceId: PH, since: (ack.payload as any).cursor });
    assert.equal((idle.payload as any).ops.length, 0, 'A caught-up phone pulls nothing');

    const status = await get(svc, paths, 'status');
    const dev = (status.payload as any).devices.find((d: any) => d.deviceId === PH);
    assert.equal(dev.behind, 0, 'and reports as fully in sync');
  }

  console.log('--- 8. A CONFLICT, RAISED AND ANSWERED OVER HTTP ---');
  {
    const paths = await freshUser('conflict-http', { ev1: { startTime: '18:00' } });
    const svc = createSyncService({ now: () => 4_000 });

    const pull = await post(svc, paths, 'pull', { deviceId: PH, since: 0 });
    const phone = mergeOps(emptyState(), (pull.payload as any).ops as SyncOp[]).state;
    const phoneOps = makeOps(phone, {
      store: 'events', entityId: 'ev1', device: PH, at: 4_100,
      changes: { startTime: '20:00' },
    });

    await pcSave(svc, paths, 'events', { ev1: { startTime: '18:30' } });
    const push = await post(svc, paths, 'push', { deviceId: PH, ops: phoneOps });
    assert.equal((push.payload as any).conflicts.length, 1, 'The race is reported in the response');

    const listed = await get(svc, paths, 'conflicts');
    const cards = (listed.payload as any).conflicts;
    assert.equal(cards.length, 1, 'and the card is listed for the sidebar');
    assert.equal(cards[0].field, 'startTime');
    assert.ok(cards[0].winner && cards[0].loser, 'with both values, so nothing is lost');

    const answered = await post(svc, paths, 'resolve', {
      deviceId: PH, conflictId: cards[0].id, choice: 'loser',
    });
    assert.equal(answered.status, 200);
    assert.equal((answered.payload as any).conflicts.length, 0, 'The card closes');
    assert.equal((await readDb(paths)).ev1.startTime, cards[0].loser.value,
      'and the chosen value reached the file');

    // The PC answers the same card a moment later. Benign.
    const late = await post(svc, paths, 'resolve', {
      deviceId: 'pc-desktop', conflictId: cards[0].id, choice: 'winner',
    });
    assert.equal(late.status, 200);
    assert.equal((late.payload as any).alreadyResolved, true);
    assert.equal((await readDb(paths)).ev1.startTime, cards[0].loser.value,
      'and it did not undo the answer already given');
  }

  console.log('--- 9. CONCURRENT REQUESTS THROUGH THE ROUTE LAYER ---');
  {
    const paths = await freshUser('concurrent', { ev1: { title: 'base' } });
    const svc = createSyncService({ now: () => 5_000 });
    await post(svc, paths, 'snapshot', { deviceId: PH });

    // Ten devices push, pull, ack and read status all at once.
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const ops = makeOps(emptyState(), {
        store: 'events', entityId: `c${i}`, device: `dev-${i}`,
        at: 5_000 + i, changes: { title: `from ${i}` },
      });
      work.push(post(svc, paths, 'push', { deviceId: `dev-${i}`, ops }));
      work.push(post(svc, paths, 'pull', { deviceId: `dev-${i}`, since: 0 }));
      work.push(get(svc, paths, 'status'));
      work.push(get(svc, paths, 'conflicts'));
    }
    const all = await Promise.all(work);
    assert.ok(all.every((r: any) => r.status === 200), 'Every concurrent request succeeded');

    const onDisk = await readDb(paths);
    for (let i = 0; i < 10; i++) {
      assert.equal(onDisk[`c${i}`]?.title, `from ${i}`, `Concurrent push ${i} was not lost`);
    }
    assert.equal(onDisk.ev1.title, 'base');
  }

  console.log('--- 10. CURSORS ARE SANITISED RATHER THAN TRUSTED ---');
  {
    const paths = await freshUser('cursors', { ev1: { title: 'a' } });
    const svc = createSyncService({ now: () => 6_000 });
    await post(svc, paths, 'snapshot', { deviceId: PH });

    for (const since of [-1, NaN, Infinity, -Infinity, 'five', null, undefined, {}, []]) {
      const r = await post(svc, paths, 'pull', { deviceId: PH, since });
      assert.equal(r.status, 200, `A cursor of ${String(since)} is sanitised, not an error`);
      assert.ok(Array.isArray((r.payload as any).ops));
    }

    // A cursor far in the future must not corrupt the device record.
    await post(svc, paths, 'ack', { deviceId: PH, cursor: 9_999_999 });
    const status = await get(svc, paths, 'status');
    const dev = (status.payload as any).devices.find((d: any) => d.deviceId === PH);
    assert.equal(dev.behind, 0, 'An over-large ack simply means "fully caught up"');

    // The cursor is a LOG POSITION, so an over-large ack is clamped to the head
    // rather than stored. Storing it would make the device skip everything
    // written afterwards -- silence that looks exactly like sync being off.
    const head = (status.payload as any).seq;
    assert.equal(dev.cursor, head, 'An impossible position is clamped to the head');

    // And a later, smaller ack does not move it backwards.
    await post(svc, paths, 'ack', { deviceId: PH, cursor: 1 });
    const status2 = await get(svc, paths, 'status');
    const dev2 = (status2.payload as any).devices.find((d: any) => d.deviceId === PH);
    assert.equal(dev2.cursor, head, 'A stale ack cannot un-acknowledge');
  }

  console.log('--- 11. EVERY RESPONSE IS JSON-SERIALISABLE ---');
  {
    // The middleware calls JSON.stringify on whatever comes back. A circular or
    // undefined-laden payload would throw INSIDE the response, leaving the phone
    // with a half-written body it cannot parse.
    const paths = await freshUser('serialise', { ev1: { title: 'a', notify: { enabled: true } } });
    const svc = createSyncService({ now: () => 7_000 });

    const responses = [
      await post(svc, paths, 'snapshot', { deviceId: PH }),
      await post(svc, paths, 'pull', { deviceId: PH, since: 0 }),
      await post(svc, paths, 'push', { deviceId: PH, ops: [] }),
      await post(svc, paths, 'ack', { deviceId: PH, cursor: 1 }),
      await get(svc, paths, 'status'),
      await get(svc, paths, 'conflicts'),
      await post(svc, paths, 'push', { deviceId: PH, ops: 'bad' }),
      await post(svc, paths, 'resolve', { deviceId: PH, choice: 'nope', conflictId: 'x' }),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.payload);
      assert.equal(typeof text, 'string', 'Payload serialises');
      assert.doesNotThrow(() => JSON.parse(text), 'and parses back');
    }
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (sync endpoints: routing, validation, lifecycle)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
