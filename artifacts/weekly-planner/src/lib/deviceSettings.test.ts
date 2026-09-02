// Tests device settings coercion, phone/tablet/desktop seeding, zoom clamping, and theme presets.
// Run with: npx tsx src/lib/deviceSettings.test.ts

import assert from 'node:assert/strict';
import {
  APP_ZOOM_MAX,
  APP_ZOOM_MIN,
  DEVICE_SCOPED_KEYS,
  coerceDeviceSettings,
  getFilterViewKey,
  seedDeviceSettings,
  type DeviceSettings,
} from './deviceSettings';
import {
  DARK_PRESETS,
  LIGHT_PRESETS,
  type AppSettings,
} from './settingsSync';
import { DEFAULT_NOTIFICATION_SETTINGS } from './notifications';

import { DEFAULT_CATEGORIES } from './categories';
import { DEFAULT_TASK_LISTS } from './taskLists';
import { DEFAULT_SHORTCUTS } from './shortcuts';
import { DEFAULT_HARDWARE_SETTINGS } from './hardwareController';
import { DEFAULT_PRAYER_SETTINGS } from './prayerTimes';
import { cn } from './utils';

const mockBase: AppSettings = {
  calendarView: 'week',
  customDaysBefore: 0,
  customDaysAfter: 0,
  customAnchor: 'day',
  mobileSwipeViewSwitch: true,
  interval: 15,
  tasksPanelOpen: true,
  tasksPanelWidth: 320,
  showTaskRow: true,
  stickyAllDayMain: true,
  stickyTasksMain: true,
  darkMode: true,
  darkPreset: 'midnight',
  lightPreset: 'clean-white',
  eventColorStyle: 'tinted',
  sidebarStyle: 'subtle-glow',
  dayStartH: 8,
  dayEndH: 22,
  weekStartsOn: 1,
  showWeekNumbers: false,
  timeFormat: '24h',
  autoSave: true,
  showTimeIndicator: true,
  eventCategories: DEFAULT_CATEGORIES,
  taskLists: DEFAULT_TASK_LISTS,
  shortcuts: DEFAULT_SHORTCUTS,
  hardware: DEFAULT_HARDWARE_SETTINGS,
  prayer: DEFAULT_PRAYER_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
};

console.log('--- 1. FILTER VIEW KEY MAPPING ---');
assert.equal(getFilterViewKey('day'), 'day');
assert.equal(getFilterViewKey('week'), 'week');
assert.equal(getFilterViewKey('month'), 'month');
assert.equal(getFilterViewKey('year'), 'year');
assert.equal(getFilterViewKey('custom'), 'week', 'Custom view shares week category filter');
assert.equal(getFilterViewKey(null), 'week');
assert.equal(getFilterViewKey(undefined), 'week');

console.log('--- 2. SEED DEVICE SETTINGS BY KIND ---');
const phoneSeed = seedDeviceSettings(mockBase, 'phone');
assert.equal(phoneSeed.calendarView, 'day', 'Phone defaults to Day view');
assert.equal(phoneSeed.interval, 30, 'Phone defaults to 30 min interval');
assert.equal(phoneSeed.tasksPanelOpen, false, 'Phone defaults to closed tasks panel');
assert.equal(phoneSeed.appZoom, 1);

const tabletSeed = seedDeviceSettings(mockBase, 'tablet');
assert.equal(tabletSeed.calendarView, 'week', 'Tablet defaults to Week view');
assert.equal(tabletSeed.tasksPanelOpen, false);

const desktopSeed = seedDeviceSettings(mockBase, 'desktop');
assert.equal(desktopSeed.calendarView, 'week');
assert.equal(desktopSeed.tasksPanelOpen, true, 'Desktop inherits base panel open');

console.log('--- 3. COERCE DEVICE SETTINGS & CLAMPING ---');
// Null / undefined -> seed
assert.deepEqual(coerceDeviceSettings(null, mockBase, 'desktop'), desktopSeed);
assert.deepEqual(coerceDeviceSettings(undefined, mockBase, 'desktop'), desktopSeed);

// Custom valid device settings
const valid: Partial<DeviceSettings> = {
  calendarView: 'month',
  customDaysBefore: 3,
  customDaysAfter: 5,
  customAnchor: 'week',
  interval: 60,
  tasksPanelOpen: false,
  tasksPanelWidth: 400,
  appZoom: 1.25,
  mobileContentZoom: 0.9,
  mobileUiZoom: 1.1,
  analysisTab: 'month',
  mobileTab: 'focus',
  dayStartH: 6,
  dayEndH: 23,
  hiddenCategoriesByView: {
    day: ['c1'],
    week: ['c2'],
    month: [],
    year: ['c3'],
  },
};
const coerced = coerceDeviceSettings(valid, mockBase, 'desktop');
assert.equal(coerced.calendarView, 'month');
assert.equal(coerced.customDaysBefore, 3);
assert.equal(coerced.customDaysAfter, 5);
assert.equal(coerced.customAnchor, 'week');
assert.equal(coerced.interval, 60);
assert.equal(coerced.tasksPanelWidth, 400);
assert.equal(coerced.appZoom, 1.25);
assert.equal(coerced.mobileContentZoom, 0.9);
assert.equal(coerced.mobileUiZoom, 1.1);
assert.equal(coerced.analysisTab, 'month');
assert.equal(coerced.mobileTab, 'focus');
assert.deepEqual(coerced.hiddenCategoriesByView.day, ['c1']);

