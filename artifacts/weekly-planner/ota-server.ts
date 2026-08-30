// ─── Over-the-air updates ────────────────────────────────────────────────────
// Implements the Expo Updates protocol so the phone can fetch a new JavaScript
// bundle straight from this PC. No account, no cloud, no store.
//
// HOW IT FITS TOGETHER
//   `npm run publish:ota` in mobile/ runs `expo export`, then copies the result
//   into database/ota/<runtimeVersion>/<timestamp>/. This module serves whatever
//   the newest folder for the phone's runtime version happens to be.
//
// WHAT AN UPDATE CAN AND CANNOT CHANGE
//   Everything written in JavaScript: screens, logic, styling, images. It CANNOT
//   add a native capability — a new permission, a new native module, a home
//   screen widget. Those change the runtime version, and a phone only ever
//   accepts updates matching the runtime version it was built with. That is the
//   whole safety mechanism: an update that needs native code it does not have
//   is simply never offered, rather than installed and then crashing on launch.
//
// THE ID IS THE CONTENT
//   An update's id is derived from the hash of its metadata, so republishing
//   identical content produces an identical id and the phone does nothing. Only
//   a genuine change causes a download.

import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';

/** What `expo export` writes alongside the bundle. */
export interface ExpoMetadata {
  version?: number;
  bundler?: string;
  fileMetadata?: {
    [platform: string]: {
      bundle: string;
      assets: { path: string; ext: string }[];
    };
  };
}

export interface AssetEntry {
  hash: string;
  key: string;
  fileExtension: string;
  contentType: string;
  url: string;
}

export interface UpdateManifest {
  id: string;
  createdAt: string;
  runtimeVersion: string;
  assets: AssetEntry[];
  launchAsset: AssetEntry;
  metadata: Record<string, unknown>;
  extra: Record<string, unknown>;
}

export type OtaPlatform = 'android' | 'ios';

export const OTA_PLATFORMS: OtaPlatform[] = ['android', 'ios'];

/** base64 -> base64url, which is what the protocol expects for hashes. */
export function base64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashOf(
  data: crypto.BinaryLike,
  algorithm: string,
  encoding: crypto.BinaryToTextEncoding,
): string {
  return crypto.createHash(algorithm).update(data).digest(encoding);
}

/**
 * The manifest id must be a UUID, but it has to be derived from the content so
 * that republishing the same bundle is a no-op. A SHA-256 hash reshaped into
 * UUID form gives both.
 */
export function sha256ToUuid(hex: string): string {
  const h = hex.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (h.length < 32) throw new Error('Hash too short to form a UUID');
  return [
    h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32),
  ].join('-');
}

/** Content types for the handful of extensions a bundle actually contains. */
export function contentTypeFor(ext: string | null | undefined): string {
  const e = String(ext ?? '').replace(/^\./, '').toLowerCase();
  const map: Record<string, string> = {
    js: 'application/javascript',
    hbc: 'application/javascript',
    bundle: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
  };
  return map[e] ?? 'application/octet-stream';
}

// ─── Finding the newest published update ─────────────────────────────────────

/** A published update folder: database/ota/<runtimeVersion>/<name>/ */
export interface UpdateFolder {
  name: string;
  runtimeVersion: string;
  path: string;
}

/**
 * Folder names are sortable timestamps, so "newest" is the last one by name.
 * Sorting by mtime instead would reorder the whole history whenever a backup or
 * a file copy touched an old folder.
 */
/**
 * When an update was published, taken from its folder name.
 *
 * `createdAt` identifies a VERSION, so it has to be a property of the update
 * rather than of the request that asked for it. It was the current clock, which
 * meant every check described the same bundle as having been created a moment
 * ago — the phone was told the update was newer than itself on every single
 * poll, for ever. Publishing stamps the folder `YYYYMMDD-HHMMSS`, so the answer
 * is already there; `fallback` covers a folder named by hand.
 */
export function publishedAt(folderName: string, fallback: number): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(folderName);
  if (!m) return new Date(fallback).toISOString();
  const [, y, mo, d, h, mi, sec] = m;
  const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  return Number.isNaN(at.getTime()) ? new Date(fallback).toISOString() : at.toISOString();
}

