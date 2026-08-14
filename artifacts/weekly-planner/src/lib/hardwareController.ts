// ---------------------------------------------------------------------------
// ESP32 focus-timer controller.
//
// An ESP32 on the desk drives a 16x2 LCD, two buttons and an ultrasonic
// presence sensor. The firmware is deliberately dumb: it posts raw events
// ("button A pressed", "someone is at the desk") and renders whatever numbers
// it is handed. Everything below turns those raw events into the same
// start/pause/terminate calls the on-screen buttons make, so hardware and UI
// can never diverge in behaviour.
//
// The decision logic is a pure reducer. Both windows run it, but only the one
// holding the server lease acts on the result -- see useHardwareController.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';

export interface HardwareSettings {
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
  /** When a session finishes and you are still at the desk, arm the next one.
   *  Without it the day stops after the first session, since staying put
   *  produces no sensor event to react to. */
  autoRestartEnabled: boolean;
  /** How long you may stay away before the paused session is terminated. */
  awayTerminateSeconds: number;

  // â”€â”€ Sensor tuning â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // These live here rather than in the firmware so the board never has to be
  // plugged into the PC to be re-tuned. The ESP32 fetches them periodically and
  // applies them at runtime.

  /** Absent â†’ present once the median distance drops below this (cm). */
  enterCm: number;
  /** Present â†’ absent once the median rises above this (cm). Must exceed
   *  enterCm: the gap between the two is the hysteresis that stops a reading
   *  sitting on the boundary from rattling the state back and forth. */
  exitCm: number;
  /** Milliseconds between ultrasonic pings. */
  sampleIntervalMs: number;
  /** How many samples the median is taken over. Odd values only, so there is
   *  always a true middle element. Capped by the firmware's buffer. */
  medianWindow: number;
  /** Sustained time before arriving is believed (ms). */
  presentConfirmMs: number;
  /** Sustained time before leaving is believed (ms). Normally longer than
   *  presentConfirmMs so leaning out of the beam is not read as walking away. */
  absentConfirmMs: number;
  /** Readings beyond this are treated as sensor glitches and dropped, rather
   *  than fed to the filter. Cheap ultrasonic modules occasionally spray
   *  maximum-range values for a second or two. NOT the same as ignoring them
   *  outright: see glitchHoldMs. */
  maxValidCm: number;
  /** How long a run of over-range readings may be discarded before it is
   *  believed. Without this, discarding them would be indistinguishable from
   *  the desk genuinely being empty with nothing in the beam, and leaving would
   *  never be detected at all. */
  glitchHoldMs: number;
  /** While true the board streams live distance readings for calibration. */
  calibrating: boolean;
  /** Re-announce presence when an app window first becomes reachable. The
   *  board is usually up long before the PC has finished booting, so without
   *  this, sitting at an already-occupied desk starts nothing until you get up
   *  and sit back down. Evaluated on the board, since it is the thing that
   *  knows when the link came back. */
  announceOnConnect: boolean;
}

/** Matches MEDIAN_WINDOW_MAX in the firmware's config.h. */
export const MEDIAN_WINDOW_MAX = 15;

