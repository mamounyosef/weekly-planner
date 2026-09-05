// ─── The phone's local database ──────────────────────────────────────────────
// Durable storage for ClientData, on top of a tiny SQL interface so the logic is
// testable against real SQLite without a device. The Android app injects
// expo-sqlite; the test suite injects node:sqlite. Same code, same SQL.
//
// WHY SQL RATHER THAN ONE JSON FILE
// The outbox is the only copy of every edit made offline. Rewriting one large
// JSON blob on each keystroke means that a crash mid-write can truncate the file
// and lose ALL of them at once. Rows are appended individually and deleted
// individually, inside transactions, so a crash costs at most the row being
// written — never the queue.
//
// THE ORDERING RULE: ops are deleted from the outbox only after the server has
// confirmed them, and state is written in the SAME transaction as the cursor. A
// cursor that advanced without its state would skip ops forever.
//
// THE TWO HALVES OF AN EDIT. The ops and the materialised state are written
// separately (`saveOps` and `saveState`), because they have very different
// costs and very different consequences:
//
//   • the ops are three small rows, and they are the ONLY copy of an edit made
//     with no PC in reach. They are written immediately, always.
//   • the state is the whole planner as one JSON string — most of a megabyte on
//     a real one — and it is a CACHE. Anything it is missing is still in the
//     outbox, and `load` replays the outbox over it. So it is allowed to lag,
//     which is what stops a drag across an hour from stringifying a megabyte
//     forty times and dropping every frame of the gesture.
//
// `saveLocalEdit` still does both in one transaction, for callers that want the
// old all-or-nothing guarantee, and it is what the crash tests exercise.

import {
  emptyState, mergeOps, sanitizeState,
  type SyncConflict, type SyncOp, type SyncState,
} from './sync';
import { emptyClientData, type ClientData } from './syncClient';

