// Tests authentication helpers, widget pairing session regex, and error formatting.
// Run with: npx tsx src/lib/auth.test.ts

import assert from 'node:assert/strict';

console.log('--- 1. WIDGET PAIRING ID VALIDATION ---');

const WIDGET_ID_RE = /^[a-f0-9]{64}$/;

function isValidWidgetPairingId(id: string | null | undefined): boolean {
  if (!id || typeof id !== 'string') return false;
  return WIDGET_ID_RE.test(id);
}

// Valid 64-char hex strings
const validId1 = 'a'.repeat(64);
const validId2 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
assert.equal(isValidWidgetPairingId(validId1), true);
assert.equal(isValidWidgetPairingId(validId2), true);

// Invalid lengths
assert.equal(isValidWidgetPairingId('a'.repeat(63)), false, '63 chars is invalid');
assert.equal(isValidWidgetPairingId('a'.repeat(65)), false, '65 chars is invalid');
assert.equal(isValidWidgetPairingId(''), false);
assert.equal(isValidWidgetPairingId(null), false);
assert.equal(isValidWidgetPairingId(undefined), false);

// Invalid characters (uppercase, non-hex)
assert.equal(isValidWidgetPairingId('A'.repeat(64)), false, 'Uppercase hex rejected');
assert.equal(isValidWidgetPairingId('g'.repeat(64)), false, 'Non-hex char rejected');
assert.equal(isValidWidgetPairingId(validId1.slice(0, 63) + '!'), false);

console.log('--- 2. WIDGET SEARCH PARAMS EXTRACTION ---');

function extractWidgetSession(search: string): string | null {
  const params = new URLSearchParams(search);
  const id = params.get('widgetSession');
  return id && WIDGET_ID_RE.test(id) ? id : null;
}

assert.equal(extractWidgetSession(`?widgetSession=${validId1}`), validId1);
assert.equal(extractWidgetSession(`?other=123&widgetSession=${validId2}&foo=bar`), validId2);
assert.equal(extractWidgetSession('?widgetSession=bad_id'), null);
assert.equal(extractWidgetSession(''), null);

console.log('--- 3. LOGIN ERROR FORMATTING ---');

function formatLoginError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Connection error while signing in (${detail})`;
}

assert.equal(formatLoginError(new Error('Failed to fetch')), 'Connection error while signing in (Failed to fetch)');
assert.equal(formatLoginError('Network timeout'), 'Connection error while signing in (Network timeout)');

console.log('\nALL PASS (auth)');
