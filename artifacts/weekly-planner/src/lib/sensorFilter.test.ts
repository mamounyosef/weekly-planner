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

import { DEFAULT_SENSOR_FILTER_CONFIG, PresenceFilter, coerceSensorFilterConfig, type SensorFilterConfig } from './sensorFilter';

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

// ---------------------------------------------------------------------------
// LAYER A — EXHAUSTIVE SCENARIO TEST MATRIX (ITEMS 1 - 15)
// ---------------------------------------------------------------------------

console.log('\n--- LAYER A: EXHAUSTIVE SCENARIO MATRIX ---');

// --- A.1: coerceSensorFilterConfig total surface ---
{
  // Null and non-object inputs fall back to defaults
  check('coerce(null) returns defaults',
    JSON.stringify(coerceSensorFilterConfig(null)) === JSON.stringify(DEFAULT_SENSOR_FILTER_CONFIG));
  check('coerce(undefined) returns defaults',
    JSON.stringify(coerceSensorFilterConfig(undefined)) === JSON.stringify(DEFAULT_SENSOR_FILTER_CONFIG));

  // Clamping of every numeric knob against NaN, negative, huge, string
  const pathological = {
    enterCm: 'NaN',
    exitCm: -10,
    maxValidCm: 999999,
    minValidCm: 'string',
    presentConfirmMs: -50,
    absentConfirmMs: Infinity,
    glitchHoldMs: -1,
    clusterWindowMs: 0,
    clusterTolCm: 500,
    minClusterSupport: 2.5,
    chaosSpreadCm: -10,
    chaosMaxMs: -5,
    rampStepCm: -20,
    rampMinSteps: 100,
    rampMaskMs: 999999,
    streamGapMs: 10,
    glitchIgnoreAlways: true,
    extraUnknownKey: 42,
  };
  const coerced = coerceSensorFilterConfig(pathological as unknown as Partial<SensorFilterConfig>);
  check('enterCm NaN falls back to default', coerced.enterCm === DEFAULT_SENSOR_FILTER_CONFIG.enterCm);
  check('exitCm negative is repaired above enterCm', coerced.exitCm > coerced.enterCm);
  check('maxValidCm huge clamps to 400', coerced.maxValidCm === 400);
  check('minValidCm non-number falls back and stays < enterCm', coerced.minValidCm < coerced.enterCm);
  check('presentConfirmMs negative clamps to 0', coerced.presentConfirmMs === 0);
  check('absentConfirmMs Infinity falls back to default', coerced.absentConfirmMs === DEFAULT_SENSOR_FILTER_CONFIG.absentConfirmMs);
  check('glitchHoldMs negative clamps to 0', coerced.glitchHoldMs === 0);
  check('clusterWindowMs below floor clamps to 200', coerced.clusterWindowMs === 200);
  check('clusterTolCm above ceiling clamps to 100', coerced.clusterTolCm === 100);
  check('minClusterSupport above 1.0 clamps to 1.0', coerced.minClusterSupport === 1.0);
  check('chaosSpreadCm negative clamps to 5', coerced.chaosSpreadCm === 5);
  check('chaosMaxMs negative clamps to 0', coerced.chaosMaxMs === 0);
  check('rampStepCm negative clamps to 2', coerced.rampStepCm === 2);
  check('rampMinSteps above 10 clamps to 10', coerced.rampMinSteps === 10);
  check('rampMaskMs above 20000 clamps to 20000', coerced.rampMaskMs === 20000);
  check('streamGapMs below 500 clamps to 500', coerced.streamGapMs === 500);
  check('glitchIgnoreAlways boolean preserved', coerced.glitchIgnoreAlways === true);
  check('unknown extra keys ignored', (coerced as Record<string, unknown>).extraUnknownKey === undefined);
}

