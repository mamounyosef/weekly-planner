// Tests Android alarm planning: the diff between what the planner wants and
// what the OS currently holds.
//
// The invariant that matters most is STABILITY. If an unchanged reminder is
// cancelled and re-registered on every sync, the phone burns battery, spends
// moments with no alarm registered at all, and can re-fire a reminder you have
// already seen. So "nothing changed" must produce literally zero OS calls, and
// that is asserted here far more often than the interesting cases.
//
// Run with: npx tsx src/lib/alarmPlan.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_HORIZON_MS,
  DEFAULT_LATE_TOLERANCE_MS,
  DEFAULT_MAX_ALARMS,
  describePlan,
  findMissed,
  planAlarms,
  planIsNoop,
  type RegisteredAlarm,
} from './alarmPlan';
import type { ScheduledNotification } from './notifications';

const NOW = 1_800_000_000_000; // a fixed instant; nothing here reads the clock
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A reminder the planner wants to fire. */
const want = (key: string, fireAt: number): ScheduledNotification => ({
  key,
  kind: 'event',
  itemId: key.split(':')[1] ?? 'ev',
  title: `Reminder ${key}`,
  fireAt,
  eventAt: fireAt + 10 * MIN,
  offsetMin: 10,
  allDay: false,
  priority: 'normal',
} as ScheduledNotification);

/** An alarm the OS currently holds. */
const reg = (key: string, fireAt: number, osId = `os-${key}`): RegisteredAlarm =>
  ({ key, osId, fireAt });

const keys = (list: { key: string }[]) => list.map(x => x.key).sort();

console.log('--- 1. NOTHING WANTED, NOTHING REGISTERED ---');
{
  const plan = planAlarms([], [], { now: NOW });
  assert.deepEqual(plan.cancel, []);
  assert.deepEqual(plan.schedule, []);
  assert.deepEqual(plan.keep, []);
  assert.deepEqual(plan.deferred, []);
  assert.equal(planIsNoop(plan), true);
  assert.equal(describePlan(plan), '0 reminders scheduled');
}

console.log('--- 2. FIRST RUN REGISTERS EVERYTHING ---');
{
  const desired = [want('event:a:2026-09-01:10', NOW + HOUR), want('event:b:2026-09-01:10', NOW + 2 * HOUR)];
  const plan = planAlarms([], desired, { now: NOW });
  assert.equal(plan.schedule.length, 2);
  assert.equal(plan.cancel.length, 0);
  assert.equal(planIsNoop(plan), false);
  assert.equal(plan.schedule[0].fireAt, NOW + HOUR, 'Soonest first');
}

console.log('--- 3. AN UNCHANGED SCHEDULE PRODUCES ZERO OS CALLS ---');
{
  const desired = [
    want('event:a:2026-09-01:10', NOW + HOUR),
    want('event:b:2026-09-01:10', NOW + 2 * HOUR),
    want('task:c:2026-09-01:0', NOW + 3 * HOUR),
  ];
  const registered = desired.map(d => reg(d.key, d.fireAt));

  // Twenty syncs in a row, as a phone polling every few minutes would do.
  for (let i = 0; i < 20; i++) {
    const plan = planAlarms(registered, desired, { now: NOW + i * MIN });
    assert.equal(plan.cancel.length, 0, `Sync ${i} cancelled nothing`);
    assert.equal(plan.schedule.length, 0, `Sync ${i} scheduled nothing`);
    assert.equal(plan.keep.length, 3, `Sync ${i} kept all three`);
    assert.equal(planIsNoop(plan), true, `Sync ${i} is a no-op`);
  }
  assert.equal(describePlan(planAlarms(registered, desired, { now: NOW })), '3 reminders scheduled');
}

