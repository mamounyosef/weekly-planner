import { format, startOfWeek } from 'date-fns';

// ─── Recurrence / modification-domain model ─────────────────────────────────
// Every planner item carries a `scope`:
//   • 'all'  — a recurring item that repeats every week. It is versioned by an
//              "effective-from" week (`weekKey`): editing it in All-weeks mode
//              from a given week creates a new version effective from that week
//              forward, leaving earlier weeks frozen. `seriesId` groups the
//              versions of one recurring item.
//   • 'week' — a single-week item pinned to exactly one week (`weekKey`).
//              It may `overridesSeriesId` a recurring series to mask/fork it for
//              that one week (a `deleted` week-record is a "skip this week"
//              tombstone that only suppresses the series, rendering nothing).
//
// The interface toggle (`domain`) decides how NEW edits behave; the item's own
// scope decides what an edit can reach. An edit propagates across weeks only
// when the item is 'all' AND the toggle is 'all' AND the viewed week is not in
// the past. Everything else stays confined to the viewed week — and the past is
// never mutated.

export type EventScope = 'all' | 'week';
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Sorts lexicographically before any real 'yyyy-MM-dd', so migrated legacy items
// (effective from "the beginning of time") render in every week.
export const FAR_PAST_WEEK = '0000-01-01';

export interface RecurFields {
  id: string;
  scope?: EventScope;
  weekKey?: string;
  seriesId?: string;
  overridesSeriesId?: string;
  deleted?: boolean;
}

export function weekKeyOf(date: Date, weekStartsOn: WeekStartsOn): string {
  return format(startOfWeek(date, { weekStartsOn }), 'yyyy-MM-dd');
}

const wk = (ev: RecurFields): string => ev.weekKey ?? FAR_PAST_WEEK;
const seriesOf = (ev: RecurFields): string => ev.seriesId ?? ev.id;

// Legacy items (no scope) become recurring, effective since forever — preserving
// exactly the old "every week" behaviour. Returns `changed` so callers can decide
// whether to persist the upgraded shape.
export function migrateEvents<T extends RecurFields>(
  raw: Record<string, T>,
): { events: Record<string, T>; changed: boolean } {
  let changed = false;
  const out: Record<string, T> = {};
  for (const [id, ev] of Object.entries(raw)) {
    if (ev.scope === 'all' || ev.scope === 'week') {
      out[id] = ev;
      continue;
    }
    changed = true;
    out[id] = { ...ev, scope: 'all', weekKey: FAR_PAST_WEEK, seriesId: seriesOf(ev) };
  }
  return { events: out, changed };
}

// Resolve raw storage into exactly the items visible in one week, keyed by the
// storage id of the record actually shown (a recurring version id, or a
// single-week record id). The rest of the app renders/edits these ids directly.
export function resolveWeek<T extends RecurFields>(
  raw: Record<string, T>,
  viewedWeekKey: string,
): Record<string, T> {
  const out: Record<string, T> = {};
  const suppressed = new Set<string>();

  // Single-week records pinned to this week (and the series they mask).
  for (const ev of Object.values(raw)) {
    if (ev.scope !== 'week') continue;
    if ((ev.weekKey ?? '') !== viewedWeekKey) continue;
    if (ev.overridesSeriesId) suppressed.add(ev.overridesSeriesId);
    if (ev.deleted) continue; // "skip this week" tombstone: suppress only
    out[ev.id] = ev;
  }

  // Recurring series: pick the version effective for this week (greatest
  // effective-from that is ≤ the viewed week), unless masked by a week override.
  const bySeries = new Map<string, T[]>();
  for (const ev of Object.values(raw)) {
    if (ev.scope !== 'all') continue;
    const sid = seriesOf(ev);
    const list = bySeries.get(sid);
    if (list) list.push(ev);
    else bySeries.set(sid, [ev]);
  }
  for (const [sid, versions] of bySeries) {
    if (suppressed.has(sid)) continue;
    let chosen: T | null = null;
    for (const v of versions) {
      if (wk(v) <= viewedWeekKey && (!chosen || wk(chosen) < wk(v))) chosen = v;
    }
    if (!chosen || chosen.deleted) continue;
    out[chosen.id] = chosen;
  }

  return out;
}

export interface CommitCtx {
  viewedWeekKey: string;
  domain: EventScope;   // interface toggle
  isPastWeek: boolean;  // viewing a week before the one containing today
  newId: () => string;
}

// Editing in the past never propagates, regardless of the toggle.
function effectiveDomain(ctx: CommitCtx): EventScope {
  return ctx.isPastWeek ? 'week' : ctx.domain;
}

// Drop every version of a series effective strictly after the viewed week, so an
// All-weeks edit makes "this week forward" uniform (later variations collapse).
function collapseForward<T extends RecurFields>(map: Record<string, T>, sid: string, viewedWeekKey: string): void {
  for (const [k, v] of Object.entries(map)) {
    if (v.scope === 'all' && seriesOf(v) === sid && wk(v) > viewedWeekKey) delete map[k];
  }
}

// Public form: given the id of a recurring version just edited, collapse any
// later versions of the same series. Mutates a copy and returns it. Called only
// on a *real* All-weeks edit (never on merely opening an editor), so opening an
// item never destroys pre-existing future versions.
export function collapseSeriesForward<T extends RecurFields>(
  map: Record<string, T>,
  targetId: string,
  viewedWeekKey: string,
): Record<string, T> {
  const target = map[targetId];
  if (!target || target.scope !== 'all') return map;
  const next = { ...map };
  collapseForward(next, seriesOf(target), viewedWeekKey);
  next[targetId] = target; // never collapse the record we just edited
  return next;
}

