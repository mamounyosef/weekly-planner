// Tests the snapshot ↔ operation bridge: the adapter that lets the PC keep
// saving whole files while the phone speaks per-field operations.
//
// The properties that matter here are LOSSLESSNESS (a save must not erase a
// field) and QUIETNESS (an unchanged save must emit zero ops — otherwise every
// poll would produce a write storm and the two windows would fight, exactly the
// failure the settings sync already taught us about).
//
// Run with: npx tsx src/lib/syncBridge.test.ts

import assert from 'node:assert/strict';
import {
  emptyState,
  isTombstoned,
  mergeOps,
  readStore,
  type SyncState,
} from './sync';
import {
  PC_ONLY_FIELDS,
  changedIds,
  isSyncableField,
  opsToSnapshot,
  sameValue,
  snapshotToOps,
  type Snapshot,
} from './syncBridge';

const PC = 'pc-desktop';
const PH = 'phone-android';

/** Save a snapshot the way the server will: diff → ops → merge. */
function save(state: SyncState, snapshot: Snapshot, device = PC, at = 1_000, store: any = 'events') {
  const ops = snapshotToOps(state, { store, snapshot, device, at });
  const res = mergeOps(state, ops);
  return { state: res.state, ops, conflicts: res.conflicts };
}

console.log('--- 1. FIELD FILTERING ---');
assert.ok(isSyncableField('title'));
assert.ok(isSyncableField('startTime'));
assert.ok(isSyncableField('notify'), 'Reminder specs MUST sync — they drive the phone alarms');
assert.ok(!isSyncableField('gCalETag'), 'Google bookkeeping stays on the PC');
assert.ok(!isSyncableField('lastSyncedAt'));
assert.ok(!isSyncableField('masterId'), 'View-only occurrence fields are never persisted');
assert.ok(!isSyncableField('occDate'));
assert.ok(!isSyncableField('__deleted'), 'Deletion is an op, not a syncable field');
assert.ok(PC_ONLY_FIELDS.has('gTaskETag'));

console.log('--- 2. VALUE COMPARISON ---');
assert.ok(sameValue(1, 1));
assert.ok(sameValue('a', 'a'));
assert.ok(sameValue(undefined, undefined));
assert.ok(sameValue([1, 2], [1, 2]));
assert.ok(sameValue({ a: 1 }, { a: 1 }));
assert.ok(!sameValue(1, '1'), 'Types are not coerced');
assert.ok(!sameValue(null, undefined), 'null and undefined are distinguishable');
assert.ok(!sameValue([1, 2], [2, 1]), 'Array order matters for ordinary fields');

console.log('--- 3. A FIRST SAVE BECOMES OPS; AN IDENTICAL RESAVE IS SILENT ---');
{
  let s = emptyState();
  const snap: Snapshot = {
    ev1: { title: 'Physics', startTime: '18:00', endTime: '19:30' },
    ev2: { title: 'Gym', allDay: true },
  };
  const first = save(s, snap);
  s = first.state;
  assert.equal(first.ops.length, 5, 'One op per field across both events');
  assert.deepEqual(readStore(s, 'events'), snap, 'State matches what was saved');

  // THE WRITE-STORM GUARD: saving the identical file again must produce nothing.
  const again = save(s, snap, PC, 2_000);
  assert.equal(again.ops.length, 0, 'An unchanged save must emit ZERO ops');
  assert.equal(again.conflicts.length, 0);

  // Ten identical saves, as an autosave loop would do.
  for (let i = 0; i < 10; i++) {
    const r = save(s, snap, PC, 3_000 + i);
    assert.equal(r.ops.length, 0, `Repeat save ${i} must stay silent`);
    s = r.state;
  }
}

