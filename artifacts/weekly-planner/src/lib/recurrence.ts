import { format, addDays, addMonths, addYears, differenceInDays, startOfWeek } from 'date-fns';

// ─── Google-style recurrence model ──────────────────────────────────────────
// An item is either NON-REPEATING (no `recur`) or REPEATING (carries a `recur`
// rule, exactly like a Google Calendar event). A repeating item is stored ONCE
// (the "master"); the weekly grid expands it into per-day occurrences on the fly.
//
//   • The master's anchor (first occurrence) is `weekKey` (a week-start date) +
//     `dayIndex` (0–6 within that week) + `startTime`/`endTime` (+ `allDay`/`daysSpan`).
//   • `recur` describes how it repeats. `exdates` lists occurrence dates that were
//     individually removed ("delete just this one").
//
// Edits to a repeating item affect the whole series (it is one item). Deletes are
// scoped: this occurrence (exdate), this-and-following (bound the rule with UNTIL),
// or all (drop the master). This maps 1:1 onto Google's RRULE / EXDATE / delete.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday … 6 = Saturday
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type RecurFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type DeleteMode = 'one' | 'following' | 'all';

export type RecurEnd = { until: string } | { count: number }; // absent = repeats forever

export interface Recurrence {
  freq: RecurFreq;
  interval: number;        // every N units (>= 1)
  byWeekday?: Weekday[];   // weekly only; absent = the anchor's weekday
  end?: RecurEnd;          // absent = never ends
}

// Legacy anchor sentinel kept only so `migrateEvents` can recognise old records.
export const FAR_PAST_WEEK = '0000-01-01';

