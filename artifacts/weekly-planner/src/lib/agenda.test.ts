// Tests the day builder the phone screen renders: which items land on which
// date, in what order, and how the edges behave.
//
// Two properties are load-bearing. ORDER MUST BE TOTAL — a list that reshuffles
// between renders reads as a bug even when the contents are right. And a MALFORMED
// RECORD MUST BE VISIBLE rather than silently sorted to midnight, because an item
// quietly appearing at the top of the wrong day is the kind of thing you only
// notice by missing it.
//
// Run with: npx tsx src/lib/agenda.test.ts

import assert from 'node:assert/strict';
import {
  addDays,
  buildDay,
  compareItems,
  countsForRange,
  currentItem,
  dayLabel,
  daysAround,
  formatMinutes,
  isDone,
  isToday,
  minutesOf,
  nextItem,
  occursOn,
  summariseDay,
  ymd,
  type AgendaItem,
} from './agenda';
import type { RecurFields } from './recurrence';
import { colourOf, titleOf } from './agenda';
import { FALLBACK_EVENT_HEX, SWATCH_BASE_HEX } from './gcalColor';

const MON = '2026-08-31'; // a Monday
const TUE = '2026-09-01';
const WED = '2026-09-02';
const WEEK = '2026-08-30';  // the Sunday that starts the week containing MON

/** A stored event/task record, in the shape the sync stores hold. */
const rec = (extra: Record<string, unknown>): Record<string, unknown> => ({
  title: 'Item',
  weekKey: WEEK,
  dayIndex: 1, // Monday, when the week starts on Sunday
  ...extra,
});

const titles = (items: AgendaItem[]) => items.map(i => i.title);

console.log('--- 1. TIME PARSING IS STRICT ---');
{
  assert.equal(minutesOf('00:00'), 0);
  assert.equal(minutesOf('09:05'), 545);
  assert.equal(minutesOf('9:05'), 545, 'A single-digit hour is accepted');
  assert.equal(minutesOf('23:59'), 1439);
  assert.equal(minutesOf('  18:30  '), 1110, 'Whitespace is trimmed');

  // Everything below must be null, NOT 0 — a broken time sorting to midnight
  // would put a corrupt item at the top of the day.
  for (const bad of [
    '24:00', '23:60', '-1:00', '12', '12:', ':30', '12:5', '12:345',
    '12:00:00', 'noon', '', '  ', null, undefined, 0, 1110, {}, [], NaN,
  ]) {
    assert.equal(minutesOf(bad as any), null, `minutesOf(${JSON.stringify(bad)}) must be null`);
  }

  assert.equal(formatMinutes(0), '00:00');
  assert.equal(formatMinutes(545), '09:05');
  assert.equal(formatMinutes(1439), '23:59');
  assert.equal(formatMinutes(null), '', 'An all-day item shows no time at all');
  assert.equal(formatMinutes(1440), '00:00', 'Midnight the next day wraps rather than showing 24:00');
}

console.log('--- 2. A ONE-OFF ITEM OCCURS ON EXACTLY ONE DAY ---');
{
  const ev = rec({}) as unknown as RecurFields;
  assert.equal(occursOn(ev, MON), true);
  assert.equal(occursOn(ev, TUE), false);
  assert.equal(occursOn(ev, '2026-08-30'), false);

  // A record with no anchor belongs to no day at all.
  assert.equal(occursOn({ id: 'x' } as RecurFields, MON), false, 'No weekKey, no day');
  assert.equal(occursOn(rec({ weekKey: undefined }) as any, MON), false);

  // Garbage dates do not throw.
  assert.equal(occursOn(ev, 'not-a-date'), false);
  assert.equal(occursOn(ev, ''), false);
}

