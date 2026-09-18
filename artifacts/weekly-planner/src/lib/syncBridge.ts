// ─── Snapshot ↔ operation bridge ─────────────────────────────────────────────
// The PC app has always written WHOLE FILES: `POST /api/events` hands over the
// entire event map. The phone speaks per-field operations. This module is the
// translator, and it exists so the PC app does not have to be rewritten to gain
// offline sync — the server diffs each incoming snapshot against what the sync
// state already holds and emits ops for exactly what changed.
//
// The alternative (teaching every call site in home.tsx to emit ops) would touch
// hundreds of places and every one of them could forget. Diffing at the single
// choke point cannot be forgotten.
//
// Direction 1 — PC saved a file:   snapshotToOps(...)  → ops → mergeOps
// Direction 2 — phone sent ops:    mergeOps → readStore(...) → write the file
//
// Round-tripping must be lossless: a snapshot in, converted to ops, merged and
// read back out, must equal the snapshot. That is the property the tests assert,
// because a lossy round trip would quietly erase fields on every save.

import {
  DELETED_FIELD,
  getOwn,
  valuesEqual,
  isSetField,
  isTombstoned,
  makeOps,
  readEntity,
  setOwn,
  type SyncOp,
  type SyncState,
  type SyncStore,
} from './sync';
import { isPlannerDate, PRAYER_KEYS } from './prayerTimes';

/**
 * Fields that must NEVER become operations.
 *
 * These are Google's bookkeeping, owned entirely by the PC's sync engine. The
 * phone has no Google connection, so it can only ever hold a stale copy — and
 * syncing them would produce a stream of conflicts on values the user has never
 * seen and cannot meaningfully choose between. They stay on the PC.
 */
export const PC_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'gCalETag',
  'gCalRecurSig',
  'gTaskETag',
  'gTaskSeriesDate',
  'lastSyncedAt',
]);

/** View-only fields stamped onto expanded occurrences; never persisted. */
export const TRANSIENT_FIELDS: ReadonlySet<string> = new Set(['masterId', 'occDate']);

/**
 * Stores where a field MISSING from a save does not mean the user cleared it.
 *
 * THIS EXISTS BECAUSE IT ONCE ATE NINE CATEGORIES. On 2026-08-30 a settings save
 * reached the server without a `categories` key. The diff below read that
 * absence as "the user cleared this field", emitted `categories: undefined`, and
 * every device dutifully merged the erasure. The app then fell back to its two
 * built-in categories and saved THOSE, so the erasure became the new truth.
 *
 * `settings.json` is not a map of records. Its snapshot is BUILT by picking the
 * shared keys that happen to be present (`sharedSettingsOf`), so an absent key
 * means "this writer did not send it" — a partial save, an older client, a file
 * written before the field existed. Not one of those is a user clearing
 * anything. Every shared setting has a default and is always present when it is
 * genuinely set; a category list emptied on purpose arrives as `[]`, which is a
 * value and travels normally. So omission here can only ever be silence, and
 * silence must never delete.
 */
export const OMISSION_NEVER_CLEARS: ReadonlySet<SyncStore> = new Set<SyncStore>(['settings']);

/**
 * Shared settings that are structures rather than scalars.
 *
 * A structure being replaced by `undefined` is the shape of the categories loss,
 * never the shape of a real edit: the app writes `[]` or `{}`, never nothing. So
 * such an op is refused wherever one is seen, no matter which client produced
 * it, which is what protects this data from a build that is not this one.
 */
export const SETTINGS_STRUCTURE_FIELDS: ReadonlySet<string> = new Set([
  'categories',
  'taskLists',
  'prayer',
  'notifications',
  'taskFilters',
  'focusExcludedDates',
]);

/**
 * Would this op erase a settings structure outright?
 *
 * Used both when ops are made and when they arrive from another device, so a
 * peer running older code cannot do what a local bug is now prevented from
 * doing.
 */
export function isSettingsWipeOp(op: {
  store: string; field: string; value?: unknown; present?: boolean;
}): boolean {
  if (op.store !== 'settings') return false;
  if (op.present !== undefined) return false; // a set-member op carries a member
  if (!SETTINGS_STRUCTURE_FIELDS.has(op.field)) return false;
  return op.value === undefined || op.value === null;
}

