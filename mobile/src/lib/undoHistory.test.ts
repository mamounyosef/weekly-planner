// Tests for the undo/redo history, run against the real sync engine.
//
// The property that matters is asserted end to end: undoing an action through
// `restoreChanges` lands the planner exactly where it was before the action,
// and redoing it lands exactly where the action left it — including undoing a
// DELETE, which must resurrect the record (a snapshot restore cannot).
//
// The harder edges are here on purpose:
//   • the stack: ordering, the redo half, the history cap;
//   • the diff: which stores are watched, tombstones, one entry per action;
//   • concurrency: a PC edit that lands between an action and its undo must
//     never be silently destroyed — undo is ordinary ops, so the CRDT's
//     last-writer-wins decides, field by field, exactly as for any other edit.
//
// The three steps the provider performs are replayed by hand:
//   diff → push → apply restoreChanges via applyLocalChanges.

import assert from 'node:assert/strict';

import { applyLocalChange, applyLocalRecord, applyLocalChanges, emptyClientData, readClientStore } from './syncClient';
import {
  createUndoHistory, diffForUndo, restoreChanges, UNDO_STORES,
  type UndoEntry,
} from './undoHistory';
import { mergeOps, type SyncOp } from './sync';

const at = 1_700_000_000_000;

/** One step of the planner, the way the provider does it. */
const apply = (data: any, edits: any) => applyLocalChanges(data, edits, at);

/** The entry the provider would record for one action. */
const capture = (label: string, before: any, after: any): UndoEntry =>
  ({ label, changes: diffForUndo(before, after) });

/** Replay an entry the way `applyUndoEntry` does. */
const step = (entry: UndoEntry, direction: 'undo' | 'redo', data: any) =>
  apply(data, restoreChanges(entry, direction, data.state));

/** The readable record, or null when it does not exist (a tombstone hides). */
const recordOf = (data: any, store: any, id: string) =>
  readClientStore(data, store)[id] ?? null;

// ─── The stack ───────────────────────────────────────────────────────────────
{
  const h = createUndoHistory();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), null, 'undo with no past answers nothing');
  assert.equal(h.redo(), null, 'redo with no future answers nothing');
  assert.equal(h.undoLabel(), null);
  assert.equal(h.redoLabel(), null);

  h.push({ label: 'Add item', changes: [] });
  assert.equal(h.canUndo(), false, 'an entry with no changes is not history');
  assert.equal(h.undoLabel(), null, 'and it does not name anything either');
}

{
  const h = createUndoHistory();
  const change = (id: string) => ({ store: 'tasks' as const, entityId: id, before: null, after: { title: id } });
  h.push({ label: 'first', changes: [change('a')] });
  h.push({ label: 'second', changes: [change('b')] });
  h.push({ label: 'third', changes: [change('c')] });

  // UNDO IS LIFO, REDO UN-DOES IT IN ORDER.
  assert.equal(h.undoLabel(), 'third', 'the newest action is named');
  assert.equal(h.undo()!.label, 'third');
  assert.equal(h.undoLabel(), 'second');
  assert.equal(h.redoLabel(), 'third', 'redo names what comes back first');
  assert.equal(h.undo()!.label, 'second');
  assert.equal(h.undoLabel(), 'first');
  assert.equal(h.redo()!.label, 'second', 'redo runs newest-of-the-undone first');
  assert.equal(h.redo()!.label, 'third');
  assert.equal(h.canRedo(), false, 'all the way back to where we were');
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo()!.label, 'third');
}

{
  const h = createUndoHistory();
  const change = (id: string) => ({ store: 'tasks' as const, entityId: id, before: null, after: { title: id } });
  h.push({ label: 'first', changes: [change('a')] });
  h.push({ label: 'second', changes: [change('b')] });

  h.undo();
  // A NEW ACTION SLAMS THE REDO DOOR, but the older past survives.
  h.push({ label: 'third', changes: [change('c')] });
  assert.equal(h.canRedo(), false, 'redo is gone the moment something new is done');
  assert.equal(h.undo()!.label, 'third');
  assert.equal(h.undo()!.label, 'first', 'the abandoned redo half is not in the past either');
  assert.equal(h.undo(), null);
}

