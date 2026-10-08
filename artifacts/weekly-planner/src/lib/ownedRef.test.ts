// Tests for ownedRef: an outgoing (animating-out) copy of the week grid must not
// clear the shared ref that the incoming copy already filled.
//
// Run with: npx tsx src/lib/ownedRef.test.ts

import assert from 'node:assert/strict';
import { ownedRef } from './ownedRef';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };
const el = (id: string) => ({ id });

test('mount fills, unmount clears', () => {
  const ref = { current: null as { id: string } | null };
  const cb = ownedRef(ref);
  const a = el('a');
  cb(a);
  assert.equal(ref.current, a);
  cb(null);
  assert.equal(ref.current, null);
});

test('old copy unmounting AFTER the new one mounted keeps the new element', () => {
  const ref = { current: null as { id: string } | null };
  const oldCb = ownedRef(ref);
  const newCb = ownedRef(ref);
  const a = el('old'), b = el('new');
  oldCb(a);
  newCb(b);          // new week mounts while the old one is still fading out
  oldCb(null);       // old one finishes its exit animation
  assert.equal(ref.current, b);
});

test('old copy unmounting BEFORE the new one mounts clears, then the new fills', () => {
  const ref = { current: null as { id: string } | null };
  const oldCb = ownedRef(ref);
  const newCb = ownedRef(ref);
  const a = el('old'), b = el('new');
  oldCb(a);
  oldCb(null);
  assert.equal(ref.current, null);
  newCb(b);
  assert.equal(ref.current, b);
});

test('element swapped within one copy (line hidden then shown again)', () => {
  const ref = { current: null as { id: string } | null };
  const cb = ownedRef(ref);
  const a = el('a'), b = el('b');
  cb(a); cb(null); cb(b);
  assert.equal(ref.current, b);
  cb(null);
  assert.equal(ref.current, null);
});

test('a null with nothing owned is harmless and leaves another owner alone', () => {
  const ref = { current: null as { id: string } | null };
  const other = ownedRef(ref);
  const idle = ownedRef(ref);
  const a = el('a');
  other(a);
  idle(null);
  idle(null);
  assert.equal(ref.current, a);
});

test('three overlapping copies (fast week clicking): only the last survives', () => {
  const ref = { current: null as { id: string } | null };
  const c1 = ownedRef(ref), c2 = ownedRef(ref), c3 = ownedRef(ref);
  const a = el('1'), b = el('2'), c = el('3');
  c1(a); c2(b); c3(c);
  c2(null); c1(null);
  assert.equal(ref.current, c);
});

test('re-attaching the same element twice is idempotent', () => {
  const ref = { current: null as { id: string } | null };
  const cb = ownedRef(ref);
  const a = el('a');
  cb(a); cb(a);
  assert.equal(ref.current, a);
  cb(null);
  assert.equal(ref.current, null);
});

console.log(`${n} passed`);
