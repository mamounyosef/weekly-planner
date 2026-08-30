// Tests the record builder the phone's editor writes through.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// A malformed record does not fail. It syncs perfectly, reaches the PC intact,
// and then sits in the wrong week column, on no day at all, or titled
// "Untitled" — every one of which reads as sync being broken rather than as a
// bad record. The two traps that have already caused exactly that:
//
//   • events store their title in `content`, tasks in `title`
//   • an item is stored as a week anchor plus an offset, so writing the anchor
//     with the wrong week start puts it in the wrong column even though the
//     date it resolves to is correct
//
// Run with: npx tsx src/lib/draft.test.ts

import assert from 'node:assert/strict';
import {
  anchorFor,
  applyCategoryDefaults,
  blankDraft,
  buildEventRecord,
  buildTaskRecord,
  dateOfAnchor,
  describeNotify,
  draftFromRecord,
  fromTimeString,
  inferWeekStartsOn,
  toTimeString,
  validateDraft,
  type DraftInput,
} from './draft';
import { occursOn } from './agenda';
import { offsetLabel, OFFSET_PRESETS_TIMED } from './notifications';

const META = { id: 'new1', now: 1_700_000_000_000, weekStartsOn: 1 as const };

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  title: 'Lecture',
  date: '2026-08-29',
  allDay: false,
  startMin: 9 * 60,
  endMin: 10 * 60,
  ...over,
});

