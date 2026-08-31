// ─── Month grid: sweeping a range, and drawing things that span days ─────────
// Everything about the month view that can be decided without React.
//
// WHY THIS IS A SEPARATE FILE
// Two features live here and they are the same problem seen twice. Dragging a
// finger across cells to create a multi-day event, and painting an existing
// multi-day event across the cells it covers, both come down to: turn a pair of
// dates into a run of coloured segments, one per week row, with the right ends
// rounded. Getting that wrong is the kind of bug you SEE rather than crash on,
// so it is pure, and it is tested rather than eyeballed.
//
// DATES ARE STRINGS, ON PURPOSE
// Everything here is `YYYY-MM-DD`. Zero-padded ISO dates compare lexicographically
// in exactly calendar order, so "is this date inside the span" is a string
// comparison that cannot be broken by a timezone, a DST hour, or a Date object
// silently rolling into the next month. The only place a real Date appears is
// counting days between two dates, and that is done in UTC so a clock change
// never turns a five day span into four and a half.
//
// A NOTE ON LANES
// Two events covering overlapping days must never be drawn on the same row of a
// cell, because the second one would land exactly on top of the first and simply
// not exist. Same failure as the day grid's columns, same rule: overlapping
// items never share a lane, and the assignment is stable so a band does not hop
// between rows when an unrelated event elsewhere in the month is edited.

import { colourOf, titleOf, ymd } from './agenda';
import type { EventCategory } from './categories';
import { occurrenceStarts, parseDate, type RecurFields, type WeekStartsOn } from './recurrence';

// ─── Dates ───────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well formed `YYYY-MM-DD`. Anything else is treated as absent. */
export function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value);
}

/**
 * Days between two dates, inclusive of both ends.
 *
 * Done as UTC midnights. Local midnights are 23 or 25 hours apart twice a year,
 * and dividing that by 86400000 rounds the wrong way just often enough to make a
 * span read "4 days" in one hemisphere and "5 days" in the other.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * `date` moved by `delta` days.
 *
 * Built from the calendar fields rather than by adding milliseconds, so it is
 * immune to DST and correct across month, year and leap year boundaries.
 */
export function shiftDate(date: string, delta: number): string {
  const d = new Date(
    +date.slice(0, 4),
    +date.slice(5, 7) - 1,
    +date.slice(8, 10) + delta,
  );
  return ymd(d);
}

// ─── Hit testing ─────────────────────────────────────────────────────────────

export interface GridMetrics {
  /** Width of the whole grid, in points. */
  width: number;
  /** Height of the whole grid, in points. */
  height: number;
  rows?: number;
  cols?: number;
}

export interface GridCell {
  row: number;
  col: number;
}

/**
 * Which cell a touch at (x, y) is over, in grid-local coordinates.
 *
 * ALWAYS CLAMPED. A finger dragging across a month grid leaves it constantly:
 * past the last column, off the bottom of the last row, into the weekday
 * headings above. Returning null there would make the selection flicker away and
 * back as the thumb wanders, so instead the nearest cell wins and the band stays
 * whole. Exact boundaries belong to the cell they start: x equal to one column
 * width is the second column, not the first.
 */
export function cellAt(x: number, y: number, m: GridMetrics): GridCell {
  const rows = Math.max(1, Math.floor(m.rows ?? 6));
  const cols = Math.max(1, Math.floor(m.cols ?? 7));
  const w = m.width > 0 ? m.width / cols : 0;
  const h = m.height > 0 ? m.height / rows : 0;

  const col = w > 0 && Number.isFinite(x) ? clamp(Math.floor(x / w), 0, cols - 1) : 0;
  const row = h > 0 && Number.isFinite(y) ? clamp(Math.floor(y / h), 0, rows - 1) : 0;
  return { row, col };
}

