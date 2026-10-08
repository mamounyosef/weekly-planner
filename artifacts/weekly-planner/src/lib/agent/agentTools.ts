// ─── Planner agent: the tools, and nothing but the tools ─────────────────────
//
// THE SANDBOX IS THIS FILE.
// The model never touches the file system, the network, the shell or the
// settings. It can only ask for one of the functions below by name, with JSON
// arguments, and every one of them is a PURE function of (arguments, world):
// it reads the planner snapshot it is handed and returns a new snapshot plus a
// record of what it did. The server writes that snapshot through the same door
// the app uses, and only after that, reads it back. A tool name that is not in
// TOOL_DEFS is refused (the model WILL invent one: gemma4 called a non-existent
// `update_item` during design and then reported success).
//
// Deletion never happens here directly. `delete_items` only builds a preview
// and pauses the run; the deletion is performed by `applyDeletion` after the
// user presses Approve, recomputed against the data as it is at that moment.

import { addDays, differenceInCalendarDays, format, startOfWeek } from 'date-fns';

import {
  formatRecurrenceLabel,
  makeOccId,
  occurrenceStarts,
  parseDate,
  parseOccId,
  weekKeyOf,
  deleteScoped,
  type Recurrence,
  type RecurFields,
  type WeekStartsOn,
  type Weekday,
} from '../recurrence';
import { planOccurrenceEdit, type OccurrenceScope } from '../occurrence';
import { deleteTaskScoped, type Task, type TaskData } from '../tasks';
import type { EventCategory } from '../categories';
import type { NotifySpec, NotificationSettings } from '../notifications';
import type { TaskList } from '../taskLists';
import type {
  AgentApproval,
  AgentQuestion,
  ChangeEntry,
  ItemFacts,
  PendingDeletion,
} from './agentTypes';
import {
  dedupeFocusHistory, applyTypedDayTotals, isTypedDayTotal,
  focusDayKey, summariseFocus, computeAllTimeStreaks,
  type FocusSessionRecord,
} from '../focusStats';
import { focusElapsedSeconds, type FocusTimerState } from '../focusTimer';

// ─── The world a tool sees ───────────────────────────────────────────────────

/** A stored calendar event, as `database.json` holds it. */
export interface AgentEvent extends RecurFields {
  content: string;
  color?: string;
  categoryId?: string;
  notify?: NotifySpec;
  completedDates?: string[];
  noCheckbox?: boolean;
  noDuration?: boolean;
  gCalHex?: string;
  [extra: string]: unknown;
}

export type EventData = Record<string, AgentEvent>;

export interface PrayerDay {
  fajr?: string; sunrise?: string; dhuhr?: string; asr?: string; maghrib?: string; isha?: string;
}

export interface AgentWorld {
  /** "Now", in the user's local time. */
  now: Date;
  timeZone: string;
  events: EventData;
  tasks: TaskData;
  categories: EventCategory[];
  taskLists: TaskList[];
  weekStartsOn: WeekStartsOn;
  dayStartH: number;
  dayEndH: number;
  timeFormat: '12h' | '24h';
  notificationDefaults?: Pick<NotificationSettings, 'defaultTimed' | 'defaultAllDay' | 'defaultTask'>;
  /** The Google calendar this app writes to. Events from any other are read-only. */
  ownedCalendarId?: string;
  calendars: Array<{ id: string; summary: string }>;
  /** Cached prayer times for a date, or null when that month is not cached. */
  prayersFor?: (date: string) => PrayerDay | null;
  /** Injected for deterministic tests. */
  newId?: () => string;
  /** Focus session history (all completed sessions, including day adjustments). */
  focusSessions: FocusSessionRecord[];
  /** The currently running/paused focus timer, or null when there is no timer file. */
  focusTimer: FocusTimerState | null;
  /** Daily focus goal in seconds, 0 means no goal set. */
  focusDailyGoalSeconds: number;
  /** Dates excluded from streaks. */
  focusExcludedDates: string[];
  /** Focus day start hour (sessions ending before this hour count to the previous day). */
  focusDayStartHour: number;
}

/** One reversible write, kept by the server so Undo can put things back. */
export interface UndoRecord {
  store: 'events' | 'tasks';
  id: string;
  /** The record before the change, or null when the change created it. */
  before: Record<string, unknown> | null;
  /** The record after the change, or null when the change removed it. */
  after: Record<string, unknown> | null;
}

export type ToolPause =
  | { kind: 'question'; questions: AgentQuestion[] }
  | { kind: 'approval'; approval: AgentApproval; plan: DeletionPlan };

export interface ToolOutcome {
  /** What the model is told. Always JSON-serialisable. */
  result: unknown;
  /** Short line for the activity list, e.g. "Added 7 events". */
  label: string;
  events?: EventData;
  tasks?: TaskData;
  entries?: ChangeEntry[];
  undo?: UndoRecord[];
  pause?: ToolPause;
  /** True when the call was refused outright (bad arguments, unknown tool). */
  isError?: boolean;
}