// Ensure there is a *concrete* record that edits to the item shown as `id` this
// week should land on, and return its id. Idempotent: calling it repeatedly (e.g.
// on every keystroke of a live text edit) reuses the same record instead of
// forking again. After this, callers may patch `targetId` in place with a plain
// map write and the unified rule still holds.
//   • single-week item → itself.
//   • global + This-week → a single-week fork masking the series (reused if it
//     already exists for this week).
//   • global + All-weeks → the series version effective from this week (created
//     by splitting an earlier version if needed; later versions collapse away).
export function ensureConcreteTarget<T extends RecurFields>(
  raw: Record<string, T>,
  id: string,
  ctx: CommitCtx,
): { events: Record<string, T>; targetId: string } {
  const ev = raw[id];
  if (!ev) return { events: raw, targetId: id };
  const eff = effectiveDomain(ctx);

  if (ev.scope === 'week') return { events: raw, targetId: id };

  const sid = seriesOf(ev);

  if (eff === 'all') {
    // Reuse a version already anchored at the viewed week, else split one off.
    const existing = Object.values(raw).find(
      v => v.scope === 'all' && seriesOf(v) === sid && wk(v) === ctx.viewedWeekKey,
    );
    if (existing) return { events: raw, targetId: existing.id };
    // Split a new version off, effective from the viewed week; earlier versions
    // stay frozen. Later versions are left intact here — a real edit collapses
    // them via collapseSeriesForward, but merely opening an editor must not.
    const targetId = ctx.newId();
    return {
      events: { ...raw, [targetId]: { ...ev, id: targetId, scope: 'all', seriesId: sid, weekKey: ctx.viewedWeekKey, deleted: false } },
      targetId,
    };
  }

  // This-week fork: reuse an existing override for this series+week if present.
  const existingOverride = Object.values(raw).find(
    v => v.scope === 'week' && v.overridesSeriesId === sid && (v.weekKey ?? '') === ctx.viewedWeekKey,
  );
  if (existingOverride) {
    if (existingOverride.deleted) {
      // A skip-this-week tombstone becomes a real fork again on edit.
      return {
        events: { ...raw, [existingOverride.id]: { ...ev, id: existingOverride.id, scope: 'week', weekKey: ctx.viewedWeekKey, seriesId: undefined, overridesSeriesId: sid, deleted: false } },
        targetId: existingOverride.id,
      };
    }
    return { events: raw, targetId: existingOverride.id };
  }
  const nid = ctx.newId();
  return {
    events: {
      ...raw,
      [nid]: { ...ev, id: nid, scope: 'week', weekKey: ctx.viewedWeekKey, seriesId: undefined, overridesSeriesId: sid, deleted: false },
    },
    targetId: nid,
  };
}

export function commitDelete<T extends RecurFields>(
  raw: Record<string, T>,
  id: string,
  ctx: CommitCtx,
): Record<string, T> {
  const ev = raw[id];
  if (!ev) return raw;
  const eff = effectiveDomain(ctx);

  if (ev.scope === 'week') {
    // A fork of a recurring series must stay masked (become a skip-this-week
    // tombstone) so the series doesn't pop back; a plain single-week item is gone.
    if (ev.overridesSeriesId) {
      return { ...raw, [id]: { ...ev, deleted: true } };
    }
    const next = { ...raw };
    delete next[id];
    return next;
  }

  const sid = seriesOf(ev);

  // Global + All-weeks → tombstone this week forward; earlier weeks keep it.
  if (eff === 'all') {
    const next = { ...raw };
    if (wk(ev) === ctx.viewedWeekKey) {
      next[id] = { ...ev, deleted: true };
    } else {
      const nid = ctx.newId();
      next[nid] = { ...ev, id: nid, scope: 'all', seriesId: sid, weekKey: ctx.viewedWeekKey, deleted: true };
    }
    collapseForward(next, sid, ctx.viewedWeekKey);
    return next;
  }

  // Global + This-week → remove just this week's occurrence (skip-this-week),
  // reusing an existing override record for this series+week if there is one.
  const existingOverride = Object.values(raw).find(
    v => v.scope === 'week' && v.overridesSeriesId === sid && (v.weekKey ?? '') === ctx.viewedWeekKey,
  );
  if (existingOverride) {
    return { ...raw, [existingOverride.id]: { ...existingOverride, deleted: true } };
  }
  const nid = ctx.newId();
  return {
    ...raw,
    [nid]: {
      ...ev, id: nid,
      scope: 'week', weekKey: ctx.viewedWeekKey,
      seriesId: undefined, overridesSeriesId: sid, deleted: true,
    },
  };
}

// Stamp scope/anchor onto a freshly-created item per the current toggle. A new
// recurring item is effective from the viewed week (so the past never gains it).
export function stampNewItem<T extends RecurFields>(item: T, ctx: CommitCtx): T {
  const eff = effectiveDomain(ctx);
  if (eff === 'all') {
    return { ...item, scope: 'all', seriesId: item.id, weekKey: ctx.viewedWeekKey, overridesSeriesId: undefined, deleted: false };
  }
  return { ...item, scope: 'week', weekKey: ctx.viewedWeekKey, seriesId: undefined, overridesSeriesId: undefined, deleted: false };
}
