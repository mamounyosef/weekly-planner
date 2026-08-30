// ─── Which settings cross between the PC and the phone ───────────────────────
// Three scopes, and every setting is in exactly one:
//
//   SHARED      one answer for the whole planner. Categories, prayer times,
//               notification rules, week start. These MUST match on both
//               devices or the two show different plans for the same day.
//   DEVICE      each device keeps its own. Which view is open, how tall an hour
//               is, dark or light. A phone is not a 27-inch monitor and must not
//               be made to pretend otherwise.
//   DESK        the PC's own machinery. Keyboard shortcuts, backups, the desk
//               controller, Google. Nothing on a phone can act on any of it.
//
// WHY THE EXHAUSTIVENESS CHECK MATTERS MORE THAN THE LISTS
// The dangerous case is not a setting in the wrong list — it is a setting in NO
// list. Add a field to `AppSettings` and forget this file, and it either never
// reaches the phone (a feature that silently half-works) or it overwrites a
// per-device choice from the other machine (your phone's view changing because
// you touched the PC). `assertEveryKeyScoped` makes that a failing test rather
// than a bug found weeks later.

import { DEVICE_SCOPED_KEYS } from './deviceSettings';
import { DEFAULT_SETTINGS, type AppSettings } from './settingsSync';

/**
 * Settings that belong to the planner rather than to a machine.
 *
 * Read this list as "things that would be wrong if the two devices disagreed".
 * A category colour, a prayer calculation method, when a reminder fires — these
 * describe the plan itself, so they travel with it.
 */
export const SHARED_SETTING_KEYS = [
  'weekStartsOn',
  'timeFormat',
  'categories',
  'taskLists',
  'prayer',
  'notifications',
  'taskColor',
  'taskCheckboxShape',
  'taskFilters',
  'autoRollRecurringTasks',
  'focusDayStartHour',
  'focusChime',
  'focusCues',
] as const satisfies ReadonlyArray<keyof AppSettings>;

export type SharedSettingKey = (typeof SHARED_SETTING_KEYS)[number];

/**
 * Settings only the desk machine can act on.
 *
 * Not secret and not per-device — simply meaningless anywhere else. A phone has
 * no keyboard shortcuts, no backup folder, no ESP32 on the desk, and no Google
 * connection. Syncing them would put values on the phone that nothing reads and
 * that it could never correctly change.
 */
export const DESK_ONLY_KEYS = [
  'shortcuts',
  'shortcutDefaultsVersion',
  'autoBackup',
  'hardware',
  'googleSyncEnabled',
  'googleTasksSync',
  'gcalPushEnabled',
  'gcalPushTarget',
  'gcalPushOtherCalendars',
  'gcalPullDailyEdits',
  'gcalPullDailyNew',
  'gcalPullOtherCalendars',
  'gcalMirrorLocalDeletions',
  'gcalMirrorGoogleDeletions',
  // The side widget is a second window on the PC. There is no such thing on a
  // phone, so its appearance travels with the machine that draws it.
  'widgetDarkPreset',
  'widgetLightPreset',
  'stickyAllDayWidget',
  'stickyTasksWidget',
] as const satisfies ReadonlyArray<keyof AppSettings>;

export type DeskOnlyKey = (typeof DESK_ONLY_KEYS)[number];

const SHARED = new Set<string>(SHARED_SETTING_KEYS);
const DEVICE = new Set<string>(DEVICE_SCOPED_KEYS);
const DESK = new Set<string>(DESK_ONLY_KEYS);

export type SettingScope = 'shared' | 'device' | 'desk' | 'unscoped';

export function scopeOf(key: string): SettingScope {
  if (SHARED.has(key)) return 'shared';
  if (DEVICE.has(key)) return 'device';
  if (DESK.has(key)) return 'desk';
  return 'unscoped';
}

/**
 * Every setting that has not been placed in a scope, and every one placed twice.
 *
 * Returned rather than thrown so a test can report the names; an empty result is
 * the only acceptable state.
 */
export function assertEveryKeyScoped(): { unscoped: string[]; duplicated: string[] } {
  const unscoped: string[] = [];
  const duplicated: string[] = [];

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const hits = [SHARED.has(key), DEVICE.has(key), DESK.has(key)].filter(Boolean).length;
    if (hits === 0) unscoped.push(key);
    if (hits > 1) duplicated.push(key);
  }
  return { unscoped: unscoped.sort(), duplicated: duplicated.sort() };
}

export type SharedSettings = Pick<AppSettings, SharedSettingKey>;

/** The half of a settings object that travels. */
export function sharedSettingsOf(settings: Partial<AppSettings>): Partial<SharedSettings> {
  const out: Record<string, unknown> = {};
  for (const key of SHARED_SETTING_KEYS) {
    if (Object.hasOwn(settings, key) && settings[key] !== undefined) {
      out[key] = settings[key];
    }
  }
  return out as Partial<SharedSettings>;
}

/**
 * Fold synced settings back into this device's own.
 *
 * ONLY the shared keys are taken. That is the whole safety property: an incoming
 * payload cannot change which view this device shows, how tall its hours are, or
 * whether it is in dark mode, however much of that it happens to contain. Those
 * belong to the machine, and a phone adopting the desk's 7-column week would be
 * exactly the "settings fighting each other" this codebase has already suffered.
 */
export function applySharedSettings<T extends Partial<AppSettings>>(
  local: T,
  incoming: Partial<AppSettings> | undefined,
): T {
  if (!incoming) return local;

  let changed = false;
  const out: Record<string, unknown> = { ...local };
  for (const key of SHARED_SETTING_KEYS) {
    if (!Object.hasOwn(incoming, key)) continue;
    const next = incoming[key];
    if (next === undefined) continue;
    if (JSON.stringify(next) === JSON.stringify(out[key])) continue;
    out[key] = next;
    changed = true;
  }
  // The same object when nothing moved, so callers can skip a write and a
  // re-render on the strength of a reference check.
  return changed ? (out as T) : local;
}
