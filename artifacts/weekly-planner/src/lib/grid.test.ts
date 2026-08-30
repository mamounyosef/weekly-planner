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

  console.log('\nALL PASS (grid: overlap columns, positions, month shape)');
}

main();
