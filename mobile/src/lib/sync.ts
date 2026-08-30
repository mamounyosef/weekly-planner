// ─── Offline-first sync core ─────────────────────────────────────────────────
// Pure, I/O-free merge engine shared by the PC dev server and the Android app.
//
// THE RULE: neither peer ever sends "here is my version of the week". Both send
// small, per-FIELD operations, and replaying them in ANY order on ANY peer lands
// on the same state. That property (commutativity) is what makes it safe to edit
// the same planner on a phone with no signal and a PC with no phone.
//
// Why not last-write-wins on whole records: a whole-record LWW would throw away
// the PC's rename because the phone moved the start time three seconds later.
// Field-level ops keep both, and only raise a conflict when the SAME field was
// genuinely edited from two directions.
//
// ── Ordering and clock skew ──────────────────────────────────────────────────
// Wall-clock timestamps across two devices cannot be trusted (a phone can be
// minutes off, and Android silently corrects its clock). So every op carries a
// LAMPORT counter as well as `at`:
//
//     lamport = max(everything I have ever seen) + 1
//
// Ordering is (lamport, deviceId) — deterministic and identical on both peers.
// `at` is kept for DISPLAY only ("edited on PC at 21:14") and never decides a
// winner. This is the single most important invariant in this file: a phone with
// a wrong clock must never be able to silently win every conflict.
//
// ── Detecting a REAL conflict (3-way, like a merge) ───────────────────────────
// Each op records the stamp of the value it overwrote (`baseLamport`/`baseDevice`).
// On apply, compared against the field's current head:
//
//   • base == head            → a clean fast-forward. Apply. No conflict.
//   • op stamp already seen   → an echo of something already applied. Ignore.
//   • op stamp IS the head's ancestor → stale. Ignore.
//   • otherwise               → the two peers edited from a common ancestor
//                               independently. CONCURRENT: pick the winner by
//                               (lamport, deviceId) and RAISE A CONFLICT so the
//                               losing value is offered in the sidebar, never
//                               silently dropped.
//
// ── Field kinds ──────────────────────────────────────────────────────────────
// Not every field should behave like a register. `exdates` and `completedDates`
// are SETS: the phone excluding Tuesday and the PC excluding Thursday is not a
// disagreement, it is two additions. Merging them as registers would lose one.
// Sets merge by union with per-element tombstones (add-wins), so they never
// produce a conflict card.

// ─── Identity ────────────────────────────────────────────────────────────────

export type SyncStore =
  | 'events'
  | 'tasks'
  | 'taskLists'
  | 'categories'
  | 'settings'
  | 'prayerDone'
  | 'focusSessions';

/** Fields that are merged as add-wins sets rather than registers. */
export const SET_FIELDS: ReadonlySet<string> = new Set([
  'events.exdates',
  'events.completedDates',
  'tasks.exdates',
  'tasks.completedDates',
]);

/** Marks an entity as deleted. Never a hard delete — a tombstone, so the peer
 *  that never saw the delete learns about it instead of resurrecting the item. */
export const DELETED_FIELD = '__deleted';

export const isSetField = (store: SyncStore, field: string): boolean =>
  SET_FIELDS.has(`${store}.${field}`);

// ─── Operations ──────────────────────────────────────────────────────────────

export interface SyncOp {
  /** Globally unique: `${deviceId}:${lamport}`. The dedupe key across peers. */
  opId: string;
  store: SyncStore;
  entityId: string;
  field: string;
  /** For a set field this is the ELEMENT; `present` says added or removed. */
  value: unknown;
  /** Set fields only. true = add the element, false = remove it. */
  present?: boolean;
  device: string;
  lamport: number;
  /** Wall clock, for display only. NEVER used to decide a winner. */
  at: number;
  /** Stamp of the value this op overwrote; absent = wrote onto nothing. */
  baseLamport?: number;
  baseDevice?: string;
  /**
   * Server-assigned position in the durable log. NEVER set by a client, and
   * never used to decide a winner — only to answer "what have I not seen yet".
   *
   * WHY THIS EXISTS: the pull cursor used to be a lamport counter, and lamports
   * are not monotonic in log order. A phone that edits while offline mints ops
   * with LOW lamports; appended to a log whose head is far higher, those ops sit
   * below every other device's cursor and are never handed out again. `seq` is
   * strictly increasing in append order, so a cursor over it can never skip.
   */
  seq?: number;
}