console.log('--- 4. ONLY THE CHANGED FIELD BECOMES AN OP ---');
{
  let s = emptyState();
  s = save(s, { ev1: { title: 'Physics', startTime: '18:00', categoryId: 'uni' } }).state;

  const r = save(s, { ev1: { title: 'Physics', startTime: '20:00', categoryId: 'uni' } }, PC, 2_000);
  assert.equal(r.ops.length, 1, 'Editing one field of one event emits exactly one op');
  assert.equal(r.ops[0].field, 'startTime');
  assert.equal(r.ops[0].value, '20:00');
}

console.log('--- 5. A REMOVED FIELD IS CLEARED, NOT LEFT STALE ---');
{
  let s = emptyState();
  s = save(s, { ev1: { title: 'x', endTime: '10:00', notify: { enabled: true } } }).state;

  // The PC saves the same event without `notify` — the user turned it back to
  // "inherit". If this did not emit a clear, the phone would keep firing an
  // explicit reminder the PC no longer has.
  const r = save(s, { ev1: { title: 'x', endTime: '10:00' } }, PC, 2_000);
  s = r.state;
  const fields = r.ops.map(o => o.field);
  assert.deepEqual(fields, ['notify'], 'Removing a field emits a clear for it');
  assert.equal(r.ops[0].value, undefined);
  assert.deepEqual(readStore(s, 'events'), { ev1: { title: 'x', endTime: '10:00' } },
    'and the field is genuinely gone');
}

console.log('--- 6. A MISSING RECORD IS A DELETE ---');
{
  let s = emptyState();
  s = save(s, { ev1: { title: 'a' }, ev2: { title: 'b' } }).state;

  const r = save(s, { ev1: { title: 'a' } }, PC, 2_000);
  s = r.state;
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].field, '__deleted');
  assert.ok(isTombstoned(s, 'events', 'ev2'), 'The dropped event is tombstoned');
  assert.deepEqual(Object.keys(readStore(s, 'events')), ['ev1']);

  // Deleting the same thing again is not a fresh op.
  const r2 = save(s, { ev1: { title: 'a' } }, PC, 3_000);
  assert.equal(r2.ops.length, 0, 'An already-deleted record does not re-emit a delete');
}

console.log('--- 7. PARTIAL SAVES MUST NOT DELETE EVERYTHING ELSE ---');
{
  let s = emptyState();
  s = save(s, { ev1: { title: 'a' }, ev2: { title: 'b' }, ev3: { title: 'c' } }).state;

  // A caller that only holds one week must be able to say so, or a partial save
  // would wipe the rest of the planner — the worst possible bug in this file.
  const ops = snapshotToOps(s, {
    store: 'events', snapshot: { ev1: { title: 'a2' } },
    device: PC, at: 2_000, detectDeletes: false,
  });
  s = mergeOps(s, ops).state;
  assert.equal(Object.keys(readStore(s, 'events')).length, 3, 'Nothing was deleted');
  assert.equal(readStore(s, 'events').ev1.title, 'a2', 'and the edit still landed');
}

console.log('--- 8. SET FIELDS: REORDERING IS NOT A CHANGE ---');
{
  let s = emptyState();
  s = save(s, { ev1: { title: 'r', exdates: ['2026-09-03', '2026-09-01'] } }).state;

  const r = save(s, { ev1: { title: 'r', exdates: ['2026-09-01', '2026-09-03'] } }, PC, 2_000);
  assert.equal(r.ops.length, 0, 'The same exdates in a different order is not a change');

  const added = save(s, { ev1: { title: 'r', exdates: ['2026-09-01', '2026-09-03', '2026-09-10'] } }, PC, 3_000);
  assert.equal(added.ops.length, 1, 'Adding one exdate emits one op');
  assert.equal(added.ops[0].present, true);

  const removed = save(s, { ev1: { title: 'r', exdates: ['2026-09-01'] } }, PC, 4_000);
  assert.equal(removed.ops.length, 1, 'Removing one exdate emits one op');
  assert.equal(removed.ops[0].present, false);

  // Emptying the array entirely.
  const cleared = save(s, { ev1: { title: 'r' } }, PC, 5_000);
  assert.equal(cleared.ops.length, 2, 'Dropping the field clears both members');
  assert.deepEqual(readStore(cleared.state, 'events').ev1.exdates, []);
}

