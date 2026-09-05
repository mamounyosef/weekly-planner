// ─── Design tokens ───────────────────────────────────────────────────────────
// One signal colour, quiet everything else.
//
// The planner is looked at in two situations that pull in opposite directions:
// a quick glance in bright daylight, and a last check in bed with the lights
// off. So the palette is built dark-first with a true light twin, and the
// neutrals carry a slight indigo bias so the accent never looks bolted on.
//
// Colour carries meaning, never decoration:
//   accent  — the one interactive/present colour
//   ok      — in sync
//   warn    — something is waiting for you to decide
//   danger  — destructive
// Event colours come from the user's own categories and are separate from all
// of these, which is why the accent is a violet-indigo rather than a hue anyone
// is likely to have picked for a category.

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  accent: string;
  accentSoft: string;
  accentInk: string;
  ok: string;
  warn: string;
  warnSoft: string;
  danger: string;
  shadow: string;
  scrim: string;
}

export const dark: Palette = {
  bg: '#0D0D14',
  surface: '#16161F',
  surfaceAlt: '#1D1D29',
  line: '#272733',
  ink: '#ECECF5',
  inkSoft: '#A6A6BA',
  inkFaint: '#6E6E85',
  accent: '#8C88FF',
  accentSoft: 'rgba(140, 136, 255, 0.14)',
  accentInk: '#0D0D14',
  ok: '#4FD1A5',
  warn: '#E9A94C',
  warnSoft: 'rgba(233, 169, 76, 0.14)',
  danger: '#F0798A',
  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.55)',
};

export const light: Palette = {
  bg: '#F5F5FA',
  surface: '#FFFFFF',
  surfaceAlt: '#EDEDF4',
  line: '#E1E1EC',
  ink: '#15151E',
  inkSoft: '#5A5A70',
  inkFaint: '#8B8BA0',
  accent: '#4F46D6',
  accentSoft: 'rgba(79, 70, 214, 0.10)',
  accentInk: '#FFFFFF',
  ok: '#12876A',
  warn: '#A96716',
  warnSoft: 'rgba(169, 103, 22, 0.10)',
  danger: '#C43D53',
  shadow: '#2A2A44',
  scrim: 'rgba(20, 20, 35, 0.45)',
};

/** Spacing scale. Everything is a multiple of 4 so rhythm holds on any screen. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

/** Type scale. Sizes are in points; line heights are set alongside, never left
 *  to the platform default, which differs between Android versions. */
export const type = {
  display: { fontSize: 26, lineHeight: 31, fontWeight: '700' as const, letterSpacing: -0.5 },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 16, lineHeight: 21, fontWeight: '600' as const, letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 17, fontWeight: '400' as const },
  label: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 1.1 },
  clock: { fontSize: 13, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.2 },
} as const;

/**
 * How far Android's own font-size slider may enlarge each variant.
 *
 * The system setting goes to 1.3, and Samsung's goes further still. Applied to
 * a 30pt screen title beside four 48pt buttons, that is the difference between
 * a heading and "Tod...", and once a title truncates the header stops telling
 * you which day you are looking at.
 *
 * So the caps are graded by what the text is for rather than uniform. Body
 * copy and captions are what somebody enlarging their font actually wants to
 * read, and they sit in flowing layouts that can absorb the extra height, so
 * they keep nearly the whole range. Display and title sit in fixed rows beside
 * fixed-size controls and are already the largest thing on screen, so they are
 * held close to their drawn size: making a 26pt heading 34pt helps nobody and
 * costs the line that follows it.
 *
 * A cap is NOT a refusal to scale. Every variant still grows with the setting;
 * it simply stops before it breaks the row it lives in.
 */
export const MAX_FONT_SCALE = {
  display: 1.15,
  title: 1.2,
  heading: 1.25,
  body: 1.35,
  bodyStrong: 1.35,
  caption: 1.3,
  label: 1.25,
  clock: 1.2,
} as const;

