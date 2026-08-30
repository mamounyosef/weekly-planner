// Tests the offline-first sync core: field-level merge, conflict detection,
// clock skew, commutativity, convergence, sets, and delete-vs-edit races.
//
// This suite is deliberately paranoid. Merge logic is the one place in the whole
// planner where a bug DESTROYS data rather than merely showing it wrong, so the
// properties below (converge, commute, idempotent, never-lose) are asserted with
// brute-force permutations rather than a few hand-picked cases.
//
// Run with: npx tsx src/lib/sync.test.ts

import assert from 'node:assert/strict';
import {
  DELETED_FIELD,
  compareStamps,
  cursorAfter,
  elementKey,
  emptyState,
  isSetField,
  isTombstoned,
  makeDeleteOp,
  makeOps,
  mergeOps,
  opsSince,
  pruneLog,
  readEntity,
  readStore,
  resolveConflict,
  type SyncOp,
  type SyncState,
} from './sync';

const PC = 'pc-desktop';
const PH = 'phone-android';

/** A peer: its merged state plus the log of every op it knows about. */
class Peer {
  state: SyncState = emptyState();
  log: SyncOp[] = [];
  constructor(readonly device: string) {}

  edit(entityId: string, changes: Record<string, unknown>, at = 1_000, store: any = 'events') {
    const ops = makeOps(this.state, { store, entityId, device: this.device, at, changes });
    this.ingest(ops);
    return ops;
  }
  remove(entityId: string, at = 1_000, store: any = 'events') {
    const op = makeDeleteOp(this.state, { store, entityId, device: this.device, at });
    this.ingest([op]);
    return [op];
  }
  ingest(ops: SyncOp[]) {
    const res = mergeOps(this.state, ops);
    this.state = res.state;
    for (const op of ops) if (!this.log.some(o => o.opId === op.opId)) this.log.push(op);
    return res;
  }
  read(entityId: string, store: any = 'events') {
    return readEntity(this.state, store, entityId);
  }
}

