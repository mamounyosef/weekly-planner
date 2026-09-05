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


// ─── WKST, and the week phase a scoped delete is decided on ─────────────────
//
// Weekly expansion buckets occurrences by the start of THEIR WEEK, so once the
// interval is two or more the dates depend on which day a week begins. Two
// separate places got that wrong in the same way, and both were silent.
function testWeekPhaseIsCarriedEverywhere() {
  console.log('\n--- WEEK PHASE: WKST AND SCOPED DELETE ---');

  // A fortnightly "Sunday and Wednesday" anchored on a Sunday. The two week
  // starts genuinely disagree; that is the premise everything below rests on.
  const master: RecurFields = {
    weekKey: '2026-01-04',
    dayIndex: 0,
    startTime: '09:00',
    recur: { freq: 'weekly', interval: 2, byWeekday: [0, 3] as Weekday[] },
  };
  const from = parseDate('2026-01-01');
  const to = parseDate('2026-03-01');
  assert.notDeepEqual(
    occurrenceStarts(master, from, to, 0).map(d => d.toDateString()),
    occurrenceStarts(master, from, to, 1).map(d => d.toDateString()),
    'the premise: a fortnightly rule really does land differently on each week start',
  );

  // ── 1. The rule sent to Google now says which day weeks start on ──────────
  const monRule = buildGoogleRecurrence(master, 'UTC', 1)![0];
  const sunRule = buildGoogleRecurrence(master, 'UTC', 0)![0];
  assert.ok(monRule.includes(';WKST=MO'), 'a fortnightly rule states WKST');
  assert.ok(sunRule.includes(';WKST=SU'), 'and states the real setting, not a default');
  assert.notEqual(monRule, sunRule, 'the two settings produce different rules');

  // Every weekday code is reachable, so no setting silently emits the wrong one.
  const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  for (let w = 0; w < 7; w += 1) {
    const rule = buildGoogleRecurrence(master, 'UTC', w as WeekStartsOn)![0];
    assert.ok(rule.includes(';WKST=' + CODES[w]), 'week start ' + w + ' emits ' + CODES[w]);
  }

  // ── 2. WKST is emitted ONLY where it can change the answer ────────────────
  // Rewriting every existing rule in Google for no behavioural reason is its own
  // kind of damage, so a rule whose dates cannot depend on the week start does
  // not carry it.
  const everyWeek: RecurFields = {
    ...master, recur: { freq: 'weekly', interval: 1, byWeekday: [0, 3] as Weekday[] },
  };
  assert.ok(!buildGoogleRecurrence(everyWeek, 'UTC', 1)![0].includes('WKST'),
    'INTERVAL=1 gives the same dates on every week start, so it says nothing');
  const daily: RecurFields = { ...master, recur: { freq: 'daily', interval: 3 } };
  assert.ok(!buildGoogleRecurrence(daily, 'UTC', 1)![0].includes('WKST'),
    'a daily rule is not bucketed by week');
  const monthly: RecurFields = { ...master, recur: { freq: 'monthly', interval: 2 } };
  assert.ok(!buildGoogleRecurrence(monthly, 'UTC', 1)![0].includes('WKST'), 'nor is a monthly one');
  const yearly: RecurFields = { ...master, recur: { freq: 'yearly', interval: 2 } };
  assert.ok(!buildGoogleRecurrence(yearly, 'UTC', 1)![0].includes('WKST'), 'nor a yearly one');

  // The default is Monday, which is what RFC 5545 assumes when a rule is silent,
  // so an omitted argument cannot change the meaning of an existing rule.
  assert.equal(buildGoogleRecurrence(master, 'UTC')![0], monRule,
    'the default matches the RFC default, so nothing shifts when it is not passed');

  // Everything else about the rule survives.
  const withUntil: RecurFields = {
    ...master,
    recur: {
      freq: 'weekly', interval: 2, byWeekday: [0, 3] as Weekday[], end: { until: '2026-06-01' },
    },
  };
  const untilRule = buildGoogleRecurrence(withUntil, 'UTC', 1)![0];
  assert.ok(untilRule.includes('UNTIL='), 'UNTIL is still there');
  assert.ok(untilRule.includes('BYDAY=SU,WE'), 'and BYDAY');
  assert.ok(untilRule.includes('WKST=MO'), 'alongside WKST');

  // ── 3. `deleteScoped` decides on the phase the GRID drew ──────────────────
  //
  // "Delete this and following" first asks "is this the FIRST occurrence, in
  // which case there is nothing before it and this is really delete-all?". It
  // expanded the series against Sunday while the grid the user clicked in used
  // their real setting, so on a fortnightly rule the question was answered
  // about a series nobody could see.
  //
  // The case below is not a near miss. A fortnightly Sunday anchored on
  // Thursday 1 January: on Monday-weeks the anchor sits in the week of 29 Dec,
  // so the first occurrence is 4 January and 11 January is a later one; on
  // Sunday-weeks the first occurrence is 11 January itself. Ask to remove "this
  // and the rest" from 11 January and the two answers are TRIM THE SERIES and
  // DELETE THE WHOLE THING. That is the difference between losing one tail and
  // losing a repeat the user has kept for years.
  const ymdOf = (d: Date) => (
    d.getFullYear()
    + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
  );

  const fortnightlySunday: RecurFields = {
    weekKey: '2026-01-01',
    dayIndex: 0,
    startTime: '09:00',
    recur: { freq: 'weekly', interval: 2, byWeekday: [0] as Weekday[] },
  };
  const raw: Record<string, RecurFields> = { m: fortnightlySunday };

  const firstOnMonday = occurrenceStarts(
    fortnightlySunday, parseDate('2026-01-01'), parseDate('2026-04-01'), 1,
  )[0];
  const firstOnSunday = occurrenceStarts(
    fortnightlySunday, parseDate('2026-01-01'), parseDate('2026-04-01'), 0,
  )[0];
  assert.notEqual(ymdOf(firstOnMonday), ymdOf(firstOnSunday),
    'the premise: the two phases disagree about which occurrence is the first');
  assert.equal(ymdOf(firstOnMonday), '2026-01-04', 'Monday weeks start the series on the 4th');
  assert.equal(ymdOf(firstOnSunday), '2026-01-11', 'Sunday weeks start it on the 11th');

  const target = makeOccId('m', '2026-01-11');
  const trimmed = deleteScoped(raw, target, 'following', 1);
  assert.ok(trimmed.m, 'told the real week start, the series survives');
  assert.ok(trimmed.m.recur?.end && 'until' in trimmed.m.recur.end,
    'and is trimmed with an UNTIL, which is what "and following" means');
  assert.equal((trimmed.m.recur!.end as { until: string }).until, '2026-01-10',
    'ending the day before the occurrence that was removed');

  // The old behaviour, said out loud, so the cost of getting this wrong is on
  // the record: the same request, expanded on the wrong phase, removes the lot.
  const wiped = deleteScoped(raw, target, 'following', 0);
  assert.equal(wiped.m, undefined,
    'on the wrong phase the same request deletes the entire series instead');

  // Deleting from the genuine first occurrence still collapses to delete-all,
  // which is the behaviour the phase argument must not break.
  const firstGone = deleteScoped(raw, makeOccId('m', '2026-01-04'), 'following', 1);
  assert.equal(firstGone.m, undefined, 'removing from the first occurrence removes the series');

  // 'one' and 'all' do not consult the phase at all, and must keep working.
  const oneGone = deleteScoped(raw, target, 'one', 1);
  assert.deepEqual(oneGone.m.exdates, ['2026-01-11'], 'one occurrence becomes an EXDATE');
  assert.equal(deleteScoped(raw, target, 'all', 1).m, undefined, 'all removes the master');

  // Every week start is accepted and none of them throws.
  for (const w of [0, 1, 2, 3, 4, 5, 6] as WeekStartsOn[]) {
    const out = deleteScoped(raw, target, 'following', w);
    assert.ok(out.m === undefined || out.m.recur, `week start ${w} gives a coherent answer`);
  }

  // A non-repeating item ignores the phase entirely.
  const plain: Record<string, RecurFields> = {
    p: { weekKey: '2026-01-04', dayIndex: 0, startTime: '09:00' },
  };
  for (const w of [0, 1, 2, 3, 4, 5, 6] as WeekStartsOn[]) {
    assert.equal(deleteScoped(plain, makeOccId('p', '2026-01-04'), 'following', w).p, undefined,
      'a one-off is removed whatever the week start (' + w + ')');
  }

  // The default stays 0, so nothing that does not pass it changes behaviour.
  assert.deepEqual(
    deleteScoped(raw, target, 'following'),
    deleteScoped(raw, target, 'following', 0),
    'the omitted argument is the old default',
  );

  console.log('  Week phase reaches Google and the delete scope');
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
  testWeekPhaseIsCarriedEverywhere();
  console.log('====================================================');
  console.log('ALL RECURRENCE TESTS PASSED SUCCESSFULLY!');
}

runAllTests();