{
  // THE CAP. A session can outlive any history; the oldest steps fall off.
  const h = createUndoHistory();
  for (let i = 1; i <= 102; i++) {
    h.push({
      label: `action-${i}`,
      changes: [{ store: 'tasks' as const, entityId: `t${i}`, before: null, after: { title: String(i) } }],
    });
  }
  assert.equal(h.undoLabel(), 'action-102');
  let undos = 0;
  let last: string | null = null;
  for (;;) {
    const entry = h.undo();
    if (!entry) break;
    undos += 1;
    last = entry.label;
  }
  assert.equal(undos, 100, 'only MAX_HISTORY steps are kept');
  assert.equal(last, 'action-3', 'the two oldest fell off the far end');
  assert.equal(h.canRedo(), true, '…and they all moved to the redo half');
  let redos = 0;
  for (;;) {
    const entry = h.redo();
    if (!entry) break;
    redos += 1;
  }
  assert.equal(redos, 100);
}

// ─── Which stores are watched ────────────────────────────────────────────────
{
  assert.deepEqual(UNDO_STORES, ['events', 'tasks'], 'items only, by decision');
}

{
  // Settings, categories, task lists, focus sessions: a phone's own or PC's
  // shared preferences are NOT item history.
  let data = emptyClientData('phone');
  const before = data;
  data = applyLocalRecord(data, { store: 'settings', entityId: 'shared', record: { weekStartsOn: 1 }, at });
  data = applyLocalRecord(data, { store: 'categories', entityId: 'c1', record: { name: 'Personal' }, at });
  data = applyLocalRecord(data, { store: 'taskLists', entityId: 'l1', record: { name: 'Inbox' }, at });
  data = applyLocalRecord(data, { store: 'focusSessions', entityId: 'f1', record: { minutes: 25 }, at });
  assert.deepEqual(diffForUndo(before, data), [], 'no item, no history');
}

{
  // The same state with a longer outbox is not a change.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, { store: 'tasks', entityId: 't1', record: { id: 't1', title: 'x' }, at });
  const louder = { ...data, outbox: [...data.outbox, { ...data.outbox[0], opId: 'echo:1' }] };
  assert.deepEqual(diffForUndo(data, louder), [], 'outbox noise is not item history');
}

{
  assert.deepEqual(diffForUndo(emptyClientData('phone'), emptyClientData('phone')), [], 'nothing done, nothing recorded');
}

// ─── What one action looks like as an entry ──────────────────────────────────
{
  // Create, edit, delete: the three shapes.
  let data = emptyClientData('phone');
  const created = applyLocalRecord(data, { store: 'tasks', entityId: 't1', record: { id: 't1', title: 'A' }, at });
  const created2 = applyLocalRecord(created, { store: 'tasks', entityId: 't2', record: { id: 't2', title: 'B' }, at });

  const createEntry = capture('Add item', data, created);
  assert.equal(createEntry.changes.length, 1);
  assert.equal(createEntry.changes[0]!.before, null, 'a created record had no before');
  assert.deepEqual(createEntry.changes[0]!.after, { id: 't1', title: 'A' });

  const multiCreate = capture('Add item', created, created2);
  assert.equal(multiCreate.changes.length, 1, 'untouched records are not in the entry');

  const deleted = applyLocalChange(created2, { store: 'tasks', entityId: 't1', changes: { __deleted: true }, at });
  const deleteEntry = capture('Delete', created2, deleted);
  assert.equal(deleteEntry.changes.length, 1);
  assert.equal(deleteEntry.changes[0]!.after, null, 'a deleted record reads as absence');
  assert.deepEqual(deleteEntry.changes[0]!.before, { id: 't1', title: 'A' });
}

