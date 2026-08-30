// ─── Server-side sync engine ─────────────────────────────────────────────────
// Owns the durable half of offline sync: the operation log, the merged state,
// and the open conflicts, per user, on disk beside the existing file database.
//
// It sits BETWEEN the existing file stores and the phone:
//
//   PC saves database.json ──► ingestSnapshot() ──► ops appended to the log
//   phone POSTs ops        ──► pushOps()        ──► files rewritten on disk
//   phone GETs since=N     ──► pullOps()        ──► the ops it has not seen
//
// Files (per user, in database/users/<name>/):
//   sync-state.json      merged field state + lamport clock
//   sync-oplog.json      the operation log, pruned once every device has it
//   sync-conflicts.json  open conflict cards, cleared as they are answered
//   sync-devices.json    each device's cursor and last-seen time
//
// DURABILITY RULE: the log is appended and fsynced BEFORE the files are
// rewritten. If the process dies mid-save the log is the source of truth and the
// files are rebuilt from it on next start — the reverse order would lose ops.

import fsp from 'fs/promises';
import path from 'path';
import {
  emptyState,
  isMeaninglessConflict,
  mergeOps,
  type SyncConflict,
  type SyncOp,
  type SyncState,
  type SyncStore,
  sanitizeState,
  DELETED_FIELD,
  getOwn,
  isDeleted,
  type EntityState,
} from './src/lib/sync';
import {
  canonicalJson,
  opsToSnapshot,
  snapshotToOps,
  type Snapshot,
  type StoreAdapter,
} from './src/lib/syncBridge';

export { baseIdOf, canonicalJson } from './src/lib/syncBridge';

/** The stores that sync to the phone, and the file each one lives in. */
export const SYNCED_STORES: Record<SyncStore, string | null> = {
  events: 'database.json',
  tasks: 'tasks.json',
  categories: null,      // lives inside settings.json
  taskLists: null,       // lives inside settings.json
  settings: 'settings.json',
  prayerDone: 'prayer-done.json',
  focusSessions: null,   // append-only history; synced separately, not merged
};

/** Stores whose whole content is one JSON object keyed by id. */
export const FILE_STORES: SyncStore[] = ['events', 'tasks', 'settings', 'focusSessions'];

export interface DeviceRecord {
  deviceId: string;
  name?: string;
  cursor: number;
  lastSeen: number;
  platform?: string;
}

export interface SyncBundle {
  state: SyncState;
  log: SyncOp[];
  conflicts: SyncConflict[];
  devices: Record<string, DeviceRecord>;
  /** Next log position to hand out. Strictly increasing, never reused. */
  seq: number;
  /** Highest `seq` that has been trimmed away. A device whose cursor is below
   *  this can no longer be caught up incrementally and must take a snapshot. */
  trimmedBelow: number;
}

export interface SyncPaths {
  statePath: string;
  logPath: string;
  conflictsPath: string;
  devicesPath: string;
  metaPath: string;
}

export function getSyncPaths(dbDir: string): SyncPaths {
  return {
    statePath: path.join(dbDir, 'sync-state.json'),
    logPath: path.join(dbDir, 'sync-oplog.json'),
    conflictsPath: path.join(dbDir, 'sync-conflicts.json'),
    devicesPath: path.join(dbDir, 'sync-devices.json'),
    metaPath: path.join(dbDir, 'sync-meta.json'),
  };
}

/** The id the PC's own writes are attributed to. Stable, so its ops order
 *  consistently against the phone's forever. */
export const PC_DEVICE_ID = 'pc-desktop';

/** How many ops to keep beyond the slowest device, so a phone that is briefly
 *  behind does not have to do a full resync. */
export const LOG_SLACK = 500;

// ─── Loading and saving ──────────────────────────────────────────────────────

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fsp.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** Atomic write: a torn sync-state.json would be worse than a missing one, so
 *  everything lands in a temp file and is renamed into place. */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf-8');
  await fsp.rename(tmp, file);
}

