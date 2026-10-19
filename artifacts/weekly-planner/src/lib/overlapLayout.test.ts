// Tests the layout of overlapping blocks in a day column.
//
// THE PROPERTIES THAT MATTER
//   1. Nothing is ever drawn on top of anything: at every moment, the blocks
//      running then never share a pixel of width (both modes).
//   2. 'fit': at every moment the blocks running then fill the column exactly,
//      so a block that is alone is full width, and a block only narrows for
//      the minutes it actually shares.
//   3. Every block stays inside its column, and its segments are contiguous and
//      cover exactly its own time.
//   4. Blocks that share time agree on one column order, so they line up.
//      (The old layout let each block pick its own column count, which drew
//      Friday Prayer half on top of the block to its left.)
//
// Run with: npx tsx src/lib/overlapLayout.test.ts

import assert from 'node:assert/strict';
import {
  layoutOverlaps,
  overlapBoxCss,
  overlapClipPath,
  overlapContentArea,
  isRectangular,
  segmentRects,
  contentSegmentIndex,
  coerceOverlapLayoutMode,
  type OverlapInput,
  type OverlapLayoutMode,
  type OverlapBox,
  type OverlapSegment,
} from './overlapLayout';

const h = (id: string, startH: number, endH: number): OverlapInput =>
  ({ id, startMin: Math.round(startH * 60), endMin: Math.round(endH * 60) });

const EPS = 1e-9;
const effEnd = (i: OverlapInput) => (Number.isFinite(i.endMin) ? Math.max(i.endMin, i.startMin + 1) : i.startMin + 1);

/** The segment of `box` covering minute `t`, if any. */
const segAt = (box: OverlapBox, t: number): OverlapSegment | undefined =>
  box.segments.find(s => s.fromMin <= t && t < s.toMin);

function checkInvariants(items: OverlapInput[], mode: OverlapLayoutMode, label: string) {
  const out = layoutOverlaps(items, { mode });
  const valid = items.filter(i => i && typeof i.id === 'string' && Number.isFinite(i.startMin));
  const firstById = new Map<string, OverlapInput>();
  for (const i of valid) if (!firstById.has(i.id)) firstById.set(i.id, i);
  assert.equal(out.size, firstById.size, `${label}: one box per distinct id`);

  for (const [id, b] of out) {
    const it = firstById.get(id)!;
    assert.ok(b.segments.length >= 1, `${label}: ${id} has segments`);
    assert.equal(b.segments[0].fromMin, it.startMin, `${label}: ${id} starts at its start`);
    assert.equal(b.segments[b.segments.length - 1].toMin, effEnd(it), `${label}: ${id} ends at its end`);
    for (let k = 0; k < b.segments.length; k++) {
      const s = b.segments[k];
      assert.ok(s.toMin > s.fromMin, `${label}: ${id} segment has length`);
      if (k > 0) assert.equal(s.fromMin, b.segments[k - 1].toMin, `${label}: ${id} segments are contiguous`);
      assert.ok(s.left >= -EPS && s.width > 0 && s.left + s.width <= 1 + EPS, `${label}: ${id} inside the column`);
      assert.ok(s.left >= b.left - EPS && s.left + s.width <= b.left + b.width + EPS, `${label}: ${id} inside its box`);
      if (k > 0) {
        const p = b.segments[k - 1];
        assert.ok(!(Math.abs(p.left - s.left) < EPS && Math.abs(p.width - s.width) < EPS), `${label}: ${id} neighbours are merged`);
      }
    }
    if (mode === 'columns') assert.ok(isRectangular(b), `${label}: columns mode never steps`);
  }

  // Probe every boundary and every midpoint.
  const times = new Set<number>();
  for (const b of out.values()) for (const s of b.segments) { times.add(s.fromMin); times.add((s.fromMin + s.toMin) / 2); }
  for (const t of times) {
    const live = [...out.entries()].map(([id, b]) => ({ id, s: segAt(b, t) })).filter(x => x.s) as { id: string; s: OverlapSegment }[];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i].s, c = live[j].s;
        const share = a.left < c.left + c.width - EPS && c.left < a.left + a.width - EPS;
        assert.ok(!share, `${label}: ${live[i].id} and ${live[j].id} share width at minute ${t}`);
      }
    }
    if (mode === 'fit' && live.length > 0) {
      const total = live.reduce((acc, x) => acc + x.s.width, 0);
      assert.ok(Math.abs(total - 1) < 1e-6, `${label}: at minute ${t} the column is filled exactly (got ${total})`);
    }
  }
  return out;
}