console.log('--- 4. A MOVED EVENT IS RE-REGISTERED, ITS NEIGHBOURS ARE NOT ---');
{
  const registered = [
    reg('event:a:2026-09-01:10', NOW + HOUR),
    reg('event:b:2026-09-01:10', NOW + 2 * HOUR),
    reg('event:c:2026-09-01:10', NOW + 3 * HOUR),
  ];
  const desired = [
    want('event:a:2026-09-01:10', NOW + HOUR),
    want('event:b:2026-09-01:10', NOW + 5 * HOUR), // moved
    want('event:c:2026-09-01:10', NOW + 3 * HOUR),
  ];

  const plan = planAlarms(registered, desired, { now: NOW });
  assert.deepEqual(keys(plan.cancel), ['event:b:2026-09-01:10'], 'Only the moved one is cancelled');
  assert.deepEqual(keys(plan.schedule), ['event:b:2026-09-01:10'], 'and only it is re-registered');
  assert.deepEqual(keys(plan.keep), ['event:a:2026-09-01:10', 'event:c:2026-09-01:10'],
    'The others are untouched');
  assert.equal(plan.schedule[0].fireAt, NOW + 5 * HOUR, 'at the new time');

  // A one-millisecond difference still counts as moved — no fuzzy matching, or
  // an event nudged by a minute would keep its old alarm.
  const nudged = planAlarms(
    [reg('event:a:2026-09-01:10', NOW + HOUR)],
    [want('event:a:2026-09-01:10', NOW + HOUR + 1)],
    { now: NOW },
  );
  assert.equal(nudged.cancel.length, 1);
  assert.equal(nudged.schedule.length, 1);
}

console.log('--- 5. A DELETED OR CANCELLED REMINDER IS CANCELLED ---');
{
  const registered = [reg('event:a:2026-09-01:10', NOW + HOUR), reg('event:b:2026-09-01:10', NOW + 2 * HOUR)];
  const plan = planAlarms(registered, [want('event:a:2026-09-01:10', NOW + HOUR)], { now: NOW });
  assert.deepEqual(keys(plan.cancel), ['event:b:2026-09-01:10']);
  assert.equal(plan.cancel[0].osId, 'os-event:b:2026-09-01:10', 'with the OS id needed to cancel it');
  assert.equal(plan.schedule.length, 0);
  assert.equal(plan.keep.length, 1);

  // Everything removed at once.
  const all = planAlarms(registered, [], { now: NOW });
  assert.equal(all.cancel.length, 2);
  assert.equal(all.schedule.length, 0);
}

console.log('--- 6. ALREADY-HANDLED REMINDERS ARE NEVER RE-REGISTERED ---');
{
  // You dealt with it on the PC. It must not fire on the phone, and an alarm
  // already sitting there for it must be cancelled.
  const handled = new Set(['event:a:2026-09-01:10']);
  const desired = [want('event:a:2026-09-01:10', NOW + HOUR), want('event:b:2026-09-01:10', NOW + 2 * HOUR)];
  const registered = [reg('event:a:2026-09-01:10', NOW + HOUR)];

  const plan = planAlarms(registered, desired, { now: NOW, handledKeys: handled });
  assert.deepEqual(keys(plan.cancel), ['event:a:2026-09-01:10'], 'The handled alarm is cancelled');
  assert.deepEqual(keys(plan.schedule), ['event:b:2026-09-01:10'], 'and not re-registered');
  assert.equal(plan.keep.length, 0);
}

console.log('--- 7. THE PAST IS NOT SCHEDULED, BUT A JUST-MISSED ONE IS ---');
{
  const desired = [
    want('event:old:2026-09-01:10', NOW - 6 * HOUR),   // long gone
    want('event:recent:2026-09-01:10', NOW - MIN),     // 60s late, still worth firing
    want('event:soon:2026-09-01:10', NOW + MIN),
  ];
  const plan = planAlarms([], desired, { now: NOW });
  assert.deepEqual(keys(plan.schedule), ['event:recent:2026-09-01:10', 'event:soon:2026-09-01:10'],
    'A reminder from this morning is history; one from a minute ago is not');

  // Exactly at the tolerance boundary.
  const edge = planAlarms([], [want('k', NOW - DEFAULT_LATE_TOLERANCE_MS)], { now: NOW });
  assert.equal(edge.schedule.length, 1, 'Exactly at the tolerance still counts');
  const past = planAlarms([], [want('k', NOW - DEFAULT_LATE_TOLERANCE_MS - 1)], { now: NOW });
  assert.equal(past.schedule.length, 0, 'One millisecond beyond it does not');

  // A stale alarm still registered for a long-past reminder gets cleaned up.
  const stale = planAlarms([reg('event:old:2026-09-01:10', NOW - 6 * HOUR)], desired, { now: NOW });
  assert.ok(stale.cancel.some(c => c.key === 'event:old:2026-09-01:10'),
    'and the alarm left behind for it is cancelled');
}