/** The date under a cell, or null when the grid does not have that cell. */
export function dateAt(weeks: readonly (readonly string[])[], cell: GridCell): string | null {
  const row = weeks[cell.row];
  if (!row) return null;
  return row[cell.col] ?? null;
}

/** Convenience: hit test and look up the date in one step. */
export function dateAtPoint(
  x: number,
  y: number,
  weeks: readonly (readonly string[])[],
  m: GridMetrics,
): string | null {
  const rows = m.rows ?? weeks.length ?? 6;
  const cols = m.cols ?? (weeks[0] ? weeks[0].length : 7);
  return dateAt(weeks, cellAt(x, y, { ...m, rows, cols }));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─── Spans ───────────────────────────────────────────────────────────────────

export interface DaySpan {
  startDate: string;
  endDate: string;
}

/**
 * The span between where the finger went down and where it is now.
 *
 * Normalised, because dragging backwards in time is not an error, it is how you
 * select the days BEFORE the one you happened to press. Anchor and current are
 * ends of the same range, so sweeping the 7th back to the 3rd creates exactly
 * the same event as sweeping the 3rd forward to the 7th. Pressing and releasing
 * on one cell is a legitimate one day span.
 */
export function spanBetween(anchorDate: string, currentDate: string): DaySpan {
  const a = isDate(anchorDate) ? anchorDate : currentDate;
  const b = isDate(currentDate) ? currentDate : anchorDate;
  return a <= b ? { startDate: a, endDate: b } : { startDate: b, endDate: a };
}

/** How many days a span covers, counting both ends. Always at least 1. */
export function spanLength(span: DaySpan): number {
  return Math.max(1, daysBetween(span.startDate, span.endDate));
}

export function spanContains(span: DaySpan, date: string): boolean {
  return date >= span.startDate && date <= span.endDate;
}

export function spansOverlap(a: DaySpan, b: DaySpan): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function shortDate(date: string, withYear: boolean): string {
  const month = MONTHS[+date.slice(5, 7) - 1] ?? date.slice(5, 7);
  const day = String(+date.slice(8, 10));
  return withYear ? `${month} ${day} ${date.slice(0, 4)}` : `${month} ${day}`;
}

/**
 * The forming range as a line of text, shown while the finger is still down.
 *
 * Reads "Aug 3 to Aug 7, 5 days". The user is committing to something they
 * cannot see the edges of once the band runs off a week row, so the count is
 * spelled out rather than left to be inferred from highlighted squares. The year
 * appears only when the span crosses one, where leaving it out would be
 * genuinely ambiguous.
 *
 * The word "to" is deliberate: no dashes in anything the user reads.
 */
export function describeSpan(span: DaySpan): string {
  const days = spanLength(span);
  const crossesYear = span.startDate.slice(0, 4) !== span.endDate.slice(0, 4);
  const unit = days === 1 ? '1 day' : `${days} days`;
  if (span.startDate === span.endDate) return `${shortDate(span.startDate, crossesYear)}, ${unit}`;
  return `${shortDate(span.startDate, crossesYear)} to ${shortDate(span.endDate, crossesYear)}, ${unit}`;
}

// ─── Bands ───────────────────────────────────────────────────────────────────

export interface WeekBand {
  /** First column of this week the span touches. */
  startCol: number;
  /** Last column of this week the span touches, inclusive. */
  endCol: number;
  /** The span really begins here, so this end is rounded. */
  startsHere: boolean;
  /** The span really ends here, so this end is rounded. */
  endsHere: boolean;
}

/**
 * The one segment a span draws on a single week row, or null if it misses it.
 *
 * A week row is seven consecutive days, so a span can only ever intersect it in
 * ONE unbroken run. That is why this returns a single band and not a list.
 *
 * `startsHere` and `endsHere` are the whole point. A span from Thursday to the
 * following Tuesday is two bands, and it only reads as one object if the first
 * band is rounded on the left and CUT SQUARE on the right, and the second is cut
 * square on the left and rounded on the right. Round every end and you get two
 * unrelated pills; square every end and it looks like a rendering glitch.
 */
export function bandForWeek(week: readonly string[], span: DaySpan): WeekBand | null {
  if (week.length === 0) return null;
  const first = week[0];
  const last = week[week.length - 1];
  if (span.endDate < first || span.startDate > last) return null;

  let startCol = 0;
  let endCol = week.length - 1;
  for (let i = 0; i < week.length; i += 1) {
    if (week[i] >= span.startDate) { startCol = i; break; }
  }
  for (let i = week.length - 1; i >= 0; i -= 1) {
    if (week[i] <= span.endDate) { endCol = i; break; }
  }
  if (startCol > endCol) return null;

  return {
    startCol,
    endCol,
    startsHere: span.startDate >= first,
    endsHere: span.endDate <= last,
  };
}

export interface WeekBandAt extends WeekBand {
  weekIndex: number;
}

/** Every segment a span draws across a whole month grid, week row by week row. */
export function bandsForSpan(
  weeks: readonly (readonly string[])[],
  span: DaySpan,
): WeekBandAt[] {
  const out: WeekBandAt[] = [];
  for (let w = 0; w < weeks.length; w += 1) {
    const band = bandForWeek(weeks[w], span);
    if (band) out.push({ ...band, weekIndex: w });
  }
  return out;
}

// ─── Lanes ───────────────────────────────────────────────────────────────────

export interface SpanItem extends DaySpan {
  id: string;
}

export interface PlacedSpan<T extends SpanItem> extends WeekBandAt {
  item: T;
  /** Which row inside the cell this band is drawn on, from zero. */
  lane: number;
}

export interface SpanLayout<T extends SpanItem> {
  placements: PlacedSpan<T>[];
  /** Lane per item id, the same in every week the item appears in. */
  lanes: Record<string, number>;
  /** Highest lane used anywhere, plus one. */
  laneCount: number;
  /** Highest lane used in each week row, plus one. Sized per row. */
  lanesPerWeek: number[];
}

/**
 * Give every span a lane, and cut it into per week bands.
 *
 * THE LANE IS GLOBAL, NOT PER WEEK. Compacting lanes week by week would use
 * fewer rows, but an event running from Saturday to Monday would then be drawn
 * on lane 2 in one row and lane 0 in the next, and a band that changes height
 * halfway does not read as one event. One lane for the whole grid costs a little
 * vertical space and buys a band that stays put.
 *
 * The assignment is the same greedy sweep the day grid uses for columns: walk in
 * date order and drop each item into the first lane whose last item has already
 * finished. Order is decided entirely by (start, end, id), so shuffling the
 * input cannot change the result. That matters more than tightness, because a
 * band that jumps rows whenever an unrelated event is saved reads as the app
 * losing track of things.
 */
export function layoutSpans<T extends SpanItem>(
  items: readonly T[],
  weeks: readonly (readonly string[])[],
): SpanLayout<T> {
  const empty: SpanLayout<T> = { placements: [], lanes: {}, laneCount: 0, lanesPerWeek: weeks.map(() => 0) };
  if (!items || items.length === 0 || weeks.length === 0) return empty;

  const sorted = items
    .filter(it => it && isDate(it.startDate) && isDate(it.endDate) && it.startDate <= it.endDate)
    .slice()
    .sort((a, b) => (
      a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1
        // Longer first, so the long backdrop event sits above the short ones
        // rather than being pushed down by whichever short item started with it.
        : a.endDate > b.endDate ? -1 : a.endDate < b.endDate ? 1
          : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    ));

  const laneEnds: string[] = [];
  const lanes: Record<string, number> = {};
  const placements: PlacedSpan<T>[] = [];
  const lanesPerWeek = weeks.map(() => 0);

  for (const item of sorted) {
    // A lane is free once its last item ENDED BEFORE this one starts. Equal
    // dates are an overlap: both cover that day, so they need separate lanes.
    let lane = laneEnds.findIndex(end => end < item.startDate);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endDate);
    } else if (item.endDate > laneEnds[lane]) {
      laneEnds[lane] = item.endDate;
    }
    lanes[item.id] = lane;

    for (const band of bandsForSpan(weeks, item)) {
      placements.push({ ...band, item, lane });
      lanesPerWeek[band.weekIndex] = Math.max(lanesPerWeek[band.weekIndex], lane + 1);
    }
  }

  return { placements, lanes, laneCount: laneEnds.length, lanesPerWeek };
}

