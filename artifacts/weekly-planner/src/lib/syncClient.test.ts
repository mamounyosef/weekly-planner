// Tests the phone's sync engine: the outbox, the push/pull/ack cycle, and every
// way a mobile network can fail in the middle of one.
//
// The controlling question in every case below is the same: CAN AN EDIT BE LOST?
// A dropped response, a crash between pull and save, a server that forgot this
// device, a resend, a request that succeeds but whose reply never arrives — each
// must cost at most a retry.
//
// Run with: npx tsx src/lib/syncClient.test.ts

import assert from 'node:assert/strict';
import { emptyState, makeOps, mergeOps, readStore, type SyncConflict, type SyncOp } from './sync';
import { opsToSnapshot, snapshotToOps, type Snapshot } from './syncBridge';
import {
  applyLocalChange,
  applyLocalDelete,
  applyLocalRecord,
  applyLocalResolution,
  backoffDelay,
  MAX_RETRY_MS,
  describeAgo,
  describeStatus,
  OFFLINE_AFTER_MS,
  emptyClientData,
  fullResync,
  mergeConflicts,
  readClientStore,
  reconcileConflicts,
  syncOnce,
  withJitter,
  type ClientData,
  type PullResponse,
  type PushResponse,
  type SnapshotResponse,
  type SyncTransport,
} from './syncClient';

const PH = 'phone-android';
const PC = 'pc-desktop';

/**
 * A fake server that behaves like the real one, plus switches for every failure
 * we need to force. It runs the SAME merge engine, so a test that passes here is
 * evidence about the real pairing rather than about the fake.
 */
class FakeServer implements SyncTransport {
  state = emptyState();
  log: SyncOp[] = [];
  conflicts: SyncConflict[] = [];
  cursors = new Map<string, number>();

  /** Failure switches. */
  failPush = false;
  failPull = false;
  failAck = false;
  failSnapshot = false;
  /** Applies the push, then throws — the "response lost" case. */
  loseePushResponse = false;
  forceFullResync = false;
  /** Ops trimmed away, so an old device cannot catch up incrementally. */
  logFloor = 0;

  pushCalls = 0;
  pullCalls = 0;
  ackCalls = 0;
  snapshotCalls = 0;
  lastPushed: SyncOp[] = [];

  seed(snapshot: Snapshot, store: any = 'events') {
    const ops = snapshotToOps(this.state, { store, snapshot, device: PC, at: 1_000 });
    this.state = mergeOps(this.state, ops).state;
    this.log.push(...ops);
  }

  /** An edit made on the PC while the phone is away. */
  pcEdit(entityId: string, changes: Record<string, unknown>, at: number, store: any = 'events') {
    const ops = makeOps(this.state, { store, entityId, device: PC, at, changes });
    const merged = mergeOps(this.state, ops);
    this.state = merged.state;
    this.log.push(...ops);
    this.conflicts = [...this.conflicts, ...merged.conflicts];
    return ops;
  }

  async push(deviceId: string, ops: SyncOp[]): Promise<PushResponse> {
    this.pushCalls += 1;
    if (this.failPush) throw new Error('Network request failed');
    this.lastPushed = ops;

    const fresh = ops.filter(o => !this.state.applied[o.opId]);
    const merged = mergeOps(this.state, ops);
    this.state = merged.state;
    this.log.push(...fresh);
    this.conflicts = [...this.conflicts, ...merged.conflicts];
    this.cursors.set(deviceId, Math.max(this.cursors.get(deviceId) ?? 0, this.state.lamport));

    if (this.loseePushResponse) throw new Error('Network request failed');
    return {
      accepted: fresh.length,
      ignored: ops.length - fresh.length,
      conflicts: merged.conflicts,
      cursor: this.state.lamport,
    };
  }

  async pull(deviceId: string, since: number): Promise<PullResponse> {
    this.pullCalls += 1;
    if (this.failPull) throw new Error('Network request failed');
    const needsFullResync = this.forceFullResync || (since > 0 && this.logFloor > since + 1);
    const ops = needsFullResync
      ? []
      : this.log.filter(o => o.lamport > since && o.lamport > this.logFloor && o.device !== deviceId);
    return {
      ops,
      cursor: this.state.lamport,
      conflicts: this.conflicts,
      needsFullResync,
      serverTime: 50_000,
    };
  }

