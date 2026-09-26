// Editing a day's focus TOTAL must never touch its sessions.
//
// THE BUG: a day of eight sessions, total nudged up by 20 minutes, came back as
// "1 session". The edit deleted the day's sessions and wrote one typed row in
// their place. Now the typed value is an `adjust-` override: the total is what
// was typed, the sessions (their number and each one's length) are untouched.
//
// Run: npx tsx src/lib/focusDayAdjust.test.ts

import assert from 'node:assert/strict';
import {
  applyTypedDayTotals, createDayAdjustment, dedupeFocusHistory, isDayAdjustment,
  isTypedDayTotal, mergeContiguousFocusSession, summariseFocus, computeAllTimeStreaks,
  tallyFocusDays, type FocusSessionRecord,
} from './focusStats';
import { summariseFocusMonths } from './yearStats';
import { adjustDayTotal, computeGoalStats } from './focusGoals';
import { buildSessionDetail } from './sessionDetail';
import {
  countCompletedSessionsForDay, isCompletedFocusSession, safeFocusSessions, sessionCredit,
  sumFocusSecondsForDay, type FocusSession, type FocusTimerState,
} from './focusSessions';

const MIN = 60_000;
const DAY = '2026-09-10';
const at = (h: number, m = 0) => new Date(2026, 8, 10, h, m, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

/** A real session: `mins` minutes starting at h:m on DAY. */
function sess(i: number, h: number, m: number, mins: number, extra: Partial<FocusSession> = {}): FocusSession {
  const start = at(h, m);
  return {
    id: `session-${iso(start)}`,
    startedAt: iso(start),
    endedAt: iso(start + mins * MIN),
    durationSeconds: mins * 60,
    plannedSeconds: mins * 60,
    ...extra,
  };
}

/** Eight 30-minute sessions, 09:00 to 16:30: four hours. */
const eight = (): FocusSession[] =>
  Array.from({ length: 8 }, (_, i) => sess(i, 9 + i, 0, 30));

function adjust(totalMins: number, stampMs: number, day = DAY): FocusSession {
  return createDayAdjustment(day, totalMins * 60, 0, stampMs) as FocusSession;
}

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n += 1;
  console.log(`  ok ${name}`);
}

console.log('--- 1. THE REPORTED BUG ---');

test('raising the total keeps all eight sessions and their lengths', () => {
  const rows = [...eight(), adjust(4 * 60 + 20, at(18))];
  const t = tallyFocusDays(rows, 0, { countsAsSession: isCompletedFocusSession }).get(DAY)!;
  assert.equal(t.seconds, (4 * 60 + 20) * 60, 'total is what was typed');
  assert.equal(t.sessions, 8, 'still eight sessions');
  assert.equal(t.sessionSeconds, 4 * 3600, 'sessions still add up to their own four hours');
  assert.equal(t.adjusted, true);
});

test('lowering the total keeps all sessions too', () => {
  const rows = [...eight(), adjust(60, at(18))];
  const t = tallyFocusDays(rows, 0, { countsAsSession: isCompletedFocusSession }).get(DAY)!;
  assert.equal(t.seconds, 3600);
  assert.equal(t.sessions, 8);
});

test('typing zero is an override of zero, never a deletion', () => {
  const rows = [...eight(), adjust(0, at(18))];
  const t = tallyFocusDays(rows, 0, { countsAsSession: isCompletedFocusSession }).get(DAY)!;
  assert.equal(t.seconds, 0);
  assert.equal(t.sessions, 8);
});

test('widget helpers agree with the Focus screen', () => {
  const rows = [...eight(), adjust(270, at(18))];
  const day = new Date(2026, 8, 10);
  assert.equal(sumFocusSecondsForDay(rows, day, 0), 270 * 60);
  assert.equal(countCompletedSessionsForDay(rows, day, 0), 8);
});

console.log('--- 2. THE OVERRIDE IS NOT A SESSION ---');

