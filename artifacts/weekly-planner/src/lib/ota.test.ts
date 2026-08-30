// Tests the over-the-air update server: manifest building, update selection,
// the multipart encoding the Expo protocol requires, and the path checks that
// stop the updater from becoming a way to read the planner's own files.
//
// The traversal cases are the sharp end. These routes answer UNAUTHENTICATED
// requests — the phone has no session when it checks for an update — on a server
// reachable from the public internet.
//
// Run with: npx tsx src/lib/ota.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  base64Url,
  buildManifest,
  contentTypeFor,
  encodeMultipart,
  makeBoundary,
  makeFsDeps,
  newestFolder,
  resolveUpdate,
  safeAssetPath,
  safePlatform,
  safeRuntimeVersion,
  sha256ToUuid,
  type ExpoMetadata,
  type OtaDeps,
} from '../../ota-server';

const ORIGIN = 'https://mamoun.example.ts.net';

const METADATA: ExpoMetadata = {
  version: 0,
  bundler: 'metro',
  fileMetadata: {
    android: {
      bundle: '_expo/static/js/android/index-abc.hbc',
      assets: [
        { path: 'assets/icon.png', ext: 'png' },
        { path: 'assets/font.ttf', ext: 'ttf' },
      ],
    },
  },
};

/** In-memory files, so manifest building needs no disk. */
function fakeReader(files: Record<string, string>) {
  return async (abs: string) => {
    const key = Object.keys(files).find(k => abs.split(path.sep).join('/').endsWith(k));
    if (!key) throw new Error(`missing ${abs}`);
    return Buffer.from(files[key], 'utf-8');
  };
}

const FILES = {
  '_expo/static/js/android/index-abc.hbc': 'BUNDLE-CONTENT',
  'assets/icon.png': 'PNG-CONTENT',
  'assets/font.ttf': 'FONT-CONTENT',
};

