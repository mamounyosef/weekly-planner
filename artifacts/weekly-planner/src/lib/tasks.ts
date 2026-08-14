import { addDays, differenceInDays, format, startOfWeek } from 'date-fns';
import {
  editSeries,
  makeOccId,
  occurrenceStarts,
  parseOccId,
  resolveWeek,
  weekKeyOf,
  type DeleteMode,
  type RecurFields,
  type WeekStartsOn,
} from './recurrence';

// ─── Tasks ───────────────────────────────────────────────────────────────────
// A task is a separate entity from a calendar event, stored in its own file
// (`database/tasks.json`) and synced to GOOGLE TASKS (not Google Calendar).
// Keeping the two stores apart is deliberate: the calendar sync engine pushes
// everything it is handed to the "Daily calendar", so a task sharing that map
// would leak onto the calendar the moment one guard is missed.
//
// Scheduling is expressed ONLY through the RecurFields anchor, exactly like
// PlannerEvent, so recurrence.ts works on tasks unmodified:
//
//   weekKey == null                     → GENERAL (panel only, never on the grid)
//   weekKey != null, startTime == null  → DATED   (task row under All Day)
//   weekKey != null, startTime != null  → TIMED   (drawn in the day column)
//
// There is deliberately no separate `dueDate` field — two representations of one
// date is how the calendar's weekKey/dayIndex drift bugs happened. Read it with
// `dueDateOf`, write it with `withDueDate`.

export interface Task extends RecurFields {
  id: string;
  title: string;
  notes?: string;            // the user's text ONLY — the ⏰ marker never lives here
  parentId?: string;         // subtask → parent task id (one level deep)
  listId?: string;           // which task list it lives on; unset = General
  order?: number;            // manual sort key within its section / siblings

  completed?: boolean;       // non-repeating tasks
  completedDates?: string[]; // repeating: 'yyyy-MM-dd' occurrences done
  completedAt?: number;

  // Optional. Panel-only tasks have no colour by default; tasks drawn on the grid
  // always paint with `settings.taskColor` regardless of this.
  color?: string;

  // ── Google Tasks identity (never gCal*) ────────────────────────────────────
  gTaskId?: string;
  gTaskListId?: string;
  gTaskETag?: string;
  // Repeating master: which occurrence date the ONE live Google task currently
  // represents. Absent = no live Google task. This single field is the whole
  // roll-forward state, and it is written last (after every Google call has
  // succeeded), which is what makes a crash mid-sync re-derive correctly.
  gTaskSeriesDate?: string;
  gTaskParentId?: string;
  seriesDone?: boolean;      // series exhausted (UNTIL / COUNT ran out)
}

export type TaskData = Record<string, Task>;

export const TASKS_STORAGE_KEY = 'planner-tasks-v1';

// ─── Dates ───────────────────────────────────────────────────────────────────

const parseYmd = (d: string): Date => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, (m || 1) - 1, day || 1);
};
export const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');
export const todayYmd = (): string => ymd(new Date());

// ─── Kind ────────────────────────────────────────────────────────────────────

export type TaskKind = 'general' | 'dated' | 'timed';

export function taskKind(t: Task): TaskKind {
  if (!t.weekKey) return 'general';
  return t.startTime ? 'timed' : 'dated';
}

/** The concrete due date of a task (or of one expanded occurrence). */
export function dueDateOf(t: Task): string | null {
  if (t.occDate && t.recur) return t.occDate;
  if (!t.weekKey) return null;
  return ymd(addDays(parseYmd(t.weekKey), t.dayIndex ?? 0));
}

/** Set (or clear, with `null`) the due date. Clearing makes the task general. */
export function withDueDate(t: Task, date: string | null, weekStartsOn: WeekStartsOn): Task {
  if (!date) {
    return { ...t, weekKey: undefined, dayIndex: undefined, startTime: undefined, endTime: undefined, recur: undefined, occDate: undefined, updatedAt: Date.now() };
  }
  const d = parseYmd(date);
  return {
    ...t,
    weekKey: weekKeyOf(d, weekStartsOn),
    dayIndex: differenceInDays(d, startOfWeek(d, { weekStartsOn })),
    occDate: undefined,
    updatedAt: Date.now(),
  };
}