console.log('--- 9. LOSSLESS ROUND TRIP ---');
{
  // Snapshot → ops → state → snapshot must be an identity. If it is not, every
  // save silently erases something.
  const snap: Snapshot = {
    ev1: {
      title: 'Physics revision', startTime: '18:00', endTime: '19:30',
      categoryId: 'study', allDay: false, daysSpan: 1, dayIndex: 3,
      weekKey: '2026-08-30', locked: true,
      recur: { freq: 'weekly', interval: 1, byWeekday: [3] },
      exdates: ['2026-09-03'],
      notify: { enabled: true, offsets: [10, 60] },
    },
    ev2: { title: 'All-day thing', allDay: true, daysSpan: 3 },
  };
  const s = save(emptyState(), snap).state;
  assert.deepEqual(opsToSnapshot(s, 'events'), snap, 'Round trip is lossless');

  // Including nested objects and arrays surviving intact.
  const back = opsToSnapshot(s, 'events');
  assert.deepEqual(back.ev1.recur, { freq: 'weekly', interval: 1, byWeekday: [3] });
  assert.deepEqual(back.ev1.notify, { enabled: true, offsets: [10, 60] });
}

console.log('--- 10. GOOGLE BOOKKEEPING SURVIVES A PHONE EDIT ---');
{
  // The phone edits an event that the PC has synced to Google. The ETag must
  // still be there afterwards, or the next Google sync re-uploads everything.
  const disk: Snapshot = {
    ev1: { title: 'Lecture', startTime: '09:00', gCalETag: '"etag-123"', lastSyncedAt: 1234 },
  };
  let s = save(emptyState(), disk).state;

  // Nothing Google-owned became an operation.
  assert.equal(opsToSnapshot(s, 'events').ev1.gCalETag, undefined,
    'ETags are absent from pure sync state');

  // The phone moves it.
  const phoneOps = snapshotToOps(s, {
    store: 'events', snapshot: { ev1: { title: 'Lecture', startTime: '11:00' } },
    device: PH, at: 5_000, detectDeletes: false,
  });
  s = mergeOps(s, phoneOps).state;

  const rebuilt = opsToSnapshot(s, 'events', disk);
  assert.equal(rebuilt.ev1.startTime, '11:00', "The phone's edit landed");
  assert.equal(rebuilt.ev1.gCalETag, '"etag-123"', 'and the ETag was carried forward');
  assert.equal(rebuilt.ev1.lastSyncedAt, 1234, 'as was the sync timestamp');
}

console.log('--- 11. A DELETED RECORD DROPS ITS GOOGLE FIELDS TOO ---');
{
  const disk: Snapshot = { ev1: { title: 'x', gCalETag: '"e1"' }, ev2: { title: 'y', gCalETag: '"e2"' } };
  let s = save(emptyState(), disk).state;
  s = save(s, { ev1: { title: 'x' } }, PC, 2_000).state;
  const rebuilt = opsToSnapshot(s, 'events', disk);
  assert.deepEqual(Object.keys(rebuilt), ['ev1'], 'The tombstoned record is gone from the file');
  assert.equal(rebuilt.ev1.gCalETag, '"e1"', 'and the survivor keeps its ETag');
}