  async ack(deviceId: string, cursor: number) {
    this.ackCalls += 1;
    if (this.failAck) throw new Error('Network request failed');
    this.cursors.set(deviceId, Math.max(this.cursors.get(deviceId) ?? 0, cursor));
    return { cursor };
  }

  async snapshot(deviceId: string): Promise<SnapshotResponse> {
    this.snapshotCalls += 1;
    if (this.failSnapshot) throw new Error('Network request failed');
    this.cursors.set(deviceId, this.state.lamport);
    return {
      stores: {
        events: opsToSnapshot(this.state, 'events'),
        tasks: opsToSnapshot(this.state, 'tasks'),
      },
      cursor: this.state.lamport,
      lamport: this.state.lamport,
      conflicts: this.conflicts,
      serverTime: 50_000,
    };
  }

  async resolve() {
    return {};
  }
}

/** Persist and reload, the way an app restart would. */
const restart = (d: ClientData): ClientData => JSON.parse(JSON.stringify(d));

console.log('--- 1. A LOCAL EDIT IS INSTANT AND QUEUED ---');
{
  let d = emptyClientData(PH);
  d = applyLocalChange(d, {
    store: 'events', entityId: 'ev1', at: 1_000,
    changes: { title: 'Physics', startTime: '18:00' },
  });

  assert.equal(readClientStore(d, 'events').ev1.title, 'Physics',
    'The UI can read the edit immediately — no network in the path');
  assert.equal(d.outbox.length, 2, 'and both fields are queued');
  assert.ok(d.outbox.every(o => o.device === PH), 'attributed to this device');

  // An edit that changes nothing must not queue anything.
  const same = applyLocalRecord(d, {
    store: 'events', entityId: 'ev1', at: 2_000,
    record: { title: 'Physics', startTime: '18:00' },
  });
  assert.equal(same.outbox.length, 2, 'A no-op save queues nothing');
  assert.equal(same, d, 'and returns the same object, so React does not re-render');
}

console.log('--- 2. WHOLE-RECORD SAVES DIFF THEMSELVES ---');
{
  let d = emptyClientData(PH);
  d = applyLocalRecord(d, {
    store: 'events', entityId: 'ev1', at: 1_000,
    record: { title: 'a', startTime: '09:00', categoryId: 'uni' },
  });
  const before = d.outbox.length;

  d = applyLocalRecord(d, {
    store: 'events', entityId: 'ev1', at: 2_000,
    record: { title: 'a', startTime: '10:00', categoryId: 'uni' },
  });
  assert.equal(d.outbox.length - before, 1,
    'Saving a form emits one op for the one field that changed, not three');
  assert.equal(d.outbox[d.outbox.length - 1].field, 'startTime');
}

console.log('--- 3. A CLEAN CYCLE ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'Physics', startTime: '18:00' } });

  let d = emptyClientData(PH);
  const first = await syncOnce(d, server, 10_000);
  d = first.data;
  assert.equal(first.phase, 'idle');
  assert.equal(first.pulled, 2, 'The phone receives the existing planner');
  assert.equal(readClientStore(d, 'events').ev1.title, 'Physics');
  assert.equal(d.lastSyncedAt, 10_000);

  // A second cycle with nothing to do must be silent.
  const idle = await syncOnce(d, server, 11_000);
  assert.equal(idle.pulled, 0, 'A caught-up phone pulls nothing');
  assert.equal(idle.pushed, 0);
  assert.equal(server.pushCalls, 0, 'and does not even call push with an empty outbox');
}

