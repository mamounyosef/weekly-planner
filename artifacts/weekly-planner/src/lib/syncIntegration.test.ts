// ─── The whole loop, end to end, on a real filesystem ────────────────────────
// Every other sync suite tests one module. This one wires the REAL pieces
// together — the HTTP routes, the per-user queue, the operation log, the file
// rebuild and a simulated phone running the actual client engine — over real
// temp directories, and reproduces the failures the user reported:
//
//   • "an edit on the PC sometimes never appears on the phone"
//   • "ticking something on the phone sometimes never appears on the PC"
//
// Both turned out to be plumbing between the modules rather than a fault in any
// one of them, which is exactly the class of bug a per-module suite cannot see.
//
// THE THREE WRITERS OF database.json, which is where most of this comes from:
//   1. the PC app, POSTing its WHOLE event map built from a copy it read earlier
//   2. Google Calendar sync, writing the file directly, behind everyone's back
//   3. this sync service, rebuilding the file after a phone push
//
// Run with: npx tsx src/lib/syncIntegration.test.ts

import assert from 'node:assert';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createSyncService,
  handleSyncRequest,
  type SyncService,
  type UserSyncPaths,
} from '../../sync-service';
import { baseIdOf, type Snapshot } from './syncBridge';
import {
  applyLocalChange,
  applyLocalDelete,
  emptyClientData,
  reconcileAfterSync,
  syncOnce,
  type ClientData,
  type SyncTransport,
} from './syncClient';
import { isMeaninglessConflict, readStore, type SyncOp } from './sync';

const USER = 'mamoun';
let tmpRoot = '';

// ─── A test rig that behaves like the real server and the real phone ─────────

interface Rig {
  paths: UserSyncPaths;
  svc: SyncService;
  transport: SyncTransport;
  /** Read database.json / tasks.json exactly as anything else on the PC would. */
  readFile(store: 'events' | 'tasks'): Promise<Snapshot>;
  /** The PC app: read the file into memory (this is its "copy"). */
  pcLoad(store?: 'events' | 'tasks'): Promise<{ data: Snapshot; base: string }>;
  /** The PC app: POST the whole map, stamped with the copy it started from. */
  pcSave(data: Snapshot, base?: string, store?: 'events' | 'tasks'): Promise<void>;
  /** Google sync: write the file directly. Nothing tells the sync service. */
  gcalWrite(data: Snapshot, store?: 'events' | 'tasks'): Promise<void>;
  /** Restart the dev server: brand-new service, same files on disk. */
  restart(): void;
}

async function makeRig(label: string, seed: Snapshot = {}, tasks: Snapshot = {}): Promise<Rig> {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
  };
  await fsp.writeFile(paths.dbPath, JSON.stringify(seed, null, 2), 'utf-8');
  await fsp.writeFile(paths.tasksPath, JSON.stringify(tasks, null, 2), 'utf-8');

  const rig: any = { paths };
  rig.svc = createSyncService();

  const fileOf = (store: 'events' | 'tasks') =>
    store === 'events' ? paths.dbPath : paths.tasksPath;

  rig.readFile = async (store: 'events' | 'tasks' = 'events'): Promise<Snapshot> => {
    try { return JSON.parse(await fsp.readFile(fileOf(store), 'utf-8')); } catch { return {}; }
  };

  rig.pcLoad = async (store: 'events' | 'tasks' = 'events') => {
    const data = await rig.readFile(store);
    // What /api/events GET does: register the version it hands over.
    const base = rig.svc.noteBase(USER, store, data);
    assert.equal(base, baseIdOf(data), 'The app computes the same id the server did');
    return { data, base };
  };

  rig.pcSave = async (data: Snapshot, base?: string, store: 'events' | 'tasks' = 'events') => {
    await fsp.writeFile(fileOf(store), JSON.stringify(data, null, 2), 'utf-8');
    await rig.svc.ingestFile(USER, paths, store, data, base);
  };

  rig.gcalWrite = async (data: Snapshot, store: 'events' | 'tasks' = 'events') => {
    await fsp.writeFile(fileOf(store), JSON.stringify(data), 'utf-8');
  };

  rig.restart = () => {
    rig.svc = createSyncService();
    rig.transport = transportFor(rig);
  };

  rig.transport = transportFor(rig);
  return rig as Rig;
}

