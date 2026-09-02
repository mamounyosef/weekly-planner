// Tests the year view of the focus timer: twelve months, what each holds, and
// which one was the best.
//
// WHY THIS FILE IS PLAIN NODE ASSERTIONS
// It was written against `vitest`, which this workspace does not have and never
// installed, so it threw on import and had never once run. Every other suite
// here is `node:assert` under `tsx`, and the runner script invokes them that
// way; a suite in a different dialect is a suite that silently is not a suite.
//
// Run with: npx tsx src/lib/yearStats.test.ts

import assert from 'node:assert/strict';
import { summariseFocusMonths, summariseFocusYear } from './yearStats';
import type { FocusSessionRecord } from './focusStats';

const session = (
  id: string, startedAt: string, durationSeconds: number, endedAt?: string,
): FocusSessionRecord => ({ id, startedAt, durationSeconds, ...(endedAt ? { endedAt } : {}) });

function main() {
  console.log('--- 1. A YEAR ADDS UP, MONTH BY MONTH ---');
  {
    const sessions: FocusSessionRecord[] = [
      session('1', '2026-01-15T10:00:00', 3600),
      session('2', '2026-01-15T12:00:00', 3600),
      session('3', '2026-02-10T10:00:00', 1800),
      session('4', '2026-02-11T10:00:00', 7200),
    ];

    const res = summariseFocusYear(sessions, { year: 2026 });

    assert.equal(res.months.length, 12, 'a year is always twelve months, empty or not');

    assert.equal(res.months[0].seconds, 7200, 'January holds both of its hours');
    assert.equal(res.months[0].sessions, 2);
    assert.equal(res.months[0].activeDays, 1, 'two sessions on one day is ONE active day');

    assert.equal(res.months[1].seconds, 9000);
    assert.equal(res.months[1].sessions, 2);
    assert.equal(res.months[1].activeDays, 2);

    assert.equal(res.months[2].seconds, 0, 'a month with nothing in it is zero, not missing');

    assert.equal(res.yearSeconds, 16200);
    assert.equal(res.yearSessions, 4);
    assert.equal(res.yearActiveDays, 3);

    assert.equal(res.yearBestMonth?.month.getMonth(), 1, 'February was the best month');
    assert.equal(res.yearBestMonth?.seconds, 9000);
  }

  console.log('--- 2. DAYS YOU EXCUSED YOURSELF ARE LEFT OUT ---');
  {
    const sessions: FocusSessionRecord[] = [
      session('1', '2026-01-15T10:00:00', 3600),
      session('2', '2026-01-16T10:00:00', 3600),
    ];

    const res = summariseFocusYear(sessions, { year: 2026, excludedDates: ['2026-01-15'] });

    assert.equal(res.months[0].seconds, 3600);
    assert.equal(res.months[0].sessions, 1, 'the excused day takes its session with it');
    assert.equal(res.months[0].activeDays, 1);
    assert.equal(res.yearSeconds, 3600);

    // Excusing a day that has nothing on it changes nothing at all.
    const same = summariseFocusYear(sessions, { year: 2026, excludedDates: ['2026-03-03'] });
    assert.equal(same.yearSeconds, 7200);
    assert.equal(same.yearActiveDays, 2);
  }

  console.log('--- 3. AN EMPTY YEAR HAS NO BEST MONTH ---');
  {
    const res = summariseFocusYear([], { year: 2026 });
    assert.equal(res.yearSeconds, 0);
    assert.equal(res.yearSessions, 0);
    assert.equal(res.yearActiveDays, 0);
    assert.equal(res.yearBestMonth, null, 'nothing done is not a best month, it is no month');
    // The chart divides by this, so it can never be zero.
    assert.ok(res.yearMaxSeconds >= 1, 'the tallest bar is never zero');
    assert.equal(res.months.length, 12);
    for (const m of res.months) {
      assert.equal(m.seconds, 0);
      assert.equal(m.sessions, 0);
      assert.equal(m.activeDays, 0);
    }
  }

  console.log('--- 4. ONLY THIS YEAR, AND ONLY REAL SESSIONS ---');
  {
    const sessions: FocusSessionRecord[] = [
      session('last-year', '2025-12-31T10:00:00', 3600),
      session('this-year', '2026-06-01T10:00:00', 1800),
      session('next-year', '2027-01-01T10:00:00', 3600),
    ];
    const res = summariseFocusYear(sessions, { year: 2026 });
    assert.equal(res.yearSeconds, 1800, 'the years either side are not this year');
    assert.equal(res.months[5].seconds, 1800);
  }

  console.log('--- 5. RUBBISH IS DROPPED RATHER THAN COUNTED ---');
  {
    const sessions = [
      session('good', '2026-04-04T10:00:00', 600),
      { id: 'no-duration', startedAt: '2026-04-05T10:00:00' },
      { id: 'negative', startedAt: '2026-04-06T10:00:00', durationSeconds: -60 },
      { id: 'not-a-number', startedAt: '2026-04-07T10:00:00', durationSeconds: Number.NaN },
      { id: 'no-date', startedAt: 'nonsense', durationSeconds: 600 },
      null,
      undefined,
    ] as unknown as FocusSessionRecord[];

    const res = summariseFocusYear(sessions, { year: 2026 });
    assert.equal(res.yearSeconds, 600, 'one good session, and nothing else counted');
    assert.equal(res.yearSessions, 1);
    assert.equal(res.yearActiveDays, 1);
    assert.ok(Number.isFinite(res.yearSeconds), 'a NaN never reaches a total');
    assert.ok(Number.isFinite(res.yearMaxSeconds));
  }

  console.log('--- 6. A LATE NIGHT BELONGS TO THE DAY IT STARTED ---');
  {
    // Finished at half past midnight on the 2nd, with the focus day starting at
    // 4am: that hour is the 1st's, which is what the setting is for. It is also
    // the case that moves a session between MONTHS, so the year view has to
    // honour it as well as the week view does.
    const sessions: FocusSessionRecord[] = [
      session('late', '2026-03-31T23:00:00', 5400, '2026-04-01T00:30:00'),
    ];

    const rolled = summariseFocusYear(sessions, { year: 2026, dayStartHour: 4 });
    assert.equal(rolled.months[2].seconds, 5400, 'with a 4am boundary it stays in March');
    assert.equal(rolled.months[3].seconds, 0);

    const plain = summariseFocusYear(sessions, { year: 2026, dayStartHour: 0 });
    assert.equal(plain.months[3].seconds, 5400, 'at midnight it belongs to April');
    assert.equal(plain.months[2].seconds, 0);
  }

  console.log('--- 7. THE TOTALS ALWAYS AGREE WITH THE MONTHS ---');
  {
    // The year figures are read beside the twelve bars, so a disagreement is
    // visible on screen rather than merely wrong.
    const sessions: FocusSessionRecord[] = [];
    for (let m = 0; m < 12; m += 1) {
      for (let d = 1; d <= 3; d += 1) {
        const mm = String(m + 1).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        sessions.push(session(`s-${mm}-${dd}`, `2026-${mm}-${dd}T09:00:00`, 60 * (m + d)));
      }
    }
    const res = summariseFocusYear(sessions, { year: 2026 });
    assert.equal(res.yearSeconds, res.months.reduce((n, m) => n + m.seconds, 0));
    assert.equal(res.yearSessions, res.months.reduce((n, m) => n + m.sessions, 0));
    assert.equal(res.yearActiveDays, res.months.reduce((n, m) => n + m.activeDays, 0));
    assert.equal(res.yearMaxSeconds, Math.max(...res.months.map(m => m.seconds)));
    assert.equal(res.yearBestMonth?.seconds, res.yearMaxSeconds);
    assert.equal(res.yearBestMonth?.month.getMonth(), 11, 'December, being the largest');
  }

  console.log('--- 8. FEBRUARY THE 29TH IS NOT LOST IN A LEAP YEAR ---');
  {
    const res = summariseFocusYear(
      [session('leap', '2024-02-29T10:00:00', 1200)],
      { year: 2024 },
    );
    assert.equal(res.months[1].seconds, 1200, 'the extra day is walked like any other');
    assert.equal(res.months[1].activeDays, 1);
    assert.equal(res.yearSeconds, 1200);
  }

  console.log('--- 9. TWELVE MONTHS ENDING WHEREVER YOU SAY ---');
  {
    // The rolling year on the analysis screen is twelve months ending in the
    // month you are standing in, so the window routinely spans a new year. That
    // is the case a calendar-year implementation cannot express at all.
    const sessions: FocusSessionRecord[] = [
      session('dec', '2025-12-10T10:00:00', 3600),
      session('jan', '2026-01-10T10:00:00', 1800),
      session('sep', '2026-09-02T10:00:00', 600),
      session('too-old', '2025-08-31T10:00:00', 9999),
    ];

    const res = summariseFocusMonths(sessions, { end: new Date(2026, 8, 1), count: 12 });

    assert.equal(res.months.length, 12);
    assert.equal(res.months[0].month.getFullYear(), 2025);
    assert.equal(res.months[0].month.getMonth(), 9, 'the window opens in October 2025');
    assert.equal(res.months[11].month.getFullYear(), 2026);
    assert.equal(res.months[11].month.getMonth(), 8, 'and closes in September 2026');

    assert.equal(res.months[2].seconds, 3600, 'December is inside the window');
    assert.equal(res.months[3].seconds, 1800, 'so is the January after it');
    assert.equal(res.months[11].seconds, 600);
    assert.equal(res.yearSeconds, 6000, 'and the August before it is not');
    assert.equal(res.yearSessions, 3);
    assert.equal(res.yearActiveDays, 3);
    assert.equal(res.yearBestMonth?.month.getMonth(), 11, 'December was the best of them');

    // Oldest first, contiguous, no month repeated: the order the bars are drawn.
    for (let i = 1; i < res.months.length; i += 1) {
      const prev = res.months[i - 1].month;
      const here = res.months[i].month;
      assert.ok(here.getTime() > prev.getTime(), 'months run forwards');
      const expected = new Date(prev.getFullYear(), prev.getMonth() + 1, 1);
      assert.equal(here.getTime(), expected.getTime(), 'and step exactly one month');
      assert.equal(here.getDate(), 1, 'each is the first of its month');
    }
  }

  console.log('--- 10. A CALENDAR YEAR IS JUST A WINDOW ENDING IN DECEMBER ---');
  {
    // summariseFocusYear is a wrapper now. If the two ever disagree, one of the
    // two readings on the analysis screen is counting differently from the
    // other, which is exactly what the setting was added to prevent.
    const sessions: FocusSessionRecord[] = [
      session('a', '2026-02-10T10:00:00', 1800),
      session('b', '2026-02-11T23:30:00', 5400, '2026-02-12T00:30:00'),
      session('c', '2026-11-30T10:00:00', 700),
      session('d', '2025-06-06T10:00:00', 700),
    ];
    for (const opts of [
      {},
      { dayStartHour: 4 },
      { excludedDates: ['2026-02-10'] },
      { dayStartHour: 4, excludedDates: ['2026-02-11', '2026-11-30'] },
    ]) {
      assert.deepEqual(
        summariseFocusYear(sessions, { year: 2026, ...opts }),
        summariseFocusMonths(sessions, { end: new Date(2026, 11, 1), count: 12, ...opts }),
        `the two agree with ${JSON.stringify(opts)}`,
      );
    }
  }

  console.log('--- 11. A WINDOW OF NO MONTHS IS NOT ALLOWED ---');
  {
    // The chart divides by yearMaxSeconds and maps over months. A count of zero
    // would render as "you have never focused", which is a lie, not an empty
    // state, so the count is clamped rather than trusted.
    const sessions: FocusSessionRecord[] = [session('x', '2026-09-02T10:00:00', 600)];
    for (const count of [0, -5, 0.4, NaN, undefined]) {
      const res = summariseFocusMonths(sessions, {
        end: new Date(2026, 8, 1), count: count as number,
      });
      assert.ok(res.months.length >= 1, `count ${count} still draws something`);
      assert.ok(res.yearMaxSeconds >= 1, 'the tallest bar is never zero');
      assert.ok(Number.isFinite(res.yearSeconds));
    }

    // A single month is a legitimate window.
    const one = summariseFocusMonths(sessions, { end: new Date(2026, 8, 1), count: 1 });
    assert.equal(one.months.length, 1);
    assert.equal(one.yearSeconds, 600);

    // An absurd count is capped rather than building ten thousand months.
    const many = summariseFocusMonths(sessions, { end: new Date(2026, 8, 1), count: 100000 });
    assert.ok(many.months.length <= 120, 'the window is capped');

    // A broken clock still produces twelve real months.
    const broken = summariseFocusMonths(sessions, { end: new Date(NaN), count: 12 });
    assert.equal(broken.months.length, 12);
    for (const m of broken.months) assert.ok(!Number.isNaN(m.month.getTime()));
  }

  console.log('\nALL PASS (yearStats: twelve months, rolling or calendar, and the best of them)');
}

main();
