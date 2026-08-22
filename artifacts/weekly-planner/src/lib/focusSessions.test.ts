import {
  parseDurationInput,
  formatFocusDuration,
  formatDetailedDuration,
  formatCountdown,
  createManualFocusSession,
  focusDayKey,
  sumFocusSecondsForDay,
  coerceFocusTimer,
  getFocusTimerElapsedSeconds,
  getFocusTimerUncreditedSeconds,
  loggableSessionSeconds,
  focusTimerPushKey,
  focusTimerIdentity,
  focusTimerTransitionKey,
  focusCueKey,
  isFocusCueFresh,
  checkpointFocusTimer,
  pauseFocusTimer,
  focusRecoveryFor,
  safeFocusHeartbeat,
  recoveredSessionId,
  autoSessionId,
  isCompletedFocusSession,
  dedupeFocusSessions,
  safeFocusSessions,
  safeFocusExcludedDates,
  coerceFocusChime,
  coerceFocusCue,
  DEFAULT_FOCUS_TIMER,
  FOCUS_HEARTBEAT_STALE_MS,
  MIN_COMPLETED_SESSION_SECONDS,
  type FocusTimerState,
  type FocusHeartbeat,
  type FocusSession,
} from './focusSessions';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`Assertion failed for ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log('--- 1. PARSE DURATION INPUT & FORMATTING ---');

// Empty and clear inputs
assertEqual(parseDurationInput(''), 0, 'empty string');
assertEqual(parseDurationInput('0'), 0, '0');
assertEqual(parseDurationInput('0m'), 0, '0m');
assertEqual(parseDurationInput('0h'), 0, '0h');
assertEqual(parseDurationInput('—'), 0, 'em dash');
assertEqual(parseDurationInput('-'), 0, 'hyphen');
assertEqual(parseDurationInput('none'), 0, 'none');
assertEqual(parseDurationInput('clear'), 0, 'clear');

// Standard formatted inputs
assertEqual(parseDurationInput('6h 27m'), 6 * 3600 + 27 * 60, '6h 27m');
assertEqual(parseDurationInput('6h27m'), 6 * 3600 + 27 * 60, '6h27m');
assertEqual(parseDurationInput('6h27'), 6 * 3600 + 27 * 60, '6h27');
assertEqual(parseDurationInput('6h 27'), 6 * 3600 + 27 * 60, '6h 27');
assertEqual(parseDurationInput('6 hours 27 mins'), 6 * 3600 + 27 * 60, '6 hours 27 mins');
assertEqual(parseDurationInput('2 hr 15'), 2 * 3600 + 15 * 60, '2 hr 15');
assertEqual(parseDurationInput('1h'), 3600, '1h');
assertEqual(parseDurationInput('45m'), 45 * 60, '45m');
assertEqual(parseDurationInput('45 mins'), 45 * 60, '45 mins');
assertEqual(parseDurationInput('90m'), 90 * 60, '90m');

// Colon time notation
assertEqual(parseDurationInput('1:30'), 5400, '1:30 (1h 30m)');
assertEqual(parseDurationInput('01:30'), 5400, '01:30');
assertEqual(parseDurationInput('0:45'), 2700, '0:45 (45m)');
assertEqual(parseDurationInput('1:30:20'), 5420, '1:30:20');

// Decimal hours
assertEqual(parseDurationInput('1.5'), 5400, '1.5 hours');
assertEqual(parseDurationInput('1.5h'), 5400, '1.5h');
assertEqual(parseDurationInput('2.25'), 8100, '2.25 hours');

// Plain integers
assertEqual(parseDurationInput('6'), 6 * 3600, '6 -> 6 hours');
assertEqual(parseDurationInput('12'), 12 * 3600, '12 -> 12 hours');
assertEqual(parseDurationInput('45'), 45 * 60, '45 -> 45 minutes');
assertEqual(parseDurationInput('90'), 90 * 60, '90 -> 90 minutes');

assertEqual(formatFocusDuration(23220), '6h 27m', 'formatFocusDuration 23220s');
assertEqual(formatFocusDuration(3600), '1h', 'formatFocusDuration 3600s');
assertEqual(formatFocusDuration(1620), '27m', 'formatFocusDuration 1620s');
assertEqual(formatFocusDuration(0), '0m', 'formatFocusDuration 0s');

assertEqual(formatDetailedDuration(0), '0 minutes (Cleared)', 'formatDetailedDuration 0s');
assertEqual(formatDetailedDuration(23220), '6 hours, 27 minutes (387 mins total)', 'formatDetailedDuration 23220s');
assertEqual(formatDetailedDuration(3600), '1 hour (60 mins total)', 'formatDetailedDuration 3600s');
assertEqual(formatDetailedDuration(1620), '27 minutes', 'formatDetailedDuration 1620s');

assertEqual(formatCountdown(0), '00:00', 'formatCountdown 0');
assertEqual(formatCountdown(59), '00:59', 'formatCountdown 59');
assertEqual(formatCountdown(60), '01:00', 'formatCountdown 60');
assertEqual(formatCountdown(3599), '59:59', 'formatCountdown 3599');
assertEqual(formatCountdown(3600), '60:00', 'formatCountdown 3600');
assertEqual(formatCountdown(12.3), '00:13', 'formatCountdown ceil fractional');

console.log('✓ parseDurationInput and formatting tests passed');

console.log('--- 2. CRASH & SYSTEM SLEEP RECOVERY LOGIC ---');

const BASE_TIME = Date.parse('2026-08-17T10:00:00.000Z');
const RUNNING_TIMER: FocusTimerState = {
  plannedSeconds: 3600,
  accumulatedSeconds: 600,
  isRunning: true,
  lastStartedAt: new Date(BASE_TIME).toISOString(),
  sessionStartedAt: new Date(BASE_TIME - 600_000).toISOString(),
};

// Case 2.1: Fresh Heartbeat -> Session is ALIVE (return null)
const freshBeat: FocusHeartbeat = {
  at: new Date(BASE_TIME + 20_000).toISOString(),
  sessionStartedAt: RUNNING_TIMER.sessionStartedAt,
  elapsedSeconds: 620,
};
const recAlive = focusRecoveryFor(RUNNING_TIMER, freshBeat, BASE_TIME + 25_000);
assertEqual(recAlive, null, 'Active live session with recent heartbeat must not be recovered');

// Case 2.2: Stale Heartbeat (> 90s) -> PC went to sleep mid-session
const staleBeat: FocusHeartbeat = {
  at: new Date(BASE_TIME + 500_000).toISOString(), // machine slept at +500s
  sessionStartedAt: RUNNING_TIMER.sessionStartedAt,
  elapsedSeconds: 1100,
};
const recSleep = focusRecoveryFor(RUNNING_TIMER, staleBeat, BASE_TIME + 10_000_000); // booted hours later
assert(recSleep !== null, 'Sleeping PC must trigger recovery');
assertEqual(recSleep?.endedAt, staleBeat.at, 'Recovered session must end at last heartbeat time');
assertEqual(recSleep?.durationSeconds, 1100, 'Recovered session duration matches heartbeat elapsed');

// Case 2.3: Heartbeat duration exceeds plannedSeconds -> Clamped to plannedSeconds
const overrunBeat: FocusHeartbeat = {
  at: new Date(BASE_TIME + 4000_000).toISOString(),
  sessionStartedAt: RUNNING_TIMER.sessionStartedAt,
  elapsedSeconds: 4000,
};
const recOverrun = focusRecoveryFor(RUNNING_TIMER, overrunBeat, BASE_TIME + 10_000_000);
assert(recOverrun !== null, 'Overrun beat triggers recovery');
assertEqual(recOverrun?.durationSeconds, 3600, 'Overrun duration must clamp to plannedSeconds');

// Case 2.4: Session resumed recently (< 90s) despite stale heartbeat from previous run
const recentlyResumed: FocusTimerState = {
  ...RUNNING_TIMER,
  lastStartedAt: new Date(BASE_TIME + 9_950_000).toISOString(), // resumed 50s ago
};
const recRecentResume = focusRecoveryFor(recentlyResumed, staleBeat, BASE_TIME + 10_000_000);
assertEqual(recRecentResume, null, 'Recently toggled session must not be aborted by old heartbeat');

// Case 2.5: No Heartbeat available -> only recover after plannedSeconds + stale buffer
const noBeatTimer: FocusTimerState = {
  plannedSeconds: 1800,
  accumulatedSeconds: 0,
  isRunning: true,
  lastStartedAt: new Date(BASE_TIME).toISOString(),
  sessionStartedAt: new Date(BASE_TIME).toISOString(),
};
// 1000s in: within planned (1800s) -> null
assertEqual(focusRecoveryFor(noBeatTimer, null, BASE_TIME + 1000_000), null, 'In-progress timer without heartbeat is alive');
// 1900s in: past planned (1800s) but within 90s grace window -> null
assertEqual(focusRecoveryFor(noBeatTimer, null, BASE_TIME + 1850_000), null, 'Within 90s grace window is alive');
// 5000s in: well past planned + grace -> recovered at planned completion time
const recNoBeat = focusRecoveryFor(noBeatTimer, null, BASE_TIME + 5000_000);
assert(recNoBeat !== null, 'Abandoned session without heartbeat is recovered');
assertEqual(recNoBeat?.endedAt, new Date(BASE_TIME + 1800_000).toISOString(), 'Ended at planned duration mark');
assertEqual(recNoBeat?.durationSeconds, 1800, 'Duration is plannedSeconds');

// Recovery ID and Completion ID stability
assertEqual(recoveredSessionId('2026-08-17T10:00:00.000Z'), 'recovered-2026-08-17T10:00:00.000Z', 'recoveredSessionId');
assertEqual(recoveredSessionId(null), 'recovered-unknown', 'recoveredSessionId fallback');
assertEqual(autoSessionId('2026-08-17T10:00:00.000Z', 3600), 'auto-2026-08-17T10:00:00.000Z-3600', 'autoSessionId');

console.log('✓ Crash & sleep recovery tests passed');

console.log('--- 3. SUB-SECOND ACCUMULATION & ZERO DRIFT VERIFICATION ---');

// Verify that periodic checkpoints fold integer seconds and keep sub-second remainder in lastStartedAt
let simTimer: FocusTimerState = {
  plannedSeconds: 3600,
  accumulatedSeconds: 0,
  isRunning: true,
  lastStartedAt: new Date(BASE_TIME).toISOString(),
  sessionStartedAt: new Date(BASE_TIME).toISOString(),
};

// Simulate 500 irregular checkpoint intervals (e.g., 2.345s, 4.812s, 1.109s)
let curTime = BASE_TIME;
const intervals = [2345, 4812, 1109, 3750, 5200, 999, 15000];
for (let i = 0; i < 500; i++) {
  const dt = intervals[i % intervals.length];
  curTime += dt;
  simTimer = checkpointFocusTimer(simTimer, curTime);
}

const totalElapsedMs = curTime - BASE_TIME;
const expectedWholeSec = Math.floor(totalElapsedMs / 1000);
const liveElapsed = getFocusTimerElapsedSeconds(simTimer, curTime);
assertEqual(liveElapsed, expectedWholeSec, 'Cumulative elapsed seconds must be EXACT across hundreds of irregular folds (zero drift)');

// Pausing banks exact seconds and transitions state
const pausedAt = curTime + 550;
const pausedTimer = pauseFocusTimer(simTimer, pausedAt);
const expectedPausedSec = Math.floor((pausedAt - BASE_TIME) / 1000);
assertEqual(pausedTimer.isRunning, false, 'pauseFocusTimer sets isRunning to false');
assertEqual(pausedTimer.lastStartedAt, null, 'pauseFocusTimer clears lastStartedAt');
assert(pausedTimer.lastPausedAt !== null, 'pauseFocusTimer stamps lastPausedAt');
assertEqual(getFocusTimerElapsedSeconds(pausedTimer, pausedAt + 100_000), expectedPausedSec, 'Paused timer freezes elapsed time');

// Negative time step / NTP rewind protection
const clockRewindTimer: FocusTimerState = {
  plannedSeconds: 3600,
  accumulatedSeconds: 500,
  isRunning: true,
  lastStartedAt: new Date(BASE_TIME).toISOString(),
  sessionStartedAt: new Date(BASE_TIME).toISOString(),
};
const afterRewind = checkpointFocusTimer(clockRewindTimer, BASE_TIME - 5000); // 5s in past
assertEqual(afterRewind.accumulatedSeconds, 500, 'NTP clock rewind must never decrement accumulatedSeconds');
assertEqual(afterRewind.lastStartedAt, clockRewindTimer.lastStartedAt, 'NTP clock rewind leaves anchor untouched');

console.log('✓ Sub-second precision & zero drift tests passed');

console.log('--- 4. CROSS-WINDOW COORDINATION & DEDUPLICATION ---');

// Identity stripping updatedAt
const tA: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, plannedSeconds: 1800, updatedAt: 1000 };
const tB: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, plannedSeconds: 1800, updatedAt: 2000 };
assertEqual(focusTimerIdentity(tA), focusTimerIdentity(tB), 'focusTimerIdentity ignores updatedAt');

// Transition key differentiation
const trRunning: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, isRunning: true, sessionStartedAt: 's1', lastStartedAt: 'l1' };
const trRunningNudged: FocusTimerState = { ...trRunning, plannedSeconds: 2400 };
assertEqual(focusTimerTransitionKey(trRunning), focusTimerTransitionKey(trRunningNudged), 'Duration nudge shares transition key');

const trPaused: FocusTimerState = { ...trRunning, isRunning: false, lastPausedAt: 'p1' };
assert(focusTimerTransitionKey(trRunning) !== focusTimerTransitionKey(trPaused), 'State change generates unique transition key');

// Cue Key bucketing
const cueTime = Date.parse('2026-08-17T12:00:00.000Z');
const cueTimer1: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, sessionStartedAt: 's1', lastStartedAt: new Date(cueTime).toISOString() };
const cueTimer2: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, sessionStartedAt: 's1', lastStartedAt: new Date(cueTime + 1500).toISOString() };
const cueTimer3: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, sessionStartedAt: 's1', lastStartedAt: new Date(cueTime + 6000).toISOString() };

assertEqual(focusCueKey('start', cueTimer1), focusCueKey('start', cueTimer2), 'Cues within 4s bucket share key');
assert(focusCueKey('start', cueTimer1) !== focusCueKey('start', cueTimer3), 'Cues > 4s apart have distinct keys');
assert(focusCueKey('start', cueTimer1) !== focusCueKey('pause', cueTimer1), 'Different cue slots have distinct keys');

// Cue Freshness tests (preventing sound on mobile/tab opening mid-session)
const nowMs = Date.parse('2026-08-17T12:00:10.000Z');
const freshStartTimer: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, lastStartedAt: '2026-08-17T12:00:08.000Z' }; // 2s ago
const staleStartTimer: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, lastStartedAt: '2026-08-17T12:00:00.000Z' }; // 10s ago
const freshPauseTimer: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, lastPausedAt: '2026-08-17T12:00:09.000Z' }; // 1s ago
const stalePauseTimer: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, lastPausedAt: '2026-08-17T11:55:00.000Z' }; // 5m ago
const noStampTimer: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, lastStartedAt: null, lastPausedAt: null };

assert(isFocusCueFresh(freshStartTimer, 'start', 5000, nowMs), 'Fresh start cue (2s old) is accepted');
assert(isFocusCueFresh(freshStartTimer, 'resume', 5000, nowMs), 'Fresh resume cue (2s old) is accepted');
assert(!isFocusCueFresh(staleStartTimer, 'start', 5000, nowMs), 'Stale start cue (10s old) is rejected');
assert(isFocusCueFresh(freshPauseTimer, 'pause', 5000, nowMs), 'Fresh pause cue (1s old) is accepted');
assert(!isFocusCueFresh(stalePauseTimer, 'pause', 5000, nowMs), 'Stale pause cue (5m old) is rejected');
assert(!isFocusCueFresh(noStampTimer, 'start', 5000, nowMs), 'Missing timestamp cue is rejected');

// Session deduplication
const rawSessions: FocusSession[] = [
  { id: 's1', startedAt: '2026-08-17T10:00:00Z', endedAt: '2026-08-17T11:00:00Z', durationSeconds: 3600, plannedSeconds: 3600 },
  { id: 's1', startedAt: '2026-08-17T10:00:00Z', endedAt: '2026-08-17T11:00:00Z', durationSeconds: 3600, plannedSeconds: 3600 },
  { id: 's2', startedAt: '2026-08-17T12:00:00Z', endedAt: '2026-08-17T12:30:00Z', durationSeconds: 1800, plannedSeconds: 1800 },
];
const deduped = dedupeFocusSessions(rawSessions);
assertEqual(deduped.length, 2, 'dedupeFocusSessions removes duplicate records');
assertEqual(deduped.map(s => s.id).join(','), 's1,s2', 'dedupeFocusSessions preserves unique order');

assertEqual(isCompletedFocusSession(rawSessions[0]), true, '3600s >= MIN_COMPLETED_SESSION_SECONDS is completed');
assertEqual(isCompletedFocusSession(rawSessions[1]), true, '3600s >= MIN_COMPLETED_SESSION_SECONDS is completed');
assertEqual(isCompletedFocusSession(rawSessions[2]), true, '1800s >= MIN_COMPLETED_SESSION_SECONDS is completed');
assertEqual(isCompletedFocusSession({ ...rawSessions[0], durationSeconds: MIN_COMPLETED_SESSION_SECONDS - 1 }), false, 'Under 20m is not completed');

console.log('✓ Cross-window coordination & deduplication tests passed');

console.log('--- 5. MANUAL DAY EDITS & FOCUS DAY BUCKETING ---');

const testDates = ['2026-08-14', '2026-08-17', '2026-12-31', '2026-01-01'];
const startHours = [0, 1, 3, 4, 6, 9, 12, 16, 20, 23];

for (const dKey of testDates) {
  for (const startH of startHours) {
    const session = createManualFocusSession(dKey, 6 * 3600 + 27 * 60, startH);
    const resolvedKey = focusDayKey(session.endedAt, startH);
    assertEqual(resolvedKey, dKey, `createManualFocusSession for date ${dKey} with startHour ${startH}`);

    assertEqual(session.durationSeconds, 23220, 'durationSeconds');
    assertEqual(session.plannedSeconds, 23220, 'plannedSeconds');
    assert(new Date(session.startedAt).getTime() < new Date(session.endedAt).getTime(), 'startedAt < endedAt');
    assertEqual(new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime(), 23220 * 1000, 'elapsed ms');

    const [y, m, dayNum] = dKey.split('-').map(Number);
    const dayDate = new Date(y, m - 1, dayNum, 12, 0, 0);
    const totalSec = sumFocusSecondsForDay([session], dayDate, startH);
    assertEqual(totalSec, 23220, `sumFocusSecondsForDay for ${dKey} with startHour ${startH}`);
  }
}

// Running session edit banking tests
const NOW = Date.parse('2026-08-17T12:00:00');
const running: FocusTimerState = {
  ...DEFAULT_FOCUS_TIMER,
  isRunning: true,
  lastStartedAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
  sessionStartedAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
};

assertEqual(getFocusTimerElapsedSeconds(running, NOW), 2400, 'elapsed of a 40m running session');
assertEqual(getFocusTimerUncreditedSeconds(running, NOW), 2400, 'nothing banked yet');

const edited: FocusTimerState = { ...running, creditedSeconds: getFocusTimerElapsedSeconds(running, NOW) };
const typedTotal = 5 * 3600; // "5h"
const dayLogged = createManualFocusSession('2026-08-17', typedTotal, 0).durationSeconds;

assertEqual(dayLogged + getFocusTimerUncreditedSeconds(edited, NOW), typedTotal, 'day total is exact at confirm time');
assertEqual(getFocusTimerElapsedSeconds(edited, NOW), 2400, 'edit does not alter live timer elapsed');
assertEqual(dayLogged + getFocusTimerUncreditedSeconds(edited, NOW + 10 * 60 * 1000), typedTotal + 600, 'only time post-edit adds to day');
assertEqual(getFocusTimerUncreditedSeconds(edited, NOW), 0, 'lowering day leaves 0 live delta');

assertEqual(loggableSessionSeconds(edited, 2400), 0, 'stopping right after edit logs nothing');
assertEqual(loggableSessionSeconds(edited, 3000), 600, 'stopping 10m later logs 10m');
assertEqual(loggableSessionSeconds(running, 2400), 2400, 'un-edited logs full');
assertEqual(loggableSessionSeconds(edited, 1200), 0, 'never logs negative');

console.log('✓ Manual day edits & focus day bucketing tests passed');

console.log('--- 6. COERCION & CORRUPT DATA RECOVERY ---');

assertEqual(coerceFocusTimer(null).plannedSeconds, DEFAULT_FOCUS_TIMER.plannedSeconds, 'null timer fallback');
assertEqual(coerceFocusTimer({ isRunning: 'true', plannedSeconds: '1800' }).isRunning, true, 'string boolean coercion');
assertEqual(coerceFocusTimer({ accumulatedSeconds: -50 }).accumulatedSeconds, 0, 'negative accumulatedSeconds clamp');
assertEqual(coerceFocusTimer({ creditedSeconds: -100 }).creditedSeconds, 0, 'negative creditedSeconds clamp');

assertEqual(safeFocusHeartbeat(null), null, 'safeFocusHeartbeat null');
assertEqual(safeFocusHeartbeat({ at: 'invalid-date' }), null, 'safeFocusHeartbeat invalid date');
assertEqual(safeFocusHeartbeat({ at: '2026-08-17T12:00:00Z', elapsedSeconds: -10 })?.elapsedSeconds, 0, 'negative elapsed clamped');

assertEqual(safeFocusSessions(null).length, 0, 'safeFocusSessions null');
assertEqual(safeFocusSessions([{ id: 123 }]).length, 0, 'safeFocusSessions invalid schema filtered');
assertEqual(safeFocusSessions([{ id: 's1', startedAt: 'a', endedAt: 'b', durationSeconds: 0 }]).length, 0, '0 duration filtered');
assertEqual(safeFocusSessions([{ id: 's1', startedAt: 'a', endedAt: 'b', durationSeconds: 100 }]).length, 1, 'valid session accepted');

assertEqual(safeFocusExcludedDates(['2026-08-17', 'invalid-date', '2026-12-31']).join(','), '2026-08-17,2026-12-31', 'excluded dates filter');

assertEqual(coerceFocusChime('invalid_chime'), 'breath', 'invalid chime fallback');
assertEqual(coerceFocusChime('bowl'), 'bowl', 'valid chime preserved');

assertEqual(coerceFocusCue('invalid_cue', 'start'), 'rise', 'invalid cue start fallback');
assertEqual(coerceFocusCue('tap', 'start'), 'tap', 'valid cue preserved');

console.log('✓ Coercion & corrupt data recovery tests passed');
console.log('====================================================');
console.log('ALL FOCUS SESSION & TIMER TESTS PASSED SUCCESSFULLY!');
