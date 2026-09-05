// Tests categories, swatches, event color resolution, and card styling.
// Run with: npx tsx src/lib/categories.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_CATEGORIES,
  PRESET_CATEGORY_COLORS,
  UNCATEGORISED,
  coerceCategories,
  resolveEventColor,
  canDeleteCategory,
  deleteCategory,
  LAST_CATEGORY_MESSAGE,
  type EventCategory,
} from './categories';
import {
  FALLBACK_EVENT_HEX,
  SWATCH_BASE_HEX,
  gcalChipColors,
  resolveEventHex,
} from './gcalColor';

console.log('--- 1. CATEGORY DEFAULTS & CONSTANTS ---');
assert.equal(UNCATEGORISED, '__none__', 'UNCATEGORISED must be __none__');
assert.equal(DEFAULT_CATEGORIES.length, 2, 'Default categories has 2 items');
assert.equal(DEFAULT_CATEGORIES[0].id, 'personal');
assert.equal(DEFAULT_CATEGORIES[1].id, 'university-calendar');
assert.ok(PRESET_CATEGORY_COLORS.length >= 12, 'At least 12 preset colors available');

console.log('--- 2. COERCE CATEGORIES ---');
// Null / undefined / invalid inputs fall back to defaults
assert.deepEqual(coerceCategories(null), DEFAULT_CATEGORIES);
assert.deepEqual(coerceCategories(undefined), DEFAULT_CATEGORIES);
assert.deepEqual(coerceCategories([]), DEFAULT_CATEGORIES);
assert.deepEqual(coerceCategories('garbage'), DEFAULT_CATEGORIES);
assert.deepEqual(coerceCategories(123), DEFAULT_CATEGORIES);

// Valid custom categories
const customCat: EventCategory = {
  id: 'work',
  name: 'Work Projects',
  color: '#3b82f6',
  defaultDurationMin: 45,
  defaultNoDuration: false,
  defaultAllDay: false,
  defaultNoCheckbox: true,
  showInWidget: false,
  isDefault: true,
  description: 'Work items',
};
const coerced = coerceCategories([customCat]);
assert.equal(coerced.length, 1);
assert.equal(coerced[0].id, 'work');
assert.equal(coerced[0].name, 'Work Projects');
assert.equal(coerced[0].color, '#3b82f6');
assert.equal(coerced[0].defaultDurationMin, 45);
assert.equal(coerced[0].defaultNoCheckbox, true);
assert.equal(coerced[0].showInWidget, false);
assert.equal(coerced[0].isDefault, true);

// Swatch name mapped to hex
const swatchCat = coerceCategories([{ id: 'sw', name: 'Swatch', color: 'peach' }]);
assert.equal(swatchCat[0].color, '#f97316');

// Invalid color falls back to default green
const invalidColorCat = coerceCategories([{ id: 'bad', name: 'Bad Color', color: 'not-a-color' }]);
assert.equal(invalidColorCat[0].color, '#22c55e');

// Missing name falls back to 'Unnamed Category'
const noNameCat = coerceCategories([{ id: 'nn', color: '#3b82f6' }]);
assert.equal(noNameCat[0].name, 'Unnamed Category');

// Duplicate IDs are disambiguated
const dups = coerceCategories([
  { id: 'dup', name: 'First', color: '#22c55e' },
  { id: 'dup', name: 'Second', color: '#3b82f6' },
]);
assert.equal(dups.length, 2);
assert.equal(dups[0].id, 'dup');
assert.ok(dups[1].id.startsWith('dup-'));

// 0 duration derives defaultNoDuration = true
const zeroDur = coerceCategories([{ id: 'zd', name: 'Zero', defaultDurationMin: 0 }]);
assert.equal(zeroDur[0].defaultDurationMin, 0);
assert.equal(zeroDur[0].defaultNoDuration, true);

// Explicit defaultNoDuration
const explicitNoDur = coerceCategories([{ id: 'nd', name: 'NoDur', defaultNoDuration: true }]);
assert.equal(explicitNoDur[0].defaultDurationMin, 0);
assert.equal(explicitNoDur[0].defaultNoDuration, true);

// Notification specs in categories
const notifyCat = coerceCategories([{
  id: 'notif',
  name: 'Notif',
  notifyTimed: { enabled: true, rules: [{ id: 'r1', offsetMin: -15 }], priority: 'critical' },
  notifyAllDay: { enabled: true, rules: [{ id: 'r2', offsetMin: -1440 }], priority: 'normal' },
}]);
assert.equal(notifyCat[0].notifyTimed?.rules[0].offsetMin, -15);
assert.equal(notifyCat[0].notifyTimed?.priority, 'critical');
assert.equal(notifyCat[0].notifyAllDay?.rules[0].offsetMin, -1440);

