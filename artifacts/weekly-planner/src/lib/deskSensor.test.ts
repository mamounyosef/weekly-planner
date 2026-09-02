// The desk, end to end: ultrasonic centimetres in, focus sessions out.
//
// WHY THIS FILE IS SEPARATE FROM THE OTHER THREE
// sensorFilter, hardwareBridge and hardwareController each have their own
// suite, and each of them passed while the desk sat there doing nothing. Every
// bug this file was written for lives BETWEEN two of those pieces:
//
//   the filter decided you were present, and the controller never heard,
//     because presence was published only as edges and an edge can be missed;
//   a window that opened while you were already sitting there discarded the
//     backlog and then went home before looking at what the sensor currently
//     said, so nothing ever corrected it;
//   the firmware's own pin chatter filled the one log that could have
//     explained any of it.
//
// So this drives the REAL pieces together, from raw centimetres through the
// bridge's filter, out of its event queue, into the reducer, and asserts on the
// session actions that come out the far end. A fake sensor generates the
// readings, including the ugly ones this particular board actually produces:
// dropouts that read 400cm, a 15cm ramp as somebody walks in, and noise.
//
// Run with: npx tsx src/lib/deskSensor.test.ts

import assert from 'node:assert/strict';

import {
  DEFAULT_HARDWARE_SETTINGS,
  INITIAL_CONTROLLER_STATE,
  SENSOR_SILENT_MS,
  presenceResync,
  reduceHardware,
  type HardwareAction,
  type HardwareControllerState,
  type HardwareSettings,
  type PresenceLevel,
  type SessionSnapshot,
} from './hardwareController';
import { createHardwareBridge, type HardwareBridge } from './hardwareBridge';

// ── A desk, simulated ───────────────────────────────────────────────────────

const SAMPLE_MS = 100;

/**
 * Noise you can reproduce.
 *
 * The readings here need to be irregular -- a sensor that returns the same
 * number forever is not the sensor on this desk -- but a suite that fails one
 * run in ten and passes the next is worse than no suite: it teaches you to
 * re-run it rather than read it. So the jitter and the dropouts come from a
 * seeded generator, and a failure here is a failure every single time.
 */
