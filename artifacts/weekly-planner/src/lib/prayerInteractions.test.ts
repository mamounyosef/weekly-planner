// Comprehensive unit tests for prayer interactions, toggles, date edge cases,
// validation, rapid sequential state updates, and boundary conditions.
// Run with: npx tsx src/lib/prayerInteractions.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_KEYS,
  buildPrayerDay,
  coercePrayerDone,
  isPlannerDate,
  isPrayerDone,
  minutesToPrayerTime,
  prayerDateKey,
  prayerOccId,
  prayerTimeToMinutes,
  togglePrayerDone,
  withinPrayerHorizon,
  type PrayerDoneMap,
  type PrayerKey,
} from './prayerTimes';
import { validatePrayerToggle } from '../../sync-service';

console.log('--- 1. PRAYER DONE TOGGLE MECHANICS ---');
{
  let map: PrayerDoneMap = {};

  // Toggle on Asr for today
  map = togglePrayerDone(map, '2026-09-08', 'asr');
  assert.equal(isPrayerDone(map, '2026-09-08', 'asr'), true, 'Asr should be marked done');
  assert.deepEqual(map['2026-09-08'], ['asr']);

  // Toggle Dhuhr on same day
  map = togglePrayerDone(map, '2026-09-08', 'dhuhr');
  assert.equal(isPrayerDone(map, '2026-09-08', 'dhuhr'), true);
  assert.equal(isPrayerDone(map, '2026-09-08', 'asr'), true);
  assert.deepEqual(map['2026-09-08'], ['dhuhr', 'asr'], 'Preserves chronological prayer order');

  // Toggle Maghrib on same day
  map = togglePrayerDone(map, '2026-09-08', 'maghrib');
  assert.deepEqual(map['2026-09-08'], ['dhuhr', 'asr', 'maghrib']);

  // Un-toggle Asr
  map = togglePrayerDone(map, '2026-09-08', 'asr');
  assert.equal(isPrayerDone(map, '2026-09-08', 'asr'), false, 'Asr should be untoggled');
  assert.deepEqual(map['2026-09-08'], ['dhuhr', 'maghrib'], 'Other prayers remain marked');

  // Un-toggle Dhuhr and Maghrib
  map = togglePrayerDone(map, '2026-09-08', 'dhuhr');
  map = togglePrayerDone(map, '2026-09-08', 'maghrib');
  assert.equal(map['2026-09-08'], undefined, 'Clean state: day key deleted when all prayers unchecked');
}

console.log('--- 2. MULTI-DAY INDEPENDENCE ---');
{
  let map: PrayerDoneMap = {};
  map = togglePrayerDone(map, '2026-09-07', 'asr');
  map = togglePrayerDone(map, '2026-09-08', 'asr');
  map = togglePrayerDone(map, '2026-09-09', 'asr');

  assert.equal(isPrayerDone(map, '2026-09-07', 'asr'), true);
  assert.equal(isPrayerDone(map, '2026-09-08', 'asr'), true);
  assert.equal(isPrayerDone(map, '2026-09-09', 'asr'), true);

  // Un-toggle only today
  map = togglePrayerDone(map, '2026-09-08', 'asr');
  assert.equal(isPrayerDone(map, '2026-09-07', 'asr'), true, 'Yesterday remains intact');
  assert.equal(isPrayerDone(map, '2026-09-08', 'asr'), false, 'Today is unticked');
  assert.equal(isPrayerDone(map, '2026-09-09', 'asr'), true, 'Tomorrow remains intact');
}

console.log('--- 3. ALL SIX PRAYER KEYS SUPPORTED ---');
{
  let map: PrayerDoneMap = {};
  for (const key of PRAYER_KEYS) {
    map = togglePrayerDone(map, '2026-09-08', key);
    assert.equal(isPrayerDone(map, '2026-09-08', key), true, `${key} can be marked done`);
  }
  assert.deepEqual(map['2026-09-08'], PRAYER_KEYS, 'All 6 prayers in correct order');

  for (const key of PRAYER_KEYS) {
    map = togglePrayerDone(map, '2026-09-08', key);
    assert.equal(isPrayerDone(map, '2026-09-08', key), false, `${key} can be unmarked`);
  }
  assert.equal(map['2026-09-08'], undefined);
}

