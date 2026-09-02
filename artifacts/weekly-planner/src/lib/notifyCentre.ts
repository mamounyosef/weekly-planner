// ─── The notification centre, as data ────────────────────────────────────────
//
// WHAT THIS IS FOR
// The PC's centre reads a server-owned store of things that have already been
// delivered. A phone cannot do that, because the phone is the machine that is
// offline: it fires its own alarms from `computeSchedule`, often for days on end
// with no server in reach, and it still has to answer three questions the moment
// it is unlocked — what fired while I was not looking, what is still coming, and
// what have I already dealt with.
//
// So the phone's centre is derived rather than stored. The SCHEDULE is the
// authority on what exists and when; a small per-key MARK is the authority on
// what the user did about it. Everything on the screen falls out of joining the
// two, which is why this file holds no clock reads, no storage and no React: the
// same inputs always produce the same list, and the tests can therefore push the
// phone through a fortnight offline in a millisecond.
//
// WHY MARKS ARE KEYED THE WAY THEY ARE
// A mark is keyed by the notification key (`event:<id>:<date>:<offset>`), which
// is built from the OFFSET and not from the fire time. That is the whole dedupe
// mechanism, on both machines, and it is what makes the awkward cases fall into
// place for free: move an event and the reminder that already fired keeps its
// key, so it is not re-listed as something new; dismiss one occurrence of a
// repeating item and only that date's keys are affected, because the date is in
// the key.
//
// WHAT COUNTS AS "DEALT WITH"
// Read, dismissed, completed and cleared all mean the user has seen it, so all
// four make the key HANDLED, and a handled key is never re-armed as an alarm and
// is reported to the server so the PC does not send it through another
// transport. A snooze is the exact opposite: it is a request to be told again,
// so it un-handles the key and moves it to a new time.
//
// MERGING BETWEEN DEVICES
// Read state is shared, and two devices can dismiss the same thing in the same
// second while neither can see the other. So marks merge without a coordinator:
// facts (it fired, it was completed) union, and the DECISION (read, snoozed,
// dismissed, cleared) is one indivisible thing decided by `(at, by)`, wall clock
// then device id. That is a deliberate departure from the op-log's
// `(lamport, deviceId)`: there is no lamport clock for a notification, nothing
// downstream depends on the order, and the disagreement window is one tap wide.
// What matters is only that both devices reach the SAME answer, which the tests
// assert by merging in both directions and comparing.

import { addDays, format } from 'date-fns';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  inQuietHours,
  quietReleaseAt,
  type NotificationKind,
  type NotificationRecord,
  type NotificationSettings,
  type NotificationStore,
  type NotifyPriority,
  type ScheduledNotification,
} from './notifications';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How far back the centre looks. Older than this is history nobody scrolls to. */
export const DEFAULT_PAST_WINDOW_MS = 7 * DAY_MS;

/**
 * How far forward it looks.
 *
 * Deliberately wider than the alarm horizon (36h): the list is also how you
 * check that tomorrow morning is covered, and showing less than the phone has
 * actually armed would read as reminders going missing.
 */
export const DEFAULT_FUTURE_WINDOW_MS = 3 * DAY_MS;

/** Enough to scroll through a bad week, few enough to render in one list. */
export const DEFAULT_MAX_ENTRIES = 200;

/** Delivered more than a minute after its moment counts as late, not on time. */
export const LATE_TOLERANCE_MS = MINUTE_MS;

/** Under five minutes of drift is a rounding difference, not a moved event. */
export const MOVED_TOLERANCE_MS = 5 * MINUTE_MS;

/** Snooze lengths the screen offers. The user's own list overrides this. */
export const DEFAULT_SNOOZE_OPTIONS = [5, 15, 60] as const;

// ─── Marks: what the user did about one notification ─────────────────────────

export interface NotifyMark {
  key: string;
  /**
   * When this actually reached the user. Absent means it has not been
   * delivered by this device, which is NOT the same as "has not happened":
   * anything whose moment passed while the app was closed is shown as fired
   * without a `firedAt`, and that absence is how the missed pile is found.
   */
  firedAt?: number;
  read?: boolean;
  readAt?: number;
  /** Swiped away. Implies read, and means "I have handled this". */
  dismissedAt?: number;
  /** Removed from the list entirely. A tombstone, never a deletion, because
   *  the schedule would otherwise conjure the same entry straight back. */
  cleared?: boolean;
  /** Ticked off from the notification itself. */
  completed?: boolean;
  snoozedUntil?: number;
  snoozedAt?: number;
  /** How many times in a row, so the screen can stop pretending it is working. */
  snoozeCount?: number;
  /**
   * Everything needed to draw this after the item behind it is gone. Without
   * it, deleting an event would silently erase the reminder that already woke
   * you up, and the history would quietly disagree with what happened.
   */
  snapshot?: ScheduledNotification;
  /** When the decision was taken. Half of the merge order. */
  at: number;
  /** Which device took it. The other half, and the "read on your PC" line. */
  by?: string;
  /** When the server last acknowledged this mark. Below `at` means unsent. */
  syncedAt?: number;
}

export interface NotifyCentreState {
  marks: Record<string, NotifyMark>;
  updatedAt: number;
}

export const EMPTY_CENTRE_STATE: NotifyCentreState = { marks: {}, updatedAt: 0 };

