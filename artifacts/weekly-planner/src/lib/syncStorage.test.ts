// Tests the phone's local database against REAL SQLite (node:sqlite), not a
// mock. The failures worth catching here — a crash mid-transaction, a corrupt
// row, a torn write — only exist because a real database is involved, so a fake
// that always behaves would prove nothing.
//
// Run with: npx tsx src/lib/syncStorage.test.ts

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { emptyState, makeOps, readStore, type SyncConflict, type SyncOp } from './sync';
import { applyLocalChange, emptyClientData, type ClientData } from './syncClient';
import { createStorage, makeDeviceId, SCHEMA_VERSION, type SqlRunner } from './syncStorage';

const PH = 'android-testdevice';

/** A SqlRunner over node:sqlite, matching what expo-sqlite provides. */
function nodeRunner(db: DatabaseSync): SqlRunner {
  return {
    async exec(sql) { db.exec(sql); },
    async run(sql, params = []) { db.prepare(sql).run(...(params as any[])); },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as any[])) as T[];
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** A runner that fails on the Nth write, to simulate a crash mid-transaction. */
function flakyRunner(db: DatabaseSync, failOnWrite: number): SqlRunner {
  const base = nodeRunner(db);
  let writes = 0;
  return {
    ...base,
    async run(sql, params) {
      writes += 1;
      if (writes === failOnWrite) throw new Error('disk full');
      return base.run(sql, params);
    },
  };
}

async function freshStore() {
  const db = new DatabaseSync(':memory:');
  const store = createStorage(nodeRunner(db));
  await store.init();
  return { db, store };
}

