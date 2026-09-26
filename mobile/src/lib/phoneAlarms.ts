// ─── What this phone's OS alarms should be, and making it so ─────────────────
// Shared by the running app (planner.tsx) and the background sync task
// (backgroundSync.ts). Both must arm EXACTLY the same alarms from the same
// data, or a background refresh would quietly disagree with the app.

import { readClientStore, type ClientData } from './syncClient';
import { SETTINGS_ENTITY } from './syncBridge';
import { inferWeekStartsOn } from './draft';
import { coercePrayerSettings, prayerMonthsFromCache } from './prayerTimes';
import {
  computeSchedule, resolveNotificationSettings, type NotificationSettings,
} from './notifications';
import { DEFAULT_CATEGORIES } from './categories';
import { desiredAlarms, handledKeys, type NotifyCentreState } from './notifyCentre';
import { syncAlarms } from './notify';

export interface PhoneAlarmResult {
  /** Everything due in the window, for the notification centre. */
  schedule: any[];
  /** How many alarms the OS is now holding. */
  armed: number;
}

/**
 * Work out what the OS should be holding, and make it so.
 *
 * Expensive, and in two different ways: `computeSchedule` walks every event
 * and task in the planner and expands two days of repeats, and `syncAlarms`
 * then makes a native round trip to read back every alarm Android currently
 * holds before scheduling or cancelling the difference.
 */
export async function replanPhoneAlarms(
  current: ClientData,
  localRules: NotificationSettings | undefined,
  marks: NotifyCentreState,
  now: number = Date.now(),
): Promise<PhoneAlarmResult> {
  const events = readClientStore(current, 'events');
  const tasks = readClientStore(current, 'tasks');
  // Read from the data being planned against, not from a render's copy: this
  // runs straight after a sync, when React state is still a render behind.
  const currentShared = ((readClientStore(current, 'settings') as any)?.[SETTINGS_ENTITY]
    ?? {}) as Record<string, any>;
  const currentPrayerSettings = coercePrayerSettings(currentShared.prayer);
  const told = currentShared.weekStartsOn;
  const currentWeekStart = (typeof told === 'number' && told >= 0 && told <= 6)
    ? (told as 0 | 1 | 2 | 3 | 4 | 5 | 6)
    : inferWeekStartsOn(events as any, tasks as any);

  // THIS PHONE'S rules, which are the shared ones unless sharing is off. The
  // user's OWN rules, never the defaults: reminders fired from default
  // settings arrive at times nobody chose, for categories switched off.
  const settings = resolveNotificationSettings({
    shared: currentShared.notifications,
    local: localRules,
    share: currentShared.shareNotificationSettings !== false,
  });

  // The window is deliberately wider than the alarm horizon: planAlarms trims
  // it back, and asking for slightly more costs nothing while making sure
  // nothing falls between the two ranges.
  const schedule = computeSchedule({
    events: events as any,
    tasks: tasks as any,
    categories: (currentShared.categories as any) ?? DEFAULT_CATEGORIES,
    settings,
    weekStartsOn: currentWeekStart,
    // PRAYERS ARE REMINDERS TOO. The prayer branch of `computeSchedule` is
    // gated on `prayerMonths` being present; leaving these out once meant the
    // phone never buzzed for a prayer at all.
    prayerSettings: currentPrayerSettings,
    prayerMonths: prayerMonthsFromCache(
      readClientStore(current, 'prayerTimes') as Record<string, unknown>,
      currentPrayerSettings,
    ),
    prayerDone: readClientStore(current, 'prayerDone') as Record<string, any>,
    from: now,
    to: now + 48 * 60 * 60 * 1000,
  }) as any[];

  // The alarms and the list must agree about when something will actually
  // arrive, so both go through `desiredAlarms`, which applies quiet hours,
  // and both skip anything already dealt with on any device.
  const plan = await syncAlarms(
    desiredAlarms(schedule as any, marks, { now, settings }),
    { now, handledKeys: handledKeys(marks, now) },
  );
  return { schedule, armed: plan.keep.length + plan.schedule.length };
}
