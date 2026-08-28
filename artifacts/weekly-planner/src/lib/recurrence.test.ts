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
  getEventWeekOverlap,
  normalizeAnchor,
  stampNewItem,
  makeOccId,
  parseOccId,
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
    'monthly-1',
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
    dayIndex: 1,
    recur: { freq: 'daily', interval: 3 },
  };

  assert.equal(currentOpenOccurrence(taskDaily3, today, true), '2026-08-21');
  assert.equal(currentOpenOccurrence(taskDaily3, today, false), '2026-08-18');

  let tasks: TaskData = { [taskDaily3.id]: taskDaily3 };
  tasks = toggleTaskDone(tasks, 'task-daily-3::2026-08-21', { today, autoRollRecurring: true });
  assert.deepEqual(tasks['task-daily-3'].completedDates, ['2026-08-21']);
  assert.equal(currentOpenOccurrence(tasks['task-daily-3'], today, true), '2026-08-24');

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

function testEventWeekOverlapAndCustomRanges() {
  console.log('Testing getEventWeekOverlap with standard and custom ranges...');

  const weekStart = new Date(2026, 7, 24); // Mon Aug 24, 2026

  // 1. Event fully within week (Wed Aug 26, 2-day span -> Wed & Thu)
  const ev1: RecurFields = { id: 'ev1', weekKey: '2026-08-24', dayIndex: 2, daysSpan: 2 };
  const overlap1 = getEventWeekOverlap(ev1, weekStart);
  assert.deepEqual(overlap1, { dayIndex: 2, daysSpan: 2 });

  // 2. Event spanning across week start (started Fri before, span 5 days -> Fri, Sat, Sun, Mon, Tue)
  const ev2: RecurFields = { id: 'ev2', weekKey: '2026-08-17', dayIndex: 4, daysSpan: 5 };
  const overlap2 = getEventWeekOverlap(ev2, weekStart);
  assert.deepEqual(overlap2, { dayIndex: 0, daysSpan: 2 }, 'Clips to visible week start with daysSpan 2');

  // 3. Event completely outside week
  const ev3: RecurFields = { id: 'ev3', weekKey: '2026-08-17', dayIndex: 0, daysSpan: 2 };
  assert.equal(getEventWeekOverlap(ev3, weekStart), null);

  // 4. Custom range (-2 to 5 -> Sat Aug 22 to Sat Aug 29)
  const customRange = { from: -2, to: 5 };
  const overlapCustom = getEventWeekOverlap(ev2, weekStart, customRange);
  assert.ok(overlapCustom !== null);
  assert.equal(overlapCustom?.dayIndex, -2, 'Starts on Saturday in custom view');
  assert.equal(overlapCustom?.daysSpan, 4, 'Spans 4 visible days (Sat, Sun, Mon, Tue)');

  console.log('✓ Event week overlap tests passed');
}

function testNormalizeAnchorAndStamping() {
  console.log('Testing normalizeAnchor, stampNewItem, and occId parsing...');

  // normalizeAnchor when dayIndex is out of range (< 0 or > 6)
  const outOfRangeItem: RecurFields = { id: 'item-1', weekKey: '2026-08-24', dayIndex: 9 };
  const normalized = normalizeAnchor(outOfRangeItem, 1 as WeekStartsOn);
  assert.equal(normalized.weekKey, '2026-08-31');
  assert.equal(normalized.dayIndex, 2);

  const negativeItem: RecurFields = { id: 'item-2', weekKey: '2026-08-24', dayIndex: -2 };
  const normalizedNeg = normalizeAnchor(negativeItem, 1 as WeekStartsOn);
  assert.equal(normalizedNeg.weekKey, '2026-08-17');
  assert.equal(normalizedNeg.dayIndex, 5);

  // stampNewItem
  const stamped = stampNewItem({ id: 'item-new', content: 'New Event' }, '2026-08-24', 1 as WeekStartsOn);
  assert.equal(stamped.weekKey, '2026-08-24');
  assert.equal(stamped.deleted, false);
  assert.ok(stamped.updatedAt !== undefined);

  // makeOccId & parseOccId
  const occId = makeOccId('master-123', '2026-08-25');
  assert.equal(occId, 'master-123::2026-08-25');
  const parsed = parseOccId(occId);
  assert.equal(parsed.masterId, 'master-123');
  assert.equal(parsed.occDate, '2026-08-25');

  const plainParsed = parseOccId('single-id');
  assert.equal(plainParsed.masterId, 'single-id');
  assert.equal(plainParsed.occDate, null);

  console.log('✓ Anchor normalization and occId tests passed');
}