export function emptyBundle(): SyncBundle {
  return { state: emptyState(), log: [], conflicts: [], devices: {}, seq: 0, trimmedBelow: 0 };
}

export async function loadBundle(dbDir: string): Promise<SyncBundle> {
  const p = getSyncPaths(dbDir);
  const [state, log, conflicts, devices, meta] = await Promise.all([
    readJson<SyncState>(p.statePath, emptyState()),
    readJson<SyncOp[]>(p.logPath, []),
    readJson<SyncConflict[]>(p.conflictsPath, []),
    readJson<Record<string, DeviceRecord>>(p.devicesPath, {}),
    readJson<{ seq?: number; trimmedBelow?: number }>(p.metaPath, {}),
  ]);
  // Guard against a hand-edited or half-written state file.
  const bundle: SyncBundle = {
    // Sanitised on the way in: members mis-keyed by an older build are already
    // saved in this file, and add-wins guarantees nothing would ever clear them.
    state: state && typeof state === 'object' && state.entities
      ? sanitizeState(state) : emptyState(),
    log: Array.isArray(log) ? log.filter(o => o && typeof o === 'object') : [],
    conflicts: (Array.isArray(conflicts) ? conflicts : [])
      .filter(c => c && typeof c === 'object' && c.winner && c.loser)
      // Cards written by an older build, where two devices agreeing on a value
      // still produced a card. They can never be answered usefully.
      .filter(c => !isMeaninglessConflict(c)),
    devices: devices && typeof devices === 'object' && !Array.isArray(devices) ? devices : {},
    seq: 0,
    trimmedBelow: 0,
  };

  // ── Migrating a log written before positions existed ──
  // Cursors used to be lamport counters, which are NOT monotonic in log order.
  // Renumbering is safe; carrying the old cursors over is not, because a lamport
  // cursor read as a position would skip ops. Everyone re-pulls once instead —
  // a merge is idempotent, so the only cost is one larger response.
  const needsRenumber = bundle.log.some(o => typeof o.seq !== 'number');
  if (needsRenumber) {
    bundle.log = bundle.log.map((o, i) => ({ ...o, seq: i + 1 }));
    bundle.seq = bundle.log.length;
    bundle.trimmedBelow = 0;
    for (const id of Object.keys(bundle.devices)) {
      bundle.devices[id] = { ...bundle.devices[id]!, cursor: 0 };
    }
  } else {
    const maxSeq = bundle.log.reduce((m, o) => Math.max(m, o.seq ?? 0), 0);
    const savedSeq = typeof meta?.seq === 'number' && Number.isFinite(meta.seq) ? meta.seq : 0;
    bundle.seq = Math.max(maxSeq, Math.floor(savedSeq));
    const savedTrim = typeof meta?.trimmedBelow === 'number' && Number.isFinite(meta.trimmedBelow)
      ? Math.floor(meta.trimmedBelow) : 0;
    bundle.trimmedBelow = Math.max(0, savedTrim);
  }
  return bundle;
}

/** Append ops to the log, stamping each with its position. Pure. */
export function appendToLog(
  bundle: SyncBundle,
  ops: readonly SyncOp[],
): { log: SyncOp[]; seq: number } {
  let seq = bundle.seq;
  const added = ops.map(op => { seq += 1; return { ...op, seq }; });
  return { log: [...bundle.log, ...added], seq };
}

/**
 * What was last written for one directory, by reference.
 *
 * WHY THIS EXISTS. Every sync request used to rewrite the whole bundle, whether
 * or not anything had changed. An idle poll that returned zero operations still
 * wrote the log and the state — together well over half a megabyte — and a poll
 * is two requests, because the device acknowledges afterwards. At one poll every
 * ten seconds that is around ten gigabytes of pointless writes a day, on an SSD,
 * for a planner nobody is touching.
 *
 * Reference comparison is exact here, not an approximation: `mergeOps`,
 * `appendToLog` and `acknowledge` all build new objects when they change
 * something and return the original when they do not. So an unchanged reference
 * genuinely means unchanged content, and an acknowledgement — which only ever
 * touches `devices` — writes one small file instead of five large ones.
 */
