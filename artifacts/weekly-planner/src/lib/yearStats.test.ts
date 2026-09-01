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
import { summariseFocusYear } from './yearStats';
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

  console.log('\nALL PASS (yearStats: twelve months, excused days, the best of them)');
}

main();
