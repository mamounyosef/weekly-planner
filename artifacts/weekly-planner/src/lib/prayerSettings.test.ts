// Tests the editable half of the prayer settings.
//
// THE ONES THAT MATTER:
//
//  • Normalising twice must equal normalising once. These settings travel over a
//    per-FIELD sync, so a value that keeps changing shape is a field two devices
//    rewrite at each other forever while agreeing about what it means.
//
//  • A blank city must never become "Amman". The loader falls back to the app
//    default, which is right when reading a file and catastrophic when a person
//    has just cleared the field to retype it: their real city would be silently
//    restored and written to the PC.
//
//  • A change of city, country, method or school must present as a MISSING
//    month, not as a fresh one. If the lookup ever matched loosely, the phone
//    would show the old city's times under the new city's name, which is
//    unnoticeable and wrong in the one place accuracy is the entire point.
//
// Run with: npx tsx src/lib/prayerSettings.test.ts

import assert from 'node:assert/strict';
import {
  PRAYER_COLOURS,
  PRAYER_MONTH_ARCHIVE_MAX_AGE_MS,
  PRAYER_MONTH_MAX_AGE_MS,
  PRAYER_OFFSET_LIMIT,
  PRAYER_SCHOOLS,
  PRAYER_STYLES,
  aladhanCalendarUrl,
  applyPrayerPatch,
  describeOffset,
  describePrayerConfig,
  describePrayerFreshness,
  describePrayerVisibility,
  isPrayerVisible,
  lookupPrayerMonth,
  normalisePrayerSettings,
  parseAladhanCalendar,
  prayerMethodLabel,
  prayerMonthKey,
  prayerMonthState,
  prayerSchoolLabel,
  readCachedDays,
  withPrayerOffset,
  withPrayerVisible,
  writablePrayerRecord,
} from './prayerSettings';
import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_HORIZON_MAX,
  PRAYER_HORIZON_MIN,
  PRAYER_KEYS,
  PRAYER_METHODS,
  buildPrayerDay,
  coercePrayerSettings,
  type PrayerKey,
  type PrayerSettings,
} from './prayerTimes';

const BASE = DEFAULT_PRAYER_SETTINGS;

/** A settings object with the given overrides, already canonical. */
function settings(patch: Partial<PrayerSettings> = {}): PrayerSettings {
  return normalisePrayerSettings({ ...BASE, ...patch });
}

/** One cache entry, as the shared `prayerTimes` store holds it. */
function entry(fetchedAt: number | undefined, days: Record<string, Record<string, string>>) {
  return fetchedAt === undefined ? { days } : { fetchedAt, days };
}

const MONTH_DAYS = {
  '2026-08-01': { fajr: '04:19', sunrise: '05:47', dhuhr: '12:41', asr: '16:18', maghrib: '19:34', isha: '20:58' },
  '2026-08-02': { fajr: '04:20', sunrise: '05:48', dhuhr: '12:41', asr: '16:18', maghrib: '19:33', isha: '20:57' },
};

