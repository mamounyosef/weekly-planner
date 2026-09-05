// ─── Which hours of the day the grid draws ───────────────────────────────────
// Not a start and an end. A SET of visible stretches.
//
// WHY THIS REPLACED A SIMPLE START AND END HOUR
// "Show 7am to 11pm" cannot say "show everything except the middle of the
// night", and those are different wishes. Someone who works late and prays at
// dawn wants 00:00 to 02:00 and 05:00 to 24:00, which no single pair of numbers
// can express. So the model is a list of visible ranges, and the old pair is
// simply the special case of a list with one entry in it.
//
// THE CONSEQUENCE, AND THE REASON THIS IS A MODULE RATHER THAN A FEW IFS
// Once hours can be missing from the middle, a minute no longer has a position
// you can get by multiplying. Nine in the morning is not nine hours down the
// grid if four of those hours are not drawn. Every mapping between a time and a
// pixel becomes piecewise, and there are a lot of them: the hour rail, the slot
// lines, an event's top and height, the now line, a prayer marker, and the
// inverse used by every drag. If any one of them disagrees with the others, a
// dragged block lands somewhere other than where it was dropped. So the mapping
// lives here, once, with its inverse tested against it.
//
// NOTHING IS EVER HIDDEN, ONLY UNDRAWN
// Hiding hours must never hide an item. A meeting at 3am with 3am switched off
// would be gone with nothing on screen to say so, which is the worst way for a
// planner to fail. `itemsOutsideView` exists so the grid can always say how many
// things are in the hours it is not drawing, and offer to show them.

/** A stretch of hours, `from` inclusive and `to` exclusive, in 0 to 24. */
export interface HourRange {
  from: number;
  to: number;
}

export const FULL_DAY: HourRange[] = [{ from: 0, to: 24 }];

const HOURS_IN_DAY = 24;
const MINUTES_IN_DAY = HOURS_IN_DAY * 60;

const clampHour = (raw: unknown): number | null => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const floored = Math.floor(n);
  if (floored < 0 || floored > HOURS_IN_DAY) return null;
  return floored;
};

/**
 * Clean a list of ranges into a canonical one: whole hours, in order, with
 * overlaps and touching ends merged, and nothing empty.
 *
 * CANONICAL MATTERS MORE THAN IT LOOKS. This is stored on the device and
 * compared to decide whether to write; two spellings of the same set of hours
 * would look like a change every time and rewrite storage forever.
 *
 * An empty result is impossible on purpose. A grid with no visible hours is not
 * a preference anyone holds, it is a blank screen with no way back, so an input
 * that comes to nothing gives the whole day instead.
 */