console.log('--- 4. AN OFFLINE EDIT SURVIVES, RETRIES AND ARRIVES ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'Physics', startTime: '18:00' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  // Aeroplane mode.
  server.failPush = true;
  server.failPull = true;
  d = applyLocalChange(d, {
    store: 'events', entityId: 'ev1', at: 11_000, changes: { startTime: '20:00' },
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await syncOnce(d, server, 12_000 + attempt);
    d = r.data;
    assert.equal(r.phase, 'offline', `Attempt ${attempt} reports offline`);
    assert.equal(d.outbox.length, 1, `and KEEPS the edit queued (attempt ${attempt})`);
    assert.equal(readClientStore(d, 'events').ev1.startTime, '20:00',
      'while the UI still shows the edit');
    assert.equal(d.lastSyncedAt, 10_000, 'and lastSyncedAt does not lie about success');
  }

  // Signal comes back.
  server.failPush = false;
  server.failPull = false;
  const ok = await syncOnce(d, server, 20_000);
  d = ok.data;
  assert.equal(ok.phase, 'idle');
  assert.equal(d.outbox.length, 0, 'The queue drains');
  assert.equal(readStore(server.state, 'events').ev1.startTime, '20:00',
    'and the edit reached the server');
}

console.log('--- 5. A LOST RESPONSE MUST NOT LOSE THE EDIT ---');
{
  // The server applied the push, then the connection dropped before the reply.
  // This is the case where a naive client clears its queue and loses nothing —
  // or keeps it and duplicates. Neither may happen.
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { title: 'b' } });
  server.loseePushResponse = true;

  const lost = await syncOnce(d, server, 12_000);
  d = lost.data;
  assert.equal(lost.phase, 'offline');
  assert.equal(d.outbox.length, 1, 'The op stays queued because nothing confirmed it');

  // The retry resends it. The server must recognise it, not duplicate it.
  server.loseePushResponse = false;
  const retry = await syncOnce(d, server, 13_000);
  d = retry.data;
  assert.equal(d.outbox.length, 0);
  assert.equal(readStore(server.state, 'events').ev1.title, 'b');
  assert.equal(server.log.filter(o => o.field === 'title' && o.device === PH).length, 1,
    'Exactly one op in the server log — the resend did not duplicate it');
}

console.log('--- 6. AN EDIT MADE DURING A PUSH IS NOT DROPPED ---');
{
  // The user keeps typing while the request is in flight. Clearing the whole
  // outbox on success would silently discard that edit.
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;
  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { title: 'b' } });

  const inFlight = syncOnce(d, server, 12_000);
  // Simulate the concurrent edit landing on the pre-sync data, as it would.
  const withExtra = applyLocalChange(d, {
    store: 'events', entityId: 'ev1', at: 11_500, changes: { startTime: '09:00' },
  });
  const result = await inFlight;

  // The real app merges the outcome back onto current data; the invariant we
  // assert is that the cycle only removes ops it actually sent.
  const sentIds = new Set(server.lastPushed.map(o => o.opId));
  const survivors = withExtra.outbox.filter(o => !sentIds.has(o.opId));
  assert.equal(survivors.length, 1, 'The edit made mid-flight is still queued');
  assert.equal(survivors[0].field, 'startTime');
  assert.equal(result.data.outbox.length, 0, 'while the sent ops were cleared');
}

console.log('--- 7. A CRASH BETWEEN PULL AND SAVE COSTS NOTHING ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a', startTime: '09:00' } });
  let d = emptyClientData(PH);

  // Pull, then "crash" — throw the result away without persisting it.
  await syncOnce(d, server, 10_000);
  // d is still the pre-sync value, exactly as a crashed app would reload it.
  assert.equal(d.cursor, 0, 'The cursor was never advanced');

  const again = await syncOnce(d, server, 11_000);
  assert.equal(again.pulled, 2, 'The same ops arrive again after the crash');
  assert.equal(readClientStore(again.data, 'events').ev1.title, 'a', 'and nothing was skipped');
}