export interface DeletionPlan {
  items: Array<{ id: string; kind: 'event' | 'task'; scope: OccurrenceScope }>;
  /** Focus session ids to delete (approval-gated, like items). */
  focusSessionIds?: string[];
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

class ToolError extends Error {}
const fail = (msg: string): never => { throw new ToolError(msg); };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A strict, real calendar date. "2026-02-30" is refused rather than rolled over. */
export function parseYmdStrict(raw: unknown, field: string): string {
  if (typeof raw !== 'string') fail(`${field} must be a date string YYYY-MM-DD.`);
  const s = (raw as string).trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) fail(`${field} "${raw}" is not a date in YYYY-MM-DD form.`);
  const [y, mo, d] = [Number(m![1]), Number(m![2]), Number(m![3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) fail(`${field} "${raw}" is not a real date.`);
  if (y < 1970 || y > 2200) fail(`${field} "${raw}" is out of range.`);
  return s;
}

/**
 * A time of day as "HH:mm" (24h). Tolerant of what a model or a human writes:
 * "9:05", "09:05", "9am", "9:30 PM", "21:00", "noon", "midnight". "24:00" is
 * accepted as the end of the day and stored as "23:59" is NOT done: it is
 * stored as "00:00", meaning midnight at the end, which the grid already
 * understands as an overnight end.
 */
export function parseTime(raw: unknown, field: string): string {
  if (typeof raw !== 'string') fail(`${field} must be a time like "14:30".`);
  const s = (raw as string).trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === 'noon') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(s);
  if (!m) fail(`${field} "${raw}" is not a time. Use 24-hour "HH:mm", e.g. "14:30".`);
  let h = Number(m![1]);
  const min = m![2] != null ? Number(m![2]) : 0;
  const suffix = m![3]?.replace(/\./g, '');
  if (suffix) {
    if (h < 1 || h > 12) fail(`${field} "${raw}" has an impossible hour.`);
    if (suffix === 'pm' && h < 12) h += 12;
    if (suffix === 'am' && h === 12) h = 0;
  }
  if (h === 24 && min === 0) h = 0;
  if (h > 23 || min > 59) fail(`${field} "${raw}" is not a valid time of day.`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const fromMin = (mins: number): string => {
  const t = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** Anchor fields (weekKey + 0-6 dayIndex) for a calendar date. */
export function anchorFor(date: string, weekStartsOn: WeekStartsOn): { weekKey: string; dayIndex: number } {
  const d = parseDate(date);
  const ws = startOfWeek(d, { weekStartsOn });
  return { weekKey: weekKeyOf(d, weekStartsOn), dayIndex: differenceInCalendarDays(d, ws) };
}

/** The calendar date a record is anchored on. */
export function anchorDate(r: RecurFields): string | null {
  if (!r.weekKey) return null;
  return ymd(addDays(parseDate(r.weekKey), r.dayIndex ?? 0));
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** "Fri 9 Oct" */
function dayLabel(date: string): string {
  const d = parseDate(date);
  return `${SHORT_DAY[d.getDay()]} ${d.getDate()} ${format(d, 'MMM')}`;
}

function clock(hhmm: string, fmt: '12h' | '24h'): string {
  if (fmt === '24h') return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

// ─── Read-only rules ─────────────────────────────────────────────────────────

/** Why an event cannot be changed by the agent, or null when it can. */
export function readOnlyReason(ev: AgentEvent, world: AgentWorld): string | null {
  if (!ev.gCalId || !ev.gCalCalendarId) return null;
  if (world.ownedCalendarId && ev.gCalCalendarId === world.ownedCalendarId) return null;
  const cal = world.calendars.find(c => c.id === ev.gCalCalendarId);
  if (!world.ownedCalendarId) {
    return 'It came from Google Calendar and the calendar list has not been loaded yet, so it is treated as read-only. Ask the user to change it in Google Calendar, or to run a Google sync first.';
  }
  return `It is mirrored read-only from the Google calendar "${cal?.summary ?? ev.gCalCalendarId}". Only items in the planner's own calendar can be changed. Tell the user to change it in Google Calendar.`;
}

function calendarName(ev: AgentEvent, world: AgentWorld): string | undefined {
  if (!ev.gCalCalendarId) return undefined;
  if (world.ownedCalendarId && ev.gCalCalendarId === world.ownedCalendarId) return undefined;
  return world.calendars.find(c => c.id === ev.gCalCalendarId)?.summary ?? 'Google Calendar';
}

// ─── Facts (the display snapshot the report is built from) ────────────────────

function remindersLabel(spec: NotifySpec | undefined): string | undefined {
  if (!spec) return undefined; // inherits: say nothing rather than guess
  if (!spec.enabled || !spec.rules.length) return 'Off';
  const parts = [...spec.rules].sort((a, b) => a.offsetMin - b.offsetMin).map(r => {
    if (r.offsetMin === 0) return 'at the time';
    const m = Math.abs(r.offsetMin);
    const unit = m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}`
      : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}`
      : `${m} min`;
    return `${unit} ${r.offsetMin < 0 ? 'before' : 'after'}`;
  });
  return parts.join(', ') + (spec.priority === 'critical' ? ' (critical)' : '');
}

export function eventFacts(ev: AgentEvent, world: AgentWorld, occDate?: string | null): ItemFacts {
  const date = occDate ?? anchorDate(ev) ?? undefined;
  const cat = ev.categoryId ? world.categories.find(c => c.id === ev.categoryId) : undefined;
  const facts: ItemFacts = { title: ev.content || '(untitled)', kind: 'event', date };
  if (ev.allDay) {
    facts.allDay = true;
    const span = Math.max(1, ev.daysSpan ?? 1);
    if (span > 1 && date) facts.endDate = ymd(addDays(parseDate(date), span - 1));
  } else if (ev.startTime) {
    facts.startTime = ev.startTime;
    const point = !!ev.noDuration || !ev.endTime || ev.endTime === ev.startTime;
    if (point) facts.pointInTime = true;
    else {
      facts.endTime = ev.endTime;
      if (toMin(ev.endTime!) < toMin(ev.startTime)) facts.overnight = true;
    }
  }
  if (cat) facts.category = cat.name;
  facts.color = cat?.color ?? (typeof ev.color === 'string' ? ev.color : undefined);
  if (ev.recur) facts.repeats = formatRecurrenceLabel(ev.recur, anchorDate(ev) ?? undefined);
  const rem = remindersLabel(ev.notify);
  if (rem) facts.reminders = rem;
  facts.checkbox = !ev.noCheckbox;
  if (date && ev.completedDates?.includes(date)) facts.done = true;
  return facts;
}

export function taskFacts(t: Task, world: AgentWorld, occDate?: string | null): ItemFacts {
  const date = occDate ?? anchorDate(t) ?? undefined;
  const list = world.taskLists.find(l => l.id === (t.listId || 'general'));
  const facts: ItemFacts = { title: t.title || '(untitled)', kind: 'task' };
  if (date) facts.date = date;
  if (t.startTime) {
    facts.startTime = t.startTime;
    if (t.endTime && t.endTime !== t.startTime) facts.endTime = t.endTime;
  }
  if (list) facts.list = list.name;
  if (t.recur) facts.repeats = formatRecurrenceLabel(t.recur, anchorDate(t) ?? undefined);
  const rem = remindersLabel(t.notify);
  if (rem) facts.reminders = rem;
  facts.done = t.recur ? !!(date && t.completedDates?.includes(date)) : !!t.completed;
  if (t.notes) facts.notes = t.notes;
  return facts;
}

/** Human "when" line: "Fri 9 Oct, 1:00 PM to 7:00 PM". */
export function whenLabel(f: ItemFacts, fmt: '12h' | '24h'): string {
  if (!f.date) return 'No date';
  let s = dayLabel(f.date);
  if (f.allDay) {
    s += f.endDate ? ` to ${dayLabel(f.endDate)} (all day)` : ' (all day)';
  } else if (f.startTime) {
    s += `, ${clock(f.startTime, fmt)}`;
    if (f.endTime) s += ` to ${clock(f.endTime, fmt)}${f.overnight ? ' (next day)' : ''}`;
  }
  return s;
}

// ─── Occurrence expansion for reading ────────────────────────────────────────

interface Occ {
  id: string;
  masterId: string;
  kind: 'event' | 'task';
  date: string;
  record: AgentEvent | Task;
}

function expand(
  store: Record<string, RecurFields>,
  kind: 'event' | 'task',
  from: string,
  toInclusive: string,
  weekStartsOn: WeekStartsOn,
): Occ[] {
  const start = parseDate(from);
  const end = addDays(parseDate(toInclusive), 1);
  const out: Occ[] = [];
  for (const rec of Object.values(store)) {
    if (!rec || rec.deleted || !rec.weekKey) continue;
    if (String(rec.id).includes('::')) continue;
    if (!rec.recur) {
      // Multi-day all-day items overlap the window even when they start before it.
      const a = parseDate(anchorDate(rec)!);
      const span = rec.allDay ? Math.max(1, rec.daysSpan ?? 1) : 1;
      if (a < end && addDays(a, span) > start) {
        out.push({ id: rec.id, masterId: rec.id, kind, date: ymd(a), record: rec as AgentEvent });
      }
      continue;
    }
    for (const d of occurrenceStarts(rec, start, end, weekStartsOn)) {
      const date = ymd(d);
      out.push({ id: makeOccId(rec.id, date), masterId: rec.id, kind, date, record: rec as AgentEvent });
    }
  }
  return out;
}

function compactItem(o: Occ, world: AgentWorld): Record<string, unknown> {
  const f = o.kind === 'event'
    ? eventFacts(o.record as AgentEvent, world, o.date)
    : taskFacts(o.record as Task, world, o.date);
  const item: Record<string, unknown> = { id: o.id, kind: o.kind, title: f.title, date: f.date };
  // The weekday is spelled out so the model never has to work it out.
  if (f.date) item.day = format(parseDate(f.date), 'EEEE');
  if (f.endDate) item.endDate = f.endDate;
  if (f.allDay) item.allDay = true;
  if (f.startTime) item.start = f.startTime;
  if (f.endTime) item.end = f.endTime;
  if (f.pointInTime) item.pointInTime = true;
  if (f.overnight) item.endsNextDay = true;
  if (f.category) item.category = f.category;
  if (f.list) item.list = f.list;
  if (f.repeats) item.repeats = f.repeats;
  if (f.done) item.done = true;
  if (o.kind === 'event') {
    const cal = calendarName(o.record as AgentEvent, world);
    if (cal) item.calendar = cal;
    if (readOnlyReason(o.record as AgentEvent, world)) item.readOnly = true;
  }
  return item;
}

const sortKey = (i: Record<string, unknown>) =>
  `${i.date}|${i.allDay ? '0' : '1'}|${i.start ?? '99:99'}|${i.title}`;

// ─── Argument coercion shared by create and update ───────────────────────────

function resolveCategory(raw: unknown, world: AgentWorld): EventCategory | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') fail('category must be a category name or id.');
  const q = (raw as string).trim().toLowerCase();
  if (q === 'none' || q === 'no category') return null;
  const cats = world.categories;
  const hit = cats.find(c => c.id === raw)
    ?? cats.find(c => c.name.toLowerCase() === q)
    ?? cats.find(c => c.name.toLowerCase().startsWith(q))
    ?? cats.find(c => c.name.toLowerCase().includes(q));
  if (!hit) fail(`Unknown category "${raw}". Existing categories: ${cats.map(c => c.name).join(', ') || '(none)'}. Pick one of these or omit it.`);
  return hit!;
}

function resolveList(raw: unknown, world: AgentWorld): TaskList | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') fail('list must be a task list name or id.');
  const q = (raw as string).trim().toLowerCase();
  const lists = world.taskLists;
  const hit = lists.find(l => l.id === raw)
    ?? lists.find(l => l.name.toLowerCase() === q)
    ?? lists.find(l => l.name.toLowerCase().startsWith(q))
    ?? lists.find(l => l.name.toLowerCase().includes(q));
  if (!hit) fail(`Unknown task list "${raw}". Existing lists: ${lists.map(l => l.name).join(', ')}.`);
  return hit!;
}

function parseWeekday(raw: unknown): Weekday {
  if (typeof raw === 'number' && raw >= 0 && raw <= 6) return raw as Weekday;
  if (typeof raw !== 'string') fail(`"${String(raw)}" is not a weekday.`);
  const q = (raw as string).trim().toLowerCase();
  const idx = WEEKDAY_NAMES.findIndex(n => n === q || n.slice(0, 3) === q.slice(0, 3));
  if (idx < 0 || q.length < 2) fail(`"${raw}" is not a weekday.`);
  return idx as Weekday;
}

/** null = "stop repeating" (only meaningful on update); undefined = not given. */
function parseRecurrence(raw: unknown, anchor: string): Recurrence | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === 'none' || raw === false) return null;
  if (!isRecord(raw)) fail('recurrence must be an object like {"freq":"weekly","weekdays":["mon","wed"]} or null.');
  const r = raw as Record<string, unknown>;
  const freq = String(r.freq ?? '').toLowerCase();
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) fail('recurrence.freq must be daily, weekly, monthly or yearly.');
  const interval = r.interval == null ? 1 : Math.floor(Number(r.interval));
  if (!Number.isFinite(interval) || interval < 1 || interval > 365) fail('recurrence.interval must be a whole number from 1.');
  const out: Recurrence = { freq: freq as Recurrence['freq'], interval };
  if (freq === 'weekly' && r.weekdays != null) {
    if (!Array.isArray(r.weekdays) || !r.weekdays.length) fail('recurrence.weekdays must be a non-empty list like ["mon","thu"].');
    const days = [...new Set((r.weekdays as unknown[]).map(parseWeekday))].sort((a, b) => a - b) as Weekday[];
    out.byWeekday = days;
    // The anchor must itself be one of the repeat days, or the first stored
    // occurrence would be a day the rule never produces.
    const aDay = parseDate(anchor).getDay() as Weekday;
    if (!days.includes(aDay)) fail(`The start date ${anchor} is a ${WEEKDAY_NAMES[aDay]}, which is not one of the repeat weekdays. Use the first matching date as the date.`);
  }
  if (r.until != null && r.count != null) fail('Give recurrence.until or recurrence.count, not both.');
  if (r.until != null) {
    const until = parseYmdStrict(r.until, 'recurrence.until');
    if (until < anchor) fail('recurrence.until is before the first date.');
    out.end = { until };
  } else if (r.count != null) {
    const count = Math.floor(Number(r.count));
    if (!Number.isFinite(count) || count < 1 || count > 5000) fail('recurrence.count must be a whole number from 1.');
    out.end = { count };
  }
  return out;
}

/** undefined = inherit (leave absent). */
function parseReminders(raw: unknown): NotifySpec | undefined | 'inherit' {
  if (raw === undefined) return undefined;
  if (raw === null || raw === 'default' || raw === 'inherit') return 'inherit';
  if (raw === 'off' || raw === false) return { enabled: false, rules: [], priority: 'normal' };
  if (!isRecord(raw)) fail('reminders must be "default", "off", or {"minutesBefore":[30,1440],"critical":false}.');
  const r = raw as Record<string, unknown>;
  const mode = r.mode == null ? 'custom' : String(r.mode);
  if (mode === 'default' || mode === 'inherit') return 'inherit';
  if (mode === 'off') return { enabled: false, rules: [], priority: 'normal' };
  const list = r.minutesBefore == null ? [0] : r.minutesBefore;
  if (!Array.isArray(list) || !list.length) fail('reminders.minutesBefore must be a non-empty list of minutes, e.g. [0, 30].');
  const mins = [...new Set((list as unknown[]).map(v => Math.round(Number(v))))];
  if (mins.some(m => !Number.isFinite(m) || m < -1440 || m > 60 * 24 * 60)) fail('reminders.minutesBefore values must be minutes before the start (0 = at the time).');
  mins.sort((a, b) => b - a);
  return {
    enabled: true,
    // `0 - m`, not `-m`: negating 0 gives -0, which is a different JSON value
    // to a deep compare and reads as a change to a spec nobody changed.
    rules: mins.map((m, i) => ({ id: `r${i}`, offsetMin: 0 - m })),
    priority: r.critical === true ? 'critical' : 'normal',
  };
}

// ─── Diffing two stores into undo records ────────────────────────────────────

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (isRecord(val)
    ? Object.fromEntries(Object.keys(val).sort().filter(k => val[k] !== undefined).map(k => [k, val[k]]))
    : val));
}

export function diffStores(
  store: 'events' | 'tasks',
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): UndoRecord[] {
  const out: UndoRecord[] = [];
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const id of ids) {
    const b = (before[id] as Record<string, unknown> | undefined) ?? null;
    const a = (after[id] as Record<string, unknown> | undefined) ?? null;
    if (stable(b) === stable(a)) continue;
    out.push({ store, id, before: b, after: a });
  }
  return out;
}

