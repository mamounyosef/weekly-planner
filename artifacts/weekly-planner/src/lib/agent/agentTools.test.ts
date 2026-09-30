// Tests for the planner agent's tool sandbox (src/lib/agent/agentTools.ts).
//
// These are the ONLY things the model can do to the planner, so they are the
// whole safety story: every write must be exactly what the report says, every
// refusal must leave the data untouched, deletion must never happen without the
// approval step, and Undo must never overwrite a newer edit.
//
// Run with: npx tsx src/lib/agent/agentTools.test.ts

import assert from 'node:assert/strict';

import {
  runTool, applyDeletion, planUndo, verifyAgainst, answersToResult, parseTime, parseYmdStrict,
  anchorFor, anchorDate, TOOL_DEFS, TOOL_NAMES, READ_ONLY_TOOLS,
  type AgentWorld, type AgentEvent, type EventData, type DeletionPlan,
} from './agentTools';
import { buildSystemPrompt, calendarTable } from './agentPrompt';
import type { Task, TaskData } from '../tasks';

const OWNED = 'owned-cal@group.calendar.google.com';
const FOREIGN = 'uni@group.calendar.google.com';

let idSeq = 0;
const nextId = () => `new-${++idSeq}`;

function baseEvents(): EventData {
  return {
    gym: {
      id: 'gym', content: 'Gym', color: 'sage', ...anchorFor('2026-09-28', 0),
      startTime: '17:00', endTime: '18:00', recur: { freq: 'weekly', interval: 1, byWeekday: [1, 3] },
      deleted: false, updatedAt: 1,
    },
    dentist: {
      id: 'dentist', content: 'Dentist', color: '#f97316', categoryId: 'events', ...anchorFor('2026-10-02', 0),
      startTime: '10:00', endTime: '10:45', deleted: false, updatedAt: 1,
    },
    lecture: {
      id: 'lecture', content: 'Lecture (read-only)', color: 'blue', ...anchorFor('2026-10-01', 0),
      startTime: '09:00', endTime: '10:00', gCalId: 'g1', gCalCalendarId: FOREIGN, deleted: false, updatedAt: 1,
    },
    owned: {
      id: 'owned', content: 'Owned Google item', color: 'sage', ...anchorFor('2026-10-03', 0),
      startTime: '12:00', endTime: '13:00', gCalId: 'g2', gCalCalendarId: OWNED, deleted: false, updatedAt: 1,
    },
    trip: {
      id: 'trip', content: 'Trip', color: 'peach', ...anchorFor('2026-09-26', 0),
      allDay: true, daysSpan: 4, startTime: '00:00', endTime: '00:30', deleted: false, updatedAt: 1,
    },
    sleep: {
      id: 'sleep', content: 'Late shift', color: 'sage', ...anchorFor('2026-09-30', 0),
      startTime: '22:00', endTime: '02:00', deleted: false, updatedAt: 1,
    },
  } as EventData;
}

function baseTasks(): TaskData {
  return {
    milk: { id: 'milk', title: 'Buy milk', listId: 'shopping', order: 10, deleted: false, updatedAt: 1 },
    report: { id: 'report', title: 'Write report', ...anchorFor('2026-09-29', 0), order: 10, deleted: false, updatedAt: 1 },
    water: {
      id: 'water', title: 'Water plants', ...anchorFor('2026-09-27', 0), recur: { freq: 'daily', interval: 1 },
      completedDates: [], order: 20, deleted: false, updatedAt: 1,
    },
    trip2: { id: 'trip2', title: 'Pack', ...anchorFor('2026-10-01', 0), order: 30, deleted: false, updatedAt: 1, gTaskId: 'gt1' },
    step1: { id: 'step1', title: 'Passport', parentId: 'trip2', order: 10, deleted: false, updatedAt: 1 },
  } as TaskData;
}

function world(over: Partial<AgentWorld> = {}): AgentWorld {
  return {
    now: new Date(2026, 8, 27, 12, 57),
    timeZone: 'Asia/Amman',
    events: baseEvents(),
    tasks: baseTasks(),
    categories: [
      { id: 'events', name: 'Events', color: '#f97316', defaultDurationMin: 60 },
      { id: 'deadlines', name: 'Deadlines', color: '#993600', defaultDurationMin: 0, defaultNoDuration: true },
      { id: 'projects', name: 'Projects Timelines', color: '#15d1bb', defaultAllDay: true },
      { id: 'uni', name: 'University Calender', color: '#f97316', defaultDurationMin: 60, defaultNoCheckbox: true },
    ],
    taskLists: [
      { id: 'general', name: 'General', color: '#3b82f6' },
      { id: 'shopping', name: 'Shopping', color: '#22c55e' },
    ],
    weekStartsOn: 0,
    dayStartH: 0,
    dayEndH: 24,
    timeFormat: '12h',
    ownedCalendarId: OWNED,
    calendars: [{ id: OWNED, summary: 'Daily calendar' }, { id: FOREIGN, summary: 'University' }],
    prayersFor: (d) => (d.startsWith('2026-10') || d.startsWith('2026-09')
      ? { fajr: '05:09', sunrise: '06:30', dhuhr: '12:26', asr: '15:50', maghrib: '18:26', isha: '19:42' }
      : null),
    newId: nextId,
    ...over,
  };
}

const call = (name: string, args: unknown, w = world()) => runTool(name, args, w);
const err = (o: ReturnType<typeof runTool>) => (o.result as { error?: string }).error ?? '';
const dateOf = (e: { weekKey?: string; dayIndex?: number }) => anchorDate(e as AgentEvent);

