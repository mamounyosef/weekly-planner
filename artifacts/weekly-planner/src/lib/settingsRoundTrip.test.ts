// Tests settings crossing between the PC and the phone, end to end through the
// real service, the real HTTP handler and the real client transport.
//
// TWO PROPERTIES, AND THEY PULL AGAINST EACH OTHER
//
//   1. Shared settings MUST arrive. A category colour or a prayer method that
//      reaches only one device means the two show different plans for the same
//      day, which is worse than the feature not existing.
//
//   2. Per-device settings MUST NOT. `settings.json` holds this machine's view,
//      theme and hour range in the same file as the shared values, so the naive
//      version of (1) reshapes the phone every time the PC is touched — and
//      wipes the PC's layout every time the phone changes a category.
//
// The second is the one that needs the tests. It is invisible when it breaks:
// nothing errors, the file is simply wrong afterwards.
//
// Run with: npx tsx src/lib/settingsRoundTrip.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncService, handleSyncRequest, type UserSyncPaths } from '../../sync-service';
import { forgetWrittenBundle } from '../../sync-server';
import { createTransport } from './syncTransport';
import { applyLocalChange, emptyClientData, readClientStore, syncOnce } from './syncClient';
import { DEFAULT_SETTINGS } from './settingsSync';
import { applySharedSettings, SHARED_SETTING_KEYS } from './settingsScope';
import { SETTINGS_ENTITY } from './syncBridge';

const USER = 'mamoun';
const PHONE = 'android-settings';
let tmpRoot = '';

/** A settings file shaped the way the PC writes one: everything, in one object. */
const pcSettings = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_SETTINGS,
  // The PC's own layout, which must survive everything the phone does.
  calendarView: 'week',
  interval: 15,
  darkMode: true,
  dayStartH: 0,
  dayEndH: 24,
  tasksPanelOpen: true,
  ...over,
});

async function freshUser(label: string, settings: Record<string, unknown> = pcSettings()) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
    settingsPath: path.join(dbDir, 'settings.json'),
  };
  await fsp.writeFile(paths.dbPath, '{}', 'utf-8');
  await fsp.writeFile(paths.tasksPath, '{}', 'utf-8');
  await fsp.writeFile(paths.settingsPath!, JSON.stringify(settings, null, 2), 'utf-8');
  forgetWrittenBundle(dbDir);
  return paths;
}

function httpTransport(svc: any, paths: UserSyncPaths) {
  const fetchImpl = async (url: string, init: any) => {
    const action = new URL(url).pathname.replace(/^\/api\/sync/, '');
    const answer = await handleSyncRequest(svc, USER, paths, {
      action, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : {},
    });
    const text = JSON.stringify(answer.payload);
    return {
      ok: answer.status < 400, status: answer.status,
      headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text),
    };
  };
  return createTransport({ baseUrl: 'http://pc.local', session: 's', fetchImpl: fetchImpl as any });
}

/** The PC saves its whole settings file, exactly as `/api/settings` does. */
async function pcSaves(svc: any, paths: UserSyncPaths, settings: Record<string, unknown>) {
  await fsp.writeFile(paths.settingsPath!, JSON.stringify(settings, null, 2), 'utf-8');
  await svc.ingestFile(USER, paths, 'settings', settings);
}

const onDisk = async (paths: UserSyncPaths): Promise<any> =>
  JSON.parse(await fsp.readFile(paths.settingsPath!, 'utf-8'));

