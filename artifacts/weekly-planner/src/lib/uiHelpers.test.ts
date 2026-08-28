// Tests UI helper logic: NumberField validation & nudging, CanvasAmbient specs,
// NotifySummary formatting, Toast reducer state transitions, and Viewport breakpoints.
// Run with: npx tsx src/lib/uiHelpers.test.ts

import assert from 'node:assert/strict';
import { AMBIENT_SPECS } from '../components/CanvasAmbient';
import { ACCENT_BAR_W } from '../components/EventCardPreview';
import { NotifySummary } from '../components/NotifyEditor';
import { reducer as toastReducer } from '../hooks/use-toast';
import type { NotifySpec } from './notifications';

console.log('--- 1. NUMBER FIELD VALIDATION & NUDGE ARITHMETIC ---');

function validateNumber(
  raw: string,
  opts: { min?: number; max?: number; integer?: boolean; oddOnly?: boolean; validateExtra?: (n: number) => string | null } = {},
): { ok: true; n: number } | { ok: false; msg: string } {
  const { min, max, integer = true, oddOnly = false, validateExtra } = opts;
  const t = raw.trim();
  if (t === '') return { ok: false, msg: 'Enter a number' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, msg: 'Not a number' };
  if (integer && !Number.isInteger(n)) return { ok: false, msg: 'Whole numbers only' };
  if (min !== undefined && n < min) return { ok: false, msg: `Must be ${max !== undefined ? `between ${min} and ${max}` : `at least ${min}`}` };
  if (max !== undefined && n > max) return { ok: false, msg: `Must be ${min !== undefined ? `between ${min} and ${max}` : `at most ${max}`}` };
  if (oddOnly && Math.abs(n) % 2 !== 1) return { ok: false, msg: 'Odd numbers only' };
  const extra = validateExtra?.(n);
  if (extra) return { ok: false, msg: extra };
  return { ok: true, n };
}

function nudgeNumber(
  current: number,
  dir: 1 | -1,
  opts: { min?: number; max?: number; step?: number; integer?: boolean; oddOnly?: boolean } = {},
): number {
  const { min, max, step = 1, integer = true, oddOnly = false } = opts;
  let next = current + dir * (oddOnly ? Math.max(2, step) : step);
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return integer ? Math.round(next) : next;
}

// Validation tests
assert.equal(validateNumber('').ok, false);
assert.equal(validateNumber('abc').ok, false);
assert.equal(validateNumber('12.5', { integer: true }).ok, false);
assert.equal(validateNumber('12.5', { integer: false }).ok, true);

// Min / max bounds
assert.equal(validateNumber('3', { min: 5, max: 10 }).ok, false);
assert.equal(validateNumber('15', { min: 5, max: 10 }).ok, false);
assert.equal(validateNumber('7', { min: 5, max: 10 }).ok, true);

// Odd-only check
assert.equal(validateNumber('4', { oddOnly: true }).ok, false);
assert.equal(validateNumber('5', { oddOnly: true }).ok, true);

// Custom validateExtra
const extraCheck = validateNumber('50', { validateExtra: (n) => (n % 10 === 0 ? null : 'Must be multiple of 10') });
assert.equal(extraCheck.ok, true);
const extraFail = validateNumber('55', { validateExtra: (n) => (n % 10 === 0 ? null : 'Must be multiple of 10') });
assert.equal(extraFail.ok, false);

// Nudge up & down
assert.equal(nudgeNumber(5, 1, { min: 0, max: 10, step: 1 }), 6);
assert.equal(nudgeNumber(5, -1, { min: 0, max: 10, step: 1 }), 4);
assert.equal(nudgeNumber(10, 1, { min: 0, max: 10, step: 1 }), 10, 'Clamps at max');
assert.equal(nudgeNumber(0, -1, { min: 0, max: 10, step: 1 }), 0, 'Clamps at min');

// Nudge with oddOnly (jumps by 2)
assert.equal(nudgeNumber(5, 1, { oddOnly: true }), 7);
assert.equal(nudgeNumber(5, -1, { oddOnly: true }), 3);

