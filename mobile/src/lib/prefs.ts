// ─── Device preferences and credentials ──────────────────────────────────────
// The server address and the session cookie. The cookie goes in SecureStore
// (hardware-backed keystore on Android) because it is a bearer credential for
// the whole planner; the address is ordinary settings.
//
// Everything below the credentials is a VIEW preference, and every one of them
// is deliberately per device. The PC keeps its own copies in
// `DEVICE_SCOPED_KEYS` (see `artifacts/weekly-planner/src/lib/deviceSettings.ts`)
// and the sync layer refuses to carry them, so a phone showing a two column
// Span view from 6am and a desktop showing a full week from 8am is the correct
// state of affairs rather than a disagreement to resolve.
//
// WHAT COUNTS AS A VALID VALUE IS NOT DECIDED HERE. It lives in `viewPrefs.ts`,
// which is the same file the PC uses, copied across the way the sync engine is.
// A store hands back strings and nulls, never numbers, and the phone and the PC
// disagreeing about whether '25' is an hour would be a layout bug on one device
// that is invisible on the other.

import * as SecureStore from 'expo-secure-store';
import { makeDeviceId } from './syncStorage';
import { isThemeMode, type ThemeMode } from '../theme';
import {
  DEFAULT_SWIPE_VIEW_SWITCH,
  coerceBool,
  coerceDayWindow,
  coerceSnapInterval,
  coerceSpanWindow,
  encodeBool,
  withDayEnd,
  withDayStart,
  type DayWindow,
  type SnapInterval,
  type SpanWindow,
} from './viewPrefs';

const KEY_SERVER = 'planner.serverUrl';
const KEY_SESSION = 'planner.session';
const KEY_DEVICE = 'planner.deviceId';
const KEY_USER = 'planner.username';
const KEY_VIEW = 'planner.calendarView';
const KEY_INTERVAL = 'planner.interval';
const KEY_THEME = 'planner.themeMode';
const KEY_CUSTOM_BEFORE = 'planner.customDaysBefore';
const KEY_CUSTOM_AFTER = 'planner.customDaysAfter';
const KEY_DAY_START = 'planner.dayStartH';
const KEY_DAY_END = 'planner.dayEndH';
const KEY_SWIPE_VIEWS = 'planner.swipeViewSwitch';

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // A locked keystore (right after a reboot, before first unlock) throws
    // rather than returning null. Treat it as "not set" and let the user sign in
    // again, which is far better than crashing on launch.
    return null;
  }
}

async function write(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    /* nothing useful to do; the user can re-enter it */
  }
}