/** Full bidirectional exchange, as a reconnect would do. */
function syncBoth(a: Peer, b: Peer) {
  const fromA = a.log.slice();
  const fromB = b.log.slice();
  const rb = b.ingest(fromA);
  const ra = a.ingest(fromB);
  return { toB: rb, toA: ra };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. STAMP ORDERING IS TOTAL AND DETERMINISTIC ---');

assert.ok(compareStamps({ lamport: 2, device: 'a' }, { lamport: 1, device: 'z' }) > 0,
  'Higher lamport always wins regardless of device id');
assert.ok(compareStamps({ lamport: 5, device: 'a' }, { lamport: 5, device: 'b' }) < 0,
  'Equal lamport falls back to device id for a deterministic tiebreak');
assert.equal(compareStamps({ lamport: 5, device: 'a' }, { lamport: 5, device: 'a' }), 0,
  'Identical stamps compare equal');

// The tiebreak must be antisymmetric or two peers could disagree on a winner.
for (const [x, y] of [['a', 'b'], ['pc-desktop', 'phone-android'], ['z', 'a']]) {
  const ab = compareStamps({ lamport: 3, device: x }, { lamport: 3, device: y });
  const ba = compareStamps({ lamport: 3, device: y }, { lamport: 3, device: x });
  assert.equal(Math.sign(ab), -Math.sign(ba), `Tiebreak must be antisymmetric for ${x}/${y}`);
}

console.log('--- 2. LOCAL EDITS AND LAMPORT ADVANCE ---');
{
  const pc = new Peer(PC);
  const ops = pc.edit('ev1', { title: 'Physics', startTime: '18:00' });
  assert.equal(ops.length, 2, 'One op per changed field, never a whole-record blob');
  assert.equal(pc.state.lamport, 2, 'Lamport advances once per op');
  assert.deepEqual(pc.read('ev1'), { title: 'Physics', startTime: '18:00' });

  // opIds are globally unique so a replay is detectable.
  assert.equal(new Set(ops.map(o => o.opId)).size, 2);
  assert.ok(ops.every(o => o.opId.startsWith(PC)), 'opId is namespaced by device');

  // The first write onto an empty field records no base.
  assert.equal(ops[0].baseLamport, undefined, 'First write has no base');
  const second = pc.edit('ev1', { title: 'Physics revision' });
  assert.equal(second[0].baseLamport, 1, 'A rewrite records the stamp it overwrote');
  assert.equal(second[0].baseDevice, PC);
}

console.log('--- 3. DIFFERENT FIELDS MERGE SILENTLY (THE HEADLINE CASE) ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'Physics', startTime: '18:00', categoryId: 'study' });
  syncBoth(pc, ph);

  // Now they go offline and each edit a DIFFERENT field.
  pc.edit('ev1', { title: 'Physics revision' }, 5_000);
  ph.edit('ev1', { startTime: '20:00' }, 6_000);

  const { toA, toB } = syncBoth(pc, ph);
  assert.equal(toA.conflicts.length, 0, 'Disjoint fields must NEVER raise a conflict');
  assert.equal(toB.conflicts.length, 0);

  const expected = { title: 'Physics revision', startTime: '20:00', categoryId: 'study' };
  assert.deepEqual(pc.read('ev1'), expected, 'PC keeps both edits');
  assert.deepEqual(ph.read('ev1'), expected, 'Phone keeps both edits');
}

console.log('--- 4. SAME FIELD = A REAL CONFLICT, RESOLVED IDENTICALLY ON BOTH ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { startTime: '18:00' });
  syncBoth(pc, ph);

  pc.edit('ev1', { startTime: '18:30' }, 21_14_00);
  ph.edit('ev1', { startTime: '20:00' }, 22_02_00);

  const { toA, toB } = syncBoth(pc, ph);
  assert.equal(toA.conflicts.length, 1, 'Same field from two directions raises exactly one card');
  assert.equal(toB.conflicts.length, 1);
  assert.equal(toA.conflicts[0].field, 'startTime');
  assert.equal(toA.conflicts[0].kind, 'field');

  // Both peers must name the SAME winner and the SAME loser, or they diverge.
  assert.deepEqual(pc.read('ev1'), ph.read('ev1'), 'Peers converge to one value');
  assert.equal(toA.conflicts[0].id, toB.conflicts[0].id, 'Conflict id is stable across peers');
  assert.equal(toA.conflicts[0].winner.value, toB.conflicts[0].winner.value);
  assert.equal(toA.conflicts[0].loser.value, toB.conflicts[0].loser.value);

  // Nothing is lost: the value that lost is still offered back.
  const values = [toA.conflicts[0].winner.value, toA.conflicts[0].loser.value].sort();
  assert.deepEqual(values, ['18:30', '20:00'], 'Both candidate values survive in the card');
}

console.log('--- 5. CLOCK SKEW MUST NOT DECIDE A WINNER ---');
{
  // The phone believes it is a year in the future. It must not therefore win
  // every conflict for the rest of time — ordering is by lamport, not by clock.
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'base' });
  syncBoth(pc, ph);

  // Phone edits FIRST in causal terms, but stamps a wildly future wall clock.
  ph.edit('ev1', { title: 'from phone' }, 9_999_999_999);
  // PC edits after, with a normal clock, having not seen the phone.
  pc.edit('ev1', { title: 'from pc' }, 1_000);

  const { toA } = syncBoth(pc, ph);
  assert.equal(toA.conflicts.length, 1);
  // Both are lamport 2, so the tiebreak is the device id — NOT the timestamp.
  // 'phone-android' sorts above 'pc-desktop', so the phone happens to win here.
  assert.equal(pc.read('ev1')!.title, ph.read('ev1')!.title, 'Peers still agree');
  assert.equal(toA.conflicts[0].winner.value, 'from phone',
    'The device-id tiebreak decides, not the wall clock');

  // And the display timestamp is still carried through for the sidebar to show.
  assert.equal(toA.conflicts[0].winner.at, 9_999_999_999,
    'Wall clock is preserved for display only');

  // THE ACTUAL PROOF: rerun the identical scenario with the clocks SWAPPED. If
  // timestamps influenced the outcome at all, the winner would change. It must not.
  const pc2 = new Peer(PC);
  const ph2 = new Peer(PH);
  pc2.edit('ev1', { title: 'base' });
  syncBoth(pc2, ph2);
  ph2.edit('ev1', { title: 'from phone' }, 1_000);            // phone now the OLD clock
  pc2.edit('ev1', { title: 'from pc' }, 9_999_999_999);       // PC now the future clock
  const swapped = syncBoth(pc2, ph2);
  assert.equal(swapped.toA.conflicts[0].winner.value, 'from phone',
    'Swapping the clocks must not change who wins — otherwise skew decides outcomes');
  assert.equal(pc2.read('ev1')!.title, pc.read('ev1')!.title,
    'Identical causal history yields an identical result regardless of clocks');
}

