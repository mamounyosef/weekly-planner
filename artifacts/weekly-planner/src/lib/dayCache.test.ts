// Tests for the agenda day cache, including a run against the REAL `buildDay`
// over a planner with repeats in it, because the failure that matters here is
// not "it was slow" but "it showed the user a day that no longer exists".
//
// Run with: npx tsx src/lib/dayCache.test.ts

import assert from 'node:assert/strict';
import { createKeyedCache, dayCacheKey, DEFAULT_CACHE_LIMIT } from './dayCache';
import { buildDay, ymd } from './agenda';
import { DEFAULT_CATEGORIES } from './categories';

function counting<V>(fn: (key: string) => V) {
  const calls: string[] = [];
  return {
    calls,
    build: (key: string) => { calls.push(key); return fn(key); },
  };
}

async function main() {
  console.log('--- 1. THE SECOND ASK IS FREE ---');
  {
    const c = counting((k: string) => `built:${k}`);
    const cache = createKeyedCache(c.build);

    assert.equal(cache.get('a'), 'built:a');
    assert.equal(cache.get('a'), 'built:a');
    assert.equal(cache.get('a'), 'built:a');
    assert.deepEqual(c.calls, ['a'], 'built once, answered three times');
    assert.deepEqual(cache.stats(), { hits: 2, misses: 1 });
    console.log('  ok');
  }

  console.log('--- 2. IT RETURNS THE SAME OBJECT, NOT AN EQUAL ONE ---');
  {
    // This is what lets React skip a subtree: identity, not deep equality.
    const cache = createKeyedCache((k: string) => ({ day: k, items: [] as string[] }));
    const first = cache.get('2026-09-02');
    const second = cache.get('2026-09-02');
    assert.equal(first, second, 'the identical object comes back');
    console.log('  ok');
  }

  console.log('--- 3. A MONTH GRID COSTS ONE PASS, NOT ONE PER RENDER ---');
  {
    const c = counting((k: string) => k.length);
    const cache = createKeyedCache(c.build);
    const days = Array.from({ length: 42 }, (_, i) => `d${i}`);

    for (let render = 0; render < 10; render++) {
      for (const d of days) cache.get(d);
    }
    assert.equal(c.calls.length, 42, 'ten renders of a month view, forty-two builds');
    assert.equal(cache.stats().hits, 42 * 9);
    console.log('  ok');
  }

  console.log('--- 4. IT IS BOUNDED ---');
  {
    const cache = createKeyedCache((k: string) => k, 10);
    for (let i = 0; i < 1_000; i++) cache.get(`k${i}`);
    assert.equal(cache.size(), 10, 'a year of scrolling does not grow forever');
    console.log('  ok');
  }

  console.log('--- 5. EVICTION IS BY LAST USE, NOT BY AGE ---');
  {
    const c = counting((k: string) => k);
    const cache = createKeyedCache(c.build, 3);

    cache.get('a');
    cache.get('b');
    cache.get('c');
    cache.get('a');          // a is now the most recently used
    cache.get('d');          // evicts b, the least recently used

    const before = c.calls.length;
    cache.get('a');
    assert.equal(c.calls.length, before, 'a was kept because it was still being read');
    cache.get('b');
    assert.equal(c.calls.length, before + 1, 'b was the one dropped');
    console.log('  ok');
  }

  console.log('--- 6. A LIMIT OF ZERO OR LESS IS STILL A WORKING CACHE ---');
  {
    for (const limit of [0, -5, 0.4, NaN]) {
      const cache = createKeyedCache((k: string) => k, limit as number);
      assert.equal(cache.get('x'), 'x', `limit ${limit} still answers`);
      assert.ok(cache.size() >= 1, 'and holds at least the one just built');
    }
    console.log('  ok');
  }

  console.log('--- 7. FALSY AND UNDEFINED ANSWERS ARE STILL CACHED ---');
  {
    // A `Map.get` returning undefined must not be read as "not present", or a
    // day with nothing in it would be rebuilt on every single render.
    const c = counting(() => undefined);
    const cache = createKeyedCache(c.build);
    cache.get('empty');
    cache.get('empty');
    cache.get('empty');
    assert.equal(c.calls.length, 1, 'an empty day is an answer like any other');

    const zero = counting(() => 0);
    const zeroCache = createKeyedCache(zero.build);
    zeroCache.get('z');
    zeroCache.get('z');
    assert.equal(zero.calls.length, 1);
    console.log('  ok');
  }

  console.log('--- 8. clear() REALLY CLEARS ---');
  {
    const c = counting((k: string) => k);
    const cache = createKeyedCache(c.build);
    cache.get('a');
    cache.clear();
    cache.get('a');
    assert.equal(c.calls.length, 2);
    assert.equal(cache.size(), 1);
    assert.deepEqual(cache.stats(), { hits: 0, misses: 1 }, 'the counters reset too');
    console.log('  ok');
  }

  console.log('--- 9. THE KEY SEPARATES "TODAY" FROM THE SAME DATE LATER ---');
  {
    const date = '2026-09-02';
    assert.equal(dayCacheKey(date, date), '2026-09-02|today');
    assert.equal(dayCacheKey(date, '2026-09-03'), '2026-09-02');
    assert.notEqual(
      dayCacheKey(date, date), dayCacheKey(date, '2026-09-03'),
      'the app left open across midnight asks a different question',
    );
    // And a different date is never confused with today.
    assert.equal(dayCacheKey('2026-09-03', '2026-09-02'), '2026-09-03');
    console.log('  ok');
  }

  console.log('--- 10. MIDNIGHT ROLLOVER: UNDATED TASKS MOVE WITH IT ---');
  {
    const events = {};
    const tasks = {
      loose: { title: 'No date on this one', listId: 'general' },
      dated: { title: 'Wednesday', weekKey: '2026-08-30', dayIndex: 3 },
    };
    const build = (key: string) => {
      const date = key.split('|')[0];
      return buildDay({
        events, tasks, date,
        weekStartsOn: 0,
        categories: DEFAULT_CATEGORIES as any,
        includeUndatedTasks: key.endsWith('|today'),
      });
    };
    const cache = createKeyedCache(build);

    const onTheDay = cache.get(dayCacheKey('2026-09-02', '2026-09-02'));
    assert.ok(
      onTheDay.tasks.some(t => t.title === 'No date on this one'),
      'while it is today, the loose task is shown',
    );

    // The clock ticks past midnight. Same date, different question.
    const theNextMorning = cache.get(dayCacheKey('2026-09-02', '2026-09-03'));
    assert.ok(
      !theNextMorning.tasks.some(t => t.title === 'No date on this one'),
      'yesterday does not keep the undated tasks',
    );
    assert.ok(
      theNextMorning.tasks.some(t => t.title === 'Wednesday'),
      'but what really was on that day is still there',
    );
    console.log('  ok');
  }

  console.log('--- 11. AGAINST THE REAL ENGINE: A WEEK OF A REPEATING EVENT ---');
  {
    // The shape the sync stores actually hold: a week key plus a day index,
    // not a date. Getting that wrong here would prove nothing about the app.
    const events = {
      standup: {
        title: 'Standup',
        weekKey: '2026-08-30',   // the Sunday
        dayIndex: 2,             // Tuesday, 2026-09-01
        startTime: '09:00',
        endTime: '09:15',
        recur: { freq: 'daily', interval: 1 },
      },
      once: {
        title: 'Dentist',
        weekKey: '2026-08-30',
        dayIndex: 4,             // Thursday, 2026-09-03
        startTime: '14:00',
        endTime: '15:00',
      },
    };
    const c = counting((key: string) => buildDay({
      events, tasks: {}, date: key.split('|')[0],
      weekStartsOn: 0, categories: DEFAULT_CATEGORIES as any,
    }));
    const cache = createKeyedCache(c.build);

    const week = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
      '2026-09-04', '2026-09-05', '2026-09-06'];

    const firstPass = week.map(d => cache.get(d));
    const secondPass = week.map(d => cache.get(d));

    assert.equal(c.calls.length, 7, 'seven days, seven builds, however many renders');
    for (let i = 0; i < week.length; i++) {
      assert.equal(firstPass[i], secondPass[i], `${week[i]} is the same object both times`);
    }

    // And the answers are the right ones, not merely consistent.
    assert.equal(
      firstPass[0].timed.filter(i => i.title === 'Standup').length, 0,
      'the day before it starts has no occurrence',
    );
    for (let i = 1; i < week.length; i++) {
      assert.equal(
        firstPass[i].timed.filter(item => item.title === 'Standup').length, 1,
        `${week[i]} has exactly one standup`,
      );
    }
    assert.ok(firstPass[3].timed.some(i => i.title === 'Dentist'), 'and the one-off is on its day');
    console.log('  ok');
  }

  console.log('--- 12. A NEW CACHE AFTER AN EDIT SHOWS THE EDIT ---');
  {
    // This is the invalidation contract in the form the app uses it: the cache
    // is created FROM the data, so an edit produces a new one and there is no
    // way to read a stale answer.
    const at = { weekKey: '2026-08-30', dayIndex: 3, startTime: '10:00', endTime: '11:00' };
    const before = { m: { title: 'Old title', ...at } };
    const after = { m: { title: 'New title', ...at } };
    const makeCache = (events: Record<string, unknown>) => createKeyedCache((key: string) =>
      buildDay({
        events: events as any, tasks: {}, date: key.split('|')[0],
        weekStartsOn: 0, categories: DEFAULT_CATEGORIES as any,
      }));

    const first = makeCache(before);
    assert.equal(first.get('2026-09-02').timed[0].title, 'Old title');

    const second = makeCache(after);
    assert.equal(second.get('2026-09-02').timed[0].title, 'New title', 'the edit is visible');
    console.log('  ok');
  }

  console.log('--- 13. IT ACTUALLY SAVES THE WORK IT CLAIMS TO ---');
  {
    // Not a timing assertion (those flake); a count of engine calls, which is
    // the thing the timing is a proxy for.
    const events: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      events[`e${i}`] = {
        title: `Event ${i}`,
        weekKey: '2026-08-30',
        dayIndex: i % 7,
        startTime: '08:00',
        endTime: '09:00',
        recur: i % 3 === 0 ? { freq: 'weekly', interval: 1 } : undefined,
      };
    }
    let engineCalls = 0;
    const cache = createKeyedCache((key: string) => {
      engineCalls += 1;
      return buildDay({
        events: events as any, tasks: {}, date: key.split('|')[0],
        weekStartsOn: 0, categories: DEFAULT_CATEGORIES as any,
      });
    });

    const month = Array.from({ length: 42 }, (_, i) => {
      const d = new Date('2026-09-01T00:00:00');
      d.setDate(d.getDate() + i);
      return ymd(d);
    });
    for (let render = 0; render < 20; render++) for (const d of month) cache.get(d);

    assert.equal(engineCalls, 42, 'twenty renders of a busy month: forty-two engine passes');
    assert.equal(cache.stats().hits, 42 * 19);
    assert.ok(cache.size() <= DEFAULT_CACHE_LIMIT);
    console.log('  ok');
  }

  console.log('--- 14. A BUILD THAT THROWS IS NOT REMEMBERED AS AN ANSWER ---');
  {
    let fail = true;
    const cache = createKeyedCache((k: string) => {
      if (fail) throw new Error('bad day');
      return `ok:${k}`;
    });

    assert.throws(() => cache.get('x'), /bad day/);
    assert.equal(cache.size(), 0, 'nothing was stored');
    fail = false;
    assert.equal(cache.get('x'), 'ok:x', 'and it can be built once it works');
    console.log('  ok');
  }

  console.log('\nAll dayCache tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
