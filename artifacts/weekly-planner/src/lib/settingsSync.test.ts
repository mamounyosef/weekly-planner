// Tests app settings coercion, dark/light presets, theme palette resolution,
// clamping rules, local storage persistence, and broadcast synchronization.
// Run with: npx tsx src/lib/settingsSync.test.ts

import assert from 'node:assert/strict';
import {
  DARK_PRESETS,
  DARK_PRESET_IDS,
  DEFAULT_SETTINGS,
  LIGHT_PRESETS,
  LIGHT_PRESET_IDS,
  TASK_PANEL_MAX_W,
  TASK_PANEL_MIN_W,
  applyDarkModeClass,
  broadcastSettingsChange,
  coerceSettings,
  loadSettingsLocal,
  saveSettingsLocal,
  subscribeSettingsChange,
  themePalette,
  type AppSettings,
  type DarkPreset,
  type LightPreset,
} from './settingsSync';

console.log('--- 1. SETTINGS DEFAULTS & PRESETS ---');
assert.equal(DEFAULT_SETTINGS.darkMode, true);
assert.equal(DEFAULT_SETTINGS.interval, 15);
assert.equal(DEFAULT_SETTINGS.weekStartsOn, 1);
assert.equal(DEFAULT_SETTINGS.dayStartH, 0);
assert.equal(DEFAULT_SETTINGS.dayEndH, 24);
assert.equal(DEFAULT_SETTINGS.timeFormat, '12h');
assert.equal(DEFAULT_SETTINGS.darkPreset, 'pure-black');
assert.equal(DEFAULT_SETTINGS.lightPreset, 'clean-white');
assert.equal(DEFAULT_SETTINGS.tasksPanelOpen, true);
assert.equal(DEFAULT_SETTINGS.tasksPanelWidth, 340);
assert.equal(DEFAULT_SETTINGS.autoRollRecurringTasks, true);

// Verify all preset IDs match lists
assert.equal(DARK_PRESETS.length, DARK_PRESET_IDS.length);
assert.equal(LIGHT_PRESETS.length, LIGHT_PRESET_IDS.length);
assert.ok(DARK_PRESETS.length >= 20, 'At least 20 dark presets');
assert.ok(LIGHT_PRESETS.length >= 20, 'At least 20 light presets');

for (const p of DARK_PRESETS) {
  assert.ok(DARK_PRESET_IDS.includes(p.id));
  assert.ok(p.rootBg && p.cardBg && p.surfaceBg && p.surfaceBdr);
}

for (const p of LIGHT_PRESETS) {
  assert.ok(LIGHT_PRESET_IDS.includes(p.id));
  assert.ok(p.rootBg && p.cardBg && p.surfaceBg && p.surfaceBdr);
}

console.log('--- 2. THEME PALETTE RESOLUTION ---');
const darkPal = themePalette(true, 'midnight', 'clean-white');
assert.equal(darkPal.rootBg, '#0b0f19');
assert.equal(darkPal.cardBg, '#121824');

const lightPal = themePalette(false, 'pure-black', 'warm-ivory');
assert.equal(lightPal.rootBg, '#faf8f5');
assert.equal(lightPal.cardBg, '#fffefa');

// Fallback for invalid preset IDs
const invalidDark = themePalette(true, 'unknown-preset' as DarkPreset, 'clean-white');
assert.deepEqual(invalidDark, DARK_PRESETS[0]);

const invalidLight = themePalette(false, 'pure-black', 'unknown-preset' as LightPreset);
assert.deepEqual(invalidLight, LIGHT_PRESETS[0]);

console.log('--- 3. COERCE SETTINGS: BOUNDARIES & CLAMPING ---');
// Null / undefined / invalid
assert.deepEqual(coerceSettings(null), DEFAULT_SETTINGS);
assert.deepEqual(coerceSettings(undefined), DEFAULT_SETTINGS);
assert.deepEqual(coerceSettings([]), DEFAULT_SETTINGS);
assert.deepEqual(coerceSettings('invalid'), DEFAULT_SETTINGS);

// Day start & end bounds clamping
const normalHours = coerceSettings({ dayStartH: 8, dayEndH: 18 });
assert.equal(normalHours.dayStartH, 8);
assert.equal(normalHours.dayEndH, 18);

const clampedHours = coerceSettings({ dayStartH: -5, dayEndH: 60 });
assert.equal(clampedHours.dayStartH, 0);
assert.equal(clampedHours.dayEndH, 48);

const reversedHours = coerceSettings({ dayStartH: 20, dayEndH: 10 });
assert.equal(reversedHours.dayStartH, 20);
assert.equal(reversedHours.dayEndH, 21, 'dayEndH must adjust to dayStartH + 1 when less than or equal');

