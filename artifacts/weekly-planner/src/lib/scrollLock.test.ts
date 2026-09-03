// Tests the ref-counted scroll lock behind drag-to-reorder.
//
// WHY THIS IS WORTH A FILE OF ITS OWN
// Every failure here has the same symptom: a screen that cannot be scrolled any
// more, with nothing on it to say why, until you leave and come back. The cases
// that produce it are the ones a thumb cannot reliably reproduce -- a release
// arriving after the row that sent it has gone, two lists holding at once, an
// unmount in the middle of a gesture -- so they are pinned here instead.
//
// Run with: npx tsx src/lib/scrollLock.test.ts

import assert from 'node:assert/strict';
import { NO_HOLDS, isHeld, releaseAll, setHold } from './scrollLock';

function main() {
  console.log('--- 1. NOTHING HELD IS NOTHING HELD ---');
  {
    assert.equal(isHeld(NO_HOLDS), false);
    assert.deepEqual([...NO_HOLDS], []);
    // Frozen, because it is shared between every idle scroller on the screen.
    assert.throws(() => (NO_HOLDS as number[]).push(1), 'the empty list cannot be written to');
  }

  console.log('--- 2. ONE LIST TAKES A HOLD AND GIVES IT BACK ---');
  {
    const held = setHold(NO_HOLDS, 1, true);
    assert.equal(isHeld(held), true, 'the page stops scrolling');
    const done = setHold(held, 1, false);
    assert.equal(isHeld(done), false, 'and starts again');
    assert.equal(done, NO_HOLDS, 'back to the shared empty list');
  }

  console.log('--- 3. A NESTED LIST: THE STEPS INSIDE A TASK CARD ---');
  {
    // THE CASE A BOOLEAN GETS WRONG. The page's list is held, then the steps
    // inside one of its cards take a hold of their own; the steps let go first.
    // A boolean would unlock the page while the outer drag was still running.
    let held = setHold(NO_HOLDS, 1, true);
    held = setHold(held, 2, true);
    assert.equal(isHeld(held), true);

    held = setHold(held, 2, false);
    assert.equal(isHeld(held), true, 'the outer drag is still going');

    held = setHold(held, 1, false);
    assert.equal(isHeld(held), false, 'and only now does the page move again');
  }

  console.log('--- 4. RELEASES ARRIVING IN THE WRONG ORDER ---');
  {
    // Nothing guarantees the order: two lists, two fingers, and React commits
    // whenever it commits. Every order must end unlocked.
    const orders = [
      [1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1],
    ];
    for (const order of orders) {
      let held = NO_HOLDS;
      for (const id of [1, 2, 3]) held = setHold(held, id, true);
      for (let i = 0; i < order.length; i += 1) {
        held = setHold(held, order[i], false);
        assert.equal(isHeld(held), i < order.length - 1,
          `${order.join(',')}: held until the last one lets go`);
      }
      assert.equal(held, NO_HOLDS, `${order.join(',')}: ends clean`);
    }
  }

  console.log('--- 5. THE SAME HOLD TWICE, AND THE SAME RELEASE TWICE ---');
  {
    // A row re-registering the hold it already has must not add a second one,
    // or its single release will leave the page locked for good. It must also
    // return the SAME array, because this feeds React state and a fresh array
    // re-renders the whole scroller mid-drag.
    const once = setHold(NO_HOLDS, 7, true);
    const twice = setHold(once, 7, true);
    assert.equal(twice, once, 'nothing changed, so nothing is re-rendered');
    assert.equal(isHeld(setHold(twice, 7, false)), false, 'one release is enough');

    // Releasing something that was never held is harmless and also changes
    // nothing: this is what an unmount does for a row that never dragged.
    assert.equal(setHold(NO_HOLDS, 9, false), NO_HOLDS);
    const other = setHold(NO_HOLDS, 1, true);
    assert.equal(setHold(other, 2, false), other, 'and it does not disturb the real hold');
  }

  console.log('--- 6. AN ID THAT COULD NEVER BE GIVEN BACK IS NEVER TAKEN ---');
  {
    // A hold under a key nothing can produce again is a hold that can never be
    // released, and the page stays frozen for as long as it is open. Better to
    // refuse it and let the drag fail than to freeze the screen.
    for (const junk of [NaN, Infinity, -Infinity]) {
      assert.equal(setHold(NO_HOLDS, junk, true), NO_HOLDS, `${junk} is not an id`);
      const held = setHold(NO_HOLDS, 1, true);
      assert.equal(setHold(held, junk, true), held, `${junk} does not join a real hold`);
      assert.equal(setHold(held, junk, false), held, `${junk} does not disturb one either`);
    }
    // Zero and negatives ARE ids: the counter starts at 1 today, but nothing
    // here should depend on that.
    assert.equal(isHeld(setHold(NO_HOLDS, 0, true)), true);
    assert.equal(isHeld(setHold(NO_HOLDS, -3, true)), true);
  }

  console.log('--- 7. THE WHOLE LIST GOES AWAY MID-DRAG ---');
  {
    // Nothing will ever arrive to release the individual holds, because the
    // things that took them no longer exist.
    let held = NO_HOLDS;
    for (const id of [4, 5, 6]) held = setHold(held, id, true);
    assert.equal(isHeld(releaseAll(held)), false);
    assert.equal(releaseAll(held), NO_HOLDS);
    assert.equal(releaseAll(NO_HOLDS), NO_HOLDS, 'and doing it twice is free');
  }

  console.log('--- 8. A LONG RUN OF HOLDS AND RELEASES ENDS WHERE IT SHOULD ---');
  {
    // A deterministic shuffle of takes and gives, checked against a plain count.
    // The invariant is only ever "locked exactly when something holds it".
    let seed = 20260903;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    let held = NO_HOLDS;
    const truth = new Set<number>();
    for (let step = 0; step < 2000; step += 1) {
      const id = Math.floor(rnd() * 6);
      const on = rnd() < 0.5;
      held = setHold(held, id, on);
      if (on) truth.add(id); else truth.delete(id);

      assert.equal(isHeld(held), truth.size > 0, `step ${step}`);
      assert.deepEqual([...held].sort((a, b) => a - b), [...truth].sort((a, b) => a - b),
        `step ${step}: the same holds, and no duplicates`);
      assert.equal(new Set(held).size, held.length, `step ${step}: each id once`);
    }

    // And everything let go ends exactly where it started.
    for (const id of [...truth]) held = setHold(held, id, false);
    assert.equal(held, NO_HOLDS, 'no residue');
  }

  console.log('\nALL PASS (scrollLock: nesting, out-of-order releases, unmount, identity)');
}

main();
