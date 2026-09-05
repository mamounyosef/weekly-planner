// Tests which hours the grid draws, and where a minute lands once some of them
// are missing.
//
// THE ONE THAT MATTERS: `minuteAtY` must be the exact inverse of `yOfMinute`
// for every visible minute. They are used by different things (one draws, the
// other reads a thumb), so a disagreement between them does not throw: a block
// dragged to 10:00 simply lands at 09:45, or at 06:00 when a hidden stretch sits
// between. The round trip is asserted rather than the arithmetic being trusted.
//
// THE OTHER ONE: hiding hours must never hide an ITEM. `itemsOutsideView` is the
// net, and a meeting at 3am with 3am switched off has to come back from it.
//
// Run with: npx tsx src/lib/dayWindows.test.ts

import assert from 'node:assert/strict';
import {
  FULL_DAY,
  clipSpan,
  describeRanges,
  drawnMinuteOf,
  hiddenHours,
  hourMarksIn,
  isFullDay,
  isMinuteVisible,
  itemsOutsideView,
  minuteAtY,
  normaliseRanges,
  rangesFromHidden,
  seamsIn,
  slotsIn,
  splitAcrossWindows,
  visibleMinutes,
  windowRanges,
  yOfMinute,
  type HourRange,
} from './dayWindows';

const r = (from: number, to: number): HourRange => ({ from, to });

/** The example that started this: everything except the middle of the night. */
const NIGHT_OFF = normaliseRanges([r(0, 2), r(6, 24)]);