/** The winning value of one field, plus who put it there. */
export interface FieldHead {
  value: unknown;
  lamport: number;
  device: string;
  at: number;
  /**
   * The value this head overwrote, when it overwrote one.
   *
   * Recorded so that "was this edit actually a change?" is answerable from state
   * alone. A save that rewrites a field with the value it already had must not
   * be able to out-rank a concurrent delete — otherwise an autosave keeps
   * resurrecting an item somebody deleted on the other device.
   */
  prev?: unknown;
}

export interface SetElementState {
  present: boolean;
  lamport: number;
  device: string;
  /** Wall clock, for display on a conflict card. Optional: states written
   *  before this existed simply have none. Never used to decide a winner. */
  at?: number;
}

export interface EntityState {
  /** Register fields → their current head. */
  fields: Record<string, FieldHead>;
  /** Set fields → element key → membership state. */
  sets: Record<string, Record<string, SetElementState>>;
  /** Every op stamp ever applied to a register field, for ancestry checks.
   *  Keyed by field, holding `${lamport}:${device}` strings. */
  seen: Record<string, string[]>;
}

export interface SyncState {
  /** store → entityId → EntityState */
  entities: Record<string, Record<string, EntityState>>;
  /** Highest lamport this peer has observed from anyone. */
  lamport: number;
  /** opIds already applied, so a replayed batch is a no-op. */
  applied: Record<string, true>;
}

// ─── Conflicts ───────────────────────────────────────────────────────────────

export type ConflictKind = 'field' | 'delete';

export interface SyncConflict {
  /** Stable across re-syncs: the two op stamps that diverged, sorted. */
  id: string;
  kind: ConflictKind;
  store: SyncStore;
  entityId: string;
  field: string;
  /** The value that won the automatic resolution and is live right now. */
  winner: { value: unknown; device: string; at: number; lamport: number };
  /** The value that lost. Preserved so the sidebar can offer it back. */
  loser: { value: unknown; device: string; at: number; lamport: number };
  detectedAt: number;
}

/**
 * A card whose two sides hold the same value is not a disagreement. Checked
 * again here because cards persist: one written by an older build is still on
 * disk and on the phone, and must disappear rather than linger unanswerable.
 */
export function isMeaninglessConflict(c: SyncConflict): boolean {
  return valuesEqual(c.winner.value, c.loser.value);
}

export interface MergeResult {
  state: SyncState;
  /** Ops that changed something. Useful for narrowing a UI refresh. */
  appliedOps: SyncOp[];
  /** Ops ignored as duplicates, echoes or stale ancestors. */
  ignoredOps: SyncOp[];
  conflicts: SyncConflict[];
}

// ─── Construction ────────────────────────────────────────────────────────────

export function emptyState(): SyncState {
  return { entities: {}, lamport: 0, applied: {} };
}

const emptyEntity = (): EntityState => ({ fields: {}, sets: {}, seen: {} });

const stampOf = (lamport: number, device: string): string => `${lamport}:${device}`;

/** Globally unique op identity. Device first so a log is readable at a glance. */
const opIdOf = (device: string, lamport: number): string => `${device}:${lamport}`;

/** Deterministic total order, identical on every peer. Higher wins. */
export function compareStamps(
  a: { lamport: number; device: string },
  b: { lamport: number; device: string },
): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.device === b.device) return 0;
  return a.device < b.device ? -1 : 1;
}

