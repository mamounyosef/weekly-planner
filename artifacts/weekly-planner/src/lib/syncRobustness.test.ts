// ─── Sync robustness: the far edges, exercised end to end ────────────────────
//
// The engine, server, service, bridge and client each carry their own suites.
// This file lives one level out from all of them and exists for the cases that
// only show up when the pieces are combined, run for a long time, starved,
// restarted, abandoned, or attacked:
//
//   • a device that synced once and never came back (the log used to be
//     forbidden from trimming past it, for ever),
//   • that same device returning a year later (must resync, not silently sit),
//   • hostile and oversized op payloads at the validation door,
//   • the prayer-done adapter fed wreckage instead of records,
//   • the prayer toggle endpoint validating at the service, not just the HTTP
//     layer,
//   • three phones and a PC interleaving ticks, edits, legacy whole-map saves
//     and server restarts at random, and still converging byte for byte.
//
// Every scenario here encodes a promise about data the user made on one device
// and expects to find on the other. Run with:
//   npx tsx src/lib/syncRobustness.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSyncService,
  validateOp,
  validatePrayerToggle,
  type UserSyncPaths,
} from '../../sync-service';
import { forgetWrittenBundle, LOG_SLACK, trimLog } from '../../sync-server';
import { prayerDoneAdapter } from './syncBridge';
import { emptyState, makeOps, readStore, mergeOps, type SyncState } from './sync';
import {
  applyLocalChange,
  emptyClientData,
  readClientStore,
  syncOnce,
} from './syncClient';
import { createTransport } from './syncTransport';

const USER = 'mamoud';
const DAY = 24 * 60 * 60 * 1000;

const readJson = async (f: string): Promise<any> => JSON.parse(await fsp.readFile(f, 'utf-8'));

/** Deterministic PRNG, so a failure reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function freshUser(label: string): Promise<UserSyncPaths> {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
    settingsPath: path.join(dbDir, 'settings.json'),
    prayerDonePath: path.join(dbDir, 'prayer-done.json'),
    prayerTimesPath: path.join(dbDir, 'prayer-times.json'),
  };
  for (const f of [paths.dbPath, paths.tasksPath, paths.settingsPath!, paths.prayerDonePath!, paths.prayerTimesPath!]) {
    await fsp.writeFile(f, '{}', 'utf-8');
  }
  forgetWrittenBundle(dbDir);
  return paths;
}

/** A valid register op, for the validation door. */
function baseOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: 'android-x:1',
    store: 'events',
    entityId: 'e1',
    field: 'title',
    value: 'Physics',
    device: 'android-x',
    lamport: 1,
    at: 1,
    ...overrides,
  };
}

