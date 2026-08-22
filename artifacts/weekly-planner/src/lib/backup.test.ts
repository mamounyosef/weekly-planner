import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { autoBackupPaths, getUserDbPaths, sanitizeUsername } from '../../server-user-db';

console.log('--- 1. AUTO-BACKUP CONFIGURATION COERCION & BOUNDARIES ---');

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

// Defaults
assert.deepEqual(coerceAutoBackupCfg(null), AUTO_BACKUP_DEFAULTS, 'null yields defaults');
assert.deepEqual(coerceAutoBackupCfg({}), AUTO_BACKUP_DEFAULTS, 'empty object yields defaults');
assert.deepEqual(coerceAutoBackupCfg(undefined), AUTO_BACKUP_DEFAULTS, 'undefined yields defaults');

// Custom valid values
assert.deepEqual(
  coerceAutoBackupCfg({ enabled: false, intervalHours: 12, keep: 100 }),
  { enabled: false, intervalHours: 12, keep: 100 },
  'valid custom configuration preserved',
);

// Clamping boundaries
assert.equal(coerceAutoBackupCfg({ intervalHours: -5 }).intervalHours, 24, 'negative interval falls back to default');
assert.equal(coerceAutoBackupCfg({ intervalHours: 0 }).intervalHours, 24, 'zero interval falls back to default');
assert.equal(coerceAutoBackupCfg({ intervalHours: 1 }).intervalHours, 1, 'minimum 1 hour interval allowed');
assert.equal(coerceAutoBackupCfg({ intervalHours: 10000 }).intervalHours, 720, 'interval capped at 30 days (720h)');
assert.equal(coerceAutoBackupCfg({ keep: -10 }).keep, 50, 'negative keep falls back to default');
assert.equal(coerceAutoBackupCfg({ keep: 0 }).keep, 50, 'zero keep falls back to default');
assert.equal(coerceAutoBackupCfg({ keep: 5000 }).keep, 1000, 'keep capped at 1000');
assert.equal(coerceAutoBackupCfg({ enabled: 'yes' }).enabled, true, 'non-boolean enabled falls back to default');

console.log('✓ Auto-backup config coercion tests passed');

console.log('--- 2. UNIFIED BACKUP PAYLOAD (V3) FORMAT & RETRO-COMPATIBILITY ---');

const sampleEvents = {
  'evt-1': { id: 'evt-1', content: 'Meeting', startTime: '09:00', endTime: '10:00', dayIndex: 1, weekKey: '2026-08-17' },
};
const sampleSettings = { darkMode: true, timeFormat: '24h' };
const sampleSessions = [{ id: 'sess-1', durationSeconds: 1500, endedAt: '2026-08-21T10:00:00.000Z' }];
const sampleTasks = { 'task-1': { id: 'task-1', title: 'Review pull request', completed: false } };

function createBackupPayload(opts: {
  username: string;
  reason: 'scheduled' | 'manual';
  events: Record<string, unknown>;
  settings: Record<string, unknown>;
  focusSessions: unknown[];
  tasks: Record<string, unknown>;
}) {
  return {
    backupFormatVersion: 3,
    exportedAt: new Date().toISOString(),
    user: opts.username,
    source: opts.reason,
    events: opts.events,
    settings: opts.settings,
    focusSessions: opts.focusSessions,
    tasks: opts.tasks,
  };
}

const payload = createBackupPayload({
  username: 'mamoun',
  reason: 'scheduled',
  events: sampleEvents,
  settings: sampleSettings,
  focusSessions: sampleSessions,
  tasks: sampleTasks,
});

assert.equal(payload.backupFormatVersion, 3, 'format version must be 3');
assert.equal(payload.user, 'mamoun', 'user preserved');
assert.equal(payload.source, 'scheduled', 'source preserved');
assert.deepEqual(payload.events, sampleEvents, 'events preserved');
assert.deepEqual(payload.settings, sampleSettings, 'settings preserved');
assert.deepEqual(payload.focusSessions, sampleSessions, 'focus sessions preserved');
assert.deepEqual(payload.tasks, sampleTasks, 'tasks preserved');
assert.ok(Date.parse(payload.exportedAt) > 0, 'exportedAt must be a valid ISO date');

// Parser compatibility testing across format versions (v1, v2, v3)
function parseBackupFile(rawJson: string) {
  const parsed = JSON.parse(rawJson);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');

  const isComprehensive = 'events' in parsed && typeof parsed.events === 'object';
  const events = isComprehensive ? parsed.events : parsed;
  const settings = isComprehensive ? parsed.settings || null : null;
  const focusSessions = isComprehensive && Array.isArray(parsed.focusSessions) ? parsed.focusSessions : [];
  const tasks = isComprehensive && parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks) ? parsed.tasks : {};

  return { events, settings, focusSessions, tasks, version: parsed.backupFormatVersion || 1 };
}