/** The minimum a SQL driver must provide. Both drivers satisfy this exactly. */
export interface SqlRunner {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Must roll back on throw. */
  transaction(fn: () => Promise<void>): Promise<void>;
}

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY,
  seq   INTEGER NOT NULL,
  json  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conflicts (
  id   TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_seq ON outbox (seq);
`;

interface MetaRow { key: string; value: string }
interface OutboxRow { op_id: string; seq: number; json: string }
interface JsonRow { json: string }

/** Parse defensively: one corrupt row must not take the whole planner down. */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function createStorage(sql: SqlRunner) {
  async function getMeta(key: string): Promise<string | null> {
    const rows = await sql.all<MetaRow>('SELECT value FROM meta WHERE key = ?', [key]);
    return rows.length > 0 ? rows[0].value : null;
  }

  async function setMeta(key: string, value: string): Promise<void> {
    await sql.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value],
    );
  }

  /**
   * What `saveSynced` last actually committed, by reference.
   *
   * Deliberately starts empty, so the FIRST save after launch always writes:
   * anything loaded from disk went through `sanitizeState` and the outbox
   * replay on the way in, so it is not necessarily byte-identical to what is
   * stored, and assuming it was would leave a repaired state unpersisted.
   */
  const lastWritten: {
    state: unknown;
    outbox: unknown;
    conflicts: unknown;
    cursor: number | null;
  } = { state: null, outbox: null, conflicts: null, cursor: null };

  return {
    /** Create tables and run migrations. Safe to call on every launch. */
    async init(): Promise<void> {
      await sql.exec(SCHEMA);
      const current = Number(await getMeta('schema_version')) || 0;
      if (current < SCHEMA_VERSION) {
        // Future migrations go here, one `if (current < N)` block each.
        await setMeta('schema_version', String(SCHEMA_VERSION));
      }
    },

    /** Everything the app needs at launch, in one read. */
    async load(deviceId: string): Promise<ClientData> {
      const [stateRaw, cursorRaw, syncedRaw, storedDevice] = await Promise.all([
        getMeta('state'),
        getMeta('cursor'),
        getMeta('last_synced_at'),
        getMeta('device_id'),
      ]);

      const outboxRows = await sql.all<OutboxRow>(
        'SELECT op_id, seq, json FROM outbox ORDER BY seq ASC',
      );
      const conflictRows = await sql.all<JsonRow>('SELECT json FROM conflicts');

      const stored = stateRaw ? parseJson<SyncState>(stateRaw, emptyState()) : emptyState();
      const base = emptyClientData(storedDevice ?? deviceId);

      // A state file that survived but lost its shape must not wedge the app;
      // an empty state simply triggers a full resync on the next connection.
      // Same repair as the server. The phone carries its own copy of the
      // damage, so healing only one side would leave them disagreeing.
      const sane = stored && typeof stored === 'object' && stored.entities
        ? sanitizeState(stored) : emptyState();

      const outbox = outboxRows
        .map(r => parseJson<SyncOp | null>(r.json, null))
        .filter((o): o is SyncOp => o !== null);

      /**
       * REPLAY THE OUTBOX ONTO WHATEVER THE STATE BLOB SAYS.
       *
       * The two are written separately now: ops the instant they are made,
       * because they are the only copy of an offline edit and must survive the
       * process dying; the state blob a moment later, because it is most of a
       * megabyte of JSON and stringifying it on every keystroke was costing
       * frames during a drag.
       *
       * That leaves a window where the ops table is ahead of the blob. This
       * closes it. `mergeOps` is idempotent — every op the blob already
       * reflects is recorded in `state.applied` and ignored — so replaying an
       * outbox that is fully accounted for costs a pass over a handful of
       * entries and changes nothing. When the blob really is behind, it catches
       * up here rather than waiting for the server to echo the edit back.
       */
      const state = outbox.length > 0 ? mergeOps(sane, outbox).state : sane;

      return {
        ...base,
        state,
        outbox,
        conflicts: conflictRows
          .map(r => parseJson<SyncConflict | null>(r.json, null))
          .filter((c): c is SyncConflict => c !== null),
        cursor: Number(cursorRaw) || 0,
        lastSyncedAt: syncedRaw === null ? null : Number(syncedRaw),
      };
    },

    /**
     * The ops from one edit, and nothing else.
     *
     * Split out of `saveLocalEdit` so that the durable half of an edit is cheap
     * enough to do immediately. These rows ARE the edit as far as survival goes:
     * lose them and an offline change is gone, so they are never deferred.
     */
    async saveOps(newOps: readonly SyncOp[]): Promise<void> {
      if (newOps.length === 0) return;
      await sql.transaction(async () => {
        for (const op of newOps) {
          await sql.run(
            'INSERT OR IGNORE INTO outbox (op_id, seq, json) VALUES (?, ?, ?)',
            [op.opId, op.lamport, JSON.stringify(op)],
          );
        }
      });
    },

    /**
     * The materialised state, and nothing else.
     *
     * The expensive half, and the one that can safely lag: anything it is
     * missing is still in the outbox, and `load` replays it. Callers coalesce
     * this so a drag across an hour writes once rather than forty times.
     */
    async saveState(data: ClientData): Promise<void> {
      await setMeta('state', JSON.stringify(data.state));
    },

    /** Remember which device this is, so the id survives reinstall-free restarts. */
    async setDeviceId(deviceId: string): Promise<void> {
      await setMeta('device_id', deviceId);
    },

    /**
     * Persist a local edit: the new state and the new ops, atomically.
     *
     * If this were two writes, a crash between them would leave an op queued that
     * the local state does not reflect, or state showing an edit that will never
     * be sent. One transaction makes both impossible.
     */
    async saveLocalEdit(data: ClientData, newOps: readonly SyncOp[]): Promise<void> {
      await sql.transaction(async () => {
        await setMeta('state', JSON.stringify(data.state));
        for (const op of newOps) {
          await sql.run(
            'INSERT OR IGNORE INTO outbox (op_id, seq, json) VALUES (?, ?, ?)',
            [op.opId, op.lamport, JSON.stringify(op)],
          );
        }
      });
    },

    /**
     * Persist the result of a sync cycle: state, cursor, outbox and cards.
     *
     * WHAT IT SKIPS, AND WHY THAT IS SAFE. This ran unconditionally after every
     * cycle: a near-megabyte `JSON.stringify` of the whole planner, then a
     * delete-and-reinsert of every outbox row and every conflict row, inside a
     * transaction, on the JS thread -- several times a minute on an idle phone,
     * to store exactly what was already stored. It landed as a hitch while
     * scrolling.
     *
     * The three heavy parts are now written only when their value has actually
     * changed since the last write, tracked by REFERENCE. Every function that
     * produces them returns its input unchanged when it changes nothing, which
     * is the invariant this leans on and which the sync tests pin.
     *
     * `cursor` is deliberately NOT skipped independently: it goes into the same
     * transaction as the state, because a cursor that advances without its
     * state skips those ops forever.
     */
    async saveSynced(data: ClientData): Promise<void> {
      const stateSame = data.state === lastWritten.state;
      const outboxSame = data.outbox === lastWritten.outbox;
      const conflictsSame = data.conflicts === lastWritten.conflicts;
      const cursorSame = data.cursor === lastWritten.cursor;

      if (stateSame && outboxSame && conflictsSame && cursorSame) {
        // Nothing but the clock moved. That is one small meta row, not a
        // transaction over the whole planner.
        if (data.lastSyncedAt !== null) {
          await setMeta('last_synced_at', String(data.lastSyncedAt));
        }
        return;
      }

      await sql.transaction(async () => {
        if (!stateSame || !cursorSame) {
          await setMeta('state', JSON.stringify(data.state));
          await setMeta('cursor', String(data.cursor));
        }
        if (data.lastSyncedAt !== null) {
          await setMeta('last_synced_at', String(data.lastSyncedAt));
        }

        if (!outboxSame) {
          // Replace the outbox with exactly what is still unsent. Deleting only the
          // confirmed ids would leave anything the cycle added unaccounted for.
          await sql.run('DELETE FROM outbox');
          for (const op of data.outbox) {
            await sql.run(
              'INSERT OR IGNORE INTO outbox (op_id, seq, json) VALUES (?, ?, ?)',
              [op.opId, op.lamport, JSON.stringify(op)],
            );
          }
        }

        if (!conflictsSame) {
          await sql.run('DELETE FROM conflicts');
          for (const c of data.conflicts) {
            await sql.run('INSERT OR IGNORE INTO conflicts (id, json) VALUES (?, ?)',
              [c.id, JSON.stringify(c)]);
          }
        }
      });

      // Only after the transaction has committed. Recording it earlier would
      // mean a failed write was never retried, which is the one way this could
      // lose data rather than merely repeat work.
      lastWritten.state = data.state;
      lastWritten.outbox = data.outbox;
      lastWritten.conflicts = data.conflicts;
      lastWritten.cursor = data.cursor;
    },

    /** Ops still waiting to be sent, oldest first. */
    async pendingCount(): Promise<number> {
      const rows = await sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
      return rows.length > 0 ? Number(rows[0].n) : 0;
    },

    /** Wipe everything except the device id. Used by "Reset local data". */
    async reset(): Promise<void> {
      await sql.transaction(async () => {
        await sql.run('DELETE FROM outbox');
        await sql.run('DELETE FROM conflicts');
        await sql.run("DELETE FROM meta WHERE key IN ('state', 'cursor', 'last_synced_at')");
      });
      // Forget what was written, or "Reset local data" followed by a sync that
      // happened to produce the same objects would skip the write and leave
      // the tables empty. This is the one path that changes the database
      // without going through `saveSynced`.
      lastWritten.state = null;
      lastWritten.outbox = null;
      lastWritten.conflicts = null;
      lastWritten.cursor = null;
    },

    /** Diagnostics for the settings screen. */
    async stats(): Promise<{ pending: number; conflicts: number; cursor: number; bytes: number }> {
      const [pending, conflicts, cursorRaw, stateRaw] = await Promise.all([
        sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM outbox'),
        sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM conflicts'),
        getMeta('cursor'),
        getMeta('state'),
      ]);
      return {
        pending: Number(pending[0]?.n ?? 0),
        conflicts: Number(conflicts[0]?.n ?? 0),
        cursor: Number(cursorRaw) || 0,
        bytes: stateRaw ? stateRaw.length : 0,
      };
    },
  };
}

export type SyncStorage = ReturnType<typeof createStorage>;

/**
 * A stable per-install device id.
 *
 * It must survive app restarts and updates but NOT be shared between installs:
 * two devices sharing an id would each think the other's ops were their own and
 * neither would ever receive them.
 */
export function makeDeviceId(random: () => number, platform = 'android'): string {
  let out = '';
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 10; i++) {
    out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  }
  return `${platform}-${out}`;
}
