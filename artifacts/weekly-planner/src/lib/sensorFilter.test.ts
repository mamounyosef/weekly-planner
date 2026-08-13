// Mirrors the firmware's sensor filter (main.cpp) so its behaviour can be
// exercised without a board on the desk.
//
// The logic is small but the failure modes are not obvious: dropping over-range
// readings protects a running session from a glitching module, but an empty
// desk with nothing in the beam produces identical readings, so dropping them
// unconditionally would mean leaving was never detected at all. These cases
// pin down both halves.
//
// Run with:  npx tsx src/lib/sensorFilter.test.ts

import { DEFAULT_HARDWARE_SETTINGS } from './hardwareController';

const CFG = {
  maxValidCm: DEFAULT_HARDWARE_SETTINGS.maxValidCm,
  glitchHoldMs: DEFAULT_HARDWARE_SETTINGS.glitchHoldMs,
  medianWindow: DEFAULT_HARDWARE_SETTINGS.medianWindow,
  enterCm: DEFAULT_HARDWARE_SETTINGS.enterCm,
  exitCm: DEFAULT_HARDWARE_SETTINGS.exitCm,
  sampleIntervalMs: DEFAULT_HARDWARE_SETTINGS.sampleIntervalMs,
  presentConfirmMs: DEFAULT_HARDWARE_SETTINGS.presentConfirmMs,
  absentConfirmMs: DEFAULT_HARDWARE_SETTINGS.absentConfirmMs,
};

class Sensor {
  ring: number[] = [];
  glitchRunSince = 0;
  t = 0;

  present = false;
  candidate = false;
  candidateSince = 0;
  initialised = false;

  /** One ping, exactly as the firmware handles it. */
  feed(cm: number) {
    this.t += CFG.sampleIntervalMs;

    if (cm > CFG.maxValidCm) {
      if (this.glitchRunSince === 0) this.glitchRunSince = this.t;
      if (this.t - this.glitchRunSince >= CFG.glitchHoldMs) this.push(cm);
      // else: dropped, the window keeps its last good values
    } else {
      this.glitchRunSince = 0;
      this.push(cm);
    }

    if (this.ring.length >= CFG.medianWindow) this.updatePresence(this.median());
  }

  private push(cm: number) {
    this.ring.push(cm);
    while (this.ring.length > CFG.medianWindow) this.ring.shift();
  }

  median() {
    const sorted = [...this.ring].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private updatePresence(med: number) {
    if (!this.initialised) {
      this.initialised = true;
      this.present = med < CFG.enterCm;
      this.candidate = this.present;
      this.candidateSince = this.t;
      return;
    }
    const raw = this.present ? med <= CFG.exitCm : med < CFG.enterCm;
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateSince = this.t;
      return;
    }
    if (raw === this.present) return;
    const needed = raw ? CFG.presentConfirmMs : CFG.absentConfirmMs;
    if (this.t - this.candidateSince >= needed) this.present = raw;
  }

  /** Feeds one value repeatedly for a number of seconds. */
  hold(cm: number, seconds: number) {
    const n = Math.round((seconds * 1000) / CFG.sampleIntervalMs);
    for (let i = 0; i < n; i++) this.feed(cm);
  }
}

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`);
};

console.log(`Filter: ignore >${CFG.maxValidCm}cm unless sustained ${CFG.glitchHoldMs}ms\n`);

// A seated user, then the module misfires for a couple of seconds.
{
  const s = new Sensor();
  s.hold(35, 5);
  check('seated is detected', s.present, `median=${s.median()}`);
  s.hold(400, 2);
  check('2s glitch burst does not unseat you', s.present, `median=${s.median()} present=${s.present}`);
  s.hold(35, 1);
  check('recovers cleanly afterwards', s.present);
}

// A longer burst, still under the hold.
{
  const s = new Sensor();
  s.hold(35, 5);
  s.hold(400, 9);
  check('9s burst still ignored', s.present, `median=${s.median()}`);
}

// Past the hold: it is not a glitch any more, it is an empty desk.
{
  const s = new Sensor();
  s.hold(35, 5);
  s.hold(400, 11);
  check('readings are believed after the hold expires', s.median() > CFG.maxValidCm, `median=${s.median()}`);
  s.hold(400, 6);
  check('sustained over-range eventually reads as away', !s.present, `present=${s.present}`);
}

// A valid reading in the middle must reset the run, or a flickering sensor
// would slowly accumulate its way past the hold.
{
  const s = new Sensor();
  s.hold(35, 5);
  for (let i = 0; i < 12; i++) { s.hold(400, 0.9); s.hold(35, 0.3); }
  check('intermittent glitches never accumulate past the hold', s.present, `present=${s.present} median=${s.median()}`);
}

// The everyday case: the chair reads well under the limit, so leaving is
// completely unaffected by any of this.
{
  const s = new Sensor();
  s.hold(35, 5);
  check('seated', s.present);
  s.hold(58, 6);
  check('empty chair at 58cm still registers as away', !s.present, `present=${s.present} median=${s.median()}`);
  s.hold(35, 4);
  check('and sitting back down is detected', s.present);
}

// Returning mid-burst must not be masked by the guard.
{
  const s = new Sensor();
  s.hold(58, 8);
  check('away to start with', !s.present);
  s.hold(400, 3);
  s.hold(32, 4);
  check('sitting down during a glitch burst is still detected', s.present, `present=${s.present}`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