const lastWritten = new Map<string, {
  log: unknown; state: unknown; conflicts: unknown; devices: unknown;
  seq: number; trimmedBelow: number;
}>();

export async function saveBundle(dbDir: string, bundle: SyncBundle): Promise<void> {
  const p = getSyncPaths(dbDir);
  const seen = lastWritten.get(dbDir);

  // The LOG FIRST, always. If the process dies after this line and before the
  // rest, nothing is lost: state and conflicts are both derivable from the log.
  if (!seen || seen.log !== bundle.log) {
    await writeJsonAtomic(p.logPath, bundle.log);
  }

  const writes: Promise<void>[] = [];
  if (!seen || seen.state !== bundle.state) {
    writes.push(writeJsonAtomic(p.statePath, bundle.state));
  }
  if (!seen || seen.conflicts !== bundle.conflicts) {
    writes.push(writeJsonAtomic(p.conflictsPath, bundle.conflicts));
  }
  if (!seen || seen.devices !== bundle.devices) {
    writes.push(writeJsonAtomic(p.devicesPath, bundle.devices));
  }
  if (!seen || seen.seq !== bundle.seq || seen.trimmedBelow !== bundle.trimmedBelow) {
    writes.push(writeJsonAtomic(p.metaPath, { seq: bundle.seq, trimmedBelow: bundle.trimmedBelow }));
  }
  await Promise.all(writes);

  // Recorded only after every write has landed, so a failure part-way through
  // leaves us believing less than we wrote rather than more.
  lastWritten.set(dbDir, {
    log: bundle.log,
    state: bundle.state,
    conflicts: bundle.conflicts,
    devices: bundle.devices,
    seq: bundle.seq,
    trimmedBelow: bundle.trimmedBelow,
  });
}

/** Forget what we believe is on disk. For tests, and for a changed user. */
export function forgetWrittenBundle(dbDir?: string): void {
  if (dbDir === undefined) lastWritten.clear();
  else lastWritten.delete(dbDir);
}

// ─── Conflict bookkeeping ────────────────────────────────────────────────────

/** Add newly detected conflicts without duplicating ones already open. */
export function addConflicts(
  open: readonly SyncConflict[],
  found: readonly SyncConflict[],
): SyncConflict[] {
  const out = [...open];
  const byTarget = new Map(out.map((c, i) => [`${c.store} ${c.entityId} ${c.field}`, i]));

  for (const c of found) {
    // Two devices that wrote the same value agreed; there is nothing to ask.
    if (isMeaninglessConflict(c)) continue;
    const key = `${c.store} ${c.entityId} ${c.field}`;
    const at = byTarget.get(key);
    if (at === undefined) {
      byTarget.set(key, out.length);
      out.push(c);
      continue;
    }
    // A newer disagreement about the SAME field replaces the older card rather
    // than stacking a second one you would have to answer twice.
    if (c.detectedAt >= out[at].detectedAt) out[at] = c;
  }
  return out;
}

/** Drop conflicts that the given ops have settled — the user answered, or the
 *  field moved on for another reason and the question is now meaningless. */
export function clearResolvedConflicts(
  open: readonly SyncConflict[],
  ops: readonly SyncOp[],
): SyncConflict[] {
  const settled = new Set(ops.map(o => `${o.store} ${o.entityId} ${o.field}`));
  return open.filter(c => {
    if (isMeaninglessConflict(c)) return false;
    if (settled.has(`${c.store} ${c.entityId} ${c.field}`)) return false;
    // A delete card is also answered by any write to the tombstone field.
    if (c.kind === 'delete' && settled.has(`${c.store} ${c.entityId} __deleted`)) return false;
    return true;
  });
}

// ─── The three operations the server performs ────────────────────────────────

export interface IngestResult {
  bundle: SyncBundle;
  ops: SyncOp[];
  conflicts: SyncConflict[];
}

/**
 * The PC just wrote a file. Turn it into ops and fold them in.
 *
 * Emits nothing when the file is unchanged, which is what keeps an autosave loop
 * from generating an endless op stream.
 */
