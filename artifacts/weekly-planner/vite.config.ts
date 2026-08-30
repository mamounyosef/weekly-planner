import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// The presence filter is shared with the app and the tests rather than
// reimplemented here: the board posts raw centimetres and this is the only
// place that decides what they mean, so there must be exactly one copy of it.
import { createPresenceFilter, coerceSensorFilterConfig } from './src/lib/sensorFilter';
import { createHardwareBridge } from './src/lib/hardwareBridge';
import {
  loadAccessConfig,
  getUserDbPaths,
  ensureUserDb,
  migrateLegacyDatabase,
  createSessionToken,
  getAuthUser,
  autoBackupPaths,
  sanitizeUsername,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  type AppUser,
} from './server-user-db';
import { createNotificationEngine } from './notification-engine';
// Offline sync for the Android app. The PC keeps writing whole files exactly as
// it always has; this service diffs each save into operations at one choke point
// so nothing in the app itself had to change to gain offline sync.
import {
  createSyncService,
  handleSyncRequest,
  type UserSyncPaths,
} from './sync-service';
// Serving the Android app from the planner itself, so installing and updating
// never needs a cable or a cloud drive.
import {
  chooseApk,
  formatBytes,
  isApk,
  listForDisplay,
  safeApkName,
  abiOf,
  type ApkFile,
} from './app-delivery';
// Over-the-air updates, so a fix reaches the phone without reinstalling.
import {
  assetRootFor,
  contentTypeFor,
  encodeMultipart,
  makeBoundary,
  makeFsDeps,
  newestFolder,
  resolveUpdate,
  safeAssetPath,
  safePlatform,
  safeRuntimeVersion,
} from './ota-server';
import { createFunnelWatchdog } from './funnel-watchdog';

// Keep the persisted shortcut migration in step with src/lib/shortcuts.ts.
// This server-side copy also lets the windowless Windows hotkey helper see the
// corrected binding before a browser page has finished loading.
const SHORTCUT_DEFAULTS_VERSION = 2;
const LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT = 'Alt+Shift+F1';
const FOCUS_TIMER_TOGGLE_DEFAULT = 'Win+Shift+F1';

// File-database safety net:
// Guards against a save silently wiping real data: refuses to overwrite non-empty
// data with an empty payload, and writes to disk atomically via a temporary file and rename.
function isEmptyJsonValue(text: string, kind: 'object' | 'array'): boolean {
  try {
    const parsed = JSON.parse(text);
    if (kind === 'array') return Array.isArray(parsed) && parsed.length === 0;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return true;
  }
}

/**
 * Union the incoming focus-session list with what is already on disk, keyed by
 * id. Sessions are append-only in normal use, so a row the sender doesn't know
 * about is one another window just logged — never a deletion. Newest first.
 */
async function mergeFocusSessions(filePath: string, body: string): Promise<string> {
  let incoming: unknown;
  try {
    incoming = JSON.parse(body);
  } catch {
    return body; // let safeWriteJsonFile reject it
  }
  if (!Array.isArray(incoming)) return body;

  let existing: unknown[] = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    if (Array.isArray(parsed)) existing = parsed;
  } catch {
    existing = [];
  }
  if (existing.length === 0) return body;

  const byId = new Map<string, Record<string, unknown>>();
  // Existing first, then incoming — so the sender's version of a row it does
  // know about (e.g. an edited duration) wins.
  for (const list of [existing, incoming as unknown[]]) {
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const id = (row as Record<string, unknown>).id;
      if (typeof id !== 'string') continue;
      byId.set(id, row as Record<string, unknown>);
    }
  }

  const merged = [...byId.values()].sort((a, b) =>
    String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? ''))
  ).slice(0, 1000);
  return JSON.stringify(merged);
}

async function safeWriteJsonFile(opts: {
  filePath: string;
  backupDir?: string;
  baseName: string;
  body: string;
  kind: 'object' | 'array';
  force: boolean;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { filePath, baseName, body, kind, force } = opts;

  let existing: string | null = null;
  try {
    existing = await fsp.readFile(filePath, 'utf-8');
  } catch {
    existing = null;
  }

  // Never write anything that isn't valid JSON of the expected shape. A truncated
  // or empty request body would otherwise land on disk verbatim and destroy the
  // file — and `force` must not be an escape hatch for corrupt data.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: `Refused to write ${baseName}: body is not valid JSON.` };
  }
  const shapeOk = kind === 'array'
    ? Array.isArray(parsedBody)
    : !!parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody);
  if (!shapeOk) {
    return { ok: false, status: 400, error: `Refused to write ${baseName}: expected a JSON ${kind}.` };
  }

  const existingIsEmpty = existing === null || isEmptyJsonValue(existing, kind);
  const incomingIsEmpty = isEmptyJsonValue(body, kind);

  if (!existingIsEmpty && incomingIsEmpty && !force) {
    return { ok: false, status: 409, error: `Refused to overwrite non-empty ${baseName} with an empty save. Retry with ?force=1 if this is intentional.` };
  }

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await fsp.writeFile(tmpPath, body, 'utf-8');
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return { ok: true };
}

// ─── Automated backups ─────────────────────────────────────────────────────
// Writes a full, restorable snapshot (same shape as the manual "Export Backup"
// file, so it can be imported straight back) into <repo root>/backups on a
// schedule the user controls from Settings. Runs entirely server-side so it
// keeps working whether or not an app window is open.
const AUTO_BACKUP_DEFAULTS = { enabled: true, intervalHours: 24, keep: 50 };

function coerceAutoBackupCfg(raw: unknown) {
  const cfg = { ...AUTO_BACKUP_DEFAULTS };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled === 'boolean') cfg.enabled = r.enabled;
    const hours = Number(r.intervalHours);
    if (Number.isFinite(hours) && hours >= 1) cfg.intervalHours = Math.min(24 * 30, Math.round(hours));
    const keep = Number(r.keep);
    if (Number.isFinite(keep) && keep >= 1) cfg.keep = Math.min(1000, Math.round(keep));
  }
  return cfg;
}

async function readJsonSafe(filePath: string, fallback: unknown) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function readJsonStrict<T>(filePath: string, expectedKind: 'object' | 'array', fallback: T): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, data: fallback };
    }
    return { ok: false, error: `Could not read ${path.basename(filePath)}: ${err?.message || err}` };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, data: fallback };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err: any) {
    return { ok: false, error: `Corrupt JSON in ${path.basename(filePath)}: ${err?.message || err}` };
  }

  if (expectedKind === 'array') {
    if (!Array.isArray(parsed)) return { ok: false, error: `Expected array in ${path.basename(filePath)}` };
  } else {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: `Expected object in ${path.basename(filePath)}` };
    }
  }

  return { ok: true, data: parsed as T };
}

const AUTO_BACKUP_PREFIX = 'planner-backup.';

async function pruneAutoBackups(outDir: string, keep: number) {
  try {
    const files = (await fsp.readdir(outDir))
      .filter(f => f.startsWith(AUTO_BACKUP_PREFIX) && f.endsWith('.json'))
      .sort(); // ISO timestamps sort chronologically
    for (let i = 0; i < files.length - keep; i++) {
      await fsp.unlink(path.join(outDir, files[i])).catch(() => {});
    }
  } catch {
    // nothing written yet
  }
}

