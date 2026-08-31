// Tests the phone's notification centre.
//
// THE ONE THAT MATTERS: a reminder the user has already dealt with must never
// come back. Not from a second alarm, not from the PC through another
// transport, not from the schedule rebuilding the same row a second later. The
// dedupe is entirely the notification key, and the key is built from the OFFSET
// rather than the fire time, so every case below that moves, repeats, deletes
// or snoozes an item is really the same test: does the key still line up.
//
// The second one that matters is the inherit-versus-off distinction. An absent
// spec means "ask the level below me" and an explicit `{ enabled: false }` means
// "stay silent". If those two ever collapse into each other, every event already
// in the database either goes quiet or starts shouting, with nothing in the UI
// to explain why.
//
// Run with: npx tsx src/lib/notifyCentre.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  coerceNotificationSettings,
  coerceNotifySpec,
  computeSchedule,
  type NotificationSettings,
  type NotificationStore,
  type NotifySpec,
  type ScheduleInput,
  type ScheduledNotification,
} from './notifications';
import { planAlarms, type RegisteredAlarm } from './alarmPlan';
import { coercePrayerSettings, type PrayerMonth } from './prayerTimes';
import type { EventCategory } from './categories';
import {
  DEFAULT_PAST_WINDOW_MS,
  EMPTY_CENTRE_STATE,
  buildCentre,
  centreStateFromServer,
  clearEntries,
  coerceCentreState,
  dayLabel,
  desiredAlarms,
  dismiss,
  emptyMessage,
  filterView,
  handledKeys,
  markAllRead,
  markCompleted,
  markRead,
  markSynced,
  markUnread,
  mergeCentreState,
  pendingSync,
  pruneCentreState,
  recordFired,
  relativeLabel,
  snooze,
  snoozeLabel,
  statusLine,
  unsnooze,
  type CentreEntry,
  type NotifyCentreState,
} from './notifyCentre';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

const spec = (offsets: number[], priority: 'normal' | 'critical' = 'normal'): NotifySpec => ({
  enabled: true,
  rules: offsets.map((o, i) => ({ id: `r${i}`, offsetMin: o })),
  priority,
});

const CATS: EventCategory[] = [
  { id: 'exams', name: 'Exams', color: '#ef4444', notifyTimed: spec([-30], 'critical') },
  { id: 'plain', name: 'Plain', color: '#22c55e' },
];

/** Monday. Every fixture week hangs off this one date. */
const WEEK = '2026-08-24';

const scheduleFor = (over: Partial<ScheduleInput> = {}): ScheduledNotification[] =>
  computeSchedule({
    events: {},
    tasks: {},
    categories: CATS,
    settings: DEFAULT_NOTIFICATION_SETTINGS,
    weekStartsOn: 1,
    from: at(2026, 8, 1),
    to: at(2026, 9, 15),
    ...over,
  });

/** A hand-built schedule row, for the cases that have nothing to do with events. */
const row = (over: Partial<ScheduledNotification> & { key: string; fireAt: number }): ScheduledNotification => ({
  kind: 'event',
  refId: over.key.split(':')[1] ?? 'x',
  occDate: '2026-08-25',
  anchorAt: over.fireAt,
  offsetMin: 0,
  title: 'Something',
  body: 'body',
  priority: 'normal',
  allDay: false,
  url: '/',
  ...over,
});

const state = (): NotifyCentreState => ({ marks: {}, updatedAt: 0 });

const byKey = (entries: readonly CentreEntry[], key: string): CentreEntry => {
  const found = entries.find(e => e.key === key);
  assert.ok(found, `expected an entry for ${key}`);
  return found;
};

/** The same lookup, over a raw schedule. */
const fire = (schedule: readonly ScheduledNotification[], key: string): ScheduledNotification => {
  const found = schedule.find(n => n.key === key);
  assert.ok(found, `expected ${key} in the schedule`);
  return found;
};

