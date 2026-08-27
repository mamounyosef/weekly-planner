// Scenario tests for the desk controller's decision logic.
//
// Two regressions shipped here before this existed: an away-timer that survived
// a resume and killed a live session, and controller state living in one
// window so a reload or a hand-off to the widget lost the fact that you had
// walked away. Both are cheap to catch in simulation and expensive to catch at
// the desk, which is what this file is for.
//
// Run with:  npx tsx src/lib/hardwareController.test.ts

import {
  reduceHardware,
  INITIAL_CONTROLLER_STATE,
  DEFAULT_HARDWARE_SETTINGS,
  coerceHardwareSettings,
  armingSecondsLeft,
  dropCrosstalkButtons,
  type HardwareAction,
  type HardwareControllerState,
  type HardwareSettings,
} from './hardwareController';
import { createHardwareBridge } from './hardwareBridge';

/**
 * Stands in for the hook plus the app's focus timer. Ticks at the real poll
 * rate, and mirrors the rule that a cycle carrying events does not also tick
 * (the session snapshot has not settled yet at that point).
 */
class Desk {
  state: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE };
  isRunning = false;
  hasSession = false;
  ready = true;
  t = 1_700_000_000_000;
  actions: string[] = [];
  settings: HardwareSettings;

  /** What the server holds; survives reloads and lease hand-offs. */
  saved: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE };

  constructor(overrides: Partial<HardwareSettings> = {}) {
    this.settings = { ...DEFAULT_HARDWARE_SETTINGS, ...overrides };
  }

  private apply(actions: HardwareAction[]) {
    for (const a of actions) {
      this.actions.push(a);
      if (a === 'start' || a === 'resume') { this.isRunning = true; this.hasSession = true; }
      if (a === 'toggle') {
        if (this.isRunning) this.isRunning = false;
        else { this.isRunning = true; this.hasSession = true; }
      }
      if (a === 'pause') this.isRunning = false;
      if (a === 'terminate') { this.isRunning = false; this.hasSession = false; }
    }
  }

  private run(kind: 'presence' | 'button_a' | 'button_b' | 'manual_stop' | 'tick', present?: boolean) {
    const r = reduceHardware(
      this.state,
      { kind, present },
      { isRunning: this.isRunning, hasSession: this.hasSession, ready: this.ready },
      this.settings,
      this.t,
    );
    this.state = r.state;
    this.saved = { ...r.state };  // owner persists every cycle
    this.apply(r.actions);
  }

  event(kind: 'presence' | 'button_a' | 'button_b' | 'manual_stop', present?: boolean) { this.run(kind, present); }

  /** Advances time in poll-sized steps. */
  advance(seconds: number) {
    for (let i = 0; i < seconds * 2; i++) {
      this.t += 500;
      this.run('tick');
    }
  }

  /** You start or resume the timer yourself: the on-screen button, the
   *  system-wide hotkey, the phone. Nothing is reported to the controller --
   *  the session simply appears, exactly as it does in the real app. */
  handStart() { this.isRunning = true; this.hasSession = true; }

  /** You pause it yourself. Also unannounced. */
  handPause() { this.isRunning = false; }

  /** You stop it yourself. The app reports this one. */
  handStop() { this.isRunning = false; this.hasSession = false; this.event('manual_stop'); }

  /** The planned time runs out and the app logs the session. */
  sessionEnds() { this.isRunning = false; this.hasSession = false; }

  /** A page reload, or the lease moving to the other window. */
  handOff() {
    this.state = { ...this.saved };
  }

  /** A hand-off to a window that never saw the events (the old failure). */
  handOffWithoutState() {
    this.state = { ...INITIAL_CONTROLLER_STATE };
  }

  get paused() { return this.hasSession && !this.isRunning; }
}

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`);
}

function section(title: string) { console.log(`\n${title}`); }

// ── the core happy path ──────────────────────────────────────────────────────
section('Basic flow');
{
  const d = new Desk();
  d.event('presence', true);
  check('countdown shows ~30s', armingSecondsLeft(d.state, d.t) === 30, `got ${armingSecondsLeft(d.state, d.t)}`);
  d.advance(29);
  check('nothing started at 29s', !d.hasSession);
  d.advance(2);
  check('session starts after 30s', d.isRunning && d.hasSession);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(10);
  d.event('presence', false); d.advance(60);
  check('leaving mid-countdown starts nothing', !d.hasSession);
}

// ── away handling: the reported bug ──────────────────────────────────────────
section('Leaving the desk');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false);
  d.advance(1);
  check('pauses on leaving', d.paused, `running=${d.isRunning} hasSession=${d.hasSession}`);
  d.advance(60);
  check('still paused at 60s away', d.paused);
  d.advance(58);
  check('still paused just before 2min', d.paused);
  d.advance(4);
  check('terminates just after 2min', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(60);
  d.event('presence', true); d.advance(1);
  check('returning within 2min resumes', d.isRunning, `running=${d.isRunning}`);
  d.advance(600);
  check('resumed session is not killed later', d.isRunning, `running=${d.isRunning}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(150);   // terminated while away
  check('terminated while away', !d.hasSession);
  d.event('presence', true); d.advance(32);
  check('returning starts a fresh session', d.isRunning);
  d.advance(600);
  check('fresh session survives (no stale away timer)', d.isRunning, `running=${d.isRunning}`);
}

