// ─── Planner agent: API keys, and moving to the next one ────────────────────
//
// Pure rules behind the server's key list (agent-keys.ts). Each service
// (Ollama, OpenRouter) has its own keys, tried in order: when one runs out of
// credit (or is rejected), the same request goes to the next key of the SAME
// service. A model never moves to the other service. A key that ran out is
// remembered and skipped until it is due to be tried again; if every key is
// out, they are all tried anyway, in case one has recovered.
//
// Imported by the server and the PC settings page; the phone gets the shapes
// it needs from agentTypes.ts.

import { PROVIDER_LABEL, type Provider } from './agentModels';

/** Why a key is being skipped: out of credit (402, a daily/plan limit) or refused outright (401/403). */
export type KeyTrouble = 'credit' | 'rejected';

export interface KeyMark {
  /** Epoch ms when the key is tried again. */
  retryAt: number;
  detail: string;
  kind: KeyTrouble;
}

const CREDIT_TEXT = /credit|insufficient|balance|quota|usage limit|limit (?:reached|exceeded)|reached your|exceeded your|upgrade|billing|payment|subscription|free-models-per-day|per[- ]day|daily|weekly|monthly/i;

/** Next midnight UTC, when OpenRouter resets the free models' daily allowance. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** How long a key with no known reset time is left alone before it is tried again. */
export const RECHECK_MS = 15 * 60_000;

/**
 * Whether a failure means this key is finished for now (rather than a passing
 * problem), and when to try it again. Status 0 is an error sent inside a
 * stream, judged by its text.
 *  - 402 is "payment required" on both services.
 *  - 429 is out of credit only when the text says so (a daily or plan limit);
 *    otherwise it is a busy model, which is retried on the same key.
 *  - 403 is out of credit when the text says so (OpenRouter's key spending
 *    limit), otherwise the key is refused, like 401.
 */
export function keyTrouble(p: Provider, status: number, text: string, now: number): KeyMark | null {
  const t = String(text || '');
  const credit = status === 402 || ((status === 429 || status === 403 || status === 0) && CREDIT_TEXT.test(t));
  if (credit) {
    // The free models' daily allowance comes back at midnight UTC.
    const daily = p === 'openrouter' && /free-models-per-day|per[- ]day|daily/i.test(t);
    return { kind: 'credit', retryAt: daily ? nextUtcMidnight(now) : now + RECHECK_MS, detail: oneLine(status, t) };
  }
  if (status === 401 || status === 403) return { kind: 'rejected', retryAt: now + RECHECK_MS, detail: oneLine(status, t) };
  return null;
}

function oneLine(status: number, text: string): string {
  const body = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return status ? `${status}${body ? ` ${body}` : ''}` : body || 'No answer';
}

/** "abcd...wxyz": enough to tell keys apart, never enough to use one. */
export function maskKey(k: string): string {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 10) return `${s.slice(0, 2)}...`;
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

/** "Ollama" with one key, "Ollama key 2" with several. */
export function keyLabel(p: Provider, i: number, n: number): string {
  return n > 1 ? `${PROVIDER_LABEL[p]} key ${i + 1}` : PROVIDER_LABEL[p];
}

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** A mark that is still in force at `now`, else null. */
export function activeMark(mark: KeyMark | null | undefined, now: number): KeyMark | null {
  return mark && mark.retryAt > now ? mark : null;
}

/** The key the next request goes to: the first one not marked (the first one if all are). -1 with no keys. */
export function inUseIndex(marks: Array<KeyMark | null>, now: number): number {
  if (!marks.length) return -1;
  const i = marks.findIndex(m => !activeMark(m, now));
  return Math.max(0, i);
}

/**
 * The order to try a service's keys in: the ones not marked, in order; only
 * if none is left, all of them again. `skipped` says why each left-out key was
 * left out, for the note on the reply.
 */
export function planKeyTries(p: Provider, marks: Array<KeyMark | null>, now: number): { order: number[]; skipped: string[] } {
  const n = marks.length;
  const live = marks.map((m, i) => (activeMark(m, now) ? -1 : i)).filter(i => i >= 0);
  if (!live.length) return { order: marks.map((_, i) => i), skipped: [] };
  const skipped: string[] = [];
  marks.forEach((m, i) => {
    const a = activeMark(m, now);
    if (a) skipped.push(`${keyLabel(p, i, n)} ${a.kind === 'rejected' ? 'was refused' : 'ran out of credit'} earlier (tried again after ${clock(a.retryAt)})`);
  });
  return { order: live, skipped };
}

/** What a key failure is called in a note. */
export function troubleText(p: Provider, i: number, n: number, mark: KeyMark): string {
  return `${keyLabel(p, i, n)} ${mark.kind === 'rejected' ? 'was refused' : 'is out of credit'} (${mark.detail.slice(0, 160)})`;
}

/** The error when every key of a service failed. */
export function allKeysFailed(p: Provider, n: number, why: string[]): string {
  const label = PROVIDER_LABEL[p];
  const list = why.join('; ');
  return n > 1
    ? `Every ${label} key failed: ${list}. Add another ${label} key, or pick a model on the other service, in Settings > Assistant.`
    : `${list}. Add another ${label} key in Settings > Assistant, or pick a model on the other service.`;
}

/** Reads the error a service sent as one line: OpenRouter's JSON error, Ollama's `error`, or the raw text. */
export function serviceErrorText(text: string): string {
  try {
    const j = JSON.parse(text);
    const msg = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null);
    const raw = j?.error?.metadata?.raw;
    if (msg) return `${msg}${raw ? ` (${String(raw).slice(0, 200)})` : ''}`;
  } catch { /* not JSON */ }
  return String(text || '').trim();
}
