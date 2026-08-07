import path from 'path';
import fsp from 'fs/promises';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// ─── File-database safety net ──────────────────────────────────────────────
// Guards against a save silently wiping real data (e.g. a stale/empty client
// state getting POSTed, or the server briefly pointing at the wrong path
// mid-refactor): refuses to overwrite non-empty data with an empty payload,
// and keeps a rolling backup of whatever was on disk before every write.
function isEmptyJsonValue(text: string, kind: 'object' | 'array'): boolean {
  try {
    const parsed = JSON.parse(text);
    if (kind === 'array') return Array.isArray(parsed) && parsed.length === 0;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return true;
  }
}

async function pruneBackups(backupDir: string, baseName: string, keep = 30) {
  try {
    const files = (await fsp.readdir(backupDir)).filter(f => f.startsWith(`${baseName}.`));
    files.sort();
    const excess = files.length - keep;
    for (let i = 0; i < excess; i++) {
      await fsp.unlink(path.join(backupDir, files[i])).catch(() => {});
    }
  } catch {
    // no backups yet
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
  backupDir: string;
  baseName: string;
  body: string;
  kind: 'object' | 'array';
  force: boolean;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { filePath, backupDir, baseName, body, kind, force } = opts;

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

  if (existing !== null && !existingIsEmpty) {
    try {
      await fsp.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fsp.writeFile(path.join(backupDir, `${baseName}.${stamp}.json`), existing, 'utf-8');
      await pruneBackups(backupDir, baseName);
    } catch {
      // a failed backup should never block the actual save
    }
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, body, 'utf-8');
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

function autoBackupPaths(rootDir: string) {
  return {
    dbPath:       path.resolve(rootDir, 'database', 'database.json'),
    settingsPath: path.resolve(rootDir, 'database', 'settings.json'),
    sessionsPath: path.resolve(rootDir, 'database', 'focus-sessions.json'),
    tasksPath:    path.resolve(rootDir, 'database', 'tasks.json'),
    statePath:    path.resolve(rootDir, 'database', 'auto-backup-state.json'),
    outDir:       path.resolve(rootDir, 'backups'),
  };
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

async function writeAutoBackup(rootDir: string, reason: 'scheduled' | 'manual') {
  const p = autoBackupPaths(rootDir);
  const settings = await readJsonSafe(p.settingsPath, {});
  const cfg = coerceAutoBackupCfg((settings as Record<string, unknown>).autoBackup);
  const events = await readJsonSafe(p.dbPath, {});

  // A planner can have no events and still have settings/history worth backing up.
  const eventCount = events && typeof events === 'object' && !Array.isArray(events)
    ? Object.keys(events).length
    : 0;

  const payload = {
    // v3 adds `tasks`. Readers must accept 2 (no tasks) and 3.
    backupFormatVersion: 3,
    exportedAt: new Date().toISOString(),
    source: reason,
    events,
    settings,
    focusSessions: await readJsonSafe(p.sessionsPath, []),
    tasks: await readJsonSafe(p.tasksPath, {}),
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
  const p = autoBackupPaths(rootDir);
  const settings = await readJsonSafe(p.settingsPath, {});
  const cfg = coerceAutoBackupCfg((settings as Record<string, unknown>).autoBackup);
  if (!cfg.enabled) return;
  const state = await readJsonSafe(p.statePath, {});
  const last = Date.parse((state as Record<string, string>).lastBackupAt || '');
  const dueAfterMs = cfg.intervalHours * 3600_000;
  if (Number.isFinite(last) && Date.now() - last < dueAfterMs) return;
  await writeAutoBackup(rootDir, 'scheduled').catch(() => {});
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
    {
      name: 'local-file-db-plugin',
      async configureServer(server) {
          const fs = await import('fs/promises');
          const path = await import('path');

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

          const dbPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'database.json');
          const configPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'google-config.json');
          const tokensPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'google-tokens.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          /**
           * Live health of the Google connection, reported to the UI.
           *
           * Sync used to fail completely silently: the refresh token died, every
           * run bailed at `getGoogleToken() → null`, and the app went on showing
           * "Syncing" and "authenticated" for days while nothing moved in either
           * direction. Every failure now lands here and is surfaced.
           */
          const syncHealth = {
            auth: {
              ok: true,
              /** True only for errors a reconnect fixes (invalid_grant & friends). */
              needsReconnect: false,
              error: null,
              at: 0,
            },
            calendar: { lastRunAt: 0, lastOkAt: 0, pushed: 0, pulled: 0, deleted: 0, incomplete: false, error: null },
            tasks:    { lastRunAt: 0, lastOkAt: 0, pushed: 0, pulled: 0, deleted: 0, incomplete: false, error: null, skipped: null },
          };

          /** Live OAuth `state` nonces, keyed by value (CSRF protection). */
          const pendingOAuthStates = new Map();

          /** Errors where retrying with the same refresh token can never work. */
          const FATAL_OAUTH_ERRORS = new Set([
            'invalid_grant',        // expired, revoked, or password changed
            'invalid_client',       // client id/secret wrong
            'unauthorized_client',
            'invalid_request',
          ]);

          async function markAuthBroken(reason, needsReconnect) {
            syncHealth.auth = { ok: false, needsReconnect, error: reason, at: Date.now() };
            if (!needsReconnect) return;
            // Persist it so a dev-server restart doesn't go back to claiming the
            // connection is fine, and so the UI can ask for a reconnect on boot.
            try {
              const toks = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));
              if (toks.invalid === reason) return;
              toks.invalid = reason;
              toks.invalidAt = Date.now();
              await safeWriteJsonFile({
                filePath: tokensPath, backupDir, baseName: 'google-tokens',
                body: JSON.stringify(toks), kind: 'object', force: true,
              });
            } catch (_) {}
          }

          async function markAuthOk() {
            syncHealth.auth = { ok: true, needsReconnect: false, error: null, at: Date.now() };
          }

          // Single-flight refresh: several syncs (calendar + tasks + a manual run)
          // can want a token at the same moment, and three parallel refreshes of
          // the same grant is how you get Google to start rejecting them.
          let refreshInFlight = null;

          async function refreshAccessToken(config, tokens) {
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
              filePath: tokensPath,
              backupDir,
              baseName: 'google-tokens',
              body: JSON.stringify(tokens),
              kind: 'object',
              force: true,
            });
            await markAuthOk();
            return tokens.access_token;
          }

          /**
           * Access token, refreshed when stale. `force` throws away a cached token
           * that Google has started 401ing on mid-run.
           */
          async function getGoogleToken(force = false) {
            try {
              const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
              const tokens = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));

              if (!tokens.refresh_token) {
                await markAuthBroken('No refresh token stored. Connect Google again.', true);
                return null;
              }

              const now = Date.now();
              if (!force && tokens.expires_at && now < tokens.expires_at - 60000) {
                // A token file flagged invalid may still hold a technically unexpired
                // access token; using it is fine, and a working call clears the flag.
                if (!tokens.invalid) await markAuthOk();
                return tokens.access_token;
              }

              if (!refreshInFlight) {
                refreshInFlight = refreshAccessToken(config, tokens)
                  .finally(() => { refreshInFlight = null; });
              }
              return await refreshInFlight;
            } catch (err) {
              // Reading/parsing the local files failed — not something a reconnect fixes.
              await markAuthBroken(`Could not read Google credentials: ${err.message}`, false);
              console.error('Error in getGoogleToken:', err);
              return null;
            }
          }

          /**
           * One Google API call with the retries the previous code had none of.
           *
           * • 401 → the access token died mid-run; refresh once and retry.
           * • 429 / 5xx → Google is rate-limiting or wobbling; back off and retry.
           * • Network throw → same treatment; a dropped Wi-Fi packet must not look
           *   like "this event no longer exists on Google".
           *
           * Returns the Response (which may still be !ok) or null when the call
           * never completed, so callers can tell "Google said no" from "we never
           * got an answer" — the distinction that keeps deletion mirroring safe.
           */
          async function gfetch(url, init = {}, opts = {}) {
            const { tries = 3, label = 'google' } = opts;
            let token = await getGoogleToken();
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
                  console.error(`[google] ${label} network failure:`, err.message);
                  return null;
                }
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                continue;
              }

              if (res.status === 401 && attempt < tries - 1) {
                const fresh = await getGoogleToken(true);
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
          function mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseRecur, palettes, calHex) {
            const isAllDay = !!gEv.start.date;
            const { recur, exdates } = gEv.recurrence ? parseRecur(gEv.recurrence) : {};
            const gCalHex = resolveGoogleHex(gEv, palettes, calHex || {});

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
                color: mapGoogleColor(gEv.gCalCalendarId),
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
                color: mapGoogleColor(gEv.gCalCalendarId),
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
          // `palettes` is the /colors resource; `calHex` maps calendarId → hex from
          // the calendar list. Returns null when neither is known, and the caller
          // falls back to the app's five-swatch palette.
          function resolveGoogleHex(gEv, palettes, calHex) {
            if (gEv.colorId && palettes && palettes.event && palettes.event[gEv.colorId]) {
              return palettes.event[gEv.colorId].background;
            }
            return calHex[gEv.gCalCalendarId] || null;
          }

          // Fallback swatch, used only when Google gave us no colour at all. Spread
          // across the palette by calendar id so different calendars stay tellable
          // apart rather than all landing on one swatch.
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

            if (ev.allDay) {
              const endDate = addDays(eventDate, ev.daysSpan || 1);
              const body: any = {
                summary: ev.content || 'Untitled',
                start: { date: dateStr },
                end: { date: format(endDate, 'yyyy-MM-dd') }
              };
              if (recurrence) body.recurrence = recurrence;
              stampPlannerId(body, plannerId || ev.id);
              return body;
            } else {
              const [sh, sm] = (ev.startTime || '00:00').split(':').map(Number);
              const [eh, em] = (ev.endTime || ev.startTime || '00:30').split(':').map(Number);
              const startDate = new Date(eventDate); startDate.setHours(sh, sm, 0, 0);
              const endDate = new Date(eventDate); endDate.setHours(eh, em, 0, 0);
              const body: any = {
                summary: ev.content || 'Untitled',
                start: { dateTime: startDate.toISOString(), timeZone: tz },
                end: { dateTime: endDate.toISOString(), timeZone: tz }
              };
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
          let isTasksSyncing = false;

          async function runGoogleTasksSync(clientTasks, todayYmdOpt, weekStartsOnOpt = 0) {
            if (isTasksSyncing) {
              syncHealth.tasks.skipped = 'A tasks sync was already running';
              return clientTasks;
            }
            isTasksSyncing = true;
            syncHealth.tasks.lastRunAt = Date.now();
            syncHealth.tasks.error = null;
            syncHealth.tasks.skipped = null;
            let pushed = 0;
            let pushFailures = 0;
            try {
              const accessToken = await getGoogleToken();
              if (!accessToken) {
                syncHealth.tasks.error = syncHealth.auth.error || 'Not connected to Google';
                return clientTasks;
              }

              // Bail before making a single call if Tasks wasn't authorised — the
              // alternative is a 403 on every request, every four minutes. This
              // used to be a silent `return`, which is how "Tasks never synced"
              // stayed invisible for weeks.
              try {
                const toks = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));
                if (!String(toks.scope || '').includes('/auth/tasks')) {
                  syncHealth.tasks.skipped = 'The Google connection has no Tasks permission — reconnect to grant it';
                  return clientTasks;
                }
              } catch (err) {
                syncHealth.tasks.error = `Could not read Google credentials: ${err.message}`;
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
                if (!res || !res.ok) throw new Error(`Failed to list task lists: ${res ? res.status : 'no response'}`);
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
              isTasksSyncing = false;
            }
          }

          // Main sync logic
          let isSyncing = false;
          async function runGoogleSync(clientEvents, weekStartsOnOpt = 0) {
            if (isSyncing) {
              console.log('Sync already in progress. Skipping concurrent run.');
              return clientEvents;
            }
            isSyncing = true;
            syncHealth.calendar.lastRunAt = Date.now();
            syncHealth.calendar.error = null;
            let pushed = 0;
            let pushFailures = 0;
            try {
              const accessToken = await getGoogleToken();
              if (!accessToken) {
                // getGoogleToken has already recorded WHY on syncHealth.auth; the
                // endpoint reports it so the UI stops claiming everything is fine.
                syncHealth.calendar.error = syncHealth.auth.error || 'Not connected to Google';
                return clientEvents;
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

              // 2. Find or create "Daily calendar"
              let targetCal = calendars.find(c => c.summary === 'Daily calendar');
              let targetCalendarId = '';
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

              // A. Mirror local deletions to Google. A tombstone (deleted:true) that
              //    carries a Daily gCalId is DELETEd on Google (this covers a whole
              //    repeating series too); then the record is dropped locally. A
              //    tombstone without a gCalId (never synced, or a foreign read-only
              //    event the user hid) is just dropped.
              for (const [id, ev] of Object.entries(localMap)) {
                if (!ev.deleted) continue;
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

              // B. Push app-owned creates/updates to the Daily calendar ONLY. Each app
              //    event (repeating or not) is one Google event; recurrence comes from
              //    ev.recur via constructGoogleEventBody → buildGoogleRecurrence. Events
              //    carrying a foreign gCalId are read-only mirrors, never written back.
              // Records we create/update on Google in this pass. The Daily calendar was
              // fetched at the very start (before these writes), so its snapshot is stale
              // for exactly these ids — we must NOT reconcile them against it in step C,
              // or we'd overwrite the change we just pushed with its pre-push state (the
              // "new item / new repeat vanishes then reappears" bug).
              const justPushed = new Set();
              for (const [id, ev] of Object.entries(localMap)) {
                if (ev.deleted) continue;
                const isForeign = ev.gCalId && ev.gCalCalendarId && ev.gCalCalendarId !== targetCalendarId;
                if (isForeign) continue;

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

              // C. Pull the Daily calendar back in — Google may also edit/create there.
              for (const gEv of dailyGoogleEvents) {
                // Deleted during this run (step A orphan cleanup) — it no longer exists
                // on Google, so importing it back would resurrect what the user removed.
                if (!seenGCalIds.has(gEv.gCalId)) continue;
                const localId = localByGCalId.get(gEv.gCalId);
                if (!localId) {
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex);
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
                // A local edit we just pushed wins this round; only pull when Google is ahead.
                const locallyDirty = ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt);
                if (!locallyDirty && ev.gCalETag !== gEv.gCalETag) {
                  const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex);
                  if (g) {
                    // Daily events are app-owned: the app is the source of truth for
                    // colour (Google doesn't store our palette, so mapGoogleColor would
                    // clobber the user's choice — e.g. green → lilac). Keep ev.color.
                    localMap[localId] = { ...ev, ...g, id: localId, color: ev.color, gCalHex: ev.gCalHex, recur: g.recur, exdates: g.exdates, completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                  }
                }
              }

              // D. Pull read-only events from every other calendar.
              for (const gEv of otherGoogleEvents) {
                const localId = localByGCalId.get(gEv.gCalId);
                if (!localId) {
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex);
                  if (plannerEv) {
                    plannerEv.lastSyncedAt = nowMs;
                    localMap[plannerEv.id] = plannerEv;
                    localByGCalId.set(gEv.gCalId, plannerEv.id);
                  }
                } else {
                  const ev = localMap[localId];
                  if (ev && !ev.deleted && ev.gCalETag !== gEv.gCalETag) {
                    const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence, palettes, calHex);
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

              // E. Mirror Google-side deletions: any previously-synced local event whose
              //    gCalId is no longer present on Google is removed locally. Repeating
              //    masters are always reconciled; non-repeating ones only when their date
              //    is inside the fetch window (so events outside it aren't wrongly dropped).
              for (const [id, ev] of Object.entries(localMap)) {
                if (fetchIncomplete) break; // snapshot unreliable → never mirror deletions this run
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
              isSyncing = false;
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
            try {
              let configured = false;
              let clientId = '';
              let clientSecret = '';
              let autoSync = false;
              try {
                const conf = JSON.parse(await fs.readFile(configPath, 'utf-8'));
                clientId = conf.clientId || '';
                clientSecret = conf.clientSecret || '';
                autoSync = !!conf.autoSync;
                configured = !!(clientId && clientSecret);
              } catch (_) {}

              let authenticated = false;
              let email = '';
              let hasTasksScope = false;
              // A stored refresh token Google has since rejected is NOT a working
              // connection. Reporting it as one is what let the app show "Syncing"
              // for days while every single call was failing.
              let storedInvalid = null;
              try {
                const toks = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));
                authenticated = !!toks.refresh_token;
                email = toks.email || '';
                hasTasksScope = String(toks.scope || '').includes('/auth/tasks');
                storedInvalid = toks.invalid || null;
              } catch (_) {}

              // Probe the credential when we don't already know it's broken. This
              // is what makes the UI notice a dead authorisation on its own: a
              // still-valid access token returns from cache with no network call,
              // and an expired one costs exactly one refresh (whose failure is
              // then remembered, so this never becomes a poll against Google).
              if (authenticated && !storedInvalid && !syncHealth.auth.needsReconnect) {
                await getGoogleToken();
                try {
                  const fresh = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));
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
                  filePath: configPath,
                  backupDir,
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
            try {
              const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
              const redirectUri = new URL(req.url || '', 'http://localhost').searchParams.get('redirectUri');
              if (!redirectUri) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Missing redirectUri parameter' }));
                return;
              }

              // Google matches this string EXACTLY against the client's Authorized
              // redirect URIs — scheme, host, port, path and trailing slash all
              // count, and http://localhost:5173 and http://127.0.0.1:5173 are two
              // different entries. This app is opened under both (the main window
              // via localhost, the widget via 127.0.0.1), which is exactly how you
              // end up staring at Error 400: redirect_uri_mismatch. Reject anything
              // malformed here rather than letting Google reject it after a
              // full-page navigation, and hand the caller both spellings so the UI
              // can tell the user precisely what to register.
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

              // CSRF: Google hands this back untouched on the callback, and the
              // exchange refuses a code that doesn't carry the nonce we issued.
              const state = crypto.randomUUID();
              pendingOAuthStates.set(state, { at: Date.now(), redirectUri });
              for (const [k, v] of pendingOAuthStates) {
                if (Date.now() - v.at > 15 * 60 * 1000) pendingOAuthStates.delete(k);
              }
              // Calendar + Tasks. An existing refresh token was minted calendar-only,
              // so adding Tasks requires a reconnect — `prompt=consent` already forces
              // the consent screen and reissues a refresh token, so a plain reconnect
              // is enough. `include_granted_scopes` keeps it incremental.
              const scope = [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/tasks',
              ].join(' ');
              // access_type=offline + prompt=consent is what guarantees a REFRESH
              // token comes back (without consent, a repeat authorisation returns
              // an access token only, and sync dies again in an hour).
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
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              try {
                const { code, redirectUri, state } = JSON.parse(body);
                const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

                // Refuse a code that didn't come from an authorisation we started.
                // Tolerated when absent so a link opened from an older build (or a
                // manually pasted code) still works — the nonce is the check, its
                // absence just means we can't perform it.
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
                  // What Google actually granted — checked before any Tasks call.
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
                  filePath: tokensPath,
                  backupDir,
                  baseName: 'google-tokens',
                  body: JSON.stringify(tokens),
                  kind: 'object',
                  force: true
                });

                // A fresh grant clears the "reconnect me" state held in memory —
                // without this the UI kept demanding a reconnect it had just done.
                await markAuthOk();
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
            try {
              await fs.unlink(tokensPath).catch(() => {});
              // Deliberately disconnected is not "broken" — clear the alarm, or the
              // header would nag for a reconnect the user just chose to undo.
              await markAuthOk();
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
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
              try {
                const { events: clientEvents, weekStartsOn: weekStartsOnOpt } = JSON.parse(body);
                const synced = await runGoogleSync(clientEvents, weekStartsOnOpt || 0);

                // runGoogleSync returns the exact same object it was given when a sync was
                // skipped (another run already in progress, or Google not connected). In that
                // case it did no merge — don't write it back, or we'd clobber a concurrent
                // real merge with un-annotated events.
                if (synced !== clientEvents) {
                  await safeWriteJsonFile({
                    filePath: dbPath,
                    backupDir,
                    baseName: 'database',
                    body: JSON.stringify(synced),
                    kind: 'object',
                    force: true
                  });
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
                res.end(JSON.stringify({ error: `Sync failed: ${err.message}` }));
              }
            });
          });

          // Note the registration order: connect matches by prefix, and
          // '/api/google-sync' is not a prefix of '/api/google-tasks-sync', so
          // these two don't shadow each other.
          server.middlewares.use('/api/google-tasks-sync', async (req, res) => {
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
                const { tasks: clientTasks, today, weekStartsOn: wso } = JSON.parse(body);
                const synced = await runGoogleTasksSync(clientTasks || {}, today, wso || 0);

                // Same contract as /api/google-sync: an identical reference back
                // means the run bailed and merged nothing — writing it would
                // clobber a concurrent real merge.
                if (synced !== clientTasks) {
                  await safeWriteJsonFile({
                    filePath: path.resolve(import.meta.dirname, '..', '..', 'database', 'tasks.json'),
                    backupDir,
                    baseName: 'tasks',
                    body: JSON.stringify(synced),
                    kind: 'object',
                    force: true,
                  });
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
                res.end(JSON.stringify({ error: `Tasks sync failed: ${err.message}` }));
              }
            });
          });

          server.middlewares.use('/api/events', async (req, res, next) => {
            const fs = await import('fs/promises');
            const path = await import('path');
            const dbPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'database.json');
            const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(dbPath, 'utf-8');
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
                const result = await safeWriteJsonFile({ filePath: dbPath, backupDir, baseName: 'database', body, kind: 'object', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
                // NOTE: Google sync is driven exclusively by the client via /api/google-sync.
                // Kicking off a second background sync here raced with that call and could
                // write back un-annotated events (losing gCalId links → duplicate Google events).
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write to file database' }));
              }
            });
          } else {
            next();
          }
        });

        // Tasks live in their OWN file, never in database.json. Mixing them would
        // hand them to runGoogleSync, which pushes everything it is given to the
        // Daily calendar — tasks belong to Google TASKS, not Google Calendar.
        server.middlewares.use('/api/tasks', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const tasksPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'tasks.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(tasksPath, 'utf-8');
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
                const result = await safeWriteJsonFile({ filePath: tasksPath, backupDir, baseName: 'tasks', body, kind: 'object', force });
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
                res.end(JSON.stringify({ error: 'Failed to write tasks' }));
              }
            });
          } else {
            next();
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
            const resp = await fetch(api, { headers: { 'User-Agent': 'weekly-planner' } });
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
            try {
              await fs.mkdir(path.dirname(cachePath), { recursive: true });
              await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
            } catch (err) {
              console.error('[prayer] failed to write cache:', err);
            }
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
          const fs = await import('fs/promises');
          const path = await import('path');
          const donePath = path.resolve(import.meta.dirname, '..', '..', 'database', 'prayer-done.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(donePath, 'utf-8');
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
                const result = await safeWriteJsonFile({ filePath: donePath, backupDir, baseName: 'prayer-done', body, kind: 'object', force });
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
          } else {
            next();
          }
        });

        server.middlewares.use('/api/settings', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const settingsPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'settings.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(settingsPath, 'utf-8');
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
                const result = await safeWriteJsonFile({ filePath: settingsPath, backupDir, baseName: 'settings', body, kind: 'object', force });
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
                res.end(JSON.stringify({ error: 'Failed to write settings file' }));
              }
            });
          } else {
            next();
          }
        });

        // ── Automated backups ────────────────────────────────────────────────
        {
          const rootDir = path.resolve(import.meta.dirname, '..', '..');
          // Check on boot, then hourly. The interval itself lives in settings, so
          // changing it in the UI takes effect at the next hourly check.
          maybeRunAutoBackup(rootDir).catch(() => {});
          const backupTimer = setInterval(() => { maybeRunAutoBackup(rootDir).catch(() => {}); }, 3600_000);
          if (typeof backupTimer.unref === 'function') backupTimer.unref();

          server.middlewares.use('/api/auto-backup', async (req, res, next) => {
            const p = autoBackupPaths(rootDir);
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
                const result = await writeAutoBackup(rootDir, 'manual');
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) { res.statusCode = 409; res.end(JSON.stringify({ error: result.reason })); return; }
                res.end(JSON.stringify({ success: true, ...result }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write backup' }));
              }
              return;
            }
            next();
          });
        }

        server.middlewares.use('/api/focus-sessions', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const focusPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'focus-sessions.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(focusPath, 'utf-8');
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
                // The main window and the widget each hold the whole session list
                // and POST all of it. A plain overwrite therefore loses a session
                // the *other* window logged since this one last read the file —
                // that is how a completed hour of focus vanished. Merge by id
                // instead. `force` (a deliberate manual edit of a day's total,
                // which legitimately removes rows) still replaces outright.
                const merged = force ? body : await mergeFocusSessions(focusPath, body);
                const result = await safeWriteJsonFile({ filePath: focusPath, backupDir, baseName: 'focus-sessions', body: merged, kind: 'array', force });
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
          } else {
            next();
          }
        });

        // Live push for everything else in the file database (events, settings,
        // focus sessions). The widget used to poll these every 5s, which is why a
        // change made in the main window took seconds to show up there.
        server.middlewares.use('/api/db-stream', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          const fs = await import('fs');
          const fsp = await import('fs/promises');
          const path = await import('path');
          const dbDir = path.resolve(import.meta.dirname, '..', '..', 'database');
          // SSE event name → file in database/.
          const WATCHED: Record<string, string> = {
            events: 'database.json',
            settings: 'settings.json',
            'focus-sessions': 'focus-sessions.json',
            tasks: 'tasks.json',
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
              const data = await fsp.readFile(path.join(dbDir, file), 'utf-8');
              if (data === lastSent[name]) return;
              lastSent[name] = data;
              res.write(`event: ${name}\ndata: ${data.replace(/\s*\n\s*/g, ' ')}\n\n`);
            } catch (_) { /* not written yet */ }
          };

          // Watch the directory, not each file: atomic writes replace the inode and
          // a file-level watcher would go deaf after the first save. The watch event
          // often lands while the temp file is still being renamed into place, so
          // re-read a couple of times before giving up on it.
          const sendSoon = (name: string) => {
            send(name);
            setTimeout(() => send(name), 40);
            setTimeout(() => send(name), 150);
          };
          let watcher: any = null;
          try {
            watcher = fs.watch(dbDir, (_evt, changed) => {
              if (!changed) return;
              for (const [name, file] of Object.entries(WATCHED)) {
                if (String(changed).startsWith(file)) sendSoon(name);
              }
            });
          } catch (_) { /* the sweep below still covers it */ }

          // Backstop: fs.watch drops events on Windows often enough to be felt.
          // Re-reading a handful of small files a few times a second is nothing, and it
          // caps the worst case at a quarter second instead of seconds.
          const sweep = setInterval(() => {
            for (const name of Object.keys(WATCHED)) send(name);
          }, 250);

          const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
          req.on('close', () => {
            clearInterval(ping);
            clearInterval(sweep);
            if (watcher) try { watcher.close(); } catch (_) {}
          });
        });

        // Live push of the shared timer state. Polling for it meant a start/pause
        // made elsewhere (widget, system-wide hotkey) only showed up on the next
        // tick; this delivers it the moment the file changes.
        server.middlewares.use('/api/focus-timer/stream', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          const fs = await import('fs');
          const fsp = await import('fs/promises');
          const path = await import('path');
          const dbDir = path.resolve(import.meta.dirname, '..', '..', 'database');
          const timerPath = path.join(dbDir, 'focus-timer.json');

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });

          let lastSent = '';
          const send = async () => {
            try {
              const data = await fsp.readFile(timerPath, 'utf-8');
              if (data === lastSent) return;
              lastSent = data;
              res.write(`data: ${data.replace(/\s*\n\s*/g, ' ')}\n\n`);
            } catch (_) { /* file not written yet */ }
          };
          await send();

          // Watch the directory, not the file: atomic writes replace the inode and
          // a file-level watcher would go deaf after the first save. The event often
          // lands while the temp file is still being renamed in, so re-read a couple
          // of times rather than trusting the first look.
          const sendSoon = () => {
            send();
            setTimeout(send, 40);
            setTimeout(send, 150);
          };
          let watcher: any = null;
          try {
            watcher = fs.watch(dbDir, (_evt, name) => {
              if (!name || String(name).startsWith('focus-timer.json')) sendSoon();
            });
          } catch (_) { /* the sweep below still covers it */ }

          // Backstop: fs.watch drops events on Windows often enough to be felt —
          // this is what keeps a hotkey press from ever appearing to hang.
          const sweep = setInterval(send, 200);

          // Keep-alive comment so proxies/browsers don't drop an idle stream.
          const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
          req.on('close', () => {
            clearInterval(ping);
            clearInterval(sweep);
            if (watcher) try { watcher.close(); } catch (_) {}
          });
        });

        // Start/pause the focus timer without a browser window in the picture. This is
        // what the system-wide hotkey helper (focus-hotkey.py) calls, so the shortcut
        // works from any app on the desktop. Registered BEFORE /api/focus-timer because
        // connect matches by prefix.
        // A single physical keypress must never land as two toggles. Key repeat,
        // a bouncy switch or a duplicate hotkey helper would otherwise start and
        // immediately pause again, which reads as "it pressed itself twice".
        let lastToggleAt = 0;
        const TOGGLE_DEBOUNCE_MS = 300;

        // Both windows watch the same timer, so both would play the same cue.
        // localStorage can't arbitrate that: the main window is Chrome and the
        // widget is WebView2, with separate storage. The server is the one thing
        // they share, so it hands the cue to whoever asks first.
        const cueClaims = new Map<string, number>();

        server.middlewares.use('/api/focus-cue/claim', (req, res, next) => {
          if (req.method !== 'POST') return next();
          const key = new URL(req.url ?? '', 'http://x').searchParams.get('key') ?? '';
          const now = Date.now();
          for (const [k, t] of cueClaims) if (now - t > 30000) cueClaims.delete(k);
          const granted = !cueClaims.has(key);
          if (granted) cueClaims.set(key, now);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ granted }));
        });

        // Liveness stamp for a running focus session. Every open window refreshes
        // it every few seconds; it lives on disk so it survives the machine being
        // switched off. On the next launch a stale stamp is how the app knows the
        // session died with the PC, and exactly when — see focusRecoveryFor().
        // Written straight (no backup rotation): it's disposable, high-frequency
        // state, not user data.
        server.middlewares.use('/api/focus-heartbeat', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const beatPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'focus-heartbeat.json');

          if (req.method === 'GET') {
            try {
              res.setHeader('Content-Type', 'application/json');
              res.end(await fs.readFile(beatPath, 'utf-8'));
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
                await fs.writeFile(beatPath, JSON.stringify({
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
          } else {
            next();
          }
        });

        server.middlewares.use('/api/focus-timer/toggle', async (req, res, next) => {
          if (req.method !== 'POST') return next();
          const nowMs = Date.now();
          if (nowMs - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, debounced: true }));
            return;
          }
          lastToggleAt = nowMs;
          const fs = await import('fs/promises');
          const path = await import('path');
          const timerPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'focus-timer.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');
          try {
            let timer: Record<string, unknown> = { plannedSeconds: 3600, accumulatedSeconds: 0, isRunning: false, lastStartedAt: null, sessionStartedAt: null, lastPausedAt: null };
            try {
              const parsed = JSON.parse(await fs.readFile(timerPath, 'utf-8'));
              if (parsed && typeof parsed === 'object') {
                timer = {
                  plannedSeconds: Number(parsed.plannedSeconds) || 3600,
                  accumulatedSeconds: Math.max(0, Number(parsed.accumulatedSeconds) || 0),
                  isRunning: Boolean(parsed.isRunning),
                  lastStartedAt: typeof parsed.lastStartedAt === 'string' ? parsed.lastStartedAt : null,
                  sessionStartedAt: typeof parsed.sessionStartedAt === 'string' ? parsed.sessionStartedAt : null,
                  lastPausedAt: typeof parsed.lastPausedAt === 'string' ? parsed.lastPausedAt : null,
                };
              }
            } catch (_) { /* no file yet → defaults */ }

            const nowIso = new Date().toISOString();
            if (timer.isRunning) {
              // Pause: bank the time run so far, exactly like pauseFocus() in the app.
              // lastPausedAt stamps this particular pause so its cue is not taken
              // for a repeat of an earlier one.
              const ran = timer.lastStartedAt
                ? Math.max(0, Math.floor((Date.now() - new Date(timer.lastStartedAt as string).getTime()) / 1000))
                : 0;
              timer = { ...timer, accumulatedSeconds: (timer.accumulatedSeconds as number) + ran, isRunning: false, lastStartedAt: null, lastPausedAt: nowIso };
            } else {
              timer = { ...timer, isRunning: true, lastStartedAt: nowIso, sessionStartedAt: timer.sessionStartedAt || nowIso, lastPausedAt: null };
            }

            await safeWriteJsonFile({ filePath: timerPath, backupDir, baseName: 'focus-timer', body: JSON.stringify(timer), kind: 'object', force: true });
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
          const fs = await import('fs/promises');
          const path = await import('path');
          const timerPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'focus-timer.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(timerPath, 'utf-8');
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
                const result = await safeWriteJsonFile({ filePath: timerPath, backupDir, baseName: 'focus-timer', body, kind: 'object', force });
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
          } else {
            next();
          }
        });

        server.middlewares.use('/api/launch-widget', async (req, res, next) => {
          if (req.method === 'POST') {
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