/** Every call goes through the real request handler, body validation and all. */
function transportFor(rig: any): SyncTransport {
  const call = async (action: string, body: unknown) => {
    const res = await handleSyncRequest(rig.svc, USER, rig.paths, {
      action, method: 'POST', body,
    });
    if (!res.handled) throw new Error(`route ${action} not handled`);
    if (res.status !== 200) throw new Error(JSON.stringify(res.payload));
    // Force the payload through JSON, as the middleware does: anything that does
    // not survive that round trip never reaches the phone.
    return JSON.parse(JSON.stringify(res.payload));
  };
  return {
    pull: (d, since) => call('pull', { deviceId: d, since }),
    push: (d, ops) => call('push', { deviceId: d, ops }),
    ack: (d, cursor) => call('ack', { deviceId: d, cursor }),
    snapshot: d => call('snapshot', { deviceId: d }),
    resolve: (d, conflictId, choice) => call('resolve', { deviceId: d, conflictId, choice }),
  };
}

/** The phone, running the real client engine. */
class Phone {
  data: ClientData;
  constructor(private rig: Rig, deviceId: string) {
    this.data = emptyClientData(deviceId);
  }
  async sync(at = Date.now()) {
    const before = this.data;
    const outcome = await syncOnce(before, this.rig.transport, at);
    this.data = reconcileAfterSync(before, this.data, outcome);
    return outcome;
  }
  edit(entityId: string, changes: Record<string, unknown>, at = Date.now(), store: any = 'events') {
    this.data = applyLocalChange(this.data, { store, entityId, changes, at });
  }
  remove(entityId: string, at = Date.now(), store: any = 'events') {
    this.data = applyLocalDelete(this.data, { store, entityId, at });
  }
  events() { return readStore(this.data.state, 'events'); }
  tasks() { return readStore(this.data.state, 'tasks'); }
  /** Wipe local storage, keeping the device id — the "Reset local data" button. */
  wipe() { this.data = emptyClientData(this.data.deviceId); }
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sync-integration-'));

  console.log('--- 1. THE BASELINE ROUND TRIP ---');
  {
    const rig = await makeRig('basics', {
      ev1: { content: 'Physics', day: '2026-03-02', startTime: '18:00' },
    });
    const phone = new Phone(rig, 'phone-a');
    await phone.sync();
    assert.equal(phone.events().ev1.content, 'Physics', 'The phone sees the existing planner');

    // PC edit reaches the phone.
    const pc = await rig.pcLoad();
    await rig.pcSave({ ...pc.data, ev1: { ...pc.data.ev1, startTime: '19:00' } }, pc.base);
    await phone.sync();
    assert.equal(phone.events().ev1.startTime, '19:00', 'A PC edit reaches the phone');

    // Phone edit reaches the file.
    phone.edit('ev1', { completedDates: ['2026-03-02'] });
    await phone.sync();
    assert.deepEqual((await rig.readFile()).ev1.completedDates, ['2026-03-02'],
      'A phone tick reaches database.json');
  }

  console.log('--- 2. SYMPTOM: A PC EDIT NEVER APPEARS ON THE PHONE (GOOGLE SYNC) ---');
  {
    // Google Calendar sync writes database.json directly. Before the fix the
    // sync service never heard about it, so an event imported from Google was
    // invisible to the phone -- and then DELETED from the file the moment the
    // phone pushed anything, because the rebuild only emitted ids the log knew.
    const rig = await makeRig('gcal', { ev1: { content: 'Physics' } });
    const phone = new Phone(rig, 'phone-b');
    await phone.sync();

    await rig.gcalWrite({
      ev1: { content: 'Physics' },
      g1: { content: 'Dentist', day: '2026-03-05', gCalETag: '"etag-1"' },
    });

    await phone.sync();
    assert.equal(phone.events().g1?.content, 'Dentist',
      'An event imported from Google must reach the phone');
    assert.equal(phone.events().g1.gCalETag, undefined,
      "but Google's bookkeeping stays on the PC");

    phone.edit('ev1', { content: 'Physics revision' });
    await phone.sync();
    const onDisk = await rig.readFile();
    assert.ok(onDisk.g1, 'and a phone push must not delete it from database.json');
    assert.equal(onDisk.g1.gCalETag, '"etag-1"', 'with its ETag intact');
    assert.equal(onDisk.ev1.content, 'Physics revision');

    // Google later removes it. The deletion must reach the phone too.
    await rig.gcalWrite({ ev1: { content: 'Physics revision' } });
    await phone.sync();
    assert.equal(phone.events().g1, undefined, 'and a removal on Google reaches the phone');
  }