console.log('--- 3. EVENT COLOR RESOLUTION ---');
const cats: EventCategory[] = [
  { id: 'c_red', name: 'Red Cat', color: '#ef4444' },
  { id: 'c_blue', name: 'Blue Cat', color: '#3b82f6' },
];

// Category color wins over event's own color
assert.equal(resolveEventColor({ categoryId: 'c_red', color: '#00ff00' }, cats), '#ef4444');
assert.equal(resolveEventColor({ categoryId: 'c_blue' }, cats), '#3b82f6');

// Unknown category falls back to event's color
assert.equal(resolveEventColor({ categoryId: 'nonexistent', color: '#123456' }, cats), '#123456');

// Event with custom hex
assert.equal(resolveEventColor({ color: '#abcdef' }, cats), '#abcdef');

// Event with gCalHex
assert.equal(resolveEventColor({ gCalHex: '#998877' }, cats), '#998877');

// Event with named swatch
assert.equal(resolveEventColor({ color: 'lavender' }, cats), SWATCH_BASE_HEX.lavender);

// Fallback when nothing set
assert.equal(resolveEventColor({}, cats), FALLBACK_EVENT_HEX);

console.log('--- 4. RESOLVE EVENT HEX ---');
assert.equal(resolveEventHex({ color: '#ff0000' }), '#ff0000');
assert.equal(resolveEventHex({ gCalHex: '#00ff00' }), '#00ff00');
assert.equal(resolveEventHex({ color: 'coral' }), SWATCH_BASE_HEX.coral);
assert.equal(resolveEventHex({}), FALLBACK_EVENT_HEX);

console.log('--- 5. CARD CHIP COLORS & STYLES ---');
// Invalid hex returns null
assert.equal(gcalChipColors(undefined, { dark: false, style: 'tinted' }), null);
assert.equal(gcalChipColors('invalid', { dark: false, style: 'tinted' }), null);
assert.equal(gcalChipColors('#12', { dark: false, style: 'tinted' }), null);

// 3-digit hex is expanded and parsed
const threeDigit = gcalChipColors('#f00', { dark: false, style: 'tinted' });
assert.ok(threeDigit !== null);
assert.ok(threeDigit.border.length === 7);

// Tinted style: light & dark
const tintedLight = gcalChipColors('#3b82f6', { dark: false, style: 'tinted' });
assert.ok(tintedLight !== null);
assert.ok(tintedLight.bg.startsWith('#'));
assert.ok(tintedLight.text.startsWith('#'));

const tintedDark = gcalChipColors('#3b82f6', { dark: true, style: 'tinted' });
assert.ok(tintedDark !== null);
assert.equal(tintedDark.border, '#3b82f6');

// Solid style: contrast check (light yellow fill gets dark text, dark navy fill gets white text)
const solidPale = gcalChipColors('#ffff00', { dark: false, style: 'solid' });
assert.ok(solidPale !== null);
assert.equal(solidPale.text, '#0f172a', 'Pale yellow solid card must use dark slate text for contrast');

const solidDark = gcalChipColors('#000080', { dark: true, style: 'solid' });
assert.ok(solidDark !== null);
assert.equal(solidDark.text, '#ffffff', 'Dark navy solid card must use white text for contrast');

// Minimal style: accent bar
const minimal = gcalChipColors('#10b981', { dark: false, style: 'minimal' });
assert.ok(minimal !== null);
assert.equal(minimal.accentBar, '#10b981');
assert.equal(minimal.bg, '#ffffff');

const minimalDark = gcalChipColors('#10b981', { dark: true, style: 'minimal' });
assert.ok(minimalDark !== null);
assert.equal(minimalDark.accentBar, '#10b981');
assert.ok(minimalDark.bg.startsWith('rgba(255, 255, 255,'));

// Glowing style: shadow and border
const glowing = gcalChipColors('#a855f7', { dark: true, style: 'glowing' });
assert.ok(glowing !== null);
assert.equal(glowing.border, '#a855f7');
assert.ok(glowing.boxShadow?.includes('#a855f7'));