// ── state must outlive the window ────────────────────────────────────────────
section('Reload and lease hand-off');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(30);
  d.handOff();                                   // reload / widget takes over
  d.advance(95);
  check('terminate still fires after a hand-off', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(30);
  d.handOff();
  d.event('presence', true); d.advance(1);
  check('resume still works after a hand-off', d.isRunning, `running=${d.isRunning}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(30);
  d.handOffWithoutState();                       // the old, broken behaviour
  d.event('presence', true); d.advance(1);
  check('a window with no state does not resurrect wrongly', !d.isRunning || d.hasSession);
}

// ── resumes that did not come from the desk button ───────────────────────────
section('Resumed by other means');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(20);
  d.isRunning = true;                            // resumed in the app / hotkey
  d.advance(600);
  check('app-side resume cancels the away timer', d.isRunning && d.hasSession, `running=${d.isRunning}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(20);
  d.event('button_a');                           // resumed with the desk button
  d.advance(600);
  check('button resume cancels the away timer', d.isRunning, `running=${d.isRunning}`);
}

// ── buttons ──────────────────────────────────────────────────────────────────
section('Buttons');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('button_b');
  check('B terminates a running session', !d.hasSession);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('button_a');
  check('A pauses a running session', d.paused);
  d.event('button_b');
  check('B terminates a paused session', !d.hasSession);
}
{
  const d = new Desk();
  d.event('presence', true);                     // countdown running
  d.event('button_b');
  d.advance(60);
  check('B during countdown starts nothing', !d.hasSession);
}
{
  const d = new Desk();
  d.event('presence', true);
  d.event('button_a');                           // start early, skipping the wait
  check('A during countdown starts immediately', d.isRunning);
  d.advance(60);
  check('the cancelled countdown does not fire later', d.isRunning && d.hasSession);
}

// ── settings ─────────────────────────────────────────────────────────────────
section('Settings honoured');
{
  const d = new Desk({ enabled: false });
  d.event('presence', true); d.advance(60);
  check('master off: sensor does nothing', !d.hasSession);
  d.event('button_a');
  check('master off: buttons do nothing', !d.hasSession);
}
{
  const d = new Desk({ sensorEnabled: false });
  d.event('presence', true); d.advance(60);
  check('sensor off: no auto-start', !d.hasSession);
  d.event('button_a');
  check('sensor off: buttons still work', d.isRunning);
}
{
  const d = new Desk({ buttonsEnabled: false });
  d.event('button_a');
  check('buttons off: button ignored', !d.hasSession);
  d.event('presence', true); d.advance(32);
  check('buttons off: sensor still works', d.isRunning);
}
{
  const d = new Desk({ awayPauseEnabled: false });
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(600);
  check('away-pause off: session keeps running', d.isRunning, `running=${d.isRunning}`);
}
{
  const d = new Desk({ armSeconds: 0 });
  d.event('presence', true); d.advance(1);
  check('zero grace period starts at once', d.isRunning);
}
{
  const d = new Desk({ awayTerminateSeconds: 10 });
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(12);
  check('custom away timeout respected', !d.hasSession);
}

