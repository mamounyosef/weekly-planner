import { useSyncExternalStore } from 'react';

/*
 * The PC app's own title bar.
 *
 * In the desktop window (WebView2 hosted by widget-window.py) the native
 * Windows caption is removed and the app draws its own min/max/close buttons
 * into its toolbar. The Python side exposes the window calls on
 * `window.pywebview.api` (MainApi) and only strips the caption once the page
 * asks for it, so this module is also what turns the feature on.
 *
 * In any other browser (the phone, the public link) there is no such api and
 * everything here stays inert: `active` is false and no insets are applied.
 */

type FrameState = { active: boolean; maximized: boolean };

interface MainWindowApi {
  enable_custom_frame(): Promise<{ custom: boolean; maximized: boolean }>;
  window_state(): Promise<{ custom: boolean; maximized: boolean }>;
  minimize(): Promise<void>;
  toggle_maximize(): Promise<{ custom: boolean; maximized: boolean }>;
  close(): Promise<void>;
}

/** Height of the app's own title bar (CSS px, unzoomed). */
export const TITLE_BAR_HEIGHT = 36;

let state: FrameState = { active: false, maximized: false };
const listeners = new Set<() => void>();

function setState(next: FrameState) {
  if (next.active === state.active && next.maximized === state.maximized) return;
  state = next;
  // Pushes every page down below the bar (see index.css, html[data-titlebar]).
  document.documentElement.toggleAttribute('data-titlebar', next.active);
  document.documentElement.style.setProperty('--titlebar-h', next.active ? `${TITLE_BAR_HEIGHT}px` : '0px');
  listeners.forEach(l => l());
}

function api(): MainWindowApi | null {
  const a = (window as unknown as { pywebview?: { api?: Partial<MainWindowApi> } }).pywebview?.api;
  return a && typeof a.enable_custom_frame === 'function' ? (a as MainWindowApi) : null;
}

let started = false;

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;

  const enable = () => {
    const a = api();
    if (!a) return false;
    a.enable_custom_frame()
      .then(s => setState({ active: !!s?.custom, maximized: !!s?.maximized }))
      .catch(() => {});
    return true;
  };

  if (!enable()) {
    // pywebview injects its bridge after the page starts, then fires this.
    window.addEventListener('pywebviewready', () => { enable(); }, { once: true });
  }

  // Maximize / restore always resizes the page, whichever way it happened
  // (button, double-click on the bar, Win+Up, Snap), so that is when to ask.
  let pending = 0;
  window.addEventListener('resize', () => {
    if (!state.active) return;
    window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      api()?.window_state()
        .then(s => setState({ active: !!s?.custom, maximized: !!s?.maximized }))
        .catch(() => {});
    }, 60);
  });
}

function subscribe(cb: () => void) {
  start();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const getSnapshot = () => state;

/** Whether this window draws its own title bar, and whether it is maximized. */
export function useDesktopFrame(): FrameState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const windowControls = {
  minimize: () => { api()?.minimize().catch(() => {}); },
  toggleMaximize: () => {
    api()?.toggle_maximize()
      .then(s => setState({ active: !!s?.custom, maximized: !!s?.maximized }))
      .catch(() => {});
  },
  close: () => { api()?.close().catch(() => {}); },
};
