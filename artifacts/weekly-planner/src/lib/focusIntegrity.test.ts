// ─────────────────────────────────────────────────────────────────────────────
// THE FOCUS HISTORY CANNOT INVENT TIME.
//
// This suite exists because it did. A real database reported a Tuesday of
// thirty hours and twenty minutes, and a Thursday of seventeen hours forty, for
// a person who works nine. None of it was a rendering fault: the chart added up
// exactly what was stored, and what was stored was wrong, in four independent
// ways that had been quietly stacking for weeks.
//
//   1. ONE SESSION, THREE NAMES. An hour that ends by running out on the PC,
//      by being stopped on the phone, and by being rebuilt after a shutdown was
//      written as `auto-<start>-3600`, `stop-<start>-3510` and
//      `recovered-<start>`. The deduplication meant to collapse them compared
//      ids. Nine sessions were logged twice; eight hours were invented.
//
//   2. A DELETION THAT WOULD NOT STICK. Correcting a day's total deletes that
//      day's rows and writes one typed total in their place. The server folded
//      every save into what was on disk and kept anything the sender did not
//      mention, so the next save from any other window put the deleted rows
//      back. Correct the same day twice and both typed totals were there too.
//
//   3. A TYPED TOTAL THAT STRADDLED THE BOUNDARY. The synthesised row anchored
//      its END six hours into the focus day and counted backwards, so a nine
//      hour total began before the day it belonged to.
//
//   4. AN HOUR INVENTED BY SITTING DOWN. The hotkey and the desk sensor reach
//      the timer through a server route that did its own arithmetic: if the
//      timer said running, add `now - lastStartedAt` and pause. Hibernate
//      overnight with a session running and that difference is the whole night.
//
// Run with: npx tsx src/lib/focusIntegrity.test.ts

import assert from 'node:assert/strict';
import {
  dedupeFocusHistory,
  focusHistoryDuplicates,
  applyTypedDayTotals,
  focusSessionId,
  foldFocusSessions,
  normaliseFocusSessionId,
  summariseFocus,
  focusDayKey,
  type FocusSessionRecord,
} from './focusStats';
import {
  coerceFocusTimer,
  reduceFocusTimer,
  IDLE_FOCUS_TIMER,
  type FocusTimerState,
} from './focusTimer';
import {
  focusSessionTruth,
  createManualFocusSession,
  safeFocusSessions,
  MAX_MANUAL_DAY_SECONDS,
} from './focusSessions';

const iso = (ms: number) => new Date(ms).toISOString();
const rec = (
  id: string,
  startedAt: string,
  endedAt: string,
  durationSeconds: number,
): FocusSessionRecord => ({ id, startedAt, endedAt, durationSeconds, plannedSeconds: 3600 });

// ─── 1. A session is the moment it began ────────────────────────────────────
{
  console.log('--- 1. ONE SESSION, ONE IDENTITY ---');

  const START = '2026-09-01T15:16:45.280Z';

  // The three spellings that were actually found in the database, all folded
  // onto one key. These exact strings are from the real file.
  assert.equal(normaliseFocusSessionId(`auto-${START}-3600`), `session-${START}`);
  assert.equal(normaliseFocusSessionId(`stop-${START}-2644`), `session-${START}`);
  assert.equal(normaliseFocusSessionId(`recovered-${START}`), `session-${START}`);
  assert.equal(normaliseFocusSessionId(`session-${START}`), `session-${START}`, 'and it is idempotent');

  // The trailing number is exactly what the two machines disagree about, so it
  // must not survive into the identity, whatever it happens to be.
  for (const n of [0, 1, 60, 3510, 3600, 43200]) {
    assert.equal(normaliseFocusSessionId(`auto-${START}-${n}`), `session-${START}`,
      `a planned length of ${n} is not part of who this session is`);
    assert.equal(normaliseFocusSessionId(`stop-${START}-${n}`), `session-${START}`,
      `nor is a duration of ${n}`);
  }

  // A build that wrote no trailing number at all still folds.
  assert.equal(normaliseFocusSessionId(`auto-${START}`), `session-${START}`);
  assert.equal(normaliseFocusSessionId(`stop-${START}`), `session-${START}`);

  // Two DIFFERENT sessions must never collide, which is the failure that would
  // silently delete work rather than merely double-count it.
  const other = '2026-09-01T16:17:57.689Z';
  assert.notEqual(normaliseFocusSessionId(`auto-${START}-3600`), normaliseFocusSessionId(`auto-${other}-3600`));

  // A typed day total is NOT a session and must keep its own identity here.
  assert.equal(normaliseFocusSessionId('manual-2026-09-01-1788359451235-35700'),
    'manual-2026-09-01-1788359451235-35700', 'a typed total is not a session');

  // Anything unrecognised is left exactly as it is: a uid from an older build
  // is still a real row and folding it into something else would lose it.
  assert.equal(normaliseFocusSessionId('4d50e231-8294-4c2b-bfdd-88e69d0c897d'),
    '4d50e231-8294-4c2b-bfdd-88e69d0c897d');
  assert.equal(normaliseFocusSessionId(''), '');

  // Minting.
  assert.equal(focusSessionId(START), `session-${START}`);
  assert.equal(focusSessionId(START, '2026-09-01T16:00:00.000Z'), `session-${START}`,
    'the start wins when there is one');

  // NO START. Collapsing every such row onto one constant would delete work, so
  // the end is used instead: still deterministic, still distinct.
  const a = focusSessionId(null, '2026-09-01T16:00:00.000Z');
  const b = focusSessionId(null, '2026-09-01T17:00:00.000Z');
  assert.equal(a, focusSessionId(null, '2026-09-01T16:00:00.000Z'), 'deterministic for one record');
  assert.notEqual(a, b, 'and different for different records');
  assert.ok(focusSessionId(null).startsWith('session-unknown-'), 'nothing at all still yields an id');

  console.log('  Three old spellings collapse; distinct sessions stay distinct');
}

