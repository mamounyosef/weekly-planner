// Tests the arithmetic behind dragging on the time grid.
//
// THE ONES THAT MATTER: a drag can never produce an inverted or zero-length
// range, and moving a block can never change its duration. Both fail silently.
// An inverted range becomes an event the grid draws with a negative height, so
// it is invisible; a squashed block becomes a meeting that quietly lost half an
// hour because it was dragged near midnight. Neither throws, neither logs, and
// you find out at the wrong moment.
//
// Run with: npx tsx src/lib/dragGrid.test.ts

import assert from 'node:assert/strict';
import { MIN_BLOCK_MINUTES, yOf } from './grid';
import {
  columnAtX,
  createRange,
  minBlockMinutes,
  minutesAtY,
  moveBlock,
  resizeBlock,
  snapMinutes,
  yAtMinutes,
  type SnapMode,
} from './dragGrid';

const INTERVALS = [5, 10, 15, 30, 60];
const MODES: SnapMode[] = ['nearest', 'floor', 'ceil'];

function main() {
  console.log('--- 1. A PIXEL IS A TIME, AND THE TRIP BACK IS EXACT ---');
  {
    // 60px an hour, grid starting at midnight.
    assert.equal(minutesAtY(0, 60, 0), 0);
    assert.equal(minutesAtY(540, 60, 0), 540, 'nine in the morning');
    assert.equal(minutesAtY(0, 60, 8), 480, 'the top of a grid that starts at 8am is 8am');
    assert.equal(minutesAtY(60, 60, 8), 540);

    // The inverse of yOf, which is what the grid draws with. If these drift,
    // the block lands somewhere other than where the ghost was.
    for (const pxPerHour of [24, 48, 57, 96, 130]) {
      for (const fromHour of [0, 6, 8, 23]) {
        for (const minutes of [0, 7, 60, 543, 1439]) {
          const y = yOf(minutes, pxPerHour, fromHour);
          assert.ok(Math.abs(minutesAtY(y, pxPerHour, fromHour) - minutes) < 1e-9,
            `${minutes} survives the round trip at ${pxPerHour}px/h from ${fromHour}`);
        }
      }
    }
    assert.equal(yAtMinutes, yOf, 'the re-export is the grid\'s own function');

    // Non-integer pixel positions are the normal case: a thumb does not land on
    // whole pixels and neither does a scroll offset.
    assert.ok(Math.abs(minutesAtY(30.5, 60, 0) - 30.5) < 1e-9);
    assert.ok(Math.abs(minutesAtY(19.37, 48, 9) - (540 + 19.37 * 60 / 48)) < 1e-9);

    // Above the top of the grid. A finger dragged off the top has a negative y
    // and must produce a time before the window, not NaN or zero.
    assert.equal(minutesAtY(-60, 60, 9), 480, 'negative y reads as earlier');
    assert.ok(minutesAtY(-1000, 60, 0) < 0, 'and is allowed to go before midnight');

    // Nonsense in, the top of the window out. Never NaN, which would poison
    // every snap and clamp downstream.
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.equal(minutesAtY(bad, 60, 9), 540);
      assert.equal(minutesAtY(100, bad, 9), 540);
    }
    assert.equal(minutesAtY(100, 0, 9), 540, 'a zero-height grid has no time in it');
    assert.equal(minutesAtY(100, -60, 9), 540);
  }

  console.log('--- 2. SNAPPING ---');
  {
    assert.equal(snapMinutes(542, 15, 'nearest'), 540);
    assert.equal(snapMinutes(548, 15, 'nearest'), 555);
    assert.equal(snapMinutes(542, 15, 'floor'), 540);
    assert.equal(snapMinutes(542, 15, 'ceil'), 555);
    assert.equal(snapMinutes(540, 15, 'ceil'), 540, 'already on the grid, so it stays');
    assert.equal(snapMinutes(540, 15, 'floor'), 540);

    // Exactly halfway rounds up, consistently, so a block does not flicker
    // between two slots while the thumb is held still on the boundary.
    assert.equal(snapMinutes(7.5, 15, 'nearest'), 15);
    assert.equal(snapMinutes(22.5, 15, 'nearest'), 30);

    // Negative times happen when the thumb goes above a grid starting at 00:00.
    assert.equal(snapMinutes(-7, 15, 'floor'), -15);
    assert.equal(snapMinutes(-7, 15, 'ceil'), 0, 'and never negative zero');
    assert.equal(snapMinutes(-20, 15, 'nearest'), -15);

    // Idempotence, at every interval and every mode. The gesture snaps on every
    // frame, not just on release, so a snap that moved a snapped value would
    // walk a block across the grid while the thumb was still.
    for (const interval of INTERVALS) {
      for (const mode of MODES) {
        for (let m = -180; m <= 1500; m += 1) {
          const once = snapMinutes(m, interval, mode);
          const twice = snapMinutes(once, interval, mode);
          assert.equal(twice, once, `snap(${m}, ${interval}, ${mode}) is idempotent`);
          // Note the ok() rather than equal(): a negative time modulo the
          // interval is -0, which is not strictly equal to 0.
          assert.ok(once % interval === 0, `and lands on a ${interval} minute line`);
          if (mode === 'floor') assert.ok(once <= m);
          if (mode === 'ceil') assert.ok(once >= m);
          if (mode === 'nearest') assert.ok(Math.abs(once - m) <= interval / 2 + 1e-9);
        }
      }
    }

    // Floating point: 540/15 lands just under 36 in binary, so a naive ceil
    // would push an exact 9:00 up to 9:15.
    for (const interval of INTERVALS) {
      for (let k = 0; k < 200; k += 1) {
        const exact = k * interval;
        assert.equal(snapMinutes(exact, interval, 'ceil'), exact, `${exact} does not creep up`);
        assert.equal(snapMinutes(exact, interval, 'floor'), exact, `${exact} does not creep down`);
      }
    }

    // A broken interval falls back to something drawable rather than dividing
    // by zero.
    for (const bad of [0, -15, NaN, Infinity]) {
      const v = snapMinutes(547, bad as number, 'nearest');
      assert.ok(Number.isFinite(v), `interval ${bad} still yields a number`);
    }
    assert.equal(snapMinutes(NaN, 15, 'nearest'), 0);
  }

  console.log('--- 3. A CREATE-DRAG ALWAYS MAKES A USABLE EVENT ---');
  {
    const win = { fromHour: 8, toHour: 20 };

    // Downward.
    assert.deepEqual(
      createRange({ anchorMin: 540, currentMin: 600, interval: 15, ...win }),
      { startMin: 540, endMin: 600 },
    );

    // Upward is the same gesture. People grab the end of a meeting they know
    // and pull back to its start.
    assert.deepEqual(
      createRange({ anchorMin: 600, currentMin: 540, interval: 15, ...win }),
      { startMin: 540, endMin: 600 },
      'dragging up gives the same range as dragging down',
    );

    // A drag covering no distance still makes exactly one slot, at every
    // interval. This is the "tap an empty slot to add something" path.
    for (const interval of INTERVALS) {
      const r = createRange({ anchorMin: 540, currentMin: 540, interval, ...win });
      assert.equal(r.startMin, 540);
      assert.equal(r.endMin - r.startMin, interval, `a tap makes one ${interval} minute slot`);
    }

    // A two pixel wobble is a tap, not a zero-length event.
    const wobble = createRange({ anchorMin: 540, currentMin: 542, interval: 30, ...win });
    assert.deepEqual(wobble, { startMin: 540, endMin: 570 });

    // The ends are pushed outward, so the range covers everything the thumb
    // passed over instead of shrinking away from it.
    assert.deepEqual(
      createRange({ anchorMin: 547, currentMin: 611, interval: 15, ...win }),
      { startMin: 540, endMin: 615 },
    );

    // Off the top of the window: clamped, never before it.
    const high = createRange({ anchorMin: -600, currentMin: 540, interval: 15, ...win });
    assert.equal(high.startMin, 480, 'clamped to the top of the visible window');
    assert.equal(high.endMin, 540);

    // Off the bottom: clamped, and still a whole slot long.
    const low = createRange({ anchorMin: 1180, currentMin: 5000, interval: 30, ...win });
    assert.equal(low.endMin, 1200, 'clamped to the bottom of the window');
    assert.ok(low.endMin > low.startMin);

    // A tap on the very last line of the grid must still make an event, which
    // means the range has to grow upward rather than off the end.
    for (const interval of INTERVALS) {
      const last = createRange({ anchorMin: 1200, currentMin: 1200, interval, ...win });
      assert.equal(last.endMin, 1200, `${interval}: pinned to the bottom edge`);
      assert.equal(last.endMin - last.startMin, interval, 'and still one slot long');
      assert.ok(last.startMin >= 480);
    }

    // Both ends outside, on the same side, and on opposite sides.
    for (const [a, b] of [[-500, -400], [3000, 4000], [-500, 4000]] as [number, number][]) {
      const r = createRange({ anchorMin: a, currentMin: b, interval: 15, ...win });
      assert.ok(r.startMin >= 480 && r.endMin <= 1200, `[${a},${b}] stays inside the window`);
      assert.ok(r.endMin > r.startMin, `[${a},${b}] is never inverted`);
    }

    // A window narrower than one slot is degenerate but must not invert.
    const tight = createRange({ anchorMin: 0, currentMin: 0, interval: 60, fromHour: 9, toHour: 9 });
    assert.ok(tight.endMin > tight.startMin, 'a zero-height window still yields a range');

    // Property sweep: whatever the drag, the result is inside the window, a
    // positive multiple of the interval long, and on grid lines.
    for (const interval of INTERVALS) {
      for (const fromHour of [0, 6, 9]) {
        for (const toHour of [12, 20, 24]) {
          const lo = fromHour * 60;
          const hi = toHour * 60;
          for (let a = lo - 120; a <= hi + 120; a += 37) {
            for (const d of [-500, -61, -7, 0, 1, 13, 90, 777]) {
              const r = createRange({ anchorMin: a, currentMin: a + d, interval, fromHour, toHour });
              const len = r.endMin - r.startMin;
              const label = `i=${interval} w=${fromHour}-${toHour} a=${a} d=${d}`;
              assert.ok(len > 0, `${label}: never zero or inverted`);
              assert.equal(len % interval, 0, `${label}: a whole number of slots`);
              assert.ok(r.startMin >= lo && r.endMin <= hi, `${label}: inside the window`);
              assert.equal(r.startMin % interval, 0, `${label}: start on a line`);
              assert.equal(r.endMin % interval, 0, `${label}: end on a line`);
              // Sorting the two points, so direction cannot matter.
              const flipped = createRange({
                anchorMin: a + d, currentMin: a, interval, fromHour, toHour,
              });
              assert.deepEqual(flipped, r, `${label}: the same range either way round`);
            }
          }
        }
      }
    }
  }

  console.log('--- 4. MOVING A BLOCK NEVER CHANGES ITS LENGTH ---');
  {
    const win = { fromHour: 8, toHour: 20 };

    const moved = moveBlock({ startMin: 540, endMin: 600, deltaMin: 60, interval: 15, ...win });
    assert.deepEqual(moved, { startMin: 600, endMin: 660 });

    // Upward.
    assert.deepEqual(
      moveBlock({ startMin: 540, endMin: 600, deltaMin: -60, interval: 30, ...win }),
      { startMin: 480, endMin: 540 },
    );

    // The delta is snapped, so the block lands on a line however far the thumb
    // actually travelled.
    assert.deepEqual(
      moveBlock({ startMin: 540, endMin: 600, deltaMin: 7, interval: 15, ...win }),
      { startMin: 540, endMin: 600 },
      'a seven minute drag at fifteen minute snap is not a move',
    );
    assert.deepEqual(
      moveBlock({ startMin: 540, endMin: 600, deltaMin: 8, interval: 15, ...win }),
      { startMin: 555, endMin: 615 },
    );

    // Off the top: the whole block clamps, keeping its two hours.
    const top = moveBlock({ startMin: 540, endMin: 660, deltaMin: -600, interval: 15, ...win });
    assert.equal(top.startMin, 480, 'flush with the top of the window');
    assert.equal(top.endMin! - top.startMin, 120, 'and still two hours long');

    // Off the bottom: the same, from the other end.
    const bottom = moveBlock({ startMin: 540, endMin: 660, deltaMin: 900, interval: 15, ...win });
    assert.equal(bottom.endMin, 1200, 'flush with the bottom');
    assert.equal(bottom.endMin! - bottom.startMin, 120, 'and still two hours long');

    // A block longer than the window itself pins to the top rather than
    // producing a start after its own end.
    const huge = moveBlock({ startMin: 480, endMin: 1500, deltaMin: 300, interval: 30, ...win });
    assert.equal(huge.startMin, 480);
    assert.equal(huge.endMin! - huge.startMin, 1020, 'length untouched even when it does not fit');

    // A null end stays null, and only the start is clamped.
    const open = moveBlock({ startMin: 540, endMin: null, deltaMin: 120, interval: 30, ...win });
    assert.deepEqual(open, { startMin: 660, endMin: null });
    const openLow = moveBlock({ startMin: 540, endMin: null, deltaMin: 9999, interval: 30, ...win });
    assert.deepEqual(openLow, { startMin: 1200, endMin: null },
      'an item with no end may sit on the last line');

    // A backwards end is not a negative duration.
    const backwards = moveBlock({ startMin: 600, endMin: 540, deltaMin: 0, interval: 15, ...win });
    assert.ok(backwards.endMin! >= backwards.startMin, 'a backwards block is not made worse');

    // Rubbish deltas are no-ops rather than NaN.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = moveBlock({ startMin: 540, endMin: 600, deltaMin: bad, interval: 15, ...win });
      assert.deepEqual(r, { startMin: 540, endMin: 600 }, `delta ${bad} moves nothing`);
    }

    // Property sweep: duration is preserved and the block stays in the window
    // whenever it fits.
    for (const interval of INTERVALS) {
      for (const [s, e] of [[540, 600], [480, 1200], [600, 605], [1140, 1200]] as [number, number][]) {
        for (let d = -900; d <= 900; d += 13) {
          const r = moveBlock({ startMin: s, endMin: e, deltaMin: d, interval, fromHour: 8, toHour: 20 });
          const label = `i=${interval} [${s},${e}] d=${d}`;
          assert.equal(r.endMin! - r.startMin, e - s, `${label}: duration preserved`);
          assert.ok(r.startMin >= 480, `${label}: not above the window`);
          if (e - s <= 720) assert.ok(r.endMin! <= 1200, `${label}: not below the window`);
        }
      }
    }
  }

  console.log('--- 5. RESIZING ---');
  {
    const win = { fromHour: 8, toHour: 20 };

    assert.deepEqual(
      resizeBlock({ startMin: 540, endMin: 600, pointerMin: 660, interval: 15, ...win }),
      { startMin: 540, endMin: 660 },
    );
    assert.deepEqual(
      resizeBlock({ startMin: 540, endMin: 600, pointerMin: 653, interval: 15, ...win }),
      { startMin: 540, endMin: 660 },
      'the pointer snaps to the nearest line',
    );

    // The minimum is at least MIN_BLOCK_MINUTES, rounded up to whole slots so
    // the handle stays on a grid line.
    assert.equal(minBlockMinutes(5), 20);
    assert.equal(minBlockMinutes(10), 20);
    assert.equal(minBlockMinutes(15), 30);
    assert.equal(minBlockMinutes(30), 30);
    assert.equal(minBlockMinutes(60), 60);
    for (const interval of INTERVALS) {
      const m = minBlockMinutes(interval);
      assert.ok(m >= MIN_BLOCK_MINUTES, `${interval}: never below the readable minimum`);
      assert.ok(m >= interval, `${interval}: never below one slot`);
      assert.equal(m % interval, 0, `${interval}: a whole number of slots`);
    }

    // Dragging the handle up through the start must not invert the block.
    for (const interval of INTERVALS) {
      for (const pointer of [540, 500, 0, -600, -1e6]) {
        const r = resizeBlock({ startMin: 540, endMin: 600, pointerMin: pointer, interval, ...win });
        assert.equal(r.startMin, 540, `${interval}/${pointer}: the start is never touched`);
        assert.equal(r.endMin, 540 + minBlockMinutes(interval),
          `${interval}/${pointer}: pinned at the minimum length`);
        assert.ok(r.endMin > r.startMin, 'never inverted');
      }
    }

    // Dragging it below the bottom of the window clamps there.
    const low = resizeBlock({ startMin: 540, endMin: 600, pointerMin: 5000, interval: 30, ...win });
    assert.deepEqual(low, { startMin: 540, endMin: 1200 });

    // A block starting on the very last line is allowed to overhang, because a
    // zero-height block cannot be grabbed again.
    const edge = resizeBlock({ startMin: 1200, endMin: null, pointerMin: 1200, interval: 30, ...win });
    assert.equal(edge.endMin - edge.startMin, 30, 'the minimum wins over the window');

    // An item with no end gets one.
    const open = resizeBlock({ startMin: 540, endMin: null, pointerMin: 630, interval: 15, ...win });
    assert.deepEqual(open, { startMin: 540, endMin: 630 });

    // Rubbish pointer falls back to the minimum rather than NaN.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = resizeBlock({ startMin: 540, endMin: 600, pointerMin: bad, interval: 30, ...win });
      assert.ok(Number.isFinite(r.endMin) && r.endMin > r.startMin, `pointer ${bad} is survivable`);
    }

    // Property sweep.
    for (const interval of INTERVALS) {
      for (const start of [480, 540, 900, 1170, 1200]) {
        for (let pm = 300; pm <= 1500; pm += 17) {
          const r = resizeBlock({ startMin: start, endMin: null, pointerMin: pm, interval, ...win });
          const label = `i=${interval} s=${start} p=${pm}`;
          assert.equal(r.startMin, start, `${label}: start untouched`);
          assert.ok(r.endMin - r.startMin >= minBlockMinutes(interval), `${label}: at least the minimum`);
          // The end lands on a grid line, unless a clamp had the last word: the
          // bottom of the window, or the minimum length measured from a start
          // that was itself off the grid (the start is never moved to fix that,
          // because the user is dragging the bottom edge, not the block).
          assert.ok(
            r.endMin % interval === 0
              || r.endMin === 1200
              || r.endMin === start + minBlockMinutes(interval),
            `${label}: the end is on a line or on a clamp`,
          );
        }
      }
    }
  }

  console.log('--- 6. WHICH COLUMN THE THUMB IS OVER ---');
  {
    // A seven day week, 48pt rail, 350pt wide: 43.14pt a column.
    const rail = 48;
    const total = 350;
    const w = (total - rail) / 7;

    assert.equal(columnAtX(rail, rail, total, 7), 0, 'the left edge of the first column');
    assert.equal(columnAtX(rail + w - 0.001, rail, total, 7), 0, 'just inside it');
    assert.equal(columnAtX(rail + w, rail, total, 7), 1, 'exactly on a boundary belongs to the right');
    assert.equal(columnAtX(rail + w * 6, rail, total, 7), 6, 'the last column');
    assert.equal(columnAtX(total - 0.001, rail, total, 7), 6);

    // Outside both edges: clamped, not dropped. A thumb on the hour rail is
    // still clearly aiming at Monday.
    assert.equal(columnAtX(0, rail, total, 7), 0);
    assert.equal(columnAtX(-500, rail, total, 7), 0);
    assert.equal(columnAtX(total, rail, total, 7), 6, 'exactly the right edge is the last column');
    assert.equal(columnAtX(9999, rail, total, 7), 6);

    // Every boundary, for every column count the views use.
    for (const count of [1, 2, 3, 4, 5, 7, 10]) {
      const cw = (total - rail) / count;
      for (let c = 0; c < count; c += 1) {
        assert.equal(columnAtX(rail + cw * c, rail, total, count), c, `${count}: boundary ${c}`);
        assert.equal(columnAtX(rail + cw * c + cw / 2, rail, total, count), c, `${count}: middle ${c}`);
        assert.equal(columnAtX(rail + cw * (c + 1) - 1e-6, rail, total, count), c,
          `${count}: just before boundary ${c + 1}`);
      }
      // Never out of range, whatever is thrown at it.
      for (let x = -100; x <= total + 100; x += 3.7) {
        const c = columnAtX(x, rail, total, count);
        assert.ok(Number.isInteger(c) && c >= 0 && c < count, `${count}: x=${x} gives a real column`);
      }
    }

    // The day view is one column, so everything is column zero.
    assert.equal(columnAtX(9999, rail, total, 1), 0);
    assert.equal(columnAtX(-9999, rail, total, 1), 0);

    // Degenerate geometry, which happens on the very first layout pass before
    // the view has been measured.
    assert.equal(columnAtX(100, 48, 0, 7), 0, 'an unmeasured view has no columns to hit');
    assert.equal(columnAtX(100, 48, 48, 7), 0);
    assert.equal(columnAtX(100, rail, total, 0), 0);
    assert.equal(columnAtX(100, rail, total, -3), 0);
    assert.equal(columnAtX(NaN, rail, total, 7), 0);
    assert.equal(columnAtX(100, NaN, total, 7), columnAtX(100, 0, total, 7),
      'a missing rail width reads as no rail, not as NaN');
    assert.ok(Number.isInteger(columnAtX(100, rail, NaN, 7)));
  }

  console.log('\nALL PASS (dragGrid: snapping, create, move, resize, columns)');
}

main();
