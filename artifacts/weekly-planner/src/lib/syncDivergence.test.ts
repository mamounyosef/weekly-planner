// Tests the one failure that made PC↔phone sync feel unreliable in practice:
// the planner FILE on disk drifting away from the operation LOG, and then the
// server treating that stale file as a deliberate edit.
//
// WHY A WHOLE SUITE FOR THIS
// Every other sync suite passed while this was broken, because they all exercise
// one running service. The bug only appears across a RESTART, or after a write
// that was merged but never landed on disk — and those are exactly the two
// things a long-lived test harness never does. So this file is built around
// deliberately hostile lifecycle events: kill the service mid-way, corrupt the
// baseline, replay a push, restore an old file, start cold with no memory at all.
//
// The user-visible bug this reproduces, in his words: "I tick an item on my
// phone, it appears, and then it un-ticks itself." What actually happened:
//
//   1. the phone's tick merged into the log and the file was rewritten
//   2. the dev server restarted (there is a button for it)
//   3. on the next sync the service had no memory of what the PC last wrote,
//      so it diffed the file against the LOG'S OWN VIEW — which asserts the
//      file is a fresh PC edit made against current state
//   4. every value the file lacked read as "the PC cleared this"
//   5. those reverts were pushed to the phone, and the tick died on both sides
//
// Run with: npx tsx src/lib/syncDivergence.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotToOps, type Snapshot } from './syncBridge';
import { emptyState, mergeOps } from './sync';
import { createSyncService, type UserSyncPaths } from '../../sync-service';

const USER = 'mamoun';
const PHONE = 'android-testdevice';
let tmpRoot = '';

async function freshUser(label: string, events: Snapshot = {}, tasks: Snapshot = {}) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
  };
  await fsp.writeFile(paths.dbPath, JSON.stringify(events, null, 2), 'utf-8');
  await fsp.writeFile(paths.tasksPath, JSON.stringify(tasks, null, 2), 'utf-8');
  return paths;
}

const readFile = async (f: string): Promise<any> => JSON.parse(await fsp.readFile(f, 'utf-8'));
const writeFile = (f: string, v: unknown) => fsp.writeFile(f, JSON.stringify(v, null, 2), 'utf-8');

/** A new service over the same directory — i.e. the dev server was restarted. */
const restart = () => createSyncService({ now: () => Date.now() });

/** The phone ticks `date` off on `entityId`. Exactly what toggleDone sends. */
function tickOp(store: 'events' | 'tasks', entityId: string, date: string, lamport: number) {
  return {
    opId: `${PHONE}:${lamport}`,
    store,
    entityId,
    field: 'completedDates',
    value: date,
    present: true,
    device: PHONE,
    lamport,
    at: 1_700_000_000_000,
  };
}

