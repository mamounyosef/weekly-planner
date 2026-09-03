// Who is currently stopping a scroller from scrolling.
//
// WHY THIS IS COUNTED AND NOT A BOOLEAN
// A screen holds several sortable lists, and a list can hold another one: the
// steps inside a task card are a list inside the list of tasks. Any of them may
// be mid-drag, and the page must stay locked until the LAST of them has let go.
// A boolean gets this wrong in the one case that actually happens -- a drag
// inside a card ending while the card's own list is still held -- and the
// symptom is a page that can never be scrolled again until the screen is left.
//
// WHY IT IS A MODULE AND NOT FOUR LINES IN THE COMPONENT
// Every interesting case here is one that cannot be produced by hand: a release
// arriving after the row that sent it has unmounted, the same hold applied
// twice, an unmount releasing a hold nobody took. Those are the ones that leave
// a screen stuck, and they are trivial to test here and impossible to test
// through a gesture.

/** No holds at all. A shared empty array, so an idle screen allocates nothing. */
export const NO_HOLDS: readonly number[] = Object.freeze([]);

/**
 * Take or release one hold.
 *
 * Returns the SAME array when nothing changed. That is not a micro-optimisation:
 * the caller feeds this straight into React state, and a fresh array every time
 * a row re-registers the hold it already has would re-render the whole scroller
 * (and every list inside it) in the middle of a drag.
 *
 * Ids that are not real numbers are ignored rather than stored. A hold under a
 * key that can never be produced again is a hold that can never be released,
 * and the page it belongs to would be frozen for as long as it is open.
 */
export function setHold(held: readonly number[], id: number, on: boolean): readonly number[] {
  if (!Number.isFinite(id)) return held;

  const has = held.indexOf(id) !== -1;
  if (on === has) return held;
  if (on) return [...held, id];

  const next = held.filter(x => x !== id);
  // Back to nothing held: hand back the shared empty array so that two idle
  // scrollers compare equal.
  return next.length === 0 ? NO_HOLDS : next;
}

/** Is anything holding the scroller? */
export function isHeld(held: readonly number[]): boolean {
  return held.length > 0;
}

/**
 * Release every hold.
 *
 * For the case where the whole list unmounts mid-drag: nothing will ever arrive
 * to release the individual holds, because the things that took them are gone.
 */
export function releaseAll(held: readonly number[]): readonly number[] {
  return held.length === 0 ? held : NO_HOLDS;
}
