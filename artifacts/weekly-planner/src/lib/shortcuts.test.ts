import assert from 'node:assert/strict';
import {
  coerceShortcuts,
  DEFAULT_SHORTCUTS,
  FOCUS_TIMER_TOGGLE_DEFAULT,
  LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT,
  SHORTCUT_DEFAULTS_VERSION,
  SHORTCUT_DEFS,
  matchesCombo,
} from './shortcuts';

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

// MatchesCombo checks for key 1 and 2
const fakeKey1 = { key: '1', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent;
const fakeKey2 = { key: '2', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false } as KeyboardEvent;
assert.ok(matchesCombo('1', fakeKey1), 'matchesCombo should match 1 key');
assert.ok(matchesCombo('2', fakeKey2), 'matchesCombo should match 2 key');
assert.ok(!matchesCombo('1', fakeKey2), 'matchesCombo should not match wrong key');

console.log('Shortcut-default migration and custom/month view tests passed');

