// ─── Keyboard shortcuts ─────────────────────────────────────────────────────
// Every shortcut in the app is described here and is user-rebindable from
// Settings. A binding is a plain string combo like "Alt+ArrowRight" or
// "Ctrl+Shift+Z", built from a KeyboardEvent by `eventToCombo` — so recording a
// new binding is just "listen for one keydown and store what it produces".

export type ShortcutAction =
  | 'prevWeek'
  | 'nextWeek'
  | 'today'
  | 'toggleView'
  | 'goToLive'
  | 'newEvent'
  | 'toggleTimer'
  | 'focusAnalysis'
  | 'openSettings'
  | 'openWidget'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'delete'
  | 'help'
  | 'widgetMinus'
  | 'widgetPlus'
  | 'widgetStart';

export interface ShortcutDef {
  action: ShortcutAction;
  label: string;
  hint: string;
  group: 'Navigation' | 'View' | 'Editing' | 'Focus';
  /** Editing shortcuts must not fire while typing in an input/textarea. */
  blockedInTextFields: boolean;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { action: 'prevWeek',      label: 'Previous week',     hint: 'Move the calendar back one week',        group: 'Navigation', blockedInTextFields: true },
  { action: 'nextWeek',      label: 'Next week',         hint: 'Move the calendar forward one week',     group: 'Navigation', blockedInTextFields: true },
  { action: 'today',         label: 'Jump to today',     hint: 'Return to the current week',             group: 'Navigation', blockedInTextFields: true },
  { action: 'goToLive',      label: 'Go to live time',   hint: 'Scroll the red now-line into view',      group: 'Navigation', blockedInTextFields: true },
  { action: 'toggleView',    label: 'Week / Month',      hint: 'Switch between week and month view',     group: 'View',       blockedInTextFields: true },
  { action: 'focusAnalysis', label: 'Focus analysis',    hint: 'Open or close the analysis screen',      group: 'View',       blockedInTextFields: true },
  { action: 'openSettings',  label: 'Settings',          hint: 'Open or close the settings drawer',      group: 'View',       blockedInTextFields: true },
  { action: 'openWidget',    label: 'Open widget',       hint: 'Launch the floating side widget',        group: 'View',       blockedInTextFields: true },
  { action: 'help',          label: 'Shortcut help',     hint: 'Show this shortcut list',                group: 'View',       blockedInTextFields: true },
  { action: 'newEvent',      label: 'New item',          hint: 'Start creating an item',                 group: 'Editing',    blockedInTextFields: true },
  { action: 'undo',          label: 'Undo',              hint: 'Undo the last change',                   group: 'Editing',    blockedInTextFields: true },
  { action: 'redo',          label: 'Redo',              hint: 'Redo the last undone change',            group: 'Editing',    blockedInTextFields: true },
  { action: 'copy',          label: 'Copy item',         hint: 'Copy the selected or hovered item',      group: 'Editing',    blockedInTextFields: true },
  { action: 'paste',         label: 'Paste item',        hint: 'Paste at the cursor position',           group: 'Editing',    blockedInTextFields: true },
  { action: 'delete',        label: 'Delete item',       hint: 'Delete the selected or hovered item',    group: 'Editing',    blockedInTextFields: true },
  { action: 'toggleTimer',   label: 'Start / pause timer', hint: 'Toggle main focus timer',              group: 'Focus',      blockedInTextFields: true },
  { action: 'widgetMinus',   label: 'Widget timer −',    hint: 'Decrease focus timer in widget',         group: 'Focus',      blockedInTextFields: true },
  { action: 'widgetPlus',    label: 'Widget timer +',    hint: 'Increase focus timer in widget',         group: 'Focus',      blockedInTextFields: true },
  { action: 'widgetStart',   label: 'Widget start / pause', hint: 'Start or pause focus session in widget', group: 'Focus',   blockedInTextFields: true },
];