async function main() {
  console.log('--- 1. ENCODING HELPERS ---');
  {
    assert.equal(base64Url('ab+/cd=='), 'ab-_cd', 'base64url swaps + / and drops padding');
    assert.equal(base64Url('plain'), 'plain');
    assert.equal(base64Url(''), '');

    const uuid = sha256ToUuid('a'.repeat(64));
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'A content hash is reshaped into a real UUID');
    assert.equal(sha256ToUuid('ABCDEF0123456789'.repeat(4)), 'abcdef01-2345-6789-abcd-ef0123456789',
      'and it is case-insensitive');
    assert.throws(() => sha256ToUuid('short'), /too short/);
  }

  console.log('--- 2. CONTENT TYPES ---');
  {
    assert.equal(contentTypeFor('png'), 'image/png');
    assert.equal(contentTypeFor('.png'), 'image/png', 'A leading dot is fine');
    assert.equal(contentTypeFor('PNG'), 'image/png', 'and so is upper case');
    assert.equal(contentTypeFor('hbc'), 'application/javascript', 'Hermes bytecode is a bundle');
    assert.equal(contentTypeFor('ttf'), 'font/ttf');
    assert.equal(contentTypeFor('json'), 'application/json');
    assert.equal(contentTypeFor('mp3'), 'audio/mpeg');
    assert.equal(contentTypeFor('wat'), 'application/octet-stream', 'Unknown falls back safely');
    assert.equal(contentTypeFor(null), 'application/octet-stream');
    assert.equal(contentTypeFor(undefined), 'application/octet-stream');
    assert.equal(contentTypeFor(''), 'application/octet-stream');
  }

  console.log('--- 3. VALIDATION OF WHAT THE PHONE SENDS ---');
  {
    assert.equal(safePlatform('android'), 'android');
    assert.equal(safePlatform('ios'), 'ios');
    for (const bad of ['web', 'ANDROID', '', null, undefined, 42, {}]) {
      assert.equal(safePlatform(bad), null, `platform ${JSON.stringify(bad)} refused`);
    }

    assert.equal(safeRuntimeVersion('1.0.0'), '1.0.0');
    assert.equal(safeRuntimeVersion('  1.0.0  '), '1.0.0', 'trimmed');
    assert.equal(safeRuntimeVersion('exposdk:57.0.0'), null, 'A colon is not allowed in a path part');
    for (const bad of [
      '', '   ', '.', '..', '../../etc', 'a/b', 'a\\b', 'x'.repeat(65),
      'ver sion', 'v\0', null, undefined, 42, {}, [],
    ]) {
      assert.equal(safeRuntimeVersion(bad), null, `runtime ${JSON.stringify(bad)} refused`);
    }
  }

  console.log('--- 4. ASSET PATHS CANNOT ESCAPE THE UPDATE FOLDER ---');
  {
    const root = path.resolve('/tmp/ota/1.0.0/20260829');
    assert.ok(safeAssetPath(root, 'assets/icon.png'), 'A normal asset resolves');
    assert.ok(safeAssetPath(root, '_expo/static/js/android/index.hbc'), 'as does a nested bundle');
    assert.ok(safeAssetPath(root, 'a/b/../c.png'), 'and a path that stays inside after normalising');

    const hostile = [
      '../../../database/users/mamoun/database.json',
      '../../vapid.json',
      '..',
      '../',
      '..\\..\\secrets.json',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'assets/../../../outside.txt',
      'x\0.png',
      '',
      null, undefined, 42, {}, [],
    ];
    for (const attempt of hostile) {
      assert.equal(safeAssetPath(root, attempt as any), null,
        `Must refuse asset path: ${JSON.stringify(attempt)}`);
    }
  }

  console.log('--- 5. NEWEST FOLDER IS CHOSEN BY NAME, NOT BY TIMESTAMP ---');
  {
    // Sorting by mtime would reshuffle the whole history the moment a backup or
    // a file copy touched an old folder.
    assert.equal(newestFolder(['20260101-000000', '20260829-120000', '20260501-000000']),
      '20260829-120000');
    assert.equal(newestFolder(['a']), 'a');
    assert.equal(newestFolder([]), null, 'Nothing published yet');
    assert.equal(newestFolder(['../evil', 'a/b']), null, 'Unsafe names are not candidates');
    assert.equal(newestFolder(['ok-1', '../evil']), 'ok-1', 'and are filtered out of a mixed list');
  }

  console.log('--- 6. A MANIFEST DESCRIBES EVERY FILE IN THE UPDATE ---');
  {
    const manifest = await buildManifest({
      updateDir: '/updates/1.0.0/20260829',
      runtimeVersion: '1.0.0',
      platform: 'android',
      metadata: METADATA,
      origin: ORIGIN,
      createdAt: '2026-08-29T12:00:00.000Z',
      readFile: fakeReader(FILES),
    });

    assert.match(manifest.id, /^[0-9a-f-]{36}$/);
    assert.equal(manifest.runtimeVersion, '1.0.0');
    assert.equal(manifest.createdAt, '2026-08-29T12:00:00.000Z');
    assert.equal(manifest.assets.length, 2);

    assert.equal(manifest.launchAsset.contentType, 'application/javascript');
    assert.equal(manifest.launchAsset.fileExtension, '.bundle',
      'The launch asset is always .bundle, whatever the file is called on disk');
    assert.ok(manifest.launchAsset.hash.length > 0);
    assert.ok(!/[+/=]/.test(manifest.launchAsset.hash), 'and its hash is base64url');
    assert.match(manifest.launchAsset.key, /^[0-9a-f]{32}$/, 'the key is an md5 hex digest');

    const icon = manifest.assets.find(a => a.url.includes('icon.png'))!;
    assert.equal(icon.contentType, 'image/png');
    assert.equal(icon.fileExtension, '.png');

    // Every URL must be absolute and point back at this server.
    for (const a of [...manifest.assets, manifest.launchAsset]) {
      assert.ok(a.url.startsWith(`${ORIGIN}/api/ota/assets?`), `absolute url: ${a.url}`);
      const q = new URL(a.url).searchParams;
      assert.equal(q.get('runtimeVersion'), '1.0.0');
      assert.equal(q.get('platform'), 'android');
      assert.ok(q.get('asset')!.length > 0);
      assert.ok(!q.get('asset')!.includes('\\'), 'and uses forward slashes on every platform');
    }
  }

  console.log('--- 7. THE ID IS THE CONTENT, SO REPUBLISHING IS FREE ---');
  {
    const build = (metadata: ExpoMetadata) => buildManifest({
      updateDir: '/updates/1.0.0/x',
      runtimeVersion: '1.0.0',
      platform: 'android',
      metadata,
      origin: ORIGIN,
      createdAt: '2026-08-29T12:00:00.000Z',
      readFile: fakeReader(FILES),
    });

    const a = await build(METADATA);
    const b = await build(JSON.parse(JSON.stringify(METADATA)));
    assert.equal(a.id, b.id, 'Identical content republishes to an identical id');

    const changed = JSON.parse(JSON.stringify(METADATA)) as ExpoMetadata;
    changed.fileMetadata!.android.bundle = '_expo/static/js/android/index-CHANGED.hbc';
    const c = await build(changed).catch(() => null);
    assert.equal(c, null, 'A bundle that is not on disk fails loudly rather than shipping empty');

    const extraAsset = JSON.parse(JSON.stringify(METADATA)) as ExpoMetadata;
    extraAsset.fileMetadata!.android.assets.pop();
    const d = await build(extraAsset);
    assert.notEqual(a.id, d.id, 'and a real change produces a different id');
  }

  console.log('--- 8. A MISSING PLATFORM IS A CLEAR FAILURE ---');
  {
    await assert.rejects(
      () => buildManifest({
        updateDir: '/x', runtimeVersion: '1.0.0', platform: 'ios',
        metadata: METADATA, origin: ORIGIN,
        createdAt: '2026-08-29T12:00:00.000Z', readFile: fakeReader(FILES),
      }),
      /nothing for ios/,
      'Asking for a platform the export does not contain says so',
    );
  }

  console.log('--- 9. MULTIPART ENCODING MATCHES THE PROTOCOL ---');
  {
    const boundary = makeBoundary('seed');
    const body = encodeMultipart(
      [{ name: 'manifest', body: '{"id":"x"}', contentType: 'application/json; charset=utf-8' }],
      boundary,
    );

    assert.ok(body.startsWith(`--${boundary}\r\n`), 'opens with the boundary');
    assert.ok(body.includes('content-disposition: form-data; name="manifest"'));
    assert.ok(body.includes('content-type: application/json; charset=utf-8'));
    assert.ok(body.includes('\r\n\r\n{"id":"x"}'), 'a blank line separates headers from the body');
    assert.ok(body.endsWith(`--${boundary}--\r\n`), 'and closes with the terminating boundary');
    assert.ok(!body.includes('\n\n'), 'line endings are CRLF throughout, as MIME requires');

    // The boundary must be stable for a given seed and not appear in the body.
    assert.equal(makeBoundary('seed'), boundary);
    assert.notEqual(makeBoundary('other'), boundary);
    assert.ok(!'{"id":"x"}'.includes(boundary));

    const two = encodeMultipart([
      { name: 'manifest', body: '{}', contentType: 'application/json' },
      { name: 'directive', body: '{}', contentType: 'application/json' },
    ], boundary);
    assert.equal(two.split(`--${boundary}`).length - 1, 3, 'two parts plus the terminator');
  }

  console.log('--- 10. RESOLVING AN UPDATE, END TO END ---');
  {
    const deps: OtaDeps = {
      listUpdates: async rv => (rv === '1.0.0' ? ['20260101-000000', '20260829-120000'] : []),
      updateDir: (rv, name) => `/ota/${rv}/${name}`,
      readFile: fakeReader(FILES),
      readJson: async abs => {
        if (abs.includes('metadata.json')) return METADATA;
        if (abs.includes('expoConfig.json')) return { name: 'Daily Planner', slug: 'daily-planner' };
        throw new Error('missing');
      },
      now: () => 1_800_000_000_000,
    };

    const ok = await resolveUpdate(
      { platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN },
      deps,
    );
    assert.equal(ok.kind, 'manifest');
    if (ok.kind !== 'manifest') throw new Error('unreachable');
    assert.ok(ok.manifest.url === undefined);
    assert.deepEqual((ok.manifest.extra as any).expoClient.name, 'Daily Planner',
      'The app config travels with the manifest');
    assert.ok(ok.manifest.assets.length === 2);

    // The phone already has this exact update.
    const same = await resolveUpdate(
      {
        platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1,
        origin: ORIGIN, currentUpdateId: ok.manifest.id,
      },
      deps,
    );
    assert.equal(same.kind, 'no-update', 'Holding the newest update means no download');

    // A different id still gets the manifest.
    const stale = await resolveUpdate(
      {
        platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1,
        origin: ORIGIN, currentUpdateId: 'something-else',
      },
      deps,
    );
    assert.equal(stale.kind, 'manifest');
  }

  console.log('--- 11. NOTHING PUBLISHED IS NOT AN ERROR ---');
  {
    const empty: OtaDeps = {
      listUpdates: async () => [],
      updateDir: (rv, n) => `/ota/${rv}/${n}`,
      readFile: async () => Buffer.from(''),
      readJson: async () => ({}),
      now: () => 0,
    };
    const res = await resolveUpdate(
      { platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN },
      empty,
    );
    assert.equal(res.kind, 'no-update',
      'A phone whose runtime version has no updates is simply running its built-in bundle');

    // A runtime version we have never seen behaves the same way — this is what
    // happens for every phone on a build newer than anything published.
    const unknown = await resolveUpdate(
      { platform: 'android', runtimeVersion: '9.9.9', protocolVersion: 1, origin: ORIGIN },
      empty,
    );
    assert.equal(unknown.kind, 'no-update');
  }

  console.log('--- 12. BAD REQUESTS AND BROKEN PUBLISHES ---');
  {
    const deps: OtaDeps = {
      listUpdates: async () => ['20260829-120000'],
      updateDir: (rv, n) => `/ota/${rv}/${n}`,
      readFile: fakeReader(FILES),
      readJson: async () => { throw new Error('corrupt'); },
      now: () => 0,
    };

    const badPlatform = await resolveUpdate(
      { platform: 'web', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN }, deps);
    assert.equal(badPlatform.kind, 'error');
    assert.equal((badPlatform as any).status, 400);

    const badRuntime = await resolveUpdate(
      { platform: 'android', runtimeVersion: '../../etc', protocolVersion: 1, origin: ORIGIN }, deps);
    assert.equal(badRuntime.kind, 'error');
    assert.equal((badRuntime as any).status, 400);

    // A published folder whose metadata will not parse.
    const corrupt = await resolveUpdate(
      { platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN }, deps);
    assert.equal(corrupt.kind, 'error');
    assert.equal((corrupt as any).status, 500);
    assert.match((corrupt as any).message, /unreadable/);

    // Metadata that parses but is not an export.
    const notAnExport: OtaDeps = { ...deps, readJson: async () => ({ hello: 'world' }) };
    const wrong = await resolveUpdate(
      { platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN },
      notAnExport);
    assert.equal(wrong.kind, 'error');
    assert.match((wrong as any).message, /not a valid export/);
  }

  console.log('--- 13. AGAINST A REAL DIRECTORY ON DISK ---');
  {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ota-test-'));
    const dir = path.join(tmp, 'database', 'ota', '1.0.0', '20260829-120000');
    await fsp.mkdir(path.join(dir, '_expo', 'static', 'js', 'android'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(METADATA), 'utf-8');
    await fsp.writeFile(path.join(dir, 'expoConfig.json'), JSON.stringify({ name: 'Daily Planner' }), 'utf-8');
    await fsp.writeFile(path.join(dir, '_expo/static/js/android/index-abc.hbc'), 'BUNDLE', 'utf-8');
    await fsp.writeFile(path.join(dir, 'assets/icon.png'), 'PNG', 'utf-8');
    await fsp.writeFile(path.join(dir, 'assets/font.ttf'), 'FONT', 'utf-8');

    const deps = makeFsDeps(tmp, () => 1_800_000_000_000);
    assert.deepEqual(await deps.listUpdates('1.0.0'), ['20260829-120000']);
    assert.deepEqual(await deps.listUpdates('2.0.0'), [], 'An unpublished runtime lists nothing');
    assert.deepEqual(await deps.listUpdates('../escape'), [], 'and an unsafe one is refused');

    const res = await resolveUpdate(
      { platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN },
      deps,
    );
    assert.equal(res.kind, 'manifest');
    if (res.kind !== 'manifest') throw new Error('unreachable');
    assert.equal(res.manifest.assets.length, 2);
    assert.equal((res.manifest.extra as any).expoClient.name, 'Daily Planner');

    // Every asset the manifest advertises must actually resolve on disk.
    for (const a of [...res.manifest.assets, res.manifest.launchAsset]) {
      const rel = new URL(a.url).searchParams.get('asset')!;
      const abs = safeAssetPath(dir, rel);
      assert.ok(abs, `${rel} resolves inside the update folder`);
      await fsp.access(abs!);
    }

    // A second publish wins.
    const dir2 = path.join(tmp, 'database', 'ota', '1.0.0', '20260830-090000');
    await fsp.mkdir(dir2, { recursive: true });
    await fsp.writeFile(path.join(dir2, 'metadata.json'), JSON.stringify(METADATA), 'utf-8');
    assert.equal(newestFolder(await deps.listUpdates('1.0.0')), '20260830-090000');

    // An update with no expoConfig.json is still served — it is optional.
    const noConfig = await resolveUpdate(
      { platform: 'android', runtimeVersion: '1.0.0', protocolVersion: 1, origin: ORIGIN },
      makeFsDeps(tmp, () => 0),
    );
    // dir2 has no bundle on disk, so this must fail cleanly rather than serve a
    // manifest pointing at files that are not there.
    assert.equal(noConfig.kind, 'error', 'A half-copied publish is refused, not shipped');

    await fsp.rm(tmp, { recursive: true, force: true });
  }

  console.log('\nALL PASS (OTA: manifests, selection, traversal defence)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