console.log('--- 3. A MULTI-DAY ITEM COVERS ITS WHOLE SPAN ---');
{
  const trip = rec({ allDay: true, daysSpan: 3 }) as unknown as RecurFields;
  assert.equal(occursOn(trip, MON), true, 'first day');
  assert.equal(occursOn(trip, TUE), true, 'middle day');
  assert.equal(occursOn(trip, WED), true, 'last day');
  assert.equal(occursOn(trip, '2026-09-03'), false, 'the day after is not included');
  assert.equal(occursOn(trip, '2026-08-30'), false, 'nor the day before');

  // A span of 0 or a nonsense span still covers its own day rather than none.
  assert.equal(occursOn(rec({ daysSpan: 0 }) as any, MON), true);
  assert.equal(occursOn(rec({ daysSpan: -3 }) as any, MON), true);
}

console.log('--- 4. REPEATS EXPAND THROUGH THE SHARED ENGINE ---');
{
  const weekly = rec({
    title: 'Standup',
    recur: { freq: 'weekly', interval: 1 },
  }) as unknown as RecurFields;

  assert.equal(occursOn(weekly, MON), true, 'the anchor');
  assert.equal(occursOn(weekly, '2026-09-07'), true, 'a week later');
  assert.equal(occursOn(weekly, '2026-09-14'), true, 'and the week after');
  assert.equal(occursOn(weekly, TUE), false, 'but not on other weekdays');
  assert.equal(occursOn(weekly, '2026-08-24'), false, 'and never before the anchor');

  // Exclusions are honoured — this is the "skip just this one" rule.
  const withSkip = { ...weekly, exdates: ['2026-09-07'] } as RecurFields;
  assert.equal(occursOn(withSkip, MON), true);
  assert.equal(occursOn(withSkip, '2026-09-07'), false, 'A skipped occurrence does not appear');
  assert.equal(occursOn(withSkip, '2026-09-14'), true, 'and the rest are unaffected');

  // An end date stops it.
  const bounded = { ...weekly, recur: { freq: 'weekly', interval: 1, end: { until: '2026-09-07' } } } as RecurFields;
  assert.equal(occursOn(bounded, '2026-09-07'), true);
  assert.equal(occursOn(bounded, '2026-09-14'), false, 'Past UNTIL it stops');

  // Every other week.
  const fortnightly = { ...weekly, recur: { freq: 'weekly', interval: 2 } } as RecurFields;
  assert.equal(occursOn(fortnightly, MON), true);
  assert.equal(occursOn(fortnightly, '2026-09-07'), false, 'the skipped week');
  assert.equal(occursOn(fortnightly, '2026-09-14'), true);
}

console.log('--- 5. A DAY IS BUILT IN THE ORDER IT IS READ ---');
{
  const day = buildDay({
    events: {
      lunch: rec({ title: 'Lunch', startTime: '13:00', endTime: '14:00' }),
      standup: rec({ title: 'Standup', startTime: '09:30', endTime: '09:45' }),
      holiday: rec({ title: 'Bank holiday', allDay: true }),
      lecture: rec({ title: 'Lecture', startTime: '09:30', endTime: '11:00' }),
    },
    tasks: {
      shop: rec({ title: 'Buy milk' }),
      call: rec({ title: 'Call the bank', startTime: '11:30' }),
    },
    date: MON,
  });

  assert.deepEqual(titles(day.allDay), ['Bank holiday'], 'All-day items are their own band');
  assert.deepEqual(titles(day.timed), ['Standup', 'Lecture', 'Call the bank', 'Lunch'],
    'Timed items run in clock order; two starting at 09:30 put the shorter one first');
  assert.deepEqual(titles(day.tasks), ['Buy milk'], 'A dated task with no time sits in the task strip');
  assert.deepEqual(titles(day.all), ['Bank holiday', 'Standup', 'Lecture', 'Call the bank', 'Lunch', 'Buy milk'],
    'and the combined list is what the screen paints, top to bottom');
  assert.equal(day.counts.total, 6);
  assert.equal(day.counts.done, 0);
}

