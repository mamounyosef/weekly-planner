// ─── Client sync engine (the phone's half) ───────────────────────────────────
// Pure orchestration: local edits, an outbox of unsent operations, and the
// push/pull/acknowledge cycle. No SQLite and no fetch in here — persistence and
// transport are injected, so every failure mode below is testable without a
// device, and the same file runs unchanged inside the Android app.
//
// THE RULES THAT KEEP EDITS ALIVE
//
// 1. A local edit is applied to local state and appended to the outbox in the
//    same step. The UI never waits for the network, ever.
// 2. An op leaves the outbox ONLY when the server has confirmed it. A push whose
//    response is lost stays queued and is sent again — the server deduplicates by
//    opId, so a resend is harmless, whereas dropping it would lose the edit.
// 3. The cursor advances only after the pulled ops are merged AND persisted. If
//    the app dies between pull and save, the same ops arrive again next time,
//    which is fine; advancing first would skip them forever.
// 4. Nothing is ever discarded because the server said something unexpected. A
//    full resync REPLACES server-derived state but KEEPS the outbox, because the
//    outbox is the only copy of edits the server has not seen.

import {
  emptyState,
  isMeaninglessConflict,
  makeOps,
  mergeOps,
  readStore,
  resolveConflict,
  type SyncConflict,
  type SyncOp,
  type SyncState,
  type SyncStore,
} from './sync';
import { snapshotToOps, type Snapshot } from './syncBridge';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error';

export interface ClientData {
  state: SyncState;
  /** Ops made locally that the server has not confirmed. Ordered. */
  outbox: SyncOp[];
  /** Highest server lamport this device has merged and persisted. */
  cursor: number;
  /** Open conflict cards, as the server reported them. */
  conflicts: SyncConflict[];
  /** Wall clock of the last completed sync, for "Last synced 4 hours ago". */
  lastSyncedAt: number | null;
  deviceId: string;
}

export function emptyClientData(deviceId: string): ClientData {
  return {
    state: emptyState(),
    outbox: [],
    cursor: 0,
    conflicts: [],
    lastSyncedAt: null,
    deviceId,
  };
}

// ─── Transport contract ──────────────────────────────────────────────────────

export interface PullResponse {
  ops: SyncOp[];
  /** A LOG POSITION on the server, opaque to us. Never a lamport clock. */
  cursor: number;
  conflicts: SyncConflict[];
  needsFullResync: boolean;
  serverTime: number;
  /** The server's lamport clock, so our next edit sorts after everything it
   *  already holds. Optional: an older server does not send it. */
  lamport?: number;
}

export interface PushResponse {
  accepted: number;
  ignored: number;
  rejected?: number;
  conflicts: SyncConflict[];
  cursor: number;
  /** The server's clock after accepting the push. Optional: an older server
   *  does not send it, and a missing clock must never lower ours. */
  lamport?: number;
}

export interface SnapshotResponse {
  stores: Partial<Record<SyncStore, Snapshot>>;
  cursor: number;
  lamport: number;
  conflicts: SyncConflict[];
  serverTime: number;
}

export interface SyncTransport {
  /** `waitMs` asks the server to hold the request until something changes. */
  pull(deviceId: string, since: number, waitMs?: number): Promise<PullResponse>;
  push(deviceId: string, ops: SyncOp[]): Promise<PushResponse>;
  ack(deviceId: string, cursor: number): Promise<{ cursor: number }>;
  snapshot(deviceId: string): Promise<SnapshotResponse>;
  resolve(deviceId: string, conflictId: string, choice: ResolveChoice): Promise<unknown>;
}

export type ResolveChoice = 'winner' | 'loser' | 'delete' | 'keep';

// ─── Local edits ─────────────────────────────────────────────────────────────

/**
 * Apply an edit locally and queue it. Returns new data; never mutates the input,
 * so a React state update is a straight assignment.
 */
export function applyLocalChange(
  data: ClientData,
  opts: { store: SyncStore; entityId: string; changes: Record<string, unknown>; at: number },
): ClientData {
  const working = structuredClone(data.state);
  const ops = makeOps(working, {
    store: opts.store,
    entityId: opts.entityId,
    device: data.deviceId,
    at: opts.at,
    changes: opts.changes,
  });
  if (ops.length === 0) return data;

  const merged = mergeOps(data.state, ops);
  return {
    ...data,
    state: merged.state,
    outbox: [...data.outbox, ...ops],
  };
}