export function ingestSnapshot(
  bundle: SyncBundle,
  opts: {
    store: SyncStore;
    snapshot: Snapshot;
    at: number;
    device?: string;
    /** What was on disk before this write. See `snapshotToOps`. */
    baseline?: Snapshot;
    detectDeletes?: boolean;
    /** Believe what the file contains, ignore what it omits. See snapshotToOps. */
    additive?: boolean;
  },
): IngestResult {
  const device = opts.device ?? PC_DEVICE_ID;
  const ops = snapshotToOps(bundle.state, {
    store: opts.store,
    snapshot: opts.snapshot,
    device,
    at: opts.at,
    baseline: opts.baseline,
    detectDeletes: opts.detectDeletes,
    additive: opts.additive,
  });
  if (ops.length === 0) return { bundle, ops: [], conflicts: [] };

  const merged = mergeOps(bundle.state, ops);
  const appended = appendToLog(bundle, ops);
  return {
    bundle: {
      ...bundle,
      state: merged.state,
      log: appended.log,
      seq: appended.seq,
      conflicts: clearResolvedConflicts(
        addConflicts(bundle.conflicts, merged.conflicts),
        ops.filter(o => o.device === device && merged.conflicts.length === 0),
      ),
      devices: bundle.devices,
    },
    ops: appended.log.slice(appended.log.length - ops.length),
    conflicts: merged.conflicts,
  };
}

export interface PushResult {
  bundle: SyncBundle;
  /** Stores whose file on disk is now out of date and must be rewritten. */
  dirtyStores: SyncStore[];
  conflicts: SyncConflict[];
  /** Ops that were duplicates or stale; reported so a client can stop resending. */
  ignored: number;
}

/**
 * A device pushed its offline edits.
 *
 * Ops the server already has are ignored rather than rejected, because a phone
 * that loses the response to a successful push WILL resend — and a resend must
 * be harmless, not a duplicate event.
 */
export function pushOps(
  bundle: SyncBundle,
  opts: { ops: readonly SyncOp[]; deviceId: string; at: number; name?: string; platform?: string },
): PushResult {
  const fresh = opts.ops.filter(op => !bundle.state.applied[op.opId]);
  const contested = contestedDeletes(bundle.state, fresh);
  const merged = mergeOps(bundle.state, opts.ops);

  const dirty = new Set<SyncStore>();
  for (const op of merged.appliedOps) dirty.add(op.store);

  const prev = bundle.devices[opts.deviceId];
  const devices: Record<string, DeviceRecord> = {
    ...bundle.devices,
    [opts.deviceId]: {
      deviceId: opts.deviceId,
      name: opts.name ?? prev?.name,
      platform: opts.platform ?? prev?.platform,
      // A push never advances the pushing device's READ cursor. Its own ops come
      // back on the next pull (which is what lets a phone that wiped its local
      // database recover everything it ever wrote), and it acknowledges them
      // like anyone else's.
      cursor: prev?.cursor ?? 0,
      lastSeen: opts.at,
    },
  };

  const appended = appendToLog(bundle, fresh);

  return {
    bundle: {
      ...bundle,
      state: merged.state,
      log: appended.log,
      seq: appended.seq,
      conflicts: clearResolvedConflicts(
        addConflicts(addConflicts(bundle.conflicts, merged.conflicts), contested),
        // A device'''s own writes answer its own open cards for that field --
        // except the ones those very writes just raised, which would otherwise
        // clear themselves the instant they appeared.
        fresh.filter(o => ![...merged.conflicts, ...contested].some(
          c => c.store === o.store && c.entityId === o.entityId && c.field === o.field)),
      ),
      devices,
    },
    dirtyStores: [...dirty],
    conflicts: [...merged.conflicts, ...contested],
    ignored: opts.ops.length - fresh.length,
  };
}

