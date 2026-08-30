// ─── Device preferences and credentials ──────────────────────────────────────
// The server address and the session cookie. The cookie goes in SecureStore
// (hardware-backed keystore on Android) because it is a bearer credential for
// the whole planner; the address is ordinary settings.

import * as SecureStore from 'expo-secure-store';
import { makeDeviceId } from './syncStorage';
import { isThemeMode, type ThemeMode } from '../theme';

const KEY_SERVER = 'planner.serverUrl';
const KEY_SESSION = 'planner.session';
const KEY_DEVICE = 'planner.deviceId';
const KEY_USER = 'planner.username';
const KEY_VIEW = 'planner.calendarView';
const KEY_INTERVAL = 'planner.interval';
const KEY_THEME = 'planner.themeMode';
const KEY_CUSTOM_BEFORE = 'planner.customDaysBefore';
const KEY_CUSTOM_AFTER = 'planner.customDaysAfter';

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
  async getInterval(): Promise<number> {
    const raw = await read(KEY_INTERVAL);
    const n = Number(raw);
    return n === 5 || n === 10 || n === 15 || n === 30 || n === 60 ? n : 30;
  },
  setInterval: (minutes: number) => write(KEY_INTERVAL, String(minutes)),

  /**
   * The Custom view's window: how many days back, and how many forward.
   *
   * Per device, like the view itself. A phone wants a narrower window than a
   * 27-inch monitor, and the PC keeps `customDaysBefore` and `customDaysAfter`
   * in its own device-scoped settings for exactly that reason.
   */
  async getCustomWindow(): Promise<{ before: number; after: number }> {
    const [b, a] = await Promise.all([read(KEY_CUSTOM_BEFORE), read(KEY_CUSTOM_AFTER)]);
    const clamp = (raw: string | null, fallback: number) => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 14 ? Math.floor(n) : fallback;
    };
    return { before: clamp(b, 1), after: clamp(a, 3) };
  },
  async setCustomWindow(before: number, after: number): Promise<void> {
    await write(KEY_CUSTOM_BEFORE, String(before));
    await write(KEY_CUSTOM_AFTER, String(after));
  },

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
  },
};
