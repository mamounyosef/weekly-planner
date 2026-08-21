// ---------------------------------------------------------------------------
// Presence filter.
//
// The ESP32 no longer decides anything about presence: it pings the ultrasonic
// module and posts the raw centimetres. Everything that turns that stream into
// "you are at the desk" / "you left" happens here, on the PC, where it can be
// as involved as it needs to be and can be unit-tested without a board.
//
// Why this is harder than a threshold and a timer
// -----------------------------------------------
// An HC-SR04 does not fail by returning noise around the truth. It fails by
// returning *plausible numbers that are not the truth*, and the worst case on
// this desk is a partially blocked transducer -- a foot resting against one
// half of it, an arm across the beam. The echo path lengthens progressively
// instead of vanishing, so a seated 30 cm walks up through 80 and 120 before
// finally timing out at 400. Every one of those intermediate values is inside
// the range a real empty chair could produce.
//
// The previous design held "the last valid reading" whenever it discarded an
// over-range one. That is exactly the wrong thing to hold: the last value
// before the timeout is the *most* corrupted one in the whole run (80 cm, in
// the example above), and latching it declares the desk empty while its owner
// is sitting right there. This filter never substitutes a held distance. It
// holds a *decision* and re-derives the distance from scratch every sample.
//
// The four ideas it is built on
// -----------------------------
// 1. NEAR readings are trustworthy, FAR readings are not. A sensor with
//    nothing in front of it does not invent an echo at 30 cm -- that would
//    need a reflector which is not there. The reverse is routine: bodies
//    absorb, angled surfaces deflect, and a blocked transducer times out. So a
//    near reading is treated as proof of presence, while a far reading is only
//    ever a hypothesis that has to survive a dwell time to be believed.
//
// 2. Decide from the dominant cluster, not from the median. A median flips the
//    moment corrupt samples take a bare majority of the window. The largest
//    tight cluster keeps describing the real target for as long as the real
//    target is the most self-consistent thing in the window, and it reports
//    how much of the window agreed with it, which a median cannot.
//
// 3. A recession no body can perform is an artifact, not a departure. Three
//    consecutive jumps of 15 cm or more is a target receding at metres per
//    second. That is a beam losing its reflector, so the samples spanning the
//    jump are masked out until the signal settles again -- only where it
//    settles is allowed to mean anything. A real departure settles within a
//    second (on the empty chair), so it costs nothing there; the 30-80-120-400
//    ramp has its 80 and 120 removed from the evidence entirely.
//
// 4. Absence has two tiers. Landing on a credible empty-desk distance (past
//    the away threshold but still inside the range this desk can physically
//    produce -- the chair) is believed after the normal dwell. Going
//    over-range is the failure mode the module is known for, so it has to hold
//    far longer before it counts, and it can be told to never count at all.
//
// Pure and dependency-free on purpose: the dev server imports it (see
// vite.config.ts) and so does the test, so it must not pull in React.
// ---------------------------------------------------------------------------

/** How a single reading is read, once thresholds are applied. */
export type SampleKind =
  /** Physically impossible -- ringing, a cable fault. Excluded outright. */
  | 'invalid'
  /** Close enough to be a person. Strong evidence. */
  | 'near'
  /** Between the two thresholds: could be either. Holds whatever we decided. */
  | 'band'
  /** Past the away threshold but still a distance this desk can produce. */
  | 'far'
  /** Beyond anything plausible here, including echo timeouts. Weak evidence. */
  | 'over';