test('recognised as a day adjustment and a typed total', () => {
  const a = adjust(90, at(18));
  assert.ok(a.id.startsWith(`adjust-${DAY}-`));
  assert.ok(isDayAdjustment(a));
  assert.ok(isTypedDayTotal(a));
  assert.ok(!isDayAdjustment(sess(0, 9, 0, 30)));
  assert.ok(isTypedDayTotal({ id: 'manual-2026-09-10-1-3600' }), 'legacy rows are typed totals too');
  assert.ok(!isDayAdjustment({ id: 'manual-2026-09-10-1-3600' }), 'but not adjustments');
});

test('a zero override survives loading; a zero session does not', () => {
  const zero = adjust(0, at(18));
  const junk = { ...sess(0, 9, 0, 30), id: 'session-zero', durationSeconds: 0 };
  const loaded = safeFocusSessions([zero, junk, sess(1, 10, 0, 30)]);
  assert.ok(loaded.some(s => s.id === zero.id), 'typed zero kept');
  assert.ok(!loaded.some(s => s.id === 'session-zero'), 'zero-length session dropped');
  assert.equal(safeFocusSessions([{ ...zero, durationSeconds: NaN }]).length, 0, 'NaN never kept');
});

test('never a completed session, however long', () => {
  assert.equal(isCompletedFocusSession(adjust(600, at(18))), false);
});

test('both endpoints inside its own focus day, even with a late day start', () => {
  const a = createDayAdjustment(DAY, 23 * 3600, 4, at(18));
  const s = Date.parse(a.startedAt), e = Date.parse(a.endedAt!);
  assert.equal(new Date(s).getHours(), 4);
  assert.ok(e - s === 23 * 3600 * 1000);
});

test('capped at a day and robust to junk input', () => {
  assert.equal(createDayAdjustment(DAY, 99 * 3600, 0, 1).durationSeconds, 24 * 3600 - 60);
  assert.equal(createDayAdjustment(DAY, NaN, 0, 1).durationSeconds, 0);
  assert.equal(createDayAdjustment(DAY, -50, 0, 1).durationSeconds, 0);
  assert.equal(createDayAdjustment(DAY, 90.9, 0, 1).durationSeconds, 90);
});

test('not listed on the session-detail page, but the total honours it', () => {
  const rows = [...eight(), adjust(300, at(18))];
  const d = buildSessionDetail(rows, [DAY], 0);
  assert.equal(d.matches.length, 8, 'eight sessions listed');
  assert.ok(d.matches.every(m => !isDayAdjustment(m.session)));
  assert.equal(d.totalSeconds, 300 * 60, 'header total is the typed total');
  assert.equal(d.realSeconds, 4 * 3600, 'the sessions keep their own sum');
  assert.deepEqual(d.adjustments, [{ key: DAY, totalSeconds: 300 * 60, sessionSeconds: 4 * 3600 }]);
  assert.equal(d.avgSeconds, 30 * 60, 'average session length is unchanged');
});

test('week detail groups carry the note per day', () => {
  const other = '2026-09-11';
  const rows = [...eight(), adjust(300, at(18)), sess(99, 9, 0, 30, {
    id: 'session-next', startedAt: iso(at(9) + 86_400_000), endedAt: iso(at(9, 30) + 86_400_000),
  })];
  const d = buildSessionDetail(rows, [DAY, other], 0);
  const g = d.groups.find(x => x.key === DAY)!;
  assert.equal(g.adjusted, true);
  assert.equal(g.seconds, 300 * 60);
  assert.equal(g.sessionSeconds, 4 * 3600);
  const g2 = d.groups.find(x => x.key === other)!;
  assert.equal(g2.adjusted, false);
  assert.equal(g2.seconds, 1800);
});

test('a day with only an override (no sessions) still shows its total', () => {
  const d = buildSessionDetail([adjust(45, at(18))], [DAY, '2026-09-11'], 0);
  assert.equal(d.matches.length, 0);
  assert.equal(d.totalSeconds, 45 * 60);
  assert.equal(d.groups.length, 1, 'the adjusted day keeps a group');
});

test('never merged into a neighbouring session', () => {
  const s = sess(0, 18, 0, 30);
  const out = mergeContiguousFocusSession([adjust(60, at(17, 59))], { ...s, startedAt: iso(at(17, 59) + 30_000) });
  assert.equal(out.merged, false);
});

console.log('--- 3. WHICH TYPED TOTAL WINS ---');