// ─── Reading spans out of the planner ────────────────────────────────────────

export interface MonthSpan extends SpanItem {
  /** The stored event this came from; the id may carry an occurrence date. */
  masterId: string;
  title: string;
  colour?: string;
  allDay: boolean;
}

export interface MonthSpanResult {
  spans: MonthSpan[];
  /** How many of the spans cover each date, so a cell can subtract them from
   *  its total and only mark what is NOT already drawn as a band. */
  covered: Record<string, number>;
}

/**
 * Every all day or multi day item touching a range, in ONE pass over the store.
 *
 * WHY ONE PASS IS NOT NEGOTIABLE. The month view used to build a full agenda per
 * cell: forty-two walks of the whole planner, each expanding every recurrence,
 * for a grid of squares. `countsForRange` fixed that and the view got about
 * forty-six times faster. This asks the same question about a different subset
 * and follows the same rule: walk the events once, expand each repeat into the
 * range once, and never loop per cell.
 */
export function spansForRange(
  events: Record<string, Record<string, unknown>> | undefined,
  from: string,
  to: string,
  weekStartsOn: WeekStartsOn = 0,
  categories?: EventCategory[],
): MonthSpanResult {
  const spans: MonthSpan[] = [];
  const covered: Record<string, number> = {};
  if (!events || !isDate(from) || !isDate(to) || from > to) return { spans, covered };

  const rangeStart = parseDate(from);
  const rangeEnd = parseDate(shiftDate(to, 1)); // exclusive, as occurrenceStarts wants

  const add = (id: string, masterId: string, raw: Record<string, unknown>, startDate: string, span: number) => {
    const endDate = shiftDate(startDate, Math.max(1, span) - 1);
    // Clip to the grid: a band that starts in the previous month still shows,
    // it simply arrives already open on its left edge.
    const clippedStart = startDate < from ? from : startDate;
    const clippedEnd = endDate > to ? to : endDate;
    if (clippedEnd < from || clippedStart > to) return;

    spans.push({
      id,
      masterId,
      title: titleOf(raw),
      colour: colourOf(raw, categories),
      allDay: raw.allDay === true,
      // The UNclipped dates are kept, so the ends know whether they are a real
      // start or the grid running out.
      startDate,
      endDate,
    });
    for (let d = clippedStart; d <= clippedEnd; d = shiftDate(d, 1)) {
      covered[d] = (covered[d] ?? 0) + 1;
    }
  };

  for (const id of Object.keys(events)) {
    const raw = events[id];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.deleted === true) continue;

    const rec = raw as unknown as RecurFields;
    const daysSpan = Math.max(1, rec.daysSpan ?? 1);
    // A band is for things that OCCUPY days rather than a moment: anything
    // all day, and anything running over more than one day even if it is timed.
    if (raw.allDay !== true && daysSpan <= 1) continue;

    if (!rec.recur) {
      if (!isDate(rec.weekKey)) continue;
      add(id, id, raw, shiftDate(rec.weekKey, rec.dayIndex ?? 0), daysSpan);
      continue;
    }

    for (const at of occurrenceStarts(rec, rangeStart, rangeEnd, weekStartsOn)) {
      const startDate = ymd(at);
      add(`${id}::${startDate}`, id, raw, startDate, daysSpan);
    }
  }

  return { spans, covered };
}
