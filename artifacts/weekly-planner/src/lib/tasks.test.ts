// Tests tasks data models, recurrence, filtering, tree structures, Google notes, and task lists.
// Run with: npx tsx src/lib/tasks.test.ts

import assert from 'node:assert/strict';
import {
  ALL_TASK_FILTERS,
  addMinutesToTime,
  buildTaskTree,
  canonicalFilters,
  coerceTasks,
  composeTaskNotes,
  currentOpenOccurrence,
  deleteTaskScoped,
  dueDateOf,
  editTaskSeries,
  expandTaskRange,
  isTaskDone,
  makeTask,
  matchesFilters,
  newTaskId,
  nextOpenOccurrence,
  parseTaskNotes,
  resolveWeekTasks,
  taskBucket,
  taskKind,
  toggleTaskDone,
  withDueDate,
  withTime,
  type Task,
  type TaskData,
} from './tasks';
import {
  DEFAULT_TASK_LISTS,
  GENERAL_LIST_ID,
  TASK_LIST_COLORS,
  coerceTaskLists,
  listIdOf,
  makeListId,
  moveList,
  nextListColor,
  resolveListId,
  type TaskList,
} from './taskLists';

console.log('--- 1. TASK KIND & DUE DATE HELPERS ---');
const genTask: Task = { id: 't1', title: 'General Task' };
const datedTask: Task = { id: 't2', title: 'Dated Task', weekKey: '2026-08-24', dayIndex: 2 };
const timedTask: Task = { id: 't3', title: 'Timed Task', weekKey: '2026-08-24', dayIndex: 2, startTime: '14:00', endTime: '15:00' };

assert.equal(taskKind(genTask), 'general');
assert.equal(taskKind(datedTask), 'dated');
assert.equal(taskKind(timedTask), 'timed');

assert.equal(dueDateOf(genTask), null);
assert.equal(dueDateOf(datedTask), '2026-08-26');
assert.equal(dueDateOf({ ...datedTask, recur: { freq: 'daily' }, occDate: '2026-08-30' }), '2026-08-30');

// Setting and clearing due date (with weekStartsOn = 1 / Monday)
const updatedDue = withDueDate(genTask, '2026-08-26', 1);
assert.equal(updatedDue.weekKey, '2026-08-24');
assert.equal(updatedDue.dayIndex, 2);

const clearedDue = withDueDate(timedTask, null, 1);
assert.equal(clearedDue.weekKey, undefined);
assert.equal(clearedDue.dayIndex, undefined);
assert.equal(clearedDue.startTime, undefined);
assert.equal(taskKind(clearedDue), 'general');

// Setting and clearing time
const withNewTime = withTime(datedTask, '10:00', 45);
assert.equal(withNewTime.startTime, '10:00');
assert.equal(withNewTime.endTime, '10:45');

const clearedTime = withTime(timedTask, null);
assert.equal(clearedTime.startTime, undefined);
assert.equal(clearedTime.endTime, undefined);

// Clamping addMinutesToTime
assert.equal(addMinutesToTime('10:00', 30), '10:30');
assert.equal(addMinutesToTime('23:30', 60), '23:59');
assert.equal(addMinutesToTime('00:30', -60), '00:00');

console.log('--- 2. TASK OCCURRENCES & AUTO-ROLL RECURRING ---');
const recDaily: Task = {
  id: 'rd',
  title: 'Daily Task',
  weekKey: '2026-08-24',
  dayIndex: 0, // starts Monday 2026-08-24
  recur: { freq: 'daily' },
};

// Next open occurrence
assert.equal(nextOpenOccurrence(recDaily, '2026-08-24'), '2026-08-24');
const withSomeDone: Task = { ...recDaily, completedDates: ['2026-08-24', '2026-08-25'] };
assert.equal(nextOpenOccurrence(withSomeDone, '2026-08-24'), '2026-08-26');

// currentOpenOccurrence with auto-roll:
// Case 1: Today is an occurrence (2026-08-26) and is open -> active is today
assert.equal(currentOpenOccurrence(recDaily, '2026-08-26', true), '2026-08-26');

