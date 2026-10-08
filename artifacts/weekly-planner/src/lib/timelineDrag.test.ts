// Tests for dragging items on the week grid, overnight items above all.
// Grid used throughout: planner day 06:00 -> 06:00, visible 06:00 -> 02:00
// (the user's real setting), 5-minute snap.
//
// Run with: npx tsx src/lib/timelineDrag.test.ts

import assert from 'node:assert/strict';
import { absMin, splitAbs, snapTo, grabOffset, dragTo, groupDragTo, toClockMin } from './timelineDrag';

const DS = 6 * 60;      // day start 06:00
const SNAP = 5;
const hm = (h: number, m = 0) => h * 60 + m;            // column minute, may exceed 1440
let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log('ok', name); };

// Sleeping on Thu (day 3): 23:35 -> 08:05 next morning, 510 minutes.
const SLEEP = { day: 3, startMin: hm(23, 35), dur: 510 };

test('splitAbs keeps the minute inside its own planner day', () => {
  assert.deepEqual(splitAbs(absMin(3, hm(23, 35)), DS), { day: 3, startMin: hm(23, 35) });
  // 05:59 on the calendar morning after day 3 still belongs to day 3.
  assert.deepEqual(splitAbs(absMin(3, hm(29, 59)), DS), { day: 3, startMin: hm(29, 59) });
  // 06:00 the next morning is day 4's first minute.
  assert.deepEqual(splitAbs(absMin(3, hm(30)), DS), { day: 4, startMin: DS });
  // Negative days (custom view, previous week) work the same way.
  assert.deepEqual(splitAbs(absMin(-1, hm(23)), DS), { day: -1, startMin: hm(23) });
  assert.deepEqual(splitAbs(absMin(0, DS) - 1, DS), { day: -1, startMin: hm(29, 59) });
});

test('grab offset is the same whether the evening or the morning part was grabbed', () => {
  // Evening part: pointer on Thu at 00:35 (column minute 24:35).
  assert.equal(grabOffset({ pointerDay: 3, pointerMin: hm(24, 35), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur }), 60);
  // Morning part: pointer on FRI at 07:00 -> 7h25m into the item.
  assert.equal(grabOffset({ pointerDay: 4, pointerMin: hm(7), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur }), 445);
  // Clamped into the item.
  assert.equal(grabOffset({ pointerDay: 5, pointerMin: hm(7), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur }), 510);
  assert.equal(grabOffset({ pointerDay: 2, pointerMin: hm(7), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur }), 0);
});

test('picking up and putting down without moving changes nothing (both parts)', () => {
  for (const [pd, pm] of [[3, hm(23, 50)], [3, hm(25, 30)], [4, hm(6)], [4, hm(8)]] as const) {
    const off = grabOffset({ pointerDay: pd, pointerMin: pm, itemDay: SLEEP.day, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur });
    assert.deepEqual(dragTo({ pointerDay: pd, pointerMin: pm, offsetMin: off, dayStartMin: DS, snap: SNAP }),
      { day: 3, startMin: SLEEP.startMin }, `grab at ${pd}/${pm}`);
  }
});

