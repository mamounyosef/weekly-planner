// ─── The focus timer, as a state machine ─────────────────────────────────────
// Start, pause, resume, stop. Three states and a handful of transitions, which
// sounds like something a screen could keep in `useState` -- and that is exactly
// the version that loses your afternoon.
//
// WHY THIS IS A PURE MODULE AND NOT A HOOK
// The timer has to survive the app being closed. Android suspends a React Native
// runtime whenever it feels like it: every interval stops, every piece of
// component state is thrown away, and a timer built out of "add one second every
// second" comes back twenty minutes short with no way to tell that it did. So
// nothing here counts. The state stores the INSTANT the clock was started, and
// elapsed time is subtracted from the clock on every read. A tick in the UI
// exists only to repaint; delete it and the numbers are still right, they just
// stop moving.
//
// Everything below is a pure function of (stored state, action, now). `now` is
// always injected, never read from `Date.now()`, which is what makes a clock
// that jumps backwards, a session that spans a daylight-saving change, and an
// app reopened six hours later all ordinary test cases rather than things you
// find out about in production.
//
// THE SHAPE IS THE PC'S SHAPE, ON PURPOSE
// `FocusTimerState` is field-for-field the desktop's `focusSessions.ts` state
// plus one tag (`origin`) that the PC's own coercion harmlessly drops. The two
// machines have to agree about how long a session ran and which day it landed
// on, and the surest way to agree is to store the same thing and derive it the
// same way. The day itself is decided by `focusDayKey` in `focusStats.ts` -- the
// shared one, never a second copy, because a phone that disagreed with the PC
// about which day a late-night session belonged to would be worse than a phone
// with no timer at all.
//
// Tested in `focusTimer.test.ts`; copied to `mobile/src/lib/focusTimer.ts`.

import {
  focusDayKey, focusSessionId, normaliseFocusSessionId, type FocusSessionRecord,
} from './focusStats';

// Re-exported so the many call sites that reach for an id through this module
// keep working. Identity lives in `focusStats` because that is the module with
// no imports of its own, and a cycle between the two would be a real hazard:
// `focusStats` needs the identity to collapse duplicates while summing.
export { focusSessionId, normaliseFocusSessionId };

/** A minute is the shortest planned session worth having. */
export const MIN_PLANNED_SECONDS = 60;
/** Twelve hours. Past this it is not a focus session, it is a stuck timer. */
export const MAX_PLANNED_SECONDS = 12 * 60 * 60;
export const DEFAULT_PLANNED_SECONDS = 60 * 60;

/**
 * A ceiling on any stored second count.
 *
 * Not a business rule, a corruption guard: a half-written or hand-edited file
 * can hand back `1e308`, and every duration computed from it afterwards is
 * `Infinity`. Clamping once, here, means nothing downstream has to wonder.
 */
export const MAX_STORED_SECONDS = 366 * 24 * 60 * 60;

export type FocusPhase = 'idle' | 'running' | 'paused';

export interface FocusTimerState {
  /** How long this session is meant to run. Survives every reset. */
  plannedSeconds: number;
  /** Time already banked by earlier runs of THIS session. */
  accumulatedSeconds: number;
  isRunning: boolean;
  /** The instant the clock was last started. The whole timer, really. */
  lastStartedAt: string | null;
  /** The instant the session began, which is what the record is stamped with. */
  sessionStartedAt: string | null;
  /** When it was last paused. Not used for timekeeping; it identifies a pause. */
  lastPausedAt: string | null;
  /**
   * How much of this session's elapsed time a manual day edit already wrote into
   * a day's total.
   *
   * The desktop lets you correct a day's figure while a session is running, and
   * without this the correction and the running clock fight: the day total is
   * `logged + elapsed`, so the edit has to guess a logged value that comes out
   * right, and then the still-growing elapsed drags it up again and the session
   * logs the same seconds a second time when it ends. Banking them here means
   * the countdown is untouched and only the time run SINCE the edit counts
   * toward the day. The phone does not offer that edit, but it must carry the
   * field faithfully or a session started on the PC would be logged twice.
   */
  creditedSeconds: number;
  /** When this state was written, in ms. Used only to order two versions. */
  updatedAt: number;
  /** Which device wrote it. A deterministic tie-break, never a clock. */
  origin: string | null;
}

