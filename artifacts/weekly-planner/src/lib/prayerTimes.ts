// ─── Prayer times ───────────────────────────────────────────────────────────
// Prayer times are NOT planner events. They have a start instant and no
// duration, they are never dragged, resized, recurred or synced to Google — so
// keeping them out of the events store keeps that store (and the Google sync
// engine) exactly as it was. They are derived from a cached monthly calendar
// fetched from the Aladhan API through the dev server (`/api/prayer-times`),
// and the only user-owned state is which ones are ticked off
// (`/api/prayer-done`).
//
// Source: https://aladhan.com/prayer-times-api — keyless, free, and backed by
// the official calculation authorities (method ids below match theirs exactly).

export type PrayerKey = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

/** Chronological order. Sunrise sits between Fajr and Dhuhr and is optional. */
export const PRAYER_KEYS: PrayerKey[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

export const PRAYER_LABELS: Record<PrayerKey, string> = {
  fajr: 'Fajr',
  sunrise: 'Sunrise',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

export const PRAYER_ARABIC: Record<PrayerKey, string> = {
  fajr: 'الفجر',
  sunrise: 'الشروق',
  dhuhr: 'الظهر',
  asr: 'العصر',
  maghrib: 'المغرب',
  isha: 'العشاء',
};

/** The key Aladhan uses in its `timings` object for each of ours. */
const ALADHAN_FIELD: Record<PrayerKey, string> = {
  fajr: 'Fajr',
  sunrise: 'Sunrise',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

/**
 * Calculation authorities, straight from `GET api.aladhan.com/v1/methods`.
 * Which one you pick is the single biggest factor in matching your local
 * mosque — the same coordinates can differ by ~20 minutes between methods.
 */
export const PRAYER_METHODS: Array<{ id: number; label: string }> = [
  { id: 23, label: 'Ministry of Awqaf, Jordan' },
  { id: 5,  label: 'Egyptian General Authority of Survey' },
  { id: 4,  label: 'Umm Al-Qura University, Makkah' },
  { id: 3,  label: 'Muslim World League' },
  { id: 2,  label: 'Islamic Society of North America (ISNA)' },
  { id: 1,  label: 'University of Islamic Sciences, Karachi' },
  { id: 8,  label: 'Gulf Region' },
  { id: 9,  label: 'Kuwait' },
  { id: 10, label: 'Qatar' },
  { id: 16, label: 'Dubai' },
  { id: 11, label: 'Majlis Ugama Islam Singapura' },
  { id: 12, label: 'Union des Organisations Islamiques de France' },
  { id: 13, label: 'Diyanet İşleri Başkanlığı, Turkey' },
  { id: 14, label: 'Spiritual Administration of Muslims of Russia' },
  { id: 15, label: 'Moonsighting Committee Worldwide' },
  { id: 17, label: 'Jabatan Kemajuan Islam Malaysia (JAKIM)' },
  { id: 18, label: 'Tunisia' },
  { id: 19, label: 'Algeria' },
  { id: 20, label: 'Kementerian Agama Republik Indonesia' },
  { id: 21, label: 'Morocco' },
  { id: 22, label: 'Comunidade Islâmica de Lisboa' },
  { id: 7,  label: 'Institute of Geophysics, University of Tehran' },
  { id: 0,  label: 'Shia Ithna-Ashari, Leva Institute, Qum' },
];

/** 0 = Standard (Shafi/Maliki/Hanbali), 1 = Hanafi — Asr shadow ratio. */
export type PrayerSchool = 0 | 1;

/** How a prayer is drawn on the calendar grid. */
export type PrayerStyle = 'marker' | 'pill' | 'row';

export interface PrayerSettings {
  enabled: boolean;
  city: string;
  country: string;
  method: number;
  school: PrayerSchool;
  /** Sunrise is not a prayer — off by default, on for people who want it. */
  showSunrise: boolean;
  /** Prayers switched off individually in settings. */
  hidden: PrayerKey[];
  style: PrayerStyle;
  color: string;             // '#rrggbb' — one colour for all prayers
  showInWidget: boolean;
  /** Per-prayer manual correction in minutes, for matching a local mosque. */
  offsets: Partial<Record<PrayerKey, number>>;
  /** Stop drawing prayers more than this many days into the future. */
  horizonDays: number;
}

export const DEFAULT_PRAYER_SETTINGS: PrayerSettings = {
  enabled: true,
  city: 'Amman',
  country: 'Jordan',
  method: 23,
  school: 0,
  showSunrise: false,
  hidden: [],
  style: 'marker',
  color: '#34d399',
  showInWidget: true,
  offsets: {},
  horizonDays: 30,
};

export const PRAYER_HORIZON_MIN = 1;
export const PRAYER_HORIZON_MAX = 365;

export function coercePrayerSettings(raw: unknown): PrayerSettings {
  const p: PrayerSettings = { ...DEFAULT_PRAYER_SETTINGS, offsets: {}, hidden: [] };
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Record<string, unknown>;

  if (typeof r.enabled === 'boolean') p.enabled = r.enabled;
  if (typeof r.city === 'string' && r.city.trim()) p.city = r.city.trim();
  if (typeof r.country === 'string' && r.country.trim()) p.country = r.country.trim();
  if (typeof r.method === 'number' && PRAYER_METHODS.some(m => m.id === r.method)) p.method = r.method;
  if (r.school === 0 || r.school === 1) p.school = r.school;
  if (typeof r.showSunrise === 'boolean') p.showSunrise = r.showSunrise;
  if (Array.isArray(r.hidden)) {
    p.hidden = PRAYER_KEYS.filter(k => (r.hidden as unknown[]).includes(k));
  }
  if (r.style === 'marker' || r.style === 'pill' || r.style === 'row') p.style = r.style;
  if (typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)) p.color = r.color;
  if (typeof r.showInWidget === 'boolean') p.showInWidget = r.showInWidget;
  if (r.offsets && typeof r.offsets === 'object') {
    const o = r.offsets as Record<string, unknown>;
    for (const k of PRAYER_KEYS) {
      const v = o[k];
      // Clamped hard: an offset is a nudge to match a local mosque, not a way to
      // move Maghrib to next Tuesday.
      if (typeof v === 'number' && Number.isFinite(v) && v !== 0) {
        p.offsets[k] = Math.max(-60, Math.min(60, Math.round(v)));
      }
    }
  }
  if (typeof r.horizonDays === 'number' && Number.isFinite(r.horizonDays)) {
    p.horizonDays = Math.max(PRAYER_HORIZON_MIN, Math.min(PRAYER_HORIZON_MAX, Math.round(r.horizonDays)));
  }
  return p;
}

/** The identity that decides whether a cached month is still valid. */
export function prayerQueryKey(p: PrayerSettings): string {
  return `${p.city}|${p.country}|${p.method}|${p.school}`;
}

// ─── Time helpers ───────────────────────────────────────────────────────────

/** Aladhan returns `"04:19 (+03)"` — the offset is already applied. */
export function parseAladhanTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function prayerTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minutesToPrayerTime(mins: number): string {
  // Wraps inside the day: an offset must never push Isha onto tomorrow.
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** One prayer on one day, ready to draw. */
export interface PrayerOccurrence {
  key: PrayerKey;
  label: string;
  arabic: string;
  /** 'HH:MM' in local time, offsets already applied. */
  time: string;
  minutes: number;
  dateStr: string;
  /** Stable id for React keys and the done-store. */
  id: string;
}

export type PrayerDayTimes = Partial<Record<PrayerKey, string>>;
/** 'yyyy-MM-dd' → times. */
export type PrayerMonth = Record<string, PrayerDayTimes>;

export function prayerOccId(dateStr: string, key: PrayerKey): string {
  return `${dateStr}::${key}`;
}

/** Extract our six timings out of one Aladhan calendar entry. */
export function timesFromAladhanTimings(timings: Record<string, unknown>): PrayerDayTimes {
  const out: PrayerDayTimes = {};
  for (const key of PRAYER_KEYS) {
    const parsed = parseAladhanTime(timings[ALADHAN_FIELD[key]]);
    if (parsed) out[key] = parsed;
  }
  return out;
}

/**
 * Turn a stored day into what should actually be drawn: hidden prayers removed,
 * Sunrise gated on its own switch, manual offsets applied, sorted by time.
 */
export function buildPrayerDay(
  dateStr: string,
  times: PrayerDayTimes | undefined,
  settings: PrayerSettings,
): PrayerOccurrence[] {
  if (!times) return [];
  const out: PrayerOccurrence[] = [];
  for (const key of PRAYER_KEYS) {
    const base = times[key];
    if (!base) continue;
    if (key === 'sunrise' && !settings.showSunrise) continue;
    if (settings.hidden.includes(key)) continue;
    const rawMinutes = prayerTimeToMinutes(base) + (settings.offsets[key] ?? 0);
    const clampedMinutes = Math.max(0, Math.min(1439, rawMinutes));
    const time = minutesToPrayerTime(clampedMinutes);
    out.push({
      key,
      label: PRAYER_LABELS[key],
      arabic: PRAYER_ARABIC[key],
      time,
      minutes: clampedMinutes,
      dateStr,
      id: prayerOccId(dateStr, key),
    });
  }
  return out.sort((a, b) => a.minutes - b.minutes);
}

/** 'yyyy-MM-dd' for a local Date (never UTC — that shifts the day). */
export function prayerDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whether a date is inside the "next N days" display horizon. */
export function withinPrayerHorizon(dateStr: string, settings: PrayerSettings, today = new Date()): boolean {
  const todayStr = prayerDateKey(today);
  if (dateStr <= todayStr) return true; // the past is history, always shown
  const limit = new Date(today.getFullYear(), today.getMonth(), today.getDate() + settings.horizonDays);
  return dateStr <= prayerDateKey(limit);
}

// ─── Done state ─────────────────────────────────────────────────────────────
// `{ 'yyyy-MM-dd': ['fajr', 'dhuhr'] }` — small, append-mostly, and shared by
// both windows through the dev server exactly like tasks and events are.

export type PrayerDoneMap = Record<string, PrayerKey[]>;

export function coercePrayerDone(raw: unknown): PrayerDoneMap {
  const out: PrayerDoneMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [date, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(keys)) continue;
    const valid = PRAYER_KEYS.filter(k => (keys as unknown[]).includes(k));
    if (valid.length) out[date] = valid;
  }
  return out;
}

export function isPrayerDone(done: PrayerDoneMap, dateStr: string, key: PrayerKey): boolean {
  return !!done[dateStr]?.includes(key);
}

export function togglePrayerDone(done: PrayerDoneMap, dateStr: string, key: PrayerKey): PrayerDoneMap {
  const current = done[dateStr] ?? [];
  const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
  const out = { ...done };
  if (next.length) out[dateStr] = PRAYER_KEYS.filter(k => next.includes(k));
  else delete out[dateStr];
  return out;
}

// ─── Fetching ───────────────────────────────────────────────────────────────

export interface PrayerMonthResponse {
  days: PrayerMonth;
  fetchedAt: number;
  /** True when the server had to serve an old cache (API unreachable). */
  stale?: boolean;
  error?: string;
}

export function prayerMonthUrl(settings: PrayerSettings, year: number, month: number): string {
  const q = new URLSearchParams({
    city: settings.city,
    country: settings.country,
    method: String(settings.method),
    school: String(settings.school),
    year: String(year),
    month: String(month),
  });
  return `/api/prayer-times?${q.toString()}`;
}

/** Months (as `YYYY-M`) that a set of visible dates needs loaded. */
export function monthsForDates(dates: Date[]): string[] {
  const seen = new Set<string>();
  for (const d of dates) seen.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
  return [...seen];
}
