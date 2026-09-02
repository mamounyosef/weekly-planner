// Tests for the device-preferences store, against REAL SQLite (node:sqlite) and
// a keystore double that can be made to fail the way a real one does.
//
// The thing being proven is narrow and important: moving fifteen keystore reads
// off the launch path must not, under ANY failure, lose a setting or reach for a
// key it does not own. So the interesting cases here are all the ways the move
// could go wrong — a sweep that dies halfway, a locked keystore, a disk that
// refuses writes, a value written while the first read is still in flight.
//
// Run with: npx tsx src/lib/prefsStore.test.ts

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createPrefsStore, MIGRATED_KEY, type PrefsSecure, type PrefsSql,
} from './prefsStore';

const KEYS = [
  'planner.calendarView',
  'planner.interval',
  'planner.themeMode',
  'planner.visibleHours',
  'planner.focusTimer',
] as const;

/** A PrefsSql over node:sqlite, matching what expo-sqlite provides. */
function nodeSql(db: DatabaseSync): PrefsSql {
  return {
    async exec(sql) { db.exec(sql); },
    async run(sql, params = []) { db.prepare(sql).run(...(params as any[])); },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as any[])) as T[];
    },
  };
}

interface Spy extends PrefsSecure {
  reads: string[];
  writes: Array<[string, string | null]>;
}

/** A keystore double. `failOn` names keys whose read throws, as a locked one does. */
function secureDouble(initial: Record<string, string> = {}, failOn: string[] = []): Spy {
  const store = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: Array<[string, string | null]> = [];
  return {
    reads,
    writes,
    async get(key) {
      reads.push(key);
      if (failOn.includes(key)) throw new Error(`keystore locked: ${key}`);
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key, value) { writes.push([key, value]); store.set(key, value); },
    async remove(key) { writes.push([key, null]); store.delete(key); },
  };
}

/** A keystore that must never be touched. Any call is the failure. */
function forbiddenSecure(): PrefsSecure {
  return {
    async get(key) { throw new Error(`keystore read of ${key} should not happen`); },
    async set(key) { throw new Error(`keystore write of ${key} should not happen`); },
    async remove(key) { throw new Error(`keystore delete of ${key} should not happen`); },
  };
}

function rows(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.prepare('SELECT key, value FROM prefs').all() as any[]) {
    out[r.key] = r.value;
  }
  return out;
}