export const prefs = {
  getServerUrl: () => read(KEY_SERVER),
  setServerUrl: (url: string | null) => write(KEY_SERVER, url),

  getSession: () => read(KEY_SESSION),
  setSession: (session: string | null) => write(KEY_SESSION, session),

  getUsername: () => read(KEY_USER),
  setUsername: (name: string | null) => write(KEY_USER, name),

  /**
   * This install's device id, created once and kept forever.
   *
   * It must never change: the server tracks how far each device has synced by
   * this id, so a new one would orphan the old cursor and force a full resync —
   * and, worse, the phone would start receiving its own past ops back.
   */
  async getDeviceId(): Promise<string> {
    const existing = await read(KEY_DEVICE);
    if (existing) return existing;
    const fresh = makeDeviceId(Math.random, 'android');
    await write(KEY_DEVICE, fresh);
    return fresh;
  },

  /**
   * Which calendar view this phone was last left on.
   *
   * PER DEVICE, DELIBERATELY, and the PC agrees: `calendarView` is in its
   * `DEVICE_SCOPED_KEYS`, so a phone showing the day and a desktop showing the
   * week is the correct state of affairs rather than a disagreement to resolve.
   * Kept here rather than in the synced settings for exactly that reason.
   *
   * Returned raw because the phone has one view the PC does not (`agenda`), so
   * the caller owns the list of names and validates it there.
   */
  getCalendarView: () => read(KEY_VIEW),
  setCalendarView: (view: string) => write(KEY_VIEW, view),

  /**
   * How coarsely times snap on this device: 5, 10, 15, 30 or 60 minutes.
   *
   * Per device, like the view, and for the same reason — the PC keeps
   * `interval` in its own `DEVICE_SCOPED_KEYS`. Fifteen minutes suits a mouse on
   * a wide grid; a thumb on a phone wants bigger steps, and the PC's own
   * `seedDeviceSettings` already drops a new phone to thirty.
   */
  async getInterval(): Promise<SnapInterval> {
    return coerceSnapInterval(await read(KEY_INTERVAL));
  },
  setInterval: (minutes: number) => write(KEY_INTERVAL, String(minutes)),

  /**
   * The Custom view's window: how many days back, and how many forward.
   *
   * Per device, like the view itself. A phone wants a narrower window than a
   * 27-inch monitor, and the PC keeps `customDaysBefore` and `customDaysAfter`
   * in its own device-scoped settings for exactly that reason.
   */
  async getCustomWindow(): Promise<SpanWindow> {
    const [b, a] = await Promise.all([read(KEY_CUSTOM_BEFORE), read(KEY_CUSTOM_AFTER)]);
    return coerceSpanWindow(b, a);
  },
  async setCustomWindow(before: number, after: number): Promise<void> {
    // Clamped on the way IN as well as on the way out. A value that is illegal
    // on read is illegal on write, and storing it anyway leaves a number in the
    // keystore that silently becomes something else next launch.
    const win = coerceSpanWindow(before, after);
    await write(KEY_CUSTOM_BEFORE, String(win.before));
    await write(KEY_CUSTOM_AFTER, String(win.after));
  },

  /**
   * The visible window of the time grid: the first hour drawn and the hour it
   * stops at, matching the PC's `dayStartH` and `dayEndH`.
   *
   * Per device for the plainest reason of all: a phone shows perhaps a tenth of
   * the pixels a desktop does, so a window that reads comfortably on the desk is
   * a wall of unreadable slivers in your hand. Somebody who wants 7am to 11pm at
   * work and 6am to midnight on the phone is not in an inconsistent state.
   *
   * The two hours are stored SEPARATELY, which is why they are always read back
   * as a pair through `coerceDayWindow`: two independent writes can be
   * interrupted between them, and a start of 20 with a stale end of 6 would draw
   * a grid of negative height. `viewPrefs` repairs the pair rather than trusting
   * that they were written together, because they were not.
   */
  async getDayWindow(): Promise<DayWindow> {
    const [start, end] = await Promise.all([read(KEY_DAY_START), read(KEY_DAY_END)]);
    return coerceDayWindow(start, end);
  },
  async setDayWindow(win: DayWindow): Promise<void> {
    const safe = coerceDayWindow(win.start, win.end);
    await write(KEY_DAY_START, String(safe.start));
    await write(KEY_DAY_END, String(safe.end));
  },
  /**
   * Move one end of the window and persist the pair.
   *
   * These take the CURRENT window rather than reading it back, so the settings
   * screen stays the single source of what is on screen and a tap never waits on
   * the keystore before the number moves. `withDayStart` carries the span along,
   * `withDayEnd` pushes the start out of the way, and both guarantee start < end
   * whichever control the user reaches for first.
   */
  async setDayStart(current: DayWindow, hour: number): Promise<DayWindow> {
    const next = withDayStart(current, hour);
    await prefs.setDayWindow(next);
    return next;
  },
  async setDayEnd(current: DayWindow, hour: number): Promise<DayWindow> {
    const next = withDayEnd(current, hour);
    await prefs.setDayWindow(next);
    return next;
  },

  /**
   * Whether a sideways swipe moves between views.
   *
   * The PC calls this `mobileSwipeViewSwitch` and keeps it per device, which is
   * the only sensible place for it: the same gesture is how you drag a wide grid
   * sideways, so on a narrow screen the two can fight, and whether they do
   * depends entirely on the size of the screen doing the swiping.
   */
  async getSwipeViewSwitch(): Promise<boolean> {
    return coerceBool(await read(KEY_SWIPE_VIEWS), DEFAULT_SWIPE_VIEW_SWITCH);
  },
  setSwipeViewSwitch: (on: boolean) => write(KEY_SWIPE_VIEWS, encodeBool(on)),

  /**
   * Light, dark, or whatever the phone is set to.
   *
   * Per device, like the view and the interval, and deliberately NOT in the
   * synced settings: appearance is a property of the screen in your hand, not of
   * the planner, so the PC must never be able to push its choice here.
   */
  async getThemeMode(): Promise<ThemeMode> {
    const raw = await read(KEY_THEME);
    return isThemeMode(raw) ? raw : 'system';
  },
  setThemeMode: (mode: ThemeMode) => write(KEY_THEME, mode),

  async signOut(): Promise<void> {
    await write(KEY_SESSION, null);
    await write(KEY_USER, null);
    // The server URL and device id deliberately survive signing out: the user is
    // almost always signing back into the same planner on the same phone.
    // So do the view preferences: they describe this screen, not this account.
  },
};