test('morning part dragged sideways moves the whole night by whole days', () => {
  const off = grabOffset({ pointerDay: 4, pointerMin: hm(7), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur });
  // To Saturday's morning (day 5): the night now starts Fri 23:35.
  assert.deepEqual(dragTo({ pointerDay: 5, pointerMin: hm(7), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: 4, startMin: hm(23, 35) });
  // To Monday's morning (day 0): starts on the previous week's Sunday (day -1).
  assert.deepEqual(dragTo({ pointerDay: 0, pointerMin: hm(7), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: -1, startMin: hm(23, 35) });
});

test('morning part dragged DOWN follows the cursor past 02:00 (old code pinned at 01:55)', () => {
  const off = grabOffset({ pointerDay: 4, pointerMin: hm(7), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur });
  // Pointer to Fri 10:00: three hours later -> starts 02:35 (hidden band), still day 3.
  assert.deepEqual(dragTo({ pointerDay: 4, pointerMin: hm(10), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: 3, startMin: hm(26, 35) });
  // Pointer to Fri 14:00: starts 06:35 Fri -> now a day-4 item entirely.
  assert.deepEqual(dragTo({ pointerDay: 4, pointerMin: hm(14), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: 4, startMin: hm(6, 35) });
});

test('evening part dragged up and down stays on its own day', () => {
  const off = grabOffset({ pointerDay: 3, pointerMin: hm(24), itemDay: 3, itemStartMin: SLEEP.startMin, durationMin: SLEEP.dur });
  assert.deepEqual(dragTo({ pointerDay: 3, pointerMin: hm(23), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: 3, startMin: hm(22, 35) });
  assert.deepEqual(dragTo({ pointerDay: 3, pointerMin: hm(25, 55), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: 3, startMin: hm(25, 30) });
  // Sideways to Wednesday.
  assert.deepEqual(dragTo({ pointerDay: 2, pointerMin: hm(24), offsetMin: off, dayStartMin: DS, snap: SNAP }), { day: 2, startMin: hm(23, 35) });
});

test('a normal item dragged above the window top becomes an early-morning item, correctly dated', () => {
  // 1h item on Wed 09:00, grabbed at its bottom (offset 55), pointer to Wed 06:15.
  const off = grabOffset({ pointerDay: 2, pointerMin: hm(9, 55), itemDay: 2, itemStartMin: hm(9), durationMin: 60 });
  const t = dragTo({ pointerDay: 2, pointerMin: hm(6, 15), offsetMin: off, dayStartMin: DS, snap: SNAP });
  // 05:20 on Wednesday morning = the tail end of Tuesday's planner day.
  assert.deepEqual(t, { day: 1, startMin: hm(29, 20) });
  assert.equal(toClockMin(t.startMin), hm(5, 20));
});

test('the item always overlaps the pointer (stays under the cursor)', () => {
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 2000; i++) {
    const itemDay = Math.floor(rnd() * 7);
    const itemStart = DS + Math.floor(rnd() * 288) * 5;
    const dur = 5 + Math.floor(rnd() * 200) * 5;
    const grabAbs = absMin(itemDay, itemStart) + Math.floor(rnd() * dur);
    const g = splitAbs(grabAbs, DS);
    const off = grabOffset({ pointerDay: g.day, pointerMin: g.startMin, itemDay, itemStartMin: itemStart, durationMin: dur });
    const pDay = Math.floor(rnd() * 7);
    const pMin = DS + Math.floor(rnd() * 240) * 5;          // visible 06:00-02:00
    const t = dragTo({ pointerDay: pDay, pointerMin: pMin, offsetMin: off, dayStartMin: DS, snap: SNAP });
    const s = absMin(t.day, t.startMin);
    const p = absMin(pDay, pMin);
    assert.ok(s <= p + SNAP && p <= s + dur + SNAP, `case ${i}: pointer ${p} outside item ${s}..${s + dur}`);
    assert.ok(t.startMin >= DS && t.startMin < DS + 1440, `case ${i}: minute inside its day`);
    assert.equal(t.startMin % SNAP, 0, `case ${i}: snapped`);
  }
});

test('linked pair grabbed by the morning part does NOT jump a day on the first move', () => {
  const items = { sleep: { day: 3, startMin: hm(23, 35) }, getup: { day: 3, startMin: hm(23, 20) } };
  // Grab on Fri 07:00 (the head), nudge 5 minutes down.
  const t = groupDragTo({ items, grabDay: 4, grabMin: hm(7), pointerDay: 4, pointerMin: hm(7, 5), dayStartMin: DS, snap: SNAP });
  assert.deepEqual(t.sleep, { day: 3, startMin: hm(23, 40) });
  assert.deepEqual(t.getup, { day: 3, startMin: hm(23, 25) });
  // Not moving at all is a no-op.
  assert.deepEqual(groupDragTo({ items, grabDay: 4, grabMin: hm(7), pointerDay: 4, pointerMin: hm(7), dayStartMin: DS, snap: SNAP }), items);
});

test('linked pair moves across days and across midnight together, spacing exact', () => {
  const items = { sleep: { day: 3, startMin: hm(23, 35) }, getup: { day: 3, startMin: hm(23, 20) } };
  const t = groupDragTo({ items, grabDay: 3, grabMin: hm(23, 30), pointerDay: 5, pointerMin: hm(24, 30), dayStartMin: DS, snap: SNAP });
  assert.deepEqual(t.getup, { day: 5, startMin: hm(24, 20) });
  assert.deepEqual(t.sleep, { day: 5, startMin: hm(24, 35) });
  const gap = (x: typeof t) => absMin(x.sleep.day, x.sleep.startMin) - absMin(x.getup.day, x.getup.startMin);
  assert.equal(gap(t), 15);
  // Spacing survives any random move.
  let seed = 9;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 500; i++) {
    const r = groupDragTo({ items, grabDay: 3, grabMin: hm(23, 30),
      pointerDay: Math.floor(rnd() * 9) - 1, pointerMin: DS + Math.floor(rnd() * 240) * 5, dayStartMin: DS, snap: SNAP });
    assert.equal(gap(r), 15, `case ${i}`);
    for (const v of Object.values(r)) assert.ok(v.startMin >= DS && v.startMin < DS + 1440);
  }
});

test('day start at midnight (dayStartH 0) behaves like a plain calendar', () => {
  assert.deepEqual(splitAbs(absMin(2, 1440 + 30), 0), { day: 3, startMin: 30 });
  const off = grabOffset({ pointerDay: 3, pointerMin: 60, itemDay: 2, itemStartMin: hm(23), durationMin: 180 });
  assert.equal(off, 120);
  assert.deepEqual(dragTo({ pointerDay: 4, pointerMin: 60, offsetMin: off, dayStartMin: 0, snap: SNAP }), { day: 3, startMin: hm(23) });
});

test('garbage input never produces NaN', () => {
  const t = dragTo({ pointerDay: NaN, pointerMin: NaN, offsetMin: NaN, dayStartMin: NaN, snap: 0 });
  assert.ok(Number.isFinite(t.day) && Number.isFinite(t.startMin));
  assert.equal(grabOffset({ pointerDay: 0, pointerMin: 0, itemDay: 0, itemStartMin: 0, durationMin: NaN }), 0);
  assert.equal(snapTo(7, 0), 7);
  assert.equal(snapTo(7, -5), 7);
});

test('toClockMin wraps column minutes back to HH:MM', () => {
  assert.equal(toClockMin(hm(25, 30)), hm(1, 30));
  assert.equal(toClockMin(hm(23, 35)), hm(23, 35));
  assert.equal(toClockMin(1440), 0);
  assert.equal(toClockMin(-5), 1435);
});

console.log(`${n} passed`);
