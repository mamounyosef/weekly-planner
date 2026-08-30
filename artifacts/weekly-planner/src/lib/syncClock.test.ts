// Tests the one thing that decides who wins a merge: the lamport clock.
//
// THE BUG THIS SUITE EXISTS FOR
// `createTransport.pull()` rebuilds the server's answer field by field — right,
// because the body is untrusted — but it left `lamport` out. `adoptClock` was
// therefore a no-op on the real device for its entire life, and the phone's
// clock only ever rose to the highest stamp among ops it happened to be sent.
//
// The PC bumps the server clock constantly (every keystroke in a title writes an
// `updatedAt` op), so the phone ran permanently behind. A tap made on the phone
// at 22:09 was stamped BELOW a change the PC had written at 22:08 — and lost.
// From the user's chair: "I tick it on my phone and nothing happens." Nothing
// was broken in the merge engine; the phone was simply always ranked older.
//
// Every test here is written from real time rather than from clock values: the
// action that happened LAST must be the one that survives.
//
// Run with: npx tsx src/lib/syncClock.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyState, mergeOps, readStore, type SyncOp } from './sync';
import {
  adoptClock,
  applyLocalChange,
  emptyClientData,
  highestLamport,
  syncOnce,
  readClientStore,
  type ClientData,
  type SyncTransport,
} from './syncClient';
import { createTransport } from './syncTransport';
import { createSyncService, type UserSyncPaths } from '../../sync-service';
import { handleSyncRequest } from '../../sync-service';

const USER = 'mamoun';
const PHONE = 'android-clocktest';
let tmpRoot = '';

async function freshUser(label: string, events: Record<string, unknown> = {}) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
  };
  await fsp.writeFile(paths.dbPath, JSON.stringify(events, null, 2), 'utf-8');
  await fsp.writeFile(paths.tasksPath, '{}', 'utf-8');
  return paths;
}

/** The service, wired to the client transport contract directly. */
function directTransport(svc: any, paths: UserSyncPaths): SyncTransport {
  return {
    pull: (d, since) => svc.pull(USER, paths, d, since),
    push: (d, ops) => svc.push(USER, paths, { deviceId: d, ops }),
    ack: (d, c) => svc.ack(USER, paths, d, c),
    snapshot: d => svc.snapshot(USER, paths, d),
    resolve: (d, id, choice) => svc.resolve(USER, paths, { conflictId: id, choice, deviceId: d }),
  };
}

/**
 * The REAL transport, over a fake fetch that runs the real HTTP handler.
 *
 * This is the layer the bug lived in, so a test that bypasses it proves nothing.
 * Everything goes through JSON serialisation and the same field-by-field rebuild
 * the phone performs.
 */