console.log('--- 8. FULL RESYNC KEEPS THE OUTBOX ---');
{
  // The single most dangerous path: the server no longer has log entries this
  // device needs. If a resync wiped the outbox, every offline edit would vanish.
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' }, ev2: { title: 'b' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  // Offline edits pile up.
  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { title: 'phone edit' } });
  d = applyLocalChange(d, { store: 'events', entityId: 'ev3', at: 11_100, changes: { title: 'new on phone' } });
  assert.equal(d.outbox.length, 2);

  // The PC moves on and the log is trimmed past us.
  server.pcEdit('ev2', { title: 'pc moved on' }, 12_000);
  server.logFloor = 999;
  server.forceFullResync = true;

  const r = await syncOnce(d, server, 13_000);
  d = r.data;
  assert.equal(r.didFullResync, true);
  assert.equal(server.snapshotCalls, 1);

  assert.equal(readClientStore(d, 'events').ev1.title, 'phone edit',
    'The offline edit is STILL VISIBLE after a full resync');
  assert.equal(readClientStore(d, 'events').ev3.title, 'new on phone',
    'and so is the item created offline');
  assert.equal(readClientStore(d, 'events').ev2.title, 'pc moved on',
    "while the PC's newer state was adopted");

  // Those ops were pushed before the resync, so the server already has them.
  server.forceFullResync = false;
  server.logFloor = 0;
  const after = await syncOnce(d, server, 14_000);
  assert.equal(after.data.outbox.length, 0);
  assert.equal(readStore(server.state, 'events').ev3.title, 'new on phone',
    'and they reached the server');
}

console.log('--- 9. FULL RESYNC WHEN THE PUSH NEVER GOT THROUGH ---');
{
  // Harsher: offline edits that were NEVER pushed, followed by a forced resync.
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  server.failPush = true;
  d = applyLocalChange(d, { store: 'events', entityId: 'ev9', at: 11_000, changes: { title: 'unsent' } });
  await syncOnce(d, server, 11_500).then(r => { d = r.data; });
  assert.equal(d.outbox.length, 1, 'It could not be sent');

  server.forceFullResync = true;
  const resynced = await fullResync(d, server);
  assert.equal(resynced.outbox.length, 1, 'The unsent op survived the resync');
  assert.equal(readClientStore(resynced, 'events').ev9.title, 'unsent',
    'and is still visible in the UI');

  server.failPush = false;
  server.forceFullResync = false;
  const final = await syncOnce(resynced, server, 12_000);
  assert.equal(readStore(server.state, 'events').ev9.title, 'unsent',
    'and finally reached the server');
  assert.equal(final.data.outbox.length, 0);
}

console.log('--- 10. A FAILED ACK IS HARMLESS ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' } });
  server.failAck = true;

  const r = await syncOnce(emptyClientData(PH), server, 10_000);
  assert.equal(r.phase, 'idle', 'A failed acknowledgement does not fail the sync');
  assert.equal(readClientStore(r.data, 'events').ev1.title, 'a', 'The data still arrived');

  server.failAck = false;
  const again = await syncOnce(r.data, server, 11_000);
  assert.equal(again.pulled, 0, 'and the phone is not stuck re-pulling forever');
}

console.log('--- 11. A FAILED SNAPSHOT LEAVES EVERYTHING INTACT ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  // Queue an edit that could not be sent, so there is something to lose.
  server.failPush = true;
  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { title: 'b' } });
  await syncOnce(d, server, 11_500).then(r => { d = r.data; });
  assert.equal(d.outbox.length, 1, 'The edit is queued and unsent');
  const before = JSON.stringify(d);

  // A resync that fails must reject WITHOUT touching anything. This is the
  // dangerous path: a half-applied resync could drop the only copy of that edit.
  server.failSnapshot = true;
  await assert.rejects(() => fullResync(d, server), 'A failed snapshot rejects');
  assert.equal(JSON.stringify(d), before, 'and leaves the client data byte-identical');
  assert.equal(d.outbox.length, 1, 'so the unsent edit is still queued');
  assert.equal(readClientStore(d, 'events').ev1.title, 'b', 'and still visible');

  // Through a full cycle, the failure is reported rather than swallowed.
  server.failPush = false;
  server.forceFullResync = true;
  const r = await syncOnce(d, server, 12_000);
  assert.equal(r.phase, 'error', 'The cycle reports an error');
  assert.ok(r.error, 'with a message');
  assert.equal(readClientStore(r.data, 'events').ev1.title, 'b', 'and the local data survived');

  // Once the server recovers, everything settles.
  server.failSnapshot = false;
  server.forceFullResync = false;
  const ok = await syncOnce(r.data, server, 13_000);
  assert.equal(ok.phase, 'idle');
  assert.equal(readStore(server.state, 'events').ev1.title, 'b', 'and the edit finally landed');
}

