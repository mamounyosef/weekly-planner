// Tests set-valued fields (`completedDates`, `exdates`) against the one thing
// that silently destroyed them: an operation carrying the WHOLE ARRAY.
//
// THE BUG THIS SUITE EXISTS FOR
// `completedDates` was not always a set field. A build from before that change
// writes it like any other value — one op, the entire array, no `present` flag.
// Two devices on different builds is the NORMAL state of an app updated over the
// air, so such ops arrive as a matter of course.
//
// Treating one as a single element was silent, permanent corruption:
// `elementKey` JSON-encodes anything that is not a string, so the array
// ["2026-08-29"] became the literal member '["2026-08-29"]'. Add-wins meant no
// later operation could ever remove it, and `completedDates.includes(date)` was
// false forever after. Both devices agreed on the stored bytes; neither could
// ever show a tick. From the user's chair the app was simply broken, and no
// amount of re-ticking helped.
//
// Run with: npx tsx src/lib/syncSetOps.test.ts

import assert from 'node:assert/strict';
import {
  elementKey,
  emptyState,
  isJunkSetMember,
  makeOps,
  mergeOps,
  readEntity,
  sanitizeState,
  type SyncOp,
  type SyncState,
} from './sync';

const DEV_OLD = 'android-oldbuild';
const DEV_NEW = 'android-newbuild';
const PC = 'pc-desktop';

/** The op an out-of-date client writes: whole array, no `present`. */
function wholeArrayOp(
  entityId: string,
  value: unknown[],
  lamport: number,
  device = DEV_OLD,
  field = 'completedDates',
): SyncOp {
  return {
    opId: `${device}:${lamport}`,
    store: 'events',
    entityId,
    field,
    value,
    device,
    lamport,
    at: 1_700_000_000_000,
  };
}

/** The op a current client writes: one element, with `present`. */
function elementOp(
  entityId: string,
  value: string,
  present: boolean,
  lamport: number,
  device = DEV_NEW,
  field = 'completedDates',
): SyncOp {
  return {
    opId: `${device}:${lamport}`,
    store: 'events',
    entityId,
    field,
    value,
    present,
    device,
    lamport,
    at: 1_700_000_000_000,
  };
}

const datesOf = (state: SyncState, id: string, field = 'completedDates'): string[] => {
  const rec = readEntity(state, 'events', id) as Record<string, unknown> | undefined;
  const v = rec?.[field];
  return Array.isArray(v) ? [...v].map(String).sort() : [];
};

