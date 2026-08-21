import assert from 'node:assert/strict';
import {
  parseGoogleRecurrence,
  buildGoogleRecurrence,
  occurrenceStarts,
  deleteScoped,
  editSeries,
  resolveWeek,
  formatRecurrenceLabel,
  parseDate,
  weekKeyOf,
  type RecurFields,
  type WeekStartsOn,
  type Weekday,
} from './recurrence';
import {
  Task,
  TaskData,
  currentOpenOccurrence,
  nextOpenOccurrence,
  toggleTaskDone,
  expandTaskRange,
  isTaskDone,
  editTaskSeries,
  deleteTaskScoped,
  coerceTasks,
} from './tasks';
import { format, addDays, startOfWeek, differenceInDays } from 'date-fns';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

function testRfc5545TimezoneParsing() {
  console.log('Testing RFC 5545 UTC UNTIL and EXDATE parsing...');

  // 1. UTC UNTIL timestamp
  const utcUntilRule = ['RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;UNTIL=20260901T020000Z'];
  const res1 = parseGoogleRecurrence(utcUntilRule);
  assert.ok(res1.recur);
  assert.equal(res1.recur.freq, 'weekly');
  assert.ok(res1.recur.end && 'until' in res1.recur.end);
  const expectedDate1 = format(new Date(Date.UTC(2026, 8, 1, 2, 0, 0)), 'yyyy-MM-dd');
  assert.equal(res1.recur.end.until, expectedDate1);

  // 2. Date-only UNTIL
  const dateOnlyRule = ['RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261231'];
  const res2 = parseGoogleRecurrence(dateOnlyRule);
  assert.ok(res2.recur?.end && 'until' in res2.recur.end);
  assert.equal(res2.recur.end.until, '2026-12-31');

  // 3. UTC EXDATE
  const utcExdateRule = [
    'RRULE:FREQ=DAILY;INTERVAL=1',
    'EXDATE:20260901T020000Z,20260902T020000Z',
  ];
  const res3 = parseGoogleRecurrence(utcExdateRule);
  assert.ok(res3.exdates && res3.exdates.length === 2);
  const expEx1 = format(new Date(Date.UTC(2026, 8, 1, 2, 0, 0)), 'yyyy-MM-dd');
  const expEx2 = format(new Date(Date.UTC(2026, 8, 2, 2, 0, 0)), 'yyyy-MM-dd');
  assert.deepEqual(res3.exdates, [expEx1, expEx2]);

  // 4. VALUE=DATE EXDATE
  const dateExdateRule = [
    'RRULE:FREQ=WEEKLY;INTERVAL=1',
    'EXDATE;VALUE=DATE:20260501,20260508',
  ];
  const res4 = parseGoogleRecurrence(dateExdateRule);
  assert.deepEqual(res4.exdates, ['2026-05-01', '2026-05-08']);

  // 5. TZID EXDATE (local wall clock format)
  const tzidExdateRule = [
    'RRULE:FREQ=WEEKLY;INTERVAL=1',
    'EXDATE;TZID=America/New_York:20260601T100000,20260608T100000',
  ];
  const res5 = parseGoogleRecurrence(tzidExdateRule);
  assert.deepEqual(res5.exdates, ['2026-06-01', '2026-06-08']);

  console.log('✓ RFC 5545 timezone parsing tests passed');
}