{
  // BOTH stores in one diff, one change per record, no duplicates — the batch
  // applier refuses duplicates, so the diff must never produce them.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, { store: 'tasks', entityId: 't1', record: { id: 't1', title: 'A' }, at });
  data = applyLocalRecord(data, { store: 'events', entityId: 'e1', record: { id: 'e1', title: 'B' }, at });
  const before = data;
  let after = applyLocalRecord(before, { store: 'tasks', entityId: 't1', record: { id: 't1', title: 'A2' }, at });
  after = applyLocalRecord(after, { store: 'events', entityId: 'e1', record: { id: 'e1', title: 'B2' }, at });
  const entry = capture('Edit item', before, after);
  assert.equal(entry.changes.length, 2);
  const keys = entry.changes.map(c => `${c.store}/${c.entityId}`).sort();
  assert.deepEqual(keys, ['events/e1', 'tasks/t1']);
  assert.equal(new Set(keys).size, keys.length, 'unique per store and id');
}

{
  // A tombstoned record recreated under a NEW id: two separate facts.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, { store: 'tasks', entityId: 't1', record: { id: 't1', title: 'old' }, at });
  const before = data;
  let after = applyLocalChange(before, { store: 'tasks', entityId: 't1', changes: { __deleted: true }, at });
  after = applyLocalRecord(after, { store: 'tasks', entityId: 't2', record: { id: 't2', title: 'old' }, at });
  const entry = capture('Replace item', before, after);
  assert.equal(entry.changes.length, 2, 'a delete and a create, not a rename of one record');
  const t1 = entry.changes.find(c => c.entityId === 't1')!;
  const t2 = entry.changes.find(c => c.entityId === 't2')!;
  assert.equal(t1.after, null);
  assert.equal(t2.before, null);
}

// ─── restoreChanges, pure: the edits it asks for ─────────────────────────────
{
  // Undoing a create must TOMBSTONE, never hard-delete.
  const entry: UndoEntry = {
    label: 'Add item',
    changes: [{ store: 'tasks', entityId: 't1', before: null, after: { id: 't1', title: 'A' } }],
  };
  const edits = restoreChanges(entry, 'undo', emptyClientData('phone').state);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0]!.changes, { __deleted: true });
}

{
  // The direction picks the image; nothing is mutated along the way.
  const entry: UndoEntry = {
    label: 'Edit item',
    changes: [{ store: 'tasks', entityId: 't1', before: { id: 't1', title: 'A' }, after: { id: 't1', title: 'B' } }],
  };
  const frozen = JSON.stringify(entry);
  const undoEdits = restoreChanges(entry, 'undo', emptyClientData('phone').state);
  const redoEdits = restoreChanges(entry, 'redo', emptyClientData('phone').state);
  assert.deepEqual(undoEdits[0]!.changes, { id: 't1', title: 'A' });
  assert.deepEqual(redoEdits[0]!.changes, { id: 't1', title: 'B' });
  assert.equal(JSON.stringify(entry), frozen, 'the entry is untouched');
}

{
  // A register field added after the target image is cleared EXPLICITLY.
  const state = emptyClientData('phone').state;
  const entry: UndoEntry = {
    label: 'Edit item',
    changes: [{ store: 'tasks', entityId: 't1', before: { id: 't1', title: 'A' }, after: { id: 't1', title: 'A', notes: 'x' } }],
  };
  const live = applyLocalRecord(emptyClientData('phone'), { store: 'tasks', entityId: 't1', record: { id: 't1', title: 'A', notes: 'x' }, at });
  const edits = restoreChanges(entry, 'undo', live.state);
  assert.equal(edits[0]!.changes.notes, undefined, 'an explicit clear, not an omission');
}

{
  // Resurrecting includes the tombstone flip; a live restore does not.
  const entry: UndoEntry = {
    label: 'Delete',
    changes: [{ store: 'tasks', entityId: 't1', before: { id: 't1', title: 'A' }, after: null }],
  };
  const tombstoned = applyLocalChange(emptyClientData('phone'), { store: 'tasks', entityId: 't1', changes: { __deleted: true }, at });
  const edits = restoreChanges(entry, 'undo', tombstoned.state);
  assert.equal(edits[0]!.changes.__deleted, false, 'the same write the conflict card\'s "keep" makes');
}

