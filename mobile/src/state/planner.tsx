// ─── The one place the app keeps its planner ─────────────────────────────────
// Loads from SQLite, runs the sync loop, keeps alarms in step, and hands the
// screens plain data. Every decision it makes lives in a tested pure module —
// this file is wiring, timers and React.
//
// THE LOOP
//   • On launch: load local data (instantly, offline) → paint → then sync.
//   • On every edit: write locally, paint immediately, queue for the server.
//   • On a timer, on app foreground, and after every edit: try to sync.
//   • After any change to the data: re-plan the OS alarms.
//
// Nothing in the render path awaits the network. If the PC is off, the only
// visible difference is one line in the header.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  applyLocalChange,
  applyLocalChanges,
  applyLocalRecord,
  applyLocalResolution,
  backoffDelay,
  describeStatus,
  emptyClientData,
  readClientStore,
  reconcileAfterSync,
  sameStatus,
  syncOnce,
  withJitter,
  type ClientData,
  type ResolveChoice,
  type SyncPhase,
  type SyncStatus,
} from '../lib/syncClient';
import { createStorage, type SyncStorage } from '../lib/syncStorage';
import { createExpoRunner, openPlannerDatabase } from '../lib/sqlite';
import { createTransport, isAuthError, type PlannerTransport } from '../lib/syncTransport';
import { prefs, flushPrefs, warmPrefs } from '../lib/prefs';
import { createCoalescer } from '../lib/coalesce';
import { createKeyedCache, dayCacheKey } from '../lib/dayCache';
import {
  DEFAULT_DAY_WINDOW, DEFAULT_PRAYER_APPEARANCE, DEFAULT_SWIPE_VIEW_SWITCH,
  withDayEnd, withDayStart,
  type DayWindow, type PrayerAppearance,
} from '../lib/viewPrefs';
import { FULL_DAY, normaliseRanges, type HourRange } from '../lib/dayWindows';
import {
  planOccurrenceDelete, planOccurrenceEdit, type OccurrenceScope,
} from '../lib/occurrence';
import {
  IDLE_FOCUS_TIMER, coerceFocusTimer, mergeFocusTimers, reduceFocusTimer,
  type FocusTimerAction, type FocusTimerState,
} from '../lib/focusTimer';
import {
  EMPTY_CENTRE_STATE, EMPTY_CENTRE_VIEW, buildCentre, centreStateFromServer, clearEntries,
  coerceCentreState, desiredAlarms, dismiss as dismissKeys, handledKeys,
  markAllRead, markCompleted, markRead, markSynced, markUnread, mergeCentreState,
  pendingSync, pruneCentreState, recordFired, snooze as snoozeKeys,
  type CentreView, type NotifyCentreState,
} from '../lib/notifyCentre';
import { buildDay, ymd, type AgendaDay } from '../lib/agenda';
import {
  buildEventRecord,
  buildTaskRecord,
  inferWeekStartsOn,
  type DraftInput,
} from '../lib/draft';
import { DELETED_FIELD, peekEntity } from '../lib/sync';
import { SETTINGS_ENTITY } from '../lib/syncBridge';
import {
  buildPrayerDay,
  coercePrayerSettings,
  prayerQueryKey,
  prayerOccId,
  type PrayerOccurrence,
} from '../lib/prayerTimes';

/**
 * The settings the PC shares, as the phone reads them.
 *
 * Typed loosely and on purpose. The authoritative list lives on the PC in
 * `settingsScope.ts`, and importing it here would drag in the desk-only
 * machinery it references — focus sessions, keyboard shortcuts, the ESP32
 * controller — none of which exists on a phone. The server already guarantees
 * that nothing outside the shared list can arrive, so the phone's job is to read
 * what it is given, not to re-derive the rule.
 */
export interface SharedSettings {
  weekStartsOn?: number;
  timeFormat?: string;
  categories?: unknown[];
  taskLists?: unknown[];
  prayer?: unknown;
  notifications?: unknown;
  taskColor?: string;
  taskCheckboxShape?: string;
  taskFilters?: string[];
  autoRollRecurringTasks?: boolean;
  focusDayStartHour?: number;
  focusDailyGoalSeconds?: number;
  focusChime?: string;
  focusCues?: unknown;
}
import { DEFAULT_NOTIFICATION_SETTINGS, computeSchedule } from '../lib/notifications';
import { DEFAULT_CATEGORIES } from '../lib/categories';
import { collectMissed, prepareNotifications, syncAlarms } from '../lib/notify';
import { applyUpdateIfAny } from '../lib/updates';
import type { SyncConflict, SyncStore } from '../lib/sync';

/**
 * How often to try while everything is healthy.
 *
 * Ten seconds, not sixty. This only runs while the app is in the FOREGROUND --
 * the timer stops the moment Android suspends the runtime, and coming back to
 * the app syncs immediately anyway -- so the battery cost is bounded by how long
 * you are actually looking at the screen.
 *
 * A minute was measurably the wrong number. Tick something off on the PC, pick
 * up the phone, and the change is simply not there; you tap around, conclude
 * sync is broken, and put it down again before it ever arrives. Being wrong for
 * up to a minute every time is indistinguishable from being broken.
 */
/**
 * A new item's id.
 *
 * Shaped like the v4 uuids the PC generates, so nothing downstream has to care
 * which device created a record. Built from Math.random rather than
 * crypto.randomUUID, which is not present on every Android runtime this ships
 * to; ample here, since a collision would need two draws from 2^122 to coincide
 * on one person's two devices.
 */
