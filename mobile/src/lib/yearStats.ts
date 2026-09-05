import { focusDayKey, isCountable, type FocusSessionRecord, applyTypedDayTotals, dedupeFocusHistory } from './focusStats';

export interface FocusMonthSummary {
  month: Date;
  seconds: number;
  sessions: number;
  activeDays: number;
}

export interface FocusYearSummary {
  months: FocusMonthSummary[];
  yearSeconds: number;
  yearSessions: number;
  yearActiveDays: number;
  yearMaxSeconds: number;
  yearBestMonth: FocusMonthSummary | null;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function eachDayOfInterval(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Aggregates focus sessions over a full calendar year.
 *
 * A thin wrapper now: a calendar year is twelve months ending in December, and
 * the rolling year on the analysis screen is twelve months ending in whichever
 * month you are standing in. Sharing one implementation is what stops the two
 * readings drifting apart in how they count an excused day or a late session.
 */
export function summariseFocusYear(
  sessions: readonly FocusSessionRecord[],
  opts: { year: number; dayStartHour?: number; excludedDates?: string[] },
): FocusYearSummary {
  return summariseFocusMonths(sessions, {
    end: new Date(opts.year, 11, 1),
    count: 12,
    dayStartHour: opts.dayStartHour,
    excludedDates: opts.excludedDates,
  });
}

/**
 * The same twelve bars, but over any run of months ending where you say.
 *
 * `end` names the LAST month in the window and `count` how many there are, so
 * the rolling year is `{ end: this month, count: 12 }`. The months come back
 * oldest first, which is the order they are drawn in, and a window that spans a
 * new year is perfectly ordinary rather than a special case.
 */
export function summariseFocusMonths(
  sessions: readonly FocusSessionRecord[],
  opts: { end: Date; count?: number; dayStartHour?: number; excludedDates?: string[] },
): FocusYearSummary {
  const dayStartHour = opts.dayStartHour ?? 0;
  // A window of no months would divide by zero on the chart and read as "you
  // have never focused", which is a lie rather than an empty state.
  const rawCount = Math.trunc(opts.count ?? 12);
  const count = Number.isFinite(rawCount) ? Math.min(120, Math.max(1, rawCount)) : 12;
  const end = Number.isNaN(opts.end?.getTime?.() ?? NaN) ? new Date() : opts.end;
  const excluded = new Set(opts.excludedDates ?? []);
  
  const byDaySeconds = new Map<string, number>();
  const byDaySessions = new Map<string, number>();
  
  // The same two rules the week totals apply. A chart that disagrees with the
  // number beside it is worse than either being wrong on its own.
  for (const s of applyTypedDayTotals(dedupeFocusHistory(sessions ?? []), dayStartHour)) {
    if (!isCountable(s)) continue;
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (!key) continue;
    
    byDaySeconds.set(key, (byDaySeconds.get(key) ?? 0) + s.durationSeconds);
    byDaySessions.set(key, (byDaySessions.get(key) ?? 0) + 1);
  }

  const months = Array.from(
    { length: count },
    (_, i) => new Date(end.getFullYear(), end.getMonth() - (count - 1 - i), 1),
  );
  const monthTotals = months.map(m => {
    const dayList = eachDayOfInterval(startOfMonth(m), endOfMonth(m));
    const validDays = dayList.filter(d => !excluded.has(dateKey(d)));
    
    const seconds = validDays.reduce((sum, d) => sum + (byDaySeconds.get(dateKey(d)) ?? 0), 0);
    const sessionCount = validDays.reduce((sum, d) => sum + (byDaySessions.get(dateKey(d)) ?? 0), 0);
    const activeDays = validDays.filter(d => (byDaySeconds.get(dateKey(d)) ?? 0) > 0).length;
    
    return { month: m, seconds, sessions: sessionCount, activeDays };
  });

  const yearSeconds = monthTotals.reduce((sum, m) => sum + m.seconds, 0);
  const yearSessions = monthTotals.reduce((sum, m) => sum + m.sessions, 0);
  const yearActiveDays = monthTotals.reduce((sum, m) => sum + m.activeDays, 0);
  const yearMaxSeconds = Math.max(1, ...monthTotals.map(m => m.seconds));
  
  let yearBestMonth: FocusMonthSummary | null = null;
  for (const m of monthTotals) {
    if (!yearBestMonth || m.seconds > yearBestMonth.seconds) {
      yearBestMonth = m;
    }
  }
  if (yearBestMonth && yearBestMonth.seconds === 0) {
    yearBestMonth = null;
  }

  return {
    months: monthTotals,
    yearSeconds,
    yearSessions,
    yearActiveDays,
    yearMaxSeconds,
    yearBestMonth,
  };
}