/**
 * Structural equality for planner values.
 *
 * Values here are JSON: strings, numbers, booleans, arrays like `completedDates`
 * and small objects like `notify` / `recur`. Two devices that independently tick
 * the same day produce EQUAL arrays that are not the same reference, so `===`
 * would call that a disagreement. It is not — it is agreement reached twice.
 *
 * `null` and `undefined` are deliberately NOT equal: one means "explicitly no
 * value", the other means "cleared", and the notification model distinguishes
 * them (an absent notify spec inherits; an explicit one does not).
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') {
    // NaN === NaN is false, but two devices writing NaN agree.
    return typeof a === 'number' && typeof b === 'number'
      && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => valuesEqual(x, (b as unknown[])[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every(k => valuesEqual(
    (a as Record<string, unknown>)[k],
    (b as Record<string, unknown>)[k],
  ));
}

/** Stable key for a set element, so objects and primitives both work. */
export function elementKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ─── Prototype-safe map access ───────────────────────────────────────────────
// Entity ids and field names are USER DATA. An id of `__proto__` on a plain
// object does not create an entry — a read returns Object.prototype and a write
// invokes the prototype setter, so the engine both crashes and risks polluting
// every object in the process. Ids like `constructor` are the same hazard.
// Every map in this file is therefore read and written through these two
// helpers; direct bracket access on a user-supplied key is a bug.

export function getOwn<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

export function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, {
    value, writable: true, enumerable: true, configurable: true,
  });
}

function entityOf(state: SyncState, store: SyncStore, entityId: string): EntityState {
  let byId = getOwn(state.entities, store);
  if (!byId) {
    byId = {};
    setOwn(state.entities, store, byId);
  }
  let ent = getOwn(byId, entityId);
  if (!ent) {
    ent = emptyEntity();
    setOwn(byId, entityId, ent);
  }
  return ent;
}

/**
 * The membership of a set field, as it stands right now.
 *
 * A field can become a set field AFTER data already exists for it — that is
 * exactly what happened to `events.completedDates`, which used to merge as a
 * register. State written before the change holds an ARRAY in `fields`, and
 * ignoring it would erase every tick the user had already made. So the register
 * value seeds the membership and per-element ops override it. Once every element
 * has been touched the register is irrelevant, and until then nothing is lost.
 *
 * Pure: same state in, same membership out, on every peer.
 */
export function setMembers(ent: EntityState, field: string): Record<string, SetElementState> {
  const out: Record<string, SetElementState> = {};
  const legacy = getOwn(ent.fields, field);
  if (legacy && Array.isArray(legacy.value)) {
    for (const el of legacy.value as unknown[]) {
      setOwn(out, elementKey(el), {
        present: true, lamport: legacy.lamport, device: legacy.device,
      });
    }
  }
  const set = getOwn(ent.sets, field);
  if (set) for (const key of Object.keys(set)) setOwn(out, key, set[key]!);
  return out;
}

// ─── Producing local operations ──────────────────────────────────────────────

/**
 * Build the ops for a local edit and advance the lamport clock.
 * `changes` is a partial record: `{ startTime: '20:00', title: 'Physics' }`.
 * A field set to `undefined` is treated as clearing it, not as "no change".
 *
 * Mutates `state.lamport` only; call `mergeOps` to apply the result locally so
 * that the local and remote paths go through exactly the same code.
 */
export function makeOps(
  state: SyncState,
  opts: {
    store: SyncStore;
    entityId: string;
    device: string;
    at: number;
    changes: Record<string, unknown>;
  },
): SyncOp[] {
  const { store, entityId, device, at, changes } = opts;
  const ent = entityOf(state, store, entityId);
  const ops: SyncOp[] = [];

  for (const field of Object.keys(changes)) {
    const value = changes[field];

    if (isSetField(store, field)) {
      // A set field is written as a whole array; diff it against what we hold.
      const next = Array.isArray(value) ? value : [];
      const nextKeys = new Set(next.map(elementKey));
      const current = setMembers(ent, field);

      for (const el of next) {
        const key = elementKey(el);
        if (getOwn(current, key)?.present) continue; // already a member
        state.lamport += 1;
        ops.push({
          opId: opIdOf(device, state.lamport),
          store, entityId, field, value: el, present: true,
          device, lamport: state.lamport, at,
        });
      }
      for (const key of Object.keys(current)) {
        if (!current[key]!.present || nextKeys.has(key)) continue;
        state.lamport += 1;
        ops.push({
          opId: opIdOf(device, state.lamport),
          store, entityId, field, value: key, present: false,
          device, lamport: state.lamport, at,
        });
      }
      continue;
    }

    const head = getOwn(ent.fields, field);
    state.lamport += 1;
    ops.push({
      opId: opIdOf(device, state.lamport),
      store, entityId, field, value,
      device, lamport: state.lamport, at,
      baseLamport: head?.lamport,
      baseDevice: head?.device,
    });
  }

  return ops;
}

