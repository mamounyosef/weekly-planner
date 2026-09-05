import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

export interface AppUser {
  username: string;
  password: string;
  name?: string;
}

export interface PublicAccessConfig {
  enabled?: boolean;
  users?: AppUser[];
  user?: string;
  password?: string;
}


const SESSION_SECRET = 'weekly-planner-multi-user-secure-secret-2026';
export const SESSION_COOKIE = 'planner_session';
// A persistent local-browser login should survive app/server restarts, but not
// live indefinitely if a browser fails to discard an expired cookie.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

export function sanitizeUsername(raw: string): string {
  return (raw || '').trim().toLowerCase().replace(/[^a-z0-9_\-\.]/g, '_');
}

export async function loadAccessConfig(rootDir: string): Promise<{ enabled: boolean; users: AppUser[] }> {
  const usersPath = path.resolve(rootDir, 'database', 'users.json');
  const legacyAccessPath = path.resolve(rootDir, 'database', 'public-access.json');
  try {
    let rawText = '';
    try {
      rawText = await fsp.readFile(usersPath, 'utf-8');
    } catch {
      rawText = await fsp.readFile(legacyAccessPath, 'utf-8');
    }
    const raw = JSON.parse(rawText) as PublicAccessConfig;
    const enabled = raw.enabled !== false;
    const users: AppUser[] = [];
    if (Array.isArray(raw.users)) {
      for (const u of raw.users) {
        if (u && typeof u.username === 'string' && u.username.trim() && typeof u.password === 'string') {
          users.push({
            username: sanitizeUsername(u.username),
            password: String(u.password),
            name: typeof u.name === 'string' && u.name.trim() ? u.name.trim() : u.username.trim(),
          });
        }
      }
    }
    // Backward compatibility for single user
    if (users.length === 0 && raw.user && raw.password) {
      users.push({
        username: sanitizeUsername(raw.user),
        password: String(raw.password),
        name: String(raw.user).trim(),
      });
    }
    return { enabled, users };
  } catch {
    return { enabled: true, users: [] };
  }
}

export function getUserDbPaths(rootDir: string, username: string) {
  const safeName = sanitizeUsername(username) || 'default';
  const dbDir = path.resolve(rootDir, 'database', 'users', safeName);
  return {
    safeName,
    dbDir,
    dbPath: path.join(dbDir, 'database.json'),
    tasksPath: path.join(dbDir, 'tasks.json'),
    settingsPath: path.join(dbDir, 'settings.json'),
    devicePath: path.join(dbDir, 'device-settings.json'),
    focusPath: path.join(dbDir, 'focus-sessions.json'),
    timerPath: path.join(dbDir, 'focus-timer.json'),
    beatPath: path.join(dbDir, 'focus-heartbeat.json'),
    donePath: path.join(dbDir, 'prayer-done.json'),
    notificationsPath: path.join(dbDir, 'notifications.json'),
    pushSubsPath: path.join(dbDir, 'push-subscriptions.json'),
    configPath: path.join(dbDir, 'google-config.json'),
    tokensPath: path.join(dbDir, 'google-tokens.json'),
    statePath: path.join(dbDir, 'auto-backup-state.json'),
    backupDir: path.join(dbDir, 'backups'),
  };
}

export async function ensureUserDb(rootDir: string, username: string) {
  const p = getUserDbPaths(rootDir, username);
  await fsp.mkdir(p.dbDir, { recursive: true });
  await fsp.mkdir(p.backupDir, { recursive: true });

  const initFile = async (filePath: string, defaultContent: string) => {
    try {
      await fsp.access(filePath);
    } catch {
      await fsp.writeFile(filePath, defaultContent, 'utf-8');
    }
  };

  await Promise.all([
    initFile(p.dbPath, '{}'),
    initFile(p.tasksPath, '{}'),
    initFile(p.settingsPath, '{}'),
    initFile(p.focusPath, '[]'),
    initFile(p.timerPath, JSON.stringify({ plannedSeconds: 3600, accumulatedSeconds: 0, isRunning: false, lastStartedAt: null, sessionStartedAt: null, lastPausedAt: null }, null, 2)),
    initFile(p.donePath, '{}'),
    initFile(p.notificationsPath, JSON.stringify({ items: {}, updatedAt: 0 }, null, 2)),
    initFile(p.pushSubsPath, '[]'),
    initFile(p.devicePath, '{}'),
  ]);

  return p;
}

