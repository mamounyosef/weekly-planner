// Tests for the "Go to Live" scroll computation.
//
// The bug this guards against was not a wrong offset -- it was the WRONG BOX
// MOVING. `scrollIntoView({ block: 'center' })` walks every scrollable ancestor
// of the now-line, and the line sits inside the today column's clipped grid, so
// a stray overflow range there let the button scroll one day column out from
// under itself while the rest of the week stayed put. The fix is a single
// measured container and one scrollTop, and these tests pin the arithmetic of
// that single box: every clamp, every degenerate measurement, zoom on both
// sides, and the property that the answer actually centres the line.
//
// Run with: npx tsx src/lib/liveScroll.test.ts

import assert from 'node:assert/strict';
import { liveScrollTarget, clampScrollTop, type LiveScrollMeasurements } from './liveScroll';

// A realistic desktop shape: a 1000px-tall scroller showing a day grid that is
// 4600px of content (5-minute slots across 24h at ~192px/hour), scrolled part
// way, with the line sitting somewhere in the visible window.
const base = (over: Partial<LiveScrollMeasurements> = {}): LiveScrollMeasurements => ({
  scrollTop: 1000,
  clientHeight: 1000,
  boundingTop: 96,
  boundingHeight: 1000,
  scrollHeight: 4600,
  lineTop: 400,
  lineHeight: 0,
  ...over,
});

// Where the line's centre lands on screen (visual px) after a given scrollTop,
// given the same geometry: content offset of the line is fixed.
const lineContentTop = (m: LiveScrollMeasurements) =>
  m.lineTop - m.boundingTop + m.scrollTop; // visual -> content px, for the unzoomed case

