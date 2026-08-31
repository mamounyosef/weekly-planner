// ─── Humanizing Sync Conflicts ───────────────────────────────────────────────
// WHY THIS EXISTS: The raw sync engine operates on operations, fields, and
// timestamps. A human sees "the title of my lunch meeting". This file bridges
// that gap, grouping field-level conflicts by the item they belong to, and
// translating raw JSON values into plain English, so the user can make an
// informed decision without needing to understand the underlying data model.

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
  itemTitle: string;
  store: SyncStore;
  entityId: string;
  conflicts: DescribedConflict[];
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
  };
  return map[field] ?? `"${field}"`;
}

function renderValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return '(empty)';
  if (typeof value === 'string') {
    if (value.trim().length === 0) return '(empty)';
    // It's already a time string like "09:00" or a date "2024-01-01" or a color name "sage"
    return value;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  try {
    return JSON.stringify(value);
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
      consequence: 'Brings it back with your change.',
      value: 'keep',
    });
    choices.push({
      label: 'Delete it',
      consequence: 'Deletes it on both devices.',
      value: 'delete',
    });
  } else {
    // Normal field edits.
    choices.push({
      label: `Keep ${wDevice}`,
      consequence: 'Uses this value on both devices.',
      value: 'winner',
    });
    choices.push({
      label: `Keep ${lDevice}`,
      consequence: 'Uses this value on both devices.',
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

export function groupConflicts(
  conflicts: SyncConflict[],
  now: number,
  getItemTitle: (store: SyncStore, entityId: string) => string | undefined
): GroupedConflict[] {
  const groups = new Map<string, GroupedConflict>();
  
  for (const c of conflicts) {
    const key = `${c.store}:${c.entityId}`;
    if (!groups.has(key)) {
      let title = getItemTitle(c.store, c.entityId);
      if (!title || title.trim() === '') {
        title = 'Untitled item';
      }
      groups.set(key, {
        itemTitle: title,
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
