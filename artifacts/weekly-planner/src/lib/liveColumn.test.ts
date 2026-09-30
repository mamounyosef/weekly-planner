// Tests for WHERE the live line goes and when "Go to Live" is needed.
//
// The bug: "not on screen" was the integer -1, and the custom view addresses
// the days before its anchor as -3, -2, -1. On any custom range that did not
// contain today, the day right before the anchor matched the sentinel and drew
// "now" on itself, on every future week. That fake line also made Go to Live
// (and its S shortcut) scroll to it instead of travelling to today, and hid
// the pill. A second bug hid the pill while the real line sat under the sticky
// day headers. These tests pin both, plus every edge the helpers touch.
//
// Run with: npx tsx src/lib/liveColumn.test.ts

import assert from 'node:assert/strict';
import { liveColumnOffset, liveColumnDate, calendarDayDiff, liveLineVisible } from './liveScroll';

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const week = range(0, 7);

async function main() {
  console.log('--- 1. THE REPORTED BUG: A CUSTOM RANGE WITHOUT TODAY HAS NO LIVE COLUMN ---');
  {
    const now = d(2026, 9, 27, 12, 57); // Sunday
    // Custom, anchored to a day, 3 before and 3 after: Oct 8..14 around Sun Oct 11.
    for (const anchor of [d(2026, 10, 11), d(2026, 10, 18), d(2026, 10, 4), d(2026, 12, 27)]) {
      const got = liveColumnOffset({ now, weekStart: anchor, visibleCols: range(-3, 4), dayStartH: 0 });
      assert.equal(got, null, `anchor ${anchor.toDateString()}: no column holds now`);
      assert.notEqual(got, -1, 'never the -1 sentinel, which is a real column here');
    }
    console.log('  ok');
  }

  console.log('--- 2. TODAY IS FOUND IN EVERY POSITION OF A WIDE CUSTOM RANGE ---');
  {
    const cols = range(-7, 15);
    const weekStart = d(2026, 9, 27);
    for (const off of cols) {
      const now = d(2026, 9, 27 + off, 13, 0);
      assert.equal(liveColumnOffset({ now, weekStart, visibleCols: cols, dayStartH: 0 }), off, `offset ${off}`);
    }
    // Specifically the offsets that collided with the old sentinel.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 26, 9), weekStart, visibleCols: cols, dayStartH: 0 }), -1);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 27, 9), weekStart, visibleCols: cols, dayStartH: 0 }), 0);
    console.log('  ok');
  }

  console.log('--- 3. A DAY JUST OUTSIDE THE PAINTED COLUMNS IS NULL ON BOTH SIDES ---');
  {
    const weekStart = d(2026, 9, 27);
    const cols = range(-3, 4);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 23, 12), weekStart, visibleCols: cols, dayStartH: 0 }), null);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 24, 12), weekStart, visibleCols: cols, dayStartH: 0 }), -3);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 30, 12), weekStart, visibleCols: cols, dayStartH: 0 }), 3);
    assert.equal(liveColumnOffset({ now: d(2026, 10, 1, 12), weekStart, visibleCols: cols, dayStartH: 0 }), null);
    console.log('  ok');
  }

  console.log('--- 4. WEEK AND DAY VIEWS ---');
  {
    const weekStart = d(2026, 9, 27);
    // Week view: every day of the week, and nothing from next/previous week.
    for (let i = 0; i < 7; i++) {
      assert.equal(liveColumnOffset({ now: d(2026, 9, 27 + i, 10), weekStart, visibleCols: week, dayStartH: 0 }), i);
    }
    assert.equal(liveColumnOffset({ now: d(2026, 10, 4, 10), weekStart, visibleCols: week, dayStartH: 0 }), null);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 26, 10), weekStart, visibleCols: week, dayStartH: 0 }), null);
    // Day view paints one column: only that day.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 29, 10), weekStart, visibleCols: [2], dayStartH: 0 }), 2);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 29, 10), weekStart, visibleCols: [3], dayStartH: 0 }), null);
    // Nothing painted at all.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 29, 10), weekStart, visibleCols: [], dayStartH: 0 }), null);
    console.log('  ok');
  }

  console.log('--- 5. BEFORE THE DAY-START HOUR, NOW BELONGS TO YESTERDAY ---');
  {
    const weekStart = d(2026, 9, 27);
    // 5:30am with a 7am day start -> Monday's 5:30am is still Sunday's column.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 28, 5, 30), weekStart, visibleCols: week, dayStartH: 7 }), 0);
    // Exactly at the day start it is today's column.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 28, 7, 0), weekStart, visibleCols: week, dayStartH: 7 }), 1);
    // One minute before: still yesterday.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 28, 6, 59), weekStart, visibleCols: week, dayStartH: 7 }), 0);
    // Sunday 3am with a 4am start is SATURDAY: previous week, so off screen in week view...
    assert.equal(liveColumnOffset({ now: d(2026, 9, 27, 3), weekStart, visibleCols: week, dayStartH: 4 }), null);
    // ...but the -1 column in a custom range, which is exactly the case the sentinel broke.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 27, 3), weekStart, visibleCols: range(-3, 4), dayStartH: 4 }), -1);
    // Midnight start: never shifts.
    assert.equal(liveColumnOffset({ now: d(2026, 9, 28, 0, 0), weekStart, visibleCols: week, dayStartH: 0 }), 1);
    console.log('  ok');
  }

  console.log('--- 6. liveColumnDate: WHERE GO TO LIVE LANDS ---');
  {
    assert.deepEqual(liveColumnDate(d(2026, 9, 27, 12, 57), 0), d(2026, 9, 27));
    assert.deepEqual(liveColumnDate(d(2026, 9, 27, 3, 0), 4), d(2026, 9, 26));
    assert.deepEqual(liveColumnDate(d(2026, 9, 27, 4, 0), 4), d(2026, 9, 27));
    // Crosses a month and a year boundary.
    assert.deepEqual(liveColumnDate(d(2026, 10, 1, 1, 0), 6), d(2026, 9, 30));
    assert.deepEqual(liveColumnDate(d(2027, 1, 1, 1, 0), 6), d(2026, 12, 31));
    // A broken day-start setting behaves like midnight rather than throwing.
    assert.deepEqual(liveColumnDate(d(2026, 9, 27, 1, 0), Number.NaN), d(2026, 9, 27));
    // Never mutates its input.
    const input = d(2026, 9, 27, 3, 0);
    const before = input.getTime();
    liveColumnDate(input, 4);
    assert.equal(input.getTime(), before);
    console.log('  ok');
  }

  console.log('--- 7. calendarDayDiff COUNTS DATES, NOT 24-HOUR PERIODS ---');
  {
    assert.equal(calendarDayDiff(d(2026, 9, 27, 23, 59), d(2026, 9, 27, 0, 0)), 0);
    assert.equal(calendarDayDiff(d(2026, 9, 28, 0, 1), d(2026, 9, 27, 23, 59)), 1);
    assert.equal(calendarDayDiff(d(2026, 9, 24), d(2026, 9, 27)), -3);
    assert.equal(calendarDayDiff(d(2027, 1, 1), d(2026, 12, 31)), 1);
    assert.equal(calendarDayDiff(d(2028, 3, 1), d(2028, 2, 28)), 2, 'leap year');
    // Every day of a whole year in a row: including any DST change of the
    // machine running the tests, the count stays exactly 1 per date.
    let prev = d(2026, 1, 1, 12);
    for (let i = 1; i <= 366; i++) {
      const next = d(2026, 1, 1 + i, 12);
      assert.equal(calendarDayDiff(next, prev), 1, `step ${i}`);
      prev = next;
    }
    console.log('  ok');
  }

  console.log('--- 8. INVALID DATES NEVER PRODUCE A COLUMN ---');
  {
    const bad = new Date(Number.NaN);
    assert.equal(liveColumnOffset({ now: bad, weekStart: d(2026, 9, 27), visibleCols: week, dayStartH: 0 }), null);
    assert.equal(liveColumnOffset({ now: d(2026, 9, 27), weekStart: bad, visibleCols: week, dayStartH: 0 }), null);
    console.log('  ok');
  }

  console.log('--- 9. liveLineVisible: THE STICKY HEADERS HIDE THE LINE ---');
  {
    const base = { scrollerTop: 95, scrollerBottom: 900, occluderBottoms: [157, 205, 250] };
    // Inside the scroller but under the sticky bands: NOT visible (the old bug).
    assert.equal(liveLineVisible({ ...base, lineTop: 133 }), false);
    assert.equal(liveLineVisible({ ...base, lineTop: 249 }), false);
    // Right at the lowest band's bottom edge and below: visible.
    assert.equal(liveLineVisible({ ...base, lineTop: 250 }), true);
    assert.equal(liveLineVisible({ ...base, lineTop: 600 }), true);
    assert.equal(liveLineVisible({ ...base, lineTop: 900 }), true);
    // Past the bottom, or above the scroller entirely.
    assert.equal(liveLineVisible({ ...base, lineTop: 901 }), false);
    assert.equal(liveLineVisible({ ...base, lineTop: -500 }), false);
    console.log('  ok');
  }

  console.log('--- 10. liveLineVisible: EDGES ---');
  {
    // Bands scrolled away above the scroller (not sticky) do not raise the bound.
    assert.equal(liveLineVisible({ lineTop: 100, scrollerTop: 95, scrollerBottom: 900, occluderBottoms: [-300, 20] }), true);
    // No bands at all.
    assert.equal(liveLineVisible({ lineTop: 95, scrollerTop: 95, scrollerBottom: 900, occluderBottoms: [] }), true);
    // Bottom inset (phone tab bar) hides the last strip.
    assert.equal(liveLineVisible({ lineTop: 850, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [], bottomInset: 90 }), false);
    assert.equal(liveLineVisible({ lineTop: 810, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [], bottomInset: 90 }), true);
    // Broken numbers: a NaN band is ignored; a NaN line or scroller is "not visible".
    assert.equal(liveLineVisible({ lineTop: 300, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [Number.NaN] }), true);
    assert.equal(liveLineVisible({ lineTop: Number.NaN, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [] }), false);
    assert.equal(liveLineVisible({ lineTop: 300, scrollerTop: Number.NaN, scrollerBottom: 900, occluderBottoms: [] }), false);
    // Negative or NaN inset is ignored rather than extending past the scroller.
    assert.equal(liveLineVisible({ lineTop: 950, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [], bottomInset: -100 }), false);
    assert.equal(liveLineVisible({ lineTop: 899, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [], bottomInset: Number.NaN }), true);
    // Bands covering the whole scroller: nothing is visible.
    assert.equal(liveLineVisible({ lineTop: 500, scrollerTop: 0, scrollerBottom: 900, occluderBottoms: [950] }), false);
    console.log('  ok');
  }

  console.log('\nAll liveColumn tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
