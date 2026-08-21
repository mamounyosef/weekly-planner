import assert from 'node:assert/strict';
import {
  coerceShortcuts,
  DEFAULT_SHORTCUTS,
  FOCUS_TIMER_TOGGLE_DEFAULT,
  LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT,
  SHORTCUT_DEFAULTS_VERSION,
} from './shortcuts';

assert.equal(
  DEFAULT_SHORTCUTS.toggleTimer,
  FOCUS_TIMER_TOGGLE_DEFAULT,
  'new profiles must default the main focus timer to Win+Shift+F1',
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

console.log('Shortcut-default migration tests passed');
