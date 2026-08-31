// ─── Prayer settings, as a thing you can edit ────────────────────────────────
// `prayerTimes.ts` answers "what are today's times". This module answers the
// questions an EDITOR has to answer, and it exists because the phone now edits
// the same settings the PC does.
//
// WHY A SECOND MODULE INSTEAD OF MORE OF THE FIRST
// `coercePrayerSettings` reads a record off disk: anything it cannot understand
// becomes the app default. That is exactly right for loading, and exactly wrong
// for editing. Clear the city field on the phone and a loader would hand back
// "Amman", silently undoing a change the user is halfway through making. An
// editor needs the OTHER fallback: keep what was already there. So everything
// here takes the current settings as the floor rather than the defaults.
//
// THREE JOBS, AND WHY EACH IS PURE
//   1. Normalising a patch, so a half-typed city or a fat-fingered offset can
//      never reach the shared settings record and travel to the PC.
//   2. Deciding whether a cached month still describes the current settings.
//      The Aladhan cache is keyed by city, country, method and school, so
//      changing any one of them does not make the cache WRONG, it makes it
//      about somewhere else. Nothing is invalidated or deleted; the lookup
//      simply stops matching, and the new key has to be filled. Getting this
//      wrong shows yesterday's Fajr for the city you just left.
//   3. Saying what a configuration is, in a sentence. Both devices show the
//      same summary, so it is written once and tested once.
//
// CACHE PARITY IS NOT OPTIONAL. The staleness rule below is the dev server's
// rule (`/api/prayer-times` in `vite.config.ts`), copied deliberately. The two
// machines write into the SAME cache through sync, so a phone that thought a
// month went stale in an hour would refetch a month the PC considers current
// and burn API calls forever.

import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_HORIZON_MAX,
  PRAYER_HORIZON_MIN,
  PRAYER_KEYS,
  PRAYER_LABELS,
  PRAYER_METHODS,
  parseAladhanTime,
  prayerQueryKey,
  type PrayerDayTimes,
  type PrayerKey,
  type PrayerSchool,
  type PrayerSettings,
  type PrayerStyle,
} from './prayerTimes';

/**
 * How far a prayer may be nudged by hand.
 *
 * The same ±60 the loader clamps to, named here because the editor draws a
 * stepper whose ends have to agree with the value that will survive the write.
 */
export const PRAYER_OFFSET_LIMIT = 60;

/** The Asr shadow ratios, in the order the segmented control shows them. */
export const PRAYER_SCHOOLS: Array<{ id: PrayerSchool; label: string; hint: string }> = [
  { id: 0, label: 'Standard', hint: 'Shafi, Maliki and Hanbali' },
  { id: 1, label: 'Hanafi', hint: 'Asr about 30 to 60 minutes later' },
];

/** How a prayer is drawn on the PC's grid. Set here, honoured there. */
export const PRAYER_STYLES: Array<{ id: PrayerStyle; label: string; hint: string }> = [
  { id: 'marker', label: 'Marker line', hint: 'A hairline at the exact time. Never collides with an event.' },
  { id: 'pill', label: 'Small pill', hint: 'A compact chip on the timeline. More visible, can overlap.' },
  { id: 'row', label: 'Its own row', hint: 'A strip above the grid, out of the timeline entirely.' },
];

/** The eight the PC offers. Kept identical so a colour set here is nameable there. */
export const PRAYER_COLOURS = [
  '#34d399', '#4ade80', '#22d3ee', '#a78bfa',
  '#f59e0b', '#f472b6', '#e2e8f0', '#94a3b8',
] as const;

// ─── Normalising ─────────────────────────────────────────────────────────────