export function normaliseRanges(raw: unknown): HourRange[] {
  if (!Array.isArray(raw)) return [...FULL_DAY];

  const cleaned: HourRange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const from = clampHour((item as HourRange).from);
    const to = clampHour((item as HourRange).to);
    if (from === null || to === null) continue;
    if (to <= from) continue;
    cleaned.push({ from, to });
  }
  if (cleaned.length === 0) return [...FULL_DAY];

  cleaned.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: HourRange[] = [cleaned[0]];
  for (const range of cleaned.slice(1)) {
    const last = merged[merged.length - 1];
    // `<=` and not `<`: 6 to 9 and 9 to 12 are one stretch, not two with an
    // invisible seam between them that would draw a break line for no reason.
    if (range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/** The hours the grid is NOT drawing, as plain numbers. The inverse below. */
export function hiddenHours(ranges: readonly HourRange[]): number[] {
  const shown = new Set<number>();
  for (const r of ranges) for (let h = r.from; h < r.to; h += 1) shown.add(h);
  const out: number[] = [];
  for (let h = 0; h < HOURS_IN_DAY; h += 1) if (!shown.has(h)) out.push(h);
  return out;
}

/** Ranges from a set of hidden hours, which is how the settings screen thinks. */
export function rangesFromHidden(hidden: readonly number[]): HourRange[] {
  const off = new Set<number>();
  for (const h of hidden) {
    const v = clampHour(h);
    if (v !== null && v < HOURS_IN_DAY) off.add(v);
  }
  const out: HourRange[] = [];
  let run: HourRange | null = null;
  for (let h = 0; h < HOURS_IN_DAY; h += 1) {
    if (off.has(h)) { run = null; continue; }
    if (run) run.to = h + 1;
    else { run = { from: h, to: h + 1 }; out.push(run); }
  }
  return out.length ? out : [...FULL_DAY];
}

/** Whether a given minute of the day is drawn at all. */
export function isMinuteVisible(minute: number, ranges: readonly HourRange[]): boolean {
  const m = Number.isFinite(minute) ? minute : 0;
  return ranges.some(r => m >= r.from * 60 && m < r.to * 60);
}

/** How many minutes the grid actually draws. Its height is this times the rate. */
export function visibleMinutes(ranges: readonly HourRange[]): number {
  let total = 0;
  for (const r of ranges) total += (r.to - r.from) * 60;
  return total;
}

/**
 * Where a minute sits, in minutes down the DRAWN grid.
 *
 * A minute inside a hidden stretch has no position of its own, so it is given
 * the seam it falls at. That keeps an event whose start is hidden but whose end
 * is not from being drawn off the top, and it is why this never returns
 * something outside the grid.
 */
export function drawnMinuteOf(minute: number, ranges: readonly HourRange[]): number {
  const m = Number.isFinite(minute) ? minute : 0;
  let before = 0;
  for (const r of ranges) {
    const from = r.from * 60;
    const to = r.to * 60;
    if (m < from) return before;          // inside a hidden stretch: the seam above
    if (m < to) return before + (m - from);
    before += to - from;
  }
  return before;                          // past the last visible hour
}

/** Where a minute sits in pixels. The one function the whole grid measures by. */
export function yOfMinute(
  minute: number, ranges: readonly HourRange[], pxPerHour: number,
): number {
  return drawnMinuteOf(minute, ranges) * (pxPerHour / 60);
}

/**
 * The inverse: which minute a pixel position means.
 *
 * It MUST be the exact inverse of `yOfMinute` for every visible minute, or a
 * dragged block lands somewhere other than where it was dropped. The test
 * asserts the round trip rather than trusting the arithmetic.
 */
export function minuteAtY(
  y: number, ranges: readonly HourRange[], pxPerHour: number,
): number {
  const rate = pxPerHour / 60;
  if (!Number.isFinite(y) || !Number.isFinite(rate) || rate <= 0) {
    return ranges.length ? ranges[0].from * 60 : 0;
  }
  const drawn = y / rate;
  let before = 0;
  for (const r of ranges) {
    const span = (r.to - r.from) * 60;
    if (drawn < before + span) {
      const into = Math.max(0, drawn - before);
      return r.from * 60 + into;
    }
    before += span;
  }
  // Past the bottom: the last drawn minute, never a minute that is not shown.
  const last = ranges[ranges.length - 1];
  return last ? last.to * 60 : MINUTES_IN_DAY;
}

/** Every whole hour that is drawn, in minutes from midnight. */
export function hourMarksIn(ranges: readonly HourRange[]): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    for (let h = r.from; h <= r.to; h += 1) out.push(h * 60);
  }
  // A seam where one stretch ends and another begins can produce the same mark
  // twice; two lines drawn on one pixel read as a thicker line for no reason.
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Every slot line that is drawn, in minutes from midnight. */
export function slotsIn(ranges: readonly HourRange[], interval: number): number[] {
  const step = Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 30;
  const out: number[] = [];
  for (const r of ranges) {
    for (let m = r.from * 60; m <= r.to * 60; m += step) out.push(m);
    // The closing edge, so a stretch whose length is not a whole number of slots
    // still gets a line at its end rather than stopping short.
    out.push(r.to * 60);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Where the grid is cut, in drawn minutes: the seams between stretches.
 *
 * The view draws a break at each one. Without it 1am sits directly above 6am
 * with nothing to say four hours are missing, and the day silently misreads.
 */
export function seamsIn(ranges: readonly HourRange[]): number[] {
  const out: number[] = [];
  let before = 0;
  for (let i = 0; i < ranges.length; i += 1) {
    const span = (ranges[i].to - ranges[i].from) * 60;
    before += span;
    if (i < ranges.length - 1) out.push(before);
  }
  return out;
}

/**
 * How a span meets the hours the grid actually draws.
 *
 * A block is not simply in view or out of it. Hiding hours cuts three different
 * ways, and each needs saying differently on the face of the block:
 *
 *   - nothing of it is drawn, so it belongs in the list under the grid;
 *   - it starts before the first hour drawn, so what you see begins mid-event;
 *   - it runs past the last hour drawn, so what you see stops early.
 *
 * The last two are the ones that used to lie. A night from half past midnight
 * to nine, on a grid that stops at two, was drawn as an hour and a half of
 * sleep with nothing to say the rest existed.
 *
 * Only the ENDS are reported. A hidden stretch in the middle is already marked
 * by the seam drawn across every column, and saying it twice on each block that
 * happens to span it would be noise.
 */
export interface SpanClipping {
  /** No minute of this span is drawn at all. */
  hidden: boolean;
  /** It began before the first minute of it that is drawn. */
  clippedAbove: boolean;
  /** It goes on after the last minute of it that is drawn. */
  clippedBelow: boolean;
}

/**
 * `endMin` is exclusive, and must already be in the same frame as `ranges` --
 * the window's frame on a grid whose day starts at six, where two in the
 * morning is 26:00. An end at or before the start is treated as a single
 * minute, so a marker with no duration still reports whether it is drawn.
 */
export function clipSpan(
  startMin: number,
  endMin: number,
  ranges: readonly HourRange[],
): SpanClipping {
  const start = Number.isFinite(startMin) ? startMin : 0;
  const end = Number.isFinite(endMin) && endMin > start ? endMin : start + 1;

  let first: number | null = null;
  let last: number | null = null;
  for (const r of ranges) {
    const from = r.from * 60;
    const to = r.to * 60;
    const a = Math.max(start, from);
    const b = Math.min(end, to);
    if (a < b) {
      if (first === null) first = a;
      last = b;
    }
  }

  if (first === null || last === null) {
    return { hidden: true, clippedAbove: false, clippedBelow: false };
  }
  return { hidden: false, clippedAbove: first > start, clippedBelow: last < end };
}

/**
 * How many things fall in hours that are not drawn.
 *
 * The whole safety net. Hiding hours is a display choice, and a display choice
 * that loses a meeting is a bug however it was configured.
 */
export function itemsOutsideView<T>(
  items: readonly T[],
  minuteOf: (item: T) => number | null,
  ranges: readonly HourRange[],
): T[] {
  return items.filter(item => {
    const m = minuteOf(item);
    return m !== null && Number.isFinite(m) && !isMinuteVisible(m, ranges);
  });
}

/** Whether the whole day is drawn, which is worth saying differently. */
export function isFullDay(ranges: readonly HourRange[]): boolean {
  return ranges.length === 1 && ranges[0].from === 0 && ranges[0].to === 24;
}

const hourLabel = (hour: number, clock: string | undefined): string => {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (clock === '24h') return `${String(h).padStart(2, '0')}:00`;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
};

/** What a person reads back. Never a dash, so ranges are joined with "to". */
export function describeRanges(
  ranges: readonly HourRange[], clock?: string,
): string {
  if (isFullDay(ranges)) return 'The whole day is shown.';
  const parts = ranges.map(r => `${hourLabel(r.from, clock)} to ${hourLabel(r.to, clock)}`);
  const hidden = hiddenHours(ranges).length;
  const shape = parts.length === 1
    ? `Showing ${parts[0]}.`
    : `Showing ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
  return `${shape} ${hidden} ${hidden === 1 ? 'hour is' : 'hours are'} hidden.`;
}

// ─── Nights that run past the end of a column ────────────────────────────────
// A grid column holds one window: the same clock time on one day through to the
// same clock time on the next. Sleep does not respect it, and neither does a
// film that finishes at half past midnight. Drawn naively such an item has an
// end EARLIER than its start, which is not a short block, it is a block whose
// remainder belongs to the column beside it.
//
// So an item is cut into at most two pieces here, and each piece is given
// coordinates inside the window of the column it is drawn in. The view then
// reads a top and a height straight off a piece, with no further arithmetic:
// re-deriving those from the original item is precisely what drew a head half a
// day above its own column.

/** One drawn piece of an item, in the frame of the column it lands in. */
export interface DaySpan {
  /** Which column it belongs to. Always inside the range that was given. */
  col: number;
  startMin: number;
  endMin: number;
  /** The closing piece of something that ran over the end of its window. */
  isTail: boolean;
  /** The opening piece, drawn at the top of the following column. */
  isHead: boolean;
}

/**
 * Where a timed item is actually drawn, once nights that cross the window's
 * edge are accounted for.
 *
 * Returns nothing at all when the item belongs to a column outside the range on
 * screen, which is the honest answer: it is not that it has no place, it is
 * that its place is not being drawn.
 */
export function splitAcrossWindows(
  block: { startMin: number | null | undefined; endMin: number | null | undefined },
  opts: {
    /** The column the item's calendar day occupies. */
    col: number;
    /** How many columns are drawn, so a piece can never land outside them. */
    columns: number;
    /** The hour each column's window opens at. Zero means midnight to midnight. */
    dayStartHour?: number;
    /** How long an item with no end is treated as being. */
    fallbackMinutes?: number;
  },
): DaySpan[] {
  const start = block.startMin;
  if (typeof start !== 'number' || !Number.isFinite(start)) return [];

  const dayStartMin = Math.max(0, Math.round(opts.dayStartHour ?? 0)) * 60;
  const windowEnd = dayStartMin + 1440;
  const fallback = opts.fallbackMinutes ?? 30;

  const rawEnd = block.endMin;
  let end = typeof rawEnd === 'number' && Number.isFinite(rawEnd) ? rawEnd : start + fallback;
  // STRICTLY earlier, never equal. An end equal to the start is a moment with
  // no duration — a deadline at six — and reading that as a full day round the
  // clock would turn every such marker into a wall down the column.
  if (end < start) end += 1440;

  // Before the window opens is the tail end of the DAY BEFORE's window.
  const shift = start < dayStartMin ? 1440 : 0;
  const col = start < dayStartMin ? opts.col - 1 : opts.col;
  const from = start + shift;
  const to = end + shift;

  const out: DaySpan[] = [];
  const inRange = (c: number) => c >= 0 && c < opts.columns;

  if (to <= windowEnd) {
    if (inRange(col)) out.push({ col, startMin: from, endMin: to, isTail: false, isHead: false });
    return out;
  }

  if (inRange(col)) {
    out.push({ col, startMin: from, endMin: windowEnd, isTail: true, isHead: false });
  }
  if (inRange(col + 1)) {
    // Clamped, so something longer than a whole day cannot draw past the foot
    // of the column it opens.
    const headEnd = Math.min(dayStartMin + (to - windowEnd), windowEnd);
    out.push({ col: col + 1, startMin: dayStartMin, endMin: headEnd, isTail: false, isHead: true });
  }
  return out;
}

/**
 * The stretches a column actually draws, once the day is allowed to start at an
 * hour of your choosing.
 *
 * TWO SETTINGS, ONE TIMELINE. "The day starts at 6am" says where a column
 * BEGINS and where it ends, a day later. "Visible hours" says which hours
 * inside it are worth the space. They were never combined, so the window was a
 * number in the settings screen that changed nothing: the grid went on drawing
 * midnight to midnight and a night was cut in half at the wrong place.
 *
 * The ranges returned run in the WINDOW's frame, so a day starting at 6am ends
 * at 30, not at 6. Everything downstream already treats a range as arithmetic
 * rather than as a clock, and `formatHour` wraps past 24, so a label still
 * reads 2am.
 */
export function windowRanges(
  win: { start: number; end: number } | null | undefined,
  visible: readonly HourRange[] | null | undefined,
): HourRange[] {
  const vis = normaliseRanges(visible);
  if (!win) return vis;

  const rawStart = Number(win.start);
  const start = Number.isFinite(rawStart)
    ? Math.min(23, Math.max(0, Math.floor(rawStart)))
    : 0;
  const rawEnd = Number(win.end);
  const end = Number.isFinite(rawEnd)
    ? Math.min(start + 24, Math.max(start + 1, Math.floor(rawEnd)))
    : start + 24;

  const drawn: HourRange[] = [];
  for (let h = start; h < end; h += 1) {
    // Which clock hour this slot of the window is. A window that runs past
    // midnight asks about the small hours of the NEXT day, and the visible
    // hours are a statement about the clock, not about the window.
    const clock = ((h % 24) + 24) % 24;
    if (!isMinuteVisible(clock * 60, vis)) continue;
    const last = drawn[drawn.length - 1];
    if (last && last.to === h) last.to = h + 1;
    else drawn.push({ from: h, to: h + 1 });
  }

  // Hiding every hour of the window would leave a grid with no height at all,
  // which reads as a broken screen rather than as a setting. The window itself
  // is the floor.
  return drawn.length > 0 ? drawn : [{ from: start, to: end }];
}
