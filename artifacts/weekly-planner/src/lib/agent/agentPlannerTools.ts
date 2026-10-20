// ─── Planner agent: tools for the planner's setup, prayers and focus timer ──
//
// The same sandbox rules as agentTools.ts: every function here is PURE over
// (arguments, world). It returns the new state of whatever it touches plus
// the records Undo needs, and the server writes that state through the same
// doors the app uses (settings save + sync ingest, the prayer toggle, the focus
// timer file). Nothing here touches a file.
//
// What lives here, and why each one is shaped the way it is:
//   - categories and task lists: edited as the coerced lists the app itself
//     shows, so what the model sees and what gets written are the same thing;
//   - settings: only SHARED planner settings, one leaf at a time, each leaf an
//     undo record of its own, so undoing one change never reverts another;
//   - prayers: per-prayer toggles, because the server applies them as single
//     set elements (a whole-map write would revert the phone's ticks);
//   - the focus timer: through the shared reducer, never arithmetic of our own.
//
// Deleting a category or a task list is not here as a tool: it goes through
// delete_items, which pauses for the user's Approve.

import { format } from 'date-fns';

import type { AgentWorld, ToolOutcome, UndoRecord } from './agentTools';
import type { ChangeEntry, ItemFacts, PendingDeletion } from './agentTypes';
import {
  coerceCategories, canDeleteCategory, LAST_CATEGORY_MESSAGE, PRESET_CATEGORY_COLORS, type EventCategory,
} from '../categories';
import { coerceTaskLists, GENERAL_LIST_ID, makeListId, nextListColor, type TaskList } from '../taskLists';
import {
  coerceNotificationSettings, DEFAULT_ALL_DAY_SPEC, DEFAULT_PRAYER_SPEC, DEFAULT_TASK_SPEC, DEFAULT_TIMED_SPEC,
  type NotifySpec,
} from '../notifications';
import { coercePrayerSettings, PRAYER_KEYS, PRAYER_LABELS, PRAYER_METHODS, type PrayerKey } from '../prayerTimes';
import {
  coerceFocusTimer, focusElapsedSeconds, focusPhase, reduceFocusTimer,
  MAX_PLANNED_SECONDS, MIN_PLANNED_SECONDS, type FocusTimerState,
} from '../focusTimer';
import { dedupeFocusHistory, focusDayKey, normaliseFocusSessionId, type FocusSessionRecord } from '../focusStats';
import {
  fail, isRecord, parseYmdStrict, stable, dayLabel, parseReminders, remindersLabel, minutesLabel,
} from './agentToolBase';

// ─── Shared bits ─────────────────────────────────────────────────────────────

/** Who the timer and settings writes are attributed to. */
export const AGENT_ORIGIN = 'assistant';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const rawSettingsOf = (w: AgentWorld): Record<string, unknown> => (isRecord(w.settings) ? w.settings : {});

/**
 * What a value MEANS, for "is it still what we left?". Empty values are dropped
 * at every level: the app writes an absent field, `false`, `''` and `[]`
 * interchangeably, and comparing them literally made untouched things look
 * edited (the same lesson as the event/task undo).
 */
export function meaning(v: unknown): string {
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (isRecord(x)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        if (val === undefined || val === null || val === false || val === '') continue;
        if (Array.isArray(val) && val.length === 0) continue;
        out[k] = strip(val);
      }
      return out;
    }
    return x;
  };
  return stable(strip(v));
}

function list<T>(raw: unknown, field: string, max: number): T[] {
  if (!Array.isArray(raw) || !raw.length) fail(`${field} must be a non-empty list.`);
  if ((raw as unknown[]).length > max) fail(`At most ${max} ${field} per call.`);
  return raw as T[];
}

function str(raw: unknown, field: string, max = 80): string {
  if (typeof raw !== 'string' || !raw.trim()) fail(`${field} must be some text.`);
  const s = (raw as string).trim();
  if (s.length > max) fail(`${field} is longer than ${max} characters.`);
  return s;
}

function bool(raw: unknown, field: string): boolean {
  if (typeof raw !== 'boolean') fail(`${field} must be true or false.`);
  return raw as boolean;
}

function int(raw: unknown, field: string, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n) || Math.round(n) !== n) fail(`${field} must be a whole number.`);
  if (n < min || n > max) fail(`${field} must be from ${min} to ${max}.`);
  return n;
}

const COLOR_WORDS: Record<string, string> = {
  green: '#22c55e', emerald: '#22c55e', forest: '#16a34a', 'dark green': '#16a34a',
  orange: '#f97316', amber: '#ea580c', blue: '#3b82f6', royal: '#3b82f6', sky: '#0284c7', 'light blue': '#0284c7',
  purple: '#a855f7', lilac: '#a855f7', violet: '#7c3aed', pink: '#f43f5e', rose: '#f43f5e',
  red: '#e11d48', crimson: '#e11d48', teal: '#14b8a6', cyan: '#14b8a6', turquoise: '#14b8a6',
  yellow: '#eab308', gold: '#eab308', golden: '#eab308', indigo: '#6366f1', gray: '#6b7280', grey: '#6b7280',
  brown: '#92400e', black: '#111827',
};

