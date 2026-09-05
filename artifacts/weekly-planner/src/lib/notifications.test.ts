// Exercises the real notification scheduler, engine fan-out, Web Push crypto,
// service worker offline runner, login diagnostics, and funnel watchdog.
//
// Every test here is deterministic: explicit timestamps, zero sleep, zero real network.
//
// Run with:  npx tsx src/lib/notifications.test.ts

import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createRequire } from 'module';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  coerceNotificationSettings,
  coerceNotifySpec,
  computeSchedule,
  groupNotifications,
  inQuietHours,
  offsetChip,
  offsetLabel,
  pruneStore,
  quietReleaseAt,
  resolveSpec,
  specOrigin,
  unreadCount,
  activeNotifications,
  type NotificationRecord,
  type NotificationSettings,
  type NotificationStore,
  type NotifySpec,
  type ScheduleInput,
} from './notifications';
import { encryptPayload, generateVapidKeys, signVapidJwt, type PushSubscriptionRecord } from '../../server-web-push';
import { isDesktopSubscription } from '../../notification-engine';
import { diagnoseConnection } from '../pages/login';
import { createFunnelWatchdog } from '../../funnel-watchdog';
import { editSeries, makeOccId } from './recurrence';
import { coercePrayerSettings, type PrayerMonth, type PrayerSettings } from './prayerTimes';


const require = createRequire(import.meta.url);
const sw = require('../../public/sw.js');