// ─── Deleting a category cannot empty the list ───────────────────────────────
//
// `coerceCategories` treats an empty array as CORRUPT and hands back the two
// built-in categories. That is right for a damaged file and catastrophic for a
// deliberate delete: removing the last category wrote `[]`, the next settings
// snapshot coerced it straight back into Personal and University Calendar, and
// those then broadcast to every device. THREE screens offered this operation
// and only one of them refused. The rule now lives in one place so they cannot
// disagree again.
{
  console.log('\n--- THE LAST CATEGORY ---');

  const cat = (id: string, name = id): EventCategory => ({
    id,
    name,
    color: '#22c55e',
    defaultDurationMin: 30,
    defaultNoDuration: false,
    defaultAllDay: false,
    defaultNoCheckbox: false,
    showInWidget: true,
  });

  const two = [cat('a'), cat('b')];
  const one = [cat('a')];

  // The premise, stated so the test explains itself: emptying the list really
  // does bring the defaults back. This is the whole reason for the guard.
  const resurrected = coerceCategories([]);
  assert.equal(resurrected.length, DEFAULT_CATEGORIES.length,
    'an empty array really is read as corruption');
  assert.deepEqual(resurrected.map(c => c.id), DEFAULT_CATEGORIES.map(c => c.id),
    'and really does come back as the built-in two');

  // ── The rule ──────────────────────────────────────────────────────────────
  assert.equal(canDeleteCategory(two, 'a'), true, 'one of two can go');
  assert.equal(canDeleteCategory(two, 'b'), true, 'either of two can go');
  assert.equal(canDeleteCategory(one, 'a'), false, 'the last one cannot');
  assert.equal(canDeleteCategory([], 'a'), false, 'nor can one out of none');
  assert.equal(canDeleteCategory(two, 'missing'), false,
    'nor can one that is not in the list, which would otherwise report success');
  assert.equal(canDeleteCategory(one, 'missing'), false, 'not even when it is the only one');

  // ── The operation ─────────────────────────────────────────────────────────
  assert.deepEqual(deleteCategory(two, 'a').map(c => c.id), ['b'], 'the right one goes');
  assert.deepEqual(deleteCategory(two, 'b').map(c => c.id), ['a'], 'and only it');
  assert.equal(deleteCategory(two, 'a').length, 1, 'exactly one is removed');

  // Refused, and refused by REFERENCE, so a caller can tell "nothing happened"
  // from "something happened" without comparing contents.
  assert.equal(deleteCategory(one, 'a'), one, 'the last one is refused, same array back');
  assert.equal(deleteCategory(two, 'missing'), two, 'an unknown id is refused the same way');
  assert.equal(deleteCategory([], 'a').length, 0, 'and an empty list stays empty');

  // The input is never mutated: these are React state arrays.
  const before = [cat('a'), cat('b')];
  const snapshot = before.map(c => c.id);
  deleteCategory(before, 'a');
  assert.deepEqual(before.map(c => c.id), snapshot, 'the array handed in is untouched');

  // ── The round trip that used to lose everything ───────────────────────────
  // Deleting down to one, then trying again, must leave exactly that one -- not
  // the two defaults.
  let list: EventCategory[] = [cat('a'), cat('b'), cat('c')];
  for (const id of ['a', 'b', 'c', 'c']) list = deleteCategory(list, id);
  assert.deepEqual(list.map(c => c.id), ['c'], 'deleting everything leaves the last survivor');
  assert.deepEqual(coerceCategories(list).map(c => c.id), ['c'],
    'and it survives the coercion that used to replace it with the defaults');

  // A duplicate id in a damaged list still cannot be used to empty it.
  const dupes = [cat('a'), cat('a')];
  assert.equal(canDeleteCategory(dupes, 'a'), true, 'two rows, so one may go');
  assert.equal(deleteCategory(dupes, 'a').length, 0,
    'filter removes both, which is why the CALLER must re-check rather than trust the count');

  // There is one message, so the two screens cannot word it differently.
  assert.equal(typeof LAST_CATEGORY_MESSAGE, 'string');
  assert.ok(LAST_CATEGORY_MESSAGE.length > 0, 'and it says something');
  assert.ok(!/[–—]/.test(LAST_CATEGORY_MESSAGE),
    'and it carries no em or en dash, which is the standing rule for visible text');

  console.log('  The list can never be emptied into the defaults');
}

// ─── The shipped default names ──────────────────────────────────────────────
{
  console.log('\n--- THE BUILT-IN NAMES ---');

  for (const c of DEFAULT_CATEGORIES) {
    assert.ok(c.name.trim().length > 0, `${c.id} has a name`);
    assert.ok(!/[–—]/.test(c.name), `${c.id} carries no em or en dash`);
  }
  const uni = DEFAULT_CATEGORIES.find(c => c.id === 'university-calendar');
  assert.ok(uni, 'the university default is still there under its own id');
  assert.equal(uni!.name, 'University Calendar', 'and is spelled correctly');
  assert.ok(!DEFAULT_CATEGORIES.some(c => /Calender/.test(c.name)),
    'nothing shipped says "Calender"');

  // The ids are what everything else keys on, so a rename must not touch them.
  assert.deepEqual(DEFAULT_CATEGORIES.map(c => c.id), ['personal', 'university-calendar'],
    'the ids are unchanged, so no existing item is orphaned by the spelling fix');

  console.log('  Defaults are named correctly and keyed unchanged');
}

console.log('\nALL PASS (categories & gcalColor)');
