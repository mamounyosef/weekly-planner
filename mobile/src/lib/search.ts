// ─── Finding things ──────────────────────────────────────────────────────────
// Paging a calendar is a fine way to READ a plan and a terrible way to find one
// item in it. Anything more than a few days away in either direction is, in
// practice, unreachable on a phone. This module answers "where is that thing"
// over the whole planner, events and tasks together, including tasks that have
// no date at all.
//
// It is pure, has no dependencies beyond the engines it consumes, and never
// touches the network: everything it needs is already on the device.
//
// ─── WHY IT IS BUILT THE WAY IT IS ───────────────────────────────────────────
//
// A FLAT SUBSTRING DUMP IS NOT SEARCH. Typing "exam" and getting forty rows in
// database order, half of them from last year, is barely better than paging.
// So every hit is scored on two independent things and the sum decides:
//
//   HOW WELL IT MATCHES.  A title beats a note, a whole word beats a fragment,
//   and a match at the start of a word beats one buried in the middle. The
//   weights are set so a title match a year away still outranks a note match
//   today, because the thing you named is the thing you were looking for.
//
//   HOW SOON IT IS.       Between two equally good matches, the near one wins,
//   and the future is worth slightly more than the past. This is the half that
//   makes the list feel like it read your mind rather than your database.
//
// RECURRENCE IS THE HARD PART. A repeating item is ONE stored master with a
// rule; it has no date of its own. Showing the master alone is useless (it
// answers "when" with nothing), and expanding it is unbounded (a daily repeat
// with no end has infinitely many occurrences). So a repeat contributes the
// occurrence that matters, which is the next one from today, plus a few either
// side inside a bounded window, and reports how many more there were. See
// `expandMatch`.
//
// SPEED IS A FEATURE, NOT AN OPTIMISATION. This runs on every keystroke over a
// planner with thousands of items, on a phone. Three things keep it cheap:
//
//   1. RECURRENCE IS EXPANDED ONLY FOR ITEMS THAT ALREADY MATCHED THE TEXT.
//      Text matching is a scan over strings; expansion allocates Dates. Doing
//      the cheap filter first means a query typically expands a handful of
//      masters instead of all of them.
//   2. FOLDED TEXT IS CACHED AGAINST THE RECORD OBJECT ITSELF, in a WeakMap.
//      Records are replaced, never mutated, by the sync layer, so an entry is
//      valid exactly as long as the record is, and a record that goes away
//      takes its entry with it. The eighth keystroke folds nothing at all.
//   3. NO AGENDA IS BUILT. `buildDay` walks every item in the planner for one
//      date; asking it per day over a year is the mistake `countsForRange` was
//      written to undo, and it would be a far worse mistake here.
//
// FOLDING HAS TO WORK IN ARABIC. The planner is written in two languages. A
// search that only folds Latin accents would mean the Arabic half of the
// planner is findable only by typing the exact diacritics, which nobody does.
// So folding also strips harakat and tatweel and unifies the alef, ya and ta
// marbuta forms, which is what makes "صلاه" find "صَلاة".

import {
  occurrenceStarts,
  parseDate,
  type RecurFields,
  type WeekStartsOn,
} from './recurrence';
import { resolveEventColor, type EventCategory } from './categories';
import { GENERAL_LIST_ID, type TaskList } from './taskLists';

// ─── Public shapes ───────────────────────────────────────────────────────────

export type SearchStore = 'events' | 'tasks';

/** Which half of the planner to look in. */
export type SearchScope = 'all' | 'events' | 'tasks';

/** Completion filter. `open` hides anything already ticked off. */
export type SearchDone = 'any' | 'open' | 'done';

/** Where a hit's best match landed. Shown as a hint on the row. */
export type SearchField = 'title' | 'notes' | 'category' | 'list';

/**
 * The time buckets results are grouped into.
 *
 * Grouping is by WHEN, not by how well it matched, because "when" is the
 * question the user could not answer without this screen. Relevance still
 * decides the order inside every group, and `hits` keeps the pure relevance
 * order for anyone who wants a flat list.
 */
export type SearchBucket =
  | 'overdue'
  | 'today'
  | 'week'
  | 'later'
  | 'undated'
  | 'past'
  | 'done';

export const BUCKET_ORDER: SearchBucket[] = [
  'overdue', 'today', 'week', 'later', 'undated', 'past', 'done',
];

export const BUCKET_LABELS: Record<SearchBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'Next 7 days',
  later: 'Later',
  undated: 'Anytime',
  past: 'Earlier',
  done: 'Done',
};

/** A half-open character run inside the ORIGINAL text, for highlighting. */
export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  /** Occurrence id: `masterId::date` for a repeat, the plain id otherwise. */
  id: string;
  masterId: string;
  store: SearchStore;
  title: string;
  notes?: string;
  /** The occurrence date, or null for a task with no date at all. */
  date: string | null;
  startMin: number | null;
  endMin: number | null;
  allDay: boolean;
  repeating: boolean;
  /** How many occurrences of this series were inside the search window. */
  seriesCount: number;
  completed: boolean;
  categoryId?: string;
  categoryName?: string;
  listId?: string;
  listName?: string;
  colour?: string;
  bucket: SearchBucket;
  /** Higher is better. See the header for how the two halves combine. */
  score: number;
  /** The strongest field this hit matched on. */
  field: SearchField;
  /** Every match inside the title, for highlighting. */
  titleRanges: MatchRange[];
  /** A short window of the note around its first match, already trimmed. */
  snippet?: string;
  /** Matches inside `snippet`, indexed against the snippet, not the note. */
  snippetRanges: MatchRange[];
}

export interface SearchGroup {
  key: SearchBucket;
  label: string;
  hits: SearchHit[];
}

export interface SearchCounts {
  total: number;
  events: number;
  tasks: number;
  open: number;
  done: number;
}