test('re-editing: the newest override rules, older ones are ignored', () => {
  const rows = [...eight(), adjust(300, at(18)), adjust(250, at(19))];
  assert.equal(tallyFocusDays(rows).get(DAY)!.seconds, 250 * 60);
  // Order of arrival does not matter.
  assert.equal(tallyFocusDays([...rows].reverse()).get(DAY)!.seconds, 250 * 60);
});

test('dedupe keeps one override per day', () => {
  const rows = dedupeFocusHistory([adjust(300, at(18)), adjust(250, at(19))]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durationSeconds, 250 * 60);
});

test('a newer override beats an older legacy manual row, and vice versa', () => {
  const legacy = { id: `manual-${DAY}-${at(17)}-3600`, startedAt: iso(at(0)), endedAt: iso(at(1)), durationSeconds: 3600, plannedSeconds: 3600 };
  assert.equal(tallyFocusDays([legacy, adjust(90, at(18))]).get(DAY)!.seconds, 90 * 60);
  const newerLegacy = { ...legacy, id: `manual-${DAY}-${at(20)}-3600` };
  assert.equal(tallyFocusDays([newerLegacy, adjust(90, at(18))]).get(DAY)!.seconds, 3600);
});

test('overrides on other days do not leak', () => {
  const rows = [...eight(), adjust(10, at(18) + 86_400_000, '2026-09-11')];
  assert.equal(tallyFocusDays(rows).get(DAY)!.seconds, 4 * 3600);
  assert.equal(tallyFocusDays(rows).get(DAY)!.adjusted, false);
  assert.equal(tallyFocusDays(rows).get('2026-09-11')!.seconds, 600);
});

console.log('--- 4. WORK AFTER THE EDIT ---');

test('a session logged after the edit adds on top of the typed total', () => {
  const rows = [...eight(), adjust(270, at(17)), sess(9, 18, 0, 45)];
  const t = tallyFocusDays(rows, 0, { countsAsSession: isCompletedFocusSession }).get(DAY)!;
  assert.equal(t.seconds, (270 + 45) * 60);
  assert.equal(t.sessions, 9);
});

test('a session running during the edit: full length on the row, banked part skipped in the total', () => {
  // Edit at 18:20 while an 18:00 session runs; it had run 20 minutes, which
  // the typed total already covers. It then runs to 18:50.
  const running = sess(9, 18, 0, 50, { creditedSeconds: 20 * 60 });
  const rows = [...eight(), adjust(300, at(18, 20)), running];
  const t = tallyFocusDays(rows, 0, { countsAsSession: isCompletedFocusSession }).get(DAY)!;
  assert.equal(t.seconds, (300 + 30) * 60, 'only the 30 minutes after the edit are added');
  assert.equal(t.sessions, 9);
  assert.equal(t.sessionSeconds, 4 * 3600 + 50 * 60, 'the session shows its whole 50 minutes');
  const d = buildSessionDetail(rows, [DAY], 0);
  assert.equal(d.matches.find(m => m.session.id === running.id)!.actual, 50 * 60);
});

test('credit larger than the session never makes a negative total', () => {
  const odd = sess(9, 18, 0, 10, { creditedSeconds: 99_999 });
  const rows = [adjust(60, at(17)), odd];
  assert.equal(tallyFocusDays(rows).get(DAY)!.seconds, 3600);
});

test('credit on a day with no override is still subtracted (legacy parity)', () => {
  const rows = [sess(0, 9, 0, 60, { creditedSeconds: 600 })];
  assert.equal(tallyFocusDays(rows).get(DAY)!.seconds, 50 * 60);
});

test('merging two halves keeps both banked parts', () => {
  const a = sess(0, 9, 0, 30, { creditedSeconds: 300 });
  const b = { ...sess(1, 9, 30, 30), creditedSeconds: 120 };
  const out = mergeContiguousFocusSession([a], b);
  assert.equal(out.merged, true);
  assert.equal(out.session.creditedSeconds, 420);
  assert.equal(out.session.durationSeconds, 3600);
});

test('sessionCredit clamps to the logged duration and drops zero', () => {
  const timer = { creditedSeconds: 900 } as FocusTimerState;
  assert.equal(sessionCredit(timer, 600), 600);
  assert.equal(sessionCredit(timer, 1200), 900);
  assert.equal(sessionCredit({ creditedSeconds: 0 } as FocusTimerState, 1200), undefined);
  assert.equal(sessionCredit({} as FocusTimerState, 1200), undefined);
});

