import { addDays, addMinutes, format } from 'date-fns';
import { occurrenceStarts, parseDate, type RecurFields, type WeekStartsOn } from './recurrence';
import type { EventCategory } from './categories';
import {
  PRAYER_KEYS,
  PRAYER_LABELS,
  buildPrayerDay,
  isPrayerDone,
  prayerDateKey,
  type PrayerDoneMap,
  type PrayerKey,
  type PrayerMonth,
  type PrayerSettings,
} from './prayerTimes';

// ─── Notification model ──────────────────────────────────────────────────────
//
// One rule set ("spec") describes how a thing alerts. The same shape is reused
// at three levels, and the FIRST one that exists wins:
//
//     item.notify  →  category.notifyTimed / notifyAllDay  →  global default
//
// An absent spec means "inherit", which is what makes every event that already
// exists in the database notify by default without touching a single record.
// Turning notifications off for one item is an explicit `{ enabled: false }`,
// never a missing field, so "off" can never be mistaken for "not set yet".
//
// Offsets are SIGNED MINUTES relative to the item's anchor instant:
//     -30  → thirty minutes before        0 → exactly at the anchor
//     +5   → five minutes after
//
// The anchor differs by kind, and this is the whole of it:
//     timed event / timed task  → its start time on that day
//     all-day event             → `allDayHour` on the day it starts (08:00)
//     dated task with no time   → `taskCutoffHour` that day (21:00), and only
//                                 if it is still not done
//     prayer                    → the prayer's own time
//
// So an all-day birthday with a -1440 offset alerts at 08:00 the day before,
// and -720 alerts at 20:00 the night before. That falls out of the anchor rule
// rather than being special-cased anywhere.

export type NotifyPriority = 'normal' | 'critical';

export interface NotifyRule {
  /** Stable within its spec, so a fired notification survives editing a sibling rule. */
  id: string;
  /** Signed minutes from the anchor. Negative = before. */
  offsetMin: number;
}

export interface NotifySpec {
  enabled: boolean;
  rules: NotifyRule[];
  /**
   * 'critical' notifications refuse to auto-dismiss, play the alert sound and
   * keep re-alerting until acknowledged on any device.
   */
  priority: NotifyPriority;
}

/** What a not-yet-configured item does. Present so "on" is never accidental. */
export const DEFAULT_TIMED_SPEC: NotifySpec = {
  enabled: true,
  rules: [{ id: 'r0', offsetMin: 0 }],
  priority: 'normal',
};

export const DEFAULT_ALL_DAY_SPEC: NotifySpec = {
  enabled: true,
  rules: [{ id: 'r0', offsetMin: 0 }],
  priority: 'normal',
};

export const DEFAULT_TASK_SPEC: NotifySpec = {
  enabled: true,
  rules: [{ id: 'r0', offsetMin: 0 }],
  priority: 'normal',
};

export const DEFAULT_PRAYER_SPEC: NotifySpec = {
  enabled: false,
  rules: [{ id: 'r0', offsetMin: 0 }],
  priority: 'normal',
};

/** Offsets offered in the pickers. Anything else can still be typed by hand. */
export const OFFSET_PRESETS_TIMED: number[] = [
  0, -5, -10, -15, -20, -30, -45, -60, -120, -180, -360, -720, -1440, -2880, 5, 10, 15, 30,
];

export const OFFSET_PRESETS_ALL_DAY: number[] = [
  0, -60, -120, -240, -720, -1440, -2160, -2880, -4320, -10080, 60, 120,
];

export interface NotificationSettings {
  /** Master switch. Off means nothing is ever scheduled or delivered. */
  enabled: boolean;
  /** Hour of day an all-day item is treated as starting. */
  allDayHour: number;
  /** Hour of day undone dated tasks are swept into one digest. */
  taskCutoffHour: number;

  defaultTimed: NotifySpec;
  defaultAllDay: NotifySpec;
  defaultTask: NotifySpec;
  prayer: NotifySpec;

  /** Snooze durations offered on the notification itself, in minutes. */
  snoozeOptions: number[];
  /** How often a critical, unacknowledged notification repeats. */
  escalateEveryMin: number;
  /** How many times it repeats before giving up. */
  escalateTimes: number;