export interface SensorFilterConfig {
  /** Absent -> present once the dominant cluster sits below this (cm). */
  enterCm: number;
  /** Present -> absent once it rises above this (cm). The gap to enterCm is
   *  the hysteresis band, inside which the current decision simply stands. */
  exitCm: number;
  /** The furthest reading this desk can physically produce. Past it, a reading
   *  is the module misfiring far more often than it is the truth. */
  maxValidCm: number;
  /** Below this an echo is not a measurement at all (transducer ringing). */
  minValidCm: number;
  /** How long a near cluster must hold before arriving is believed (ms). */
  presentConfirmMs: number;
  /** How long a credible far cluster must hold before leaving is (ms). */
  absentConfirmMs: number;
  /** How long an *over-range* cluster must hold before leaving is believed
   *  (ms). Longer than absentConfirmMs, because this is the module's known
   *  failure mode rather than a distance anything here can produce. */
  glitchHoldMs: number;
  /** Over-range readings may never, on their own, prove absence. Correct
   *  whenever the empty state of the desk reads inside maxValidCm (an empty
   *  chair does), because then a timeout is always a fault and never a fact. */
  glitchIgnoreAlways: boolean;
  /** Width of the rolling window every statistic is computed over (ms). */
  clusterWindowMs: number;
  /** Two readings within this many cm are describing the same thing. */
  clusterTolCm: number;
  /** Fraction of the window the dominant cluster must hold (0-1) before it is
   *  allowed to change the decision. Below it, the window has no story. */
  minClusterSupport: number;
  /** A window spread wider than this is not describing one object, so no
   *  departure can be read out of it. */
  chaosSpreadCm: number;
  /** How long a chaotic-but-far signal may block a departure before it is
   *  believed anyway (ms). Stops a permanently confused sensor from holding a
   *  session open forever. 0 disables the escape hatch. */
  chaosMaxMs: number;
  /** A jump at least this large is a step no seated body performs (cm). */
  rampStepCm: number;
  /** Consecutive such jumps before the run is called an artifact. */
  rampMinSteps: number;
  /** Longest a ramp may keep masking samples if it never settles (ms). */
  rampMaskMs: number;
  /** A gap longer than this means the board stopped reporting; the window is
   *  cleared rather than joined across the hole (ms). */
  streamGapMs: number;
}

export const DEFAULT_SENSOR_FILTER_CONFIG: SensorFilterConfig = {
  // Measured on this desk: seated reads 30-39 cm, empty chair 57-59 cm.
  enterCm: 48,
  exitCm: 52,
  // There is a wall behind this desk, so nothing here can legitimately read
  // past about a metre.
  maxValidCm: 100,
  minValidCm: 4,
  presentConfirmMs: 2000,
  absentConfirmMs: 5000,
  glitchHoldMs: 10000,
  glitchIgnoreAlways: false,
  clusterWindowMs: 1500,
  clusterTolCm: 12,
  minClusterSupport: 0.5,
  chaosSpreadCm: 40,
  chaosMaxMs: 90000,
  rampStepCm: 15,
  rampMinSteps: 3,
  rampMaskMs: 2000,
  streamGapMs: 3000,
};

/** Why an otherwise-satisfied departure is being withheld. */
export type HoldReason =
  /** A near reading landed inside the window. You are demonstrably here. */
  | 'near-reading'
  /** The window is too spread out to be describing one object. */
  | 'unstable'
  /** No single cluster holds enough of the window to speak for it. */
  | 'no-consensus'
  /** Every recent sample is inside a masked ramp; there is nothing to judge. */
  | 'ramp-masked'
  /** Over-range readings, which this desk treats as never proving absence. */
  | 'over-range-ignored';

