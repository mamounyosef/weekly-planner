// ─── Occurrence scope: what "this one" versus "all of them" actually writes ───
//
// A repeating item is stored ONCE (the master) and expanded into occurrences on
// the fly, so "delete Tuesday's gym" is never a delete of a record. It is a
// change to the master, or a truncation of its rule, or a brand new standalone
// record plus an EXDATE. Which of the three it is depends entirely on the scope
// the user picked, and getting it wrong is silent: the wrong occurrence quietly
// disappears, or a whole series does.
//
// WHY THIS FILE EXISTS AT ALL. The PC already knows all of this, but it knows it
// inside `home.tsx` and inside `recurrence.ts`'s `editSeries` / `deleteScoped`,
// tangled with React state, the viewed week and Google sync. The phone needs the
// same decisions without any of that, and it needs them as DATA (a list of
// record writes) rather than as a mutation, so the caller can hand the writes to
// the sync layer one field at a time. Both machines must agree about what an
// edit meant or they diverge permanently, so this file is deliberately a
// re-expression of the PC's rules and nothing more.
//
// WHERE THIS FILE AND THE PC DIFFER, AND WHY.
//   • Edit has no 'following' on the PC. The PC's popup offers scope only for
//     DELETE; an edit is either "detach this one" (unlocked, the default) or
//     "change the series" (locked). 'following' for an edit is new here, and is
//     built out of the two operations the PC already performs: truncate the old
//     rule exactly the way `deleteScoped('following')` does, then start a new
//     master at the chosen date. Nothing the PC can produce is interpreted
//     differently because of it.
//   • `locked` forces 'all' for EDITS only, which is what the PC does. A delete
//     stays scoped on a locked series, because `deleteScoped` never looks at
//     `locked`: locking a series means "keep every occurrence identical", not
//     "you may never drop one".
//
// Everything else is a line-by-line match with `editSeries` / `deleteScoped`,
// including the details that look like accidents but are not: a detached
// occurrence drops its Google identity so it becomes its own event on the next
// sync; 'following' from the first occurrence collapses to 'all' because
// truncating a series to end before it starts leaves nothing behind; and a
// series with a Google id is tombstoned rather than removed, so the delete
// mirrors to Google before the record goes.

import { addDays, addYears, differenceInDays, format, startOfWeek } from 'date-fns';

import {
  normalizeAnchor,
  occurrenceStarts,
  parseDate,
  weekKeyOf,
  type RecurFields,
  type Recurrence,
  type WeekStartsOn,
} from './recurrence';

/** The three-way choice, identical for editing and for deleting. */
export type OccurrenceScope = 'one' | 'following' | 'all';

/**
 * One record write.
 *
 * `put` replaces (or creates) the whole record under `id`; `remove` deletes the
 * key outright. There is deliberately no "patch" write: the caller may be a sync
 * layer that diffs against what it already holds, and a diff of two whole
 * records is something it can do, whereas guessing which absent field means
 * "unset" is not.
 */
export type OccurrenceWrite<T extends RecurFields> =
  | { op: 'put'; id: string; record: T; role: WriteRole }
  | { op: 'remove'; id: string; role: WriteRole };

/**
 * What each write is FOR, so a caller can report it ("the series was shortened")
 * without re-deriving the intent from the record shapes.
 */
export type WriteRole =
  /** The original master, edited, excluded or truncated in place. */
  | 'master'
  /** A single occurrence pulled out of the series into a free standalone item. */
  | 'detached'
  /** The second half of a split series, carrying the edit forward. */
  | 'newMaster'
  /** The master kept as a tombstone so the delete can reach Google first. */
  | 'tombstone'
  /** The master removed outright (it was never synced). */
  | 'dropped';