  /** Deliver as a real Windows toast from the server, even with no window open. */
  windowsToast: boolean;
  /** Deliver by Web Push to every subscribed browser and phone. */
  webPush: boolean;
  /**
   * Also push to browsers on the PC that already shows Windows toasts.
   *
   * Off by default, and that default is the fix for a real annoyance: with the
   * planner installed as an app AND open in Chrome, one reminder arrived twice
   * on the same screen, because each is its own push subscription on top of the
   * native toast. The toast is the PC's notification; push is for everything
   * else. Turn this on only if the Windows toasts stop working.
   */
  desktopPush: boolean;
  /** Show the rich in-app banner in any open planner window. */
  inApp: boolean;
  /** Play a sound in open windows. Critical items always sound. */
  sound: boolean;

  /**
   * Anything that came due while the machine was off still fires when it comes
   * back, as long as it is no older than this. Older items land silently in the
   * notification centre instead of arriving as a burst of stale toasts.
   */
  catchUpHours: number;

  /**
   * Normal-priority notifications are held back during these hours and released
   * at the end of the window. Critical ones ignore it entirely.
   */
  quietHoursEnabled: boolean;
  quietFromH: number;
  quietToH: number;

  /** Keep this many delivered notifications in the centre. */
  historyLimit: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  allDayHour: 8,
  taskCutoffHour: 21,
  defaultTimed: DEFAULT_TIMED_SPEC,
  defaultAllDay: DEFAULT_ALL_DAY_SPEC,
  defaultTask: DEFAULT_TASK_SPEC,
  prayer: DEFAULT_PRAYER_SPEC,
  snoozeOptions: [5, 10, 30],
  escalateEveryMin: 3,
  escalateTimes: 10,
  windowsToast: true,
  webPush: true,
  desktopPush: false,
  inApp: true,
  sound: true,
  catchUpHours: 12,
  quietHoursEnabled: false,
  quietFromH: 23,
  quietToH: 7,
  historyLimit: 300,
};

// ─── Coercion ────────────────────────────────────────────────────────────────

const clampHour = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(23, Math.round(v))) : fallback;

/** Widest useful window: a month before to a month after. */
const OFFSET_MIN = -44640;
const OFFSET_MAX = 44640;

export function coerceNotifyRule(raw: unknown, index: number): NotifyRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const offsetRaw = r.offsetMin;
  if (typeof offsetRaw !== 'number' || !Number.isFinite(offsetRaw)) return null;
  const offsetMin = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Math.round(offsetRaw)));
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `r${index}`;
  return { id, offsetMin };
}

/**
 * `undefined` in, `undefined` out. That is load-bearing: it is the difference
 * between "this item inherits its category" and "this item was configured".
 */
export function coerceNotifySpec(raw: unknown, fallback: NotifySpec): NotifySpec;
export function coerceNotifySpec(raw: unknown, fallback?: undefined): NotifySpec | undefined;
export function coerceNotifySpec(raw: unknown, fallback?: NotifySpec): NotifySpec | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;


  const rules: NotifyRule[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.rules)) {
    r.rules.forEach((row, i) => {
      const rule = coerceNotifyRule(row, i);
      if (!rule) return;
      // Two rules at the same offset would fire twice at the same instant.
      const dupKey = String(rule.offsetMin);
      if (seen.has(dupKey)) return;
      seen.add(dupKey);
      rules.push(rule);
    });
  }

  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    // A spec with no rules but enabled would be silently dead, so it falls back
    // to alerting exactly on time, which is what "on" means to a reader.
    rules: rules.length ? rules.slice(0, 10) : [{ id: 'r0', offsetMin: 0 }],
    priority: r.priority === 'critical' ? 'critical' : 'normal',
  };
}