console.log('--- 6. COMMUTATIVITY: EVERY ORDER OF THE SAME OPS LANDS IDENTICALLY ---');
{
  const src = new Peer(PC);
  const other = new Peer(PH);
  src.edit('ev1', { title: 'a', startTime: '09:00' });
  other.ingest(src.log.slice());
  src.edit('ev1', { title: 'b' }, 2_000);
  other.edit('ev1', { title: 'c', endTime: '10:00' }, 3_000);
  other.edit('ev2', { title: 'second' }, 4_000);
  src.remove('ev3', 5_000);

  const allOps = [...src.log, ...other.log].filter(
    (op, i, arr) => arr.findIndex(o => o.opId === op.opId) === i,
  );

  // Every permutation of a 6+ op log is too many, so shuffle deterministically
  // a large number of times — this is the property that matters most.
  const reference = JSON.stringify(readStore(mergeOps(emptyState(), allOps).state, 'events'));
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  for (let trial = 0; trial < 300; trial++) {
    const shuffled = allOps.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const got = JSON.stringify(readStore(mergeOps(emptyState(), shuffled).state, 'events'));
    assert.equal(got, reference, `Order ${trial} diverged — ops are not commutative`);
  }

  // Conflicts must also be order-independent, not just the final values.
  const refConf = mergeOps(emptyState(), allOps).conflicts.map(c => c.id).sort();
  const revConf = mergeOps(emptyState(), allOps.slice().reverse()).conflicts.map(c => c.id).sort();
  assert.deepEqual(revConf, refConf, 'Conflict set must not depend on arrival order');
}

console.log('--- 7. IDEMPOTENCE: REPLAYING A BATCH CHANGES NOTHING ---');
{
  const pc = new Peer(PC);
  pc.edit('ev1', { title: 'x', startTime: '08:00' });
  const before = JSON.stringify(pc.state.entities);

  const again = pc.ingest(pc.log.slice());
  assert.equal(again.appliedOps.length, 0, 'A replayed batch applies nothing');
  assert.equal(again.ignoredOps.length, 2, 'and is reported as ignored, not silently dropped');
  assert.equal(again.conflicts.length, 0, 'An echo of my own ops is not a conflict');
  assert.equal(JSON.stringify(pc.state.entities), before, 'State is byte-identical after replay');

  // Ten times over, the way a flaky connection would actually retry.
  for (let i = 0; i < 10; i++) pc.ingest(pc.log.slice());
  assert.equal(JSON.stringify(pc.state.entities), before, 'Still identical after 10 replays');
}

console.log('--- 8. CONVERGENCE AFTER A LONG OFFLINE SPLIT ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'Lecture', startTime: '09:00', categoryId: 'uni' });
  pc.edit('ev2', { title: 'Gym', startTime: '17:00' });
  syncBoth(pc, ph);

  // Two weeks apart. Both sides work normally, neither can reach the other.
  for (let d = 0; d < 14; d++) {
    pc.edit(`pc-ev${d}`, { title: `PC day ${d}`, startTime: '10:00' }, 100_000 + d);
    ph.edit(`ph-ev${d}`, { title: `Phone day ${d}`, startTime: '11:00' }, 200_000 + d);
  }
  ph.edit('ev1', { startTime: '09:30' }, 300_000);   // phone moved the lecture
  pc.edit('ev1', { categoryId: 'study' }, 300_001);  // PC recategorised it
  pc.remove('ev2', 300_002);                         // PC deleted the gym slot

  syncBoth(pc, ph);
  // A second exchange must be a complete no-op — otherwise the peers would
  // oscillate forever, which is the classic write-storm failure.
  const round2 = syncBoth(pc, ph);
  assert.equal(round2.toA.appliedOps.length, 0, 'A second sync applies nothing new');
  assert.equal(round2.toB.appliedOps.length, 0);

  assert.deepEqual(readStore(pc.state, 'events'), readStore(ph.state, 'events'),
    'After a 14-day split both peers hold exactly the same planner');
  assert.deepEqual(pc.read('ev1'), { title: 'Lecture', startTime: '09:30', categoryId: 'study' },
    'Disjoint edits across a two-week split both survive');
  assert.equal(ph.read('ev2'), null, 'An uncontested delete propagates to the phone');
  assert.ok(isTombstoned(ph.state, 'events', 'ev2'), 'and leaves a tombstone, not a hole');
  assert.equal(Object.keys(readStore(ph.state, 'events')).length, 29,
    '28 new items plus ev1, with ev2 deleted');
}