/**
 * Read a settings record, falling back to `fallback` rather than to the app
 * defaults for anything unusable.
 *
 * Field by field on purpose. Every rule matches `coercePrayerSettings`, with
 * two canonicalisations added that the loader has no reason to care about but
 * an editor does:
 *
 *   • An offset that ROUNDS to zero is dropped, not stored as zero. The loader
 *     tests `v !== 0` before rounding, so a stray 0.4 survives as a stored 0 and
 *     the next pass drops it. That makes normalising twice differ from
 *     normalising once, which in a per-field sync is a spurious op: the phone
 *     writes `offsets`, the PC writes it back canonical, and the field ping
 *     pongs between two devices that agree.
 *
 *   • Sunrise never appears in `hidden`. Sunrise has its own switch, so a record
 *     holding both controls says the same thing twice and the two can disagree.
 *     It is resolved towards HIDDEN, because that is what a record listing it in
 *     `hidden` was asking for, and the redundant entry is then dropped.
 */
export function normalisePrayerSettings(
  raw: unknown,
  fallback: PrayerSettings = DEFAULT_PRAYER_SETTINGS,
): PrayerSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const enabled = typeof r.enabled === 'boolean' ? r.enabled : fallback.enabled;
  // A blank city is a field being cleared before it is retyped, never an answer.
  const city = typeof r.city === 'string' && r.city.trim() ? r.city.trim() : fallback.city;
  const country = typeof r.country === 'string' && r.country.trim() ? r.country.trim() : fallback.country;
  const method = typeof r.method === 'number' && PRAYER_METHODS.some(m => m.id === r.method)
    ? r.method
    : fallback.method;
  const school: PrayerSchool = r.school === 0 || r.school === 1 ? r.school : fallback.school;
  const style: PrayerStyle = r.style === 'marker' || r.style === 'pill' || r.style === 'row'
    ? r.style
    : fallback.style;
  // Lower cased so two records that mean the same colour compare equal, which
  // is what stops a cosmetic difference from becoming a sync op.
  const color = typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color)
    ? r.color.toLowerCase()
    : fallback.color;
  const showInWidget = typeof r.showInWidget === 'boolean' ? r.showInWidget : fallback.showInWidget;

  let showSunrise = typeof r.showSunrise === 'boolean' ? r.showSunrise : fallback.showSunrise;
  // Filtering over PRAYER_KEYS rather than over the input also sorts the list
  // into prayer order and drops anything that is not a prayer at all.
  let hidden = Array.isArray(r.hidden)
    ? PRAYER_KEYS.filter(k => (r.hidden as unknown[]).includes(k))
    : PRAYER_KEYS.filter(k => fallback.hidden.includes(k));
  if (hidden.includes('sunrise')) {
    showSunrise = false;
    hidden = hidden.filter(k => k !== 'sunrise');
  }

  const offsetSource = r.offsets && typeof r.offsets === 'object'
    ? (r.offsets as Record<string, unknown>)
    : (fallback.offsets as Record<string, unknown>);
  const offsets: Partial<Record<PrayerKey, number>> = {};
  for (const k of PRAYER_KEYS) {
    const v = offsetSource[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const clamped = Math.max(-PRAYER_OFFSET_LIMIT, Math.min(PRAYER_OFFSET_LIMIT, Math.round(v)));
    if (clamped !== 0) offsets[k] = clamped;
  }

  const horizonDays = typeof r.horizonDays === 'number' && Number.isFinite(r.horizonDays)
    ? Math.max(PRAYER_HORIZON_MIN, Math.min(PRAYER_HORIZON_MAX, Math.round(r.horizonDays)))
    : fallback.horizonDays;

  return {
    enabled, city, country, method, school, showSunrise, hidden,
    style, color, showInWidget, offsets, horizonDays,
  };
}

/**
 * Apply one change on top of what is already stored.
 *
 * `undefined` in a patch means "no opinion", never "clear it", because that is
 * how a partial object from a form arrives. Clearing is expressed by the value
 * that means empty for that field: an empty `hidden` array, a zero offset.
 */
export function applyPrayerPatch(current: unknown, patch: Partial<PrayerSettings>): PrayerSettings {
  const base = normalisePrayerSettings(current);
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined) merged[k] = v;
  }
  return normalisePrayerSettings(merged, base);
}