async function main() {
  console.log('--- 1. THE SANDBOX: ONLY DECLARED TOOLS RUN ---');
  {
    for (const bad of ['update_item', 'delete_event', 'exec', '', '__proto__', 'constructor', 'toString']) {
      const o = call(bad, {});
      assert.equal(o.isError, true, bad);
      assert.equal(o.events, undefined);
      assert.equal(o.tasks, undefined);
      assert.match(err(o), /There is no tool/);
    }
    assert.equal(TOOL_NAMES.size, TOOL_DEFS.length);
    for (const n of READ_ONLY_TOOLS) assert.ok(TOOL_NAMES.has(n));
    // Bad argument shapes are refused, never thrown.
    for (const args of ['{not json', '[]', 'null', 42, [1, 2]]) {
      const o = call('list_items', args);
      assert.equal(o.isError, true, String(args));
    }
    console.log('  ok');
  }

  console.log('--- 2. PARSING TIMES AND DATES ---');
  {
    const ok: Array<[string, string]> = [
      ['9:05', '09:05'], ['09:05', '09:05'], ['21:00', '21:00'], ['9am', '09:00'], ['9 am', '09:00'],
      ['9:30 PM', '21:30'], ['12 pm', '12:00'], ['12am', '00:00'], ['12:15 a.m.', '00:15'], ['noon', '12:00'],
      ['midnight', '00:00'], ['24:00', '00:00'], ['7', '07:00'], ['14:30:00', '14:30'],
    ];
    for (const [i, o] of ok) assert.equal(parseTime(i, 't'), o, i);
    for (const bad of ['25:00', '13pm', '0am', '9:60', 'soon', '', '1430', '-1:00']) {
      assert.throws(() => parseTime(bad, 't'), undefined, bad);
    }
    assert.throws(() => parseTime(930 as unknown as string, 't'));
    assert.equal(parseYmdStrict('2026-10-09', 'd'), '2026-10-09');
    assert.equal(parseYmdStrict('2026-10-09T10:00:00Z', 'd'), '2026-10-09');
    for (const bad of ['2026-02-30', '2026-13-01', '26-10-09', '2026/10/09', 'tomorrow', '1900-01-01', '']) {
      assert.throws(() => parseYmdStrict(bad, 'd'), undefined, bad);
    }
    assert.equal(parseYmdStrict('2028-02-29', 'd'), '2028-02-29');
    assert.throws(() => parseYmdStrict('2027-02-29', 'd'));
    // Anchors round-trip for every weekday and both week starts.
    for (const ws of [0, 1, 6] as const) {
      for (let i = 0; i < 14; i++) {
        const d = `2026-10-${String(1 + i).padStart(2, '0')}`;
        const a = anchorFor(d, ws);
        assert.ok(a.dayIndex >= 0 && a.dayIndex <= 6);
        assert.equal(anchorDate(a as AgentEvent), d, `${d} ws=${ws}`);
      }
    }
    console.log('  ok');
  }

  console.log('--- 3. list_items: EXPANSION, READ-ONLY FLAGS, PRAYERS ---');
  {
    const o = call('list_items', { from: '2026-09-27', to: '2026-10-03', include: ['events', 'tasks', 'prayers'] });
    const r = o.result as { items: Array<Record<string, unknown>>; prayers: Record<string, unknown> };
    const ids = r.items.map(i => i.id);
    // Weekly gym on Mon + Wed: 28th and 30th only.
    assert.ok(ids.includes('gym::2026-09-28') && ids.includes('gym::2026-09-30'));
    assert.equal(ids.filter(i => String(i).startsWith('gym::')).length, 2);
    // Multi-day trip that STARTED before the window still shows.
    assert.ok(ids.includes('trip'));
    const trip = r.items.find(i => i.id === 'trip')!;
    assert.equal(trip.endDate, '2026-09-29');
    // Foreign Google event: flagged read-only and named; owned one is not.
    const lec = r.items.find(i => i.id === 'lecture')!;
    assert.equal(lec.day, 'Thursday', 'each item carries its weekday');
    assert.equal(lec.readOnly, true);
    assert.equal(lec.calendar, 'University');
    const own = r.items.find(i => i.id === 'owned')!;
    assert.equal(own.readOnly, undefined);
    // Overnight item is marked.
    assert.equal(r.items.find(i => i.id === 'sleep')!.endsNextDay, true);
    // Daily repeating task expands per day; general task never appears.
    assert.equal(ids.filter(i => String(i).startsWith('water::')).length, 7);
    assert.ok(!ids.includes('milk'));
    // Sorted by date, all-day first, then time.
    const keys = r.items.map(i => `${i.date}|${i.allDay ? 0 : 1}|${i.start ?? '99'}`);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(Object.keys(r.prayers).length, 7);
    // Filters.
    const t = call('list_items', { from: '2026-09-27', to: '2026-10-03', text: 'gym' }).result as { items: unknown[] };
    assert.equal(t.items.length, 2);
    const c = call('list_items', { from: '2026-09-27', to: '2026-10-03', category: 'events' }).result as { items: Array<{ id: string }> };
    assert.deepEqual(c.items.map(i => i.id), ['dentist']);
    // Range limits.
    assert.equal(call('list_items', { from: '2026-10-05', to: '2026-10-01' }).isError, true);
    assert.equal(call('list_items', { from: '2026-01-01', to: '2026-12-31' }).isError, true);
    assert.equal(call('list_items', { from: '2026-10-01' }).isError, true);
    // Unknown category is a refusal that names the real ones.
    assert.match(err(call('list_items', { from: '2026-10-01', to: '2026-10-02', category: 'Nope' })), /Existing categories: Events/);
    // Deleted and leaked occurrence records never show.
    const w = world();
    w.events.ghost = { ...w.events.dentist, id: 'ghost', deleted: true };
    w.events['dentist::2026-10-02'] = { ...w.events.dentist, id: 'dentist::2026-10-02' };
    const g = runTool('list_items', { from: '2026-10-02', to: '2026-10-02' }, w).result as { items: Array<{ id: string }> };
    assert.deepEqual(g.items.map(i => i.id).filter(i => i.startsWith('ghost') || i.includes('::2026-10-02') && i.startsWith('dentist')), []);
    console.log('  ok');
  }

  console.log('--- 4. create_events: EVERY SHAPE OF ITEM ---');
  {
    idSeq = 0;
    const w = world();
    const o = runTool('create_events', {
      events: [
        { title: 'Registration (New Soft Area)', date: '2026-10-09', startTime: '09:30', endTime: '10:15', category: 'Events' },
        { title: 'Kick-off', date: '2026-10-09', startTime: '13:00', pointInTime: true, category: 'events' },
        { title: 'Hackathon', date: '2026-10-09', endDate: '2026-10-10', allDay: true },
        { title: 'Night build', date: '2026-10-09', startTime: '23:00', endTime: '01:30' },
        { title: 'Default duration', date: '2026-10-11', startTime: '8am', category: 'Events' },
        { title: 'No category default', date: '2026-10-11', startTime: '10:00' },
        { title: 'Deadline by category', date: '2026-10-12', startTime: '23:59', category: 'Deadlines' },
        { title: 'Timeline by category', date: '2026-10-12', category: 'Projects' },
        { title: 'Uni thing', date: '2026-10-13', startTime: '09:00', category: 'University' },
        { title: 'Custom colour', date: '2026-10-13', startTime: '11:00', color: '#123abc', checkbox: false },
        { title: 'Standup', date: '2026-10-12', startTime: '09:00', endTime: '09:15', recurrence: { freq: 'weekly', weekdays: ['mon', 'wed'], count: 6 } },
        { title: 'Remind me', date: '2026-10-14', startTime: '15:00', reminders: { minutesBefore: [30, 0, 1440], critical: true } },
        { title: 'Silent', date: '2026-10-14', startTime: '16:00', reminders: 'off' },
      ],
    }, w);
    assert.equal(o.isError, undefined, err(o));
    const ev = o.events!;
    const byTitle = (t: string) => Object.values(ev).find(e => e.content === t)!;
    const reg = byTitle('Registration (New Soft Area)');
    assert.equal(dateOf(reg), '2026-10-09');
    assert.equal(reg.weekKey, '2026-10-04');
    assert.equal(reg.dayIndex, 5);
    assert.equal(reg.startTime, '09:30'); assert.equal(reg.endTime, '10:15');
    assert.equal(reg.categoryId, 'events'); assert.equal(reg.color, '#f97316');
    assert.equal(reg.noDuration, false); assert.equal(reg.allDay, false); assert.equal(reg.noCheckbox, false);
    assert.equal(reg.notify, undefined, 'reminders inherit by being absent');
    const ko = byTitle('Kick-off');
    assert.equal(ko.noDuration, true); assert.equal(ko.endTime, '13:00');
    const hk = byTitle('Hackathon');
    assert.equal(hk.allDay, true); assert.equal(hk.daysSpan, 2);
    const nb = byTitle('Night build');
    assert.equal(nb.endTime, '01:30');
    assert.equal(byTitle('Default duration').endTime, '09:00');
    assert.equal(byTitle('No category default').endTime, '11:00');
    assert.equal(byTitle('No category default').color, 'sage');
    assert.equal(byTitle('No category default').categoryId, undefined);
    const dl = byTitle('Deadline by category');
    assert.equal(dl.noDuration, true); assert.equal(dl.endTime, '23:59');
    const tl = byTitle('Timeline by category');
    assert.equal(tl.allDay, true); assert.equal(tl.daysSpan, 1);
    assert.equal(byTitle('Uni thing').noCheckbox, true, 'category checkbox default applies');
    const cc = byTitle('Custom colour');
    assert.equal(cc.color, '#123abc'); assert.equal(cc.noCheckbox, true);
    const su = byTitle('Standup');
    assert.deepEqual(su.recur, { freq: 'weekly', interval: 1, byWeekday: [1, 3], end: { count: 6 } });
    const rm = byTitle('Remind me');
    assert.deepEqual(rm.notify, { enabled: true, priority: 'critical', rules: [{ id: 'r0', offsetMin: -1440 }, { id: 'r1', offsetMin: -30 }, { id: 'r2', offsetMin: 0 }] });
    assert.deepEqual(byTitle('Silent').notify, { enabled: false, rules: [], priority: 'normal' });
    // No undefined keys ever reach a stored record.
    for (const e of Object.values(ev)) for (const [k, v] of Object.entries(e)) assert.notEqual(v, undefined, `${e.content}.${k}`);
    // The report entries match the stored records one to one.
    assert.equal(o.entries!.length, 13);
    assert.ok(o.entries!.every(e => e.action === 'added' && e.kind === 'event' && ev[e.id]));
    assert.equal(o.entries!.find(e => e.after?.title === 'Hackathon')!.after!.endDate, '2026-10-10');
    assert.equal(o.entries!.find(e => e.after?.title === 'Night build')!.after!.overnight, true);
    assert.equal(o.entries!.find(e => e.after?.title === 'Kick-off')!.after!.pointInTime, true);
    // Undo records: exactly the 13 new ids, each from nothing.
    assert.equal(o.undo!.length, 13);
    assert.ok(o.undo!.every(u => u.before === null && u.after && u.store === 'events'));
    // The input world was not mutated.
    assert.equal(Object.keys(w.events).length, 6);
    console.log('  ok');
  }

  console.log('--- 5. create_events: REFUSALS CHANGE NOTHING (BATCH IS ATOMIC) ---');
  {
    const cases: Array<[unknown, RegExp]> = [
      [{ events: [] }, /non-empty/],
      [{ events: [{ date: '2026-10-09', startTime: '09:00' }] }, /title is required/],
      [{ events: [{ title: 'x', startTime: '09:00' }] }, /date/],
      [{ events: [{ title: 'x', date: '2026-10-09' }] }, /needs a startTime/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', endTime: '09:00' }] }, /pointInTime/],
      [{ events: [{ title: 'x', date: '2026-10-09', allDay: true, endDate: '2026-10-01' }] }, /before its date/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', endDate: '2026-10-10' }] }, /only for all-day/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', category: 'Gardening' }] }, /Unknown category/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', color: 'red' }] }, /hex colour/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', recurrence: { freq: 'hourly' } }] }, /freq/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', recurrence: { freq: 'weekly', weekdays: ['mon'] } }] }, /not one of the repeat weekdays/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', recurrence: { freq: 'daily', until: '2026-10-01' } }] }, /before the first date/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', recurrence: { freq: 'daily', until: '2026-10-20', count: 3 } }] }, /not both/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00', reminders: { minutesBefore: 'soon' } }] }, /minutesBefore/],
      [{ events: [{ title: 'x', date: '2026-10-09', startTime: '09:00' }, { title: '', date: '2026-10-09', startTime: '09:00' }] }, /events\[1\]/],
    ];
    for (const [args, re] of cases) {
      const o = call('create_events', args);
      assert.equal(o.isError, true, JSON.stringify(args));
      assert.match(err(o), re, JSON.stringify(args));
      assert.equal(o.events, undefined);
      assert.equal(o.entries, undefined);
    }
    console.log('  ok');
  }

  console.log('--- 6. create_events: DUPLICATES ARE SKIPPED, NOT ADDED TWICE ---');
  {
    const w = world();
    const o = runTool('create_events', {
      events: [
        { title: 'dentist', date: '2026-10-02', startTime: '10:00', endTime: '10:45' },
        { title: 'Dentist', date: '2026-10-02', startTime: '11:00' },
        { title: 'New thing', date: '2026-10-02', startTime: '12:00' },
        { title: 'New thing', date: '2026-10-02', startTime: '12:00' },
      ],
    }, w);
    const acts = o.entries!.map(e => e.action);
    assert.deepEqual(acts, ['skipped', 'added', 'added', 'skipped'], 'same title+date+start is a duplicate, also within one batch');
    assert.equal((o.result as { added: number }).added, 2);
    assert.equal(o.entries![0].id, 'dentist');
    const forced = runTool('create_events', { allowDuplicates: true, events: [{ title: 'Dentist', date: '2026-10-02', startTime: '10:00' }] }, w);
    assert.equal(forced.entries![0].action, 'added');
    console.log('  ok');
  }

  console.log('--- 7. update_events: ONE-OFF ITEMS ---');
  {
    const w = world();
    // Moving the start keeps the duration.
    let o = runTool('update_events', { updates: [{ id: 'dentist', set: { startTime: '15:00' } }] }, w);
    assert.equal(o.events!.dentist.startTime, '15:00');
    assert.equal(o.events!.dentist.endTime, '15:45');
    assert.deepEqual(o.entries![0].changed, ['startTime', 'endTime']);
    // Moving the date keeps the time.
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { date: '2026-10-07' } }] }, w);
    assert.equal(dateOf(o.events!.dentist), '2026-10-07');
    assert.equal(o.events!.dentist.startTime, '10:00');
    assert.equal(o.events!.dentist.weekKey, '2026-10-04');
    // Rename + category + explicit end.
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { title: 'Dentist (Dr Sami)', category: 'University', endTime: '11:30' } }] }, w);
    assert.equal(o.events!.dentist.content, 'Dentist (Dr Sami)');
    assert.equal(o.events!.dentist.categoryId, 'uni');
    assert.equal(o.events!.dentist.color, '#f97316');
    assert.equal(o.events!.dentist.endTime, '11:30');
    // Category "none" removes it.
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { category: 'none' } }] }, w);
    assert.equal(o.events!.dentist.categoryId, undefined);
    assert.ok(!('categoryId' in o.events!.dentist));
    // To a point in time and back.
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { pointInTime: true } }] }, w);
    assert.equal(o.events!.dentist.noDuration, true);
    assert.equal(o.events!.dentist.endTime, '10:00');
    // To all-day across three days, then back to timed.
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { allDay: true, endDate: '2026-10-04' } }] }, w);
    assert.equal(o.events!.dentist.allDay, true);
    assert.equal(o.events!.dentist.daysSpan, 3);
    assert.equal(call('update_events', { updates: [{ id: 'trip', set: { allDay: false } }] }).isError, true, 'timed needs a start');
    o = runTool('update_events', { updates: [{ id: 'trip', set: { allDay: false, startTime: '08:00' } }] }, w);
    assert.equal(o.events!.trip.allDay, false);
    assert.equal(o.events!.trip.daysSpan, 1);
    assert.equal(o.events!.trip.endTime, '09:00');
    // Done ticks by date and never detaches.
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { done: true } }] }, w);
    assert.deepEqual(o.events!.dentist.completedDates, ['2026-10-02']);
    assert.equal(o.entries![0].action, 'completed');
    // Undo record per touched id only.
    assert.deepEqual(o.undo!.map(u => u.id), ['dentist']);
    // Unknown id / empty set.
    assert.match(err(call('update_events', { updates: [{ id: 'nope', set: { title: 'x' } }] })), /No event/);
    assert.match(err(call('update_events', { updates: [{ id: 'dentist', set: {} }] })), /at least one/);
    console.log('  ok');
  }

  console.log('--- 8. update_events: READ-ONLY GOOGLE CALENDARS ARE REFUSED ---');
  {
    const o = call('update_events', { updates: [{ id: 'lecture', set: { title: 'x' } }] });
    assert.equal(o.isError, true);
    assert.match(err(o), /read-only from the Google calendar "University"/);
    assert.equal(o.events, undefined);
    // The owned calendar is fine.
    assert.equal(call('update_events', { updates: [{ id: 'owned', set: { title: 'y' } }] }).isError, undefined);
    // With the calendar list unknown, every Google-linked item is protected.
    const blind = runTool('update_events', { updates: [{ id: 'owned', set: { title: 'y' } }] }, world({ ownedCalendarId: undefined }));
    assert.equal(blind.isError, true);
    assert.match(err(blind), /has not been loaded yet/);
    // Delete is refused the same way, before any approval card is shown.
    const d = call('delete_items', { items: [{ id: 'lecture' }], reason: 'x' });
    assert.equal(d.isError, true);
    assert.equal(d.pause, undefined);
    console.log('  ok');
  }

  console.log('--- 9. update_events: REPEATING ITEMS AND SCOPES ---');
  {
    idSeq = 100;
    const w = world();
    // No scope on a repeating item is refused and tells the model to ask.
    assert.match(err(runTool('update_events', { updates: [{ id: 'gym::2026-09-30', set: { startTime: '19:00' } }] }, w)), /ask_user/);
    // "one" needs a concrete occurrence.
    assert.match(err(runTool('update_events', { updates: [{ id: 'gym', scope: 'one', set: { startTime: '19:00' } }] }, w)), /occurrence id/);
    // A date that is not an occurrence.
    assert.match(err(runTool('update_events', { updates: [{ id: 'gym::2026-09-29', scope: 'one', set: { startTime: '19:00' } }] }, w)), /not a current occurrence/);

    // ONE: detach Wednesday 30th and move it to Thursday 1st at 19:00.
    let o = runTool('update_events', { updates: [{ id: 'gym::2026-09-30', scope: 'one', set: { date: '2026-10-01', startTime: '19:00' } }] }, w);
    const detId = o.entries![0].id;
    assert.notEqual(detId, 'gym');
    assert.deepEqual(o.events!.gym.exdates, ['2026-09-30']);
    assert.equal(o.events![detId].recur, undefined);
    assert.equal(dateOf(o.events![detId]), '2026-10-01');
    assert.equal(o.events![detId].startTime, '19:00');
    assert.equal(o.events![detId].endTime, '20:00');
    assert.match(o.entries![0].note!, /Only the Wed 30 Sep occurrence/);
    // Re-listing: the 30th is gone from the series and the 1st has the moved one.
    const l = runTool('list_items', { from: '2026-09-28', to: '2026-10-02' }, { ...w, events: o.events! }).result as { items: Array<{ id: string; date: string; start?: string }> };
    assert.ok(!l.items.some(i => i.id === 'gym::2026-09-30'));
    assert.ok(l.items.some(i => i.id === detId && i.date === '2026-10-01' && i.start === '19:00'));

    // ALL: move the whole series from Monday to Tuesday: weekdays shift Mon,Wed -> Tue,Thu.
    o = runTool('update_events', { updates: [{ id: 'gym::2026-09-28', scope: 'all', set: { date: '2026-09-29' } }] }, w);
    assert.deepEqual(o.events!.gym.recur!.byWeekday, [2, 4]);
    assert.equal(dateOf(o.events!.gym), '2026-09-29');
    // ALL time change keeps the rule.
    o = runTool('update_events', { updates: [{ id: 'gym::2026-09-28', scope: 'all', set: { startTime: '06:00' } }] }, w);
    assert.equal(o.events!.gym.startTime, '06:00');
    assert.equal(o.events!.gym.endTime, '07:00');
    assert.deepEqual(o.events!.gym.recur!.byWeekday, [1, 3]);

    // FOLLOWING: from Mon 5 Oct onwards at 18:00; before stays at 17:00.
    o = runTool('update_events', { updates: [{ id: 'gym::2026-10-05', scope: 'following', set: { startTime: '18:00' } }] }, w);
    assert.deepEqual(o.events!.gym.recur!.end, { until: '2026-10-04' });
    const tailId = o.entries![0].id;
    assert.equal(o.events![tailId].startTime, '18:00');
    assert.equal(dateOf(o.events![tailId]), '2026-10-05');
    // FOLLOWING from the very first occurrence collapses to the whole series.
    o = runTool('update_events', { updates: [{ id: 'gym::2026-09-28', scope: 'following', set: { startTime: '18:00' } }] }, w);
    assert.equal(o.entries![0].id, 'gym');
    assert.match(o.entries![0].note!, /whole series/);

    // Series-level changes never need a scope.
    o = runTool('update_events', { updates: [{ id: 'gym::2026-09-30', set: { category: 'Events' } }] }, w);
    assert.equal(o.events!.gym.categoryId, 'events');
    o = runTool('update_events', { updates: [{ id: 'gym', set: { recurrence: null } }] }, w);
    assert.equal(o.events!.gym.recur, undefined);
    o = runTool('update_events', { updates: [{ id: 'dentist', set: { recurrence: { freq: 'monthly', count: 3 } } }] }, w);
    assert.deepEqual(o.events!.dentist.recur, { freq: 'monthly', interval: 1, end: { count: 3 } });

    // Ticking an occurrence of a series records the date on the master.
    o = runTool('update_events', { updates: [{ id: 'gym::2026-09-30', set: { done: true } }] }, w);
    assert.deepEqual(o.events!.gym.completedDates, ['2026-09-30']);
    assert.equal(Object.keys(o.events!).length, 6, 'no detach for a tick');

    // Locked series: an edit of one is forced onto all, and the report says so.
    const lw = world();
    lw.events.gym = { ...lw.events.gym, locked: true };
    o = runTool('update_events', { updates: [{ id: 'gym::2026-09-30', scope: 'one', set: { startTime: '07:00' } }] }, lw);
    assert.equal(o.events!.gym.startTime, '07:00');
    assert.match(o.entries![0].note!, /locked/);
    console.log('  ok');
  }

  console.log('--- 10. create_tasks ---');
  {
    idSeq = 200;
    const w = world();
    const o = runTool('create_tasks', {
      tasks: [
        { title: 'Call bank' },
        { title: 'Bread', list: 'shop' },
        { title: 'Submit form', date: '2026-10-05' },
        { title: 'Standup notes', date: '2026-10-05', startTime: '09:00' },
        { title: 'Plan trip', date: '2026-10-06', subtasks: ['Book hotel', 'Buy tickets'] },
        { title: 'Visa copy', parentId: 'trip2' },
        { title: 'Stretch', date: '2026-10-05', recurrence: { freq: 'daily', count: 10 }, reminders: { minutesBefore: [0] } },
      ],
    }, w);
    assert.equal(o.isError, undefined, err(o));
    const t = o.tasks!;
    const byTitle = (s: string) => Object.values(t).find(x => x.title === s)!;
    assert.equal(byTitle('Call bank').weekKey, undefined, 'no date means the task board');
    assert.equal(byTitle('Bread').listId, 'shopping');
    assert.equal(byTitle('Bread').order, 20, 'after the existing Buy milk');
    assert.equal(dateOf(byTitle('Submit form')), '2026-10-05');
    assert.equal(byTitle('Submit form').startTime, undefined);
    assert.equal(byTitle('Standup notes').endTime, '09:30');
    const plan = byTitle('Plan trip');
    const steps = Object.values(t).filter(x => x.parentId === plan.id).map(x => x.title);
    assert.deepEqual(steps, ['Book hotel', 'Buy tickets']);
    assert.equal(byTitle('Visa copy').parentId, 'trip2');
    assert.deepEqual(byTitle('Stretch').recur, { freq: 'daily', interval: 1, end: { count: 10 } });
    assert.equal(o.entries!.length, 9);
    assert.match(o.entries!.find(e => e.after?.title === 'Book hotel')!.note!, /Step of "Plan trip"/);
    // Refusals.
    assert.match(err(call('create_tasks', { tasks: [{ title: 'x', startTime: '09:00' }] })), /time but no date/);
    assert.match(err(call('create_tasks', { tasks: [{ title: 'x', recurrence: { freq: 'daily' } }] })), /no first date/);
    assert.match(err(call('create_tasks', { tasks: [{ title: 'x', list: 'Groceries' }] })), /Existing lists: General, Shopping/);
    assert.match(err(call('create_tasks', { tasks: [{ title: 'x', parentId: 'step1' }] })), /one level deep/);
    assert.match(err(call('create_tasks', { tasks: [{ title: 'x', parentId: 'trip2', subtasks: ['y'] }] })), /cannot have steps/);
    console.log('  ok');
  }

  console.log('--- 11. update_tasks ---');
  {
    const w = world();
    let o = runTool('update_tasks', { updates: [{ id: 'report', set: { done: true } }] }, w);
    assert.equal(o.tasks!.report.completed, true);
    assert.equal(o.entries![0].action, 'completed');
    o = runTool('update_tasks', { updates: [{ id: 'water::2026-09-28', set: { done: true } }] }, w);
    assert.deepEqual(o.tasks!.water.completedDates, ['2026-09-28']);
    assert.equal(o.tasks!.water.completed, undefined, 'a repeating task is never done as a whole');
    assert.match(err(runTool('update_tasks', { updates: [{ id: 'water', set: { done: true } }] }, w)), /which occurrence/);
    // Clearing the date sends it to the board and drops time and repeat.
    o = runTool('update_tasks', { updates: [{ id: 'report', set: { date: null } }] }, w);
    assert.equal(o.tasks!.report.weekKey, undefined);
    assert.equal(o.tasks!.report.dayIndex, undefined);
    // Giving a board task a date and time.
    o = runTool('update_tasks', { updates: [{ id: 'milk', set: { date: '2026-10-03', startTime: '18:00' } }] }, w);
    assert.equal(dateOf(o.tasks!.milk), '2026-10-03');
    assert.equal(o.tasks!.milk.endTime, '18:30');
    assert.match(err(runTool('update_tasks', { updates: [{ id: 'milk', set: { startTime: '18:00' } }] }, w)), /needs a date/);
    // Moving a repeating task to another list never needs a scope and never detaches.
    o = runTool('update_tasks', { updates: [{ id: 'water::2026-09-29', set: { list: 'Shopping' } }] }, w);
    assert.equal(o.tasks!.water.listId, 'shopping');
    assert.equal(Object.keys(o.tasks!).length, 5);
    // Detaching one occurrence of a Google-synced repeating task gets a fresh identity.
    const gw = world();
    gw.tasks.water = { ...gw.tasks.water, gTaskId: 'gX', gTaskListId: 'L' } as Task;
    o = runTool('update_tasks', { updates: [{ id: 'water::2026-09-30', scope: 'one', set: { title: 'Water the big plant' } }] }, gw);
    const det = o.tasks![o.entries![0].id];
    assert.equal(det.gTaskId, undefined);
    assert.equal(det.title, 'Water the big plant');
    assert.equal(o.tasks!.water.gTaskId, 'gX');
    assert.deepEqual(o.tasks!.water.exdates, ['2026-09-30']);
    console.log('  ok');
  }

  console.log('--- 12. delete_items NEVER DELETES; IT ONLY ASKS ---');
  {
    const w = world();
    const o = runTool('delete_items', { items: [{ id: 'dentist' }, { id: 'gym::2026-09-30', scope: 'one' }, { id: 'trip2' }], reason: 'Cleaning up' }, w);
    assert.equal(o.events, undefined);
    assert.equal(o.tasks, undefined);
    assert.equal(o.undo, undefined);
    assert.equal(o.pause!.kind, 'approval');
    const ap = (o.pause as { approval: { deletions: Array<{ title: string; scopeLabel: string; when: string }>; reason: string } }).approval;
    assert.equal(ap.reason, 'Cleaning up');
    assert.deepEqual(ap.deletions.map(d => d.title), ['Dentist', 'Gym', 'Pack']);
    assert.equal(ap.deletions[1].scopeLabel, 'Only Wed 30 Sep');
    assert.match(ap.deletions[2].scopeLabel, /and its 1 step/);
    assert.equal(ap.deletions[0].when, 'Fri 2 Oct, 10:00 AM to 10:45 AM');
    // Duplicate requests for the same thing collapse to one card row.
    const dup = runTool('delete_items', { items: [{ id: 'dentist' }, { id: 'dentist' }], reason: 'x' }, w);
    assert.equal((dup.pause as { approval: { deletions: unknown[] } }).approval.deletions.length, 1);
    // Repeating without scope is refused before any card.
    assert.match(err(runTool('delete_items', { items: [{ id: 'gym::2026-09-30' }], reason: 'x' }, w)), /scope/);
    assert.match(err(runTool('delete_items', { items: [{ id: 'nothing' }], reason: 'x' }, w)), /No event or task/);
    console.log('  ok');
  }

  console.log('--- 13. applyDeletion (after Approve) DOES EXACTLY WHAT THE CARD SAID ---');
  {
    const w = world();
    const plan: DeletionPlan = {
      items: [
        { id: 'dentist', kind: 'event', scope: 'all' },
        { id: 'gym::2026-09-30', kind: 'event', scope: 'one' },
        { id: 'owned', kind: 'event', scope: 'all' },
        { id: 'trip2', kind: 'task', scope: 'all' },
        { id: 'water::2026-10-01', kind: 'task', scope: 'following' },
      ],
    };
    const o = applyDeletion(plan, w);
    assert.equal(o.events!.dentist, undefined, 'never synced: removed');
    assert.deepEqual(o.events!.gym.exdates, ['2026-09-30']);
    assert.equal(o.events!.owned.deleted, true, 'synced to Google: tombstoned so the delete mirrors');
    assert.equal(o.tasks!.trip2.deleted, true, 'Google task: tombstoned');
    assert.equal(o.tasks!.water.recur!.end && 'until' in o.tasks!.water.recur!.end ? o.tasks!.water.recur!.end.until : null, '2026-09-30');
    assert.equal(o.entries!.filter(e => e.action === 'deleted').length, 5);
    // A never-synced task takes its steps with it.
    const w2 = world();
    w2.tasks.trip2 = { ...w2.tasks.trip2, gTaskId: undefined } as Task;
    const o2 = applyDeletion({ items: [{ id: 'trip2', kind: 'task', scope: 'all' }] }, w2);
    assert.equal(o2.tasks!.trip2, undefined);
    assert.equal(o2.tasks!.step1, undefined);
    // Something that vanished between the card and the tap is reported, not guessed.
    const w3 = world();
    delete w3.events.dentist;
    const o3 = applyDeletion({ items: [{ id: 'dentist', kind: 'event', scope: 'all' }] }, w3);
    assert.equal(o3.entries![0].action, 'failed');
    assert.equal(o3.events, undefined);
    assert.equal(o3.undo!.length, 0);
    console.log('  ok');
  }

  console.log('--- 14. UNDO RESTORES, BUT NEVER OVER A NEWER EDIT ---');
  {
    const w = world();
    const add = runTool('create_events', { events: [{ title: 'A', date: '2026-10-09', startTime: '09:00' }, { title: 'B', date: '2026-10-09', startTime: '10:00' }] }, w);
    const events = add.events!;
    // The user edits B afterwards.
    const bId = add.entries!.find(e => e.after?.title === 'B')!.id;
    const edited = { ...events, [bId]: { ...events[bId], content: 'B (edited by hand)' } };
    const u = planUndo(add.undo!, edited, w.tasks);
    assert.equal(u.restored, 1);
    assert.deepEqual(u.skipped.map(s => s.id), [bId]);
    assert.equal(u.events[bId].content, 'B (edited by hand)');
    assert.equal(Object.values(u.events).some(e => e.content === 'A'), false);
    // Undo of an update puts the old record back exactly.
    const upd = runTool('update_events', { updates: [{ id: 'dentist', set: { startTime: '15:00' } }] }, w);
    const back = planUndo(upd.undo!, upd.events!, w.tasks);
    // Restored exactly, except updatedAt, which moves forward so every sync treats it as a change.
    assert.deepEqual({ ...back.events.dentist, updatedAt: 0 }, { ...w.events.dentist, updatedAt: 0 });
    assert.ok((back.events.dentist.updatedAt ?? 0) > 1);
    // Undo of a delete brings it back.
    const del = applyDeletion({ items: [{ id: 'dentist', kind: 'event', scope: 'all' }] }, w);
    const re = planUndo(del.undo!, del.events!, w.tasks);
    assert.deepEqual({ ...re.events.dentist, updatedAt: 0 }, { ...w.events.dentist, updatedAt: 0 });
    // Undo twice is a no-op the second time (everything reads as changed since).
    const twice = planUndo(del.undo!, re.events, w.tasks);
    assert.equal(twice.restored, 0);
    console.log('  ok');
  }

  console.log('--- 14b. UNDO AFTER GOOGLE SYNC TOUCHED THE ITEMS ---');
  {
    const w = world();
    const add = runTool('create_events', { events: [{ title: 'Pushed', date: '2026-12-14', startTime: '18:00' }, { title: 'Local', date: '2026-12-15', startTime: '09:00' }] }, w);
    const pushedId = add.entries!.find(e => e.after?.title === 'Pushed')!.id;
    const localId = add.entries!.find(e => e.after?.title === 'Local')!.id;
    // The PC pushed one of them to Google a few minutes later: link fields + a new updatedAt.
    const synced: EventData = {
      ...add.events!,
      [pushedId]: { ...add.events![pushedId], gCalId: 'gX', gCalCalendarId: OWNED, gCalETag: '"1"', lastSyncedAt: 5, updatedAt: 99 },
    };
    const u = planUndo(add.undo!, synced, w.tasks, 1000);
    assert.equal(u.restored, 2, 'sync bookkeeping never makes an item look edited');
    assert.equal(u.skipped.length, 0);
    assert.equal(u.events[localId], undefined, 'never synced: removed outright');
    assert.equal(u.events[pushedId].deleted, true, 'synced: tombstoned so Google deletes it too');
    assert.equal(u.events[pushedId].gCalId, 'gX');
    assert.equal(u.events[pushedId].updatedAt, 1000);

    // Undoing an EDIT of a synced item keeps its Google link and marks it dirty.
    const w2 = world();
    w2.events.dentist = { ...w2.events.dentist, gCalId: 'gD', gCalCalendarId: OWNED, lastSyncedAt: 5 };
    const upd = runTool('update_events', { updates: [{ id: 'dentist', set: { startTime: '15:00' } }] }, w2);
    const afterSync = { ...upd.events!, dentist: { ...upd.events!.dentist, gCalETag: '"2"', lastSyncedAt: 50, updatedAt: 60 } };
    const u2 = planUndo(upd.undo!, afterSync, w2.tasks, 2000);
    assert.equal(u2.restored, 1);
    assert.equal(u2.events.dentist.startTime, '10:00');
    assert.equal(u2.events.dentist.gCalId, 'gD');
    assert.equal(u2.events.dentist.gCalETag, '"2"', 'the newest link bookkeeping is kept');
    assert.equal(u2.events.dentist.updatedAt, 2000, 'newer than lastSyncedAt, so the old content is pushed back');
    // A real edit by the user after the agent still blocks the undo.
    const edited = { ...afterSync, dentist: { ...afterSync.dentist, content: 'Dentist (moved by me)' } };
    assert.equal(planUndo(upd.undo!, edited, w2.tasks).skipped.length, 1);

    // Undoing a DELETE of a synced item: while the tombstone waits, it is revived with its link...
    const del = applyDeletion({ items: [{ id: 'owned', kind: 'event', scope: 'all' }] }, w);
    assert.equal(del.events!.owned.deleted, true);
    const u3 = planUndo(del.undo!, del.events!, w.tasks, 3000);
    assert.equal(u3.restored, 1);
    assert.equal(u3.events.owned.deleted, false);
    assert.equal(u3.events.owned.gCalId, 'g2');
    // ...and once Google sync already removed it, it comes back without the dead link.
    const gone = { ...del.events! };
    delete gone.owned;
    const u4 = planUndo(del.undo!, gone, w.tasks, 3000);
    assert.equal(u4.restored, 1);
    assert.equal(u4.events.owned.gCalId, undefined);
    assert.equal(u4.events.owned.content, 'Owned Google item');
    // Verification treats a tombstone as deleted and ignores sync fields.
    assert.equal(verifyAgainst(add.undo!, synced, w.tasks).size, 2);

    // The sync layer rebuilds absent set fields as [] and absent flags as
    // false; that is not an edit (a test item was left behind because of it).
    const normalised: EventData = {
      ...add.events!,
      [localId]: { ...add.events![localId], exdates: [], completedDates: [], locked: false },
    };
    assert.equal(planUndo(add.undo!, normalised, w.tasks).restored, 2);
    assert.equal(verifyAgainst(add.undo!, normalised, w.tasks).size, 2);
    // But a real list value is still a change.
    const ticked: EventData = { ...add.events!, [localId]: { ...add.events![localId], completedDates: ['2026-12-15'] } };
    assert.equal(planUndo(add.undo!, ticked, w.tasks).skipped.length, 1);
    console.log('  ok');
  }

  console.log('--- 15. VERIFICATION READS BACK WHAT LANDED ---');
  {
    const w = world();
    const add = runTool('create_events', { events: [{ title: 'A', date: '2026-10-09', startTime: '09:00' }] }, w);
    const ok = verifyAgainst(add.undo!, add.events!, w.tasks);
    assert.equal(ok.size, 1);
    // A write that did not land is not verified.
    assert.equal(verifyAgainst(add.undo!, w.events, w.tasks).size, 0);
    // Sync bookkeeping added later does not break verification.
    const id = add.entries![0].id;
    const synced = { ...add.events!, [id]: { ...add.events![id], lastSyncedAt: 99, gCalETag: 'x' } };
    assert.equal(verifyAgainst(add.undo!, synced, w.tasks).size, 1);
    // A tombstone counts as deleted.
    const del = applyDeletion({ items: [{ id: 'owned', kind: 'event', scope: 'all' }] }, w);
    assert.equal(verifyAgainst(del.undo!, del.events!, w.tasks).size, 1);
    console.log('  ok');
  }

  console.log('--- 16. ask_user ---');
  {
    const o = call('ask_user', { questions: [{ header: 'Which gym', question: 'Which session?', options: [{ label: 'Today (Recommended)' }, { label: 'Tuesday', description: 'The 29th' }] }] });
    assert.equal(o.pause!.kind, 'question');
    const qs = (o.pause as { questions: Array<{ options: unknown[]; allowOther: boolean; multiSelect: boolean }> }).questions;
    assert.equal(qs.length, 1);
    assert.equal(qs[0].allowOther, true);
    assert.equal(qs[0].multiSelect, false);
    // Forgiving shapes: a bare question and string options.
    const bare = call('ask_user', { question: 'Which?', options: ['A', 'B'] });
    assert.equal(bare.pause!.kind, 'question');
    // Too few options / too many questions.
    assert.equal(call('ask_user', { questions: [{ question: 'x?', options: ['only'] }] }).isError, true);
    assert.equal(call('ask_user', { questions: Array(5).fill({ question: 'x?', options: ['a', 'b'] }) }).isError, true);
    // A model-made "Other" option is dropped (the card has its own box), and so are duplicates.
    const oth = call('ask_user', { questions: [{ question: 'x?', options: ['Monday', 'Tuesday', 'Other', 'monday', 'Something else'] }] });
    assert.deepEqual((oth.pause as { questions: Array<{ options: Array<{ label: string }> }> }).questions[0].options.map(o => o.label), ['Monday', 'Tuesday']);
    // "Otherwise..." or "Other office" are real options and stay.
    const keep = call('ask_user', { questions: [{ question: 'x?', options: ['Other office', 'Main office'] }] });
    assert.equal((keep.pause as { questions: Array<{ options: unknown[] }> }).questions[0].options.length, 2);
    assert.equal(call('ask_user', { questions: [{ question: 'x?', options: ['Other', 'Something else'] }] }).isError, true);
    // More than 4 options are cut to 4 rather than refused.
    const many = call('ask_user', { questions: [{ question: 'x?', options: ['a', 'b', 'c', 'd', 'e'] }] });
    assert.equal((many.pause as { questions: Array<{ options: unknown[] }> }).questions[0].options.length, 4);
    // Answers turn into a readable tool result, including "Other".
    const q = (o.pause as { questions: Array<{ id: string; question: string }> }).questions;
    assert.deepEqual(answersToResult(q as never, [{ questionId: q[0].id, selected: ['Tuesday'], other: 'at 8pm' }]), {
      answers: [{ question: 'Which session?', answer: 'Tuesday; at 8pm' }],
    });
    assert.deepEqual(answersToResult(q as never, []), { answers: [{ question: 'Which session?', answer: '(no answer)' }] });
    console.log('  ok');
  }

  console.log('--- 17. find_free_time AND search_items ---');
  {
    const w = world();
    const f = runTool('find_free_time', { date: '2026-10-01', from: '08:00', to: '14:00', minMinutes: 30 }, w).result as { free: Array<{ start: string; end: string }>; busy: Array<{ title: string }> };
    // Busy: 00:00-02:00 (late shift carried over, outside window), lecture 09:00-10:00, dhuhr 12:26-12:46, Pack is untimed.
    assert.deepEqual(f.free, [
      { start: '08:00', end: '09:00', minutes: 60 },
      { start: '10:00', end: '12:26', minutes: 146 },
      { start: '12:46', end: '14:00', minutes: 74 },
    ] as never);
    const carried = runTool('find_free_time', { date: '2026-10-01', from: '00:00', to: '03:00', respectPrayers: false }, w).result as { free: Array<{ start: string }> };
    assert.equal(carried.free[0].start, '02:00', 'the overnight item from the day before blocks the early hours');
    const s = runTool('search_items', { query: 'milk' }, w).result as { items: Array<{ id: string; noDate?: boolean; list?: string }> };
    assert.equal(s.items[0].id, 'milk');
    assert.equal(s.items[0].noDate, true);
    assert.equal(s.items[0].list, 'Shopping');
    const g = runTool('search_items', { query: 'gym' }, w).result as { items: Array<{ id: string }> };
    assert.equal(g.items[0].id, 'gym::2026-09-28', 'a series reports its next occurrence');
    // The trip ended on the 29th, which is not in the past yet (today is the 27th).
    assert.equal((runTool('search_items', { query: 'trip' }, w).result as { count: number }).count, 1);
    const later = world({ now: new Date(2026, 9, 15) });
    assert.equal((runTool('search_items', { query: 'trip' }, later).result as { count: number }).count, 0);
    assert.equal((runTool('search_items', { query: 'trip', includePast: true }, later).result as { count: number }).count, 1);
    console.log('  ok');
  }

  console.log('--- 18. THE SYSTEM PROMPT STATES THE FACTS THE MODEL NEEDS ---');
  {
    const p = buildSystemPrompt(world(), "Ma'moun");
    assert.match(p, /Today is Sunday 27 September 2026 \(2026-09-27\)/);
    assert.match(p, /Fri 9 Oct=2026-10-09/);
    // Whole weeks in the user's layout, labelled, with today marked.
    const t = calendarTable(new Date(2026, 8, 27, 12), 0);
    const rows = t.split('\n');
    assert.equal(rows.length, 7);
    assert.match(rows[0], /^- Last week: Sun 20 Sep=2026-09-20,/);
    assert.match(rows[1], /^- This week: Sun 27 Sep=2026-09-27 \(TODAY\), Mon 28 Sep=2026-09-28, Tue 29 Sep=2026-09-29,/);
    assert.match(rows[2], /^- Next week: Sun 4 Oct=2026-10-04, .* Sat 10 Oct=2026-10-10$/);
    // A Monday week start shifts the rows, and "next week" follows it.
    const tm = calendarTable(new Date(2026, 8, 27, 12), 1).split('\n');
    assert.match(tm[1], /^- This week: Mon 21 Sep=2026-09-21, .*Sun 27 Sep=2026-09-27 \(TODAY\)$/);
    assert.match(tm[2], /^- Next week: Mon 28 Sep=2026-09-28,/);
    // Every weekday label in the table is the real weekday of its date.
    for (const cell of t.replace(/- [^:]+: /g, '').split(/,\s*|\n/)) {
      const m = /^(\w{3}) (\d+) (\w{3})=(\d{4})-(\d{2})-(\d{2})/.exec(cell.trim());
      assert.ok(m, cell);
      const d = new Date(Number(m![4]), Number(m![5]) - 1, Number(m![6]));
      assert.equal(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()], m![1], cell);
      assert.equal(String(d.getDate()), m![2], cell);
    }
    assert.match(p, /- Events \(60 min default\)/);
    assert.match(p, /- Deadlines \(point-in-time by default\)/);
    assert.match(p, /READ-ONLY.*"University"/);
    assert.match(p, /Shopping/);
    assert.doesNotMatch(p, /[–—]/, 'no en or em dashes in the prompt');
    for (const n of TOOL_NAMES) assert.ok(p.includes(n), `prompt names ${n}`);
    console.log('  ok');
  }

  console.log('\nAll agentTools tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
