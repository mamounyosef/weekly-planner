// Tests for the agent's setup, prayer, focus-timer and settings tools, and for
// Undo across every store (src/lib/agent/agentPlannerTools.ts + the parts of
// agentTools.ts that dispatch to them).
//
// The rules under test are the same as for events and tasks: every write is
// exactly what the report says, a refused call changes nothing, deleting a
// category or list never happens without Approve, and Undo puts back only what
// nobody has touched since.
//
// Run with: npx tsx src/lib/agent/agentPlannerTools.test.ts

import assert from 'node:assert/strict';

import {
  runTool, applyDeletion, applyFocusDeletion, planUndoAll, verifyAll, entryVerified, TOOL_NAMES, READ_ONLY_TOOLS,
  type AgentWorld, type ToolOutcome, type UndoRecord, type UndoStores, type DeletionPlan,
} from './agentTools';
import {
  parseColor, parsePrayerKey, meaning, sameTimer, undoSettingsRecords, undoPrayerRecords, undoFocusRecords,
  verifyPlannerRecords, timerText, PLANNER_TOOL_NAMES,
} from './agentPlannerTools';
import { buildReport, summarize, diffsOf } from './agentReport';
import { buildSystemPrompt } from './agentPrompt';
import { coerceCategories, type EventCategory } from '../categories';
import { coerceTaskLists } from '../taskLists';
import { coerceNotificationSettings } from '../notifications';
import { coercePrayerSettings } from '../prayerTimes';
import { coerceFocusTimer, reduceFocusTimer, IDLE_FOCUS_TIMER, type FocusTimerState } from '../focusTimer';
import type { FocusSessionRecord } from '../focusStats';
import type { ChangeSet } from './agentTypes';

const NOW = new Date(2026, 9, 20, 15, 0, 0); // Tue 20 Oct 2026, 15:00
let seq = 0;
const nextId = () => `n${++seq}`;

const CATS: EventCategory[] = [
  { id: 'personal', name: 'Personal', color: '#22c55e', defaultDurationMin: 30, defaultNoDuration: false, defaultAllDay: false, defaultNoCheckbox: false, showInWidget: true, isDefault: true, description: '' },
  { id: 'uni', name: 'University Calender', color: '#f97316', defaultDurationMin: 60, defaultNoDuration: false, defaultAllDay: false, defaultNoCheckbox: true, showInWidget: true, isDefault: false, description: 'Lectures' },
  { id: 'deadlines', name: 'Deadlines', color: '#993600', defaultDurationMin: 0, defaultNoDuration: true, defaultAllDay: false, defaultNoCheckbox: false, showInWidget: true, isDefault: false, description: '' },
];

function settings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    weekStartsOn: 0,
    timeFormat: '12h',
    categories: CATS.map(c => ({ ...c })),
    taskLists: [
      { id: 'general', name: 'General', color: '#3b82f6' },
      { id: 'shopping', name: 'Shopping', color: '#22c55e' },
      { id: 'uni-list', name: 'University', color: '#f97316' },
    ],
    focusDailyGoalSeconds: 0,
    focusDayStartHour: 4,
    // Device keys ride along untouched.
    viewMode: 'week',
    shortcuts: { toggleTimer: 'Win+Shift+F1' },
    ...over,
  };
}

function world(over: Partial<AgentWorld> = {}): AgentWorld {
  const s = (over.settings ?? settings()) as Record<string, unknown>;
  return {
    now: NOW,
    timeZone: 'Asia/Amman',
    events: {
      lec: { id: 'lec', content: 'Lecture', categoryId: 'uni', color: '#f97316', weekKey: '2026-10-18', dayIndex: 3, startTime: '09:00', endTime: '10:00', deleted: false, updatedAt: 1 },
      lec2: { id: 'lec2', content: 'Lab', categoryId: 'uni', color: '#f97316', weekKey: '2026-10-18', dayIndex: 4, startTime: '09:00', endTime: '10:00', deleted: false, updatedAt: 1 },
      gone: { id: 'gone', content: 'Old', categoryId: 'uni', color: '#f97316', weekKey: '2026-10-18', dayIndex: 4, startTime: '09:00', endTime: '10:00', deleted: true, updatedAt: 1 },
    },
    tasks: {
      milk: { id: 'milk', title: 'Milk', listId: 'shopping', deleted: false, updatedAt: 1 },
      eggs: { id: 'eggs', title: 'Eggs', listId: 'shopping', deleted: false, updatedAt: 1 },
    },
    categories: coerceCategories(s.categories),
    taskLists: coerceTaskLists(s.taskLists),
    weekStartsOn: 0,
    dayStartH: 6,
    dayEndH: 24,
    timeFormat: '12h',
    calendars: [],
    prayersFor: (d: string) => (d <= '2026-10-31' ? { fajr: '05:01', sunrise: '06:20', dhuhr: '11:40', asr: '14:55', maghrib: '17:25', isha: '18:45' } : null),
    newId: nextId,
    focusSessions: [],
    focusTimer: null,
    focusDailyGoalSeconds: 0,
    focusExcludedDates: [],
    focusDayStartHour: 4,
    settings: s,
    prayerDone: { '2026-10-20': ['fajr'] },
    ...over,
  };
}

const call = (name: string, args: unknown, w = world()) => runTool(name, args, w);
const err = (o: ToolOutcome): string => {
  assert.equal(o.isError, true, `expected a refusal, got: ${JSON.stringify(o.result)}`);
  return String((o.result as { error: string }).error);
};
const ok = (o: ToolOutcome): ToolOutcome => {
  assert.ok(!o.isError, `unexpected refusal: ${JSON.stringify(o.result)}`);
  return o;
};
const catsOf = (o: ToolOutcome) => coerceCategories(o.settings!.categories);
const listsOf = (o: ToolOutcome) => coerceTaskLists(o.settings!.taskLists);

/** The stores a world would read back as, after applying an outcome. */
function storesAfter(w: AgentWorld, o: ToolOutcome): UndoStores {
  const done: Record<string, string[]> = JSON.parse(JSON.stringify(w.prayerDone ?? {}));
  for (const t of o.prayerToggles ?? []) {
    const set = new Set(done[t.date] ?? []);
    if (t.present) set.add(t.key); else set.delete(t.key);
    if (set.size) done[t.date] = [...set]; else delete done[t.date];
  }
  return {
    events: o.events ?? w.events,
    tasks: o.tasks ?? w.tasks,
    settings: o.settings ?? w.settings ?? {},
    prayerDone: done,
    focusSessions: o.focusSessions ?? w.focusSessions,
    focusTimer: o.focusTimer ?? w.focusTimer,
  };
}

/** A world whose stores are `s`. */
function worldFrom(s: UndoStores, over: Partial<AgentWorld> = {}): AgentWorld {
  return world({
    events: s.events, tasks: s.tasks, settings: s.settings, prayerDone: s.prayerDone,
    focusSessions: s.focusSessions, focusTimer: s.focusTimer,
    categories: coerceCategories(s.settings.categories), taskLists: coerceTaskLists(s.settings.taskLists),
    ...over,
  });
}

