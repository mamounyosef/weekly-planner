// Tests the parts of PC↔phone sync the owner has never been able to exercise by
// hand: REPEATING events and DELETION.
//
// WHY THESE TWO
// Everything tested so far has been a flat item and a tick. Repeats and deletes
// are where the model stops being flat:
//
//   • a repeat is ONE stored master; the grid invents occurrences keyed
//     `masterId::date`, and ticking one writes a DATE into a set on the master.
//     Nothing named after that date exists in the store, so an off-by-one in the
//     occurrence logic looks exactly like sync losing an edit.
//   • a delete is a TOMBSTONE, not a removal — precisely so a peer that never saw
//     it cannot bring the item back. Every one of the four sync bugs found so far
//     was a case of one side quietly reviving or discarding state, which is the
//     same failure shape a mishandled tombstone produces.
//
// The phone can currently only view and tick, so these paths run in real life
// with no one watching them. That is the argument for covering them here.
//
// Run with: npx tsx src/lib/syncLifecycle.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDay } from './agenda';
import {
  applyLocalChange,
  applyLocalRecord,
  emptyClientData,
  readClientStore,
  syncOnce,
  type SyncTransport,
} from './syncClient';
import {
  buildEventRecord,
  buildTaskRecord,
  dateOfAnchor,
  draftFromRecord,
  inferWeekStartsOn,
} from './draft';
import { DELETED_FIELD } from './sync';
import { createSyncService, handleSyncRequest, type UserSyncPaths } from '../../sync-service';
import { createTransport } from './syncTransport';

const USER = 'mamoun';
const PHONE = 'android-lifecycle';
let tmpRoot = '';

/** A weekly Monday repeat anchored on the week of 2026-08-24. */
const WEEKLY = {
  id: 'rep1',
  content: 'Lecture',
  weekKey: '2026-08-24',
  dayIndex: 1,               // Monday
  startTime: '09:00',
  endTime: '10:00',
  recur: { freq: 'weekly', interval: 1 },
};

const MON_1 = '2026-08-25';   // the anchor occurrence
const MON_2 = '2026-09-01';   // one week later
const MON_3 = '2026-09-08';

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