export const IDLE_FOCUS_TIMER: FocusTimerState = {
  plannedSeconds: DEFAULT_PLANNED_SECONDS,
  accumulatedSeconds: 0,
  isRunning: false,
  lastStartedAt: null,
  sessionStartedAt: null,
  lastPausedAt: null,
  creditedSeconds: 0,
  updatedAt: 0,
  origin: null,
};

// ── Reading stored state ─────────────────────────────────────────────────────

/** `Date.parse` that answers null instead of NaN, so callers cannot forget. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function storedSeconds(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_STORED_SECONDS);
}

/**
 * Turn whatever came off disk into a state we can reason about.
 *
 * Stored state is not trustworthy input. It can be from an older build with
 * fields missing, half-written by a process that died between two writes, or
 * simply absent on a first run. The rule throughout is that no input throws and
 * no input produces a state that lies: in particular a timer that claims to be
 * running with no start instant is NOT running, because there is no honest
 * answer to "how long has it been going" and pretending otherwise would show a
 * clock counting up from 1970.
 */
export function coerceFocusTimer(value: unknown): FocusTimerState {
  if (!value || typeof value !== 'object') return IDLE_FOCUS_TIMER;
  const p = value as Record<string, unknown>;

  const planned = Math.floor(Number(p.plannedSeconds));
  const plannedSeconds = Number.isFinite(planned) && planned > 0
    ? Math.min(MAX_PLANNED_SECONDS, Math.max(MIN_PLANNED_SECONDS, planned))
    : DEFAULT_PLANNED_SECONDS;

  const startedMs = instant(p.lastStartedAt);
  const sessionMs = instant(p.sessionStartedAt);
  const pausedMs = instant(p.lastPausedAt);
  const isRunning = Boolean(p.isRunning) && startedMs !== null;

  const updated = Number(p.updatedAt);

  return {
    plannedSeconds,
    accumulatedSeconds: storedSeconds(p.accumulatedSeconds),
    isRunning,
    // A start instant is meaningless once the clock is stopped, and keeping one
    // is how a stale anchor gets resumed later and credits hours nobody worked.
    lastStartedAt: isRunning && startedMs !== null ? iso(startedMs) : null,
    sessionStartedAt: sessionMs !== null ? iso(sessionMs) : null,
    lastPausedAt: pausedMs !== null ? iso(pausedMs) : null,
    creditedSeconds: storedSeconds(p.creditedSeconds),
    updatedAt: Number.isFinite(updated) && updated > 0 ? Math.floor(updated) : 0,
    origin: typeof p.origin === 'string' && p.origin !== '' ? p.origin : null,
  };
}

// ── Reading the clock ────────────────────────────────────────────────────────

export function focusPhase(state: FocusTimerState): FocusPhase {
  if (state.isRunning) return 'running';
  if (state.sessionStartedAt !== null || state.accumulatedSeconds > 0) return 'paused';
  return 'idle';
}

/** Whether there is a session at all, running or held. */
export function hasFocusSession(state: FocusTimerState): boolean {
  return focusPhase(state) !== 'idle';
}

/**
 * How long this session has run by `now`.
 *
 * The running part is derived from the anchor rather than counted, so closing
 * the app for an hour and reopening it gives the same answer as never having
 * closed it. A negative span (the phone's clock corrected itself backwards, or
 * somebody changed the time zone by hand) contributes zero rather than a
 * negative number: time already banked is never taken away, and the clock simply
 * appears to stand still until it catches up with where it was.
 */
export function focusElapsedSeconds(state: FocusTimerState, now: number): number {
  const anchor = state.lastStartedAt ? Date.parse(state.lastStartedAt) : NaN;
  const running = state.isRunning && Number.isFinite(anchor)
    ? Math.max(0, Math.floor((now - anchor) / 1000))
    : 0;
  return Math.max(0, state.accumulatedSeconds + running);
}

/** What is left of the planned length. Never negative. */
export function focusRemainingSeconds(state: FocusTimerState, now: number): number {
  return Math.max(0, state.plannedSeconds - focusElapsedSeconds(state, now));
}

/** 0 to 1, clamped, for a ring or a bar. */
export function focusProgress(state: FocusTimerState, now: number): number {
  if (state.plannedSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, focusElapsedSeconds(state, now) / state.plannedSeconds));
}

