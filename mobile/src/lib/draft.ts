// ─── Building a planner record from what someone typed ───────────────────────
// The phone can now create and edit items, which means it has to produce records
// the PC will accept without ever having seen the PC's editor. Everything that
// decides the SHAPE of a record lives here, pure and tested, so the screen only
// has to collect text.
//
// WHY THIS IS NOT INLINE IN THE SCREEN
// A record the PC cannot place is not a visible error — it syncs perfectly and
// then sits in the wrong week, or on no day at all. That failure looks exactly
// like sync being broken, which this project has had quite enough of.

import { parseDate, weekKeyOf, type Recurrence, type WeekStartsOn } from './recurrence';
import type { EventCategory } from './categories';
import { offsetLabel, type NotifySpec } from './notifications';

/** Minutes from midnight → "HH:MM". */
export function toTimeString(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "HH:MM" → minutes from midnight, or null if it is not a time. */
export function fromTimeString(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ymdOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Which weekday the user's weeks start on, worked out from their own data.
 *
 * WHY IT IS INFERRED RATHER THAN ASSUMED. An item is stored as a week anchor
 * plus an offset (`weekKey` + `dayIndex`), so writing the wrong anchor puts a
 * Saturday item in the wrong COLUMN of the PC's week grid even though the date
 * it resolves to is right. The setting lives in settings.json, which the phone
 * does not sync — and hardcoding Sunday was wrong for this planner, whose weeks
 * begin on Monday.
 *
 * Every existing record already encodes the answer: the weekday of its own
 * `weekKey`. Taking the most common reading is robust to a stray record written
 * by an older build, and needs no new sync, no new setting and no guess.
 */
export function inferWeekStartsOn(
  ...stores: Array<Record<string, Record<string, unknown>> | undefined>
): WeekStartsOn {
  const votes = new Map<number, number>();
  for (const store of stores) {
    if (!store) continue;
    for (const id of Object.keys(store)) {
      const key = store[id]?.weekKey;
      if (typeof key !== 'string') continue;
      const d = parseDate(key);
      if (Number.isNaN(d.getTime())) continue;
      const day = d.getDay();
      votes.set(day, (votes.get(day) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [day, count] of votes) {
    // Ties break towards the lower weekday so the result is deterministic
    // rather than dependent on Map insertion order.
    if (count > bestCount || (count === bestCount && best !== undefined && day < best)) {
      best = day;
      bestCount = count;
    }
  }
  // Nothing to learn from — a genuinely empty planner. Sunday is the product
  // default. It is only ever reached before the first record exists: the moment
  // there is one, its own anchor overrides this, which is what keeps the phone
  // agreeing with whatever the PC is set to. (This planner is set to Monday, and
  // the inference above is what makes the phone follow it.)
  return (best ?? 0) as WeekStartsOn;
}

export interface Anchor {
  weekKey: string;
  dayIndex: number;
}

/** Where a given date sits, expressed the way the planner stores it. */
export function anchorFor(date: string, weekStartsOn: WeekStartsOn): Anchor {
  const target = parseDate(date);
  const weekKey = weekKeyOf(target, weekStartsOn);
  const start = parseDate(weekKey);
  // Whole days apart, computed from calendar dates rather than by dividing
  // milliseconds, so a daylight-saving boundary inside the week cannot shift it.
  const dayIndex = Math.round(
    (Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
      - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / DAY_MS,
  );
  return { weekKey, dayIndex };
}

/** The date an anchor resolves to — the inverse of `anchorFor`. */
export function dateOfAnchor(anchor: Anchor): string {
  const start = parseDate(anchor.weekKey);
  return ymdOf(new Date(
    start.getFullYear(), start.getMonth(), start.getDate() + (anchor.dayIndex || 0),
  ));
}

export interface DraftInput {
  title: string;
  date: string;
  allDay: boolean;
  /** Minutes from midnight. Ignored when `allDay`. */
  startMin: number | null;
  endMin: number | null;
  notes?: string;
  /** A swatch name or a '#rrggbb'. Overridden by the category when one is set. */
  colour?: string;
  categoryId?: string;
  /** Absent means it happens once. */
  recur?: Recurrence;
  /**
   * Reminders for this item.
   *
   * ABSENT MEANS INHERIT, and that is load-bearing: it is why every event that
   * already exists gets reminders without being rewritten, and why the category
   * and then the global default get their turn. "Off" is an explicit
   * `{ enabled: false }`, never an absence.
   */
  notify?: NotifySpec;
  /** All-day items only: how many days it covers. 1, or absent, is one day. */
  daysSpan?: number;
  /** A reference point rather than something to tick off. */
  noCheckbox?: boolean;
  /** A moment rather than a span. */
  noDuration?: boolean;
  /** Editing one occurrence changes the whole series instead of detaching it. */
  locked?: boolean;
  /**
   * TASKS ONLY: this one is not on a day at all.
   *
   * Most tasks are not. "Renew the passport" is something to get done, not
   * something that happens on Wednesday, and filing it under a date you did not
   * choose means it appears to be overdue the next morning for no reason. A task
   * with no `weekKey` is already what the rest of the app calls undated -- the
   * grid gathers them onto today without claiming they belong there -- so this
   * flag is only how the EDITOR says it, since `date` itself cannot be empty
   * (an event always has one).
   *
   * Ignored for events.
   */
  undated?: boolean;
}

/**
 * A real calendar date, written the way the planner stores them.
 *
 * Checked here rather than by asking `parseDate`, which never reports failure:
 * it answers the epoch for nonsense and rolls "2026-13-45" forward into 2027.
 * So the round trip is the test — a date that does not format back to itself was
 * not a date.
 */
export function isDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return false;
  const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return back === value;
}

export interface DraftProblem {
  field: 'title' | 'time' | 'date';
  message: string;
}

/** Everything wrong with a draft, in the order a person would fix it. */
export function validateDraft(input: DraftInput): DraftProblem[] {
  const out: DraftProblem[] = [];

  if (input.title.trim().length === 0) {
    out.push({ field: 'title', message: 'Give it a name.' });
  }
  if (!isDateString(input.date)) {
    out.push({ field: 'date', message: 'Pick a date.' });
  }
  if (!input.allDay) {
    if (input.startMin === null) {
      out.push({ field: 'time', message: 'Set a start time.' });
    } else if (input.endMin !== null && input.endMin <= input.startMin) {
      // Equal is rejected too: a zero-length event draws as nothing at all on
      // the PC's grid, so it would simply look like the save failed.
      out.push({ field: 'time', message: 'The end time must be after the start.' });
    }
  }
  return out;
}

/**
 * Apply a category's defaults to a draft.
 *
 * The PC's categories carry more than a colour: a default duration, whether
 * items start as all-day, whether they show a checkbox. Choosing "Sleep" and
 * then having to set all-day by hand every time is the kind of small mismatch
 * that makes two clients feel like different apps.
 *
 * Only for a draft the user is still composing. Applying these on an EDIT would
 * silently undo deliberate choices — someone who set a 90-minute meeting does
 * not want it snapped back to the category's 60 because they touched the
 * category chip.
 */
export function applyCategoryDefaults(
  input: DraftInput,
  category: EventCategory | undefined,
): DraftInput {
  if (!category) return { ...input, categoryId: undefined };

  const next: DraftInput = { ...input, categoryId: category.id };

  if (category.defaultAllDay !== undefined) next.allDay = category.defaultAllDay;
  if (category.defaultNoCheckbox !== undefined) next.noCheckbox = category.defaultNoCheckbox;
  if (category.defaultNoDuration !== undefined) next.noDuration = category.defaultNoDuration;

  if (!next.allDay && typeof category.defaultDurationMin === 'number') {
    const start = next.startMin ?? 9 * 60;
    next.startMin = start;
    // A duration of zero is the category saying "this is a moment, not a span".
    next.endMin = category.defaultDurationMin > 0
      ? Math.min(24 * 60 - 1, start + category.defaultDurationMin)
      : null;
  }
  return next;
}

/** A stable id. Passed in rather than generated, so drafts stay pure. */
export interface DraftMeta {
  id: string;
  now: number;
  weekStartsOn: WeekStartsOn;
}

/**
 * The record to store for an EVENT.
 *
 * Field names match what the PC writes, exactly. `content` is the title — not
 * `title`, which is what tasks use; mixing the two produced items that synced
 * perfectly and displayed as "Untitled" on the phone.
 */
export function buildEventRecord(
  input: DraftInput,
  meta: DraftMeta,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const { weekKey, dayIndex } = anchorFor(input.date, meta.weekStartsOn);
  const base = existing ? { ...existing } : {};

  const record: Record<string, unknown> = {
    ...base,
    id: meta.id,
    content: input.title.trim(),
    weekKey,
    dayIndex,
    updatedAt: meta.now,
  };

  if (input.allDay) {
    record.allDay = true;
    // Cleared, not left behind: an all-day item that still carries a start time
    // sorts among the timed items on the PC.
    record.startTime = undefined;
    record.endTime = undefined;
  } else {
    record.allDay = undefined;
    record.startTime = toTimeString(input.startMin ?? 0);
    record.endTime = input.endMin === null ? undefined : toTimeString(input.endMin);
  }

  if (input.notes !== undefined) record.notes = input.notes.trim() || undefined;
  if (input.colour !== undefined) record.color = input.colour;
  if (input.categoryId !== undefined) record.categoryId = input.categoryId || undefined;

  // `undefined` is written deliberately for each of these rather than skipped:
  // clearing a repeat, or a reminder, has to be expressible. The sync layer
  // turns an undefined into a real "this field is now empty".
  record.recur = input.recur;
  record.notify = input.notify;
  record.daysSpan = input.allDay && input.daysSpan && input.daysSpan > 1
    ? input.daysSpan
    : undefined;
  record.noCheckbox = input.noCheckbox ?? false;
  record.noDuration = input.noDuration ?? false;
  record.locked = input.locked ? true : undefined;

  // A repeat that is cleared must take its exclusions with it: dates excluded
  // from a series that no longer exists would silently hide the one occurrence
  // that remains.
  if (!input.recur) record.exdates = undefined;

  if (!existing) record.deleted = false;
  return record;
}

/** The record to store for a TASK. Tasks use `title`, and have no end time. */
export function buildTaskRecord(
  input: DraftInput,
  meta: DraftMeta,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const { weekKey, dayIndex } = anchorFor(input.date, meta.weekStartsOn);
  const base = existing ? { ...existing } : {};

  const record: Record<string, unknown> = {
    ...base,
    id: meta.id,
    title: input.title.trim(),
    // Cleared rather than omitted: `base` is the existing record, so leaving
    // these out would keep whatever day it used to be on. `undefined` is how
    // every other field here is cleared.
    weekKey: input.undated ? undefined : weekKey,
    dayIndex: input.undated ? undefined : dayIndex,
    updatedAt: meta.now,
  };

  if (input.allDay || input.startMin === null) {
    record.startTime = undefined;
  } else {
    record.startTime = toTimeString(input.startMin);
  }
  if (input.notes !== undefined) record.notes = input.notes.trim() || undefined;
  if (input.colour !== undefined) record.color = input.colour;
  // A repeat is a rule about which DAYS something falls on, so it cannot mean
  // anything without one. Dropped rather than stored and quietly ignored, which
  // is the version that has somebody wondering why their weekly task never
  // came back.
  record.recur = input.undated ? undefined : input.recur;
  record.notify = input.notify;
  if (input.undated || !input.recur) record.exdates = undefined;
  if (!existing) record.deleted = false;
  return record;
}

/** Fill the editor from a record that already exists. */
export function draftFromRecord(
  record: Record<string, unknown>,
  store: 'events' | 'tasks',
  fallbackDate: string,
): DraftInput {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const title = store === 'events' ? str(record.content) : str(record.title);
  const startTime = str(record.startTime);
  const endTime = str(record.endTime);
  const anchor = typeof record.weekKey === 'string'
    ? dateOfAnchor({ weekKey: record.weekKey, dayIndex: Number(record.dayIndex) || 0 })
    : fallbackDate;

  const span = Number(record.daysSpan);

  return {
    title: title ?? '',
    date: anchor,
    allDay: record.allDay === true || (store === 'events' && startTime === undefined),
    startMin: startTime ? fromTimeString(startTime) : null,
    endMin: endTime ? fromTimeString(endTime) : null,
    notes: str(record.notes) ?? '',
    colour: str(record.color),
    categoryId: str(record.categoryId),
    recur: (record.recur && typeof record.recur === 'object')
      ? (record.recur as Recurrence)
      : undefined,
    notify: (record.notify && typeof record.notify === 'object')
      ? (record.notify as NotifySpec)
      : undefined,
    daysSpan: Number.isFinite(span) && span > 1 ? Math.floor(span) : undefined,
    noCheckbox: record.noCheckbox === true,
    noDuration: record.noDuration === true,
    locked: record.locked === true,
    // No anchor stored means it was never on a day. `date` still carries the
    // fallback, so turning the date back on lands somewhere sensible rather
    // than on an empty field.
    undated: store === 'tasks' && typeof record.weekKey !== 'string',
  };
}

// ─── Saying what a rule means ────────────────────────────────────────────────
// A repeat and a reminder are both small data structures, and both are easy to
// set wrongly and never notice. So the editor never shows the structure: it
// shows a sentence, and the sentence is generated here where it can be tested.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
};

/** "Every 2 weeks on Mon, Wed, until 3 Sep" — a rule a person can check. */
export function describeRecur(recur: Recurrence | undefined): string {
  if (!recur) return 'Does not repeat';

  const n = Math.max(1, Math.floor(recur.interval || 1));
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[recur.freq]
    ?? 'time';
  let text = n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;

  if (recur.freq === 'weekly' && recur.byWeekday?.length) {
    const days = [...recur.byWeekday].sort((a, b) => a - b).map(d => DAY_SHORT[d] ?? '?');
    text += ` on ${days.join(', ')}`;
  }

  if (recur.end && 'until' in recur.end && recur.end.until) {
    text += `, until ${niceDay(recur.end.until)}`;
  } else if (recur.end && 'count' in recur.end && recur.end.count > 0) {
    text += `, ${recur.end.count} time${recur.end.count === 1 ? '' : 's'}`;
  }
  return text;
}

/** The full weekday name, for an accessible label. */
export const weekdayName = (d: number): string => DAY_NAMES[d] ?? '';

function niceDay(date: string): string {
  if (!isDateString(date)) return date;
  const d = parseDate(date);
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: 'short' })}`;
}

/**
 * "15 minutes before", "At the time", "Off", "Uses the default".
 *
 * ABSENT IS NOT OFF. An item with no spec inherits — from its category, then
 * from the global default — which is how everything that already exists gets
 * reminders without being rewritten. Saying "Off" here would be a lie, and one
 * the user would act on.
 */
export function describeNotify(notify: NotifySpec | undefined): string {
  if (!notify) return 'Default';
  if (!notify.enabled) return 'Off';
  if (!notify.rules?.length) return 'On';

  // The ENGINE's own wording, never a second copy of it. A duplicate got the
  // sign backwards once already: it called a positive offset "before" while
  // `computeSchedule` fires at `anchor + offsetMin`, so a reminder that said
  // "15 minutes before" arrived fifteen minutes late. One function, one truth.
  const parts = notify.rules
    .slice(0, 3)
    .map(r => offsetLabel(r.offsetMin ?? 0));
  const extra = notify.rules.length - parts.length;
  return parts.join(', ') + (extra > 0 ? ` +${extra}` : '');
}

export { ordinal };

/** A reasonable first draft for the "+" button: the next round half hour. */
/**
 * A new TASK, as both machines start one.
 *
 * Undated and all-day, which are the same decision said twice: a task is
 * something to get done, not something that happens at 14:15 on Wednesday.
 * Defaulting it onto today was a guess, and a guess that goes stale overnight --
 * you would come back the next morning to a list of things that looked overdue
 * and never had a deadline in the first place.
 *
 * The date is still carried, so choosing a day in the editor lands on something
 * sensible instead of an empty field.
 *
 * Kept here rather than in either UI because the PC and the phone have to agree
 * about it; they write into the same store and read each other's rows.
 */
export function blankTaskDraft(date: string, nowMinutes: number): DraftInput {
  return {
    ...blankDraft(date, nowMinutes),
    allDay: true,
    endMin: null,
    undated: true,
  };
}

export function blankDraft(date: string, nowMinutes: number): DraftInput {
  const start = Math.min(23 * 60 + 30, Math.ceil(nowMinutes / 30) * 30);
  return {
    title: '',
    date,
    allDay: false,
    startMin: start,
    endMin: Math.min(24 * 60 - 1, start + 60),
    notes: '',
  };
}