function testWeeklyIntervalGroupingWithWeekStartsOn() {
  console.log('Testing weekly interval grouping with weekStartsOn...');

  // Master anchored on Wednesday 2025-01-08 (weekKey = 2025-01-06, dayIndex = 2)
  // Repeating every 2 weeks on Monday and Sunday (byWeekday: [1, 0])
  // With weekStartsOn = 1 (Monday):
  // Week 1: Mon 2025-01-06 to Sun 2025-01-12 (Anchor is Wed 2025-01-08, so only Sun 2025-01-12 occurs in Week 1)
  // Week 2: Mon 2025-01-13 to Sun 2025-01-19 (Skipped due to interval: 2)
  // Week 3: Mon 2025-01-20 to Sun 2025-01-26 (Both Mon 2025-01-20 and Sun 2025-01-26 occur)

  const master: RecurFields = {
    id: 'ev-biweekly-1',
    weekKey: '2025-01-06',
    dayIndex: 2, // Wed Jan 8
    recur: {
      freq: 'weekly',
      interval: 2,
      byWeekday: [1, 0], // Mon and Sun
    },
  };

  const occs = occurrenceStarts(master, new Date(2025, 0, 1), new Date(2025, 1, 1), 1 as WeekStartsOn);
  const occDates = occs.map(d => format(d, 'yyyy-MM-dd'));

  assert.deepEqual(occDates, [
    '2025-01-12', // Sun in Week 1 (after Wed Jan 8)
    '2025-01-20', // Mon in Week 3
    '2025-01-26', // Sun in Week 3
  ]);

  // Exhaustive verification for all weekStartsOn (0..6)
  for (let wkst = 0; wkst < 7; wkst++) {
    const weekStartsOn = wkst as WeekStartsOn;
    const anchorDate = new Date(2025, 0, 8);
    const anchorWeekKey = weekKeyOf(anchorDate, weekStartsOn);
    const anchorDayIndex = differenceInDays(anchorDate, parseYmd(anchorWeekKey));

    const testMaster: RecurFields = {
      id: `biweekly-test-wkst${wkst}`,
      weekKey: anchorWeekKey,
      dayIndex: anchorDayIndex,
      recur: { freq: 'weekly', interval: 2, byWeekday: [0, 1] },
    };

    const expanded = occurrenceStarts(testMaster, new Date(2025, 0, 1), new Date(2025, 2, 1), weekStartsOn);
    const anchorWs = startOfWeek(anchorDate, { weekStartsOn });
    for (const occ of expanded) {
      assert.ok(occ >= anchorDate);
      const occWs = startOfWeek(occ, { weekStartsOn });
      const weeksDiff = Math.round(differenceInDays(occWs, anchorWs) / 7);
      assert.equal(weeksDiff % 2, 0);
    }
  }

  console.log('✓ Weekly interval grouping tests passed');
}

function testDeleteFirstOccurrenceScoped() {
  console.log('Testing deleteScoped on first occurrence...');

  // Weekly series on Tuesday (2) and Thursday (4) anchored on Sunday 2025-01-05
  // First active occurrence is Tuesday 2025-01-07
  const master: RecurFields = {
    id: 'master-1',
    weekKey: '2025-01-05',
    dayIndex: 0,
    recur: {
      freq: 'weekly',
      interval: 1,
      byWeekday: [2, 4],
    },
  };

  const raw = { 'master-1': master };

  // Case 1: Delete following on the first active occurrence (2025-01-07)
  const del1 = deleteScoped(raw, 'master-1::2025-01-07', 'following');
  assert.equal(Object.keys(del1).length, 0, 'Master should be dropped when deleting from first active occurrence');

  // Case 2: Delete following on the second active occurrence (2025-01-09)
  const del2 = deleteScoped(raw, 'master-1::2025-01-09', 'following');
  assert.ok(del2['master-1'], 'Master should remain when deleting from 2nd occurrence');
  assert.equal(del2['master-1'].recur?.end && 'until' in del2['master-1'].recur.end ? del2['master-1'].recur.end.until : null, '2025-01-08');

  // Case 3: Task delete scoped
  const taskMaster: Task = {
    id: 'task-1',
    title: 'Bi-daily review',
    weekKey: '2025-01-05',
    dayIndex: 0,
    recur: {
      freq: 'weekly',
      interval: 1,
      byWeekday: [2, 4],
    },
  };
  const rawTasks = { 'task-1': taskMaster };
  const delTask = deleteTaskScoped(rawTasks, 'task-1::2025-01-07', 'following');
  assert.equal(Object.keys(delTask).length, 0, 'Task master should be dropped when deleting from first active occurrence');

  console.log('✓ Delete scoped first occurrence tests passed');
}

function testMonthlyYearlyDragAnchorStability() {
  console.log('Testing monthly/yearly drag anchor stability...');

  // Master created in 2025 on the 15th
  const master: RecurFields = {
    id: 'monthly-1',
    weekKey: '2025-01-12',
    dayIndex: 3, // 2025-01-15 (Wed)
    locked: true,
    recur: {
      freq: 'monthly',
      interval: 1,
    },
  };

  const raw = { 'monthly-1': master };

  const res = editSeries(
    raw,
    'monthly-1', // no occDate in ID
    { weekKey: '2026-08-17', dayIndex: 1 },
    '2026-08-10',
    1 as WeekStartsOn,
  );

  const updated = res.events['monthly-1'];
  assert.ok(updated);
  const updatedAnchorDate = addDays(parseDate(updated.weekKey ?? '0000-01-01'), updated.dayIndex ?? 0);
  assert.equal(format(updatedAnchorDate, 'yyyy-MM-dd'), '2025-01-18');

  console.log('✓ Drag anchor stability tests passed');
}

