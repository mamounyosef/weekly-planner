// Tests the APK download logic: which build the phone is offered, and the path
// checks that stop the installer route from becoming a way to read the planner's
// own files.
//
// The traversal cases matter most. The download route takes a file name straight
// from a query string on a PUBLICLY REACHABLE server, so `safeApkName` is a
// security boundary, not a tidy-up.
//
// Run with: npx tsx src/lib/appDelivery.test.ts

import assert from 'node:assert/strict';
import {
  KNOWN_ABIS,
  abiHintFromUserAgent,
  abiOf,
  chooseApk,
  formatBytes,
  isApk,
  listForDisplay,
  safeApkName,
  type ApkFile,
} from '../../app-delivery';

const file = (name: string, mb = 30, modified = 1_000): ApkFile =>
  ({ name, size: Math.round(mb * 1024 * 1024), modified });

const BUILDS: ApkFile[] = [
  file('app-arm64-v8a-release.apk', 32.4, 3_000),
  file('app-armeabi-v7a-release.apk', 27.3, 2_000),
  file('app-universal-release.apk', 78.3, 1_000),
];

console.log('--- 1. RECOGNISING APKS ---');
{
  assert.equal(isApk('app-release.apk'), true);
  assert.equal(isApk('APP-RELEASE.APK'), true, 'Case does not matter');
  assert.equal(isApk('app-release.apk.txt'), false);
  assert.equal(isApk('database.json'), false);
  assert.equal(isApk('apk'), false);
  assert.equal(isApk(''), false);
  assert.equal(isApk('.apk'), true, 'Odd but genuinely an apk extension');
}

console.log('--- 2. READING THE ARCHITECTURE FROM A FILE NAME ---');
{
  assert.equal(abiOf('app-arm64-v8a-release.apk'), 'arm64-v8a');
  assert.equal(abiOf('app-armeabi-v7a-release.apk'), 'armeabi-v7a');
  assert.equal(abiOf('app-x86_64-release.apk'), 'x86_64');
  assert.equal(abiOf('app-universal-release.apk'), 'universal');
  assert.equal(abiOf('APP-ARM64-V8A-RELEASE.APK'), 'arm64-v8a', 'Case-insensitive');
  assert.equal(abiOf('app-release.apk'), 'universal',
    'An unlabelled build is treated as universal — the safe assumption');
  assert.equal(abiOf('anything.apk'), 'universal');

  // "universal" wins even when an ABI also appears, because that is what the
  // Gradle universal build is actually named in some configurations.
  assert.equal(abiOf('app-universal-arm64-v8a-release.apk'), 'universal');
  assert.deepEqual([...KNOWN_ABIS], ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']);
}

console.log('--- 3. THE USER-AGENT HINT IS A HINT, NOT A GUESS ---');
{
  const ua = (s: string) => abiHintFromUserAgent(s);
  assert.equal(ua('Mozilla/5.0 (Linux; Android 15; Pixel 7a Build/AP4A; aarch64)'), 'arm64-v8a');
  assert.equal(ua('Mozilla/5.0 (Linux; Android 15; arm64) Chrome'), 'arm64-v8a');
  assert.equal(ua('Mozilla/5.0 (Linux; Android 9; armv7l)'), 'armeabi-v7a');
  assert.equal(ua('Mozilla/5.0 (Linux; Android 12; x86_64)'), 'x86_64');

  // Anything that is not clearly an Android phone gives NO hint at all.
  assert.equal(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), null,
    'A desktop must not be handed an architecture-specific build');
  assert.equal(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'), null);
  assert.equal(ua('Mozilla/5.0 (Linux; Android 15; SM-A155F) Chrome/140'), null,
    'A typical modern Android UA names no CPU — so no guess is made');
  assert.equal(ua(''), null);
  assert.equal(ua(null), null);
  assert.equal(ua(undefined), null);
  assert.equal(ua(42 as any), null);
}

console.log('--- 4. CHOOSING A BUILD ---');
{
  // No hint: universal, because a failed install is worse than a big download.
  const blind = chooseApk(BUILDS)!;
  assert.equal(blind.abi, 'universal');
  assert.ok(blind.reason.includes('every phone'));

  // A recognised phone gets the smaller, matched build.
  const matched = chooseApk(BUILDS, {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel; aarch64)',
  })!;
  assert.equal(matched.abi, 'arm64-v8a');
  assert.equal(matched.file.name, 'app-arm64-v8a-release.apk');
  assert.ok(matched.reason.includes('arm64-v8a'));

  // An explicit choice always beats the hint.
  const chosen = chooseApk(BUILDS, {
    preferred: 'armeabi-v7a',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; aarch64)',
  })!;
  assert.equal(chosen.abi, 'armeabi-v7a', 'What the user picked wins over what we detected');

  // An unbuildable choice falls back to universal AND says so.
  const impossible = chooseApk(BUILDS, { preferred: 'x86' })!;
  assert.equal(impossible.abi, 'universal');
  assert.ok(impossible.reason.includes('No x86 build'),
    'Silently substituting a different build would be worse than saying so');

  // A hint for something not built falls through to universal.
  const notBuilt = chooseApk(BUILDS, {
    userAgent: 'Mozilla/5.0 (Linux; Android 12; x86_64)',
  })!;
  assert.equal(notBuilt.abi, 'universal');
}

