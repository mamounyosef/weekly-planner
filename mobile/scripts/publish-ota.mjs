// ─── Publish an over-the-air update ──────────────────────────────────────────
// Run from mobile/:  npm run publish
//
// Exports the current JavaScript, stamps it with the app's runtime version, and
// drops it where the planner server serves it from. The phone picks it up on its
// next launch — no reinstall, no cable, no account.
//
// WHAT THIS CANNOT SHIP
// Native changes. If you added a permission, a native module, or anything that
// changed app.json's `plugins` or `android` block, the runtime version must be
// bumped and a new APK built and installed by hand. That is deliberate: a phone
// only accepts updates matching the runtime version it was built with, so an
// update needing native code it does not have is never offered rather than
// installed and then crashing on launch.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');
const repoRoot = path.resolve(mobileDir, '..');
const otaRoot = path.join(repoRoot, 'database', 'ota');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: mobileDir, stdio: 'inherit', shell: true, ...opts });

function readAppConfig() {
  const raw = fs.readFileSync(path.join(mobileDir, 'app.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.expo ?? parsed;
}

/**
 * A sortable folder name, so "newest" is simply the last one alphabetically.
 *
 * This string IS the update's identity everywhere: the folder here, the
 * `createdAt` the manifest carries, and the "Update" row on the phone under
 * Settings > App & Data. To check whether a phone actually picked up what you
 * published, compare the two -- they are the same characters. Do not trust the
 * "Runtime" row for that: it is pinned (see below) and reads 1.0.0 forever.
 */
function stamp(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return [
    now.getFullYear(), p(now.getMonth() + 1), p(now.getDate()),
  ].join('') + '-' + [p(now.getHours()), p(now.getMinutes()), p(now.getSeconds())].join('');
}

async function copyTree(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else await fsp.copyFile(src, dst);
  }
}

async function main() {
  // ── The gate ──────────────────────────────────────────────────────────────
  // Metro does not typecheck, so a ReferenceError reaches the phone as a bundle
  // that dies at launch. That has happened: `(pl as any).id.toString()` on a
  // value with no `id` shipped over the air, the app shut itself instantly, and
  // because a crashing process also kills the background download of the NEXT
  // update, the fix could not land either. Recovering it meant reinstalling the
  // APK by hand.
  //
  // So the typecheck is not advice here, it is the door. `--skip-check` exists
  // only for someone who has just run it themselves.
  if (!process.argv.includes('--skip-check')) {
    console.log('\n\n> Type checking (a bundle that does not compile bricks the app)...');
    try {
      run('npx', ['tsc', '--noEmit']);
    } catch (_) {
      throw new Error(
        'Type errors above. NOT publishing.\n'
        + '  A crash at launch also kills the update download, so a broken\n'
        + '  publish cannot be fixed by publishing again. It needs a reinstall\n'
        + '  of the APK from the /app page.',
      );
    }
  }

  const config = readAppConfig();
  // NOT a build number. `runtimeVersion` is the contract with the NATIVE half:
  // a phone only accepts an update whose runtime matches the APK it has
  // installed. Bump it and every OTA silently stops landing until a new APK is
  // sideloaded, so it changes ONLY when the native side does (a new native
  // module, an Expo SDK upgrade). The thing that moves per publish is the
  // folder stamp above.
  const runtimeVersion = config.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || runtimeVersion.length === 0) {
    throw new Error('app.json has no runtimeVersion — the phone would not know what to accept.');
  }

  console.log(`\n▶ Exporting JavaScript for runtime ${runtimeVersion}…`);
  const dist = path.join(mobileDir, 'dist');
  await fsp.rm(dist, { recursive: true, force: true });
  run('npx', ['expo', 'export', '--platform', 'android']);

  const metadataPath = path.join(dist, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('The export produced no metadata.json — nothing to publish.');
  }
  // Fail here rather than publishing a manifest that points at a missing bundle.
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf-8'));
  const bundle = metadata?.fileMetadata?.android?.bundle;
  if (!bundle || !fs.existsSync(path.join(dist, bundle))) {
    throw new Error('The export is missing its Android bundle — refusing to publish.');
  }

  const target = path.join(otaRoot, runtimeVersion, stamp());
  console.log(`▶ Publishing to ${path.relative(repoRoot, target)}…`);
  await copyTree(dist, target);

  // The app config travels with the update; expo-updates reads it back as
  // `extra.expoClient`, and without it the phone falls back to whatever was
  // baked into the APK.
  await fsp.writeFile(
    path.join(target, 'expoConfig.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );

  const published = (await fsp.readdir(path.join(otaRoot, runtimeVersion))).sort();
  console.log(`\n✓ Published. ${published.length} update${published.length === 1 ? '' : 's'} for runtime ${runtimeVersion}.`);
  console.log('  Your phone will pick it up the next time the app is opened.');
  console.log('  Settings → Check for update forces it immediately.\n');

  // Old exports are kept: they cost little and are the only way back if an
  // update turns out to be broken. Rolling back is renaming a folder.
  if (published.length > 5) {
    console.log(`  (${published.length} kept for rollback; delete old folders in database/ota if you want the space.)`);
  }
}

main().catch(err => {
  console.error(`\n✗ ${err?.message ?? err}\n`);
  process.exit(1);
});