console.log('--- 6. THE ORDER IS TOTAL AND STABLE ---');
{
  // Identical items differing only in id must still have a definite order, or
  // the list reshuffles on every render.
  const mk = (id: string, title: string, start: number | null): AgendaItem => ({
    id, masterId: id, kind: start === null ? 'allDay' : 'timed', title,
    startMin: start, endMin: start === null ? null : start + 60,
    date: MON, completed: false, repeating: false,
  });

  const items = [
    mk('z', 'Same', 540), mk('a', 'Same', 540), mk('m', 'Same', 540),
    mk('b', 'Alpha', 540), mk('c', 'Zulu', 540),
  ];
  const once = [...items].sort(compareItems).map(i => i.id);
  for (let trial = 0; trial < 50; trial++) {
    const shuffled = [...items].sort(() => (trial % 3) - 1);
    assert.deepEqual([...shuffled].sort(compareItems).map(i => i.id), once,
      'Sorting is stable regardless of the input order');
  }
  assert.deepEqual(once, ['b', 'a', 'm', 'z', 'c'],
    'Ties break on title, then on id — never on chance');

  assert.equal(compareItems(items[0], items[0]), 0, 'An item equals itself');
}

console.log('--- 7. AN UNREADABLE TIME SORTS LAST, NOT TO MIDNIGHT ---');
{
  const day = buildDay({
    events: {
      broken: rec({ title: 'Broken time', startTime: '25:99' }),
      early: rec({ title: 'Early', startTime: '07:00' }),
      late: rec({ title: 'Late', startTime: '21:00' }),
    },
    tasks: {},
    date: MON,
  });
  assert.deepEqual(titles(day.timed), ['Early', 'Late', 'Broken time'],
    'The corrupt item is visible at the end rather than leading the day');
  assert.equal(day.timed[2].startMin, null);
}

console.log('--- 8. COMPLETION IS RECORDED DIFFERENTLY IN EACH STORE ---');
{
  // THE BUG THIS EXISTS FOR: ticking off a one-off EVENT on the phone wrote a
  // `completed` flag. The PC only ever reads `completedDates` for events, so the
  // tick appeared to work, synced perfectly, and then did nothing. Tasks really
  // do use the flag, which is what made the mistake plausible.

  // Events: per-date, always, repeating or not.
  assert.equal(isDone({ completedDates: [MON] }, MON, 'events'), true);
  assert.equal(isDone({ completedDates: [MON] }, TUE, 'events'), false);
  assert.equal(isDone({ completed: true }, MON, 'events'), false,
    'A completed FLAG on an event means nothing — the PC never writes or reads it');
  assert.equal(isDone({ recur: {}, completedDates: [MON] }, MON, 'events'), true);
  assert.equal(isDone({ recur: {}, completed: true }, MON, 'events'), false);
  assert.equal(isDone({}, MON, 'events'), false);

  // Tasks: a flag when it does not repeat, per-date when it does.
  assert.equal(isDone({ completed: true }, MON, 'tasks'), true);
  assert.equal(isDone({ completed: false }, MON, 'tasks'), false);
  assert.equal(isDone({ completedDates: [MON] }, MON, 'tasks'), true,
    'A one-off task ticked per-date still counts');
  assert.equal(isDone({ recur: {}, completedDates: [MON] }, MON, 'tasks'), true);
  assert.equal(isDone({ recur: {}, completedDates: [MON] }, TUE, 'tasks'), false,
    'Ticking today must not mark tomorrow done as well');
  assert.equal(isDone({ recur: {}, completed: true }, MON, 'tasks'), false,
    'and the flag must not mark the whole series done');

  // Garbage never reads as done.
  assert.equal(isDone({ completed: 'yes' }, MON, 'tasks'), false, 'Only a real true counts');
  assert.equal(isDone({ completedDates: 'nope' }, MON, 'events'), false);
  assert.equal(isDone({ completedDates: null }, MON, 'events'), false);
  assert.equal(isDone({}, MON, 'tasks'), false);

  // The default store is events, the stricter of the two.
  assert.equal(isDone({ completed: true }, MON), false, 'Defaulting must not invent completion');

  // And it flows through to the built day.
  const day = buildDay({
    events: {
      e1: rec({ title: 'Ticked event', completedDates: [MON] }),
      e2: rec({ title: 'Flagged event', completed: true }),
    },
    tasks: {
      t1: rec({ title: 'Done task', completed: true }),
      t2: rec({ title: 'Open task' }),
      t3: rec({ title: 'Daily', recur: { freq: 'daily', interval: 1 }, completedDates: [MON] }),
    },
    date: MON,
  });
  const byTitle = Object.fromEntries(day.all.map(i => [i.title, i]));
  assert.equal(byTitle['Ticked event'].completed, true);
  assert.equal(byTitle['Flagged event'].completed, false,
    'A flagged event reads as NOT done, matching the PC');
  assert.equal(byTitle['Done task'].completed, true);
  assert.equal(byTitle['Open task'].completed, false);
  assert.equal(byTitle['Daily'].completed, true);

  assert.equal(day.counts.total, 5);
  assert.equal(day.counts.done, 3);
  assert.equal(summariseDay(day), '2 left');
}

