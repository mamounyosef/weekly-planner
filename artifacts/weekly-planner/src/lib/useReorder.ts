import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag-to-reorder for a row of chips or a column of cards.
 *
 * Pointer events rather than HTML5 drag-and-drop, for two reasons:
 *
 *  - HTML5 drag simply does not exist on a touch screen, so an arrow-button
 *    fallback would have to live on forever beside it.
 *  - It leaves HTML5 drag free for a DIFFERENT gesture on the same element —
 *    the tasks panel drops tasks onto list pills that way, and the two never
 *    collide because an HTML5 drag never emits pointermove.
 *
 * A mouse picks an item up after a few pixels of travel (so a plain click still
 * clicks); a finger picks it up after a short hold (so a plain swipe still
 * scrolls). Each item must carry `data-reorder-id="<id>"`.
 *
 * Draggable items deliberately do NOT set `touch-action`: pinning an axis would
 * stop the surrounding page (or rail) scrolling through them. Instead a finger
 * that moves before the hold expires abandons the pick-up, so a scroll gesture
 * always wins, and only a committed drag calls preventDefault.
 */
export interface ReorderOptions {
  /** 'y' for a stacked list (default), 'x' for a horizontal rail. */
  axis?: 'x' | 'y';
  /** Mouse travel, in px, before a drag begins. */
  threshold?: number;
  /** How long a finger must rest before a drag begins. */
  holdMs?: number;
  /**
   * Elements a drag must never start from. Defaults to everything you'd expect
   * to interact with instead. Pass a narrower selector when the draggable item
   * is itself a button.
   */
  ignore?: string;
}

export interface ReorderApi<E extends HTMLElement = HTMLDivElement> {
  containerRef: React.RefObject<E | null>;
  /** The item currently being dragged, if any. */
  dragId: string | null;
  /** The gap the item would drop into, 0..items.length. */
  dropIndex: number | null;
  startDrag: (e: React.PointerEvent<HTMLElement>, id: string) => void;
  /** True during the click that follows a drag, so that click can be ignored. */
  wasDragged: () => boolean;
}

const DEFAULT_IGNORE = 'input, textarea, select, button, a, [contenteditable], [data-no-drag]';

export function useReorder<T, E extends HTMLElement = HTMLDivElement>(
  items: T[],
  idOf: (item: T) => string,
  onReorder: (next: T[]) => void,
  { axis = 'y', threshold = 5, holdMs = 260, ignore = DEFAULT_IGNORE }: ReorderOptions = {},
): ReorderApi<E> {
  const containerRef = useRef<E | null>(null);
  const dragRef = useRef<{ id: string; origin: number; touch: boolean; timer: number; dragging: boolean } | null>(null);
  const gestureRef = useRef<AbortController | null>(null);
  const justDraggedRef = useRef(false);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Mirrored in a ref so the commit on pointerup can read the final gap without
  // doing work inside a setState updater, which React is free to run twice.
  const dropIndexRef = useRef<number | null>(null);
  const setGap = useCallback((gap: number | null) => {
    dropIndexRef.current = gap;
    setDropIndex(gap);
  }, []);

  /** Which gap the pointer is over, counting the dragged item in place. */
  const gapUnder = useCallback((point: number): number => {
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? []);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      const middle = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
      if (point < middle) return i;
    }
    return rows.length;
  }, [axis]);

  const end = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    gestureRef.current?.abort();
    gestureRef.current = null;
    if (!drag) return;
    window.clearTimeout(drag.timer);
    if (!drag.dragging) return;

    justDraggedRef.current = true;
    window.setTimeout(() => { justDraggedRef.current = false; }, 0);

    const gap = dropIndexRef.current;
    setDragId(null);
    setGap(null);
    if (!commit || gap === null) return;

    const from = items.findIndex(it => idOf(it) === drag.id);
    // The gap counts the dragged item itself, so a move further along lands one
    // slot short once that item is lifted out.
    const to = gap > from ? gap - 1 : gap;
    if (from < 0 || to === from) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  }, [items, idOf, onReorder, setGap]);

  const startDrag = useCallback((e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || items.length < 2) return;
    if (ignore && (e.target as HTMLElement).closest(ignore)) return;

    const touch = e.pointerType !== 'mouse';
    const origin = axis === 'x' ? e.clientX : e.clientY;

    const begin = () => {
      const drag = dragRef.current;
      if (!drag || drag.dragging) return;
      drag.dragging = true;
      setDragId(id);
      setGap(items.findIndex(it => idOf(it) === id));
      try { navigator.vibrate?.(10); } catch { /* unsupported */ }
    };

    dragRef.current = {
      id,
      origin,
      touch,
      timer: touch ? window.setTimeout(begin, holdMs) : 0,
      dragging: false,
    };

    gestureRef.current?.abort();
    const gesture = new AbortController();
    gestureRef.current = gesture;
    const { signal } = gesture;

    window.addEventListener('pointermove', ev => {
      const drag = dragRef.current;
      if (!drag) return;
      const point = axis === 'x' ? ev.clientX : ev.clientY;
      if (!drag.dragging) {
        // Moving before the hold expires means the user meant to scroll, so the
        // pick-up is abandoned rather than fought with.
        if (drag.touch) { if (Math.abs(point - drag.origin) > 12) end(false); }
        else if (Math.abs(point - drag.origin) > threshold) begin();
        if (!dragRef.current?.dragging) return;
      }
      setGap(gapUnder(point));
    }, { signal });
    window.addEventListener('pointerup', () => end(true), { signal });
    window.addEventListener('pointercancel', () => end(false), { signal });
    // touch-action is read when the gesture starts and this one only becomes a
    // drag partway through, so preventDefault is the only thing left that can
    // stop the page scrolling out from under the finger.
    document.addEventListener('touchmove', ev => {
      if (dragRef.current?.dragging && ev.cancelable) ev.preventDefault();
    }, { passive: false, signal });
  }, [items, idOf, axis, threshold, holdMs, ignore, gapUnder, end, setGap]);

  useEffect(() => () => { gestureRef.current?.abort(); }, []);

  const wasDragged = useCallback(() => justDraggedRef.current, []);

  return { containerRef, dragId, dropIndex, startDrag, wasDragged };
}
