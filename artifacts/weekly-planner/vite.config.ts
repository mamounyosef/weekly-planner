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

  // Never write an empty snapshot over a healthy history — a blank backup is
  // worse than no backup, since it silently consumes a retention slot.
  if (!events || typeof events !== 'object' || Object.keys(events).length === 0) {
    return { ok: false as const, reason: 'no events to back up' };
  }

  const payload = {
    backupFormatVersion: 2,
    exportedAt: new Date().toISOString(),
    source: reason,
    events,
    settings,
    focusSessions: await readJsonSafe(p.sessionsPath, []),
  };

  await fsp.mkdir(p.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(p.outDir, `${AUTO_BACKUP_PREFIX}${stamp}.json`);
  await fsp.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  await pruneAutoBackups(p.outDir, cfg.keep);
  await fsp.writeFile(p.statePath, JSON.stringify({ lastBackupAt: new Date().toISOString() }, null, 2), 'utf-8').catch(() => {});
  return { ok: true as const, file: path.basename(file), count: Object.keys(events).length };
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

          // Helper to get access token (refreshing if needed)
          async function getGoogleToken() {
            try {
              const configData = await fs.readFile(configPath, 'utf-8');
              const config = JSON.parse(configData);
              const tokensData = await fs.readFile(tokensPath, 'utf-8');
              const tokens = JSON.parse(tokensData);

              if (!tokens.refresh_token) throw new Error('No refresh token');

              const now = Date.now();
              if (tokens.expires_at && now < tokens.expires_at - 60000) {
                return tokens.access_token;
              }

              const params = new URLSearchParams();
              params.append('client_id', config.clientId);
              params.append('client_secret', config.clientSecret);
              params.append('refresh_token', tokens.refresh_token);
              params.append('grant_type', 'refresh_token');

              const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString()
              });

              if (!tokenRes.ok) {
                throw new Error(`Failed to refresh token: ${tokenRes.statusText}`);
              }

              const tokenData = await tokenRes.json();
              tokens.access_token = tokenData.access_token;
              if (tokenData.refresh_token) {
                tokens.refresh_token = tokenData.refresh_token;
              }
              tokens.expires_at = Date.now() + tokenData.expires_in * 1000;

              await safeWriteJsonFile({
                filePath: tokensPath,
                backupDir,
                baseName: 'google-tokens',
                body: JSON.stringify(tokens),
                kind: 'object',
                force: true
              });

              return tokens.access_token;
            } catch (err) {
              console.error('Error in getGoogleToken:', err);
              return null;
            }
          }

          // Maps Google event to PlannerEvent. `parseRecur` (from recurrence.ts)
          // turns a Google recurrence array into { recur, exdates } so a repeating
          // event round-trips as a single master.
          function mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseRecur) {
            const isAllDay = !!gEv.start.date;
            const { recur, exdates } = gEv.recurrence ? parseRecur(gEv.recurrence) : {};

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
                weekKey,
                ...(recur ? { recur } : {}),
                ...(exdates ? { exdates } : {}),
                gCalId: gEv.gCalId,
                gCalCalendarId: gEv.gCalCalendarId,
                gCalETag: gEv.gCalETag
              };
            }
          }

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
          function constructGoogleEventBody(ev, format, addDays, buildRecur) {
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
              return body;
            }
          }

          // The concrete calendar date of a single-week event (for sync-window filtering).
          // Recurring ('all') events return null — they are always "in window".
          function eventOccurrenceDate(ev, addDays) {
            if (ev.recur || !ev.weekKey) return null;
            const weekStartDate = new Date(ev.weekKey + 'T00:00:00');
            return addDays(weekStartDate, ev.dayIndex || 0);
          }

          // Main sync logic
          let isSyncing = false;
          async function runGoogleSync(clientEvents, weekStartsOnOpt = 0) {
            if (isSyncing) {
              console.log('Sync already in progress. Skipping concurrent run.');
              return clientEvents;
            }
            isSyncing = true;
            try {
              const accessToken = await getGoogleToken();
              if (!accessToken) return clientEvents;

              const { format, startOfWeek, addDays, differenceInDays } = await import('date-fns');
              // Load the app's own recurrence formatting so app↔Google mapping stays
              // in one place (no duplicated RRULE logic drifting out of sync).
              const { buildGoogleRecurrence, parseGoogleRecurrence } = await server.ssrLoadModule('/src/lib/recurrence.ts');

              // 1. Fetch calendar list
              const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              if (!listRes.ok) throw new Error(`Failed to list calendars: ${listRes.statusText}`);
              const listData = await listRes.json();
              const calendars = listData.items || [];

              // 2. Find or create "Daily calendar"
              let targetCal = calendars.find(c => c.summary === 'Daily calendar');
              let targetCalendarId = '';
              if (targetCal) {
                targetCalendarId = targetCal.id;
              } else {
                const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ summary: 'Daily calendar' })
                });
                if (!createRes.ok) throw new Error('Failed to create Daily calendar');
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
                  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
                  if (!res.ok) { fetchIncomplete = true; break; }
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
                      description: item.description || ''
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

              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

              // A. Mirror local deletions to Google. A tombstone (deleted:true) that
              //    carries a Daily gCalId is DELETEd on Google (this covers a whole
              //    repeating series too); then the record is dropped locally. A
              //    tombstone without a gCalId (never synced, or a foreign read-only
              //    event the user hid) is just dropped.
              for (const [id, ev] of Object.entries(localMap)) {
                if (!ev.deleted) continue;
                if (ev.gCalId && ev.gCalCalendarId === targetCalendarId) {
                  try {
                    const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${accessToken}` }
                    });
                    if (delRes.ok || delRes.status === 404 || delRes.status === 410) {
                      seenGCalIds.delete(ev.gCalId);
                      delete localMap[id];
                    }
                  } catch (err) {
                    console.error(`Failed to delete event ${ev.gCalId} from Google:`, err);
                  }
                } else {
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

                if (!ev.gCalId) {
                  try {
                    const body = constructGoogleEventBody(ev, format, addDays, buildGoogleRecurrence);
                    const insRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    });
                    if (insRes.ok) {
                      const created = await insRes.json();
                      localMap[id] = { ...ev, gCalId: created.id, gCalCalendarId: targetCalendarId, gCalETag: created.etag, lastSyncedAt: nowMs };
                      seenGCalIds.add(created.id);
                      justPushed.add(id);
                    } else {
                      console.error(`Google API insert failed for event ${id}: Status ${insRes.status} - ${await insRes.text()}`);
                    }
                  } catch (err) {
                    console.error(`Failed to create local event ${id} on Google:`, err);
                  }
                }
                else if (ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt)) {
                  try {
                    const body = constructGoogleEventBody(ev, format, addDays, buildGoogleRecurrence);
                    const updRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                      method: 'PUT',
                      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    });
                    if (updRes.ok) {
                      const updated = await updRes.json();
                      localMap[id] = { ...ev, gCalETag: updated.etag, lastSyncedAt: nowMs };
                      seenGCalIds.add(ev.gCalId);
                      justPushed.add(id);
                    } else if (updRes.status === 404 || updRes.status === 410) {
                      seenGCalIds.delete(ev.gCalId);
                      delete localMap[id];
                    } else {
                      console.error(`Google API update failed for event ${ev.gCalId}: Status ${updRes.status} - ${await updRes.text()}`);
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
                const localId = localByGCalId.get(gEv.gCalId);
                if (!localId) {
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence);
                  if (plannerEv) {
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
                  const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence);
                  if (g) {
                    // Daily events are app-owned: the app is the source of truth for
                    // colour (Google doesn't store our palette, so mapGoogleColor would
                    // clobber the user's choice — e.g. green → lilac). Keep ev.color.
                    localMap[localId] = { ...ev, ...g, id: localId, color: ev.color, recur: g.recur, exdates: g.exdates, completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                  }
                }
              }

              // D. Pull read-only events from every other calendar.
              for (const gEv of otherGoogleEvents) {
                const localId = localByGCalId.get(gEv.gCalId);
                if (!localId) {
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence);
                  if (plannerEv) {
                    plannerEv.lastSyncedAt = nowMs;
                    localMap[plannerEv.id] = plannerEv;
                    localByGCalId.set(gEv.gCalId, plannerEv.id);
                  }
                } else {
                  const ev = localMap[localId];
                  if (ev && !ev.deleted && ev.gCalETag !== gEv.gCalETag) {
                    const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt, parseGoogleRecurrence);
                    if (g) {
                      localMap[localId] = { ...ev, ...g, id: localId, recur: g.recur, exdates: g.exdates, completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                    }
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

              return localMap;
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
              try {
                const toks = JSON.parse(await fs.readFile(tokensPath, 'utf-8'));
                authenticated = !!toks.refresh_token;
                email = toks.email || '';
              } catch (_) {}

              res.end(JSON.stringify({ configured, authenticated, email, autoSync, clientId, clientSecret }));
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
              const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=https://www.googleapis.com/auth/calendar&access_type=offline&prompt=consent`;
              res.end(JSON.stringify({ url: authUrl }));
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
                const { code, redirectUri } = JSON.parse(body);
                const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

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
                  res.statusCode = 400;
                  res.end(JSON.stringify({ error: `Token exchange failed: ${errText}` }));
                  return;
                }

                const tokenData = await tokenRes.json();
                const tokens = {
                  access_token: tokenData.access_token,
                  refresh_token: tokenData.refresh_token,
                  expires_at: Date.now() + tokenData.expires_in * 1000,
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

                res.end(JSON.stringify({ success: true, events: synced }));
              } catch (err) {
                console.error('Error in google-sync endpoint:', err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: `Sync failed: ${err.message}` }));
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
                const result = await safeWriteJsonFile({ filePath: focusPath, backupDir, baseName: 'focus-sessions', body, kind: 'array', force });
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

            const condaExe = 'C:\\ProgramData\\anaconda3\\Scripts\\conda.exe';
            const condaPythonw = 'C:\\ProgramData\\anaconda3\\pythonw.exe';
            let spawnCmd = 'pythonw';
            let spawnArgs = [pythonScript];

            try {
              await fs.access(condaExe);
              spawnCmd = condaExe;
              spawnArgs = ['run', '-n', 'base', 'pythonw', pythonScript];
            } catch (_) {
              try {
                await fs.access(condaPythonw);
                spawnCmd = condaPythonw;
              } catch (__) {
                // fallback to path env
              }
            }

            try {
              const child = spawn(spawnCmd, spawnArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
              });
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
