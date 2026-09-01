// ─── What a valid view preference is ─────────────────────────────────────────
// The PC and the phone both let you choose how the time grid looks: where the
// visible day begins and ends, how coarsely times snap, how wide the Span view
// is, and whether a sideways swipe changes view. Those choices are DEVICE
// SCOPED (see `deviceSettings.ts` and `settingsScope.ts`) so the two machines
// never overwrite each other's layout.
//
// WHY THIS FILE EXISTS AT ALL
// Device-scoped means the value is stored twice, once per machine, in two
// completely different places: localStorage on the PC and SecureStore on the
// phone. Two stores means two chances to disagree about what "valid" means, and
// a disagreement here is not cosmetic. A stored `dayEndH` of 0 with a
// `dayStartH` of 7 does not throw; it produces a grid with negative height, an
// empty screen, and nothing at all to say why. So the rules live in ONE pure
// module, tested once, and copied to `mobile/src/lib/viewPrefs.ts` exactly the
// way the sync engine is copied.
//
// EVERY FUNCTION HERE TAKES `unknown`. That is deliberate. What comes back from
// a key-value store is a string at best; it can also be null (never written),
// stale JSON from an older build, 'NaN' from a `String(0/0)` that got past a
// setter, or plain rubbish from a half-finished write. None of that may reach
// the grid, and none of it may throw. Clamp, and fall back to something usable.

// ── The visible day ──────────────────────────────────────────────────────────

/**
 * The window is expressed in whole hours from midnight, and it stays inside a
 * single calendar day.
 *
 * The PC allows `dayEndH` up to 48, which is its way of drawing a night shift
 * that runs past midnight. The phone's grid is clamped to 24 by construction,
 * so allowing 25 here would store a value the phone silently ignores, which is
 * worse than not offering it.
 */
export const DAY_HOUR_MIN = 0;
export const DAY_HOUR_MAX = 24;

/** 7am to 11pm: an ordinary waking day, and what the PC ships with. */
export const DEFAULT_DAY_START_HOUR = 7;
export const DEFAULT_DAY_END_HOUR = 23;

export interface DayWindow {
  /** First hour drawn. 0 to 23. */
  start: number;
  /** Hour the grid stops at. Always strictly greater than `start`. 1 to 24. */
  end: number;
}

export const DEFAULT_DAY_WINDOW: DayWindow = {
  start: DEFAULT_DAY_START_HOUR,
  end: DEFAULT_DAY_END_HOUR,
};

/**
 * A finite integer inside [lo, hi], or the fallback.
 *
 * Rejecting rather than rounding a float is the point: 7.5 in a store that only
 * ever holds whole hours means something wrote the wrong kind of value, and the
 * honest answer is the default rather than a plausible-looking 8 that hides it.
 * Booleans, arrays and objects are rejected before `Number` gets to coerce them
 * (`Number(true)` is 1, and `Number([])` is 0, neither of which anyone meant).
 */
export function coerceInt(raw: unknown, fallback: number, lo: number, hi: number): number {
  const n = toFiniteNumber(raw);
  if (n === null) return fallback;
  if (!Number.isInteger(n)) return fallback;
  if (n < lo || n > hi) return fallback;
  return n;
}

/**
 * The same, but out-of-range values are pulled to the nearest edge instead of
 * thrown away.
 *
 * Used where a neighbouring value has already moved and the answer must stay
 * consistent with it, never where a stored value is being read for the first
 * time. Reading is the moment to notice rubbish; clamping it silently would
 * turn a stored 999 into a confident 24.
 */