async function main() {
  console.log('--- 1. INIT IS IDEMPOTENT ---');
  {
    const db = new DatabaseSync(':memory:');
    const store = createStorage(nodeRunner(db));
    for (let i = 0; i < 5; i++) await store.init();

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const names = tables.map(t => t.name).sort();
    assert.ok(names.includes('meta') && names.includes('outbox') && names.includes('conflicts'),
      'All three tables exist');

    const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").all() as any[];
    assert.equal(Number(version[0].value), SCHEMA_VERSION, 'and the schema version is stamped once');
  }

  console.log('--- 2. AN EMPTY DATABASE LOADS AS A USABLE BLANK ---');
  {
    const { store } = await freshStore();
    const d = await store.load(PH);
    assert.equal(d.deviceId, PH);
    assert.deepEqual(d.outbox, []);
    assert.deepEqual(d.conflicts, []);
    assert.equal(d.cursor, 0);
    assert.equal(d.lastSyncedAt, null, 'null, not 0 — "never synced" is not "synced at epoch"');
    assert.deepEqual(readStore(d.state, 'events'), {});
    assert.equal(await store.pendingCount(), 0);
  }

  console.log('--- 3. A LOCAL EDIT SURVIVES A RESTART ---');
  {
    const { db, store } = await freshStore();
    await store.setDeviceId(PH);

    let d = emptyClientData(PH);
    const before = d.outbox.length;
    d = applyLocalChange(d, {
      store: 'events', entityId: 'ev1', at: 1_000,
      changes: { title: 'Physics', startTime: '18:00' },
    });
    await store.saveLocalEdit(d, d.outbox.slice(before));

    // Reopen the same database, as relaunching the app would.
    const reopened = createStorage(nodeRunner(db));
    const back = await reopened.load('ignored-because-stored');
    assert.equal(back.deviceId, PH, 'The stored device id wins over the argument');
    assert.equal(back.outbox.length, 2, 'Both queued ops survived');
    assert.equal(readStore(back.state, 'events').ev1.title, 'Physics', 'and so did the data');
    assert.equal(await reopened.pendingCount(), 2);
  }

  console.log('--- 4. THE OUTBOX KEEPS ITS ORDER ---');
  {
    const { db, store } = await freshStore();
    let d = emptyClientData(PH);
    for (let i = 0; i < 40; i++) {
      const before = d.outbox.length;
      d = applyLocalChange(d, {
        store: 'events', entityId: `ev${i}`, at: 1_000 + i, changes: { title: `n${i}` },
      });
      await store.saveLocalEdit(d, d.outbox.slice(before));
    }
    const back = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(back.outbox.length, 40);
    for (let i = 1; i < back.outbox.length; i++) {
      assert.ok(back.outbox[i].lamport >= back.outbox[i - 1].lamport,
        'Ops come back in the order they were made');
    }
    assert.deepEqual(back.outbox.map(o => o.entityId), d.outbox.map(o => o.entityId));
  }

  console.log('--- 5. SAVING THE SAME OP TWICE DOES NOT DUPLICATE IT ---');
  {
    const { store } = await freshStore();
    let d = emptyClientData(PH);
    d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 1, changes: { title: 'x' } });

    for (let i = 0; i < 5; i++) await store.saveLocalEdit(d, d.outbox);
    assert.equal(await store.pendingCount(), 1,
      'A retried save is idempotent — opId is the primary key');
  }

  console.log('--- 6. A CRASH MID-TRANSACTION LEAVES NOTHING HALF-WRITTEN ---');
  {
    const db = new DatabaseSync(':memory:');
    await createStorage(nodeRunner(db)).init();

    let d = emptyClientData(PH);
    d = applyLocalChange(d, {
      store: 'events', entityId: 'ev1', at: 1,
      changes: { title: 'a', startTime: '09:00', endTime: '10:00' },
    });

    // Fail on the third write inside the transaction: state written, one op in,
    // then the disk gives out. Without the transaction this leaves an outbox
    // that disagrees with the state.
    const flaky = createStorage(flakyRunner(db, 3));
    await assert.rejects(() => flaky.saveLocalEdit(d, d.outbox), 'The save reports the failure');

    const after = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(after.outbox.length, 0, 'NOTHING was committed — no half-written queue');
    assert.deepEqual(readStore(after.state, 'events'), {}, 'and no half-written state');

    // And the database is still usable afterwards, not locked by a stray BEGIN.
    const healthy = createStorage(nodeRunner(db));
    await healthy.saveLocalEdit(d, d.outbox);
    assert.equal(await healthy.pendingCount(), 3, 'The retry succeeded in full');
  }

  console.log('--- 7. A SYNC RESULT REPLACES THE QUEUE EXACTLY ---');
  {
    const { db, store } = await freshStore();
    let d = emptyClientData(PH);
    d = applyLocalChange(d, { store: 'events', entityId: 'a', at: 1, changes: { title: '1' } });
    d = applyLocalChange(d, { store: 'events', entityId: 'b', at: 2, changes: { title: '2' } });
    await store.saveLocalEdit(d, d.outbox);
    assert.equal(await store.pendingCount(), 2);

    // The first op was confirmed; the second was not.
    const synced: ClientData = { ...d, outbox: [d.outbox[1]], cursor: 42, lastSyncedAt: 9_000 };
    await store.saveSynced(synced);

    const back = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(back.outbox.length, 1, 'Only the unconfirmed op remains');
    assert.equal(back.outbox[0].entityId, 'b');
    assert.equal(back.cursor, 42, 'and the cursor advanced');
    assert.equal(back.lastSyncedAt, 9_000);
  }

  console.log('--- 8. CURSOR AND STATE MOVE TOGETHER OR NOT AT ALL ---');
  {
    // A cursor that advanced without its state would skip those ops forever.
    const db = new DatabaseSync(':memory:');
    await createStorage(nodeRunner(db)).init();
    const store = createStorage(nodeRunner(db));

    let d = emptyClientData(PH);
    d = applyLocalChange(d, { store: 'events', entityId: 'a', at: 1, changes: { title: '1' } });
    await store.saveSynced({ ...d, cursor: 10, lastSyncedAt: 1_000, outbox: [] });

    // Fail partway through the next save.
    const flaky = createStorage(flakyRunner(db, 2));
    let d2 = applyLocalChange(d, { store: 'events', entityId: 'b', at: 2, changes: { title: '2' } });
    await assert.rejects(() => flaky.saveSynced({ ...d2, cursor: 20, outbox: [] }));

    const back = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(back.cursor, 10, 'The cursor did NOT advance past state that was not written');
    assert.equal(readStore(back.state, 'events').b, undefined, 'and the state matches it');
  }

  console.log('--- 9. CONFLICT CARDS PERSIST AND CLEAR ---');
  {
    const { db, store } = await freshStore();
    const card = (id: string, field: string): SyncConflict => ({
      id, kind: 'field', store: 'events', entityId: 'ev1', field,
      winner: { value: 'w', device: 'pc', at: 1, lamport: 1 },
      loser: { value: 'l', device: PH, at: 2, lamport: 2 },
      detectedAt: 2,
    });

    const d = { ...emptyClientData(PH), conflicts: [card('c1', 'title'), card('c2', 'startTime')] };
    await store.saveSynced(d);

    const back = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(back.conflicts.length, 2, 'Cards survive a restart — you can answer them tomorrow');
    assert.deepEqual(back.conflicts.map(c => c.id).sort(), ['c1', 'c2']);
    assert.equal(back.conflicts[0].winner.value, 'w', 'with both values intact');

    // Answering one leaves the other.
    await store.saveSynced({ ...d, conflicts: [card('c2', 'startTime')] });
    const after = await createStorage(nodeRunner(db)).load(PH);
    assert.deepEqual(after.conflicts.map(c => c.id), ['c2']);

    // Clearing all of them empties the table rather than leaving stale rows.
    await store.saveSynced({ ...d, conflicts: [] });
    assert.equal((await createStorage(nodeRunner(db)).load(PH)).conflicts.length, 0);
  }

  console.log('--- 10. CORRUPT ROWS ARE SKIPPED, NOT FATAL ---');
  {
    const db = new DatabaseSync(':memory:');
    const store = createStorage(nodeRunner(db));
    await store.init();

    let d = emptyClientData(PH);
    d = applyLocalChange(d, { store: 'events', entityId: 'good', at: 1, changes: { title: 'ok' } });
    await store.saveLocalEdit(d, d.outbox);

    // Hand-corrupt rows the way a bad flush or a manual edit would.
    db.prepare('INSERT INTO outbox (op_id, seq, json) VALUES (?, ?, ?)')
      .run('broken-1', 99, '{"opId": "trunc');
    db.prepare('INSERT INTO outbox (op_id, seq, json) VALUES (?, ?, ?)')
      .run('broken-2', 100, 'null');
    db.prepare('INSERT INTO conflicts (id, json) VALUES (?, ?)').run('bad', 'not json');

    const back = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(back.outbox.length, 1, 'The good op still loads');
    assert.equal(back.outbox[0].entityId, 'good');
    assert.equal(back.conflicts.length, 0, 'and a corrupt card is simply dropped');
  }

  console.log('--- 11. A CORRUPT STATE BLOB FALLS BACK TO A RESYNC, NOT A CRASH ---');
  {
    for (const bad of ['{"entities":', 'null', '[]', '{"lamport":3}', 'garbage', '']) {
      const db = new DatabaseSync(':memory:');
      await createStorage(nodeRunner(db)).init();
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('state', bad);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('cursor', '55');

      const back = await createStorage(nodeRunner(db)).load(PH);
      assert.ok(back.state.entities, `State recovers from ${JSON.stringify(bad)}`);
      assert.deepEqual(readStore(back.state, 'events'), {}, 'as an empty planner');

      // And it must still be writable — a poisoned store would brick the app.
      const store = createStorage(nodeRunner(db));
      const d = applyLocalChange(back, {
        store: 'events', entityId: 'x', at: 1, changes: { title: 'after recovery' },
      });
      await store.saveLocalEdit(d, d.outbox);
      assert.equal(await store.pendingCount(), 1, 'and the app keeps working');
    }
  }

  console.log('--- 12. GARBAGE IN THE NUMERIC META FIELDS ---');
  {
    for (const [cursor, expected] of [['abc', 0], ['', 0], ['-5', -5], ['1e3', 1000], ['NaN', 0]]) {
      const db = new DatabaseSync(':memory:');
      await createStorage(nodeRunner(db)).init();
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('cursor', cursor);
      const back = await createStorage(nodeRunner(db)).load(PH);
      assert.equal(back.cursor, expected, `cursor "${cursor}" reads as ${expected}`);
    }
  }

  console.log('--- 13. LARGE AND AWKWARD DATA ROUND-TRIPS ---');
  {
    const { db, store } = await freshStore();
    let d = emptyClientData(PH);
    d = applyLocalChange(d, {
      store: 'events', entityId: 'ev::2026-09-01', at: 1,
      changes: {
        title: 'صلاة الفجر 💪',
        notes: 'x'.repeat(100_000),
        recur: { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] },
        exdates: ['2026-09-01', '2026-09-08'],
        weird: 'quotes " backslash \\ newline \n tab \t',
      },
    });
    await store.saveLocalEdit(d, d.outbox);

    const back = await createStorage(nodeRunner(db)).load(PH);
    const rec = readStore(back.state, 'events')['ev::2026-09-01'];
    assert.equal(rec.title, 'صلاة الفجر 💪', 'Arabic and emoji survive');
    assert.equal((rec.notes as string).length, 100_000, 'A 100k string survives');
    assert.deepEqual(rec.recur, { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] });
    assert.deepEqual(rec.exdates, ['2026-09-01', '2026-09-08']);
    assert.ok((rec.weird as string).includes('\n'), 'and escapes are intact');
  }

  console.log('--- 14. A BIG BACKLOG IS NOT SLOW OR LOSSY ---');
  {
    const { db, store } = await freshStore();
    let d = emptyClientData(PH);
    const started = Date.now();
    for (let i = 0; i < 500; i++) {
      d = applyLocalChange(d, {
        store: 'events', entityId: `ev${i % 50}`, at: 1_000 + i, changes: { title: `v${i}` },
      });
    }
    await store.saveLocalEdit(d, d.outbox);
    const elapsed = Date.now() - started;

    assert.equal(await store.pendingCount(), 500, 'All 500 offline edits are queued');
    assert.ok(elapsed < 5_000, `Writing 500 ops took ${elapsed}ms — well under a freeze`);

    const back = await createStorage(nodeRunner(db)).load(PH);
    assert.equal(back.outbox.length, 500, 'and they all come back');
    assert.equal(readStore(back.state, 'events').ev0.title, 'v450');
  }

  console.log('--- 15. RESET CLEARS DATA BUT KEEPS THE DEVICE IDENTITY ---');
  {
    const { db, store } = await freshStore();
    await store.setDeviceId(PH);
    let d = emptyClientData(PH);
    d = applyLocalChange(d, { store: 'events', entityId: 'a', at: 1, changes: { title: 'x' } });
    await store.saveSynced({ ...d, cursor: 30, lastSyncedAt: 5_000 });

    await store.reset();
    const back = await createStorage(nodeRunner(db)).load('fallback');
    assert.equal(back.deviceId, PH,
      'The device id survives a reset — changing it would orphan every op on the server');
    assert.equal(back.outbox.length, 0);
    assert.equal(back.cursor, 0);
    assert.equal(back.lastSyncedAt, null);
    assert.deepEqual(readStore(back.state, 'events'), {});
  }

  console.log('--- 16. STATS FOR THE SETTINGS SCREEN ---');
  {
    const { store } = await freshStore();
    let stats = await store.stats();
    assert.deepEqual(stats, { pending: 0, conflicts: 0, cursor: 0, bytes: 0 });

    let d = emptyClientData(PH);
    d = applyLocalChange(d, { store: 'events', entityId: 'a', at: 1, changes: { title: 'x' } });
    await store.saveSynced({ ...d, cursor: 12, lastSyncedAt: 1 });
    stats = await store.stats();
    assert.equal(stats.pending, 1);
    assert.equal(stats.cursor, 12);
    assert.ok(stats.bytes > 0, 'and it can report how much space the planner uses');
  }

  console.log('--- 17. DEVICE IDS ARE UNIQUE AND SERVER-LEGAL ---');
  {
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i++) ids.add(makeDeviceId(rand));
    assert.equal(ids.size, 5_000, 'Five thousand generated ids, no collisions');

    for (const id of [...ids].slice(0, 200)) {
      assert.ok(/^[A-Za-z0-9._-]+$/.test(id), `"${id}" passes the server's device-id rule`);
      assert.ok(id.length >= 3 && id.length <= 128, `"${id}" is within the length limit`);
      assert.ok(id.startsWith('android-'), 'and says which platform it is');
    }
    assert.ok(makeDeviceId(rand, 'tablet').startsWith('tablet-'));
  }

  console.log('\nALL PASS (phone local database: durability, corruption, backlog)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