console.log('--- 12. STATE SURVIVES AN APP RESTART ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a', startTime: '09:00' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  server.failPush = true;
  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { title: 'edited offline' } });
  d = applyLocalDelete(d, { store: 'events', entityId: 'gone', at: 11_100 });
  await syncOnce(d, server, 11_500).then(r => { d = r.data; });

  // Force-close the app and reopen it.
  const reopened = restart(d);
  assert.equal(reopened.outbox.length, d.outbox.length, 'The outbox survived the restart');
  assert.equal(readClientStore(reopened, 'events').ev1.title, 'edited offline',
    'and so did the local data');
  assert.equal(reopened.cursor, d.cursor, 'and the cursor');

  server.failPush = false;
  const r = await syncOnce(reopened, server, 12_000);
  assert.equal(r.data.outbox.length, 0, 'and it all sent after reopening');
  assert.equal(readStore(server.state, 'events').ev1.title, 'edited offline');
}

console.log('--- 13. CONFLICTS ARRIVE, DEDUPE AND CLEAR ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { startTime: '18:00' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  // Both sides edit the same field while apart.
  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { startTime: '20:00' } });
  server.pcEdit('ev1', { startTime: '18:30' }, 11_001);

  const r = await syncOnce(d, server, 12_000);
  d = r.data;
  assert.equal(d.conflicts.length, 1, 'The card reaches the phone');
  assert.equal(d.conflicts[0].field, 'startTime');

  // Re-syncing must not stack a second copy of the same card.
  const again = await syncOnce(d, server, 13_000);
  assert.equal(again.data.conflicts.length, 1, 'Polling does not duplicate the card');

  // Answering it locally removes it and queues the choice.
  const card = again.data.conflicts[0];
  const answered = applyLocalResolution(again.data, card, 'loser', 14_000);
  assert.equal(answered.conflicts.length, 0, 'The card is gone from the sidebar');
  assert.ok(answered.outbox.length > 0, 'and the choice is queued to sync');
  assert.equal(readClientStore(answered, 'events').ev1.startTime, card.loser.value,
    'and the chosen value is live immediately');
}

console.log('--- 14. A CARD ANSWERED ON THE PC DISAPPEARS FROM THE PHONE ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { startTime: '18:00' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;
  d = applyLocalChange(d, { store: 'events', entityId: 'ev1', at: 11_000, changes: { startTime: '20:00' } });
  server.pcEdit('ev1', { startTime: '18:30' }, 11_001);
  d = (await syncOnce(d, server, 12_000)).data;
  assert.equal(d.conflicts.length, 1);

  // The PC answers it; the server stops listing the card.
  server.conflicts = [];
  const r = await syncOnce(d, server, 13_000);
  assert.equal(r.data.conflicts.length, 0,
    'The phone stops showing a card that was answered elsewhere');
}

console.log('--- 15. CONFLICT LIST HELPERS ---');
{
  const card = (field: string, id: string, at: number): SyncConflict => ({
    id, kind: 'field', store: 'events', entityId: 'ev1', field,
    winner: { value: 'w', device: 'a', at, lamport: at },
    loser: { value: 'l', device: 'b', at, lamport: at },
    detectedAt: at,
  });

  assert.equal(mergeConflicts([], []).length, 0);
  assert.equal(mergeConflicts([], [card('title', 'c1', 1)]).length, 1);

  const dup = mergeConflicts([card('title', 'c1', 1)], [card('title', 'c2', 2)]);
  assert.equal(dup.length, 1, 'The same field never stacks two cards');
  assert.equal(dup[0].id, 'c2', 'and the newer one wins');

  const older = mergeConflicts([card('title', 'c2', 2)], [card('title', 'c0', 0)]);
  assert.equal(older[0].id, 'c2', 'A late-arriving older card does not regress');

  const two = mergeConflicts([card('title', 'c1', 1)], [card('startTime', 'c3', 3)]);
  assert.equal(two.length, 2, 'Different fields are separate cards');

  // Reconcile keeps what the server still lists, plus anything it has not seen.
  const local = [card('title', 'c1', 1), card('startTime', 'c2', 2)];
  assert.deepEqual(reconcileConflicts(local, [card('title', 'c1', 1)]).map(c => c.id), ['c1'],
    'A card the server dropped disappears');
  assert.equal(reconcileConflicts([], [card('title', 'c9', 9)]).length, 1,
    'and a card only the server knows about appears');
  assert.equal(reconcileConflicts(local, []).length, 0, 'An empty server list clears everything');
}