/**
 * Edits that arrived for an item this server has already tombstoned.
 *
 * WHY THIS CANNOT BE DECIDED BY THE CLOCK. A delete-versus-edit race is only
 * visible as a race if the two are concurrent, and lamport stamps cannot show
 * that here: the phone can only out-rank a delete it has already seen, and once
 * it has seen one the item is gone from its screen and it can no longer edit it.
 * Comparing stamps therefore lets a delete beat EVERY phone edit in existence,
 * silently — which is exactly the rule "deletion never silently beats a
 * concurrent edit" was written to prevent.
 *
 * Arrival gives the answer that ordering cannot. A tombstoned entity is not
 * rendered, so a device physically could not have produced this edit from a copy
 * that contained the delete: the two ARE concurrent, whatever the stamps say.
 *
 * This does not reintroduce the order-dependence that once made peers diverge.
 * The merged STATE is untouched — the delete still wins the merge, deterministic
 * as ever. All that is raised is a card, and cards live only here, in the
 * server's bundle, from where both devices read the same list.
 */
function contestedDeletes(before: SyncState, fresh: readonly SyncOp[]): SyncConflict[] {
  const out = new Map<string, SyncConflict>();

  for (const op of fresh) {
    // A delete racing a delete is not a question worth asking.
    if (op.field === DELETED_FIELD) continue;

    // getOwn, never plain indexing: an entityId of "__proto__" otherwise returns
    // Object.prototype, which has no `fields` and takes the whole push down.
    const byId = getOwn(before.entities as Record<string, unknown>, op.store) as
      Record<string, EntityState> | undefined;
    const ent = byId ? getOwn(byId, op.entityId) : undefined;
    if (!ent || !ent.fields || !isDeleted(ent)) continue;

    const del = getOwn(ent.fields, DELETED_FIELD);
    // Deleted and edited by the same device is just that device changing its
    // mind in the order it chose; there is nothing to reconcile.
    if (!del || del.device === op.device) continue;

    const key = `${op.store} ${op.entityId}`;
    const existing = out.get(key);
    // One card per item, naming its newest edit, so a batch of twenty ticks does
    // not become twenty identical questions.
    if (existing && existing.winner.lamport >= op.lamport) continue;

    out.set(key, {
      id: [
        `${del.lamport}@${del.device}`,
        `${op.lamport}@${op.device}`,
      ].sort().join('|'),
      kind: 'delete',
      store: op.store,
      entityId: op.entityId,
      field: DELETED_FIELD,
      winner: { value: false, device: op.device, at: op.at, lamport: op.lamport },
      loser: { value: true, device: del.device, at: del.at, lamport: del.lamport },
      detectedAt: Math.max(op.at, del.at),
    });
  }

  return [...out.values()];
}

export interface PullResult {
  ops: SyncOp[];
  cursor: number;
  conflicts: SyncConflict[];
  /** True when the device is too far behind for the log to cover it and must
   *  take a full snapshot instead. Never guess — resuming from a pruned log
   *  would silently skip changes. */
  needsFullResync: boolean;
}

export function pullOps(
  bundle: SyncBundle,
  opts: { deviceId: string; since: number },
): PullResult {
  // Two ways a cursor can be unusable, and both must end in a full resync.
  //
  // BELOW THE LOG: everything at or below `trimmedBelow` has been pruned.
  //
  // ABOVE THE HEAD: the cursor is not a position this log ever issued. That is
  // not hypothetical — cursors used to be lamport counters, and a device that
  // stored one from that era asks for `since = 2203` against a log whose head is
  // 951. Nothing is ever greater than 2203, so the device receives NOTHING, for
  // ever, while still acknowledging happily. Worse, this used to answer with
  // `max(since, seq)`, handing the bad cursor straight back so the device stored
  // it again — a silent, self-sealing deadlock in which PC changes simply never
  // reached the phone and no error was raised anywhere.
  const needsFullResync = opts.since < bundle.trimmedBelow || opts.since > bundle.seq;

  // NOT filtered by device. A phone whose local database was cleared, or
  // reinstalled onto the same device id, has to be able to get its OWN history
  // back — it is the only copy it has lost. Merging is idempotent, so a device
  // receiving its own ops again costs nothing.
  const ops = needsFullResync ? [] : bundle.log.filter(op => (op.seq ?? 0) > opts.since);
  return {
    ops,
    // ALWAYS the head of this log, never the caller's own number. The server is
    // the only authority on its positions; echoing back whatever it was handed
    // is what let a nonsense cursor survive indefinitely.
    cursor: bundle.seq,
    conflicts: bundle.conflicts.filter(c => !isMeaninglessConflict(c)),
    needsFullResync,
  };
}

