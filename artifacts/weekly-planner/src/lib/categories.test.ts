// Tests categories, swatches, event color resolution, and card styling.
// Run with: npx tsx src/lib/categories.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_CATEGORIES,
  PRESET_CATEGORY_COLORS,
  UNCATEGORISED,
  coerceCategories,
  resolveEventColor,
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

console.log('\nALL PASS (categories & gcalColor)');