console.log('--- 16. THE STATUS LINE NEVER LEAVES YOU GUESSING ---');
{
  let d = emptyClientData(PH);
  assert.equal(describeStatus(d, 'idle', 0).label, 'Not synced yet');

  d = { ...d, lastSyncedAt: 1_000 };
  assert.equal(describeStatus(d, 'idle', 2_000).label, 'In sync with PC');
  assert.equal(describeStatus(d, 'syncing', 2_000).label, 'Syncing…');

  d = applyLocalChange(d, { store: 'events', entityId: 'e', at: 1, changes: { title: 'x' } });
  assert.equal(describeStatus(d, 'idle', 2_000).label, '1 change to send');

  // ONE FAILED ATTEMPT IS NOT A PC BEING OFF, and saying so was the loudest
  // thing on the screen while sync was in fact working perfectly. A phone drops
  // its connection walking between rooms, and a request cut short while the app
  // is frozen on screen-off fails with nothing wrong at either end. Having
  // reached the PC a second ago, the honest label is that there is something to
  // send — not that the PC is unreachable.
  assert.equal(describeStatus(d, 'offline', 2_000).label, '1 change to send',
    'A moment after a successful sync, the PC is not "offline"');

  d = applyLocalChange(d, { store: 'events', entityId: 'e', at: 2, changes: { startTime: '1' } });
  assert.equal(describeStatus(d, 'offline', 2_000).label, '2 changes to send');

  // But once nothing has got through for a while, say so plainly.
  const stale = 1_000 + OFFLINE_AFTER_MS + 1;
  assert.equal(describeStatus(d, 'offline', stale).label, '2 changes waiting — PC offline',
    'and once it really is out of reach, it says so');
  assert.equal(describeStatus(d, 'idle', stale).label, '2 changes to send',
    'while a healthy phase never claims it, however long ago the last sync was');

  // A device that has never synced has nothing to be recently-fine about.
  const never = applyLocalChange(
    emptyClientData(PH), { store: 'events', entityId: 'e', at: 1, changes: { title: 'x' } },
  );
  assert.equal(describeStatus(never, 'offline', 2_000).label, '1 change waiting — PC offline',
    'A phone that has never reached the PC is offline from the start');

  const synced = { ...emptyClientData(PH), lastSyncedAt: 0 };
  assert.equal(describeStatus(synced, 'offline', 4 * 3_600_000).label, 'Last synced 4 hours ago');

  // Conflicts outrank everything: they are the only thing needing a decision.
  const conflicted = {
    ...d,
    conflicts: [{
      id: 'c1', kind: 'field' as const, store: 'events' as const, entityId: 'e', field: 'title',
      winner: { value: 1, device: 'a', at: 1, lamport: 1 },
      loser: { value: 2, device: 'b', at: 1, lamport: 1 },
      detectedAt: 1,
    }],
  };
  assert.equal(describeStatus(conflicted, 'offline', 2_000).label, '1 conflict to review');
}

console.log('--- 17. RELATIVE TIME WORDING ---');
{
  assert.equal(describeAgo(0), 'just now');
  assert.equal(describeAgo(-5_000), 'just now', 'A clock that jumped backwards still reads sensibly');
  assert.equal(describeAgo(59_000), 'just now');
  assert.equal(describeAgo(60_000), '1 minute ago');
  assert.equal(describeAgo(120_000), '2 minutes ago');
  assert.equal(describeAgo(3_600_000), '1 hour ago');
  assert.equal(describeAgo(7_200_000), '2 hours ago');
  assert.equal(describeAgo(86_400_000), '1 day ago');
  assert.equal(describeAgo(200_000_000), '2 days ago');
}

