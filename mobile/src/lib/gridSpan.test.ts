// The phone's copy of grid.ts must widen blocks into free columns exactly like
// the PC's (see artifacts/weekly-planner/src/lib/grid.test.ts, section 12).
// Before this, overlapping items in the week view were drawn as unreadable
// slivers even when the space beside them was empty.
//
// Run with: cd ../artifacts/weekly-planner && npx tsx ../../mobile/src/lib/gridSpan.test.ts

import assert from 'node:assert/strict';
import { blockEnd, layoutDay, MIN_BLOCK_MINUTES, type Placeable } from './grid';

const at = (id: string, startH: number, endH: number): Placeable => ({
  id, startMin: Math.round(startH * 60), endMin: Math.round(endH * 60),
});
const get = (p: ReturnType<typeof layoutDay>, id: string) => p.find(x => x.item.id === id)!;

assert.equal(MIN_BLOCK_MINUTES, 15, 'the phone floor stays 15 minutes');

{
  const p = layoutDay([at('a', 9, 13), at('b', 9, 10), at('c', 9, 10), at('d', 11, 12)], { pxPerHour: 60 });
  assert.equal(get(p, 'd').column, 0);
  assert.equal(get(p, 'd').span, 2, 'd widens over the free column, stopping at a');
  assert.equal(get(p, 'a').span, 1);
}
{
  assert.equal(layoutDay([at('x', 9, 10)], { pxPerHour: 60 })[0].span, 1);
}
{
  // Random days: span never makes two time-overlapping blocks share pixels.
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 300; n++) {
    const items = Array.from({ length: 1 + Math.floor(rnd() * 9) }, (_, i) => {
      const s = 8 + Math.floor(rnd() * 20) / 2;
      return at(`e${i}`, s, s + 0.25 + Math.floor(rnd() * 8) / 4);
    });
    const p = layoutDay(items, { pxPerHour: 60 });
    for (const x of p) {
      assert.ok(x.span >= 1 && x.column + x.span <= x.columns, `case ${n}: ${x.item.id} inside its run`);
      for (const y of p) {
        if (x === y || x.columns !== y.columns) continue;
        const t = x.item.startMin < blockEnd(y.item) && y.item.startMin < blockEnd(x.item);
        const c = x.column < y.column + y.span && y.column < x.column + x.span;
        assert.ok(!(t && c), `case ${n}: ${x.item.id} and ${y.item.id} collide`);
      }
    }
  }
}

console.log('ALL PASS (phone grid span)');
