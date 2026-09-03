// Tests for the held tick.
//
// The thing that must never happen here is a tap that writes twice, or a tap
// that writes nothing. Both look identical on a phone -- a box that is filled
// when you expected it empty -- and both are only reachable by tapping fast,
// which is exactly what people do with a shopping list.
//
// Run with: npx tsx src/lib/pendingDone.test.ts

import assert from 'node:assert/strict';
import {
  planTick, shownDone, isPending, setPending, applyGuesses, type PendingMap,
} from './pendingDone';

/** Replays a run of taps through the same rules the screen uses. */
function screen(stored: boolean) {
  let pending: PendingMap = {};
  const writes: boolean[] = [];   // what each write would set `done` to
  const KEY = 'row';

  return {
    get stored() { return stored; },
    get shown() { return shownDone(stored, isPending(pending, KEY)); },
    get held() { return isPending(pending, KEY); },
    writes,
    /** A tap, and the hold that has not expired yet. */
    tap() {
      const plan = planTick(stored, isPending(pending, KEY));
      if (plan === 'write') {
        pending = setPending(pending, KEY, false);
        stored = !stored;
        writes.push(stored);
      } else if (plan === 'cancel') {
        pending = setPending(pending, KEY, false);
      } else {
        pending = setPending(pending, KEY, true);
      }
      return plan;
    },
    /** The hold expiring: the write finally happens. */
    settle() {
      if (!isPending(pending, KEY)) return;
      stored = true;
      writes.push(true);
      pending = setPending(pending, KEY, false);
    },
  };
}