// Case 2: Today is an occurrence and is done -> active is tomorrow (2026-08-27)
const doneToday: Task = { ...recDaily, completedDates: ['2026-08-26'] };
assert.equal(currentOpenOccurrence(doneToday, '2026-08-26', true), '2026-08-27');

// Case 3: Weekly task on Mon/Wed/Fri (2026-08-24, 26, 28). Today is Tuesday (2026-08-25).
// Monday 24 was NOT done -> overdue on Monday 24.
const mwfTask: Task = {
  id: 'mwf',
  title: 'MWF Task',
  weekKey: '2026-08-24',
  dayIndex: 0,
  recur: { freq: 'weekly', byWeekday: [1, 3, 5] },
};

assert.equal(currentOpenOccurrence(mwfTask, '2026-08-25', true), '2026-08-24');

// Monday 24 WAS done -> next open is Wednesday 26.
const mwfDoneMon: Task = { ...mwfTask, completedDates: ['2026-08-24'] };
assert.equal(currentOpenOccurrence(mwfDoneMon, '2026-08-25', true), '2026-08-26');

// Expand range: non-repeating vs repeating
const oneOffInRange = expandTaskRange(datedTask, '2026-08-24', '2026-08-30');
assert.equal(oneOffInRange.length, 1);
assert.equal(oneOffInRange[0].occId, 't2');
assert.equal(oneOffInRange[0].occDate, '2026-08-26');

const oneOffOutRange = expandTaskRange(datedTask, '2026-09-01', '2026-09-07');
assert.equal(oneOffOutRange.length, 0);

console.log('--- 3. COMPLETION & TOGGLING ---');
assert.equal(isTaskDone(genTask), false);
assert.equal(isTaskDone({ ...genTask, completed: true }), true);
assert.equal(isTaskDone(recDaily, '2026-08-25'), false);
assert.equal(isTaskDone({ ...recDaily, completedDates: ['2026-08-25'] }, '2026-08-25'), true);

// Toggle non-repeating
const rawTasks: TaskData = { t1: genTask, rd: recDaily };
const toggledOneOff = toggleTaskDone(rawTasks, 't1');
assert.equal(toggledOneOff.t1.completed, true);
assert.ok(toggledOneOff.t1.completedAt !== undefined);

const untoggledOneOff = toggleTaskDone(toggledOneOff, 't1');
assert.equal(untoggledOneOff.t1.completed, false);
assert.equal(untoggledOneOff.t1.completedAt, undefined);

// Toggle repeating occurrence
const toggledRec = toggleTaskDone(rawTasks, 'rd::2026-08-25');
assert.deepEqual(toggledRec.rd.completedDates, ['2026-08-25']);

const untoggledRec = toggleTaskDone(toggledRec, 'rd::2026-08-25');
assert.deepEqual(untoggledRec.rd.completedDates, []);

console.log('--- 4. GOOGLE TASKS NOTES & TIME MARKER ---');
// Parsing notes
const notesWith24h = '⏰ 14:30–15:30\n\nMeeting agenda and discussion items';
const parsed24h = parseTaskNotes(notesWith24h);
assert.equal(parsed24h.startTime, '14:30');
assert.equal(parsed24h.endTime, '15:30');
assert.equal(parsed24h.body, 'Meeting agenda and discussion items');

// Parsing 12h format with am/pm
const notesWith12h = '⏰ 9:15am - 10:45am\nClient check-in call';
const parsed12h = parseTaskNotes(notesWith12h);
assert.equal(parsed12h.startTime, '09:15');
assert.equal(parsed12h.endTime, '10:45');
assert.equal(parsed12h.body, 'Client check-in call');

// Single start time
const singleTime = parseTaskNotes('⏰ 16:00\nSolo task');
assert.equal(singleTime.startTime, '16:00');
assert.equal(singleTime.endTime, null);
assert.equal(singleTime.body, 'Solo task');

