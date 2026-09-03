// Tests for the drag-to-reorder arithmetic.
//
// The bar here is not "a drag works". It is that a drag can NEVER put a row
// somewhere the finger did not go: rows of different heights, rows that have
// not been measured yet, a list that shrank mid-gesture, a flung finger that
// travels a thousand points past the end. Every one of those is a real thing a
// thumb does, and each one used to be a silently wrong `order` field written to
// both machines.
//
// Run with: npx tsx src/lib/dragSort.test.ts

import assert from 'node:assert/strict';
import {
  centreOf, slotSpan, shiftThreshold, dropIndexFor, rowShift, reorderList,
  manualOrders, planAppendOrder, planReorder, bridgeVerdict, ORDER_STEP,
  type Orderable, type RowBoxes,
} from './dragSort';

/** A row of a bucket: an id, a list it is filed on, and maybe a position. */
interface Item extends Orderable { id: string; list: string; order?: number }

const item = (id: string, list: string, order?: number): Item =>
  (order === undefined ? { id, list } : { id, list, order });

/** What the user can see when `list` is selected. Null is "All". */
const onlyList = (full: readonly Item[], list: string | null): Item[] =>
  list === null ? [...full] : full.filter(t => t.list === list);

/** Apply a plan's changes and re-sort, which is what the board then does. */
function settle(full: readonly Item[], changes: ReadonlyArray<{ id: string; order: number }>): Item[] {
  const by = new Map(changes.map(c => [c.id, c.order]));
  return full
    .map(t => (by.has(t.id) ? { ...t, order: by.get(t.id) as number } : t))
    .sort((a, b) => {
      const ak = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const bk = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      return ak - bk || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}

/** `n` rows of equal height stacked with a gap, the ordinary case. */
function evenRows(n: number, height = 100, gap = 8): RowBoxes {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ y: i * (height + gap), height });
  return out;
}

/** Rows of the given heights, stacked with a gap. */
function rows(heights: number[], gap = 8): RowBoxes {
  const out = [];
  let y = 0;
  for (const height of heights) {
    out.push({ y, height });
    y += height + gap;
  }
  return out;
}

/** The whole drag, end to end: pick up `from`, move by `dy`, drop. */
function drag<T>(items: readonly T[], boxes: RowBoxes, from: number, dy: number): T[] {
  return reorderList(items, from, dropIndexFor(boxes, from, dy, items.length));
}