export interface SearchResults {
  /** The query exactly as it was typed. */
  query: string;
  /** The folded words the query was reduced to. Empty means "nothing to do". */
  terms: string[];
  hits: SearchHit[];
  groups: SearchGroup[];
  counts: SearchCounts;
  /** True when `limit` cut the list short. `counts.total` is still the truth. */
  truncated: boolean;
  /** How many stored masters matched the text before expansion. */
  matchedItems: number;
}

export interface SearchInput {
  query: string;
  events?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
  /** Today, as `yyyy-MM-dd`. Passed in so the whole module stays pure. */
  today: string;
  weekStartsOn?: WeekStartsOn;
  categories?: EventCategory[];
  taskLists?: TaskList[];

  // ── Filters. Every one of these is "no filter" when absent. ──
  scope?: SearchScope;
  done?: SearchDone;
  /** A category id, or `null` for no filter. */
  categoryId?: string | null;
  /** A task list id, or `null` for no filter. */
  listId?: string | null;
  /** Inclusive date floor / ceiling, `yyyy-MM-dd`. An undated task passes only
   *  when neither is set, since it is not in any range. */
  from?: string | null;
  to?: string | null;

  // ── Bounds. Defaults are in SEARCH_DEFAULTS. ──
  /** How far back a repeat is expanded from today. */
  seriesPastDays?: number;
  /** How far forward a repeat is expanded from today. */
  seriesFutureDays?: number;
  /** The most occurrences one repeating master may contribute. */
  maxPerSeries?: number;
  /** The most rows returned. `counts` still reports the true totals. */
  limit?: number;
}

export const SEARCH_DEFAULTS = {
  /**
   * Ninety days back, a year forward.
   *
   * Asymmetric on purpose. A repeat you are searching for is nearly always one
   * you still have to do, and the past occurrences of a daily habit are noise
   * that would push everything else off the screen. Three months back is enough
   * to answer "when did I last" without expanding a decade of history.
   */
  seriesPastDays: 90,
  seriesFutureDays: 365,
  /**
   * Three rows per series.
   *
   * One is not enough (you often want the next two), and an unbounded list of a
   * daily repeat is the entire result screen. The row says how many more there
   * were, so nothing is hidden silently.
   */
  maxPerSeries: 3,
  limit: 200,
  /** Characters of note text kept either side of the match in a snippet. */
  snippetPad: 34,
} as const;

// ─── Folding ─────────────────────────────────────────────────────────────────

/**
 * Whether the runtime can decompose accented Latin letters.
 *
 * Hermes has shipped `normalize` for a long time, but the app also runs on
 * whatever engine a future Expo release brings, and a search box that throws is
 * worse than one that is slightly less clever. When it is missing, the explicit
 * table below covers the accented letters that actually appear in a planner.
 */
const NFD_AVAILABLE = (() => {
  try {
    return typeof ''.normalize === 'function' && 'é'.normalize('NFC').length === 1;
  } catch {
    return false;
  }
})();

/** Fallback for a runtime without `normalize`. Lowercase keys only. */
const LATIN_FALLBACK: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a', ă: 'a', ą: 'a',
  ç: 'c', ć: 'c', č: 'c',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e', ė: 'e', ę: 'e', ě: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ī: 'i', į: 'i',
  ñ: 'n', ń: 'n',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ū: 'u', ů: 'u',
  ý: 'y', ÿ: 'y',
  ž: 'z', ź: 'z', ż: 'z',
  ş: 's', ś: 's', š: 's',
  ğ: 'g', ł: 'l', ð: 'd', þ: 't',
};

/**
 * Arabic letters that are the same letter as far as anyone typing is concerned.
 *
 * Nobody types the hamza on the alef when searching, and the difference between
 * ة and ه at the end of a word is a spelling convention rather than a distinct
 * sound. Unifying them is what standard Arabic search does, and skipping it
 * means half the planner is only findable by exact transcription.
 */
const ARABIC_LETTER_FOLD: Record<string, string> = {
  'آ': 'ا', // آ
  'أ': 'ا', // أ
  'إ': 'ا', // إ
  'ٱ': 'ا', // ٱ
  'ى': 'ي', // ى → ي
  'ة': 'ه', // ة → ه
  'ؤ': 'و', // ؤ → و
  'ئ': 'ي', // ئ → ي
};

/** Harakat, sukun, shadda, superscript alef and tatweel: all dropped. */
const ARABIC_DROP = /[ً-ٰٕـۖ-ۭؐ-ؚ]/;

/** Arabic-Indic and extended Arabic-Indic digits, folded to ASCII. */
function arabicDigit(code: number): string | null {
  if (code >= 0x0660 && code <= 0x0669) return String.fromCharCode(code - 0x0660 + 48);
  if (code >= 0x06F0 && code <= 0x06F9) return String.fromCharCode(code - 0x06F0 + 48);
  return null;
}

export interface FoldedText {
  /** The folded string, which is what all matching runs against. */
  text: string;
  /**
   * For every character of `text`, the index it came from in the original.
   *
   * Highlighting is the reason this exists. Folding removes characters (a
   * harakat) and can change their count (a decomposed accent), so an offset
   * found in the folded string means nothing in the string being painted. The
   * map turns one back into the other exactly.
   */
  map: number[];
  /** True at every index that starts a word, for whole-word scoring. */
  wordStart: boolean[];
}

/**
 * Is this character a separator rather than part of a word?
 *
 * Written as an explicit range check rather than a `\p{L}` regex, which needs
 * Unicode property escapes the app's engine is not contractually obliged to
 * have. Everything that is not punctuation, whitespace or a symbol counts as a
 * word character, which is the right default for a function that has to handle
 * Arabic, Latin and digits without knowing which it is looking at.
 */
