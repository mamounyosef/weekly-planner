// Tests the focus arithmetic the phone and the PC must agree on.
//
// Two of these matter more than the rest:
//
//   THE DAY BOUNDARY. A focus day starts at an hour the user chooses, so work
//   finished at half past one belongs to the day before. Get it wrong and the
//   phone reports a different yesterday from the PC, which makes the whole
//   screen untrustworthy for the exact person who works late — the only kind of
//   person who sets the option.
//
//   EMPTY DAYS ARE DAYS. A chart that omits them reads as unbroken work.
//
// Run with: npx tsx src/lib/focusStats.test.ts

import assert from 'node:assert/strict';
import {
  dateRange,
  describeDuration,
  focusDayKey,
  isCountable,
  summariseFocus,
  MIN_COMPLETED_SESSION_SECONDS,
  type FocusSessionRecord,
} from './focusStats';

/** A session that ended at a given local wall-clock time. */
const at = (iso: string, minutes: number, id = iso): FocusSessionRecord => ({
  id,
  startedAt: new Date(new Date(iso).getTime() - minutes * 60_000).toISOString(),
  endedAt: new Date(iso).toISOString(),
  durationSeconds: minutes * 60,
});

/** Local time, written the way a person would say it. */
const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).toISOString();

function main() {
  console.log('--- 1. THE FOCUS DAY STARTS WHEN THE USER SAYS ---');
  {
    // 01:30 on the 15th, with a day that starts at 03:00, is the 14th's work.
    assert.equal(focusDayKey(local(2026, 8, 15, 1, 30), 3), '2026-08-14',
      'Before the cutoff belongs to the day before');
    assert.equal(focusDayKey(local(2026, 8, 15, 3, 0), 3), '2026-08-15',
      'The cutoff hour itself starts the new day');
    assert.equal(focusDayKey(local(2026, 8, 15, 23, 59), 3), '2026-08-15',
      'and late evening is still that day');

    assert.equal(focusDayKey(local(2026, 8, 15, 1, 30), 0), '2026-08-15',
      'A start hour of zero is plain calendar bucketing');

    // Rolling backwards over a month and a year boundary.
    assert.equal(focusDayKey(local(2026, 9, 1, 2, 0), 4), '2026-08-31', 'across a month');
    assert.equal(focusDayKey(local(2026, 1, 1, 2, 0), 4), '2025-12-31', 'and across a year');

    assert.equal(focusDayKey('not a date', 3), '', 'Nonsense yields nothing, not a crash');
  }

  console.log('--- 2. TOO SHORT TO COUNT ---');
  {
    assert.equal(isCountable(at(local(2026, 8, 15, 10), 1)), true, 'A minute counts');
    assert.equal(
      isCountable({ id: 'x', startedAt: '', durationSeconds: MIN_COMPLETED_SESSION_SECONDS - 1 }),
      false, 'Just under does not');
    assert.equal(isCountable({ id: 'x', startedAt: '', durationSeconds: 0 }), false, 'Nor zero');
    assert.equal(isCountable({ id: 'x', startedAt: '', durationSeconds: NaN as any }), false,
      'Nor nonsense');
    assert.equal(isCountable(undefined as any), false, 'Nor a missing record');
  }

  console.log('--- 3. A WEEK TOTALS THE WAY A PERSON WOULD ---');
  {
    const sessions = [
      at(local(2026, 8, 10, 9), 60, 'a'),
      at(local(2026, 8, 10, 14), 30, 'b'),
      at(local(2026, 8, 12, 11), 90, 'c'),
      // Outside the range, and must not be counted.
      at(local(2026, 8, 20, 11), 120, 'far'),
    ];
    const s = summariseFocus(sessions, { from: '2026-08-10', to: '2026-08-16' });

    assert.equal(s.days.length, 7, 'Seven days, including the empty ones');
    assert.equal(s.totalSeconds, (60 + 30 + 90) * 60, 'Totalled');
    assert.equal(s.sessions, 3, 'and counted');
    assert.equal(s.days[0].seconds, 90 * 60, 'Monday holds both of its sessions');
    assert.equal(s.days[1].seconds, 0, 'and the empty day is present, at zero');

    // The average is over days WORKED, not over the range.
    assert.equal(s.averageSeconds, Math.round((180 * 60) / 2), 'Averaged over days worked');
    assert.equal(s.bestDay?.date, '2026-08-10', 'and the best day found');
    assert.equal(s.bestDay?.seconds, 90 * 60);
  }

  console.log('--- 4. NOTHING AT ALL IS NOT AN ERROR ---');
  {
    const s = summariseFocus([], { from: '2026-08-10', to: '2026-08-16' });
    assert.equal(s.totalSeconds, 0);
    assert.equal(s.sessions, 0);
    assert.equal(s.averageSeconds, 0, 'and no division by zero');
    assert.equal(s.bestDay, null, 'No best day when there was no work');
    assert.equal(s.streak, 0);
    assert.equal(s.days.length, 7, 'but the days are still drawn');
  }

  console.log('--- 5. THE STREAK COUNTS BACK FROM THE END ---');
  {
    const days = (dates: string[]) => dates.map((d, i) => at(`${d}T10:00:00`, 60, `s${i}`));

    const unbroken = summariseFocus(
      days(['2026-08-14', '2026-08-15', '2026-08-16']),
      { from: '2026-08-10', to: '2026-08-16' },
    );
    assert.equal(unbroken.streak, 3, 'Three days up to the end');

    const brokenYesterday = summariseFocus(
      days(['2026-08-14', '2026-08-15']),
      { from: '2026-08-10', to: '2026-08-16' },
    );
    assert.equal(brokenYesterday.streak, 0, 'A gap at the end ends the streak');

    const allSeven = summariseFocus(
      days(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
        '2026-08-14', '2026-08-15', '2026-08-16']),
      { from: '2026-08-10', to: '2026-08-16' },
    );
    assert.equal(allSeven.streak, 7, 'and a full range counts every day');
  }

  console.log('--- 6. A SESSION IS CREDITED TO THE DAY IT FINISHED ---');
  {
    // Started at 23:30 on the 14th, ran ninety minutes into the 15th. With a
    // midnight day, that is the 15th's work.
    const overnight: FocusSessionRecord = {
      id: 'night',
      startedAt: local(2026, 8, 14, 23, 30),
      endedAt: local(2026, 8, 15, 1, 0),
      durationSeconds: 90 * 60,
    };
    const plain = summariseFocus([overnight], { from: '2026-08-14', to: '2026-08-15' });
    assert.equal(plain.days[1].seconds, 90 * 60, 'Credited to the day it ended');
    assert.equal(plain.days[0].seconds, 0, 'not the day it began');

    // With a 3am day start it belongs to the 14th, where the person would put it.
    const late = summariseFocus([overnight], {
      from: '2026-08-14', to: '2026-08-15', dayStartHour: 3,
    });
    assert.equal(late.days[0].seconds, 90 * 60, 'and the late-night rule moves it back');
    assert.equal(late.days[1].seconds, 0);
  }

  console.log('--- 7. RANGES ---');
  {
    assert.deepEqual(dateRange('2026-08-14', '2026-08-16'),
      ['2026-08-14', '2026-08-15', '2026-08-16']);
    assert.deepEqual(dateRange('2026-08-14', '2026-08-14'), ['2026-08-14'], 'One day is a range');
    assert.deepEqual(dateRange('2026-08-16', '2026-08-14'), [], 'Backwards yields nothing');
    assert.deepEqual(dateRange('nonsense', '2026-08-14'), [], 'and so does nonsense');
    assert.equal(dateRange('2026-01-01', '2026-12-31').length, 365, 'A year is a year');
    // A range nobody meant must not hang the screen building it.
    assert.ok(dateRange('1900-01-01', '2100-01-01').length <= 3660, 'and an absurd range is bounded');
  }

  console.log('--- 8. DURATIONS READ LIKE ENGLISH ---');
  {
    assert.equal(describeDuration(0), '—');
    assert.equal(describeDuration(-5), '—', 'and nonsense does not print a negative');
    assert.equal(describeDuration(45 * 60), '45m');
    assert.equal(describeDuration(60 * 60), '1h', 'A round hour drops the minutes');
    assert.equal(describeDuration(135 * 60), '2h 15m');
    assert.equal(describeDuration(30), '1m', 'Half a minute rounds up rather than vanishing');
  }

  console.log('--- 9. A HOSTILE HISTORY DOES NOT BREAK THE SCREEN ---');
  {
    const junk = [
      null, undefined, 42, 'session',
      { id: 'no-duration', startedAt: local(2026, 8, 15, 10) },
      { id: 'bad-date', startedAt: 'nope', endedAt: 'nope', durationSeconds: 3600 },
      { id: 'negative', startedAt: local(2026, 8, 15, 10), durationSeconds: -3600 },
      at(local(2026, 8, 15, 10), 60, 'good'),
    ] as any[];

    const s = summariseFocus(junk, { from: '2026-08-14', to: '2026-08-16' });
    assert.equal(s.sessions, 1, 'Only the sound one counted');
    assert.equal(s.totalSeconds, 3600);
  }

  console.log('\nALL PASS (focus stats: day boundary, totals, streaks, hostile data)');
}

main();