export interface OccurrencePlan<T extends RecurFields> {
  /**
   * The scope that was actually applied. It differs from the requested one when
   * the item does not repeat (always 'all'), when the series is locked (edits
   * are forced to 'all'), or when 'following' from the very first occurrence
   * would leave nothing behind (collapses to 'all').
   */
  scope: OccurrenceScope;
  /** True when `locked` overrode the request. Say so in the UI, do not hide it. */
  forcedByLock: boolean;
  /**
   * Empty when the request is already satisfied, for example deleting an
   * occurrence that is already excluded. An empty plan must be a no-op, never a
   * write of an unchanged record: a redundant write is a sync op that can lose
   * a race against a real one.
   */
  writes: OccurrenceWrite<T>[];
  /**
   * The id the UI should keep selected afterwards: the detached record for a
   * one-off edit, the new master for a split, the master otherwise. Null when
   * the target no longer exists (any delete that removed it).
   */
  targetId: string | null;
}

export interface OccurrenceOptions {
  weekStartsOn?: WeekStartsOn;
  /** Injected so tests get deterministic ids. Defaults to a UUID. */
  newId?: () => string;
  /** Injected so tests get deterministic timestamps. Defaults to `Date.now()`. */
  now?: () => number;
}

const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');
const anchorOf = (m: RecurFields): Date => addDays(parseDate(m.weekKey ?? '0000-01-01'), m.dayIndex ?? 0);

// A detached occurrence and a split-off master both become their OWN Google
// event on the next sync. Carrying the parent's identity forward would make two
// records claim one remote event, and `resolveWeek` then hides whichever it
// judges staler, so one of them simply stops being drawn.
const FRESH_GCAL = {
  gCalId: undefined,
  gCalCalendarId: undefined,
  gCalETag: undefined,
  gCalRecurSig: undefined,
  lastSyncedAt: undefined,
} as const;

// View-only fields stamped by `resolveWeek`. They must never reach a stored
// record: an id containing "::" is dropped on the next load, so an item written
// with one simply vanishes after a reload.
const STRIP_VIEW = { masterId: undefined, occDate: undefined } as const;

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Anchor a record on a real (weekKey, 0-6) pair for a concrete calendar date. */
function anchorOn<T extends RecurFields>(record: T, date: Date, weekStartsOn: WeekStartsOn): T {
  const ws = startOfWeek(date, { weekStartsOn });
  return normalizeAnchor({
    ...record,
    weekKey: weekKeyOf(date, weekStartsOn),
    dayIndex: differenceInDays(date, ws),
  }, weekStartsOn);
}

/**
 * The first date the series still SHOWS, or null for a rule that produces nothing
 * at all (a count of zero, an until before the anchor, or every date excluded).
 *
 * Exclusions count here, which is a decision copied from the PC rather than
 * reasoned out fresh: `deleteScoped` asks the same question with the exdates
 * left in, so on a series whose opening occurrences have been deleted one by
 * one, "this and everything after" from the first date still VISIBLE removes the
 * whole thing. Answering it any other way would leave the PC and the phone
 * disagreeing about a series that has been picked at from the front.
 *
 * Five years matches `deleteScoped`, which uses the same window. A rule that
 * produces its first occurrence more than five years after its anchor cannot be
 * expressed by this model anyway.
 */
export function firstOccurrenceDate(master: RecurFields, weekStartsOn: WeekStartsOn = 0): string | null {
  const anchor = anchorOf(master);
  const occs = occurrenceStarts(master, anchor, addYears(anchor, 5), weekStartsOn);
  return occs.length ? ymd(occs[0]) : null;
}

/** Whether `date` is a live occurrence: produced by the rule and not excluded. */
export function isOccurrenceOf(master: RecurFields, date: string, weekStartsOn: WeekStartsOn = 0): boolean {
  const d = parseDate(date);
  const found = occurrenceStarts(master, d, addDays(d, 1), weekStartsOn);
  return found.length > 0 && ymd(found[0]) === date;
}

/**
 * How many occurrences the rule has already produced STRICTLY BEFORE `date`.
 *
 * Needed only to re-express a `count` rule across a split. Exclusions are
 * ignored because `occurrenceStarts` counts an excluded date against `count`
 * too (it increments `produced` before testing the exdate set), and the two must
 * agree or the second half of a split series runs for the wrong number of days.
 */