console.log('--- 9. SET FIELDS: EXDATES UNION INSTEAD OF FIGHTING ---');
{
  assert.ok(isSetField('events', 'exdates'), 'exdates is a set field');
  assert.ok(isSetField('tasks', 'completedDates'), 'completedDates is a set field');
  assert.ok(!isSetField('events', 'title'), 'title is a register, not a set');

  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'Standup', exdates: ['2026-09-01'] });
  syncBoth(pc, ph);

  // Each device skips a different occurrence while offline.
  pc.edit('ev1', { exdates: ['2026-09-01', '2026-09-03'] }, 5_000);
  ph.edit('ev1', { exdates: ['2026-09-01', '2026-09-08'] }, 6_000);

  const { toA } = syncBoth(pc, ph);
  assert.equal(toA.conflicts.length, 0, 'Two different skipped dates is not a disagreement');
  assert.deepEqual(pc.read('ev1')!.exdates, ['2026-09-01', '2026-09-03', '2026-09-08'],
    'Both exclusions survive as a union');
  assert.deepEqual(ph.read('ev1')!.exdates, pc.read('ev1')!.exdates, 'Both peers agree');
}

console.log('--- 10. SET REMOVAL, AND ADD-WINS ON A TIE ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { exdates: ['2026-09-01', '2026-09-03'] });
  syncBoth(pc, ph);

  // PC un-skips a date; phone leaves it alone. The removal must stick.
  pc.edit('ev1', { exdates: ['2026-09-03'] }, 5_000);
  syncBoth(pc, ph);
  assert.deepEqual(ph.read('ev1')!.exdates, ['2026-09-03'], 'A removal propagates');

  // Now a genuine tie: one peer removes, the other re-adds, at the same lamport.
  const a = new Peer('aaa');
  const b = new Peer('bbb');
  a.edit('ev9', { exdates: ['2026-10-01'] });
  syncBoth(a, b);
  a.edit('ev9', { exdates: [] }, 7_000);                // remove
  b.edit('ev9', { exdates: ['2026-10-01'] }, 7_000);    // still present (no-op)
  syncBoth(a, b);
  assert.deepEqual(a.read('ev9')!.exdates, b.read('ev9')!.exdates,
    'Peers agree on set membership even in a tie');
}

console.log('--- 11. DELETE VS EDIT: THE ITEM MUST SURVIVE UNTIL ANSWERED ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'Dentist', startTime: '14:00' });
  syncBoth(pc, ph);

  pc.remove('ev1', 8_000);                      // PC deletes it
  ph.edit('ev1', { startTime: '15:00' }, 9_000); // phone reschedules it, unaware

  const { toA, toB } = syncBoth(pc, ph);
  const del = toA.conflicts.find(c => c.kind === 'delete');
  assert.ok(del, 'A delete racing an edit must raise a card');
  assert.equal(del!.entityId, 'ev1');

  assert.notEqual(pc.read('ev1'), null, 'The item is STILL THERE on the PC');
  assert.notEqual(ph.read('ev1'), null, 'and on the phone');
  assert.equal(pc.read('ev1')!.startTime, '15:00', 'The edit that raced it survived');
  assert.deepEqual(pc.read('ev1'), ph.read('ev1'), 'Peers agree while the card is open');
  assert.ok(toB.conflicts.some(c => c.kind === 'delete'), 'Both peers raise it');

  // Answering "Delete it" finishes the job, and that answer itself syncs.
  const ops = resolveConflict(pc.state, del!, 'delete', { device: PC, at: 10_000 });
  pc.ingest(ops);
  assert.equal(pc.read('ev1'), null, 'Confirming the delete removes it');
  syncBoth(pc, ph);
  assert.equal(ph.read('ev1'), null, 'and the phone follows');
}