async function main() {
  const ABC = ['a', 'b', 'c', 'd', 'e'];

  console.log('--- 1. A ROW THAT HAS NOT MOVED STAYS PUT ---');
  {
    const boxes = evenRows(5);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(dropIndexFor(boxes, i, 0, 5), i, `row ${i} with no movement`);
    }
    // And a nudge far too small to cross anything is still no movement.
    assert.equal(dropIndexFor(boxes, 2, 3, 5), 2);
    assert.equal(dropIndexFor(boxes, 2, -3, 5), 2);
    console.log('  ok');
  }

  console.log('--- 2. THE HANDOVER POINT IS THE NEIGHBOUR\'S CENTRE ---');
  {
    // Rows 100 tall with an 8 gap: centres are 108 apart. Nothing happens until
    // the dragged centre reaches the next centre, and dragging by exactly one
    // slot is a swap: anything else would leave a full slot drag doing nothing.
    const boxes = evenRows(5);
    assert.equal(dropIndexFor(boxes, 1, 107, 5), 1, 'just short');
    assert.equal(dropIndexFor(boxes, 1, 108, 5), 2, 'exactly one slot is a swap');
    assert.equal(dropIndexFor(boxes, 1, 109, 5), 2, 'past');
    assert.equal(dropIndexFor(boxes, 3, -107, 5), 3);
    assert.equal(dropIndexFor(boxes, 3, -108, 5), 2, 'exactly one slot going up');
    assert.equal(dropIndexFor(boxes, 3, -109, 5), 2);
    console.log('  ok');
  }

  console.log('--- 3. IT CANNOT LEAVE THE LIST ---');
  {
    const boxes = evenRows(5);
    assert.equal(dropIndexFor(boxes, 0, -99999, 5), 0, 'flung off the top');
    assert.equal(dropIndexFor(boxes, 4, 99999, 5), 4, 'flung off the bottom');
    assert.equal(dropIndexFor(boxes, 2, -99999, 5), 0);
    assert.equal(dropIndexFor(boxes, 2, 99999, 5), 4);
    console.log('  ok');
  }

  console.log('--- 4. A ONE ROW LIST HAS NOWHERE TO GO ---');
  {
    const boxes = evenRows(1);
    assert.equal(dropIndexFor(boxes, 0, 500, 1), 0);
    assert.equal(dropIndexFor(boxes, 0, -500, 1), 0);
    assert.deepEqual(drag(['only'], boxes, 0, 900), ['only']);
    console.log('  ok');
  }

  console.log('--- 5. TWO ROWS SWAP AND SWAP BACK ---');
  {
    const boxes = evenRows(2);
    assert.deepEqual(drag(['a', 'b'], boxes, 0, 200), ['b', 'a']);
    assert.deepEqual(drag(['a', 'b'], boxes, 1, -200), ['b', 'a']);
    assert.deepEqual(drag(['a', 'b'], boxes, 0, 10), ['a', 'b'], 'not far enough');
    console.log('  ok');
  }

  console.log('--- 6. UNEQUAL HEIGHTS: THE WALK NEVER SKIPS A ROW ---');
  {
    // A short row wedged between two tall ones. Nearest-centre would let a drag
    // from the top land past the short row without ever crossing it; walking
    // outward one neighbour at a time cannot.
    //   0: y=0    h=300  centre 150
    //   1: y=308  h=40   centre 328
    //   2: y=356  h=300  centre 506
    const boxes = rows([300, 40, 300]);
    assert.equal(centreOf(boxes, 0), 150);
    assert.equal(centreOf(boxes, 1), 328);
    assert.equal(centreOf(boxes, 2), 506);

    assert.equal(dropIndexFor(boxes, 0, 179, 3), 1, 'crossed the short row only');
    assert.equal(dropIndexFor(boxes, 0, 357, 3), 2, 'crossed both');
    assert.equal(dropIndexFor(boxes, 0, 356, 3), 2, 'level with the last centre counts');
    assert.equal(dropIndexFor(boxes, 0, 355, 3), 1, 'a hair short of it does not');
    console.log('  ok');
  }

  console.log('--- 7. AN UNMEASURED NEIGHBOUR STOPS THE WALK ---');
  {
    // The list grew a row this frame and it has not been laid out yet. Guessing
    // its position would move a task somewhere the user cannot see.
    const boxes: RowBoxes = [
      { y: 0, height: 100 },
      undefined,
      { y: 216, height: 100 },
      { y: 324, height: 100 },
    ];
    assert.equal(dropIndexFor(boxes, 0, 1000, 4), 0, 'stopped at the hole');
    assert.equal(dropIndexFor(boxes, 3, -1000, 4), 2, 'stopped coming back up');
    assert.equal(dropIndexFor(boxes, 2, 1000, 4), 3, 'the clear side still works');
    console.log('  ok');
  }

  console.log('--- 8. AN UNMEASURED DRAGGED ROW NEVER MOVES ---');
  {
    const boxes: RowBoxes = [{ y: 0, height: 100 }, undefined, { y: 216, height: 100 }];
    assert.equal(dropIndexFor(boxes, 1, 400, 3), 1);
    assert.equal(dropIndexFor(boxes, 1, -400, 3), 1);
    console.log('  ok');
  }

  console.log('--- 9. NONSENSE INPUT IS REFUSED, NOT ACTED ON ---');
  {
    const boxes = evenRows(3);
    assert.equal(dropIndexFor(boxes, -1, 100, 3), -1, 'index below the list');
    assert.equal(dropIndexFor(boxes, 7, 100, 3), 7, 'index past the list');
    assert.equal(dropIndexFor(boxes, 1, Number.NaN, 3), 1, 'a NaN drag');
    assert.equal(dropIndexFor(boxes, 1, Number.POSITIVE_INFINITY, 3), 1, 'an infinite drag is refused too');
    assert.equal(dropIndexFor([], 0, 100, 0), 0, 'an empty list');
    assert.equal(dropIndexFor(boxes, 0, 100, 1), 0, 'count of one wins over the boxes');
    // A row measured with rubbish is treated as unmeasured, not as y=0.
    const bad: RowBoxes = [{ y: 0, height: 100 }, { y: Number.NaN, height: 100 }, { y: 216, height: 100 }];
    assert.equal(centreOf(bad, 1), null);
    assert.equal(dropIndexFor(bad, 0, 1000, 3), 0);
    console.log('  ok');
  }

  console.log('--- 10. THE WHOLE DRAG, IN BOTH DIRECTIONS ---');
  {
    const boxes = evenRows(5);
    assert.deepEqual(drag(ABC, boxes, 0, 108 * 4), ['b', 'c', 'd', 'e', 'a'], 'top to bottom');
    assert.deepEqual(drag(ABC, boxes, 4, -108 * 4), ['e', 'a', 'b', 'c', 'd'], 'bottom to top');
    assert.deepEqual(drag(ABC, boxes, 2, 108), ['a', 'b', 'd', 'c', 'e'], 'one down');
    assert.deepEqual(drag(ABC, boxes, 2, -108), ['a', 'c', 'b', 'd', 'e'], 'one up');
    console.log('  ok');
  }

  console.log('--- 11. A REORDER IS ALWAYS A PERMUTATION ---');
  {
    // Whatever the indices, nothing is duplicated and nothing is lost. This is
    // the property that stops a drag from eating a task.
    const boxes = evenRows(6);
    const items = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (let from = 0; from < 6; from += 1) {
      for (let dy = -900; dy <= 900; dy += 37) {
        const out = drag(items, boxes, from, dy);
        assert.equal(out.length, items.length);
        assert.deepEqual([...out].sort(), [...items].sort(), `from ${from} dy ${dy}`);
      }
    }
    console.log('  ok');
  }

  console.log('--- 12. MOVING A ROW ONTO ITSELF CHANGES NOTHING ---');
  {
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(reorderList(items, i, i), items);
    }
    console.log('  ok');
  }

  console.log('--- 13. REORDER REFUSES INDICES OUTSIDE THE LIST ---');
  {
    const items = ['a', 'b', 'c'];
    assert.deepEqual(reorderList(items, -1, 1), items);
    assert.deepEqual(reorderList(items, 3, 1), items);
    assert.deepEqual(reorderList(items, 1, -1), items);
    assert.deepEqual(reorderList(items, 1, 3), items);
    assert.deepEqual(reorderList(items, 0.5, 1), items, 'a fractional index');
    assert.deepEqual(reorderList([], 0, 0), []);
    // And it never hands back the same array, so a caller cannot mutate state.
    assert.notEqual(reorderList(items, 0, 0), items);
    console.log('  ok');
  }

  console.log('--- 14. THE SLOT A ROW OCCUPIES INCLUDES THE GAP ---');
  {
    const boxes = evenRows(4, 100, 8);
    assert.equal(slotSpan(boxes, 0), 108);
    assert.equal(slotSpan(boxes, 1), 108);
    assert.equal(slotSpan(boxes, 3), 108, 'the last row measures off the one above');

    const varied = rows([50, 120, 70]);
    assert.equal(slotSpan(varied, 0), 58);
    assert.equal(slotSpan(varied, 1), 128);
    assert.equal(slotSpan(varied, 2), 128, 'the last falls back to the gap above it');
    console.log('  ok');
  }

  console.log('--- 15. A SLOT WITH NOTHING TO MEASURE AGAINST ---');
  {
    assert.equal(slotSpan([{ y: 0, height: 90 }], 0), 90, 'a lone row is its own height');
    assert.equal(slotSpan([], 0), 0, 'nothing measured at all');
    assert.equal(slotSpan([undefined, { y: 10, height: 10 }], 0), 0);
    // Rows laid out at the same y (a list mid-collapse) must not report a zero
    // or negative span: that would send the other rows sliding by nothing.
    assert.equal(slotSpan([{ y: 0, height: 40 }, { y: 0, height: 40 }], 0), 40);
    assert.equal(slotSpan([{ y: 100, height: 40 }, { y: 0, height: 40 }], 0), 40);
    console.log('  ok');
  }

  console.log('--- 16. WHICH ROWS GIVE WAY, AND HOW FAR ---');
  {
    const boxes = evenRows(5);           // slot span 108
    // Dragging row 1 down to 3: rows 2 and 3 come up one slot, nothing else moves.
    assert.equal(rowShift(boxes, 1, 3, 0), 0);
    assert.equal(rowShift(boxes, 1, 3, 1), 0, 'the dragged row is drawn by the finger');
    assert.equal(rowShift(boxes, 1, 3, 2), -108);
    assert.equal(rowShift(boxes, 1, 3, 3), -108);
    assert.equal(rowShift(boxes, 1, 3, 4), 0);

    // Dragging row 3 up to 1: rows 1 and 2 go down one slot.
    assert.equal(rowShift(boxes, 3, 1, 0), 0);
    assert.equal(rowShift(boxes, 3, 1, 1), 108);
    assert.equal(rowShift(boxes, 3, 1, 2), 108);
    assert.equal(rowShift(boxes, 3, 1, 3), 0);
    assert.equal(rowShift(boxes, 3, 1, 4), 0);

    // Nothing moves at all while the drop index is where it started.
    for (let i = 0; i < 5; i += 1) assert.equal(rowShift(boxes, 2, 2, i), 0);
    console.log('  ok');
  }

  console.log('--- 17. THE HOLE IS ALWAYS EXACTLY ONE SLOT ---');
  {
    // However far the drag goes, every row that gives way moves by the SAME
    // amount. A list that shifted rows by their own heights would ripple.
    const boxes = rows([200, 60, 90, 150]);
    const span = slotSpan(boxes, 0);
    for (let drop = 1; drop < 4; drop += 1) {
      for (let i = 1; i <= drop; i += 1) {
        assert.equal(rowShift(boxes, 0, drop, i), -span, `row ${i} for drop ${drop}`);
      }
      for (let i = drop + 1; i < 4; i += 1) {
        assert.equal(rowShift(boxes, 0, drop, i), 0);
      }
    }
    console.log('  ok');
  }

  console.log('--- 18. AN UNMEASURED DRAGGED ROW MOVES NOBODY ---');
  {
    const boxes: RowBoxes = [undefined, { y: 10, height: 10 }];
    assert.equal(rowShift(boxes, 0, 1, 1), 0);
    console.log('  ok');
  }

  console.log('--- 19. THE THRESHOLD A ROW GIVES WAY AT ---');
  {
    const boxes = evenRows(5);
    assert.equal(shiftThreshold(boxes, 2, 2), null, 'the dragged row has none');
    assert.equal(shiftThreshold(boxes, 2, 3), 108, 'the one below, going down');
    assert.equal(shiftThreshold(boxes, 2, 4), 216);
    assert.equal(shiftThreshold(boxes, 2, 1), -108, 'the one above, going up');
    assert.equal(shiftThreshold(boxes, 2, 0), -216);
    assert.equal(shiftThreshold(boxes, 2, 9), null, 'a row that is not there');
    assert.equal(shiftThreshold([undefined, { y: 0, height: 5 }], 0, 1), null);
    console.log('  ok');
  }

  console.log('--- 20. THE THRESHOLDS AGREE WITH THE DROP INDEX ---');
  {
    // The one that matters: the moment a row slides aside on screen is the
    // moment the drop index counts it as passed. If these two ever disagree the
    // card lands one place off from the hole the user was looking at.
    const shapes = [evenRows(6), rows([200, 60, 90, 150, 40, 300]), rows([30, 30, 30, 30, 30, 30])];
    for (const boxes of shapes) {
      for (let from = 0; from < 6; from += 1) {
        for (let dy = -800; dy <= 800; dy += 1) {
          const drop = dropIndexFor(boxes, from, dy, 6);
          for (let i = 0; i < 6; i += 1) {
            const t = shiftThreshold(boxes, from, i);
            if (t === null) continue;
            const asideOnScreen = i > from ? dy >= t : dy <= t;
            const asideByIndex = rowShift(boxes, from, drop, i) !== 0;
            assert.equal(asideByIndex, asideOnScreen,
              `row ${i} while dragging ${from} by ${dy}`);
          }
        }
      }
    }
    console.log('  ok');
  }

  console.log('--- 21. THE SORT KEYS LEAVE ROOM BETWEEN ROWS ---');
  {
    assert.deepEqual(manualOrders(4), [0, 10, 20, 30]);
    assert.deepEqual(manualOrders(1), [0]);
    assert.deepEqual(manualOrders(0), []);
    assert.deepEqual(manualOrders(-3), []);
    assert.deepEqual(manualOrders(2.5), []);
    assert.deepEqual(manualOrders(3, 1), [0, 1, 2]);
    assert.equal(ORDER_STEP, 10, 'the PC writes the same step');
    // Strictly increasing, which is the only thing the sort actually needs.
    const many = manualOrders(200);
    for (let i = 1; i < many.length; i += 1) assert.ok(many[i] > many[i - 1]);
    console.log('  ok');
  }

  console.log('--- 22. A DRAG THAT RACED THE LIST ---');
  {
    // The row was measured, then two tasks arrived from the PC and the list is
    // longer than the boxes. Nothing may be written outside the new list.
    const boxes = evenRows(3);
    assert.equal(dropIndexFor(boxes, 2, 1000, 5), 2, 'no boxes past the third row');
    // And the other way round: the list shrank under the finger.
    const items = ['a', 'b'];
    assert.deepEqual(drag(items, evenRows(5), 1, 500), ['a', 'b']);
    console.log('  ok');
  }

  console.log('--- 23. A REAL RUN: FIVE SHOPPING ITEMS, TOP TO THIRD ---');
  {
    const boxes = evenRows(5, 96, 8);    // the phone's task cards, near enough
    const items = ['Paprika', 'Coffee', 'Anise', 'Sage', 'Flax'];
    const drop = dropIndexFor(boxes, 0, 104 * 2 + 5, 5);
    assert.equal(drop, 2);
    const moved = reorderList(items, 0, drop);
    assert.deepEqual(moved, ['Coffee', 'Anise', 'Paprika', 'Sage', 'Flax']);
    // And the keys written back put them in exactly that order again.
    const keys = manualOrders(moved.length);
    const sorted = moved
      .map((title, i) => ({ title, order: keys[i] }))
      .sort((a, b) => a.order - b.order)
      .map(x => x.title);
    assert.deepEqual(sorted, moved);
    console.log('  ok');
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // DRAGGING WHILE A FILTER IS ON
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('planReorder: with no filter it is just a reorder');
  {
    const full = [item('a', 'w', 0), item('b', 'w', 10), item('c', 'w', 20)];
    const plan = planReorder(full, full, 2, 0);
    assert.deepEqual(plan.items.map(t => t.id), ['c', 'a', 'b']);
    // ONE write, not three: `a` and `b` keep the numbers they had and `c` is
    // given one below them. See the section on minimal writes further down.
    assert.deepEqual(plan.changes, [{ id: 'c', order: -10 }]);
    assert.deepEqual(settle(full, plan.changes).map(t => t.id), ['c', 'a', 'b']);
    // A move that changes nothing writes nothing.
    assert.deepEqual(planReorder(full, full, 1, 1).changes, []);
    console.log('  ok');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ONE ROW IF ONE ROW WILL DO
  // ═══════════════════════════════════════════════════════════════════════════
  // Every row written is a merge, a row in the op log and a line in the next
  // sync. On the phone, twenty of those for a gesture that moved one thing is
  // most of a second with the screen frozen. The gaps of ten exist so that a row
  // can be slid between two others without disturbing either.

  console.log('planReorder: a move in the middle writes exactly one row');
  {
    const full = [
      item('a', 'w', 0), item('b', 'w', 10), item('c', 'w', 20),
      item('d', 'w', 30), item('e', 'w', 40),
    ];
    // `e` to the middle: it needs a number between 10 and 20, and 15 is free.
    const plan = planReorder(full, full, 4, 2);
    assert.deepEqual(plan.changes, [{ id: 'e', order: 15 }], 'one row, one number');
    assert.deepEqual(settle(full, plan.changes).map(t => t.id), ['a', 'b', 'e', 'c', 'd']);

    // Both ends are unbounded, so a drop to the top or the bottom is always one
    // write however long the list is.
    assert.deepEqual(planReorder(full, full, 2, 0).changes, [{ id: 'c', order: -10 }]);
    assert.deepEqual(planReorder(full, full, 0, 4).changes, [{ id: 'a', order: 50 }]);
    console.log('  ok');
  }

  console.log('planReorder: when the room runs out, the bucket is renumbered');
  {
    // Numbers one apart: there is no whole number between them, so the slide is
    // impossible and the answer is to spread everything out again. Fractions
    // would fit and are deliberately not used -- halving a gap forever ends in
    // numbers that no longer compare the way they read, on two machines at once.
    const tight = [item('a', 'w', 0), item('b', 'w', 1), item('c', 'w', 2)];
    const plan = planReorder(tight, tight, 2, 1);
    assert.deepEqual(plan.items.map(t => t.id), ['a', 'c', 'b']);
    assert.deepEqual(plan.changes, [{ id: 'c', order: 10 }, { id: 'b', order: 20 }],
      'renumbered, and the row that was already right is left alone');
    assert.deepEqual(settle(tight, plan.changes).map(t => t.id), ['a', 'c', 'b']);

    // And having renumbered once, the next move is a single write again.
    const spread = settle(tight, plan.changes);
    assert.equal(planReorder(spread, spread, 2, 1).changes.length, 1, 'room again');
    console.log('  ok');
  }

  console.log('planReorder: numbers that were never in order are repaired');
  {
    // Two rows sharing a number, or one that was never placed, means the order
    // on screen is not the order in the store. Sliding a row into that leaves a
    // list nobody can explain, so the whole bucket is rewritten instead.
    const shared = [item('a', 'w', 0), item('b', 'w', 0), item('c', 'w', 10)];
    const fixed = planReorder(shared, shared, 2, 0);
    assert.ok(fixed.changes.length > 1, 'a full renumber, not a slide');
    const after = settle(shared, fixed.changes);
    assert.deepEqual(after.map(t => t.id), ['c', 'a', 'b']);
    assert.equal(new Set(after.map(t => t.order)).size, 3, 'and no two share a number now');

    const partly = [item('a', 'w', 0), item('b', 'w'), item('c', 'w', 10)];
    assert.ok(planReorder(partly, partly, 0, 2).changes.length > 1,
      'an unplaced row forces the renumber too');

    // Descending numbers: the store disagrees with the screen, so repair.
    const backwards = [item('a', 'w', 30), item('b', 'w', 20), item('c', 'w', 10)];
    const repaired = planReorder(backwards, backwards, 0, 2);
    assert.deepEqual(settle(backwards, repaired.changes).map(t => t.id), ['b', 'c', 'a']);
    console.log('  ok');
  }

  console.log('planReorder: dragging the same row again and again stays correct');
  {
    // The end numbers walk outwards (-10, -20, ...) and nothing stops them, so
    // this is the run that would show it if that ever mattered. A hundred drags
    // to the top, and the list is still the list.
    let full = [item('a', 'w', 0), item('b', 'w', 10), item('c', 'w', 20), item('d', 'w', 30)];
    for (let i = 0; i < 100; i += 1) {
      const plan = planReorder(full, full, 3, 0);
      full = settle(full, plan.changes);
      assert.equal(full.length, 4, `pass ${i}: nothing lost`);
      assert.equal(new Set(full.map(t => t.id)).size, 4, `pass ${i}: nothing duplicated`);
      assert.equal(new Set(full.map(t => t.order)).size, 4, `pass ${i}: distinct places`);
      assert.ok(full.every(t => Number.isFinite(t.order as number)), `pass ${i}: real numbers`);
    }
    // Four rows rotated a hundred times: 100 % 4 === 0, so it is back where it
    // started, in the same order it started in.
    assert.deepEqual(full.map(t => t.id), ['a', 'b', 'c', 'd']);
    console.log('  ok');
  }

  console.log('planReorder: alternating middle drops do not run out of room');
  {
    // Swapping two neighbours back and forth is the move most likely to squeeze
    // a gap shut. It must keep working, whether by sliding or by renumbering.
    let full = [item('a', 'w', 0), item('b', 'w', 10), item('c', 'w', 20), item('d', 'w', 30)];
    for (let i = 0; i < 200; i += 1) {
      const from = i % 2 === 0 ? 1 : 2;
      const to = i % 2 === 0 ? 2 : 1;
      const plan = planReorder(full, full, from, to);
      const next = settle(full, plan.changes);
      assert.deepEqual(next.map(t => t.id), plan.items.map(t => t.id), `pass ${i}: as planned`);
      assert.equal(new Set(next.map(t => t.order)).size, 4, `pass ${i}: distinct places`);
      full = next;
    }
    console.log('  ok');
  }

  console.log('planReorder: THE REGRESSION -- the other lists survive the drag');
  {
    // Work and Home interleaved, each already arranged by hand. Renumbering only
    // what was on screen gave BOTH lists 0, 10, 20; clearing the filter then
    // interleaved two arrangements into one nobody had chosen.
    const full = [
      item('w1', 'work', 0), item('h1', 'home', 10), item('w2', 'work', 20),
      item('h2', 'home', 30), item('w3', 'work', 40),
    ];
    const visible = onlyList(full, 'work');          // w1, w2, w3
    const plan = planReorder(full, visible, 2, 0);   // w3 to the top of Work

    assert.deepEqual(plan.items.map(t => t.id), ['w3', 'w1', 'h1', 'w2', 'h2'],
      'w3 lands before w1, and the Home rows keep the places they were in');

    const after = settle(full, plan.changes);
    assert.deepEqual(after.map(t => t.id), ['w3', 'w1', 'h1', 'w2', 'h2'],
      'and the board with the filter cleared agrees');
    assert.deepEqual(onlyList(after, 'work').map(t => t.id), ['w3', 'w1', 'w2'],
      'the drag did what it was asked');
    assert.deepEqual(onlyList(after, 'home').map(t => t.id), ['h1', 'h2'],
      'and Home is in the order it always was');

    // Every number is distinct: two rows sharing one is what let the board
    // reshuffle itself later.
    const orders = after.map(t => t.order);
    assert.equal(new Set(orders).size, orders.length, 'no two rows share a place');
  }

  console.log('planReorder: every source and destination, under every filter');
  {
    // Exhaustive. Six rows over three lists, each list selected in turn plus
    // "All", every from/to pair. Three invariants, every time:
    //   1. the visible rows come out in exactly the order the drag asked for,
    //   2. the hidden rows keep their order relative to each other,
    //   3. nothing is lost, duplicated, or left sharing a number.
    const full: Item[] = [
      item('a', 'work', 0), item('b', 'home', 10), item('c', 'work', 20),
      item('d', 'errands', 30), item('e', 'home', 40), item('f', 'work', 50),
    ];

    for (const list of [null, 'work', 'home', 'errands']) {
      const visible = onlyList(full, list);
      const hidden = full.filter(t => !visible.includes(t)).map(t => t.id);

      for (let from = 0; from < visible.length; from += 1) {
        for (let to = 0; to < visible.length; to += 1) {
          const where = `${list ?? 'all'} ${from}->${to}`;
          const plan = planReorder(full, visible, from, to);
          const after = settle(full, plan.changes);

          assert.deepEqual(after.map(t => t.id).sort(), full.map(t => t.id).sort(),
            `${where}: nothing lost or duplicated`);
          assert.deepEqual(
            after.filter(t => visible.some(v => v.id === t.id)).map(t => t.id),
            reorderList(visible, from, to).map(t => t.id),
            `${where}: the visible order is what the finger asked for`);
          assert.deepEqual(after.filter(t => hidden.includes(t.id)).map(t => t.id), hidden,
            `${where}: the hidden rows never move relative to each other`);
          const orders = after.map(t => t.order);
          assert.equal(new Set(orders).size, orders.length, `${where}: distinct places`);
          assert.deepEqual(plan.items.map(t => t.id), after.map(t => t.id),
            `${where}: the plan and the settled board agree`);
          // Nothing is ever written that did not need to be.
          for (const c of plan.changes) {
            const was = full.find(t => t.id === c.id);
            assert.notEqual(was?.order, c.order, `${where}: ${c.id} was already at ${c.order}`);
          }
        }
      }
    }
    console.log('  ok');
  }

  console.log('planReorder: a bucket where nothing has ever been placed');
  {
    // The first drag on a fresh list. Every row is unnumbered, so every row is
    // written -- which is the point: two numbers floating among blanks would not
    // survive the next sort.
    const full = [item('a', 'work'), item('b', 'home'), item('c', 'work')];
    const plan = planReorder(full, onlyList(full, 'work'), 1, 0);
    assert.deepEqual(plan.items.map(t => t.id), ['c', 'a', 'b']);
    assert.equal(plan.changes.length, 3, 'all three get a place');
    assert.deepEqual(settle(full, plan.changes).map(t => t.id), ['c', 'a', 'b']);
    console.log('  ok');
  }

  console.log('planReorder: a drag that dropped its row at the very end');
  {
    // The anchor is the row's new NEXT visible neighbour; with none, it is the
    // previous one. Hidden rows that trailed the last visible row then follow.
    const full = [item('w1', 'work', 0), item('w2', 'work', 10), item('h1', 'home', 20)];
    const plan = planReorder(full, onlyList(full, 'work'), 0, 1);
    assert.deepEqual(plan.items.map(t => t.id), ['w2', 'w1', 'h1']);
    assert.deepEqual(onlyList(settle(full, plan.changes), 'work').map(t => t.id), ['w2', 'w1']);
    console.log('  ok');
  }

  console.log('planReorder: rubbish in, the list back out unchanged');
  {
    const full = [item('a', 'w', 0), item('b', 'w', 10)];
    const cases: Array<[string, number, number]> = [
      ['equal', 0, 0], ['negative from', -1, 0], ['negative to', 0, -1],
      ['from past the end', 5, 0], ['to past the end', 0, 5],
      ['fractional', 0.5 as number, 1], ['NaN', NaN, 1], ['Infinity', 0, Infinity],
    ];
    for (const [why, from, to] of cases) {
      const plan = planReorder(full, full, from, to);
      assert.deepEqual(plan.changes, [], `${why}: nothing written`);
      assert.deepEqual(plan.items.map(t => t.id), ['a', 'b'], `${why}: nothing moved`);
    }

    // A store holding the same id twice, which is a fault somewhere else: better
    // to refuse than to guess which one the finger was on and scramble both.
    const dupes = [item('a', 'w', 0), item('a', 'w', 10), item('b', 'w', 20)];
    assert.deepEqual(planReorder(dupes, dupes, 0, 2).changes, [], 'duplicate ids refuse');
    // A visible row that is not in the full list: "before the next visible one"
    // is then a place that does not exist.
    assert.deepEqual(planReorder(full, [item('ghost', 'w', 0), ...full], 0, 1).changes, [],
      'a visible row nobody can find refuses');
    assert.deepEqual(planReorder(full, [], 0, 0).changes, [], 'an empty visible list');
    assert.deepEqual(planReorder([], [], 0, 1).changes, [], 'an empty bucket');
    console.log('  ok');
  }

  console.log('planReorder: a reorder is always a permutation (property)');
  {
    // Random shapes, every from/to. The one thing that must never happen is a
    // row appearing twice or vanishing.
    let seed = 20260903;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const lists = ['work', 'home', 'errands'];

    for (let trial = 0; trial < 200; trial += 1) {
      // The bucket is generated the way the BOARD produces one: the rows that
      // have been placed come first, in their numbers' order, and the ones
      // nobody has touched trail them. Generating those two groups interleaved
      // would be testing an arrangement the board can never hand this function,
      // and every failure would be an artefact of the generator.
      const n = 1 + Math.floor(rnd() * 8);
      const placedCount = Math.floor(rnd() * (n + 1));
      const full: Item[] = [];
      for (let i = 0; i < n; i += 1) {
        full.push(item(`t${i}`, lists[Math.floor(rnd() * lists.length)],
          i < placedCount ? i * 10 : undefined));
      }
      const pick = rnd() < 0.25 ? null : lists[Math.floor(rnd() * lists.length)];
      const visible = onlyList(full, pick);
      if (visible.length === 0) continue;

      const from = Math.floor(rnd() * visible.length);
      const to = Math.floor(rnd() * visible.length);
      const plan = planReorder(full, visible, from, to);
      assert.deepEqual(plan.items.map(t => t.id).sort(), full.map(t => t.id).sort(),
        `trial ${trial}: still a permutation`);
      const after = settle(full, plan.changes);
      assert.deepEqual(after.map(t => t.id), plan.items.map(t => t.id),
        `trial ${trial}: the written numbers reproduce the plan`);
    }
    console.log('  ok');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADDING A STEP TO THE END
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('planAppendOrder: THE REGRESSION -- one past the last, not the count');
  {
    // Three steps dragged into 0, 10, 20. Numbering the fourth by counting gave
    // it 3, which lands it SECOND.
    const placed = [item('a', 's', 0), item('b', 's', 10), item('c', 's', 20)];
    const plan = planAppendOrder(placed);
    assert.equal(plan.order, 30, 'past the last one');
    assert.deepEqual(plan.changes, [], 'and nothing else is disturbed');
    assert.ok(plan.order > 20, 'which is the whole point');

    // Room is left between rows for the other machine, so it is +10 and not +1.
    assert.equal(plan.order - 20, ORDER_STEP);
  }

  console.log('planAppendOrder: siblings nobody has placed get numbered too');
  {
    // An unnumbered row sorts LAST, so handing the newcomer any finite number at
    // all would put it above them. The short list is numbered in the order it is
    // being drawn instead, and the newcomer really does go on the end.
    const fresh = [item('a', 's'), item('b', 's'), item('c', 's')];
    const plan = planAppendOrder(fresh);
    assert.deepEqual(plan.changes, [
      { id: 'a', order: 0 }, { id: 'b', order: 10 }, { id: 'c', order: 20 },
    ]);
    assert.equal(plan.order, 30);

    // Half placed, half not: still numbered by the drawn order, which is what
    // the user is looking at.
    const mixed = [item('a', 's', 0), item('b', 's'), item('c', 's', 20)];
    const m = planAppendOrder(mixed);
    assert.deepEqual(m.changes, [{ id: 'b', order: 10 }], 'only what actually changes is written');
    assert.equal(m.order, 30);
    console.log('  ok');
  }

  console.log('planAppendOrder: the odd shapes');
  {
    assert.deepEqual(planAppendOrder([]), { order: 0, changes: [] }, 'the first step of all');

    // Out-of-order or negative numbers: the highest wins, not the last.
    assert.equal(planAppendOrder([item('a', 's', 40), item('b', 's', 10)]).order, 50);
    assert.equal(planAppendOrder([item('a', 's', -30), item('b', 's', -10)]).order, 0);

    // Rubbish counts as never placed, so the whole list is renumbered rather
    // than the newcomer being sorted against a NaN.
    for (const junk of [NaN, Infinity, '5', null, undefined]) {
      const p = planAppendOrder([item('a', 's', 0), { id: 'b', list: 's', order: junk as never }]);
      assert.equal(p.order, 20, `${String(junk)} is not a place`);
      assert.deepEqual(p.changes, [{ id: 'b', order: 10 }]);
    }

    // A step that is already exactly where it would be put is not rewritten.
    assert.deepEqual(planAppendOrder([item('a', 's', 0), item('b', 's')]).changes,
      [{ id: 'b', order: 10 }]);
    assert.deepEqual(planAppendOrder([item('a', 's'), item('b', 's', 10)]).changes,
      [{ id: 'a', order: 0 }]);
    console.log('  ok');
  }

  console.log('planAppendOrder: appending twice in a row keeps arriving at the end');
  {
    // Steps arrive in threes and fours; each one has to land after the last.
    let steps: Item[] = [];
    for (let i = 0; i < 6; i += 1) {
      const plan = planAppendOrder(steps);
      const by = new Map(plan.changes.map(c => [c.id, c.order]));
      steps = [
        ...steps.map(t => (by.has(t.id) ? { ...t, order: by.get(t.id) as number } : t)),
        item(`s${i}`, 's', plan.order),
      ];
      assert.deepEqual(steps.map(t => t.id), steps.slice().sort(
        (a, b) => (a.order as number) - (b.order as number)).map(t => t.id),
        `after ${i + 1}: the drawn order is the numbered order`);
    }
    assert.deepEqual(steps.map(t => t.order), [0, 10, 20, 30, 40, 50]);
    console.log('  ok');
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // HOLDING THE DROPPED ORDER UNTIL THE STORE AGREES
  // ═══════════════════════════════════════════════════════════════════════════
  // This is the bug the user reported twice: drop a task in its new place, watch
  // it snap back to the old one, wait most of a second, watch it jump. The list
  // keeps drawing the dropped order across that gap, and this decides when to
  // stop. Too eager and the flicker comes back; too patient and the screen shows
  // a list that no longer exists.

  console.log('bridgeVerdict: the store catches up');
  {
    assert.equal(bridgeVerdict(['a', 'b', 'c'], ['a', 'b', 'c']), 'caught-up');
    assert.equal(bridgeVerdict([], []), 'caught-up', 'two empty lists agree');
    assert.equal(bridgeVerdict(['a'], ['a']), 'caught-up');
    console.log('  ok');
  }

  console.log('bridgeVerdict: the write has not landed yet');
  {
    // The same rows, a different order. This is the whole window the bridge
    // exists for, and the answer must be to keep drawing the drop.
    assert.equal(bridgeVerdict(['c', 'a', 'b'], ['a', 'b', 'c']), 'waiting');
    assert.equal(bridgeVerdict(['b', 'a'], ['a', 'b']), 'waiting');

    // Every rotation and every swap of a five-row list: still waiting, never
    // "changed", because nothing has actually come or gone.
    const rows = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 1; i < rows.length; i += 1) {
      const rotated = [...rows.slice(i), ...rows.slice(0, i)];
      assert.equal(bridgeVerdict(rotated, rows), 'waiting', `rotation by ${i}`);
    }
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const swapped = [...rows];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        assert.equal(bridgeVerdict(swapped, rows), 'waiting', `swap ${i}/${j}`);
      }
    }
    console.log('  ok');
  }

  console.log('bridgeVerdict: THE ROWS THEMSELVES CHANGED, so the truth wins at once');
  {
    // A task arriving from the PC, one ticked off and gone to Done, one deleted.
    // The bridge is holding a list that no longer exists; going on drawing it
    // would hide a real change for as long as the timeout runs.
    assert.equal(bridgeVerdict(['a', 'b'], ['a', 'b', 'c']), 'changed', 'one arrived');
    assert.equal(bridgeVerdict(['a', 'b', 'c'], ['a', 'b']), 'changed', 'one left');
    assert.equal(bridgeVerdict(['a', 'b'], ['a', 'z']), 'changed', 'one replaced');
    assert.equal(bridgeVerdict(['a'], []), 'changed', 'the last one went');
    assert.equal(bridgeVerdict([], ['a']), 'changed', 'the first one arrived');

    // Same LENGTH, different rows: counting is not enough, which is why the
    // membership is actually checked.
    assert.equal(bridgeVerdict(['a', 'b', 'c'], ['a', 'b', 'z']), 'changed');
    assert.equal(bridgeVerdict(['x', 'y'], ['a', 'b']), 'changed');
    console.log('  ok');
  }

  console.log('bridgeVerdict: keys that are not identities are refused');
  {
    // A duplicate key means the caller cannot tell two rows apart. Bridging on
    // that could draw a row twice; falling back to what the parent gave is at
    // worst the old flicker, which is a great deal better.
    assert.equal(bridgeVerdict(['a', 'a'], ['a', 'a']), 'changed');
    assert.equal(bridgeVerdict(['a', 'b'], ['a', 'a']), 'changed');
    assert.equal(bridgeVerdict(['a', 'a'], ['a', 'b']), 'changed');
    console.log('  ok');
  }

  console.log('bridgeVerdict: a real drop, followed end to end');
  {
    // Five tasks; the last is dragged to the top. What the list draws, and what
    // it is given, at each step of the second that follows.
    const before = ['a', 'b', 'c', 'd', 'e'];
    const dropped = ['e', 'a', 'b', 'c', 'd'];

    // The finger lifts. The parent still has the old order for a while.
    assert.equal(bridgeVerdict(dropped, before), 'waiting', 'the drop is held');
    // A render or two later, still nothing.
    assert.equal(bridgeVerdict(dropped, before), 'waiting');
    // The write lands.
    assert.equal(bridgeVerdict(dropped, dropped), 'caught-up', 'and the bridge ends');

    // The other ending: a sync arrives first with a new task, and the bridge
    // gets out of the way rather than hiding it.
    assert.equal(bridgeVerdict(dropped, [...before, 'f']), 'changed');
    console.log('  ok');
  }

  console.log('\nAll dragSort tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