console.log('--- 8b. EVERY ITEM KNOWS WHICH STORE IT CAME FROM ---');
{
  // The screen writes back through this. If it were guessed from `kind`, a task
  // with a time (drawn like an event) would be written as an event and vanish.
  const day = buildDay({
    events: { e1: rec({ title: 'Meeting', startTime: '09:00' }) },
    tasks: {
      t1: rec({ title: 'Timed task', startTime: '10:00' }),
      t2: rec({ title: 'Untimed task' }),
    },
    date: MON,
  });
  const byTitle = Object.fromEntries(day.all.map(i => [i.title, i]));

  assert.equal(byTitle['Meeting'].store, 'events');
  assert.equal(byTitle['Timed task'].store, 'tasks',
    'A task with a time is DRAWN like an event but is still a task');
  assert.ok(day.timed.some(i => i.title === 'Timed task'),
    'and it is drawn in the timed band');
  assert.equal(byTitle['Timed task'].kind, 'task', 'while its kind still says task');

  // The trap this closes: an ALL-DAY task has kind 'allDay', identical to an
  // all-day event. Deriving the store from `kind` would write it into the events
  // store, where the PC would never find it again.
  const allDayTask = buildDay({
    events: {},
    tasks: { t: rec({ title: 'All-day task', allDay: true }) },
    date: MON,
  }).all[0];
  assert.equal(allDayTask.kind, 'allDay');
  assert.equal(allDayTask.store, 'tasks', 'An all-day task is still a task');
  assert.equal(byTitle['Untimed task'].store, 'tasks');
}

console.log('--- 8c. EVENTS WITH NO CHECKBOX CANNOT BE TICKED ---');
{
  const day = buildDay({
    events: {
      normal: rec({ title: 'Normal', startTime: '09:00' }),
      marker: rec({ title: 'Reference point', startTime: '10:00', noCheckbox: true }),
    },
    tasks: { t: rec({ title: 'A task', noCheckbox: true }) },
    date: MON,
  });
  const byTitle = Object.fromEntries(day.all.map(i => [i.title, i]));

  assert.equal(byTitle['Normal'].checkable, true);
  assert.equal(byTitle['Reference point'].checkable, false,
    'The PC hides its checkbox, so the phone must not offer one');
  assert.equal(byTitle['A task'].checkable, true,
    'noCheckbox is an event setting; tasks are always tickable');
}

