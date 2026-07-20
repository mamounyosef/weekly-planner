export interface FocusSession {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  plannedSeconds: number;
}

export interface FocusTimerState {
  plannedSeconds: number;
  accumulatedSeconds: number;
  isRunning: boolean;
  lastStartedAt: string | null;
  sessionStartedAt: string | null;
}

export const FOCUS_SESSIONS_KEY = 'planner-focus-sessions';
export const FOCUS_TIMER_KEY = 'planner-focus-timer';
export const MIN_COMPLETED_SESSION_SECONDS = 20 * 60;

export function isCompletedFocusSession(session: FocusSession): boolean {
  return session.durationSeconds >= MIN_COMPLETED_SESSION_SECONDS;
}

export const DEFAULT_FOCUS_TIMER: FocusTimerState = {
  plannedSeconds: 60 * 60,
  accumulatedSeconds: 0,
  isRunning: false,
  lastStartedAt: null,
  sessionStartedAt: null,
};

export function dateKey(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Which "focus day" a moment belongs to, given a configurable day-start hour.
// e.g. with dayStartHour = 3, anything before 3:00 AM counts toward the previous
// calendar day. dayStartHour = 0 reproduces plain calendar-day bucketing.
// The returned key is the calendar date of the day the moment belongs to.
export function focusDayKey(value: Date | string, dayStartHour = 0): string {
  const d = typeof value === 'string' ? new Date(value) : new Date(value);
  // Use the local wall-clock hour directly: anything before the cutoff belongs to
  // the previous calendar day. setDate() rolls month/year over and is DST-safe
  // (it operates on the local calendar, not a fixed millisecond offset).
  const shifted = new Date(d);
  if (d.getHours() < dayStartHour) {
    shifted.setDate(shifted.getDate() - 1);
  }
  return dateKey(shifted);
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function safeFocusSessions(value: unknown): FocusSession[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is FocusSession => {
    if (!s || typeof s !== 'object') return false;
    const item = s as Partial<FocusSession>;
    return (
      typeof item.id === 'string' &&
      typeof item.startedAt === 'string' &&
      typeof item.endedAt === 'string' &&
      typeof item.durationSeconds === 'number' &&
      item.durationSeconds > 0
    );
  });
}

export function loadLocalFocusSessions(): FocusSession[] {
  try {
    return safeFocusSessions(JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]'));
  } catch (_) {
    return [];
  }
}

export function coerceFocusTimer(parsed: unknown): FocusTimerState {
  if (!parsed || typeof parsed !== 'object') return DEFAULT_FOCUS_TIMER;
  const p = parsed as Partial<FocusTimerState>;
  return {
    plannedSeconds: Number(p.plannedSeconds) || DEFAULT_FOCUS_TIMER.plannedSeconds,
    accumulatedSeconds: Math.max(0, Number(p.accumulatedSeconds) || 0),
    isRunning: Boolean(p.isRunning),
    lastStartedAt: typeof p.lastStartedAt === 'string' ? p.lastStartedAt : null,
    sessionStartedAt: typeof p.sessionStartedAt === 'string' ? p.sessionStartedAt : null,
  };
}

export function loadLocalFocusTimer(): FocusTimerState {
  try {
    return coerceFocusTimer(JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY) || 'null'));
  } catch (_) {
    return DEFAULT_FOCUS_TIMER;
  }
}

export function getFocusTimerElapsedSeconds(timer: FocusTimerState, now = Date.now()): number {
  const runningSeconds = timer.isRunning && timer.lastStartedAt
    ? Math.max(0, Math.floor((now - new Date(timer.lastStartedAt).getTime()) / 1000))
    : 0;
  return Math.max(0, Math.floor(timer.accumulatedSeconds + runningSeconds));
}

export function formatFocusDuration(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function sumFocusSecondsForDay(sessions: FocusSession[], day: Date, dayStartHour = 0): number {
  const key = dateKey(day);
  return sessions
    .filter(session => focusDayKey(session.endedAt, dayStartHour) === key)
    .reduce((sum, session) => sum + session.durationSeconds, 0);
}