function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 1. INHERIT IS NOT THE SAME AS OFF ---');
  {
    // Three identical events. One says nothing about reminders, one inherits a
    // category that does, one is explicitly silenced. Only the silenced one may
    // be missing from the centre.
    const events = {
      inherit: { id: 'inherit', weekKey: WEEK, dayIndex: 1, startTime: '10:00', content: 'Inherits the global default' },
      fromCat: { id: 'fromCat', weekKey: WEEK, dayIndex: 1, startTime: '10:00', content: 'Inherits Exams', categoryId: 'exams' },
      off: { id: 'off', weekKey: WEEK, dayIndex: 1, startTime: '10:00', content: 'Silenced', notify: { enabled: false, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' as const } },
    };
    const schedule = scheduleFor({ events });
    const now = at(2026, 8, 25, 12, 0);
    const view = buildCentre({ schedule, state: state(), now });

    assert.ok(view.entries.some(e => e.refId === 'inherit'), 'an event with no spec still reminds you');
    assert.ok(view.entries.some(e => e.refId === 'fromCat'), 'and one that inherits its category does too');
    assert.equal(view.entries.filter(e => e.refId === 'off').length, 0, 'an explicit off is silent');

    // The distinction itself, at the coercion boundary. If this ever returns a
    // spec, every item in the database becomes "configured" and inheritance is
    // gone for good.
    assert.equal(coerceNotifySpec(undefined), undefined, 'undefined in, undefined out');
    assert.equal(coerceNotifySpec(null), undefined, 'and null is not a configuration either');
    assert.deepEqual(coerceNotifySpec({ enabled: false, rules: [] })?.enabled, false, 'off survives coercion');

    // Inheriting the Exams category means inheriting critical, which the centre
    // has to surface: an unread critical is the one thing that may not be quiet.
    const critical = byKey(view.entries, `event:fromCat:2026-08-25:-30`);
    assert.equal(critical.priority, 'critical');
    assert.equal(critical.unread, true);
    assert.equal(view.unreadCritical, 1, 'the badge knows one of them is critical');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 2. MOVING AN EVENT DOES NOT RESURRECT A FIRED REMINDER ---');
  {
    const before = scheduleFor({
      events: { m1: { id: 'm1', weekKey: WEEK, dayIndex: 1, startTime: '09:00', content: 'Standup', notify: spec([-15]) } },
    });
    const key = 'event:m1:2026-08-25:-15';
    assert.equal(before.length, 1);
    assert.equal(before[0].key, key);
    assert.equal(before[0].fireAt, at(2026, 8, 25, 8, 45));

    // It fires, the user has not read it yet, and only then is the event dragged
    // to the afternoon.
    const firedAt = at(2026, 8, 25, 8, 45);
    let s = recordFired(state(), before, { now: firedAt });

    const after = scheduleFor({
      events: { m1: { id: 'm1', weekKey: WEEK, dayIndex: 1, startTime: '15:00', content: 'Standup', notify: spec([-15]) } },
    });
    assert.equal(after[0].key, key, 'THE KEY IS UNCHANGED: it is built from the offset, not the time');
    assert.equal(after[0].fireAt, at(2026, 8, 25, 14, 45), 'even though the fire time moved six hours');

    const now = at(2026, 8, 25, 9, 30);
    const view = buildCentre({ schedule: after, state: s, now });
    const entry = byKey(view.entries, key);
    assert.equal(entry.status, 'fired', 'it already happened, so it stays in the past');
    assert.equal(entry.at, firedAt, 'pinned to when it actually reached the user');
    assert.equal(entry.moved, true, 'and flagged, because the times no longer agree');
    assert.equal(entry.scheduledAt, at(2026, 8, 25, 14, 45), 'while still reporting where the item now is');
    assert.equal(view.upcomingCount, 0, 'it is NOT also listed as something still to come');
    assert.match(statusLine(entry, now), /moved since/);

    // Reading it handles the key, so the moved event does not re-arm it.
    s = markRead(s, [key], { now: at(2026, 8, 25, 9, 31) });
    assert.equal(handledKeys(s, now).has(key), true);
    const plan = planAlarms([], desiredAlarms(after, s, { now }), { now, handledKeys: handledKeys(s, now) });
    assert.equal(plan.schedule.length, 0, 'nothing is re-armed for a reminder already dealt with');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 3. A REMINDER WHOSE ITEM HAS BEEN DELETED ---');
  {
    const schedule = scheduleFor({
      events: { d1: { id: 'd1', weekKey: WEEK, dayIndex: 1, startTime: '09:00', content: 'Dentist', notify: spec([0]) } },
    });
    const key = 'event:d1:2026-08-25:0';
    const firedAt = at(2026, 8, 25, 9, 0);
    const s = recordFired(state(), schedule, { now: firedAt });

    // The event is deleted an hour later. The schedule no longer mentions it.
    const now = at(2026, 8, 25, 10, 0);
    const view = buildCentre({ schedule: [], state: s, now });
    const entry = byKey(view.entries, key);
    assert.equal(entry.orphan, true, 'drawn from the snapshot the mark kept');
    assert.equal(entry.title, 'Dentist', 'and it still knows what woke you up');
    assert.equal(entry.unread, true, 'deleting the event does not un-ring the bell');

    // A mark with neither a schedule row nor a snapshot cannot be described, and
    // an unnamed row is worse than no row.
    const nameless: NotifyCentreState = { marks: { 'event:gone:2026-08-25:0': { key: 'event:gone:2026-08-25:0', at: now, read: true } }, updatedAt: now };
    assert.equal(buildCentre({ schedule: [], state: nameless, now }).entries.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 4. ONE OCCURRENCE OF A REPEAT, NOT THE WHOLE SERIES ---');
  {
    const schedule = scheduleFor({
      events: {
        r1: {
          id: 'r1', weekKey: WEEK, dayIndex: 1, startTime: '07:00', content: 'Run',
          notify: spec([0]),
          recur: { freq: 'daily' as const, interval: 1, end: { count: 4 } },
        },
      },
    });
    const keys = schedule.map(n => n.key);
    assert.deepEqual(keys, [
      'event:r1:2026-08-25:0', 'event:r1:2026-08-26:0', 'event:r1:2026-08-27:0', 'event:r1:2026-08-28:0',
    ], 'the date is in the key, which is what makes one occurrence addressable');

    const now = at(2026, 8, 25, 7, 30);
    const s = dismiss(state(), ['event:r1:2026-08-25:0'], { now, items: schedule });

    const view = buildCentre({ schedule, state: s, now });
    assert.equal(byKey(view.entries, 'event:r1:2026-08-25:0').dismissed, true);
    for (const key of keys.slice(1)) {
      const e = byKey(view.entries, key);
      assert.equal(e.status, 'upcoming', `${key} is untouched`);
      assert.equal(e.dismissed, false);
    }
    const handled = handledKeys(s, now);
    assert.deepEqual([...handled], ['event:r1:2026-08-25:0'], 'exactly one key is handled');

    // Tomorrow's run still fires.
    const tomorrow = at(2026, 8, 26, 7, 1);
    const later = buildCentre({ schedule, state: s, now: tomorrow });
    assert.equal(byKey(later.entries, 'event:r1:2026-08-26:0').unread, true);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 5. ALL-DAY ITEMS ANCHOR AT 08:00, NOT MIDNIGHT ---');
  {
    const schedule = scheduleFor({
      events: {
        a1: { id: 'a1', weekKey: WEEK, dayIndex: 2, allDay: true, daysSpan: 1, content: 'Mum birthday', notify: spec([0, -1440, -720]) },
      },
    });
    const onTheDay = fire(schedule, 'event:a1:2026-08-26:0');
    assert.equal(onTheDay.fireAt, at(2026, 8, 26, 8, 0), 'the anchor is allDayHour');
    assert.equal(fire(schedule, 'event:a1:2026-08-26:-1440').fireAt, at(2026, 8, 25, 8, 0),
      'a day before is 08:00 the morning before, which falls out of the anchor');
    assert.equal(fire(schedule, 'event:a1:2026-08-26:-720').fireAt, at(2026, 8, 25, 20, 0),
      'and twelve hours before is the night before');

    const now = at(2026, 8, 26, 9, 0);
    const view = buildCentre({ schedule, state: state(), now });
    const entry = byKey(view.entries, 'event:a1:2026-08-26:0');
    assert.equal(entry.allDay, true);
    assert.equal(entry.status, 'fired');
    // The three reminders for the same day are three separate rows, because the
    // user set three and hiding two would look like the app forgot them.
    assert.equal(view.entries.filter(e => e.refId === 'a1').length, 3);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 6. UNDATED TASKS ARRIVE AS ONE DIGEST AT THE CUTOFF ---');
  {
    const schedule = scheduleFor({
      tasks: {
        t1: { id: 't1', weekKey: WEEK, dayIndex: 1, title: 'Buy milk' },
        t2: { id: 't2', weekKey: WEEK, dayIndex: 1, title: 'Call the bank' },
        t3: { id: 't3', weekKey: WEEK, dayIndex: 1, title: 'Already done', completed: true },
        t4: { id: 't4', weekKey: WEEK, dayIndex: 1, startTime: '11:00', title: 'Timed one' },
      },
    });
    const digests = schedule.filter(n => n.kind === 'task-digest' && n.occDate === '2026-08-25');
    assert.equal(digests.length, 1, 'one digest, never one alert per task');
    assert.equal(digests[0].fireAt, at(2026, 8, 25, 21, 0), 'at taskCutoffHour');
    assert.equal(digests[0].key, 'task-digest:2026-08-25');
    assert.ok(!digests[0].body.includes('Already done'), 'a finished task is not nagged about');
    assert.ok(!digests[0].body.includes('Timed one'), 'and a timed task alerts on its own instead');

    const now = at(2026, 8, 25, 21, 30);
    const s = snooze(state(), [digests[0].key], 30, { now, items: schedule });
    const view = buildCentre({ schedule, state: s, now });
    const entry = byKey(view.entries, 'task-digest:2026-08-25');
    assert.equal(entry.kind, 'task-digest');
    assert.equal(entry.status, 'snoozed');
    assert.equal(entry.at, now + 30 * 60_000);
    assert.equal(entry.unread, false, 'a snoozed row is not sitting unread in the meantime');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 7. PRAYERS ---');
  {
    const prayerMonth: PrayerMonth = {
      '2026-08-25': { fajr: '04:30', sunrise: '06:00', dhuhr: '12:30', asr: '16:00', maghrib: '19:00', isha: '20:30' },
    };
    const schedule = scheduleFor({
      settings: coerceNotificationSettings({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        prayer: { enabled: true, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' },
      }),
      prayerMonths: { '2026-08': prayerMonth },
      prayerSettings: coercePrayerSettings({
        enabled: true, city: 'London', country: 'UK', method: 2, school: 0, color: '#10b981',
      }),
      from: at(2026, 8, 25),
      to: at(2026, 8, 26),
    });
    const fajr = schedule.find(n => n.kind === 'prayer' && n.refId === 'fajr');
    assert.ok(fajr, 'fajr is scheduled');
    assert.equal(fajr.fireAt, at(2026, 8, 25, 4, 30), 'at its own time, with no duration involved');
    assert.equal(fajr.key, 'prayer:fajr:2026-08-25:0');

    const now = at(2026, 8, 25, 13, 0);
    const view = buildCentre({ schedule, state: state(), now });
    const entry = byKey(view.entries, fajr.key);
    assert.equal(entry.kind, 'prayer');
    assert.equal(entry.color, '#10b981', 'prayers keep their own colour, which is not a category');
    assert.equal(entry.status, 'fired');

    // Dhuhr has passed, Asr has not: one list, two senses of time.
    assert.equal(byKey(view.entries, 'prayer:dhuhr:2026-08-25:0').status, 'fired');
    assert.equal(byKey(view.entries, 'prayer:asr:2026-08-25:0').status, 'upcoming');
    assert.ok(view.nowIndex > 0 && view.nowIndex < view.entries.length, 'the now line sits between them');
    assert.ok(view.entries[view.nowIndex - 1].at <= now && view.entries[view.nowIndex].at > now);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 8. SNOOZING ---');
  {
    const now = at(2026, 8, 25, 9, 0);
    const items = [
      row({ key: 'event:s1:2026-08-25:0', fireAt: at(2026, 8, 25, 9, 0), refId: 's1', title: 'First' }),
      row({ key: 'event:s1:2026-08-25:-30', fireAt: at(2026, 8, 25, 8, 30), refId: 's1', title: 'First' }),
      row({ key: 'event:s1:2026-08-25:360', fireAt: at(2026, 8, 25, 15, 0), refId: 's1', title: 'Later today' }),
      row({ key: 'event:s1:2026-08-26:0', fireAt: at(2026, 8, 26, 9, 0), refId: 's1', title: 'Second day' }),
    ];

    // A plain snooze moves the row and un-handles the key.
    let s = snooze(state(), ['event:s1:2026-08-25:0'], 15, { now, items });
    let view = buildCentre({ schedule: items, state: s, now });
    let entry = byKey(view.entries, 'event:s1:2026-08-25:0');
    assert.equal(entry.status, 'snoozed');
    assert.equal(entry.snoozedUntil, now + 15 * 60_000);
    assert.equal(entry.snoozeCount, 1);
    assert.equal(handledKeys(s, now).has('event:s1:2026-08-25:0'), false, 'a snooze asks to be told again');
    assert.equal(entry.snoozedPastNext, false, 'fifteen minutes is nowhere near tomorrow');
    assert.match(statusLine(entry, now), /Snoozed, back in 15 mins/);

    // The OS alarm must move with it, and only it.
    const alarms = desiredAlarms(items, s, { now });
    assert.equal(alarms.find(a => a.key === 'event:s1:2026-08-25:0')?.fireAt, now + 15 * 60_000);
    assert.equal(alarms.find(a => a.key === 'event:s1:2026-08-26:0')?.fireAt, at(2026, 8, 26, 9, 0));

    // Snoozing past the NEXT occurrence is allowed and said out loud, because
    // the two will otherwise arrive together and read as a duplicate.
    // Eight hours, which lands past this evening's reminder for the same event.
    // The model caps a snooze at twelve hours, exactly as the PC does, so this
    // is also the largest gap that can be tested honestly.
    s = snooze(s, ['event:s1:2026-08-25:0'], 480, { now, items });
    view = buildCentre({ schedule: items, state: s, now });
    entry = byKey(view.entries, 'event:s1:2026-08-25:0');
    assert.equal(entry.snoozedPastNext, true);
    assert.equal(entry.snoozeCount, 2, 'and the app admits how many times you have done this');
    assert.match(statusLine(entry, now), /past the next one/);
    assert.equal(entry.at, at(2026, 8, 25, 17, 0));
    // The other reminders for the same event are untouched by this one's snooze.
    assert.equal(byKey(view.entries, 'event:s1:2026-08-25:360').snoozedUntil, undefined);
    assert.equal(byKey(view.entries, 'event:s1:2026-08-26:0').snoozedUntil, undefined);
    // And the cap is real: nobody gets to snooze something into next week.
    const capped = snooze(state(), ['event:s1:2026-08-25:0'], 10_000, { now, items });
    assert.equal(capped.marks['event:s1:2026-08-25:0'].snoozedUntil, now + 720 * 60_000);

    // Snoozing something already dismissed revives it. Asking to be reminded is
    // only ever a statement about the future.
    let d = dismiss(state(), ['event:s1:2026-08-25:-30'], { now, items });
    assert.equal(handledKeys(d, now).has('event:s1:2026-08-25:-30'), true);
    d = snooze(d, ['event:s1:2026-08-25:-30'], 10, { now: now + 1000, items });
    const revived = byKey(buildCentre({ schedule: items, state: d, now: now + 1000 }).entries, 'event:s1:2026-08-25:-30');
    assert.equal(revived.dismissed, false, 'the dismissal is lifted');
    assert.equal(revived.read, false);
    assert.equal(revived.status, 'snoozed');
    assert.equal(handledKeys(d, now + 1000).has('event:s1:2026-08-25:-30'), false);

    // A snooze whose item then vanishes still fires, from the snapshot.
    const orphanAlarms = desiredAlarms([], d, { now: now + 1000 });
    assert.equal(orphanAlarms.length, 1);
    assert.equal(orphanAlarms[0].key, 'event:s1:2026-08-25:-30');
    assert.equal(orphanAlarms[0].fireAt, now + 1000 + 10 * 60_000);

    // An expired snooze simply becomes a fired row again, unread.
    const later = buildCentre({ schedule: items, state: d, now: now + 20 * 60_000 });
    const back = byKey(later.entries, 'event:s1:2026-08-25:-30');
    assert.equal(back.status, 'fired');
    assert.equal(back.unread, true);
    assert.equal(handledKeys(d, now + 20 * 60_000).has('event:s1:2026-08-25:-30'), false);

    // Cancelling a snooze puts the row back where the schedule says it belongs.
    const cancelled = unsnooze(d, ['event:s1:2026-08-25:-30'], { now: now + 1000 });
    assert.equal(byKey(buildCentre({ schedule: items, state: cancelled, now }).entries, 'event:s1:2026-08-25:-30').at,
      at(2026, 8, 25, 8, 30));
    assert.deepEqual(unsnooze(EMPTY_CENTRE_STATE, ['nothing-here'], { now }), EMPTY_CENTRE_STATE,
      'unsnoozing something that was never snoozed changes nothing');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 9. QUIET HOURS, INCLUDING ACROSS MIDNIGHT ---');
  {
    const quiet: NotificationSettings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      quietHoursEnabled: true,
      quietFromH: 23,
      quietToH: 7,
    };
    const now = at(2026, 8, 25, 22, 0);
    const items = [
      row({ key: 'event:q1:2026-08-25:0', fireAt: at(2026, 8, 25, 23, 30), title: 'Late one' }),
      row({ key: 'event:q2:2026-08-26:0', fireAt: at(2026, 8, 26, 2, 0), title: 'After midnight' }),
      row({ key: 'event:q3:2026-08-26:0', fireAt: at(2026, 8, 26, 9, 0), title: 'Morning' }),
      row({ key: 'event:q4:2026-08-26:0', fireAt: at(2026, 8, 26, 1, 0), title: 'Emergency', priority: 'critical' }),
    ];
    const view = buildCentre({ schedule: items, state: state(), now, settings: quiet });

    const held = byKey(view.entries, 'event:q1:2026-08-25:0');
    assert.equal(held.quietUntil, at(2026, 8, 26, 7, 0), '23:30 is held to 07:00 the next morning');
    assert.equal(held.at, at(2026, 8, 26, 7, 0));
    assert.match(statusLine(held, now), /^Held for quiet hours/);

    const afterMidnight = byKey(view.entries, 'event:q2:2026-08-26:0');
    assert.equal(afterMidnight.quietUntil, at(2026, 8, 26, 7, 0),
      'the window wraps past midnight, so 02:00 is still inside it and releases the same morning');

    assert.equal(byKey(view.entries, 'event:q3:2026-08-26:0').quietUntil, undefined, '09:00 is outside the window');
    assert.equal(byKey(view.entries, 'event:q4:2026-08-26:0').quietUntil, undefined,
      'critical ignores quiet hours entirely, which is the whole point of critical');

    // The alarms move with the list, so what you are shown is what will happen.
    const alarms = desiredAlarms(items, state(), { now, settings: quiet });
    assert.equal(alarms.find(a => a.key === 'event:q1:2026-08-25:0')?.fireAt, at(2026, 8, 26, 7, 0));
    assert.equal(alarms.find(a => a.key === 'event:q4:2026-08-26:0')?.fireAt, at(2026, 8, 26, 1, 0));

    // With quiet hours off, nothing is held. Same inputs, one switch.
    const loud = buildCentre({ schedule: items, state: state(), now, settings: { ...quiet, quietHoursEnabled: false } });
    assert.equal(byKey(loud.entries, 'event:q1:2026-08-25:0').at, at(2026, 8, 25, 23, 30));

    // A window with equal ends is not a window, and must not swallow the day.
    const degenerate = buildCentre({ schedule: items, state: state(), now, settings: { ...quiet, quietFromH: 7, quietToH: 7 } });
    assert.equal(byKey(degenerate.entries, 'event:q1:2026-08-25:0').quietUntil, undefined);

    // A snooze is an explicit instruction and is never delayed further, even
    // into the middle of the night.
    const snoozed = snooze(state(), ['event:q3:2026-08-26:0'], 60, { now: at(2026, 8, 25, 23, 10), items });
    const snoozedAlarm = desiredAlarms(items, snoozed, { now: at(2026, 8, 25, 23, 10), settings: quiet })
      .find(a => a.key === 'event:q3:2026-08-26:0');
    assert.equal(snoozedAlarm?.fireAt, at(2026, 8, 26, 0, 10), 'asked for an hour, gets an hour');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 10. A PHONE THAT WAS AWAY FOR DAYS ---');
  {
    // Five days of a daily reminder, and the phone comes back on the fifth.
    const schedule = scheduleFor({
      events: {
        w1: {
          id: 'w1', weekKey: WEEK, dayIndex: 1, startTime: '08:00', content: 'Take the tablets',
          notify: spec([0]),
          recur: { freq: 'daily' as const, interval: 1, end: { count: 5 } },
        },
      },
    });
    assert.equal(schedule.length, 5);

    const now = at(2026, 8, 29, 12, 0);
    const view = buildCentre({ schedule, state: state(), now });

    // Everything before now is history; nothing is lost and nothing is invented.
    assert.equal(view.firedCount, 5);
    assert.equal(view.upcomingCount, 0);
    assert.equal(view.unread, 5, 'all five are still waiting to be looked at');

    // catchUpHours is 12 by default, so only the most recent day was close
    // enough to have been worth alerting about on wake.
    const missed = view.entries.filter(e => e.missed).map(e => e.occDate);
    assert.deepEqual(missed, ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28'],
      'the older four are recorded silently rather than arriving as a burst of stale alarms');
    assert.equal(byKey(view.entries, 'event:w1:2026-08-29:0').missed, false, 'today is within the catch-up window');
    assert.match(statusLine(byKey(view.entries, 'event:w1:2026-08-25:0'), now), /Missed while you were away/);

    // Grouped by day, oldest first, with today called out by name.
    assert.deepEqual(view.groups.map(g => g.id),
      ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29']);
    assert.equal(view.groups[4].label, 'Today');
    assert.equal(view.groups[3].label, 'Yesterday');
    assert.equal(view.groups[0].label, 'Tue 25 Aug');
    assert.deepEqual(view.groups.map(g => g.relative), ['past', 'past', 'past', 'past', 'today']);
    assert.equal(view.groups[4].unread, 1);
    assert.equal(view.nowIndex, view.entries.length, 'with nothing ahead, the now line is at the very bottom');

    // An alarm that fired late while the phone was catching up is labelled as
    // such rather than pretending it was on time.
    const lateState = recordFired(state(), [schedule[4]], { now: at(2026, 8, 29, 8, 20) });
    const lateEntry = byKey(buildCentre({ schedule, state: lateState, now }).entries, 'event:w1:2026-08-29:0');
    assert.equal(lateEntry.late, true);
    assert.equal(lateEntry.at, at(2026, 8, 29, 8, 20));
    assert.match(statusLine(lateEntry, now), /Arrived late/);

    // Nothing older than the past window is carried around forever.
    const ancient = buildCentre({ schedule, state: state(), now: at(2026, 9, 10, 12, 0) });
    assert.equal(ancient.entries.length, 0);
    assert.equal(ancient.trimmed, 5);
    assert.deepEqual(emptyMessage(ancient, 'all'), {
      title: 'All quiet',
      hint: 'Nothing has fired and nothing is due. Add a reminder to an event or a task and it will show up here before it arrives.',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 11. TWO DEVICES, ONE KEY, NO COORDINATOR ---');
  {
    const now = at(2026, 8, 25, 9, 0);
    const items = [row({ key: 'event:c1:2026-08-25:0', fireAt: now, title: 'Both of us' })];
    const base = recordFired(state(), items, { now, by: 'phone' });

    // Both devices dismiss it in the same millisecond, neither having heard of
    // the other. The answer has to be the same on both, whichever way round the
    // merge happens to run.
    const phone = dismiss(base, ['event:c1:2026-08-25:0'], { now: now + 5_000, by: 'phone' });
    const pc = dismiss(base, ['event:c1:2026-08-25:0'], { now: now + 5_000, by: 'pc' });
    const ab = mergeCentreState(phone, pc);
    const ba = mergeCentreState(pc, phone);
    assert.deepEqual(ab, ba, 'the merge is commutative, so the two devices converge');
    assert.equal(ab.marks['event:c1:2026-08-25:0'].dismissedAt, now + 5_000);
    assert.equal(ab.marks['event:c1:2026-08-25:0'].by, 'phone', 'the tie is broken by device id, not by luck');
    assert.equal(handledKeys(ab, now + 6_000).has('event:c1:2026-08-25:0'), true);

    // A later decision beats an earlier one, whichever device made it.
    const readOnPc = markRead(base, ['event:c1:2026-08-25:0'], { now: now + 1_000, by: 'pc' });
    const snoozedOnPhone = snooze(base, ['event:c1:2026-08-25:0'], 10, { now: now + 9_000, by: 'phone' });
    const merged = mergeCentreState(readOnPc, snoozedOnPhone);
    assert.deepEqual(merged, mergeCentreState(snoozedOnPhone, readOnPc));
    assert.equal(merged.marks['event:c1:2026-08-25:0'].snoozedUntil, now + 9_000 + 10 * 60_000,
      'the newer snooze wins over the older read');
    assert.equal(merged.marks['event:c1:2026-08-25:0'].read, false);

    // Facts union rather than being decided: the earliest delivery is the real
    // one, and completing something on either device is permanent.
    const firedEarly = recordFired(state(), items, { now: now - 60_000, by: 'pc' });
    const firedLate = recordFired(state(), items, { now: now + 60_000, by: 'phone' });
    const factMerge = mergeCentreState(firedEarly, markCompleted(firedLate, ['event:c1:2026-08-25:0'], { now, by: 'phone' }));
    assert.equal(factMerge.marks['event:c1:2026-08-25:0'].firedAt, now - 60_000);
    assert.equal(factMerge.marks['event:c1:2026-08-25:0'].completed, true);
    assert.deepEqual(factMerge, mergeCentreState(markCompleted(firedLate, ['event:c1:2026-08-25:0'], { now, by: 'phone' }), firedEarly));

    // A key only one side has ever heard of survives untouched.
    const lonely = dismiss(state(), ['event:only:2026-08-25:0'], { now, by: 'phone', items: [row({ key: 'event:only:2026-08-25:0', fireAt: now })] });
    const wide = mergeCentreState(lonely, ab);
    assert.equal(Object.keys(wide.marks).length, 2);
    assert.deepEqual(wide, mergeCentreState(ab, lonely));

    // Recording the same delivery twice must not move the row.
    const twice = recordFired(recordFired(state(), items, { now }), items, { now: now + 30_000 });
    assert.equal(twice.marks['event:c1:2026-08-25:0'].firedAt, now, 'the first delivery is the truth');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 12. READ, UNREAD, AND WHAT THE BADGE COUNTS ---');
  {
    const now = at(2026, 8, 25, 12, 0);
    const items = [
      row({ key: 'event:p1:2026-08-25:0', fireAt: at(2026, 8, 25, 9, 0), title: 'Past' }),
      row({ key: 'event:p2:2026-08-25:0', fireAt: at(2026, 8, 25, 11, 0), title: 'Also past' }),
      row({ key: 'event:f1:2026-08-25:0', fireAt: at(2026, 8, 25, 15, 0), title: 'Future' }),
      row({ key: 'event:f2:2026-08-26:0', fireAt: at(2026, 8, 26, 9, 0), title: 'Tomorrow' }),
    ];
    let s = state();
    let view = buildCentre({ schedule: items, state: s, now });
    assert.equal(view.unread, 2, 'only what has already fired can be unread');
    assert.equal(view.upcomingCount, 2, 'the future is never unread, or the badge would never reach zero');
    assert.equal(view.nextAt, at(2026, 8, 25, 15, 0));

    // Opening the screen is NOT reading it. Deliberately: this list is opened to
    // see what is coming as often as to triage what arrived, and silently
    // zeroing the badge would destroy the only record that something fired while
    // the phone was in a pocket. Marking read is always an explicit act.
    s = markRead(s, ['event:p1:2026-08-25:0'], { now, by: 'phone', items });
    view = buildCentre({ schedule: items, state: s, now });
    assert.equal(view.unread, 1);
    assert.equal(byKey(view.entries, 'event:p1:2026-08-25:0').read, true);
    assert.equal(byKey(view.entries, 'event:p1:2026-08-25:0').readBy, 'phone');

    // Mark all read touches what has fired and nothing else, so tomorrow's
    // reminder is still armed afterwards.
    s = markAllRead(s, view, { now, by: 'phone', items });
    view = buildCentre({ schedule: items, state: s, now });
    assert.equal(view.unread, 0);
    const handled = handledKeys(s, now);
    assert.equal(handled.has('event:f1:2026-08-25:0'), false, 'the future was not quietly handled');
    assert.equal(handled.has('event:f2:2026-08-26:0'), false);
    assert.equal(planAlarms([], desiredAlarms(items, s, { now }), { now, handledKeys: handled }).schedule.length, 2,
      'both future alarms survive being caught up on the past');

    // Unread puts it back, and un-handles it, or the alarm would never return.
    s = markUnread(s, ['event:p2:2026-08-25:0'], { now: now + 1_000, by: 'phone' });
    view = buildCentre({ schedule: items, state: s, now });
    assert.equal(view.unread, 1);
    assert.equal(handledKeys(s, now).has('event:p2:2026-08-25:0'), false);

    // Completing something reads and handles it in one go.
    s = markCompleted(s, ['event:p2:2026-08-25:0'], { now: now + 2_000, by: 'phone' });
    view = buildCentre({ schedule: items, state: s, now });
    assert.equal(byKey(view.entries, 'event:p2:2026-08-25:0').completed, true);
    assert.equal(view.unread, 0);
    assert.equal(handledKeys(s, now).has('event:p2:2026-08-25:0'), true);

    // Filters rebuild the day headings rather than leaving empty ones behind.
    const unreadOnly = filterView(buildCentre({ schedule: items, state: state(), now }), 'unread', now);
    assert.equal(unreadOnly.entries.length, 2);
    assert.equal(unreadOnly.groups.length, 1);
    assert.equal(unreadOnly.groups[0].label, 'Today');
    const upcomingOnly = filterView(buildCentre({ schedule: items, state: state(), now }), 'upcoming', now);
    assert.deepEqual(upcomingOnly.groups.map(g => g.label), ['Today', 'Tomorrow']);
    assert.equal(upcomingOnly.nowIndex, 0, 'with nothing behind it, the now line is at the top');
    assert.equal(filterView(unreadOnly, 'all', now), unreadOnly, 'the all filter is a no-op');

    // The empty states say something true, and which one depends on the view.
    const nothingUnread = filterView(buildCentre({ schedule: items, state: markAllRead(state(), view, { now }), now }), 'unread', now);
    assert.equal(emptyMessage(nothingUnread, 'unread').title, 'Nothing waiting on you');
    assert.match(emptyMessage(nothingUnread, 'unread').hint, /2 reminders are still to come/);
    assert.equal(emptyMessage(buildCentre({ schedule: [], state: state(), now }), 'upcoming').title, 'Nothing coming up');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 13. WHAT THE OS IS ASKED TO HOLD ---');
  {
    const now = at(2026, 8, 25, 9, 0);
    const items = [
      row({ key: 'event:a:2026-08-25:0', fireAt: at(2026, 8, 25, 10, 0) }),
      row({ key: 'event:b:2026-08-25:0', fireAt: at(2026, 8, 25, 11, 0) }),
      row({ key: 'event:c:2026-08-25:0', fireAt: at(2026, 8, 25, 12, 0) }),
    ];
    const registered: RegisteredAlarm[] = [
      { key: 'event:a:2026-08-25:0', osId: 'os-a', fireAt: at(2026, 8, 25, 10, 0) },
      { key: 'event:b:2026-08-25:0', osId: 'os-b', fireAt: at(2026, 8, 25, 11, 0) },
      { key: 'event:c:2026-08-25:0', osId: 'os-c', fireAt: at(2026, 8, 25, 12, 0) },
    ];

    // Dismiss one and snooze another. The third must be left completely alone,
    // which is the invariant the whole alarm diff exists to protect.
    let s = dismiss(state(), ['event:a:2026-08-25:0'], { now, items });
    s = snooze(s, ['event:b:2026-08-25:0'], 30, { now, items });

    const plan = planAlarms(registered, desiredAlarms(items, s, { now }), {
      now, handledKeys: handledKeys(s, now),
    });
    assert.deepEqual(plan.keep.map(a => a.key), ['event:c:2026-08-25:0'], 'the untouched one is not churned');
    assert.deepEqual(plan.cancel.map(a => a.osId).sort(), ['os-a', 'os-b']);
    assert.deepEqual(plan.schedule.map(a => a.key), ['event:b:2026-08-25:0'], 'only the snoozed one is re-armed');
    assert.equal(plan.schedule[0].fireAt, now + 30 * 60_000);

    // A duplicated key in the schedule is a bug upstream, not two alarms.
    const dupes = [...items, row({ key: 'event:c:2026-08-25:0', fireAt: at(2026, 8, 25, 12, 0) })];
    assert.equal(desiredAlarms(dupes, state(), { now }).filter(a => a.key === 'event:c:2026-08-25:0').length, 1);
    assert.equal(buildCentre({ schedule: dupes, state: state(), now }).entries.filter(e => e.key === 'event:c:2026-08-25:0').length, 1);

    // Junk in the schedule is skipped rather than crashing the screen.
    const junk = [null, undefined, { key: '', fireAt: 1 }, { key: 'x', fireAt: Number.NaN }] as unknown as ScheduledNotification[];
    assert.equal(desiredAlarms(junk, state(), { now }).length, 0);
    assert.equal(buildCentre({ schedule: junk, state: state(), now }).entries.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 14. REACHING THE SERVER, AND FAILING TO ---');
  {
    const now = at(2026, 8, 25, 9, 0);
    const items = [
      row({ key: 'event:x:2026-08-25:0', fireAt: at(2026, 8, 25, 8, 0) }),
      row({ key: 'event:y:2026-08-25:0', fireAt: at(2026, 8, 25, 8, 30) }),
      row({ key: 'event:z:2026-08-25:0', fireAt: at(2026, 8, 25, 10, 0) }),
    ];
    let s = recordFired(state(), [items[0], items[1]], { now: at(2026, 8, 25, 8, 30), by: 'phone' });
    s = dismiss(s, ['event:x:2026-08-25:0'], { now, by: 'phone', items });
    s = snooze(s, ['event:z:2026-08-25:0'], 20, { now, by: 'phone', items });

    const payload = pendingSync(s, now);
    assert.deepEqual(payload.fired.sort(), ['event:x:2026-08-25:0', 'event:y:2026-08-25:0'],
      'the server is told what this phone delivered, so it does not send it again by push');
    assert.deepEqual(payload.read, ['event:x:2026-08-25:0'], 'a dismissal reaches the PC as a read');
    assert.deepEqual(payload.snoozed, [{ key: 'event:z:2026-08-25:0', minutes: 20 }],
      'and a snooze as a duration, because that is what the endpoint takes');
    assert.equal(payload.keys.length, 3);

    // Offline. Nothing is queued, so nothing can be lost: the payload is simply
    // recomputed later, and the snooze is re-based on the new now.
    const muchLater = now + 5 * 60_000;
    const again = pendingSync(s, muchLater);
    assert.deepEqual(again.snoozed, [{ key: 'event:z:2026-08-25:0', minutes: 15 }],
      'five minutes have gone by, so fifteen are left, not twenty');
    assert.deepEqual(again.read, payload.read, 'and everything else is unchanged, however long it took');

    // It lands. Only marks untouched since the request went out are stamped.
    const sent = markSynced(s, payload.keys, { now: now + 1_000, sentAt: now });
    assert.deepEqual(pendingSync(sent, now + 1_000).keys, [], 'nothing is sent twice');

    // A decision made WHILE the request was in flight is not lost to it.
    const raced = markUnread(s, ['event:y:2026-08-25:0'], { now: now + 500, by: 'phone' });
    const stamped = markSynced(raced, payload.keys, { now: now + 1_000, sentAt: now });
    assert.deepEqual(pendingSync(stamped, now + 1_000).unread, ['event:y:2026-08-25:0'],
      'the change that raced the request is still waiting to be sent');

    // Adopting the PC's store: a read taken on the desk arrives, and a dismissal
    // taken on the phone a second ago is not resurrected by it.
    const serverStore: NotificationStore = {
      updatedAt: now,
      items: {
        'event:y:2026-08-25:0': {
          ...items[1], firedAt: at(2026, 8, 25, 8, 30), lastAlertAt: at(2026, 8, 25, 8, 30), alerts: 1,
          read: true, readAt: now - 30_000, readBy: 'pc',
        },
        'event:x:2026-08-25:0': {
          ...items[0], firedAt: at(2026, 8, 25, 8, 0), lastAlertAt: at(2026, 8, 25, 8, 0), alerts: 1,
        },
      },
    };
    const adopted = mergeCentreState(s, centreStateFromServer(serverStore));
    assert.equal(adopted.marks['event:y:2026-08-25:0'].read, true, 'read on the PC is read on the phone');
    assert.equal(adopted.marks['event:y:2026-08-25:0'].by, 'pc');
    assert.equal(adopted.marks['event:x:2026-08-25:0'].dismissedAt, now,
      'and the older server record does not undo a dismissal made here a moment ago');
    assert.deepEqual(adopted, mergeCentreState(centreStateFromServer(serverStore), s));

    const view = buildCentre({ schedule: items, state: adopted, now });
    assert.equal(view.unread, 0, 'between the two devices, everything that fired has been seen');
    assert.equal(byKey(view.entries, 'event:y:2026-08-25:0').readBy, 'pc', 'and the screen can say where');

    // An empty or missing server store is not an instruction to forget anything.
    assert.deepEqual(centreStateFromServer(null), { marks: {}, updatedAt: 0 });
    assert.deepEqual(mergeCentreState(s, centreStateFromServer(undefined)), s);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 15. CLEARING, PRUNING, AND JUNK ON DISK ---');
  {
    const now = at(2026, 8, 25, 12, 0);
    const items = [row({ key: 'event:k:2026-08-25:0', fireAt: at(2026, 8, 25, 9, 0), title: 'Cleared one' })];

    // Clearing has to leave a tombstone, or the schedule rebuilds the row on the
    // very next render and the swipe looks like it did nothing.
    const cleared = clearEntries(state(), ['event:k:2026-08-25:0'], { now, items });
    assert.equal(buildCentre({ schedule: items, state: cleared, now }).entries.length, 0);
    assert.equal(handledKeys(cleared, now).has('event:k:2026-08-25:0'), true);
    assert.deepEqual(pendingSync(cleared, now).cleared, ['event:k:2026-08-25:0']);

    // Snoozing a cleared row brings it back, with its description intact.
    const revived = snooze(cleared, ['event:k:2026-08-25:0'], 5, { now: now + 1_000 });
    const back = byKey(buildCentre({ schedule: [], state: revived, now: now + 1_000 }).entries, 'event:k:2026-08-25:0');
    assert.equal(back.title, 'Cleared one');
    assert.equal(back.status, 'snoozed');

    // Pruning drops what has scrolled out of existence, and never drops a live
    // snooze however old the thing behind it is.
    const old = recordFired(state(), [row({ key: 'event:old:2026-01-01:0', fireAt: at(2026, 1, 1, 9, 0) })], { now: at(2026, 1, 1, 9, 0) });
    const mixed = mergeCentreState(old, revived);
    const pruned = pruneCentreState(mixed, { now: now + 1_000 });
    assert.equal(Object.keys(pruned.marks).includes('event:old:2026-01-01:0'), false);
    assert.equal(Object.keys(pruned.marks).includes('event:k:2026-08-25:0'), true);
    const ancientSnooze = snooze(old, ['event:old:2026-01-01:0'], 60, { now });
    assert.equal(Object.keys(pruneCentreState(ancientSnooze, { now }).marks).length, 1,
      'a snooze you set is kept until it has actually happened');
    assert.equal(Object.keys(pruneCentreState(mixed, { now: now + 1_000, limit: 1 }).marks).length, 1,
      'and the cap keeps the newest');

    // Round trip through JSON, which is how it actually lives on the phone.
    const round = coerceCentreState(JSON.parse(JSON.stringify(revived)));
    assert.deepEqual(round.marks['event:k:2026-08-25:0'].snoozedUntil, revived.marks['event:k:2026-08-25:0'].snoozedUntil);
    assert.equal(round.marks['event:k:2026-08-25:0'].snapshot?.title, 'Cleared one');

    // Everything a corrupted or half-written file can throw at it.
    assert.deepEqual(coerceCentreState(null), { marks: {}, updatedAt: 0 });
    assert.deepEqual(coerceCentreState('nonsense'), { marks: {}, updatedAt: 0 });
    assert.deepEqual(coerceCentreState([1, 2, 3]), { marks: {}, updatedAt: 0 });
    assert.deepEqual(coerceCentreState({ marks: 'no' }), { marks: {}, updatedAt: 0 });
    assert.deepEqual(coerceCentreState({ marks: { a: null, b: 5, '': { read: true } } }).marks, {},
      'a mark with no key and a mark that is a number are both dropped');
    assert.deepEqual(coerceCentreState({ marks: { k: { at: 1 } } }).marks, {},
      'a mark recording no decision at all is noise, not state');
    assert.equal(coerceCentreState({ marks: { k: { read: true, at: 'soon', snapshot: { key: 'k' } } } }).marks.k.at, 0,
      'a non-numeric timestamp becomes the epoch rather than NaN, which would poison every comparison');
    assert.equal(coerceCentreState({ marks: { k: { read: true, at: 1, snapshot: { key: 'k', fireAt: 5, kind: 'weird' } } } })
      .marks.k.snapshot?.kind, 'event', 'an unknown kind falls back rather than rendering nothing');

    // A schedule and a state that are both empty is the normal first launch.
    const fresh = buildCentre({ schedule: [], state: EMPTY_CENTRE_STATE, now });
    assert.deepEqual(fresh.entries, []);
    assert.deepEqual(fresh.groups, []);
    assert.equal(fresh.unread, 0);
    assert.equal(fresh.nextAt, null);
    assert.equal(fresh.nowIndex, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('--- 16. WORDING, WINDOWS AND CAPS ---');
  {
    const now = at(2026, 8, 25, 12, 0);
    assert.equal(relativeLabel(now, now), 'just now');
    assert.equal(relativeLabel(now + 30_000, now), 'just now');
    assert.equal(relativeLabel(now + 60_000, now), 'in 1 min');
    assert.equal(relativeLabel(now - 60_000, now), '1 min ago');
    assert.equal(relativeLabel(now + 45 * 60_000, now), 'in 45 mins');
    assert.equal(relativeLabel(now - 3 * 3_600_000, now), '3 hours ago');
    assert.equal(relativeLabel(now + 3 * 86_400_000, now), 'in 3 days');
    assert.equal(relativeLabel(now - 21 * 86_400_000, now), '3 weeks ago');
    assert.equal(snoozeLabel(5), '5 min');
    assert.equal(snoozeLabel(60), '1 hour');
    assert.equal(snoozeLabel(120), '2 hours');
    assert.equal(snoozeLabel(90), '1.5 hours');

    // No em dashes or en dashes anywhere in what the user is shown.
    const strings = [
      snoozeLabel(90), relativeLabel(now, now),
      emptyMessage(buildCentre({ schedule: [], state: state(), now }), 'all').hint,
      emptyMessage(buildCentre({ schedule: [], state: state(), now }), 'unread').hint,
      emptyMessage(buildCentre({ schedule: [], state: state(), now }), 'upcoming').hint,
      statusLine(byKey(buildCentre({
        schedule: [row({ key: 'event:d:2026-08-25:0', fireAt: now - 60_000 })], state: state(), now,
      }).entries, 'event:d:2026-08-25:0'), now),
    ];
    for (const s of strings) {
      assert.ok(!s.includes('—') && !s.includes('–'), `no dashes in "${s}"`);
    }

    assert.equal(dayLabel(now, now), 'Today');
    assert.equal(dayLabel(now + 86_400_000, now), 'Tomorrow');
    assert.equal(dayLabel(now - 86_400_000, now), 'Yesterday');
    assert.equal(dayLabel(at(2026, 9, 2, 9, 0), now), 'Wed 2 Sep');

    // The windows are what stop a year of history rendering in one list.
    const wide = Array.from({ length: 40 }, (_, i) =>
      row({ key: `event:n${i}:2026-08-25:0`, fireAt: now - (i + 1) * 3_600_000, title: `#${i}` }));
    const capped = buildCentre({ schedule: wide, state: state(), now, maxEntries: 10 });
    assert.equal(capped.entries.length, 10);
    assert.equal(capped.trimmed, 30);
    assert.equal(capped.entries[capped.entries.length - 1].key, 'event:n0:2026-08-25:0',
      'the newest survives the cap, because that is the one still on screen');

    // Unread rows beat read ones when the cap has to choose.
    const half = wide.slice(0, 5);
    let readState = state();
    readState = markRead(readState, half.map(r => r.key), { now, items: wide });
    const preferUnread = buildCentre({ schedule: wide, state: readState, now, maxEntries: 5 });
    assert.equal(preferUnread.entries.every(e => e.unread), true, 'nothing unread is thrown away first');

    const narrow = buildCentre({ schedule: wide, state: state(), now, pastWindowMs: 2 * 3_600_000 });
    assert.equal(narrow.entries.length, 2);
    assert.ok(DEFAULT_PAST_WINDOW_MS > 0);
  }

  console.log('\nALL PASS (notify centre: inherit vs off, key stability, orphans, snooze, quiet hours, offline catch-up, two-device merge, alarms, server sync)');
}

main();