/** Tombstone an entity. Deletes are ops like any other, so they sync and merge. */
export function makeDeleteOp(
  state: SyncState,
  opts: { store: SyncStore; entityId: string; device: string; at: number },
): SyncOp {
  return makeOps(state, { ...opts, changes: { [DELETED_FIELD]: true } })[0];
}

// ─── Merging ─────────────────────────────────────────────────────────────────

/**
 * Apply a batch of ops (local or remote) to `state`.
 *
 * Order-independent: the same batch in any order, applied any number of times,
 * yields the same state and the same conflicts. That is the property the tests
 * hammer, because it is the one that keeps data alive.
 */
export function mergeOps(state: SyncState, ops: readonly SyncOp[]): MergeResult {
  const next: SyncState = {
    entities: structuredClone(state.entities),
    lamport: state.lamport,
    applied: { ...state.applied },
  };
  const appliedOps: SyncOp[] = [];
  const ignoredOps: SyncOp[] = [];
  const conflicts: SyncConflict[] = [];

  // Deterministic application order, so two peers handed the same set of ops in
  // different orders take the same path and log the same conflicts.
  const sorted = [...ops].sort((a, b) => compareStamps(a, b) || (a.opId < b.opId ? -1 : 1));

  for (const op of sorted) {
    // The clock advances even for ops we end up ignoring: we have still SEEN them.
    if (op.lamport > next.lamport) next.lamport = op.lamport;

    if (getOwn(next.applied, op.opId)) {
      ignoredOps.push(op);
      continue;
    }
    setOwn(next.applied, op.opId, true);

    const ent = entityOf(next, op.store, op.entityId);

    if (isSetField(op.store, op.field)) {
      applySetOp(ent, op, appliedOps, ignoredOps);
      continue;
    }

    applyRegisterOp(ent, op, appliedOps, ignoredOps, conflicts);
  }

  // Delete-vs-edit is a whole-entity question, so it is decided after the field
  // pass, once we know every edit that landed in this batch.
  conflicts.push(...detectDeleteConflicts(next, appliedOps));

  return { state: next, appliedOps, ignoredOps, conflicts: collapseConflicts(conflicts) };
}

/**
 * One card per field, not one per op. Editing a title three times offline while
 * the PC edited it once is ONE disagreement to answer, and a sidebar that asked
 * three times about the same field would train you to dismiss without reading.
 */
function collapseConflicts(conflicts: readonly SyncConflict[]): SyncConflict[] {
  const best = new Map<string, SyncConflict>();
  for (const c of conflicts) {
    if (isMeaninglessConflict(c)) continue;
    const key = `${c.store} ${c.entityId} ${c.field}`;
    const prev = best.get(key);
    if (!prev || compareStamps(c.winner, prev.winner) > 0) best.set(key, c);
  }
  return [...best.values()];
}

/**
 * A set-field op that carries the WHOLE ARRAY instead of one element.
 *
 * WHERE THESE COME FROM, AND WHY IT MATTERED SO MUCH. `completedDates` was not
 * always a set field. A build that predates that change writes it like any other
 * value: one op, the entire array, and no `present` flag. Two devices on
 * different builds is the normal state of affairs for an app updated over the
 * air, so these ops WILL arrive.
 *
 * Treating one as an ordinary element was silent, permanent data corruption.
 * `elementKey` JSON-encodes a non-string, so the array `["2026-08-29"]` became
 * the literal member `'["2026-08-29"]'` — a string that is not a date. It sat in
 * the set at `present: true`, where add-wins semantics meant nothing would ever
 * remove it, and `completedDates.includes('2026-08-29')` stayed false forever.
 * The user ticked the item, both devices agreed on the stored data, and neither
 * ever showed a tick.
 *
 * The honest reading is the one the writer meant: the set is now exactly this
 * array. Applied per element at the op's own stamp, so it orders against every
 * other change the same way and stays idempotent.
 */