export type ShortcutMap = Record<ShortcutAction, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  // Bare letters are safe here: the handler ignores shortcuts while a text field
  // has focus, so typing is never intercepted.
  prevWeek:      'A',
  nextWeek:      'D',
  today:         'Alt+T',
  goToLive:      'S',
  toggleView:    'Alt+M',
  focusAnalysis: 'Alt+A',
  openSettings:  'Alt+S',
  openWidget:    'Alt+W',
  help:          'Alt+/',
  newEvent:      'Alt+N',
  undo:          'Ctrl+Z',
  redo:          'Ctrl+Shift+Z',
  copy:          'Ctrl+C',
  paste:         'Ctrl+V',
  delete:        'Delete',
  toggleTimer:   'Alt+Shift+F1',
  widgetMinus:   'A',
  widgetPlus:    'D',
  widgetStart:   'S',
};

/**
 * Combos the OS or browser owns. Binding these either does nothing or does
 * something destructive (Alt+F4 closes the window), so recording rejects them.
 */
const RESERVED_COMBOS = new Set([
  'Alt+F4', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+R', 'Ctrl+Shift+R', 'F5',
  'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+Q', 'Alt+Tab', 'Alt+Space',
  'Ctrl+Alt+Delete', 'F11', 'F12',
  // Windows itself owns these and never lets the page (or a hotkey) see them.
  'Win+L', 'Win+D', 'Win+E', 'Win+R', 'Win+I', 'Win+S', 'Win+A', 'Win+Tab', 'Win+X',
]);

export function isReservedCombo(combo: string): boolean {
  return RESERVED_COMBOS.has(combo);
}

export const SHORTCUTS_KEY = 'planner-shortcuts';

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'Dead', 'OS']);

/**
 * Canonical combo string for a keydown. Returns null while only modifiers are
 * held (so a recorder can ignore them and wait for the real key).
 */
export function eventToCombo(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  // The Windows key is its own modifier — the system-wide hotkey helper can bind
  // it, so combos like Win+Shift+F1 have to be recordable here too.
  if (e.metaKey) parts.push('Win');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

export function matchesCombo(binding: string | undefined, e: KeyboardEvent): boolean {
  if (!binding) return false;
  const combo = eventToCombo(e);
  if (!combo) return false;
  if (combo === binding) return true;
  // Shift often rewrites the printed key ("/" + Shift → "?"), so also accept a
  // match on the physical code when a Shift-bearing binding doesn't line up.
  return combo.toLowerCase() === binding.toLowerCase();
}

/** Human-readable combo for display: "Alt+ArrowRight" → "Alt + →". */
export function formatCombo(binding: string): string {
  if (!binding) return 'Unassigned';
  return binding
    .split('+')
    .map(part => {
      switch (part) {
        case 'ArrowLeft':  return '←';
        case 'ArrowRight': return '→';
        case 'ArrowUp':    return '↑';
        case 'ArrowDown':  return '↓';
        case 'Space':      return 'Space';
        case 'Escape':     return 'Esc';
        case 'Delete':     return 'Del';
        case 'Backspace':  return '⌫';
        case 'Win':        return '⊞ Win';
        default:           return part;
      }
    })
    .join(' + ');
}

export function coerceShortcuts(raw: unknown): ShortcutMap {
  const out: ShortcutMap = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const def of SHORTCUT_DEFS) {
    const value = (raw as Record<string, unknown>)[def.action];
    // Drop anything empty or OS-reserved (a previously-saved Alt+F4 would make
    // the shortcut close the app), falling back to that action's default.
    if (typeof value === 'string' && value && !isReservedCombo(value)) {
      out[def.action] = value;
    }
  }
  return out;
}

export function loadShortcuts(): ShortcutMap {
  try {
    return coerceShortcuts(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || 'null'));
  } catch (_) {
    return { ...DEFAULT_SHORTCUTS };
  }
}

/** Actions currently bound to the same combo as `action` (for conflict warnings). */
export function findConflicts(map: ShortcutMap, action: ShortcutAction): ShortcutAction[] {
  const combo = map[action];
  if (!combo) return [];
  return SHORTCUT_DEFS
    .map(d => d.action)
    .filter(a => a !== action && map[a] === combo);
}