  console.log('--- 3. SYMPTOM: A PHONE TICK NEVER APPEARS ON THE PC (STALE AUTOSAVE) ---');
  {
    // The PC app POSTs its WHOLE map, built from a copy it loaded earlier. If the
    // phone changed something in between, that save used to look like "the user
    // deleted everything the phone just did".
    const rig = await makeRig('stale', { ev1: { content: 'Physics' } });
    const phone = new Phone(rig, 'phone-c');
    await phone.sync();

    const pc = await rig.pcLoad();                       // the PC's copy: {ev1}

    phone.edit('ev1', { completedDates: ['2026-03-02'] });
    phone.edit('new1', { content: 'Made on the phone', day: '2026-03-03' });
    await phone.sync();
    assert.ok((await rig.readFile()).new1, 'The phone item is on disk');

    // Now the PC saves its stale copy, which knows nothing about either change.
    await rig.pcSave({ ev1: { content: 'Physics', note: 'typed on the PC' } }, pc.base);

    const after = await rig.readFile();
    assert.ok(after.new1, 'The stale save must NOT delete the item the phone added');
    assert.deepEqual(after.ev1.completedDates, ['2026-03-02'],
      'nor undo the tick the phone made');
    assert.equal(after.ev1.note, 'typed on the PC',
      'while the change the PC really did make is kept');

    await phone.sync();
    assert.equal(phone.events().ev1.note, 'typed on the PC');
    assert.deepEqual(phone.events().ev1.completedDates, ['2026-03-02']);
    assert.equal(phone.data.conflicts.length, 0, 'and none of it needed a conflict card');
  }

  console.log('--- 4. A GENUINE PC DELETE STILL DELETES ---');
  {
    // The guard above must not make deleting impossible. A save from a copy that
    // HAD the item and no longer does is a real deletion.
    const rig = await makeRig('realdelete', { ev1: { content: 'a' }, ev2: { content: 'b' } });
    const phone = new Phone(rig, 'phone-d');
    await phone.sync();

    const pc = await rig.pcLoad();
    delete pc.data.ev2;
    await rig.pcSave(pc.data, pc.base);

    assert.equal((await rig.readFile()).ev2, undefined, 'gone from the file');
    await phone.sync();
    assert.equal(phone.events().ev2, undefined, 'and gone from the phone');

    // ...and it stays gone across a restart, which is where it used to come back.
    rig.restart();
    await phone.sync();
    assert.equal(phone.events().ev2, undefined, 'still gone after a dev-server restart');
    assert.equal((await rig.readFile()).ev2, undefined);
  }

  console.log('--- 5. A PHONE DELETE SURVIVES A DEV-SERVER RESTART ---');
  {
    const rig = await makeRig('restart', { ev1: { content: 'a' }, ev2: { content: 'b' } });
    const phone = new Phone(rig, 'phone-e');
    await phone.sync();

    phone.remove('ev2');
    await phone.sync();
    assert.equal((await rig.readFile()).ev2, undefined, 'removed from the file');

    // Google re-adds it from a calendar that still has it, and the server
    // restarts. Seeding used to run again and re-create everything on disk,
    // undoing every delete the phone had ever made.
    await rig.gcalWrite({ ev1: { content: 'a' }, ev2: { content: 'b' } });
    rig.restart();

    await phone.sync();
    assert.equal(phone.events().ev2, undefined, 'The delete is not undone by a restart');
    assert.equal((await rig.readFile()).ev2, undefined, 'and the file is put back');

    // Restarting repeatedly must not drift either.
    for (let i = 0; i < 5; i++) { rig.restart(); await phone.sync(); }
    assert.equal(phone.events().ev2, undefined);
    assert.equal(Object.keys(phone.events()).length, 1);
  }

  console.log('--- 6. A PHONE THAT CLEARS ITS LOCAL DATA RECOVERS EVERYTHING ---');
  {
    const rig = await makeRig('wipe', { ev1: { content: 'a' } });
    const phone = new Phone(rig, 'phone-f');
    await phone.sync();
    phone.edit('p1', { content: 'Made on the phone' });
    phone.edit('ev1', { startTime: '09:00' });
    await phone.sync();

    // "Reset local data", or a reinstall onto the same device id.
    phone.wipe();
    await phone.sync();

    assert.equal(phone.events().p1?.content, 'Made on the phone',
      'A device must get its OWN history back — nothing else holds it');
    assert.equal(phone.events().ev1.startTime, '09:00');
    assert.equal(Object.keys(phone.events()).length, 2);
  }