function testResolveWeekSpillInAndDeduping() {
  console.log('Testing resolveWeek overnight spill-in and duplicate gCal deduplication...');

  const viewedWeek = '2026-08-24'; // Mon Aug 24

  // 1. Overnight timed item starting on Sunday Aug 23 (23:00 to 01:00)
  const rawEvents: Record<string, RecurFields> = {
    'ev-overnight': {
      id: 'ev-overnight',
      weekKey: '2026-08-17',
      dayIndex: 6, // Sunday Aug 23
      startTime: '23:00',
      endTime: '01:00',
      allDay: false,
    },
    // Duplicate Google event with same gCalId
    'ev-gcal-old': {
      id: 'ev-gcal-old',
      gCalId: 'gcal-dup-1',
      weekKey: '2026-08-24',
      dayIndex: 1,
      lastSyncedAt: 1000,
    },
    'ev-gcal-fresh': {
      id: 'ev-gcal-fresh',
      gCalId: 'gcal-dup-1',
      weekKey: '2026-08-24',
      dayIndex: 1,
      lastSyncedAt: 2000,
    },
  };

  const resolved = resolveWeek(rawEvents, viewedWeek, undefined, 1 as WeekStartsOn);
  // Overnight event is included with negative dayIndex
  assert.ok(resolved['ev-overnight'], 'Overnight event from Sunday included in Monday view');
  assert.equal(resolved['ev-overnight'].dayIndex, -1);

  // Duplicate Google event: only freshest kept
  assert.equal(resolved['ev-gcal-old'], undefined, 'Old duplicate Google event must be discarded');
  assert.ok(resolved['ev-gcal-fresh'], 'Freshest duplicate Google event must be kept');

  console.log('✓ Resolve week spill-in and deduping tests passed');
}

function testBuildGoogleRecurrenceAndLabels() {
  console.log('Testing buildGoogleRecurrence and formatRecurrenceLabel...');

  const master: RecurFields = {
    id: 'm1',
    startTime: '10:00',
    endTime: '11:00',
    allDay: false,
    recur: { freq: 'weekly', interval: 2, byWeekday: [1, 3] },
    exdates: ['2026-08-26'],
  };

  const gRecur = buildGoogleRecurrence(master, 'Asia/Amman');
  assert.ok(gRecur && gRecur.length === 2);
  assert.ok(gRecur[0].includes('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'));
  assert.ok(gRecur[1].includes('EXDATE;TZID=Asia/Amman:20260826T100000'));

  // Recurrence labels
  assert.equal(formatRecurrenceLabel(undefined), "Doesn't repeat");
  assert.equal(formatRecurrenceLabel({ freq: 'daily', interval: 1 }), 'Daily');
  assert.equal(formatRecurrenceLabel({ freq: 'daily', interval: 3 }), 'Every 3 days');
  assert.equal(formatRecurrenceLabel({ freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] }), 'Weekdays');
  assert.equal(formatRecurrenceLabel({ freq: 'monthly', interval: 1 }), 'Monthly');
  assert.equal(formatRecurrenceLabel({ freq: 'yearly', interval: 1 }), 'Yearly');

  console.log('✓ buildGoogleRecurrence and formatRecurrenceLabel tests passed');
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
  testEventWeekOverlapAndCustomRanges();
  testNormalizeAnchorAndStamping();
  testResolveWeekSpillInAndDeduping();
  testBuildGoogleRecurrenceAndLabels();
  console.log('====================================================');
  console.log('ALL RECURRENCE TESTS PASSED SUCCESSFULLY!');
}

runAllTests();
