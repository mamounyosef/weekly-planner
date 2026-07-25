// Universal Event Card Color & Style Rendering for all planner items (Google & Native).

export type EventCardStyle = 'tinted' | 'solid' | 'minimal' | 'glowing';

export interface ChipColors {
  bg: string;
  border: string;
  text: string;
  /**
   * Secondary text (the time / duration line). Derived from `text` and the fill
   * so it stays legible on every card — a flat low opacity washed out badly on
   * lighter fills, which is exactly where the times were hardest to read.
   */
  textMuted: string;
  boxShadow?: string;
  accentBar?: string;
}

/**
 * The named swatches, as the single hue each one is built from. An event stores
 * either one of these names, a raw `#rrggbb` (custom colour), or nothing at all
 * with a `gCalHex` from Google — `resolveEventHex` collapses all three to a hex.
 */
export const SWATCH_BASE_HEX: Record<string, string> = {
  sage:     '#22c55e',
  peach:    '#f97316',
  blue:     '#3b82f6',
  sand:     '#eab308',
  lilac:    '#a855f7',
  rose:     '#f43f5e',
  teal:     '#14b8a6',
  lavender: '#6366f1',
  emerald:  '#10b981',
  coral:    '#ef4444',
};

export const FALLBACK_EVENT_HEX = SWATCH_BASE_HEX.sage;

/**
 * The hue an event should be drawn in.
 *
 * An explicitly chosen custom colour wins. Otherwise a Google event wears the
 * exact colour Google gives it, and everything else maps its swatch name through
 * the table above. Never returns a bare swatch name — passing one of those to the
 * chip builder is what used to leave side-window cards stuck on pale green.
 */
export function resolveEventHex(ev: { color?: string; gCalHex?: string }): string {
  const c = ev.color;
  if (c && c.startsWith('#')) return c;
  if (ev.gCalHex) return ev.gCalHex;
  return (c && SWATCH_BASE_HEX[c]) || FALLBACK_EVENT_HEX;
}

interface RGB { r: number; g: number; b: number }

function parseHex(hex: string): RGB | null {
  const s = hex.trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

const toHex = ({ r, g, b }: RGB) =>
  '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** Blend `c` toward `target` by `amount` (0 = unchanged, 1 = fully target). */
function mix(c: RGB, target: RGB, amount: number): RGB {
  return {
    r: c.r + (target.r - c.r) * amount,
    g: c.g + (target.g - c.g) * amount,
    b: c.b + (target.b - c.b) * amount,
  };
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };

/** Perceived brightness, 0–1. Used to pick readable text on a solid fill. */
function luminance({ r, g, b }: RGB): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Secondary text: the primary colour pulled a little toward the fill. Bounded so
 * it never fades far enough to lose contrast against the card.
 */
function mutedOn(text: RGB, fill: RGB): string {
  return toHex(mix(text, fill, 0.3));
}

/**
 * Build chip styling for any event color (preset hex, custom RGB, or Google Calendar hex).
 * Supports 4 universal card styles:
 * - 'tinted': Glassmorphic translucent fill + vivid border stroke
 * - 'solid': Smooth matte solid fill with refined, non-glaring saturation & high-contrast text
 * - 'minimal': Clean surface card with a vivid left vertical accent bar
 * - 'glowing': Luminous neon stroke + subtle ambient backlight shadow
 */
export function gcalChipColors(
  hex: string | undefined,
  opts: { dark: boolean; style: EventCardStyle; pageBg?: string }
): ChipColors | null {
  if (!hex) return null;
  const rgb = parseHex(hex);
  if (!rgb) return null;

  const { dark, style } = opts;

  // How far a dark-mode fill is pushed toward black. Fixed at ~80% this works on
  // a near-black page, but on the lighter dark themes it makes cards *darker*
  // than the page they sit on, so they sink instead of lifting. Ease the mix back
  // as the page gets lighter.
  const pageLum = dark ? luminance(parseHex(opts.pageBg || '#000000') ?? BLACK) : 0;
  const lift = Math.min(0.26, pageLum * 1.7);

  if (style === 'solid') {
    // Smoother, balanced solid fill — avoids harsh glaring saturation by blending with soft dark matte in dark mode
    const fill = dark ? mix(rgb, BLACK, Math.max(0.26, 0.48 - lift)) : mix(rgb, WHITE, 0.24);
    const bdr = dark ? mix(rgb, BLACK, 0.32) : mix(rgb, WHITE, 0.12);
    // Contrast is decided by the fill, not by the theme: a pale Google colour can
    // produce a light card even in dark mode, and white-on-pale is unreadable.
    const onLight = luminance(fill) > 0.55;
    const textRgb = onLight ? { r: 15, g: 23, b: 42 } : { r: 255, g: 255, b: 255 };
    return {
      bg: toHex(fill),
      border: toHex(bdr),
      text: toHex(textRgb),
      textMuted: mutedOn(textRgb, fill),
      boxShadow: dark ? '0 1px 5px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.08)',
    };
  }

  if (style === 'minimal') {
    return {
      bg: dark ? `rgba(255, 255, 255, ${(0.05 + pageLum * 0.25).toFixed(3)})` : '#ffffff',
      border: dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.10)',
      text: dark ? '#f1f5f9' : '#0f172a',
      textMuted: dark ? '#9aa5b4' : '#4a5568',
      accentBar: toHex(rgb),
    };
  }

  if (style === 'glowing') {
    return {
      bg: dark ? toHex(mix(rgb, BLACK, Math.max(0.58, 0.84 - lift))) : toHex(mix(rgb, WHITE, 0.88)),
      border: toHex(rgb),
      text: dark ? toHex(mix(rgb, WHITE, 0.38)) : toHex(mix(rgb, BLACK, 0.55)),
      textMuted: dark ? toHex(mix(rgb, WHITE, 0.18)) : toHex(mix(rgb, BLACK, 0.38)),
      boxShadow: dark ? `0 0 12px ${toHex(rgb)}45` : `0 0 8px ${toHex(rgb)}25`,
    };
  }

  // Default 'tinted' (Glass & Border Accent)
  if (!dark) {
    return {
      bg: toHex(mix(rgb, WHITE, 0.84)),
      border: toHex(mix(rgb, WHITE, 0.35)),
      text: toHex(mix(rgb, BLACK, 0.55)),
      textMuted: toHex(mix(rgb, BLACK, 0.34)),
    };
  }

  return {
    bg: toHex(mix(rgb, BLACK, Math.max(0.54, 0.80 - lift))),
    border: toHex(rgb),
    text: toHex(mix(rgb, WHITE, 0.35)),
    textMuted: toHex(mix(rgb, WHITE, 0.1)),
  };
}