function httpTransport(svc: any, paths: UserSyncPaths) {
  const fetchImpl = async (url: string, init: any) => {
    const action = new URL(url).pathname.replace(/^\/api\/sync/, '');
    const body = init?.body ? JSON.parse(init.body) : {};
    const answer = await handleSyncRequest(svc, USER, paths, {
      action, method: init?.method ?? 'GET', body,
    });
    const text = JSON.stringify(answer.payload);
    return {
      ok: answer.status < 400,
      status: answer.status,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return createTransport({
    baseUrl: 'http://pc.local',
    session: 'session-token',
    fetchImpl: fetchImpl as any,
  });
}

/** A PC edit, applied the way the dev server applies one. */
async function pcEdits(svc: any, paths: UserSyncPaths, snapshot: Record<string, unknown>) {
  await fsp.writeFile(paths.dbPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  await svc.ingestFile(USER, paths, 'events', snapshot);
}

const doneOn = (rec: any): string[] => [...(rec?.completedDates ?? [])].sort();

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-clock-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. THE REAL TRANSPORT CARRIES THE SERVER CLOCK ---');
  {
    const paths = await freshUser('carries', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    // Push the server's clock far ahead with ordinary PC edits.
    for (let i = 0; i < 30; i++) {
      await pcEdits(svc, paths, { ev1: { content: `Lecture ${i}` } });
    }
    const server = await svc.status(USER, paths);
    assert.ok(server.lamport > 20, 'The PC has moved the clock well past zero');

    const pulled = await t.pull(PHONE, 0);
    assert.equal(pulled.lamport, server.lamport,
      'pull() reports the server clock — omitting it made adoptClock a no-op forever');

    const pushed = await t.push(PHONE, []);
    assert.equal(pushed.lamport, server.lamport, 'and so does push()');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. A PHONE THAT SYNCS IS NEVER LEFT BEHIND ---');
  {
    const paths = await freshUser('catchup', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    for (let round = 0; round < 15; round++) {
      await pcEdits(svc, paths, { ev1: { content: `Lecture ${round}` } });
      phone = (await syncOnce(phone, t, 2_000 + round)).data;
      const server = await svc.status(USER, paths);
      assert.equal(phone.state.lamport, server.lamport,
        `After sync ${round} the phone's clock equals the server's`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. THE REPORTED BUG: THE LATER TAP WINS ---');
  {
    // Exactly the sequence from his oplog. The PC ticks an event, the phone
    // syncs, then the user un-ticks it ON THE PHONE a second later. The phone's
    // action happened last, so it must be what survives.
    const paths = await freshUser('lasttap', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    // The PC ticks it off, then keeps typing — bumping the clock hard, which is
    // what used to bury the phone's edit.
    await pcEdits(svc, paths, { ev1: { content: 'Lecture', completedDates: ['2026-08-29'] } });
    for (let i = 0; i < 25; i++) {
      await pcEdits(svc, paths, {
        ev1: { content: `Lecture${'!'.repeat(i)}`, completedDates: ['2026-08-29'] },
      });
    }

    phone = (await syncOnce(phone, t, 2_000)).data;
    assert.deepEqual(doneOn(readClientStore(phone, 'events').ev1), ['2026-08-29'],
      'The phone sees the PC tick');

    // Now the user un-ticks it on the phone. This is the LAST thing that happened.
    phone = applyLocalChange(phone, {
      store: 'events', entityId: 'ev1', changes: { completedDates: [] }, at: 3_000,
    });
    phone = (await syncOnce(phone, t, 3_100)).data;

    const onServer = await svc.snapshot(USER, paths, 'probe');
    assert.deepEqual(doneOn(onServer.stores.events?.ev1), [],
      'The un-tick made on the phone is what the server ends up holding');
    assert.deepEqual(doneOn(JSON.parse(await fsp.readFile(paths.dbPath, 'utf-8')).ev1), [],
      'and it is what the PC file shows');
    assert.deepEqual(doneOn(readClientStore(phone, 'events').ev1), [],
      'and the phone does not flip back on the next sync');

    // One more round trip, because the old failure only showed itself when the
    // phone pulled its own loss back.
    phone = (await syncOnce(phone, t, 4_000)).data;
    assert.deepEqual(doneOn(readClientStore(phone, 'events').ev1), [],
      'and it is still un-ticked after another sync');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. AND THE OTHER DIRECTION: THE PC WINS WHEN IT GOES LAST ---');
  {
    const paths = await freshUser('pclast', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    phone = applyLocalChange(phone, {
      store: 'events', entityId: 'ev1', changes: { completedDates: ['2026-08-29'] }, at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;

    // The PC now un-ticks it, after the phone's change has landed.
    const disk = JSON.parse(await fsp.readFile(paths.dbPath, 'utf-8'));
    assert.deepEqual(doneOn(disk.ev1), ['2026-08-29'], 'The phone tick reached the PC file');
    await pcEdits(svc, paths, { ...disk, ev1: { ...disk.ev1, completedDates: [] } });

    phone = (await syncOnce(phone, t, 3_000)).data;
    assert.deepEqual(doneOn(readClientStore(phone, 'events').ev1), [],
      'The PC un-tick reaches the phone');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. TWENTY ALTERNATING TAPS, EACH ONE STICKS ---');
  {
    // The property that actually matters day to day: whoever acted last wins,
    // every single time, no matter how many times control changes hands.
    const paths = await freshUser('alternating', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    for (let i = 0; i < 20; i++) {
      const wantDone = i % 2 === 0;
      if (i % 3 === 0) {
        // The PC acts.
        const disk = JSON.parse(await fsp.readFile(paths.dbPath, 'utf-8'));
        await pcEdits(svc, paths, {
          ...disk,
          ev1: { ...disk.ev1, completedDates: wantDone ? ['2026-08-29'] : [] },
        });
        phone = (await syncOnce(phone, t, 10_000 + i)).data;
      } else {
        // The phone acts.
        phone = applyLocalChange(phone, {
          store: 'events',
          entityId: 'ev1',
          changes: { completedDates: wantDone ? ['2026-08-29'] : [] },
          at: 10_000 + i,
        });
        phone = (await syncOnce(phone, t, 10_100 + i)).data;
      }

      const expected = wantDone ? ['2026-08-29'] : [];
      const snap = await svc.snapshot(USER, paths, 'probe');
      assert.deepEqual(doneOn(snap.stores.events?.ev1), expected,
        `Round ${i}: the server holds what was done last`);
      assert.deepEqual(doneOn(readClientStore(phone, 'events').ev1), expected,
        `Round ${i}: and so does the phone`);
      assert.deepEqual(
        doneOn(JSON.parse(await fsp.readFile(paths.dbPath, 'utf-8')).ev1), expected,
        `Round ${i}: and so does the PC file`,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. A TAP MADE OFFLINE STILL LANDS WHEN THE PC IS QUIET ---');
  {
    const paths = await freshUser('offline', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    // Offline: several taps queue up with no chance to adopt anything.
    for (let i = 0; i < 5; i++) {
      phone = applyLocalChange(phone, {
        store: 'events', entityId: 'ev1',
        changes: { completedDates: i % 2 === 0 ? ['2026-08-29'] : [] },
        at: 2_000 + i,
      });
    }
    assert.equal(phone.outbox.length > 0, true, 'The taps are queued');

    phone = (await syncOnce(phone, t, 3_000)).data;
    assert.equal(phone.outbox.length, 0, 'and all of them are sent');
    // Five alternating taps starting with a tick: the fifth is a tick.
    const snap = await svc.snapshot(USER, paths, 'probe');
    assert.deepEqual(doneOn(snap.stores.events?.ev1), ['2026-08-29'],
      'The last of the offline taps is the one that stands');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. adoptClock AND highestLamport, UNIT BY UNIT ---');
  {
    const base = { ...emptyState(), lamport: 50 };

    assert.equal(adoptClock(base, 80).lamport, 80, 'A higher server clock is taken');
    assert.equal(adoptClock(base, 20).lamport, 50, 'A lower one is ignored');
    assert.equal(adoptClock(base, 50).lamport, 50, 'An equal one changes nothing');
    assert.equal(adoptClock(base, undefined), base, 'undefined returns the SAME object');
    assert.equal(adoptClock(base, NaN), base, 'and so does NaN');
    assert.equal(adoptClock(base, Infinity), base, 'and Infinity');
    assert.equal(adoptClock(base, -5).lamport, 50, 'A negative clock cannot drag us back');
    assert.equal(adoptClock(base, 80.9).lamport, 80, 'A fractional clock is floored');

    const op = (lamport: number): SyncOp => ({
      opId: `d:${lamport}`, store: 'events', entityId: 'e', field: 'f',
      value: 1, device: 'd', lamport, at: 0,
    });
    assert.equal(highestLamport([]), undefined, 'An empty batch reports nothing');
    assert.equal(highestLamport([op(3), op(9), op(4)]), 9, 'The highest stamp is found');
    assert.equal(highestLamport([op(9), op(3)]), 9, 'regardless of order');
    assert.equal(highestLamport([{ ...op(1), lamport: NaN as any }]), undefined,
      'A nonsense stamp is skipped rather than poisoning the result');
    assert.equal(highestLamport([{ ...op(1), lamport: NaN as any }, op(7)]), 7,
      'and does not hide a good one beside it');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. A SERVER THAT REPORTS NO CLOCK STILL WORKS ---');
  {
    // Belt and braces: if the field were ever dropped again, the ops themselves
    // still carry the clock forward. This is what stops one omission becoming
    // another silent evening of lost taps.
    const paths = await freshUser('noclock', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const inner = directTransport(svc, paths);
    const stripped: SyncTransport = {
      ...inner,
      pull: async (d, since) => {
        const r = await inner.pull(d, since);
        return { ...r, lamport: undefined };
      },
      push: async (d, ops) => {
        const r = await inner.push(d, ops);
        return { ...r, lamport: undefined };
      },
    };

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, stripped, 1_000)).data;
    for (let i = 0; i < 20; i++) {
      await pcEdits(svc, paths, { ev1: { content: `Lecture ${i}` } });
    }
    phone = (await syncOnce(phone, stripped, 2_000)).data;

    const server = await svc.status(USER, paths);
    assert.ok(phone.state.lamport >= server.lamport - 1,
      'The received ops alone keep the phone within one tick of the server');

    phone = applyLocalChange(phone, {
      store: 'events', entityId: 'ev1', changes: { completedDates: ['2026-08-29'] }, at: 3_000,
    });
    phone = (await syncOnce(phone, stripped, 3_100)).data;
    const snap = await svc.snapshot(USER, paths, 'probe');
    assert.deepEqual(doneOn(snap.stores.events?.ev1), ['2026-08-29'],
      'and its tap still wins');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 9. THE CLOCK NEVER RUNS BACKWARDS ---');
  {
    // A clock that could go down would re-open races already settled, and the
    // damage would be invisible until two devices disagreed for good.
    const paths = await freshUser('monotonic', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    let seen = 0;
    for (let i = 0; i < 25; i++) {
      if (i % 2 === 0) await pcEdits(svc, paths, { ev1: { content: `L${i}` } });
      phone = (await syncOnce(phone, t, 1_000 + i)).data;
      assert.ok(phone.state.lamport >= seen,
        `Sync ${i}: the clock did not go backwards (${phone.state.lamport} < ${seen})`);
      seen = phone.state.lamport;
    }
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (clock: transport carries it, last action wins, never backwards)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
