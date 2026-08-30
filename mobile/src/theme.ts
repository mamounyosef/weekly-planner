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
  display: { fontSize: 30, lineHeight: 34, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 16, lineHeight: 21, fontWeight: '600' as const, letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, lineHeight: 21, fontWeight: '600' as const },
  caption: { fontSize: 13, lineHeight: 17, fontWeight: '400' as const },
  label: { fontSize: 11, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 1.1 },
  clock: { fontSize: 13, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.2 },
} as const;

/**
 * Touch targets.
 *
 * 48 is Android's accessibility floor and the app holds to it everywhere —
 * a planner is used one-handed, in a hurry, often while walking.
 */
export const HIT = 48;

/** The primary actions live in the lower third, within one thumb's reach. */
export const THUMB_ZONE_BOTTOM = 96;
