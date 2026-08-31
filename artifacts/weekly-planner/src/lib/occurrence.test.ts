// Tests the scope of an edit or a delete on a repeating item.
//
// THE ONE THAT MATTERS: a scope decision is invisible when it goes wrong. Ask
// for "only this Tuesday" and get "the whole series", and nothing errors, no
// dialog appears, the item simply is not there next week either. Ask for "all"
// and get "only this one", and the change you thought you made silently stops
// applying in seven days. Neither failure announces itself, and both are
// unrecoverable once Google has mirrored them.
//
// So almost every case here checks the RESULT rather than the plan: the writes
// are applied to a store and the store is re-expanded through `occurrenceStarts`
// from `recurrence.ts`, the same function the grid uses. A detached occurrence
// that comes back on re-expansion is the specific bug this catches.
//
// The final section pins this file against the PC's own `editSeries` and
// `deleteScoped`. The two machines must agree about what an edit meant or they
// diverge permanently, and the only proof of that is running both.
//
// Run with: npx tsx src/lib/occurrence.test.ts

import assert from 'node:assert/strict';
import { format } from 'date-fns';

import {
  applyOccurrenceWrites,
  countBefore,
  effectiveScope,
  firstOccurrenceDate,
  isOccurrenceOf,
  planOccurrenceDelete,
  planOccurrenceEdit,
  scopeChoices,
  type OccurrencePlan,
} from './occurrence';
import {
  deleteScoped,
  editSeries,
  makeOccId,
  occurrenceStarts,
  parseDate,
  weekKeyOf,
  type RecurFields,
  type Recurrence,
} from './recurrence';

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Ev extends RecurFields {
  content?: string;
  color?: string;
  done?: boolean;
}

// 2026-01-04 is a Sunday, so dayIndex 1 is Monday 2026-01-05. Every weekly
// fixture therefore lands on Mondays: 05, 12, 19, 26 January, then 02, 09
// February. Dates are spelled out in the assertions rather than computed, so a
// wrong expansion cannot be masked by the same wrong arithmetic twice.
const MON = '2026-01-05';

function ev(over: Partial<Ev> = {}): Ev {
  return {
    id: 'm1',
    weekKey: '2026-01-04',
    dayIndex: 1,
    startTime: '09:00',
    endTime: '10:00',
    content: 'Gym',
    color: 'sage',
    recur: { freq: 'weekly', interval: 1 },
    ...over,
  };
}

const weekly = (end?: Recurrence['end']): Recurrence => ({ freq: 'weekly', interval: 1, ...(end ? { end } : {}) });

/** Deterministic ids and timestamps so a plan can be compared field by field. */
function opts(extra: { weekStartsOn?: 0 | 1 } = {}) {
  let n = 0;
  return { newId: () => `n${++n}`, now: () => 1_700_000_000_000, ...extra };
}

const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');

/**
 * Every date the whole store shows in [from, to), from every record it holds.
 * This is the real expansion path, so anything the grid would draw shows up here
 * and anything it would hide does not.
 */
function shows(store: Record<string, Ev>, from: string, to: string): string[] {
  const out: string[] = [];
  for (const rec of Object.values(store)) {
    if (rec.deleted) continue;
    for (const d of occurrenceStarts(rec, parseDate(from), parseDate(to))) out.push(ymd(d));
  }
  return out.sort();
}

/** Which record is responsible for a given visible date. */
function ownerOf(store: Record<string, Ev>, date: string): string[] {
  const out: string[] = [];
  for (const rec of Object.values(store)) {
    if (rec.deleted) continue;
    const hits = occurrenceStarts(rec, parseDate(date), new Date(parseDate(date).getTime() + 86_400_000));
    if (hits.length) out.push(rec.id);
  }
  return out.sort();
}

function put<T extends RecurFields>(plan: OccurrencePlan<T>, role: string): T {
  const w = plan.writes.find(x => x.role === role);
  assert.ok(w, `plan has a '${role}' write`);
  assert.equal(w!.op, 'put', `the '${role}' write is a put`);
  return (w as { record: T }).record;
}

const YEAR = ['2026-01-01', '2027-01-01'] as const;

