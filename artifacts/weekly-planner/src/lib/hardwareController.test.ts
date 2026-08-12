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
  armingSecondsLeft,
  type HardwareAction,
  type HardwareControllerState,
  type HardwareSettings,
} from './hardwareController';

/**
 * Stands in for the hook plus the app's focus timer. Ticks at the real poll
 * rate, and mirrors the rule that a cycle carrying events does not also tick
 * (the session snapshot has not settled yet at that point).
 */
class Desk {
  state: HardwareControllerState = { ...INITIAL_CONTROLLER_STATE };
  isRunning = false;
  hasSession = false;
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

  private run(kind: 'presence' | 'button_a' | 'button_b' | 'tick', present?: boolean) {
    const r = reduceHardware(
      this.state,
      { kind, present },
      { isRunning: this.isRunning, hasSession: this.hasSession },
      this.settings,
      this.t,
    );
    this.state = r.state;
    this.saved = { ...r.state };  // owner persists every cycle
    this.apply(r.actions);
  }

  event(kind: 'presence' | 'button_a' | 'button_b', present?: boolean) { this.run(kind, present); }

  /** Advances time in poll-sized steps. */
  advance(seconds: number) {
    for (let i = 0; i < seconds * 2; i++) {
      this.t += 500;
      this.run('tick');
    }
  }

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
