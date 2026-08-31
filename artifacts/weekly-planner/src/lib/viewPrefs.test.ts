// Tests the per-device view preferences.
//
// THE ONE THAT MATTERS: `start < end`, always, no matter what was stored or in
// which order the user moved the two controls. A window with end <= start does
// not throw anywhere. It produces a grid of zero or negative height, which on a
// phone is a blank screen with no error, no message and nothing at all to
// suggest that a setting caused it. The same is true of every other value here:
// the store hands back strings, the strings can be anything, and none of it may
// reach the grid.
//
// Run with: npx tsx src/lib/viewPrefs.test.ts

import assert from 'node:assert/strict';
import {
  BOOL_FALSE,
  BOOL_TRUE,
  DAY_HOUR_MAX,
  DAY_HOUR_MIN,
  DEFAULT_DAY_END_HOUR,
  DEFAULT_DAY_START_HOUR,
  DEFAULT_DAY_WINDOW,
  DEFAULT_SNAP_INTERVAL,
  DEFAULT_SPAN_AFTER,
  DEFAULT_SPAN_BEFORE,
  DEFAULT_SPAN_WINDOW,
  DEFAULT_SWIPE_VIEW_SWITCH,
  SNAP_INTERVALS,
  SPAN_DAYS_MAX,
  SPAN_DAYS_MIN,
  clampInt,
  coerceBool,
  coerceDayWindow,
  coerceInt,
  coerceSnapInterval,
  coerceSpanWindow,
  dayWindowSpan,
  describeDayWindow,
  encodeBool,
  formatHour,
  normalizeDayWindow,
  spanColumns,
  withDayEnd,
  withDayStart,
  type DayWindow,
  DEFAULT_PRAYER_APPEARANCE,
  coercePrayerAppearance,
  describePrayerAppearance,
  isHexColour,
  isPrayerDrawStyle,
  PRAYER_DRAW_STYLES,
} from './viewPrefs';

/** Every value a key-value store has ever been caught handing back. */
const RUBBISH: unknown[] = [
  null,
  undefined,
  '',
  '   ',
  'NaN',
  'Infinity',
  '-Infinity',
  'null',
  'undefined',
  'abc',
  '7abc',
  '{"start":7,"end":23}',
  '[7,23]',
  '{}',
  'true',
  '1e400',
  {},
  [],
  [7],
  true,
  false,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  () => 7,
  Symbol('7'),
];

/** Every legal window, which is few enough to enumerate exhaustively. */
function allWindows(): DayWindow[] {
  const out: DayWindow[] = [];
  for (let start = DAY_HOUR_MIN; start <= DAY_HOUR_MAX - 1; start += 1) {
    for (let end = start + 1; end <= DAY_HOUR_MAX; end += 1) out.push({ start, end });
  }
  return out;
}

/** The shape prefs.ts uses: numbers out to strings, strings back to numbers. */
const roundTripWindow = (w: DayWindow) => coerceDayWindow(String(w.start), String(w.end));

