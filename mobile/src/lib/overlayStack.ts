// Which screen is on top of the phone's tabs, and what the back button closes.
//
// WHY THESE TWO QUESTIONS SHARE A FILE
// They are the same question, and they were being answered twice: once by the
// chain of ternaries that decides what to draw, and once by a list of `if`s in
// the hardware back handler. The two lists had drifted into being very nearly
// each other's REVERSE -- the drawing order ran conflicts, categories, task
// settings, reminders, prayers, planner, search, notifications, and the back
// handler ran notifications, search, planner, prayers, reminders, categories,
// task settings, conflicts. The comment above the back handler said "in the
// order they are drawn, topmost first", which is precisely what it was not.
//
// Nothing about that is visible until two of them are open at once, which the
// app allows: opening one screen does not close another, and the back handler
// then closed a screen the user could not see while the one covering the
// display stayed exactly where it was. Pressing back and having nothing happen
// is the sort of thing that gets described as the app being broken, and it is
// impossible to guess at from the code because the two lists are four hundred
// lines apart.
//
// So the order lives here, once. `topOverlay` decides what is drawn; `backTarget`
// decides what closes; both read the same array, and a test asserts they can
// never disagree.

/**
 * Every screen that can cover the tabs, TOPMOST FIRST.
 *
 * The order is the drawing order the app already had. It is not alphabetical and
 * it is not arbitrary: Diagnostics is opened from Settings and has to sit above
 * it, Conflicts is opened from a banner that can appear over anything, and the
 * bell can open Reminders from on top of the Notifications list.
 */
export const OVERLAY_ORDER = [
  'diagnostics',
  'conflicts',
  'categories',
  'taskSettings',
  'reminders',
  'prayers',
  'planner',
  'search',
  'notifications',
] as const;

export type OverlayName = (typeof OVERLAY_ORDER)[number];

/** Which overlays are open right now. Absent and false mean the same thing. */
export type OverlayFlags = Partial<Record<OverlayName, boolean>>;

/**
 * The one that is actually covering the screen, or null for the bare tabs.
 */
export function topOverlay(open: OverlayFlags): OverlayName | null {
  for (const name of OVERLAY_ORDER) {
    if (open[name]) return name;
  }
  return null;
}

/**
 * What the hardware back button should close.
 *
 * BY CONSTRUCTION THE SAME ANSWER AS `topOverlay`. Back closes what you can see;
 * anything else is a press that appears to do nothing while quietly dismantling
 * the screen behind. Written as its own function because the caller has a third
 * case -- there is nothing on top, so back leaves the tab it is on -- and
 * because naming it says what it is for.
 */
export function backTarget(open: OverlayFlags): OverlayName | null {
  return topOverlay(open);
}

/**
 * What the back button does, all of it, in one answer.
 *
 * `tab` is the tab currently shown and `home` the one the app returns to before
 * it will let itself be closed. Keeping this here rather than in the handler is
 * what makes "back should never exit while something is open" a thing a test can
 * check rather than a thing to be careful about.
 */
export type BackAction =
  | { kind: 'close-overlay'; overlay: OverlayName }
  | { kind: 'close-sheet' }
  | { kind: 'go-home' }
  | { kind: 'exit' };

export function backAction(
  open: OverlayFlags,
  options: { sheetOpen?: boolean; tab: string; home?: string } = { tab: 'calendar' },
): BackAction {
  const overlay = backTarget(open);
  if (overlay) return { kind: 'close-overlay', overlay };

  // A sheet inside the tab stack sits UNDER every overlay, so it is closed only
  // once none of them are left.
  if (options.sheetOpen) return { kind: 'close-sheet' };

  const home = options.home ?? 'calendar';
  if (options.tab !== home) return { kind: 'go-home' };

  // Nothing is covering anything and we are already home: this is the press that
  // leaves the app, and the only one that may.
  return { kind: 'exit' };
}
