// Unit tests for the server-side notification engine (notification-engine.ts).
// Tests multi-user isolation, schedule calculation, sleep/wake catchup, quiet hours,
// snooze expirations, critical escalations, actions, completion persistence, and push management.
// Run with: npx tsx src/lib/notificationEngine.test.ts

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  canCompleteFromToast,
  createNotificationEngine,
  isDesktopSubscription,
  type UserPathsLike,
} from '../../notification-engine';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationStore } from './notifications';

console.log('--- 1. NOTIFICATION ENGINE LIFECYCLE & ISOLATION ---');

const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'planner-notif-engine-test-'));

const mockUserPaths = (username: string): UserPathsLike => {
  const userDir = path.join(tmpDir, 'database', 'users', username);
  return {
    safeName: username,
    dbDir: userDir,
    dbPath: path.join(userDir, 'database.json'),
    tasksPath: path.join(userDir, 'tasks.json'),
    settingsPath: path.join(userDir, 'settings.json'),
    donePath: path.join(userDir, 'prayer-done.json'),
    notificationsPath: path.join(userDir, 'notifications.json'),
    pushSubsPath: path.join(userDir, 'push-subscriptions.json'),
  };
};

const users = ['alice'];
const ensureUser = async (username: string) => {
  const p = mockUserPaths(username);
  await fsp.mkdir(p.dbDir, { recursive: true });
  return p;
};

// Seed alice's environment
const alicePaths = await ensureUser('alice');
const now = Date.now();
const todayYmd = new Date(now).toISOString().slice(0, 10);

