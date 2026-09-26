// ─── Syncing while the app is closed ─────────────────────────────────────────
// THE BUG THIS EXISTS FOR: the phone only synced while the app was open, and
// its reminders are OS alarms armed from local data. Move an event on the PC,
// leave the app shut, and the phone rang at the OLD time, because nothing had
// told it otherwise.
//
// Android's WorkManager (via expo-background-task) now wakes the app every 15
// minutes or so (Android decides exactly when, and only with a network), and
// this pulls the latest data and re-arms the alarms from it.
//
// Two paths, never both at once:
//   • the app is alive: sync THROUGH it (`setForegroundSyncer`), so there is
//     one copy of the data in memory, not two quietly disagreeing;
//   • the app is not: open the database, sync once, save, re-arm, done. No UI,
//     no timers, no React.
//
// The task MUST be defined at module scope, loaded from index.ts before the app
// renders: a headless wake-up runs the bundle without mounting any component,
// and a task defined inside one would simply not exist at that moment.

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { reconcileAfterSync, syncOnce } from '../lib/syncClient';
import { createStorage } from '../lib/syncStorage';
import { createExpoRunner, openPlannerDatabase } from '../lib/sqlite';
import { createTransport } from '../lib/syncTransport';
import { prefs, flushPrefs } from '../lib/prefs';
import { coerceCentreState, pruneCentreState } from '../lib/notifyCentre';
import { prepareNotifications } from '../lib/notify';
import { replanPhoneAlarms } from '../lib/phoneAlarms';

export const BACKGROUND_SYNC_TASK = 'planner-background-sync';

/** Minutes. Android's floor is 15; asking for less is silently raised. */
const INTERVAL_MINUTES = 15;

type Syncer = () => Promise<void>;
let foregroundSyncer: Syncer | null = null;

/** Set by the running app (planner.tsx) while it is mounted; null when not. */
export function setForegroundSyncer(fn: Syncer | null): void {
  foregroundSyncer = fn;
}

/** One headless cycle: pull, merge, save, re-arm. Throws on failure. */
async function syncHeadless(): Promise<void> {
  const [url, session, deviceId, localRules, centreRaw] = await Promise.all([
    prefs.getServerUrl(), prefs.getSession(), prefs.getDeviceId(),
    prefs.getNotificationsLocal(), prefs.getNotifyCentre(),
  ]);
  // Not signed in: nothing to fetch, and the alarms already match local data.
  if (!url || !session) return;

  const db = await openPlannerDatabase();
  const storage = createStorage(createExpoRunner(db));
  await storage.init();
  const before = await storage.load(deviceId);

  const transport = createTransport({
    baseUrl: url,
    session,
    fetchImpl: fetch as any,
    onSession: s => { void prefs.setSession(s); },
  });
  // No holding: a background slot is short, so ask and go.
  const outcome = await syncOnce(before, transport, Date.now(), 0);
  // Nothing else writes in a headless run, so "current" IS "before".
  const merged = reconcileAfterSync(before, before, outcome);
  await storage.saveSynced(merged);
  if (outcome.error) throw new Error(outcome.error);

  await prepareNotifications();
  const marks = pruneCentreState(coerceCentreState(centreRaw), { now: Date.now() });
  await replanPhoneAlarms(merged, localRules, marks);
  await flushPrefs();
}

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    if (foregroundSyncer) await foregroundSyncer();
    else await syncHeadless();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Ask Android to run the task periodically. Idempotent: WorkManager keeps one
 * registration per name, so calling this on every launch is harmless, and it
 * survives reboots and app updates on its own.
 */
export async function registerBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
      minimumInterval: INTERVAL_MINUTES,
    });
  } catch {
    // Never let a scheduling hiccup affect the app itself.
  }
}