export function countBefore(master: RecurFields, date: string, weekStartsOn: WeekStartsOn = 0): number {
  const anchor = anchorOf(master);
  const bare = { ...master, exdates: undefined };
  return occurrenceStarts(bare, anchor, parseDate(date), weekStartsOn).length;
}

/**
 * The scope that will really be used, given the item and what was asked.
 * Exported so the menu can grey out or relabel a choice BEFORE the user taps it,
 * rather than silently doing something else afterwards.
 */
export function effectiveScope(
  master: RecurFields | undefined,
  requested: OccurrenceScope,
  action: 'edit' | 'delete',
): { scope: OccurrenceScope; forcedByLock: boolean } {
  if (!master || !master.recur) return { scope: 'all', forcedByLock: false };
  // Locking a series means "every occurrence stays identical", which is exactly
  // a refusal to detach one. It says nothing about deleting one, and the PC's
  // `deleteScoped` never reads the flag, so neither do we.
  if (action === 'edit' && master.locked && requested !== 'all') {
    return { scope: 'all', forcedByLock: true };
  }
  return { scope: requested, forcedByLock: false };
}

// ─── Edit ────────────────────────────────────────────────────────────────────

/**
 * The writes needed to apply `patch` to a repeating item at scope `scope`.
 *
 * `date` is the occurrence the user acted on, 'yyyy-MM-dd'. It may be null for a
 * non-repeating item; for a repeating one a null date has no occurrence to
 * detach from, so the edit falls back to the whole series exactly as
 * `editSeries` does.
 *
 * The patch describes CONTENT, never identity: `id`, `masterId`, `occDate`,
 * `weekKey` and `dayIndex` are stripped out of it. The first three would file a
 * record under a key it does not match; the last two would fight the anchor this
 * function is computing, and a moved occurrence is expressed by passing a
 * different `date`, not by patching the anchor.
 */
