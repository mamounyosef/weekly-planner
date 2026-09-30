// ─── Planner agent: turning change sets into a readable report ───────────────
//
// Pure. Shared by the PC/browser panel and the Android app (copied into
// mobile/src/lib/agent/). The report is rendered from ChangeSets, which are
// built by code from the records actually written and read back, never from
// the model's text. This file only decides WORDING and GROUPING.

import type { ChangeEntry, ChangeSet, ItemFacts } from './agentTypes';

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parse(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function shortDate(date: string): string {
  const d = parse(date);
  return `${SHORT_DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
}

/** "Friday, 9 Oct", with the year only when it is not the current one. */
export function dayHeading(date: string, now = new Date()): string {
  const d = parse(date);
  const y = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${LONG_DAY[d.getDay()]}, ${d.getDate()} ${MONTH[d.getMonth()]}${y}`;
}

export function clockLabel(hhmm: string, fmt: '12h' | '24h'): string {
  if (fmt === '24h') return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** The time part only: "9:30 AM to 10:15 AM", "1:00 PM (moment)", "All day". */
export function timeLabel(f: ItemFacts, fmt: '12h' | '24h'): string {
  if (f.allDay) {
    return f.endDate ? `All day, until ${shortDate(f.endDate)}` : 'All day';
  }
  if (!f.startTime) return f.kind === 'task' ? (f.date ? 'Any time that day' : 'No date') : '';
  if (f.pointInTime || !f.endTime) return clockLabel(f.startTime, fmt);
  return `${clockLabel(f.startTime, fmt)} to ${clockLabel(f.endTime, fmt)}${f.overnight ? ' (next day)' : ''}`;
}

/** Date and time together: "Fri 9 Oct, 9:30 AM to 10:15 AM". */
export function whenText(f: ItemFacts, fmt: '12h' | '24h'): string {
  if (!f.date) return 'No date';
  const t = timeLabel(f, fmt);
  return t ? `${shortDate(f.date)}, ${t}` : shortDate(f.date);
}

export type Tone = 'added' | 'updated' | 'deleted' | 'done' | 'skipped' | 'failed';

export const ACTION_WORD: Record<ChangeEntry['action'], { word: string; tone: Tone }> = {
  added: { word: 'Added', tone: 'added' },
  updated: { word: 'Changed', tone: 'updated' },
  deleted: { word: 'Deleted', tone: 'deleted' },
  completed: { word: 'Ticked off', tone: 'done' },
  reopened: { word: 'Un-ticked', tone: 'updated' },
  skipped: { word: 'Already there', tone: 'skipped' },
  failed: { word: 'Not done', tone: 'failed' },
};

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  date: 'Date',
  endDate: 'Last day',
  startTime: 'Starts',
  endTime: 'Ends',
  allDay: 'All day',
  pointInTime: 'Moment (no end)',
  overnight: 'Ends next day',
  category: 'Category',
  color: 'Colour',
  list: 'List',
  repeats: 'Repeats',
  reminders: 'Reminders',
  checkbox: 'Checkbox',
  done: 'Done',
  notes: 'Notes',
};

export interface FieldDiff { field: string; label: string; before: string; after: string }

function fieldValue(f: ItemFacts | undefined, field: string, fmt: '12h' | '24h'): string {
  if (!f) return '';
  const v = (f as unknown as Record<string, unknown>)[field];
  if (v === undefined || v === null || v === '') {
    if (field === 'category' || field === 'list') return 'None';
    if (field === 'repeats') return "Doesn't repeat";
    if (field === 'reminders') return 'Default';
    if (field === 'endTime') return f.pointInTime ? 'No end' : 'None';
    if (field === 'date') return 'No date';
    if (typeof v === 'boolean' || field === 'allDay' || field === 'pointInTime' || field === 'overnight' || field === 'done') return 'No';
    return 'None';
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if ((field === 'startTime' || field === 'endTime') && typeof v === 'string') return clockLabel(v, fmt);
  if ((field === 'date' || field === 'endDate') && typeof v === 'string') return shortDate(v);
  return String(v);
}

/** The before/after rows for an update, skipping pure bookkeeping fields. */
export function diffsOf(entry: ChangeEntry, fmt: '12h' | '24h'): FieldDiff[] {
  if (entry.action === 'added' || entry.action === 'deleted' || entry.action === 'skipped' || entry.action === 'failed') return [];
  const fields = (entry.changed ?? []).filter(f => f !== 'kind' && f !== 'color' && f !== 'overnight');
  return fields.map(field => ({
    field,
    label: FIELD_LABEL[field] ?? field,
    before: fieldValue(entry.before, field, fmt),
    after: fieldValue(entry.after, field, fmt),
  })).filter(d => d.before !== d.after);
}

/** Small descriptive chips shown under an item. */
export function chipsOf(f: ItemFacts | undefined): Array<{ label: string; color?: string }> {
  if (!f) return [];
  const out: Array<{ label: string; color?: string }> = [];
  if (f.category) out.push({ label: f.category, color: f.color });
  if (f.list) out.push({ label: f.list });
  if (f.repeats) out.push({ label: f.repeats });
  if (f.reminders) out.push({ label: `Reminders: ${f.reminders}` });
  if (f.kind === 'event' && f.checkbox === false) out.push({ label: 'No checkbox' });
  return out;
}

export interface ReportRow {
  key: string;
  entry: ChangeEntry;
  facts: ItemFacts | undefined;
  word: string;
  tone: Tone;
  time: string;
  chips: Array<{ label: string; color?: string }>;
  diffs: FieldDiff[];
}

export interface ReportGroup { date: string | null; heading: string; rows: ReportRow[] }

export interface ReportSummary {
  /** e.g. "7 events added, 1 already there" */
  headline: string;
  counts: Partial<Record<ChangeEntry['action'], number>>;
  unverified: number;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function summarize(sets: ChangeSet[]): ReportSummary {
  const counts: Partial<Record<ChangeEntry['action'], number>> = {};
  const kinds: Record<string, Set<'event' | 'task'>> = {};
  let unverified = 0;
  for (const s of sets) for (const e of s.entries) {
    counts[e.action] = (counts[e.action] ?? 0) + 1;
    (kinds[e.action] ??= new Set()).add(e.kind);
    if (!e.verified && e.action !== 'failed' && e.action !== 'skipped') unverified++;
  }
  const noun = (a: string, n: number) => {
    const k = kinds[a];
    if (!k || k.size !== 1) return plural(n, 'item');
    return plural(n, k.has('event') ? 'event' : 'task');
  };
  const parts: string[] = [];
  const order: Array<[ChangeEntry['action'], string]> = [
    ['added', 'added'], ['updated', 'changed'], ['completed', 'ticked off'], ['reopened', 'un-ticked'],
    ['deleted', 'deleted'], ['skipped', 'already there'], ['failed', 'not done'],
  ];
  for (const [a, verb] of order) {
    const n = counts[a];
    if (n) parts.push(`${noun(a, n)} ${verb}`);
  }
  return { headline: parts.join(', ') || 'No changes', counts, unverified };
}

/**
 * Rows grouped by day, days in order, "No date" last. Within a day: all-day
 * first, then by start time, then by title, so the card reads like the
 * calendar it describes.
 */
export function buildReport(sets: ChangeSet[], fmt: '12h' | '24h', now = new Date()): ReportGroup[] {
  const rows: ReportRow[] = [];
  for (const s of sets) {
    s.entries.forEach((entry, i) => {
      const facts = entry.after ?? entry.before;
      const { word, tone } = ACTION_WORD[entry.action];
      rows.push({
        key: `${s.id}:${i}`,
        entry,
        facts,
        word,
        tone,
        time: facts ? timeLabel(facts, fmt) : '',
        chips: chipsOf(facts),
        diffs: diffsOf(entry, fmt),
      });
    });
  }
  const groups = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = r.facts?.date ?? '';
    const list = groups.get(k);
    if (list) list.push(r); else groups.set(k, [r]);
  }
  const keyOf = (r: ReportRow) => `${r.facts?.allDay ? '0' : '1'}|${r.facts?.startTime ?? '99:99'}|${r.facts?.title ?? ''}`;
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([date, list]) => ({
      date: date || null,
      heading: date ? dayHeading(date, now) : 'No date',
      rows: list.sort((x, y) => keyOf(x).localeCompare(keyOf(y))),
    }));
}

/** A plain-text version, for copying or sharing. */
export function reportAsText(sets: ChangeSet[], fmt: '12h' | '24h', now = new Date()): string {
  const lines: string[] = [summarize(sets).headline];
  for (const g of buildReport(sets, fmt, now)) {
    lines.push('', g.heading);
    for (const r of g.rows) {
      const t = r.time ? `${r.time}  ` : '';
      lines.push(`  ${r.word}: ${t}${r.facts?.title ?? ''}`);
      for (const d of r.diffs) lines.push(`      ${d.label}: ${d.before} -> ${d.after}`);
      if (r.entry.note) lines.push(`      ${r.entry.note}`);
    }
  }
  return lines.join('\n');
}