function main() {
  console.log('--- 1. NORMALISING TWICE CHANGES NOTHING ---');
  {
    // Every input that could possibly be canonicalised, run through twice. This
    // is the property the sync layer depends on, so it is checked first and on
    // the widest set of inputs in the file.
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      '',
      'Amman',
      [],
      {},
      { ...BASE },
      { city: '  Amman  ', country: '  Jordan ' },
      { color: '#34D399' },
      { offsets: { fajr: 0.4, dhuhr: -0.4, asr: 0, maghrib: 3.5, isha: -3.5 } },
      { offsets: { fajr: 999, isha: -999, asr: NaN, dhuhr: Infinity, maghrib: '5' } },
      { hidden: ['sunrise'], showSunrise: true },
      { hidden: ['isha', 'fajr', 'nope', 'sunrise', 'fajr'] },
      { horizonDays: 0.4 },
      { horizonDays: 100000 },
      { horizonDays: -5 },
      { method: 4, school: 1, style: 'row', showInWidget: false },
      { unknownField: 'kept elsewhere', another: { deep: true } },
      { enabled: 'yes', city: 42, country: null, method: '4', school: '1', style: 'blob', color: 'green' },
    ];

    for (const [n, input] of inputs.entries()) {
      const once = normalisePrayerSettings(input);
      const twice = normalisePrayerSettings(once);
      assert.deepEqual(twice, once, `case ${n}: normalising is idempotent`);

      // And through the patch path too, which is the one the screen uses.
      const patched = applyPrayerPatch(once, {});
      assert.deepEqual(patched, once, `case ${n}: an empty patch is a no-op`);
    }

    // The specific trap: a fractional offset that rounds to zero must be gone,
    // not stored as a zero the next pass would remove.
    const rounded = normalisePrayerSettings({ offsets: { fajr: 0.4, dhuhr: -0.49 } });
    assert.deepEqual(rounded.offsets, {}, 'an offset that rounds to zero is dropped outright');
    assert.ok(!('fajr' in rounded.offsets), 'and the key is absent, not present-and-zero');
  }

  console.log('--- 2. EVERY METHOD AND EVERY SCHOOL SURVIVES A ROUND TRIP ---');
  {
    assert.ok(PRAYER_METHODS.length >= 20, 'the full authority list is present');
    for (const m of PRAYER_METHODS) {
      for (const school of [0, 1] as const) {
        const s = normalisePrayerSettings({ ...BASE, method: m.id, school });
        assert.equal(s.method, m.id, `method ${m.id} (${m.label}) is kept`);
        assert.equal(s.school, school, `school ${school} is kept with method ${m.id}`);
        assert.equal(prayerMethodLabel(m.id), m.label, `method ${m.id} names itself`);

        // The key has to separate them, or two configurations share one cache.
        const key = prayerMonthKey(s, 2026, 8);
        assert.ok(key.includes(`|${m.id}|${school}|`), `${key} carries method and school`);
      }
    }

    // Method 0 is a real id (Shia Ithna-Ashari) and must not be read as absent.
    assert.equal(normalisePrayerSettings({ ...BASE, method: 0 }).method, 0, 'method 0 is a method');

    // An id nobody publishes falls back rather than being stored.
    assert.equal(normalisePrayerSettings({ ...BASE, method: 9999 }).method, BASE.method, 'unknown method falls back');
    assert.equal(normalisePrayerSettings({ ...BASE, method: -1 }).method, BASE.method, 'negative method falls back');
    assert.equal(normalisePrayerSettings({ ...BASE, school: 2 as any }).school, BASE.school, 'school 2 does not exist');
    assert.equal(normalisePrayerSettings({ ...BASE, school: '1' as any }).school, BASE.school, 'school is a number, not a string');

    for (const s of PRAYER_SCHOOLS) assert.equal(prayerSchoolLabel(s.id), s.label, `${s.label} names itself`);
    assert.equal(PRAYER_STYLES.length, 3, 'three ways to draw a prayer');
  }

  console.log('--- 3. A CLEARED CITY KEEPS THE OLD ONE ---');
  {
    const current = settings({ city: 'Irbid', country: 'Jordan' });

    for (const blank of ['', '   ', '\t\n ', undefined, null, 0, 42, [], {}] as unknown[]) {
      const next = applyPrayerPatch(current, { city: blank as any });
      assert.equal(next.city, 'Irbid', `city "${String(blank)}" is not an answer`);
      const nextCountry = applyPrayerPatch(current, { country: blank as any });
      assert.equal(nextCountry.country, 'Jordan', `country "${String(blank)}" is not an answer`);
    }

    // But a real change is a real change, and undefined means "no opinion".
    assert.equal(applyPrayerPatch(current, { city: 'Zarqa' }).city, 'Zarqa', 'a typed city is taken');
    assert.equal(applyPrayerPatch(current, { city: undefined }).city, 'Irbid', 'undefined leaves it alone');

    // Reading a record with no city at all still gets the app default, because
    // there is nothing else to fall back to. That is the loader's job, kept.
    assert.equal(normalisePrayerSettings({}).city, BASE.city, 'an empty record uses the app default');
  }

  console.log('--- 4. CITIES ARE TRIMMED, NEVER TRANSLITERATED ---');
  {
    const cases: Array<[string, string]> = [
      ['  Amman  ', 'Amman'],
      ['\tAmman\n', 'Amman'],
      ['عمان', 'عمان'],
      ['  عمان  ', 'عمان'],
      ['İstanbul', 'İstanbul'],
      ["Sant'Angelo", "Sant'Angelo"],
      ['Stoke-on-Trent', 'Stoke-on-Trent'],
      ['Washington, D.C.', 'Washington, D.C.'],
      ['São Paulo', 'São Paulo'],
      ['Xi’an', 'Xi’an'],
      ['Ma`an', 'Ma`an'],
      ['al-Quds  ', 'al-Quds'],
      ['A'.repeat(200), 'A'.repeat(200)],
    ];

    for (const [input, expected] of cases) {
      const s = applyPrayerPatch(settings(), { city: input });
      assert.equal(s.city, expected, `"${input}" is stored as "${expected}"`);
      // Interior spacing and punctuation are the user's business: Aladhan
      // geocodes the string, so mangling it changes which place is asked about.
      assert.equal(normalisePrayerSettings(s).city, expected, 'and stays that way');
    }

    // The url has to carry those characters intact, escaped rather than dropped.
    const arabic = settings({ city: 'عمان', country: 'الأردن' });
    const url = aladhanCalendarUrl(arabic, 2026, 8);
    assert.ok(url.startsWith('https://api.aladhan.com/v1/calendarByCity/2026/8?'), 'the url names the month');
    assert.ok(url.includes(`city=${encodeURIComponent('عمان')}`), 'the city is percent encoded');
    assert.ok(url.includes(`country=${encodeURIComponent('الأردن')}`), 'so is the country');
    assert.ok(!/[ ]/.test(url), 'and no raw spaces reach the url');
    assert.ok(aladhanCalendarUrl(settings({ city: 'Washington, D.C.' }), 2026, 1)
      .includes('city=Washington%2C%20D.C.'), 'punctuation is escaped, not stripped');
  }

  console.log('--- 5. OFFSETS: NEGATIVE, HUGE, FRACTIONAL AND NOT A NUMBER ---');
  {
    const cases: Array<[unknown, number | undefined]> = [
      [0, undefined],
      [-0, undefined],
      [0.4, undefined],
      [-0.4, undefined],
      [0.5, 1],
      [-0.5, -0],          // rounds towards +0 in JS, and -0 !== 0 is false, so dropped
      [1, 1],
      [-1, -1],
      [3.5, 4],
      [-3.5, -3],
      [60, 60],
      [-60, -60],
      [61, 60],
      [-61, -60],
      [99999, 60],
      [-99999, -60],
      [Number.MAX_SAFE_INTEGER, 60],
      [Number.MIN_SAFE_INTEGER, -60],
      [NaN, undefined],
      [Infinity, undefined],
      [-Infinity, undefined],
      ['5', undefined],
      [null, undefined],
      [true, undefined],
      [{ minutes: 5 }, undefined],
      [[5], undefined],
    ];

    for (const [input, expected] of cases) {
      const s = normalisePrayerSettings({ ...BASE, offsets: { fajr: input } as any });
      if (expected === undefined || Object.is(expected, -0)) {
        assert.deepEqual(s.offsets, {}, `offset ${String(input)} is not stored`);
      } else {
        assert.equal(s.offsets.fajr, expected, `offset ${String(input)} becomes ${expected}`);
      }
      assert.deepEqual(normalisePrayerSettings(s), s, `offset ${String(input)} is stable`);
    }

    // Clamping is symmetric and matches the advertised limit.
    assert.equal(PRAYER_OFFSET_LIMIT, 60, 'the limit the stepper draws is the limit stored');

    // Every prayer can hold its own, all at once.
    const all = normalisePrayerSettings({
      ...BASE,
      offsets: { fajr: -5, sunrise: 2, dhuhr: 1, asr: -1, maghrib: 3, isha: -2 },
    });
    assert.deepEqual(all.offsets, { fajr: -5, sunrise: 2, dhuhr: 1, asr: -1, maghrib: 3, isha: -2 },
      'six independent corrections');

    // Setting one to zero removes it and leaves the others untouched.
    const cleared = withPrayerOffset(all, 'dhuhr', 0);
    assert.ok(!('dhuhr' in cleared.offsets), 'zero removes the correction');
    assert.equal(cleared.offsets.fajr, -5, 'and the others survive');
    assert.equal(withPrayerOffset(all, 'asr', 12).offsets.asr, 12, 'a new value replaces the old');
    assert.equal(withPrayerOffset(all, 'asr', 500).offsets.asr, 60, 'and is clamped on the way in');

    // An offsets value that is not an object at all falls back rather than throwing.
    for (const bad of [null, 'x', 5, true] as unknown[]) {
      const s = normalisePrayerSettings({ ...BASE, offsets: bad as any });
      assert.deepEqual(s.offsets, {}, `offsets: ${String(bad)} reads as none`);
    }
    // An array is an object, so its numeric keys simply do not match a prayer.
    assert.deepEqual(normalisePrayerSettings({ ...BASE, offsets: [1, 2, 3] as any }).offsets, {},
      'an array of offsets names no prayer');
  }

  console.log('--- 6. AN OFFSET NEVER PUSHES A PRAYER ONTO ANOTHER DAY ---');
  {
    // Forwards: an Isha late at night, nudged an hour later, must stay tonight.
    const late = { isha: '23:30', fajr: '04:19' };
    const forward = buildPrayerDay('2026-08-01', late, settings({ offsets: { isha: 60 } }));
    const isha = forward.find(o => o.key === 'isha')!;
    assert.equal(isha.time, '23:59', 'Isha is pinned to the end of its own day');
    assert.ok(isha.minutes <= 1439, 'and its minutes stay inside the day');

    // Backwards: a Fajr just after midnight, nudged an hour earlier, must not
    // land on yesterday evening.
    const early = { fajr: '00:10', dhuhr: '12:41' };
    const backward = buildPrayerDay('2026-08-01', early, settings({ offsets: { fajr: -60 } }));
    const fajr = backward.find(o => o.key === 'fajr')!;
    assert.equal(fajr.time, '00:00', 'Fajr is pinned to the start of its own day');
    assert.ok(fajr.minutes >= 0, 'and its minutes stay inside the day');

    // The ordering the grid relies on holds even after a big correction.
    const shuffled = buildPrayerDay('2026-08-01', MONTH_DAYS['2026-08-01'],
      settings({ showSunrise: true, offsets: { fajr: 60, sunrise: -60 } }));
    for (let i = 1; i < shuffled.length; i += 1) {
      assert.ok(shuffled[i].minutes >= shuffled[i - 1].minutes, 'the day stays in time order');
    }

    // And the id stays keyed to the day it was drawn on, so ticking it off marks
    // the right date no matter how far the time was nudged.
    assert.equal(isha.id, '2026-08-01::isha', 'the id follows the date, not the clock');
  }

  console.log('--- 7. EVERY PRAYER CAN BE HIDDEN, INDIVIDUALLY AND TOGETHER ---');
  {
    const prayers = PRAYER_KEYS.filter(k => k !== 'sunrise');

    for (const k of prayers) {
      const s = withPrayerVisible(settings(), k, false);
      assert.deepEqual(s.hidden, [k], `${k} alone is hidden`);
      assert.equal(isPrayerVisible(s, k), false, `${k} reports itself hidden`);
      for (const other of prayers) {
        if (other !== k) assert.equal(isPrayerVisible(s, other), true, `${other} is untouched`);
      }
      const drawn = buildPrayerDay('2026-08-01', MONTH_DAYS['2026-08-01'], s);
      assert.ok(!drawn.some(o => o.key === k), `${k} is not drawn`);
      assert.equal(drawn.length, prayers.length - 1, 'and the rest still are');

      // Showing it again is an exact undo.
      assert.deepEqual(withPrayerVisible(s, k, true), settings(), `${k} comes back`);
    }

    // All of them at once.
    let none = settings();
    for (const k of prayers) none = withPrayerVisible(none, k, false);
    assert.deepEqual(none.hidden, prayers, 'all five hidden, in prayer order');
    assert.deepEqual(buildPrayerDay('2026-08-01', MONTH_DAYS['2026-08-01'], none), [],
      'and nothing is drawn');
    assert.equal(describePrayerVisibility(none),
      'Every prayer is hidden, so nothing is drawn on the calendar.', 'and it says so plainly');

    // Sunrise is governed by its own switch and is never written into `hidden`.
    const withSunrise = withPrayerVisible(settings(), 'sunrise', true);
    assert.equal(withSunrise.showSunrise, true, 'Sunrise is switched on');
    assert.deepEqual(withSunrise.hidden, [], 'without touching the hidden list');
    const noSunrise = withPrayerVisible(withSunrise, 'sunrise', false);
    assert.equal(noSunrise.showSunrise, false, 'and off again');
    assert.deepEqual(noSunrise.hidden, [], 'still without touching it');

    // A record that says it both ways is resolved towards hidden, once.
    const contradictory = normalisePrayerSettings({ ...BASE, hidden: ['sunrise'], showSunrise: true });
    assert.equal(contradictory.showSunrise, false, 'listing Sunrise as hidden hides it');
    assert.deepEqual(contradictory.hidden, [], 'and the duplicate control is dropped');
    assert.equal(isPrayerVisible(contradictory, 'sunrise'), false, 'consistently');

    // Everything hidden AND Sunrise on is a legal, if unusual, configuration.
    const onlySunrise = withPrayerVisible(none, 'sunrise', true);
    assert.equal(describePrayerVisibility(onlySunrise), 'Every prayer is hidden. Only Sunrise is shown.',
      'which the sentence covers');
    assert.deepEqual(buildPrayerDay('2026-08-01', MONTH_DAYS['2026-08-01'], onlySunrise).map(o => o.key),
      ['sunrise'], 'and only Sunrise is drawn');

    // Rubbish in the hidden list is filtered, deduplicated and sorted.
    const messy = normalisePrayerSettings({ ...BASE, hidden: ['isha', 'fajr', 'isha', 'lunch', 7, null] as any });
    assert.deepEqual(messy.hidden, ['fajr', 'isha'], 'only real prayers, in order, once each');
    assert.deepEqual(normalisePrayerSettings({ ...BASE, hidden: 'fajr' as any }).hidden, BASE.hidden,
      'a string is not a list');
  }

  console.log('--- 8. MISSING FIELDS AND UNKNOWN FIELDS ---');
  {
    // Nothing at all.
    for (const empty of [undefined, null, {}, 0, '', false, [], 'prayer'] as unknown[]) {
      assert.deepEqual(normalisePrayerSettings(empty), normalisePrayerSettings(BASE),
        `${String(empty)} reads as the defaults`);
    }

    // One field at a time, everything else absent.
    const partials: Array<[Record<string, unknown>, Partial<PrayerSettings>]> = [
      [{ city: 'Cairo' }, { city: 'Cairo' }],
      [{ enabled: false }, { enabled: false }],
      [{ school: 1 }, { school: 1 }],
      [{ style: 'row' }, { style: 'row' }],
      [{ horizonDays: 7 }, { horizonDays: 7 }],
      [{ showInWidget: false }, { showInWidget: false }],
      [{ color: '#F472B6' }, { color: '#f472b6' }],
    ];
    for (const [input, expected] of partials) {
      assert.deepEqual(normalisePrayerSettings(input), { ...normalisePrayerSettings(BASE), ...expected },
        `${JSON.stringify(input)} changes only what it names`);
    }

    // Extra fields are not settings, and are not carried into the typed view.
    const extra = normalisePrayerSettings({
      ...BASE, qibla: 138.7, madhab: 'hanafi', notify: { enabled: true }, __proto__: { evil: true },
    } as any);
    assert.ok(!('qibla' in extra), 'an unknown field is not adopted');
    assert.ok(!('madhab' in extra), 'nor a near miss for one we do model');
    assert.deepEqual(Object.keys(extra).sort(), Object.keys(BASE).sort(), 'the shape is exactly the model');

    // But it survives the WRITE, so a newer PC field is not deleted by an older phone.
    const raw = { ...BASE, qibla: 138.7, futureSwitch: true };
    const written = writablePrayerRecord(raw, applyPrayerPatch(raw, { city: 'Cairo' }));
    assert.equal(written.qibla, 138.7, 'the unknown field rides along');
    assert.equal(written.futureSwitch, true, 'all of them do');
    assert.equal(written.city, 'Cairo', 'alongside the change');
    assert.deepEqual(writablePrayerRecord(null, settings()), { ...settings() }, 'and a null record is fine');

    // A horizon outside the allowed band is pulled in, not rejected.
    assert.equal(normalisePrayerSettings({ horizonDays: -100 }).horizonDays, PRAYER_HORIZON_MIN, 'clamped low');
    assert.equal(normalisePrayerSettings({ horizonDays: 1e9 }).horizonDays, PRAYER_HORIZON_MAX, 'clamped high');
    assert.equal(normalisePrayerSettings({ horizonDays: 30.6 }).horizonDays, 31, 'rounded');
    assert.equal(normalisePrayerSettings({ horizonDays: NaN }).horizonDays, BASE.horizonDays, 'NaN falls back');
    assert.equal(normalisePrayerSettings({ horizonDays: '30' as any }).horizonDays, BASE.horizonDays,
      'a string falls back');

    // Colours: the eight offered are all accepted as written.
    for (const hex of PRAYER_COLOURS) {
      assert.equal(normalisePrayerSettings({ color: hex }).color, hex, `${hex} is kept`);
      assert.equal(normalisePrayerSettings({ color: hex.toUpperCase() }).color, hex, 'case folded');
    }
    for (const bad of ['#fff', 'red', '34d399', '#34d3990', '', null, 0x34d399] as unknown[]) {
      assert.equal(normalisePrayerSettings({ color: bad as any }).color, BASE.color, `${String(bad)} is not a colour`);
    }
  }

  console.log('--- 9. THIS MODULE AND THE LOADER AGREE ---');
  {
    // The PC reads settings with `coercePrayerSettings`. Anything this editor
    // writes has to survive that read unchanged, or the phone would appear to
    // save a value the PC then ignores.
    const written: PrayerSettings[] = [
      settings(),
      settings({ city: 'İstanbul', country: 'Türkiye', method: 13, school: 1 }),
      settings({ hidden: ['fajr', 'isha'], showSunrise: true, offsets: { asr: -7 }, horizonDays: 3 }),
      settings({ enabled: false, style: 'row', color: '#22d3ee', showInWidget: false }),
    ];
    for (const s of written) {
      assert.deepEqual(coercePrayerSettings(s), s, `the loader reads back ${s.city} exactly as written`);
    }
  }

  console.log('--- 10. A CACHED MONTH GOES STALE ON TIME ---');
  {
    const now = new Date('2026-08-15T12:00:00');
    const nowMs = now.getTime();

    // The month being looked at right now: trusted for a day.
    assert.equal(prayerMonthState(entry(nowMs, MONTH_DAYS), 2026, 8, now), 'fresh', 'just fetched');
    assert.equal(prayerMonthState(entry(nowMs - PRAYER_MONTH_MAX_AGE_MS + 1000, MONTH_DAYS), 2026, 8, now),
      'fresh', 'just under a day old');
    assert.equal(prayerMonthState(entry(nowMs - PRAYER_MONTH_MAX_AGE_MS, MONTH_DAYS), 2026, 8, now),
      'stale', 'exactly a day old');
    assert.equal(prayerMonthState(entry(nowMs - PRAYER_MONTH_MAX_AGE_MS - 1, MONTH_DAYS), 2026, 8, now),
      'stale', 'over a day old');

    // Any other month: a full thirty days, because it is not drifting.
    for (const [y, m, what] of [[2026, 9, 'next month'], [2026, 7, 'last month'],
      [2027, 1, 'next year'], [2025, 12, 'last year']] as Array<[number, number, string]>) {
      assert.equal(prayerMonthState(entry(nowMs - PRAYER_MONTH_MAX_AGE_MS * 2, MONTH_DAYS), y, m, now),
        'fresh', `${what} is not refetched daily`);
      assert.equal(prayerMonthState(entry(nowMs - PRAYER_MONTH_ARCHIVE_MAX_AGE_MS, MONTH_DAYS), y, m, now),
        'stale', `${what} does expire eventually`);
    }

    // The month boundary: the same entry, one midnight apart.
    const lastOfMonth = new Date('2026-08-31T23:59:00');
    const firstOfNext = new Date('2026-09-01T00:01:00');
    const twoDaysOld = (d: Date) => entry(d.getTime() - 2 * PRAYER_MONTH_MAX_AGE_MS, MONTH_DAYS);
    assert.equal(prayerMonthState(twoDaysOld(lastOfMonth), 2026, 8, lastOfMonth), 'stale',
      'August is the current month on the 31st, so a two day old copy is stale');
    assert.equal(prayerMonthState(twoDaysOld(firstOfNext), 2026, 8, firstOfNext), 'fresh',
      'and the moment September starts, August stops being refetched daily');

    // The year boundary behaves the same way, with December and January.
    const newYearsEve = new Date('2026-12-31T23:00:00');
    const newYearsDay = new Date('2027-01-01T01:00:00');
    assert.equal(prayerMonthState(twoDaysOld(newYearsEve), 2026, 12, newYearsEve), 'stale',
      'December is current on the 31st');
    assert.equal(prayerMonthState(twoDaysOld(newYearsDay), 2026, 12, newYearsDay), 'fresh',
      'and is history an hour later');
    assert.equal(prayerMonthState(twoDaysOld(newYearsDay), 2027, 1, newYearsDay), 'stale',
      'while January has become the current one');
    // The year is part of the comparison, not just the month number.
    assert.equal(prayerMonthState(twoDaysOld(newYearsDay), 2026, 1, newYearsDay), 'fresh',
      'January of last year is not January of this one');

    // A leap day is an ordinary day of an ordinary current month.
    const leapDay = new Date('2028-02-29T09:00:00');
    assert.equal(prayerMonthState(entry(leapDay.getTime() - 1000, MONTH_DAYS), 2028, 2, leapDay), 'fresh',
      'fetched on the 29th');
    assert.equal(prayerMonthState(twoDaysOld(leapDay), 2028, 2, leapDay), 'stale',
      'and stale two days later, leap year or not');
    assert.equal(prayerMonthKey(settings(), 2028, 2), `${prayerMonthKey(settings(), 2028, 2)}`,
      'and February keys the same either way');

    // Degenerate entries.
    assert.equal(prayerMonthState(undefined, 2026, 8, now), 'missing', 'nothing cached');
    assert.equal(prayerMonthState(null, 2026, 8, now), 'missing', 'null is nothing');
    assert.equal(prayerMonthState({}, 2026, 8, now), 'missing', 'an entry with no days is nothing');
    assert.equal(prayerMonthState(entry(nowMs, {}), 2026, 8, now), 'missing', 'an empty month is nothing');
    assert.equal(prayerMonthState({ days: MONTH_DAYS }, 2026, 8, now), 'stale',
      'days with no timestamp are usable but unvouched for');
    assert.equal(prayerMonthState(entry(nowMs + 5 * 86_400_000, MONTH_DAYS), 2026, 8, now), 'stale',
      'a timestamp from the future is a wrong clock, not a fresh fetch');
    assert.equal(prayerMonthState('a month' as any, 2026, 8, now), 'missing', 'a string is not an entry');
  }

  console.log('--- 11. CHANGING THE PLACE OR THE METHOD EMPTIES THE CACHE ---');
  {
    const now = new Date('2026-08-15T12:00:00');
    const base = settings({ city: 'Amman', country: 'Jordan', method: 23, school: 0 });
    const cache: Record<string, unknown> = {
      [prayerMonthKey(base, 2026, 8)]: entry(now.getTime(), MONTH_DAYS),
    };

    const hit = lookupPrayerMonth(cache, base, 2026, 8, now);
    assert.equal(hit.state, 'fresh', 'the configuration that was fetched hits');
    assert.equal(hit.source, 'exact', 'and reads its own entry');
    assert.deepEqual(Object.keys(hit.days), Object.keys(MONTH_DAYS), 'with its days');

    // Each of the four identity fields, changed on its own.
    const changes: Array<[string, PrayerSettings]> = [
      ['city', applyPrayerPatch(base, { city: 'Irbid' })],
      ['country', applyPrayerPatch(base, { country: 'Palestine' })],
      ['method', applyPrayerPatch(base, { method: 5 })],
      ['school', applyPrayerPatch(base, { school: 1 })],
    ];
    for (const [what, next] of changes) {
      const miss = lookupPrayerMonth(cache, next, 2026, 8, now);
      assert.equal(miss.state, 'missing', `changing the ${what} misses the cache`);
      assert.notEqual(miss.key, hit.key, `and asks for a different key`);
      // But it does not go blank: the old month is offered, clearly labelled.
      assert.equal(miss.source, 'other', `the previous ${what}'s times are offered meanwhile`);
      assert.equal(miss.fallbackKey, hit.key, 'named as the entry they came from');
      assert.deepEqual(Object.keys(miss.days), Object.keys(MONTH_DAYS), 'so the list never empties');
      assert.equal(describePrayerFreshness(miss, now),
        'Showing the times saved for your previous location while the new ones are fetched.',
        'and the screen can say which');
    }

    // A setting that is NOT part of the identity must not throw the cache away.
    for (const [what, next] of [
      ['colour', applyPrayerPatch(base, { color: '#f472b6' })],
      ['style', applyPrayerPatch(base, { style: 'row' })],
      ['horizon', applyPrayerPatch(base, { horizonDays: 3 })],
      ['an offset', withPrayerOffset(base, 'fajr', -3)],
      ['visibility', withPrayerVisible(base, 'isha', false)],
      ['Sunrise', withPrayerVisible(base, 'sunrise', true)],
      ['the widget switch', applyPrayerPatch(base, { showInWidget: false })],
      ['the master switch', applyPrayerPatch(base, { enabled: false })],
    ] as Array<[string, PrayerSettings]>) {
      const still = lookupPrayerMonth(cache, next, 2026, 8, now);
      assert.equal(still.state, 'fresh', `changing ${what} keeps the cached month`);
      assert.equal(still.key, hit.key, 'because the key is unchanged');
    }

    // Trimming means "Amman" and "  Amman  " are one configuration, not two.
    assert.equal(
      prayerMonthKey(applyPrayerPatch(base, { city: '  Amman  ' }), 2026, 8),
      prayerMonthKey(base, 2026, 8),
      'whitespace does not fork the cache',
    );

    // Nothing on hand at all.
    assert.deepEqual(lookupPrayerMonth({}, base, 2026, 8, now),
      { key: prayerMonthKey(base, 2026, 8), state: 'missing', source: 'none', days: {}, fetchedAt: null, fallbackKey: null },
      'an empty cache is honest about it');
    assert.equal(lookupPrayerMonth(undefined, base, 2026, 8, now).source, 'none', 'so is no cache at all');
    assert.equal(lookupPrayerMonth(null, base, 2026, 8, now).source, 'none', 'and a null one');

    // The fallback only ever borrows from the SAME month.
    const otherMonth = { [prayerMonthKey(base, 2026, 7)]: entry(now.getTime(), MONTH_DAYS) };
    assert.equal(lookupPrayerMonth(otherMonth, applyPrayerPatch(base, { city: 'Irbid' }), 2026, 8, now).source,
      'none', 'July never stands in for August');

    // With several old configurations to choose from, the newest wins.
    const many: Record<string, unknown> = {
      [prayerMonthKey(settings({ city: 'A' }), 2026, 8)]: entry(1000, { '2026-08-01': { fajr: '01:00' } }),
      [prayerMonthKey(settings({ city: 'B' }), 2026, 8)]: entry(9000, { '2026-08-01': { fajr: '02:00' } }),
      [prayerMonthKey(settings({ city: 'C' }), 2026, 8)]: entry(5000, { '2026-08-01': { fajr: '03:00' } }),
    };
    const newest = lookupPrayerMonth(many, settings({ city: 'D' }), 2026, 8, now);
    assert.equal(newest.days['2026-08-01'].fajr, '02:00', 'the most recently fetched stand-in is used');
    assert.equal(newest.fetchedAt, 9000, 'and its timestamp is reported, not invented');

    // A stale exact entry is still preferred over a fresh entry for elsewhere.
    const staleExact: Record<string, unknown> = {
      ...many,
      [prayerMonthKey(settings({ city: 'D' }), 2026, 8)]: entry(1, { '2026-08-01': { fajr: '04:00' } }),
    };
    const preferred = lookupPrayerMonth(staleExact, settings({ city: 'D' }), 2026, 8, now);
    assert.equal(preferred.state, 'stale', 'the right city, out of date');
    assert.equal(preferred.source, 'exact', 'is still the right city');
    assert.equal(preferred.days['2026-08-01'].fajr, '04:00', 'and its times are the ones shown');
  }

  console.log('--- 12. READING WHAT IS IN THE CACHE ---');
  {
    assert.deepEqual(readCachedDays(undefined), {}, 'nothing');
    assert.deepEqual(readCachedDays({}), {}, 'no days');
    assert.deepEqual(readCachedDays({ days: null }), {}, 'null days');
    assert.deepEqual(readCachedDays({ days: [] }), {}, 'an array of days');
    assert.deepEqual(readCachedDays({ days: { 'yesterday': { fajr: '04:19' } } }), {},
      'a key that is not a date');
    assert.deepEqual(readCachedDays({ days: { '2026-08-01': { fajr: 'noon' } } }), {},
      'a day with nothing parseable is dropped entirely');
    assert.deepEqual(readCachedDays({ days: { '2026-08-01': { fajr: '04:19 (+03)', lunch: '13:00' } } }),
      { '2026-08-01': { fajr: '04:19' } },
      'the timezone suffix is stripped and a non prayer ignored');
    assert.deepEqual(readCachedDays({ days: { '2026-08-01': { fajr: '4:19' } } }),
      { '2026-08-01': { fajr: '04:19' } }, 'a single digit hour is padded');
    assert.deepEqual(readCachedDays({ days: { '2026-08-01': { fajr: '25:00' } } }), {},
      'an impossible hour is not a time');
  }

  console.log('--- 13. ALADHAN REPLIES, INCLUDING BROKEN ONES ---');
  {
    const reply = {
      data: [
        { date: { gregorian: { date: '01-08-2026' } }, timings: { Fajr: '04:19 (+03)', Sunrise: '05:47 (+03)', Dhuhr: '12:41 (+03)', Asr: '16:18 (+03)', Maghrib: '19:34 (+03)', Isha: '20:58 (+03)' } },
        { date: { gregorian: { date: '02-08-2026' } }, timings: { Fajr: '04:20 (+03)', Dhuhr: '12:41 (+03)' } },
      ],
    };
    const days = parseAladhanCalendar(reply);
    // Day first, month second. Reading it the other way round would put August
    // 1st on January 8th and nothing would look obviously wrong.
    assert.deepEqual(Object.keys(days), ['2026-08-01', '2026-08-02'], 'dates are day first');
    assert.equal(days['2026-08-01'].fajr, '04:19', 'the offset suffix is dropped');
    assert.equal(days['2026-08-01'].isha, '20:58', 'every prayer is picked up');
    assert.equal(days['2026-08-02'].asr, undefined, 'a partial day keeps only what it has');

    // What it produces must be exactly what the cache stores, so a month the
    // phone fetched and a month the PC fetched are indistinguishable.
    assert.deepEqual(readCachedDays({ days }), days, 'a fetched month is already cache shaped');

    for (const broken of [
      undefined, null, {}, { data: null }, { data: {} }, { data: [] }, 'nope', 42,
      { data: [null] }, { data: [{}] },
      { data: [{ date: { gregorian: { date: '2026-08-01' } }, timings: { Fajr: '04:19' } }] },
      { data: [{ date: { gregorian: {} }, timings: { Fajr: '04:19' } }] },
      { data: [{ date: { gregorian: { date: '01-08-2026' } } }] },
      { data: [{ date: { gregorian: { date: '01-08-2026' } }, timings: null }] },
      { data: [{ date: { gregorian: { date: '01-08-2026' } }, timings: { Fajr: 'soon' } }] },
    ] as unknown[]) {
      assert.deepEqual(parseAladhanCalendar(broken), {}, `${JSON.stringify(broken)} yields nothing, and throws nothing`);
    }

    // One usable row among rubbish is still worth having.
    const mixed = parseAladhanCalendar({ data: [null, { date: { gregorian: { date: '03-08-2026' } }, timings: { Fajr: '04:21' } }, 'x'] });
    assert.deepEqual(mixed, { '2026-08-03': { fajr: '04:21' } }, 'the good row survives its neighbours');
  }

  console.log('--- 14. THE SENTENCES A PERSON READS ---');
  {
    assert.equal(
      describePrayerConfig(settings({ city: 'Amman', country: 'Jordan', method: 23, school: 0 })),
      'Amman, Jordan · Ministry of Awqaf, Jordan · Standard Asr',
    );
    assert.equal(
      describePrayerConfig(settings({ city: 'İstanbul', country: 'Türkiye', method: 13, school: 1 })),
      'İstanbul, Türkiye · Diyanet İşleri Başkanlığı, Turkey · Hanafi Asr',
    );

    assert.equal(describeOffset(0), 'On the calculated time');
    assert.equal(describeOffset(-0), 'On the calculated time');
    assert.equal(describeOffset(0.4), 'On the calculated time');
    assert.equal(describeOffset(NaN), 'On the calculated time');
    assert.equal(describeOffset(1), '1 minute later');
    assert.equal(describeOffset(-1), '1 minute earlier');
    assert.equal(describeOffset(5), '5 minutes later');
    assert.equal(describeOffset(-60), '60 minutes earlier');

    assert.equal(describePrayerVisibility(settings()), 'All five prayers');
    assert.equal(describePrayerVisibility(settings({ showSunrise: true })), 'All five prayers, with Sunrise');
    assert.equal(describePrayerVisibility(settings({ hidden: ['fajr'] })), 'Fajr hidden');
    assert.equal(describePrayerVisibility(settings({ hidden: ['fajr', 'isha'] })), 'Fajr and Isha hidden');
    assert.equal(describePrayerVisibility(settings({ hidden: ['fajr', 'asr', 'isha'] })),
      'Fajr, Asr and Isha hidden');
    assert.equal(describePrayerVisibility(settings({ hidden: ['fajr', 'isha'], showSunrise: true })),
      'Fajr and Isha hidden, with Sunrise');

    const now = new Date('2026-08-15T12:00:00');
    const day = 86_400_000;
    const fresh = (at: number | null) => ({
      key: 'k', state: 'fresh' as const, source: 'exact' as const, days: {}, fetchedAt: at, fallbackKey: null,
    });
    assert.equal(describePrayerFreshness(fresh(now.getTime()), now), 'Updated today.');
    assert.equal(describePrayerFreshness(fresh(now.getTime() - day), now), 'Updated yesterday.');
    assert.equal(describePrayerFreshness(fresh(now.getTime() - 5 * day), now), 'Updated 5 days ago.');
    assert.equal(describePrayerFreshness(fresh(now.getTime() - 90 * day), now), 'Updated more than a month ago.');
    assert.equal(describePrayerFreshness(fresh(null), now), 'Saved times, of unknown age.');
    assert.equal(
      describePrayerFreshness({ ...fresh(null), state: 'missing', source: 'none' }, now),
      'No times saved for this month yet. They arrive the next time this phone or your PC can reach the internet.',
    );

    // The standing rule: no em or en dashes anywhere a person can read.
    const spoken = [
      describePrayerConfig(settings()),
      describePrayerVisibility(settings()),
      describePrayerVisibility(settings({ hidden: PRAYER_KEYS.filter(k => k !== 'sunrise') })),
      describeOffset(5),
      describeOffset(-5),
      describeOffset(0),
      describePrayerFreshness(fresh(now.getTime()), now),
      describePrayerFreshness({ ...fresh(null), state: 'missing', source: 'none' }, now),
      describePrayerFreshness({ ...fresh(1), state: 'missing', source: 'other', fallbackKey: 'x' }, now),
      ...PRAYER_SCHOOLS.map(s => `${s.label} ${s.hint}`),
      ...PRAYER_STYLES.map(s => `${s.label} ${s.hint}`),
    ];
    for (const line of spoken) {
      assert.ok(!/[–—]/.test(line), `no dashes in: ${line}`);
      assert.ok(line.trim().length > 0, 'and nothing is blank');
    }
  }

  console.log('--- 15. A WHOLE EDITING SESSION, IN ORDER ---');
  {
    // The sequence a person actually performs, to prove the pieces compose:
    // move city, correct a prayer, hide another, then think better of it.
    let s = settings();
    const seen = new Set<string>([prayerMonthKey(s, 2026, 8)]);

    s = applyPrayerPatch(s, { city: 'Cairo', country: 'Egypt' });
    s = applyPrayerPatch(s, { method: 5 });
    seen.add(prayerMonthKey(s, 2026, 8));
    s = withPrayerOffset(s, 'maghrib', 3);
    s = withPrayerVisible(s, 'sunrise', true);
    s = withPrayerVisible(s, 'asr', false);
    seen.add(prayerMonthKey(s, 2026, 8));

    assert.equal(s.city, 'Cairo');
    assert.equal(s.method, 5);
    assert.deepEqual(s.offsets, { maghrib: 3 });
    assert.deepEqual(s.hidden, ['asr']);
    assert.equal(s.showSunrise, true);
    assert.equal(seen.size, 2, 'only the location and method changed the cache key');
    assert.deepEqual(normalisePrayerSettings(s), s, 'and the result is canonical');

    s = withPrayerVisible(s, 'asr', true);
    s = withPrayerOffset(s, 'maghrib', 0);
    assert.deepEqual(s, applyPrayerPatch(settings(), { city: 'Cairo', country: 'Egypt', method: 5, showSunrise: true }),
      'undoing every change lands exactly back where it started');

    // And the times drawn from it are the times the cache holds, corrected.
    const drawn = buildPrayerDay('2026-08-01', MONTH_DAYS['2026-08-01'],
      withPrayerOffset(s, 'maghrib', 3));
    assert.equal(drawn.find(o => o.key === 'maghrib')!.time, '19:37', 'Maghrib is three minutes later');
    assert.equal(drawn.find(o => o.key === 'fajr')!.time, '04:19', 'and Fajr is untouched');
    assert.equal(drawn.length, 6, 'six entries, Sunrise included');
  }

  console.log('\nALL PASS (prayerSettings: normalising, patching, cache keys, staleness, Aladhan, wording)');
}

main();