function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. A WHOLE-ARRAY OP BECOMES REAL MEMBERS, NOT ONE JSON BLOB ---');
  {
    const s = mergeOps(emptyState(), [wholeArrayOp('ev1', ['2026-08-29'], 10)]).state;
    assert.deepEqual(datesOf(s, 'ev1'), ['2026-08-29'],
      'The date is a member; the array is not');

    // The precise corruption: a member that is the encoded array.
    const members = Object.keys((s.entities.events as any).ev1.sets.completedDates);
    assert.deepEqual(members, ['2026-08-29'],
      'and nothing that looks like JSON was ever stored');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. IT MEANS "THE SET IS NOW EXACTLY THIS" ---');
  {
    let s = mergeOps(emptyState(), [
      elementOp('ev1', '2026-08-01', true, 5),
      elementOp('ev1', '2026-08-02', true, 6),
    ]).state;
    assert.deepEqual(datesOf(s, 'ev1'), ['2026-08-01', '2026-08-02']);

    // An older client now writes the whole array with one of them dropped.
    s = mergeOps(s, [wholeArrayOp('ev1', ['2026-08-02', '2026-08-03'], 20)]).state;
    assert.deepEqual(datesOf(s, 'ev1'), ['2026-08-02', '2026-08-03'],
      'Members it omits are removed, members it adds appear');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. AN EMPTY ARRAY CLEARS, AND DOES NOT ADD "[]" ---');
  {
    let s = mergeOps(emptyState(), [elementOp('ev1', '2026-08-29', true, 5)]).state;
    s = mergeOps(s, [wholeArrayOp('ev1', [], 10)]).state;
    assert.deepEqual(datesOf(s, 'ev1'), [], 'Cleared');
    const members = Object.keys((s.entities.events as any).ev1.sets.completedDates);
    assert.ok(!members.includes('[]'), 'and no "[]" member was invented');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. THE CLOCK STILL DECIDES, IN BOTH DIRECTIONS ---');
  {
    // Newer element op beats an older whole-array op.
    let s = mergeOps(emptyState(), [
      wholeArrayOp('ev1', ['2026-08-29'], 10),
      elementOp('ev1', '2026-08-29', false, 20),
    ]).state;
    assert.deepEqual(datesOf(s, 'ev1'), [], 'A later un-tick wins over an earlier array');

    // And the other way round.
    s = mergeOps(emptyState(), [
      elementOp('ev1', '2026-08-29', false, 10),
      wholeArrayOp('ev1', ['2026-08-29'], 20),
    ]).state;
    assert.deepEqual(datesOf(s, 'ev1'), ['2026-08-29'], 'A later array wins over an earlier op');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. ORDER OF ARRIVAL NEVER CHANGES THE RESULT ---');
  {
    // Two peers handed the same ops in different orders must agree, or they
    // diverge permanently — the whole point of the merge being a CRDT.
    const ops: SyncOp[] = [
      wholeArrayOp('ev1', ['2026-08-01', '2026-08-02'], 10),
      elementOp('ev1', '2026-08-02', false, 15),
      wholeArrayOp('ev1', ['2026-08-02', '2026-08-03'], 20, PC),
      elementOp('ev1', '2026-08-01', true, 25),
      wholeArrayOp('ev1', [], 12),
    ];
    const reference = datesOf(mergeOps(emptyState(), ops).state, 'ev1');

    // Every rotation, and a reversal, and one at a time.
    for (let i = 0; i < ops.length; i++) {
      const rotated = [...ops.slice(i), ...ops.slice(0, i)];
      assert.deepEqual(datesOf(mergeOps(emptyState(), rotated).state, 'ev1'), reference,
        `Rotation ${i} agrees`);
    }
    assert.deepEqual(datesOf(mergeOps(emptyState(), [...ops].reverse()).state, 'ev1'), reference,
      'Reversed agrees');

    let one = emptyState();
    for (const op of [...ops].reverse()) one = mergeOps(one, [op]).state;
    assert.deepEqual(datesOf(one, 'ev1'), reference, 'One at a time agrees');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. APPLYING THE SAME OP TWICE CHANGES NOTHING ---');
  {
    const op = wholeArrayOp('ev1', ['2026-08-29'], 10);
    let s = mergeOps(emptyState(), [op]).state;
    const first = datesOf(s, 'ev1');
    const second = mergeOps(s, [op]);
    assert.deepEqual(datesOf(second.state, 'ev1'), first, 'Idempotent');
    assert.equal(second.appliedOps.length, 0, 'and recognised as already applied');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. HOSTILE AND DEGENERATE ARRAYS ---');
  {
    const cases: [string, unknown[], string[]][] = [
      ['duplicates', ['2026-08-29', '2026-08-29'], ['2026-08-29']],
      ['numbers', [1, 2], ['1', '2']],
      ['booleans', [true], ['true']],
      ['null and undefined', [null, undefined], ['null', 'undefined']],
      ['empty strings', [''], ['']],
      ['mixed', ['2026-08-29', 3], ['2026-08-29', '3']],
    ];
    for (const [label, value, expected] of cases) {
      const s = mergeOps(emptyState(), [wholeArrayOp('ev1', value, 10)]).state;
      assert.deepEqual(datesOf(s, 'ev1'), expected.sort(), `${label} handled`);
    }

    // A nested array is the one shape that genuinely cannot be a member. It must
    // still not crash, and must still be recognisable as wreckage afterwards.
    const nested = mergeOps(emptyState(), [wholeArrayOp('ev1', [['2026-08-29']], 10)]).state;
    const members = Object.keys((nested.entities.events as any).ev1.sets.completedDates);
    assert.ok(members.every(isJunkSetMember), 'A nested array is detectably junk');
    assert.deepEqual(datesOf(sanitizeState(nested), 'ev1'), [], 'and the sanitiser removes it');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. A HUGE ARRAY IS NOT QUADRATIC OR LOSSY ---');
  {
    const many = Array.from({ length: 800 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`);
    const s = mergeOps(emptyState(), [wholeArrayOp('ev1', many, 10)]).state;
    assert.equal(datesOf(s, 'ev1').length, 800, 'Every member survives');
    const cleared = mergeOps(s, [wholeArrayOp('ev1', [], 20)]).state;
    assert.equal(datesOf(cleared, 'ev1').length, 0, 'and all of them can be cleared at once');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 9. THE SANITISER, EXACTLY ---');
  {
    assert.equal(isJunkSetMember('2026-08-29'), false, 'A date is a real member');
    assert.equal(isJunkSetMember(''), false, 'So is an empty string');
    assert.equal(isJunkSetMember('abc-123'), false, 'So is an id');
    assert.equal(isJunkSetMember('["2026-08-29"]'), true, 'An encoded array is junk');
    assert.equal(isJunkSetMember('[]'), true, 'and so is an encoded empty array');
    assert.equal(isJunkSetMember('{"a":1}'), true, 'and an encoded object');

    // The exact wreckage found in the real database.
    const poisoned = mergeOps(emptyState(), [
      elementOp('ev1', '["2026-08-29"]', true, 5),
      elementOp('ev1', '[]', true, 6),
      elementOp('ev1', '2026-08-29', true, 7),
    ]).state;
    assert.deepEqual(datesOf(poisoned, 'ev1'), ['2026-08-29', '["2026-08-29"]', '[]'].sort(),
      'All three are members before the repair');

    const healed = sanitizeState(poisoned);
    assert.deepEqual(datesOf(healed, 'ev1'), ['2026-08-29'],
      'and only the real date survives it');

    // Idempotent, and free on healthy data.
    assert.equal(sanitizeState(healed), healed, 'Healthy state is returned unchanged');
    assert.deepEqual(datesOf(sanitizeState(healed), 'ev1'), ['2026-08-29'], 'and stays healed');
    assert.equal(sanitizeState(emptyState()) && true, true, 'An empty state is fine');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 10. THE SANITISER LEAVES EVERYTHING ELSE ALONE ---');
  {
    const s = mergeOps(emptyState(), [
      elementOp('ev1', '2026-08-29', true, 5),
      elementOp('ev1', '2026-07-20', true, 6, DEV_NEW, 'exdates'),
      {
        opId: 'pc:7', store: 'events', entityId: 'ev1', field: 'content',
        value: 'Lecture', device: PC, lamport: 7, at: 0,
      },
    ]).state;
    const before = JSON.stringify(s.entities);
    const after = sanitizeState(s);
    assert.equal(JSON.stringify(after.entities), before, 'Clean data is untouched');
    assert.deepEqual(datesOf(after, 'ev1', 'exdates'), ['2026-07-20'], 'exdates survive');
    assert.equal((readEntity(after, 'events', 'ev1') as any).content, 'Lecture',
      'and so do ordinary fields');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 11. THE CURRENT CLIENT NEVER EMITS THE BROKEN FORM ---');
  {
    // The forward guarantee: whatever the old build did, makeOps must always
    // produce per-element ops with an explicit `present`.
    const state = emptyState();
    const ops = makeOps(state, {
      store: 'events', entityId: 'ev1', device: DEV_NEW, at: 0,
      changes: { completedDates: ['2026-08-29', '2026-08-30'] },
    });
    assert.equal(ops.length, 2, 'One op per element');
    for (const op of ops) {
      assert.equal(typeof op.present, 'boolean', 'each with an explicit present flag');
      assert.equal(typeof op.value, 'string', 'and a scalar element as its value');
      assert.equal(elementKey(op.value), op.value, 'that needs no encoding');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 12. AN OLD PHONE AND A NEW PC CONVERGE ---');
  {
    // The real situation: one device on each build, editing the same field, with
    // neither able to tell what the other is running.
    const shared: SyncOp[] = [];
    let phone = emptyState();
    let pc = emptyState();

    const broadcast = (ops: SyncOp[]) => {
      shared.push(...ops);
      phone = mergeOps(phone, ops).state;
      pc = mergeOps(pc, ops).state;
    };

    broadcast([wholeArrayOp('ev1', ['2026-08-29'], 10)]);          // old phone
    broadcast([elementOp('ev1', '2026-08-30', true, 20, PC)]);     // new PC
    broadcast([wholeArrayOp('ev1', ['2026-08-30'], 30)]);          // old phone again
    broadcast([elementOp('ev1', '2026-08-31', true, 40, PC)]);

    assert.deepEqual(datesOf(phone, 'ev1'), datesOf(pc, 'ev1'), 'Both devices agree');
    assert.deepEqual(datesOf(phone, 'ev1'), ['2026-08-30', '2026-08-31'],
      'on the result the last writer of each member intended');

    // A third device that receives the same ops shuffled must land in the same place.
    const late = mergeOps(emptyState(), [...shared].reverse()).state;
    assert.deepEqual(datesOf(late, 'ev1'), datesOf(pc, 'ev1'),
      'and so does a device that catches up out of order');
  }

  console.log('\nALL PASS (set ops: whole-array form, ordering, repair of the wreckage)');
}

main();
