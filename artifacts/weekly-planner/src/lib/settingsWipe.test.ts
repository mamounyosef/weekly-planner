// Tests the one rule that stands between the user and losing hand-built
// settings: A SETTING THAT IS SIMPLY ABSENT FROM A SAVE HAS NOT BEEN CLEARED.
//
// WHAT ACTUALLY HAPPENED, on 2026-08-30 at 22:13 local. The user had eleven
// item categories, built by hand over weeks and referenced by events all over
// the planner. A settings save reached the server without a `categories` key.
// The snapshot diff read that absence the way it correctly reads a missing
// field on an EVENT -- "the user cleared this" -- and emitted:
//
//     {"store":"settings","entityId":"app","field":"categories",
//      "device":"pc-desktop","lamport":5752}          <-- note: no "value"
//
// Every device merged it. The app, finding no categories, fell back to its two
// built-in ones and saved THOSE, so an hour later the erasure was the newest
// and most authoritative fact in the log. Nine categories were gone from every
// device, and every backup written from then on recorded the loss as the truth.
//
// WHY THE RULE IS SAFE. `settings.json` is not a map of records like the event
// store. Its snapshot is BUILT by picking the shared keys that happen to be
// present, so an absent key can only ever mean "this writer did not send it":
// a partial save, an older client, a file written before the field existed.
// A user who really empties a category list produces `[]`, which is a value and
// travels normally. Silence and emptiness are different things, and only one of
// them is an instruction.
//
// These tests cover the exact historical op, every other settings structure the
// same bug could reach, the door that stops such an op arriving from a peer, and
// -- just as important -- that ordinary clearing on ordinary stores still works,
// because a fix that made nothing ever clear anywhere would be its own data bug.
//
// Run with: npx tsx src/lib/settingsWipe.test.ts

import assert from 'node:assert/strict';
import {
  emptyState,
  mergeOps,
  readEntity,
  type SyncOp,
  type SyncState,
} from './sync';
import {
  OMISSION_NEVER_CLEARS,
  SETTINGS_ENTITY,
  SETTINGS_STRUCTURE_FIELDS,
  isSettingsWipeOp,
  opsToSnapshot,
  settingsAdapter,
  snapshotToOps,
  type Snapshot,
} from './syncBridge';
import { applySharedSettings, sharedSettingsOf } from './settingsScope';
import { validateOp, validatePush } from '../../sync-service';

const PC = 'pc-desktop';
const PH = 'phone-android';

/** The eleven categories that were lost, in the shape the app writes them. */
const CATEGORIES = [
  { id: 'personal', name: 'Personal', color: '#22c55e', defaultDurationMin: 30 },
  { id: 'cat-mt3fgzh0-0n0g', name: 'Important Events', color: '#ef4444', defaultDurationMin: 60 },
  { id: 'cat-mt3fia6p-d7lx', name: 'Important Timed Tasks', color: '#f97316', defaultDurationMin: 30 },
  { id: 'cat-mt3fhpob-oipd', name: 'Exams and Assignments', color: '#a855f7', defaultDurationMin: 60 },
  { id: 'cat-mt3fjl5e-g7a6', name: 'Events', color: '#0ea5e9', defaultDurationMin: 60 },
  { id: 'cat-mt3ftdlv-lloj', name: 'Projects Timelines', color: '#14b8a6', defaultDurationMin: 60 },
  { id: 'cat-mt3foelh-vhyl', name: 'Deadlines', color: '#eab308', defaultDurationMin: 30 },
  { id: 'university-calendar', name: 'University Calender', color: '#f97316', defaultDurationMin: 60 },
  { id: 'cat-mt3ftx8p-9lfh', name: 'Studying Timelines', color: '#6366f1', defaultDurationMin: 60 },
  { id: 'cat-mt3fsa3w-1tf2', name: 'Lectures', color: '#8b5cf6', defaultDurationMin: 60 },
  { id: 'cat-mt4arq95-mutm', name: 'Family', color: '#ec4899', defaultDurationMin: 60 },
];

/** The two built-ins the app falls back to. The shape of the damage. */
const DEFAULTS_ONLY = [CATEGORIES[0], CATEGORIES[7]];

