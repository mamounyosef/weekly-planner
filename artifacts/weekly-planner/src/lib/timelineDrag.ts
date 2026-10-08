// Where a dragged item lands on the week grid, in ABSOLUTE time.
//
// A column on the grid is one planner day: it runs from `dayStartMin` (say
// 06:00) to the same time the next morning. An item is stored as
// (dayIndex, startMin) with startMin in [dayStartMin, dayStartMin + 1440), so
// an overnight item like Sleeping 23:35 -> 08:05 is drawn twice: its evening
// part at the bottom of its own column and its morning part (the "head") at the
// top of the NEXT column.
//
// The old drag maths worked in column-local minutes and special-cased the head,
// which went wrong in three ways the user saw as "it ends up in the wrong day":
//  1. A linked pair (Sleeping + Get Up) grabbed by Sleeping's morning part
//     measured the day shift from the item's OWN day, not the column under the
//     pointer, so the pair jumped forward a whole day on the first move.
//  2. Every start was clamped to the visible window, so an overnight item
//     dragged by its head stopped dead at 01:55 instead of following the cursor.
//  3. Starts in the hidden early-morning band (02:00-06:00) were unreachable.
//
// Here everything is one number: minutes since day 0 at 00:00 of the planner
// day, i.e. day * 1440 + startMin. The pointer, the grab offset and the result
// all live on that line, so a head grab and a normal grab are the same maths,
// and the item always stays under the cursor (the pointer minute is inside the
// visible window and the offset is inside the item, so the item overlaps it).

export interface DayMinute { day: number; startMin: number }

const isNum = (n: number) => typeof n === 'number' && Number.isFinite(n);
const num = (n: number, fallback = 0) => (isNum(n) ? n : fallback);

export function absMin(day: number, minute: number): number {
  return Math.round(num(day)) * 1440 + num(minute);
}

/** Split an absolute minute back into (planner day, minute in that day's column). */
export function splitAbs(abs: number, dayStartMin: number): DayMinute {
  const ds = num(dayStartMin);
  const a = num(abs, ds);
  const day = Math.floor((a - ds) / 1440);
  return { day, startMin: a - day * 1440 };
}

export function snapTo(n: number, step: number): number {
  const s = isNum(step) && step > 0 ? step : 1;
  return Math.round(num(n) / s) * s;
}

/**
 * How far into the item the pointer grabbed it, in minutes. Works the same for
 * the evening part (pointer in the item's own column) and the morning part
 * (pointer in the next column), because both are measured on the absolute line.
 */
export function grabOffset(opts: {
  pointerDay: number; pointerMin: number;
  itemDay: number; itemStartMin: number; durationMin: number;
}): number {
  const off = absMin(opts.pointerDay, opts.pointerMin) - absMin(opts.itemDay, opts.itemStartMin);
  return Math.min(Math.max(off, 0), Math.max(0, num(opts.durationMin)));
}

/** Where a single dragged item lands. */
export function dragTo(opts: {
  pointerDay: number; pointerMin: number; offsetMin: number;
  dayStartMin: number; snap: number;
}): DayMinute {
  const start = snapTo(absMin(opts.pointerDay, opts.pointerMin) - num(opts.offsetMin), opts.snap);
  return splitAbs(start, opts.dayStartMin);
}

/**
 * Where every member of a group lands (a multi-selection or a linked train).
 * One delta for all of them, so their spacing is preserved exactly, measured
 * from the pointer's position at grab time (`grabDay`/`grabMin`), NOT from the
 * grabbed item's stored day.
 */
export function groupDragTo<K extends string>(opts: {
  items: Record<K, DayMinute>;
  grabDay: number; grabMin: number;
  pointerDay: number; pointerMin: number;
  dayStartMin: number; snap: number;
}): Record<K, DayMinute> {
  const delta = snapTo(absMin(opts.pointerDay, opts.pointerMin) - absMin(opts.grabDay, opts.grabMin), opts.snap);
  const out = {} as Record<K, DayMinute>;
  for (const id of Object.keys(opts.items) as K[]) {
    const it = opts.items[id];
    out[id] = splitAbs(absMin(it.day, it.startMin) + delta, opts.dayStartMin);
  }
  return out;
}

/** The stored HH:MM minute for a column minute (column minutes run past 24:00). */
export function toClockMin(startMin: number): number {
  const m = Math.round(num(startMin)) % 1440;
  return m < 0 ? m + 1440 : m;
}