let tmpRoot = '';

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-robust-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. THE PRAYER-DONE ADAPTER FEEDS ON WRECKAGE AND GIVES BACK RECORDS ---');
  {
    const A = prayerDoneAdapter();

    // Both on-disk shapes mean the same thing.
    assert.deepEqual(
      A.toSnapshot({ '2026-08-30': ['fajr', 'isha'] }),
      { '2026-08-30': { done: ['fajr', 'isha'] } },
      'the PC array form is read',
    );
    assert.deepEqual(
      A.toSnapshot({ '2026-08-30': { done: ['fajr', 'isha'] } }),
      { '2026-08-30': { done: ['fajr', 'isha'] } },
      'the engine object form is read too',
    );

    // The exact damage the broken build wrote: real ticks stranded under array
    // indices next to an empty set. They come back, in prayer order.
    assert.deepEqual(
      A.toSnapshot({ '2026-09-07': { '0': 'maghrib', '1': 'isha', done: [] } }),
      { '2026-09-07': { done: ['maghrib', 'isha'] } },
      'stranded index ticks are rescued',
    );
    // Index garbage and a live set coexist: the union, deduplicated.
    assert.deepEqual(
      A.toSnapshot({ '2026-09-07': { '0': 'isha', done: ['isha', 'fajr'] } }),
      { '2026-09-07': { done: ['fajr', 'isha'] } },
      'rescue unions with the live set without duplicating',
    );

    // Hostility and wreckage that must NOT become members.
    assert.deepEqual(
      A.toSnapshot({
        '2026-08-30': { done: ['fajr', 42, null, { a: 1 }, 'not-a-prayer', ['isha']] },
        'not-a-date': ['fajr'],
        '2026-13-01': ['fajr'],
        '2026-08-31': { '0': 'also-not-a-prayer', done: 'not-an-array' },
      }),
      {
        '2026-08-30': { done: ['fajr'] },
        '2026-08-31': { done: [] },
      },
      'junk members, junk dates and junk values are dropped',
    );

    // Degenerate inputs are empty, never an exception.
    assert.deepEqual(A.toSnapshot(null), {});
    assert.deepEqual(A.toSnapshot(undefined), {});
    assert.deepEqual(A.toSnapshot(42), {});
    assert.deepEqual(A.toSnapshot(['row']), {}, 'a bare array is not a snapshot');
    // A __proto__ key that arrived by JSON.parse is data, and is discarded by
    // the date check rather than being walked or spread anywhere.
    const hostile = JSON.parse('{"__proto__": ["fajr"], "2026-08-30": ["isha"]}');
    assert.deepEqual(
      A.toSnapshot(hostile),
      { '2026-08-30': { done: ['isha'] } },
    );

    // On the way out: empty days vanish from the file (the PC deletes a date
    // key when its day empties), and what remains is the plain array the
    // PC app reads.
    assert.deepEqual(
      A.fromSnapshot({
        '2026-08-30': { done: ['isha', 'maghrib'] },
        '2026-08-31': { done: [] },
        '2026-08-32': {},
      }),
      { '2026-08-30': ['isha', 'maghrib'] },
      'empty and malformed days write nothing',
    );
    assert.equal(A.detectDeletes, false,
      'a date absent from a save must never tombstone the day');

    // LOSSLESSNESS THROUGH THE REAL ENGINE. A file → snapshot → ops → merged
    // state → snapshot → file round trip must agree with itself, because every
    // sync request walks exactly this path in one direction or the other.
    const state: SyncState = emptyState();
    const file = { '2026-08-30': ['fajr', 'dhuhr', 'isha'] };
    const snap = A.toSnapshot(file);
    const ops = makeOps(state, {
      store: 'prayerDone', entityId: '2026-08-30',
      device: 'android-x', at: 1, changes: { done: snap['2026-08-30'].done },
    });
    const merged = mergeOps(state, ops);
    const back = readStore(merged.state, 'prayerDone') as Record<string, any>;
    assert.deepEqual(
      A.fromSnapshot(back),
      { '2026-08-30': ['dhuhr', 'fajr', 'isha'] },
      'engine round trip preserves exactly the members that went in',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. THE VALIDATION DOOR HOLDS AGAINST HOSTILE AND HUGE PAYLOADS ---');
  {
    // Values are bounded: the log is durable and replicated forever, so one
    // op is the unit of unbounded growth.
    const big = 'x'.repeat(300 * 1024);
    assert.equal(validateOp(baseOp({ value: big })), null, 'an oversized value is rejected');
    assert.equal(validateOp(baseOp({ value: 'x'.repeat(200 * 1024) })) !== null, true,
      'a large-but-legitimate value passes');

    // A value that JSON cannot serialise is rejected rather than crashing the door.
    const circular: any = { self: null };
    circular.self = circular;
    assert.equal(validateOp(baseOp({ value: circular })), null, 'an unserialisable value is rejected');

    // Set ELEMENT ops carry one string member. Anything else would be
    // stringified into the set by `elementKey` and sit there forever under
    // add-wins, unmatchable by any real lookup, on every device.
    for (const v of [42, null, { a: 1 }, ['2026-01-01'], true]) {
      assert.equal(
        validateOp(baseOp({ store: 'events', field: 'completedDates', present: true, value: v })),
        null,
        `a set element of ${JSON.stringify(v)} is rejected`,
      );
    }
    assert.equal(
      validateOp(baseOp({ store: 'events', field: 'completedDates', present: true, value: '2026-01-01' })) !== null,
      true, 'a proper set element passes',
    );
    // The legacy whole-array form has no `present` and must keep working — it
    // is how older builds still write set fields.
    assert.equal(
      validateOp(baseOp({ store: 'events', field: 'completedDates', value: ['2026-01-01'] })) !== null,
      true, 'the legacy whole-array set op still passes',
    );
    // A missing value is a legitimate register CLEAR, not wreckage.
    const clear = baseOp();
    delete clear.value;
    assert.equal(validateOp(clear) !== null, true, 'a valueless register op (a clear) passes');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. THE PRAYER TOGGLE VALIDATES AT THE SERVICE, NOT JUST THE DOOR ---');
  {
    const paths = await freshUser('toggle-validation');
    const svc = createSyncService();
    // Seed the service so the log exists.
    await svc.refresh(USER, paths);

    for (const bad of [
      { date: '2026-9-7', key: 'fajr', present: true },
      { date: '2026-13-01', key: 'fajr', present: true },
      { date: '2026-02-30', key: 'fajr', present: true },
      { date: 'not-a-date', key: 'fajr', present: true },
      { date: '2026-09-07', key: 'second-breakfast', present: true },
      { date: '2026-09-07', key: 'fajr', present: 'yes' },
      { date: 20260907, key: 'fajr', present: true },
    ]) {
      const out = await svc.togglePrayerDone(USER, paths, bad as any);
      assert.equal(out.changed, false, `bad toggle ${JSON.stringify(bad)} changes nothing`);
      assert.ok(out.reason, 'and says why');
    }
    assert.deepEqual(await readJson(paths.prayerDonePath!), {},
      'the shared record was never touched');
    assert.equal((await svc.status(USER, paths)).logSize, 0,
      'the log was never touched either');

    // validatePrayerToggle itself, including the calendar-range rule.
    assert.equal(validatePrayerToggle({ date: '2026-09-07', key: 'isha', present: false }), null);
    assert.equal(validatePrayerToggle({ date: '0000-01-01', key: 'isha', present: true }), null,
      'an odd but real calendar date is accepted');
    assert.ok(validatePrayerToggle({ date: '2026-00-10', key: 'isha', present: true }));
    assert.ok(validatePrayerToggle({ date: '2026-09-00', key: 'isha', present: true }));
    assert.ok(validatePrayerToggle({}));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. A DEVICE ABANDONED FOR A YEAR STOPS HOLDING THE LOG HOSTAGE ---');
  {
    // It synced once, acked at cursor 600, and its owner never opened the app
    // again. Trimming used to respect its cursor forever: the log grew without
    // bound for as long as the planner was used. Now a device quiet for 30
    // days stops counting, and the safety net is the one that already existed:
    // a device asking below `trimmedBelow` is told to take a full snapshot.
    const paths = await freshUser('abandoned');
    const clock = { now: 100 * DAY };
    const svc = createSyncService({ now: () => clock.now });

    // Two devices sync; the later-abandoned one acks at a middling cursor.
    const minter = emptyState();
    let n = 0;
    const pushBatch = async (device: string, count: number) => {
      const ops = [];
      for (let i = 0; i < count; i += 1) {
        n += 1;
        ops.push(...makeOps(minter, {
          store: 'events', entityId: `e${n}`, device, at: clock.now,
          changes: { title: `Event ${n}` },
        }));
      }
      const res = await svc.push(USER, paths, { deviceId: device, ops });
      assert.equal(res.accepted, count, 'every op accepted');
    };

    await pushBatch('device-fast', 700);
    const st = await svc.status(USER, paths);
    await svc.ack(USER, paths, 'device-gone', 600);   // acks partway, then quits
    await svc.ack(USER, paths, 'device-fast', st.seq);
    await pushBatch('device-fast', 600);

    let after = await svc.status(USER, paths);
    // The abandoned cursor (600) minus LOG_SLACK already trims the first 100
    // ops — that is the ordinary slack rule. Everything from 101 up stays,
    // because the abandoned device might still come back for it.
    assert.equal(after.logSize, 1200, 'nothing beyond the slack line is trimmed yet');
    assert.ok(after.devices.find(d => d.deviceId === 'device-gone'));

    // The active device keeps syncing for a month. The log cannot shrink past
    // the abandoned cursor yet.
    for (let d = 1; d <= 29; d += 1) {
      clock.now += DAY;
      await pushBatch('device-fast', 10);
      const s = await svc.status(USER, paths);
      await svc.ack(USER, paths, 'device-fast', s.seq);
    }
    after = await svc.status(USER, paths);
    assert.ok(after.logSize > 1000, 'still carrying the abandoned device\u2019s history');

    // Past the window, the next ordinary ack reclaims the log.
    clock.now += 2 * DAY;
    await pushBatch('device-fast', 10);
    const s2 = await svc.status(USER, paths);
    await svc.ack(USER, paths, 'device-fast', s2.seq);
    after = await svc.status(USER, paths);
    assert.ok(after.logSize <= LOG_SLACK + 10,
      `the log shrank to the active device\u2019s needs (got ${after.logSize})`);

    // The abandoned device comes back after a year. Its cursor is below the
    // trim line, so it is told — clearly, not silently — to take a snapshot.
    clock.now += 335 * DAY;
    const back = await svc.pull(USER, paths, 'device-gone', 600);
    assert.equal(back.needsFullResync, true, 'returning device is sent to a full resync');

    // And the snapshot really does hold everything it never received.
    const snap = await svc.snapshot(USER, paths, 'device-gone');
    const events = snap.stores.events as Record<string, any>;
    assert.ok(Object.keys(events).length >= 1300 + 29 * 10 + 10,
      'the snapshot covers every event pushed while it was away');

    // It resyncs through the ordinary client path and converges.
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData('device-gone'), t, clock.now)).data;
    const onPhone = readClientStore(phone, 'events') as Record<string, any>;
    assert.ok(Object.keys(onPhone).length >= 1300, 'the recovered copy is complete');

    // Restarting the server does not forget the trim line.
    forgetWrittenBundle(paths.dbDir);
    const svc2 = createSyncService({ now: () => clock.now });
    const back2 = await svc2.pull(USER, paths, 'device-gone', 600);
    assert.equal(back2.needsFullResync, true, 'the resync demand survives a restart');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. TRIMMING STILL RESPECTS A DEVICE THAT IS MERELY BEHIND ---');
  {
    // Staleness must not overreach: a device seen YESTERDAY with a low cursor
    // (a phone mid-backlog after a long flight) still pins the log.
    const paths = await freshUser('behind');
    const clock = { now: 100 * DAY };
    const svc = createSyncService({ now: () => clock.now });

    const minter = emptyState();
    let n = 0;
    const pushBatch = async (device: string, count: number) => {
      const ops = [];
      for (let i = 0; i < count; i += 1) {
        n += 1;
        ops.push(...makeOps(minter, {
          store: 'events', entityId: `e${n}`, device, at: clock.now,
          changes: { title: `Event ${n}` },
        }));
      }
      await svc.push(USER, paths, { deviceId: device, ops });
    };

    await pushBatch('device-fast', 700);
    let st = await svc.status(USER, paths);
    await svc.ack(USER, paths, 'device-slow', 600);   // behind, but seen just now
    await svc.ack(USER, paths, 'device-fast', st.seq);
    await pushBatch('device-fast', 600);
    st = await svc.status(USER, paths);

    // Ack again with a clock a day later — the slow device is NOT yet stale.
    clock.now += DAY;
    await svc.ack(USER, paths, 'device-fast', st.seq);
    st = await svc.status(USER, paths);
    assert.ok(st.logSize > 1000,
      'a recently-seen slow device still holds the log (it will catch up)');

    // And the direct trimLog call keeps its old behaviour when given no clock.
    const log = Array.from({ length: 700 }, (_, i) => ({
      opId: `d:${i}`, store: 'events' as const, entityId: `e${i}`, field: 'title',
      value: 'x', device: 'd', lamport: i + 1, at: 1, seq: i + 1,
    }));
    const day0 = 100 * DAY;
    const devices = { a: { deviceId: 'a', cursor: 600, lastSeen: day0 } };
    assert.equal(trimLog(log, devices).log.length, 600,
      'no clock: old behaviour trims to the cursor minus slack (100 of 700 go)');
    assert.equal(trimLog(log, devices, day0 + 31 * DAY).log.length, 700,
      'with a clock: a device unseen for 31 days no longer pins the log');
    assert.equal(
      trimLog(log, { a: { deviceId: 'a', cursor: 600, lastSeen: day0 + 30 * DAY } }, day0 + 31 * DAY).log.length,
      600,
      'a device seen exactly at the window edge (30 days) still counts',
    );
    assert.equal(trimLog(log, {}, day0).log.length, 700, 'no devices: nothing trimmed');
    // acknowledge never moves a cursor backwards, stale or not.
    const acked = await svc.ack(USER, paths, 'device-slow', 0);
    assert.equal(acked.cursor, 600, 'a stale retry cannot un-acknowledge');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. THREE PHONES AND A PC INTERLEAVE AT RANDOM AND STILL CONVERGE ---');
  {
    const paths = await freshUser('chaos');
    const svc = createSyncService();
    const clock = { t: 1_000 };

    const DATES = Array.from({ length: 8 }, (_, i) => `2026-08-${String(10 + i).padStart(2, '0')}`);
    const KEYS = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const rng = mulberry32(20260907);

    /** The oracle: every tick the user ever made, wherever they made it. */
    const expectedTicks = new Set<string>();
    const expectedEvents = new Map<string, string>();

    const PHONE_IDS = ['android-p1', 'android-p2', 'android-p3'];
    const phones = new Map<string, any>();
    let svcAt = svc;
    const transports = new Map<string, any>();
    for (const id of PHONE_IDS) transports.set(id, httpTransport(svcAt, paths));

    const syncPhone = async (id: string) => {
      const prev = phones.get(id) ?? emptyClientData(id);
      clock.t += 50;
      const out = await syncOnce(prev, transports.get(id), clock.t);
      assert.equal(out.error, undefined, `phone ${id} syncs without error`);
      phones.set(id, out.data);
      return out.data;
    };

    const tick = async (id: string, date: string, key: string) => {
      const data = phones.get(id) ?? emptyClientData(id);
      const entry = (readClientStore(data, 'prayerDone') as any)[date];
      const done: string[] = Array.isArray(entry?.done) ? [...entry.done] : [];
      if (!done.includes(key)) done.push(key);
      const next = applyLocalChange(data, {
        store: 'prayerDone', entityId: date, changes: { done }, at: clock.t,
      });
      phones.set(id, next);
      expectedTicks.add(`${date}|${key}`);
    };

    const pcLegacyTick = async (date: string, key: string) => {
      // The PC's OLD path: read the file, add to it, write it back whole, and
      // fold it into the log — what /api/prayer-done does for a stale window.
      const current = await readJson(paths.prayerDonePath!);
      const done: string[] = Array.isArray(current[date]) ? [...current[date]] : [];
      if (!done.includes(key)) done.push(key);
      current[date] = done;
      await fsp.writeFile(paths.prayerDonePath!, JSON.stringify(current, null, 2), 'utf-8');
      await svcAt.ingestFile(USER, paths, 'prayerDone');
      expectedTicks.add(`${date}|${key}`);
    };

    const pcToggleTick = async (date: string, key: string) => {
      // The PC's NEW path: one element, inside the queue.
      const out = await svcAt.togglePrayerDone(USER, paths, { date, key, present: true });
      assert.equal(out.reason, undefined, 'the toggle is valid');
      expectedTicks.add(`${date}|${key}`);
    };

    const addEvent = async (id: string) => {
      const eid = `ev-${id}-${expectedEvents.size}`;
      const title = `Event from ${id} #${expectedEvents.size}`;
      const data = phones.get(id) ?? emptyClientData(id);
      phones.set(id, applyLocalChange(data, {
        store: 'events', entityId: eid,
        changes: { title, date: DATES[0], startTime: '10:00' },
        at: clock.t,
      }));
      expectedEvents.set(eid, title);
    };

    const ROUNDS = 120;
    for (let r = 0; r < ROUNDS; r += 1) {
      clock.t += 100;
      const roll = rng();
      const id = PHONE_IDS[Math.floor(rng() * PHONE_IDS.length)];

      if (roll < 0.35) {
        // A phone ticks a prayer, then syncs.
        await tick(id, DATES[Math.floor(rng() * DATES.length)], KEYS[Math.floor(rng() * KEYS.length)]);
        await syncPhone(id);
      } else if (roll < 0.5) {
        // A phone adds an event, then syncs.
        await addEvent(id);
        await syncPhone(id);
      } else if (roll < 0.6) {
        // The PC ticks through the new element path.
        await pcToggleTick(DATES[Math.floor(rng() * DATES.length)], KEYS[Math.floor(rng() * KEYS.length)]);
      } else if (roll < 0.68) {
        // The PC ticks through the legacy whole-map path (an old window).
        await pcLegacyTick(DATES[Math.floor(rng() * DATES.length)], KEYS[Math.floor(rng() * KEYS.length)]);
      } else if (roll < 0.8) {
        // Idle poll: costs nothing, changes nothing.
        await syncPhone(id);
      } else if (roll < 0.9) {
        // The dev server restarts under everyone. State must survive it.
        forgetWrittenBundle(paths.dbDir);
        svcAt = createSyncService();
        for (const pid of PHONE_IDS) transports.set(pid, httpTransport(svcAt, paths));
      } else {
        // A phone goes offline for a few rounds (no sync), then returns.
        await tick(id, DATES[Math.floor(rng() * DATES.length)], KEYS[Math.floor(rng() * KEYS.length)]);
      }

      // Every few rounds everyone catches up.
      if (r % 7 === 6) for (const pid of PHONE_IDS) await syncPhone(pid);
    }

    // Final convergence: everyone syncs twice against the final server.
    for (let i = 0; i < 2; i += 1) for (const pid of PHONE_IDS) await syncPhone(pid);

    // 1. Every tick made anywhere is on every phone.
    const prayerViews: string[] = [];
    for (const pid of PHONE_IDS) {
      const store = readClientStore(phones.get(pid)!, 'prayerDone') as Record<string, any>;
      const view: string[] = [];
      for (const date of Object.keys(store).sort()) {
        for (const key of [...(store[date].done ?? [])].sort()) view.push(`${date}|${key}`);
      }
      prayerViews.push(JSON.stringify(view));
      for (const t of expectedTicks) {
        assert.ok(view.includes(t), `tick ${t} (made somewhere) reached ${pid}`);
      }
    }
    assert.equal(new Set(prayerViews).size, 1, 'all phones hold byte-identical tick state');

    // 2. The file the PC reads holds the same union, in the array form.
    const onDisk = await readJson(paths.prayerDonePath!);
    const diskView: string[] = [];
    for (const date of Object.keys(onDisk).sort()) {
      assert.ok(Array.isArray(onDisk[date]), `the file keeps the PC array form (${date})`);
      for (const key of onDisk[date]) diskView.push(`${date}|${key}`);
    }
    for (const t of expectedTicks) {
      assert.ok(diskView.includes(t), `tick ${t} reached the PC file`);
    }
    assert.equal(diskView.length, expectedTicks.size,
      'the file holds exactly the union — nothing invented, nothing lost');

    // 3. No device was left arguing: ticks are a set, so no conflict cards.
    assert.equal((await svcAt.conflicts(USER, paths)).length, 0,
      'concurrent ticks on different devices are not a disagreement');

    // 4. Every event, from every phone, everywhere, with its title intact.
    for (const pid of PHONE_IDS) {
      const store = readClientStore(phones.get(pid)!, 'events') as Record<string, any>;
      for (const [eid, title] of expectedEvents) {
        assert.equal(store[eid]?.title, title, `event ${eid} reached ${pid} intact`);
      }
    }

    // 5. One more restart, then one more sync: nothing moves.
    const viewOf = (data: any): string => {
      const store = readClientStore(data, 'prayerDone') as Record<string, any>;
      const view: string[] = [];
      for (const date of Object.keys(store).sort()) {
        for (const key of [...(store[date].done ?? [])].sort()) view.push(`${date}|${key}`);
      }
      return JSON.stringify(view);
    };
    forgetWrittenBundle(paths.dbDir);
    const svcFinal = createSyncService();
    const tFinal = httpTransport(svcFinal, paths);
    for (const pid of PHONE_IDS) {
      const out = await syncOnce(phones.get(pid)!, tFinal, clock.t + 1000);
      assert.equal(out.error, undefined);
      assert.equal(
        viewOf(out.data),
        prayerViews[PHONE_IDS.indexOf(pid)],
        `a restart moved nothing for ${pid}`,
      );
    }
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (robustness: wreckage, hostility, abandonment, chaos, convergence)');
}

/** In-process transport wired straight to a service, like the real HTTP layer. */
function httpTransport(svc: any, paths: UserSyncPaths) {
  const fetchImpl = async (url: string, init: any) => {
    const action = new URL(url).pathname.replace(/^\/api\/sync/, '');
    const answer = await (await import('../../sync-service')).handleSyncRequest(svc, USER, paths, {
      action, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {},
    });
    const text = JSON.stringify(answer.payload);
    return {
      ok: answer.status < 400, status: answer.status,
      headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text),
    };
  };
  return createTransport({ baseUrl: 'http://pc.local', session: 's', fetchImpl: fetchImpl as any });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