/** A colour as "#rrggbb", from a hex, a preset name ("Royal Blue") or a plain word ("teal"). */
export function parseColor(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) fail(`${field} must be a colour like "#22c55e" or a name like "teal".`);
  const s = (raw as string).trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s.slice(1).split('').map(c => c + c).join('')}`.toLowerCase();
  const q = s.toLowerCase();
  const preset = PRESET_CATEGORY_COLORS.find(p => p.label.toLowerCase() === q);
  if (preset) return preset.hex;
  if (COLOR_WORDS[q]) return COLOR_WORDS[q];
  const word = Object.keys(COLOR_WORDS).find(w => q.split(/\s+/).includes(w));
  if (word) return COLOR_WORDS[word];
  return fail(`${field} "${s}" is not a colour. Use a hex like "#22c55e" or one of: ${Object.keys(COLOR_WORDS).join(', ')}.`);
}

/** Look a thing up by id, exact name, then prefix, then substring. */
function findByName<T extends { id: string; name: string }>(items: T[], raw: unknown, what: string): { item: T; index: number } {
  if (typeof raw !== 'string' || !raw.trim()) fail(`Say which ${what} by its name.`);
  const q = (raw as string).trim().toLowerCase();
  const tries = [
    (x: T) => x.id === raw,
    (x: T) => x.name.toLowerCase() === q,
    (x: T) => x.name.toLowerCase().startsWith(q),
    (x: T) => x.name.toLowerCase().includes(q),
  ];
  for (const t of tries) {
    const hits = items.filter(t);
    if (hits.length === 1) return { item: hits[0], index: items.indexOf(hits[0]) };
    if (hits.length > 1) fail(`"${raw}" matches several ${what}s (${hits.map(h => h.name).join(', ')}). Use the full name.`);
  }
  return fail(`There is no ${what} called "${raw}". Existing: ${items.map(i => i.name).join(', ') || '(none)'}.`);
}

/** Per-id diff of two ordered lists into undo records, plus an order record if the order moved. */
function diffList<T extends { id: string }>(prefix: 'category' | 'taskList', before: T[], after: T[]): UndoRecord[] {
  const out: UndoRecord[] = [];
  const b = new Map(before.map((x, i) => [x.id, { x, i }]));
  const a = new Map(after.map((x, i) => [x.id, { x, i }]));
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const bx = b.get(id);
    const ax = a.get(id);
    if (bx && ax && meaning(bx.x) === meaning(ax.x)) continue;
    out.push({
      store: 'settings',
      id: `${prefix}:${id}`,
      before: bx ? { ...bx.x } as Record<string, unknown> : null,
      after: ax ? { ...ax.x } as Record<string, unknown> : null,
      ...(bx ? { position: bx.i } : {}),
    });
  }
  const common = (xs: T[], other: Map<string, unknown>) => xs.map(x => x.id).filter(id => other.has(id));
  const bOrder = common(before, a);
  const aOrder = common(after, b);
  if (bOrder.join('\u0000') !== aOrder.join('\u0000')) {
    out.push({
      store: 'settings',
      id: prefix === 'category' ? 'categories#order' : 'taskLists#order',
      before: { ids: before.map(x => x.id) },
      after: { ids: after.map(x => x.id) },
    });
  }
  return out;
}

// ─── Categories ──────────────────────────────────────────────────────────────

export function categoryFacts(c: EventCategory, index: number): ItemFacts {
  const noDur = !!c.defaultNoDuration || c.defaultDurationMin === 0;
  const f: ItemFacts = {
    title: c.name,
    kind: 'category',
    color: c.color,
    duration: noDur ? 'No duration (a moment)' : `${c.defaultDurationMin ?? 30} min`,
    allDay: !!c.defaultAllDay,
    checkbox: !c.defaultNoCheckbox,
    widget: c.showInWidget !== false,
    isDefault: !!c.isDefault,
    position: index + 1,
  };
  if (c.description) f.description = c.description;
  const rt = remindersLabel(c.notifyTimed);
  if (rt) f.reminders = rt;
  const ra = remindersLabel(c.notifyAllDay);
  if (ra) f.remindersAllDay = ra;
  return f;
}

const CATEGORY_FIELDS = ['name', 'newName', 'color', 'defaultMinutes', 'pointInTime', 'allDay', 'checkbox', 'showInWidget', 'makeDefault', 'description', 'remindersTimed', 'remindersAllDay'];

/** Apply the fields a change carries onto a category, the way the Settings window stores them. */
function patchCategory(c: EventCategory, a: Record<string, unknown>, idx: number): EventCategory {
  const next = { ...c };
  if (a.color !== undefined) next.color = parseColor(a.color, `changes[${idx}].color`);
  if (a.pointInTime !== undefined) {
    if (bool(a.pointInTime, `changes[${idx}].pointInTime`)) {
      next.defaultNoDuration = true;
      next.defaultDurationMin = 0;
    } else {
      next.defaultNoDuration = false;
      if (!next.defaultDurationMin) next.defaultDurationMin = 30;
    }
  }
  if (a.defaultMinutes !== undefined) {
    const m = int(a.defaultMinutes, `changes[${idx}].defaultMinutes`, 0, 1440);
    if (m === 0) { next.defaultNoDuration = true; next.defaultDurationMin = 0; }
    else {
      if (a.pointInTime === true) fail(`changes[${idx}]: a point-in-time category has no length; leave defaultMinutes out.`);
      next.defaultNoDuration = false;
      next.defaultDurationMin = m;
    }
  }
  if (a.allDay !== undefined) next.defaultAllDay = bool(a.allDay, `changes[${idx}].allDay`);
  if (a.checkbox !== undefined) next.defaultNoCheckbox = !bool(a.checkbox, `changes[${idx}].checkbox`);
  if (a.showInWidget !== undefined) next.showInWidget = bool(a.showInWidget, `changes[${idx}].showInWidget`);
  if (a.description !== undefined) {
    if (a.description !== null && typeof a.description !== 'string') fail(`changes[${idx}].description must be text.`);
    next.description = typeof a.description === 'string' ? a.description.trim().slice(0, 500) : '';
  }
  if (a.remindersTimed !== undefined) {
    const r = parseReminders(a.remindersTimed);
    next.notifyTimed = r === 'inherit' ? undefined : r;
  }
  if (a.remindersAllDay !== undefined) {
    const r = parseReminders(a.remindersAllDay);
    next.notifyAllDay = r === 'inherit' ? undefined : r;
  }
  return next;
}

function manageCategories(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const changes = list<unknown>(args.changes, 'changes', 40);
  const raw = rawSettingsOf(world);
  const before = coerceCategories(raw.categories);
  let cats = before.map(c => ({ ...c }));
  const entries: ChangeEntry[] = [];
  const results: unknown[] = [];
  const newId = world.newId;

  changes.forEach((rawChange, idx) => {
    if (!isRecord(rawChange)) fail(`changes[${idx}] must be an object.`);
    const a = rawChange as Record<string, unknown>;
    const action = String(a.action ?? '').toLowerCase();
    const unknownField = Object.keys(a).find(k => k !== 'action' && k !== 'category' && k !== 'position' && !CATEGORY_FIELDS.includes(k));
    if (unknownField) fail(`changes[${idx}] has an unknown field "${unknownField}".`);

    if (action === 'create') {
      const name = str(a.name, `changes[${idx}].name`, 60);
      const dup = cats.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (dup) {
        entries.push({ action: 'skipped', kind: 'category', id: dup.id, after: categoryFacts(dup, cats.indexOf(dup)), note: 'A category with this name already exists, so it was not added again.', verified: true });
        results.push({ name, skipped: 'already exists' });
        return;
      }
      const base: EventCategory = {
        id: newId ? `cat-${newId()}` : `cat-${world.now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        color: PRESET_CATEGORY_COLORS[cats.length % PRESET_CATEGORY_COLORS.length].hex,
        defaultDurationMin: 30,
        defaultNoDuration: false,
        defaultAllDay: false,
        defaultNoCheckbox: false,
        showInWidget: true,
        isDefault: false,
        description: '',
        notifyTimed: undefined,
        notifyAllDay: undefined,
      };
      const cat = patchCategory(base, a, idx);
      if (a.makeDefault === true) { cats = cats.map(c => ({ ...c, isDefault: false })); cat.isDefault = true; }
      cats.push(cat);
      entries.push({ action: 'added', kind: 'category', id: cat.id, after: categoryFacts(cat, cats.length - 1), verified: false });
      results.push({ id: cat.id, name: cat.name, color: cat.color });
      return;
    }

    if (action === 'update' || action === 'move') {
      const { item, index } = findByName(cats, a.category ?? a.name, 'category');
      // With the category named, a "name" can only mean the new name.
      if (a.category !== undefined && a.name !== undefined && a.newName === undefined) a.newName = a.name;
      const beforeFacts = categoryFacts(item, index);
      let next = item;
      if (action === 'update') {
        const fields = Object.keys(a).filter(k => !['action', 'category', 'name'].includes(k));
        if (!fields.length) fail(`changes[${idx}] lists nothing to change.`);
        if (a.position !== undefined) fail(`changes[${idx}]: use action "move" to change a position.`);
        next = patchCategory(item, a, idx);
        if (a.newName !== undefined) {
          const nn = str(a.newName, `changes[${idx}].newName`, 60);
          if (cats.some(c => c.id !== item.id && c.name.toLowerCase() === nn.toLowerCase())) fail(`Another category is already called "${nn}".`);
          next = { ...next, name: nn };
        }
        if (a.makeDefault !== undefined) {
          if (bool(a.makeDefault, `changes[${idx}].makeDefault`)) {
            cats = cats.map(c => ({ ...c, isDefault: false }));
            next = { ...next, isDefault: true };
          } else next = { ...next, isDefault: false };
        }
        cats = cats.map(c => (c.id === item.id ? next : c));
      } else {
        const pos = int(a.position, `changes[${idx}].position`, 1, cats.length);
        cats = cats.filter(c => c.id !== item.id);
        cats.splice(pos - 1, 0, item);
      }
      const nowIndex = cats.findIndex(c => c.id === item.id);
      const afterFacts = categoryFacts(cats[nowIndex], nowIndex);
      const changed = changedKeys(beforeFacts, afterFacts);
      if (!changed.length) {
        entries.push({ action: 'skipped', kind: 'category', id: item.id, after: afterFacts, note: 'It was already like that.', verified: true });
        results.push({ name: item.name, skipped: 'no change' });
        return;
      }
      entries.push({ action: 'updated', kind: 'category', id: item.id, before: beforeFacts, after: afterFacts, changed, verified: false });
      results.push({ id: item.id, name: afterFacts.title, changed });
      return;
    }

    if (action === 'delete') fail('Deleting a category goes through delete_items with "categories": ["<name>"], so the user can approve it.');
    fail(`changes[${idx}].action must be "create", "update" or "move".`);
  });

  // A default can only be one category; tell the reader which one lost it.
  for (const c of before) {
    const now = cats.find(x => x.id === c.id);
    if (c.isDefault && now && !now.isDefault && !entries.some(e => e.id === c.id)) {
      entries.push({
        action: 'updated', kind: 'category', id: c.id,
        before: categoryFacts(c, before.indexOf(c)), after: categoryFacts(now, cats.indexOf(now)),
        changed: ['isDefault'], note: 'No longer the default category.', verified: false,
      });
    }
  }

  // Written in exactly the shape every reader coerces it to, so read-back and
  // Undo compare like with like (an "off" reminder, for one, gains a rule).
  cats = coerceCategories(cats);
  const undo = diffList('category', before, cats);
  const changedAny = undo.length > 0;
  const added = entries.filter(e => e.action === 'added').length;
  const updated = entries.filter(e => e.action === 'updated').length;
  return {
    ...(changedAny ? { settings: { ...raw, categories: cats } } : {}),
    entries,
    undo,
    result: { added, updated, skipped: entries.filter(e => e.action === 'skipped').length, items: results, categoriesNow: cats.map(c => c.name) },
    label: categoryLabel(added, updated, 'categor', 'y', 'ies'),
  };
}

function categoryLabel(added: number, updated: number, stem: string, one: string, many: string): string {
  const parts: string[] = [];
  if (added) parts.push(`Added ${added} ${stem}${added === 1 ? one : many}`);
  if (updated) parts.push(`${parts.length ? 'changed' : 'Changed'} ${updated}${parts.length ? '' : ` ${stem}${updated === 1 ? one : many}`}`);
  return parts.join(', ') || `No ${stem}${many} changed`;
}

function changedKeys(before: ItemFacts, after: ItemFacts): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const order = ['title', 'color', 'duration', 'allDay', 'checkbox', 'widget', 'isDefault', 'reminders', 'remindersAllDay', 'description', 'position', 'value', 'done'];
  return [...keys]
    .filter(k => k !== 'kind')
    .filter(k => stable((before as unknown as Record<string, unknown>)[k]) !== stable((after as unknown as Record<string, unknown>)[k]))
    .sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
}

// ─── Task lists ──────────────────────────────────────────────────────────────

export function taskListFacts(l: TaskList, index: number): ItemFacts {
  return { title: l.name, kind: 'task_list', color: l.color, position: index + 1 };
}