console.log('--- 12. DELETE VS EDIT ANSWERED THE OTHER WAY ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'Dentist' });
  syncBoth(pc, ph);
  pc.remove('ev1', 8_000);
  ph.edit('ev1', { title: 'Dentist (moved)' }, 9_000);
  const { toA } = syncBoth(pc, ph);
  const del = toA.conflicts.find(c => c.kind === 'delete')!;

  pc.ingest(resolveConflict(pc.state, del, 'keep', { device: PC, at: 10_000 }));
  syncBoth(pc, ph);
  assert.notEqual(pc.read('ev1'), null, 'Choosing "Keep it" cancels the deletion');
  assert.equal(ph.read('ev1')!.title, 'Dentist (moved)', 'and the edit is intact on both');
  assert.equal(readEntity(ph.state, 'events', 'ev1')!.title, 'Dentist (moved)');
}

console.log('--- 13. RESOLVING A FIELD CONFLICT RESTORES THE LOSING VALUE ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { startTime: '18:00' });
  syncBoth(pc, ph);
  pc.edit('ev1', { startTime: '18:30' }, 100);
  ph.edit('ev1', { startTime: '20:00' }, 200);
  const { toA } = syncBoth(pc, ph);
  const c = toA.conflicts[0];

  // "Keep the other one" writes an ordinary op, so the choice itself syncs.
  const ops = resolveConflict(pc.state, c, 'loser', { device: PC, at: 300 });
  assert.equal(ops.length, 1, 'A resolution is one normal op, not a special channel');
  pc.ingest(ops);
  assert.equal(pc.read('ev1')!.startTime, c.loser.value, 'The chosen value is now live');

  const after = syncBoth(pc, ph);
  assert.equal(ph.read('ev1')!.startTime, c.loser.value, 'and the phone agrees');
  assert.equal(after.toB.conflicts.length, 0, 'Resolving does not raise a fresh conflict');

  // Keeping the winner is a pure dismissal — it must not write anything.
  const none = resolveConflict(pc.state, c, 'winner', { device: PC, at: 400 });
  assert.equal(none.length, 0, 'Keeping the live value writes no op');
}

console.log('--- 14. ONE CARD PER FIELD, NOT ONE PER KEYSTROKE ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'draft' });
  syncBoth(pc, ph);

  // The phone edits the same field five times while offline.
  for (let i = 0; i < 5; i++) ph.edit('ev1', { title: `phone v${i}` }, 1_000 + i);
  pc.edit('ev1', { title: 'pc version' }, 2_000);

  const { toA } = syncBoth(pc, ph);
  const titleCards = toA.conflicts.filter(c => c.field === 'title');
  assert.equal(titleCards.length, 1, 'Five offline edits are ONE disagreement to answer');
  assert.equal(titleCards[0].loser.value !== titleCards[0].winner.value, true);
  assert.deepEqual(pc.read('ev1'), ph.read('ev1'), 'and the peers still converge');
}

console.log('--- 15. STALE AND ECHOED OPS ARE IGNORED, NOT MISREAD AS CONFLICTS ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'one' });
  syncBoth(pc, ph);
  const firstOps = pc.log.slice();

  pc.edit('ev1', { title: 'two' }, 2_000);
  syncBoth(pc, ph);

  // A retry delivers the ORIGINAL op again, long after it was superseded.
  const res = ph.ingest(firstOps);
  assert.equal(res.appliedOps.length, 0, 'A superseded op must not be reapplied');
  assert.equal(res.conflicts.length, 0, 'and must not masquerade as a conflict');
  assert.equal(ph.read('ev1')!.title, 'two', 'The current value is untouched');
}

console.log('--- 16. A SEQUENTIAL CHAIN IS NEVER A CONFLICT ---');
{
  // PC edits, syncs, edits again, syncs. Each write saw the previous one, so
  // there is no divergence anywhere and the sidebar must stay empty.
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  for (let i = 0; i < 20; i++) {
    (i % 2 === 0 ? pc : ph).edit('ev1', { title: `v${i}` }, 1_000 + i);
    const r = syncBoth(pc, ph);
    assert.equal(r.toA.conflicts.length, 0, `Step ${i} must not conflict`);
    assert.equal(r.toB.conflicts.length, 0, `Step ${i} must not conflict`);
  }
  assert.equal(pc.read('ev1')!.title, 'v19');
  assert.deepEqual(pc.read('ev1'), ph.read('ev1'));
}