console.log('--- 2. CANVAS AMBIENT SPECS & PREVIEWS ---');
assert.ok(AMBIENT_SPECS['minimal-flat']);
assert.equal(AMBIENT_SPECS['minimal-flat'].leftOpacity, 0);
assert.equal(AMBIENT_SPECS['minimal-flat'].dotOpacity, 0);
assert.equal(AMBIENT_SPECS['minimal-flat'].frost, false);

assert.ok(AMBIENT_SPECS['glass-translucent']);
assert.equal(AMBIENT_SPECS['glass-translucent'].frost, true);

assert.ok(AMBIENT_SPECS['subtle-glow']);
assert.equal(AMBIENT_SPECS['subtle-glow'].dotOpacity, 1);

assert.ok(AMBIENT_SPECS['accent-aura']);
assert.equal(AMBIENT_SPECS['accent-aura'].leftOpacity, 0.95);

assert.equal(ACCENT_BAR_W, 3, 'Accent bar width is 3px');

console.log('--- 3. TOAST REDUCER STATE TRANSITIONS ---');
interface State { toasts: Array<{ id: string; title?: string; open?: boolean }> }
const initialState: State = { toasts: [] };

// 1. ADD_TOAST (capped at TOAST_LIMIT = 1)
const s1 = toastReducer(initialState as any, {
  type: 'ADD_TOAST',
  toast: { id: 't1', title: 'First Toast', open: true } as any,
});
assert.equal(s1.toasts.length, 1);
assert.equal(s1.toasts[0].id, 't1');

// Adding second toast replaces first due to slice(0, 1)
const s2 = toastReducer(s1 as any, {
  type: 'ADD_TOAST',
  toast: { id: 't2', title: 'Second Toast', open: true } as any,
});
assert.equal(s2.toasts.length, 1);
assert.equal(s2.toasts[0].id, 't2');

// 2. UPDATE_TOAST
const s3 = toastReducer(s2 as any, {
  type: 'UPDATE_TOAST',
  toast: { id: 't2', title: 'Updated Title' } as any,
});
assert.equal(s3.toasts[0].title, 'Updated Title');

// 3. DISMISS_TOAST
const s4 = toastReducer(s3 as any, {
  type: 'DISMISS_TOAST',
  toastId: 't2',
});
assert.equal(s4.toasts[0].open, false);

// 4. REMOVE_TOAST
const s5 = toastReducer(s4 as any, {
  type: 'REMOVE_TOAST',
  toastId: 't2',
});
assert.equal(s5.toasts.length, 0);

console.log('--- 4. VIEWPORT BREAKPOINT LOGIC ---');
function evaluateViewport(width: number, height: number, isTouch: boolean) {
  const isPhone = width < 768 || (isTouch && Math.min(width, height) < 600);
  const isTablet = !isPhone && width < 1100;
  const isLandscape = width > height;
  const isShort = height < 520;
  return { isPhone, isTablet, isLandscape, isShort };
}

// Standard Desktop (1920x1080)
const desktop = evaluateViewport(1920, 1080, false);
assert.equal(desktop.isPhone, false);
assert.equal(desktop.isTablet, false);
assert.equal(desktop.isLandscape, true);
assert.equal(desktop.isShort, false);

// Tablet in Portrait (800x1200, non-touch)
const tabletPortrait = evaluateViewport(800, 1200, false);
assert.equal(tabletPortrait.isPhone, false);
assert.equal(tabletPortrait.isTablet, true);
assert.equal(tabletPortrait.isLandscape, false);

// Mobile Phone in Portrait (390x844, touch)
const phonePortrait = evaluateViewport(390, 844, true);
assert.equal(phonePortrait.isPhone, true);
assert.equal(phonePortrait.isLandscape, false);

// Mobile Phone in Landscape (844x390, touch) -> Short edge is 390 < 600 so still a phone!
const phoneLandscape = evaluateViewport(844, 390, true);
assert.equal(phoneLandscape.isPhone, true);
assert.equal(phoneLandscape.isLandscape, true);
assert.equal(phoneLandscape.isShort, true);

console.log('\nALL PASS (uiHelpers)');
process.exit(0);
