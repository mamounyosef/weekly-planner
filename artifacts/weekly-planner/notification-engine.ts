/**
 * The notification engine.
 *
 * This runs inside the dev server, which is the one process that is always up:
 * it starts on boot, outlives every window, and is already the thing the main
 * window, the side widget and the phone all talk to. Putting the scheduler here
 * rather than in a page is the whole reason a reminder still arrives when every
 * planner window is closed.
 *
 * One tick does four things, in this order:
 *
 *   1. DUE          — anything whose fire time has passed and that has never
 *                     been delivered is delivered now.
 *   2. CATCH-UP     — if the machine was asleep, everything missed inside the
 *                     catch-up window is delivered on wake; anything older is
 *                     recorded silently so the notification centre is honest
 *                     without burying the screen in stale toasts.
 *   3. SNOOZE       — a snooze that has run out re-alerts.
 *   4. ESCALATION   — a critical notification that is still unacknowledged
 *                     re-alerts on an interval until it is, or until it has
 *                     shouted its configured number of times.
 *
 * Delivery fans out to three transports, and each one is independent so a
 * failure in any of them cannot suppress the others:
 *
 *   • Windows toast  — a real OS toast with working buttons, fired even when
 *                      nothing is open. Local, instant, needs no network.
 *   • Web Push       — every subscribed browser and phone, over the push
 *                      service's own always-on channel.
 *   • The file store — written last; open windows see it over the existing
 *                      db-stream SSE and raise the in-app banner.
 *
 * Read state is shared, not per device. Marking one thing read anywhere writes
 * the store once, which closes the OS toast on Windows and pushes a `dismiss`
 * to every other device, so a notification never has to be dealt with twice.
 */
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

import {
  coerceNotificationSettings,
  coerceStore,
  computeSchedule,
  inQuietHours,
  notificationTag,
  pruneStore,
  quietReleaseAt,
  type NotificationRecord,
  type NotificationSettings,
  type NotificationStore,
  type ScheduledNotification,
} from './src/lib/notifications';
import { coerceCategories, type EventCategory } from './src/lib/categories';
import { coercePrayerSettings, type PrayerMonth, type PrayerSettings } from './src/lib/prayerTimes';
import {
  loadOrCreateVapid,
  sendPush,
  type PushSubscriptionRecord,
  type VapidKeys,
} from './server-web-push';

export interface UserPathsLike {
  safeName: string;
  dbDir: string;
  dbPath: string;
  tasksPath: string;
  settingsPath: string;
  donePath: string;
  notificationsPath: string;
  pushSubsPath: string;
}

export interface EngineOptions {
  rootDir: string;
  /** Usernames the engine should service, re-read every tick so a new user is picked up. */
  listUsers: () => Promise<string[]>;
  ensureUser: (username: string) => Promise<UserPathsLike>;
  /** How often the engine looks at the clock. */
  tickMs?: number;
  log?: (msg: string, ...rest: unknown[]) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A tick gap longer than this means the machine was suspended, not merely busy. */
const WAKE_GAP_MS = 3 * 60 * 1000;
/** How far ahead the engine looks, and how much of that the phone gets cached. */
const HORIZON_MS = 3 * DAY_MS;

const readJson = async <T,>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
};

/** Atomic write, so a crash mid-save can never leave a half-written store. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fsp.rename(tmp, file);
}

/** Toast tags are short and must not contain anything exotic. */
const toastTag = (key: string): string => crypto.createHash('sha1').update(key).digest('hex').slice(0, 32);

/**
 * Is this subscription a browser on the PC that gets Windows toasts?
 *
 * Two signals, either is enough. `local` is recorded when the subscription
 * was made from a loopback request, which only this machine can do. The user
 * agent is the fallback for the same PC reached through the public URL: a
 * desktop Windows or Mac browser, explicitly not a phone or tablet.
 */
export function isDesktopSubscription(sub: PushSubscriptionRecord): boolean {
  if ((sub as { local?: boolean }).local) return true;
  const ua = sub.userAgent || '';
  if (!ua) return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  return /Windows NT|Macintosh|X11|Linux/i.test(ua);
}