// ─── Through the engine: create, edit, delete ────────────────────────────────
{
  let data = emptyClientData('phone');
  const created = applyLocalRecord(data, {
    store: 'tasks', entityId: 't1',
    record: { id: 't1', title: 'Buy milk', order: 1 }, at,
  });
  const entry = capture('Add item', data, created);
  data = created;

  // UNDO: the record did not exist before, so undo must tombstone it.
  const undone = step(entry, 'undo', data);
  assert.equal(recordOf(undone, 'tasks', 't1'), null, 'undo removes the created record');
  assert.ok(undone.outbox.length > data.outbox.length, 'the undo left sync ops behind');
  assert.ok(undone.outbox[undone.outbox.length - 1]!.device === 'phone', 'and they are ordinary local ops');

  // Applying the same revert twice changes nothing further (the values agree).
  const reUndone = step(entry, 'undo', undone);
  assert.deepEqual(recordOf(reUndone, 'tasks', 't1'), recordOf(undone, 'tasks', 't1'));

  // REDO: the record comes back whole.
  const redone = step(entry, 'redo', undone);
  assert.deepEqual(
    recordOf(redone, 'tasks', 't1'),
    { id: 't1', title: 'Buy milk', order: 1 },
    'redo restores the created record',
  );
}

{
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'events', entityId: 'e1',
    record: { id: 'e1', title: 'Lunch', minutes: 30 }, at,
  });
  const before = data;
  const moved = applyLocalRecord(data, {
    store: 'events', entityId: 'e1',
    record: { id: 'e1', title: 'Lunch', minutes: 45 }, at,
  });
  const entry = capture('Edit item', before, moved);
  data = moved;

  const undone = step(entry, 'undo', data);
  assert.deepEqual(
    recordOf(undone, 'events', 'e1'),
    { id: 'e1', title: 'Lunch', minutes: 30 },
    'undo puts the old value back',
  );

  const redone = step(entry, 'redo', undone);
  assert.equal(recordOf(redone, 'events', 'e1')!.minutes, 45);
}

{
  // DELETE → UNDO (RESURRECTION) → REDO.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 't2',
    record: { id: 't2', title: 'Read', notes: 'chapter 3' }, at,
  });
  const before = data;
  const removed = applyLocalChange(before, {
    store: 'tasks', entityId: 't2', changes: { __deleted: true }, at,
  });
  const entry = capture('Delete', before, removed);
  data = removed;

  const undone = step(entry, 'undo', data);
  assert.deepEqual(
    recordOf(undone, 'tasks', 't2'),
    { id: 't2', title: 'Read', notes: 'chapter 3' },
    'undoing a delete resurrects the record',
  );

  const redone = step(entry, 'redo', undone);
  assert.equal(recordOf(redone, 'tasks', 't2'), null, 'redo deletes it again');
}

{
  // Resurrect a record with SET members: the ticks come back too.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 't3',
    record: { id: 't3', title: 'Stretch', completed: true, completedDates: ['2026-09-07'] }, at,
  });
  const before = data;
  const removed = applyLocalChange(before, { store: 'tasks', entityId: 't3', changes: { __deleted: true }, at });
  const entry = capture('Delete', before, removed);

  const undone = step(entry, 'undo', removed);
  const t3 = recordOf(undone, 'tasks', 't3')!;
  assert.equal(t3.completed, true, 'the flag is back');
  assert.deepEqual(t3.completedDates, ['2026-09-07'], 'the set members are back');
}

// ─── Through the engine: set fields ──────────────────────────────────────────
{
  // UNDOING A TICK. completedDates is a set field; absent fields emit no op,
  // so an undo that only wrote the "before" image would leave the tick in.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 't4',
    record: { id: 't4', title: 'Stretch' }, at,
  });
  const before = data;
  const ticked = applyLocalRecord(data, {
    store: 'tasks', entityId: 't4',
    record: { id: 't4', title: 'Stretch', completed: true, completedDates: ['2026-09-07'] }, at,
  });
  const entry = capture('Mark done', before, ticked);
  data = ticked;

  const undone = step(entry, 'undo', data);
  const t4 = recordOf(undone, 'tasks', 't4')!;
  assert.equal(t4.completed, undefined, 'the flag went back');
  const dates = t4.completedDates as string[] | undefined;
  assert.ok(!dates || dates.length === 0, 'the tick member is gone from the set');
}