/** A device confirms it has stored everything up to `cursor`. */
export function acknowledge(
  bundle: SyncBundle,
  opts: { deviceId: string; cursor: number; at: number },
): SyncBundle {
  const prev = bundle.devices[opts.deviceId];
  const devices: Record<string, DeviceRecord> = {
    ...bundle.devices,
    [opts.deviceId]: {
      deviceId: opts.deviceId,
      name: prev?.name,
      platform: prev?.platform,
      // Never move a cursor backwards: a stale retry must not un-acknowledge.
      // Never above the head either: a device cannot have seen what does not
      // exist, and a cursor past the head would make it skip the next ops.
      cursor: Math.min(bundle.seq, Math.max(prev?.cursor ?? 0, opts.cursor)),
      lastSeen: opts.at,
    },
  };
  const trimmed = trimLog(bundle.log, devices);
  return {
    ...bundle,
    devices,
    log: trimmed.log,
    trimmedBelow: Math.max(bundle.trimmedBelow, trimmed.trimmedBelow),
  };
}

/** Trim the log to what the slowest known device still needs, plus slack. */
export function trimLog(
  log: readonly SyncOp[],
  devices: Record<string, DeviceRecord>,
): { log: SyncOp[]; trimmedBelow: number } {
  const cursors = Object.values(devices).map(d => d.cursor);
  if (cursors.length === 0) return { log: [...log], trimmedBelow: 0 };
  const slowest = Math.min(...cursors);
  const below = Math.max(0, slowest - LOG_SLACK);
  if (below <= 0) return { log: [...log], trimmedBelow: 0 };
  return { log: log.filter(op => (op.seq ?? 0) > below), trimmedBelow: below };
}

// ─── Rewriting the files after a phone push ──────────────────────────────────

/**
 * Rebuild one store's file from sync state, preserving the PC-only fields that
 * are on disk. Returns the new content, or null when nothing changed — the
 * caller must not write in that case, or the db-stream fires and every open
 * window reloads for nothing.
 */
export async function rebuildStoreFile(
  filePath: string,
  bundle: SyncBundle,
  store: SyncStore,
  adapter?: StoreAdapter,
): Promise<string | null> {
  const raw = await readJson<unknown>(filePath, {});
  const onDisk = adapter ? adapter.toSnapshot(raw) : (raw as Snapshot);
  const next = opsToSnapshot(bundle.state, store, onDisk);

  // Compare CANONICALLY, not as raw text. The rebuild emits keys in sorted order
  // while the PC app writes them in insertion order, so a byte comparison would
  // report "changed" on every single sync — rewriting database.json, firing the
  // db-stream, and making every open window reload for no reason at all.
  if (canonicalJson(next) === canonicalJson(onDisk)) return null;

  // Through the adapter on the way out too, so the parts of the file that never
  // synced are carried through rather than dropped.
  const body = adapter ? adapter.fromSnapshot(next, raw) : next;
  return JSON.stringify(body, null, 2);
}

/** Seed the sync state from files that already exist, the first time a user's
 *  planner is synced. Existing data must appear on the phone without migration. */
export async function seedFromFiles(
  bundle: SyncBundle,
  files: Partial<Record<SyncStore, string>>,
  at: number,
): Promise<SyncBundle> {
  let out = bundle;
  for (const store of FILE_STORES) {
    const file = files[store];
    if (!file) continue;
    const snapshot = await readJson<Snapshot>(file, {});
    if (!snapshot || typeof snapshot !== 'object') continue;
    out = ingestSnapshot(out, { store, snapshot, at }).bundle;
  }
  return out;
}