function main() {
  console.log('--- 1. START IS ALWAYS STRICTLY BEFORE END ---');
  {
    // The invariant, asserted against every route a value can take into a
    // window: reading storage, normalising, and moving either end.
    const probes: unknown[] = [...RUBBISH, -99, -1, 0, 1, 7, 12, 23, 24, 25, 99, 1e9, 7.5, -0];

    for (const a of probes) {
      for (const b of probes) {
        const w = coerceDayWindow(a, b);
        assert.ok(w.start < w.end, `coerceDayWindow(${String(a)}, ${String(b)}) -> ${w.start}..${w.end}`);
        assert.ok(Number.isInteger(w.start) && Number.isInteger(w.end), 'whole hours only');
        assert.ok(w.start >= DAY_HOUR_MIN && w.start <= DAY_HOUR_MAX - 1, 'start in range');
        assert.ok(w.end >= DAY_HOUR_MIN + 1 && w.end <= DAY_HOUR_MAX, 'end in range');
      }
    }

    for (const w of allWindows()) {
      for (const probe of probes) {
        const moved = withDayStart(w, probe);
        assert.ok(moved.start < moved.end, `withDayStart(${w.start}..${w.end}, ${String(probe)})`);
        assert.ok(moved.start >= 0 && moved.end <= 24, 'still inside the day');

        const movedEnd = withDayEnd(w, probe);
        assert.ok(movedEnd.start < movedEnd.end, `withDayEnd(${w.start}..${w.end}, ${String(probe)})`);
        assert.ok(movedEnd.start >= 0 && movedEnd.end <= 24, 'still inside the day');
      }
    }
  }

  console.log('--- 2. RUBBISH IN STORAGE FALLS BACK, NEVER THROWS ---');
  {
    for (const bad of RUBBISH) {
      const w = coerceDayWindow(bad, bad);
      assert.deepEqual(w, DEFAULT_DAY_WINDOW, `both ends ${String(bad)} -> the default window`);

      // One good half must not be dragged down by the other's rubbish.
      assert.deepEqual(coerceDayWindow('6', bad), { start: 6, end: DEFAULT_DAY_END_HOUR });
      assert.deepEqual(coerceDayWindow(bad, '20'), { start: DEFAULT_DAY_START_HOUR, end: 20 });

      assert.equal(coerceSnapInterval(bad), DEFAULT_SNAP_INTERVAL, `snap ${String(bad)}`);
      assert.deepEqual(coerceSpanWindow(bad, bad), DEFAULT_SPAN_WINDOW, `span ${String(bad)}`);
    }

    // Booleans are the exception: `true`/`false` ARE meaningful values, and the
    // strings 'true'/'false' are what older builds wrote.
    assert.equal(coerceBool(true, false), true, 'a real boolean is taken as itself');
    assert.equal(coerceBool(false, true), false);
    assert.equal(coerceBool('true', false), true, 'the legacy spelling still reads');
    assert.equal(coerceBool('FALSE', true), false, 'and is case insensitive');
    for (const bad of RUBBISH) {
      if (typeof bad === 'boolean' || bad === 'true') continue;
      assert.equal(coerceBool(bad, true), true, `bool ${String(bad)} -> fallback true`);
      assert.equal(coerceBool(bad, false), false, `bool ${String(bad)} -> fallback false`);
    }
  }

  console.log('--- 3. THE NAMED EDGE CASES, ONE BY ONE ---');
  {
    assert.deepEqual(coerceDayWindow(null, null), DEFAULT_DAY_WINDOW, 'never written');
    assert.deepEqual(coerceDayWindow('', ''), DEFAULT_DAY_WINDOW, 'empty string is not midnight');
    assert.deepEqual(coerceDayWindow('NaN', 'NaN'), DEFAULT_DAY_WINDOW, "a String(0/0) that escaped");
    assert.deepEqual(coerceDayWindow('Infinity', 'Infinity'), DEFAULT_DAY_WINDOW, 'no infinite grid');
    assert.deepEqual(coerceDayWindow('-5', '-5'), DEFAULT_DAY_WINDOW, 'negative hours');
    assert.deepEqual(coerceDayWindow('7.5', '22.5'), DEFAULT_DAY_WINDOW, 'floats are rejected, not rounded');
    assert.deepEqual(coerceDayWindow('999999', '1000000'), DEFAULT_DAY_WINDOW, 'far out of range');
    assert.deepEqual(coerceDayWindow('{"start":7}', '{"end":23}'), DEFAULT_DAY_WINDOW, 'a JSON blob');
    assert.deepEqual(coerceDayWindow({ start: 7 }, 23), { start: DEFAULT_DAY_START_HOUR, end: 23 },
      'an object is rejected; a real number beside it is not');
    assert.deepEqual(coerceDayWindow([], []), DEFAULT_DAY_WINDOW, 'Number([]) is 0 and must not be believed');
    assert.deepEqual(coerceDayWindow(true, false), DEFAULT_DAY_WINDOW, 'Number(true) is 1 and must not be believed');

    // Start equal to end, and start after end. Both are individually legal
    // numbers, and the pair is what breaks the grid.
    assert.deepEqual(coerceDayWindow('9', '9'), { start: 9, end: 10 }, 'equal ends are pushed apart');
    assert.deepEqual(coerceDayWindow('20', '6'), { start: 20, end: 21 }, 'end before start is repaired');
    assert.deepEqual(coerceDayWindow('23', '1'), { start: 23, end: 24 }, 'and at the very top of the day');

    // Both extremes.
    assert.deepEqual(coerceDayWindow('0', '24'), { start: 0, end: 24 }, 'the whole day is legal');
    // An END of 0 is not a short day, it is an out-of-range value: no window can
    // stop before it starts. It is refused like any other rubbish, and the start
    // beside it is still honoured.
    assert.deepEqual(coerceDayWindow('0', '0'), { start: 0, end: DEFAULT_DAY_END_HOUR });
    assert.deepEqual(coerceDayWindow('24', '24'), { start: DEFAULT_DAY_START_HOUR, end: 24 },
      'a start of 24 is out of range for a start and is refused; the end of 24 is legal');
    assert.deepEqual(coerceDayWindow('23', '24'), { start: 23, end: 24 }, 'the last legal hour');
    assert.deepEqual(coerceDayWindow('0', '1'), { start: 0, end: 1 }, 'the first legal hour');
  }

  console.log('--- 4. MOVING ONE END, IN EITHER ORDER ---');
  {
    // Moving the start carries the span with it, so a whole day shifts rather
    // than being trimmed.
    assert.deepEqual(withDayStart({ start: 7, end: 23 }, 9), { start: 9, end: 24 },
      'a 16 hour window that no longer fits stops at midnight');
    assert.deepEqual(withDayStart({ start: 8, end: 12 }, 10), { start: 10, end: 14 }, 'the span is kept');
    assert.deepEqual(withDayStart({ start: 8, end: 12 }, 0), { start: 0, end: 4 }, 'and going earlier too');
    assert.deepEqual(withDayStart({ start: 8, end: 12 }, 23), { start: 23, end: 24 },
      'pinned at the top, the span is the only thing that can give');
    assert.deepEqual(withDayStart({ start: 8, end: 12 }, 99), { start: 23, end: 24 }, 'clamped, not defaulted');
    assert.deepEqual(withDayStart({ start: 8, end: 12 }, -99), { start: 0, end: 4 });
    assert.deepEqual(withDayStart({ start: 8, end: 12 }, 'abc'), { start: 8, end: 12 }, 'rubbish leaves it alone');

    // Moving the end only disturbs the start when it has crossed it.
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 22), { start: 8, end: 22 }, 'the start stays put');
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 8), { start: 7, end: 8 }, 'equal ends push the start back');
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 3), { start: 2, end: 3 }, 'and so does crossing it');
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 1), { start: 0, end: 1 }, 'right down to midnight');
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 0), { start: 0, end: 1 },
      'an end of 0 is clamped to the first legal hour');
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 99), { start: 8, end: 24 });
    assert.deepEqual(withDayEnd({ start: 8, end: 20 }, 'abc'), { start: 8, end: 20 });

    // Order independence: reaching the same pair by either route lands in the
    // same place, which is what "whatever order the user changes them in" means.
    for (const target of allWindows()) {
      const viaStart = withDayEnd(withDayStart({ start: 0, end: 24 }, target.start), target.end);
      const viaEnd = withDayStart(withDayEnd({ start: 0, end: 24 }, target.end), target.start);
      assert.ok(viaStart.start < viaStart.end, `${target.start}..${target.end} via start`);
      assert.ok(viaEnd.start < viaEnd.end, `${target.start}..${target.end} via end`);
      assert.equal(viaStart.end, target.end, 'the end the user asked for is the end they get');
      assert.equal(viaEnd.start, target.start, 'and the same for the start');
    }
  }

  console.log('--- 5. NORMALISING AN ALREADY-TYPED WINDOW ---');
  {
    for (const w of allWindows()) {
      assert.deepEqual(normalizeDayWindow(w), w, `${w.start}..${w.end} is already legal and is left alone`);
      assert.equal(dayWindowSpan(w), w.end - w.start);
    }
    assert.deepEqual(normalizeDayWindow({ start: 7.4, end: 22.6 }), { start: 7, end: 23 },
      'a float that reached the type is rounded rather than refused');
    assert.deepEqual(normalizeDayWindow({ start: -3, end: -1 }), { start: 0, end: 1 });
    assert.deepEqual(normalizeDayWindow({ start: 40, end: 60 }), { start: 23, end: 24 });
    assert.deepEqual(normalizeDayWindow({ start: 10, end: 10 }), { start: 10, end: 11 });
    assert.equal(dayWindowSpan({ start: 5, end: 5 }), 1, 'a span is never zero');
  }

  console.log('--- 6. ROUND TRIP: WHAT THE SETTER WRITES, THE GETTER READS ---');
  {
    // The property the whole storage layer rests on. prefs.ts writes String(n)
    // and reads it back through coerceDayWindow, so every legal window must
    // survive that trip untouched.
    for (const w of allWindows()) {
      assert.deepEqual(roundTripWindow(w), w, `${w.start}..${w.end} survives storage`);
      // And a second trip, in case the first quietly moved something.
      assert.deepEqual(roundTripWindow(roundTripWindow(w)), w, `${w.start}..${w.end} is stable`);
    }
    assert.equal(allWindows().length, 300, 'all 300 legal windows were checked');

    for (const n of SNAP_INTERVALS) {
      assert.equal(coerceSnapInterval(String(n)), n, `snap ${n} survives storage`);
    }
    for (let before = SPAN_DAYS_MIN; before <= SPAN_DAYS_MAX; before += 1) {
      for (let after = SPAN_DAYS_MIN; after <= SPAN_DAYS_MAX; after += 1) {
        assert.deepEqual(coerceSpanWindow(String(before), String(after)), { before, after });
        assert.equal(spanColumns({ before, after }), before + after + 1);
      }
    }
    for (const v of [true, false]) {
      assert.equal(coerceBool(encodeBool(v), !v), v, `bool ${v} survives storage`);
    }
    assert.equal(encodeBool(true), BOOL_TRUE);
    assert.equal(encodeBool(false), BOOL_FALSE);
  }

  console.log('--- 7. SNAP INTERVAL AND SPAN WINDOW ---');
  {
    assert.deepEqual([...SNAP_INTERVALS], [5, 10, 15, 30, 60], 'the offered steps');
    for (const bad of [0, 1, 7, 20, 45, 120, -30, 30.5, '30.0000001']) {
      assert.equal(coerceSnapInterval(bad), DEFAULT_SNAP_INTERVAL, `${String(bad)} is not on the list`);
    }
    assert.equal(coerceSnapInterval('30.0'), 30, 'a trailing zero is still thirty');
    assert.equal(coerceSnapInterval(' 15 '), 15, 'padding is tolerated');
    assert.equal(coerceSnapInterval(null, 60), 60, 'the caller may pick the fallback');

    // The span clamps rather than defaults, because unlike the hours the two
    // sides do not have to agree with each other.
    assert.deepEqual(coerceSpanWindow('99', '99'), { before: SPAN_DAYS_MAX, after: SPAN_DAYS_MAX });
    assert.deepEqual(coerceSpanWindow('-4', '-4'), { before: SPAN_DAYS_MIN, after: SPAN_DAYS_MIN });
    assert.deepEqual(coerceSpanWindow('0', '0'), { before: 0, after: 0 }, 'one column is legal');
    assert.equal(spanColumns({ before: 0, after: 0 }), 1);
    assert.deepEqual(coerceSpanWindow('2.4', '3.6'), { before: 2, after: 4 }, 'floats round to the nearest day');
    assert.deepEqual(coerceSpanWindow(null, '5'), { before: DEFAULT_SPAN_BEFORE, after: 5 });
    assert.deepEqual(coerceSpanWindow('2', null), { before: 2, after: DEFAULT_SPAN_AFTER });
    assert.equal(spanColumns({ before: 99, after: 99 }), SPAN_DAYS_MAX * 2 + 1, 'columns count the clamped days');
  }

  console.log('--- 8. THE PRIMITIVES UNDERNEATH ---');
  {
    assert.equal(coerceInt('12', 0, 0, 24), 12);
    assert.equal(coerceInt(12, 0, 0, 24), 12, 'a real number needs no parsing');
    // `assert.equal` is Object.is under node:assert/strict, and Object.is(-0, 0)
    // is false, so this one is compared the way the grid would compare it.
    assert.ok(coerceInt('-0', 5, 0, 24) === 0, 'negative zero is zero');
    // '0x10' parses as 16, which is a perfectly good hour. Deliberately NOT in
    // the rubbish list above: it is a legal number written oddly, not garbage.
    assert.equal(coerceInt('0x10', 5, 0, 24), 16, 'hex parses, and 16 is in range');
    assert.equal(coerceInt('25', 5, 0, 24), 5, 'one past the top is refused');
    assert.equal(coerceInt('-1', 5, 0, 24), 5, 'one below the bottom is refused');
    assert.equal(coerceInt('1e2', 5, 0, 1000), 100, 'exponent notation is a legal integer');

    assert.equal(clampInt('25', 5, 0, 24), 24, 'clamping pulls to the edge');
    assert.equal(clampInt('-99', 5, 0, 24), 0);
    assert.equal(clampInt('abc', 5, 0, 24), 5, 'but rubbish still falls back');
    assert.equal(clampInt(7.6, 5, 0, 24), 8, 'and floats round');
  }

  console.log('--- 9. WHAT THE USER READS ---');
  {
    assert.equal(formatHour(0), 'midnight');
    assert.equal(formatHour(24), 'midnight');
    assert.equal(formatHour(12), 'noon');
    assert.equal(formatHour(7), '7am');
    assert.equal(formatHour(11), '11am');
    assert.equal(formatHour(13), '1pm');
    assert.equal(formatHour(23), '11pm');
    assert.equal(formatHour(0, '24h'), '00:00');
    assert.equal(formatHour(9, '24h'), '09:00');
    assert.equal(formatHour(23, '24h'), '23:00');
    assert.equal(formatHour(24, '24h'), '00:00');

    assert.equal(
      describeDayWindow({ start: 7, end: 23 }),
      'Showing 7am to 11pm, 16 hours on screen.',
    );
    assert.equal(
      describeDayWindow({ start: 8, end: 9 }),
      'Showing 8am to 9am, 1 hour on screen.',
      'one hour is singular',
    );
    assert.equal(
      describeDayWindow({ start: 0, end: 24 }, '24h'),
      'Showing 00:00 to 00:00, 24 hours on screen.',
    );

    // The house rule: no em or en dash anywhere a user can read it.
    for (const w of allWindows()) {
      for (const clock of ['12h', '24h'] as const) {
        const sentence = describeDayWindow(w, clock);
        assert.ok(!/[–—]/.test(sentence), `no dashes in "${sentence}"`);
        assert.ok(sentence.startsWith('Showing '), 'and it is a sentence');
      }
    }
    // Even a broken window produces a sentence rather than a crash.
    assert.equal(describeDayWindow({ start: 20, end: 3 }), 'Showing 8pm to 9pm, 1 hour on screen.');
  }

  console.log('--- 10. THE DEFAULTS ARE THEMSELVES LEGAL ---');
  {
    assert.deepEqual(normalizeDayWindow(DEFAULT_DAY_WINDOW), DEFAULT_DAY_WINDOW);
    assert.ok(DEFAULT_DAY_START_HOUR < DEFAULT_DAY_END_HOUR, 'the shipped window is drawable');
    assert.ok((SNAP_INTERVALS as readonly number[]).includes(DEFAULT_SNAP_INTERVAL));
    assert.deepEqual(coerceSpanWindow(DEFAULT_SPAN_BEFORE, DEFAULT_SPAN_AFTER), DEFAULT_SPAN_WINDOW);
    assert.equal(DEFAULT_SWIPE_VIEW_SWITCH, true, 'swiping is on until turned off, as on the PC');
    assert.equal(DAY_HOUR_MIN, 0);
    assert.equal(DAY_HOUR_MAX, 24);
  }

  console.log('--- 11. HOW THIS DEVICE DRAWS PRAYERS ---');
  {
    // The defaults are themselves legal, and survive a round trip.
    assert.deepEqual(coercePrayerAppearance(DEFAULT_PRAYER_APPEARANCE), DEFAULT_PRAYER_APPEARANCE);
    assert.deepEqual(
      coercePrayerAppearance(JSON.parse(JSON.stringify(DEFAULT_PRAYER_APPEARANCE))),
      DEFAULT_PRAYER_APPEARANCE);

    // Anything at all can be in storage, and none of it may throw.
    const rubbish: unknown[] = [
      null, undefined, 0, 1, -1, NaN, Infinity, '', 'x', '{}', '[]', true, false,
      [], [1, 2], {}, { colour: 1 }, { colour: '#12345' }, { colour: '#1234567' },
      { colour: 'red' }, { colour: '#GGGGGG' }, { colour: null }, { showLabels: 'yes' },
      { showOnCalendar: 'no' }, { showOnCalendar: 1 }, () => {},
      new Date(),
    ];
    for (const raw of rubbish) {
      const got = coercePrayerAppearance(raw as unknown);
      assert.equal(typeof got.showOnCalendar, 'boolean', `${String(raw)} gives a boolean`);
      assert.equal(typeof got.showLabels, 'boolean');
      assert.ok(isHexColour(got.colour), `${String(raw)} gives a real colour`);
      assert.ok(isPrayerDrawStyle(got.style), `${String(raw)} gives a real style`);
    }

    // ── The three shapes ──
    for (const { id } of PRAYER_DRAW_STYLES) {
      assert.equal(coercePrayerAppearance({ style: id }).style, id, `${id} survives`);
      assert.ok(isPrayerDrawStyle(id));
    }
    // Every style has a label and a hint, and no two share an id.
    assert.equal(new Set(PRAYER_DRAW_STYLES.map(s2 => s2.id)).size, PRAYER_DRAW_STYLES.length);
    for (const s2 of PRAYER_DRAW_STYLES) {
      assert.ok(s2.label.length > 0 && s2.hint.length > 0, `${s2.id} is described`);
      for (const text of [s2.label, s2.hint]) {
        assert.ok(!text.includes('—') && !text.includes('–'), `no dash in "${text}"`);
      }
    }
    // Anything that is not one of the three falls back rather than being kept.
    for (const bad of ['Marker', 'MARKER', 'line', '', 0, 1, null, [], {}, 'row ']) {
      assert.equal(coercePrayerAppearance({ style: bad }).style,
        DEFAULT_PRAYER_APPEARANCE.style, `${String(bad)} is not a style`);
      assert.ok(!isPrayerDrawStyle(bad as unknown));
    }
    // A bad style does not cost the colour beside it.
    const mixed = coercePrayerAppearance({ style: 'nope', colour: '#123456' });
    assert.equal(mixed.style, DEFAULT_PRAYER_APPEARANCE.style);
    assert.equal(mixed.colour, '#123456', 'the good field survived a bad neighbour');

    // ONE BAD FIELD DOES NOT COST THE OTHERS. That is the whole reason to coerce
    // per field rather than reject the object: a corrupt colour must not also
    // take away the choice of whether prayers are drawn at all.
    const partial = coercePrayerAppearance({ colour: 'not a colour', showOnCalendar: false });
    assert.equal(partial.showOnCalendar, false, 'the good field survived');
    assert.equal(partial.colour, DEFAULT_PRAYER_APPEARANCE.colour, 'the bad one fell back');

    // Case is normalised, so one colour is one value and cannot ping-pong.
    assert.equal(coercePrayerAppearance({ colour: '#AABBCC' }).colour, '#aabbcc');
    assert.equal(
      coercePrayerAppearance({ colour: '#aabbcc' }).colour,
      coercePrayerAppearance({ colour: '#AaBbCc' }).colour,
      'the same colour written two ways is one value');

    // Idempotent: coercing what was already coerced changes nothing.
    for (const raw of rubbish) {
      const once = coercePrayerAppearance(raw as unknown);
      assert.deepEqual(coercePrayerAppearance(once), once, 'stable under a second pass');
    }

    // isHexColour is exactly as strict as it claims to be.
    for (const good of ['#000000', '#ffffff', '#34d399', '#ABCDEF']) {
      assert.ok(isHexColour(good), `${good} is a colour`);
    }
    for (const bad of ['#fff', '#1234567', 'ffffff', '#12345g', '', ' #ffffff', '#ffffff ', null, 3]) {
      assert.ok(!isHexColour(bad as unknown), `${String(bad)} is not a colour`);
    }

    // EVERY reachable combination has a sentence, and none of them uses a dash.
    for (const showOnCalendar of [true, false]) {
      for (const showLabels of [true, false]) {
        for (const style of PRAYER_DRAW_STYLES.map(s2 => s2.id)) {
        const line = describePrayerAppearance({
          ...DEFAULT_PRAYER_APPEARANCE, showOnCalendar, showLabels, style,
        });
        assert.ok(line.length > 0, 'there is something to read');
        assert.ok(!line.includes('—') && !line.includes('–'), `no dash in "${line}"`);
        }
      }
    }
  }


  console.log('\nALL PASS (viewPrefs: day window invariant, storage round trip, rubbish tolerance)');
}

main();
