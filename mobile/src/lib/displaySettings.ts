// ─── The shared display settings ─────────────────────────────────────────────
// The handful of choices that describe the PLANNER rather than the screen it is
// being read on, and which the phone could read but never change.
//
// WHICH SIDE OF THE LINE THESE SIT ON
// `settingsScope.ts` already draws the line: shared settings travel between the
// machines, device settings do not. Everything here is on the shared side, and
// deliberately so. Which day a week starts on is a property of the calendar
// itself: a phone whose weeks began on Sunday while the desk's began on Monday
// would not be two preferences, it would be two different calendars, and every
// repeat expanded against the week start would land differently on each.
// Twelve or twenty four hour time is the same kind of fact, as is what a task
// looks like and when a focus day rolls over.
//
// So this module is not a second copy of the settings. It is the validating and
// patching layer the phone needs to WRITE them safely, and it exists as its own
// file for one reason: a per-field sync means a value written in a shape the
// desk does not expect is not a local mistake. It replicates.
//
// EVERY READER IS TOTAL AND EVERY WRITER IS IDEMPOTENT
// Total, because a value can arrive from an older build, a half-finished merge,
// or a hand-edited file, and a settings screen that throws is a settings screen
// you cannot use to fix the setting. Idempotent, because the sync layer compares
// before it writes: a normaliser that returned a new shape each pass would look
// like a change every time and the two machines would write at each other for
// ever.

export type TimeFormat = '12h' | '24h';
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type CheckboxShape = 'circle' | 'square';

export interface DisplaySettings {
  /** Which weekday a week begins on. Repeats expand against this. */
  weekStartsOn: WeekStart;
  /** Twelve or twenty four hour clock, everywhere a time is written. */
  timeFormat: TimeFormat;
  /** The one colour tasks wear on the grid. */
  taskColor: string;
  /** Whether a task's tick box is round or square. */
  taskCheckboxShape: CheckboxShape;
  /** Whether an overdue repeating task rolls forward to today on its own. */
  autoRollRecurringTasks: boolean;
  /**
   * The hour a focus DAY rolls over.
   *
   * Not midnight, and that is the point of it: work done at one in the morning
   * belongs to the day that has not ended yet, not to the one just started.
   */
  focusDayStartHour: number;
  /**
   * How long a focus day is meant to be, in seconds.
   *
   * Zero means no goal, and that is a real answer rather than a missing one:
   * with no goal any focused day counts towards a streak, which is what someone
   * who has not set one would expect.
   */
  focusDailyGoalSeconds: number;
  focusExcludedDates: string[];
}

/** The desk's own defaults, so a phone with nothing synced yet agrees with it. */
export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  weekStartsOn: 1,
  timeFormat: '12h',
  taskColor: '#64748b',
  taskCheckboxShape: 'circle',
  autoRollRecurringTasks: true,
  focusDayStartHour: 4,
  focusDailyGoalSeconds: 0,
  focusExcludedDates: [],
};

export const WEEK_START_LABELS: { id: WeekStart; label: string; short: string }[] = [
  { id: 0, label: 'Sunday', short: 'Sun' },
  { id: 1, label: 'Monday', short: 'Mon' },
  { id: 2, label: 'Tuesday', short: 'Tue' },
  { id: 3, label: 'Wednesday', short: 'Wed' },
  { id: 4, label: 'Thursday', short: 'Thu' },
  { id: 5, label: 'Friday', short: 'Fri' },
  { id: 6, label: 'Saturday', short: 'Sat' },
];

export const TIME_FORMATS: { id: TimeFormat; label: string; hint: string }[] = [
  { id: '12h', label: '12 hour', hint: 'Times read as 6:30pm.' },
  { id: '24h', label: '24 hour', hint: 'Times read as 18:30.' },
];

export const CHECKBOX_SHAPES: { id: CheckboxShape; label: string }[] = [
  { id: 'circle', label: 'Round' },
  { id: 'square', label: 'Square' },
];

/** The colours the desk offers for tasks. */
export const TASK_COLOURS: readonly string[] = [
  '#64748b', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
];

export function isTimeFormat(raw: unknown): raw is TimeFormat {
  return raw === '12h' || raw === '24h';
}

export function isWeekStart(raw: unknown): raw is WeekStart {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6;
}

export function isCheckboxShape(raw: unknown): raw is CheckboxShape {
  return raw === 'circle' || raw === 'square';
}

export function isHexColour(raw: unknown): raw is string {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw);
}

/**
 * The hour a focus day may roll over on.
 *
 * Nought to eleven. Past midday it stops describing "the small hours of the
 * previous day" and starts silently splitting ordinary afternoons in two.
 */
export function isFocusDayStartHour(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 11;
}

/** The goals worth offering, in seconds. Zero is the first, and means none. */
export const FOCUS_GOAL_CHOICES: readonly number[] = [
  0, 1800, 3600, 5400, 7200, 10800, 14400, 21600, 28800,
];