export const isSyncableField = (field: string): boolean =>
  !PC_ONLY_FIELDS.has(field) && !TRANSIENT_FIELDS.has(field) && field !== DELETED_FIELD;

export type Snapshot = Record<string, Record<string, unknown>>;

// ─── Files that are not maps of records ──────────────────────────────────────
// `database.json` and `tasks.json` are already shaped the way the sync engine
// thinks — an object of records, keyed by id. `settings.json` is not: it is ONE
// object of loose keys, and only part of it may travel at all.
//
// So a store may declare how its file becomes a snapshot and how a merged
// snapshot becomes its file again. Everything else in the engine stays unaware
// that any such thing exists.

/** The single entity the settings store keeps. There is only ever one planner. */
export const SETTINGS_ENTITY = 'app';

export interface StoreAdapter {
  /** File content → the snapshot the engine diffs. */
  toSnapshot(raw: unknown): Snapshot;
  /** A merged snapshot → the file content to write back. */
  fromSnapshot(next: Snapshot, onDisk: unknown): unknown;
  /** False where an absent id can never mean a deletion. */
  detectDeletes: boolean;
}

/**
 * A file that is an ARRAY of records, each carrying its own id.
 *
 * `focus-sessions.json` is a list, not a map, because the PC only ever appends
 * to it and reads it back in order. The sync engine works in records keyed by
 * id, so the list is turned into one on the way in and back into a list on the
 * way out — sorted, so two devices that merged the same sessions in different
 * orders still write byte-identical files and do not fight over the result.
 */
export function arrayAdapter(sortKey: string): StoreAdapter {
  return {
    toSnapshot(raw) {
      const out: Snapshot = {};
      if (!Array.isArray(raw)) return out;
      for (const row of raw) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const id = (row as Record<string, unknown>).id;
        // A row with no id cannot be merged per-field and cannot be matched up
        // between devices, so it is left out rather than given a made-up one.
        if (typeof id !== 'string' || id.length === 0) continue;
        setOwn(out, id, row as Record<string, unknown>);
      }
      return out;
    },
    fromSnapshot(next) {
      return Object.keys(next)
        .map(id => getOwn(next, id))
        .filter((row): row is Record<string, unknown> => Boolean(row))
        .sort((a, b) => String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')));
    },
    detectDeletes: true,
  };
}

/**
 * Settings: only the shared keys travel, and the rest of the file survives.
 *
 * The second half is what makes this safe. `settings.json` holds this machine's
 * own view, theme and hour range alongside the shared values, so writing back
 * only what synced would erase them — the PC would lose its layout every time
 * the phone changed a category.
 */
export function settingsAdapter(
  sharedOf: (raw: any) => Record<string, unknown>,
  applyShared: (local: any, incoming: any) => any,
): StoreAdapter {
  return {
    toSnapshot(raw) {
      const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      return { [SETTINGS_ENTITY]: sharedOf(src) };
    },
    fromSnapshot(next, onDisk) {
      const local = onDisk && typeof onDisk === 'object' && !Array.isArray(onDisk) ? onDisk : {};
      return applyShared(local, getOwn(next, SETTINGS_ENTITY) ?? {});
    },
    detectDeletes: false,
  };
}

/**
 * Prayer completion marks: the PC's file vs the engine's shape.
 *
 * `prayer-done.json` has always been `{ 'yyyy-MM-dd': ['fajr', ...] }` — the PC
 * app reads and writes it through `/api/prayer-done`, which hands the whole map
 * over. The sync engine instead keeps one entity per date with a single SET
 * field called `done`, so two devices ticking different prayers on the same day
 * merge instead of fight. Without this adapter the two shapes were read as each
 * other: the engine saw the PC's array as an object keyed "0", "1", ... and the
 * PC could not read the engine's `{ done: [...] }` back at all. Each device then
 * overwrote the other's ticks with something neither could parse — the file this
 * produced held the same day as `{ "0": "maghrib", "1": "isha", done: [] }`,
 * which both apps rendered as nothing ticked.
 *
 * The engine sees `{ date: { done: [...] } }`; the file keeps the array form the
 * PC has always written.
 *
 * The digit-keyed members are a deliberate rescue, not toleration: a day saved
 * by the OLD code has its ticks stranded under their array indices, invisible to
 * both apps. They were real ticks, so they are folded back into `done`.
 */
