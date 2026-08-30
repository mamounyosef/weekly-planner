/**
 * Task lists — the Tasks page's own sections.
 *
 * Deliberately NOT the same thing as calendar categories: a category colours a
 * calendar item, a list decides which page of the task board a task lives on.
 * Keeping them separate means renaming "University Calendar" never silently
 * moves half the todo list somewhere else.
 *
 * Every task belongs to exactly one list. A task with no `listId` — which is
 * every task that existed before lists did — belongs to General, so the feature
 * arrives with nothing to migrate.
 */

export interface TaskList {
  id: string;
  name: string;
  /** Accent used for the tab and the list's chips. */
  color: string;
}

/** The list that owns every task that has not been filed anywhere else. */
export const GENERAL_LIST_ID = 'general';

export const DEFAULT_TASK_LISTS: TaskList[] = [
  { id: GENERAL_LIST_ID, name: 'General', color: '#3b82f6' },
];

export const TASK_LIST_COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#a855f7',
  '#f43f5e', '#14b8a6', '#eab308', '#6366f1',
];

/** The list a task actually belongs to, treating "unset" as General. */
export const listIdOf = (listId?: string | null): string => listId || GENERAL_LIST_ID;

/**
 * The same thing, but proof against a list that no longer exists.
 *
 * Lists can be deleted from the Settings window, which has no access to the
 * task store and so cannot rewrite the tasks that pointed at them. Rather than
 * leave those tasks invisible on a page nobody can open, every read resolves an
 * unknown id back to General — deleting a list can never lose a task.
 */
export function resolveListId(listId: string | null | undefined, lists: TaskList[]): string {
  const id = listIdOf(listId);
  return lists.some(l => l.id === id) ? id : GENERAL_LIST_ID;
}

/** The next unused preset colour, so two new lists never look the same. */
export function nextListColor(lists: TaskList[]): string {
  const used = new Set(lists.map(l => l.color.toLowerCase()));
  return TASK_LIST_COLORS.find(c => !used.has(c.toLowerCase()))
    ?? TASK_LIST_COLORS[lists.length % TASK_LIST_COLORS.length];
}

/** Move a list one slot left/right. Returns the same array when it can't move. */
export function moveList(lists: TaskList[], id: string, dir: -1 | 1): TaskList[] {
  const idx = lists.findIndex(l => l.id === id);
  const next = idx + dir;
  if (idx < 0 || next < 0 || next >= lists.length) return lists;
  const out = [...lists];
  const [moved] = out.splice(idx, 1);
  out.splice(next, 0, moved);
  return out;
}

export function coerceTaskLists(raw: unknown): TaskList[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_TASK_LISTS.map(l => ({ ...l }));
  }
  const out: TaskList[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Untitled list';
    const rawColor = typeof r.color === 'string' ? r.color.trim() : '';
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor)
      ? rawColor
      : TASK_LIST_COLORS[out.length % TASK_LIST_COLORS.length];
    out.push({ id, name, color });
  }
  // General is structural, not optional: without it, tasks with no list would
  // have nowhere to appear.
  if (!out.some(l => l.id === GENERAL_LIST_ID)) {
    out.unshift({ ...DEFAULT_TASK_LISTS[0] });
  }
  return out;
}

/** A stable-ish id from a name, with a random tail so duplicates can coexist. */
export function makeListId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return `${slug || 'list'}-${Math.random().toString(36).slice(2, 6)}`;
}