/** The part of a running session that still owes its day some time. */
export function focusUncreditedSeconds(state: FocusTimerState, now: number): number {
  return Math.max(0, focusElapsedSeconds(state, now) - state.creditedSeconds);
}

/** Whether a running session has already reached its planned length. */
export function focusIsOverdue(state: FocusTimerState, now: number): boolean {
  return state.isRunning && focusElapsedSeconds(state, now) >= state.plannedSeconds;
}

/**
 * Bank the running time into `accumulatedSeconds` without changing the total.
 *
 * The subtle part is the new anchor: it moves forward by exactly the whole
 * seconds just banked, NOT to `now`. Anchoring to now throws away the
 * sub-second remainder every single time, which on the desktop worked out at
 * roughly three minutes of focus quietly vanishing per hour, and made the
 * countdown jump backwards whenever anything recomputed the true total.
 */
export function checkpointFocusTimer(state: FocusTimerState, now: number): FocusTimerState {
  if (!state.isRunning || !state.lastStartedAt) return state;
  const anchor = Date.parse(state.lastStartedAt);
  if (!Number.isFinite(anchor)) return state;
  const ran = Math.floor((now - anchor) / 1000);
  // A backwards clock must not rewind the session, so the anchor stays put.
  if (ran <= 0) return state;
  return {
    ...state,
    accumulatedSeconds: Math.min(MAX_STORED_SECONDS, state.accumulatedSeconds + ran),
    lastStartedAt: iso(anchor + ran * 1000),
  };
}

// ── Finished sessions ────────────────────────────────────────────────────────

/**
 * The id an auto-completed session gets.
 *
 * Kept as a name because it reads better at the call site, but it is now the
 * session's own id: an hour that ends by running out and an hour that ends by
 * being stopped are the same hour.
 */
export function autoSessionId(sessionStartedAt: string | null, _plannedSeconds?: number): string {
  return focusSessionId(sessionStartedAt);
}

/** The id a hand-stopped session gets. The same id, for the same reason. */
export function stoppedSessionId(sessionStartedAt: string | null, _durationSeconds?: number): string {
  return focusSessionId(sessionStartedAt);
}

/**
 * Build the record for a session that ended at `endedMs` having run `ran`
 * seconds.
 *
 * `startedAt` is the real start of the session unless a manual day edit already
 * banked part of it, in which case the record covers only the un-banked tail and
 * has to start where that tail did. Returns null when there is nothing worth
 * writing down, which is the honest answer for a mis-tap.
 */
function buildSession(
  state: FocusTimerState,
  ran: number,
  endedMs: number,
  id: string,
): FocusSessionRecord | null {
  const duration = Math.max(0, Math.floor(ran) - state.creditedSeconds);
  if (duration <= 0) return null;
  const startedMs = state.sessionStartedAt !== null && state.creditedSeconds === 0
    ? Date.parse(state.sessionStartedAt)
    : endedMs - duration * 1000;
  return {
    id,
    startedAt: iso(Number.isFinite(startedMs) ? startedMs : endedMs - duration * 1000),
    endedAt: iso(endedMs),
    durationSeconds: duration,
    plannedSeconds: state.plannedSeconds,
  };
}

/**
 * The instant a running session reaches its planned length.
 *
 * This is the whole reason the app can be closed for six hours and still credit
 * the right day: the session did not end when the phone was next unlocked, it
 * ended when the clock said it did, possibly on the previous day. Clamped to
 * `now`, because nothing can have finished in the future.
 */
function completionInstant(state: FocusTimerState, now: number): number {
  const anchor = state.lastStartedAt ? Date.parse(state.lastStartedAt) : NaN;
  if (!Number.isFinite(anchor)) return now;
  const stillNeeded = Math.max(0, state.plannedSeconds - state.accumulatedSeconds);
  return Math.min(now, anchor + stillNeeded * 1000);
}

