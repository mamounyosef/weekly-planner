// ─── Handing the Android app to the phone ────────────────────────────────────
// The planner serves its own APK, so installing and updating never involves a
// cable, a cloud drive or a store. Open the planner URL on the phone, tap
// Install, done.
//
// The only real decision here is WHICH file: the build produces one APK per CPU
// architecture plus a universal fallback. Installing the wrong architecture
// fails with Android's famously unhelpful "App not installed", so when the
// architecture is not known for certain the universal build wins — 45 MB is a
// far smaller cost than an install that fails for no visible reason.

import path from 'path';

export interface ApkFile {
  /** File name as built, e.g. `app-arm64-v8a-release.apk`. */
  name: string;
  size: number;
  modified: number;
}

export interface ApkChoice {
  file: ApkFile;
  abi: string;
  /** Why this one — shown on the download page so the choice is not a mystery. */
  reason: string;
}

/** ABIs we build for, most preferred first. */
export const KNOWN_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'] as const;

/** Pull the architecture out of a built APK's file name. */
export function abiOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.includes('universal')) return 'universal';
  for (const abi of KNOWN_ABIS) {
    if (lower.includes(abi)) return abi;
  }
  return 'universal';
}

export function isApk(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.apk');
}

/**
 * Read the phone's architecture out of the browser's User-Agent.
 *
 * Android does not advertise the ABI directly, but the build tag usually names
 * the CPU family. This is a HINT ONLY — a miss falls back to universal rather
 * than guessing, because a wrong guess produces a failed install.
 */
export function abiHintFromUserAgent(ua: string | undefined | null): string | null {
  if (typeof ua !== 'string' || ua.length === 0) return null;
  const lower = ua.toLowerCase();
  if (!lower.includes('android')) return null;

  if (lower.includes('aarch64') || lower.includes('arm64')) return 'arm64-v8a';
  if (lower.includes('x86_64') || lower.includes('x64')) return 'x86_64';
  if (lower.includes('armv7') || lower.includes('armeabi')) return 'armeabi-v7a';
  // Modern Android on 64-bit ARM often reports nothing useful at all.
  return null;
}

/**
 * Choose which APK to hand over.
 *
 * `preferred` comes from an explicit choice on the download page and always
 * wins; the User-Agent hint is used only when nothing was chosen.
 */
export function chooseApk(
  files: readonly ApkFile[],
  opts: { preferred?: string | null; userAgent?: string | null } = {},
): ApkChoice | null {
  const apks = files.filter(f => isApk(f.name));
  if (apks.length === 0) return null;

  const byAbi = new Map<string, ApkFile>();
  for (const file of apks) {
    const abi = abiOf(file.name);
    const existing = byAbi.get(abi);
    // If a rebuild left two files for one ABI, the newer one is the real answer.
    if (!existing || file.modified > existing.modified) byAbi.set(abi, file);
  }

  const wanted = opts.preferred?.trim();
  if (wanted) {
    const exact = byAbi.get(wanted);
    if (exact) return { file: exact, abi: wanted, reason: `You chose ${wanted}.` };
    // An explicit request we cannot satisfy must not silently become something
    // else without saying so.
    const universal = byAbi.get('universal');
    if (universal) {
      return {
        file: universal,
        abi: 'universal',
        reason: `No ${wanted} build available — this one works on every phone.`,
      };
    }
  }

  const hint = abiHintFromUserAgent(opts.userAgent);
  if (hint && byAbi.has(hint)) {
    return { file: byAbi.get(hint)!, abi: hint, reason: `Matched to your phone (${hint}).` };
  }

  const universal = byAbi.get('universal');
  if (universal) {
    return {
      file: universal,
      abi: 'universal',
      reason: 'Works on every phone. Larger, but it cannot fail to install.',
    };
  }

  // No universal build: fall back to the most likely architecture rather than
  // refusing outright.
  for (const abi of KNOWN_ABIS) {
    const file = byAbi.get(abi);
    if (file) return { file, abi, reason: `Only ${abi} was built.` };
  }
  return { file: apks[0], abi: abiOf(apks[0].name), reason: 'The only build available.' };
}

/** Human file size. Phones show MB, so this does too. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reject anything that is not one of the files we listed.
 *
 * The download route takes a file name from the query string, so this is the
 * boundary that stops `?file=../../database/users/mamoun/database.json` from
 * turning the installer into a way to read the planner's own files.
 */
export function safeApkName(raw: unknown, available: readonly ApkFile[]): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > 200) return null;
  if (name !== path.basename(name)) return null;      // no directory parts
  if (name.includes('..') || name.includes('\0')) return null;
  if (!isApk(name)) return null;
  return available.some(f => f.name === name) ? name : null;
}

/** Sorted for display: universal last, so the tailored build reads as the default. */
export function listForDisplay(files: readonly ApkFile[]): ApkFile[] {
  return files.filter(f => isApk(f.name)).sort((a, b) => {
    const ua = abiOf(a.name) === 'universal' ? 1 : 0;
    const ub = abiOf(b.name) === 'universal' ? 1 : 0;
    if (ua !== ub) return ua - ub;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