// Notes without time marker
const plainNotes = parseTaskNotes('Just normal notes');
assert.equal(plainNotes.startTime, null);
assert.equal(plainNotes.endTime, null);
assert.equal(plainNotes.body, 'Just normal notes');

// Composing notes
assert.equal(
  composeTaskNotes({ startTime: '14:30', endTime: '15:30', notes: 'Agenda' }),
  '⏰ 14:30–15:30\n\nAgenda',
);
assert.equal(
  composeTaskNotes({ startTime: '09:00', endTime: undefined, notes: '' }),
  '⏰ 09:00',
);
assert.equal(
  composeTaskNotes({ startTime: undefined, endTime: undefined, notes: 'Plain body' }),
  'Plain body',
);

console.log('--- 5. FILTERS & BUCKETS ---');
assert.deepEqual(canonicalFilters(['today', 'invalid', 'completed']), ['today', 'completed']);
assert.equal(ALL_TASK_FILTERS.length, 5);

const todayStr = '2026-08-25';
assert.equal(taskBucket(genTask, null, todayStr), 'general');
assert.equal(taskBucket(datedTask, '2026-08-24', todayStr), 'overdue');
assert.equal(taskBucket(datedTask, '2026-08-25', todayStr), 'today');
assert.equal(taskBucket(datedTask, '2026-08-26', todayStr), 'upcoming');

// matchesFilters
assert.equal(matchesFilters(genTask, null, [], todayStr), true, 'Empty filter matches all');
assert.equal(matchesFilters(genTask, null, ['general'], todayStr), true);
assert.equal(matchesFilters(genTask, null, ['today'], todayStr), false);
assert.equal(matchesFilters({ ...genTask, completed: true }, null, ['completed'], todayStr), true);

console.log('--- 6. SUBTASK TREE BUILDING ---');
const treeInput: Task[] = [
  { id: 'p1', title: 'Parent 1', order: 1 },
  { id: 'c1', title: 'Child 1A', parentId: 'p1', order: 2 },
  { id: 'c2', title: 'Child 1B', parentId: 'p1', order: 1 },
  { id: 'orphan', title: 'Orphaned Task', parentId: 'nonexistent_parent', order: 0 },
  { id: 'p2', title: 'Parent 2', order: 0 },
];
const tree = buildTaskTree(treeInput);
assert.equal(tree.length, 3, '2 valid parents + 1 promoted orphan root');
assert.equal(tree[0].task.id, 'orphan');
assert.equal(tree[1].task.id, 'p2');
assert.equal(tree[2].task.id, 'p1');
assert.equal(tree[2].children.length, 2);
assert.equal(tree[2].children[0].id, 'c2', 'Children sorted by order');
assert.equal(tree[2].children[1].id, 'c1');

console.log('--- 7. CREATE, EDIT SERIES & DELETE SCOPED ---');
// makeTask creates a task with default due date today
const newTask = makeTask({ title: 'New Item' }, 1);
assert.ok(newTask.id.length > 0);
assert.equal(newTask.title, 'New Item');
assert.equal(newTask.deleted, false);
assert.ok(newTask.weekKey !== undefined);

// editTaskSeries: reordering / listId update does NOT detach occurrence
const storeWithRec: TaskData = {
  m1: { id: 'm1', title: 'Master', weekKey: '2026-08-24', dayIndex: 0, recur: { freq: 'daily' }, listId: 'general', order: 0 },
};
const reordered = editTaskSeries(storeWithRec, 'm1::2026-08-26', { order: 5, listId: 'work' }, '2026-08-24', 1);
assert.equal(reordered.targetId, 'm1::2026-08-26');
assert.equal(reordered.events.m1.order, 5);
assert.equal(reordered.events.m1.listId, 'work');
assert.equal(Object.keys(reordered.events).length, 1, 'No detached copy created');