console.log('--- 9. OCCURRENCE IDS ---');
{
  const day = buildDay({
    events: {
      once: rec({ title: 'One off' }),
      every: rec({ title: 'Weekly', recur: { freq: 'weekly', interval: 1 } }),
    },
    tasks: {},
    date: MON,
  });
  const single = day.timed.concat(day.allDay).find(i => i.title === 'One off')!;
  const repeat = day.timed.concat(day.allDay).find(i => i.title === 'Weekly')!;

  assert.equal(single.id, 'once', 'A one-off keeps its plain id');
  assert.equal(single.repeating, false);
  assert.equal(repeat.id, `every::${MON}`, 'A repeat is addressed per occurrence');
  assert.equal(repeat.masterId, 'every', 'while still pointing at its master');
  assert.equal(repeat.repeating, true);

  // The same master on another day yields a different occurrence id.
  const next = buildDay({ events: { every: rec({ title: 'Weekly', recur: { freq: 'weekly', interval: 1 } }) }, tasks: {}, date: '2026-09-07' });
  assert.equal(next.all[0].id, 'every::2026-09-07');
}

console.log('--- 10. DELETED AND MALFORMED RECORDS ARE SKIPPED ---');
{
  const day = buildDay({
    events: {
      gone: rec({ title: 'Deleted', deleted: true }),
      good: rec({ title: 'Kept' }),
      nulled: null as any,
      stringy: 'not an object' as any,
      numeric: 42 as any,
      empty: {} as any,
      noTitle: rec({ title: undefined }),
    },
    tasks: { alsoGone: rec({ title: 'Deleted task', deleted: true }) },
    date: MON,
  });
  const shown = titles(day.all);
  assert.ok(shown.includes('Kept'));
  assert.ok(!shown.includes('Deleted'));
  assert.ok(!shown.includes('Deleted task'));
  assert.ok(shown.includes('Untitled'), 'A record with no title still appears, labelled');
  assert.equal(day.all.length, 2, 'and nothing malformed slipped through');
}

console.log('--- 11. UNDATED TASKS ONLY APPEAR WHEN ASKED FOR ---');
{
  const tasks = {
    someday: { title: 'Learn guitar' },
    today: rec({ title: 'Due today' }),
  };
  const hidden = buildDay({ events: {}, tasks, date: MON });
  assert.deepEqual(titles(hidden.tasks), ['Due today'], 'By default the day shows only dated work');

  const shown = buildDay({ events: {}, tasks, date: MON, includeUndatedTasks: true });
  assert.deepEqual(titles(shown.tasks).sort(), ['Due today', 'Learn guitar']);
}

console.log('--- 12. AN EMPTY DAY IS A REAL, USABLE ANSWER ---');
{
  const day = buildDay({ events: {}, tasks: {}, date: MON });
  assert.deepEqual(day.all, []);
  assert.equal(day.counts.total, 0);
  assert.equal(summariseDay(day), 'Nothing planned');
  assert.equal(currentItem(day, 600), null);
  assert.equal(nextItem(day, 600), null);

  // Missing stores entirely must not throw — this is the very first launch.
  const nothing = buildDay({ events: undefined as any, tasks: undefined as any, date: MON });
  assert.deepEqual(nothing.all, []);
}

console.log('--- 13. NOW AND NEXT ---');
{
  const day = buildDay({
    events: {
      a: rec({ title: 'Morning', startTime: '09:00', endTime: '10:00' }),
      b: rec({ title: 'Midday', startTime: '12:00', endTime: '13:00' }),
      c: rec({ title: 'Evening', startTime: '18:00', endTime: '19:00' }),
    },
    tasks: {},
    date: MON,
  });

  assert.equal(currentItem(day, 9 * 60)!.title, 'Morning', 'At the start of an item');
  assert.equal(currentItem(day, 9 * 60 + 30)!.title, 'Morning', 'and during it');
  assert.equal(currentItem(day, 10 * 60), null, 'The moment it ends, it is no longer current');
  assert.equal(currentItem(day, 11 * 60), null, 'A gap has nothing current');

  assert.equal(nextItem(day, 8 * 60)!.title, 'Morning');
  assert.equal(nextItem(day, 10 * 60)!.title, 'Midday', 'Next skips what has passed');
  assert.equal(nextItem(day, 12 * 60)!.title, 'Midday', 'An item starting exactly now is next');
  assert.equal(nextItem(day, 23 * 60), null, 'and the end of the day has no next');

  // A completed item is not offered as "next" — you have already done it.
  const withDone = buildDay({
    events: {
      // An EVENT is ticked off per date, never with a flag.
      a: rec({ title: 'Done', startTime: '15:00', completedDates: [MON] }),
      b: rec({ title: 'Open', startTime: '16:00' }),
    },
    tasks: {},
    date: MON,
  });
  assert.equal(nextItem(withDone, 14 * 60)!.title, 'Open');

  // An item with no end time is treated as half an hour long.
  const openEnded = buildDay({ events: { a: rec({ title: 'Quick', startTime: '09:00' }) }, tasks: {}, date: MON });
  assert.equal(currentItem(openEnded, 9 * 60 + 20)!.title, 'Quick');
  assert.equal(currentItem(openEnded, 9 * 60 + 31), null);
}

