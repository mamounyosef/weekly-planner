import {
  parseDurationInput,
  formatFocusDuration,
  formatDetailedDuration,
  createManualFocusSession,
  focusDayKey,
  sumFocusSecondsForDay,
  coerceFocusTimer,
  getFocusTimerElapsedSeconds,
  getFocusTimerUncreditedSeconds,
  loggableSessionSeconds,
  focusTimerPushKey,
  DEFAULT_FOCUS_TIMER,
  type FocusTimerState,
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

console.log('Testing parseDurationInput...');

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

console.log('✓ parseDurationInput tests passed');

console.log('Testing createManualFocusSession and focusDayKey across all start hours...');

const testDates = ['2026-08-14', '2026-08-17', '2026-12-31', '2026-01-01'];
const startHours = [0, 1, 3, 4, 6, 9, 12, 16, 20, 23];

for (const dKey of testDates) {
  for (const startH of startHours) {
    const session = createManualFocusSession(dKey, 6 * 3600 + 27 * 60, startH);
    const resolvedKey = focusDayKey(session.endedAt, startH);
    assertEqual(resolvedKey, dKey, `createManualFocusSession for date ${dKey} with startHour ${startH}`);

    // Verify duration
    assertEqual(session.durationSeconds, 23220, 'durationSeconds');
    assertEqual(session.plannedSeconds, 23220, 'plannedSeconds');

    // Verify startedAt is before endedAt
    assert(new Date(session.startedAt).getTime() < new Date(session.endedAt).getTime(), 'startedAt < endedAt');
    assertEqual(new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime(), 23220 * 1000, 'elapsed ms');

    // Verify sumFocusSecondsForDay correctly sums this session
    const [y, m, dayNum] = dKey.split('-').map(Number);
    const dayDate = new Date(y, m - 1, dayNum, 12, 0, 0);
    const totalSec = sumFocusSecondsForDay([session], dayDate, startH);
    assertEqual(totalSec, 23220, `sumFocusSecondsForDay for ${dKey} with startHour ${startH}`);
  }
}

console.log('✓ createManualFocusSession and focusDayKey tests passed');

console.log('Testing formatDetailedDuration & formatFocusDuration...');
assertEqual(formatFocusDuration(23220), '6h 27m', 'formatFocusDuration 23220s');
assertEqual(formatFocusDuration(3600), '1h', 'formatFocusDuration 3600s');
assertEqual(formatFocusDuration(1620), '27m', 'formatFocusDuration 1620s');
assertEqual(formatFocusDuration(0), '0m', 'formatFocusDuration 0s');

assertEqual(formatDetailedDuration(0), '0 minutes (Cleared)', 'formatDetailedDuration 0s');
assertEqual(formatDetailedDuration(23220), '6 hours, 27 minutes (387 mins total)', 'formatDetailedDuration 23220s');
assertEqual(formatDetailedDuration(3600), '1 hour (60 mins total)', 'formatDetailedDuration 3600s');
assertEqual(formatDetailedDuration(1620), '27 minutes', 'formatDetailedDuration 1620s');

console.log('✓ Formatting tests passed');

console.log('Testing manual day edits against a running session...');

// A session that started 40 minutes ago and is still running.
const NOW = Date.parse('2026-08-17T12:00:00');
const running: FocusTimerState = {
  ...DEFAULT_FOCUS_TIMER,
  isRunning: true,
  lastStartedAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
  sessionStartedAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
};

assertEqual(getFocusTimerElapsedSeconds(running, NOW), 2400, 'elapsed of a 40m running session');
assertEqual(getFocusTimerUncreditedSeconds(running, NOW), 2400, 'nothing banked yet → whole session counts toward the day');

// The edit banks the 40 minutes run so far and writes the typed total verbatim.
const edited: FocusTimerState = { ...running, creditedSeconds: getFocusTimerElapsedSeconds(running, NOW) };
const typedTotal = 5 * 3600; // "5h"
const dayLogged = createManualFocusSession('2026-08-17', typedTotal, 0).durationSeconds;

// Right after confirming, the day reads EXACTLY what was typed.
assertEqual(dayLogged + getFocusTimerUncreditedSeconds(edited, NOW), typedTotal, 'day total is exactly the typed value at confirm time');
// The countdown is untouched — the session keeps running from where it was.
assertEqual(getFocusTimerElapsedSeconds(edited, NOW), 2400, 'edit does not rewind or advance the running session');
// Ten minutes later the day has grown by exactly those ten minutes, no more.
assertEqual(dayLogged + getFocusTimerUncreditedSeconds(edited, NOW + 10 * 60 * 1000), typedTotal + 600, 'only time run AFTER the edit adds to the day');
// Editing to a value below what the session has already run works too (it used
// to rewrite the timer, which corrupted the live countdown).
assertEqual(getFocusTimerUncreditedSeconds(edited, NOW), 0, 'clearing/lowering the day cannot leave phantom live seconds');

// Finishing the session logs only the un-banked part, so nothing is counted twice.
assertEqual(loggableSessionSeconds(edited, 2400), 0, 'stopping right after the edit logs nothing');
assertEqual(loggableSessionSeconds(edited, 3000), 600, 'stopping 10m later logs 10m');
assertEqual(loggableSessionSeconds(running, 2400), 2400, 'an un-edited session logs its full length');
assertEqual(loggableSessionSeconds(edited, 1200), 0, 'never logs a negative duration');

// The banked amount survives a round-trip through the shared file DB and forces
// a push, so the widget and desk display agree with the main window.
assertEqual(coerceFocusTimer(JSON.parse(JSON.stringify(edited))).creditedSeconds, 2400, 'creditedSeconds survives serialisation');
assertEqual(coerceFocusTimer({}).creditedSeconds, 0, 'missing creditedSeconds defaults to 0');
assertEqual(coerceFocusTimer({ creditedSeconds: -5 }).creditedSeconds, 0, 'negative creditedSeconds clamps to 0');
assert(focusTimerPushKey(edited) !== focusTimerPushKey(running), 'a day edit changes the push key so the other windows get it');

console.log('✓ Running-session edit tests passed');
console.log('ALL TESTS PASSED SUCCESSFULLY!');