export function prayerDoneAdapter(): StoreAdapter {
  const isPrayerKey = (v: unknown): v is string =>
    typeof v === 'string' && (PRAYER_KEYS as readonly string[]).includes(v);

  const membersOf = (value: unknown): string[] => {
    const members = new Set<string>();
    if (Array.isArray(value)) {
      for (const v of value) if (isPrayerKey(v)) members.add(v);
    } else if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      if (Array.isArray(rec.done)) {
        for (const v of rec.done) if (isPrayerKey(v)) members.add(v);
      }
      for (const [k, v] of Object.entries(rec)) {
        // Legacy damage: an array ingested as an object lands under "0", "1", ...
        if (/^\d+$/.test(k) && isPrayerKey(v)) members.add(v);
      }
    }
    // In prayer order, so the rebuilt file matches what the PC itself writes.
    return PRAYER_KEYS.filter(k => members.has(k));
  };

  return {
    toSnapshot(raw) {
      const out: Snapshot = {};
      const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      for (const [date, value] of Object.entries(src)) {
        // One exact definition of a real day, shared with the sync door: a
        // day that cannot exist must not enter a record every device treats
        // as the truth.
        if (!isPlannerDate(date)) continue;
        const rec: Record<string, unknown> = { done: membersOf(value) };
        setOwn(out, date, rec);
      }
      return out;
    },
    fromSnapshot(next) {
      const out: Record<string, string[]> = {};
      for (const [date, rec] of Object.entries(next)) {
        const done = (rec as Record<string, unknown> | undefined)?.done;
        if (Array.isArray(done) && done.length > 0) out[date] = done;
      }
      return out;
    },
    // An id this peer has tombstoned must never resurrect — but a DATE cannot be
    // tombstoned at all: it is stable for ever, and un-ticking a day's last
    // prayer (a missing or empty entry in the next save) must not make the same
    // date un-tick-able an hour later. Removal is expressed per ELEMENT by the
    // set merge, never by omitting the entity.
    detectDeletes: false,
  };
}

/**
 * Structural equality for planner values. Re-exported from `sync.ts` so the
 * merge engine and the snapshot diff can never disagree about whether two
 * devices wrote the same thing — if they did, one would raise a conflict card
 * the other considers impossible.
 */
export const sameValue = valuesEqual;

/**
 * Diff a freshly saved snapshot against current sync state and produce the ops
 * that explain the difference.
 *
 * `at` is the wall clock for display; ordering still comes from the lamport
 * clock inside `state`, which this call advances.
 */
