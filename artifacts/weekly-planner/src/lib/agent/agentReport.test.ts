// Tests for the report wording (src/lib/agent/agentReport.ts).
//
// The report is the user's evidence of what the assistant did, so its wording
// must be exact: right day, right time, right before/after, nothing dropped,
// nothing invented, and a clear flag on anything that could not be confirmed.
//
// Run with: npx tsx src/lib/agent/agentReport.test.ts

import assert from 'node:assert/strict';

import { buildReport, summarize, diffsOf, timeLabel, whenText, clockLabel, dayHeading, reportAsText } from './agentReport';
import type { ChangeSet, ChangeEntry, ItemFacts } from './agentTypes';

const ev = (over: Partial<ItemFacts>): ItemFacts => ({ kind: 'event', title: 'x', ...over });
const set = (entries: ChangeEntry[], id = 's1'): ChangeSet => ({ id, at: 0, tool: 'create_events', entries });
const NOW = new Date(2026, 8, 27);

async function main() {
  console.log('--- 1. TIMES AND DATES READ LIKE THE CALENDAR ---');
  {
    assert.equal(clockLabel('00:00', '12h'), '12:00 AM');
    assert.equal(clockLabel('12:00', '12h'), '12:00 PM');
    assert.equal(clockLabel('13:05', '12h'), '1:05 PM');
    assert.equal(clockLabel('13:05', '24h'), '13:05');
    assert.equal(timeLabel(ev({ date: '2026-10-09', startTime: '09:30', endTime: '10:15' }), '12h'), '9:30 AM to 10:15 AM');
    assert.equal(timeLabel(ev({ date: '2026-10-09', startTime: '13:00', pointInTime: true }), '12h'), '1:00 PM');
    assert.equal(timeLabel(ev({ date: '2026-10-09', startTime: '23:00', endTime: '01:30', overnight: true }), '24h'), '23:00 to 01:30 (next day)');
    assert.equal(timeLabel(ev({ date: '2026-10-09', allDay: true }), '12h'), 'All day');
    assert.equal(timeLabel(ev({ date: '2026-10-09', allDay: true, endDate: '2026-10-10' }), '12h'), 'All day, until Sat 10 Oct');
    assert.equal(timeLabel({ kind: 'task', title: 't', date: '2026-10-09' }, '12h'), 'Any time that day');
    assert.equal(timeLabel({ kind: 'task', title: 't' }, '12h'), 'No date');
    assert.equal(whenText(ev({ date: '2026-10-09', startTime: '09:30', endTime: '10:15' }), '12h'), 'Fri 9 Oct, 9:30 AM to 10:15 AM');
    assert.equal(whenText({ kind: 'task', title: 't' }, '12h'), 'No date');
    assert.equal(dayHeading('2026-10-09', NOW), 'Friday, 9 Oct');
    assert.equal(dayHeading('2027-01-02', NOW), 'Saturday, 2 Jan 2027');
    console.log('  ok');
  }

  console.log('--- 2. GROUPED BY DAY, IN CALENDAR ORDER ---');
  {
    const sets = [set([
      { action: 'added', kind: 'event', id: 'b', verified: true, after: ev({ title: 'Lunch', date: '2026-10-10', startTime: '12:00', endTime: '13:00' }) },
      { action: 'added', kind: 'event', id: 'a', verified: true, after: ev({ title: 'Modeling', date: '2026-10-10', startTime: '08:00', endTime: '12:00' }) },
      { action: 'added', kind: 'event', id: 'c', verified: true, after: ev({ title: 'Hackathon', date: '2026-10-09', allDay: true, endDate: '2026-10-10' }) },
      { action: 'added', kind: 'event', id: 'd', verified: true, after: ev({ title: 'Kick-off', date: '2026-10-09', startTime: '13:00', pointInTime: true }) },
      { action: 'added', kind: 'task', id: 'e', verified: true, after: { kind: 'task', title: 'Buy snacks' } },
    ])];
    const g = buildReport(sets, '12h', NOW);
    assert.deepEqual(g.map(x => x.heading), ['Friday, 9 Oct', 'Saturday, 10 Oct', 'No date']);
    assert.deepEqual(g[0].rows.map(r => r.facts?.title), ['Hackathon', 'Kick-off'], 'all-day first');
    assert.deepEqual(g[1].rows.map(r => r.facts?.title), ['Modeling', 'Lunch'], 'then by time');
    assert.equal(g[2].date, null);
    // Every entry appears exactly once.
    assert.equal(g.reduce((n, x) => n + x.rows.length, 0), 5);
    console.log('  ok');
  }

  console.log('--- 3. THE HEADLINE COUNTS EVERYTHING, BY KIND ---');
  {
    const s = summarize([set([
      { action: 'added', kind: 'event', id: '1', verified: true },
      { action: 'added', kind: 'event', id: '2', verified: true },
      { action: 'skipped', kind: 'event', id: '3', verified: true },
    ]), set([
      { action: 'updated', kind: 'task', id: '4', verified: true },
      { action: 'deleted', kind: 'event', id: '5', verified: false },
      { action: 'deleted', kind: 'task', id: '6', verified: true },
      { action: 'failed', kind: 'event', id: '7', verified: true },
    ], 's2')]);
    assert.equal(s.headline, '2 events added, 1 task changed, 2 items deleted, 1 event already there, 1 event not done');
    assert.equal(s.unverified, 1);
    assert.equal(summarize([]).headline, 'No changes');
    // Skipped and failed entries never count as "unconfirmed".
    assert.equal(summarize([set([{ action: 'failed', kind: 'event', id: 'x', verified: false }])]).unverified, 0);
    console.log('  ok');
  }

  console.log('--- 4. UPDATES SHOW EXACT BEFORE AND AFTER ---');
  {
    const e: ChangeEntry = {
      action: 'updated', kind: 'event', id: 'x', verified: true,
      before: ev({ title: 'Gym', date: '2026-09-30', startTime: '17:00', endTime: '18:00', color: '#111' }),
      after: ev({ title: 'Gym', date: '2026-10-01', startTime: '19:00', endTime: '20:00', category: 'Events', color: '#222' }),
      changed: ['date', 'startTime', 'endTime', 'category', 'color'],
    };
    assert.deepEqual(diffsOf(e, '12h'), [
      { field: 'date', label: 'Date', before: 'Wed 30 Sep', after: 'Thu 1 Oct' },
      { field: 'startTime', label: 'Starts', before: '5:00 PM', after: '7:00 PM' },
      { field: 'endTime', label: 'Ends', before: '6:00 PM', after: '8:00 PM' },
      { field: 'category', label: 'Category', before: 'None', after: 'Events' },
    ], 'colour is shown by the category chip, not as a raw hex diff');
    // Adds and deletes have no diff rows.
    assert.deepEqual(diffsOf({ ...e, action: 'added' }, '12h'), []);
    assert.deepEqual(diffsOf({ ...e, action: 'deleted' }, '12h'), []);
    // Booleans and absent values read as words.
    const b: ChangeEntry = {
      action: 'updated', kind: 'event', id: 'y', verified: true,
      before: ev({ title: 'a', repeats: 'Weekly (Mon)' }), after: ev({ title: 'a', allDay: true }),
      changed: ['allDay', 'repeats'],
    };
    assert.deepEqual(diffsOf(b, '12h').map(d => [d.before, d.after]), [['No', 'Yes'], ['Weekly (Mon)', "Doesn't repeat"]]);
    console.log('  ok');
  }

  console.log('--- 5. PLAIN TEXT COPY ---');
  {
    const txt = reportAsText([set([
      { action: 'added', kind: 'event', id: 'a', verified: true, after: ev({ title: 'Registration', date: '2026-10-09', startTime: '09:30', endTime: '10:15' }) },
      { action: 'updated', kind: 'event', id: 'b', verified: true, note: 'Only the Wed 30 Sep occurrence was changed.', before: ev({ title: 'Gym', date: '2026-09-30', startTime: '17:00', endTime: '18:00' }), after: ev({ title: 'Gym', date: '2026-09-30', startTime: '19:00', endTime: '20:00' }), changed: ['startTime', 'endTime'] },
    ])], '12h', NOW);
    assert.equal(txt, [
      '1 event added, 1 event changed',
      '',
      'Wednesday, 30 Sep',
      '  Changed: 7:00 PM to 8:00 PM  Gym',
      '      Starts: 5:00 PM -> 7:00 PM',
      '      Ends: 6:00 PM -> 8:00 PM',
      '      Only the Wed 30 Sep occurrence was changed.',
      '',
      'Friday, 9 Oct',
      '  Added: 9:30 AM to 10:15 AM  Registration',
    ].join('\n'));
    assert.doesNotMatch(txt, /[–—]/);
    console.log('  ok');
  }

  console.log('\nAll agentReport tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
