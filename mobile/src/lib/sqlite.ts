// ─── expo-sqlite adapter ─────────────────────────────────────────────────────
// Satisfies the SqlRunner contract that syncStorage.ts is written against. The
// test suite implements the same contract over node:sqlite, so the storage logic
// is proven against real SQL before it ever reaches a phone.

import * as SQLite from 'expo-sqlite';
import type { SqlRunner } from './syncStorage';

export const DATABASE_NAME = 'planner.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function openPlannerDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async db => {
      // WAL keeps a read (the UI painting today's agenda) from blocking a write
      // (the sync loop landing 200 ops), which is the difference between a
      // smooth list and a visible stutter every time the phone syncs.
      await db.execAsync('PRAGMA journal_mode = WAL');
      // FULL is unnecessary with WAL and costs an fsync on every commit; NORMAL
      // still survives an app crash, which is the failure that actually happens.
      await db.execAsync('PRAGMA synchronous = NORMAL');
      await db.execAsync('PRAGMA foreign_keys = ON');
      return db;
    });
  }
  return dbPromise;
}

export function createExpoRunner(db: SQLite.SQLiteDatabase): SqlRunner {
  return {
    async exec(sql) {
      await db.execAsync(sql);
    },
    async run(sql, params = []) {
      await db.runAsync(sql, ...(params as SQLite.SQLiteBindValue[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.getAllAsync<T>(sql, ...(params as SQLite.SQLiteBindValue[])) as Promise<T[]>;
    },
    async transaction(fn) {
      // withExclusiveTransactionAsync takes its own connection, so a concurrent
      // read cannot interleave and see a half-applied sync. It rolls back on
      // throw, which is the guarantee syncStorage relies on.
      await db.withExclusiveTransactionAsync(async () => {
        await fn();
      });
    },
  };
}

/** Close and forget the handle — used by "Reset local data" before deleting. */
export async function closePlannerDatabase(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  dbPromise = null;
  await db.closeAsync();
}