async function writeAutoBackup(rootDir: string, username: string, reason: 'scheduled' | 'manual') {
  const p = autoBackupPaths(rootDir, username);
  const settingsRes = await readJsonStrict(p.settingsPath, 'object', {});
  const eventsRes = await readJsonStrict(p.dbPath, 'object', {});
  const sessionsRes = await readJsonStrict(p.sessionsPath, 'array', []);
  const tasksRes = await readJsonStrict(p.tasksPath, 'object', {});

  if (!settingsRes.ok || !eventsRes.ok || !sessionsRes.ok || !tasksRes.ok) {
    const err = [settingsRes, eventsRes, sessionsRes, tasksRes].find(r => !r.ok)?.error || 'Corrupted source file';
    console.warn(`[autoBackup] Aborting backup for user "${username}" due to corrupt source file: ${err}`);
    return { ok: false as const, error: err, reason: err };
  }

  const settings = settingsRes.data as Record<string, unknown>;
  const events = eventsRes.data as Record<string, unknown>;
  const focusSessions = sessionsRes.data as unknown[];
  const tasks = tasksRes.data as Record<string, unknown>;

  const cfg = coerceAutoBackupCfg(settings.autoBackup);

  // A planner can have no events and still have settings/history worth backing up.
  const eventCount = events && typeof events === 'object' && !Array.isArray(events)
    ? Object.keys(events).length
    : 0;

  const payload = {
    // v3 adds `tasks`. Readers must accept 2 (no tasks) and 3.
    backupFormatVersion: 3,
    exportedAt: new Date().toISOString(),
    user: username,
    source: reason,
    events,
    settings,
    focusSessions,
    tasks,
  };

  await fsp.mkdir(p.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(p.outDir, `${AUTO_BACKUP_PREFIX}${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  await pruneAutoBackups(p.outDir, cfg.keep);
  await fsp.writeFile(p.statePath, JSON.stringify({ lastBackupAt: new Date().toISOString() }, null, 2), 'utf-8').catch(() => {});
  return { ok: true as const, file: path.basename(file), count: eventCount };
}

async function maybeRunAutoBackup(rootDir: string) {
  const { users } = await loadAccessConfig(rootDir);
  for (const u of users) {
    try {
      const p = autoBackupPaths(rootDir, u.username);
      const settings = await readJsonSafe(p.settingsPath, {});
      const cfg = coerceAutoBackupCfg((settings as Record<string, unknown>).autoBackup);
      if (!cfg.enabled) continue;
      const state = await readJsonSafe(p.statePath, {});
      const last = Date.parse((state as Record<string, string>).lastBackupAt || '');
      const dueAfterMs = cfg.intervalHours * 3600_000;
      if (Number.isFinite(last) && Date.now() - last < dueAfterMs) continue;
      await writeAutoBackup(rootDir, u.username, 'scheduled').catch(() => {});
    } catch (_) {}
  }
}

const rawPort = process.env.PORT || '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    // ── Precompress every build output ────────────────────────────────────
    // Nothing in this stack compressed responses, so the phone was pulling the
    // JS bundle and the stylesheet as raw bytes — roughly 3.5x more data than
    // necessary on a connection where data is exactly the problem. Compressing
    // at build time (rather than per request) means the server just picks a
    // file: no CPU cost per load, and Brotli can run at its slowest, smallest
    // setting because it only ever runs once.
    {
      name: 'precompress-build-output',
      apply: 'build',
      async closeBundle() {
        const zlib = await import('zlib');
        const { promisify } = await import('util');
        const brotli = promisify(zlib.brotliCompress);
        const gzip = promisify(zlib.gzip);
        const outDir = path.resolve(import.meta.dirname, 'dist/public');
        // Only text-ish assets benefit; PNG/ICO/WOFF2 are already compressed
        // and re-compressing them wastes space for a rounding error.
        const COMPRESSIBLE = /\.(js|css|html|json|webmanifest|svg|txt)$/i;

        const walk = async (dir: string): Promise<string[]> => {
          const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          const out: string[] = [];
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...await walk(full));
            else if (COMPRESSIBLE.test(entry.name)) out.push(full);
          }
          return out;
        };

        let saved = 0;
        for (const file of await walk(outDir)) {
          const raw = await fsp.readFile(file);
          // Below ~1 KB the headers cost more than the compression saves.
          if (raw.length < 1024) continue;
          const [br, gz] = await Promise.all([
            brotli(raw, {
              params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
              },
            }),
            gzip(raw, { level: 9 }),
          ]);
          await Promise.all([
            fsp.writeFile(`${file}.br`, br),
            fsp.writeFile(`${file}.gz`, gz),
          ]);
          saved += raw.length - br.length;
        }
        console.log(`[planner] precompressed bundle — ${(saved / 1024).toFixed(0)} KB less to send per cold load.`);
      },
    },
    {
      name: 'local-file-db-plugin',
      async configureServer(server) {
          const fs = await import('fs/promises');
          const path = await import('path');
          const rootDir = path.resolve(import.meta.dirname, '..', '..');
          await migrateLegacyDatabase(rootDir);

          // ── Compress JSON API responses ─────────────────────────────────
          // The phone pulls the whole event store, the focus history and the
          // settings on every open, and polls several of them afterwards —
          // well over 100 KB of JSON each time, sent raw. JSON compresses by
          // roughly 10x, so this is the difference between a usable and a
          // painful load on a weak mobile connection.
          //
          // Registered before every handler below so the patch is in place for
          // all of them, and written so it can only ever affect a one-shot
          // JSON reply: the moment a handler calls res.write (which is what the
          // live SSE streams do) this steps aside and never touches the socket.
          {
            const zlib = await import('zlib');
            const MIN_COMPRESS_BYTES = 1024;

            server.middlewares.use((req, res, next) => {
              const accepted = String(req.headers['accept-encoding'] || '');
              const encoding = accepted.includes('br')
                ? 'br'
                : accepted.includes('gzip')
                  ? 'gzip'
                  : null;
              if (!encoding) return next();

              let streamed = false;
              let declaredType = '';
              const originalWrite = res.write.bind(res);
              const originalEnd = res.end.bind(res);
              const originalWriteHead = res.writeHead.bind(res);

              res.writeHead = ((...writeHeadArgs: any[]) => {
                const headers = writeHeadArgs[writeHeadArgs.length - 1];
                if (headers && typeof headers === 'object') {
                  for (const [key, value] of Object.entries(headers)) {
                    if (key.toLowerCase() === 'content-type') declaredType = String(value);
                  }
                }
                return originalWriteHead(...(writeHeadArgs as [number]));
              }) as typeof res.writeHead;

              res.write = ((...writeArgs: any[]) => {
                streamed = true;
                return originalWrite(...(writeArgs as [any]));
              }) as typeof res.write;

              res.end = ((...endArgs: any[]) => {
                const chunk = endArgs[0];
                const contentType = String(declaredType || res.getHeader('Content-Type') || '');
                const eligible =
                  !streamed &&
                  !res.getHeader('Content-Encoding') &&
                  contentType.includes('application/json') &&
                  (typeof chunk === 'string' || Buffer.isBuffer(chunk));
                if (!eligible) return originalEnd(...(endArgs as [any]));

                const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
                if (raw.length < MIN_COMPRESS_BYTES) return originalEnd(...(endArgs as [any]));

                try {
                  // Quality 4 rather than 11: this runs per request, and past
                  // this point Brotli buys single-digit percentages for several
                  // times the CPU. The build-time assets are the ones worth 11.
                  const body = encoding === 'br'
                    ? zlib.brotliCompressSync(raw, {
                        params: {
                          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
                          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
                        },
                      })
                    : zlib.gzipSync(raw, { level: 6 });
                  res.setHeader('Content-Encoding', encoding);
                  res.setHeader('Vary', 'Accept-Encoding');
                  res.setHeader('Content-Length', String(body.length));
                  return originalEnd(body);
                } catch (_) {
                  // Compression must never be the reason a reply fails to send.
                  return originalEnd(...(endArgs as [any]));
                }
              }) as typeof res.end;

              next();
            });
          }

          const syncHealthMap = new Map<string, any>();
          function getUserSyncHealth(username: string) {
            const safe = sanitizeUsername(username);
            let h = syncHealthMap.get(safe);
            if (!h) {
              h = {
                auth: { ok: true, needsReconnect: false, error: null, at: 0 },
                calendar: { lastRunAt: 0, lastOkAt: 0, pushed: 0, pulled: 0, deleted: 0, incomplete: false, error: null },
                tasks:    { lastRunAt: 0, lastOkAt: 0, pushed: 0, pulled: 0, deleted: 0, incomplete: false, error: null, skipped: null },
              };
              syncHealthMap.set(safe, h);
            }
            return h;
          }

          // The desktop widget is rendered by WebView2 while the main app is
          // rendered by Chrome. Those engines deliberately keep separate cookie
          // jars, so a normal browser session cannot be shared between them.
          //
          // A widget therefore registers a 256-bit, process-local pairing id.
          // Once the signed-in main app sees that registration, it assigns the
          // current account to it. The widget then receives a separate cookie
          // that is valid only while its pairing registration stays alive. No
          // password or main-session token is ever put in the widget URL or on
          // a process command line.
          const WIDGET_SESSION_COOKIE = 'planner_widget_session';
          const WIDGET_ID_RE = /^[a-f0-9]{64}$/;
          const WIDGET_REGISTRATION_TTL_MS = 30_000;
          const BROWSER_HANDOFF_TTL_MS = 30_000;
          type WidgetRegistration = {
            username?: string;
            expiresAt: number;
          };
          const widgetRegistrations = new Map<string, WidgetRegistration>();
          const browserHostHandoffs = new Map<string, { username: string; expiresAt: number }>();

          const persistentCookie = (name: string, value: string) => {
            // This server deliberately uses HTTP on loopback, so `Secure` would
            // make the browser discard the cookie. It is otherwise host-only,
            // HttpOnly and SameSite=Lax; both Max-Age and Expires are supplied
            // so Chrome/WebView2 persist the login reliably across restarts.
            const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toUTCString();
            return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; Expires=${expires}; HttpOnly; SameSite=Lax`;
          };

          const expiredCookie = (name: string) =>
            `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`;

          const isLocalDesktopRequest = (req: any) => {
            // Do not trust an X-Forwarded-For value supplied by a browser. The
            // pairing bridge is intentionally available only to the desktop
            // processes connected directly to this computer's loopback server.
            if (req.headers?.['x-forwarded-for']) return false;
            const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
            return remote === '127.0.0.1' || remote === '::1';
          };

          const pruneWidgetRegistrations = () => {
            const now = Date.now();
            for (const [id, registration] of widgetRegistrations) {
              if (registration.expiresAt <= now) widgetRegistrations.delete(id);
            }
            for (const [ticket, handoff] of browserHostHandoffs) {
              if (handoff.expiresAt <= now) browserHostHandoffs.delete(ticket);
            }
          };

          const readJsonBody = (req: any): Promise<any> => new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (chunk: Buffer | string) => { body += chunk; });
            req.on('end', () => {
              try {
                resolve(JSON.parse(body || '{}'));
              } catch (error) {
                reject(error);
              }
            });
            req.on('error', reject);
          });

          const readCookie = (req: any, name: string): string | null => {
            const cookieHeader = String(req.headers?.cookie || '');
            const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
            if (!match) return null;
            try {
              return decodeURIComponent(match[1]);
            } catch (_) {
              return null;
            }
          };

          const getRequestUser = (req: any, users: AppUser[]): AppUser | null => {
            const regularUser = getAuthUser(req, users);
            if (regularUser) return regularUser;

            pruneWidgetRegistrations();
            const widgetId = readCookie(req, WIDGET_SESSION_COOKIE);
            const username = widgetId && widgetRegistrations.get(widgetId)?.username;
            return username ? users.find(user => user.username === username) || null : null;
          };

          const clearWidgetPairingsFor = (username: string) => {
            for (const registration of widgetRegistrations.values()) {
              if (registration.username === username) delete registration.username;
            }
          };

          // The one endpoint that answers before any authentication, so a device
          // that cannot sign in can still be asked the only question that
          // matters: is this a network fault or a wrong password? Sign-in used
          // to fail with a single opaque line, and the real cause (the phone's
          // network, not the server) took a day to find.
          server.middlewares.use('/api/ping', (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ ok: true, at: Date.now() }));
          });

          // ── Multi-User Session Authentication Endpoints ──────────────────
          server.middlewares.use('/api/auth/me', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const { users } = await loadAccessConfig(rootDir);
            const user = getRequestUser(req, users);
            if (!user) {
              res.end(JSON.stringify({ authenticated: false }));
              return;
            }
            // Renew a normal browser session when the app is opened. This
            // upgrades older pre-expiry tokens without prompting again and
            // keeps an actively used desktop profile remembered for another
            // year. Widget cookies are deliberately excluded: their lifetime
            // is governed by the live desktop-pairing registration instead.
            if (readCookie(req, SESSION_COOKIE)) {
              res.setHeader('Set-Cookie', persistentCookie(
                SESSION_COOKIE,
                createSessionToken(user.username, user.password),
              ));
            }
            res.end(JSON.stringify({
              authenticated: true,
              user: { username: user.username, name: user.name || user.username },
            }));
          });

          server.middlewares.use('/api/auth/login', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              try {
                const { username, password, widgetId } = JSON.parse(body || '{}');
                const cleanUser = sanitizeUsername(username);
                const { users } = await loadAccessConfig(rootDir);
                const matched = users.find(u => u.username === cleanUser && u.password === password);
                if (!matched) {
                  res.statusCode = 401;
                  res.end(JSON.stringify({ error: 'Invalid username or password' }));
                  return;
                }
                await ensureUserDb(rootDir, matched.username);
                pruneWidgetRegistrations();
                const validWidgetId = typeof widgetId === 'string' && WIDGET_ID_RE.test(widgetId)
                  ? widgetId
                  : null;
                const widgetRegistration = validWidgetId && isLocalDesktopRequest(req)
                  ? widgetRegistrations.get(validWidgetId) || { expiresAt: 0 }
                  : undefined;
                if (validWidgetId && widgetRegistration) {
                  widgetRegistration.username = matched.username;
                  widgetRegistration.expiresAt = Date.now() + WIDGET_REGISTRATION_TTL_MS;
                  widgetRegistrations.set(validWidgetId, widgetRegistration);
                  res.setHeader(
                    'Set-Cookie',
                    persistentCookie(WIDGET_SESSION_COOKIE, validWidgetId),
                  );
                } else {
                  const sessionToken = createSessionToken(matched.username, matched.password);
                  res.setHeader(
                    'Set-Cookie',
                    persistentCookie(SESSION_COOKIE, sessionToken),
                  );
                }
                res.end(JSON.stringify({
                  success: true,
                  user: { username: matched.username, name: matched.name || matched.username },
                }));
              } catch {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid login payload' }));
              }
            });
          });

          server.middlewares.use('/api/auth/logout', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const { users } = await loadAccessConfig(rootDir);
            const user = getRequestUser(req, users);
            if (user) clearWidgetPairingsFor(user.username);
            res.setHeader('Set-Cookie', [
              expiredCookie(SESSION_COOKIE),
              expiredCookie(WIDGET_SESSION_COOKIE),
            ]);
            res.end(JSON.stringify({ success: true }));
          });

          // `localhost` and `127.0.0.1` have independent cookie jars in every
          // browser. This one-time bridge lets an already signed-in legacy
          // 127.0.0.1 page move to the canonical localhost address without
          // revealing or putting its existing HttpOnly cookie in JavaScript.
          server.middlewares.use('/api/auth/host-handoff', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            if (!isLocalDesktopRequest(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Browser handoff is local only' }));
              return;
            }
            const { users } = await loadAccessConfig(rootDir);
            const user = getRequestUser(req, users);
            if (!user) {
              res.statusCode = 401;
              res.end(JSON.stringify({ authenticated: false }));
              return;
            }
            pruneWidgetRegistrations();
            const ticket = crypto.randomBytes(32).toString('hex');
            browserHostHandoffs.set(ticket, {
              username: user.username,
              expiresAt: Date.now() + BROWSER_HANDOFF_TTL_MS,
            });
            res.end(JSON.stringify({ ticket }));
          });

          server.middlewares.use('/api/auth/claim-host-handoff', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            if (!isLocalDesktopRequest(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Browser handoff is local only' }));
              return;
            }
            try {
              const { ticket } = await readJsonBody(req);
              pruneWidgetRegistrations();
              const handoff = typeof ticket === 'string' ? browserHostHandoffs.get(ticket) : undefined;
              // Consume before responding: each random ticket is single-use,
              // even if a duplicate request races this one.
              if (typeof ticket === 'string') browserHostHandoffs.delete(ticket);
              const { users } = await loadAccessConfig(rootDir);
              const user = handoff ? users.find(candidate => candidate.username === handoff.username) : null;
              if (!user) {
                res.statusCode = 401;
                res.end(JSON.stringify({ authenticated: false }));
                return;
              }
              res.setHeader('Set-Cookie', persistentCookie(
                SESSION_COOKIE,
                createSessionToken(user.username, user.password),
              ));
              res.end(JSON.stringify({
                authenticated: true,
                user: { username: user.username, name: user.name || user.username },
              }));
            } catch (_) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid handoff payload' }));
            }
          });

          async function requireAuth(req: any, res: any) {
            const { users } = await loadAccessConfig(rootDir);
            const user = getRequestUser(req, users);
            if (!user) {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Authentication required' }));
              return null;
            }
            const userPaths = await ensureUserDb(rootDir, user.username);
            const syncHealth = getUserSyncHealth(user.username);
            return { user, userPaths, syncHealth };
          }

          // Register, pair and claim make up the desktop-only cookie bridge.
          // They are deliberately separate: the unauthenticated widget can only
          // register its random id; only an already authenticated local main app
          // can assign a user to that id.
          server.middlewares.use('/api/widget-auth/register', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            if (!isLocalDesktopRequest(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Desktop pairing is local only' }));
              return;
            }
            try {
              const { widgetId } = await readJsonBody(req);
              if (typeof widgetId !== 'string' || !WIDGET_ID_RE.test(widgetId)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid widget pairing id' }));
                return;
              }
              pruneWidgetRegistrations();
              const registration = widgetRegistrations.get(widgetId) || { expiresAt: 0 };
              registration.expiresAt = Date.now() + WIDGET_REGISTRATION_TTL_MS;
              widgetRegistrations.set(widgetId, registration);
              res.end(JSON.stringify({ registered: true, paired: Boolean(registration.username) }));
            } catch (_) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid registration payload' }));
            }
          });

          server.middlewares.use('/api/widget-auth/activate', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            if (!isLocalDesktopRequest(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Desktop pairing is local only' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            pruneWidgetRegistrations();
            let paired = 0;
            for (const registration of widgetRegistrations.values()) {
              registration.username = auth.user.username;
              paired++;
            }
            res.end(JSON.stringify({ success: true, paired }));
          });

          server.middlewares.use('/api/widget-auth/claim', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            if (!isLocalDesktopRequest(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: 'Desktop pairing is local only' }));
              return;
            }
            try {
              const { widgetId } = await readJsonBody(req);
              pruneWidgetRegistrations();
              const registration = typeof widgetId === 'string' && WIDGET_ID_RE.test(widgetId)
                ? widgetRegistrations.get(widgetId)
                : undefined;
              const { users } = await loadAccessConfig(rootDir);
              const user = registration?.username
                ? users.find(candidate => candidate.username === registration.username)
                : null;
              if (!user) {
                res.statusCode = 401;
                res.end(JSON.stringify({ authenticated: false }));
                return;
              }
              res.setHeader(
                'Set-Cookie',
                persistentCookie(WIDGET_SESSION_COOKIE, widgetId),
              );
              res.end(JSON.stringify({
                authenticated: true,
                user: { username: user.username, name: user.name || user.username },
              }));
            } catch (_) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid claim payload' }));
            }
          });

          // ── Crash-proof "open in editor" ─────────────────────────────────
          // Vite 7's launchEditor calls onErrorCallback() on its Windows UNC-path
          // guard, but Vite registers /__open-in-editor without that callback, so
          // on Windows the request throws "onErrorCallback is not a function" and
          // the runtime-error overlay renders it as a scary crash. Plugin
          // middlewares register before Vite's built-in handler, so this shadows
          // it: open the file best-effort, never let the request crash the server.
          server.middlewares.use('/__open-in-editor', (req, res) => {
            (async () => {
              try {
                const { spawn } = await import('child_process');
                const raw = new URL(req.url || '', 'http://localhost').searchParams.get('file') || '';
                // Strip a trailing :line:col and any file:// prefix, then keep only
                // real, existing local files (skips blank/URL/UNC frames that trip Vite).
                const fileOnly = raw.replace(/^file:\/\//, '').replace(/:\d+(:\d+)?$/, '');
                const abs = path.resolve(server.config.root, fileOnly);
                if (fileOnly && !abs.startsWith('\\\\') && (await fs.stat(abs).then(() => true).catch(() => false))) {
                  const editor = process.env.VISUAL || process.env.EDITOR || 'code';
                  spawn(editor, [abs], { stdio: 'ignore', detached: true, shell: true }).unref();
                }
              } catch (err) {
                console.warn('[open-in-editor] ignored:', (err as Error)?.message);
              } finally {
                res.statusCode = 204;
                res.end();
              }
            })();
          });

          /** Live OAuth `state` nonces, keyed by value (CSRF protection). */
          const pendingOAuthStates = new Map();

          /** Errors where retrying with the same refresh token can never work. */
          const FATAL_OAUTH_ERRORS = new Set([
            'invalid_grant',        // expired, revoked, or password changed
            'invalid_client',       // client id/secret wrong
            'unauthorized_client',
            'invalid_request',
          ]);

          async function markAuthBroken(userPaths: any, syncHealth: any, reason: string, needsReconnect: boolean) {
            syncHealth.auth = { ok: false, needsReconnect, error: reason, at: Date.now() };
            if (!needsReconnect) return;
            // Persist it so a dev-server restart doesn't go back to claiming the
            // connection is fine, and so the UI can ask for a reconnect on boot.
            try {
              const toks = JSON.parse(await fs.readFile(userPaths.tokensPath, 'utf-8'));
              if (toks.invalid === reason) return;
              toks.invalid = reason;
              toks.invalidAt = Date.now();
              await safeWriteJsonFile({
                filePath: userPaths.tokensPath, backupDir: userPaths.backupDir, baseName: 'google-tokens',
                body: JSON.stringify(toks), kind: 'object', force: true,
              });
            } catch (_) {}
          }

          async function markAuthOk(syncHealth: any) {
            syncHealth.auth = { ok: true, needsReconnect: false, error: null, at: Date.now() };
          }

          // Single-flight refresh: several syncs (calendar + tasks + a manual run)
          // can want a token at the same moment, and three parallel refreshes of
          // the same grant is how you get Google to start rejecting them.
          const userRefreshInFlight = new Map<string, Promise<any>>();

          async function refreshAccessToken(config: any, tokens: any, userPaths: any, syncHealth: any) {
            const params = new URLSearchParams();
            params.append('client_id', config.clientId);
            params.append('client_secret', config.clientSecret);
            params.append('refresh_token', tokens.refresh_token);
            params.append('grant_type', 'refresh_token');

            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params.toString(),
            });

            const raw = await tokenRes.text();
            if (!tokenRes.ok) {
              let code = '';
              let description = '';
              try {
                const parsed = JSON.parse(raw);
                code = parsed.error || '';
                description = parsed.error_description || '';
              } catch (_) {}
              const fatal = FATAL_OAUTH_ERRORS.has(code);
              const reason = description || code || `HTTP ${tokenRes.status}`;
              await markAuthBroken(
                userPaths,
                syncHealth,
                fatal ? `Google rejected the saved authorisation (${reason}). Reconnect to fix.` : `Token refresh failed: ${reason}`,
                fatal,
              );
              console.error('[google] token refresh failed:', tokenRes.status, raw.slice(0, 300));
              return null;
            }

            const tokenData = JSON.parse(raw);
            tokens.access_token = tokenData.access_token;
            if (tokenData.refresh_token) tokens.refresh_token = tokenData.refresh_token;
            tokens.expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;
            // Record which scopes this token actually carries. Tokens minted before
            // Tasks support have calendar-only scope, and every Tasks call made with
            // one 403s — persisting this is how the UI knows to ask for a reconnect.
            if (tokenData.scope) tokens.scope = tokenData.scope;
            // A successful refresh clears any previous "reconnect me" flag.
            delete tokens.invalid;
            delete tokens.invalidAt;

            await safeWriteJsonFile({
              filePath: userPaths.tokensPath,
              backupDir: userPaths.backupDir,
              baseName: 'google-tokens',
              body: JSON.stringify(tokens),
              kind: 'object',
              force: true,
            });
            await markAuthOk(syncHealth);
            return tokens.access_token;
          }

          /**
           * Access token, refreshed when stale. `force` throws away a cached token
           * that Google has started 401ing on mid-run.
           */
          async function getGoogleTokenForUser(userPaths: any, syncHealth: any, force = false) {
            try {
              let config: any = null;
              let tokens: any = null;
              try {
                config = JSON.parse(await fs.readFile(userPaths.configPath, 'utf-8'));
              } catch (_) {}
              try {
                tokens = JSON.parse(await fs.readFile(userPaths.tokensPath, 'utf-8'));
              } catch (_) {}

              if (!config || !config.clientId || !tokens || !tokens.refresh_token) {
                // Not connected or not configured — normal unlinked state, not a broken auth error
                return null;
              }

              const now = Date.now();
              if (!force && tokens.expires_at && now < tokens.expires_at - 60000) {
                if (!tokens.invalid) await markAuthOk(syncHealth);
                return tokens.access_token;
              }

              const usernameKey = userPaths.safeName || 'default';
              let inFlight = userRefreshInFlight.get(usernameKey);
              if (!inFlight) {
                inFlight = refreshAccessToken(config, tokens, userPaths, syncHealth)
                  .finally(() => { userRefreshInFlight.delete(usernameKey); });
                userRefreshInFlight.set(usernameKey, inFlight);
              }
              return await inFlight;
            } catch (err) {
              console.error('Error in getGoogleTokenForUser:', err);
              return null;
            }
          }

          /**
           * One Google API call with the retries the previous code had none of.
           */
          async function gfetchForUser(userPaths: any, syncHealth: any, url: string, init: any = {}, opts: any = {}) {
            const { tries = 3, label = 'google' } = opts;
            let token = await getGoogleTokenForUser(userPaths, syncHealth);
            if (!token) return null;

            for (let attempt = 0; attempt < tries; attempt++) {
              let res = null;
              try {
                res = await fetch(url, {
                  ...init,
                  headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
                });
              } catch (err) {
                if (attempt === tries - 1) {
                  console.error(`[google] ${label} network failure:`, (err as Error)?.message);
                  return null;
                }
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                continue;
              }

              if (res.status === 401 && attempt < tries - 1) {
                const fresh = await getGoogleTokenForUser(userPaths, syncHealth, true);
                if (!fresh) return res; // reconnect needed — reported by getGoogleToken
                token = fresh;
                continue;
              }
              if ((res.status === 429 || res.status >= 500) && attempt < tries - 1) {
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
                continue;
              }
              return res;
            }
            return null;
          }

          // Maps Google event to PlannerEvent. `parseRecur` (from recurrence.ts)
          // turns a Google recurrence array into { recur, exdates } so a repeating
          // event round-trips as a single master.
          function mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseRecur, palettes, calHex, targetCalendarId) {
            const isAllDay = !!gEv.start.date;
            const { recur, exdates } = gEv.recurrence ? parseRecur(gEv.recurrence) : {};
            const gCalHex = resolveGoogleHex(gEv, palettes, calHex || {});
            const colorFromId = gEv.colorId ? GOOGLE_COLOR_ID_TO_SWATCH[gEv.colorId] : null;
            const isDailyCal = targetCalendarId && gEv.gCalCalendarId === targetCalendarId;
            const resolvedColor = colorFromId || (isDailyCal ? 'sage' : mapGoogleColor(gEv.gCalCalendarId));

            if (isAllDay) {
              const startD = new Date(gEv.start.date + 'T00:00:00');
              const endD = new Date(gEv.end.date + 'T00:00:00');
              const daysSpan = Math.max(1, differenceInDays(endD, startD));

              const weekStartDate = startOfWeek(startD, { weekStartsOn: weekStartsOnOpt });
              const weekKey = format(weekStartDate, 'yyyy-MM-dd');
              const dayIndex = differenceInDays(startD, weekStartDate);

              return {
                id: `gcal-${gEv.gCalId}`,
                dayIndex,
                startTime: '00:00',
                endTime: '00:30',
                content: gEv.summary,
                color: resolvedColor,
                ...(gCalHex ? { gCalHex } : {}),
                allDay: true,
                daysSpan,
                weekKey,
                ...(recur ? { recur } : {}),
                ...(exdates ? { exdates } : {}),
                gCalId: gEv.gCalId,
                gCalCalendarId: gEv.gCalCalendarId,
                gCalETag: gEv.gCalETag
              };
            } else {
              const startD = new Date(gEv.start.dateTime);
              const endD = new Date(gEv.end.dateTime);

              const weekStartDate = startOfWeek(startD, { weekStartsOn: weekStartsOnOpt });
              const weekKey = format(weekStartDate, 'yyyy-MM-dd');
              const dayIndex = differenceInDays(startD, weekStartDate);

              const startTime = format(startD, 'HH:mm');
              const endTime = format(endD, 'HH:mm');

              return {
                id: `gcal-${gEv.gCalId}`,
                dayIndex,
                startTime,
                endTime,
                content: gEv.summary,
                color: resolvedColor,
                ...(gCalHex ? { gCalHex } : {}),
                weekKey,
                ...(recur ? { recur } : {}),
                ...(exdates ? { exdates } : {}),
                gCalId: gEv.gCalId,
                gCalCalendarId: gEv.gCalCalendarId,
                gCalETag: gEv.gCalETag
              };
            }
          }

          // Google's own colour for an event, as a hex string.
          //
          // Precedence matches what Google Calendar itself renders:
          //   1. the event's own `colorId` (the 11-entry *event* palette), else
          //   2. the colour of the calendar it lives on.
          const SWATCH_TO_GOOGLE_COLOR_ID: Record<string, string> = {
            lavender: '1',
            sage: '2',
            lilac: '3',
            rose: '4',
            sand: '5',
            peach: '6',
            teal: '7',
            blue: '9',
            emerald: '10',
            coral: '11',
          };

          const GOOGLE_COLOR_ID_TO_SWATCH: Record<string, string> = {
            '1': 'lavender',
            '2': 'sage',
            '3': 'lilac',
            '4': 'rose',
            '5': 'sand',
            '6': 'peach',
            '7': 'teal',
            '8': 'sand',
            '9': 'blue',
            '10': 'emerald',
            '11': 'coral',
          };

          function resolveGoogleHex(gEv, palettes, calHex) {
            if (gEv.colorId && palettes && palettes.event && palettes.event[gEv.colorId]) {
              return palettes.event[gEv.colorId].background;
            }
            return calHex[gEv.gCalCalendarId] || null;
          }

          /** What an app-owned event falls back to when its colour can't be recovered. */
          const OWNED_DEFAULT_COLOR = 'sage';

          function mapGoogleColor(calendarId) {
            const colors = ['sage', 'peach', 'blue', 'sand', 'lilac'];
            let hash = 0;
            for (let i = 0; i < calendarId.length; i++) {
              hash = calendarId.charCodeAt(i) + ((hash << 5) - hash);
            }
            return colors[Math.abs(hash) % colors.length];
          }

          // Build the Google event body for an app-owned event. The first occurrence
          // is the master's anchor (weekKey + dayIndex); repetition (if any) comes
          // from `ev.recur` via buildGoogleRecurrence, so app and Google agree 1:1.
          function constructGoogleEventBody(ev, format, addDays, buildRecur, plannerId) {
            const weekStartDate = new Date((ev.weekKey || '0000-01-01') + 'T00:00:00');
            const eventDate = addDays(weekStartDate, ev.dayIndex || 0);
            const dateStr = format(eventDate, 'yyyy-MM-dd');
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
            const recurrence = ev.recur ? buildRecur(ev, tz) : undefined;
            const googleColorId = ev.color ? SWATCH_TO_GOOGLE_COLOR_ID[ev.color] : undefined;

            if (ev.allDay) {
              const endDate = addDays(eventDate, ev.daysSpan || 1);
              const body: any = {
                summary: ev.content || 'Untitled',
                start: { date: dateStr },
                end: { date: format(endDate, 'yyyy-MM-dd') }
              };
              if (googleColorId) body.colorId = googleColorId;
              if (recurrence) body.recurrence = recurrence;
              stampPlannerId(body, plannerId || ev.id);
              return body;
            } else {
              const [sh, sm] = (ev.startTime || '00:00').split(':').map(Number);
              const [eh, em] = (ev.endTime || ev.startTime || '00:30').split(':').map(Number);
              const startDate = new Date(eventDate); startDate.setHours(sh, sm, 0, 0);
              const isOvernight = eh < sh || (eh === sh && em <= sm);
              const endDay = isOvernight ? addDays(new Date(eventDate), 1) : new Date(eventDate);
              const endDate = new Date(endDay); endDate.setHours(eh, em, 0, 0);
              const body: any = {
                summary: ev.content || 'Untitled',
                start: { dateTime: startDate.toISOString(), timeZone: tz },
                end: { dateTime: endDate.toISOString(), timeZone: tz }
              };
              if (googleColorId) body.colorId = googleColorId;
              if (recurrence) body.recurrence = recurrence;
              stampPlannerId(body, plannerId || ev.id);
              return body;
            }
          }

          // Every event this app writes to Google carries the local record id it came
          // from. That link survives even if the local record loses its gCalId, which is
          // what lets us clean up orphans instead of re-importing them as new items.
          function stampPlannerId(body, plannerId) {
            if (!plannerId) return;
            body.extendedProperties = { private: { plannerId: String(plannerId) } };
          }

          // The concrete calendar date of a single-week event (for sync-window filtering).
          // Recurring ('all') events return null — they are always "in window".
          function eventOccurrenceDate(ev, addDays) {
            if (ev.recur || !ev.weekKey) return null;
            const weekStartDate = new Date(ev.weekKey + 'T00:00:00');
            return addDays(weekStartDate, ev.dayIndex || 0);
          }

          // ── Google Tasks sync ──────────────────────────────────────────────
          // Mirrors runGoogleSync's contract: returns the IDENTICAL input object
          // when it bails, so the endpoint knows not to persist.
          //
          // Two API limits shape everything here:
          //   • `due` is date-only — "the time portion of the timestamp is
          //     discarded… It isn't possible to read or write the time that a task
          //     is scheduled for using the API". Time travels as a `⏰ HH:MM`
          //     marker line in `notes` (see lib/tasks.ts).
          //   • There is NO recurrence field. The repeat rule lives only in the
          //     planner; Google holds exactly ONE task per series — the next due
          //     occurrence — which the roll-forward pass advances.
          const TASK_LIST_TITLE = 'Daily Tasks';
          const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';
          const userTasksSyncing = new Set<string>();

          async function runGoogleTasksSync(userPaths: any, syncHealth: any, clientTasks: any, todayYmdOpt: any, weekStartsOnOpt = 0) {
            const userName = userPaths.safeName || 'default';
            const tokensPath = userPaths.tokensPath;
            const backupDir = userPaths.backupDir;
            const getGoogleToken = (force = false) => getGoogleTokenForUser(userPaths, syncHealth, force);
            const gfetch = (url: string, init: any = {}, opts: any = {}) => gfetchForUser(userPaths, syncHealth, url, init, opts);

            if (userTasksSyncing.has(userName)) {
              syncHealth.tasks.skipped = 'A tasks sync was already running';
              return clientTasks;
            }
            userTasksSyncing.add(userName);
            syncHealth.tasks.lastRunAt = Date.now();
            syncHealth.tasks.error = null;
            syncHealth.tasks.skipped = null;
            let pushed = 0;
            let pushFailures = 0;
            try {
              const accessToken = await getGoogleToken();
              if (!accessToken) {
                if (syncHealth.auth.needsReconnect) {
                  syncHealth.tasks.error = syncHealth.auth.error || 'Google connection needs reconnect';
                } else {
                  syncHealth.tasks.error = null;
                }
                return clientTasks;
              }

              try {
                const toks = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));
                if (!String(toks.scope || '').includes('/auth/tasks')) {
                  syncHealth.tasks.skipped = 'The Google connection has no Tasks permission';
                  return clientTasks;
                }
              } catch (_) {
                return clientTasks;
              }

              const { addDays, differenceInDays, format, startOfWeek } = await import('date-fns');
              const {
                composeTaskNotes, parseTaskNotes, nextOpenOccurrence, dueDateOf,
              } = await server.ssrLoadModule('/src/lib/tasks.ts');
              const { weekKeyOf } = await server.ssrLoadModule('/src/lib/recurrence.ts');

              // Write a due date onto a task in the anchor form the app stores
              // (weekKey + dayIndex). Doing it here rather than shipping a
              // `dueDate` field back keeps one representation of the date.
              const setDue = (t, ymd) => {
                if (!ymd) return { ...t, weekKey: undefined, dayIndex: undefined };
                const d = new Date(`${ymd}T00:00:00`);
                return {
                  ...t,
                  weekKey: weekKeyOf(d, weekStartsOnOpt),
                  dayIndex: differenceInDays(d, startOfWeek(d, { weekStartsOn: weekStartsOnOpt })),
                };
              };

              // gfetch attaches the Authorization header (and refreshes it on a
              // mid-run 401), so callers only carry the content type.
              const jsonCT = { 'Content-Type': 'application/json' };
              const today = todayYmdOpt || format(new Date(), 'yyyy-MM-dd');
              const now = Date.now();
              const localMap = { ...clientTasks };
              let changed = false;

              // ── 0. Find (or create) the "Daily Tasks" list ─────────────────
              let listId = null;
              let pageToken = '';
              do {
                const res = await gfetch(`${TASKS_API}/users/@me/lists?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`, {}, { label: 'taskLists' });
                if (!res || !res.ok) {
                  if (res && res.status === 403) {
                    throw new Error('Google Tasks Permission Denied (403): Re-link Google Account in Settings to grant Tasks scope');
                  }
                  throw new Error(`Failed to list task lists: ${res ? res.status : 'no response'}`);
                }
                const data = await res.json();
                for (const l of data.items || []) if (l.title === TASK_LIST_TITLE) listId = l.id;
                pageToken = data.nextPageToken || '';
              } while (pageToken && !listId);

              if (!listId) {
                const res = await gfetch(`${TASKS_API}/users/@me/lists`, {
                  method: 'POST', headers: jsonCT, body: JSON.stringify({ title: TASK_LIST_TITLE }),
                }, { label: 'createTaskList' });
                if (!res || !res.ok) throw new Error(`Failed to create task list: ${res ? res.status : 'no response'}`);
                listId = (await res.json()).id;
              }

              // ── 1. Fetch every task in the list ────────────────────────────
              // maxResults caps at 100 here (Calendar allows 2500), so the
              // pageToken loop is mandatory, not an optimisation.
              const remote = new Map();
              let fetchIncomplete = false;
              pageToken = '';
              do {
                const url = `${TASKS_API}/lists/${listId}/tasks?maxResults=100&showCompleted=true&showHidden=true${pageToken ? `&pageToken=${pageToken}` : ''}`;
                const res = await gfetch(url, {}, { label: 'listTasks' });
                if (!res || !res.ok) { fetchIncomplete = true; break; }
                const data = await res.json();
                for (const t of data.items || []) {
                  if (t.deleted) continue;
                  remote.set(t.id, t);
                }
                pageToken = data.nextPageToken || '';
              } while (pageToken);

              // ── 2. Dedupe: never let two local records own one Google task ──
              const byGTaskId = new Map();
              for (const t of Object.values(localMap)) {
                if (!t.gTaskId || t.deleted) continue;
                const prev = byGTaskId.get(t.gTaskId);
                const score = r => (r.lastSyncedAt || 0) + (r.updatedAt || 0);
                if (!prev) { byGTaskId.set(t.gTaskId, t); continue; }
                const loser = score(t) >= score(prev) ? prev : t;
                byGTaskId.set(t.gTaskId, score(t) >= score(prev) ? t : prev);
                localMap[loser.id] = { ...loser, gTaskId: undefined, gTaskETag: undefined, gTaskSeriesDate: undefined };
                changed = true;
              }

              const justPushed = new Set();
              const seenGTaskIds = new Set();
              const locallyDirty = t => !!t.updatedAt && (!t.lastSyncedAt || t.updatedAt > t.lastSyncedAt);

              const deleteRemote = async (id) => {
                const res = await gfetch(`${TASKS_API}/lists/${listId}/tasks/${id}`, { method: 'DELETE' }, { label: 'deleteTask' });
                return !!res && (res.ok || res.status === 404 || res.status === 410);
              };
              const patchRemote = async (id, body) => {
                const res = await gfetch(`${TASKS_API}/lists/${listId}/tasks/${id}`, {
                  method: 'PATCH', headers: jsonCT, body: JSON.stringify(body),
                }, { label: 'patchTask' });
                if (res && res.ok) { pushed++; return await res.json(); }
                pushFailures++;
                console.error(`[google] task PATCH failed: ${res ? res.status + ' ' + (await res.text()) : 'no response'}`);
                return null;
              };
              const insertRemote = async (body, parentId) => {
                const url = `${TASKS_API}/lists/${listId}/tasks${parentId ? `?parent=${encodeURIComponent(parentId)}` : ''}`;
                const res = await gfetch(url, { method: 'POST', headers: jsonCT, body: JSON.stringify(body) }, { label: 'insertTask' });
                if (res && res.ok) { pushed++; return await res.json(); }
                pushFailures++;
                console.error(`[google] task insert failed: ${res ? res.status + ' ' + (await res.text()) : 'no response'}`);
                return null;
              };
              // Google normalises `due` and throws the time away; only ever read the
              // date half back out.
              const dueBody = ymd => (ymd ? `${ymd}T00:00:00.000Z` : null);
              const bodyFor = (t, ymd) => ({
                title: t.title || 'Untitled task',
                notes: composeTaskNotes(t),
                ...(ymd ? { due: dueBody(ymd) } : {}),
                status: 'needsAction',
              });

              // ── A. Local deletions → Google ────────────────────────────────
              for (const t of Object.values(localMap)) {
                if (!t.deleted) continue;
                if (t.gTaskId) {
                  if (!(await deleteRemote(t.gTaskId))) continue; // retry next run
                  remote.delete(t.gTaskId);
                }
                delete localMap[t.id];
                changed = true;
              }

              // ── B. Local creates / updates → Google ────────────────────────
              // Repeating masters are skipped: pass R owns their single live task.
              // Parents before children so a subtask always has a parent to attach to.
              const pushable = Object.values(localMap)
                .filter(t => !t.deleted && !t.recur)
                .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));

              for (const t of pushable) {
                const cur = localMap[t.id];
                if (!cur || cur.deleted || cur.recur) continue;
                const ymd = dueDateOf(cur);

                if (!cur.gTaskId) {
                  // Weak re-adoption: Tasks has no extendedProperties, so there is no
                  // plannerId to match on. Title + due is the best available signal
                  // against creating a duplicate of a task we already pushed.
                  const orphan = [...remote.values()].find(g =>
                    !seenGTaskIds.has(g.id) && !byGTaskId.has(g.id)
                    && g.title === (cur.title || 'Untitled task')
                    && (g.due ? g.due.slice(0, 10) : null) === ymd);
                  const created = orphan || await insertRemote(bodyFor(cur, ymd), cur.parentId ? localMap[cur.parentId]?.gTaskId : undefined);
                  if (!created) continue;
                  localMap[t.id] = { ...cur, gTaskId: created.id, gTaskListId: listId, gTaskETag: created.etag, lastSyncedAt: now };
                  remote.set(created.id, created);
                  seenGTaskIds.add(created.id);
                  justPushed.add(created.id);
                  changed = true;
                  continue;
                }

                seenGTaskIds.add(cur.gTaskId);
                const g = remote.get(cur.gTaskId);
                if (!g) continue; // handled by pass E / re-created next run

                if (locallyDirty(cur)) {
                  // PATCH, not PUT: fields we don't model (position, links,
                  // assignmentInfo) must survive our write untouched.
                  const updated = await patchRemote(cur.gTaskId, {
                    ...bodyFor(cur, ymd),
                    status: cur.completed ? 'completed' : 'needsAction',
                    ...(ymd ? {} : { due: null }),
                  });
                  if (!updated) continue;
                  localMap[t.id] = { ...cur, gTaskETag: updated.etag, lastSyncedAt: now };
                  remote.set(updated.id, updated);
                  justPushed.add(cur.gTaskId);
                  changed = true;
                }
              }

              // ── C. Pull Google → local ────────────────────────────────────
              const claimed = new Set(Object.values(localMap).map(t => t.gTaskId).filter(Boolean));
              for (const g of remote.values()) {
                if (justPushed.has(g.id)) continue;

                const local = Object.values(localMap).find(t => t.gTaskId === g.id);
                if (!local) {
                  if (claimed.has(g.id)) continue;
                  // New on Google. A "repeating" task made in the Google UI arrives
                  // as N unrelated one-off tasks with no recurrence field — each
                  // imports as its own dated task. We never infer `recur` from
                  // Google, so no existing series can be corrupted.
                  const { startTime, endTime, body } = parseTaskNotes(g.notes);
                  const dueYmd = g.due ? g.due.slice(0, 10) : null;
                  const id = `gtask-${g.id}`;
                  localMap[id] = setDue({
                    id,
                    title: g.title || 'Untitled task',
                    notes: body || undefined,
                    // A time is only meaningful with a date to anchor it to.
                    ...(startTime && dueYmd ? { startTime, endTime: endTime || undefined } : {}),
                    completed: g.status === 'completed',
                    gTaskId: g.id,
                    gTaskListId: listId,
                    gTaskETag: g.etag,
                    gTaskParentId: g.parent || undefined,
                    updatedAt: now,
                    lastSyncedAt: now,
                  }, dueYmd);
                  seenGTaskIds.add(g.id);
                  changed = true;
                  continue;
                }

                seenGTaskIds.add(g.id);
                if (local.recur) continue;             // pass R owns repeating series
                if (locallyDirty(local)) continue;     // local wins when newer
                if (local.gTaskETag === g.etag) continue;

                const { startTime, endTime, body } = parseTaskNotes(g.notes);
                const dueYmd = g.due ? g.due.slice(0, 10) : null;
                localMap[local.id] = setDue({
                  ...local,
                  title: g.title || local.title,
                  notes: body || undefined,
                  // A missing marker is NOT an instruction to clear the time — an
                  // unrelated edit on the phone must not silently unschedule a task.
                  ...(startTime ? { startTime, endTime: endTime || local.endTime } : {}),
                  completed: g.status === 'completed',
                  gTaskETag: g.etag,
                  gTaskParentId: g.parent || undefined,
                  lastSyncedAt: now,
                }, dueYmd);
                changed = true;
              }

              // ── R. Roll repeating series forward ──────────────────────────
              for (const master of Object.values(localMap)) {
                if (!master.recur || master.deleted) continue;
                let m = { ...master };
                const live = m.gTaskId ? remote.get(m.gTaskId) : null;
                let cur = m.gTaskSeriesDate || null;
                let needsRoll = !m.gTaskId;
                const done = new Set(m.completedDates || []);

                // 1. Completed on the phone.
                if (live && live.status === 'completed' && cur) {
                  if (!done.has(cur)) {
                    m.completedDates = [...done, cur].sort();
                    m.updatedAt = now;
                  }
                  needsRoll = true;
                // 2. Completed in the planner. Under the PATCH strategy we skip
                //    marking it completed first — the very next PATCH re-dates and
                //    reopens it, so the phone never observes the intermediate state.
                } else if (cur && done.has(cur)) {
                  needsRoll = true;
                // 3. Un-completed in the planner → reopen, and cancel the roll.
                } else if (cur && !done.has(cur) && live && live.status === 'completed') {
                  const reopened = await patchRemote(m.gTaskId, { status: 'needsAction' });
                  if (reopened) { m.gTaskETag = reopened.etag; m.lastSyncedAt = now; }
                  needsRoll = false;
                }

                // 4. Deleted on the phone → skip THIS occurrence, never end the
                //    series. Skipped entirely when the fetch was incomplete: a
                //    transient 500 must never EXDATE a day.
                if (m.gTaskId && !live && !fetchIncomplete) {
                  if (cur && !done.has(cur)) {
                    m.exdates = [...new Set([...(m.exdates || []), cur])].sort();
                    m.updatedAt = now;
                  }
                  m.gTaskId = undefined; m.gTaskETag = undefined; m.gTaskSeriesDate = undefined;
                  cur = null;
                  needsRoll = true;
                }

                // 5. Edited on the phone.
                if (live && live.etag !== m.gTaskETag && !locallyDirty(m)) {
                  const { startTime, endTime, body } = parseTaskNotes(live.notes);
                  m.title = live.title || m.title;
                  m.notes = body || undefined;
                  if (startTime) { m.startTime = startTime; m.endTime = endTime || m.endTime; }

                  const dueYmd = live.due ? live.due.slice(0, 10) : null;
                  if (dueYmd && cur && dueYmd !== cur) {
                    // A one-off reschedule of THIS occurrence: EXDATE it out of the
                    // series and hand the Google task to a detached standalone copy.
                    // Mirrors the unlocked-detach semantics of editSeries.
                    m.exdates = [...new Set([...(m.exdates || []), cur])].sort();
                    const detachedId = `gtask-detached-${live.id}`;
                    localMap[detachedId] = setDue({
                      ...m,
                      id: detachedId,
                      recur: undefined, exdates: undefined, locked: undefined,
                      completedDates: undefined, seriesDone: undefined,
                      gTaskId: live.id, gTaskListId: listId, gTaskETag: live.etag,
                      gTaskSeriesDate: undefined,
                      updatedAt: now, lastSyncedAt: now,
                    }, dueYmd);
                    m.gTaskId = undefined; m.gTaskETag = undefined; m.gTaskSeriesDate = undefined;
                    cur = null;
                    needsRoll = true;
                  } else {
                    m.gTaskETag = live.etag;
                    m.lastSyncedAt = now;
                  }
                  m.updatedAt = now;
                }

                // 6. Roll to the next open occurrence.
                if (needsRoll) {
                  // Scan from today, or the day after the occurrence just retired —
                  // whichever is LATER. This is what collapses "offline for three
                  // weeks" into ONE push instead of one per missed day. Missed
                  // occurrences stay uncompleted locally and surface under Overdue.
                  const after = cur ? format(addDays(new Date(`${cur}T00:00:00`), 1), 'yyyy-MM-dd') : today;
                  const from = after > today ? after : today;
                  const next = nextOpenOccurrence(m, from);

                  if (!next) {
                    if (m.gTaskId) { await deleteRemote(m.gTaskId); remote.delete(m.gTaskId); }
                    m.gTaskId = undefined; m.gTaskETag = undefined; m.gTaskSeriesDate = undefined;
                    m.seriesDone = true;
                  } else if (m.gTaskId && cur === next) {
                    // Already correct — nothing to do.
                  } else {
                    const body = bodyFor(m, next);
                    const res = m.gTaskId
                      ? await patchRemote(m.gTaskId, body)
                      : await insertRemote(body, m.parentId ? localMap[m.parentId]?.gTaskId : undefined);
                    if (res) {
                      // State written LAST, only on success: a crash before this
                      // point simply re-derives on the next run.
                      m.gTaskId = res.id;
                      m.gTaskListId = listId;
                      m.gTaskETag = res.etag;
                      m.gTaskSeriesDate = next;
                      m.lastSyncedAt = now;
                      remote.set(res.id, res);
                      seenGTaskIds.add(res.id);
                    }
                  }
                }

                if (JSON.stringify(m) !== JSON.stringify(master)) {
                  localMap[master.id] = m;
                  changed = true;
                }
                if (m.gTaskId) seenGTaskIds.add(m.gTaskId);
              }

              // ── E. Mirror Google-side deletions ───────────────────────────
              // Skipped wholesale on an incomplete fetch — the same policy the
              // calendar sync uses, and for the same reason.
              if (!fetchIncomplete) {
                for (const t of Object.values(localMap)) {
                  if (!t.gTaskId || t.recur || t.deleted) continue;
                  if (justPushed.has(t.gTaskId) || seenGTaskIds.has(t.gTaskId)) continue;
                  if (remote.has(t.gTaskId)) continue;
                  delete localMap[t.id];
                  changed = true;
                }
              }

              syncHealth.tasks.pushed = pushed;
              syncHealth.tasks.incomplete = fetchIncomplete;
              syncHealth.tasks.error = pushFailures
                ? `${pushFailures} task change${pushFailures === 1 ? '' : 's'} could not be sent to Google`
                : fetchIncomplete
                  ? 'Google returned an incomplete task list; deletions were not mirrored this run'
                  : null;
              if (!pushFailures && !fetchIncomplete) syncHealth.tasks.lastOkAt = Date.now();

              // Returning the identical reference is the signal to the endpoint
              // that nothing needs persisting.
              if (!changed) return clientTasks;
              return localMap;
            } catch (err) {
              syncHealth.tasks.error = err && err.message ? err.message : String(err);
              console.error('Google Tasks sync failed:', err);
              return clientTasks;
            } finally {
              userTasksSyncing.delete(userName);
            }
          }

          // Main sync logic
          const userCalendarSyncing = new Set<string>();
          async function runGoogleSync(userPaths: any, syncHealth: any, clientEvents: any, weekStartsOnOpt = 0, policyOpts: any = null) {
            const userName = userPaths.safeName || 'default';
            const tokensPath = userPaths.tokensPath;
            const settingsPath = userPaths.settingsPath;
            const dbPath = userPaths.dbPath;
            const backupDir = userPaths.backupDir;
            const getGoogleToken = (force = false) => getGoogleTokenForUser(userPaths, syncHealth, force);
            const gfetch = (url: string, init: any = {}, opts: any = {}) => gfetchForUser(userPaths, syncHealth, url, init, opts);

            if (userCalendarSyncing.has(userName)) {
              console.log(`Sync already in progress for ${userName}. Skipping concurrent run.`);
              return clientEvents;
            }
            userCalendarSyncing.add(userName);
            syncHealth.calendar.lastRunAt = Date.now();
            syncHealth.calendar.error = null;
            let pushed = 0;
            let pushFailures = 0;
            try {
              const accessToken = await getGoogleToken();
              if (!accessToken) {
                if (syncHealth.auth.needsReconnect) {
                  syncHealth.calendar.error = syncHealth.auth.error || 'Google connection needs reconnect';
                } else {
                  syncHealth.calendar.error = null;
                }
                return clientEvents;
              }

              // Load settings from disk and merge explicit policyOpts passed in
              let policy = {
                gcalPushEnabled: true,
                gcalPushTarget: 'daily',
                gcalPushOtherCalendars: true,
                gcalPullDailyEdits: false,
                gcalPullDailyNew: false,
                gcalPullOtherCalendars: true,
                gcalMirrorLocalDeletions: true,
                gcalMirrorGoogleDeletions: false,
              };
              try {
                const storedSettings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
                policy = { ...policy, ...storedSettings, ...(policyOpts || {}) };
              } catch (_) {
                policy = { ...policy, ...(policyOpts || {}) };
              }

              const { format, startOfWeek, addDays, differenceInDays } = await import('date-fns');
              // Load the app's own recurrence formatting so app↔Google mapping stays
              // in one place (no duplicated RRULE logic drifting out of sync).
              const { buildGoogleRecurrence, parseGoogleRecurrence } = await server.ssrLoadModule('/src/lib/recurrence.ts');

              // 1. Fetch calendar list
              const listRes = await gfetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {}, { label: 'calendarList' });
              if (!listRes || !listRes.ok) {
                throw new Error(`Failed to list calendars: ${listRes ? listRes.status + ' ' + listRes.statusText : 'no response'}`);
              }
              const listData = await listRes.json();
              const calendars = listData.items || [];

              // Google's actual colours, so pulled events look exactly as they do in
              // Google Calendar. The calendar list already carries each calendar's
              // own colour; the /colors palette is only needed to resolve an event's
              // per-event `colorId` override. A failure here is not fatal — events
              // simply fall back to the app's own swatches.
              let palettes = null;
              try {
                const colorsRes = await gfetch('https://www.googleapis.com/calendar/v3/colors', {}, { label: 'colors' });
                if (colorsRes && colorsRes.ok) palettes = await colorsRes.json();
              } catch (err) {
                console.error('Failed to fetch Google colour palette:', err);
              }

              const calHex = {};
              for (const c of calendars) {
                const fromPalette = c.colorId && palettes && palettes.calendar
                  && palettes.calendar[c.colorId] && palettes.calendar[c.colorId].background;
                const hex = c.backgroundColor || fromPalette;
                if (hex) calHex[c.id] = hex;
              }

              // 2. Find or create target calendar ("Daily calendar" vs Primary)
              let targetCalendarId = '';
              if (policy.gcalPushTarget === 'primary') {
                const primaryCal = calendars.find(c => c.primary);
                if (primaryCal) targetCalendarId = primaryCal.id;
              }
              if (!targetCalendarId) {
                let targetCal = calendars.find(c => c.summary === 'Daily calendar');
                if (targetCal) {
                  targetCalendarId = targetCal.id;
                } else {
                  const createRes = await gfetch('https://www.googleapis.com/calendar/v3/calendars', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ summary: 'Daily calendar' })
                  }, { label: 'createCalendar' });
                  if (!createRes || !createRes.ok) throw new Error('Failed to create Daily calendar');
                  const created = await createRes.json();
                  targetCalendarId = created.id;
                }
              }

              // 3. Define sync window (from 60 days ago to 180 days in the future).
              const timeMinMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
              const timeMaxMs = Date.now() + 180 * 24 * 60 * 60 * 1000;
              const timeMin = new Date(timeMinMs).toISOString();
              const timeMax = new Date(timeMaxMs).toISOString();

              // 4. Fetch events (paginated).
              //    • Daily calendar → singleEvents=false: we get the master records (incl.
              //      RRULE masters) whose ids match what the app created, so a recurring app
              //      event round-trips 1:1 instead of exploding into per-occurrence copies.
              //    • Every other calendar → singleEvents=true: each occurrence is expanded
              //      into its own read-only item so every event shows up in the app.
              // Set true if ANY calendar/page fetch fails. When the snapshot is
              // incomplete we cannot safely conclude "not seen ⇒ deleted on Google",
              // so step E (deletion mirroring) is skipped to avoid wiping local events
              // on a transient error (rate-limit, token blip, network hiccup).
              let fetchIncomplete = false;
              async function fetchCalendarEvents(calId, singleEvents) {
                const out = [];
                let pageToken = '';
                do {
                  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
                    + `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
                    + `&singleEvents=${singleEvents ? 'true' : 'false'}&showDeleted=false&maxResults=2500`
                    + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
                  const res = await gfetch(url, {}, { label: `events:${calId}` });
                  if (!res || !res.ok) { fetchIncomplete = true; break; }
                  const data = await res.json();
                  for (const item of (data.items || [])) {
                    if (item.status === 'cancelled') continue;
                    out.push({
                      gCalId: item.id,
                      gCalCalendarId: calId,
                      gCalETag: item.etag,
                      summary: item.summary || '',
                      start: item.start,
                      end: item.end,
                      recurrence: item.recurrence || null,
                      description: item.description || '',
                      // Event-level colour override ("1".."11" in Google's event
                      // palette). Absent means the event just wears its calendar's
                      // colour, which we resolve from the calendar list instead.
                      colorId: item.colorId || null,
                      // Set by constructGoogleEventBody on every event this app creates.
                      // Lets us recognise our own event even when the local record lost
                      // its gCalId (create-then-delete-mid-sync), instead of pulling it
                      // back in as a brand-new foreign-looking copy.
                      plannerId: (item.extendedProperties && item.extendedProperties.private
                        && item.extendedProperties.private.plannerId) || null
                    });
                  }
                  pageToken = data.nextPageToken || '';
                } while (pageToken);
                return out;
              }

              const dailyGoogleEvents = [];
              const otherGoogleEvents = [];
              for (const cal of calendars) {
                try {
                  const evs = await fetchCalendarEvents(cal.id, cal.id !== targetCalendarId);
                  const bucket = cal.id === targetCalendarId ? dailyGoogleEvents : otherGoogleEvents;
                  for (const e of evs) bucket.push(e);
                } catch (err) {
                  fetchIncomplete = true;
                  console.error(`Failed to fetch events for calendar ${cal.id}:`, err);
                }
              }

              let localMap = { ...clientEvents };
              const nowMs = Date.now();

              // Every gCalId still known to exist on Google after this run (fetched, created,
              // or updated). Any local event whose gCalId is absent here has been removed on
              // Google and gets mirrored away locally (step E).
              const seenGCalIds = new Set();
              for (const e of dailyGoogleEvents) seenGCalIds.add(e.gCalId);
              for (const e of otherGoogleEvents) seenGCalIds.add(e.gCalId);

              // Daily events indexed by the local record that authored them. A create
              // that was deleted before its sync round-trip finished leaves a Google
              // event whose local record no longer knows the gCalId; this index is how
              // we still find it.
              const dailyByPlannerId = new Map();
              for (const e of dailyGoogleEvents) {
                if (e.plannerId) dailyByPlannerId.set(e.plannerId, e);
              }
              async function deleteFromGoogle(gCalId) {
                try {
                  const delRes = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(gCalId)}`, {
                    method: 'DELETE',
                  }, { label: 'deleteEvent' });
                  if (delRes && (delRes.ok || delRes.status === 404 || delRes.status === 410)) {
                    seenGCalIds.delete(gCalId);
                    return true;
                  }
                } catch (err) {
                  console.error(`Failed to delete event ${gCalId} from Google:`, err);
                }
                return false;
              }

              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

              // A. Mirror local deletions to Google (governed by gcalMirrorLocalDeletions)
              for (const [id, ev] of Object.entries(localMap)) {
                if (!ev.deleted) continue;
                if (!policy.gcalMirrorLocalDeletions) {
                  delete localMap[id];
                  continue;
                }
                if (ev.gCalId && ev.gCalCalendarId === targetCalendarId) {
                  if (await deleteFromGoogle(ev.gCalId)) delete localMap[id];
                } else {
                  // No gCalId locally, but this record may still have authored a Google
                  // event: the create's round-trip landed after the delete. Match by the
                  // plannerId stamp and remove the orphan, otherwise the next pull would
                  // re-import it as a new item at Google's own date/colour.
                  const orphan = !ev.gCalId ? dailyByPlannerId.get(id) : null;
                  if (orphan) {
                    await deleteFromGoogle(orphan.gCalId);
                    dailyByPlannerId.delete(id);
                  }
                  delete localMap[id];
                }
              }

              // B. Push app-owned creates/updates to Google
              // Records we create/update on Google in this pass. The Daily calendar was
              // fetched at the very start (before these writes), so its snapshot is stale
              // for exactly these ids — we must NOT reconcile them against it in step C,
              // or we'd overwrite the change we just pushed with its pre-push state (the
              // "new item / new repeat vanishes then reappears" bug).
              const justPushed = new Set();
              for (const [id, ev] of Object.entries(localMap)) {
                if (ev.deleted) continue;
                const isForeign = ev.gCalId && ev.gCalCalendarId && ev.gCalCalendarId !== targetCalendarId;
                if (isForeign) {
                  if (!policy.gcalPushOtherCalendars) continue;
                  if (ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt)) {
                    try {
                      const body = constructGoogleEventBody(ev, format, addDays, buildGoogleRecurrence, id);
                      const updRes = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ev.gCalCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                      }, { label: 'updateForeignEvent' });
                      if (updRes && updRes.ok) {
                        const updated = await updRes.json();
                        localMap[id] = { ...ev, gCalETag: updated.etag, lastSyncedAt: nowMs };
                        justPushed.add(id);
                        pushed++;
                      }
                    } catch (err) {
                      console.error(`Failed to update foreign event ${ev.gCalId} on Google:`, err);
                    }
                  }
                  continue;
                }

                if (!policy.gcalPushEnabled) continue;

                if (!ev.gCalId && dailyByPlannerId.has(id)) {
                  // We already created this record on Google in an earlier run; the local
                  // copy just lost the link (a POST /api/events overwrote the annotated
                  // map mid-sync). Re-adopt it instead of inserting a second copy.
                  const existing = dailyByPlannerId.get(id);
                  localMap[id] = {
                    ...ev,
                    gCalId: existing.gCalId,
                    gCalCalendarId: targetCalendarId,
                    gCalETag: existing.gCalETag
                  };
                  continue;
                }

                if (!ev.gCalId) {
                  try {
                    const body = constructGoogleEventBody(ev, format, addDays, buildGoogleRecurrence, id);
                    const insRes = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    }, { label: 'insertEvent' });
                    if (insRes && insRes.ok) {
                      const created = await insRes.json();
                      localMap[id] = { ...ev, gCalId: created.id, gCalCalendarId: targetCalendarId, gCalETag: created.etag, lastSyncedAt: nowMs };
                      seenGCalIds.add(created.id);
                      justPushed.add(id);
                      pushed++;
                    } else {
                      pushFailures++;
                      const detail = insRes ? `${insRes.status} - ${await insRes.text()}` : 'no response';
                      console.error(`Google API insert failed for event ${id}: ${detail}`);
                    }
                  } catch (err) {
                    console.error(`Failed to create local event ${id} on Google:`, err);
                  }
                }
                else if (ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt)) {
                  try {
                    const body = constructGoogleEventBody(ev, format, addDays, buildGoogleRecurrence, id);
                    const updRes = await gfetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    }, { label: 'updateEvent' });
                    if (updRes && updRes.ok) {
                      const updated = await updRes.json();
                      localMap[id] = { ...ev, gCalETag: updated.etag, lastSyncedAt: nowMs };
                      seenGCalIds.add(ev.gCalId);
                      justPushed.add(id);
                      pushed++;
                    } else if (updRes && (updRes.status === 404 || updRes.status === 410)) {
                      // Gone on Google — but only trust that when the snapshot was
                      // complete; a half-fetched run must not delete local records.
                      seenGCalIds.delete(ev.gCalId);
                      if (!fetchIncomplete) delete localMap[id];
                      else localMap[id] = { ...ev, gCalId: undefined, gCalETag: undefined, lastSyncedAt: undefined };
                    } else {
                      pushFailures++;
                      const detail = updRes ? `${updRes.status} - ${await updRes.text()}` : 'no response';
                      console.error(`Google API update failed for event ${ev.gCalId}: ${detail}`);
                    }
                  } catch (err) {
                    console.error(`Failed to update event ${ev.gCalId} on Google:`, err);
                  }
                }
              }

              // Index local events by the Google id they map to.
              const localByGCalId = new Map();
              for (const [id, ev] of Object.entries(localMap)) {
                if (ev.gCalId) localByGCalId.set(ev.gCalId, id);
              }

              // C. Pull the Daily calendar back in — governed by gcalPullDailyEdits & gcalPullDailyNew
              for (const gEv of dailyGoogleEvents) {
                // Deleted during this run (step A orphan cleanup) — it no longer exists
                // on Google, so importing it back would resurrect what the user removed.
                if (!seenGCalIds.has(gEv.gCalId)) continue;
                const localId = localByGCalId.get(gEv.gCalId);
                if (!localId) {
                  if (!policy.gcalPullDailyNew) continue;
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex, targetCalendarId);
                  if (plannerEv) {
                    // Keep the original local id when this event came from the app, so it
                    // returns as itself rather than as a new "gcal-…" import.
                    if (gEv.plannerId) plannerEv.id = gEv.plannerId;

                    // ── The Daily calendar is APP-OWNED: the app owns the colour ──
                    // Google stores one colour for the whole calendar and knows
                    // nothing about our palette, so anything re-imported from here
                    // used to come back wearing that single calendar colour (or
                    // mapGoogleColor's arbitrary per-calendar hash). That is the
                    // "every sync turns my items purple" bug: it repaints on any
                    // re-import — an event whose local record lost its gCalId, a
                    // restored backup, or an item created before plannerId existed.
                    //
                    // Precedence: the colour this item already has locally → an
                    // explicit per-event colour set in Google (a deliberate choice,
                    // unlike the calendar default) → the app's default swatch.
                    const existing = localMap[plannerEv.id];
                    delete plannerEv.gCalHex;
                    const perEventHex = gEv.colorId && palettes && palettes.event && palettes.event[gEv.colorId]
                      ? palettes.event[gEv.colorId].background
                      : null;
                    if (existing && existing.color) {
                      plannerEv.color = existing.color;
                      if (existing.gCalHex) plannerEv.gCalHex = existing.gCalHex;
                    } else if (perEventHex) {
                      plannerEv.gCalHex = perEventHex;
                    } else {
                      plannerEv.color = OWNED_DEFAULT_COLOR;
                    }

                    plannerEv.lastSyncedAt = nowMs;
                    localMap[plannerEv.id] = plannerEv;
                    localByGCalId.set(gEv.gCalId, plannerEv.id);
                  }
                  continue;
                }
                const ev = localMap[localId];
                if (!ev || ev.deleted) continue; // never resurrect a locally-deleted record
                if (justPushed.has(localId)) continue; // we authored this in step B; snapshot is stale
                
                if (!policy.gcalPullDailyEdits) continue;

                // A local edit we just pushed wins this round; only pull when Google is ahead.
                const locallyDirty = ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt);
                if (!locallyDirty && ev.gCalETag !== gEv.gCalETag) {
                  const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex, targetCalendarId);
                  if (g) {
                    // Daily events are app-owned: the app is the source of truth for
                    // colour (Google doesn't store our palette, so mapGoogleColor would
                    // clobber the user's choice — e.g. green → lilac). Keep ev.color.
                    localMap[localId] = { ...ev, ...g, id: localId, color: ev.color, gCalHex: ev.gCalHex, recur: g.recur, exdates: g.exdates, completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                  }
                }
              }

              // D. Pull read-only events from every other calendar (governed by gcalPullOtherCalendars)
              if (policy.gcalPullOtherCalendars) {
                for (const gEv of otherGoogleEvents) {
                  const localId = localByGCalId.get(gEv.gCalId);
                  if (!localId) {
                    const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex, targetCalendarId);
                    if (plannerEv) {
                      plannerEv.lastSyncedAt = nowMs;
                      localMap[plannerEv.id] = plannerEv;
                      localByGCalId.set(gEv.gCalId, plannerEv.id);
                    }
                  } else {
                    const ev = localMap[localId];
                    if (ev && !ev.deleted && ev.gCalETag !== gEv.gCalETag) {
                      const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex, targetCalendarId);
                      if (g) {
                        localMap[localId] = { ...ev, ...g, id: localId, recur: g.recur, exdates: g.exdates, completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                      }
                    } else if (ev && !ev.deleted) {
                      // Unchanged on Google, so nothing above re-maps it — but records
                      // synced before colours were supported carry no hex at all. Fill it
                      // in (and follow a recolour) without touching anything else.
                      const hex = resolveGoogleHex(gEv, palettes, calHex);
                      if (hex && ev.gCalHex !== hex) localMap[localId] = { ...ev, gCalHex: hex };
                    }
                  }
                }
              }

              // E. Mirror Google-side deletions (governed by gcalMirrorGoogleDeletions)
              if (policy.gcalMirrorGoogleDeletions && !fetchIncomplete) {
                for (const [id, ev] of Object.entries(localMap)) {
                  if (!ev.gCalId || ev.deleted) continue;
                  if (justPushed.has(id)) continue; // just created/updated; not in the stale fetch
                  if (seenGCalIds.has(ev.gCalId)) continue;
                  if (!ev.recur) {
                    const d = eventOccurrenceDate(ev, addDays);
                    if (d) {
                      const t = d.getTime();
                      if (t < timeMinMs || t > timeMaxMs) continue;
                    }
                  }
                  delete localMap[id];
                }
              }

              syncHealth.calendar.pushed = pushed;
              syncHealth.calendar.incomplete = fetchIncomplete;
              syncHealth.calendar.error = pushFailures
                ? `${pushFailures} change${pushFailures === 1 ? '' : 's'} could not be sent to Google`
                : fetchIncomplete
                  ? 'Google returned an incomplete snapshot; deletions were not mirrored this run'
                  : null;
              if (!pushFailures && !fetchIncomplete) syncHealth.calendar.lastOkAt = Date.now();
              return localMap;
            } catch (err) {
              syncHealth.calendar.error = err && err.message ? err.message : String(err);
              throw err;
            } finally {
              userCalendarSyncing.delete(userName);
            }
          }

          // Auth endpoints
          server.middlewares.use('/api/google-auth/status', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths, syncHealth } = auth;

            try {
              let configured = false;
              let clientId = '';
              let clientSecret = '';
              let autoSync = false;
              try {
                const conf = JSON.parse(await fs.readFile(userPaths.configPath, 'utf-8'));
                clientId = conf.clientId || '';
                clientSecret = conf.clientSecret || '';
                autoSync = !!conf.autoSync;
                configured = !!(clientId && clientSecret);
              } catch (_) {}

              let authenticated = false;
              let email = '';
              let hasTasksScope = false;
              let storedInvalid = null;
              try {
                const toks = JSON.parse(await fs.readFile(userPaths.tokensPath, 'utf-8'));
                authenticated = !!toks.refresh_token;
                email = toks.email || '';
                hasTasksScope = String(toks.scope || '').includes('/auth/tasks');
                storedInvalid = toks.invalid || null;
              } catch (_) {}

              if (authenticated && !storedInvalid && !syncHealth.auth.needsReconnect) {
                await getGoogleTokenForUser(userPaths, syncHealth);
                try {
                  const fresh = JSON.parse(await fs.readFile(userPaths.tokensPath, 'utf-8'));
                  storedInvalid = fresh.invalid || null;
                  hasTasksScope = String(fresh.scope || '').includes('/auth/tasks');
                } catch (_) {}
              }

              const needsReconnect = !!storedInvalid || syncHealth.auth.needsReconnect;
              const authError = syncHealth.auth.error || storedInvalid || null;

              res.end(JSON.stringify({
                configured,
                authenticated: authenticated && !needsReconnect,
                hasStoredToken: authenticated,
                needsReconnect,
                authError,
                email,
                autoSync,
                clientId,
                clientSecret,
                hasTasksScope,
                health: syncHealth,
              }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Failed to read auth status' }));
            }
          });

          server.middlewares.use('/api/google-auth/setup', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths } = auth;

            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              try {
                const payload = JSON.parse(body);
                const { clientId, clientSecret, autoSync } = payload;
                if (!clientId || !clientSecret) {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: 'Missing Client ID or Client Secret' }));
                  return;
                }
                await safeWriteJsonFile({
                  filePath: userPaths.configPath,
                  backupDir: userPaths.backupDir,
                  baseName: 'google-config',
                  body: JSON.stringify({ clientId, clientSecret, autoSync: !!autoSync }),
                  kind: 'object',
                  force: true
                });
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Failed to save settings' }));
              }
            });
          });

          server.middlewares.use('/api/google-auth/url', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths } = auth;

            try {
              const config = JSON.parse(await fs.readFile(userPaths.configPath, 'utf-8'));
              const redirectUri = new URL(req.url || '', 'http://localhost').searchParams.get('redirectUri');
              if (!redirectUri) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing redirectUri parameter' }));
                return;
              }

              let parsed;
              try {
                parsed = new URL(redirectUri);
              } catch (_) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: `Not a valid redirect URI: ${redirectUri}` }));
                return;
              }
              const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
              if (parsed.protocol !== 'https:' && !isLoopback) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: `Google only accepts https:// or loopback redirect URIs; got ${redirectUri}` }));
                return;
              }
              const bothHosts = isLoopback
                ? ['localhost', '127.0.0.1'].map(h => `${parsed.protocol}//${h}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname === '/' ? '' : parsed.pathname}`)
                : [redirectUri];

              const state = crypto.randomUUID();
              pendingOAuthStates.set(state, { at: Date.now(), redirectUri });
              for (const [k, v] of pendingOAuthStates) {
                if (Date.now() - v.at > 15 * 60 * 1000) pendingOAuthStates.delete(k);
              }
              const scope = [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/tasks',
              ].join(' ');
              const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
                + `?client_id=${encodeURIComponent(config.clientId)}`
                + `&redirect_uri=${encodeURIComponent(redirectUri)}`
                + '&response_type=code'
                + `&scope=${encodeURIComponent(scope)}`
                + '&access_type=offline'
                + '&prompt=consent'
                + '&include_granted_scopes=true'
                + `&state=${encodeURIComponent(state)}`;
              res.end(JSON.stringify({ url: authUrl, redirectUri, authorizedRedirectUris: bothHosts }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'OAuth configuration not found. Please setup credentials first.' }));
            }
          });

          server.middlewares.use('/api/google-auth/exchange', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths, syncHealth } = auth;

            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              try {
                const { code, redirectUri, state } = JSON.parse(body);
                const config = JSON.parse(await fs.readFile(userPaths.configPath, 'utf-8'));

                if (state) {
                  const pending = pendingOAuthStates.get(state);
                  if (!pending) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ error: 'This sign-in link has expired or did not come from this app. Start the connection again.' }));
                    return;
                  }
                  pendingOAuthStates.delete(state);
                }

                const params = new URLSearchParams();
                params.append('code', code);
                params.append('client_id', config.clientId);
                params.append('client_secret', config.clientSecret);
                params.append('redirect_uri', redirectUri);
                params.append('grant_type', 'authorization_code');

                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: params.toString()
                });

                if (!tokenRes.ok) {
                  const errText = await tokenRes.text();
                  let hint = '';
                  if (errText.includes('redirect_uri_mismatch')) {
                    hint = ` — add exactly "${redirectUri}" to the OAuth client's Authorized redirect URIs in Google Cloud Console.`;
                  } else if (errText.includes('invalid_client')) {
                    hint = ' — the Client ID or Client Secret does not match the OAuth client.';
                  }
                  console.error('[google] token exchange failed:', errText.slice(0, 400));
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: `Token exchange failed${hint}`, detail: errText.slice(0, 400) }));
                  return;
                }

                const tokenData = await tokenRes.json();
                const tokens = {
                  access_token: tokenData.access_token,
                  refresh_token: tokenData.refresh_token,
                  expires_at: Date.now() + tokenData.expires_in * 1000,
                  scope: tokenData.scope || '',
                  email: ''
                };

                try {
                  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                  });
                  if (userRes.ok) {
                    const userInfo = await userRes.json();
                    tokens.email = userInfo.email || '';
                  }
                } catch (_) {}

                await safeWriteJsonFile({
                  filePath: userPaths.tokensPath,
                  backupDir: userPaths.backupDir,
                  baseName: 'google-tokens',
                  body: JSON.stringify(tokens),
                  kind: 'object',
                  force: true
                });

                await markAuthOk(syncHealth);
                syncHealth.calendar.error = null;
                syncHealth.tasks.error = null;
                syncHealth.tasks.skipped = null;
                res.end(JSON.stringify({ success: true, email: tokens.email }));
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Failed to exchange token code' }));
              }
            });
          });

          server.middlewares.use('/api/google-auth/disconnect', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths, syncHealth } = auth;

            try {
              await fs.unlink(userPaths.tokensPath).catch(() => {});
              await markAuthOk(syncHealth);
              res.end(JSON.stringify({ success: true }));
            } catch (_) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Failed to disconnect' }));
            }
          });

          server.middlewares.use('/api/google-sync', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths, syncHealth } = auth;

            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              let parsedPayload: any;
              try {
                parsedPayload = JSON.parse(body);
              } catch (parseErr) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: `Invalid JSON body: ${(parseErr as Error)?.message || parseErr}` }));
                return;
              }

              try {
                const { events: clientEvents, weekStartsOn: weekStartsOnOpt, settings: clientSettings } = parsedPayload;
                const synced = await runGoogleSync(userPaths, syncHealth, clientEvents, weekStartsOnOpt || 0, clientSettings);

                if (synced !== clientEvents) {
                  await safeWriteJsonFile({
                    filePath: userPaths.dbPath,
                    backupDir: userPaths.backupDir,
                    baseName: 'database',
                    body: JSON.stringify(synced),
                    kind: 'object',
                    force: true
                  });
                  // Google sync is the OTHER writer of this file. Nothing here
                  // went through /api/events, so without this the phone never
                  // learned about an event imported from Google — and the next
                  // rebuild after a phone push had no record of it at all.
                  syncService
                    .refresh(auth.user.username, syncPathsOf(userPaths))
                    .catch(err => console.error('[sync] gcal refresh failed:', err));
                }

                res.end(JSON.stringify({
                  success: !syncHealth.calendar.error && !syncHealth.auth.needsReconnect,
                  events: synced,
                  needsReconnect: syncHealth.auth.needsReconnect,
                  error: syncHealth.calendar.error || (syncHealth.auth.ok ? null : syncHealth.auth.error),
                  health: syncHealth.calendar,
                }));
              } catch (err) {
                console.error('Error in google-sync endpoint:', err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: `Sync failed: ${(err as Error)?.message || err}` }));
              }
            });
          });

          server.middlewares.use('/api/google-tasks-sync', async (req, res) => {
            res.setHeader('Content-Type', 'application/json');
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end(JSON.stringify({ error: 'Method not allowed' }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths, syncHealth } = auth;

            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              let parsedPayload: any;
              try {
                parsedPayload = JSON.parse(body);
              } catch (parseErr) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: `Invalid JSON body: ${(parseErr as Error)?.message || parseErr}` }));
                return;
              }

              try {
                const { tasks: clientTasks, today, weekStartsOn: wso } = parsedPayload;
                const synced = await runGoogleTasksSync(userPaths, syncHealth, clientTasks || {}, today, wso || 0);

                if (synced !== clientTasks) {
                  await safeWriteJsonFile({
                    filePath: userPaths.tasksPath,
                    backupDir: userPaths.backupDir,
                    baseName: 'tasks',
                    body: JSON.stringify(synced),
                    kind: 'object',
                    force: true,
                  });
                  syncService
                    .refresh(auth.user.username, syncPathsOf(userPaths))
                    .catch(err => console.error('[sync] gtasks refresh failed:', err));
                }

                res.end(JSON.stringify({
                  success: !syncHealth.tasks.error && !syncHealth.auth.needsReconnect,
                  tasks: synced,
                  needsReconnect: syncHealth.auth.needsReconnect,
                  error: syncHealth.tasks.error || syncHealth.tasks.skipped || (syncHealth.auth.ok ? null : syncHealth.auth.error),
                  health: syncHealth.tasks,
                }));
              } catch (err) {
                console.error('Error in google-tasks-sync endpoint:', err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: `Tasks sync failed: ${(err as Error)?.message || err}` }));
              }
            });
          });

          // --- Offline sync for the phone --------------------------------
          // Every route below is thin on purpose: parse, validate, hand to the
          // service, serialise the answer. All the reasoning lives in
          // sync-service.ts / sync-server.ts / src/lib/sync.ts, which are pure
          // and covered by four test suites.
          // ── Sync trace ────────────────────────────────────────────────
          // One line per sync request and per planner save, appended to
          // database/sync-trace.log. Reasoning about what the phone "must" be
          // doing has been wrong three times now; this makes it observable.
          // Cheap (one short line, fire and forget) and safe to leave on.
          const tracePath = path.resolve(rootDir, 'database', 'sync-trace.log');
          const trace = (line: string) => {
            const stamp = new Date().toTimeString().slice(0, 8);
            fsp.appendFile(tracePath, `${stamp}  ${line}\n`, 'utf-8').catch(() => {});
          };

          const syncService = createSyncService();

          const syncPathsOf = (userPaths: any): UserSyncPaths => ({
            dbDir: userPaths.dbDir,
            dbPath: userPaths.dbPath,
            tasksPath: userPaths.tasksPath,
            // Only the SHARED half of this file travels; the per-device and
            // desk-only keys in it are carried through untouched. See
            // settingsScope.ts for which is which.
            settingsPath: userPaths.settingsPath,
            // The focus history, so the phone can show how the time went.
            focusPath: userPaths.focusPath,
            prayerDonePath: userPaths.donePath,
            // Global rather than per-user: a public timetable, not anyone's data.
            prayerTimesPath: path.resolve(rootDir, 'database', 'prayer-times.json'),
          });

          const sendSyncJson = (res: any, status: number, payload: unknown) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
          };

          // --- Restarting the planner ------------------------------------
          // Closing the app window does not stop the server: the launcher starts
          // it in its own process group precisely so it survives the window. That
          // is right for normal use and wrong when the server's own code has
          // changed, which previously left no way to restart it without hunting
          // for a process.
          //
          // LOOPBACK ONLY, on top of the login. Restarting is not destructive,
          // but it is an action on the machine itself rather than on the planner
          // data, and nothing reachable from the public URL should be able to
          // take the server down.
          server.middlewares.use('/api/restart', async (req, res, next) => {
            if (req.method !== 'POST') return next();

            res.setHeader('Content-Type', 'application/json');
            if (!isLocalDesktopRequest(req)) {
              res.statusCode = 403;
              res.end(JSON.stringify({
                error: 'The planner can only be restarted from the PC it runs on.',
              }));
              return;
            }
            const auth = await requireAuth(req, res);
            if (!auth) return;

            const script = path.resolve(rootDir, 'tools', 'restart-planner.pyw');
            const pythonw = path.resolve(rootDir, '.venv-launcher', 'Scripts', 'pythonw.exe');

            try {
              await fsp.access(script);
            } catch {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'The restart helper is missing.' }));
              return;
            }

            try {
              const { spawn } = await import('child_process');
              let usable = pythonw;
              try {
                await fsp.access(pythonw);
              } catch {
                // Fall back to whatever pythonw is on PATH. Never `python`:
                // that one opens a console window, which is the single thing
                // this whole launcher chain exists to avoid.
                usable = 'pythonw.exe';
              }

              // Detached and unref'd on purpose. The child has to outlive this
              // process — it is about to kill it.
              const child = spawn(usable, [script], {
                cwd: rootDir,
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              });
              child.unref();

              console.log('[restart] handed over to tools/restart-planner.pyw');
              res.end(JSON.stringify({
                ok: true,
                message: 'Restarting. The planner will reopen in a few seconds.',
              }));
            } catch (err) {
              console.error('[restart] failed to start the helper:', err);
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Could not start the restart helper.' }));
            }
          });

          // --- Over-the-air updates --------------------------------------
          // These two routes are the ONLY ones on this server that are not
          // behind the login. They have to be: expo-updates checks for a new
          // bundle before the app has a session, and often before the user has
          // ever signed in. What they expose is the app's own JavaScript, which
          // is already on every phone that installed it -- but that is exactly
          // why the path handling below is strict rather than convenient.
          const otaDeps = makeFsDeps(rootDir);

          const originOf = (req: any): string => {
            const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
              || 'http';
            const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
            return `${proto}://${host}`;
          };

          server.middlewares.use('/api/ota/manifest', async (req, res, next) => {
            trace(`OTA manifest asked (platform=${req.headers['expo-platform'] ?? '?'} runtime=${req.headers['expo-runtime-version'] ?? '?'})`);
            if (req.method !== 'GET') return next();
            const url = new URL(req.url || '/', 'http://localhost');
            const header = (n: string) => {
              const v = req.headers[n];
              return Array.isArray(v) ? v[0] : v;
            };

            const protocolVersion = Number(header('expo-protocol-version') ?? 0) || 0;
            const outcome = await resolveUpdate({
              platform: header('expo-platform') ?? url.searchParams.get('platform'),
              runtimeVersion: header('expo-runtime-version')
                ?? url.searchParams.get('runtime-version'),
              protocolVersion,
              currentUpdateId: header('expo-current-update-id') ?? null,
              origin: originOf(req),
            }, otaDeps);

            res.setHeader('expo-protocol-version', String(protocolVersion));
            res.setHeader('expo-sfv-version', '0');
            res.setHeader('cache-control', 'private, max-age=0');

            if (outcome.kind === 'error') {
              res.statusCode = outcome.status;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ error: outcome.message }));
              return;
            }

            if (outcome.kind === 'no-update') {
              // Protocol 1 has a directive for this; protocol 0 has no way to
              // say it, and 204 is what the client treats as "nothing new".
              if (protocolVersion === 0) {
                res.statusCode = 204;
                res.end();
                return;
              }
              const boundary = makeBoundary('no-update');
              const body = encodeMultipart([{
                name: 'directive',
                body: JSON.stringify({ type: 'noUpdateAvailable' }),
                contentType: 'application/json; charset=utf-8',
              }], boundary);
              res.statusCode = 200;
              res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
              res.end(body);
              return;
            }

            const boundary = makeBoundary(outcome.manifest.id);
            const body = encodeMultipart([{
              name: 'manifest',
              body: JSON.stringify(outcome.manifest),
              contentType: 'application/json; charset=utf-8',
            }], boundary);
            res.statusCode = 200;
            res.setHeader('content-type', `multipart/mixed; boundary=${boundary}`);
            res.end(body);
          });

          server.middlewares.use('/api/ota/assets', async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const url = new URL(req.url || '/', 'http://localhost');

            const runtimeVersion = safeRuntimeVersion(url.searchParams.get('runtimeVersion'));
            const platform = safePlatform(url.searchParams.get('platform'));
            const asset = url.searchParams.get('asset');
            if (!runtimeVersion || !platform || !asset) {
              res.statusCode = 400;
              res.end('Bad asset request.');
              return;
            }

            const names = await otaDeps.listUpdates(runtimeVersion);
            const newest = newestFolder(names);
            if (!newest) {
              res.statusCode = 404;
              res.end('No update published.');
              return;
            }

            // The only thing standing between a query string and the rest of the
            // disk. Never inline this.
            const root = assetRootFor(rootDir, runtimeVersion, newest);
            const full = safeAssetPath(root, asset);
            if (!full) {
              res.statusCode = 400;
              res.end('Bad asset path.');
              return;
            }

            try {
              const bytes = await fsp.readFile(full);
              const ext = path.extname(full);
              res.statusCode = 200;
              res.setHeader('content-type', contentTypeFor(ext));
              res.setHeader('content-length', String(bytes.length));
              // Assets are addressed by content hash, so they never change.
              res.setHeader('cache-control', 'public, max-age=31536000, immutable');
              if (req.method === 'HEAD') { res.end(); return; }
              res.end(bytes);
            } catch {
              res.statusCode = 404;
              res.end('Asset not found.');
            }
          });

          // --- The Android app -------------------------------------------
          // GET /app       a small page listing the builds
          // GET /app.apk   the right build for whatever asked
          //
          // Behind the same login as everything else. The APK is not secret, but
          // this server is reachable from the public internet and there is no
          // reason to hand a build to anyone who has not signed in.
          const APK_DIR = path.resolve(
            rootDir, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release',
          );

          const listApks = async (): Promise<ApkFile[]> => {
            try {
              const names = await fsp.readdir(APK_DIR);
              const files: ApkFile[] = [];
              for (const name of names) {
                if (!isApk(name)) continue;
                const stat = await fsp.stat(path.join(APK_DIR, name));
                files.push({ name, size: stat.size, modified: stat.mtimeMs });
              }
              return files;
            } catch {
              // Not built yet. The page says so rather than 500-ing.
              return [];
            }
          };

          server.middlewares.use('/app.apk', async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const auth = await requireAuth(req, res);
            if (!auth) return;

            const files = await listApks();
            if (files.length === 0) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('The Android app has not been built yet.');
              return;
            }

            const url = new URL(req.url || '/', 'http://localhost');
            const explicit = safeApkName(url.searchParams.get('file'), files);
            const chosen = explicit
              ? files.find(f => f.name === explicit)!
              : chooseApk(files, {
                  preferred: url.searchParams.get('abi'),
                  userAgent: req.headers['user-agent'] as string | undefined,
                })?.file;

            if (!chosen) {
              res.statusCode = 404;
              res.end('No suitable build.');
              return;
            }

            const full = path.join(APK_DIR, chosen.name);
            res.setHeader('Content-Type', 'application/vnd.android.package-archive');
            res.setHeader('Content-Length', String(chosen.size));
            // A plain name, so the phone's downloads list is readable.
            res.setHeader('Content-Disposition', 'attachment; filename="daily-planner.apk"');
            // Never cached: an update must not be shadowed by yesterday's build.
            res.setHeader('Cache-Control', 'no-store');
            if (req.method === 'HEAD') { res.end(); return; }

            const stream = (await import('fs')).createReadStream(full);
            stream.on('error', () => { res.statusCode = 500; res.end(); });
            stream.pipe(res);
          });

          server.middlewares.use('/app', async (req, res, next) => {
            const url = new URL(req.url || '/', 'http://localhost');
            // Connect strips the mounted prefix, so this normally arrives as '/'.
            // It does NOT always: behind the Funnel the original path can survive,
            // and an earlier version fell through to the single-page app here,
            // which answered with its own "no such route" page. Accept every form
            // this can legitimately take rather than guessing which one it is.
            const tail = url.pathname.replace(/^\/?app/, '').replace(/\/+$/, '');
            if (req.method !== 'GET' || (tail !== '' && tail !== '/')) return next();

            const auth = await requireAuth(req, res);
            if (!auth) return;

            try {
            const files = listForDisplay(await listApks());
            const recommended = chooseApk(files, {
              userAgent: req.headers['user-agent'] as string | undefined,
            });

            const rows = files.map(f => {
              const abi = abiOf(f.name);
              const isPick = recommended?.file.name === f.name;
              return `<li class="${isPick ? 'pick' : ''}">
                <a href="/app.apk?file=${encodeURIComponent(f.name)}">
                  <span class="abi">${abi === 'universal' ? 'Any phone' : abi}</span>
                  <span class="size">${formatBytes(f.size)}</span>
                </a>
              </li>`;
            }).join('');

            const body = files.length === 0
              ? `<p class="empty">The app has not been built yet. Build it on the PC with
                 <code>cd mobile/android &amp;&amp; ./gradlew assembleRelease</code>.</p>`
              : `<a class="cta" href="/app.apk">Install Daily Planner</a>
                 <p class="hint">${recommended?.reason ?? ''}
                 ${recommended ? formatBytes(recommended.file.size) : ''}</p>
                 <p class="note">Android will ask you to allow installing from your browser.
                 That prompt is expected — this file comes from your own PC.</p>
                 <details><summary>Other builds</summary><ul>${rows}</ul></details>`;

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install Daily Planner</title><style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;
 background:#0D0D14;color:#ECECF5;font:16px/1.5 system-ui,sans-serif;padding:24px}
main{max-width:420px;width:100%;text-align:center}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 8px}
.sub{color:#A6A6BA;margin:0 0 32px}
.cta{display:block;background:#8C88FF;color:#0D0D14;text-decoration:none;
 font-weight:600;padding:18px;border-radius:999px;margin-bottom:12px}
.hint{color:#A6A6BA;font-size:14px;margin:0 0 24px}
.note{color:#6E6E85;font-size:13px;border-left:2px solid #272733;padding-left:12px;text-align:left}
.empty{color:#A6A6BA}
code{background:#16161F;padding:2px 6px;border-radius:4px;font-size:13px}
details{margin-top:24px;text-align:left}
summary{color:#A6A6BA;cursor:pointer;font-size:14px}
ul{list-style:none;padding:0;margin:12px 0 0}
li a{display:flex;justify-content:space-between;padding:14px;margin-bottom:8px;
 background:#16161F;border:1px solid #272733;border-radius:12px;
 color:#ECECF5;text-decoration:none}
li.pick a{border-color:#8C88FF}
.size{color:#6E6E85}
@media (prefers-color-scheme:light){
 body{background:#F5F5FA;color:#15151E}.cta{background:#4F46D6;color:#fff}
 .sub,.hint{color:#5A5A70}li a{background:#fff;border-color:#E1E1EC;color:#15151E}
 code{background:#EDEDF4}}
</style></head><body><main>
<h1>Daily Planner</h1>
<p class="sub">The app for your phone. Works with this PC switched off.</p>
${body}
</main></body></html>`);
            } catch (err) {
              // Falling through to next() here is what produced the confusing
              // "no such route" page, so the failure is reported instead.
              console.error('[app] download page failed:', err);
              res.statusCode = 500;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end(`The install page failed: ${(err as Error)?.message || err}`);
            }
          });

          server.middlewares.use('/api/sync', async (req, res, next) => {
            const auth = await requireAuth(req, res);
            if (!auth) return;

            // Did the phone hang up before we answered? This is the difference
            // between "the server never replied" and "the device gave up", and
            // guessing which was costing whole rounds of diagnosis. A held pull
            // that the phone abandons shows up here and nowhere else.
            const askedAt = Date.now();
            let answered = false;
            req.on('close', () => {
              if (answered || res.writableEnded) return;
              trace(`ABORTED   ${req.url} after ${Date.now() - askedAt}ms — the device closed it`);
            });

            try {
              const url = new URL(req.url || '/', 'http://localhost');
              const body = req.method === 'POST' ? await readJsonBody(req) : {};
              const answer = await handleSyncRequest(
                syncService,
                auth.user.username,
                syncPathsOf(auth.userPaths),
                { action: url.pathname, method: req.method || 'GET', body },
              );
              if (!answer.handled) return next();
              const p: any = answer.payload ?? {};
              const who = String((body as any)?.deviceId ?? '?').slice(0, 24);
              const bits = [
                `dev=${who}`,
                typeof (body as any)?.since === 'number' ? `since=${(body as any).since}` : '',
                // Whether the device asked us to hold the request. This is the
                // only reliable way to tell which bundle a phone is running:
                // an older one simply never sends it.
                typeof (body as any)?.wait === 'number' ? `wait=${(body as any).wait}` : '',
                Array.isArray(p.ops) ? `ops=${p.ops.length}` : '',
                Array.isArray((body as any)?.ops) ? `sent=${(body as any).ops.length}` : '',
                typeof p.cursor === 'number' ? `cursor=${p.cursor}` : '',
                typeof p.lamport === 'number' ? `L=${p.lamport}` : '',
                p.needsFullResync ? 'FULLRESYNC' : '',
              ].filter(Boolean).join(' ');
              answered = true;
              const slow = Date.now() - askedAt;
              trace(`${url.pathname.padEnd(10)} ${bits}${slow > 1000 ? ` took=${slow}ms` : ''}`);
              return sendSyncJson(res, answer.status, answer.payload);
            } catch (err) {
              console.error('[sync] request failed:', err);
              return sendSyncJson(res, 500, { error: 'Sync failed on the server.' });
            }
          });

          /**
           * Fold a file the PC just wrote into the operation log.
           *
           * Deliberately fire-and-forget: a sync failure must never make a normal
           * save fail. The log catches up on the next write, whereas a save that
           * errored would lose the user's edit outright.
           */
          const ingestAfterWrite = (
            username: string,
            userPaths: any,
            store: 'events' | 'tasks' | 'settings',
            body: string,
            baseId?: string,
          ) => {
            let snapshot: any;
            try {
              snapshot = JSON.parse(body);
            } catch {
              return;
            }
            if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
            syncService
              .ingestFile(username, syncPathsOf(userPaths), store, snapshot, baseId)
              .catch(err => console.error('[sync] ingest failed:', err));
          };

          /**
           * Register a version of a store we are handing to the app, so that the
           * save the app builds from it can be merged against the right
           * baseline rather than against whatever is on disk by then.
           */
          const noteServed = (username: string, store: 'events' | 'tasks', raw: string) => {
            try {
              const parsed = JSON.parse(raw);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
              syncService.noteBase(username, store, parsed);
            } catch { /* not JSON yet */ }
          };

          /** The base id the client stamped onto this save, if any. */
          const baseIdHeader = (req: any): string | undefined => {
            const v = req.headers['x-planner-base'];
            const id = Array.isArray(v) ? v[0] : v;
            return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : undefined;
          };

          server.middlewares.use('/api/events', async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'POST') return next();
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths } = auth;
            const fs = await import('fs/promises');

            if (req.method === 'GET') {
              try {
                const data = await fs.readFile(userPaths.dbPath, 'utf-8');
                noteServed(auth.user.username, 'events', data);
                res.setHeader('Content-Type', 'application/json');
                res.end(data);
              } catch (err) {
                res.setHeader('Content-Type', 'application/json');
                res.end('{}');
              }
            } else if (req.method === 'POST') {
              let body = '';
              req.on('data', chunk => {
                body += chunk;
              });
              req.on('end', async () => {
                try {
                  const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                  const result = await safeWriteJsonFile({ filePath: userPaths.dbPath, backupDir: userPaths.backupDir, baseName: 'database', body, kind: 'object', force });
                  res.setHeader('Content-Type', 'application/json');
                  if (!result.ok) {
                    res.statusCode = result.status;
                    res.end(JSON.stringify({ error: result.error }));
                    return;
                  }
                  trace(`SAVE events   bytes=${body.length}`);
                  ingestAfterWrite(auth.user.username, userPaths, 'events', body, baseIdHeader(req));
                  res.end(JSON.stringify({ success: true }));
                } catch (err) {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'Failed to write to file database' }));
                }
              });
            }
          });

          // Tasks live in their OWN file, never in database.json. Mixing them would
          // hand them to runGoogleSync, which pushes everything it is given to the
          // Daily calendar — tasks belong to Google TASKS, not Google Calendar.
          server.middlewares.use('/api/tasks', async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'POST') return next();
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { userPaths } = auth;
            const fs = await import('fs/promises');

            if (req.method === 'GET') {
              try {
                const data = await fs.readFile(userPaths.tasksPath, 'utf-8');
                noteServed(auth.user.username, 'tasks', data);
                res.setHeader('Content-Type', 'application/json');
                res.end(data);
              } catch {
                res.setHeader('Content-Type', 'application/json');
                res.end('{}');
              }
            } else if (req.method === 'POST') {
              let body = '';
              req.on('data', chunk => { body += chunk; });
              req.on('end', async () => {
                try {
                  const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                  const result = await safeWriteJsonFile({ filePath: userPaths.tasksPath, backupDir: userPaths.backupDir, baseName: 'tasks', body, kind: 'object', force });
                  res.setHeader('Content-Type', 'application/json');
                  if (!result.ok) {
                    res.statusCode = result.status;
                    res.end(JSON.stringify({ error: result.error }));
                    return;
                  }
                  trace(`SAVE tasks    bytes=${body.length}`);
                  ingestAfterWrite(auth.user.username, userPaths, 'tasks', body, baseIdHeader(req));
                  res.end(JSON.stringify({ success: true }));
                } catch {
                  res.statusCode = 500;
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ error: 'Failed to write tasks' }));
                }
              });
            }
          });

        // ── Prayer times ──────────────────────────────────────────────────────
        // The Aladhan API is hit from the server, not the browser: one shared
        // cache for both windows, no CORS, and — most importantly — the cache
        // file means a month already fetched keeps working with no internet.
        // A month is re-fetched when it is older than a week (and always for a
        // month still in progress, since a calendar fetched on the 1st is only
        // as accurate as the API was that day).
        server.middlewares.use('/api/prayer-times', async (req, res, next) => {
          if (req.method !== 'GET') { next(); return; }
          const fs = await import('fs/promises');
          const path = await import('path');
          const cachePath = path.resolve(import.meta.dirname, '..', '..', 'database', 'prayer-times.json');

          const url = new URL(req.url || '', 'http://localhost');
          const city = (url.searchParams.get('city') || '').trim();
          const country = (url.searchParams.get('country') || '').trim();
          const method = Number(url.searchParams.get('method'));
          const school = Number(url.searchParams.get('school'));
          const year = Number(url.searchParams.get('year'));
          const month = Number(url.searchParams.get('month'));

          res.setHeader('Content-Type', 'application/json');
          if (!city || !country || !Number.isFinite(method) || !Number.isFinite(year) || !Number.isFinite(month)
              || month < 1 || month > 12 || year < 1900 || year > 2200) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Bad prayer-times query' }));
            return;
          }

          const key = `${city}|${country}|${method}|${school === 1 ? 1 : 0}|${year}-${month}`;
          let cache: Record<string, { fetchedAt: number; days: Record<string, Record<string, string>> }> = {};
          try {
            cache = JSON.parse(await fs.readFile(cachePath, 'utf-8')) || {};
          } catch { cache = {}; }

          const hit = cache[key];
          const now = Date.now();
          const nowD = new Date();
          const isCurrentMonth = year === nowD.getFullYear() && month === nowD.getMonth() + 1;
          const maxAge = isCurrentMonth ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
          if (hit && now - hit.fetchedAt < maxAge) {
            res.end(JSON.stringify({ days: hit.days, fetchedAt: hit.fetchedAt }));
            return;
          }

          const api = `https://api.aladhan.com/v1/calendarByCity/${year}/${month}`
            + `?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}`
            + `&method=${method}&school=${school === 1 ? 1 : 0}`;
          try {
            const resp = await fetch(api, { headers: { 'User-Agent': 'daily-planner' } });
            if (!resp.ok) throw new Error(`Aladhan responded ${resp.status}`);
            const json: any = await resp.json();
            const rows: any[] = Array.isArray(json?.data) ? json.data : [];
            if (!rows.length) throw new Error('Aladhan returned no days');

            const days: Record<string, Record<string, string>> = {};
            for (const row of rows) {
              // "01-08-2026" (DD-MM-YYYY) → "2026-08-01".
              const g = String(row?.date?.gregorian?.date || '');
              const m = g.match(/^(\d{2})-(\d{2})-(\d{4})$/);
              if (!m) continue;
              const dateStr = `${m[3]}-${m[2]}-${m[1]}`;
              const t = row?.timings || {};
              const picked: Record<string, string> = {};
              for (const [ours, theirs] of Object.entries({
                fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr',
                asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha',
              })) {
                // Values arrive as "04:19 (+03)" — the offset is already baked in.
                const hhmm = String(t[theirs] || '').match(/^(\d{1,2}):(\d{2})/);
                if (hhmm) picked[ours] = `${hhmm[1].padStart(2, '0')}:${hhmm[2]}`;
              }
              if (Object.keys(picked).length) days[dateStr] = picked;
            }
            if (!Object.keys(days).length) throw new Error('Aladhan returned nothing usable');

            cache[key] = { fetchedAt: now, days };
            const prayerBackupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');
            await safeWriteJsonFile({
              filePath: cachePath,
              backupDir: prayerBackupDir,
              baseName: 'prayer-times',
              body: JSON.stringify(cache, null, 2),
              kind: 'object',
              force: true,
            });
            res.end(JSON.stringify({ days, fetchedAt: now }));
          } catch (err) {
            // Offline or the API is down: an old cache still beats a blank grid.
            if (hit) {
              res.end(JSON.stringify({ days: hit.days, fetchedAt: hit.fetchedAt, stale: true }));
              return;
            }
            console.error('[prayer] fetch failed:', err);
            res.statusCode = 502;
            res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
          }
        });

        // Which prayers have been ticked off: { 'yyyy-MM-dd': ['fajr', ...] }.
        server.middlewares.use('/api/prayer-done', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;
          const fs = await import('fs/promises');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(userPaths.donePath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch {
              res.setHeader('Content-Type', 'application/json');
              res.end('{}');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const result = await safeWriteJsonFile({ filePath: userPaths.donePath, backupDir: userPaths.backupDir, baseName: 'prayer-done', body, kind: 'object', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write prayer completion' }));
              }
            });
          }
        });

        // ── Notifications ────────────────────────────────────────────────────
        // The engine lives in the server, not in a page, so a reminder still
        // fires with every planner window closed. Delivery goes out over three
        // independent transports (Windows toast, Web Push, and the shared store
        // that open windows read over db-stream), and read state is shared, so
        // dealing with something on the phone clears it on the PC too.
        {
          const rootDir = path.resolve(import.meta.dirname, '..', '..');

          const notifications = createNotificationEngine({
            rootDir,
            listUsers: async () => (await loadAccessConfig(rootDir)).users.map(u => u.username),
            ensureUser: (username: string) => ensureUserDb(rootDir, username),
          });
          notifications.start();

          // The public link is what the phone depends on, and it can be taken
          // down by things outside this app entirely. Watch it and put it back.
          const funnelWatchdog = createFunnelWatchdog({
            rootDir,
            port: Number(server.config.server.port) || 5173,
          });
          funnelWatchdog.start();

          const readBody = (req: any): Promise<any> => new Promise(resolve => {
            let body = '';
            req.on('data', (chunk: any) => { body += chunk; });
            req.on('end', () => {
              try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
            });
            req.on('error', () => resolve({}));
          });

          const sendJson = (res: any, value: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(value));
          };

          // The Windows toast agent has no session cookie: it is a separate
          // process reacting to a button press. It is trusted only when the
          // request comes from this machine AND carries the token the engine
          // generated, which never leaves the local database directory.
          const isLoopback = (req: any): boolean => {
            const addr = String(req.socket?.remoteAddress || '');
            return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
          };

          server.middlewares.use('/api/notifications/agent-action', async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed' }, 405);
            const body = await readBody(req);
            const token = await notifications.getAgentToken();
            if (!isLoopback(req) || !body?.token || body.token !== token) {
              return sendJson(res, { error: 'Forbidden' }, 403);
            }
            const { users } = await loadAccessConfig(rootDir);
            const username = users.find(u => u.username === body.user)?.username ?? users[0]?.username;
            if (!username) return sendJson(res, { error: 'No user' }, 400);
            try {
              const { store } = await notifications.applyAction(username, {
                action: body.action,
                keys: Array.isArray(body.keys) ? body.keys : [],
                minutes: body.minutes,
                deviceId: body.deviceId || 'windows-toast',
              });
              sendJson(res, { success: true, updatedAt: store.updatedAt });
            } catch (err) {
              sendJson(res, { error: String((err as Error)?.message || err) }, 500);
            }
          });

          server.middlewares.use('/api/notifications/action', async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const body = await readBody(req);
            try {
              const { store } = await notifications.applyAction(auth.user.username, {
                action: body.action,
                keys: Array.isArray(body.keys) ? body.keys : undefined,
                minutes: body.minutes,
                deviceId: body.deviceId,
              });
              sendJson(res, { success: true, store });
            } catch (err) {
              sendJson(res, { error: String((err as Error)?.message || err) }, 500);
            }
          });

          // The next couple of days of reminders, so the phone can still alert
          // with this machine switched off. Nothing already delivered is
          // included, which is what stops the same reminder arriving twice.
          server.middlewares.use('/api/notifications/schedule', async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            // Every open planner window refreshes its offline plan periodically,
            // which keeps this machine's list of local accounts fresh even when
            // the live stream means nothing else is being polled.
            if (isLoopback(req)) notifications.markDesktopUser(auth.user.username);
            const hours = Number(new URL(req.url || '', 'http://x').searchParams.get('hours')) || 30;
            try {
              sendJson(res, await notifications.upcomingFor(auth.user.username, hours));
            } catch (err) {
              sendJson(res, { error: String((err as Error)?.message || err) }, 500);
            }
          });

          // A device reporting what it fired by itself while offline.
          server.middlewares.use('/api/notifications/local-fired', async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const body = await readBody(req);
            try {
              await notifications.recordLocallyFired(
                auth.user.username,
                Array.isArray(body.keys) ? body.keys : [],
                body.deviceId,
              );
              sendJson(res, { success: true });
            } catch (err) {
              sendJson(res, { error: String((err as Error)?.message || err) }, 500);
            }
          });

          server.middlewares.use('/api/notifications/health', async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const engineHealth = await notifications.health(auth.user.username);
            sendJson(res, { ...engineHealth, funnel: funnelWatchdog.health() });
          });

          server.middlewares.use('/api/notifications/test', async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const body = await readBody(req);
            try {
              const rec = await notifications.sendTest(
                auth.user.username,
                body?.priority === 'critical' ? 'critical' : 'normal',
              );
              sendJson(res, { success: true, key: rec.key });
            } catch (err) {
              sendJson(res, { error: String((err as Error)?.message || err) }, 500);
            }
          });

          server.middlewares.use('/api/push/key', async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, { error: 'Method not allowed' }, 405);
            sendJson(res, { publicKey: await notifications.getVapidPublicKey() });
          });

          server.middlewares.use('/api/push/subscribe', async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const body = await readBody(req);
            if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
              return sendJson(res, { error: 'Malformed subscription' }, 400);
            }
            const subs = await notifications.savePushSubscription(auth.user.username, {
              endpoint: String(body.endpoint),
              keys: { p256dh: String(body.keys.p256dh), auth: String(body.keys.auth) },
              label: typeof body.label === 'string' ? body.label.slice(0, 80) : undefined,
              deviceId: typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : undefined,
              userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : undefined,
              local: isLoopback(req),
            });
            sendJson(res, { success: true, count: subs.length });
          });

          server.middlewares.use('/api/push/unsubscribe', async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const body = await readBody(req);
            const subs = await notifications.removePushSubscription(
              auth.user.username,
              String(body?.endpoint || body?.id || ''),
            );
            sendJson(res, { success: true, count: subs.length });
          });

          // Registered last: connect matches by prefix, so the specific routes
          // above must claim their paths before this one sees them.
          server.middlewares.use('/api/notifications', async (req, res, next) => {
            const rest = (req.url || '/').split('?')[0];
            if (rest !== '/' && rest !== '') return next();
            if (req.method !== 'GET') return sendJson(res, { error: 'Method not allowed' }, 405);
            const auth = await requireAuth(req, res);
            if (!auth) return;
            // Every planner window on this PC polls this. It is therefore the
            // natural place to learn which account is sitting at this machine,
            // which is what decides who may raise a Windows toast here.
            if (isLoopback(req)) notifications.markDesktopUser(auth.user.username);
            sendJson(res, await notifications.getStore(auth.user.username));
          });
        }

        server.middlewares.use('/api/settings', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;
          const fs = await import('fs/promises');

          if (req.method === 'GET') {
            try {
              let data = await fs.readFile(userPaths.settingsPath, 'utf-8');
              // Migrate the one historical focus-timer default at the source of
              // truth. This is intentionally done before responding: the
              // windowless RegisterHotKey helper reads this endpoint before the
              // browser has mounted, so a client-only migration leaves a window
              // where the old global shortcut is still active.
              try {
                const parsed = JSON.parse(data);
                const shortcuts = parsed?.shortcuts;
                const version = parsed?.shortcutDefaultsVersion;
                const isCurrent = typeof version === 'number'
                  && Number.isFinite(version)
                  && version >= SHORTCUT_DEFAULTS_VERSION;
                if (!isCurrent && shortcuts && typeof shortcuts === 'object' && !Array.isArray(shortcuts)) {
                  const oldToggle = (shortcuts as Record<string, unknown>).toggleTimer;
                  if (
                    typeof oldToggle === 'string'
                    && oldToggle.toLowerCase() === LEGACY_FOCUS_TIMER_TOGGLE_DEFAULT.toLowerCase()
                  ) {
                    (shortcuts as Record<string, unknown>).toggleTimer = FOCUS_TIMER_TOGGLE_DEFAULT;
                  }
                  parsed.shortcutDefaultsVersion = SHORTCUT_DEFAULTS_VERSION;
                  data = JSON.stringify(parsed);
                  await safeWriteJsonFile({
                    filePath: userPaths.settingsPath,
                    backupDir: userPaths.backupDir,
                    baseName: 'settings',
                    body: data,
                    kind: 'object',
                    force: true,
                  });
                }
              } catch (_) {
                // Preserve the established GET behaviour for malformed legacy
                // settings; the client will still surface its normal recovery.
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{}');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk;
            });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const result = await safeWriteJsonFile({ filePath: userPaths.settingsPath, backupDir: userPaths.backupDir, baseName: 'settings', body, kind: 'object', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                trace(`SAVE settings bytes=${body.length}`);
                ingestAfterWrite(auth.user.username, userPaths, 'settings', body);
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write settings file' }));
              }
            });
          }
        });

        // ── Per-device settings ──────────────────────────────────────────────
        server.middlewares.use('/api/device-settings', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;

          const readAll = async (): Promise<Record<string, any>> => {
            const raw = await readJsonSafe(userPaths.devicePath, {});
            return raw && typeof raw === 'object' ? raw as Record<string, any> : {};
          };

          if (req.method === 'GET') {
            const params = new URL(req.url || '', 'http://localhost').searchParams;
            const device = params.get('device') || '';
            const kind = params.get('kind') || '';
            const all = await readAll();
            let entry = device ? all[device] : null;
            if (!entry && kind) {
              const sameKind = Object.values(all)
                .filter((e: any) => e && e.kind === kind)
                .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));
              if (sameKind.length) entry = { ...sameKind[0], inherited: true };
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(entry || {}));
            return;
          }

          if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
              res.setHeader('Content-Type', 'application/json');
              try {
                const parsed = JSON.parse(body || '{}');
                const device = String(parsed.device || '').trim();
                if (!device || !parsed.settings || typeof parsed.settings !== 'object') {
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: 'device and settings are required' }));
                  return;
                }
                const all = await readAll();
                all[device] = {
                  kind: typeof parsed.kind === 'string' ? parsed.kind : 'desktop',
                  label: typeof parsed.label === 'string' ? parsed.label : 'Device',
                  updatedAt: Date.now(),
                  settings: parsed.settings,
                };
                const entries = Object.entries(all)
                  .sort((a: any, b: any) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
                  .slice(0, 24);
                const writeRes = await safeWriteJsonFile({
                  filePath: userPaths.devicePath,
                  backupDir: userPaths.backupDir,
                  baseName: 'device-settings',
                  body: JSON.stringify(Object.fromEntries(entries), null, 2),
                  kind: 'object',
                  force: true,
                });
                if (!writeRes.ok) {
                  res.statusCode = writeRes.status;
                  res.end(JSON.stringify({ error: writeRes.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'Failed to write device settings' }));
              }
            });
            return;
          }
        });

        // ── Automated backups ────────────────────────────────────────────────
        {
          const rootDir = path.resolve(import.meta.dirname, '..', '..');
          maybeRunAutoBackup(rootDir).catch(() => {});
          const backupTimer = setInterval(() => { maybeRunAutoBackup(rootDir).catch(() => {}); }, 3600_000);
          if (typeof backupTimer.unref === 'function') backupTimer.unref();

          server.middlewares.use('/api/auto-backup', async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'POST') return next();
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { user } = auth;

            const p = autoBackupPaths(rootDir, user.username);
            if (req.method === 'GET') {
              let files: string[] = [];
              try {
                files = (await fsp.readdir(p.outDir))
                  .filter(f => f.startsWith(AUTO_BACKUP_PREFIX) && f.endsWith('.json'))
                  .sort()
                  .reverse();
              } catch { /* no backups yet */ }
              const state = await readJsonSafe(p.statePath, {});
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                count: files.length,
                latest: files[0] ?? null,
                lastBackupAt: (state as Record<string, string>).lastBackupAt ?? null,
                directory: p.outDir,
              }));
              return;
            }
            if (req.method === 'POST') {
              try {
                const result = await writeAutoBackup(rootDir, user.username, 'manual');
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) { res.statusCode = 409; res.end(JSON.stringify({ error: (result as any).reason })); return; }
                res.end(JSON.stringify({ success: true, ...result }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write backup' }));
              }
              return;
            }
          });
        }

        server.middlewares.use('/api/focus-sessions', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;
          const fs = await import('fs/promises');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(userPaths.focusPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end('[]');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk;
            });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const merged = force ? body : await mergeFocusSessions(userPaths.focusPath, body);
                const result = await safeWriteJsonFile({ filePath: userPaths.focusPath, backupDir: userPaths.backupDir, baseName: 'focus-sessions', body: merged, kind: 'array', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write focus sessions file' }));
              }
            });
          }
        });

        // Helper for formatting SSE data payload as single-line JSON without mangling internal newlines
        function formatSsePayload(data: string): string {
          try {
            return JSON.stringify(JSON.parse(data));
          } catch {
            return data.split('\n').join('\ndata: ');
          }
        }

        // Live push for everything else in the file database (events, settings,
        // focus sessions). The widget used to poll these every 5s, which is why a
        // change made in the main window took seconds to show up there.
        server.middlewares.use('/api/db-stream', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          const fs = await import('fs');
          const fsp = await import('fs/promises');
          const { users } = await loadAccessConfig(rootDir);
          const user = getRequestUser(req, users);
          if (!user) {
            res.statusCode = 401;
            res.end('Unauthorized');
            return;
          }
          const userPaths = await ensureUserDb(rootDir, user.username);
          const WATCHED: Record<string, string> = {
            events: 'database.json',
            settings: 'settings.json',
            'focus-sessions': 'focus-sessions.json',
            tasks: 'tasks.json',
            notifications: 'notifications.json',
          };

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });

          const lastSent: Record<string, string> = {};
          const send = async (name: string) => {
            const file = WATCHED[name];
            if (!file) return;
            try {
              const data = await fsp.readFile(path.join(userPaths.dbDir, file), 'utf-8');
              if (data === lastSent[name]) return;
              lastSent[name] = data;
              // The app builds its next save from this frame, so this version
              // has to be one the merge can look up later.
              if (name === 'events' || name === 'tasks') noteServed(user.username, name, data);
              res.write(`event: ${name}\ndata: ${formatSsePayload(data)}\n\n`);
            } catch (_) { /* not written yet */ }
          };

          const sendSoon = (name: string) => {
            send(name);
            setTimeout(() => send(name), 40);
            setTimeout(() => send(name), 150);
          };
          let watcher: any = null;
          try {
            watcher = fs.watch(userPaths.dbDir, (_evt, changed) => {
              if (!changed) return;
              for (const [name, file] of Object.entries(WATCHED)) {
                if (String(changed).startsWith(file)) sendSoon(name);
              }
            });
          } catch (_) { /* the sweep below still covers it */ }

          const sweep = setInterval(() => {
            for (const name of Object.keys(WATCHED)) send(name);
          }, 250);

          const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
          let isClosed = false;
          const cleanup = () => {
            if (isClosed) return;
            isClosed = true;
            clearInterval(ping);
            clearInterval(sweep);
            if (watcher) try { watcher.close(); } catch (_) {}
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          res.on('close', cleanup);
          res.on('error', cleanup);
          res.on('finish', cleanup);
        });

        // Live push of the shared timer state.
        server.middlewares.use('/api/focus-timer/stream', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          const fs = await import('fs');
          const fsp = await import('fs/promises');
          const { users } = await loadAccessConfig(rootDir);
          const user = getRequestUser(req, users);
          if (!user) {
            res.statusCode = 401;
            res.end('Unauthorized');
            return;
          }
          const userPaths = await ensureUserDb(rootDir, user.username);

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });

          let lastSent = '';
          const send = async () => {
            try {
              const data = await fsp.readFile(userPaths.timerPath, 'utf-8');
              if (data === lastSent) return;
              lastSent = data;
              res.write(`data: ${formatSsePayload(data)}\n\n`);
            } catch (_) { /* file not written yet */ }
          };
          await send();

          const sendSoon = () => {
            send();
            setTimeout(send, 40);
            setTimeout(send, 150);
          };
          let watcher: any = null;
          try {
            watcher = fs.watch(userPaths.dbDir, (_evt, name) => {
              if (!name || String(name).startsWith('focus-timer.json')) sendSoon();
            });
          } catch (_) { /* the sweep below still covers it */ }

          const sweep = setInterval(send, 200);

          const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
          let isClosed = false;
          const cleanup = () => {
            if (isClosed) return;
            isClosed = true;
            clearInterval(ping);
            clearInterval(sweep);
            if (watcher) try { watcher.close(); } catch (_) {}
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          res.on('close', cleanup);
          res.on('error', cleanup);
          res.on('finish', cleanup);
        });

        let lastToggleAt = 0;
        const TOGGLE_DEBOUNCE_MS = 300;

        const cueClaims = new Map<string, number>();

        server.middlewares.use('/api/focus-cue/claim', async (req, res, next) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
          }
          if (req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { user } = auth;
          const rawKey = new URL(req.url ?? '', 'http://x').searchParams.get('key') ?? '';
          const key = `${user.username}:${rawKey}`;
          const now = Date.now();
          for (const [k, t] of cueClaims) if (now - t > 300000) cueClaims.delete(k);
          const granted = !cueClaims.has(key);
          if (granted) cueClaims.set(key, now);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ granted }));
        });

        server.middlewares.use('/api/focus-heartbeat', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;
          const fs = await import('fs/promises');

          if (req.method === 'GET') {
            try {
              res.setHeader('Content-Type', 'application/json');
              res.end(await fs.readFile(userPaths.beatPath, 'utf-8'));
            } catch (_) {
              res.setHeader('Content-Type', 'application/json');
              res.end('null');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
              try {
                const parsed = JSON.parse(body || 'null');
                if (!parsed || typeof parsed !== 'object') throw new Error('bad body');
                await fs.writeFile(userPaths.beatPath, JSON.stringify({
                  at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString(),
                  sessionStartedAt: typeof parsed.sessionStartedAt === 'string' ? parsed.sessionStartedAt : null,
                  elapsedSeconds: Math.max(0, Number(parsed.elapsedSeconds) || 0),
                }), 'utf-8');
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true }));
              } catch (_) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write focus heartbeat' }));
              }
            });
          }
        });

        // ---------------------------------------------------------------
        // ESP32 focus-timer controller bridge.
        //
        // The firmware holds no logic at all: it posts raw button edges and
        // raw ultrasonic centimetres, and renders whatever display state it is
        // handed. Presence is decided in src/lib/sensorFilter.ts via
        // src/lib/hardwareBridge.ts -- on the PC, where the analysis can be as
        // involved as it needs to be and can be tested without a board on the
        // desk. The windows then consume presence events and drive the session
        // through the app's own start/pause/terminate code, so a hardware
        // button and an on-screen button cannot ever behave differently.
        //
        // All of this is live, disposable state regenerated every second, so
        // it stays in memory -- writing it to disk would just churn the file
        // database for no benefit.
        // ---------------------------------------------------------------

        const hwBridge = createHardwareBridge();

        // --- app <- server: a heartbeat to drive the controller's poll loop ---
        //
        // setInterval is not a reliable clock in a window nobody is looking at.
        // Chrome throttles timers in a hidden, minimised or fully-covered page
        // to roughly once a minute, so the controller simply stopped: the LCD
        // went to "waiting for app", and worse, a pending countdown or away
        // timeout sat frozen until the window was clicked. Delivery of a network
        // message is not throttled that way, so the beat comes from here
        // instead and the page merely reacts to it.
        server.middlewares.use('/api/hardware/tick', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          const { users } = await loadAccessConfig(rootDir);
          const authUser = getRequestUser(req, users);
          if (!authUser) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          const beat = setInterval(() => {
            try { res.write(`data: ${Date.now()}\n\n`); } catch (_) { /* closing */ }
          }, 500);
          req.on('close', () => clearInterval(beat));
        });

        server.middlewares.use('/api/hardware', async (req, res, next) => {
          const url = new URL(req.url ?? '', 'http://x');
          const route = url.pathname.replace(/\/+$/, '');

          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
          }

          const readBody = () => new Promise<string>(resolve => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => resolve(body));
          });

          const json = (payload: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
          };

          if (route === '/event' && req.method === 'POST') {
            let parsed: unknown = {};
            try {
              const text = await readBody();
              parsed = text ? JSON.parse(text) : {};
            } catch (_) {
              json({ error: 'Bad hardware event' }, 400);
              return;
            }
            const out = hwBridge.handleEvent(parsed);
            json(out.body, out.status);
            return;
          }

          if (route === '/events' && req.method === 'GET') {
            const { users } = await loadAccessConfig(rootDir);
            const authUser = getRequestUser(req, users);
            const since = Number(url.searchParams.get('since') ?? 0) || 0;
            const out = hwBridge.getEvents(since, Boolean(authUser));
            json(out.body, out.status);
            return;
          }

          if (route === '/state' && req.method === 'GET') {
            const out = hwBridge.getState();
            json(out.body, out.status);
            return;
          }

          if (route === '/state' && req.method === 'POST') {
            let parsed: unknown = {};
            try {
              const text = await readBody();
              parsed = text ? JSON.parse(text) : {};
            } catch (_) {
              json({ error: 'Bad hardware state' }, 400);
              return;
            }
            const out = hwBridge.postState(parsed);
            json(out.body, out.status);
            return;
          }

          if (route === '/config' && req.method === 'GET') {
            const out = hwBridge.getConfig();
            json(out.body, out.status);
            return;
          }

          if (route === '/config' && req.method === 'POST') {
            let parsed: unknown = {};
            try {
              const text = await readBody();
              parsed = text ? JSON.parse(text) : {};
            } catch (_) {
              json({ error: 'Bad hardware config' }, 400);
              return;
            }
            const out = hwBridge.postConfig(parsed);
            json(out.body, out.status);
            return;
          }

          if (route === '/live' && req.method === 'GET') {
            const out = hwBridge.getLive();
            json(out.body, out.status);
            return;
          }

          if (route === '/log' && req.method === 'POST') {
            let parsed: unknown = {};
            try {
              const text = await readBody();
              parsed = text ? JSON.parse(text) : {};
            } catch (_) {
              json({ error: 'Bad log entry' }, 400);
              return;
            }
            const out = hwBridge.postLog(parsed);
            json(out.body, out.status);
            return;
          }

          if (route === '/log' && req.method === 'GET') {
            const out = hwBridge.getLog();
            json(out.body, out.status);
            return;
          }

          if (route === '/controller' && req.method === 'GET') {
            const out = hwBridge.getController();
            json(out.body, out.status);
            return;
          }

          if (route === '/controller' && req.method === 'POST') {
            let parsed: unknown = {};
            try {
              const text = await readBody();
              parsed = text ? JSON.parse(text) : {};
            } catch (_) {
              json({ error: 'Bad controller state' }, 400);
              return;
            }
            const out = hwBridge.postController(parsed);
            json(out.body, out.status);
            return;
          }

          if (route === '/claim' && req.method === 'POST') {
            const { users } = await loadAccessConfig(rootDir);
            const authUser = getRequestUser(req, users);
            const key = url.searchParams.get('key') ?? '';
            const out = hwBridge.claim(key, Boolean(authUser));
            json(out.body, out.status);
            return;
          }

          next();
        });

        server.middlewares.use('/api/focus-timer/toggle', async (req, res, next) => {
          if (req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;

          const nowMs = Date.now();
          if (nowMs - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, debounced: true }));
            return;
          }
          lastToggleAt = nowMs;

          if (hwBridge.cancelArming(nowMs)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, cancelledArm: true }));
            return;
          }

          const fs = await import('fs/promises');
          try {
            let timer: Record<string, unknown> = { plannedSeconds: 3600, accumulatedSeconds: 0, isRunning: false, lastStartedAt: null, sessionStartedAt: null, lastPausedAt: null };
            try {
              const parsed = JSON.parse(await fs.readFile(userPaths.timerPath, 'utf-8'));
              if (parsed && typeof parsed === 'object') {
                timer = {
                  plannedSeconds: Number(parsed.plannedSeconds) || 3600,
                  accumulatedSeconds: Math.max(0, Number(parsed.accumulatedSeconds) || 0),
                  isRunning: Boolean(parsed.isRunning),
                  lastStartedAt: typeof parsed.lastStartedAt === 'string' ? parsed.lastStartedAt : null,
                  sessionStartedAt: typeof parsed.sessionStartedAt === 'string' ? parsed.sessionStartedAt : null,
                  lastPausedAt: typeof parsed.lastPausedAt === 'string' ? parsed.lastPausedAt : null,
                  creditedSeconds: Math.max(0, Number(parsed.creditedSeconds) || 0),
                };
              }
            } catch (_) { /* no file yet → defaults */ }

            const nowIso = new Date().toISOString();
            if (timer.isRunning) {
              const ran = timer.lastStartedAt
                ? Math.max(0, Math.floor((Date.now() - new Date(timer.lastStartedAt as string).getTime()) / 1000))
                : 0;
              timer = { ...timer, accumulatedSeconds: (timer.accumulatedSeconds as number) + ran, isRunning: false, lastStartedAt: null, lastPausedAt: nowIso };
            } else {
              timer = { ...timer, isRunning: true, lastStartedAt: nowIso, sessionStartedAt: timer.sessionStartedAt || nowIso, lastPausedAt: null };
            }

            await safeWriteJsonFile({ filePath: userPaths.timerPath, backupDir: userPaths.backupDir, baseName: 'focus-timer', body: JSON.stringify(timer), kind: 'object', force: true });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, isRunning: timer.isRunning, timer }));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Failed to toggle focus timer' }));
          }
        });

        // Shared running-timer state so the main window and the side widget reflect
        // the same live focus session (localStorage events don't cross windows).
        server.middlewares.use('/api/focus-timer', async (req, res, next) => {
          if (req.method !== 'GET' && req.method !== 'POST') return next();
          const auth = await requireAuth(req, res);
          if (!auth) return;
          const { userPaths } = auth;
          const fs = await import('fs/promises');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(userPaths.timerPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{}');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const result = await safeWriteJsonFile({ filePath: userPaths.timerPath, backupDir: userPaths.backupDir, baseName: 'focus-timer', body, kind: 'object', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write focus timer file' }));
              }
            });
          }
        });

        server.middlewares.use('/api/launch-widget', async (req, res, next) => {
          if (req.method === 'POST') {
            const auth = await requireAuth(req, res);
            if (!auth) return;
            const { spawn } = await import('child_process');
            const path = await import('path');
            const fs = await import('fs/promises');
            const pythonScript = path.resolve(import.meta.dirname, '..', '..', 'widget-window.py');

            // Always launch pythonw.exe DIRECTLY. It's a GUI-subsystem binary, so it
            // opens no console at all. Going through `conda run` used to pop a black
            // terminal in the user's face every time — conda.exe is a console program
            // and Node's windowsHide can't suppress it once detached.
            // The repo's own interpreter comes first. Anaconda's pythonw.exe was
            // quarantined by antivirus on this machine, and bare 'pythonw' is not
            // on PATH — see below for why that mattered so much.
            const candidates = [
              path.resolve(import.meta.dirname, '..', '..', '.venv-launcher', 'Scripts', 'pythonw.exe'),
              'C:\\ProgramData\\anaconda3\\pythonw.exe',
            ];
            let spawnCmd: string | null = null;
            for (const candidate of candidates) {
              try {
                await fs.access(candidate);
                spawnCmd = candidate;
                break;
              } catch (_) { /* try the next one */ }
            }

            if (!spawnCmd) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'No pythonw.exe found to launch the widget' }));
              return;
            }

            try {
              const child = spawn(spawnCmd, [pythonScript], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
              });
              // Without this, a failed spawn raises an unhandled 'error' event on
              // the child, which takes down the whole dev server — and with it the
              // app, the widget and the hotkey. A missing interpreter must never
              // be more than a failed button press.
              child.on('error', () => { /* reported below via the response */ });
              child.unref();
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Failed to spawn widget wrapper process' }));
            }
          } else {
            next();
          }
        });

        // ── Serve the optimised production bundle ──────────────────────────
        // Registered last, so every /api route above still wins. Everything
        // else is answered from dist/ instead of Vite's dev pipeline.
        //
        // This is the single biggest thing for phone performance. In dev mode
        // the browser fetches ~700 unbundled ES modules one at a time (brutal
        // over a tunnel) and runs React's development build, whose reconciler
        // is several times slower than the production one and which re-renders
        // components twice under StrictMode. A mid-range phone feels every bit
        // of that. The built bundle is minified, tree-shaken, served as a
        // handful of files and cached forever by hash.
        //
        // The API middlewares above stay exactly as they are — this is still
        // one process, so the Google sync engine's ssrLoadModule still works.
        // Set PLANNER_DEV=1 to get the normal HMR dev experience back.
        if (process.env.PLANNER_DEV !== '1') {
          const distDir = path.resolve(import.meta.dirname, 'dist', 'public');
          const distIndex = path.resolve(distDir, 'index.html');

          /** Newest mtime under a directory, so an edit anywhere triggers a rebuild. */
          const newestUnder = async (dir: string): Promise<number> => {
            let newest = 0;
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              const at = entry.isDirectory()
                ? await newestUnder(full)
                : await fs.stat(full).then(s => s.mtimeMs).catch(() => 0);
              if (at > newest) newest = at;
            }
            return newest;
          };

          const builtAt = await fs.stat(distIndex).then(s => s.mtimeMs).catch(() => 0);
          const sourceAt = Math.max(
            await newestUnder(path.resolve(import.meta.dirname, 'src')),
            await newestUnder(path.resolve(import.meta.dirname, 'public')),
            await fs.stat(path.resolve(import.meta.dirname, 'index.html')).then(s => s.mtimeMs).catch(() => 0),
          );
          // Rebuilding only when a source file is actually newer keeps a normal
          // start instant; the ~5s build is paid once, after a code change.
          if (sourceAt > builtAt) {
            console.log('[planner] app changed — rebuilding the optimised bundle…');
            const { build } = await import('vite');
            await build({ logLevel: 'warn' });
            console.log('[planner] bundle ready.');
          }

          const MIME: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.webmanifest': 'application/manifest+json',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.txt': 'text/plain; charset=utf-8',
          };

          // Icons, the manifest and robots.txt have no content hash, so they
          // cannot be immutable — but re-fetching them on every single open
          // wastes a round trip each on a slow link. A day of caching plus the
          // ETag revalidation below is the right trade for artwork.
          const SEMI_STATIC = /\.(png|ico|svg|webmanifest|txt|woff2?)$/i;

          server.middlewares.use(async (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const urlPath = (req.url || '/').split('?')[0];
            // Dev-only endpoints keep their own handlers.
            if (urlPath.startsWith('/api/') || urlPath.startsWith('/@') || urlPath.startsWith('/__')) {
              return next();
            }
            let file = path.join(distDir, decodeURIComponent(urlPath));
            if (!file.startsWith(distDir)) return next();
            let stat = await fs.stat(file).catch(() => null);
            // Client-side routes (/settings, /widget) have no file of their own
            // and must be answered with the shell.
            if (!stat?.isFile()) {
              file = distIndex;
              stat = await fs.stat(file).catch(() => null);
            }
            if (!stat?.isFile()) return next();

            const ext = path.extname(file).toLowerCase();
            res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
            // Asset filenames carry a content hash, so they can be cached
            // permanently — that is what stops the phone re-downloading the
            // whole app over the tunnel on every single open. index.html must
            // never be cached, or a new build would never be picked up.
            const isHashedAsset = file.includes(`${path.sep}assets${path.sep}`);
            res.setHeader(
              'Cache-Control',
              isHashedAsset
                ? 'public, max-age=31536000, immutable'
                : SEMI_STATIC.test(ext)
                  ? 'public, max-age=86400'
                  : 'no-cache',
            );
            res.setHeader('Vary', 'Accept-Encoding');

            // Serve the build's precompressed twin when the browser accepts it.
            // Brotli first: it beats gzip by another ~15% on this bundle and
            // every phone browser that reaches this app supports it over HTTPS.
            const accepted = String(req.headers['accept-encoding'] || '');
            let body = file;
            for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
              if (!accepted.includes(encoding)) continue;
              const candidate = `${file}${suffix}`;
              const encodedStat = await fs.stat(candidate).catch(() => null);
              if (!encodedStat?.isFile()) continue;
              res.setHeader('Content-Encoding', encoding);
              body = candidate;
              stat = encodedStat;
              break;
            }

            // Revalidation for everything not marked immutable: the shell and
            // the icons then cost one small 304 instead of a full re-download.
            const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
            res.setHeader('ETag', etag);
            if (!isHashedAsset && req.headers['if-none-match'] === etag) {
              res.statusCode = 304;
              res.end();
              return;
            }

            res.setHeader('Content-Length', String(stat.size));
            if (req.method === 'HEAD') { res.end(); return; }
            res.end(await fs.readFile(body));
          });
        }
      }
    },
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    // The phone re-downloads any chunk whose hash changed. With everything in
    // one file, editing a single line of the calendar invalidated React,
    // framer-motion and Radix too — the full payload again, over the tunnel.
    // Splitting the libraries out means an app edit re-sends only the app.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\/]node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return 'react-vendor';
          if (id.includes('framer-motion') || id.includes('motion-dom') || id.includes('motion-utils')) return 'motion-vendor';
          if (id.includes('@radix-ui')) return 'radix-vendor';
          return 'vendor';
        },
      },
    },
    // Compressed-size reporting re-gzips every chunk just to print a number;
    // the precompression plugin below already writes the real .br/.gz files.
    reportCompressedSize: false,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