/** Strip undefined so a stored record never carries `"x": undefined` keys. */
function clean<T extends object>(r: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(r)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

// ─── Tool definitions (what the model is shown) ──────────────────────────────

const recurrenceSchema = {
  type: 'object',
  description: 'Repeat rule. Omit for a one-off item.',
  properties: {
    freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
    interval: { type: 'integer', description: 'Every N days/weeks/months/years. Default 1.' },
    weekdays: { type: 'array', items: { type: 'string' }, description: 'Weekly only: e.g. ["mon","wed","fri"]. The item date must be one of these days.' },
    until: { type: 'string', description: 'Last possible date YYYY-MM-DD (inclusive).' },
    count: { type: 'integer', description: 'Number of occurrences in total.' },
  },
  required: ['freq'],
};

const remindersSchema = {
  description: 'Reminder notifications. Omit (or "default") to use the category/app default, which is almost always right. "off" disables. Custom: {"minutesBefore":[0,30,1440],"critical":false}; 0 = at the time, 1440 = one day before.',
  anyOf: [
    { type: 'string', enum: ['default', 'off'] },
    {
      type: 'object',
      properties: {
        minutesBefore: { type: 'array', items: { type: 'integer' } },
        critical: { type: 'boolean', description: 'Critical reminders keep alerting until acknowledged. Only if the user asks.' },
      },
    },
  ],
};

const eventFieldProps = {
  title: { type: 'string', description: 'The text shown on the calendar. Clear and specific; include the location in parentheses when there is one, e.g. "Rules briefing (New Soft Area)".' },
  date: { type: 'string', description: 'YYYY-MM-DD. For a repeating item, the first occurrence.' },
  startTime: { type: 'string', description: '24-hour HH:mm. Omit for all-day items.' },
  endTime: { type: 'string', description: '24-hour HH:mm. May be earlier than startTime for an item that ends after midnight. Omit to use the category default duration.' },
  allDay: { type: 'boolean' },
  endDate: { type: 'string', description: 'All-day items spanning several days: the LAST day, YYYY-MM-DD, inclusive.' },
  pointInTime: { type: 'boolean', description: 'A moment with no duration (a deadline, "doors open", "kick-off"). Uses startTime only.' },
  category: { type: 'string', description: 'Category name exactly as listed in the context. Omit if none fits.' },
  color: { type: 'string', description: 'Hex colour, only when the user asks for a colour. Categories colour items already.' },
  checkbox: { type: 'boolean', description: 'Whether the item shows a completion checkbox. Omit to use the category default.' },
  recurrence: recurrenceSchema,
  reminders: remindersSchema,
};

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_items',
      description: 'Read what is on the calendar between two dates (inclusive): events, dated tasks, and optionally prayer times. Repeating items are expanded; each occurrence has its own id ("<id>::<date>") that you pass to update/delete. Always check before adding, so you do not create duplicates or clashes.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD, inclusive. At most 92 days after from.' },
          include: { type: 'array', items: { type: 'string', enum: ['events', 'tasks', 'prayers'] }, description: 'Default ["events","tasks"].' },
          text: { type: 'string', description: 'Only items whose title contains this text.' },
          category: { type: 'string', description: 'Only events in this category.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_items',
      description: 'Find events and tasks by words in their title, across all dates, including tasks with no date. Returns each match with its next occurrence (or its date).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string', enum: ['any', 'event', 'task'] },
          includePast: { type: 'boolean', description: 'Also return items that are entirely in the past. Default false.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_free_time',
      description: 'Find free gaps on one day between timed items (and prayer times unless excluded).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD' },
          from: { type: 'string', description: 'HH:mm, default the start of the user\'s day.' },
          to: { type: 'string', description: 'HH:mm, default 23:59.' },
          minMinutes: { type: 'integer', description: 'Shortest gap worth returning. Default 15.' },
          respectPrayers: { type: 'boolean', description: 'Treat each prayer as a 20-minute block. Default true.' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_events',
      description: 'Add calendar events (timed, all-day, multi-day, point-in-time, repeating). Pass ALL the events of a request in ONE call. Exact duplicates of existing items are skipped automatically and reported.',
      parameters: {
        type: 'object',
        properties: {
          events: { type: 'array', items: { type: 'object', properties: eventFieldProps, required: ['title', 'date'] } },
          allowDuplicates: { type: 'boolean', description: 'Only true if the user explicitly wants a second identical item.' },
        },
        required: ['events'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_events',
      description: 'Change existing events: rename, move to another date or time, change category/colour/reminders/repeat rule, or mark done. Only the fields you pass change. For a REPEATING event you must say which occurrences: scope "one" (just that date), "following" (that date onwards) or "all".',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Id from list_items/search_items (an occurrence id is fine).' },
                scope: { type: 'string', enum: ['one', 'following', 'all'] },
                set: {
                  type: 'object',
                  properties: {
                    ...eventFieldProps,
                    recurrence: { ...recurrenceSchema, description: 'New repeat rule, or null to stop repeating.' },
                    done: { type: 'boolean', description: 'Tick or untick this occurrence.' },
                  },
                },
              },
              required: ['id', 'set'],
            },
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_tasks',
      description: 'Add tasks (to-dos). A task may have no date (goes to the task board), a date (shows in the day\'s task row), or a date and time (drawn on the grid). Pass all tasks in one call.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                notes: { type: 'string' },
                date: { type: 'string', description: 'YYYY-MM-DD, or omit for no date.' },
                startTime: { type: 'string', description: 'HH:mm, requires date.' },
                endTime: { type: 'string', description: 'HH:mm. Default 30 minutes after startTime.' },
                list: { type: 'string', description: 'Task list name as in the context. Default General.' },
                recurrence: recurrenceSchema,
                reminders: remindersSchema,
                subtasks: { type: 'array', items: { type: 'string' }, description: 'Titles of steps under this task.' },
                parentId: { type: 'string', description: 'Make this a step of an existing task.' },
              },
              required: ['title'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_tasks',
      description: 'Change tasks: rename, re-date (null removes the date), set time, move list, edit notes, change repeat rule, or mark done/not done. Repeating tasks need a scope like update_events.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                scope: { type: 'string', enum: ['one', 'following', 'all'] },
                set: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    notes: { type: 'string' },
                    date: { type: ['string', 'null'] },
                    startTime: { type: ['string', 'null'] },
                    endTime: { type: ['string', 'null'] },
                    list: { type: 'string' },
                    recurrence: { ...recurrenceSchema, description: 'New repeat rule, or null to stop repeating.' },
                    reminders: remindersSchema,
                    done: { type: 'boolean' },
                  },
                },
              },
              required: ['id', 'set'],
            },
          },
        },
        required: ['updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_items',
      description: 'Delete events or tasks. This does NOT delete immediately: the user sees exactly what will be removed and must press Approve. Batch every deletion of a request into one call. Repeating items need a scope.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                scope: { type: 'string', enum: ['one', 'following', 'all'] },
              },
              required: ['id'],
            },
          },
          reason: { type: 'string', description: 'One short sentence shown on the approval card.' },
        },
        required: ['items', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user 1 to 4 multiple-choice questions and WAIT for the answers. Use it whenever the request is ambiguous and a wrong guess would put wrong things in their calendar. Never ask about things that have an obvious default. Recommended option first, with "(Recommended)" at the end of its label. The user can always type their own answer.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                header: { type: 'string', description: 'Very short chip label, max 12 characters.' },
                question: { type: 'string', description: 'The full question, ending with "?".' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { label: { type: 'string' }, description: { type: 'string' } },
                    required: ['label'],
                  },
                  description: '2 to 4 distinct options.',
                },
                multiSelect: { type: 'boolean' },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_focus_sessions',
      description: 'List completed focus sessions in a date range. Shows each session\'s start/end time, duration, and which day it counts toward. Use this to answer questions about focus history, peak focus times, specific sessions, or daily totals.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD, inclusive. At most 366 days.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_focus_stats',
      description: 'Get focus statistics and streaks: total hours, session count, daily average, best day, current/longest streak, and daily goal progress. Also reports the current timer state (running/paused/idle, elapsed time, planned duration). Use this for questions about focus trends, productivity, goals, and streaks.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD. Start of the stats range.' },
          to: { type: 'string', description: 'YYYY-MM-DD, inclusive. End of the stats range.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_focus_sessions',
      description: 'Delete focus sessions by their ids. This does NOT delete immediately: the user sees exactly what will be removed and must press Approve. Use this when the user asks to remove specific sessions from their history.',
      parameters: {
        type: 'object',
        properties: {
          sessionIds: { type: 'array', items: { type: 'string' }, description: 'Session ids from list_focus_sessions.' },
          reason: { type: 'string', description: 'One short sentence shown on the approval card.' },
        },
        required: ['sessionIds', 'reason'],
      },
    },
  },
] as const;

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFS.map(t => t.function.name));

