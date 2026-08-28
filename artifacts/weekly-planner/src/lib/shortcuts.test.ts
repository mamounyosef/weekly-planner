import assert from 'node:assert/strict';
import {
  DEFAULT_SHORTCUTS,
  FOCUS_TIMER_TOGGLE_DEFAULT,
  LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT,
  SHORTCUT_DEFAULTS_VERSION,
  SHORTCUT_DEFS,
  coerceShortcuts,
  eventToCombo,
  findConflicts,
  formatCombo,
  isReservedCombo,
  loadShortcuts,
  matchesCombo,
} from './shortcuts';

console.log('--- 1. SHORTCUT DEFAULTS & DEFINITIONS ---');
assert.equal(
  DEFAULT_SHORTCUTS.toggleTimer,
  FOCUS_TIMER_TOGGLE_DEFAULT,
  'new profiles must default the main focus timer to Win+Shift+F1',
);

assert.equal(
  DEFAULT_SHORTCUTS.customView,
  '1',
  'custom preview shortcut must default to 1',
);

assert.equal(
  DEFAULT_SHORTCUTS.monthView,
  '2',
  'monthly preview shortcut must default to 2',
);

const customDef = SHORTCUT_DEFS.find(d => d.action === 'customView');
assert.ok(customDef, 'customView must be present in SHORTCUT_DEFS');
assert.equal(customDef?.group, 'View', 'customView must belong to View group');
assert.equal(customDef?.blockedInTextFields, true, 'customView must be blocked in text fields');

const monthDef = SHORTCUT_DEFS.find(d => d.action === 'monthView');
assert.ok(monthDef, 'monthView must be present in SHORTCUT_DEFS');
assert.equal(monthDef?.group, 'View', 'monthView must belong to View group');
assert.equal(monthDef?.blockedInTextFields, true, 'monthView must be blocked in text fields');

console.log('--- 2. COERCE SHORTCUTS & MIGRATIONS ---');
assert.equal(
  coerceShortcuts({ customView: 'Alt+1', monthView: 'Alt+2' }).customView,
  'Alt+1',
  'customView custom binding must be preserved',
);

assert.equal(
  coerceShortcuts({ customView: 'Alt+1', monthView: 'Alt+2' }).monthView,
  'Alt+2',
  'monthView custom binding must be preserved',
);

assert.equal(
  coerceShortcuts({}).customView,
  '1',
  'missing customView in raw settings must fallback to default 1',
);

assert.equal(
  coerceShortcuts({}).monthView,
  '2',
  'missing monthView in raw settings must fallback to default 2',
);

assert.equal(
  coerceShortcuts({ toggleTimer: LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT }, 1).toggleTimer,
  FOCUS_TIMER_TOGGLE_DEFAULT,
  'the historical shipped default must migrate to Win+Shift+F1',
);

assert.equal(
  coerceShortcuts({ toggleTimer: LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT }, SHORTCUT_DEFAULTS_VERSION).toggleTimer,
  LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT,
  'a deliberate Alt+Shift+F1 choice made after migration must remain custom',
);

assert.equal(
  coerceShortcuts({ toggleTimer: 'Win+Shift+F2' }, 1).toggleTimer,
  'Win+Shift+F2',
  'other existing custom timer bindings must remain untouched',
);

// Reserved combo in raw settings is rejected and reset to default
assert.equal(
  coerceShortcuts({ openSettings: 'Alt+F4' }).openSettings,
  DEFAULT_SHORTCUTS.openSettings,
  'OS reserved combo must be rejected',
);

// Old default 'S' for widgetStart upgraded to 'W'
assert.equal(
  coerceShortcuts({ widgetStart: 'S' }).widgetStart,
  'W',
  'Legacy widgetStart S must migrate to W',
);

console.log('--- 3. EVENT TO COMBO & MATCHES COMBO ---');
// Modifiers alone return null
assert.equal(eventToCombo({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent), null);
assert.equal(eventToCombo({ key: 'Alt', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false } as KeyboardEvent), null);
assert.equal(eventToCombo({ key: 'Shift', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false } as KeyboardEvent), null);

// Key combos
const ctrlC = { key: 'c', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent;
assert.equal(eventToCombo(ctrlC), 'Ctrl+C');
assert.ok(matchesCombo('Ctrl+C', ctrlC));

const winShiftF1 = { key: 'F1', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true } as KeyboardEvent;
assert.equal(eventToCombo(winShiftF1), 'Win+Shift+F1');
assert.ok(matchesCombo('Win+Shift+F1', winShiftF1));

const spaceEvent = { key: ' ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent;
assert.equal(eventToCombo(spaceEvent), 'Space');
assert.ok(matchesCombo('Space', spaceEvent));

// MatchesCombo checks for key 1 and 2
const fakeKey1 = { key: '1', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent;
const fakeKey2 = { key: '2', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent;
assert.ok(matchesCombo('1', fakeKey1), 'matchesCombo should match 1 key');
assert.ok(matchesCombo('2', fakeKey2), 'matchesCombo should match 2 key');
assert.ok(!matchesCombo('1', fakeKey2), 'matchesCombo should not match wrong key');

console.log('--- 4. FORMAT COMBO ---');
assert.equal(formatCombo(''), 'Unassigned');
assert.equal(formatCombo('Alt+ArrowRight'), 'Alt + →');
assert.equal(formatCombo('Ctrl+ArrowLeft'), 'Ctrl + ←');
assert.equal(formatCombo('ArrowUp'), '↑');
assert.equal(formatCombo('ArrowDown'), '↓');
assert.equal(formatCombo('Escape'), 'Esc');
assert.equal(formatCombo('Delete'), 'Del');
assert.equal(formatCombo('Backspace'), '⌫');
assert.equal(formatCombo('Win+Shift+F1'), '⊞ Win + Shift + F1');

console.log('--- 5. IS RESERVED COMBO ---');
assert.equal(isReservedCombo('Alt+F4'), true);
assert.equal(isReservedCombo('Ctrl+W'), true);
assert.equal(isReservedCombo('Ctrl+R'), true);
assert.equal(isReservedCombo('F5'), true);
assert.equal(isReservedCombo('Win+L'), true);
assert.equal(isReservedCombo('Win+D'), true);
assert.equal(isReservedCombo('Ctrl+Z'), false);
assert.equal(isReservedCombo('Alt+N'), false);

console.log('--- 6. FIND CONFLICTS ---');
const withConflict = { ...DEFAULT_SHORTCUTS, prevWeek: 'Alt+T', today: 'Alt+T' };
const conflicts = findConflicts(withConflict, 'today');
assert.equal(conflicts.length, 1);
assert.equal(conflicts[0], 'prevWeek');

// Widget actions do not conflict with main window actions
const noCrossConflict = findConflicts({ ...DEFAULT_SHORTCUTS, prevWeek: 'A', widgetMinus: 'A' }, 'prevWeek');
assert.equal(noCrossConflict.length, 0, 'Widget shortcuts run in separate window scope and do not conflict with main');

console.log('--- 7. LOAD SHORTCUTS ---');
const loaded = loadShortcuts();
assert.ok(loaded.today !== undefined);

console.log('\nALL PASS (shortcuts)');