function applyPlan(s: UndoStores, u: ReturnType<typeof planUndoAll>): UndoStores {
  return storesAfter(worldFrom(s), {
    result: null, label: '',
    events: u.events, tasks: u.tasks, settings: u.settings, prayerToggles: u.prayerToggles,
    focusSessions: u.focusSessions, focusTimer: u.focusTimer,
  });
}

function main() {
  console.log('--- 1. THE NEW TOOLS ARE REGISTERED, AND NONE OF THEM IS READ-ONLY ---');
  {
    for (const n of ['manage_categories', 'manage_task_lists', 'set_prayer_done', 'focus_timer', 'update_settings']) {
      assert.ok(TOOL_NAMES.has(n), n);
      assert.ok(PLANNER_TOOL_NAMES.has(n), n);
      assert.ok(!READ_ONLY_TOOLS.has(n), `${n} writes, so it must not be read-only`);
    }
    // Every tool the prompt can mention really exists, and vice versa.
    const p = buildSystemPrompt(world(), 'Mamoun');
    for (const n of TOOL_NAMES) assert.ok(p.includes(n), `prompt names ${n}`);
    assert.doesNotMatch(p, /[–—]/, 'no en or em dashes in the prompt');
    assert.doesNotMatch(p, /You cannot start, stop, or pause the focus timer/);
    assert.match(p, /Ticked off today: Fajr/);
    assert.match(p, /task list: use manage_task_lists/);
    console.log('  ok');
  }

  console.log('--- 2. COLOURS AND PRAYER NAMES ---');
  {
    assert.equal(parseColor('#22C55E', 'c'), '#22c55e');
    assert.equal(parseColor('#abc', 'c'), '#aabbcc');
    assert.equal(parseColor('teal', 'c'), '#14b8a6');
    assert.equal(parseColor('Royal Blue', 'c'), '#3b82f6');
    assert.equal(parseColor('dark green', 'c'), '#16a34a');
    assert.equal(parseColor('a nice purple please', 'c'), '#a855f7');
    assert.throws(() => parseColor('ultraviolet-ish', 'c'));
    assert.throws(() => parseColor('', 'c'));
    assert.throws(() => parseColor(42, 'c'));
    assert.throws(() => parseColor('#12345', 'c'));
    assert.equal(parsePrayerKey('Zuhr', 'p'), 'dhuhr');
    assert.equal(parsePrayerKey('ISHA', 'p'), 'isha');
    assert.equal(parsePrayerKey('magrib', 'p'), 'maghrib');
    assert.equal(parsePrayerKey(' fajr ', 'p'), 'fajr');
    assert.throws(() => parsePrayerKey('tahajjud', 'p'));
    assert.throws(() => parsePrayerKey(3, 'p'));
    console.log('  ok');
  }

  console.log('--- 3. CREATING A CATEGORY ---');
  {
    const w = world();
    const o = ok(call('manage_categories', { changes: [{ action: 'create', name: 'Gym' }] }, w));
    const cats = catsOf(o);
    assert.equal(cats.length, 4);
    const gym = cats[3];
    assert.equal(gym.name, 'Gym');
    assert.match(gym.color, /^#[0-9a-f]{6}$/);
    assert.equal(gym.defaultDurationMin, 30);
    assert.equal(gym.isDefault, false);
    assert.equal(gym.showInWidget, true);
    assert.ok(gym.id.startsWith('cat-'));
    // Everything else in settings.json is carried through untouched.
    assert.equal(o.settings!.viewMode, 'week');
    assert.deepEqual(o.settings!.shortcuts, { toggleTimer: 'Win+Shift+F1' });
    assert.deepEqual(o.settings!.taskLists, w.settings!.taskLists);
    // The report says exactly that, and undo knows it was created.
    assert.equal(o.entries!.length, 1);
    assert.equal(o.entries![0].action, 'added');
    assert.equal(o.entries![0].kind, 'category');
    assert.equal(o.entries![0].after!.title, 'Gym');
    assert.equal(o.entries![0].after!.position, 4);
    assert.deepEqual(o.undo!.map(u => [u.store, u.id, u.before === null]), [['settings', `category:${gym.id}`, true]]);
    // The world given in is never mutated.
    assert.equal(coerceCategories(w.settings!.categories).length, 3);
    console.log('  ok');
  }

  console.log('--- 4. CREATING A CATEGORY WITH EVERY OPTION, AND THE DEFAULT MOVES ---');
  {
    const o = ok(call('manage_categories', {
      changes: [{
        action: 'create', name: 'Exams', color: 'red', defaultMinutes: 120, allDay: true, checkbox: false,
        showInWidget: false, makeDefault: true, description: '  Finals  ',
        remindersTimed: { minutesBefore: [1440, 60] }, remindersAllDay: 'off',
      }],
    }));
    const cats = catsOf(o);
    const exams = cats.find(c => c.name === 'Exams')!;
    assert.equal(exams.color, '#e11d48');
    assert.equal(exams.defaultDurationMin, 120);
    assert.equal(exams.defaultNoDuration, false);
    assert.equal(exams.defaultAllDay, true);
    assert.equal(exams.defaultNoCheckbox, true);
    assert.equal(exams.showInWidget, false);
    assert.equal(exams.description, 'Finals');
    assert.deepEqual(exams.notifyTimed, { enabled: true, rules: [{ id: 'r0', offsetMin: -1440 }, { id: 'r1', offsetMin: -60 }], priority: 'normal' });
    // "Off" is stored the way every reader coerces it: disabled, with its rule kept.
    assert.deepEqual(exams.notifyAllDay, { enabled: false, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' });
    assert.equal(o.entries!.find(e => e.after?.title === 'Exams')!.after!.remindersAllDay, 'Off');
    // Only one default, and the one that lost it is reported.
    assert.deepEqual(cats.filter(c => c.isDefault).map(c => c.name), ['Exams']);
    const lost = o.entries!.find(e => e.id === 'personal')!;
    assert.equal(lost.action, 'updated');
    assert.deepEqual(lost.changed, ['isDefault']);
    assert.match(lost.note!, /No longer the default/);
    // Both changes are undoable records.
    assert.deepEqual(o.undo!.map(u => u.id).sort(), [`category:${exams.id}`, 'category:personal'].sort());
    console.log('  ok');
  }

  console.log('--- 5. A CATEGORY THAT ALREADY EXISTS IS NOT ADDED TWICE ---');
  {
    const o = ok(call('manage_categories', { changes: [{ action: 'create', name: 'deadlines' }] }));
    assert.equal(o.settings, undefined, 'nothing to write');
    assert.equal(o.undo!.length, 0);
    assert.equal(o.entries![0].action, 'skipped');
    // A batch where the second create duplicates the first.
    const o2 = ok(call('manage_categories', { changes: [{ action: 'create', name: 'Gym' }, { action: 'create', name: 'GYM' }] }));
    assert.equal(catsOf(o2).filter(c => c.name.toLowerCase() === 'gym').length, 1);
    assert.deepEqual(o2.entries!.map(e => e.action), ['added', 'skipped']);
    console.log('  ok');
  }

  console.log('--- 6. EDITING A CATEGORY ---');
  {
    const o = ok(call('manage_categories', { changes: [{ action: 'update', category: 'uni', newName: 'Uni', color: '#abc', checkbox: true }] }));
    const uni = catsOf(o).find(c => c.id === 'uni')!;
    assert.equal(uni.name, 'Uni');
    assert.equal(uni.color, '#aabbcc');
    assert.equal(uni.defaultNoCheckbox, false);
    const e = o.entries![0];
    assert.equal(e.action, 'updated');
    assert.deepEqual(e.changed, ['title', 'color', 'checkbox']);
    assert.equal(e.before!.title, 'University Calender');
    // `name` with `category` given means a rename.
    const o2 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Deadlines', name: 'Due dates' }] }));
    assert.equal(catsOf(o2).find(c => c.id === 'deadlines')!.name, 'Due dates');
    // Point-in-time on and off.
    const o3 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', pointInTime: true }] }));
    const p3 = catsOf(o3).find(c => c.id === 'personal')!;
    assert.equal(p3.defaultNoDuration, true);
    assert.equal(p3.defaultDurationMin, 0);
    const o4 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Deadlines', pointInTime: false }] }));
    const d4 = catsOf(o4).find(c => c.id === 'deadlines')!;
    assert.equal(d4.defaultNoDuration, false);
    assert.equal(d4.defaultDurationMin, 30, 'a point-in-time category gets a usable length back');
    const o5 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', defaultMinutes: 0 }] }));
    assert.equal(catsOf(o5).find(c => c.id === 'personal')!.defaultNoDuration, true);
    // Reminders back to "inherit" leave the field absent.
    const withRem = settings({ categories: CATS.map(c => (c.id === 'uni' ? { ...c, notifyTimed: { enabled: false, rules: [], priority: 'normal' } } : c)) });
    const o6 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'uni', remindersTimed: 'default' }] }, world({ settings: withRem })));
    assert.equal(catsOf(o6).find(c => c.id === 'uni')!.notifyTimed, undefined);
    // Unsetting the default.
    const o7 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', makeDefault: false }] }));
    assert.equal(catsOf(o7).some(c => c.isDefault), false);
    // A no-op update is reported, not written.
    const o8 = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', color: '#22c55e' }] }));
    assert.equal(o8.settings, undefined);
    assert.equal(o8.entries![0].action, 'skipped');
    console.log('  ok');
  }

  console.log('--- 7. MOVING A CATEGORY ---');
  {
    const o = ok(call('manage_categories', { changes: [{ action: 'move', category: 'Deadlines', position: 1 }] }));
    assert.deepEqual(catsOf(o).map(c => c.id), ['deadlines', 'personal', 'uni']);
    assert.deepEqual(o.entries![0].changed, ['position']);
    assert.equal(o.entries![0].before!.position, 3);
    assert.equal(o.entries![0].after!.position, 1);
    // A pure move changes no category, only the order.
    assert.deepEqual(o.undo!.map(u => u.id), ['categories#order']);
    // Moving to where it already is.
    const o2 = ok(call('manage_categories', { changes: [{ action: 'move', category: 'Personal', position: 1 }] }));
    assert.equal(o2.settings, undefined);
    console.log('  ok');
  }

  console.log('--- 8. BAD CATEGORY REQUESTS CHANGE NOTHING ---');
  {
    assert.match(err(call('manage_categories', {})), /changes must be a non-empty list/);
    assert.match(err(call('manage_categories', { changes: [] })), /non-empty/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'create' }] })), /name must be some text/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'create', name: 'x'.repeat(61) }] })), /longer than 60/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'explode', name: 'X' }] })), /must be "create", "update" or "move"/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'delete', category: 'Personal' }] })), /delete_items/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Nope', color: 'red' }] })), /no category called "Nope".*Personal/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal' }] })), /nothing to change/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', newName: 'deadlines' }] })), /already called/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', colour: 'red' }] })), /unknown field "colour"/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', defaultMinutes: 1441 }] })), /from 0 to 1440/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', defaultMinutes: 12.5 }] })), /whole number/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', pointInTime: true, defaultMinutes: 30 }] })), /point-in-time/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', allDay: 'yes' }] })), /true or false/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'move', category: 'Personal', position: 9 }] })), /from 1 to 3/);
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', position: 2 }] })), /use action "move"/);
    // Ambiguous: two categories contain "e" but neither is named exactly that.
    const amb = settings({ categories: [...CATS, { ...CATS[0], id: 'pe2', name: 'Personal Errands', isDefault: false }] });
    assert.match(err(call('manage_categories', { changes: [{ action: 'update', category: 'Pers', color: 'red' }] }, world({ settings: amb }))), /matches several/);
    // An exact name wins over a longer one that starts with it.
    const o = ok(call('manage_categories', { changes: [{ action: 'update', category: 'Personal', color: 'red' }] }, world({ settings: amb })));
    assert.equal(catsOf(o).find(c => c.id === 'personal')!.color, '#e11d48');
    // One bad change in a batch: the good ones are not written either.
    const bad = call('manage_categories', { changes: [{ action: 'create', name: 'Fine' }, { action: 'update', category: 'Missing', color: 'red' }] });
    err(bad);
    assert.equal(bad.settings, undefined);
    console.log('  ok');
  }

  console.log('--- 9. A SETTINGS FILE WITH NO CATEGORIES STARTS FROM THE APP DEFAULTS ---');
  {
    const w = world({ settings: { weekStartsOn: 1 } });
    const o = ok(call('manage_categories', { changes: [{ action: 'create', name: 'Work' }] }, w));
    assert.deepEqual(catsOf(o).map(c => c.name), ['Personal', 'Work']);
    assert.equal(o.settings!.weekStartsOn, 1);
    assert.equal(o.settings!.taskLists, undefined, 'untouched keys are not invented');
    console.log('  ok');
  }

  console.log('--- 10. UNDO OF CATEGORY CHANGES ---');
  {
    const w = world();
    const o = ok(call('manage_categories', {
      changes: [
        { action: 'create', name: 'Gym', makeDefault: true },
        { action: 'update', category: 'uni', color: 'teal' },
        { action: 'move', category: 'Deadlines', position: 1 },
      ],
    }, w));
    const after = storesAfter(w, o);
    // Verified as written.
    const okKeys = verifyAll(o.undo!, after, NOW.getTime());
    for (const e of o.entries!) assert.ok(entryVerified(e, o.undo!, okKeys), `${e.id} verified`);
    // Undo with nothing touched since: exactly the old list, in the old order.
    const u = planUndoAll(o.undo!, after, NOW.getTime());
    assert.equal(u.skipped.length, 0);
    assert.deepEqual(coerceCategories(u.settings!.categories), coerceCategories(w.settings!.categories));
    assert.equal(u.settings!.viewMode, 'week');
    // Undo twice: nothing is restored the second time and nothing breaks.
    const back = applyPlan(after, u);
    const again = planUndoAll(o.undo!, back, NOW.getTime());
    assert.equal(again.restored, 0);
    assert.deepEqual(coerceCategories((again.settings ?? back.settings).categories), coerceCategories(w.settings!.categories));

    // The user edited the new category since: it is kept, the rest is undone.
    const gymId = catsOf(o).find(c => c.name === 'Gym')!.id;
    const edited: UndoStores = { ...after, settings: { ...after.settings, categories: catsOf(o).map(c => (c.id === gymId ? { ...c, color: '#000000' } : c)) } };
    const u2 = planUndoAll(o.undo!, edited, NOW.getTime());
    assert.deepEqual(u2.skipped.map(s => s.id), [`category:${gymId}`]);
    const cats2 = coerceCategories(u2.settings!.categories);
    assert.ok(cats2.some(c => c.id === gymId), 'the edited category stays');
    assert.equal(cats2.find(c => c.id === 'uni')!.color, '#f97316', 'the colour change is undone');
    // Two defaults would be impossible: Personal comes back as the default
    // while Gym (kept) loses it.
    assert.deepEqual(cats2.filter(c => c.isDefault).map(c => c.id), ['personal']);

    // The user rearranged the order since: the order is left alone.
    const reordered: UndoStores = { ...after, settings: { ...after.settings, categories: [...catsOf(o)].reverse() } };
    const u3 = planUndoAll(o.undo!, reordered, NOW.getTime());
    assert.ok(u3.skipped.some(s => s.id === 'categories#order'));
    console.log('  ok');
  }

  console.log('--- 11. TASK LISTS: CREATE, RENAME, RECOLOUR, MOVE ---');
  {
    const o = ok(call('manage_task_lists', { changes: [{ action: 'create', name: 'Gym' }] }));
    const lists = listsOf(o);
    assert.equal(lists.length, 4);
    assert.equal(lists[3].name, 'Gym');
    assert.ok(!['#3b82f6', '#22c55e', '#f97316'].includes(lists[3].color), 'gets an unused colour');
    assert.equal(o.entries![0].kind, 'task_list');
    // Duplicate.
    const d = ok(call('manage_task_lists', { changes: [{ action: 'create', name: 'shopping' }] }));
    assert.equal(d.settings, undefined);
    assert.equal(d.entries![0].action, 'skipped');
    // General can be renamed and recoloured, but keeps its id.
    const g = ok(call('manage_task_lists', { changes: [{ action: 'update', list: 'General', newName: 'Inbox', color: 'purple' }] }));
    assert.deepEqual(listsOf(g)[0], { id: 'general', name: 'Inbox', color: '#a855f7' });
    // Move.
    const m = ok(call('manage_task_lists', { changes: [{ action: 'move', list: 'University', position: 2 }] }));
    assert.deepEqual(listsOf(m).map(l => l.id), ['general', 'uni-list', 'shopping']);
    assert.deepEqual(m.undo!.map(u => u.id), ['taskLists#order']);
    // Refusals.
    assert.match(err(call('manage_task_lists', { changes: [{ action: 'update', list: 'Shopping' }] })), /nothing to change/);
    assert.match(err(call('manage_task_lists', { changes: [{ action: 'update', list: 'Shopping', newName: 'university' }] })), /already called/);
    assert.match(err(call('manage_task_lists', { changes: [{ action: 'delete', list: 'Shopping' }] })), /delete_items/);
    assert.match(err(call('manage_task_lists', { changes: [{ action: 'create', name: 'X', icon: 'cart' }] })), /unknown field "icon"/);
    // Undo restores.
    const w = world();
    const u = planUndoAll(g.undo!, storesAfter(w, g), NOW.getTime());
    assert.deepEqual(coerceTaskLists(u.settings!.taskLists), coerceTaskLists(w.settings!.taskLists));
    console.log('  ok');
  }

  console.log('--- 12. DELETING CATEGORIES AND LISTS NEEDS APPROVE ---');
  {
    const w = world();
    const p = call('delete_items', { categories: ['University Calender'], taskLists: ['Shopping'], reason: 'Cleanup' }, w);
    ok(p);
    assert.equal(p.settings, undefined, 'the preview writes nothing');
    assert.equal(p.pause!.kind, 'approval');
    const plan = (p.pause as { plan: DeletionPlan }).plan;
    assert.deepEqual(plan.categoryIds, ['uni']);
    assert.deepEqual(plan.taskListIds, ['shopping']);
    assert.deepEqual(plan.items, []);
    const rows = (p.pause as { approval: { deletions: Array<{ kind: string; scopeLabel: string }> } }).approval.deletions;
    assert.equal(rows[0].kind, 'category');
    assert.match(rows[0].scopeLabel, /2 items stay/, 'deleted events are not counted');
    assert.equal(rows[1].kind, 'task_list');
    assert.match(rows[1].scopeLabel, /2 tasks move to General/);
    // Approve.
    const a = applyDeletion(plan, w);
    assert.deepEqual(coerceCategories(a.settings!.categories).map(c => c.id), ['personal', 'deadlines']);
    assert.deepEqual(coerceTaskLists(a.settings!.taskLists).map(l => l.id), ['general', 'uni-list']);
    assert.equal(a.events, undefined, 'items keep their category id; nothing else is rewritten');
    assert.equal(a.tasks, undefined);
    assert.deepEqual(a.entries!.map(e => [e.kind, e.action]), [['category', 'deleted'], ['task_list', 'deleted']]);
    assert.equal((a.result as { deleted: number }).deleted, 2);
    // Undo puts both back exactly where they were.
    const after = storesAfter(w, a);
    const u = planUndoAll(a.undo!, after, NOW.getTime());
    assert.deepEqual(coerceCategories(u.settings!.categories).map(c => c.id), ['personal', 'uni', 'deadlines']);
    assert.deepEqual(coerceTaskLists(u.settings!.taskLists).map(l => l.id), ['general', 'shopping', 'uni-list']);
    assert.deepEqual(coerceCategories(u.settings!.categories)[1], coerceCategories(w.settings!.categories)[1]);
    // Approved after it was already deleted elsewhere: reported, not guessed at.
    const w2 = worldFrom(after);
    const a2 = applyDeletion(plan, w2);
    assert.deepEqual(a2.entries!.map(e => e.action), ['failed', 'failed']);
    assert.equal(a2.settings, undefined);
    // A mixed request: an event and a category in one approval.
    const mixed = ok(call('delete_items', { items: [{ id: 'lec' }], categories: ['Deadlines'], reason: 'x' }, w));
    const mplan = (mixed.pause as { plan: DeletionPlan }).plan;
    const ma = applyDeletion(mplan, w);
    assert.equal(ma.events!.lec, undefined);
    assert.ok(!coerceCategories(ma.settings!.categories).some(c => c.id === 'deadlines'));
    const mu = planUndoAll(ma.undo!, storesAfter(w, ma), NOW.getTime());
    assert.ok(mu.events!.lec);
    assert.ok(coerceCategories(mu.settings!.categories).some(c => c.id === 'deadlines'));
    console.log('  ok');
  }

  console.log('--- 13. WHAT CAN NEVER BE DELETED ---');
  {
    assert.match(err(call('delete_items', { taskLists: ['General'], reason: 'x' })), /General.*cannot be deleted/);
    assert.match(err(call('delete_items', { categories: ['Personal', 'University Calender', 'Deadlines'], reason: 'x' })), /at least one category/);
    assert.match(err(call('delete_items', { reason: 'x' })), /Give items/);
    assert.match(err(call('delete_items', { items: [], categories: [], reason: 'x' })), /Give items/);
    assert.match(err(call('delete_items', { categories: ['Nope'], reason: 'x' })), /no category called/);
    assert.match(err(call('delete_items', { categories: 'Personal', reason: 'x' })), /must be a list/);
    // The last category, when the others vanished between preview and Approve.
    const one = world({ settings: settings({ categories: [CATS[0]] }) });
    const a = applyDeletion({ items: [], categoryIds: ['personal'] }, one);
    assert.equal(a.entries![0].action, 'failed');
    assert.equal(a.settings, undefined);
    // Asking twice for the same thing lists it once.
    const twice = ok(call('delete_items', { categories: ['Deadlines', 'deadlines'], reason: 'x' }));
    assert.equal((twice.pause as { plan: DeletionPlan }).plan.categoryIds!.length, 1);
    console.log('  ok');
  }

  console.log('--- 14. PRAYERS ---');
  {
    const w = world();
    const o = ok(call('set_prayer_done', { prayers: [{ prayer: 'zuhr' }, { prayer: 'asr', date: '2026-10-19' }] }, w));
    assert.deepEqual(o.prayerToggles, [
      { date: '2026-10-20', key: 'dhuhr', present: true },
      { date: '2026-10-19', key: 'asr', present: true },
    ]);
    assert.deepEqual(o.entries!.map(e => [e.action, e.after!.title, e.after!.date, e.after!.startTime]), [
      ['completed', 'Dhuhr prayer', '2026-10-20', '11:40'],
      ['completed', 'Asr prayer', '2026-10-19', '14:55'],
    ]);
    // Already ticked.
    const s = ok(call('set_prayer_done', { prayers: [{ prayer: 'fajr' }] }, w));
    assert.equal(s.prayerToggles, undefined);
    assert.equal(s.entries![0].action, 'skipped');
    // Un-tick.
    const u = ok(call('set_prayer_done', { prayers: [{ prayer: 'fajr', done: false }] }, w));
    assert.deepEqual(u.prayerToggles, [{ date: '2026-10-20', key: 'fajr', present: false }]);
    assert.equal(u.entries![0].action, 'reopened');
    // Tick then untick in one call cancels out.
    const c = ok(call('set_prayer_done', { prayers: [{ prayer: 'isha', date: '2026-10-18' }, { prayer: 'isha', date: '2026-10-18', done: false }] }, w));
    assert.equal(c.prayerToggles, undefined);
    assert.equal(c.undo!.length, 0);
    // Refusals.
    assert.match(err(call('set_prayer_done', { prayers: [{ prayer: 'fajr', date: '2026-10-21' }] })), /has not happened yet/);
    assert.match(err(call('set_prayer_done', { prayers: [{ prayer: 'witr' }] })), /not a prayer/);
    assert.match(err(call('set_prayer_done', { prayers: [{ prayer: 'fajr', date: '2026-02-30' }] })), /not a real date/);
    assert.match(err(call('set_prayer_done', { prayers: [{ prayer: 'fajr', done: 'yes' }] })), /true or false/);
    assert.match(err(call('set_prayer_done', { prayers: [] })), /non-empty/);
    // A bad row anywhere: nothing is ticked.
    const bad = call('set_prayer_done', { prayers: [{ prayer: 'asr' }, { prayer: 'nope' }] });
    err(bad);
    assert.equal(bad.prayerToggles, undefined);
    // Undo, and undo refusing to fight a newer tap.
    const after = storesAfter(w, o);
    assert.equal(verifyAll(o.undo!, after, NOW.getTime()).size, 2);
    const un = planUndoAll(o.undo!, after, NOW.getTime());
    assert.deepEqual(un.prayerToggles, [
      { date: '2026-10-20', key: 'dhuhr', present: false },
      { date: '2026-10-19', key: 'asr', present: false },
    ]);
    const retapped = { ...after, prayerDone: { ...after.prayerDone, '2026-10-19': [] } };
    const un2 = undoPrayerRecords(o.undo!, retapped.prayerDone);
    assert.deepEqual(un2.skipped.map(x => x.id), ['2026-10-19|asr']);
    assert.equal(un2.toggles.length, 1);
    console.log('  ok');
  }

  console.log('--- 15. FOCUS TIMER: START, PAUSE, RESUME, STOP, LENGTH ---');
  {
    const t0 = NOW.getTime();
    // Start from nothing, with a length.
    const w = world();
    const s = ok(call('focus_timer', { action: 'start', minutes: 25 }, w));
    assert.equal(s.focusTimer!.isRunning, true);
    assert.equal(s.focusTimer!.plannedSeconds, 1500);
    assert.equal(s.focusTimer!.sessionStartedAt, NOW.toISOString());
    assert.equal(s.focusTimer!.origin, 'assistant');
    assert.equal(s.focusSessions, undefined);
    assert.equal(s.entries![0].before!.value, 'Not running (1h sessions)');
    assert.equal(s.entries![0].after!.value, 'Running, 0m of 25m');
    // Ten minutes later: pause.
    const running = s.focusTimer!;
    const later = new Date(t0 + 10 * 60_000);
    const p = ok(call('focus_timer', { action: 'pause' }, world({ now: later, focusTimer: running })));
    assert.equal(p.focusTimer!.isRunning, false);
    assert.equal(p.focusTimer!.accumulatedSeconds, 600);
    assert.equal(p.entries![0].after!.value, 'Paused at 10m of 25m');
    // Pause again: nothing changes, and the model is told why.
    const p2 = ok(call('focus_timer', { action: 'pause' }, world({ now: later, focusTimer: p.focusTimer! })));
    assert.equal(p2.focusTimer, undefined);
    assert.equal(p2.entries![0].action, 'skipped');
    assert.match(p2.entries![0].note!, /already paused/);
    // Resume.
    const r = ok(call('focus_timer', { action: 'resume' }, world({ now: later, focusTimer: p.focusTimer! })));
    assert.equal(r.focusTimer!.isRunning, true);
    // Stop five minutes after resuming: a 15-minute session is logged.
    const stopAt = new Date(t0 + 15 * 60_000);
    const st = ok(call('focus_timer', { action: 'stop' }, world({ now: stopAt, focusTimer: r.focusTimer! })));
    assert.equal(st.focusTimer!.isRunning, false);
    assert.equal(st.focusTimer!.sessionStartedAt, null);
    assert.equal(st.focusTimer!.plannedSeconds, 1500, 'the chosen length survives');
    assert.equal(st.focusSessions!.length, 1);
    assert.equal(st.focusSessions![0].durationSeconds, 900);
    assert.equal(st.focusSessions![0].id, `session-${NOW.toISOString()}`);
    const sessEntry = st.entries!.find(e => e.kind === 'focus_session')!;
    assert.equal(sessEntry.action, 'added');
    assert.equal(sessEntry.after!.title, '15-minute focus session');
    assert.equal(sessEntry.after!.date, '2026-10-20');
    assert.match(st.label, /Stopped the focus timer and logged 15m/);
    // Stop with nothing running.
    const none = ok(call('focus_timer', { action: 'stop' }, w));
    assert.equal(none.focusTimer, undefined);
    assert.match(none.entries![0].note!, /nothing to stop/);
    // Start while running, with a new length: only the length changes.
    const sl = ok(call('focus_timer', { action: 'start', minutes: 50 }, world({ now: later, focusTimer: running })));
    assert.equal(sl.focusTimer!.plannedSeconds, 3000);
    assert.equal(sl.focusTimer!.lastStartedAt, running.lastStartedAt, 'never re-anchored');
    assert.match(sl.entries![0].note!, /already running/);
    // Set the length alone.
    const len = ok(call('focus_timer', { action: 'set_length', minutes: 90 }, w));
    assert.equal(len.focusTimer!.plannedSeconds, 5400);
    assert.equal(len.focusTimer!.isRunning, false);
    // An overdue session that is stopped ends when it ran out, at its planned length.
    const overdueAt = new Date(t0 + 3 * 3600_000);
    const od = ok(call('focus_timer', { action: 'stop' }, world({ now: overdueAt, focusTimer: running })));
    assert.equal(od.focusSessions![0].durationSeconds, 1500);
    assert.equal(od.focusSessions![0].endedAt, new Date(t0 + 1500_000).toISOString());
    // Refusals.
    assert.match(err(call('focus_timer', { action: 'resume' }, w)), /no paused session/);
    assert.match(err(call('focus_timer', { action: 'set_length' }, w)), /needs minutes/);
    assert.match(err(call('focus_timer', { action: 'start', minutes: 0 }, w)), /from 1 to 720/);
    assert.match(err(call('focus_timer', { action: 'start', minutes: 721 }, w)), /from 1 to 720/);
    assert.match(err(call('focus_timer', { action: 'pause', minutes: 5 }, w)), /takes no minutes/);
    assert.match(err(call('focus_timer', { action: 'discard' }, w)), /action must be one of/);
    console.log('  ok');
  }

  console.log('--- 16. FOCUS TIMER UNDO ---');
  {
    const t0 = NOW.getTime();
    const w = world();
    const s = ok(call('focus_timer', { action: 'start', minutes: 25 }, w));
    // Undo a start: back to no session at all.
    const a1 = storesAfter(w, s);
    const later = t0 + 5 * 60_000;
    const u1 = planUndoAll(s.undo!, a1, later);
    assert.equal(u1.skipped.length, 0);
    assert.equal(u1.focusTimer!.isRunning, false);
    assert.equal(u1.focusTimer!.sessionStartedAt, null);
    // The checkpoint a window does while running does not count as an edit.
    const checkpointed = reduceFocusTimer(a1.focusTimer, { kind: 'checkpoint' }, t0 + 60_000).state;
    assert.notDeepEqual(checkpointed, a1.focusTimer);
    assert.ok(sameTimer(checkpointed, a1.focusTimer, later));
    assert.equal(planUndoAll(s.undo!, { ...a1, focusTimer: checkpointed }, later).skipped.length, 0);
    // A new session started since is never thrown away by an old undo.
    const restarted = reduceFocusTimer(reduceFocusTimer(a1.focusTimer, { kind: 'stop' }, t0 + 60_000).state, { kind: 'start' }, t0 + 120_000).state;
    const u2 = planUndoAll(s.undo!, { ...a1, focusTimer: restarted }, later);
    assert.equal(u2.focusTimer, undefined);
    assert.deepEqual(u2.skipped.map(x => x.store), ['focusTimer']);
    // Undo a stop: the session comes off the history and the timer runs on
    // from its ORIGINAL start, as if it had never been stopped.
    const r = s.focusTimer!;
    const stopAt = new Date(t0 + 15 * 60_000);
    const wStop = world({ now: stopAt, focusTimer: r });
    const st = ok(call('focus_timer', { action: 'stop' }, wStop));
    const a2 = storesAfter(wStop, st);
    const u3 = planUndoAll(st.undo!, a2, t0 + 20 * 60_000);
    assert.equal(u3.skipped.length, 0);
    assert.deepEqual(u3.focusSessions, []);
    assert.equal(u3.focusTimer!.isRunning, true);
    assert.equal(u3.focusTimer!.lastStartedAt, r.lastStartedAt);
    assert.equal(timerText(u3.focusTimer!, t0 + 20 * 60_000), 'Running, 20m of 25m');
    // A session that was ALREADY in the history before the stop (another
    // device logged the same one) is put back, not removed.
    const prior: FocusSessionRecord = { id: `session-${NOW.toISOString()}`, startedAt: NOW.toISOString(), endedAt: new Date(t0 + 14 * 60_000).toISOString(), durationSeconds: 840, plannedSeconds: 1500 };
    const wDup = world({ now: stopAt, focusTimer: r, focusSessions: [prior] });
    const stDup = ok(call('focus_timer', { action: 'stop' }, wDup));
    const uDup = planUndoAll(stDup.undo!, storesAfter(wDup, stDup), t0 + 20 * 60_000);
    assert.deepEqual(uDup.focusSessions, [prior]);
    // Undo a pause: running again from the same anchor.
    const pAt = new Date(t0 + 10 * 60_000);
    const wP = world({ now: pAt, focusTimer: r });
    const p = ok(call('focus_timer', { action: 'pause' }, wP));
    const uP = planUndoAll(p.undo!, storesAfter(wP, p), t0 + 12 * 60_000);
    assert.equal(uP.focusTimer!.isRunning, true);
    assert.equal(uP.focusTimer!.lastStartedAt, r.lastStartedAt);
    // Verification.
    assert.equal(verifyAll(st.undo!, a2, stopAt.getTime()).size, 2);
    assert.equal(verifyPlannerRecords(st.undo!, { ...a2, focusSessions: [] }, stopAt.getTime()).size, 1);
    console.log('  ok');
  }

  console.log('--- 17. FOCUS SESSION DELETION CAN NOW BE UNDONE ---');
  {
    const s1: FocusSessionRecord = { id: 'session-a', startedAt: '2026-10-19T08:00:00.000Z', endedAt: '2026-10-19T09:00:00.000Z', durationSeconds: 3600 };
    const s2: FocusSessionRecord = { id: 'session-b', startedAt: '2026-10-19T10:00:00.000Z', endedAt: '2026-10-19T10:30:00.000Z', durationSeconds: 1800 };
    const w = world({ focusSessions: [s2, s1] });
    const d = applyFocusDeletion(['session-a'], w.focusSessions, w);
    assert.deepEqual(d.sessions, [s2]);
    assert.equal(d.undo.length, 1);
    // The report row carries 24-hour times whatever the display format.
    assert.match(d.entries[0].before!.startTime!, /^\d{2}:\d{2}$/);
    const after: UndoStores = { ...storesAfter(w, { result: null, label: '' }), focusSessions: d.sessions };
    assert.ok(verifyAll(d.undo, after, NOW.getTime()).has('focusSessions:session-a'));
    const u = planUndoAll(d.undo, after, NOW.getTime());
    assert.deepEqual(u.focusSessions!.map(x => x.id), ['session-b', 'session-a']);
    // Re-added elsewhere already: undo has nothing to do and does not duplicate it.
    const u2 = undoFocusRecords(d.undo, [s2, s1], null, NOW.getTime());
    assert.equal(u2.sessions, undefined);
    assert.equal(u2.skipped.length, 0);
    console.log('  ok');
  }

  console.log('--- 18. SETTINGS ---');
  {
    const w = world();
    const o = ok(call('update_settings', {
      set: {
        weekStartsOn: 'Monday', timeFormat: '24', focusDailyGoalMinutes: 90, focusDayStartHour: 5,
        taskColor: 'teal', taskCheckboxShape: 'square', autoRollRecurringTasks: false, overlapLayout: 'columns',
        focusExcludeDates: ['2026-10-01', '2026-10-02'],
        reminders: { timedDefault: { minutesBefore: [10] }, allDayHour: 7, quietHours: { from: 22, to: 6 }, prayerReminders: { minutesBefore: [0] } },
        prayerTimes: { city: 'Irbid', method: 'umm al-qura', school: 'hanafi', hide: ['sunrise', 'isha'], offsets: { isha: 5, fajr: 0 } },
      },
    }, w));
    const s = o.settings!;
    assert.equal(s.weekStartsOn, 1);
    assert.equal(s.timeFormat, '24h');
    assert.equal(s.focusDailyGoalSeconds, 5400);
    assert.equal(s.focusDayStartHour, 5);
    assert.equal(s.taskColor, '#14b8a6');
    assert.equal(s.taskCheckboxShape, 'square');
    assert.equal(s.autoRollRecurringTasks, false);
    assert.equal(s.overlapLayout, 'columns');
    assert.deepEqual(s.focusExcludedDates, ['2026-10-01', '2026-10-02']);
    const n = coerceNotificationSettings(s.notifications);
    assert.deepEqual(n.defaultTimed, { enabled: true, rules: [{ id: 'r0', offsetMin: -10 }], priority: 'normal' });
    assert.equal(n.allDayHour, 7);
    assert.equal(n.quietHoursEnabled, true);
    assert.equal(n.quietFromH, 22);
    assert.equal(n.quietToH, 6);
    assert.equal(n.prayer.enabled, true);
    // A notifications object that did not exist is written WHOLE, so it reads
    // exactly as before except for what changed.
    assert.equal((s.notifications as Record<string, unknown>).taskCutoffHour, 21);
    const pr = coercePrayerSettings(s.prayer);
    assert.equal(pr.city, 'Irbid');
    assert.equal(pr.method, 4);
    assert.equal(pr.school, 1);
    assert.deepEqual(pr.hidden, ['sunrise', 'isha']);
    assert.deepEqual(pr.offsets, { isha: 5 });
    // Device keys untouched.
    assert.equal(s.viewMode, 'week');
    // One report row per setting, in words.
    const rows = o.entries!.filter(e => e.action === 'updated');
    const byTitle = Object.fromEntries(rows.map(e => [e.after!.title, [e.before!.value, e.after!.value]]));
    assert.deepEqual(byTitle['Week starts on'], ['Sunday', 'Monday']);
    assert.deepEqual(byTitle['Daily focus goal'], ['No goal', '1h 30m']);
    assert.deepEqual(byTitle['Default reminders, timed items'], ['at the time', '10 min before']);
    assert.deepEqual(byTitle['Prayer calculation method'][1], 'Umm Al-Qura University, Makkah');
    assert.deepEqual(byTitle['Prayer time corrections'], ['None', 'Isha +5 min']);
    assert.equal(o.undo!.length, rows.length);
    // Already like that.
    const same = ok(call('update_settings', { set: { timeFormat: '12h' } }, w));
    assert.equal(same.settings, undefined);
    assert.equal(same.entries![0].action, 'skipped');
    // "default" puts a reminder default back to the app's own.
    const changed = world({ settings: settings({ notifications: { defaultTask: { enabled: false, rules: [], priority: 'normal' } } }) });
    const back = ok(call('update_settings', { set: { reminders: { taskDefault: 'default' } } }, changed));
    assert.deepEqual(coerceNotificationSettings(back.settings!.notifications).defaultTask, { enabled: true, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' });
    // Quiet hours off; showing a hidden prayer again; include a date again.
    const w2 = worldFrom(storesAfter(w, o));
    const o2 = ok(call('update_settings', { set: { reminders: { quietHours: 'off' }, prayerTimes: { show: ['isha'] }, focusIncludeDates: ['2026-10-01'] } }, w2));
    assert.equal(coerceNotificationSettings(o2.settings!.notifications).quietHoursEnabled, false);
    assert.deepEqual(coercePrayerSettings(o2.settings!.prayer).hidden, ['sunrise']);
    assert.deepEqual(o2.settings!.focusExcludedDates, ['2026-10-02']);
    // Refusals.
    assert.match(err(call('update_settings', { set: { darkMode: true } })), /"darkMode" is not a setting/);
    assert.match(err(call('update_settings', { set: {} })), /no settings/);
    assert.match(err(call('update_settings', {})), /set must be an object/);
    assert.match(err(call('update_settings', { set: { weekStartsOn: 'Funday' } })), /weekday name/);
    assert.match(err(call('update_settings', { set: { weekStartsOn: 9 } })), /weekday name/);
    assert.match(err(call('update_settings', { set: { timeFormat: 'military' } })), /12h/);
    assert.match(err(call('update_settings', { set: { focusDayStartHour: 24 } })), /from 0 to 23/);
    assert.match(err(call('update_settings', { set: { reminders: { volume: 3 } } })), /not a reminder setting/);
    assert.match(err(call('update_settings', { set: { prayerTimes: { method: 999 } } })), /method must be one of/);
    assert.match(err(call('update_settings', { set: { prayerTimes: { offsets: { isha: 90 } } } })), /from -60 to 60/);
    assert.match(err(call('update_settings', { set: { prayerTimes: { hide: ['witr'] } } })), /not a prayer/);
    assert.match(err(call('update_settings', { set: { focusExcludeDates: ['tomorrow'] } })), /YYYY-MM-DD/);
    console.log('  ok');
  }

  console.log('--- 19. SETTINGS UNDO IS PER SETTING ---');
  {
    const w = world();
    const o = ok(call('update_settings', { set: { weekStartsOn: 'monday', focusDailyGoalMinutes: 60, reminders: { allDayHour: 9 } } }, w));
    const after = storesAfter(w, o);
    const v = verifyAll(o.undo!, after, NOW.getTime());
    for (const e of o.entries!) assert.ok(entryVerified(e, o.undo!, v), e.id);
    // The user changed the goal again since; undo restores the rest only.
    const touched: UndoStores = { ...after, settings: { ...after.settings, focusDailyGoalSeconds: 7200 } };
    const u = planUndoAll(o.undo!, touched, NOW.getTime());
    assert.deepEqual(u.skipped.map(x => x.id), ['key:focusDailyGoalSeconds']);
    assert.equal(u.settings!.weekStartsOn, 0);
    assert.equal(u.settings!.focusDailyGoalSeconds, 7200, 'their newer value stays');
    assert.equal(coerceNotificationSettings(u.settings!.notifications).allDayHour, 8);
    // A window re-saving the same values in a different but equivalent shape
    // (the whole coerced notifications object) is NOT an edit.
    const resaved: UndoStores = { ...after, settings: { ...after.settings, notifications: coerceNotificationSettings(after.settings.notifications) } };
    assert.equal(planUndoAll(o.undo!, resaved, NOW.getTime()).skipped.length, 0);
    // The report has a section for settings.
    const cs: ChangeSet = { id: 'cs', at: 0, tool: 'update_settings', entries: o.entries! };
    const groups = buildReport([cs], '12h', NOW);
    assert.deepEqual(groups.map(g => g.heading), ['Settings']);
    const d = diffsOf(o.entries!.find(e => e.id === 'weekStartsOn')!, '12h');
    assert.deepEqual(d, [{ field: 'value', label: 'Week starts on', before: 'Sunday', after: 'Monday' }]);
    assert.equal(summarize([cs]).headline, '3 settings changed');
    console.log('  ok');
  }

  console.log('--- 20. THE REPORT FOR SETUP CHANGES ---');
  {
    const o = ok(call('manage_categories', { changes: [{ action: 'create', name: 'Gym', color: 'teal' }, { action: 'update', category: 'uni', color: 'red' }] }));
    const lists = ok(call('manage_task_lists', { changes: [{ action: 'create', name: 'Errands' }] }));
    const prayers = ok(call('set_prayer_done', { prayers: [{ prayer: 'asr' }] }));
    const sets: ChangeSet[] = [
      { id: 'a', at: 0, tool: 'manage_categories', entries: o.entries! },
      { id: 'b', at: 0, tool: 'manage_task_lists', entries: lists.entries! },
      { id: 'c', at: 0, tool: 'set_prayer_done', entries: prayers.entries! },
    ];
    const groups = buildReport(sets, '12h', NOW);
    // Dated first (the prayer, under its day), then the setup sections in order.
    assert.deepEqual(groups.map(g => g.heading), ['Tuesday, 20 Oct', 'Categories', 'Task lists']);
    assert.equal(groups[0].rows[0].time, '2:55 PM');
    assert.equal(groups[0].rows[0].word, 'Ticked off');
    // A category's colour change is shown (an event's is not).
    const colour = diffsOf(o.entries![1], '12h');
    assert.deepEqual(colour, [{ field: 'color', label: 'Colour', before: '#f97316', after: '#e11d48' }]);
    const chips = groups[1].rows.find(r => r.facts?.title === 'Gym')!.chips;
    assert.equal(chips[0].label, 'Gym');
    assert.equal(chips[0].color, '#14b8a6');
    assert.equal(summarize([sets[0]]).headline, '1 category added, 1 category changed');
    assert.equal(summarize([sets[2]]).headline, '1 prayer ticked off');
    console.log('  ok');
  }

  console.log('--- 21. UNDO LEAVES SETTINGS IT NEVER TOUCHED ALONE ---');
  {
    // Records for categories only: settings keys the user changed meanwhile
    // (theme, shortcuts, a setting) are carried through untouched.
    const w = world();
    const o = ok(call('manage_categories', { changes: [{ action: 'create', name: 'Gym' }] }, w));
    const after = storesAfter(w, o);
    const busy: UndoStores = { ...after, settings: { ...after.settings, viewMode: 'month', weekStartsOn: 3 } };
    const u = undoSettingsRecords(o.undo!, busy.settings);
    assert.equal(u.settings.viewMode, 'month');
    assert.equal(u.settings.weekStartsOn, 3);
    assert.equal(coerceCategories(u.settings.categories).length, 3);
    // Records with nothing to do report touched: false (no write).
    assert.equal(undoSettingsRecords([], busy.settings).touched, false);
    console.log('  ok');
  }

  console.log('--- 22. MEANING IGNORES HOW EMPTY IS SPELLED ---');
  {
    assert.equal(meaning({ a: 1, b: undefined, c: null, d: false, e: '', f: [] }), meaning({ a: 1 }));
    assert.notEqual(meaning({ a: true }), meaning({ a: false }));
    assert.equal(meaning({ x: { y: 1, z: [] } }), meaning({ x: { y: 1 } }));
    assert.equal(meaning({ b: 2, a: 1 }), meaning({ a: 1, b: 2 }));
    console.log('  ok');
  }

  console.log('--- 23. EVENTS AND TASKS UNDO IGNORES THE NEW STORES ---');
  {
    // A change set that mixes stores never lets a settings record land in the
    // tasks map (the old planUndo assumed every record was events or tasks).
    const w = world();
    const records: UndoRecord[] = [
      { store: 'settings', id: 'key:weekStartsOn', before: { v: 0 }, after: { v: 1 } },
      { store: 'tasks', id: 'milk', before: { id: 'milk', title: 'Milk', listId: 'shopping', deleted: false, updatedAt: 1 }, after: { id: 'milk', title: 'Oat milk', listId: 'shopping', deleted: false, updatedAt: 2 } },
    ];
    const stores: UndoStores = { ...storesAfter(w, { result: null, label: '' }), settings: settings({ weekStartsOn: 1 }), tasks: { ...w.tasks, milk: { ...w.tasks.milk, title: 'Oat milk' } } };
    const u = planUndoAll(records, stores, 5);
    assert.equal(u.tasks!.milk.title, 'Milk');
    assert.equal((u.tasks as Record<string, unknown>)['key:weekStartsOn'], undefined);
    assert.equal(u.settings!.weekStartsOn, 0);
    assert.equal(u.restored, 2);
    console.log('  ok');
  }

  console.log('--- 24. A TIMER THAT WAS NEVER WRITTEN READS AS IDLE ---');
  {
    assert.equal(timerText(coerceFocusTimer(null), 0), 'Not running (1h sessions)');
    assert.ok(sameTimer(null, IDLE_FOCUS_TIMER, 0));
    const t: FocusTimerState = { ...IDLE_FOCUS_TIMER, plannedSeconds: 1500 };
    assert.ok(!sameTimer(null, t, 0));
    console.log('  ok');
  }

  console.log('\nAll agentPlannerTools tests passed.');
}

main();
