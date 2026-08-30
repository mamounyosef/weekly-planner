// Tests that prayer times and the record of which prayers were prayed reach the
// phone, and survive being changed on either device.
//
// WHY THE TIMETABLE SYNCS AT ALL
// It is a cache of a public timetable, not anyone's data, so syncing it looks
// like waste until you ask where prayer times are actually wanted: away from the
// desk, often with no signal. An app that needs the internet to say when Maghrib
// is has missed the point of being on a phone. So the month cache travels with
// everything else and the phone answers offline.
//
// The done-marks are the opposite kind of thing: small, personal, and edited
// from both devices within the same minute. They merge as a SET, so two devices
// ticking different prayers on the same day both stick.
//
// Run with: npx tsx src/lib/prayerSync.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncService, handleSyncRequest, type UserSyncPaths } from '../../sync-service';
import { forgetWrittenBundle } from '../../sync-server';
import { createTransport } from './syncTransport';
import { applyLocalChange, emptyClientData, readClientStore, syncOnce } from './syncClient';
import { buildPrayerDay, coercePrayerSettings, prayerQueryKey } from './prayerTimes';

const USER = 'mamoun';
const PHONE = 'android-prayer';
let tmpRoot = '';

/** A month cache shaped exactly the way the PC writes one. */
const MONTH = {
  'Amman|Jordan|23|0|2026-8': {
    fetchedAt: 1_788_104_540_101,
    days: {
      '2026-08-30': {
        fajr: '04:41', sunrise: '06:09', dhuhr: '12:39',
        asr: '16:12', maghrib: '19:07', isha: '20:29',
      },
      '2026-08-31': {
        fajr: '04:42', sunrise: '06:10', dhuhr: '12:39',
        asr: '16:11', maghrib: '19:06', isha: '20:27',
      },
    },
  },
};

