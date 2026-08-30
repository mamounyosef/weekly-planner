// ─── Android alarm planning ──────────────────────────────────────────────────
// Decides which OS alarms to add and which to cancel, given what the planner
// says should fire and what is currently registered on the device.
//
// The schedule itself comes from `computeSchedule` in notifications.ts — the
// exact code the PC already runs — so a reminder means the same thing on both
// machines. This module only handles the part that is specific to a phone:
// keeping the OS in step without churning it.
//
// WHY DIFFING MATTERS MORE THAN IT LOOKS
// The naive loop is "cancel everything, then schedule everything" on each sync.
// On Android that is wrong three times over: it burns battery, it briefly leaves
// the device with NO alarms (so one landing in that gap is missed entirely), and
// re-registering an alarm whose time has already passed can make it fire again
// immediately. So an unchanged reminder must be left completely alone, and the
// tests below assert exactly that.
//
// THE CAP
// Android limits how many alarms one app may hold. Rather than fail at the OS
// boundary — which would silently drop whichever alarms happened to be last — we
// keep the SOONEST ones and say so, because a reminder three weeks out matters
// far less than one this afternoon, and the horizon is re-planned on every sync
// anyway.

import type { ScheduledNotification } from './notifications';

/** An alarm currently registered with the OS. */
export interface RegisteredAlarm {
  /** The notification key — the same dedupe key the server uses. */
  key: string;
  /** Identifier handed back by the OS, needed to cancel it. */
  osId: string;
  /** When it is set to fire. */
  fireAt: number;
}

export interface AlarmPlan {
  /** OS ids to cancel. */
  cancel: RegisteredAlarm[];
  /** Reminders to register. */
  schedule: ScheduledNotification[];
  /** Registered alarms that are already correct and must be left untouched. */
  keep: RegisteredAlarm[];
  /** Dropped because the device cannot hold them all; re-planned next sync. */
  deferred: ScheduledNotification[];
}

export interface PlanOptions {
  now: number;
  /** How far ahead to register alarms. */
  horizonMs?: number;
  /** Most alarms to hold at once. */
  maxAlarms?: number;
  /** Keys already delivered or dealt with; never re-register these. */
  handledKeys?: ReadonlySet<string>;
  /** Grace period for an alarm that has only just passed. */
  lateToleranceMs?: number;
}

/**
 * How far ahead alarms are registered.
 *
 * 36 hours rather than a week: the phone re-plans on every sync and every app
 * launch, so a longer horizon buys nothing but costs alarm slots that a busy
 * tomorrow may need. It is long enough that a PC switched off overnight still
 * cannot cause a missed morning reminder.
 */
export const DEFAULT_HORIZON_MS = 36 * 60 * 60 * 1000;

/** Well under Android's limit, leaving room for the OS and other apps. */
export const DEFAULT_MAX_ALARMS = 400;

/**
 * An alarm that should have fired within this window is still scheduled, at
 * once. Anything older is history: firing a reminder for a meeting that ended
 * two hours ago is worse than staying quiet.
 */
export const DEFAULT_LATE_TOLERANCE_MS = 5 * 60 * 1000;

export function planAlarms(
  registered: readonly RegisteredAlarm[],
  desired: readonly ScheduledNotification[],
  opts: PlanOptions,
): AlarmPlan {
  const {
    now,
    horizonMs = DEFAULT_HORIZON_MS,
    maxAlarms = DEFAULT_MAX_ALARMS,
    handledKeys,
    lateToleranceMs = DEFAULT_LATE_TOLERANCE_MS,
  } = opts;

  const horizonEnd = now + horizonMs;
  const earliest = now - lateToleranceMs;

  // ── What SHOULD be registered ──
  const wantedByKey = new Map<string, ScheduledNotification>();
  for (const item of desired) {
    if (!item || typeof item.key !== 'string' || item.key.length === 0) continue;
    if (!Number.isFinite(item.fireAt)) continue;
    if (item.fireAt < earliest) continue;      // too far in the past to be useful
    if (item.fireAt > horizonEnd) continue;    // beyond the horizon; next sync will get it
    if (handledKeys?.has(item.key)) continue;  // already dealt with anywhere

    // The same key twice in one batch is a bug upstream, not a reason to
    // register two alarms. Keep the earlier one.
    const existing = wantedByKey.get(item.key);
    if (!existing || item.fireAt < existing.fireAt) wantedByKey.set(item.key, item);
  }

  // Soonest first, so the cap keeps what matters.
  const wanted = [...wantedByKey.values()].sort(
    (a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const withinCap = wanted.slice(0, Math.max(0, maxAlarms));
  const deferred = wanted.slice(Math.max(0, maxAlarms));
  const capKeys = new Set(withinCap.map(w => w.key));

  // ── What IS registered ──
  const cancel: RegisteredAlarm[] = [];
  const keep: RegisteredAlarm[] = [];
  const keptKeys = new Set<string>();

  for (const alarm of registered) {
    if (!alarm || typeof alarm.key !== 'string') continue;
    const want = capKeys.has(alarm.key) ? wantedByKey.get(alarm.key) : undefined;

    // No longer wanted: the event moved, was deleted, or was dealt with.
    if (!want) {
      cancel.push(alarm);
      continue;
    }
    // A duplicate registration for the same key — cancel the extra.
    if (keptKeys.has(alarm.key)) {
      cancel.push(alarm);
      continue;
    }
    // Wanted, but at a different time: cancel and re-register.
    if (alarm.fireAt !== want.fireAt) {
      cancel.push(alarm);
      continue;
    }
    // Correct as it stands. LEAVE IT ALONE.
    keep.push(alarm);
    keptKeys.add(alarm.key);
  }

  const schedule = withinCap.filter(w => !keptKeys.has(w.key));

  return { cancel, schedule, keep, deferred };
}

/** True when the plan would change nothing — used to skip the OS calls entirely. */
export function planIsNoop(plan: AlarmPlan): boolean {
  return plan.cancel.length === 0 && plan.schedule.length === 0;
}

/** One-line summary for the diagnostics screen. */
export function describePlan(plan: AlarmPlan): string {
  if (planIsNoop(plan)) {
    return plan.keep.length === 1
      ? '1 reminder scheduled'
      : `${plan.keep.length} reminders scheduled`;
  }
  const bits: string[] = [];
  if (plan.schedule.length > 0) bits.push(`+${plan.schedule.length}`);
  if (plan.cancel.length > 0) bits.push(`−${plan.cancel.length}`);
  const tail = plan.deferred.length > 0 ? `, ${plan.deferred.length} beyond the limit` : '';
  return `${bits.join(' ')} (${plan.keep.length} unchanged)${tail}`;
}

/**
 * Alarms whose time has passed while the device was asleep or the app closed.
 *
 * Android does deliver these, but if the app was force-stopped it may not, so
 * the phone checks on launch and reports anything genuinely missed. Reporting
 * matters as much as firing: the server must know, or it will send the same
 * reminder again through another transport.
 */
export function findMissed(
  registered: readonly RegisteredAlarm[],
  opts: { now: number; handledKeys?: ReadonlySet<string>; graceMs?: number },
): RegisteredAlarm[] {
  const grace = opts.graceMs ?? 30 * 1000;
  return registered
    .filter(a => a && typeof a.key === 'string' && Number.isFinite(a.fireAt))
    .filter(a => a.fireAt <= opts.now - grace)
    .filter(a => !opts.handledKeys?.has(a.key))
    .sort((a, b) => a.fireAt - b.fireAt);
}
