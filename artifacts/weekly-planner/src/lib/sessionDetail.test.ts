// Tests the arithmetic of the sessions-detail page (Focus → "N sessions" →
// every individual session of a day or week).
//
// The recurring theme is HONESTY ABOUT TIME:
//
//   a manual day-total edit carries a synthetic 4 AM anchor, and nothing may
//   ever present it as a moment anybody actually worked;
//   gaps are measured only between real sessions, so the fake anchor can never
//   manufacture a "5h 50m break" chip;
//   the day a session belongs to is its focus day, on the same configurable
//   day-start hour every other screen uses;
//   the day map places moments by local wall clock and handles sessions that
//   wrap past the day-start hour.
//
// Run with: npx tsx src/lib/sessionDetail.test.ts

import assert from 'node:assert/strict';
import {
  buildSessionDetail,
  dayMapPercent,
  dayMapSpanPercent,
  isManualFocusSession,
} from './sessionDetail';
import { createManualFocusSession, type FocusSession } from './focusSessions';

/** A real timed session starting at a local wall-clock moment. */
function sess(
  y: number, mo: number, d: number, h: number, min: number,
  minutes: number,
  opts: { id?: string; planned?: number } = {},
): FocusSession {
  const start = new Date(y, mo - 1, d, h, min, 0, 0);
  return {
    id: opts.id ?? `s-${start.toISOString()}-${minutes}`,
    startedAt: start.toISOString(),
    endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    durationSeconds: Math.round(minutes * 60),
    plannedSeconds: opts.planned ?? Math.round(minutes * 60),
  };
}

/** 2026-08-17 is a Monday; 17–23 makes a clean Mon–Sun week. */
const D = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const WEEK = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23'];

function approx(actual: number, expected: number, label: string, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `${label}: expected ~${expected}, got ${actual}`);
}

