// Tests the phone's overlay priority and what the back button does.
//
// THE ONE THAT MATTERS: back closes what you can SEE. The two orders used to be
// written out separately and had drifted into being nearly each other's reverse,
// so with two screens open the back button dismissed the hidden one and the
// visible one sat there unchanged. Nothing about that is reachable from a single
// screen, which is why it survived so long.
//
// Run with: npx tsx src/lib/overlayStack.test.ts

import assert from 'node:assert/strict';
import {
  OVERLAY_ORDER, backAction, backTarget, topOverlay,
  type OverlayFlags, type OverlayName,
} from './overlayStack';

/** Every combination of open screens, as a bitmask over OVERLAY_ORDER. */
function flagsFor(mask: number): OverlayFlags {
  const out: OverlayFlags = {};
  OVERLAY_ORDER.forEach((name, i) => {
    if ((mask >> i) & 1) out[name] = true;
  });
  return out;
}

function main() {
  console.log('--- 1. NOTHING OPEN ---');
  {
    assert.equal(topOverlay({}), null);
    assert.equal(backTarget({}), null);
    assert.deepEqual(backAction({}, { tab: 'calendar' }), { kind: 'exit' });
  }

  console.log('--- 2. ONE OPEN IS ITSELF THE ANSWER ---');
  {
    for (const name of OVERLAY_ORDER) {
      assert.equal(topOverlay({ [name]: true }), name, `${name} is on top when alone`);
      assert.deepEqual(backAction({ [name]: true }, { tab: 'calendar' }),
        { kind: 'close-overlay', overlay: name }, `back closes ${name}`);
    }
  }

  console.log('--- 3. BACK CLOSES WHAT IS DRAWN. EVERY COMBINATION. ---');
  {
    // THE REGRESSION, and the only way to be sure of it: 512 combinations of
    // nine screens. There is no combination in which back may close something
    // other than the one on top, because the one on top is the only one the
    // user can see.
    const total = 1 << OVERLAY_ORDER.length;
    assert.equal(total, 512, 'nine screens');

    for (let mask = 0; mask < total; mask += 1) {
      const open = flagsFor(mask);
      const top = topOverlay(open);
      assert.equal(backTarget(open), top, `mask ${mask}: back and the screen agree`);

      const action = backAction(open, { tab: 'calendar' });
      if (top) {
        assert.deepEqual(action, { kind: 'close-overlay', overlay: top },
          `mask ${mask}: back closes the one on top`);
      } else {
        assert.equal(mask, 0, 'only an empty set has nothing on top');
      }
    }
  }

  console.log('--- 4. THE PAIRS THAT ACTUALLY HAPPEN ---');
  {
    // Named, so a future reordering that breaks one of these fails on something
    // a person can read rather than on "mask 322".
    const pairs: Array<[OverlayName, OverlayName, OverlayName]> = [
      // [open, also open, which must close first]
      ['notifications', 'reminders', 'reminders'],   // the bell opens reminders
      ['settings' as OverlayName, 'diagnostics', 'diagnostics'],
      ['search', 'planner', 'planner'],
      ['conflicts', 'notifications', 'conflicts'],   // the banner covers the bell
      ['categories', 'search', 'categories'],
      ['taskSettings', 'prayers', 'taskSettings'],
    ];
    for (const [a, b, winner] of pairs) {
      const open: OverlayFlags = {};
      if (OVERLAY_ORDER.includes(a)) open[a] = true;
      open[b] = true;
      assert.equal(topOverlay(open), winner, `${a} + ${b} -> ${winner}`);
    }
  }

  console.log('--- 5. BACK NEVER LEAVES THE APP WHILE SOMETHING IS OPEN ---');
  {
    // The worst outcome available here: the user presses back expecting to close
    // something and the app shuts instead. It must be impossible with anything
    // at all on screen.
    for (let mask = 1; mask < (1 << OVERLAY_ORDER.length); mask += 1) {
      for (const tab of ['calendar', 'tasks', 'focus', 'settings']) {
        for (const sheetOpen of [true, false]) {
          const action = backAction(flagsFor(mask), { tab, sheetOpen });
          assert.notEqual(action.kind, 'exit', `mask ${mask} on ${tab}: never exits`);
          // Stronger, and the one that actually matters: with something open,
          // back closes THAT and does nothing else. Merely "does not exit" would
          // be satisfied by quietly switching tabs underneath the user.
          assert.deepEqual(action, { kind: 'close-overlay', overlay: topOverlay(flagsFor(mask)) },
            `mask ${mask} on ${tab} (sheet ${sheetOpen}): closes the screen on top`);
        }
      }
    }
    // And with a sheet open but no overlay, it closes the sheet rather than
    // leaving the tab or the app.
    assert.deepEqual(backAction({}, { tab: 'calendar', sheetOpen: true }), { kind: 'close-sheet' });
    assert.deepEqual(backAction({}, { tab: 'tasks', sheetOpen: true }), { kind: 'close-sheet' });
  }

  console.log('--- 6. THE ORDER OF THE STEPS DOWN TO LEAVING ---');
  {
    // Overlay, then sheet, then back to the home tab, then out. One rung at a
    // time, and never two.
    assert.deepEqual(
      backAction({ search: true }, { tab: 'tasks', sheetOpen: true }),
      { kind: 'close-overlay', overlay: 'search' });
    assert.deepEqual(
      backAction({}, { tab: 'tasks', sheetOpen: true }),
      { kind: 'close-sheet' });
    assert.deepEqual(backAction({}, { tab: 'tasks' }), { kind: 'go-home' });
    assert.deepEqual(backAction({}, { tab: 'calendar' }), { kind: 'exit' });

    // A different home tab, in case the app ever opens somewhere else.
    assert.deepEqual(backAction({}, { tab: 'calendar', home: 'tasks' }), { kind: 'go-home' });
    assert.deepEqual(backAction({}, { tab: 'tasks', home: 'tasks' }), { kind: 'exit' });
  }

  console.log('--- 7. RUBBISH IN THE FLAGS ---');
  {
    // These come from React state, so they are booleans -- but `undefined` is
    // what a missing key reads as, and a falsy value must never count as open.
    assert.equal(topOverlay({ search: false, planner: undefined }), null);
    assert.equal(topOverlay({ search: false, planner: true }), 'planner');
    assert.equal(topOverlay({} as OverlayFlags), null);
    // An unknown key is not a screen and cannot be drawn.
    assert.equal(topOverlay({ nonsense: true } as unknown as OverlayFlags), null);
  }

  console.log('--- 8. THE LIST ITSELF IS SANE ---');
  {
    assert.equal(new Set(OVERLAY_ORDER).size, OVERLAY_ORDER.length, 'no screen listed twice');
    assert.ok(OVERLAY_ORDER.length > 0);
    for (const name of OVERLAY_ORDER) {
      assert.equal(typeof name, 'string');
      assert.notEqual(name, '', 'a screen with no name could never be matched');
    }
    assert.equal(OVERLAY_ORDER[0], 'diagnostics', 'opened from Settings, so it covers it');
  }

  console.log('\nALL PASS (overlayStack: one order for drawing and for back)');
}

main();