/** Anything read back off the phone's disk is untrusted; this is the gate. */
export function coerceCentreState(raw: unknown): NotifyCentreState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { marks: {}, updatedAt: 0 };
  const r = raw as Record<string, unknown>;
  const marks: Record<string, NotifyMark> = {};

  if (r.marks && typeof r.marks === 'object' && !Array.isArray(r.marks)) {
    for (const [key, value] of Object.entries(r.marks as Record<string, unknown>)) {
      if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const m = value as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;

      const mark: NotifyMark = {
        key,
        at: num(m.at) ?? 0,
        firedAt: num(m.firedAt),
        readAt: num(m.readAt),
        dismissedAt: num(m.dismissedAt),
        snoozedUntil: num(m.snoozedUntil),
        snoozedAt: num(m.snoozedAt),
        snoozeCount: num(m.snoozeCount),
        syncedAt: num(m.syncedAt),
      };
      if (m.read === true) mark.read = true;
      if (m.completed === true) mark.completed = true;
      if (m.cleared === true) mark.cleared = true;
      if (typeof m.by === 'string' && m.by) mark.by = m.by;

      const snap = coerceSnapshot(m.snapshot);
      if (snap) mark.snapshot = snap;

      // A mark that records nothing at all is noise from a half-written file.
      if (!hasSubstance(mark)) continue;
      marks[key] = mark;
    }
  }

  return {
    marks,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
  };
}

function hasSubstance(m: NotifyMark): boolean {
  return m.read === true
    || m.completed === true
    || m.cleared === true
    || m.firedAt != null
    || m.dismissedAt != null
    || m.snoozedUntil != null;
}

function coerceSnapshot(raw: unknown): ScheduledNotification | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.key !== 'string' || !s.key) return undefined;
  if (typeof s.fireAt !== 'number' || !Number.isFinite(s.fireAt)) return undefined;
  const kind = s.kind;
  const okKind = kind === 'event' || kind === 'task' || kind === 'task-digest' || kind === 'prayer';
  return {
    key: s.key,
    kind: okKind ? (kind as NotificationKind) : 'event',
    refId: typeof s.refId === 'string' ? s.refId : '',
    occDate: typeof s.occDate === 'string' ? s.occDate : '',
    fireAt: s.fireAt,
    anchorAt: typeof s.anchorAt === 'number' && Number.isFinite(s.anchorAt) ? s.anchorAt : s.fireAt,
    offsetMin: typeof s.offsetMin === 'number' && Number.isFinite(s.offsetMin) ? s.offsetMin : 0,
    title: typeof s.title === 'string' && s.title.trim() ? s.title : 'Reminder',
    body: typeof s.body === 'string' ? s.body : '',
    priority: s.priority === 'critical' ? 'critical' : 'normal',
    color: typeof s.color === 'string' ? s.color : undefined,
    allDay: s.allDay === true,
    url: typeof s.url === 'string' ? s.url : '',
  };
}

/** The stored half of a schedule entry, kept small on purpose. */
export function snapshotOf(item: ScheduledNotification): ScheduledNotification {
  return {
    key: item.key,
    kind: item.kind,
    refId: item.refId,
    occDate: item.occDate,
    fireAt: item.fireAt,
    anchorAt: item.anchorAt,
    offsetMin: item.offsetMin,
    title: item.title,
    body: item.body,
    priority: item.priority,
    color: item.color,
    allDay: item.allDay,
    url: item.url,
  };
}

// ─── Entries: one row on the screen ──────────────────────────────────────────

/**
 * Where a reminder sits relative to now.
 *
 * Only three states, and they are mutually exclusive on purpose: the screen is
 * one timeline, and an entry that could be both "coming" and "already fired"
 * would have to be drawn twice.
 */
export type CentreStatus = 'fired' | 'snoozed' | 'upcoming';

export interface CentreEntry {
  key: string;
  kind: NotificationKind;
  refId: string;
  occDate: string;
  title: string;
  body: string;
  priority: NotifyPriority;
  color?: string;
  allDay: boolean;
  url: string;
  offsetMin: number;
  /** The instant being reminded ABOUT, which is not the reminder's own time. */
  anchorAt: number;
  /** What the schedule says, before a snooze or quiet hours moved it. */
  scheduledAt: number;
  /** When it lands for the user. The list is ordered and grouped on this. */
  at: number;
  status: CentreStatus;
  read: boolean;
  /** Exactly what the badge counts, so no caller has to re-derive it. */
  unread: boolean;
  dismissed: boolean;
  completed: boolean;
  firedAt?: number;
  snoozedUntil?: number;
  snoozeCount: number;
  /** Held back by quiet hours until this instant. */
  quietUntil?: number;
  /** Arrived later than its own moment, because the phone was away. */
  late: boolean;
  /** Its moment passed outside the catch-up window: recorded, never alerted. */
  missed: boolean;
  /** The item was moved after this reminder had already fired. */
  moved: boolean;
  /** The item behind it is gone; this row is drawn from the stored snapshot. */
  orphan: boolean;
  /** Snoozed to at or past this item's next reminder, which is worth saying. */
  snoozedPastNext: boolean;
  /** Set when the decision came from somewhere other than this device. */
  readBy?: string;
}

