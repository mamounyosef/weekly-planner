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

import { emptyState, sanitizeState, type SyncConflict, type SyncOp, type SyncState } from './sync';
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

      const state = stateRaw ? parseJson<SyncState>(stateRaw, emptyState()) : emptyState();
      const base = emptyClientData(storedDevice ?? deviceId);

      return {
        ...base,
        // A state file that survived but lost its shape must not wedge the app;
        // an empty state simply triggers a full resync on the next connection.
        // Same repair as the server. The phone carries its own copy of the
        // damage, so healing only one side would leave them disagreeing.
        state: state && typeof state === 'object' && state.entities
          ? sanitizeState(state) : emptyState(),
        outbox: outboxRows
          .map(r => parseJson<SyncOp | null>(r.json, null))
          .filter((o): o is SyncOp => o !== null),
        conflicts: conflictRows
          .map(r => parseJson<SyncConflict | null>(r.json, null))
          .filter((c): c is SyncConflict => c !== null),
        cursor: Number(cursorRaw) || 0,
        lastSyncedAt: syncedRaw === null ? null : Number(syncedRaw),
      };
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

    /** Persist the result of a sync cycle: state, cursor, outbox and cards. */
    async saveSynced(data: ClientData): Promise<void> {
      await sql.transaction(async () => {
        await setMeta('state', JSON.stringify(data.state));
        await setMeta('cursor', String(data.cursor));
        if (data.lastSyncedAt !== null) {
          await setMeta('last_synced_at', String(data.lastSyncedAt));
        }

        // Replace the outbox with exactly what is still unsent. Deleting only the
        // confirmed ids would leave anything the cycle added unaccounted for.
        await sql.run('DELETE FROM outbox');
        for (const op of data.outbox) {
          await sql.run(
            'INSERT OR IGNORE INTO outbox (op_id, seq, json) VALUES (?, ?, ?)',
            [op.opId, op.lamport, JSON.stringify(op)],
          );
        }

        await sql.run('DELETE FROM conflicts');
        for (const c of data.conflicts) {
          await sql.run('INSERT OR IGNORE INTO conflicts (id, json) VALUES (?, ?)',
            [c.id, JSON.stringify(c)]);
        }
      });
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
