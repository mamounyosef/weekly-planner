import {
  type FocusSessionRecord, focusDayKey, dateRange, dateKey,
  createDayAdjustment, isDayAdjustment, tallyFocusDays,
} from './focusStats';

export interface FocusGoalStats {
  currentStreak: number;
  bestStreak: number;
  todayProgress: number; // 0.0 to 1.0
  todayTotal: number;
}

/**
 * Calculates current and best streaks against a daily goal.
 * A day meets the goal if its total focus seconds are >= goalSeconds.
 * If goalSeconds is 0, any day with > 0 seconds meets the goal.
 */
export function computeGoalStats(
  sessions: readonly FocusSessionRecord[],
  opts: {
    now: string;
    goalSeconds: number;
    dayStartHour?: number;
    /**
     * Time already run by a session that has not been logged yet.
     *
     * WITHOUT THIS THE BAR IS FROZEN WHILE YOU WORK. A running session is not in
     * the store until it stops, so a goal computed from logged sessions alone
     * sits still for an hour and then jumps, and the streak says "nothing today
     * yet" while the timer beside it is counting.
     *
     * It must be the UNCREDITED elapsed time, never the raw elapsed: editing a
     * day's figure while a session runs banks what has run so far into the day
     * directly, and counting it here as well would show the same minutes twice.
     */
    liveSeconds?: number;
    excludedDates?: string[];
  }
): FocusGoalStats {
  const { now, goalSeconds, dayStartHour = 0, excludedDates = [] } = opts;
  const live = typeof opts.liveSeconds === 'number' && Number.isFinite(opts.liveSeconds)
    ? Math.max(0, opts.liveSeconds)
    : 0;
  const totals = new Map<string, number>();
  const excludedSet = new Set(excludedDates);

  // Through the shared tally, so a typed day total REPLACES the day's sum
  // instead of being added on top of the sessions it corrected.
  const clean = (sessions ?? []).filter(s =>
    s && typeof s.durationSeconds === 'number' && !Number.isNaN(s.durationSeconds) && s.durationSeconds >= 0);
  for (const [key, t] of tallyFocusDays(clean, dayStartHour)) totals.set(key, t.seconds);

  const today = focusDayKey(now, dayStartHour);
  let earliest = today;
  for (const k of totals.keys()) {
    if (k < earliest) earliest = k;
  }

  const days = dateRange(earliest, today);
  let currentStreak = 0;
  let bestStreak = 0;
  let currentRun = 0;
  let yesterdayRun = 0;

  const validGoal = typeof goalSeconds === 'number' && !Number.isNaN(goalSeconds) && goalSeconds >= 0 ? goalSeconds : 0;
  const meetsGoal = (secs: number) => validGoal > 0 ? secs >= validGoal : secs > 0;

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const secs = (totals.get(day) ?? 0) + (day === today ? live : 0);
    
    if (meetsGoal(secs)) {
      currentRun++;
      if (currentRun > bestStreak) bestStreak = currentRun;
    } else if (!excludedSet.has(day)) {
      // A DAY YOU EXCUSED YOURSELF FROM DOES NOT BREAK A STREAK. That is the
      // entire purpose of excusing it: a Friday off, a day ill, a holiday.
      // Nor does it extend one -- nothing happened, so the run is carried
      // across the gap rather than incremented over it.
      //
      // Today is not a special case. If today is excused and the goal has not
      // been met, yesterday's run is still intact, which is exactly what
      // carrying it across says. The outer test used to read
      // `!excluded || day === today`, whose second half could never reach the
      // assignment underneath it.
      currentRun = 0;
    }
    
    if (i === days.length - 2) {
      yesterdayRun = currentRun;
    }
  }

  const todayTotal = (totals.get(today) ?? 0) + live;
  const todayProgress = validGoal > 0 ? Math.min(1, Math.max(0, todayTotal / validGoal)) : (todayTotal > 0 ? 1 : 0);
  const streak = meetsGoal(todayTotal) ? currentRun : yesterdayRun;

  return {
    currentStreak: streak,
    bestStreak,
    todayProgress,
    todayTotal,
  };
}

export interface FocusDayDelta {
  mutated: FocusSessionRecord[];
  deletedIds: string[];
}

/**
 * Set a single day's TOTAL focus time, and nothing else.
 *
 * Every session stays exactly as it was, with its own length, and the day
 * keeps its session count. The typed value is written as one `adjust-` day
 * override, which is what the totals honour (see `tallyFocusDays`). This used
 * to trim and delete sessions to make the numbers add up (and add a fake
 * `adj-` session to make them bigger), so correcting a day destroyed the
 * record of what was actually done on it. Same model as the PC.
 *
 * Returns only the changes to make: the new override, and the day's previous
 * override (if any) to delete.
 */
export function adjustDayTotal(
  sessions: readonly FocusSessionRecord[],
  opts: { dateKeyVal: string; newTotalSeconds: number; dayStartHour?: number; now?: number }
): FocusDayDelta {
  const { dateKeyVal, newTotalSeconds, dayStartHour = 0, now = Date.now() } = opts;
  const want = Math.max(0, Math.floor(newTotalSeconds) || 0);

  const current = tallyFocusDays(sessions ?? [], dayStartHour).get(dateKeyVal)?.seconds ?? 0;
  if (want === current) return { mutated: [], deletedIds: [] };

  const previous = (sessions ?? [])
    .filter(s => isDayAdjustment(s) && s.id.startsWith(`adjust-${dateKeyVal}-`))
    .map(s => s.id);
  return {
    mutated: [createDayAdjustment(dateKeyVal, want, dayStartHour, now)],
    deletedIds: previous,
  };
}

/**
 * Updates or removes a single focus session.
 */
export function editSingleSession(
  session: FocusSessionRecord,
  newDurationSeconds: number
): FocusDayDelta {
  const want = Math.max(0, Math.floor(newDurationSeconds) || 0);
  if (want === 0) {
    return { mutated: [], deletedIds: [session.id] };
  }
  if (want === session.durationSeconds) {
    return { mutated: [], deletedIds: [] };
  }
  return { mutated: [{ ...session, durationSeconds: want }], deletedIds: [] };
}