export interface PresenceSnapshot {
  /** The filter's decision. Meaningless until `ready`. */
  present: boolean;
  /** `present` differs from what the previous snapshot reported. */
  changed: boolean;
  /** Enough evidence has accumulated to have an opinion at all. */
  ready: boolean;
  /** The distance the filter believes, i.e. the dominant cluster's centre.
   *  Null when the window holds nothing judgeable. Never a held-over value. */
  distanceCm: number | null;
  /** The most recent raw reading, before any of this. */
  rawCm: number | null;
  /** How the most recent reading was classified. */
  rawKind: SampleKind | null;
  /** Fraction of the window inside the dominant cluster (0-1). */
  support: number;
  /** Spread of the whole window (cm). High means it is not one object. */
  spreadCm: number;
  /** Fraction of the window reading as a body (0-1). */
  nearRatio: number;
  /** Fraction of the window reading over-range (0-1). */
  overRatio: number;
  /** The latest sample fell inside a masked ramp. */
  masked: boolean;
  /** Set while a departure is being withheld, with the reason. */
  holding: HoldReason | null;
  /** How long the departure has been withheld (ms). */
  holdingMs: number;
  /** Progress towards a confirmed departure (ms), and what it needs. */
  awayProgressMs: number;
  awayNeedsMs: number;
  /** The same, for arrival. */
  arriveProgressMs: number;
  arriveNeedsMs: number;
  /** Samples currently contributing to the decision. */
  windowCount: number;
  /** The sensor has produced at least one real echo, so it is wired up. */
  everEchoed: boolean;
  /** The departure was forced through by the chaos escape hatch. */
  forced: boolean;
}

const EMPTY_SNAPSHOT: PresenceSnapshot = {
  present: false,
  changed: false,
  ready: false,
  distanceCm: null,
  rawCm: null,
  rawKind: null,
  support: 0,
  spreadCm: 0,
  nearRatio: 0,
  overRatio: 0,
  masked: false,
  holding: null,
  holdingMs: 0,
  awayProgressMs: 0,
  awayNeedsMs: 0,
  arriveProgressMs: 0,
  arriveNeedsMs: 0,
  windowCount: 0,
  everEchoed: false,
  forced: false,
};

interface Sample {
  at: number;
  cm: number;
  kind: SampleKind;
  masked: boolean;
}

/**
 * Largest set of values that all fall inside `tol` of each other.
 *
 * Ties go to the nearest cluster. When half the window says 30 cm and half
 * says 400, believing the near half is the safe error: a spurious near reading
 * costs a session that runs a few seconds too long, a spurious far one costs a
 * session paused while you are working.
 */
function dominantCluster(values: number[], tol: number): { centre: number; count: number } {
  const sorted = [...values].sort((a, b) => a - b);
  let bestStart = 0;
  let bestLen = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end] - sorted[start] > tol) start++;
    const len = end - start + 1;
    if (len > bestLen) {
      bestLen = len;
      bestStart = start;
    }
  }
  const run = sorted.slice(bestStart, bestStart + bestLen);
  return { centre: run[Math.floor(run.length / 2)], count: bestLen };
}

export function coerceSensorFilterConfig(raw: Partial<SensorFilterConfig> | null | undefined): SensorFilterConfig {
  const c = { ...DEFAULT_SENSOR_FILTER_CONFIG };
  if (!raw || typeof raw !== 'object') return c;
  const num = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  c.enterCm = num(raw.enterCm, 2, 400, c.enterCm);
  c.exitCm = num(raw.exitCm, 2, 400, c.exitCm);
  c.maxValidCm = num(raw.maxValidCm, 20, 400, c.maxValidCm);
  c.minValidCm = num(raw.minValidCm, 1, 20, c.minValidCm);
  c.presentConfirmMs = num(raw.presentConfirmMs, 0, 60000, c.presentConfirmMs);
  c.absentConfirmMs = num(raw.absentConfirmMs, 0, 60000, c.absentConfirmMs);
  c.glitchHoldMs = num(raw.glitchHoldMs, 0, 120000, c.glitchHoldMs);
  c.clusterWindowMs = num(raw.clusterWindowMs, 200, 10000, c.clusterWindowMs);
  c.clusterTolCm = num(raw.clusterTolCm, 1, 100, c.clusterTolCm);
  c.minClusterSupport = num(raw.minClusterSupport, 0.1, 1, c.minClusterSupport);
  c.chaosSpreadCm = num(raw.chaosSpreadCm, 5, 400, c.chaosSpreadCm);
  c.chaosMaxMs = num(raw.chaosMaxMs, 0, 600000, c.chaosMaxMs);
  c.rampStepCm = num(raw.rampStepCm, 2, 200, c.rampStepCm);
  c.rampMinSteps = Math.round(num(raw.rampMinSteps, 2, 10, c.rampMinSteps));
  c.rampMaskMs = num(raw.rampMaskMs, 0, 20000, c.rampMaskMs);
  c.streamGapMs = num(raw.streamGapMs, 500, 60000, c.streamGapMs);
  if (typeof raw.glitchIgnoreAlways === 'boolean') c.glitchIgnoreAlways = raw.glitchIgnoreAlways;

  // Hysteresis only exists if leaving needs a strictly larger distance than
  // arriving, and the "implausible" line has to sit outside both, or every
  // reading past the away threshold would be dismissed as a glitch.
  if (c.exitCm <= c.enterCm) c.exitCm = c.enterCm + 4;
  if (c.maxValidCm <= c.exitCm) c.maxValidCm = c.exitCm + 4;
  return c;
}