/** Tools that change nothing and may run without any bookkeeping. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['list_items', 'search_items', 'find_free_time', 'list_focus_sessions', 'get_focus_stats']);

// ─── Tool dispatch ───────────────────────────────────────────────────────────

export function runTool(name: string, rawArgs: unknown, world: AgentWorld): ToolOutcome {
  if (!TOOL_NAMES.has(name)) {
    return {
      isError: true,
      label: `Refused unknown tool "${name}"`,
      result: { error: `There is no tool called "${name}". Nothing was done. The only tools are: ${[...TOOL_NAMES].join(', ')}.` },
    };
  }
  let args: Record<string, unknown>;
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs); } catch { return badArgs(name, 'Arguments were not valid JSON.'); }
  } else args = (rawArgs ?? {}) as Record<string, unknown>;
  if (!isRecord(args)) return badArgs(name, 'Arguments must be a JSON object.');

  try {
    switch (name) {
      case 'list_items': return listItems(args, world);
      case 'search_items': return searchItems(args, world);
      case 'find_free_time': return findFreeTime(args, world);
      case 'create_events': return createEvents(args, world);
      case 'update_events': return updateEvents(args, world);
      case 'create_tasks': return createTasks(args, world);
      case 'update_tasks': return updateTasks(args, world);
      case 'delete_items': return prepareDeletion(args, world);
      case 'list_focus_sessions': return listFocusSessions(args, world);
      case 'get_focus_stats': return getFocusStats(args, world);
      case 'delete_focus_sessions': return prepareFocusDeletion(args, world);
      case 'ask_user': return askUser(args, world);
    }
  } catch (err) {
    if (err instanceof ToolError) return badArgs(name, err.message);
    throw err;
  }
  return badArgs(name, 'Unhandled tool.');
}

function badArgs(name: string, message: string): ToolOutcome {
  return { isError: true, label: `${name}: ${message}`, result: { error: message, nothingWasChanged: true } };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

function listItems(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const from = parseYmdStrict(args.from, 'from');
  const to = parseYmdStrict(args.to, 'to');
  if (to < from) fail('"to" is before "from".');
  if (differenceInCalendarDays(parseDate(to), parseDate(from)) > 92) fail('Ask for at most 93 days at a time.');
  const include = Array.isArray(args.include) && args.include.length
    ? new Set((args.include as unknown[]).map(String))
    : new Set(['events', 'tasks']);
  const text = typeof args.text === 'string' && args.text.trim() ? normTitle(args.text) : null;
  const cat = args.category != null ? resolveCategory(args.category, world) : undefined;

  let occs: Occ[] = [];
  if (include.has('events')) occs.push(...expand(world.events, 'event', from, to, world.weekStartsOn));
  if (include.has('tasks')) occs.push(...expand(world.tasks as Record<string, RecurFields>, 'task', from, to, world.weekStartsOn));
  if (text) occs = occs.filter(o => normTitle(o.kind === 'event' ? (o.record as AgentEvent).content : (o.record as Task).title).includes(text));
  if (cat !== undefined) occs = occs.filter(o => o.kind === 'event' && (o.record as AgentEvent).categoryId === (cat?.id ?? undefined));

  const items = occs.map(o => compactItem(o, world)).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const MAX = 250;
  const result: Record<string, unknown> = {
    from, to,
    count: items.length,
    items: items.slice(0, MAX),
  };
  if (items.length > MAX) result.truncated = `Only the first ${MAX} are shown; ask for a shorter range.`;
  if (include.has('prayers')) {
    const prayers: Record<string, PrayerDay | string> = {};
    for (let d = parseDate(from); d <= parseDate(to); d = addDays(d, 1)) {
      const key = ymd(d);
      prayers[key] = world.prayersFor?.(key) ?? 'not available';
    }
    result.prayers = prayers;
  }
  return { result, label: `Checked ${from === to ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`} (${items.length} item${items.length === 1 ? '' : 's'})` };
}

function searchItems(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (typeof args.query !== 'string' || !args.query.trim()) fail('query must be some words to look for.');
  const words = normTitle(args.query as string).split(' ').filter(Boolean);
  const kind = typeof args.kind === 'string' ? args.kind : 'any';
  const includePast = args.includePast === true;
  const today = ymd(world.now);
  const hits: Array<Record<string, unknown>> = [];

  const consider = (rec: RecurFields, k: 'event' | 'task', title: string) => {
    if (rec.deleted || String(rec.id).includes('::')) return;
    const t = normTitle(title);
    if (!words.every(w => t.includes(w))) return;
    const anchor = anchorDate(rec);
    let date: string | null = anchor;
    if (rec.recur && anchor) {
      const next = occurrenceStarts(rec, parseDate(today), addDays(parseDate(today), 800), world.weekStartsOn)[0];
      date = next ? ymd(next) : null;
      if (!date && !includePast) return;
    } else if (anchor && !includePast) {
      const span = rec.allDay ? Math.max(1, rec.daysSpan ?? 1) : 1;
      if (ymd(addDays(parseDate(anchor), span - 1)) < today) return;
    }
    const occ: Occ = {
      id: rec.recur && date ? makeOccId(rec.id, date) : rec.id,
      masterId: rec.id, kind: k, date: date ?? '', record: rec as AgentEvent,
    };
    const item = date ? compactItem(occ, world) : { id: rec.id, kind: k, title, date: null, noDate: true };
    if (!date && k === 'task') {
      const tf = taskFacts(rec as Task, world);
      if (tf.list) (item as Record<string, unknown>).list = tf.list;
      if (tf.done) (item as Record<string, unknown>).done = true;
    }
    hits.push(item as Record<string, unknown>);
  };

  if (kind !== 'task') for (const ev of Object.values(world.events)) if (ev) consider(ev, 'event', ev.content ?? '');
  if (kind !== 'event') for (const t of Object.values(world.tasks)) if (t) consider(t, 'task', t.title ?? '');
  hits.sort((a, b) => String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')));
  return {
    result: { query: args.query, count: hits.length, items: hits.slice(0, 60), ...(hits.length > 60 ? { truncated: true } : {}) },
    label: `Searched for "${args.query}" (${hits.length} found)`,
  };
}

function findFreeTime(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const date = parseYmdStrict(args.date, 'date');
  const from = args.from != null ? toMin(parseTime(args.from, 'from')) : world.dayStartH * 60;
  const toRaw = args.to != null ? parseTime(args.to, 'to') : '23:59';
  const to = toRaw === '00:00' ? 1440 : toMin(toRaw);
  if (to <= from) fail('"to" must be after "from".');
  const minMinutes = args.minMinutes != null ? Math.max(1, Math.floor(Number(args.minMinutes))) : 15;
  const respectPrayers = args.respectPrayers !== false;

  const busy: Array<[number, number, string]> = [];
  const prevDay = ymd(addDays(parseDate(date), -1));
  for (const o of [
    ...expand(world.events, 'event', prevDay, date, world.weekStartsOn),
    ...expand(world.tasks as Record<string, RecurFields>, 'task', prevDay, date, world.weekStartsOn),
  ]) {
    const r = o.record as AgentEvent;
    if (r.allDay || !r.startTime) continue;
    const s = toMin(r.startTime);
    const point = r.noDuration || !r.endTime || r.endTime === r.startTime;
    let e = point ? s + 10 : toMin(r.endTime!);
    const overnight = !point && e <= s;
    if (overnight) e += 1440;
    const title = o.kind === 'event' ? r.content : (o.record as Task).title;
    if (o.date === date) busy.push([s, Math.min(e, 1440), title]);
    else if (o.date === prevDay && overnight) busy.push([0, e - 1440, title]);
  }
  if (respectPrayers) {
    const p = world.prayersFor?.(date);
    if (p) for (const k of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const) {
      const t = p[k];
      if (t) busy.push([toMin(t), toMin(t) + 20, `${k} prayer`]);
    }
  }
  busy.sort((a, b) => a[0] - b[0]);
  const free: Array<{ start: string; end: string; minutes: number }> = [];
  let cursor = from;
  for (const [s, e] of busy) {
    if (e <= cursor) continue;
    if (s >= to) break;
    if (s - cursor >= minMinutes) free.push({ start: fromMin(cursor), end: fromMin(s), minutes: s - cursor });
    cursor = Math.max(cursor, e);
  }
  if (to - cursor >= minMinutes) free.push({ start: fromMin(cursor), end: to === 1440 ? '24:00' : fromMin(to), minutes: to - cursor });
  return {
    result: {
      date,
      busy: busy.filter(([s, e]) => e > from && s < to).map(([s, e, t]) => ({ start: fromMin(s), end: e >= 1440 ? '24:00' : fromMin(e), title: t })),
      free,
    },
    label: `Looked for free time on ${dayLabel(date)}`,
  };
}

// ─── Creating events ─────────────────────────────────────────────────────────

interface BuiltEvent { record: AgentEvent; facts: ItemFacts }

function buildEvent(raw: unknown, world: AgentWorld, idx: number): BuiltEvent {
  if (!isRecord(raw)) fail(`events[${idx}] must be an object.`);
  const a = raw as Record<string, unknown>;
  const title = typeof a.title === 'string' ? a.title.trim() : '';
  if (!title) fail(`events[${idx}].title is required.`);
  if (title.length > 300) fail(`events[${idx}].title is too long.`);
  const date = parseYmdStrict(a.date, `events[${idx}].date`);
  const cat = a.category !== undefined ? resolveCategory(a.category, world) : (world.categories.find(c => c.isDefault) ?? null);

  const allDay = a.allDay === true || (a.allDay == null && a.startTime == null && (a.endDate != null || cat?.defaultAllDay === true));
  const rec: AgentEvent = {
    id: (world.newId ?? uuid)(),
    content: title,
    ...anchorFor(date, world.weekStartsOn),
    startTime: '00:00',
    endTime: '00:30',
    deleted: false,
    updatedAt: world.now.getTime(),
  };
  if (cat) { rec.categoryId = cat.id; rec.color = cat.color; }
  else rec.color = 'sage';
  if (typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color.trim())) rec.color = a.color.trim();
  else if (a.color != null && a.color !== '') fail(`events[${idx}].color must be a hex colour like "#22c55e".`);

  if (allDay) {
    rec.allDay = true;
    let span = 1;
    if (a.endDate != null) {
      const end = parseYmdStrict(a.endDate, `events[${idx}].endDate`);
      if (end < date) fail(`events[${idx}].endDate is before its date.`);
      span = differenceInCalendarDays(parseDate(end), parseDate(date)) + 1;
      if (span > 366) fail(`events[${idx}] spans more than a year.`);
    }
    rec.daysSpan = span;
    rec.noDuration = false;
  } else {
    if (a.startTime == null) fail(`events[${idx}] needs a startTime, or allDay: true.`);
    if (a.endDate != null) fail(`events[${idx}].endDate is only for all-day items; a timed item that ends after midnight just uses an endTime earlier than its startTime.`);
    const start = parseTime(a.startTime, `events[${idx}].startTime`);
    rec.startTime = start;
    rec.allDay = false;
    rec.daysSpan = 1;
    const point = a.pointInTime === true
      || (a.pointInTime == null && a.endTime == null && (cat?.defaultNoDuration === true || cat?.defaultDurationMin === 0));
    if (point) {
      rec.noDuration = true;
      rec.endTime = start;
    } else {
      rec.noDuration = false;
      if (a.endTime != null) {
        const end = parseTime(a.endTime, `events[${idx}].endTime`);
        if (end === start) fail(`events[${idx}] ends when it starts; use pointInTime: true for a moment with no duration.`);
        rec.endTime = end;
      } else {
        const dur = cat?.defaultDurationMin && cat.defaultDurationMin > 0 ? cat.defaultDurationMin : 60;
        rec.endTime = fromMin(toMin(start) + dur);
      }
    }
  }

  rec.noCheckbox = typeof a.checkbox === 'boolean' ? !a.checkbox : (cat?.defaultNoCheckbox ?? false);

  const recur = parseRecurrence(a.recurrence, date);
  if (recur) rec.recur = recur;
  const rem = parseReminders(a.reminders);
  if (rem && rem !== 'inherit') rec.notify = rem;

  const record = clean(rec);
  return { record, facts: eventFacts(record, world) };
}

function isDuplicateEvent(candidate: AgentEvent, events: EventData): AgentEvent | null {
  const title = normTitle(candidate.content);
  const date = anchorDate(candidate);
  for (const ev of Object.values(events)) {
    if (!ev || ev.deleted || normTitle(ev.content ?? '') !== title) continue;
    if (anchorDate(ev) !== date) continue;
    if (!!ev.allDay !== !!candidate.allDay) continue;
    if (!candidate.allDay && ev.startTime !== candidate.startTime) continue;
    return ev;
  }
  return null;
}

function createEvents(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!Array.isArray(args.events) || !args.events.length) fail('events must be a non-empty list.');
  if ((args.events as unknown[]).length > 200) fail('At most 200 events per call.');
  const allowDup = args.allowDuplicates === true;

  // Validate EVERYTHING first: a batch with one bad item adds nothing, so the
  // model can fix that item and resend the batch without half of it landing twice.
  const built = (args.events as unknown[]).map((e, i) => buildEvent(e, world, i));

  const next: EventData = { ...world.events };
  const entries: ChangeEntry[] = [];
  const results: Array<Record<string, unknown>> = [];
  for (const b of built) {
    const dup = allowDup ? null : isDuplicateEvent(b.record, next);
    if (dup) {
      entries.push({ action: 'skipped', kind: 'event', id: dup.id, after: eventFacts(dup, world), note: 'Already in your calendar, so it was not added again.', verified: true });
      results.push({ title: b.record.content, skipped: 'duplicate of an existing item', existingId: dup.id });
      continue;
    }
    next[b.record.id] = b.record;
    entries.push({ action: 'added', kind: 'event', id: b.record.id, after: b.facts, verified: false });
    results.push({ id: b.record.id, title: b.record.content, when: whenLabel(b.facts, '24h'), ...(b.facts.repeats ? { repeats: b.facts.repeats } : {}) });
  }
  const added = entries.filter(e => e.action === 'added').length;
  const skipped = entries.length - added;
  return {
    events: next,
    entries,
    undo: diffStores('events', world.events, next),
    result: { added, skipped, items: results },
    label: `Added ${added} event${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}`,
  };
}

// ─── Updating (shared by events and tasks) ───────────────────────────────────

interface Target<T> { master: T; masterId: string; occDate: string | null }

function findTarget<T extends RecurFields>(store: Record<string, T>, id: unknown, kind: string): Target<T> {
  if (typeof id !== 'string' || !id) fail(`Each ${kind} update needs an id.`);
  const { masterId, occDate } = parseOccId(id as string);
  const master = store[masterId];
  if (!master || master.deleted) fail(`No ${kind} with id "${id}". Use list_items or search_items to get current ids.`);
  if (occDate && master.recur) {
    const found = occurrenceStarts(master, parseDate(occDate), addDays(parseDate(occDate), 1));
    if (!found.length) fail(`"${id}" is not a current occurrence of that repeating ${kind}.`);
  }
  return { master, masterId, occDate: master.recur ? occDate : null };
}

function scopeOf(raw: unknown, isRepeating: boolean, occDate: string | null, kind: string, id: string): OccurrenceScope {
  if (!isRepeating) return 'all';
  if (raw !== 'one' && raw !== 'following' && raw !== 'all') {
    fail(`"${id}" is a repeating ${kind}: pass scope "one", "following" or "all". If the user did not say, ask them with ask_user.`);
  }
  if ((raw === 'one' || raw === 'following') && !occDate) {
    fail(`scope "${raw}" needs an occurrence id ("<id>::YYYY-MM-DD") from list_items so it is clear which date is meant.`);
  }
  return raw as OccurrenceScope;
}

/** Shift a repeating master's anchor (and weekly weekdays) by whole days. */
function shiftSeries<T extends RecurFields>(rec: T, delta: number, weekStartsOn: WeekStartsOn): T {
  if (!delta || !rec.recur) return rec;
  const rule = rec.recur;
  const anchor = parseDate(anchorDate(rec)!);
  const newAnchor = addDays(anchor, delta);
  let recur = rule;
  if (rule.freq === 'weekly') {
    const days = rule.byWeekday && rule.byWeekday.length ? rule.byWeekday : [anchor.getDay() as Weekday];
    const shift = ((delta % 7) + 7) % 7;
    recur = { ...rule, byWeekday: [...new Set(days.map(d => ((d + shift) % 7) as Weekday))].sort((a, b) => a - b) };
  }
  if (rule.end && 'until' in rule.end) {
    recur = { ...recur, end: { until: ymd(addDays(parseDate(rule.end.until), delta)) } };
  }
  const exdates = rec.exdates?.map(d => ymd(addDays(parseDate(d), delta)));
  return { ...rec, recur, exdates, ...anchorFor(ymd(newAnchor), weekStartsOn) };
}