// Zoom clamping [0.5, 2.0] in 0.05 increments
assert.equal(coerceDeviceSettings({ appZoom: 0.1 }, mockBase, 'desktop').appZoom, APP_ZOOM_MIN);
assert.equal(coerceDeviceSettings({ appZoom: 5.0 }, mockBase, 'desktop').appZoom, APP_ZOOM_MAX);
assert.equal(coerceDeviceSettings({ appZoom: 1.23 }, mockBase, 'desktop').appZoom, 1.25);

// Tasks panel width clamping [260, 520]
assert.equal(coerceDeviceSettings({ tasksPanelWidth: 100 }, mockBase, 'desktop').tasksPanelWidth, 260);
assert.equal(coerceDeviceSettings({ tasksPanelWidth: 999 }, mockBase, 'desktop').tasksPanelWidth, 520);

// Day start & end bounds
const crossedHours = coerceDeviceSettings({ dayStartH: 18, dayEndH: 10 }, mockBase, 'desktop');
assert.equal(crossedHours.dayStartH, 18);
assert.equal(crossedHours.dayEndH, 19, 'dayEndH must be strictly greater than dayStartH');

// Custom days bounds [-14, 14]
assert.equal(coerceDeviceSettings({ customDaysBefore: -50 }, mockBase, 'desktop').customDaysBefore, -14);
assert.equal(coerceDeviceSettings({ customDaysAfter: 50 }, mockBase, 'desktop').customDaysAfter, 14);

console.log('--- 4. THEME PRESETS & PALETTES ---');
assert.ok(DARK_PRESETS.length >= 20, 'At least 20 dark presets available');
assert.ok(LIGHT_PRESETS.length >= 20, 'At least 20 light presets available');

for (const p of DARK_PRESETS) {
  assert.ok(p.id, 'Dark preset has id');
  assert.ok(p.label, 'Dark preset has label');
  assert.ok(p.rootBg.startsWith('#'), `Preset ${p.id} has hex rootBg`);
  assert.ok(p.cardBg.startsWith('#'), `Preset ${p.id} has hex cardBg`);
}

for (const p of LIGHT_PRESETS) {
  assert.ok(p.id, 'Light preset has id');
  assert.ok(p.label, 'Light preset has label');
  assert.ok(p.rootBg.startsWith('#'), `Preset ${p.id} has hex rootBg`);
  assert.ok(p.cardBg.startsWith('#'), `Preset ${p.id} has hex cardBg`);
}

console.log('--- 5. CN (TAILWIND UTILITY) ---');
assert.equal(cn('p-4', 'p-2'), 'p-2', 'Tailwind merge resolves conflicting padding');
assert.equal(cn('text-red-500', false && 'text-blue-500', 'font-bold'), 'text-red-500 font-bold');
assert.equal(cn('bg-white', undefined, null, 'shadow-md'), 'bg-white shadow-md');

console.log('--- 6. HOW THE FOCUS RANGE IS READ, PER DEVICE ---');
{
  // "Week" on the analysis screen means either the week you are in or the last
  // seven days. The two disagree by up to six days, so which one is meant has
  // to survive a reload rather than resetting every time the screen opens.
  for (const kind of ['desktop', 'tablet', 'phone'] as const) {
    const seed = seedDeviceSettings(mockBase, kind);
    assert.equal(seed.analysisRangeMode, 'calendar', `${kind} starts on the older reading`);
  }

  assert.equal(
    coerceDeviceSettings({ analysisRangeMode: 'rolling' }, mockBase, 'desktop').analysisRangeMode,
    'rolling',
    'a stored choice is honoured',
  );

  // Anything unrecognised, including a value written by a newer build, falls
  // back rather than leaving the screen with a mode it cannot draw.
  for (const raw of ['Rolling', 'last7', '', 0, 1, null, {}, []]) {
    assert.equal(
      coerceDeviceSettings({ analysisRangeMode: raw } as never, mockBase, 'desktop').analysisRangeMode,
      'calendar',
      `${JSON.stringify(raw)} is not a mode`,
    );
  }

  // Absent means untouched: an old device blob must not wipe the seeded value.
  assert.equal(
    coerceDeviceSettings({ analysisTab: 'year' }, mockBase, 'desktop').analysisRangeMode,
    'calendar',
  );

  // It round trips through storage with the rest of the blob.
  const stored = coerceDeviceSettings(
    { analysisTab: 'month', analysisRangeMode: 'rolling' }, mockBase, 'desktop',
  );
  assert.deepEqual(
    coerceDeviceSettings(JSON.parse(JSON.stringify(stored)), mockBase, 'desktop'),
    stored,
    'settled after one pass',
  );
}

console.log('\nALL PASS (deviceSettings & presets)');
