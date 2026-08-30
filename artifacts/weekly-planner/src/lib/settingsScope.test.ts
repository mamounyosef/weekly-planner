// Tests which settings cross between the PC and the phone.
//
// THE TEST THAT MATTERS MOST IS THE BORING ONE. Section 1 asserts that every
// key in `AppSettings` has been placed in exactly one scope. It will fail the
// day someone adds a setting and does not classify it — which is the whole
// point, because an unclassified setting fails silently in one of two ways:
// it never reaches the phone, so a feature half-works with no error anywhere;
// or it travels when it should not, and touching the PC changes which view the
// phone is showing. Both are the kind of bug that gets blamed on sync.
//
// Run with: npx tsx src/lib/settingsScope.test.ts

import assert from 'node:assert/strict';
import {
  applySharedSettings,
  assertEveryKeyScoped,
  DESK_ONLY_KEYS,
  scopeOf,
  SHARED_SETTING_KEYS,
  sharedSettingsOf,
} from './settingsScope';
import { DEVICE_SCOPED_KEYS } from './deviceSettings';
import { DEFAULT_SETTINGS } from './settingsSync';

function main() {
  console.log('--- 1. EVERY SETTING IS SCOPED, EXACTLY ONCE ---');
  {
    const { unscoped, duplicated } = assertEveryKeyScoped();
    assert.deepEqual(unscoped, [],
      `Unscoped settings would silently never sync, or silently overwrite a per-device choice: ${unscoped.join(', ')}`);
    assert.deepEqual(duplicated, [],
      `A setting in two scopes has no defined behaviour: ${duplicated.join(', ')}`);

    // And the lists themselves contain no repeats.
    for (const [label, keys] of [
      ['shared', SHARED_SETTING_KEYS],
      ['desk', DESK_ONLY_KEYS],
      ['device', DEVICE_SCOPED_KEYS],
    ] as const) {
      assert.equal(new Set(keys).size, keys.length, `${label} has a duplicate entry`);
    }
  }

  console.log('--- 2. THE SPLIT IS THE ONE THAT WAS AGREED ---');
  {
    // Named individually rather than counted, so a key silently changing scope
    // is a failure with a name attached.
    for (const key of ['weekStartsOn', 'timeFormat', 'categories', 'taskLists',
      'prayer', 'notifications', 'taskColor', 'autoRollRecurringTasks'] as const) {
      assert.equal(scopeOf(key), 'shared', `${key} describes the plan, so it must be shared`);
    }
    for (const key of ['calendarView', 'darkMode', 'interval', 'dayStartH', 'dayEndH',
      'customAnchor', 'eventColorStyle'] as const) {
      assert.equal(scopeOf(key), 'device',
        `${key} is how ONE device draws the planner, and must never be pushed from the other`);
    }
    for (const key of ['shortcuts', 'autoBackup', 'hardware', 'googleSyncEnabled',
      'gcalPushEnabled', 'widgetDarkPreset'] as const) {
      assert.equal(scopeOf(key), 'desk', `${key} is machinery only the PC has`);
    }
    assert.equal(scopeOf('somethingInvented'), 'unscoped', 'An unknown key is reported, not assumed');
  }

  console.log('--- 3. ONLY THE SHARED HALF IS EXTRACTED ---');
  {
    const shared = sharedSettingsOf(DEFAULT_SETTINGS) as Record<string, unknown>;
    assert.deepEqual(Object.keys(shared).sort(), [...SHARED_SETTING_KEYS].sort(),
      'Exactly the shared keys, no more');

    for (const key of [...DEVICE_SCOPED_KEYS, ...DESK_ONLY_KEYS]) {
      assert.equal(Object.hasOwn(shared, key), false, `${key} must not travel`);
    }

    // Values come through untouched, including the nested ones.
    assert.equal(shared.weekStartsOn, DEFAULT_SETTINGS.weekStartsOn);
    assert.deepEqual(shared.categories, DEFAULT_SETTINGS.categories);
    assert.deepEqual(shared.notifications, DEFAULT_SETTINGS.notifications);
  }

  console.log('--- 4. A PARTIAL SETTINGS OBJECT LOSES NOTHING IT HAD ---');
  {
    const partial = { weekStartsOn: 0, darkMode: true } as any;
    const shared = sharedSettingsOf(partial) as Record<string, unknown>;
    assert.deepEqual(Object.keys(shared), ['weekStartsOn'], 'Only what was present, and only if shared');

    assert.deepEqual(sharedSettingsOf({}), {}, 'An empty object yields an empty one');
    // A key explicitly set to undefined is absent, not a value to send.
    assert.deepEqual(sharedSettingsOf({ weekStartsOn: undefined } as any), {},
      'undefined is not a setting');
  }

  console.log('--- 5. INCOMING SETTINGS CANNOT TOUCH THIS DEVICE\'S OWN ---');
  {
    // The property that keeps a phone from being reshaped by the desk. The
    // incoming payload here is deliberately hostile: it carries every per-device
    // and desk key, all different from the local ones.
    const local = {
      ...DEFAULT_SETTINGS,
      calendarView: 'day',
      interval: 30,
      darkMode: false,
      dayStartH: 6,
      tasksPanelOpen: false,
      weekStartsOn: 1 as const,
    };
    const incoming = {
      ...DEFAULT_SETTINGS,
      calendarView: 'week',
      interval: 5,
      darkMode: true,
      dayStartH: 0,
      tasksPanelOpen: true,
      shortcuts: { invented: 'x' } as any,
      hardware: { invented: true } as any,
      weekStartsOn: 0 as const,
      timeFormat: '24h' as const,
    };

    const merged = applySharedSettings(local, incoming);

    assert.equal(merged.weekStartsOn, 0, 'A shared setting is adopted');
    assert.equal(merged.timeFormat, '24h', 'and so is another');

    assert.equal(merged.calendarView, 'day', 'The view this device is showing is untouched');
    assert.equal(merged.interval, 30, 'and its grid resolution');
    assert.equal(merged.darkMode, false, 'and its theme');
    assert.equal(merged.dayStartH, 6, 'and its visible hours');
    assert.equal(merged.tasksPanelOpen, false, 'and its panel');
    assert.deepEqual(merged.shortcuts, DEFAULT_SETTINGS.shortcuts, 'Desk machinery is ignored');
    assert.deepEqual(merged.hardware, DEFAULT_SETTINGS.hardware, 'including the desk controller');
  }

  console.log('--- 6. NOTHING TO DO RETURNS THE SAME OBJECT ---');
  {
    // Callers skip a write and a re-render on this, and the settings-fighting
    // bug this codebase already had came from writing when nothing had changed.
    const local = { ...DEFAULT_SETTINGS };
    assert.equal(applySharedSettings(local, undefined), local, 'No payload, no change');
    assert.equal(applySharedSettings(local, {}), local, 'An empty payload changes nothing');
    assert.equal(applySharedSettings(local, { ...DEFAULT_SETTINGS }), local,
      'An identical payload changes nothing');
    assert.equal(applySharedSettings(local, { calendarView: 'month', darkMode: !local.darkMode }), local,
      'A payload of only per-device keys changes nothing');

    const moved = applySharedSettings(local, { weekStartsOn: local.weekStartsOn === 0 ? 1 : 0 });
    assert.notEqual(moved, local, 'but a real change does produce a new object');
  }

  console.log('--- 7. DEEP VALUES COMPARE BY CONTENT, NOT IDENTITY ---');
  {
    // Categories and notification settings arrive as fresh objects on every
    // sync. Comparing by reference would report a change every time and write
    // the file on every poll — which is precisely the write storm already seen.
    const local = { ...DEFAULT_SETTINGS };
    const sameContent = {
      categories: JSON.parse(JSON.stringify(DEFAULT_SETTINGS.categories)),
      notifications: JSON.parse(JSON.stringify(DEFAULT_SETTINGS.notifications)),
      prayer: JSON.parse(JSON.stringify(DEFAULT_SETTINGS.prayer)),
    };
    assert.equal(applySharedSettings(local, sameContent), local,
      'Identical content that is a different object is not a change');

    const realChange = applySharedSettings(local, {
      categories: [{ id: 'c1', name: 'New', color: '#fff' }] as any,
    });
    assert.notEqual(realChange, local, 'but different content is');
    assert.equal((realChange.categories as any[])[0].name, 'New');
  }

  console.log('--- 8. HOSTILE AND DEGENERATE PAYLOADS ---');
  {
    const local = { ...DEFAULT_SETTINGS };
    for (const [label, payload] of [
      ['null-ish values', { weekStartsOn: null, categories: null }],
      ['wrong types', { weekStartsOn: 'Monday', categories: 'lots' }],
      ['prototype pollution', JSON.parse('{"__proto__":{"polluted":true},"weekStartsOn":0}')],
      ['extra unknown keys', { weekStartsOn: 0, invented: true, alsoInvented: [1, 2] }],
    ] as [string, any][]) {
      const merged = applySharedSettings(local, payload);
      assert.equal(Object.hasOwn(merged, 'invented'), false, `${label}: unknown keys are not adopted`);
      assert.equal(({} as any).polluted, undefined, `${label}: Object.prototype is intact`);
      // Scoping is this module's job; validating a value's shape is the
      // receiver's. What matters here is that nothing outside the shared list
      // moved, and nothing crashed.
      assert.equal(merged.calendarView, local.calendarView, `${label}: per-device keys held`);
      assert.deepEqual(merged.shortcuts, local.shortcuts, `${label}: desk keys held`);
    }
  }

  console.log('\nALL PASS (settings scope: shared vs device vs desk, and nothing unclassified)');
}

main();