// --- A.2: Threshold coherence rules & idempotence ---
{
  // Inverted hysteresis: enterCm >= exitCm
  const inverted = coerceSensorFilterConfig({ enterCm: 60, exitCm: 40 });
  check('inverted hysteresis is repaired (exitCm > enterCm)',
    inverted.exitCm > inverted.enterCm && inverted.exitCm === inverted.enterCm + 4);

  // maxValidCm <= exitCm
  const badMax = coerceSensorFilterConfig({ enterCm: 40, exitCm: 50, maxValidCm: 45 });
  check('maxValidCm below exitCm is repaired (maxValidCm > exitCm)',
    badMax.maxValidCm > badMax.exitCm && badMax.maxValidCm === badMax.exitCm + 4);

  // minValidCm >= enterCm
  const badMin = coerceSensorFilterConfig({ enterCm: 10, minValidCm: 15 });
  check('minValidCm >= enterCm is repaired (minValidCm < enterCm)',
    badMin.minValidCm < badMin.enterCm && badMin.minValidCm === 9);

  // Idempotence: coerce(coerce(x)) === coerce(x)
  const testInputs: Array<Partial<SensorFilterConfig>> = [
    {},
    { enterCm: 100, exitCm: 80, maxValidCm: 70, minValidCm: 90 },
    { enterCm: 2, exitCm: 2, maxValidCm: 20 },
    { enterCm: 400, exitCm: 400, maxValidCm: 400 },
    { enterCm: 350, exitCm: 360, maxValidCm: 370 },
  ];
  let allIdempotent = true;
  for (const inp of testInputs) {
    const c1 = coerceSensorFilterConfig(inp);
    const c2 = coerceSensorFilterConfig(c1);
    if (JSON.stringify(c1) !== JSON.stringify(c2)) {
      allIdempotent = false;
    }
  }
  check('coerce(coerce(x)) === coerce(x) holds across all pathological configs (idempotent)', allIdempotent);
}

// --- A.3: Hysteresis band exact boundaries & internal oscillations ---
{
  // Seated filter parked exactly at enterCm (48cm) and exitCm (52cm)
  const rPresent = new Rig().seat();
  for (let i = 0; i < 20; i++) rPresent.feed(48); // exactly enterCm
  check('parked exactly at enterCm while present stays present', rPresent.present);

  for (let i = 0; i < 20; i++) rPresent.feed(52); // exactly exitCm
  check('parked exactly at exitCm while present stays present (hysteresis upper bound)', rPresent.present);

  // Oscillating inside the hysteresis band from the present side
  const flipsBefore = rPresent.flips.length;
  for (let i = 0; i < 50; i++) rPresent.feed(i % 2 ? 49 : 51);
  check('oscillating inside hysteresis band while present never flips',
    rPresent.present && rPresent.flips.length === flipsBefore);

  // Absent filter parked inside band
  const rAbsent = new Rig();
  rAbsent.hold(58, 6); // confirmed absent
  check('absent initially', !rAbsent.present);

  const absentFlipsBefore = rAbsent.flips.length;
  for (let i = 0; i < 30; i++) rAbsent.feed(50); // inside band (48..52)
  check('parked inside band while absent stays absent',
    !rAbsent.present && rAbsent.flips.length === absentFlipsBefore);

  for (let i = 0; i < 50; i++) rAbsent.feed(i % 2 ? 49 : 51);
  check('oscillating inside band while absent never flips to present',
    !rAbsent.present && rAbsent.flips.length === absentFlipsBefore);
}

// --- A.4: presentConfirmMs / absentConfirmMs exact boundaries ---
{
  // Arrival: presentConfirmMs is 2000ms.
  // Rig feeds at DT = 100ms.
  const r = new Rig();
  r.hold(58, 6); // start absent
  check('arrival test starts absent', !r.present);

  // Feed near samples (32cm) until arriveSince starts tracking
  // Old 58cm readings age out of the 1500ms window, then arriveSince begins counting.
  let snap = r.feed(32);
  while (snap.arriveProgressMs === 0) {
    snap = r.feed(32);
  }
  // Now arriveProgressMs is counting. Feed until exactly one sample before presentConfirmMs (1900ms)
  while (snap.arriveProgressMs < CFG.presentConfirmMs - DT) {
    snap = r.feed(32);
  }
  check('1 sample before presentConfirmMs (1900ms) is still absent', !r.present);

  // Next ping lands at exactly presentConfirmMs (2000ms)
  snap = r.feed(32);
  check('at presentConfirmMs (2000ms) arrival fires', r.present && snap.present);
}
{
  // Departure: absentConfirmMs is 5000ms. Analysis window is 1500ms.
  // Full departure needs window (1500ms) + absentConfirmMs (5000ms) = 6500ms.
  const r = new Rig().seat();
  // 64 pings at 100ms = 6400ms (< 6500ms)
  for (let i = 0; i < 64; i++) r.feed(58);
  check('1 sample before confirm window (6400ms) is still present', r.present);

  // 65th and 66th pings land at >= 6500ms
  r.feed(58);
  r.feed(58);
  check('at and past confirm window departure fires', !r.present);
}