console.log('--- 14. DATE ARITHMETIC AND LABELS ---');
{
  assert.equal(addDays(MON, 1), TUE);
  assert.equal(addDays(MON, -1), '2026-08-30');
  assert.equal(addDays(MON, 0), MON);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01', 'across a year boundary');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'and a leap day');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01', 'in a non-leap year');
  assert.equal(addDays(MON, 365), '2027-08-31');

  const now = new Date(2026, 7, 31, 10, 0, 0); // 31 Aug 2026, local
  assert.equal(dayLabel(MON, now), 'Today');
  assert.equal(dayLabel(TUE, now), 'Tomorrow');
  assert.equal(dayLabel('2026-08-30', now), 'Yesterday');
  assert.equal(dayLabel(WED, now), 'Wed 2 Sep', 'and anything else is dated plainly');
  assert.equal(dayLabel('2027-01-01', now), 'Fri 1 Jan');

  assert.equal(isToday(MON, now), true);
  assert.equal(isToday(TUE, now), false);
  assert.equal(ymd(now), MON);
}

console.log('--- 15. THE DAY STRIP ---');
{
  const strip = daysAround(MON, 3, 3);
  assert.equal(strip.length, 7);
  assert.equal(strip[3], MON, 'The chosen day sits in the middle');
  assert.equal(strip[0], '2026-08-28');
  assert.equal(strip[6], '2026-09-03');

  assert.deepEqual(daysAround(MON, 0, 0), [MON], 'A strip of one is legal');
  assert.deepEqual(daysAround(MON, 0, 2), [MON, TUE, WED]);
  assert.deepEqual(daysAround('2026-12-30', 0, 3), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
    'and it crosses a year boundary correctly');
}

console.log('--- 16. A FULL WEEK OF A REPEATING SCHEDULE ---');
{
  // The realistic shape: a couple of repeats, a one-off, and a task, checked
  // across seven consecutive days.
  const events = {
    standup: rec({ title: 'Standup', startTime: '09:30', recur: { freq: 'daily', interval: 1 } }),
    gym: rec({ title: 'Gym', startTime: '18:00', recur: { freq: 'weekly', interval: 1 }, exdates: ['2026-09-07'] }),
    dentist: rec({ title: 'Dentist', startTime: '14:00', weekKey: WEEK, dayIndex: 3 }),
  };
  const tasks = { essay: rec({ title: 'Essay', weekKey: WEEK, dayIndex: 5 }) };

  const week = daysAround(MON, 0, 6).map(d => ({ d, day: buildDay({ events, tasks, date: d }) }));

  assert.deepEqual(week.map(w => titles(w.day.all)), [
    ['Standup', 'Gym'],        // Mon: both repeats anchor here
    ['Standup'],               // Tue
    ['Standup', 'Dentist'],    // Wed
    ['Standup'],               // Thu
    ['Standup', 'Essay'],      // Fri
    ['Standup'],               // Sat
    ['Standup'],               // Sun: gym is excluded on 2026-09-07
  ]);

  const nextMonday = buildDay({ events, tasks, date: '2026-09-07' });
  assert.deepEqual(titles(nextMonday.all), ['Standup'],
    'The exdate removed exactly one gym session and left the series intact');
}