export class PresenceFilter {
  private cfg: SensorFilterConfig;
  private samples: Sample[] = [];

  private present = false;
  private initialised = false;
  private everEchoed = false;

  private arriveSince: number | null = null;
  private awaySince: number | null = null;
  private holdingSince: number | null = null;

  // Ramp tracking. `rampRun` counts consecutive implausible upward jumps;
  // `maskUntil` is the hard stop on masking, so a signal that never settles
  // cannot silence the filter indefinitely.
  private lastCm: number | null = null;
  private rampRun = 0;
  private maskUntil = 0;
  private masking = false;
  private settleRun = 0;

  private last: PresenceSnapshot = { ...EMPTY_SNAPSHOT };

  constructor(cfg?: Partial<SensorFilterConfig>) {
    this.cfg = coerceSensorFilterConfig(cfg);
  }

  get config(): SensorFilterConfig { return this.cfg; }
  get snapshot(): PresenceSnapshot { return { ...this.last, changed: false }; }

  /**
   * Swap in new tuning. The window is kept -- the readings themselves are
   * still true -- but every dwell timer restarts, because a timer part-way to
   * expiry was measuring progress against a rule that no longer applies.
   */
  configure(cfg: Partial<SensorFilterConfig>) {
    this.cfg = coerceSensorFilterConfig({ ...this.cfg, ...cfg });
    this.arriveSince = null;
    this.awaySince = null;
    this.holdingSince = null;
  }

  /** Forget everything, including the current decision. */
  reset() {
    this.samples = [];
    this.present = false;
    this.initialised = false;
    this.arriveSince = null;
    this.awaySince = null;
    this.holdingSince = null;
    this.lastCm = null;
    this.rampRun = 0;
    this.maskUntil = 0;
    this.masking = false;
    this.settleRun = 0;
    this.last = { ...EMPTY_SNAPSHOT, everEchoed: this.everEchoed };
  }

  private classify(cm: number): SampleKind {
    const c = this.cfg;
    if (cm < c.minValidCm) return 'invalid';
    if (cm < c.enterCm) return 'near';
    if (cm <= c.exitCm) return 'band';
    if (cm <= c.maxValidCm) return 'far';
    return 'over';
  }