// editTaskSeries: title/time change detaches occurrence and strips Google Tasks metadata
const withGoogleMeta: TaskData = {
  m1: { ...storeWithRec.m1, gTaskId: 'gt-123', gTaskListId: 'list-1', gTaskETag: 'etag-1' },
};
const detached = editTaskSeries(withGoogleMeta, 'm1::2026-08-26', { title: 'Special Wednesday' }, '2026-08-24', 1);
assert.ok(detached.targetId !== 'm1');
const detachedTask = detached.events[detached.targetId];
assert.equal(detachedTask.title, 'Special Wednesday');
assert.equal(detachedTask.gTaskId, undefined, 'Detached copy must strip gTaskId');
assert.equal(detachedTask.gTaskListId, undefined);

// deleteTaskScoped: 'this' adds exdate
const deletedThis = deleteTaskScoped(storeWithRec, 'm1::2026-08-26', 'this');
assert.deepEqual(deletedThis.m1.exdates, ['2026-08-26']);

// deleteTaskScoped: 'following' sets until date
const deletedFollowing = deleteTaskScoped(storeWithRec, 'm1::2026-08-27', 'following');
assert.equal(deletedFollowing.m1.recur?.end?.until, '2026-08-26');

// deleteTaskScoped: 'all' deletes master and its subtasks
const withChild: TaskData = {
  m1: storeWithRec.m1,
  child: { id: 'child', title: 'Child', parentId: 'm1' },
};
const deletedAll = deleteTaskScoped(withChild, 'm1::2026-08-26', 'all');
assert.equal(deletedAll.m1, undefined);
assert.equal(deletedAll.child, undefined, 'Child deleted along with parent');

console.log('--- 8. DEFENSIVE COERCION ---');
assert.deepEqual(coerceTasks(null), {});
assert.deepEqual(coerceTasks(undefined), {});
assert.deepEqual(coerceTasks([]), {});

const garbageTasks = coerceTasks({
  t_valid: { id: 't_valid', title: 'Valid Task', notes: 'Hi', order: 1, weekKey: '2026-08-24', dayIndex: 3 },
  t_bad_title: { id: 'bad', title: 123 },
  t_leaked_gcal: { id: 'gcal', title: 'Leaked', gCalId: 'google-cal-id' },
  'm::2026-08-25': { id: 'm::2026-08-25', title: 'Leaked Occ' },
});
assert.equal(Object.keys(garbageTasks).length, 1);
assert.equal(garbageTasks.t_valid.title, 'Valid Task');
assert.equal(garbageTasks.t_valid.notes, 'Hi');
assert.equal(garbageTasks.t_valid.order, 1);

console.log('--- 9. TASK LISTS ---');
assert.equal(GENERAL_LIST_ID, 'general');
assert.equal(listIdOf(undefined), 'general');
assert.equal(listIdOf(null), 'general');
assert.equal(listIdOf('work'), 'work');

const lists: TaskList[] = [
  { id: 'general', name: 'General', color: '#3b82f6' },
  { id: 'work', name: 'Work', color: '#22c55e' },
  { id: 'shopping', name: 'Shopping', color: '#f97316' },
];

assert.equal(resolveListId('work', lists), 'work');
assert.equal(resolveListId('deleted-list', lists), 'general', 'Unknown list falls back to General');

// nextListColor picks unused
assert.equal(nextListColor(lists), '#a855f7');

// moveList reordering
const movedRight = moveList(lists, 'general', 1);
assert.equal(movedRight[0].id, 'work');
assert.equal(movedRight[1].id, 'general');

const cannotMovePastEnd = moveList(lists, 'shopping', 1);
assert.equal(cannotMovePastEnd, lists, 'Returns original array when move is out of bounds');

// coerceTaskLists
assert.deepEqual(coerceTaskLists(null), DEFAULT_TASK_LISTS);
const customLists = coerceTaskLists([
  { id: 'work', name: 'Work', color: '#22c55e' },
]);
assert.equal(customLists.length, 2, 'General list auto-prepended');
assert.equal(customLists[0].id, 'general');
assert.equal(customLists[1].id, 'work');

const slugId = makeListId('Groceries & Supplies!');
assert.ok(slugId.startsWith('groceries-supplies-'));

console.log('\nALL PASS (tasks & taskLists)');
