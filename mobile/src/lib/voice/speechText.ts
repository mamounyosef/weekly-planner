// ─── Voice mode: text that is spoken, and speech that is read ───────────────
//
// Pure helpers, no DOM, so they are tested on their own (speechText.test.ts):
//
//   speakable()        markdown and symbols out, words a voice can read in
//   SentenceSplitter   a reply streaming in token by token, cut into whole
//                      sentences the moment each one is complete, so the
//                      voice starts on the first sentence while the model is
//                      still writing the rest
//   yesOrNo()          a spoken answer to "should I delete these?"
//   approvalSpeech()   that question, said out loud
//   questionSpeech()   an ask_user card, said out loud
//
// Shared by the PC/browser app and (later) the phone, so nothing in here may
// assume a browser.

import type { AgentApproval, AgentQuestion } from '../agent/agentTypes';

// ─── Writing for the ear ─────────────────────────────────────────────────────

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/**
 * What a voice should say for a piece of the model's markdown. Formatting
 * goes, the words stay: "**Gym** at 6" -> "Gym at 6", a list item loses its
 * bullet, a link keeps its text and drops the address.
 */
export function speakable(text: string): string {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, 'a link');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*>\s?/gm, '');
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '');
  t = t.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '');
  t = t.replace(/^[ \t]*\|/gm, '').replace(/\|[ \t]*$/gm, '');
  t = t.replace(/\s*\|\s*/g, ', ');
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
  t = t.replace(/(^|[^\w*])[*_](?!\s)([^*_\n]+?)[*_](?=[^\w*]|$)/g, '$1$2');
  t = t.replace(/[*_~#]+/g, ' ');
  t = t.replace(EMOJI, ' ');
  // Dashes read as a pause, never as "dash".
  t = t.replace(/\s*[—–]\s*/g, ', ');
  t = t.replace(/\s+-\s+/g, ', ');
  t = t.replace(/&/g, ' and ');
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  t = t.replace(/,(\s*,)+/g, ',');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[,;:]\s*/, '');
  return t;
}

// ─── Streaming text into sentences ───────────────────────────────────────────

/** Words whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'a.m', 'p.m',
  'approx', 'no', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun', 'min', 'hr', 'hrs',
]);

/** A long run with no full stop is cut at a comma once it reaches this. */
const SOFT_MAX = 180;
/** ...and anywhere at all once it reaches this. */
const HARD_MAX = 320;
/** The first piece may go to the voice early, at a comma, to start sooner. */
const FIRST_MIN = 40;