function manageTaskLists(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const changes = list<unknown>(args.changes, 'changes', 40);
  const raw = rawSettingsOf(world);
  const before = coerceTaskLists(raw.taskLists);
  let lists = before.map(l => ({ ...l }));
  const entries: ChangeEntry[] = [];
  const results: unknown[] = [];

  changes.forEach((rawChange, idx) => {
    if (!isRecord(rawChange)) fail(`changes[${idx}] must be an object.`);
    const a = rawChange as Record<string, unknown>;
    const action = String(a.action ?? '').toLowerCase();
    const unknownField = Object.keys(a).find(k => !['action', 'list', 'name', 'newName', 'color', 'position'].includes(k));
    if (unknownField) fail(`changes[${idx}] has an unknown field "${unknownField}".`);

    if (action === 'create') {
      const name = str(a.name, `changes[${idx}].name`, 60);
      const dup = lists.find(l => l.name.toLowerCase() === name.toLowerCase());
      if (dup) {
        entries.push({ action: 'skipped', kind: 'task_list', id: dup.id, after: taskListFacts(dup, lists.indexOf(dup)), note: 'A list with this name already exists, so it was not added again.', verified: true });
        results.push({ name, skipped: 'already exists' });
        return;
      }
      const l: TaskList = {
        id: world.newId ? `list-${world.newId()}` : makeListId(name),
        name,
        color: a.color !== undefined ? parseColor(a.color, `changes[${idx}].color`) : nextListColor(lists),
      };
      lists.push(l);
      entries.push({ action: 'added', kind: 'task_list', id: l.id, after: taskListFacts(l, lists.length - 1), verified: false });
      results.push({ id: l.id, name: l.name, color: l.color });
      return;
    }

    if (action === 'update' || action === 'move') {
      const { item, index } = findByName(lists, a.list ?? a.name, 'task list');
      if (a.list !== undefined && a.name !== undefined && a.newName === undefined) a.newName = a.name;
      const beforeFacts = taskListFacts(item, index);
      if (action === 'update') {
        if (a.newName === undefined && a.color === undefined) fail(`changes[${idx}] lists nothing to change (newName or color).`);
        let next = { ...item };
        if (a.newName !== undefined) {
          const nn = str(a.newName, `changes[${idx}].newName`, 60);
          if (lists.some(l => l.id !== item.id && l.name.toLowerCase() === nn.toLowerCase())) fail(`Another list is already called "${nn}".`);
          next = { ...next, name: nn };
        }
        if (a.color !== undefined) next = { ...next, color: parseColor(a.color, `changes[${idx}].color`) };
        lists = lists.map(l => (l.id === item.id ? next : l));
      } else {
        const pos = int(a.position, `changes[${idx}].position`, 1, lists.length);
        lists = lists.filter(l => l.id !== item.id);
        lists.splice(pos - 1, 0, item);
      }
      const nowIndex = lists.findIndex(l => l.id === item.id);
      const afterFacts = taskListFacts(lists[nowIndex], nowIndex);
      const changed = changedKeys(beforeFacts, afterFacts);
      if (!changed.length) {
        entries.push({ action: 'skipped', kind: 'task_list', id: item.id, after: afterFacts, note: 'It was already like that.', verified: true });
        results.push({ name: item.name, skipped: 'no change' });
        return;
      }
      entries.push({ action: 'updated', kind: 'task_list', id: item.id, before: beforeFacts, after: afterFacts, changed, verified: false });
      results.push({ id: item.id, name: afterFacts.title, changed });
      return;
    }

    if (action === 'delete') fail('Deleting a task list goes through delete_items with "taskLists": ["<name>"], so the user can approve it.');
    fail(`changes[${idx}].action must be "create", "update" or "move".`);
  });

  lists = coerceTaskLists(lists);
  const undo = diffList('taskList', before, lists);
  const added = entries.filter(e => e.action === 'added').length;
  const updated = entries.filter(e => e.action === 'updated').length;
  return {
    ...(undo.length ? { settings: { ...raw, taskLists: lists } } : {}),
    entries,
    undo,
    result: { added, updated, skipped: entries.filter(e => e.action === 'skipped').length, items: results, listsNow: lists.map(l => l.name) },
    label: categoryLabel(added, updated, 'task list', '', 's'),
  };
}

// ─── Deleting categories and task lists (after Approve) ─────────────────────

export interface SetupDeletionPreview {
  deletions: PendingDeletion[];
  categoryIds: string[];
  taskListIds: string[];
}

/** The approval-card rows for categories and lists. Throws (nothing changes) on a bad name. */
export function previewSetupDeletion(args: Record<string, unknown>, world: AgentWorld): SetupDeletionPreview {
  const raw = rawSettingsOf(world);
  const cats = coerceCategories(raw.categories);
  const lists = coerceTaskLists(raw.taskLists);
  const out: SetupDeletionPreview = { deletions: [], categoryIds: [], taskListIds: [] };

  if (args.categories !== undefined) {
    if (!Array.isArray(args.categories)) fail('categories must be a list of category names.');
    for (const name of args.categories as unknown[]) {
      const { item } = findByName(cats, name, 'category');
      if (out.categoryIds.includes(item.id)) continue;
      out.categoryIds.push(item.id);
      const used = Object.values(world.events).filter(e => e && !e.deleted && e.categoryId === item.id).length;
      out.deletions.push({
        id: item.id,
        kind: 'category',
        title: item.name,
        scopeLabel: used
          ? `The category only. Its ${used} item${used === 1 ? '' : 's'} stay in the calendar with no category.`
          : 'The category (nothing uses it).',
        when: 'Event category',
      });
    }
    if (out.categoryIds.length >= cats.length) fail(`${LAST_CATEGORY_MESSAGE} Leave at least one category.`);
  }
  if (args.taskLists !== undefined) {
    if (!Array.isArray(args.taskLists)) fail('taskLists must be a list of task list names.');
    for (const name of args.taskLists as unknown[]) {
      const { item } = findByName(lists, name, 'task list');
      if (item.id === GENERAL_LIST_ID) fail('General is where every unfiled task lives, so it cannot be deleted. It can be renamed.');
      if (out.taskListIds.includes(item.id)) continue;
      out.taskListIds.push(item.id);
      const used = Object.values(world.tasks).filter(t => t && !t.deleted && t.listId === item.id).length;
      out.deletions.push({
        id: item.id,
        kind: 'task_list',
        title: item.name,
        scopeLabel: used
          ? `The list only. Its ${used} task${used === 1 ? '' : 's'} move to General.`
          : 'The list (it has no tasks).',
        when: 'Task list',
      });
    }
  }
  return out;
}

/** Perform an approved category/list deletion against the settings AS THEY ARE NOW. */
export function applySetupDeletion(
  categoryIds: string[],
  taskListIds: string[],
  world: AgentWorld,
): { settings?: Record<string, unknown>; entries: ChangeEntry[]; undo: UndoRecord[]; deleted: number } {
  const raw = rawSettingsOf(world);
  const beforeCats = coerceCategories(raw.categories);
  const beforeLists = coerceTaskLists(raw.taskLists);
  let cats = beforeCats;
  let lists = beforeLists;
  const entries: ChangeEntry[] = [];

  for (const id of categoryIds) {
    const idx = cats.findIndex(c => c.id === id);
    if (idx < 0) {
      entries.push({ action: 'failed', kind: 'category', id, note: 'It was already gone, so nothing was deleted.', verified: true });
      continue;
    }
    if (!canDeleteCategory(cats, id)) {
      entries.push({ action: 'failed', kind: 'category', id, before: categoryFacts(cats[idx], idx), note: LAST_CATEGORY_MESSAGE, verified: true });
      continue;
    }
    entries.push({ action: 'deleted', kind: 'category', id, before: categoryFacts(cats[idx], beforeCats.findIndex(c => c.id === id)), verified: false });
    cats = cats.filter(c => c.id !== id);
  }
  for (const id of taskListIds) {
    const idx = lists.findIndex(l => l.id === id);
    if (idx < 0 || id === GENERAL_LIST_ID) {
      entries.push({ action: 'failed', kind: 'task_list', id, note: id === GENERAL_LIST_ID ? 'General cannot be deleted.' : 'It was already gone, so nothing was deleted.', verified: true });
      continue;
    }
    entries.push({ action: 'deleted', kind: 'task_list', id, before: taskListFacts(lists[idx], beforeLists.findIndex(l => l.id === id)), note: 'Its tasks now show under General.', verified: false });
    lists = lists.filter(l => l.id !== id);
  }

  const undo = [...diffList('category', beforeCats, cats), ...diffList('taskList', beforeLists, lists)];
  let settings: Record<string, unknown> | undefined;
  if (undo.length) {
    settings = { ...raw };
    if (cats !== beforeCats) settings.categories = cats;
    if (lists !== beforeLists) settings.taskLists = lists;
  }
  return { settings, entries, undo, deleted: entries.filter(e => e.action === 'deleted').length };
}

// ─── Prayers ─────────────────────────────────────────────────────────────────

