import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1100;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener('change', onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return !!isMobile;
}

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

function read(): Viewport {
  if (typeof window === 'undefined') {
    return { width: 1280, height: 800, isPhone: false, isTablet: false, isTouch: false, isLandscape: true, isShort: false, keyboardInset: 0 };
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  const isTouch =
    (window.matchMedia?.('(pointer: coarse)').matches ?? false) ||
    (navigator.maxTouchPoints ?? 0) > 1;
  // The visual viewport shrinks when the software keyboard opens; the layout
  // viewport does not. The difference is how much of the screen the keyboard ate.
  const vv = window.visualViewport;
  const keyboardInset = vv ? Math.max(0, height - vv.height - vv.offsetTop) : 0;
  /**
   * A phone turned sideways is 840px wide and still a phone — a width-only test
   * hands it the full desktop toolbar and a docked 340px tasks panel on a 412px
   * -tall screen. So a touch device is judged on its SHORT edge, which doesn't
   * change when the device rotates.
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

/**
 * One subscription to every way a mobile viewport can change: rotation, the
 * URL bar sliding away, the keyboard opening, a desktop window being resized.
 * Updates are rAF-coalesced because `resize` fires per frame during a rotation
 * and re-rendering a full calendar grid on each of those frames is visible.
 */
export function useViewport(): Viewport {
  const [vp, setVp] = React.useState<Viewport>(read);

  React.useEffect(() => {
    let frame = 0;
    const onChange = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVp(prev => {
          const next = read();
          // Skip the re-render when nothing that matters actually moved.
          if (
            prev.width === next.width && prev.height === next.height &&
            prev.isTouch === next.isTouch && prev.keyboardInset === next.keyboardInset
          ) return prev;
          return next;
        });
      });
    };
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    window.visualViewport?.addEventListener('resize', onChange);
    window.visualViewport?.addEventListener('scroll', onChange);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
      window.visualViewport?.removeEventListener('resize', onChange);
      window.visualViewport?.removeEventListener('scroll', onChange);
    };
  }, []);

  return vp;
}

/** Short buzz for a confirmed touch gesture (drag armed, event created). */
export function haptic(pattern: number | number[] = 12) {
  try { navigator.vibrate?.(pattern); } catch (_) { /* unsupported — silent */ }
}