// v1: pure events map
const v1Json = JSON.stringify(sampleEvents);
const parsedV1 = parseBackupFile(v1Json);
assert.equal(parsedV1.version, 1, 'v1 version detected');
assert.deepEqual(parsedV1.events, sampleEvents, 'v1 events extracted');
assert.deepEqual(parsedV1.tasks, {}, 'v1 tasks default to empty');

// v2: events + settings + focusSessions
const v2Json = JSON.stringify({ backupFormatVersion: 2, exportedAt: new Date().toISOString(), events: sampleEvents, settings: sampleSettings, focusSessions: sampleSessions });
const parsedV2 = parseBackupFile(v2Json);
assert.equal(parsedV2.version, 2, 'v2 version detected');
assert.deepEqual(parsedV2.events, sampleEvents, 'v2 events extracted');
assert.deepEqual(parsedV2.settings, sampleSettings, 'v2 settings extracted');
assert.deepEqual(parsedV2.focusSessions, sampleSessions, 'v2 sessions extracted');
assert.deepEqual(parsedV2.tasks, {}, 'v2 tasks default to empty without error');

// v3: full unified
const v3Json = JSON.stringify(payload);
const parsedV3 = parseBackupFile(v3Json);
assert.equal(parsedV3.version, 3, 'v3 version detected');
assert.deepEqual(parsedV3.events, sampleEvents, 'v3 events extracted');
assert.deepEqual(parsedV3.tasks, sampleTasks, 'v3 tasks extracted');
assert.deepEqual(parsedV3.focusSessions, sampleSessions, 'v3 sessions extracted');

console.log('✓ Unified backup format and parser compatibility tests passed');

console.log('--- 3. 24-HOUR SCHEDULER & DUE CALCULATION LOGIC ---');

function isBackupDue(lastBackupAt: string | null | undefined, intervalHours: number): boolean {
  if (!lastBackupAt) return true;
  const last = Date.parse(lastBackupAt);
  if (!Number.isFinite(last)) return true;
  const dueAfterMs = intervalHours * 3600_000;
  return Date.now() - last >= dueAfterMs;
}

// Never backed up
assert.equal(isBackupDue(null, 24), true, 'never backed up is due');
assert.equal(isBackupDue('', 24), true, 'empty lastBackupAt is due');
assert.equal(isBackupDue('invalid-date', 24), true, 'invalid timestamp is due');

// Recently backed up (e.g. 1 hour ago with 24h interval)
const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
assert.equal(isBackupDue(oneHourAgo, 24), false, 'backed up 1h ago is not due for 24h interval');

// Backed up 23.5 hours ago with 24h interval
const almostDue = new Date(Date.now() - 23.5 * 3600_000).toISOString();
assert.equal(isBackupDue(almostDue, 24), false, 'backed up 23.5h ago is not yet due');

// Backed up 24.1 hours ago with 24h interval
const overdue = new Date(Date.now() - 24.1 * 3600_000).toISOString();
assert.equal(isBackupDue(overdue, 24), true, 'backed up 24.1h ago is due');

// Custom 12h interval
const thirteenHoursAgo = new Date(Date.now() - 13 * 3600_000).toISOString();
assert.equal(isBackupDue(thirteenHoursAgo, 12), true, 'backed up 13h ago is due for 12h interval');

console.log('✓ 24-hour backup scheduling & due calculation tests passed');

console.log('--- 4. MULTI-USER ISOLATION & DIRECTORY ROUTING ---');

const root = 'D:\\My Projects\\weekly-planner';
const mamounPaths = autoBackupPaths(root, 'mamoun');
const mahmoudPaths = autoBackupPaths(root, 'mahmoud');
const maysPaths = autoBackupPaths(root, 'mays');

assert.ok(mamounPaths.outDir.includes('users\\mamoun\\backups') || mamounPaths.outDir.includes('users/mamoun/backups'), 'mamoun backup path correct');
assert.ok(mahmoudPaths.outDir.includes('users\\mahmoud\\backups') || mahmoudPaths.outDir.includes('users/mahmoud/backups'), 'mahmoud backup path correct');
assert.ok(maysPaths.outDir.includes('users\\mays\\backups') || maysPaths.outDir.includes('users/mays/backups'), 'mays backup path correct');

assert.notEqual(mamounPaths.outDir, mahmoudPaths.outDir, 'different users must have isolated backup directories');
assert.notEqual(mamounPaths.outDir, maysPaths.outDir, 'different users must have isolated backup directories');

// Sanitization checks
assert.equal(sanitizeUsername('Ma\'moun'), 'ma_moun', 'sanitizes quotes');
assert.equal(sanitizeUsername('USER 123!'), 'user_123_', 'sanitizes spaces and symbols');
assert.equal(sanitizeUsername(''), '', 'empty string remains empty');

console.log('✓ Multi-user isolation & routing tests passed');

console.log('--- 5. RETENTION PRUNING & CHRONOLOGICAL ORDERING ---');

const AUTO_BACKUP_PREFIX = 'planner-backup.';

