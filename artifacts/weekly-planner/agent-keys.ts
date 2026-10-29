// ─── Planner agent: the API keys of each service ────────────────────────────
//
// Every key for Ollama and OpenRouter, in the order they are tried, lives in
// `database/agent-keys.json` (git-ignored, never sent to a client: the
// settings screens only ever see masked keys). The key in the repo's `.env`
// (OLLAMA_API_KEY) is not copied: the list holds a reference to it
// ("env:OLLAMA_API_KEY"), so it stays Ollama key 1, read live from `.env`,
// and editing `.env` still works as before.
//
// Keys that ran out of credit (or were refused) are remembered by a hash of
// the key in `database/agent-key-status.json`, so a restart still skips them
// until they are due to be tried again. The rules are in
// src/lib/agent/agentKeys.ts (tested).

import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  activeMark, allKeysFailed, inUseIndex, keyLabel, keyTrouble, maskKey, nextUtcMidnight, planKeyTries,
  serviceErrorText, troubleText, RECHECK_MS, type KeyMark,
} from './src/lib/agent/agentKeys';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from './src/lib/agent/agentModels';
import type { AgentKeyInfo, AgentKeyNote, AgentKeysStatus } from './src/lib/agent/agentTypes';
import { OPENROUTER } from './server-openrouter';

