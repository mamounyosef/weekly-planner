// Tests the wording of "which update am I running".
//
// This is a label, so the failures are all of one kind: a sentence that is
// grammatically wrong ("1 minutes ago"), arithmetically wrong (midnight shown
// as "0:05 am"), or confidently wrong about a case nobody pictured (a phone
// whose clock is a minute behind the PC, so the publish looks like tomorrow).
// None of those crash anything, which is exactly why they survive unless
// something checks them.
//
// Run with: npx tsx src/lib/updateLabel.test.ts

import assert from 'node:assert/strict';
import {
  describeAge,
  describeUpdate,
  describeWhen,
  formatClockTime,
  updateStamp,
} from './updateLabel';

/** Local time, which is the only frame any of this is ever read in. */
const at = (
  y: number, m: number, d: number, hh = 0, mm = 0, ss = 0,
): Date => new Date(y, m - 1, d, hh, mm, ss);

function main() {
  console.log('--- 1. THE CLOCK FACE, IN BOTH FORMATS ---');
  {
    assert.equal(formatClockTime(at(2026, 9, 2, 10, 22), '12h'), '10:22 am');
    assert.equal(formatClockTime(at(2026, 9, 2, 22, 5), '12h'), '10:05 pm');
    assert.equal(formatClockTime(at(2026, 9, 2, 10, 22), '24h'), '10:22');
    assert.equal(formatClockTime(at(2026, 9, 2, 22, 5), '24h'), '22:05');

    // The hour is padded in 24h so the column does not jump, and NOT padded in
    // 12h, where "09:05 am" is not how anyone says it.
    assert.equal(formatClockTime(at(2026, 9, 2, 9, 5), '24h'), '09:05');
    assert.equal(formatClockTime(at(2026, 9, 2, 9, 5), '12h'), '9:05 am');

    // Midnight and noon: the two `h % 12` gets wrong.
    assert.equal(formatClockTime(at(2026, 9, 2, 0, 0), '12h'), '12:00 am');
    assert.equal(formatClockTime(at(2026, 9, 2, 0, 30), '12h'), '12:30 am');
    assert.equal(formatClockTime(at(2026, 9, 2, 12, 0), '12h'), '12:00 pm');
    assert.equal(formatClockTime(at(2026, 9, 2, 12, 30), '12h'), '12:30 pm');
    assert.equal(formatClockTime(at(2026, 9, 2, 0, 0), '24h'), '00:00');
    assert.equal(formatClockTime(at(2026, 9, 2, 23, 59), '24h'), '23:59');

    // Every hour of the day is am before noon and pm from noon on, exactly once.
    for (let h = 0; h < 24; h += 1) {
      const out = formatClockTime(at(2026, 9, 2, h, 0), '12h');
      assert.match(out, /^\d{1,2}:\d{2} (am|pm)$/, `${h} reads as a clock time`);
      assert.equal(out.endsWith(h < 12 ? 'am' : 'pm'), true, `${h} is on the right side of noon`);
      const hour = Number(out.split(':')[0]);
      assert.ok(hour >= 1 && hour <= 12, 'a 12 hour clock has hours 1 to 12');
    }

    // 12h is the default, since that is what the planner ships set to.
    assert.equal(formatClockTime(at(2026, 9, 2, 13, 0)), '1:00 pm');
  }

  console.log('--- 2. HOW LONG AGO, IN THE LARGEST HONEST UNIT ---');
  {
    const now = at(2026, 9, 2, 12, 0, 0);

    assert.equal(describeAge(now, now), 'just now');
    assert.equal(describeAge(at(2026, 9, 2, 11, 59, 30), now), 'just now', 'under a minute');
    assert.equal(describeAge(at(2026, 9, 2, 11, 59, 0), now), '1 minute ago', 'and not "1 minutes"');
    assert.equal(describeAge(at(2026, 9, 2, 11, 38), now), '22 minutes ago');
    assert.equal(describeAge(at(2026, 9, 2, 11, 1), now), '59 minutes ago', 'still minutes at 59');
    assert.equal(describeAge(at(2026, 9, 2, 11, 0), now), '1 hour ago');
    assert.equal(describeAge(at(2026, 9, 2, 2, 0), now), '10 hours ago');
    assert.equal(describeAge(at(2026, 9, 1, 12, 1), now), '23 hours ago', 'still hours under a day');
    assert.equal(describeAge(at(2026, 9, 1, 12, 0), now), '1 day ago');
    assert.equal(describeAge(at(2026, 8, 30, 12, 0), now), '3 days ago');
    assert.equal(describeAge(at(2026, 8, 27, 12, 0), now), '6 days ago');
    assert.equal(describeAge(at(2026, 8, 26, 12, 0), now), '1 week ago');
    assert.equal(describeAge(at(2026, 8, 19, 12, 0), now), '2 weeks ago');
    assert.equal(describeAge(at(2026, 8, 3, 12, 0), now), '4 weeks ago');
    assert.equal(describeAge(at(2026, 7, 2, 12, 0), now), '2 months ago');
    assert.equal(describeAge(at(2025, 9, 2, 12, 0), now), '1 year ago');
    assert.equal(describeAge(at(2023, 9, 2, 12, 0), now), '3 years ago');
  }

  console.log('--- 3. A CLOCK RUNNING BACKWARDS IS NOT AN ERROR MESSAGE ---');
  {
    // The phone's clock and the PC's are never exactly equal. A publish that
    // looks a few seconds into the future must not print "in -1 minutes", and
    // must never be called "Tomorrow", which is the one label certainly wrong.
    const now = at(2026, 9, 2, 12, 0, 0);
    assert.equal(describeAge(at(2026, 9, 2, 12, 0, 30), now), 'just now');
    assert.equal(describeAge(at(2026, 9, 2, 12, 5, 0), now), 'just now');
    assert.equal(describeAge(at(2026, 9, 3, 9, 0, 0), now), 'just now', 'even a day ahead');
    assert.equal(describeWhen(at(2026, 9, 3, 9, 0), now, '12h'), 'Today at 9:00 am');
  }

  console.log('--- 4. TODAY AND YESTERDAY ARE NAMED, NOT DATED ---');
  {
    const now = at(2026, 9, 2, 12, 0);

    assert.equal(describeWhen(at(2026, 9, 2, 10, 22), now, '12h'), 'Today at 10:22 am');
    assert.equal(describeWhen(at(2026, 9, 1, 21, 4), now, '12h'), 'Yesterday at 9:04 pm');
    assert.equal(describeWhen(at(2026, 8, 31, 10, 22), now, '12h'), '31 Aug at 10:22 am');

    // Calendar days, not elapsed hours: five minutes either side of midnight is
    // "Yesterday", however few minutes have actually passed.
    const justAfterMidnight = at(2026, 9, 2, 0, 5);
    assert.equal(
      describeWhen(at(2026, 9, 1, 23, 55), justAfterMidnight, '12h'),
      'Yesterday at 11:55 pm',
    );
    assert.equal(describeAge(at(2026, 9, 1, 23, 55), justAfterMidnight), '10 minutes ago');

    // A different year is spelled out; this one is not.
    assert.equal(describeWhen(at(2026, 1, 3, 8, 0), now, '12h'), '3 Jan at 8:00 am');
    assert.equal(describeWhen(at(2025, 12, 31, 8, 0), now, '12h'), '31 Dec 2025 at 8:00 am');

    // The clock setting is honoured here too.
    assert.equal(describeWhen(at(2026, 9, 2, 22, 5), now, '24h'), 'Today at 22:05');

    // Every month is named, and none of them come out undefined.
    for (let m = 1; m <= 12; m += 1) {
      const out = describeWhen(at(2025, m, 15, 9, 0), now, '12h');
      assert.match(out, /^15 [A-Z][a-z]{2} 2025 at 9:00 am$/, `month ${m} is named`);
    }
  }

  console.log('--- 5. THE STAMP MATCHES THE PUBLISH FOLDER ---');
  {
    // This is the string the PC names the folder with. If the two ever drift,
    // the row stops being usable for checking which publish landed.
    assert.equal(updateStamp(at(2026, 9, 2, 10, 22, 38)), '20260902-102238');
    assert.equal(updateStamp(at(2026, 1, 5, 9, 4, 3)), '20260105-090403', 'everything is padded');
    assert.equal(updateStamp(at(2026, 12, 31, 23, 59, 59)), '20261231-235959');
    assert.equal(updateStamp(at(2026, 9, 2, 0, 0, 0)), '20260902-000000');

    assert.equal(updateStamp(null), null);
    assert.equal(updateStamp(undefined), null);
    assert.equal(updateStamp(new Date(NaN)), null);

    // The shape the server's own folder matcher accepts.
    for (const d of [at(2026, 3, 9, 1, 2, 3), at(2026, 11, 30, 13, 45, 0)]) {
      assert.match(updateStamp(d) as string, /^\d{8}-\d{6}$/);
    }
  }

  console.log('--- 6. NOTHING TO DESCRIBE IS ITS OWN ANSWER ---');
  {
    const now = at(2026, 9, 2, 12, 0);
    // Null is an embedded launch: the bundle baked into the APK, which is where
    // a phone lands after its data is cleared. The screen says so in words.
    assert.equal(describeUpdate(null, now), null);
    assert.equal(describeUpdate(undefined, now), null);
    assert.equal(describeUpdate(new Date(NaN), now), null);
  }

  console.log('--- 7. BOTH HALVES TOGETHER, AS THE ROW READS THEM ---');
  {
    const now = at(2026, 9, 2, 10, 44, 0);
    const out = describeUpdate(at(2026, 9, 2, 10, 22, 38), now, '12h');
    // 10:22:38 to 10:44:00 is 21 minutes and change, and part minutes are not
    // rounded up: "22 minutes ago" would claim time that has not passed yet.
    assert.deepEqual(out, { when: 'Today at 10:22 am', ago: '21 minutes ago' });

    const old = describeUpdate(at(2026, 8, 20, 19, 5, 0), now, '12h');
    assert.deepEqual(old, { when: '20 Aug at 7:05 pm', ago: '1 week ago' });

    const in24 = describeUpdate(at(2026, 8, 20, 19, 5, 0), now, '24h');
    assert.equal(in24?.when, '20 Aug at 19:05');
    assert.equal(in24?.ago, '1 week ago', 'the age does not depend on the clock format');
  }

  console.log('--- 8. IT NEVER PRODUCES NONSENSE, WHATEVER THE GAP ---');
  {
    const now = at(2026, 9, 2, 12, 0, 0);
    // Walk backwards over four years in irregular steps and check every label
    // is a real sentence, singular where it should be, and never empty.
    for (let minutes = 0; minutes < 4 * 365 * 24 * 60; minutes += 37) {
      const then = new Date(now.getTime() - minutes * 60_000);
      const ago = describeAge(then, now);
      assert.ok(ago.length > 0);
      assert.match(
        ago,
        /^(just now|\d+ (minute|hour|day|week|month|year)s? ago)$/,
        `"${ago}" is a sentence`,
      );
      // "1 minutes ago" is the classic, so it is checked on every single step.
      assert.ok(!/\b1 [a-z]+s ago$/.test(ago), `"${ago}" is singular where it must be`);
      assert.ok(!/\b(0) [a-z]+s? ago$/.test(ago), `"${ago}" never counts zero`);

      const when = describeWhen(then, now, '12h');
      assert.match(
        when,
        /^(Today|Yesterday|\d{1,2} [A-Z][a-z]{2}( \d{4})?) at \d{1,2}:\d{2} (am|pm)$/,
        `"${when}" is a readable moment`,
      );
    }
  }

  console.log('--- 9. DAYLIGHT SAVING DOES NOT BREAK THE COUNTING ---');
  {
    // Calendar arithmetic across a day that is 23 or 25 hours long is where a
    // naive "divide by 86400000" starts reporting the wrong day. The rounding
    // in calendarDaysApart is what protects this, so it is checked in whatever
    // zone the machine running the tests happens to be in.
    for (const [y, m, d] of [[2026, 3, 29], [2026, 10, 25], [2026, 11, 1], [2026, 3, 8]]) {
      const now = at(y, m, d, 12, 0);
      assert.equal(describeWhen(at(y, m, d, 9, 0), now, '12h'), 'Today at 9:00 am');
      const prev = new Date(y, m - 1, d - 1, 9, 0);
      assert.equal(
        describeWhen(prev, now, '12h').startsWith('Yesterday at '), true,
        `the day before ${y}-${m}-${d} is yesterday`,
      );
    }
  }

  console.log('\nALL PASS (updateLabel: which publish is running, in words)');
}

main();