export function newestFolder(names: readonly string[]): string | null {
  const valid = names.filter(n => /^[0-9A-Za-z._-]+$/.test(n));
  if (valid.length === 0) return null;
  return [...valid].sort()[valid.length - 1];
}

/** A runtime version arrives from the phone; it must never reach a path. */
export function safeRuntimeVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0 || v.length > 64) return null;
  if (!/^[0-9A-Za-z._-]+$/.test(v)) return null;
  if (v === '.' || v === '..') return null;
  return v;
}

export function safePlatform(raw: unknown): OtaPlatform | null {
  return raw === 'android' || raw === 'ios' ? raw : null;
}

/**
 * Resolve an asset path requested by the phone, refusing anything that escapes
 * the update folder.
 *
 * This is a security boundary: the OTA routes are reachable from the public
 * internet, and without it `?asset=../../database/users/mamoun/database.json`
 * would turn the updater into a file reader.
 */
export function safeAssetPath(root: string, requested: unknown): string | null {
  if (typeof requested !== 'string' || requested.length === 0) return null;
  if (requested.includes('\0')) return null;
  if (path.isAbsolute(requested)) return null;
  if (/^[A-Za-z]:/.test(requested)) return null;      // Windows drive letter

  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, requested);
  const rel = path.relative(resolvedRoot, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

// ─── Building a manifest ─────────────────────────────────────────────────────

export interface BuildManifestInput {
  updateDir: string;
  runtimeVersion: string;
  platform: OtaPlatform;
  metadata: ExpoMetadata;
  /** Absolute origin the phone should download from, e.g. https://host */
  origin: string;
  expoConfig?: Record<string, unknown>;
  createdAt: string;
  /** Injected so the module stays testable without touching a disk. */
  readFile: (absolutePath: string) => Promise<Buffer>;
}

async function assetEntry(
  input: BuildManifestInput,
  relativePath: string,
  ext: string | null,
  isLaunchAsset: boolean,
): Promise<AssetEntry> {
  const abs = path.join(input.updateDir, relativePath);
  const bytes = await input.readFile(abs);

  const query = new URLSearchParams({
    asset: relativePath.split(path.sep).join('/'),
    runtimeVersion: input.runtimeVersion,
    platform: input.platform,
  });

  return {
    hash: base64Url(hashOf(bytes, 'sha256', 'base64')),
    key: hashOf(bytes, 'md5', 'hex'),
    fileExtension: `.${isLaunchAsset ? 'bundle' : String(ext ?? '').replace(/^\./, '')}`,
    contentType: isLaunchAsset ? 'application/javascript' : contentTypeFor(ext),
    url: `${input.origin.replace(/\/+$/, '')}/api/ota/assets?${query.toString()}`,
  };
}

export async function buildManifest(input: BuildManifestInput): Promise<UpdateManifest> {
  const forPlatform = input.metadata.fileMetadata?.[input.platform];
  if (!forPlatform || typeof forPlatform.bundle !== 'string') {
    throw new Error(`This update contains nothing for ${input.platform}.`);
  }

  const assets = await Promise.all(
    (forPlatform.assets ?? []).map(a => assetEntry(input, a.path, a.ext, false)),
  );
  const launchAsset = await assetEntry(input, forPlatform.bundle, null, true);

  // The id is the hash of the metadata, so identical content republishes to the
  // identical id and the phone correctly decides it already has this update.
  const id = sha256ToUuid(hashOf(JSON.stringify(input.metadata), 'sha256', 'hex'));

  return {
    id,
    createdAt: input.createdAt,
    runtimeVersion: input.runtimeVersion,
    assets,
    launchAsset,
    metadata: {},
    extra: input.expoConfig ? { expoClient: input.expoConfig } : {},
  };
}

// ─── The multipart body the protocol requires ────────────────────────────────

export interface MultipartPart {
  name: string;
  body: string;
  contentType: string;
}

/**
 * Encode parts as multipart/mixed.
 *
 * Written by hand rather than pulled from a package: this is the only place in
 * the planner that needs it, the format is a dozen lines, and adding a runtime
 * dependency to the dev server for it would be a poor trade.
 */
export function encodeMultipart(parts: readonly MultipartPart[], boundary: string): string {
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    lines.push(`content-disposition: form-data; name="${part.name}"`);
    lines.push(`content-type: ${part.contentType}`);
    lines.push('');
    lines.push(part.body);
  }
  lines.push(`--${boundary}--`);
  lines.push('');
  return lines.join('\r\n');
}