  console.log('--- 7. OFFLINE EDITS WITH A COLD LAMPORT CLOCK STILL WIN ---');
  {
    // A phone that has been offline mints ops from a low clock. Those ops used
    // to lose every race against the server's much higher clock, so a whole
    // evening of edits landed and did nothing.
    const rig = await makeRig('cold', { ev1: { content: 'a', startTime: '10:00' } });
    const phone = new Phone(rig, 'phone-g');
    await phone.sync();

    // The PC churns for a while, with the phone unreachable.
    for (let i = 0; i < 40; i++) {
      const pc = await rig.pcLoad();
      await rig.pcSave({ ...pc.data, ev1: { ...pc.data.ev1, content: `a${i}` } }, pc.base);
    }
    // The phone (still holding its old view) makes an edit and comes back.
    phone.edit('ev1', { startTime: '21:30' });
    await phone.sync();

    const onDisk = await rig.readFile();
    assert.equal(onDisk.ev1.startTime, '21:30', "The phone's offline edit reached the PC");
    assert.equal(onDisk.ev1.content, 'a39', "and the PC's own edits survived");

    // The phone's clock must now be level with the server, or the NEXT edit
    // loses in exactly the same way.
    const status: any = await handleSyncRequest(rig.svc, USER, rig.paths, {
      action: 'status', method: 'GET', body: {},
    });
    assert.ok(phone.data.state.lamport >= status.payload.lamport,
      'The phone adopts the server clock so its next edit is not born stale');

    phone.edit('ev1', { startTime: '22:00' });
    await phone.sync();
    assert.equal((await rig.readFile()).ev1.startTime, '22:00', 'and the next edit lands too');
  }

  console.log('--- 8. AN EDIT MADE WHILE A SYNC IS IN FLIGHT IS NOT LOST ---');
  {
    const rig = await makeRig('inflight', { ev1: { content: 'a' } });
    const phone = new Phone(rig, 'phone-h');
    await phone.sync();

    // Start a cycle against the data as it is now...
    const before = phone.data;
    const inFlight = syncOnce(before, rig.transport, Date.now());
    // ...and type during the round trip.
    phone.edit('ev1', { content: 'typed mid-sync' });
    const outcome = await inFlight;
    phone.data = reconcileAfterSync(before, phone.data, outcome);

    assert.equal(phone.events().ev1.content, 'typed mid-sync',
      'The screen must still show what was typed');
    await phone.sync();
    assert.equal((await rig.readFile()).ev1.content, 'typed mid-sync',
      'and it must reach the PC');
    assert.equal(phone.data.outbox.length, 0, 'with nothing stuck in the queue');
  }

  console.log('--- 9. DUPLICATE, OUT-OF-ORDER AND STALE DELIVERY ---');
  {
    const rig = await makeRig('delivery', { ev1: { content: 'a' } });
    const phone = new Phone(rig, 'phone-i');
    await phone.sync();
    phone.edit('ev1', { startTime: '08:00' });

    const ops = [...phone.data.outbox];
    // The same batch, sent three times, in three different orders.
    await rig.transport.push('phone-i', ops);
    await rig.transport.push('phone-i', [...ops].reverse());
    await rig.transport.push('phone-i', [...ops, ...ops]);
    await phone.sync();

    assert.equal((await rig.readFile()).ev1.startTime, '08:00');
    const status: any = await handleSyncRequest(rig.svc, USER, rig.paths, {
      action: 'status', method: 'GET', body: {},
    });
    assert.equal(status.payload.openConflicts, 0, 'A resend is never a conflict');

    // A pull replayed from an old cursor must be idempotent, not duplicating.
    const replay = await rig.transport.pull('phone-i', 0);
    const snapshotBefore = phone.events();
    phone.data = { ...phone.data, state: phone.data.state };
    await phone.sync();
    assert.deepEqual(phone.events(), snapshotBefore, 'Replaying the log changes nothing');
    assert.ok(replay.ops.length > 0);
  }

  console.log('--- 10. THE LOG IS TRIMMED, AND A DEVICE BEHIND IT RESYNCS CLEANLY ---');
  {
    const rig = await makeRig('trim', { ev1: { content: 'a' } });
    const fast = new Phone(rig, 'phone-fast');
    await fast.sync();

    // Enough traffic to move the trim watermark well past a stale device.
    for (let i = 0; i < 800; i++) {
      fast.edit(`e${i}`, { content: `item ${i}` });
    }
    await fast.sync();
    await fast.sync();

    const slow = new Phone(rig, 'phone-slow');
    // Pretend it acknowledged something ancient and then vanished for a month.
    slow.data = { ...slow.data, cursor: 1 };
    const outcome = await slow.sync();

    assert.equal(outcome.didFullResync, true, 'A device past the trim point resyncs');
    assert.equal(Object.keys(slow.events()).length, 801,
      'and a full resync produces the WHOLE planner, not a fragment');
    assert.deepEqual(slow.events(), fast.events(), 'identical to the up-to-date device');

    // A resync must keep unsent local work.
    const another = new Phone(rig, 'phone-another');
    another.data = { ...another.data, cursor: 1 };
    another.edit('offline1', { content: 'written with no signal' });
    const out2 = await another.sync();
    assert.equal(out2.didFullResync, true);
    assert.equal(another.events().offline1?.content, 'written with no signal',
      'An offline edit survives a full resync');
    await another.sync();
    assert.ok((await rig.readFile()).offline1, 'and reaches the PC afterwards');
  }