function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. AN ITEM THAT DOES NOT REPEAT IGNORES SCOPE ENTIRELY ---');
  {
    // There is nothing to scope, so all three choices must land on the same
    // single write. A menu that offers the question here would be lying.
    for (const scope of ['one', 'following', 'all'] as const) {
      const plain = ev({ recur: undefined });
      const plan = planOccurrenceEdit(plain, MON, scope, { content: 'Swim' }, opts());
      assert.equal(plan.scope, 'all');
      assert.equal(plan.writes.length, 1);
      assert.equal(plan.targetId, 'm1');
      assert.equal(put(plan, 'master').content, 'Swim');
      assert.equal(put(plan, 'master').recur, undefined);

      const del = planOccurrenceDelete(plain, MON, scope, opts());
      assert.equal(del.scope, 'all');
      assert.deepEqual(del.writes, [{ op: 'remove', id: 'm1', role: 'dropped' }]);
      assert.equal(del.targetId, null);
    }
    assert.deepEqual(effectiveScope(ev({ recur: undefined }), 'one', 'edit'), { scope: 'all', forcedByLock: false });
    // A missing record must not throw. The menu can outlive the item it opened on.
    assert.deepEqual(effectiveScope(undefined, 'following', 'delete'), { scope: 'all', forcedByLock: false });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. EDIT ALL: ONE WRITE, THE SERIES KEEPS ITS SHAPE ---');
  {
    const m = ev({ recur: weekly({ count: 4 }) });
    const plan = planOccurrenceEdit(m, '2026-01-19', 'all', { content: 'Swim', color: 'blue' }, opts());
    assert.equal(plan.scope, 'all');
    assert.equal(plan.forcedByLock, false);
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.targetId, 'm1');

    const store = applyOccurrenceWrites({ m1: m }, plan);
    assert.deepEqual(shows(store, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    assert.equal(store.m1.content, 'Swim');
    assert.equal(store.m1.color, 'blue');
    // The rule, the anchor and the Google identity are none of an edit's business.
    assert.deepEqual(store.m1.recur, weekly({ count: 4 }));
    assert.equal(store.m1.weekKey, '2026-01-04');
    assert.equal(store.m1.dayIndex, 1);
    assert.equal(store.m1.updatedAt, 1_700_000_000_000);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. EDIT ONE: DETACHES, AND THE SERIES IS OTHERWISE UNTOUCHED ---');
  {
    const m = ev({ recur: weekly({ count: 4 }), gCalId: 'g-abc', gCalCalendarId: 'daily', gCalETag: 'W/1', lastSyncedAt: 5 });
    const plan = planOccurrenceEdit(m, '2026-01-19', 'one', { content: 'Swim' }, opts());
    assert.equal(plan.scope, 'one');
    assert.equal(plan.writes.length, 2);
    assert.equal(plan.targetId, 'n1');

    const master = put(plan, 'master');
    const det = put(plan, 'detached');

    assert.deepEqual(master.exdates, ['2026-01-19']);
    assert.equal(master.content, 'Gym', 'the series keeps the OLD text');
    assert.equal(master.gCalId, 'g-abc', 'the series keeps its Google event');

    assert.equal(det.id, 'n1');
    assert.equal(det.content, 'Swim');
    assert.equal(det.recur, undefined, 'a detached occurrence does not repeat');
    assert.equal(det.exdates, undefined);
    assert.equal(det.locked, undefined);
    assert.equal(det.masterId, undefined, 'no view-only fields reach the store');
    assert.equal(det.occDate, undefined);
    assert.equal(det.deleted, false);
    // Two records claiming one Google event means `resolveWeek` hides one of
    // them, so the detached copy must start with a clean identity.
    for (const k of ['gCalId', 'gCalCalendarId', 'gCalETag', 'gCalRecurSig', 'lastSyncedAt'] as const) {
      assert.equal(det[k], undefined, `detached.${k} is cleared`);
    }
    // Anchored on a real week start with a 0-6 index, never a raw date.
    assert.equal(det.weekKey, weekKeyOf(parseDate('2026-01-19'), 0));
    assert.equal(det.weekKey, '2026-01-18');
    assert.equal(det.dayIndex, 1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. A DETACHED OCCURRENCE NEVER COMES BACK ---');
  {
    // The whole point. Re-expand the store afterwards and the date must be shown
    // exactly once, by the detached record and not by the series.
    const m = ev({ recur: weekly({ count: 4 }) });
    const store = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, '2026-01-19', 'one', { content: 'Swim' }, opts()));

    assert.deepEqual(shows(store, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    assert.deepEqual(ownerOf(store, '2026-01-19'), ['n1'], 'only the detached record owns that day');
    assert.deepEqual(ownerOf(store, '2026-01-12'), ['m1']);
    // And the series alone, without the detached record, has a hole there.
    assert.deepEqual(shows({ m1: store.m1 }, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-26']);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. DETACHING THE FIRST AND THE LAST OCCURRENCE ---');
  {
    // The first: the series now starts later in practice while its anchor stays
    // put. An anchor that moved would slide every later occurrence with it.
    const m = ev({ recur: weekly({ count: 4 }) });
    const first = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, MON, 'one', { content: 'Swim' }, opts()));
    assert.deepEqual(first.m1.exdates, [MON]);
    assert.equal(first.m1.weekKey, '2026-01-04');
    assert.equal(first.m1.dayIndex, 1);
    assert.deepEqual(shows(first, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    assert.deepEqual(ownerOf(first, MON), ['n1']);
    // The count still spends itself on the excluded date, so the series does not
    // grow a fourth Monday to make up for the one taken away.
    assert.deepEqual(shows({ m1: first.m1 }, ...YEAR), ['2026-01-12', '2026-01-19', '2026-01-26']);

    // The last: nothing after it, so the series simply ends one Monday earlier.
    const last = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, '2026-01-26', 'one', { content: 'Swim' }, opts()));
    assert.deepEqual(last.m1.exdates, ['2026-01-26']);
    assert.deepEqual(shows({ m1: last.m1 }, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19']);
    assert.deepEqual(shows(last, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    assert.equal(last.n1.content, 'Swim');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. EDIT FOLLOWING: THE SERIES SPLITS IN TWO ---');
  {
    const m = ev({ recur: weekly({ count: 6 }) });
    const plan = planOccurrenceEdit(m, '2026-01-19', 'following', { content: 'Swim' }, opts());
    assert.equal(plan.scope, 'following');
    assert.equal(plan.writes.length, 2);
    assert.equal(plan.targetId, 'n1');

    const head = put(plan, 'master');
    const tail = put(plan, 'newMaster');
    assert.deepEqual(head.recur, { freq: 'weekly', interval: 1, end: { until: '2026-01-18' } });
    assert.equal(head.content, 'Gym', 'earlier days keep the old version');
    assert.equal(tail.content, 'Swim');
    assert.equal(tail.id, 'n1');
    assert.equal(tail.gCalId, undefined, 'the tail is its own event from now on');
    assert.equal(tail.weekKey, '2026-01-18');
    assert.equal(tail.dayIndex, 1);

    const store = applyOccurrenceWrites({ m1: m }, plan);
    // Not one day gained, not one lost.
    assert.deepEqual(shows(store, ...YEAR),
      ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26', '2026-02-02', '2026-02-09']);
    assert.deepEqual(shows({ m1: store.m1 }, ...YEAR), ['2026-01-05', '2026-01-12']);
    assert.deepEqual(shows({ n1: store.n1 }, ...YEAR),
      ['2026-01-19', '2026-01-26', '2026-02-02', '2026-02-09']);
    // And the edit landed on exactly the right half.
    assert.deepEqual(ownerOf(store, '2026-01-12'), ['m1']);
    assert.deepEqual(ownerOf(store, '2026-01-19'), ['n1']);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. FOLLOWING FROM THE FIRST OCCURRENCE IS JUST ALL ---');
  {
    // Truncating a series to end before it began leaves nothing behind, so a
    // split would write an empty record and orphan the Google event. One write
    // on the master is the same visible result with none of that.
    const m = ev({ recur: weekly({ count: 4 }) });
    const plan = planOccurrenceEdit(m, MON, 'following', { content: 'Swim' }, opts());
    assert.equal(plan.scope, 'all', 'reported honestly, not as "following"');
    assert.equal(plan.writes.length, 1);
    assert.equal(plan.targetId, 'm1');

    const store = applyOccurrenceWrites({ m1: m }, plan);
    assert.deepEqual(shows(store, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    assert.equal(store.m1.content, 'Swim');
    assert.deepEqual(store.m1.recur, weekly({ count: 4 }), 'the rule is untouched');

    // The same collapse on the anchor date itself, even when the anchor is not a
    // real occurrence because the rule skips it.
    const offAnchor = ev({ dayIndex: 0, recur: { freq: 'weekly', interval: 1, byWeekday: [1] } }); // anchor Sunday, repeats Mondays
    assert.equal(firstOccurrenceDate(offAnchor), MON);
    const p2 = planOccurrenceEdit(offAnchor, '2026-01-04', 'following', { content: 'Swim' }, opts());
    assert.equal(p2.scope, 'all');
    const p3 = planOccurrenceEdit(offAnchor, MON, 'following', { content: 'Swim' }, opts());
    assert.equal(p3.scope, 'all', 'the FIRST occurrence collapses too, not only the anchor');

    // A rule that produces nothing at all cannot be split either.
    const empty = ev({ recur: weekly({ until: '2025-12-01' }) });
    assert.equal(firstOccurrenceDate(empty), null);
    assert.equal(planOccurrenceEdit(empty, '2026-01-19', 'following', {}, opts()).scope, 'all');
    assert.equal(planOccurrenceDelete(empty, '2026-01-19', 'following', opts()).scope, 'all');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. FOLLOWING ON THE LAST OCCURRENCE LEAVES A SERIES OF ONE ---');
  {
    const m = ev({ recur: weekly({ count: 4 }) });
    const store = applyOccurrenceWrites({ m1: m },
      planOccurrenceEdit(m, '2026-01-26', 'following', { content: 'Swim' }, opts()));

    assert.deepEqual(shows({ m1: store.m1 }, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19']);
    assert.deepEqual(shows({ n1: store.n1 }, ...YEAR), ['2026-01-26'], 'exactly one day left in the tail');
    assert.deepEqual(store.n1.recur, { freq: 'weekly', interval: 1, end: { count: 1 } });
    assert.equal(store.n1.content, 'Swim');
    assert.deepEqual(shows(store, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);

    // Deleting from the last occurrence onwards is the same as deleting that one.
    const del = applyOccurrenceWrites({ m1: m }, planOccurrenceDelete(m, '2026-01-26', 'following', opts()));
    assert.deepEqual(shows(del, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19']);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 9. A COUNT SURVIVES A SPLIT WITH THE SAME TOTAL ---');
  {
    // The failure this guards: the tail inherits the FULL count and the series
    // gets longer every time somebody edits the middle of it.
    for (const total of [2, 3, 4, 5, 6, 10]) {
      const m = ev({ recur: weekly({ count: total }) });
      const all = shows({ m1: m }, ...YEAR);
      assert.equal(all.length, total);
      for (const at of all) {
        const store = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, at, 'following', { content: 'X' }, opts()));
        assert.deepEqual(shows(store, ...YEAR), all, `count ${total} split at ${at} keeps every day`);
      }
    }
    assert.equal(countBefore(ev({ recur: weekly({ count: 6 }) }), '2026-01-19'), 2);
    assert.equal(countBefore(ev({ recur: weekly({ count: 6 }) }), MON), 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 10. AN UNTIL SURVIVES A SPLIT UNCHANGED ---');
  {
    const m = ev({ recur: weekly({ until: '2026-02-02' }) });
    const all = shows({ m1: m }, ...YEAR);
    assert.deepEqual(all, ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26', '2026-02-02']);
    for (const at of all) {
      const store = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, at, 'following', { content: 'X' }, opts()));
      assert.deepEqual(shows(store, ...YEAR), all, `until split at ${at} keeps every day`);
    }
    const plan = planOccurrenceEdit(m, '2026-01-19', 'following', {}, opts());
    // An UNTIL is an absolute date, so the tail keeps it exactly.
    assert.deepEqual(put(plan, 'newMaster').recur, { freq: 'weekly', interval: 1, end: { until: '2026-02-02' } });
    assert.deepEqual(put(plan, 'master').recur, { freq: 'weekly', interval: 1, end: { until: '2026-01-18' } });

    // A rule with no end at all keeps having no end on both sides.
    const forever = ev({});
    const p2 = planOccurrenceEdit(forever, '2026-01-19', 'following', {}, opts());
    assert.deepEqual(put(p2, 'newMaster').recur, { freq: 'weekly', interval: 1 });
    assert.deepEqual(put(p2, 'master').recur, { freq: 'weekly', interval: 1, end: { until: '2026-01-18' } });
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 11. A SERIES THAT ALREADY HAS EXDATES ---');
  {
    const m = ev({ recur: weekly({ count: 6 }), exdates: ['2026-01-12', '2026-02-02'] });
    const visible = shows({ m1: m }, ...YEAR);
    assert.deepEqual(visible, ['2026-01-05', '2026-01-19', '2026-01-26', '2026-02-09']);

    // Detaching adds to the list rather than replacing it.
    const one = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, '2026-01-19', 'one', { content: 'X' }, opts()));
    assert.deepEqual(one.m1.exdates, ['2026-01-12', '2026-02-02', '2026-01-19']);
    assert.deepEqual(shows(one, ...YEAR), visible, 'the same days are still shown');

    // A split hands each exclusion to the half it falls in, and to only one.
    const plan = planOccurrenceEdit(m, '2026-01-26', 'following', { content: 'X' }, opts());
    assert.deepEqual(put(plan, 'master').exdates, ['2026-01-12']);
    assert.deepEqual(put(plan, 'newMaster').exdates, ['2026-02-02']);
    const split = applyOccurrenceWrites({ m1: m }, plan);
    assert.deepEqual(shows(split, ...YEAR), visible);

    // A 'following' DELETE drops the exclusions that are now past the end. They
    // would otherwise ride along forever in the Google EXDATE list.
    const delPlan = planOccurrenceDelete(m, '2026-01-26', 'following', opts());
    assert.deepEqual(put(delPlan, 'master').exdates, ['2026-01-12']);
    assert.deepEqual(shows(applyOccurrenceWrites({ m1: m }, delPlan), ...YEAR), ['2026-01-05', '2026-01-19']);

    // Excluded dates at the FRONT: "everything after the first day you can still
    // see" is everything, exactly as `deleteScoped` decides it.
    const gnawed = ev({ recur: weekly({ count: 4 }), exdates: [MON, '2026-01-12'] });
    assert.equal(firstOccurrenceDate(gnawed), '2026-01-19');
    assert.equal(planOccurrenceEdit(gnawed, '2026-01-19', 'following', {}, opts()).scope, 'all');
    assert.equal(planOccurrenceDelete(gnawed, '2026-01-19', 'following', opts()).scope, 'all');
    // But one day further in still splits.
    assert.equal(planOccurrenceEdit(gnawed, '2026-01-26', 'following', {}, opts()).scope, 'following');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 12. EVERY FREQUENCY, EVERY SCOPE, NOTHING GAINED OR LOST ---');
  {
    const rules: Recurrence[] = [
      { freq: 'daily', interval: 1, end: { count: 5 } },
      { freq: 'daily', interval: 3, end: { count: 4 } },
      { freq: 'daily', interval: 1, end: { until: '2026-01-09' } },
      { freq: 'weekly', interval: 1, end: { count: 5 } },
      { freq: 'weekly', interval: 2, end: { count: 4 } },
      { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5], end: { count: 7 } },
      { freq: 'weekly', interval: 1, byWeekday: [0, 6], end: { count: 5 } },
      { freq: 'monthly', interval: 1, end: { count: 5 } },
      { freq: 'monthly', interval: 2, end: { count: 4 } },
      { freq: 'monthly', interval: 1, end: { until: '2026-05-05' } },
      { freq: 'yearly', interval: 1, end: { count: 3 } },
      { freq: 'yearly', interval: 2, end: { count: 3 } },
    ];
    const WIDE = ['2026-01-01', '2033-01-01'] as const;

    for (const recur of rules) {
      const name = `${recur.freq}/${recur.interval}${recur.byWeekday ? `/${recur.byWeekday.join('')}` : ''}`;
      const m = ev({ recur });
      const all = shows({ m1: m }, ...WIDE);
      assert.ok(all.length >= 3, `${name}: fixture produces enough occurrences to scope`);

      for (const at of all) {
        // ONE: the set of visible days never changes, but the day is owned by a
        // standalone record afterwards.
        const one = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, at, 'one', { content: 'X' }, opts()));
        assert.deepEqual(shows(one, ...WIDE), all, `${name}: detaching ${at} keeps every day`);
        assert.deepEqual(ownerOf(one, at), ['n1'], `${name}: ${at} is owned by the detached record`);
        assert.equal(one.n1.recur, undefined);

        // FOLLOWING: same days, split at the right place.
        const fol = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, at, 'following', { content: 'X' }, opts()));
        assert.deepEqual(shows(fol, ...WIDE), all, `${name}: splitting at ${at} keeps every day`);
        if (at !== all[0]) {
          assert.deepEqual(shows({ m1: fol.m1 }, ...WIDE), all.filter(d => d < at), `${name}: head of ${at}`);
          assert.deepEqual(shows({ n1: fol.n1 }, ...WIDE), all.filter(d => d >= at), `${name}: tail of ${at}`);
          // The tail repeats on the same rhythm; only the end may be rewritten.
          assert.equal(fol.n1.recur!.freq, recur.freq);
          assert.equal(fol.n1.recur!.interval, recur.interval);
          assert.deepEqual(fol.n1.recur!.byWeekday, recur.byWeekday);
        }

        // DELETE ONE / FOLLOWING: the exact complement of the above.
        const d1 = applyOccurrenceWrites({ m1: m }, planOccurrenceDelete(m, at, 'one', opts()));
        assert.deepEqual(shows(d1, ...WIDE), all.filter(d => d !== at), `${name}: delete one ${at}`);
        const df = applyOccurrenceWrites({ m1: m }, planOccurrenceDelete(m, at, 'following', opts()));
        assert.deepEqual(shows(df, ...WIDE), all.filter(d => d < at), `${name}: delete following ${at}`);
      }

      // ALL: nothing survives.
      const da = applyOccurrenceWrites({ m1: m }, planOccurrenceDelete(m, all[1], 'all', opts()));
      assert.deepEqual(shows(da, ...WIDE), [], `${name}: delete all`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 13. DELETE ALL: TOMBSTONE WHEN SYNCED, REMOVE WHEN NOT ---');
  {
    // A synced record must stay long enough to tell Google. Removing it here and
    // now deletes it on this phone and leaves it on every calendar forever.
    const synced = ev({ recur: weekly({ count: 4 }), gCalId: 'g-abc' });
    const plan = planOccurrenceDelete(synced, '2026-01-19', 'all', opts());
    assert.deepEqual(plan.writes, [{
      op: 'put', id: 'm1', role: 'tombstone',
      record: { ...synced, deleted: true, updatedAt: 1_700_000_000_000 },
    }]);
    assert.equal(plan.targetId, null);
    assert.deepEqual(shows(applyOccurrenceWrites({ m1: synced }, plan), ...YEAR), []);

    const local = ev({ recur: weekly({ count: 4 }) });
    assert.deepEqual(planOccurrenceDelete(local, '2026-01-19', 'all', opts()).writes,
      [{ op: 'remove', id: 'm1', role: 'dropped' }]);

    // The same fork on a 'following' delete that collapses to 'all'.
    assert.equal(planOccurrenceDelete(synced, MON, 'following', opts()).writes[0].role, 'tombstone');
    assert.equal(planOccurrenceDelete(local, MON, 'following', opts()).writes[0].role, 'dropped');
    // And when there is no occurrence date to scope by at all.
    assert.equal(planOccurrenceDelete(local, null, 'one', opts()).scope, 'all');
    assert.equal(planOccurrenceDelete(local, null, 'following', opts()).writes[0].role, 'dropped');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 14. DELETE ONE IS AN EXCLUSION, AND IS IDEMPOTENT ---');
  {
    const m = ev({ recur: weekly({ count: 4 }) });
    const plan = planOccurrenceDelete(m, '2026-01-12', 'one', opts());
    assert.deepEqual(put(plan, 'master').exdates, ['2026-01-12']);
    assert.equal(plan.targetId, 'm1', 'the series is still there to keep selected');
    const store = applyOccurrenceWrites({ m1: m }, plan);
    assert.deepEqual(shows(store, ...YEAR), ['2026-01-05', '2026-01-19', '2026-01-26']);

    // Asking again must write NOTHING. A redundant write is a sync op that can
    // lose a race against a real one.
    const again = planOccurrenceDelete(store.m1, '2026-01-12', 'one', opts());
    assert.deepEqual(again.writes, []);
    assert.equal(applyOccurrenceWrites(store, again), store, 'an empty plan returns the same store');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 15. LOCKED FORCES ALL ON AN EDIT, AND NEVER ON A DELETE ---');
  {
    const m = ev({ recur: weekly({ count: 4 }), locked: true });

    for (const scope of ['one', 'following'] as const) {
      const plan = planOccurrenceEdit(m, '2026-01-19', scope, { content: 'Swim' }, opts());
      assert.equal(plan.scope, 'all', `locked overrides '${scope}'`);
      assert.equal(plan.forcedByLock, true, 'and says so, so the menu can warn');
      assert.equal(plan.writes.length, 1);
      const store = applyOccurrenceWrites({ m1: m }, plan);
      assert.deepEqual(shows(store, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
      assert.equal(store.m1.content, 'Swim');
      assert.equal(store.m1.exdates, undefined, 'nothing was detached');
      assert.equal(store.m1.locked, true, 'and the lock survives the edit');
      assert.deepEqual(effectiveScope(m, scope, 'edit'), { scope: 'all', forcedByLock: true });
    }
    // Asking for 'all' outright is not an override, so nothing to warn about.
    assert.equal(planOccurrenceEdit(m, '2026-01-19', 'all', {}, opts()).forcedByLock, false);

    // Locking means "keep every occurrence identical", not "you may never drop
    // one". `deleteScoped` never reads the flag, so neither does this.
    const del = planOccurrenceDelete(m, '2026-01-19', 'one', opts());
    assert.equal(del.scope, 'one');
    assert.equal(del.forcedByLock, false);
    assert.deepEqual(shows(applyOccurrenceWrites({ m1: m }, del), ...YEAR),
      ['2026-01-05', '2026-01-12', '2026-01-26']);
    assert.deepEqual(effectiveScope(m, 'one', 'delete'), { scope: 'one', forcedByLock: false });
    const delF = planOccurrenceDelete(m, '2026-01-19', 'following', opts());
    assert.equal(delF.scope, 'following');
    assert.deepEqual(shows(applyOccurrenceWrites({ m1: m }, delF), ...YEAR), ['2026-01-05', '2026-01-12']);

    // An unlocked series is the default, and it detaches.
    assert.equal(planOccurrenceEdit(ev({ recur: weekly() }), '2026-01-19', 'one', {}, opts()).scope, 'one');
    assert.equal(planOccurrenceEdit(ev({ recur: weekly(), locked: false }), '2026-01-19', 'one', {}, opts()).scope, 'one');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 16. A DATE THAT IS NOT IN THE SERIES ---');
  {
    const m = ev({ recur: weekly({ count: 4 }) }); // Mondays only
    assert.equal(isOccurrenceOf(m, MON), true);
    assert.equal(isOccurrenceOf(m, '2026-01-07'), false, 'a Wednesday is not in a Monday series');
    assert.equal(isOccurrenceOf(m, '2026-03-02'), false, 'past the end of the count');
    assert.equal(isOccurrenceOf(ev({ recur: weekly({ count: 4 }), exdates: ['2026-01-12'] }), '2026-01-12'), false,
      'an excluded date is not an occurrence any more');

    // The PC does not check either, and it must not: refusing here would strand a
    // stale menu that was opened just before the series changed. An exclusion for
    // a date the rule never produces is inert, so the result is a plain new item.
    const store = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, '2026-01-07', 'one', { content: 'Swim' }, opts()));
    assert.deepEqual(store.m1.exdates, ['2026-01-07']);
    assert.deepEqual(shows({ m1: store.m1 }, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26'],
      'the series is unchanged, the inert exclusion cost nothing');
    assert.deepEqual(shows({ n1: store.n1 }, ...YEAR), ['2026-01-07']);
    assert.equal(store.n1.content, 'Swim');

    // Deleting a date the series never had is a no-op for the visible days.
    const d = applyOccurrenceWrites({ m1: m }, planOccurrenceDelete(m, '2026-01-07', 'one', opts()));
    assert.deepEqual(shows(d, ...YEAR), ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);

    // A split at a between-days date still cuts cleanly on both sides.
    const fol = applyOccurrenceWrites({ m1: m }, planOccurrenceEdit(m, '2026-01-14', 'following', { content: 'Swim' }, opts()));
    assert.deepEqual(shows({ m1: fol.m1 }, ...YEAR), ['2026-01-05', '2026-01-12']);
    // Two Mondays were spent before the cut, so the tail carries the other two,
    // now landing on Wednesdays because that is the day it was cut on.
    assert.deepEqual(shows({ n1: fol.n1 }, ...YEAR), ['2026-01-14', '2026-01-21'],
      'the tail re-anchors onto the day that was asked for');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 17. A PATCH CARRIES CONTENT, NEVER IDENTITY OR ANCHOR ---');
  {
    // Several call sites build a patch by spreading a whole EXPANDED record,
    // whose id is "<master>::<date>". Written through, the record is filed under
    // a key it does not match, records with "::" are dropped on the next load,
    // and the item silently vanishes on reload.
    const m = ev({ recur: weekly({ count: 4 }) });
    const poisoned = {
      id: makeOccId('m1', '2026-01-19'),
      masterId: 'm1',
      occDate: '2026-01-19',
      weekKey: '1999-01-03',
      dayIndex: 6,
      content: 'Swim',
    } as Partial<Ev>;

    const one = planOccurrenceEdit(m, '2026-01-19', 'one', poisoned, opts());
    const det = put(one, 'detached');
    assert.equal(det.id, 'n1');
    assert.ok(!det.id.includes('::'));
    assert.equal(det.masterId, undefined);
    assert.equal(det.occDate, undefined);
    assert.equal(det.weekKey, '2026-01-18', 'the anchor comes from the chosen date, not the patch');
    assert.equal(det.dayIndex, 1);
    assert.equal(det.content, 'Swim', 'the actual content still lands');

    const all = planOccurrenceEdit(m, '2026-01-19', 'all', poisoned, opts());
    assert.equal(put(all, 'master').id, 'm1');
    assert.equal(put(all, 'master').weekKey, '2026-01-04');
    assert.deepEqual(shows(applyOccurrenceWrites({ m1: m }, all), ...YEAR),
      ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);

    const fol = planOccurrenceEdit(m, '2026-01-19', 'following', poisoned, opts());
    assert.equal(put(fol, 'newMaster').id, 'n1');
    assert.equal(put(fol, 'newMaster').weekKey, '2026-01-18');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 18. THE STORE IS NEVER MUTATED ---');
  {
    // Merge decisions are derived from state, never by mutating it mid-flight.
    // A plan that edited its own input would make the second peer to apply it
    // reach a different answer from the first.
    const m = ev({ recur: weekly({ count: 4 }), exdates: ['2026-01-12'] });
    const before = JSON.stringify(m);
    const store = { m1: m };
    const plans = [
      planOccurrenceEdit(m, '2026-01-19', 'one', { content: 'X' }, opts()),
      planOccurrenceEdit(m, '2026-01-19', 'following', { content: 'X' }, opts()),
      planOccurrenceEdit(m, '2026-01-19', 'all', { content: 'X' }, opts()),
      planOccurrenceDelete(m, '2026-01-19', 'one', opts()),
      planOccurrenceDelete(m, '2026-01-19', 'following', opts()),
      planOccurrenceDelete(m, '2026-01-19', 'all', opts()),
    ];
    for (const plan of plans) {
      applyOccurrenceWrites(store, plan);
      assert.equal(JSON.stringify(m), before, 'the master was not touched');
      assert.deepEqual(Object.keys(store), ['m1'], 'the store was not touched');
    }
    // Exdate arrays in particular are copied, never pushed onto.
    const p = planOccurrenceEdit(m, '2026-01-19', 'one', {}, opts());
    assert.deepEqual(m.exdates, ['2026-01-12']);
    assert.deepEqual(put(p, 'master').exdates, ['2026-01-12', '2026-01-19']);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 19. THE WORDING SAYS WHAT HAPPENS, IN PLAIN SENTENCES ---');
  {
    for (const action of ['edit', 'delete'] as const) {
      const choices = scopeChoices(action);
      assert.deepEqual(choices.map(c => c.scope), ['one', 'following', 'all']);
      assert.deepEqual(choices.map(c => c.label),
        ['Only this one', 'This and everything after', 'The whole series']);
      for (const c of choices) {
        assert.ok(c.hint.length > 10, 'every choice explains itself');
        // The house rule: no em dashes and no en dashes anywhere a user can read.
        for (const text of [c.label, c.hint]) {
          assert.ok(!text.includes('—'), `no em dash in "${text}"`);
          assert.ok(!text.includes('–'), `no en dash in "${text}"`);
          // And no data-model words either. "EXDATE" is not a promise anyone can check.
          assert.ok(!/exdate|master|recur|occurrence|rrule/i.test(text), `no jargon in "${text}"`);
        }
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 20. PARITY WITH THE PC, RUN SIDE BY SIDE ---');
  {
    // The PC is the authority. Every case below runs `editSeries` /
    // `deleteScoped` from `recurrence.ts` on the same input and compares the
    // resulting STORES, because a phone that means something different by "only
    // this one" diverges from the desk permanently.
    const strip = (store: Record<string, Ev>): unknown =>
      Object.values(store)
        .map(r => ({ ...r, id: r.id === 'm1' ? 'm1' : 'NEW', updatedAt: 0 }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const fixtures: Ev[] = [
      ev({ recur: weekly({ count: 4 }) }),
      ev({ recur: weekly({ until: '2026-02-02' }) }),
      ev({ recur: weekly() }),
      ev({ recur: weekly({ count: 6 }), exdates: ['2026-01-12'] }),
      ev({ recur: { freq: 'daily', interval: 1, end: { count: 5 } } }),
      ev({ recur: { freq: 'daily', interval: 2, end: { count: 5 } } }),
      ev({ recur: { freq: 'weekly', interval: 1, byWeekday: [1, 3], end: { count: 6 } } }),
      ev({ recur: { freq: 'monthly', interval: 1, end: { count: 4 } } }),
      ev({ recur: { freq: 'yearly', interval: 1, end: { count: 3 } } }),
      ev({ recur: weekly({ count: 4 }), locked: true }),
      ev({ recur: weekly({ count: 4 }), gCalId: 'g-abc', gCalCalendarId: 'daily' }),
      ev({ recur: undefined }),
    ];

    let compared = 0;
    for (const m of fixtures) {
      const days = shows({ m1: m }, '2026-01-01', '2033-01-01');
      const probe = days.length ? [days[0], days[Math.floor(days.length / 2)], days[days.length - 1]] : [MON];

      for (const at of probe) {
        const viewedWeekKey = weekKeyOf(parseDate(at), 0);
        const occId = m.recur ? makeOccId('m1', at) : 'm1';

        // EDIT. The PC has no 'following' for an edit, so the comparable scopes
        // are the two it does have: unlocked detach, and locked/whole-series.
        const pcEdit = editSeries<Ev>({ m1: m }, occId, { content: 'Swim' }, viewedWeekKey, 0);
        const mine = planOccurrenceEdit(m, m.recur ? at : null, m.locked ? 'all' : 'one', { content: 'Swim' }, opts());
        assert.deepEqual(strip(applyOccurrenceWrites({ m1: m }, mine)), strip(pcEdit.events),
          `edit parity at ${at} for ${JSON.stringify(m.recur)}`);
        // The PC re-anchors selection onto the same record this plan targets.
        const pcTarget = pcEdit.targetId === 'm1' || pcEdit.targetId.startsWith('m1::') ? 'm1' : 'NEW';
        const myTarget = mine.targetId === 'm1' ? 'm1' : 'NEW';
        assert.equal(myTarget, pcTarget, `edit target parity at ${at}`);

        // DELETE, all three scopes, which the PC does offer.
        for (const mode of ['one', 'following', 'all'] as const) {
          const pc = deleteScoped<Ev>({ m1: m }, occId, mode);
          const plan = planOccurrenceDelete(m, m.recur ? at : null, mode, opts());
          assert.deepEqual(strip(applyOccurrenceWrites({ m1: m }, plan)), strip(pc),
            `delete '${mode}' parity at ${at} for ${JSON.stringify(m.recur)}`);
          compared += 1;
        }
        compared += 1;
      }
    }
    assert.ok(compared > 100, `enough side-by-side comparisons ran (${compared})`);
    console.log(`    ${compared} plans compared against the PC's own code`);
  }

  console.log('\nALL PASS (20 sections)');
}

main();