/**
 * Touch targets.
 *
 * 48 is Android's accessibility floor and the app holds to it everywhere —
 * a planner is used one-handed, in a hurry, often while walking.
 */
/**
 * What a press looks like, everywhere.
 *
 * The app had 106 pressable things and feedback on 31 of them. The other 75
 * did their job perfectly and looked like they had ignored you, which is
 * indistinguishable from being slow: with nothing acknowledging the touch, the
 * only signal that anything happened is the screen finally changing, so every
 * interaction felt like it took as long as its slowest part.
 *
 * Dimming is used rather than a ripple because it is honest on any shape. An
 * Android ripple is masked to the view's background drawable, so on the many
 * transparent or oddly-clipped touch targets here it would spill as a
 * rectangle. Opacity cannot be wrong about a shape.
 *
 * Applied through `style={({ pressed }) => [...]}`, so it costs nothing until a
 * finger is down.
 */
export const PRESSED = { opacity: 0.55 } as const;

/**
 * The least room to leave under anything sitting at the bottom of a sheet.
 *
 * `useSafeAreaInsets()` is read inside a Modal, which is its own window, and
 * what comes back there is not reliably the gesture bar's height -- the Add
 * button ended up resting on the navigation line. This is a floor, not a
 * replacement: a device that reports a real inset still gets it.
 */
/**
 * How long a finger must be down before anything lights up.
 *
 * Zero -- React Native's default -- means a touch highlights the moment it
 * lands, and a scroll begins with a touch. So dragging the editor lit up every
 * control the thumb passed over on the way down: nothing was ever pressed, but
 * everything flashed as though it had been, which reads as the list being
 * confused about what you meant.
 *
 * A tenth of a second is long enough that a scroll never starts one and short
 * enough that a real tap still feels immediate -- a deliberate press lasts
 * upwards of 150ms, so the highlight is still there before the finger lifts.
 * This is the same trick UIScrollView has used since the first iPhone.
 *
 * NOT used on the tab bar, which is not inside anything scrollable and where
 * the instant ripple is the point.
 */
/**
 * How long a row waits before it looks pressed.
 *
 * FOR ROWS INSIDE A SCROLLER, AND NOTHING ELSE. A finger that lands on a list
 * and then drags is starting a scroll, not a press, and without this delay every
 * such scroll begins with the row under the thumb flashing. 100ms is not a
 * guess: it is Android's own tap timeout, which is what the platform's lists
 * use for exactly this.
 *
 * On anything that is NOT a scroll child -- a floating button, a header
 * control, the dark backdrop behind a sheet -- there is no scroll to disambiguate
 * from, and the delay is pure latency: you press, and for a tenth of a second
 * the app appears not to have noticed. Use `TAP_DELAY` there.
 */
export const PRESS_DELAY = 100;

/**
 * No delay at all, for controls that cannot be confused with a scroll.
 *
 * Named rather than left out so that the absence is visibly deliberate, and so
 * the two cases read differently at a glance.
 */
export const TAP_DELAY = 0;

export const NAV_CLEARANCE = 24;

/** The bottom padding a sheet should use, given whatever the insets claim. */
export const clearNav = (insetBottom: number): number =>
  Math.max(insetBottom, NAV_CLEARANCE);

export const HIT = 48;

/** The primary actions live in the lower third, within one thumb's reach. */
export const THUMB_ZONE_BOTTOM = 96;

/**
 * How the app picks between the two palettes.
 *
 * Per device on purpose: the phone is used in bed with the lights off far more
 * than the PC ever is, so forcing dark there while the desk follows the system
 * is a legitimate combination rather than a disagreement to reconcile.
 */
export type ThemeMode = 'system' | 'light' | 'dark';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** `scheme` is whatever the OS reports, which is not always one of the two. */
export function resolvePalette(mode: ThemeMode, scheme: string | null | undefined): Palette {
  if (mode === 'light') return light;
  if (mode === 'dark') return dark;
  // Undecided reads as dark, matching the value this app has always defaulted to.
  return scheme === 'light' ? light : dark;
}
