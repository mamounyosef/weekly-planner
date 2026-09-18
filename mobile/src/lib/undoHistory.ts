// ─── Undo / redo for planner items ───────────────────────────────────────────
//
// An undo in a syncing app cannot be a snapshot restore: the change may already
// be on the server, and dropping it from the local outbox would only be undone
// until the next pull handed it straight back. So an undo here is ITSELF an
// edit — the "before" image is re-applied as ordinary ops, with a fresh
// lamport, and syncs to every peer like the change it reverts did.
//
// Each entry therefore keeps both images of every record it touched, taken from
// the readable snapshots either side of one user action:
//   before/after = null   → the record did not exist on that side.
// Undo walks the entry backwards, redo forwards; both travel through the same
// edit path the original action used.

import {
  DELETED_FIELD, isTombstoned, peekEntity, readEntity,
  type SyncState, type SyncStore,
} from './sync';
import { readClientStore, type ClientData } from './syncClient';

/** One record's two images. `null` means "did not exist" on that side. */
export interface UndoChange {
  store: SyncStore;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Everything ONE user action touched, applied or reverted as one step. */
export interface UndoEntry {
  /** What the action was, for the button's caption. */
  label: string;
  changes: UndoChange[];
}

/** The stores undo covers: the planner items themselves, not settings. */
export const UNDO_STORES: readonly SyncStore[] = ['events', 'tasks'];

/** Plenty for a session, small enough to never matter for memory. */
const MAX_HISTORY = 100;

export function createUndoHistory() {
  let past: UndoEntry[] = [];
  let future: UndoEntry[] = [];

  return {
    /** Record one finished action. Anything newly done clears the redo half. */
    push(entry: UndoEntry): void {
      if (entry.changes.length === 0) return;
      past.push(entry);
      if (past.length > MAX_HISTORY) past.shift();
      future = [];
    },
    undo(): UndoEntry | null {
      const entry = past.pop();
      if (!entry) return null;
      future.push(entry);
      return entry;
    },
    redo(): UndoEntry | null {
      const entry = future.pop();
      if (!entry) return null;
      past.push(entry);
      return entry;
    },
    canUndo(): boolean { return past.length > 0; },
    canRedo(): boolean { return future.length > 0; },
    undoLabel(): string | null { return past.length > 0 ? past[past.length - 1].label : null; },
    redoLabel(): string | null { return future.length > 0 ? future[future.length - 1].label : null; },
  };
}

export type UndoHistory = ReturnType<typeof createUndoHistory>;

/**
 * Which readable records differ between two states.
 *
 * Both sides come from `readClientStore`, so key order is sorted and values are
 * plain JSON — a string compare is an honest equality here, and it sees a
 * deleted record as `null` on the after side because tombstones are hidden.
 */
export function diffForUndo(previous: ClientData, next: ClientData): UndoChange[] {
  const out: UndoChange[] = [];
  for (const store of UNDO_STORES) {
    const before = readClientStore(previous, store);
    const after = readClientStore(next, store);
    const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const entityId of ids) {
      const was = before[entityId] ?? null;
      const now = after[entityId] ?? null;
      if (JSON.stringify(was) !== JSON.stringify(now)) {
        out.push({ store, entityId, before: was, after: now });
      }
    }
  }
  return out;
}

/**
 * The edits that move the planner one step along an entry, ready for
 * `applyLocalChanges`.
 *
 * Restoring goes through per-field ops, NOT the snapshot path: that one refuses
 * to touch a tombstoned id ("never resurrect"), while undoing a delete is
 * precisely a resurrection. Writing `__deleted: false` is the same op the
 * conflict card's "keep" makes, so every peer already understands it.
 */
export function restoreChanges(
  entry: UndoEntry,
  direction: 'undo' | 'redo',
  state: SyncState,
): ReadonlyArray<{ store: SyncStore; entityId: string; changes: Record<string, unknown> }> {
  return entry.changes.map((c) => {
    const target = direction === 'undo' ? c.before : c.after;

    // The record did not exist in the state we are moving to: tombstone it,
    // exactly as the remove path would have.
    if (!target) {
      return { store: c.store, entityId: c.entityId, changes: { [DELETED_FIELD]: true } };
    }

    const gone = isTombstoned(state, c.store, c.entityId);
    // A tombstone hides the record from `readEntity`, but its fields are still
    // there under it — `peekEntity` sees through the tombstone. One of the two
    // always answers, including the set fields, which is what makes the
    // clearing below cover a `completedDates` the undo must take back.
    const raw = (gone ? peekEntity : readEntity)(state, c.store, c.entityId);
    const changes: Record<string, unknown> = { ...target };

    // Fields the record has NOW but the target image lacks were added after it.
    // An absent field emits no op, so they must be cleared EXPLICITLY or they
    // would quietly survive the undo.
    for (const field of Object.keys(raw ?? {})) {
      if (field === DELETED_FIELD) continue;
      if (!(field in changes)) changes[field] = undefined;
    }
    if (gone) changes[DELETED_FIELD] = false;

    return { store: c.store, entityId: c.entityId, changes };
  });
}
