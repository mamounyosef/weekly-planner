// Ticking something off, drawn before it is written.
//
// WHY A TICK IS NOT SIMPLY A WRITE
// Writing straight through is correct and feels broken. The box only fills once
// the store has been changed, every screen kept alive has re-rendered and the
// board has been regrouped, and on a phone that is long enough to read as the
// tap not having landed. Worse, on the task board the row leaves for the Done
// section in the very frame the box fills, so there is nothing to look at.
//
// So a tick is HELD: the screen believes it immediately and writes it a moment
// later. That buys three things, and costs one rule each.
//
//   1. The box fills on the finger, not on the data.
//   2. The row stays where it is for long enough to see it happen.
//   3. Tapping again inside the hold is a free undo: nothing was ever written,
//      so there is no op, no sync and nothing for the other machine to merge.
//
// The rules, which is what this file is:
//   * UN-TICKING IS NEVER HELD. Nobody wants to admire that, and a held un-tick
//     would make "tick, un-tick, tick" ambiguous.
//   * A HELD TICK IS FLUSHED, NOT CANCELLED, if the screen goes away. The tap
//     happened; the delay is ours, not the user's.
//   * A GUESS IS DROPPED once the store agrees with it, or after a few seconds
//     whatever happened, so a write that never landed shows the truth again
//     rather than a tick that is a lie.

/** What a tap on a tick box should do. */
export type TickPlan =
  /** Write it now: this is an un-tick, and those are never held. */
  | 'write'
  /** Believe it, and write it after the hold. */
  | 'hold'
  /** A second tap inside the hold: forget the whole thing, write nothing. */
  | 'cancel';

/**
 * `stored` is what the store says. `pending` is what this screen has already
 * promised the user. They are different questions and the plan needs both: a
 * row that is pending-done but not stored-done is exactly the undo case, and
 * reading only one of them turns that into a double write.
 */
export function planTick(stored: boolean, pending: boolean): TickPlan {
  if (stored) return 'write';
  if (pending) return 'cancel';
  return 'hold';
}

/** What the row should DRAW, as opposed to what the store holds. */
export function shownDone(stored: boolean, pending: boolean): boolean {
  return stored || pending;
}

export type PendingMap = Readonly<Record<string, boolean>>;

export function isPending(state: PendingMap, key: string): boolean {
  return state[key] === true;
}

/**
 * Add or remove a key.
 *
 * Returns the SAME object when nothing changes. A new map on every tap would
 * re-render every row in the list to say that none of them moved.
 */
export function setPending(state: PendingMap, key: string, on: boolean): PendingMap {
  if (on) {
    if (state[key] === true) return state;
    return { ...state, [key]: true };
  }
  if (!(key in state)) return state;
  const next = { ...state };
  delete next[key];
  return next;
}

/**
 * Overlay the guesses onto a list of items that carry their own `completed`.
 *
 * Used by the day view, where a ticked row stays where it is and only needs to
 * look done. Both identities are preserved wherever nothing is being guessed:
 * the array itself when there are no guesses at all, and each item when its
 * guess already agrees with what the store came back with. That is what stops
 * a stale guess from re-rendering the whole day once a second.
 */
export function applyGuesses<T extends { completed: boolean }>(
  items: readonly T[],
  keyOf: (item: T) => string,
  guesses: PendingMap,
): readonly T[] {
  let changed = false;
  const out = items.map(item => {
    const guess = guesses[keyOf(item)];
    if (guess === undefined || guess === item.completed) return item;
    changed = true;
    return { ...item, completed: guess };
  });
  return changed ? out : items;
}
