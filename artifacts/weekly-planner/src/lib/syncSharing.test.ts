// Tests for the one rule that lets the merge share structure with the state it
// came from: NOTHING REACHABLE FROM THE OLD STATE IS EVER WRITTEN TO.
//
// `mergeOps` used to deep clone the entire planner before touching anything,
// which made this rule impossible to break and every tap cost the whole
// history. It now copies only the store and the entity an op actually names.
// That is a much better trade and a much sharper knife: one stray mutation
// through a shared reference and a peer's history changes underneath it, which
// is the single failure this engine cannot recover from.
//
// So the central test here deep FREEZES the old state and merges anyway. If any
// path writes through a shared reference, the merge throws instead of quietly
// corrupting something a week from now.
//
// Run with: npx tsx src/lib/syncSharing.test.ts

import assert from 'node:assert/strict';
import {
  emptyState, mergeOps, makeOps, readEntity, setMembers,
  type SyncOp, type SyncState,
} from './sync';
import {
  applyLocalChange, applyLocalChanges, emptyClientData, readClientStore,
} from './syncClient';

let seq = 0;
function op(partial: Partial<SyncOp> & { entityId: string; field: string }): SyncOp {
  seq += 1;
  return {
    opId: `dev:${seq}`,
    store: 'tasks',
    value: 'v',
    device: 'dev',
    lamport: seq,
    at: 1_700_000_000_000 + seq,
    ...partial,
  } as SyncOp;
}

/** A state with a few entities across two stores, built the ordinary way. */
function populated(): SyncState {
  let state = emptyState();
  state = mergeOps(state, [
    op({ entityId: 'a', field: 'title', value: 'Task A' }),
    op({ entityId: 'a', field: 'notes', value: 'first' }),
    op({ entityId: 'b', field: 'title', value: 'Task B' }),
    op({ entityId: 'c', field: 'title', value: 'Task C' }),
    op({ store: 'events', entityId: 'e1', field: 'title', value: 'Event' }),
    op({ store: 'events', entityId: 'e2', field: 'title', value: 'Other' }),
    op({ entityId: 'a', field: 'completedDates', value: '2026-09-01', present: true }),
  ]).state;
  return state;
}