function main() {
  console.log('--- 1. BASICS ---');
  {
    for (const mode of ['fit', 'columns'] as const) {
      assert.equal(layoutOverlaps([], { mode }).size, 0, 'nothing in, nothing out');
      const one = layoutOverlaps([h('a', 9, 10)], { mode }).get('a')!;
      assert.deepEqual(one, { left: 0, width: 1, segments: [{ fromMin: 540, toMin: 600, left: 0, width: 1 }] });
      const apart = layoutOverlaps([h('a', 9, 10), h('b', 10, 11)], { mode });
      assert.equal(apart.get('a')!.width, 1, 'touching is not overlapping');
      assert.equal(apart.get('b')!.width, 1);
    }
    assert.equal(coerceOverlapLayoutMode('columns'), 'columns');
    for (const v of ['fit', 'stack', undefined, null, 'COLUMNS', 3, {}]) {
      assert.equal(coerceOverlapLayoutMode(v), 'fit', `${String(v)} -> fit`);
    }
  }

  console.log('--- 2. THE SLEEP CASE ---');
  {
    // Sat 10: sleep 0:00-8:05, AI Quest 8:00-12:00.
    const items = [h('sleep', 0, 8 + 5 / 60), h('quest', 8, 12)];
    const fit = checkInvariants(items, 'fit', 'sleep/fit');
    assert.deepEqual(fit.get('sleep')!.segments, [
      { fromMin: 0, toMin: 480, left: 0, width: 1 },
      { fromMin: 480, toMin: 485, left: 0, width: 0.5 },
    ], 'sleep is full width until 8:00, then the left half until 8:05');
    assert.deepEqual(fit.get('quest')!.segments, [
      { fromMin: 480, toMin: 485, left: 0.5, width: 0.5 },
      { fromMin: 485, toMin: 720, left: 0, width: 1 },
    ], 'quest is the right half until sleep ends, then full width');
    assert.deepEqual({ l: fit.get('sleep')!.left, w: fit.get('sleep')!.width }, { l: 0, w: 1 });

    const cols = checkInvariants(items, 'columns', 'sleep/columns');
    assert.deepEqual(cols.get('sleep')!.segments, [{ fromMin: 0, toMin: 485, left: 0, width: 0.5 }], 'columns: half the whole way, as before');
    assert.deepEqual(cols.get('quest')!.segments, [{ fromMin: 480, toMin: 720, left: 0.5, width: 0.5 }]);

    // Sun 11: sleep 0:00-8:20, Going to University 7:00-8:30.
    const sun = checkInvariants([h('sleep', 0, 8 + 20 / 60), h('uni', 7, 8.5)], 'fit', 'sun/fit');
    assert.deepEqual(sun.get('sleep')!.segments.map(s => [s.fromMin, s.toMin, s.width]), [[0, 420, 1], [420, 500, 0.5]]);
    assert.deepEqual(sun.get('uni')!.segments.map(s => [s.fromMin, s.toMin, s.left, s.width]), [[420, 500, 0.5, 0.5], [500, 510, 0, 1]]);
  }

  console.log('--- 3. THE FRIDAY PRAYER CASE ---');
  {
    const items = [
      h('rules', 11.5, 12),
      h('jumuah', 12, 13),
      h('prayer', 12.5, 13.5),
      h('dot', 13, 13 + 10 / 60),
      h('modeling', 13, 19),
    ];
    const fit = checkInvariants(items, 'fit', 'friday/fit');
    assert.deepEqual(fit.get('rules')!.segments, [{ fromMin: 690, toMin: 720, left: 0, width: 1 }], 'rules touches nothing');
    assert.deepEqual(fit.get('jumuah')!.segments.map(s => [s.fromMin, s.toMin, s.left, s.width]),
      [[720, 750, 0, 1], [750, 780, 0, 0.5]], 'jumuah full until prayer starts, then left half');
    const p = fit.get('prayer')!.segments;
    assert.deepEqual(p[0], { fromMin: 750, toMin: 780, left: 0.5, width: 0.5 }, 'prayer right half beside jumuah');
    assert.equal(p[p.length - 1].toMin, 810);
    assert.deepEqual(fit.get('modeling')!.segments[fit.get('modeling')!.segments.length - 1],
      { fromMin: 810, toMin: 1140, left: 0, width: 1 }, 'modeling full width once prayer is over');
    checkInvariants(items, 'columns', 'friday/columns');
  }

  console.log('--- 4. ONE COLUMN ORDER (the old misalignment) ---');
  {
    const items = [h('a', 12, 13), h('b', 12.5, 13.5), h('c', 13, 14), h('d', 13, 14)];
    const out = checkInvariants(items, 'columns', 'grid');
    assert.deepEqual(out.get('a')!.segments[0], { fromMin: 720, toMin: 780, left: 0, width: 1 / 3 });
    assert.deepEqual(out.get('b')!.segments[0], { fromMin: 750, toMin: 810, left: 1 / 3, width: 1 / 3 });
    assert.deepEqual(out.get('c')!.segments[0], { fromMin: 780, toMin: 840, left: 0, width: 1 / 3 });
    assert.deepEqual(out.get('d')!.segments[0], { fromMin: 780, toMin: 840, left: 2 / 3, width: 1 / 3 });
    checkInvariants(items, 'fit', 'grid/fit');
  }

  console.log('--- 5. COLUMNS MODE WIDENS INTO FREE COLUMNS ---');
  {
    const out = layoutOverlaps([h('long', 9, 12), h('s1', 9, 10), h('s2', 11, 12)], { mode: 'columns' });
    assert.equal(out.get('long')!.width, 0.5);
    assert.equal(out.get('s1')!.left, 0.5);
    assert.equal(out.get('s2')!.left, 0.5);
    const w = layoutOverlaps([h('a', 9, 13), h('b', 9, 10), h('c', 9, 10), h('d', 11, 12)], { mode: 'columns' });
    assert.equal(w.get('d')!.left, 1 / 3);
    assert.equal(w.get('d')!.width, 2 / 3, 'd sits in column 1 and widens over the free column 2');
  }

  console.log('--- 6. SAME START: LONGER ONE ON THE LEFT ---');
  {
    for (const mode of ['fit', 'columns'] as const) {
      const out = layoutOverlaps([h('short', 9, 10), h('long', 9, 17)], { mode });
      assert.equal(out.get('long')!.segments[0].left, 0, `${mode}: long takes the left`);
      assert.equal(out.get('short')!.left, 0.5);
    }
    const fit = layoutOverlaps([h('short', 9, 10), h('long', 9, 17)], { mode: 'fit' });
    assert.deepEqual(fit.get('long')!.segments.map(s => s.width), [0.5, 1], 'long goes full width once short ends');
  }

  console.log('--- 7. CONTAINED BLOCK ---');
  {
    const fit = checkInvariants([h('day', 9, 17), h('meet', 12, 13)], 'fit', 'contained');
    assert.deepEqual(fit.get('day')!.segments.map(s => [s.fromMin, s.toMin, s.width]),
      [[540, 720, 1], [720, 780, 0.5], [780, 1020, 1]], 'narrow only during the meeting');
    assert.deepEqual(fit.get('meet')!.segments, [{ fromMin: 720, toMin: 780, left: 0.5, width: 0.5 }]);
  }

  console.log('--- 8. CSS: RECTANGLES ---');
  {
    const full: OverlapBox = { left: 0, width: 1, segments: [{ fromMin: 0, toMin: 60, left: 0, width: 1 }] };
    assert.deepEqual(overlapBoxCss(full, 3, 2), { left: 'calc(0% + 3px)', right: 'calc(0% + 3px)' });
    assert.equal(overlapClipPath(full, 3, 2), undefined, 'a rectangle is never clipped');
    assert.equal(overlapContentArea(full, 3, 2), undefined);
    const leftHalf: OverlapBox = { left: 0, width: 0.5, segments: [{ fromMin: 0, toMin: 60, left: 0, width: 0.5 }] };
    assert.deepEqual(overlapBoxCss(leftHalf, 3, 2), { left: 'calc(0% + 3px)', right: 'calc(50% + 4px)' });
    const rightHalf: OverlapBox = { left: 0.5, width: 0.5, segments: [{ fromMin: 0, toMin: 60, left: 0.5, width: 0.5 }] };
    assert.deepEqual(overlapBoxCss(rightHalf, 3, 2), { left: 'calc(50% + 4px)', right: 'calc(0% + 3px)' });
  }

  console.log('--- 9. CSS: THE STEPPED SHAPE LINES UP WITH ITS NEIGHBOUR ---');
  {
    const fit = layoutOverlaps([h('sleep', 0, 8 + 5 / 60), h('quest', 8, 12)], { mode: 'fit' });
    const sleep = fit.get('sleep')!, quest = fit.get('quest')!;
    const EDGE = 3, GAP = 2;
    // Evaluate a `calc(p% + qpx)` x for an element of width W, then map to
    // column coordinates, for a column of width C.
    const C = 200;
    const evalX = (expr: string, elLeft: number, elW: number) => {
      if (expr === '0%') return elLeft;
      if (expr === '100%') return elLeft + elW;
      const m = /^calc\((-?[\d.]+)% \+ (-?[\d.]+)px\)$/.exec(expr);
      assert.ok(m, `parseable x: ${expr}`);
      return elLeft + (Number(m![1]) / 100) * elW + Number(m![2]);
    };
    const place = (b: OverlapBox) => {
      const css = overlapBoxCss(b, EDGE, GAP);
      const p = (s: string) => /^calc\(([\d.]+)% \+ ([\d.]+)px\)$/.exec(s)!;
      const l = (Number(p(css.left)[1]) / 100) * C + Number(p(css.left)[2]);
      const r = C - ((Number(p(css.right)[1]) / 100) * C + Number(p(css.right)[2]));
      return { l, w: r - l };
    };
    const sp = place(sleep), qp = place(quest);
    const sClip = overlapClipPath(sleep, EDGE, GAP)!;
    const qClip = overlapClipPath(quest, EDGE, GAP)!;
    assert.ok(sClip.startsWith('polygon('), 'sleep is clipped');
    assert.ok(qClip.startsWith('polygon('), 'quest is clipped');
    const pts = (clip: string) => clip.slice(8, -1).split(', ').map(pt => {
      const i = pt.lastIndexOf(' ');
      return { x: pt.slice(0, i), y: pt.slice(i + 1) };
    });
    // Sleep's narrow right edge vs quest's narrow left edge, during 8:00-8:05.
    const sNarrowRight = Math.max(...pts(sClip).filter(p => p.x !== '100%').map(p => evalX(p.x, sp.l, sp.w)));
    const qNarrowLeft = Math.min(...pts(qClip).filter(p => p.x !== '0%').map(p => evalX(p.x, qp.l, qp.w)));
    assert.ok(Math.abs(sNarrowRight - (C / 2 - GAP / 2)) < 1e-6, `sleep stops 1px left of the middle (${sNarrowRight})`);
    assert.ok(Math.abs(qNarrowLeft - (C / 2 + GAP / 2)) < 1e-6, `quest starts 1px right of the middle (${qNarrowLeft})`);
    assert.ok(Math.abs(sp.l - EDGE) < 1e-6 && Math.abs(sp.l + sp.w - (C - EDGE)) < 1e-6, 'sleep box spans the column');
    // The step sits at 8:00 as a fraction of sleep's own length.
    assert.ok(sClip.includes(`${Math.round((480 / 485) * 100 * 10000) / 10000}%`), 'sleep steps at 8:00');

    const area = overlapContentArea(sleep, EDGE, GAP)!;
    assert.deepEqual({ l: area.left, r: area.right, t: area.top }, { l: '0%', r: '0px', t: '0%' }, 'sleep text sits in its full-width part');
    assert.ok(Math.abs(area.heightFraction - 480 / 485) < 1e-9);
    const qa = overlapContentArea(quest, EDGE, GAP)!;
    assert.equal(qa.left, '0%', 'quest text sits in its full-width part');
    assert.equal(qa.bottom, '0%');
  }

  console.log('--- 9b. RECTANGLES FOR THE PHONE ---');
  {
    const fit = layoutOverlaps([h('sleep', 0, 8 + 5 / 60), h('quest', 8, 12)], { mode: 'fit' });
    const y = (m: number) => m * 2; // 2px per minute
    const sleep = fit.get('sleep')!;
    assert.deepEqual(segmentRects(sleep, y, 0, 970), [
      { top: 0, height: 960, left: 0, width: 1 },
      { top: 960, height: 10, left: 0, width: 0.5 },
    ]);
    const quest = fit.get('quest')!;
    assert.deepEqual(segmentRects(quest, y, 960, 480), [
      { top: 0, height: 10, left: 0.5, width: 0.5 },
      { top: 10, height: 470, left: 0, width: 1 },
    ]);
    assert.equal(contentSegmentIndex(sleep), 0, 'sleep text in the long full-width part');
    assert.equal(contentSegmentIndex(quest), 1, 'quest text in the long full-width part');
    // A block drawn taller than its minutes (minimum height) is still covered top to bottom.
    const short = layoutOverlaps([h('a', 9, 9 + 5 / 60), h('b', 9, 9 + 5 / 60)], { mode: 'fit' }).get('a')!;
    const r = segmentRects(short, y, 1080, 40);
    assert.equal(r[0].top, 0);
    assert.equal(r[r.length - 1].top + r[r.length - 1].height, 40, 'last rect reaches the bottom');
    // A yAt that jumps (hidden hours) never produces a negative or overflowing rect.
    const jumpy = (m: number) => (m > 300 ? m * 2 - 400 : m * 2);
    for (const rr of segmentRects(fit.get('quest')!, jumpy, 0, 100)) {
      assert.ok(rr.top >= 0 && rr.height >= 0 && rr.top + rr.height <= 100);
    }
    const day = layoutOverlaps([h('day', 9, 17), h('meet', 12, 13)], { mode: 'fit' }).get('day')!;
    assert.equal(contentSegmentIndex(day), 2, 'ties go to the first, longest wins (13-17 > 9-12)');
  }

  console.log('--- 10. JUNK INPUT ---');
  {
    const junk = [
      null, undefined, { id: 'nan', startMin: NaN, endMin: 10 },
      { id: 'inf', startMin: Infinity, endMin: 10 },
      { id: 'noend', startMin: 60, endMin: NaN },
      { id: 'back', startMin: 120, endMin: 60 },
      { id: 'zero', startMin: 200, endMin: 200 },
      { id: 'dup', startMin: 300, endMin: 360 }, { id: 'dup', startMin: 0, endMin: 999 },
      { id: 5, startMin: 0, endMin: 10 },
    ] as unknown as OverlapInput[];
    for (const mode of ['fit', 'columns'] as const) {
      const out = layoutOverlaps(junk, { mode });
      assert.ok(!out.has('nan') && !out.has('inf'), 'non-finite starts are dropped');
      assert.ok(out.has('noend') && out.has('back') && out.has('zero'), 'bad ends still get a box');
      assert.equal(out.size, 4, 'duplicate id laid out once');
      assert.equal(out.get('dup')!.segments[0].fromMin, 300, 'first copy of a duplicate wins');
    }
    const neg = checkInvariants([h('n', -2, 1), h('m', -2, 1)], 'fit', 'negative');
    assert.equal(neg.get('n')!.width, 0.5, 'negative minutes (before day start) still lay out');
  }

  console.log('--- 11. DETERMINISTIC UNDER INPUT ORDER ---');
  {
    const items = [h('a', 9, 12), h('b', 9, 10), h('c', 9.25, 11), h('d', 10, 13), h('e', 11, 11.5), h('f', 9, 12)];
    for (const mode of ['fit', 'columns'] as const) {
      const ref = layoutOverlaps(items, { mode });
      const rev = layoutOverlaps([...items].reverse(), { mode });
      for (const [id, b] of ref) assert.deepEqual(rev.get(id), b, `${mode}: ${id} same in any order`);
    }
  }

  console.log('--- 12. RANDOMISED INVARIANTS (4000 days) ---');
  {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let t = 0; t < 4000; t++) {
      const n = 1 + Math.floor(rnd() * 12);
      const items: OverlapInput[] = [];
      for (let i = 0; i < n; i++) {
        const s = Math.floor(rnd() * 96) * 15 - (rnd() < 0.05 ? 120 : 0);
        const len = rnd() < 0.1 ? 0 : Math.floor(1 + rnd() * 40) * 5;
        items.push({ id: `e${i}`, startMin: s, endMin: s + len });
      }
      for (const mode of ['fit', 'columns'] as const) {
        const out = checkInvariants(items, mode, `rand#${t}/${mode}`);
        for (const b of out.values()) {
          const clip = overlapClipPath(b, 3, 2);
          if (clip) assert.ok(/^polygon\(.+\)$/.test(clip) && !clip.includes('NaN'), `rand#${t}: clip is well formed`);
          const area = overlapContentArea(b, 3, 2);
          if (area) assert.ok(area.heightFraction > 0 && area.heightFraction <= 1 && !JSON.stringify(area).includes('NaN'));
        }
      }
    }
  }

  console.log('\nAll overlap layout tests passed.');
}

main();
