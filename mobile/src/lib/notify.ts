// ─── Android alarms ──────────────────────────────────────────────────────────
// The reason this app exists rather than a browser tab: reminders that fire with
// the PC switched off, the phone offline, and the app closed.
//
// Everything about WHAT should fire comes from `computeSchedule` — the same code
// the PC runs — and everything about WHICH alarms to touch comes from
// `planAlarms`, which is tested exhaustively. This file only performs the OS
// calls, so it holds no logic worth arguing with.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { planAlarms, findMissed, type AlarmPlan, type RegisteredAlarm } from './alarmPlan';
import type { ScheduledNotification } from './notifications';

export const CHANNEL_ID = 'reminders';

/** Foreground behaviour: a reminder must be visible even while the app is open. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function prepareNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.HIGH,
      // A planner reminder that arrives silently has failed at its one job.
      vibrationPattern: [0, 250, 200, 250],
      lightColor: '#8C88FF',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: false,
    });
  }
}

export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
  /** Android 12+: exact alarms need their own grant, separate from notifications. */
  exactAlarms: boolean;
}

export async function checkPermissions(): Promise<PermissionState> {
  const current = await Notifications.getPermissionsAsync();
  return {
    granted: current.granted || current.ios?.status === 3,
    canAskAgain: current.canAskAgain,
    // Expo reports this through the Android-specific block; when it is absent we
    // assume the grant is in place rather than nagging on every launch.
    exactAlarms: (current as any)?.android?.allowsAlarms !== false,
  };
}

export async function requestPermissions(): Promise<PermissionState> {
  await Notifications.requestPermissionsAsync({
    android: {},
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return checkPermissions();
}

/** Read back what the OS is currently holding for us. */
export async function readRegisteredAlarms(): Promise<RegisteredAlarm[]> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const out: RegisteredAlarm[] = [];

  for (const item of scheduled) {
    const key = (item.content?.data as any)?.plannerKey;
    const fireAt = (item.content?.data as any)?.plannerFireAt;
    if (typeof key !== 'string' || typeof fireAt !== 'number') {
      // Not ours, or from a version that stored things differently. Cancel it
      // rather than leaving an alarm nobody can account for.
      await Notifications.cancelScheduledNotificationAsync(item.identifier).catch(() => {});
      continue;
    }
    out.push({ key, osId: item.identifier, fireAt });
  }
  return out;
}

/**
 * Bring the OS into line with what the planner wants.
 *
 * Cancels first, then schedules: doing it the other way round can briefly exceed
 * the alarm limit and have the OS refuse the tail of the batch.
 */
export async function applyAlarmPlan(plan: AlarmPlan): Promise<{ scheduled: number; cancelled: number }> {
  for (const alarm of plan.cancel) {
    await Notifications.cancelScheduledNotificationAsync(alarm.osId).catch(() => {});
  }

  let scheduled = 0;
  for (const item of plan.schedule) {
    // A date trigger that has already passed is delivered immediately, which is
    // exactly what we want for a reminder that came due while we were offline.
    await Notifications.scheduleNotificationAsync({
      content: {
        title: item.title,
        body: subtitleFor(item),
        sound: true,
        data: { plannerKey: item.key, plannerFireAt: item.fireAt, refId: item.refId, url: item.url },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(item.fireAt),
        channelId: CHANNEL_ID,
      },
    }).then(() => { scheduled += 1; }).catch(() => {
      // One alarm the OS refuses must not abort the rest of the batch.
    });
  }

  return { scheduled, cancelled: plan.cancel.length };
}

function subtitleFor(item: ScheduledNotification): string {
  // The engine already writes a human body; prefer it, and fall back to a time
  // line only when it is empty.
  if (item.body && item.body.trim().length > 0) return item.body;
  const when = new Date(item.anchorAt ?? item.fireAt);
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  if (item.allDay) return 'All day';
  if (item.offsetMin === 0) return `Now · ${hh}:${mm}`;
  if (item.offsetMin > 0) return `In ${item.offsetMin} min · ${hh}:${mm}`;
  return `${hh}:${mm}`;
}

/** Plan and apply in one step. Returns the plan so the UI can report it. */
export async function syncAlarms(
  desired: readonly ScheduledNotification[],
  opts: { now: number; handledKeys?: ReadonlySet<string> },
): Promise<AlarmPlan> {
  const registered = await readRegisteredAlarms();
  const plan = planAlarms(registered, desired, opts);
  await applyAlarmPlan(plan);
  return plan;
}

/** Alarms whose moment passed while the app was closed. */
export async function collectMissed(
  now: number,
  handledKeys?: ReadonlySet<string>,
): Promise<RegisteredAlarm[]> {
  return findMissed(await readRegisteredAlarms(), { now, handledKeys });
}

export async function cancelEverything(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
}
