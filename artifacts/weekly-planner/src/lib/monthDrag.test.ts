// Tests the month view's drag-to-create and its spanning bands.
//
// THE TWO THAT MATTER:
//
//   Sweeping backwards must create the same event as sweeping forwards. If it
//   does not, half of every user's drags silently produce a one day event on the
//   wrong day, and there is nothing on screen to say so.
//
//   No two overlapping bands may share a lane. Same failure as the day grid's
//   columns: the second event is drawn exactly on top of the first and is simply
//   invisible. You find out you missed it afterwards.
//
// Run with: npx tsx src/lib/monthDrag.test.ts

import assert from 'node:assert/strict';
import { monthGrid } from './grid';
import {
  bandForWeek,
  bandsForSpan,
  cellAt,
  dateAt,
  dateAtPoint,
  daysBetween,
  describeSpan,
  isDate,
  layoutSpans,
  shiftDate,
  spanBetween,
  spanContains,
  spanLength,
  spansForRange,
  spansOverlap,
  type SpanItem,
} from './monthDrag';

/** A deterministic random source, so a failing property test is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

const span = (id: string, startDate: string, endDate: string): SpanItem => ({ id, startDate, endDate });

/** Every pair of items that genuinely covers a common day. */
function overlappingPairs(items: SpanItem[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (spansOverlap(items[i], items[j])) out.push([items[i].id, items[j].id]);
    }
  }
  return out;
}

