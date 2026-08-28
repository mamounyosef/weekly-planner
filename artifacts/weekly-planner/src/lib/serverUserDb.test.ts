// Tests multi-user isolation, credential validation, session tokens, and local address resolution.
// Run with: npx tsx src/lib/serverUserDb.test.ts

import assert from 'node:assert/strict';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getAuthUser,
  getUserDbPaths,
  isLocalAddress,
  sanitizeUsername,
  verifySessionToken,
  type AppUser,
} from '../../server-user-db';

console.log('--- 1. SANITIZE USERNAME ---');
assert.equal(sanitizeUsername('  Mamoun.Yosef-2026! '), 'mamoun.yosef-2026_');
assert.equal(sanitizeUsername('User@Domain#Name'), 'user_domain_name');
assert.equal(sanitizeUsername('admin_123'), 'admin_123');
assert.equal(sanitizeUsername(''), '');
assert.equal(sanitizeUsername(null as any), '');
assert.equal(sanitizeUsername(undefined as any), '');

console.log('--- 2. USER DB PATHS ISOLATION ---');
const pathsUserA = getUserDbPaths('C:/app', 'alice');
const pathsUserB = getUserDbPaths('C:/app', 'bob');

assert.equal(pathsUserA.safeName, 'alice');
assert.equal(pathsUserB.safeName, 'bob');
assert.ok(pathsUserA.dbPath.includes('alice'));
assert.ok(pathsUserB.dbPath.includes('bob'));
assert.notEqual(pathsUserA.dbDir, pathsUserB.dbDir);
assert.ok(pathsUserA.tasksPath.endsWith('tasks.json'));
assert.ok(pathsUserA.settingsPath.endsWith('settings.json'));
assert.ok(pathsUserA.notificationsPath.endsWith('notifications.json'));
assert.ok(pathsUserA.backupDir.endsWith('backups'));

console.log('--- 3. SESSION TOKEN CREATION & VERIFICATION ---');
const users: AppUser[] = [
  { username: 'alice', password: 'password123', name: 'Alice Smith' },
  { username: 'bob', password: 'secret456', name: 'Bob Jones' },
];

const tokenA = createSessionToken('alice', 'password123');
assert.ok(typeof tokenA === 'string');
assert.equal(tokenA.split(':').length, 3, 'Token format is username:expiry:signature');
assert.equal(tokenA.split(':')[0], 'alice');

// Successful verification
const verifiedA = verifySessionToken(tokenA, users);
assert.ok(verifiedA !== null);
assert.equal(verifiedA?.username, 'alice');
assert.equal(verifiedA?.name, 'Alice Smith');

// Wrong user list (user not found)
assert.equal(verifySessionToken(tokenA, []), null);

// Wrong password (password changed)
const changedPasswordUsers: AppUser[] = [
  { username: 'alice', password: 'new_password_789' },
];
assert.equal(verifySessionToken(tokenA, changedPasswordUsers), null, 'Password change invalidates existing token');

// Tampered token signature
const parts = tokenA.split(':');
const tamperedToken = `${parts[0]}:${parts[1]}:bad_signature`;
assert.equal(verifySessionToken(tamperedToken, users), null, 'Tampered token signature must fail verification');

// Tampered expiry date
const tamperedExpiry = `${parts[0]}:${Number(parts[1]) + 10000}:${parts[2]}`;
assert.equal(verifySessionToken(tamperedExpiry, users), null, 'Tampered expiry must fail verification');

// Expired token
const expiredToken = `${parts[0]}:${Date.now() - 5000}:${parts[2]}`;
assert.equal(verifySessionToken(expiredToken, users), null, 'Expired token must fail verification');

// Legacy 2-part token verification (backwards compatibility)
const crypto = await import('crypto');
const legacySig = crypto.createHmac('sha256', 'weekly-planner-multi-user-secure-secret-2026')
  .update('alice:password123')
  .digest('hex');
const legacyToken = `alice:${legacySig}`;
const verifiedLegacy = verifySessionToken(legacyToken, users);
assert.ok(verifiedLegacy !== null);
assert.equal(verifiedLegacy?.username, 'alice');

// Malformed tokens
assert.equal(verifySessionToken('', users), null);
assert.equal(verifySessionToken('singlepart', users), null);
assert.equal(verifySessionToken('a:b:c:d:e', users), null);
assert.equal(verifySessionToken(null as any, users), null);

console.log('--- 4. IS LOCAL ADDRESS (IP RESOLUTION) ---');
assert.equal(isLocalAddress('127.0.0.1'), true);
assert.equal(isLocalAddress('::1'), true);
assert.equal(isLocalAddress('::ffff:127.0.0.1'), true);
assert.equal(isLocalAddress('10.0.0.1'), true);
assert.equal(isLocalAddress('10.255.255.255'), true);
assert.equal(isLocalAddress('192.168.1.1'), true);
assert.equal(isLocalAddress('192.168.0.254'), true);
assert.equal(isLocalAddress('172.16.0.1'), true);
assert.equal(isLocalAddress('172.31.255.255'), true);

// Public addresses (must NOT be treated as local)
assert.equal(isLocalAddress('172.32.0.1'), false);
assert.equal(isLocalAddress('8.8.8.8'), false);
assert.equal(isLocalAddress('1.1.1.1'), false);
assert.equal(isLocalAddress('203.0.113.1'), false);
assert.equal(isLocalAddress(''), false);

console.log('--- 5. GET AUTH USER FROM REQUEST ---');
// 1. Session Cookie
const reqCookie = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(tokenA)}` } };
assert.equal(getAuthUser(reqCookie, users)?.username, 'alice');

// 2. Basic Auth
const credentials = Buffer.from('bob:secret456').toString('base64');
const reqBasic = { headers: { authorization: `Basic ${credentials}` } };
assert.equal(getAuthUser(reqBasic, users)?.username, 'bob');

// Bad Basic Auth
const badBasic = { headers: { authorization: `Basic ${Buffer.from('bob:wrongpass').toString('base64')}` } };
assert.equal(getAuthUser(badBasic, users), null);

// 3. Bearer Token
const reqBearer = { headers: { authorization: `Bearer ${tokenA}` } };
assert.equal(getAuthUser(reqBearer, users)?.username, 'alice');

// 4. Local loopback hotkey helper bypass
const reqLocalHotkey = {
  originalUrl: '/api/focus-timer/toggle',
  socket: { remoteAddress: '127.0.0.1' },
  headers: {},
};
assert.equal(getAuthUser(reqLocalHotkey, users)?.username, 'alice', 'Local loopback hotkey helper resolves first user');

// Remote request to hotkey endpoint without auth fails
const reqRemoteHotkey = {
  originalUrl: '/api/focus-timer/toggle',
  socket: { remoteAddress: '203.0.113.5' },
  headers: {},
};
assert.equal(getAuthUser(reqRemoteHotkey, users), null);

// Proxied request with x-forwarded-for does NOT get loopback bypass
const reqProxied = {
  originalUrl: '/api/focus-timer/toggle',
  socket: { remoteAddress: '127.0.0.1' },
  headers: { 'x-forwarded-for': '203.0.113.5' },
};
assert.equal(getAuthUser(reqProxied, users), null, 'Proxied requests are not treated as local loopback');

console.log('\nALL PASS (server-user-db)');