export interface CentreGroup {
  /** The day, 'yyyy-MM-dd'. Stable, so it works as a list key. */
  id: string;
  label: string;
  relative: 'past' | 'today' | 'future';
  items: CentreEntry[];
  unread: number;
}

export interface CentreView {
  /** Ascending by `at`: one timeline, oldest first, the future at the bottom. */
  entries: CentreEntry[];
  groups: CentreGroup[];
  unread: number;
  unreadCritical: number;
  firedCount: number;
  upcomingCount: number;
  snoozedCount: number;
  /** Index in `entries` where the "now" line belongs. */
  nowIndex: number;
  /** The next thing that will alert, or null when nothing will. */
  nextAt: number | null;
  /** Dropped for being outside the window or over the cap. */
  trimmed: number;
}

/**
 * A centre with nothing in it.
 *
 * Exists so a React context can have a default that is a real, complete view
 * rather than null: the alternative is every reader checking for null before it
 * can count anything, for a case that only happens outside the provider.
 */
export const EMPTY_CENTRE_VIEW: CentreView = {
  entries: [],
  groups: [],
  unread: 0,
  unreadCritical: 0,
  firedCount: 0,
  upcomingCount: 0,
  snoozedCount: 0,
  nowIndex: 0,
  nextAt: null,
  trimmed: 0,
};

export interface CentreInput {
  schedule: readonly ScheduledNotification[];
  state: NotifyCentreState;
  now: number;
  settings?: NotificationSettings;
  pastWindowMs?: number;
  futureWindowMs?: number;
  maxEntries?: number;
}

/**
 * Join the schedule with the marks and produce the whole screen.
 *
 * The union of the two key sets is deliberate. Schedule-only keys are the
 * future and anything that passed unnoticed; mark-only keys are history whose
 * item has since been edited out of the window or deleted outright. Dropping
 * either half would lose a case the user would notice: the first is every
 * reminder that fired in a pocket, the second is every reminder for something
 * since cancelled.
 */
export function buildCentre(input: CentreInput): CentreView {
  const settings = input.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
  const now = input.now;
  const pastWindow = Math.max(0, input.pastWindowMs ?? DEFAULT_PAST_WINDOW_MS);
  const futureWindow = Math.max(0, input.futureWindowMs ?? DEFAULT_FUTURE_WINDOW_MS);
  const maxEntries = Math.max(1, input.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const catchUpMs = Math.max(0, settings.catchUpHours) * HOUR_MS;

  // One entry per key. A schedule that repeats a key is a bug upstream, and the
  // earliest wins rather than the list showing the same reminder twice.
  const scheduled = new Map<string, ScheduledNotification>();
  for (const item of input.schedule || []) {
    if (!item || typeof item.key !== 'string' || !item.key) continue;
    if (!Number.isFinite(item.fireAt)) continue;
    const existing = scheduled.get(item.key);
    if (!existing || item.fireAt < existing.fireAt) scheduled.set(item.key, item);
  }

  const keys = new Set<string>([...scheduled.keys(), ...Object.keys(input.state?.marks ?? {})]);
  const all: CentreEntry[] = [];

  for (const key of keys) {
    const mark = input.state?.marks?.[key];
    // Cleared is the one state that removes a row. It survives as a tombstone
    // precisely because the schedule would otherwise rebuild it next second.
    if (mark?.cleared) continue;

    const sched = scheduled.get(key);
    const base = sched ?? mark?.snapshot;
    // A mark with no schedule entry and no snapshot describes something this
    // build can no longer name. Better silence than a row reading "Reminder".
    if (!base) continue;

    const scheduledAt = sched ? sched.fireAt : base.fireAt;
    const snoozedUntil = mark?.snoozedUntil;
    const dismissed = mark?.dismissedAt != null;
    const completed = mark?.completed === true;

    // WHERE THE ROW SITS. A snooze is an explicit instruction and outranks
    // everything. Otherwise a delivery that actually happened pins the row to
    // when it happened, which is what keeps a moved event from jumping back
    // into the future after it has already woken someone up. Only a reminder
    // that has never been delivered follows the schedule, and only that one can
    // be held by quiet hours.
    let at: number;
    let quietUntil: number | undefined;
    if (snoozedUntil != null) {
      at = snoozedUntil;
    } else if (mark?.firedAt != null) {
      at = mark.firedAt;
    } else {
      at = scheduledAt;
      if (base.priority !== 'critical' && inQuietHours(settings, new Date(at))) {
        quietUntil = quietReleaseAt(settings, new Date(at));
        at = quietUntil;
      }
    }

    const snoozeActive = snoozedUntil != null && snoozedUntil > now;
    const status: CentreStatus = snoozeActive ? 'snoozed' : at <= now ? 'fired' : 'upcoming';
    const firedAt = mark?.firedAt ?? (status === 'fired' ? at : undefined);
    const read = mark?.read === true || dismissed || completed;

    all.push({
      key,
      kind: base.kind,
      refId: base.refId,
      occDate: base.occDate,
      title: base.title,
      body: base.body,
      priority: base.priority,
      color: base.color,
      allDay: base.allDay,
      url: base.url,
      offsetMin: base.offsetMin,
      anchorAt: base.anchorAt,
      scheduledAt,
      at,
      status,
      read,
      unread: status === 'fired' && !read,
      dismissed,
      completed,
      firedAt,
      snoozedUntil: snoozeActive ? snoozedUntil : undefined,
      snoozeCount: mark?.snoozeCount ?? 0,
      quietUntil,
      // Late means the phone delivered it, but behind its moment.
      late: mark?.firedAt != null && mark.firedAt - scheduledAt > LATE_TOLERANCE_MS,
      // Missed means nothing delivered it at all and it is now too old to
      // shout about. It still belongs in the list: that IS the point of a
      // centre on a device that spends its life asleep.
      missed: status === 'fired' && mark?.firedAt == null && now - at > catchUpMs,
      moved: !!sched && mark?.firedAt != null
        && Math.abs(sched.fireAt - mark.firedAt) > MOVED_TOLERANCE_MS,
      orphan: !sched,
      snoozedPastNext: false,
      readBy: mark?.by,
    });
  }

  // A snooze that lands at or past the SAME item's next reminder is not wrong,
  // but it is worth saying out loud, because the two will then arrive together
  // and look like a duplicate.
  const nextByRef = new Map<string, number[]>();
  for (const item of scheduled.values()) {
    const list = nextByRef.get(`${item.kind}:${item.refId}`);
    if (list) list.push(item.fireAt);
    else nextByRef.set(`${item.kind}:${item.refId}`, [item.fireAt]);
  }
  for (const entry of all) {
    if (entry.snoozedUntil == null) continue;
    const times = nextByRef.get(`${entry.kind}:${entry.refId}`) ?? [];
    let next = Infinity;
    for (const t of times) if (t > entry.scheduledAt && t < next) next = t;
    entry.snoozedPastNext = Number.isFinite(next) && entry.snoozedUntil >= next;
  }

  all.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Trim by time first, then by count. Anything unread is kept in preference to
  // anything read, because the read rows are only there for reassurance while
  // the unread ones are the actual job.
  const inWindow = all.filter(e => e.at >= now - pastWindow && e.at <= now + futureWindow);
  let entries = inWindow;
  if (inWindow.length > maxEntries) {
    const drop = new Set<string>();
    let over = inWindow.length - maxEntries;
    for (const e of inWindow) {
      if (over <= 0) break;
      if (e.unread) continue;
      drop.add(e.key);
      over -= 1;
    }
    for (const e of inWindow) {
      if (over <= 0) break;
      if (drop.has(e.key)) continue;
      drop.add(e.key);
      over -= 1;
    }
    entries = inWindow.filter(e => !drop.has(e.key));
  }

  let unread = 0;
  let unreadCritical = 0;
  let firedCount = 0;
  let upcomingCount = 0;
  let snoozedCount = 0;
  let nextAt: number | null = null;
  for (const e of entries) {
    if (e.unread) {
      unread += 1;
      if (e.priority === 'critical') unreadCritical += 1;
    }
    if (e.status === 'fired') firedCount += 1;
    if (e.status === 'upcoming') upcomingCount += 1;
    if (e.status === 'snoozed') snoozedCount += 1;
    if (e.at > now && (nextAt === null || e.at < nextAt)) nextAt = e.at;
  }

  let nowIndex = entries.length;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].at > now) { nowIndex = i; break; }
  }

  return {
    entries,
    groups: groupEntries(entries, now),
    unread,
    unreadCritical,
    firedCount,
    upcomingCount,
    snoozedCount,
    nowIndex,
    nextAt,
    trimmed: all.length - entries.length,
  };
}