console.log('--- 5. CHOOSING WHEN THE BUILD SET IS INCOMPLETE ---');
{
  assert.equal(chooseApk([]), null, 'Nothing built means nothing offered');
  assert.equal(chooseApk([file('notes.txt'), file('database.json')]), null,
    'Non-APK files are not offered as an app');

  const onlyArm = [file('app-arm64-v8a-release.apk')];
  const forced = chooseApk(onlyArm)!;
  assert.equal(forced.abi, 'arm64-v8a');
  assert.ok(forced.reason.includes('Only arm64-v8a'), 'and the page says why there is no choice');

  const single = chooseApk([file('app-release.apk')])!;
  assert.equal(single.abi, 'universal', 'An unlabelled single build is treated as universal');

  // Two files for the same ABI: the newer build wins, so a stale APK left behind
  // by an earlier run is never handed out.
  const duplicated = [
    file('app-arm64-v8a-release.apk', 30, 1_000),
    { ...file('app-arm64-v8a-release.apk', 32, 9_000), name: 'app-arm64-v8a-release.apk' },
  ];
  const newest = chooseApk(duplicated, { preferred: 'arm64-v8a' })!;
  assert.equal(newest.file.modified, 9_000, 'The most recent build is the one offered');
}

console.log('--- 6. PATH TRAVERSAL AND HOSTILE FILE NAMES ---');
{
  const available = BUILDS;
  const ok = safeApkName('app-arm64-v8a-release.apk', available);
  assert.equal(ok, 'app-arm64-v8a-release.apk', 'A file we actually listed is allowed');
  assert.equal(safeApkName('  app-arm64-v8a-release.apk  ', available), 'app-arm64-v8a-release.apk',
    'Whitespace is trimmed');

  const hostile = [
    '../../database/users/mamoun/database.json',
    '../../../../Windows/System32/drivers/etc/hosts',
    '..\\..\\database\\vapid.json',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'app-arm64-v8a-release.apk/../../secret.apk',
    './app-arm64-v8a-release.apk',
    'subdir/app-arm64-v8a-release.apk',
    'app-arm64-v8a-release.apk\u0000.txt',
    '..%2f..%2fdatabase.json',
    'not-a-real-build.apk',
    'database.json',
    '',
    '   ',
    'x'.repeat(201) + '.apk',
    null, undefined, 42, {}, [],
  ];
  for (const attempt of hostile) {
    assert.equal(safeApkName(attempt as any, available), null,
      `Must refuse: ${JSON.stringify(attempt)}`);
  }

  // Even a legitimate-looking name is refused when it is not in the built set —
  // membership, not shape, is what authorises the read.
  assert.equal(safeApkName('app-x86-release.apk', available), null,
    'A well-formed name for a file we did not build is still refused');
  assert.equal(safeApkName('app-arm64-v8a-release.apk', []), null,
    'and nothing at all is served when nothing was built');
}

console.log('--- 7. SIZES READ THE WAY A PHONE SHOWS THEM ---');
{
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(34_000_000), '32.4 MB');
  assert.equal(formatBytes(82_000_000), '78.2 MB');

  assert.equal(formatBytes(-1), '—', 'A nonsense size shows as unknown, not "-1 B"');
  assert.equal(formatBytes(NaN), '—');
  assert.equal(formatBytes(Infinity), '—');
}

console.log('--- 8. THE DOWNLOAD PAGE LISTING ---');
{
  const listed = listForDisplay(BUILDS.concat([file('README.txt')]));
  assert.equal(listed.length, 3, 'Only APKs are listed');
  assert.equal(listed[listed.length - 1].name, 'app-universal-release.apk',
    'Universal sits last, so the tailored builds read as the normal choice');
  assert.deepEqual(listed.map(f => f.name), [
    'app-arm64-v8a-release.apk',
    'app-armeabi-v7a-release.apk',
    'app-universal-release.apk',
  ]);

  assert.deepEqual(listForDisplay([]), []);
  assert.deepEqual(listForDisplay([file('a.json'), file('b.txt')]), [],
    'A folder with no builds lists nothing rather than offering junk');
}

console.log('--- 9. THE WHOLE FLOW, AS THE PHONE WOULD DRIVE IT ---');
{
  // Phone opens the page. No CPU in its UA, so it is offered universal.
  const offered = chooseApk(BUILDS, {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-A155F) AppleWebKit Chrome/140 Mobile Safari',
  })!;
  assert.equal(offered.abi, 'universal');

  // The listing shows the alternatives, and picking one is honoured.
  const options = listForDisplay(BUILDS);
  const picked = options.find(o => o.name.includes('arm64'))!;
  const validated = safeApkName(picked.name, BUILDS)!;
  assert.equal(validated, 'app-arm64-v8a-release.apk');

  const finalChoice = chooseApk(BUILDS, { preferred: 'arm64-v8a' })!;
  assert.equal(finalChoice.file.name, validated);
  assert.equal(formatBytes(finalChoice.file.size), '32.4 MB',
    'and the page can tell them how big the download is before they start it');
}

console.log('\nALL PASS (app delivery: architecture choice, traversal defence)');
