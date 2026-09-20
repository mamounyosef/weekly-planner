/**
 * Converting between "HH:MM" and minutes since midnight.
 *
 * WHY THIS IS ITS OWN FILE. On 2026-09-20 the whole planner rendered as a black
 * window. The cause was one event out of 185: an all-day item called "Safe
 * Distance Project", created on the phone, with no `startTime`. An all-day
 * event legitimately has no start time, so the data was right.
 *
 * What was wrong was `timeToMin`, which went straight to `t.split(':')` and
 * threw on it. The blast radius was total because the call sits inside a
 * `useMemo` that sorts each month cell's events by start time (all-day items
 * pass that filter too), so React could render nothing at all and the user saw
 * an empty window with no error.
 *
 * There were TWO copies of that function, one in home.tsx and one in
 * widget.tsx, so the same single event could take down the side widget too.
 * Hence one hardened implementation, in a file that can actually be tested.
 *
 * The rule these encode: a single unusable value in one record degrades that
 * record's ordering, never the application.
 */

/** Minutes in a day. */
const DAY_MINUTES = 1440;

/**
 * "HH:MM" to minutes since midnight. Total: never throws, whatever it is given.
 *
 * Missing or malformed reads as midnight (0), which sorts all-day items to the
 * start of the day, where they belong.
 */
export function timeToMin(t: string | null | undefined): number {
  if (typeof t !== 'string') return 0;
  const [h, m] = t.split(':').map(Number);
  // NaN from a non-numeric part, and Infinity from something exotic, both have
  // to be rejected: either one poisons a sort comparator into returning NaN,
  // which silently scrambles the order instead of failing loudly.
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/**
 * Minutes since midnight back to "HH:MM", wrapped into a single day.
 *
 * Wrapping rather than clamping is deliberate: callers add and subtract
 * durations freely (dragging an event past midnight, a reminder offset before
 * one), and a negative or over-long result should come back as the time of day
 * it actually lands on.
 */
export function minToTime(min: number): string {
  if (!Number.isFinite(min)) return '00:00';
  const normMin = ((Math.trunc(min) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const h = Math.floor(normMin / 60);
  const m = normMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