console.log('--- 5. LEGACY manual- ROWS KEEP THEIR OLD MEANING ---');

test('a legacy row still counts as one and hides the sessions it replaced', () => {
  const legacy = { id: `manual-${DAY}-${at(17)}-9000`, startedAt: iso(at(0)), endedAt: iso(at(2, 30)), durationSeconds: 9000, plannedSeconds: 9000 };
  // Two sessions from before the legacy edit came back through sync.
  const rows = [legacy, sess(0, 9, 0, 30), sess(1, 10, 0, 30), sess(2, 18, 0, 30)];
  const t = tallyFocusDays(rows).get(DAY)!;
  assert.equal(t.seconds, 9000 + 1800, 'typed total plus the one after it');
  assert.equal(t.sessions, 2, 'the legacy row plus the one after it, as before');
});

console.log('--- 6. EVERY SUMMARY AGREES ---');

test('week summary, month summary, streaks and goals use the typed total', () => {
  const rows = [...eight(), adjust(300, at(18))];
  const week = summariseFocus(rows, { from: DAY, to: DAY });
  assert.equal(week.totalSeconds, 300 * 60);
  assert.equal(week.sessions, 8);
  const months = summariseFocusMonths(rows, { end: new Date(2026, 8, 30), count: 1 });
  assert.equal(months.months[0].seconds, 300 * 60);
  assert.equal(months.months[0].sessions, 8);
  const streak = computeAllTimeStreaks([adjust(0, at(18))], { anchorDate: new Date(at(20)) });
  assert.equal(streak.currentStreak, 0, 'a day typed to zero is not a focus day');
  const goal = computeGoalStats(rows, { now: iso(at(20)), goalSeconds: 5 * 3600 });
  assert.equal(goal.todayTotal, 300 * 60);
  assert.equal(goal.todayProgress, 1);
});

test('applyTypedDayTotals never returns an older override', () => {
  const out = applyTypedDayTotals([adjust(300, at(18)), adjust(250, at(19))]);
  assert.equal(out.length, 1);
  assert.equal(out[0].durationSeconds, 250 * 60);
});

console.log('--- 7. THE PHONE EDIT (adjustDayTotal) ---');

test('writes one override and deletes nothing but the previous override', () => {
  const rows: FocusSessionRecord[] = [...eight(), adjust(200, at(17))];
  const out = adjustDayTotal(rows, { dateKeyVal: DAY, newTotalSeconds: 300 * 60, now: at(18) });
  assert.equal(out.mutated.length, 1);
  assert.ok(isDayAdjustment(out.mutated[0]));
  assert.equal(out.mutated[0].durationSeconds, 300 * 60);
  assert.deepEqual(out.deletedIds, [rows[8].id], 'only the old override goes');
});

test('no-op when the total already matches', () => {
  const out = adjustDayTotal(eight(), { dateKeyVal: DAY, newTotalSeconds: 4 * 3600, now: at(18) });
  assert.deepEqual(out, { mutated: [], deletedIds: [] });
});

test('zero is an override, not a deletion of sessions', () => {
  const out = adjustDayTotal(eight(), { dateKeyVal: DAY, newTotalSeconds: 0, now: at(18) });
  assert.equal(out.deletedIds.length, 0);
  assert.equal(out.mutated[0].durationSeconds, 0);
});

test('garbage totals are clamped', () => {
  const out = adjustDayTotal(eight(), { dateKeyVal: DAY, newTotalSeconds: NaN, now: at(18) });
  assert.equal(out.mutated[0].durationSeconds, 0);
});

test('an empty day can be given a total', () => {
  const out = adjustDayTotal([], { dateKeyVal: DAY, newTotalSeconds: 3600, now: at(18) });
  assert.equal(out.mutated[0].durationSeconds, 3600);
  const t = tallyFocusDays(out.mutated).get(DAY)!;
  assert.equal(t.seconds, 3600);
  assert.equal(t.sessions, 0);
});

console.log(`\nALL PASS (focusDayAdjust: ${n} cases)`);
