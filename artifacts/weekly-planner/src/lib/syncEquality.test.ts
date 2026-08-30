// ─── Agreement is not a conflict ─────────────────────────────────────────────
// Covers the rules that decide whether two writes actually DISAGREE, and the
// set-field handling that stops two devices ticking different days from
// overwriting each other.
//
// The bug this suite exists for: ticking the same item off on the phone and on
// the PC within a minute produced a conflict card whose two sides showed the
// SAME value. There is nothing to choose between them, so answering it is
// meaningless — and a sidebar full of meaningless questions is a sidebar nobody
// reads.
//
// Run with: npx tsx src/lib/syncEquality.test.ts

import assert from 'node:assert';

import {
  DELETED_FIELD,
  emptyState,
  isDeleted,
  isMeaninglessConflict,
  makeOps,
  mergeOps,
  readEntity,
  readStore,
  setMembers,
  valuesEqual,
  type SyncConflict,
  type SyncOp,
  type SyncState,
} from './sync';
import { addConflicts, clearResolvedConflicts } from '../../sync-server';
import { mergeConflicts, reconcileConflicts } from './syncClient';
import { snapshotToOps } from './syncBridge';

const PC = 'pc-desktop';
const PHONE = 'phone-1';

/** Ops one peer produces without seeing the other. */
function localOps(
  base: SyncState,
  device: string,
  entityId: string,
  changes: Record<string, unknown>,
  at: number,
  store: any = 'events',
): SyncOp[] {
  const working = structuredClone(base);
  return makeOps(working, { store, entityId, device, at, changes });
}

function card(winner: unknown, loser: unknown): SyncConflict {
  return {
    id: 'c', kind: 'field', store: 'events', entityId: 'ev1', field: 'title',
    winner: { value: winner, device: PC, at: 1, lamport: 2 },
    loser: { value: loser, device: PHONE, at: 1, lamport: 1 },
    detectedAt: 1,
  };
}

