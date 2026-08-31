// ─── Dragging on a time grid ─────────────────────────────────────────────────
// Turning a finger's position into a time, and a drag into a range.
//
// WHY THIS IS NOT DONE IN THE COMPONENT
// The gesture code on the phone is already the hardest part of that screen: a
// PanResponder that has to tell a tap from a scroll from a long press, keep a
// ghost following the thumb at sixty frames a second, and never claim the
// responder from the ScrollView by accident. Mixing arithmetic into that means
// the arithmetic is only ever "tested" by dragging a finger across a phone and
// squinting at the result, which is how you end up with an event that quietly
// lands at 9:05 when the grid snaps to fifteen, or a block that gets squashed
// to nothing when you drag it past midnight.
//
// So every decision that does not need a screen lives here, pure and tested:
// where a pixel is in time, how a time is rounded to the user's interval, and
// what a drag from A to B means. The component is left with nothing but
// bookkeeping.
//
// TWO RULES RUN THROUGH ALL OF IT
//  1. Nothing ever comes back inverted, zero-length or outside the visible
//     window. A drag is a gesture made with a thumb on glass; it will go
//     backwards, it will overshoot the end of the day, and it will sometimes be
//     a tap that moved two pixels. Every one of those has to produce something
//     usable rather than an error.
//  2. Moving a block clamps the WHOLE block. Dragging an hour-long meeting into
//     the top of the grid must give an hour-long meeting at the top, not a
//     meeting squashed to five minutes. Only an explicit resize changes a
//     duration.

import { MIN_BLOCK_MINUTES, yOf } from './grid';

export type SnapMode = 'nearest' | 'floor' | 'ceil';

export interface Range {
  startMin: number;
  endMin: number;
}

export interface Block {
  startMin: number;
  /** Null for an item with a start and no end. Moving one keeps it null. */
  endMin: number | null;
}

/** A sane interval, whatever the settings happen to hold. */
function safeInterval(interval: number): number {
  if (!Number.isFinite(interval) || interval <= 0) return 30;
  return Math.max(1, Math.round(interval));
}

