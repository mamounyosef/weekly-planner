// Tests for the coalescer, on a fake clock so the timing rules are asserted
// exactly rather than waited for.
//
// What is actually at stake: this sits between an edit and the durable copy of
// the planner, and between an edit and the OS alarms. "Ran once with the newest
// payload" and "never lost a request" are not performance properties here, they
// are correctness properties.
//
// Run with: npx tsx src/lib/coalesce.test.ts

import assert from 'node:assert/strict';
import { createCoalescer, type CoalesceOptions } from './coalesce';

/** A controllable clock and timer queue. */
function fakeClock() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    now: () => t,
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer(handle: unknown) { timers.delete(handle as number); },
    pending: () => timers.size,
    /** Advance time, firing anything due, oldest first. */
    async advance(ms: number) {
      const target = t + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, entry] of timers) {
          if (entry.at <= target && entry.at < dueAt) { dueAt = entry.at; dueId = id; }
        }
        if (dueId === null) break;
        const entry = timers.get(dueId)!;
        timers.delete(dueId);
        t = entry.at;
        entry.fn();
        // Let the promise chain inside `fire` run to completion.
        await drain();
      }
      t = target;
      await drain();
    },
  };
}

/** Let every already-resolved microtask (and any zero-delay await) settle. */
async function drain(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function make<T>(clock: ReturnType<typeof fakeClock>, o: Partial<CoalesceOptions<T>> & {
  run: CoalesceOptions<T>['run'];
}) {
  return createCoalescer<T>({
    delayMs: 100,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...o,
  });
}

async function main() {
  console.log('--- 1. A BURST BECOMES ONE RUN, WITH THE NEWEST PAYLOAD ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, { run: p => { runs.push(p); } });

    c.schedule('a');
    await clock.advance(30);
    c.schedule('b');
    await clock.advance(30);
    c.schedule('c');
    assert.deepEqual(runs, [], 'nothing yet: the finger is still moving');

    await clock.advance(100);
    assert.deepEqual(runs, ['c'], 'once, and with the value the user ended on');
    console.log('  ok');
  }

  console.log('--- 2. NOTHING RUNS WITHOUT A REQUEST ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, { run: p => { runs.push(p); } });
    await clock.advance(10_000);
    assert.deepEqual(runs, []);
    assert.equal(c.busy(), false);
    console.log('  ok');
  }

  console.log('--- 3. A CONTINUOUS DRAG STILL SAVES, BECAUSE OF maxWait ---');
  {
    const clock = fakeClock();
    const runs: number[] = [];
    const c = make<number>(clock, { delayMs: 100, maxWaitMs: 500, run: p => { runs.push(p); } });

    // A request every 40ms for two seconds: without maxWait the quiet period
    // never arrives and nothing is ever written.
    for (let i = 1; i <= 50; i++) {
      c.schedule(i);
      await clock.advance(40);
    }
    assert.ok(runs.length >= 3, `ran repeatedly under continuous pressure (${runs.length})`);
    assert.ok(runs.length <= 6, `but not once per request (${runs.length})`);
    assert.ok(runs.every((v, i) => i === 0 || v > runs[i - 1]), 'always moving forward');

    await c.flush();
    assert.equal(runs.at(-1), 50, 'and the final position is the one that lands');
    console.log('  ok');
  }

  console.log('--- 4. WITHOUT maxWait, THE QUIET PERIOD IS THE ONLY RULE ---');
  {
    const clock = fakeClock();
    const runs: number[] = [];
    const c = make<number>(clock, { delayMs: 100, run: p => { runs.push(p); } });
    for (let i = 1; i <= 20; i++) {
      c.schedule(i);
      await clock.advance(40);
    }
    assert.deepEqual(runs, [], 'held off for as long as the requests kept coming');
    await clock.advance(100);
    assert.deepEqual(runs, [20]);
    console.log('  ok');
  }

  console.log('--- 5. A REQUEST DURING A RUN IS NOT LOST ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    let release: (() => void) | null = null;
    const c = make<string>(clock, {
      run: async p => {
        runs.push(p);
        if (p === 'first') await new Promise<void>(r => { release = r; });
      },
    });

    c.schedule('first');
    await clock.advance(100);
    assert.deepEqual(runs, ['first'], 'the first run is in flight');

    // The user edits again while the save is still going.
    c.schedule('second');
    assert.equal(c.busy(), true);
    await drain();
    assert.deepEqual(runs, ['first'], 'not started concurrently');

    release!();
    await drain();
    assert.deepEqual(runs, ['first', 'second'], 'it ran straight after, no extra wait');
    assert.equal(c.busy(), false);
    console.log('  ok');
  }

  console.log('--- 6. TWO RUNS NEVER OVERLAP ---');
  {
    const clock = fakeClock();
    let inFlight = 0;
    let maxInFlight = 0;
    const c = make<number>(clock, {
      delayMs: 10,
      run: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await drain(3);
        inFlight -= 1;
      },
    });

    for (let i = 0; i < 40; i++) {
      c.schedule(i);
      await clock.advance(12);
    }
    await c.flush();
    assert.equal(maxInFlight, 1, 'the whole point: one writer at a time');
    console.log('  ok');
  }

  console.log('--- 7. FLUSH RUNS IT NOW AND WAITS FOR IT ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, {
      delayMs: 5_000,
      run: async p => { await drain(3); runs.push(p); },
    });

    c.schedule('x');
    assert.deepEqual(runs, []);
    await c.flush();
    assert.deepEqual(runs, ['x'], 'backgrounding the app does not wait out the delay');
    assert.equal(clock.pending(), 0, 'and the timer was cleared, so it does not run twice');

    await clock.advance(10_000);
    assert.deepEqual(runs, ['x'], 'really: exactly once');
    console.log('  ok');
  }

  console.log('--- 8. FLUSH WITH NOTHING PENDING DOES NOTHING ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, { run: p => { runs.push(p); } });
    await c.flush();
    assert.deepEqual(runs, []);
    console.log('  ok');
  }

  console.log('--- 9. FLUSH DURING A RUN WAITS, THEN DOES THE LATEST ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    let release: (() => void) | null = null;
    const c = make<string>(clock, {
      run: async p => {
        runs.push(p);
        if (p === 'slow') await new Promise<void>(r => { release = r; });
      },
    });

    c.schedule('slow');
    await clock.advance(100);
    c.schedule('newest');

    const flushing = c.flush();
    let done = false;
    void flushing.then(() => { done = true; });
    await drain();
    assert.equal(done, false, 'flush is still waiting on the run in flight');

    release!();
    await flushing;
    assert.deepEqual(runs, ['slow', 'newest']);
    assert.equal(c.busy(), false, 'and everything really is finished when flush resolves');
    console.log('  ok');
  }

  console.log('--- 10. CANCEL DROPS WHAT IS WAITING ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, { run: p => { runs.push(p); } });

    c.schedule('doomed');
    c.cancel();
    await clock.advance(1_000);
    assert.deepEqual(runs, []);
    assert.equal(c.busy(), false);

    c.schedule('kept');
    await clock.advance(100);
    assert.deepEqual(runs, ['kept'], 'and it works again afterwards');
    console.log('  ok');
  }

  console.log('--- 11. A THROW IS REPORTED AND FORGOTTEN ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const errors: string[] = [];
    let explode = true;
    const c = make<string>(clock, {
      run: p => {
        if (explode) { explode = false; throw new Error(`boom on ${p}`); }
        runs.push(p);
      },
      onError: e => errors.push(String(e)),
    });

    c.schedule('bad');
    await clock.advance(100);
    assert.deepEqual(runs, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom on bad/);

    c.schedule('good');
    await clock.advance(100);
    assert.deepEqual(runs, ['good'], 'a failed alarm plan does not stop the next one');
    console.log('  ok');
  }

  console.log('--- 12. A REJECTED PROMISE IS THE SAME AS A THROW ---');
  {
    const clock = fakeClock();
    const errors: unknown[] = [];
    const runs: string[] = [];
    let fail = true;
    const c = make<string>(clock, {
      run: async p => {
        if (fail) { fail = false; throw new Error('async boom'); }
        runs.push(p);
      },
      onError: e => errors.push(e),
    });

    c.schedule('a');
    await clock.advance(100);
    await drain();
    assert.equal(errors.length, 1);

    c.schedule('b');
    await c.flush();
    assert.deepEqual(runs, ['b']);
    console.log('  ok');
  }

  console.log('--- 13. AN onError THAT ITSELF THROWS CANNOT WEDGE IT ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    let fail = true;
    const c = make<string>(clock, {
      run: p => { if (fail) { fail = false; throw new Error('x'); } runs.push(p); },
      onError: () => { throw new Error('the logger is broken too'); },
    });

    c.schedule('a');
    await clock.advance(100);
    c.schedule('b');
    await clock.advance(100);
    assert.deepEqual(runs, ['b']);
    console.log('  ok');
  }

  console.log('--- 14. ZERO DELAY IS STILL COALESCED WITHIN A TICK ---');
  {
    const clock = fakeClock();
    const runs: number[] = [];
    const c = make<number>(clock, { delayMs: 0, run: p => { runs.push(p); } });

    c.schedule(1);
    c.schedule(2);
    c.schedule(3);
    assert.deepEqual(runs, [], 'never synchronous: the caller keeps its frame');
    await clock.advance(0);
    assert.deepEqual(runs, [3]);
    console.log('  ok');
  }

  console.log('--- 15. THE PAYLOAD IS NEVER APPLIED OUT OF ORDER ---');
  {
    const clock = fakeClock();
    const seen: number[] = [];
    const c = make<number>(clock, {
      delayMs: 20,
      maxWaitMs: 60,
      run: async p => { await drain(4); seen.push(p); },
    });

    let n = 0;
    for (let i = 0; i < 200; i++) {
      c.schedule(++n);
      await clock.advance(7);
    }
    await c.flush();

    assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), 'strictly increasing');
    assert.equal(seen.at(-1), n, 'and it finishes on the very latest state');
    console.log('  ok');
  }

  console.log('--- 16. SCHEDULING FROM INSIDE THE RUN IS HANDLED, NOT LOOPED ---');
  {
    const clock = fakeClock();
    const runs: number[] = [];
    let again = true;
    const c = make<number>(clock, {
      run: p => {
        runs.push(p);
        // A replan that notices the data moved under it and asks for one more.
        if (again) { again = false; c.schedule(p + 1); }
      },
    });

    c.schedule(1);
    await clock.advance(100);
    await drain();
    assert.deepEqual(runs, [1, 2], 'the follow-up ran, and then it stopped');
    assert.equal(c.busy(), false);
    console.log('  ok');
  }

  console.log('--- 17. settled() WAITS WITHOUT STARTING ANYTHING ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, { delayMs: 500, run: p => { runs.push(p); } });

    c.schedule('later');
    await c.settled();
    assert.deepEqual(runs, [], 'settled is not flush: it does not force the work');
    await clock.advance(500);
    assert.deepEqual(runs, ['later']);
    console.log('  ok');
  }

  console.log('--- 18. FLUSH IS SAFE TO CALL TWICE AT ONCE ---');
  {
    const clock = fakeClock();
    const runs: string[] = [];
    const c = make<string>(clock, {
      delayMs: 1_000,
      run: async p => { await drain(4); runs.push(p); },
    });

    c.schedule('once');
    await Promise.all([c.flush(), c.flush(), c.flush()]);
    assert.deepEqual(runs, ['once'], 'three backgrounding signals, one write');
    console.log('  ok');
  }

  console.log('--- 19. maxWait COUNTS FROM THE OLDEST UNRUN REQUEST ---');
  {
    const clock = fakeClock();
    const runs: number[] = [];
    const c = make<number>(clock, { delayMs: 100, maxWaitMs: 250, run: p => { runs.push(p); } });

    c.schedule(1);            // t=0, oldest = 0
    await clock.advance(90);
    c.schedule(2);            // t=90, would push the quiet period to t=190
    await clock.advance(90);
    c.schedule(3);            // t=180, would push it to t=280 -> capped at 250
    await clock.advance(80);  // t=260

    assert.deepEqual(runs, [3], 'the cap fired at 250, not at 280');
    console.log('  ok');
  }

  console.log('--- 20. AFTER A RUN, THE CLOCK STARTS AGAIN FROM SCRATCH ---');
  {
    const clock = fakeClock();
    const runs: number[] = [];
    const c = make<number>(clock, { delayMs: 100, maxWaitMs: 250, run: p => { runs.push(p); } });

    c.schedule(1);
    await clock.advance(100);
    assert.deepEqual(runs, [1]);

    // A second burst, long after: it gets its own full quiet period rather than
    // inheriting an expired deadline and firing immediately.
    await clock.advance(10_000);
    c.schedule(2);
    await clock.advance(50);
    assert.deepEqual(runs, [1], 'still waiting, as it should be');
    await clock.advance(50);
    assert.deepEqual(runs, [1, 2]);
    console.log('  ok');
  }

  console.log('\nAll coalesce tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
