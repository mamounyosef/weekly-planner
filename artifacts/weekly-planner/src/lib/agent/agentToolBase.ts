// ─── Planner agent: helpers shared by every tool module ─────────────────────
//
// Pure, no imports of the tool modules themselves, so `agentTools.ts` and
// `agentPlannerTools.ts` can both use them without an import cycle.

import { format } from 'date-fns';

import { parseDate } from '../recurrence';
import type { NotifySpec } from '../notifications';

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A refusal the model is told about. Nothing was changed when one is thrown. */
export class ToolError extends Error {}
export const fail = (msg: string): never => { throw new ToolError(msg); };

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A strict, real calendar date. "2026-02-30" is refused rather than rolled over. */
export function parseYmdStrict(raw: unknown, field: string): string {
  if (typeof raw !== 'string') fail(`${field} must be a date string YYYY-MM-DD.`);
  const s = (raw as string).trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) fail(`${field} "${raw}" is not a date in YYYY-MM-DD form.`);
  const [y, mo, d] = [Number(m![1]), Number(m![2]), Number(m![3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) fail(`${field} "${raw}" is not a real date.`);
  if (y < 1970 || y > 2200) fail(`${field} "${raw}" is out of range.`);
  return s;
}

/** JSON with sorted keys and no undefined values: equal meaning, equal string. */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (isRecord(val)
    ? Object.fromEntries(Object.keys(val).sort().filter(k => val[k] !== undefined).map(k => [k, val[k]]))
    : val));
}

/** Strip undefined so a stored record never carries `"x": undefined` keys. */
export function clean<T extends object>(r: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(r)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Fri 9 Oct" */
export function dayLabel(date: string): string {
  const d = parseDate(date);
  return `${SHORT_DAY[d.getDay()]} ${d.getDate()} ${format(d, 'MMM')}`;
}

/** undefined = not given; 'inherit' = back to the default (leave absent). */
export function parseReminders(raw: unknown): NotifySpec | undefined | 'inherit' {
  if (raw === undefined) return undefined;
  if (raw === null || raw === 'default' || raw === 'inherit') return 'inherit';
  if (raw === 'off' || raw === false) return { enabled: false, rules: [], priority: 'normal' };
  if (!isRecord(raw)) fail('reminders must be "default", "off", or {"minutesBefore":[30,1440],"critical":false}.');
  const r = raw as Record<string, unknown>;
  const mode = r.mode == null ? 'custom' : String(r.mode);
  if (mode === 'default' || mode === 'inherit') return 'inherit';
  if (mode === 'off') return { enabled: false, rules: [], priority: 'normal' };
  const list = r.minutesBefore == null ? [0] : r.minutesBefore;
  if (!Array.isArray(list) || !list.length) fail('reminders.minutesBefore must be a non-empty list of minutes, e.g. [0, 30].');
  const mins = [...new Set((list as unknown[]).map(v => Math.round(Number(v))))];
  if (mins.some(m => !Number.isFinite(m) || m < -1440 || m > 60 * 24 * 60)) fail('reminders.minutesBefore values must be minutes before the start (0 = at the time).');
  mins.sort((a, b) => b - a);
  return {
    enabled: true,
    // `0 - m`, not `-m`: negating 0 gives -0, which is a different JSON value
    // to a deep compare and reads as a change to a spec nobody changed.
    rules: mins.map((m, i) => ({ id: `r${i}`, offsetMin: 0 - m })),
    priority: r.critical === true ? 'critical' : 'normal',
  };
}

/** "30 min before, at the time (critical)"; undefined when the spec inherits. */
export function remindersLabel(spec: NotifySpec | undefined): string | undefined {
  if (!spec) return undefined; // inherits: say nothing rather than guess
  if (!spec.enabled || !spec.rules.length) return 'Off';
  const parts = [...spec.rules].sort((a, b) => a.offsetMin - b.offsetMin).map(r => {
    if (r.offsetMin === 0) return 'at the time';
    const m = Math.abs(r.offsetMin);
    const unit = m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? '' : 's'}`
      : m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}`
      : `${m} min`;
    return `${unit} ${r.offsetMin < 0 ? 'before' : 'after'}`;
  });
  return parts.join(', ') + (spec.priority === 'critical' ? ' (critical)' : '');
}

/** "1h 30m", "45m". */
export function minutesLabel(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