export function coerceNotificationSettings(raw: unknown): NotificationSettings {
  const s: NotificationSettings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    defaultTimed: { ...DEFAULT_TIMED_SPEC, rules: [...DEFAULT_TIMED_SPEC.rules] },
    defaultAllDay: { ...DEFAULT_ALL_DAY_SPEC, rules: [...DEFAULT_ALL_DAY_SPEC.rules] },
    defaultTask: { ...DEFAULT_TASK_SPEC, rules: [...DEFAULT_TASK_SPEC.rules] },
    prayer: { ...DEFAULT_PRAYER_SPEC, rules: [...DEFAULT_PRAYER_SPEC.rules] },
    snoozeOptions: [...DEFAULT_NOTIFICATION_SETTINGS.snoozeOptions],
  };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;

  if (typeof r.enabled === 'boolean') s.enabled = r.enabled;
  s.allDayHour = clampHour(r.allDayHour, s.allDayHour);
  s.taskCutoffHour = clampHour(r.taskCutoffHour, s.taskCutoffHour);
  s.defaultTimed = coerceNotifySpec(r.defaultTimed, s.defaultTimed);
  s.defaultAllDay = coerceNotifySpec(r.defaultAllDay, s.defaultAllDay);
  s.defaultTask = coerceNotifySpec(r.defaultTask, s.defaultTask);
  s.prayer = coerceNotifySpec(r.prayer, s.prayer);

  if (Array.isArray(r.snoozeOptions)) {
    const opts = r.snoozeOptions
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
      .map(v => Math.max(1, Math.min(720, Math.round(v))));
    const uniq = [...new Set(opts)].sort((a, b) => a - b).slice(0, 5);
    if (uniq.length) s.snoozeOptions = uniq;
  }
  if (typeof r.escalateEveryMin === 'number' && Number.isFinite(r.escalateEveryMin)) {
    s.escalateEveryMin = Math.max(1, Math.min(60, Math.round(r.escalateEveryMin)));
  }
  if (typeof r.escalateTimes === 'number' && Number.isFinite(r.escalateTimes)) {
    s.escalateTimes = Math.max(0, Math.min(60, Math.round(r.escalateTimes)));
  }
  if (typeof r.windowsToast === 'boolean') s.windowsToast = r.windowsToast;
  if (typeof r.webPush === 'boolean') s.webPush = r.webPush;
  if (typeof r.desktopPush === 'boolean') s.desktopPush = r.desktopPush;
  if (typeof r.inApp === 'boolean') s.inApp = r.inApp;
  if (typeof r.sound === 'boolean') s.sound = r.sound;
  if (typeof r.catchUpHours === 'number' && Number.isFinite(r.catchUpHours)) {
    s.catchUpHours = Math.max(0, Math.min(72, Math.round(r.catchUpHours)));
  }
  if (typeof r.quietHoursEnabled === 'boolean') s.quietHoursEnabled = r.quietHoursEnabled;
  s.quietFromH = clampHour(r.quietFromH, s.quietFromH);
  s.quietToH = clampHour(r.quietToH, s.quietToH);
  if (typeof r.historyLimit === 'number' && Number.isFinite(r.historyLimit)) {
    s.historyLimit = Math.max(20, Math.min(2000, Math.round(r.historyLimit)));
  }
  return s;
}

// ─── Resolving which spec applies ────────────────────────────────────────────

export interface NotifiableItem extends RecurFields {
  notify?: NotifySpec;
}

/**
 * The one place the three-level fallback lives. Everything else asks this.
 */
export function resolveSpec(
  item: { notify?: NotifySpec; categoryId?: string | null } | null | undefined,
  kind: 'timed' | 'allDay' | 'task',
  categories: EventCategory[],
  settings: NotificationSettings,
): NotifySpec {
  if (item?.notify) return item.notify;

  if (kind !== 'task' && item?.categoryId) {
    const cat = categories.find(c => c.id === item.categoryId);
    const fromCat = kind === 'allDay' ? cat?.notifyAllDay : cat?.notifyTimed;
    if (fromCat) return fromCat;
  }

  if (kind === 'task') return settings.defaultTask;
  return kind === 'allDay' ? settings.defaultAllDay : settings.defaultTimed;
}

/** Where a spec is coming from, for the "inheriting from Exams" hint in the UI. */
export type SpecOrigin = 'item' | 'category' | 'global';

export function specOrigin(
  item: { notify?: NotifySpec; categoryId?: string | null } | null | undefined,
  kind: 'timed' | 'allDay' | 'task',
  categories: EventCategory[],
): SpecOrigin {
  if (item?.notify) return 'item';
  if (kind !== 'task' && item?.categoryId) {
    const cat = categories.find(c => c.id === item.categoryId);
    if (kind === 'allDay' ? cat?.notifyAllDay : cat?.notifyTimed) return 'category';
  }
  return 'global';
}