function applyWholeSetOp(
  ent: EntityState,
  op: SyncOp,
  appliedOps: SyncOp[],
  ignoredOps: SyncOp[],
): void {
  let set = getOwn(ent.sets, op.field);
  if (!set) { set = {}; setOwn(ent.sets, op.field, set); }

  const wanted = new Set((op.value as unknown[]).map(elementKey));
  const effective = setMembers(ent, op.field);
  const keys = new Set([
    ...Object.keys(set),
    ...Object.keys(effective),
    ...wanted,
  ]);

  let changed = false;
  for (const key of keys) {
    const incoming: SetElementState = {
      present: wanted.has(key),
      lamport: op.lamport,
      device: op.device,
      at: op.at,
    };
    const current = getOwn(set, key) ?? getOwn(effective, key);
    if (!current) {
      // Absent and staying absent: nothing to record.
      if (!incoming.present) continue;
      setOwn(set, key, incoming);
      changed = true;
      continue;
    }
    const cmp = compareStamps(incoming, current);
    if (cmp > 0 || (cmp === 0 && incoming.present && !current.present)) {
      setOwn(set, key, incoming);
      changed = true;
    }
  }

  (changed ? appliedOps : ignoredOps).push(op);
}

/**
 * Is this a plausible set member, or wreckage from the mis-keying above?
 *
 * Members are dates and ids — never JSON. Anything that begins like an encoded
 * array or object was produced by the bug and can never match a real lookup.
 */
