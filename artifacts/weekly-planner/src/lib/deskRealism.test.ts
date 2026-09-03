// The desk, end to end, against streams a real HC-SR04 actually produces.
//
// WHY ANOTHER DESK SUITE
// The existing ones test the pieces: the filter against distances, the reducer
// against inputs, the bridge against requests. This one runs the whole chain --
// centimetres in at the top, session actions out at the bottom -- against the
// specific ways this hardware misbehaves, because every fault this system has
// ever had lived in the seam between two pieces that were each correct.
//
// The streams below are not invented. They are the shapes seen on this desk:
//   * a receding ramp, where a beam losing its reflector reports 30, 80, 150,
//     400 rather than jumping straight to nothing;
//   * echo timeouts scattered through a ramp, which is what a half-returned
//     ping looks like;
//   * ringing, where the module reports a few centimetres because it heard its
//     own transducer;
//   * crosstalk, where pressing one button induces a falling edge on the other;
//   * a stream that simply stops, because wifi dropped or the board rebooted.
//
// Run with: npx tsx src/lib/deskRealism.test.ts

import assert from 'node:assert/strict';
import { createPresenceFilter, PresenceFilter, type SensorFilterConfig } from './sensorFilter';
import {
  reduceHardware, filterButtonBatch, dropCrosstalkButtons, presenceResync,
  DEFAULT_HARDWARE_SETTINGS,
  type HardwareControllerState, type HardwareSettings, type SessionSnapshot,
  type HardwareAction,
} from './hardwareController';

// ─── A desk you can drive ────────────────────────────────────────────────────

const SETTINGS: HardwareSettings = {
  ...DEFAULT_HARDWARE_SETTINGS,
  sensorEnabled: true,
  armSeconds: 30,
  awayPauseEnabled: true,
  awayTerminateSeconds: 300,
  autoRestartEnabled: false,
};

const idle: SessionSnapshot = { hasSession: false, isRunning: false, ready: true };
const running: SessionSnapshot = { hasSession: true, isRunning: true, ready: true };
const paused: SessionSnapshot = { hasSession: true, isRunning: false, ready: true };

function freshState(over: Partial<HardwareControllerState> = {}): HardwareControllerState {
  return {
    present: false,
    armingUntil: null,
    awaySince: null,
    stoppedByHand: false,
    sessionActive: false,
    manualSession: false,
    pausedByAway: false,
    ...over,
  } as HardwareControllerState;
}

/**
 * The whole chain: raw centimetres through the filter, the edges it produces
 * through the reducer, and whatever the reducer decided to do about it.
 */
class Desk {
  filter: PresenceFilter;
  state: HardwareControllerState;
  session: SessionSnapshot = idle;
  settings: HardwareSettings;
  actions: HardwareAction[] = [];
  /** Every presence input the reducer was actually handed. */
  edges: boolean[] = [];

  constructor(cfg: Partial<SensorFilterConfig> = {}, settings: HardwareSettings = SETTINGS) {
    this.filter = createPresenceFilter(cfg);
    this.state = freshState();
    this.settings = settings;
  }

  /** One sensor reading. `null` is an echo timeout. */
  ping(cm: number | null, at: number) {
    const snap = this.filter.push(cm, at);
    if (snap.ready && snap.changed) {
      this.edges.push(snap.present);
      this.apply({ kind: 'presence', present: snap.present }, at);
    }
    return snap;
  }

  /** A stream of readings at the board's own 100ms cadence. */
  stream(values: Array<number | null>, from: number, stepMs = 100) {
    let at = from;
    for (const v of values) { this.ping(v, at); at += stepMs; }
    return at;
  }

  /** Hold one distance for a while, which is what sitting still looks like. */
  hold(cm: number | null, ms: number, from: number, stepMs = 100, jitter = 0) {
    const values: Array<number | null> = [];
    for (let t = 0; t < ms; t += stepMs) {
      values.push(cm === null ? null : cm + (jitter ? ((t / stepMs) % 3) - 1 : 0) * jitter);
    }
    return this.stream(values, from, stepMs);
  }