  /**
   * Feed one raw reading. `rawCm` is exactly what the board measured; pass
   * null (or 0) for an echo timeout, which is a real observation of "nothing
   * came back", not a failed one.
   */
  push(rawCm: number | null, at: number): PresenceSnapshot {
    const c = this.cfg;
    // A timeout is the sensor saying "nothing within range". It is entered as
    // the furthest thing it could possibly mean, so that it participates in
    // the statistics rather than being silently dropped.
    const timeoutCm = Math.max(c.maxValidCm + 1, 400);
    const isTimeout = rawCm === null || !Number.isFinite(rawCm) || (rawCm as number) <= 0;
    const cm = isTimeout ? timeoutCm : (rawCm as number);

    // A real echo inside the plausible band is the only thing a working module
    // can produce, so it is what proves the sensor is wired up at all. Without
    // it, a disconnected sensor -- which times out exactly like an empty desk
    // -- would pause and then terminate a session you are sitting in.
    if (!isTimeout && cm >= c.minValidCm && cm < timeoutCm) this.everEchoed = true;

    const prev = this.samples.length ? this.samples[this.samples.length - 1] : null;
    // A hole in the stream means the board or the link went away. Joining
    // across it would compute a spread between two unrelated moments.
    if (prev && at - prev.at > c.streamGapMs) {
      this.samples = [];
      this.lastCm = null;
      this.rampRun = 0;
      this.settleRun = 0;
      this.masking = false;
      this.arriveSince = null;
      this.awaySince = null;
    }

    const kind = this.classify(cm);

    // --- ramp masking -------------------------------------------------------
    // Only upward runs are masked. A target that suddenly appears close is a
    // person arriving, and believing that early is the safe direction; a
    // target that recedes in implausible strides is a beam losing its
    // reflector, and believing that is how a seated user gets marked away.
    let masked = false;
    if (kind !== 'invalid') {
      if (this.lastCm !== null) {
        const step = cm - this.lastCm;
        if (step >= c.rampStepCm) {
          this.rampRun++;
          this.settleRun = 0;
          if (this.rampRun >= c.rampMinSteps && !this.masking) {
            this.masking = true;
            this.maskUntil = at + c.rampMaskMs;
            // Retroactive, because the readings that made up the ramp are the
            // corrupt ones and they are already in the window. This is the
            // whole point: the 80 cm sitting between a seated 30 and a
            // timed-out 400 is the single most misleading number in the run,
            // and it is exactly the one a "hold the last valid reading" scheme
            // would keep.
            for (let i = this.samples.length - 1, n = 0; i >= 0 && n < c.rampMinSteps - 1; i--, n++) {
              this.samples[i].masked = true;
            }
          }
        } else if (Math.abs(step) <= c.clusterTolCm) {
          // Settled: consecutive readings agreeing with each other means the
          // beam has found something and is holding it, whatever it is.
          this.settleRun++;
          this.rampRun = 0;
          if (this.masking && this.settleRun >= 2) this.masking = false;
        } else {
          this.rampRun = 0;
          this.settleRun = 0;
        }
      }
      if (this.masking && at >= this.maskUntil) this.masking = false;
      masked = this.masking;
      this.lastCm = cm;
    }

    this.samples.push({ at, cm, kind, masked: masked || kind === 'invalid' });
    const cutoff = at - Math.max(c.clusterWindowMs, 500);
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();

    return this.evaluate(at, cm, kind, masked);
  }