export function makeBoundary(seed: string): string {
  return `----planner${hashOf(seed, 'sha256', 'hex').slice(0, 24)}`;
}

// ─── Deciding what to answer ─────────────────────────────────────────────────

export type OtaOutcome =
  | { kind: 'manifest'; manifest: UpdateManifest }
  | { kind: 'no-update' }
  | { kind: 'error'; status: number; message: string };

export interface OtaRequest {
  platform: unknown;
  runtimeVersion: unknown;
  protocolVersion: number;
  currentUpdateId?: string | null;
  origin: string;
}

export interface OtaDeps {
  /** Folder names published for a runtime version, or [] when there are none. */
  listUpdates: (runtimeVersion: string) => Promise<string[]>;
  updateDir: (runtimeVersion: string, name: string) => string;
  readFile: (absolutePath: string) => Promise<Buffer>;
  readJson: (absolutePath: string) => Promise<unknown>;
  now: () => number;
}

export async function resolveUpdate(req: OtaRequest, deps: OtaDeps): Promise<OtaOutcome> {
  const platform = safePlatform(req.platform);
  if (!platform) {
    return { kind: 'error', status: 400, message: 'Expected platform android or ios.' };
  }
  const runtimeVersion = safeRuntimeVersion(req.runtimeVersion);
  if (!runtimeVersion) {
    return { kind: 'error', status: 400, message: 'A valid runtime version is required.' };
  }

  const names = await deps.listUpdates(runtimeVersion);
  const newest = newestFolder(names);
  if (!newest) {
    // Nothing published for this runtime version. Not an error: the phone is
    // simply running the build it was installed with.
    return { kind: 'no-update' };
  }

  const dir = deps.updateDir(runtimeVersion, newest);
  let metadata: ExpoMetadata;
  try {
    metadata = (await deps.readJson(path.join(dir, 'metadata.json'))) as ExpoMetadata;
  } catch {
    return { kind: 'error', status: 500, message: 'The published update is unreadable.' };
  }
  if (!metadata || typeof metadata !== 'object' || !metadata.fileMetadata) {
    return { kind: 'error', status: 500, message: 'The published update is not a valid export.' };
  }

  let expoConfig: Record<string, unknown> | undefined;
  try {
    expoConfig = (await deps.readJson(path.join(dir, 'expoConfig.json'))) as Record<string, unknown>;
  } catch {
    expoConfig = undefined;   // optional
  }

  let manifest: UpdateManifest;
  try {
    manifest = await buildManifest({
      updateDir: dir,
      runtimeVersion,
      platform,
      metadata,
      origin: req.origin,
      expoConfig,
      createdAt: publishedAt(newest, deps.now()),
      readFile: deps.readFile,
    });
  } catch (err) {
    return { kind: 'error', status: 500, message: (err as Error)?.message ?? 'Update build failed.' };
  }

  // The phone already has exactly this. Saying so saves it a download it would
  // otherwise start and then discard.
  if (req.currentUpdateId && req.currentUpdateId === manifest.id) {
    return { kind: 'no-update' };
  }

  return { kind: 'manifest', manifest };
}

// ─── Filesystem helpers used by the server ───────────────────────────────────

export function otaRoot(rootDir: string): string {
  return path.resolve(rootDir, 'database', 'ota');
}

export function makeFsDeps(rootDir: string, now: () => number = Date.now): OtaDeps {
  const root = otaRoot(rootDir);
  return {
    async listUpdates(runtimeVersion) {
      const safe = safeRuntimeVersion(runtimeVersion);
      if (!safe) return [];
      try {
        const entries = await fsp.readdir(path.join(root, safe), { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
      } catch {
        return [];
      }
    },
    updateDir: (runtimeVersion, name) => path.join(root, runtimeVersion, name),
    readFile: abs => fsp.readFile(abs),
    async readJson(abs) {
      return JSON.parse(await fsp.readFile(abs, 'utf-8'));
    },
    now,
  };
}

/** Where an asset request must be confined to. */
export function assetRootFor(rootDir: string, runtimeVersion: string, name: string): string {
  return path.join(otaRoot(rootDir), runtimeVersion, name);
}
