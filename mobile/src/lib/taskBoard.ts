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
  expandTaskRange, isStepDone, isTaskDone, makeOccId, matchesFilters
} from './tasks';
import { resolveListId, type TaskList } from './taskLists';

export type SortMode = 'datetime' | 'manual' | 'title' | 'title-desc';

/** Every sort the board understands, and the one it falls back to. */
export const SORT_MODES: readonly SortMode[] = ['datetime', 'manual', 'title', 'title-desc'];

export const DEFAULT_SORT_MODE: SortMode = 'datetime';

/**
 * A stored sort mode, or the default.
 *
 * A store hands back strings and nulls. Deciding here, rather than at each of
 * the two places that read one, is what stops a phone and a PC from disagreeing
 * about whether a mode written by an older build still means anything.
 */
export function coerceSortMode(value: unknown): SortMode {
  return typeof value === 'string' && (SORT_MODES as readonly string[]).includes(value)
    ? value as SortMode
    : DEFAULT_SORT_MODE;
}
/**
 * Where a task sits in a hand-made order. Something nobody has placed sorts
 * AFTER everything somebody has.
 *
 * THIS IS THE WHOLE BUG THAT ORDER-BY-HAND USED TO HAVE. Positions are written
 * as 0, 10, 20, so reading an absent one as zero made every task the user had
 * never touched tie with the FIRST row of the arrangement they had just made,
 * and win the tie often enough to land on top of it. A new task appeared above
 * work that had been ordered on purpose, which is the one thing a manual order
 * exists to prevent.
 *
 * When nothing in a group has been placed they all tie here, and the rule below
 * this one decides -- which is why a list looks completely unchanged until the
 * first thing is moved.
 *
 * Rubbish is treated as absent on purpose: `NaN` and `Infinity` have both
 * reached this field from older builds, and either one poisons a comparator
 * (`NaN - n` is `NaN`, which sorts as "equal to everything" and lets the list
 * reshuffle itself between renders).
 */
export function orderKey(t: Task): number {
  return typeof t.order === 'number' && Number.isFinite(t.order)
    ? t.order
    : Number.MAX_SAFE_INTEGER;
}

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

  /**
   * Every row a task is drawn as, by the task's own id.
   *
   * A LIST, NOT A ROW, BECAUSE A REPEAT IS DRAWN MORE THAN ONCE. The old index
   * kept one row per id and deliberately left repeating masters out of it
   * altogether, so a step whose `parentId` named a repeat found no parent at all
   * and was drawn as a task in its own right: "buy milk" sitting in Today as a
   * separate card, next to the shopping trip it belongs to. The PC has always
   * nested these correctly, which is how the two screens came to disagree about
   * what the same database contained.
   *
   * Only rows that are not themselves steps go in. Nesting is one level deep,
   * and a step of a step would otherwise attach.
   */
  const rowsByTaskId = new Map<string, Row[]>();
  for (const r of allVisibleRows) {
    if (r.task.parentId) continue;
    const list = rowsByTaskId.get(r.task.id);
    if (list) list.push(r); else rowsByTaskId.set(r.task.id, [r]);
  }

  const parentRowsOf = (r: Row): Row[] => {
    if (!r.task.parentId || r.task.parentId === r.task.id) return [];
    return rowsByTaskId.get(r.task.parentId) ?? [];
  };

  const roots: Row[] = [];
  const kids = new Map<string, Row[]>();

  for (const r of allVisibleRows) {
    const parents = parentRowsOf(r);
    if (parents.length === 0) {
      // Either a task in its own right, or a step whose parent is not on screen
      // (a different list, filtered out, deleted). Drawn on its own rather than
      // dropped, because a step nobody can reach is worse than one out of place.
      roots.push(r);
      continue;
    }
    for (const parent of parents) {
      // A step of a REPEAT is drawn under every occurrence of it, and is done
      // for each one separately -- so the row handed to the UI carries the
      // parent's date, not the step's own, and an occurrence id of its own so
      // two copies of the same step never share a React key.
      const child: Row = parent.task.recur
        ? {
            occId: makeOccId(r.task.id, parent.due ?? ''),
            task: r.task,
            due: parent.due,
            done: isStepDone(r.task, parent.task, parent.due),
          }
        : r;
      const siblings = kids.get(parent.occId);
      if (siblings) siblings.push(child); else kids.set(parent.occId, [child]);
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
      orderKey(a.task) - orderKey(b.task)
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
      return orderKey(ar.task) - orderKey(br.task)
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
      || orderKey(ar.task) - orderKey(br.task)
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

