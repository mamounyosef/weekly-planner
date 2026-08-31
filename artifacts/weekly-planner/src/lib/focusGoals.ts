import { type FocusSessionRecord, focusDayKey, dateRange, dateKey } from './focusStats';

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
  }
): FocusGoalStats {
  const { now, goalSeconds, dayStartHour = 0 } = opts;
  const live = typeof opts.liveSeconds === 'number' && Number.isFinite(opts.liveSeconds)
    ? Math.max(0, opts.liveSeconds)
    : 0;
  const totals = new Map<string, number>();

  for (const s of sessions) {
    if (!s || typeof s.durationSeconds !== 'number' || Number.isNaN(s.durationSeconds) || s.durationSeconds < 0) continue;
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    totals.set(key, (totals.get(key) ?? 0) + s.durationSeconds);
  }

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
    } else {
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
 * Adjusts a single day's total focus time.
 * Returns only the changes to make.
 */
export function adjustDayTotal(
  sessions: readonly FocusSessionRecord[],
  opts: { dateKeyVal: string; newTotalSeconds: number; dayStartHour?: number }
): FocusDayDelta {
  const { dateKeyVal, newTotalSeconds, dayStartHour = 0 } = opts;
  const want = Math.max(0, Math.floor(newTotalSeconds) || 0);

  const daySessions: FocusSessionRecord[] = [];
  let currentTotal = 0;

  for (const s of sessions) {
    if (!s || typeof s.durationSeconds !== 'number' || Number.isNaN(s.durationSeconds) || s.durationSeconds < 0) continue;
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (key === dateKeyVal) {
      daySessions.push(s);
      currentTotal += s.durationSeconds;
    }
  }

  if (want === currentTotal) return { mutated: [], deletedIds: [] };

  if (want === 0) {
    return { mutated: [], deletedIds: daySessions.map(s => s.id) };
  }

  daySessions.sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });

  const mutated: FocusSessionRecord[] = [];
  const deletedIds: string[] = [];

  if (want > currentTotal) {
    const diff = want - currentTotal;
    const last = daySessions.length > 0 ? daySessions[daySessions.length - 1] : null;
    const anchor = last ? (last.endedAt ?? last.startedAt) : `${dateKeyVal}T12:00:00.000Z`;
    mutated.push({
      id: `adj-${dateKeyVal}-${want}-${diff}`,
      startedAt: anchor,
      endedAt: anchor,
      durationSeconds: diff,
      plannedSeconds: diff
    });
  } else {
    let accumulated = 0;
    for (const s of daySessions) {
      if (accumulated >= want) {
        deletedIds.push(s.id);
        continue;
      }
      const space = want - accumulated;
      if (s.durationSeconds <= space) {
        accumulated += s.durationSeconds;
      } else {
        mutated.push({
          ...s,
          durationSeconds: space,
          plannedSeconds: Math.min(s.plannedSeconds ?? space, space),
          id: s.id
        });
        accumulated += space;
      }
    }
  }

  return { mutated, deletedIds };
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