const adapter = settingsAdapter(sharedSettingsOf as any, applySharedSettings as any);

/** A settings save, exactly as the service performs one. */
function saveSettings(
  state: SyncState,
  file: Record<string, unknown>,
  opts: { baseline?: Record<string, unknown>; device?: string; at?: number } = {},
) {
  const ops = snapshotToOps(state, {
    store: 'settings',
    snapshot: adapter.toSnapshot(file),
    device: opts.device ?? PC,
    at: opts.at ?? 1_000,
    detectDeletes: adapter.detectDeletes,
    baseline: opts.baseline ? adapter.toSnapshot(opts.baseline) : undefined,
  });
  const res = mergeOps(state, ops);
  return { state: res.state, ops, conflicts: res.conflicts };
}

/** What the merged log says the categories now are. */
const categoriesIn = (state: SyncState): unknown =>
  readEntity(state, 'settings', SETTINGS_ENTITY)?.categories;

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((c: any) => c?.name) : [];

let checks = 0;
const ok = (cond: unknown, msg: string) => { assert.ok(cond, msg); checks++; };
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); checks++; };

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. THE HISTORICAL OP ITSELF ---');

// This is the op copied verbatim out of the user's log, minus nothing.
const THE_OP = {
  opId: 'pc-desktop:5752',
  store: 'settings',
  entityId: 'app',
  field: 'categories',
  device: 'pc-desktop',
  lamport: 5752,
  at: 1788117194495,
  baseLamport: 3034,
  baseDevice: 'pc-desktop',
};

ok(isSettingsWipeOp(THE_OP), 'The op that ate the categories is recognised as a wipe');
eq(validateOp(THE_OP), null, 'And is refused at the door, so no peer can replay it');

// It must be refused whether the key is missing or explicitly undefined/null:
// JSON drops `undefined`, so the same op looks different depending on whether it
// has been through the wire, and both forms are the same instruction.
ok(isSettingsWipeOp({ ...THE_OP, value: undefined }), 'Explicit undefined is the same wipe');
ok(isSettingsWipeOp({ ...THE_OP, value: null }), 'null is the same wipe');
eq(validateOp({ ...THE_OP, value: undefined }), null, 'Refused with an explicit undefined');
eq(validateOp({ ...THE_OP, value: null }), null, 'Refused with a null');