console.log('--- 17. EVENTS NAME THEMSELVES WITH `content`, TASKS WITH `title` ---');
{
  // The real store uses BOTH: a calendar event carries `content`, a task carries
  // `title`. Reading only one made every event on the phone say "Untitled",
  // which looked like a sync failure rather than a field-name mistake.
  assert.equal(titleOf({ content: 'Happy birthday!' }), 'Happy birthday!');
  assert.equal(titleOf({ title: 'Water the plants' }), 'Water the plants');
  assert.equal(titleOf({ content: 'Chalet', title: 'ignored' }), 'Chalet',
    'When both exist the event field wins');

  assert.equal(titleOf({}), 'Untitled');
  assert.equal(titleOf({ content: '' }), 'Untitled');
  assert.equal(titleOf({ content: '   ' }), 'Untitled', 'Whitespace is not a name');
  assert.equal(titleOf({ content: '   ', title: 'Fallback' }), 'Fallback',
    'A blank content falls through to title rather than showing nothing');
  assert.equal(titleOf({ content: 42 as any }), 'Untitled', 'A non-string is not a name');
  assert.equal(titleOf({ content: null as any, title: null as any }), 'Untitled');

  // Through the real path.
  const day = buildDay({
    events: { e1: rec({ title: undefined, content: 'IoT Project Deadline' }) },
    tasks: { t1: rec({ title: 'Garbage' }) },
    date: MON,
  });
  assert.deepEqual(titles(day.all).sort(), ['Garbage', 'IoT Project Deadline'],
    'A real-shaped event and a real-shaped task both read correctly');
}