const PRAYER_ALIASES: Record<string, PrayerKey> = {
  fajr: 'fajr', fajer: 'fajr', fajir: 'fajr', subh: 'fajr', sobh: 'fajr', dawn: 'fajr',
  sunrise: 'sunrise', shuruq: 'sunrise', shurooq: 'sunrise',
  dhuhr: 'dhuhr', duhr: 'dhuhr', zuhr: 'dhuhr', zohr: 'dhuhr', dhuhur: 'dhuhr', thuhr: 'dhuhr', noon: 'dhuhr',
  asr: 'asr', aser: 'asr', afternoon: 'asr',
  maghrib: 'maghrib', magrib: 'maghrib', maghreb: 'maghrib', sunset: 'maghrib',
  isha: 'isha', ishaa: 'isha', isya: 'isha', esha: 'isha', night: 'isha',
};

export function parsePrayerKey(raw: unknown, field: string): PrayerKey {
  if (typeof raw !== 'string') fail(`${field} must be a prayer name: fajr, dhuhr, asr, maghrib or isha.`);
  const q = (raw as string).trim().toLowerCase().replace(/[^a-z]/g, '');
  const key = PRAYER_ALIASES[q];
  if (!key) fail(`${field} "${raw}" is not a prayer. Use fajr, dhuhr, asr, maghrib or isha.`);
  return key!;
}

function prayerFacts(date: string, key: PrayerKey, done: boolean, world: AgentWorld): ItemFacts {
  const f: ItemFacts = { title: `${PRAYER_LABELS[key]} prayer`, kind: 'prayer', date, done, pointInTime: true };
  const day = world.prayersFor?.(date) as Record<string, string | undefined> | null | undefined;
  const t = day?.[key];
  if (typeof t === 'string' && /^\d{2}:\d{2}$/.test(t)) f.startTime = t;
  return f;
}

function setPrayerDone(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const items = list<unknown>(args.prayers, 'prayers', 60);
  const today = format(world.now, 'yyyy-MM-dd');
  const working: Record<string, Set<string>> = {};
  const isDone = (date: string, key: string) => (working[date] ?? new Set(world.prayerDone?.[date] ?? [])).has(key);
  const entries: ChangeEntry[] = [];
  const undo: UndoRecord[] = [];
  const toggles: Array<{ date: string; key: string; present: boolean }> = [];

  // Validate everything first: one bad row changes nothing.
  const parsed = items.map((raw, idx) => {
    if (!isRecord(raw)) fail(`prayers[${idx}] must be an object.`);
    const r = raw as Record<string, unknown>;
    const date = parseYmdStrict(r.date ?? today, `prayers[${idx}].date`);
    if (date > today) fail(`prayers[${idx}]: ${dayLabel(date)} has not happened yet, so it cannot be ticked off.`);
    const key = parsePrayerKey(r.prayer, `prayers[${idx}].prayer`);
    const done = r.done === undefined ? true : bool(r.done, `prayers[${idx}].done`);
    return { date, key, done };
  });

  for (const { date, key, done } of parsed) {
    const cur = isDone(date, key);
    if (cur === done) {
      entries.push({ action: 'skipped', kind: 'prayer', id: `${date}|${key}`, after: prayerFacts(date, key, cur, world), note: done ? 'It was already ticked off.' : 'It was not ticked off.', verified: true });
      continue;
    }
    const set = working[date] ?? new Set(world.prayerDone?.[date] ?? []);
    if (done) set.add(key); else set.delete(key);
    working[date] = set;
    // Two toggles of the same prayer in one call collapse to the final state.
    const prev = toggles.findIndex(t => t.date === date && t.key === key);
    if (prev >= 0) toggles.splice(prev, 1);
    toggles.push({ date, key, present: done });
    const rec = undo.findIndex(u => u.id === `${date}|${key}`);
    if (rec >= 0) undo[rec] = { ...undo[rec], after: { done } };
    else undo.push({ store: 'prayerDone', id: `${date}|${key}`, before: { done: cur }, after: { done } });
    entries.push({
      action: done ? 'completed' : 'reopened', kind: 'prayer', id: `${date}|${key}`,
      before: prayerFacts(date, key, cur, world), after: prayerFacts(date, key, done, world), changed: ['done'], verified: false,
    });
  }
  // A toggle that a later row undid again is no change at all.
  const real = undo.filter(u => (u.before as { done: boolean }).done !== (u.after as { done: boolean }).done);
  const realToggles = toggles.filter(t => real.some(u => u.id === `${t.date}|${t.key}`));
  const ticked = realToggles.filter(t => t.present).length;
  const unticked = realToggles.length - ticked;
  return {
    ...(realToggles.length ? { prayerToggles: realToggles } : {}),
    entries,
    undo: real,
    result: { ticked, unticked, skipped: entries.filter(e => e.action === 'skipped').length },
    label: [ticked ? `Ticked off ${ticked} prayer${ticked === 1 ? '' : 's'}` : '', unticked ? `un-ticked ${unticked}` : ''].filter(Boolean).join(', ') || 'No prayers changed',
  };
}

// ─── Focus timer ─────────────────────────────────────────────────────────────

export function timerText(t: FocusTimerState, now: number): string {
  const phase = focusPhase(t);
  const planned = minutesLabel(t.plannedSeconds / 60);
  const ran = minutesLabel(Math.floor(focusElapsedSeconds(t, now) / 60));
  if (phase === 'running') return `Running, ${ran} of ${planned}`;
  if (phase === 'paused') return `Paused at ${ran} of ${planned}`;
  return `Not running (${planned} sessions)`;
}

function timerFacts(t: FocusTimerState, now: number): ItemFacts {
  return { title: 'Focus timer', kind: 'focus_timer', value: timerText(t, now) };
}

export function sessionFacts(s: FocusSessionRecord, world: AgentWorld): ItemFacts {
  const tf = 'HH:mm';
  const f: ItemFacts = {
    title: `${Math.max(1, Math.round(s.durationSeconds / 60))}-minute focus session`,
    kind: 'focus_session',
    date: focusDayKey(s.endedAt ?? s.startedAt, world.focusDayStartHour),
    startTime: format(new Date(s.startedAt), tf),
  };
  if (s.endedAt) f.endTime = format(new Date(s.endedAt), tf);
  return f;
}

/** Newest first, deduplicated, capped: exactly what the server's own append writes. */
export function withSession(sessions: FocusSessionRecord[], s: FocusSessionRecord): FocusSessionRecord[] {
  return dedupeFocusHistory([s, ...sessions])
    .sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')))
    .slice(0, 1000);
}

