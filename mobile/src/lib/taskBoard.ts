/**
 * Shared logic for grouping and sorting tasks into sections.
 * 
 * WHY EXTRACT THIS?
 * Both the PC and Phone need to group tasks into identical buckets (Overdue, Today,
 * Tomorrow, Upcoming, General, Done) and sort them the exact same way. Extracting
 * this ensures the two platforms can never disagree about where a task lives or
 * what is considered overdue.
 *
 * HOW RECURRING TASKS ARE HANDLED
 * A recurring task isn't one item; it's an infinite series. This file expands those
 * tasks into "Rows" for the specified lookback/lookahead window, letting the UI
 * simply render a list without worrying about the math of generating occurrences.
 */
import {
  type Task, type TaskData, type TaskFilter,
  expandTaskRange, isTaskDone, matchesFilters
} from './tasks';
import { resolveListId, type TaskList } from './taskLists';

export type SortMode = 'datetime' | 'manual' | 'title' | 'title-desc';
export type Bucket = 'Overdue' | 'Today' | 'Tomorrow' | 'Upcoming' | 'General';
export type SectionKey = Bucket | 'Done';

export interface Row {
  occId: string;
  task: Task;
  due: string | null;
  done: boolean;
}

export interface Node {
  row: Row;
  children: Row[];
}

const LOOKBACK_DAYS = 28;
const LOOKAHEAD_DAYS = 365;

export function buildTaskRows(
  tasks: TaskData,
  today: string,
  autoRollRecurringTasks = true
): Row[] {
  const day = (n: number) => {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const from = day(-LOOKBACK_DAYS);
  const to = day(LOOKAHEAD_DAYS);
  const staleBefore = day(-7);
  const rows: Row[] = [];

  for (const t of Object.values(tasks)) {
    // A real record, with a real id. `typeof [] === 'object'` is true, so the
    // obvious guard lets an array through and it becomes a row whose occId is
    // undefined: invisible in the list, and able to collide with any other
    // malformed entry. Anything the store should not be holding is skipped here
    // rather than being drawn as a ghost.
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    if (typeof t.id !== 'string' || t.id === '') continue;
    if (t.deleted) continue;
    if (!t.weekKey) {
      rows.push({ occId: t.id, task: t, due: null, done: isTaskDone(t) });
      continue;
    }
    for (const { occId, occDate } of expandTaskRange(t, from, to, { autoRollRecurring: autoRollRecurringTasks, today })) {
      const done = isTaskDone(t, occDate);
      if (done && occDate < staleBefore) continue;
      rows.push({ occId, task: t.recur ? { ...t, occDate } : t, due: occDate, done });
    }
  }
  return rows;
}

export function groupTasks(
  rows: Row[],
  tasks: TaskData,
  lists: TaskList[],
  activeListId: string | null,
  filters: TaskFilter[],
  today: string,
  sortMode: SortMode
): Record<SectionKey, Node[]> {
  const tomorrowStr = (() => {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  })();

  const listOfTask = (t: Task): string => {
    const owner = (t.parentId && tasks[t.parentId] ? tasks[t.parentId] : null) ?? t;
    return resolveListId(owner.listId, lists);
  };

  const allVisibleRows = activeListId
    ? rows.filter(r => listOfTask(r.task) === activeListId)
    : rows;

  const byId = new Map<string, Row>();
  for (const r of allVisibleRows) {
    byId.set(r.occId, r);
    if (!r.task.recur) byId.set(r.task.id, r);
  }

  const parentOf = (r: Row): Row | null => {
    if (!r.task.parentId || r.task.parentId === r.task.id) return null;
    const parent = byId.get(r.task.parentId);
    if (!parent || parent.task.parentId) return null;
    return parent;
  };

  const roots: Row[] = [];
  const kids = new Map<string, Row[]>();

  for (const r of allVisibleRows) {
    const parent = parentOf(r);
    if (!parent) {
      roots.push(r);
    } else {
      const siblings = kids.get(parent.occId) ?? [];
      siblings.push(r);
      kids.set(parent.occId, siblings);
    }
  }

  const out: Record<SectionKey, Node[]> = {
    Overdue: [], Today: [], Tomorrow: [], Upcoming: [], General: [], Done: []
  };

  for (const r of roots) {
    // The tested predicate from `tasks.ts`, not a second copy of it. An empty
    // selection means "everything", a selection ORs together, and completed is
    // its own axis: getting any of that subtly different here would show the
    // phone a different set of tasks than the PC for the same filters.
    if (!matchesFilters(r.task, r.due, filters, today)) continue;

    const children = (kids.get(r.occId) ?? []).sort((a, b) =>
      (a.task.order ?? 0) - (b.task.order ?? 0)
      || (a.task.title ?? '').localeCompare(b.task.title ?? '')
      // The id last, always. Without it two subtasks with the same name and the
      // same order compare equal, and a comparator that returns 0 lets the sort
      // put them in either order: the list quietly reshuffles between renders.
      || (a.occId < b.occId ? -1 : a.occId > b.occId ? 1 : 0));

    const node: Node = { row: r, children };

    if (r.done) out.Done.push(node);
    else if (!r.due) out.General.push(node);
    else if (r.due < today) out.Overdue.push(node);
    else if (r.due === today) out.Today.push(node);
    else if (r.due === tomorrowStr) out.Tomorrow.push(node);
    else out.Upcoming.push(node);
  }

  const sortFn = (a: Node, b: Node) => {
    const ar = a.row;
    const br = b.row;
    // EVERY branch ends on the id, so the comparator is a TOTAL order and never
    // returns 0 for two different rows. A comparator with ties is not a cosmetic
    // problem: the order becomes whatever the sort happened to do this time, so
    // a list redraws in a different order after an unrelated edit and looks like
    // it moved on its own.
    const tie = ar.occId < br.occId ? -1 : ar.occId > br.occId ? 1 : 0;

    if (sortMode === 'manual') {
      return (ar.task.order ?? 0) - (br.task.order ?? 0)
        || (ar.due ?? '9999').localeCompare(br.due ?? '9999')
        || (ar.task.title ?? '').localeCompare(br.task.title ?? '')
        || tie;
    }
    if (sortMode === 'title') {
      return (ar.task.title ?? '').localeCompare(br.task.title ?? '') || tie;
    }
    if (sortMode === 'title-desc') {
      return (br.task.title ?? '').localeCompare(ar.task.title ?? '') || tie;
    }
    return (ar.due ?? '9999').localeCompare(br.due ?? '9999')
      || (ar.task.startTime ?? '99:99').localeCompare(br.task.startTime ?? '99:99')
      || (ar.task.order ?? 0) - (br.task.order ?? 0)
      || (ar.task.title ?? '').localeCompare(br.task.title ?? '')
      || tie;
  };

  for (const key of ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'General'] as const) {
    out[key].sort(sortFn);
  }
  // Newest first, and the id again so two things finished in the same
  // millisecond (a "clear all" does exactly that) keep a settled order.
  out.Done.sort((a, b) =>
    (b.row.task.completedAt ?? 0) - (a.row.task.completedAt ?? 0)
    || (a.row.occId < b.row.occId ? -1 : a.row.occId > b.row.occId ? 1 : 0));

  return out;
}

