// ─── Focus, as numbers ───────────────────────────────────────────────────────
// The arithmetic behind the focus screen, kept apart from `focusSessions.ts`.
//
// WHY A SEPARATE MODULE. `focusSessions.ts` is where the chimes live: a thousand
// lines of Web Audio, `localStorage` coordination between the two desktop
// windows, and `crypto.randomUUID`. None of that exists on a phone, and none of
// it is needed to add up how long someone worked. Copying that file across to
// get three sums would drag a browser's worth of assumptions into a React Native
// bundle.
//
// So the maths lives here, pure and shared, and both machines total the same
// history the same way. A phone that disagreed with the PC about yesterday would
// be worse than a phone that showed nothing.

/** Exactly the shape the sessions file stores. */
export interface FocusSessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  plannedSeconds?: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date of a moment, as 'yyyy-MM-dd'. */
export function dateKey(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which focus-day a moment belongs to.
 *
 * A day does not begin at midnight for someone who works late: with a start hour
 * of 3, anything before 03:00 counts toward the previous day, so a session that
 * ran to half past one still lands on the day it felt like. Character-for-
 * character the same rule as the PC's, including using the local calendar rather
 * than a fixed millisecond offset, which is what keeps it right across a
 * daylight-saving change.
 */
export function focusDayKey(value: Date | string, dayStartHour = 0): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const shifted = new Date(d);
  if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
  return dateKey(shifted);
}

/** Below this a session is a mis-tap, not work. Matches the PC's threshold. */
export const MIN_COMPLETED_SESSION_SECONDS = 60;

export function isCountable(s: FocusSessionRecord): boolean {
  return Boolean(s)
    && typeof s.durationSeconds === 'number'
    && Number.isFinite(s.durationSeconds)
    && s.durationSeconds >= MIN_COMPLETED_SESSION_SECONDS;
}

export interface FocusDay {
  date: string;
  seconds: number;
  sessions: number;
}

export interface FocusSummary {
  /** Oldest first, one entry per day in the range, including empty days. */
  days: FocusDay[];
  totalSeconds: number;
  sessions: number;
  /** Mean over days that had ANY focus, not over the whole range — an average
   *  diluted by days off says nothing about how a working day actually goes. */
  averageSeconds: number;
  bestDay: FocusDay | null;
  /** Consecutive days with focus, counting back from the end of the range. */
  streak: number;
}

/** Every date from `from` to `to` inclusive, as keys. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  const cursor = new Date(start);
  // Guarded rather than trusted: a reversed or absurd range would otherwise spin
  // forever building an array nobody asked for.
  for (let i = 0; cursor <= end && i < 3660; i += 1) {
    out.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Total a history over a range of days.
 *
 * Days with nothing are included deliberately: a chart with the gaps missing
 * reads as continuous work, which is a flattering lie.
 */
export function summariseFocus(
  sessions: readonly FocusSessionRecord[],
  opts: { from: string; to: string; dayStartHour?: number },
): FocusSummary {
  const dayStartHour = opts.dayStartHour ?? 0;
  const totals = new Map<string, { seconds: number; sessions: number }>();

  for (const s of sessions ?? []) {
    if (!isCountable(s)) continue;
    // Bucketed by when it ENDED. A session that starts before the cutoff and
    // ends after it belongs to the day it was finished in, which is how the PC
    // credits it and how a person remembers it.
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (!key || key < opts.from || key > opts.to) continue;
    const entry = totals.get(key) ?? { seconds: 0, sessions: 0 };
    entry.seconds += s.durationSeconds;
    entry.sessions += 1;
    totals.set(key, entry);
  }

  const days: FocusDay[] = dateRange(opts.from, opts.to).map(date => {
    const entry = totals.get(date);
    return { date, seconds: entry?.seconds ?? 0, sessions: entry?.sessions ?? 0 };
  });

  const worked = days.filter(d => d.seconds > 0);
  const totalSeconds = worked.reduce((sum, d) => sum + d.seconds, 0);
  const sessionCount = worked.reduce((sum, d) => sum + d.sessions, 0);

  let bestDay: FocusDay | null = null;
  for (const d of days) if (!bestDay || d.seconds > bestDay.seconds) bestDay = d;
  if (bestDay && bestDay.seconds === 0) bestDay = null;

  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].seconds <= 0) break;
    streak += 1;
  }

  return {
    days,
    totalSeconds,
    sessions: sessionCount,
    averageSeconds: worked.length > 0 ? Math.round(totalSeconds / worked.length) : 0,
    bestDay,
    streak,
  };
}

/** "2h 15m", "45m", "None". Short enough to sit under a bar on a phone. */
export function describeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'None';
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
