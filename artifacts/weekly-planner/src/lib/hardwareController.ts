// ---------------------------------------------------------------------------
// ESP32 focus-timer controller.
//
// An ESP32 on the desk drives a 16x2 LCD, two buttons and an ultrasonic
// presence sensor. The firmware is deliberately dumb: it posts raw button
// edges and raw centimetres, and renders whatever numbers it is handed. The
// dev server turns the distance stream into presence (see sensorFilter.ts),
// and everything below turns those events into the same start/pause/terminate
// calls the on-screen buttons make, so hardware and UI can never diverge.
//
// The decision logic is a pure reducer. Both windows run it, but only the one
// holding the server lease acts on the result -- see useHardwareController.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';

import { coerceSensorFilterConfig, DEFAULT_SENSOR_FILTER_CONFIG, type SensorFilterConfig } from './sensorFilter';

/**
 * The tuning the presence filter reads. Listed here as a type rather than
 * duplicated, so adding a knob in sensorFilter.ts cannot leave the settings
 * page and the dev server disagreeing about what exists.
 */
export type HardwareSensorSettings = SensorFilterConfig;

export interface HardwareSettings extends HardwareSensorSettings {
  /** Master switch. Off = the ESP32 is ignored entirely. */
  enabled: boolean;
  /** Physical buttons may control the session. */
  buttonsEnabled: boolean;
  /** The ultrasonic sensor may start/pause/terminate sessions on its own. */
  sensorEnabled: boolean;
  /** Grace period after sitting down before a session actually starts. */
  armSeconds: number;
  /** Leaving the desk pauses a running session. */
  awayPauseEnabled: boolean;
  /** Sessions you start yourself -- the on-screen button, the system-wide
   *  hotkey, the phone -- are governed by the sensor exactly like ones the desk
   *  started. Off = a hand-started session is the sensor's business no longer,
   *  until you leave and come back. */
  manualFollowsSensor: boolean;
  /** When a session finishes and you are still at the desk, start or arm the next one.
   *  Without it the day stops after the first session, since staying put
   *  produces no sensor event to react to. */
  autoRestartEnabled: boolean;
  /** Grace period before automatically starting the next session when chaining (seconds).
   *  0 = start immediately with no delay. */
  autoRestartArmSeconds: number;
  /** How long you may stay away before the paused session is terminated. */
  awayTerminateSeconds: number;

  // ── Sensor tuning ──────────────────────────────────────────────────────────
  // Everything the presence filter reads is inherited from SensorFilterConfig
  // above. It lives in the app's settings rather than the firmware because the
  // firmware no longer decides anything: it pings and posts raw centimetres,
  // and the dev server turns the stream into presence (see sensorFilter.ts).

  /** Milliseconds between ultrasonic pings. The one number the board itself
   *  still needs, since it is the thing doing the pinging. */
  sampleIntervalMs: number;
  /** While true the settings page polls the live readout quickly. */
  calibrating: boolean;
  /** Re-announce presence when an app window first becomes reachable. The
   *  board is usually up long before the PC has finished booting, so without
   *  this, sitting at an already-occupied desk starts nothing until you get up
   *  and sit back down. */
  announceOnConnect: boolean;
}

/** The subset of settings the presence filter is configured from. */
export const SENSOR_FILTER_KEYS = Object.keys(DEFAULT_SENSOR_FILTER_CONFIG) as Array<keyof SensorFilterConfig>;

export function sensorFilterConfigOf(s: HardwareSettings): SensorFilterConfig {
  const out: Record<string, unknown> = {};
  for (const k of SENSOR_FILTER_KEYS) out[k] = s[k];
  return out as unknown as SensorFilterConfig;
}

export const DEFAULT_HARDWARE_SETTINGS: HardwareSettings = {
  ...DEFAULT_SENSOR_FILTER_CONFIG,
  enabled: true,
  buttonsEnabled: true,
  sensorEnabled: true,
  armSeconds: 30,
  awayPauseEnabled: true,
  manualFollowsSensor: true,
  autoRestartEnabled: true,
  autoRestartArmSeconds: 0,
  awayTerminateSeconds: 120,
  sampleIntervalMs: 100,
  calibrating: false,
  announceOnConnect: true,
};

