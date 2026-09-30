import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Mouse wheel over a horizontally scrolling row scrolls it sideways
 * (wheel up = left, wheel down = right). At either end, or when the row does
 * not overflow, the event is left alone so the page behind it still scrolls.
 */
export function useWheelScrollX(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1 || e.deltaY === 0) return;
      // deltaMode 1 = lines, 2 = pages; normalise to pixels.
      const px = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY;
      const next = Math.max(0, Math.min(max, el.scrollLeft + px));
      if (next === el.scrollLeft) return;
      el.scrollLeft = next;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}