async function main() {
  console.log('--- 1. A FRESH INSTALL ---');
  {
    const db = new DatabaseSync(':memory:');
    const secure = secureDouble();
    const store = createPrefsStore({ sql: nodeSql(db), secure, keys: KEYS });

    assert.equal(store.loaded(), false, 'not loaded before load()');
    const report = await store.load();

    assert.equal(report.source, 'migrated', 'the first launch is a sweep');
    assert.equal(report.migrated, 0, 'nothing to migrate on a fresh install');
    assert.equal(report.secureReads, KEYS.length, 'it asked once, and found nothing');
    assert.equal(store.loaded(), true);
    for (const k of KEYS) assert.equal(store.get(k), null, `${k} unset`);
    assert.equal(rows(db)[MIGRATED_KEY], '1', 'the sweep is recorded even when empty');
    console.log('  ok');
  }

  console.log('--- 2. THE UPGRADE: VALUES COME OUT OF THE KEYSTORE ---');
  {
    const db = new DatabaseSync(':memory:');
    const secure = secureDouble({
      'planner.calendarView': 'week',
      'planner.interval': '15',
      'planner.themeMode': 'dark',
    });
    const store = createPrefsStore({ sql: nodeSql(db), secure, keys: KEYS });
    const report = await store.load();

    assert.equal(report.source, 'migrated');
    assert.equal(report.migrated, 3, 'three values found and copied');
    assert.equal(store.get('planner.calendarView'), 'week');
    assert.equal(store.get('planner.interval'), '15');
    assert.equal(store.get('planner.themeMode'), 'dark');
    assert.equal(store.get('planner.visibleHours'), null, 'a key that was never set stays unset');

    const onDisk = rows(db);
    assert.equal(onDisk['planner.calendarView'], 'week', 'copied into SQL, not just memory');
    assert.equal(onDisk['planner.themeMode'], 'dark');
    assert.equal(onDisk[MIGRATED_KEY], '1');
    console.log('  ok');
  }

  console.log('--- 3. EVERY LATER LAUNCH TOUCHES NO KEYSTORE AT ALL ---');
  {
    const db = new DatabaseSync(':memory:');
    const first = createPrefsStore({
      sql: nodeSql(db),
      secure: secureDouble({ 'planner.interval': '5', 'planner.themeMode': 'light' }),
      keys: KEYS,
    });
    await first.load();

    // A second store over the SAME database is the next launch. Its keystore
    // throws on every call, so any read at all fails the test rather than
    // merely being slow.
    const second = createPrefsStore({
      sql: nodeSql(db), secure: forbiddenSecure(), keys: KEYS,
    });
    const report = await second.load();

    assert.equal(report.source, 'sql', 'the steady state is one SELECT');
    assert.equal(report.secureReads, 0, 'and zero keystore traffic');
    assert.equal(second.get('planner.interval'), '5', 'values survived');
    assert.equal(second.get('planner.themeMode'), 'light');
    console.log('  ok');
  }

  console.log('--- 4. A SWEEP THAT DIED HALFWAY FINISHES NEXT TIME ---');
  {
    const db = new DatabaseSync(':memory:');
    // Two values already copied in, but the marker never written: exactly what a
    // process killed mid-migration leaves behind.
    db.exec('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('planner.interval', '10');
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('planner.themeMode', 'dark');

    const secure = secureDouble({
      'planner.interval': '60',          // stale: SQL already has the newer copy
      'planner.calendarView': 'month',   // never copied
    });
    const store = createPrefsStore({ sql: nodeSql(db), secure, keys: KEYS });
    const report = await store.load();

    assert.equal(report.source, 'migrated', 'no marker means the sweep runs again');
    assert.equal(report.migrated, 1, 'only the key that was still missing');
    assert.ok(
      !secure.reads.includes('planner.interval'),
      'a key already in SQL is never read from the keystore again',
    );
    assert.equal(store.get('planner.interval'), '10', 'SQL wins over the stale keystore copy');
    assert.equal(store.get('planner.calendarView'), 'month', 'and the missing one arrived');
    assert.equal(rows(db)[MIGRATED_KEY], '1', 'now it is recorded as done');
    console.log('  ok');
  }

  console.log('--- 5. A SETTING CLEARED AFTER MIGRATION STAYS CLEARED ---');
  {
    const db = new DatabaseSync(':memory:');
    const sql = nodeSql(db);
    const first = createPrefsStore({
      sql, secure: secureDouble({ 'planner.themeMode': 'dark' }), keys: KEYS,
    });
    await first.load();
    first.set('planner.themeMode', null);
    await first.flush();

    // The value is still sitting in the keystore. The marker must stop it being
    // resurrected on the next launch, which is the whole reason the marker is a
    // row rather than a count of keys.
    const second = createPrefsStore({
      sql, secure: secureDouble({ 'planner.themeMode': 'dark' }), keys: KEYS,
    });
    await second.load();
    assert.equal(second.get('planner.themeMode'), null, 'the ghost did not come back');
    console.log('  ok');
  }

  console.log('--- 6. WRITES PERSIST, AND THE LAST ONE WINS ---');
  {
    const db = new DatabaseSync(':memory:');
    const sql = nodeSql(db);
    const store = createPrefsStore({ sql, secure: secureDouble(), keys: KEYS });
    await store.load();

    store.set('planner.calendarView', 'day');
    assert.equal(store.get('planner.calendarView'), 'day', 'memory updates synchronously');

    // A burst, as fast as a finger can tap through the view chips.
    store.set('planner.calendarView', 'week');
    store.set('planner.calendarView', 'month');
    store.set('planner.calendarView', 'year');
    await store.flush();

    assert.equal(rows(db)['planner.calendarView'], 'year', 'the chain kept the order');

    const next = createPrefsStore({ sql, secure: forbiddenSecure(), keys: KEYS });
    await next.load();
    assert.equal(next.get('planner.calendarView'), 'year', 'and it survives a relaunch');
    console.log('  ok');
  }

  console.log('--- 7. A WRITE DURING LAUNCH BEATS THE VALUE OFF THE DISK ---');
  {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run(MIGRATED_KEY, '1');
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('planner.themeMode', 'dark');

    const slow: PrefsSql = {
      ...nodeSql(db),
      async all<T>(q: string, params: unknown[] = []) {
        await new Promise(r => setTimeout(r, 20));
        return db.prepare(q).all(...(params as any[])) as T[];
      },
    };
    const store = createPrefsStore({ sql: slow, secure: secureDouble(), keys: KEYS });

    const loading = store.load();
    // The user taps "light" while the splash is still up.
    store.set('planner.themeMode', 'light');
    await loading;

    assert.equal(
      store.get('planner.themeMode'), 'light',
      'the choice just made is not reverted by the older value arriving',
    );
    await store.flush();
    assert.equal(rows(db)['planner.themeMode'], 'light');
    console.log('  ok');
  }

  console.log('--- 8. A DELETE DURING LAUNCH ALSO BEATS THE DISK ---');
  {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run(MIGRATED_KEY, '1');
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('planner.interval', '30');

    const slow: PrefsSql = {
      ...nodeSql(db),
      async all<T>(q: string, params: unknown[] = []) {
        await new Promise(r => setTimeout(r, 20));
        return db.prepare(q).all(...(params as any[])) as T[];
      },
    };
    const store = createPrefsStore({ sql: slow, secure: secureDouble(), keys: KEYS });
    const loading = store.load();
    store.set('planner.interval', null);
    await loading;

    assert.equal(store.get('planner.interval'), null, 'the clear stuck');
    console.log('  ok');
  }

  console.log('--- 9. SQL THAT WILL NOT READ FALLS BACK TO THE OLD BEHAVIOUR ---');
  {
    const broken: PrefsSql = {
      async exec() { throw new Error('database is locked'); },
      async run() { throw new Error('database is locked'); },
      async all<T>() { throw new Error('database is locked'); },
    };
    const secure = secureDouble({ 'planner.interval': '45', 'planner.themeMode': 'dark' });
    const errors: string[] = [];
    const store = createPrefsStore({
      sql: broken, secure, keys: KEYS, onError: where => errors.push(where),
    });
    const report = await store.load();

    assert.equal(report.source, 'secure-fallback');
    assert.equal(report.secureReads, KEYS.length, 'it read every key the slow way');
    assert.match(report.sqlError ?? '', /locked/);
    assert.equal(store.get('planner.interval'), '45', 'and the app still has its settings');
    assert.equal(store.get('planner.themeMode'), 'dark');
    assert.ok(errors.includes('load'), 'the failure was reported, not swallowed silently');
    console.log('  ok');
  }

  console.log('--- 10. SQL THAT WILL NOT WRITE STILL KEEPS THE SETTING ---');
  {
    const db = new DatabaseSync(':memory:');
    const base = nodeSql(db);
    let refuse = false;
    const flaky: PrefsSql = {
      ...base,
      async run(q, params) {
        if (refuse) throw new Error('disk full');
        return base.run(q, params);
      },
    };
    const secure = secureDouble();
    const store = createPrefsStore({ sql: flaky, secure, keys: KEYS });
    await store.load();

    refuse = true;
    store.set('planner.themeMode', 'light');
    await store.flush();

    assert.equal(store.get('planner.themeMode'), 'light', 'the screen still shows the choice');
    assert.deepEqual(
      secure.writes.at(-1), ['planner.themeMode', 'light'],
      'and it landed in the keystore rather than nowhere',
    );
    console.log('  ok');
  }

  console.log('--- 11. A LOCKED KEYSTORE COSTS ONE VALUE, NOT ALL OF THEM ---');
  {
    const db = new DatabaseSync(':memory:');
    const secure = secureDouble(
      { 'planner.interval': '20', 'planner.themeMode': 'dark', 'planner.calendarView': 'week' },
      ['planner.themeMode'],
    );
    const errors: string[] = [];
    const store = createPrefsStore({
      sql: nodeSql(db), secure, keys: KEYS, onError: w => errors.push(w),
    });
    const report = await store.load();

    assert.equal(report.migrated, 2, 'the two that could be read');
    assert.equal(store.get('planner.interval'), '20');
    assert.equal(store.get('planner.calendarView'), 'week');
    assert.equal(store.get('planner.themeMode'), null, 'the unreadable one reads as unset');
    assert.ok(errors.some(e => e.includes('themeMode')));

    // And the marker is still written, so a permanently unreadable entry does
    // not make every future launch pay for the keystore again.
    assert.equal(rows(db)[MIGRATED_KEY], '1');
    console.log('  ok');
  }

  console.log('--- 12. AWKWARD VALUES SURVIVE THE ROUND TRIP ---');
  {
    const db = new DatabaseSync(':memory:');
    const sql = nodeSql(db);
    const store = createPrefsStore({ sql, secure: secureDouble(), keys: KEYS });
    await store.load();

    const awkward: Array<[string, string]> = [
      ['planner.visibleHours', JSON.stringify([{ start: 6, end: 23 }, { start: 0, end: 1 }])],
      ['planner.themeMode', 'lig\'ht"; DROP TABLE prefs; --'],
      ['planner.calendarView', 'مرحبا 🌙 \n\t multi\nline'],
      ['planner.interval', ''],
      ['planner.focusTimer', JSON.stringify({ blob: 'x'.repeat(120_000) })],
    ];
    for (const [k, v] of awkward) store.set(k, v);
    await store.flush();

    const next = createPrefsStore({ sql, secure: forbiddenSecure(), keys: KEYS });
    await next.load();
    for (const [k, v] of awkward) {
      assert.equal(next.get(k), v, `${k} round-tripped exactly`);
    }
    assert.equal(next.get('planner.interval'), '', 'an empty string is a value, not an absence');
    console.log('  ok');
  }

  console.log('--- 13. CONCURRENT LOADS DO THE WORK ONCE ---');
  {
    const db = new DatabaseSync(':memory:');
    let selects = 0;
    const counting: PrefsSql = {
      ...nodeSql(db),
      async all<T>(q: string, params: unknown[] = []) {
        selects += 1;
        await new Promise(r => setTimeout(r, 5));
        return db.prepare(q).all(...(params as any[])) as T[];
      },
    };
    const secure = secureDouble({ 'planner.interval': '30' });
    const store = createPrefsStore({ sql: counting, secure, keys: KEYS });

    const reports = await Promise.all([store.load(), store.load(), store.load()]);
    assert.equal(selects, 1, 'one SELECT no matter how many callers');
    assert.equal(secure.reads.length, KEYS.length, 'and one sweep, not three');
    assert.equal(reports[0], reports[1], 'every caller got the same report');
    assert.equal(reports[1], reports[2]);
    console.log('  ok');
  }

  console.log('--- 14. IT REFUSES KEYS IT DOES NOT OWN ---');
  {
    const db = new DatabaseSync(':memory:');
    const secure = secureDouble({ 'planner.session': 'secret-cookie' });
    const errors: string[] = [];
    const store = createPrefsStore({
      sql: nodeSql(db), secure, keys: KEYS, onError: w => errors.push(w),
    });
    await store.load();

    assert.ok(
      !secure.reads.includes('planner.session'),
      'the session token is never read by this store',
    );

    store.set('planner.session', 'stolen');
    await store.flush();
    assert.equal(store.get('planner.session'), null, 'and never written by it either');
    assert.equal(rows(db)['planner.session'], undefined, 'nothing reached the database');
    assert.ok(errors.includes('set'), 'the attempt was reported');
    console.log('  ok');
  }

  console.log('--- 15. THE MARKER IS NEVER VISIBLE AS A SETTING ---');
  {
    const db = new DatabaseSync(':memory:');
    const sql = nodeSql(db);
    const store = createPrefsStore({ sql, secure: secureDouble(), keys: KEYS });
    await store.load();
    assert.equal(store.get(MIGRATED_KEY), null, 'bookkeeping is not a preference');

    // Nor is a stray row from some future version of the app.
    db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run('planner.somethingNew', 'x');
    const next = createPrefsStore({ sql, secure: forbiddenSecure(), keys: KEYS });
    await next.load();
    assert.equal(next.get('planner.somethingNew'), null, 'unknown rows are ignored, not adopted');
    console.log('  ok');
  }

  console.log('--- 16. A DRIVER THAT HANDS BACK RUBBISH DOES NOT CRASH THE APP ---');
  {
    const db = new DatabaseSync(':memory:');
    const weird: PrefsSql = {
      ...nodeSql(db),
      async all<T>() {
        return ([
          { key: 'planner.interval', value: '25' },
          { key: 'planner.themeMode', value: null },
          { key: 42, value: 'nonsense' },
          null,
          undefined,
          { nothing: true },
        ] as unknown) as T[];
      },
    };
    const store = createPrefsStore({ sql: weird, secure: secureDouble(), keys: KEYS });
    await store.load();
    assert.equal(store.get('planner.interval'), '25', 'the good row still came through');
    assert.equal(store.get('planner.themeMode'), null, 'a null column reads as unset');
    console.log('  ok');
  }

  console.log('--- 17. CLEAR EMPTIES BOTH SIDES ---');
  {
    const db = new DatabaseSync(':memory:');
    const sql = nodeSql(db);
    const secure = secureDouble({ 'planner.interval': '30', 'planner.themeMode': 'dark' });
    const store = createPrefsStore({ sql, secure, keys: KEYS });
    await store.load();
    assert.equal(store.get('planner.interval'), '30');

    await store.clear();
    assert.equal(store.get('planner.interval'), null, 'memory cleared');
    assert.deepEqual(rows(db), {}, 'the table is empty, marker included');
    for (const k of KEYS) {
      assert.ok(
        secure.writes.some(([key, v]) => key === k && v === null),
        `${k} was removed from the keystore too`,
      );
    }

    // And the next launch is a clean fresh install, not a half-state.
    const next = createPrefsStore({ sql, secure: secureDouble(), keys: KEYS });
    const report = await next.load();
    assert.equal(report.source, 'migrated');
    assert.equal(report.migrated, 0);
    console.log('  ok');
  }

  console.log('--- 18. NO DATABASE AT ALL IS STILL A WORKING PLANNER ---');
  {
    const secure = secureDouble({ 'planner.calendarView': 'agenda' });
    const store = createPrefsStore({ sql: null, secure, keys: KEYS });
    const report = await store.load();

    assert.equal(report.source, 'secure-fallback');
    assert.equal(store.get('planner.calendarView'), 'agenda');

    store.set('planner.calendarView', 'week');
    await store.flush();
    assert.deepEqual(secure.writes.at(-1), ['planner.calendarView', 'week']);
    assert.equal(await secure.get('planner.calendarView'), 'week');
    console.log('  ok');
  }

  console.log('--- 19. ONE FAILED WRITE DOES NOT POISON THE QUEUE ---');
  {
    const db = new DatabaseSync(':memory:');
    const base = nodeSql(db);
    let failNext = false;
    const flaky: PrefsSql = {
      ...base,
      async run(q, params) {
        if (failNext) { failNext = false; throw new Error('transient'); }
        return base.run(q, params);
      },
    };
    const secure = secureDouble();
    const store = createPrefsStore({ sql: flaky, secure, keys: KEYS });
    await store.load();

    failNext = true;
    store.set('planner.interval', '5');
    store.set('planner.themeMode', 'dark');
    store.set('planner.calendarView', 'week');
    await store.flush();

    const onDisk = rows(db);
    assert.equal(onDisk['planner.themeMode'], 'dark', 'the writes after the failure went through');
    assert.equal(onDisk['planner.calendarView'], 'week');
    assert.equal(store.get('planner.interval'), '5', 'and the failed one is still in memory');
    console.log('  ok');
  }

  console.log('--- 20. FLUSH WAITS FOR WORK QUEUED WHILE IT WAS WAITING ---');
  {
    const db = new DatabaseSync(':memory:');
    const base = nodeSql(db);
    const store = createPrefsStore({
      sql: {
        ...base,
        async run(q, params) {
          await new Promise(r => setTimeout(r, 5));
          return base.run(q, params);
        },
      },
      secure: secureDouble(),
      keys: KEYS,
    });
    await store.load();

    store.set('planner.interval', '1');
    const flushing = store.flush();
    store.set('planner.interval', '2');
    await flushing;

    assert.equal(rows(db)['planner.interval'], '2', 'the late write was caught');
    console.log('  ok');
  }

  console.log('--- 21. THE SWEEP COSTS ONE ROUND OF READS, NOT ONE PER GET ---');
  {
    const db = new DatabaseSync(':memory:');
    const secure = secureDouble({ 'planner.interval': '30' });
    const store = createPrefsStore({ sql: nodeSql(db), secure, keys: KEYS });
    await store.load();

    const before = secure.reads.length;
    for (let i = 0; i < 100; i++) {
      store.get('planner.interval');
      store.get('planner.themeMode');
    }
    assert.equal(secure.reads.length, before, 'reads are pure memory after launch');
    assert.equal(before, KEYS.length, 'and the sweep asked each key exactly once');
    console.log('  ok');
  }

  console.log('\nAll prefsStore tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