export function coerceHardwareSettings(raw: unknown): HardwareSettings {
  const s = { ...DEFAULT_HARDWARE_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;

  if (typeof r.enabled === 'boolean') s.enabled = r.enabled;
  if (typeof r.buttonsEnabled === 'boolean') s.buttonsEnabled = r.buttonsEnabled;
  if (typeof r.sensorEnabled === 'boolean') s.sensorEnabled = r.sensorEnabled;
  if (typeof r.awayPauseEnabled === 'boolean') s.awayPauseEnabled = r.awayPauseEnabled;
  if (typeof r.manualFollowsSensor === 'boolean') s.manualFollowsSensor = r.manualFollowsSensor;
  if (typeof r.autoRestartEnabled === 'boolean') s.autoRestartEnabled = r.autoRestartEnabled;
  // Clamped rather than rejected: a nonsensical value should degrade to a sane
  // one, not silently disable the feature.
  if (Number.isFinite(Number(r.armSeconds))) s.armSeconds = Math.max(0, Math.min(300, Math.round(Number(r.armSeconds))));
  if (Number.isFinite(Number(r.autoRestartArmSeconds))) {
    s.autoRestartArmSeconds = Math.max(0, Math.min(300, Math.round(Number(r.autoRestartArmSeconds))));
  }
  if (Number.isFinite(Number(r.awayTerminateSeconds))) {
    s.awayTerminateSeconds = Math.max(10, Math.min(3600, Math.round(Number(r.awayTerminateSeconds))));
  }

  if (typeof r.calibrating === 'boolean') s.calibrating = r.calibrating;
  if (typeof r.announceOnConnect === 'boolean') s.announceOnConnect = r.announceOnConnect;
  if (Number.isFinite(Number(r.sampleIntervalMs))) {
    s.sampleIntervalMs = Math.max(40, Math.min(2000, Math.round(Number(r.sampleIntervalMs))));
  }

  // Every filter knob is clamped by the filter's own coercion, so the rules
  // that keep the thresholds coherent (hysteresis, the implausibility line
  // sitting outside both) live in exactly one place.
  Object.assign(s, coerceSensorFilterConfig(r as Partial<SensorFilterConfig>));

  return s;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface HardwareControllerState {
  /** Last confirmed presence reading from the sensor. */
  present: boolean;
  /** Epoch ms at which the arming countdown fires, or null when not arming. */
  armingUntil: number | null;
  /** Epoch ms at which we paused because you left, or null. */
  awaySince: number | null;
  /** Set when you stop a session yourself. Sitting at the desk normally arms a
   *  new one, which would otherwise restart the session you just deliberately
   *  ended. Cleared by actually leaving and coming back. */
  stoppedByHand: boolean;
  /** True while a session is active. Used to distinguish a finished session (which
   *  chains with autoRestartArmSeconds) from a fresh arrival (which uses armSeconds). */
  sessionActive?: boolean;
  /** The session now in progress was not started by this controller -- it came
   *  from the on-screen button, the system-wide hotkey or the phone. Tracked so
   *  the desk can adopt it rather than ignore it, and so the one preference
   *  that says otherwise has something to key off. */
  manualSession?: boolean;
  /** The session is paused because the sensor saw you leave, as opposed to you
   *  pausing it yourself. Only the former should be resumed on your return. */
  pausedByAway?: boolean;
}

export const INITIAL_CONTROLLER_STATE: HardwareControllerState = {
  present: false,
  armingUntil: null,
  awaySince: null,
  stoppedByHand: false,
  sessionActive: false,
  manualSession: false,
  pausedByAway: false,
};

/** What the reducer wants done, expressed in the app's own vocabulary. */
export type HardwareAction = 'start' | 'pause' | 'resume' | 'terminate' | 'toggle';

export interface SessionSnapshot {
  /** The focus timer is counting right now. */
  isRunning: boolean;
  /** A session exists (running or paused) rather than a clean slate. */
  hasSession: boolean;
  /** False until the window has actually loaded the timer. Before that
   *  `hasSession` is a guess, and adopting a session on a guess would flag a
   *  perfectly ordinary desk-started session as hand-started. */
  ready?: boolean;
}

export interface HardwareInput {
  /**
   * `manual_stop` is you calling the session off from the app itself -- the
   * stop button, or the system-wide hotkey pressed during the countdown. The
   * app has already done whatever needed doing; this only tells the controller
   * that the decision was yours.
   */
  kind: 'presence' | 'button_a' | 'button_b' | 'manual_stop' | 'tick';
  present?: boolean;
}

export interface ReducerResult {
  state: HardwareControllerState;
  actions: HardwareAction[];
}

/** The sensor's standing verdict, mirrored from the bridge on every poll. */
export interface PresenceLevel {
  present: boolean;
  ready: boolean;
  /** When the board last spoke. Older than SENSOR_SILENT_MS and it has not. */
  at: number;
}

/**
 * How long the board may go quiet before its verdict stops meaning anything.
 *
 * It reports every ~100ms in batches, so a couple of seconds of silence is a
 * hiccup and ten is the board being gone. A verdict from a sensor that is no
 * longer talking must not be used to correct anything: unplug the board while
 * you are sitting there and the last thing it said would otherwise keep
 * re-arming a session for as long as the server stays up.
 */
export const SENSOR_SILENT_MS = 10_000;

/**
 * Notice that the controller and the sensor disagree, and say so as an input.
 *
 * This is the self-healing half of presence, and the whole reason the bridge
 * now publishes a level. Edges can be missed -- a window opening a moment
 * before the filter is ready, a poll delayed past the ten-second staleness
 * cutoff, the lease moving between the main window and the widget -- and a
 * missed edge used to be permanent, because sitting still generates no further
 * edges to recover from. Comparing the level every poll turns a permanent
 * desync into one that lasts half a second.
 *
 * Returns null when there is nothing to correct: no level, a filter still
 * warming up, a board that has gone quiet, or the two already agreeing.
 */
export function presenceResync(
  state: HardwareControllerState,
  level: PresenceLevel | null | undefined,
  now: number,
  silentMs = SENSOR_SILENT_MS,
): HardwareInput | null {
  if (!level || typeof level !== 'object') return null;
  if (!level.ready) return null;
  if (typeof level.present !== 'boolean') return null;
  const at = typeof level.at === 'number' && Number.isFinite(level.at) ? level.at : 0;
  // A stamp of zero is "the board has never reported", not 1970.
  if (at <= 0 || now - at > silentMs) return null;
  if (state.present === level.present) return null;
  return { kind: 'presence', present: level.present };
}

/**
 * Pure transition. Given the current controller state, what the session looks
 * like, and one input, returns the next state plus any actions to perform.
 */
export function reduceHardware(
  state: HardwareControllerState,
  input: HardwareInput,
  session: SessionSnapshot,
  settings: HardwareSettings,
  now: number,
): ReducerResult {
  if (!settings.enabled) return { state: INITIAL_CONTROLLER_STATE, actions: [] };

  const actions: HardwareAction[] = [];
  let next = { ...state };

  if (input.kind === 'button_a') {
    if (!settings.buttonsEnabled) return { state: next, actions };
    // A press is an explicit override: it cancels a pending auto-start rather
    // than racing it, and clears the away timer so a session you deliberately
    // resumed is not terminated a moment later by the sensor.
    next.armingUntil = null;
    next.awaySince = null;
    next.pausedByAway = false;
    // A toggle from the desk that begins a session is a desk-started session,
    // and it clears any earlier "I am done" for the same reason arriving does.
    if (!session.hasSession) {
      next.sessionActive = true;
      next.manualSession = false;
      next.stoppedByHand = false;
    }
    actions.push('toggle');
    return { state: next, actions };
  }

  if (input.kind === 'button_b') {
    if (!settings.buttonsEnabled) return { state: next, actions };
    next.armingUntil = null;
    next.awaySince = null;
    // Stopping by hand means "I am done", not "start the next one" -- without
    // this, still being sat at the desk would arm a fresh session moments later.
    next.stoppedByHand = true;
    next.sessionActive = false;
    next.manualSession = false;
    next.pausedByAway = false;
    if (session.hasSession) actions.push('terminate');
    return { state: next, actions };
  }

  if (input.kind === 'manual_stop') {
    // Deliberately not gated on buttonsEnabled: this comes from the app, not
    // the desk, so turning the physical buttons off must not make the on-screen
    // stop button unable to call off a countdown.
    next.armingUntil = null;
    next.awaySince = null;
    // Same reasoning as the terminate button: you ended it, so sitting here
    // should not immediately arm another one. Cleared by leaving and returning.
    next.stoppedByHand = true;
    next.sessionActive = false;
    next.manualSession = false;
    next.pausedByAway = false;
    // No actions -- the app performed the stop itself before telling us.
    return { state: next, actions };
  }

  if (input.kind === 'presence') {
    const present = Boolean(input.present);
    const isEdge = present !== Boolean(state.present);
    next.present = present;
    if (!settings.sensorEnabled) return { state: next, actions };

    // A PRESENCE INPUT THAT SAYS WHAT WE ALREADY BELIEVE IS NOT AN EVENT.
    // The level is published on every poll and there are two separate paths
    // that can turn it into an input -- `presenceResync`, which only ever
    // synthesises a genuine disagreement, and the bridge's announce-on-connect,
    // which re-sends the current level to a window that has just opened. The
    // announce used to land a second or two after the resync had already put
    // the state right, and arriving-again restarted the arming countdown: the
    // "starting in 5s" on the LCD jumped back to 30. The same guard makes a
    // repeated "away" harmless, which otherwise kept pushing the terminate
    // countdown back and left an abandoned session paused all day.
    if (!isEdge) return { state: next, actions };

    if (present) {
      // Being at the desk ends the absence, whatever else is true. Leaving this
      // to the individual branches below meant it could survive a return and
      // then fire against a later, unrelated session.
      const wasAway = state.awaySince !== null;
      next.awaySince = null;
      // Arriving is a fresh intent to work, so a previous manual stop no longer
      // applies.
      next.stoppedByHand = false;

      if (session.isRunning) {
        // Already working; nothing to do beyond cancelling the timeout above.
        next.pausedByAway = false;
      } else if (session.hasSession && wasAway) {
        // Came back within the grace window. Only resume what the sensor itself
        // paused: a session you paused by hand before getting up was paused on
        // purpose, and sitting down again is not a request to un-do that.
        if (state.pausedByAway) {
          next.pausedByAway = false;
          actions.push('resume');
        }
      } else if (!session.hasSession) {
        // Fresh arrival. The countdown gives you time to settle in, and is
        // cancellable by leaving again before it fires.
        if (settings.armSeconds <= 0) {
          actions.push('start');
          next.sessionActive = true;
          next.manualSession = false;
        } else {
          next.armingUntil = now + settings.armSeconds * 1000;
        }
      }
    } else {
      // Standing up during the countdown means you were not settling in after
      // all, so nothing should start.
      next.armingUntil = null;
      // Off means the desk keeps its hands off a session you started yourself:
      // no pause, and no absence countdown either.
      const ignored = !settings.manualFollowsSensor && Boolean(state.manualSession);
      if (!ignored && settings.awayPauseEnabled && session.hasSession) {
        // The absence clock starts because you left, not because something was
        // paused. Anchoring it to the pause meant a session that was already
        // paused when you walked away sat there for the rest of the day.
        next.awaySince = now;
        if (session.isRunning) {
          next.pausedByAway = true;
          actions.push('pause');
        } else {
          // It was already paused when you got up, so the desk did not pause
          // it and has no business resuming it when you sit back down.
          next.pausedByAway = false;
        }
      }
    }
    return { state: next, actions };
  }

  // --- tick: the time-driven half of the machine ---

  // Keep sessionActive in sync with the live session snapshot
  const wasSessionActive = Boolean(state.sessionActive);
  if (session.hasSession) {
    next.sessionActive = true;

    // A session appeared that this controller did not start: the on-screen
    // button, the system-wide hotkey, the phone. It is adopted rather than
    // ignored, because "the sensor only governs sessions the sensor started"
    // is exactly the split that made a hand-started timer run on undisturbed
    // after you got up and walked off. Adopting it also retires the stale "I
    // stopped that one by hand", which would otherwise keep every later
    // session from chaining.
    //
    // Gated on `ready`: before the timer has loaded, hasSession is a guess,
    // and a guess here would brand an ordinary desk-started session as manual.
    if (!wasSessionActive && session.ready !== false) {
      next.manualSession = true;
      next.stoppedByHand = false;
      next.pausedByAway = false;
      next.armingUntil = null;
    }
  }

  // Session chaining: a session was active and has now ended on its own
  // while you stayed at the desk.
  const sessionJustFinished = wasSessionActive && !session.hasSession;
  if (sessionJustFinished) {
    next.sessionActive = false;
    next.pausedByAway = false;
    const wasManual = Boolean(state.manualSession);
    next.manualSession = false;
    if (settings.sensorEnabled
        && settings.autoRestartEnabled
        && state.present
        && !state.stoppedByHand
        && !(wasManual && !settings.manualFollowsSensor)
        && state.armingUntil === null) {
      const restartDelay = settings.autoRestartArmSeconds ?? 0;
      if (restartDelay <= 0) {
        actions.push('start');
        next.sessionActive = true;
      } else {
        next.armingUntil = now + restartDelay * 1000;
      }
    }
  }

  // A countdown that supposedly expired more than a few minutes ago is corrupt,
  // not merely due: firing it would start a session nobody asked for.
  if (state.armingUntil !== null && (state.armingUntil <= 0 || now - state.armingUntil > 300_000)) {
    next.armingUntil = null;
  } else if (state.armingUntil !== null && now >= state.armingUntil) {
    next.armingUntil = null;
    if (!session.hasSession) {
      actions.push('start');
      next.sessionActive = true;
      next.manualSession = false;
    }
  }

  // A timestamp that is in the future, or absurdly far in the past, is
  // corrupt rather than merely old. Terminating on one would end a session for
  // an absence that never happened, so it is discarded instead of trusted.
  const awayImplausible = state.awaySince !== null
    && (state.awaySince > now || now - state.awaySince > 24 * 3600 * 1000);
  if (awayImplausible) {
    next.awaySince = null;
  } else if (state.awaySince !== null) {
    // The countdown to terminate is only meaningful against a session that is
    // still sitting paused because you walked away. Anything else -- the
    // session ended, it was resumed from the app or the hotkey rather than the
    // desk button, or away-pausing was switched off -- means the timer is
    // stale, and firing it would kill a session that is running perfectly well.
    if (!session.hasSession || session.isRunning || !settings.awayPauseEnabled) {
      next.awaySince = null;
      // AND THE CLAIM THAT WENT WITH IT. `pausedByAway` means "the desk paused
      // this, so the desk may resume it". Once the session is gone, running
      // again, or away-pausing is off, that claim describes nothing -- and
      // leaving it set was enough to have the desk resume a session the user
      // had paused by hand, several steps later, on the next return.
      next.pausedByAway = false;
    } else if (now - state.awaySince >= settings.awayTerminateSeconds * 1000) {
      next.awaySince = null;
      next.pausedByAway = false;
      next.manualSession = false;
      // Terminating leaves a clean slate, so returning to the desk arms a brand
      // new session rather than resuming the abandoned one.
      actions.push('terminate');
    }
  }

  return { state: next, actions };
}

/** Seconds left on the arming countdown, for display. 0 when not arming. */
export function armingSecondsLeft(state: HardwareControllerState, now: number): number {
  if (state.armingUntil === null) return 0;
  return Math.max(0, Math.ceil((state.armingUntil - now) / 1000));
}

// ---------------------------------------------------------------------------
// Server bridge
// ---------------------------------------------------------------------------

export interface HardwareDisplay {
  mode: 'idle' | 'arming' | 'running' | 'paused';
  remainingSeconds: number;
  todaySeconds: number;
  sessionsToday: number;
  armSeconds: number;
}

export interface HardwareControllerOptions {
  settings: HardwareSettings;
  session: SessionSnapshot;
  /** Function returning numbers the LCD should mirror, evaluated on each hardware tick. */
  getDisplay: () => Omit<HardwareDisplay, 'armSeconds'> & {
    /**
     * False until this window has actually loaded the session data. Publishing
     * before that puts a confident "0m, 0 done" on the LCD, which is a lie
     * rather than a delay -- so nothing is published until the numbers are real.
     */
    ready: boolean;
  };
  onToggle: () => void;
  onStart: () => void;
  onResume: () => void;
  onPause: () => void;
  onTerminate: () => void;
}

// One window must own the controller, or a single button press gets acted on
// twice. The lease is refreshed on every poll and expires server-side, so the
// widget takes over within seconds if the main window closes.
// Twice a second: the firmware renders these numbers verbatim rather than
// extrapolating between updates, so the publish rate is what the LCD's
// smoothness depends on.
const POLL_MS = 500;

// An event older than this is history, not news. Acting on one would mean
// reacting to where you were, not where you are.
const STALE_EVENT_MS = 10_000;

/**
 * Drops phantom button presses caused by electrical crosstalk.
 *
 * Measured on this desk: every press of button A was followed ~80ms later by a
 * button B that nobody pressed, which terminated the session. The weak internal
 * pull-ups and the two button wires running together are enough for one line to
 * induce a falling edge on the other.
 *
 * Two *different* buttons cannot be pressed a fraction of a second apart by a
 * human hand, so the second one is noise and is discarded. Repeated presses of
 * the SAME button are left alone -- those are a real thing people do.
 */
export const CROSSTALK_WINDOW_MS = 250;

export function dropCrosstalkButtons<T extends { type: string; at?: number }>(
  events: T[],
  windowMs = CROSSTALK_WINDOW_MS,
): T[] {
  const kept: T[] = [];
  let lastButtonType: string | null = null;
  let lastButtonAt = 0;

  for (const e of events) {
    if (e.type !== 'button_a' && e.type !== 'button_b') {
      kept.push(e);
      continue;
    }
    const at = typeof e.at === 'number' ? e.at : 0;
    if (lastButtonType !== null && e.type !== lastButtonType && at - lastButtonAt < windowMs) {
      continue;  // the other button, far too soon to be a real press
    }
    lastButtonType = e.type;
    lastButtonAt = at;
    kept.push(e);
  }
  return kept;
}
/** The most recent genuine button press, carried between polls. */
export interface ButtonCarry {
  type: string;
  at: number;
}

/**
 * Clean one poll's worth of events, and say what to carry into the next one.
 *
 * WHY THE CARRY EXISTS. Crosstalk straddles polls: press A at the end of one
 * batch and the phantom B it induces 80ms later can land at the start of the
 * next. So the last genuine button of the previous batch is prepended, filtered
 * alongside this one, and then removed again.
 *
 * WHY IT COMES OUT OF THE CLEAN LIST. It used to be taken from the raw events,
 * which meant the ghost itself became the reference for the next batch. Press A,
 * have its phantom B dropped, press A again a fraction later, and that genuine
 * second press was compared against the ghost and discarded as crosstalk. The
 * reference has to be something the filter actually believed.
 *
 * `fallbackAt` stands in for an event with no timestamp of its own, which is
 * what a board with an unset clock sends.
 */
export function filterButtonBatch<T extends { id: number; type: string; at?: number }>(
  events: readonly T[],
  carry: ButtonCarry | null,
  fallbackAt: number,
  windowMs = CROSSTALK_WINDOW_MS,
): { clean: T[]; carry: ButtonCarry | null } {
  type Tagged = { id: number; type: string; at?: number; carried?: boolean };
  const withCarry: Tagged[] = carry
    ? [{ id: -1, type: carry.type, at: carry.at, carried: true }, ...(events as readonly Tagged[])]
    : [...(events as readonly Tagged[])];

  const clean = dropCrosstalkButtons(withCarry, windowMs)
    .filter(e => !e.carried) as unknown as T[];

  let nextCarry = carry;
  for (let i = clean.length - 1; i >= 0; i--) {
    const e = clean[i];
    if (e.type === 'button_a' || e.type === 'button_b') {
      nextCarry = { type: e.type, at: typeof e.at === 'number' ? e.at : fallbackAt };
      break;
    }
  }
  return { clean, carry: nextCarry };
}

const controllerKey = `hw-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * Drives the ESP32 bridge. Returns the arming countdown so the main window and
 * the widget can render the same "starting in Ns" the LCD shows.
 */
export function useHardwareController(opts: HardwareControllerOptions): {
  armSeconds: number;
  present: boolean;
  online: boolean;
  reportManualStop: () => void;
} {
  const [armSeconds, setArmSeconds] = useState(0);
  const [present, setPresent] = useState(false);
  const [online, setOnline] = useState(false);

  // Mirrors of the three pieces of state above. A functional setter that returns
  // the previous value still *dispatches*, and React only skips the re-render
  // when nothing else is pending -- which, on a page with a one-second clock,
  // is rarely true. Twice a second that turned into a full re-render of the
  // planner producing byte-identical output. Comparing here means the setter is
  // never called at all unless the value really moved.
  const armSecondsRef = useRef(0);
  const presentRef = useRef(false);
  const onlineRef = useRef(false);

  const publishArmSeconds = useCallback((v: number) => {
    if (armSecondsRef.current === v) return;
    armSecondsRef.current = v;
    setArmSeconds(v);
  }, []);
  const publishPresent = useCallback((v: boolean) => {
    if (presentRef.current === v) return;
    presentRef.current = v;
    setPresent(v);
  }, []);
  const publishOnline = useCallback((v: boolean) => {
    if (onlineRef.current === v) return;
    onlineRef.current = v;
    setOnline(v);
  }, []);

  /**
   * Tell the controller you stopped the session, or called off a pending
   * countdown, from the app. Routed through the server's event queue rather
   * than applied locally because the window you clicked in is often not the one
   * holding the lease -- and only the lease holder's state is authoritative.
   */
  const reportManualStop = useCallback(() => {
    void fetch('/api/hardware/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'manual_stop' }),
    }).catch(() => {});
  }, []);

  const stateRef = useRef<HardwareControllerState>(INITIAL_CONTROLLER_STATE);
  const lastEventIdRef = useRef(0);
  const isOwnerRef = useRef(false);
  const lastConfigRef = useRef<string | null>(null);
  const syncedRef = useRef(false);
  const lastStateRef = useRef<string | null>(null);
  const lastButtonRef = useRef<{ type: string; at: number } | null>(null);

  // Everything the poll loop needs, kept in refs so the interval does not have
  // to be torn down and rebuilt on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const runActions = useCallback((actions: HardwareAction[]) => {
    const o = optsRef.current;
    for (const action of actions) {
      // Deliberately routed through the app's own handlers -- these are the
      // exact functions the on-screen buttons call.
      if (action === 'toggle') o.onToggle();
      else if (action === 'start') o.onStart();
      else if (action === 'resume') o.onResume();
      else if (action === 'pause') o.onPause();
      else if (action === 'terminate') o.onTerminate();
    }
  }, []);

  // Read here rather than from the ref so switching the feature on opens the
  // heartbeat immediately instead of on the next unrelated remount.
  const enabled = opts.settings.enabled;

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const o = optsRef.current;
      if (!o.settings.enabled) {
        stateRef.current = INITIAL_CONTROLLER_STATE;
        if (!cancelled) {
          publishArmSeconds(0);
          publishOnline(false);
        }
        return;
      }

      const now = Date.now();

      // --- ownership ---
      const wasOwner = isOwnerRef.current;
      try {
        const res = await fetch(`/api/hardware/claim?key=${encodeURIComponent(controllerKey)}`, { method: 'POST' });
        isOwnerRef.current = res.ok ? Boolean((await res.json())?.owner) : false;
      } catch (_) {
        isOwnerRef.current = false;
      }

      // --- adopt the shared controller state ---
      // Read on the first cycle and whenever this window takes over the lease.
      // The state describes the desk, not the window, so a reload or a hand-off
      // to the widget must not lose the fact that you walked away -- that is
      // what left a paused session neither terminating nor resuming.
      // A window that does not hold the lease never processes events, so it has
      // no state of its own to draw -- which is why the countdown was missing
      // from the widget. It mirrors the shared state every cycle instead.
      if (!isOwnerRef.current || !wasOwner) {
        try {
          const res = await fetch('/api/hardware/controller');
          if (res.ok) {
            const s = await res.json();
            // Zero is not a plausible timestamp -- treat it as "unset" rather
            // than as 1970, which would read as an infinitely old timer.
            const stamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
            stateRef.current = {
              present: Boolean(s?.present),
              armingUntil: stamp(s?.armingUntil),
              awaySince: stamp(s?.awaySince),
              stoppedByHand: Boolean(s?.stoppedByHand),
              // Dropped here once, which quietly broke chaining after every
              // reload: the incoming state said "no session active", so the
              // next tick read a live session as one nobody had started.
              sessionActive: Boolean(s?.sessionActive),
              manualSession: Boolean(s?.manualSession),
              pausedByAway: Boolean(s?.pausedByAway),
            };
          }
        } catch (_) { /* keep whatever we had */ }
      }

      // --- drain events ---
      let inputs: HardwareInput[] = [];
      let level: PresenceLevel | null = null;
      try {
        const res = await fetch(`/api/hardware/events?since=${lastEventIdRef.current}`);
        if (res.ok) {
          const data = await res.json();
          const events: Array<{ id: number; type: string; present?: boolean; at?: number }> = data?.events ?? [];
          level = (data?.presence ?? null) as PresenceLevel | null;

          // The server keeps a backlog so a briefly-disconnected window can
          // catch up. A window that has just opened has no business replaying
          // it: acting on a presence change from ten minutes ago would pause
          // and then terminate a session that is running perfectly well. So the
          // first poll only adopts the position in the stream.
          //
          // It does NOT return any more. Discarding the backlog is right; going
          // home before the level check below is what left a window that opened
          // while you were already sitting there believing the desk was empty,
          // with no edge ever coming to correct it.
          if (!syncedRef.current) {
            syncedRef.current = true;
            lastEventIdRef.current = Number(data?.latest) || 0;
            if (!cancelled) publishOnline(true);
          } else {

          // Crosstalk can straddle two polls, so the last button believed in
          // the previous batch is carried in and filtered alongside this one.
          const batch = filterButtonBatch(events, lastButtonRef.current, now);
          const clean = batch.clean;
          lastButtonRef.current = batch.carry;

          for (const e of events) lastEventIdRef.current = Math.max(lastEventIdRef.current, e.id);

          for (const e of clean) {
            // Belt and braces: an event that has been sitting unconsumed for a
            // while no longer describes the present, whatever the reason.
            if (typeof e.at === 'number' && now - e.at > STALE_EVENT_MS) continue;
            if (e.type === 'presence') inputs.push({ kind: 'presence', present: e.present });
            else if (e.type === 'button_a') inputs.push({ kind: 'button_a' });
            else if (e.type === 'button_b') inputs.push({ kind: 'button_b' });
            else if (e.type === 'manual_stop') inputs.push({ kind: 'manual_stop' });
          }
          }
          if (!cancelled) publishOnline(true);
        } else if (!cancelled) {
          publishOnline(false);
        }
      } catch (_) {
        if (!cancelled) publishOnline(false);
        // Server unreachable: still run the tick so a pending countdown does
        // not freeze mid-flight.
      }

      // The sensor's standing verdict, used to correct a controller that
      // missed an edge. Appended rather than substituted: a real edge in this
      // batch is the better evidence and is processed first, after which the
      // two agree and this adds nothing.
      if (!inputs.some(i => i.kind === 'presence')) {
        const resync = presenceResync(stateRef.current, level, now);
        if (resync) inputs.push(resync);
      }

      // A window that does not hold the lease still tracks state so it can
      // display the countdown, but must not perform any action.
      if (!isOwnerRef.current) inputs = [];

      // The tick is time-driven and reads the session snapshot to decide
      // whether a pending timer is still meaningful. Running it in the same
      // cycle as an event would read a snapshot React has not updated yet --
      // immediately after a pause the session still looks like it is running --
      // so it waits for the next cycle, by which point the state has settled.
      const hadEvents = inputs.length > 0;
      if (!hadEvents) inputs.push({ kind: 'tick' });

      for (const input of inputs) {
        const before = stateRef.current;
        const result = reduceHardware(stateRef.current, input, o.session, o.settings, now);
        stateRef.current = result.state;
        if (isOwnerRef.current && result.actions.length) {
          runActions(result.actions);
          // Recorded with everything the decision was based on, so a wrong one
          // can be read back rather than reconstructed from memory.
          void fetch('/api/hardware/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              input: input.kind,
              present: input.present,
              actions: result.actions,
              wasRunning: o.session.isRunning,
              hadSession: o.session.hasSession,
              awaySinceMsAgo: before.awaySince === null ? null : now - before.awaySince,
              armingInMs: before.armingUntil === null ? null : before.armingUntil - now,
              awayTimeoutS: o.settings.awayTerminateSeconds,
            }),
          }).catch(() => {});
        }
      }

      const arming = armingSecondsLeft(stateRef.current, now);
      if (!cancelled) {
        // Only ever set state on a real change. These setters feed the whole
        // planner tree, and calling them unconditionally re-rendered it twice a
        // second forever -- which is invisible in isolation and ruinous for the
        // frame rate of everything else on the page.
        publishArmSeconds(arming);
        publishPresent(stateRef.current.present);
      }

      // --- persist the controller state ---
      // Written every cycle rather than only on change: this is the record that
      // lets another window continue from where this one left off, so it must
      // never be even one cycle out of date.
      if (isOwnerRef.current) {
        const serialized = JSON.stringify(stateRef.current);
        if (serialized !== lastStateRef.current) {
          lastStateRef.current = serialized;
          try {
            await fetch('/api/hardware/controller', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: serialized,
            });
          } catch (_) { lastStateRef.current = null; /* retry next cycle */ }
        }
      }

      // --- publish sensor tuning ---
      // The dev server configures the presence filter from this, and the board
      // reads its ping rate out of it. Only written when it actually changes:
      // both of them poll it, and rewriting it every tick would be pure churn.
      if (isOwnerRef.current) {
        const cfg = {
          ...sensorFilterConfigOf(o.settings),
          sampleIntervalMs: o.settings.sampleIntervalMs,
          calibrating: o.settings.calibrating,
          announceOnConnect: o.settings.announceOnConnect,
        };
        const serialized = JSON.stringify(cfg);
        if (serialized !== lastConfigRef.current) {
          lastConfigRef.current = serialized;
          try {
            await fetch('/api/hardware/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: serialized,
            });
          } catch (_) { lastConfigRef.current = null; /* retry next tick */ }
        }
      }

      // --- publish what the LCD should show ---
      // Withheld until the numbers are loaded: the server treats "nobody
      // published recently" as offline, and a display that admits it is waiting
      // beats one that confidently shows a zero total you know is wrong.
      if (isOwnerRef.current) {
        const display = o.getDisplay();
        if (display.ready) {
          const mode: HardwareDisplay['mode'] = arming > 0 ? 'arming' : display.mode;
          try {
            await fetch('/api/hardware/state', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mode,
                remainingSeconds: display.remainingSeconds,
                todaySeconds: display.todaySeconds,
                sessionsToday: display.sessionsToday,
                armSeconds: arming,
              }),
            });
          } catch (_) { /* transient; the next poll republishes */ }
        }
      }
    };

    // One cycle at a time, and never two in the same instant. Two wake sources
    // feed this (see below) and a cycle makes several sequential requests, so
    // without the gate they would overlap and act on each other's half-written
    // state.
    let inFlight = false;
    let lastRunAt = 0;
    const runOnce = async () => {
      const now = Date.now();
      if (inFlight || now - lastRunAt < POLL_MS * 0.8) return;
      inFlight = true;
      lastRunAt = now;
      try { await tick(); } finally { inFlight = false; }
    };

    void runOnce();

    // The timer is the fallback, not the primary beat: Chrome throttles it to
    // about once a minute whenever this window is hidden, minimised or fully
    // covered by another one, which froze the whole controller until the window
    // was clicked. The server's heartbeat below arrives as a network message,
    // which is not throttled, and keeps the desk working while you are looking
    // at something else. The timer still covers the case where the stream drops.
    const id = window.setInterval(() => { void runOnce(); }, POLL_MS);

    let beat: EventSource | null = null;
    if (enabled) {
      try {
        beat = new EventSource('/api/hardware/tick');
        beat.onmessage = () => { void runOnce(); };
      } catch (_) { /* the interval above still drives it */ }
    }

    return () => {
      cancelled = true;
      window.clearInterval(id);
      beat?.close();
    };
  }, [enabled, runActions, publishArmSeconds, publishPresent, publishOnline]);

  return { armSeconds, present, online, reportManualStop };
}
