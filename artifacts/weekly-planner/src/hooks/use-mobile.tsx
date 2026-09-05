import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1100;

export interface Viewport {
  /** Live CSS pixel width of the visual viewport. */
  width: number;
  /** Live height. On phones this SHRINKS as the URL bar slides in — hence dvh. */
  height: number;
  /** Narrow screen: the phone shell (bottom nav, sheets, single-day grid). */
  isPhone: boolean;
  /** Mid-width: fewer toolbar controls, tasks panel as an overlay. */
  isTablet: boolean;
  /** The pointer is a finger — drives hit-target size and long-press gestures. */
  isTouch: boolean;
  isLandscape: boolean;
  /** Not much vertical room (a phone on its side): collapse the header to one row. */
  isShort: boolean;
  /** Height of the on-screen keyboard, when one is open (0 otherwise). */
  keyboardInset: number;
}

function read(prev?: Viewport): Viewport {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800, isPhone: false, isTablet: false, isTouch: false, isLandscape: true, isShort: false, keyboardInset: 0 };
  }
  const width = window.innerWidth;
  const height = window.innerHeight;

  // On Windows, minimizing a window drops its inner dimensions to 0x0.
  // This is a hidden desktop window, not a 0-pixel wide phone. Falling back
  // to the previous state prevents the app from inappropriately applying
  // mobile-only throttling to background processes.
  if (width === 0 && height === 0 && prev) {
    return prev;
  }

  /**
   * A COARSE PRIMARY POINTER, not "has a touchscreen somewhere".
   *
   * `maxTouchPoints > 0` is true on most touchscreen Windows laptops and every
   * 2-in-1, so a user sitting at a keyboard with a mouse was handed the phone
   * build of three interactions: drag-and-drop on task chips was switched off
   * in two places, and the editor stopped focusing its title field. They had
   * never touched the screen.
   *
   * `(pointer: coarse)` asks about the pointer actually in use, which is the
   * question. `maxTouchPoints` stays only as the fallback for a browser with
   * no matchMedia at all.
   */
  const canAskPointer = typeof window.matchMedia === 'function';
  const isTouch = canAskPointer
    ? window.matchMedia('(pointer: coarse)').matches
    : (navigator.maxTouchPoints ?? 0) > 0;
  // The visual viewport shrinks when the software keyboard opens.
  // Address bar / URL bar collapse can cause small jitter (< 32px), so we threshold.
  const vv = window.visualViewport;
  const rawInset = vv ? Math.max(0, height - vv.height - vv.offsetTop) : 0;
  const keyboardInset = rawInset > 32 ? Math.round(rawInset) : 0;
  /**
   * A phone turned sideways is 840px wide and still a phone — a touch device is
   * judged on its short edge so layout doesn't jump to desktop mode on rotate.
   */
  const isPhone = width < MOBILE_BREAKPOINT || (isTouch && Math.min(width, height) < 600);
  return {
    width,
    height,
    isPhone,
    isTablet: !isPhone && width < TABLET_BREAKPOINT,
    isTouch,
    isLandscape: width > height,
    isShort: height < 520,
    keyboardInset,
  };
}

// ── Shared Singleton Store ───────────────────────────────────────────────────
// Centralizes all window viewport subscriptions into ONE listener set, eliminating
// dozens of duplicate DOM event listeners and keeping React state updates coalesced.

let currentViewport: Viewport = read();
const listeners = new Set<() => void>();
let isListening = false;
let rafId = 0;

/**
 * The snapshot the subscribers were last woken for.
 *
 * Kept apart from `currentViewport` on purpose. The thresholds below are
 * measured against what the screen currently SHOWS, not against the last
 * reading -- comparing against the last reading lets a width drift past the
 * threshold eleven pixels at a time and never once re-render.
 */
let lastNotified: Viewport = currentViewport;

function notifySubscribers() {
  const next = read(currentViewport);
  const prev = lastNotified;

  const flagsSame =
    prev.isPhone === next.isPhone &&
    prev.isTablet === next.isTablet &&
    prev.isTouch === next.isTouch &&
    prev.isLandscape === next.isLandscape &&
    prev.isShort === next.isShort;

  const keyboardSame = Math.abs(prev.keyboardInset - next.keyboardInset) < 16;

  // THE SNAPSHOT IS ALWAYS COMMITTED; only the re-render is skipped.
  //
  // This used to `return` before the assignment, which is not the same thing.
  // A phone address bar sliding away changes the height without touching the
  // width, so the guard fired and `vp.height` stayed a whole address bar out of
  // date for everything that read it. Anything that renders for another reason
  // now sees the true size; nothing is woken up just for the jitter.
  currentViewport = next;

  if (flagsSame && keyboardSame) {
    if (next.isPhone && Math.abs(prev.width - next.width) < 12) {
      return; // Skip re-render for address-bar micro jitter
    }
    if (!next.isPhone && prev.width === next.width && Math.abs(prev.height - next.height) < 32) {
      return;
    }
  }

  lastNotified = next;
  for (const listener of listeners) {
    listener();
  }
}

function handleViewportChange() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    notifySubscribers();
  });
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  if (!isListening && typeof window !== 'undefined') {
    isListening = true;
    window.addEventListener('resize', handleViewportChange, { passive: true });
    window.addEventListener('orientationchange', handleViewportChange, { passive: true });
    window.visualViewport?.addEventListener('resize', handleViewportChange, { passive: true });
  }

  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && isListening && typeof window !== 'undefined') {
      isListening = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('orientationchange', handleViewportChange);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
    }
  };
}

function getSnapshot(): Viewport {
  return currentViewport;
}

function getServerSnapshot(): Viewport {
  return { width: 1280, height: 800, isPhone: false, isTablet: false, isTouch: false, isLandscape: true, isShort: false, keyboardInset: 0 };
}

export function useViewport(): Viewport {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIsMobile(): boolean {
  const vp = useViewport();
  return vp.isPhone;
}

/** Short buzz for a confirmed touch gesture (drag armed, event created). */
export function haptic(pattern: number | number[] = 12) {
  try { navigator.vibrate?.(pattern); } catch (_) { /* unsupported — silent */ }
}