/** Delete an item locally. A tombstone, so the server learns about it. */
export function applyLocalDelete(
  data: ClientData,
  opts: { store: SyncStore; entityId: string; at: number },
): ClientData {
  return applyLocalChange(data, { ...opts, changes: { __deleted: true } });
}

/**
 * Apply a whole edited record at once — how a form save actually arrives from
 * the UI. Diffing here rather than in every screen means a screen cannot forget
 * to emit an op for a field it changed.
 */
export function applyLocalRecord(
  data: ClientData,
  opts: { store: SyncStore; entityId: string; record: Record<string, unknown>; at: number },
): ClientData {
  const working = structuredClone(data.state);
  const ops = snapshotToOps(working, {
    store: opts.store,
    snapshot: { [opts.entityId]: opts.record },
    device: data.deviceId,
    at: opts.at,
    detectDeletes: false,
  });
  if (ops.length === 0) return data;

  const merged = mergeOps(data.state, ops);
  return { ...data, state: merged.state, outbox: [...data.outbox, ...ops] };
}

/** Answer a conflict card locally; the choice is an ordinary op and syncs. */
export function applyLocalResolution(
  data: ClientData,
  conflict: SyncConflict,
  choice: ResolveChoice,
  at: number,
): ClientData {
  const working = structuredClone(data.state);
  const ops = resolveConflict(working, conflict, choice, { device: data.deviceId, at });
  const merged = mergeOps(data.state, ops);
  return {
    ...data,
    state: merged.state,
    outbox: [...data.outbox, ...ops],
    conflicts: data.conflicts.filter(c => c.id !== conflict.id),
  };
}

// ─── Reading for the UI ──────────────────────────────────────────────────────

export function readClientStore(data: ClientData, store: SyncStore): Snapshot {
  return readStore(data.state, store);
}

export interface SyncStatus {
  phase: SyncPhase;
  pending: number;
  conflicts: number;
  lastSyncedAt: number | null;
  /** Ready-to-show sentence for the sidebar. */
  label: string;
}

/**
 * The one line the sidebar shows. Written so you never have to guess whether the
 * phone is current: it always says either that it is, or exactly what is waiting.
 */
/**
 * How recently we must have reached the PC to refuse to call it offline.
 *
 * One failed attempt is not evidence that a PC is switched off — a phone loses
 * its connection walking between rooms, and a request cut short while the app
 * was frozen on screen-off fails without anything being wrong at either end.
 * Announcing "PC offline" on that basis was simply untrue, and it was the most
 * alarming thing on the screen, sitting there while sync was in fact working.
 *
 * Two minutes is comfortably longer than the idle loop, so a healthy phone
 * never crosses it, and short enough that a PC genuinely switched off is
 * reported as such quickly.
 */
export const OFFLINE_AFTER_MS = 120_000;

export function describeStatus(data: ClientData, phase: SyncPhase, now: number): SyncStatus {
  const pending = data.outbox.length;
  const conflicts = data.conflicts.length;

  // Believed only when nothing has got through for a while. The phase reports
  // the last ATTEMPT; this asks whether the PC is actually out of reach.
  const reallyOffline = (phase === 'offline' || phase === 'error')
    && (data.lastSyncedAt === null || now - data.lastSyncedAt > OFFLINE_AFTER_MS);

  let label: string;
  if (conflicts > 0) {
    label = conflicts === 1 ? '1 conflict to review' : `${conflicts} conflicts to review`;
  } else if (phase === 'syncing') {
    label = 'Syncing…';
  } else if (pending > 0) {
    label = reallyOffline
      ? `${pending} ${pending === 1 ? 'change' : 'changes'} waiting, PC offline`
      : `${pending} ${pending === 1 ? 'change' : 'changes'} to send`;
  } else if (data.lastSyncedAt === null) {
    label = 'Not synced yet';
  } else if (reallyOffline) {
    label = `Last synced ${describeAgo(now - data.lastSyncedAt)}`;
  } else {
    label = 'In sync with PC';
  }

  return { phase, pending, conflicts, lastSyncedAt: data.lastSyncedAt, label };
}

/**
 * Is this the same status, as far as anybody reading it is concerned?
 *
 * The sync loop moves through phases constantly — a held pull returns, the
 * phase goes syncing, then idle, then syncing again, several times a minute
 * forever. `describeStatus` builds a fresh object each time, so on the phone
 * that identity change propagated through the planner context and re-rendered
 * every screen in the app, including the calendar grid, to display a line of
 * text that had not changed.
 *
 * Comparing by VALUE keeps the indicator exactly as live as it was — the
 * moment any of these five fields differs, the new object is used — while
 * costing nothing when the answer is the same one as last time.
 */