export const isJunkSetMember = (key: string): boolean => /^[[{]/.test(key);

/**
 * Strip members that could only have come from the mis-keying bug.
 *
 * Needed because the damage outlives the fix: the bad members are already in
 * every saved state file, and add-wins means no later op will ever clear them.
 * Cheap, and a no-op on healthy data. Returns the SAME object when nothing
 * changes so callers can skip a write.
 */
export function sanitizeState(state: SyncState): SyncState {
  let dirty = false;
  for (const store of Object.keys(state.entities)) {
    const byId = getOwn(state.entities as Record<string, unknown>, store) as
      Record<string, EntityState> | undefined;
    if (!byId) continue;
    for (const id of Object.keys(byId)) {
      const sets = getOwn(byId, id)?.sets;
      if (!sets) continue;
      for (const field of Object.keys(sets)) {
        const members = getOwn(sets, field);
        if (!members) continue;
        for (const key of Object.keys(members)) {
          if (!isJunkSetMember(key)) continue;
          delete members[key];
          dirty = true;
        }
      }
    }
  }
  return dirty ? { ...state, entities: state.entities } : state;
}

function applySetOp(
  ent: EntityState,
  op: SyncOp,
  appliedOps: SyncOp[],
  ignoredOps: SyncOp[],
): void {
  // The whole-array form, written by a build that did not know this was a set.
  if (op.present === undefined && Array.isArray(op.value)) {
    applyWholeSetOp(ent, op, appliedOps, ignoredOps);
    return;
  }

  let set = getOwn(ent.sets, op.field);
  if (!set) { set = {}; setOwn(ent.sets, op.field, set); }
  const key = elementKey(op.value);
  // Compare against the EFFECTIVE membership, which includes a legacy register
  // array left over from before this field merged as a set.
  const current = getOwn(set, key) ?? getOwn(setMembers(ent, op.field), key);
  const incoming: SetElementState = {
    present: op.present !== false,
    lamport: op.lamport,
    device: op.device,
    at: op.at,
  };

  if (!current) {
    setOwn(set, key, incoming);
    appliedOps.push(op);
    return;
  }
  const cmp = compareStamps(incoming, current);
  // Add-wins: on a genuine tie the addition survives, because resurrecting an
  // excluded date is recoverable and losing one silently is not.
  if (cmp > 0 || (cmp === 0 && incoming.present && !current.present)) {
    setOwn(set, key, incoming);
    appliedOps.push(op);
  } else {
    ignoredOps.push(op);
  }
}

function applyRegisterOp(
  ent: EntityState,
  op: SyncOp,
  appliedOps: SyncOp[],
  ignoredOps: SyncOp[],
  conflicts: SyncConflict[],
): void {
  const head = getOwn(ent.fields, op.field);
  let seen = getOwn(ent.seen, op.field);
  if (!seen) { seen = []; setOwn(ent.seen, op.field, seen); }
  const myStamp = stampOf(op.lamport, op.device);
  const incoming: FieldHead = {
    value: op.value,
    lamport: op.lamport,
    device: op.device,
    at: op.at,
  };

  // First value this field has ever held.
  if (!head) {
    setOwn(ent.fields, op.field, incoming);
    seen.push(myStamp);
    appliedOps.push(op);
    return;
  }
  incoming.prev = head.value;

  const headStamp = stampOf(head.lamport, head.device);
  const baseStamp =
    op.baseLamport === undefined || op.baseDevice === undefined
      ? undefined
      : stampOf(op.baseLamport, op.baseDevice);

  // Clean fast-forward: this op was written on top of exactly what we hold.
  if (baseStamp === headStamp) {
    setOwn(ent.fields, op.field, incoming);
    seen.push(myStamp);
    appliedOps.push(op);
    return;
  }

  // We already hold something derived from this op — it is an ancestor. Stale.
  if (seen.includes(myStamp)) {
    ignoredOps.push(op);
    return;
  }

  // Two peers wrote this field from a common ancestor without seeing each other.
  // Resolve deterministically, and keep the loser.
  const incomingWins = compareStamps(incoming, head) > 0;
  const winner = incomingWins ? incoming : head;
  const loser = incomingWins ? head : incoming;

  // TWO DEVICES THAT WROTE THE SAME VALUE HAVE NOT DISAGREED.
  // Ticking the same item off on the phone and on the PC within a minute is the
  // commonest way to reach this branch, and a card offering you a choice between
  // two identical values is noise that teaches you to dismiss cards unread. The
  // ORDERING is still resolved exactly as before — only the card is suppressed.
  // The comparison must be structural: `completedDates` arrays and `notify`
  // objects are equal by content, never by reference.
  const agreed = valuesEqual(winner.value, loser.value);

  // A conflict against a value we never actually diverged from is not a conflict
  // — it is a first write racing an unrelated one on a brand-new entity.
  if (!agreed && !(winner.device === loser.device && winner.lamport === loser.lamport)) {
    conflicts.push({
      id: [stampOf(winner.lamport, winner.device), stampOf(loser.lamport, loser.device)]
        .sort()
        .join('|'),
      kind: op.field === DELETED_FIELD ? 'delete' : 'field',
      store: op.store,
      entityId: op.entityId,
      field: op.field,
      winner: { value: winner.value, device: winner.device, at: winner.at, lamport: winner.lamport },
      loser: { value: loser.value, device: loser.device, at: loser.at, lamport: loser.lamport },
      detectedAt: Math.max(winner.at, loser.at),
    });
  }

  seen.push(myStamp);
  if (incomingWins) {
    setOwn(ent.fields, op.field, incoming);
    appliedOps.push(op);
  } else {
    ignoredOps.push(op);
  }
}

/**
 * Is this entity actually deleted right now?
 *
 * A tombstone alone is not enough. If any field was edited by ANOTHER device
 * with a later stamp, that device had not seen the delete — the two are
 * concurrent, and THE EDIT WINS PROVISIONALLY. The item stays visible and usable
 * until you answer the card, because a silently vanished item is unrecoverable
 * damage whereas a briefly surviving one costs a single tap. The delete intent is
 * not lost: it is held in the conflict and reapplied if you choose "Delete it".
 *
 * CRITICAL: this is a pure function of the final state, never a decision taken
 * while merging. An earlier version flipped the tombstone during the merge, and
 * the outcome then depended on which ops happened to arrive in the same batch —
 * two peers holding identical ops disagreed about whether an item existed. Any
 * rule that decides deletion must be derivable from state alone, or peers drift.
 */
function deleteIsContested(ent: EntityState): boolean {
  const del = getOwn(ent.fields, DELETED_FIELD);
  if (!del || del.value !== true) return false;
  for (const field of Object.keys(ent.fields)) {
    if (field === DELETED_FIELD) continue;
    const head = ent.fields[field]!;
    if (head.device === del.device) continue;
    if (isNoOpEdit(head)) continue;
    if (compareStamps(head, del) > 0) return true;
  }
  // SET FIELDS COUNT TOO. Ticking something off is an edit like any other, and
  // for a long time it was the ONLY edit the phone could make — so the one kind
  // of change it could contribute was the one kind a delete could destroy
  // without asking. Marking a lecture done on the phone while the PC deleted it
  // lost the tick and the item with no card, no error and no trace, which is
  // precisely the "deletion never silently beats a concurrent edit" rule this
  // function exists to enforce.
  return newestSetEditAfter(ent, del) !== undefined;
}

/**
 * The newest set-member change that beat `del` and came from another device.
 *
 * Both directions count. Adding a member is plainly an edit; removing one is a
 * deliberate act too, and treating it as nothing would make "I un-ticked it"
 * disappear as silently as the case above.
 */
function newestSetEditAfter(
  ent: EntityState,
  del: FieldHead,
): { field: string; key: string; el: SetElementState } | undefined {
  let best: { field: string; key: string; el: SetElementState } | undefined;
  for (const field of Object.keys(ent.sets)) {
    const members = getOwn(ent.sets, field);
    if (!members) continue;
    for (const key of Object.keys(members)) {
      const el = members[key]!;
      if (el.device === del.device) continue;
      if (compareStamps(el, del) <= 0) continue;
      if (!best || compareStamps(el, best.el) > 0) best = { field, key, el };
    }
  }
  return best;
}

/**
 * Did this head actually change anything?
 *
 * The PC autosaves its whole event map, so a field is rewritten with the value
 * it already held every time anything else on the page changes. Such a write
 * must not out-rank a delete made on the phone, or the item comes back on every
 * autosave and the user can never delete it from the phone at all.
 *
 * Derived from state (`prev` is recorded when the head is written), never from
 * which ops happened to share a batch.
 */
function isNoOpEdit(head: FieldHead): boolean {
  return Object.hasOwn(head, 'prev') && valuesEqual(head.value, head.prev);
}

export function isDeleted(ent: EntityState): boolean {
  return getOwn(ent.fields, DELETED_FIELD)?.value === true && !deleteIsContested(ent);
}

/** Delete-vs-edit races, derived from state rather than from batch composition. */
function detectDeleteConflicts(state: SyncState, appliedOps: SyncOp[]): SyncConflict[] {
  const out: SyncConflict[] = [];
  const touched = new Set(appliedOps.map(o => `${o.store} ${o.entityId}`));

  for (const key of touched) {
    const sep = key.indexOf(' ');
    const store = key.slice(0, sep);
    const entityId = key.slice(sep + 1);
    const byId = getOwn(state.entities, store);
    const ent = byId ? getOwn(byId, entityId) : undefined;
    if (!ent || !deleteIsContested(ent)) continue;

    const del = getOwn(ent.fields, DELETED_FIELD)!;
    // The edit that beat the delete — the newest one, so the card is stable no
    // matter which field triggered the detection.
    let head: FieldHead | undefined;
    for (const field of Object.keys(ent.fields)) {
      if (field === DELETED_FIELD) continue;
      const h = ent.fields[field]!;
      if (h.device === del.device || compareStamps(h, del) <= 0) continue;
      if (isNoOpEdit(h)) continue;
      if (!head || compareStamps(h, head) > 0) head = h;
    }

    // A set change can be the winner too, and often IS the only edit involved.
    // Presented as a head so the card looks the same whichever kind of field
    // raised it; `at` falls back to the delete's clock for states written before
    // set members recorded one.
    const setEdit = newestSetEditAfter(ent, del);
    if (setEdit && (!head || compareStamps(setEdit.el, head) > 0)) {
      head = {
        value: setEdit.key,
        device: setEdit.el.device,
        lamport: setEdit.el.lamport,
        at: setEdit.el.at ?? del.at,
      };
    }
    if (!head) continue;

    out.push({
      id: [stampOf(del.lamport, del.device), stampOf(head.lamport, head.device)].sort().join('|'),
      kind: 'delete',
      store: store as SyncStore,
      entityId,
      field: DELETED_FIELD,
      winner: { value: false, device: head.device, at: head.at, lamport: head.lamport },
      loser: { value: true, device: del.device, at: del.at, lamport: del.lamport },
      detectedAt: Math.max(head.at, del.at),
    });
  }
  return out;
}

// ─── Reading state back out ──────────────────────────────────────────────────

/** Materialise one entity as a plain record, or null if it is tombstoned. */
export function readEntity(
  state: SyncState,
  store: SyncStore,
  entityId: string,
): Record<string, unknown> | null {
  const byId = getOwn(state.entities, store);
  const ent = byId ? getOwn(byId, entityId) : undefined;
  if (!ent) return null;
  if (isDeleted(ent)) return null;

  // Keys are emitted in sorted order so that two peers holding the same data
  // serialise BYTE-IDENTICALLY. That is what lets a sync round cheaply prove
  // agreement by comparing a hash instead of walking the whole planner.
  const out: Record<string, unknown> = {};
  const names = new Set<string>();
  for (const field of Object.keys(ent.fields)) {
    if (field === DELETED_FIELD) continue;
    if (isSetField(store, field)) { names.add(field); continue; }
    if (ent.fields[field]!.value !== undefined) names.add(field);
  }
  for (const field of Object.keys(ent.sets)) names.add(field);

  for (const field of [...names].sort()) {
    if (isSetField(store, field) || Object.hasOwn(ent.sets, field)) {
      setOwn(out, field, Object.entries(setMembers(ent, field))
        .filter(([, st]) => st.present)
        .map(([k]) => k)
        .sort());
    } else {
      setOwn(out, field, ent.fields[field]!.value);
    }
  }
  return out;
}

/** Materialise a whole store, tombstones omitted. */
export function readStore(
  state: SyncState,
  store: SyncStore,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const byId = getOwn(state.entities, store) ?? {};
  for (const id of Object.keys(byId).sort()) {
    const rec = readEntity(state, store, id);
    if (rec) setOwn(out, id, rec);
  }
  return out;
}

/** True if the entity exists but is tombstoned — needed so a peer can delete it
 *  locally rather than treating a missing record as "never existed". */
export function isTombstoned(state: SyncState, store: SyncStore, entityId: string): boolean {
  const byId = getOwn(state.entities, store);
  const ent = byId ? getOwn(byId, entityId) : undefined;
  return ent ? isDeleted(ent) : false;
}

// ─── Resolving a conflict from the sidebar ───────────────────────────────────

/**
 * Turn the user's answer into a normal op, so the choice itself syncs and both
 * peers land on it. There is no separate "resolution" channel to get out of step.
 *
 * `choice`: 'winner' keeps what is already live (just dismisses), 'loser' restores
 * the other value, 'delete' confirms a pending deletion, 'keep' cancels one.
 */
export function resolveConflict(
  state: SyncState,
  conflict: SyncConflict,
  choice: 'winner' | 'loser' | 'delete' | 'keep',
  opts: { device: string; at: number },
): SyncOp[] {
  if (conflict.kind === 'delete' && (choice === 'delete' || choice === 'keep')) {
    return makeOps(state, {
      store: conflict.store,
      entityId: conflict.entityId,
      device: opts.device,
      at: opts.at,
      changes: { [DELETED_FIELD]: choice === 'delete' },
    });
  }
  if (choice === 'winner') return []; // already live; nothing to write
  return makeOps(state, {
    store: conflict.store,
    entityId: conflict.entityId,
    device: opts.device,
    at: opts.at,
    changes: { [conflict.field]: conflict.loser.value },
  });
}

// ─── Transport helpers ───────────────────────────────────────────────────────

/** Ops this peer must send: everything the other side has not acknowledged. */
export function opsSince(log: readonly SyncOp[], cursor: number): SyncOp[] {
  return log.filter(op => op.lamport > cursor);
}

/** The cursor to send back after ingesting a batch. */
export function cursorAfter(cursor: number, ops: readonly SyncOp[]): number {
  return ops.reduce((max, op) => (op.lamport > max ? op.lamport : max), cursor);
}

/**
 * Trim an op log once BOTH peers have acknowledged past a point. Field heads
 * live in the state, not the log, so trimming is safe — but never trim past the
 * lowest peer cursor or that peer can never catch up.
 */
export function pruneLog(log: readonly SyncOp[], lowestPeerCursor: number): SyncOp[] {
  return log.filter(op => op.lamport > lowestPeerCursor);
}