  apply(input: Parameters<typeof reduceHardware>[1], at: number) {
    const out = reduceHardware(this.state, input, this.session, this.settings, at);
    this.state = out.state;
    this.actions.push(...out.actions);
    for (const a of out.actions) {
      if (a === 'start') this.session = running;
      else if (a === 'pause') this.session = paused;
      else if (a === 'resume') this.session = running;
      else if (a === 'terminate') this.session = idle;
    }
    return out.actions;
  }

  tick(at: number) { return this.apply({ kind: 'tick' }, at); }

  took(action: HardwareAction) { return this.actions.includes(action); }
  clear() { this.actions = []; }
}

const T0 = 1_800_000_000_000;

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  // A. The filter, against streams the module really produces
  // ═══════════════════════════════════════════════════════════════════════

  console.log('--- 1. SITTING STILL IS PRESENT, AND STAYS PRESENT ---');
  {
    const d = new Desk();
    d.hold(45, 6000, T0, 100, 1);          // a person at 45cm, breathing
    assert.equal(d.filter.snapshot.present, true, 'seated is present');
    assert.equal(d.filter.snapshot.ready, true);
    assert.deepEqual(d.edges, [true], 'exactly one edge, no flapping');
    console.log('  ok');
  }

  console.log('--- 2. A RECEDING RAMP IS NOT AN ABSENCE ---');
  {
    // The beam loses its reflector and reports the room behind you on the way
    // out. Believing those numbers is how a seated user gets marked away.
    const d = new Desk();
    let at = d.hold(40, 6000, T0);
    assert.equal(d.filter.snapshot.present, true);
    d.stream([80, 150, 400], at);          // the classic ramp
    assert.equal(d.filter.snapshot.present, true, 'still here through the ramp');
    assert.deepEqual(d.edges, [true], 'and no away edge was produced');
    console.log('  ok');
  }

  console.log('--- 3. A RAMP WITH AN IMPOSSIBLE READING IN THE MIDDLE OF IT ---');
  {
    // THE REGRESSION. Ringing -- a reading of a centimetre or two, from the
    // module hearing its own transducer -- is masked on sight and deliberately
    // does NOT reset the ramp counter. The retroactive mask used to walk back a
    // fixed number of INDICES, so that already-masked sample ate one of them
    // and the FIRST reading of the ramp stayed in the window: the 60 between a
    // seated 40 and a receding 120, which is exactly the number that drags the
    // cluster away from the person sitting there.
    //
    // The window is shortened so the ramp can fill it; at the default 1.5s the
    // seated readings outvote the escapee and hide the fault.
    const d = new Desk({ clusterWindowMs: 400 });
    const at = d.hold(40, 6000, T0);
    assert.equal(d.filter.snapshot.present, true);

    d.stream([60, 2, 80, 100], at);

    // Every sample of that ramp must be masked. With the old loop the 60 was
    // still countable, and the window it left behind said so.
    assert.equal(d.filter.snapshot.windowCount, 2,
      `only the two seated readings are left to judge, got ${d.filter.snapshot.windowCount}`);
    assert.equal(d.filter.snapshot.present, true, 'and the desk is still occupied');
    assert.deepEqual(d.edges, [true], 'with no away edge produced');
    console.log('  ok');
  }

  console.log('--- 4. RAMPS OF EVERY LENGTH, WITH THE RINGING ANYWHERE IN THEM ---');
  {
    // Exhaustive rather than anecdotal: an impossible reading at every position
    // of a ramp of every plausible length, and a timeout at every position too,
    // must never mark an occupied desk as empty.
    const ramps = [[60, 80, 100], [55, 75, 95, 115], [50, 70, 90, 110, 130]];
    for (const ramp of ramps) {
      for (const junk of [2, 1, null] as Array<number | null>) {
        for (let hole = 0; hole <= ramp.length; hole++) {
          const withHole: Array<number | null> = [...ramp];
          if (hole < ramp.length) withHole.splice(hole, 0, junk);
          const d = new Desk();
          const at = d.hold(40, 6000, T0);
          d.stream(withHole, at);
          assert.deepEqual(d.edges, [true],
            `ramp ${JSON.stringify(ramp)} with ${junk} at ${hole} produced ${JSON.stringify(d.edges)}`);
          assert.equal(d.filter.snapshot.present, true,
            `ramp ${JSON.stringify(ramp)} with ${junk} at ${hole} lost the person`);
        }
      }
    }
    console.log('  ok');
  }

  console.log('--- 5. ACTUALLY LEAVING IS STILL AN ABSENCE ---');
  {
    // The masking must not be so eager that walking away never registers.
    const d = new Desk();
    let at = d.hold(40, 6000, T0);
    at = d.stream([80, 150, 400], at);      // the ramp on the way out
    at = d.hold(null, 20000, at);           // and then simply nothing, for a while
    assert.equal(d.filter.snapshot.present, false, 'an empty desk is eventually empty');
    assert.deepEqual(d.edges, [true, false]);
    console.log('  ok');
  }

  console.log('--- 6. RINGING IS NOT SOMEBODY ARRIVING ---');
  {
    // The module hearing its own transducer reports a couple of centimetres.
    // Believing it would start a session at an empty desk.
    const d = new Desk();
    let at = d.hold(null, 20000, T0);
    assert.equal(d.filter.snapshot.present, false);
    at = d.stream([2, 1, 3, 2, 1, 2, 3, 1], at);
    assert.equal(d.filter.snapshot.present, false, 'ringing is not a person');
    assert.deepEqual(d.edges.slice(1), [], 'and produced no arrival');
    console.log('  ok');
  }

  console.log('--- 7. A DEAD SENSOR IS NOT AN EMPTY DESK ---');
  {
    // Nothing but timeouts from the very first ping: a disconnected module
    // looks exactly like an empty room, so the filter refuses to be ready
    // until it has heard one real echo.
    const d = new Desk();
    d.hold(null, 30000, T0);
    assert.equal(d.filter.snapshot.ready, false, 'never ready without an echo');
    assert.deepEqual(d.edges, [], 'and so it never spoke');
    assert.equal(d.state.armingUntil, null, 'nothing was armed');
    console.log('  ok');
  }

  console.log('--- 8. IMPOSSIBLE READINGS REPORT AS THEMSELVES ---');
  {
    // A window with nothing usable in it holds the verdict. WHICH KIND of
    // nothing is a diagnostic the user reads when the hardware is broken, and
    // calling a dead transducer "ramp masked" sent them looking for a moving
    // target that was never there.
    // Long enough to flush the 1.5s cluster window, so the ONLY thing left to
    // judge is the ringing.
    const d = new Desk();
    let at = d.hold(40, 6000, T0);
    d.hold(1, 3000, at);
    assert.equal(d.filter.snapshot.holding, 'no-valid-samples',
      `expected no-valid-samples, got ${d.filter.snapshot.holding}`);
    assert.equal(d.filter.snapshot.present, true, 'and the verdict is held, not flipped');

    // The other branch, with a short window so a masked ramp can fill it: every
    // sample the filter can see is one it has chosen to disbelieve.
    const e = new Desk({ clusterWindowMs: 400 });
    const at2 = e.hold(40, 6000, T0);
    e.stream([60, 80, 100, 120, 140, 160], at2);
    assert.equal(e.filter.snapshot.holding, 'ramp-masked',
      `expected ramp-masked, got ${e.filter.snapshot.holding}`);
    assert.equal(e.filter.snapshot.present, true, 'and the verdict is held here too');
    console.log('  ok');
  }

  console.log('--- 9. THE STREAM STOPPING IS NOT A DECISION ---');
  {
    // Wifi drops, or the board reboots. The samples either side of the hole
    // describe two unrelated moments and must not be compared.
    const d = new Desk();
    let at = d.hold(40, 6000, T0);
    assert.equal(d.filter.snapshot.present, true);
    at += 60_000;                            // a minute of silence
    d.hold(40, 3000, at);
    assert.equal(d.filter.snapshot.present, true, 'still seated after the gap');
    assert.deepEqual(d.edges, [true], 'and the gap itself said nothing');
    console.log('  ok');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. The reducer, against the ways two paths can both speak
  // ═══════════════════════════════════════════════════════════════════════

  console.log('--- 10. A REPEATED ARRIVAL DOES NOT RESTART THE COUNTDOWN ---');
  {
    // THE REGRESSION. `presenceResync` corrects a window that missed an edge,
    // and the bridge separately announces the current level to a window that
    // has just opened. Both arrive. The second used to re-arm: "starting in 5s"
    // jumped back to 30.
    const d = new Desk();
    d.apply({ kind: 'presence', present: true }, T0);
    const armed = d.state.armingUntil;
    assert.ok(armed !== null, 'the first arrival arms');

    d.apply({ kind: 'presence', present: true }, T0 + 25_000);
    assert.equal(d.state.armingUntil, armed, 'the second says nothing');

    // And the countdown still fires on time, five seconds later rather than
    // thirty-five.
    d.tick(T0 + 30_000);
    assert.equal(d.took('start'), true, 'and it started when it was always going to');
    console.log('  ok');
  }

  console.log('--- 11. A REPEATED ABSENCE DOES NOT PUSH BACK THE TERMINATE ---');
  {
    // Same guard, other direction. A level re-announced every poll used to
    // reset the away clock, so an abandoned session sat paused all day instead
    // of being terminated.
    const d = new Desk();
    d.session = running;
    d.state = freshState({ present: true, sessionActive: true });
    d.apply({ kind: 'presence', present: false }, T0);
    const awayAt = d.state.awaySince;
    assert.equal(awayAt, T0);
    assert.equal(d.took('pause'), true);

    for (let i = 1; i <= 20; i++) d.apply({ kind: 'presence', present: false }, T0 + i * 1500);
    assert.equal(d.state.awaySince, awayAt, 'the clock did not move');

    d.clear();
    d.tick(T0 + SETTINGS.awayTerminateSeconds * 1000);
    assert.equal(d.took('terminate'), true, 'and it terminated on time');
    console.log('  ok');
  }

  console.log('--- 12. THE DESK NEVER RESUMES WHAT YOU PAUSED BY HAND ---');
  {
    // THE REGRESSION, in the shape it actually reaches the user:
    //   the sensor pauses you, you resume from the app while still away,
    //   you pause again by hand, you walk off, you come back.
    // `pausedByAway` was left set by the first pause and never cleared, so the
    // desk claimed that last pause as its own and resumed it.
    const d = new Desk();
    d.session = running;
    d.state = freshState({ present: true, sessionActive: true });

    d.apply({ kind: 'presence', present: false }, T0);      // the sensor pauses
    assert.equal(d.took('pause'), true);
    assert.equal(d.state.pausedByAway, true);

    d.session = running;                                     // resumed from the app
    d.tick(T0 + 2000);
    assert.equal(d.state.awaySince, null, 'the away clock is dropped');
    assert.equal(d.state.pausedByAway, false, 'AND the claim that went with it');

    d.session = paused;                                      // paused by hand
    d.tick(T0 + 4000);

    d.clear();
    d.apply({ kind: 'presence', present: true }, T0 + 6000); // sit back down
    assert.equal(d.took('resume'), false, 'the desk keeps its hands off');

    // The longer route: away and back again, which is where it used to bite.
    d.apply({ kind: 'presence', present: false }, T0 + 8000);
    assert.equal(d.state.pausedByAway, false, 'a session already paused is not the desk s doing');
    d.clear();
    d.apply({ kind: 'presence', present: true }, T0 + 12_000);
    assert.equal(d.took('resume'), false, 'still hands off, after a real trip away');
    console.log('  ok');
  }

  console.log('--- 13. AND IT STILL RESUMES WHAT IT PAUSED ITSELF ---');
  {
    // The guard above must not cost the feature it is guarding.
    const d = new Desk();
    d.session = running;
    d.state = freshState({ present: true, sessionActive: true });
    d.apply({ kind: 'presence', present: false }, T0);
    assert.equal(d.took('pause'), true);
    d.clear();
    d.apply({ kind: 'presence', present: true }, T0 + 20_000);
    assert.equal(d.took('resume'), true, 'the desk resumes its own pause');
    assert.equal(d.state.pausedByAway, false, 'and lets go of the claim');
    console.log('  ok');
  }

  console.log('--- 14. A LEVEL THAT AGREES IS NEVER TURNED INTO AN EVENT ---');
  {
    // `presenceResync` is the other half of the guard: it only ever synthesises
    // a genuine disagreement, so a level published every poll costs nothing.
    const here = freshState({ present: true });
    for (let i = 0; i < 50; i++) {
      assert.equal(presenceResync(here, { present: true, ready: true, at: T0 + i }, T0 + i), null);
    }
    assert.deepEqual(
      presenceResync(here, { present: false, ready: true, at: T0 }, T0),
      { kind: 'presence', present: false },
      'a real disagreement still speaks',
    );
    assert.equal(presenceResync(here, { present: false, ready: false, at: T0 }, T0), null,
      'a filter that is not ready has no opinion to act on');
    console.log('  ok');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. The buttons, against wiring that talks to itself
  // ═══════════════════════════════════════════════════════════════════════

  console.log('--- 15. A PHANTOM IS DROPPED AND NOT REMEMBERED ---');
  {
    // THE REGRESSION. The ghost used to become the reference for the next poll,
    // so a genuine second press of the same button was discarded as crosstalk
    // with something that never happened.
    const first = filterButtonBatch(
      [{ id: 1, type: 'button_a', at: T0 }, { id: 2, type: 'button_b', at: T0 + 80 }],
      null, T0,
    );
    assert.deepEqual(first.clean.map(e => e.id), [1], 'the phantom B is dropped');
    assert.deepEqual(first.carry, { type: 'button_a', at: T0 },
      'and A, which was believed, is what carries forward');

    const second = filterButtonBatch(
      [{ id: 3, type: 'button_a', at: T0 + 200 }],
      first.carry, T0 + 200,
    );
    assert.deepEqual(second.clean.map(e => e.id), [3], 'the real second press survives');
    console.log('  ok');
  }

  console.log('--- 16. CROSSTALK STRADDLING TWO POLLS IS STILL CAUGHT ---');
  {
    const first = filterButtonBatch([{ id: 1, type: 'button_a', at: T0 }], null, T0);
    assert.deepEqual(first.clean.map(e => e.id), [1]);
    const second = filterButtonBatch(
      [{ id: 2, type: 'button_b', at: T0 + 90 }],
      first.carry, T0 + 90,
    );
    assert.deepEqual(second.clean.map(e => e.id), [], 'the phantom in the next batch is dropped too');
    assert.deepEqual(second.carry, first.carry, 'and it did not become the new reference');
    console.log('  ok');
  }

  console.log('--- 17. REAL PRESSES ARE NEVER EATEN ---');
  {
    // Two different buttons a comfortable distance apart are two real presses.
    const out = filterButtonBatch(
      [{ id: 1, type: 'button_a', at: T0 }, { id: 2, type: 'button_b', at: T0 + 900 }],
      null, T0,
    );
    assert.deepEqual(out.clean.map(e => e.id), [1, 2]);
    assert.deepEqual(out.carry, { type: 'button_b', at: T0 + 900 });

    // The same button twice quickly is a person pressing twice.
    const twice = filterButtonBatch(
      [{ id: 1, type: 'button_a', at: T0 }, { id: 2, type: 'button_a', at: T0 + 60 }],
      null, T0,
    );
    assert.deepEqual(twice.clean.map(e => e.id), [1, 2]);

    // Non-button events are never touched by any of this.
    const mixed = filterButtonBatch(
      [
        { id: 1, type: 'presence', at: T0 },
        { id: 2, type: 'button_a', at: T0 + 10 },
        { id: 3, type: 'button_b', at: T0 + 40 },
        { id: 4, type: 'manual_stop', at: T0 + 50 },
      ],
      null, T0,
    );
    assert.deepEqual(mixed.clean.map(e => e.id), [1, 2, 4], 'only the phantom went');
    console.log('  ok');
  }

  console.log('--- 18. BATCHES WITH NOTHING IN THEM ---');
  {
    const carry = { type: 'button_a', at: T0 };
    const empty = filterButtonBatch([], carry, T0 + 500);
    assert.deepEqual(empty.clean, []);
    assert.deepEqual(empty.carry, carry, 'an empty poll does not forget the last press');

    const noButtons = filterButtonBatch([{ id: 9, type: 'presence', at: T0 + 10 }], carry, T0 + 10);
    assert.deepEqual(noButtons.clean.map(e => e.id), [9]);
    assert.deepEqual(noButtons.carry, carry);

    // An event with no timestamp at all, which is what a board with an unset
    // clock sends. It must not be treated as having happened in 1970.
    const undated = filterButtonBatch([{ id: 5, type: 'button_a' }], null, T0 + 777);
    assert.deepEqual(undated.carry, { type: 'button_a', at: T0 + 777 });
    console.log('  ok');
  }

  console.log('--- 19. A STORM OF CROSSTALK NEVER LOSES EVERY PRESS ---');
  {
    // Ten deliberate presses of A, each inducing a phantom B, delivered in
    // batches of every size. Every real press must survive exactly once.
    for (const batchSize of [1, 2, 3, 4, 7]) {
      const all: Array<{ id: number; type: string; at: number }> = [];
      let id = 0;
      for (let i = 0; i < 10; i++) {
        const base = T0 + i * 1000;
        all.push({ id: ++id, type: 'button_a', at: base });
        all.push({ id: ++id, type: 'button_b', at: base + 80 });
      }
      let carry: { type: string; at: number } | null = null;
      const kept: string[] = [];
      for (let i = 0; i < all.length; i += batchSize) {
        const out = filterButtonBatch(all.slice(i, i + batchSize), carry, T0);
        carry = out.carry;
        kept.push(...out.clean.map(e => e.type));
      }
      assert.equal(kept.filter(t => t === 'button_a').length, 10,
        `batch size ${batchSize}: every real press survived`);
      assert.equal(kept.filter(t => t === 'button_b').length, 0,
        `batch size ${batchSize}: every phantom went`);
    }
    console.log('  ok');
  }

  console.log('--- 20. THE FILTER ITSELF, ON ITS OWN TERMS ---');
  {
    // `dropCrosstalkButtons` is what the batch helper is built on; a change to
    // one must not quietly change the other.
    const out = dropCrosstalkButtons([
      { type: 'button_a', at: 0 },
      { type: 'button_b', at: 10 },
      { type: 'button_b', at: 500 },
    ]);
    assert.deepEqual(out.map(e => e.at), [0, 500]);
    console.log('  ok');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // D. A whole working day, in one go
  // ═══════════════════════════════════════════════════════════════════════

  console.log('--- 21. A MORNING AT THE DESK ---');
  {
    const d = new Desk();
    let at = T0;

    // Arrive. 42cm is where this desk reads a seated person; 48 is the
    // threshold and 57 is the empty chair.
    at = d.hold(42, 6000, at, 100, 1);
    assert.equal(d.state.armingUntil !== null, true, 'armed on arrival');
    at += SETTINGS.armSeconds * 1000;
    d.tick(at);
    assert.equal(d.took('start'), true);
    assert.equal(d.session.isRunning, true);

    // Work for ten minutes, leaning about. The beam loses you now and then and
    // finds you again; none of it may reach the session.
    d.clear();
    for (let i = 0; i < 10; i++) {
      at = d.hold(45, 30_000, at, 100, 2);
      at = d.stream([90, 170, 400], at);     // a lean back, seen as a ramp
      at = d.hold(48, 20_000, at, 100, 1);
    }
    assert.deepEqual(d.actions, [], 'ten minutes of leaning about changed nothing');
    assert.equal(d.session.isRunning, true, 'and the session ran throughout');

    // Get up for coffee. Confirmed absence pauses it.
    at = d.stream([80, 160, 400], at);
    at = d.hold(null, 20_000, at);
    assert.equal(d.took('pause'), true, 'a real absence pauses');

    // Back inside the grace window: the desk resumes what it paused.
    d.clear();
    at = d.hold(46, 6000, at, 100, 1);
    assert.equal(d.took('resume'), true, 'and resumes when you sit back down');
    assert.equal(d.session.isRunning, true);
    console.log('  ok');
  }

  console.log('--- 22. AND AN AFTERNOON THAT ENDS BY WALKING OFF ---');
  {
    const d = new Desk();
    let at = T0;
    d.session = running;
    d.state = freshState({ present: true, sessionActive: true });

    at = d.hold(45, 6000, at, 100, 1);       // seated, already working
    at = d.stream([85, 160, 400], at);       // stand up
    at = d.hold(null, 20_000, at);
    assert.equal(d.took('pause'), true);

    // Gone for the rest of the afternoon. The terminate fires once, and only
    // once, however many times the empty desk is re-reported.
    d.clear();
    for (let t = 0; t <= SETTINGS.awayTerminateSeconds * 1000 + 60_000; t += 1500) {
      d.tick(at + t);
    }
    assert.equal(d.actions.filter(a => a === 'terminate').length, 1,
      `terminated exactly once, got ${JSON.stringify(d.actions)}`);
    assert.equal(d.state.pausedByAway, false, 'and left a clean slate behind it');
    assert.equal(d.state.awaySince, null);
    console.log('  ok');
  }

  console.log('--- 23. A MANUAL STOP IS NOT UNDONE BY THE NEXT PING ---');
  {
    const d = new Desk();
    d.session = running;
    d.state = freshState({ present: true, sessionActive: true });
    d.apply({ kind: 'manual_stop' }, T0);
    assert.equal(d.state.stoppedByHand, true);
    assert.equal(d.state.armingUntil, null);

    // Still sitting there. Every poll re-reports the same level, and not one of
    // them may arm anything.
    d.clear();
    d.session = idle;
    for (let i = 1; i <= 40; i++) d.apply({ kind: 'presence', present: true }, T0 + i * 1500);
    assert.equal(d.state.armingUntil, null, 'nothing was armed by a level it already knew');
    assert.deepEqual(d.actions, [], 'and nothing was started');
    assert.equal(d.state.stoppedByHand, true, 'the stop still stands');
    console.log('  ok');
  }

  console.log('--- 24. THE SENSOR SWITCHED OFF IS THE SENSOR SWITCHED OFF ---');
  {
    const off: HardwareSettings = { ...SETTINGS, sensorEnabled: false };
    const d = new Desk({}, off);
    let at = d.hold(45, 8000, T0, 100, 1);
    at = d.hold(null, 20_000, at);
    assert.deepEqual(d.actions, [], 'a full arrive-and-leave did nothing at all');
    assert.equal(d.state.armingUntil, null);
    assert.equal(d.state.awaySince, null);
    console.log('  ok');
  }

  console.log('\nAll deskRealism tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
