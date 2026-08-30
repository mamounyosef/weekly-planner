// ─── Sync service ────────────────────────────────────────────────────────────
// The stateful layer around the pure engine in `sync-server.ts`: one in-memory
// bundle per user, a serialising queue so two requests can never interleave, and
// the HTTP routes the phone talks to.
//
// WHY A QUEUE: every sync request is read-modify-write on the same bundle. Node
// is single threaded but `await` is not atomic — a push and a pull that both
// `await loadBundle()` before either writes would each save a bundle missing the
// other's ops, and the loser's edits would vanish. Every mutation therefore runs
// inside `withUser()`, which guarantees one at a time per user.
//
// The queue is per USER, not global: two accounts syncing at once must not block
// each other, and they share no state.

import fsp from 'fs/promises';
import path from 'path';
import {
  acknowledge,
  appendToLog,
  FILE_STORES,
  ingestSnapshot,
  loadBundle,
  pullOps,
  pushOps,
  rebuildStoreFile,
  saveBundle,
  seedFromFiles,
  trimLog,
  type SyncBundle,
} from './sync-server';
import {
  arrayAdapter,
  baseIdOf,
  opsToSnapshot,
  settingsAdapter,
  type Snapshot,
  type StoreAdapter,
} from './src/lib/syncBridge';
import {
  applySharedSettings,
  SHARED_SETTING_KEYS,
  sharedSettingsOf,
} from './src/lib/settingsScope';

/** Set form of the shared keys, for the per-op check in `validateOp`. */
const SHARED_SETTING_SET: ReadonlySet<string> = new Set(SHARED_SETTING_KEYS);
import {
  DELETED_FIELD,
  resolveConflict,
  mergeOps,
  type SyncConflict,
  type SyncOp,
  type SyncStore,
} from './src/lib/sync';

export interface UserSyncPaths {
  dbDir: string;
  dbPath: string;
  tasksPath: string;
  /** Optional so an older caller keeps working; settings simply do not sync. */
  settingsPath?: string;
  /** Focus session history. An array file, so it needs its own adapter. */
  focusPath?: string;
  /** Which prayers have been ticked off, per day. */
  prayerDonePath?: string;
  /**
   * The Aladhan month cache.
   *
   * Shared by every user rather than per-user, because it is a cache of a public
   * timetable rather than anyone's data. It syncs so the phone has the times
   * OFFLINE: prayer times are most wanted exactly where there is no signal, and
   * an app that needs the internet to tell you when Maghrib is has missed the
   * point.
   */
  prayerTimesPath?: string;
}

/**
 * How each store's file becomes a snapshot, where it is not already one.
 *
 * Only settings needs this. `database.json` and `tasks.json` are already maps of
 * records; `settings.json` is a single object of which only part may travel.
 */
const ADAPTERS: Partial<Record<SyncStore, StoreAdapter>> = {
  settings: settingsAdapter(sharedSettingsOf as any, applySharedSettings as any),
  // Sessions are ordered by when they began, which is also how the PC writes
  // them, so a rebuild produces the file the PC would have produced itself.
  focusSessions: arrayAdapter('startedAt'),
};

/** Which file each syncable store is written back to. */
export function storeFileOf(paths: UserSyncPaths, store: SyncStore): string | null {
  if (store === 'events') return paths.dbPath;
  if (store === 'tasks') return paths.tasksPath;
  if (store === 'settings') return paths.settingsPath ?? null;
  if (store === 'focusSessions') return paths.focusPath ?? null;
  if (store === 'prayerDone') return paths.prayerDonePath ?? null;
  if (store === 'prayerTimes') return paths.prayerTimesPath ?? null;
  return null;
}

export interface SyncServiceOptions {
  /** Called after files change on disk so the db-stream can wake open windows. */
  onStoresChanged?: (username: string, stores: SyncStore[]) => void;
  now?: () => number;
}

