// Tests the pull cursor — the number that decides which operations a device is
// still owed — against the failure that made PC→phone sync stop dead.
//
// THE BUG THIS SUITE EXISTS FOR
// The cursor is a POSITION IN THE SERVER'S LOG. It used to be a lamport counter,
// and a device that stored one from that era kept it: a real phone was asking
// for everything after position 2203 of a log whose head was 951.
//
// Nothing is ever greater than 2203, so `log.filter(op => op.seq > since)`
// returned an empty array every single time. The phone received NOTHING from the
// PC, for ever. And it looked perfectly healthy while doing it — it polled every
// ten seconds, acknowledged, reported "In sync with PC", and pushed its own
// edits successfully, which is why phone→PC worked and PC→phone never did.
//
// Two separate mistakes kept it wedged, and this file covers both:
//   • the server answered with `max(since, seq)`, handing the bad number back so
//     the phone stored it again — a self-sealing loop
//   • the client kept `max(ours, theirs)`, so a cursor once too high could never
//     come down even when the server did report the truth
//
// Run with: npx tsx src/lib/syncCursor.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyClientData, syncOnce, readClientStore, type SyncTransport } from './syncClient';
import { createSyncService, handleSyncRequest, type UserSyncPaths } from '../../sync-service';
import { createTransport } from './syncTransport';

const USER = 'mamoun';
const PHONE = 'android-cursortest';
let tmpRoot = '';

async function freshUser(label: string, events: Record<string, unknown> = {}) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
  };
  await fsp.writeFile(paths.dbPath, JSON.stringify(events, null, 2), 'utf-8');
  await fsp.writeFile(paths.tasksPath, '{}', 'utf-8');
  return paths;
}

function httpTransport(svc: any, paths: UserSyncPaths) {
  const fetchImpl = async (url: string, init: any) => {
    const action = new URL(url).pathname.replace(/^\/api\/sync/, '');
    const answer = await handleSyncRequest(svc, USER, paths, {
      action, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {},
    });
    const text = JSON.stringify(answer.payload);
    return {
      ok: answer.status < 400, status: answer.status,
      headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text),
    };
  };
  return createTransport({ baseUrl: 'http://pc.local', session: 's', fetchImpl: fetchImpl as any });
}