function main() {
  console.log('--- 1. valuesEqual: SCALARS ---');
  {
    assert.equal(valuesEqual('a', 'a'), true);
    assert.equal(valuesEqual('a', 'b'), false);
    assert.equal(valuesEqual(1, 1), true);
    assert.equal(valuesEqual(1, '1'), false, 'A number is not its own string');
    assert.equal(valuesEqual(0, -0), true);
    assert.equal(valuesEqual(true, true), true);
    assert.equal(valuesEqual(true, 1), false);
    assert.equal(valuesEqual(false, 0), false);
    assert.equal(valuesEqual(NaN, NaN), true, 'Two devices writing NaN agree');
    assert.equal(valuesEqual(Infinity, Infinity), true);
    assert.equal(valuesEqual(undefined, undefined), true);
    assert.equal(valuesEqual(null, null), true);
    // These two must stay different: an absent notify spec INHERITS, an explicit
    // null does not. Collapsing them would silently change what reminders fire.
    assert.equal(valuesEqual(null, undefined), false, 'null is not undefined');
    assert.equal(valuesEqual(undefined, null), false);
    assert.equal(valuesEqual(null, ''), false);
    assert.equal(valuesEqual(undefined, ''), false);
    assert.equal(valuesEqual('', ''), true);
  }

  console.log('--- 2. valuesEqual: ARRAYS AND OBJECTS ---');
  {
    assert.equal(valuesEqual(['2026-01-01'], ['2026-01-01']), true,
      'Two devices ticking the same day produce equal arrays, not the same array');
    assert.equal(valuesEqual([], []), true);
    assert.equal(valuesEqual([], {}), false, 'An empty array is not an empty object');
    assert.equal(valuesEqual(['a', 'b'], ['b', 'a']), false,
      'Array ORDER is meaningful for a register field; only set fields ignore it');
    assert.equal(valuesEqual(['a'], ['a', 'b']), false);
    assert.equal(valuesEqual({ enabled: true, offsets: [10] }, { offsets: [10], enabled: true }), true,
      'Key order is not a difference');
    assert.equal(valuesEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } }), true);
    assert.equal(valuesEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }), false);
    assert.equal(valuesEqual({ a: 1 }, { a: 1, b: undefined }), false,
      'A present key holding undefined is still a key');
    assert.equal(valuesEqual({ a: undefined }, { a: undefined }), true);
    assert.equal(valuesEqual([[1, [2]]], [[1, [2]]]), true);
    assert.equal(valuesEqual([null], [undefined]), false);

    // Unicode, emoji and RTL text must compare as ordinary strings.
    assert.equal(valuesEqual('مراجعة الفيزياء', 'مراجعة الفيزياء'), true);
    assert.equal(valuesEqual('🎯 focus', '🎯 focus'), true);
    assert.equal(valuesEqual('🎯 focus', '🎯 focus '), false);

    // A very large value must not blow up or be reported equal by truncation.
    const big = 'x'.repeat(200_000);
    assert.equal(valuesEqual(big, big), true);
    assert.equal(valuesEqual(big, big + 'y'), false);
    const wide = Array.from({ length: 5_000 }, (_, i) => i);
    assert.equal(valuesEqual(wide, [...wide]), true);
    assert.equal(valuesEqual(wide, [...wide.slice(0, -1), -1]), false);
  }

  console.log('--- 3. THE REPORTED BUG: TICKING THE SAME DAY ON BOTH DEVICES ---');
  {
    // A one-off event, already synced to both peers.
    let server = emptyState();
    server = mergeOps(server, snapshotToOps(structuredClone(server), {
      store: 'events',
      snapshot: { ev1: { content: 'Physics', day: '2026-03-02' } },
      device: PC, at: 1_000,
    })).state;

    const day = '2026-03-02';
    const fromPhone = localOps(server, PHONE, 'ev1', { completedDates: [day] }, 2_000);
    const fromPc = localOps(server, PC, 'ev1', { completedDates: [day] }, 2_010);

    const merged = mergeOps(server, [...fromPhone, ...fromPc]);
    assert.equal(merged.conflicts.length, 0,
      'Both devices ticked the same day. That is agreement, not a disagreement.');
    assert.deepEqual(readEntity(merged.state, 'events', 'ev1')!.completedDates, [day],
      'and the day is ticked exactly once');

    // Order must not change the answer.
    const other = mergeOps(server, [...fromPc, ...fromPhone]);
    assert.equal(other.conflicts.length, 0);
    assert.deepEqual(readStore(other.state, 'events'), readStore(merged.state, 'events'));
  }

  console.log('--- 4. TICKING DIFFERENT DAYS MERGES INSTEAD OF ONE WINNING ---');
  {
    let server = emptyState();
    server = mergeOps(server, snapshotToOps(structuredClone(server), {
      store: 'events',
      snapshot: { ev1: { content: 'Gym', recur: { freq: 'weekly' } } },
      device: PC, at: 1_000,
    })).state;

    const phone = localOps(server, PHONE, 'ev1', { completedDates: ['2026-03-02'] }, 2_000);
    const pc = localOps(server, PC, 'ev1', { completedDates: ['2026-03-09'] }, 2_010);
    const merged = mergeOps(server, [...phone, ...pc]);

    assert.equal(merged.conflicts.length, 0, 'Two additions are not a conflict');
    assert.deepEqual(readEntity(merged.state, 'events', 'ev1')!.completedDates,
      ['2026-03-02', '2026-03-09'],
      'BOTH ticks survive. As a register field one of them was silently dropped, '
      + 'which is exactly "I ticked it and it did not arrive".');
  }

  console.log('--- 5. UN-TICKING STILL WORKS, AND WINS OVER AN OLDER TICK ---');
  {
    let s = emptyState();
    s = mergeOps(s, snapshotToOps(structuredClone(s), {
      store: 'events', snapshot: { ev1: { content: 'a', completedDates: ['d1', 'd2'] } },
      device: PC, at: 1_000,
    })).state;
    assert.deepEqual(readEntity(s, 'events', 'ev1')!.completedDates, ['d1', 'd2']);

    const untick = localOps(s, PHONE, 'ev1', { completedDates: ['d2'] }, 2_000);
    s = mergeOps(s, untick).state;
    assert.deepEqual(readEntity(s, 'events', 'ev1')!.completedDates, ['d2'],
      'Removing a day works even though the data started life as a plain array');

    // A stale re-add of the same day loses to the newer removal.
    const stale: SyncOp = {
      opId: 'old:1', store: 'events', entityId: 'ev1', field: 'completedDates',
      value: 'd1', present: true, device: 'old', lamport: 1, at: 0,
    };
    s = mergeOps(s, [stale]).state;
    assert.deepEqual(readEntity(s, 'events', 'ev1')!.completedDates, ['d2'],
      'A late-arriving older addition does not undo a newer removal');
  }

  console.log('--- 6. LEGACY STATE: A SET FIELD THAT USED TO BE A REGISTER ---');
  {
    // Hand-built state exactly as an older build would have written it: the
    // whole array sitting in `fields`, nothing in `sets`.
    const legacy: SyncState = {
      entities: {
        events: {
          ev1: {
            fields: {
              content: { value: 'Physics', lamport: 1, device: PC, at: 0 },
              completedDates: { value: ['d1', 'd2'], lamport: 2, device: PC, at: 0 },
            },
            sets: {},
            seen: { content: ['1:' + PC], completedDates: ['2:' + PC] },
          },
        },
      },
      lamport: 2,
      applied: {},
    };

    assert.deepEqual(readEntity(legacy, 'events', 'ev1')!.completedDates, ['d1', 'd2'],
      'Ticks made before the change are still visible');
    assert.deepEqual(Object.keys(setMembers(legacy.entities.events.ev1, 'completedDates')).sort(),
      ['d1', 'd2']);

    const add = localOps(legacy, PHONE, 'ev1', { completedDates: ['d1', 'd2', 'd3'] }, 3_000);
    const withAdd = mergeOps(legacy, add).state;
    assert.deepEqual(readEntity(withAdd, 'events', 'ev1')!.completedDates, ['d1', 'd2', 'd3']);

    const remove = localOps(legacy, PHONE, 'ev1', { completedDates: ['d2'] }, 3_000);
    const withRemove = mergeOps(legacy, remove).state;
    assert.deepEqual(readEntity(withRemove, 'events', 'ev1')!.completedDates, ['d2'],
      'A day removed after the model changed does NOT come back from the old array');
  }

  console.log('--- 7. EQUAL CONCURRENT WRITES ON EVERY FIELD SHAPE ---');
  {
    const shapes: Array<[string, unknown]> = [
      ['string', 'Physics revision'],
      ['empty string', ''],
      ['number', 45],
      ['zero', 0],
      ['true', true],
      ['false', false],
      ['null', null],
      ['array', ['a', 'b', 'c']],
      ['empty array', []],
      ['object', { enabled: true, offsets: [10, 30] }],
      ['nested object', { a: { b: [1, { c: 'x' }] } }],
      ['emoji', '🎯 مراجعة'],
      ['long', 'y'.repeat(50_000)],
    ];

    for (const [label, value] of shapes) {
      let base = emptyState();
      base = mergeOps(base, localOps(base, PC, 'ev1', { seedField: 'seed' }, 100)).state;

      const a = localOps(base, PHONE, 'ev1', { note: value }, 200);
      const b = localOps(base, PC, 'ev1', { note: value }, 201);
      const merged = mergeOps(base, [...a, ...b]);
      assert.equal(merged.conflicts.length, 0, `${label}: equal values must not conflict`);
      assert.equal(
        valuesEqual(readEntity(merged.state, 'events', 'ev1')!.note, value), true,
        `${label}: and the agreed value is what is live`,
      );
    }

    // ...while a genuine disagreement STILL raises a card.
    let base = emptyState();
    base = mergeOps(base, localOps(base, PC, 'ev1', { note: 'seed' }, 100)).state;
    const a = localOps(base, PHONE, 'ev1', { note: 'phone version' }, 200);
    const b = localOps(base, PC, 'ev1', { note: 'pc version' }, 201);
    const merged = mergeOps(base, [...a, ...b]);
    assert.equal(merged.conflicts.length, 1, 'A real disagreement is still reported');
    assert.equal(isMeaninglessConflict(merged.conflicts[0]), false);
  }

  console.log('--- 8. undefined VS MISSING VS null, CONCURRENTLY ---');
  {
    let base = emptyState();
    base = mergeOps(base, localOps(base, PC, 'ev1', { notify: { enabled: true } }, 100)).state;

    // Both peers clear the field. Same intent, same value: no card.
    const clearA = localOps(base, PHONE, 'ev1', { notify: undefined }, 200);
    const clearB = localOps(base, PC, 'ev1', { notify: undefined }, 201);
    assert.equal(mergeOps(base, [...clearA, ...clearB]).conflicts.length, 0,
      'Two peers clearing the same field agree');

    // One clears, the other writes an explicit null. Those MEAN different things.
    const nulled = localOps(base, PC, 'ev1', { notify: null }, 201);
    const both = mergeOps(base, [...clearA, ...nulled]);
    assert.equal(both.conflicts.length, 1,
      'Cleared and explicitly-null are different answers and must be asked about');
  }

  console.log('--- 9. A NO-OP SAVE DOES NOT OUT-RANK A DELETE ---');
  {
    // The PC autosaves the whole map, so a field is rewritten with the value it
    // already held every time anything else on the page changes.
    let base = emptyState();
    base = mergeOps(base, localOps(base, PC, 'ev1', { content: 'Gym' }, 100)).state;

    const del = localOps(base, PHONE, 'ev1', { [DELETED_FIELD]: true }, 200);
    const withDelete = mergeOps(base, del).state;
    assert.equal(isDeleted(withDelete.entities.events.ev1), true, 'Deleted on the phone');

    // Now the PC saves again, writing the same title back with a later stamp.
    const echo = localOps(withDelete, PC, 'ev1', { content: 'Gym' }, 300);
    const after = mergeOps(withDelete, echo);
    assert.equal(isDeleted(after.state.entities.events.ev1), true,
      'An echo of an unchanged value must not resurrect a deleted item');
    assert.equal(after.conflicts.length, 0, 'and it raises no card either');
    assert.equal(readEntity(after.state, 'events', 'ev1'), null);

    // A REAL edit racing the delete still contests it, as designed.
    const realEdit = localOps(withDelete, PC, 'ev1', { content: 'Gym (moved)' }, 300);
    const contested = mergeOps(withDelete, realEdit);
    assert.equal(isDeleted(contested.state.entities.events.ev1), false,
      'A genuine concurrent edit keeps the item alive until the user answers');
    assert.equal(contested.conflicts.filter(c => c.kind === 'delete').length, 1);
  }

  console.log('--- 10. DOWNSTREAM: NO LAYER CAN RE-INTRODUCE AN AGREEMENT ---');
  {
    const agreed = card(['d1'], ['d1']);
    const real = { ...card('a', 'b'), id: 'real' };

    assert.equal(isMeaninglessConflict(agreed), true);
    assert.equal(isMeaninglessConflict(real), false);

    // Server side.
    assert.deepEqual(addConflicts([], [agreed]), [], 'The server never opens one');
    assert.deepEqual(addConflicts([], [agreed, real]).map(c => c.id), ['real']);
    assert.deepEqual(clearResolvedConflicts([agreed, real], []).map(c => c.id), ['real'],
      'and an old one already on disk is dropped on the next pass');

    // Client side.
    assert.deepEqual(mergeConflicts([], [agreed]), [], 'The phone never shows one');
    assert.deepEqual(mergeConflicts([agreed], [real]).map(c => c.id), ['real']);
    assert.deepEqual(reconcileConflicts([agreed], [agreed]), [],
      'and one already on the phone disappears rather than being kept alive');
    assert.deepEqual(reconcileConflicts([real], [real]).map(c => c.id), ['real']);

    // reconcileConflicts must not duplicate a card present on both sides.
    assert.equal(reconcileConflicts([real], [real, real]).length, 1);
  }

  console.log('--- 11. AWKWARD IDS AND FIELD NAMES ---');
  {
    const ids = ['__proto__', 'constructor', 'prototype', 'a::2026-01-01', 'a:b:c', '', ' ', '🎯'];
    for (const id of ids.filter(x => x.length > 0)) {
      let s = emptyState();
      const a = localOps(s, PHONE, id, { completedDates: ['d1'] }, 100);
      const b = localOps(s, PC, id, { completedDates: ['d1'] }, 101);
      const merged = mergeOps(s, [...a, ...b]);
      assert.equal(merged.conflicts.length, 0, `id ${JSON.stringify(id)}: agreement`);
      assert.deepEqual(readEntity(merged.state, 'events', id)!.completedDates, ['d1']);
    }
    assert.equal(({} as any).polluted, undefined, 'Nothing leaked onto Object.prototype');

    // A field literally named __proto__ must behave like any other field.
    let s = emptyState();
    const ops = localOps(s, PC, 'ev1', { __proto__: 'x' } as any, 100);
    if (ops.length > 0) {
      const merged = mergeOps(s, ops);
      assert.ok(merged.state.entities.events.ev1);
    }
  }

  console.log('--- 12. RANDOMISED: AGREEING PEERS NEVER PRODUCE A CARD ---');
  {
    const values: unknown[] = [
      'a', 'b', '', 0, 1, -1, true, false, null, undefined,
      [], ['x'], ['x', 'y'], { k: 1 }, { k: [1, 2] }, '🎯', 'مرحبا',
    ];
    let rng = 987654321;
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };

    for (let round = 0; round < 500; round++) {
      let base = emptyState();
      base = mergeOps(base, localOps(base, PC, 'ev1', { seed: round }, 1)).state;

      const field = `f${rand(4)}`;
      const value = values[rand(values.length)];
      const sameOnBoth = rand(2) === 0;
      const otherValue = sameOnBoth ? value : values[rand(values.length)];

      const a = localOps(base, PHONE, 'ev1', { [field]: value }, 100 + rand(50));
      const b = localOps(base, PC, 'ev1', { [field]: otherValue }, 100 + rand(50));

      const forwards = mergeOps(base, [...a, ...b]);
      const backwards = mergeOps(base, [...b, ...a]);

      assert.deepEqual(readStore(forwards.state, 'events'), readStore(backwards.state, 'events'),
        `round ${round}: order must not change the outcome`);
      assert.deepEqual(
        forwards.conflicts.map(c => c.id).sort(),
        backwards.conflicts.map(c => c.id).sort(),
        `round ${round}: order must not change which cards appear`,
      );
      for (const c of [...forwards.conflicts, ...backwards.conflicts]) {
        assert.equal(isMeaninglessConflict(c), false,
          `round ${round}: a card was raised over two identical values`);
      }
      if (valuesEqual(value, otherValue)) {
        assert.equal(forwards.conflicts.length, 0,
          `round ${round}: equal values must never raise a card`);
      }
    }
  }

  console.log('--- 13. RANDOMISED: SET FIELDS CONVERGE FROM ANY ORDER ---');
  {
    let rng = 42;
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];

    for (let round = 0; round < 300; round++) {
      let base = emptyState();
      base = mergeOps(base, localOps(base, PC, 'ev1', { content: 'x' }, 1)).state;

      const ops: SyncOp[] = [];
      let a = structuredClone(base);
      let b = structuredClone(base);
      let aDays: string[] = [];
      let bDays: string[] = [];
      for (let i = 0; i < 4; i++) {
        aDays = days.filter(() => rand(2) === 0);
        bDays = days.filter(() => rand(2) === 0);
        const opsA = makeOps(a, { store: 'events', entityId: 'ev1', device: PHONE, at: 10 + i, changes: { completedDates: aDays } });
        const opsB = makeOps(b, { store: 'events', entityId: 'ev1', device: PC, at: 10 + i, changes: { completedDates: bDays } });
        a = mergeOps(a, opsA).state;
        b = mergeOps(b, opsB).state;
        ops.push(...opsA, ...opsB);
      }

      // Shuffle, apply twice, and compare with a differently shuffled run.
      const shuffled = [...ops].sort(() => rand(3) - 1);
      const twice = mergeOps(mergeOps(base, shuffled).state, shuffled);
      const otherOrder = mergeOps(base, [...ops].reverse());

      assert.deepEqual(readStore(twice.state, 'events'), readStore(otherOrder.state, 'events'),
        `round ${round}: set fields must converge regardless of order or replay`);
      assert.equal(twice.conflicts.length, 0, 'and set fields never raise cards');
    }
  }

  console.log('\nALL PASS (equality: agreement is not a conflict, sets merge, no-ops do not resurrect)');
}

main();