console.log('--- 18. BACKOFF IS BOUNDED AND JITTERED ---');
{
  assert.equal(backoffDelay(0), 0, 'No failures, no delay');
  assert.equal(backoffDelay(1), 2_000);
  assert.equal(backoffDelay(2), 4_000);
  assert.equal(backoffDelay(3), 8_000);
  // THE CAP IS SHORT ON PURPOSE. Nothing tells the app that Wi-Fi came back, so
  // the wait it is already sitting in IS the delay before reconnecting works.
  // Every edit made offline counts as a failure too, so a few changes made on a
  // plane used to buy a multi-minute wait after landing — during which the only
  // cure was closing and reopening the app.
  assert.equal(backoffDelay(20), MAX_RETRY_MS, 'Capped at half a minute');
  assert.equal(backoffDelay(50), MAX_RETRY_MS, 'however long it has been failing');
  assert.ok(MAX_RETRY_MS <= 30_000, 'and that cap stays short enough to feel automatic');
  assert.ok(backoffDelay(5) > backoffDelay(4), 'Monotonic below the cap');
  assert.ok(backoffDelay(4) < MAX_RETRY_MS, 'and it does still back off before reaching it');

  for (let seed = 0; seed < 50; seed++) {
    const j = withJitter(10_000, seed);
    assert.ok(j >= 8_500 && j <= 11_500, `Jitter stays within ±15% (seed ${seed}, got ${j})`);
  }
  assert.equal(withJitter(0, 7), 0, 'Zero stays zero');
  assert.notEqual(withJitter(10_000, 1), withJitter(10_000, 2), 'Different seeds differ');
}

console.log('--- 19. A LONG OFFLINE STRETCH, THEN EVERYTHING AT ONCE ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'base' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  server.failPush = true;
  server.failPull = true;

  // A week of use with no signal: 60 edits, some to the same fields.
  for (let i = 0; i < 60; i++) {
    d = applyLocalChange(d, {
      store: 'events', entityId: `off-${i % 12}`, at: 20_000 + i,
      changes: { title: `entry ${i}` },
    });
    if (i % 7 === 0) await syncOnce(d, server, 20_000 + i).then(r => { d = r.data; });
  }
  assert.ok(d.outbox.length >= 60, 'Every edit is still queued');

  // Meanwhile the PC was busy too.
  for (let i = 0; i < 20; i++) server.pcEdit(`pc-${i}`, { title: `pc ${i}` }, 30_000 + i);

  server.failPush = false;
  server.failPull = false;
  const r = await syncOnce(d, server, 40_000);
  d = r.data;

  assert.equal(d.outbox.length, 0, 'The whole backlog sent in one cycle');
  const local = readClientStore(d, 'events');
  for (let i = 0; i < 12; i++) assert.ok(local[`off-${i}`], `Offline item ${i} survived`);
  for (let i = 0; i < 20; i++) assert.ok(local[`pc-${i}`], `PC item ${i} arrived`);

  // And both sides now agree exactly.
  const settle = await syncOnce(d, server, 41_000);
  assert.deepEqual(readClientStore(settle.data, 'events'), readStore(server.state, 'events'),
    'Phone and server hold identical planners');
  assert.equal(settle.pulled, 0, 'with nothing left to exchange');
}

console.log('--- 20. REPEATED SYNCS NEVER OSCILLATE ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a', startTime: '09:00' }, ev2: { title: 'b' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  for (let i = 0; i < 30; i++) {
    const r = await syncOnce(d, server, 11_000 + i);
    assert.equal(r.pushed, 0, `Poll ${i} pushed nothing`);
    assert.equal(r.pulled, 0, `Poll ${i} pulled nothing`);
    d = r.data;
  }
  assert.equal(server.pushCalls, 0, 'An idle phone never calls push');
  assert.deepEqual(readClientStore(d, 'events'), readStore(server.state, 'events'));
}