const equalHours = coerceSettings({ dayStartH: 15, dayEndH: 15 });
assert.equal(equalHours.dayStartH, 15);
assert.equal(equalHours.dayEndH, 16);

// Custom days before / after clamping [-14, 14]
const customDays = coerceSettings({ customDaysBefore: -25, customDaysAfter: 30 });
assert.equal(customDays.customDaysBefore, -14);
assert.equal(customDays.customDaysAfter, 14);

// Tasks panel width clamping [260, 520]
const panelMin = coerceSettings({ tasksPanelWidth: 100 });
assert.equal(panelMin.tasksPanelWidth, TASK_PANEL_MIN_W);

const panelMax = coerceSettings({ tasksPanelWidth: 900 });
assert.equal(panelMax.tasksPanelWidth, TASK_PANEL_MAX_W);

// Interval validation: only 5, 15, 30, 60 allowed
assert.equal(coerceSettings({ interval: 5 }).interval, 5);
assert.equal(coerceSettings({ interval: 30 }).interval, 30);
assert.equal(coerceSettings({ interval: 45 }).interval, 15, 'Invalid interval falls back to default 15');

// WeekStartsOn validation: 0..6
assert.equal(coerceSettings({ weekStartsOn: 0 }).weekStartsOn, 0);
assert.equal(coerceSettings({ weekStartsOn: 6 }).weekStartsOn, 6);
assert.equal(coerceSettings({ weekStartsOn: 7 }).weekStartsOn, 1, 'Invalid weekStartsOn falls back to default');

// Time format: '12h' | '24h'
assert.equal(coerceSettings({ timeFormat: '24h' }).timeFormat, '24h');
assert.equal(coerceSettings({ timeFormat: 'military' }).timeFormat, '12h');

// Task color hex validation
assert.equal(coerceSettings({ taskColor: '#34d399' }).taskColor, '#34d399');
assert.equal(coerceSettings({ taskColor: 'not-a-color' }).taskColor, DEFAULT_SETTINGS.taskColor);

// Task checkbox shape: circle | square
assert.equal(coerceSettings({ taskCheckboxShape: 'square' }).taskCheckboxShape, 'square');
assert.equal(coerceSettings({ taskCheckboxShape: 'diamond' }).taskCheckboxShape, 'circle');

// Canonical filter ordering
const outOfOrderFilters = coerceSettings({ taskFilters: ['completed', 'today', 'general', 'upcoming'] });
assert.deepEqual(outOfOrderFilters.taskFilters, ['today', 'upcoming', 'general', 'completed'], 'taskFilters must be sorted canonically');

// Auto backup object coercion
const customBackup = coerceSettings({ autoBackup: { enabled: false, intervalHours: 12, keep: 100 } });
assert.deepEqual(customBackup.autoBackup, { enabled: false, intervalHours: 12, keep: 100 });

const badBackup = coerceSettings({ autoBackup: { enabled: 'yes', intervalHours: '24', keep: null } });
assert.deepEqual(badBackup.autoBackup, { enabled: true, intervalHours: 24, keep: 50 });

console.log('--- 4. LOCAL STORAGE & BROADCAST SYNC ---');
const storageMap = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => storageMap.set(k, v),
  removeItem: (k: string) => storageMap.delete(k),
  clear: () => storageMap.clear(),
};
(globalThis as any).localStorage = fakeLocalStorage;

// Save and load
const modifiedSettings: AppSettings = { ...DEFAULT_SETTINGS, timeFormat: '24h', dayStartH: 6 };
saveSettingsLocal(modifiedSettings);
assert.ok(storageMap.has('planner-app-settings-v2'));

const loaded = loadSettingsLocal();
assert.equal(loaded.timeFormat, '24h');
assert.equal(loaded.dayStartH, 6);

// Corrupted local storage JSON recovers to defaults
storageMap.set('planner-app-settings-v2', 'not valid json {{{');
const recovered = loadSettingsLocal();
assert.equal(recovered.timeFormat, DEFAULT_SETTINGS.timeFormat);

// Broadcast settings change with mock fetch
let fetchedUrl = '';
let fetchedBody = '';
(globalThis as any).fetch = async (url: string, opts: any) => {
  fetchedUrl = url;
  fetchedBody = opts.body;
  return { ok: true, json: async () => ({}) };
};

broadcastSettingsChange(modifiedSettings);
assert.equal(fetchedUrl, '/api/settings');
const sentJson = JSON.parse(fetchedBody);
assert.equal(sentJson.timeFormat, '24h');

// Echo guard test: calling broadcastSettingsChange with identical content is a no-op
fetchedUrl = '';
broadcastSettingsChange(modifiedSettings);
assert.equal(fetchedUrl, '', 'Echo guard must prevent duplicate POST if settings have not changed');

console.log('\nALL PASS (settingsSync)');