/** Apply an edit plan, then move the resulting target record's date if asked. */
function applyEdit<T extends RecurFields>(
  store: Record<string, T>,
  target: Target<T>,
  scope: OccurrenceScope,
  patch: Partial<T>,
  newDate: string | null,
  world: AgentWorld,
): { store: Record<string, T>; targetId: string; appliedScope: OccurrenceScope; forcedByLock: boolean } {
  const { master, occDate } = target;
  const plan = planOccurrenceEdit<T>(master, occDate, scope, patch, {
    weekStartsOn: world.weekStartsOn,
    newId: world.newId ?? uuid,
    now: () => world.now.getTime(),
  });
  const out = { ...store };
  for (const w of plan.writes) {
    if (w.op === 'remove') delete out[w.id];
    else out[w.id] = w.record;
  }
  const targetId = plan.targetId ?? master.id;
  if (newDate) {
    const rec = out[targetId];
    if (!rec.recur) {
      out[targetId] = { ...rec, ...anchorFor(newDate, world.weekStartsOn) };
    } else {
      // A whole series (or its tail) moves by the distance between the chosen
      // occurrence and its new date; with no occurrence given, by the anchor.
      const fromDate = plan.scope === 'following' ? occDate! : (occDate ?? anchorDate(rec)!);
      const delta = differenceInCalendarDays(parseDate(newDate), parseDate(fromDate));
      if (rec.recur.freq === 'daily' && delta !== 0 && plan.scope === 'all' && rec.recur.interval === 1) {
        // Moving an every-day series by days means changing its first day.
        out[targetId] = { ...rec, ...anchorFor(ymd(addDays(parseDate(anchorDate(rec)!), delta)), world.weekStartsOn) };
      } else {
        out[targetId] = shiftSeries(rec, delta, world.weekStartsOn);
      }
    }
  }
  return { store: out, targetId, appliedScope: plan.scope, forcedByLock: plan.forcedByLock };
}

function scopeNote(applied: OccurrenceScope, occDate: string | null, repeating: boolean, forcedByLock: boolean): string | undefined {
  if (!repeating) return undefined;
  if (forcedByLock) return 'The series is locked, so the change applied to every occurrence.';
  if (applied === 'one') return `Only the ${occDate ? dayLabel(occDate) : 'chosen'} occurrence was changed; it is now a separate item.`;
  if (applied === 'following') return `Changed from ${occDate ? dayLabel(occDate) : 'that date'} onwards.`;
  return 'Changed for the whole series.';
}

const EVENT_FIELD_ORDER = ['title', 'date', 'endDate', 'startTime', 'endTime', 'allDay', 'pointInTime', 'category', 'color', 'repeats', 'reminders', 'checkbox', 'done'];