console.log('--- 8. THE HORIZON ---');
{
  const desired = [
    want('a', NOW + HOUR),
    want('b', NOW + DEFAULT_HORIZON_MS - MIN),
    want('c', NOW + DEFAULT_HORIZON_MS + MIN),
    want('d', NOW + 30 * 24 * HOUR),
  ];
  const plan = planAlarms([], desired, { now: NOW });
  assert.deepEqual(keys(plan.schedule), ['a', 'b'], 'Only what is inside the horizon');
  assert.equal(plan.deferred.length, 0,
    'Beyond-horizon items are not "deferred" — they are simply not due yet');

  assert.equal(DEFAULT_HORIZON_MS, 36 * HOUR, 'The horizon covers an overnight PC shutdown');

  // Exactly at the horizon is included.
  const edge = planAlarms([], [want('e', NOW + DEFAULT_HORIZON_MS)], { now: NOW });
  assert.equal(edge.schedule.length, 1);

  // A custom horizon is honoured.
  const short = planAlarms([], desired, { now: NOW, horizonMs: 2 * HOUR });
  assert.deepEqual(keys(short.schedule), ['a']);

  // An alarm registered for something now beyond the horizon is cancelled, so
  // the slot is free for something nearer.
  const shrink = planAlarms([reg('b', NOW + DEFAULT_HORIZON_MS - MIN)], desired,
    { now: NOW, horizonMs: 2 * HOUR });
  assert.deepEqual(keys(shrink.cancel), ['b']);
}

console.log('--- 9. THE ALARM CAP KEEPS THE SOONEST ---');
{
  const desired = Array.from({ length: 500 }, (_, i) => want(`k${i}`, NOW + (i + 1) * MIN));
  const plan = planAlarms([], desired, { now: NOW, maxAlarms: 10 });

  assert.equal(plan.schedule.length, 10, 'Only ten are registered');
  assert.equal(plan.deferred.length, 490, 'and the rest are reported, not silently dropped');
  assert.deepEqual(plan.schedule.map(s => s.key), Array.from({ length: 10 }, (_, i) => `k${i}`),
    'The ten SOONEST are the ones kept');
  assert.ok(plan.deferred.every(d => d.fireAt > plan.schedule[9].fireAt),
    'Everything deferred is later than everything scheduled');

  assert.ok(describePlan(plan).includes('490 beyond the limit'),
    'and the diagnostics screen can say so');
  assert.equal(DEFAULT_MAX_ALARMS, 400, 'The default leaves headroom below the OS limit');

  // As time passes and the early ones fire, deferred ones move into the window.
  const later = planAlarms([], desired, { now: NOW + 20 * MIN, maxAlarms: 10 });
  assert.equal(later.schedule[0].key, 'k14',
    'The window advanced — k14 fired 5 minutes ago, exactly at the late tolerance');
  assert.equal(later.schedule.length, 10);
  assert.ok(!later.schedule.some(s => s.key === 'k13'), 'and k13 is genuinely too old');

  // A cap of zero registers nothing rather than crashing.
  const none = planAlarms([], desired, { now: NOW, maxAlarms: 0 });
  assert.equal(none.schedule.length, 0);
  assert.equal(none.deferred.length, 500);

  // A negative cap is treated as zero, not as "slice from the end".
  const negative = planAlarms([], desired, { now: NOW, maxAlarms: -5 });
  assert.equal(negative.schedule.length, 0);
  assert.equal(negative.deferred.length, 500);
}

console.log('--- 10. THE CAP IS STABLE ACROSS SYNCS ---');
{
  // If the cap reshuffled which alarms are held, every sync would churn the OS.
  const desired = Array.from({ length: 50 }, (_, i) => want(`k${i}`, NOW + (i + 1) * HOUR));
  const first = planAlarms([], desired, { now: NOW, maxAlarms: 5, horizonMs: 100 * HOUR });
  const registered = first.schedule.map(s => reg(s.key, s.fireAt));

  const second = planAlarms(registered, desired, { now: NOW, maxAlarms: 5, horizonMs: 100 * HOUR });
  assert.equal(second.cancel.length, 0, 'The capped set does not churn');
  assert.equal(second.schedule.length, 0);
  assert.equal(second.keep.length, 5);
}