console.log('--- 17. THREE-WAY: A SECOND PHONE JOINING LATE ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  const tablet = new Peer('tablet-x');
  pc.edit('ev1', { title: 'Meeting', startTime: '10:00' });
  syncBoth(pc, ph);
  pc.edit('ev1', { startTime: '11:00' }, 5_000);
  ph.edit('ev1', { title: 'Meeting (long)' }, 5_001);

  // The tablet has never seen anything; it catches up from the PC only.
  syncBoth(pc, tablet);
  syncBoth(pc, ph);
  syncBoth(pc, tablet);
  syncBoth(ph, tablet);

  assert.deepEqual(pc.read('ev1'), ph.read('ev1'), 'PC and phone agree');
  assert.deepEqual(pc.read('ev1'), tablet.read('ev1'), 'and the late tablet agrees too');
  assert.deepEqual(pc.read('ev1'), { title: 'Meeting (long)', startTime: '11:00' });
}

console.log('--- 18. CROSS-STORE ISOLATION ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('x1', { title: 'an event' }, 1_000, 'events');
  pc.edit('x1', { title: 'a task' }, 1_000, 'tasks');
  syncBoth(pc, ph);
  assert.equal(ph.read('x1', 'events')!.title, 'an event');
  assert.equal(ph.read('x1', 'tasks')!.title, 'a task',
    'The same id in two stores must never collide');

  ph.edit('x1', { title: 'edited task' }, 2_000, 'tasks');
  const { toA } = syncBoth(pc, ph);
  assert.equal(toA.conflicts.length, 0, 'Editing the task does not disturb the event');
  assert.equal(pc.read('x1', 'events')!.title, 'an event');
}

console.log('--- 19. TASK COMPLETION FROM TWO DEVICES ---');
{
  // Ticking off the same repeating task on both devices is the single most
  // likely real collision, and it must not produce a card.
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('t1', { title: 'Water the plants', completedDates: [] }, 1_000, 'tasks');
  syncBoth(pc, ph);

  pc.edit('t1', { completedDates: ['2026-09-01'] }, 5_000, 'tasks');
  ph.edit('t1', { completedDates: ['2026-09-01'] }, 5_100, 'tasks');
  const { toA } = syncBoth(pc, ph);
  assert.equal(toA.conflicts.length, 0, 'Both devices ticking the same day is not a conflict');
  assert.deepEqual(pc.read('t1', 'tasks')!.completedDates, ['2026-09-01']);
  assert.deepEqual(ph.read('t1', 'tasks')!.completedDates, ['2026-09-01'], 'Ticked once, not twice');
}

console.log('--- 20. UNDEFINED CLEARS A FIELD RATHER THAN MEANING "UNCHANGED" ---');
{
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'x', endTime: '10:00' });
  syncBoth(pc, ph);
  pc.edit('ev1', { endTime: undefined }, 2_000);
  syncBoth(pc, ph);
  assert.deepEqual(pc.read('ev1'), { title: 'x' }, 'Cleared field disappears from the record');
  assert.deepEqual(ph.read('ev1'), { title: 'x' }, 'and the clear propagates');
  // This matters for `notify`: absent means INHERIT, so clearing must actually
  // clear rather than leaving a stale explicit spec behind on the other device.
}

console.log('--- 21. TRANSPORT: CURSORS AND LOG PRUNING ---');
{
  const pc = new Peer(PC);
  pc.edit('ev1', { title: 'a' });
  pc.edit('ev2', { title: 'b' }, 2_000);
  pc.edit('ev3', { title: 'c' }, 3_000);
  assert.equal(pc.log.length, 3);

  assert.equal(opsSince(pc.log, 0).length, 3, 'A fresh peer receives everything');
  assert.equal(opsSince(pc.log, 2).length, 1, 'A caught-up peer receives only the tail');
  assert.equal(opsSince(pc.log, 99).length, 0, 'A fully caught-up peer receives nothing');

  assert.equal(cursorAfter(0, pc.log), 3, 'Cursor advances to the highest lamport seen');
  assert.equal(cursorAfter(5, []), 5, 'An empty batch does not move the cursor backwards');
  assert.equal(cursorAfter(5, pc.log), 5, 'and neither does an older batch');

  assert.equal(pruneLog(pc.log, 2).length, 1, 'Acknowledged ops can be trimmed');
  assert.equal(pruneLog(pc.log, 0).length, 3, 'Nothing is trimmed below the lowest peer cursor');
}