console.log('--- 4. RAPID SEQUENTIAL TOGGLE SIMULATION (RACE SAFETY) ---');
{
  // Simulating the bug where doneRef was not updated until re-render.
  // With immediate doneRef.current = next, consecutive toggles in the same tick are atomic.
  let state: PrayerDoneMap = {};
  let doneRefCurrent = state;

  const simulateToggle = (dateStr: string, key: PrayerKey) => {
    const next = togglePrayerDone(doneRefCurrent, dateStr, key);
    doneRefCurrent = next;
    state = next;
  };

  simulateToggle('2026-09-08', 'dhuhr');
  simulateToggle('2026-09-08', 'asr');
  simulateToggle('2026-09-08', 'maghrib');

  assert.equal(isPrayerDone(state, '2026-09-08', 'dhuhr'), true);
  assert.equal(isPrayerDone(state, '2026-09-08', 'asr'), true);
  assert.equal(isPrayerDone(state, '2026-09-08', 'maghrib'), true);
  assert.deepEqual(state['2026-09-08'], ['dhuhr', 'asr', 'maghrib']);
}

console.log('--- 5. CALENDAR DATE INTEGRITY & LEAP YEARS (isPlannerDate) ---');
{
  // Valid regular dates
  assert.equal(isPlannerDate('2026-09-08'), true, 'Today is valid');
  assert.equal(isPlannerDate('2026-01-01'), true);
  assert.equal(isPlannerDate('2026-12-31'), true);

  // Leap years: Gregorian rules
  assert.equal(isPlannerDate('2024-02-29'), true, '2024 is a leap year');
  assert.equal(isPlannerDate('2026-02-29'), false, '2026 is NOT a leap year');
  assert.equal(isPlannerDate('2000-02-29'), true, '2000 is a century leap year (divisible by 400)');
  assert.equal(isPlannerDate('1900-02-29'), false, '1900 is NOT a leap year (divisible by 100 but not 400)');
  assert.equal(isPlannerDate('2400-02-29'), true, '2400 is a leap year');

  // Month lengths: 30 vs 31 days
  assert.equal(isPlannerDate('2026-04-30'), true);
  assert.equal(isPlannerDate('2026-04-31'), false, 'April has only 30 days');
  assert.equal(isPlannerDate('2026-06-31'), false, 'June has only 30 days');
  assert.equal(isPlannerDate('2026-09-31'), false, 'September has only 30 days');
  assert.equal(isPlannerDate('2026-11-31'), false, 'November has only 30 days');
  assert.equal(isPlannerDate('2026-08-31'), true, 'August has 31 days');

  // Impossible month / day ranges
  assert.equal(isPlannerDate('2026-00-10'), false, 'Month 0 is invalid');
  assert.equal(isPlannerDate('2026-13-01'), false, 'Month 13 is invalid');
  assert.equal(isPlannerDate('2026-05-00'), false, 'Day 0 is invalid');
  assert.equal(isPlannerDate('2026-05-32'), false, 'Day 32 is invalid');

  // Malformed formats
  assert.equal(isPlannerDate('2026/09/08'), false, 'Slashes are invalid');
  assert.equal(isPlannerDate('08-09-2026'), false, 'DMY is invalid');
  assert.equal(isPlannerDate('2026-9-8'), false, 'Unpadded numbers are invalid');
  assert.equal(isPlannerDate(''), false);
  assert.equal(isPlannerDate(null), false);
  assert.equal(isPlannerDate(undefined), false);
  assert.equal(isPlannerDate(12345), false);
}