function main() {
  console.log('--- 1. MANUAL ENTRIES ARE MARKED, AND NEVER CLAIM A CLOCK ---');
  {
    const manual = createManualFocusSession('2026-08-17', 10 * 60, 4);
    assert.ok(isManualFocusSession(manual), 'a typed day total is a manual session');
    assert.ok(!isManualFocusSession(sess(2026, 8, 17, 10, 0, 30)), 'a timed session is not');

    const r = buildSessionDetail([manual], ['2026-08-17'], 4);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].isManual, true);
    assert.equal(r.matches[0].actual, 600);
    // The storage anchor (04:00, the day-start hour) is the storage anchor —
    // the match must SAY it crosses no honest boundary but flag the badges:
    // with dayStart 4 the anchor is inside the day, so no badges fire.
    assert.equal(r.matches[0].startsOtherDay, false);
    assert.equal(r.matches[0].endsOtherDay, false);
    // First/last are about when work happened; a manual row knows no such thing.
    assert.equal(r.firstStartMs, null, 'manual-only day has no first start');
    assert.equal(r.lastEndMs, null, 'manual-only day has no last end');
    // But its duration is real and counts toward the day total.
    assert.equal(r.totalSeconds, 600);
    assert.equal(r.manualSeconds, 600);
    assert.equal(r.realSeconds, 0);
    assert.equal(r.manualCount, 1);
    // Its "planned" is just its own total — excluded from the plan totals.
    assert.equal(r.totalPlannedSeconds, 0);
  }

  console.log('--- 2. MANUAL ANCHOR NEVER SHADOWS REAL SESSIONS ---');
  {
    const manual = createManualFocusSession('2026-08-17', 10 * 60, 4); // anchored 04:00
    const real = sess(2026, 8, 17, 10, 0, 30);                        // 10:00–10:30
    const r = buildSessionDetail([real, manual], ['2026-08-17'], 4);
    assert.equal(r.matches.length, 2);
    // Sorted by start: the 4 AM anchor lands first even though nobody worked then.
    assert.equal(r.matches[0].isManual, true);
    assert.equal(r.matches[1].isManual, false);
    // First start / last end come from the REAL session only.
    assert.equal(r.firstStartMs, Date.parse(real.startedAt));
    assert.equal(r.lastEndMs, Date.parse(real.endedAt));
    // The gap chain skips the manual row entirely — the real session has no
    // prior real session, so null, never "5h 50m break before".
    assert.equal(r.matches[1].gapBeforeSeconds, null);
    assert.equal(r.matches[0].gapBeforeSeconds, null, 'manual rows never carry a gap');
    // Totals split honestly.
    assert.equal(r.totalSeconds, 600 + 1800);
    assert.equal(r.realSeconds, 1800);
    assert.equal(r.manualSeconds, 600);
    assert.equal(r.totalPlannedSeconds, 1800, 'plan totals ignore the manual row');
  }

  console.log('--- 3. THE FOCUS-DAY BOUNDARY (DAY-START HOUR) ---');
  {
    // Ends 02:00 on the 18th with a 4 AM day start → belongs to the 17th.
    const nightOwl = sess(2026, 8, 18, 0, 30, 90); // 00:30 → 02:00 on the 18th
    const on17 = buildSessionDetail([nightOwl], ['2026-08-17'], 4);
    assert.equal(on17.matches.length, 1, 'a 2 AM finish belongs to the previous focus day');
    assert.equal(on17.matches[0].startsOtherDay, true, 'it started on a different calendar day');
    assert.equal(on17.matches[0].endsOtherDay, true);
    assert.equal(on17.matches[0].crossesMidnight, false, '00:30→02:00 does not itself cross midnight');

    // One that genuinely crosses midnight: 23:00 → 01:00.
    const straddle = sess(2026, 8, 18, 23, 0, 120);
    const straddleR = buildSessionDetail([straddle], ['2026-08-18'], 4);
    assert.equal(straddleR.matches.length, 1, 'ends 01:00 on the 19th, before a 4 AM start → the 18th');
    assert.equal(straddleR.matches[0].crossesMidnight, true);
    assert.equal(straddleR.matches[0].startsOtherDay, false);
    assert.equal(straddleR.matches[0].endsOtherDay, true, 'it ended on the 19th, a different calendar day');

    const on18 = buildSessionDetail([nightOwl], ['2026-08-18'], 4);
    assert.equal(on18.matches.length, 0, 'the same session does NOT appear on the 18th');

    // With a midnight day start the same session belongs to the 18th.
    const on18midnight = buildSessionDetail([nightOwl], ['2026-08-18'], 0);
    assert.equal(on18midnight.matches.length, 1);

    // Ends exactly at the day-start hour → already the NEW day (only times
    // strictly before the cutoff roll back, matching every other screen).
    const tillFour = sess(2026, 8, 18, 2, 0, 120); // 02:00 → 04:00 on the 18th
    assert.equal(buildSessionDetail([tillFour], ['2026-08-18'], 4).matches.length, 1,
      'ending exactly at the day-start hour belongs to the new focus day');
    assert.equal(buildSessionDetail([tillFour], ['2026-08-17'], 4).matches.length, 0);

    // Week mode uses the same bucketing: 03:00 Wednesday finish, 4 AM start → Tuesday.
    const lateWed = sess(2026, 8, 19, 1, 0, 120); // Wed 01:00 → 03:00
    const wk = buildSessionDetail([lateWed], WEEK, 4);
    assert.equal(wk.groups.length, 1);
    assert.equal(wk.groups[0].key, '2026-08-18', 'a 3 AM Wednesday finish groups under Tuesday');
  }

  console.log('--- 4. SORTING, TIES, AND CORRUPT ROWS ---');
  {
    const a = sess(2026, 8, 17, 9, 0, 30);
    const b = sess(2026, 8, 17, 8, 0, 30);
    const c = sess(2026, 8, 17, 10, 0, 30);
    const r = buildSessionDetail([c, a, b], ['2026-08-17']);
    assert.deepEqual(
      r.matches.map(m => m.startMs),
      [Date.parse(b.startedAt), Date.parse(a.startedAt), Date.parse(c.startedAt)],
      'arrives unsorted, leaves sorted by start',
    );
    assert.deepEqual(r.matches.map(m => m.index), [0, 1, 2], 'index is the overall position');

    // Same start: shorter session first; identical everything: id decides.
    const long1 = sess(2026, 8, 17, 9, 0, 60, { id: 'a' });
    const long2 = sess(2026, 8, 17, 9, 0, 60, { id: 'b' });
    const short = sess(2026, 8, 17, 9, 0, 30, { id: 'c' });
    const tied = buildSessionDetail([long2, long1, short], ['2026-08-17']);
    assert.deepEqual(tied.matches.map(m => m.session.id), ['c', 'a', 'b'],
      'tie on start breaks by end time, then id — deterministic whatever the input order');

    // Corrupt rows are dropped, not rendered as 0-minute sessions.
    const zero = { ...sess(2026, 8, 17, 9, 0, 30), durationSeconds: 0 };
    const nan = { ...sess(2026, 8, 17, 9, 0, 30), durationSeconds: Number.NaN };
    const badStart = { ...sess(2026, 8, 17, 9, 0, 30), startedAt: 'not-a-date' };
    const badEnd = { ...sess(2026, 8, 17, 9, 0, 30), endedAt: 'not-a-date' };
    const r2 = buildSessionDetail([zero, nan, badStart, badEnd], ['2026-08-17']);
    assert.equal(r2.matches.length, 0, 'zero, NaN and undateable rows are all dropped');
  }

  console.log('--- 5. GAPS BETWEEN REAL SESSIONS ---');
  {
    const first = sess(2026, 8, 17, 9, 0, 60);        // 09:00–10:00
    const backToBack = sess(2026, 8, 17, 10, 0, 30);  // 10:00–10:30
    const afterLunch = sess(2026, 8, 17, 13, 0, 30);  // 13:00–13:30
    const r = buildSessionDetail([first, backToBack, afterLunch], ['2026-08-17']);
    assert.equal(r.matches[0].gapBeforeSeconds, null, 'the first real session has no gap');
    assert.equal(r.matches[1].gapBeforeSeconds, 0, 'back-to-back is 0, not null');
    assert.equal(r.matches[2].gapBeforeSeconds, 2.5 * 3600, 'gap measured from the previous real end');

    // Overlap (bad data): clamped to 0, never negative.
    const overlapping = sess(2026, 8, 17, 9, 45, 30); // starts before `first` ends
    const r2 = buildSessionDetail([first, overlapping], ['2026-08-17']);
    assert.equal(r2.matches[1].gapBeforeSeconds, 0, 'an overlapping start clamps to 0');

    // A manual row between two real ones does not reset or fake the chain.
    const morning = sess(2026, 8, 17, 9, 0, 60);      // 09:00–10:00
    const manual = createManualFocusSession('2026-08-17', 600, 4);
    const evening = sess(2026, 8, 17, 18, 0, 30);     // 18:00–18:30
    const r3 = buildSessionDetail([morning, manual, evening], ['2026-08-17'], 4);
    assert.equal(r3.matches[2].gapBeforeSeconds, 8 * 3600,
      'the evening gap is measured from the morning real end, skipping the manual row');
  }

  console.log('--- 6. THE 20-MINUTE COMPLETENESS BAR ---');
  {
    const short = sess(2026, 8, 17, 9, 0, 19.99); // 19m59s
    const exact = sess(2026, 8, 17, 10, 0, 20);   // exactly 20m
    const r = buildSessionDetail([short, exact], ['2026-08-17']);
    assert.equal(r.matches[0].countsAsComplete, false, '19m59s does not count as a completed session');
    assert.equal(r.matches[1].countsAsComplete, true, 'exactly 20m does');
    // A short MANUAL entry is also below the bar the analysis counts use.
    const manual = createManualFocusSession('2026-08-17', 10 * 60, 0);
    const r2 = buildSessionDetail([manual], ['2026-08-17'], 0);
    assert.equal(r2.matches[0].countsAsComplete, false);
  }

  console.log('--- 7. TOTALS, AVERAGES, EMPTY DAYS ---');
  {
    const a = sess(2026, 8, 17, 9, 0, 30);
    const b = sess(2026, 8, 17, 11, 0, 45);
    const r = buildSessionDetail([b, a], ['2026-08-17']);
    assert.equal(r.totalSeconds, 4500);
    assert.equal(r.longestSeconds, 2700);
    assert.equal(r.avgSeconds, 2250);
    assert.equal(r.firstStartMs, Date.parse(a.startedAt));
    assert.equal(r.lastEndMs, Date.parse(b.endedAt));

    const empty = buildSessionDetail([], ['2026-08-17']);
    assert.equal(empty.matches.length, 0);
    assert.equal(empty.totalSeconds, 0);
    assert.equal(empty.avgSeconds, 0, 'no divide-by-zero on an empty day');
    assert.equal(empty.longestSeconds, 0);
    assert.equal(empty.firstStartMs, null);
    assert.equal(empty.lastEndMs, null);
    assert.deepEqual(empty.groups, [], 'single-day mode never produces groups');

    // Sessions of other days are not counted.
    const otherDay = sess(2026, 8, 18, 9, 0, 30);
    assert.equal(buildSessionDetail([otherDay], ['2026-08-17']).matches.length, 0);
  }

  console.log('--- 8. WEEK MODE: GROUPS FOLLOW DAYS, EMPTY DAYS VANISH ---');
  {
    const mon = sess(2026, 8, 17, 9, 0, 30);
    const wed1 = sess(2026, 8, 19, 9, 0, 30);
    const wed2 = sess(2026, 8, 19, 14, 0, 60);
    const sat = sess(2026, 8, 22, 11, 0, 45);
    const r = buildSessionDetail([sat, wed2, mon, wed1], WEEK);
    assert.equal(r.matches.length, 4);
    assert.deepEqual(r.groups.map(g => g.key), ['2026-08-17', '2026-08-19', '2026-08-22'],
      'only days with sessions appear, in calendar order');
    assert.deepEqual(r.groups.map(g => g.matches.length), [1, 2, 1]);
    assert.deepEqual(r.groups.map(g => g.seconds), [1800, 5400, 2700]);
    assert.equal(r.totalSeconds, 1800 + 5400 + 2700);
    // Numbering is continuous across groups.
    assert.deepEqual(r.matches.map(m => m.index), [0, 1, 2, 3]);

    // A session ending just past midnight Sunday → Monday belongs to Monday,
    // which is OUTSIDE a Mon–Sun week, so it must not leak in.
    const straddler = sess(2026, 8, 23, 23, 50, 20); // Sun 23:50 → Mon 00:10
    const r2 = buildSessionDetail([straddler], WEEK);
    assert.equal(r2.matches.length, 0, 'a Monday-00:10 finish is next week, not this one');

    // And the same straddler IS next Monday's first session.
    const nextWeek = ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30'];
    assert.equal(buildSessionDetail([straddler], nextWeek).matches.length, 1);
  }

  console.log('--- 9. DAY MAP POSITION (WALL CLOCK, WRAPPING) ---');
  {
    const at = (h: number, min = 0) => new Date(2026, 7, 17, h, min, 0, 0).getTime();
    approx(dayMapPercent(at(4), 4), 0, 'the day-start hour is the left edge');
    approx(dayMapPercent(at(12), 4), ((720 - 240) / 1440) * 100, 'noon on a 4 AM day');
    approx(dayMapPercent(at(3), 4), ((180 - 240 + 1440) / 1440) * 100, '3 AM on a 4 AM day wraps to the right edge');
    approx(dayMapPercent(at(0), 4), ((0 - 240 + 1440) / 1440) * 100, 'midnight wraps too');
    approx(dayMapPercent(at(16), 0), (960 / 1440) * 100, 'a midnight day start is plain clock position');
    approx(dayMapPercent(at(4, 30), 4), (30 / 1440) * 100, 'half past the day start');
    // 3:59 with seconds — just before the wrap point.
    const almost = new Date(2026, 7, 17, 3, 59, 30).getTime();
    approx(dayMapPercent(almost, 4), (((239.5 - 240 + 1440) % 1440 + 1440) % 1440) / 1440 * 100,
      '3:59:30 is a hair under 100%');
  }

  console.log('--- 10. DAY MAP SPAN (WIDTHS, WRAPS, EXTREMES) ---');
  {
    const at = (h: number, min = 0) => new Date(2026, 7, 17, h, min, 0, 0).getTime();
    // A plain 10-minute block on a 4 AM day.
    approx(dayMapSpanPercent(at(10), at(10, 10), 4), (10 / 1440) * 100, 'ten minutes is ten minutes wide');
    // The wrap case: 23:00 → 01:00 on a 4 AM day is one 2h block at the right edge.
    const lateNight = sess(2026, 8, 17, 23, 0, 120);
    approx(dayMapSpanPercent(Date.parse(lateNight.startedAt), Date.parse(lateNight.endedAt), 4),
      (120 / 1440) * 100, '23:00→01:00 spans 2h, not a wrap-around band');
    approx(dayMapPercent(Date.parse(lateNight.startedAt), 4), ((1380 - 240) / 1440) * 100,
      '...and it starts at 79.17% (the 11 PM point)');
    // A full day.
    approx(dayMapSpanPercent(at(4), at(4) + 24 * 3600_000, 4), 100, 'a 24h session is the whole strip');
    // A manual day total can be up to 23h59m — one minute shy of the strip.
    const nearFull = createManualFocusSession('2026-08-17', (24 * 60 - 1) * 60, 4);
    approx(dayMapSpanPercent(Date.parse(nearFull.startedAt), Date.parse(nearFull.endedAt), 4),
      (1439 / 1440) * 100, 'a 23h59m manual total is everything but the last minute');
    // Ending exactly at the next day-start: width is the distance to the right edge.
    const tillEnd = sess(2026, 8, 17, 22, 0, 120); // 22:00 → 00:00 (= next 4 AM boundary? no: midnight)
    // 22:00 → 24:00 on a 4 AM strip: start 75%, end = midnight → (0-240+1440)/1440 = 83.33% → width 8.33%.
    approx(dayMapSpanPercent(Date.parse(tillEnd.startedAt), Date.parse(tillEnd.endedAt), 4),
      (120 / 1440) * 100, '22:00→24:00 is 8.33% wide');
    // Degenerate inputs.
    assert.equal(dayMapSpanPercent(at(10), at(10), 4), 0, 'zero-length span is 0');
    assert.equal(dayMapSpanPercent(at(10), at(9), 4), 0, 'a negative span is 0, not a giant bar');
  }

  console.log('--- 11. MIXED WEEK: MANUAL + REAL TOGETHER ---');
  {
    const manualTue = createManualFocusSession('2026-08-18', 45 * 60, 4);
    const realWed = sess(2026, 8, 19, 10, 0, 30);
    const shortFri = sess(2026, 8, 21, 15, 0, 5);
    const r = buildSessionDetail([shortFri, realWed, manualTue], WEEK, 4);
    assert.equal(r.matches.length, 3);
    assert.deepEqual(r.groups.map(g => g.key), ['2026-08-18', '2026-08-19', '2026-08-21']);
    assert.equal(r.groups[0].seconds, 2700, 'the Tuesday group is the manual total');
    assert.equal(r.totalSeconds, 2700 + 1800 + 300);
    assert.equal(r.realSeconds, 2100);
    assert.equal(r.manualSeconds, 2700);
    assert.equal(r.manualCount, 1);
    assert.equal(r.firstStartMs, Date.parse(realWed.startedAt), 'first start is the first REAL session');
    assert.equal(r.lastEndMs, Date.parse(shortFri.endedAt));
    assert.equal(r.avgSeconds, Math.round(4800 / 3));
    assert.equal(r.totalPlannedSeconds, 1800 + 300, 'plan totals from real sessions only');
    // Week mode never raises the other-day badges (there is no single viewed day).
    assert.equal(r.matches[0].startsOtherDay, false);
    assert.equal(r.matches[0].endsOtherDay, false);
  }

  console.log('--- 12. MULTIPLE MANUAL ENTRIES ON ONE DAY ---');
  {
    const m1 = createManualFocusSession('2026-08-17', 3600, 4);
    const m2 = createManualFocusSession('2026-08-17', 1800, 4);
    const r = buildSessionDetail([m1, m2], ['2026-08-17'], 4);
    assert.equal(r.matches.length, 2);
    assert.equal(r.manualCount, 2);
    assert.equal(r.manualSeconds, 5400);
    assert.equal(r.totalSeconds, 5400);
    assert.equal(r.firstStartMs, null);
    assert.equal(r.lastEndMs, null);
    // Both manual rows carry a null gap no matter their sort order.
    assert.equal(r.matches[0].gapBeforeSeconds, null);
    assert.equal(r.matches[1].gapBeforeSeconds, null);
  }

  console.log('--- 13. PLANNED VS ACTUAL ---');
  {
    const met = sess(2026, 8, 17, 9, 0, 60, { planned: 3600 });
    const partial = sess(2026, 8, 17, 11, 0, 30, { planned: 3600 });
    const over = sess(2026, 8, 17, 14, 0, 75, { planned: 3600 });
    const r = buildSessionDetail([met, partial, over], ['2026-08-17']);
    assert.deepEqual(r.matches.map(m => m.planned), [3600, 3600, 3600]);
    assert.equal(r.totalPlannedSeconds, 3 * 3600);
    // A missing/zero planned field must not poison anything.
    const unplanned = { ...sess(2026, 8, 17, 16, 0, 30), plannedSeconds: 0 };
    const r2 = buildSessionDetail([unplanned], ['2026-08-17']);
    assert.equal(r2.matches[0].planned, 0);
    assert.equal(r2.totalPlannedSeconds, 0);
  }

  console.log('All sessionDetail tests passed.');
}

main();