console.log('--- 12. THE FULL LOOP: PC SAVES A FILE, PHONE EDITS, BOTH AGREE ---');
{
  // This is the real scenario end to end, through the bridge on both sides.
  const disk: Snapshot = {
    ev1: { title: 'Physics', startTime: '18:00', categoryId: 'uni', gCalETag: '"e"' },
  };
  let server = save(emptyState(), disk).state;

  // Phone syncs down, then edits offline.
  // (The transport hands the phone the op log; here we rebuild it from state.)
  let phone = emptyState();
  const log = snapshotToOps(emptyState(), {
    store: 'events', snapshot: opsToSnapshot(server, 'events'), device: PC, at: 1_000,
  });
  phone = mergeOps(phone, log).state;
  assert.deepEqual(readStore(phone, 'events'), readStore(server, 'events'),
    'The phone starts in step with the PC');

  // Phone moves the event; PC renames it. Different fields → both survive.
  const phoneOps = snapshotToOps(phone, {
    store: 'events',
    snapshot: { ev1: { ...readStore(phone, 'events').ev1, startTime: '20:00' } },
    device: PH, at: 5_000,
  });
  phone = mergeOps(phone, phoneOps).state;

  const pcOps = snapshotToOps(server, {
    store: 'events',
    snapshot: { ev1: { ...opsToSnapshot(server, 'events').ev1, title: 'Physics revision' } },
    device: PC, at: 5_001,
  });
  server = mergeOps(server, pcOps).state;

  // Exchange.
  server = mergeOps(server, phoneOps).state;
  phone = mergeOps(phone, pcOps).state;

  assert.deepEqual(readStore(server, 'events'), readStore(phone, 'events'), 'Both agree');
  const final = opsToSnapshot(server, 'events', disk);
  assert.equal(final.ev1.startTime, '20:00', "Phone's move survived");
  assert.equal(final.ev1.title, 'Physics revision', "PC's rename survived");
  assert.equal(final.ev1.gCalETag, '"e"', 'Google bookkeeping intact');
}

console.log('--- 13. changedIds REPORTS EXACTLY WHAT MUST BE REWRITTEN ---');
{
  const disk: Snapshot = { ev1: { title: 'a' }, ev2: { title: 'b' } };
  let s = save(emptyState(), disk).state;
  assert.deepEqual(changedIds(s, 'events', disk), [],
    'Nothing to rewrite when state and disk agree');

  const ops = snapshotToOps(s, {
    store: 'events', snapshot: { ev1: { title: 'a2' }, ev2: { title: 'b' } },
    device: PH, at: 2_000,
  });
  s = mergeOps(s, ops).state;
  assert.deepEqual(changedIds(s, 'events', disk), ['ev1'],
    'Only the record the phone touched is reported');
}

console.log('--- 14. TASKS GO THROUGH THE SAME BRIDGE ---');
{
  let s = emptyState();
  const tasks: Snapshot = {
    t1: { title: 'Water plants', listId: 'home', completedDates: ['2026-09-01'], gTaskETag: '"t"' },
  };
  s = save(s, tasks, PC, 1_000, 'tasks').state;
  assert.deepEqual(opsToSnapshot(s, 'tasks', tasks), tasks, 'Tasks round-trip losslessly');

  // completedDates behaves as a set here too.
  const r = save(s, {
    t1: { title: 'Water plants', listId: 'home', completedDates: ['2026-09-01', '2026-09-02'] },
  }, PH, 2_000, 'tasks');
  assert.equal(r.ops.length, 1, 'Ticking one more day is one op');
  assert.equal(r.ops[0].present, true);
  assert.equal(r.conflicts.length, 0, 'and never a conflict');
}

console.log('--- 15. EMPTY AND DEGENERATE INPUTS ---');
{
  const s = emptyState();
  assert.deepEqual(snapshotToOps(s, { store: 'events', snapshot: {}, device: PC, at: 1 }), [],
    'An empty snapshot against empty state is a no-op');
  assert.deepEqual(opsToSnapshot(s, 'events'), {}, 'Empty state rebuilds to an empty file');
  assert.deepEqual(changedIds(s, 'events', {}), []);

  // A record with no fields at all must not crash or invent ops.
  const r = save(emptyState(), { ev1: {} });
  assert.equal(r.ops.length, 0, 'A fieldless record produces nothing');
  assert.deepEqual(readStore(r.state, 'events'), {},
    'and does not materialise as an empty event');
}

console.log('\nALL PASS (snapshot ↔ operation bridge)');
