// A callback ref that only ever clears a shared ref for ITS OWN element.
//
// Why: the week grid is drawn inside an animated, keyed shell. When the week or
// view changes, the new copy mounts and fills the shared ref, then the old copy
// finishes fading out and unmounts. A plain `ref={someRef}` makes React set
// `someRef.current = null` at that moment, wiping out the NEW element. With the
// grid ref gone, dragging items, drag-to-create and the "Go to Live" pill all
// silently stopped working until the page was reloaded.
//
// Make one per mounted copy (memoise it on the same key as the shell), so each
// copy's callback remembers which element it owns.

export interface MutableRef<T> { current: T | null }

export function ownedRef<T>(ref: MutableRef<T>): (el: T | null) => void {
  let mine: T | null = null;
  return (el: T | null) => {
    if (el) {
      mine = el;
      ref.current = el;
      return;
    }
    if (mine !== null && ref.current === mine) ref.current = null;
    mine = null;
  };
}
