// Tests the focus timer's state machine.
//
// THE ONE THAT MATTERS: the timer must survive the app being closed. Every
// other bug here is visible. That one is not: you start an hour, lock the
// phone, come back, and the number is simply wrong by however long Android
// decided to suspend the runtime. Nothing throws, nothing looks broken, and the
// day's total is quietly short. So most of what follows is the same question
// asked in different ways -- close the app, move the clock, cross a midnight,
// cross a daylight-saving change -- and the answer must always come from the
// stored start instant rather than from anything that was counting.
//
// The zone is pinned before anything else runs, because two of these cases are
// about what the local calendar does on the days a clock changes, and a suite
// that only passes in the timezone of the machine that wrote it is not evidence.
//
// Run with: npx tsx src/lib/focusTimer.test.ts

process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { focusDayKey, summariseFocus } from './focusStats';
import {
  DEFAULT_PLANNED_SECONDS,
  IDLE_FOCUS_TIMER,
  MAX_PLANNED_SECONDS,
  MIN_PLANNED_SECONDS,
  autoSessionId,
  checkpointFocusTimer,
  coerceFocusTimer,
  focusElapsedSeconds,
  focusIsOverdue,
  focusPhase,
  focusProgress,
  focusRemainingSeconds,
  focusSessionDay,
  focusUncreditedSeconds,
  formatFocusClock,
  formatFocusLength,
  hasFocusSession,
  mergeFocusTimers,
  reduceFocusTimer,
  stoppedSessionId,
  type FocusTimerState,
} from './focusTimer';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** A moment, in local wall-clock terms, as epoch ms. */
const local = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, m - 1, d, h, mi, s, 0).getTime();

const iso = (ms: number): string => new Date(ms).toISOString();

/** A running timer anchored at `startedMs`, with nothing banked yet. */
function running(startedMs: number, plannedSeconds = 3600): FocusTimerState {
  return {
    ...IDLE_FOCUS_TIMER,
    plannedSeconds,
    isRunning: true,
    lastStartedAt: iso(startedMs),
    sessionStartedAt: iso(startedMs),
    updatedAt: startedMs,
  };
}