async function pcEdits(svc: any, paths: UserSyncPaths, snapshot: Record<string, unknown>) {
  await fsp.writeFile(paths.dbPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  await svc.ingestFile(USER, paths, 'events', snapshot);
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-cursor-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. THE REPORTED BUG: A CURSOR PAST THE HEAD RECOVERS ---');
  {
    const paths = await freshUser('stranded', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    // Exactly his situation: the stored cursor is a lamport from an older build,
    // far beyond any position this log has ever issued.
    const status = await svc.status(USER, paths);
    phone = { ...phone, cursor: status.seq + 1_500 };

    // The PC makes a change the phone must see.
    await pcEdits(svc, paths, {
      ev1: { content: 'Lecture', completedDates: ['2026-08-29'] },
      ev2: { content: 'Added on the PC' },
    });

    const out = await syncOnce(phone, t, 2_000);
    phone = out.data;

    assert.equal(out.didFullResync, true, 'An impossible cursor forces a full resync');
    const events = readClientStore(phone, 'events') as any;
    assert.deepEqual(events.ev1.completedDates, ['2026-08-29'],
      'and the PC change arrives after all');
    assert.ok(events.ev2, 'including a whole new event');
    assert.equal(phone.cursor, (await svc.status(USER, paths)).seq,
      'and the cursor is a real log position again');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. AND KEEPS WORKING AFTERWARDS ---');
  {
    // Recovering once is not enough: the old code re-poisoned the cursor on the
    // very next pull by echoing it back.
    const paths = await freshUser('stays-fixed', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;
    phone = { ...phone, cursor: 99_999 };
    phone = (await syncOnce(phone, t, 2_000)).data;

    for (let i = 0; i < 10; i++) {
      await pcEdits(svc, paths, { ev1: { content: `Lecture ${i}` } });
      const out = await syncOnce(phone, t, 3_000 + i);
      phone = out.data;
      assert.ok(out.pulled > 0, `Round ${i}: the PC change was delivered`);
      assert.equal((readClientStore(phone, 'events') as any).ev1.content, `Lecture ${i}`,
        `Round ${i}: and applied`);
      assert.equal(phone.cursor, (await svc.status(USER, paths)).seq,
        `Round ${i}: cursor still tracks the head`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. THE SERVER NEVER ECHOES A CURSOR IT DID NOT ISSUE ---');
  {
    const paths = await freshUser('no-echo', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    await svc.snapshot(USER, paths, PHONE);
    const head = (await svc.status(USER, paths)).seq;

    for (const since of [head + 1, head + 500, 1e6, Number.MAX_SAFE_INTEGER]) {
      const res = await t.pull(PHONE, since);
      assert.equal(res.cursor, head, `since=${since} is answered with the real head`);
      assert.equal(res.needsFullResync, true, `and flagged for resync`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. ORDINARY CURSORS ARE UNAFFECTED ---');
  {
    const paths = await freshUser('normal', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    await svc.snapshot(USER, paths, PHONE);
    for (let i = 0; i < 5; i++) await pcEdits(svc, paths, { ev1: { content: `L${i}` } });
    const head = (await svc.status(USER, paths)).seq;

    const fromZero = await t.pull(PHONE, 0);
    assert.ok(fromZero.ops.length > 0, 'A cursor of zero still gets everything');
    assert.equal(fromZero.needsFullResync, false, 'without needing a resync');

    const atHead = await t.pull(PHONE, head);
    assert.equal(atHead.ops.length, 0, 'A cursor at the head gets nothing new');
    assert.equal(atHead.needsFullResync, false, 'and is perfectly valid');
    assert.equal(atHead.cursor, head, 'and stays at the head');

    const midway = await t.pull(PHONE, Math.floor(head / 2));
    assert.ok(midway.ops.length > 0, 'A cursor midway gets the remainder');
    assert.ok(midway.ops.every(o => (o.seq ?? 0) > Math.floor(head / 2)),
      'and only the remainder');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. A PHONE THAT LOOKS HEALTHY BUT RECEIVES NOTHING IS IMPOSSIBLE ---');
  {
    // The property that would have caught this on day one: after a completed
    // sync with no error, the phone must actually hold what the server holds.
    // The old failure passed every other check while violating exactly this.
    const paths = await freshUser('honest', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = emptyClientData(PHONE);
    phone = (await syncOnce(phone, t, 1_000)).data;

    for (const cursor of [0, 7, 99_999, 2_203]) {
      phone = { ...phone, cursor };
      await pcEdits(svc, paths, {
        ev1: { content: `Lecture ${cursor}` },
        [`ev${cursor}`]: { content: `Marker ${cursor}` },
      });
      const out = await syncOnce(phone, t, 5_000 + cursor);
      phone = out.data;
      assert.equal(out.error, undefined, `cursor=${cursor}: the sync reported success`);

      const mine = readClientStore(phone, 'events') as any;
      const theirs = (await svc.snapshot(USER, paths, 'probe')).stores.events as any;
      assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort(),
        `cursor=${cursor}: a successful sync means the phone really has everything`);
      assert.equal(mine.ev1.content, theirs.ev1.content,
        `cursor=${cursor}: with the same values`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. A TRIMMED LOG STILL RESYNCS (THE OTHER DIRECTION) ---');
  {
    const paths = await freshUser('trimmed', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    await svc.snapshot(USER, paths, PHONE);
    for (let i = 0; i < 5; i++) await pcEdits(svc, paths, { ev1: { content: `L${i}` } });

    const res = await t.pull(PHONE, 0);
    // With nothing trimmed, zero is a legitimate cursor.
    assert.equal(res.needsFullResync, false, 'Zero is fine on an untrimmed log');

    let phone = { ...emptyClientData(PHONE), cursor: 0 };
    const out = await syncOnce(phone, t, 9_000);
    assert.equal(out.error, undefined, 'and syncs cleanly');
    assert.equal((readClientStore(out.data, 'events') as any).ev1.content, 'L4',
      'ending up current');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (cursor: impossible positions recover, server owns the number)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