export function clampInt(raw: unknown, fallback: number, lo: number, hi: number): number {
  const n = toFiniteNumber(raw);
  if (n === null) return fallback;
  const whole = Math.round(n);
  return Math.min(hi, Math.max(lo, whole));
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // '' would become 0 through Number, and an empty stored value means "never
  // written", not "midnight".
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read a stored pair back into a window that is always drawable.
 *
 * The invariant enforced last, after both values are known, is the one that
 * matters: start < end. Two independently stored numbers can be individually
 * valid and jointly useless (start 20, end 6), and nothing upstream guarantees
 * they were written together, because they are not.
 */
export function coerceDayWindow(rawStart: unknown, rawEnd: unknown): DayWindow {
  const start = coerceInt(rawStart, DEFAULT_DAY_START_HOUR, DAY_HOUR_MIN, DAY_HOUR_MAX - 1);
  const end = coerceInt(rawEnd, DEFAULT_DAY_END_HOUR, DAY_HOUR_MIN + 1, DAY_HOUR_MAX);
  return normalizeDayWindow({ start, end });
}

/**
 * Force start < end while moving as little as possible.
 *
 * The END gives way, because the start is what the user scrolls to and notices.
 * Only when the start is at the very top of the range does the start move.
 */
export function normalizeDayWindow(win: DayWindow): DayWindow {
  const start = Math.min(DAY_HOUR_MAX - 1, Math.max(DAY_HOUR_MIN, Math.round(win.start)));
  let end = Math.min(DAY_HOUR_MAX, Math.max(DAY_HOUR_MIN + 1, Math.round(win.end)));
  if (end <= start) end = start + 1;
  return { start, end };
}

/**
 * Move the start, keeping the same number of visible hours where it fits.
 *
 * Dragging the start later should not silently shrink the window: someone
 * moving 7am to 9am wants their whole day shifted, not two hours cut off it.
 * The span is only shortened when it would run past midnight.
 */
export function withDayStart(win: DayWindow, nextStart: unknown): DayWindow {
  const current = normalizeDayWindow(win);
  const start = clampInt(nextStart, current.start, DAY_HOUR_MIN, DAY_HOUR_MAX - 1);
  const span = current.end - current.start;
  return normalizeDayWindow({ start, end: Math.min(DAY_HOUR_MAX, start + span) });
}

/**
 * Move the end. The start follows only if the end has crossed it, which is the
 * other half of "whatever order the user changes them in".
 */
export function withDayEnd(win: DayWindow, nextEnd: unknown): DayWindow {
  const current = normalizeDayWindow(win);
  const end = clampInt(nextEnd, current.end, DAY_HOUR_MIN + 1, DAY_HOUR_MAX);
  const start = Math.min(current.start, end - 1);
  return normalizeDayWindow({ start, end });
}

/** Hours currently drawn. Never zero, never negative, by the invariant above. */
export function dayWindowSpan(win: DayWindow): number {
  const w = normalizeDayWindow(win);
  return w.end - w.start;
}

// ── Saying it in words ───────────────────────────────────────────────────────

export type ClockFormat = '12h' | '24h';

/**
 * One hour as a person would say it.
 *
 * Compact on purpose ("7am", not "7:00 AM"): this goes inside a sentence, and a
 * sentence full of ":00" reads like a log line. 24 is written as midnight
 * rather than "24:00", which is a time no clock has ever shown.
 */
export function formatHour(hour: number, clock: ClockFormat = '12h'): string {
  const h = Math.min(DAY_HOUR_MAX, Math.max(DAY_HOUR_MIN, Math.round(hour)));
  if (clock === '24h') return `${String(h % 24).padStart(2, '0')}:00`;
  if (h === 0 || h === 24) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/**
 * The window as a readable sentence, for the settings screen.
 *
 * The whole reason the preference is worth having is that you can picture the
 * result before you leave the screen, and two spin controls showing 7 and 23
 * do not let you do that.
 *
 * No dashes anywhere in this string: the house rule is that no user-facing text
 * contains an em or en dash, and "7am to 11pm" reads better than a range dash
 * regardless.
 */
export function describeDayWindow(win: DayWindow, clock: ClockFormat = '12h'): string {
  const w = normalizeDayWindow(win);
  const span = w.end - w.start;
  const hours = `${span} hour${span === 1 ? '' : 's'}`;
  return `Showing ${formatHour(w.start, clock)} to ${formatHour(w.end, clock)}, ${hours} on screen.`;
}

// ── The other per-device view preferences ────────────────────────────────────

/**
 * Snap intervals this app understands. The PC offers 5, 15, 30 and 60; the
 * phone adds 10 because a thumb on a small grid lands between the two.
 */
export const SNAP_INTERVALS = [5, 10, 15, 30, 60] as const;
export type SnapInterval = (typeof SNAP_INTERVALS)[number];

/** Thirty minutes, which is what `seedDeviceSettings` gives a new phone. */
export const DEFAULT_SNAP_INTERVAL: SnapInterval = 30;

export function coerceSnapInterval(raw: unknown, fallback: SnapInterval = DEFAULT_SNAP_INTERVAL): SnapInterval {
  const n = toFiniteNumber(raw);
  if (n === null) return fallback;
  return (SNAP_INTERVALS as readonly number[]).includes(n) ? (n as SnapInterval) : fallback;
}

/** How far the Span view may reach either side of the chosen day. */
export const SPAN_DAYS_MIN = 0;
export const SPAN_DAYS_MAX = 6;
export const DEFAULT_SPAN_BEFORE = 1;
export const DEFAULT_SPAN_AFTER = 3;

export interface SpanWindow {
  before: number;
  after: number;
}

export const DEFAULT_SPAN_WINDOW: SpanWindow = {
  before: DEFAULT_SPAN_BEFORE,
  after: DEFAULT_SPAN_AFTER,
};

/**
 * The Span view's width, in days.
 *
 * Clamped rather than rejected, because unlike the hours these two do not have
 * to agree with each other: any pair in range is a usable grid, so the nearest
 * legal value is a better answer than the default.
 */
export function coerceSpanWindow(rawBefore: unknown, rawAfter: unknown): SpanWindow {
  return {
    before: clampInt(rawBefore, DEFAULT_SPAN_BEFORE, SPAN_DAYS_MIN, SPAN_DAYS_MAX),
    after: clampInt(rawAfter, DEFAULT_SPAN_AFTER, SPAN_DAYS_MIN, SPAN_DAYS_MAX),
  };
}

export function spanColumns(win: SpanWindow): number {
  const w = coerceSpanWindow(win.before, win.after);
  return w.before + w.after + 1;
}

/**
 * A stored on/off flag.
 *
 * Written as '1' and '0' rather than 'true' and 'false' so a value truncated by
 * a bad write cannot read as the opposite of what was meant ('t' is not '1',
 * but a half-written 'true' could be anything). Legacy spellings are still
 * accepted on read, because older builds of the phone wrote them.
 */
export const BOOL_TRUE = '1';
export const BOOL_FALSE = '0';

export function encodeBool(value: boolean): string {
  return value ? BOOL_TRUE : BOOL_FALSE;
}

export function coerceBool(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/**
 * Swiping sideways to change view is ON by default, matching the PC's
 * `mobileSwipeViewSwitch`. It is a preference at all because the same gesture
 * is how you scroll a wide grid, and on a narrow phone the two can fight.
 */
export const DEFAULT_SWIPE_VIEW_SWITCH = true;

// ─── How this device draws prayers ───────────────────────────────────────────
// Per device, deliberately, and separate from the prayer settings themselves.
//
// The times are a fact about Amman: the city, the method and the madhab decide
// them, they are the same on every screen, and they are shared. How a prayer is
// DRAWN is not a fact about anything. A green line across a phone's grid and a
// pill on a wide desk monitor are both right, on their own screens, and a phone
// that adopted the desk's answer would be adopting a decision made about a
// different piece of glass. Kept here beside the theme and the snap interval,
// which are per device for exactly the same reason.

/**
 * The three shapes a prayer can take on a grid.
 *
 *  marker  a hairline across the day with a pill sitting in it
 *  pill    a full width bar at that minute, like a very short event
 *  row     out of the grid entirely, into a band above it
 *
 * The same three the desk offers, chosen separately here: the right answer on a
 * 27 inch monitor is not automatically the right one on a phone.
 */
export type PrayerDrawStyle = 'marker' | 'pill' | 'row';

export const PRAYER_DRAW_STYLES: { id: PrayerDrawStyle; label: string; hint: string }[] = [
  { id: 'marker', label: 'Marker line', hint: 'A line across the day with the name sitting in it.' },
  { id: 'pill', label: 'Small pill', hint: 'A short bar at the time, like a very brief event.' },
  { id: 'row', label: 'Its own row', hint: 'Out of the grid, into a band above it.' },
];

export function isPrayerDrawStyle(raw: unknown): raw is PrayerDrawStyle {
  return raw === 'marker' || raw === 'pill' || raw === 'row';
}

export interface PrayerAppearance {
  /** Whether prayers are drawn across the time grids at all. */
  showOnCalendar: boolean;
  /** Which of the three shapes this device draws them in. */
  style: PrayerDrawStyle;
  /** The line and marker colour. */
  colour: string;
  /** Whether the prayer's name is drawn beside its line. */
  showLabels: boolean;
  /** The language the prayer name is drawn in. */
  language: 'english' | 'arabic';
}

export const DEFAULT_PRAYER_APPEARANCE: PrayerAppearance = {
  showOnCalendar: true,
  style: 'marker',
  colour: '#34d399',
  showLabels: true,
  language: 'english',
};

/** A six-digit hex colour, or nothing. Anything else is not a colour. */
export function isHexColour(raw: unknown): raw is string {
  return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw);
}

/**
 * Read stored appearance, tolerating anything.
 *
 * Each field falls back on its own. A corrupt colour must not also cost you the
 * choice to show prayers at all, which is the kind of collateral loss that makes
 * a settings screen feel unreliable.
 */
export function coercePrayerAppearance(raw: unknown): PrayerAppearance {
  const out = { ...DEFAULT_PRAYER_APPEARANCE };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.showOnCalendar === 'boolean') out.showOnCalendar = r.showOnCalendar;
  if (typeof r.showLabels === 'boolean') out.showLabels = r.showLabels;
  if (isPrayerDrawStyle(r.style)) out.style = r.style;
  // Normalised to lower case so two spellings of one colour are one value and
  // cannot ping-pong a stored setting between them.
  if (isHexColour(r.colour)) out.colour = r.colour.toLowerCase();
  if (r.language === 'english' || r.language === 'arabic') out.language = r.language;
  return out;
}

/** What a person reads back on the settings screen. No dashes, ever. */
export function describePrayerAppearance(a: PrayerAppearance): string {
  if (!a.showOnCalendar) return 'Not drawn on this device. The times are still shared.';
  const shape = PRAYER_DRAW_STYLES.find(s => s.id === a.style)?.label ?? 'Marker line';
  const lang = a.language === 'arabic' ? 'in Arabic' : 'in English';
  // The row style has no line to label, so promising a name either way would be
  // describing a setting that does nothing.
  if (a.style === 'row') return `${shape}, above the grid, ${lang}.`;
  return a.showLabels ? `${shape}, with the name ${lang}.` : `${shape}, with no name.`;
}