console.log('--- 22. ELEMENT KEYS ARE STABLE ---');
{
  assert.equal(elementKey('2026-09-01'), '2026-09-01');
  assert.equal(elementKey(5), '5');
  assert.equal(elementKey(null), 'null');
  assert.equal(elementKey({ a: 1 }), '{"a":1}');
  assert.equal(elementKey({ a: 1 }), elementKey({ a: 1 }), 'Equal objects key identically');
}

console.log('--- 23. TOMBSTONES AND READING STATE BACK ---');
{
  const pc = new Peer(PC);
  assert.equal(pc.read('missing'), null, 'An unknown entity reads as null');
  assert.equal(isTombstoned(pc.state, 'events', 'missing'), false,
    'and is NOT reported as deleted — never seen and deleted are different things');

  pc.edit('ev1', { title: 'x' });
  pc.remove('ev1', 2_000);
  assert.equal(pc.read('ev1'), null, 'A tombstoned entity reads as null');
  assert.ok(isTombstoned(pc.state, 'events', 'ev1'), 'but is known to be deleted');
  assert.equal(Object.keys(readStore(pc.state, 'events')).length, 0,
    'Tombstones are omitted from the materialised store');
  assert.equal(pc.state.entities.events.ev1.fields[DELETED_FIELD].value, true);
}

console.log('--- 24. STRESS: RANDOMISED SPLIT-BRAIN ALWAYS CONVERGES ---');
{
  // Randomly interleave edits, deletes and partial syncs across three peers and
  // assert that a final full sync ALWAYS lands them on identical state. This is
  // the test most likely to catch a merge bug we did not think of.
  let seed = 987654321;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  for (let run = 0; run < 400; run++) {
    const peers = [new Peer('dev-a'), new Peer('dev-b'), new Peer('dev-c')];
    const ids = ['e1', 'e2', 'e3', 'e4'];
    const fields = ['title', 'startTime', 'endTime', 'categoryId'];

    for (let step = 0; step < 60; step++) {
      const p = pick(peers);
      const roll = rand();
      if (roll < 0.60) {
        p.edit(pick(ids), { [pick(fields)]: `v${step}` }, 1_000 + step);
      } else if (roll < 0.70) {
        p.edit(pick(ids), { exdates: [`2026-09-0${1 + Math.floor(rand() * 9)}`] }, 1_000 + step);
      } else if (roll < 0.78) {
        p.remove(pick(ids), 1_000 + step);
      } else {
        const q = pick(peers.filter(x => x !== p));
        syncBoth(p, q);
      }
    }

    // Full mesh sync, twice, to let any resolution op propagate everywhere.
    for (let pass = 0; pass < 3; pass++) {
      for (const a of peers) for (const b of peers) if (a !== b) syncBoth(a, b);
    }

    const snapshots = peers.map(p => JSON.stringify(readStore(p.state, 'events')));
    assert.equal(snapshots[1], snapshots[0], `Run ${run}: peer b diverged from a`);
    assert.equal(snapshots[2], snapshots[0], `Run ${run}: peer c diverged from a`);

    // And a further sync must be a no-op: no oscillation, no write storm.
    const quiet = syncBoth(peers[0], peers[1]);
    assert.equal(quiet.toA.appliedOps.length, 0, `Run ${run}: peers still exchanging after settling`);
    assert.equal(quiet.toB.appliedOps.length, 0, `Run ${run}: peers still exchanging after settling`);
  }
}