// ─── 2. Collapsing a history ────────────────────────────────────────────────
{
  console.log('\n--- 2. ONE ROW PER SESSION ---');

  const S = '2026-09-01T15:16:45.280Z';
  const E1 = '2026-09-01T16:16:45.280Z';
  const E2 = '2026-09-01T16:00:49.280Z';

  // The exact shape found in the database: the PC logged the full planned hour
  // and the phone logged the hand stop, forty-four minutes.
  const both = [
    rec(`auto-${S}-3600`, S, E1, 3600),
    rec(`stop-${S}-2644`, S, E2, 2644),
  ];
  const one = dedupeFocusHistory(both);
  assert.equal(one.length, 1, 'one session is one row');
  assert.equal(one[0].durationSeconds, 2644,
    'and the SHORTER reading wins: this function exists because time was invented, '
    + 'so when the two ends disagree the one that does not invent is the honest one');

  // Order of arrival must not change the answer, or two devices would disagree.
  assert.deepEqual(dedupeFocusHistory([both[1], both[0]])[0], one[0],
    'the same answer whichever order they arrive in');

  // Three-way, including a recovery.
  const three = dedupeFocusHistory([
    rec(`auto-${S}-3600`, S, E1, 3600),
    rec(`recovered-${S}`, S, E1, 3600),
    rec(`stop-${S}-2644`, S, E2, 2644),
  ]);
  assert.equal(three.length, 1);
  assert.equal(three[0].durationSeconds, 2644);

  // Coherence breaks a tie. A row claiming 2994 seconds inside a five
  // millisecond span is one the endpoints of which were rebuilt badly; a row
  // that agrees with itself is the better record of the same fact. (This exact
  // pair is in the real database.)
  const G = '2026-09-01T20:09:54.962Z';
  const tie = dedupeFocusHistory([
    rec(`recovered-${G}`, G, '2026-09-01T20:09:54.967Z', 2994),
    rec(`stop-${G}-2994`, G, '2026-09-01T20:59:48.962Z', 2994),
  ]);
  assert.equal(tie.length, 1);
  assert.equal(tie[0].id, `stop-${G}-2994`, 'the self-consistent record wins the tie');

  // Different sessions are untouched, and their order is preserved: a list that
  // was sorted stays sorted, so nothing appears to jump on screen.
  const many = dedupeFocusHistory([
    rec('session-c', '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', 3600),
    rec('session-b', '2026-09-01T11:00:00.000Z', '2026-09-01T12:00:00.000Z', 3600),
    rec('session-a', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 3600),
  ]);
  assert.deepEqual(many.map(s => s.id), ['session-c', 'session-b', 'session-a'],
    'order is preserved exactly');

  // Rubbish in the list is dropped rather than thrown on.
  const messy = dedupeFocusHistory([
    null as any, undefined as any, {} as any, { id: '' } as any, 5 as any,
    rec('session-x', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 3600),
  ]);
  assert.deepEqual(messy.map(s => s.id), ['session-x']);
  assert.deepEqual(dedupeFocusHistory([]), []);
  assert.deepEqual(dedupeFocusHistory(null as any), []);

  // And it says what it removed, because a number nobody can check is not
  // evidence.
  const report = focusHistoryDuplicates(both);
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0].id, `auto-${S}-3600`);
  assert.equal(report.secondsRemoved, 3600);

  console.log('  Duplicates collapse to the conservative reading, order intact');
}