/** 'yyyy-MM-dd' for an instant, in the phone's own zone. */
export const dayKey = (at: number): string => format(new Date(at), 'yyyy-MM-dd');

/** 'Today', 'Tomorrow', 'Yesterday', then 'Sat 5 Sep'. */
export function dayLabel(at: number, now: number): string {
  const today = dayKey(now);
  const key = dayKey(at);
  if (key === today) return 'Today';
  if (key === dayKey(addDays(new Date(now), 1).getTime())) return 'Tomorrow';
  if (key === dayKey(addDays(new Date(now), -1).getTime())) return 'Yesterday';
  return format(new Date(at), 'EEE d MMM');
}

export function groupEntries(entries: readonly CentreEntry[], now: number): CentreGroup[] {
  const today = dayKey(now);
  const groups: CentreGroup[] = [];
  let current: CentreGroup | null = null;

  for (const entry of entries) {
    const id = dayKey(entry.at);
    if (!current || current.id !== id) {
      current = {
        id,
        label: dayLabel(entry.at, now),
        relative: id === today ? 'today' : id < today ? 'past' : 'future',
        items: [],
        unread: 0,
      };
      groups.push(current);
    }
    current.items.push(entry);
    if (entry.unread) current.unread += 1;
  }
  return groups;
}

// ─── Filtering ───────────────────────────────────────────────────────────────

export type CentreFilter = 'all' | 'unread' | 'upcoming' | 'fired';

/**
 * Filtering rebuilds the groups rather than filtering them, so a day whose only
 * rows were filtered out disappears with its heading instead of leaving an
 * empty date floating in the list.
 */
