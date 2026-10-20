// The floating orb's focus ring (planner_orb.py draws it; the widget feeds it).
//
// A full circle is an average focus-day: the mean of the 30 focus-days before
// today. Past that the ring keeps going in gold, up to a second full lap at
// double the average. Pure, so it is tested on its own.

/** How many past focus-days the average looks at. */
export const ORB_AVERAGE_DAYS = 30;

/** The ring's ceiling: two full laps (twice the average). */
export const ORB_MAX_FRACTION = 2;

function parseKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function keyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Mean seconds per focus-day over the `days` focus-days before `todayKey`.
 *
 * - Today is left out: it is the thing being measured against the average.
 * - Excluded days (holidays, sick days) are left out, as everywhere else.
 * - Days with no focus count as zero, like the Focus screen's daily average,
 *   EXCEPT days before the first focus ever recorded: a planner first used ten
 *   days ago should not have its average dragged down by twenty days that
 *   predate it.
 * - Nothing to go on gives 0.
 */
export function orbAverageSeconds(
  totals: ReadonlyMap<string, { seconds: number }>,
  todayKey: string,
  excludedDates: Iterable<string> = [],
  days = ORB_AVERAGE_DAYS,
): number {
  const today = parseKey(todayKey);
  if (!today || !(days > 0)) return 0;
  const excluded = new Set(excludedDates);

  let firstKey: string | null = null;
  for (const [k, t] of totals) {
    if (!(Number(t?.seconds) > 0) || !parseKey(k)) continue;
    if (firstKey === null || k < firstKey) firstKey = k;
  }
  if (firstKey === null) return 0;

  let sum = 0;
  let count = 0;
  for (let i = 1; i <= Math.floor(days); i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const k = keyOf(d);
    if (k < firstKey) break;
    if (excluded.has(k)) continue;
    const s = Number(totals.get(k)?.seconds ?? 0);
    sum += Number.isFinite(s) && s > 0 ? s : 0;
    count += 1;
  }
  return count > 0 ? Math.round(sum / count) : 0;
}

/**
 * How far round the ring goes: 1 is the average, 2 (the cap) twice it.
 *
 * With no average yet (a brand-new planner, or every recent day excluded) the
 * daily goal stands in for it; with neither, any focus at all already beats
 * "nothing", so it shows as a full overflow.
 */
export function orbFraction(todaySeconds: number, averageSeconds: number, fallbackGoalSeconds = 0): number {
  const today = Number.isFinite(todaySeconds) && todaySeconds > 0 ? todaySeconds : 0;
  const avg = Number.isFinite(averageSeconds) && averageSeconds > 0
    ? averageSeconds
    : Number.isFinite(fallbackGoalSeconds) && fallbackGoalSeconds > 0 ? fallbackGoalSeconds : 0;
  if (avg <= 0) return today > 0 ? ORB_MAX_FRACTION : 0;
  return Math.min(ORB_MAX_FRACTION, today / avg);
}

/**
 * Rounded so the widget only bothers the orb when the ring would visibly
 * move: 1/500 of a lap is well under a pixel on a 34px orb.
 */
export function quantiseOrbFraction(frac: number): number {
  if (!Number.isFinite(frac) || frac <= 0) return 0;
  return Math.min(ORB_MAX_FRACTION, Math.round(frac * 500) / 500);
}