function endsSentenceAt(s: string, i: number): boolean {
  const ch = s[i];
  if (ch === '\n') return true;
  if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== ':' && ch !== ';') return false;
  // Closing quotes and brackets belong to the sentence they close.
  let j = i + 1;
  while (j < s.length && /["'”’)\]]/.test(s[j])) j++;
  if (j >= s.length) return false; // unknown yet: more text may follow
  if (!/\s/.test(s[j])) return false; // "3.5", "e.g.x", "10:30"
  if (ch === ':' || ch === ';') {
    // Only a colon before a new line or a capital is a break worth pausing on.
    let k = j;
    while (k < s.length && s[k] === ' ') k++;
    return s[k] === '\n';
  }
  if (ch === '.') {
    const word = /([A-Za-z.]+)$/.exec(s.slice(0, i))?.[1]?.toLowerCase() ?? '';
    if (ABBREVIATIONS.has(word)) {
      // "6 p.m. Then..." still ends; "Dr. Smith" does not. A capital after an
      // abbreviation only ends the sentence for the time ones.
      let k = j;
      while (k < s.length && s[k] === ' ') k++;
      if (!(word === 'a.m' || word === 'p.m') || !/[A-Z]/.test(s[k] ?? '')) return false;
    }
    // An initial: "J. Smith". (A capital letter alone, then a capitalised word.)
    // Until the letter after that capital has arrived, it cannot be told apart.
    if (/(^|\s)[A-Z]$/.test(s.slice(0, i)) && /^\s+([A-Z][a-z]|[A-Z]?$)/.test(s.slice(i + 1))) return false;
  }
  return true;
}

/**
 * Feed it the reply as it streams; it hands back each sentence once it is
 * complete. `push` takes the WHOLE text so far (not a delta), so a missed or
 * repeated stream event can never double or drop words.
 */
export class SentenceSplitter {
  private spoken = 0;
  private emitted = 0;

  /** Everything up to here has been handed out. */
  get position(): number { return this.spoken; }

  push(full: string): string[] {
    const out: string[] = [];
    if (full.length < this.spoken) this.spoken = 0; // a different text: start again
    for (;;) {
      const piece = this.next(full);
      if (piece === null) break;
      if (piece) out.push(piece);
    }
    return out;
  }

  /** The text is complete: whatever is left is the last sentence. */
  finish(full: string): string[] {
    const out = this.push(full);
    const rest = speakable(full.slice(this.spoken));
    this.spoken = full.length;
    if (rest && /[\p{L}\p{N}]/u.test(rest)) { out.push(rest); this.emitted++; }
    return out;
  }

  reset(): void { this.spoken = 0; this.emitted = 0; }

  private next(full: string): string | null {
    const s = full.slice(this.spoken);
    if (!s.trim()) return null;
    let cut = -1;
    for (let i = 0; i < s.length; i++) {
      if (endsSentenceAt(s, i)) { cut = i + 1; break; }
    }
    if (cut < 0) {
      const soft = this.emitted === 0 ? FIRST_MIN : SOFT_MAX;
      if (s.length >= soft) {
        // A clause break: a comma followed by more text.
        const window = s.slice(0, Math.min(s.length, HARD_MAX));
        const m = [...window.matchAll(/,\s/g)].filter(x => (x.index ?? 0) >= Math.min(soft, 24)).pop();
        if (m && (this.emitted > 0 || s.length >= FIRST_MIN)) cut = (m.index ?? 0) + 1;
      }
      if (cut < 0 && s.length >= HARD_MAX) {
        const sp = s.lastIndexOf(' ', HARD_MAX);
        cut = sp > 0 ? sp : HARD_MAX;
      }
      if (cut < 0) return null;
    }
    // Swallow closing quotes/brackets that belong to the sentence.
    while (cut < s.length && /["'”’)\]]/.test(s[cut])) cut++;
    this.spoken += cut;
    const said = speakable(s.slice(0, cut));
    if (!said || !/[\p{L}\p{N}]/u.test(said)) return '';
    this.emitted++;
    return said;
  }
}

// ─── Spoken answers ──────────────────────────────────────────────────────────

const NO_PATTERNS = [
  /\bno\b(?!\s+(problem|worries|doubt)\b)/, /\bnope\b/, /\bnah\b/, /\bdon'?t\b/, /\bdo not\b/, /\bcancel\b/,
  /\bstop\b/, /\bwait\b/, /\bhold on\b/, /\bnever ?mind\b/, /\bkeep (it|them|that|those|this)\b/,
  /\bnot (that|those|this|yet|now)\b/, /\bdeny\b/, /\bleave (it|them)\b/, /\bscratch that\b/,
];
const YES_PATTERNS = [
  /\byes\b/, /\byeah\b/, /\byep\b/, /\byup\b/, /\bya\b/, /\bsure\b/, /\bok(ay)?\b/, /\bgo ahead\b/,
  /\bdo it\b/, /\bdelete (it|them|those|that|all)\b/, /\bremove (it|them|those|that)\b/, /\bconfirm(ed)?\b/,
  /\bapprove(d)?\b/, /\bcorrect\b/, /\bplease do\b/, /\babsolutely\b/, /\bof course\b/, /\bdefinitely\b/,
  /\bsounds good\b/, /\bthat'?s right\b/, /\bright\b/, /\bgo for it\b/, /\bproceed\b/, /\bget rid of\b/,
];

/**
 * A spoken reply to a yes/no question about deleting. Anything with a "no"
 * in it is a no: when in doubt, nothing is deleted. Neither is null, and the
 * words are passed on to the assistant as a normal message instead.
 */
export function yesOrNo(text: string): 'yes' | 'no' | null {
  const t = ` ${String(text ?? '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  if (!t.trim()) return null;
  if (NO_PATTERNS.some(p => p.test(t))) return 'no';
  if (YES_PATTERNS.some(p => p.test(t))) return 'yes';
  return null;
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Should I delete Gym on Thursday the 23rd and Dentist? Say yes or no." */
export function approvalSpeech(approval: Pick<AgentApproval, 'deletions'>): string {
  const list = approval.deletions ?? [];
  if (!list.length) return 'Should I go ahead and delete that? Say yes or no.';
  const shown = list.slice(0, 4).map(d => {
    const title = speakable(d.title || 'an item');
    const when = speakable(d.when || '');
    const scope = /whole series|all/i.test(d.scopeLabel || '') ? ', the whole series' : '';
    return `${title}${when ? `, ${when}` : ''}${scope}`;
  });
  const more = list.length > 4 ? `, and ${list.length - 4} more` : '';
  const what = list.length === 1 ? shown[0] : `these ${list.length}: ${joinWords(shown)}${more}`;
  return `Should I delete ${what}? Say yes or no.`;
}

/** An ask_user card read out: each question with its options. */
export function questionSpeech(questions: AgentQuestion[]): string {
  return (questions ?? []).slice(0, 4).map(q => {
    const opts = (q.options ?? [])
      .map(o => speakable(String(o?.label ?? '').replace(/\s*\(Recommended\)\s*/i, '')).replace(/[.?!]+$/, ''))
      .filter(Boolean)
      .slice(0, 4);
    let ask = speakable(q.question);
    if (ask && !/[.?!]$/.test(ask)) ask += '?';
    if (!opts.length) return ask;
    const choices = opts.length === 1 ? opts[0] : `${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]}`;
    return `${ask} ${choices}?`.trim();
  }).filter(Boolean).join(' ');
}

// ─── Settings ────────────────────────────────────────────────────────────────

export type PauseLength = 'quick' | 'balanced' | 'patient';

/** How much silence ends a turn. The engine stretches it after "and", "um"... */
export function endpointMs(p: PauseLength | string | null | undefined): number {
  return p === 'quick' ? 500 : p === 'patient' ? 1150 : 750;
}
