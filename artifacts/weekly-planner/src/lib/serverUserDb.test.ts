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
  isLoopbackAddress,
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

// ─── The passwordless fallback is THIS MACHINE, not the network ─────────────
//
// Step 4 of `getAuthUser` resolves an unauthenticated request to the first
// account, so that the hotkey helper and the toast agent -- which run on this
// PC with no cookie -- can toggle the focus timer and read settings. It asked
// `isLocalAddress`, which answers for the whole private range: 10.x, 192.168.x
// and 172.16-31.x as well as loopback.
//
// So every phone, laptop and television on the same Wi-Fi was treated as a
// signed-in user on two routes. One of them, /api/settings, accepts POST, which
// is a full read and overwrite of that account categories, notification rules
// and Google sync policy, with no password. The comment beside it said
// "loopback" the whole time; the code did not.
{
  console.log('\n--- THE PASSWORDLESS FALLBACK IS LOOPBACK ONLY ---');

  const req = (ip: string, url = '/api/settings', headers: Record<string, string> = {}) => ({
    originalUrl: url,
    headers,
    socket: { remoteAddress: ip },
  });

  // ── The rest of the house does not ───────────────────────────────────────
  const LAN = [
    '10.0.0.1', '10.255.255.255', '192.168.1.1', '192.168.0.254',
    '172.16.0.1', '172.31.255.255', '172.20.10.5',
    '::ffff:192.168.1.50', '::ffff:10.0.0.9',
  ];
  for (const ip of LAN) {
    assert.equal(getAuthUser(req(ip), users), null, `${ip} is on the network, not this machine`);
    assert.equal(getAuthUser(req(ip, '/api/focus-timer/toggle'), users), null,
      `${ip} cannot toggle the timer either`);
  }

  // ── This machine still works, or the hotkey helper stops working ─────────
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    assert.equal(getAuthUser(req(ip), users)?.username, 'alice', `${ip} is this machine`);
    assert.equal(getAuthUser(req(ip, '/api/focus-timer/toggle'), users)?.username, 'alice',
      `${ip} may still toggle the timer`);
  }

  // And the wider internet, which was never allowed and still is not.
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '', 'not-an-ip']) {
    assert.equal(getAuthUser(req(ip), users), null, `${JSON.stringify(ip)} is refused`);
  }

  // ── The two helpers are still separate questions ─────────────────────────
  // `isLocalAddress` has other callers (the desk controller is genuinely a LAN
  // device), so it must keep answering the question it answers.
  assert.equal(isLocalAddress('192.168.1.1'), true, 'the LAN helper still means the LAN');
  assert.equal(isLoopbackAddress('192.168.1.1'), false, 'and the loopback helper does not');
  assert.equal(isLoopbackAddress('127.0.0.1'), true, 'loopback is loopback');
  assert.equal(isLoopbackAddress('::1'), true, 'in both address families');
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true, 'and through the v4-mapped form');
  assert.equal(isLoopbackAddress(''), false, 'nothing is not loopback');
  assert.equal(isLoopbackAddress('127.0.0.1.evil.com'), false,
    'and a hostname that merely starts with it is not either');

  // ── A tunnelled request is still refused, however it looks ───────────────
  // The public link arrives through a proxy on loopback, so without this the
  // narrowing above would have made things worse rather than better.
  assert.equal(
    getAuthUser(req('127.0.0.1', '/api/settings', { 'x-forwarded-for': '203.0.113.7' }), users),
    null,
    'a proxied request is refused even though it arrives from loopback');

  // ── And only these two routes, on this machine ───────────────────────────
  for (const url of ['/api/events', '/api/tasks', '/api/sync/pull', '/api/notifications', '/']) {
    assert.equal(getAuthUser(req('127.0.0.1', url), users), null,
      `${url} is not part of the fallback`);
  }

  // A real credential still works from anywhere, which is the whole point of
  // narrowing this rather than blocking the network outright.
  const creds = Buffer.from('bob:secret456').toString('base64');
  assert.equal(
    getAuthUser({ originalUrl: '/api/settings', headers: { authorization: `Basic ${creds}` }, socket: { remoteAddress: '192.168.1.1' } }, users)?.username,
    'bob',
    'a signed-in phone on the LAN is unaffected');

  console.log('  Only this machine gets a free pass, and only on two routes');
}

console.log('\nALL PASS (server-user-db)');
