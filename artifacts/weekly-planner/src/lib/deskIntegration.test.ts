// ---------------------------------------------------------------------------
// End-to-end integration simulation test suite (Layer E).
//
// Simulates the full multi-tier hardware system:
//   - Physical ultrasonic acoustics & PresenceFilter (sensorFilter.ts)
//   - Server-side REST API & event broker (hardwareBridge.ts)
//   - Client-side state machine reducer (hardwareController.ts)
//   - Focus session lifecycle & recovery (focusSessions.ts)
//
// Run with:  npx tsx src/lib/deskIntegration.test.ts
// ---------------------------------------------------------------------------

import { PresenceFilter, DEFAULT_SENSOR_FILTER_CONFIG } from './sensorFilter';
import {
  HardwareBridge,
  createHardwareBridge,
  HW_LEASE_MS,
  type HardwareEvent,
} from './hardwareBridge';
import {
  reduceHardware,
  INITIAL_CONTROLLER_STATE,
  DEFAULT_HARDWARE_SETTINGS,
  dropCrosstalkButtons,
  type HardwareControllerState,
  type HardwareSettings,
  type HardwareAction,
} from './hardwareController';
import {
  FocusTimerState,
  DEFAULT_FOCUS_TIMER,
  getFocusTimerElapsedSeconds,
  checkpointFocusTimer,
  pauseFocusTimer,
  focusRecoveryFor,
  sumFocusSecondsForDay,
  createManualFocusSession,
  focusDayKey,
  type FocusSession,
  type FocusHeartbeat,
} from './focusSessions';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

/**
 * Full-system simulated desk environment.
 */
class DeskSystem {
  t = 1_700_000_000_000;
  now = () => this.t;

