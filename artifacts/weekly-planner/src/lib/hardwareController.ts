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
  /** How long you may stay away before the paused session is terminated. */
  awayTerminateSeconds: number;
}

export const DEFAULT_HARDWARE_SETTINGS: HardwareSettings = {
  enabled: true,
  buttonsEnabled: true,
  sensorEnabled: true,
  armSeconds: 30,
  awayPauseEnabled: true,
  awayTerminateSeconds: 120,
};

export function coerceHardwareSettings(raw: unknown): HardwareSettings {
  const s = { ...DEFAULT_HARDWARE_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;

  if (typeof r.enabled === 'boolean') s.enabled = r.enabled;
  if (typeof r.buttonsEnabled === 'boolean') s.buttonsEnabled = r.buttonsEnabled;
  if (typeof r.sensorEnabled === 'boolean') s.sensorEnabled = r.sensorEnabled;
  if (typeof r.awayPauseEnabled === 'boolean') s.awayPauseEnabled = r.awayPauseEnabled;
  // Clamped rather than rejected: a nonsensical value should degrade to a sane
  // one, not silently disable the feature.
  if (Number.isFinite(Number(r.armSeconds))) s.armSeconds = Math.max(0, Math.min(300, Math.round(Number(r.armSeconds))));
  if (Number.isFinite(Number(r.awayTerminateSeconds))) {
    s.awayTerminateSeconds = Math.max(10, Math.min(3600, Math.round(Number(r.awayTerminateSeconds))));
  }
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
}

export const INITIAL_CONTROLLER_STATE: HardwareControllerState = {
  present: false,
  armingUntil: null,
  awaySince: null,
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
  kind: 'presence' | 'button_a' | 'button_b' | 'tick';
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
    if (session.hasSession) actions.push('terminate');
    return { state: next, actions };
  }

  if (input.kind === 'presence') {
    const present = Boolean(input.present);
    next.present = present;
    if (!settings.sensorEnabled) return { state: next, actions };

    if (present) {
      if (session.isRunning) {
        // Already working; just cancel any pending absence timeout.
        next.awaySince = null;
      } else if (session.hasSession && state.awaySince !== null) {
        // Came back within the grace window -- pick the session back up.
        next.awaySince = null;
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
  if (state.armingUntil !== null && now >= state.armingUntil) {
    next.armingUntil = null;
    if (!session.hasSession) actions.push('start');
  }

  if (state.awaySince !== null && now - state.awaySince >= settings.awayTerminateSeconds * 1000) {
    next.awaySince = null;
    // Terminating leaves a clean slate, so returning to the desk arms a brand
    // new session rather than resuming the abandoned one.
    if (session.hasSession) actions.push('terminate');
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
  display: Omit<HardwareDisplay, 'armSeconds'>;
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
const controllerKey = `hw-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/**
 * Drives the ESP32 bridge. Returns the arming countdown so the main window and
 * the widget can render the same "starting in Ns" the LCD shows.
 */
export function useHardwareController(opts: HardwareControllerOptions): { armSeconds: number; present: boolean; online: boolean } {
  const [armSeconds, setArmSeconds] = useState(0);
  const [present, setPresent] = useState(false);
  const [online, setOnline] = useState(false);

  const stateRef = useRef<HardwareControllerState>(INITIAL_CONTROLLER_STATE);
  const lastEventIdRef = useRef(0);
  const isOwnerRef = useRef(false);

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

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const o = optsRef.current;
      if (!o.settings.enabled) {
        stateRef.current = INITIAL_CONTROLLER_STATE;
        if (!cancelled) {
          setArmSeconds(0);
          setOnline(false);
        }
        return;
      }

      const now = Date.now();

      // --- ownership ---
      try {
        const res = await fetch(`/api/hardware/claim?key=${encodeURIComponent(controllerKey)}`, { method: 'POST' });
        isOwnerRef.current = res.ok ? Boolean((await res.json())?.owner) : false;
      } catch (_) {
        isOwnerRef.current = false;
      }

      // --- drain events ---
      let inputs: HardwareInput[] = [];
      try {
        const res = await fetch(`/api/hardware/events?since=${lastEventIdRef.current}`);
        if (res.ok) {
          const data = await res.json();
          const events: Array<{ id: number; type: string; present?: boolean }> = data?.events ?? [];
          for (const e of events) {
            lastEventIdRef.current = Math.max(lastEventIdRef.current, e.id);
            if (e.type === 'presence') inputs.push({ kind: 'presence', present: e.present });
            else if (e.type === 'button_a') inputs.push({ kind: 'button_a' });
            else if (e.type === 'button_b') inputs.push({ kind: 'button_b' });
          }
          if (!cancelled) setOnline(true);
        } else if (!cancelled) {
          setOnline(false);
        }
      } catch (_) {
        if (!cancelled) setOnline(false);
        // Server unreachable: still run the tick so a pending countdown does
        // not freeze mid-flight.
      }

      // A window that does not hold the lease still tracks state so it can
      // display the countdown, but must not perform any action.
      if (!isOwnerRef.current) inputs = [];

      inputs.push({ kind: 'tick' });

      for (const input of inputs) {
        const result = reduceHardware(stateRef.current, input, o.session, o.settings, now);
        stateRef.current = result.state;
        if (isOwnerRef.current && result.actions.length) runActions(result.actions);
      }

      const arming = armingSecondsLeft(stateRef.current, now);
      if (!cancelled) {
        setArmSeconds(arming);
        setPresent(stateRef.current.present);
      }

      // --- publish what the LCD should show ---
      if (isOwnerRef.current) {
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

    void tick();
    const id = window.setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [runActions]);

  return { armSeconds, present, online };
}