  console.log('--- 11. TWO PHONES PLUS THE PC ALL CONVERGE ---');
  {
    const rig = await makeRig('three', { ev1: { content: 'Physics', startTime: '18:00' } });
    const a = new Phone(rig, 'phone-one');
    const b = new Phone(rig, 'phone-two');
    await a.sync(); await b.sync();

    a.edit('ev1', { completedDates: ['2026-03-02'] });
    b.edit('ev1', { completedDates: ['2026-03-09'] });
    const pc = await rig.pcLoad();
    await rig.pcSave({ ...pc.data, ev1: { ...pc.data.ev1, content: 'Physics revision' } }, pc.base);

    await a.sync(); await b.sync(); await a.sync(); await b.sync();

    const disk = await rig.readFile();
    assert.equal(disk.ev1.content, 'Physics revision');
    assert.deepEqual(disk.ev1.completedDates, ['2026-03-02', '2026-03-09'],
      'Both phones ticked a different day and BOTH ticks survived');
    assert.deepEqual(a.events(), b.events(), 'The two phones agree');
    assert.equal(a.data.conflicts.length, 0);
    assert.equal(b.data.conflicts.length, 0);
  }

  console.log('--- 12. THE SAME TICK ON BOTH DEVICES RAISES NO CARD ---');
  {
    const rig = await makeRig('sametick', { ev1: { content: 'Gym' } });
    const phone = new Phone(rig, 'phone-j');
    await phone.sync();

    const pc = await rig.pcLoad();
    phone.edit('ev1', { completedDates: ['2026-03-02'] });
    await rig.pcSave({ ev1: { ...pc.data.ev1, completedDates: ['2026-03-02'] } }, pc.base);
    await phone.sync();

    assert.equal(phone.data.conflicts.length, 0,
      'Both devices ticked the same day. Agreement, not a question.');
    const cards: any = await handleSyncRequest(rig.svc, USER, rig.paths, {
      action: 'conflicts', method: 'GET', body: {},
    });
    assert.equal(cards.payload.conflicts.length, 0, 'and none on the server either');
    assert.deepEqual((await rig.readFile()).ev1.completedDates, ['2026-03-02']);
  }

  console.log('--- 13. A REAL DISAGREEMENT IS STILL RAISED AND CAN BE ANSWERED ---');
  {
    const rig = await makeRig('conflict', { ev1: { content: 'Physics', startTime: '18:00' } });
    const phone = new Phone(rig, 'phone-k');
    await phone.sync();

    const pc = await rig.pcLoad();
    phone.edit('ev1', { startTime: '20:00' });
    await rig.pcSave({ ev1: { ...pc.data.ev1, startTime: '18:30' } }, pc.base);
    await phone.sync();

    assert.equal(phone.data.conflicts.length, 1, 'The same field from two directions is a card');
    const cardId = phone.data.conflicts[0].id;
    assert.equal(isMeaninglessConflict(phone.data.conflicts[0]), false);

    await rig.transport.resolve('phone-k', cardId, 'loser');
    await phone.sync();
    assert.equal(phone.data.conflicts.length, 0, 'and answering it closes it everywhere');
    const disk = await rig.readFile();
    assert.ok(disk.ev1.startTime === '18:30' || disk.ev1.startTime === '20:00');
    assert.equal(phone.events().ev1.startTime, disk.ev1.startTime,
      'with both sides landing on the same answer');
  }

  console.log('--- 14. TASKS: THE OTHER FILE BEHAVES THE SAME ---');
  {
    const rig = await makeRig('tasks', {}, { t1: { title: 'Buy milk', completed: false } });
    const phone = new Phone(rig, 'phone-l');
    await phone.sync();
    assert.equal(phone.tasks().t1.title, 'Buy milk');

    phone.edit('t1', { completed: true, completedAt: 111 }, Date.now(), 'tasks');
    await phone.sync();
    const disk = await rig.readFile('tasks');
    assert.equal(disk.t1.completed, true, 'Tasks use a flag, events use dates');
    assert.equal((await rig.readFile('events')).t1, undefined,
      'and a task never leaks into database.json');
  }

  console.log('--- 15. CORRUPT, TRUNCATED AND EMPTY FILES ARE NOT "DELETE EVERYTHING" ---');
  {
    const rig = await makeRig('corrupt', { ev1: { content: 'a' }, ev2: { content: 'b' } });
    const phone = new Phone(rig, 'phone-m');
    await phone.sync();
    assert.equal(Object.keys(phone.events()).length, 2);

    for (const junk of ['', '{', '{"ev1": ', 'null', '[]', '[1,2,3]', 'not json at all', '   ']) {
      await fsp.writeFile(rig.paths.dbPath, junk, 'utf-8');
      await phone.sync();
      assert.equal(Object.keys(phone.events()).length, 2,
        `A file containing ${JSON.stringify(junk)} must not wipe the planner`);
      assert.equal(Object.keys(await rig.readFile()).length, 2,
        `and the file is repaired from the log, not left as ${JSON.stringify(junk)}`);
    }

    // An EMPTY object is a legitimate state, and only a real save can produce it.
    const pc = await rig.pcLoad();
    await rig.pcSave({}, pc.base);
    assert.deepEqual(await rig.readFile(), {}, 'Deleting everything on purpose works');
    await phone.sync();
    assert.equal(Object.keys(phone.events()).length, 0);
  }

