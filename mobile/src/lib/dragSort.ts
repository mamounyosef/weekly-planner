// Turning a finger dragging a row up and down into "this is where it lands".
//
// WHY THIS IS A MODULE AND NOT A FEW LINES INSIDE THE LIST COMPONENT
// The arithmetic here is only ever exercised by a thumb on glass, where a
// mistake looks like "the task went to the wrong place" and is impossible to
// tell apart from a mis-aimed drag. Every rule below (where the drop index
// changes, how far the rows that give way move, what happens when a row has
// not been measured yet) is a decision that has to be identical on the way up,
// on the way down, and at the two ends of the list, so it is written once here
// and tested rather than being re-derived in three places in a component.
//
// EVERYTHING IS IN THE SCROLLER'S COORDINATES. `y` is the row's offset inside
// the list container as `onLayout` reports it, so consecutive rows differ by
// height PLUS whatever gap the container puts between them. That is deliberate:
// a row that gives way must move by the whole slot the dragged row occupied,
// gap included, or the list visibly breathes in and out as things pass.

/** One measured row. `y` is its top inside the list; `height` its own height. */
export interface RowBox {
  readonly y: number;
  readonly height: number;
}

/** A list of measured rows. Holes are normal: `onLayout` has not fired yet. */
export type RowBoxes = ReadonlyArray<RowBox | undefined>;

/** The vertical middle of a row, or null when it has not been measured. */
export function centreOf(boxes: RowBoxes, index: number): number | null {
  const b = boxes[index];
  if (!b) return null;
  if (!Number.isFinite(b.y) || !Number.isFinite(b.height)) return null;
  return b.y + b.height / 2;
}

/**
 * How much vertical space row `index` occupies, gap included.
 *
 * Measured from the NEIGHBOURS' offsets rather than from the row's own height,
 * because the gap between cards belongs to the container and never appears in
 * any single row's layout. Falling back to the bare height (a one-row list, or
 * unmeasured neighbours) is only ever wrong by the gap, which is the smallest
 * error available.
 */
export function slotSpan(boxes: RowBoxes, index: number): number {
  const self = boxes[index];
  const next = boxes[index + 1];
  const prev = boxes[index - 1];

  if (self && next) {
    const span = next.y - self.y;
    if (Number.isFinite(span) && span > 0) return span;
  }
  if (self && prev) {
    const span = self.y - prev.y;
    if (Number.isFinite(span) && span > 0) return span;
  }
  if (self && Number.isFinite(self.height) && self.height > 0) return self.height;
  return 0;
}

/**
 * The distance the finger must travel before row `index` gives way.
 *
 * Expressed as a `dy` (the drag's own offset) so the component can hand the
 * number straight to an interpolation and never has to know where the drag
 * started. The row gives way at the moment the dragged row's centre reaches its
 * own: below it going down, above it going up. Level counts as reached, which
 * is what makes a drag of exactly one slot swap exactly one row.
 *
 * Returns null when either row is unmeasured, which the caller must read as
 * "this row does not move" rather than as zero -- a zero threshold would make a
 * row jump aside before the drag had begun.
 */
export function shiftThreshold(boxes: RowBoxes, from: number, index: number): number | null {
  if (index === from) return null;
  const a = centreOf(boxes, from);
  const b = centreOf(boxes, index);
  if (a === null || b === null) return null;
  return b - a;
}

/**
 * Where the dragged row would land if the finger let go now.
 *
 * Walks outward from the row's own index one neighbour at a time instead of
 * taking the nearest centre outright. Nearest-centre looks equivalent and is
 * not: with rows of different heights a tall card's centre can be closer than
 * the short card between them, and the drop then skips a row that the finger
 * never crossed. Walking cannot skip.
 *
 * A row gives way the moment the two centres are LEVEL, not once they are past
 * each other, so that dragging a card exactly one slot down lands it one slot
 * down. Off by a hair either way is the difference between a drag that works
 * and one that needs an extra shove.
 *
 * An unmeasured neighbour stops the walk. Passing "through" a row nobody has
 * measured would be a guess, and the honest answer is the last index the drag
 * demonstrably reached.
 */
export function dropIndexFor(boxes: RowBoxes, from: number, dy: number, count: number): number {
  if (count <= 1) return from;
  if (from < 0 || from >= count) return from;
  const start = centreOf(boxes, from);
  if (start === null || !Number.isFinite(dy)) return from;

  const centre = start + dy;
  let index = from;

  if (dy < 0) {
    while (index > 0) {
      const above = centreOf(boxes, index - 1);
      if (above === null || centre > above) break;
      index -= 1;
    }
    return index;
  }

  while (index < count - 1) {
    const below = centreOf(boxes, index + 1);
    if (below === null || centre < below) break;
    index += 1;
  }
  return index;
}

/**
 * How far row `index` has to move aside while `from` is being dragged to
 * `dropIndex`. Positive is down.
 *
 * Only the rows BETWEEN the two positions move, and they all move by exactly
 * one slot: that is what makes the gap under the finger look like a hole the
 * dragged card came out of rather than a list quietly rearranging itself.
 */
export function rowShift(boxes: RowBoxes, from: number, dropIndex: number, index: number): number {
  if (index === from || dropIndex === from) return 0;
  const span = slotSpan(boxes, from);
  if (span <= 0) return 0;
  if (dropIndex > from) return index > from && index <= dropIndex ? -span : 0;
  return index >= dropIndex && index < from ? span : 0;
}

/**
 * The list with one item moved.
 *
 * Out-of-range indices return the list unchanged rather than throwing: the only
 * way to get one is a drag that raced a list which changed underneath it, and
 * dropping that drag on the floor is better than a crash mid-gesture.
 */
export function reorderList<T>(items: readonly T[], from: number, to: number): T[] {
  const next = items.slice();
  if (from === to) return next;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return next;
  if (from < 0 || from >= items.length) return next;
  if (to < 0 || to >= items.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The manual sort keys for a freshly reordered list.
 *
 * Spaced out rather than 0,1,2 so that the other machine, which writes the same
 * field from the same kind of drag, has room to place something between two
 * rows without renumbering the world. The step matches the PC's.
 */
export const ORDER_STEP = 10;

export function manualOrders(count: number, step: number = ORDER_STEP): number[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(i * step);
  return out;
}
