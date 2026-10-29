// Tests for the server's key list and key-to-key failover (agent-keys.ts).
// Run with: npx tsx agent-keys.test.ts
// Uses a throwaway folder and a stubbed fetch: no real service is called.

import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { KeyFailure, KeyStore, KeysExhausted } from './agent-keys';
import type { AgentKeyNote } from './src/lib/agent/agentTypes';

const realFetch = globalThis.fetch;
/** Every key is accepted by the "is this key known" check unless it contains "bad". */
globalThis.fetch = (async (_url: any, init?: any) => {
  const auth = String(init?.headers?.Authorization ?? '');
  return new Response('{}', { status: auth.includes('bad') ? 401 : 200 });
}) as typeof fetch;

const dirs: string[] = [];
function setup(env: Record<string, string> = { OLLAMA_API_KEY: 'env-ollama-key-123456' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-keys-'));
  dirs.push(dir);
  const logs: string[] = [];
  const envBox = { env };
  const store = () => new KeyStore(dir, () => envBox.env, () => 'https://ollama.example', l => logs.push(l));
  return { dir, store, logs, envBox, file: path.join(dir, 'database', 'agent-keys.json') };
}

const ctrl = () => new AbortController().signal;
const credit = (detail = '402 out') => new KeyFailure({ kind: 'credit', retryAt: Date.now() + 60_000, detail });

async function main() {
  console.log('--- 1. THE .ENV KEY IS OLLAMA KEY 1, READ LIVE, NEVER COPIED ---');
  {
    const t = setup();
    const s = t.store();
    assert.equal(fs.existsSync(t.file), false, 'nothing written just by reading');
    const st = s.status();
    assert.equal(st.ollama.length, 1);
    assert.equal(st.ollama[0].fromEnv, true);
    assert.equal(st.ollama[0].inUse, true);
    assert.equal(st.ollama[0].masked, 'env-...3456');
    assert.equal(st.openrouter.length, 0);
    assert.ok(s.hasKey('ollama'));
    assert.ok(!s.hasKey('openrouter'));
    // Adding a key writes the list: the .env key is a reference, not the key.
    assert.deepEqual(await s.add('ollama', 'second-ollama-key-abcdef'), { ok: true });
    const saved = JSON.parse(fs.readFileSync(t.file, 'utf-8'));
    assert.deepEqual(saved.ollama, ['env:OLLAMA_API_KEY', 'second-ollama-key-abcdef']);
    assert.ok(!fs.readFileSync(t.file, 'utf-8').includes('env-ollama-key-123456'), 'the .env key never lands in the list file');
    // Editing .env still changes key 1.
    t.envBox.env = { OLLAMA_API_KEY: 'changed-env-key-999999' };
    assert.equal(s.status().ollama[0].masked, 'chan...9999');
    // .env emptied: the reference is skipped, not used as an empty key.
    t.envBox.env = {};
    assert.equal(s.keys('ollama').length, 1);
    assert.equal(s.keys('ollama')[0].key, 'second-ollama-key-abcdef');
    console.log('  ok');
  }

  console.log('--- 2. NO .ENV KEY, NO LIST: NOTHING; OPENROUTER FROM ITS OWN ENV NAME ---');
  {
    const t = setup({});
    assert.equal(t.store().status().ollama.length, 0);
    const u = setup({ OPENROUTER_API_KEY: 'sk-or-env-key-0000' });
    assert.equal(u.store().status().openrouter[0].fromEnv, true);
    assert.equal(u.store().status().ollama.length, 0);
    console.log('  ok');
  }

  console.log('--- 3. ADD, REFUSE, USE, REMOVE ---');
  {
    const t = setup();
    const s = t.store();
    assert.deepEqual(await s.add('ollama', ''), { ok: false, error: 'Paste a key first.' });
    assert.deepEqual(await s.add('ollama', '   '), { ok: false, error: 'Paste a key first.' });
    assert.equal((await s.add('ollama', 'has space inside')).ok, false);
    assert.deepEqual(await s.add('ollama', 'env-ollama-key-123456'), { ok: false, error: 'This key is already saved.' }, 'the .env key counts as saved');
    assert.deepEqual(await s.add('openrouter', 'sk-or-bad-key-1111'), { ok: false, error: 'OpenRouter rejected this key.' });
    assert.equal(fs.existsSync(t.file), false, 'a refused key writes nothing');
    assert.deepEqual(await s.add('openrouter', '  sk-or-good-key-2222  '), { ok: true }, 'trimmed');
    assert.equal(s.keys('openrouter')[0].key, 'sk-or-good-key-2222');
    assert.deepEqual(await s.add('ollama', 'k2-xxxxxxxxxxxx'), { ok: true });
    assert.deepEqual(await s.add('ollama', 'k3-xxxxxxxxxxxx'), { ok: true });
    assert.deepEqual(s.keys('ollama').map(k => k.key), ['env-ollama-key-123456', 'k2-xxxxxxxxxxxx', 'k3-xxxxxxxxxxxx']);
    // Use moves a key to the top.
    assert.deepEqual(s.use('ollama', 2), { ok: true });
    assert.deepEqual(s.keys('ollama').map(k => k.key), ['k3-xxxxxxxxxxxx', 'env-ollama-key-123456', 'k2-xxxxxxxxxxxx']);
    assert.equal(s.status().ollama[0].inUse, true);
    assert.equal(s.use('ollama', 9).ok, false);
    assert.equal(s.use('ollama', -1).ok, false);
    // Removing the .env key takes the reference off the list; .env is untouched.
    assert.deepEqual(s.remove('ollama', 1), { ok: true });
    assert.deepEqual(s.keys('ollama').map(k => k.key), ['k3-xxxxxxxxxxxx', 'k2-xxxxxxxxxxxx']);
    assert.deepEqual(t.envBox.env, { OLLAMA_API_KEY: 'env-ollama-key-123456' });
    // ...and it does not come back by itself once the list exists.
    assert.equal(t.store().keys('ollama').length, 2);
    assert.equal(s.remove('ollama', 5).ok, false);
    // Removing every key leaves an empty list, still not the .env key.
    s.remove('ollama', 0); s.remove('ollama', 0);
    assert.equal(t.store().keys('ollama').length, 0);
    assert.equal(t.store().keys('openrouter').length, 1, 'the other service is untouched');
    console.log('  ok');
  }

  console.log('--- 4. FAILOVER: SAME SERVICE, NEXT KEY, AND THE REPLY IS TOLD ---');
  {
    const t = setup();
    const s = t.store();
    await s.add('ollama', 'k2-xxxxxxxxxxxx');
    await s.add('ollama', 'k3-xxxxxxxxxxxx');
    const notes: AgentKeyNote[] = [];
    const used: string[] = [];
    // First reply: key 1 works, nothing to say.
    assert.equal(await s.withKeys('ollama', ctrl(), n => notes.push(n), async k => { used.push(k); return 'a'; }), 'a');
    assert.deepEqual(notes, []);
    // Key 1 runs out mid-chat: key 2 answers, and the note says why.
    const r = await s.withKeys('ollama', ctrl(), n => notes.push(n), async k => {
      used.push(k);
      if (k === 'env-ollama-key-123456') throw credit('402 weekly usage limit reached');
      return 'b';
    });
    assert.equal(r, 'b');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].provider, 'ollama');
    assert.equal(notes[0].key, 2);
    assert.equal(notes[0].keys, 3);
    assert.match(notes[0].reason, /^Ollama key 1 is out of credit \(402 weekly usage limit reached\)$/);
    assert.match(t.logs.join('\n'), /Ollama key 1 out of credit/);
    // The next reply skips key 1 without asking it, and says nothing (same key as last time).
    used.length = 0;
    notes.length = 0;
    await s.withKeys('ollama', ctrl(), n => notes.push(n), async k => { used.push(k); return 'c'; });
    assert.deepEqual(used, ['k2-xxxxxxxxxxxx']);
    assert.deepEqual(notes, []);
    const st = s.status().ollama;
    assert.equal(st[0].inUse, false);
    assert.ok(st[0].outUntil! > Date.now());
    assert.equal(st[0].trouble, 'credit');
    assert.equal(st[1].inUse, true);
    // Remembered across a restart (a new store reads the status file).
    const again = t.store();
    used.length = 0;
    await again.withKeys('ollama', ctrl(), () => {}, async k => { used.push(k); return 'd'; });
    assert.deepEqual(used, ['k2-xxxxxxxxxxxx']);
    // Never moves to the other service: OpenRouter has no key here.
    await assert.rejects(s.withKeys('openrouter', ctrl(), () => {}, async () => 'x'), (e: any) => e instanceof KeysExhausted && /no OpenRouter API key/i.test(e.message));
    console.log('  ok');
  }

  console.log('--- 5. EVERY KEY OUT: ALL TRIED, THEN ONE CLEAR ERROR ---');
  {
    const t = setup();
    const s = t.store();
    await s.add('ollama', 'k2-xxxxxxxxxxxx');
    const used: string[] = [];
    await assert.rejects(
      s.withKeys('ollama', ctrl(), () => {}, async k => { used.push(k); throw credit(); }),
      (e: any) => e instanceof KeysExhausted && /^Every Ollama key failed: Ollama key 1 is out of credit \(402 out\); Ollama key 2 is out of credit/.test(e.message),
    );
    assert.deepEqual(used, ['env-ollama-key-123456', 'k2-xxxxxxxxxxxx']);
    // Both marked: the next request still tries them all, in order, in case one recovered.
    used.length = 0;
    const notes: AgentKeyNote[] = [];
    const r = await s.withKeys('ollama', ctrl(), n => notes.push(n), async k => { used.push(k); if (k === 'k2-xxxxxxxxxxxx') return 'ok'; throw credit(); });
    assert.equal(r, 'ok');
    assert.deepEqual(used, ['env-ollama-key-123456', 'k2-xxxxxxxxxxxx']);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].key, 2);
    // The key that answered is no longer marked.
    assert.equal(s.status().ollama[1].outUntil, null);
    console.log('  ok');
  }

  console.log('--- 6. ONLY KEY FAILURES MOVE ON; OTHER ERRORS GO STRAIGHT UP ---');
  {
    const t = setup();
    const s = t.store();
    await s.add('ollama', 'k2-xxxxxxxxxxxx');
    const used: string[] = [];
    await assert.rejects(s.withKeys('ollama', ctrl(), () => {}, async k => { used.push(k); throw new Error('500 busy'); }), /500 busy/);
    assert.deepEqual(used, ['env-ollama-key-123456'], 'a busy model is not a reason to spend the next key');
    assert.equal(s.status().ollama[0].outUntil, null);
    // Stopped by the user: no further key is tried.
    const c = new AbortController();
    c.abort();
    await assert.rejects(s.withKeys('ollama', c.signal, () => {}, async () => 'x'), /aborted/);
    console.log('  ok');
  }

  console.log('--- 7. A KEY PICKED BY HAND IS TOLD ON THE NEXT REPLY ---');
  {
    const t = setup();
    const s = t.store();
    await s.add('ollama', 'k2-xxxxxxxxxxxx');
    await s.withKeys('ollama', ctrl(), () => {}, async () => 'first');
    s.use('ollama', 1);
    const notes: AgentKeyNote[] = [];
    await s.withKeys('ollama', ctrl(), n => notes.push(n), async () => 'second');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].key, 1);
    assert.equal(notes[0].reason, '');
    console.log('  ok');
  }

  console.log('\nAll agent-keys tests passed.');
}

main()
  .finally(() => {
    globalThis.fetch = realFetch;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  })
  .catch(err => { console.error(err); process.exit(1); });
