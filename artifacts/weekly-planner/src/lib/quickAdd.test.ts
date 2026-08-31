// Tests the Quick Add natural language parser.
//
// WHY IT NEEDS SO MANY TESTS
// Natural language parsing is notoriously brittle. A change that makes "next
// friday" work might break "friday", or parsing "12am" might break "noon".
// The only way to confidently change this file is to have every edge case documented
// and locked down.
//
// Run with: npx tsx src/lib/quickAdd.test.ts

import assert from 'node:assert/strict';
import { parseQuickAdd } from './quickAdd';

function main() {
  const options = {
    now: new Date(2026, 7, 31, 10, 0), // Aug 31, 2026 10:00 AM (Monday)
    weekStartsOn: 0 as const,
    categories: [{ id: 'c1', name: 'Work' }],
    lists: [{ id: 'l1', name: 'Groceries' }]
  };

  const parse = (input: string) => parseQuickAdd(input, options);

  console.log('--- 1. BASIC EVENTS ---');
  {
    const res = parse('gym tomorrow 6pm');
    assert.equal(res.draft.title, 'gym');
    assert.equal(res.draft.date, '2026-09-01');
    assert.equal(res.draft.allDay, false);
    assert.equal(res.draft.startMin, 18 * 60);
    assert.equal(res.draft.endMin, 19 * 60); // default 60m
    assert.equal(res.store, 'events');
  }

  console.log('--- 2. BASIC TASKS ---');
  {
    const res1 = parse('call dad friday 7:30');
    assert.equal(res1.draft.title, 'call dad');
    assert.equal(res1.draft.date, '2026-09-04');
    assert.equal(res1.draft.allDay, false);
    assert.equal(res1.draft.startMin, 7 * 60 + 30);
    assert.equal(res1.draft.endMin, null);
    assert.equal(res1.store, 'tasks');

    const res2 = parse('buy milk');
    assert.equal(res2.draft.title, 'buy milk');
    assert.equal(res2.draft.date, '2026-08-31');
    assert.equal(res2.draft.allDay, true);
    assert.equal(res2.store, 'tasks');
  }

  console.log('--- 3. DURATIONS ---');
  {
    const res = parse('dentist 15 March 2pm for 45m');
    assert.equal(res.draft.title, 'dentist');
    assert.equal(res.draft.date, '2027-03-15'); // 15 March next year
    assert.equal(res.draft.startMin, 14 * 60);
    assert.equal(res.draft.endMin, 14 * 60 + 45);
    assert.equal(res.store, 'events');
    
    const res2 = parse('meeting at 2pm for 1.5h');
    assert.equal(res2.draft.title, 'meeting');
    assert.equal(res2.draft.endMin, (res2.draft.startMin ?? 0) + 90);
  }

  console.log('--- 4. RECURRENCE ---');
  {
    const res = parse('standup every weekday 9am');
    assert.equal(res.draft.title, 'standup');
    assert.equal(res.draft.recur?.freq, 'weekly');
    assert.deepEqual(res.draft.recur?.byWeekday, [1, 2, 3, 4, 5]);

    const res2 = parse('rent every month');
    assert.equal(res2.draft.recur?.freq, 'monthly');
  }

  console.log('--- 5. TAGS (CATEGORIES AND LISTS) ---');
  {
    const res = parse('submit report next monday !work');
    assert.equal(res.draft.title, 'submit report');
    assert.equal(res.draft.categoryId, 'c1');
    assert.equal(res.store, 'events'); // explicitly set category forces event

    const res2 = parse('buy apples !groceries');
    assert.equal(res2.draft.title, 'buy apples');
    assert.equal(res2.listId, 'l1');
    assert.equal(res2.store, 'tasks');
    
    // Tag that doesn't exist stays in title
    const res3 = parse('buy apples !invalid');
    assert.equal(res3.draft.title, 'buy apples !invalid');
  }

  console.log('--- 6. TIME EDGE CASES ---');
  {
    assert.equal(parse('12am').draft.startMin, 0);
    assert.equal(parse('12pm').draft.startMin, 12 * 60);
    assert.equal(parse('noon').draft.startMin, 12 * 60);
    assert.equal(parse('midnight').draft.startMin, 0);
    assert.equal(parse('8am').draft.startMin, 8 * 60);
  }

  console.log('--- 7. DATE EDGE CASES ---');
  {
    const res = parse('31 February'); // Does not exist
    assert.equal(res.draft.title, '31 February');
    
    const res2 = parse('party 28 Feb'); // Next year since Feb is past Aug 31
    assert.equal(res2.draft.date, '2027-02-28');
    
    const res3 = parse('next friday'); // 11 days from now (Mon -> next Fri)
    assert.equal(res3.draft.date, '2026-09-11');
  }

  console.log('--- 8. DEGENERATE INPUT ---');
  {
    const resEmpty = parse('');
    assert.equal(resEmpty.draft.title, '');
    
    const resSpace = parse('   ');
    assert.equal(resSpace.draft.title, '');
    
    const resDateOnly = parse('tomorrow');
    assert.equal(resDateOnly.draft.title, '');
    
    const resTimeOnly = parse('6pm');
    assert.equal(resTimeOnly.draft.title, '');
    
    const resArabic = parse('مرحبا !work');
    assert.equal(resArabic.draft.title, 'مرحبا');
    assert.equal(resArabic.draft.categoryId, 'c1');
    
    const resMultipleTags = parse('hello !work !groceries');
    assert.equal(resMultipleTags.draft.title, 'hello');
    assert.equal(resMultipleTags.draft.categoryId, 'c1');
    assert.equal(resMultipleTags.listId, 'l1');
  }

  console.log('--- 9. DETERMINISM AND NO THROWS ON RANDOM INPUT ---');
  {
    const words = ['march', 'may', 'at', 'for', '12', 'pm', 'tomorrow', 'buy', 'every', 'day', '!', 'work', 'hello', 'world', '31', 'february'];
    for (let i = 0; i < 500; i++) {
      const parts = [];
      const len = Math.floor(Math.random() * 10);
      for (let j = 0; j < len; j++) {
        parts.push(words[Math.floor(Math.random() * words.length)]);
      }
      const str = parts.join(' ');
      try {
        const res = parse(str);
        // Repeated parse of same string must yield exact same result
        const res2 = parse(str);
        assert.deepEqual(res, res2);
      } catch (e) {
        throw new Error(`Threw on random input: "${str}"`);
      }
    }
  }

  console.log('--- 10. A REPEAT ON NAMED DAYS IS NOT EATEN BY THE DATE ---');
  {
    // THE ORDERING BUG. "every monday and wednesday" contains a weekday, and the
    // date parser was perfectly happy to take it: it blanked out "monday",
    // leaving "every and wednesday" behind, so the recurrence never matched and
    // a repeating standup silently became a one off on next Monday. Whichever
    // pattern runs first wins the word, so the specific one has to go first.
    const r = parseQuickAdd('standup every monday and wednesday 9am', options);
    assert.equal(r.draft.title, 'standup', 'nothing is left over in the title');
    assert.deepEqual(r.draft.recur?.byWeekday, [1, 3], 'both days survived');
    assert.equal(r.draft.date, '2026-08-31', 'and it starts today, not next week');

    for (const [text, days] of [
      ['x every monday', [1]],
      ['x every mon and fri', [1, 5]],
      ['x every monday, wednesday and friday', [1, 3, 5]],
      ['x every tuesday and thursday', [2, 4]],
    ] as [string, number[]][]) {
      const got = parseQuickAdd(text, options);
      assert.deepEqual(got.draft.recur?.byWeekday, days, text);
      assert.equal(got.draft.title, 'x', `${text} leaves a clean title`);
    }

    // A weekday with no "every" is still a date, not a repeat.
    const once = parseQuickAdd('x monday', options);
    assert.equal(once.draft.recur, undefined, 'no repeat without "every"');
    assert.equal(once.draft.date, '2026-09-07', 'and it is the next Monday');
  }

  console.log('--- 11. A WRITTEN YEAR IS OBEYED ---');
  {
    // Rolling a written year forward creates the item years early, which is
    // worse than not understanding it at all.
    assert.equal(parseQuickAdd('gym 1 Jan 2030', options).draft.date, '2030-01-01');
    assert.equal(parseQuickAdd('gym 15 March 2027 9am', options).draft.date, '2027-03-15');
    assert.equal(parseQuickAdd('gym Jan 1 2030', options).draft.date, '2030-01-01');
    assert.equal(parseQuickAdd('gym 1 Jan 2020', options).draft.date, '2020-01-01',
      'a year in the past is still the year that was written');

    // The year comes out of the title with the rest of the date.
    assert.equal(parseQuickAdd('gym 1 Jan 2030', options).draft.title, 'gym');

    // A LEAP DAY, which only exists in the right year. This is the case that
    // proves the year is read before the date is validated.
    assert.equal(parseQuickAdd('leap 29 February 2028', options).draft.date, '2028-02-29');
    const notLeap = parseQuickAdd('leap 29 February 2027', options);
    assert.equal(notLeap.draft.date, '2026-08-31', '29 Feb 2027 does not exist');
    assert.ok(notLeap.draft.title.includes('29'), 'so it stays in the title');

    // Without a year, a date already gone means the next one.
    assert.equal(parseQuickAdd('gym 1 Jan', options).draft.date, '2027-01-01');
    assert.equal(parseQuickAdd('gym 25 December', options).draft.date, '2026-12-25');

    // Dates that do not exist are never invented.
    for (const bad of ['x 31 February', 'x 31 April', 'x 32 January', 'x 0 January']) {
      const got = parseQuickAdd(bad, options);
      assert.equal(got.draft.date, '2026-08-31', `${bad} keeps today`);
    }
  }

  console.log('--- 12. A TIME RANGE, AND THE MIDNIGHT WRAP ---');
  {
    // The single time pattern used to take the "5pm" and leave "to 6pm" in the
    // title, giving both an ugly title and an event of the wrong length.
    for (const text of ['meeting 5pm to 6pm', 'meeting 5pm-6pm', 'meeting from 5pm until 6pm']) {
      const r = parseQuickAdd(text, options);
      assert.equal(r.draft.title, 'meeting', `${text} leaves a clean title`);
      assert.equal(r.draft.startMin, 17 * 60, `${text} starts at 5pm`);
      assert.equal(r.draft.endMin, 18 * 60, `${text} ends at 6pm`);
    }

    const precise = parseQuickAdd('meeting 17:00 to 18:30', options);
    assert.equal(precise.draft.endMin, 18 * 60 + 30, 'the written end wins, not a default hour');

    // Past midnight, rather than refused.
    const late = parseQuickAdd('party 10pm to 1am', options);
    assert.equal(late.draft.startMin, 22 * 60);
    assert.equal(late.draft.endMin, 25 * 60, 'one in the morning is the next day');
    const equal = parseQuickAdd('vigil 9pm to 9pm', options);
    assert.equal(equal.draft.endMin! - equal.draft.startMin!, 24 * 60,
      'the same time twice is a whole day, never zero');

    // A range beats a duration, since both were written but only one is a fact.
    const both = parseQuickAdd('meeting 5pm to 6pm for 15m', options);
    assert.equal(both.draft.endMin, 18 * 60, 'the range wins');

    // A lone time still behaves exactly as it did.
    const lone = parseQuickAdd('meeting 5pm', options);
    assert.equal(lone.draft.startMin, 17 * 60);
    assert.equal(lone.draft.endMin, 18 * 60, 'and still gets the default hour');

    // "to" in ordinary prose is not a range and must not be eaten.
    const prose = parseQuickAdd('go to the shop', options);
    assert.equal(prose.draft.title, 'go to the shop');
    assert.equal(prose.draft.startMin, null);
  }


  console.log('\nALL PASS (quickAdd: events, tasks, durations, recurrence, tags, time/date, degenerate)');
}

main();