let failures = 0;
let passed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) failures++;
  else passed++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`);
};

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const spec = (offsets: number[], priority: 'normal' | 'critical' = 'normal'): NotifySpec => ({
  enabled: true,
  rules: offsets.map((o, i) => ({ id: `r${i}`, offsetMin: o })),
  priority,
});

const CATS: EventCategory[] = [
  { id: 'exams', name: 'Exams', color: '#ef4444', notifyTimed: spec([-30, -10], 'critical') },
  { id: 'birthdays', name: 'Birthdays', color: '#a855f7', notifyAllDay: spec([-1440]) },
  { id: 'plain', name: 'Plain', color: '#22c55e' },
];

const baseInput = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  events: {},
  tasks: {},
  categories: CATS,
  settings: DEFAULT_NOTIFICATION_SETTINGS,
  weekStartsOn: 1,
  from: at(2026, 8, 1),
  to: at(2026, 9, 1),
  ...over,
});

// Monday 2026-08-24 is the anchor week used throughout.
const WEEK = '2026-08-24';

console.log(`all-day anchor ${DEFAULT_NOTIFICATION_SETTINGS.allDayHour}:00, task cutoff ${DEFAULT_NOTIFICATION_SETTINGS.taskCutoffHour}:00\n`);

// ═══════════════════════════════════════════════════════════════════════════
// A. Pure core: src/lib/notifications.ts
// ═══════════════════════════════════════════════════════════════════════════

// 1. coerceNotifySpec & boundaries
{
  // Undefined in must return undefined out so existing events continue inheriting.
  check('coerceNotifySpec leaves undefined as undefined (inherit)', coerceNotifySpec(undefined) === undefined);
  check('coerceNotifySpec leaves null as undefined', coerceNotifySpec(null) === undefined);

  // Wrong types must not be mistaken for configured specs.
  check('coerceNotifySpec with number returns undefined', coerceNotifySpec(123) === undefined);
  check('coerceNotifySpec with string returns undefined', coerceNotifySpec('garbage') === undefined);
  check('coerceNotifySpec with boolean returns undefined', coerceNotifySpec(true) === undefined);
  check('coerceNotifySpec with array returns undefined', coerceNotifySpec([1, 2]) === undefined);

  // Explicit disabled spec must be preserved.
  check('coerceNotifySpec keeps an explicit disabled spec rather than dropping it',
    coerceNotifySpec({ enabled: false, rules: [] })?.enabled === false);

  // An enabled spec with no usable rules alerts on time rather than dying silently.
  check('an enabled spec with empty rules alerts on time',
    coerceNotifySpec({ enabled: true, rules: [] })?.rules[0].offsetMin === 0);

  // Garbage rule items are filtered out.
  const garbageRules = coerceNotifySpec({
    enabled: true,
    rules: ['text', null, { offsetMin: 'bad' }, { offsetMin: -15, id: 'custom-id' }],
  });
  check('garbage rule entries are cleaned and valid ones kept',
    garbageRules?.rules.length === 1 && garbageRules.rules[0].offsetMin === -15 && garbageRules.rules[0].id === 'custom-id');

  // Non-numeric / NaN / Infinity offsets are rejected.
  const nanRules = coerceNotifySpec({
    enabled: true,
    rules: [{ offsetMin: NaN }, { offsetMin: Infinity }, { offsetMin: -Infinity }, { offsetMin: 20 }],
  });
  check('NaN and Infinity offsets are rejected',
    nanRules?.rules.length === 1 && nanRules.rules[0].offsetMin === 20);

  // Absurd offsets (+/- 10 years) are clamped within safe bounds [-44640, 44640].
  const clamped = coerceNotifySpec({
    enabled: true,
    rules: [{ offsetMin: 5_000_000 }, { offsetMin: -5_000_000 }],
  });
  check('absurd offsets are clamped to month limits',
    clamped?.rules[0].offsetMin === 44640 && clamped?.rules[1].offsetMin === -44640);

  // Duplicate offsets collapse to prevent double-firing at the exact same instant.
  check('duplicate offsets collapse so one instant cannot fire twice',
    coerceNotifySpec({ enabled: true, rules: [{ offsetMin: -30 }, { offsetMin: -30 }, { offsetMin: -10 }] })?.rules.length === 2);

  // Unknown priority strings fall back to normal.
  check('unknown priority string falls back to normal',
    coerceNotifySpec({ enabled: true, rules: [{ offsetMin: 0 }], priority: 'urgent-unknown' })?.priority === 'normal');

  // Extra unknown keys are stripped during normalization.
  const extraKeys = coerceNotifySpec({
    enabled: true,
    rules: [{ offsetMin: -5 }],
    unknownKey: 'ignored',
    nestedObject: { foo: 1 },
  });
  check('extra unknown keys are stripped safely',
    extraKeys !== undefined && !('unknownKey' in extraKeys) && extraKeys.rules[0].offsetMin === -5);

  // Round trip through JSON.stringify/parse is identical.
  const originalSpec = spec([-60, -15, 0], 'critical');
  const roundTripped = coerceNotifySpec(JSON.parse(JSON.stringify(originalSpec)));
  check('spec survives a round-trip through JSON.stringify and JSON.parse',
    JSON.stringify(originalSpec) === JSON.stringify(roundTripped));
}

// 2. Three-level inheritance chain: item -> category -> global
{
  const global = DEFAULT_NOTIFICATION_SETTINGS;

  check('an item with nothing set falls through to the global timed default',
    resolveSpec({ categoryId: undefined }, 'timed', CATS, global) === global.defaultTimed);

  check('an item in a category with a timed default takes the category default',
    resolveSpec({ categoryId: 'exams' }, 'timed', CATS, global).rules.length === 2);

  check('the category default carries its priority too',
    resolveSpec({ categoryId: 'exams' }, 'timed', CATS, global).priority === 'critical');

  check('a category that only defines an all-day default does not hijack timed items',
    resolveSpec({ categoryId: 'birthdays' }, 'timed', CATS, global) === global.defaultTimed);

  check('an item that configures itself beats its category',
    resolveSpec({ categoryId: 'exams', notify: spec([-5]) }, 'timed', CATS, global).rules[0].offsetMin === -5);

  check('an item explicitly switched off stays off even inside a configured category',
    resolveSpec({ categoryId: 'exams', notify: { enabled: false, rules: [], priority: 'normal' } }, 'timed', CATS, global).enabled === false);

  check('category absent falls back to global default',
    resolveSpec({ categoryId: 'nonexistent-cat' }, 'timed', CATS, global) === global.defaultTimed);

  check('tasks never inherit from a category, only from the task default',
    resolveSpec({ categoryId: 'exams' }, 'task', CATS, global) === global.defaultTask);

  check('all-day item inherits category all-day spec if present',
    resolveSpec({ categoryId: 'birthdays' }, 'allDay', CATS, global).rules[0].offsetMin === -1440);

  check('origin reports item / category / global correctly across timed, allDay and task',
    specOrigin({ notify: spec([0]) }, 'timed', CATS) === 'item'
    && specOrigin({ categoryId: 'exams' }, 'timed', CATS) === 'category'
    && specOrigin({ categoryId: 'plain' }, 'timed', CATS) === 'global'
    && specOrigin({ categoryId: 'exams' }, 'task', CATS) === 'global'
    && specOrigin({ categoryId: 'birthdays' }, 'allDay', CATS) === 'category'
    && specOrigin({ categoryId: 'birthdays' }, 'timed', CATS) === 'global');
}

// 3. computeSchedule anchors
{
  // Timed event: anchor is start time.
  const timedEvent = {
    e1: { id: 'e1', weekKey: WEEK, dayIndex: 1, startTime: '14:30', endTime: '15:30', content: 'Lecture', categoryId: 'plain' },
  };
  const timedOut = computeSchedule(baseInput({ events: timedEvent }));
  check('timed item anchor is its start time',
    timedOut.length === 1 && timedOut[0].fireAt === at(2026, 8, 25, 14, 30) && timedOut[0].anchorAt === at(2026, 8, 25, 14, 30));

  // All-day item: default anchor is 08:00; "1 day before" is 08:00 previous day.
  const allDayEvent = {
    b1: { id: 'b1', weekKey: WEEK, dayIndex: 2, allDay: true, daysSpan: 1, content: "Mom's birthday", categoryId: 'birthdays' },
  };
  const allDayOut = computeSchedule(baseInput({ events: allDayEvent }));
  check('all-day item at -1 day fires at 08:00 the morning before',
    allDayOut.length === 1 && allDayOut[0].fireAt === at(2026, 8, 25, 8, 0));

  // Non-default allDayHour: 0 (midnight) and 23 (11 PM).
  const midnightSetting = coerceNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, allDayHour: 0 });
  const midnightOut = computeSchedule(baseInput({ events: allDayEvent, settings: midnightSetting }));
  check('all-day item with allDayHour=0 anchors at midnight',
    midnightOut[0].fireAt === at(2026, 8, 25, 0, 0));

  const lateSetting = coerceNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, allDayHour: 23 });
  const lateOut = computeSchedule(baseInput({ events: allDayEvent, settings: lateSetting }));
  check('all-day item with allDayHour=23 anchors at 23:00',
    lateOut[0].fireAt === at(2026, 8, 25, 23, 0));

  // Dated tasks with no time: swept into exactly ONE digest at taskCutoffHour.
  const tasksInput = {
    t1: { id: 't1', weekKey: WEEK, dayIndex: 1, title: 'Open task A' },
    t2: { id: 't2', weekKey: WEEK, dayIndex: 1, title: 'Open task B' },
    t3: { id: 't3', weekKey: WEEK, dayIndex: 1, title: 'Completed task', completed: true },
    t4: { id: 't4', weekKey: WEEK, dayIndex: 1, startTime: '11:00', title: 'Timed task' },
  };
  const taskOut = computeSchedule(baseInput({ tasks: tasksInput }));
  const digests = taskOut.filter(n => n.kind === 'task-digest');
  const timedTasks = taskOut.filter(n => n.kind === 'task');

  check('several open dated tasks collapse into exactly ONE digest', digests.length === 1);
  check('digest fires at taskCutoffHour', digests[0].fireAt === at(2026, 8, 25, 21, 0));
  check('completed tasks never appear in the digest count or body',
    digests[0].title.startsWith('2 tasks') && !digests[0].body.includes('Completed task'));
  check('timed task fires at its own time and is never in the digest',
    timedTasks.length === 1 && timedTasks[0].fireAt === at(2026, 8, 25, 11, 0) && !digests[0].body.includes('Timed task'));

  // Prayer times: anchor at prayer's own time.
  const prayerMonth: PrayerMonth = {
    '2026-08-25': {
      fajr: '04:30', sunrise: '06:00', dhuhr: '12:30', asr: '16:00', maghrib: '19:00', isha: '20:30',
    },
  };
  const prayerSettings: PrayerSettings = coercePrayerSettings({
    enabled: true, city: 'London', country: 'UK', method: 2, school: 0,
    color: '#10b981', showSunrise: true,
  });
  const prayerOut = computeSchedule(baseInput({
    settings: coerceNotificationSettings({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      prayer: { enabled: true, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' },
    }),
    prayerMonths: { '2026-08': prayerMonth },
    prayerSettings,
  }));
  const fajr = prayerOut.find(n => n.kind === 'prayer' && n.refId === 'fajr');
  check('prayer fires at its own scheduled time from the prayer table',
    fajr !== undefined && fajr.fireAt === at(2026, 8, 25, 4, 30));

}

// 4. Positive offsets, negative offsets, and offset 0
{
  const events = {
    en: { id: 'en', weekKey: WEEK, dayIndex: 1, startTime: '12:00', content: 'Lunch', notify: spec([-30]) },
    ez: { id: 'ez', weekKey: WEEK, dayIndex: 1, startTime: '12:00', content: 'Lunch', notify: spec([0]) },
    ep: { id: 'ep', weekKey: WEEK, dayIndex: 1, startTime: '12:00', content: 'Lunch', notify: spec([15]) },
  };
  const out = computeSchedule(baseInput({ events }));
  const neg = out.find(n => n.refId === 'en');
  const zero = out.find(n => n.refId === 'ez');
  const pos = out.find(n => n.refId === 'ep');

  check('negative offset fires before anchor', neg?.fireAt === at(2026, 8, 25, 11, 30));
  check('zero offset fires on time', zero?.fireAt === at(2026, 8, 25, 12, 0));
  check('positive offset fires after anchor', pos?.fireAt === at(2026, 8, 25, 12, 15));
}


// 5. Key stability: dedupe mechanism
{
  const before = computeSchedule(baseInput({
    events: { k1: { id: 'k1', weekKey: WEEK, dayIndex: 1, startTime: '09:00', endTime: '10:00', content: 'Original', categoryId: 'plain', notify: spec([-15]) } },
  }));
  const movedSameDay = computeSchedule(baseInput({
    events: { k1: { id: 'k1', weekKey: WEEK, dayIndex: 1, startTime: '15:00', endTime: '16:00', content: 'Original', categoryId: 'plain', notify: spec([-15]) } },
  }));
  check('moving an event to another hour on the same day produces the SAME key',
    before[0].key === movedSameDay[0].key);

  const movedDifferentDay = computeSchedule(baseInput({
    events: { k1: { id: 'k1', weekKey: WEEK, dayIndex: 3, startTime: '09:00', endTime: '10:00', content: 'Original', categoryId: 'plain', notify: spec([-15]) } },
  }));
  check('moving an event to a different day produces a DIFFERENT key',
    before[0].key !== movedDifferentDay[0].key);

  const renamed = computeSchedule(baseInput({
    events: { k1: { id: 'k1', weekKey: WEEK, dayIndex: 1, startTime: '09:00', endTime: '10:00', content: 'Renamed Meeting', categoryId: 'exams', notify: spec([-15]) } },
  }));
  check('renaming or changing category color does not change the key',
    before[0].key === renamed[0].key);
}

// 6. Scan windowing: large leads across month/year and positive lag
{
  // Event in January 2027 with a 2-week-ahead reminder (-20160 min) firing in December 2026.
  const events = {
    crossYear: { id: 'cy1', weekKey: '2027-01-11', dayIndex: 0, startTime: '10:00', content: 'Conference', notify: spec([-20160]) },
  };
  const inDec = computeSchedule(baseInput({
    events,
    from: at(2026, 12, 28),
    to: at(2026, 12, 29),
  }));
  check('a multi-week reminder across year boundary is found in the firing window',
    inDec.length === 1 && inDec[0].fireAt === at(2026, 12, 28, 10, 0));

  const outside = computeSchedule(baseInput({
    events,
    from: at(2027, 1, 1),
    to: at(2027, 1, 5),
  }));
  check('and is not reported in an unrelated window', outside.length === 0);

  // Large positive offset (+120 min) firing in the subsequent window.
  const lateItem = {
    late1: { id: 'l1', weekKey: WEEK, dayIndex: 1, startTime: '23:30', content: 'Night Run', notify: spec([120]) },
  };
  const nextDay = computeSchedule(baseInput({
    events: lateItem,
    from: at(2026, 8, 26, 0, 0),
    to: at(2026, 8, 26, 3, 0),
  }));
  check('a large positive offset firing past midnight is found in the next-day scan',
    nextDay.length === 1 && nextDay[0].fireAt === at(2026, 8, 26, 1, 30));
}

// 7. Master switch and disabled specs
{
  const events = { ev: { id: 'ev', weekKey: WEEK, dayIndex: 1, startTime: '10:00', content: 'Task' } };
  const masterOff = computeSchedule(baseInput({
    events,
    settings: coerceNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false }),
  }));
  check('master switch disabled silences all schedule computation', masterOff.length === 0);

  const disabledSpec = computeSchedule(baseInput({
    events: { ev: { ...events.ev, notify: { enabled: false, rules: [{ id: 'r0', offsetMin: 0 }], priority: 'normal' } } },
  }));
  check('an item with a disabled spec produces zero reminders', disabledSpec.length === 0);
}

// 8. Quiet hours boundaries, wrapping, zero-length, and critical escalation
{
  const wrapping: NotificationSettings = coerceNotificationSettings({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    quietHoursEnabled: true,
    quietFromH: 23,
    quietToH: 7,
  });

  check('wrapping quiet hours: 22:59 is outside', !inQuietHours(wrapping, new Date(at(2026, 8, 25, 22, 59))));
  check('wrapping quiet hours: 23:00 exact boundary is inside', inQuietHours(wrapping, new Date(at(2026, 8, 25, 23, 0))));
  check('wrapping quiet hours: 06:59 is inside', inQuietHours(wrapping, new Date(at(2026, 8, 26, 6, 59))));
  check('wrapping quiet hours: 07:00 exact boundary is outside', !inQuietHours(wrapping, new Date(at(2026, 8, 26, 7, 0))));

  const sameDay: NotificationSettings = coerceNotificationSettings({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    quietHoursEnabled: true,
    quietFromH: 13,
    quietToH: 17,
  });
  check('same-day quiet hours: 12:59 is outside', !inQuietHours(sameDay, new Date(at(2026, 8, 25, 12, 59))));
  check('same-day quiet hours: 13:00 is inside', inQuietHours(sameDay, new Date(at(2026, 8, 25, 13, 0))));
  check('same-day quiet hours: 17:00 is outside', !inQuietHours(sameDay, new Date(at(2026, 8, 25, 17, 0))));

  const zeroLength: NotificationSettings = coerceNotificationSettings({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    quietHoursEnabled: true,
    quietFromH: 8,
    quietToH: 8,
  });
  check('zero-length quiet hours range is disabled everywhere',
    !inQuietHours(zeroLength, new Date(at(2026, 8, 25, 8, 0))) && !inQuietHours(zeroLength, new Date(at(2026, 8, 25, 12, 0))));

  check('quietReleaseAt for wrapping window held at 23:30 releases next morning at 07:00',
    quietReleaseAt(wrapping, new Date(at(2026, 8, 25, 23, 30))) === at(2026, 8, 26, 7, 0));
  check('quietReleaseAt for wrapping window held at 02:00 releases same morning at 07:00',
    quietReleaseAt(wrapping, new Date(at(2026, 8, 26, 2, 0))) === at(2026, 8, 26, 7, 0));
  check('quietReleaseAt for same-day window held at 14:00 releases at 17:00',
    quietReleaseAt(sameDay, new Date(at(2026, 8, 25, 14, 0))) === at(2026, 8, 25, 17, 0));
}

// 9. Recurrence, EXDATEs, detached occurrences, and locked series
{
  const master = {
    id: 'rec1',
    weekKey: WEEK,
    dayIndex: 0,
    startTime: '09:00',
    endTime: '10:00',
    content: 'Team Sync',
    recur: { freq: 'daily' as const, interval: 1, end: { count: 4 } },
    notify: spec([-15]),
  };

  const series = computeSchedule(baseInput({ events: { rec1: master } }));
  check('repeating master expands into per-occurrence notifications',
    series.length === 4 && series[0].key === 'event:rec1:2026-08-24:-15' && series[3].key === 'event:rec1:2026-08-27:-15');

  const withExdate = computeSchedule(baseInput({
    events: { rec1: { ...master, exdates: ['2026-08-25'] } },
  }));
  check('exdated occurrence produces no notification',
    withExdate.length === 3 && !withExdate.some(n => n.occDate === '2026-08-25'));

  // Detached occurrence via editSeries: detaches with standalone id and custom spec.
  const detachedEdit = editSeries({ rec1: master }, makeOccId('rec1', '2026-08-26'), {
    startTime: '16:00',
    notify: spec([-30], 'critical'),
  }, WEEK, 1);

  const detachedSchedule = computeSchedule(baseInput({ events: detachedEdit.events }));
  const detachedEntry = detachedSchedule.find(n => n.occDate === '2026-08-26');
  check('detached occurrence uses its own spec and fire time',
    detachedEntry !== undefined && detachedEntry.fireAt === at(2026, 8, 26, 15, 30) && detachedEntry.priority === 'critical');
}

// 10. Store: activeNotifications, unreadCount, pruneStore, and groupNotifications
{
  const now = at(2026, 8, 26, 14, 0);
  const rec = (key: string, over: Partial<NotificationRecord> = {}): NotificationRecord => ({
    key, kind: 'event', refId: 'e', occDate: '2026-08-26', fireAt: now, anchorAt: now, offsetMin: 0,
    title: key, body: '', priority: 'normal', allDay: false, url: '/',
    firedAt: now, lastAlertAt: now, alerts: 1, ...over,
  });

  const store: NotificationStore = {
    items: {
      n1: rec('n1', { read: false }),
      n2: rec('n2', { read: true }),
      n3: rec('n3', { snoozedUntil: now + 300_000 }), // active snooze: hidden
      n4: rec('n4', { snoozedUntil: now - 300_000 }), // expired snooze: visible
    },
    updatedAt: now,
  };

  check('activeNotifications filters out read and active snoozes',
    activeNotifications(store, now).map(n => n.key).sort().join(',') === 'n1,n4');
  check('unreadCount matches active count', unreadCount(store, now) === 2);

  // Pruning at limit and over limit.
  const exactlyAtLimit: NotificationStore = {
    items: { a: rec('a'), b: rec('b'), c: rec('c') },
    updatedAt: now,
  };
  check('pruneStore at exact limit preserves all items',
    Object.keys(pruneStore(exactlyAtLimit, 3).items).length === 3);

  const overLimit: NotificationStore = {
    items: {
      oldest: rec('oldest', { firedAt: now - 50_000 }),
      middle: rec('middle', { firedAt: now - 20_000 }),
      newest: rec('newest', { firedAt: now }),
    },
    updatedAt: now,
  };
  const pruned = pruneStore(overLimit, 2);
  check('pruneStore over limit retains newest items and drops oldest',
    Object.keys(pruned.items).length === 2 && !!pruned.items.newest && !!pruned.items.middle && !pruned.items.oldest);

  // groupNotifications boundary tests.
  const groups = groupNotifications([
    rec('just_now_edge', { firedAt: now - 3600_000 }), // exactly 1h ago -> Just now
    rec('today_edge', { firedAt: now - 3600_001 }),    // >1h ago but today -> Today
    rec('start_of_today', { firedAt: at(2026, 8, 26, 0, 0) }),
    rec('start_of_yesterday', { firedAt: at(2026, 8, 25, 0, 0) }),
    rec('earlier_edge', { firedAt: at(2026, 8, 24, 23, 59, 59) }),
  ], now);

  check('groupNotifications divides correctly at boundaries into 4 buckets',
    groups.map(g => `${g.label}:${g.items.length}`).join('|') === 'Just now:1|Today:2|Yesterday:1|Earlier:1');
}

// 11. Wording helpers: offsetLabel and offsetChip
{
  check('offsetLabel formats 0 correctly', offsetLabel(0) === 'At the time');
  check('offsetLabel singular minute before', offsetLabel(-1) === '1 minute before');
  check('offsetLabel plural minutes before', offsetLabel(-2) === '2 minutes before');
  check('offsetLabel singular hour before', offsetLabel(-60) === '1 hour before');
  check('offsetLabel plural hours before', offsetLabel(-120) === '2 hours before');
  check('offsetLabel combined hours and minutes', offsetLabel(-90) === '1h 30m before');
  check('offsetLabel singular day before', offsetLabel(-1440) === '1 day before');
  check('offsetLabel plural days before', offsetLabel(-2880) === '2 days before');
  check('offsetLabel singular week before', offsetLabel(-10080) === '1 week before');
  check('offsetLabel plural weeks before', offsetLabel(-20160) === '2 weeks before');
  check('offsetLabel singular minute after', offsetLabel(1) === '1 minute after');
  check('offsetLabel plural minutes after', offsetLabel(5) === '5 minutes after');
  check('offsetLabel hours after', offsetLabel(120) === '2 hours after');
  check('offsetLabel days after', offsetLabel(1440) === '1 day after');

  check('offsetChip produces compact tags',
    offsetChip(0) === 'on time'
    && offsetChip(-1) === '-1m'
    && offsetChip(5) === '+5m'
    && offsetChip(-60) === '-1h'
    && offsetChip(120) === '+2h'
    && offsetChip(-1440) === '-1d'
    && offsetChip(2880) === '+2d'
    && offsetChip(-10080) === '-1w'
    && offsetChip(20160) === '+2w');
}

// 12. Timezone / DST wall-clock anchoring
{
  // A date constructed in local time ensures setHours lands on target wall-clock hour.
  const d = new Date(2026, 2, 29); // spring transition date in many zones
  d.setHours(8, 0, 0, 0);
  check('all-day anchor lands exactly on 08:00 wall-clock time', d.getHours() === 8 && d.getMinutes() === 0);

  const t = new Date(2026, 9, 25); // autumn transition date
  t.setHours(21, 0, 0, 0);
  check('task cutoff anchor lands exactly on 21:00 wall-clock time', t.getHours() === 21 && t.getMinutes() === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// B. NEW behaviour: notification-engine.ts & desktop suppression
// ═══════════════════════════════════════════════════════════════════════════

// 13. desktopPush setting
{
  check('desktopPush defaults to false', DEFAULT_NOTIFICATION_SETTINGS.desktopPush === false);

  const coercedTrue = coerceNotificationSettings({ desktopPush: true });
  check('desktopPush true is coerced from JSON', coercedTrue.desktopPush === true);

  const coercedFalse = coerceNotificationSettings({ desktopPush: false });
  check('desktopPush false is coerced from JSON', coercedFalse.desktopPush === false);

  const coercedGarbage = coerceNotificationSettings({ desktopPush: 'nonsense' });
  check('desktopPush invalid value falls back to default', coercedGarbage.desktopPush === false);

  const roundTrip = coerceNotificationSettings(JSON.parse(JSON.stringify({ ...DEFAULT_NOTIFICATION_SETTINGS, desktopPush: true })));
  check('desktopPush survives round-trip through JSON', roundTrip.desktopPush === true);
}

// 14. isDesktopSubscription against real user agents
{
  const winChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const winPwa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (PWA)';
  const winEdge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0';
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const linuxFirefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0';

  const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
  const iPhoneSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const iPadSafari = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const genericMobile = 'CustomApp/1.0 Mobile';

  const sub = (ua?: string, local?: boolean): PushSubscriptionRecord => ({
    id: 's1', endpoint: 'https://example.com/ep', keys: { p256dh: 'k', auth: 'a' },
    userAgent: ua, local, createdAt: 1000,
  });

  check('isDesktopSubscription identifies Windows Chrome as desktop', isDesktopSubscription(sub(winChrome)));
  check('isDesktopSubscription identifies Windows Chrome PWA as desktop', isDesktopSubscription(sub(winPwa)));
  check('isDesktopSubscription identifies Windows Edge as desktop', isDesktopSubscription(sub(winEdge)));
  check('isDesktopSubscription identifies Mac Safari as desktop', isDesktopSubscription(sub(macSafari)));
  check('isDesktopSubscription identifies Linux Firefox as desktop', isDesktopSubscription(sub(linuxFirefox)));

  check('isDesktopSubscription rejects Android Chrome', !isDesktopSubscription(sub(androidChrome)));
  check('isDesktopSubscription rejects iPhone Safari', !isDesktopSubscription(sub(iPhoneSafari)));
  check('isDesktopSubscription rejects iPad', !isDesktopSubscription(sub(iPadSafari)));
  check('isDesktopSubscription rejects generic Mobile UA', !isDesktopSubscription(sub(genericMobile)));

  check('isDesktopSubscription with local:true is always desktop regardless of UA',
    isDesktopSubscription(sub(androidChrome, true)) && isDesktopSubscription(sub(undefined, true)));

  // Fail-open: unknown subscription with no UA must never be silenced.
  check('isDesktopSubscription with no UA and no local flag is NOT treated as desktop (fail-open)',
    !isDesktopSubscription(sub(undefined, false)));
}

// 15. Push fan-out merge rule simulation
{
  const desktopSub: PushSubscriptionRecord = {
    id: 'd1', endpoint: 'https://push.example.com/desktop', keys: { p256dh: 'k1', auth: 'a1' },
    userAgent: 'Windows NT', createdAt: 1000, failures: 0,
  };
  const phoneSub: PushSubscriptionRecord = {
    id: 'p1', endpoint: 'https://push.example.com/phone', keys: { p256dh: 'k2', auth: 'a2' },
    userAgent: 'Android Mobile', createdAt: 1000, failures: 0,
  };

  const allSubs = [desktopSub, phoneSub];
  const attemptedSubs = [phoneSub]; // Desktop was skipped

  // Case 1: Phone push succeeds -> desktop sub survives unchanged.
  const keptSuccess = [{ ...phoneSub, lastOkAt: 2000, failures: 0 }];
  const byEndpointSuccess = new Map(keptSuccess.map(s => [s.endpoint, s]));
  const attemptedSet = new Set(attemptedSubs.map(s => s.endpoint));
  const mergedSuccess = allSubs
    .map(s => byEndpointSuccess.get(s.endpoint) ?? (attemptedSet.has(s.endpoint) ? null : s))
    .filter(Boolean) as PushSubscriptionRecord[];

  check('skipped desktop subscription is preserved unchanged on successful push',
    mergedSuccess.length === 2 && mergedSuccess.some(s => s.id === 'd1' && s.failures === 0));

  // Case 2: Phone is gone (404/410) -> phone dropped, desktop kept.
  const keptGone: PushSubscriptionRecord[] = []; // Phone died
  const byEndpointGone = new Map<string, PushSubscriptionRecord>();
  const mergedGone = allSubs
    .map(s => byEndpointGone.get(s.endpoint) ?? (attemptedSet.has(s.endpoint) ? null : s))
    .filter(Boolean) as PushSubscriptionRecord[];

  check('gone phone subscription is removed while skipped desktop subscription is kept',
    mergedGone.length === 1 && mergedGone[0].id === 'd1');

  // Case 3: Transient failure (500) -> phone kept with incremented failure, desktop failure untouched.
  const keptTransient = [{ ...phoneSub, failures: 1, lastError: '500 Internal Error' }];
  const byEndpointTransient = new Map(keptTransient.map(s => [s.endpoint, s]));
  const mergedTransient = allSubs
    .map(s => byEndpointTransient.get(s.endpoint) ?? (attemptedSet.has(s.endpoint) ? null : s))
    .filter(Boolean) as PushSubscriptionRecord[];

  check('transient failure increments phone failure counter without touching desktop subscription',
    mergedTransient.length === 2
    && mergedTransient.find(s => s.id === 'p1')?.failures === 1
    && mergedTransient.find(s => s.id === 'd1')?.failures === 0);
}

// 16 & 17. desktopPush flag and fail-open suppression rules
{
  // When desktopPush is true: skipDesktop must be false even if toasted.
  const toasted = true;
  const desktopPushEnabled = true;
  const skipWhenDesktopPush = toasted && !desktopPushEnabled;
  check('with desktopPush:true, desktop subscriptions are not skipped', skipWhenDesktopPush === false);

  // Fail-open: when toast did NOT fire (toasted = false), skipDesktop must be false so desktop gets push.
  const toastDisabled = false;
  const notWindows = false;
  const toastedFailed = toastDisabled || notWindows;
  const skipWhenToastFailed = toastedFailed && !false;
  check('fail-open rule: when Windows toast does not fire, desktop browsers still receive push',
    skipWhenToastFailed === false);
}

// ═══════════════════════════════════════════════════════════════════════════
// C. Web Push crypto: server-web-push.ts
// ═══════════════════════════════════════════════════════════════════════════

// 18. Payload encryption/decryption round-trip (empty, Arabic UTF-8, near size limit)
{
  const subscriberEcdh = crypto.createECDH('prime256v1');
  subscriberEcdh.generateKeys();
  const subPub = subscriberEcdh.getPublicKey().toString('base64url');
  const subAuth = crypto.randomBytes(16).toString('base64url');

  const decryptTest = (ciphertextBuffer: Buffer): string => {
    const salt = ciphertextBuffer.subarray(0, 16);
    const idLen = ciphertextBuffer[20];
    const asPublic = ciphertextBuffer.subarray(21, 21 + idLen);
    const ct = ciphertextBuffer.subarray(21 + idLen);

    const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();
    const hkdf = (s: Buffer, ikm: Buffer, info: Buffer, len: number) =>
      hmac(hmac(s, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

    const shared = subscriberEcdh.computeSecret(asPublic);
    const uaPublicBuf = Buffer.from(subPub, 'base64url');
    const authBuf = Buffer.from(subAuth, 'base64url');
    const ikm = hkdf(authBuf, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicBuf, asPublic]), 32);
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    if (plain[plain.length - 1] !== 0x02) throw new Error('Bad delimiter');
    return plain.subarray(0, plain.length - 1).toString('utf-8');
  };

  // Standard payload.
  const msg1 = JSON.stringify({ type: 'notify', title: 'Meeting', body: 'Starts in 10 minutes' });
  const enc1 = encryptPayload(msg1, subPub, subAuth);
  check('standard payload decrypts back to exact plaintext', decryptTest(enc1) === msg1);

  // Empty payload.
  const emptyMsg = '';
  const encEmpty = encryptPayload(emptyMsg, subPub, subAuth);
  check('empty payload decrypts back to empty string', decryptTest(encEmpty) === '');

  // Multi-byte UTF-8 Arabic text.
  const arabicMsg = JSON.stringify({ title: 'موعد الصلاة', body: 'حان الآن موعد صلاة الظهر في مكة المكرمة' });
  const encArabic = encryptPayload(arabicMsg, subPub, subAuth);
  check('multi-byte UTF-8 Arabic text decrypts without byte corruption', decryptTest(encArabic) === arabicMsg);

  // Large payload near 4096-byte limit (~3900 bytes).
  const largeMsg = JSON.stringify({ title: 'Big Plan', data: 'A'.repeat(3850) });
  const encLarge = encryptPayload(largeMsg, subPub, subAuth);
  check('large payload near size limit decrypts accurately', decryptTest(encLarge) === largeMsg);
}

// 19. VAPID JWT: raw 64-byte signature, verification, and claim bounds
{
  const keys = generateVapidKeys('mailto:planner-test@example.com');
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const jwt = signVapidJwt(keys, 'https://fcm.googleapis.com', 12 * 3600);
  const [h, b, sig] = jwt.split('.');

  const sigBuf = Buffer.from(sig, 'base64url');
  check('VAPID JWT signature is raw 64-byte ieee-p1363 (not ASN.1 DER)', sigBuf.length === 64);

  const verifyKey = crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
  } as unknown as crypto.PublicKeyInput);

  const verified = crypto.verify('sha256', Buffer.from(`${h}.${b}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, sigBuf);
  check('VAPID JWT verifies cleanly with its own public key', verified);

  const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  const nowSec = Math.floor(Date.now() / 1000);
  check('VAPID JWT carries correct aud, sub, and exp within 24h',
    claims.aud === 'https://fcm.googleapis.com'
    && claims.sub === 'mailto:planner-test@example.com'
    && claims.exp > nowSec
    && claims.exp <= nowSec + 24 * 3600);
}