export function isSeparator(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c <= 0x2F) return true;                       // space, punctuation, digits' prefix range
  if (c >= 0x3A && c <= 0x40) return true;          // : ; < = > ? @
  if (c >= 0x5B && c <= 0x60) return true;          // [ \ ] ^ _ `
  if (c >= 0x7B && c <= 0x7E) return true;          // { | } ~
  if (c >= 0x7F && c <= 0xA9) return true;          // controls and Latin-1 symbols
  if (c >= 0xAB && c <= 0xB4) return true;
  if (c >= 0xB6 && c <= 0xB9) return true;
  if (c >= 0xBB && c <= 0xBF) return true;
  if (c >= 0x2000 && c <= 0x206F) return true;      // general punctuation, dashes, quotes
  if (c >= 0x2E00 && c <= 0x2E7F) return true;      // supplemental punctuation
  if (c >= 0x3000 && c <= 0x303F) return true;      // CJK punctuation
  if (c === 0x060C || c === 0x061B || c === 0x061F) return true; // ، ؛ ؟
  if (c === 0x066A || c === 0x066B || c === 0x066C || c === 0x066D) return true;
  return false;
}

/**
 * Lowercase, strip accents and Arabic diacritics, and remember where every
 * surviving character came from.
 */
export function fold(input: string): FoldedText {
  const out: string[] = [];
  const map: number[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const code = ch.charCodeAt(0);

    if (ARABIC_DROP.test(ch)) continue;

    const digit = arabicDigit(code);
    if (digit !== null) { out.push(digit); map.push(i); continue; }

    const arabic = ARABIC_LETTER_FOLD[ch];
    if (arabic) { out.push(arabic); map.push(i); continue; }

    let lower = ch.toLowerCase();
    if (NFD_AVAILABLE) {
      // Decompose, then drop the combining marks the decomposition produced.
      // Anything that has no decomposition passes through untouched.
      const decomposed = lower.normalize('NFD');
      let kept = '';
      for (let k = 0; k < decomposed.length; k += 1) {
        const d = decomposed.charCodeAt(k);
        if (d >= 0x0300 && d <= 0x036F) continue;
        kept += decomposed[k];
      }
      lower = kept;
    } else {
      lower = LATIN_FALLBACK[lower] ?? lower;
    }

    for (let k = 0; k < lower.length; k += 1) {
      out.push(lower[k]);
      map.push(i);
    }
  }

  const text = out.join('');
  const wordStart: boolean[] = new Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    wordStart[i] = i === 0 || isSeparator(text[i - 1]);
  }

  return { text, map, wordStart };
}

/** The folded words of a query. Punctuation-only input yields none. */
export function tokenize(query: string): string[] {
  const folded = fold(query).text;
  const terms: string[] = [];
  let current = '';
  for (let i = 0; i < folded.length; i += 1) {
    const ch = folded[i];
    if (isSeparator(ch)) {
      if (current) { terms.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) terms.push(current);
  return terms;
}

// ─── Match scoring ───────────────────────────────────────────────────────────

/**
 * What a match is worth, before the field it was found in is taken into
 * account. The gaps are wide on purpose: a whole word beating a fragment has to
 * survive being found in a lower-weighted field.
 */
const KIND_SCORE = {
  exact: 1,       // the field IS the term
  word: 0.92,     // a complete word inside the field
  prefix: 0.8,    // the start of a word
  infix: 0.45,    // somewhere in the middle of a word
} as const;

/**
 * How much each field is trusted.
 *
 * A title is what the user named the thing. A note is context they wrote for
 * themselves and matches it far more loosely, so it is worth well under half.
 * A category or list name matches every item filed under it, so it sits between
 * the two: useful for "show me everything university", never strong enough to
 * bury a real title match.
 */
const FIELD_WEIGHT: Record<SearchField, number> = {
  title: 1,
  category: 0.6,
  list: 0.55,
  notes: 0.42,
};

interface FieldMatch {
  score: number;
  ranges: MatchRange[];
}

const NO_MATCH: FieldMatch = { score: 0, ranges: [] };

/**
 * Find every occurrence of `term` in a folded field, score the best one, and
 * return the ranges of all of them mapped back onto the original string.
 *
 * Every occurrence is highlighted even though only the best one scores, because
 * a row that highlights one of three matches looks like a bug.
 */
function matchTerm(field: FoldedText, term: string): FieldMatch {
  if (!term || !field.text) return NO_MATCH;

  let best = 0;
  const ranges: MatchRange[] = [];
  let at = field.text.indexOf(term);

  while (at !== -1) {
    const end = at + term.length;
    const startsWord = field.wordStart[at];
    const endsWord = end >= field.text.length || isSeparator(field.text[end]);

    const kind = at === 0 && end === field.text.length ? KIND_SCORE.exact
      : startsWord && endsWord ? KIND_SCORE.word
      : startsWord ? KIND_SCORE.prefix
      : KIND_SCORE.infix;
    if (kind > best) best = kind;

    // Map the folded run back onto the original text. `end - 1` is used rather
    // than `end` because the map has no entry one past the last character.
    ranges.push({ start: field.map[at], end: field.map[end - 1] + 1 });

    at = field.text.indexOf(term, at + 1);
  }

  return best === 0 ? NO_MATCH : { score: best, ranges };
}

/** Merge overlapping ranges so a highlight is never painted twice. */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: MatchRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const next = sorted[i];
    if (next.start <= last.end) {
      if (next.end > last.end) out[out.length - 1] = { start: last.start, end: next.end };
    } else {
      out.push(next);
    }
  }
  return out;
}

/**
 * Split text into painted and unpainted runs.
 *
 * The screen calls this and renders one `<Text>` per run. Keeping it here means
 * the highlight can be tested without a renderer, which is the only reason the
 * off-by-one in the range mapping above was ever caught.
 */
