// Where should the MAIN scroll container go so the now-line is centred?
//
// WHY THIS EXISTS AND WHY `scrollIntoView` IS BANNED FROM THIS CALL SITE
// The now-line is rendered inside the today column's grid, which clips with
// `overflow: hidden`. An `overflow: hidden` box is still a SCROLL BOX: the
// browser will happily move its content for `scrollIntoView`, focus, or
// find-in-page, and `hidden` means there is no scrollbar to undo it with. That
// is exactly how "Go to Live" once scrolled ONLY the today column -- the line's
// inner box had a stray scrollable overflow, `scrollIntoView({ block: 'center' })`
// obliged, and one day's Get Up / Sleep blocks drifted a screen above everyone
// else's with no way to pull them back. The rule the bug taught us:
//
//   Never hand the browser a target and let it pick the boxes. Pick ONE box
//   (the main scroller), compute its offset yourself, and set its scrollTop.
//
// The maths below therefore takes measurements the caller reads off the two
// rects, and answers a single number: the new scrollTop of that one container.

export interface LiveScrollMeasurements {
  /** Current scrollTop of the scroll container that owns the timeline. */
  scrollTop: number;
  /** Visible height of that container, in layout pixels (clientHeight). */
  clientHeight: number;
  /** Top of the container's bounding rect, in visual pixels. */
  boundingTop: number;
  /** Height of the container's bounding rect, in visual pixels. */
  boundingHeight: number;
  /** Full content height of the container (scrollHeight), for clamping. */
  scrollHeight: number;
  /** Top of the now-line's bounding rect, in visual pixels. */
  lineTop: number;
  /** Height of the now-line's bounding rect. The line is hairline-thin, so this is usually 0. */
  lineHeight: number;
}

/**
 * Clamp a scrollTop into what a container can actually do.
 *
 * Exported because the same rule repairs any scroll box whose content shrunk
 * under it: never negative, never past the content. A container asked to go
 * above its own top is either ignored or clamped depending on the platform,
 * and "either" is not a behaviour.
 */
export function clampScrollTop(top: number, scrollHeight: number, clientHeight: number): number {
  // Math.min/max would propagate NaN into a scrollTop assignment; an offset
  // that cannot be read is the top of the content, never "undefined behaviour".
  // Infinities need no guard -- they clamp to the legal range on their own.
  if (Number.isNaN(top)) return 0;
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(Math.max(top, 0), max);
}

/**
 * The scrollTop that puts the now-line's centre at the viewport's centre, of
 * THE ONE container that was measured -- no other box is touched.
 *
 * All measurements may come from `getBoundingClientRect`, which reports VISUAL
 * pixels, while `scrollTop`/`clientHeight`/`scrollHeight` are LAYOUT pixels.
 * CSS `zoom` (the phone content zoom) scales the rects but not the offsets, so
 * the visual delta is divided by the rect/layout ratio before it is applied.
 * Browser zoom scales both sides equally, making that ratio 1 and this a
 * no-op -- which is the desired outcome there.
 *
 * Anything unmeasurable answers "stay where you are": a NaN from a layout pass
 * that has not run must not fling the user to the top of the day.
 */
export function liveScrollTarget(m: LiveScrollMeasurements): number {
  const {
    scrollTop, clientHeight, boundingTop, boundingHeight,
    scrollHeight, lineTop, lineHeight,
  } = m;

  if (!Number.isFinite(scrollTop)) return 0;
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return 0;
  if (!Number.isFinite(scrollHeight)) return scrollTop;
  if (!Number.isFinite(boundingTop) || !Number.isFinite(boundingHeight)) return scrollTop;
  if (!Number.isFinite(lineTop)) return scrollTop;
  // A broken line height is not fatal -- the line is a hairline anyway, and a
  // negative one would silently drag the centre above the line's top.
  const h = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 0;

  // Visual px per layout px. Guarded: a rect of zero (display:none ancestors,
  // a hidden tab) must not turn the delta into an infinity.
  const scale = Number.isFinite(boundingHeight / clientHeight) && boundingHeight > 0
    ? boundingHeight / clientHeight
    : 1;

  const lineCentreVisual = lineTop + h / 2;
  const viewportCentreVisual = boundingTop + boundingHeight / 2;
  const deltaLayout = (lineCentreVisual - viewportCentreVisual) / scale;

  return clampScrollTop(scrollTop + deltaLayout, scrollHeight, clientHeight);
}