// ─── 3. A day typed in twice is one day ─────────────────────────────────────
{
  console.log('\n--- 3. ONE TYPED TOTAL PER DAY ---');

  // Exactly the two rows that made Tuesday claim thirty hours: the same day
  // corrected on Wednesday and then again on Friday, both left in place.
  const first = rec('manual-2026-09-01-1788359451235-35700',
    '2026-09-01T01:05:00.000Z', '2026-09-01T07:00:00.000Z', 35700);
  const second = rec('manual-2026-09-01-1788507535414-33000',
    '2026-09-01T01:50:00.000Z', '2026-09-01T07:00:00.000Z', 33000);

  const kept = dedupeFocusHistory([first, second]);
  assert.equal(kept.length, 1, 'one day holds one typed total');
  assert.equal(kept[0].id, second.id,
    'and it is the LATEST edit: these are corrections, not two observations, '
    + 'so the last thing the user typed is what they meant');
  assert.deepEqual(dedupeFocusHistory([second, first])[0].id, second.id,
    'whichever order they arrive in');

  // A third correction wins over both.
  const third = rec('manual-2026-09-01-1788600000000-30000',
    '2026-09-01T01:00:00.000Z', '2026-09-01T07:00:00.000Z', 30000);
  assert.equal(dedupeFocusHistory([first, second, third])[0].id, third.id);

  // Typed totals for DIFFERENT days are different facts and both survive.
  const otherDay = rec('manual-2026-09-03-1788465284208-21600',
    '2026-09-03T01:00:00.000Z', '2026-09-03T07:00:00.000Z', 21600);
  assert.equal(dedupeFocusHistory([first, second, otherDay]).length, 2);

  // A typed total does not swallow the day's real sessions when they are meant
  // to be there -- collapsing is about DUPLICATES, not about the day's shape.
  const realOne = rec('session-2026-09-01T12:00:00.000Z',
    '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', 3600);
  assert.equal(dedupeFocusHistory([second, realOne]).length, 2,
    'a typed total and a session are two rows; which of them SHOULD be there is '
    + 'decided when the edit is saved, not here');

  console.log('  The last correction wins, per day');
}

// ─── 4. The Tuesday that claimed thirty hours ───────────────────────────────
{
  console.log('\n--- 4. THE REAL TUESDAY, END TO END ---');

  // Reconstructed from the actual file, in the shape that produced 30h 20m.
  const DAY = '2026-09-01';
  const H = (t: string) => `2026-09-01T${t}:00.000Z`;

  const history: FocusSessionRecord[] = [
    // Two typed totals for the day, 9h55m and 9h10m.
    rec('manual-2026-09-01-1788359451235-35700', H('01:05'), H('07:00'), 35700),
    rec('manual-2026-09-01-1788507535414-33000', H('01:50'), H('07:00'), 33000),
    // One session logged twice, once as an auto-completion and once as a stop.
    rec('auto-2026-09-01T11:11:46.077Z-3600', '2026-09-01T11:11:46.077Z', H('12:12'), 3600),
    rec('stop-2026-09-01T11:11:46.077Z-3510', '2026-09-01T11:11:46.077Z', H('12:10'), 3510),
    // And another.
    rec('auto-2026-09-01T15:16:45.280Z-3600', '2026-09-01T15:16:45.280Z', H('16:17'), 3600),
    rec('stop-2026-09-01T15:16:45.280Z-2644', '2026-09-01T15:16:45.280Z', H('16:01'), 2644),
  ];

  const before = history.reduce((n, s) => n + s.durationSeconds, 0);
  assert.equal(before, 82054, 'the raw rows really do add up to nearly twenty-three hours');

  const after = dedupeFocusHistory(history);
  const total = after.reduce((n, s) => n + s.durationSeconds, 0);
  assert.equal(after.length, 3, 'one typed total and two sessions');
  assert.equal(total, 33000 + 3510 + 2644);
  assert.ok(total < 24 * 3600, 'and a day no longer claims more hours than a day has');

  // AND THEN THE CORRECTION IS HONOURED. Collapsing the duplicates leaves nine
  // hours typed plus the sessions it was meant to stand in for, which is still
  // seventeen. `summariseFocus` applies both rules, so a chart drawn from the
  // unrepaired file shows what the user actually meant that day to be.
  const summary = summariseFocus(history, { from: DAY, to: DAY, dayStartHour: 4 });
  assert.equal(summary.days.length, 1);
  assert.equal(summary.days[0].seconds, 33000,
    'the day is the correction the user typed last, and nothing else');
  assert.ok(summary.days[0].seconds < 10 * 3600,
    'which is a day a person could actually have worked');

  // Work logged AFTER the correction is not swallowed by it.
  const later = rec('session-2026-09-05T09:00:00.000Z',
    '2026-09-05T09:00:00.000Z', '2026-09-05T10:00:00.000Z', 3600);
  const laterOnSameDay = { ...later, id: 'session-late', endedAt: '2026-09-04T12:00:00.000Z',
    startedAt: '2026-09-04T11:00:00.000Z' };
  const withLate = summariseFocus(
    [...history, { ...laterOnSameDay, endedAt: H('12:00'), startedAt: H('11:00'), id: 'session-after-the-edit' }],
    { from: DAY, to: DAY, dayStartHour: 4 },
  );
  assert.equal(withLate.days[0].seconds, 33000,
    'a session that ended BEFORE the correction is still replaced by it');

  console.log(`  30h 20m of stored rows read as ${(total / 3600).toFixed(2)}h`);
}