// ─── Human wording ───────────────────────────────────────────────────────────

/** "30 minutes before", "at the time", "1 day before", "5 minutes after". */
export function offsetLabel(offsetMin: number): string {
  if (offsetMin === 0) return 'At the time';
  const after = offsetMin > 0;
  const m = Math.abs(offsetMin);
  const suffix = after ? 'after' : 'before';

  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ${suffix}`;

  if (m % 10080 === 0) return unit(m / 10080, 'week');
  if (m % 1440 === 0) return unit(m / 1440, 'day');
  if (m % 60 === 0) return unit(m / 60, 'hour');
  if (m > 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return `${h}h ${rem}m ${suffix}`;
  }
  return unit(m, 'minute');
}

/** Compact form for the chips on a card: "-30m", "-2d", "+5m", "on time". */
export function offsetChip(offsetMin: number): string {
  if (offsetMin === 0) return 'on time';
  const sign = offsetMin > 0 ? '+' : '-';
  const m = Math.abs(offsetMin);
  if (m % 10080 === 0) return `${sign}${m / 10080}w`;
  if (m % 1440 === 0) return `${sign}${m / 1440}d`;
  if (m % 60 === 0) return `${sign}${m / 60}h`;
  return `${sign}${m}m`;
}

export function summariseSpec(spec: NotifySpec): string {
  if (!spec.enabled) return 'Off';
  const sorted = [...spec.rules].sort((a, b) => a.offsetMin - b.offsetMin);
  return sorted.map(r => offsetChip(r.offsetMin)).join(', ');
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

export type NotificationKind = 'event' | 'task' | 'task-digest' | 'prayer';

export interface ScheduledNotification {
  /**
   * Deterministic and stable across restarts, which is the entire dedupe
   * mechanism. Deliberately built from the OFFSET rather than the fire time, so
   * dragging an event to a new hour does not re-fire a reminder already sent.
   */
  key: string;
  kind: NotificationKind;
  /** Master id of the event/task, the prayer key, or the date for a digest. */
  refId: string;
  occDate: string;
  fireAt: number;
  /** The instant being reminded about, for the "in 30 minutes" line. */
  anchorAt: number;
  offsetMin: number;
  title: string;
  body: string;
  priority: NotifyPriority;
  color?: string;
  allDay: boolean;
  /** Deep link back into the planner. */
  url: string;
}

export interface ScheduleInput {
  events: Record<string, NotifiableItem & { content?: string; allDay?: boolean; noDuration?: boolean }>;
  tasks: Record<string, NotifiableItem & { title?: string; completed?: boolean; completedDates?: string[]; deleted?: boolean }>;
  categories: EventCategory[];
  settings: NotificationSettings;
  weekStartsOn: WeekStartsOn;
  /** Aladhan month cache, keyed 'yyyy-MM'. Optional. */
  prayerMonths?: Record<string, PrayerMonth>;
  prayerSettings?: PrayerSettings;
  prayerDone?: PrayerDoneMap;
  from: number;
  to: number;
}

const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');

function atTime(date: Date, hhmm: string | undefined, fallbackHour: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (hhmm && /^\d{1,2}:\d{2}/.test(hhmm)) {
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
  }
  d.setHours(fallbackHour, 0, 0, 0);
  return d;
}

/** Is this occurrence already ticked off? Repeating items track per-date. */
function isDone(
  item: { completed?: boolean; completedDates?: string[] },
  occDate: string,
  repeating: boolean,
): boolean {
  if (repeating) return !!item.completedDates?.includes(occDate);
  return !!item.completed || !!item.completedDates?.includes(occDate);
}

/**
 * Every notification instant in [from, to). Pure: same inputs, same output,
 * no clock reads. The engine calls it on a timer; the tests call it directly.
 */
export function computeSchedule(input: ScheduleInput): ScheduledNotification[] {
  const { settings, categories, from, to } = input;
  const out: ScheduledNotification[] = [];
  if (!settings.enabled) return out;

  // Occurrences are expanded over a padded window, because a rule can point far
  // outside it: a -1 week reminder for an event a week from now fires today.
  // The padding is derived from the offsets actually in use rather than from the
  // widest offset the model allows, so a database with only same-day reminders
  // expands one day either side instead of a month.
  const specs: NotifySpec[] = [settings.defaultTimed, settings.defaultAllDay, settings.defaultTask, settings.prayer];
  for (const c of categories) {
    if (c.notifyTimed) specs.push(c.notifyTimed);
    if (c.notifyAllDay) specs.push(c.notifyAllDay);
  }
  for (const ev of Object.values(input.events || {})) if (ev?.notify) specs.push(ev.notify);
  for (const t of Object.values(input.tasks || {})) if (t?.notify) specs.push(t.notify);

  let leadMin = 1440;  // how far AHEAD of `to` an occurrence can still matter
  let lagMin = 1440;   // how far BEHIND `from` one can still matter
  for (const s of specs) {
    if (!s?.enabled) continue;
    for (const r of s.rules) {
      if (r.offsetMin < 0) leadMin = Math.max(leadMin, -r.offsetMin);
      else lagMin = Math.max(lagMin, r.offsetMin);
    }
  }
  const leadMs = leadMin * 60_000;
  const lagMs = lagMin * 60_000;
  const scanFrom = new Date(from - lagMs);
  const scanTo = new Date(to + leadMs);

  const push = (n: ScheduledNotification) => {
    if (n.fireAt >= from && n.fireAt < to) out.push(n);
  };

  // ── Events ────────────────────────────────────────────────────────────────
  for (const [id, ev] of Object.entries(input.events || {})) {
    if (!ev || ev.deleted) continue;
    if (!ev.weekKey) continue;

    const allDay = !!ev.allDay;
    const spec = resolveSpec(ev, allDay ? 'allDay' : 'timed', categories, settings);
    if (!spec.enabled) continue;

    const cat = ev.categoryId ? categories.find(c => c.id === ev.categoryId) : undefined;
    const starts = occurrenceStarts(ev, scanFrom, scanTo, input.weekStartsOn);

    for (const day of starts) {
      const occDate = ymd(day);
      const repeating = !!ev.recur;
      if (isDone(ev as any, occDate, repeating)) continue;

      const anchor = allDay
        ? atTime(day, undefined, settings.allDayHour)
        : atTime(day, ev.startTime, settings.allDayHour);

      for (const rule of spec.rules) {
        const fireAt = anchor.getTime() + rule.offsetMin * 60_000;
        push({
          key: `event:${id}:${occDate}:${rule.offsetMin}`,
          kind: 'event',
          refId: id,
          occDate,
          fireAt,
          anchorAt: anchor.getTime(),
          offsetMin: rule.offsetMin,
          title: (ev.content || 'Untitled').trim() || 'Untitled',
          body: describeWhen(anchor, rule.offsetMin, allDay, ev.startTime, ev.endTime),
          priority: spec.priority,
          color: cat?.color,
          allDay,
          url: `/?focus=${encodeURIComponent(id)}&date=${occDate}`,
        });
      }
    }
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  // Timed tasks alert like a timed event. Dated tasks with no time never get
  // their own notification: they roll into the one end-of-day digest below,
  // which is the whole reason the two loops are separate.
  const digestByDate = new Map<string, string[]>();

  for (const [id, t] of Object.entries(input.tasks || {})) {
    if (!t || t.deleted) continue;
    if (!t.weekKey) continue; // general tasks are panel-only and never alert

    const repeating = !!t.recur;
    const starts = occurrenceStarts(t, scanFrom, scanTo, input.weekStartsOn);

    for (const day of starts) {
      const occDate = ymd(day);
      if (isDone(t as any, occDate, repeating)) continue;

      if (!t.startTime) {
        const cutoff = atTime(day, undefined, settings.taskCutoffHour).getTime();
        if (cutoff >= from && cutoff < to) {
          const list = digestByDate.get(occDate) || [];
          list.push((t.title || 'Untitled task').trim() || 'Untitled task');
          digestByDate.set(occDate, list);
        }
        continue;
      }

      const spec = resolveSpec(t, 'task', categories, settings);
      if (!spec.enabled) continue;
      const anchor = atTime(day, t.startTime, settings.taskCutoffHour);

      for (const rule of spec.rules) {
        push({
          key: `task:${id}:${occDate}:${rule.offsetMin}`,
          kind: 'task',
          refId: id,
          occDate,
          fireAt: anchor.getTime() + rule.offsetMin * 60_000,
          anchorAt: anchor.getTime(),
          offsetMin: rule.offsetMin,
          title: (t.title || 'Untitled task').trim() || 'Untitled task',
          body: describeWhen(anchor, rule.offsetMin, false, t.startTime, t.endTime),
          priority: spec.priority,
          allDay: false,
          url: `/?task=${encodeURIComponent(id)}&date=${occDate}`,
        });
      }
    }
  }

  if (settings.defaultTask.enabled) {
    for (const [date, titles] of digestByDate) {
      const at = atTime(parseDate(date), undefined, settings.taskCutoffHour).getTime();
      const shown = titles.slice(0, 6);
      const extra = titles.length - shown.length;
      push({
        key: `task-digest:${date}`,
        kind: 'task-digest',
        refId: date,
        occDate: date,
        fireAt: at,
        anchorAt: at,
        offsetMin: 0,
        title: titles.length === 1 ? '1 task still open today' : `${titles.length} tasks still open today`,
        body: shown.join(', ') + (extra > 0 ? `, and ${extra} more` : ''),
        priority: settings.defaultTask.priority,
        allDay: true,
        url: `/?tasks=1&date=${date}`,
      });
    }
  }

  // ── Prayers ───────────────────────────────────────────────────────────────
  const pSpec = settings.prayer;
  const pSet = input.prayerSettings;
  if (pSpec.enabled && pSet?.enabled && input.prayerMonths) {
    const done = input.prayerDone || {};
    let cursor = new Date(from - lagMs);
    cursor.setHours(0, 0, 0, 0);
    const last = new Date(to + leadMs);

    // The guard below is a backstop, not the real bound: the window is already
    // narrowed to the widest offset actually configured.
    let guard = 0;
    while (cursor <= last && guard++ < 400) {
      const dateStr = prayerDateKey(cursor);
      const month = input.prayerMonths[dateStr.slice(0, 7)];
      const day = month?.[dateStr];
      if (day) {
        const occs = buildPrayerDay(dateStr, day, pSet);
        for (const occ of occs) {
          if (!PRAYER_KEYS.includes(occ.key as PrayerKey)) continue;
          if (isPrayerDone(done, dateStr, occ.key)) continue;
          const anchor = atTime(parseDate(dateStr), occ.time, 0);
          for (const rule of pSpec.rules) {
            push({
              key: `prayer:${occ.key}:${dateStr}:${rule.offsetMin}`,
              kind: 'prayer',
              refId: occ.key,
              occDate: dateStr,
              fireAt: anchor.getTime() + rule.offsetMin * 60_000,
              anchorAt: anchor.getTime(),
              offsetMin: rule.offsetMin,
              title: PRAYER_LABELS[occ.key] || occ.key,
              body: describeWhen(anchor, rule.offsetMin, false, occ.time, undefined),
              priority: pSpec.priority,
              color: pSet.color,
              allDay: false,
              url: `/?date=${dateStr}`,
            });
          }
        }
      }
      cursor = addDays(cursor, 1);
    }
  }

  out.sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));
  return out;
}

/** "Starts at 14:30", "In 30 minutes, at 14:30", "Started 5 minutes ago". */
export function describeWhen(
  anchor: Date,
  offsetMin: number,
  allDay: boolean,
  startTime?: string,
  endTime?: string,
): string {
  const clock = allDay ? 'All day' : (startTime ? (endTime ? `${startTime} to ${endTime}` : startTime) : '');
  if (offsetMin === 0) return allDay ? 'Today, all day' : `Starting now, ${clock}`;
  if (offsetMin > 0) return `Started ${offsetLabel(offsetMin).replace(' after', ' ago')}${clock ? `, ${clock}` : ''}`;
  const lead = offsetLabel(offsetMin).replace(' before', '');
  return allDay
    ? `In ${lead}, on ${format(anchor, 'EEE d MMM')}`
    : `In ${lead}, at ${clock || format(anchor, 'HH:mm')}`;
}

// ─── Delivered notification records ──────────────────────────────────────────

export interface NotificationRecord extends ScheduledNotification {
  /** When it was actually dispatched. */
  firedAt: number;
  /** Last time an alert was pushed out for it, including escalations. */
  lastAlertAt: number;
  /** How many escalation repeats have gone out. */
  alerts: number;
  read?: boolean;
  readAt?: number;
  /** Which device marked it read, purely so the centre can say so. */
  readBy?: string;
  acknowledgedAt?: number;
  snoozedUntil?: number;
  /** Fired later than intended because the machine was asleep. */
  late?: boolean;
  /** Too old to alert about on wake, recorded silently. */
  missed?: boolean;
  /** The task or event was ticked off straight from the notification. */
  completed?: boolean;
}

export interface NotificationStore {
  items: Record<string, NotificationRecord>;
  updatedAt: number;
}

export const EMPTY_STORE: NotificationStore = { items: {}, updatedAt: 0 };

export function coerceStore(raw: unknown): NotificationStore {
  if (!raw || typeof raw !== 'object') return { items: {}, updatedAt: 0 };
  const r = raw as Record<string, unknown>;
  const items: Record<string, NotificationRecord> = {};
  if (r.items && typeof r.items === 'object') {
    for (const [k, v] of Object.entries(r.items as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as NotificationRecord;
      if (typeof rec.fireAt !== 'number') continue;
      items[k] = { ...rec, key: k };
    }
  }
  return { items, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0 };
}

/** Unread, not snoozed away, newest first. What the bell counts. */
export function activeNotifications(store: NotificationStore, now: number): NotificationRecord[] {
  return Object.values(store.items)
    .filter(n => !n.read && (!n.snoozedUntil || n.snoozedUntil <= now))
    .sort((a, b) => b.firedAt - a.firedAt);
}

export function unreadCount(store: NotificationStore, now: number): number {
  return activeNotifications(store, now).length;
}

/**
 * Is `at` inside the quiet window? Handles the window wrapping past midnight,
 * which is the normal case for 23:00 to 07:00.
 */
export function inQuietHours(settings: NotificationSettings, at: Date): boolean {
  if (!settings.quietHoursEnabled) return false;
  const { quietFromH: a, quietToH: b } = settings;
  if (a === b) return false;
  const h = at.getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/** The instant a held-back notification is released. */
export function quietReleaseAt(settings: NotificationSettings, at: Date): number {
  const d = new Date(at);
  d.setMinutes(0, 0, 0);
  if (settings.quietToH > at.getHours()) {
    d.setHours(settings.quietToH);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(settings.quietToH);
  }
  return d.getTime();
}

/** Trim to the history limit, oldest delivered records first. */
export function pruneStore(store: NotificationStore, limit: number): NotificationStore {
  const all = Object.values(store.items).sort((a, b) => b.firedAt - a.firedAt);
  if (all.length <= limit) return store;
  const keep = all.slice(0, limit);
  const items: Record<string, NotificationRecord> = {};
  for (const n of keep) items[n.key] = n;
  return { items, updatedAt: store.updatedAt };
}

/** Grouping used by the notification centre. */
export function groupNotifications(
  list: NotificationRecord[],
  now: number,
): Array<{ label: string; items: NotificationRecord[] }> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const startOfToday = today.getTime();
  const startOfYesterday = addDays(today, -1).getTime();
  const hourAgo = now - 60 * 60 * 1000;

  const buckets: Array<{ label: string; items: NotificationRecord[] }> = [
    { label: 'Just now', items: [] },
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Earlier', items: [] },
  ];

  for (const n of list) {
    if (n.firedAt >= hourAgo) buckets[0].items.push(n);
    else if (n.firedAt >= startOfToday) buckets[1].items.push(n);
    else if (n.firedAt >= startOfYesterday) buckets[2].items.push(n);
    else buckets[3].items.push(n);
  }
  return buckets.filter(b => b.items.length > 0);
}

/** Stable per-notification tag, so every device closes the same OS notification. */
export const notificationTag = (key: string): string => `planner:${key}`;

export const snoozeUntil = (now: number, minutes: number): number =>
  addMinutes(new Date(now), minutes).getTime();