{
  // UNDOING AN UNTICK puts the member back — the same diff machinery, the
  // other direction.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 't5',
    record: { id: 't5', title: 'Walk', completed: true, completedDates: ['2026-09-07'] }, at,
  });
  const before = data;
  const unticked = applyLocalRecord(data, {
    store: 'tasks', entityId: 't5',
    record: { id: 't5', title: 'Walk' }, at,
  });
  const entry = capture('Mark not done', before, unticked);

  const undone = step(entry, 'undo', unticked);
  const t5 = recordOf(undone, 'tasks', 't5')!;
  assert.deepEqual(t5.completedDates, ['2026-09-07'], 'the member is a member again');
  assert.equal(t5.completed, true);
}

{
  // EXDATES — the other set field — behave the same on events.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'events', entityId: 'e3',
    record: { id: 'e3', title: 'Class' }, at,
  });
  const before = data;
  const excluded = applyLocalRecord(data, {
    store: 'events', entityId: 'e3',
    record: { id: 'e3', title: 'Class', exdates: ['2026-09-14'] }, at,
  });
  const entry = capture('Edit occurrence', before, excluded);

  const undone = step(entry, 'undo', excluded);
  const e3 = recordOf(undone, 'events', 'e3')!;
  const ex = e3.exdates as string[] | undefined;
  assert.ok(!ex || ex.length === 0, 'the exclusion is taken back');
}

// ─── Through the engine: a field nobody wrote before ─────────────────────────
{
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'events', entityId: 'e2', record: { id: 'e2', title: 'Call' }, at,
  });
  const before = data;
  const annotated = applyLocalRecord(before, {
    store: 'events', entityId: 'e2',
    record: { id: 'e2', title: 'Call', notes: 'ask about Tuesday' }, at,
  });
  const entry = capture('Edit item', before, annotated);

  const undone = step(entry, 'undo', annotated);
  assert.deepEqual(
    recordOf(undone, 'events', 'e2'),
    { id: 'e2', title: 'Call' },
    'the notes field is gone, not merely absent from the write',
  );
}

// ─── Through the engine: hidden state under a tombstone ──────────────────────
{
  // A record edited WHILE deleted (a concurrent write, an old backup) keeps
  // its hidden fields. Resurrecting must not drag them back into the light.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 't6', record: { id: 't6', title: 'Faded' }, at,
  });
  const before = data;
  let removed = applyLocalChange(before, { store: 'tasks', entityId: 't6', changes: { __deleted: true }, at });
  removed = applyLocalChange(removed, {
    store: 'tasks', entityId: 't6', changes: { notes: 'written while deleted' }, at,
  });
  const entry = capture('Delete', before, removed);

  const undone = step(entry, 'undo', removed);
  assert.deepEqual(
    recordOf(undone, 'tasks', 't6'),
    { id: 't6', title: 'Faded' },
    'the hidden edit does not resurrect with the record',
  );
}

// ─── One action, several records (a recurring split) ─────────────────────────
{
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'events', entityId: 'm1',
    record: { id: 'm1', title: 'Class', minutes: 60 }, at,
  });
  const before = data;
  let after = applyLocalRecord(before, {
    store: 'events', entityId: 'm1',
    record: { id: 'm1', title: 'Class', minutes: 90 }, at,
  });
  after = applyLocalRecord(after, {
    store: 'events', entityId: 'm2',
    record: { id: 'm2', title: 'Class', minutes: 90 }, at,
  });
  const entry = capture('Edit occurrence', before, after);
  assert.equal(entry.changes.length, 2, 'both touched records are one entry');

  const undone = step(entry, 'undo', after);
  assert.equal(recordOf(undone, 'events', 'm1')!.minutes, 60, 'first record reverted');
  assert.equal(recordOf(undone, 'events', 'm2'), null, 'created half reverted too');

  const redone = step(entry, 'redo', undone);
  assert.equal(recordOf(redone, 'events', 'm1')!.minutes, 90);
  assert.ok(recordOf(redone, 'events', 'm2'), 'both come back together');
}