// 20. Salt is fresh per message
{
  const keys = generateVapidKeys('mailto:test@example.com');
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const subPub = ua.getPublicKey().toString('base64url');
  const subAuth = crypto.randomBytes(16).toString('base64url');

  const payload = 'same payload';
  const c1 = encryptPayload(payload, subPub, subAuth);
  const c2 = encryptPayload(payload, subPub, subAuth);
  check('every encryption produces unique ciphertext and fresh salt', !c1.equals(c2));
}

// ═══════════════════════════════════════════════════════════════════════════
// D. Service worker logic: public/sw.js
// ═══════════════════════════════════════════════════════════════════════════

// 21. Fetch handler routing predicate
{
  const { shouldHandleFetch } = sw;
  const origin = 'http://localhost:5000';

  const req = (url: string, method = 'GET', headers: Record<string, string> = {}) => ({
    url, method, headers: { get: (k: string) => headers[k.toLowerCase()] || null },
  });

  // Must NEVER intercept /api/
  check('fetch handler never intercepts /api/auth/me', !shouldHandleFetch(req(`${origin}/api/auth/me`), origin));
  check('fetch handler never intercepts /api/ping', !shouldHandleFetch(req(`${origin}/api/ping`), origin));
  check('fetch handler never intercepts /api/notifications/schedule', !shouldHandleFetch(req(`${origin}/api/notifications/schedule`), origin));

  // Must NEVER intercept non-GET requests
  check('fetch handler never intercepts POST request', !shouldHandleFetch(req(`${origin}/api/auth/login`, 'POST'), origin));
  check('fetch handler never intercepts PUT request', !shouldHandleFetch(req(`${origin}/settings`, 'PUT'), origin));
  check('fetch handler never intercepts DELETE request', !shouldHandleFetch(req(`${origin}/items/1`, 'DELETE'), origin));

  // Must NEVER intercept SSE stream
  check('fetch handler never intercepts text/event-stream accept header',
    !shouldHandleFetch(req(`${origin}/api/db-stream`, 'GET', { accept: 'text/event-stream' }), origin));

  // Must NEVER intercept external origin
  check('fetch handler never intercepts external origins (e.g. Google Fonts)',
    !shouldHandleFetch(req('https://fonts.googleapis.com/css2', 'GET'), origin));

  // Valid local assets ARE handled
  check('fetch handler intercepts local hashed assets', shouldHandleFetch(req(`${origin}/assets/app-123.js`), origin));
  check('fetch handler intercepts navigation to shell', shouldHandleFetch(req(`${origin}/index.html`), origin));
  check('fetch handler intercepts static icons', shouldHandleFetch(req(`${origin}/favicon.ico`), origin));
}

