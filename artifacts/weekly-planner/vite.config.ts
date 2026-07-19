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

          // Maps Google event to PlannerEvent
          function mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt) {
            const isAllDay = !!gEv.start.date;

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
                scope: 'week',
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
                scope: 'week',
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

          function constructGoogleEventBody(ev, format, startOfWeek, addDays, weekStartsOnOpt) {
            const isRecurring = ev.scope === 'all';
            let eventDate;

            if (isRecurring) {
              const now = new Date();
              const startOfCurrentWeek = startOfWeek(now, { weekStartsOn: weekStartsOnOpt });
              eventDate = addDays(startOfCurrentWeek, ev.dayIndex);
            } else {
              const weekStartDate = new Date(ev.weekKey + 'T00:00:00');
              eventDate = addDays(weekStartDate, ev.dayIndex);
            }

            const dateStr = format(eventDate, 'yyyy-MM-dd');

            if (ev.allDay) {
              const span = ev.daysSpan || 1;
              const endDate = addDays(eventDate, span);
              const endDateStr = format(endDate, 'yyyy-MM-dd');
              const body: any = {
                summary: ev.content || 'Untitled',
                start: { date: dateStr },
                end: { date: endDateStr }
              };
              if (isRecurring) {
                const actualDayOfWeek = (weekStartsOnOpt + ev.dayIndex) % 7;
                const byDayStr = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][actualDayOfWeek];
                body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${byDayStr}`];
              }
              return body;
            } else {
              const [sh, sm] = ev.startTime.split(':').map(Number);
              const [eh, em] = ev.endTime.split(':').map(Number);
              const startDate = new Date(eventDate);
              startDate.setHours(sh, sm, 0, 0);
              const endDate = new Date(eventDate);
              endDate.setHours(eh, em, 0, 0);

              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
              const body: any = {
                summary: ev.content || 'Untitled',
                start: { dateTime: startDate.toISOString(), timeZone: tz },
                end: { dateTime: endDate.toISOString(), timeZone: tz }
              };
              if (isRecurring) {
                const actualDayOfWeek = (weekStartsOnOpt + ev.dayIndex) % 7;
                const byDayStr = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][actualDayOfWeek];
                body.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${byDayStr}`];
              }
              return body;
            }
          }

          // The concrete calendar date of a single-week event (for sync-window filtering).
          // Recurring ('all') events return null — they are always "in window".
          function eventOccurrenceDate(ev, addDays) {
            if (ev.scope === 'all' || !ev.weekKey) return null;
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
              // Load the app's own recurrence resolver so the series→Google mapping stays
              // in one place (no duplicated logic drifting out of sync).
              const { computeDailySeriesSpecs } = await server.ssrLoadModule('/src/lib/recurrence.ts');

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
              async function fetchCalendarEvents(calId, singleEvents) {
                const out = [];
                let pageToken = '';
                do {
                  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
                    + `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
                    + `&singleEvents=${singleEvents ? 'true' : 'false'}&showDeleted=false&maxResults=2500`
                    + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
                  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
                  if (!res.ok) break;
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

              // A. Local deletions of CONCRETE single-week events.
              //    Recurrence bookkeeping records — skip-this-week masks (overridesSeriesId)
              //    and series-end / forward-delete tombstones (scope 'all') — are NOT user
              //    deletions of a Google event: they must stay in storage so resolveWeek
              //    keeps honouring them, and must never touch Google. We deliberately do
              //    not propagate whole-series deletes to Google (that would risk wiping past
              //    occurrences); recurring series stay on Google once created.
              for (const [id, ev] of Object.entries(localMap)) {
                if (!ev.deleted) continue;
                if (ev.overridesSeriesId || ev.scope === 'all') continue;
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
                  // Never synced, or a read-only foreign event the user removed locally
                  // (it will simply re-appear on the next pull — other calendars are read-only).
                  delete localMap[id];
                }
              }

              // B. Push app-owned creates/updates to the Daily calendar ONLY. An event
              //    carrying a foreign gCalId belongs to a read-only calendar and is never
              //    written back.
              for (const [id, ev] of Object.entries(localMap)) {
                if (ev.deleted) continue;
                // Recurring series are pushed as native RRULE events in B2 below, not here.
                if (ev.scope === 'all') continue;
                const isForeign = ev.gCalId && ev.gCalCalendarId && ev.gCalCalendarId !== targetCalendarId;
                if (isForeign) continue;

                if (!ev.gCalId) {
                  try {
                    const body = constructGoogleEventBody(ev, format, startOfWeek, addDays, weekStartsOnOpt);
                    const insRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    });
                    if (insRes.ok) {
                      const created = await insRes.json();
                      localMap[id] = { ...ev, gCalId: created.id, gCalCalendarId: targetCalendarId, gCalETag: created.etag, lastSyncedAt: nowMs };
                      seenGCalIds.add(created.id);
                    } else {
                      console.error(`Google API insert failed for event ${id}: Status ${insRes.status} - ${await insRes.text()}`);
                    }
                  } catch (err) {
                    console.error(`Failed to create local event ${id} on Google:`, err);
                  }
                }
                else if (ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt)) {
                  try {
                    const body = constructGoogleEventBody(ev, format, startOfWeek, addDays, weekStartsOnOpt);
                    const updRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                      method: 'PUT',
                      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    });
                    if (updRes.ok) {
                      const updated = await updRes.json();
                      localMap[id] = { ...ev, gCalETag: updated.etag, lastSyncedAt: nowMs };
                      seenGCalIds.add(ev.gCalId);
                    } else if (updRes.status === 404 || updRes.status === 410) {
                      // Deleted on Google meanwhile → mirror the deletion locally.
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

              // B2. Push recurring series to the Daily calendar as native RRULE events.
              //     Each active version owns one Google event, bounded by the next version
              //     (UNTIL) and punched with EXDATE for skip-this-week masks and this-week
              //     forks. This makes version splits, forward-deletes and per-week skips map
              //     faithfully onto Google instead of leaving duplicate/open-ended series.
              const two = (n) => String(n).padStart(2, '0');
              const basicDate = (d) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
              const basicLocalDT = (d, hh, mm) => `${basicDate(d)}T${two(hh)}${two(mm)}00`;
              const basicUTC = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

              // Occurrence date for a weekKey; absurdly-old anchors (migrated "since forever"
              // events) are clamped forward to the first occurrence inside the sync window so
              // we never send a DTSTART in year 0.
              const occurrenceOf = (weekKey, dayIndex) => {
                if (!weekKey || new Date(weekKey + 'T00:00:00').getFullYear() < 1990) {
                  const base = startOfWeek(new Date(timeMinMs), { weekStartsOn: weekStartsOnOpt });
                  let occ = addDays(base, dayIndex || 0);
                  while (occ.getTime() < timeMinMs) occ = addDays(occ, 7);
                  return occ;
                }
                return addDays(new Date(weekKey + 'T00:00:00'), dayIndex || 0);
              };

              const buildSeriesBody = (ev, spec) => {
                const dayIndex = ev.dayIndex || 0;
                const startOcc = occurrenceOf(spec.dtStartWeekKey, dayIndex);
                const byDay = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][startOcc.getDay()];
                const allDay = !!ev.allDay;
                const [sh, sm] = allDay ? [0, 0] : (ev.startTime || '00:00').split(':').map(Number);

                // Last included occurrence = one week before the next version's occurrence.
                let lastOcc = null;
                if (spec.untilWeekKey) {
                  lastOcc = addDays(occurrenceOf(spec.untilWeekKey, dayIndex), -7);
                  if (lastOcc.getTime() < startOcc.getTime()) return null; // no occurrences in range
                }

                let rrule = `RRULE:FREQ=WEEKLY;BYDAY=${byDay}`;
                if (lastOcc) {
                  if (allDay) {
                    rrule += `;UNTIL=${basicDate(lastOcc)}`;
                  } else {
                    const u = new Date(lastOcc); u.setHours(sh, sm, 0, 0);
                    rrule += `;UNTIL=${basicUTC(u)}`;
                  }
                }
                const recurrence = [rrule];

                // EXDATE for every excluded (skipped/forked) week within range.
                const exOccs = spec.exWeekKeys
                  .map((w) => occurrenceOf(w, dayIndex))
                  .filter((d) => d.getTime() >= startOcc.getTime() && (!lastOcc || d.getTime() <= lastOcc.getTime()));
                if (exOccs.length) {
                  if (allDay) {
                    recurrence.push(`EXDATE;VALUE=DATE:${exOccs.map(basicDate).join(',')}`);
                  } else {
                    recurrence.push(`EXDATE;TZID=${tz}:${exOccs.map((d) => basicLocalDT(d, sh, sm)).join(',')}`);
                  }
                }

                let start, end;
                if (allDay) {
                  start = { date: format(startOcc, 'yyyy-MM-dd') };
                  end = { date: format(addDays(startOcc, ev.daysSpan || 1), 'yyyy-MM-dd') };
                } else {
                  const [eh, em] = (ev.endTime || ev.startTime || '00:30').split(':').map(Number);
                  const s = new Date(startOcc); s.setHours(sh, sm, 0, 0);
                  const e = new Date(startOcc); e.setHours(eh, em, 0, 0);
                  start = { dateTime: s.toISOString(), timeZone: tz };
                  end = { dateTime: e.toISOString(), timeZone: tz };
                }
                return { summary: ev.content || 'Untitled', start, end, recurrence };
              };

              const specs = computeDailySeriesSpecs(localMap);
              const activeRecordIds = new Set(specs.map((s) => s.recordId));

              // Delete Google events for 'all' records that are no longer active (deleted
              // tombstones / full-series deletes) but still carry a gCalId, then keep the
              // record as an app-side boundary marker without its stale Google identity.
              for (const [id, ev] of Object.entries(localMap)) {
                if (ev.scope !== 'all' || !ev.gCalId || activeRecordIds.has(id)) continue;
                if (ev.gCalCalendarId && ev.gCalCalendarId !== targetCalendarId) continue;
                try {
                  const delRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${accessToken}` }
                  });
                  if (delRes.ok || delRes.status === 404 || delRes.status === 410) {
                    seenGCalIds.delete(ev.gCalId);
                    localMap[id] = { ...ev, gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined };
                  }
                } catch (err) {
                  console.error(`Failed to delete stale series event ${ev.gCalId}:`, err);
                }
              }

              for (const spec of specs) {
                const ev = localMap[spec.recordId];
                if (!ev) continue;
                const body = buildSeriesBody(ev, spec);
                if (!body) continue;
                const sig = JSON.stringify(body);
                try {
                  if (!ev.gCalId) {
                    const insRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`, {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    });
                    if (insRes.ok) {
                      const created = await insRes.json();
                      localMap[spec.recordId] = { ...ev, gCalId: created.id, gCalCalendarId: targetCalendarId, gCalETag: created.etag, gCalRecurSig: sig, lastSyncedAt: nowMs };
                      seenGCalIds.add(created.id);
                    } else {
                      console.error(`Series insert failed for ${spec.recordId}: ${insRes.status} - ${await insRes.text()}`);
                    }
                  } else if (ev.gCalRecurSig !== sig) {
                    const updRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(ev.gCalId)}`, {
                      method: 'PUT',
                      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify(body)
                    });
                    if (updRes.ok) {
                      const updated = await updRes.json();
                      localMap[spec.recordId] = { ...ev, gCalETag: updated.etag, gCalRecurSig: sig, lastSyncedAt: nowMs };
                      seenGCalIds.add(ev.gCalId);
                    } else if (updRes.status === 404 || updRes.status === 410) {
                      seenGCalIds.delete(ev.gCalId);
                      localMap[spec.recordId] = { ...ev, gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined };
                    } else {
                      console.error(`Series update failed for ${ev.gCalId}: ${updRes.status} - ${await updRes.text()}`);
                    }
                  } else {
                    seenGCalIds.add(ev.gCalId);
                  }
                } catch (err) {
                  console.error(`Failed to push series ${spec.recordId} to Google:`, err);
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
                  // Created directly in Google's Daily calendar → import as an app-owned event.
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt);
                  if (plannerEv) {
                    plannerEv.lastSyncedAt = nowMs;
                    localMap[plannerEv.id] = plannerEv;
                    localByGCalId.set(gEv.gCalId, plannerEv.id);
                  }
                  continue;
                }
                const ev = localMap[localId];
                if (!ev || ev.deleted) continue; // never resurrect a locally-deleted record
                // A local edit we just pushed wins this round; only pull when Google is ahead.
                const locallyDirty = ev.updatedAt && (!ev.lastSyncedAt || ev.updatedAt > ev.lastSyncedAt);
                if (!locallyDirty && ev.gCalETag !== gEv.gCalETag) {
                  const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt);
                  if (g) {
                    if (ev.scope === 'all') {
                      // Preserve recurrence identity; refresh only the display fields.
                      localMap[localId] = { ...ev, content: g.content, startTime: g.startTime, endTime: g.endTime, allDay: g.allDay, daysSpan: g.daysSpan, gCalETag: gEv.gCalETag, lastSyncedAt: nowMs };
                    } else {
                      localMap[localId] = { ...ev, ...g, id: localId, scope: 'week', completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                    }
                  }
                }
              }

              // D. Pull read-only events from every other calendar.
              for (const gEv of otherGoogleEvents) {
                const localId = localByGCalId.get(gEv.gCalId);
                if (!localId) {
                  const plannerEv = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt);
                  if (plannerEv) {
                    plannerEv.lastSyncedAt = nowMs;
                    localMap[plannerEv.id] = plannerEv;
                    localByGCalId.set(gEv.gCalId, plannerEv.id);
                  }
                } else {
                  const ev = localMap[localId];
                  if (ev && !ev.deleted && ev.gCalETag !== gEv.gCalETag) {
                    const g = mapGoogleToPlannerEvent(gEv, format, startOfWeek, differenceInDays, weekStartsOnOpt);
                    if (g) {
                      localMap[localId] = { ...ev, ...g, id: localId, completedDates: ev.completedDates, noCheckbox: ev.noCheckbox, lastSyncedAt: nowMs };
                    }
                  }
                }
              }

              // E. Mirror Google-side deletions: any previously-synced local event whose
              //    gCalId is no longer present on Google is removed locally. Single-week
              //    events are only reconciled when their date is inside the fetch window,
              //    so events outside the window aren't wrongly dropped.
              for (const [id, ev] of Object.entries(localMap)) {
                if (!ev.gCalId || ev.deleted) continue;
                if (seenGCalIds.has(ev.gCalId)) continue;
                if (ev.scope !== 'all') {
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