function focusTimerTool(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  const action = String(args.action ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const actions = ['start', 'pause', 'resume', 'stop', 'set_length'];
  if (!actions.includes(action)) fail(`action must be one of: ${actions.join(', ')}.`);
  const minutes = args.minutes === undefined || args.minutes === null
    ? null
    : int(args.minutes, 'minutes', MIN_PLANNED_SECONDS / 60, MAX_PLANNED_SECONDS / 60);
  if (action === 'set_length' && minutes === null) fail('set_length needs minutes.');
  if ((action === 'pause' || action === 'stop') && minutes !== null) fail(`${action} takes no minutes.`);

  const now = world.now.getTime();
  const before = coerceFocusTimer(world.focusTimer);
  let state = before;
  let session: FocusSessionRecord | null = null;
  const notes: string[] = [];
  const step = (a: Parameters<typeof reduceFocusTimer>[1]) => {
    const out = reduceFocusTimer(state, a, now, AGENT_ORIGIN);
    state = out.state;
    if (out.session) session = out.session;
    return out.changed;
  };
  const phase = focusPhase(before);

  if (action === 'set_length') step({ kind: 'setPlanned', seconds: minutes! * 60 });
  else if (action === 'start') {
    if (minutes !== null) step({ kind: 'setPlanned', seconds: minutes * 60 });
    if (phase === 'running') notes.push('The timer was already running.');
    step({ kind: 'start' });
  } else if (action === 'resume') {
    if (phase === 'idle') fail('There is no paused session to resume. Use action "start" to begin one.');
    if (minutes !== null) step({ kind: 'setPlanned', seconds: minutes * 60 });
    if (phase === 'running') notes.push('The timer was already running.');
    step({ kind: 'resume' });
  } else if (action === 'pause') {
    if (phase !== 'running') notes.push(phase === 'paused' ? 'The timer was already paused.' : 'The timer was not running.');
    step({ kind: 'pause' });
  } else if (action === 'stop') {
    if (phase === 'idle') notes.push('The timer was not running, so there was nothing to stop.');
    step({ kind: 'stop' });
    if (phase !== 'idle' && !session) notes.push('Nothing beyond time already counted was run, so no session was logged.');
  }

  const changed = meaning({ ...state, updatedAt: 0, origin: null }) !== meaning({ ...before, updatedAt: 0, origin: null });
  const entries: ChangeEntry[] = [];
  const undo: UndoRecord[] = [];
  if (changed) {
    entries.push({
      action: 'updated', kind: 'focus_timer', id: 'timer',
      before: timerFacts(before, now), after: timerFacts(state, now), changed: ['value'],
      note: notes.join(' ') || undefined, verified: false,
    });
    undo.push({ store: 'focusTimer', id: 'timer', before: { ...before } as unknown as Record<string, unknown>, after: { ...state } as unknown as Record<string, unknown> });
  } else {
    entries.push({ action: 'skipped', kind: 'focus_timer', id: 'timer', after: timerFacts(state, now), note: notes.join(' ') || 'Nothing changed.', verified: true });
  }
  let sessions: FocusSessionRecord[] | undefined;
  const logged = session as FocusSessionRecord | null;
  if (logged) {
    sessions = withSession(world.focusSessions, logged);
    const prior = world.focusSessions.find(s => normaliseFocusSessionId(s.id) === normaliseFocusSessionId(logged.id)) ?? null;
    const stored = sessions.find(s => normaliseFocusSessionId(s.id) === normaliseFocusSessionId(logged.id)) ?? logged;
    undo.push({ store: 'focusSessions', id: stored.id, before: prior ? { ...prior } as unknown as Record<string, unknown> : null, after: { ...stored } as unknown as Record<string, unknown> });
    entries.push({ action: 'added', kind: 'focus_session', id: stored.id, after: sessionFacts(stored, world), note: 'Logged to your focus history.', verified: false });
  }
  return {
    ...(changed ? { focusTimer: state } : {}),
    ...(sessions ? { focusSessions: sessions } : {}),
    entries,
    undo,
    result: {
      timer: timerText(state, now),
      ...(logged ? { loggedSessionMinutes: Math.round(logged.durationSeconds / 60) } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    },
    label: !changed ? 'Focus timer unchanged'
      : action === 'set_length' ? `Set the focus length to ${minutesLabel(state.plannedSeconds / 60)}`
      : action === 'stop' ? `Stopped the focus timer${logged ? ` and logged ${minutesLabel(logged.durationSeconds / 60)}` : ''}`
      : action === 'pause' ? 'Paused the focus timer'
      : `Started the focus timer (${minutesLabel(state.plannedSeconds / 60)})`,
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** The effective (coerced) value of every setting this tool may change. */
function effective(raw: Record<string, unknown>) {
  const ws = Number(raw.weekStartsOn);
  return {
    weekStartsOn: Number.isInteger(ws) && ws >= 0 && ws <= 6 ? ws : 1,
    timeFormat: raw.timeFormat === '24h' ? '24h' : '12h',
    taskColor: typeof raw.taskColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.taskColor) ? raw.taskColor : '#7dd3fc',
    taskCheckboxShape: raw.taskCheckboxShape === 'square' ? 'square' : 'circle',
    autoRollRecurringTasks: typeof raw.autoRollRecurringTasks === 'boolean' ? raw.autoRollRecurringTasks : true,
    overlapLayout: raw.overlapLayout === 'columns' ? 'columns' : 'fit',
    focusDailyGoalSeconds: typeof raw.focusDailyGoalSeconds === 'number' && Number.isFinite(raw.focusDailyGoalSeconds)
      ? Math.max(0, Math.min(24 * 3600, Math.round(raw.focusDailyGoalSeconds))) : 0,
    focusDayStartHour: typeof raw.focusDayStartHour === 'number' ? Math.max(0, Math.min(23, Math.round(raw.focusDayStartHour))) : 4,
    focusExcludedDates: Array.isArray(raw.focusExcludedDates) ? (raw.focusExcludedDates as unknown[]).filter((d): d is string => typeof d === 'string') : [],
    notifications: coerceNotificationSettings(raw.notifications),
    prayer: coercePrayerSettings(raw.prayer),
  };
}
type Effective = ReturnType<typeof effective>;

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Set one leaf on the RAW settings. A missing parent object starts as its full
 * effective value, so writing one notification default never leaves a partial
 * `notifications` object that reads differently from what the user saw.
 */
function setPath(raw: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const out = { ...raw };
  if (parts.length === 1) {
    if (value === undefined) delete out[parts[0]]; else out[parts[0]] = value;
    return out;
  }
  const [head, ...rest] = parts;
  const eff = effective(raw) as unknown as Record<string, unknown>;
  const parent = isRecord(raw[head]) ? { ...(raw[head] as Record<string, unknown>) } : { ...(eff[head] as Record<string, unknown>) };
  out[head] = setPath(parent, rest.join('.'), value);
  return out;
}

const HOUR = (h: number) => `${String(h).padStart(2, '0')}:00`;

interface SettingSpec {
  path: string;
  label: string;
  text: (v: unknown) => string;
}

const specText = (v: unknown) => remindersLabel(v as NotifySpec) ?? 'Default';
const onOff = (v: unknown) => (v ? 'On' : 'Off');

const SETTINGS: Record<string, SettingSpec> = {
  weekStartsOn: { path: 'weekStartsOn', label: 'Week starts on', text: v => WEEKDAYS[Number(v)] ?? String(v) },
  timeFormat: { path: 'timeFormat', label: 'Time format', text: v => (v === '24h' ? '24-hour' : '12-hour') },
  taskColor: { path: 'taskColor', label: 'Task colour on the calendar', text: v => String(v) },
  taskCheckboxShape: { path: 'taskCheckboxShape', label: 'Task checkbox shape', text: v => (v === 'square' ? 'Square' : 'Circle') },
  autoRollRecurringTasks: { path: 'autoRollRecurringTasks', label: 'Roll overdue repeating tasks to today', text: onOff },
  overlapLayout: { path: 'overlapLayout', label: 'Overlapping items', text: v => (v === 'columns' ? 'Equal columns' : 'Split only where they overlap') },
  focusDailyGoalSeconds: { path: 'focusDailyGoalSeconds', label: 'Daily focus goal', text: v => (Number(v) > 0 ? minutesLabel(Number(v) / 60) : 'No goal') },
  focusDayStartHour: { path: 'focusDayStartHour', label: 'Focus day starts at', text: v => HOUR(Number(v)) },
  focusExcludedDates: { path: 'focusExcludedDates', label: 'Days left out of focus streaks', text: v => ((v as string[]).length ? (v as string[]).map(dayLabel).join(', ') : 'None') },
  'notifications.enabled': { path: 'notifications.enabled', label: 'Reminders', text: onOff },
  'notifications.sound': { path: 'notifications.sound', label: 'Reminder sound', text: onOff },
  'notifications.allDayHour': { path: 'notifications.allDayHour', label: 'All-day reminders fire at', text: v => HOUR(Number(v)) },
  'notifications.taskCutoffHour': { path: 'notifications.taskCutoffHour', label: 'Unfinished-tasks digest at', text: v => HOUR(Number(v)) },
  'notifications.defaultTimed': { path: 'notifications.defaultTimed', label: 'Default reminders, timed items', text: specText },
  'notifications.defaultAllDay': { path: 'notifications.defaultAllDay', label: 'Default reminders, all-day items', text: specText },
  'notifications.defaultTask': { path: 'notifications.defaultTask', label: 'Default reminders, tasks', text: specText },
  'notifications.prayer': { path: 'notifications.prayer', label: 'Prayer reminders', text: specText },
  'notifications.quietHoursEnabled': { path: 'notifications.quietHoursEnabled', label: 'Quiet hours', text: onOff },
  'notifications.quietFromH': { path: 'notifications.quietFromH', label: 'Quiet hours start', text: v => HOUR(Number(v)) },
  'notifications.quietToH': { path: 'notifications.quietToH', label: 'Quiet hours end', text: v => HOUR(Number(v)) },
  'prayer.enabled': { path: 'prayer.enabled', label: 'Prayer times on the calendar', text: onOff },
  'prayer.city': { path: 'prayer.city', label: 'Prayer times city', text: v => String(v) },
  'prayer.country': { path: 'prayer.country', label: 'Prayer times country', text: v => String(v) },
  'prayer.method': { path: 'prayer.method', label: 'Prayer calculation method', text: v => PRAYER_METHODS.find(m => m.id === v)?.label ?? String(v) },
  'prayer.school': { path: 'prayer.school', label: 'Asr calculation', text: v => (v === 1 ? 'Hanafi' : 'Standard (Shafi, Maliki, Hanbali)') },
  'prayer.showSunrise': { path: 'prayer.showSunrise', label: 'Show sunrise', text: onOff },
  'prayer.showInWidget': { path: 'prayer.showInWidget', label: 'Prayers in the side widget', text: onOff },
  'prayer.color': { path: 'prayer.color', label: 'Prayer colour', text: v => String(v) },
  'prayer.hidden': { path: 'prayer.hidden', label: 'Hidden prayers', text: v => ((v as string[]).length ? (v as PrayerKey[]).map(k => PRAYER_LABELS[k]).join(', ') : 'None') },
  'prayer.offsets': { path: 'prayer.offsets', label: 'Prayer time corrections', text: v => {
    const o = v as Partial<Record<PrayerKey, number>>;
    const parts = PRAYER_KEYS.filter(k => o[k]).map(k => `${PRAYER_LABELS[k]} ${o[k]! > 0 ? '+' : ''}${o[k]} min`);
    return parts.length ? parts.join(', ') : 'None';
  } },
};

/** Reminder defaults have no "inherit": "default" puts the app's own default back. */
function defaultSpec(raw: unknown, field: string, fallback: NotifySpec): NotifySpec {
  const r = parseReminders(raw);
  if (r === undefined) fail(`${field} is missing.`);
  return r === 'inherit' ? { ...fallback, rules: fallback.rules.map(x => ({ ...x })) } : r as NotifySpec;
}

/** Parse the model's `set` object into leaf path -> new effective value. */
function parseSettingsSet(set: Record<string, unknown>, eff: Effective): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const known = ['weekStartsOn', 'timeFormat', 'taskColor', 'taskCheckboxShape', 'autoRollRecurringTasks', 'overlapLayout',
    'focusDailyGoalMinutes', 'focusDayStartHour', 'focusExcludeDates', 'focusIncludeDates', 'reminders', 'prayerTimes'];
  const unknownKey = Object.keys(set).find(k => !known.includes(k));
  if (unknownKey) fail(`"${unknownKey}" is not a setting this tool can change. It can change: ${known.join(', ')}.`);

  if (set.weekStartsOn !== undefined) {
    const v = set.weekStartsOn;
    let idx = -1;
    if (typeof v === 'number') idx = v;
    else if (typeof v === 'string' && v.trim().length >= 3) {
      const q = v.trim().toLowerCase().slice(0, 3);
      idx = WEEKDAYS.findIndex(d => d.toLowerCase().startsWith(q));
    }
    if (!Number.isInteger(idx) || idx < 0 || idx > 6) fail('weekStartsOn must be a weekday name, e.g. "monday".');
    out.set('weekStartsOn', idx);
  }
  if (set.timeFormat !== undefined) {
    const v = String(set.timeFormat).toLowerCase().replace(/[^0-9h]/g, '');
    if (v !== '12h' && v !== '24h' && v !== '12' && v !== '24') fail('timeFormat must be "12h" or "24h".');
    out.set('timeFormat', v.startsWith('24') ? '24h' : '12h');
  }
  if (set.taskColor !== undefined) out.set('taskColor', parseColor(set.taskColor, 'taskColor'));
  if (set.taskCheckboxShape !== undefined) {
    if (set.taskCheckboxShape !== 'circle' && set.taskCheckboxShape !== 'square') fail('taskCheckboxShape must be "circle" or "square".');
    out.set('taskCheckboxShape', set.taskCheckboxShape);
  }
  if (set.autoRollRecurringTasks !== undefined) out.set('autoRollRecurringTasks', bool(set.autoRollRecurringTasks, 'autoRollRecurringTasks'));
  if (set.overlapLayout !== undefined) {
    if (set.overlapLayout !== 'fit' && set.overlapLayout !== 'columns') fail('overlapLayout must be "fit" or "columns".');
    out.set('overlapLayout', set.overlapLayout);
  }
  if (set.focusDailyGoalMinutes !== undefined) out.set('focusDailyGoalSeconds', int(set.focusDailyGoalMinutes, 'focusDailyGoalMinutes', 0, 1440) * 60);
  if (set.focusDayStartHour !== undefined) out.set('focusDayStartHour', int(set.focusDayStartHour, 'focusDayStartHour', 0, 23));
  if (set.focusExcludeDates !== undefined || set.focusIncludeDates !== undefined) {
    const next = new Set(eff.focusExcludedDates);
    const dates = (raw: unknown, f: string) => {
      if (!Array.isArray(raw)) fail(`${f} must be a list of dates.`);
      return (raw as unknown[]).map((d, i) => parseYmdStrict(d, `${f}[${i}]`));
    };
    if (set.focusExcludeDates !== undefined) for (const d of dates(set.focusExcludeDates, 'focusExcludeDates')) next.add(d);
    if (set.focusIncludeDates !== undefined) for (const d of dates(set.focusIncludeDates, 'focusIncludeDates')) next.delete(d);
    out.set('focusExcludedDates', [...next].sort());
  }
  if (set.reminders !== undefined) {
    if (!isRecord(set.reminders)) fail('reminders must be an object.');
    const r = set.reminders as Record<string, unknown>;
    const okKeys = ['enabled', 'sound', 'allDayHour', 'taskCutoffHour', 'timedDefault', 'allDayDefault', 'taskDefault', 'prayerReminders', 'quietHours'];
    const bad = Object.keys(r).find(k => !okKeys.includes(k));
    if (bad) fail(`reminders.${bad} is not a reminder setting. Use: ${okKeys.join(', ')}.`);
    if (r.enabled !== undefined) out.set('notifications.enabled', bool(r.enabled, 'reminders.enabled'));
    if (r.sound !== undefined) out.set('notifications.sound', bool(r.sound, 'reminders.sound'));
    if (r.allDayHour !== undefined) out.set('notifications.allDayHour', int(r.allDayHour, 'reminders.allDayHour', 0, 23));
    if (r.taskCutoffHour !== undefined) out.set('notifications.taskCutoffHour', int(r.taskCutoffHour, 'reminders.taskCutoffHour', 0, 23));
    if (r.timedDefault !== undefined) out.set('notifications.defaultTimed', defaultSpec(r.timedDefault, 'reminders.timedDefault', DEFAULT_TIMED_SPEC));
    if (r.allDayDefault !== undefined) out.set('notifications.defaultAllDay', defaultSpec(r.allDayDefault, 'reminders.allDayDefault', DEFAULT_ALL_DAY_SPEC));
    if (r.taskDefault !== undefined) out.set('notifications.defaultTask', defaultSpec(r.taskDefault, 'reminders.taskDefault', DEFAULT_TASK_SPEC));
    if (r.prayerReminders !== undefined) out.set('notifications.prayer', defaultSpec(r.prayerReminders, 'reminders.prayerReminders', DEFAULT_PRAYER_SPEC));
    if (r.quietHours !== undefined) {
      if (r.quietHours === false || r.quietHours === 'off') out.set('notifications.quietHoursEnabled', false);
      else {
        if (!isRecord(r.quietHours)) fail('reminders.quietHours must be {"enabled":true,"from":23,"to":7} or "off".');
        const q = r.quietHours as Record<string, unknown>;
        out.set('notifications.quietHoursEnabled', q.enabled === undefined ? true : bool(q.enabled, 'reminders.quietHours.enabled'));
        if (q.from !== undefined) out.set('notifications.quietFromH', int(q.from, 'reminders.quietHours.from', 0, 23));
        if (q.to !== undefined) out.set('notifications.quietToH', int(q.to, 'reminders.quietHours.to', 0, 23));
      }
    }
  }
  if (set.prayerTimes !== undefined) {
    if (!isRecord(set.prayerTimes)) fail('prayerTimes must be an object.');
    const p = set.prayerTimes as Record<string, unknown>;
    const okKeys = ['enabled', 'city', 'country', 'method', 'school', 'showSunrise', 'showInWidget', 'color', 'hide', 'show', 'offsets'];
    const bad = Object.keys(p).find(k => !okKeys.includes(k));
    if (bad) fail(`prayerTimes.${bad} is not a prayer setting. Use: ${okKeys.join(', ')}.`);
    if (p.enabled !== undefined) out.set('prayer.enabled', bool(p.enabled, 'prayerTimes.enabled'));
    if (p.city !== undefined) out.set('prayer.city', str(p.city, 'prayerTimes.city', 80));
    if (p.country !== undefined) out.set('prayer.country', str(p.country, 'prayerTimes.country', 80));
    if (p.method !== undefined) {
      const q = typeof p.method === 'string' ? p.method.trim().toLowerCase() : '';
      const m = typeof p.method === 'number' ? PRAYER_METHODS.find(x => x.id === p.method)
        : q ? (PRAYER_METHODS.find(x => String(x.id) === q) ?? PRAYER_METHODS.find(x => x.label.toLowerCase().includes(q))) : undefined;
      if (!m) fail(`prayerTimes.method must be one of: ${PRAYER_METHODS.map(x => `${x.id} (${x.label})`).join(', ')}.`);
      out.set('prayer.method', m!.id);
    }
    if (p.school !== undefined) {
      const v = String(p.school).toLowerCase();
      if (!['standard', 'shafi', 'hanafi', '0', '1'].includes(v)) fail('prayerTimes.school must be "standard" or "hanafi".');
      out.set('prayer.school', v === 'hanafi' || v === '1' ? 1 : 0);
    }
    if (p.showSunrise !== undefined) out.set('prayer.showSunrise', bool(p.showSunrise, 'prayerTimes.showSunrise'));
    if (p.showInWidget !== undefined) out.set('prayer.showInWidget', bool(p.showInWidget, 'prayerTimes.showInWidget'));
    if (p.color !== undefined) out.set('prayer.color', parseColor(p.color, 'prayerTimes.color'));
    if (p.hide !== undefined || p.show !== undefined) {
      const hidden = new Set<PrayerKey>(eff.prayer.hidden);
      const keys = (raw: unknown, f: string) => {
        if (!Array.isArray(raw)) fail(`${f} must be a list of prayer names.`);
        return (raw as unknown[]).map((k, i) => parsePrayerKey(k, `${f}[${i}]`));
      };
      if (p.hide !== undefined) for (const k of keys(p.hide, 'prayerTimes.hide')) hidden.add(k);
      if (p.show !== undefined) for (const k of keys(p.show, 'prayerTimes.show')) hidden.delete(k);
      out.set('prayer.hidden', PRAYER_KEYS.filter(k => hidden.has(k)));
    }
    if (p.offsets !== undefined) {
      if (!isRecord(p.offsets)) fail('prayerTimes.offsets must be like {"isha": 5, "fajr": -2} (minutes).');
      const next: Partial<Record<PrayerKey, number>> = { ...eff.prayer.offsets };
      for (const [k, v] of Object.entries(p.offsets as Record<string, unknown>)) {
        const key = parsePrayerKey(k, 'prayerTimes.offsets');
        const n = int(v, `prayerTimes.offsets.${k}`, -60, 60);
        if (n === 0) delete next[key]; else next[key] = n;
      }
      out.set('prayer.offsets', next);
    }
  }
  if (!out.size) fail('set lists no settings to change.');
  return out;
}

function updateSettings(args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  if (!isRecord(args.set)) fail('set must be an object of settings to change.');
  const raw = rawSettingsOf(world);
  const eff = effective(raw);
  const leaves = parseSettingsSet(args.set as Record<string, unknown>, eff);
  let next = raw;
  const entries: ChangeEntry[] = [];
  const undo: UndoRecord[] = [];
  for (const [path, value] of leaves) {
    const spec = SETTINGS[path];
    const old = getPath(eff, path);
    const facts = (v: unknown): ItemFacts => ({ title: spec.label, kind: 'setting', value: spec.text(v) });
    if (meaning({ v: old }) === meaning({ v: value })) {
      entries.push({ action: 'skipped', kind: 'setting', id: path, after: facts(old), note: 'It was already set like that.', verified: true });
      continue;
    }
    next = setPath(next, path, value);
    // Recorded as it will READ BACK, so verification and Undo compare like with like.
    const landed = getPath(effective(next), path);
    if (meaning({ v: old }) === meaning({ v: landed })) {
      next = setPath(next, path, old);
      entries.push({ action: 'skipped', kind: 'setting', id: path, after: facts(old), note: 'It was already set like that.', verified: true });
      continue;
    }
    undo.push({ store: 'settings', id: `key:${path}`, before: { v: old as unknown }, after: { v: landed } });
    entries.push({ action: 'updated', kind: 'setting', id: path, before: facts(old), after: facts(landed), changed: ['value'], verified: false });
  }
  const n = undo.length;
  return {
    ...(n ? { settings: next } : {}),
    entries,
    undo,
    result: { changed: entries.filter(e => e.action === 'updated').map(e => ({ setting: e.after!.title, now: e.after!.value })), unchanged: entries.filter(e => e.action === 'skipped').length },
    label: n ? `Changed ${n} setting${n === 1 ? '' : 's'}` : 'No settings changed',
  };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const remindersArg = {
  description: '"default" (inherit the app default), "off", or {"minutesBefore":[0,30],"critical":false}.',
  anyOf: [
    { type: 'string', enum: ['default', 'off'] },
    { type: 'object', properties: { minutesBefore: { type: 'array', items: { type: 'integer' } }, critical: { type: 'boolean' } } },
  ],
};

export const PLANNER_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'manage_categories',
      description: 'Create, edit or reorder EVENT categories (the colours and defaults calendar items use). Pass every change of a request in one call. Deleting a category is done with delete_items (categories: [names]).',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['create', 'update', 'move'] },
                category: { type: 'string', description: 'update/move: the existing category name.' },
                name: { type: 'string', description: 'create: the new category name.' },
                newName: { type: 'string', description: 'update: rename to this.' },
                color: { type: 'string', description: 'Hex like "#22c55e" or a colour word (teal, orange, purple...). Omit on create to get an unused preset colour.' },
                defaultMinutes: { type: 'integer', description: 'Default length of new items in minutes (0 = a moment with no duration).' },
                pointInTime: { type: 'boolean', description: 'New items are moments with no duration (deadlines).' },
                allDay: { type: 'boolean', description: 'New items are all-day by default.' },
                checkbox: { type: 'boolean', description: 'Items show a completion checkbox.' },
                showInWidget: { type: 'boolean', description: 'Items appear in the side widget.' },
                makeDefault: { type: 'boolean', description: 'Pick this category automatically for new items (only one can be the default).' },
                description: { type: 'string' },
                remindersTimed: { ...remindersArg, description: `Reminders for timed items in this category. ${remindersArg.description}` },
                remindersAllDay: { ...remindersArg, description: `Reminders for all-day items in this category. ${remindersArg.description}` },
                position: { type: 'integer', description: 'move: new 1-based position.' },
              },
              required: ['action'],
            },
          },
        },
        required: ['changes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_task_lists',
      description: 'Create, rename, recolour or reorder TASK lists (the sections of the task board; separate from event categories). Deleting a list is done with delete_items (taskLists: [names]); its tasks move to General.',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['create', 'update', 'move'] },
                list: { type: 'string', description: 'update/move: the existing list name.' },
                name: { type: 'string', description: 'create: the new list name.' },
                newName: { type: 'string' },
                color: { type: 'string', description: 'Hex or a colour word. Omit on create for an unused colour.' },
                position: { type: 'integer', description: 'move: new 1-based position.' },
              },
              required: ['action'],
            },
          },
        },
        required: ['changes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_prayer_done',
      description: 'Tick prayers off (or un-tick them) for today or past days, exactly like tapping them in the app.',
      parameters: {
        type: 'object',
        properties: {
          prayers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prayer: { type: 'string', enum: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] },
                date: { type: 'string', description: 'YYYY-MM-DD, default today. Never a future day.' },
                done: { type: 'boolean', description: 'true = ticked off (default), false = not done.' },
              },
              required: ['prayer'],
            },
          },
        },
        required: ['prayers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'focus_timer',
      description: 'Control the focus timer, exactly like its buttons: start (optionally with a length), pause, resume, stop (logs the session to their history), or set_length. Check get_focus_stats first if you need its current state.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'set_length'] },
          minutes: { type: 'integer', description: 'Session length in minutes (1 to 720), for start, resume or set_length.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_settings',
      description: 'Change planner settings that apply on every device. Only the fields you pass change.',
      parameters: {
        type: 'object',
        properties: {
          set: {
            type: 'object',
            properties: {
              weekStartsOn: { type: 'string', description: 'Weekday name, e.g. "monday".' },
              timeFormat: { type: 'string', enum: ['12h', '24h'] },
              taskColor: { type: 'string', description: 'The colour tasks wear on the calendar grid.' },
              taskCheckboxShape: { type: 'string', enum: ['circle', 'square'] },
              autoRollRecurringTasks: { type: 'boolean', description: 'Move overdue repeating tasks to today when the next one comes up.' },
              overlapLayout: { type: 'string', enum: ['fit', 'columns'], description: 'How overlapping items share a day: "fit" splits only where they overlap, "columns" gives equal columns.' },
              focusDailyGoalMinutes: { type: 'integer', description: 'Daily focus goal in minutes, 0 = no goal.' },
              focusDayStartHour: { type: 'integer', description: 'Hour (0 to 23) a focus day starts; later sessions count to the previous day.' },
              focusExcludeDates: { type: 'array', items: { type: 'string' }, description: 'YYYY-MM-DD days to leave out of focus streaks.' },
              focusIncludeDates: { type: 'array', items: { type: 'string' }, description: 'Days to count in streaks again.' },
              reminders: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean', description: 'Master switch for every reminder.' },
                  sound: { type: 'boolean' },
                  allDayHour: { type: 'integer', description: 'Hour an all-day item counts as starting, for its reminders.' },
                  taskCutoffHour: { type: 'integer', description: 'Hour unfinished dated tasks are sent as one digest.' },
                  timedDefault: remindersArg,
                  allDayDefault: remindersArg,
                  taskDefault: remindersArg,
                  prayerReminders: remindersArg,
                  quietHours: { description: '"off" or {"enabled":true,"from":23,"to":7}.' },
                },
              },
              prayerTimes: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  city: { type: 'string' },
                  country: { type: 'string' },
                  method: { type: 'integer', description: `Calculation method id: ${PRAYER_METHODS.map(m => `${m.id} = ${m.label}`).join('; ')}.` },
                  school: { type: 'string', enum: ['standard', 'hanafi'] },
                  showSunrise: { type: 'boolean' },
                  showInWidget: { type: 'boolean' },
                  color: { type: 'string' },
                  hide: { type: 'array', items: { type: 'string' }, description: 'Prayers to stop showing.' },
                  show: { type: 'array', items: { type: 'string' }, description: 'Prayers to show again.' },
                  offsets: { type: 'object', description: 'Minutes to shift a prayer time to match a local mosque, e.g. {"isha": 5}. 0 removes the correction.' },
                },
              },
            },
          },
        },
        required: ['set'],
      },
    },
  },
] as const;