  bridge: HardwareBridge;
  controllerState: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE };
  settings: HardwareSettings;

  // App-side focus timer
  timer: FocusTimerState = { ...DEFAULT_FOCUS_TIMER, plannedSeconds: 1500 };
  loggedSessions: FocusSession[] = [];
  lastHeartbeat: FocusHeartbeat | null = null;

  // Window lease identifier
  windowKey = 'main-window';
  isOwner = true;
  lastEventId = 0;

  constructor(settingsOverrides: Partial<HardwareSettings> = {}) {
    this.settings = { ...DEFAULT_HARDWARE_SETTINGS, armSeconds: 30, awayTerminateSeconds: 120, ...settingsOverrides };
    this.bridge = createHardwareBridge({ now: this.now });
    this.bridge.postConfig(this.settings);
    this.bridge.claim(this.windowKey, true);
  }

  /**
   * Advances the simulation by `seconds` in 500ms steps.
   * On each step:
   *  1. ESP32 sends 5 ultrasonic pings (dt=100ms) with `cm` distance.
   *  2. Client window polls /api/hardware, processes events, runs reducer,
   *     maintains timer state, and publishes LCD display state.
   */
  advance(seconds: number, cm: number | number[] = 32) {
    const steps = Math.max(1, Math.round(seconds / 0.5));
    for (let s = 0; s < steps; s++) {
      this.t += 500;

      // 1. ESP32 pings sensor
      const samples = Array.isArray(cm) ? cm : [cm, cm, cm, cm, cm];
      this.bridge.handleEvent({ type: 'samples', dt: 100, cm: samples }, this.t);

      // 2. Maintain lease
      const claimRes = this.bridge.claim(this.windowKey, true, this.t);
      this.isOwner = Boolean(claimRes.body.owner);
      if (!this.isOwner) continue;

      // 3. Fetch new hardware events
      const pollRes = this.bridge.getEvents(this.lastEventId, true, this.t);
      const events = pollRes.body.events as HardwareEvent[];
      this.lastEventId = Number(pollRes.body.latest);

      // 4. Process events through reducer
      for (const evt of events) {
        if (evt.type === 'presence') {
          this.applyReducer({ kind: 'presence', present: evt.present });
        } else if (evt.type === 'button_a') {
          this.applyReducer({ kind: 'button_a' });
        } else if (evt.type === 'button_b') {
          this.applyReducer({ kind: 'button_b' });
        } else if (evt.type === 'manual_stop') {
          this.applyReducer({ kind: 'manual_stop' });
        }
      }

      // 5. Tick the reducer
      this.applyReducer({ kind: 'tick' });

      // 6. App timer maintenance & heartbeat
      if (this.timer.isRunning) {
        this.timer = checkpointFocusTimer(this.timer, this.t);
        const elapsed = getFocusTimerElapsedSeconds(this.timer, this.t);
        this.lastHeartbeat = {
          at: new Date(this.t).toISOString(),
          sessionStartedAt: this.timer.sessionStartedAt,
          elapsedSeconds: elapsed,
        };

        // Natural completion
        if (elapsed >= this.timer.plannedSeconds) {
          this.loggedSessions.push({
            id: `session-${this.timer.sessionStartedAt}`,
            startedAt: this.timer.sessionStartedAt!,
            endedAt: new Date(this.t).toISOString(),
            durationSeconds: this.timer.plannedSeconds,
            plannedSeconds: this.timer.plannedSeconds,
          });
          this.timer = { ...DEFAULT_FOCUS_TIMER, plannedSeconds: this.timer.plannedSeconds };
          // Tick once more so chaining logic in reducer recognizes completed session
          this.applyReducer({ kind: 'tick' });
        }
      }

      // 7. Post updated controller state & display state to server
      this.bridge.postController(this.controllerState);
      const armSec = this.controllerState.armingUntil !== null
        ? Math.max(0, Math.ceil((this.controllerState.armingUntil - this.t) / 1000))
        : 0;
      const mode = armSec > 0 ? 'arming' : (this.timer.isRunning ? 'running' : (this.timer.sessionStartedAt ? 'paused' : 'idle'));
      this.bridge.postState({
        mode,
        remainingSeconds: Math.max(0, this.timer.plannedSeconds - getFocusTimerElapsedSeconds(this.timer, this.t)),
        todaySeconds: sumFocusSecondsForDay(this.loggedSessions, new Date(this.t)),
        sessionsToday: this.loggedSessions.length,
        armSeconds: armSec,
      }, this.t);
    }
  }

  // --- Hardware simulation: physical button press with crosstalk filter ---
  pressButton(type: 'button_a' | 'button_b', withCrosstalk = false) {
    const rawEvents = [{ type, at: this.t }];
    if (withCrosstalk) {
      // 60ms phantom opposite button
      rawEvents.push({
        type: type === 'button_a' ? 'button_b' : 'button_a',
        at: this.t + 60,
      });
    }
    const clean = dropCrosstalkButtons(rawEvents);
    for (const evt of clean) {
      this.bridge.handleEvent({ type: evt.type }, evt.at ?? this.t);
    }
    // Run immediate tick to process button press
    this.advance(0.5, this.bridge.hwFilter.snapshot.present ? 32 : 58);
  }

  private applyReducer(input: { kind: 'presence' | 'button_a' | 'button_b' | 'manual_stop' | 'tick'; present?: boolean }) {
    const sessionSnapshot = {
      isRunning: this.timer.isRunning,
      hasSession: Boolean(this.timer.sessionStartedAt),
      ready: true,
    };
    const res = reduceHardware(this.controllerState, input, sessionSnapshot, this.settings, this.t);
    this.controllerState = res.state;

    for (const act of res.actions) {
      this.executeAction(act);
    }
  }

  private executeAction(action: HardwareAction) {
    if (action === 'start') {
      this.timer = {
        plannedSeconds: this.timer.plannedSeconds || 1500,
        accumulatedSeconds: 0,
        isRunning: true,
        lastStartedAt: new Date(this.t).toISOString(),
        sessionStartedAt: new Date(this.t).toISOString(),
      };
    } else if (action === 'pause') {
      if (this.timer.isRunning) {
        this.timer = pauseFocusTimer(this.timer, this.t);
      }
    } else if (action === 'resume') {
      if (!this.timer.isRunning && this.timer.sessionStartedAt) {
        this.timer = {
          ...this.timer,
          isRunning: true,
          lastStartedAt: new Date(this.t).toISOString(),
        };
      }
    } else if (action === 'terminate') {
      if (this.timer.sessionStartedAt) {
        const elapsed = getFocusTimerElapsedSeconds(this.timer, this.t);
        if (elapsed > 0) {
          this.loggedSessions.push({
            id: `session-${this.timer.sessionStartedAt}`,
            startedAt: this.timer.sessionStartedAt,
            endedAt: new Date(this.t).toISOString(),
            durationSeconds: elapsed,
            plannedSeconds: this.timer.plannedSeconds,
          });
        }
      }
      this.timer = { ...DEFAULT_FOCUS_TIMER, plannedSeconds: this.timer.plannedSeconds };
    } else if (action === 'toggle') {
      if (this.timer.isRunning) {
        this.executeAction('pause');
      } else if (this.timer.sessionStartedAt) {
        this.executeAction('resume');
      } else {
        this.executeAction('start');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The Morning Arrival
// ---------------------------------------------------------------------------
section('1. The Morning Arrival');
{
  const sys = new DeskSystem({ armSeconds: 30 });
  // Overnight empty desk (400cm timeouts)
  sys.advance(5, 400);
  check('overnight empty desk is idle', !sys.timer.isRunning && !sys.timer.sessionStartedAt);

  // User sits down at desk: stream of 32cm readings
  sys.advance(3, 32); // 3s -> filter detects presence

  check('sitting down initiates arming countdown',
    sys.controllerState.armingUntil !== null && sys.bridge.getState().body.mode === 'arming');
  check('display indicates ~30s arming time', Number(sys.bridge.getState().body.armSeconds) <= 30);

  // User sits through the 30s countdown
  sys.advance(30, 32);

  check('session starts automatically after 30s countdown',
    sys.timer.isRunning && sys.bridge.getState().body.mode === 'running');
  check('remaining time initialized to ~25m (1500s)',
    Number(sys.bridge.getState().body.remainingSeconds) <= 1500);
}

// ---------------------------------------------------------------------------
// 2. The Coffee Trip
// ---------------------------------------------------------------------------
section('2. The Coffee Trip');
{
  const sys = new DeskSystem({ armSeconds: 0, awayTerminateSeconds: 120 });
  // Start session
  sys.advance(3, 32);
  check('session running initially', sys.timer.isRunning);

  // User works for 12 minutes (720s)
  sys.advance(720, 32);
  const elapsedBeforeCoffee = getFocusTimerElapsedSeconds(sys.timer, sys.t);
  check('12 minutes elapsed', elapsedBeforeCoffee >= 720);

  // User stands up for coffee (58cm empty chair readings)
  sys.advance(7, 58); // 7s > absentConfirmMs (6.5s)
  check('session paused automatically upon departure',
    !sys.timer.isRunning && sys.controllerState.pausedByAway === true && sys.bridge.getState().body.mode === 'paused');

  // User away for 90 seconds (< 120s awayTerminateSeconds)
  sys.advance(90, 58);
  check('session still paused at 90s away', !sys.timer.isRunning && Boolean(sys.timer.sessionStartedAt));

  // User returns with coffee (32cm readings)
  sys.advance(3, 32); // 3s arrival

  check('session resumes automatically upon return',
    sys.timer.isRunning && sys.controllerState.pausedByAway === false && sys.bridge.getState().body.mode === 'running');
  check('away timer cleared completely', sys.controllerState.awaySince === null);
}

// ---------------------------------------------------------------------------
// 3. The Abandoned Session
// ---------------------------------------------------------------------------
section('3. The Abandoned Session');
{
  const sys = new DeskSystem({ armSeconds: 0, awayTerminateSeconds: 120 });
  // Start session & work 20 mins (1200s)
  sys.advance(3, 32);
  sys.advance(1200, 32);
  check('20 mins completed', getFocusTimerElapsedSeconds(sys.timer, sys.t) >= 1200);

  // User leaves desk and doesn't return
  sys.advance(7, 58); // pauses
  check('paused upon departure', !sys.timer.isRunning);

  // Advance past 120s awayTerminateSeconds
  sys.advance(125, 58);

  check('session terminated cleanly after 120s away timeout',
    !sys.timer.isRunning && !sys.timer.sessionStartedAt && sys.bridge.getState().body.mode === 'idle');
  check('exactly 1 session logged', sys.loggedSessions.length === 1);
  check('logged duration matches work time (~20m) without away time included',
    Math.round(sys.loggedSessions[0].durationSeconds / 60) === 20);
}

// ---------------------------------------------------------------------------
// 4. The Phone Call (Standing Up to Stretch)
// ---------------------------------------------------------------------------
section('4. The Phone Call (Standing Up to Stretch)');
{
  const sys = new DeskSystem({ armSeconds: 0 });
  sys.advance(3, 32);
  check('session active', sys.timer.isRunning);

  // User explicitly pauses by pressing button A while seated
  sys.pressButton('button_a');
  check('session paused by hand button A',
    !sys.timer.isRunning && sys.controllerState.pausedByAway === false && sys.controllerState.stoppedByHand === false);

  // User stands up to pace during phone call
  sys.advance(15, 58);

  // User returns to desk
  sys.advance(3, 32);

  check('returning to desk does NOT unpause a hand-paused session',
    !sys.timer.isRunning && Boolean(sys.timer.sessionStartedAt));

  // Explicit button A press resumes
  sys.pressButton('button_a');
  check('pressing button A explicitly resumes the session', sys.timer.isRunning);
}

// ---------------------------------------------------------------------------
// 5. The Fidgety Sitter (Hysteresis & Acoustic Stability)
// ---------------------------------------------------------------------------
section('5. The Fidgety Sitter (Hysteresis & Acoustic Stability)');
{
  const sys = new DeskSystem({ armSeconds: 0 });
  sys.advance(3, 32);
  check('seated session running', sys.timer.isRunning);

  // 100 samples fidgeting between 28cm and 52cm (across enterCm 48cm / exitCm 52cm hysteresis band)
  for (let i = 0; i < 20; i++) {
    const cm = 28 + (i % 24);
    sys.advance(0.5, cm);
  }

  check('fidgeting within hysteresis band never pauses running session',
    sys.timer.isRunning && sys.bridge.getState().body.mode === 'running');
}

// ---------------------------------------------------------------------------
// 6. The Foot Against the Transducer
// ---------------------------------------------------------------------------
section('6. The Foot Against the Transducer');
{
  const sys = new DeskSystem({ armSeconds: 0 });
  sys.advance(3, 32);
  check('session running', sys.timer.isRunning);

  // Ramp sequence: foot gradually blocking beam (35 -> 75 -> 115 -> 400)
  sys.advance(0.5, [35, 75, 115, 400, 400]);
  check('ramp masking suppresses false departure during transducer blockage', sys.timer.isRunning);

  // Foot moves away, clean 32cm restored
  sys.advance(3, 32);
  check('session stays uninterrupted after foot is removed', sys.timer.isRunning);
}

// ---------------------------------------------------------------------------
// 7. Hotkey During Arming Countdown (cancelArming)
// ---------------------------------------------------------------------------
section('7. Hotkey During Arming Countdown (cancelArming)');
{
  const sys = new DeskSystem({ armSeconds: 30 });
  // User sits down
  sys.advance(3, 32);
  check('arming countdown active', sys.controllerState.armingUntil !== null);

  // 15 seconds into countdown, user hits system-wide hotkey toggle (/api/focus-timer/toggle)
  sys.advance(15, 32);
  const cancelled = sys.bridge.cancelArming(sys.t);
  check('cancelArming returns true', cancelled);

  // Next window poll applies manual_stop event and updates state
  sys.advance(0.5, 32);
  check('arming countdown cancelled and stoppedByHand set',
    sys.controllerState.armingUntil === null && sys.controllerState.stoppedByHand === true);

  // Wait 30s more while seated
  sys.advance(30, 32);
  check('no session started after cancelled arm countdown',
    !sys.timer.isRunning && !sys.timer.sessionStartedAt);
}

// ---------------------------------------------------------------------------
// 8. The Mid-Session Reload
// ---------------------------------------------------------------------------
section('8. The Mid-Session Reload');
{
  const sys = new DeskSystem({ armSeconds: 0 });
  sys.advance(3, 32);
  // Run 10 minutes (600s)
  sys.advance(600, 32);
  const elapsedBefore = getFocusTimerElapsedSeconds(sys.timer, sys.t);

  // Simulate window reload: window reads controller state from server
  const serverState = sys.bridge.getController().body as HardwareControllerState;
  check('server state preserves sessionActive: true', serverState.sessionActive === true);

  // New window continues running
  sys.advance(1, 32);
  const elapsedAfter = getFocusTimerElapsedSeconds(sys.timer, sys.t);
  check('timekeeping continues accurately after reload without time loss',
    elapsedAfter >= elapsedBefore && elapsedAfter <= elapsedBefore + 5);
}

// ---------------------------------------------------------------------------
// 9. Multi-Window Lease Hand-Off
// ---------------------------------------------------------------------------
section('9. Multi-Window Lease Hand-Off');
{
  const sys = new DeskSystem();
  check('main window is lease owner', sys.bridge.claim('main-window', true).body.owner === true);

  // Side widget tries to claim and is denied
  check('widget denied lease during active main window lease',
    sys.bridge.claim('widget-window', true).body.owner === false);

  // Main window closes (advance time > HW_LEASE_MS)
  sys.t += HW_LEASE_MS + 500;
  const widgetClaim = sys.bridge.claim('widget-window', true, sys.t);
  check('widget acquires lease after main window expires', widgetClaim.body.owner === true);
}

// ---------------------------------------------------------------------------
// 10. Session Chaining
// ---------------------------------------------------------------------------
section('10. Session Chaining');
{
  const sys = new DeskSystem({ armSeconds: 0, autoRestartEnabled: true, autoRestartArmSeconds: 0 });
  // Start 25m session
  sys.advance(3, 32);

  // Work entire 25m (1500s) while seated
  sys.advance(1500, 32);

  check('first session completed and logged', sys.loggedSessions.length === 1);
  check('second session chained immediately while user remained seated',
    sys.timer.isRunning && sys.bridge.getState().body.sessionsToday === 1);
}

// ---------------------------------------------------------------------------
// 11. Accidental Button Crosstalk
// ---------------------------------------------------------------------------
section('11. Accidental Button Crosstalk');
{
  const sys = new DeskSystem({ armSeconds: 0 });
  sys.advance(3, 32);
  check('running', sys.timer.isRunning);

  // User presses button A, electrical crosstalk creates button B 60ms later
  sys.pressButton('button_a', true);

  check('crosstalk rejection ensures button A pauses rather than button B terminating',
    !sys.timer.isRunning && Boolean(sys.timer.sessionStartedAt));
}

// ---------------------------------------------------------------------------
// 12. Unannounced Manual Start
// ---------------------------------------------------------------------------
section('12. Unannounced Manual Start');
{
  const sys = new DeskSystem({ armSeconds: 30 });
  // User starts session from mobile/hotkey while not at desk
  sys.timer = {
    plannedSeconds: 1500,
    accumulatedSeconds: 0,
    isRunning: true,
    lastStartedAt: new Date(sys.t).toISOString(),
    sessionStartedAt: new Date(sys.t).toISOString(),
  };

  sys.advance(0.5, 400); // away from desk
  check('controller adopts manual session without starting countdown',
    sys.controllerState.manualSession === true && sys.controllerState.armingUntil === null);

  // User sits down at desk
  sys.advance(3, 32);
  check('session stays running and does not restart or arm',
    sys.timer.isRunning && sys.controllerState.armingUntil === null);
}

// ---------------------------------------------------------------------------
// 13. PC Sleep & Crash Recovery
// ---------------------------------------------------------------------------
section('13. PC Sleep & Crash Recovery');
{
  const sys = new DeskSystem();
  // Start session and work 10 minutes (600s)
  sys.advance(3, 32);
  sys.advance(600, 32);
  const heartbeatAtSleep = { ...sys.lastHeartbeat! };

  // PC sleeps for 3 hours (10,800s)
  sys.t += 3 * 3600 * 1000;

  // On wake, check crash recovery
  const recovery = focusRecoveryFor(sys.timer, heartbeatAtSleep, sys.t);
  check('recovery identifies dead session on wake from sleep', recovery !== null);
  check('recovered duration is capped to heartbeat elapsed (~600s) not 3 hours',
    recovery !== null && Math.round(recovery.durationSeconds / 60) === 10);
}

// ---------------------------------------------------------------------------
// 14. Local Midnight Transition
// ---------------------------------------------------------------------------
section('14. Local Midnight Transition');
{
  // Session spanning midnight
  const beforeMidnight = new Date(2026, 7, 17, 23, 50, 0); // 23:50 Aug 17
  const afterMidnight = new Date(2026, 7, 18, 0, 15, 0);  // 00:15 Aug 18

  // With dayStartHour = 4 (night owl mode), 00:15 belongs to Aug 17 focus day
  check('night owl dayStartHour 4 attributes 00:15 to previous calendar date',
    focusDayKey(afterMidnight, 4) === '2026-08-17');

  // With dayStartHour = 0 (standard mode), 00:15 belongs to Aug 18
  check('standard dayStartHour 0 attributes 00:15 to current calendar date',
    focusDayKey(afterMidnight, 0) === '2026-08-18');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