export function sameStatus(a: SyncStatus | null, b: SyncStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.phase === b.phase
    && a.pending === b.pending
    && a.conflicts === b.conflicts
    && a.lastSyncedAt === b.lastSyncedAt
    && a.label === b.label;
}

export function describeAgo(ms: number): string {
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// ─── The sync cycle ──────────────────────────────────────────────────────────

export interface SyncOutcome {
  /**
   * A held pull failed where an immediate one worked.
   *
   * Means the path to the PC will not tolerate a request that stays silent —
   * a proxy, a tunnel or a phone radio closing it early. Not a fault, and
   * emphatically not "the PC is offline": the caller should stop asking the
   * server to hold, and carry on.
   */
  holdRejected?: boolean;
  data: ClientData;
  phase: SyncPhase;
  pushed: number;
  pulled: number;
  /** Set when the cycle failed; the outbox is intact and it is safe to retry. */
  error?: string;
  didFullResync?: boolean;
}

/**
 * One complete cycle: push what is queued, pull what is new, acknowledge.
 *
 * Every early return keeps the outbox, so a failure at any point costs a retry
 * and never an edit. The order is push-then-pull deliberately: pushing first
 * means the server can detect a conflict and hand it back in the same round
 * trip, instead of the phone merging a stale value and only finding out later.
 */
export async function syncOnce(
  data: ClientData,
  transport: SyncTransport,
  now: number,
  /**
   * How long the server may hold an empty pull open.
   *
   * Zero for a sync the user is waiting on — pressing refresh, or opening the
   * app — where an immediate answer matters more than efficiency. Non-zero for
   * the idle loop, where holding the request is what makes a change made on the
   * PC arrive at once instead of on the next tick of a timer.
   */
  waitMs = 0,
): Promise<SyncOutcome> {
  let next = data;
  let pushed = 0;
  let pulled = 0;
  let didFullResync = false;
  let holdRejected = false;

  // ── Push ──
  if (next.outbox.length > 0) {
    const sending = next.outbox.slice();
    let res: PushResponse;
    try {
      res = await transport.push(next.deviceId, sending);
    } catch (err) {
      return { data: next, phase: 'offline', pushed: 0, pulled: 0, error: messageOf(err) };
    }
    // Only the ops we actually sent leave the queue — anything added while the
    // request was in flight must survive, or a fast typist loses an edit.
    const sentIds = new Set(sending.map(o => o.opId));
    next = {
      ...next,
      state: adoptClock(next.state, res.lamport),
      outbox: next.outbox.filter(o => !sentIds.has(o.opId)),
      conflicts: mergeConflicts(next.conflicts, res.conflicts),
    };
    pushed = sending.length;
  }

  // ── Pull ──
  let pull: PullResponse;
  try {
    // Never wait when we have just sent something: the push has already moved
    // the log, so there is something to collect and parking would be silly.
    const hold = pushed > 0 ? 0 : waitMs;
    try {
      pull = await transport.pull(next.deviceId, next.cursor, hold);
    } catch (err) {
      // A HELD REQUEST FAILING IS NOT THE PC BEING OFF. Something in the middle
      // closed a connection that was deliberately quiet, which says nothing
      // about whether the PC is reachable — so before reporting failure, ask
      // again without the hold. Getting an answer proves the link is fine and
      // that only the waiting is unwelcome.
      if (hold <= 0) throw err;
      pull = await transport.pull(next.deviceId, next.cursor, 0);
      holdRejected = true;
    }
  } catch (err) {
    return { data: next, phase: 'offline', pushed, pulled: 0, error: messageOf(err) };
  }

  if (pull.needsFullResync) {
    try {
      next = await fullResync(next, transport);
      didFullResync = true;
    } catch (err) {
      return { data: next, phase: 'error', pushed, pulled: 0, error: messageOf(err) };
    }
  } else {
    // The cursor comes from the SERVER, always. It is a position in the server's
    // log, and deriving it locally from the lamports of the ops we happened to
    // receive made the phone re-request the same batch forever whenever an op
    // carried a lower lamport than one already seen.
    const state = pull.ops.length > 0 ? mergeOps(next.state, pull.ops) : null;
    next = {
      ...next,
      // Both sources, because neither alone is sufficient. `pull.lamport` is the
      // server's clock INCLUDING changes whose ops we were not sent (our own,
      // already applied); the ops themselves cover a server too old to report a
      // clock at all. Taking the higher of the two is the only way the phone is
      // guaranteed to be current after a completed sync.
      state: adoptClock(
        adoptClock(state ? state.state : next.state, pull.lamport),
        highestLamport(pull.ops),
      ),
      // The SERVER's number, taken as given — not `max(ours, theirs)`. Keeping
      // the higher of the two meant a cursor that was once too high could never
      // come down, and a cursor above the log's head matches no operation at
      // all. Requests are serialised here, so there is no stale response to
      // guard against; the only thing `max` protected was the bug itself.
      cursor: pull.cursor,
      conflicts: state
        ? mergeConflicts(next.conflicts, state.conflicts)
        : next.conflicts,
    };
    pulled = pull.ops.length;
  }

  // The server is the authority on which cards are still open, so a card
  // answered on the PC disappears here without the phone doing anything.
  next = { ...next, conflicts: reconcileConflicts(next.conflicts, pull.conflicts) };

  // ── Acknowledge ──
  // Only when the cursor actually moved. The server already knows where an
  // unchanged device stands, so an ack that repeats it is a whole round trip —
  // and a whole read-modify-write on the server — to say nothing at all. On an
  // idle planner that was half of all sync traffic.
  //
  // A failed ack is harmless either way: the same ops arrive again and merge
  // idempotently.
  if (next.cursor !== data.cursor) {
    try {
      await transport.ack(next.deviceId, next.cursor);
    } catch {
      /* ignored on purpose */
    }
  }

  return {
    data: { ...next, lastSyncedAt: now },
    holdRejected,
    phase: 'idle',
    pushed,
    pulled,
    didFullResync,
  };
}

/**
 * Take the server's lamport clock if it is ahead of ours.
 *
 * WHY THIS IS NOT OPTIONAL. Lamport ordering decides every conflict. A phone
 * whose clock sits below the server's loses every single race it enters, no
 * matter when the edit was made -- the user ticks something on the phone, the
 * PC's older value out-ranks it, and the tick "does not arrive". The phone only
 * ever learned the server's clock from ops it received, so a phone that pulls
 * nothing new (the common case: it is up to date) stayed behind forever.
 *
 * Returns the same object when nothing changes, so React does not re-render.
 */
/** The highest clock stamp in a batch, or undefined for an empty batch. */
export function highestLamport(ops: readonly SyncOp[]): number | undefined {
  let max: number | undefined;
  for (const op of ops) {
    if (typeof op.lamport !== 'number' || !Number.isFinite(op.lamport)) continue;
    if (max === undefined || op.lamport > max) max = op.lamport;
  }
  return max;
}

export function adoptClock(state: SyncState, serverLamport: number | undefined): SyncState {
  if (typeof serverLamport !== 'number' || !Number.isFinite(serverLamport)) return state;
  if (serverLamport <= state.lamport) return state;
  return { ...state, lamport: Math.floor(serverLamport) };
}

/**
 * Fold edits made WHILE a sync was in flight back into its outcome.
 *
 * `syncOnce` works on a copy taken before the request. Anything the user typed
 * during the round trip is in `current` and not in `outcome`, and assigning the
 * outcome straight into React state threw it away: the op was still queued, so
 * the server got it, but the phone's own screen reverted to the old value and
 * stayed there -- the edit had been pushed, so it never came back on a pull.
 *
 * Pure, and idempotent: replaying an op already present is a no-op.
 */
export function reconcileAfterSync(
  before: ClientData,
  current: ClientData,
  outcome: SyncOutcome,
): ClientData {
  const knownBefore = new Set(before.outbox.map(o => o.opId));
  const madeDuring = current.outbox.filter(o => !knownBefore.has(o.opId));

  const inOutcome = new Set(outcome.data.outbox.map(o => o.opId));
  const stillQueued = madeDuring.filter(o => !inOutcome.has(o.opId));

  const state = madeDuring.length === 0
    ? outcome.data.state
    : mergeOps(outcome.data.state, madeDuring).state;

  return {
    ...outcome.data,
    state,
    outbox: [...outcome.data.outbox, ...stillQueued],
    conflicts: outcome.data.conflicts.filter(c => !isMeaninglessConflict(c)),
  };
}

/**
 * Rebuild server-derived state from a snapshot, KEEPING the outbox.
 *
 * Used when the server's log no longer reaches back to this device's cursor.
 * The outbox must survive: those ops exist nowhere else, and throwing them away
 * to "start clean" would silently delete everything edited while offline.
 */
export async function fullResync(
  data: ClientData,
  transport: SyncTransport,
): Promise<ClientData> {
  const snap = await transport.snapshot(data.deviceId);

  let state = emptyState();
  for (const store of Object.keys(snap.stores) as SyncStore[]) {
    const snapshot = snap.stores[store];
    if (!snapshot) continue;
    const ops = snapshotToOps(state, {
      store, snapshot, device: 'pc-desktop', at: snap.serverTime,
    });
    state = mergeOps(state, ops).state;
  }
  // Adopt the server's clock so our next local op sorts after everything it has.
  state.lamport = Math.max(state.lamport, snap.lamport);
  // The device id matters for ordering, so ops rebuilt from a snapshot must not
  // be attributed to this phone -- they are the server's view, not our edits.

  // Replay the outbox on top, so unsent edits are still visible in the UI and
  // still queued to send.
  const replayed = mergeOps(state, data.outbox);

  return {
    ...data,
    state: replayed.state,
    cursor: snap.cursor,
    conflicts: mergeConflicts(data.conflicts, replayed.conflicts),
  };
}

// ─── Conflict list maintenance ───────────────────────────────────────────────

/** Add newly seen cards without duplicating one already on screen. */
export function mergeConflicts(
  open: readonly SyncConflict[],
  found: readonly SyncConflict[],
): SyncConflict[] {
  const out = open.filter(c => !isMeaninglessConflict(c));
  for (const c of found) {
    if (isMeaninglessConflict(c)) continue;
    const at = out.findIndex(
      x => x.store === c.store && x.entityId === c.entityId && x.field === c.field,
    );
    if (at === -1) out.push(c);
    else if (c.detectedAt >= out[at].detectedAt) out[at] = c;
  }
  return out;
}

/**
 * Drop cards the server no longer lists — answered on the other device.
 *
 * Cards the server has not seen yet (detected locally this round) are KEPT, or a
 * conflict would flicker away before you could answer it.
 */
export function reconcileConflicts(
  local: readonly SyncConflict[],
  fromServer: readonly SyncConflict[],
): SyncConflict[] {
  const serverIds = new Set(fromServer.map(c => c.id));
  const kept = local.filter(c => serverIds.has(c.id) && !isMeaninglessConflict(c));
  const known = new Set(kept.map(c => c.id));
  for (const c of fromServer) {
    if (known.has(c.id) || isMeaninglessConflict(c)) continue;
    known.add(c.id);
    kept.push(c);
  }
  return kept;
}

// ─── Retry pacing ────────────────────────────────────────────────────────────

/**
 * Delay before the next attempt, in ms.
 *
 * Capped at five minutes: a phone that has been out of range all day must not
 * end up waiting hours after it reconnects. Real reconnection is driven by
 * network events; this is only the fallback poll.
 */
/**
 * The longest the loop will ever wait before trying again.
 *
 * WHY IT IS THIRTY SECONDS AND NOT FIVE MINUTES. The retry delay doubles on
 * each failure, and every edit made while offline is itself a failed attempt —
 * so a handful of changes made on a plane put the app into a multi-minute wait.
 * Reconnecting to Wi-Fi is invisible to it: nothing tells the app the network is
 * back, so it simply sits out the rest of that wait while the user watches
 * their changes not sync. Closing and reopening the app fixed it, which is a
 * horrible thing to have to know.
 *
 * A short cap is what makes reconnecting feel automatic. The cost is one request
 * every thirty seconds while the PC is genuinely off — and only while the app is
 * in the foreground, since Android stops the timer as soon as it is not.
 */
export const MAX_RETRY_MS = 30_000;

export function backoffDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const base = 2_000 * 2 ** Math.min(consecutiveFailures - 1, 8);
  return Math.min(base, MAX_RETRY_MS);
}

/** Deterministic jitter, so several devices do not retry in lockstep. */
export function withJitter(delay: number, seed: number): number {
  if (delay === 0) return 0;
  const frac = ((seed * 9301 + 49297) % 233280) / 233280;
  return Math.round(delay * (0.85 + frac * 0.3));
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