async function main() {
  console.log('--- 1. THE THREE PLANS ---');
  {
    assert.equal(planTick(false, false), 'hold', 'ticking something not done');
    assert.equal(planTick(false, true), 'cancel', 'tapping again inside the hold');
    assert.equal(planTick(true, false), 'write', 'un-ticking');
    // Stored and pending at once is not a state the screen should reach, but if
    // it does, the STORE wins: it is the only one of the two that is real.
    assert.equal(planTick(true, true), 'write');
    console.log('  ok');
  }

  console.log('--- 2. ONE TAP, ONE WRITE, AFTER THE HOLD ---');
  {
    const s = screen(false);
    assert.equal(s.tap(), 'hold');
    assert.equal(s.shown, true, 'filled immediately');
    assert.equal(s.stored, false, 'and nothing written yet');
    assert.deepEqual(s.writes, []);
    s.settle();
    assert.equal(s.stored, true);
    assert.equal(s.shown, true, 'no flicker when the write lands');
    assert.deepEqual(s.writes, [true], 'exactly one write');
    assert.equal(s.held, false, 'and nothing left held');
    console.log('  ok');
  }

  console.log('--- 3. A SECOND TAP INSIDE THE HOLD WRITES NOTHING AT ALL ---');
  {
    const s = screen(false);
    s.tap();
    assert.equal(s.tap(), 'cancel');
    assert.equal(s.shown, false, 'back to empty');
    s.settle();
    assert.deepEqual(s.writes, [], 'the store was never touched');
    assert.equal(s.stored, false);
    console.log('  ok');
  }

  console.log('--- 4. TAPPING LIKE A WOODPECKER ---');
  {
    // An even number of taps inside one hold must leave no trace; an odd number
    // must leave exactly one tick.
    for (let taps = 1; taps <= 9; taps += 1) {
      const s = screen(false);
      for (let i = 0; i < taps; i += 1) s.tap();
      s.settle();
      if (taps % 2 === 1) {
        assert.deepEqual(s.writes, [true], `${taps} taps tick it once`);
        assert.equal(s.stored, true);
      } else {
        assert.deepEqual(s.writes, [], `${taps} taps write nothing`);
        assert.equal(s.stored, false);
      }
      assert.equal(s.held, false);
    }
    console.log('  ok');
  }

  console.log('--- 5. UN-TICKING IS NEVER HELD ---');
  {
    const s = screen(true);
    assert.equal(s.shown, true);
    assert.equal(s.tap(), 'write');
    assert.equal(s.stored, false, 'written at once');
    assert.deepEqual(s.writes, [false]);
    assert.equal(s.held, false, 'and nothing is pending afterwards');
    // Which means tick, un-tick, tick lands on ticked, with three writes.
    s.tap(); s.settle(); s.tap();
    assert.equal(s.stored, false);
    s.tap(); s.settle();
    assert.equal(s.stored, true);
    assert.deepEqual(s.writes, [false, true, false, true]);
    console.log('  ok');
  }

  console.log('--- 6. A HELD TICK SURVIVES THE SCREEN GOING AWAY ---');
  {
    // `settle` is what the unmount flush does too, so this is the same path:
    // the tap happened, and the delay was ours.
    const s = screen(false);
    s.tap();
    s.settle();          // stands in for the flush
    assert.deepEqual(s.writes, [true]);
    console.log('  ok');
  }

  console.log('--- 7. WHAT THE ROW DRAWS ---');
  {
    assert.equal(shownDone(false, false), false);
    assert.equal(shownDone(false, true), true, 'the guess wins over an empty store');
    assert.equal(shownDone(true, false), true);
    assert.equal(shownDone(true, true), true);
    console.log('  ok');
  }

  console.log('--- 8. THE MAP KEEPS ITS IDENTITY WHEN NOTHING CHANGES ---');
  {
    const empty: PendingMap = {};
    assert.equal(setPending(empty, 'a', false), empty, 'removing what is not there');
    const one = setPending(empty, 'a', true);
    assert.notEqual(one, empty);
    assert.equal(setPending(one, 'a', true), one, 'setting what is already set');
    assert.deepEqual(setPending(one, 'a', false), {}, 'and removing it empties it');
    assert.equal(isPending(one, 'a'), true);
    assert.equal(isPending(one, 'b'), false);
    assert.equal(isPending(empty, 'a'), false);
    console.log('  ok');
  }

  console.log('--- 9. KEYS THAT ARE NOT ORDINARY ---');
  {
    // Ids come from occurrence keys like `id::2026-09-03`, and a task can be
    // called anything at all. Nothing may fall through to Object.prototype.
    const odd = ['', '__proto__', 'constructor', 'toString', 'a::2026-09-03', '0', 'hasOwnProperty'];
    for (const key of odd) {
      let state: PendingMap = {};
      assert.equal(isPending(state, key), false, `${key} starts clear`);
      state = setPending(state, key, true);
      assert.equal(isPending(state, key), true, `${key} can be held`);
      state = setPending(state, key, false);
      assert.equal(isPending(state, key), false, `${key} can be released`);
      assert.deepEqual(Object.keys(state).filter(k => k === key), [], `${key} is gone`);
    }
    console.log('  ok');
  }

  console.log('--- 10. TWO ROWS HELD AT ONCE DO NOT SEE EACH OTHER ---');
  {
    let state: PendingMap = {};
    state = setPending(state, 'a', true);
    state = setPending(state, 'b', true);
    assert.deepEqual(state, { a: true, b: true });
    state = setPending(state, 'a', false);
    assert.deepEqual(state, { b: true });
    assert.equal(isPending(state, 'b'), true, 'b is untouched');
    console.log('  ok');
  }

  console.log('--- 11. THE DAY VIEW OVERLAY ---');
  {
    const items = [
      { id: 'x', completed: false },
      { id: 'y', completed: true },
      { id: 'z', completed: false },
    ];
    const key = (i: { id: string }) => i.id;

    assert.equal(applyGuesses(items, key, {}), items, 'no guesses, same array');

    const out = applyGuesses(items, key, { x: true });
    assert.notEqual(out, items);
    assert.deepEqual(out.map(i => i.completed), [true, true, false]);
    assert.equal(out[1], items[1], 'the rows nobody guessed keep their identity');
    assert.equal(out[2], items[2]);
    assert.equal(items[0].completed, false, 'and the input is not mutated');
    console.log('  ok');
  }

  console.log('--- 12. A GUESS THE STORE HAS CAUGHT UP WITH COSTS NOTHING ---');
  {
    // This is the ordinary case a second after a tap, and it must not keep
    // rebuilding the day: the array AND every row keep their identity.
    const items = [{ id: 'x', completed: true }, { id: 'y', completed: false }];
    const key = (i: { id: string }) => i.id;
    assert.equal(applyGuesses(items, key, { x: true }), items, 'agreeing guess, same array');
    assert.equal(applyGuesses(items, key, { x: true, y: false }), items, 'both agree');
    assert.equal(applyGuesses(items, key, { nobody: true }), items, 'a guess for a row that is gone');
    console.log('  ok');
  }

  console.log('--- 13. AN UN-TICK GUESS OVERLAYS TOO ---');
  {
    const items = [{ id: 'x', completed: true }];
    const out = applyGuesses(items, i => i.id, { x: false });
    assert.deepEqual(out.map(i => i.completed), [false]);
    console.log('  ok');
  }

  console.log('--- 14. AN EMPTY DAY ---');
  {
    const items: Array<{ id: string; completed: boolean }> = [];
    assert.equal(applyGuesses(items, i => i.id, { x: true }), items);
    assert.equal(applyGuesses(items, i => i.id, {}), items);
    console.log('  ok');
  }

  console.log('--- 15. TWO ROWS OF THE SAME REPEAT ON DIFFERENT DAYS ---');
  {
    // The key has to carry the date, or ticking Monday ticks Tuesday as well.
    const items = [
      { id: 'r', date: '2026-09-03', completed: false },
      { id: 'r', date: '2026-09-04', completed: false },
    ];
    const key = (i: { id: string; date: string }) => `${i.id}:${i.date}`;
    const out = applyGuesses(items, key, { 'r:2026-09-03': true });
    assert.deepEqual(out.map(i => i.completed), [true, false], 'only the day tapped');
    // Whereas keying by the id alone would take both, which is the bug.
    const wrong = applyGuesses(items, i => i.id, { r: true });
    assert.deepEqual(wrong.map(i => i.completed), [true, true]);
    console.log('  ok');
  }

  console.log('--- 16. A FULL RUN ACROSS A LIST ---');
  {
    // Five rows, ticked in a burst the way a shopping list is, one of them
    // taken back inside its hold. Exactly four writes, and the screen shows the
    // right thing at every step.
    const keys = ['a', 'b', 'c', 'd', 'e'];
    let pending: PendingMap = {};
    const stored: Record<string, boolean> = { a: false, b: false, c: false, d: false, e: false };
    const writes: string[] = [];

    const tap = (k: string) => {
      const plan = planTick(stored[k], isPending(pending, k));
      if (plan === 'write') { stored[k] = !stored[k]; writes.push(k); pending = setPending(pending, k, false); }
      else if (plan === 'cancel') pending = setPending(pending, k, false);
      else pending = setPending(pending, k, true);
    };
    const settle = (k: string) => {
      if (!isPending(pending, k)) return;
      stored[k] = true; writes.push(k); pending = setPending(pending, k, false);
    };

    keys.forEach(tap);
    assert.deepEqual(keys.map(k => shownDone(stored[k], isPending(pending, k))), [true, true, true, true, true]);
    tap('c');                                  // changed their mind
    assert.equal(shownDone(stored.c, isPending(pending, 'c')), false);
    keys.forEach(settle);
    assert.deepEqual(writes, ['a', 'b', 'd', 'e']);
    assert.deepEqual(stored, { a: true, b: true, c: false, d: true, e: true });
    assert.deepEqual(pending, {}, 'nothing left held');
    console.log('  ok');
  }

  console.log('\nAll pendingDone tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