function testSafeModuloCustomViews() {
  console.log('Testing safe positive modulo for custom views...');

  // Range -100 to +100 across all weekStartsOn (0..6)
  const refDate = new Date(2026, 7, 21);
  for (let wkst = 0; wkst < 7; wkst++) {
    const weekStartsOn = wkst as WeekStartsOn;
    const ws = startOfWeek(refDate, { weekStartsOn });
    for (let dayIndex = -100; dayIndex <= 100; dayIndex++) {
      const actualDate = addDays(ws, dayIndex);
      const groundTruth = actualDate.getDay() as Weekday;
      const formula = (((dayIndex + weekStartsOn) % 7 + 7) % 7) as Weekday;
      assert.equal(formula, groundTruth, `Mismatch at dayIndex=${dayIndex}, wkst=${weekStartsOn}`);
    }
  }

  console.log('✓ Safe positive modulo tests passed');
}

function testMonthEndAndLeapYearRecurrence() {
  console.log('Testing month-end and leap-year recurrence expansion...');

  // Monthly on 31st starting Jan 31, 2024 (2024 is a leap year)
  const monthly31: RecurFields = {
    id: 'monthly-31',
    weekKey: '2024-01-28',
    dayIndex: 3, // 2024-01-31
    recur: { freq: 'monthly', interval: 1, end: { count: 5 } },
  };

  const mOccs = occurrenceStarts(monthly31, new Date(2024, 0, 1), new Date(2024, 6, 1));
  const mDates = mOccs.map(d => format(d, 'yyyy-MM-dd'));
  assert.deepEqual(mDates, [
    '2024-01-31',
    '2024-02-29', // Feb in leap year
    '2024-03-31',
    '2024-04-30',
    '2024-05-31',
  ]);

  // Yearly on Feb 29 starting Feb 29, 2024
  const yearlyLeap: RecurFields = {
    id: 'yearly-leap',
    weekKey: '2024-02-25',
    dayIndex: 4, // 2024-02-29
    recur: { freq: 'yearly', interval: 1, end: { count: 3 } },
  };

  const yOccs = occurrenceStarts(yearlyLeap, new Date(2024, 0, 1), new Date(2027, 0, 1));
  const yDates = yOccs.map(d => format(d, 'yyyy-MM-dd'));
  assert.deepEqual(yDates, [
    '2024-02-29',
    '2025-02-28', // Non-leap year clamps to Feb 28
    '2026-02-28',
  ]);

  console.log('✓ Month-end and leap-year recurrence tests passed');
}

function testTaskCompletionRollForward() {
  console.log('Testing task completion roll-forward with custom recurrence rules...');

  const today = '2026-08-21';
  const taskDaily3: Task = {
    id: 'task-daily-3',
    title: 'Water plants every 3 days',
    weekKey: '2026-08-17',
    dayIndex: 1, // 2026-08-18 (Tue) -> Occurrences: 2026-08-18, 2026-08-21, 2026-08-24...
    recur: { freq: 'daily', interval: 3 },
  };

  assert.equal(currentOpenOccurrence(taskDaily3, today, true), '2026-08-21');
  assert.equal(currentOpenOccurrence(taskDaily3, today, false), '2026-08-18');

  let tasks: TaskData = { [taskDaily3.id]: taskDaily3 };
  tasks = toggleTaskDone(tasks, 'task-daily-3::2026-08-21', { today, autoRollRecurring: true });
  assert.deepEqual(tasks['task-daily-3'].completedDates, ['2026-08-21']);
  assert.equal(currentOpenOccurrence(tasks['task-daily-3'], today, true), '2026-08-24');

  // Multi-occurrence COUNT test
  const taskBiweeklyCount: Task = {
    id: 'task-count',
    title: 'Gym session',
    weekKey: '2026-08-17',
    dayIndex: 0,
    recur: { freq: 'weekly', interval: 2, byWeekday: [1, 4], end: { count: 3 } },
  };

  let raw: TaskData = { [taskBiweeklyCount.id]: taskBiweeklyCount };
  raw = toggleTaskDone(raw, 'task-count::2026-08-17', { today, autoRollRecurring: true });
  raw = toggleTaskDone(raw, 'task-count::2026-08-20', { today, autoRollRecurring: true });
  raw = toggleTaskDone(raw, 'task-count::2026-08-31', { today, autoRollRecurring: true });
  assert.equal(currentOpenOccurrence(raw['task-count'], today, true), null);

  console.log('✓ Task completion roll-forward tests passed');
}

function runAllTests() {
  console.log('--- RUNNING COMPLETE RECURRENCE ENGINE TEST SUITE ---');
  testRfc5545TimezoneParsing();
  testWeeklyIntervalGroupingWithWeekStartsOn();
  testDeleteFirstOccurrenceScoped();
  testMonthlyYearlyDragAnchorStability();
  testSafeModuloCustomViews();
  testMonthEndAndLeapYearRecurrence();
  testTaskCompletionRollForward();
  console.log('====================================================');
  console.log('ALL RECURRENCE TESTS PASSED SUCCESSFULLY!');
}

runAllTests();
