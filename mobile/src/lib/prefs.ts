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
//
// ── WHERE EACH THING LIVES, AND WHY ─────────────────────────────────────────
// The view preferences used to be keystore entries too, one Android Keystore
// decrypt each, dispatched on a single serial Expo queue. About fifteen of them
// stood between tapping the icon and seeing the planner, which was the largest
// single cost in the whole launch. None of them is a secret.
//
// So they moved into the SQLite database the app opens anyway, where the entire
// set is ONE query and every later read is memory (see `prefsStore.ts`, which
// owns the migration and its failure modes). The keystore now holds only the
// four things that are genuinely about identity:
//
//     planner.session   the bearer cookie
//     planner.deviceId  what the server's sync cursor is keyed by
//     planner.serverUrl / planner.username
//
// Those four are NOT in `PREF_KEYS` and nothing in the new path can touch them,
// which is what makes "this change signed me out" not a thing that can happen.
//
// The public API here is still async everywhere, so no caller changed. After
// the first load these resolve from memory in the same tick.

import * as SecureStore from 'expo-secure-store';
import { makeDeviceId } from './syncStorage';
import { createPrefsStore, type PrefsSql, type PrefsStore } from './prefsStore';
import { createExpoRunner, openPlannerDatabase } from './sqlite';
import { FULL_DAY, normaliseRanges, type HourRange } from './dayWindows';
import { coerceNotificationSettings, type NotificationSettings } from './notifications';
import { isThemeMode, type ThemeMode } from '../theme';
import { coerceFocusRangeMode, type FocusRangeMode } from './focusPeriod';
import { coerceSortMode, type SortMode } from './taskBoard';
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
  DEFAULT_PRAYER_APPEARANCE,
  coercePrayerAppearance,
  type PrayerAppearance,
} from './viewPrefs';

// ── The keystore's four. Never in PREF_KEYS. ──
const KEY_SERVER = 'planner.serverUrl';
const KEY_SESSION = 'planner.session';
const KEY_DEVICE = 'planner.deviceId';
const KEY_USER = 'planner.username';

// ── The settings, all of which live in SQLite now. ──
const KEY_VIEW = 'planner.calendarView';
const KEY_INTERVAL = 'planner.interval';
const KEY_THEME = 'planner.themeMode';
const KEY_FOCUS_TIMER = 'planner.focusTimer';
const KEY_NOTIFY_CENTRE = 'planner.notifyCentre';
const KEY_PRAYER_LOOK = 'planner.prayerAppearance';
const KEY_VISIBLE_HOURS = 'planner.visibleHours';
const KEY_CUSTOM_BEFORE = 'planner.customDaysBefore';
const KEY_CUSTOM_AFTER = 'planner.customDaysAfter';
const KEY_DAY_START = 'planner.dayStartH';
const KEY_DAY_END = 'planner.dayEndH';
const KEY_SWIPE_VIEWS = 'planner.swipeViewSwitch';
const KEY_FOCUS_RANGE_MODE = 'planner.focusRangeMode';
const KEY_TASK_SORT = 'planner.taskSort';
const KEY_HIDDEN_CATEGORIES = 'planner.hiddenCategoriesByView';
/**
 * This phone's OWN reminder rules, used only while sharing is switched off.
 *
 * Kept here rather than in the synced settings for the obvious reason: the
 * whole point is that it does not travel. Absent until the phone actually
 * changes something of its own, which is what lets switching sharing off carry
 * on with the rules you already had instead of dropping back to the defaults.
 */
const KEY_NOTIFICATIONS_LOCAL = 'planner.notificationsLocal';

/**
 * Exactly what the fast store owns.
 *
 * Adding a key here is how a new preference gets the fast path. Removing one,
 * or adding a credential to it, is how the launch gets slow again or how a
 * token ends up in plain SQL — so the list is short, explicit, and reviewed.
 */
export const PREF_KEYS = [
  KEY_VIEW,
  KEY_INTERVAL,
  KEY_THEME,
  KEY_FOCUS_TIMER,
  KEY_NOTIFY_CENTRE,
  KEY_PRAYER_LOOK,
  KEY_VISIBLE_HOURS,
  KEY_CUSTOM_BEFORE,
  KEY_CUSTOM_AFTER,
  KEY_DAY_START,
  KEY_DAY_END,
  KEY_SWIPE_VIEWS,
  KEY_FOCUS_RANGE_MODE,
  KEY_TASK_SORT,
  KEY_HIDDEN_CATEGORIES,
  KEY_NOTIFICATIONS_LOCAL,
] as const;

async function secureRead(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // A locked keystore (right after a reboot, before first unlock) throws
    // rather than returning null. Treat it as "not set" and let the user sign in
    // again, which is far better than crashing on launch.
    return null;
  }
}