console.log('--- 18. COLOURS ARE SWATCH NAMES, NOT HEX ---');
{
  // The store holds 'peach' / 'lilac'. Handing that to a stylesheet paints
  // nothing at all, so it has to be resolved to a real value first.
  const peach = colourOf({ color: 'peach' });
  assert.ok(peach && peach.startsWith('#'), `"peach" must resolve to a hex, got ${peach}`);
  assert.equal(peach, SWATCH_BASE_HEX['peach']);

  assert.equal(colourOf({ color: '#ff8800' }), '#ff8800', 'An explicit hex is kept as-is');
  assert.equal(colourOf({ gCalHex: '#123456' }), '#123456', 'A Google colour is used when there is no swatch');
  assert.equal(colourOf({ color: 'peach', gCalHex: '#123456' }), '#123456',
    'A Google hex beats a swatch NAME — this matches the PC exactly, and the two '
    + 'must never diverge or the same event would be a different colour on each screen');

  // Unknown or missing values fall back rather than producing an invalid style.
  assert.equal(colourOf({}), FALLBACK_EVENT_HEX);
  assert.equal(colourOf({ color: 'not-a-swatch' }), FALLBACK_EVENT_HEX);
  assert.equal(colourOf({ color: 42 as any }), FALLBACK_EVENT_HEX);

  // A category overrides the item's own colour.
  const cats = [{
    id: 'uni', name: 'University', color: '#00ff99',
    defaultDurationMin: 60, defaultNoDuration: false, defaultAllDay: false,
    defaultNoCheckbox: false, showInWidget: true, isDefault: false,
  }] as any;
  assert.equal(colourOf({ color: 'peach', categoryId: 'uni' }, cats), '#00ff99');
  assert.equal(colourOf({ color: 'peach', categoryId: 'missing' }, cats), SWATCH_BASE_HEX['peach'],
    'An unknown category falls back to the item colour rather than to nothing');

  // And it reaches the screen through buildDay.
  const day = buildDay({
    events: { e1: rec({ content: 'Chalet', color: 'peach' }) },
    tasks: {},
    date: MON,
  });
  assert.ok(day.all[0].colour?.startsWith('#'), 'Every item hands the screen a paintable colour');
}

  console.log('--- COUNTS FOR A RANGE MATCH BUILDING EVERY DAY ---');
  {
    // The month and year views count with this instead of building an agenda per
    // cell, which was a visible pause. A faster answer is only worth having if
    // it is the SAME answer, so it is checked against the slow one day by day.
    const events: Record<string, any> = {
      once: { id: 'once', content: 'One off', weekKey: '2026-08-24', dayIndex: 1,
        startTime: '09:00', endTime: '10:00' },
      weekly: { id: 'weekly', content: 'Lecture', weekKey: '2026-08-24', dayIndex: 1,
        startTime: '11:00', endTime: '12:00', recur: { freq: 'weekly', interval: 1 } },
      daily: { id: 'daily', content: 'Standup', weekKey: '2026-08-24', dayIndex: 0,
        startTime: '08:00', endTime: '08:15', recur: { freq: 'daily', interval: 1 } },
      spanning: { id: 'spanning', content: 'Trip', weekKey: '2026-08-24', dayIndex: 3,
        allDay: true, daysSpan: 3 },
      gone: { id: 'gone', content: 'Deleted', weekKey: '2026-08-24', dayIndex: 1,
        startTime: '15:00', deleted: true },
      skipping: { id: 'skipping', content: 'Skips one', weekKey: '2026-08-24', dayIndex: 2,
        startTime: '14:00', endTime: '15:00',
        recur: { freq: 'weekly', interval: 1 }, exdates: ['2026-09-02'] },
    };

    const from = '2026-08-20';
    const to = '2026-09-20';
    const counts = countsForRange(events, from, to, 1);

    let checked = 0;
    const cursor = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    while (cursor <= end) {
      const date = ymd(cursor);
      const slow = buildDay({ events, tasks: {}, date, weekStartsOn: 1 })
        .all.filter(i => i.store === 'events').length;
      assert.equal(counts[date] ?? 0, slow, `${date}: the fast count matches the slow one`);
      checked += 1;
      cursor.setDate(cursor.getDate() + 1);
    }
    assert.ok(checked > 30, 'and a whole month of days was compared');

    // The exdate is genuinely honoured rather than merely counted the same.
    assert.equal(counts['2026-09-02'] ?? 0,
      buildDay({ events, tasks: {}, date: '2026-09-02', weekStartsOn: 1 })
        .all.filter(i => i.store === 'events').length,
      'An excluded occurrence is not counted');

    // A deleted item is in neither.
    const onlyDeleted = countsForRange({ gone: events.gone }, from, to, 1);
    assert.deepEqual(onlyDeleted, {}, 'A deleted event counts nowhere');
  }

  console.log('--- COUNTS ARE BOUNDED AND SURVIVE NONSENSE ---');
  {
    assert.deepEqual(countsForRange(undefined, '2026-08-01', '2026-08-07', 1), {},
      'No events, no counts');
    assert.deepEqual(countsForRange({}, 'nonsense', '2026-08-07', 1), {},
      'An unparseable range yields nothing rather than looping');
    assert.deepEqual(countsForRange({}, '2026-08-07', '2026-08-01', 1), {},
      'and so does a backwards one');

    const junk = {
      a: null, b: 42, c: 'event',
      d: { id: 'd', content: 'No anchor' },
      e: { id: 'e', content: 'Fine', weekKey: '2026-08-24', dayIndex: 1, startTime: '09:00' },
    } as any;
    const counts = countsForRange(junk, '2026-08-24', '2026-08-31', 1);
    assert.equal(counts['2026-08-25'], 1, 'Only the sound record counted');
    assert.equal(Object.keys(counts).length, 1, 'and nothing else appeared');
  }

console.log('\nALL PASS (agenda: occurrence, ordering, edges)');
