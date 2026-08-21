// Exercises the real presence filter (sensorFilter.ts) -- not a reimplementation
// of it -- against the ways this particular desk's sensor actually misbehaves.
//
// The cases that matter are not "does a threshold work". They are the ones
// where the sensor produces numbers that are individually plausible and
// collectively a lie:
//
//   - a foot against half the transducer, which walks the reading up through
//     80 and 120 before timing out at 400. Every intermediate value looks like
//     an ordinary empty chair, and the last one before the timeout is the one
//     a "hold the last good reading" scheme would latch. That is the bug this
//     filter exists to kill.
//   - bursts of maximum-range readings for no reason, which are identical to
//     an empty desk with nothing in the beam.
//   - a hand right against the module, which rings and returns nonsense.
//
// Run with:  npx tsx src/lib/sensorFilter.test.ts

import { DEFAULT_SENSOR_FILTER_CONFIG, PresenceFilter, type SensorFilterConfig } from './sensorFilter';

const CFG = DEFAULT_SENSOR_FILTER_CONFIG;
const DT = 100;  // ping interval used throughout, matching the shipped default

/** Drives a filter on a synthetic clock, so tests run instantly and exactly. */
class Rig {
  readonly filter: PresenceFilter;
  t = 0;
  /** Every presence flip the filter announced, in order. */
  flips: Array<{ at: number; present: boolean }> = [];

  constructor(cfg?: Partial<SensorFilterConfig>) {
    this.filter = new PresenceFilter(cfg);
  }

  /** One ping. `null`/0 is an echo timeout. */
  feed(cm: number | null) {
    this.t += DT;
    const snap = this.filter.push(cm, this.t);
    if (snap.changed) this.flips.push({ at: this.t, present: snap.present });
    return snap;
  }

  /** Holds one value for a number of seconds. */
  hold(cm: number | null, seconds: number) {
    const n = Math.round((seconds * 1000) / DT);
    for (let i = 0; i < n; i++) this.feed(cm);
    return this.filter.snapshot;
  }

  /** Feeds an explicit sequence once. */
  seq(values: Array<number | null>) {
    for (const v of values) this.feed(v);
    return this.filter.snapshot;
  }

  /** Seated and confirmed, which nearly every case starts from. */
  seat() {
    this.hold(32, 5);
    return this;
  }