async function secureWrite(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    /* nothing useful to do; the user can re-enter it */
  }
}

/**
 * The fast store, built on first use.
 *
 * Built lazily rather than at import: the theme provider asks for a value
 * before the planner has opened anything, and whichever of the two gets here
 * first should be the one that starts the database opening. They then share the
 * one handle, because `openPlannerDatabase` memoises its promise.
 */
let storePromise: Promise<PrefsStore> | null = null;

function getStore(): Promise<PrefsStore> {
  if (!storePromise) {
    storePromise = (async () => {
      let sql: PrefsSql | null = null;
      try {
        sql = createExpoRunner(await openPlannerDatabase());
      } catch {
        // No database means the old, slow, entirely correct path.
        sql = null;
      }
      const store = createPrefsStore({
        sql,
        secure: {
          get: secureRead,
          set: (k, v) => secureWrite(k, v),
          remove: k => secureWrite(k, null),
        },
        keys: PREF_KEYS,
      });
      await store.load();
      return store;
    })();
  }
  return storePromise;
}

/**
 * Start the store warming without waiting for it.
 *
 * Called at the very top of launch so the one query is already in flight while
 * notification channels and the sync database are being set up.
 */
export function warmPrefs(): void {
  void getStore().catch(() => { /* getStore already degrades on its own */ });
}

/** Read one owned key. Resolves from memory once the first load has landed. */
async function read(key: string): Promise<string | null> {
  const store = await getStore();
  return store.get(key);
}

/** Write one owned key. Applies to memory at once; the disk catches up. */
function write(key: string, value: string | null): Promise<void> {
  return getStore().then(store => { store.set(key, value); });
}

/** Persist anything still queued. Called when the app goes to the background. */
export async function flushPrefs(): Promise<void> {
  const store = await getStore().catch(() => null);
  if (store) await store.flush();
}

/** What the launch actually did, for the diagnostics screen. */
export async function prefsReport() {
  const store = await getStore().catch(() => null);
  return store?.lastReport() ?? null;
}