function main() {
  console.log('--- 1. TIME STRINGS ROUND TRIP ---');
  {
    for (const [min, text] of [[0, '00:00'], [9 * 60, '09:00'], [23 * 60 + 59, '23:59'], [754, '12:34']] as const) {
      assert.equal(toTimeString(min), text, `${min} formats as ${text}`);
      assert.equal(fromTimeString(text), min, `${text} parses back`);
    }
    assert.equal(toTimeString(1440), '00:00', 'Midnight wraps rather than reading 24:00');
    assert.equal(toTimeString(-60), '23:00', 'and a negative wraps too');

    for (const bad of ['', '9:00 am', '24:00', '09:60', '-1:00', 'noon', '0900', '09:0']) {
      assert.equal(fromTimeString(bad), null, `"${bad}" is not a time`);
    }
    assert.equal(fromTimeString(' 09:00 '), 540, 'Surrounding space is tolerated');
  }

  console.log('--- 2. THE WEEK START IS READ OFF THE USER\'S OWN DATA ---');
  {
    // His planner: weekKey 2026-08-24 with dayIndex 5 resolves to Sat 2026-08-29,
    // which is only true if weeks begin on Monday.
    const real = { a: { weekKey: '2026-08-24', dayIndex: 5 } };
    assert.equal(inferWeekStartsOn(real), 1, 'Monday, as this planner actually uses');

    const sunday = { a: { weekKey: '2026-08-23' } };
    assert.equal(inferWeekStartsOn(sunday), 0, 'A Sunday-start planner reads as Sunday');

    // One stray record from an older build must not outvote the rest.
    const mostly = {
      a: { weekKey: '2026-08-24' }, b: { weekKey: '2026-08-17' },
      c: { weekKey: '2026-08-10' }, d: { weekKey: '2026-08-23' },
    };
    assert.equal(inferWeekStartsOn(mostly), 1, 'The majority wins');

    assert.equal(inferWeekStartsOn({}), 0, 'An empty planner defaults to Sunday');
    assert.equal(inferWeekStartsOn(undefined), 0, 'and so does no planner at all');
    assert.equal(inferWeekStartsOn({ a: {} }, { b: { weekKey: 42 as any } }), 0,
      'Records with no usable anchor are skipped');
    assert.equal(inferWeekStartsOn({ a: { weekKey: 'not-a-date' } }), 0,
      'and so is an unparseable one');

    // Both stores are consulted.
    assert.equal(inferWeekStartsOn({}, { t: { weekKey: '2026-08-23' } }), 0,
      'Tasks count as evidence too');
  }

  console.log('--- 3. ANCHORS ROUND TRIP, EVERY DAY OF THE WEEK ---');
  {
    for (const weekStartsOn of [0, 1, 6] as const) {
      for (let i = 0; i < 40; i++) {
        const d = new Date(2026, 7, 1 + i);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const anchor = anchorFor(date, weekStartsOn);
        assert.ok(anchor.dayIndex >= 0 && anchor.dayIndex <= 6,
          `ws=${weekStartsOn} ${date}: the offset is inside the week (${anchor.dayIndex})`);
        assert.equal(dateOfAnchor(anchor), date,
          `ws=${weekStartsOn} ${date}: the anchor resolves back to the same day`);
      }
    }
  }

  console.log('--- 4. A BUILT RECORD LANDS ON THE DAY IT WAS ASKED FOR ---');
  {
    // The end-to-end property that matters: whatever the editor produced, the
    // shared expansion must place it on the chosen date and no other.
    for (const date of ['2026-08-29', '2026-08-31', '2026-09-01', '2026-12-31', '2027-01-01']) {
      const ev = buildEventRecord(draft({ date }), META) as any;
      assert.equal(occursOn(ev, date, 1), true, `${date}: the event is on that day`);
      const next = new Date(new Date(`${date}T00:00:00`).getTime() + 86_400_000);
      const nextYmd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
      assert.equal(occursOn(ev, nextYmd, 1), false, `${date}: and not the day after`);

      const task = buildTaskRecord(draft({ date }), META) as any;
      assert.equal(occursOn(task, date, 1), true, `${date}: the task lands there too`);
    }
  }

  console.log('--- 5. EVENTS USE content, TASKS USE title ---');
  {
    const ev = buildEventRecord(draft({ title: '  Physics  ' }), META);
    assert.equal(ev.content, 'Physics', 'An event stores a trimmed `content`');
    assert.equal(ev.title, undefined, 'and never `title`');

    const task = buildTaskRecord(draft({ title: '  Bins  ' }), META);
    assert.equal(task.title, 'Bins', 'A task stores a trimmed `title`');
    assert.equal(task.content, undefined, 'and never `content`');
  }

  console.log('--- 6. ALL-DAY CLEARS THE TIMES, TIMED CLEARS ALL-DAY ---');
  {
    const allDay = buildEventRecord(draft({ allDay: true }), META);
    assert.equal(allDay.allDay, true);
    assert.equal(allDay.startTime, undefined, 'An all-day event carries no start time');
    assert.equal(allDay.endTime, undefined, 'nor an end time');

    // Switching an existing all-day event back to timed must clear the flag, or
    // it keeps sorting with the all-day row on the PC.
    const back = buildEventRecord(draft({ allDay: false }), META, allDay);
    assert.equal(back.allDay, undefined, 'Going back to timed clears the flag');
    assert.equal(back.startTime, '09:00');
    assert.equal(back.endTime, '10:00');
  }

  console.log('--- 7. EDITING PRESERVES WHAT THE EDITOR NEVER SAW ---');
  {
    const existing = {
      id: 'ev1', content: 'Old', weekKey: '2026-08-24', dayIndex: 1,
      startTime: '09:00', endTime: '10:00',
      // Things only the PC sets. Losing any of them on a phone edit would be
      // silent damage: the recurrence would break, or Google would re-upload.
      recur: { freq: 'weekly', interval: 1 },
      exdates: ['2026-09-01'],
      completedDates: ['2026-08-25'],
      categoryId: 'cat7',
      gCalETag: 'etag-123',
      noCheckbox: true,
      locked: true,
    };
    // Through `draftFromRecord`, because that is what a real edit does: the
    // sheet is filled FROM the record, changed, and written back. Building a
    // draft by hand would mean "no repeat, no category", and the editor now
    // genuinely owns those fields — clearing them would be correct.
    const filled = draftFromRecord(existing, 'events', '2026-08-24');
    const edited = buildEventRecord(
      { ...filled, title: 'New', date: '2026-08-26' }, META, existing,
    ) as any;

    assert.equal(edited.content, 'New', 'The title changed');
    assert.equal(edited.dayIndex, 2, 'and so did the day');
    assert.deepEqual(edited.recur, existing.recur, 'The repeat rule survived');
    assert.deepEqual(edited.exdates, existing.exdates, 'and the exclusions');
    assert.deepEqual(edited.completedDates, existing.completedDates, 'and the ticks');
    assert.equal(edited.categoryId, 'cat7', 'and the category');
    assert.equal(edited.gCalETag, 'etag-123', 'and Google bookkeeping');
    assert.equal(edited.noCheckbox, true, 'and a choice made on the PC is not reset');
    assert.equal(edited.locked, true, 'nor the series lock');
    assert.equal(edited.categoryId, 'cat7', 'and the category came through the editor intact');
  }

  console.log('--- 8. NEW RECORDS GET THE DEFAULTS THE PC WRITES ---');
  {
    const ev = buildEventRecord(draft(), META);
    assert.equal(ev.noCheckbox, false);
    assert.equal(ev.noDuration, false);
    assert.equal(ev.deleted, false);
    assert.equal(ev.id, 'new1', 'with the id it was given');
    assert.equal(ev.updatedAt, META.now, 'stamped now');
  }

  console.log('--- 9. VALIDATION CATCHES WHAT A PERSON ACTUALLY GETS WRONG ---');
  {
    assert.deepEqual(validateDraft(draft()), [], 'A good draft has no problems');

    const noTitle = validateDraft(draft({ title: '   ' }));
    assert.equal(noTitle.length, 1);
    assert.equal(noTitle[0].field, 'title', 'Whitespace is not a name');

    const backwards = validateDraft(draft({ startMin: 10 * 60, endMin: 9 * 60 }));
    assert.equal(backwards[0].field, 'time', 'An end before the start is caught');

    const zero = validateDraft(draft({ startMin: 9 * 60, endMin: 9 * 60 }));
    assert.equal(zero.length, 1, 'and so is a zero-length event');

    assert.deepEqual(validateDraft(draft({ allDay: true, startMin: null, endMin: null })), [],
      'An all-day item needs no times at all');
    assert.deepEqual(validateDraft(draft({ endMin: null })), [],
      'and an open-ended timed item is allowed');
    assert.equal(validateDraft(draft({ startMin: null }))[0].field, 'time',
      'but a timed item with no start is not');
    assert.equal(validateDraft(draft({ date: 'nonsense' })).some(p => p.field === 'date'), true,
      'An unparseable date is caught');
  }

  console.log('--- 10. FILLING THE EDITOR FROM AN EXISTING RECORD ---');
  {
    const ev = {
      content: 'Physics', weekKey: '2026-08-24', dayIndex: 5,
      startTime: '09:30', endTime: '11:00', notes: 'bring laptop', color: 'sage',
    };
    const d = draftFromRecord(ev, 'events', '2026-01-01');
    assert.equal(d.title, 'Physics');
    assert.equal(d.date, '2026-08-29', 'The anchor is turned back into a date');
    assert.equal(d.allDay, false);
    assert.equal(d.startMin, 570);
    assert.equal(d.endMin, 660);
    assert.equal(d.notes, 'bring laptop');
    assert.equal(d.colour, 'sage');

    const task = draftFromRecord({ title: 'Bins', weekKey: '2026-08-24', dayIndex: 0 }, 'tasks', '2026-01-01');
    assert.equal(task.title, 'Bins', 'A task reads its title from the right field');
    assert.equal(task.date, '2026-08-24');

    // Round trip: record → draft → record must not drift.
    const rebuilt = buildEventRecord(d, { ...META, id: 'ev1' }) as any;
    const again = draftFromRecord(rebuilt, 'events', '2026-01-01');
    assert.deepEqual(again, d, 'A record survives a trip through the editor unchanged');
  }

  console.log('--- 11. DEGENERATE RECORDS DO NOT CRASH THE EDITOR ---');
  {
    for (const [label, rec] of [
      ['empty', {}],
      ['no anchor', { content: 'x' }],
      ['wrong types', { content: 42, weekKey: 7, dayIndex: 'x', startTime: true }],
      ['null everywhere', { content: null, weekKey: null, startTime: null }],
    ] as [string, any][]) {
      const d = draftFromRecord(rec, 'events', '2026-08-29');
      assert.equal(typeof d.title, 'string', `${label}: title is always a string`);
      assert.equal(typeof d.date, 'string', `${label}: date is always a string`);
      assert.ok(d.startMin === null || typeof d.startMin === 'number',
        `${label}: the start is a number or nothing`);
    }
  }

  console.log('--- 12. THE BLANK DRAFT IS SOMETHING YOU CAN JUST SAVE ---');
  {
    for (const now of [0, 7 * 60 + 3, 12 * 60, 23 * 60 + 58, 23 * 60 + 59]) {
      const d = blankDraft('2026-08-29', now);
      const problems = validateDraft({ ...d, title: 'x' });
      assert.deepEqual(problems, [], `at ${now} minutes the default draft is valid`);
      assert.ok(d.startMin !== null && d.endMin !== null && d.endMin > d.startMin,
        `at ${now} minutes the end is after the start`);
      assert.ok(d.startMin! % 30 === 0, 'and the start is on a half hour');
    }
  }

  console.log('--- 13. THE OTHER SEVEN FIELDS SURVIVE A ROUND TRIP ---');
  {
    // Every field the PC's popup can set. A field that writes but does not read
    // back is the failure that made "Untitled" items: nothing errors, the value
    // is simply gone the next time the sheet is opened.
    const full: DraftInput = {
      title: 'Physics',
      date: '2026-08-29',
      allDay: false,
      startMin: 9 * 60,
      endMin: 10 * 60,
      notes: 'bring laptop',
      colour: 'sage',
      categoryId: 'uni',
      recur: { freq: 'weekly', interval: 2, byWeekday: [1, 3] },
      notify: { enabled: true, rules: [{ id: 'r0', offsetMin: 15 }], priority: 'normal' },
      noCheckbox: true,
      noDuration: true,
      locked: true,
    };

    const rec = buildEventRecord(full, META) as any;
    assert.equal(rec.categoryId, 'uni');
    assert.deepEqual(rec.recur, full.recur);
    assert.deepEqual(rec.notify, full.notify);
    assert.equal(rec.noCheckbox, true);
    assert.equal(rec.noDuration, true);
    assert.equal(rec.locked, true);

    const back = draftFromRecord(rec, 'events', '2026-01-01');
    assert.deepEqual(back.recur, full.recur, 'The repeat reads back');
    assert.deepEqual(back.notify, full.notify, 'and the reminder');
    assert.equal(back.categoryId, 'uni', 'and the category');
    assert.equal(back.noCheckbox, true, 'and the flags');
    assert.equal(back.noDuration, true);
    assert.equal(back.locked, true);
  }

  console.log('--- 14. CLEARING A REPEAT TAKES ITS EXCLUSIONS WITH IT ---');
  {
    // An exdate means "skip this occurrence of the series". With the series gone
    // it becomes "hide this item on that date" — so the one occurrence that
    // remains would vanish, and nothing on screen would explain why.
    const repeating = {
      id: 'ev1', content: 'Lecture', weekKey: '2026-08-24', dayIndex: 1,
      startTime: '09:00', endTime: '10:00',
      recur: { freq: 'weekly', interval: 1 },
      exdates: ['2026-09-01', '2026-09-08'],
    };
    const filled = draftFromRecord(repeating, 'events', '2026-08-25');
    assert.deepEqual(filled.recur, repeating.recur, 'The repeat is in the draft');

    const stopped = buildEventRecord({ ...filled, recur: undefined }, META, repeating) as any;
    assert.equal(stopped.recur, undefined, 'The repeat is gone');
    assert.equal(stopped.exdates, undefined, 'and so are its exclusions');

    const kept = buildEventRecord(filled, META, repeating) as any;
    assert.deepEqual(kept.exdates, repeating.exdates, 'but an unchanged repeat keeps them');
  }

  console.log('--- 15. MULTI-DAY IS AN ALL-DAY IDEA ---');
  {
    const spanning = buildEventRecord(
      draft({ allDay: true, daysSpan: 3, startMin: null, endMin: null }), META,
    ) as any;
    assert.equal(spanning.daysSpan, 3, 'An all-day item can cover days');

    const timed = buildEventRecord(draft({ allDay: false, daysSpan: 3 }), META) as any;
    assert.equal(timed.daysSpan, undefined,
      'A timed item cannot: it has an end time instead, and the two would disagree');

    const single = buildEventRecord(
      draft({ allDay: true, daysSpan: 1, startMin: null, endMin: null }), META,
    ) as any;
    assert.equal(single.daysSpan, undefined, 'One day is the absence of a span, not a span of 1');
  }

  console.log('--- 16. A CATEGORY BRINGS ITS DEFAULTS TO A NEW ITEM ---');
  {
    const sleep = {
      id: 'sleep', name: 'Sleep', color: '#6366f1',
      defaultAllDay: true, defaultNoCheckbox: true,
    };
    const meeting = { id: 'meet', name: 'Meetings', color: '#3b82f6', defaultDurationMin: 30 };
    const moment = {
      id: 'dl', name: 'Deadlines', color: '#f43f5e',
      defaultDurationMin: 0, defaultNoDuration: true,
    };

    const asSleep = applyCategoryDefaults(draft(), sleep as any);
    assert.equal(asSleep.categoryId, 'sleep');
    assert.equal(asSleep.allDay, true, 'The category makes it all-day');
    assert.equal(asSleep.noCheckbox, true, 'and hides the checkbox');

    const asMeeting = applyCategoryDefaults(
      draft({ startMin: 14 * 60, endMin: null }), meeting as any,
    );
    assert.equal(asMeeting.endMin, 14 * 60 + 30, 'A default duration sets the end');

    const asMoment = applyCategoryDefaults(draft(), moment as any);
    assert.equal(asMoment.endMin, null, 'A zero duration means a moment, not a span');
    assert.equal(asMoment.noDuration, true);

    const cleared = applyCategoryDefaults(draft({ categoryId: 'sleep' }), undefined);
    assert.equal(cleared.categoryId, undefined, 'Choosing no category clears it');
    assert.equal(cleared.allDay, false, 'and leaves everything else as the user set it');
  }

  console.log('--- 17. A TASK TAKES A REPEAT AND A REMINDER TOO ---');
  {
    const t = buildTaskRecord({
      ...draft({ title: 'Bins' }),
      recur: { freq: 'weekly', interval: 1, byWeekday: [2] },
      notify: { enabled: false, rules: [], priority: 'normal' },
    }, META) as any;
    assert.deepEqual(t.recur, { freq: 'weekly', interval: 1, byWeekday: [2] });
    assert.equal(t.notify.enabled, false, 'and "off" is a value, not an absence');

    const back = draftFromRecord(t, 'tasks', '2026-01-01');
    assert.deepEqual(back.recur, t.recur, 'reading back the same');
  }

  console.log('--- 18. A REMINDER SAYS WHAT IT WILL ACTUALLY DO ---');
  {
    // THE SIGN IS THE WHOLE TEST. `computeSchedule` fires at
    // `anchor + offsetMin`, so a NEGATIVE offset is before and a positive one is
    // after. A duplicate of this wording once had it the other way round, which
    // made a reminder set on the phone as "15 minutes before" arrive fifteen
    // minutes late: the label was reassuring and wrong, which is worse than no
    // label at all. So the description comes from the engine's own
    // `offsetLabel`, and this asserts the two agree about direction.
    assert.equal(offsetLabel(-15), '15 minutes before', 'Negative is before');
    assert.equal(offsetLabel(15), '15 minutes after', 'and positive is after');
    assert.equal(offsetLabel(0), 'At the time');

    // Every preset the phone offers for a timed item must be one the engine
    // understands, and the ones meant as "before" must be negative.
    assert.ok(OFFSET_PRESETS_TIMED.includes(0), 'At the time is offered');
    assert.ok(OFFSET_PRESETS_TIMED.some(o => o < 0), 'and some are before');
    for (const off of OFFSET_PRESETS_TIMED) {
      const label = offsetLabel(off);
      if (off < 0) assert.ok(label.endsWith('before'), `${off} reads as before`);
      if (off > 0) assert.ok(label.endsWith('after'), `${off} reads as after`);
    }

    // And the description of a whole spec uses the same wording.
    const spec = {
      enabled: true,
      rules: [{ id: 'a', offsetMin: -15 }, { id: 'b', offsetMin: 0 }],
      priority: 'normal' as const,
    };
    const described = describeNotify(spec);
    assert.ok(described.includes('before'), `"${described}" says before`);
    assert.ok(!described.includes('after'), 'and does not claim after');
  }

  console.log('\nALL PASS (draft: anchors, week start, field names, validation)');
}

main();