export function snapshotToOps(
  state: SyncState,
  opts: {
    store: SyncStore;
    snapshot: Snapshot;
    device: string;
    at: number;
    /** When false, ids missing from the snapshot are left alone instead of being
     *  tombstoned. Use for partial saves that only carry one week. */
    detectDeletes?: boolean;
    /**
     * What the writer was looking at when it produced this snapshot — i.e. the
     * bytes that were on disk before this save.
     *
     * WHY THIS MATTERS MORE THAN ANYTHING ELSE HERE. The PC app saves its WHOLE
     * event map, built from a read that may be seconds old. Without a baseline
     * the server can only ask "does this differ from sync state?", and after the
     * phone has just changed something the answer is yes for every field the
     * phone touched and for every id the phone created — so a routine PC
     * autosave silently reverted the phone's edit and TOMBSTONED anything the
     * phone had just added. That is the "I ticked it on my phone and the PC
     * never showed it" report.
     *
     * With a baseline the question becomes the right one: "did the WRITER change
     * this?" A field equal to the baseline is an echo and produces no op; an id
     * the writer never had cannot be a deletion by that writer.
     */
    baseline?: Snapshot;
    /**
     * Take additions and changes from this snapshot, but never removals.
     *
     * FOR WHEN THERE IS NO HONEST BASELINE. A snapshot with no known baseline
     * cannot be diffed safely: the server has no way to tell "the user cleared
     * this field" from "this file is simply older than the log". Guessing wrong
     * in that direction is catastrophic and silent — it reverts an edit that was
     * already merged, and pushes the revert to every device.
     *
     * The asymmetry is the point. A stale file's damage is always ABSENCE: it
     * lacks values the log has learned since. Anything it CONTAINS is real. So
     * with no baseline we believe what it says and ignore what it omits, and let
     * the rebuild put the missing values back.
     */
    additive?: boolean;
  },
): SyncOp[] {
  const {
    store, snapshot, device, at, detectDeletes = true, baseline, additive = false,
  } = opts;
  const ops: SyncOp[] = [];
  /** Was the writer looking at a baseline at all? */
  const scoped = baseline !== undefined;

  for (const id of Object.keys(snapshot).sort()) {
    const incoming = snapshot[id] ?? {};
    // NEVER RESURRECT. An id this peer has tombstoned is deliberately absent
    // from the rebuilt file; if it is still on disk (a Google sync re-added it,
    // a backup was restored, the server restarted before the file was rewritten)
    // treating it as new would undo the delete on every single restart.
    if (isTombstoned(state, store, id)) continue;
    const current = readEntity(state, store, id);
    const was = scoped ? getOwn(baseline!, id) : undefined;
    const knownToWriter = !scoped || was !== undefined;
    const changes: Record<string, unknown> = {};

    for (const field of Object.keys(incoming)) {
      if (!isSyncableField(field)) continue;
      const next = getOwn(incoming, field);
      const prev = current ? getOwn(current, field) : undefined;

      // The writer is echoing back exactly what it read. Not an edit.
      if (knownToWriter && was && sameValue(next, getOwn(was, field))) continue;

      if (isSetField(store, field)) {
        // Sets are compared as sorted membership, so re-ordering an array is not
        // mistaken for a change and does not emit pointless ops.
        const a = Array.isArray(next) ? [...next].map(String).sort() : [];
        const b = Array.isArray(prev) ? [...prev].map(String).sort() : [];
        if (a.join(' ') === b.join(' ')) continue;
        // Additive: take the union, so a file that has not caught up yet adds
        // dates without dropping the ones the log already knows about. This is
        // the exact line that decides whether a tick made on the phone survives
        // a dev-server restart -- an empty `completedDates` on disk is the stale
        // file's silence, not the user un-ticking anything.
        if (additive) {
          const union = [...new Set([...b, ...a])].sort();
          if (union.length !== b.length) changes[field] = union;
          continue;
        }
        changes[field] = next;
        continue;
      }
      // Additive: a scalar that disagrees is genuinely ambiguous -- a stale file
      // and a real edit look identical -- so only fields the log has never held
      // are taken. That is what makes a whole NEW record arrive intact (every
      // field of it is unknown) while a stale copy of a record we already track
      // cannot roll it back.
      if (additive && prev !== undefined) continue;
      if (!sameValue(next, prev)) setOwn(changes, field, next);
    }

    // A field the record used to have and no longer does was CLEARED. Without
    // this the phone would keep a value the PC deleted — the stale-notify bug.
    // Skipped entirely in additive mode: see `additive` above.
    if (current && !additive && !OMISSION_NEVER_CLEARS.has(store)) {
      for (const field of Object.keys(current)) {
        if (!isSyncableField(field)) continue;
        if (Object.hasOwn(incoming, field)) continue;
        // A field the writer never held cannot have been cleared BY the writer.
        if (was && !Object.hasOwn(was, field)) continue;
        if (scoped && !was) continue;
        if (isSetField(store, field)) {
          const cur = getOwn(current, field);
          if (Array.isArray(cur) && cur.length > 0) setOwn(changes, field, []);
          continue;
        }
        setOwn(changes, field, undefined);
      }
    }

    if (Object.keys(changes).length > 0) {
      ops.push(...makeOps(state, { store, entityId: id, device, at, changes }));
    }
  }

  if (detectDeletes && !additive) {
    const live = state.entities[store] ?? {};
    for (const id of Object.keys(live).sort()) {
      if (Object.hasOwn(snapshot, id)) continue;
      if (isTombstoned(state, store, id)) continue;
      if (!readEntity(state, store, id)) continue;
      // Only the writer's OWN omissions are deletions. An id created on the
      // phone thirty seconds ago was never in the PC's copy, so the PC leaving
      // it out means "I have not heard of it", not "delete it".
      if (scoped && !Object.hasOwn(baseline!, id)) continue;
      ops.push(...makeOps(state, {
        store, entityId: id, device, at, changes: { [DELETED_FIELD]: true },
      }));
    }
  }

  // LAST GATE. Nothing above should be able to produce one of these any more,
  // but an op that erases a settings structure is destructive and irreversible
  // once it has been replicated, so it is checked for on the way out as well as
  // prevented on the way in. Cheap; and the one time it mattered cost the user
  // nine categories they had built by hand.
  return ops.filter(op => !isSettingsWipeOp(op));
}