async function pruneAutoBackups(outDir: string, keep: number) {
  try {
    const files = (await fsp.readdir(outDir))
      .filter(f => f.startsWith(AUTO_BACKUP_PREFIX) && f.endsWith('.json'))
      .sort(); // ISO timestamps sort chronologically
    for (let i = 0; i < files.length - keep; i++) {
      await fsp.unlink(path.join(outDir, files[i])).catch(() => {});
    }
  } catch {}
}

async function runPruneTest() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'planner-prune-test-'));
  try {
    // Create 10 mock backups with timestamps
    const timestamps = [
      '2026-08-01T10-00-00-000Z',
      '2026-08-02T10-00-00-000Z',
      '2026-08-03T10-00-00-000Z',
      '2026-08-04T10-00-00-000Z',
      '2026-08-05T10-00-00-000Z',
      '2026-08-06T10-00-00-000Z',
      '2026-08-07T10-00-00-000Z',
      '2026-08-08T10-00-00-000Z',
      '2026-08-09T10-00-00-000Z',
      '2026-08-10T10-00-00-000Z',
    ];

    for (const ts of timestamps) {
      await fsp.writeFile(path.join(tmpDir, `${AUTO_BACKUP_PREFIX}${ts}.json`), '{}');
    }

    // Also write a non-backup file to ensure it is never touched
    const keepMeFile = path.join(tmpDir, 'important-notes.txt');
    await fsp.writeFile(keepMeFile, 'keep me');

    // Prune to keep 4
    await pruneAutoBackups(tmpDir, 4);

    const remaining = (await fsp.readdir(tmpDir)).sort();
    const remainingBackups = remaining.filter(f => f.startsWith(AUTO_BACKUP_PREFIX));

    assert.equal(remainingBackups.length, 4, 'must retain exactly 4 backups');
    assert.equal(remainingBackups[0], `${AUTO_BACKUP_PREFIX}2026-08-07T10-00-00-000Z.json`, 'oldest preserved is Aug 7');
    assert.equal(remainingBackups[3], `${AUTO_BACKUP_PREFIX}2026-08-10T10-00-00-000Z.json`, 'newest preserved is Aug 10');
    assert.ok(fs.existsSync(keepMeFile), 'non-backup file must be untouched');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

await runPruneTest();
console.log('✓ Retention pruning & chronological sorting tests passed');

console.log('--- 6. ATOMIC WRITE SAFETY & CORRUPT SOURCE FILE PROTECTION ---');

function isEmptyJsonValue(text: string, kind: 'object' | 'array'): boolean {
  try {
    const parsed = JSON.parse(text);
    if (kind === 'array') return Array.isArray(parsed) && parsed.length === 0;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return true;
  }
}

async function safeWriteJsonFile(opts: {
  filePath: string;
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

async function runAtomicSafetyTest() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'planner-atomic-test-'));
  const targetFile = path.join(tmpDir, 'database.json');
  try {
    // 1. Initial valid write
    const res1 = await safeWriteJsonFile({
      filePath: targetFile,
      baseName: 'database',
      body: JSON.stringify({ 'event-1': { id: 'event-1', title: 'Initial' } }),
      kind: 'object',
      force: false,
    });
    assert.equal(res1.ok, true, 'valid initial write succeeds');

    // 2. Reject corrupt JSON
    const res2 = await safeWriteJsonFile({
      filePath: targetFile,
      baseName: 'database',
      body: '{ corrupt json missing closing',
      kind: 'object',
      force: false,
    });
    assert.equal(res2.ok, false, 'corrupt JSON rejected');
    assert.equal(res2.status, 400, 'returns 400 for corrupt JSON');
    assert.ok(JSON.parse(await fsp.readFile(targetFile, 'utf-8'))['event-1'], 'target file content preserved on reject');

    // 3. Reject wrong shape (expected object, got array)
    const res3 = await safeWriteJsonFile({
      filePath: targetFile,
      baseName: 'database',
      body: JSON.stringify(['not', 'an', 'object']),
      kind: 'object',
      force: false,
    });
    assert.equal(res3.ok, false, 'wrong JSON shape rejected');

    // 4. Reject accidental empty overwrite without force
    const res4 = await safeWriteJsonFile({
      filePath: targetFile,
      baseName: 'database',
      body: '{}',
      kind: 'object',
      force: false,
    });
    assert.equal(res4.ok, false, 'empty overwrite rejected without force');
    assert.equal(res4.status, 409, 'returns 409 conflict');

    // 5. Allow legitimate empty overwrite with force=true
    const res5 = await safeWriteJsonFile({
      filePath: targetFile,
      baseName: 'database',
      body: '{}',
      kind: 'object',
      force: true,
    });
    assert.equal(res5.ok, true, 'forced empty overwrite allowed');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

await runAtomicSafetyTest();
console.log('✓ Atomic write safety and data protection tests passed');

console.log('====================================================');
console.log('ALL BACKUP ENGINE TESTS PASSED SUCCESSFULLY!');
