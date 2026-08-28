// Tests drag-to-reorder indexing arithmetic, array mutations, and boundary cases.
// Run with: npx tsx src/lib/useReorder.test.ts

import assert from 'node:assert/strict';

/** Pure reorder algorithm mirrored from useReorder.ts */
function reorderArray<T>(items: T[], idOf: (item: T) => string, dragId: string, gap: number): T[] {
  const from = items.findIndex(it => idOf(it) === dragId);
  if (from < 0 || gap === null || gap === undefined) return items;
  const to = gap > from ? gap - 1 : gap;
  if (to === from || to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

console.log('--- 1. REORDER ARRAY ARITHMETIC & BOUNDARIES ---');

interface Item { id: string; name: string }
const idOf = (i: Item) => i.id;

const sample: Item[] = [
  { id: 'a', name: 'Item A' },
  { id: 'b', name: 'Item B' },
  { id: 'c', name: 'Item C' },
  { id: 'd', name: 'Item D' },
  { id: 'e', name: 'Item E' },
];

// Move item A (index 0) forward to gap 3 (between B and C -> index 2)
// gap=3 > from=0 -> to = 3 - 1 = 2 -> [B, C, A, D, E]
const moveAForward = reorderArray(sample, idOf, 'a', 3);
assert.deepEqual(moveAForward.map(i => i.id), ['b', 'c', 'a', 'd', 'e']);

// Move item A (index 0) to last position (gap 5)
// gap=5 > from=0 -> to = 5 - 1 = 4 -> [B, C, D, E, A]
const moveAToEnd = reorderArray(sample, idOf, 'a', 5);
assert.deepEqual(moveAToEnd.map(i => i.id), ['b', 'c', 'd', 'e', 'a']);

// Move item E (index 4) backward to first position (gap 0)
// gap=0 <= from=4 -> to = 0 -> [E, A, B, C, D]
const moveEToStart = reorderArray(sample, idOf, 'e', 0);
assert.deepEqual(moveEToStart.map(i => i.id), ['e', 'a', 'b', 'c', 'd']);

// Move item D (index 3) backward to gap 1 (between A and B -> index 1)
// gap=1 <= from=3 -> to = 1 -> [A, D, B, C, E]
const moveDBackward = reorderArray(sample, idOf, 'd', 1);
assert.deepEqual(moveDBackward.map(i => i.id), ['a', 'd', 'b', 'c', 'e']);

// Move item to its own slot (no change)
// gap 1 or gap 2 for item B (index 1)
assert.deepEqual(reorderArray(sample, idOf, 'b', 1), sample);
assert.deepEqual(reorderArray(sample, idOf, 'b', 2), sample);

// Non-existent ID returns original array unchanged
assert.deepEqual(reorderArray(sample, idOf, 'nonexistent', 2), sample);

// Minimal array (2 items)
const twoItems: Item[] = [{ id: '1', name: '1' }, { id: '2', name: '2' }];
const swapped = reorderArray(twoItems, idOf, '1', 2);
assert.deepEqual(swapped.map(i => i.id), ['2', '1']);

const swappedBack = reorderArray(swapped, idOf, '1', 0);
assert.deepEqual(swappedBack.map(i => i.id), ['1', '2']);

console.log('--- 2. GEOMETRIC GAP CALCULATION SIMULATION ---');

interface Rect { left: number; width: number; top: number; height: number }

function calculateGap(points: Rect[], cursor: number, axis: 'x' | 'y'): number {
  for (let i = 0; i < points.length; i++) {
    const r = points[i];
    const middle = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
    if (cursor < middle) return i;
  }
  return points.length;
}

// Vertical list: 4 items of height 40px starting at y=0 (0..40, 40..80, 80..120, 120..160)
// Middles: 20, 60, 100, 140
const verticalRows: Rect[] = [
  { left: 0, width: 200, top: 0, height: 40 },
  { left: 0, width: 200, top: 40, height: 40 },
  { left: 0, width: 200, top: 80, height: 40 },
  { left: 0, width: 200, top: 120, height: 40 },
];

assert.equal(calculateGap(verticalRows, 10, 'y'), 0, 'Cursor above first middle lands in gap 0');
assert.equal(calculateGap(verticalRows, 35, 'y'), 1, 'Cursor between middle 0 (20) and middle 1 (60) lands in gap 1');
assert.equal(calculateGap(verticalRows, 95, 'y'), 2, 'Cursor below middle 1 (60) and above middle 2 (100) lands in gap 2');
assert.equal(calculateGap(verticalRows, 150, 'y'), 4, 'Cursor past last middle (140) lands in gap 4');

// Horizontal rail: 3 chips of width 80px starting at x=0 (0..80, 80..160, 160..240)
// Middles: 40, 120, 200
const horizontalChips: Rect[] = [
  { left: 0, width: 80, top: 0, height: 30 },
  { left: 80, width: 80, top: 0, height: 30 },
  { left: 160, width: 80, top: 0, height: 30 },
];

assert.equal(calculateGap(horizontalChips, 30, 'x'), 0);
assert.equal(calculateGap(horizontalChips, 100, 'x'), 1);
assert.equal(calculateGap(horizontalChips, 180, 'x'), 2);
assert.equal(calculateGap(horizontalChips, 230, 'x'), 3);

console.log('\nALL PASS (useReorder)');