// A push containing it loses that op and keeps the rest, rather than failing
// the whole batch: one bad op must not cost a phone the edits sent alongside it.
const push = validatePush([
  THE_OP,
  { ...THE_OP, opId: 'pc-desktop:5753', lamport: 5753, field: 'weekStartsOn', value: 1 },
]);
ok(!('error' in push), 'A batch carrying a wipe is still accepted');
if (!('error' in push)) {
  eq(push.ops.length, 1, 'Only the wipe is dropped');
  eq(push.rejected, 1, 'And it is counted as rejected');
  eq(push.ops[0]!.field, 'weekStartsOn', 'The innocent op alongside it survives');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 2. EVERY SETTINGS STRUCTURE, NOT JUST CATEGORIES ---');

// `categories` is the one that was lost, but nothing about the bug was specific
// to it. Task lists, prayer configuration and the notification rules are the
// same shape and would have gone the same way.
for (const field of SETTINGS_STRUCTURE_FIELDS) {
  ok(isSettingsWipeOp({ store: 'settings', field, value: undefined }),
    `An erasure of ${field} is a wipe`);
  eq(validateOp({ ...THE_OP, field, value: undefined }), null,
    `An erasure of ${field} is refused at the door`);
}
ok(SETTINGS_STRUCTURE_FIELDS.has('categories'), 'categories is covered');
ok(SETTINGS_STRUCTURE_FIELDS.has('taskLists'), 'taskLists is covered');
ok(SETTINGS_STRUCTURE_FIELDS.has('notifications'), 'notification rules are covered');
ok(SETTINGS_STRUCTURE_FIELDS.has('prayer'), 'prayer settings are covered');

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 3. WHAT IS *NOT* A WIPE (the guard must not overreach) ---');

ok(!isSettingsWipeOp({ store: 'settings', field: 'categories', value: [] }),
  'An empty list is a real value: the user deleting their last category must sync');
ok(!isSettingsWipeOp({ store: 'settings', field: 'categories', value: CATEGORIES }),
  'A full list is obviously not a wipe');
ok(!isSettingsWipeOp({ store: 'settings', field: 'notifications', value: {} }),
  'An empty object is a real value');
ok(!isSettingsWipeOp({ store: 'events', field: 'categories', value: undefined }),
  'Clearing a field on an EVENT is ordinary and stays allowed');
ok(!isSettingsWipeOp({ store: 'settings', field: 'weekStartsOn', value: undefined }),
  'A scalar setting is not a structure; its clearing is harmless and reversible');
ok(!isSettingsWipeOp({ store: 'settings', field: 'timeFormat', value: undefined }),
  'Same for the time format');
ok(!isSettingsWipeOp({ store: 'settings', field: 'categories', value: undefined, present: false }),
  'A set-member removal carries a member in `value` and is a different mechanism');
ok(!isSettingsWipeOp({ store: 'settings', field: 'focusExcludedDates', value: [], present: true }),
  'A set-member addition is never a wipe');
ok(!isSettingsWipeOp({ store: 'tasks', field: 'taskLists', value: null }),
  'The field name alone does not make an op a settings wipe');

// The ordinary ops must still validate, or the guard has broken normal sync.
ok(validateOp({ ...THE_OP, value: CATEGORIES }), 'A real category list is accepted');
ok(validateOp({ ...THE_OP, value: [] }), 'An intentionally emptied list is accepted');
ok(validateOp({ ...THE_OP, field: 'weekStartsOn', value: 1 }), 'Scalars are accepted');

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 4. THE DIFF NO LONGER PRODUCES THE OP ---');

// The full sequence that lost the data, replayed against the fixed code.
let s = emptyState();
const FULL = { darkMode: true, dayStartH: 6, categories: CATEGORIES, weekStartsOn: 1 };

s = saveSettings(s, FULL).state;
eq(names(categoriesIn(s)), names(CATEGORIES), 'The eleven categories are in the log');

// The save that did the damage: same file, `categories` simply absent, written
// against a baseline that HAD them (which is what made it look like a removal).
const PARTIAL = { darkMode: true, dayStartH: 6, weekStartsOn: 1 };
const damage = saveSettings(s, PARTIAL, { baseline: FULL });
eq(damage.ops.filter(o => o.field === 'categories'), [],
  'A save that omits categories emits NO categories op at all');
s = damage.state;
eq(names(categoriesIn(s)), names(CATEGORIES), 'The eleven categories are still there');

// ...and the app's fallback save an hour later, which is what made the loss
// permanent, is now just a normal edit against categories that never went away.
// (It still applies -- we are not blocking writes, only silence.)
const fallback = saveSettings(s, { ...PARTIAL, categories: DEFAULTS_ONLY }, { baseline: FULL });
ok(fallback.ops.some(o => o.field === 'categories'),
  'An explicit two-category save is still a real edit and still syncs');

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 5. NO BASELINE, ANOTHER DEVICE, NO DEVICE: SAME ANSWER ---');

// The baseline is what tells the server "the writer was looking at this". The
// rule must not depend on it, because the exact circumstances that produce a
// partial save (a restart, an older client) are also the ones that lose it.
for (const label of ['with baseline', 'without baseline', 'baseline lacking the key'] as const) {
  let t = saveSettings(emptyState(), FULL).state;
  const baseline = label === 'with baseline' ? FULL
    : label === 'baseline lacking the key' ? PARTIAL
      : undefined;
  const r = saveSettings(t, PARTIAL, { baseline });
  eq(r.ops.filter(o => o.field === 'categories'), [], `No wipe op ${label}`);
  eq(names(categoriesIn(r.state)), names(CATEGORIES), `Categories survive ${label}`);
}

// A partial save arriving from the PHONE is equally silent about what it omits.
{
  let t = saveSettings(emptyState(), FULL).state;
  const r = saveSettings(t, PARTIAL, { baseline: FULL, device: PH, at: 2_000 });
  eq(r.ops.filter(o => o.field === 'categories'), [], 'A phone omission is not a clear either');
  eq(names(categoriesIn(r.state)), names(CATEGORIES), 'Categories survive a phone partial save');
}

// A save of an EMPTY settings file -- the shape a first-run or corrupted read
// produces -- must not take the whole shared half down with it.
{
  let t = saveSettings(emptyState(), FULL).state;
  const r = saveSettings(t, {}, { baseline: FULL });
  eq(r.ops, [], 'An empty settings save emits nothing at all');
  eq(names(categoriesIn(r.state)), names(CATEGORIES), 'And erases nothing');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 6. ORDINARY EDITS STILL SYNC, IN BOTH DIRECTIONS ---');

{
  let t = saveSettings(emptyState(), FULL).state;

  // Rename one.
  const renamed = CATEGORIES.map(c =>
    c.id === 'cat-mt4arq95-mutm' ? { ...c, name: 'Family & Home' } : c);
  t = saveSettings(t, { ...FULL, categories: renamed }, { baseline: FULL }).state;
  ok(names(categoriesIn(t)).includes('Family & Home'), 'A rename syncs');

  // Add one.
  const added = [...renamed, { id: 'cat-new', name: 'Gym', color: '#000', defaultDurationMin: 45 }];
  t = saveSettings(t, { ...FULL, categories: added },
    { baseline: { ...FULL, categories: renamed } }).state;
  ok(names(categoriesIn(t)).includes('Gym'), 'An addition syncs');
  eq(names(categoriesIn(t)).length, 12, 'And nothing else was disturbed');

  // Delete one -- deliberately, by sending the list without it.
  const removed = added.filter(c => c.id !== 'cat-new');
  t = saveSettings(t, { ...FULL, categories: removed },
    { baseline: { ...FULL, categories: added } }).state;
  ok(!names(categoriesIn(t)).includes('Gym'), 'A deliberate deletion syncs: it is a VALUE');
  eq(names(categoriesIn(t)).length, 11, 'Back to eleven');

  // Delete every one. The extreme case, and still legitimate.
  t = saveSettings(t, { ...FULL, categories: [] },
    { baseline: { ...FULL, categories: removed } }).state;
  eq(categoriesIn(t), [], 'Emptying the list entirely is honoured');

  // And it can be filled again afterwards, i.e. the guard did not freeze it.
  t = saveSettings(t, { ...FULL, categories: CATEGORIES },
    { baseline: { ...FULL, categories: [] } }).state;
  eq(names(categoriesIn(t)).length, 11, 'And refilled');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 7. A PHONE EDIT IS NOT UNDONE BY A PC SAVE THAT SAYS NOTHING ---');

// The composite failure: the phone adds a category, then the PC autosaves a
// settings file that predates it and does not mention categories at all. Before
// the fix this both erased the phone's addition AND the ten it did not know
// about. This is the scenario the user would actually hit twice a day.
{
  let server = saveSettings(emptyState(), FULL).state;
  const fromPhone = [...CATEGORIES, { id: 'cat-phone', name: 'Errands', color: '#0f0', defaultDurationMin: 15 }];
  server = saveSettings(server, { ...FULL, categories: fromPhone },
    { baseline: FULL, device: PH, at: 3_000 }).state;

  const pc = saveSettings(server, PARTIAL, { baseline: FULL, device: PC, at: 4_000 });
  eq(names(categoriesIn(pc.state)).length, 12, 'The phone addition survives the PC autosave');
  ok(names(categoriesIn(pc.state)).includes('Errands'), 'By name, too');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 8. OTHER STORES MUST STILL CLEAR BY OMISSION ---');

// The bug was fixed by narrowing, not by disabling. If a field dropped from an
// EVENT stopped clearing, a reminder the user removed on the PC would live for
// ever on the phone -- a bug this codebase has already had once.
{
  let t = emptyState();
  const withNote: Snapshot = { e1: { title: 'Lecture', note: 'bring the notes' } };
  t = mergeOps(t, snapshotToOps(t, { store: 'events', snapshot: withNote, device: PC, at: 1 })).state;
  eq(readEntity(t, 'events', 'e1')?.note, 'bring the notes', 'The note is stored');

  const withoutNote: Snapshot = { e1: { title: 'Lecture' } };
  const ops = snapshotToOps(t, {
    store: 'events', snapshot: withoutNote, device: PC, at: 2, baseline: withNote,
  });
  ok(ops.some(o => o.field === 'note'), 'Dropping a field from an event still emits a clear');
  t = mergeOps(t, ops).state;
  eq(readEntity(t, 'events', 'e1')?.note, undefined, 'And the note is really gone');
}

ok(OMISSION_NEVER_CLEARS.has('settings'), 'Settings is exempt');
ok(!OMISSION_NEVER_CLEARS.has('events'), 'Events are not');
ok(!OMISSION_NEVER_CLEARS.has('tasks'), 'Tasks are not');
eq(OMISSION_NEVER_CLEARS.size, 1, 'And nothing was exempted by accident');

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 9. THE FILE WRITTEN BACK KEEPS WHAT WAS NOT SENT ---');

// Even if a wipe op somehow existed, the settings file must not lose the value:
// the adapter folds only what it was given onto what is on disk.
{
  const onDisk = { darkMode: true, dayStartH: 6, categories: CATEGORIES };
  const merged = adapter.fromSnapshot({ [SETTINGS_ENTITY]: { categories: undefined } }, onDisk) as any;
  eq(names(merged.categories), names(CATEGORIES), 'An undefined in the snapshot changes nothing');
  eq(merged.darkMode, true, 'And this device keeps its own settings');
  eq(merged.dayStartH, 6, 'All of them');

  const emptied = adapter.fromSnapshot({ [SETTINGS_ENTITY]: { categories: [] } }, onDisk) as any;
  eq(emptied.categories, [], 'A real empty list still lands on disk');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 10. ROUND TRIP: SAVE, MERGE, READ BACK, RESAVE ---');

// The property that makes the whole bridge safe: what goes in comes out, and
// feeding it back in is silent. A resave that emitted ops would be a write storm
// and, before the fix, a chance to lose the field all over again.
{
  const t = saveSettings(emptyState(), FULL);
  const snap = opsToSnapshot(t.state, 'settings');
  eq(names((snap[SETTINGS_ENTITY] as any).categories), names(CATEGORIES), 'Read back intact');

  const again = saveSettings(t.state, FULL, { baseline: FULL });
  eq(again.ops, [], 'Saving the same settings twice emits nothing');

  const rebuilt = adapter.fromSnapshot(snap, FULL) as any;
  eq(names(rebuilt.categories), names(CATEGORIES), 'And the rebuilt file matches');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 11. THE SETTINGS ENTITY IS NEVER TOMBSTONED ---');

// One more way the whole shared half could vanish at once: the `app` entity
// being treated as deleted because a save did not contain it.
{
  let t = saveSettings(emptyState(), FULL).state;
  const ops = snapshotToOps(t, {
    store: 'settings', snapshot: {}, device: PC, at: 9_000,
    detectDeletes: adapter.detectDeletes, baseline: adapter.toSnapshot(FULL),
  });
  eq(ops, [], 'An empty settings snapshot deletes nothing');
  ok(!adapter.detectDeletes, 'The settings adapter never detects deletes');
  t = mergeOps(t, ops).state;
  eq(names(categoriesIn(t)), names(CATEGORIES), 'The shared half is intact');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 12. AN OLD WIPE, REPLAYED, CANNOT WIN ---');

// A phone that has been offline since before the fix may still hold the op in
// its outbox. It gets refused at the door -- but even if it were merged, a
// later real value must beat it, so this checks both halves.
{
  let t = saveSettings(emptyState(), FULL).state;
  const stale: SyncOp = {
    opId: 'phone-android:1', store: 'settings', entityId: SETTINGS_ENTITY,
    field: 'categories', value: undefined, device: PH, lamport: 1, at: 1,
  };
  eq(validateOp(stale as unknown as Record<string, unknown>), null, 'Refused on arrival');
  const forced = mergeOps(t, [stale]).state;
  eq(names(categoriesIn(forced)), names(CATEGORIES),
    'And even forced past the door it loses to the newer real value');
}

console.log(`\n✓ settings-wipe suite passed (${checks} assertions)`);
