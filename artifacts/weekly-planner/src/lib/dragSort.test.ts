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
  manualOrders, ORDER_STEP, type RowBoxes,
} from './dragSort';

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

  console.log('\nAll dragSort tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