function main() {
  console.log('--- 1. DATE ARITHMETIC SURVIVES EVERY BOUNDARY ---');
  {
    assert.equal(shiftDate('2026-08-03', 4), '2026-08-07');
    assert.equal(shiftDate('2026-08-03', 0), '2026-08-03');
    assert.equal(shiftDate('2026-08-03', -4), '2026-07-30', 'backwards over a month edge');
    assert.equal(shiftDate('2026-08-31', 1), '2026-09-01', 'month boundary');
    assert.equal(shiftDate('2026-12-31', 1), '2027-01-01', 'year boundary');
    assert.equal(shiftDate('2027-01-01', -1), '2026-12-31', 'and back again');

    // February, both kinds.
    assert.equal(shiftDate('2028-02-28', 1), '2028-02-29', '2028 is a leap year');
    assert.equal(shiftDate('2028-02-29', 1), '2028-03-01');
    assert.equal(shiftDate('2027-02-28', 1), '2027-03-01', '2027 is not');
    assert.equal(shiftDate('2100-02-28', 1), '2100-03-01', 'and neither is 2100');
    assert.equal(shiftDate('2000-02-28', 1), '2000-02-29', 'but 2000 is');

    // Long hauls, in both directions.
    assert.equal(shiftDate('2026-01-01', 365), '2027-01-01');
    assert.equal(shiftDate('2028-01-01', 366), '2029-01-01', 'a leap year is 366');

    assert.equal(daysBetween('2026-08-03', '2026-08-03'), 1, 'one day, counting both ends');
    assert.equal(daysBetween('2026-08-03', '2026-08-07'), 5);
    assert.equal(daysBetween('2026-08-30', '2026-09-02'), 4, 'across a month');
    assert.equal(daysBetween('2026-12-30', '2027-01-02'), 4, 'across a year');
    assert.equal(daysBetween('2028-02-01', '2028-03-01'), 30, 'leap February');
    assert.equal(daysBetween('2027-02-01', '2027-03-01'), 29, 'ordinary February');
    assert.equal(daysBetween('2026-01-01', '2026-12-31'), 365, 'a whole year');
    assert.equal(daysBetween('2028-01-01', '2028-12-31'), 366, 'a whole leap year');

    assert.ok(isDate('2026-08-03'));
    for (const junk of ['2026-8-3', '', 'today', '2026-08-03T00:00', null, undefined, 5]) {
      assert.equal(isDate(junk as unknown), false, `${String(junk)} is not a date`);
    }
  }

  console.log('--- 2. HIT TESTING, INCLUDING THE EDGES AND THE OUTSIDE ---');
  {
    // 350 wide, 420 tall: cells are exactly 50 by 70.
    const m = { width: 350, height: 420, rows: 6, cols: 7 };

    assert.deepEqual(cellAt(0, 0, m), { row: 0, col: 0 }, 'the very first pixel');
    assert.deepEqual(cellAt(49.9, 69.9, m), { row: 0, col: 0 }, 'just inside the first cell');

    // A boundary belongs to the cell it STARTS, never the one it ends.
    assert.deepEqual(cellAt(50, 0, m), { row: 0, col: 1 }, 'exactly on a column edge');
    assert.deepEqual(cellAt(0, 70, m), { row: 1, col: 0 }, 'exactly on a row edge');
    assert.deepEqual(cellAt(150, 210, m), { row: 3, col: 3 }, 'exactly on an interior corner');

    // Every column and row lands where it should, at its start, middle and end.
    for (let c = 0; c < 7; c += 1) {
      assert.equal(cellAt(c * 50, 5, m).col, c, `col ${c} at its left edge`);
      assert.equal(cellAt(c * 50 + 25, 5, m).col, c, `col ${c} in the middle`);
      assert.equal(cellAt(c * 50 + 49.99, 5, m).col, c, `col ${c} at its right edge`);
    }
    for (let r = 0; r < 6; r += 1) {
      assert.equal(cellAt(5, r * 70, m).row, r, `row ${r} at its top`);
      assert.equal(cellAt(5, r * 70 + 69.99, m).row, r, `row ${r} at its bottom`);
    }

    // Off all four sides, the nearest cell wins. The finger wanders constantly
    // while dragging and the band must not flicker away when it does.
    assert.deepEqual(cellAt(-1, 5, m), { row: 0, col: 0 }, 'off the left');
    assert.deepEqual(cellAt(-9999, -9999, m), { row: 0, col: 0 }, 'far off the top left');
    assert.deepEqual(cellAt(350, 5, m), { row: 0, col: 6 }, 'exactly on the right edge');
    assert.deepEqual(cellAt(9999, 5, m), { row: 0, col: 6 }, 'far off the right');
    assert.deepEqual(cellAt(5, -1, m), { row: 0, col: 0 }, 'off the top');
    assert.deepEqual(cellAt(5, 420, m), { row: 5, col: 0 }, 'exactly on the bottom edge');
    assert.deepEqual(cellAt(5, 9999, m), { row: 5, col: 0 }, 'far off the bottom');
    assert.deepEqual(cellAt(9999, 9999, m), { row: 5, col: 6 }, 'off the bottom right corner');

    // Degenerate metrics must not produce NaN, which would index nothing and
    // make the whole selection vanish.
    assert.deepEqual(cellAt(10, 10, { width: 0, height: 0 }), { row: 0, col: 0 });
    assert.deepEqual(cellAt(NaN, NaN, m), { row: 0, col: 0 });
    assert.deepEqual(cellAt(Infinity, Infinity, m), { row: 0, col: 0 }, 'infinity is not a position');
    assert.deepEqual(cellAt(10, 10, { width: 350, height: 420, rows: 0, cols: 0 }), { row: 0, col: 0 });

    // Defaults are the month grid's own shape.
    assert.deepEqual(cellAt(349, 419, { width: 350, height: 420 }), { row: 5, col: 6 });

    const { weeks } = monthGrid('2026-08-15', 0);
    assert.equal(dateAt(weeks, { row: 0, col: 0 }), weeks[0][0]);
    assert.equal(dateAt(weeks, { row: 5, col: 6 }), weeks[5][6]);
    assert.equal(dateAt(weeks, { row: 9, col: 0 }), null, 'a row that does not exist');
    assert.equal(dateAt(weeks, { row: 0, col: 9 }), null, 'a column that does not exist');
    assert.equal(dateAtPoint(9999, 9999, weeks, { width: 350, height: 420 }), weeks[5][6],
      'a finger off the corner still points at the last day');
  }

  console.log('--- 3. A SPAN IS THE SAME WHICHEVER WAY YOU DRAG IT ---');
  {
    const forwards = spanBetween('2026-08-03', '2026-08-07');
    const backwards = spanBetween('2026-08-07', '2026-08-03');
    assert.deepEqual(forwards, { startDate: '2026-08-03', endDate: '2026-08-07' });
    assert.deepEqual(backwards, forwards, 'dragging backwards selects the same days');

    assert.deepEqual(spanBetween('2026-08-03', '2026-08-03'),
      { startDate: '2026-08-03', endDate: '2026-08-03' });
    assert.equal(spanLength(spanBetween('2026-08-03', '2026-08-03')), 1,
      'a press and release on one cell is a one day event, not an error');

    // Across every boundary, in both directions.
    assert.deepEqual(spanBetween('2026-09-02', '2026-08-30'),
      { startDate: '2026-08-30', endDate: '2026-09-02' }, 'backwards over a month edge');
    assert.deepEqual(spanBetween('2027-01-02', '2026-12-30'),
      { startDate: '2026-12-30', endDate: '2027-01-02' }, 'backwards over a year edge');
    assert.equal(spanLength(spanBetween('2028-03-01', '2028-02-01')), 30, 'backwards over leap February');

    // Garbage on one side falls back to the other rather than producing a span
    // that reaches to the epoch.
    assert.deepEqual(spanBetween('nonsense', '2026-08-07'),
      { startDate: '2026-08-07', endDate: '2026-08-07' });
    assert.deepEqual(spanBetween('2026-08-07', 'nonsense'),
      { startDate: '2026-08-07', endDate: '2026-08-07' });

    const s = spanBetween('2026-08-03', '2026-08-07');
    assert.ok(spanContains(s, '2026-08-03'), 'the first day is inside');
    assert.ok(spanContains(s, '2026-08-07'), 'and so is the last');
    assert.ok(spanContains(s, '2026-08-05'));
    assert.equal(spanContains(s, '2026-08-02'), false);
    assert.equal(spanContains(s, '2026-08-08'), false);

    assert.ok(spansOverlap(s, spanBetween('2026-08-07', '2026-08-09')), 'touching on one day is an overlap');
    assert.equal(spansOverlap(s, spanBetween('2026-08-08', '2026-08-09')), false, 'adjacent is not');
  }

  console.log('--- 4. THE RANGE READS BACK AS PLAIN TEXT ---');
  {
    assert.equal(describeSpan({ startDate: '2026-08-03', endDate: '2026-08-07' }), 'Aug 3 to Aug 7, 5 days');
    assert.equal(describeSpan({ startDate: '2026-08-03', endDate: '2026-08-03' }), 'Aug 3, 1 day');
    assert.equal(describeSpan({ startDate: '2026-08-30', endDate: '2026-09-02' }), 'Aug 30 to Sep 2, 4 days');
    assert.equal(describeSpan({ startDate: '2026-12-30', endDate: '2027-01-02' }),
      'Dec 30 2026 to Jan 2 2027, 4 days', 'the year appears only when it is ambiguous without it');
    assert.equal(describeSpan({ startDate: '2028-02-28', endDate: '2028-02-29' }), 'Feb 28 to Feb 29, 2 days');
    assert.equal(describeSpan({ startDate: '2026-01-01', endDate: '2026-01-01' }), 'Jan 1, 1 day');

    // House rule: nothing the user reads may contain a dash of any kind.
    for (const text of [
      describeSpan({ startDate: '2026-08-03', endDate: '2026-08-07' }),
      describeSpan({ startDate: '2026-12-30', endDate: '2027-01-02' }),
      describeSpan({ startDate: '2026-08-03', endDate: '2026-08-03' }),
    ]) {
      assert.equal(/[—–-]/.test(text), false, `no dashes in "${text}"`);
    }
  }

  console.log('--- 5. A BAND IS ONE OBJECT, EVEN WHEN IT IS CUT IN TWO ---');
  {
    const week = ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'];

    assert.deepEqual(bandForWeek(week, { startDate: '2026-08-04', endDate: '2026-08-04' }),
      { startCol: 2, endCol: 2, startsHere: true, endsHere: true }, 'a single day is a rounded pill');

    assert.deepEqual(bandForWeek(week, { startDate: '2026-08-02', endDate: '2026-08-08' }),
      { startCol: 0, endCol: 6, startsHere: true, endsHere: true }, 'a whole week, rounded at both ends');

    // The one that looks wrong when it is wrong: Thursday to next Tuesday.
    const crossing = { startDate: '2026-08-06', endDate: '2026-08-11' };
    assert.deepEqual(bandForWeek(week, crossing),
      { startCol: 4, endCol: 6, startsHere: true, endsHere: false },
      'the first row is rounded on the left and cut square on the right');
    const next = ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
    assert.deepEqual(bandForWeek(next, crossing),
      { startCol: 0, endCol: 2, startsHere: false, endsHere: true },
      'and the second is cut square on the left and rounded on the right');

    // A week entirely inside a long span has no rounded end at all.
    const long = { startDate: '2026-07-20', endDate: '2026-09-20' };
    assert.deepEqual(bandForWeek(week, long),
      { startCol: 0, endCol: 6, startsHere: false, endsHere: false }, 'a pass-through week is square at both ends');

    // Misses, on both sides and by exactly one day.
    assert.equal(bandForWeek(week, { startDate: '2026-08-09', endDate: '2026-08-12' }), null, 'entirely after');
    assert.equal(bandForWeek(week, { startDate: '2026-07-20', endDate: '2026-08-01' }), null, 'entirely before');
    assert.equal(bandForWeek([], { startDate: '2026-08-03', endDate: '2026-08-04' }), null, 'no week, no band');
    assert.notEqual(bandForWeek(week, { startDate: '2026-08-08', endDate: '2026-08-20' }), null,
      'starting on the very last day still draws');
    assert.notEqual(bandForWeek(week, { startDate: '2026-07-01', endDate: '2026-08-02' }), null,
      'ending on the very first day still draws');
  }

  console.log('--- 6. BANDS ACROSS A WHOLE GRID ---');
  {
    const { weeks } = monthGrid('2026-08-15', 0);

    // One day: exactly one band, rounded both ends.
    const one = bandsForSpan(weeks, { startDate: '2026-08-15', endDate: '2026-08-15' });
    assert.equal(one.length, 1);
    assert.ok(one[0].startsHere && one[0].endsHere);
    assert.equal(one[0].endCol, one[0].startCol);

    // Crossing a week boundary: exactly two bands, and exactly one rounded end
    // each. Anything else and it reads as two unrelated events.
    const two = bandsForSpan(weeks, { startDate: '2026-08-06', endDate: '2026-08-11' });
    assert.equal(two.length, 2, 'two rows, two bands');
    assert.equal(two[1].weekIndex, two[0].weekIndex + 1, 'and they are consecutive rows');
    assert.equal(two.filter(b => b.startsHere).length, 1, 'only one real start');
    assert.equal(two.filter(b => b.endsHere).length, 1, 'only one real end');

    // The whole six week grid: six full width bands, and no rounded ends at all
    // when the span reaches past both edges.
    const all = bandsForSpan(weeks, { startDate: weeks[0][0], endDate: weeks[5][6] });
    assert.equal(all.length, 6, 'a band on every row');
    for (const b of all) {
      assert.equal(b.startCol, 0);
      assert.equal(b.endCol, 6);
    }
    assert.deepEqual([all[0].startsHere, all[5].endsHere], [true, true], 'rounded only at the very ends');
    assert.equal(all[0].endsHere, false);
    assert.equal(all[5].startsHere, false);
    for (let i = 1; i < 5; i += 1) {
      assert.equal(all[i].startsHere, false, `row ${i} is square on the left`);
      assert.equal(all[i].endsHere, false, `row ${i} is square on the right`);
    }

    const beyond = bandsForSpan(weeks, { startDate: '2020-01-01', endDate: '2030-01-01' });
    assert.equal(beyond.length, 6);
    assert.equal(beyond[0].startsHere, false, 'a span that starts before the grid is open on the left');
    assert.equal(beyond[5].endsHere, false, 'and open on the right when it runs past the end');

    // Every day of every band, put back together, is exactly the span clipped to
    // the grid. This is the real invariant: nothing is drawn twice and no day of
    // the range is left blank.
    for (const [from, to] of [
      ['2026-08-03', '2026-08-07'],   // inside one week
      ['2026-07-30', '2026-08-04'],   // across a month boundary
      ['2026-08-29', '2026-09-03'],   // across the other month boundary
      ['2026-08-01', '2026-08-31'],   // the whole month
      ['2026-08-06', '2026-08-11'],   // across a week boundary
    ] as [string, string][]) {
      const covered: string[] = [];
      for (const b of bandsForSpan(weeks, { startDate: from, endDate: to })) {
        for (let c = b.startCol; c <= b.endCol; c += 1) covered.push(weeks[b.weekIndex][c]);
      }
      const expected = weeks.flat().filter(d => d >= from && d <= to);
      assert.deepEqual(covered, expected, `${from} to ${to} is covered exactly once, in order`);
    }

    // A year boundary, on a December grid.
    const dec = monthGrid('2026-12-15', 1).weeks;
    const across = bandsForSpan(dec, { startDate: '2026-12-30', endDate: '2027-01-02' });
    const days = across.flatMap(b => dec[b.weekIndex].slice(b.startCol, b.endCol + 1));
    assert.deepEqual(days, ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
      'a new year is just another day boundary');

    // February, both kinds, with a span over the 28th.
    const leap = monthGrid('2028-02-10', 0).weeks;
    const leapDays = bandsForSpan(leap, { startDate: '2028-02-27', endDate: '2028-03-01' })
      .flatMap(b => leap[b.weekIndex].slice(b.startCol, b.endCol + 1));
    assert.deepEqual(leapDays, ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);

    const plain = monthGrid('2027-02-10', 0).weeks;
    const plainDays = bandsForSpan(plain, { startDate: '2027-02-27', endDate: '2027-03-01' })
      .flatMap(b => plain[b.weekIndex].slice(b.startCol, b.endCol + 1));
    assert.deepEqual(plainDays, ['2027-02-27', '2027-02-28', '2027-03-01'], 'no 29th to draw');
  }

  console.log('--- 7. EVERY FIRST DAY OF THE WEEK, 0 TO 6 ---');
  {
    // The grid can start on any weekday. A band must still cover exactly the
    // days of its span, in order, whichever column that puts them in.
    for (const weekStartsOn of [0, 1, 2, 3, 4, 5, 6]) {
      for (const anchor of ['2026-08-15', '2026-02-01', '2026-12-31', '2028-02-10', '2027-02-10']) {
        const { weeks } = monthGrid(anchor, weekStartsOn);
        const first = new Date(`${weeks[0][0]}T00:00:00`);
        assert.equal(first.getDay(), weekStartsOn, `${anchor} ws=${weekStartsOn}: grid starts right`);

        const from = weeks[1][3];
        const to = shiftDate(from, 9);
        const covered = bandsForSpan(weeks, { startDate: from, endDate: to })
          .flatMap(b => weeks[b.weekIndex].slice(b.startCol, b.endCol + 1));
        assert.deepEqual(covered, weeks.flat().filter(d => d >= from && d <= to),
          `ws=${weekStartsOn} ${anchor}: a ten day band covers exactly its days`);

        // A sweep from the first cell to the last covers all forty-two.
        const whole = bandsForSpan(weeks, spanBetween(weeks[5][6], weeks[0][0]));
        assert.equal(whole.reduce((n, b) => n + (b.endCol - b.startCol + 1), 0), 42,
          `ws=${weekStartsOn} ${anchor}: a backwards sweep of the whole grid covers every cell`);
      }
    }
  }

  console.log('--- 8. NOTHING IS EVER DRAWN ON TOP OF ANYTHING ---');
  {
    const { weeks } = monthGrid('2026-08-15', 0);

    const cases: SpanItem[][] = [
      [span('a', '2026-08-03', '2026-08-07'), span('b', '2026-08-03', '2026-08-07')],
      [span('a', '2026-08-03', '2026-08-05'), span('b', '2026-08-05', '2026-08-09')],
      [span('a', '2026-08-01', '2026-08-31'), span('b', '2026-08-10', '2026-08-11'), span('c', '2026-08-10', '2026-08-12')],
      [span('a', '2026-08-03', '2026-08-04'), span('b', '2026-08-05', '2026-08-06'), span('c', '2026-08-07', '2026-08-08')],
      [span('a', '2026-07-28', '2026-09-05'), span('b', '2026-08-06', '2026-08-11'), span('c', '2026-08-09', '2026-08-09')],
    ];

    for (const [n, items] of cases.entries()) {
      const { lanes, placements } = layoutSpans(items, weeks);
      for (const [x, y] of overlappingPairs(items)) {
        assert.notEqual(lanes[x], lanes[y], `case ${n}: ${x} and ${y} overlap and must not share a lane`);
      }
      for (const item of items) {
        assert.ok(placements.some(pl => pl.item.id === item.id), `case ${n}: ${item.id} was placed`);
      }
    }

    // Non-overlapping items DO share a lane, or a month of short events would
    // stack forty rows deep in cells fifty points tall.
    const tidy = layoutSpans(
      [span('a', '2026-08-03', '2026-08-04'), span('b', '2026-08-06', '2026-08-07')],
      weeks,
    );
    assert.equal(tidy.lanes.a, 0);
    assert.equal(tidy.lanes.b, 0, 'two events that never meet share the top lane');
    assert.equal(tidy.laneCount, 1);

    // One lane for the whole grid, so a band that crosses a week boundary does
    // not change height halfway down.
    const crossing = layoutSpans([span('a', '2026-08-06', '2026-08-11')], weeks);
    const rows = crossing.placements.filter(pl => pl.item.id === 'a');
    assert.equal(rows.length, 2, 'two rows');
    assert.equal(rows[0].lane, rows[1].lane, 'and the same lane on both');

    // Per-row lane counts, so a row with nothing in it is not padded for a band
    // that only appears three weeks later.
    const sparse = layoutSpans(
      [span('a', weeks[0][0], weeks[0][2]), span('b', weeks[0][0], weeks[0][3]), span('c', weeks[4][1], weeks[4][2])],
      weeks,
    );
    assert.equal(sparse.lanesPerWeek[0], 2, 'the first row needs two lanes');
    assert.equal(sparse.lanesPerWeek[2], 0, 'an empty row needs none');
    assert.equal(sparse.lanesPerWeek[4], 1);
  }

  console.log('--- 9. LANES ARE STABLE, WHATEVER ORDER THINGS ARRIVE IN ---');
  {
    // A band that jumps rows when an unrelated event is saved reads as the app
    // losing track of things, so the layout must depend on the dates and ids
    // alone and never on the order the store happened to enumerate.
    const { weeks } = monthGrid('2026-08-15', 0);
    const rand = rng(20260830);

    for (let trial = 0; trial < 200; trial += 1) {
      const items: SpanItem[] = [];
      const count = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < count; i += 1) {
        const start = shiftDate(weeks[0][0], Math.floor(rand() * 42));
        const length = Math.floor(rand() * 12);
        items.push(span(`i${i}`, start, shiftDate(start, length)));
      }

      const base = layoutSpans(items, weeks);

      // THE RULE.
      for (const [x, y] of overlappingPairs(items)) {
        assert.notEqual(base.lanes[x], base.lanes[y],
          `trial ${trial}: ${x} and ${y} overlap and share lane ${base.lanes[x]}`);
      }

      // Shuffle and expect an identical answer.
      const shuffled = items.slice();
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const again = layoutSpans(shuffled, weeks);
      assert.deepEqual(again.lanes, base.lanes, `trial ${trial}: lanes do not depend on input order`);
      assert.deepEqual(again.lanesPerWeek, base.lanesPerWeek);
      assert.equal(again.laneCount, base.laneCount);

      // And no lane is skipped, which would leave a visible empty row.
      const used = new Set(Object.values(base.lanes));
      for (let l = 0; l < base.laneCount; l += 1) {
        assert.ok(used.has(l), `trial ${trial}: lane ${l} is used rather than left as a gap`);
      }
    }
  }

  console.log('--- 10. DEGENERATE LAYOUT INPUT ---');
  {
    const { weeks } = monthGrid('2026-08-15', 0);
    assert.deepEqual(layoutSpans([], weeks).placements, [], 'nothing lays out as nothing');
    assert.deepEqual(layoutSpans([], weeks).lanesPerWeek, [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(layoutSpans([span('a', '2026-08-03', '2026-08-04')], []).placements, []);

    const junk = [
      span('backwards', '2026-08-07', '2026-08-03'),
      span('nodate', '', '2026-08-04'),
      span('ok', '2026-08-03', '2026-08-04'),
    ];
    const placed = layoutSpans(junk, weeks);
    assert.deepEqual(Object.keys(placed.lanes), ['ok'], 'broken records are dropped, not drawn wrong');

    // Something entirely off the grid takes no lane at all.
    const off = layoutSpans([span('far', '2020-01-01', '2020-01-05')], weeks);
    assert.deepEqual(off.placements, [], 'an item nowhere near the grid draws nothing');
  }

  console.log('--- 11. READING SPANS OUT OF THE PLANNER, IN ONE PASS ---');
  {
    const { weeks } = monthGrid('2026-08-15', 0);
    const from = weeks[0][0];
    const to = weeks[5][6];

    const events: Record<string, Record<string, unknown>> = {
      // A three day all-day event, Aug 3 to Aug 5.
      trip: { id: 'trip', weekKey: '2026-08-02', dayIndex: 1, daysSpan: 3, allDay: true, content: 'Trip' },
      // A one day all-day event.
      holiday: { id: 'holiday', weekKey: '2026-08-09', dayIndex: 2, daysSpan: 1, allDay: true, content: 'Holiday' },
      // A timed event: not a band.
      standup: { id: 'standup', weekKey: '2026-08-09', dayIndex: 1, startTime: '09:00', content: 'Standup' },
      // A timed event that nonetheless runs over two days: still a band.
      redeye: { id: 'redeye', weekKey: '2026-08-09', dayIndex: 4, daysSpan: 2, startTime: '23:00', content: 'Red eye' },
      // A tombstone.
      gone: { id: 'gone', weekKey: '2026-08-02', dayIndex: 0, daysSpan: 4, allDay: true, deleted: true },
      // Nowhere near this month.
      old: { id: 'old', weekKey: '2020-01-05', dayIndex: 0, daysSpan: 3, allDay: true, content: 'Old' },
      // No anchor at all.
      loose: { id: 'loose', daysSpan: 3, allDay: true, content: 'Loose' },
    };

    const { spans, covered } = spansForRange(events, from, to, 0);
    const ids = spans.map(s => s.id).sort();
    assert.deepEqual(ids, ['holiday', 'redeye', 'trip'],
      'all day and multi day items only; deleted, undated and out of range are out');

    const trip = spans.find(s => s.id === 'trip')!;
    assert.deepEqual([trip.startDate, trip.endDate], ['2026-08-03', '2026-08-05']);
    assert.equal(trip.title, 'Trip');
    assert.equal(trip.masterId, 'trip');
    assert.equal(trip.allDay, true);
    assert.equal(spans.find(s => s.id === 'redeye')!.allDay, false, 'a timed multi day item is still a band');

    assert.equal(covered['2026-08-03'], 1);
    assert.equal(covered['2026-08-05'], 1);
    assert.equal(covered['2026-08-06'], undefined, 'the day after is untouched');
    assert.equal(covered['2026-08-11'], 1, 'the one day holiday');

    // A repeat produces one span per occurrence, each carrying its own dates.
    const weekly = spansForRange({
      camp: {
        id: 'camp', weekKey: '2026-08-02', dayIndex: 1, daysSpan: 2, allDay: true, content: 'Camp',
        recur: { freq: 'weekly', interval: 1 },
      },
    }, from, to, 0);
    assert.ok(weekly.spans.length >= 4, 'a weekly repeat appears every week of the grid');
    for (const s of weekly.spans) {
      assert.equal(daysBetween(s.startDate, s.endDate), 2, 'each occurrence keeps its length');
      assert.equal(s.masterId, 'camp');
      assert.ok(s.id.startsWith('camp::'), 'and gets its own occurrence id');
    }
    const occIds = new Set(weekly.spans.map(s => s.id));
    assert.equal(occIds.size, weekly.spans.length, 'occurrence ids are unique, so lanes are too');

    // An item overlapping the edge of the grid still draws, clipped.
    const edge = spansForRange({
      long: { id: 'long', weekKey: '2026-07-19', dayIndex: 0, daysSpan: 60, allDay: true, content: 'Long' },
    }, from, to, 0);
    assert.equal(edge.spans.length, 1);
    assert.equal(edge.spans[0].startDate < from, true, 'the real start is kept so the end stays square');
    assert.equal(Object.keys(edge.covered).length, 42, 'and it covers the whole grid');

    // Degenerate input.
    assert.deepEqual(spansForRange(undefined, from, to, 0), { spans: [], covered: {} });
    assert.deepEqual(spansForRange({}, from, to, 0), { spans: [], covered: {} });
    assert.deepEqual(spansForRange(events, to, from, 0), { spans: [], covered: {} }, 'a backwards range is empty');
    assert.deepEqual(spansForRange(events, 'nonsense', to, 0), { spans: [], covered: {} });
    assert.deepEqual(
      spansForRange({ junk: null as unknown as Record<string, unknown> }, from, to, 0),
      { spans: [], covered: {} },
    );

    // The bands drawn for the store are laid out without collisions.
    const layout = layoutSpans(spans, weeks);
    for (const [x, y] of overlappingPairs(spans)) {
      assert.notEqual(layout.lanes[x], layout.lanes[y], `${x} and ${y} must not share a lane`);
    }
  }

  console.log('\nALL PASS (monthDrag: hit testing, span normalisation, bands, lanes, store reading)');
}

main();