function httpTransport(svc: any, paths: UserSyncPaths) {
  const fetchImpl = async (url: string, init: any) => {
    const action = new URL(url).pathname.replace(/^\/api\/sync/, '');
    const answer = await handleSyncRequest(svc, USER, paths, {
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

/** The PC saves its whole event map, exactly as the dev server ingests it. */
async function pcSave(svc: any, paths: UserSyncPaths, snapshot: Record<string, unknown>) {
  await fsp.writeFile(paths.dbPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  await svc.ingestFile(USER, paths, 'events', snapshot);
}

const pcFile = async (paths: UserSyncPaths): Promise<any> =>
  JSON.parse(await fsp.readFile(paths.dbPath, 'utf-8'));

/** What the phone's screen shows for one date. */
function phoneDay(phone: any, date: string) {
  return buildDay({
    events: readClientStore(phone, 'events') as any,
    tasks: readClientStore(phone, 'tasks') as any,
    date,
  });
}

/** Tick an occurrence the way Today.tsx does: master id plus the date. */
function tickOccurrence(phone: any, masterId: string, date: string, undo = false) {
  const rec = (readClientStore(phone, 'events') as any)[masterId] ?? {};
  const done: string[] = Array.isArray(rec.completedDates) ? [...rec.completedDates] : [];
  const next = undo ? done.filter(d => d !== date) : [...new Set([...done, date])];
  return { store: 'events' as const, entityId: masterId, changes: { completedDates: next } };
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-lifecycle-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. A REPEAT EXPANDS THE SAME WAY ON BOTH SIDES ---');
  {
    const paths = await freshUser('expand', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    for (const date of [MON_1, MON_2, MON_3]) {
      const day = phoneDay(phone, date);
      assert.equal(day.all.length, 1, `${date}: the occurrence is there`);
      assert.equal(day.all[0].masterId, 'rep1', `${date}: and points at the master`);
      assert.equal(day.all[0].id, `rep1::${date}`, `${date}: with an occurrence id`);
      assert.equal(day.all[0].repeating, true, `${date}: marked as repeating`);
    }
    assert.equal(phoneDay(phone, '2026-08-26').all.length, 0, 'and not on a Tuesday');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. TICKING ONE OCCURRENCE TICKS ONLY THAT ONE ---');
  {
    const paths = await freshUser('one-occ', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChange(phone, { ...tickOccurrence(phone, 'rep1', MON_2), at: 2_000 });
    phone = (await syncOnce(phone, t, 2_100)).data;

    assert.equal(phoneDay(phone, MON_2).all[0].completed, true, 'The ticked week is done');
    assert.equal(phoneDay(phone, MON_1).all[0].completed, false, 'The week before is not');
    assert.equal(phoneDay(phone, MON_3).all[0].completed, false, 'Nor the week after');

    assert.deepEqual((await pcFile(paths)).rep1.completedDates, [MON_2],
      'and the PC file records exactly that one date');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. TWO OCCURRENCES, TICKED FROM OPPOSITE ENDS ---');
  {
    const paths = await freshUser('two-occ', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    // Phone ticks week 1.
    phone = applyLocalChange(phone, { ...tickOccurrence(phone, 'rep1', MON_1), at: 2_000 });
    phone = (await syncOnce(phone, t, 2_100)).data;

    // PC ticks week 3, saving its whole map as it always does.
    const disk = await pcFile(paths);
    await pcSave(svc, paths, {
      rep1: { ...disk.rep1, completedDates: [...disk.rep1.completedDates, MON_3] },
    });
    phone = (await syncOnce(phone, t, 3_000)).data;

    const done = [...((readClientStore(phone, 'events') as any).rep1.completedDates)].sort();
    assert.deepEqual(done, [MON_1, MON_3].sort(), 'Both ticks survive together');
    assert.equal(phoneDay(phone, MON_2).all[0].completed, false, 'and the middle week is untouched');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. UN-TICKING ONE LEAVES THE OTHERS ALONE ---');
  {
    const paths = await freshUser('untick-one', {
      rep1: { ...WEEKLY, completedDates: [MON_1, MON_2, MON_3] },
    });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChange(phone, { ...tickOccurrence(phone, 'rep1', MON_2, true), at: 2_000 });
    phone = (await syncOnce(phone, t, 2_100)).data;

    assert.equal(phoneDay(phone, MON_1).all[0].completed, true, 'Week 1 still done');
    assert.equal(phoneDay(phone, MON_2).all[0].completed, false, 'Week 2 cleared');
    assert.equal(phoneDay(phone, MON_3).all[0].completed, true, 'Week 3 still done');
    assert.deepEqual([...(await pcFile(paths)).rep1.completedDates].sort(), [MON_1, MON_3].sort(),
      'and the PC agrees');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. THE PC DETACHES ONE OCCURRENCE ---');
  {
    // The default editing model: moving or editing a single occurrence excludes
    // that date from the series and creates a standalone item in its place.
    const paths = await freshUser('detach', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    await pcSave(svc, paths, {
      rep1: { ...WEEKLY, exdates: [MON_2] },
      detached: {
        id: 'detached', content: 'Lecture (moved)',
        weekKey: '2026-08-31', dayIndex: 1, startTime: '14:00', endTime: '15:00',
      },
    });
    phone = (await syncOnce(phone, t, 2_000)).data;

    const day = phoneDay(phone, MON_2);
    assert.equal(day.all.length, 1, 'That date shows one item, not two');
    assert.equal(day.all[0].masterId, 'detached', 'and it is the detached one');
    assert.equal(day.all[0].title, 'Lecture (moved)', 'with its new title');
    assert.equal(phoneDay(phone, MON_1).all[0].masterId, 'rep1', 'The series is untouched before');
    assert.equal(phoneDay(phone, MON_3).all[0].masterId, 'rep1', 'and after');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. AN EXCLUDED DATE IS NOT RESURRECTED BY A TICK ELSEWHERE ---');
  {
    const paths = await freshUser('exdate-keep', { rep1: { ...WEEKLY, exdates: [MON_2] } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChange(phone, { ...tickOccurrence(phone, 'rep1', MON_1), at: 2_000 });
    phone = (await syncOnce(phone, t, 2_100)).data;

    assert.equal(phoneDay(phone, MON_2).all.length, 0, 'The excluded week stays excluded');
    assert.deepEqual((await pcFile(paths)).rep1.exdates, [MON_2], 'and the exdate survives the round trip');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. DELETE FROM THE PC REACHES THE PHONE ---');
  {
    const paths = await freshUser('pc-delete', {
      ev1: { id: 'ev1', content: 'Gym', weekKey: '2026-08-24', dayIndex: 1, startTime: '07:00', endTime: '08:00' },
      ev2: { id: 'ev2', content: 'Keep me', weekKey: '2026-08-24', dayIndex: 1, startTime: '11:00', endTime: '12:00' },
    });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;
    assert.equal(phoneDay(phone, MON_1).all.length, 2, 'Both are there to begin with');

    const disk = await pcFile(paths);
    delete disk.ev1;
    await pcSave(svc, paths, disk);
    phone = (await syncOnce(phone, t, 2_000)).data;

    assert.equal((readClientStore(phone, 'events') as any).ev1, undefined, 'The deleted one is gone');
    assert.ok((readClientStore(phone, 'events') as any).ev2, 'and the other survives');
    assert.equal(phoneDay(phone, MON_1).all.length, 1, 'The day shows one item');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. A DELETED ITEM STAYS DELETED ACROSS RESTARTS AND RESYNCS ---');
  {
    const paths = await freshUser('stay-deleted', {
      ev1: { id: 'ev1', content: 'Gym', weekKey: '2026-08-24', dayIndex: 1, startTime: '07:00', endTime: '08:00' },
    });
    let svc = createSyncService();
    let t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    await pcSave(svc, paths, {});
    phone = (await syncOnce(phone, t, 2_000)).data;
    assert.equal((readClientStore(phone, 'events') as any).ev1, undefined, 'Deleted');

    // Restart the server, then force the phone to take a full snapshot.
    svc = createSyncService();
    t = httpTransport(svc, paths);
    phone = { ...phone, cursor: 0 };
    phone = (await syncOnce(phone, t, 3_000)).data;
    assert.equal((readClientStore(phone, 'events') as any).ev1, undefined,
      'and still deleted after a restart and a resync');
    assert.equal((await pcFile(paths)).ev1, undefined, 'and never comes back to the file');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 9. DELETING A REPEAT REMOVES EVERY OCCURRENCE ---');
  {
    const paths = await freshUser('delete-repeat', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;
    assert.equal(phoneDay(phone, MON_2).all.length, 1, 'Occurrences exist first');

    await pcSave(svc, paths, {});
    phone = (await syncOnce(phone, t, 2_000)).data;

    for (const date of [MON_1, MON_2, MON_3]) {
      assert.equal(phoneDay(phone, date).all.length, 0, `${date}: gone`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 10. TICK vs DELETE AT THE SAME TIME RAISES A CARD, NOT A LOSS ---');
  {
    // The one case where the right answer is genuinely unknown: the phone marks
    // an occurrence done while the PC deletes the whole item. Silently choosing
    // either way loses something real, so it must surface.
    const paths = await freshUser('tick-vs-delete', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    // Phone ticks, offline.
    phone = applyLocalChange(phone, { ...tickOccurrence(phone, 'rep1', MON_2), at: 2_000 });
    assert.ok(phone.outbox.length > 0, 'The tick is queued');

    // Meanwhile the PC deletes the series.
    await pcSave(svc, paths, {});

    // The phone reconnects.
    phone = (await syncOnce(phone, t, 3_000)).data;

    const cards = await svc.conflicts(USER, paths);
    assert.equal(cards.length, 1, 'Exactly one conflict card is raised');
    assert.equal(cards[0].kind, 'delete', 'and it is the delete-versus-edit question');
    assert.equal(cards[0].entityId, 'rep1', 'about the right item');

    // Answering "keep" must bring the item back, complete with the tick.
    await svc.resolve(USER, paths, { conflictId: cards[0].id, choice: 'keep', deviceId: PHONE });
    phone = (await syncOnce(phone, t, 4_000)).data;

    const rec = (readClientStore(phone, 'events') as any).rep1;
    assert.ok(rec, 'Keeping it restores the item');
    assert.deepEqual(rec.completedDates, [MON_2], 'with the tick that caused the argument');
    assert.equal((await svc.conflicts(USER, paths)).length, 0, 'and the card is closed');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 11. ANSWERING "DELETE" REALLY DELETES, EVERYWHERE ---');
  {
    const paths = await freshUser('answer-delete', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChange(phone, { ...tickOccurrence(phone, 'rep1', MON_2), at: 2_000 });
    await pcSave(svc, paths, {});
    phone = (await syncOnce(phone, t, 3_000)).data;

    const cards = await svc.conflicts(USER, paths);
    assert.equal(cards.length, 1, 'A card is waiting');
    await svc.resolve(USER, paths, { conflictId: cards[0].id, choice: 'delete', deviceId: PHONE });
    phone = (await syncOnce(phone, t, 4_000)).data;

    assert.equal((readClientStore(phone, 'events') as any).rep1, undefined, 'Gone from the phone');
    assert.equal((await pcFile(paths)).rep1, undefined, 'and from the PC file');
    assert.equal((await svc.conflicts(USER, paths)).length, 0, 'with no card left over');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 12. A LONG MIXED SESSION ON A REPEAT CONVERGES ---');
  {
    const paths = await freshUser('mixed-repeat', { rep1: WEEKLY });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const weeks = [MON_1, MON_2, MON_3, '2026-09-15', '2026-09-22'];
    for (let i = 0; i < 15; i++) {
      const date = weeks[i % weeks.length];
      if (i % 2 === 0) {
        phone = applyLocalChange(phone, {
          ...tickOccurrence(phone, 'rep1', date, i % 4 === 2), at: 10_000 + i,
        });
        phone = (await syncOnce(phone, t, 10_100 + i)).data;
      } else {
        const disk = await pcFile(paths);
        const done: string[] = disk.rep1.completedDates ?? [];
        await pcSave(svc, paths, {
          rep1: {
            ...disk.rep1,
            completedDates: done.includes(date) ? done.filter(d => d !== date) : [...done, date],
          },
        });
        phone = (await syncOnce(phone, t, 10_100 + i)).data;
      }

      const mine = [...((readClientStore(phone, 'events') as any).rep1.completedDates ?? [])].sort();
      const theirs = [...(((await svc.snapshot(USER, paths, 'probe')).stores.events as any)
        .rep1.completedDates ?? [])].sort();
      const file = [...((await pcFile(paths)).rep1.completedDates ?? [])].sort();
      assert.deepEqual(mine, theirs, `Round ${i}: phone and server agree`);
      assert.deepEqual(file, theirs, `Round ${i}: and so does the PC file`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 13. AN ITEM CREATED ON THE PHONE LANDS ON THE PC ---');
  {
    // The phone can now create things, and a record it builds wrongly does not
    // fail — it syncs perfectly and then sits in the wrong week column, or on no
    // day at all. So the check is what the PC FILE ends up holding.
    const paths = await freshUser('phone-create', { seed: { ...WEEKLY, id: 'seed' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    // Exactly what the editor does: infer the week start from existing data,
    // then build the record.
    const weekStartsOn = inferWeekStartsOn(readClientStore(phone, 'events') as any);
    assert.equal(weekStartsOn, 1, 'The week start is read off the seed record');

    const record = buildEventRecord(
      {
        title: 'Made on the phone',
        date: '2026-09-03',
        allDay: false,
        startMin: 14 * 60 + 30,
        endMin: 15 * 60 + 30,
        notes: 'from the sofa',
      },
      { id: 'phone-made-1', now: 2_000, weekStartsOn },
    );

    phone = applyLocalRecord(phone, {
      store: 'events', entityId: 'phone-made-1', record, at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;

    const onPc = (await pcFile(paths))['phone-made-1'];
    assert.ok(onPc, 'The PC file has it');
    assert.equal(onPc.content, 'Made on the phone', 'under `content`, the field events use');
    assert.equal(onPc.title, undefined, 'and not `title`');
    assert.equal(onPc.startTime, '14:30');
    assert.equal(onPc.endTime, '15:30');
    assert.equal(onPc.notes, 'from the sofa');
    assert.equal(dateOfAnchor({ weekKey: onPc.weekKey, dayIndex: onPc.dayIndex }), '2026-09-03',
      'and its anchor resolves to the day that was chosen');

    // And it shows up on the right day for both readers.
    assert.equal(phoneDay(phone, '2026-09-03').all.some(i => i.masterId === 'phone-made-1'), true,
      'The phone shows it on that day');
    const pcDay = buildDay({ events: await pcFile(paths), tasks: {}, date: '2026-09-03' });
    assert.equal(pcDay.all.some(i => i.masterId === 'phone-made-1'), true,
      'and so does the PC');
    assert.equal(
      buildDay({ events: await pcFile(paths), tasks: {}, date: '2026-09-04' })
        .all.some(i => i.masterId === 'phone-made-1'),
      false, 'and on no other day');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 14. A TASK CREATED ON THE PHONE USES THE TASK FIELDS ---');
  {
    const paths = await freshUser('phone-task', { seed: { ...WEEKLY, id: 'seed' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const record = buildTaskRecord(
      { title: 'Take the bins out', date: '2026-09-01', allDay: true, startMin: null, endMin: null },
      { id: 'phone-task-1', now: 2_000, weekStartsOn: 1 },
    );
    phone = applyLocalRecord(phone, {
      store: 'tasks', entityId: 'phone-task-1', record, at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;

    const file = JSON.parse(await fsp.readFile(paths.tasksPath, 'utf-8'));
    assert.equal(file['phone-task-1']?.title, 'Take the bins out', 'Tasks store `title`');
    assert.equal(file['phone-task-1']?.content, undefined, 'and never `content`');
    assert.equal(phoneDay(phone, '2026-09-01').all.some(i => i.store === 'tasks'), true,
      'and it appears as a task on the day');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 15. DELETING FROM THE PHONE REMOVES IT FROM THE PC ---');
  {
    const paths = await freshUser('phone-delete', {
      ev1: { id: 'ev1', content: 'Gym', weekKey: '2026-08-24', dayIndex: 1, startTime: '07:00', endTime: '08:00' },
      ev2: { id: 'ev2', content: 'Keep', weekKey: '2026-08-24', dayIndex: 1, startTime: '11:00', endTime: '12:00' },
    });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    // What `removeItem` writes: a tombstone, never a local removal.
    phone = applyLocalChange(phone, {
      store: 'events', entityId: 'ev1', changes: { [DELETED_FIELD]: true }, at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;

    assert.equal((await pcFile(paths)).ev1, undefined, 'Gone from the PC file');
    assert.ok((await pcFile(paths)).ev2, 'and the other one is untouched');
    assert.equal((readClientStore(phone, 'events') as any).ev1, undefined, 'Gone from the phone');

    // And it stays gone — the PC's next whole-map save must not resurrect it.
    await pcSave(svc, paths, await pcFile(paths));
    phone = (await syncOnce(phone, t, 3_000)).data;
    assert.equal((readClientStore(phone, 'events') as any).ev1, undefined,
      'A PC autosave does not bring it back');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 16. EDITING FROM THE PHONE KEEPS WHAT THE EDITOR NEVER SAW ---');
  {
    const paths = await freshUser('phone-edit', { rep1: { ...WEEKLY, completedDates: [MON_1] } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const existing = (readClientStore(phone, 'events') as any).rep1;
    // Through `draftFromRecord`, the way the editor actually works: the sheet is
    // filled FROM the record, changed, and written back. A draft built by hand
    // would say "no repeat", and clearing it would then be correct.
    const filled = draftFromRecord(existing, 'events', MON_1);
    const record = buildEventRecord(
      { ...filled, title: 'Renamed on the phone', startMin: 11 * 60, endMin: 12 * 60 },
      { id: 'rep1', now: 2_000, weekStartsOn: 1 },
      existing,
    );
    phone = applyLocalRecord(phone, { store: 'events', entityId: 'rep1', record, at: 2_000 });
    phone = (await syncOnce(phone, t, 2_100)).data;

    const onPc = (await pcFile(paths)).rep1;
    assert.equal(onPc.content, 'Renamed on the phone', 'The rename reached the PC');
    assert.equal(onPc.startTime, '11:00', 'and the new time');
    assert.deepEqual(onPc.recur, WEEKLY.recur, 'the repeat rule survived a phone edit');
    assert.deepEqual(onPc.completedDates, [MON_1], 'and so did the ticks');
    assert.equal(phoneDay(phone, MON_2).all.length, 1, 'and the series still expands');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (lifecycle: repeats, deletes, delete-vs-edit, phone-authored items)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