function changedFields(before: ItemFacts, after: ItemFacts): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === 'kind') continue;
    if (stable((before as unknown as Record<string, unknown>)[k]) !== stable((after as unknown as Record<string, unknown>)[k])) out.push(k);
  }
  return out.sort((a, b) => {
    const ia = EVENT_FIELD_ORDER.indexOf(a); const ib = EVENT_FIELD_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function updateEvents(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!Array.isArray(args.updates) || !args.updates.length) fail('updates must be a non-empty list.');
  let store: EventData = { ...world.events };
  const entries: ChangeEntry[] = [];
  const results: unknown[] = [];

  (args.updates as unknown[]).forEach((u, idx) => {
    if (!isRecord(u)) fail(`updates[${idx}] must be an object.`);
    const upd = u as Record<string, unknown>;
    const target = findTarget(store, upd.id, 'event');
    const ro = readOnlyReason(target.master, world);
    if (ro) fail(`Cannot change "${target.master.content}": ${ro}`);
    if (!isRecord(upd.set) || !Object.keys(upd.set).length) fail(`updates[${idx}].set must list at least one field to change.`);
    const set = upd.set as Record<string, unknown>;
    const beforeFacts = eventFacts(target.master, world, target.occDate);

    // Ticking an occurrence is recorded by date on the master; it never detaches.
    if (Object.keys(set).every(k => k === 'done')) {
      const cur = target.master;
      const day = cur.recur ? target.occDate : anchorDate(cur);
      if (!day) fail('Say which occurrence to tick with an occurrence id ("<id>::YYYY-MM-DD").');
      const dates = new Set(cur.completedDates ?? []);
      if (set.done === true) dates.add(day!); else dates.delete(day!);
      store[cur.id] = clean({ ...cur, completedDates: [...dates].sort(), updatedAt: world.now.getTime() });
      const afterFacts = eventFacts(store[cur.id], world, day);
      entries.push({ action: afterFacts.done ? 'completed' : 'reopened', kind: 'event', id: cur.id, before: beforeFacts, after: afterFacts, changed: ['done'], verified: false });
      results.push({ id: String(upd.id), title: afterFacts.title, done: !!afterFacts.done });
      return;
    }

    // The repeat rule and the category describe the SERIES (the PC's
    // `editSeries` treats them the same way), so they never need a scope.
    const seriesLevel = set.recurrence !== undefined || set.category !== undefined;
    const scope: OccurrenceScope = seriesLevel ? 'all' : scopeOf(upd.scope, !!target.master.recur, target.occDate, 'event', String(upd.id));

    // Everything is expressed as a patch on the stored record; the date move is
    // applied after the scope plan so it lands on whichever record carries it.
    const patch: Partial<AgentEvent> = {};
    const cur = target.master;
    if (set.title !== undefined) {
      if (typeof set.title !== 'string' || !set.title.trim()) fail('title cannot be empty.');
      patch.content = (set.title as string).trim();
    }
    if (set.category !== undefined) {
      const cat = resolveCategory(set.category, world);
      patch.categoryId = cat?.id;
      patch.color = cat?.color ?? (cur.categoryId ? 'sage' : cur.color);
    }
    if (set.color !== undefined) {
      if (typeof set.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(set.color.trim())) fail('color must be a hex colour like "#22c55e".');
      patch.color = (set.color as string).trim();
      if (set.category === undefined && cur.categoryId) patch.categoryId = undefined; // a category would repaint it
    }
    if (set.checkbox !== undefined) patch.noCheckbox = set.checkbox !== true;

    const willBeAllDay = set.allDay !== undefined ? set.allDay === true : !!cur.allDay;
    if (set.allDay !== undefined) patch.allDay = willBeAllDay;
    if (willBeAllDay) {
      if (set.allDay === true && !cur.allDay) { patch.daysSpan = 1; patch.noDuration = false; }
      if (set.endDate !== undefined) {
        const startDate = set.date !== undefined ? parseYmdStrict(set.date, 'date') : (target.occDate ?? anchorDate(cur)!);
        const end = parseYmdStrict(set.endDate, 'endDate');
        if (end < startDate) fail('endDate is before the start date.');
        patch.daysSpan = differenceInCalendarDays(parseDate(end), parseDate(startDate)) + 1;
      }
      if (set.startTime !== undefined || set.endTime !== undefined) fail('An all-day item has no times; pass allDay: false together with startTime to make it timed.');
    } else {
      if (set.allDay === false && cur.allDay && set.startTime === undefined) fail('Turning an all-day item into a timed one needs a startTime.');
      const start = set.startTime !== undefined ? parseTime(set.startTime, 'startTime') : cur.startTime ?? '09:00';
      if (set.startTime !== undefined) patch.startTime = start;
      if (set.allDay === false) patch.daysSpan = 1;
      const wantsPoint = set.pointInTime === true || (set.pointInTime === undefined && set.endTime === undefined && !!cur.noDuration && set.startTime !== undefined);
      if (wantsPoint) {
        patch.noDuration = true;
        patch.endTime = start;
      } else if (set.endTime !== undefined) {
        const end = parseTime(set.endTime, 'endTime');
        if (end === start) fail('endTime equals startTime; use pointInTime: true instead.');
        patch.endTime = end;
        patch.noDuration = false;
      } else if (set.startTime !== undefined && !cur.allDay) {
        // Moving the start keeps the duration, which is what "move it to 8" means.
        const oldStart = toMin(cur.startTime ?? start);
        const oldEnd = cur.noDuration || !cur.endTime ? oldStart : toMin(cur.endTime);
        const dur = ((oldEnd - oldStart) + 1440) % 1440;
        patch.endTime = fromMin(toMin(start) + dur);
        patch.noDuration = dur === 0;
      } else if (set.pointInTime === false && cur.noDuration) {
        patch.noDuration = false;
        patch.endTime = fromMin(toMin(start) + 60);
      } else if (set.allDay === false) {
        patch.endTime = fromMin(toMin(start) + 60);
        patch.noDuration = false;
      }
    }

    if (set.recurrence !== undefined) {
      const anchor = set.date !== undefined ? parseYmdStrict(set.date, 'date') : (target.occDate ?? anchorDate(cur)!);
      const recur = parseRecurrence(set.recurrence, anchor);
      patch.recur = recur ?? undefined;
      if (!recur) { patch.exdates = undefined; patch.locked = undefined; }
    }
    if (set.reminders !== undefined) {
      const rem = parseReminders(set.reminders);
      patch.notify = rem === 'inherit' ? undefined : rem;
    }

    const newDate = set.date !== undefined ? parseYmdStrict(set.date, 'date') : null;
    const res = applyEdit(store, target, scope, patch, newDate, world);
    store = res.store;
    let rec = store[res.targetId];

    if (set.done !== undefined) {
      const day = res.appliedScope === 'all' && rec.recur ? target.occDate : (anchorDate(rec) ?? target.occDate);
      if (!day) fail('Say which occurrence to tick with an occurrence id.');
      const dates = new Set(rec.completedDates ?? []);
      if (set.done === true) dates.add(day!); else dates.delete(day!);
      rec = { ...rec, completedDates: [...dates].sort(), updatedAt: world.now.getTime() };
      store[res.targetId] = rec;
    }
    store[res.targetId] = clean({ ...store[res.targetId], updatedAt: world.now.getTime() });
    rec = store[res.targetId];

    const afterOcc = rec.recur ? (newDate ?? target.occDate) : null;
    const afterFacts = eventFacts(rec, world, afterOcc);
    const changed = changedFields(beforeFacts, afterFacts);
    const doneOnly = changed.length === 1 && changed[0] === 'done';
    entries.push({
      action: doneOnly ? (afterFacts.done ? 'completed' : 'reopened') : 'updated',
      kind: 'event',
      id: res.targetId,
      before: beforeFacts,
      after: afterFacts,
      changed,
      note: scopeNote(res.appliedScope, target.occDate, !!target.master.recur, res.forcedByLock),
      verified: false,
    });
    results.push({ id: res.targetId, title: afterFacts.title, now: whenLabel(afterFacts, '24h'), changed, scopeApplied: target.master.recur ? res.appliedScope : undefined });
  });

  return {
    events: store,
    entries,
    undo: diffStores('events', world.events, store),
    result: { updated: entries.length, items: results },
    label: `Updated ${entries.length} event${entries.length === 1 ? '' : 's'}`,
  };
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

const GTASK_FRESH = {
  gTaskId: undefined, gTaskListId: undefined, gTaskETag: undefined,
  gTaskSeriesDate: undefined, gTaskParentId: undefined, lastSyncedAt: undefined, seriesDone: undefined,
};

function nextOrder(tasks: TaskData, listId: string | undefined, parentId: string | undefined): number {
  let max = 0;
  for (const t of Object.values(tasks)) {
    if (!t || t.deleted) continue;
    if ((t.listId || 'general') !== (listId || 'general')) continue;
    if ((t.parentId ?? undefined) !== parentId) continue;
    if (typeof t.order === 'number' && t.order > max) max = t.order;
  }
  return max + 10;
}

function createTasks(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!Array.isArray(args.tasks) || !args.tasks.length) fail('tasks must be a non-empty list.');
  if ((args.tasks as unknown[]).length > 200) fail('At most 200 tasks per call.');
  const next: TaskData = { ...world.tasks };
  const entries: ChangeEntry[] = [];
  const results: unknown[] = [];
  const now = world.now.getTime();
  const newId = world.newId ?? uuid;

  const built: Task[][] = (args.tasks as unknown[]).map((raw, idx) => {
    if (!isRecord(raw)) fail(`tasks[${idx}] must be an object.`);
    const a = raw as Record<string, unknown>;
    const title = typeof a.title === 'string' ? a.title.trim() : '';
    if (!title) fail(`tasks[${idx}].title is required.`);
    const list = a.list !== undefined ? resolveList(a.list, world) : null;
    let parentId: string | undefined;
    if (a.parentId != null) {
      const p = world.tasks[parseOccId(String(a.parentId)).masterId];
      if (!p || p.deleted) fail(`tasks[${idx}].parentId does not match a task.`);
      if (p.parentId) fail('Steps can only be one level deep; that task is already a step.');
      parentId = p.id;
    }
    const t: Task = { id: newId(), title, deleted: false, updatedAt: now };
    if (typeof a.notes === 'string' && a.notes.trim()) t.notes = a.notes.trim();
    if (parentId) { t.parentId = parentId; t.listId = world.tasks[parentId].listId; }
    else if (list && list.id !== 'general') t.listId = list.id;
    if (a.date != null) {
      const date = parseYmdStrict(a.date, `tasks[${idx}].date`);
      Object.assign(t, anchorFor(date, world.weekStartsOn));
      if (a.startTime != null) {
        t.startTime = parseTime(a.startTime, `tasks[${idx}].startTime`);
        t.endTime = a.endTime != null ? parseTime(a.endTime, `tasks[${idx}].endTime`) : fromMin(toMin(t.startTime) + 30);
      }
      const recur = parseRecurrence(a.recurrence, date);
      if (recur) t.recur = recur;
    } else {
      if (a.startTime != null) fail(`tasks[${idx}] has a time but no date.`);
      if (a.recurrence != null) fail(`tasks[${idx}] repeats but has no first date.`);
    }
    const rem = parseReminders(a.reminders);
    if (rem && rem !== 'inherit') t.notify = rem;
    t.order = nextOrder(next, t.listId, t.parentId);
    const group = [clean(t)];
    if (a.subtasks != null) {
      if (!Array.isArray(a.subtasks)) fail(`tasks[${idx}].subtasks must be a list of titles.`);
      if (parentId) fail('A step cannot have steps of its own.');
      (a.subtasks as unknown[]).forEach((s, j) => {
        const st = typeof s === 'string' ? s.trim() : '';
        if (!st) fail(`tasks[${idx}].subtasks[${j}] must be a title.`);
        group.push(clean({ id: newId(), title: st, parentId: t.id, listId: t.listId, order: (j + 1) * 10, deleted: false, updatedAt: now } as Task));
      });
    }
    return group;
  });

  for (const group of built) {
    for (const t of group) {
      next[t.id] = t;
      const facts = taskFacts(t, world);
      entries.push({
        action: 'added', kind: 'task', id: t.id, after: facts,
        note: t.parentId ? `Step of "${next[t.parentId]?.title ?? world.tasks[t.parentId]?.title ?? 'a task'}"` : undefined,
        verified: false,
      });
      results.push({ id: t.id, title: t.title, when: facts.date ? whenLabel(facts, '24h') : 'no date', list: facts.list, ...(t.parentId ? { stepOf: t.parentId } : {}) });
    }
  }
  return {
    tasks: next,
    entries,
    undo: diffStores('tasks', world.tasks as Record<string, unknown>, next as Record<string, unknown>),
    result: { added: entries.length, items: results },
    label: `Added ${entries.length} task${entries.length === 1 ? '' : 's'}`,
  };
}

function updateTasks(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!Array.isArray(args.updates) || !args.updates.length) fail('updates must be a non-empty list.');
  let store: TaskData = { ...world.tasks };
  const entries: ChangeEntry[] = [];
  const results: unknown[] = [];
  const now = world.now.getTime();

  (args.updates as unknown[]).forEach((u, idx) => {
    if (!isRecord(u)) fail(`updates[${idx}] must be an object.`);
    const upd = u as Record<string, unknown>;
    const target = findTarget(store, upd.id, 'task');
    if (!isRecord(upd.set) || !Object.keys(upd.set).length) fail(`updates[${idx}].set must list at least one field.`);
    const set = upd.set as Record<string, unknown>;
    const cur = target.master;
    const beforeFacts = taskFacts(cur, world, target.occDate);

    // Completion alone never detaches an occurrence: it is recorded by date.
    const onlyDone = Object.keys(set).every(k => k === 'done');
    if (onlyDone) {
      const next = { ...cur };
      if (cur.recur) {
        const day = target.occDate ?? fail('Say which occurrence with an occurrence id ("<id>::YYYY-MM-DD").');
        const dates = new Set(cur.completedDates ?? []);
        if (set.done === true) dates.add(day as string); else dates.delete(day as string);
        next.completedDates = [...dates].sort();
        next.completedAt = set.done === true ? now : cur.completedAt;
      } else {
        next.completed = set.done === true;
        next.completedAt = set.done === true ? now : undefined;
      }
      next.updatedAt = now;
      store[cur.id] = clean(next);
      const afterFacts = taskFacts(store[cur.id], world, target.occDate);
      entries.push({ action: afterFacts.done ? 'completed' : 'reopened', kind: 'task', id: cur.id, before: beforeFacts, after: afterFacts, changed: ['done'], verified: false });
      results.push({ id: cur.id, title: cur.title, done: afterFacts.done });
      return;
    }

    const seriesLevel = set.recurrence !== undefined
      || Object.keys(set).every(k => k === 'list' || k === 'done');
    const scope: OccurrenceScope = seriesLevel ? 'all' : scopeOf(upd.scope, !!cur.recur, target.occDate, 'task', String(upd.id));
    const patch: Partial<Task> = {};
    if (set.title !== undefined) {
      if (typeof set.title !== 'string' || !set.title.trim()) fail('title cannot be empty.');
      patch.title = (set.title as string).trim();
    }
    if (set.notes !== undefined) patch.notes = typeof set.notes === 'string' && set.notes.trim() ? set.notes.trim() : undefined;
    if (set.list !== undefined) {
      const list = resolveList(set.list, world);
      patch.listId = list && list.id !== 'general' ? list.id : undefined;
    }
    let newDate: string | null = null;
    let clearDate = false;
    if (set.date !== undefined) {
      if (set.date === null) clearDate = true;
      else newDate = parseYmdStrict(set.date, 'date');
    }
    if (set.startTime !== undefined) {
      if (set.startTime === null) { patch.startTime = undefined; patch.endTime = undefined; }
      else {
        if (!cur.weekKey && !newDate) fail('A task needs a date before it can have a time.');
        patch.startTime = parseTime(set.startTime, 'startTime');
        patch.endTime = set.endTime != null ? parseTime(set.endTime, 'endTime')
          : cur.startTime && cur.endTime ? fromMin(toMin(patch.startTime) + ((toMin(cur.endTime) - toMin(cur.startTime) + 1440) % 1440 || 30))
          : fromMin(toMin(patch.startTime) + 30);
      }
    } else if (set.endTime !== undefined && set.endTime !== null) {
      if (!cur.startTime) fail('Set a startTime before an endTime.');
      patch.endTime = parseTime(set.endTime, 'endTime');
    }
    if (set.recurrence !== undefined) {
      const anchor = newDate ?? target.occDate ?? anchorDate(cur);
      if (set.recurrence !== null && !anchor) fail('A repeating task needs a date.');
      const recur = anchor ? parseRecurrence(set.recurrence, anchor) : null;
      patch.recur = recur ?? undefined;
      if (!recur) { patch.exdates = undefined; patch.completedDates = undefined; }
    }
    if (set.reminders !== undefined) {
      const rem = parseReminders(set.reminders);
      patch.notify = rem === 'inherit' ? undefined : rem;
    }

    let targetId = cur.id;
    let applied: OccurrenceScope = 'all';
    let forced = false;
    if (clearDate) {
      // No date means no repeat and no time: it becomes a task-board item.
      store[cur.id] = clean({
        ...cur, ...patch,
        weekKey: undefined, dayIndex: undefined, startTime: undefined, endTime: undefined,
        recur: undefined, exdates: undefined, updatedAt: now,
      });
    } else {
      const seriesOnly = Object.keys(patch).every(k => k === 'listId') && !newDate;
      const res = applyEdit(store, target, set.recurrence !== undefined || seriesOnly ? 'all' : scope, patch, newDate, world);
      store = res.store;
      targetId = res.targetId;
      applied = res.appliedScope;
      forced = res.forcedByLock;
      if (!cur.weekKey && newDate) {
        store[targetId] = { ...store[targetId], ...anchorFor(newDate, world.weekStartsOn) };
      }
      if (targetId !== cur.id) {
        // A detached occurrence or split-off tail is its own Google task.
        store[targetId] = { ...store[targetId], ...GTASK_FRESH, completedDates: undefined } as Task;
      }
      store[targetId] = clean({ ...store[targetId], updatedAt: now });
    }
    if (set.done !== undefined) {
      const t = store[targetId];
      if (t.recur) {
        const day = target.occDate ?? fail('Say which occurrence to tick with an occurrence id.');
        const dates = new Set(t.completedDates ?? []);
        if (set.done === true) dates.add(day as string); else dates.delete(day as string);
        store[targetId] = { ...t, completedDates: [...dates].sort(), completedAt: now };
      } else {
        store[targetId] = clean({ ...t, completed: set.done === true, completedAt: set.done === true ? now : undefined });
      }
    }

    const rec = store[targetId];
    const afterFacts = taskFacts(rec, world, rec.recur ? (newDate ?? target.occDate) : null);
    const changed = changedFields(beforeFacts, afterFacts);
    entries.push({
      action: 'updated', kind: 'task', id: targetId, before: beforeFacts, after: afterFacts, changed,
      note: scopeNote(applied, target.occDate, !!cur.recur, forced), verified: false,
    });
    results.push({ id: targetId, title: afterFacts.title, now: afterFacts.date ? whenLabel(afterFacts, '24h') : 'no date', changed });
  });

  return {
    tasks: store,
    entries,
    undo: diffStores('tasks', world.tasks as Record<string, unknown>, store as Record<string, unknown>),
    result: { updated: entries.length, items: results },
    label: `Updated ${entries.length} task${entries.length === 1 ? '' : 's'}`,
  };
}