/**
 * A daily goal, from nothing up to a whole day.
 *
 * Capped at twenty four hours because a goal longer than the day it is measured
 * against can never be met, so it is not a goal, it is a bar that is always
 * empty.
 */
export function isFocusGoalSeconds(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 24 * 3600;
}

/**
 * Read whatever is stored, field by field.
 *
 * PER FIELD, NOT PER OBJECT. Rejecting the whole object because one value is
 * wrong would throw away five good settings to punish one bad one, and the bad
 * one is usually the least important.
 */
export function coerceDisplaySettings(raw: unknown): DisplaySettings {
  const out = { ...DEFAULT_DISPLAY_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;

  if (isWeekStart(r.weekStartsOn)) out.weekStartsOn = r.weekStartsOn;
  if (isTimeFormat(r.timeFormat)) out.timeFormat = r.timeFormat;
  // Lower cased so one colour is one value: two spellings of the same hex would
  // compare unequal and rewrite the setting on every pass.
  if (isHexColour(r.taskColor)) out.taskColor = r.taskColor.toLowerCase();
  if (isCheckboxShape(r.taskCheckboxShape)) out.taskCheckboxShape = r.taskCheckboxShape;
  if (typeof r.autoRollRecurringTasks === 'boolean') {
    out.autoRollRecurringTasks = r.autoRollRecurringTasks;
  }
  if (isFocusDayStartHour(r.focusDayStartHour)) out.focusDayStartHour = r.focusDayStartHour;
  if (isFocusGoalSeconds(r.focusDailyGoalSeconds)) {
    out.focusDailyGoalSeconds = r.focusDailyGoalSeconds;
  }
  if (Array.isArray(r.focusExcludedDates)) {
    out.focusExcludedDates = r.focusExcludedDates.filter(d => typeof d === 'string');
  }
  return out;
}

/**
 * One change, validated, ready to write.
 *
 * Returns only the fields that ACTUALLY changed. A per-field sync stamps every
 * field it is handed, so writing all six every time would out-rank five settings
 * the desk may have changed a moment ago for the sake of the one that moved.
 */
export function displayPatch(
  current: unknown, patch: Partial<DisplaySettings>,
): Partial<DisplaySettings> {
  const now = coerceDisplaySettings(current);
  const next = coerceDisplaySettings({ ...now, ...patch });
  const out: Partial<DisplaySettings> = {};
  for (const key of Object.keys(next) as (keyof DisplaySettings)[]) {
    if (!sameSetting(next[key], now[key])) (out as Record<string, unknown>)[key] = next[key];
  }
  return out;
}

/**
 * Are these two values of a setting the same setting?
 *
 * BY VALUE FOR LISTS, NOT BY REFERENCE. `coerceDisplaySettings` rebuilds every
 * list it returns, so two identical exclusion lists are never the same object,
 * and a straight `!==` reported them as a change. That put
 * `focusExcludedDates: []` into EVERY patch the phone sent -- so changing the
 * time format broadcast an empty list of excused days, and every day the user
 * had excused on the PC was wiped by a setting that had nothing to do with
 * them. Exactly the redundant write the rest of this function exists to avoid,
 * except this one destroyed something on its way past.
 */
function sameSetting(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** An hour a person can read. Never a bare number, and never a dash. */
export function describeHour(hour: number, clock: TimeFormat = '12h'): string {
  // Guarded before the modulo, not after: `Infinity % 24` is NaN, and the
  // result was printing "NaNpm" at people rather than falling back.
  const n = Number(hour);
  const h = Number.isFinite(n) ? ((Math.floor(n) % 24) + 24) % 24 : 0;
  if (clock === '24h') return `${String(h).padStart(2, '0')}:00`;
  if (h === 0) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** What the focus day setting actually means, said plainly. */
export function describeFocusDay(hour: number, clock: TimeFormat = '12h'): string {
  if (!isFocusDayStartHour(hour)) return describeFocusDay(DEFAULT_DISPLAY_SETTINGS.focusDayStartHour, clock);
  if (hour === 0) return 'A focus day runs from midnight to midnight.';
  return `Work before ${describeHour(hour, clock)} counts towards the day before.`;
}

/** A goal a person can read. "No goal" is a sentence, not an empty string. */
export function describeFocusGoal(seconds: number): string {
  if (!isFocusGoalSeconds(seconds) || seconds === 0) return 'No goal';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes} minutes a day`;
  if (minutes === 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'} a day`;
  return `${hours}h ${minutes}m a day`;
}

/** One line summarising the lot, for a settings row that is not open. */
export function describeDisplaySettings(s: DisplaySettings): string {
  const day = WEEK_START_LABELS.find(w => w.id === s.weekStartsOn)?.label ?? 'Monday';
  const clock = s.timeFormat === '24h' ? '24 hour' : '12 hour';
  return `Weeks start on ${day}, ${clock} time.`;
}
