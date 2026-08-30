// ─── The day, as the phone shows it ──────────────────────────────────────────
// Turns the synced stores into one ordered list for a single date: all-day items
// first, then timed items in clock order, then dated tasks, then anything
// undated the user asked to see.
//
// This is pure. The screen renders exactly what comes out of here and makes no
// decisions of its own, so what appears on a given day is settled by tests
// rather than by whichever component happened to filter last.
//
// SORTING IS PART OF THE PRODUCT
// Two items at 09:00 must not swap places between renders — a list that
// reshuffles while you look at it feels broken. Every comparison therefore ends
// in a tiebreak on id, so the order is total and stable.

import { occurrenceStarts, parseDate, type RecurFields, type WeekStartsOn } from './recurrence';
import { resolveEventColor, type EventCategory } from './categories';

export type AgendaKind = 'allDay' | 'timed' | 'task' | 'prayer';

export type AgendaStore = 'events' | 'tasks';

export interface AgendaItem {
  /** Occurrence id: `masterId::date` for a repeat, or the plain id. */
  id: string;
  masterId: string;
  /** Which store it came from. Completion is recorded differently in each, so
   *  this is not cosmetic — see `isDone`. */
  store: AgendaStore;
  /** False for events the user marked as having no checkbox. */
  checkable: boolean;
  kind: AgendaKind;
  title: string;
  /** Minutes from midnight, or null for an all-day item. */
  startMin: number | null;
  endMin: number | null;
  date: string;
  categoryId?: string;
  colour?: string;
  completed: boolean;
  /** True when this is one occurrence of a repeating item. */
  repeating: boolean;
  notes?: string;
}

