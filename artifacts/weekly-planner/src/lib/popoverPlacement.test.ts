// Tests for the item popup placement. The bug: clicking the overnight piece of
// an item on Wednesday opened the popup on top of it, because it anchored to the
// Tuesday piece (first in the page) and went "right of" that, i.e. onto Wed.
//
// Run with: npx tsx src/lib/popoverPlacement.test.ts

import assert from 'node:assert/strict';
import { placeBeside, pickAnchor, visibleArea, type Rect } from './popoverPlacement';

const vp = { width: 1920, height: 1035 };
const size = { width: 340, height: 600 };
const rect = (left: number, top: number, w: number, h: number): Rect => ({ left, top, right: left + w, bottom: top + h });
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const popRect = (p: { x: number; y: number }, s = size): Rect => rect(p.x, p.y, s.width, s.height);

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

test('goes right of the block when there is room', () => {
  const a = rect(270, 580, 180, 400);
  const p = placeBeside(a, size, vp);
  assert.equal(p.x, 456);
  assert.equal(p.y, 427); // 580 would push the bottom out: clamped up
  assert.ok(!overlaps(popRect(p), a));
});

test('flips left near the right edge', () => {
  const a = rect(1700, 300, 180, 200);
  const p = placeBeside(a, size, vp);
  assert.equal(p.x, 1700 - 6 - 340);
  assert.ok(!overlaps(popRect(p), a));
});

test('neither side fits: uses the side with more room and stays in the window', () => {
  const win = { width: 1000, height: 800 };
  const pop = { width: 500, height: 300 };
  // Block at 600..700: room right 286, room left 586 -> left side, clamped to the margin.
  const q = placeBeside(rect(600, 100, 100, 100), { width: 700, height: 300 }, win);
  assert.equal(q.x, 8);
  // Block at 200..300: room right 686 fits 500 -> right.
  assert.equal(placeBeside(rect(200, 100, 100, 100), pop, win).x, 306);
  // Block at 400..600: right 386, left 386 is not > -> right side, clamped inside.
  const r = placeBeside(rect(400, 100, 200, 100), pop, win);
  assert.equal(r.x, 1000 - 500 - 8);
  assert.ok(r.x + pop.width <= win.width - 8);
});

test('block scrolled above the window does not drag the popup off screen', () => {
  const a = rect(270, -900, 180, 400);
  const p = placeBeside(a, size, vp);
  assert.equal(p.y, 8);
});

test('block below the window: popup bottom stays inside', () => {
  const a = rect(270, 1000, 180, 400);
  const p = placeBeside(a, size, vp);
  assert.equal(p.y, 1035 - 600 - 8);
});

test('popup taller than the window pins to the top margin', () => {
  const p = placeBeside(rect(100, 500, 100, 50), { width: 340, height: 5000 }, vp);
  assert.equal(p.y, 8);
});

test('popup wider than the window pins to the left margin', () => {
  const p = placeBeside(rect(100, 500, 100, 50), { width: 5000, height: 300 }, vp);
  assert.equal(p.x, 8);
});

test('garbage measurements never produce NaN', () => {
  const p = placeBeside({ left: NaN, top: NaN, right: NaN, bottom: NaN }, { width: NaN, height: Infinity }, { width: NaN, height: NaN });
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('zero-size viewport still returns the margin', () => {
  assert.deepEqual(placeBeside(rect(0, 0, 10, 10), size, { width: 0, height: 0 }), { x: 8, y: 8 });
});

test('custom margin and gap are honoured', () => {
  const p = placeBeside(rect(100, 100, 100, 100), size, vp, { margin: 20, gap: 12 });
  assert.equal(p.x, 212);
  assert.equal(placeBeside(rect(100, 0, 100, 100), size, vp, { margin: 20 }).y, 20);
});

test('pickAnchor follows the clicked piece, not the first in the page', () => {
  const tueHead = rect(270, 1400, 180, 300); // off screen below
  const wedTail = rect(456, 580, 180, 400);  // the one clicked
  assert.equal(pickAnchor([{ item: 'tue', rect: tueHead }, { item: 'wed', rect: wedTail }], vp, wedTail), 'wed');
});

test('pickAnchor without a hint picks the most visible piece', () => {
  const off = rect(270, 1400, 180, 300);
  const on = rect(456, 580, 180, 400);
  assert.equal(pickAnchor([{ item: 'a', rect: off }, { item: 'b', rect: on }], vp, null), 'b');
});

test('pickAnchor tracks the piece after it moved a little (scroll)', () => {
  const clicked = rect(456, 580, 180, 400);
  const nowA = rect(270, 530, 180, 300);
  const nowB = rect(456, 530, 180, 400);
  assert.equal(pickAnchor([{ item: 'a', rect: nowA }, { item: 'b', rect: nowB }], vp, clicked), 'b');
});

test('pickAnchor with no candidates is null; a single one is returned', () => {
  assert.equal(pickAnchor([], vp, null), null);
  assert.equal(pickAnchor([{ item: 1, rect: rect(0, 0, 1, 1) }], vp, null), 1);
});

test('visibleArea clips to the viewport and is zero off screen', () => {
  assert.equal(visibleArea(rect(-10, -10, 20, 20), vp), 100);
  assert.equal(visibleArea(rect(2000, 0, 10, 10), vp), 0);
});

console.log(`${n} passed`);