export function createSyncService(opts: SyncServiceOptions = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Per-user in-memory bundle, so a sync poll does not re-read four files. */
  const cache = new Map<string, SyncBundle>();
  /** Per-user promise chain. The whole point of this module. */
  const queues = new Map<string, Promise<unknown>>();

  /**
   * What this service believes is in each planner file right now.
   *
   * THE CACHE IS NOT THE ONLY WRITER. Google Calendar sync rewrites
   * database.json, `runGoogleTasksSync` rewrites tasks.json, a backup restore
   * replaces both, and the user can edit them by hand. Diffing a new save
   * against a stale in-memory baseline produced ops for changes nobody made --
   * and, far worse, a rebuild that dropped every event the sync engine had never
   * been told about. So before ANY operation, each file is compared with what we
   * last saw and folded in if it moved. That single check is what makes
   * Google-imported events reach the phone at all, and what stops them being
   * deleted from disk the next time the phone pushes.
   */
  const lastSeen = new Map<string, Map<SyncStore, { raw: string; snapshot: Snapshot }>>();

  /**
   * `lastSeen` ON DISK. This file is not an optimisation — it is a correctness
   * requirement, and keeping it in memory only was the bug behind "I ticked it
   * on my phone and the PC un-ticked it again".
   *
   * THE FAILURE IT PREVENTS, exactly. The phone ticks an event. The op merges,
   * the log is saved, the planner file is rewritten. The dev server then
   * restarts (which happens often — there is a button for it). On the next sync
   * `lastSeen` is empty, so the service has no idea what the PC was looking at
   * when it last wrote database.json. The old code fell back to "the log's own
   * view", which asserts the file is a deliberate PC edit made against the
   * current log — the exact opposite of the truth. Every value the file lacked
   * was therefore read as "the PC cleared this", turned into revert ops, and
   * pushed to the phone. The tick vanished on both devices, permanently.
   *
   * Persisting it means a restart resumes with the right baseline, while a file
   * genuinely changed by someone else (Google sync, a restore, a hand edit)
   * still differs from what we last saw and is still ingested properly.
   */
  const SEEN_FILE = 'sync-seen.json';
  const seenLoaded = new Set<string>();
  const seenDirty = new Set<string>();

  async function loadSeen(username: string, paths: UserSyncPaths): Promise<void> {
    if (seenLoaded.has(username)) return;
    seenLoaded.add(username);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(path.join(paths.dbDir, SEEN_FILE), 'utf-8'));
    } catch {
      return;   // absent or unreadable: fall back to additive ingest, which is safe
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const into = seenOf(username);
    for (const store of FILE_STORES) {
      const raw = (parsed as Record<string, unknown>)[store];
      if (typeof raw !== 'string' || raw === '') continue;
      try {
        const snapshot = JSON.parse(raw);
        if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
          into.set(store, { raw, snapshot });
        }
      } catch { /* a half-written baseline is no baseline */ }
    }
  }

  async function saveSeen(username: string, paths: UserSyncPaths): Promise<void> {
    if (!seenDirty.has(username)) return;
    seenDirty.delete(username);
    const out: Record<string, string> = {};
    for (const [store, rec] of seenOf(username)) out[store] = rec.raw;
    const file = path.join(paths.dbDir, SEEN_FILE);
    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(out), 'utf-8');
      await fsp.rename(tmp, file);
    } catch (err) {
      // Not fatal. A missing baseline costs one additive ingest next time, which
      // is conservative rather than wrong — so this must never fail a sync.
      seenDirty.add(username);
      console.error('[sync] could not persist the disk baseline:', err);
    }
  }

  /** Record what a planner file now contains, and remember to persist it. */
  function rememberSeen(
    username: string,
    store: SyncStore,
    rec: { raw: string; snapshot: Snapshot },
  ): void {
    seenOf(username).set(store, rec);
    seenDirty.add(username);
  }

  /**
   * The last few versions of each store the server has handed to, or received
   * from, the PC app — keyed by the id the app stamps onto its next save.
   *
   * This is what makes a whole-file save safe. Without it the server can only
   * ask "does this save differ from the file on disk?", and the answer is yes
   * for everything the phone changed in the meantime — so a routine PC autosave
   * reverted the phone's tick and TOMBSTONED anything the phone had just added.
   * With it the question becomes "what did the writer change, relative to the
   * copy it actually had?", which is the only question a merge can answer.
   *
   * Bounded: only the newest few matter, and an id nobody recognises simply
   * falls back to the old behaviour rather than failing the save.
   */
  /**
   * Devices parked on an empty pull, waiting to be told something changed.
   *
   * WHY WAITING BEATS ASKING. The phone can reach the PC; the PC can never reach
   * the phone. That asymmetry is the only reason a timer existed at all — a
   * change made on the phone syncs the instant it is made, while a change made
   * on the PC could not be delivered and had to be discovered. Polling for it
   * every ten seconds meant a full sync cycle six times a minute forever, and
   * still up to ten seconds of staleness.
   *
   * Holding the request inverts it: the phone asks once and the server answers
   * the moment the log moves. Changes arrive as fast as the network allows, and
   * an idle planner costs one parked connection instead of endless work.
   *
   * NEVER held inside `withUser`. Parking a request while holding the per-user
   * queue would block every other request for that user — including the very
   * writes that would wake it.
   */
  const waiters = new Map<string, Set<() => void>>();

  function notifyWaiters(username: string): void {
    const set = waiters.get(username);
    if (!set || set.size === 0) return;
    // Copied first: a waiter removes itself as it runs.
    for (const wake of [...set]) wake();
  }

  function park(username: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      let set = waiters.get(username);
      if (!set) { set = new Set(); waiters.set(username, set); }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set!.delete(wake);
        if (set!.size === 0) waiters.delete(username);
        resolve();
      };
      const wake = finish;
      const timer = setTimeout(finish, ms);
      set.add(wake);
    });
  }

  /**
   * When each user's files were last checked against the log.
   *
   * Reconciling on every single request was the right call for correctness and
   * the wrong one for cost: it re-read and re-serialised both planner files each
   * time. It is kept as a periodic sweep instead — anything that actually
   * changed still reconciles immediately, and the sweep is only there to heal a
   * write that went missing while nothing else was happening.
   */
  const lastSweep = new Map<string, number>();
  const SWEEP_EVERY_MS = 60_000;

  const BASE_HISTORY = 40;
  const bases = new Map<string, Map<SyncStore, Map<string, Snapshot>>>();

  function noteBase(username: string, store: SyncStore, snapshot: Snapshot): string {
    let byStore = bases.get(username);
    if (!byStore) { byStore = new Map(); bases.set(username, byStore); }
    let byId = byStore.get(store);
    if (!byId) { byId = new Map(); byStore.set(store, byId); }
    const id = baseIdOf(snapshot);
    byId.delete(id);            // re-insert so it counts as the newest
    // CLONED. The caller keeps editing the object it handed over -- that is what
    // a whole-map save IS -- and a baseline that mutates underneath us describes
    // the wrong version, which is worse than having no baseline at all.
    byId.set(id, structuredClone(snapshot));
    while (byId.size > BASE_HISTORY) {
      const oldest = byId.keys().next();
      if (oldest.done) break;
      byId.delete(oldest.value);
    }
    return id;
  }

  function lookupBase(username: string, store: SyncStore, id: unknown): Snapshot | undefined {
    if (typeof id !== 'string' || id.length === 0) return undefined;
    return bases.get(username)?.get(store)?.get(id);
  }

  const seenOf = (username: string) => {
    let m = lastSeen.get(username);
    if (!m) { m = new Map(); lastSeen.set(username, m); }
    return m;
  };

  async function readSnapshotFile(
    file: string,
    adapter?: StoreAdapter,
  ): Promise<{ raw: string; snapshot: Snapshot }> {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch {
      return { raw: '', snapshot: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      // A corrupt or truncated planner file must never be read as "the user
      // deleted everything". Report it as unreadable and leave the log alone.
      //
      // AN ARRAY IS NOT CORRUPT WHEN THE STORE IS ONE. This guard was written
      // when every synced file was a map of records, so it rejected arrays out
      // of hand — and `focus-sessions.json`, which is a list, was therefore read
      // as unreadable every single time and never entered the log at all. Where
      // a store has an adapter, the adapter decides what its file may look like.
      if (parsed === null || typeof parsed !== 'object') return { raw: '', snapshot: {} };
      if (!adapter && Array.isArray(parsed)) return { raw: '', snapshot: {} };
      // `raw` stays the FILE's text, not the snapshot's: it is the baseline for
      // "has this file changed since we last looked", and comparing a derived
      // view instead would miss an edit to the half that does not sync.
      return { raw, snapshot: adapter ? adapter.toSnapshot(parsed) : (parsed as Snapshot) };
    } catch {
      return { raw: '', snapshot: {} };
    }
  }

  /**
   * Fold any change made to the planner files by someone other than this service
   * into the log. Returns the bundle, changed or not.
   */
  async function refreshFromDisk(
    username: string,
    paths: UserSyncPaths,
    bundle: SyncBundle,
    /** store → the copy the writer of the newest file content started from. */
    writerBase?: Map<SyncStore, Snapshot>,
    /** Filled in with what the refresh did, for the caller's report. */
    stats?: { ops: number; stores: SyncStore[] },
  ): Promise<SyncBundle> {
    let out = bundle;
    const seen = seenOf(username);
    for (const store of FILE_STORES) {
      const file = storeFileOf(paths, store);
      if (!file) continue;
      const adapter = ADAPTERS[store];
      const current = await readSnapshotFile(file, adapter);
      if (current.raw === '') {
        // Unreadable, truncated or not an object. Reading that as "the user
        // deleted everything" would be catastrophic, so the log is left alone --
        // but the file is offered for rebuild, which repairs it from the log
        // instead of leaving both windows staring at an empty planner.
        if (stats) stats.stores.push(store);
        continue;
      }
      const known = seen.get(store);
      if (known && known.raw === current.raw) continue;
      noteBase(username, store, current.snapshot);
      // Whatever we last saw in the file is exactly what the writer was looking
      // at, so only its real changes become ops.
      const baseline = writerBase?.get(store) ?? known?.snapshot;
      const res = ingestSnapshot(out, {
        store,
        snapshot: current.snapshot,
        at: now(),
        baseline,
        // NO BASELINE, NO REMOVALS. Without a record of what the writer started
        // from there is no way to tell a deliberate clear from a file that is
        // merely older than the log, and guessing "clear" silently reverts
        // edits that were already merged. Additions and changes are still taken:
        // a stale file's error is always omission, never invention.
        additive: baseline === undefined,
        // A store whose file holds exactly one entity can never express a
        // deletion by omission, so an empty read must not tombstone it.
        detectDeletes: adapter ? adapter.detectDeletes : true,
      });
      out = res.bundle;
      if (stats) { stats.ops += res.ops.length; stats.stores.push(store); }
      rememberSeen(username, store, current);
    }
    return out;
  }

  /**
   * Run `fn` with exclusive access to one user's bundle, then persist whatever
   * it returns. Serialised: the next call waits, even if this one throws.
   */
  function withUser<T>(
    username: string,
    paths: UserSyncPaths,
    fn: (
      bundle: SyncBundle,
      refreshed: { ops: number; stores: SyncStore[] },
    ) => Promise<{ bundle: SyncBundle; result: T; dirty?: SyncStore[] }>,
    writerBase?: Map<SyncStore, Snapshot>,
  ): Promise<T> {
    const prev = queues.get(username) ?? Promise.resolve();
    const next = prev.then(async () => {
      await loadSeen(username, paths);
      let bundle = cache.get(username);
      if (!bundle) {
        bundle = await loadBundle(paths.dbDir);
        // Seeding is decided from the LOG, not from a per-process flag. A
        // dev-server restart used to re-seed an already-populated log, which
        // re-created every item the phone had deleted -- the deletes came back
        // undone every time the PC rebooted. An empty log is the only honest
        // signal that nothing has ever been synced for this user.
        if (bundle.log.length === 0 && Object.keys(bundle.state.entities).length === 0) {
          const seeded = { events: paths.dbPath, tasks: paths.tasksPath };
          bundle = await seedFromFiles(bundle, seeded, now());

          // ONLY the stores that were actually seeded are recorded as seen.
          // Marking a store seen without ingesting it tells the next refresh
          // "this file has not moved", so it is skipped — for ever. That is
          // exactly how settings.json reached the log on no device: seeded by
          // nothing, believed unchanged by everything.
          for (const store of Object.keys(seeded) as SyncStore[]) {
            const file = storeFileOf(paths, store);
            if (file) rememberSeen(username, store, await readSnapshotFile(file, ADAPTERS[store]));
          }
        }
      }
      const refreshed: { ops: number; stores: SyncStore[] } = { ops: 0, stores: [] };
      // Captured BEFORE the refresh. A save made on the PC advances the log
      // inside `refreshFromDisk`, so comparing afterwards saw no change and left
      // every parked device waiting out its full timeout for news that had
      // already arrived.
      const seqBefore = bundle.seq;
      bundle = await refreshFromDisk(username, paths, bundle, writerBase, refreshed);

      const out = await fn(bundle, refreshed);
      cache.set(username, out.bundle);
      await saveBundle(paths.dbDir, out.bundle);

      // EVERY store, EVERY cycle — not just the ones an op happened to touch.
      //
      // The old code derived this from the ops applied in THIS request, which
      // made a missed write permanent. Miss it once — the process dies between
      // saving the log and writing the file, a virus scanner locks the rename,
      // a resent push is deduplicated so nothing looks dirty — and the file
      // disagrees with the log forever: no later request ever marks that store
      // dirty again, and the divergence then poisons everything downstream,
      // because the next whole-file save is diffed against a file the log has
      // already moved past.
      //
      // Reconciling unconditionally makes divergence self-healing instead, and
      // it is close to free: `rebuildStoreFile` compares canonically and returns
      // null — writing nothing, waking nobody — whenever the file already
      // agrees, which is the overwhelmingly common case.
      // Reconcile when something could have moved, and otherwise at most once a
      // minute. `rebuildStoreFile` still writes nothing when the file already
      // agrees, so this only removes work, never the self-healing itself.
      const moved = out.bundle !== bundle
        || (out.dirty ?? []).length > 0
        || refreshed.stores.length > 0;
      const due = now() - (lastSweep.get(username) ?? 0) >= SWEEP_EVERY_MS;

      if (moved || due) {
        lastSweep.set(username, now());
        const written = await writeDirtyStores(username, paths, out.bundle, FILE_STORES);
        if (written.length > 0) opts.onStoresChanged?.(username, written);
      }

      await saveSeen(username, paths);

      // Anything parked on an empty pull is owed an answer now.
      if (out.bundle.seq !== seqBefore) notifyWaiters(username);
      return out.result;
    });

    // Keep the chain alive even after a failure, or one bad request would wedge
    // that user's sync permanently.
    queues.set(username, next.catch(() => undefined));
    return next;
  }

  /** Write back only the stores that actually differ from what is on disk. */
  async function writeDirtyStores(
    username: string,
    paths: UserSyncPaths,
    bundle: SyncBundle,
    stores: SyncStore[],
  ): Promise<SyncStore[]> {
    const written: SyncStore[] = [];
    for (const store of stores) {
      const file = storeFileOf(paths, store);
      if (!file) continue;
      const adapter = ADAPTERS[store];
      const next = await rebuildStoreFile(file, bundle, store, adapter);
      if (next === null) continue;
      const tmp = `${file}.sync.tmp`;
      await fsp.writeFile(tmp, next, 'utf-8');
      await fsp.rename(tmp, file);
      // Remember our own write, or the very next request would read it back as
      // an external change and diff the file against a stale baseline.
      try {
        const parsed = JSON.parse(next);
        const snapshot = adapter ? adapter.toSnapshot(parsed) : (parsed as Snapshot);
        rememberSeen(username, store, { raw: next, snapshot });
        noteBase(username, store, snapshot);
      } catch { /* unreachable: `next` came from JSON.stringify */ }
      written.push(store);
    }
    return written;
  }

  return {
    /**
     * The PC saved a file. Fold it in. Safe to call on every write.
     *
     * The body is deliberately NOT used: the file on disk is authoritative,
     * because between the caller's write and this call Google sync may have
     * written again, and folding in a body that is already stale would revert
     * it. `withUser` re-reads whatever moved, which covers this write and any
     * other, from any writer.
     */
    async ingestFile(
      username: string,
      paths: UserSyncPaths,
      store: SyncStore,
      snapshot?: Snapshot,
      baseId?: string,
    ) {
      // The writer told us which copy it started from. If we still hold that
      // copy, it is the correct baseline for the diff; if we do not, fall back
      // to the last content we saw on disk, which is what this did before.
      // Through the adapter, so a settings save is compared as its shared half.
      const adapter = ADAPTERS[store];
      const base = lookupBase(username, store, baseId);
      const override = base ? new Map<SyncStore, Snapshot>([[store, base]]) : undefined;
      // The body the writer just saved becomes a base in its own right, so its
      // NEXT save resolves even if nothing else reads the file in between.
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        noteBase(username, store, adapter ? adapter.toSnapshot(snapshot) : snapshot);
      }
      return withUser(username, paths, async (bundle, refreshed) => ({
        bundle,
        // Always offered for rewrite. A whole-file save built from a stale copy
        // physically drops rows the log still holds, so the file has to be put
        // back the way the merged state says it should be — otherwise the
        // phone's new item stays visible to the phone and invisible on the PC
        // until something else happens to trigger a rebuild. `rebuildStoreFile`
        // writes nothing when the content already agrees, so this is free in the
        // overwhelmingly common case.
        dirty: [store],
        result: { store, ops: refreshed.ops, conflicts: [] as SyncConflict[] },
      }), override);
    },

    /** Fold in anything that changed on disk. The same thing, honestly named. */
    async refresh(username: string, paths: UserSyncPaths) {
      return withUser(username, paths, async bundle => ({ bundle, result: true }));
    },

    /**
     * Remember a version of a store the server is about to hand to the app (a
     * GET response, an event-stream frame), and return the id the app should
     * stamp onto the save it derives from it.
     */
    noteBase(username: string, store: SyncStore, snapshot: Snapshot): string {
      return noteBase(username, store, snapshot);
    },

    /** A device asks for everything it has not seen. */
    async pull(username: string, paths: UserSyncPaths, deviceId: string, since: number) {
      return withUser(username, paths, async bundle => {
        const res = pullOps(bundle, { deviceId, since });
        return {
          bundle,
          result: {
            ops: res.ops,
            cursor: res.cursor,
            conflicts: res.conflicts,
            needsFullResync: res.needsFullResync,
            lamport: bundle.state.lamport,
            serverTime: now(),
          },
        };
      });
    },

    /**
     * A pull that may park until there is something to say.
     *
     * Answers immediately when anything is already waiting; otherwise holds the
     * request for up to `waitMs`, returning the moment the log moves. The wait
     * happens between two ordinary pulls and never inside the queue.
     */
    async pullWaiting(
      username: string,
      paths: UserSyncPaths,
      deviceId: string,
      since: number,
      waitMs: number,
    ) {
      const first = await this.pull(username, paths, deviceId, since);
      if (waitMs <= 0 || first.ops.length > 0 || first.needsFullResync) return first;

      await park(username, waitMs);

      // Asked again rather than assuming: the wake may have been the timeout, or
      // a change for a different device, and the second pull is cheap.
      return this.pull(username, paths, deviceId, since);
    },

    /** A device sends its offline edits. */
    async push(
      username: string,
      paths: UserSyncPaths,
      args: { deviceId: string; ops: SyncOp[]; name?: string; platform?: string },
    ) {
      return withUser(username, paths, async bundle => {
        const res = pushOps(bundle, { ...args, at: now() });
        return {
          bundle: res.bundle,
          dirty: res.dirtyStores,
          result: {
            accepted: args.ops.length - res.ignored,
            ignored: res.ignored,
            conflicts: res.conflicts,
            cursor: res.bundle.devices[args.deviceId]?.cursor ?? 0,
            // So the device is current the moment its push lands, rather than
            // stamping its next edit against a clock one poll out of date.
            lamport: res.bundle.state.lamport,
          },
        };
      });
    },

    /** A device confirms it has stored everything up to `cursor`. */
    async ack(username: string, paths: UserSyncPaths, deviceId: string, cursor: number) {
      return withUser(username, paths, async bundle => {
        const next = acknowledge(bundle, { deviceId, cursor, at: now() });
        return { bundle: next, result: { cursor: next.devices[deviceId].cursor } };
      });
    },

    /** Everything, for a first sync or after the log has moved past a device. */
    async snapshot(username: string, paths: UserSyncPaths, deviceId: string) {
      return withUser(username, paths, async bundle => {
        const stores: Partial<Record<SyncStore, Snapshot>> = {
          events: opsToSnapshot(bundle.state, 'events'),
          tasks: opsToSnapshot(bundle.state, 'tasks'),
          settings: opsToSnapshot(bundle.state, 'settings'),
          focusSessions: opsToSnapshot(bundle.state, 'focusSessions'),
          prayerDone: opsToSnapshot(bundle.state, 'prayerDone'),
          prayerTimes: opsToSnapshot(bundle.state, 'prayerTimes'),
        };
        // The cursor is a LOG POSITION, never the lamport clock. Handing back a
        // lamport made the phone skip every op whose position happened to be
        // higher than the clock -- which is most of them after any offline edit.
        const next = acknowledge(bundle, { deviceId, cursor: bundle.seq, at: now() });
        return {
          bundle: next,
          result: {
            stores,
            cursor: bundle.seq,
            lamport: bundle.state.lamport,
            conflicts: bundle.conflicts,
            serverTime: now(),
          },
        };
      });
    },

    /** The user answered a conflict card, from either device. */
    async resolve(
      username: string,
      paths: UserSyncPaths,
      args: { conflictId: string; choice: 'winner' | 'loser' | 'delete' | 'keep'; deviceId: string },
    ) {
      return withUser(username, paths, async bundle => {
        const card = bundle.conflicts.find(c => c.id === args.conflictId);
        if (!card) {
          // Already answered on the other device. Not an error — the sidebar on
          // this device is simply out of date, and saying so is more useful than
          // a failure the user cannot act on.
          return { bundle, result: { ok: true, alreadyResolved: true, conflicts: bundle.conflicts } };
        }
        const ops = resolveConflict(bundle.state, card, args.choice, {
          device: args.deviceId,
          at: now(),
        });
        const merged = mergeOps(bundle.state, ops);
        const conflicts = bundle.conflicts.filter(c => c.id !== args.conflictId);
        const appended = appendToLog(bundle, ops);
        const nextBundle: SyncBundle = {
          ...bundle,
          state: merged.state,
          log: appended.log,
          seq: appended.seq,
          conflicts,
          devices: bundle.devices,
        };
        return {
          bundle: nextBundle,
          dirty: [card.store],
          result: { ok: true, alreadyResolved: false, conflicts },
        };
      });
    },

    /** Open conflict cards, for the notification sidebar. */
    async conflicts(username: string, paths: UserSyncPaths): Promise<SyncConflict[]> {
      return withUser(username, paths, async bundle => ({
        bundle,
        result: bundle.conflicts,
      }));
    },

    /** Which devices are syncing, and how far behind each one is. */
    async status(username: string, paths: UserSyncPaths) {
      return withUser(username, paths, async bundle => ({
        bundle,
        result: {
          lamport: bundle.state.lamport,
          seq: bundle.seq,
          trimmedBelow: bundle.trimmedBelow,
          logSize: bundle.log.length,
          openConflicts: bundle.conflicts.length,
          devices: Object.values(bundle.devices).map(d => ({
            ...d,
            behind: Math.max(0, bundle.seq - d.cursor),
          })),
          serverTime: now(),
        },
      }));
    },

    /** Testing / shutdown hook: drop the in-memory cache. */
    _reset() {
      cache.clear();
      queues.clear();
      lastSeen.clear();
      seenLoaded.clear();
      seenDirty.clear();
      bases.clear();
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;


// ─── Request handling ────────────────────────────────────────────────────────
// The routes live here rather than inline in vite.config.ts so they can be
// tested directly. The middleware is then a thin adapter: parse the URL and the
// body, call this, write the answer. Nothing that decides anything lives in the
// config file, where it could not be covered.

export interface SyncRequest {
  /** Path segment after /api/sync, with slashes stripped. */
  action: string;
  method: string;
  body: unknown;
}

export interface SyncResponse {
  /** False means "not a sync route" — the caller should fall through to next(). */
  handled: boolean;
  status: number;
  payload: unknown;
}

const pass = (): SyncResponse => ({ handled: false, status: 404, payload: null });
const ok = (payload: unknown): SyncResponse => ({ handled: true, status: 200, payload });
const bad = (error: string): SyncResponse => ({ handled: true, status: 400, payload: { error } });

const RESOLVE_CHOICES = ['winner', 'loser', 'delete', 'keep'] as const;

export async function handleSyncRequest(
  svc: SyncService,
  username: string,
  paths: UserSyncPaths,
  req: SyncRequest,
): Promise<SyncResponse> {
  const action = String(req.action ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  const method = String(req.method ?? '').toUpperCase();

  if (action === 'status' && method === 'GET') {
    return ok(await svc.status(username, paths));
  }
  if (action === 'conflicts' && method === 'GET') {
    return ok({ conflicts: await svc.conflicts(username, paths) });
  }
  if (method !== 'POST') return pass();

  const body = (req.body ?? {}) as Record<string, unknown>;
  const deviceId = validateDeviceId(body.deviceId);
  if (!deviceId) {
    return bad('A deviceId of 3-128 letters, digits, dot, dash or underscore is required.');
  }

  switch (action) {
    case 'snapshot':
      return ok(await svc.snapshot(username, paths, deviceId));

    case 'pull':
      return ok(await svc.pullWaiting(
        username, paths, deviceId, validateCursor(body.since), validateWait(body.wait),
      ));

    case 'ack':
      return ok(await svc.ack(username, paths, deviceId, validateCursor(body.cursor)));

    case 'push': {
      const checked = validatePush(body.ops);
      if ('error' in checked) return bad(checked.error);
      const result = await svc.push(username, paths, {
        deviceId,
        ops: checked.ops,
        name: typeof body.name === 'string' ? body.name.slice(0, 80) : undefined,
        platform: typeof body.platform === 'string' ? body.platform.slice(0, 40) : undefined,
      });
      // `rejected` is reported rather than hidden: a phone sending malformed ops
      // has a real bug, and silently dropping them would look to the user like
      // edits that simply never arrived.
      return ok({ ...result, rejected: checked.rejected });
    }

    case 'resolve': {
      const choice = body.choice as (typeof RESOLVE_CHOICES)[number];
      if (!RESOLVE_CHOICES.includes(choice)) {
        return bad('choice must be winner, loser, delete or keep');
      }
      if (typeof body.conflictId !== 'string' || body.conflictId.length === 0) {
        return bad('conflictId is required');
      }
      return ok(await svc.resolve(username, paths, { conflictId: body.conflictId, choice, deviceId }));
    }

    default:
      return pass();
  }
}

// ─── Request validation ──────────────────────────────────────────────────────
// Everything below runs on data the phone sent, which after a bad OTA update or
// a half-corrupted local database may be nonsense. A malformed op must be
// rejected at the door — once it reaches the log it is replicated everywhere.

const MAX_OPS_PER_PUSH = 5_000;

export function validateOp(raw: unknown): SyncOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.opId !== 'string' || o.opId.length === 0 || o.opId.length > 200) return null;
  if (typeof o.store !== 'string' || typeof o.entityId !== 'string') return null;
  if (o.entityId.length === 0 || o.entityId.length > 400) return null;
  if (typeof o.field !== 'string' || o.field.length === 0 || o.field.length > 200) return null;
  if (typeof o.device !== 'string' || o.device.length === 0 || o.device.length > 200) return null;
  if (typeof o.lamport !== 'number' || !Number.isFinite(o.lamport) || o.lamport < 0) return null;
  if (!Number.isInteger(o.lamport)) return null;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  if (o.baseLamport !== undefined && typeof o.baseLamport !== 'number') return null;
  if (o.baseDevice !== undefined && typeof o.baseDevice !== 'string') return null;
  if (o.present !== undefined && typeof o.present !== 'boolean') return null;

  const allowed: SyncStore[] = [
    'events', 'tasks', 'taskLists', 'categories', 'settings',
    'prayerDone', 'prayerTimes', 'focusSessions',
  ];
  if (!allowed.includes(o.store as SyncStore)) return null;

  // SETTINGS ARE SCOPED AT THE DOOR. Only the shared half of the settings may
  // enter the log at all. Filtering only where the file is written was not
  // enough: an op for a per-device key was still accepted, stored and handed to
  // every other device, so one buggy client could push its own view or theme
  // into everyone else's copy. It could not reach settings.json — but it should
  // never have been replicated in the first place.
  if (o.store === 'settings'
    && o.field !== DELETED_FIELD
    && !SHARED_SETTING_SET.has(o.field)) {
    return null;
  }

  return {
    opId: o.opId,
    store: o.store as SyncStore,
    entityId: o.entityId,
    field: o.field,
    value: o.value,
    present: o.present as boolean | undefined,
    device: o.device,
    lamport: o.lamport,
    at: o.at,
    baseLamport: o.baseLamport as number | undefined,
    baseDevice: o.baseDevice as string | undefined,
  };
}

export interface ValidatedPush {
  ops: SyncOp[];
  rejected: number;
}

/** Filter a pushed batch down to the ops that are structurally sound. */
export function validatePush(raw: unknown): ValidatedPush | { error: string } {
  if (!Array.isArray(raw)) return { error: 'ops must be an array' };
  if (raw.length > MAX_OPS_PER_PUSH) {
    return { error: `too many ops in one push (max ${MAX_OPS_PER_PUSH})` };
  }
  const ops: SyncOp[] = [];
  let rejected = 0;
  for (const item of raw) {
    const op = validateOp(item);
    if (op) ops.push(op);
    else rejected += 1;
  }
  return { ops, rejected };
}

/** A device id must be safe to use as an object key and a log field. */
export function validateDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id.length < 3 || id.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  return id;
}

/**
 * How long a pull may be held open, in milliseconds.
 *
 * Capped at 25 seconds. Proxies and phone radios drop an idle connection
 * somewhere around a minute, and a request killed in flight looks to the app
 * exactly like the PC going offline — so the hold ends comfortably before
 * anything else loses patience.
 */
export const MAX_PULL_WAIT_MS = 25_000;

export function validateWait(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(MAX_PULL_WAIT_MS, Math.floor(raw));
}

export function validateCursor(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}