// ─── One action that edits, creates AND deletes at once ──────────────────────
{
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, { store: 'tasks', entityId: 'a', record: { id: 'a', title: 'A' }, at });
  data = applyLocalRecord(data, { store: 'tasks', entityId: 'b', record: { id: 'b', title: 'B' }, at });
  const before = data;

  let after = applyLocalRecord(before, { store: 'tasks', entityId: 'a', record: { id: 'a', title: 'A2' }, at });
  after = applyLocalChange(after, { store: 'tasks', entityId: 'b', changes: { __deleted: true }, at });
  after = applyLocalRecord(after, { store: 'tasks', entityId: 'c', record: { id: 'c', title: 'C' }, at });

  const entry = capture('Reorder', before, after);
  assert.equal(entry.changes.length, 3);

  const undone = step(entry, 'undo', after);
  assert.deepEqual(recordOf(undone, 'tasks', 'a'), { id: 'a', title: 'A' }, 'edit reverted');
  assert.deepEqual(recordOf(undone, 'tasks', 'b'), { id: 'b', title: 'B' }, 'delete undone');
  assert.equal(recordOf(undone, 'tasks', 'c'), null, 'create undone');

  const redone = step(entry, 'redo', undone);
  assert.equal(recordOf(redone, 'tasks', 'a')!.title, 'A2');
  assert.equal(recordOf(redone, 'tasks', 'b'), null);
  assert.ok(recordOf(redone, 'tasks', 'c'));
}

// ─── Restoring into a state that has never seen the record ───────────────────
{
  // After a full rebuild (a fresh install pulling everything) the local state
  // may not have the entity at all. A restore must still be able to build it.
  const entry: UndoEntry = {
    label: 'Delete',
    changes: [{ store: 'tasks', entityId: 'far', before: { id: 'far', title: 'Kept', order: 2 }, after: null }],
  };
  const fresh = emptyClientData('phone');
  const edits = restoreChanges(entry, 'undo', fresh.state);
  assert.equal(edits[0]!.changes.__deleted, undefined, 'no tombstone to lift, so no flip op');
  const restored = apply(fresh, edits);
  assert.deepEqual(
    recordOf(restored, 'tasks', 'far'),
    { id: 'far', title: 'Kept', order: 2 },
    'the record is written whole into empty state',
  );
}

// ─── Concurrency: the PC edits while the undo is on its way ──────────────────
{
  // An OLDER PC edit (a lower lamport) loses to the undo, exactly as it would
  // lose to any phone edit: undo writes ordinary ops.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 'r1', record: { id: 'r1', title: 'A', minutes: 30 }, at,
  });
  const before = data;
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 'r1', record: { id: 'r1', title: 'A', minutes: 45 }, at,
  });
  const entry = capture('Edit item', before, data);

  const stalePcOp: SyncOp = {
    opId: 'pc:2', store: 'tasks', entityId: 'r1', field: 'title',
    value: 'PC stale title', device: 'pc', lamport: 2, at,
  };
  const raced = { ...data, state: mergeOps(data.state, [stalePcOp]).state };

  const undone = step(entry, 'undo', raced);
  const r1 = recordOf(undone, 'tasks', 'r1')!;
  assert.equal(r1.title, 'A', 'the undo out-ranks the stale peer edit');
  assert.equal(r1.minutes, 30);
}

