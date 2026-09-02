/**
 * What "week", "month" and "year" actually mean on the focus analysis screen.
 *
 * THE AMBIGUITY THIS SETTLES
 * "This week" has two honest readings and they disagree by up to six days:
 *
 *   CALENDAR  the week you are standing in, from its first day to its last, so
 *             on a Wednesday it is Sunday to Wednesday plus three days that
 *             have not happened yet.
 *   ROLLING   the last seven days, literally: last Thursday through today.
 *
 * Neither is more correct. They answer different questions ("how is this week
 * going" versus "how much have I done lately"), and until now the two halves of
 * this planner quietly picked different ones: the PC drew calendar weeks and
 * months, the phone drew rolling 7 and 30 day windows, and the phone's year was
 * a calendar year while its week was not. The same session history therefore
 * produced two different totals on two screens, with nothing on either saying
 * why. So the choice is made explicit and the wording follows it.
 *
 * WHY THE RANGE RUNS TO THE END OF THE PERIOD, NOT TO TODAY
 * In calendar mode the range deliberately covers the whole period, future days
 * included. Days that have not happened hold no sessions, so every total,
 * average and best day is identical either way; what it buys is a chart with
 * the rest of the week still drawn on it, which is the thing that makes "how is
 * this week going" readable at a glance. `throughToday` is there for anything
 * that needs the honest "so far" end instead, such as wording.
 *
 * Everything here is pure and takes `today` as an argument, so the PC, the
 * phone and the tests all agree about where a period begins.
 */

export type FocusPeriod = 'week' | 'month' | 'year';

/** `calendar` = the period you are in. `rolling` = the last N days, literally. */
export type FocusRangeMode = 'calendar' | 'rolling';

/** How many days each rolling window covers. */
export const ROLLING_DAYS: Record<FocusPeriod, number> = {
  week: 7,
  month: 30,
  year: 365,
};

export interface FocusPeriodRange {
  period: FocusPeriod;
  mode: FocusRangeMode;
  /** First day counted, as a YYYY-MM-DD key. */
  from: string;
  /** Last day counted. In calendar mode this can be in the future. */
  to: string;
  /** `to`, but never past today. What "so far" means. */
  throughToday: string;
  /** Whether this range is the one containing today. */
  isCurrent: boolean;
}

const MS_PER_DAY = 86_400_000;

export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midnight local, so nothing downstream depends on the time of day. */
function atMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return out;
}

/**
 * The first day of the week containing `d`.
 *
 * `weekStartsOn` is a shared setting for a reason: repeats are expanded against
 * it, so the two machines must already agree on it. Reusing it here means the
 * focus week and the calendar week can never disagree about where Sunday is.
 */
export function startOfWeekOn(d: Date, weekStartsOn = 0): Date {
  const start = ((weekStartsOn % 7) + 7) % 7;
  const shift = (d.getDay() - start + 7) % 7;
  return addDays(atMidnight(d), -shift);
}

export function startOfMonthOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonthOf(d: Date): Date {
  // Day 0 of the next month is the last day of this one, which is also how
  // February in a leap year gets its 29th without a table.
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * The range a given tab is showing.
 *
 * `offset` steps whole periods backwards or forwards from the one containing
 * `today`: -1 is the previous week, month or year in calendar mode, and the
 * window immediately before the current one in rolling mode. Zero is the one
 * you are in, which is all the phone ever asks for.
 */
export function focusPeriodRange(opts: {
  period: FocusPeriod;
  mode: FocusRangeMode;
  today: Date;
  weekStartsOn?: number;
  offset?: number;
}): FocusPeriodRange {
  const period = opts.period;
  const mode = opts.mode === 'rolling' ? 'rolling' : 'calendar';
  const offset = Number.isFinite(opts.offset) ? Math.trunc(opts.offset as number) : 0;
  const today = Number.isNaN(opts.today?.getTime?.() ?? NaN)
    ? atMidnight(new Date())
    : atMidnight(opts.today);

  let from: Date;
  let to: Date;

  if (mode === 'rolling') {
    const span = ROLLING_DAYS[period];
    // A step moves the window by its own length, so consecutive steps tile the
    // history rather than overlapping it.
    to = addDays(today, offset * span);
    from = addDays(to, -(span - 1));
  } else if (period === 'week') {
    from = addDays(startOfWeekOn(today, opts.weekStartsOn ?? 0), offset * 7);
    to = addDays(from, 6);
  } else if (period === 'month') {
    const anchor = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    from = startOfMonthOf(anchor);
    to = endOfMonthOf(anchor);
  } else {
    const year = today.getFullYear() + offset;
    from = new Date(year, 0, 1);
    to = new Date(year, 11, 31);
  }

  const throughToday = to.getTime() > today.getTime() ? today : to;

  return {
    period,
    mode,
    from: dayKey(from),
    to: dayKey(to),
    throughToday: dayKey(throughToday),
    isCurrent: from.getTime() <= today.getTime() && today.getTime() <= to.getTime(),
  };
}

/**
 * What to call the range above a total.
 *
 * The wording carries the mode, because a number labelled only "week" is
 * exactly the ambiguity this module exists to remove. `upper` is for the phone,
 * where the label sits in a small-caps strip.
 */
export function describeFocusRange(range: FocusPeriodRange, upper = false): string {
  const label = phrase(range);
  return upper ? label.toUpperCase() : label;
}

function phrase(range: FocusPeriodRange): string {
  const span = ROLLING_DAYS[range.period];
  if (range.mode === 'rolling') {
    return range.isCurrent ? `Last ${span} days` : `${span} days`;
  }
  if (!range.isCurrent) {
    return range.period === 'week' ? 'That week'
      : range.period === 'month' ? 'That month' : 'That year';
  }
  return range.period === 'week' ? 'This week'
    : range.period === 'month' ? 'This month' : 'This year';
}

/**
 * The one-line explanation shown beside the switch.
 *
 * Written as the two answers rather than as two names, because "calendar" and
 * "rolling" mean nothing until you have already understood the difference.
 */
export function explainFocusMode(mode: FocusRangeMode, period: FocusPeriod): string {
  const span = ROLLING_DAYS[period];
  if (mode === 'rolling') return `The last ${span} days, counting back from today.`;
  return period === 'week'
    ? 'The week you are in, from its first day.'
    : period === 'month'
      ? 'The month you are in, from the 1st.'
      : 'The year you are in, from January.';
}

/** Every day in the range, oldest first. Capped, so a bad range cannot spin. */
export function daysInRange(range: { from: string; to: string }): string[] {
  const out: string[] = [];
  const start = new Date(`${range.from}T00:00:00`);
  const end = new Date(`${range.to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  const cursor = new Date(start);
  for (let i = 0; cursor.getTime() <= end.getTime() && i < 3660; i += 1) {
    out.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** How many whole days a range covers, inclusive of both ends. */
export function rangeLength(range: { from: string; to: string }): number {
  const start = new Date(`${range.from}T00:00:00`);
  const end = new Date(`${range.to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  // Rounded, not floored: a daylight saving change makes one of these days 23
  // or 25 hours long, and a floor would quietly lose it.
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
}

export function isFocusRangeMode(raw: unknown): raw is FocusRangeMode {
  return raw === 'calendar' || raw === 'rolling';
}

/** Anything unrecognised means the calendar reading, which is the older one. */
export function coerceFocusRangeMode(raw: unknown): FocusRangeMode {
  return isFocusRangeMode(raw) ? raw : 'calendar';
}