export const PLANNER_TOOL_NAMES: ReadonlySet<string> = new Set(PLANNER_TOOL_DEFS.map(t => t.function.name));

export function runPlannerTool(name: string, args: Record<string, unknown>, world: AgentWorld): ToolOutcome {
  switch (name) {
    case 'manage_categories': return manageCategories(args, world);
    case 'manage_task_lists': return manageTaskLists(args, world);
    case 'set_prayer_done': return setPrayerDone(args, world);
    case 'focus_timer': return focusTimerTool(args, world);
    case 'update_settings': return updateSettings(args, world);
  }
  return fail(`Unhandled tool "${name}".`);
}

// ─── Undo for everything above ───────────────────────────────────────────────

export interface Skip { id: string; store: string }

/**
 * Put back what settings records changed, record by record, ONLY where the
 * thing still means exactly what the change left. A category the user edited
 * since, a setting they changed again, an order they rearranged: all left
 * alone and reported, never overwritten.
 */
export function undoSettingsRecords(
  records: UndoRecord[],
  rawIn: Record<string, unknown>,
): { settings: Record<string, unknown>; restored: number; skipped: Skip[]; touched: boolean } {
  let raw = { ...rawIn };
  let restored = 0;
  let touched = false;
  const skipped: Skip[] = [];
  const settingsRecs = records.filter(r => r.store === 'settings');

  const restoreList = <T extends { id: string }>(
    prefix: 'category' | 'taskList',
    field: 'categories' | 'taskLists',
    coerce: (v: unknown) => T[],
    canRemove: (items: T[], id: string) => boolean,
  ) => {
    const recs = settingsRecs.filter(r => r.id.startsWith(`${prefix}:`));
    if (!recs.length) return;
    let items = coerce(raw[field]);
    let changed = false;
    // Re-inserts go lowest position first, so each lands where it was.
    const ordered = [...recs].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    for (const r of ordered) {
      const id = r.id.slice(prefix.length + 1);
      const cur = items.find(x => x.id === id) ?? null;
      if (meaning(cur) !== meaning(r.after)) { skipped.push({ id: r.id, store: 'settings' }); continue; }
      if (!r.before) {
        if (!cur) { restored++; continue; }
        if (!canRemove(items, id)) { skipped.push({ id: r.id, store: 'settings' }); continue; }
        items = items.filter(x => x.id !== id);
      } else if (!cur) {
        const at = Math.max(0, Math.min(items.length, r.position ?? items.length));
        items = [...items.slice(0, at), { ...(r.before as unknown as T) }, ...items.slice(at)];
      } else {
        items = items.map(x => (x.id === id ? { ...(r.before as unknown as T) } : x));
      }
      changed = true;
      restored++;
    }
    // At most one default category, whatever order the restores happened in.
    if (prefix === 'category' && changed) {
      const defaults = (items as unknown as EventCategory[]).filter(c => c.isDefault);
      if (defaults.length > 1) {
        const keep = recs.find(r => (r.before as { isDefault?: boolean } | null)?.isDefault)?.id.slice(9) ?? defaults[0].id;
        items = (items as unknown as EventCategory[]).map(c => ({ ...c, isDefault: c.id === keep })) as unknown as T[];
      }
    }
    const orderRec = settingsRecs.find(r => r.id === `${field}#order`);
    if (orderRec) {
      const afterIds = (orderRec.after as { ids: string[] }).ids;
      const beforeIds = (orderRec.before as { ids: string[] }).ids;
      const curIds = items.map(x => x.id);
      const curCommon = curIds.filter(id => afterIds.includes(id));
      const afterCommon = afterIds.filter(id => curIds.includes(id));
      if (curCommon.join('\u0000') !== afterCommon.join('\u0000')) skipped.push({ id: orderRec.id, store: 'settings' });
      else {
        const rank = (id: string) => { const i = beforeIds.indexOf(id); return i < 0 ? beforeIds.length + curIds.indexOf(id) : i; };
        const sorted = [...items].sort((a, b) => rank(a.id) - rank(b.id));
        if (sorted.map(x => x.id).join('\u0000') !== curIds.join('\u0000')) { items = sorted; changed = true; }
        restored++;
      }
    }
    if (changed) { raw = { ...raw, [field]: items }; touched = true; }
  };

  restoreList('category', 'categories', v => coerceCategories(v), (items, id) => canDeleteCategory(items as unknown as EventCategory[], id));
  restoreList('taskList', 'taskLists', v => coerceTaskLists(v), (_items, id) => id !== GENERAL_LIST_ID);

  for (const r of settingsRecs.filter(x => x.id.startsWith('key:'))) {
    const path = r.id.slice(4);
    const cur = getPath(effective(raw), path);
    if (meaning({ v: cur }) !== meaning({ v: (r.after as { v: unknown }).v })) { skipped.push({ id: r.id, store: 'settings' }); continue; }
    raw = setPath(raw, path, (r.before as { v: unknown }).v);
    touched = true;
    restored++;
  }
  return { settings: raw, restored, skipped, touched };
}