{
  // A PC edit that lands BETWEEN the action and its undo. The phone merges the
  // PC's op first, so the lamport clock absorbs it — the undo is stamped after
  // everything the phone has seen and wins. That is the honest reading of the
  // gesture: the user pressed undo on the planner AS IT IS NOW. Nothing is
  // lost silently either — the undo's ops carry the PC head as their base, so
  // the race stays visible to conflict detection downstream.
  let data = emptyClientData('phone');
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 'r2', record: { id: 'r2', title: 'A', minutes: 30 }, at,
  });
  const before = data;
  data = applyLocalRecord(data, {
    store: 'tasks', entityId: 'r2', record: { id: 'r2', title: 'A', minutes: 45 }, at,
  });
  const entry = capture('Edit item', before, data);

  const freshPcOp: SyncOp = {
    opId: 'pc:9999', store: 'tasks', entityId: 'r2', field: 'title',
    value: 'PC newer title', device: 'pc', lamport: 9999, at,
  };
  const raced = { ...data, state: mergeOps(data.state, [freshPcOp]).state };

  const undone = step(entry, 'undo', raced);
  const r2 = recordOf(undone, 'tasks', 'r2')!;
  assert.equal(r2.title, 'A', 'the undo overwrites what the phone has seen');
  assert.equal(r2.minutes, 30);
  const undoTitleOps = undone.outbox.slice(data.outbox.length)
    .filter(o => o.field === 'title');
  assert.ok(undoTitleOps.length > 0);
  assert.equal(undoTitleOps[0]!.baseDevice, 'pc', 'the race is stamped, not hidden');
  assert.equal(undoTitleOps[0]!.baseLamport, 9999);
}

// ─── A whole session, start to finish ────────────────────────────────────────
{
  // create → tick → rename → delete, then walk the whole stack back and
  // forward again and check the state at every landing.
  let data = emptyClientData('phone');
  const d1 = applyLocalRecord(data, {
    store: 'tasks', entityId: 's1', record: { id: 's1', title: 'Milk', order: 1 }, at,
  });
  const e1 = capture('Add item', data, d1);

  const d2 = applyLocalRecord(d1, {
    store: 'tasks', entityId: 's1',
    record: { id: 's1', title: 'Milk', order: 1, completed: true, completedDates: ['2026-09-07'] }, at,
  });
  const e2 = capture('Mark done', d1, d2);

  const d3 = applyLocalRecord(d2, {
    store: 'tasks', entityId: 's1',
    record: { id: 's1', title: 'Buy milk', order: 1, completed: true, completedDates: ['2026-09-07'] }, at,
  });
  const e3 = capture('Edit item', d2, d3);

  const d4 = applyLocalChange(d3, { store: 'tasks', entityId: 's1', changes: { __deleted: true }, at });
  const e4 = capture('Delete', d3, d4);

  let walking = d4;
  walking = step(e4, 'undo', walking);
  assert.ok(recordOf(walking, 'tasks', 's1'), 'undeleted');
  assert.equal(recordOf(walking, 'tasks', 's1')!.title, 'Buy milk');

  walking = step(e3, 'undo', walking);
  assert.equal(recordOf(walking, 'tasks', 's1')!.title, 'Milk', 'rename taken back');

  walking = step(e2, 'undo', walking);
  const s1 = recordOf(walking, 'tasks', 's1')!;
  assert.equal(s1.completed, undefined, 'unticked');
  const dates = s1.completedDates as string[] | undefined;
  assert.ok(!dates || dates.length === 0, 'tick member removed');

  walking = step(e1, 'undo', walking);
  assert.equal(recordOf(walking, 'tasks', 's1'), null, 'back to empty');

  // And forward again: create, tick, rename — but stop before the delete.
  walking = step(e1, 'redo', walking);
  const s1back = recordOf(walking, 'tasks', 's1')!;
  assert.equal(s1back.title, 'Milk');
  assert.equal(s1back.order, 1);
  // Resurrection reads hidden state through `peekEntity`, which shows register
  // fields only — the empty set the tick-undo left behind survives it. It is
  // inert: no members, so every reader sees "never ticked".
  const datesBack = s1back.completedDates as string[] | undefined;
  assert.ok(!datesBack || datesBack.length === 0, 'no tick survived the round trip');

  walking = step(e2, 'redo', walking);
  assert.equal(recordOf(walking, 'tasks', 's1')!.completed, true);

  walking = step(e3, 'redo', walking);
  assert.equal(recordOf(walking, 'tasks', 's1')!.title, 'Buy milk');

  walking = step(e4, 'redo', walking);
  assert.equal(recordOf(walking, 'tasks', 's1'), null, 'deleted again, exactly where we started');
}

console.log('undoHistory: all tests passed');