  get present() { return this.filter.snapshot.present; }
  get believed() { return this.filter.snapshot.distanceCm; }
}

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`);
};

console.log(`at desk <${CFG.enterCm}cm, away >${CFG.exitCm}cm, implausible >${CFG.maxValidCm}cm`);
console.log(`arrive ${CFG.presentConfirmMs}ms, leave ${CFG.absentConfirmMs}ms, over-range ${CFG.glitchHoldMs}ms\n`);

// ---------------------------------------------------------------------------
// The everyday cases still have to work
// ---------------------------------------------------------------------------

{
  const r = new Rig();
  r.hold(32, 5);
  check('sitting down is detected', r.present, `believed=${r.believed}`);
  check('and the believed distance is what the sensor sees', r.believed === 32, `believed=${r.believed}`);
}

{
  const r = new Rig().seat();
  r.hold(58, 7);
  check('getting up, chair at 58cm, reads as away', !r.present, `believed=${r.believed}`);
  r.hold(32, 4);
  check('and sitting back down is detected again', r.present);
}

{
  // The dwell times must actually be dwelt, not merely eventually satisfied.
  //
  // The clock does not start the instant you stand up: it starts once the last
  // close reading has aged out of the analysis window, because a close reading
  // anywhere in it means the sensor can still see somebody. So leaving costs
  // the window plus the confirm time -- 6.5s on the shipped defaults -- and
  // that extra second and a half is simply credited to the session.
  const r = new Rig().seat();
  r.hold(58, 5);
  check('leaving is not believed before the confirm time', r.present, `believed=${r.believed}`);
  r.hold(58, 3);
  check('but is believed a window later', !r.present);
  const leftAt = r.flips[r.flips.length - 1].at;
  const expected = 5000 + CFG.clusterWindowMs + CFG.absentConfirmMs;
  check('and lands within a ping of window + confirm time', Math.abs(leftAt - expected) <= 2 * DT,
    `left at ${leftAt}, expected ~${expected}`);
}

{
  // Shifting in your seat crosses the band constantly; it must not flip.
  const r = new Rig().seat();
  for (let i = 0; i < 40; i++) r.feed(i % 2 ? 44 : 50);
  check('fidgeting across the hysteresis band never flips the state', r.present, `flips=${r.flips.length}`);
}

// ---------------------------------------------------------------------------
// The 80 cm problem: a partly blocked transducer
// ---------------------------------------------------------------------------

{
  // The exact reported failure. Seated at 30, a foot fouls the sensor, the
  // reading climbs 80 -> 120 -> 400 and stays there. The old filter latched 80
  // (the last reading under its "implausible" line) and declared the desk
  // empty within a second.
  const r = new Rig().seat();
  r.seq([80, 120, 400]);
  check('the 80/120 ramp does not evict you', r.present, `believed=${r.believed}`);
  check('and 80cm is never adopted as the believed distance', r.believed !== 80, `believed=${r.believed}`);

  r.hold(400, 2);
  check('two seconds of timeouts still does not evict you', r.present, `believed=${r.believed}`);

  r.seq([30]);
  r.hold(30, 2);
  check('moving the foot away restores the real distance', r.present && r.believed === 30, `believed=${r.believed}`);
}

{
  // The ramp intermediates must be invisible to the statistics, not merely
  // outvoted -- otherwise a slower ramp would still land on one of them.
  const r = new Rig().seat();
  const snap = r.seq([70, 110, 150, 190]);
  check('a long ramp is masked out rather than believed',
    snap.masked || (snap.distanceCm !== null && snap.distanceCm < CFG.enterCm),
    `believed=${snap.distanceCm} masked=${snap.masked}`);
  check('and you are still at the desk throughout it', r.present);
}

{
  // The intermittent version, which is what a shifting foot really looks like:
  // it never settles anywhere long enough to be anything.
  const r = new Rig().seat();
  for (let i = 0; i < 20; i++) {
    r.hold(400, 0.8);
    r.hold(31, 0.4);
  }
  check('a foot fouling the sensor on and off never evicts you', r.present, `flips=${JSON.stringify(r.flips)}`);
}

{
  // ... and the same with the ramp included on every cycle, which is the shape
  // the user actually described.
  const r = new Rig().seat();
  for (let i = 0; i < 15; i++) {
    r.seq([80, 130, 400]);
    r.hold(400, 0.6);
    r.hold(30, 0.5);
  }
  check('repeated 30-80-400-30 cycles never evict you', r.present, `flips=${JSON.stringify(r.flips)}`);
}

// ---------------------------------------------------------------------------
// Over-range readings are the weakest evidence there is
// ---------------------------------------------------------------------------

{
  const r = new Rig().seat();
  r.hold(400, 8);
  check('8s of timeouts is under the over-range hold, so you stay', r.present, `believed=${r.believed}`);
}

{
  // It cannot be ignored forever: a truly blocked or truly empty beam reads
  // this way too, and refusing it would mean never noticing anything.
  const r = new Rig().seat();
  r.hold(400, 14);
  check('sustained timeouts eventually do count as away', !r.present, `believed=${r.believed}`);
}

{
  const r = new Rig({ glitchIgnoreAlways: true }).seat();
  r.hold(400, 60);
  check('with "never counts as away" on, timeouts never evict you', r.present, `believed=${r.believed}`);
  r.hold(58, 7);
  check('but the empty chair still does', !r.present, `believed=${r.believed}`);
}

{
  // A single near reading is proof you are there, and has to restart the clock
  // from scratch rather than merely pause it.
  const r = new Rig().seat();
  for (let i = 0; i < 10; i++) {
    r.hold(400, 8);
    r.feed(31);
  }
  check('one close reading resets the over-range clock every time', r.present, `flips=${JSON.stringify(r.flips)}`);
}

// ---------------------------------------------------------------------------
// A hand right against the module
// ---------------------------------------------------------------------------

{
  const r = new Rig().seat();
  r.seq([1, 2, 0.5, 3, 1]);
  check('ringing below the minimum valid distance is discarded', r.present, `believed=${r.believed}`);
  check('and does not become the believed distance', (r.believed ?? 0) >= CFG.minValidCm, `believed=${r.believed}`);
}

{
  // A hand hovering close while you are away is a person at the desk. Believing
  // that is the safe direction, and it must not be masked as a ramp.
  const r = new Rig();
  r.hold(58, 7);
  check('away to start with', !r.present);
  r.hold(12, 4);
  check('something arriving very close is read as being at the desk', r.present, `believed=${r.believed}`);
}

// ---------------------------------------------------------------------------
// The sensor itself failing
// ---------------------------------------------------------------------------

{
  // A disconnected module times out forever, exactly like an empty desk. It
  // must never be able to pause a session, since it has never proved it works.
  const r = new Rig();
  r.hold(null, 60);
  const snap = r.filter.snapshot;
  check('a sensor that never echoes decides nothing', !snap.ready && r.flips.length === 0,
    `ready=${snap.ready} flips=${r.flips.length}`);
}

{
  // A signal that is far and permanently incoherent -- no near readings at all
  // -- is a broken sensor, not a session worth defending. The escape hatch has
  // to fire, or a fault would hold a session open indefinitely.
  const r = new Rig({ chaosMaxMs: 20000 }).seat();
  for (let i = 0; i < 400; i++) r.feed([60, 400, 130, 400, 90, 300][i % 6]);
  check('permanently incoherent far readings eventually give up and call it away',
    !r.present, `believed=${r.believed}`);
}

{
  // ... but never while near readings keep arriving, however long it goes on.
  const r = new Rig({ chaosMaxMs: 20000 }).seat();
  for (let i = 0; i < 400; i++) r.feed([60, 400, 31, 400, 90, 300][i % 6]);
  check('the escape hatch never fires while close readings keep arriving',
    r.present, `flips=${JSON.stringify(r.flips)}`);
}

// ---------------------------------------------------------------------------
// Stream handling
// ---------------------------------------------------------------------------

{
  // A gap means the board or the link went away. The window must not be joined
  // across it, or a spread would be computed between two unrelated moments.
  const r = new Rig().seat();
  r.t += 30000;                      // board offline for half a minute
  const snap = r.hold(31, 3);
  check('a long gap in the stream does not fabricate a huge spread',
    snap.spreadCm < CFG.chaosSpreadCm, `spread=${snap.spreadCm}`);
  check('and you are still at the desk after it', r.present);
}

{
  // Server restarted mid-session: the first coherent window establishes where
  // things stand with no dwell, or the desk would read as empty while you sit
  // at it.
  const r = new Rig();
  const snap = r.hold(33, 1);
  check('a fresh filter adopts the current state immediately', snap.present && snap.ready,
    `present=${snap.present} ready=${snap.ready}`);
}

{
  // Retuning must not leave a half-elapsed timer counting against a rule that
  // no longer exists.
  const r = new Rig().seat();
  r.hold(58, 3);
  r.filter.configure({ absentConfirmMs: 5000 });
  r.hold(58, 3);
  check('changing the tuning restarts the dwell rather than banking it', r.present,
    `believed=${r.believed}`);
  r.hold(58, 3);
  check('and the new dwell then completes normally', !r.present);
}

// ---------------------------------------------------------------------------
// Diagnostics are what makes a wrong verdict debuggable at all
// ---------------------------------------------------------------------------

{
  const r = new Rig().seat();
  r.hold(400, 3);
  const snap = r.filter.snapshot;
  check('a withheld departure says why it is being withheld', snap.holding !== null || snap.awayProgressMs > 0,
    `holding=${snap.holding} progress=${snap.awayProgressMs}`);
}

// ---------------------------------------------------------------------------
// Advanced Acoustic & Physical Simulations
// ---------------------------------------------------------------------------

console.log('\n--- ADVANCED ULTRASONIC ACOUSTIC SIMULATIONS ---');

{
  // Simulation: Realistic Seated Session with Normal Fidgeting & Acoustic Noise (10-minute simulation)
  // Distance fluctuates normally around 33cm with Gaussian noise +/- 2cm,
  // occasional shifts to 42cm (leaning back) or 28cm (leaning in), and 1% chance of acoustic deflection.
  const r = new Rig().seat();
  let spuriousAwayFlips = 0;
  // Seeded pseudo-random generator for 100% deterministic simulation runs
  let seed = 42;
  const pseudoRand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  // 10 minutes = 6,000 pings at 100ms
  for (let i = 0; i < 6000; i++) {
    const posture = (i % 1200 < 600) ? 33 : (i % 1200 < 900 ? 40 : 29);
    const noise = (pseudoRand() - 0.5) * 4; // +/- 2cm noise
    let sample: number | null = posture + noise;

    // 1% chance of acoustic dropout/timeout (HC-SR04 sound wave deflection on angled clothing)
    if (pseudoRand() < 0.01) {
      sample = 400;
    }

    const snap = r.feed(sample);
    if (snap.changed && !snap.present) {
      spuriousAwayFlips++;
    }
  }

  check('10-minute simulated seated session with posture shifts and acoustic noise NEVER evicts you',
    r.present && spuriousAwayFlips === 0, `spuriousAwayFlips=${spuriousAwayFlips}`);
}

{
  // Simulation: Rapid Pacing & In-and-Out of Desk Area
  // Person walks in (stays 3s), walks away (stays 4s), walks back (stays 15s)
  const r = new Rig();
  r.hold(58, 6); // start away (empty chair)
  check('initially away', !r.present);

  // In for 3s (confirm is 2s -> becomes present)
  r.hold(32, 3);
  check('detected arrival within 3s', r.present);

  // Out for 4s (confirm is 5s + window 1.5s -> stays present because away requires 6.5s)
  r.hold(58, 4);
  check('brief 4s step away does not drop session', r.present);

  // Back in and stays 10s
  r.hold(32, 10);
  check('still present after returning', r.present);

  // Leaves permanently (10s > 6.5s)
  r.hold(58, 10);
  check('confirmed away after 10s departure', !r.present);
}

{
  // Simulation: Multi-target competition (dominant cluster vs secondary reflection)
  // 60% of samples see knees at 32cm, 40% see room reflection at 90cm
  const r = new Rig().seat();
  let seed = 12345;
  const pseudoRand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < 100; i++) {
    const isTarget = pseudoRand() < 0.65;
    r.feed(isTarget ? 32 + (pseudoRand() - 0.5) * 2 : 90 + (pseudoRand() - 0.5) * 5);
  }

  check('dominant near cluster wins against secondary far reflections',
    r.present && (r.believed ?? 0) < CFG.enterCm, `believed=${r.believed}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;

