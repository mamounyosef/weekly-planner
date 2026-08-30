// ─── Runtime guards ──────────────────────────────────────────────────────────
// The sync engine is shared with the PC, where it runs on Node and can assume
// modern built-ins. Hermes has these too on current React Native, but the cost
// of being wrong is the app failing to open at all — so they are checked once,
// here, rather than trusted.
//
// Each fallback is behaviour-identical for the values this app actually stores
// (JSON-shaped data: objects, arrays, strings, numbers, booleans, null).

if (typeof globalThis.structuredClone !== 'function') {
  // The engine clones state before merging so a failed merge cannot leave a
  // half-mutated planner behind.
  (globalThis as any).structuredClone = <T>(value: T): T =>
    value === undefined ? value : JSON.parse(JSON.stringify(value));
}

if (typeof (Object as any).hasOwn !== 'function') {
  // Used for every entity id and field name, because a key of `__proto__` must
  // be treated as data rather than as prototype access.
  (Object as any).hasOwn = (target: object, key: PropertyKey): boolean =>
    Object.prototype.hasOwnProperty.call(target, key);
}

export {};