/** What the log says the record holds, materialised the way the phone reads it. */
async function logValue(svc: any, paths: UserSyncPaths, store: 'events' | 'tasks', id: string) {
  const snap = await svc.snapshot(USER, paths, 'probe-device');
  return snap.stores[store]?.[id];
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-divergence-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. THE REPORTED BUG: A TICK SURVIVES A DEV-SERVER RESTART ---');
  {
    const paths = await freshUser('restart', { ev1: { content: 'Lecture', completedDates: [] } });

    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, { deviceId: PHONE, ops: [tickOp('events', 'ev1', '2026-08-29', 900)] });

    assert.deepEqual(
      (await readFile(paths.dbPath)).ev1.completedDates, ['2026-08-29'],
      'The tick reaches database.json straight away',
    );

    // The server restarts. Nothing is in memory any more.
    const svc2 = restart();
    const pulled = await svc2.pull(USER, paths, PHONE, 9_999);

    assert.equal(pulled.ops.length, 0, 'A restart invents no ops out of the file on disk');
    assert.deepEqual(
      (await logValue(svc2, paths, 'events', 'ev1') as any).completedDates, ['2026-08-29'],
      'and the tick is still in the log afterwards',
    );
    assert.deepEqual(
      (await readFile(paths.dbPath)).ev1.completedDates, ['2026-08-29'],
      'and still on disk',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. A MERGED-BUT-UNWRITTEN TICK IS REPAIRED, NOT REVERTED ---');
  {
    // The precise state his planner was found in: the log had the tick, the file
    // did not. Whatever caused the missed write (a crash between saving the log
    // and writing the file, a locked rename, a stale whole-map save landing
    // after it), the file must lose and the log must win — the log is the only
    // record that both devices agreed on.
    const paths = await freshUser('unwritten', { ev1: { content: 'Lecture', completedDates: [] } });
    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, { deviceId: PHONE, ops: [tickOp('events', 'ev1', '2026-08-29', 900)] });

    // Simulate the write never having landed.
    await writeFile(paths.dbPath, { ev1: { content: 'Lecture', completedDates: [] } });
    await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

    const svc2 = restart();
    await svc2.pull(USER, paths, PHONE, 9_999);

    assert.deepEqual(
      (await readFile(paths.dbPath)).ev1.completedDates, ['2026-08-29'],
      'The file is brought back into line with the log',
    );
    assert.deepEqual(
      (await logValue(svc2, paths, 'events', 'ev1') as any).completedDates, ['2026-08-29'],
      'and the log is not talked out of the tick by the stale file',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. A DEDUPLICATED RE-PUSH STILL RECONCILES THE FILE ---');
  {
    // A phone that loses the response to a successful push resends it. The
    // server correctly ignores the duplicate — and the old code derived "which
    // files need rewriting" from the ops applied in that request, so a resend
    // marked nothing dirty and the file stayed wrong forever.
    const paths = await freshUser('repush', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);
    const op = tickOp('events', 'ev1', '2026-08-29', 900);

    // Capture the state a FAILED write would have left behind. The service only
    // records a new baseline after the rename succeeds, so a lost write leaves
    // the file and the baseline both holding the old content — which is exactly
    // what makes it distinguishable from someone deliberately un-ticking.
    const seenPath = path.join(paths.dbDir, 'sync-seen.json');
    const fileBefore = await readFile(paths.dbPath);
    const seenBefore = await fsp.readFile(seenPath, 'utf-8');

    await svc.push(USER, paths, { deviceId: PHONE, ops: [op] });

    await writeFile(paths.dbPath, fileBefore);              // the write never landed
    await fsp.writeFile(seenPath, seenBefore, 'utf-8');     // so the baseline never moved

    // The server comes back and the phone, never having seen a response, resends.
    const again = await restart().push(USER, paths, { deviceId: PHONE, ops: [op] });
    assert.equal(again.ignored, 1, 'The resend is recognised as a duplicate');
    assert.deepEqual(
      (await readFile(paths.dbPath)).ev1.completedDates, ['2026-08-29'],
      'but the file is still repaired',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. EVERY KIND OF REQUEST RECONCILES, NOT JUST PUSH ---');
  {
    for (const kind of ['pull', 'ack', 'status', 'conflicts', 'snapshot'] as const) {
      const paths = await freshUser(`reconcile-${kind}`, { ev1: { content: 'L' } });
      const svc1 = createSyncService();
      await svc1.snapshot(USER, paths, PHONE);
      await svc1.push(USER, paths, { deviceId: PHONE, ops: [tickOp('events', 'ev1', '2026-08-29', 900)] });
      await writeFile(paths.dbPath, { ev1: { content: 'L' } });
      await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

      const svc2 = restart();
      if (kind === 'pull') await svc2.pull(USER, paths, PHONE, 0);
      if (kind === 'ack') await svc2.ack(USER, paths, PHONE, 1);
      if (kind === 'status') await svc2.status(USER, paths);
      if (kind === 'conflicts') await svc2.conflicts(USER, paths);
      if (kind === 'snapshot') await svc2.snapshot(USER, paths, PHONE);

      assert.deepEqual(
        (await readFile(paths.dbPath)).ev1.completedDates, ['2026-08-29'],
        `A ${kind} request repairs a diverged file`,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. REAL PC EDITS STILL WIN, INCLUDING DELETIONS ---');
  {
    // The fix must not turn the server deaf to the PC. With a baseline (the
    // normal running case) removals are still honoured in full.
    const paths = await freshUser('pc-edits', {
      ev1: { content: 'Lecture', completedDates: ['2026-08-29'], notes: 'bring laptop' },
      ev2: { content: 'Gym' },
    });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);

    // The PC un-ticks it, clears the notes, and deletes ev2 — one ordinary save.
    const saved = { ev1: { content: 'Lecture', completedDates: [] } };
    await writeFile(paths.dbPath, saved);
    await svc.ingestFile(USER, paths, 'events', saved);

    const view: any = await logValue(svc, paths, 'events', 'ev1');
    assert.deepEqual(view.completedDates, [], 'The PC can un-tick');
    assert.equal(view.notes, undefined, 'The PC can clear a field');
    assert.equal(await logValue(svc, paths, 'events', 'ev2'), undefined, 'The PC can delete');
    assert.equal((await readFile(paths.dbPath)).ev2, undefined, 'and the deletion sticks on disk');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. AN EXTERNAL EDIT MADE WHILE RUNNING IS STILL INGESTED ---');
  {
    // Google sync and a backup restore both rewrite the file behind our back.
    // Those must still be picked up in full — the durable baseline exists to
    // make this distinguishable from a stale file, not to ignore both.
    const paths = await freshUser('external', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);

    await writeFile(paths.dbPath, {
      ev1: { content: 'Lecture', notes: 'from Google' },
      gcal1: { content: 'Imported', startTime: '09:00' },
    });
    await svc.refresh(USER, paths);

    assert.equal((await logValue(svc, paths, 'events', 'ev1') as any).notes, 'from Google',
      'A field added behind our back is ingested');
    assert.ok(await logValue(svc, paths, 'events', 'gcal1'),
      'and so is a whole event added behind our back');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. COLD START WITH NO BASELINE: ADDITIONS YES, REMOVALS NO ---');
  {
    // The upgrade path, and any case where sync-seen.json is missing. Without a
    // record of what the writer started from, absence is not evidence.
    const paths = await freshUser('cold', { ev1: { content: 'Lecture' } });
    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, {
      deviceId: PHONE,
      ops: [
        tickOp('events', 'ev1', '2026-08-29', 900),
        { ...tickOp('events', 'ev1', '2026-08-30', 901), opId: `${PHONE}:901` },
      ],
    });

    // A file that is behind the log in every possible way, and ahead in one.
    await writeFile(paths.dbPath, {
      ev1: { content: 'Lecture', completedDates: ['2026-08-31'] },   // lost two, gained one
      ev9: { content: 'Added while the server was down' },           // brand new
    });
    await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

    const svc2 = restart();
    await svc2.pull(USER, paths, PHONE, 0);

    const view: any = await logValue(svc2, paths, 'events', 'ev1');
    assert.deepEqual(
      [...view.completedDates].sort(), ['2026-08-29', '2026-08-30', '2026-08-31'],
      'Set members are unioned: nothing the log knew is dropped, what the file adds is taken',
    );
    assert.ok(await logValue(svc2, paths, 'events', 'ev9'),
      'A record only the file has is still adopted in full');
    assert.equal((await logValue(svc2, paths, 'events', 'ev9') as any).content,
      'Added while the server was down', 'with its fields intact');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. COLD START NEVER DELETES WHAT THE FILE HAPPENS TO OMIT ---');
  {
    const paths = await freshUser('cold-delete', {});
    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, {
      deviceId: PHONE,
      ops: [{
        opId: `${PHONE}:950`, store: 'events' as const, entityId: 'phoneNew',
        field: 'content', value: 'Made on the phone', device: PHONE, lamport: 950,
        at: 1_700_000_000_000,
      }],
    });

    await writeFile(paths.dbPath, {});                              // the file has never heard of it
    await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

    const svc2 = restart();
    await svc2.pull(USER, paths, PHONE, 0);

    assert.ok(await logValue(svc2, paths, 'events', 'phoneNew'),
      'An empty file on a cold start is silence, not a mass deletion');
    assert.ok((await readFile(paths.dbPath)).phoneNew, 'and the item is restored to disk');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 9. COLD START DOES NOT ROLL A SCALAR BACK ---');
  {
    const paths = await freshUser('cold-scalar', { ev1: { content: 'Old title' } });
    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, {
      deviceId: PHONE,
      ops: [{
        opId: `${PHONE}:960`, store: 'events' as const, entityId: 'ev1',
        field: 'content', value: 'Renamed on the phone', device: PHONE, lamport: 960,
        at: 1_700_000_000_000,
      }],
    });
    await writeFile(paths.dbPath, { ev1: { content: 'Old title' } });
    await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

    const svc2 = restart();
    await svc2.pull(USER, paths, PHONE, 0);
    assert.equal((await logValue(svc2, paths, 'events', 'ev1') as any).content,
      'Renamed on the phone', 'A stale file does not undo a rename');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 10. THE BASELINE FILE SURVIVES AND IS USED ---');
  {
    const paths = await freshUser('seen-file', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);
    await svc.refresh(USER, paths);

    const seen = await readFile(path.join(paths.dbDir, 'sync-seen.json'));
    assert.ok(typeof seen.events === 'string', 'The events baseline is stored');
    assert.ok(typeof seen.tasks === 'string', 'and the tasks baseline too');
    assert.deepEqual(JSON.parse(seen.events), await readFile(paths.dbPath),
      'and it is exactly what is on disk');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 11. A CORRUPT OR HOSTILE BASELINE FILE IS SURVIVED ---');
  {
    const cases: [string, string][] = [
      ['truncated json', '{"events": "{\\"ev1\\":'],
      ['not an object', '[1,2,3]'],
      ['null', 'null'],
      ['empty', ''],
      ['wrong value types', '{"events": 42, "tasks": null}'],
      ['inner value not json', '{"events": "not json at all"}'],
      ['inner value is an array', '{"events": "[1,2,3]"}'],
      ['prototype pollution', '{"__proto__": {"polluted": true}, "events": "{}"}'],
    ];
    for (const [label, body] of cases) {
      const paths = await freshUser(`corrupt-${label.replace(/\W+/g, '-')}`, { ev1: { content: 'L' } });
      const svc1 = createSyncService();
      await svc1.snapshot(USER, paths, PHONE);
      await svc1.push(USER, paths, { deviceId: PHONE, ops: [tickOp('events', 'ev1', '2026-08-29', 900)] });
      await fsp.writeFile(path.join(paths.dbDir, 'sync-seen.json'), body, 'utf-8');

      const svc2 = restart();
      await svc2.pull(USER, paths, PHONE, 0);
      assert.deepEqual(
        (await logValue(svc2, paths, 'events', 'ev1') as any).completedDates, ['2026-08-29'],
        `A ${label} baseline falls back to additive rather than reverting`,
      );
      assert.equal(({} as any).polluted, undefined, 'and nothing pollutes Object.prototype');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 12. RESTARTING TWENTY TIMES CHANGES NOTHING ---');
  {
    // Convergence has to be a fixed point. If each restart nudged the data even
    // slightly, the planner would rot over weeks rather than fail outright.
    const paths = await freshUser('idempotent', { ev1: { content: 'Lecture' } });
    const svc0 = createSyncService();
    await svc0.snapshot(USER, paths, PHONE);
    await svc0.push(USER, paths, { deviceId: PHONE, ops: [tickOp('events', 'ev1', '2026-08-29', 900)] });

    const settled = await readFile(paths.dbPath);
    for (let i = 0; i < 20; i++) {
      const svc = restart();
      await svc.pull(USER, paths, PHONE, 0);
      await svc.status(USER, paths);
      assert.deepEqual(await readFile(paths.dbPath), settled, `Restart ${i + 1} left the file alone`);
    }
    const final = await restart().status(USER, paths);
    assert.equal(final.openConflicts, 0, 'and invented no conflicts along the way');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 13. BOTH STORES ARE REPAIRED INDEPENDENTLY ---');
  {
    const paths = await freshUser('both', { ev1: { content: 'L' } }, { t1: { title: 'Bins' } });
    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, {
      deviceId: PHONE,
      ops: [
        tickOp('events', 'ev1', '2026-08-29', 900),
        { ...tickOp('tasks', 't1', '2026-08-29', 901), opId: `${PHONE}:901` },
      ],
    });
    await writeFile(paths.dbPath, { ev1: { content: 'L' } });
    await writeFile(paths.tasksPath, { t1: { title: 'Bins' } });
    await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

    const svc2 = restart();
    await svc2.pull(USER, paths, PHONE, 0);
    assert.deepEqual((await readFile(paths.dbPath)).ev1.completedDates, ['2026-08-29'],
      'Events repaired');
    assert.deepEqual((await readFile(paths.tasksPath)).t1.completedDates, ['2026-08-29'],
      'Tasks repaired');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 14. A DELETE THE PHONE MADE IS NOT RESURRECTED BY A STALE FILE ---');
  {
    const paths = await freshUser('no-resurrect', { ev1: { content: 'Lecture' } });
    const svc1 = createSyncService();
    await svc1.snapshot(USER, paths, PHONE);
    await svc1.push(USER, paths, {
      deviceId: PHONE,
      ops: [{
        opId: `${PHONE}:970`, store: 'events' as const, entityId: 'ev1',
        field: '__deleted', value: true, device: PHONE, lamport: 970, at: 1_700_000_000_000,
      }],
    });
    assert.equal((await readFile(paths.dbPath)).ev1, undefined, 'The delete reaches disk');

    // An old copy of the file comes back — a restore, or Google re-adding it.
    await writeFile(paths.dbPath, { ev1: { content: 'Lecture' } });
    await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });

    const svc2 = restart();
    await svc2.pull(USER, paths, PHONE, 0);
    assert.equal(await logValue(svc2, paths, 'events', 'ev1'), undefined,
      'A tombstoned item is never resurrected, even additively');
    assert.equal((await readFile(paths.dbPath)).ev1, undefined, 'and it is removed from disk again');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 15. ADDITIVE MODE, UNIT BY UNIT ---');
  {
    const base = () => {
      const state = emptyState();
      const ops = snapshotToOps(state, {
        store: 'events',
        snapshot: { a: { content: 'A', notes: 'keep', completedDates: ['2026-01-01'] } },
        device: 'pc-desktop',
        at: 1,
      });
      return { state, ops };
    };

    // A field the log has never held IS taken.
    {
      const { state, ops } = base();
      const s = mergeOps(state, ops).state;
      const out = snapshotToOps(s, {
        store: 'events', device: 'pc-desktop', at: 2, additive: true,
        snapshot: { a: { content: 'A', notes: 'keep', completedDates: ['2026-01-01'], colour: 'red' } },
      });
      assert.deepEqual(out.map(o => o.field), ['colour'], 'A brand-new field is adopted');
    }

    // A field the log holds is NOT overwritten.
    {
      const { state, ops } = base();
      const s = mergeOps(state, ops).state;
      const out = snapshotToOps(s, {
        store: 'events', device: 'pc-desktop', at: 2, additive: true,
        snapshot: { a: { content: 'DIFFERENT', notes: 'keep', completedDates: ['2026-01-01'] } },
      });
      assert.equal(out.length, 0, 'A disagreeing scalar is left alone');
    }

    // Set members union rather than replace.
    {
      const { state, ops } = base();
      const s = mergeOps(state, ops).state;
      const out = snapshotToOps(s, {
        store: 'events', device: 'pc-desktop', at: 2, additive: true,
        snapshot: { a: { content: 'A', notes: 'keep', completedDates: ['2026-02-02'] } },
      });
      assert.equal(out.length, 1, 'Exactly one element is added');
      assert.equal(out[0].value, '2026-02-02');
      assert.equal(out[0].present, true, 'as an addition, never a removal');
    }

    // An omitted field is not cleared, and an omitted record is not deleted.
    {
      const { state, ops } = base();
      const s = mergeOps(state, ops).state;
      const out = snapshotToOps(s, {
        store: 'events', device: 'pc-desktop', at: 2, additive: true,
        snapshot: {},
      });
      assert.equal(out.length, 0, 'An empty snapshot produces nothing at all');
    }

    // Without additive, the same inputs DO clear and delete — proving the flag
    // is what changed the behaviour and not some other accident.
    {
      const { state, ops } = base();
      const s = mergeOps(state, ops).state;
      const out = snapshotToOps(s, { store: 'events', device: 'pc-desktop', at: 2, snapshot: {} });
      assert.equal(out.length, 1, 'Normally an empty snapshot is a deletion');
      assert.equal(out[0].field, '__deleted');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 16. THE FILE AND THE PHONE AGREE AFTER A LONG MIXED SESSION ---');
  {
    // The end-to-end property, exercised through restarts, lost writes and
    // interleaved edits from both sides. Whatever route the data took, the file
    // the PC reads and the snapshot the phone gets must describe one planner.
    const paths = await freshUser('endtoend', { ev1: { content: 'Lecture' } }, { t1: { title: 'Bins' } });
    let svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);

    for (let round = 0; round < 12; round++) {
      const date = `2026-09-${String((round % 28) + 1).padStart(2, '0')}`;

      // The phone ticks something.
      await svc.push(USER, paths, {
        deviceId: PHONE,
        ops: [tickOp(round % 2 === 0 ? 'events' : 'tasks', round % 2 === 0 ? 'ev1' : 't1', date, 1000 + round)],
      });

      // The PC saves its whole map, built from what it can see.
      const onDisk = await readFile(paths.dbPath);
      onDisk[`pc${round}`] = { content: `Added on the PC ${round}` };
      await writeFile(paths.dbPath, onDisk);
      await svc.ingestFile(USER, paths, 'events', onDisk);

      // Every third round: the write is lost and the server restarts.
      if (round % 3 === 2) {
        await writeFile(paths.dbPath, { ev1: { content: 'Lecture' } });
        await fsp.rm(path.join(paths.dbDir, 'sync-seen.json'), { force: true });
        svc = restart();
      }
    }

    await svc.pull(USER, paths, PHONE, 0);

    const fileEvents = await readFile(paths.dbPath);
    const fileTasks = await readFile(paths.tasksPath);
    const snap = await svc.snapshot(USER, paths, 'probe-device');

    assert.deepEqual(fileEvents, snap.stores.events,
      'The PC file and the phone snapshot describe exactly the same events');
    assert.deepEqual(fileTasks, snap.stores.tasks,
      'and exactly the same tasks');

    // And nothing was silently lost along the way.
    for (let round = 0; round < 12; round++) {
      assert.ok(fileEvents[`pc${round}`], `The PC's item from round ${round} survived`);
    }
    assert.ok(fileEvents.ev1.completedDates.length >= 6, 'The phone ticks survived too');
    assert.ok(fileTasks.t1.completedDates.length >= 6, 'on both stores');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 17. RECONCILING EVERY CYCLE DOES NOT WAKE THE WINDOWS ---');
  {
    // The rebuild now runs on every request. If it wrote even when the file
    // already agreed, the db-stream would fire on every poll and both windows
    // would reload constantly — which would be a worse bug than the one fixed.
    const paths = await freshUser('quiet', { ev1: { content: 'Lecture' } });
    let woke = 0;
    const svc = createSyncService({ onStoresChanged: () => { woke += 1; } });
    await svc.snapshot(USER, paths, PHONE);
    woke = 0;

    for (let i = 0; i < 30; i++) {
      await svc.pull(USER, paths, PHONE, 999);
      await svc.status(USER, paths);
    }
    assert.equal(woke, 0, 'Thirty idle polls wrote nothing and woke nobody');

    const before = await fsp.stat(paths.dbPath);
    await svc.pull(USER, paths, PHONE, 999);
    const after = await fsp.stat(paths.dbPath);
    assert.equal(before.mtimeMs, after.mtimeMs, 'and did not even touch the file');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 18. OVERLAPPING REQUESTS STILL SERIALISE ---');
  {
    const paths = await freshUser('race', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);

    await Promise.all([
      svc.push(USER, paths, { deviceId: PHONE, ops: [tickOp('events', 'ev1', '2026-08-29', 900)] }),
      svc.pull(USER, paths, PHONE, 0),
      svc.push(USER, paths, { deviceId: PHONE, ops: [{ ...tickOp('events', 'ev1', '2026-08-30', 901), opId: `${PHONE}:901` }] }),
      svc.status(USER, paths),
      svc.refresh(USER, paths),
    ]);

    const file = await readFile(paths.dbPath);
    assert.deepEqual([...file.ev1.completedDates].sort(), ['2026-08-29', '2026-08-30'],
      'Both ticks survived five overlapping requests');
    const snap = await svc.snapshot(USER, paths, 'probe-device');
    assert.deepEqual(file, snap.stores.events, 'and the file still matches the log');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (divergence: restarts, lost writes, stale files, convergence)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