export function planOccurrenceEdit<T extends RecurFields>(
  master: T,
  date: string | null,
  scope: OccurrenceScope,
  patchIn: Partial<T>,
  opts: OccurrenceOptions = {},
): OccurrencePlan<T> {
  const weekStartsOn = opts.weekStartsOn ?? 0;
  const newId = opts.newId ?? uuid;
  const now = (opts.now ?? Date.now)();
  const patch = sanitizePatch(patchIn);

  const { scope: eff, forcedByLock } = effectiveScope(master, scope, 'edit');

  // Non-repeating, locked, or an explicit "all": one write on the master.
  if (!master.recur || eff === 'all' || !date) {
    const next = normalizeAnchor({ ...master, ...patch, updatedAt: now } as T, weekStartsOn);
    return {
      scope: 'all',
      forcedByLock,
      writes: [{ op: 'put', id: master.id, record: next, role: 'master' }],
      targetId: master.id,
    };
  }

  if (eff === 'one') {
    // Detach: the series loses this date, and a free-standing copy of the item
    // takes its place carrying the edit. It keeps no repeat rule, no lock and no
    // Google identity, because it is no longer part of anything.
    const exdates = master.exdates ?? [];
    const nextExdates = exdates.includes(date) ? exdates : [...exdates, date];
    const masterNext = { ...master, exdates: nextExdates, updatedAt: now } as T;

    const id = newId();
    const detached = anchorOn({
      ...master,
      id,
      recur: undefined,
      exdates: undefined,
      locked: undefined,
      ...STRIP_VIEW,
      ...FRESH_GCAL,
      deleted: false,
      ...patch,
      updatedAt: now,
    } as T, parseDate(date), weekStartsOn);

    return {
      scope: 'one',
      forcedByLock,
      writes: [
        { op: 'put', id: master.id, record: masterNext, role: 'master' },
        { op: 'put', id, record: detached, role: 'detached' },
      ],
      targetId: id,
    };
  }

  // ─── 'following' ───
  // From the first occurrence onwards there is no "before", so the split would
  // produce an empty original. Editing the master in place is the same result
  // with one fewer record, and it keeps the Google event rather than orphaning
  // it, which is why `deleteScoped` collapses the same case to 'all'.
  const first = firstOccurrenceDate(master, weekStartsOn);
  if (date <= ymd(anchorOf(master)) || first === null || date <= first) {
    const next = normalizeAnchor({ ...master, ...patch, updatedAt: now } as T, weekStartsOn);
    return {
      scope: 'all',
      forcedByLock,
      writes: [{ op: 'put', id: master.id, record: next, role: 'master' }],
      targetId: master.id,
    };
  }

  const truncated = truncateBefore(master, date, now);

  // The tail keeps the same rule, minus whatever the head already used up, and
  // keeps only the exclusions that fall inside it. Exclusions from the head
  // would be dead weight that the Google EXDATE list still has to carry.
  const tailId = newId();
  const tail = anchorOn({
    ...master,
    id: tailId,
    recur: tailRule(master.recur!, master, date, weekStartsOn),
    exdates: (master.exdates ?? []).filter(d => d >= date),
    ...STRIP_VIEW,
    ...FRESH_GCAL,
    deleted: false,
    ...patch,
    updatedAt: now,
  } as T, parseDate(date), weekStartsOn);

  return {
    scope: 'following',
    forcedByLock,
    writes: [
      { op: 'put', id: master.id, record: truncated, role: 'master' },
      { op: 'put', id: tailId, record: tail, role: 'newMaster' },
    ],
    targetId: tailId,
  };
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * The writes needed to delete at scope `scope`. A line-for-line match with
 * `deleteScoped` in `recurrence.ts`, expressed as writes.
 *
 * A record that has ever reached Google is TOMBSTONED rather than removed: the
 * next sync needs the record in order to tell Google the event is gone. Removing
 * it immediately deletes it here and leaves it on every other calendar forever.
 */
export function planOccurrenceDelete<T extends RecurFields>(
  master: T,
  date: string | null,
  scope: OccurrenceScope,
  opts: OccurrenceOptions = {},
): OccurrencePlan<T> {
  const weekStartsOn = opts.weekStartsOn ?? 0;
  const now = (opts.now ?? Date.now)();

  const dropOrTombstone = (used: OccurrenceScope): OccurrencePlan<T> => (
    master.gCalId
      ? {
        scope: used,
        forcedByLock: false,
        writes: [{ op: 'put', id: master.id, record: { ...master, deleted: true, updatedAt: now } as T, role: 'tombstone' }],
        targetId: null,
      }
      : {
        scope: used,
        forcedByLock: false,
        writes: [{ op: 'remove', id: master.id, role: 'dropped' }],
        targetId: null,
      }
  );

  if (!master.recur) return dropOrTombstone('all');
  if (scope === 'all') return dropOrTombstone('all');
  if (!date) return dropOrTombstone('all');

  if (scope === 'following') {
    // Same collapse as the edit path, and for the same reason: a series bounded
    // to end before it began is not a series, it is an absence.
    const first = firstOccurrenceDate(master, weekStartsOn);
    if (date <= ymd(anchorOf(master)) || first === null || date <= first) return dropOrTombstone('all');
    return {
      scope: 'following',
      forcedByLock: false,
      writes: [{ op: 'put', id: master.id, record: truncateBefore(master, date, now), role: 'master' }],
      targetId: master.id,
    };
  }

  // 'one': already excluded is already done. Writing the identical record again
  // would be a sync op with nothing in it.
  const exdates = master.exdates ?? [];
  if (exdates.includes(date)) {
    return { scope: 'one', forcedByLock: false, writes: [], targetId: master.id };
  }
  return {
    scope: 'one',
    forcedByLock: false,
    writes: [{ op: 'put', id: master.id, record: { ...master, exdates: [...exdates, date], updatedAt: now } as T, role: 'master' }],
    targetId: master.id,
  };
}

// ─── Applying ────────────────────────────────────────────────────────────────

/**
 * Fold a plan into a store. Provided so tests (and any caller that holds a plain
 * map) can check the RESULT rather than the intent, which is the only way to
 * prove a detached occurrence never comes back when the week is re-expanded.
 */
export function applyOccurrenceWrites<T extends RecurFields>(
  raw: Record<string, T>,
  plan: OccurrencePlan<T>,
): Record<string, T> {
  if (!plan.writes.length) return raw;
  const out = { ...raw };
  for (const w of plan.writes) {
    if (w.op === 'remove') delete out[w.id];
    else out[w.id] = w.record;
  }
  return out;
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

/**
 * The head of a split, or a 'following' delete: the series now ends the day
 * before the chosen date, and exclusions after that point are dropped because
 * there is nothing left there to exclude.
 *
 * UNTIL replaces a COUNT here rather than reducing it, which is what the PC
 * does. It is not a loss: an UNTIL that lands inside the counted run bounds the
 * series more tightly than the count ever did, so the visible occurrences are
 * identical, and Google is given one unambiguous rule instead of two.
 */
function truncateBefore<T extends RecurFields>(
  master: T,
  date: string,
  now: number,
): T {
  const until = ymd(addDays(parseDate(date), -1));
  return {
    ...master,
    recur: { ...master.recur!, end: { until } },
    exdates: (master.exdates ?? []).filter(d => d < date),
    updatedAt: now,
  } as T;
}

/**
 * The tail's rule. Frequency, interval and weekdays are untouched, so the split
 * halves keep landing on the same days. Only the end needs rewriting:
 *   • a COUNT must lose whatever the head already spent, or the tail runs on for
 *     the full original count and the series gets longer by being edited;
 *   • an UNTIL is an absolute date and stays exactly as it was;
 *   • no end stays no end.
 */
function tailRule(recur: Recurrence, master: RecurFields, date: string, weekStartsOn: WeekStartsOn): Recurrence {
  if (recur.end && 'count' in recur.end) {
    const spent = countBefore(master, date, weekStartsOn);
    return { ...recur, end: { count: Math.max(1, recur.end.count - spent) } };
  }
  return { ...recur };
}

/**
 * Strip identity and anchor out of a patch.
 *
 * `id`/`masterId`/`occDate`: several call sites build a patch by spreading a
 * whole EXPANDED record, whose id is "<master>::<date>". Writing that through
 * files the record under a key it does not match, and records with "::" in their
 * id are dropped on the next load, so the item silently vanishes on reload.
 *
 * `weekKey`/`dayIndex`: the anchor is decided by the scope and the chosen date,
 * never by the patch. Letting a patch set it would place a detached occurrence
 * on a different day from the one that was long-pressed.
 */
function sanitizePatch<T extends RecurFields>(patch: Partial<T>): Partial<T> {
  if (!('id' in patch) && !('masterId' in patch) && !('occDate' in patch)
    && !('weekKey' in patch) && !('dayIndex' in patch)) return patch;
  const p = { ...patch } as Partial<RecurFields>;
  delete p.id; delete p.masterId; delete p.occDate; delete p.weekKey; delete p.dayIndex;
  return p as Partial<T>;
}

// ─── Wording ─────────────────────────────────────────────────────────────────

/**
 * The three choices, as sentences.
 *
 * They live here rather than in the menu because the phone and any future screen
 * must offer the same promise, and because a scope question phrased in terms of
 * the data model ("apply to master", "add EXDATE") is a question nobody can
 * answer. Each line says what will happen to the OTHER occurrences, since that
 * is the part a person is actually worried about.
 */
export function scopeChoices(action: 'edit' | 'delete'): { scope: OccurrenceScope; label: string; hint: string }[] {
  return action === 'edit'
    ? [
      { scope: 'one', label: 'Only this one', hint: 'The rest of the series stays exactly as it is' },
      { scope: 'following', label: 'This and everything after', hint: 'Earlier days keep the old version' },
      { scope: 'all', label: 'The whole series', hint: 'Every day this repeats on, past and future' },
    ]
    : [
      { scope: 'one', label: 'Only this one', hint: 'Every other day it repeats on stays' },
      { scope: 'following', label: 'This and everything after', hint: 'The series stops on the day before this one' },
      { scope: 'all', label: 'The whole series', hint: 'Removes every day this repeats on' },
    ];
}