console.log('--- 11. DUPLICATES ARE COLLAPSED ---');
{
  // Two reminders with the same key must never become two alarms — the key is
  // the whole dedupe mechanism, on the phone as on the server.
  const desired = [
    want('event:a:2026-09-01:10', NOW + 2 * HOUR),
    want('event:a:2026-09-01:10', NOW + HOUR),
    want('event:a:2026-09-01:10', NOW + 3 * HOUR),
  ];
  const plan = planAlarms([], desired, { now: NOW });
  assert.equal(plan.schedule.length, 1, 'One key, one alarm');
  assert.equal(plan.schedule[0].fireAt, NOW + HOUR, 'and the earliest time wins');

  // Two OS alarms somehow holding the same key: keep one, cancel the extra.
  const dupes = [
    reg('event:a:2026-09-01:10', NOW + HOUR, 'os-1'),
    reg('event:a:2026-09-01:10', NOW + HOUR, 'os-2'),
  ];
  const cleaned = planAlarms(dupes, [want('event:a:2026-09-01:10', NOW + HOUR)], { now: NOW });
  assert.equal(cleaned.keep.length, 1, 'One registration is kept');
  assert.equal(cleaned.cancel.length, 1, 'and the duplicate is cancelled');
  assert.equal(cleaned.schedule.length, 0, 'without re-registering anything');
}

console.log('--- 12. MALFORMED INPUT IS IGNORED, NOT FATAL ---');
{
  // These can only arrive from a corrupted local database or a bad OTA, but the
  // alarm layer must not be the thing that crashes on launch.
  const junk = [
    null, undefined, {},
    { key: '', fireAt: NOW + HOUR },
    { key: 'k', fireAt: NaN },
    { key: 'k', fireAt: Infinity },
    { key: 'k' },
    { key: 42, fireAt: NOW + HOUR },
    want('good', NOW + HOUR),
  ] as ScheduledNotification[];

  const plan = planAlarms([], junk, { now: NOW });
  assert.deepEqual(keys(plan.schedule), ['good'], 'Only the sound reminder is scheduled');

  const junkRegistered = [
    null, undefined, {}, { key: 'x' }, { osId: 'y', fireAt: 1 },
    reg('good', NOW + HOUR),
  ] as RegisteredAlarm[];
  const plan2 = planAlarms(junkRegistered, [want('good', NOW + HOUR)], { now: NOW });
  assert.equal(plan2.keep.length, 1, 'and a corrupt registration list does not throw');
  assert.deepEqual(keys(plan2.cancel), ['x'],
    'A registration for a key the planner no longer knows is cleaned up, not left orphaned');
  assert.equal(plan2.schedule.length, 0, 'and nothing is registered twice');
}

console.log('--- 13. A CLOCK THAT JUMPS ---');
{
  const desired = [want('a', NOW + HOUR), want('b', NOW + 2 * HOUR)];
  const registered = desired.map(d => reg(d.key, d.fireAt));

  // The phone corrects its clock forward by a day (NTP, or a flight). Both
  // reminders are now in the past and must be cleaned up rather than fired.
  const jumped = planAlarms(registered, desired, { now: NOW + 24 * HOUR });
  assert.equal(jumped.schedule.length, 0, 'Nothing is registered for the past');
  assert.equal(jumped.cancel.length, 2, 'and the stale alarms are cleared');

  // The clock jumps backwards. Everything is now further away but still valid,
  // and — crucially — still unchanged, so no churn.
  const back = planAlarms(registered, desired, { now: NOW - 24 * HOUR });
  assert.equal(back.cancel.length, 0, 'A backwards clock jump does not churn the alarms');
  assert.equal(back.keep.length, 2);
}

console.log('--- 14. FINDING WHAT WAS MISSED ---');
{
  const registered = [
    reg('a', NOW - 2 * HOUR),
    reg('b', NOW - MIN),
    reg('c', NOW - 10),        // inside the grace period, may still be delivering
    reg('d', NOW + HOUR),      // not due
  ];

  const missed = findMissed(registered, { now: NOW });
  assert.deepEqual(keys(missed), ['a', 'b'], 'Only genuinely overdue alarms count as missed');
  assert.equal(missed[0].key, 'a', 'oldest first, so they can be reported in order');

  // Anything already dealt with elsewhere is not "missed".
  const handled = findMissed(registered, { now: NOW, handledKeys: new Set(['a']) });
  assert.deepEqual(keys(handled), ['b']);

  // A longer grace period.
  const patient = findMissed(registered, { now: NOW, graceMs: 2 * HOUR });
  assert.deepEqual(keys(patient), ['a']);

  // Corrupt entries are skipped.
  const junk = findMissed(
    [null, { key: 'x' }, { key: 'y', fireAt: NaN }, reg('z', NOW - HOUR)] as RegisteredAlarm[],
    { now: NOW },
  );
  assert.deepEqual(keys(junk), ['z']);

  assert.deepEqual(findMissed([], { now: NOW }), [], 'An empty device has missed nothing');
}