async function freshUser(label: string) {
  const dbDir = path.join(tmpRoot, label);
  await fsp.mkdir(dbDir, { recursive: true });
  const paths: UserSyncPaths = {
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
    settingsPath: path.join(dbDir, 'settings.json'),
    prayerDonePath: path.join(dbDir, 'prayer-done.json'),
    prayerTimesPath: path.join(dbDir, 'prayer-times.json'),
  };
  await fsp.writeFile(paths.dbPath, '{}', 'utf-8');
  await fsp.writeFile(paths.tasksPath, '{}', 'utf-8');
  await fsp.writeFile(paths.settingsPath!, '{}', 'utf-8');
  await fsp.writeFile(paths.prayerDonePath!, '{}', 'utf-8');
  await fsp.writeFile(paths.prayerTimesPath!, JSON.stringify(MONTH, null, 2), 'utf-8');
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

const readJson = async (f: string): Promise<any> => JSON.parse(await fsp.readFile(f, 'utf-8'));

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'prayer-sync-test-'));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. THE TIMETABLE REACHES THE PHONE ---');
  {
    const paths = await freshUser('times');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    const phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const months = readClientStore(phone, 'prayerTimes') as any;
    const key = 'Amman|Jordan|23|0|2026-8';
    assert.ok(months[key], 'The month arrived');
    assert.equal(months[key].days['2026-08-30'].maghrib, '19:07', 'with its times intact');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. THE PHONE CAN BUILD A DAY FROM WHAT IT HAS ---');
  {
    // The end-to-end point of syncing the cache at all: the phone must be able
    // to answer "when is Maghrib" from its own copy, with nothing to ask.
    const paths = await freshUser('build');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    const phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const settings = coercePrayerSettings({
      enabled: true, city: 'Amman', country: 'Jordan', method: 23, school: 0,
    });
    // The key the phone rebuilds must match the one the PC wrote, exactly.
    const key = `${prayerQueryKey(settings)}|2026-8`;
    assert.equal(key, 'Amman|Jordan|23|0|2026-8',
      'The cache key is rebuilt character for character');

    const months = readClientStore(phone, 'prayerTimes') as any;
    const day = buildPrayerDay('2026-08-30', months[key].days['2026-08-30'], settings);
    assert.ok(day.length >= 5, 'A day of prayers is produced');

    const maghrib = day.find(p => p.key === 'maghrib');
    assert.ok(maghrib, 'including Maghrib');
    assert.equal(maghrib!.time, '19:07');
    // Sorted by time, so the screen can take them in order.
    for (let i = 1; i < day.length; i += 1) {
      assert.ok(day[i].minutes >= day[i - 1].minutes, 'in time order');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. TICKING A PRAYER ON THE PHONE REACHES THE PC ---');
  {
    const paths = await freshUser('tick');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChange(phone, {
      store: 'prayerDone',
      entityId: '2026-08-30',
      changes: { done: ['fajr'] },
      at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;

    const onPc = await readJson(paths.prayerDonePath!);
    assert.deepEqual(onPc['2026-08-30'].done, ['fajr'], 'The PC file records it');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. TWO DEVICES TICKING DIFFERENT PRAYERS BOTH STICK ---');
  {
    // The reason `prayerDone.done` is a set field. Whole-value merge would lose
    // one of these, and losing a prayer you marked is not recoverable by
    // looking at the screen: it simply appears you never marked it.
    const paths = await freshUser('both');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    // The phone marks Fajr while offline.
    phone = applyLocalChange(phone, {
      store: 'prayerDone', entityId: '2026-08-30', changes: { done: ['fajr'] }, at: 2_000,
    });

    // Meanwhile the PC marks Dhuhr, writing its whole file as it always does.
    await fsp.writeFile(
      paths.prayerDonePath!,
      JSON.stringify({ '2026-08-30': { done: ['dhuhr'] } }, null, 2),
      'utf-8',
    );
    await svc.refresh(USER, paths);

    phone = (await syncOnce(phone, t, 3_000)).data;

    const onPc = await readJson(paths.prayerDonePath!);
    assert.deepEqual([...onPc['2026-08-30'].done].sort(), ['dhuhr', 'fajr'],
      'Both marks survived on the PC');

    const onPhone = (readClientStore(phone, 'prayerDone') as any)['2026-08-30'];
    assert.deepEqual([...onPhone.done].sort(), ['dhuhr', 'fajr'], 'and on the phone');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. UN-TICKING STILL WORKS ---');
  {
    // Add-wins sets make removal the interesting case: it has to be possible to
    // take a mark back, or a mis-tap is permanent.
    const paths = await freshUser('untick');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    phone = applyLocalChange(phone, {
      store: 'prayerDone', entityId: '2026-08-30', changes: { done: ['fajr', 'dhuhr'] }, at: 2_000,
    });
    phone = (await syncOnce(phone, t, 2_100)).data;
    assert.equal((await readJson(paths.prayerDonePath!))['2026-08-30'].done.length, 2);

    phone = applyLocalChange(phone, {
      store: 'prayerDone', entityId: '2026-08-30', changes: { done: ['dhuhr'] }, at: 3_000,
    });
    phone = (await syncOnce(phone, t, 3_100)).data;

    assert.deepEqual((await readJson(paths.prayerDonePath!))['2026-08-30'].done, ['dhuhr'],
      'The mark was taken back');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. A REFRESHED TIMETABLE REACHES THE PHONE ---');
  {
    // The PC re-fetches the month when it expires. The phone must take the new
    // times rather than holding the old ones for ever.
    const paths = await freshUser('refresh');
    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    let phone = (await syncOnce(emptyClientData(PHONE), t, 1_000)).data;

    const updated = JSON.parse(JSON.stringify(MONTH));
    updated['Amman|Jordan|23|0|2026-8'].days['2026-08-30'].maghrib = '19:08';
    updated['Amman|Jordan|23|0|2026-8'].fetchedAt = 1_788_204_540_101;
    await fsp.writeFile(paths.prayerTimesPath!, JSON.stringify(updated, null, 2), 'utf-8');
    await svc.refresh(USER, paths);

    phone = (await syncOnce(phone, t, 2_000)).data;
    const months = readClientStore(phone, 'prayerTimes') as any;
    assert.equal(months['Amman|Jordan|23|0|2026-8'].days['2026-08-30'].maghrib, '19:08',
      'The corrected time arrived');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. A MISSING TIMETABLE IS NOT AN ERROR ---');
  {
    // A planner with prayer times switched off has no such file, and a phone
    // syncing against it must be entirely unbothered.
    const paths = await freshUser('absent');
    await fsp.rm(paths.prayerTimesPath!, { force: true });
    await fsp.rm(paths.prayerDonePath!, { force: true });

    const svc = createSyncService();
    const t = httpTransport(svc, paths);
    const out = await syncOnce(emptyClientData(PHONE), t, 1_000);
    assert.equal(out.error, undefined, 'The sync succeeded');
    assert.deepEqual(readClientStore(out.data, 'prayerTimes'), {}, 'with no times');
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PASS (prayer: timetable offline, marks merge as a set)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