function makeRandom(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/** A distance the board reports when the pulse comes back from nothing. */
const NO_ECHO = 400;

interface DeskOptions {
  settings?: Partial<HardwareSettings>;
  /** Where the person is sitting, in cm. */
  sittingCm?: number;
  /** Where the wall behind the chair is. */
  emptyCm?: number;
  /** Seed for the noise, so every run of this file is the same run. */
  seed?: number;
}

/**
 * The whole desk in one object: a bridge with a real filter, a real reducer,
 * and a session that starts and stops the way the app's own handlers do.
 */
class Desk {
  clock = 1_700_000_000_000;
  bridge: HardwareBridge;
  settings: HardwareSettings;
  state: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE };
  session: SessionSnapshot = { isRunning: false, hasSession: false, ready: true };
  actions: HardwareAction[] = [];
  /** Where the controller's event cursor has got to. */
  cursor = 0;
  synced = false;
  sittingCm: number;
  emptyCm: number;
  /** Every session the desk has logged, as [startedAtMs, endedAtMs]. */
  logged: Array<[number, number]> = [];
  private startedAt: number | null = null;
  private rnd: () => number;

  constructor(opts: DeskOptions = {}) {
    this.rnd = makeRandom(opts.seed ?? 0x5eed);
    this.settings = { ...DEFAULT_HARDWARE_SETTINGS, ...opts.settings };
    this.sittingCm = opts.sittingCm ?? 30;
    this.emptyCm = opts.emptyCm ?? 90;
    this.bridge = createHardwareBridge({ now: () => this.clock });
  }

  /** Push one batch of readings, exactly as the firmware posts them. */
  report(cm: Array<number | null>): void {
    this.clock += cm.length * SAMPLE_MS;
    this.bridge.handleEvent(
      { type: 'samples', dt: SAMPLE_MS, cm: cm.map(v => (v === null ? 0 : v)) },
      this.clock,
    );
  }

  /** Sit at the desk for `seconds`, reporting the whole time. */
  sit(seconds: number, jitter = 2): void {
    this.stream(seconds, () => this.sittingCm + (this.rnd() - 0.5) * jitter);
  }

  /** Be away for `seconds`. */
  away(seconds: number, jitter = 4): void {
    this.stream(seconds, () => this.emptyCm + (this.rnd() - 0.5) * jitter);
  }

  /** Away, but the board keeps losing the echo, which is what it really does. */
  awayWithDropouts(seconds: number, dropRatio = 0.4): void {
    this.stream(seconds, () => (this.rnd() < dropRatio ? NO_ECHO : this.emptyCm));
  }

  private stream(seconds: number, value: () => number): void {
    const batches = Math.max(1, Math.round((seconds * 1000) / (SAMPLE_MS * 5)));
    for (let b = 0; b < batches; b += 1) {
      this.report([value(), value(), value(), value(), value()]);
      this.pump();
    }
  }

  /** Walk in: a ramp of decreasing distances, the way an approach looks. */
  walkIn(steps = 5): void {
    const from = this.emptyCm;
    const to = this.sittingCm;
    for (let i = 1; i <= steps; i += 1) {
      const cm = from + ((to - from) * i) / steps;
      this.report([cm, cm, cm, cm, cm]);
      this.pump();
    }
  }

  /** One turn of the controller's poll loop, with the bridge's real payload. */
  pump(): HardwareAction[] {
    const res = this.bridge.getEvents(this.cursor, true, this.clock);
    const body = res.body as {
      events: Array<{ id: number; type: string; present?: boolean; at?: number }>;
      latest: number;
      presence: PresenceLevel;
    };

    const inputs: Array<{ kind: 'presence' | 'tick'; present?: boolean }> = [];
    if (!this.synced) {
      this.synced = true;
      this.cursor = body.latest;
    } else {
      for (const e of body.events) {
        this.cursor = Math.max(this.cursor, e.id);
        if (e.type !== 'presence') continue;
        if (typeof e.at === 'number' && this.clock - e.at > 10_000) continue;
        inputs.push({ kind: 'presence', present: e.present });
      }
    }

    if (!inputs.some(i => i.kind === 'presence')) {
      const resync = presenceResync(this.state, body.presence, this.clock);
      if (resync) inputs.push(resync as { kind: 'presence'; present?: boolean });
    }
    if (inputs.length === 0) inputs.push({ kind: 'tick' });

    const done: HardwareAction[] = [];
    for (const input of inputs) {
      const out = reduceHardware(this.state, input as never, this.session, this.settings, this.clock);
      this.state = out.state;
      for (const a of out.actions) {
        done.push(a);
        this.apply(a);
      }
    }
    this.actions.push(...done);
    return done;
  }

  /** Let time pass with no readings at all, the way an unplugged board does. */
  idle(seconds: number): void {
    const steps = Math.max(1, Math.round(seconds / 0.5));
    for (let i = 0; i < steps; i += 1) {
      this.clock += 500;
      this.pump();
    }
  }

  /** The app's own start/pause/terminate, so the reducer sees a real session. */
  private apply(action: HardwareAction): void {
    if (action === 'start') {
      this.session = { isRunning: true, hasSession: true, ready: true };
      this.startedAt = this.clock;
    } else if (action === 'toggle') {
      if (this.session.isRunning) this.session = { ...this.session, isRunning: false };
      else if (this.session.hasSession) this.session = { ...this.session, isRunning: true };
      else { this.session = { isRunning: true, hasSession: true, ready: true }; this.startedAt = this.clock; }
    } else if (action === 'pause') {
      this.session = { ...this.session, isRunning: false };
    } else if (action === 'resume') {
      this.session = { ...this.session, isRunning: true };
    } else if (action === 'terminate') {
      if (this.startedAt !== null) this.logged.push([this.startedAt, this.clock]);
      this.startedAt = null;
      this.session = { isRunning: false, hasSession: false, ready: true };
    }
  }

  get present(): boolean { return this.state.present; }
  get arming(): boolean { return this.state.armingUntil !== null; }
  get level(): PresenceLevel {
    return (this.bridge.getEvents(this.cursor, true, this.clock).body as { presence: PresenceLevel }).presence;
  }
  took(action: HardwareAction): boolean { return this.actions.includes(action); }
  clear(): void { this.actions = []; }
}

