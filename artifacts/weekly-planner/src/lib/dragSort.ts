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

// ─── Dragging while a filter is on ───────────────────────────────────────────

/** The least a thing needs for its place in a hand-made order to be written. */
export interface Orderable {
  readonly id: string;
  readonly order?: number;
}

export interface ReorderPlan<T extends Orderable> {
  /** The WHOLE bucket in its new order, hidden rows included. */
  readonly items: T[];
  /** Only the rows whose stored number actually changes. */
  readonly changes: Array<{ id: string; order: number }>;
}

/**
 * Work out a reorder from a drag that happened inside a FILTERED list.
 *
 * WHAT WENT WRONG WITHOUT IT. The screen renumbered whatever it could see, from
 * zero, in tens. Reorder three tasks while the Work list is selected and they
 * become 0, 10, 20 -- and so is everything on Home, and on Errands, because each
 * of those was renumbered from zero on its own day. Clear the filter and the
 * three arrangements interleave, in an order nobody chose and nobody can undo.
 * Every one of those drags was a small, invisible act of vandalism against the
 * other lists.
 *
 * So the move is expressed against the FULL bucket instead. `visible` is the
 * subset the user is actually looking at, in the order they see it, and `from`
 * and `to` are indices into THAT. The moved row is placed among the hidden ones
 * so that:
 *
 *   - the visible rows come out in exactly the order the drag asked for, and
 *   - the hidden rows keep their order relative to each other and to the visible
 *     neighbours they were already sitting between.
 *
 * The anchor is the row's new NEXT visible neighbour, or its previous one when
 * it has been dropped last. Either way the answer is decided by a row the user
 * can see, which is the only thing they can reason about.
 *
 * Passing the same array as both `full` and `visible` is the unfiltered case and
 * behaves exactly as a plain reorder does.
 */
export function planReorder<T extends Orderable>(
  full: readonly T[],
  visible: readonly T[],
  from: number,
  to: number,
  step: number = ORDER_STEP,
): ReorderPlan<T> {
  const unchanged: ReorderPlan<T> = { items: full.slice(), changes: [] };

  if (from === to) return unchanged;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return unchanged;
  if (from < 0 || from >= visible.length) return unchanged;
  if (to < 0 || to >= visible.length) return unchanged;

  // A row can only be placed once. Two entries sharing an id is a store that has
  // gone wrong somewhere else, and guessing which one moved would turn that into
  // a scrambled list here as well.
  const indexById = new Map<string, number>();
  for (let i = 0; i < full.length; i += 1) {
    const id = full[i]?.id;
    if (typeof id !== 'string' || id === '') return unchanged;
    if (indexById.has(id)) return unchanged;
    indexById.set(id, i);
  }

  const movedId = visible[from]?.id;
  if (typeof movedId !== 'string' || !indexById.has(movedId)) return unchanged;
  // Every visible row has to be locatable in the full list, or "before the next
  // visible one" is a position that does not exist.
  for (const v of visible) {
    if (typeof v?.id !== 'string' || !indexById.has(v.id)) return unchanged;
  }

  const nextVisible = reorderList(visible, from, to);
  const after = nextVisible[to + 1];
  const before = nextVisible[to - 1];

  const rest = full.filter(t => t.id !== movedId);
  const at = after
    ? rest.findIndex(t => t.id === after.id)
    : before
      ? rest.findIndex(t => t.id === before.id) + 1
      : rest.length;

  const items = rest.slice();
  const landing = at < 0 ? items.length : at;
  items.splice(landing, 0, full[indexById.get(movedId) as number]);

  // ONE ROW IF ONE ROW WILL DO.
  //
  // Renumbering the whole bucket is correct and was what this did, and on a
  // phone it is also what made a drop take most of a second: every row written
  // is a merge, a row in the op log and a line in the next sync. Twenty tasks
  // in Today meant twenty of each, for a gesture that moved one thing.
  //
  // Numbers are spaced ten apart precisely so there is room to slide something
  // between two of them without disturbing either. When that room exists, the
  // answer is a single write and every other row keeps the number it had.
  const slim = slideBetween(items, landing, step);
  if (slim) return { items, changes: [slim] };

  // No room, or numbers that were never in order to begin with. Renumbering
  // repairs both, and is the only thing that can.
  const keys = manualOrders(items.length, step);
  const changes: Array<{ id: string; order: number }> = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].order !== keys[i]) changes.push({ id: items[i].id, order: keys[i] });
  }
  return { items, changes };
}