export const DEFAULT_HARDWARE_SETTINGS: HardwareSettings = {
  enabled: true,
  buttonsEnabled: true,
  sensorEnabled: true,
  armSeconds: 30,
  awayPauseEnabled: true,
  autoRestartEnabled: true,
  awayTerminateSeconds: 120,
  // Measured on this desk: seated reads 30-39 cm, empty chair 57-59 cm.
  enterCm: 48,
  exitCm: 52,
  sampleIntervalMs: 100,
  medianWindow: 5,
  presentConfirmMs: 2000,
  absentConfirmMs: 5000,
  // There is a wall behind this desk, so nothing can legitimately read beyond
  // about a metre; anything further is the module misfiring.
  maxValidCm: 100,
  glitchHoldMs: 10000,
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
  if (typeof r.autoRestartEnabled === 'boolean') s.autoRestartEnabled = r.autoRestartEnabled;
  // Clamped rather than rejected: a nonsensical value should degrade to a sane
  // one, not silently disable the feature.
  if (Number.isFinite(Number(r.armSeconds))) s.armSeconds = Math.max(0, Math.min(300, Math.round(Number(r.armSeconds))));
  if (Number.isFinite(Number(r.awayTerminateSeconds))) {
    s.awayTerminateSeconds = Math.max(10, Math.min(3600, Math.round(Number(r.awayTerminateSeconds))));
  }

  if (typeof r.calibrating === 'boolean') s.calibrating = r.calibrating;
  if (typeof r.announceOnConnect === 'boolean') s.announceOnConnect = r.announceOnConnect;
  if (Number.isFinite(Number(r.enterCm))) s.enterCm = Math.max(2, Math.min(400, Number(r.enterCm)));
  if (Number.isFinite(Number(r.exitCm))) s.exitCm = Math.max(2, Math.min(400, Number(r.exitCm)));
  if (Number.isFinite(Number(r.sampleIntervalMs))) {
    s.sampleIntervalMs = Math.max(40, Math.min(2000, Math.round(Number(r.sampleIntervalMs))));
  }
  if (Number.isFinite(Number(r.medianWindow))) {
    const w = Math.max(1, Math.min(MEDIAN_WINDOW_MAX, Math.round(Number(r.medianWindow))));
    s.medianWindow = w % 2 === 0 ? w - 1 : w;  // even windows have no true middle
  }
  if (Number.isFinite(Number(r.presentConfirmMs))) {
    s.presentConfirmMs = Math.max(0, Math.min(60000, Math.round(Number(r.presentConfirmMs))));
  }
  if (Number.isFinite(Number(r.absentConfirmMs))) {
    s.absentConfirmMs = Math.max(0, Math.min(60000, Math.round(Number(r.absentConfirmMs))));
  }
  if (Number.isFinite(Number(r.maxValidCm))) {
    s.maxValidCm = Math.max(20, Math.min(400, Math.round(Number(r.maxValidCm))));
  }
  if (Number.isFinite(Number(r.glitchHoldMs))) {
    s.glitchHoldMs = Math.max(0, Math.min(60000, Math.round(Number(r.glitchHoldMs))));
  }

  // Hysteresis only works if leaving needs a strictly larger distance than
  // arriving. An inverted pair would make the state flip on every sample, so it
  // is corrected here rather than trusted.
  if (s.exitCm <= s.enterCm) s.exitCm = s.enterCm + 4;

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
}

export const INITIAL_CONTROLLER_STATE: HardwareControllerState = {
  present: false,
  armingUntil: null,
  awaySince: null,
  stoppedByHand: false,
};

/** What the reducer wants done, expressed in the app's own vocabulary. */
export type HardwareAction = 'start' | 'pause' | 'resume' | 'terminate' | 'toggle';

