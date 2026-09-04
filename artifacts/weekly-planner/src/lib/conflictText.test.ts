// Tests what a sync conflict card actually SAYS.
//
// THE ONE THAT MATTERS: a card has to answer "what is this about" before
// anything else on it means anything. It stopped doing that in four separate
// ways at once, and the screenshot that started this had all four on it:
//
//   UNTITLED ITEM                      <- the lookup knew 2 of 8 stores, and
//   Event edited on both devices          could not read a deleted record
//   DISAGREEMENT ON "ENDEDAT"          <- no phrase for the field
//   PC 2026-09-03T19:11:14.644Z        <- a value nobody can weigh up
//   PHONE 2026-09-03T19:11:14.579Z
//
// It was a focus session. Nothing on the card said so.
//
// Run with: npx tsx src/lib/conflictText.test.ts

import assert from 'node:assert/strict';
import {
  groupConflicts, describeConflict, describeEntity, storeLabel, storeNoun,
  type EntityPeek, type GroupedConflict,
} from './conflictText';
import type { SyncConflict, SyncStore } from './sync';

function makeConflict(
  id: string, store: any, entityId: string, field: string,
  winnerVal: any, winnerDevice: string, winnerAt: number,
  loserVal: any, loserDevice: string, loserAt: number,
  kind: 'field' | 'delete' = 'field'
): SyncConflict {
  return {
    id, store, entityId, field,
    winner: { value: winnerVal, device: winnerDevice, at: winnerAt, lamport: 2 },
    loser: { value: loserVal, device: loserDevice, at: loserAt, lamport: 1 },
    detectedAt: Math.max(winnerAt, loserAt),
    kind,
  };
}

/** Every store the sync engine has. If one is added, this list must grow. */
const ALL_STORES: SyncStore[] = [
  'events', 'tasks', 'taskLists', 'categories',
  'settings', 'prayerDone', 'prayerTimes', 'focusSessions',
];