/** Set (or clear, with `null`) the time of day. Default duration is 30 minutes. */
export function withTime(t: Task, startTime: string | null, durationMin = 30): Task {
  if (!startTime) return { ...t, startTime: undefined, endTime: undefined, updatedAt: Date.now() };
  return { ...t, startTime, endTime: t.endTime ?? addMinutesToTime(startTime, durationMin), updatedAt: Date.now() };
}

export function addMinutesToTime(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.max(0, Math.min(24 * 60 - 1, (h || 0) * 60 + (m || 0) + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ─── Week resolution ─────────────────────────────────────────────────────────

/**
 * Expand the tasks visible in one week. General tasks are filtered out FIRST —
 * they have no anchor, and `resolveWeek` would otherwise resolve them against
 * the year-0 sentinel.
 */
export function resolveWeekTasks(raw: TaskData, viewedWeekKey: string, range?: { from: number; to: number }): TaskData {
  const scheduled: TaskData = {};
  for (const t of Object.values(raw)) {
    if (!t.weekKey || t.deleted) continue;
    scheduled[t.id] = t;
  }
  return resolveWeek<Task>(scheduled, viewedWeekKey, range);
}

/**
 * Every occurrence of one task between two dates, as `{ occId, occDate }`.
 * Non-repeating tasks yield at most one entry; general tasks yield none.
 * This is the panel's expansion — the grid uses `resolveWeekTasks` instead
 * because it needs the per-week `dayIndex` remapping.
 */
export function expandTaskRange(t: Task, fromYmd: string, toYmd: string): Array<{ occId: string; occDate: string }> {
  if (!t.weekKey || t.deleted) return [];
  const from = parseYmd(fromYmd);
  const to = parseYmd(toYmd);
  if (!t.recur) {
    const d = dueDateOf(t);
    return d && d >= fromYmd && d <= toYmd ? [{ occId: t.id, occDate: d }] : [];
  }
  return occurrenceStarts(t, from, addDays(to, 1)).map(d => {
    const occDate = ymd(d);
    return { occId: makeOccId(t.id, occDate), occDate };
  });
}

// ─── Completion ──────────────────────────────────────────────────────────────

export function isTaskDone(t: Task, occDate?: string | null): boolean {
  if (t.recur) {
    const d = occDate ?? t.occDate ?? null;
    return !!d && !!t.completedDates?.includes(d);
  }
  return !!t.completed;
}

/**
 * Flip the done state of the occurrence shown as `occId`. Repeating tasks record
 * completion per occurrence date; one-off tasks use the boolean.
 */
export function toggleTaskDone(raw: TaskData, occId: string): TaskData {
  const { masterId, occDate } = parseOccId(occId);
  const master = raw[masterId];
  if (!master) return raw;
  const now = Date.now();

  if (master.recur) {
    const date = occDate ?? dueDateOf(master);
    if (!date) return raw;
    const done = master.completedDates ?? [];
    const next = done.includes(date) ? done.filter(d => d !== date) : [...done, date].sort();
    return { ...raw, [masterId]: { ...master, completedDates: next, completedAt: now, updatedAt: now } };
  }

  const completed = !master.completed;
  return { ...raw, [masterId]: { ...master, completed, completedAt: completed ? now : undefined, updatedAt: now } };
}

// ─── Occurrence scanning (shared by the client and the sync engine) ──────────

export const ROLL_HORIZON_DAYS = 400;

/**
 * The first occurrence of a repeating master on or after `fromYmd` that has NOT
 * already been completed. `occurrenceStarts` already honours interval, weekly
 * BYDAY, UNTIL/COUNT and exdates, so this only has to skip completed dates.
 * Returns null when the series is exhausted.
 */
export function nextOpenOccurrence(m: Task, fromYmd: string, horizonDays = ROLL_HORIZON_DAYS): string | null {
  const from = parseYmd(fromYmd);
  const done = new Set(m.completedDates ?? []);
  for (const d of occurrenceStarts(m, from, addDays(from, horizonDays))) {
    const date = ymd(d);
    if (!done.has(date)) return date;
  }
  return null;
}

// ─── Google Tasks notes ⇄ time marker ────────────────────────────────────────
// The Google Tasks API discards the time portion of `due` ("It isn't possible to
// read or write the time that a task is scheduled for using the API"), so the
// time of day travels as a readable marker line inside `notes`. It is written at
// the top, but parsed from ANYWHERE in the text so a hand-typed line on the phone
// still works.

export const TIME_MARKER_RE =
  /^[ \t]*⏰[ \t]*(\d{1,2}):(\d{2})[ \t]*(am|pm)?(?:[ \t]*[-–—][ \t]*(\d{1,2}):(\d{2})[ \t]*(am|pm)?)?[ \t]*$/i;

function to24h(h: number, m: number, suffix?: string): string | null {
  let hh = h;
  const s = suffix?.toLowerCase();
  if (s === 'pm' && hh < 12) hh += 12;
  else if (s === 'am' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23 || m < 0 || m > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Split a Google task's notes into its time marker and the user's own text.
 * The marker line (plus one adjacent blank line) is removed from the body so it
 * never accumulates across round-trips.
 */
export function parseTaskNotes(notes: string | undefined | null): { startTime: string | null; endTime: string | null; body: string } {
  if (!notes) return { startTime: null, endTime: null, body: '' };
  const lines = notes.split(/\r?\n/);
  let startTime: string | null = null;
  let endTime: string | null = null;
  let markerAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = TIME_MARKER_RE.exec(lines[i]);
    if (!m) continue;
    const s = to24h(Number(m[1]), Number(m[2]), m[3]);
    if (!s) continue;
    startTime = s;
    endTime = m[4] != null ? to24h(Number(m[4]), Number(m[5]), m[6]) : null;
    markerAt = i;
    break;
  }

  if (markerAt === -1) return { startTime: null, endTime: null, body: notes.trim() };

  lines.splice(markerAt, 1);
  // Collapse the blank line the marker left behind (whichever side it sat on).
  if (lines[markerAt] != null && lines[markerAt].trim() === '') lines.splice(markerAt, 1);
  else if (markerAt > 0 && lines[markerAt - 1]?.trim() === '') lines.splice(markerAt - 1, 1);

  return { startTime, endTime, body: lines.join('\n').trim() };
}

/** Re-emit notes for Google: a canonical marker line, then the user's text. */
export function composeTaskNotes(t: Pick<Task, 'startTime' | 'endTime' | 'notes'>): string {
  const body = (t.notes ?? '').trim();
  if (!t.startTime) return body;
  const marker = t.endTime && t.endTime !== t.startTime
    ? `⏰ ${t.startTime}–${t.endTime}`
    : `⏰ ${t.startTime}`;
  return body ? `${marker}\n\n${body}` : marker;
}

// ─── Panel filters ───────────────────────────────────────────────────────────

export type TaskFilter = 'today' | 'overdue' | 'upcoming' | 'general' | 'completed';

// Canonical order. `taskFilters` must always be stored in this order — the
// settings echo guard stringifies arrays without sorting them, so two equivalent
// selections in different orders would make the pages fight each other.
export const ALL_TASK_FILTERS: TaskFilter[] = ['today', 'overdue', 'upcoming', 'general', 'completed'];

export const TASK_FILTER_LABELS: Record<TaskFilter, string> = {
  today: 'Today',
  overdue: 'Overdue',
  upcoming: 'Upcoming',
  general: 'General',
  completed: 'Completed',
};

export function canonicalFilters(f: readonly string[]): TaskFilter[] {
  return ALL_TASK_FILTERS.filter(x => f.includes(x));
}

/** Which buckets a task falls into. A task is in exactly one temporal bucket. */
export function taskBucket(t: Task, occDate: string | null, today: string): Exclude<TaskFilter, 'completed'> {
  const due = occDate ?? dueDateOf(t);
  if (!due) return 'general';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

/** An empty filter selection means "show everything". Selections OR together. */
export function matchesFilters(t: Task, occDate: string | null, filters: readonly TaskFilter[], today: string): boolean {
  const done = isTaskDone(t, occDate);
  if (!filters.length) return true;
  if (done) return filters.includes('completed');
  return filters.some(f => f !== 'completed' && f === taskBucket(t, occDate, today));
}

// ─── Subtask tree ────────────────────────────────────────────────────────────

export function buildTaskTree(tasks: Task[]): Array<{ task: Task; children: Task[] }> {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const children = new Map<string, Task[]>();
  const roots: Task[] = [];

  for (const t of tasks) {
    // A subtask whose parent isn't in this slice is promoted to a root rather
    // than silently disappearing.
    if (t.parentId && byId.has(t.parentId)) {
      const list = children.get(t.parentId);
      if (list) list.push(t); else children.set(t.parentId, [t]);
    } else {
      roots.push(t);
    }
  }

  const byOrder = (a: Task, b: Task) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title);
  roots.sort(byOrder);
  return roots.map(task => ({ task, children: (children.get(task.id) ?? []).sort(byOrder) }));
}

// ─── Create / edit / delete ──────────────────────────────────────────────────

export function newTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** A fresh task with the required defaults: today's date, no time. */
export function makeTask(partial: Partial<Task>, weekStartsOn: WeekStartsOn): Task {
  const base: Task = {
    id: partial.id ?? newTaskId(),
    title: partial.title ?? '',
    deleted: false,
    updatedAt: Date.now(),
    ...partial,
  };
  if (base.weekKey === undefined && !('weekKey' in partial)) {
    return withDueDate(base, todayYmd(), weekStartsOn);
  }
  return base;
}

/**
 * Route an edit on the occurrence `occId` back to its master.
 *
 * IMPORTANT: `editSeries`'s unlocked-detach path clears the gCal* identity but
 * knows nothing about gTask* — a detached task would otherwise inherit the
 * master's Google Tasks id and the two would fight over one Google task.
 */
export function editTaskSeries(
  raw: TaskData,
  occId: string,
  patch: Partial<Task>,
  viewedWeekKey: string,
  weekStartsOn: WeekStartsOn,
): { events: TaskData; targetId: string } {
  const res = editSeries<Task>(raw, occId, patch, viewedWeekKey, weekStartsOn);
  const { masterId } = parseOccId(occId);
  const detached = res.targetId !== masterId ? res.events[res.targetId] : null;
  if (detached) {
    res.events[res.targetId] = {
      ...detached,
      gTaskId: undefined,
      gTaskListId: undefined,
      gTaskETag: undefined,
      gTaskSeriesDate: undefined,
      gTaskParentId: undefined,
      lastSyncedAt: undefined,
      completedDates: undefined,
      seriesDone: undefined,
    };
  }
  return res;
}

/**
 * Delete scoped to one occurrence / this-and-following / the whole series.
 * A task with a Google id is tombstoned so the delete mirrors before removal.
 */
export function deleteTaskScoped(raw: TaskData, occId: string, mode: DeleteMode): TaskData {
  const { masterId, occDate } = parseOccId(occId);
  const master = raw[masterId];
  if (!master) return raw;
  const now = Date.now();

  const dropOrTombstone = (): TaskData => {
    if (master.gTaskId) return { ...raw, [masterId]: { ...master, deleted: true, updatedAt: now } };
    const next = { ...raw };
    delete next[masterId];
    // Orphaned subtasks go with their parent.
    for (const t of Object.values(next)) if (t.parentId === masterId) delete next[t.id];
    return next;
  };

  if (!master.recur || mode === 'all') return dropOrTombstone();

  if (mode === 'following') {
    if (!occDate) return dropOrTombstone();
    const anchor = dueDateOf(master);
    if (anchor && occDate <= anchor) return dropOrTombstone();
    const until = ymd(addDays(parseYmd(occDate), -1));
    const exdates = (master.exdates ?? []).filter(d => d < occDate);
    return { ...raw, [masterId]: { ...master, recur: { ...master.recur, end: { until } }, exdates, updatedAt: now } };
  }

  if (!occDate) return dropOrTombstone();
  const exdates = master.exdates ?? [];
  if (exdates.includes(occDate)) return raw;
  return { ...raw, [masterId]: { ...master, exdates: [...exdates, occDate], updatedAt: now } };
}

export { makeOccId, parseOccId };

// ─── Defensive load ──────────────────────────────────────────────────────────

/**
 * Coerce whatever came off disk / localStorage into a valid TaskData. Anything
 * unrecognisable is dropped rather than allowed to crash the grid. Records
 * carrying a gCalId are rejected outright — that would mean an event leaked into
 * the task store.
 */
export function coerceTasks(raw: unknown): TaskData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: TaskData = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const t = value as Partial<Task> & Record<string, unknown>;
    const id = typeof t.id === 'string' && t.id ? t.id : key;
    if (typeof t.title !== 'string') continue;
    if (t.gCalId) continue;
    if (String(id).includes('::')) continue; // a leaked occurrence record

    const task: Task = { id, title: t.title };
    if (typeof t.notes === 'string') task.notes = t.notes;
    if (typeof t.parentId === 'string') task.parentId = t.parentId;
    if (typeof t.order === 'number' && Number.isFinite(t.order)) task.order = t.order;
    if (typeof t.weekKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.weekKey)) task.weekKey = t.weekKey;
    if (typeof t.dayIndex === 'number') task.dayIndex = Math.max(0, Math.min(6, Math.round(t.dayIndex)));
    if (typeof t.startTime === 'string' && /^\d{2}:\d{2}$/.test(t.startTime)) task.startTime = t.startTime;
    if (typeof t.endTime === 'string' && /^\d{2}:\d{2}$/.test(t.endTime)) task.endTime = t.endTime;
    if (t.recur && typeof t.recur === 'object') task.recur = t.recur as Task['recur'];
    if (Array.isArray(t.exdates)) task.exdates = t.exdates.filter(d => typeof d === 'string');
    if (typeof t.locked === 'boolean') task.locked = t.locked;
    if (typeof t.completed === 'boolean') task.completed = t.completed;
    if (Array.isArray(t.completedDates)) task.completedDates = t.completedDates.filter(d => typeof d === 'string');
    if (typeof t.completedAt === 'number') task.completedAt = t.completedAt;
    if (typeof t.color === 'string') task.color = t.color;
    if (typeof t.deleted === 'boolean') task.deleted = t.deleted;
    if (typeof t.updatedAt === 'number') task.updatedAt = t.updatedAt;
    if (typeof t.lastSyncedAt === 'number') task.lastSyncedAt = t.lastSyncedAt;
    if (typeof t.gTaskId === 'string') task.gTaskId = t.gTaskId;
    if (typeof t.gTaskListId === 'string') task.gTaskListId = t.gTaskListId;
    if (typeof t.gTaskETag === 'string') task.gTaskETag = t.gTaskETag;
    if (typeof t.gTaskSeriesDate === 'string') task.gTaskSeriesDate = t.gTaskSeriesDate;
    if (typeof t.gTaskParentId === 'string') task.gTaskParentId = t.gTaskParentId;
    if (typeof t.seriesDone === 'boolean') task.seriesDone = t.seriesDone;

    // A task with a time but no date is nonsense — the time has nothing to anchor to.
    if (!task.weekKey) { task.startTime = undefined; task.endTime = undefined; task.recur = undefined; }

    out[id] = task;
  }
  return out;
}