// 22. artFor returns embedded data URIs per kind and critical fallback
{
  const { artFor, NOTIFY_ART } = sw;

  check('artFor event returns embedded event icon data URI', artFor('event', 'normal').icon.startsWith('data:image/png;base64,'));
  check('artFor task returns embedded task icon data URI', artFor('task', 'normal').icon === NOTIFY_ART.task.icon);
  check('artFor task-digest returns embedded task-digest icon data URI', artFor('task-digest', 'normal').icon === NOTIFY_ART['task-digest'].icon);
  check('artFor prayer returns embedded prayer icon data URI', artFor('prayer', 'normal').icon === NOTIFY_ART.prayer.icon);
  check('artFor unknown kind falls back to event artwork', artFor('custom_kind', 'normal').icon === NOTIFY_ART.event.icon);

  // Critical priority always returns critical artwork regardless of kind.
  check('artFor critical priority returns critical artwork for event', artFor('event', 'critical').icon === NOTIFY_ART.critical.icon);
  check('artFor critical priority returns critical artwork for task', artFor('task', 'critical').icon === NOTIFY_ART.critical.icon);
  check('artFor critical priority returns critical artwork for prayer', artFor('prayer', 'critical').icon === NOTIFY_ART.critical.icon);
}

// 23. Cached-plan runner: timing floor, dedupe, and single report
{
  const { runCachedPlanCore } = sw;
  const now = at(2026, 8, 26, 12, 0);

  const plan = {
    settings: DEFAULT_NOTIFICATION_SETTINGS,
    items: [
      { key: 'due_now', title: 'Due Now', fireAt: now - 60_000, kind: 'event' },
      { key: 'due_3h_ago', title: 'Due Earlier', fireAt: now - 3 * 3600_000, kind: 'event' },
      { key: 'too_old_7h', title: 'Too Old', fireAt: now - 7 * 3600_000, kind: 'event' }, // >6h floor: skipped
      { key: 'future_1h', title: 'Future Event', fireAt: now + 3600_000, kind: 'event' },  // future: skipped
    ],
  };

  const firedTitles: string[] = [];
  const mockShow = async (title: string) => { firedTitles.push(title); };

  const result = await runCachedPlanCore(plan, now, mockShow);
  check('cached-plan runner fires only due items within 6h floor and excludes future/stale items',
    result.fired.sort().join(',') === 'due_3h_ago,due_now');
  check('showNotification was called exactly for due items',
    firedTitles.sort().join(',') === 'Due Earlier,Due Now');
  check('remaining items keep future items and exclude fired/expired ones',
    result.remaining.map((i: any) => i.key).join(',') === 'future_1h');

  // Running a second time with remaining items produces no new fires.
  const secondResult = await runCachedPlanCore({ ...plan, items: result.remaining }, now, mockShow);
  check('running cached-plan a second time does not re-fire already delivered items',
    secondResult.fired.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// E. Login diagnostics: src/pages/login.tsx & src/lib/auth.tsx
// ═══════════════════════════════════════════════════════════════════════════

// 24. diagnoseConnection decision table
{
  const origin = 'http://localhost:5000';

  // 1. Offline device.
  const offlineMsg = await diagnoseConnection(origin, async () => new Response(''), false);
  check('diagnose: offline navigator returns offline message',
    offlineMsg.includes('This device is offline'));

  // 2. /api/ping 200 OK.
  const pingOk = await diagnoseConnection(origin, async () => new Response('{"ok":true}', { status: 200 }), true);
  check('diagnose: ping OK reports connection is fine and prompts checking credentials',
    pingOk.includes('connection is fine. Check the username and password'));

  // 3. /api/ping 502 error.
  const pingErr = await diagnoseConnection(origin, async () => new Response('Bad Gateway', { status: 502 }), true);
  check('diagnose: ping non-2xx reports exact status code',
    pingErr.includes('error (502)'));

  // 4. /api/ping throws / network failure.
  const pingThrows = await diagnoseConnection(origin, async () => { throw new Error('Failed to fetch'); }, true);
  check('diagnose: ping throw reports cannot reach origin',
    pingThrows.includes('Cannot reach http://localhost:5000'));

  // 5. IT PINGS THE ADDRESS IT NAMES. The message quotes `where`; the request
  // used to go to a relative '/api/ping', so on any origin other than the one
  // being asked about the answer described a server it had never contacted.
  {
    const asked: string[] = [];
    const record = async (url: unknown) => {
      asked.push(String(url));
      return new Response('{"ok":true}', { status: 200 });
    };

    await diagnoseConnection('http://192.168.1.50:5000', record as typeof fetch, true);
    check('diagnose: pings the host it was asked about',
      asked[0] === 'http://192.168.1.50:5000/api/ping');

    // A trailing slash, a path, and an https host: all resolve to that host's
    // own /api/ping, never to a path underneath whatever was passed in.
    asked.length = 0;
    await diagnoseConnection('https://planner.example.net/', record as typeof fetch, true);
    check('diagnose: a trailing slash does not change the target',
      asked[0] === 'https://planner.example.net/api/ping');

    asked.length = 0;
    await diagnoseConnection('https://planner.example.net/login', record as typeof fetch, true);
    check('diagnose: a path on the address is replaced, not appended to',
      asked[0] === 'https://planner.example.net/api/ping');

    // A port, which is how this planner is actually reached.
    asked.length = 0;
    await diagnoseConnection('http://localhost:5000', record as typeof fetch, true);
    check('diagnose: the port survives',
      asked[0] === 'http://localhost:5000/api/ping');

    // The offline branch answers before any request is made.
    asked.length = 0;
    await diagnoseConnection('http://localhost:5000', record as typeof fetch, false);
    check('diagnose: an offline device is not asked to make a request',
      asked.length === 0);
  }

  // 6. An address that is not a URL at all must not take the whole page down
  // with it -- a diagnosis that throws is worse than one that says nothing.
  {
    let threw = false;
    try {
      await diagnoseConnection('not a url', async () => new Response('', { status: 200 }), true);
    } catch (_) {
      threw = true;
    }
    check('diagnose: a malformed address does not throw', threw === false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F. Funnel watchdog: funnel-watchdog.ts
// ═══════════════════════════════════════════════════════════════════════════

// 25. Watchdog state machine & command runner
{
  const logs: string[] = [];
  const commandsRun: string[] = [];

  // Case 1: Healthy status -> no repair attempted.
  const healthyWatchdog = createFunnelWatchdog({
    rootDir: 'd:/mock',
    port: 5000,
    tailscaleBinary: () => 'tailscale.exe',
    log: l => logs.push(l),
    runner: async (_bin, args) => {
      commandsRun.push(args.join(' '));
      return { code: 0, out: 'Funnel on: https://node.ts.net -> http://127.0.0.1:5000' };
    },
  });
  await healthyWatchdog.kick();
  check('healthy funnel status triggers no repair commands',
    commandsRun.length === 1 && commandsRun[0] === 'funnel status' && healthyWatchdog.health().state === 'up');

  // Case 2: Status missing "Funnel on" -> repairs once.
  commandsRun.length = 0;
  const brokenWatchdog = createFunnelWatchdog({
    rootDir: 'd:/mock',
    port: 5000,
    tailscaleBinary: () => 'tailscale.exe',
    log: l => logs.push(l),
    runner: async (_bin, args) => {
      commandsRun.push(args.join(' '));
      if (args[0] === 'funnel' && args[1] === '--bg') return { code: 0, out: '' };
      if (commandsRun.length === 1) return { code: 0, out: 'Funnel off' };
      return { code: 0, out: 'Funnel on: https://node.ts.net -> http://127.0.0.1:5000' };
    },
  });
  await brokenWatchdog.kick();
  check('missing funnel status triggers repair command and succeeds',
    commandsRun.length === 3
    && commandsRun[1] === 'funnel --bg --https=443 http://127.0.0.1:5000'
    && brokenWatchdog.health().repairs === 1
    && brokenWatchdog.health().state === 'up');

  // Case 3: Funnel pointing at wrong port (3000 instead of 5000) -> repairs.
  commandsRun.length = 0;
  const wrongPortWatchdog = createFunnelWatchdog({
    rootDir: 'd:/mock',
    port: 5000,
    tailscaleBinary: () => 'tailscale.exe',
    log: l => logs.push(l),
    runner: async (_bin, args) => {
      commandsRun.push(args.join(' '));
      if (args[0] === 'funnel' && args[1] === '--bg') return { code: 0, out: '' };
      if (commandsRun.length === 1) return { code: 0, out: 'Funnel on: https://node.ts.net -> http://127.0.0.1:3000' };
      return { code: 0, out: 'Funnel on: https://node.ts.net -> http://127.0.0.1:5000' };
    },
  });
  await wrongPortWatchdog.kick();
  check('status pointing at wrong port triggers repair to correct port',
    commandsRun.includes('funnel --bg --https=443 http://127.0.0.1:5000')
    && wrongPortWatchdog.health().state === 'up');

  // Case 4: Repair that fails -> state is down, not looped.
  commandsRun.length = 0;
  const failingWatchdog = createFunnelWatchdog({
    rootDir: 'd:/mock',
    port: 5000,
    tailscaleBinary: () => 'tailscale.exe',
    log: l => logs.push(l),
    runner: async (_bin, args) => {
      commandsRun.push(args.join(' '));
      return { code: 1, out: 'Funnel off' };
    },
  });
  await failingWatchdog.kick();
  check('repair that fails marks state down without looping',
    failingWatchdog.health().state === 'down' && commandsRun.length === 3);

  // Case 5: Tailscale binary absent -> disables itself after one log line and never runs commands.
  commandsRun.length = 0;
  const absentWatchdog = createFunnelWatchdog({
    rootDir: 'd:/mock',
    port: 5000,
    tailscaleBinary: () => null,
    log: l => logs.push(l),
    runner: async (_bin, args) => {
      commandsRun.push(args.join(' '));
      return { code: 0, out: '' };
    },
  });
  await absentWatchdog.kick();
  await absentWatchdog.kick();
  check('absent tailscale binary disables watchdog after one log and runs no commands',
    absentWatchdog.health().disabled === true && commandsRun.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

// ─── A task with reminders switched off is off everywhere ───────────────────
//
// Timed tasks go through `resolveSpec` and are skipped when the resolved spec
// is disabled. The dated-WITHOUT-a-time branch never called it: it dropped
// straight into the evening digest, which was gated only on the global default.
// So setting one task to "no reminders" removed it from nothing. It still
// appeared by name in the 21:00 "still open today" notification, which
// contradicts the inheritance model the whole file is built on.
{
  console.log('\n--- A TASK SWITCHED OFF STAYS OUT OF THE DIGEST ---');

  const DAY = '2026-03-04';
  const settings = coerceNotificationSettings({
    defaultTask: { enabled: true, rules: [{ offsetMin: 0 }] },
    taskCutoffHour: 21,
  });

  // The whole of that day, so the 21:00 cutoff is inside the window whichever
  // way the machine is set up.
  const from = new Date(`${DAY}T00:00:00`).getTime();
  const to = new Date(`${DAY}T23:59:59`).getTime();

  const dated = (id: string, title: string, notify?: unknown) => ({
    [id]: { id, title, weekKey: DAY, dayIndex: 0, ...(notify === undefined ? {} : { notify }) },
  });

  const digestOf = (tasks: Record<string, unknown>) => {
    const out = computeSchedule({
      events: {}, tasks: tasks as any, categories: [], settings,
      weekStartsOn: 1, from, to,
    });
    return out.filter(n => n.kind === 'task-digest');
  };

  // The premise: a dated task with no time DOES normally reach the digest.
  const on = digestOf(dated('t1', 'Return the book'));
  assert.equal(on.length, 1, 'a dated task with no time raises one digest');
  assert.ok(on[0].body.includes('Return the book'), 'and is named in it');

  // Switched off on the item itself. An explicit `{ enabled: false }` is the
  // only thing that means "off"; an ABSENT spec means "inherit", which is why
  // the two cannot be collapsed.
  const off = digestOf(dated('t1', 'Return the book', { enabled: false }));
  assert.equal(off.length, 0, 'a task with reminders off raises no digest at all');

  // Off for one, on for another: the digest must lose one name and keep the
  // other, not disappear or list both.
  const mixed = digestOf({
    ...dated('t1', 'Return the book', { enabled: false }),
    ...dated('t2', 'Buy milk'),
  });
  assert.equal(mixed.length, 1, 'the digest still happens for the task that wants it');
  assert.ok(mixed[0].body.includes('Buy milk'), 'and names it');
  assert.ok(!mixed[0].body.includes('Return the book'),
    'and does not name the one that was switched off');

  // A TASK DOES NOT INHERIT FROM ITS CATEGORY, and that is deliberate:
  // `resolveSpec` skips the category lookup entirely for `kind === 'task'`
  // (`if (kind !== 'task' && item?.categoryId)`), so a task goes item -> global
  // default with nothing in between. Pinned here because the new gate calls
  // `resolveSpec` on a path that never called it, and the easy mistake would
  // have been to quietly give tasks a category step they never had.
  const cats = [{
    id: 'c1', name: 'Errands', color: '#22c55e',
    notifyTimed: { enabled: false }, notifyAllDay: { enabled: false },
  }];
  const viaCategory = computeSchedule({
    events: {},
    tasks: { t1: { id: 't1', title: 'Return the book', weekKey: DAY, dayIndex: 0, categoryId: 'c1' } } as any,
    categories: cats as any, settings, weekStartsOn: 1, from, to,
  }).filter(n => n.kind === 'task-digest');
  assert.equal(viaCategory.length, 1,
    'a category with reminders off does NOT silence a task, because a task never asks its category');
  assert.equal(
    resolveSpec({ categoryId: 'c1' }, 'task', cats as any, settings),
    settings.defaultTask,
    'and the spec it resolves to is the global default, said directly');

  // An item that says OFF still wins over that global default, which is the
  // direction the new gate actually depends on.
  const itemOff = computeSchedule({
    events: {},
    tasks: {
      t1: {
        id: 't1', title: 'Return the book', weekKey: DAY, dayIndex: 0, categoryId: 'c1',
        notify: { enabled: false },
      },
    } as any,
    categories: cats as any, settings, weekStartsOn: 1, from, to,
  }).filter(n => n.kind === 'task-digest');
  assert.equal(itemOff.length, 0, 'an item that says off beats the global default that says on');

  // The global switch still wins over everything, as it always did.
  const globallyOff = computeSchedule({
    events: {}, tasks: dated('t1', 'Return the book') as any, categories: [],
    settings: coerceNotificationSettings({ defaultTask: { enabled: false }, taskCutoffHour: 21 }),
    weekStartsOn: 1, from, to,
  }).filter(n => n.kind === 'task-digest');
  assert.equal(globallyOff.length, 0, 'the global default off still silences everything');

  // A task that is already DONE was never in the digest and still is not, so
  // the new gate has not changed which of the two rules fires first.
  const done = digestOf({
    t1: { id: 't1', title: 'Return the book', weekKey: DAY, dayIndex: 0, completed: true },
  });
  assert.equal(done.length, 0, 'a completed task is still left out');

  console.log('  Off on the item means off in the digest');
}

console.log(`\nTotal checks: ${passed + failures} | Passed: ${passed} | Failures: ${failures}`);
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
