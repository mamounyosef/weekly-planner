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
  opts: { now: string; goalSeconds: number; dayStartHour?: number }
): FocusGoalStats {
  const { now, goalSeconds, dayStartHour = 0 } = opts;
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
    const secs = totals.get(day) ?? 0;
    
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

  const todayTotal = totals.get(today) ?? 0;
  const todayProgress = validGoal > 0 ? Math.min(1, Math.max(0, todayTotal / validGoal)) : (todayTotal > 0 ? 1 : 0);
  const streak = meetsGoal(todayTotal) ? currentRun : yesterdayRun;

  return {
    currentStreak: streak,
    bestStreak,
    todayProgress,
    todayTotal,
  };
}

/**
 * Adjusts a single day's total focus time.
 * If increasing, it appends a synthetic session to make up the difference.
 * If decreasing, it shrinks or drops sessions from that day (chronologically).
 */
export function adjustDayTotal(
  sessions: readonly FocusSessionRecord[],
  opts: { dateKeyVal: string; newTotalSeconds: number; dayStartHour?: number }
): FocusSessionRecord[] {
  const { dateKeyVal, newTotalSeconds, dayStartHour = 0 } = opts;
  const want = Math.max(0, Math.floor(newTotalSeconds) || 0);

  const out: FocusSessionRecord[] = [];
  const daySessions: FocusSessionRecord[] = [];
  let currentTotal = 0;

  for (const s of sessions) {
    if (!s || typeof s.durationSeconds !== 'number' || Number.isNaN(s.durationSeconds) || s.durationSeconds < 0) continue;
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (key === dateKeyVal) {
      daySessions.push(s);
      currentTotal += s.durationSeconds;
    } else {
      out.push(s);
    }
  }

  if (want === 0) return out;

  // Sort chronological so shrinking affects the most recent first, etc.
  daySessions.sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });

  if (want > currentTotal) {
    out.push(...daySessions);
    const diff = want - currentTotal;
    const last = daySessions.length > 0 ? daySessions[daySessions.length - 1] : null;
    const anchor = last ? (last.endedAt ?? last.startedAt) : `${dateKeyVal}T12:00:00.000Z`;
    out.push({
      id: `adj-${dateKeyVal}-${want}-${diff}`,
      startedAt: anchor,
      endedAt: anchor,
      durationSeconds: diff,
      plannedSeconds: diff
    });
  } else {
    // Shrink sessions
    let accumulated = 0;
    for (const s of daySessions) {
      if (accumulated >= want) break;
      const space = want - accumulated;
      if (s.durationSeconds <= space) {
        out.push(s);
        accumulated += s.durationSeconds;
      } else {
        out.push({
          ...s,
          durationSeconds: space,
          plannedSeconds: Math.min(s.plannedSeconds ?? space, space),
          id: `${s.id}-shrunk`
        });
        accumulated += space;
      }
    }
  }

  return out;
}

/**
 * Updates or removes a single focus session.
 * If newDurationSeconds is 0, it removes it.
 */
export function editSingleSession(
  sessions: readonly FocusSessionRecord[],
  id: string,
  newDurationSeconds: number
): FocusSessionRecord[] {
  const want = Math.max(0, Math.floor(newDurationSeconds) || 0);
  if (want === 0) {
    return sessions.filter(s => s.id !== id);
  }
  return sessions.map(s => {
    if (s.id === id) {
      return { ...s, durationSeconds: want };
    }
    return s;
  });
}