export function filterView(view: CentreView, filter: CentreFilter, now: number): CentreView {
  if (filter === 'all') return view;
  const entries = view.entries.filter(e => {
    if (filter === 'unread') return e.unread;
    if (filter === 'upcoming') return e.status === 'upcoming' || e.status === 'snoozed';
    return e.status === 'fired';
  });
  let nowIndex = entries.length;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].at > now) { nowIndex = i; break; }
  }
  return { ...view, entries, groups: groupEntries(entries, now), nowIndex };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface ActionOptions {
  now: number;
  /** This device's id, so the other one can say where a decision came from. */
  by?: string;
  /**
   * The schedule rows being acted on, so the decision carries a snapshot.
   * Without it, dealing with something and then deleting it would erase the
   * evidence that it ever fired.
   */
  items?: readonly ScheduledNotification[];
}

function emptyMark(key: string): NotifyMark {
  return { key, at: 0 };
}

function updateMarks(
  state: NotifyCentreState,
  keys: readonly string[],
  opts: ActionOptions,
  fn: (mark: NotifyMark) => NotifyMark | null,
): NotifyCentreState {
  if (!keys.length) return state;
  const snapshots = new Map<string, ScheduledNotification>();
  for (const item of opts.items ?? []) if (item?.key) snapshots.set(item.key, snapshotOf(item));

  const marks = { ...(state.marks ?? {}) };
  let changed = false;

  for (const key of keys) {
    if (!key) continue;
    const before = marks[key] ?? emptyMark(key);
    const next = fn({ ...before });
    if (!next) continue;
    const snap = next.snapshot ?? snapshots.get(key) ?? before.snapshot;
    marks[key] = { ...next, key, at: opts.now, by: opts.by, snapshot: snap };
    changed = true;
  }

  if (!changed) return state;
  return { marks, updatedAt: opts.now };
}

/** Seen. Closes it here and, once it reaches the server, everywhere. */
export function markRead(state: NotifyCentreState, keys: readonly string[], opts: ActionOptions): NotifyCentreState {
  return updateMarks(state, keys, opts, m => ({
    ...m, read: true, readAt: opts.now, snoozedUntil: undefined, snoozedAt: undefined,
  }));
}

/**
 * Back to unread. Deliberately clears the dismissal too: putting something back
 * on the pile and leaving it flagged as handled would mean the alarm never
 * comes back, which is not what "unread" looks like it does.
 */
export function markUnread(state: NotifyCentreState, keys: readonly string[], opts: ActionOptions): NotifyCentreState {
  return updateMarks(state, keys, opts, m => ({
    ...m, read: false, readAt: undefined, dismissedAt: undefined,
  }));
}

/** Swiped away. Read, and handled, so nothing re-fires it from anywhere. */
export function dismiss(state: NotifyCentreState, keys: readonly string[], opts: ActionOptions): NotifyCentreState {
  return updateMarks(state, keys, opts, m => ({
    ...m,
    read: true,
    readAt: m.readAt ?? opts.now,
    dismissedAt: opts.now,
    snoozedUntil: undefined,
    snoozedAt: undefined,
  }));
}

/** Ticked off from the notification itself. The item's own store is separate. */
export function markCompleted(state: NotifyCentreState, keys: readonly string[], opts: ActionOptions): NotifyCentreState {
  return updateMarks(state, keys, opts, m => ({
    ...m,
    completed: true,
    read: true,
    readAt: m.readAt ?? opts.now,
    dismissedAt: m.dismissedAt ?? opts.now,
    snoozedUntil: undefined,
    snoozedAt: undefined,
  }));
}

/**
 * Tell me again in `minutes`.
 *
 * A snooze REVIVES something already dismissed, on purpose. Asking to be
 * reminded again is only ever meaningful as an instruction about the future,
 * and refusing it because of a swipe thirty seconds earlier would be the app
 * arguing with the user about what they meant.
 */
export function snooze(
  state: NotifyCentreState,
  keys: readonly string[],
  minutes: number,
  opts: ActionOptions,
): NotifyCentreState {
  const mins = Math.max(1, Math.min(720, Math.round(minutes)));
  return updateMarks(state, keys, opts, m => ({
    ...m,
    read: false,
    readAt: undefined,
    dismissedAt: undefined,
    cleared: false,
    snoozedUntil: opts.now + mins * MINUTE_MS,
    snoozedAt: opts.now,
    snoozeCount: (m.snoozeCount ?? 0) + 1,
  }));
}

/** Cancel a snooze without dealing with the thing. */
export function unsnooze(state: NotifyCentreState, keys: readonly string[], opts: ActionOptions): NotifyCentreState {
  return updateMarks(state, keys, opts, m =>
    m.snoozedUntil == null ? null : { ...m, snoozedUntil: undefined, snoozedAt: undefined });
}

/**
 * The phone actually delivered these.
 *
 * Recorded separately from reading them, because the two answer different
 * questions: `firedAt` is a fact about the device, `read` is a decision by the
 * person. Only the fact is worth reporting to the server as locally-fired.
 */
export function recordFired(
  state: NotifyCentreState,
  items: readonly ScheduledNotification[],
  opts: ActionOptions,
): NotifyCentreState {
  const keys = items.map(i => i?.key).filter((k): k is string => !!k);
  const withItems: ActionOptions = { ...opts, items: [...(opts.items ?? []), ...items] };
  return updateMarks(state, keys, withItems, m => (
    // The FIRST delivery is the truth. A second alarm for the same key, from a
    // duplicate registration or an OS replay, must not move the row.
    m.firedAt != null ? null : { ...m, firedAt: opts.now }
  ));
}