async function main() {
  console.log('--- 1. CENTRING IS EXACT WHEN NOTHING CLAMPS ---');
  {
    for (const lineTop of [96, 200, 596, 800, 1050]) {
      const m = base({ lineTop });
      const target = liveScrollTarget(m);
      // After scrolling, the line's content top must sit exactly one
      // half-viewport below the new scrollTop (centre of the window).
      assert.ok(
        Math.abs((lineContentTop(m) - target) - m.clientHeight / 2) < 1e-9,
        `lineTop ${lineTop}: centred, got offset ${lineContentTop(m) - target}`,
      );
    }
    console.log('  ok');
  }

  console.log('--- 2. A LINE ALREADY CENTRED DOES NOT MOVE THE SCROLLER ---');
  {
    const centred = base({ lineTop: 96 + 500 }); // centre of the 1000px window
    assert.equal(liveScrollTarget(centred), 1000);
    // Including a fractional resting offset, which smooth scrolling really
    // produces: a hair off centre must move by exactly that hair.
    const almost = base({ lineTop: 96 + 500 - 0.5 });
    assert.ok(Math.abs(liveScrollTarget(almost) - 999.5) < 1e-9);
    console.log('  ok');
  }

  console.log('--- 3. DIRECTION: LINE ABOVE CENTRE SCROLLS UP, BELOW SCROLLS DOWN ---');
  {
    // The line sits high in the window: centring it means scrolling UP (the
    // content slides down). A line low in the window means scrolling DOWN.
    assert.ok(liveScrollTarget(base({ lineTop: 96 + 100 })) < 1000, 'line high in the window -> scroll up');
    assert.ok(liveScrollTarget(base({ lineTop: 96 + 900 })) > 1000, 'line low in the window -> scroll down');
    assert.equal(liveScrollTarget(base({ lineTop: 96 })), 500, 'line at the very top edge');
    assert.equal(liveScrollTarget(base({ lineTop: 96 + 999 })), 1499, 'line at the very bottom edge');
    console.log('  ok');
  }

  console.log('--- 4. THE TOP CLAMP: A LINE NEAR THE DAY START ---');
  {
    // Centre would demand a negative scrollTop; zero is the honest answer.
    assert.equal(liveScrollTarget(base({ scrollTop: 0, lineTop: 96 + 100 })), 0);
    assert.equal(liveScrollTarget(base({ scrollTop: 0, lineTop: 96 })), 0);
    // Exactly on the clamp boundary: target 0 must be reachable exactly.
    const exact = base({ scrollTop: 0, lineTop: 96 + 500 });
    assert.equal(liveScrollTarget(exact), 0);
    // Half a pixel of scroll room is used, not clamped away.
    assert.equal(liveScrollTarget(base({ scrollTop: 0.5, lineTop: 96 + 500 })), 0.5);
    console.log('  ok');
  }

  console.log('--- 5. THE BOTTOM CLAMP: A LINE NEAR THE DAY END ---');
  {
    const max = 4600 - 1000; // 3600
    // A line whose centre would sit past the end of the content bottoms out.
    assert.equal(liveScrollTarget(base({ scrollTop: 3600, lineTop: 96 + 1400 })), max);
    assert.equal(liveScrollTarget(base({ scrollTop: 3600, lineTop: 96 + 5000 })), max);
    // And it must never exceed max from ANY starting offset.
    for (const top of [0, 500, 3599, 3600]) {
      assert.ok(liveScrollTarget(base({ scrollTop: top, lineTop: 96 + 4000 })) <= max);
    }
    console.log('  ok');
  }

  console.log('--- 6. CONTENT SHORTER THAN THE WINDOW CANNOT SCROLL AT ALL ---');
  {
    // Zoomed out far, or a short custom day: max scroll is 0, so every answer
    // is 0 no matter where the line claims to be.
    for (const lineTop of [-1000, 0, 96, 500, 99999]) {
      assert.equal(liveScrollTarget(base({ scrollHeight: 800, scrollTop: 0, lineTop })), 0);
    }
    // Content exactly equal to the window: same.
    assert.equal(liveScrollTarget(base({ scrollHeight: 1000, scrollTop: 0 })), 0);
    console.log('  ok');
  }

  console.log('--- 7. A TALL LINE IS CENTRED BY ITS MIDDLE, NOT ITS TOP ---');
  {
    // The line element carries a glow that can give it real height.
    const m = base({ lineTop: 96 + 100, lineHeight: 40 });
    const target = liveScrollTarget(m);
    // Centre of the line = 120 content px below its top...
    assert.ok(Math.abs((lineContentTop(m) + 20 - target) - m.clientHeight / 2) < 1e-9);
    // ...which is 20px less of a scroll than centring the top would be.
    assert.equal(target, liveScrollTarget(base({ lineTop: 96 + 120, lineHeight: 0 })));
    // Negative height is nonsense; it must not push the centre anywhere odd.
    assert.equal(
      liveScrollTarget(base({ lineTop: 96 + 100, lineHeight: -40 })),
      liveScrollTarget(base({ lineTop: 96 + 100 })),
    );
    console.log('  ok');
  }

  console.log('--- 8. UNMEASURED LAYOUT NEVER FLINGS THE USER ---');
  {
    // A rect read before layout, a hidden tab, a split-view collapse: every
    // broken number must answer "stay put" (or a valid clamp), never NaN and
    // never a wild offset.
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const n of bad) {
      assert.equal(liveScrollTarget(base({ scrollTop: n })), 0, `scrollTop ${n}`);
      assert.equal(liveScrollTarget(base({ clientHeight: n })), 0, `clientHeight ${n}`);
      assert.equal(liveScrollTarget(base({ scrollHeight: n })), 1000, `scrollHeight ${n}`);
      assert.equal(liveScrollTarget(base({ boundingTop: n })), 1000, `boundingTop ${n}`);
      assert.equal(liveScrollTarget(base({ boundingHeight: n })), 1000, `boundingHeight ${n}`);
      assert.equal(liveScrollTarget(base({ lineTop: n })), 1000, `lineTop ${n}`);
      assert.equal(liveScrollTarget(base({ lineHeight: n })), liveScrollTarget(base()), `lineHeight ${n}`);
    }
    console.log('  ok');
  }

  console.log('--- 9. A ZERO-SIZED WINDOW ---');
  {
    // Before the first layout pass, or the grid collapsed to nothing. There is
    // nothing to scroll and no way to aim; the answer must be "don't".
    assert.equal(liveScrollTarget(base({ clientHeight: 0 })), 0);
    assert.equal(liveScrollTarget(base({ clientHeight: -100 })), 0);
    // A sliver of a window is technically aimable; the answer must at least
    // stay a legal offset for the measured container.
    const sliver = liveScrollTarget(base({ clientHeight: 0.0001 }));
    assert.ok(Number.isFinite(sliver) && sliver >= 0 && sliver <= 3600, `sliver -> ${sliver}`);
    console.log('  ok');
  }

  console.log('--- 10. CSS ZOOM: VISUAL PIXELS ARE DIVIDED BACK TO LAYOUT PIXELS ---');
  {
    // Phone content zoom 1.25: rects report 1.25x, offsets report 1x. The
    // delta measured in visual px MUST shrink by the ratio before it touches
    // scrollTop, or every scroll overshoots by a quarter.
    const zoom = 1.25;
    const m = base({
      boundingTop: 96 * zoom,
      boundingHeight: 1000 * zoom,
      lineTop: (96 + 200) * zoom, // line 200 layout px below the window's top edge
    });
    const target = liveScrollTarget(m);
    // Unzoomed equivalent: line 200 below the top edge -> scrollTop 1000 + 300 - ... centred.
    const plain = liveScrollTarget(base({ lineTop: 96 + 200 }));
    assert.ok(Math.abs(target - plain) < 1e-9, `zoomed target ${target} must equal plain ${plain}`);
    // And zoom 0.5 (zoomed out) agrees with the same plain answer.
    const half = liveScrollTarget(base({
      boundingTop: 48, boundingHeight: 500, lineTop: (96 + 200) * 0.5,
    }));
    assert.ok(Math.abs(half - plain) < 1e-9);
    console.log('  ok');
  }

  console.log('--- 11. BROWSER ZOOM SCALES BOTH SIDES AND IS A NO-OP ON THE RATIO ---');
  {
    // Ctrl +/- zoom scales rects AND layout px together, so the ratio stays 1
    // and the raw visual delta is already in layout px.
    const m = base({ boundingTop: 144, boundingHeight: 1500, clientHeight: 1500, scrollHeight: 6900, lineTop: 144 + 300 });
    const target = liveScrollTarget(m);
    assert.ok(Math.abs((lineContentTop(m) - target) - 750) < 1e-9);
    console.log('  ok');
  }

  console.log('--- 12. A COLLAPSED RECT FALLS BACK TO RATIO 1 ---');
  {
    // boundingHeight 0 with a live clientHeight (display flip, hidden preview):
    // dividing by the ratio would be an infinity, so the ratio must be treated
    // as 1 and the answer must stay finite and inside the legal range.
    const t = liveScrollTarget(base({ boundingHeight: 0 }));
    assert.ok(Number.isFinite(t), 'finite');
    assert.ok(t >= 0 && t <= 3600, `in range, got ${t}`);
    console.log('  ok');
  }

  console.log('--- 13. CONVERGENCE: SCROLLING THERE MAKES A SECOND MEASUREMENT AGREE ---');
  {
    // The pill recomputes on every scroll frame. Wherever the day starts, the
    // target measured AFTER arriving must equal the target measured before --
    // one smooth scroll, no drift, no oscillation.
    for (const start of [0, 137.5, 1000, 3599]) {
      const m = base({ scrollTop: start, lineTop: 96 + 300 });
      const target = liveScrollTarget(m);
      // After the scroll the line's visual top moved up by (start - target) layout px.
      const after = liveScrollTarget({ ...m, scrollTop: target, lineTop: 96 + 300 + (start - target) });
      assert.ok(Math.abs(after - target) < 1e-9, `from ${start}: ${after} != ${target}`);
    }
    console.log('  ok');
  }

  console.log('--- 14. SUB-PIXEL INPUTS ARE DETERMINISTIC ---');
  {
    // Fractional scroll offsets and rect tops are what browsers actually
    // report. Same input, same answer, every time; no rounding drift.
    const m = base({ scrollTop: 1234.5678, lineTop: 405.123456 });
    const a = liveScrollTarget(m);
    const b = liveScrollTarget(m);
    assert.equal(a, b);
    assert.ok(Number.isFinite(a));
    // And a 1e-9 nudge to the line moves the target by exactly that nudge.
    assert.ok(Math.abs(liveScrollTarget({ ...m, lineTop: m.lineTop + 1e-9 }) - a - 1e-9) < 1e-10);
    console.log('  ok');
  }

  console.log('--- 15. EXTREME BUT LEGAL GEOMETRY ---');
  {
    // A 5-minute slot grid on a 4K portrait window: huge content, huge window.
    const huge = base({ clientHeight: 4000, boundingHeight: 4000, scrollHeight: 27600, scrollTop: 12000, lineTop: 96 + 10000 });
    assert.ok(Math.abs((lineContentTop(huge) - liveScrollTarget(huge)) - 2000) < 1e-9);
    // A one-pixel window over a one-pixel of slack.
    const tiny = base({ clientHeight: 1, boundingHeight: 1, scrollHeight: 2, scrollTop: 0, lineTop: 96 });
    assert.ok([0, 1].includes(liveScrollTarget(tiny)), 'clamped into the 0..1 range');
    // Safe-integer scale: no overflow into nonsense.
    const vast = clampScrollTop(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1000);
    assert.equal(vast, Number.MAX_SAFE_INTEGER - 1000);
    console.log('  ok');
  }

  console.log('--- 16. clampScrollTop ALONE ---');
  {
    assert.equal(clampScrollTop(-1, 4600, 1000), 0, 'never negative');
    assert.equal(clampScrollTop(-1e9, 4600, 1000), 0);
    assert.equal(clampScrollTop(3600, 4600, 1000), 3600, 'the max is reachable');
    assert.equal(clampScrollTop(3601, 4600, 1000), 3600, 'never past the content');
    assert.equal(clampScrollTop(9999, 800, 1000), 0, 'content shorter than window');
    assert.equal(clampScrollTop(500, 1000, 1000), 0, 'content equal to window');
    assert.equal(clampScrollTop(500, 0, 0), 0, 'nothing measured');
    assert.equal(clampScrollTop(Number.NaN, 4600, 1000), 0, 'unreadable offset reads as the top');
    assert.equal(clampScrollTop(Number.POSITIVE_INFINITY, 4600, 1000), 3600);
    assert.equal(clampScrollTop(Number.NEGATIVE_INFINITY, 4600, 1000), 0);
    assert.equal(clampScrollTop(100.5, 4600, 1000), 100.5, 'fractional offsets pass through');
    console.log('  ok');
  }

  console.log('--- 17. THE PROPERTY THE BUG BROKE: THE ANSWER FEEDS EXACTLY ONE BOX ---');
  {
    // The function returns a scrollTop; it never returns a delta to be added to
    // "whatever the browser decides". The value is always inside what the
    // measured container can legally do, for any input sweep.
    for (let top = -2000; top <= 5000; top += 137) {
      for (let line = -500; line <= 5000; line += 173) {
        const t = liveScrollTarget(base({ scrollTop: top, lineTop: 96 + line }));
        assert.ok(t >= 0 && t <= 3600, `top ${top}, line ${line} -> ${t} outside 0..3600`);
      }
    }
    console.log('  ok');
  }

  console.log('--- 18. IT IS A PURE FUNCTION OF WHAT IT IS GIVEN ---');
  {
    const m = base({ scrollTop: 987.654 });
    const before = JSON.stringify(m);
    liveScrollTarget(m);
    clampScrollTop(1, 2, 3);
    assert.equal(JSON.stringify(m), before, 'the measurements are not touched');
    console.log('  ok');
  }

  console.log('\nAll liveScroll tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