/** Which focus-day a finished session counts toward. The shared rule, always. */
export function focusSessionDay(session: FocusSessionRecord, dayStartHour = 0): string {
  return focusDayKey(session.endedAt ?? session.startedAt, dayStartHour);
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type FocusTimerAction =
  /** Begin a session, or pick up a paused one. Doing it twice does nothing. */
  | { kind: 'start' }
  /** Pick up a paused session. Does nothing to a running or absent one. */
  | { kind: 'resume' }
  /** Hold the clock, keeping every second run so far. */
  | { kind: 'pause' }
  /** Finish the session and hand back the record to log. */
  | { kind: 'stop'; id?: string }
  /** Throw the session away without logging anything. */
  | { kind: 'discard' }
  /** Change the planned length. Allowed mid-session, like the desktop. */
  | { kind: 'setPlanned'; seconds: number }
  /** Bank elapsed time that a manual day edit has already written to the day. */
  | { kind: 'credit'; seconds: number }
  /** Fold running time into the accumulated total. Nothing visible changes. */
  | { kind: 'checkpoint' }
  /**
   * Bring the state up to date with the clock: complete the session if it has
   * run past its planned length. Safe to call on every tick, on foreground and
   * on launch, which is exactly where it belongs.
   */
  | { kind: 'settle' }
  /**
   * One button, doing whatever the timer needs next.
   *
   * WHAT THE KEYBOARD SHORTCUT AND THE DESK SENSOR PRESS. Both of those reach
   * the timer with no window open, through a server route that used to do its
   * own arithmetic: if the timer said running, it added `now - lastStartedAt`
   * to the accumulated seconds and paused. With the PC hibernated overnight
   * that difference is the whole night, so sitting down at the desk the next
   * morning banked eight hours into a one hour session -- which then landed on
   * the new day as invented work nobody had done.
   *
   * Routing it through the reducer is what fixes that: an overdue session is
   * SETTLED at the moment it ran out, exactly as it would be if a window had
   * been open to notice.
   */
  | { kind: 'toggle' };

export interface FocusTimerOutcome {
  state: FocusTimerState;
  /** A session to write to the history, or null. Never a zero-length one. */
  session: FocusSessionRecord | null;
  /** False when the action was a no-op, so callers can skip a write. */
  changed: boolean;
}

function unchanged(state: FocusTimerState): FocusTimerOutcome {
  return { state, session: null, changed: false };
}

/** Back to nothing, keeping the planned length the user chose. */
function afterSession(state: FocusTimerState, now: number, origin: string | null): FocusTimerState {
  return {
    ...IDLE_FOCUS_TIMER,
    plannedSeconds: state.plannedSeconds,
    lastPausedAt: iso(now),
    updatedAt: now,
    origin,
  };
}

/**
 * The whole timer.
 *
 * Takes unvalidated stored state on purpose: the caller reads a blob off disk
 * and passes it straight in, which is what keeps the wiring around this module
 * down to a few lines. Every action either returns a new state or says it
 * changed nothing, and the only effect available to it is the session record it
 * hands back for the caller to log.
 */
export function reduceFocusTimer(
  stored: unknown,
  action: FocusTimerAction,
  now: number,
  origin: string | null = null,
): FocusTimerOutcome {
  const state = coerceFocusTimer(stored);
  const tag = origin ?? state.origin;

  switch (action.kind) {
    case 'start': {
      // Already running: a double tap, or the button racing a tick. Re-anchoring
      // here would silently discard everything since the last checkpoint.
      if (state.isRunning) return unchanged(state);
      const stamp = iso(now);
      return {
        state: {
          ...state,
          isRunning: true,
          lastStartedAt: stamp,
          sessionStartedAt: state.sessionStartedAt ?? stamp,
          lastPausedAt: null,
          updatedAt: now,
          origin: tag,
        },
        session: null,
        changed: true,
      };
    }

    case 'resume': {
      // Resuming something that was never paused is not an error, it is a
      // no-op: the user wants the clock running, and the clock is running.
      if (state.isRunning || !hasFocusSession(state)) return unchanged(state);
      return reduceFocusTimer(state, { kind: 'start' }, now, tag);
    }

    case 'pause': {
      // Pausing twice keeps the FIRST pause's timestamp. The second tap did not
      // stop anything, so recording a moment as though it had would make two
      // identical pauses look like two different events.
      if (!state.isRunning) return unchanged(state);

      // An overdue session is not pausable, it is over. Banking the overrun
      // instead would carry however long the machine was away into the session,
      // and `checkpointFocusTimer` is bounded only by a YEAR -- so a pause on
      // the way back from an overnight hibernate could add eight hours to an
      // hour-long session. `stop` has always routed this way; `pause` did not.
      if (focusIsOverdue(state, now)) {
        return reduceFocusTimer(state, { kind: 'settle' }, now, tag);
      }
      const banked = checkpointFocusTimer(state, now);
      return {
        state: {
          ...banked,
          isRunning: false,
          lastStartedAt: null,
          lastPausedAt: iso(now),
          updatedAt: now,
          origin: tag,
        },
        session: null,
        changed: true,
      };
    }

    case 'stop': {
      // Nothing to stop. Answering with a cleared state rather than a no-op
      // would overwrite whatever the other device is doing, for no reason.
      if (!hasFocusSession(state)) return unchanged(state);

      // A session that ran past its planned length while the app was closed is
      // finished, and finished at the moment it ran out -- not now. Routing
      // through `settle` is what stops a tap on the way back into the app from
      // logging six hours against a one hour session.
      if (focusIsOverdue(state, now)) {
        return reduceFocusTimer(state, { kind: 'settle' }, now, tag);
      }

      const ran = focusElapsedSeconds(state, now);
      const session = buildSession(
        state,
        ran,
        now,
        action.id ?? stoppedSessionId(state.sessionStartedAt, Math.max(0, ran - state.creditedSeconds)),
      );
      return { state: afterSession(state, now, tag), session, changed: true };
    }

    case 'discard': {
      if (!hasFocusSession(state)) return unchanged(state);
      return { state: afterSession(state, now, tag), session: null, changed: true };
    }

    case 'setPlanned': {
      const raw = Math.floor(Number(action.seconds));
      const next = Number.isFinite(raw)
        ? Math.min(MAX_PLANNED_SECONDS, Math.max(MIN_PLANNED_SECONDS, raw))
        : state.plannedSeconds;
      if (next === state.plannedSeconds) return unchanged(state);
      return {
        state: { ...state, plannedSeconds: next, updatedAt: now, origin: tag },
        session: null,
        changed: true,
      };
    }

    case 'credit': {
      // Never bank more than has actually been run, or the day ends up owed
      // negative time when the session finishes.
      const want = Math.max(0, Math.floor(Number(action.seconds)) || 0);
      const next = Math.min(want, focusElapsedSeconds(state, now));
      if (next === state.creditedSeconds) return unchanged(state);
      return {
        state: { ...state, creditedSeconds: next, updatedAt: now, origin: tag },
        session: null,
        changed: true,
      };
    }

    case 'checkpoint': {
      const banked = checkpointFocusTimer(state, now);
      if (banked === state) return unchanged(state);
      // Deliberately NOT stamped with a new `updatedAt`. A checkpoint describes
      // exactly the same total as the state it replaces, so letting it win an
      // ordering contest would overwrite a real start or stop made elsewhere
      // with our own stale view of the session.
      return { state: banked, session: null, changed: true };
    }

    case 'toggle': {
      // Overdue first, and never a pause. A session that ran past its planned
      // length while nothing was watching is FINISHED, and finished when it ran
      // out -- not now, and not after the machine spent the night off.
      if (focusIsOverdue(state, now)) {
        return reduceFocusTimer(state, { kind: 'settle' }, now, tag);
      }
      if (state.isRunning) return reduceFocusTimer(state, { kind: 'pause' }, now, tag);
      return reduceFocusTimer(state, { kind: 'start' }, now, tag);
    }

    case 'settle': {
      if (!focusIsOverdue(state, now)) return unchanged(state);
      const endedMs = completionInstant(state, now);
      const session = buildSession(
        state,
        state.plannedSeconds,
        endedMs,
        autoSessionId(state.sessionStartedAt, state.plannedSeconds),
      );
      return { state: afterSession(state, now, tag), session, changed: true };
    }

    default:
      return unchanged(state);
  }
}

// ── Two devices, one timer ───────────────────────────────────────────────────

export interface FocusTimerMerge {
  state: FocusTimerState;
  /**
   * A session the losing side had running, worth writing into the history
   * rather than dropping. Null unless two independent sessions actually
   * collided.
   */
  salvaged: FocusSessionRecord | null;
  /** True when the two sides described genuinely different sessions. */
  conflict: boolean;
}

/** The last moment anyone is known to have been holding this state. */
function lastKnownAlive(state: FocusTimerState, now: number): number {
  return state.updatedAt > 0 ? Math.min(state.updatedAt, now) : now;
}

/**
 * A stable, symmetric preference between two versions of the SAME session.
 *
 * Wall clocks do not decide a winner anywhere else in this app and they barely
 * do here: `updatedAt` separates two writes the same person made seconds apart,
 * and when it cannot, the tie falls to the version holding more elapsed time
 * (losing recorded work is the one outcome worth avoiding) and then to the
 * device id, which both sides compare identically and so both sides agree.
 */
function preferSame(a: FocusTimerState, b: FocusTimerState, now: number): FocusTimerState {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  const ea = focusElapsedSeconds(a, now);
  const eb = focusElapsedSeconds(b, now);
  if (ea !== eb) return ea > eb ? a : b;
  if (a.isRunning !== b.isRunning) return a.isRunning ? a : b;
  const oa = a.origin ?? '';
  const ob = b.origin ?? '';
  if (oa !== ob) return oa < ob ? a : b;
  return a;
}

/**
 * Reconcile this device's timer with the other one's.
 *
 * Three situations, and each rule exists because of the thing that situation
 * can destroy:
 *
 *  • THE SAME SESSION, seen twice. Ordinary catch-up. The newer write wins.
 *
 *  • A SESSION AGAINST NOTHING. "Nothing" is what stopping produces, so a stop
 *    made after the other side's last write must not be undone by that side's
 *    older "still running" view; that is how a finished session comes back from
 *    the dead and gets logged a second time. Only a strictly newer idle beats a
 *    live session.
 *
 *  • TWO DIFFERENT SESSIONS, started independently on the two machines. The
 *    most recent start wins, because it is the one the user is sitting in front
 *    of, and because the alternative resurrects a timer somebody left running
 *    on the desk yesterday and shows it as today's work. The loser is not
 *    thrown away though: whatever it actually ran comes back as a finished
 *    record for the caller to log, so the only thing lost is a countdown and
 *    never any time worked.
 */
export function mergeFocusTimers(mine: unknown, theirs: unknown, now: number): FocusTimerMerge {
  const a = coerceFocusTimer(mine);
  const b = coerceFocusTimer(theirs);

  const aHas = hasFocusSession(a);
  const bHas = hasFocusSession(b);

  if (!aHas && !bHas) {
    return { state: preferSame(a, b, now), salvaged: null, conflict: false };
  }

  if (aHas !== bHas) {
    const session = aHas ? a : b;
    const idle = aHas ? b : a;
    // A stop that happened after the other side's last word wins. Nothing is
    // salvaged: the device that stopped has already written that session down.
    if (idle.updatedAt > session.updatedAt) {
      return { state: idle, salvaged: null, conflict: false };
    }
    return { state: session, salvaged: null, conflict: false };
  }

  if (a.sessionStartedAt === b.sessionStartedAt) {
    return { state: preferSame(a, b, now), salvaged: null, conflict: false };
  }

  // Two real sessions. Ordered by when they STARTED, which both sides read the
  // same way, rather than by who happened to write last.
  const aStart = a.sessionStartedAt ? Date.parse(a.sessionStartedAt) : -Infinity;
  const bStart = b.sessionStartedAt ? Date.parse(b.sessionStartedAt) : -Infinity;
  const winner = aStart === bStart ? preferSame(a, b, now) : (aStart > bStart ? a : b);
  const loser = winner === a ? b : a;

  const aliveAt = lastKnownAlive(loser, now);
  const ran = focusElapsedSeconds(loser, aliveAt);
  const salvaged = buildSession(
    loser,
    ran,
    aliveAt,
    stoppedSessionId(loser.sessionStartedAt, Math.max(0, ran - loser.creditedSeconds)),
  );

  return { state: winner, salvaged, conflict: true };
}

// ── Presentation helpers ─────────────────────────────────────────────────────

/**
 * "25:00", "1:04:09".
 *
 * Minutes are padded and hours are not, so the string only ever grows at the
 * front. A layout that reserves room per character can then hold every digit
 * still while the seconds change, which matters more than it sounds: a hero
 * clock that shuffles sideways twice a second is the difference between calm
 * and fidgety.
 */
export function formatFocusClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "1h 30m", "45m", "None". The same words the history below it uses. */
export function formatFocusLength(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (s <= 0) return 'None';
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
