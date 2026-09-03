// Is the now-line out of sight, and where do we scroll to bring it back?
//
// WHY THIS IS NOT TWO EXPRESSIONS INSIDE THE DAY SCREEN
// It used to be, and the screen paid for it: the scroll offset was React state
// written on every frame of every scroll, so the whole day re-rendered sixty
// times a second to answer a question whose answer is a single boolean that
// changes twice per scroll. Pulling the question out is what let the offsets
// become refs -- the screen now recomputes this on every frame and only writes
// state when the ANSWER changes.
//
// The two margins are not symmetrical, and that is deliberate. A line drifting
// off the top is gone the moment it passes the edge, so a small allowance is
// enough. A line near the bottom is technically visible while sitting under the
// floating button and the tab bar, so it counts as gone well before it reaches
// the edge. Getting these the same way round on both sides is what made the
// pill flicker on and off while a thumb rested still.

/** How far past the top edge the line may drift before it counts as gone. */
export const TOP_ALLOWANCE = 30;

/** How much of the bottom is spoken for by the button and the bar. */
export const BOTTOM_ALLOWANCE = 100;

export interface LiveMarkerView {
  /** Current scroll offset of the day. */
  scrollY: number;
  /** Height of the visible window. */
  viewport: number;
  /** Where the timeline group starts inside the scroller. */
  timelineY: number;
  /** Where the now-line sits inside the timeline, or null if it is not drawn. */
  nowLineY: number | null;
}

/**
 * Is the now-line outside the part of the window the user can actually use?
 *
 * False whenever there is no line to find, which is the whole answer for any
 * day that is not today: a pill offering to scroll to "now" on a Thursday in
 * three weeks is an offer to go nowhere.
 */
export function nowLineOffscreen(view: LiveMarkerView): boolean {
  const { scrollY, viewport, timelineY, nowLineY } = view;
  if (nowLineY === null) return false;
  if (!Number.isFinite(scrollY) || !Number.isFinite(viewport)) return false;
  if (!Number.isFinite(timelineY) || !Number.isFinite(nowLineY)) return false;

  const line = timelineY + nowLineY;
  if (line + TOP_ALLOWANCE < scrollY) return true;
  return line > scrollY + viewport - BOTTOM_ALLOWANCE;
}

/**
 * Where to scroll so the now-line sits in the middle of the window.
 *
 * Never negative: asking a scroller to go above its own top is either ignored
 * or clamped depending on the platform, and "either" is not a behaviour.
 */
export function goToLiveOffset(view: LiveMarkerView): number {
  const { viewport, timelineY, nowLineY } = view;
  if (nowLineY === null) return 0;
  if (!Number.isFinite(viewport) || !Number.isFinite(timelineY) || !Number.isFinite(nowLineY)) return 0;
  return Math.max(0, timelineY + nowLineY - viewport / 2 + 50);
}