// --- A.5: Over-range handling and glitchIgnoreAlways ---
{
  // Burst shorter than glitchHoldMs (10s)
  const r = new Rig().seat();
  r.hold(400, 9); // 9s < 10s
  check('burst of over-range pings shorter than glitchHoldMs never causes departure', r.present);

  // Burst longer than glitchHoldMs (10s) with glitchIgnoreAlways: false
  r.hold(400, 6); // 9s + 6s = 15s > 11.5s
  check('sustained over-range pings past glitchHoldMs cause departure', !r.present);
}
{
  // glitchIgnoreAlways: true -> never departs on over-range
  const r = new Rig({ glitchIgnoreAlways: true }).seat();
  r.hold(400, 30); // 30 seconds of timeouts
  check('with glitchIgnoreAlways: true, over-range timeouts never evict even after 30s', r.present);

  // But a valid chair distance (58cm <= maxValidCm 100cm) still does
  r.hold(58, 8);
  check('credible empty chair reading (58cm) still causes departure', !r.present);
}

// --- A.6: Clustering & dominantCluster edge cases ---
{
  // Bimodal window: half 35cm, half 70cm
  const r = new Rig().seat();
  // Alternate 35 and 70: no dominant cluster has support >= 0.5
  for (let i = 0; i < 20; i++) {
    r.feed(i % 2 ? 35 : 70);
  }
  check('bimodal window with no dominant consensus preserves current decision', r.present);

  // clusterTolCm boundary: exactly clusterTolCm (12cm) apart form one cluster
  const rTol = new Rig();
  rTol.hold(58, 6); // absent
  // Feed pairs at 30 and 42 (diff exactly 12cm = clusterTolCm)
  for (let i = 0; i < 30; i++) {
    rTol.feed(i % 2 ? 30 : 42);
  }
  check('two readings exactly clusterTolCm apart form a single cluster and detect presence',
    rTol.present && (rTol.believed === 30 || rTol.believed === 42));
}

// --- A.7: Chaos escape hatch ---
{
  // Incoherent far signal with chaosMaxMs: 15000
  const r = new Rig({ chaosMaxMs: 15000 }).seat();
  // Feed wide-spread readings (spread > 40cm) between 60cm and 350cm
  for (let i = 0; i < 200; i++) {
    r.feed([60, 200, 90, 350, 80, 280][i % 6]);
  }
  check('chaotic far signal triggers escape hatch and marks away after chaosMaxMs', !r.present);
}
{
  // chaosMaxMs: 0 disables the escape hatch completely
  const rNoHatch = new Rig({ chaosMaxMs: 0 }).seat();
  for (let i = 0; i < 400; i++) {
    rNoHatch.feed([60, 200, 90, 350, 80, 280][i % 6]);
  }
  check('chaosMaxMs: 0 disables escape hatch completely (stays present under chaotic signal)', rNoHatch.present);
}

// --- A.8: Ramp masking edge cases ---
{
  // rampMinSteps - 1 (2 jumps of +15cm) is not a ramp
  const r = new Rig().seat();
  const snap2Steps = r.seq([30, 46, 62]); // 2 steps of +16cm
  check('2 steps (< rampMinSteps 3) does not activate ramp masking', !snap2Steps.masked);

  // 3 jumps of +15cm activates ramp masking
  const snap3Steps = r.seq([30, 46, 62, 78]); // 3 steps
  check('3 steps (>= rampMinSteps 3) activates ramp masking', snap3Steps.masked);

  // Downward ramp: approaching target (e.g. 150 -> 100 -> 50 -> 30) is NOT masked
  const rDown = new Rig();
  rDown.hold(58, 6); // start absent
  const snapDown = rDown.seq([150, 100, 50, 30]);
  check('downward ramp (approaching target) is never masked', !snapDown.masked);

  // Specific documented failure: 40 -> 80 -> 120 -> 400 does not evict seated user
  const rFoot = new Rig().seat();
  rFoot.seq([40, 80, 120, 400]);
  rFoot.hold(400, 3);
  check('foot against transducer (40 -> 80 -> 120 -> 400) does not evict seated user', rFoot.present);
}

// --- A.9: Stream gaps & board reboot ---
{
  const r = new Rig().seat();
  // Gap > streamGapMs (3000ms)
  r.t += 5000;
  const snapGap = r.feed(32);
  check('stream gap > streamGapMs resets window count cleanly', snapGap.windowCount === 1);
  check('and user remains present after gap resumes', r.present);

  // Gap < streamGapMs (1000ms)
  r.feed(32);
  r.feed(32);
  const countBefore = r.filter.snapshot.windowCount;
  r.t += 1000; // 1s < 3s
  const snapSmallGap = r.feed(32);
  check('stream gap < streamGapMs does not reset rolling window', snapSmallGap.windowCount > 1);

  // Board reboot mid-arrival: 1s arrival, reboot (5s gap), resumes
  const rReboot = new Rig();
  rReboot.hold(58, 6); // absent
  rReboot.hold(32, 1); // 1s of arrival (needs 2s)
  check('mid-arrival not yet present', !rReboot.present);
  rReboot.t += 5000; // reboot gap
  rReboot.hold(32, 1.5); // 1.5s after reboot (< 2s needed from scratch)
  check('arrival timer restarted cleanly after reboot gap', !rReboot.present);
  rReboot.hold(32, 1); // now reaches 2.5s total post-reboot
  check('arrival completes after full post-reboot dwell', rReboot.present);
}

