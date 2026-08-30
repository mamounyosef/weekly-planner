// Tests the waiting pull, and the cost of doing nothing.
//
// WHY THIS EXISTS
// A change made on the phone syncs the moment it is made; a change made on the
// PC cannot be delivered, because the PC has no way to reach the phone. That one
// asymmetry is the only reason a timer ever existed, and it bought the worst of
// both: a full sync cycle six times a minute forever, AND up to ten seconds of
// staleness whenever something did happen.
//
// Holding the request inverts it. The phone asks once; the server answers the
// instant the log moves. This file pins down the three things that have to be
// true for that to be an improvement rather than a new class of bug:
//
//   • a parked request must never hold the per-user queue — everything else for
//     that user would block, including the write that would wake it
//   • a doing-nothing cycle must actually write nothing
//   • a request must always come back, whether or not anything happened
//
// Run with: npx tsx src/lib/syncWaiting.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncService, handleSyncRequest, validateWait, MAX_PULL_WAIT_MS, type UserSyncPaths } from '../../sync-service';
import { forgetWrittenBundle } from '../../sync-server';
import { createTransport } from './syncTransport';
import { emptyClientData, readClientStore, syncOnce } from './syncClient';

const USER = 'mamoun';
const PHONE = 'android-waiting';
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
  forgetWrittenBundle(dbDir);
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