function main() {
  console.log('--- 1. NORMALISING PUTS ANY INPUT INTO ONE CANONICAL SHAPE ---');
  {
    assert.deepEqual(normaliseRanges([r(0, 24)]), [r(0, 24)]);
    assert.deepEqual(normaliseRanges([r(9, 17)]), [r(9, 17)]);

    // Out of order, overlapping, and touching all come back as one stretch.
    assert.deepEqual(normaliseRanges([r(12, 18), r(9, 13)]), [r(9, 18)], 'overlap merges');
    assert.deepEqual(normaliseRanges([r(9, 12), r(12, 15)]), [r(9, 15)], 'touching merges');
    assert.deepEqual(normaliseRanges([r(18, 24), r(0, 6)]), [r(0, 6), r(18, 24)], 'sorted');
    assert.deepEqual(normaliseRanges([r(0, 24), r(9, 10)]), [r(0, 24)], 'contained is absorbed');

    // Anything that is not a range is dropped, not guessed at.
    assert.deepEqual(normaliseRanges([r(9, 9)]), FULL_DAY, 'an empty range is no range');
    assert.deepEqual(normaliseRanges([r(17, 9)]), FULL_DAY, 'backwards is no range');
    assert.deepEqual(normaliseRanges([]), FULL_DAY, 'nothing means the whole day');

    // A GRID WITH NO HOURS IS NOT A PREFERENCE, it is a blank screen with no way
    // back, so every degenerate input gives the whole day instead.
    const rubbish: unknown[] = [
      null, undefined, 0, 1, '', 'x', true, {}, [null], [undefined], [0], ['x'],
      [{}], [[]], [{ from: 'a', to: 'b' }], [{ from: NaN, to: 9 }],
      [{ from: 9, to: Infinity }], [{ from: -5, to: -1 }], [{ from: 25, to: 30 }],
      [{ from: 9 }], [{ to: 17 }], [{ from: null, to: null }],
    ];
    for (const raw of rubbish) {
      const out = normaliseRanges(raw);
      assert.ok(out.length > 0, `${JSON.stringify(raw)} still leaves a grid`);
      assert.ok(visibleMinutes(out) > 0, `${JSON.stringify(raw)} draws something`);
      for (const range of out) {
        assert.ok(range.from >= 0 && range.to <= 24 && range.from < range.to,
          `${JSON.stringify(raw)} gives a sane range`);
      }
    }

    // Idempotent, which is what stops the device rewriting storage forever.
    for (const raw of [[r(0, 2), r(6, 24)], [r(9, 17)], [r(1, 3), r(2, 5)], rubbish]) {
      const once = normaliseRanges(raw);
      assert.deepEqual(normaliseRanges(once), once, 'stable under a second pass');
    }

    // Fractions of an hour are floored rather than kept, since the strip the
    // user actually taps is a whole hour.
    assert.deepEqual(normaliseRanges([{ from: 9.7, to: 17.2 }]), [r(9, 17)]);
  }

  console.log('--- 2. HIDDEN HOURS AND RANGES ARE TWO VIEWS OF ONE THING ---');
  {
    assert.deepEqual(hiddenHours(FULL_DAY), [], 'nothing is hidden in a full day');
    assert.deepEqual(hiddenHours(NIGHT_OFF), [2, 3, 4, 5], 'the small hours');
    assert.deepEqual(rangesFromHidden([2, 3, 4, 5]), NIGHT_OFF, 'and back again');

    // The round trip holds for EVERY possible set of hidden hours that leaves
    // something behind. This is the property that lets the settings screen think
    // in hours while the grid thinks in ranges.
    for (let mask = 0; mask < (1 << 12); mask += 1) {
      const hidden: number[] = [];
      for (let h = 0; h < 12; h += 1) if (mask & (1 << h)) hidden.push(h * 2);
      const ranges = rangesFromHidden(hidden);
      assert.deepEqual(normaliseRanges(ranges), ranges, `mask ${mask} is canonical`);
      if (hidden.length < 24) {
        assert.deepEqual(hiddenHours(ranges), hidden, `mask ${mask} round trips`);
      }
    }

    // Every hour hidden is the one input that cannot be honoured.
    const all = Array.from({ length: 24 }, (_, h) => h);
    assert.deepEqual(rangesFromHidden(all), FULL_DAY, 'a blank day is refused');
    assert.deepEqual(rangesFromHidden([]), FULL_DAY);
    // Rubbish among the hours is ignored, not fatal.
    assert.deepEqual(rangesFromHidden([2, 3, 4, 5, -1, 99, NaN as number]), NIGHT_OFF);
  }

  console.log('--- 3. A MINUTE KNOWS WHETHER IT IS DRAWN ---');
  {
    for (let m = 0; m < 24 * 60; m += 7) {
      assert.equal(isMinuteVisible(m, FULL_DAY), true, `${m} is in a full day`);
    }
    assert.equal(isMinuteVisible(0, NIGHT_OFF), true, 'midnight is shown');
    assert.equal(isMinuteVisible(119, NIGHT_OFF), true, 'one minute to two');
    assert.equal(isMinuteVisible(120, NIGHT_OFF), false, 'two exactly is hidden');
    assert.equal(isMinuteVisible(359, NIGHT_OFF), false, 'one minute to six');
    assert.equal(isMinuteVisible(360, NIGHT_OFF), true, 'six exactly is back');
    assert.equal(isMinuteVisible(24 * 60 - 1, NIGHT_OFF), true, 'the last minute');
  }

  console.log('--- 4. HOW TALL THE GRID IS ---');
  {
    assert.equal(visibleMinutes(FULL_DAY), 1440);
    assert.equal(visibleMinutes(NIGHT_OFF), 1200, 'four hours fewer');
    assert.equal(visibleMinutes([r(9, 17)]), 480);
    assert.equal(visibleMinutes([r(0, 1), r(23, 24)]), 120, 'two thin ends');
  }

  console.log('--- 5. THE ROUND TRIP, WHICH IS THE WHOLE THING ---');
  {
    // Every visible minute, at several slot heights, must survive being turned
    // into a pixel and read back. A disagreement here is a block that lands
    // somewhere other than where it was dropped.
    const shapes: HourRange[][] = [
      FULL_DAY,
      [r(9, 17)],
      NIGHT_OFF,
      normaliseRanges([r(0, 3), r(8, 12), r(14, 18), r(22, 24)]),
      [r(23, 24)],
    ];
    for (const ranges of shapes) {
      for (const pxPerHour of [45, 48, 60, 96, 130.5]) {
        for (const range of ranges) {
          for (let m = range.from * 60; m < range.to * 60; m += 1) {
            const y = yOfMinute(m, ranges, pxPerHour);
            const back = minuteAtY(y, ranges, pxPerHour);
            assert.ok(Math.abs(back - m) < 1e-6,
              `${m} came back as ${back} at ${pxPerHour}px`);
          }
        }
      }
    }
  }

  console.log('--- 6. POSITIONS SKIP THE HOURS THAT ARE NOT THERE ---');
  {
    // Nine in the morning is nine hours down a full day, but only five once the
    // small hours are gone. This is the arithmetic the old code could not do.
    assert.equal(drawnMinuteOf(9 * 60, FULL_DAY), 9 * 60);
    assert.equal(drawnMinuteOf(9 * 60, NIGHT_OFF), 5 * 60,
      'two hours drawn, four skipped, then three more: five drawn hours');
    assert.equal(drawnMinuteOf(0, NIGHT_OFF), 0);
    assert.equal(drawnMinuteOf(6 * 60, NIGHT_OFF), 2 * 60, 'six sits right under two');

    // A minute inside a hidden stretch is pinned to the seam above it rather
    // than being given a position it does not have.
    assert.equal(drawnMinuteOf(3 * 60, NIGHT_OFF), 2 * 60);
    assert.equal(drawnMinuteOf(5 * 60 + 59, NIGHT_OFF), 2 * 60);

    // Before the first drawn hour and after the last, clamped rather than off grid.
    const office = [r(9, 17)];
    assert.equal(drawnMinuteOf(0, office), 0, 'midnight clamps to the top');
    assert.equal(drawnMinuteOf(23 * 60, office), 8 * 60, 'and 11pm to the bottom');
    for (let m = 0; m <= 24 * 60; m += 13) {
      const y = yOfMinute(m, office, 60);
      assert.ok(y >= 0 && y <= visibleMinutes(office), `${m} stays on the grid`);
    }
  }

  console.log('--- 7. A PIXEL OFF THE END STILL NAMES A VISIBLE MINUTE ---');
  {
    for (const ranges of [FULL_DAY, NIGHT_OFF, [r(9, 17)]]) {
      for (const y of [-500, -1, 0, 1e6, NaN, Infinity, -Infinity]) {
        const m = minuteAtY(y, ranges, 60);
        assert.ok(Number.isFinite(m), `${y} gives a real minute`);
        assert.ok(m >= 0 && m <= 24 * 60, `${y} stays inside the day`);
      }
      // A rate that makes no sense must not produce a NaN minute either.
      for (const rate of [0, -60, NaN, Infinity]) {
        const m = minuteAtY(100, ranges, rate);
        assert.ok(Number.isFinite(m), `rate ${rate} gives a real minute`);
      }
    }
  }

  console.log('--- 8. THE LINES DRAWN DOWN THE GRID ---');
  {
    assert.equal(hourMarksIn(FULL_DAY).length, 25, 'every hour plus the closing one');
    assert.deepEqual(hourMarksIn([r(9, 12)]), [540, 600, 660, 720]);

    // A seam must not produce the same line twice, which would read as a
    // thicker line for no reason.
    const touching = [r(0, 2), r(2, 4)];
    assert.equal(new Set(hourMarksIn(touching)).size, hourMarksIn(touching).length);
    for (const ranges of [FULL_DAY, NIGHT_OFF, [r(9, 17)], touching]) {
      const marks = hourMarksIn(ranges);
      assert.deepEqual([...marks].sort((a, b) => a - b), marks, 'in order');
      assert.equal(new Set(marks).size, marks.length, 'no duplicates');
    }

    // Slots divide the drawn hours and nothing else.
    for (const interval of [5, 10, 15, 30, 60]) {
      const slots = slotsIn(NIGHT_OFF, interval);
      assert.equal(new Set(slots).size, slots.length, `${interval} has no duplicates`);
      for (const m of slots) {
        const atEdge = NIGHT_OFF.some(x => m === x.from * 60 || m === x.to * 60);
        assert.ok(isMinuteVisible(m, NIGHT_OFF) || atEdge,
          `${interval}: ${m} is drawn or is an edge`);
      }
    }
    // A nonsense interval falls back rather than looping forever.
    for (const bad of [0, -5, NaN, Infinity]) {
      const slots = slotsIn([r(9, 10)], bad as number);
      assert.ok(slots.length > 0 && slots.length < 200, `${bad} terminates`);
    }
  }

  console.log('--- 9. THE SEAMS, SO A CUT IS VISIBLE ---');
  {
    assert.deepEqual(seamsIn(FULL_DAY), [], 'an uncut day has no seams');
    assert.deepEqual(seamsIn(NIGHT_OFF), [120], 'one cut, two hours down');
    assert.deepEqual(seamsIn(normaliseRanges([r(0, 2), r(6, 8), r(20, 24)])), [120, 240]);
    for (const ranges of [FULL_DAY, NIGHT_OFF, [r(9, 17)]]) {
      assert.equal(seamsIn(ranges).length, ranges.length - 1, 'one seam between each pair');
    }
  }

  console.log('--- 10. NOTHING IS EVER SILENTLY LOST ---');
  {
    // THE SAFETY NET. A meeting at 3am with 3am switched off must come back
    // from here, or it is gone with nothing on screen to say so.
    const items = [
      { id: 'night', min: 3 * 60 },
      { id: 'morning', min: 9 * 60 },
      { id: 'edge', min: 2 * 60 },
      { id: 'back', min: 6 * 60 },
      { id: 'undated', min: null as number | null },
    ];
    const out = itemsOutsideView(items, i => i.min, NIGHT_OFF);
    assert.deepEqual(out.map(i => i.id), ['night', 'edge'],
      'the two in hidden hours, and only those');

    assert.deepEqual(itemsOutsideView(items, i => i.min, FULL_DAY), [],
      'a full day hides nothing');
    assert.deepEqual(itemsOutsideView([], i => (i as any).min, NIGHT_OFF), []);

    // Every item is either drawn or reported. Never neither.
    for (const ranges of [FULL_DAY, NIGHT_OFF, [r(9, 17)]]) {
      const hiddenSet = new Set(itemsOutsideView(items, i => i.min, ranges).map(i => i.id));
      for (const item of items) {
        if (item.min === null) continue;
        const drawn = isMinuteVisible(item.min, ranges);
        assert.notEqual(drawn, hiddenSet.has(item.id),
          `${item.id} is drawn or reported, never both or neither`);
      }
    }
  }

  console.log('--- 11. WHAT A PERSON READS ---');
  {
    assert.equal(describeRanges(FULL_DAY), 'The whole day is shown.');
    assert.ok(isFullDay(FULL_DAY));
    assert.ok(!isFullDay(NIGHT_OFF));

    assert.ok(describeRanges([r(9, 17)]).includes('9am to 5pm'));
    assert.ok(describeRanges([r(9, 17)], '24h').includes('09:00 to 17:00'));
    assert.ok(describeRanges(NIGHT_OFF).includes('4 hours are hidden'));
    assert.ok(describeRanges(normaliseRanges([r(0, 1), r(2, 24)])).includes('1 hour is hidden'),
      'one hour is singular');

    // Midnight and noon are named, not numbered, and 24 reads as midnight.
    const ends = describeRanges([r(0, 24)], undefined);
    assert.ok(ends.length > 0);
    assert.ok(describeRanges([r(0, 12)]).includes('midnight'));
    assert.ok(describeRanges([r(0, 12)]).includes('noon'));

    // NO DASHES ANYWHERE, in any shape, in either clock.
    const shapes = [
      FULL_DAY, NIGHT_OFF, [r(9, 17)], [r(23, 24)],
      normaliseRanges([r(0, 3), r(8, 12), r(14, 18), r(22, 24)]),
    ];
    for (const ranges of shapes) {
      for (const clock of [undefined, '12h', '24h']) {
        const line = describeRanges(ranges, clock);
        assert.ok(line.length > 0, 'there is something to read');
        assert.ok(!line.includes('—') && !line.includes('–'), `no dash in "${line}"`);
      }
    }
  }


  // ── 12. NIGHTS THAT RUN PAST THE END OF A COLUMN ───────────────────────────
  // The bug this exists for: an end read off the clock can never be greater
  // than 24:00, so sleep from 23:50 to 00:05 arrived with an end EARLIER than
  // its start. Drawn literally that is a block of no length, which is how a
  // whole night became a sliver at bedtime.
  {
    console.log('--- 12. NIGHTS THAT RUN PAST THE END OF A COLUMN ---');
    const cut = (startMin: number, endMin: number | null, opts: Partial<{
      col: number; columns: number; dayStartHour: number; fallbackMinutes: number;
    }> = {}) => splitAcrossWindows({ startMin, endMin }, {
      col: opts.col ?? 1,
      columns: opts.columns ?? 3,
      dayStartHour: opts.dayStartHour,
      fallbackMinutes: opts.fallbackMinutes,
    });

    // An ordinary daytime block is one piece, untouched.
    assert.deepEqual(cut(9 * 60, 10 * 60), [
      { col: 1, startMin: 540, endMin: 600, isTail: false, isHead: false },
    ], 'an ordinary block is left alone');

    // The night that started all of this.
    assert.deepEqual(cut(23 * 60 + 50, 5), [
      { col: 1, startMin: 1430, endMin: 1440, isTail: true, isHead: false },
      { col: 2, startMin: 0, endMin: 5, isTail: false, isHead: true },
    ], '23:50 to 00:05 is a tail tonight and a head tomorrow');

    // Total drawn length equals the real length, which is the whole point.
    {
      const pieces = cut(22 * 60 + 25, 6 * 60 + 40);
      const drawn = pieces.reduce((n, piece) => n + (piece.endMin - piece.startMin), 0);
      assert.equal(drawn, (24 * 60 - (22 * 60 + 25)) + (6 * 60 + 40), 'nothing is lost in the cut');
      assert.equal(pieces.length, 2);
      assert.equal(pieces[0].isTail, true);
      assert.equal(pieces[1].isHead, true);
    }

    // A deadline at six is a MOMENT, not a day. Equal must never wrap, or every
    // Google deadline in the calendar becomes a wall down the column.
    assert.deepEqual(cut(18 * 60, 18 * 60), [
      { col: 1, startMin: 1080, endMin: 1080, isTail: false, isHead: false },
    ], 'an end equal to the start is zero length, not twenty-four hours');

    // Ending exactly at midnight closes today rather than opening tomorrow.
    assert.deepEqual(cut(23 * 60, 0), [
      { col: 1, startMin: 1380, endMin: 1440, isTail: false, isHead: false },
    ], 'an end at midnight closes the column rather than opening the next');

    // No end at all: the fallback length, and it can cross midnight too.
    assert.deepEqual(cut(23 * 60 + 45, null), [
      { col: 1, startMin: 1425, endMin: 1440, isTail: true, isHead: false },
      { col: 2, startMin: 0, endMin: 15, isTail: false, isHead: true },
    ], 'an item with no end uses the fallback, and still splits');
    assert.deepEqual(cut(9 * 60, null, { fallbackMinutes: 45 }), [
      { col: 1, startMin: 540, endMin: 585, isTail: false, isHead: false },
    ], 'the fallback length is honoured');

    // The head has nowhere to go: the tail is still drawn, alone.
    assert.deepEqual(cut(23 * 60, 60, { col: 2, columns: 3 }), [
      { col: 2, startMin: 1380, endMin: 1440, isTail: true, isHead: false },
    ], 'the last column keeps its tail and drops the head off the edge');

    // A window that opens at 4am: anything before it belongs to the column
    // BEFORE, at the far end of that column's own window.
    assert.deepEqual(cut(60, 3 * 60, { dayStartHour: 4 }), [
      { col: 0, startMin: 1500, endMin: 1620, isTail: false, isHead: false },
    ], '1am with a 4am start is late in yesterday, not early today');
    assert.deepEqual(cut(60, 3 * 60, { col: 0, dayStartHour: 4 }), [],
      'and it is simply not drawn when that column is off screen');

    // The same window, with an item that runs over ITS end.
    // 11pm to 5am with a 4am window is cut at 4am, not at midnight: the window
    // is what a column holds, and midnight is not special to it.
    assert.deepEqual(cut(23 * 60, 5 * 60, { dayStartHour: 4 }), [
      { col: 1, startMin: 1380, endMin: 1680, isTail: true, isHead: false },
      { col: 2, startMin: 240, endMin: 300, isTail: false, isHead: true },
    ], 'a 4am window cuts 11pm to 5am at its own edge');
    // Whereas 11pm to 3am fits inside that same window whole, which midnight
    // would have split.
    assert.deepEqual(cut(23 * 60, 3 * 60, { dayStartHour: 4 }), [
      { col: 1, startMin: 1380, endMin: 1620, isTail: false, isHead: false },
    ], 'and holds 11pm to 3am in one piece');
    assert.deepEqual(cut(3 * 60, 5 * 60, { dayStartHour: 4 }), [
      { col: 0, startMin: 1620, endMin: 1680, isTail: true, isHead: false },
      { col: 1, startMin: 240, endMin: 300, isTail: false, isHead: true },
    ], '3am to 5am straddles the 4am boundary and is cut at it');

    // Longer than a whole day: the head is clamped so it cannot draw past the
    // foot of the column it opens.
    {
      const pieces = cut(10 * 60, null, { fallbackMinutes: 3 * 1440 });
      assert.equal(pieces.length, 2);
      assert.equal(pieces[1].endMin, 1440, 'a head can never run past its own column');
    }

    // Rubbish in, nothing out. Never a throw, and never a NaN on the grid.
    assert.deepEqual(splitAcrossWindows({ startMin: null, endMin: 60 }, { col: 1, columns: 3 }), []);
    assert.deepEqual(splitAcrossWindows({ startMin: undefined, endMin: 60 }, { col: 1, columns: 3 }), []);
    assert.deepEqual(splitAcrossWindows({ startMin: NaN, endMin: 60 }, { col: 1, columns: 3 }), []);
    for (const piece of cut(9 * 60, NaN)) {
      assert.ok(Number.isFinite(piece.startMin) && Number.isFinite(piece.endMin), 'no NaN reaches the grid');
    }

    // Every piece must sit inside the window of the column it was given to, or
    // the view's top and height are meaningless.
    for (const dayStartHour of [0, 4, 7, 12]) {
      for (let start = 0; start < 1440; start += 17) {
        for (const end of [null, 0, 5, 300, 725, 1439, start, (start + 600) % 1440]) {
          const pieces = splitAcrossWindows({ startMin: start, endMin: end }, {
            col: 2, columns: 5, dayStartHour,
          });
          const lo = dayStartHour * 60;
          for (const piece of pieces) {
            assert.ok(piece.col >= 0 && piece.col < 5, 'the column is on screen');
            assert.ok(piece.startMin >= lo && piece.startMin <= lo + 1440, 'start inside the window');
            assert.ok(piece.endMin >= piece.startMin, 'a piece never ends before it starts');
            assert.ok(piece.endMin <= lo + 1440, 'end inside the window');
          }
          assert.ok(pieces.filter(piece => piece.isTail).length <= 1, 'at most one tail');
          assert.ok(pieces.filter(piece => piece.isHead).length <= 1, 'at most one head');
          if (pieces.length === 2) {
            assert.equal(pieces[0].col + 1, pieces[1].col, 'the head follows its tail');
          }
        }
      }
    }
  }

  // ── 13. THE DAY IS ALLOWED TO START WHEN YOU SAY ───────────────────────────
  // The window and the visible hours are two different questions and were never
  // combined, so "the day starts at 6am" changed a number in the settings and
  // nothing on the grid.
  {
    console.log('--- 13. THE DAY IS ALLOWED TO START WHEN YOU SAY ---');

    // No window at all is the old behaviour, exactly.
    assert.deepEqual(windowRanges(null, FULL_DAY), FULL_DAY);
    assert.deepEqual(windowRanges(undefined, NIGHT_OFF), NIGHT_OFF);

    // A whole day starting at 6 runs 6 to 30, not 6 to 6.
    assert.deepEqual(windowRanges({ start: 6, end: 30 }, FULL_DAY), [r(6, 30)]);
    assert.equal(visibleMinutes(windowRanges({ start: 6, end: 30 }, FULL_DAY)), 1440);

    // A shorter window is just shorter.
    assert.deepEqual(windowRanges({ start: 7, end: 23 }, FULL_DAY), [r(7, 23)]);

    // Hidden hours are cut out of the window, and the cut is expressed in the
    // window's own frame: 2am to 6am on a day that starts at 6pm is 26 to 30.
    assert.deepEqual(
      windowRanges({ start: 18, end: 42 }, normaliseRanges([r(0, 2), r(6, 24)])),
      [r(18, 26), r(30, 42)],
    );

    // The same hidden stretch on an ordinary midnight day.
    assert.deepEqual(windowRanges({ start: 0, end: 24 }, NIGHT_OFF), NIGHT_OFF);

    // Hiding everything the window covers cannot produce a grid of no height.
    const allHidden = windowRanges({ start: 9, end: 12 }, normaliseRanges([r(13, 20)]));
    assert.deepEqual(allHidden, [r(9, 12)], 'the window is the floor');
    assert.ok(visibleMinutes(allHidden) > 0);

    // Rubbish never yields a grid of no height, and never a NaN.
    for (const win of [
      { start: NaN, end: 24 }, { start: 6, end: NaN },
      { start: -5, end: 10 }, { start: 30, end: 40 },
      { start: 10, end: 10 }, { start: 10, end: 3 },
      { start: 0, end: 999 }, { start: 6.7, end: 20.2 },
    ] as { start: number; end: number }[]) {
      const out = windowRanges(win, FULL_DAY);
      assert.ok(out.length > 0, 'always something to draw');
      for (const range of out) {
        assert.ok(Number.isFinite(range.from) && Number.isFinite(range.to));
        assert.ok(range.to > range.from, 'a range always moves forwards');
        assert.ok(range.from >= 0 && range.to <= 48, 'inside the two-day frame');
      }
      assert.ok(visibleMinutes(out) > 0);
      assert.ok(visibleMinutes(out) <= 1440, 'a day is never longer than a day');
    }

    // The round trip still holds inside a shifted window: this is the property
    // that keeps a block dropped at 2am from landing at 1:45.
    for (const win of [{ start: 6, end: 30 }, { start: 18, end: 36 }, { start: 4, end: 20 }]) {
      const ranges = windowRanges(win, normaliseRanges([r(0, 3), r(7, 24)]));
      for (let m = win.start * 60; m < win.end * 60; m += 7) {
        if (!isMinuteVisible(m, ranges)) continue;
        const y = yOfMinute(m, ranges, 60);
        const back = minuteAtY(y, ranges, 60);
        assert.ok(Math.abs(back - m) < 1, 'a drawn minute reads back as itself');
      }
    }

    // And a piece cut by `splitAcrossWindows` always lands on a drawn minute or
    // is honestly reported as hidden, never off the end of the grid.
    {
      const win = { start: 6, end: 30 };
      const ranges = windowRanges(win, FULL_DAY);
      const pieces = splitAcrossWindows({ startMin: 35, endMin: 9 * 60 + 5 }, {
        col: 1, columns: 3, dayStartHour: win.start,
      });
      assert.equal(pieces.length, 2, '00:35 to 09:05 with a 6am day is two pieces');
      assert.equal(pieces[0].col, 0, 'the night half belongs to the day before');
      assert.deepEqual(
        [pieces[0].startMin, pieces[0].endMin], [35 + 1440, 30 * 60],
        'and runs to the far edge of that column',
      );
      assert.deepEqual(
        [pieces[1].startMin, pieces[1].endMin], [6 * 60, 9 * 60 + 5],
        'the morning half opens the next column at 6am',
      );
      for (const piece of pieces) {
        const y = yOfMinute(piece.startMin, ranges, 60);
        assert.ok(y >= 0 && y <= visibleMinutes(ranges), 'drawn inside the grid');
      }
    }
  }


  // ─── WHERE THE DRAWN HOURS CUT A BLOCK ───────────────────────────────────────
  //
  // The case that prompted this: a night from 00:25 to 08:55 on a grid whose day
  // ends at 2am. An hour and a half of it is drawn and seven hours are not, and
  // the block said nothing at all about the missing seven.
  console.log('\n--- CLIPPING: WHOLLY IN, WHOLLY OUT, AND CUT AT EITHER END ---');
  {
    const DAY = [{ from: 8, to: 18 }];

    // Entirely inside the drawn hours: nothing to say.
    assert.deepEqual(clipSpan(9 * 60, 10 * 60, DAY),
      { hidden: false, clippedAbove: false, clippedBelow: false });
    // Flush against both edges is still entirely inside. `endMin` is exclusive,
    // so a block ending exactly at 18:00 is not cut by the hour starting there.
    assert.deepEqual(clipSpan(8 * 60, 18 * 60, DAY),
      { hidden: false, clippedAbove: false, clippedBelow: false },
      'the exact span of the drawn hours is not clipped at either end');

    // Entirely outside, on either side.
    assert.deepEqual(clipSpan(2 * 60, 3 * 60, DAY),
      { hidden: true, clippedAbove: false, clippedBelow: false }, 'before the first hour drawn');
    assert.deepEqual(clipSpan(20 * 60, 21 * 60, DAY),
      { hidden: true, clippedAbove: false, clippedBelow: false }, 'after the last');
    // A hidden span reports no clipping. It is not "cut off at the top", it is
    // simply not there, and it belongs in the list under the grid instead.
    const out = clipSpan(20 * 60, 21 * 60, DAY);
    assert.equal(out.clippedAbove, false);
    assert.equal(out.clippedBelow, false);

    // Cut at the top, at the bottom, and at both.
    assert.deepEqual(clipSpan(6 * 60, 10 * 60, DAY),
      { hidden: false, clippedAbove: true, clippedBelow: false }, 'starts before the grid opens');
    assert.deepEqual(clipSpan(16 * 60, 20 * 60, DAY),
      { hidden: false, clippedAbove: false, clippedBelow: true }, 'runs past where it closes');
    assert.deepEqual(clipSpan(6 * 60, 20 * 60, DAY),
      { hidden: false, clippedAbove: true, clippedBelow: true }, 'swallows the whole drawn day');

    // One minute of overlap is still visible, at either edge.
    assert.equal(clipSpan(7 * 60, 8 * 60 + 1, DAY).hidden, false, 'one minute at the top counts');
    assert.equal(clipSpan(7 * 60, 8 * 60 + 1, DAY).clippedAbove, true);
    assert.equal(clipSpan(17 * 60 + 59, 19 * 60, DAY).hidden, false, 'and one at the bottom');
    assert.equal(clipSpan(17 * 60 + 59, 19 * 60, DAY).clippedBelow, true);
    // Ending exactly where the grid opens is not an overlap at all.
    assert.equal(clipSpan(6 * 60, 8 * 60, DAY).hidden, true, 'an end flush with the first hour is out');
    assert.equal(clipSpan(18 * 60, 19 * 60, DAY).hidden, true, 'and a start flush with the last');
  }

  console.log('\n--- CLIPPING ACROSS A HOLE IN THE MIDDLE ---');
  {
    // Two stretches with the afternoon cut out of the middle.
    const SPLIT = [{ from: 6, to: 12 }, { from: 16, to: 22 }];

    // A block spanning the hole is drawn in both halves, and is NOT reported as
    // clipped: the seam already says the hours are missing, and repeating it on
    // every block that crosses it would be noise.
    assert.deepEqual(clipSpan(10 * 60, 18 * 60, SPLIT),
      { hidden: false, clippedAbove: false, clippedBelow: false },
      'a block bridging the seam is whole at both of its own ends');

    // A block living entirely inside the hole is hidden.
    assert.deepEqual(clipSpan(13 * 60, 14 * 60, SPLIT),
      { hidden: true, clippedAbove: false, clippedBelow: false });

    // One that starts in the hole and comes out the far side is cut at the top.
    assert.deepEqual(clipSpan(13 * 60, 18 * 60, SPLIT),
      { hidden: false, clippedAbove: true, clippedBelow: false });
    // And one that starts in view and ends in the hole is cut at the bottom.
    assert.deepEqual(clipSpan(10 * 60, 14 * 60, SPLIT),
      { hidden: false, clippedAbove: false, clippedBelow: true });

    // Three stretches, so a block can bridge two holes at once.
    const THREE = [{ from: 0, to: 2 }, { from: 6, to: 8 }, { from: 20, to: 22 }];
    assert.deepEqual(clipSpan(60, 21 * 60, THREE),
      { hidden: false, clippedAbove: false, clippedBelow: false }, 'bridging two holes');
    assert.deepEqual(clipSpan(3 * 60, 21 * 60, THREE),
      { hidden: false, clippedAbove: true, clippedBelow: false }, 'starting inside the first hole');
    assert.deepEqual(clipSpan(60, 23 * 60, THREE),
      { hidden: false, clippedAbove: false, clippedBelow: true }, 'ending past the last hour');
  }

  console.log('\n--- CLIPPING IN A WINDOW THAT RUNS PAST MIDNIGHT ---');
  {
    // The real setup from the report: the day runs 6am to 2am the next
    // morning. That is a twenty hour window, so the four hours from 2am to 6am
    // belong to no column at all -- and everything measured here is in the
    // WINDOW's frame, where half past midnight is 24:30.
    const NIGHT = windowRanges({ start: 6, end: 26 }, FULL_DAY);
    assert.deepEqual(NIGHT, [r(6, 26)], 'six in the morning until two the next');
    assert.equal(visibleMinutes(NIGHT), 20 * 60, 'twenty hours of it are drawn');

    // Sleeping, 00:25 to 08:55. It opens after midnight, so it belongs to the
    // PREVIOUS column, and `splitAcrossWindows` cuts it at the foot of that
    // column. What is left is the piece from 24:25 to the cut.
    const [tail, head] = splitAcrossWindows(
      { startMin: 25, endMin: 535 }, { col: 1, columns: 3, dayStartHour: 6 },
    );
    assert.equal(tail.isTail, true, 'the first piece runs off the end of its column');
    assert.equal(tail.startMin, 24 * 60 + 25, 'starting at half past midnight');
    assert.equal(head.isHead, true, 'and the rest arrives at the top of the next one');

    const sleep = clipSpan(tail.startMin, tail.endMin, NIGHT);
    assert.equal(sleep.hidden, false, 'the first hour and a half of it is on screen');
    assert.equal(sleep.clippedAbove, false, 'it starts where it appears to start');
    assert.equal(sleep.clippedBelow, true,
      'and everything after 2am is cut off, which the block has to say');

    // THE CASE THAT PROMPTED ALL THIS. Dawn prayer at 04:19 falls in the four
    // hours between the end of one column and the start of the next, so in this
    // frame it is 28:19: past the end of the window entirely. It is not late in
    // the column. It is not in the column.
    const fajr = clipSpan(4 * 60 + 19 + 1440, 4 * 60 + 20 + 1440, NIGHT);
    assert.equal(fajr.hidden, true,
      'dawn prayer is outside the drawn hours, not squashed against the bottom of them');

    // A day drawn round the clock has nowhere for it to fall out of.
    const whole = windowRanges({ start: 6, end: 30 }, FULL_DAY);
    assert.equal(clipSpan(4 * 60 + 19 + 1440, 4 * 60 + 20 + 1440, whole).hidden, false,
      'the same prayer on a full twenty-four hour column is simply drawn');
  }

  console.log('\n--- CLIPPING SURVIVES NONSENSE ---');
  {
    const DAY = [{ from: 8, to: 18 }];
    // A moment with no duration is one minute, so it still answers the question.
    assert.equal(clipSpan(9 * 60, 9 * 60, DAY).hidden, false, 'a marker inside the hours is drawn');
    assert.equal(clipSpan(3 * 60, 3 * 60, DAY).hidden, true, 'and one outside them is not');
    assert.equal(clipSpan(9 * 60, 8 * 60, DAY).hidden, false, 'a backwards span is read as its start');

    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = clipSpan(bad, 10 * 60, DAY);
      assert.equal(typeof r.hidden, 'boolean', `start ${bad} still answers`);
      const r2 = clipSpan(9 * 60, bad, DAY);
      assert.equal(typeof r2.hidden, 'boolean', `end ${bad} still answers`);
    }
    // No drawn hours at all: everything is hidden, and nothing throws.
    assert.deepEqual(clipSpan(9 * 60, 10 * 60, []),
      { hidden: true, clippedAbove: false, clippedBelow: false });

    // AGREES WITH `isMinuteVisible`, which is what the rest of the grid measures
    // by. Walked over every minute of the day against three different windows,
    // because a disagreement here means a block drawn in one place and listed as
    // missing in another.
    for (const ranges of [[{ from: 8, to: 18 }], [{ from: 0, to: 24 }],
                          [{ from: 6, to: 12 }, { from: 16, to: 22 }]]) {
      for (let m = 0; m < 1440; m += 1) {
        assert.equal(clipSpan(m, m + 1, ranges).hidden, !isMinuteVisible(m, ranges),
          `minute ${m} is described the same way by both`);
      }
    }

    // A span is hidden if and only if no minute in it is visible. Checked
    // exhaustively over a day at five minute resolution rather than argued.
    const RANGES = [{ from: 6, to: 12 }, { from: 16, to: 22 }];
    for (let s = 0; s < 1440; s += 5) {
      for (const len of [1, 30, 90, 480]) {
        const e = s + len;
        let anyVisible = false;
        for (let m = s; m < e; m += 1) if (isMinuteVisible(m, RANGES)) { anyVisible = true; break; }
        assert.equal(clipSpan(s, e, RANGES).hidden, !anyVisible,
          `${s} for ${len} minutes`);
      }
    }
  }

  console.log('\nALL PASS (dayWindows: canonical ranges, the round trip, seams, nothing lost, clipping)');
}

main();
