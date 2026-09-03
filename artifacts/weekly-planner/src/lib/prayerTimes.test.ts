// Tests prayer calculation settings, time parsing, minute wrapping, day building,
// horizon checks, done-store toggling, and monthly fetching URLs.
// Run with: npx tsx src/lib/prayerTimes.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_ARABIC,
  PRAYER_HORIZON_MAX,
  PRAYER_HORIZON_MIN,
  PRAYER_KEYS,
  PRAYER_LABELS,
  PRAYER_METHODS,
  buildPrayerDay,
  coercePrayerDone,
  coercePrayerSettings,
  isPrayerDone,
  minutesToPrayerTime,
  monthsForDates,
  parseAladhanTime,
  prayerDateKey,
  prayerMonthUrl,
  prayerOccId,
  prayerQueryKey,
  prayerTimeToMinutes,
  timesFromAladhanTimings,
  togglePrayerDone,
  withinPrayerHorizon,
  type PrayerDayTimes,
  type PrayerDoneMap,
  type PrayerSettings,
} from './prayerTimes';

console.log('--- 1. PRAYER CONSTANTS & LABELS ---');
assert.equal(PRAYER_KEYS.length, 6, 'Must have 6 prayer keys');
assert.deepEqual(PRAYER_KEYS, ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha']);
assert.equal(PRAYER_LABELS.fajr, 'Fajr');
assert.equal(PRAYER_ARABIC.fajr, 'الفجر');
assert.equal(PRAYER_ARABIC.maghrib, 'المغرب');
assert.ok(PRAYER_METHODS.some(m => m.id === 23 && m.label.includes('Jordan')));
assert.ok(PRAYER_METHODS.some(m => m.id === 4 && m.label.includes('Makkah')));

console.log('--- 2. COERCE PRAYER SETTINGS & CLAMPING ---');
// Null / undefined -> default
assert.deepEqual(coercePrayerSettings(null), { ...DEFAULT_PRAYER_SETTINGS, offsets: {}, hidden: [] });
assert.deepEqual(coercePrayerSettings(undefined), { ...DEFAULT_PRAYER_SETTINGS, offsets: {}, hidden: [] });

// Valid custom settings
const custom: PrayerSettings = {
  enabled: false,
  city: 'London',
  country: 'United Kingdom',
  method: 2,
  school: 1,
  showSunrise: true,
  hidden: ['sunrise'],
  style: 'pill',
  color: '#10b981',
  showInWidget: false,
  offsets: { fajr: 5, isha: -10 },
  horizonDays: 60,
};
const coerced = coercePrayerSettings(custom);
assert.equal(coerced.enabled, false);
assert.equal(coerced.city, 'London');
assert.equal(coerced.country, 'United Kingdom');
assert.equal(coerced.method, 2);
assert.equal(coerced.school, 1);
assert.equal(coerced.showSunrise, true);
assert.deepEqual(coerced.hidden, ['sunrise']);
assert.equal(coerced.style, 'pill');
assert.equal(coerced.color, '#10b981');
assert.equal(coerced.showInWidget, false);
assert.equal(coerced.offsets.fajr, 5);
assert.equal(coerced.offsets.isha, -10);
assert.equal(coerced.horizonDays, 60);

// Horizon clamping [1, 365]
assert.equal(coercePrayerSettings({ horizonDays: -10 }).horizonDays, PRAYER_HORIZON_MIN);
assert.equal(coercePrayerSettings({ horizonDays: 0 }).horizonDays, PRAYER_HORIZON_MIN);
assert.equal(coercePrayerSettings({ horizonDays: 500 }).horizonDays, PRAYER_HORIZON_MAX);

// Offsets clamping [-60, 60]
const clampedOffsets = coercePrayerSettings({
  offsets: { fajr: 100, isha: -100, dhuhr: 0, asr: 'invalid' as any },
});
assert.equal(clampedOffsets.offsets.fajr, 60);
assert.equal(clampedOffsets.offsets.isha, -60);
assert.equal(clampedOffsets.offsets.dhuhr, undefined, 'Zero offset is omitted');
assert.equal(clampedOffsets.offsets.asr, undefined, 'Invalid offset is omitted');

// Method validation (only recognized IDs preserved)
assert.equal(coercePrayerSettings({ method: 9999 }).method, DEFAULT_PRAYER_SETTINGS.method);

// Color validation
assert.equal(coercePrayerSettings({ color: 'red' }).color, DEFAULT_PRAYER_SETTINGS.color);
assert.equal(coercePrayerSettings({ color: '#AABBCC' }).color, '#AABBCC');

console.log('--- 3. PRAYER QUERY KEY ---');
assert.equal(prayerQueryKey(DEFAULT_PRAYER_SETTINGS), 'Amman|Jordan|23|0');
assert.equal(prayerQueryKey(coerced), 'London|United Kingdom|2|1');

console.log('--- 4. ALADHAN TIME PARSING ---');
assert.equal(parseAladhanTime('04:19'), '04:19');
assert.equal(parseAladhanTime('4:19'), '04:19');
assert.equal(parseAladhanTime('04:19 (+03)'), '04:19');
assert.equal(parseAladhanTime('19:45 (EEST)'), '19:45');
assert.equal(parseAladhanTime('23:59'), '23:59');
assert.equal(parseAladhanTime('00:00'), '00:00');

// Invalid times
assert.equal(parseAladhanTime('24:00'), null);
assert.equal(parseAladhanTime('04:60'), null);
assert.equal(parseAladhanTime('-01:00'), null);
assert.equal(parseAladhanTime(''), null);
assert.equal(parseAladhanTime('not a time'), null);
assert.equal(parseAladhanTime(null), null);
assert.equal(parseAladhanTime(123), null);

console.log('--- 5. MINUTE CONVERSION & WRAPPING ---');
assert.equal(prayerTimeToMinutes('00:00'), 0);
assert.equal(prayerTimeToMinutes('01:30'), 90);
assert.equal(prayerTimeToMinutes('12:00'), 720);
assert.equal(prayerTimeToMinutes('23:59'), 1439);

assert.equal(minutesToPrayerTime(0), '00:00');
assert.equal(minutesToPrayerTime(90), '01:30');
assert.equal(minutesToPrayerTime(720), '12:00');
assert.equal(minutesToPrayerTime(1439), '23:59');

// Wrapping within day (1440 mins)
assert.equal(minutesToPrayerTime(-30), '23:30', 'Negative minutes wrap to previous evening');
assert.equal(minutesToPrayerTime(1470), '00:30', 'Over-1440 minutes wrap to next morning');
assert.equal(minutesToPrayerTime(1440), '00:00');

console.log('--- 6. PRAYER OCCURRENCE ID ---');
assert.equal(prayerOccId('2026-08-25', 'fajr'), '2026-08-25::fajr');
assert.equal(prayerOccId('2026-12-31', 'isha'), '2026-12-31::isha');

console.log('--- 7. ALADHAN TIMINGS EXTRACTION ---');
const rawTimings = {
  Fajr: '04:30 (+03)',
  Sunrise: '05:55 (+03)',
  Dhuhr: '12:35 (+03)',
  Asr: '16:10 (+03)',
  Sunset: '19:15 (+03)',
  Maghrib: '19:15 (+03)',
  Isha: '20:45 (+03)',
  Imsak: '04:20 (+03)',
  Midnight: '00:35 (+03)',
};
const extracted = timesFromAladhanTimings(rawTimings);
assert.equal(extracted.fajr, '04:30');
assert.equal(extracted.sunrise, '05:55');
assert.equal(extracted.dhuhr, '12:35');
assert.equal(extracted.asr, '16:10');
assert.equal(extracted.maghrib, '19:15');
assert.equal(extracted.isha, '20:45');
assert.equal((extracted as any).Sunset, undefined, 'Unused Aladhan fields are stripped');

console.log('--- 8. BUILD PRAYER DAY ---');
const dayTimes: PrayerDayTimes = {
  fajr: '04:30',
  sunrise: '06:00',
  dhuhr: '12:30',
  asr: '16:00',
  maghrib: '19:00',
  isha: '20:30',
};

// Default settings: showSunrise = false -> 5 prayers
const defaultDay = buildPrayerDay('2026-08-25', dayTimes, DEFAULT_PRAYER_SETTINGS);
assert.equal(defaultDay.length, 5, 'Sunrise hidden by default');
assert.equal(defaultDay[0].key, 'fajr');
assert.equal(defaultDay[0].time, '04:30');
assert.equal(defaultDay[0].id, '2026-08-25::fajr');
assert.equal(defaultDay[4].key, 'isha');
assert.equal(defaultDay[4].time, '20:30');

// With sunrise enabled
const withSunrise = buildPrayerDay('2026-08-25', dayTimes, { ...DEFAULT_PRAYER_SETTINGS, showSunrise: true });
assert.equal(withSunrise.length, 6, 'All 6 entries when sunrise enabled');
assert.equal(withSunrise[1].key, 'sunrise');
assert.equal(withSunrise[1].time, '06:00');

// With manual offsets
const withOffsets = buildPrayerDay('2026-08-25', dayTimes, {
  ...DEFAULT_PRAYER_SETTINGS,
  offsets: { fajr: 15, isha: -10 },
});
assert.equal(withOffsets.find(p => p.key === 'fajr')?.time, '04:45');
assert.equal(withOffsets.find(p => p.key === 'fajr')?.minutes, 4 * 60 + 45);
assert.equal(withOffsets.find(p => p.key === 'isha')?.time, '20:20');
assert.equal(withOffsets.find(p => p.key === 'isha')?.minutes, 20 * 60 + 20);

// With hidden prayer
const withHidden = buildPrayerDay('2026-08-25', dayTimes, {
  ...DEFAULT_PRAYER_SETTINGS,
  hidden: ['dhuhr', 'asr'],
});
assert.equal(withHidden.length, 3);
assert.ok(!withHidden.some(p => p.key === 'dhuhr' || p.key === 'asr'));

// Empty times returns empty array
assert.deepEqual(buildPrayerDay('2026-08-25', undefined, DEFAULT_PRAYER_SETTINGS), []);

console.log('--- 9. WITHIN PRAYER HORIZON & DATE KEY ---');
const anchorDate = new Date(2026, 7, 25); // 2026-08-25
assert.equal(prayerDateKey(anchorDate), '2026-08-25');

// Today & Past dates are always within horizon
assert.equal(withinPrayerHorizon('2026-08-25', DEFAULT_PRAYER_SETTINGS, anchorDate), true);
assert.equal(withinPrayerHorizon('2026-08-01', DEFAULT_PRAYER_SETTINGS, anchorDate), true);

// Future within 30 days
assert.equal(withinPrayerHorizon('2026-09-10', DEFAULT_PRAYER_SETTINGS, anchorDate), true);

// Future beyond 30 days
assert.equal(withinPrayerHorizon('2026-10-01', DEFAULT_PRAYER_SETTINGS, anchorDate), false);

console.log('--- 10. PRAYER DONE MAP COERCION & TOGGLING ---');
assert.deepEqual(coercePrayerDone(null), {});
assert.deepEqual(coercePrayerDone('invalid'), {});

const validDone: PrayerDoneMap = {
  '2026-08-25': ['fajr', 'dhuhr'],
};
assert.deepEqual(coercePrayerDone(validDone), validDone);

// Toggling on & off
let doneMap: PrayerDoneMap = {};
assert.equal(isPrayerDone(doneMap, '2026-08-25', 'fajr'), false);

doneMap = togglePrayerDone(doneMap, '2026-08-25', 'fajr');
assert.equal(isPrayerDone(doneMap, '2026-08-25', 'fajr'), true);
assert.deepEqual(doneMap['2026-08-25'], ['fajr']);

doneMap = togglePrayerDone(doneMap, '2026-08-25', 'dhuhr');
assert.deepEqual(doneMap['2026-08-25'], ['fajr', 'dhuhr']);

// Untoggle fajr
doneMap = togglePrayerDone(doneMap, '2026-08-25', 'fajr');
assert.deepEqual(doneMap['2026-08-25'], ['dhuhr']);

// Untoggle dhuhr -> empties date and deletes key
doneMap = togglePrayerDone(doneMap, '2026-08-25', 'dhuhr');
assert.equal(doneMap['2026-08-25'], undefined);

console.log('--- 11. PRAYER MONTH URL & MONTHS FOR DATES ---');
const url = prayerMonthUrl(DEFAULT_PRAYER_SETTINGS, 2026, 8);
assert.ok(url.startsWith('/api/prayer-times?'));
assert.ok(url.includes('city=Amman'));
assert.ok(url.includes('country=Jordan'));
assert.ok(url.includes('year=2026'));
assert.ok(url.includes('month=8'));

const testDates = [
  new Date(2026, 7, 30), // Aug 30
  new Date(2026, 7, 31), // Aug 31
  new Date(2026, 8, 1),  // Sep 1
];
const neededMonths = monthsForDates(testDates);
assert.deepEqual(neededMonths, ['2026-8', '2026-9']);

// ─── The name is not printed twice ──────────────────────────────────────────
// Both screens draw a prayer's name in two scripts: "Fajr", and beside it the
// Arabic. Set the language to Arabic and the label BECAME the Arabic while the
// second slot still held the Arabic, so the row read the same word twice with a
// space between them. `secondary` decides it in one place, so the two screens
// cannot be fixed separately and drift apart again.
{
  const english = buildPrayerDay('2026-08-25', dayTimes, DEFAULT_PRAYER_SETTINGS, 'english');
  assert.ok(english.length > 0, 'there is a day to look at');
  for (const row of english) {
    assert.notEqual(row.label, row.arabic, 'the English label is not the Arabic one');
    assert.equal(row.secondary, row.arabic, 'so the Arabic is worth printing beside it');
    assert.notEqual(row.secondary, '', 'and it is actually printed');
  }

  const arabic = buildPrayerDay('2026-08-25', dayTimes, DEFAULT_PRAYER_SETTINGS, 'arabic');
  assert.equal(arabic.length, english.length, 'the same prayers either way');
  for (const row of arabic) {
    assert.equal(row.label, row.arabic, 'the label IS the Arabic now');
    assert.equal(row.secondary, '', 'so there is nothing to add beside it');
  }

  // The default, with no language given at all, is English and says both.
  for (const row of buildPrayerDay('2026-08-25', dayTimes, DEFAULT_PRAYER_SETTINGS)) {
    assert.notEqual(row.secondary, '', 'the default prints both scripts');
  }

  // Whatever else is switched on or off, the rule holds: a row never says the
  // same word twice, and never loses the second script when it has one to give.
  const variants = [
    { ...DEFAULT_PRAYER_SETTINGS, showSunrise: true },
    { ...DEFAULT_PRAYER_SETTINGS, hidden: ['fajr', 'isha'] as never },
    { ...DEFAULT_PRAYER_SETTINGS, offsets: { ...DEFAULT_PRAYER_SETTINGS.offsets, fajr: 45 } },
  ];
  for (const settings of variants) {
    for (const language of ['english', 'arabic'] as const) {
      for (const row of buildPrayerDay('2026-08-25', dayTimes, settings, language)) {
        assert.notEqual(row.secondary, row.label,
          `${language}: a row never prints its own name twice`);
        if (language === 'english') {
          assert.notEqual(row.secondary, '', 'English rows keep the Arabic beside them');
        } else {
          assert.equal(row.secondary, '', 'Arabic rows have nothing to add');
        }
        // The Arabic itself is always carried, drawn or not: the settings screen
        // prints it whatever the language, because that is where the language is
        // chosen and a row that renamed itself as you changed it would be a
        // puzzle of its own.
        assert.notEqual(row.arabic, '', 'the Arabic name is always available');
      }
    }
  }
}

console.log('\nALL PASS (prayerTimes)');