console.log('--- 15. A REALISTIC DAY, STEP BY STEP ---');
{
  // Morning: three reminders today, one tomorrow.
  let desired = [
    want('event:standup:2026-09-01:10', NOW + 2 * HOUR),
    want('event:lecture:2026-09-01:10', NOW + 5 * HOUR),
    want('task:digest:2026-09-01:0', NOW + 11 * HOUR),
    want('event:gym:2026-09-02:10', NOW + 26 * HOUR),
  ];
  let registered: RegisteredAlarm[] = [];

  const apply = (plan: ReturnType<typeof planAlarms>) => {
    const cancelled = new Set(plan.cancel.map(c => c.osId));
    registered = [
      ...registered.filter(r => !cancelled.has(r.osId)),
      ...plan.schedule.map(s => reg(s.key, s.fireAt)),
    ];
  };

  apply(planAlarms(registered, desired, { now: NOW }));
  assert.equal(registered.length, 4, 'All four are registered');

  // A sync ten minutes later with nothing changed.
  let plan = planAlarms(registered, desired, { now: NOW + 10 * MIN });
  assert.equal(planIsNoop(plan), true, 'A quiet sync touches nothing');

  // The lecture moves an hour later on the PC.
  desired = desired.map(d =>
    d.key === 'event:lecture:2026-09-01:10' ? want(d.key, NOW + 6 * HOUR) : d);
  plan = planAlarms(registered, desired, { now: NOW + 20 * MIN });
  assert.equal(plan.cancel.length, 1);
  assert.equal(plan.schedule.length, 1);
  apply(plan);
  assert.equal(registered.length, 4, 'Still four alarms, one at a new time');

  // Standup fires and is dealt with.
  const handledKeys = new Set(['event:standup:2026-09-01:10']);
  plan = planAlarms(registered, desired, { now: NOW + 2 * HOUR + MIN, handledKeys });
  assert.deepEqual(keys(plan.cancel), ['event:standup:2026-09-01:10']);
  apply(plan);
  assert.equal(registered.length, 3);

  // Evening: the gym reminder is deleted on the PC.
  desired = desired.filter(d => d.key !== 'event:gym:2026-09-02:10');
  plan = planAlarms(registered, desired, { now: NOW + 12 * HOUR, handledKeys });
  assert.ok(plan.cancel.some(c => c.key === 'event:gym:2026-09-02:10'));
  apply(plan);

  // Everything that remains is either fired or still pending, and a final sync
  // settles to a no-op.
  plan = planAlarms(registered, desired, { now: NOW + 12 * HOUR, handledKeys });
  assert.equal(planIsNoop(plan), true, 'The day ends with a stable, quiet schedule');
}

console.log('--- 16. DESCRIPTIONS READ LIKE ENGLISH ---');
{
  assert.equal(describePlan({ cancel: [], schedule: [], keep: [], deferred: [] }),
    '0 reminders scheduled');
  assert.equal(describePlan({ cancel: [], schedule: [], keep: [reg('a', 1)], deferred: [] }),
    '1 reminder scheduled', 'singular, not "1 reminders"');
  assert.equal(describePlan({ cancel: [], schedule: [want('a', 1)], keep: [], deferred: [] }),
    '+1 (0 unchanged)');
  assert.equal(describePlan({ cancel: [reg('a', 1)], schedule: [], keep: [reg('b', 2)], deferred: [] }),
    '−1 (1 unchanged)');
  assert.equal(
    describePlan({ cancel: [reg('a', 1)], schedule: [want('b', 2)], keep: [], deferred: [want('c', 3)] }),
    '+1 −1 (0 unchanged), 1 beyond the limit');
}

console.log('\nALL PASS (Android alarm planning: stability, cap, horizon, misses)');
