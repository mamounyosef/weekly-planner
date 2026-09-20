// Tests for the "HH:MM" <-> minutes helpers.
//
// What is actually at stake: on 2026-09-20 ONE event out of 185 rendered the
// entire planner as a black window. It was an all-day item created on the
// phone, with no startTime, which is correct data for an all-day event. The
// crash was `timeToMin` calling `.split` on it, inside a `useMemo` that sorts
// a month cell's events, so React could render nothing at all and the user got
// an empty window with no error message anywhere.
//
// So the property under test is not "converts times correctly". It is: a single
// unusable value degrades that record's ORDERING and nothing else. Every case
// below that passes junk in is guarding that.
//
// Run with: npx tsx src/lib/timeOfDay.test.ts

import assert from 'node:assert/strict';
import { timeToMin, minToTime } from './timeOfDay';

async function main() {
  console.log('--- 1. ORDINARY TIMES CONVERT ---');
  {
    assert.equal(timeToMin('00:00'), 0);
    assert.equal(timeToMin('00:01'), 1);
    assert.equal(timeToMin('01:00'), 60);
    assert.equal(timeToMin('09:30'), 570);
    assert.equal(timeToMin('13:45'), 825);
    assert.equal(timeToMin('23:59'), 1439);
    console.log('  ok');
  }

  console.log('--- 2. THE BUG: A MISSING TIME IS MIDNIGHT, NOT A CRASH ---');
  {
    // The exact shape of the 2026-09-20 outage: an all-day event's startTime.
    assert.equal(timeToMin(undefined), 0);
    assert.equal(timeToMin(null), 0);
    assert.equal(timeToMin(''), 0);
    console.log('  ok');
  }

  console.log('--- 3. MALFORMED INPUT IS MIDNIGHT, NOT A CRASH ---');
  {
    // Genuinely unparseable: no usable number on either side.
    for (const junk of ['abc', ':', '::', 'no-colon', 'aa:bb', '12:xx', 'xx:12']) {
      assert.equal(timeToMin(junk), 0, `${JSON.stringify(junk)} must read as midnight`);
    }

    // Half-written times are NOT treated as junk. An empty half is zero, which
    // is what a person typing "12:" into a time field means, and refusing to
    // read it would make the field fight the user mid-keystroke.
    assert.equal(timeToMin('12:'), 720, '"12:" is 12:00');
    assert.equal(timeToMin(':30'), 30, '":30" is 00:30');
    console.log('  ok');
  }

  console.log('--- 4. NON-STRINGS ARE MIDNIGHT, NOT A CRASH ---');
  {
    // Sync merges arrive from another device and are not schema-checked here,
    // so a number or an object reaching this is a real possibility.
    for (const junk of [0, 42, {}, [], true, NaN] as unknown[]) {
      assert.equal(timeToMin(junk as string), 0);
    }
    console.log('  ok');
  }

  console.log('--- 5. A SORT COMPARATOR NEVER SEES NaN ---');
  {
    // THE property that matters. A comparator returning NaN does not throw, it
    // silently scrambles the order, which is a worse bug than a crash because
    // nobody notices. So every path must yield a real number.
    const inputs: unknown[] = ['09:00', undefined, null, '', 'junk', '12:xx', 25, {}, '23:59'];
    for (const i of inputs) {
      const n = timeToMin(i as string);
      assert.equal(typeof n, 'number');
      assert.ok(Number.isFinite(n), `${JSON.stringify(i)} produced ${n}`);
    }

    // And a real sort over the mixed list completes and is ordered.
    const events = [
      { name: 'allDay', startTime: undefined },
      { name: 'evening', startTime: '21:00' },
      { name: 'morning', startTime: '08:00' },
      { name: 'broken', startTime: 'nonsense' },
    ];
    const sorted = [...events].sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
    assert.deepEqual(
      sorted.map(e => e.name),
      ['allDay', 'broken', 'morning', 'evening'],
      'untimed items sort to the start of the day, timed ones stay in order',
    );
    console.log('  ok');
  }

  console.log('--- 6. HOURS BEYOND A DAY ARE NOT SILENTLY WRAPPED ON THE WAY IN ---');
  {
    // timeToMin is a parser, not a normaliser. "25:00" is arithmetic the caller
    // asked for; clamping here would hide a real data problem.
    assert.equal(timeToMin('25:00'), 1500);
    assert.equal(timeToMin('24:00'), 1440);
    console.log('  ok');
  }

  console.log('--- 7. MINUTES BACK TO A TIME STRING ---');
  {
    assert.equal(minToTime(0), '00:00');
    assert.equal(minToTime(1), '00:01');
    assert.equal(minToTime(60), '01:00');
    assert.equal(minToTime(570), '09:30');
    assert.equal(minToTime(1439), '23:59');
    console.log('  ok');
  }

  console.log('--- 8. minToTime WRAPS INSTEAD OF CLAMPING ---');
  {
    // Callers add and subtract durations freely: dragging an event past
    // midnight, or a reminder offset before one. The answer should be the time
    // of day it actually lands on.
    assert.equal(minToTime(1440), '00:00', 'exactly one day wraps to midnight');
    assert.equal(minToTime(1500), '01:00');
    assert.equal(minToTime(-1), '23:59', 'one minute before midnight');
    assert.equal(minToTime(-60), '23:00');
    assert.equal(minToTime(-1440), '00:00');
    assert.equal(minToTime(-1441), '23:59', 'more than a day back still wraps');
    console.log('  ok');
  }

  console.log('--- 9. minToTime SURVIVES JUNK TOO ---');
  {
    assert.equal(minToTime(NaN), '00:00');
    assert.equal(minToTime(Infinity), '00:00');
    assert.equal(minToTime(-Infinity), '00:00');
    assert.equal(minToTime(90.7), '01:30', 'fractional minutes truncate, never produce "01:30.7"');
    console.log('  ok');
  }

  console.log('--- 10. THE TWO ARE INVERSES ACROSS A WHOLE DAY ---');
  {
    for (let m = 0; m < 1440; m++) {
      assert.equal(timeToMin(minToTime(m)), m, `round trip failed at ${m}`);
    }
    console.log('  ok');
  }

  console.log('\nAll timeOfDay tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