// --- A.10: ready and everEchoed preconditions ---
{
  const rFresh = new Rig();
  check('fresh filter with no pings has ready=false and everEchoed=false',
    !rFresh.filter.snapshot.ready && !rFresh.filter.snapshot.everEchoed);

  // Disconnected sensor: only timeouts (null / 0) for 100 pings
  rFresh.hold(null, 10);
  check('disconnected sensor (timeouts only) never sets everEchoed or ready',
    !rFresh.filter.snapshot.everEchoed && !rFresh.filter.snapshot.ready && rFresh.flips.length === 0);

  // Valid echo establishes everEchoed immediately on first valid echo
  const snap1 = rFresh.feed(35);
  check('first valid echo sets everEchoed', snap1.everEchoed);

  // Holding valid echo allows old timeouts to age out of the window and establish ready + present
  rFresh.hold(35, 2);
  check('valid echo stream clears timeouts and establishes ready and present',
    rFresh.filter.snapshot.everEchoed && rFresh.filter.snapshot.ready && rFresh.present);
}

// --- A.11: Degenerate inputs ---
{
  const r = new Rig().seat();
  const degenerateVals = [null, 0, -1, -50, NaN, Infinity, -Infinity, 1e12];
  let survived = true;
  for (const v of degenerateVals) {
    try {
      r.feed(v as number);
    } catch (_) {
      survived = false;
    }
  }
  check('all degenerate inputs (null, 0, negative, NaN, Infinity) handled without throwing', survived);
  check('still seated after transient degenerate input sequence', r.present);
}

// --- A.12: Clock abuse ---
{
  const r = new Rig().seat();
  // Duplicate timestamps
  r.filter.push(32, r.t);
  r.filter.push(32, r.t);
  check('duplicate timestamps handled safely', r.present);

  // Timestamp going backwards
  r.filter.push(32, r.t - 5000);
  check('clock rewind resets window safely without crashing', r.present);

  // Huge jump forward (e.g. 8 hours)
  r.filter.push(32, r.t + 8 * 3600 * 1000);
  r.t += 8 * 3600 * 1000;
  check('multi-hour clock jump handled safely as stream gap', r.present);
}

// --- A.13: changed flag semantics ---
{
  const f = new PresenceFilter();
  // First sample of fresh filter
  const s1 = f.push(32, 1000);
  check('changed is false on the very first sample of a fresh filter', s1.changed === false);

  // Second sample initializes presence
  const s2 = f.push(32, 1100);
  check('changed is true on the sample where presence first becomes confirmed', s2.changed === true && s2.present === true);

  // Third sample continues present
  const s3 = f.push(32, 1200);
  check('changed is false on following sample with steady state', s3.changed === false && s3.present === true);
}

// --- A.14: 10,000-sample seated soak test ---
{
  const r = new Rig().seat();
  let maxWindowCount = 0;
  let allPresent = true;
  for (let i = 0; i < 10000; i++) {
    const snap = r.feed(32 + (i % 5) - 2);
    if (snap.windowCount > maxWindowCount) maxWindowCount = snap.windowCount;
    if (!snap.present) allPresent = false;
  }
  const maxExpectedWindow = Math.ceil(CFG.clusterWindowMs / DT) + 5;
  check('10,000-sample seated soak test: window count never grows without bound',
    maxWindowCount <= maxExpectedWindow, `maxWindowCount=${maxWindowCount} expected<=${maxExpectedWindow}`);
  check('10,000-sample seated soak test: verdict stays 100% stable present', allPresent);
}

// --- A.15: Determinism across parallel instances ---
{
  const f1 = new PresenceFilter();
  const f2 = new PresenceFilter();
  const testPings = [30, 32, 31, 400, null, 35, 58, 60, 48, 52, 33, 400, 400, 31];
  let identical = true;
  let t = 1000;
  for (const p of testPings) {
    t += 100;
    const snap1 = f1.push(p, t);
    const snap2 = f2.push(p, t);
    if (JSON.stringify(snap1) !== JSON.stringify(snap2)) {
      identical = false;
      break;
    }
  }
  check('two filters fed identical sequence produce identical snapshots field-for-field (deterministic)', identical);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;