console.log('--- 21. DELETES ROUND-TRIP ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' }, ev2: { title: 'b' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  d = applyLocalDelete(d, { store: 'events', entityId: 'ev2', at: 11_000 });
  assert.equal(readClientStore(d, 'events').ev2, undefined, 'It disappears from the phone at once');

  d = (await syncOnce(d, server, 12_000)).data;
  assert.equal(readStore(server.state, 'events').ev2, undefined, 'and from the server');

  // A delete arriving FROM the server removes it locally too.
  server.pcEdit('ev1', { __deleted: true }, 13_000);
  d = (await syncOnce(d, server, 14_000)).data;
  assert.equal(readClientStore(d, 'events').ev1, undefined, 'A PC delete reaches the phone');
}

console.log('--- 22. TASKS SYNC THROUGH THE SAME PATH ---');
{
  const server = new FakeServer();
  server.seed({ t1: { title: 'Read chapter 4', completedDates: [] } }, 'tasks');
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;
  assert.equal(readClientStore(d, 'tasks').t1.title, 'Read chapter 4');

  d = applyLocalRecord(d, {
    store: 'tasks', entityId: 't1', at: 11_000,
    record: { title: 'Read chapter 4', completedDates: ['2026-09-01'] },
  });
  d = (await syncOnce(d, server, 12_000)).data;
  assert.deepEqual(readStore(server.state, 'tasks').t1.completedDates, ['2026-09-01'],
    'Ticking a task on the phone reaches the server');

  // Both devices ticking the same day is not a conflict.
  server.pcEdit('t1', { completedDates: ['2026-09-01'] }, 13_000, 'tasks');
  const r = await syncOnce(d, server, 14_000);
  assert.equal(r.data.conflicts.length, 0, 'and ticking it twice raises nothing');
}

console.log('--- 23. DEGENERATE AND HOSTILE SERVER REPLIES ---');
{
  const server = new FakeServer();
  server.seed({ ev1: { title: 'a' } });
  let d = (await syncOnce(emptyClientData(PH), server, 10_000)).data;

  // A server that replies with a cursor BEHIND ours REWINDS us, deliberately.
  //
  // This assertion used to say the opposite, and that was the bug. The cursor is
  // a position in the SERVER's log, so only the server can know what it means;
  // keeping the higher of the two numbers meant a cursor once set too high could
  // never come back down. A real device ended up asking for everything after
  // position 2203 of a log whose head was 951 -- so it matched no operation,
  // received nothing ever again, and went on acknowledging as though all were
  // well. Changes made on the PC simply never arrived.
  //
  // Following the server is safe in the other direction: re-receiving operations
  // is idempotent and costs one larger response, while ignoring the server can
  // strand a device for good.
  const rewind: SyncTransport = {
    ...server,
    pull: async () => ({ ops: [], cursor: 0, conflicts: [], needsFullResync: false, serverTime: 1 }),
    push: server.push.bind(server),
    ack: server.ack.bind(server),
    snapshot: server.snapshot.bind(server),
    resolve: server.resolve.bind(server),
  };
  const r = await syncOnce(d, rewind, 11_000);
  assert.equal(r.data.cursor, 0, "The client follows the server's cursor, even backwards");

  // A server replying with the same ops twice must merge idempotently.
  const doubled: SyncTransport = {
    ...rewind,
    pull: async () => ({
      ops: [...server.log, ...server.log],
      cursor: server.state.lamport, conflicts: [], needsFullResync: false, serverTime: 1,
    }),
  };
  const dbl = await syncOnce(d, doubled, 12_000);
  assert.equal(readClientStore(dbl.data, 'events').ev1.title, 'a',
    'Duplicated ops in one reply change nothing');
  assert.equal(dbl.data.conflicts.length, 0, 'and raise no phantom conflict');

  // A reply with an empty ops array and no conflicts is a normal quiet sync.
  const quiet = await syncOnce(dbl.data, rewind, 13_000);
  assert.equal(quiet.phase, 'idle');
}

console.log('\nALL PASS (client sync engine: outbox, retries, resync, conflicts)');