/**
 * A number for the row at `landing` that puts it there without moving anything
 * else, or null when no such number exists.
 *
 * The conditions are strict on purpose. Every OTHER row keeps its stored number,
 * so those numbers have to already say what the list looks like: all present,
 * and strictly increasing. One row sharing a number with another, or one that
 * was never placed, means the order on screen is not the order in the store, and
 * sliding a row into that is how a list ends up in a state nobody can explain.
 * Renumbering is the honest answer there, and it repairs the damage on its way.
 */
function slideBetween<T extends Orderable>(
  items: readonly T[], landing: number, step: number,
): { id: string; order: number } | null {
  const at = (i: number): number | null => {
    const v = items[i]?.order;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  for (let i = 0; i < items.length; i += 1) {
    if (i === landing) continue;
    if (at(i) === null) return null;
    // Strictly increasing, skipping the row being placed: its own number is
    // whatever it used to be and is about to be replaced.
    const j = i + 1 === landing ? i + 2 : i + 1;
    if (j < items.length && j !== landing) {
      const a = at(i) as number;
      const b = at(j);
      if (b === null || b <= a) return null;
    }
  }

  const before = landing === 0 ? null : at(landing - 1);
  const after = landing === items.length - 1 ? null : at(landing + 1);

  // Room at the ends is unbounded, so a drop to the top or the bottom is always
  // one write.
  if (before === null && after === null) return null;
  if (before === null) return { id: items[landing].id, order: (after as number) - step };
  if (after === null) return { id: items[landing].id, order: before + step };

  // A whole number strictly between the two, or nothing. Fractions would work
  // here and are not used: `order` is compared and stored on two machines, and
  // halving a gap forever is how you arrive at numbers that no longer compare
  // the way they read.
  const gap = after - before;
  if (gap < 2) return null;
  const order = Math.floor(before + gap / 2);
  if (order <= before || order >= after) return null;
  return { id: items[landing].id, order };
}

/**
 * Where a newly created step goes, and what has to be renumbered to put it there.
 *
 * WHAT WENT WRONG WITHOUT IT. A new step was numbered by counting the ones
 * already there: the third got `2`. That is right exactly until somebody drags
 * the steps, after which they are numbered 0, 10, 20 -- and `2` lands the new
 * step SECOND, in the middle of a list it was supposed to join the end of.
 *
 * The rule is "one step past the last one", which needs every sibling to
 * actually have a number: an absent one sorts last (see `orderKey`), so handing
 * the newcomer any finite number at all would put it above the unnumbered ones
 * rather than below them. So when some sibling has never been placed, the whole
 * short list is numbered in the order it is currently DRAWN -- which is what the
 * user is looking at, and therefore the only order that will not surprise them.
 * Steps come in threes and fours, so this costs nothing.
 *
 * `siblings` must be in the order they appear on screen. `changes` is empty in
 * the ordinary case where they have all been placed already.
 */
export function planAppendOrder<T extends Orderable>(
  siblings: readonly T[],
  step: number = ORDER_STEP,
): { order: number; changes: Array<{ id: string; order: number }> } {
  const real = (t: T): number | null =>
    typeof t?.order === 'number' && Number.isFinite(t.order) ? t.order : null;

  const allPlaced = siblings.length > 0 && siblings.every(t => real(t) !== null);

  if (allPlaced) {
    let highest = -step;
    for (const t of siblings) {
      const v = real(t) as number;
      if (v > highest) highest = v;
    }
    // Room is left for the other machine to place something between two rows,
    // so `highest + step` and never `highest + 1`.
    return { order: highest + step, changes: [] };
  }

  const keys = manualOrders(siblings.length + 1, step);
  const changes: Array<{ id: string; order: number }> = [];
  siblings.forEach((t, i) => {
    if (typeof t?.id === 'string' && t.id !== '' && real(t) !== keys[i]) {
      changes.push({ id: t.id, order: keys[i] });
    }
  });
  return { order: keys[siblings.length], changes };
}

// ─── Placing several rows at once ────────────────────────────────────────────

/**
 * The numbers that make `after` the drawn order, writing as few rows as it can.
 *
 * `before` is the list exactly as it is drawn now (so the rows nobody has
 * placed are at the end, in the order the tie-breaks put them), and `after` is
 * the same rows in the order they should be drawn in. Only rows whose number
 * actually changes come back. Null when the two are not the same set of rows.
 *
 * WHY NOT JUST RENUMBER. Every row written is a merge, an op in the log and a
 * line in the next sync on the other machine, and a renumber also rewrites
 * rows the user never touched. So:
 *
 *   - The longest run of rows whose numbers already climb in the new order
 *     keeps its numbers. Everything else is slotted between them, which is
 *     always possible at the two ends and possible in the middle while the
 *     numbers are spaced (that is what ORDER_STEP is for).
 *   - Rows that were never placed, sitting at the very end in the order they
 *     are already drawn, stay unplaced: they are drawn there anyway.
 *   - When there is no room, the list is renumbered 0, 10, 20 in the new
 *     order, which is the only thing that can repair numbers that never were
 *     in order.
 *
 * Whole numbers only, as in `slideBetween`: fractions halve forever.
 */
export function planOrderNumbers<T extends Orderable>(
  before: readonly T[],
  after: readonly T[],
  step: number = ORDER_STEP,
): Array<{ id: string; order: number }> | null {
  if (before.length !== after.length) return null;
  const posBefore = new Map<string, number>();
  for (let i = 0; i < before.length; i += 1) {
    const id = before[i]?.id;
    if (typeof id !== 'string' || id === '' || posBefore.has(id)) return null;
    posBefore.set(id, i);
  }
  const seen = new Set<string>();
  for (const t of after) {
    const id = t?.id;
    if (typeof id !== 'string' || !posBefore.has(id) || seen.has(id)) return null;
    seen.add(id);
  }

  const real = (t: T): number | null =>
    typeof t.order === 'number' && Number.isFinite(t.order) ? t.order : null;

  // The unplaced tail: drawn last already, in this same order, so left alone.
  let head = after.length;
  while (head > 0) {
    const t = after[head - 1];
    if (real(t) !== null) break;
    if (head < after.length && (posBefore.get(t.id) as number) > (posBefore.get(after[head].id) as number)) break;
    head -= 1;
  }

  // A climbing run of real numbers among the rest keeps them. Rows that have
  // not moved at all count for far more than rows that have, so the rows the
  // request did not name are the last thing ever written; a plain longest run
  // is the second choice, and a renumber the last.
  const idx: number[] = [];
  for (let i = 0; i < head; i += 1) if (real(after[i]) !== null) idx.push(i);

  const keepRun = (weight: (i: number) => number): Set<number> => {
    // O(n^2) is fine: a section of a task board is tens of rows, not thousands.
    const best = new Array<number>(idx.length).fill(0);
    const prev = new Array<number>(idx.length).fill(-1);
    let top = -1;
    for (let k = 0; k < idx.length; k += 1) {
      const v = real(after[idx[k]]) as number;
      best[k] = weight(idx[k]);
      for (let m = 0; m < k; m += 1) {
        if ((real(after[idx[m]]) as number) < v && best[m] + weight(idx[k]) > best[k]) {
          best[k] = best[m] + weight(idx[k]);
          prev[k] = m;
        }
      }
      if (top < 0 || best[k] > best[top]) top = k;
    }
    const kept = new Set<number>();
    for (let k = top; k >= 0; k = prev[k]) kept.add(idx[k]);
    return kept;
  };

  // Numbers for everything between the kept rows, or null when they do not fit.
  const fill = (kept: Set<number>): Map<number, number> | null => {
    if (!kept.size) return null;
    const out = new Map<number, number>();
    let i = 0;
    while (i < head) {
      if (kept.has(i)) { i += 1; continue; }
      let j = i;
      while (j < head && !kept.has(j)) j += 1;
      const run = j - i;
      const lower = i > 0 ? real(after[i - 1]) as number : null;   // i-1 is kept
      const upper = j < head ? real(after[j]) as number : null;    // j is kept
      if (lower !== null && upper !== null && upper - lower < run + 1) return null;
      for (let r = 0; r < run; r += 1) {
        const v = lower === null ? (upper as number) - step * (run - r)
          : upper === null ? lower + step * (r + 1)
          : lower + Math.floor(((upper - lower) * (r + 1)) / (run + 1));
        if (!Number.isFinite(v)) return null;
        out.set(i + r, v);
      }
      i = j;
    }
    return out;
  };

  const unmoved = (i: number) => (posBefore.get(after[i].id) === i ? head + 1 : 1);
  let out = fill(keepRun(unmoved)) ?? fill(keepRun(() => 1));
  if (!out) {
    out = new Map<number, number>();
    const keys = manualOrders(head, step);
    for (let k = 0; k < head; k += 1) out.set(k, keys[k]);
  }

  const changes: Array<{ id: string; order: number }> = [];
  for (const [k, v] of [...out.entries()].sort((a, b) => a[0] - b[0])) {
    if (after[k].order !== v) changes.push({ id: after[k].id, order: v });
  }
  return changes;
}

/**
 * Put some rows of a list into a new order WITHOUT disturbing the others.
 *
 * `full` is the whole bucket as drawn now (every list, not just the ones on
 * screen) and `ids` names some of its rows, top to bottom. Those rows are
 * re-dealt into the same places they occupied between them, in the order
 * given; every row not named stays exactly where it was. That is what makes it
 * safe to reorder what one list shows: the tasks of the lists that are not
 * shown keep their places, relative to each other and to everything else.
 *
 * Null when the request names a row twice or one that is not in `full`.
 */
export function planSubsetOrder<T extends Orderable>(
  full: readonly T[],
  ids: readonly string[],
  step: number = ORDER_STEP,
): ReorderPlan<T> | null {
  const at = new Map<string, number>();
  for (let i = 0; i < full.length; i += 1) {
    const id = full[i]?.id;
    if (typeof id !== 'string' || id === '' || at.has(id)) return null;
    at.set(id, i);
  }
  if (new Set(ids).size !== ids.length) return null;
  if (!ids.every(id => at.has(id))) return null;

  const slots = ids.map(id => at.get(id) as number).sort((a, b) => a - b);
  const items = full.slice();
  slots.forEach((slot, k) => { items[slot] = full[at.get(ids[k]) as number]; });
  const changes = planOrderNumbers(full, items, step);
  return changes ? { items, changes } : null;
}

/** Where `placeRow` puts a row: next to another row, or at an end. */
export type RowPlacement =
  | { before: string }
  | { after: string }
  | { edge: 'top' | 'bottom' };

/**
 * The list with one row taken out and put back at `where`. Null when the row
 * or the anchor is not in the list, or the row is its own anchor.
 */
export function placeRow<T extends Orderable>(items: readonly T[], id: string, where: RowPlacement): T[] | null {
  const from = items.findIndex(t => t.id === id);
  if (from < 0) return null;
  const rest = items.filter((_, i) => i !== from);
  let to: number;
  if ('edge' in where) to = where.edge === 'top' ? 0 : rest.length;
  else {
    const anchor = 'before' in where ? where.before : where.after;
    if (anchor === id) return null;
    const a = rest.findIndex(t => t.id === anchor);
    if (a < 0) return null;
    to = 'before' in where ? a : a + 1;
  }
  rest.splice(to, 0, items[from]);
  return rest;
}

// ─── Holding the dropped order until the store agrees ────────────────────────

/**
 * Should the list go on drawing the order it just dropped into, or hand back to
 * the order it is being given?
 *
 * WHY A LIST EVER DRAWS SOMETHING IT WAS NOT GIVEN. A row is drawn in a slot and
 * then pushed out of it by a transform, and those two reach the screen by
 * different routes: the transform at once, the slot only when React next
 * renders. On a drop both have to change together or the row is drawn wrong in
 * between -- and on a phone the render waits on a merge, a database write and
 * the start of a sync, which is most of a second of the row sitting back where
 * it was picked up. So the list keeps drawing the dropped order across that gap.
 *
 * It is a bridge and it must be short. Three ways it ends:
 *
 *  • `caught-up`  the order given now matches the one being drawn. Done.
 *  • `changed`    the ROWS are different, not just their order -- something
 *                 arrived from a sync, or was ticked off, or deleted on the PC.
 *                 The bridge is holding a list that no longer exists, so the
 *                 truth wins immediately rather than being hidden.
 *  • `waiting`    the same rows in a different order: the write has not landed
 *                 yet. Keep drawing the drop. (The caller also gives up after a
 *                 few seconds, in case it never lands at all.)
 */
export type BridgeVerdict = 'caught-up' | 'changed' | 'waiting';

export function bridgeVerdict(
  drawn: readonly string[],
  given: readonly string[],
): BridgeVerdict {
  if (drawn.length !== given.length) return 'changed';

  // A repeated key means the caller's identities are not identities, and it has
  // to be checked on BOTH sides: a duplicate among the rows being DRAWN is the
  // dangerous one, and it does not show up in a set built from the other list.
  // Refusing to bridge is the safe answer -- the list is redrawn from what it
  // was given, which is at worst the old flicker and never a row drawn twice.
  const seen = new Set(given);
  if (seen.size !== given.length) return 'changed';
  if (new Set(drawn).size !== drawn.length) return 'changed';

  for (const key of drawn) {
    if (!seen.has(key)) return 'changed';
  }

  for (let i = 0; i < drawn.length; i += 1) {
    if (drawn[i] !== given[i]) return 'waiting';
  }
  return 'caught-up';
}