/** The visible window in minutes, always at least one minute wide. */
function windowOf(fromHour: number, toHour: number): { lo: number; hi: number } {
  const lo = Number.isFinite(fromHour) ? fromHour * 60 : 0;
  const hiRaw = Number.isFinite(toHour) ? toHour * 60 : 24 * 60;
  return { lo, hi: Math.max(lo + 1, hiRaw) };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Which moment a pixel offset from the top of the grid points at.
 *
 * The inverse of `yOf`, which the grid already uses to draw. They must stay
 * exact inverses of each other or a block lands one slot away from where the
 * ghost was drawn, which reads as the app ignoring you.
 */
export function minutesAtY(y: number, pxPerHour: number, fromHour = 0): number {
  const base = Number.isFinite(fromHour) ? fromHour * 60 : 0;
  if (!Number.isFinite(y) || !Number.isFinite(pxPerHour) || pxPerHour <= 0) return base;
  return base + (y * 60) / pxPerHour;
}

/** Where a moment sits, in pixels from the top of the grid. Re-exported from
 *  `grid` so a component dragging things only has to import one module. */
export const yAtMinutes = yOf;

/**
 * Round a time to the user's snap interval.
 *
 * 'nearest' is for a thing being placed (a block being moved lands on the
 * closest line), 'floor'/'ceil' are for the two ends of a drag, so that a
 * selection always covers everything the thumb passed over rather than
 * shrinking away from it.
 *
 * Snapping is idempotent by construction: snapping an already-snapped value
 * returns it unchanged, in every mode. The gesture code relies on that, because
 * it snaps on every frame rather than only on release.
 */
export function snapMinutes(min: number, interval: number, mode: SnapMode = 'nearest'): number {
  const step = safeInterval(interval);
  if (!Number.isFinite(min)) return 0;
  const n = min / step;
  // A hair of tolerance: floating point turns 540/15 into 35.999999999999996
  // often enough to matter, and a ceil on that value jumps a whole slot.
  const eps = 1e-9;
  const k = mode === 'floor' ? Math.floor(n + eps)
    : mode === 'ceil' ? Math.ceil(n - eps)
    : Math.round(n);
  const out = k * step;
  // Negative zero is a real value here: a drag just above midnight snaps to -0,
  // which compares equal to 0 everywhere except the one place it matters, an
  // identity check that decides whether anything changed.
  return out === 0 ? 0 : out;
}

/**
 * The range a create-drag has swept out.
 *
 * Dragging UPWARD is the same gesture as dragging down: people reach for the
 * end of a meeting they already know and pull back to its start. So the two
 * points are sorted rather than trusted in order.
 *
 * A drag that covers no distance at all (a press and release, or a two pixel
 * wobble) still has to make a usable event, so anything shorter than one
 * interval becomes exactly one interval. That is the difference between "tap
 * an empty slot to add something there" working and doing nothing.
 */
export function createRange(opts: {
  anchorMin: number;
  currentMin: number;
  interval: number;
  fromHour: number;
  toHour: number;
}): Range {
  const step = safeInterval(opts.interval);
  const { lo, hi } = windowOf(opts.fromHour, opts.toHour);

  // A window too small to hold one slot is degenerate; give back the window
  // itself rather than something inverted.
  if (hi - lo <= step) return { startMin: lo, endMin: hi };

  const a = clamp(opts.anchorMin, lo, hi);
  const b = clamp(opts.currentMin, lo, hi);

  let start = snapMinutes(Math.min(a, b), step, 'floor');
  let end = snapMinutes(Math.max(a, b), step, 'ceil');

  // Snapping outward can leave either end just outside a window that does not
  // itself sit on the grid, so the window has the last word.
  start = clamp(start, lo, hi - step);
  end = clamp(end, lo, hi);

  if (end - start < step) end = start + step;
  if (end > hi) {
    end = hi;
    start = Math.min(start, end - step);
  }
  return { startMin: start, endMin: end };
}

/**
 * Where a block ends up after being dragged by `deltaMin`.
 *
 * The delta is applied to the start and the block keeps its length, including
 * at the ends of the window: dragging a two hour block off the bottom of the
 * grid gives a two hour block flush with the bottom. Squashing it instead would
 * silently rewrite a duration the user never touched.
 */
export function moveBlock(opts: {
  startMin: number;
  endMin: number | null;
  deltaMin: number;
  interval: number;
  fromHour: number;
  toHour: number;
}): Block {
  const step = safeInterval(opts.interval);
  const { lo, hi } = windowOf(opts.fromHour, opts.toHour);

  const start0 = Number.isFinite(opts.startMin) ? opts.startMin : lo;
  const delta = Number.isFinite(opts.deltaMin) ? opts.deltaMin : 0;

  // A backwards or missing end is not a duration; treat it as zero rather than
  // propagating a negative length through the clamp.
  const duration = opts.endMin === null || !Number.isFinite(opts.endMin as number)
    ? null
    : Math.max(0, (opts.endMin as number) - start0);

  // Null-ended items have a position but no length, so only the start is
  // clamped and the room needed below it is zero.
  const room = duration ?? 0;
  const latest = Math.max(lo, hi - room);

  const start = clamp(snapMinutes(start0 + delta, step, 'nearest'), lo, latest);

  return {
    startMin: start,
    endMin: duration === null ? null : start + duration,
  };
}

/**
 * The shortest a block may be made by dragging its bottom edge.
 *
 * `MIN_BLOCK_MINUTES` is what the grid needs to draw a block you can still read
 * and still grab again; the snap interval is what the user asked for. The
 * larger of the two wins, rounded up to a whole number of slots so the end
 * still lands on a grid line. Leaving it off the grid would put the resize
 * handle between two lines and make the next drag jump.
 */
export function minBlockMinutes(interval: number): number {
  const step = safeInterval(interval);
  return Math.ceil(Math.max(step, MIN_BLOCK_MINUTES) / step) * step;
}

/**
 * Where a block's end goes when its bottom edge is dragged to `pointerMin`.
 *
 * The end can never cross the start, and it can never go under the minimum
 * length: a block dragged shut would vanish under the thumb with no way to get
 * it back. The start is never touched, because the handle being dragged is the
 * bottom one.
 */
export function resizeBlock(opts: {
  startMin: number;
  endMin: number | null;
  pointerMin: number;
  interval: number;
  fromHour: number;
  toHour: number;
}): Range {
  const step = safeInterval(opts.interval);
  const { lo, hi } = windowOf(opts.fromHour, opts.toHour);
  const min = minBlockMinutes(step);

  const start = clamp(Number.isFinite(opts.startMin) ? opts.startMin : lo, lo, hi);
  const floorEnd = start + min;

  let end = snapMinutes(
    Number.isFinite(opts.pointerMin) ? opts.pointerMin : floorEnd,
    step,
    'nearest',
  );

  // The window first, then the minimum, in that order: a block at the very
  // bottom of the grid is allowed to run one slot past it rather than being
  // crushed, because a zero-height block is unrecoverable and a slightly
  // overhanging one is not.
  end = Math.min(end, hi);
  end = Math.max(end, floorEnd);

  return { startMin: start, endMin: end };
}

/**
 * Which day column a horizontal position is over.
 *
 * Used while dragging a block sideways in the week and custom views, where
 * moving across a column boundary changes the item's DATE. Positions off either
 * edge clamp to the end columns instead of returning nothing: a thumb that
 * strays onto the hour rail or past the screen edge is still clearly aiming at
 * the first or last day, and dropping the item back where it started at that
 * moment would feel like the drag was cancelled.
 */
export function columnAtX(
  x: number,
  railWidth: number,
  totalWidth: number,
  columnCount: number,
): number {
  const count = Number.isFinite(columnCount) ? Math.floor(columnCount) : 0;
  if (count <= 1) return 0;

  const rail = Number.isFinite(railWidth) ? railWidth : 0;
  const total = Number.isFinite(totalWidth) ? totalWidth : 0;
  const width = (total - rail) / count;
  if (!Number.isFinite(width) || width <= 0) return 0;
  if (!Number.isFinite(x)) return 0;

  // The epsilon is not cosmetic. A column width is a screen width divided by
  // seven, so a position computed as `rail + width * n` comes back a hair under
  // the boundary in binary and floors into the previous column. Without it, the
  // left edge of a column is the one place a drop lands on the wrong day.
  return clamp(Math.floor((x - rail) / width + 1e-9), 0, count - 1);
}