console.log('--- 25. NO EDIT IS EVER LOST WITHOUT A CARD ---');
{
  // The safety property in plain terms: for every value a user typed, either it
  // is live, or an unresolved conflict is offering it back. Never neither.
  const pc = new Peer(PC);
  const ph = new Peer(PH);
  pc.edit('ev1', { title: 'original', startTime: '10:00' });
  syncBoth(pc, ph);

  const typed = new Set<string>();
  const allConflicts: { field: string; value: unknown }[] = [];

  for (let i = 0; i < 8; i++) {
    const pcVal = `pc-${i}`;
    const phVal = `ph-${i}`;
    pc.edit('ev1', { title: pcVal }, 5_000 + i);
    ph.edit('ev1', { title: phVal }, 5_000 + i);
    typed.add(pcVal).add(phVal);
    const { toA } = syncBoth(pc, ph);
    for (const c of toA.conflicts) {
      allConflicts.push({ field: c.field, value: c.winner.value });
      allConflicts.push({ field: c.field, value: c.loser.value });
    }
  }

  const live = pc.read('ev1')!.title as string;
  const offered = new Set(allConflicts.map(c => String(c.value)));
  for (const v of typed) {
    assert.ok(v === live || offered.has(v),
      `Value "${v}" was typed but is neither live nor offered back in a card`);
  }
  assert.deepEqual(pc.read('ev1'), ph.read('ev1'), 'and the peers agree at the end');
}

console.log('--- 26. DANGEROUS KEYS ARE DATA, NOT PROTOTYPE ACCESS ---');
{
  // Entity ids and field names are user data. On a plain object, a key of
  // `__proto__` does not create an entry: a read hands back Object.prototype and
  // a write invokes the prototype setter. That crashed the engine, and could
  // have polluted every object in the process. These keys must behave like any
  // other string.
  const DANGEROUS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];

  for (const key of DANGEROUS) {
    const pc = new Peer(PC);
    const ph = new Peer(PH);

    // As an ENTITY ID.
    pc.edit(key, { title: `id ${key}` });
    assert.equal(pc.read(key)!.title, `id ${key}`, `Entity id "${key}" round-trips`);

    // As a FIELD NAME.
    pc.edit('ev1', { [key]: `field ${key}` });
    assert.equal(pc.read('ev1')![key], `field ${key}`, `Field name "${key}" round-trips`);

    // And it must still SYNC, merge and conflict like anything else.
    syncBoth(pc, ph);
    assert.equal(ph.read(key)!.title, `id ${key}`, `"${key}" as an id syncs`);
    assert.equal(ph.read('ev1')![key], `field ${key}`, `"${key}" as a field syncs`);

    pc.edit('ev1', { [key]: 'from pc' }, 5_000);
    ph.edit('ev1', { [key]: 'from phone' }, 5_001);
    const { toA } = syncBoth(pc, ph);
    assert.equal(toA.conflicts.length, 1, `A conflict on field "${key}" is detected normally`);
    assert.deepEqual(pc.read('ev1'), ph.read('ev1'), `Peers converge on field "${key}"`);
  }

  // Nothing leaked onto the prototype chain of ordinary objects.
  assert.equal(({} as any).title, undefined, 'Object.prototype was not polluted');
  assert.equal(([] as any).title, undefined, 'Array.prototype was not polluted');
  assert.equal(Object.prototype.hasOwnProperty('title'), false);

  // A dangerous key must also survive persistence, since the server writes the
  // whole state to JSON and reads it back on every restart.
  const pc2 = new Peer(PC);
  pc2.edit('__proto__', { title: 'persisted' });
  const revived = JSON.parse(JSON.stringify(pc2.state));
  assert.equal(readEntity(revived, 'events', '__proto__')!.title, 'persisted',
    'A __proto__ entity id survives a JSON round trip');

  // And merging INTO the revived state still works — this is the restart path.
  const more = makeOps(revived, {
    store: 'events', entityId: '__proto__', device: PC, at: 9_000,
    changes: { title: 'after restart' },
  });
  const merged = mergeOps(revived, more);
  assert.equal(readEntity(merged.state, 'events', '__proto__')!.title, 'after restart',
    'and can still be edited afterwards');
  assert.equal(merged.conflicts.length, 0, 'with no phantom conflict');

  // A set field keyed dangerously.
  const pc3 = new Peer(PC);
  pc3.edit('ev1', { exdates: ['__proto__', 'constructor', '2026-09-01'] });
  assert.deepEqual(pc3.read('ev1')!.exdates, ['2026-09-01', '__proto__', 'constructor'],
    'Dangerous strings are ordinary set members');
}

console.log('\nALL PASS (sync core: merge, conflicts, clock skew, convergence)');
