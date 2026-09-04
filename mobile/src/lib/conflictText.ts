// ─── Saying what a sync conflict is actually about ───────────────────────────
// The sync engine deals in stores, entity ids, field names and lamport stamps.
// A person is looking at a card and asking one question: WHAT IS THIS ABOUT? If
// the card cannot answer that, every word after it is wasted, and the two
// buttons underneath are a coin toss.
//
// WHAT THE CARDS USED TO SAY, AND WHY
//
//  * "Untitled item", almost always. The screen could look up a title in two of
//    the EIGHT stores, and even for those two it read through the live planner,
//    which hides deleted records -- so the one card that most needs a name, the
//    "deleted here, edited there" card, could never have one. The user could not
//    tell "this thing has no title" from "the app has no idea what this is".
//  * "Event edited on both devices" for a focus session, a category, a task
//    list, a setting or a prayer, because anything that was not a task was
//    called an event.
//  * DISAGREEMENT ON "ENDEDAT". Field names with no entry in the table fell
//    through to the raw key, in quotes, shouted.
//  * 2026-09-03T19:11:14.644Z as a value to choose between.
//
// So: every store has a noun, every field a phrase, every value a rendering,
// and a thing with no title of its own is described by what it IS and when it
// happened rather than by the absence of a name.

import type { SyncConflict, SyncStore } from './sync';

export interface DescribedChoice {
  label: string;
  consequence: string;
  value: 'winner' | 'loser' | 'delete' | 'keep';
}

export interface DescribedConflict {
  raw: SyncConflict;
  fieldFriendlyName: string;
  winnerLabel: string;
  winnerValue: string;
  winnerTime: string;
  loserLabel: string;
  loserValue: string;
  loserTime: string;
  isDelete: boolean;
  choices: DescribedChoice[];
}

export interface GroupedConflict {
  /** The name if it has one, otherwise a description of what it is. */
  itemTitle: string;
  /** 'Event', 'Focus session', 'Task list'. Never a guess. */
  kindLabel: string;
  /** True when the record is a tombstone, so the card can say so. */
  deleted: boolean;
  /** One line: what this is, whether it is gone, and what happened to it. */
  subtitle: string;
  store: SyncStore;
  entityId: string;
  conflicts: DescribedConflict[];
}

/**
 * Whatever the app can still find out about the thing a conflict is about.
 *
 * A PLAIN RECORD, READ THROUGH THE TOMBSTONE. The screen used to read titles
 * out of the live planner, which by design does not return deleted records --
 * so the "deleted here, edited there" card, the one where knowing what was
 * deleted matters most, was the one card guaranteed to say "Untitled item".
 */
export type EntityPeek = Record<string, unknown> | null | undefined;

/**
 * What kind of thing this is, in a word.
 *
 * Every store, not two of them. Anything missing here used to be called an
 * event, which is how a focus session came to be described as one.
 */
const STORE_NOUN: Record<SyncStore, string> = {
  events: 'event',
  tasks: 'task',
  taskLists: 'task list',
  categories: 'category',
  settings: 'setting',
  prayerDone: 'prayer',
  prayerTimes: 'prayer times',
  focusSessions: 'focus session',
};

export function storeNoun(store: SyncStore): string {
  return STORE_NOUN[store] ?? 'item';
}

/** The same, capitalised, for the line above a card. */
export function storeLabel(store: SyncStore): string {
  const noun = storeNoun(store);
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

function deviceLabel(device: string): string {
  if (device.startsWith('pc')) return 'PC';
  if (device.startsWith('android') || device.startsWith('phone')) return 'phone';
  if (device.startsWith('tablet')) return 'tablet';
  return device;
}

function describeAgo(ms: number): string {
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    title: 'the title',
    startTime: 'the start time',
    endTime: 'the end time',
    notes: 'the notes',
    categoryId: 'the category',
    weekKey: 'the date',
    dayIndex: 'the date',
    allDay: 'all-day',
    daysSpan: 'the length',
    color: 'the colour',
    notify: 'the reminder',
    completed: 'whether it is done',
    listId: 'the list',
    recur: 'how it repeats',
    locked: 'the repeat setting',
    completedDates: 'completed dates',
    exdates: 'excluded dates',

    // Tasks
    order: 'the position in the list',
    parentId: 'which task it is a step of',
    completedAt: 'when it was finished',
    undated: 'whether it has a date',
    occDate: 'which repeat this is',

    // Focus sessions. `endedAt` is the one that was being shown raw, in
    // quotes, because this half of the table did not exist.
    startedAt: 'when it started',
    endedAt: 'when it ended',
    durationSeconds: 'how long it ran',
    plannedSeconds: 'how long it was set for',
    creditedSeconds: 'time already counted',

    // Lists, categories and everything else with a name of its own
    name: 'the name',
    icon: 'the icon',
    hidden: 'whether it is hidden',
    position: 'the position',
    done: 'whether it is done',
  };
  if (map[field]) return map[field];

  // NOT THE RAW KEY. `endedAt` in quotes tells a person nothing and looks like
  // a fault in the app. Splitting the camel case at least produces words:
  // `plannedSeconds` becomes "planned seconds", which is wrong-ish English and
  // still a great deal better than shouting a variable name at somebody.
  const words = field
    // A run of capitals followed by a word is two words: HTTPStatus is "http
    // status", not "httpstatus". Done first, or the rule below eats the run.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? `the ${words}` : 'this field';
}

/** 2026-09-03T19:11:14.644Z and friends. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Fields that hold a length of time in seconds. */
const SECONDS_FIELDS = new Set(['durationSeconds', 'plannedSeconds', 'creditedSeconds']);