export interface SessionSnapshot {
  /** The focus timer is counting right now. */
  isRunning: boolean;
  /** A session exists (running or paused) rather than a clean slate. */
  hasSession: boolean;
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
    // No actions -- the app performed the stop itself before telling us.
    return { state: next, actions };
  }

  if (input.kind === 'presence') {
    const present = Boolean(input.present);
    next.present = present;
    if (!settings.sensorEnabled) return { state: next, actions };

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
      } else if (session.hasSession && wasAway) {
        // Came back within the grace window -- pick the session back up.
        actions.push('resume');
      } else if (!session.hasSession) {
        // Fresh arrival. The countdown gives you time to settle in, and is
        // cancellable by leaving again before it fires.
        next.armingUntil = now + settings.armSeconds * 1000;
      }
    } else {
      // Standing up during the countdown means you were not settling in after
      // all, so nothing should start.
      next.armingUntil = null;
      if (session.isRunning && settings.awayPauseEnabled) {
        next.awaySince = now;
        actions.push('pause');
      }
    }
    return { state: next, actions };
  }

  // --- tick: the time-driven half of the machine ---

  // Sitting at the desk with no session running arms one. Usually that is
  // driven by the arrival event, but a session that simply ran out while you
  // stayed put produces no event at all -- presence never changed -- so without
  // this the day would stop dead at the end of the first hour. Suppressed after
  // a manual stop, and while a countdown is already pending.
  if (settings.sensorEnabled
      && settings.autoRestartEnabled
      && state.present
      && !session.hasSession
      && state.armingUntil === null
      && !state.stoppedByHand) {
    next.armingUntil = now + settings.armSeconds * 1000;
  }
  // A countdown that supposedly expired more than a few minutes ago is corrupt,
  // not merely due: firing it would start a session nobody asked for.
  if (state.armingUntil !== null && now - state.armingUntil > 300_000) {
    next.armingUntil = null;
  } else if (state.armingUntil !== null && now >= state.armingUntil) {
    next.armingUntil = null;
    if (!session.hasSession) actions.push('start');
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
    } else if (now - state.awaySince >= settings.awayTerminateSeconds * 1000) {
      next.awaySince = null;
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
  /** Numbers the LCD should mirror -- taken from what the app itself displays. */
  display: Omit<HardwareDisplay, 'armSeconds'> & {
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
            };
          }
        } catch (_) { /* keep whatever we had */ }
      }

      // --- drain events ---
      let inputs: HardwareInput[] = [];
      try {
        const res = await fetch(`/api/hardware/events?since=${lastEventIdRef.current}`);
        if (res.ok) {
          const data = await res.json();
          const events: Array<{ id: number; type: string; present?: boolean; at?: number }> = data?.events ?? [];

          // The server keeps a backlog so a briefly-disconnected window can
          // catch up. A window that has just opened has no business replaying
          // it: acting on a presence change from ten minutes ago would pause
          // and then terminate a session that is running perfectly well. So the
          // first poll only adopts the position in the stream.
          if (!syncedRef.current) {
            syncedRef.current = true;
            lastEventIdRef.current = Number(data?.latest) || 0;
            if (!cancelled) publishOnline(true);
            return;
          }

          // Crosstalk can straddle two polls, so the last button seen in the
          // previous batch is carried in and filtered alongside this one.
          const carried = lastButtonRef.current
            ? [{ id: -1, type: lastButtonRef.current.type, at: lastButtonRef.current.at, carried: true }, ...events]
            : events;
          const clean = dropCrosstalkButtons(carried as Array<{ id: number; type: string; at?: number; carried?: boolean }>)
            .filter(e => !(e as { carried?: boolean }).carried) as typeof events;

          for (const e of events) lastEventIdRef.current = Math.max(lastEventIdRef.current, e.id);
          for (const e of [...events].reverse()) {
            if (e.type === 'button_a' || e.type === 'button_b') {
              lastButtonRef.current = { type: e.type, at: typeof e.at === 'number' ? e.at : now };
              break;
            }
          }

          for (const e of clean) {
            // Belt and braces: an event that has been sitting unconsumed for a
            // while no longer describes the present, whatever the reason.
            if (typeof e.at === 'number' && now - e.at > STALE_EVENT_MS) continue;
            if (e.type === 'presence') inputs.push({ kind: 'presence', present: e.present });
            else if (e.type === 'button_a') inputs.push({ kind: 'button_a' });
            else if (e.type === 'button_b') inputs.push({ kind: 'button_b' });
            else if (e.type === 'manual_stop') inputs.push({ kind: 'manual_stop' });
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

      // --- publish sensor tuning for the board to pick up ---
      // Only when it actually changes: the board polls this, and rewriting it
      // every tick would be pure churn.
      if (isOwnerRef.current) {
        const cfg = {
          enterCm: o.settings.enterCm,
          exitCm: o.settings.exitCm,
          sampleIntervalMs: o.settings.sampleIntervalMs,
          medianWindow: o.settings.medianWindow,
          presentConfirmMs: o.settings.presentConfirmMs,
          absentConfirmMs: o.settings.absentConfirmMs,
          maxValidCm: o.settings.maxValidCm,
          glitchHoldMs: o.settings.glitchHoldMs,
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
      if (isOwnerRef.current && o.display.ready) {
        const mode: HardwareDisplay['mode'] = arming > 0 ? 'arming' : o.display.mode;
        try {
          await fetch('/api/hardware/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode,
              remainingSeconds: o.display.remainingSeconds,
              todaySeconds: o.display.todaySeconds,
              sessionsToday: o.display.sessionsToday,
              armSeconds: arming,
            }),
          });
        } catch (_) { /* transient; the next poll republishes */ }
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