/** Remove rows from the list. A tombstone, so the schedule cannot rebuild them. */
export function clearEntries(state: NotifyCentreState, keys: readonly string[], opts: ActionOptions): NotifyCentreState {
  return updateMarks(state, keys, opts, m => ({
    ...m,
    cleared: true,
    read: true,
    readAt: m.readAt ?? opts.now,
    dismissedAt: m.dismissedAt ?? opts.now,
    snoozedUntil: undefined,
    // The snapshot stays. A cleared row is never drawn, but clearing is not
    // final: snoozing it afterwards revives it, and reviving a row whose
    // description had been thrown away would leave a nameless reminder.
  }));
}

/**
 * Mark everything that has actually fired as read.
 *
 * Upcoming rows are untouched, which is the whole reason this takes the view
 * rather than the state: "mark all read" must not silently handle tomorrow's
 * reminders and stop them arriving.
 */
export function markAllRead(state: NotifyCentreState, view: CentreView, opts: ActionOptions): NotifyCentreState {
  const targets = view.entries.filter(e => e.unread);
  return markRead(state, targets.map(e => e.key), { ...opts, items: opts.items });
}

// ─── What the alarms and the server need ─────────────────────────────────────

/**
 * Keys that must never be armed again, and that the PC must be told about.
 *
 * Read counts as handled. A reminder you have already looked at, on a device
 * you were holding, must not come back through a Windows toast an hour later
 * just because a different machine has not heard about it yet. A live snooze
 * un-handles the key, because that is exactly what a snooze asks for.
 */
export function handledKeys(state: NotifyCentreState, now: number): Set<string> {
  const out = new Set<string>();
  for (const mark of Object.values(state?.marks ?? {})) {
    if (!mark) continue;
    if (mark.snoozedUntil != null && mark.snoozedUntil > now) continue;
    if (mark.read === true || mark.dismissedAt != null || mark.completed === true || mark.cleared === true) {
      out.add(mark.key);
    }
  }
  return out;
}

export interface DesiredAlarmOptions {
  now: number;
  settings?: NotificationSettings;
  /** Quiet hours hold normal reminders back. Critical ones ignore them. */
  applyQuietHours?: boolean;
}

/**
 * The schedule as the OS should actually hold it.
 *
 * This does NOT decide which alarms to add or cancel: `planAlarms` still owns
 * that, untouched. All this does is move two kinds of reminder to the time the
 * user asked for. A snoozed reminder that has fallen out of the schedule window
 * is re-added from its snapshot, because otherwise "remind me in 30 minutes"
 * would quietly do nothing for an item that has since been deleted or moved.
 */