/**
 * Rebuild the file-shaped snapshot from sync state, carrying forward the PC-only
 * fields from the snapshot currently on disk.
 *
 * That carry-forward is the whole reason this is not just `readStore`: Google's
 * ETags live only on the PC and are not operations, so a naive rebuild would
 * erase them and the next Google sync would re-upload everything.
 */
export function opsToSnapshot(
  state: SyncState,
  store: SyncStore,
  currentOnDisk: Snapshot = {},
): Snapshot {
  const out: Snapshot = {};
  const byId = state.entities[store] ?? {};

  for (const id of Object.keys(byId).sort()) {
    const rec = readEntity(state, store, id);
    if (!rec) continue;

    const preserved: Record<string, unknown> = {};
    const disk = getOwn(currentOnDisk, id);
    if (disk) {
      for (const field of PC_ONLY_FIELDS) {
        if (Object.hasOwn(disk, field)) setOwn(preserved, field, disk[field]);
      }
    }
    setOwn(out, id, { ...rec, ...preserved });
  }

  // Ids on disk the sync engine has never heard of are NOT ours to delete.
  // Google Calendar writes database.json directly, and a rebuild that emitted
  // only what sync state knows would erase every imported event the moment the
  // phone pushed anything. They are carried through untouched; the next ingest
  // folds them into the log properly.
  for (const id of Object.keys(currentOnDisk).sort()) {
    if (Object.hasOwn(out, id)) continue;
    if (Object.hasOwn(byId, id)) continue;   // known, and deliberately omitted
    const disk = getOwn(currentOnDisk, id);
    if (disk && typeof disk === 'object' && !Array.isArray(disk)) setOwn(out, id, disk);
  }
  return out;
}

/**
 * Ids whose materialised value differs from what is on disk — i.e. what the
 * phone changed. Lets the server rewrite a file only when it actually must,
 * which is what keeps the db-stream from firing on every empty sync poll.
 */
export function changedIds(
  state: SyncState,
  store: SyncStore,
  currentOnDisk: Snapshot,
): string[] {
  const next = opsToSnapshot(state, store, currentOnDisk);
  const ids = new Set([...Object.keys(next), ...Object.keys(currentOnDisk)]);
  const out: string[] = [];
  for (const id of ids) {
    if (!sameValue(getOwn(next, id), getOwn(currentOnDisk, id))) out.push(id);
  }
  return out.sort();
}

// ─── Identifying which version a writer was looking at ───────────────────────
// The PC app saves its WHOLE event map, built from a copy it loaded earlier. To
// merge that safely the server has to know WHICH copy — otherwise it cannot tell
// "the user deleted this" from "this writer has never heard of it". The app
// therefore stamps every save with the id of the version it started from, and
// the server keeps the last few versions it has handed out so it can look one up.
//
// The id is over the CANONICAL form, not the bytes: the same data reaches the
// app pretty-printed from a GET and compact over the event stream, and those two
// must produce the same id or the stamp is useless.

/** Stable stringification: object keys sorted at every depth, arrays left alone. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) {
        if (src[k] !== undefined) out[k] = walk(src[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * A short, stable id for one version of a store. FNV-1a over the canonical form
 * — not a security hash, just a collision-resistant-enough label for the last
 * couple of dozen versions of one file.
 */
export function baseIdOf(value: unknown): string {
  const text = canonicalJson(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}