/** Prayer ticks: the toggles that put them back, where nobody has re-ticked since. */
export function undoPrayerRecords(
  records: UndoRecord[],
  done: Record<string, string[]>,
): { toggles: Array<{ date: string; key: string; present: boolean }>; restored: number; skipped: Skip[] } {
  const toggles: Array<{ date: string; key: string; present: boolean }> = [];
  const skipped: Skip[] = [];
  let restored = 0;
  for (const r of records.filter(x => x.store === 'prayerDone')) {
    const [date, key] = r.id.split('|');
    const cur = !!done[date]?.includes(key);
    if (cur !== !!(r.after as { done: boolean }).done) { skipped.push({ id: r.id, store: 'prayerDone' }); continue; }
    const want = !!(r.before as { done: boolean }).done;
    if (want !== cur) toggles.push({ date, key, present: want });
    restored++;
  }
  return { toggles, restored, skipped };
}

/** Two timer states that describe the same session at `now`, give or take a tick. */
export function sameTimer(a: unknown, b: unknown, now: number): boolean {
  const x = coerceFocusTimer(a);
  const y = coerceFocusTimer(b);
  return focusPhase(x) === focusPhase(y)
    && x.sessionStartedAt === y.sessionStartedAt
    && x.plannedSeconds === y.plannedSeconds
    && x.creditedSeconds === y.creditedSeconds
    && Math.abs(focusElapsedSeconds(x, now) - focusElapsedSeconds(y, now)) <= 2;
}