/** What the phone holds for the shared settings. */
const phoneSettings = (phone: any): Record<string, unknown> =>
  (readClientStore(phone, 'settings') as any)[SETTINGS_ENTITY] ?? {};

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'settings-rt-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. THE PHONE RECEIVES THE SHARED SETTINGS, AND ONLY THOSE ---');
  {
    const paths = await freshUser('receive');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    const phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const got = phoneSettings(phone);
    assert.deepEqual(Object.keys(got).sort(), [...SHARED_SETTING_KEYS].sort(),
      'Exactly the shared keys crossed');

    assert.equal(got.weekStartsOn, DEFAULT_SETTINGS.weekStartsOn, 'Week start arrived');
    assert.deepEqual(got.categories, DEFAULT_SETTINGS.categories, 'and the categories');
    assert.deepEqual(got.notifications, DEFAULT_SETTINGS.notifications, 'and notification rules');

    for (const key of ['calendarView', 'interval', 'darkMode', 'dayStartH', 'tasksPanelOpen',
      'shortcuts', 'hardware', 'gcalPushEnabled', 'autoBackup']) {
      assert.equal(Object.hasOwn(got, key), false, `${key} must not reach the phone`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. A CHANGE ON THE PC REACHES THE PHONE ---');
  {
    const paths = await freshUser('pc-change');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    await pcSaves(svc, paths, pcSettings({
      weekStartsOn: 0,
      timeFormat: '24h',
      categories: [{ id: 'uni', name: 'University', color: '#8C88FF' }],
    }));
    phone = (await syncOnce(phone, t, 2_000)).data;

    const got = phoneSettings(phone);
    assert.equal(got.weekStartsOn, 0, 'The new week start arrived');
    assert.equal(got.timeFormat, '24h', 'and the time format');
    assert.equal((got.categories as any[])[0].name, 'University', 'and the new category');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. A CHANGE ON THE PHONE REACHES THE PC, LEAVING ITS LAYOUT ALONE ---');
  {
    // The dangerous direction. The phone writes one shared key; every per-device
    // and desk key in settings.json must come through the rebuild untouched.
    const paths = await freshUser('phone-change');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const before = await onDisk(paths);

    phone = applyLocalChange(phone, {
      store: 'settings',
      entityId: SETTINGS_ENTITY,
      changes: { taskColor: '#ff0000', weekStartsOn: 6 },
      at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;

    const after = await onDisk(paths);
    assert.equal(after.taskColor, '#ff0000', 'The phone\'s change reached the PC file');
    assert.equal(after.weekStartsOn, 6, 'and so did the other one');

    // Everything the phone has no business touching.
    for (const key of ['calendarView', 'interval', 'darkMode', 'dayStartH', 'dayEndH',
      'tasksPanelOpen', 'tasksPanelWidth', 'eventColorStyle', 'sidebarStyle',
      'shortcuts', 'autoBackup', 'hardware', 'googleSyncEnabled', 'gcalPushEnabled',
      'widgetDarkPreset', 'stickyAllDayWidget']) {
      assert.deepEqual(after[key], before[key], `${key} survived the phone's write`);
    }
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(),
      'and no key was added or lost');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. THE TWO DEVICES KEEP THEIR OWN VIEWS ---');
  {
    // Stated as its own case because it is the thing the owner asked for by
    // name: the phone remembers the view it was left on, the PC remembers its
    // own, and neither ever moves the other.
    const paths = await freshUser('own-views', pcSettings({ calendarView: 'week', interval: 15 }));
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    // Even a per-device key pushed straight into the shared store — which the
    // phone's own settings screen will never do, but a bug might — must not move
    // the PC. The write-back filter is the guard, not the caller's good manners.
    phone = applyLocalChangeSafe(phone, { calendarView: 'day', interval: 30 });
    phone = (await syncOnce(phone, t, 2_000)).data;

    const after = await onDisk(paths);
    assert.equal(after.calendarView, 'week', 'The PC is still on its week view');
    assert.equal(after.interval, 15, 'at its own resolution');

    // And in the other direction: the PC switching views reaches no phone. Asked
    // of a fresh device, because the one above deliberately poisoned its own
    // copy a moment ago.
    await pcSaves(svc, paths, pcSettings({ calendarView: 'month', interval: 5 }));
    const fresh = (await syncOnce(emptyClientData('android-fresh'), t, 3_000)).data;
    const got = phoneSettings(fresh);
    assert.equal(Object.hasOwn(got, 'calendarView'), false, 'The phone was never told');
    assert.equal(Object.hasOwn(got, 'interval'), false, 'about either of them');
    assert.equal(got.weekStartsOn, DEFAULT_SETTINGS.weekStartsOn,
      'while the shared settings did arrive on it');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. DIFFERENT SETTINGS CHANGED AT ONCE BOTH SURVIVE ---');
  {
    // Per-field merge is the whole reason the sync engine works this way: two
    // devices changing different settings must not overwrite each other.
    const paths = await freshUser('both');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChangeSafe(phone, {}, { taskColor: '#00ff00' });
    await pcSaves(svc, paths, pcSettings({ timeFormat: '24h' }));
    phone = (await syncOnce(phone, t, 2_000)).data;

    const after = await onDisk(paths);
    assert.equal(after.taskColor, '#00ff00', "The phone's setting survived");
    assert.equal(after.timeFormat, '24h', "and so did the PC's");
    assert.equal(phoneSettings(phone).taskColor, '#00ff00', 'The phone agrees');
    assert.equal(phoneSettings(phone).timeFormat, '24h', 'on both');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. AN IDLE SYNC DOES NOT REWRITE THE SETTINGS FILE ---');
  {
    // settings.json is read by both windows on the PC. Rewriting it when nothing
    // changed would fire the db-stream and make them reload on every poll, which
    // is exactly the write storm this project has already lived through.
    const paths = await freshUser('quiet');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;
    await new Promise(r => setTimeout(r, 20));

    const before = (await fsp.stat(paths.settingsPath!)).mtimeMs;
    for (let i = 0; i < 8; i++) phone = (await syncOnce(phone, t, 2_000 + i)).data;
    const after = (await fsp.stat(paths.settingsPath!)).mtimeMs;

    assert.equal(before, after, 'Eight idle syncs left settings.json alone');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. A MISSING OR BROKEN SETTINGS FILE IS SURVIVED ---');
  {
    for (const [label, body] of [
      ['absent', null],
      ['empty', ''],
      ['truncated', '{"weekStartsOn":'],
      ['an array', '[1,2,3]'],
      ['null', 'null'],
    ] as [string, string | null][]) {
      const paths = await freshUser(`broken-${label.replace(/\W+/g, '-')}`);
      if (body === null) await fsp.rm(paths.settingsPath!, { force: true });
      else await fsp.writeFile(paths.settingsPath!, body, 'utf-8');

      const svc = createSyncService();
      const t = httpTransport(svc, paths);
      const out = await syncOnce(emptyClientData(PHONE), t, 1_000);
      assert.equal(out.error, undefined, `${label}: the sync still succeeded`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. THE SHARED HALF SURVIVES A RESTART ---');
  {
    const paths = await freshUser('restart');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChangeSafe(phone, {}, { taskColor: '#123456' });
    phone = (await syncOnce(phone, t, 2_000)).data;
    assert.equal((await onDisk(paths)).taskColor, '#123456', 'Written before the restart');

    const before = await onDisk(paths);
    const svc2 = createSyncService();
    const t2 = httpTransport(svc2, paths);
    phone = (await syncOnce(phone, t2, 3_000)).data;

    const after = await onDisk(paths);
    assert.deepEqual(after, before, 'A restart changed nothing in the file');
    assert.equal(phoneSettings(phone).taskColor, '#123456', 'and the phone still has it');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (settings: shared crosses, per-device never does, file preserved)');
}

/**
 * Change settings on the phone.
 *
 * `deviceChanges` are deliberately dropped rather than sent: on a real phone
 * they live in its own device settings and never enter the sync engine at all.
 * Passing them here proves that even if one leaked into a sync call, nothing on
 * the PC would move — the scope filter is the guard, not the caller's care.
 */
function applyLocalChangeSafe(
  phone: any,
  deviceChanges: Record<string, unknown>,
  sharedChanges: Record<string, unknown> = {},
) {
  const changes = { ...deviceChanges, ...sharedChanges };
  if (Object.keys(changes).length === 0) return phone;
  return applyLocalChange(phone, {
    store: 'settings', entityId: SETTINGS_ENTITY, changes, at: Date.now(),
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