function main() {
  console.log('--- 1. SITTING DOWN STARTS A SESSION ---');
  {
    const desk = new Desk({ settings: { armSeconds: 5 } });
    desk.away(10);
    assert.equal(desk.present, false, 'an empty desk is empty');
    assert.equal(desk.session.hasSession, false);

    desk.walkIn();
    desk.sit(5);
    assert.equal(desk.present, true, 'the controller knows you sat down');
    assert.ok(desk.arming || desk.session.hasSession, 'and a countdown is running');

    desk.sit(8);
    assert.equal(desk.session.isRunning, true, 'the session started on its own');
    assert.equal(desk.state.manualSession, false, 'and it is a desk session, not a hand one');
  }

  console.log('--- 2. THE BUG: A MISSED EDGE USED TO BE PERMANENT ---');
  {
    // The exact shape of the failure on this desk. The window opens while you
    // are ALREADY sitting there, so the only presence edge there will ever be
    // has already happened and been discarded with the backlog. Sitting still
    // produces no further edges. Before the level check, the controller sat on
    // `present: false` for as long as you stayed put -- measured at 38 minutes
    // -- with the LCD saying Ready.
    const desk = new Desk({ settings: { armSeconds: 5 } });

    // The desk is occupied before any window exists.
    desk.synced = true;              // a window that has already taken its position
    desk.cursor = 9999;              // and will never be handed those old events
    desk.sit(6);

    assert.equal(desk.level.present, true, 'the sensor is in no doubt');
    assert.equal(desk.level.ready, true);

    desk.pump();
    assert.equal(desk.present, true, 'and the controller now agrees with it');

    desk.sit(8);
    assert.equal(desk.session.isRunning, true, 'so the session starts after all');
  }

  console.log('--- 3. A WINDOW OPENING MID-SIT CATCHES UP ---');
  {
    // Same thing by the honest route: a brand new window, first poll, desk
    // already occupied. The backlog is still discarded (a ten minute old edge
    // must never pause a running session) but the LEVEL is acted on.
    const desk = new Desk({ settings: { armSeconds: 5 } });
    desk.sit(6);

    const fresh = new Desk({ settings: { armSeconds: 5 } });
    fresh.bridge = desk.bridge;
    fresh.clock = desk.clock;
    assert.equal(fresh.synced, false, 'it has never polled');

    fresh.pump();                       // the first poll: adopts position only
    assert.equal(fresh.present, true, 'and still learns where you are');

    fresh.clock += 6000;
    fresh.pump();
    assert.ok(fresh.arming || fresh.session.hasSession, 'the countdown is under way');
  }

  console.log('--- 4. STANDING UP PAUSES, AND STAYING AWAY ENDS IT ---');
  {
    const desk = new Desk({ settings: { armSeconds: 0, awayTerminateSeconds: 60 } });
    desk.sit(6);
    desk.pump();
    assert.equal(desk.session.isRunning, true, 'started');

    desk.away(30);
    assert.equal(desk.present, false, 'the desk sees you go');
    assert.equal(desk.session.isRunning, false, 'and the session pauses');
    assert.equal(desk.session.hasSession, true, 'but is not thrown away yet');
    assert.equal(desk.state.pausedByAway, true, 'and it knows why it paused');

    desk.away(40);
    assert.equal(desk.session.hasSession, false, 'past the timeout it is ended');
    assert.equal(desk.logged.length, 1, 'and logged exactly once');
  }

  console.log('--- 5. COMING STRAIGHT BACK RESUMES THE SAME SESSION ---');
  {
    const desk = new Desk({ settings: { armSeconds: 0, awayTerminateSeconds: 120 } });
    desk.sit(6);
    desk.pump();
    assert.equal(desk.session.isRunning, true);

    desk.away(20);
    assert.equal(desk.session.isRunning, false, 'paused while you were up');

    desk.walkIn();
    desk.sit(6);
    assert.equal(desk.session.isRunning, true, 'and running again on your return');
    assert.equal(desk.session.hasSession, true);
    assert.equal(desk.logged.length, 0, 'nothing was ended, so nothing was logged');
    assert.equal(desk.state.pausedByAway, false);
  }

  console.log('--- 6. A SESSION YOU PAUSED YOURSELF STAYS PAUSED ---');
  {
    // Sitting back down is not a request to undo a pause you asked for.
    const desk = new Desk({ settings: { armSeconds: 0, awayTerminateSeconds: 120 } });
    desk.sit(6);
    desk.pump();
    assert.equal(desk.session.isRunning, true);

    // Paused by hand, from the app.
    desk.session = { ...desk.session, isRunning: false };
    desk.state = { ...desk.state, pausedByAway: false };

    desk.away(20);
    desk.walkIn();
    desk.sit(6);
    assert.equal(desk.session.isRunning, false, 'still paused, as you left it');
  }

  console.log('--- 7. AN UNPLUGGED BOARD DECIDES NOTHING ---');
  {
    // The last thing a sensor said stops being evidence once it stops talking.
    // Without this, unplugging the board while you sat there would keep
    // re-arming sessions for as long as the server stayed up.
    const desk = new Desk({ settings: { armSeconds: 5 } });
    desk.sit(6);
    desk.pump();

    const quiet: PresenceLevel = { present: true, ready: true, at: desk.clock };
    const stateAway: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE, present: false };
    assert.deepEqual(
      presenceResync(stateAway, quiet, desk.clock),
      { kind: 'presence', present: true },
      'a live board is listened to',
    );
    assert.equal(
      presenceResync(stateAway, quiet, desk.clock + SENSOR_SILENT_MS + 1),
      null,
      'a silent one is not',
    );
    assert.equal(
      presenceResync(stateAway, { ...quiet, ready: false }, desk.clock),
      null,
      'nor is one still warming up',
    );
    assert.equal(
      presenceResync(stateAway, { ...quiet, at: 0 }, desk.clock),
      null,
      'and "never reported" is not 1970',
    );

    // Agreement is silence: no input, so no log entry and no churn.
    assert.equal(
      presenceResync({ ...INITIAL_CONTROLLER_STATE, present: true }, quiet, desk.clock),
      null,
      'nothing to correct when the two already agree',
    );

    // Rubbish never produces an input.
    for (const bad of [null, undefined, {}, { present: 'yes', ready: true, at: 1 }, 7, 'x']) {
      assert.equal(presenceResync(stateAway, bad as never, desk.clock), null, `rejects ${JSON.stringify(bad)}`);
    }
  }

  console.log('--- 8. DROPOUTS AND NOISE DO NOT INVENT A PERSON ---');
  {
    // This board answers 400cm when the pulse comes back from nothing, and it
    // does it constantly. A filter that treated those as readings would flap;
    // one that held the last verdict forever would never let you leave.
    const desk = new Desk({ settings: { armSeconds: 0, awayTerminateSeconds: 3600 } });
    desk.away(10);
    assert.equal(desk.present, false);

    desk.awayWithDropouts(30, 0.5);
    assert.equal(desk.present, false, 'an empty desk with a flaky sensor is still empty');
    assert.equal(desk.session.hasSession, false, 'and nothing was started');
    assert.equal(desk.took('start'), false);
  }

  console.log('--- 9. A SESSION IS NOT STARTED TWICE ---');
  {
    const desk = new Desk({ settings: { armSeconds: 0 } });
    desk.sit(20);
    const starts = desk.actions.filter(a => a === 'start').length;
    assert.equal(starts, 1, `sat still for twenty seconds and started once, not ${starts}`);

    // And the level check, running on every single poll, never re-fires it.
    desk.clear();
    desk.sit(30);
    assert.equal(desk.actions.filter(a => a === 'start').length, 0, 'still one session');
    assert.equal(desk.actions.filter(a => a === 'pause').length, 0, 'and never paused');
  }

  console.log('--- 10. A WHOLE MORNING, WITH THE INTERRUPTIONS ---');
  {
    const desk = new Desk({ settings: {
      armSeconds: 0, awayTerminateSeconds: 90, autoRestartEnabled: true, autoRestartArmSeconds: 0,
    } });

    desk.away(20);
    desk.walkIn();
    desk.sit(60);
    assert.equal(desk.session.isRunning, true, 'working');

    desk.away(30);                       // a cup of tea
    assert.equal(desk.session.isRunning, false, 'paused for the kettle');
    desk.walkIn();
    desk.sit(60);
    assert.equal(desk.session.isRunning, true, 'and back to it');
    assert.equal(desk.logged.length, 0, 'one continuous session so far');

    // Lunch, with the sensor misbehaving. Deliberately long: a flaky signal
    // costs a full chaosMaxMs (90s) before the filter will call it absence at
    // all, and only then does the controller's own away timeout start. See
    // section 16, which pins that arithmetic down.
    desk.awayWithDropouts(300, 0.3);
    assert.equal(desk.session.hasSession, false, 'lunch ended it');
    assert.equal(desk.logged.length, 1);

    desk.walkIn();
    desk.sit(30);
    assert.equal(desk.session.isRunning, true, 'the afternoon is a NEW session');
    assert.equal(desk.logged.length, 1, 'and the morning one is still the only logged one');
  }

  console.log('--- 11. THE SENSOR SWITCHED OFF CHANGES NOTHING ---');
  {
    const desk = new Desk({ settings: { armSeconds: 0, sensorEnabled: false } });
    desk.sit(30);
    assert.equal(desk.session.hasSession, false, 'no session from a sensor nobody asked for');
    assert.equal(desk.took('start'), false);

    // And with the whole feature off, not even the state is touched.
    const off = new Desk({ settings: { enabled: false } });
    off.sit(30);
    assert.deepEqual(off.state, INITIAL_CONTROLLER_STATE);
    assert.equal(off.actions.length, 0);
  }

  console.log('--- 12. FIRMWARE CHATTER CANNOT BURY A DECISION ---');
  {
    // The buttons on this desk emit thousands of spurious pin edges. They used
    // to share one 200-entry ring with the controller's decisions, so the log
    // that exists to explain a wrong start could only show which pins wobbled.
    const bridge = createHardwareBridge();
    bridge.postLog({ input: 'presence', actions: ['start'] });
    for (let i = 0; i < 500; i += 1) bridge.postLog({ source: 'edge', pin: 38, level: 1 });

    const body = bridge.getLog().body as {
      entries: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    assert.equal(body.entries.length, 1, 'the decision is still there');
    assert.equal(body.entries[0].input, 'presence');
    assert.equal(body.edges.length, 200, 'and the chatter is capped in its own ring');
  }

  console.log('--- 13. THE LEVEL IS PUBLISHED ON EVERY POLL ---');
  {
    const desk = new Desk();
    desk.away(10);
    const empty = desk.level;
    assert.equal(empty.ready, true, 'the filter has an opinion');
    assert.equal(empty.present, false);
    assert.ok(empty.at > 0, 'stamped with when the board last spoke');

    desk.walkIn();
    desk.sit(6);
    assert.equal(desk.level.present, true, 'and it follows the desk');

    // A bridge that has never heard from a board must not claim readiness.
    const cold = createHardwareBridge();
    const level = (cold.getEvents(0, true).body as { presence: PresenceLevel }).presence;
    assert.equal(level.ready, false, 'nothing to say yet');
    assert.equal(level.at, 0, 'and no board has ever reported');
    assert.equal(presenceResync(INITIAL_CONTROLLER_STATE, level, Date.now()), null);
  }

  console.log('--- 14. AN UNAUTHENTICATED POLL LEARNS NOTHING ---');
  {
    // Presence is not public. Checked because the failure mode is silent: the
    // caller gets a 200 and an empty list, which looks exactly like a quiet
    // desk rather than like a refusal.
    const desk = new Desk();
    desk.sit(10);
    const body = desk.bridge.getEvents(0, false, desk.clock).body as Record<string, unknown>;
    assert.deepEqual(body.events, []);
    assert.equal(body.latest, 0);
    assert.equal(body.presence, undefined, 'and no level either');
  }

  console.log('--- 15. TWO WINDOWS, ONE DESK ---');
  {
    // The main window and the widget both poll. Only the lease holder acts, but
    // both must arrive at the same picture of where you are, or the countdown
    // shown in one disagrees with the session running in the other.
    const bridge = createHardwareBridge();
    const main = new Desk({ settings: { armSeconds: 0 } });
    const widget = new Desk({ settings: { armSeconds: 0 } });
    main.bridge = bridge;
    widget.bridge = bridge;

    main.sit(10);
    widget.clock = main.clock;
    widget.pump();
    widget.clock += 1000;
    widget.pump();

    assert.equal(main.present, true);
    assert.equal(widget.present, true, 'the second window agrees about the desk');
  }

  console.log('--- 16. A FLAKY SENSOR COSTS TIME, AND THE COST IS KNOWN ---');
  {
    // This board answers 400cm when it hears nothing, constantly. Such a window
    // is too spread out to describe one object, so the filter refuses to call
    // it absence and holds -- which is right, because a dropout is not proof
    // that you left. The escape hatch is what stops that hold lasting forever:
    // a signal that has been far-but-incoherent for chaosMaxMs is a sensor that
    // has stopped working, not a session worth protecting.
    //
    // The number matters. Until the hatch fires the session keeps running, so
    // this is exactly how much focus time a bad sensor can invent.
    const desk = new Desk({ settings: { armSeconds: 0, awayTerminateSeconds: 60 } });
    desk.sit(10);
    desk.pump();
    assert.equal(desk.session.isRunning, true);

    desk.awayWithDropouts(60, 0.3);
    assert.equal(desk.present, true, 'sixty seconds of noise proves nothing');
    assert.equal(desk.session.isRunning, true, 'so the session is still protected');

    desk.awayWithDropouts(60, 0.3);
    assert.equal(desk.present, false, 'past the chaos timeout it gives up on the sensor');
    assert.equal(desk.session.isRunning, false, 'and the session pauses');

    desk.awayWithDropouts(90, 0.3);
    assert.equal(desk.session.hasSession, false, 'then the away timeout ends it');

    // A CLEAN signal costs nothing like as long: this is the comparison that
    // says the delay is the sensor's fault and not the logic's.
    const clean = new Desk({ settings: { armSeconds: 0, awayTerminateSeconds: 60 } });
    clean.sit(10);
    clean.pump();
    clean.away(20);
    assert.equal(clean.present, false, 'twenty clean seconds is enough');
    assert.equal(clean.session.isRunning, false);
  }

  console.log('--- 17. NOBODY THERE ALL NIGHT MEANS NO SESSIONS ALL NIGHT ---');
  {
    // The runaway case behind "it added hours it should not have": an empty
    // desk, a sensor that keeps dropping out, and chaining switched on.
    const desk = new Desk({ settings: {
      armSeconds: 0, awayTerminateSeconds: 60, autoRestartEnabled: true, autoRestartArmSeconds: 0,
    } });
    desk.away(10);
    assert.equal(desk.present, false);

    for (let hour = 0; hour < 8; hour += 1) desk.awayWithDropouts(900, 0.35);

    assert.equal(desk.session.hasSession, false, 'eight hours of an empty desk logged nothing');
    assert.equal(desk.logged.length, 0);
    assert.equal(desk.actions.filter(a => a === 'start').length, 0, 'and never started one');
  }

  console.log('--- 18. THE SAME STORY, TWELVE DIFFERENT SETS OF NOISE ---');
  {
    // One seed proves the logic works against one particular sequence of
    // readings. Twelve prove it is not that sequence doing the work. Every one
    // is still deterministic, so a failure names the seed that broke it.
    for (let seed = 1; seed <= 12; seed += 1) {
      const desk = new Desk({ seed, settings: { armSeconds: 0, awayTerminateSeconds: 60 } });

      desk.away(15);
      assert.equal(desk.present, false, `seed ${seed}: starts empty`);
      assert.equal(desk.session.hasSession, false, `seed ${seed}: and idle`);

      desk.walkIn();
      desk.sit(15);
      assert.equal(desk.present, true, `seed ${seed}: notices you arrive`);
      assert.equal(desk.session.isRunning, true, `seed ${seed}: and starts a session`);
      assert.equal(
        desk.actions.filter(a => a === 'start').length, 1,
        `seed ${seed}: exactly one session, not several`,
      );

      desk.sit(60);
      assert.equal(desk.session.isRunning, true, `seed ${seed}: a minute of jitter does not pause it`);
      assert.equal(desk.actions.filter(a => a === 'pause').length, 0, `seed ${seed}: never spuriously paused`);

      desk.away(25);
      assert.equal(desk.present, false, `seed ${seed}: notices you leave`);
      assert.equal(desk.session.isRunning, false, `seed ${seed}: and pauses`);

      desk.away(70);
      assert.equal(desk.session.hasSession, false, `seed ${seed}: then ends it`);
      assert.equal(desk.logged.length, 1, `seed ${seed}: one session logged`);

      // And the session that was logged covers the time actually spent there,
      // not the time spent away from it.
      const [from, to] = desk.logged[0];
      const minutes = (to - from) / 60_000;
      assert.ok(minutes > 1 && minutes < 3, `seed ${seed}: a plausible length, got ${minutes.toFixed(1)}m`);
    }
  }

  console.log('\nALL PASS (deskSensor: centimetres in, sessions out)');
}

main();