function deepFreeze<T>(value: T, seen = new Set<unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

const snapshot = (s: SyncState) => JSON.stringify(s);

async function main() {
  console.log('--- 1. A FROZEN STATE CAN STILL BE MERGED INTO ---');
  {
    // The whole invariant in one line: if any write went through a reference
    // shared with the old state, this throws.
    const before = populated();
    deepFreeze(before);
    const result = mergeOps(before, [
      op({ entityId: 'a', field: 'title', value: 'Renamed', lamport: 500 }),
    ]);
    assert.equal(readEntity(result.state, 'tasks', 'a')?.title, 'Renamed');
    assert.equal(readEntity(before, 'tasks', 'a')?.title, 'Task A', 'the old state still says the old thing');
    console.log('  ok');
  }

  console.log('--- 2. FROZEN, THROUGH EVERY KIND OF OP ---');
  {
    const before = deepFreeze(populated());
    // A new field, an existing field, a set addition, a set removal, a brand new
    // entity, a brand new store, and a tombstone.
    const result = mergeOps(before, [
      op({ entityId: 'a', field: 'notes', value: 'second', lamport: 600 }),
      op({ entityId: 'a', field: 'colour', value: 'red', lamport: 601 }),
      op({ entityId: 'a', field: 'completedDates', value: '2026-09-02', present: true, lamport: 602 }),
      op({ entityId: 'a', field: 'completedDates', value: '2026-09-01', present: false, lamport: 603 }),
      op({ entityId: 'brand-new', field: 'title', value: 'New', lamport: 604 }),
      op({ store: 'focusSessions', entityId: 'f1', field: 'seconds', value: 60, lamport: 605 }),
      op({ store: 'events', entityId: 'e1', field: '__deleted', value: true, lamport: 606 }),
    ]);
    const a = readEntity(result.state, 'tasks', 'a');
    assert.equal(a?.notes, 'second');
    assert.equal(a?.colour, 'red');
    assert.deepEqual(a?.completedDates, ['2026-09-02']);
    assert.equal(readEntity(result.state, 'tasks', 'brand-new')?.title, 'New');
    assert.equal(readEntity(result.state, 'focusSessions', 'f1')?.seconds, 60);
    assert.equal(readEntity(result.state, 'events', 'e1'), null, 'tombstoned');
    console.log('  ok');
  }

  console.log('--- 3. THE OLD STATE IS BYTE FOR BYTE WHAT IT WAS ---');
  {
    const before = populated();
    const was = snapshot(before);
    for (let i = 0; i < 5; i += 1) {
      mergeOps(before, [
        op({ entityId: 'a', field: 'title', value: `v${i}`, lamport: 700 + i }),
        op({ entityId: 'a', field: 'completedDates', value: `2026-10-0${i + 1}`, present: true, lamport: 800 + i }),
      ]);
    }
    assert.equal(snapshot(before), was, 'five merges later, unchanged');
    console.log('  ok');
  }

  console.log('--- 4. ONLY WHAT WAS TOUCHED IS A NEW OBJECT ---');
  {
    // This is the performance contract, and it is worth asserting: a regression
    // here is invisible until the phone gets slow again.
    const before = populated();
    const after = mergeOps(before, [
      op({ entityId: 'a', field: 'title', value: 'Renamed', lamport: 900 }),
    ]).state;

    assert.notEqual(after.entities, before.entities, 'the top level is new');
    assert.notEqual(after.entities.tasks, before.entities.tasks, 'the touched store is copied');
    assert.notEqual(after.entities.tasks.a, before.entities.tasks.a, 'the touched entity is copied');

    assert.equal(after.entities.events, before.entities.events, 'an untouched store is SHARED');
    assert.equal(after.entities.tasks.b, before.entities.tasks.b, 'an untouched entity is SHARED');
    assert.equal(after.entities.tasks.c, before.entities.tasks.c);
    console.log('  ok');
  }

  console.log('--- 5. A TOUCHED ENTITY IS COPIED ONCE, NOT PER OP ---');
  {
    const before = populated();
    const after = mergeOps(before, [
      op({ entityId: 'a', field: 'one', value: 1, lamport: 1000 }),
      op({ entityId: 'a', field: 'two', value: 2, lamport: 1001 }),
      op({ entityId: 'a', field: 'three', value: 3, lamport: 1002 }),
    ]).state;
    const ent = readEntity(after, 'tasks', 'a');
    assert.equal(ent?.one, 1);
    assert.equal(ent?.two, 2);
    assert.equal(ent?.three, 3, 'all three landed on the same copy');
    console.log('  ok');
  }

  console.log('--- 6. THE SEEN ARRAYS ARE NOT SHARED ---');
  {
    // `seen` is the one thing that is PUSHED to rather than replaced, so a
    // shallow copy of the entity would not be enough. If it were shared, the old
    // state would gain ancestry for an op it never saw and would then start
    // ignoring real edits as stale.
    const before = populated();
    const beforeSeen = before.entities.tasks.a.seen.title;
    const beforeLength = beforeSeen.length;
    const after = mergeOps(before, [
      op({ entityId: 'a', field: 'title', value: 'Renamed', lamport: 1100 }),
    ]).state;
    assert.notEqual(after.entities.tasks.a.seen.title, beforeSeen, 'a different array');
    assert.equal(beforeSeen.length, beforeLength, 'the old one did not grow');
    assert.equal(after.entities.tasks.a.seen.title.length, beforeLength + 1);
    console.log('  ok');
  }

  console.log('--- 7. THE SET MEMBER MAPS ARE NOT SHARED ---');
  {
    const before = populated();
    const beforeSet = before.entities.tasks.a.sets.completedDates;
    const beforeKeys = Object.keys(beforeSet).length;
    const after = mergeOps(before, [
      op({ entityId: 'a', field: 'completedDates', value: '2026-12-25', present: true, lamport: 1200 }),
    ]).state;
    assert.notEqual(after.entities.tasks.a.sets.completedDates, beforeSet);
    assert.equal(Object.keys(beforeSet).length, beforeKeys, 'the old membership is unchanged');
    assert.deepEqual(
      Object.keys(setMembers(before.entities.tasks.a, 'completedDates')).sort(),
      ['2026-09-01'],
    );
    console.log('  ok');
  }

  console.log('--- 8. TWO MERGES FROM ONE BASE DO NOT SEE EACH OTHER ---');
  {
    // The base is shared by both results, which is exactly the situation the old
    // deep clone made impossible.
    const base = populated();
    const left = mergeOps(base, [op({ entityId: 'a', field: 'title', value: 'Left', lamport: 1300 })]).state;
    const right = mergeOps(base, [op({ entityId: 'a', field: 'title', value: 'Right', lamport: 1301 })]).state;
    assert.equal(readEntity(left, 'tasks', 'a')?.title, 'Left');
    assert.equal(readEntity(right, 'tasks', 'a')?.title, 'Right');
    assert.equal(readEntity(base, 'tasks', 'a')?.title, 'Task A');
    console.log('  ok');
  }

  console.log('--- 9. IDEMPOTENCE SURVIVES THE SHARING ---');
  {
    const base = populated();
    const ops = [
      op({ entityId: 'a', field: 'title', value: 'Once', lamport: 1400 }),
      op({ entityId: 'a', field: 'completedDates', value: '2026-11-11', present: true, lamport: 1401 }),
    ];
    const once = mergeOps(base, ops).state;
    const twice = mergeOps(once, ops).state;
    assert.equal(snapshot(once), snapshot(twice), 'replaying changes nothing');
    const shuffled = mergeOps(base, [...ops].reverse()).state;
    assert.equal(snapshot(shuffled), snapshot(once), 'and order does not matter');
    console.log('  ok');
  }

  console.log('--- 10. IDS THAT ARE NOT ORDINARY GO THROUGH THE COPY PATH ---');
  {
    const nasty = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ''];
    for (const id of nasty) {
      let state = emptyState();
      state = mergeOps(state, [op({ entityId: id, field: 'title', value: 'x', lamport: 1500 })]).state;
      assert.equal(readEntity(state, 'tasks', id)?.title, 'x', `${id} stored`);
      // And again, so the second pass goes through the COPY branch rather than
      // the create branch.
      const frozen = deepFreeze(state);
      const after = mergeOps(frozen, [op({ entityId: id, field: 'title', value: 'y', lamport: 1501 })]).state;
      assert.equal(readEntity(after, 'tasks', id)?.title, 'y', `${id} updated`);
      assert.equal(readEntity(frozen, 'tasks', id)?.title, 'x', `${id} old state intact`);
      assert.equal(({} as Record<string, unknown>).polluted, undefined, 'nothing leaked to the prototype');
    }
    // A field name that is a prototype key, on the copy path.
    let s2 = mergeOps(emptyState(), [op({ entityId: 'p', field: '__proto__', value: 1, lamport: 1600 })]).state;
    s2 = mergeOps(deepFreeze(s2), [op({ entityId: 'p', field: '__proto__', value: 2, lamport: 1601 })]).state;
    assert.equal(readEntity(s2, 'tasks', 'p')?.__proto__, 2);
    console.log('  ok');
  }

  console.log('--- 11. A MERGE THAT APPLIES NOTHING ---');
  {
    const before = deepFreeze(populated());
    const result = mergeOps(before, []);
    assert.equal(snapshot(result.state), snapshot(before), 'the same state');
    assert.deepEqual(result.appliedOps, []);
    // And a batch of pure duplicates.
    const dup = op({ entityId: 'a', field: 'title', value: 'Task A' });
    const first = mergeOps(before, [dup]).state;
    const again = mergeOps(deepFreeze(first), [dup]);
    assert.deepEqual(again.appliedOps, [], 'the second pass applies nothing');
    console.log('  ok');
  }

  console.log('--- 12. WRITING OPS DOES NOT CHANGE THE STATE THEY WERE READ FROM ---');
  {
    // `makeOps` advances the lamport counter and NOTHING else. It used to
    // quietly insert an empty entity for any id it was asked about, which is why
    // its callers were deep cloning the whole planner before calling it.
    const state = populated();
    const entitiesBefore = snapshot({ ...state, lamport: 0 });
    const lamportBefore = state.lamport;

    const ops = makeOps(state, {
      store: 'tasks', entityId: 'never-seen-before', device: 'dev', at: 1,
      changes: { title: 'Hello', completedDates: ['2026-01-01'] },
    });

    assert.ok(ops.length >= 2, 'it wrote ops');
    assert.equal(snapshot({ ...state, lamport: 0 }), entitiesBefore, 'entities untouched');
    assert.ok(state.lamport > lamportBefore, 'only the clock moved');
    assert.equal(
      Object.hasOwn(state.entities.tasks ?? {}, 'never-seen-before'), false,
      'and no empty entity was left behind',
    );
    console.log('  ok');
  }

  console.log('--- 13. A LOCAL EDIT LEAVES THE OLD CLIENT DATA ALONE ---');
  {
    let data = emptyClientData('phone');
    data = applyLocalChange(data, {
      store: 'tasks', entityId: 't1', changes: { title: 'Buy milk' }, at: 1,
    });
    const was = snapshot(data.state);
    const outboxWas = data.outbox.length;

    const next = applyLocalChange(data, {
      store: 'tasks', entityId: 't1', changes: { completed: true }, at: 2,
    });

    assert.equal(snapshot(data.state), was, 'the state it was given is untouched');
    assert.equal(data.outbox.length, outboxWas, 'and so is its outbox');
    assert.equal(readClientStore(next, 'tasks').t1?.completed, true);
    assert.equal(readClientStore(data, 'tasks').t1?.completed, undefined);
    assert.ok(next.outbox.length > outboxWas, 'the new one carries the op');
    console.log('  ok');
  }

  console.log('--- 14. A HUNDRED EDITS IN A ROW STAY CORRECT ---');
  {
    // The shape a real burst takes: the same few entities, over and over, each
    // merge built on the result of the last and sharing most of it.
    let data = emptyClientData('phone');
    for (let i = 0; i < 100; i += 1) {
      data = applyLocalChange(data, {
        store: 'tasks',
        entityId: `t${i % 7}`,
        changes: { title: `title ${i}`, order: i },
        at: 1000 + i,
      });
    }
    const tasks = readClientStore(data, 'tasks');
    assert.equal(Object.keys(tasks).length, 7);
    for (let k = 0; k < 7; k += 1) {
      // The last i under 100 with i % 7 === k.
      const last = k + 7 * Math.floor((99 - k) / 7);
      assert.equal(tasks[`t${k}`]?.title, `title ${last}`, `t${k} holds its last write`);
      assert.equal(tasks[`t${k}`]?.order, last);
    }
    console.log('  ok');
  }

  console.log('--- 15. THE OLD STATE IS STILL READABLE AFTERWARDS ---');
  {
    // Sharing means the previous state's objects live on inside the new one. It
    // must still answer every question correctly, because the app does hold one
    // for a moment (`persistEdit` takes both) and the tests hold many.
    const before = populated();
    const after = mergeOps(before, [
      op({ entityId: 'a', field: 'title', value: 'Changed', lamport: 1700 }),
      op({ entityId: 'b', field: '__deleted', value: true, lamport: 1701 }),
      op({ entityId: 'a', field: 'completedDates', value: '2026-09-01', present: false, lamport: 1702 }),
    ]).state;

    assert.equal(readEntity(before, 'tasks', 'a')?.title, 'Task A');
    assert.equal(readEntity(before, 'tasks', 'b')?.title, 'Task B', 'still not deleted');
    assert.deepEqual(readEntity(before, 'tasks', 'a')?.completedDates, ['2026-09-01']);

    assert.equal(readEntity(after, 'tasks', 'a')?.title, 'Changed');
    assert.equal(readEntity(after, 'tasks', 'b'), null);
    assert.deepEqual(readEntity(after, 'tasks', 'a')?.completedDates, []);
    console.log('  ok');
  }

  console.log('--- 16. A BATCH IS THE SAME AS THE EDITS ONE AT A TIME ---');
  {
    // This is the whole claim `applyLocalChanges` makes. A reorder renumbers a
    // group; sent together or sent one at a time, the planner must end up in
    // exactly the same place.
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const seed = (data: ReturnType<typeof emptyClientData>) => {
      let d = data;
      rows.forEach((id, i) => {
        d = applyLocalChange(d, { store: 'tasks', entityId: id, changes: { title: id, order: i * 10 }, at: 1 });
      });
      return d;
    };

    const oneAtATime = (() => {
      let d = seed(emptyClientData('phone'));
      rows.forEach((id, i) => {
        d = applyLocalChange(d, { store: 'tasks', entityId: id, changes: { order: (rows.length - i) * 10 }, at: 2 });
      });
      return d;
    })();

    const batched = applyLocalChanges(
      seed(emptyClientData('phone')),
      rows.map((id, i) => ({ store: 'tasks' as const, entityId: id, changes: { order: (rows.length - i) * 10 } })),
      2,
    );

    const orders = (d: typeof batched) =>
      rows.map(id => readClientStore(d, 'tasks')[id]?.order);
    assert.deepEqual(orders(batched), orders(oneAtATime), 'the same orders');
    assert.deepEqual(orders(batched), [50, 40, 30, 20, 10]);
    assert.equal(batched.outbox.length, oneAtATime.outbox.length, 'the same number of ops');
    console.log('  ok');
  }

  console.log('--- 17. EVERY OP IN A BATCH GETS ITS OWN STAMP ---');
  {
    // Two ops sharing a lamport from the same device is two ops with the same
    // identity: the second is dropped as a duplicate and one row never moves.
    let data = emptyClientData('phone');
    data = applyLocalChanges(data, [
      { store: 'tasks', entityId: 'a', changes: { order: 0, title: 'A' } },
      { store: 'tasks', entityId: 'b', changes: { order: 10, title: 'B' } },
      { store: 'tasks', entityId: 'c', changes: { order: 20, title: 'C' } },
    ], 5);

    const ids = data.outbox.map(o => o.opId);
    assert.equal(new Set(ids).size, ids.length, 'no two ops share an id');
    const stamps = data.outbox.map(o => o.lamport);
    assert.equal(new Set(stamps).size, stamps.length, 'no two share a lamport');
    assert.equal(data.state.lamport, Math.max(...stamps), 'the clock ends at the highest');

    const tasks = readClientStore(data, 'tasks');
    assert.deepEqual([tasks.a?.order, tasks.b?.order, tasks.c?.order], [0, 10, 20]);
    assert.deepEqual([tasks.a?.title, tasks.b?.title, tasks.c?.title], ['A', 'B', 'C']);
    console.log('  ok');
  }

  console.log('--- 18. ONE ENTITY TWICE IN A BATCH IS REFUSED ---');
  {
    // Not merged silently: the second set of ops would claim a base stamp the
    // first set has already replaced, which reads downstream as a conflict the
    // user never caused. The caller folds its own duplicates.
    const data = emptyClientData('phone');
    assert.throws(
      () => applyLocalChanges(data, [
        { store: 'tasks', entityId: 'a', changes: { order: 1 } },
        { store: 'tasks', entityId: 'a', changes: { order: 2 } },
      ], 1),
      /appears twice/,
    );
    // The same id in a DIFFERENT store is a different entity and is fine.
    const ok = applyLocalChanges(data, [
      { store: 'tasks', entityId: 'x', changes: { title: 'task' } },
      { store: 'events', entityId: 'x', changes: { title: 'event' } },
    ], 1);
    assert.equal(readClientStore(ok, 'tasks').x?.title, 'task');
    assert.equal(readClientStore(ok, 'events').x?.title, 'event');
    console.log('  ok');
  }

  console.log('--- 19. A BATCH THAT CHANGES NOTHING ---');
  {
    let data = emptyClientData('phone');
    assert.equal(applyLocalChanges(data, [], 1), data, 'an empty batch is the same object');
    data = applyLocalChange(data, { store: 'tasks', entityId: 'a', changes: { order: 7 }, at: 1 });

    // A REGISTER FIELD IS NOT DIFFED. Writing the value it already holds is
    // still a write, exactly as it is through `applyLocalChange`, because "set
    // this to what it already is" is a real statement about ordering that the
    // other machine may need. Callers that do not mean it -- the reorder, which
    // renumbers a whole group -- skip the rows that did not move themselves.
    const same = applyLocalChanges(data, [{ store: 'tasks', entityId: 'a', changes: { order: 7 } }], 2);
    assert.equal(same.outbox.length, data.outbox.length + 1, 'it queues the write');
    assert.equal(readClientStore(same, 'tasks').a?.order, 7);

    // A SET field, which IS diffed, is the other case: nothing to say, nothing
    // queued, and the same object comes back.
    let withDates = applyLocalChange(data, {
      store: 'tasks', entityId: 'a', changes: { completedDates: ['2026-09-01'] }, at: 3,
    });
    const unchanged = applyLocalChanges(withDates, [
      { store: 'tasks', entityId: 'a', changes: { completedDates: ['2026-09-01'] } },
    ], 4);
    assert.equal(unchanged, withDates, 'nothing to write, the same object back');
    console.log('  ok');
  }

  console.log('--- 20. A BATCH DOES NOT TOUCH THE DATA IT WAS GIVEN ---');
  {
    let data = emptyClientData('phone');
    data = applyLocalChange(data, { store: 'tasks', entityId: 'a', changes: { order: 1 }, at: 1 });
    const was = snapshot(data.state);
    const outboxWas = data.outbox.length;
    const lamportWas = data.state.lamport;

    applyLocalChanges(data, [
      { store: 'tasks', entityId: 'a', changes: { order: 99 } },
      { store: 'tasks', entityId: 'b', changes: { order: 100 } },
    ], 2);

    assert.equal(snapshot(data.state), was, 'state untouched');
    assert.equal(data.outbox.length, outboxWas, 'outbox untouched');
    assert.equal(data.state.lamport, lamportWas, 'even the clock');
    console.log('  ok');
  }

  console.log('--- 21. A REORDER ARRIVES SOMEWHERE ELSE WITHOUT A CONFLICT ---');
  {
    // The point of getting the base stamps right: the other machine applies the
    // whole reorder cleanly and nobody is asked to answer a card about it.
    let phone = emptyClientData('phone');
    const rows = ['r1', 'r2', 'r3', 'r4'];
    rows.forEach((id, i) => {
      phone = applyLocalChange(phone, { store: 'tasks', entityId: id, changes: { title: id, order: i * 10 }, at: 1 });
    });

    // The PC starts from everything the phone has so far.
    let pc = mergeOps(emptyState(), phone.outbox);
    assert.deepEqual(pc.conflicts, []);

    const moved = applyLocalChanges(phone, [
      { store: 'tasks', entityId: 'r3', changes: { order: 0 } },
      { store: 'tasks', entityId: 'r1', changes: { order: 10 } },
      { store: 'tasks', entityId: 'r2', changes: { order: 20 } },
      { store: 'tasks', entityId: 'r4', changes: { order: 30 } },
    ], 2);

    const fresh = moved.outbox.slice(phone.outbox.length);
    pc = mergeOps(pc.state, fresh);
    assert.deepEqual(pc.conflicts, [], 'no conflict cards for a drag');
    assert.deepEqual(
      rows.map(id => readEntity(pc.state, 'tasks', id)?.order),
      [10, 20, 0, 30],
      'and the PC agrees about the new order',
    );
    console.log('  ok');
  }

  console.log('\nAll syncSharing tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
