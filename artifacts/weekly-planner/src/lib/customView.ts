// Custom calendar view: which week-relative column offsets are on screen, and
// how the viewed date follows the real day when the calendar date rolls over.
// Pure, so it is tested in customView.test.ts.

export const CUSTOM_BEFORE_MIN = -14;
export const CUSTOM_BEFORE_MAX = 14;
export const CUSTOM_AFTER_MIN = -14;
export const CUSTOM_AFTER_MAX = 14;

export type CustomAnchor = 'day' | 'week';

/** A finite integer in [lo, hi]; anything unusable (NaN, Infinity, junk) becomes `fallback`. */
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

export interface CustomWindow {
  /** The before/after values actually used (clamped for the anchor). */
  before: number;
  after: number;
  /** Column offsets from the week start, in order, never empty. */
  cols: number[];
}

/**
 * The columns of the custom view.
 * - 'day': `before` days before the viewed day through `after` days after it
 *   (both 0..14), so the span is always before + after + 1.
 * - 'week': the week start shifted by `before` through the week end shifted by
 *   `after` (both -14..14). An inverted range collapses to its start column.
 * `dayColIdx` is the viewed day's offset from the week start (0..6).
 */
export function customWindow(anchor: CustomAnchor, before: unknown, after: unknown, dayColIdx: number): CustomWindow {
  const center = clampInt(dayColIdx, 0, 6, 0);
  if (anchor === 'week') {
    const b = clampInt(before, CUSTOM_BEFORE_MIN, CUSTOM_BEFORE_MAX, 0);
    const a = clampInt(after, CUSTOM_AFTER_MIN, CUSTOM_AFTER_MAX, 0);
    const from = b;
    const to = Math.max(from + 1, 6 + a + 1);
    return { before: b, after: a, cols: range(from, to) };
  }
  const b = clampInt(before, 0, CUSTOM_BEFORE_MAX, 0);
  const a = clampInt(after, 0, CUSTOM_AFTER_MAX, 0);
  return { before: b, after: a, cols: range(center - b, center + a + 1) };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

/** Local calendar-day key, e.g. "2026-10-29". */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * When the real day changes (midnight, or waking from hibernate days later),
 * a calendar that was showing the old "today" moves to the new today, so a
 * Today-anchored custom view stays centred on today. A calendar the user had
 * navigated elsewhere is left alone. Returns the date to view.
 */
export function followToday(viewed: Date, prevToday: Date, today: Date): Date {
  if (dayKey(prevToday) === dayKey(today)) return viewed;
  if (dayKey(viewed) !== dayKey(prevToday)) return viewed;
  return today;
}
