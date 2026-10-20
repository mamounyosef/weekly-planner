import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useRightClickDragScroll(
  ref: RefObject<HTMLElement | null>,
  threshold = 6,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let active = false;
    let dragHappened = false;
    let startY = 0;
    let startScrollTop = 0;
    let suppressUntil = 0;

    const onContextMenu = (e: MouseEvent): void => {
      if (dragHappened || Date.now() < suppressUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 2) return;
      const target = e.target as Element | null;
      if (target && target.closest('[data-no-rcd]')) return;
      e.stopPropagation();
    };

    const onWindowPointerDown = (e: PointerEvent): void => {
      if (e.button !== 2) return;
      const target = e.target as Element | null;
      if (!target || !el.contains(target)) return;
      e.stopImmediatePropagation();
    };

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 2) return;
      const target = e.target as Element | null;
      if (target && target.closest('[data-no-rcd]')) return;
      e.stopPropagation();
      active = true;
      dragHappened = false;
      startY = e.clientY;
      startScrollTop = el.scrollTop;
      document.body.style.cursor = 'grab';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    };

    const onMove = (e: MouseEvent): void => {
      if (!active) return;
      if (!dragHappened && Math.abs(e.clientY - startY) <= threshold) return;
      if (!dragHappened) {
        dragHappened = true;
        suppressUntil = Date.now() + 300;
      }
      suppressUntil = Date.now() + 300;
      e.preventDefault();
      e.stopPropagation();
      document.body.style.cursor = 'grabbing';
      el.scrollTop = startScrollTop - (e.clientY - startY);
    };

    const onUp = (): void => {
      if (!active) return;
      active = false;
      if (dragHappened) suppressUntil = Date.now() + 300;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      document.body.style.cursor = ''
      window.setTimeout(() => {
        dragHappened = false;
      }, 0);
    };

    el.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerdown', onWindowPointerDown, true);
    el.addEventListener('mousedown', onMouseDown, true);
    el.addEventListener('contextmenu', onContextMenu, true);

    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      el.removeEventListener('pointerdown', onPointerDown, true);
      el.removeEventListener('mousedown', onMouseDown, true);
      el.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.body.style.cursor = '';
    };
  }, [ref, threshold]);
}