/**
 * Set one prayer's manual correction.
 *
 * Its own function because "zero means remove the key" is a rule the editor
 * would otherwise have to restate at every call site, and a stored zero is the
 * exact thing the normaliser has to keep undoing.
 */
export function withPrayerOffset(
  current: PrayerSettings, key: PrayerKey, minutes: number,
): PrayerSettings {
  const offsets: Partial<Record<PrayerKey, number>> = { ...current.offsets };
  delete offsets[key];
  return applyPrayerPatch(current, { offsets: { ...offsets, [key]: minutes } });
}

/**
 * Show or hide one prayer.
 *
 * Sunrise is not in `hidden` and never will be, so the switch it actually owns
 * is flipped instead. Keeping that decision here means the row on the phone and
 * the chip on the PC cannot drift apart on it.
 */
export function withPrayerVisible(
  current: PrayerSettings, key: PrayerKey, visible: boolean,
): PrayerSettings {
  if (key === 'sunrise') return applyPrayerPatch(current, { showSunrise: visible });
  const hidden = visible
    ? current.hidden.filter(k => k !== key)
    : [...current.hidden, key];
  return applyPrayerPatch(current, { hidden });
}

/** Whether a prayer will be drawn, taking Sunrise's separate switch into account. */
export function isPrayerVisible(settings: PrayerSettings, key: PrayerKey): boolean {
  if (key === 'sunrise') return settings.showSunrise;
  return !settings.hidden.includes(key);
}

/**
 * The record to write back into shared settings.
 *
 * The raw object underneath, then the normalised view on top. A field this
 * build has never heard of (something a newer PC added) survives a phone edit
 * instead of being quietly deleted by a device that simply did not model it.
 */
export function writablePrayerRecord(raw: unknown, next: PrayerSettings): Record<string, unknown> {
  const base = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { ...base, ...next };
}

// ─── The month cache ─────────────────────────────────────────────────────────

/**
 * How long a cached month is trusted.
 *
 * The current month is refetched daily because published times drift by a
 * minute or two as the month goes on. Any other month is fixed by astronomy, so
 * a month is kept for thirty days purely to pick up a corrected calculation
 * rather than because it is expected to change. Both numbers are the dev
 * server's, and must stay that way: the two devices share one cache.
 */
export const PRAYER_MONTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PRAYER_MONTH_ARCHIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type PrayerMonthState = 'fresh' | 'stale' | 'missing';

/** One month as it sits in the shared `prayerTimes` store. */
export interface CachedPrayerMonth {
  fetchedAt?: unknown;
  days?: unknown;
}

/**
 * The cache key for one month of one configuration.
 *
 * Month is NOT zero padded. That is the dev server's format and therefore the
 * format already on disk, so padding it here would silently start a second,
 * parallel cache that never hits.
 */
export function prayerMonthKey(settings: PrayerSettings, year: number, month: number): string {
  return `${prayerQueryKey(settings)}|${year}-${month}`;
}

/** The days out of a cache entry, with anything unparseable dropped. */
export function readCachedDays(entry: unknown): Record<string, PrayerDayTimes> {
  const days = (entry as CachedPrayerMonth | undefined)?.days;
  if (!days || typeof days !== 'object') return {};
  const out: Record<string, PrayerDayTimes> = {};
  for (const [date, times] of Object.entries(days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !times || typeof times !== 'object') continue;
    const picked: PrayerDayTimes = {};
    for (const k of PRAYER_KEYS) {
      const parsed = parseAladhanTime((times as Record<string, unknown>)[k]);
      if (parsed) picked[k] = parsed;
    }
    if (Object.keys(picked).length) out[date] = picked;
  }
  return out;
}