/** A moment, said the way a clock and a calendar say it. */
function renderMoment(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

/** A length of time, in the largest unit that still says something. */
function renderDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '(unknown)';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  const h = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return rest === 0 ? h : `${h} ${rest} min`;
}

/**
 * One side of a disagreement, as something a person can weigh up.
 *
 * A CHOICE BETWEEN TWO THINGS YOU CANNOT READ IS NOT A CHOICE. The card offered
 * `2026-09-03T19:11:14.644Z` against `2026-09-03T19:11:14.579Z` and two buttons,
 * which is not a question anybody can answer -- and the answer, once rendered,
 * is usually that the two are the same moment to within a rounding error.
 */
function renderValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return '(empty)';

  if (typeof value === 'string') {
    if (value.trim().length === 0) return '(empty)';
    if (ISO_STAMP.test(value)) return renderMoment(value);
    // Already a time like "09:00", a date like "2026-01-01", or a colour name.
    // Long free text is cut: a card is not the place to read a page of notes,
    // and an unbounded string pushes the buttons off the screen.
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  if (typeof value === 'number') {
    if (SECONDS_FIELDS.has(field)) return renderDuration(value);
    // A bare epoch is a moment, not a number with fourteen digits in it.
    if (/At$/.test(field) && value > 1_000_000_000_000) return renderMoment(new Date(value).toISOString());
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    const shown = value.slice(0, 4).map(v => String(v)).join(', ');
    return value.length > 4 ? `${shown} and ${value.length - 4} more` : shown;
  }

  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  } catch {
    return '(unreadable)';
  }
}

export function describeConflict(conflict: SyncConflict, now: number): DescribedConflict {
  const isDelete = conflict.kind === 'delete';
  const wDevice = deviceLabel(conflict.winner.device);
  const lDevice = deviceLabel(conflict.loser.device);
  
  const choices: DescribedChoice[] = [];
  
  if (isDelete) {
    // A delete conflict is one device deleting an item while another device edited it.
    // Keeping it keeps the edited version. Deleting it deletes it completely.
    choices.push({
      label: 'Keep it',
      consequence: 'Brings it back, everywhere.',
      value: 'keep',
    });
    choices.push({
      label: 'Delete it',
      consequence: 'Removes it, everywhere.',
      value: 'delete',
    });
  } else {
    // Normal field edits.
    choices.push({
      label: `Keep ${wDevice}`,
      consequence: 'Used on both devices.',
      value: 'winner',
    });
    choices.push({
      label: `Keep ${lDevice}`,
      consequence: 'Used on both devices.',
      value: 'loser',
    });
  }

  return {
    raw: conflict,
    fieldFriendlyName: fieldLabel(conflict.field),
    winnerLabel: wDevice,
    winnerValue: renderValue(conflict.field, conflict.winner.value),
    winnerTime: describeAgo(now - conflict.winner.at),
    loserLabel: lDevice,
    loserValue: renderValue(conflict.field, conflict.loser.value),
    loserTime: describeAgo(now - conflict.loser.at),
    isDelete,
    choices,
  };
}

/**
 * What to call this thing on the card.
 *
 * In order of preference: the name it was given; something that identifies it
 * from what it holds (a focus session is the day and time it ran); and only
 * then an admission that it has no name -- phrased as "Untitled event" rather
 * than "Untitled item", because knowing WHAT has no name is most of the answer.
 */
export function describeEntity(store: SyncStore, record: EntityPeek): string {
  const noun = storeNoun(store);

  const text = (key: string): string | null => {
    const v = record?.[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };

  const named = text('title') ?? text('name') ?? text('label');
  if (named) return named;

  if (store === 'focusSessions') {
    // A session has no name and never will: it is identified by when it ran.
    const when = text('startedAt') ?? text('endedAt');
    if (when) {
      const d = new Date(when);
      if (!Number.isNaN(d.getTime())) {
        return `Focus session, ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
      }
    }
    return 'A focus session';
  }

  if (store === 'settings') return 'Planner settings';

  if (store === 'prayerDone' || store === 'prayerTimes') {
    const day = text('date') ?? text('dateStr');
    return day ? `Prayers on ${day}` : `Your ${noun}`;
  }

  // Dated things can at least say when they were.
  const day = text('weekKey') ?? text('date') ?? text('occDate');
  if (day) return `Untitled ${noun}, ${day}`;

  return `Untitled ${noun}`;
}

export function groupConflicts(
  conflicts: SyncConflict[],
  now: number,
  peek: (store: SyncStore, entityId: string) => EntityPeek,
): GroupedConflict[] {
  const groups = new Map<string, GroupedConflict>();
  
  for (const c of conflicts) {
    const key = `${c.store}:${c.entityId}`;
    if (!groups.has(key)) {
      const record = peek(c.store, c.entityId);
      const deleted = record?.deleted === true || record?.__deleted === true;
      groups.set(key, {
        itemTitle: describeEntity(c.store, record),
        kindLabel: storeLabel(c.store),
        deleted,
        subtitle: deleted
          ? `${storeLabel(c.store)}, deleted on one device`
          : `${storeLabel(c.store)}, changed on both devices`,
        store: c.store,
        entityId: c.entityId,
        conflicts: [],
      });
    }
    groups.get(key)!.conflicts.push(describeConflict(c, now));
  }
  
  // Sort conflicts within each group to ensure deterministic order (e.g., delete first)
  for (const group of groups.values()) {
    group.conflicts.sort((a, b) => {
      if (a.isDelete !== b.isDelete) return a.isDelete ? -1 : 1;
      return a.fieldFriendlyName.localeCompare(b.fieldFriendlyName);
    });
  }
  
  // Convert to array and sort groups
  return Array.from(groups.values()).sort((a, b) => a.itemTitle.localeCompare(b.itemTitle));
}
