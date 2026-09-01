import { focusDayKey, isCountable, type FocusSessionRecord } from './focusStats';

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
 */
export function summariseFocusYear(
  sessions: readonly FocusSessionRecord[],
  opts: { year: number; dayStartHour?: number; excludedDates?: string[] },
): FocusYearSummary {
  const dayStartHour = opts.dayStartHour ?? 0;
  const excluded = new Set(opts.excludedDates ?? []);
  
  const byDaySeconds = new Map<string, number>();
  const byDaySessions = new Map<string, number>();
  
  for (const s of sessions) {
    if (!isCountable(s)) continue;
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (!key) continue;
    
    byDaySeconds.set(key, (byDaySeconds.get(key) ?? 0) + s.durationSeconds);
    byDaySessions.set(key, (byDaySessions.get(key) ?? 0) + 1);
  }

  const months = Array.from({ length: 12 }, (_, m) => new Date(opts.year, m, 1));
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