const testEvent = {
  id: 'ev-1',
  content: 'Dentist Appointment',
  weekKey: todayYmd,
  dayIndex: 0,
  startTime: '10:00',
  endTime: '11:00',
  notify: { enabled: true, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' },
};

const testCriticalTask = {
  id: 'task-crit',
  title: 'Server Maintenance',
  weekKey: todayYmd,
  dayIndex: 0,
  startTime: '14:00',
  endTime: '15:00',
  notify: { enabled: true, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'critical' },
};

await fsp.writeFile(alicePaths.dbPath, JSON.stringify({ 'ev-1': testEvent }));
await fsp.writeFile(alicePaths.tasksPath, JSON.stringify({ 'task-crit': testCriticalTask }));
await fsp.writeFile(alicePaths.settingsPath, JSON.stringify({
  notifications: {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    windowsToast: false, // Disable real windows toast in unit tests
    webPush: false,
  },
}));
await fsp.writeFile(alicePaths.donePath, '{}');
await fsp.writeFile(alicePaths.notificationsPath, JSON.stringify({ items: {}, updatedAt: 0 }));
await fsp.writeFile(alicePaths.pushSubsPath, '[]');

const engine = createNotificationEngine({
  rootDir: tmpDir,
  listUsers: async () => users,
  ensureUser,
  tickMs: 60_000,
  log: () => {},
});

// Test VAPID public key & agent token generation
const vapidKey = await engine.getVapidPublicKey();
assert.ok(typeof vapidKey === 'string' && vapidKey.length > 30);

const agentToken = await engine.getAgentToken();
assert.ok(typeof agentToken === 'string' && agentToken.length >= 24);

console.log('--- 2. SEND TEST NOTIFICATION ---');
const testRec = await engine.sendTest('alice', 'normal');
assert.ok(testRec.key.startsWith('test:'));
assert.equal(testRec.priority, 'normal');

const storeAfterTest = await engine.getStore('alice');
assert.ok(storeAfterTest.items[testRec.key]);
assert.equal(storeAfterTest.items[testRec.key].title, 'Test notification');

console.log('--- 3. APPLY ACTIONS: READ, UNREAD, SNOOZE, ACK, DONE ---');
// 1. Read action
const readRes = await engine.applyAction('alice', {
  action: 'read',
  keys: [testRec.key],
  deviceId: 'device-1',
});
assert.equal(readRes.store.items[testRec.key].read, true);
assert.equal(readRes.store.items[testRec.key].readBy, 'device-1');

// 2. Unread action
const unreadRes = await engine.applyAction('alice', {
  action: 'unread',
  keys: [testRec.key],
});
assert.equal(unreadRes.store.items[testRec.key].read, false);

// 3. Snooze action
const snoozeRes = await engine.applyAction('alice', {
  action: 'snooze',
  keys: [testRec.key],
  minutes: 15,
});
assert.equal(snoozeRes.store.items[testRec.key].read, false);
assert.ok(snoozeRes.store.items[testRec.key].snoozedUntil! > Date.now());

// 4. Ack action
const ackRes = await engine.applyAction('alice', {
  action: 'ack',
  keys: [testRec.key],
  deviceId: 'device-1',
});
assert.equal(ackRes.store.items[testRec.key].read, true);
assert.ok(ackRes.store.items[testRec.key].acknowledgedAt !== undefined);

// 5. Done action with Task completion persistence
const taskNotifKey = `task:task-crit:${todayYmd}:0`;
const seedTaskNotif = {
  key: taskNotifKey,
  kind: 'task',
  refId: 'task-crit',
  occDate: todayYmd,
  fireAt: now,
  anchorAt: now,
  offsetMin: 0,
  title: 'Server Maintenance',
  body: 'Due now',
  priority: 'critical',
  firedAt: now,
  lastAlertAt: now,
  alerts: 1,
};

const curStore = await engine.getStore('alice');
curStore.items[taskNotifKey] = seedTaskNotif as any;
await fsp.writeFile(alicePaths.notificationsPath, JSON.stringify(curStore));

const doneRes = await engine.applyAction('alice', {
  action: 'done',
  keys: [taskNotifKey],
});
assert.equal(doneRes.store.items[taskNotifKey].completed, true);
assert.equal(doneRes.completed.length, 1);
assert.equal(doneRes.completed[0].refId, 'task-crit');

// Verify task completion was written to database file
const updatedTasks = JSON.parse(await fsp.readFile(alicePaths.tasksPath, 'utf-8'));
assert.equal(updatedTasks['task-crit'].completed, true);

// 6. Clear action
const clearRes = await engine.applyAction('alice', {
  action: 'clear',
  keys: [testRec.key, taskNotifKey],
});
assert.equal(clearRes.store.items[testRec.key], undefined);
assert.equal(clearRes.store.items[taskNotifKey], undefined);

console.log('--- N. A TOAST NEVER OFFERS A BUTTON THAT DOES NOTHING ---');

// The toast builder passed `-CanComplete` for 'task-digest' alongside 'task'
// and 'event', so Windows drew a Done button on the evening digest. But
// `applyCompletions` handles only 'task' and 'event', deliberately: ticking off
// several tasks from one button press is not undoable, and the comment above it
// says so. The reasoning was right and the button was drawn anyway, so pressing
// it marked the reminder read and silently changed no task.
assert.equal(canCompleteFromToast('task'), true, 'a task can be ticked from a toast');
assert.equal(canCompleteFromToast('event'), true, 'so can an event');
assert.equal(canCompleteFromToast('task-digest'), false,
  'a digest cannot, because nothing would happen if it were pressed');
assert.equal(canCompleteFromToast('prayer'), false, 'nor a prayer');
assert.equal(canCompleteFromToast(''), false, 'nor anything unrecognised');
assert.equal(canCompleteFromToast('TASK'), false, 'and the kinds are exact, not case-folded');

// And the behaviour that predicate is protecting: a `done` on a digest still
// marks the notification dealt with -- the user did ask for it to go away --
// but must not silently claim to have completed anything.
const digestKey = `task-digest:${todayYmd}`;
const digestStore = await engine.getStore('alice');
digestStore.items[digestKey] = {
  key: digestKey,
  kind: 'task-digest',
  refId: '',
  occDate: todayYmd,
  fireAt: now,
  anchorAt: now,
  offsetMin: 0,
  title: 'Still open today',
  body: 'Server Maintenance',
  priority: 'normal',
  firedAt: now,
  lastAlertAt: now,
  alerts: 1,
} as any;
await fsp.writeFile(alicePaths.notificationsPath, JSON.stringify(digestStore));

const tasksBefore = await fsp.readFile(alicePaths.tasksPath, 'utf-8');
const digestDone = await engine.applyAction('alice', { action: 'done', keys: [digestKey] });
assert.equal(digestDone.store.items[digestKey].completed, true,
  'the notification itself is marked dealt with');
// The entry is reported back -- the caller wants to know what was acted on --
// but its KIND is the digest, and `applyCompletions` writes for 'task' and
// 'event' only. That is the whole distinction, so it is stated rather than
// inferred from a count.
assert.ok(digestDone.completed.every(c => c.kind === 'task-digest'),
  'the only thing reported is the digest itself, not any task inside it');
assert.equal(digestDone.completed.filter(c => c.kind === 'task' || c.kind === 'event').length, 0,
  'and nothing that would actually be written');
assert.equal(await fsp.readFile(alicePaths.tasksPath, 'utf-8'), tasksBefore,
  'and the task file is untouched, byte for byte');

console.log('--- 4. RECORD LOCALLY FIRED NOTIFICATIONS ---');
// Offline phone fired a reminder -> records into store
const offlineKey = `event:ev-1:${todayYmd}:0`;
await engine.recordLocallyFired('alice', [offlineKey], 'phone-pixel');
const storeAfterLocal = await engine.getStore('alice');
assert.ok(storeAfterLocal.items[offlineKey]);
assert.equal(storeAfterLocal.items[offlineKey].readBy, 'phone-pixel');

console.log('--- 5. PUSH SUBSCRIPTION MANAGEMENT ---');
const subRecord = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/sub-123',
  keys: { p256dh: 'p256-test-key', auth: 'auth-test-key' },
  label: 'Chrome on Windows',
  deviceId: 'pc-1',
};

const subs = await engine.savePushSubscription('alice', subRecord);
assert.equal(subs.length, 1);
assert.equal(subs[0].endpoint, subRecord.endpoint);
assert.ok(subs[0].id);

// Remove subscription
const subsAfterRemove = await engine.removePushSubscription('alice', subRecord.endpoint);
assert.equal(subsAfterRemove.length, 0);

console.log('--- 6. HEALTH REPORTING ---');
const health = await engine.health('alice');
assert.ok(health.windowsToast !== undefined);
assert.ok(Array.isArray(health.push));

// Clean up
await fsp.rm(tmpDir, { recursive: true, force: true });

console.log('\nALL PASS (notificationEngine)');
process.exit(0);
