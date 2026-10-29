// Tests for the API key rules (src/lib/agent/agentKeys.ts).
// Run with: npx tsx src/lib/agent/agentKeys.test.ts

import assert from 'node:assert/strict';

import {
  activeMark, allKeysFailed, inUseIndex, keyLabel, keyTrouble, maskKey, nextUtcMidnight, planKeyTries,
  serviceErrorText, troubleText, RECHECK_MS, type KeyMark,
} from './agentKeys';
import { keyNoteText } from './agentTypes';

const NOW = Date.UTC(2026, 9, 26, 14, 30); // 26 Oct 2026, 14:30 UTC
const mark = (kind: KeyMark['kind'], retryAt = NOW + 60_000, detail = '402 no credit'): KeyMark => ({ kind, retryAt, detail });

console.log('--- 1. WHAT COUNTS AS A FINISHED KEY ---');
{
  // 402 is out of credit on both services, whatever the text.
  for (const p of ['ollama', 'openrouter'] as const) {
    const m = keyTrouble(p, 402, 'Payment Required', NOW)!;
    assert.equal(m.kind, 'credit');
    assert.equal(m.retryAt, NOW + RECHECK_MS);
    assert.equal(m.detail, '402 Payment Required');
  }
  // 429: only a limit in the text makes it credit; a busy model is retried on the same key.
  assert.equal(keyTrouble('ollama', 429, 'Too many requests, slow down', NOW), null);
  assert.equal(keyTrouble('openrouter', 429, 'Rate limited upstream. Please retry shortly.', NOW), null);
  assert.equal(keyTrouble('ollama', 429, "you've reached your weekly usage limit", NOW)!.kind, 'credit');
  assert.equal(keyTrouble('ollama', 429, 'session usage limit exceeded, upgrade for more', NOW)!.kind, 'credit');
  // OpenRouter's free daily allowance comes back at midnight UTC.
  const daily = keyTrouble('openrouter', 429, 'Rate limit exceeded: free-models-per-day', NOW)!;
  assert.equal(daily.kind, 'credit');
  assert.equal(daily.retryAt, Date.UTC(2026, 9, 27));
  // The same words on Ollama are not OpenRouter's daily reset.
  assert.equal(keyTrouble('ollama', 429, 'daily limit reached', NOW)!.retryAt, NOW + RECHECK_MS);
  // 403: a spending limit is credit; anything else is a refused key.
  assert.equal(keyTrouble('openrouter', 403, 'Key limit exceeded (total limit)', NOW)!.kind, 'credit');
  assert.equal(keyTrouble('openrouter', 403, 'Forbidden', NOW)!.kind, 'rejected');
  assert.equal(keyTrouble('ollama', 401, 'unauthorized', NOW)!.kind, 'rejected');
  assert.equal(keyTrouble('ollama', 401, '', NOW)!.detail, '401');
  // Errors inside a stream (status 0) count only when they say so.
  assert.equal(keyTrouble('ollama', 0, 'insufficient balance', NOW)!.kind, 'credit');
  assert.equal(keyTrouble('ollama', 0, 'model is overloaded', NOW), null);
  assert.equal(keyTrouble('ollama', 0, '', NOW), null);
  // Passing problems never move to another key.
  for (const s of [400, 404, 500, 502, 503]) assert.equal(keyTrouble('ollama', s, 'quota', NOW), null, String(s));
  // The detail is one line, at most 200 characters of text.
  const long = keyTrouble('ollama', 402, `a\n\n  b ${'x'.repeat(500)}`, NOW)!;
  assert.doesNotMatch(long.detail, /\n/);
  assert.ok(long.detail.length <= 204);
  console.log('  ok');
}

console.log('--- 2. MIDNIGHT UTC ---');
{
  assert.equal(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59)), Date.UTC(2027, 0, 1));
  assert.equal(nextUtcMidnight(Date.UTC(2026, 1, 28, 0, 0)), Date.UTC(2026, 2, 1));
  assert.equal(nextUtcMidnight(Date.UTC(2028, 1, 28, 12)), Date.UTC(2028, 1, 29), 'leap year');
  console.log('  ok');
}