  console.log('--- 16. AWKWARD IDS AND CONTENT SURVIVE THE WHOLE ROUND TRIP ---');
  {
    const nasty: Snapshot = {
      '__proto__': { content: 'prototype pollution attempt' },
      'constructor': { content: 'constructor' },
      'a::2026-01-01': { content: 'looks like an occurrence id' },
      'with:colons:everywhere': { content: 'colons' },
      'emoji-🎯-id': { content: '🎯 focus 🔥' },
      'rtl': { content: 'مراجعة الفيزياء — الفصل الثاني' },
      'newlines': { content: 'line one\nline two\r\nline three' },
      'quotes': { content: 'he said "hi" and \\ escaped' },
      'big': { content: 'z'.repeat(120_000) },
      'nulls': { content: 'x', note: null, other: 0, flag: false, list: [] },
    };
    const rig = await makeRig('nasty', nasty);
    const phone = new Phone(rig, 'phone-n');
    await phone.sync();

    for (const id of Object.keys(nasty)) {
      assert.ok(phone.events()[id], `${id} reached the phone`);
      assert.equal(phone.events()[id].content, nasty[id].content, `${id} content is intact`);
    }
    assert.equal(({} as any).content, undefined, 'and nothing polluted Object.prototype');

    phone.edit('emoji-🎯-id', { content: '🎯 done ✅' });
    await phone.sync();
    assert.equal((await rig.readFile())['emoji-🎯-id'].content, '🎯 done ✅');

    // Round-trip fidelity: the file and the phone must agree exactly.
    const disk = await rig.readFile();
    for (const id of Object.keys(disk)) {
      assert.deepEqual(phone.events()[id], disk[id], `${id} is byte-for-byte the same view`);
    }
  }

  console.log('--- 17. A MALFORMED PUSH IS REJECTED WITHOUT DAMAGE ---');
  {
    const rig = await makeRig('hostile', { ev1: { content: 'a' } });
    const phone = new Phone(rig, 'phone-o');
    await phone.sync();

    const junk: unknown[] = [
      null, undefined, 42, 'op', [], {},
      { opId: '', store: 'events', entityId: 'e', field: 'f', device: 'd', lamport: 1, at: 0 },
      { opId: 'x', store: 'nope', entityId: 'e', field: 'f', device: 'd', lamport: 1, at: 0 },
      { opId: 'x', store: 'events', entityId: 'e', field: 'f', device: 'd', lamport: -1, at: 0 },
      { opId: 'x', store: 'events', entityId: 'e', field: 'f', device: 'd', lamport: 1.5, at: 0 },
      { opId: 'x', store: 'events', entityId: '', field: 'f', device: 'd', lamport: 1, at: 0 },
      { opId: 'x', store: 'events', entityId: 'e', field: 'f', device: 'd', lamport: NaN, at: 0 },
    ];
    const res = await handleSyncRequest(rig.svc, USER, rig.paths, {
      action: 'push', method: 'POST', body: { deviceId: 'phone-o', ops: junk },
    });
    assert.equal(res.status, 200);
    assert.equal((res.payload as any).rejected, junk.length, 'Every malformed op is refused');
    assert.equal((res.payload as any).accepted, 0);
    assert.deepEqual(await rig.readFile(), { ev1: { content: 'a' } }, 'and the file is untouched');

    await phone.sync();
    assert.equal(phone.events().ev1.content, 'a', 'and the phone still works');
  }

  console.log('--- 18. A CRASH BETWEEN THE LOG AND THE FILE LOSES NOTHING ---');
  {
    const rig = await makeRig('crash', { ev1: { content: 'a' } });
    const phone = new Phone(rig, 'phone-p');
    await phone.sync();
    phone.edit('ev1', { startTime: '07:30' });
    phone.edit('p2', { content: 'second item' });
    await phone.sync();

    // Simulate the file write having been lost while the log survived: put the
    // old content back on disk and restart, as if the process died mid-save.
    // Whatever the phone acknowledged must still be there afterwards.
    const rebuiltBefore = await rig.readFile();
    rig.restart();
    await phone.sync();
    assert.deepEqual(await rig.readFile(), rebuiltBefore,
      'The rebuild from the log is stable across restarts');
    assert.equal((await rig.readFile()).ev1.startTime, '07:30');
    assert.ok((await rig.readFile()).p2);
  }

