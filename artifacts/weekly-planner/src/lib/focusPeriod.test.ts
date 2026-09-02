// Tests what "week", "month" and "year" mean once there are two honest answers
// and the screen has to pick one.
//
// The dangerous failures here are all silent. A range off by a day still draws
// a chart; a rolling window that overlaps itself still shows a total; a week
// that ignores `weekStartsOn` looks right to anyone whose week starts on Sunday
// and wrong to everyone else. None of them throw, so the only thing that
// catches them is arithmetic checked against dates worked out by hand.
//
// Run with: npx tsx src/lib/focusPeriod.test.ts

import assert from 'node:assert/strict';
import {
  ROLLING_DAYS,
  coerceFocusRangeMode,
  dayKey,
  daysInRange,
  describeFocusRange,
  explainFocusMode,
  focusPeriodRange,
  isFocusRangeMode,
  rangeLength,
  startOfWeekOn,
  type FocusPeriod,
  type FocusRangeMode,
} from './focusPeriod';

/** Local midnight, the frame every one of these ranges lives in. */
const on = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);

const PERIODS: FocusPeriod[] = ['week', 'month', 'year'];
const MODES: FocusRangeMode[] = ['calendar', 'rolling'];

function main() {
  console.log('--- 1. THE WEEK STARTS WHERE THE PLANNER SAYS IT DOES ---');
  {
    // Wednesday 2 September 2026.
    const wed = on(2026, 9, 2);
    assert.equal(wed.getDay(), 3, 'the fixture really is a Wednesday');

    assert.equal(dayKey(startOfWeekOn(wed, 0)), '2026-08-30', 'Sunday start');
    assert.equal(dayKey(startOfWeekOn(wed, 1)), '2026-08-31', 'Monday start');
    assert.equal(dayKey(startOfWeekOn(wed, 3)), '2026-09-02', 'a Wednesday start is today');
    assert.equal(dayKey(startOfWeekOn(wed, 4)), '2026-08-27', 'a Thursday start is six days back');

    // A day that IS the start of its week is its own week start, never the one
    // seven days earlier.
    for (let d = 0; d < 7; d += 1) {
      const day = on(2026, 8, 30 + d);
      assert.equal(dayKey(startOfWeekOn(day, day.getDay())), dayKey(day));
    }

    // Rubbish week starts are folded rather than believed.
    assert.equal(dayKey(startOfWeekOn(wed, 7)), dayKey(startOfWeekOn(wed, 0)));
    assert.equal(dayKey(startOfWeekOn(wed, -1)), dayKey(startOfWeekOn(wed, 6)));
  }

  console.log('--- 2. THE TWO READINGS OF "THIS WEEK" ---');
  {
    const today = on(2026, 9, 2); // Wednesday

    const cal = focusPeriodRange({ period: 'week', mode: 'calendar', today, weekStartsOn: 0 });
    assert.equal(cal.from, '2026-08-30', 'the Sunday you are standing in');
    assert.equal(cal.to, '2026-09-05', 'through the end of that week');
    assert.equal(cal.throughToday, '2026-09-02', 'but "so far" stops at today');
    assert.equal(cal.isCurrent, true);

    const roll = focusPeriodRange({ period: 'week', mode: 'rolling', today });
    assert.equal(roll.from, '2026-08-27', 'seven days, counting today as one');
    assert.equal(roll.to, '2026-09-02');
    assert.equal(roll.throughToday, '2026-09-02', 'a rolling window never runs ahead');
    assert.equal(rangeLength(roll), 7, 'and it is seven days, not eight');

    // The whole point: on a Wednesday these disagree.
    assert.notEqual(cal.from, roll.from);

    // The week start is honoured in calendar mode and irrelevant in rolling.
    const mon = focusPeriodRange({ period: 'week', mode: 'calendar', today, weekStartsOn: 1 });
    assert.equal(mon.from, '2026-08-31');
    assert.equal(mon.to, '2026-09-06');
    const rollMon = focusPeriodRange({ period: 'week', mode: 'rolling', today, weekStartsOn: 1 });
    assert.deepEqual([rollMon.from, rollMon.to], [roll.from, roll.to]);
  }

  console.log('--- 3. THE TWO READINGS OF "THIS MONTH" AND "THIS YEAR" ---');
  {
    const today = on(2026, 9, 2);

    const calM = focusPeriodRange({ period: 'month', mode: 'calendar', today });
    assert.deepEqual([calM.from, calM.to], ['2026-09-01', '2026-09-30']);
    assert.equal(calM.throughToday, '2026-09-02');

    const rollM = focusPeriodRange({ period: 'month', mode: 'rolling', today });
    assert.deepEqual([rollM.from, rollM.to], ['2026-08-04', '2026-09-02']);
    assert.equal(rangeLength(rollM), 30);

    const calY = focusPeriodRange({ period: 'year', mode: 'calendar', today });
    assert.deepEqual([calY.from, calY.to], ['2026-01-01', '2026-12-31']);
    assert.equal(rangeLength(calY), 365);

    const rollY = focusPeriodRange({ period: 'year', mode: 'rolling', today });
    assert.deepEqual([rollY.from, rollY.to], ['2025-09-03', '2026-09-02']);
    assert.equal(rangeLength(rollY), 365);
  }

  console.log('--- 4. THE MONTH IS THE MONTH IT ACTUALLY IS ---');
  {
    // Month lengths are the classic place to be a day out, and February is the
    // one that only breaks every fourth year.
    const cases: [number, number, string, number][] = [
      [2026, 1, '2026-01-31', 31],
      [2026, 2, '2026-02-28', 28],
      [2024, 2, '2024-02-29', 29],
      [2026, 4, '2026-04-30', 30],
      [2026, 12, '2026-12-31', 31],
      [2100, 2, '2100-02-28', 28],
      [2000, 2, '2000-02-29', 29],
    ];
    for (const [y, m, lastDay, length] of cases) {
      const r = focusPeriodRange({ period: 'month', mode: 'calendar', today: on(y, m, 15) });
      assert.equal(r.to, lastDay, `${y}-${m} ends on ${lastDay}`);
      assert.equal(rangeLength(r), length);
    }

    // A leap year is 366 days, and the year range says so.
    assert.equal(rangeLength(focusPeriodRange({
      period: 'year', mode: 'calendar', today: on(2024, 6, 1),
    })), 366);
  }

  console.log('--- 5. STEPPING BACK TILES THE HISTORY, IT DOES NOT OVERLAP IT ---');
  {
    const today = on(2026, 9, 2);

    // Calendar steps land on whole periods.
    assert.deepEqual(
      [-1, 0, 1].map(offset => focusPeriodRange({
        period: 'week', mode: 'calendar', today, weekStartsOn: 0, offset,
      }).from),
      ['2026-08-23', '2026-08-30', '2026-09-06'],
    );
    assert.deepEqual(
      [-2, -1, 0].map(offset => focusPeriodRange({
        period: 'month', mode: 'calendar', today, offset,
      }).from),
      ['2026-07-01', '2026-08-01', '2026-09-01'],
    );
    assert.deepEqual(
      [-1, 0].map(offset => focusPeriodRange({ period: 'year', mode: 'calendar', today, offset }).from),
      ['2025-01-01', '2026-01-01'],
    );

    // Stepping across a year boundary is ordinary, not a special case.
    assert.deepEqual(
      focusPeriodRange({ period: 'month', mode: 'calendar', today: on(2026, 1, 15), offset: -1 }),
      {
        period: 'month', mode: 'calendar',
        from: '2025-12-01', to: '2025-12-31', throughToday: '2025-12-31', isCurrent: false,
      },
    );

    // Rolling windows abut exactly: the day before one window starts is the
    // last day of the one before it. Overlapping would double count a day in a
    // history read two screens apart.
    for (const period of PERIODS) {
      for (let offset = 0; offset > -6; offset -= 1) {
        const here = focusPeriodRange({ period, mode: 'rolling', today, offset });
        const before = focusPeriodRange({ period, mode: 'rolling', today, offset: offset - 1 });
        const gap = daysInRange({ from: before.to, to: here.from });
        assert.equal(gap.length, 2, `${period} windows meet without a gap or an overlap`);
        assert.equal(rangeLength(here), ROLLING_DAYS[period]);
      }
    }

    // A period stepped away from today is not the current one, and says so.
    assert.equal(focusPeriodRange({ period: 'week', mode: 'calendar', today, offset: -1 }).isCurrent, false);
    assert.equal(focusPeriodRange({ period: 'week', mode: 'rolling', today, offset: -1 }).isCurrent, false);
    assert.equal(focusPeriodRange({ period: 'week', mode: 'rolling', today, offset: 0 }).isCurrent, true);
  }

  console.log('--- 6. EVERY RANGE IS SANE, FOR EVERY DAY OF A YEAR ---');
  {
    // Walk a whole year, in every mode, in every period, on every week start.
    // The properties are the ones the charts and totals silently depend on.
    for (let i = 0; i < 366; i += 1) {
      const today = new Date(2026, 0, 1 + i);
      for (const period of PERIODS) {
        for (const mode of MODES) {
          for (const weekStartsOn of [0, 1, 6]) {
            const r = focusPeriodRange({ period, mode, today, weekStartsOn });

            assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/);
            assert.match(r.to, /^\d{4}-\d{2}-\d{2}$/);
            assert.ok(r.from <= r.to, 'a range never runs backwards');
            assert.ok(r.throughToday <= r.to, '"so far" never passes the end');
            assert.ok(r.throughToday >= r.from, 'nor falls before the start');
            assert.equal(r.throughToday, min(r.to, dayKey(today)), '"so far" is the earlier of the two');
            assert.equal(r.isCurrent, true, 'the unstepped range always holds today');
            assert.ok(r.from <= dayKey(today) && dayKey(today) <= r.to, 'and really does contain it');

            const length = rangeLength(r);
            assert.ok(length > 0, 'a range always has days in it');
            assert.ok(length <= 366, 'and never more than a year of them');
            assert.equal(daysInRange(r).length, length, 'the day list agrees with the length');

            if (mode === 'rolling') {
              assert.equal(length, ROLLING_DAYS[period], 'a rolling window is a fixed length');
              assert.equal(r.to, dayKey(today), 'and always ends today');
            }
            if (mode === 'calendar' && period === 'week') {
              assert.equal(length, 7);
              assert.equal(new Date(`${r.from}T00:00:00`).getDay(), weekStartsOn);
            }
          }
        }
      }
    }
  }

  console.log('--- 7. THE DAY LIST IS THE RANGE, WITH NOTHING MISSING ---');
  {
    const r = focusPeriodRange({ period: 'week', mode: 'calendar', today: on(2026, 9, 2), weekStartsOn: 0 });
    assert.deepEqual(daysInRange(r), [
      '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02',
      '2026-09-03', '2026-09-04', '2026-09-05',
    ]);

    // One day is a range of one, not of none.
    assert.deepEqual(daysInRange({ from: '2026-09-02', to: '2026-09-02' }), ['2026-09-02']);
    assert.equal(rangeLength({ from: '2026-09-02', to: '2026-09-02' }), 1);

    // Backwards, or rubbish, yields nothing rather than spinning.
    assert.deepEqual(daysInRange({ from: '2026-09-05', to: '2026-09-02' }), []);
    assert.deepEqual(daysInRange({ from: 'nonsense', to: '2026-09-02' }), []);
    assert.deepEqual(daysInRange({ from: '2026-09-02', to: 'nonsense' }), []);
    assert.equal(rangeLength({ from: 'nonsense', to: 'nonsense' }), 0);

    // Across a daylight saving change the day list is still one entry per day,
    // with no day repeated and none skipped.
    for (const [y, m, d] of [[2026, 3, 26], [2026, 10, 22], [2026, 2, 26], [2026, 11, 1]]) {
      const range = focusPeriodRange({ period: 'month', mode: 'rolling', today: on(y, m, d) });
      const days = daysInRange(range);
      assert.equal(days.length, 30, `30 days ending ${y}-${m}-${d}`);
      assert.equal(new Set(days).size, 30, 'and no day appears twice');
      assert.deepEqual([...days].sort(), days, 'in order, oldest first');
    }
  }

  console.log('--- 8. THE LABEL CARRIES THE MODE ---');
  {
    const today = on(2026, 9, 2);
    const label = (period: FocusPeriod, mode: FocusRangeMode, offset = 0) =>
      describeFocusRange(focusPeriodRange({ period, mode, today, offset }));

    assert.equal(label('week', 'calendar'), 'This week');
    assert.equal(label('week', 'rolling'), 'Last 7 days');
    assert.equal(label('month', 'calendar'), 'This month');
    assert.equal(label('month', 'rolling'), 'Last 30 days');
    assert.equal(label('year', 'calendar'), 'This year');
    assert.equal(label('year', 'rolling'), 'Last 365 days');

    // A stepped range must not still claim to be "this" anything.
    assert.equal(label('week', 'calendar', -1), 'That week');
    assert.equal(label('month', 'calendar', -1), 'That month');
    assert.equal(label('year', 'rolling', -1), '7 days'.replace('7', '365'));

    assert.equal(
      describeFocusRange(focusPeriodRange({ period: 'week', mode: 'rolling', today }), true),
      'LAST 7 DAYS',
      'the phone shows it in small caps',
    );

    // Two modes never share a label, which is the entire reason it exists.
    for (const period of PERIODS) {
      assert.notEqual(label(period, 'calendar'), label(period, 'rolling'));
    }
  }

  console.log('--- 9. THE EXPLANATION SAYS WHAT WILL HAPPEN ---');
  {
    assert.equal(explainFocusMode('rolling', 'week'), 'The last 7 days, counting back from today.');
    assert.equal(explainFocusMode('rolling', 'month'), 'The last 30 days, counting back from today.');
    assert.equal(explainFocusMode('rolling', 'year'), 'The last 365 days, counting back from today.');
    assert.equal(explainFocusMode('calendar', 'week'), 'The week you are in, from its first day.');
    assert.equal(explainFocusMode('calendar', 'month'), 'The month you are in, from the 1st.');
    assert.equal(explainFocusMode('calendar', 'year'), 'The year you are in, from January.');

    // Nothing user facing here may carry a dash, which is a house rule this
    // codebase keeps breaking by accident.
    for (const period of PERIODS) {
      for (const mode of MODES) {
        const text = `${explainFocusMode(mode, period)} ${describeFocusRange(
          focusPeriodRange({ period, mode, today: on(2026, 9, 2) }),
        )}`;
        assert.ok(!text.includes('—') && !text.includes('–'), `no dashes in "${text}"`);
        assert.ok(text.length > 0);
      }
    }
  }

  console.log('--- 10. A STORED MODE IS NEVER TRUSTED BLINDLY ---');
  {
    assert.equal(isFocusRangeMode('calendar'), true);
    assert.equal(isFocusRangeMode('rolling'), true);
    for (const raw of ['Calendar', 'ROLLING', '', 'week', null, undefined, 0, 1, {}, []]) {
      assert.equal(isFocusRangeMode(raw), false, `${JSON.stringify(raw)} is not a mode`);
      assert.equal(coerceFocusRangeMode(raw), 'calendar', 'and falls back to the older reading');
    }
    assert.equal(coerceFocusRangeMode('rolling'), 'rolling');
    // Coercing twice settles, as every stored value on both machines must.
    assert.equal(coerceFocusRangeMode(coerceFocusRangeMode('nope')), 'calendar');
  }

  console.log('--- 11. NONSENSE IN NEVER PRODUCES A BROKEN CHART ---');
  {
    const today = on(2026, 9, 2);

    // An unknown mode is the calendar reading, not a crash and not an empty range.
    const odd = focusPeriodRange({
      period: 'week', mode: 'sideways' as unknown as FocusRangeMode, today, weekStartsOn: 0,
    });
    assert.equal(odd.mode, 'calendar');
    assert.equal(odd.from, '2026-08-30');

    // A broken clock still yields a usable range rather than "Invalid Date".
    const broken = focusPeriodRange({ period: 'month', mode: 'rolling', today: new Date(NaN) });
    assert.match(broken.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(rangeLength(broken), 30);

    // Fractional and absurd offsets are truncated, not obeyed literally.
    assert.deepEqual(
      focusPeriodRange({ period: 'week', mode: 'calendar', today, weekStartsOn: 0, offset: -1.9 }).from,
      focusPeriodRange({ period: 'week', mode: 'calendar', today, weekStartsOn: 0, offset: -1 }).from,
    );
    for (const offset of [NaN, Infinity, -Infinity, undefined]) {
      const r = focusPeriodRange({
        period: 'year', mode: 'calendar', today, offset: offset as number,
      });
      assert.equal(r.from, '2026-01-01', 'an unusable offset means no offset');
    }
  }

  console.log('\nALL PASS (focusPeriod: two honest readings of the same word)');
}

function min(a: string, b: string): string {
  return a <= b ? a : b;
}

main();