/**
 * The focus timer and history, put back where untouched since.
 *
 * A restored timer keeps its ORIGINAL anchor: undoing a pause makes the session
 * read as if it had never been paused, which is what "undo the pause" means.
 * A session the stop logged is taken out of the history again.
 */
export function undoFocusRecords(
  records: UndoRecord[],
  sessions: FocusSessionRecord[],
  timer: FocusTimerState | null,
  now: number,
): { sessions?: FocusSessionRecord[]; timer?: FocusTimerState; restored: number; skipped: Skip[] } {
  const skipped: Skip[] = [];
  let restored = 0;
  let nextTimer: FocusTimerState | undefined;
  let nextSessions: FocusSessionRecord[] | undefined;

  for (const r of records.filter(x => x.store === 'focusTimer')) {
    if (!sameTimer(timer, r.after, now)) { skipped.push({ id: r.id, store: 'focusTimer' }); continue; }
    nextTimer = { ...coerceFocusTimer(r.before), updatedAt: now, origin: AGENT_ORIGIN };
    restored++;
  }

  let list = [...sessions];
  for (const r of records.filter(x => x.store === 'focusSessions')) {
    const norm = normaliseFocusSessionId(r.id);
    const cur = list.find(s => normaliseFocusSessionId(s.id) === norm) ?? null;
    if (meaning(cur) !== meaning(r.after)) {
      // Already exactly as it was before (restored once already, or never
      // landed): nothing to do, and nothing to report as lost.
      if (meaning(cur) === meaning(r.before)) { restored++; continue; }
      skipped.push({ id: r.id, store: 'focusSessions' });
      continue;
    }
    list = list.filter(s => normaliseFocusSessionId(s.id) !== norm);
    if (r.before) list = withSession(list, r.before as unknown as FocusSessionRecord);
    nextSessions = list;
    restored++;
  }
  return { ...(nextTimer ? { timer: nextTimer } : {}), ...(nextSessions ? { sessions: nextSessions } : {}), restored, skipped };
}

/** Did each record land as written? Keys are `${store}:${id}`. */
export function verifyPlannerRecords(
  records: UndoRecord[],
  stores: { settings: Record<string, unknown>; prayerDone: Record<string, string[]>; focusSessions: FocusSessionRecord[]; focusTimer: FocusTimerState | null },
  now: number,
): Set<string> {
  const ok = new Set<string>();
  const cats = coerceCategories(stores.settings.categories);
  const lists = coerceTaskLists(stores.settings.taskLists);
  const eff = effective(stores.settings);
  for (const r of records) {
    let good = false;
    if (r.store === 'settings') {
      if (r.id.startsWith('category:')) good = meaning(cats.find(c => c.id === r.id.slice(9)) ?? null) === meaning(r.after);
      else if (r.id.startsWith('taskList:')) good = meaning(lists.find(l => l.id === r.id.slice(9)) ?? null) === meaning(r.after);
      else if (r.id.endsWith('#order')) {
        const ids = (r.id.startsWith('categories') ? cats : lists).map(x => x.id);
        good = ids.join('\u0000') === (r.after as { ids: string[] }).ids.filter(id => ids.includes(id)).join('\u0000');
      } else if (r.id.startsWith('key:')) good = meaning({ v: getPath(eff, r.id.slice(4)) }) === meaning({ v: (r.after as { v: unknown }).v });
    } else if (r.store === 'prayerDone') {
      const [date, key] = r.id.split('|');
      good = !!stores.prayerDone[date]?.includes(key) === !!(r.after as { done: boolean }).done;
    } else if (r.store === 'focusTimer') {
      good = sameTimer(stores.focusTimer, r.after, now);
    } else if (r.store === 'focusSessions') {
      const norm = normaliseFocusSessionId(r.id);
      good = meaning(stores.focusSessions.find(s => normaliseFocusSessionId(s.id) === norm) ?? null) === meaning(r.after);
    } else continue;
    if (good) ok.add(`${r.store}:${r.id}`);
  }
  return ok;
}