// ─── Which column holds "now", and where "Go to Live" should land ────────────
//
// WHY `null` AND NEVER -1
// The custom view renders columns OUTSIDE the anchor week, and it addresses
// them by their offset from the week start: the three days before a Sunday
// anchor are -3, -2 and -1. "Now is not on screen" used to be spelled -1, so
// on any custom range that did not contain today, the day right before the
// anchor matched that sentinel and drew a live line on itself (a Saturday
// showing "12:57pm", on every future week). The same false line then made
// "Go to Live" and its shortcut believe the line was on screen, so they
// scrolled to the fake one instead of travelling to today, and the pill that
// is supposed to bring you home was suppressed. Every integer is a legal
// column offset, so the only honest "nowhere" is `null`.

/** Minutes past midnight of a local time. */
const minutesOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** Local midnight of a date, without mutating it. */
const midnight = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * The calendar date whose column the live line belongs in. A day column spans
 * dayStartH -> dayStartH + 24h, so between midnight and the day-start hour
 * "now" is still part of YESTERDAY's column.
 */
export function liveColumnDate(now: Date, dayStartH: number): Date {
  const day = midnight(now);
  const startH = Number.isFinite(dayStartH) ? dayStartH : 0;
  if (minutesOfDay(now) < startH * 60) day.setDate(day.getDate() - 1);
  return day;
}

/**
 * Whole calendar days from `from` to `to`, by local date. Counting 24-hour
 * periods instead would be off by one across a daylight-saving change (a 23h
 * day is not a whole "day" of milliseconds).
 */
export function calendarDayDiff(to: Date, from: Date): number {
  const a = midnight(to);
  const b = midnight(from);
  return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
    - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 86_400_000);
}

/**
 * The column offset (from the viewed week's start) that holds the live line,
 * or `null` when that column is not on screen. `visibleCols` are the offsets
 * the grid is painting, which may be negative or past 6 in the custom view.
 */
export function liveColumnOffset(opts: {
  now: Date;
  weekStart: Date;
  visibleCols: readonly number[];
  dayStartH: number;
}): number | null {
  const { now, weekStart, visibleCols, dayStartH } = opts;
  if (Number.isNaN(now.getTime()) || Number.isNaN(weekStart.getTime())) return null;
  const offset = calendarDayDiff(liveColumnDate(now, dayStartH), weekStart);
  return visibleCols.includes(offset) ? offset : null;
}

/**
 * Is the live line actually visible to the user?
 *
 * The line lives inside a scroller whose top is covered by STICKY bands (day
 * headers, all-day row, task row, mini focus bar). A line tucked under them
 * is inside the scroller's rect but hidden, which is exactly when the
 * "Go to Live" pill is needed, so the visible window starts below the lowest
 * of those bands, not at the scroller's top.
 */
export function liveLineVisible(opts: {
  lineTop: number;
  scrollerTop: number;
  scrollerBottom: number;
  /** Bottom edges of the sticky bands painted over the top of the scroller. */
  occluderBottoms: readonly number[];
  /** Extra space covered at the bottom (the phone's tab bar), in px. */
  bottomInset?: number;
}): boolean {
  const { lineTop, scrollerTop, scrollerBottom, occluderBottoms, bottomInset = 0 } = opts;
  if (!Number.isFinite(lineTop) || !Number.isFinite(scrollerTop) || !Number.isFinite(scrollerBottom)) return false;
  let top = scrollerTop;
  for (const b of occluderBottoms) if (Number.isFinite(b) && b > top) top = b;
  const bottom = scrollerBottom - (Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0);
  return lineTop >= top && lineTop <= bottom;
}