export function desiredAlarms(
  schedule: readonly ScheduledNotification[],
  state: NotifyCentreState,
  opts: DesiredAlarmOptions,
): ScheduledNotification[] {
  const settings = opts.settings ?? DEFAULT_NOTIFICATION_SETTINGS;
  const quiet = opts.applyQuietHours !== false;
  const marks = state?.marks ?? {};
  const out: ScheduledNotification[] = [];
  const seen = new Set<string>();

  const place = (item: ScheduledNotification): ScheduledNotification => {
    const mark = marks[item.key];
    if (mark?.snoozedUntil != null && mark.snoozedUntil > opts.now) {
      // A snooze is an explicit instruction and is never delayed further.
      return { ...item, fireAt: mark.snoozedUntil };
    }
    if (quiet && item.priority !== 'critical' && inQuietHours(settings, new Date(item.fireAt))) {
      return { ...item, fireAt: quietReleaseAt(settings, new Date(item.fireAt)) };
    }
    return item;
  };

  for (const item of schedule || []) {
    if (!item?.key || !Number.isFinite(item.fireAt)) continue;
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(place(item));
  }

  for (const mark of Object.values(marks)) {
    if (!mark || seen.has(mark.key)) continue;
    if (mark.cleared) continue;
    if (mark.snoozedUntil == null || mark.snoozedUntil <= opts.now) continue;
    if (!mark.snapshot) continue;
    seen.add(mark.key);
    out.push({ ...mark.snapshot, fireAt: mark.snoozedUntil });
  }

  out.sort((a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** One decision, in the shape the PC's own endpoints already understand. */
export interface CentreSyncPayload {
  /** POST to /api/notifications/local-fired so a record exists to act on. */
  fired: string[];
  /** POST to /api/notifications/action, one call per action. */
  read: string[];
  unread: string[];
  completed: string[];
  cleared: string[];
  /** Snoozes carry a duration, so they cannot be batched into one call. */
  snoozed: Array<{ key: string; minutes: number }>;
  /** Everything above, for handing straight back to `markSynced`. */
  keys: string[];
}

/**
 * What still has to reach the PC.
 *
 * Derived from the marks rather than kept as a queue, which is what makes an
 * offline week harmless: nothing accumulates, nothing can be lost, and the
 * answer after reconnecting is simply the current state of every mark the
 * server has not acknowledged. The order below matters: `fired` must go first,
 * because the server refuses an action on a key it has no record of.
 */
export function pendingSync(state: NotifyCentreState, now: number): CentreSyncPayload {
  const payload: CentreSyncPayload = {
    fired: [], read: [], unread: [], completed: [], cleared: [], snoozed: [], keys: [],
  };

  for (const mark of Object.values(state?.marks ?? {})) {
    if (!mark) continue;
    if (mark.at <= (mark.syncedAt ?? 0)) continue;
    payload.keys.push(mark.key);

    if (mark.firedAt != null) payload.fired.push(mark.key);

    if (mark.snoozedUntil != null && mark.snoozedUntil > now) {
      payload.snoozed.push({
        key: mark.key,
        // Sent as a duration because that is what the endpoint takes, and it is
        // re-based on `now` so a payload written before an offline stretch does
        // not arrive asking for a snooze that already expired.
        minutes: Math.max(1, Math.round((mark.snoozedUntil - now) / MINUTE_MS)),
      });
      continue;
    }
    if (mark.cleared) { payload.cleared.push(mark.key); continue; }
    if (mark.completed) { payload.completed.push(mark.key); continue; }
    if (mark.read) { payload.read.push(mark.key); continue; }
    // Only an EXPLICIT mark-unread is worth sending. A mark that merely records
    // a delivery has no decision in it, and sending "unread" for it would undo
    // a read the PC had already recorded.
    if (mark.read === false) payload.unread.push(mark.key);
  }

  payload.keys.sort();
  return payload;
}

/**
 * The server took it.
 *
 * Only stamps marks whose decision has not moved since: acknowledging a mark
 * the user changed while the request was in flight would strand that change on
 * the phone for good.
 */
export function markSynced(
  state: NotifyCentreState,
  keys: readonly string[],
  opts: { now: number; sentAt: number },
): NotifyCentreState {
  if (!keys.length) return state;
  const marks = { ...(state.marks ?? {}) };
  let changed = false;
  for (const key of keys) {
    const mark = marks[key];
    if (!mark || mark.at > opts.sentAt) continue;
    if ((mark.syncedAt ?? 0) >= mark.at) continue;
    marks[key] = { ...mark, syncedAt: opts.now };
    changed = true;
  }
  return changed ? { marks, updatedAt: state.updatedAt } : state;
}

// ─── Merging ─────────────────────────────────────────────────────────────────

/** Later decision wins; the device id breaks a same-millisecond tie. */
function decisionWins(a: NotifyMark, b: NotifyMark): boolean {
  if (a.at !== b.at) return a.at > b.at;
  const av = a.by ?? '';
  const bv = b.by ?? '';
  if (av !== bv) return av > bv;
  return true;
}

/**
 * Merge one key's mark from two devices.
 *
 * Facts union: the EARLIEST delivery is the real one, and "completed" once true
 * stays true, because both are statements about something that happened rather
 * than opinions. Everything else is one decision and moves as a unit, so a
 * device cannot end up read-but-not-dismissed by picking the winner per field.
 */
export function mergeMark(a: NotifyMark, b: NotifyMark): NotifyMark {
  const winner = decisionWins(a, b) ? a : b;
  const loser = winner === a ? b : a;

  const firedAt = a.firedAt == null ? b.firedAt
    : b.firedAt == null ? a.firedAt
    : Math.min(a.firedAt, b.firedAt);

  return {
    ...winner,
    firedAt,
    completed: a.completed === true || b.completed === true ? true : undefined,
    snapshot: winner.snapshot ?? loser.snapshot,
    snoozeCount: Math.max(a.snoozeCount ?? 0, b.snoozeCount ?? 0) || undefined,
    // Synced is per device and never travels; the lower value is the safe one,
    // because re-sending a decision the server already has is idempotent while
    // skipping one is not.
    syncedAt: Math.min(a.syncedAt ?? 0, b.syncedAt ?? 0) || undefined,
  };
}

export function mergeCentreState(a: NotifyCentreState, b: NotifyCentreState): NotifyCentreState {
  const marks: Record<string, NotifyMark> = {};
  const keys = new Set([...Object.keys(a?.marks ?? {}), ...Object.keys(b?.marks ?? {})]);
  for (const key of keys) {
    const left = a?.marks?.[key];
    const right = b?.marks?.[key];
    if (left && right) marks[key] = mergeMark(left, right);
    else marks[key] = { ...(left ?? right)! };
  }
  return { marks, updatedAt: Math.max(a?.updatedAt ?? 0, b?.updatedAt ?? 0) };
}

/**
 * Adopt the PC's own store.
 *
 * Read state is server-owned and shared, so what comes back from
 * `/api/notifications` is folded in as if it were another device's marks and
 * merged by the same rule. It cannot simply overwrite: the phone may have
 * dismissed three things a second ago that the server has not heard about yet,
 * and a straight overwrite would resurrect all three.
 */
export function centreStateFromServer(store: NotificationStore | null | undefined): NotifyCentreState {
  const marks: Record<string, NotifyMark> = {};
  for (const rec of Object.values(store?.items ?? {}) as NotificationRecord[]) {
    if (!rec || typeof rec.key !== 'string' || !rec.key) continue;
    const at = rec.readAt ?? rec.acknowledgedAt ?? rec.snoozedUntil ?? rec.firedAt ?? 0;
    const mark: NotifyMark = {
      key: rec.key,
      at,
      by: rec.readBy ?? 'pc',
      firedAt: typeof rec.firedAt === 'number' ? rec.firedAt : undefined,
      readAt: rec.readAt,
      snoozedUntil: rec.snoozedUntil,
      // The server has it, by definition.
      syncedAt: at,
      snapshot: snapshotOf(rec),
    };
    if (rec.read === true) mark.read = true;
    if (rec.completed === true) { mark.completed = true; mark.dismissedAt = rec.readAt ?? at; }
    marks[rec.key] = mark;
  }
  return { marks, updatedAt: store?.updatedAt ?? 0 };
}

/**
 * Drop what nobody will ever look at again.
 *
 * Tombstones cannot be kept forever, but they also cannot be dropped while the
 * schedule can still rebuild the row they suppress. So a cleared or handled
 * mark survives until its own moment is older than the centre's past window,
 * at which point the row would have scrolled out of existence anyway.
 */
export function pruneCentreState(
  state: NotifyCentreState,
  opts: { now: number; keepMs?: number; limit?: number },
): NotifyCentreState {
  const keep = opts.keepMs ?? DEFAULT_PAST_WINDOW_MS + DAY_MS;
  const limit = opts.limit ?? DEFAULT_MAX_ENTRIES * 2;
  const cutoff = opts.now - keep;

  const survivors = Object.values(state?.marks ?? {}).filter(mark => {
    if (!mark) return false;
    if (mark.snoozedUntil != null && mark.snoozedUntil > opts.now) return true;
    const moment = mark.firedAt ?? mark.snapshot?.fireAt ?? mark.at;
    return moment >= cutoff;
  });

  // Newest first, so the cap keeps what is still on screen.
  survivors.sort((a, b) => {
    const am = a.firedAt ?? a.snapshot?.fireAt ?? a.at;
    const bm = b.firedAt ?? b.snapshot?.fireAt ?? b.at;
    return bm - am;
  });

  const marks: Record<string, NotifyMark> = {};
  for (const mark of survivors.slice(0, limit)) marks[mark.key] = mark;
  return { marks, updatedAt: state.updatedAt };
}

// ─── Wording ─────────────────────────────────────────────────────────────────

/** "in 3 min", "in 2 hours", "just now", "5 min ago", "3 days ago". */
export function relativeLabel(at: number, now: number): string {
  const diff = at - now;
  const ahead = diff > 0;
  const secs = Math.abs(Math.round(diff / 1000));
  if (secs < 45) return 'just now';

  const mins = Math.round(secs / 60);
  const say = (value: number, unit: string) => {
    const word = `${value} ${unit}${value === 1 ? '' : 's'}`;
    return ahead ? `in ${word}` : `${word} ago`;
  };
  if (mins < 60) return say(mins, 'min');
  const hours = Math.round(mins / 60);
  if (hours < 24) return say(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 14) return say(days, 'day');
  return say(Math.round(days / 7), 'week');
}

/** "5 min", "1 hour", "2 hours". Used on the snooze buttons. */
export function snoozeLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/**
 * The one line under the title that says what state this row is in.
 *
 * Ordered by what a person needs to know first: a snooze they set, then
 * anything that went wrong with delivery, then the plain time.
 */
export function statusLine(entry: CentreEntry, now: number): string {
  if (entry.status === 'snoozed' && entry.snoozedUntil != null) {
    const again = relativeLabel(entry.snoozedUntil, now);
    return entry.snoozedPastNext
      ? `Snoozed ${again}, past the next one`
      : `Snoozed, back ${again}`;
  }
  if (entry.status === 'upcoming') {
    return entry.quietUntil != null
      ? `Held for quiet hours, ${relativeLabel(entry.at, now)}`
      : relativeLabel(entry.at, now);
  }
  if (entry.missed) return `Missed while you were away, ${relativeLabel(entry.at, now)}`;
  if (entry.late) return `Arrived late, ${relativeLabel(entry.at, now)}`;
  if (entry.moved) return `Fired ${relativeLabel(entry.at, now)}, moved since`;
  return relativeLabel(entry.at, now);
}

/** A short word for the kind, for the badge on the left of a row. */
export const KIND_LABEL: Record<NotificationKind, string> = {
  event: 'Event',
  task: 'Task',
  'task-digest': 'Tasks',
  prayer: 'Prayer',
};

/**
 * What the screen says when the list is empty.
 *
 * Never a shrug. An empty centre on a planner means something specific and
 * reassuring, and which of the three it means depends entirely on whether
 * anything is armed, which is why this takes the view rather than a boolean.
 */
export function emptyMessage(view: CentreView, filter: CentreFilter): { title: string; hint: string } {
  if (filter === 'unread') {
    return {
      title: 'Nothing waiting on you',
      hint: view.upcomingCount > 0
        ? `You have read everything that has come in. ${view.upcomingCount === 1 ? '1 reminder is' : `${view.upcomingCount} reminders are`} still to come.`
        : 'You have read everything that has come in.',
    };
  }
  if (filter === 'upcoming') {
    return {
      title: 'Nothing coming up',
      hint: 'Reminders you set on an event or a task appear here before they fire, so you can see what the day is about to ask of you.',
    };
  }
  if (view.upcomingCount > 0) {
    return {
      title: 'All quiet for now',
      hint: `${view.upcomingCount === 1 ? '1 reminder is' : `${view.upcomingCount} reminders are`} armed on this phone and will arrive on time, with or without a connection.`,
    };
  }
  return {
    title: 'All quiet',
    hint: 'Nothing has fired and nothing is due. Add a reminder to an event or a task and it will show up here before it arrives.',
  };
}
