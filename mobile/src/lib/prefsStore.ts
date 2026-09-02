// ─── Device preferences, read in one go ──────────────────────────────────────
// Every view preference the phone remembers used to live in expo-secure-store,
// one Android Keystore entry each. That is the correct home for a bearer token
// and an expensive mistake for "which calendar view were you last on":
//
//   • each read is an AES decrypt against a key held in the TEE, and
//   • Expo dispatches a module's async functions on ONE serial queue, so
//     fifteen reads issued together still happen one after another.
//
// The launch path was doing about fifteen of them before the splash could
// clear, which is the single largest thing standing between tapping the icon
// and seeing the planner. None of those values is a secret; they are settings.
//
// So they move into the SQLite database the app already opens, where the whole
// set is ONE query, and the keystore keeps only what is actually a credential.
//
// MIGRATION IS THE WHOLE RISK, so it is written to be boring:
//
//   • the keystore is read at most once ever, on the first launch after this
//     change, and only for keys this store owns;
//   • a marker row records that it happened, so every later launch is one
//     SELECT and no keystore traffic at all;
//   • a value that fails to migrate is simply absent, which every caller
//     already handles as "not set" — the same answer a locked keystore gives
//     today;
//   • nothing here can touch the session token, the device id, the server
//     address or the username. Those are not in `keys` and this file never
//     names them. Signing the user out is therefore not a failure mode this
//     code has.
//
// If SQL is unavailable for any reason, the store degrades to reading the
// keystore exactly as before: slower, never wrong.