function main() {
  const now = 1000000;

  console.log('--- 1. EMPTY LIST ---');
  {
    assert.deepEqual(groupConflicts([], now, () => null), []);
  }

  console.log('--- 2. THE SCREENSHOT: A FOCUS SESSION CALLED AN UNTITLED EVENT ---');
  {
    // Exactly the card that was reported. A conflict on `endedAt` in the
    // focusSessions store: the store the title lookup did not know, and the
    // field the phrase table did not have.
    const c = makeConflict(
      'c1', 'focusSessions', 's1', 'endedAt',
      '2026-09-03T19:11:14.644Z', 'pc', now - 3_600_000,
      '2026-09-03T19:11:14.579Z', 'android-1', now - 60_000,
    );
    const [group] = groupConflicts([c], now, () => ({
      startedAt: '2026-09-03T18:41:00.000Z',
      endedAt: '2026-09-03T19:11:14.644Z',
      durationSeconds: 1814,
    }));

    // WHAT IT IS. Not "Untitled item", and not an event.
    assert.equal(group.kindLabel, 'Focus session');
    assert.equal(group.subtitle, 'Focus session, changed on both devices');
    assert.ok(group.itemTitle.startsWith('Focus session,'), group.itemTitle);
    assert.notEqual(group.itemTitle, 'Untitled item');
    assert.equal(group.deleted, false);

    // WHICH FIELD. Not the raw key, and not shouted in quotes.
    const [desc] = group.conflicts;
    assert.equal(desc.fieldFriendlyName, 'when it ended');
    assert.ok(!desc.fieldFriendlyName.includes('"'), 'no raw key in quotes');

    // AND THE TWO VALUES, as a clock says them.
    assert.ok(!desc.winnerValue.includes('T'), desc.winnerValue);
    assert.ok(!desc.winnerValue.includes('Z'), desc.winnerValue);
    assert.ok(!desc.winnerValue.includes('.644'), 'and no milliseconds');
    assert.ok(/\d{1,2}:\d{2}/.test(desc.winnerValue), desc.winnerValue);
    assert.ok(/\d{1,2}:\d{2}/.test(desc.loserValue), desc.loserValue);
    assert.ok(desc.winnerValue.length < '2026-09-03T19:11:14.644Z'.length,
      'and shorter than the machine wrote it');
  }

  console.log('--- 3. EVERY STORE HAS A NAME. NONE OF THEM IS "EVENT". ---');
  {
    // The old line was `store === 'tasks' ? 'Task' : 'Event'`, so six of the
    // eight stores were announced as events.
    const expected: Record<SyncStore, string> = {
      events: 'Event',
      tasks: 'Task',
      taskLists: 'Task list',
      categories: 'Category',
      settings: 'Setting',
      prayerDone: 'Prayer',
      prayerTimes: 'Prayer times',
      focusSessions: 'Focus session',
    };
    for (const store of ALL_STORES) {
      assert.equal(storeLabel(store), expected[store], `${store} is named`);
      assert.equal(storeNoun(store), expected[store].toLowerCase());
      // And it reaches the card.
      const c = makeConflict('c', store, 'x', 'title', 'A', 'pc', now, 'B', 'phone', now);
      const [g] = groupConflicts([c], now, () => null);
      assert.equal(g.kindLabel, expected[store]);
      assert.ok(g.subtitle.startsWith(expected[store]), g.subtitle);
    }
    // Every label is distinct, or two different things read the same on screen.
    const labels = ALL_STORES.map(storeLabel);
    assert.equal(new Set(labels).size, labels.length, 'no two stores read alike');
  }

  console.log('--- 4. A THING WITH NO NAME IS DESCRIBED BY WHAT IT IS ---');
  {
    // "Untitled item" answered neither "what is it" nor "does it have a name".
    assert.equal(describeEntity('events', null), 'Untitled event');
    assert.equal(describeEntity('tasks', {}), 'Untitled task');
    assert.equal(describeEntity('categories', { title: '   ' }), 'Untitled category');
    assert.equal(describeEntity('taskLists', undefined), 'Untitled task list');

    // A name of any of the shapes the stores use.
    assert.equal(describeEntity('events', { title: 'Lunch' }), 'Lunch');
    assert.equal(describeEntity('categories', { name: 'Work' }), 'Work');
    assert.equal(describeEntity('taskLists', { name: '  Errands  ' }), 'Errands');
    assert.equal(describeEntity('events', { title: 'Lunch', name: 'Other' }), 'Lunch',
      'the title wins where both exist');

    // Things that never have a name say what they are instead.
    assert.equal(describeEntity('settings', {}), 'Planner settings');
    assert.equal(describeEntity('focusSessions', {}), 'A focus session');
    assert.equal(describeEntity('prayerDone', { date: '2026-09-03' }), 'Prayers on 2026-09-03');

    // A dated thing with no name can at least say when it was.
    assert.equal(describeEntity('events', { weekKey: '2026-08-31' }), 'Untitled event, 2026-08-31');
    assert.equal(describeEntity('tasks', { date: '2026-09-03' }), 'Untitled task, 2026-09-03');

    // A focus session is identified by when it ran, from either end of it.
    const started = describeEntity('focusSessions', { startedAt: '2026-09-03T18:41:00.000Z' });
    assert.ok(started.startsWith('Focus session, '), started);
    assert.notEqual(started, 'A focus session');
    const ended = describeEntity('focusSessions', { endedAt: '2026-09-03T19:11:00.000Z' });
    assert.ok(ended.startsWith('Focus session, '), ended);
    // A stamp that is not a date does not produce "Invalid Date" at anybody.
    assert.equal(describeEntity('focusSessions', { startedAt: 'not-a-date' }), 'A focus session');
  }

  console.log('--- 5. A DELETED THING KEEPS ITS NAME, AND SAYS IT IS GONE ---');
  {
    // THE ONE THAT MATTERED MOST. The screen read titles out of the live
    // planner, which hides deleted records by design, so the card about a
    // deletion was the one card guaranteed to say "Untitled item" -- exactly
    // where knowing what was deleted matters most.
    const c = makeConflict('c1', 'events', 'e1', '__deleted', true, 'pc', now, false, 'phone', now, 'delete');
    const [group] = groupConflicts([c], now, () => ({
      title: 'Dentist',
      __deleted: true,
    }));
    assert.equal(group.itemTitle, 'Dentist', 'the name survives the deletion');
    assert.equal(group.deleted, true);
    assert.equal(group.subtitle, 'Event, deleted on one device');

    // A live record says the other thing.
    const [live] = groupConflicts(
      [makeConflict('c2', 'events', 'e2', 'title', 'A', 'pc', now, 'B', 'phone', now)],
      now, () => ({ title: 'Dentist' }));
    assert.equal(live.deleted, false);
    assert.equal(live.subtitle, 'Event, changed on both devices');

    // Both spellings of the tombstone flag count, since one is the engine's
    // internal name and the other is what a plain record carries.
    for (const flag of [{ deleted: true }, { __deleted: true }]) {
      const [g] = groupConflicts([c], now, () => ({ title: 'X', ...flag }));
      assert.equal(g.deleted, true, JSON.stringify(flag));
    }
  }

  console.log('--- 6. EVERY FIELD THAT CAN CONFLICT HAS A PHRASE ---');
  {
    // A field with no entry used to be shouted back as `"endedAt"`, which reads
    // as a fault in the app rather than as a question.
    const known: Array<[string, string]> = [
      ['title', 'the title'],
      ['startTime', 'the start time'],
      ['endTime', 'the end time'],
      ['notes', 'the notes'],
      ['categoryId', 'the category'],
      ['weekKey', 'the date'],
      ['completed', 'whether it is done'],
      ['endedAt', 'when it ended'],
      ['startedAt', 'when it started'],
      ['durationSeconds', 'how long it ran'],
      ['plannedSeconds', 'how long it was set for'],
      ['order', 'the position in the list'],
      ['parentId', 'which task it is a step of'],
      ['name', 'the name'],
    ];
    for (const [field, phrase] of known) {
      const c = makeConflict('c', 'events', 'e', field, 1, 'pc', now, 2, 'phone', now);
      assert.equal(describeConflict(c, now).fieldFriendlyName, phrase, field);
    }

    // And a field nobody has thought of yet still comes out as words.
    const unknown: Array<[string, string]> = [
      ['someNewThing', 'the some new thing'],
      ['snake_case_field', 'the snake case field'],
      ['x', 'the x'],
      ['HTTPStatus', 'the http status'],
    ];
    for (const [field, phrase] of unknown) {
      const c = makeConflict('c', 'events', 'e', field, 1, 'pc', now, 2, 'phone', now);
      const got = describeConflict(c, now).fieldFriendlyName;
      assert.equal(got, phrase, field);
      assert.ok(!got.includes('"'), `${field} is not quoted at the user`);
    }
    // Nothing at all still says something.
    const blank = makeConflict('c', 'events', 'e', '', 1, 'pc', now, 2, 'phone', now);
    assert.equal(describeConflict(blank, now).fieldFriendlyName, 'this field');
  }

  console.log('--- 7. VALUES A PERSON CAN WEIGH UP ---');
  {
    const cases: Array<{ field: string; value: unknown; expect: string | RegExp }> = [
      { field: 'title', value: 'Standup', expect: 'Standup' },
      { field: 'startTime', value: '09:00', expect: '09:00' },
      { field: 'weekKey', value: '2026-08-31', expect: '2026-08-31' },
      { field: 'completed', value: true, expect: 'Yes' },
      { field: 'completed', value: false, expect: 'No' },
      { field: 'color', value: 'sage', expect: 'sage' },
      { field: 'daysSpan', value: 3, expect: '3' },
      { field: 'title', value: '', expect: '(empty)' },
      { field: 'title', value: '   ', expect: '(empty)' },
      { field: 'title', value: null, expect: '(empty)' },
      { field: 'title', value: undefined, expect: '(empty)' },
      { field: 'completedDates', value: [], expect: '(none)' },
      { field: 'completedDates', value: ['2026-08-31'], expect: '2026-08-31' },

      // The ones the screenshot was full of. The exact wording is the device's
      // locale, so what is asserted is what a person needs: a month, a day and
      // a clock, and none of the machine's punctuation.
      { field: 'endedAt', value: '2026-09-03T19:11:14.644Z', expect: /^[^TZ]*\d{1,2}:\d{2}/ },
      { field: 'startedAt', value: '2026-09-03T18:41:00.000Z', expect: /^[^TZ]*\d{1,2}:\d{2}/ },
      { field: 'completedAt', value: 1756926674644, expect: /^[^TZ]*\d{1,2}:\d{2}/ },
      { field: 'durationSeconds', value: 1814, expect: '30 minutes' },
      { field: 'durationSeconds', value: 45, expect: '45 seconds' },
      { field: 'durationSeconds', value: 1, expect: '1 second' },
      { field: 'durationSeconds', value: 60, expect: '1 minute' },
      { field: 'durationSeconds', value: 3600, expect: '1 hour' },
      { field: 'plannedSeconds', value: 5400, expect: '1 hour 30 min' },
      { field: 'durationSeconds', value: 7200, expect: '2 hours' },
    ];
    for (const tc of cases) {
      const c = makeConflict('c', 'events', 'e', tc.field, tc.value, 'pc', now, 'other', 'phone', now);
      const got = describeConflict(c, now).winnerValue;
      if (tc.expect instanceof RegExp) {
        assert.ok(tc.expect.test(got), `${tc.field}=${String(tc.value)} rendered "${got}"`);
      } else {
        assert.equal(got, tc.expect, `${tc.field}=${String(tc.value)}`);
      }
    }
  }

  console.log('--- 8. NOTHING ON A CARD IS UNBOUNDED ---');
  {
    // A card has two buttons under it. A value that runs to a thousand
    // characters pushes them off the screen, and the choice with them.
    const long = 'very long note '.repeat(50);
    const c = makeConflict('c', 'events', 'e', 'notes', long, 'pc', now, 'short', 'phone', now);
    const desc = describeConflict(c, now);
    assert.ok(desc.winnerValue.length <= 80, `cut to ${desc.winnerValue.length}`);
    assert.ok(desc.winnerValue.endsWith('...'), 'and says it was cut');
    assert.equal(desc.loserValue, 'short', 'a short one is untouched');

    // A long list is counted rather than printed.
    const many = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
    const cl = makeConflict('c', 'events', 'e', 'completedDates', many, 'pc', now, [], 'phone', now);
    const dl = describeConflict(cl, now);
    assert.ok(dl.winnerValue.includes('and 26 more'), dl.winnerValue);

    // An object that cannot be serialised does not throw on the way to a card.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cc = makeConflict('c', 'events', 'e', 'recur', cyclic, 'pc', now, null, 'phone', now);
    assert.equal(describeConflict(cc, now).winnerValue, '(unreadable)');

    // Arabic and other scripts pass through untouched when they are short.
    const car = makeConflict('c', 'events', 'e', 'title', 'صلاة', 'pc', now, 'x', 'phone', now);
    assert.equal(describeConflict(car, now).winnerValue, 'صلاة');
  }

  console.log('--- 9. TIMES, DATES, FUTURE TIMESTAMPS ---');
  {
    const future = now + 60000;
    const past = now - 3600000;
    const c1 = makeConflict('c1', 'events', 'e1', 'title', 'A', 'pc-desk', future, 'B', 'phone1', past);
    const desc = describeConflict(c1, now);
    assert.equal(desc.winnerTime, 'just now', 'a clock that is ahead does not say "in -1 minutes"');
    assert.equal(desc.loserTime, '1 hour ago');
    assert.equal(desc.winnerLabel, 'PC');
    assert.equal(desc.loserLabel, 'phone');
  }

  console.log('--- 10. DEVICE LABELS ---');
  {
    const cases = [
      ['pc-home', 'PC'],
      ['android-1', 'phone'],
      ['phone-2', 'phone'],
      ['tablet-9', 'tablet'],
      ['unknown-device', 'unknown-device'],
    ];
    for (const [raw, expected] of cases) {
      const c = makeConflict('c1', 'events', 'e1', 'title', 'A', raw, now, 'B', 'pc', now);
      assert.equal(describeConflict(c, now).winnerLabel, expected);
    }
  }

  console.log('--- 11. THE CHOICES ARE SHORT AND SAY WHAT THEY DO ---');
  {
    const del = describeConflict(
      makeConflict('c', 'events', 'e', '__deleted', true, 'pc', now, false, 'phone', now, 'delete'), now);
    assert.equal(del.isDelete, true);
    assert.deepEqual(del.choices.map(c => c.label), ['Keep it', 'Delete it']);

    const field = describeConflict(
      makeConflict('c', 'events', 'e', 'title', 'A', 'pc', now, 'B', 'android-1', now), now);
    assert.equal(field.isDelete, false);
    assert.deepEqual(field.choices.map(c => c.label), ['Keep PC', 'Keep phone']);

    // Every consequence is one short sentence: this sits under a button on a
    // phone, and a paragraph there is a paragraph nobody reads.
    for (const desc of [del, field]) {
      for (const choice of desc.choices) {
        assert.ok(choice.consequence.length <= 40, `"${choice.consequence}" is ${choice.consequence.length}`);
        assert.ok(choice.consequence.endsWith('.'), choice.consequence);
        assert.equal(choice.consequence.split('.').filter(Boolean).length, 1, 'one sentence');
      }
    }
  }

  console.log('--- 12. NO CARD IS EVER NAMELESS, WHATEVER IT IS HANDED ---');
  {
    // Across every store, and every shape of record the lookup can return.
    const records: EntityPeek[] = [
      null, undefined, {}, { title: '' }, { title: '   ' }, { name: null as never },
      { title: 'Real name' }, { __deleted: true }, { weekKey: '2026-08-31' },
    ];
    for (const store of ALL_STORES) {
      for (const record of records) {
        const c = makeConflict('c', store, 'x', 'title', 'A', 'pc', now, 'B', 'phone', now);
        const [g] = groupConflicts([c], now, () => record);
        assert.ok(g.itemTitle.trim().length > 0, `${store}: a card always says something`);
        assert.notEqual(g.itemTitle, 'Untitled item', `${store}: never the old catch-all`);
        assert.ok(g.subtitle.includes(storeLabel(store)), `${store}: the subtitle names the kind`);
        assert.equal(typeof g.deleted, 'boolean');
      }
    }
  }

  console.log('--- 13. PROPERTY: NEVER LOSES OR DUPLICATES A CONFLICT ---');
  {
    const conflicts: SyncConflict[] = [];
    for (let i = 0; i < 100; i++) {
      const store = i % 2 === 0 ? 'events' : 'tasks';
      const entityId = `e${i % 10}`;
      conflicts.push(makeConflict(`c${i}`, store, entityId, `field${i}`, i, 'pc', now, -i, 'phone', now));
    }
    conflicts.push(makeConflict('c_del', 'events', 'e0', '__deleted', true, 'pc', now, false, 'phone', now, 'delete'));

    const groups = groupConflicts(conflicts, now, (s, id) => ({ title: `Item ${id}` }));

    let total = 0;
    const seen = new Set<string>();
    for (const group of groups) {
      for (const desc of group.conflicts) { total++; seen.add(desc.raw.id); }
    }
    assert.equal(total, 101, 'every conflict is on some card');
    assert.equal(seen.size, 101, 'and on exactly one');
    assert.equal(groups.length, 10, 'ten things were in dispute');

    // The delete is drawn first on its card: it is the question that decides
    // whether the others are worth answering at all.
    const withDelete = groups.find(g => g.conflicts.some(c => c.isDelete)) as GroupedConflict;
    assert.ok(withDelete, 'the delete is somewhere');
    assert.equal(withDelete.conflicts[0].isDelete, true, 'and it is first');
  }

  console.log('\nALL PASS (conflictText: what it is, which field, and values you can read)');
}

main();