export interface RecurFields {
  id: string;
  weekKey?: string;   // week-start date of the anchor (first) occurrence
  dayIndex?: number;  // 0–6 within that week
  daysSpan?: number;
  allDay?: boolean;
  startTime?: string;
  endTime?: string;
  deleted?: boolean;  // tombstone awaiting a Google-side delete, then removal
  recur?: Recurrence;
  exdates?: string[]; // 'yyyy-MM-dd' occurrence dates removed individually
  // When true, edits/moves to any occurrence apply to the WHOLE series (they stay
  // identical). When false/absent (the default), editing or moving one occurrence
  // detaches it into a standalone non-repeating item, leaving the rest of the series
  // untouched. Only meaningful on a repeating master.
  locked?: boolean;
  // View-only fields stamped onto expanded occurrences (never persisted):
  masterId?: string;
  occDate?: string;
  // Google sync identity:
  gCalId?: string;
  gCalCalendarId?: string;
  gCalETag?: string;
  gCalRecurSig?: string;
  lastSyncedAt?: number;
  updatedAt?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WD_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

export function weekKeyOf(date: Date, weekStartsOn: WeekStartsOn): string {
  return format(startOfWeek(date, { weekStartsOn }), 'yyyy-MM-dd');
}

export function parseDate(d: string): Date {
  if (!d) return new Date(0);
  const parts = d.split('-');
  if (parts.length < 3) return new Date(0);
  const [y, m, day] = parts.map(Number);
  return new Date(y, m - 1, day);
}

// Helper to calculate the visible dayIndex and daysSpan of an all-day event
// within the viewed week (which starts at weekStart). Returns null if it doesn't overlap.
// `range` (day offsets from `weekStart`, `to` exclusive) defaults to the 7 days of
// the week; the custom view passes its own window, so the returned `dayIndex` is
// relative to `weekStart` and may be negative.
export function getEventWeekOverlap(
  ev: RecurFields,
  weekStart: Date,
  range?: { from: number; to: number },
): { dayIndex: number; daysSpan: number } | null {
  const fromOff = range ? range.from : 0;
  const toOff = range ? range.to : 7;
  const evWeekStart = parseDate(ev.weekKey || '0000-01-01');
  const evStart = addDays(evWeekStart, ev.dayIndex || 0);
  const evEnd = addDays(evStart, Math.max(1, ev.daysSpan || 1));
  const winStart = addDays(weekStart, fromOff);
  const weekEnd = addDays(weekStart, toOff);

  if (evStart >= weekEnd || evEnd <= winStart) {
    return null;
  }

  const startDiff = differenceInDays(evStart, weekStart);
  const visibleDayIndex = Math.max(fromOff, startDiff);

  const endDiff = differenceInDays(evEnd, weekStart);
  const visibleDaysSpan = Math.min(toOff, endDiff) - visibleDayIndex;

  if (visibleDaysSpan <= 0) return null;

  return {
    dayIndex: visibleDayIndex,
    daysSpan: visibleDaysSpan
  };
}

const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');
const anchorOf = (ev: RecurFields): Date => addDays(parseDate(ev.weekKey ?? FAR_PAST_WEEK), ev.dayIndex ?? 0);

// ─── Occurrence expansion ────────────────────────────────────────────────────

// Occurrence START dates of `master` that fall within [rangeStart, rangeEnd).
// Honours interval, weekly BYDAY, end (until/count) and exclusions (exdates).
export function occurrenceStarts(master: RecurFields, rangeStart: Date, rangeEnd: Date): Date[] {
  const anchor = anchorOf(master);
  const r = master.recur;
  if (!r) {
    return anchor < rangeEnd && addDays(anchor, master.daysSpan ?? 1) > rangeStart ? [anchor] : [];
  }

  const interval = Math.max(1, Math.floor(r.interval || 1));
  const until = r.end && 'until' in r.end ? parseDate(r.end.until) : null;
  const count = r.end && 'count' in r.end ? r.end.count : null;
  const ex = master.exdates && master.exdates.length ? new Set(master.exdates) : null;

  const out: Date[] = [];
  let produced = 0; // occurrences generated from the anchor (counts toward `count`)
  const CAP = 8000;

  // Returns false to signal "stop generating".
  const consider = (d: Date): boolean => {
    if (d < anchor) return true;                       // before the series began
    if (until && d > until) return false;
    if (count != null && produced >= count) return false;
    produced++;
    if (d >= rangeStart && d < rangeEnd && !(ex && ex.has(ymd(d)))) out.push(d);
    return true;
  };

  if (r.freq === 'weekly') {
    const byday = (r.byWeekday && r.byWeekday.length ? [...r.byWeekday] : [anchor.getDay() as Weekday]).sort((a, b) => a - b);
    const anchorSunday = addDays(anchor, -anchor.getDay());
    for (let k = 0; k < CAP; k++) {
      const weekSunday = addDays(anchorSunday, k * 7);
      if (k % interval !== 0) continue;
      let stop = false;
      for (const wd of byday) {
        if (!consider(addDays(weekSunday, wd))) { stop = true; break; }
      }
      if (stop) break;
      if (weekSunday >= rangeEnd && count == null && until == null) break;
    }
  } else {
    for (let k = 0; k < CAP; k++) {
      const d = r.freq === 'daily' ? addDays(anchor, k * interval)
        : r.freq === 'monthly' ? addMonths(anchor, k * interval)
        : addYears(anchor, k * interval);
      if (!consider(d)) break;
      if (d >= rangeEnd && count == null && until == null) break;
    }
  }
  return out;
}

// Upgrade any OLD modification-domain records (they carry a `scope` field) to the
// Google-style recur model, in place, on load. Idempotent: once upgraded a record
// has no `scope`, so re-running passes it through. This self-heals if a stale old
// copy is ever written back. Collapses old per-weekday 'all' records into one
// weekly/daily master; old 'week' records become plain non-repeating events; old
// bookkeeping tombstones are dropped (kept only if they still own a Google event).
const MIGRATE_ANCHOR_WEEK = '2025-01-05'; // a Sunday, in-range for occurrence expansion
export function migrateEvents<T extends RecurFields>(raw: Record<string, T>): { events: Record<string, T>; changed: boolean } {
  const anyOld = Object.values(raw).some((e: any) => 'scope' in e || 'seriesId' in e || 'overridesSeriesId' in e);
  if (!anyOld) return { events: raw, changed: false };

  const strip = (o: any): T => { const n = { ...o }; delete n.scope; delete n.seriesId; delete n.overridesSeriesId; delete n.gCalRecurSig; return n as T; };
  const out: Record<string, T> = {};
  const groups = new Map<string, any[]>();

  for (const ev of Object.values(raw) as any[]) {
    if (ev.deleted) {
      if (ev.gCalId) out[ev.id] = strip({ ...ev, deleted: true }); // still needs a Google delete
      continue;
    }
    if (ev.scope === 'all') {
      const key = [ev.content, ev.startTime, ev.endTime, ev.color, !!ev.noCheckbox, !!ev.allDay, ev.daysSpan || 1].join('|');
      const g = groups.get(key); if (g) g.push(ev); else groups.set(key, [ev]);
      continue;
    }
    out[ev.id] = strip({ ...ev, deleted: false });
  }

  const now = Date.now();
  for (const group of groups.values()) {
    const byWeekday = [...new Set(group.map(r => (r.dayIndex || 0) as Weekday))].sort((a, b) => a - b);
    const rep = group.find(r => r.gCalId) || group[0];
    const recur: Recurrence = byWeekday.length >= 7 ? { freq: 'daily', interval: 1 } : { freq: 'weekly', interval: 1, byWeekday };
    out[rep.id] = strip({ ...rep, weekKey: MIGRATE_ANCHOR_WEEK, dayIndex: byWeekday[0], recur, deleted: false, updatedAt: now });
    for (const sib of group) {
      if (sib.id === rep.id) continue;
      if (sib.gCalId) out[sib.id] = strip({ ...sib, deleted: true, updatedAt: now }); // orphan → delete on next sync
    }
  }

  return { events: out, changed: true };
}

// ─── Occurrence ids ──────────────────────────────────────────────────────────
const OCC_SEP = '::';
export function makeOccId(masterId: string, occDate: string): string { return `${masterId}${OCC_SEP}${occDate}`; }
export function parseOccId(id: string): { masterId: string; occDate: string | null } {
  const i = id.indexOf(OCC_SEP);
  return i === -1 ? { masterId: id, occDate: null } : { masterId: id.slice(0, i), occDate: id.slice(i + OCC_SEP.length) };
}

// ─── Resolve one week ─────────────────────────────────────────────────────────
// Expands every stored item into the concrete occurrences visible in the viewed
// week, keyed by occurrence id ("<masterId>::<date>" for repeats, plain id for
// non-repeating items). Each occurrence carries `masterId`/`occDate` so edits and
// deletes can be routed back to the stored master.
// `range` widens/narrows the window to an arbitrary run of days expressed as
// offsets from the week start (default the 7 days of the week itself). The custom
// view uses e.g. { from: -2, to: 5 }; `dayIndex` is always stamped relative to the
// week start, so it can legitimately be negative or >= 7 there.
export function resolveWeek<T extends RecurFields>(
  raw: Record<string, T>,
  viewedWeekKey: string,
  range?: { from: number; to: number },
): Record<string, T> {
  const anchorWeekStart = parseDate(viewedWeekKey);
  const fromOff = range ? range.from : 0;
  const toOff = range ? range.to : 7;
  const weekStart = addDays(anchorWeekStart, fromOff);          // first visible day
  const weekEnd = addDays(anchorWeekStart, toOff);              // one past the last
  // Offsets are stamped against the anchor week start, not the first visible day.
  const stampBase = anchorWeekStart;
  const out: Record<string, T> = {};

  // Safety net: if two stored records ever end up pointing at the SAME Google event
  // (e.g. a foreign event re-pulled under a second id, or a stale merge artifact),
  // they'd render as two identical items stacked in the same slot. Keep only the
  // freshest per gCalId so a duplicate can never reach the grid.
  const freshestByGCal = new Map<string, string>();
  for (const ev of Object.values(raw)) {
    if (ev.deleted || !ev.gCalId || String(ev.id).includes(OCC_SEP)) continue;
    const prevId = freshestByGCal.get(ev.gCalId);
    if (!prevId) { freshestByGCal.set(ev.gCalId, ev.id); continue; }
    const prev = raw[prevId];
    const score = (r: T) => (r.lastSyncedAt ?? 0) + (r.updatedAt ?? 0);
    if (score(ev) >= score(prev)) freshestByGCal.set(ev.gCalId, ev.id);
  }

  for (const master of Object.values(raw)) {
    if (master.deleted) continue;
    // Never treat a leaked occurrence record (id "master::date") as its own master —
    // it carries a copy of `recur` and would re-expand into phantom duplicates.
    if (String(master.id).includes(OCC_SEP)) continue;
    // Drop the shadowed copy of any duplicated Google event (see freshestByGCal).
    if (master.gCalId && freshestByGCal.get(master.gCalId) !== master.id) continue;

    if (!master.recur) {
      // Non-repeating: show if its span overlaps this week (supports multi-day all-day).
      // A TIMED item on the last day of the previous week can run past the day-start
      // boundary into this week's first day, so reach one day back for those and stamp
      // a negative dayIndex — the grid draws them as a spill-in "head" segment.
      const start = anchorOf(master);
      const end = addDays(start, master.daysSpan ?? 1);
      const from = master.allDay ? weekStart : addDays(weekStart, -1);
      if (start < weekEnd && end > from) {
        out[master.id] = master.allDay
          ? { ...master, masterId: master.id, occDate: ymd(start) }
          : { ...master, masterId: master.id, occDate: ymd(start), weekKey: viewedWeekKey, dayIndex: differenceInDays(start, stampBase) };
      }
      continue;
    }

    // Repeating: widen the scan backwards for multi-day all-day spill-in, and by one
    // day for timed items so an overnight occurrence from the previous week's last day
    // still reaches this week's first day.
    const scanStart = master.allDay
      ? addDays(weekStart, -(Math.max(1, master.daysSpan ?? 1) - 1))
      : addDays(weekStart, -1);
    for (const d of occurrenceStarts(master, scanStart, weekEnd)) {
      const occDate = ymd(d);
      const occId = makeOccId(master.id, occDate);
      out[occId] = {
        ...master,
        id: occId,
        masterId: master.id,
        occDate,
        weekKey: viewedWeekKey,
        dayIndex: differenceInDays(d, stampBase), // may be < 0 for spill-in; overlap clips it
      };
    }
  }

  return out;
}

// ─── Anchor normalisation ──────────────────────────────────────────────────
// The custom view addresses days outside the anchor week (dayIndex < 0 or > 6).
// That's fine for rendering, but stored records must always hold a real
// (weekKey, 0–6) pair, so fold any out-of-range offset onto its own week.
export function normalizeAnchor<T extends RecurFields>(item: T, weekStartsOn: WeekStartsOn): T {
  const di = item.dayIndex ?? 0;
  if (di >= 0 && di <= 6) return item;
  const date = addDays(parseDate(item.weekKey ?? FAR_PAST_WEEK), di);
  const ws = startOfWeek(date, { weekStartsOn });
  return { ...item, weekKey: ymd(ws), dayIndex: differenceInDays(date, ws) };
}

// ─── Create ────────────────────────────────────────────────────────────────
// Stamp anchor + timestamp onto a freshly created item (recurrence optional).
export function stampNewItem<T extends RecurFields>(item: T, viewedWeekKey: string, weekStartsOn: WeekStartsOn = 0): T {
  return normalizeAnchor({ ...item, weekKey: item.weekKey ?? viewedWeekKey, deleted: false, updatedAt: Date.now() }, weekStartsOn);
}

// ─── Edit (whole series) ───────────────────────────────────────────────────
// Route a patch on the occurrence shown as `occId` back to its stored master and
// apply it to the whole item. A day-move on a single-weekday weekly item retargets
// its weekday; on other repeats the day component is ignored (time still applies).
// Returns the (possibly new) occurrence id so the UI can re-anchor selection/menu.
export function editSeries<T extends RecurFields>(
  raw: Record<string, T>,
  occId: string,
  patch: Partial<T>,
  viewedWeekKey: string,
  weekStartsOn: WeekStartsOn,
): { events: Record<string, T>; targetId: string } {
  const { masterId, occDate } = parseOccId(occId);
  const master = raw[masterId];
  if (!master) return { events: raw, targetId: occId };

  // Non-repeating: plain in-place edit.
  if (!master.recur) {
    const next = normalizeAnchor({ ...master, ...patch, updatedAt: Date.now() } as T, weekStartsOn);
    return { events: { ...raw, [masterId]: next }, targetId: masterId };
  }

  // Series-level fields (the repeat rule itself, or the lock flag) always apply to
  // the whole master and never detach — they define the series, not one occurrence.
  const seriesLevel = 'recur' in patch || 'locked' in patch;

  // Repeating + LOCKED (or a series-level change) → edit the whole series in place.
  if (master.locked || seriesLevel) {
    return editWholeSeries(raw, master, masterId, occDate, patch, viewedWeekKey, weekStartsOn);
  }

  // Repeating + UNLOCKED (the default) → detach THIS occurrence into a standalone,
  // non-repeating item. The rest of the series is untouched (EXDATE on this date),
  // and the detached item loses its repeat/lock identity — it's a free normal event.
  if (!occDate) {
    // No concrete occurrence date to detach from; fall back to a whole-series edit.
    return editWholeSeries(raw, master, masterId, occDate, patch, viewedWeekKey, weekStartsOn);
  }
  const exdates = master.exdates ?? [];
  const nextExdates = exdates.includes(occDate) ? exdates : [...exdates, occDate];
  const masterNext = { ...master, exdates: nextExdates, updatedAt: Date.now() } as T;

  const targetWeekKey = patch.weekKey ?? viewedWeekKey;
  const weekStart = parseDate(targetWeekKey);
  const occDay = parseDate(occDate);
  const newId = newLocalId();
  const detached = normalizeAnchor({
    ...master,
    id: newId,
    weekKey: targetWeekKey,
    dayIndex: differenceInDays(occDay, weekStart),
    recur: undefined,
    exdates: undefined,
    locked: undefined,
    masterId: undefined,
    occDate: undefined,
    // Fresh Google identity: it becomes its own event on the next sync (the master
    // keeps its own event, now carrying an EXDATE for this date).
    gCalId: undefined,
    gCalCalendarId: undefined,
    gCalETag: undefined,
    gCalRecurSig: undefined,
    lastSyncedAt: undefined,
    deleted: false,
    ...patch, // the actual change (move/time/title/color) lands on the detached item
    updatedAt: Date.now(),
  } as T, weekStartsOn);

  return { events: { ...raw, [masterId]: masterNext, [newId]: detached }, targetId: newId };
}

// Edit a repeating master in place (locked series, or a series-level rule change).
// A day-move relocates the WHOLE series to the new day: weekly shifts every weekday
// by the drag delta; other freqs shift the anchor date. Time edits apply to all.
function editWholeSeries<T extends RecurFields>(
  raw: Record<string, T>,
  master: T,
  masterId: string,
  occDate: string | null,
  patch: Partial<T>,
  viewedWeekKey: string,
  weekStartsOn: WeekStartsOn,
): { events: Record<string, T>; targetId: string } {
  const p: Partial<T> = { ...patch };
  let next = { ...master, updatedAt: Date.now() } as T;
  let newOccDate = occDate;

  if (master.recur && p.dayIndex != null) {
    const targetWeekKey = p.weekKey ?? viewedWeekKey;
    const weekStart = parseDate(targetWeekKey);
    const newDate = addDays(weekStart, p.dayIndex);
    const rec = master.recur;
    const oldDate = occDate ? parseDate(occDate) : anchorOf(master);
    const delta = differenceInDays(newDate, oldDate); // whole days moved

    if (rec.freq === 'weekly') {
      const oldByday = rec.byWeekday && rec.byWeekday.length ? rec.byWeekday : [anchorOf(master).getDay() as Weekday];
      const shift = ((delta % 7) + 7) % 7;
      const newByday = shift === 0
        ? oldByday
        : Array.from(new Set(oldByday.map(w => (((w + shift) % 7) as Weekday)))).sort((a, b) => a - b);
      const newAnchor = addDays(anchorOf(master), delta);
      next = { ...next, recur: { ...rec, byWeekday: newByday }, weekKey: weekKeyOf(newAnchor, weekStartsOn), dayIndex: differenceInDays(newAnchor, startOfWeek(newAnchor, { weekStartsOn })) };
      newOccDate = ymd(newDate);
    } else if (rec.freq === 'daily') {
      // Daily repeats every day — a day-move is meaningless; keep the anchor.
      newOccDate = occDate;
    } else {
      // monthly / yearly → slide the anchor date so the recurring date moves with it.
      const newAnchor = addDays(anchorOf(master), delta);
      next = { ...next, weekKey: weekKeyOf(newAnchor, weekStartsOn), dayIndex: differenceInDays(newAnchor, startOfWeek(newAnchor, { weekStartsOn })) };
      newOccDate = ymd(newDate);
    }
    delete p.dayIndex;
    delete (p as Partial<RecurFields>).weekKey;
  }

  next = normalizeAnchor({ ...next, ...p }, weekStartsOn);
  const events = { ...raw, [masterId]: next };
  const targetId = master.recur ? (newOccDate ? makeOccId(masterId, newOccDate) : masterId) : masterId;
  return { events, targetId };
}

// UUID for a detached occurrence (crypto when available, Math.random fallback).
function newLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Delete (scoped) ──────────────────────────────────────────────────────────
// Non-repeating: drop it (tombstone first if it has a Google id, so the delete
// mirrors to Google before the record is removed on the next sync).
// Repeating: 'one' → exclude this date (EXDATE); 'following' → bound with UNTIL;
// 'all' → drop the master (tombstone if synced).
export function deleteScoped<T extends RecurFields>(raw: Record<string, T>, occId: string, mode: DeleteMode): Record<string, T> {
  const { masterId, occDate } = parseOccId(occId);
  const master = raw[masterId];
  if (!master) return raw;

  const dropOrTombstone = (): Record<string, T> => {
    if (master.gCalId) return { ...raw, [masterId]: { ...master, deleted: true, updatedAt: Date.now() } };
    const n = { ...raw }; delete n[masterId]; return n;
  };

  if (!master.recur) return dropOrTombstone();

  if (mode === 'all') return dropOrTombstone();

  if (mode === 'following') {
    if (!occDate) return dropOrTombstone();
    // Deleting from the anchor onward removes everything → same as 'all'.
    if (occDate <= ymd(anchorOf(master))) return dropOrTombstone();
    const until = ymd(addDays(parseDate(occDate), -1));
    const exdates = (master.exdates ?? []).filter(d => d < occDate);
    return { ...raw, [masterId]: { ...master, recur: { ...master.recur, end: { until } }, exdates, updatedAt: Date.now() } };
  }

  // mode === 'one'
  if (!occDate) return dropOrTombstone();
  const exdates = master.exdates ?? [];
  if (exdates.includes(occDate)) return raw;
  return { ...raw, [masterId]: { ...master, exdates: [...exdates, occDate], updatedAt: Date.now() } };
}

// ─── Google recurrence formatting (RFC 5545) ─────────────────────────────────
// Verified against Google Calendar API + RFC 5545 §3.3.10: the recurrence array
// carries RRULE (+ EXDATE) without DTSTART; start/end fields define the first
// occurrence. Timed UNTIL is UTC (…Z); all-day uses VALUE=DATE. Timed EXDATE uses
// TZID + local wall-clock; all-day EXDATE uses VALUE=DATE.
const two = (n: number) => String(n).padStart(2, '0');
const basicDate = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
const basicUTC = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildGoogleRecurrence(master: RecurFields, tz: string): string[] | undefined {
  const r = master.recur;
  if (!r) return undefined;
  const [sh, sm] = (master.startTime ?? '00:00').split(':').map(Number);
  const allDay = !!master.allDay;

  let rule = `RRULE:FREQ=${r.freq.toUpperCase()};INTERVAL=${Math.max(1, Math.floor(r.interval || 1))}`;
  if (r.freq === 'weekly' && r.byWeekday && r.byWeekday.length) {
    rule += `;BYDAY=${[...r.byWeekday].sort((a, b) => a - b).map(w => WD_CODES[w]).join(',')}`;
  }
  if (r.end && 'count' in r.end) {
    rule += `;COUNT=${r.end.count}`;
  } else if (r.end && 'until' in r.end) {
    const u = parseDate(r.end.until);
    if (allDay) {
      rule += `;UNTIL=${basicDate(u)}`;
    } else {
      const dt = new Date(u); dt.setHours(sh, sm, 0, 0);
      rule += `;UNTIL=${basicUTC(dt)}`;
    }
  }

  const arr = [rule];
  if (master.exdates && master.exdates.length) {
    const ds = [...master.exdates].sort();
    if (allDay) {
      arr.push(`EXDATE;VALUE=DATE:${ds.map(d => basicDate(parseDate(d))).join(',')}`);
    } else {
      arr.push(`EXDATE;TZID=${tz}:${ds.map(d => `${basicDate(parseDate(d))}T${two(sh)}${two(sm)}00`).join(',')}`);
    }
  }
  return arr;
}

// Parse a Google recurrence array back into { recur, exdates } for pull-side sync.
export function parseGoogleRecurrence(recurrence: string[] | undefined): { recur?: Recurrence; exdates?: string[] } {
  if (!recurrence || !recurrence.length) return {};
  let recur: Recurrence | undefined;
  const exdates: string[] = [];
  const codeToWd: Record<string, Weekday> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  for (const line of recurrence) {
    if (line.startsWith('RRULE:')) {
      const parts = Object.fromEntries(line.slice(6).split(';').map(kv => { const [k, v] = kv.split('='); return [k.toUpperCase(), v]; }));
      const freqMap: Record<string, RecurFreq> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };
      const freq = freqMap[(parts.FREQ || '').toUpperCase()];
      if (!freq) continue;
      recur = { freq, interval: parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10)) : 1 };
      if (freq === 'weekly' && parts.BYDAY) recur.byWeekday = parts.BYDAY.split(',').map(c => codeToWd[c.trim().slice(-2).toUpperCase()]).filter(w => w != null) as Weekday[];
      if (parts.COUNT) recur.end = { count: parseInt(parts.COUNT, 10) };
      else if (parts.UNTIL) {
        const u = parts.UNTIL;
        const y = u.slice(0, 4), m = u.slice(4, 6), d = u.slice(6, 8);
        recur.end = { until: `${y}-${m}-${d}` };
      }
    } else if (line.startsWith('EXDATE')) {
      const idx = line.indexOf(':');
      if (idx !== -1) {
        for (const raw of line.slice(idx + 1).split(',')) {
          const v = raw.trim();
          if (v.length >= 8) exdates.push(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
        }
      }
    }
  }
  return { recur, exdates: exdates.length ? exdates : undefined };
}