function fetchedAtOf(entry: unknown): number | null {
  const at = (entry as CachedPrayerMonth | undefined)?.fetchedAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Is this entry still trusted for this month?
 *
 * An entry with days but no timestamp counts as stale rather than missing: the
 * times are still worth showing, they simply cannot be vouched for, so it is
 * refetched when there is signal and used when there is not.
 */
export function prayerMonthState(
  entry: unknown, year: number, month: number, now: Date = new Date(),
): PrayerMonthState {
  if (!entry || typeof entry !== 'object') return 'missing';
  if (Object.keys(readCachedDays(entry)).length === 0) return 'missing';
  const at = fetchedAtOf(entry);
  if (at === null) return 'stale';
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const maxAge = isCurrentMonth ? PRAYER_MONTH_MAX_AGE_MS : PRAYER_MONTH_ARCHIVE_MAX_AGE_MS;
  const age = now.getTime() - at;
  // A timestamp in the future is a clock that disagrees, not a fresh fetch.
  if (age < 0) return 'stale';
  return age < maxAge ? 'fresh' : 'stale';
}

export interface PrayerMonthLookup {
  /** The key this configuration is asking for. */
  key: string;
  /** The state of the entry stored under exactly that key. */
  state: PrayerMonthState;
  /** Where the days being handed back actually came from. */
  source: 'exact' | 'other' | 'none';
  days: Record<string, PrayerDayTimes>;
  fetchedAt: number | null;
  /** The key the fallback days came from, when `source` is 'other'. */
  fallbackKey: string | null;
}

/**
 * Find a month, and never come back empty handed if anything at all is known.
 *
 * A change of city, country, method or school changes the key, so the new key
 * has nothing behind it and `state` is 'missing' the instant the setting is
 * saved. That is the correct answer, but on its own it means an empty screen at
 * the exact moment the user is looking to see what their change did. So the
 * most recently fetched entry for the SAME month under any other configuration
 * is offered as well, clearly marked as belonging to a different one. A caller
 * refetches on `state`, and draws on `source`.
 */
export function lookupPrayerMonth(
  cache: Record<string, unknown> | null | undefined,
  settings: PrayerSettings,
  year: number,
  month: number,
  now: Date = new Date(),
): PrayerMonthLookup {
  const key = prayerMonthKey(settings, year, month);
  const exact = cache?.[key];
  const state = prayerMonthState(exact, year, month, now);

  if (state !== 'missing') {
    return {
      key, state, source: 'exact',
      days: readCachedDays(exact),
      fetchedAt: fetchedAtOf(exact),
      fallbackKey: null,
    };
  }

  // Only entries for the same month qualify: showing August's Fajr in September
  // would be wrong in a way nobody would think to check.
  const suffix = `|${year}-${month}`;
  let bestKey: string | null = null;
  let bestAt = -Infinity;
  for (const [k, entry] of Object.entries(cache ?? {})) {
    if (k === key || !k.endsWith(suffix)) continue;
    if (Object.keys(readCachedDays(entry)).length === 0) continue;
    const at = fetchedAtOf(entry) ?? 0;
    if (at > bestAt) { bestAt = at; bestKey = k; }
  }

  if (bestKey === null) {
    return { key, state, source: 'none', days: {}, fetchedAt: null, fallbackKey: null };
  }
  return {
    key, state, source: 'other',
    days: readCachedDays(cache?.[bestKey]),
    fetchedAt: fetchedAtOf(cache?.[bestKey]),
    fallbackKey: bestKey,
  };
}

// ─── Talking to Aladhan directly ─────────────────────────────────────────────
// The PC goes through its own dev server, which caches for both devices. The
// phone cannot: the setting it just changed has no cached month anywhere yet,
// and the whole point of an offline first app is not telling someone to go and
// open their PC. So the phone fetches the month itself and writes it into the
// same shared cache, which is why the parsing below has to produce byte for
// byte what the server produces.

export function aladhanCalendarUrl(settings: PrayerSettings, year: number, month: number): string {
  return `https://api.aladhan.com/v1/calendarByCity/${year}/${month}`
    + `?city=${encodeURIComponent(settings.city)}`
    + `&country=${encodeURIComponent(settings.country)}`
    + `&method=${settings.method}`
    + `&school=${settings.school}`;
}

/**
 * Turn one Aladhan calendar reply into cache days.
 *
 * Returns `{}` rather than throwing on anything unexpected, so a caller has one
 * failure to handle instead of two. Dates arrive as "01-08-2026", day first,
 * which is the single most likely thing to get silently backwards.
 */
export function parseAladhanCalendar(json: unknown): Record<string, PrayerDayTimes> {
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return {};
  const out: Record<string, PrayerDayTimes> = {};
  for (const row of rows) {
    const gregorian = (row as any)?.date?.gregorian?.date;
    const m = typeof gregorian === 'string' ? gregorian.match(/^(\d{2})-(\d{2})-(\d{4})$/) : null;
    if (!m) continue;
    const dateStr = `${m[3]}-${m[2]}-${m[1]}`;
    const timings = (row as any)?.timings;
    if (!timings || typeof timings !== 'object') continue;
    const picked: PrayerDayTimes = {};
    for (const k of PRAYER_KEYS) {
      const field = k.charAt(0).toUpperCase() + k.slice(1);
      const parsed = parseAladhanTime((timings as Record<string, unknown>)[field]);
      if (parsed) picked[k] = parsed;
    }
    if (Object.keys(picked).length) out[dateStr] = picked;
  }
  return out;
}

// ─── Saying what is set ──────────────────────────────────────────────────────

export function prayerMethodLabel(method: number): string {
  return PRAYER_METHODS.find(m => m.id === method)?.label ?? `Method ${method}`;
}

export function prayerSchoolLabel(school: PrayerSchool): string {
  return PRAYER_SCHOOLS.find(s => s.id === school)?.label ?? 'Standard';
}

/** One line naming the configuration, for a settings row and for the header. */
export function describePrayerConfig(settings: PrayerSettings): string {
  return `${settings.city}, ${settings.country} · ${prayerMethodLabel(settings.method)}`
    + ` · ${prayerSchoolLabel(settings.school)} Asr`;
}

/** "5 minutes later", "2 minutes earlier", "on the calculated time". */
export function describeOffset(minutes: number): string {
  if (!Number.isFinite(minutes) || Math.round(minutes) === 0) return 'On the calculated time';
  const n = Math.round(minutes);
  const unit = Math.abs(n) === 1 ? 'minute' : 'minutes';
  return n > 0 ? `${n} ${unit} later` : `${Math.abs(n)} ${unit} earlier`;
}

/**
 * What is being shown, as a sentence.
 *
 * Names the hidden ones rather than counting them, because "Fajr is hidden" is
 * the thing worth noticing and "4 of 5 shown" is not.
 */
export function describePrayerVisibility(settings: PrayerSettings): string {
  const prayers = PRAYER_KEYS.filter(k => k !== 'sunrise');
  const hidden = prayers.filter(k => settings.hidden.includes(k));
  const sunrise = settings.showSunrise ? ', with Sunrise' : '';

  if (hidden.length === prayers.length) {
    return settings.showSunrise
      ? 'Every prayer is hidden. Only Sunrise is shown.'
      : 'Every prayer is hidden, so nothing is drawn on the calendar.';
  }
  if (hidden.length === 0) return `All five prayers${sunrise}`;
  const names = hidden.map(k => PRAYER_LABELS[k]);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} hidden${sunrise}`;
}

/**
 * How current the times on screen are, said without alarming anyone.
 *
 * There is no failure worth a red banner here: prayer times from yesterday are
 * within a minute or two of today's, so the honest and useful thing to say is
 * where the numbers came from, not that something went wrong.
 */
export function describePrayerFreshness(lookup: PrayerMonthLookup, now: Date = new Date()): string {
  if (lookup.source === 'none') {
    return 'No times saved for this month yet. They arrive the next time this phone or your PC can reach the internet.';
  }
  if (lookup.source === 'other') {
    return 'Showing the times saved for your previous location while the new ones are fetched.';
  }
  if (lookup.fetchedAt === null) return 'Saved times, of unknown age.';

  const days = Math.floor((now.getTime() - lookup.fetchedAt) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Updated today.';
  if (days === 1) return 'Updated yesterday.';
  if (days < 30) return `Updated ${days} days ago.`;
  return 'Updated more than a month ago.';
}
