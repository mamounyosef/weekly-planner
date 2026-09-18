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