// ─── Deleting: preview, then (after approval) apply ──────────────────────────

function scopeLabel(scope: OccurrenceScope, occDate: string | null, repeating: boolean): string {
  if (!repeating) return 'This item';
  if (scope === 'one') return `Only ${occDate ? dayLabel(occDate) : 'this occurrence'}`;
  if (scope === 'following') return `${occDate ? dayLabel(occDate) : 'This date'} and every later occurrence`;
  return 'The whole repeating series';
}

function locate(id: unknown, world: AgentWorld): { kind: 'event' | 'task'; target: Target<RecurFields> } {
  if (typeof id !== 'string' || !id) fail('Each item needs an id.');
  const { masterId } = parseOccId(id as string);
  if (world.events[masterId] && !world.events[masterId].deleted) {
    return { kind: 'event', target: findTarget(world.events, id, 'event') };
  }
  if (world.tasks[masterId] && !world.tasks[masterId].deleted) {
    return { kind: 'task', target: findTarget(world.tasks as Record<string, RecurFields>, id, 'task') };
  }
  return fail(`No event or task with id "${id}". Use list_items or search_items for current ids.`);
}

function prepareDeletion(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!Array.isArray(args.items) || !args.items.length) fail('items must be a non-empty list.');
  if ((args.items as unknown[]).length > 100) fail('At most 100 deletions per request.');
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'Delete these items';
  const deletions: PendingDeletion[] = [];
  const plan: DeletionPlan = { items: [] };
  const seen = new Set<string>();

  (args.items as unknown[]).forEach((raw, idx) => {
    if (!isRecord(raw)) fail(`items[${idx}] must be an object.`);
    const it = raw as Record<string, unknown>;
    const { kind, target } = locate(it.id, world);
    if (kind === 'event') {
      const ro = readOnlyReason(target.master as AgentEvent, world);
      if (ro) fail(`Cannot delete "${(target.master as AgentEvent).content}": ${ro}`);
    }
    const scope = scopeOf(it.scope, !!target.master.recur, target.occDate, kind, String(it.id));
    const key = `${target.masterId}|${scope}|${target.occDate ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const facts = kind === 'event'
      ? eventFacts(target.master as AgentEvent, world, target.occDate)
      : taskFacts(target.master as Task, world, target.occDate);
    const steps = kind === 'task'
      ? Object.values(world.tasks).filter(t => t && !t.deleted && t.parentId === target.masterId).length
      : 0;
    deletions.push({
      id: String(it.id),
      kind,
      title: facts.title,
      scopeLabel: scopeLabel(scope, target.occDate, !!target.master.recur) + (steps && scope === 'all' ? ` (and its ${steps} step${steps === 1 ? '' : 's'})` : ''),
      when: whenLabel(facts, world.timeFormat),
      repeats: facts.repeats,
    });
    plan.items.push({ id: String(it.id), kind, scope });
  });

  const approval: AgentApproval = { id: (world.newId ?? uuid)(), reason, deletions };
  return {
    pause: { kind: 'approval', approval, plan },
    result: { status: 'waiting_for_user_approval', items: deletions.length },
    label: `Asked to delete ${deletions.length} item${deletions.length === 1 ? '' : 's'}`,
  };
}

/**
 * Perform an approved deletion against the data AS IT IS NOW. Anything that
 * disappeared or changed shape since the preview is reported, not guessed at.
 */
export function applyDeletion(plan: DeletionPlan, world: AgentWorld): ToolOutcome {
  let events: EventData = { ...world.events };
  let tasks: TaskData = { ...world.tasks };
  const entries: ChangeEntry[] = [];
  const results: unknown[] = [];

  for (const item of plan.items) {
    const { masterId, occDate } = parseOccId(item.id);
    const store = item.kind === 'event' ? events : tasks;
    const master = store[masterId] as RecurFields | undefined;
    if (!master || master.deleted) {
      entries.push({ action: 'failed', kind: item.kind, id: masterId, note: 'It was already gone, so nothing was deleted.', verified: true });
      results.push({ id: item.id, status: 'already gone' });
      continue;
    }
    const facts = item.kind === 'event'
      ? eventFacts(master as AgentEvent, world, master.recur ? occDate : null)
      : taskFacts(master as Task, world, master.recur ? occDate : null);
    const occId = master.recur && occDate ? makeOccId(masterId, occDate) : masterId;
    if (item.kind === 'event') events = deleteScoped(events, occId, item.scope, world.weekStartsOn);
    else tasks = deleteTaskScoped(tasks, occId, item.scope);
    entries.push({
      action: 'deleted', kind: item.kind, id: masterId, before: facts,
      note: master.recur ? scopeLabel(item.scope, occDate, true) : undefined,
      verified: false,
    });
    results.push({ id: item.id, title: facts.title, status: 'deleted' });
  }

  const undo = [
    ...diffStores('events', world.events, events),
    ...diffStores('tasks', world.tasks as Record<string, unknown>, tasks as Record<string, unknown>),
  ];
  const deleted = entries.filter(e => e.action === 'deleted').length;
  return {
    events: undo.some(u => u.store === 'events') ? events : undefined,
    tasks: undo.some(u => u.store === 'tasks') ? tasks : undefined,
    entries,
    undo,
    result: { approved: true, deleted, items: results },
    label: `Deleted ${deleted} item${deleted === 1 ? '' : 's'}`,
  };
}

// ─── Focus sessions ─────────────────────────────────────────────────────────

function timePeriod(d: Date): string {
  const h = d.getHours();
  if (h < 6) return 'Night';
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Night';
}

function listFocusSessions(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const from = parseYmdStrict(args.from, 'from');
  const to = parseYmdStrict(args.to, 'to');
  if (to < from) fail('"to" is before "from".');
  if (differenceInCalendarDays(parseDate(to), parseDate(from)) > 366) fail('At most 367 days at a time.');

  const dayStart = world.focusDayStartHour;
  const deduped = dedupeFocusHistory(world.focusSessions);
  const sessions = applyTypedDayTotals(deduped, dayStart)
    .filter(s => {
      if (isTypedDayTotal(s)) return false; // only real sessions
      const day = focusDayKey(s.endedAt ?? s.startedAt, dayStart);
      return day >= from && day <= to;
    })
    .map(s => {
      const day = focusDayKey(s.endedAt ?? s.startedAt, dayStart);
      const started = new Date(s.startedAt);
      const ended = s.endedAt ? new Date(s.endedAt) : null;
      return {
        id: s.id,
        date: day,
        day: format(parseDate(day), 'EEEE'),
        startedAt: s.startedAt,
        startTime: format(started, world.timeFormat === '24h' ? 'HH:mm' : 'h:mm a'),
        endTime: ended ? format(ended, world.timeFormat === '24h' ? 'HH:mm' : 'h:mm a') : null,
        durationMinutes: Math.round(s.durationSeconds / 60),
        plannedMinutes: s.plannedSeconds ? Math.round(s.plannedSeconds / 60) : null,
        period: timePeriod(started),
      };
    });

  return {
    result: { from, to, count: sessions.length, sessions: sessions.slice(0, 200) },
    label: `Checked focus sessions ${dayLabel(from)} to ${dayLabel(to)} (${sessions.length} session${sessions.length === 1 ? '' : 's'})`,
  };
}

function getFocusStats(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const from = parseYmdStrict(args.from, 'from');
  const to = parseYmdStrict(args.to, 'to');
  if (to < from) fail('"to" is before "from".');

  const dayStart = world.focusDayStartHour;
  const summary = summariseFocus(world.focusSessions, {
    from, to, dayStartHour: dayStart, excludedDates: world.focusExcludedDates,
  });
  const allTimeStreaks = computeAllTimeStreaks(world.focusSessions, {
    anchorDate: world.now, dayStartHour: dayStart, excludedDates: world.focusExcludedDates,
  });

  // Timer state
  let timerInfo: Record<string, unknown> = { status: 'no timer' };
  if (world.focusTimer) {
    const t = world.focusTimer;
    if (t.isRunning && t.lastStartedAt) {
      const elapsed = focusElapsedSeconds(t, world.now.getTime());
      const remaining = Math.max(0, t.plannedSeconds - elapsed);
      timerInfo = {
        status: 'running',
        elapsedMinutes: Math.round(elapsed / 60),
        remainingMinutes: Math.round(remaining / 60),
        plannedMinutes: Math.round(t.plannedSeconds / 60),
      };
    } else if (t.sessionStartedAt) {
      timerInfo = {
        status: 'paused',
        accumulatedMinutes: Math.round(t.accumulatedSeconds / 60),
        plannedMinutes: Math.round(t.plannedSeconds / 60),
      };
    } else {
      timerInfo = { status: 'idle', plannedMinutes: Math.round(t.plannedSeconds / 60) };
    }
  }

  const result: Record<string, unknown> = {
    range: { from, to },
    totalHours: +(summary.totalSeconds / 3600).toFixed(1),
    sessions: summary.sessions,
    averageMinutesPerDay: Math.round(summary.averageSeconds / 60),
    bestDay: summary.bestDay ? {
      date: summary.bestDay.date,
      day: format(parseDate(summary.bestDay.date), 'EEEE'),
      hours: +(summary.bestDay.seconds / 3600).toFixed(1),
    } : null,
    streakInRange: summary.streak,
    allTimeCurrentStreak: allTimeStreaks.currentStreak,
    allTimeLongestStreak: allTimeStreaks.longestStreak,
    timer: timerInfo,
  };
  if (world.focusDailyGoalSeconds > 0) {
    result.dailyGoalMinutes = Math.round(world.focusDailyGoalSeconds / 60);
  }

  return {
    result,
    label: `Checked focus stats ${dayLabel(from)} to ${dayLabel(to)}`,
  };
}

function prepareFocusDeletion(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!Array.isArray(args.sessionIds) || !args.sessionIds.length)
    fail('sessionIds must be a non-empty list of focus session ids.');
  if ((args.sessionIds as unknown[]).length > 50)
    fail('At most 50 deletions per request.');
  const reason = typeof args.reason === 'string' && args.reason.trim()
    ? args.reason.trim() : 'Delete these focus sessions';

  const dayStart = world.focusDayStartHour;
  const deduped = dedupeFocusHistory(world.focusSessions);
  const byId = new Map(deduped.map(s => [s.id, s]));
  const deletions: PendingDeletion[] = [];
  const plan: DeletionPlan = { items: [], focusSessionIds: [] };

  for (const rawId of args.sessionIds as unknown[]) {
    const id = String(rawId);
    const session = byId.get(id);
    if (!session) return fail(`No focus session with id "${id}". Use list_focus_sessions to get current ids.`);
    const day = focusDayKey(session.endedAt ?? session.startedAt, dayStart);
    const started = new Date(session.startedAt);
    const ended = session.endedAt ? new Date(session.endedAt) : null;
    const mins = Math.round(session.durationSeconds / 60);
    const tf = world.timeFormat === '24h' ? 'HH:mm' : 'h:mm a';

    deletions.push({
      id,
      kind: 'focus_session',
      title: `${mins}-minute focus session`,
      scopeLabel: 'This session',
      when: `${dayLabel(day)}, ${format(started, tf)}${ended ? ` to ${format(ended, tf)}` : ''}`,
    });
    plan.focusSessionIds!.push(id);
  }

  const approval: AgentApproval = {
    id: (world.newId ?? uuid)(),
    reason,
    deletions,
  };
  return {
    pause: { kind: 'approval', approval, plan },
    result: { status: 'waiting_for_user_approval', items: deletions.length },
    label: `Asked to delete ${deletions.length} focus session${deletions.length === 1 ? '' : 's'}`,
  };
}

/**
 * Perform an approved focus session deletion against the data AS IT IS NOW.
 */
export function applyFocusDeletion(
  sessionIds: string[],
  focusSessions: FocusSessionRecord[],
  world: AgentWorld,
): { sessions: FocusSessionRecord[]; deleted: number; entries: ChangeEntry[] } {
  const toDelete = new Set(sessionIds);
  const entries: ChangeEntry[] = [];
  const kept: FocusSessionRecord[] = [];
  const dayStart = world.focusDayStartHour;
  const tf = world.timeFormat === '24h' ? 'HH:mm' : 'h:mm a';

  for (const s of focusSessions) {
    if (toDelete.has(s.id)) {
      const day = focusDayKey(s.endedAt ?? s.startedAt, dayStart);
      entries.push({
        action: 'deleted',
        kind: 'focus_session',
        id: s.id,
        before: {
          title: `${Math.round(s.durationSeconds / 60)}-minute focus session`,
          kind: 'focus_session',
          date: day,
          startTime: format(new Date(s.startedAt), tf),
          endTime: s.endedAt ? format(new Date(s.endedAt), tf) : undefined,
        },
        verified: true,
      });
      toDelete.delete(s.id);
    } else {
      kept.push(s);
    }
  }

  // Any ids that weren't found
  for (const id of toDelete) {
    entries.push({
      action: 'failed',
      kind: 'focus_session',
      id,
      note: 'Session was already gone.',
      verified: true,
    });
  }

  return { sessions: kept, deleted: entries.filter(e => e.action === 'deleted').length, entries };
}

// ─── Questions ───────────────────────────────────────────────────────────────

// A WHOLE label that only means "something not listed", e.g. "Other",
// "Other (please specify)", "Something else." ("Other office" is a real option.)
const OTHER_LABEL = /^(other|others|something else|none of (these|the above)|custom|type (my|your) own( answer)?)(\s*\([^)]*\))?\s*[.:]?$/i;

function askUser(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const raw = Array.isArray(args.questions) ? args.questions
    // Forgiving: a single question passed at the top level.
    : typeof args.question === 'string' ? [args] : null;
  if (!raw || !raw.length) fail('questions must be a list of 1 to 4 questions.');
  if (raw!.length > 4) fail('Ask at most 4 questions at once.');
  const questions: AgentQuestion[] = raw!.map((q, i) => {
    if (!isRecord(q)) fail(`questions[${i}] must be an object.`);
    const r = q as Record<string, unknown>;
    const text = typeof r.question === 'string' ? r.question.trim() : '';
    if (!text) fail(`questions[${i}].question is required.`);
    if (!Array.isArray(r.options) || r.options.length < 2) fail(`questions[${i}] needs 2 to 4 options.`);
    const parsed = (r.options as unknown[]).map((o, j) => {
      if (typeof o === 'string') return { label: o.trim() };
      if (!isRecord(o) || typeof o.label !== 'string' || !o.label.trim()) fail(`questions[${i}].options[${j}] needs a label.`);
      const opt = o as Record<string, unknown>;
      return {
        label: String(opt.label).trim(),
        ...(typeof opt.description === 'string' && opt.description.trim() ? { description: opt.description.trim() } : {}),
      };
    });
    // The card always has its own "type your own answer" box, so an "Other"
    // option from the model would be a second, dead way to say the same thing.
    // Duplicate labels would make two buttons that mean one choice.
    const seenLabels = new Set<string>();
    const options = parsed.filter(o => {
      const key = o.label.toLowerCase();
      if (!o.label || OTHER_LABEL.test(o.label) || seenLabels.has(key)) return false;
      seenLabels.add(key);
      return true;
    }).slice(0, 4);
    if (!options.length) fail(`questions[${i}] has no real options (an "Other" choice is added by the app itself).`);
    const header = typeof r.header === 'string' && r.header.trim() ? r.header.trim().slice(0, 16) : `Question ${i + 1}`;
    return {
      id: (world.newId ?? uuid)(),
      header,
      question: text,
      options,
      multiSelect: r.multiSelect === true,
      allowOther: true,
    };
  });
  return {
    pause: { kind: 'question', questions },
    result: { status: 'waiting_for_user' },
    label: `Asked you ${questions.length === 1 ? 'a question' : `${questions.length} questions`}`,
  };
}

/** The tool result the model receives once the user has answered. */
export function answersToResult(questions: AgentQuestion[], answers: Array<{ questionId: string; selected: string[]; other?: string }>): unknown {
  return {
    answers: questions.map(q => {
      const a = answers.find(x => x.questionId === q.id);
      const parts = [...(a?.selected ?? [])];
      if (a?.other?.trim()) parts.push(a.other.trim());
      return { question: q.question, answer: parts.length ? parts.join('; ') : '(no answer)' };
    }),
  };
}

// ─── Undo ────────────────────────────────────────────────────────────────────

/**
 * Fields the SYNC layers write onto a record after the agent saved it: the
 * Google Calendar / Google Tasks link and the bookkeeping around it, plus the
 * timestamp every writer bumps. None of them is something the user changed,
 * so none of them may make an item look "edited since".
 */
const SYNC_IDENTITY = ['gCalId', 'gCalCalendarId', 'gCalETag', 'gCalRecurSig', 'gCalHex', 'gTaskId', 'gTaskListId', 'gTaskETag', 'gTaskSeriesDate', 'gTaskParentId', 'lastSyncedAt'] as const;
const IGNORED_FOR_COMPARE = new Set<string>([...SYNC_IDENTITY, 'updatedAt']);

/**
 * A record's meaning, for "is it still what we left?". Empty values are
 * dropped because the sync layer writes them differently from the app: it
 * rebuilds a set field that was ABSENT as `[]` (seen in testing on `exdates`),
 * and `false` / `null` / `''` mean the same as a missing key everywhere in
 * the planner. Comparing them literally made an untouched item look edited.
 */
function content(r: Record<string, unknown> | null): string {
  if (!r) return 'null';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (IGNORED_FOR_COMPARE.has(k)) continue;
    if (v === undefined || v === null || v === false || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return stable(out);
}

/** A tombstone (kept only so a delete can reach Google) counts as gone. */
function live(r: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!r || (r as { deleted?: boolean }).deleted) return null;
  return r;
}

function identityOf(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SYNC_IDENTITY) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

function withoutIdentity(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!(SYNC_IDENTITY as readonly string[]).includes(k)) out[k] = v;
  return out;
}

/**
 * Put back what a change set changed, record by record, but ONLY where the
 * item still reads exactly as the change left it. An item the user edited
 * since is left alone and reported: undoing their newer edit would be a
 * second, silent change nobody asked for.
 *
 * "Reads exactly" ignores the sync layers' bookkeeping: the PC pushes new
 * events to Google within minutes and stamps a Google id onto them, and that
 * must not turn an untouched item into an "edited" one (it did, in testing:
 * Undo then left a test item behind).
 *
 * And the Google link is KEPT through an undo, so Google follows along:
 *   - undoing an add of an item that already reached Google tombstones it
 *     (deleted: true), which is what makes the next sync delete it there too;
 *     removing it outright would orphan it in Google, and the next pull would
 *     bring it straight back;
 *   - undoing an edit restores the old content onto the linked record with a
 *     fresh updatedAt, so the next sync pushes the old content to Google;
 *   - undoing a delete whose Google copy is already gone restores the item
 *     without the dead link, so the next sync creates it in Google again.
 */
export function planUndo(
  records: UndoRecord[],
  events: EventData,
  tasks: TaskData,
  now = Date.now(),
): { events: EventData; tasks: TaskData; restored: number; skipped: Array<{ id: string; store: string }> } {
  const ev = { ...events } as Record<string, Record<string, unknown>>;
  const tk = { ...tasks } as unknown as Record<string, Record<string, unknown>>;
  let restored = 0;
  const skipped: Array<{ id: string; store: string }> = [];
  for (const r of records) {
    const store = r.store === 'events' ? ev : tk;
    const current = store[r.id] ?? null;
    if (content(live(current)) !== content(live(r.after))) {
      skipped.push({ id: r.id, store: r.store });
      continue;
    }
    const before = live(r.before);
    if (before) {
      store[r.id] = current
        ? { ...withoutIdentity(before), ...identityOf(current), deleted: false, updatedAt: now }
        : { ...withoutIdentity(before), deleted: false, updatedAt: now };
    } else if (current && (current.gCalId || current.gTaskId)) {
      store[r.id] = { ...current, deleted: true, updatedAt: now };
    } else {
      delete store[r.id];
    }
    restored++;
  }
  return { events: ev as unknown as EventData, tasks: tk as unknown as TaskData, restored, skipped };
}

/** Did the record the change meant to write actually land on disk as written? */
export function verifyAgainst(records: UndoRecord[], events: EventData, tasks: TaskData): Set<string> {
  const ok = new Set<string>();
  for (const r of records) {
    const store = (r.store === 'events' ? events : tasks) as unknown as Record<string, Record<string, unknown>>;
    const cur = store[r.id] ?? null;
    // Content must match; bookkeeping the sync layers add may differ, and a
    // tombstone reads as gone, exactly as the user sees it.
    if (content(live(cur)) === content(live(r.after))) ok.add(`${r.store}:${r.id}`);
  }
  return ok;
}
