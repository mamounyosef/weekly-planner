// Tests the custom view window and the follow-today rollover.
// Run with: npx tsx src/lib/customView.test.ts

import assert from 'node:assert/strict';
import { addDays, startOfWeek } from 'date-fns';
import { customWindow, followToday, dayKey } from './customView';

/** The dates a window shows, given the viewed date and week start day. */
function shownDates(viewed: Date, weekStartsOn: 0 | 1 | 6, anchor: 'day' | 'week', before: unknown, after: unknown): string[] {
  const ws = startOfWeek(viewed, { weekStartsOn });
  const idx = (viewed.getDay() - weekStartsOn + 7) % 7;
  return customWindow(anchor, before, after, idx).cols.map(o => dayKey(addDays(ws, o)));
}

// ── The reported case: Thu Oct 29 2026, 2 before / 3 after ─────────────────
const thu = new Date(2026, 9, 29, 9, 43);
assert.deepEqual(shownDates(thu, 0, 'day', 2, 3),
  ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
  'Today anchor: Tue 27 to Sun Nov 1');
// The bug: the view still pointing at Tue 27 gives Sun 25 to Fri 30.
assert.deepEqual(shownDates(new Date(2026, 9, 27), 0, 'day', 2, 3)[0], '2026-10-25');

// ── Day anchor: exact span for every before/after and every weekday/week start ─
for (const ws of [0, 1, 6] as const) {
  for (let d = 0; d < 21; d++) {
    const viewed = addDays(new Date(2026, 9, 18, 12), d);
    for (let b = 0; b <= 14; b++) {
      for (let a = 0; a <= 14; a++) {
        const got = shownDates(viewed, ws, 'day', b, a);
        assert.equal(got.length, b + a + 1);
        assert.equal(got[0], dayKey(addDays(viewed, -b)), `start ws=${ws} d=${d} b=${b} a=${a}`);
        assert.equal(got[got.length - 1], dayKey(addDays(viewed, a)), `end ws=${ws} d=${d} b=${b} a=${a}`);
        assert.ok(got.includes(dayKey(viewed)), 'the viewed day is always shown');
        assert.equal(new Set(got).size, got.length, 'no duplicate days');
      }
    }
  }
}

// Day anchor clamps: negatives to 0, above 14 to 14, junk to 0.
assert.deepEqual(customWindow('day', -5, -1, 3).cols, [3]);
assert.deepEqual(customWindow('day', 99, 99, 0).cols.length, 29);
assert.equal(customWindow('day', 99, 0, 0).before, 14);
for (const junk of [NaN, Infinity, -Infinity, undefined, null, '3', {}]) {
  assert.deepEqual(customWindow('day', junk, junk, 4).cols, [4], `junk ${String(junk)}`);
  assert.deepEqual(customWindow('week', junk, junk, 4).cols, [0, 1, 2, 3, 4, 5, 6], `junk week ${String(junk)}`);
}
// Fractions round; a bad column index falls back into 0..6.
assert.deepEqual(customWindow('day', 1.4, 0.6, 2).cols, [1, 2, 3]);
assert.deepEqual(customWindow('day', 0, 0, 9).cols, [6]);
assert.deepEqual(customWindow('day', 0, 0, NaN).cols, [0]);

// ── Week anchor ─────────────────────────────────────────────────────────────
assert.deepEqual(customWindow('week', 0, 0, 3).cols, [0, 1, 2, 3, 4, 5, 6]);
assert.deepEqual(customWindow('week', -2, 3, 3).cols, [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.deepEqual(customWindow('week', 2, -2, 0).cols, [2, 3, 4]);
assert.deepEqual(customWindow('week', 6, -6, 0).cols, [6], 'inverted collapses to start');
assert.deepEqual(customWindow('week', 14, -14, 0).cols, [14]);
assert.equal(customWindow('week', 20, -20, 0).before, 14);
for (let b = -14; b <= 14; b++) {
  for (let a = -14; a <= 14; a++) {
    for (let idx = 0; idx < 7; idx++) {
      const { cols } = customWindow('week', b, a, idx);
      assert.ok(cols.length >= 1);
      assert.equal(cols[0], b);
      for (let i = 1; i < cols.length; i++) assert.equal(cols[i], cols[i - 1] + 1);
      if (7 + a - b >= 1) assert.equal(cols.length, 7 + a - b);
    }
  }
}

// ── followToday ─────────────────────────────────────────────────────────────
const tue = new Date(2026, 9, 27, 23, 59);
const wed = new Date(2026, 9, 28, 0, 0);
// Same day: never moves.
assert.equal(followToday(tue, tue, new Date(2026, 9, 27, 8)), tue);
// Midnight while viewing today: follows.
assert.equal(dayKey(followToday(new Date(2026, 9, 27, 10), tue, wed)), '2026-10-28');
// Waking from hibernate two days later (the reported case): follows.
assert.equal(dayKey(followToday(new Date(2026, 9, 27), tue, thu)), '2026-10-29');
// The user had navigated elsewhere: kept.
const nav = new Date(2026, 10, 15);
assert.equal(followToday(nav, tue, wed), nav);
assert.equal(followToday(new Date(2026, 9, 28), tue, wed).getDate(), 28);
// Viewing "tomorrow" when the day turns: kept (it is now today anyway).
assert.equal(dayKey(followToday(new Date(2026, 9, 28, 5), tue, wed)), '2026-10-28');
// Clock going backwards (manual change / timezone): follows the new today too.
assert.equal(dayKey(followToday(wed, wed, tue)), '2026-10-27');
// Month and year boundaries.
assert.equal(dayKey(followToday(new Date(2026, 11, 31, 12), new Date(2026, 11, 31, 23), new Date(2027, 0, 1, 0, 5))), '2027-01-01');
assert.equal(dayKey(followToday(new Date(2026, 9, 31), new Date(2026, 9, 31), new Date(2026, 10, 1))), '2026-11-01');
// DST change day (Oct 25 2026 in Europe): day keys are calendar based.
assert.equal(dayKey(followToday(new Date(2026, 9, 25, 1), new Date(2026, 9, 25, 23), new Date(2026, 9, 26, 0, 1))), '2026-10-26');

console.log('customView tests passed');