export function splitHighlight(
  text: string,
  ranges: MatchRange[],
): Array<{ text: string; hit: boolean }> {
  const merged = mergeRanges(ranges).filter(r => r.start < r.end && r.start < text.length);
  if (!merged.length) return text ? [{ text, hit: false }] : [];

  const out: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const r of merged) {
    const start = Math.max(cursor, r.start);
    const end = Math.min(text.length, r.end);
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) out.push({ text: text.slice(start, end), hit: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

// ─── The folded-text cache ───────────────────────────────────────────────────

interface DocText {
  title: FoldedText;
  notes: FoldedText | null;
  rawTitle: string;
  rawNotes: string;
}

/**
 * Folded title and notes, keyed by the record object.
 *
 * A WeakMap and not a Map: the sync layer replaces records rather than mutating
 * them, so an entry is correct for exactly as long as its record is reachable,
 * and a deleted record's entry disappears with it. A plain Map here would be a
 * slow leak that grows with every edit for as long as the app is open.
 */
const docCache: WeakMap<object, DocText> = new WeakMap();

/** Category and list names, folded once per distinct name. */
const nameCache: Map<string, FoldedText> = new Map();

function foldName(name: string): FoldedText {
  const hit = nameCache.get(name);
  if (hit) return hit;
  const folded = fold(name);
  // Names come from a fixed, small set the user maintains by hand, so this can
  // never grow without bound the way a per-record cache could.
  if (nameCache.size < 500) nameCache.set(name, folded);
  return folded;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Events call it `content`, tasks call it `title`. Same field to a human. */
function rawTitleOf(raw: Record<string, unknown>): string {
  const content = str(raw.content).trim();
  if (content) return content;
  const title = str(raw.title).trim();
  if (title) return title;
  return 'Untitled';
}

function docOf(raw: Record<string, unknown>): DocText {
  const cached = docCache.get(raw);
  if (cached) return cached;

  const rawTitle = rawTitleOf(raw);
  const rawNotes = str(raw.notes);
  const doc: DocText = {
    title: fold(rawTitle),
    notes: rawNotes ? fold(rawNotes) : null,
    rawTitle,
    rawNotes,
  };
  docCache.set(raw, doc);
  return doc;
}

/** Only for the tests, which need to prove the cache is not doing the work. */
export function clearSearchCaches(): void {
  nameCache.clear();
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shift(date: string, days: number): string {
  const base = parseDate(date);
  return ymd(new Date(base.getFullYear(), base.getMonth(), base.getDate() + days));
}

/** Whole days from `today` to `date`. Negative is in the past. */
function daysBetween(today: string, date: string): number {
  const a = parseDate(today);
  const b = parseDate(date);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function minutesOf(time: unknown): number | null {
  if (typeof time !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is this occurrence ticked off?
 *
 * Copied in spirit from `agenda.isDone`, and the difference between the two
 * stores is not cosmetic: an event ALWAYS records completion per date, whether
 * it repeats or not, while a one-off task uses a plain boolean. Getting this
 * wrong shows a finished item as outstanding, silently.
 */
function isDone(raw: Record<string, unknown>, date: string | null, store: SearchStore): boolean {
  const dates = Array.isArray(raw.completedDates) ? (raw.completedDates as unknown[]) : null;
  const perDate = Boolean(date && dates && dates.includes(date));
  if (store === 'events') return perDate;
  if (raw.recur) return perDate;
  return raw.completed === true || perDate;
}

/**
 * Which section of the results this hit belongs in.
 *
 * Done is a bucket of its own and outranks every date bucket: a finished item
 * is findable, which is the point, but it must never sit at the top of a list
 * of things the user still has to deal with.
 */
function bucketOf(date: string | null, today: string, completed: boolean): SearchBucket {
  if (completed) return 'done';
  if (date === null) return 'undated';
  if (date < today) return daysBetween(today, date) >= -30 ? 'overdue' : 'past';
  if (date === today) return 'today';
  return daysBetween(today, date) <= 7 ? 'week' : 'later';
}

/**
 * How much being near counts for.
 *
 * A hyperbola rather than a cliff, so nothing ever falls off the list for being
 * one day too far away. The past is worth four fifths of the future at the same
 * distance, because "last Tuesday" is usually a thing you are checking and
 * "next Tuesday" is a thing you are planning. An undated task sits at a flat
 * middling value: it is not far away, it is simply not on the axis at all.
 */
function proximity(date: string | null, today: string): number {
  if (date === null) return 0.35;
  const delta = daysBetween(today, date);
  if (delta >= 0) return 1 / (1 + delta / 30);
  return 0.8 / (1 + -delta / 30);
}

/** How much the date half of the score is allowed to move things. */
const PROXIMITY_WEIGHT = 0.35;

/** A finished item is pushed down, never out. */
const DONE_PENALTY = 0.2;

// ─── Matching one stored record ──────────────────────────────────────────────

interface TextMatch {
  score: number;
  field: SearchField;
  titleRanges: MatchRange[];
  noteRanges: MatchRange[];
}

/**
 * Score one record's text against every term.
 *
 * EVERY TERM MUST MATCH SOMETHING. Typing two words and getting back everything
 * that contains either of them is how a search stops being trusted; two words
 * is the user narrowing down, so the terms are ANDed. They may land in
 * different fields, though, so "exam physics" finds an event titled "exam" in
 * the Physics category.
 */
function scoreText(
  doc: DocText,
  categoryName: FoldedText | null,
  listName: FoldedText | null,
  terms: string[],
  wholeQuery: string,
): TextMatch | null {
  let total = 0;
  let bestField: SearchField = 'notes';
  let bestFieldScore = -1;
  let allInTitle = true;
  const titleRanges: MatchRange[] = [];
  const noteRanges: MatchRange[] = [];

  for (const term of terms) {
    const inTitle = matchTerm(doc.title, term);
    const inNotes = doc.notes ? matchTerm(doc.notes, term) : NO_MATCH;
    const inCategory = categoryName ? matchTerm(categoryName, term) : NO_MATCH;
    const inList = listName ? matchTerm(listName, term) : NO_MATCH;

    const candidates: Array<[SearchField, FieldMatch]> = [
      ['title', inTitle],
      ['category', inCategory],
      ['list', inList],
      ['notes', inNotes],
    ];

    let termScore = 0;
    let termField: SearchField = 'notes';
    for (const [field, match] of candidates) {
      if (match.score === 0) continue;
      const weighted = match.score * FIELD_WEIGHT[field];
      if (weighted > termScore) { termScore = weighted; termField = field; }
    }
    if (termScore === 0) return null; // one term unmatched is no hit at all

    if (inTitle.score > 0) titleRanges.push(...inTitle.ranges);
    else allInTitle = false;
    if (inNotes.score > 0) noteRanges.push(...inNotes.ranges);

    total += termScore;
    if (termScore > bestFieldScore) { bestFieldScore = termScore; bestField = termField; }
  }

  let score = total / terms.length;

  // Two small coherence bonuses. Both reward the item that reads like the thing
  // the user had in mind rather than one that merely contains the same letters
  // scattered across two different fields.
  if (allInTitle && terms.length > 1) score += 0.08;
  if (terms.length > 1 && doc.title.text.indexOf(wholeQuery) !== -1) score += 0.15;

  return { score, field: bestField, titleRanges, noteRanges };
}

/**
 * A short window of the note around its first match.
 *
 * A note can be a paragraph. Showing all of it turns every result row into a
 * wall of text; showing none of it means a note match gives no reason for why
 * the row is there. So the note is cut around the match, with an ellipsis on
 * whichever side was cut, and the ranges are re-indexed against the cut string.
 */
function makeSnippet(
  notes: string,
  ranges: MatchRange[],
  pad: number,
): { snippet: string; snippetRanges: MatchRange[] } {
  const merged = mergeRanges(ranges);
  if (!merged.length) return { snippet: '', snippetRanges: [] };

  const first = merged[0];
  const start = Math.max(0, first.start - pad);
  const end = Math.min(notes.length, first.end + pad * 2);
  const head = start > 0 ? '…' : '';
  const tail = end < notes.length ? '…' : '';
  // A note is often several lines; a snippet is one line, so newlines collapse.
  const body = notes.slice(start, end).replace(/\s+/g, ' ');

  // Collapsing whitespace can shift offsets, so the ranges are recomputed
  // against the finished snippet rather than arithmetic on the original ones.
  const snippet = `${head}${body}${tail}`;
  const offset = head.length;
  const shifted: MatchRange[] = [];
  for (const r of merged) {
    if (r.end <= start || r.start >= end) continue;
    // The slice's own coordinates, then nudged by any whitespace collapsed
    // before the match. Counting is cheap here: a snippet is under 120 chars.
    const rawBefore = notes.slice(start, Math.max(start, r.start));
    const collapsedBefore = rawBefore.replace(/\s+/g, ' ').length;
    const length = notes.slice(Math.max(start, r.start), Math.min(end, r.end))
      .replace(/\s+/g, ' ').length;
    shifted.push({
      start: offset + collapsedBefore,
      end: offset + collapsedBefore + length,
    });
  }
  return { snippet, snippetRanges: shifted };
}

// ─── Occurrence expansion ────────────────────────────────────────────────────

interface Occurrence {
  date: string | null;
  /** How many occurrences of the series were inside the window. */
  seriesCount: number;
  /** How far ahead the window that produced `seriesCount` actually reached. */
  horizonDays?: number;
}

/**
 * The dates a matching record should appear on.
 *
 * ONE-OFFS are a single date and are never windowed: an appointment three years
 * out is exactly the kind of thing this screen exists to find, and it costs
 * nothing to include.
 *
 * REPEATS are bounded twice over. The forward expansion runs from today to the
 * horizon and the backward one from the floor to today, so a rule with no end
 * produces a finite list, and only the first few of the forward run plus the
 * single most recent past one survive. The full count is reported so the row
 * can say what was left out.
 */
/**
 * Expanded occurrences, cached against the record object.
 *
 * The same trick as the folded text above, and for a much larger prize. Walking
 * a recurrence rule is the single most expensive thing this file does: the
 * shared engine expands from the series anchor every time it is asked, so a
 * habit that started a year ago costs a year of iteration to answer "when is the
 * next one". Doing that again for every keystroke of the same word is pure
 * waste, because the answer cannot change while the record and the date stay the
 * same.
 *
 * The key covers everything the answer depends on besides the record itself, so
 * midnight, a changed week start, or a caller asking for a wider window all miss
 * the cache rather than reading a stale answer out of it. A record is allowed at
 * most a couple of entries: the results and the preview ask with different
 * bounds, and without a bound the two would evict each other forever.
 */
const occCache: WeakMap<object, Map<string, Occurrence[]>> = new WeakMap();

function expandUncached(
  raw: Record<string, unknown>,
  today: string,
  weekStartsOn: WeekStartsOn,
  opts: { pastDays: number; futureDays: number; maxPerSeries: number },
): Occurrence[] {
  const rec = raw as unknown as RecurFields;

  // An anchor that is not a real date is treated as no anchor at all. A record
  // that arrived from a half-written sync would otherwise crash the whole search
  // on a keystroke, which is a spectacular way to lose a feature to one bad row.
  const anchored = typeof rec.weekKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.weekKey);
  if (!anchored) return [{ date: null, seriesCount: 1 }]; // an undated task

  if (!rec.recur) {
    const anchor = parseDate(rec.weekKey as string);
    const offset = typeof rec.dayIndex === 'number' && Number.isFinite(rec.dayIndex) ? rec.dayIndex : 0;
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset);
    return [{ date: ymd(start), seriesCount: 1 }];
  }

  // ONE expansion, not two.
  //
  // The range is walked from the series anchor every time (that is how
  // `occurrenceStarts` works, and re-implementing it here would be exactly the
  // drift between the phone and the PC that the shared-engine rule exists to
  // prevent), so asking twice costs twice. One call over the whole window, split
  // at today afterwards, is the same answer for half the work.
  //
  // The horizon is also reached in stages. A daily or weekly repeat has its next
  // occurrence within days, so the wide window is only ever paid for by the
  // sparse rules (monthly, yearly, "every 6 weeks") whose expansions are tiny
  // anyway. On the synthetic planner this alone was worth more than half the
  // time the search was spending.
  const todayDate = parseDate(today);
  const floor = parseDate(shift(today, -opts.pastDays));

  let all: Date[] = [];
  let horizonDays = 0;
  for (const stage of [Math.min(31, opts.futureDays), Math.min(120, opts.futureDays), opts.futureDays]) {
    horizonDays = stage;
    const horizon = parseDate(shift(today, stage + 1)); // exclusive
    all = occurrenceStarts(rec, floor, horizon, weekStartsOn);
    // Stop as soon as the window holds something still to come. A window with
    // only past occurrences in it may simply be too short.
    if (all.length && ymd(all[all.length - 1]) >= today) break;
    if (stage >= opts.futureDays) break;
  }
  if (!all.length) return [];

  const dates: string[] = [];
  let firstFutureIdx = all.length;
  for (let i = 0; i < all.length; i += 1) {
    if (ymd(all[i]) >= today) { firstFutureIdx = i; break; }
  }
  const pastCount = firstFutureIdx;
  const futureCount = all.length - firstFutureIdx;
  const seriesCount = all.length;

  // The most recent past occurrence, so "when was the last one" is answerable
  // without paging backwards, but only ever one of them, and never at the cost
  // of the next one. THE NEXT OCCURRENCE IS THE ANSWER the user came for: a
  // budget of one row spends it forwards, and only a series with no future left
  // spends it backwards.
  const takesPastSlot = pastCount > 0 && (opts.maxPerSeries > 1 || futureCount === 0);
  const forwardSlots = Math.max(1, opts.maxPerSeries - (takesPastSlot ? 1 : 0));

  if (takesPastSlot) dates.push(ymd(all[firstFutureIdx - 1]));
  for (let i = 0; i < futureCount && i < forwardSlots; i += 1) {
    dates.push(ymd(all[firstFutureIdx + i]));
  }

  return dates.map(date => ({ date, seriesCount, horizonDays }));
}

function expandMatch(
  raw: Record<string, unknown>,
  today: string,
  weekStartsOn: WeekStartsOn,
  opts: { pastDays: number; futureDays: number; maxPerSeries: number },
): Occurrence[] {
  const key = `${today}|${weekStartsOn}|${opts.pastDays}|${opts.futureDays}|${opts.maxPerSeries}`;
  let per = occCache.get(raw);
  if (per) {
    const hit = per.get(key);
    if (hit) return hit;
    // Two shapes of question is all any one record is ever asked, so anything
    // beyond that is a sign the key changed (a new day) and the old answers are
    // dead weight rather than a cache.
    if (per.size >= 2) per.clear();
  } else {
    per = new Map();
    occCache.set(raw, per);
  }
  const occ = expandUncached(raw, today, weekStartsOn, opts);
  per.set(key, occ);
  return occ;
}

// ─── The search itself ───────────────────────────────────────────────────────

/**
 * Total, stable ordering.
 *
 * Score decides, then nearness, then the date itself, then the title, then the
 * id. The last two exist so two items with the same name on the same day cannot
 * swap places between keystrokes: an id is unique, so the comparator can never
 * return 0 for two different rows, which is what makes the order a total one
 * rather than whatever the sort happened to do this time.
 */
function compareHits(a: SearchHit, b: SearchHit, today: string): number {
  if (a.score !== b.score) return b.score - a.score;

  const da = a.date === null ? Number.MAX_SAFE_INTEGER : Math.abs(daysBetween(today, a.date));
  const db = b.date === null ? Number.MAX_SAFE_INTEGER : Math.abs(daysBetween(today, b.date));
  if (da !== db) return da - db;

  const ka = a.date ?? '￿';
  const kb = b.date ?? '￿';
  if (ka !== kb) return ka < kb ? -1 : 1;

  const sa = a.startMin ?? Number.POSITIVE_INFINITY;
  const sb = b.startMin ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa - sb;

  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const EMPTY_COUNTS: SearchCounts = { total: 0, events: 0, tasks: 0, open: 0, done: 0 };

function emptyResults(query: string, terms: string[]): SearchResults {
  return {
    query,
    terms,
    hits: [],
    groups: [],
    counts: { ...EMPTY_COUNTS },
    truncated: false,
    matchedItems: 0,
  };
}

/**
 * The most stored items one search will date.
 *
 * A one-letter query matches nearly everything, and dating everything means
 * expanding every recurrence rule in the planner on a keystroke. The text score
 * of every match is already known before any of that work happens, so the
 * matches are dated in descending order of how well they matched and the tail is
 * left undated rather than made slow. The budget is many times the number of
 * rows anyone will ever scroll, so this can only ever discard rows that would
 * have been far below the fold, and `matchedItems` still reports the real total
 * so the screen never lies about how much it found.
 */
const EXPAND_BUDGET = 600;

/** One record that matched the text, before it has been given any dates. */
interface Candidate {
  id: string;
  raw: Record<string, unknown>;
  store: SearchStore;
  match: TextMatch;
  doc: DocText;
  categoryId?: string;
  categoryName?: string;
  listId?: string;
  listName?: string;
}

/**
 * Search the whole planner.
 *
 * Cheap enough to call on every keystroke: see the note at the top of the file
 * for the things that make that true.
 */
export function searchPlanner(input: SearchInput): SearchResults {
  const terms = tokenize(input.query);
  if (!terms.length) return emptyResults(input.query, terms);

  const wholeQuery = terms.join(' ');
  const today = input.today;
  const weekStartsOn = (input.weekStartsOn ?? 0) as WeekStartsOn;
  const scope: SearchScope = input.scope ?? 'all';
  const doneFilter: SearchDone = input.done ?? 'any';
  const limit = input.limit ?? SEARCH_DEFAULTS.limit;

  const bounds = {
    pastDays: input.seriesPastDays ?? SEARCH_DEFAULTS.seriesPastDays,
    futureDays: input.seriesFutureDays ?? SEARCH_DEFAULTS.seriesFutureDays,
    maxPerSeries: Math.max(1, input.maxPerSeries ?? SEARCH_DEFAULTS.maxPerSeries),
  };

  const categories = input.categories ?? [];
  const lists = input.taskLists ?? [];
  const categoryById = new Map(categories.map(c => [c.id, c]));
  const listById = new Map(lists.map(l => [l.id, l]));

  // -- Phase one: who matches. Strings only, no dates, nothing per day. --
  const candidates: Candidate[] = [];

  const scan = (
    store: SearchStore,
    records: Record<string, Record<string, unknown>> | null | undefined,
  ) => {
    if (!records) return;
    if (scope !== 'all' && scope !== store) return;

    for (const id of Object.keys(records)) {
      const raw = records[id];
      if (!raw || typeof raw !== 'object') continue;
      if (raw.deleted === true) continue;
      // A leaked occurrence record would re-expand into phantom duplicates, the
      // same way `resolveWeek` guards against it.
      if (id.indexOf('::') !== -1) continue;

      const categoryId = str(raw.categoryId) || undefined;
      if (input.categoryId && categoryId !== input.categoryId) continue;

      const listId = store === 'tasks' ? (str(raw.listId) || GENERAL_LIST_ID) : undefined;
      if (input.listId && listId !== input.listId) continue;

      const category = categoryId ? categoryById.get(categoryId) : undefined;
      const list = listId ? listById.get(listId) : undefined;

      const doc = docOf(raw);
      const match = scoreText(
        doc,
        category?.name ? foldName(category.name) : null,
        list?.name ? foldName(list.name) : null,
        terms,
        wholeQuery,
      );
      if (!match) continue;

      candidates.push({
        id, raw, store, match, doc,
        categoryId,
        categoryName: category?.name,
        listId,
        listName: list?.name,
      });
    }
  };

  scan('events', input.events);
  scan('tasks', input.tasks);

  const matchedItems = candidates.length;

  // Best text match first, so the budget below is always spent on the rows the
  // user is most likely to be looking at. The id tiebreak keeps this a total
  // order, which is what stops the budget cutting a different tail each time the
  // same query is run.
  candidates.sort((a, b) => b.match.score - a.match.score
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // -- Phase two: dating. This is the expensive half, so it is bounded. --
  const hits: SearchHit[] = [];
  const budget = Math.min(candidates.length, EXPAND_BUDGET);

  for (let c = 0; c < budget; c += 1) {
    const cand = candidates[c];
    const { raw, id, store, match, doc } = cand;

    const occurrences = expandMatch(raw, today, weekStartsOn, bounds);
    if (!occurrences.length) continue;

    const allDay = raw.allDay === true;
    const startMin = allDay ? null : minutesOf(raw.startTime);
    const endMin = allDay ? null : minutesOf(raw.endTime);
    const repeating = Boolean(raw.recur);
    const colour = resolveEventColor(
      {
        color: str(raw.color) || undefined,
        categoryId: cand.categoryId,
        gCalHex: str(raw.gCalHex) || undefined,
      },
      categories,
    ) || undefined;
    const snippet = match.noteRanges.length
      ? makeSnippet(doc.rawNotes, match.noteRanges, SEARCH_DEFAULTS.snippetPad)
      : null;
    const titleRanges = mergeRanges(match.titleRanges);

    for (const occ of occurrences) {
      if (occ.date !== null) {
        if (input.from && occ.date < input.from) continue;
        if (input.to && occ.date > input.to) continue;
      } else if (input.from || input.to) {
        // An undated task is not in any range, so an explicit range excludes it
        // rather than silently keeping it at the top of every result.
        continue;
      }

      const completed = isDone(raw, occ.date, store);
      if (doneFilter === 'open' && completed) continue;
      if (doneFilter === 'done' && !completed) continue;

      hits.push({
        id: repeating && occ.date ? `${id}::${occ.date}` : id,
        masterId: id,
        store,
        title: doc.rawTitle,
        notes: doc.rawNotes || undefined,
        date: occ.date,
        startMin,
        endMin,
        allDay,
        repeating,
        seriesCount: occ.seriesCount,
        completed,
        categoryId: cand.categoryId,
        categoryName: cand.categoryName,
        listId: cand.listId,
        listName: cand.listName,
        colour,
        bucket: bucketOf(occ.date, today, completed),
        score: match.score
          + PROXIMITY_WEIGHT * proximity(occ.date, today)
          - (completed ? DONE_PENALTY : 0),
        field: match.field,
        titleRanges,
        snippet: snippet?.snippet || undefined,
        snippetRanges: snippet?.snippetRanges ?? [],
      });
    }
  }

  hits.sort((a, b) => compareHits(a, b, today));

  let events = 0;
  let tasks = 0;
  let done = 0;
  for (const h of hits) {
    if (h.store === 'events') events += 1; else tasks += 1;
    if (h.completed) done += 1;
  }
  const counts: SearchCounts = {
    total: hits.length,
    events,
    tasks,
    open: hits.length - done,
    done,
  };

  const truncated = hits.length > limit || budget < candidates.length;
  const shown = truncated ? hits.slice(0, limit) : hits;

  const byBucket = new Map<SearchBucket, SearchHit[]>();
  for (const hit of shown) {
    const inBucket = byBucket.get(hit.bucket);
    if (inBucket) inBucket.push(hit); else byBucket.set(hit.bucket, [hit]);
  }
  const groups: SearchGroup[] = [];
  for (const key of BUCKET_ORDER) {
    const inBucket = byBucket.get(key);
    if (inBucket && inBucket.length) {
      groups.push({ key, label: BUCKET_LABELS[key], hits: inBucket });
    }
  }

  return { query: input.query, terms, hits: shown, groups, counts, truncated, matchedItems };
}

// ─── The screen before anything is typed ─────────────────────────────────────

export interface PreviewInput {
  events?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
  today: string;
  weekStartsOn?: WeekStartsOn;
  categories?: EventCategory[];
  taskLists?: TaskList[];
  /** How many days ahead "coming up" reaches. */
  aheadDays?: number;
  /** Rows per section. */
  limit?: number;
}

export interface SearchPreview {
  /** The next few things due, soonest first. */
  upcoming: SearchHit[];
  /** What was edited most recently, newest first. */
  recent: SearchHit[];
  /** Category ids that actually appear in the planner, most used first. */
  activeCategoryIds: string[];
}

/**
 * What to show while the box is still empty.
 *
 * A blank search screen wastes the most valuable moment there is: the user has
 * already decided they are looking for something and has not yet said what. The
 * two lists here answer the two most likely intentions without a keystroke,
 * which is "what is next" and "what was I just doing".
 *
 * It reuses the same expansion and scoring plumbing, with no terms, so a row in
 * the preview is the exact same shape as a row in the results and the screen
 * has one row component rather than three.
 */
export function searchPreview(input: PreviewInput): SearchPreview {
  const today = input.today;
  const aheadDays = input.aheadDays ?? 14;
  const limit = input.limit ?? 6;
  const weekStartsOn = (input.weekStartsOn ?? 0) as WeekStartsOn;
  const categories = input.categories ?? [];
  const lists = input.taskLists ?? [];
  const categoryById = new Map(categories.map(c => [c.id, c]));
  const listById = new Map(lists.map(l => [l.id, l]));
  const to = shift(today, aheadDays);

  const upcoming: SearchHit[] = [];
  const recent: Array<{ hit: SearchHit; updatedAt: number }> = [];
  const categoryUse = new Map<string, number>();

  const bounds = { pastDays: 0, futureDays: aheadDays, maxPerSeries: 1 };

  const scan = (store: SearchStore, records: Record<string, Record<string, unknown>> | null | undefined) => {
    if (!records) return;
    for (const id of Object.keys(records)) {
      const raw = records[id];
      if (!raw || typeof raw !== 'object') continue;
      if (raw.deleted === true) continue;
      if (id.indexOf('::') !== -1) continue;

      const categoryId = str(raw.categoryId) || undefined;
      if (categoryId) categoryUse.set(categoryId, (categoryUse.get(categoryId) ?? 0) + 1);

      const listId = store === 'tasks' ? (str(raw.listId) || GENERAL_LIST_ID) : undefined;
      const category = categoryId ? categoryById.get(categoryId) : undefined;
      const list = listId ? listById.get(listId) : undefined;
      const doc = docOf(raw);
      const allDay = raw.allDay === true;
      const repeating = Boolean(raw.recur);

      const build = (date: string | null, seriesCount: number): SearchHit => {
        const completed = isDone(raw, date, store);
        return {
          id: repeating && date ? `${id}::${date}` : id,
          masterId: id,
          store,
          title: doc.rawTitle,
          notes: doc.rawNotes || undefined,
          date,
          startMin: allDay ? null : minutesOf(raw.startTime),
          endMin: allDay ? null : minutesOf(raw.endTime),
          allDay,
          repeating,
          seriesCount,
          completed,
          categoryId,
          categoryName: category?.name,
          listId,
          listName: list?.name,
          colour: resolveEventColor(
            { color: str(raw.color) || undefined, categoryId, gCalHex: str(raw.gCalHex) || undefined },
            categories,
          ) || undefined,
          bucket: bucketOf(date, today, completed),
          score: proximity(date, today),
          field: 'title',
          titleRanges: [],
          snippet: undefined,
          snippetRanges: [],
        };
      };

      const occurrences = expandMatch(raw, today, weekStartsOn, bounds);
      for (const occ of occurrences) {
        if (occ.date === null) continue;
        if (occ.date < today || occ.date > to) continue;
        const hit = build(occ.date, occ.seriesCount);
        if (!hit.completed) upcoming.push(hit);
      }

      const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
      if (updatedAt > 0) {
        const first = occurrences[0];
        recent.push({ hit: build(first ? first.date : null, first ? first.seriesCount : 1), updatedAt });
      }
    }
  };

  scan('events', input.events);
  scan('tasks', input.tasks);

  upcoming.sort((a, b) => compareHits(a, b, today));
  // Newest first, with the id as the tiebreak so two items saved in the same
  // millisecond (which a bulk sync does constantly) never trade places.
  recent.sort((a, b) => b.updatedAt - a.updatedAt
    || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0));

  const activeCategoryIds = [...categoryUse.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);

  return {
    upcoming: upcoming.slice(0, limit),
    recent: recent.slice(0, limit).map(r => r.hit),
    activeCategoryIds,
  };
}