function main() {
  console.log('--- 1. STORED STATE IS NEVER TRUSTED ---');
  {
    // Nothing at all, from a first run.
    for (const junk of [undefined, null, 0, '', 'running', [], NaN, true]) {
      assert.deepEqual(coerceFocusTimer(junk), IDLE_FOCUS_TIMER,
        `${String(junk)} reads as an idle timer`);
    }

    // An older build that never had `creditedSeconds`, `updatedAt` or `origin`.
    const old = coerceFocusTimer({
      plannedSeconds: 1500,
      accumulatedSeconds: 300,
      isRunning: false,
      lastStartedAt: null,
      sessionStartedAt: '2026-08-30T10:00:00.000Z',
    });
    assert.equal(old.plannedSeconds, 1500);
    assert.equal(old.accumulatedSeconds, 300);
    assert.equal(old.creditedSeconds, 0, 'a missing field is zero, not undefined');
    assert.equal(old.updatedAt, 0);
    assert.equal(old.origin, null);
    assert.equal(focusPhase(old), 'paused', 'and it is still a held session');

    // Half-written: it says it is running but the anchor never made it to disk.
    // There is no honest elapsed time for that, so it is not running -- the
    // alternative is a clock counting up from 1970.
    const torn = coerceFocusTimer({ isRunning: true, lastStartedAt: null, accumulatedSeconds: 90 });
    assert.equal(torn.isRunning, false, 'no anchor means not running');
    assert.equal(torn.accumulatedSeconds, 90, 'but the banked time is kept');
    assert.equal(focusElapsedSeconds(torn, local(2026, 8, 30, 12)), 90);

    // An anchor that is not a date at all.
    const bad = coerceFocusTimer({ isRunning: true, lastStartedAt: 'yesterday afternoon' });
    assert.equal(bad.isRunning, false);
    assert.equal(bad.lastStartedAt, null);

    // A stopped timer must not keep a stale anchor: resuming from one credits
    // hours nobody worked.
    const stale = coerceFocusTimer({ isRunning: false, lastStartedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(stale.lastStartedAt, null);

    // Numbers from a corrupted file.
    const wild = coerceFocusTimer({
      plannedSeconds: Infinity,
      accumulatedSeconds: -500,
      creditedSeconds: 1e308,
      updatedAt: 'soon',
    });
    assert.equal(wild.plannedSeconds, DEFAULT_PLANNED_SECONDS, 'Infinity is not a length');
    assert.equal(wild.accumulatedSeconds, 0, 'negative time is no time');
    assert.ok(Number.isFinite(wild.creditedSeconds), 'and nothing downstream sees Infinity');
    assert.equal(wild.updatedAt, 0);

    // Lengths are clamped rather than rejected, so a hand-edited file still
    // gives a usable timer.
    assert.equal(coerceFocusTimer({ plannedSeconds: 1 }).plannedSeconds, MIN_PLANNED_SECONDS);
    assert.equal(coerceFocusTimer({ plannedSeconds: 99 * HOUR }).plannedSeconds, MAX_PLANNED_SECONDS);
    assert.equal(coerceFocusTimer({ plannedSeconds: 0 }).plannedSeconds, DEFAULT_PLANNED_SECONDS);

    // Coercion is idempotent: reading back what we wrote changes nothing.
    const once = coerceFocusTimer(running(local(2026, 8, 30, 9)));
    assert.deepEqual(coerceFocusTimer(once), once);
  }

  console.log('--- 2. ELAPSED IS DERIVED FROM THE CLOCK, NEVER COUNTED ---');
  {
    const start = local(2026, 8, 30, 9);
    const t = running(start);

    assert.equal(focusElapsedSeconds(t, start), 0);
    assert.equal(focusElapsedSeconds(t, start + 30 * SEC), 30);
    assert.equal(focusElapsedSeconds(t, start + 25 * MIN), 25 * 60);
    assert.equal(focusRemainingSeconds(t, start + 25 * MIN), 35 * 60);
    assert.equal(focusProgress(t, start + 30 * MIN), 0.5);
    assert.equal(focusProgress(t, start + 5 * HOUR), 1, 'progress is clamped');

    // Sub-second remainders are floored, never rounded up, so the clock never
    // shows a second that has not fully passed.
    assert.equal(focusElapsedSeconds(t, start + 1999), 1);

    // A paused timer does not move, however long you leave it.
    const held = reduceFocusTimer(t, { kind: 'pause' }, start + 10 * MIN).state;
    assert.equal(focusElapsedSeconds(held, start + 10 * MIN), 600);
    assert.equal(focusElapsedSeconds(held, start + 9 * HOUR), 600, 'a pause is a pause');

    // An idle timer has nothing to report.
    assert.equal(focusElapsedSeconds(IDLE_FOCUS_TIMER, start), 0);
    assert.equal(focusProgress(IDLE_FOCUS_TIMER, start), 0);
    assert.equal(hasFocusSession(IDLE_FOCUS_TIMER), false);
  }

  console.log('--- 3. START, AND STARTING TWICE ---');
  {
    const t0 = local(2026, 8, 30, 9);
    const first = reduceFocusTimer(IDLE_FOCUS_TIMER, { kind: 'start' }, t0, 'phone');
    assert.equal(first.changed, true);
    assert.equal(first.session, null, 'starting logs nothing');
    assert.equal(focusPhase(first.state), 'running');
    assert.equal(first.state.sessionStartedAt, iso(t0));
    assert.equal(first.state.lastStartedAt, iso(t0));
    assert.equal(first.state.origin, 'phone');

    // A double tap, or the button racing a tick. Re-anchoring here would throw
    // away everything since the last checkpoint.
    const again = reduceFocusTimer(first.state, { kind: 'start' }, t0 + 5 * MIN, 'phone');
    assert.equal(again.changed, false, 'starting a running timer does nothing');
    assert.equal(again.state.lastStartedAt, iso(t0), 'and the anchor is untouched');
    assert.equal(focusElapsedSeconds(again.state, t0 + 5 * MIN), 300);

    // The planned length survives a session ending.
    const sized = reduceFocusTimer(IDLE_FOCUS_TIMER, { kind: 'setPlanned', seconds: 25 * 60 }, t0);
    assert.equal(sized.state.plannedSeconds, 1500);
    const ran = reduceFocusTimer(sized.state, { kind: 'start' }, t0).state;
    const done = reduceFocusTimer(ran, { kind: 'stop' }, t0 + 20 * MIN).state;
    assert.equal(done.plannedSeconds, 1500, 'the length you chose is still there');

    // Lengths are clamped, and a no-change is a no-op.
    assert.equal(reduceFocusTimer(sized.state, { kind: 'setPlanned', seconds: 5 }, t0).state.plannedSeconds, MIN_PLANNED_SECONDS);
    assert.equal(reduceFocusTimer(sized.state, { kind: 'setPlanned', seconds: 1500 }, t0).changed, false);
    assert.equal(reduceFocusTimer(sized.state, { kind: 'setPlanned', seconds: NaN }, t0).state.plannedSeconds, 1500);

    // Changing the length mid-session keeps the time already run.
    const midway = reduceFocusTimer(ran, { kind: 'setPlanned', seconds: 45 * 60 }, t0 + 10 * MIN).state;
    assert.equal(focusElapsedSeconds(midway, t0 + 10 * MIN), 600);
    assert.equal(focusRemainingSeconds(midway, t0 + 10 * MIN), 35 * 60);
  }

  console.log('--- 4. PAUSE, PAUSING TWICE, AND RESUMING WHAT WAS NEVER PAUSED ---');
  {
    const t0 = local(2026, 8, 30, 9);
    const live = running(t0);

    const paused = reduceFocusTimer(live, { kind: 'pause' }, t0 + 10 * MIN);
    assert.equal(paused.changed, true);
    assert.equal(focusPhase(paused.state), 'paused');
    assert.equal(paused.state.accumulatedSeconds, 600, 'every second run is kept');
    assert.equal(paused.state.lastStartedAt, null);
    assert.equal(paused.state.lastPausedAt, iso(t0 + 10 * MIN));

    // Pausing again did not stop anything, so it must not look like a second
    // event: the state, including the first pause's stamp, is untouched.
    const twice = reduceFocusTimer(paused.state, { kind: 'pause' }, t0 + 20 * MIN);
    assert.equal(twice.changed, false, 'the second pause is a no-op');
    assert.deepEqual(twice.state, paused.state);

    // Resume, run some more, and the two stretches add up.
    const resumed = reduceFocusTimer(paused.state, { kind: 'resume' }, t0 + 30 * MIN);
    assert.equal(resumed.changed, true);
    assert.equal(focusPhase(resumed.state), 'running');
    assert.equal(resumed.state.sessionStartedAt, iso(t0), 'still the same session');
    assert.equal(resumed.state.lastPausedAt, null);
    assert.equal(focusElapsedSeconds(resumed.state, t0 + 35 * MIN), 900,
      'ten minutes banked plus five more');

    // Resuming something that was never paused: the user wants it running and
    // it is running. Not an error, and above all not a re-anchor.
    const noop = reduceFocusTimer(resumed.state, { kind: 'resume' }, t0 + 40 * MIN);
    assert.equal(noop.changed, false);
    assert.equal(focusElapsedSeconds(noop.state, t0 + 40 * MIN), 1200);

    // Resuming when there is no session at all does nothing either.
    assert.equal(reduceFocusTimer(IDLE_FOCUS_TIMER, { kind: 'resume' }, t0).changed, false);

    // Many pause/resume cycles must not drift. Ten minutes on, ten minutes off,
    // five times over: fifty minutes of work in a hundred minutes of wall time.
    let s: FocusTimerState = running(t0);
    let clock = t0;
    for (let i = 0; i < 5; i += 1) {
      clock += 10 * MIN;
      s = reduceFocusTimer(s, { kind: 'pause' }, clock).state;
      clock += 10 * MIN;
      s = reduceFocusTimer(s, { kind: 'resume' }, clock).state;
    }
    assert.equal(focusElapsedSeconds(s, clock), 50 * 60, 'no second gained or lost');

    // A checkpoint changes the books but never the total, and never the stamp
    // that decides who wins a merge.
    const mid = running(t0);
    const checked = checkpointFocusTimer(mid, t0 + 90 * SEC + 400);
    assert.equal(checked.accumulatedSeconds, 90);
    assert.equal(focusElapsedSeconds(checked, t0 + 90 * SEC + 400), 90);
    assert.equal(focusElapsedSeconds(checked, t0 + 10 * MIN), 600,
      'the anchor moved by exactly the seconds banked, so nothing is lost');
    const cp = reduceFocusTimer(mid, { kind: 'checkpoint' }, t0 + 90 * SEC + 400);
    assert.equal(cp.state.updatedAt, mid.updatedAt, 'a checkpoint is not a new write');

    // Checkpointing repeatedly, as the app does every few seconds, must not
    // shave the sub-second remainder off each time.
    let drift: FocusTimerState = running(t0);
    for (let i = 1; i <= 600; i += 1) drift = checkpointFocusTimer(drift, t0 + i * 1400);
    assert.equal(focusElapsedSeconds(drift, t0 + 600 * 1400), Math.floor(600 * 1.4),
      'ten minutes of half-second remainders are still there');
  }

  console.log('--- 5. STOPPING: IDLE, EMPTY, AND ORDINARY ---');
  {
    const t0 = local(2026, 8, 30, 9);

    // Stopping an idle timer is a no-op, not a reset: answering with a cleared
    // state would overwrite whatever the PC is doing for no reason at all.
    const nothing = reduceFocusTimer(IDLE_FOCUS_TIMER, { kind: 'stop' }, t0);
    assert.equal(nothing.changed, false);
    assert.equal(nothing.session, null);
    assert.deepEqual(nothing.state, IDLE_FOCUS_TIMER);
    assert.equal(reduceFocusTimer(undefined, { kind: 'stop' }, t0).session, null);

    // Started and stopped in the same instant: a mis-tap. The session is
    // cleared and nothing is written down.
    const started = reduceFocusTimer(IDLE_FOCUS_TIMER, { kind: 'start' }, t0).state;
    const zero = reduceFocusTimer(started, { kind: 'stop' }, t0);
    assert.equal(zero.changed, true, 'the timer did clear');
    assert.equal(zero.session, null, 'but a zero-length session is not a session');
    assert.equal(focusPhase(zero.state), 'idle');

    // Under a second is still zero.
    assert.equal(reduceFocusTimer(started, { kind: 'stop' }, t0 + 800).session, null);

    // One second is a session, however silly. The history filters short ones
    // out of its totals; the timer's job is to record what happened.
    const oneSecond = reduceFocusTimer(started, { kind: 'stop' }, t0 + SEC).session;
    assert.equal(oneSecond?.durationSeconds, 1);

    // The ordinary case.
    const out = reduceFocusTimer(running(t0), { kind: 'stop' }, t0 + 42 * MIN);
    assert.ok(out.session, 'a stopped session is written down');
    assert.equal(out.session!.durationSeconds, 42 * 60);
    assert.equal(out.session!.startedAt, iso(t0));
    assert.equal(out.session!.endedAt, iso(t0 + 42 * MIN));
    assert.equal(out.session!.plannedSeconds, 3600);
    assert.equal(out.session!.id, stoppedSessionId(iso(t0), 42 * 60));
    assert.equal(focusPhase(out.state), 'idle');
    assert.equal(out.state.creditedSeconds, 0, 'and the next session starts clean');

    // The id is deterministic, so two devices stopping the same session at the
    // same second collapse into one record rather than counting it twice.
    const twin = reduceFocusTimer(running(t0), { kind: 'stop' }, t0 + 42 * MIN);
    assert.equal(twin.session!.id, out.session!.id);

    // A caller may supply its own id (the salvage path does).
    assert.equal(reduceFocusTimer(running(t0), { kind: 'stop', id: 'given' }, t0 + MIN).session!.id, 'given');

    // Stopping a paused session logs what it ran, ending now.
    const parked = reduceFocusTimer(running(t0), { kind: 'pause' }, t0 + 15 * MIN).state;
    const late = reduceFocusTimer(parked, { kind: 'stop' }, t0 + 3 * HOUR);
    assert.equal(late.session!.durationSeconds, 15 * 60, 'the pause did not count');

    // Discarding throws the session away and writes nothing.
    const dropped = reduceFocusTimer(running(t0), { kind: 'discard' }, t0 + 20 * MIN);
    assert.equal(dropped.changed, true);
    assert.equal(dropped.session, null);
    assert.equal(focusPhase(dropped.state), 'idle');
    assert.equal(reduceFocusTimer(IDLE_FOCUS_TIMER, { kind: 'discard' }, t0).changed, false);
  }

  console.log('--- 6. THE APP WAS CLOSED FOR HOURS ---');
  {
    // An hour was started at ten in the morning. The phone was locked, Android
    // suspended the app, and it is opened again at four. The session finished at
    // eleven -- not at four, and not "an hour from now".
    const start = local(2026, 8, 30, 10);
    const live = running(start, 3600);
    const reopened = start + 6 * HOUR;

    assert.equal(focusIsOverdue(live, reopened), true);
    const settled = reduceFocusTimer(live, { kind: 'settle' }, reopened);
    assert.ok(settled.session);
    assert.equal(settled.session!.endedAt, iso(start + HOUR), 'it ended when it ran out');
    assert.equal(settled.session!.startedAt, iso(start));
    assert.equal(settled.session!.durationSeconds, 3600, 'and it ran exactly its hour');
    assert.equal(settled.session!.id, autoSessionId(iso(start), 3600),
      'the PC would give the same session the same id');
    assert.equal(focusPhase(settled.state), 'idle');

    // Settling repeatedly is harmless, which is what lets it run on every tick.
    assert.equal(reduceFocusTimer(settled.state, { kind: 'settle' }, reopened).changed, false);
    assert.equal(reduceFocusTimer(live, { kind: 'settle' }, start + 30 * MIN).changed, false,
      'a session still inside its length is left alone');

    // Reopened before it ran out: still going, with the right total.
    assert.equal(focusElapsedSeconds(live, start + 40 * MIN), 40 * 60);

    // Stopping by hand on the way back in must not log six hours. The stop
    // routes through the same completion, so it logs the hour it really ran.
    const stoppedLate = reduceFocusTimer(live, { kind: 'stop' }, reopened);
    assert.equal(stoppedLate.session!.durationSeconds, 3600);
    assert.equal(stoppedLate.session!.endedAt, iso(start + HOUR));

    // Closed across a pause: a session paused with time banked, resumed days
    // later, still knows what it had.
    const held = reduceFocusTimer(live, { kind: 'pause' }, start + 12 * MIN).state;
    const revived = reduceFocusTimer(held, { kind: 'resume' }, start + 3 * 24 * HOUR).state;
    assert.equal(focusElapsedSeconds(revived, start + 3 * 24 * HOUR + 8 * MIN), 20 * 60);

    // A session that overran while paused-then-resumed completes at the moment
    // the remaining time ran out, not at the resume.
    const resumedLate = reduceFocusTimer(held, { kind: 'resume' }, start + 5 * HOUR).state;
    const finished = reduceFocusTimer(resumedLate, { kind: 'settle' }, start + 9 * HOUR);
    assert.equal(finished.session!.endedAt, iso(start + 5 * HOUR + 48 * MIN),
      'twelve minutes were already banked, so forty-eight remained');
    assert.equal(finished.session!.durationSeconds, 3600);
  }

  console.log('--- 7. WHICH DAY THE SESSION LANDS ON ---');
  {
    // Across midnight. Started at twenty to twelve, ran forty minutes.
    const start = local(2026, 8, 30, 23, 40);
    const out = reduceFocusTimer(running(start, 40 * 60), { kind: 'settle' }, start + 2 * HOUR);
    assert.equal(out.session!.durationSeconds, 40 * 60);
    assert.equal(out.session!.endedAt, iso(local(2026, 8, 31, 0, 20)));

    // With a plain calendar day, it belongs to the 31st: it ended there.
    assert.equal(focusSessionDay(out.session!, 0), '2026-08-31');
    // With a day that starts at three in the morning, it is still the 30th --
    // which is how it felt, and how the PC credits it.
    assert.equal(focusSessionDay(out.session!, 3), '2026-08-30');
    // And the shared rule is the one being used, not a copy of it.
    assert.equal(focusSessionDay(out.session!, 3), focusDayKey(out.session!.endedAt!, 3));

    // Right on the boundary: a session that ends at exactly 03:00:00 belongs to
    // the new day, and one ending a second earlier to the old one.
    const onIt = reduceFocusTimer(running(local(2026, 8, 31, 2, 30), 30 * 60), { kind: 'settle' }, local(2026, 8, 31, 6));
    assert.equal(onIt.session!.endedAt, iso(local(2026, 8, 31, 3)));
    assert.equal(focusSessionDay(onIt.session!, 3), '2026-08-31');
    const justBefore = reduceFocusTimer(running(local(2026, 8, 31, 2, 30), 29 * 60 + 59), { kind: 'settle' }, local(2026, 8, 31, 6));
    assert.equal(focusSessionDay(justBefore.session!, 3), '2026-08-30');

    // The history agrees with the timer. One session, put through the same
    // maths the screen uses, lands on the day the timer said.
    const summary = summariseFocus([out.session!], { from: '2026-08-29', to: '2026-08-31', dayStartHour: 3 });
    assert.equal(summary.days.find(d => d.date === '2026-08-30')!.seconds, 40 * 60);
    assert.equal(summary.days.find(d => d.date === '2026-08-31')!.seconds, 0);

    // A session that STARTS before the boundary and ENDS after it counts on the
    // day it was finished, which is the rule the PC uses and a person remembers.
    const overnight = reduceFocusTimer(running(local(2026, 8, 31, 2, 45), 60 * 60), { kind: 'settle' }, local(2026, 8, 31, 9));
    assert.equal(focusSessionDay(overnight.session!, 3), '2026-08-31');
  }

  console.log('--- 8. A CLOCK THAT JUMPS ---');
  {
    const start = local(2026, 8, 30, 9);
    const live = running(start);

    // Backwards. A network time correction, or somebody changing the zone by
    // hand. Time already run is never taken away, and the clock stands still
    // until it catches up rather than showing a negative number.
    assert.equal(focusElapsedSeconds(live, start - 10 * MIN), 0);
    assert.equal(focusRemainingSeconds(live, start - 10 * MIN), 3600);
    assert.equal(focusProgress(live, start - HOUR), 0);
    assert.equal(focusIsOverdue(live, start - HOUR), false);

    // A backwards jump after some real work keeps what was banked.
    const banked = reduceFocusTimer(live, { kind: 'pause' }, start + 20 * MIN).state;
    const back = reduceFocusTimer(banked, { kind: 'resume' }, start + 20 * MIN).state;
    assert.equal(focusElapsedSeconds(back, start), 20 * 60, 'the twenty minutes survive');
    // And checkpointing during the backwards window does not rewind the anchor.
    assert.deepEqual(checkpointFocusTimer(back, start + 10 * MIN), back);

    // Stopping while the clock is behind logs what was banked, not a negative.
    const stopped = reduceFocusTimer(back, { kind: 'stop' }, start + 5 * MIN);
    assert.equal(stopped.session!.durationSeconds, 20 * 60);

    // Forwards. The clock corrected itself an hour ahead mid-session; the
    // session is over, and it is credited its planned length rather than the
    // hour and a half the arithmetic would otherwise claim.
    const jumped = reduceFocusTimer(running(start, 30 * 60), { kind: 'settle' }, start + 90 * MIN);
    assert.equal(jumped.session!.durationSeconds, 30 * 60, 'never more than was planned');
    assert.equal(jumped.session!.endedAt, iso(start + 30 * MIN));

    // A forwards jump on a session with no planned end in sight still cannot
    // report a completion in the future.
    const far = reduceFocusTimer(running(start, MAX_PLANNED_SECONDS), { kind: 'settle' }, start + 2 * HOUR);
    assert.equal(far.changed, false, 'it has not finished yet, however far the clock moved');
  }

  console.log('--- 9. VERY LONG SESSIONS ---');
  {
    const start = local(2026, 8, 28, 9);

    // A session left paused for days and then stopped. Nothing caps a paused
    // total, because those seconds were genuinely run.
    let s: FocusTimerState = running(start, 6 * HOUR / SEC);
    s = reduceFocusTimer(s, { kind: 'pause' }, start + 3 * HOUR).state;
    const out = reduceFocusTimer(s, { kind: 'stop' }, start + 4 * 24 * HOUR);
    assert.equal(out.session!.durationSeconds, 3 * 3600);
    assert.equal(focusSessionDay(out.session!, 0), '2026-09-01', 'stopped on the day it was stopped');

    // A session left RUNNING for days is capped at its planned length and
    // credited to the day it would have finished on, four days ago.
    const runaway = reduceFocusTimer(running(start, 2 * 3600), { kind: 'settle' }, start + 4 * 24 * HOUR);
    assert.equal(runaway.session!.durationSeconds, 2 * 3600);
    assert.equal(runaway.session!.endedAt, iso(start + 2 * HOUR));
    assert.equal(focusSessionDay(runaway.session!, 0), '2026-08-28');

    // The longest planned session the app allows still behaves.
    const longest = reduceFocusTimer(running(start, MAX_PLANNED_SECONDS), { kind: 'settle' }, start + 13 * HOUR);
    assert.equal(longest.session!.durationSeconds, MAX_PLANNED_SECONDS);
    assert.equal(longest.session!.endedAt, iso(start + 12 * HOUR));

    // Absurd stored totals are clamped rather than allowed to become Infinity.
    const absurd = coerceFocusTimer({ accumulatedSeconds: 1e12 });
    assert.ok(Number.isFinite(focusElapsedSeconds(absurd, start)));
  }

  console.log('--- 10. DAYLIGHT SAVING, BOTH DIRECTIONS ---');
  {
    // Spring forward: at 02:00 local on 8 March 2026 the clocks jump to 03:00.
    // A session started at 01:30 and run for one real hour ends at 03:30 by the
    // wall clock. It ran an hour, and it must be logged as an hour -- elapsed is
    // epoch arithmetic, so the missing hour on the wall never enters into it.
    const spring = local(2026, 3, 8, 1, 30);
    assert.equal(new Date(spring + HOUR).getHours(), 3, 'the wall clock skipped an hour');
    const sprung = reduceFocusTimer(running(spring, 3600), { kind: 'settle' }, spring + 5 * HOUR);
    assert.equal(sprung.session!.durationSeconds, 3600);
    assert.equal(new Date(sprung.session!.endedAt!).getHours(), 3);
    assert.equal(focusSessionDay(sprung.session!, 0), '2026-03-08');
    assert.equal(focusSessionDay(sprung.session!, 3), '2026-03-08',
      'and 03:30 is past a 3am day start even on the day an hour vanished');

    // Fall back: at 02:00 local on 1 November 2026 the clocks go back to 01:00,
    // so 01:30 happens twice. A one hour session starting at the first 01:30
    // ends at the second one. Still an hour, still that day.
    // Named as an absolute instant, because "01:30 local" is genuinely
    // ambiguous that morning and a local constructor has to pick one.
    const autumn = Date.parse('2026-11-01T05:30:00.000Z'); // the first of the two 01:30s
    assert.equal(new Date(autumn).getHours(), 1);
    assert.equal(new Date(autumn + HOUR).getHours(), 1, 'the wall clock repeated an hour');
    const fell = reduceFocusTimer(running(autumn, 3600), { kind: 'settle' }, autumn + 6 * HOUR);
    assert.equal(fell.session!.durationSeconds, 3600);
    assert.equal(focusSessionDay(fell.session!, 0), '2026-11-01');
    // With a 3am day start, an hour that ends at 01:30 belongs to the day before.
    assert.equal(focusSessionDay(fell.session!, 3), '2026-10-31');

    // A session running straight through the spring-forward boundary from the
    // day before still crosses exactly one calendar day.
    const eve = local(2026, 3, 7, 23, 30);
    const crossed = reduceFocusTimer(running(eve, 4 * 3600), { kind: 'settle' }, eve + 9 * HOUR);
    assert.equal(crossed.session!.durationSeconds, 4 * 3600);
    assert.equal(focusSessionDay(crossed.session!, 0), '2026-03-08');

    // Pause and resume across a transition: the banked time is unaffected.
    let s: FocusTimerState = running(spring - 30 * MIN, 4 * 3600);
    s = reduceFocusTimer(s, { kind: 'pause' }, spring).state;
    s = reduceFocusTimer(s, { kind: 'resume' }, spring + 2 * HOUR).state;
    assert.equal(focusElapsedSeconds(s, spring + 3 * HOUR), 30 * 60 + 60 * 60);
  }

  console.log('--- 11. THE CREDITED-SECONDS RULE ---');
  {
    // Editing a day's total while a session runs banks the elapsed time so far.
    // The countdown must not flinch, and the seconds already written into the
    // day must not be written again when the session ends.
    const start = local(2026, 8, 30, 9);
    const live = running(start, 3600);

    const credited = reduceFocusTimer(live, { kind: 'credit', seconds: 10 * 60 }, start + 10 * MIN);
    assert.equal(credited.state.creditedSeconds, 600);
    assert.equal(focusElapsedSeconds(credited.state, start + 10 * MIN), 600,
      'the session itself is untouched');
    assert.equal(focusRemainingSeconds(credited.state, start + 10 * MIN), 50 * 60,
      'and so is the countdown');
    assert.equal(focusUncreditedSeconds(credited.state, start + 10 * MIN), 0,
      'but the day is owed nothing right now');
    assert.equal(focusUncreditedSeconds(credited.state, start + 25 * MIN), 15 * 60,
      'only the time run since the edit');

    // Stopping logs the tail only, and the record starts where the tail did.
    const out = reduceFocusTimer(credited.state, { kind: 'stop' }, start + 30 * MIN);
    assert.equal(out.session!.durationSeconds, 20 * 60, 'the banked ten minutes are not logged twice');
    assert.equal(out.session!.endedAt, iso(start + 30 * MIN));
    assert.equal(out.session!.startedAt, iso(start + 10 * MIN), 'the tail, not the whole session');
    assert.equal(out.state.creditedSeconds, 0, 'and the next session starts clean');

    // Auto-completion obeys the same rule.
    const auto = reduceFocusTimer(credited.state, { kind: 'settle' }, start + 3 * HOUR);
    assert.equal(auto.session!.durationSeconds, 3600 - 600);

    // Crediting the whole session leaves nothing to log at all.
    const all = reduceFocusTimer(live, { kind: 'credit', seconds: 30 * 60 }, start + 30 * MIN);
    assert.equal(reduceFocusTimer(all.state, { kind: 'stop' }, start + 30 * MIN).session, null);

    // You cannot bank more than has been run, or the day ends up owed a
    // negative amount.
    const greedy = reduceFocusTimer(live, { kind: 'credit', seconds: 99 * 3600 }, start + 5 * MIN);
    assert.equal(greedy.state.creditedSeconds, 300);
    assert.equal(reduceFocusTimer(live, { kind: 'credit', seconds: -5 }, start + 5 * MIN).state.creditedSeconds, 0);
    assert.equal(reduceFocusTimer(live, { kind: 'credit', seconds: 0 }, start + 5 * MIN).changed, false);
  }

  console.log('--- 12. TWO DEVICES ---');
  {
    const t0 = local(2026, 8, 30, 9);

    // The same session, seen twice. The newer write wins, and nothing is
    // salvaged because nothing was lost.
    const early = { ...running(t0), updatedAt: t0, origin: 'pc' };
    const later = reduceFocusTimer(early, { kind: 'pause' }, t0 + 10 * MIN, 'pc').state;
    const caught = mergeFocusTimers(early, later, t0 + 11 * MIN);
    assert.deepEqual(caught.state, later, 'the pause is the newer word');
    assert.equal(caught.salvaged, null);
    assert.equal(caught.conflict, false);
    assert.deepEqual(mergeFocusTimers(later, early, t0 + 11 * MIN).state, later, 'and either way round');

    // A session against nothing. A stop made AFTER the other side's last write
    // must not be undone by that side's stale "still running" view -- that is
    // how a finished session comes back to life and gets logged twice.
    const stopped = reduceFocusTimer(early, { kind: 'stop' }, t0 + 20 * MIN, 'pc').state;
    const afterStop = mergeFocusTimers(early, stopped, t0 + 21 * MIN);
    assert.equal(focusPhase(afterStop.state), 'idle', 'the stop stands');
    assert.equal(afterStop.salvaged, null, 'and the stopping device already logged it');

    // The other way round: a session started after the other side went idle
    // beats the idle state.
    const idleOld = { ...IDLE_FOCUS_TIMER, updatedAt: t0 - HOUR };
    const freshRun = { ...running(t0), updatedAt: t0 };
    assert.equal(focusPhase(mergeFocusTimers(idleOld, freshRun, t0 + MIN).state), 'running');
    assert.equal(focusPhase(mergeFocusTimers(freshRun, idleOld, t0 + MIN).state), 'running');

    // Both idle: the newer planned length is the one that survives.
    const idleA = { ...IDLE_FOCUS_TIMER, plannedSeconds: 1500, updatedAt: t0 };
    const idleB = { ...IDLE_FOCUS_TIMER, plannedSeconds: 3600, updatedAt: t0 + MIN };
    assert.equal(mergeFocusTimers(idleA, idleB, t0 + 2 * MIN).state.plannedSeconds, 3600);
    assert.equal(mergeFocusTimers(idleB, idleA, t0 + 2 * MIN).state.plannedSeconds, 3600);

    // TWO INDEPENDENT SESSIONS. The desk was left running at nine; the phone
    // started its own at eleven. The one the user is sitting in front of wins,
    // and the abandoned one is handed back as a finished record rather than
    // being thrown away.
    const desk = { ...running(t0, 3600), updatedAt: t0 + 5 * MIN, origin: 'pc' };
    const phone = { ...running(t0 + 2 * HOUR, 1500), updatedAt: t0 + 2 * HOUR, origin: 'phone' };
    const clash = mergeFocusTimers(phone, desk, t0 + 2 * HOUR + MIN);
    assert.equal(clash.conflict, true);
    assert.equal(clash.state.sessionStartedAt, iso(t0 + 2 * HOUR), 'the newest start wins');
    assert.ok(clash.salvaged, 'and the older one is not simply lost');
    assert.equal(clash.salvaged!.durationSeconds, 5 * 60,
      'credited with what it was last known to have run, not with the two hours nobody watched');
    assert.equal(clash.salvaged!.endedAt, iso(t0 + 5 * MIN));

    // Symmetric: both devices reach the same conclusion, which is the only way
    // they ever converge.
    const other = mergeFocusTimers(desk, phone, t0 + 2 * HOUR + MIN);
    assert.deepEqual(other.state, clash.state);
    assert.deepEqual(other.salvaged, clash.salvaged);

    // A collided session too short to be worth a record is dropped silently.
    const blip = { ...running(t0 + 3 * HOUR), updatedAt: t0 + 3 * HOUR };
    const withBlip = mergeFocusTimers({ ...running(t0 + 4 * HOUR), updatedAt: t0 + 4 * HOUR }, blip, t0 + 5 * HOUR);
    assert.equal(withBlip.conflict, true);
    assert.equal(withBlip.salvaged, null);

    // Merging garbage from a device running an older build never throws and
    // never invents a session.
    for (const junk of [null, undefined, 'nope', 42, { isRunning: true }]) {
      const m = mergeFocusTimers(junk, phone, t0 + 2 * HOUR);
      assert.equal(m.state.sessionStartedAt, phone.sessionStartedAt);
      assert.equal(mergeFocusTimers(junk, junk, t0).state.plannedSeconds, DEFAULT_PLANNED_SECONDS);
    }

    // Merging a state with itself is always the identity, whatever it holds.
    for (const s of [IDLE_FOCUS_TIMER, early, later, stopped, phone]) {
      const m = mergeFocusTimers(s, s, t0 + 3 * HOUR);
      assert.deepEqual(m.state, coerceFocusTimer(s));
      assert.equal(m.conflict, false);
      assert.equal(m.salvaged, null);
    }

    // Merging is stable: doing it again with the result changes nothing.
    const once = mergeFocusTimers(phone, desk, t0 + 2 * HOUR + MIN);
    const twice = mergeFocusTimers(once.state, desk, t0 + 2 * HOUR + 2 * MIN);
    assert.deepEqual(twice.state, once.state);
  }

  console.log('--- 13. THE CLOCK ON SCREEN ---');
  {
    assert.equal(formatFocusClock(0), '00:00');
    assert.equal(formatFocusClock(9), '00:09');
    assert.equal(formatFocusClock(59), '00:59');
    assert.equal(formatFocusClock(60), '01:00');
    assert.equal(formatFocusClock(1500), '25:00');
    assert.equal(formatFocusClock(3599), '59:59');
    assert.equal(formatFocusClock(3600), '1:00:00');
    assert.equal(formatFocusClock(3849), '1:04:09');
    assert.equal(formatFocusClock(-5), '00:00', 'never a negative clock');
    assert.equal(formatFocusClock(NaN), '00:00');

    // The string only ever grows at the front, so a fixed layout can hold the
    // digits still instead of shuffling them every second.
    for (let s = 0; s < 3600; s += 7) assert.equal(formatFocusClock(s).length, 5);
    for (let s = 3600; s < 36000; s += 601) assert.equal(formatFocusClock(s).length, 7);

    assert.equal(formatFocusLength(0), 'None');
    assert.equal(formatFocusLength(45 * 60), '45m');
    assert.equal(formatFocusLength(3600), '1h');
    assert.equal(formatFocusLength(5400), '1h 30m');
    assert.equal(formatFocusLength(-1), 'None');
  }

  console.log('--- 14. NOTHING HERE READS THE WALL CLOCK ---');
  {
    // The whole module is a function of (state, action, now). If any of it
    // reached for the real clock, none of the cases above would mean anything --
    // so the real clock is taken away and the ordinary path is walked again.
    const realNow = Date.now;
    Date.now = () => { throw new Error('focusTimer must never read the wall clock'); };
    try {
      const t0 = local(2026, 8, 30, 9);
      let s: FocusTimerState = coerceFocusTimer({ plannedSeconds: 1500 });
      s = reduceFocusTimer(s, { kind: 'start' }, t0, 'phone').state;
      s = checkpointFocusTimer(s, t0 + 3 * MIN);
      s = reduceFocusTimer(s, { kind: 'pause' }, t0 + 5 * MIN).state;
      s = reduceFocusTimer(s, { kind: 'resume' }, t0 + 6 * MIN).state;
      const done = reduceFocusTimer(s, { kind: 'settle' }, t0 + 2 * HOUR);
      assert.equal(done.session!.durationSeconds, 1500);
      mergeFocusTimers(s, done.state, t0 + 2 * HOUR);
      focusSessionDay(done.session!, 3);
      formatFocusClock(focusRemainingSeconds(s, t0 + 7 * MIN));
    } finally {
      Date.now = realNow;
    }

    // And the same inputs always give the same answer, byte for byte.
    const a = reduceFocusTimer(running(local(2026, 8, 30, 9)), { kind: 'stop' }, local(2026, 8, 30, 9) + 17 * MIN);
    const b = reduceFocusTimer(running(local(2026, 8, 30, 9)), { kind: 'stop' }, local(2026, 8, 30, 9) + 17 * MIN);
    assert.deepEqual(a, b);
  }

  console.log('\nALL PASS (focusTimer: derived elapsed, closed app, day boundaries, DST, credit, two devices)');
}

main();