export async function migrateLegacyDatabase(rootDir: string) {
  try {
    const legacyDbPath = path.resolve(rootDir, 'database', 'database.json');
    const { users } = await loadAccessConfig(rootDir);
    const targetUser = users.length > 0 ? users[0].username : 'mamoun';
    const targetDir = path.resolve(rootDir, 'database', 'users', targetUser);
    const targetDbPath = path.join(targetDir, 'database.json');
    const destBackup = path.join(targetDir, 'backups');

    const hasLegacy = await fsp.stat(legacyDbPath).then(() => true).catch(() => false);
    const hasMigrated = await fsp.stat(targetDbPath).then(() => true).catch(() => false);

    if (hasLegacy && !hasMigrated) {
      await fsp.mkdir(targetDir, { recursive: true });
      const rootDbDir = path.resolve(rootDir, 'database');
      const files = await fsp.readdir(rootDbDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isDirectory() && file.name === 'backups') {
          await fsp.mkdir(destBackup, { recursive: true });
          const backupFiles = await fsp.readdir(path.join(rootDbDir, 'backups')).catch(() => []);
          for (const bf of backupFiles) {
            await fsp.copyFile(path.join(rootDbDir, 'backups', bf), path.join(destBackup, bf)).catch(() => {});
          }
        } else if (file.isFile()) {
          if (file.name === 'users.json' || file.name === 'public-access.json' || file.name === 'prayer-times.json') continue;
          await fsp.copyFile(path.join(rootDbDir, file.name), path.join(targetDir, file.name)).catch(() => {});
        }
      }
      console.log(`[auth] Successfully migrated legacy database to database/users/${targetUser}/`);
    }

    // Also migrate legacy root backups (<rootDir>/backups) if any exist
    const rootBackupDir = path.resolve(rootDir, 'backups');
    const rootBackups = await fsp.readdir(rootBackupDir).catch(() => []);
    if (rootBackups.length > 0) {
      await fsp.mkdir(destBackup, { recursive: true });
      for (const bf of rootBackups) {
        if (bf.startsWith('planner-backup.') && bf.endsWith('.json')) {
          const destFile = path.join(destBackup, bf);
          const exists = await fsp.stat(destFile).then(() => true).catch(() => false);
          if (!exists) {
            await fsp.copyFile(path.join(rootBackupDir, bf), destFile).catch(() => {});
          }
          await fsp.unlink(path.join(rootBackupDir, bf)).catch(() => {});
        }
      }
      await fsp.rmdir(rootBackupDir).catch(() => {});
      console.log(`[auth] Successfully migrated legacy root backups to database/users/${targetUser}/backups/`);
    }
  } catch (err) {
    console.warn('[auth] Migration check notice:', err);
  }
}

export function createSessionToken(username: string, password: string): string {
  const safeName = sanitizeUsername(username);
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  const sig = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${safeName}:${expiresAt}:${password}`)
    .digest('hex');
  return `${safeName}:${expiresAt}:${sig}`;
}

export function verifySessionToken(tokenStr: string, users: AppUser[]): AppUser | null {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [rawUser, expiryOrSignature, maybeSignature] = parts;
  const safeName = sanitizeUsername(rawUser);
  const found = users.find(u => u.username === safeName);
  if (!found) return null;

  // Cookies issued before this upgrade have no signed expiry. Keep them valid
  // until their existing browser expiry so users are not unexpectedly signed
  // out once, while all newly-issued sessions are server-expiring as well.
  const expiresAt = maybeSignature ? Number(expiryOrSignature) : null;
  if (maybeSignature && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) return null;
  const signature = maybeSignature || expiryOrSignature;
  const payload = maybeSignature
    ? `${safeName}:${expiresAt}:${found.password}`
    : `${safeName}:${found.password}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  if (signature.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? found : null;
}

/**
 * This machine only. NOT the local network.
 *
 * Kept separate from `isLocalAddress` because the two answer different
 * questions and one of them grants a signed-in identity with no password.
 */
export function isLoopbackAddress(raw: string): boolean {
  const ip = (raw || '').replace(/^::ffff:/, '');
  // A full match on 127.0.0.0/8, not a `startsWith('127.')` prefix. A socket
  // address is always numeric so a hostname cannot really arrive here, but this
  // function decides whether to hand out an account with no password, and that
  // is not a place to rely on the caller.
  return ip === '::1' || /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip);
}

/** Anywhere on the home network, including this machine. */
export function isLocalAddress(raw: string): boolean {
  const ip = (raw || '').replace(/^::ffff:/, '');
  return (
    ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') ||
    ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

export function getAuthUser(req: any, users: AppUser[]): AppUser | null {
  // 1. Session Cookie
  const cookieHeader = String(req.headers?.cookie || '');
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match) {
    const raw = decodeURIComponent(match[1]);
    const u = verifySessionToken(raw, users);
    if (u) return u;
  }

  // 2. Authorization: Basic
  const authHeader = String(req.headers?.authorization || '');
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const [uName, ...pParts] = decoded.split(':');
      const pass = pParts.join(':');
      const safe = sanitizeUsername(uName);
      const found = users.find(u => u.username === safe && u.password === pass);
      if (found) return found;
    } catch (_) {}
  }

  // 3. Authorization: Bearer <sessionToken>
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const u = verifySessionToken(token, users);
    if (u) return u;
  }

  // 4. LOOPBACK hotkey helper fallback -- this machine, and nothing else.
  //
  // This used to ask `isLocalAddress`, which answers for the whole private
  // range: 10.x, 192.168.x and 172.16-31.x as well as 127.0.0.1. So every
  // phone, laptop and television on the same Wi-Fi was resolved to the first
  // account without a password, on two routes -- and one of them, /api/settings,
  // accepts POST, which is a full overwrite of that account's categories,
  // notification rules and Google sync policy.
  //
  // The helpers this exists for (the hotkey script and the toast agent) all run
  // on this PC, so loopback is the whole of what it ever needed.
  const rawUrl = req.originalUrl || req.url || '';
  const urlPath = rawUrl.split('?')[0].replace(/\/+$/, '') || '/';
  const remote = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const proxied = Boolean(req.headers?.['x-forwarded-for']);
  if (!proxied && isLoopbackAddress(remote) && (urlPath === '/api/focus-timer/toggle' || urlPath === '/api/settings')) {
    if (users.length > 0) return users[0];
  }

  return null;
}

export function autoBackupPaths(rootDir: string, username: string) {
  const userDir = path.resolve(rootDir, 'database', 'users', sanitizeUsername(username) || 'default');
  return {
    dbPath:       path.resolve(userDir, 'database.json'),
    settingsPath: path.resolve(userDir, 'settings.json'),
    sessionsPath: path.resolve(userDir, 'focus-sessions.json'),
    tasksPath:    path.resolve(userDir, 'tasks.json'),
    statePath:    path.resolve(userDir, 'auto-backup-state.json'),
    outDir:       path.resolve(userDir, 'backups'),
  };
}