/** Newest write time across the sync files, for measuring idle cost. */
async function syncFileStamps(paths: UserSyncPaths): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of ['sync-oplog.json', 'sync-state.json', 'sync-devices.json', 'sync-meta.json', 'sync-conflicts.json']) {
    try {
      out[name] = (await fsp.stat(path.join(paths.dbDir, name))).mtimeMs;
    } catch { /* not written yet */ }
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-waiting-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. A PC CHANGE WAKES A PARKED PULL AT ONCE ---');
  {
    const paths = await freshUser('wake', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);
    const head = (await svc.status(USER, paths)).seq;

    const started = Date.now();
    const parked = svc.pullWaiting(USER, paths, PHONE, head, 5_000);

    // Let it actually park before anything changes, or the test proves nothing.
    await sleep(60);
    await pcEdits(svc, paths, { ev1: { content: 'Lecture', notes: 'moved room' } });

    const res = await parked;
    const took = Date.now() - started;

    assert.ok(res.ops.length > 0, 'The parked pull came back with the change');
    assert.ok(took < 2_000, `and returned as soon as it happened, not on a timer (${took}ms)`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. NOTHING TO SAY: IT RETURNS EMPTY, ON TIME ---');
  {
    const paths = await freshUser('quiet', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);
    const head = (await svc.status(USER, paths)).seq;

    const started = Date.now();
    const res = await svc.pullWaiting(USER, paths, PHONE, head, 300);
    const took = Date.now() - started;

    assert.equal(res.ops.length, 0, 'Nothing happened, so nothing came back');
    assert.ok(took >= 250, `and it did wait (${took}ms)`);
    assert.ok(took < 3_000, 'but it did come back');
    assert.equal(res.cursor, head, 'with the cursor where it was');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. A PARKED PULL DOES NOT BLOCK ANYTHING ELSE ---');
  {
    // The failure this guards against would be total: parking inside the
    // per-user queue would block every other request for that user, including
    // the write meant to wake it. The planner would simply stop.
    const paths = await freshUser('nonblocking', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);
    const head = (await svc.status(USER, paths)).seq;

    const parked = svc.pullWaiting(USER, paths, PHONE, head, 4_000);
    await sleep(50);

    // Every other kind of request must still be served while it waits.
    const started = Date.now();
    const status = await svc.status(USER, paths);
    const conflicts = await svc.conflicts(USER, paths);
    await svc.push(USER, paths, {
      deviceId: 'other-device',
      ops: [{
        opId: 'other-device:5000', store: 'events' as const, entityId: 'ev1',
        field: 'notes', value: 'from elsewhere', device: 'other-device',
        lamport: 5000, at: Date.now(),
      }],
    });
    const elapsed = Date.now() - started;

    assert.ok(status.seq >= head, 'status answered while a pull was parked');
    assert.deepEqual(conflicts, [], 'and so did conflicts');
    assert.ok(elapsed < 2_000, `none of them waited on it (${elapsed}ms)`);

    // And that push is exactly what should have woken it.
    const res = await parked;
    assert.ok(res.ops.length > 0, 'the parked pull was woken by the other device');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. AN IDLE CYCLE WRITES NOTHING AT ALL ---');
  {
    // The measurement that started this: every request used to rewrite the log
    // and the state whether or not anything had changed — well over half a
    // megabyte, twice per poll, for a planner nobody was touching.
    const paths = await freshUser('idle', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);

    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;
    await svc.status(USER, paths);          // let the first sweep happen
    await sleep(20);

    const before = await syncFileStamps(paths);
    for (let i = 0; i < 10; i++) {
      const out = await syncOnce(phone, t, 2_000 + i);
      phone = out.data;
      assert.equal(out.pulled, 0, `cycle ${i} had nothing to fetch`);
    }
    const after = await syncFileStamps(paths);

    const rewritten = Object.keys(before).filter(f => before[f] !== after[f]);
    assert.deepEqual(rewritten, [],
      `Ten idle cycles rewrote nothing (touched: ${rewritten.join(', ') || 'none'})`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. A REAL CHANGE STILL WRITES EVERYTHING IT MUST ---');
  {
    // The other half: making writes conditional must not make them optional.
    const paths = await freshUser('realwrite', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;
    await sleep(20);

    const before = await syncFileStamps(paths);
    await pcEdits(svc, paths, { ev1: { content: 'Changed' } });
    const after = await syncFileStamps(paths);

    assert.notEqual(before['sync-oplog.json'], after['sync-oplog.json'], 'The log was written');
    assert.notEqual(before['sync-state.json'], after['sync-state.json'], 'and the state');

    // And it survives a restart, which is the only thing the writing was for.
    const svc2 = createSyncService();
    const seen = await svc2.snapshot(USER, paths, 'probe');
    assert.equal((seen.stores.events as any).ev1.content, 'Changed',
      'and a fresh service reads it back');

    phone = (await syncOnce(phone, t, 3_000)).data;
    assert.equal((readClientStore(phone, 'events') as any).ev1.content, 'Changed',
      'and the phone receives it');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. AN ACK THAT SAYS NOTHING IS NOT SENT ---');
  {
    const paths = await freshUser('noack', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    const calls: string[] = [];
    const inner = httpTransport(svc, paths);
    const counted = {
      ...inner,
      pull: (d: string, since: number, w?: number) => { calls.push('pull'); return inner.pull(d, since, w); },
      push: (d: string, ops: any[]) => { calls.push('push'); return inner.push(d, ops); },
      ack: (d: string, c: number) => { calls.push('ack'); return inner.ack(d, c); },
      snapshot: (d: string) => { calls.push('snapshot'); return inner.snapshot(d); },
      resolve: inner.resolve.bind(inner),
    };

    let phone = (await syncOnce(emptyClientData(PHONE), counted as any, 1_000)).data;
    calls.length = 0;

    for (let i = 0; i < 5; i++) {
      phone = (await syncOnce(phone, counted as any, 2_000 + i)).data;
    }
    assert.equal(calls.filter(c => c === 'ack').length, 0,
      'Five idle cycles sent no acknowledgements at all');
    assert.equal(calls.filter(c => c === 'pull').length, 5, 'just the five pulls');

    // But a cycle that moves the cursor must still acknowledge, or the server
    // never learns how far this device has got and the log can never be trimmed.
    await pcEdits(svc, paths, { ev1: { content: 'Moved on' } });
    calls.length = 0;
    phone = (await syncOnce(phone, counted as any, 9_000)).data;
    assert.equal(calls.filter(c => c === 'ack').length, 1,
      'and a cycle that received something does acknowledge');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. THE HOLD IS BOUNDED AND HOSTILE INPUT CANNOT EXTEND IT ---');
  {
    for (const [raw, expected] of [
      [undefined, 0], [null, 0], ['25000', 0], [-1, 0], [0, 0], [NaN, 0], [Infinity, 0],
      [1_000, 1_000], [24_999.7, 24_999], [MAX_PULL_WAIT_MS, MAX_PULL_WAIT_MS],
      [10 ** 9, MAX_PULL_WAIT_MS], [Number.MAX_SAFE_INTEGER, MAX_PULL_WAIT_MS],
    ] as [unknown, number][]) {
      assert.equal(validateWait(raw), expected, `wait=${String(raw)} clamps to ${expected}`);
    }
    assert.ok(MAX_PULL_WAIT_MS < 60_000,
      'and the cap sits below the point where proxies and radios drop a connection');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. MANY DEVICES PARKED AT ONCE ALL WAKE ---');
  {
    const paths = await freshUser('many', { ev1: { content: 'Lecture' } });
    const svc = createSyncService();
    await svc.snapshot(USER, paths, PHONE);
    const head = (await svc.status(USER, paths)).seq;

    const parked = Array.from({ length: 6 }, (_, i) =>
      svc.pullWaiting(USER, paths, `device-${i}`, head, 5_000));
    await sleep(60);
    await pcEdits(svc, paths, { ev1: { content: 'Woken' } });

    const results = await Promise.all(parked);
    for (const [i, r] of results.entries()) {
      assert.ok(r.ops.length > 0, `device ${i} was woken with the change`);
    }
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (waiting pull: instant delivery, free idling, nothing blocked)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
