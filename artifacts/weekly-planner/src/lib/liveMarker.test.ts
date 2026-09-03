// Tests for the "go to live" pill's two questions.
//
// The failure this guards against is not a wrong number, it is a pill that
// blinks. The predicate is evaluated on every scroll frame, so any input it
// answers inconsistently -- a NaN from an unmeasured layout, a viewport of
// zero before the first pass, a line exactly on a boundary -- becomes a control
// flickering under a resting thumb.
//
// Run with: npx tsx src/lib/liveMarker.test.ts

import assert from 'node:assert/strict';
import {
  nowLineOffscreen, goToLiveOffset, TOP_ALLOWANCE, BOTTOM_ALLOWANCE,
} from './liveMarker';

const view = (over: Partial<Parameters<typeof nowLineOffscreen>[0]> = {}) => ({
  scrollY: 0,
  viewport: 800,
  timelineY: 200,
  nowLineY: 300,
  ...over,
});

async function main() {
  console.log('--- 1. A LINE IN THE MIDDLE IS NOT OFF SCREEN ---');
  {
    assert.equal(nowLineOffscreen(view()), false);
    assert.equal(nowLineOffscreen(view({ scrollY: 100 })), false);
    assert.equal(nowLineOffscreen(view({ scrollY: 400 })), false);
    console.log('  ok');
  }

  console.log('--- 2. NO LINE, NO PILL ---');
  {
    // Any day that is not today. The pill would offer to scroll to nowhere.
    for (const scrollY of [-500, 0, 500, 99999]) {
      assert.equal(nowLineOffscreen(view({ nowLineY: null, scrollY })), false, `scrolled to ${scrollY}`);
    }
    assert.equal(goToLiveOffset(view({ nowLineY: null })), 0);
    console.log('  ok');
  }

  console.log('--- 3. SCROLLED PAST IT: THE EXACT BOUNDARY ---');
  {
    // Line at 500. It is gone once 500 + 30 is above the top of the window.
    const line = 500;
    assert.equal(nowLineOffscreen(view({ scrollY: line + TOP_ALLOWANCE })), false, 'exactly level is still here');
    assert.equal(nowLineOffscreen(view({ scrollY: line + TOP_ALLOWANCE - 1 })), false, 'a hair short');
    assert.equal(nowLineOffscreen(view({ scrollY: line + TOP_ALLOWANCE + 1 })), true, 'a hair past');
    console.log('  ok');
  }

  console.log('--- 4. NOT SCROLLED FAR ENOUGH: THE OTHER BOUNDARY ---');
  {
    // Line at 500, window 800 tall. The bottom 100 is the button and the bar,
    // so the line counts as gone once it passes 700 below the scroll offset.
    const usable = 800 - BOTTOM_ALLOWANCE;
    assert.equal(nowLineOffscreen(view({ scrollY: 500 - usable })), false, 'exactly at the usable edge');
    assert.equal(nowLineOffscreen(view({ scrollY: 500 - usable - 1 })), true, 'one past it, below the fold');
    assert.equal(nowLineOffscreen(view({ scrollY: 500 - usable + 1 })), false, 'one inside it');
    console.log('  ok');
  }

  console.log('--- 5. THE TWO EDGES NEVER BOTH FIRE, AND NEVER BOTH MISS ---');
  {
    // Sweep the whole scroll range past a line and check the answer changes
    // exactly twice: gone, here, gone. A third change is a flicker.
    const flips: number[] = [];
    let last = nowLineOffscreen(view({ scrollY: -2000 }));
    for (let y = -2000; y <= 2000; y += 1) {
      const now = nowLineOffscreen(view({ scrollY: y }));
      if (now !== last) flips.push(y);
      last = now;
    }
    assert.equal(flips.length, 2, `two transitions, got ${flips.length}`);
    assert.ok(flips[0] < flips[1], 'and they are in order');
    // Between them, it is on screen the whole way.
    for (let y = flips[0]; y < flips[1]; y += 7) {
      assert.equal(nowLineOffscreen(view({ scrollY: y })), false, `visible at ${y}`);
    }
    console.log('  ok');
  }

  console.log('--- 6. THE SAME SWEEP FOR EVERY SHAPE OF DAY ---');
  {
    const shapes = [
      { viewport: 300, timelineY: 0, nowLineY: 0 },
      { viewport: 300, timelineY: 0, nowLineY: 5000 },
      { viewport: 2000, timelineY: 1200, nowLineY: 900 },
      { viewport: 101, timelineY: 0, nowLineY: 0 },
      { viewport: 800, timelineY: 0, nowLineY: 0 },
    ];
    for (const shape of shapes) {
      let flips = 0;
      let last = nowLineOffscreen(view({ ...shape, scrollY: -9000 }));
      for (let y = -9000; y <= 9000; y += 3) {
        const now = nowLineOffscreen(view({ ...shape, scrollY: y }));
        if (now !== last) flips += 1;
        last = now;
      }
      assert.ok(flips <= 2, `${JSON.stringify(shape)} flipped ${flips} times`);
    }
    console.log('  ok');
  }

  console.log('--- 7. A WINDOW SHORTER THAN THE ALLOWANCE ---');
  {
    // Before the first layout pass, and on a split screen. The usable band is
    // empty or negative, so the line is always "gone" -- which is honest, and
    // must not oscillate.
    for (const viewport of [0, 1, 50, BOTTOM_ALLOWANCE]) {
      const a = nowLineOffscreen(view({ viewport, scrollY: 0 }));
      const b = nowLineOffscreen(view({ viewport, scrollY: 0 }));
      assert.equal(a, b, 'the same answer twice');
      assert.equal(typeof a, 'boolean');
    }
    console.log('  ok');
  }

  console.log('--- 8. UNMEASURED LAYOUT IS NEVER A PILL ---');
  {
    // `onLayout` has not run, or ran with a broken value. Showing a control that
    // scrolls to NaN is worse than showing nothing.
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const n of bad) {
      assert.equal(nowLineOffscreen(view({ scrollY: n })), false, `scrollY ${n}`);
      assert.equal(nowLineOffscreen(view({ viewport: n })), false, `viewport ${n}`);
      assert.equal(nowLineOffscreen(view({ timelineY: n })), false, `timelineY ${n}`);
      assert.equal(nowLineOffscreen(view({ nowLineY: n })), false, `nowLineY ${n}`);
      assert.equal(goToLiveOffset(view({ viewport: n })), 0, `offset for viewport ${n}`);
      assert.equal(goToLiveOffset(view({ timelineY: n })), 0);
      assert.equal(goToLiveOffset(view({ nowLineY: n })), 0);
    }
    console.log('  ok');
  }

  console.log('--- 9. WHERE IT SCROLLS TO ---');
  {
    // Line at 200 + 300 = 500, window 800: centred means 500 - 400 + 50 = 150.
    assert.equal(goToLiveOffset(view()), 150);
    // A line near the top cannot pull the scroller above zero.
    assert.equal(goToLiveOffset(view({ timelineY: 0, nowLineY: 0 })), 0);
    assert.equal(goToLiveOffset(view({ timelineY: 0, nowLineY: 100 })), 0);
    // A tall window over a line low down.
    assert.equal(goToLiveOffset(view({ viewport: 400, timelineY: 1000, nowLineY: 500 })), 1350);
    // It never returns a negative offset, whatever the shape.
    for (let v = 0; v < 3000; v += 97) {
      for (let line = 0; line < 3000; line += 173) {
        assert.ok(goToLiveOffset(view({ viewport: v, timelineY: 0, nowLineY: line })) >= 0);
      }
    }
    console.log('  ok');
  }

  console.log('--- 10. SCROLLING THERE MAKES THE PILL GO AWAY ---');
  {
    // The property that matters: the button does what it offers. Wherever the
    // day is, scrolling to the offset must leave the line on screen -- so the
    // pill cannot survive its own tap.
    for (const viewport of [300, 500, 800, 1200, 2000]) {
      for (const timelineY of [0, 120, 900]) {
        for (const nowLineY of [0, 40, 700, 3000]) {
          const target = goToLiveOffset({ scrollY: 0, viewport, timelineY, nowLineY });
          const after = nowLineOffscreen({ scrollY: target, viewport, timelineY, nowLineY });
          // Only possible when the window is too short to hold the line clear
          // of the bottom furniture at all, which is the 0-viewport case.
          if (viewport > BOTTOM_ALLOWANCE + TOP_ALLOWANCE) {
            assert.equal(after, false,
              `still off screen after scrolling: viewport ${viewport}, line ${timelineY}+${nowLineY}`);
          }
        }
      }
    }
    console.log('  ok');
  }

  console.log('--- 11. IT IS A PURE FUNCTION OF WHAT IT IS GIVEN ---');
  {
    const v = view({ scrollY: 123.456 });
    const before = JSON.stringify(v);
    nowLineOffscreen(v);
    goToLiveOffset(v);
    assert.equal(JSON.stringify(v), before, 'the input is not touched');
    assert.equal(nowLineOffscreen(v), nowLineOffscreen(v), 'the same answer every time');
    console.log('  ok');
  }

  console.log('--- 12. FRACTIONAL OFFSETS, WHICH IS WHAT A SCROLLER ACTUALLY GIVES ---');
  {
    // Android reports sub-pixel offsets. Nothing here may round in a way that
    // makes two consecutive frames disagree.
    let last = nowLineOffscreen(view({ scrollY: 0 }));
    let flips = 0;
    for (let y = 0; y <= 1200; y += 0.37) {
      const now = nowLineOffscreen(view({ scrollY: y }));
      if (now !== last) flips += 1;
      last = now;
    }
    assert.ok(flips <= 2, `flipped ${flips} times across a fractional sweep`);
    console.log('  ok');
  }

  console.log('\nAll liveMarker tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