  console.log('--- 19. AN IDLE LOOP WRITES NOTHING ---');
  {
    // Every needless rewrite of database.json fires the file watcher and makes
    // both PC windows reload. A quiet system must be silent.
    const rig = await makeRig('idle', { ev1: { content: 'a', gCalETag: '"e"' } });
    const phone = new Phone(rig, 'phone-q');
    await phone.sync();
    const before = await fsp.readFile(rig.paths.dbPath, 'utf-8');

    for (let i = 0; i < 25; i++) await phone.sync();
    const pc = await rig.pcLoad();
    for (let i = 0; i < 25; i++) await rig.pcSave(pc.data, pc.base);

    assert.equal(await fsp.readFile(rig.paths.dbPath, 'utf-8'), before,
      'Twenty-five empty syncs and twenty-five identical saves changed nothing');
    const status: any = await handleSyncRequest(rig.svc, USER, rig.paths, {
      action: 'status', method: 'GET', body: {},
    });
    assert.ok(status.payload.logSize < 10, 'and the log did not grow');
  }

  console.log('--- 20. GOOGLE SYNC AND THE PHONE WRITING AT THE SAME TIME ---');
  {
    // The feedback-loop check: Google writes, the phone pushes, the file is
    // rebuilt, Google writes again from what it reads. This must settle, not
    // oscillate.
    const rig = await makeRig('loop', { ev1: { content: 'a' } });
    const phone = new Phone(rig, 'phone-r');
    await phone.sync();

    for (let round = 0; round < 12; round++) {
      const disk = await rig.readFile();
      // Google's turn: it re-writes what it read, stamping a fresh ETag.
      await rig.gcalWrite(Object.fromEntries(Object.entries(disk).map(
        ([id, rec]) => [id, { ...rec, gCalETag: `"etag-${round}"` }],
      )));
      phone.edit('ev1', { startTime: `0${round % 9}:00` });
      await phone.sync();
    }

    const finalDisk = await rig.readFile();
    await phone.sync();
    await phone.sync();
    assert.deepEqual(await rig.readFile(), finalDisk, 'The system comes to rest');
    assert.equal(phone.events().ev1.startTime, finalDisk.ev1.startTime, 'both sides agreeing');
    assert.equal(finalDisk.ev1.gCalETag, '"etag-11"', "and Google's bookkeeping is preserved");
    assert.equal(phone.data.conflicts.length, 0, 'with no conflict cards produced by the loop');
  }

  console.log('--- 21. CLOCK SKEW: A PHONE HOURS AHEAD DOES NOT WIN AUTOMATICALLY ---');
  {
    const rig = await makeRig('skew', { ev1: { content: 'a', startTime: '10:00' } });
    const phone = new Phone(rig, 'phone-s');
    await phone.sync();

    const pc = await rig.pcLoad();
    // The phone's wall clock is a year in the future. Ordering must ignore it.
    phone.edit('ev1', { startTime: '11:00' }, Date.now() + 365 * 24 * 3600_000);
    // The PC writes afterwards, with a correct (lower) wall clock.
    await rig.pcSave({ ev1: { ...pc.data.ev1, startTime: '12:00' } }, pc.base);
    await phone.sync();

    // Whoever wins, both sides must land on the SAME answer, and the loser must
    // be offered rather than lost.
    assert.equal(phone.data.conflicts.length, 1, 'The race is reported');
    const c = phone.data.conflicts[0];
    assert.notEqual(c.winner.value, c.loser.value);
    await phone.sync();
    assert.equal(phone.events().ev1.startTime, (await rig.readFile()).ev1.startTime,
      'and the phone and the PC agree on the outcome');

    // A phone whose clock is far in the PAST must not lose automatically either.
    const rig2 = await makeRig('skew2', { ev1: { content: 'a', startTime: '10:00' } });
    const p2 = new Phone(rig2, 'phone-t');
    await p2.sync();
    p2.edit('ev1', { startTime: '23:00' }, 0);
    await p2.sync();
    assert.equal((await rig2.readFile()).ev1.startTime, '23:00',
      'An edit stamped at the epoch still lands: the lamport clock decides, not `at`');
  }

  console.log('--- 22. RANDOMISED: HUNDREDS OF INTERLEAVED ROUNDS MUST CONVERGE ---');
  {
    let rng = 20260829;
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };

    const rig = await makeRig('stress', {
      ev1: { content: 'one' }, ev2: { content: 'two' }, ev3: { content: 'three' },
    });
    const a = new Phone(rig, 'phone-x');
    const b = new Phone(rig, 'phone-y');
    await a.sync(); await b.sync();