  private evaluate(now: number, rawCm: number, rawKind: SampleKind, masked: boolean): PresenceSnapshot {
    const c = this.cfg;
    const usable = this.samples.filter(s => !s.masked && s.kind !== 'invalid');
    const wasPresent = this.present;

    const snap: PresenceSnapshot = {
      ...EMPTY_SNAPSHOT,
      present: this.present,
      ready: this.initialised && this.everEchoed,
      rawCm,
      rawKind,
      masked,
      windowCount: usable.length,
      everEchoed: this.everEchoed,
      arriveNeedsMs: c.presentConfirmMs,
    };

    // Nothing judgeable: every recent reading was masked or impossible. The
    // decision stands untouched -- this is the one place the filter
    // deliberately holds, and it holds the *verdict*, never a distance.
    if (usable.length === 0) {
      this.arriveSince = null;
      this.awaySince = null;
      snap.holding = 'ramp-masked';
      snap.holdingMs = this.trackHold(now);
      this.last = snap;
      return snap;
    }

    const values = usable.map(s => s.cm);
    const { centre, count } = dominantCluster(values, c.clusterTolCm);
    const support = count / values.length;
    const spreadCm = Math.max(...values) - Math.min(...values);
    const nearCount = usable.filter(s => s.kind === 'near').length;
    const overCount = usable.filter(s => s.kind === 'over').length;

    snap.distanceCm = centre;
    snap.support = support;
    snap.spreadCm = spreadCm;
    snap.nearRatio = nearCount / usable.length;
    snap.overRatio = overCount / usable.length;

    // --- first opinion ------------------------------------------------------
    // Established with no dwell time, or a server restart would publish
    // "absent" while you sit in front of the sensor. It still waits for a
    // window that agrees with itself, so one reading cannot decide it alone.
    if (!this.initialised) {
      if (!this.everEchoed || support < c.minClusterSupport || spreadCm > c.chaosSpreadCm) {
        this.last = snap;
        return snap;
      }
      this.initialised = true;
      this.present = centre < c.enterCm;
      snap.present = this.present;
      snap.ready = true;
      snap.changed = true;
      this.last = snap;
      return snap;
    }

    // --- hysteresis ---------------------------------------------------------
    // Which side of the band the cluster has to be on depends on where we
    // already are, so a distance parked on a threshold cannot oscillate.
    const wantsPresent = !this.present && centre < c.enterCm;
    const wantsAway = this.present && centre > c.exitCm;

    // --- arrival ------------------------------------------------------------
    // No vetoes. A cluster of near readings cannot be manufactured by a sensor
    // with nothing in front of it, so this half of the problem is the easy one.
    if (wantsPresent && support >= c.minClusterSupport) {
      if (this.arriveSince === null) this.arriveSince = now;
      snap.arriveProgressMs = now - this.arriveSince;
      if (now - this.arriveSince >= c.presentConfirmMs) {
        this.present = true;
        this.arriveSince = null;
        this.awaySince = null;
        this.holdingSince = null;
      }
    } else {
      this.arriveSince = null;
    }

    // --- departure ----------------------------------------------------------
    if (wantsAway) {
      // Over-range is the module's known failure mode rather than a distance
      // this desk can produce, so it is held to a much longer proof -- or, if
      // the empty state of the desk reads inside maxValidCm anyway, to one it
      // can never meet.
      const overRange = centre > c.maxValidCm;
      const needs = overRange ? Math.max(c.absentConfirmMs, c.glitchHoldMs) : c.absentConfirmMs;
      snap.awayNeedsMs = needs;

      let veto: HoldReason | null = null;
      if (overRange && c.glitchIgnoreAlways) veto = 'over-range-ignored';
      else if (nearCount > 0) veto = 'near-reading';
      else if (spreadCm > c.chaosSpreadCm) veto = 'unstable';
      else if (support < c.minClusterSupport) veto = 'no-consensus';

      if (veto) {
        this.awaySince = null;
        snap.holding = veto;
        snap.holdingMs = this.trackHold(now);
        // Escape hatch. A signal that has been far-but-incoherent this long is
        // a sensor that has stopped working, not a session worth protecting.
        // Never armed while a near reading is in the window, and never while
        // over-range readings are the thing being disbelieved on purpose.
        if (c.chaosMaxMs > 0
            && veto !== 'over-range-ignored'
            && veto !== 'near-reading'
            && snap.holdingMs >= c.chaosMaxMs) {
          this.present = false;
          snap.forced = true;
          this.holdingSince = null;
          snap.holding = null;
        }
      } else {
        this.holdingSince = null;
        if (this.awaySince === null) this.awaySince = now;
        snap.awayProgressMs = now - this.awaySince;
        if (now - this.awaySince >= needs) {
          this.present = false;
          this.awaySince = null;
          this.arriveSince = null;
        }
      }
    } else {
      this.awaySince = null;
      this.holdingSince = null;
    }

    snap.present = this.present;
    snap.changed = this.present !== wasPresent;
    snap.ready = true;
    this.last = snap;
    return snap;
  }

  /** Runs the "how long have we been withholding a departure" clock. */
  private trackHold(now: number): number {
    if (this.holdingSince === null) this.holdingSince = now;
    return now - this.holdingSince;
  }
}

export function createPresenceFilter(cfg?: Partial<SensorFilterConfig>): PresenceFilter {
  return new PresenceFilter(cfg);
}