export type ActionName =
  | 'read' | 'unread' | 'read-all'
  | 'snooze' | 'ack' | 'done' | 'clear' | 'clear-all';

export interface ActionRequest {
  action: ActionName;
  keys?: string[];
  minutes?: number;
  deviceId?: string;
}

export interface DeliveryHealth {
  windowsToast: { lastOkAt?: number; lastErrorAt?: number; lastError?: string };
  push: PushSubscriptionRecord[];
  lastTickAt: number;
  lastWakeAt?: number;
  scheduledNext?: { key: string; title: string; fireAt: number } | null;
}

export function createNotificationEngine(opts: EngineOptions) {
  const log = opts.log ?? ((msg: string, ...rest: unknown[]) => console.log(`[notify] ${msg}`, ...rest));
  const tickMs = opts.tickMs ?? 15_000;
  const vapidPath = path.resolve(opts.rootDir, 'database', 'vapid.json');
  const agentTokenPath = path.resolve(opts.rootDir, 'database', 'agent-token.json');
  const prayerCachePath = path.resolve(opts.rootDir, 'database', 'prayer-times.json');

  let vapid: VapidKeys | null = null;
  let agentToken = '';
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastTickAt = 0;
  let lastWakeAt = 0;
  const toastHealth: DeliveryHealth['windowsToast'] = {};
  /**
   * Which accounts this machine may raise a Windows toast for.
   *
   * The database holds several accounts, but a Windows toast is not addressed
   * to an account: it appears on whoever's screen is in front of this PC. Only
   * an account that has actually had a planner window open here may raise one,
   * otherwise a second person's exam reminder appears on the first person's
   * desktop. Web Push is unaffected, because a push IS addressed to a device.
   *
   * A SET rather than "whoever was last seen": signing into a second account
   * briefly must not silence the account that actually lives on this machine.
   * Entries lapse on their own, so an account that stops being used here stops
   * being able to interrupt.
   */
  const desktopUsers = new Map<string, number>();
  const DESKTOP_USER_TTL = 2 * DAY_MS;
  /** Per-user cache of the next scheduled item, purely for the health panel. */
  const nextUp = new Map<string, { key: string; title: string; fireAt: number } | null>();

  // ── Setup ──────────────────────────────────────────────────────────────────

  async function ready(): Promise<void> {
    if (!vapid) {
      vapid = await loadOrCreateVapid(vapidPath, 'mailto:planner@localhost');
    }
    if (!agentToken) {
      const existing = await readJson<{ token?: string }>(agentTokenPath, {});
      if (existing.token) {
        agentToken = existing.token;
      } else {
        agentToken = crypto.randomBytes(24).toString('hex');
        await writeJsonAtomic(agentTokenPath, { token: agentToken });
      }
    }
  }

  const getVapidPublicKey = async (): Promise<string> => {
    await ready();
    return vapid!.publicKey;
  };

  const getAgentToken = async (): Promise<string> => {
    await ready();
    return agentToken;
  };

  // ── Reading a user's world ─────────────────────────────────────────────────

  interface UserWorld {
    paths: UserPathsLike;
    settings: NotificationSettings;
    categories: EventCategory[];
    weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    events: Record<string, any>;
    tasks: Record<string, any>;
    prayerSettings: PrayerSettings;
    prayerMonths: Record<string, PrayerMonth>;
    prayerDone: Record<string, any>;
    store: NotificationStore;
  }

  /**
   * The Aladhan cache is one global file keyed by query, not by month, so it is
   * reshaped here into the 'yyyy-MM' map the scheduler wants. Only the entries
   * matching this user's city/method are considered, otherwise a stale entry
   * from a previous city would quietly drive the reminders.
   */
  function prayerMonthsFor(cache: Record<string, { days?: Record<string, Record<string, string>> }>, p: PrayerSettings) {
    const prefix = `${p.city}|${p.country}|${p.method}|${p.school === 1 ? 1 : 0}|`;
    const out: Record<string, PrayerMonth> = {};
    for (const [key, value] of Object.entries(cache || {})) {
      if (!key.startsWith(prefix) || !value?.days) continue;
      for (const [dateStr, times] of Object.entries(value.days)) {
        const month = dateStr.slice(0, 7);
        (out[month] ||= {})[dateStr] = times as PrayerMonth[string];
      }
    }
    return out;
  }

  async function loadWorld(username: string): Promise<UserWorld> {
    const paths = await opts.ensureUser(username);
    const [rawSettings, events, tasks, prayerDone, rawStore, prayerCache] = await Promise.all([
      readJson<Record<string, unknown>>(paths.settingsPath, {}),
      readJson<Record<string, any>>(paths.dbPath, {}),
      readJson<Record<string, any>>(paths.tasksPath, {}),
      readJson<Record<string, any>>(paths.donePath, {}),
      readJson<unknown>(paths.notificationsPath, { items: {}, updatedAt: 0 }),
      readJson<Record<string, any>>(prayerCachePath, {}),
    ]);

    const prayerSettings = coercePrayerSettings((rawSettings as any).prayer);
    const weekRaw = (rawSettings as any).weekStartsOn;
    return {
      paths,
      settings: coerceNotificationSettings((rawSettings as any).notifications),
      categories: coerceCategories((rawSettings as any).categories),
      weekStartsOn: (typeof weekRaw === 'number' && weekRaw >= 0 && weekRaw <= 6 ? weekRaw : 1) as UserWorld['weekStartsOn'],
      events,
      tasks,
      prayerSettings,
      prayerMonths: prayerMonthsFor(prayerCache, prayerSettings),
      prayerDone,
      store: coerceStore(rawStore),
    };
  }

  function scheduleFor(world: UserWorld, from: number, to: number): ScheduledNotification[] {
    return computeSchedule({
      events: world.events,
      tasks: world.tasks,
      categories: world.categories,
      settings: world.settings,
      weekStartsOn: world.weekStartsOn,
      prayerMonths: world.prayerMonths,
      prayerSettings: world.prayerSettings,
      prayerDone: world.prayerDone as any,
      from,
      to,
    });
  }

  // ── Transports ─────────────────────────────────────────────────────────────

  /**
   * Fire a real Windows toast. Buttons activate the `plannernotify:` protocol,
   * which the small Python agent turns back into an API call, so Snooze and
   * Done work from the toast without the planner being open at all.
   */
  function showWindowsToast(rec: NotificationRecord, username: string, settings: NotificationSettings): boolean {
    if (process.platform !== 'win32' || !settings.windowsToast) return false;
    // Nobody has identified themselves on this machine yet (a fresh install, or
    // a server restarted before any window opened): allow it, because being
    // silent is the worse failure of the two.
    const now = Date.now();
    for (const [name, seenAt] of desktopUsers) {
      if (now - seenAt > DESKTOP_USER_TTL) desktopUsers.delete(name);
    }
    if (desktopUsers.size > 0 && !desktopUsers.has(username)) return false;

    const snooze = settings.snoozeOptions[0] ?? 10;
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.resolve(opts.rootDir, 'tools', 'notify-toast.ps1'),
      '-Title', rec.title,
      '-Body', rec.body,
      '-Tag', toastTag(rec.key),
      '-Key', rec.key,
      '-User', username,
      '-Token', agentToken,
      '-Kind', rec.kind,
      '-SnoozeMinutes', String(snooze),
      '-Priority', rec.priority,
    ];
    if (rec.priority === 'critical') args.push('-Critical');
    if (rec.kind === 'task' || rec.kind === 'task-digest' || rec.kind === 'event') args.push('-CanComplete');

    try {
      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore', detached: false });
      child.on('error', err => {
        toastHealth.lastErrorAt = Date.now();
        toastHealth.lastError = String(err?.message || err);
      });
      child.on('exit', code => {
        if (code === 0) toastHealth.lastOkAt = Date.now();
        else {
          toastHealth.lastErrorAt = Date.now();
          toastHealth.lastError = `powershell exited ${code}`;
        }
      });
      return true;
    } catch (err) {
      toastHealth.lastErrorAt = Date.now();
      toastHealth.lastError = String((err as Error)?.message || err);
      return false;
    }
  }

  /**
   * Is this subscription a browser on the PC that gets Windows toasts?
   *
   * Two signals, either is enough. `local` is recorded when the subscription
   * was made from a loopback request, which only this machine can do. The user
   * agent is the fallback for the same PC reached through the public URL: a
   * desktop Windows or Mac browser, explicitly not a phone or tablet.
   */


  /** Close an already-shown toast, so marking something read clears the screen. */
  function removeWindowsToast(key: string): void {
    if (process.platform !== 'win32') return;
    try {
      spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.resolve(opts.rootDir, 'tools', 'notify-toast.ps1'),
        '-Remove', '-Tag', toastTag(key),
      ], { windowsHide: true, stdio: 'ignore' });
    } catch { /* clearing a toast is best effort by design */ }
  }

  async function loadSubs(paths: UserPathsLike): Promise<PushSubscriptionRecord[]> {
    const raw = await readJson<unknown>(paths.pushSubsPath, []);
    return Array.isArray(raw) ? (raw as PushSubscriptionRecord[]).filter(s => s?.endpoint && s?.keys?.p256dh) : [];
  }

  /**
   * Push to every device. A subscription the push service reports as gone is
   * dropped; a transient failure is only counted, because a phone that is off
   * must not lose its subscription for being off.
   */
  async function pushToAll(paths: UserPathsLike, payload: unknown, settings: NotificationSettings, o?: { topic?: string; ttl?: number; skipDesktop?: boolean }) {
    if (!settings.webPush) return;
    await ready();
    const all = await loadSubs(paths);
    // The PC has already been told natively. Pushing to its browsers as well is
    // how one reminder ended up on the same screen twice, once from the
    // installed app and once from Chrome. Its subscriptions are kept, so
    // nothing has to be re-granted if the toasts ever stop working.
    const subs = o?.skipDesktop ? all.filter(s => !isDesktopSubscription(s)) : all;
    if (!subs.length) return;

    const body = JSON.stringify(payload);
    const results = await Promise.all(subs.map(async sub => {
      const res = await sendPush(sub, body, vapid!, {
        ttlSeconds: o?.ttl ?? 24 * 3600,
        urgency: 'high',
        topic: o?.topic,
      });
      if (res.ok) return { ...sub, lastOkAt: Date.now(), failures: 0, lastError: undefined, lastErrorAt: undefined };
      if (res.gone) return null;
      return { ...sub, lastErrorAt: Date.now(), lastError: `${res.status} ${res.error ?? ''}`.trim(), failures: (sub.failures ?? 0) + 1 };
    }));

    const kept = results.filter(Boolean) as PushSubscriptionRecord[];
    if (kept.length !== subs.length || kept.some((s, i) => s.lastOkAt !== subs[i]?.lastOkAt || s.lastErrorAt !== subs[i]?.lastErrorAt)) {
      // Merge rather than replace: the skipped desktop subscriptions were never
      // in `subs` and must survive this write untouched.
      const byEndpoint = new Map(kept.map(s => [s.endpoint, s]));
      const attempted = new Set(subs.map(s => s.endpoint));
      const merged = all
        .map(s => byEndpoint.get(s.endpoint) ?? (attempted.has(s.endpoint) ? null : s))
        .filter(Boolean) as PushSubscriptionRecord[];
      await writeJsonAtomic(paths.pushSubsPath, merged);
    }
  }

  /**
   * One alert, out of every door at once. `store` is mutated by the caller and
   * written after the whole tick, so a burst of twenty catch-up notifications
   * is one file write and therefore one SSE update, not twenty.
   */
  async function deliver(world: UserWorld, username: string, rec: NotificationRecord, reason: 'new' | 'snooze' | 'escalate' | 'wake') {
    const toasted = showWindowsToast(rec, username, world.settings);
    await pushToAll(world.paths, {
      type: 'notify',
      reason,
      snoozeOptions: world.settings.snoozeOptions,
      sound: world.settings.sound,
      n: {
        key: rec.key, kind: rec.kind, refId: rec.refId, occDate: rec.occDate,
        title: rec.title, body: rec.body, priority: rec.priority,
        color: rec.color, url: rec.url, anchorAt: rec.anchorAt, fireAt: rec.fireAt,
        allDay: rec.allDay, late: rec.late,
      },
    }, world.settings, {
      topic: toastTag(rec.key).slice(0, 24),
      skipDesktop: toasted && !world.settings.desktopPush,
      // A critical reminder is worth holding for a full day; a routine one is
      // stale long before that and should expire rather than surprise.
      ttl: rec.priority === 'critical' ? 24 * 3600 : 6 * 3600,
    });
  }

  // ── The tick ───────────────────────────────────────────────────────────────

  async function tickUser(username: string, now: number, wokeUp: boolean): Promise<void> {
    const world = await loadWorld(username);
    const { settings, store } = world;
    if (!settings.enabled) return;

    const catchUpMs = settings.catchUpHours * 60 * 60 * 1000;
    const scheduled = scheduleFor(world, now - Math.max(catchUpMs, DAY_MS), now + HORIZON_MS);

    nextUp.set(username, (() => {
      const upcoming = scheduled.find(s => s.fireAt > now);
      return upcoming ? { key: upcoming.key, title: upcoming.title, fireAt: upcoming.fireAt } : null;
    })());

    let dirty = false;
    const toDeliver: Array<{ rec: NotificationRecord; reason: 'new' | 'snooze' | 'escalate' | 'wake' }> = [];

    // 1 + 2. Newly due, and anything missed while the machine was off.
    for (const s of scheduled) {
      if (s.fireAt > now) continue;
      if (store.items[s.key]) continue;

      const age = now - s.fireAt;
      const tooOld = age > catchUpMs;
      const held = !tooOld && s.priority !== 'critical' && inQuietHours(settings, new Date(now));

      const rec: NotificationRecord = {
        ...s,
        firedAt: now,
        lastAlertAt: now,
        alerts: 1,
        late: age > 60_000,
        missed: tooOld,
      };

      if (tooOld) {
        // Recorded, never shouted. The notification centre still shows it, with
        // a "missed" mark, which is the honest thing to do after a day away.
        rec.alerts = 0;
        store.items[s.key] = rec;
        dirty = true;
        continue;
      }

      if (held) {
        // Quiet hours: keep it, but release it as a snooze when the window ends.
        rec.alerts = 0;
        rec.snoozedUntil = quietReleaseAt(settings, new Date(now));
        store.items[s.key] = rec;
        dirty = true;
        continue;
      }

      store.items[s.key] = rec;
      dirty = true;
      toDeliver.push({ rec, reason: age > 60_000 ? 'wake' : 'new' });
    }

    // 3. Snoozes that have run out.
    for (const rec of Object.values(store.items)) {
      if (rec.read || rec.completed) continue;
      if (!rec.snoozedUntil || rec.snoozedUntil > now) continue;
      rec.snoozedUntil = undefined;
      rec.lastAlertAt = now;
      rec.alerts = (rec.alerts ?? 0) + 1;
      dirty = true;
      toDeliver.push({ rec, reason: 'snooze' });
    }

    // 4. Critical items that are still unacknowledged.
    if (settings.escalateTimes > 0) {
      const gap = settings.escalateEveryMin * 60_000;
      for (const rec of Object.values(store.items)) {
        if (rec.priority !== 'critical') continue;
        if (rec.read || rec.completed || rec.acknowledgedAt || rec.missed) continue;
        if (rec.snoozedUntil && rec.snoozedUntil > now) continue;
        if ((rec.alerts ?? 0) >= settings.escalateTimes + 1) continue;
        if (now - (rec.lastAlertAt ?? 0) < gap) continue;
        rec.lastAlertAt = now;
        rec.alerts = (rec.alerts ?? 0) + 1;
        dirty = true;
        toDeliver.push({ rec, reason: 'escalate' });
      }
    }

    // On wake, anything still unread gets one more shout on the PC. This is the
    // "I dealt with nothing on my phone last night" case: the desktop should
    // show it again rather than leave it buried in a panel nobody opened.
    if (wokeUp) {
      for (const rec of Object.values(store.items)) {
        if (rec.read || rec.completed || rec.missed) continue;
        if (rec.snoozedUntil && rec.snoozedUntil > now) continue;
        if (toDeliver.some(d => d.rec.key === rec.key)) continue;
        if (now - rec.firedAt > catchUpMs) continue;
        showWindowsToast(rec, username, settings);
      }
    }

    if (dirty) {
      store.updatedAt = now;
      const pruned = pruneStore(store, settings.historyLimit);
      await writeJsonAtomic(world.paths.notificationsPath, pruned);
    }

    for (const item of toDeliver) {
      await deliver(world, username, item.rec, item.reason);
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    const now = Date.now();
    const gap = lastTickAt ? now - lastTickAt : 0;
    const wokeUp = lastTickAt > 0 && gap > WAKE_GAP_MS;
    if (wokeUp) {
      lastWakeAt = now;
      log(`resumed after ${Math.round(gap / 1000)}s, re-checking everything`);
    }
    lastTickAt = now;

    try {
      await ready();
      const users = await opts.listUsers();
      for (const username of users) {
        try {
          await tickUser(username, now, wokeUp);
        } catch (err) {
          log(`tick failed for ${username}:`, (err as Error)?.message || err);
        }
      }
    } catch (err) {
      log('tick failed:', (err as Error)?.message || err);
    } finally {
      running = false;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Every action ends in exactly one place: the store on disk. Open windows
   * pick it up over db-stream, other devices get a `dismiss` push, and Windows
   * has its toast pulled. There is no second source of read state anywhere.
   */
  async function applyAction(username: string, req: ActionRequest): Promise<{ store: NotificationStore; completed: Array<{ kind: string; refId: string; occDate: string }> }> {
    const world = await loadWorld(username);
    const { store, settings } = world;
    const now = Date.now();
    const keys = req.keys?.length
      ? req.keys
      : (req.action === 'read-all' || req.action === 'clear-all' ? Object.keys(store.items) : []);

    const dismissed: string[] = [];
    const completed: Array<{ kind: string; refId: string; occDate: string }> = [];

    for (const key of keys) {
      const rec = store.items[key];
      if (!rec) continue;

      switch (req.action) {
        case 'read':
        case 'read-all':
          if (!rec.read) {
            rec.read = true;
            rec.readAt = now;
            rec.readBy = req.deviceId;
            dismissed.push(key);
          }
          break;
        case 'unread':
          rec.read = false;
          rec.readAt = undefined;
          rec.readBy = undefined;
          break;
        case 'snooze': {
          const minutes = Math.max(1, Math.min(720, Math.round(req.minutes ?? settings.snoozeOptions[0] ?? 10)));
          rec.snoozedUntil = now + minutes * 60_000;
          rec.read = false;
          dismissed.push(key);
          break;
        }
        case 'ack':
          rec.acknowledgedAt = now;
          rec.read = true;
          rec.readAt = now;
          rec.readBy = req.deviceId;
          dismissed.push(key);
          break;
        case 'done':
          rec.completed = true;
          rec.read = true;
          rec.readAt = now;
          rec.readBy = req.deviceId;
          rec.acknowledgedAt = now;
          dismissed.push(key);
          completed.push({ kind: rec.kind, refId: rec.refId, occDate: rec.occDate });
          break;
        case 'clear':
        case 'clear-all':
          delete store.items[key];
          dismissed.push(key);
          break;
      }
    }

    store.updatedAt = now;
    await writeJsonAtomic(world.paths.notificationsPath, pruneStore(store, settings.historyLimit));
    if (completed.length) await applyCompletions(world, completed);

    for (const key of dismissed) removeWindowsToast(key);
    if (dismissed.length) {
      await pushToAll(world.paths, { type: 'dismiss', tags: dismissed.map(notificationTag), keys: dismissed }, settings, { ttl: 300 });
    }

    return { store, completed };
  }

  /**
   * "Done" from a toast has to reach the real database, not just silence the
   * alert. Completion is per occurrence for anything repeating, which is why it
   * always writes `completedDates` and never a bare flag on a master.
   *
   * A digest is deliberately excluded: it stands for several tasks at once, and
   * ticking all of them off from one button press is not something a person can
   * undo from a toast.
   */
  async function applyCompletions(world: UserWorld, completed: Array<{ kind: string; refId: string; occDate: string }>) {
    let eventsDirty = false;
    let tasksDirty = false;

    for (const c of completed) {
      if (c.kind === 'event') {
        const ev = world.events[c.refId];
        if (!ev || ev.deleted) continue;
        const dates: string[] = Array.isArray(ev.completedDates) ? ev.completedDates : [];
        if (dates.includes(c.occDate)) continue;
        ev.completedDates = [...dates, c.occDate];
        ev.updatedAt = Date.now();
        eventsDirty = true;
      } else if (c.kind === 'task') {
        const t = world.tasks[c.refId];
        if (!t || t.deleted) continue;
        if (t.recur) {
          const dates: string[] = Array.isArray(t.completedDates) ? t.completedDates : [];
          if (dates.includes(c.occDate)) continue;
          t.completedDates = [...dates, c.occDate];
        } else {
          if (t.completed) continue;
          t.completed = true;
          t.completedAt = Date.now();
        }
        t.updatedAt = Date.now();
        tasksDirty = true;
      }
    }

    if (eventsDirty) await writeJsonAtomic(world.paths.dbPath, world.events);
    if (tasksDirty) await writeJsonAtomic(world.paths.tasksPath, world.tasks);
  }

  /** What the phone caches so it can still alert with the PC switched off. */
  async function upcomingFor(username: string, hours: number): Promise<{ from: number; to: number; items: ScheduledNotification[]; settings: NotificationSettings }> {
    const world = await loadWorld(username);
    const now = Date.now();
    const to = now + Math.max(1, Math.min(72, hours)) * 60 * 60 * 1000;
    const items = scheduleFor(world, now, to)
      // Anything the server has already delivered must not be repeated locally.
      .filter(s => !world.store.items[s.key]);
    return { from: now, to, items, settings: world.settings };
  }

  /**
   * A notification the phone fired by itself while the PC was off. Recording it
   * is what stops the same reminder arriving a second time when the PC returns.
   */
  async function recordLocallyFired(username: string, keys: string[], deviceId?: string): Promise<void> {
    if (!keys.length) return;
    const world = await loadWorld(username);
    const now = Date.now();
    const scheduled = scheduleFor(world, now - 3 * DAY_MS, now + DAY_MS);
    const byKey = new Map(scheduled.map(s => [s.key, s]));

    let dirty = false;
    for (const key of keys) {
      if (world.store.items[key]) continue;
      const s = byKey.get(key);
      if (!s) continue;
      world.store.items[key] = {
        ...s,
        firedAt: Math.min(now, s.fireAt),
        lastAlertAt: s.fireAt,
        alerts: 1,
        late: false,
        readBy: deviceId,
      };
      dirty = true;
    }
    if (dirty) {
      world.store.updatedAt = now;
      await writeJsonAtomic(world.paths.notificationsPath, pruneStore(world.store, world.settings.historyLimit));
    }
  }

  async function savePushSubscription(username: string, sub: Omit<PushSubscriptionRecord, 'id' | 'createdAt'>): Promise<PushSubscriptionRecord[]> {
    const paths = await opts.ensureUser(username);
    const subs = await loadSubs(paths);
    const existing = subs.find(s => s.endpoint === sub.endpoint);
    if (existing) {
      Object.assign(existing, sub, { lastErrorAt: undefined, lastError: undefined, failures: 0 });
    } else {
      subs.push({ ...sub, id: crypto.randomUUID(), createdAt: Date.now() });
    }
    await writeJsonAtomic(paths.pushSubsPath, subs);
    return subs;
  }

  async function removePushSubscription(username: string, endpointOrId: string): Promise<PushSubscriptionRecord[]> {
    const paths = await opts.ensureUser(username);
    const subs = (await loadSubs(paths)).filter(s => s.endpoint !== endpointOrId && s.id !== endpointOrId);
    await writeJsonAtomic(paths.pushSubsPath, subs);
    return subs;
  }

  /** Fires one notification straight through every transport, to prove the path. */
  async function sendTest(username: string, priority: 'normal' | 'critical' = 'normal'): Promise<NotificationRecord> {
    const world = await loadWorld(username);
    const now = Date.now();
    const rec: NotificationRecord = {
      key: `test:${now}`,
      kind: 'event',
      refId: 'test',
      occDate: new Date(now).toISOString().slice(0, 10),
      fireAt: now,
      anchorAt: now,
      offsetMin: 0,
      title: priority === 'critical' ? 'Critical test notification' : 'Test notification',
      body: priority === 'critical'
        ? 'This one repeats until you acknowledge it. That is what a critical item will do.'
        : 'If you can see this on this device, notifications are working here.',
      priority,
      allDay: false,
      url: '/?notifications=1',
      firedAt: now,
      lastAlertAt: now,
      alerts: 1,
    };
    world.store.items[rec.key] = rec;
    world.store.updatedAt = now;
    await writeJsonAtomic(world.paths.notificationsPath, pruneStore(world.store, world.settings.historyLimit));
    await deliver(world, username, rec, 'new');
    return rec;
  }

  async function health(username: string): Promise<DeliveryHealth> {
    const paths = await opts.ensureUser(username);
    return {
      windowsToast: { ...toastHealth },
      push: await loadSubs(paths),
      lastTickAt,
      lastWakeAt: lastWakeAt || undefined,
      scheduledNext: nextUp.get(username) ?? null,
    };
  }

  /** Called when an authenticated request arrives from this machine itself. */
  function markDesktopUser(username: string): void {
    desktopUsers.set(username, Date.now());
  }

  async function getStore(username: string): Promise<NotificationStore> {
    const paths = await opts.ensureUser(username);
    return coerceStore(await readJson<unknown>(paths.notificationsPath, { items: {}, updatedAt: 0 }));
  }

  /**
   * Repair the `plannernotify:` association that the toast buttons ride on.
   * The launcher does this too; doing it here as well means the buttons work
   * even when the server was started by hand without the launcher.
   */
  function registerToastProtocol(): void {
    if (process.platform !== 'win32') return;
    const agent = path.resolve(opts.rootDir, 'tools', 'notify-action.pyw');
    const candidates = [
      path.resolve(opts.rootDir, '.venv-launcher', 'Scripts', 'pythonw.exe'),
      'pythonw.exe',
    ];
    const tryNext = (i: number) => {
      if (i >= candidates.length) {
        log('could not register the toast protocol: no pythonw found. Toasts still show; their buttons will not respond.');
        return;
      }
      try {
        const child = spawn(candidates[i], [agent, '--register'], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => tryNext(i + 1));
        child.on('exit', code => { if (code !== 0) tryNext(i + 1); });
      } catch {
        tryNext(i + 1);
      }
    };
    tryNext(0);
  }

  return {
    start() {
      if (timer) return;
      registerToastProtocol();
      // A first pass right away, so restarting the server delivers whatever came
      // due while it was down instead of waiting out a full interval.
      void tick();
      timer = setInterval(() => { void tick(); }, tickMs);
      timer.unref?.();
      log(`engine started, ticking every ${Math.round(tickMs / 1000)}s`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    kick: tick,
    applyAction,
    upcomingFor,
    recordLocallyFired,
    savePushSubscription,
    removePushSubscription,
    sendTest,
    health,
    getStore,
    markDesktopUser,
    getVapidPublicKey,
    getAgentToken,
  };
}

export type NotificationEngine = ReturnType<typeof createNotificationEngine>;