export interface AgendaDay {
  date: string;
  allDay: AgendaItem[];
  timed: AgendaItem[];
  tasks: AgendaItem[];
  /** Everything in one list, in the order the screen paints it. */
  all: AgendaItem[];
  counts: { total: number; done: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const ymd = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** "18:30" → 1110. Anything unparseable is null rather than 0, which would
 *  silently sort a broken item to the top of the day. */
export function minutesOf(time: unknown): number | null {
  if (typeof time !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A clock time in the user's own format.
 *
 * `timeFormat` is a shared setting — one answer for the whole planner — so a
 * phone showing 24h while the PC shows 12h is simply the phone ignoring it.
 * Kept separate from `formatMinutes` rather than replacing it, because the
 * 24-hour form is also what gets stored and compared, and those must not start
 * depending on a display preference.
 */
export function formatClock(min: number | null, timeFormat: string | undefined): string {
  if (min === null) return '';
  if (timeFormat !== '12h') return formatMinutes(min);

  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const suffix = h24 < 12 ? 'am' : 'pm';
  // Midnight and midday are 12, not 0 — the mistake that makes a planner show
  // "0:30am" and look broken at exactly the hour someone is checking it.
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

export function formatMinutes(min: number | null): string {
  if (min === null) return '';
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Does this stored record occur on `date`? Returns the occurrence date if so. */
export function occursOn(record: RecurFields, date: string, weekStartsOn: WeekStartsOn = 0): boolean {
  const anchorWeek = record.weekKey;
  if (!anchorWeek) return false;

  const target = parseDate(date);
  if (Number.isNaN(target.getTime())) return false;

  if (!record.recur) {
    const start = new Date(parseDate(anchorWeek).getTime() + (record.dayIndex ?? 0) * DAY_MS);
    const span = Math.max(1, record.daysSpan ?? 1);
    const end = new Date(start.getTime() + span * DAY_MS);
    return target >= startOfDay(start) && target < startOfDay(end);
  }

  // A repeat: ask the shared expansion for this one day, so the phone and the PC
  // can never disagree about whether Tuesday is included.
  const dayEnd = new Date(target.getTime() + DAY_MS);
  const starts = occurrenceStarts(record, target, dayEnd, weekStartsOn);
  return starts.length > 0;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean => v === true;

function toItem(
  id: string,
  raw: Record<string, unknown>,
  date: string,
  kind: AgendaKind,
  store: AgendaStore,
  categories?: EventCategory[],
): AgendaItem {
  const repeating = Boolean(raw.recur);
  const startMin = bool(raw.allDay) ? null : minutesOf(raw.startTime);
  const endMin = bool(raw.allDay) ? null : minutesOf(raw.endTime);

  return {
    id: repeating ? `${id}::${date}` : id,
    masterId: id,
    store,
    // `noCheckbox` events are reference points, not things to tick off. Offering
    // a checkbox the PC does not show would write state nothing ever reads.
    checkable: store === 'tasks' || !bool(raw.noCheckbox),
    kind: bool(raw.allDay) ? 'allDay' : kind,
    title: titleOf(raw),
    startMin,
    endMin,
    date,
    categoryId: str(raw.categoryId),
    colour: colourOf(raw, categories),
    completed: isDone(raw, date, store),
    repeating,
    notes: str(raw.notes),
  };
}

/**
 * The item's name.
 *
 * Calendar events store it in `content`; tasks store it in `title`. This looked
 * like one field for far too long and every event on the phone read "Untitled".
 * Both are checked, in that order, and an item with neither is labelled rather
 * than rendered blank.
 */
export function titleOf(raw: Record<string, unknown>): string {
  const content = str(raw.content)?.trim();
  if (content) return content;
  const title = str(raw.title)?.trim();
  if (title) return title;
  return 'Untitled';
}

/**
 * The colour to paint the item's edge.
 *
 * `color` holds a SWATCH NAME ('peach', 'lilac'), not a hex value — handing it
 * straight to a stylesheet paints nothing. Google-synced events also carry
 * `gCalHex`, and a category can override both.
 */
export function colourOf(
  raw: Record<string, unknown>,
  categories?: EventCategory[],
): string | undefined {
  const resolved = resolveEventColor(
    {
      color: str(raw.color),
      categoryId: str(raw.categoryId),
      gCalHex: str(raw.gCalHex),
    },
    categories,
  );
  return resolved || undefined;
}

/**
 * Is this occurrence ticked off?
 *
 * The two stores genuinely differ, and getting it wrong is SILENT:
 *
 *   EVENTS always record completion per DATE in `completedDates`, whether or not
 *   they repeat. That is what the PC writes and the only thing it reads back.
 *   Writing a `completed` flag on an event looks like it worked on the phone and
 *   then does nothing at all on the PC — which is exactly what happened.
 *
 *   TASKS use `completedDates` when repeating and a plain `completed` flag
 *   otherwise, matching how Google Tasks models them.
 */
export function isDone(
  raw: Record<string, unknown>,
  date: string,
  store: AgendaStore = 'events',
): boolean {
  const perDate = Array.isArray(raw.completedDates)
    && (raw.completedDates as unknown[]).includes(date);
  if (store === 'events') return perDate;
  if (raw.recur) return perDate;
  return bool(raw.completed) || perDate;
}

/**
 * Total, stable ordering.
 *
 * All-day items sit above timed ones because they frame the day; a timed item
 * with an unreadable time sorts to the end rather than to midnight, so a broken
 * record is visible instead of quietly leading the list.
 */
export function compareItems(a: AgendaItem, b: AgendaItem): number {
  const rank = (i: AgendaItem) => (i.kind === 'allDay' ? 0 : i.kind === 'task' && i.startMin === null ? 2 : 1);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;

  const sa = a.startMin ?? Number.POSITIVE_INFINITY;
  const sb = b.startMin ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa - sb;

  const ea = a.endMin ?? Number.POSITIVE_INFINITY;
  const eb = b.endMin ?? Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea - eb;

  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildDayInput {
  events: Record<string, Record<string, unknown>>;
  tasks: Record<string, Record<string, unknown>>;
  date: string;
  weekStartsOn?: WeekStartsOn;
  /** Show tasks that have no date at all, alongside the day. */
  includeUndatedTasks?: boolean;
  /** Used to resolve an item's colour; a category overrides the item's own. */
  categories?: EventCategory[];
}

/**
 * How many items fall on each day of a range, in ONE pass.
 *
 * WHY THIS EXISTS. The month and year views were asking `buildDay` per cell:
 * forty-two calls for a month, three hundred and sixty-five for a year, each one
 * walking every event in the planner and expanding its recurrence. That is a
 * hundred thousand recurrence expansions to draw a grid of squares, and it was
 * plainly visible as a delay when opening either view.
 *
 * This walks the events ONCE and expands each into the range, which is the same
 * work the day view already does but not repeated per cell. Counts only: a cell
 * that small has nothing to draw but a number and a tint.
 */
export function countsForRange(
  events: Record<string, Record<string, unknown>> | undefined,
  from: string,
  to: string,
  weekStartsOn: WeekStartsOn = 0,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!events) return out;

  const start = parseDate(from);
  const end = parseDate(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;

  // The range as a half-open window for the expansion, which takes an exclusive
  // end. Asking a repeat for all its occurrences ONCE is the whole point: the
  // obvious version calls `occursOn` per event per date, which for a year is
  // sixty thousand recurrence expansions to count some squares.
  const rangeEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);

  for (const id of Object.keys(events)) {
    const raw = events[id];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.deleted === true) continue;
    const rec = raw as unknown as RecurFields;

    if (!rec.recur) {
      // A one-off touches at most `daysSpan` days, so there is no need to ask
      // about every date in the range.
      if (!rec.weekKey) continue;
      const first = new Date(parseDate(rec.weekKey).getTime() + (rec.dayIndex ?? 0) * DAY_MS);
      const span = Math.max(1, rec.daysSpan ?? 1);
      for (let i = 0; i < span; i += 1) {
        const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
        const key = ymd(d);
        if (key < from || key > to) continue;
        out[key] = (out[key] ?? 0) + 1;
      }
      continue;
    }

    for (const at of occurrenceStarts(rec, start, rangeEnd, weekStartsOn)) {
      const key = ymd(at);
      if (key < from || key > to) continue;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

export function buildDay(input: BuildDayInput): AgendaDay {
  const { events, tasks, date, weekStartsOn = 0, includeUndatedTasks = false, categories } = input;

  const allDay: AgendaItem[] = [];
  const timed: AgendaItem[] = [];
  const taskItems: AgendaItem[] = [];

  for (const id of Object.keys(events ?? {})) {
    const raw = events[id];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.deleted === true) continue;
    if (!occursOn(raw as unknown as RecurFields, date, weekStartsOn)) continue;
    const item = toItem(id, raw, date, 'timed', 'events', categories);
    (item.kind === 'allDay' ? allDay : timed).push(item);
  }

  for (const id of Object.keys(tasks ?? {})) {
    const raw = tasks[id];
    if (!raw || typeof raw !== 'object') continue;
    if (raw.deleted === true) continue;

    const undated = !raw.weekKey;
    if (undated) {
      if (!includeUndatedTasks) continue;
      taskItems.push(toItem(id, raw, date, 'task', 'tasks', categories));
      continue;
    }
    if (!occursOn(raw as unknown as RecurFields, date, weekStartsOn)) continue;

    const item = toItem(id, raw, date, 'task', 'tasks', categories);
    // A task with a time is drawn in the day column like an event; one without
    // sits in the task strip. That is the PC's rule, kept identical here.
    if (item.kind === 'allDay' || item.startMin === null) taskItems.push(item);
    else timed.push(item);
  }

  allDay.sort(compareItems);
  timed.sort(compareItems);
  taskItems.sort(compareItems);

  const all = [...allDay, ...timed, ...taskItems];
  return {
    date,
    allDay,
    timed,
    tasks: taskItems,
    all,
    counts: { total: all.length, done: all.filter(i => i.completed).length },
  };
}

/** The item happening right now, if any — used to anchor the timeline. */
export function currentItem(day: AgendaDay, nowMin: number): AgendaItem | null {
  for (const item of day.timed) {
    if (item.startMin === null) continue;
    const end = item.endMin ?? item.startMin + 30;
    if (nowMin >= item.startMin && nowMin < end) return item;
  }
  return null;
}

/** The next thing due today, for the header line. */
export function nextItem(day: AgendaDay, nowMin: number): AgendaItem | null {
  for (const item of day.timed) {
    if (item.startMin !== null && item.startMin >= nowMin && !item.completed) return item;
  }
  return null;
}

/** A short, human summary of a day, for the day strip. */
export function summariseDay(day: AgendaDay): string {
  if (day.counts.total === 0) return 'Nothing planned';
  const remaining = day.counts.total - day.counts.done;
  if (remaining === 0) return 'All done';
  return remaining === 1 ? '1 left' : `${remaining} left`;
}

/** The seven dates around `date`, for the swipeable strip. */
export function daysAround(date: string, before: number, after: number): string[] {
  const base = parseDate(date);
  const out: string[] = [];
  for (let i = -before; i <= after; i++) {
    out.push(ymd(new Date(base.getTime() + i * DAY_MS)));
  }
  return out;
}

export function addDays(date: string, delta: number): string {
  return ymd(new Date(parseDate(date).getTime() + delta * DAY_MS));
}

export function isToday(date: string, now: Date): boolean {
  return date === ymd(now);
}

/** "Today", "Tomorrow", "Yesterday", else "Wed 2 Sep". */
export function dayLabel(date: string, now: Date): string {
  const today = ymd(now);
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  if (date === addDays(today, -1)) return 'Yesterday';
  const d = parseDate(date);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${weekday} ${d.getDate()} ${month}`;
}