function newId(): string {
  const hex = (n: number) => Array.from(
    { length: n }, () => Math.floor(Math.random() * 16).toString(16),
  ).join('');
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

const POLL_MS = 60_000;

/**
 * How long the server may hold an idle pull open before answering "nothing".
 *
 * This is what replaced the fast timer. A change made HERE syncs the instant it
 * is made — nothing was ever waiting on a tick for that. The timer only ever
 * existed for the other direction, because the PC cannot reach the phone, and
 * polling for that meant a full cycle six times a minute forever while still
 * being up to ten seconds stale.
 *
 * Parking the request inverts it: the server answers the moment its log moves,
 * so a change made on the PC lands at once and an idle planner costs one held
 * connection. The timer above is now only a safety net for a hold that was cut
 * short by something in the middle of the network.
 */
const PULL_WAIT_MS = 15_000;

/**
 * After a hold is refused, stop asking for one for this long.
 *
 * Not every path to the PC will carry a request that deliberately stays silent:
 * a tunnel, a proxy or a phone radio may close it early. That is harmless in
 * itself — the client retries at once without the hold — but continuing to ask
 * would spend an extra round trip on every single cycle. So the app stops
 * asking for a while, then tries again, because the network the phone is on
 * changes all day.
 */
const HOLD_COOLDOWN_MS = 10 * 60_000;

/**
 * When an in-flight sync is presumed dead.
 *
 * Comfortably past the longest a real cycle can take — the hold, plus the
 * transport's own timeout, plus room for a slow round trip — so this can only
 * ever fire on a cycle that genuinely is not coming back.
 */
const STUCK_AFTER_MS = PULL_WAIT_MS + 60_000;

/**
 * How often to retry while changes are still unsent.
 *
 * The general backoff exists to stop a phone hammering a PC that is switched
 * off. That reasoning does not apply while the user is standing there having
 * just made an edit, so a queue that has not drained is retried on a short fixed
 * interval instead — which is what makes walking back into Wi-Fi look automatic.
 */
const RETRY_WITH_PENDING_MS = 8_000;

export type Screen = 'connect' | 'today' | 'conflicts' | 'settings';

interface PlannerContextValue {
  ready: boolean;
  signedIn: boolean;
  username: string | null;
  serverUrl: string | null;
  data: ClientData;
  status: SyncStatus;
  conflicts: SyncConflict[];
  alarmSummary: string;

  day(date: string): AgendaDay;
  events(): Record<string, Record<string, unknown>>;
  tasks(): Record<string, Record<string, unknown>>;
  /**
   * One record from any store, INCLUDING a deleted one.
   *
   * For the conflicts screen, which has to be able to name a thing that was
   * deleted on one device. `events()` and `tasks()` cannot: they hide
   * tombstones, which is correct everywhere except there.
   */
  peek(store: SyncStore, entityId: string): Record<string, unknown> | null;

  connect(serverUrl: string, username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  syncNow(): Promise<void>;
  edit(store: SyncStore, entityId: string, changes: Record<string, unknown>): Promise<void>;
  /**
   * Several edits, one commit.
   *
   * For a reorder, which renumbers a whole group at once. Sent one at a time
   * the list walks to its new order a row per frame; sent together it arrives
   * in one. Duplicate ids are merged, last one wins.
   */
  editMany(store: SyncStore, edits: ReadonlyArray<{ id: string; changes: Record<string, unknown> }>): Promise<void>;
  saveRecord(store: SyncStore, entityId: string, record: Record<string, unknown>): Promise<void>;
  toggleDone(store: SyncStore, item: { masterId: string; date: string; repeating: boolean; completed: boolean }): Promise<void>;
  /** Create or update one item from the editor. Returns the id it wrote. */
  saveDraft(store: SyncStore, draft: DraftInput, editingId?: string): Promise<string>;
  /** Remove an item everywhere. A tombstone, never a local hide. */
  removeItem(store: SyncStore, id: string): Promise<void>;
  /**
   * Change or delete a repeating item at ONE date, or from it onwards, or
   * everywhere.
   *
   * The decision itself is made in `occurrence.ts`, which is tested against the
   * PC's own code side by side. A phone and a desktop that disagreed about what
   * "only this one" meant would not throw an error: they would quietly write two
   * different shapes of series and both look right until a week later.
   *
   * Returns the id worth keeping selected afterwards, or null when the target is
   * gone.
   */
  applyScoped(
    store: SyncStore,
    masterId: string,
    date: string | null,
    scope: OccurrenceScope,
    action: 'edit' | 'delete',
    patch?: Record<string, unknown>,
  ): Promise<string | null>;
  /** Which weekday this planner's weeks start on. From the PC once synced. */
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** The settings the PC shares. Empty until the first sync brings them. */
  shared: Partial<SharedSettings>;
  /** The user's categories, or the defaults until they arrive. */
  categories: any[];
  /** '12h' or '24h', from the PC. Undefined until settings have synced. */
  timeFormat: string | undefined;
  /** The sections tasks belong to, from the PC. Empty until settings sync. */
  taskLists: any[];
  /** Focus history from the PC, newest last. Empty until it syncs. */
  focusSessions: any[];
  /**
   * For the badge. Only things that have actually fired can be unread.
   *
   * The LIST itself is not here: it is rebuilt every thirty seconds so that
   * "in 20 minutes" stays true, and carrying that in this value re-rendered
   * every screen in the app twice a minute. It lives in its own context now,
   * reached with `useNotifyCentre()`, so only the screen that draws it pays.
   */
  unreadNotifications: number;
  /** The snooze durations the user configured on the PC. */
  snoozeOptions: number[];
  notifyRead(keys: readonly string[]): void;
  notifyUnread(keys: readonly string[]): void;
  notifyDismiss(keys: readonly string[]): void;
  notifySnooze(keys: readonly string[], minutes: number): void;
  notifyComplete(keys: readonly string[]): void;
  notifyClear(keys: readonly string[]): void;
  notifyMarkAllRead(): void;
  /** The live focus timer. Always a real state, never undefined. */
  focusTimer: FocusTimerState;
  /** Apply one action to the timer: persist it, log any session, then push. */
  runFocusTimer(action: FocusTimerAction): Promise<void>;
  /** Minutes each time step moves. This device's own: 5, 10, 15, 30 or 60. */
  interval: number;
  setInterval(minutes: number): void;
  /** The Custom view's window, in days either side of the chosen day. */
  customWindow: { before: number; after: number };
  setCustomWindow(before: number, after: number): void;
  /**
   * The hours of the day this phone draws, its own choice.
   *
   * Per device, like the view and the interval: a phone held in one hand wants
   * a tighter window than a wide monitor, and the PC keeps `dayStartH` and
   * `dayEndH` in its own device-scoped settings for that reason.
   */
  dayWindow: DayWindow;
  setDayStart(hour: number): void;
  setDayEnd(hour: number): void;
  calendarView: 'agenda' | 'day' | 'custom' | 'week' | 'month' | 'year';
  setCalendarView(view: 'agenda' | 'day' | 'custom' | 'week' | 'month' | 'year'): void;
  /**
   * Which hours the grid draws, as a list of stretches.
   *
   * Supersedes the start and end pair, which could not say "everything except
   * the middle of the night" and was in any case being overruled by content.
   */
  visibleHours: HourRange[];
  setVisibleHours(ranges: HourRange[]): void;
  /** Whether a sideways swipe changes the view as well as the date. */
  swipeViewSwitch: boolean;
  setSwipeViewSwitch(on: boolean): void;
  /** How this phone draws prayers. Its own, never the desk's. */
  prayerAppearance: PrayerAppearance;
  setPrayerAppearance(look: PrayerAppearance): void;
  /**
   * How many months of prayer times this phone actually holds.
   *
   * Shown on the prayer screen. When the times do not appear on the calendar the
   * question is always the same, and unanswerable from the outside: does the
   * phone HAVE them. This answers it on the device rather than by inference.
   */
  prayerCacheSummary: { months: number; key: string; hasToday: boolean };
  /** The prayers of one day, already offset, filtered and sorted. */
  prayersOn(date: string): PrayerOccurrence[];
  /** Whether a given prayer has been marked as prayed. */
  isPrayerDone(date: string, key: string): boolean;
  togglePrayer(date: string, key: string): Promise<void>;
  answerConflict(conflict: SyncConflict, choice: ResolveChoice): Promise<void>;
  resetLocal(): Promise<void>;
  lastError: string | null;
}

const PlannerContext = createContext<PlannerContextValue | null>(null);

/**
 * The reminder list, on its own wire.
 *
 * Separated from the planner context for one reason: it is a claim about NOW.
 * Every entry says "in 20 minutes" or "2 hours ago", so it is rebuilt on a
 * thirty-second tick whether or not anything has happened. While it travelled
 * with everything else, that tick handed a new context value to every consumer
 * in the app and re-rendered the calendar grid, the task list and the focus
 * charts, twice a minute, forever.
 *
 * Only the notifications screen subscribes here. The bell needs the unread
 * COUNT, which is a small number that usually does not change, and that stays
 * on the main context.
 */
const NotifyCentreContext = createContext<CentreView>(EMPTY_CENTRE_VIEW);

export function usePlanner(): PlannerContextValue {
  const ctx = useContext(PlannerContext);
  if (!ctx) throw new Error('usePlanner must be used inside <PlannerProvider>');
  return ctx;
}

/** What has fired and what is coming, joined with what you did about it. */
export function useNotifyCentre(): CentreView {
  return useContext(NotifyCentreContext);
}

export function PlannerProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<ClientData>(() => emptyClientData('pending'));
  const [phase, setPhase] = useState<SyncPhase>('idle');
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [alarmSummary, setAlarmSummary] = useState('No reminders scheduled yet');
  const [interval, setIntervalState] = useState(30);
  const [customWindow, setCustomWindowState] = useState({ before: 1, after: 3 });
  const [dayWindow, setDayWindowState] = useState<DayWindow>(DEFAULT_DAY_WINDOW);
  const [calendarView, setCalendarViewState] = useState<'agenda' | 'day' | 'custom' | 'week' | 'month' | 'year'>('day');
  const [focusTimer, setFocusTimerState] = useState<FocusTimerState>(IDLE_FOCUS_TIMER);
  // Read through a ref for the same reason `saveDraft` does: an action can be
  // dispatched while a sync is landing, and reducing against a stale state would
  // lose whichever of the two happened first.
  const focusTimerRef = useRef<FocusTimerState>(IDLE_FOCUS_TIMER);
  /**
   * A session that finished while the app was closed, waiting for the store.
   *
   * Settling happens before the database is open, because the timer must be
   * right on the first frame. The record it produces is written as soon as
   * there is somewhere to write it.
   */
  const pendingFocusSessionRef = useRef<any>(null);

  /**
   * What this phone has done about each reminder, and the schedule it was done
   * against.
   *
   * The centre is DERIVED, never accumulated: `computeSchedule` is the authority
   * on what exists and when, these marks are the authority on what the user did
   * about it, and the two are joined on every render. That is why an offline
   * fortnight is harmless rather than a backlog.
   */
  const [notifyState, setNotifyStateRaw] = useState<NotifyCentreState>(EMPTY_CENTRE_STATE);
  const notifyStateRef = useRef<NotifyCentreState>(EMPTY_CENTRE_STATE);
  const scheduleRef = useRef<any[]>([]);
  /** A tick purely so "in 20 minutes" stops being a lie a minute later. */
  const [notifyClock, setNotifyClock] = useState(() => Date.now());
  const [swipeViewSwitch, setSwipeState] = useState(DEFAULT_SWIPE_VIEW_SWITCH);
  const [prayerAppearance, setPrayerLook] = useState<PrayerAppearance>(DEFAULT_PRAYER_APPEARANCE);
  const [visibleHours, setVisibleHoursState] = useState<HourRange[]>(FULL_DAY);

  const storageRef = useRef<SyncStorage | null>(null);
  const transportRef = useRef<PlannerTransport | null>(null);
  const dataRef = useRef(data);
  const failuresRef = useRef(0);
  /** Guards against two sync cycles overlapping, which would double-send. */
  const syncingRef = useRef(false);
  /** When the in-flight cycle began, for the watchdog below. */
  const syncStartedAtRef = useRef(0);
  /** A sync was requested while one was already running; run it straight after. */
  const pendingSyncRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True while the loop is idling and may park; false for anything urgent. */
  const waitRef = useRef(false);
  /** When holds may be attempted again, after this path refused one. */
  const holdBlockedUntilRef = useRef(0);

  dataRef.current = data;

  const commit = useCallback((next: ClientData) => {
    dataRef.current = next;
    setData(next);
  }, []);

  // ── Launch ──
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // FIRST, AND WITHOUT WAITING. This starts the database opening and the
        // single query that fetches every device preference, so that work is
        // already in flight while the lines below set up notifications and the
        // sync tables. It used to be fifteen separate keystore decrypts, in
        // series, and they were the largest single thing between tapping the
        // icon and seeing the planner.
        warmPrefs();

        // NOT awaited. Registering the Android notification channel is a native
        // round trip that nothing on screen depends on; it only has to be done
        // before an alarm is scheduled, and the first alarm plan is minutes of
        // app-time away. Awaiting it here bought nothing and cost the splash.
        void prepareNotifications().catch(() => { /* replanning reports this */ });

        const db = await openPlannerDatabase();
        const storage = createStorage(createExpoRunner(db));
        await storage.init();
        storageRef.current = storage;

        // Everything at once. The four keystore reads (identity and
        // credentials) overlap with each other and with the preference query,
        // which by now has usually already answered.
        const [
          deviceId, url, session, user,
          savedInterval, savedWindow, savedDayWindow, savedSwipe, savedCalendarView,
          savedPrayerLook, savedVisibleHours, storedTimerRaw, storedCentreRaw,
        ] = await Promise.all([
          prefs.getDeviceId(), prefs.getServerUrl(), prefs.getSession(), prefs.getUsername(),
          prefs.getInterval(), prefs.getCustomWindow(), prefs.getDayWindow(),
          prefs.getSwipeViewSwitch(), prefs.getCalendarView(),
          prefs.getPrayerAppearance(), prefs.getVisibleHours(),
          prefs.getFocusTimer(), prefs.getNotifyCentre(),
        ]);
        if (cancelled) return;

        // Not awaited: nothing below reads it back, and `load` prefers the id
        // already stored anyway.
        void storage.setDeviceId(deviceId);

        setPrayerLook(savedPrayerLook);
        setVisibleHoursState(savedVisibleHours);
        setIntervalState(savedInterval);
        setCustomWindowState(savedWindow);
        setDayWindowState(savedDayWindow);
        setSwipeState(savedSwipe);
        if (savedCalendarView && ['agenda', 'day', 'custom', 'week', 'month', 'year'].includes(savedCalendarView)) {
          setCalendarViewState(savedCalendarView as any);
        }

        // SETTLE FIRST, before anything is drawn. A session that ran out while
        // the app was closed is completed at the instant it actually ran out,
        // not at the moment you reopened the app, so six hours in a pocket
        // credits the right hour to the right day.
        const storedTimer = coerceFocusTimer(storedTimerRaw);
        const settled = reduceFocusTimer(storedTimer, { kind: 'settle' }, Date.now());
        focusTimerRef.current = settled.state;
        setFocusTimerState(settled.state);
        if (settled.changed) void prefs.setFocusTimer(settled.state);
        pendingFocusSessionRef.current = settled.session ?? null;

        // Pruned on the way in. The marks are a cache of decisions, and one for
        // a reminder three months gone can never be needed again.
        const centre = pruneCentreState(
          coerceCentreState(storedCentreRaw), { now: Date.now() },
        );
        notifyStateRef.current = centre;
        setNotifyStateRaw(centre);
        const loaded = await storage.load(deviceId);
        if (cancelled) return;

        commit(loaded);
        setServerUrl(url);
        setUsername(user);

        if (url && session) {
          transportRef.current = buildTransport(url, session);
        }
        setReady(true);
      } catch (err) {
        // A failure here means the local database is unusable. Say so rather
        // than showing an empty planner that looks like lost data.
        setLastError(err instanceof Error ? err.message : String(err));
        setReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, [commit]);

  function buildTransport(url: string, session: string | null): PlannerTransport {
    return createTransport({
      baseUrl: url,
      session,
      fetchImpl: fetch as any,
      onSession: s => { void prefs.setSession(s); },
    });
  }

  // ── Alarms follow the data ──
  /**
   * Work out what the OS should be holding, and make it so.
   *
   * Expensive, and in two different ways: `computeSchedule` walks every event
   * and task in the planner and expands two days of repeats, and `syncAlarms`
   * then makes a native round trip to read back every alarm Android currently
   * holds before scheduling or cancelling the difference.
   *
   * This used to run on EVERY edit, in full, immediately after the tap that
   * caused it — so ticking a task off spent the next frames doing this instead
   * of drawing the tick. It is now driven by the coalescer below.
   */
  const replanAlarmsNow = useCallback(async (current: ClientData) => {
    try {
      const events = readClientStore(current, 'events');
      const tasks = readClientStore(current, 'tasks');
      const now = Date.now();
      // Read from the data being planned against, not from the render's copy:
      // this runs straight after a sync, when `shared` is still a render behind.
      const currentShared = ((readClientStore(current, 'settings') as any)?.[SETTINGS_ENTITY]
        ?? {}) as Partial<SharedSettings>;
      const told = (currentShared as any).weekStartsOn;
      const currentWeekStart = (typeof told === 'number' && told >= 0 && told <= 6)
        ? (told as 0 | 1 | 2 | 3 | 4 | 5 | 6)
        : inferWeekStartsOn(events as any, tasks as any);

      // The window is deliberately wider than the alarm horizon: planAlarms
      // trims it back, and asking for slightly more costs nothing while making
      // sure nothing falls between the two ranges.
      // The user's OWN rules, not the defaults. Reminders fired from default
      // settings are worse than none: they arrive at times nobody chose, for
      // categories the user had switched off.
      const schedule = computeSchedule({
        events: events as any,
        tasks: tasks as any,
        categories: (currentShared.categories as any) ?? DEFAULT_CATEGORIES,
        settings: (currentShared.notifications as any) ?? DEFAULT_NOTIFICATION_SETTINGS,
        weekStartsOn: currentWeekStart,
        prayerDone: {},
        from: now,
        to: now + 48 * 60 * 60 * 1000,
      });

      scheduleRef.current = schedule as any[];

      // The alarms and the list must agree about when something will actually
      // arrive, so both go through `desiredAlarms`, which applies quiet hours,
      // and both skip anything already dealt with on any device.
      const marks = notifyStateRef.current;
      const plan = await syncAlarms(
        desiredAlarms(schedule as any, marks, {
          now,
          settings: (currentShared.notifications as any) ?? DEFAULT_NOTIFICATION_SETTINGS,
        }),
        { now, handledKeys: handledKeys(marks, now) },
      );
      setAlarmSummary(
        plan.keep.length + plan.schedule.length === 0
          ? 'Nothing to remind you about yet'
          : `${plan.keep.length + plan.schedule.length} reminders armed on this phone`,
      );
    } catch {
      // Alarm planning must never take the app down; the next sync retries it.
      setAlarmSummary('Reminders could not be scheduled. Check permissions.');
    }
  }, []);

  /**
   * One alarm plan per burst of edits, not one per edit.
   *
   * Reads `dataRef` at RUN time rather than carrying a snapshot, so whatever it
   * plans against is the newest data there is — which also means a plan cannot
   * be computed from state older than a sync that landed while it was waiting.
   *
   * The delay is short enough that reminders are armed before you have put the
   * phone down, and `maxWaitMs` guarantees a plan even while a finger is still
   * dragging. Backgrounding the app flushes it, which is the moment that
   * actually matters: that is when the alarms have to be right, because the app
   * will not be running to fix them.
   */
  const alarmPlanner = useMemo(() => createCoalescer<void>({
    delayMs: 900,
    maxWaitMs: 4_000,
    run: () => replanAlarmsNow(dataRef.current),
  }), [replanAlarmsNow]);

  const replanAlarms = useCallback(() => { alarmPlanner.schedule(undefined); }, [alarmPlanner]);

  /**
   * One write of the state blob per burst, instead of one per keystroke.
   *
   * Safe to defer because it is a CACHE: the ops that make up an edit are
   * written the instant the edit happens (`saveOps`), and `storage.load`
   * replays the outbox over whatever the blob says. So the worst a lost write
   * can cost is the few milliseconds `load` spends replaying, never an edit.
   * See the note at the top of `syncStorage.ts`.
   *
   * Reading `dataRef` at run time also removes the ordering hazard the split
   * creates: a write that fires just after a sync writes the POST-sync state,
   * never the pre-sync snapshot it was scheduled with.
   */
  const statePersister = useMemo(() => createCoalescer<void>({
    delayMs: 300,
    maxWaitMs: 2_000,
    run: async () => {
      const storage = storageRef.current;
      if (storage) await storage.saveState(dataRef.current);
    },
  }), []);

  // ── Sync ──
  /**
   * Set once the reconciler exists.
   *
   * `syncNow` is declared before `saveRecord`, which the reconciler needs, so
   * the two cannot simply reference each other. A ref closes the loop without
   * reordering half the provider around one call.
   */
  const reconcileFocusTimerRef = useRef<() => Promise<void>>(async () => {});

  const syncNow = useCallback(async () => {
    const storage = storageRef.current;
    const transport = transportRef.current;
    if (!storage || !transport) return;
    // THE WATCHDOG. A cycle that never finishes used to wedge the app for good:
    // every later sync — including the one that follows an edit — saw the guard
    // still set and returned immediately, so changes queued up behind a request
    // that was never coming back. It happens for real, because a held pull can
    // be suspended mid-flight when Android freezes the app on screen-off, and
    // the socket then neither completes nor errors.
    //
    // So the guard expires. Past the point where any legitimate cycle must have
    // finished, the old one is presumed dead and abandoned rather than waited
    // on. Its result is ignored if it ever does arrive: every cycle folds its
    // outcome onto current data, so a late one cannot resurrect stale state.
    const inFlightFor = Date.now() - syncStartedAtRef.current;
    if (syncingRef.current && inFlightFor < STUCK_AFTER_MS) {
      pendingSyncRef.current = true;
      return;
    }

    syncingRef.current = true;
    const startedAt = Date.now();
    syncStartedAtRef.current = startedAt;
    // Consumed here, so a request that arrives during this cycle is served
    // promptly rather than inheriting permission to park.
    const mayWait = waitRef.current;
    waitRef.current = false;
    setPhase('syncing');
    try {
      // The cycle works on a COPY taken now. Anything the user types during the
      // round trip lands in `dataRef` and is not in the outcome, so the outcome
      // is folded back onto current data rather than assigned over it. Assigning
      // it used to wipe the edit from the screen while still sending it, so the
      // PC had the new value and the phone showed the old one, forever.
      const before = dataRef.current;
      // Only the idle loop waits. A sync the user is standing in front of —
      // pull-to-refresh, opening the app, or one that follows an edit — wants an
      // answer now, not the freshest possible one twenty seconds later.
      const canHold = mayWait && Date.now() >= holdBlockedUntilRef.current;
      const outcome = await syncOnce(before, transport, Date.now(), canHold ? PULL_WAIT_MS : 0);
      if (outcome.holdRejected) {
        // The sync itself succeeded; only the waiting was rejected. Back to
        // plain polling on the safety timer for a while.
        holdBlockedUntilRef.current = Date.now() + HOLD_COOLDOWN_MS;
      }
      const merged: ClientData = reconcileAfterSync(before, dataRef.current, outcome);

      await storage.saveSynced(merged);
      commit(merged);
      setPhase(outcome.phase);

      if (outcome.error) {
        failuresRef.current += 1;
        setLastError(outcome.error);
      } else {
        failuresRef.current = 0;
        setLastError(null);
        replanAlarms();
        // Only on a healthy cycle: reconciling a timer against a server we
        // could not reach would compare it with nothing and look like a stop.
        await reconcileFocusTimerRef.current();
        // A read taken on the PC lands here; a dismissal taken here goes out.
        await pullNotifyRef.current();
        await flushNotifyRef.current();
      }
    } catch (err) {
      failuresRef.current += 1;
      if (isAuthError(err)) {
        transportRef.current = null;
        setUsername(null);
        setPhase('error');
        setLastError('Signed out — please sign in again.');
      } else {
        setPhase('offline');
        setLastError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Only if this cycle still owns the guard. A cycle the watchdog gave up on
      // may finish later, and clearing the flag then would let it cancel a
      // healthy cycle that had already started.
      if (syncStartedAtRef.current === startedAt) syncingRef.current = false;
      // Something asked for a sync while this one was in flight (an edit, almost
      // always). Serve it now rather than making the user wait out the poll --
      // that delay is most of what "the phone did not send it" felt like.
      if (pendingSyncRef.current) {
        pendingSyncRef.current = false;
        setTimeout(() => { void syncNow(); }, 0);
      } else {
        scheduleNextSync();
      }
    }
  }, [commit, replanAlarms]);

  const scheduleNextSync = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const failures = failuresRef.current;
    // Keenest exactly when something is waiting. Nothing tells the app that
    // Wi-Fi came back, so the delay it is sitting in IS how long a reconnect
    // takes to notice — and with unsent changes the user is watching for it.
    const waiting = dataRef.current.outbox.length > 0;
    const delay = failures === 0
      ? POLL_MS
      : Math.min(
        withJitter(backoffDelay(failures), failures),
        waiting ? RETRY_WITH_PENDING_MS : Number.POSITIVE_INFINITY,
      );
    timerRef.current = setTimeout(() => {
      waitRef.current = true;
      void syncNow();
    }, Math.max(1_000, delay));
  }, [syncNow]);

  // Kick the loop once we are ready and signed in.
  useEffect(() => {
    if (!ready || !transportRef.current) return;
    void syncNow();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [ready, syncNow, username]);

  // Coming back to the app is the strongest signal that a sync is worth trying:
  // the phone may have been on Wi-Fi for hours with the screen off.
  useEffect(() => {
    const handler = (state: AppStateStatus) => {
      if (state !== 'active') {
        // LEAVING. Everything that was allowed to lag while the app was on
        // screen has to be finished now, because the process may not be running
        // in a second's time: the state blob, the device preferences, and above
        // all the alarm plan — the OS is what fires reminders once we are gone,
        // so it must be holding the right ones before we stop.
        void statePersister.flush();
        void alarmPlanner.flush();
        void flushPrefs();
        return;
      }
      failuresRef.current = 0;
      // A new foreground is usually a new network, so give holding another go.
      holdBlockedUntilRef.current = 0;
      // Newer code first. If the PC has published a fix, coming back to the app
      // is the moment to pick it up -- otherwise the fix sits downloaded and
      // unused until the app is killed, which is how "it is still broken"
      // survives being fixed. This never blocks: it reloads or it does nothing.
      void applyUpdateIfAny();
      void syncNow();
      void (async () => {
        const now = Date.now();
        const missed = await collectMissed(now);
        if (missed.length === 0) return;
        // Anything that rang while the app was shut is RECORDED as delivered
        // before anything else happens. Without that the centre would show it as
        // still upcoming, and the PC would send it a second time.
        const next = recordFired(notifyStateRef.current, missed as any, {
          now, by: dataRef.current.deviceId,
        });
        if (next !== notifyStateRef.current) {
          notifyStateRef.current = next;
          setNotifyStateRaw(next);
          void prefs.setNotifyCentre(next);
          void flushNotifyRef.current();
        }
        replanAlarms();
      })();
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [syncNow, replanAlarms, statePersister, alarmPlanner]);

  // ── Editing ──
  const persistEdit = useCallback(async (next: ClientData, previous: ClientData) => {
    const storage = storageRef.current;
    const newOps = next.outbox.slice(previous.outbox.length);
    commit(next);

    // THE DURABLE HALF, IMMEDIATELY. Three small rows, and they are the only
    // copy of an edit made with no PC in reach.
    if (storage) await storage.saveOps(newOps);

    // THE EXPENSIVE HALF, COALESCED. Nearly a megabyte of JSON, and only a
    // cache: `load` replays the outbox over it, so a burst of edits writes it
    // once at the end instead of once per tap. This is most of what made a
    // drag stutter.
    statePersister.schedule(undefined);

    replanAlarms();
    void syncNow();
  }, [commit, replanAlarms, syncNow, statePersister]);

  const edit = useCallback(async (
    store: SyncStore, entityId: string, changes: Record<string, unknown>,
  ) => {
    const previous = dataRef.current;
    const next = applyLocalChange(previous, { store, entityId, changes, at: Date.now() });
    if (next === previous) return;
    await persistEdit(next, previous);
  }, [persistEdit]);

  const editMany = useCallback(async (
    store: SyncStore,
    edits: ReadonlyArray<{ id: string; changes: Record<string, unknown> }>,
  ) => {
    if (edits.length === 0) return;

    // `applyLocalChanges` refuses a batch that names one entity twice, because
    // the second set of ops would claim a base the first set already replaced.
    // Folding them here is the honest reading of "set this, then set that on the
    // same row": one edit with the later value.
    const byId = new Map<string, Record<string, unknown>>();
    const order: string[] = [];
    for (const e of edits) {
      const existing = byId.get(e.id);
      if (existing) Object.assign(existing, e.changes);
      else { byId.set(e.id, { ...e.changes }); order.push(e.id); }
    }

    const previous = dataRef.current;
    const next = applyLocalChanges(
      previous,
      order.map(id => ({ store, entityId: id, changes: byId.get(id)! })),
      Date.now(),
    );
    if (next === previous) return;
    await persistEdit(next, previous);
  }, [persistEdit]);

  const saveRecord = useCallback(async (
    store: SyncStore, entityId: string, record: Record<string, unknown>,
  ) => {
    const previous = dataRef.current;
    const next = applyLocalRecord(previous, { store, entityId, record, at: Date.now() });
    if (next === previous) return;
    await persistEdit(next, previous);
  }, [persistEdit]);

  /**
   * Tick something off.
   *
   * WHICH FIELD depends on the store, not on whether it repeats:
   *   events -> always `completedDates`, per date
   *   tasks  -> `completedDates` when repeating, the `completed` flag otherwise
   *
   * An earlier version branched on `repeating` alone, so ticking a one-off event
   * wrote a `completed` flag. It synced perfectly and the PC ignored it, which
   * looked exactly like sync being broken.
   */
  const toggleDone = useCallback(async (
    store: SyncStore,
    item: { masterId: string; date: string; repeating: boolean; completed: boolean },
  ) => {
    const current = readClientStore(dataRef.current, store)[item.masterId] ?? {};
    const done = Array.isArray(current.completedDates)
      ? [...(current.completedDates as string[])]
      : [];
    const nextDates = item.completed
      ? done.filter(d => d !== item.date)
      : [...new Set([...done, item.date])];

    if (store === 'events' || item.repeating) {
      await edit(store, item.masterId, { completedDates: nextDates });
      return;
    }
    // A one-off task: keep the flag and the date list agreeing, so whichever the
    // PC happens to read gives the same answer.
    await edit(store, item.masterId, {
      completed: !item.completed,
      completedDates: nextDates,
      completedAt: item.completed ? undefined : Date.now(),
    });
  }, [edit]);

  /**
   * The settings the PC shares with this phone.
   *
   * Only ever the shared half — week start, categories, prayer and notification
   * rules. How this device draws the planner is its own business and is not in
   * here by construction, so nothing on the desk can reshape the phone.
   */
  const shared = useMemo<Partial<SharedSettings>>(
    () => ((readClientStore(data, 'settings') as any)?.[SETTINGS_ENTITY] ?? {}),
    [data],
  );

  /**
   * Which weekday weeks start on, taken from the records themselves.
   *
   * NOT hardcoded, and not guessed. An item is stored as a week anchor plus an
   * offset, so writing the anchor for the wrong week start drops it into the
   * wrong column of the PC's grid while still resolving to the right date --
   * which reads as sync corrupting data rather than as a bad record. The
   * existing records already state the answer, so they are asked.
   */
  const weekStartsOn = useMemo(() => {
    // The PC's own answer, once it has reached us. Inference stays as the
    // fallback for a phone that has not synced settings yet — a first run, or an
    // older PC that does not send them — because writing an item against the
    // wrong week start puts it in the wrong column and looks like corruption.
    const told = (shared as any).weekStartsOn;
    if (typeof told === 'number' && told >= 0 && told <= 6) return told as 0 | 1 | 2 | 3 | 4 | 5 | 6;
    return inferWeekStartsOn(
      readClientStore(data, 'events') as any,
      readClientStore(data, 'tasks') as any,
    );
  }, [shared, data]);

  /**
   * The focus history, as a list.
   *
   * Stored as records keyed by id so the merge can work per session; the screen
   * wants a list, and sorting by start makes it the same list the PC shows.
   */
  const focusSessions = useMemo(() => {
    const byId = readClientStore(data, 'focusSessions') as Record<string, any>;
    return Object.values(byId ?? {})
      .filter(s => s && typeof s === 'object')
      .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  }, [data]);

  /**
   * Prayer times for a day, computed from the month cache the PC keeps.
   *
   * The cache syncs like everything else, so the times are known with no signal
   * at all. That matters more here than anywhere: a prayer time you can only
   * look up online is one you cannot look up in the places you most need it.
   */
  const prayerSettings = useMemo(
    () => coercePrayerSettings((shared as any).prayer),
    [shared],
  );

  const prayerMonths = useMemo(
    () => readClientStore(data, 'prayerTimes') as Record<string, any>,
    [data],
  );

  /** What this phone holds, so the prayer screen can say so plainly. */
  const prayerCacheSummary = useMemo(() => {
    const today = ymd(new Date());
    const key = `${prayerQueryKey(prayerSettings)}|${today.slice(0, 4)}-${Number(today.slice(5, 7))}`;
    return {
      months: Object.keys(prayerMonths ?? {}).length,
      key,
      hasToday: Boolean((prayerMonths?.[key] as any)?.days?.[today]),
    };
  }, [prayerMonths, prayerSettings]);

  const prayersOn = useCallback((date: string): PrayerOccurrence[] => {
    if (!prayerSettings.enabled) return [];
    // The cache is keyed by city, country, method and month, so the key has to
    // be rebuilt from the settings exactly as the PC built it.
    const key = `${prayerQueryKey(prayerSettings)}|${date.slice(0, 4)}-${Number(date.slice(5, 7))}`;
    const entry = prayerMonths?.[key];
    const times = entry?.days?.[date];
    // The language is this device's choice, like the colour and the shape: the
    // names are drawn here, so the screen that draws them decides.
    return buildPrayerDay(date, times, prayerSettings, prayerAppearance.language);
  }, [prayerSettings, prayerMonths, prayerAppearance.language]);

  const prayerDone = useMemo(
    () => readClientStore(data, 'prayerDone') as Record<string, any>,
    [data],
  );

  const isPrayerDone = useCallback((date: string, key: string): boolean => {
    const entry = prayerDone?.[date];
    const done = entry?.done;
    return Array.isArray(done) && done.includes(key);
  }, [prayerDone]);

  const togglePrayer = useCallback(async (date: string, key: string) => {
    const entry = (readClientStore(dataRef.current, 'prayerDone') as any)?.[date];
    const done: string[] = Array.isArray(entry?.done) ? [...entry.done] : [];
    const next = done.includes(key) ? done.filter(k => k !== key) : [...done, key];
    await edit('prayerDone', date, { done: next });
  }, [edit]);

  /** The user's own categories, for colours. Defaults only until they arrive. */
  const categories = useMemo(
    () => ((shared as any).categories as any[] | undefined) ?? DEFAULT_CATEGORIES,
    [shared],
  );

  const saveDraft = useCallback(async (
    store: SyncStore, draftInput: DraftInput, editingId?: string,
  ): Promise<string> => {
    const id = editingId ?? newId();
    // Read through the REF, not `data`: the editor may have been open while a
    // sync landed, and merging onto a stale copy would drop whatever arrived.
    const existing = editingId
      ? (readClientStore(dataRef.current, store) as any)[editingId]
      : undefined;

    const meta = { id, now: Date.now(), weekStartsOn };
    const record = store === 'events'
      ? buildEventRecord(draftInput, meta, existing)
      : buildTaskRecord(draftInput, meta, existing);

    await saveRecord(store, id, record);
    return id;
  }, [saveRecord, weekStartsOn]);

  const removeItem = useCallback(async (store: SyncStore, id: string) => {
    // A TOMBSTONE, not a local removal. Dropping the record here would leave the
    // PC holding it, and the next sync would hand it straight back.
    await edit(store, id, { [DELETED_FIELD]: true });
  }, [edit]);

  const applyScoped = useCallback(async (
    store: SyncStore,
    masterId: string,
    date: string | null,
    scope: OccurrenceScope,
    action: 'edit' | 'delete',
    patch: Record<string, unknown> = {},
  ): Promise<string | null> => {
    // Through the ref, like `saveDraft`: the menu may have been open while a
    // sync landed, and planning against a stale master would split the wrong
    // series.
    const master = (readClientStore(dataRef.current, store) as any)[masterId];
    if (!master) return null;

    const opts = { weekStartsOn, newId };
    const plan = action === 'edit'
      ? planOccurrenceEdit(master, date, scope, patch as any, opts)
      : planOccurrenceDelete(master, date, scope, opts);

    // An empty plan is a genuine no-op, so it must not become a write. A
    // redundant write is a sync op that can lose a race against a real one.
    for (const w of plan.writes) {
      if (w.op === 'remove') await removeItem(store, w.id);
      else await saveRecord(store, w.id, w.record as Record<string, unknown>);
    }
    return plan.targetId;
  }, [removeItem, saveRecord, weekStartsOn]);

  /**
   * The whole timer, in one place: reduce, persist, log, push.
   *
   * The reducer decides everything; this only carries out what it decided. That
   * split is what lets the timer be tested against a closed app, a clock that
   * jumps and two devices at once, none of which can be reproduced here.
   */
  const runFocusTimer = useCallback(async (action: FocusTimerAction) => {
    const out = reduceFocusTimer(
      focusTimerRef.current, action, Date.now(), dataRef.current.deviceId,
    );
    // An unchanged state must not be written. A redundant write is a POST that
    // can lose a race against a real one made on the PC a moment later.
    if (!out.changed) return;

    focusTimerRef.current = out.state;
    setFocusTimerState(out.state);
    void prefs.setFocusTimer(out.state);

    // The finished session, if this action ended one. Its id is derived, not
    // random, so the same session completed on both machines collapses to one
    // record rather than counting the hour twice.
    if (out.session) {
      await saveRecord('focusSessions', out.session.id, out.session as any);
    }

    void transportRef.current?.putFocusTimer(out.state as any).catch(() => {
      // Offline is the normal case, not an error: the phone holds the timer and
      // the next successful sync reconciles it.
    });
  }, [saveRecord]);

  /**
   * Reconcile the phone's timer with the PC's.
   *
   * Both machines can start one, and neither is wrong. `mergeFocusTimers` picks
   * the newest START, because that is the one the user is sitting in front of,
   * and hands back the loser as a finished record so no worked time is ever
   * thrown away, only a countdown.
   */
  const reconcileFocusTimer = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport) return;
    let remote: unknown;
    try {
      remote = await transport.getFocusTimer();
    } catch {
      return;
    }
    const mine = focusTimerRef.current;
    const merged = mergeFocusTimers(mine, coerceFocusTimer(remote), Date.now());
    if (merged.salvaged) {
      await saveRecord('focusSessions', merged.salvaged.id, merged.salvaged as any);
    }
    if (merged.state !== mine) {
      focusTimerRef.current = merged.state;
      setFocusTimerState(merged.state);
      void prefs.setFocusTimer(merged.state);
    } else {
      // We won. Tell the other machine rather than letting it keep a timer the
      // user has already moved on from.
      void transport.putFocusTimer(merged.state as any).catch(() => {});
    }
  }, [saveRecord]);

  reconcileFocusTimerRef.current = reconcileFocusTimer;

  // ── The notification centre ──
  /**
   * One action, applied everywhere it has to land.
   *
   * The order matters. The marks are written first because they are what the
   * user just decided; the alarms are replanned next so a dismissal actually
   * cancels the buzz; the server is told last, and failing to tell it is not an
   * error. Nothing is queued: `pendingSync` recomputes the whole payload from
   * the marks next time, so an unreachable PC costs a delay, never a decision.
   */
  const applyNotify = useCallback((
    fn: (state: NotifyCentreState, opts: { now: number; by: string; items?: any }) => NotifyCentreState,
  ) => {
    const now = Date.now();
    const next = fn(notifyStateRef.current, {
      now,
      by: dataRef.current.deviceId,
      items: scheduleRef.current,
    });
    if (next === notifyStateRef.current) return;
    notifyStateRef.current = next;
    setNotifyStateRaw(next);
    void prefs.setNotifyCentre(next);
    replanAlarms();
    void flushNotifyRef.current();
  }, [replanAlarms]);

  /**
   * Report this phone's decisions to the PC.
   *
   * `local-fired` goes FIRST, deliberately: the engine ignores an action on a
   * key it has never heard of, so telling it "this was dismissed" before
   * telling it "this fired here" would silently drop the dismissal and the PC
   * would send the reminder again.
   */
  const flushNotifyCentre = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport) return;
    const sentAt = Date.now();
    const payload = pendingSync(notifyStateRef.current, sentAt);
    if (payload.keys.length === 0) return;

    const deviceId = dataRef.current.deviceId;
    try {
      if (payload.fired.length) {
        await transport.notifyLocalFired(payload.fired, deviceId);
      }
      const buckets: [string, string[]][] = [
        ['read', payload.read],
        ['unread', payload.unread],
        ['done', payload.completed],
        ['clear', payload.cleared],
      ];
      for (const [action, keys] of buckets) {
        if (keys.length) await transport.notifyAction(action, keys, deviceId);
      }
      for (const s of payload.snoozed) {
        await transport.notifyAction('snooze', [s.key], deviceId, s.minutes);
      }
    } catch {
      // Left unstamped, so the next flush sends it again with a fresh snooze
      // duration. Nothing is lost by failing here.
      return;
    }

    const acked = markSynced(notifyStateRef.current, payload.keys, { now: Date.now(), sentAt });
    if (acked !== notifyStateRef.current) {
      notifyStateRef.current = acked;
      setNotifyStateRaw(acked);
      void prefs.setNotifyCentre(acked);
    }
  }, []);

  const flushNotifyRef = useRef<() => Promise<void>>(async () => {});
  flushNotifyRef.current = flushNotifyCentre;

  /** A read taken on the PC, folded in without undoing one taken here. */
  const pullNotifyCentre = useCallback(async () => {
    const transport = transportRef.current;
    if (!transport) return;
    let store: unknown;
    try {
      store = await transport.notifyStore();
    } catch {
      return;
    }
    const merged = mergeCentreState(
      notifyStateRef.current, centreStateFromServer(store as any),
    );
    if (merged === notifyStateRef.current) return;
    notifyStateRef.current = merged;
    setNotifyStateRaw(merged);
    void prefs.setNotifyCentre(merged);
  }, []);

  const pullNotifyRef = useRef<() => Promise<void>>(async () => {});
  pullNotifyRef.current = pullNotifyCentre;


  // The session that finished while the app was shut, written as soon as there
  // is a database. Kept out of the launch path so nothing delays the first paint.
  useEffect(() => {
    if (!ready) return;
    const pending = pendingFocusSessionRef.current;
    if (!pending) return;
    pendingFocusSessionRef.current = null;
    void saveRecord('focusSessions', pending.id, pending);
  }, [ready, saveRecord]);

  const answerConflict = useCallback(async (conflict: SyncConflict, choice: ResolveChoice) => {
    const previous = dataRef.current;
    const next = applyLocalResolution(previous, conflict, choice, Date.now());
    await persistEdit(next, previous);
    // Tell the server too, so the card closes on the PC as well.
    void transportRef.current?.resolve(previous.deviceId, conflict.id, choice).catch(() => {});
  }, [persistEdit]);

  // ── Account ──
  const connect = useCallback(async (url: string, user: string, password: string) => {
    const transport = createTransport({
      baseUrl: url,
      fetchImpl: fetch as any,
      onSession: s => { void prefs.setSession(s); },
    });
    const who = await transport.login(user, password);

    await prefs.setServerUrl(url);
    await prefs.setUsername(who.username);
    transportRef.current = transport;
    setServerUrl(url);
    setUsername(who.username);
    failuresRef.current = 0;
    setLastError(null);
    await syncNow();
  }, [syncNow]);

  const signOut = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    transportRef.current = null;
    await prefs.signOut();
    setUsername(null);
    setPhase('idle');
  }, []);

  const resetLocal = useCallback(async () => {
    const storage = storageRef.current;
    if (!storage) return;
    // Drop anything the coalescer is holding FIRST. A state write scheduled a
    // moment ago would otherwise land after the wipe and put the whole planner
    // straight back, which is the one thing "Reset local data" must not do.
    statePersister.cancel();
    await statePersister.settled();
    await storage.reset();
    const deviceId = await prefs.getDeviceId();
    const fresh = await storage.load(deviceId);
    commit(fresh);
    failuresRef.current = 0;
    await syncNow();
  }, [commit, syncNow, statePersister]);

  // ── Derived ──
  /**
   * The stores, materialised ONCE per change rather than per call.
   *
   * `readClientStore` walks every entity and every field to rebuild a plain
   * record. As a callback that ran on every call, so a screen that asked for the
   * events three times in a render rebuilt them three times, and the month view
   * asking inside a loop rebuilt them per cell. Memoising makes the cost
   * proportional to how often the data changes, which is what it should have
   * been proportional to all along.
   */
  const eventsMap = useMemo(() => readClientStore(data, 'events'), [data]);
  const tasksMap = useMemo(() => readClientStore(data, 'tasks'), [data]);

  const events = useCallback(() => eventsMap, [eventsMap]);
  const tasks = useCallback(() => tasksMap, [tasksMap]);

  /**
   * One record out of any store, deleted or not, for the conflicts screen.
   *
   * Deliberately not routed through `events()`/`tasks()`: those hide deleted
   * records, which is right for the planner and exactly wrong for a card whose
   * whole subject is something that was deleted.
   */
  const peek = useCallback(
    (store: SyncStore, entityId: string) => peekEntity(dataRef.current.state, store, entityId),
    [],
  );

  /**
   * One day's agenda, built at most once per set of inputs.
   *
   * `buildDay` walks every event in the planner and asks the recurrence engine
   * about each one, which the month view then does forty-two times — and did
   * again on every render. The cache lives inside this `useMemo`, so it is
   * created FROM the events, tasks, week start and categories it answers for
   * and thrown away whole the moment any of them changes. There is no partial
   * invalidation to get wrong, and therefore no way to show a day that is no
   * longer true. See `dayCache.ts`.
   */
  const dayBuilder = useMemo(
    () => createKeyedCache(key => buildDay({
      events: eventsMap,
      tasks: tasksMap,
      // The key carries a "|today" marker for the current day; the date itself
      // is everything before it.
      date: key.split('|')[0],
      // Both taken from the PC rather than guessed: a repeat expands against the
      // week start, and an item's colour comes from its category.
      weekStartsOn,
      categories,
      includeUndatedTasks: key.endsWith('|today'),
    })),
    [eventsMap, tasksMap, weekStartsOn, categories],
  );

  const day = useCallback(
    // `ymd(new Date())` is read on every call, exactly as it was before the
    // cache existed, and travels in the key. An app left open across midnight
    // therefore starts asking a different question rather than being handed
    // yesterday's answer.
    (date: string) => dayBuilder.get(dayCacheKey(date, ymd(new Date()))),
    [dayBuilder],
  );

  /**
   * The sync line, rebuilt only when it actually says something different.
   *
   * The loop moves through phases several times a minute forever, and each pass
   * produced a fresh object. That identity change flowed through the context
   * and re-rendered every screen in the app — the calendar grid included — to
   * redraw a line of text that had not changed. Comparing by value keeps the
   * indicator exactly as live as it was: the instant any field differs, the new
   * object is the one that goes out.
   */
  const lastStatusRef = useRef<SyncStatus | null>(null);
  const status = useMemo(() => {
    const next = describeStatus(data, phase, Date.now());
    const previous = lastStatusRef.current;
    if (sameStatus(previous, next)) return previous as SyncStatus;
    lastStatusRef.current = next;
    return next;
  }, [data, phase]);

  // Relative wording ("in 20 minutes") is a claim about now, so it is rebuilt on
  // a slow tick rather than left to whatever last caused a render.
  useEffect(() => {
    const id = setInterval(() => setNotifyClock(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const notifyCentre = useMemo(() => buildCentre({
    schedule: scheduleRef.current as any,
    state: notifyState,
    now: notifyClock,
    settings: (shared.notifications as any) ?? DEFAULT_NOTIFICATION_SETTINGS,
  }), [notifyState, notifyClock, shared.notifications, alarmSummary]);

  /**
   * The centre, reachable from a callback without being a dependency of one.
   *
   * `notifyComplete` and `notifyMarkAllRead` need the CURRENT list, but closing
   * over it would make both callbacks change every thirty seconds and drag the
   * whole context value with them.
   */
  const notifyCentreRef = useRef(notifyCentre);
  notifyCentreRef.current = notifyCentre;

  const snoozeOptions = useMemo(() => {
    const raw = (shared.notifications as any)?.snoozeOptions;
    return Array.isArray(raw) && raw.length
      ? raw.filter((n: unknown) => typeof n === 'number' && n > 0)
      : [5, 10, 30, 60];
  }, [shared.notifications]);

  // ── Actions, all stable ──
  // Written as callbacks rather than inline arrows so that the context value
  // below can be memoised at all: an object rebuilt every render defeats every
  // consumer's ability to skip work, however carefully the rest is written.
  const notifyRead = useCallback(
    (keys: string[]) => applyNotify((st, o) => markRead(st, keys, o)), [applyNotify]);
  const notifyUnread = useCallback(
    (keys: string[]) => applyNotify((st, o) => markUnread(st, keys, o)), [applyNotify]);
  const notifyDismiss = useCallback(
    (keys: string[]) => applyNotify((st, o) => dismissKeys(st, keys, o)), [applyNotify]);
  const notifySnooze = useCallback(
    (keys: string[], minutes: number) => applyNotify((st, o) => snoozeKeys(st, keys, minutes, o)),
    [applyNotify]);
  const notifyClear = useCallback(
    (keys: string[]) => applyNotify((st, o) => clearEntries(st, keys, o)), [applyNotify]);
  const notifyMarkAllRead = useCallback(
    () => applyNotify((st, o) => markAllRead(st, notifyCentreRef.current, o)), [applyNotify]);

  /**
   * Completing from the list also ticks the thing itself.
   *
   * `markCompleted` only records that the reminder was dealt with; the item
   * is a separate fact, and leaving it unticked would mean dismissing a
   * reminder for a task that then stays open forever.
   */
  const notifyComplete = useCallback((keys: string[]) => {
    applyNotify((st, o) => markCompleted(st, keys, o));
    for (const key of keys) {
      const entry = notifyCentreRef.current.entries.find(e => e.key === key);
      if (!entry || !entry.refId) continue;
      if (entry.kind !== 'task' && entry.kind !== 'event') continue;
      void toggleDone(entry.kind === 'task' ? 'tasks' : 'events', {
        masterId: entry.refId,
        date: entry.occDate ?? ymd(new Date()),
        repeating: Boolean(entry.occDate),
        completed: false,
      });
    }
  }, [applyNotify, toggleDone]);

  /**
   * Named `setSnapInterval`, NOT `setInterval`.
   *
   * A `const setInterval` in this scope shadows the global one, and the
   * thirty-second clock above would then be calling this — handing a function
   * where a number belongs, and never ticking again. It has bitten this project
   * once already, in the settings screen.
   */
  const setSnapInterval = useCallback((minutes: number) => {
    setIntervalState(minutes);
    void prefs.setInterval(minutes);
  }, []);

  const setCalendarView = useCallback(
    (v: 'agenda' | 'day' | 'custom' | 'week' | 'month' | 'year') => {
      setCalendarViewState(v);
      void prefs.setCalendarView(v);
    }, []);

  const setCustomWindow = useCallback((before: number, after: number) => {
    setCustomWindowState({ before, after });
    void prefs.setCustomWindow(before, after);
  }, []);

  // The repaired window is computed here and stored, rather than being read
  // back from disk: moving one end can move the other, and the screen has to
  // show the corrected pair immediately rather than a frame of the illegal one.
  // Both read the window through the state updater rather than closing over it,
  // so neither has to change when it moves.
  const setDayStart = useCallback((hour: number) => {
    setDayWindowState(current => {
      const next = withDayStart(current, hour);
      void prefs.setDayWindow(next);
      return next;
    });
  }, []);

  const setDayEnd = useCallback((hour: number) => {
    setDayWindowState(current => {
      const next = withDayEnd(current, hour);
      void prefs.setDayWindow(next);
      return next;
    });
  }, []);

  const setSwipeViewSwitch = useCallback((on: boolean) => {
    setSwipeState(on);
    void prefs.setSwipeViewSwitch(on);
  }, []);

  const setVisibleHours = useCallback((ranges: HourRange[]) => {
    const clean = normaliseRanges(ranges);
    setVisibleHoursState(clean);
    void prefs.setVisibleHours(clean);
  }, []);

  const setPrayerAppearance = useCallback((look: PrayerAppearance) => {
    setPrayerLook(look);
    void prefs.setPrayerAppearance(look);
  }, []);

  const signedIn = Boolean(username && transportRef.current);
  const taskLists = useMemo(
    () => (shared.taskLists as any[]) ?? [], [shared.taskLists]);
  const unreadNotifications = notifyCentre.unread;

  /**
   * What every screen reads.
   *
   * Memoised, and deliberately WITHOUT `notifyCentre` in it. The centre is
   * rebuilt every thirty seconds so that "in 20 minutes" stays true, and while
   * it lived here that tick handed every consumer a brand new context value and
   * re-rendered the entire app — the calendar grid, the task list, all of it —
   * twice a minute, forever, for a phrase almost nobody was looking at.
   *
   * The bell needs only the COUNT, which is a number and usually the same
   * number, so it stays here. The list itself moved to its own context below,
   * where the one screen that shows it can subscribe on its own.
   */
  const value = useMemo<PlannerContextValue>(() => ({
    ready,
    signedIn,
    username,
    serverUrl,
    data,
    status,
    conflicts: data.conflicts,
    alarmSummary,
    day,
    events,
    tasks,
    peek,
    connect,
    signOut,
    syncNow,
    edit,
    editMany,
    saveRecord,
    toggleDone,
    saveDraft,
    removeItem,
    applyScoped,
    weekStartsOn,
    shared,
    categories,
    timeFormat: shared.timeFormat,
    taskLists,
    focusSessions,
    focusTimer,
    runFocusTimer,
    unreadNotifications,
    snoozeOptions,
    notifyRead,
    notifyUnread,
    notifyDismiss,
    notifySnooze,
    notifyClear,
    notifyMarkAllRead,
    notifyComplete,
    prayersOn,
    isPrayerDone,
    togglePrayer,
    interval,
    setInterval: setSnapInterval,
    calendarView,
    setCalendarView,
    customWindow,
    setCustomWindow,
    dayWindow,
    setDayStart,
    setDayEnd,
    swipeViewSwitch,
    setSwipeViewSwitch,
    visibleHours,
    setVisibleHours,
    prayerAppearance,
    setPrayerAppearance,
    prayerCacheSummary,
    answerConflict,
    resetLocal,
    lastError,
  }), [
    ready, signedIn, username, serverUrl, data, status, alarmSummary,
    day, events, tasks, connect, signOut, syncNow, edit, editMany, saveRecord, toggleDone,
    saveDraft, removeItem, applyScoped, weekStartsOn, shared, categories,
    taskLists, focusSessions, focusTimer, runFocusTimer,
    unreadNotifications, snoozeOptions,
    notifyRead, notifyUnread, notifyDismiss, notifySnooze, notifyClear,
    notifyMarkAllRead, notifyComplete,
    prayersOn, isPrayerDone, togglePrayer,
    interval, setSnapInterval, calendarView, setCalendarView,
    customWindow, setCustomWindow, dayWindow, setDayStart, setDayEnd,
    swipeViewSwitch, setSwipeViewSwitch, visibleHours, setVisibleHours,
    prayerAppearance, setPrayerAppearance, prayerCacheSummary,
    answerConflict, resetLocal, lastError, peek,
  ]);

  return (
    <PlannerContext.Provider value={value}>
      <NotifyCentreContext.Provider value={notifyCentre}>
        {children}
      </NotifyCentreContext.Provider>
    </PlannerContext.Provider>
  );
}