// ─── 5. A typed total stays inside its own day ──────────────────────────────
{
  console.log('\n--- 5. A TYPED TOTAL DOES NOT STRADDLE THE BOUNDARY ---');

  // The old version anchored the END six hours into the day and counted back,
  // so anything over six hours started before the day did.
  for (const dayStart of [0, 3, 4, 6, 12, 23]) {
    for (const hours of [0.5, 1, 5, 6, 8, 9.9, 12, 20, 23.9]) {
      const seconds = Math.round(hours * 3600);
      const row = createManualFocusSession('2026-09-01', seconds, dayStart);
      const startKey = focusDayKey(row.startedAt, dayStart);
      const endKey = focusDayKey(row.endedAt, dayStart);
      assert.equal(startKey, '2026-09-01',
        `${hours}h with dayStart ${dayStart}: the row STARTS on the day it is for`);
      assert.equal(endKey, '2026-09-01',
        `${hours}h with dayStart ${dayStart}: and ENDS on it too`);
      assert.equal(row.durationSeconds, seconds, 'and says what was typed');
      // And its own endpoints agree with the duration it claims.
      const span = (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000;
      assert.equal(span, seconds, 'with a span that matches');
    }
  }

  // A day cannot hold more than a day, however it is typed.
  const huge = createManualFocusSession('2026-09-01', 40 * 3600, 4);
  assert.equal(huge.durationSeconds, MAX_MANUAL_DAY_SECONDS, 'an absurd total is capped at a day');
  assert.equal(focusDayKey(huge.endedAt, 4), '2026-09-01', 'and the cap keeps it inside the day');

  // Negative and nonsense are floored rather than allowed to run backwards.
  assert.equal(createManualFocusSession('2026-09-01', -5, 4).durationSeconds, 0);
  assert.equal(createManualFocusSession('2026-09-01', Number.NaN, 4).durationSeconds, 0);

  // The id still carries the day it was typed for, which is what lets two edits
  // of one day collapse.
  assert.ok(createManualFocusSession('2026-09-01', 3600, 4).id.startsWith('manual-2026-09-01-'));

  console.log('  Both endpoints land inside the day, for every hour and every cutoff');
}

// ─── 6. Folding a save: absence is not deletion ─────────────────────────────
{
  console.log('\n--- 6. A DELETION THAT STICKS ---');

  const a = rec('session-a', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z', 3600);
  const b = rec('session-b', '2026-09-01T11:00:00.000Z', '2026-09-01T12:00:00.000Z', 3600);
  const c = rec('session-c', '2026-09-01T12:00:00.000Z', '2026-09-01T13:00:00.000Z', 3600);

  // A stale client that has never heard of `c` must not delete it. This is the
  // reason the fold exists and it must keep working.
  const stale = foldFocusSessions([a, b, c], [a, b]);
  assert.equal(stale.length, 3, 'a row the sender did not mention is kept');
  assert.ok(stale.some(s => s.id === 'session-c'));

  // A client that SAYS it removed something has it removed.
  const deleted = foldFocusSessions([a, b, c], [a, b], ['session-c']);
  assert.equal(deleted.length, 2, 'a row the sender named is dropped');
  assert.ok(!deleted.some(s => s.id === 'session-c'));

  // The exact scenario that corrupted Tuesday: a day is replaced by a typed
  // total, and then a second window saves its own older copy.
  const typed = rec('manual-2026-09-01-1788507535414-33000',
    '2026-09-01T01:00:00.000Z', '2026-09-01T10:10:00.000Z', 33000);
  const afterEdit = foldFocusSessions([a, b, c], [typed], ['session-a', 'session-b', 'session-c']);
  assert.deepEqual(afterEdit.map(s => s.id), [typed.id], 'the edit leaves exactly the typed total');

  const widgetSavesStaleCopy = foldFocusSessions(afterEdit, [a, b, c]);
  assert.equal(widgetSavesStaleCopy.length, 4,
    'the old rows DO come back, because a plain save cannot express a deletion '
    + 'and the widget genuinely does not know they were removed');
  // ...which is exactly why the removal is named. A widget that saves after the
  // edit adds nothing it did not itself log:
  const widgetAddsOnlyItsOwn = foldFocusSessions(afterEdit, [typed]);
  assert.deepEqual(widgetAddsOnlyItsOwn.map(s => s.id), [typed.id]);

  // Additions from elsewhere survive a fold in either direction.
  const d = rec('session-d', '2026-09-01T13:00:00.000Z', '2026-09-01T14:00:00.000Z', 3600);
  assert.equal(foldFocusSessions([a, b], [a, b, d]).length, 3, 'a new row is taken');
  assert.equal(foldFocusSessions([a, b, d], [a, b]).length, 3, 'and kept');

  // The sender's version of a row it knows about wins, so an edited duration
  // reaches disk.
  const edited = { ...b, durationSeconds: 1800 };
  const folded = foldFocusSessions([a, b], [edited]);
  assert.equal(folded.find(s => s.id === 'session-b')!.durationSeconds, 1800);

  // Folding collapses duplicates too, so a phone and a PC that each logged the
  // same session cannot survive the trip.
  const S = '2026-09-01T15:16:45.280Z';
  const merged = foldFocusSessions(
    [rec(`auto-${S}-3600`, S, '2026-09-01T16:16:45.280Z', 3600)],
    [rec(`stop-${S}-2644`, S, '2026-09-01T16:00:49.280Z', 2644)],
  );
  assert.equal(merged.length, 1, 'one session, one row, even across two devices');

  // Newest first, which is the order the file is stored in.
  const ordered = foldFocusSessions([], [a, c, b]);
  assert.deepEqual(ordered.map(s => s.id), ['session-c', 'session-b', 'session-a']);

  // Empty and rubbish inputs are answers, not exceptions.
  assert.deepEqual(foldFocusSessions([], []), []);
  assert.deepEqual(foldFocusSessions(null as any, null as any), []);
  assert.equal(foldFocusSessions([a], [null as any, { id: 5 } as any]).length, 1);

  console.log('  Named removals stick; unmentioned rows are kept');
}

// ─── 7. Hibernating with a session running ──────────────────────────────────
{
  console.log('\n--- 7. THE PC GOES OFF WITH THE TIMER RUNNING ---');

  const NIGHT = Date.parse('2026-09-03T21:30:00.000Z');   // 00:30 local, session starts
  const MORNING = Date.parse('2026-09-04T06:00:00.000Z'); // 09:00 local, user sits down

  const running: FocusTimerState = {
    ...IDLE_FOCUS_TIMER,
    plannedSeconds: 3600,
    accumulatedSeconds: 0,
    isRunning: true,
    lastStartedAt: iso(NIGHT),
    sessionStartedAt: iso(NIGHT),
    updatedAt: NIGHT,
  };

  // THE OLD BEHAVIOUR, said out loud so the cost is on the record: the server
  // route added `now - lastStartedAt` and paused, which banks eight and a half
  // hours into a one hour session.
  const naive = Math.floor((MORNING - NIGHT) / 1000);
  assert.ok(naive > 30000, 'the gap really is most of a night');

  // What the toggle does now. The session ran out at 01:30 local and is
  // finished, at that moment, for exactly its planned length.
  const out = reduceFocusTimer(running, { kind: 'toggle' }, MORNING, 'desk');
  assert.ok(out.changed);
  assert.ok(out.session, 'sitting down finishes the session rather than banking the night');
  assert.equal(out.session!.durationSeconds, 3600, 'worth its planned hour, and not a second more');
  assert.equal(out.session!.endedAt, iso(NIGHT + 3600 * 1000),
    'and it ended when it ran out, not when the machine came back');
  assert.equal(out.state.isRunning, false, 'the timer is idle afterwards');
  assert.equal(out.state.accumulatedSeconds, 0, 'with nothing banked');
  assert.equal(out.state.sessionStartedAt, null);

  // THE DAY IT LANDS ON. With a 04:00 cutoff, 01:30 local belongs to the
  // previous day -- the night it was actually worked, not the morning the user
  // sat down. This is the "an hour appeared in today out of nowhere" report.
  assert.equal(focusDayKey(out.session!.endedAt, 4), '2026-09-03',
    'the hour is credited to the night it was worked');
  assert.notEqual(focusDayKey(out.session!.endedAt, 4), focusDayKey(iso(MORNING), 4),
    'and emphatically NOT to the day the user sat back down');

  // `updatedAt` survives. The route used to rebuild the timer field by field
  // and drop it, destroying the very stamp that lets a ghost be recognised.
  assert.equal(typeof out.state.updatedAt, 'number');
  assert.equal(out.state.updatedAt, MORNING, 'and is refreshed by the write');

  // A SECOND press must not log the hour again.
  const again = reduceFocusTimer(out.state, { kind: 'toggle' }, MORNING + 1000, 'desk');
  assert.equal(again.session, null, 'nothing more to finish');
  assert.equal(again.state.isRunning, true, 'the second press starts a fresh session');
  assert.equal(again.state.sessionStartedAt, iso(MORNING + 1000), 'stamped now, not last night');

  // Pausing an overdue ghost settles it too, rather than banking the overrun.
  const paused = reduceFocusTimer(running, { kind: 'pause' }, MORNING, 'desk');
  assert.ok(paused.session, 'a pause on an overdue session finishes it');
  assert.equal(paused.session!.durationSeconds, 3600);
  assert.equal(paused.state.accumulatedSeconds, 0, 'and banks nothing');

  // A session that is genuinely still running is untouched by all of this.
  const fresh = reduceFocusTimer(running, { kind: 'toggle' }, NIGHT + 5 * 60 * 1000, 'desk');
  assert.equal(fresh.session, null, 'five minutes in, there is nothing to log');
  assert.equal(fresh.state.isRunning, false, 'it is simply paused');
  assert.equal(fresh.state.accumulatedSeconds, 300, 'with the five minutes banked');

  // And resuming from that pause and hibernating again does not double-bank.
  const resumed = reduceFocusTimer(fresh.state, { kind: 'toggle' }, NIGHT + 6 * 60 * 1000, 'desk');
  assert.equal(resumed.state.isRunning, true);
  const settled = reduceFocusTimer(resumed.state, { kind: 'toggle' }, MORNING, 'desk');
  assert.ok(settled.session);
  assert.equal(settled.session!.durationSeconds, 3600,
    'still exactly the planned hour, however many pauses it took');

  console.log('  A night off is never banked, and never lands on the new day');
}

// ─── 8. The toggle across every starting state ──────────────────────────────
{
  console.log('\n--- 8. THE TOGGLE, FROM EVERY STATE ---');

  const T0 = Date.parse('2026-09-04T08:00:00.000Z');
  const idle: FocusTimerState = { ...IDLE_FOCUS_TIMER, plannedSeconds: 3600 };

  // Idle → running.
  const started = reduceFocusTimer(idle, { kind: 'toggle' }, T0, 'desk');
  assert.equal(started.state.isRunning, true);
  assert.equal(started.state.sessionStartedAt, iso(T0));
  assert.equal(started.session, null, 'starting logs nothing');

  // Running → paused, banking only what actually ran.
  const half = reduceFocusTimer(started.state, { kind: 'toggle' }, T0 + 600_000, 'desk');
  assert.equal(half.state.isRunning, false);
  assert.equal(half.state.accumulatedSeconds, 600);
  assert.equal(half.session, null);

  // Paused → running again, keeping the session it belongs to.
  const back = reduceFocusTimer(half.state, { kind: 'toggle' }, T0 + 900_000, 'desk');
  assert.equal(back.state.isRunning, true);
  assert.equal(back.state.sessionStartedAt, iso(T0), 'the same session, resumed');
  assert.equal(back.state.accumulatedSeconds, 600, 'nothing lost across the pause');

  // Never exceeds the planned length, whenever it is finally pressed.
  for (const late of [3600, 7200, 86_400, 7 * 86_400]) {
    const end = reduceFocusTimer(back.state, { kind: 'toggle' }, T0 + 900_000 + late * 1000, 'desk');
    if (end.session) {
      assert.ok(end.session.durationSeconds <= 3600,
        `pressed ${late}s late, the session is still at most its planned hour`);
    }
  }

  // A timer read off disk as junk does not crash the toggle.
  for (const junk of [null, undefined, 0, 'x', [], { isRunning: 'yes' }, { plannedSeconds: -1 }]) {
    const t = coerceFocusTimer(junk as unknown);
    const r = reduceFocusTimer(t, { kind: 'toggle' }, T0, 'desk');
    assert.ok(r.state, `${JSON.stringify(junk)} still yields a timer`);
    assert.ok(r.state.plannedSeconds > 0, 'with a sane planned length');
  }

  console.log('  Start, pause, resume and finish all behave');
}

// ─── 9. Reading a history collapses it ──────────────────────────────────────
{
  console.log('\n--- 9. EVERY READER GETS THE COLLAPSED HISTORY ---');

  const S = '2026-09-01T15:16:45.280Z';
  const raw = [
    { id: `auto-${S}-3600`, startedAt: S, endedAt: '2026-09-01T16:16:45.280Z', durationSeconds: 3600, plannedSeconds: 3600 },
    { id: `stop-${S}-2644`, startedAt: S, endedAt: '2026-09-01T16:00:49.280Z', durationSeconds: 2644, plannedSeconds: 3600 },
    { id: 'manual-2026-09-01-1', startedAt: '2026-09-01T01:00:00.000Z', endedAt: '2026-09-01T07:00:00.000Z', durationSeconds: 35700, plannedSeconds: 35700 },
    { id: 'manual-2026-09-01-2', startedAt: '2026-09-01T01:00:00.000Z', endedAt: '2026-09-01T07:00:00.000Z', durationSeconds: 33000, plannedSeconds: 33000 },
  ];

  // `safeFocusSessions` is the one door every reader uses -- the initial load,
  // the live stream, an import, the widget -- so collapsing there is what makes
  // an unrepaired database honest immediately.
  const read = safeFocusSessions(raw);
  assert.equal(read.length, 2, 'one session and one typed total');

  // Malformed rows are still rejected as they always were.
  assert.equal(safeFocusSessions([{ id: 'x' }, null, 7, { id: 'y', startedAt: 1 }]).length, 0);
  assert.deepEqual(safeFocusSessions('nope' as unknown), []);
  assert.deepEqual(safeFocusSessions(null), []);

  // A duration of zero or less is not a session.
  assert.equal(safeFocusSessions([
    { id: 'z', startedAt: S, endedAt: S, durationSeconds: 0, plannedSeconds: 0 },
  ]).length, 0);

  console.log('  The single read door collapses duplicates for everybody');
}

// ─── 10. A typed total replaces its day, up to the moment it was typed ──────
{
  console.log('\n--- 10. A CORRECTION MEANS "THAT DAY WAS NINE HOURS" ---');

  // The stamp inside a typed total's id is when the correction was made.
  const TYPED_AT = Date.parse('2026-09-04T07:38:55.414Z'); // Friday morning
  const typed = rec(
    `manual-2026-09-01-${TYPED_AT}-33000`,
    '2026-09-01T01:00:00.000Z', '2026-09-01T10:10:00.000Z', 33000,
  );

  // Sessions that were already on that Tuesday when it was corrected. The edit
  // was meant to delete these; the deletion was undone, so they must be
  // disregarded on read instead.
  const before1 = rec('session-2026-09-01T11:11:46.077Z',
    '2026-09-01T11:11:46.077Z', '2026-09-01T12:11:46.077Z', 3600);
  const before2 = rec('session-2026-09-01T15:16:45.280Z',
    '2026-09-01T15:16:45.280Z', '2026-09-01T16:00:49.280Z', 2644);

  const kept = applyTypedDayTotals([typed, before1, before2], 4);
  assert.deepEqual(kept.map(s => s.id), [typed.id],
    'the day is exactly what was typed, and the rows it replaced are gone');

  // A day with no correction is untouched, entirely.
  const otherDay = rec('session-2026-09-02T10:00:00.000Z',
    '2026-09-02T10:00:00.000Z', '2026-09-02T11:00:00.000Z', 3600);
  assert.deepEqual(
    applyTypedDayTotals([typed, otherDay], 4).map(s => s.id).sort(),
    [typed.id, otherDay.id].sort(),
    'a day nobody corrected keeps every session it has');

  // WORK DONE AFTER THE CORRECTION SURVIVES. Type a total at noon, work three
  // more hours, and the day is the total plus three hours -- anything else
  // would make a day uncorrectable for the rest of its life.
  const after = rec('session-after',
    iso(TYPED_AT + 3600_000), iso(TYPED_AT + 7200_000), 3600);
  const afterKey = focusDayKey(after.endedAt!, 4);
  const typedForAfterDay = rec(
    `manual-${afterKey}-${TYPED_AT}-1800`,
    iso(TYPED_AT - 7200_000), iso(TYPED_AT - 3600_000), 1800,
  );
  const withLater = applyTypedDayTotals([typedForAfterDay, after], 4);
  assert.equal(withLater.length, 2,
    'a session logged after the correction is work the correction could not know about');

  // And one logged a second BEFORE it is replaced.
  const justBefore = { ...after, id: 'session-just-before',
    startedAt: iso(TYPED_AT - 3600_000), endedAt: iso(TYPED_AT - 1000) };
  assert.equal(
    applyTypedDayTotals([typedForAfterDay, justBefore], 4).length, 1,
    'and one logged a second before it is not');

  // The LATEST correction is the one that counts, so an older stamp does not
  // resurrect anything.
  const older = rec(`manual-2026-09-01-${TYPED_AT - 86_400_000}-35700`,
    '2026-09-01T01:00:00.000Z', '2026-09-01T10:55:00.000Z', 35700);
  const both = applyTypedDayTotals([older, typed, before1], 4);
  assert.ok(!both.some(s => s.id === before1.id),
    'the newest correction decides the cutoff, not the oldest');

  // Every cutoff hour, because the day a session belongs to depends on it.
  for (const dsh of [0, 3, 4, 6, 12]) {
    const out = applyTypedDayTotals([typed, before1, before2], dsh);
    assert.ok(out.some(s => s.id === typed.id), `dayStart ${dsh}: the typed total survives`);
  }

  // Nothing to do is not an error.
  assert.deepEqual(applyTypedDayTotals([], 4), []);
  assert.deepEqual(applyTypedDayTotals([before1], 4).map(s => s.id), [before1.id],
    'with no corrections at all, the list is returned as it was');

  console.log('  A correction stands in for its day, and only up to when it was made');
}

// ─── 11. A running session is never worth more than it was planned for ──────
{
  console.log('\n--- 11. THE LIVE CLOCK CANNOT OUTRUN THE SESSION ---');

  const NIGHT = Date.parse('2026-09-03T21:30:00.000Z');
  const MORNING = Date.parse('2026-09-04T06:00:00.000Z'); // eight and a half hours later

  // A timer file with NO `updatedAt`, which is exactly what the old hotkey
  // route wrote on every press: it rebuilt the timer field by field and dropped
  // that field. With no witness at all, `focusSessionTruth` reaches for the
  // wall clock -- and the wall clock ran all night.
  const witnessless: FocusTimerState = {
    ...IDLE_FOCUS_TIMER,
    plannedSeconds: 3600,
    isRunning: true,
    lastStartedAt: iso(NIGHT),
    sessionStartedAt: iso(NIGHT),
    updatedAt: 0,
  };

  const truth = focusSessionTruth(witnessless, null, MORNING);
  assert.ok(truth.seconds <= 3600,
    'a session cannot be live-worth more than its planned length, whatever the clock says');
  assert.equal(truth.seconds, 3600, 'so it reads as its full hour, and no more');

  // The raw elapsed really is the whole night, which is what would have been
  // added to the day before the cap.
  const raw = Math.floor((MORNING - NIGHT) / 1000);
  assert.ok(raw > 8 * 3600, 'the uncapped reading really is over eight hours');

  // With a heartbeat, the exact truth is smaller still, and that still wins.
  const beat = {
    at: iso(NIGHT + 12 * 60 * 1000),
    sessionStartedAt: iso(NIGHT),
    elapsedSeconds: 720,
  };
  const withBeat = focusSessionTruth(witnessless, beat, MORNING);
  assert.equal(withBeat.seconds, 720, 'twelve minutes, because something saw twelve minutes');
  assert.equal(withBeat.ghost, true, 'and it is known to be a ghost');
  assert.equal(withBeat.endedAt, beat.at, 'ending when it was last seen');

  // A genuinely live session is untouched by the cap. "Live" means something
  // saw it RECENTLY -- a witness ten minutes old is a ghost, and correctly
  // reads as worth what it had run when last seen.
  const TEN_MIN = NIGHT + 10 * 60 * 1000;
  const live = focusSessionTruth(
    { ...witnessless, updatedAt: TEN_MIN - 5_000 }, null, TEN_MIN,
  );
  assert.equal(live.seconds, 600, 'ten minutes in and being watched, it is worth ten minutes');
  assert.equal(live.ghost, false, 'and is not a ghost');

  // The same timer with a witness that has gone quiet is a ghost worth what it
  // had run at that last sighting, which is the whole point of the mechanism.
  const abandoned = focusSessionTruth({ ...witnessless, updatedAt: NIGHT }, null, TEN_MIN);
  assert.equal(abandoned.ghost, true, 'a stale witness means nobody was watching');
  assert.equal(abandoned.seconds, 0, 'so it is worth what it had run when last seen');

  // And a paused timer reports what it banked, still capped.
  const paused = focusSessionTruth(
    { ...witnessless, isRunning: false, accumulatedSeconds: 99_999, lastStartedAt: null },
    null, MORNING,
  );
  assert.ok(paused.seconds <= 3600, 'a corrupt accumulated figure cannot exceed the session either');

  console.log('  Eight hours of wall clock reads as one planned hour, never more');
}

console.log('\nALL PASS (focus integrity: one session one row, one day one total)');