console.log('--- 3. WHICH KEY IS IN USE ---');
{
  assert.equal(inUseIndex([], NOW), -1);
  assert.equal(inUseIndex([null], NOW), 0);
  assert.equal(inUseIndex([null, null], NOW), 0);
  assert.equal(inUseIndex([mark('credit'), null, null], NOW), 1);
  assert.equal(inUseIndex([mark('credit'), mark('rejected'), null], NOW), 2);
  assert.equal(inUseIndex([mark('credit'), mark('credit')], NOW), 0, 'all out: the first');
  // A mark whose time has come is no mark at all.
  assert.equal(inUseIndex([mark('credit', NOW), null], NOW), 0);
  assert.equal(inUseIndex([mark('credit', NOW - 1), null], NOW), 0);
  assert.equal(activeMark(mark('credit', NOW + 1), NOW)?.kind, 'credit');
  assert.equal(activeMark(mark('credit', NOW), NOW), null);
  assert.equal(activeMark(undefined, NOW), null);
  console.log('  ok');
}

console.log('--- 4. THE ORDER KEYS ARE TRIED IN ---');
{
  assert.deepEqual(planKeyTries('ollama', [], NOW), { order: [], skipped: [] });
  assert.deepEqual(planKeyTries('ollama', [null, null, null], NOW), { order: [0, 1, 2], skipped: [] });
  const a = planKeyTries('ollama', [mark('credit', NOW + 3600_000), null, mark('rejected'), null], NOW);
  assert.deepEqual(a.order, [1, 3]);
  assert.equal(a.skipped.length, 2);
  assert.match(a.skipped[0], /^Ollama key 1 ran out of credit earlier \(tried again after \d\d:\d\d\)$/);
  assert.match(a.skipped[1], /^Ollama key 3 was refused earlier/);
  // Every key out: all are tried again, in order, in case one recovered.
  const all = planKeyTries('openrouter', [mark('credit'), mark('credit')], NOW);
  assert.deepEqual(all, { order: [0, 1], skipped: [] });
  // Expired marks do not skip.
  assert.deepEqual(planKeyTries('ollama', [mark('credit', NOW - 5), null], NOW).order, [0, 1]);
  console.log('  ok');
}

console.log('--- 5. WHAT THE NOTES SAY ---');
{
  assert.equal(keyLabel('ollama', 0, 1), 'Ollama');
  assert.equal(keyLabel('ollama', 1, 3), 'Ollama key 2');
  assert.equal(keyLabel('openrouter', 0, 2), 'OpenRouter key 1');
  assert.equal(troubleText('ollama', 0, 2, mark('credit')), 'Ollama key 1 is out of credit (402 no credit)');
  assert.equal(troubleText('openrouter', 1, 2, mark('rejected', NOW, '401 bad key')), 'OpenRouter key 2 was refused (401 bad key)');
  const many = allKeysFailed('ollama', 2, ['Ollama key 1 is out of credit (402)', 'Ollama key 2 is out of credit (402)']);
  assert.match(many, /^Every Ollama key failed: Ollama key 1 is out of credit \(402\); Ollama key 2/);
  assert.match(many, /Settings > Assistant/);
  const one = allKeysFailed('openrouter', 1, ['OpenRouter is out of credit (402)']);
  assert.match(one, /^OpenRouter is out of credit \(402\)\. Add another OpenRouter key/);
  assert.equal(
    keyNoteText({ provider: 'ollama', key: 2, keys: 3, reason: 'Ollama key 1 is out of credit (402)', at: NOW }),
    'Answered with Ollama key 2 of 3: Ollama key 1 is out of credit (402)',
  );
  assert.equal(keyNoteText({ provider: 'openrouter', key: 1, keys: 2, reason: '', at: NOW }), 'Answered with OpenRouter key 1 of 2');
  for (const s of [many, one, troubleText('ollama', 0, 1, mark('credit'))]) assert.doesNotMatch(s, /[–—]/);
  console.log('  ok');
}

console.log('--- 6. MASKED KEYS NEVER SHOW THE KEY ---');
{
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('sk-or-v1-abcdef0123456789'), 'sk-o...6789');
  assert.equal(maskKey('short'), 'sh...');
  assert.equal(maskKey('0123456789'), '01...');
  const k = 'a3f9c0e1b2d4f6a8c0e2b4d6f8a0c2e4';
  assert.ok(maskKey(k).replace('...', '').length <= 8);
  console.log('  ok');
}

console.log('--- 7. SERVICE ERROR TEXT ---');
{
  assert.equal(serviceErrorText('{"error":{"message":"Insufficient credits","metadata":{"raw":"upstream said no"}}}'), 'Insufficient credits (upstream said no)');
  assert.equal(serviceErrorText('{"error":"you have reached your weekly usage limit"}'), 'you have reached your weekly usage limit');
  assert.equal(serviceErrorText('  plain text  '), 'plain text');
  assert.equal(serviceErrorText('{"other":1}'), '{"other":1}');
  assert.equal(serviceErrorText(''), '');
  console.log('  ok');
}

console.log('\nAll agentKeys tests passed.');