const ENV_NAME: Record<Provider, string> = { ollama: 'OLLAMA_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const ENV_REF = (p: Provider) => `env:${ENV_NAME[p]}`;

/** A key that cannot serve this request: the request moves on to the service's next key. */
export class KeyFailure extends Error {
  constructor(readonly mark: KeyMark) { super(mark.detail); }
}

/** No key of the service could serve the request (none saved, or every one failed). Not worth retrying. */
export class KeysExhausted extends Error {}

interface Resolved { key: string; entry: string; fromEnv: boolean }

export class KeyStore {
  private file: string;
  private statusFile: string;
  private marks: Record<string, KeyMark> = {};
  /** The key each service last answered with (its id): a reply is noted only when this changes. */
  private current: Partial<Record<Provider, string>> = {};

  constructor(
    private rootDir: string,
    private readEnv: () => Record<string, string>,
    private ollamaBase: () => string,
    private log: (line: string) => void,
  ) {
    this.file = path.join(rootDir, 'database', 'agent-keys.json');
    this.statusFile = path.join(rootDir, 'database', 'agent-key-status.json');
    try {
      const j = JSON.parse(fsSync.readFileSync(this.statusFile, 'utf-8')) || {};
      if (j.marks && typeof j.marks === 'object') this.marks = j.marks;
      if (j.current && typeof j.current === 'object') this.current = j.current;
    } catch { /* none yet */ }
  }

  // ── The list ──

  /** The saved entries (keys, or a reference to the .env key). Before anything is saved: the .env keys. */
  private entries(): Record<Provider, string[]> {
    try {
      const j = JSON.parse(fsSync.readFileSync(this.file, 'utf-8'));
      const list = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : []);
      return { ollama: list(j?.ollama), openrouter: list(j?.openrouter) };
    } catch {
      const env = this.readEnv();
      const seed = (p: Provider) => (env[ENV_NAME[p]]?.trim() ? [ENV_REF(p)] : []);
      return { ollama: seed('ollama'), openrouter: seed('openrouter') };
    }
  }

  private writeEntries(all: Record<Provider, string[]>) {
    const clean = (l: string[]) => [...new Set(l.map(k => k.trim()).filter(Boolean))];
    const out = { ollama: clean(all.ollama), openrouter: clean(all.openrouter) };
    fsSync.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fsSync.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
    fsSync.renameSync(tmp, this.file);
  }

  /** A service's usable keys in the order they are tried. A .env reference with nothing in .env is left out. */
  keys(p: Provider): Resolved[] {
    const env = this.readEnv();
    return this.entries()[p]
      .map(entry => {
        const ref = /^env:([A-Z0-9_]+)$/.exec(entry);
        return ref ? { key: env[ref[1]]?.trim() ?? '', entry, fromEnv: true } : { key: entry, entry, fromEnv: false };
      })
      .filter(r => r.key);
  }

  hasKey(p: Provider): boolean { return this.keys(p).length > 0; }

  // ── Marks ──

  private idOf(k: string) { return crypto.createHash('sha256').update(k).digest('hex').slice(0, 24); }

  private saveStatus() {
    const now = Date.now();
    for (const [id, m] of Object.entries(this.marks)) if (!activeMark(m, now)) delete this.marks[id];
    try {
      fsSync.mkdirSync(path.dirname(this.statusFile), { recursive: true });
      fsSync.writeFileSync(this.statusFile, JSON.stringify({ marks: this.marks, current: this.current }), 'utf-8');
    } catch (err: any) {
      this.log(`AGENT key status not saved: ${err?.message ?? err}`);
    }
  }

  private markOf(k: string): KeyMark | null { return activeMark(this.marks[this.idOf(k)], Date.now()); }

  private setMark(k: string, m: KeyMark) { this.marks[this.idOf(k)] = m; this.saveStatus(); }

  private clearMark(k: string) {
    if (!(this.idOf(k) in this.marks)) return;
    delete this.marks[this.idOf(k)];
    this.saveStatus();
  }

  // ── What the settings screens see ──

  status(): AgentKeysStatus {
    const now = Date.now();
    const one = (p: Provider): AgentKeyInfo[] => {
      const list = this.keys(p);
      const marks = list.map(r => this.markOf(r.key));
      const use = inUseIndex(marks, now);
      return list.map((r, i) => ({
        masked: maskKey(r.key),
        ...(r.fromEnv ? { fromEnv: true } : {}),
        inUse: i === use,
        outUntil: marks[i]?.retryAt ?? null,
        ...(marks[i] ? { trouble: marks[i]!.kind } : {}),
        detail: marks[i]?.detail ?? '',
      }));
    };
    return { ollama: one('ollama'), openrouter: one('openrouter') };
  }

  /** Asks the service whether it knows the key, so a typo shows up here and not mid-chat. Offline: kept anyway. */
  private async checkKey(p: Provider, k: string): Promise<string> {
    try {
      const res = await fetch(p === 'openrouter' ? `${OPENROUTER}/key` : `${this.ollamaBase()}/api/tags`, {
        headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 || res.status === 403) return `${PROVIDER_LABEL[p]} rejected this key.`;
    } catch { /* offline */ }
    return '';
  }

  /** Adds a key after the others: it is used when the ones before it run out. */
  async add(p: Provider, raw: unknown): Promise<{ ok: boolean; error?: string }> {
    const k = String(raw ?? '').trim();
    if (!k) return { ok: false, error: 'Paste a key first.' };
    if (/\s/.test(k) || k.length > 400) return { ok: false, error: 'That does not look like an API key.' };
    if (this.keys(p).some(r => r.key === k)) return { ok: false, error: 'This key is already saved.' };
    const err = await this.checkKey(p, k);
    if (err) return { ok: false, error: err };
    const all = this.entries();
    all[p] = [...all[p], k];
    this.writeEntries(all);
    this.clearMark(k);
    this.log(`AGENT ${PROVIDER_LABEL[p]} key added (${maskKey(k)})`);
    return { ok: true };
  }

  /** Removes a key from the list. The .env key is only taken off the list; .env itself is never touched. */
  remove(p: Provider, index: number): { ok: boolean; error?: string } {
    const list = this.keys(p);
    const r = list[index];
    if (!r) return { ok: false, error: 'No such key.' };
    const all = this.entries();
    all[p] = all[p].filter(e => e !== r.entry);
    this.writeEntries(all);
    this.clearMark(r.key);
    this.log(`AGENT ${PROVIDER_LABEL[p]} key removed (${maskKey(r.key)})`);
    return { ok: true };
  }

  /** Makes a key the one used: it moves to the top and its mark is cleared. */
  use(p: Provider, index: number): { ok: boolean; error?: string } {
    const list = this.keys(p);
    const r = list[index];
    if (!r) return { ok: false, error: 'No such key.' };
    const all = this.entries();
    all[p] = [r.entry, ...all[p].filter(e => e !== r.entry)];
    this.writeEntries(all);
    this.clearMark(r.key);
    return { ok: true };
  }

  /**
   * Asks the service whether a key works right now: OpenRouter reports the
   * key's limits; Ollama answers a one token request. Updates the key's mark.
   */
  async test(p: Provider, index: number): Promise<{ ok: boolean; info?: string; error?: string }> {
    const r = this.keys(p)[index];
    if (!r) return { ok: false, error: 'No such key.' };
    const k = r.key;
    try {
      let res: Response;
      if (p === 'openrouter') {
        res = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(20_000) });
        if (res.ok) {
          const d: any = (await res.json().catch(() => ({})))?.data || {};
          const f = d.free_model_daily_requests;
          if (typeof d.limit_remaining === 'number' && d.limit_remaining <= 0) {
            this.setMark(k, { kind: 'credit', retryAt: Date.now() + RECHECK_MS, detail: 'Key spending limit reached' });
            return { ok: false, error: 'Its spending limit is used up.' };
          }
          if (f?.limit && f.used >= f.limit) {
            this.setMark(k, { kind: 'credit', retryAt: nextUtcMidnight(Date.now()), detail: 'Free requests for today used up' });
            return { ok: false, error: `All ${f.limit} free requests for today are used.` };
          }
          this.clearMark(k);
          return { ok: true, info: f?.limit ? `Works. ${f.used ?? 0} of ${f.limit} free requests used today.` : 'Works.' };
        }
      } else {
        res = await fetch(`${this.ollamaBase()}/api/chat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'Hi' }], stream: false, think: 'low', options: { num_predict: 1 } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          this.clearMark(k);
          return { ok: true, info: 'Works.' };
        }
      }
      const text = serviceErrorText(await res.text().catch(() => ''));
      const mark = keyTrouble(p, res.status, text, Date.now());
      if (mark) {
        this.setMark(k, mark);
        return { ok: false, error: mark.kind === 'rejected' ? `Refused: ${mark.detail}` : `Out of credit: ${mark.detail}` };
      }
      return { ok: false, error: `${res.status} ${text}`.trim() };
    } catch (err: any) {
      return { ok: false, error: err?.name === 'TimeoutError' ? 'The service did not answer in time.' : err?.message ?? String(err) };
    }
  }

  /** OpenRouter's free allowance for one key: requests used today. */
  async openrouterLimits(index: number): Promise<{ ok: boolean; freeUsed?: number | null; freeLimit?: number | null }> {
    const r = this.keys('openrouter')[index];
    if (!r) return { ok: false };
    try {
      const j: any = await (await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${r.key}` }, signal: AbortSignal.timeout(15_000) })).json();
      const f = j?.data?.free_model_daily_requests;
      return { ok: true, freeUsed: f?.used ?? null, freeLimit: f?.limit ?? null };
    } catch {
      return { ok: false };
    }
  }

  // ── Running a request ──

  /**
   * Runs a request with the service's keys in order: when one cannot serve
   * it (`run` throws KeyFailure), the same request goes to the next key of the
   * same service. `run` must throw KeyFailure only before it has passed
   * anything on. `onSwitch` hears about a change of key as it happens, so the
   * reply can say so while the next key starts.
   */
  async withKeys<T>(p: Provider, signal: AbortSignal, onSwitch: (n: AgentKeyNote) => void, run: (key: string) => Promise<T>): Promise<T> {
    const list = this.keys(p);
    if (!list.length) throw new KeysExhausted(`There is no ${PROVIDER_LABEL[p]} API key. Add one in Settings > Assistant${p === 'ollama' ? ' (or OLLAMA_API_KEY in the .env file on the PC)' : ''}.`);
    const n = list.length;
    const now = Date.now();
    const plan = planKeyTries(p, list.map(r => this.markOf(r.key)), now);
    const why = [...plan.skipped];
    for (const i of plan.order) {
      if (signal.aborted) throw new Error('aborted');
      const k = list[i].key;
      // Told once, when the key differs from the one that answered last; not on every reply after.
      const changed = this.current[p] !== this.idOf(k) && (Boolean(this.current[p]) || i > 0);
      if (changed) onSwitch({ provider: p, key: i + 1, keys: n, reason: why.join('; '), at: Date.now() });
      try {
        const result = await run(k);
        this.clearMark(k);
        if (this.current[p] !== this.idOf(k)) { this.current[p] = this.idOf(k); this.saveStatus(); }
        return result;
      } catch (err: any) {
        if (signal.aborted || !(err instanceof KeyFailure)) throw err;
        this.setMark(k, err.mark);
        const text = troubleText(p, i, n, err.mark);
        this.log(`AGENT ${keyLabel(p, i, n)} ${err.mark.kind === 'rejected' ? 'refused' : 'out of credit'}: ${err.mark.detail}`);
        why.push(text);
      }
    }
    throw new KeysExhausted(allKeysFailed(p, n, why));
  }
}

export function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as string[]).includes(v);
}