export const prefs = {
  getServerUrl: () => secureRead(KEY_SERVER),
  setServerUrl: (url: string | null) => secureWrite(KEY_SERVER, url),

  getSession: () => secureRead(KEY_SESSION),
  setSession: (session: string | null) => secureWrite(KEY_SESSION, session),

  getUsername: () => secureRead(KEY_USER),
  setUsername: (name: string | null) => secureWrite(KEY_USER, name),

  /**
   * This install's device id, created once and kept forever.
   *
   * It must never change: the server tracks how far each device has synced by
   * this id, so a new one would orphan the old cursor and force a full resync —
   * and, worse, the phone would start receiving its own past ops back.
   *
   * Which is exactly why it stays in the keystore, alone, on the old path. It
   * is worth one read at launch to keep it somewhere nothing else writes.
   */
  async getDeviceId(): Promise<string> {
    const existing = await secureRead(KEY_DEVICE);
    if (existing) return existing;
    const fresh = makeDeviceId(Math.random, 'android');
    await secureWrite(KEY_DEVICE, fresh);
    return fresh;
  },

  /**
   * Which calendar view this phone was last left on.
   *
   * PER DEVICE, DELIBERATELY, and the PC agrees: `calendarView` is in its
   * `DEVICE_SCOPED_KEYS`, so a phone showing the day and a desktop showing the
   * week is the correct state of affairs rather than a disagreement to resolve.
   *
   * Returned raw because the phone has one view the PC does not (`agenda`), so
   * the caller owns the list of names and validates it there.
   */
  getCalendarView: () => read(KEY_VIEW),
  setCalendarView: (view: string) => write(KEY_VIEW, view),

  /**
   * How the focus screen reads "week", "month" and "year": the calendar period
   * you are in, or the last N days.
   *
   * Per device, matching the PC, which keeps `analysisRangeMode` in its own
   * device settings beside the tab it qualifies. Reading the same history two
   * ways on two screens is the point; forcing both machines onto one reading
   * would be the surprise.
   */
  async getFocusRangeMode(): Promise<FocusRangeMode> {
    return coerceFocusRangeMode(await read(KEY_FOCUS_RANGE_MODE));
  },
  setFocusRangeMode: (mode: FocusRangeMode) => write(KEY_FOCUS_RANGE_MODE, mode),

  /**
   * How the task board is sorted.
   *
   * Per device like the rest of the view preferences, and remembered because
   * dragging a task switches the board to Manual: coming back to Date on the
   * next launch would look exactly like the drag having been thrown away.
   */
  async getTaskSort(): Promise<SortMode> {
    return coerceSortMode(await read(KEY_TASK_SORT));
  },
  setTaskSort: (mode: SortMode) => write(KEY_TASK_SORT, mode),

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
    // store that silently becomes something else next launch.
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
   * storage before the number moves. `withDayStart` carries the span along,
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

  /**
   * The focus timer, as one JSON blob.
   *
   * Per device, and stored WHOLE rather than as synced fields. A running timer
   * is a single fact, and the periodic checkpoint a session writes would fight
   * a per-field merge every few seconds. It reaches the PC over
   * `/api/focus-timer`, which is the same endpoint the PC has always used.
   *
   * A blob that will not parse is treated as no timer at all: the alternative is
   * a screen that cannot be used until the app is reinstalled, for the sake of a
   * session nobody can see anyway.
   */
  async getFocusTimer(): Promise<unknown> {
    const raw = await read(KEY_FOCUS_TIMER);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  setFocusTimer: (state: unknown) => write(KEY_FOCUS_TIMER, JSON.stringify(state)),

  /**
   * What this phone has done about each reminder.
   *
   * DEVICE-LOCAL, and deliberately not a sync store. It is a cache of a truth
   * the server owns plus the decisions this phone has not managed to report
   * yet, so a corrupt blob costs at most a repeated dismissal, never data.
   */
  async getNotifyCentre(): Promise<unknown> {
    const raw = await read(KEY_NOTIFY_CENTRE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  setNotifyCentre: (state: unknown) => write(KEY_NOTIFY_CENTRE, JSON.stringify(state)),

  /**
   * How THIS phone draws prayers.
   *
   * Per device, like the theme and the snap interval. The times themselves are
   * shared, because they are a fact about a city; how they are drawn is a fact
   * about a screen, and the desk must never be able to push its answer here.
   */
  async getPrayerAppearance(): Promise<PrayerAppearance> {
    const raw = await read(KEY_PRAYER_LOOK);
    if (!raw) return DEFAULT_PRAYER_APPEARANCE;
    try {
      return coercePrayerAppearance(JSON.parse(raw));
    } catch {
      return DEFAULT_PRAYER_APPEARANCE;
    }
  },
  setPrayerAppearance: (look: PrayerAppearance) =>
    write(KEY_PRAYER_LOOK, JSON.stringify(coercePrayerAppearance(look))),

  /**
   * Which hours of the day this phone's grid draws.
   *
   * A LIST of stretches, not a start and an end. "Everything except the middle
   * of the night" is a perfectly ordinary wish that no single pair of numbers
   * can express, and the pair was also being quietly overruled: the grid used to
   * stretch itself open for any content outside it, and with dawn prayer at
   * 04:19 that meant every day reopened at 3am no matter what was set.
   *
   * Falls back to the older `dayStartH`/`dayEndH` pair when nothing has been
   * stored here yet, so an existing phone keeps the window it already had.
   */
  async getVisibleHours(): Promise<HourRange[]> {
    const raw = await read(KEY_VISIBLE_HOURS);
    if (raw) {
      try {
        return normaliseRanges(JSON.parse(raw));
      } catch {
        return [...FULL_DAY];
      }
    }
    const legacy = await prefs.getDayWindow();
    return normaliseRanges([{ from: legacy.start, to: legacy.end }]);
  },
  setVisibleHours: (ranges: HourRange[]) =>
    write(KEY_VISIBLE_HOURS, JSON.stringify(normaliseRanges(ranges))),

  async signOut(): Promise<void> {
    await secureWrite(KEY_SESSION, null);
    await secureWrite(KEY_USER, null);
    // The server URL and device id deliberately survive signing out: the user is
    // almost always signing back into the same planner on the same phone.
    // So do the view preferences: they describe this screen, not this account.
  },

  async getHiddenCategoriesByView(): Promise<Record<string, string[]>> {
    const raw = await read(KEY_HIDDEN_CATEGORIES);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string[]>;
    } catch {
      return {};
    }
  },
  setHiddenCategoriesByView: (val: Record<string, string[]>) => write(KEY_HIDDEN_CATEGORIES, JSON.stringify(val)),

  /** Undefined, not a default: "this phone has never chosen its own rules". */
  async getNotificationsLocal(): Promise<NotificationSettings | undefined> {
    const raw = await read(KEY_NOTIFICATIONS_LOCAL);
    if (!raw) return undefined;
    try {
      return coerceNotificationSettings(JSON.parse(raw));
    } catch {
      return undefined;
    }
  },
  setNotificationsLocal: (val: NotificationSettings | undefined) =>
    write(KEY_NOTIFICATIONS_LOCAL, val ? JSON.stringify(val) : null),
};