console.log('--- 6. HTTP API VALIDATION (validatePrayerToggle) ---');
{
  // Valid payloads
  assert.equal(validatePrayerToggle({ date: '2026-09-08', key: 'asr', present: true }), null);
  assert.equal(validatePrayerToggle({ date: '2026-09-08', key: 'asr', present: false }), null);
  for (const k of PRAYER_KEYS) {
    assert.equal(validatePrayerToggle({ date: '2026-09-08', key: k, present: true }), null);
  }

  // Invalid dates
  assert.notEqual(validatePrayerToggle({ date: '2026-02-29', key: 'asr', present: true }), null);
  assert.notEqual(validatePrayerToggle({ date: 'invalid', key: 'asr', present: true }), null);
  assert.notEqual(validatePrayerToggle({ date: '', key: 'asr', present: true }), null);

  // Invalid keys
  assert.notEqual(validatePrayerToggle({ date: '2026-09-08', key: 'tahajjud', present: true }), null);
  assert.notEqual(validatePrayerToggle({ date: '2026-09-08', key: 'ASR', present: true }), null);
  assert.notEqual(validatePrayerToggle({ date: '2026-09-08', key: 123, present: true }), null);

  // Invalid present
  assert.notEqual(validatePrayerToggle({ date: '2026-09-08', key: 'asr', present: 'true' }), null);
  assert.notEqual(validatePrayerToggle({ date: '2026-09-08', key: 'asr', present: 1 }), null);
  assert.notEqual(validatePrayerToggle({ date: '2026-09-08', key: 'asr', present: null }), null);

  // Missing body
  assert.notEqual(validatePrayerToggle(null as any), null);
  assert.notEqual(validatePrayerToggle(undefined as any), null);
}

console.log('--- 7. PRAYER DATE KEY FORMATTING ACROSS BOUNDARIES ---');
{
  // Leading zeros verification
  assert.equal(prayerDateKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(prayerDateKey(new Date(2026, 8, 8)), '2026-09-08');
  assert.equal(prayerDateKey(new Date(2026, 11, 31)), '2026-12-31');

  // Year boundary
  const dec31 = new Date(2026, 11, 31);
  const jan1 = new Date(2027, 0, 1);
  assert.equal(prayerDateKey(dec31), '2026-12-31');
  assert.equal(prayerDateKey(jan1), '2027-01-01');
}

console.log('--- 8. COERCE CORRUPT OR MALFORMED PRAYER DONE MAPS ---');
{
  // Malformed input recovery
  assert.deepEqual(coercePrayerDone(null), {});
  assert.deepEqual(coercePrayerDone(undefined), {});
  assert.deepEqual(coercePrayerDone('not an object'), {});
  assert.deepEqual(coercePrayerDone([1, 2, 3]), {});

  // Strips invalid dates and invalid prayer keys
  const dirty = {
    '2026-09-08': ['asr', 'not-a-prayer', 'dhuhr'],
    'not-a-date': ['fajr'],
    '2026-15-40': ['isha'],
    '2026-09-09': 'not-an-array',
    '2026-09-10': [],
  };
  const cleaned = coercePrayerDone(dirty);
  assert.deepEqual(cleaned, {
    '2026-09-08': ['dhuhr', 'asr'],
  });
}

console.log('--- 9. BUILD PRAYER DAY WITH OFFSETS & CLAMPING ---');
{
  const timings = {
    fajr: '04:30',
    sunrise: '05:55',
    dhuhr: '12:35',
    asr: '16:08',
    maghrib: '19:15',
    isha: '20:45',
  };

  // Normal build
  const prayers = buildPrayerDay('2026-09-08', timings, DEFAULT_PRAYER_SETTINGS);
  const asr = prayers.find(p => p.key === 'asr');
  assert.ok(asr);
  assert.equal(asr.time, '16:08');
  assert.equal(asr.minutes, 16 * 60 + 8);
  assert.equal(asr.id, '2026-09-08::asr');

  // Extreme manual offsets clamped within 0..1439
  const offsetSettings = {
    ...DEFAULT_PRAYER_SETTINGS,
    offsets: {
      fajr: -300, // Would be negative minutes
      isha: 300,  // Would exceed 1440 minutes
    },
  };
  const offsetPrayers = buildPrayerDay('2026-09-08', timings, offsetSettings);
  const fajr = offsetPrayers.find(p => p.key === 'fajr');
  const isha = offsetPrayers.find(p => p.key === 'isha');
  assert.ok(fajr && fajr.minutes >= 0);
  assert.ok(isha && isha.minutes <= 1439);
}

console.log('\nALL PASS (prayerInteractions: mechanics, race safety, calendar rules, validation, edge cases)');