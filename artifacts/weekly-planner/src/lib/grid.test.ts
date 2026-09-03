// Tests the calendar grid's layout.
//
// THE ONE THAT MATTERS: no two overlapping blocks may share a column. When that
// breaks, one event is drawn exactly on top of another and is simply invisible —
// no error, no gap, nothing to notice. You find out you missed it afterwards,
// which is the worst possible way for a planner to fail.
//
// Run with: npx tsx src/lib/grid.test.ts

import assert from 'node:assert/strict';
import {
  blockEnd,
  hourMarks,
  layoutDay,
  monthGrid,
  yOf,
  prayerChipMode,
  shiftMonths,
  MIN_BLOCK_MINUTES,
  type Placeable,
} from './grid';

const at = (id: string, startH: number, endH: number | null): Placeable => ({
  id,
  startMin: Math.round(startH * 60),
  endMin: endH === null ? null : Math.round(endH * 60),
});

/** Every pair that genuinely overlaps in time. */
function overlappingPairs(items: Placeable[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.startMin < blockEnd(b) && b.startMin < blockEnd(a)) out.push([a.id, b.id]);
    }
  }
  return out;
}

function main() {
  console.log('--- 1. NOTHING IS EVER DRAWN ON TOP OF ANYTHING ---');
  {
    const cases: Placeable[][] = [
      [at('a', 9, 10), at('b', 9, 10)],
      [at('a', 9, 11), at('b', 10, 12), at('c', 11, 13)],
      [at('a', 9, 17), at('b', 10, 11), at('c', 10.5, 11.5), at('d', 14, 15)],
      [at('a', 9, 10), at('b', 10, 11), at('c', 11, 12)],
      [at('a', 8, 20), at('b', 9, 9.5), at('c', 9.25, 9.75), at('d', 9.5, 10)],
    ];

    for (const [n, items] of cases.entries()) {
      const placed = layoutDay(items, { pxPerHour: 60 });
      const byId = new Map(placed.map(pl => [pl.item.id, pl]));

      for (const [x, y] of overlappingPairs(items)) {
        assert.notEqual(byId.get(x)!.column, byId.get(y)!.column,
          `case ${n}: ${x} and ${y} overlap and must not share a column`);
      }
      assert.equal(placed.length, items.length, `case ${n}: everything was placed`);
    }
  }

  console.log('--- 2. SEPARATE RUNS EACH START FROM ONE COLUMN ---');
  {
    // Two events in the morning and two in the afternoon must not force the
    // whole day into four columns — the afternoon does not know about the
    // morning, so it gets the full width.
    const items = [at('a', 9, 10), at('b', 9, 10), at('c', 15, 16), at('d', 15, 16)];
    const placed = layoutDay(items, { pxPerHour: 60 });

    for (const id of ['a', 'b']) {
      assert.equal(placed.find(x => x.item.id === id)!.columns, 2, `${id} is in a 2-wide run`);
    }
    for (const id of ['c', 'd']) {
      assert.equal(placed.find(x => x.item.id === id)!.columns, 2, `${id} is in its own 2-wide run`);
    }
  }

  console.log('--- 3. A LONE EVENT TAKES THE WHOLE WIDTH ---');
  {
    const placed = layoutDay([at('a', 9, 10)], { pxPerHour: 60 });
    assert.equal(placed[0].column, 0);
    assert.equal(placed[0].columns, 1, 'One event, one column');
  }

  console.log('--- 4. POSITION AND HEIGHT ---');
  {
    const placed = layoutDay([at('a', 9, 10.5)], { pxPerHour: 60 });
    assert.equal(placed[0].top, 9 * 60, 'Nine in the morning, at sixty pixels an hour');
    assert.equal(placed[0].height, 90, 'and an hour and a half tall');

    const scaled = layoutDay([at('a', 9, 10)], { pxPerHour: 30 });
    assert.equal(scaled[0].top, 270, 'Halving the scale halves the offset');
    assert.equal(scaled[0].height, 30);

    // A grid that starts at 6am puts 6am at the top.
    const shifted = layoutDay([at('a', 9, 10)], { pxPerHour: 60, dayStartHour: 6 });
    assert.equal(shifted[0].top, 3 * 60, 'Measured from the grid\'s own start');
  }

  console.log('--- 5. A BLOCK IS NEVER TOO SHORT TO SEE ---');
  {
    const tiny = layoutDay([at('a', 9, 9 + 5 / 60)], { pxPerHour: 60 });
    assert.equal(tiny[0].height, MIN_BLOCK_MINUTES, 'A five-minute event is still readable');

    const open = layoutDay([at('a', 9, null)], { pxPerHour: 60 });
    assert.equal(open[0].height, MIN_BLOCK_MINUTES, 'and so is one with no end at all');

    // And that minimum counts as real length when deciding overlap, or a block
    // could be drawn over the one below it.
    const items = [at('a', 9, null), at('b', 9 + 10 / 60, 10)];
    const placed = layoutDay(items, { pxPerHour: 60 });
    assert.notEqual(placed[0].column, placed[1].column,
      'A minimum-height block still overlaps what it covers');
  }

  console.log('--- 6. THE SAME INPUT ALWAYS LAYS OUT THE SAME WAY ---');
  {
    // Stability matters more than tightness: a block that jumps sideways when an
    // unrelated event is edited reads as the app losing track of things.
    const items = [at('c', 9, 11), at('a', 9, 10), at('b', 9, 10), at('d', 10, 12)];
    const first = layoutDay(items, { pxPerHour: 60 });
    const shuffled = layoutDay([...items].reverse(), { pxPerHour: 60 });

    for (const pl of first) {
      const other = shuffled.find(x => x.item.id === pl.item.id)!;
      assert.equal(other.column, pl.column, `${pl.item.id} keeps its column whatever the order`);
      assert.equal(other.columns, pl.columns);
    }
  }

  console.log('--- 7. DEGENERATE INPUT ---');
  {
    assert.deepEqual(layoutDay([], { pxPerHour: 60 }), [], 'Nothing lays out as nothing');

    const junk = [
      { id: 'bad', startMin: NaN, endMin: 60 },
      { id: 'ok', startMin: 540, endMin: 600 },
    ] as Placeable[];
    const placed = layoutDay(junk, { pxPerHour: 60 });
    assert.equal(placed.length, 1, 'A block with no start is dropped, not drawn at the top');
    assert.equal(placed[0].item.id, 'ok');

    // An end before its start must not produce a negative height.
    const backwards = layoutDay([at('a', 10, 9)], { pxPerHour: 60 });
    assert.ok(backwards[0].height > 0, 'A backwards event still has a positive height');
  }

  console.log('--- 8. HOUR MARKS ---');
  {
    assert.deepEqual(hourMarks(0, 24).length, 25, 'Midnight to midnight, inclusive');
    assert.deepEqual(hourMarks(9, 12), [9, 10, 11, 12]);
    assert.deepEqual(hourMarks(23, 24), [23, 24]);
    assert.ok(hourMarks(20, 4).length >= 2, 'A nonsense range still yields something drawable');
    assert.equal(yOf(9 * 60, 60), 540);
    assert.equal(yOf(9 * 60, 60, 8), 60, 'measured from the grid start');
  }

  console.log('--- 9. THE MONTH GRID IS ALWAYS THE SAME SHAPE ---');
  {
    for (const anchor of ['2026-02-01', '2026-08-15', '2026-12-31', '2024-02-10']) {
      for (const weekStartsOn of [0, 1]) {
        const { weeks } = monthGrid(anchor, weekStartsOn);
        assert.equal(weeks.length, 6, `${anchor} ws=${weekStartsOn}: six rows, always`);
        for (const row of weeks) assert.equal(row.length, 7, 'seven days each');

        // The first cell is the right weekday, so the columns line up with their
        // headings whatever month is shown.
        const first = new Date(`${weeks[0][0]}T00:00:00`);
        assert.equal(first.getDay(), weekStartsOn,
          `${anchor} ws=${weekStartsOn}: the grid starts on the right weekday`);

        // Consecutive, with no gaps or repeats.
        const flat = weeks.flat();
        for (let i = 1; i < flat.length; i += 1) {
          const prev = new Date(`${flat[i - 1]}T00:00:00`);
          const cur = new Date(`${flat[i]}T00:00:00`);
          assert.equal(Math.round((cur.getTime() - prev.getTime()) / 86_400_000), 1,
            `${anchor}: ${flat[i - 1]} → ${flat[i]} is one day`);
        }
      }
    }

    // The month being shown is present, and the 1st is in the first two rows.
    const { weeks, month } = monthGrid('2026-08-15', 0);
    assert.equal(month, 7, 'August is month 7');
    assert.ok(weeks.flat().includes('2026-08-01'), 'and the 1st is on the grid');
    assert.ok(weeks.flat().includes('2026-08-31'), 'along with the last day');
  }

  console.log('--- 10. HOW MUCH OF A PRAYER MARKER FITS ---');
  {
    // The thresholds themselves, so a change to them fails here rather than in a
    // week view where the label is quietly clipped.
    assert.equal(prayerChipMode(400), 'full', 'a day column fits everything');
    assert.equal(prayerChipMode(132), 'full', 'exactly at the full threshold');
    assert.equal(prayerChipMode(131.9), 'name', 'just under it drops the time');
    assert.equal(prayerChipMode(78), 'name', 'exactly at the name threshold');
    assert.equal(prayerChipMode(77.9), 'dot', 'just under it drops the name');
    assert.equal(prayerChipMode(45), 'dot', 'a seven column week gets a ring');

    // It never throws and never returns anything else, whatever it is handed.
    for (const w of [0, -1, -1000, NaN, Infinity, -Infinity, 0.0001, 1e9]) {
      assert.ok(['full', 'name', 'dot'].includes(prayerChipMode(w)),
        `${w} gives a real mode`);
    }
    // An unmeasured column falls to the SMALLEST marker, not the largest.
    // Infinity is not a measurement any more than NaN is, and guessing "full"
    // for it would draw a label that does not fit the moment a real width
    // arrives, which is a flicker on every first paint.
    assert.equal(prayerChipMode(NaN), 'dot', 'an unmeasured column is not full');
    assert.equal(prayerChipMode(Infinity), 'dot', 'and neither is a nonsense one');

    // MONOTONIC. A wider column may never show LESS than a narrower one, which
    // is the property that stops a marker flickering between two modes while a
    // layout settles.
    const rank: Record<string, number> = { dot: 0, name: 1, full: 2 };
    let last = -1;
    for (let w = 0; w <= 400; w += 0.5) {
      const here = rank[prayerChipMode(w)];
      assert.ok(here >= last, `width ${w} does not go backwards`);
      last = here;
    }
  }


  console.log('--- 11. A MONTH AWAY IS STILL A REAL DATE ---');
  {
    // THE ONE THAT MATTERS. JavaScript turns 31 January plus one month into 3
    // March, so a swipe forward from the 31st skips February altogether. It goes
    // wrong on seven days of the year, which is why it ships.
    assert.equal(shiftMonths('2026-01-31', 1), '2026-02-28', 'clamped, not rolled over');
    assert.equal(shiftMonths('2028-01-31', 1), '2028-02-29', 'and a leap year has one more');
    assert.equal(shiftMonths('2026-03-31', -1), '2026-02-28', 'backwards too');
    assert.equal(shiftMonths('2026-05-31', 1), '2026-06-30', 'thirty day months as well');

    // The ordinary cases stay ordinary.
    assert.equal(shiftMonths('2026-08-15', 1), '2026-09-15');
    assert.equal(shiftMonths('2026-08-15', -1), '2026-07-15');
    assert.equal(shiftMonths('2026-08-15', 0), '2026-08-15', 'nowhere is where it started');

    // Year boundaries, in both directions and by whole years.
    assert.equal(shiftMonths('2026-12-15', 1), '2027-01-15');
    assert.equal(shiftMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(shiftMonths('2026-08-31', 12), '2027-08-31', 'a year is twelve months');
    assert.equal(shiftMonths('2028-02-29', 12), '2029-02-28', 'a leap day has no anniversary');
    assert.equal(shiftMonths('2026-08-31', -24), '2024-08-31');

    // Every month of a year, stepped one at a time, always lands in the month
    // it should and never skips one.
    for (const day of ['01', '15', '28', '29', '30', '31']) {
      let cursor = `2026-01-${day}`;
      if (Number(day) > 31) continue;
      for (let step = 1; step <= 12; step += 1) {
        const next = shiftMonths(`2026-01-${day}`, step);
        const month = Number(next.split('-')[1]);
        const expected = ((0 + step) % 12) + 1;
        assert.equal(month, expected, `${day} plus ${step} months lands in month ${expected}`);
      }
      void cursor;
    }

    // Stepping forward then back returns the same date, EXCEPT where clamping
    // legitimately lost a day. Asserted rather than assumed.
    assert.equal(shiftMonths(shiftMonths('2026-08-15', 1), -1), '2026-08-15');
    assert.equal(shiftMonths(shiftMonths('2026-01-31', 1), -1), '2026-01-28',
      'a clamp is not reversible, and pretending otherwise would be worse');

    // Rubbish in, the same date out, rather than a thrown error or "NaN-NaN-NaN".
    for (const bad of ['', 'not a date', '2026-13-40', 'x-y-z']) {
      const out = shiftMonths(bad, 1);
      assert.ok(!out.includes('NaN'), `${JSON.stringify(bad)} does not produce NaN`);
    }
    for (const months of [NaN, Infinity, -Infinity, 1.7]) {
      const out = shiftMonths('2026-08-15', months as number);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(out), `${months} still gives a date, got ${out}`);
    }
  }



  console.log('--- THE ONE CONSTANT THAT IS SUPPOSED TO DIFFER FROM THE PHONE ---');
  {
    // `grid.ts` is copied between the two machines like the rest of the shared
    // engine, EXCEPT for this: a readable block is however many pixels a title
    // needs, and a phone row is denser than a desktop one. The two values drifted
    // apart by accident once and nobody could say which was intended. Pinning it
    // here means a stray copy in either direction fails a test instead of quietly
    // changing how every short event on one of the two screens is drawn.
    assert.equal(MIN_BLOCK_MINUTES, 20, 'the PC draws nothing shorter than 20 minutes');

    // And it really is the floor, whatever it is handed.
    assert.equal(blockEnd({ id: 'z', startMin: 600, endMin: 600 }) - 600, MIN_BLOCK_MINUTES,
      'an item with no length at all');
    assert.equal(blockEnd({ id: 'b', startMin: 600, endMin: 540 }) - 600, MIN_BLOCK_MINUTES,
      'and one that ends before it starts');
    assert.equal(blockEnd({ id: 'o', startMin: 600, endMin: null }) - 600, MIN_BLOCK_MINUTES,
      'and one with no end at all');
    assert.equal(layoutDay([at('short', 10, 10 + 5 / 60)], { pxPerHour: 60 })[0].height, MIN_BLOCK_MINUTES,
      'a five-minute event is drawn at the floor, not at five');
  }

  console.log('\nALL PASS (grid: overlap columns, positions, month shape)');
}

main();