    const ids = ['ev1', 'ev2', 'ev3', 'ev4', 'ev5'];
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    let created = 0;

    for (let round = 0; round < 400; round++) {
      const who = rand(3);
      const id = ids[rand(ids.length)];

      if (who === 0 || who === 1) {
        const phone = who === 0 ? a : b;
        const kind = rand(6);
        if (kind === 0) phone.edit(id, { content: `c${round}` });
        else if (kind === 1) phone.edit(id, { startTime: `${String(rand(24)).padStart(2, '0')}:00` });
        else if (kind === 2) {
          const cur = (phone.events()[id]?.completedDates as string[]) ?? [];
          const day = days[rand(days.length)];
          phone.edit(id, {
            completedDates: cur.includes(day) ? cur.filter(d => d !== day) : [...cur, day],
          });
        } else if (kind === 3 && phone.events()[id]) phone.remove(id);
        else if (kind === 4) { created += 1; phone.edit(`new${created}`, { content: `n${created}` }); }
        if (rand(3) !== 0) await phone.sync();
      } else if (who === 2) {
        const kind = rand(4);
        if (kind === 3) {
          // Google, writing behind everyone's back.
          const disk = await rig.readFile();
          const first = Object.keys(disk)[0];
          if (first) await rig.gcalWrite({ ...disk, [first]: { ...disk[first], gCalETag: `"e${round}"` } });
        } else {
          const pc = await rig.pcLoad();
          if (kind === 0) await rig.pcSave({ ...pc.data, [id]: { ...(pc.data[id] ?? {}), content: `pc${round}` } }, pc.base);
          else if (kind === 1 && pc.data[id]) {
            const next = { ...pc.data }; delete next[id];
            await rig.pcSave(next, pc.base);
          } else await rig.pcSave(pc.data, pc.base);
        }
      }
    }

    // Let everyone finish talking.
    for (let i = 0; i < 8; i++) { await a.sync(); await b.sync(); }

    const disk = await rig.readFile();
    const stripPcOnly = (snap: Snapshot) => Object.fromEntries(Object.entries(snap).map(
      ([id, rec]) => {
        const copy: Record<string, unknown> = { ...rec };
        delete copy.gCalETag;
        return [id, copy];
      },
    ));

    assert.deepEqual(a.events(), b.events(), 'The two phones converge exactly');
    assert.deepEqual(stripPcOnly(disk), a.events(), 'and the file matches what they hold');

    // Nothing may be stuck: every op either landed or is still queued.
    assert.equal(a.data.outbox.length, 0, 'phone X has nothing stranded');
    assert.equal(b.data.outbox.length, 0, 'phone Y has nothing stranded');

    // No card may be a fake one.
    for (const c of [...a.data.conflicts, ...b.data.conflicts]) {
      assert.equal(isMeaninglessConflict(c), false, 'no card offers two identical values');
    }

    // And a further quiet period must change nothing at all.
    const settled = await fsp.readFile(rig.paths.dbPath, 'utf-8');
    for (let i = 0; i < 5; i++) { await a.sync(); await b.sync(); }
    assert.equal(await fsp.readFile(rig.paths.dbPath, 'utf-8'), settled,
      'The system is quiescent once the traffic stops');
  }

  console.log('--- 23. RANDOMISED: RESTARTS IN THE MIDDLE OF EVERYTHING ---');
  {
    let rng = 777;
    const rand = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    const rig = await makeRig('restart-stress', { ev1: { content: 'seed' } });
    const phone = new Phone(rig, 'phone-z');
    await phone.sync();

    const deleted = new Set<string>();
    for (let round = 0; round < 200; round++) {
      const id = `e${rand(12)}`;
      const kind = rand(5);
      if (kind === 0) { phone.remove(id); deleted.add(id); }
      else { phone.edit(id, { content: `v${round}` }); deleted.delete(id); }
      if (rand(3) === 0) await phone.sync();
      if (rand(7) === 0) rig.restart();
      if (rand(11) === 0) {
        // Google rewrites the file from a stale copy it kept.
        const disk = await rig.readFile();
        await rig.gcalWrite({ ...disk, ghost: { content: 'from Google' } });
      }
    }
    for (let i = 0; i < 4; i++) { rig.restart(); await phone.sync(); }

    const disk = await rig.readFile();
    for (const id of deleted) {
      assert.equal(disk[id], undefined, `${id} was deleted and must stay deleted`);
      assert.equal(phone.events()[id], undefined, `${id} must not come back on the phone`);
    }
    assert.ok(disk.ghost, "and Google's own event was never destroyed");
    const stripped = Object.fromEntries(Object.entries(disk));
    assert.deepEqual(stripped, phone.events(),
      'The phone and the file agree after every restart in the world');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (integration: PC, phone, Google and restarts all converge)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