/** The SQL surface this needs. `syncStorage`'s SqlRunner satisfies it. */
export interface PrefsSql {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** The keystore surface: what expo-secure-store provides, narrowed. */
export interface PrefsSecure {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const PREFS_TABLE = 'prefs';

/**
 * Marks that the one-time keystore sweep has run.
 *
 * Deliberately stored as a row in the same table rather than anywhere else: it
 * is written by the same code path that writes the migrated values, so a sweep
 * that never finished is retried on the next launch rather than recorded as
 * done.
 */
export const MIGRATED_KEY = '__migrated_from_secure_store';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type PrefsSource =
  /** Read from SQL alone. The steady state: no keystore traffic at all. */
  | 'sql'
  /** First launch after the change: swept the keystore and copied values in. */
  | 'migrated'
  /** SQL was unusable, so this behaved exactly like the old code. */
  | 'secure-fallback';

export interface PrefsLoadReport {
  source: PrefsSource;
  /** How many keystore entries were read. Zero on every launch after the first. */
  secureReads: number;
  /** How many values were copied out of the keystore into SQL. */
  migrated: number;
  /** Set when SQL failed; kept for the diagnostics screen. */
  sqlError?: string;
}

export interface PrefsStore {
  /** Idempotent, and safe to call concurrently: later callers await the first. */
  load(): Promise<PrefsLoadReport>;
  loaded(): boolean;
  /** Synchronous once loaded, which is the entire point of this file. */
  get(key: string): string | null;
  /** Applies to memory immediately; persists in the background. */
  set(key: string, value: string | null): void;
  /** Awaits every queued write. Used before backgrounding, and by the tests. */
  flush(): Promise<void>;
  /** Forget everything this store owns, in memory and on disk. */
  clear(): Promise<void>;
  lastReport(): PrefsLoadReport | null;
}

interface Row { key: string; value: string }

export function createPrefsStore(opts: {
  sql: PrefsSql | null;
  secure: PrefsSecure;
  /** The keys this store owns. Anything outside this list is never touched. */
  keys: readonly string[];
  /** Reported, never thrown; lets the app surface a storage problem. */
  onError?: (where: string, err: unknown) => void;
}): PrefsStore {
  const owned = new Set(opts.keys);
  const values = new Map<string, string>();
  /**
   * Keys written before `load()` finished.
   *
   * A write that happens while the first read is still in flight must win: the
   * user has just chosen something, and the value coming back off the disk is
   * by definition older. Without this, tapping a theme button during launch
   * would silently revert a moment later.
   */
  const dirty = new Set<string>();

  let loadPromise: Promise<PrefsLoadReport> | null = null;
  let isLoaded = false;
  let report: PrefsLoadReport | null = null;

  /** Writes are chained so two upserts of one key cannot land out of order. */
  let writeChain: Promise<void> = Promise.resolve();

  const fail = (where: string, err: unknown) => {
    try { opts.onError?.(where, err); } catch { /* a logger must not throw */ }
  };

  function queue(fn: () => Promise<void>): void {
    writeChain = writeChain.then(fn, fn).catch(err => { fail('write', err); });
  }

  async function readAllFromSql(sql: PrefsSql): Promise<Map<string, string>> {
    await sql.exec(SCHEMA);
    const rows = await sql.all<Row>('SELECT key, value FROM prefs');
    const out = new Map<string, string>();
    for (const row of rows) {
      // A driver that hands back a non-string (a NULL column, a number) must not
      // become a crash three screens away.
      if (row && typeof row.key === 'string' && typeof row.value === 'string') {
        out.set(row.key, row.value);
      }
    }
    return out;
  }

  /**
   * The one-time sweep.
   *
   * Reads only the keys that are BOTH owned and absent from SQL, so a partially
   * migrated database finishes the job rather than starting again, and a value
   * the user has since cleared is not resurrected out of the keystore.
   */
  async function migrate(sql: PrefsSql, present: Map<string, string>): Promise<number> {
    const wanted = opts.keys.filter(k => !present.has(k));
    if (wanted.length === 0) return 0;

    const found: Array<[string, string]> = [];
    // Issued in parallel: they serialise inside Expo anyway, and this is the
    // only launch that ever pays for it.
    await Promise.all(wanted.map(async key => {
      try {
        const raw = await opts.secure.get(key);
        if (typeof raw === 'string') found.push([key, raw]);
      } catch (err) {
        // A locked keystore right after a reboot throws. "Not set" is the same
        // answer the old code gave, and the user simply sees the default.
        fail(`migrate:${key}`, err);
      }
    }));

    // Sorted so the write order is deterministic, which is what makes a
    // half-finished migration reproducible in a test rather than a flake.
    found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    for (const [key, value] of found) {
      await sql.run(
        'INSERT INTO prefs (key, value) VALUES (?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
      present.set(key, value);
    }
    return found.length;
  }

  /**
   * How many times to try a write before giving up on SQL.
   *
   * Not for a broken disk, which no number of attempts fixes, but for
   * SQLITE_BUSY. The sync engine writes through `withExclusiveTransactionAsync`,
   * which takes a connection of its own, so a preference written at the same
   * instant as an edit is saved can be refused for a few milliseconds and
   * succeed immediately afterwards.
   */
  const WRITE_ATTEMPTS = 3;
  const RETRY_MS = [20, 60];

  const wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

  /** True if the value reached SQL. */
  async function writeToSql(
    sql: PrefsSql, key: string, value: string | null,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      try {
        if (value === null) {
          await sql.run('DELETE FROM prefs WHERE key = ?', [key]);
        } else {
          await sql.run(
            'INSERT INTO prefs (key, value) VALUES (?, ?) '
            + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [key, value],
          );
        }
        return true;
      } catch (err) {
        fail(`set:${key}`, err);
        if (attempt < WRITE_ATTEMPTS - 1) await wait(RETRY_MS[attempt] ?? 60);
      }
    }
    return false;
  }

  async function readAllFromSecure(): Promise<{ map: Map<string, string>; reads: number }> {
    const map = new Map<string, string>();
    let reads = 0;
    await Promise.all(opts.keys.map(async key => {
      reads += 1;
      try {
        const raw = await opts.secure.get(key);
        if (typeof raw === 'string') map.set(key, raw);
      } catch (err) {
        fail(`secure:${key}`, err);
      }
    }));
    return { map, reads };
  }

  /** Take the values off disk, without ever overwriting a fresher user choice. */
  function adopt(map: Map<string, string>): void {
    for (const [key, value] of map) {
      if (key === MIGRATED_KEY) continue;
      if (!owned.has(key)) continue;
      if (dirty.has(key)) continue;
      values.set(key, value);
    }
    dirty.clear();
  }

  async function doLoad(): Promise<PrefsLoadReport> {
    const sql = opts.sql;

    if (sql) {
      try {
        const present = await readAllFromSql(sql);
        const alreadySwept = present.get(MIGRATED_KEY) === '1';

        let migrated = 0;
        let secureReads = 0;
        if (!alreadySwept) {
          secureReads = opts.keys.filter(k => !present.has(k)).length;
          migrated = await migrate(sql, present);
          await sql.run(
            'INSERT INTO prefs (key, value) VALUES (?, ?) '
            + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [MIGRATED_KEY, '1'],
          );
        }

        adopt(present);
        isLoaded = true;
        return { source: alreadySwept ? 'sql' : 'migrated', secureReads, migrated };
      } catch (err) {
        fail('load', err);
        const { map, reads } = await readAllFromSecure();
        adopt(map);
        isLoaded = true;
        return {
          source: 'secure-fallback',
          secureReads: reads,
          migrated: 0,
          sqlError: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const { map, reads } = await readAllFromSecure();
    adopt(map);
    isLoaded = true;
    return { source: 'secure-fallback', secureReads: reads, migrated: 0 };
  }

  return {
    load() {
      if (!loadPromise) {
        loadPromise = doLoad().then(r => { report = r; return r; });
      }
      return loadPromise;
    },

    loaded() { return isLoaded; },

    get(key: string): string | null {
      const v = values.get(key);
      return typeof v === 'string' ? v : null;
    },

    set(key: string, value: string | null): void {
      if (!owned.has(key)) {
        fail('set', new Error(`prefsStore does not own "${key}"`));
        return;
      }

      if (value === null) values.delete(key);
      else values.set(key, value);
      if (!isLoaded) dirty.add(key);

      const sql = opts.sql;
      queue(async () => {
        if (sql && await writeToSql(sql, key, value)) return;

        // SQL would not take it. Put it in the keystore so the value is not
        // simply lost, and then CLEAR THE MIGRATION MARKER.
        //
        // That second half is the important one. Without it the next launch
        // would read SQL, find the key absent, trust the marker that says the
        // keystore has already been swept, and quietly serve the default —
        // losing a setting the user had just chosen. Clearing the marker makes
        // the next launch sweep again, find this value sitting in the keystore,
        // and copy it back into SQL. The app repairs itself, and the cost is one
        // slow launch rather than a lost preference.
        try {
          if (value === null) await opts.secure.remove(key);
          else await opts.secure.set(key, value);
        } catch (err) {
          fail(`set-secure:${key}`, err);
        }
        if (sql) {
          try {
            await sql.run('DELETE FROM prefs WHERE key = ?', [MIGRATED_KEY]);
          } catch (err) {
            // The marker could not be cleared either, which means SQL is
            // thoroughly unavailable; `load` falls back wholesale in that case.
            fail('unmark', err);
          }
        }
      });
    },

    async flush(): Promise<void> {
      // Awaited twice on purpose: a write queued by something that ran while we
      // were awaiting the first pass is still caught by the second.
      await writeChain;
      await writeChain;
    },

    async clear(): Promise<void> {
      values.clear();
      dirty.clear();
      const sql = opts.sql;
      queue(async () => {
        if (sql) {
          try {
            await sql.run('DELETE FROM prefs');
          } catch (err) { fail('clear', err); }
        }
        for (const key of opts.keys) {
          try { await opts.secure.remove(key); } catch (err) { fail(`clear:${key}`, err); }
        }
      });
      await writeChain;
      await writeChain;
    },

    lastReport() { return report; },
  };
}