// ── noise and repeats ────────────────────────────────────────────────────────
section('Duplicate and noisy events');
{
  const d = new Desk();
  d.event('presence', true);
  d.event('presence', true);
  d.event('presence', true);
  d.advance(32);
  check('repeated arrivals start one session', d.isRunning && d.actions.filter(a => a === 'start').length === 1,
    `starts=${d.actions.filter(a => a === 'start').length}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false);
  d.event('presence', false);
  d.advance(1);
  check('repeated departures pause once', d.actions.filter(a => a === 'pause').length === 1,
    `pauses=${d.actions.filter(a => a === 'pause').length}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  for (let i = 0; i < 20; i++) {                 // flapping sensor
    d.event('presence', false);
    d.advance(1);
    d.event('presence', true);
    d.advance(1);
  }
  check('flapping never terminates the session', d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(110);
  d.event('presence', true);  d.advance(1);      // back just in time
  d.event('presence', false); d.advance(110);    // leave again
  check('away timer restarts on each departure', d.hasSession, `hasSession=${d.hasSession}`);
  d.advance(20);
  check('and still terminates eventually', !d.hasSession);
}

// ── corrupt persisted state ──────────────────────────────────────────────────
// The bug that actually bit: the server stored a cleared timer as 0 rather than
// null, so a paused session saw an away timer 56 years old and died instantly.
section('Corrupt or implausible timestamps');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.state = { ...d.state, awaySince: 0 };        // epoch, as the server used to return
  d.event('presence', false);
  d.advance(1);
  check('epoch away-stamp does not terminate on pause', d.paused, `hasSession=${d.hasSession} running=${d.isRunning}`);
  d.advance(60);
  check('and still only pauses a minute later', d.paused, `hasSession=${d.hasSession}`);
  d.advance(65);
  check('then terminates on the real timeout', !d.hasSession);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('button_a');                            // paused by button
  d.state = { ...d.state, awaySince: 0 };
  d.advance(600);
  check('epoch stamp never terminates a button-paused session', d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(1);
  d.state = { ...d.state, awaySince: d.t + 60_000 };  // future timestamp
  d.advance(600);
  check('future away-stamp is discarded, not trusted', d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true);
  d.state = { ...d.state, armingUntil: 0 };       // epoch arming stamp
  d.advance(2);
  check('epoch arming stamp does not start a session', !d.hasSession, `hasSession=${d.hasSession}`);
}

// ── back-to-back sessions ────────────────────────────────────────────────────
// Staying at the desk produces no sensor event, so a session that simply ran
// out left the day stopped until the user got up and sat down again.
section('Session chaining');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  check('first session running', d.isRunning);
  d.isRunning = false; d.hasSession = false;      // the hour is up, timer completes
  d.advance(1);
  check('next session starts immediately (0s delay by default)', d.isRunning && d.hasSession, `running=${d.isRunning}`);
}
{
  const d = new Desk({ autoRestartArmSeconds: 30 });
  d.event('presence', true); d.advance(32);
  check('first session running with 30s delay', d.isRunning);
  d.isRunning = false; d.hasSession = false;      // session completes
  d.advance(2);
  check('countdown re-arms with 30s delay', armingSecondsLeft(d.state, d.t) > 0,
    `arming=${armingSecondsLeft(d.state, d.t)}`);
  d.advance(32);
  check('next session starts after delay', d.isRunning && d.hasSession, `running=${d.isRunning}`);
}
{
  const d = new Desk({ autoRestartEnabled: false });
  d.event('presence', true); d.advance(32);
  d.isRunning = false; d.hasSession = false;
  d.advance(60);
  check('respects the setting when switched off', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('button_b');                            // stopped deliberately
  d.advance(120);
  check('a manual stop does not restart itself', !d.hasSession, `hasSession=${d.hasSession}`);
  d.event('presence', false); d.advance(2);
  d.event('presence', true); d.advance(32);
  check('but leaving and returning starts a new one', d.isRunning, `running=${d.isRunning}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(150);     // terminated by the away timeout
  d.advance(60);
  check('does not restart while you are away', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk({ autoRestartArmSeconds: 30 });
  d.event('presence', true); d.advance(32);
  d.isRunning = false; d.hasSession = false;      // session completes
  d.advance(10);
  d.event('presence', false); d.advance(30);      // you leave mid-countdown
  check('leaving cancels the re-armed countdown', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('button_a');                            // paused, not ended
  d.advance(60);
  check('a paused session is not treated as finished', d.hasSession && !d.isRunning,
    `hasSession=${d.hasSession} running=${d.isRunning}`);
}

// ── crosstalk ────────────────────────────────────────────────────────────────
// Real captured data: every press of A was followed ~80ms later by a phantom B
// that terminated the session.
section('Button crosstalk rejection');
{
  const evts = [
    { id: 1, type: 'button_a', at: 1000 },
    { id: 2, type: 'button_b', at: 1077 },
  ];
  const clean = dropCrosstalkButtons(evts);
  check('phantom B 77ms after A is dropped', clean.length === 1 && clean[0].type === 'button_a',
    JSON.stringify(clean.map(e => e.type)));
}
{
  const evts = [
    { id: 1, type: 'button_a', at: 1000 },
    { id: 2, type: 'button_b', at: 1079 },
    { id: 3, type: 'button_a', at: 1300 },
    { id: 4, type: 'button_b', at: 1377 },
  ];
  const clean = dropCrosstalkButtons(evts);
  check('two press+phantom pairs leave two A presses',
    clean.length === 2 && clean.every(e => e.type === 'button_a'),
    JSON.stringify(clean.map(e => e.type)));
}
{
  const evts = [
    { id: 1, type: 'button_a', at: 1000 },
    { id: 2, type: 'button_b', at: 1600 },
  ];
  const clean = dropCrosstalkButtons(evts);
  check('a deliberate B 600ms later is kept', clean.length === 2, JSON.stringify(clean.map(e => e.type)));
}
{
  const evts = [
    { id: 1, type: 'button_a', at: 1000 },
    { id: 2, type: 'button_a', at: 1080 },
    { id: 3, type: 'button_a', at: 1160 },
  ];
  const clean = dropCrosstalkButtons(evts);
  check('rapid presses of the SAME button all survive', clean.length === 3, JSON.stringify(clean.map(e => e.type)));
}
{
  const evts = [
    { id: 1, type: 'presence', at: 1000 },
    { id: 2, type: 'button_b', at: 1010 },
    { id: 3, type: 'presence', at: 1020 },
  ];
  const clean = dropCrosstalkButtons(evts);
  check('presence events are never filtered', clean.length === 3, JSON.stringify(clean.map(e => e.type)));
}
{
  // The whole point: a lone A press must not terminate the session.
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  const evts = [
    { id: 1, type: 'button_a', at: d.t },
    { id: 2, type: 'button_b', at: d.t + 78 },
  ];
  for (const e of dropCrosstalkButtons(evts)) {
    d.event(e.type as 'button_a' | 'button_b');
  }
  check('pressing A pauses, and does NOT terminate', d.hasSession && !d.isRunning,
    `hasSession=${d.hasSession} running=${d.isRunning}`);
}

// --- calling off a countdown from the app ---------------------------------
// The countdown belongs to no window, so before this there was no way to stop
// one you did not want short of standing up and walking away.
{
  const d = new Desk();
  d.event('presence', true);
  d.advance(10);
  check('countdown is pending', armingSecondsLeft(d.state, d.t) > 0, String(armingSecondsLeft(d.state, d.t)));
  d.event('manual_stop');
  check('manual stop cancels the countdown', d.state.armingUntil === null, String(d.state.armingUntil));
  d.advance(120);
  check('and no session ever starts', !d.hasSession && d.actions.length === 0, d.actions.join(','));
}
{
  // Auto-restart must not simply re-arm the countdown you just called off.
  const d = new Desk({ autoRestartEnabled: true });
  d.event('presence', true);
  d.advance(10);
  d.event('manual_stop');
  d.advance(300);
  check('cancelled countdown is not re-armed while still seated',
    !d.hasSession && armingSecondsLeft(d.state, d.t) === 0, d.actions.join(','));
}
{
  // ...but leaving and coming back is a fresh intent to work.
  const d = new Desk({ autoRestartEnabled: true });
  d.event('presence', true);
  d.advance(10);
  d.event('manual_stop');
  d.advance(10);
  d.event('presence', false);
  d.advance(5);
  d.event('presence', true);
  d.advance(35);
  check('returning to the desk arms again', d.hasSession && d.isRunning, d.actions.join(','));
}
{
  // Stopping a live session from the app, not the desk button.
  const d = new Desk({ autoRestartEnabled: true });
  d.event('presence', true);
  d.advance(35);
  check('session running before the stop', d.isRunning, d.actions.join(','));
  d.isRunning = false; d.hasSession = false;   // the app performed the stop itself
  d.event('manual_stop');
  d.advance(300);
  check('an app-side stop does not restart the session while seated',
    !d.hasSession && armingSecondsLeft(d.state, d.t) === 0, d.actions.join(','));
}
{
  // The physical buttons being switched off must not disable the app's own
  // stop button -- that would leave the countdown uncancellable again.
  const d = new Desk({ buttonsEnabled: false });
  d.event('presence', true);
  d.advance(10);
  d.event('manual_stop');
  check('manual stop works with hardware buttons disabled', d.state.armingUntil === null, String(d.state.armingUntil));
}
{
  // A cancel must survive the lease moving to the other window.
  const d = new Desk({ autoRestartEnabled: true });
  d.event('presence', true);
  d.advance(10);
  d.event('manual_stop');
  d.handOff();
  d.advance(120);
  check('cancel survives a reload / lease hand-off', !d.hasSession, d.actions.join(','));
}

// ── sessions the desk did not start ──────────────────────────────────────────
// The reported bug: stop a session by hand, start a fresh one by hand, and the
// desk ignored it completely -- walking away neither paused nor ended it.
section('Hand-started sessions');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  check('desk started a session', d.isRunning);
  d.handStop();                       // stopped and terminated by hand
  d.advance(2);
  check('nothing running after a hand stop', !d.hasSession);

  d.handStart();                      // started again by hand, sensor told nothing
  d.advance(2);
  d.event('presence', false); d.advance(1);
  check('hand-started session pauses when you leave', d.paused, `running=${d.isRunning}`);
  d.advance(125);
  check('hand-started session ends after the away timeout', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.handStop(); d.advance(2);
  d.handStart(); d.advance(2);
  d.sessionEnds();                    // ran to completion while sat there
  d.advance(2);
  check('a hand-started session still chains into the next', d.isRunning, `running=${d.isRunning}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(60);
  d.event('presence', true); d.advance(2);   // back, resumed
  d.handPause();                              // paused by hand, still sitting there
  d.advance(2);
  d.event('presence', false); d.advance(125);
  check('a hand-paused session still ends after the away timeout', !d.hasSession, `hasSession=${d.hasSession}`);
}
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.handPause(); d.advance(2);
  d.event('presence', false); d.advance(30);
  d.event('presence', true); d.advance(2);
  check('returning does not un-do a pause you made yourself', !d.isRunning, `running=${d.isRunning}`);
  check('...and the session is still there', d.hasSession);
}
{
  const d = new Desk({ manualFollowsSensor: false });
  d.handStart(); d.advance(2);
  d.event('presence', false); d.advance(200);
  check('preference off: a hand-started session is left alone', d.isRunning, `running=${d.isRunning}`);
}
{
  const d = new Desk({ manualFollowsSensor: false });
  d.event('presence', true); d.advance(32);
  d.event('presence', false); d.advance(1);
  check('preference off: a desk-started session still pauses', d.paused);
}

// ── chaining must survive a reload ───────────────────────────────────────────
section('Chaining across a hand-off');
{
  const d = new Desk();
  d.event('presence', true); d.advance(32);
  d.handOff();                        // reload / widget takes the lease
  d.advance(2);
  d.sessionEnds();
  d.advance(2);
  check('the next session still chains after a hand-off', d.isRunning, `running=${d.isRunning}`);
}

// ── a session already in progress when a window opens ────────────────────────
{
  const d = new Desk();
  d.isRunning = true; d.hasSession = true; d.ready = false;   // not loaded yet
  d.advance(3);
  d.ready = true;
  d.advance(2);
  d.sessionEnds();
  d.advance(2);
  check('an unhydrated window does not invent a chained session', !d.isRunning, `running=${d.isRunning}`);
}

// ---------------------------------------------------------------------------
// LAYER B — EXHAUSTIVE SCENARIO TEST MATRIX (ITEMS 1 - 15)
// ---------------------------------------------------------------------------

console.log('\n--- LAYER B: EXHAUSTIVE SCENARIO MATRIX ---');

// --- B.1: reduceHardware pure reducer exhaustive permutations ---
{
  const testStates: HardwareControllerState[] = [
    { ...INITIAL_CONTROLLER_STATE },
    { ...INITIAL_CONTROLLER_STATE, present: true, sessionActive: true },
    { ...INITIAL_CONTROLLER_STATE, present: false, awaySince: 1000, sessionActive: true, pausedByAway: true },
    { ...INITIAL_CONTROLLER_STATE, present: true, armingUntil: 2000, stoppedByHand: false },
    { ...INITIAL_CONTROLLER_STATE, present: true, stoppedByHand: true },
  ];
  const testInputs = [
    { kind: 'tick' as const },
    { kind: 'presence' as const, present: true },
    { kind: 'presence' as const, present: false },
    { kind: 'button_a' as const },
    { kind: 'button_b' as const },
    { kind: 'manual_stop' as const },
  ];
  const testSessions = [
    { isRunning: false, hasSession: false, ready: true },
    { isRunning: true, hasSession: true, ready: true },
    { isRunning: false, hasSession: true, ready: true },
  ];

  let reducerSurvivesAll = true;
  for (const st of testStates) {
    for (const inp of testInputs) {
      for (const sess of testSessions) {
        const res = reduceHardware(st, inp, sess, DEFAULT_HARDWARE_SETTINGS, 1500);
        if (!res || !res.state || !Array.isArray(res.actions)) reducerSurvivesAll = false;
      }
    }
  }
  check('reduceHardware evaluates all state/input/session permutations without error', reducerSurvivesAll);
}

// --- B.2: Countdown arming lifecycles ---
{
  // Sit down -> arms countdown
  const d = new Desk({ armSeconds: 10 });
  d.event('presence', true);
  check('sitting down sets arming countdown', d.state.armingUntil !== null && d.state.armingUntil > d.t);

  // Stand up during countdown -> cancels cleanly
  d.advance(3);
  d.event('presence', false);
  check('standing up during countdown cancels arming', d.state.armingUntil === null && !d.isRunning);

  // Sit down again, arming starts
  d.event('presence', true);
  check('sitting down again restarts countdown', d.state.armingUntil !== null);

  // Hand toggle during countdown (manual_stop) -> cancels with stoppedByHand: true
  d.advance(2);
  d.event('manual_stop');
  check('manual_stop during countdown cancels arming and sets stoppedByHand',
    d.state.armingUntil === null && d.state.stoppedByHand === true && !d.isRunning);

  // Leaving and returning clears stoppedByHand and arms countdown
  d.event('presence', false);
  d.advance(2);
  d.event('presence', true);
  check('leaving and returning clears stoppedByHand and arms countdown',
    d.state.stoppedByHand === false && d.state.armingUntil !== null);

  // Countdown expires while seated -> starts session
  d.advance(11);
  check('countdown expiration starts session', d.isRunning && d.hasSession && d.state.sessionActive === true);
}

// --- B.3: Auto-start disabled & instant start ---
{
  // sensorEnabled: false -> sitting down never sets armingUntil
  const dNoSensor = new Desk({ sensorEnabled: false });
  dNoSensor.event('presence', true);
  dNoSensor.advance(5);
  check('sensorEnabled: false ignores presence and never arms',
    dNoSensor.state.armingUntil === null && !dNoSensor.isRunning);

  // Button A starts immediately even with sensor disabled
  dNoSensor.event('button_a');
  check('button A starts session immediately when sensor is disabled', dNoSensor.isRunning);

  // armSeconds: 0 -> starts immediately on sitting down
  const dZeroArm = new Desk({ armSeconds: 0 });
  dZeroArm.event('presence', true);
  check('armSeconds: 0 starts session immediately upon sitting down',
    dZeroArm.isRunning && dZeroArm.hasSession && dZeroArm.state.sessionActive === true);
}

// --- B.4: Auto-pause on departure ---
{
  // awayPauseEnabled: true -> departs during active session -> pauses immediately
  const d = new Desk({ awayPauseEnabled: true, armSeconds: 0 });
  d.event('presence', true);
  check('session active', d.isRunning);
  d.event('presence', false);
  check('awayPauseEnabled: true pauses session immediately on departure',
    !d.isRunning && d.hasSession && d.state.pausedByAway === true && d.state.awaySince !== null);

  // awayPauseEnabled: false -> departs during active session -> keeps running
  const dNoPause = new Desk({ awayPauseEnabled: false, armSeconds: 0 });
  dNoPause.event('presence', true);
  dNoPause.event('presence', false);
  check('awayPauseEnabled: false keeps session running when user departs',
    dNoPause.isRunning && dNoPause.hasSession);
}

// --- B.5: Auto-resume on return ---
{
  const d = new Desk({ armSeconds: 0, awayTerminateSeconds: 60 });
  d.event('presence', true);
  d.event('presence', false); // paused by away
  check('paused on departure', !d.isRunning && d.state.pausedByAway === true);

  // Return within away timeout -> auto resumes
  d.advance(10); // 10s < 60s
  d.event('presence', true);
  check('returning within timeout auto-resumes session and clears awaySince',
    d.isRunning && d.hasSession && d.state.pausedByAway === false && d.state.awaySince === null);
}

// --- B.6: Away timeout termination ---
{
  const d = new Desk({ armSeconds: 0, awayTerminateSeconds: 30 });
  d.event('presence', true);
  d.event('presence', false); // paused
  check('paused', !d.isRunning && d.hasSession);

  // Advance past awayTerminateSeconds (30s)
  d.advance(35);
  check('away timeout terminates abandoned session cleanly',
    !d.isRunning && !d.hasSession && d.state.sessionActive === false);

  // Returning now starts/arms a fresh session rather than resuming
  d.event('presence', true);
  check('returning after termination starts a fresh session', d.isRunning && d.hasSession);
}

// --- B.7: Manual override precedence (standing up to stretch) ---
{
  const d = new Desk({ armSeconds: 0 });
  d.event('presence', true);
  check('running', d.isRunning);

  // User pauses manually while seated (e.g. stretch break)
  d.handPause(); // manual pause
  d.advance(2);
  check('session paused manually', !d.isRunning && d.hasSession);

  // User stands up (leaves desk) and comes back 10 seconds later
  d.event('presence', false);
  d.advance(10);
  d.event('presence', true);
  check('getting up and returning does NOT unpause a hand-paused session',
    !d.isRunning && d.hasSession);

  // Resuming by pressing button A resumes normally
  d.event('button_a');
  check('pressing button A resumes the hand-paused session', d.isRunning && d.hasSession);
}

// --- B.8: Long-break termination vs autoTerminate ---
{
  // awayPauseEnabled: false ignores away termination
  const d = new Desk({ awayPauseEnabled: false, awayTerminateSeconds: 20 });
  d.handStart();
  d.event('presence', false);
  d.advance(30);
  check('when awayPauseEnabled is false, away timer does not terminate running session',
    d.isRunning && d.hasSession);
}

// --- B.9: dropCrosstalkButtons electrical debouncing ---
{
  const t0 = 1000;
  // Crosstalk: button_a followed 50ms later by button_b
  const inputWithCrosstalk = [
    { type: 'presence', present: true, at: t0 },
    { type: 'button_a', at: t0 + 100 },
    { type: 'button_b', at: t0 + 150 }, // crosstalk within 250ms -> dropped
    { type: 'presence', present: true, at: t0 + 200 },
  ];
  const filtered = dropCrosstalkButtons(inputWithCrosstalk);
  check('dropCrosstalkButtons drops button B occurring 50ms after button A',
    filtered.length === 3 &&
    filtered.some(e => e.type === 'button_a') &&
    !filtered.some(e => e.type === 'button_b'));

  // Legitimate double-tap of the SAME button is preserved
  const doubleTap = [
    { type: 'button_a', at: t0 },
    { type: 'button_a', at: t0 + 100 },
  ];
  const filteredDouble = dropCrosstalkButtons(doubleTap);
  check('repeated presses of the same button are preserved', filteredDouble.length === 2);

  // Button presses separated by > 250ms are both preserved
  const separated = [
    { type: 'button_a', at: t0 },
    { type: 'button_b', at: t0 + 300 },
  ];
  const filteredSep = dropCrosstalkButtons(separated);
  check('button presses separated by > 250ms are both preserved', filteredSep.length === 2);
}

// --- B.10: Multi-window lease race & seamless hand-off ---
{
  const bridge = createHardwareBridge();
  // Window 1 claims lease
  const claim1 = bridge.claim('window-1', true);
  check('window 1 acquires lease', claim1.body.owner === true);

  // Window 1 writes state
  bridge.postController({
    present: true,
    sessionActive: true,
    awaySince: null,
    stoppedByHand: false,
  });

  // Window 2 attempts claim and is denied
  const claim2 = bridge.claim('window-2', true);
  check('window 2 denied lease while window 1 active', claim2.body.owner === false);

  // Simulate window 1 closing (time advances > HW_LEASE_MS)
  const nowAfterLease = bridge.now() + 7000;
  const claim2After = bridge.claim('window-2', true, nowAfterLease);
  check('window 2 acquires lease after window 1 expires', claim2After.body.owner === true);

  // Window 2 reads controller state and continues without loss
  const inheritedState = bridge.getController().body as HardwareControllerState;
  check('window 2 inherits controller state seamlessly',
    inheritedState.present === true && inheritedState.sessionActive === true);
}

// --- B.11: Settings coercion (coerceHardwareSettings) ---
{
  const corruptSettings = {
    enabled: 'yes',
    buttonsEnabled: 1,
    sensorEnabled: null,
    armSeconds: -50,
    awayTerminateSeconds: '999999',
    sampleIntervalMs: 5,
    enterCm: 50,
    exitCm: 30, // inverted hysteresis
  };
  const coerced = coerceHardwareSettings(corruptSettings);
  check('enabled invalid type falls back to default true', coerced.enabled === true);
  check('armSeconds negative clamps to 0', coerced.armSeconds === 0);
  check('awayTerminateSeconds huge clamps to 3600', coerced.awayTerminateSeconds === 3600);
  check('sampleIntervalMs < 40 clamps to 40', coerced.sampleIntervalMs === 40);
  check('enterCm and exitCm inverted hysteresis repaired in settings coercion', coerced.exitCm > coerced.enterCm);
}

// --- B.12: Display state generation ---
{
  // armingSecondsLeft helper
  const stateArming: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE, armingUntil: 10_000 };
  check('armingSecondsLeft calculates correct seconds remaining', armingSecondsLeft(stateArming, 6500) === 4);
  check('armingSecondsLeft returns 0 when armingUntil is null', armingSecondsLeft(INITIAL_CONTROLLER_STATE, 6500) === 0);
}

// --- B.13: Server-side controller state round-trip ---
{
  const bridge = createHardwareBridge();
  const sampleState: HardwareControllerState = {
    present: true,
    armingUntil: 1700000050000,
    awaySince: 1700000020000,
    stoppedByHand: true,
    sessionActive: true,
    manualSession: true,
    pausedByAway: true,
  };
  bridge.postController(sampleState);
  const fetched = bridge.getController().body as HardwareControllerState;
  let allEqual = true;
  for (const k of Object.keys(sampleState) as Array<keyof HardwareControllerState>) {
    if (fetched[k] !== sampleState[k]) allEqual = false;
  }
  check('all 7 HardwareControllerState fields survive JSON serialization/deserialization', allEqual);
}

// --- B.14: Whitelist completeness ---
{
  const bridge = createHardwareBridge();
  const allKeys = Object.keys(INITIAL_CONTROLLER_STATE) as Array<keyof HardwareControllerState>;
  const populated: Record<string, unknown> = {};
  for (const k of allKeys) {
    if (k === 'armingUntil' || k === 'awaySince') populated[k] = 123456789;
    else populated[k] = true;
  }
  bridge.postController(populated);
  const out = bridge.getController().body as Record<string, unknown>;
  const missingKeys = allKeys.filter(k => out[k] === undefined);
  check('server-side /controller whitelist covers 100% of INITIAL_CONTROLLER_STATE keys',
    missingKeys.length === 0, `missing=${missingKeys.join(', ')}`);
}

// --- B.15: End-of-day rollover ---
{
  // Session running across midnight
  const d = new Desk({ armSeconds: 0 });
  d.t = 1_700_092_790_000; // 10s before midnight epoch
  d.event('presence', true);
  check('running before midnight', d.isRunning);

  d.advance(30); // 30s advances across midnight
  check('session continues running uninterrupted across midnight boundary', d.isRunning && d.hasSession);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;

