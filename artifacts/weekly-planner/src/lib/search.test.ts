// Tests the planner's search.
//
// THE ONE THAT MATTERS: the order has to be TOTAL and stable. A search box that
// reshuffles its own results between two keystrokes that produce the same query
// is worse than no search at all, because you stop believing the top row is
// really the best answer. Every comparison therefore ends on an id, and the
// determinism test below runs the same input repeatedly and demands the exact
// same list back.
//
// The second thing that matters is that it stays fast. This runs on every
// keystroke over a planner with thousands of items, on a phone, so the last
// section builds a synthetic planner of several thousand items with repeats and
// asserts the whole search lands well inside a frame.
//
// Run with: npx tsx src/lib/search.test.ts

import assert from 'node:assert/strict';
import {
  BUCKET_ORDER,
  fold,
  searchPlanner,
  searchPreview,
  splitHighlight,
  tokenize,
  type SearchHit,
  type SearchInput,
} from './search';
import type { EventCategory } from './categories';
import type { TaskList } from './taskLists';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TODAY = '2026-08-31'; // a Monday

const DAY_MS = 24 * 60 * 60 * 1000;

const parse = (d: string): Date => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
};
const ymd = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const shift = (date: string, days: number): string =>
  ymd(new Date(parse(date).getTime() + days * DAY_MS));

/** The Sunday-based week start of a date, which is how records are anchored. */
const weekKeyOf = (date: string): string => {
  const d = parse(date);
  return ymd(new Date(d.getTime() - d.getDay() * DAY_MS));
};
const dayIndexOf = (date: string): number => parse(date).getDay();

/** An event, anchored on a real date rather than a hand-written weekKey. */
function ev(
  id: string,
  content: string,
  date: string | null,
  extra: Record<string, unknown> = {},
): [string, Record<string, unknown>] {
  const anchor = date === null ? {} : { weekKey: weekKeyOf(date), dayIndex: dayIndexOf(date) };
  return [id, { id, content, ...anchor, ...extra }];
}

function task(
  id: string,
  title: string,
  date: string | null,
  extra: Record<string, unknown> = {},
): [string, Record<string, unknown>] {
  const anchor = date === null ? {} : { weekKey: weekKeyOf(date), dayIndex: dayIndexOf(date) };
  return [id, { id, title, ...anchor, ...extra }];
}

const store = (
  ...entries: Array<[string, Record<string, unknown>]>
): Record<string, Record<string, unknown>> => Object.fromEntries(entries);

const CATEGORIES: EventCategory[] = [
  { id: 'uni', name: 'University Calendar', color: '#f97316' },
  { id: 'personal', name: 'Personal', color: '#22c55e' },
];

const LISTS: TaskList[] = [
  { id: 'general', name: 'General', color: '#3b82f6' },
  { id: 'shopping', name: 'Shopping', color: '#22c55e' },
];

function run(query: string, over: Partial<SearchInput> = {}) {
  return searchPlanner({
    query,
    today: TODAY,
    categories: CATEGORIES,
    taskLists: LISTS,
    ...over,
  });
}

const ids = (hits: SearchHit[]): string[] => hits.map(h => h.id);
const titles = (hits: SearchHit[]): string[] => hits.map(h => h.title);

// ─── Tests ───────────────────────────────────────────────────────────────────

function main() {
  console.log('--- 1. A QUERY THAT ASKS FOR NOTHING FINDS NOTHING ---');
  {
    const events = store(
      ev('a', 'Physics exam', TODAY),
      ev('b', 'Anything at all', TODAY),
    );

    for (const query of ['', '   ', '\t\n', '...', '!!!', '---', '؟؟', '·  ·', '“”', '،،']) {
      const r = run(query, { events });
      assert.equal(r.hits.length, 0, `"${query}" returns nothing`);
      assert.equal(r.counts.total, 0);
      assert.deepEqual(r.groups, [], `"${query}" has no groups either`);
      assert.deepEqual(r.terms, [], `"${query}" reduces to no terms`);
      assert.equal(r.truncated, false);
    }

    // And an empty planner is not an error, whatever is asked of it.
    const nothing = run('exam', { events: {}, tasks: {} });
    assert.equal(nothing.hits.length, 0);
    const missing = run('exam', { events: undefined, tasks: null });
    assert.equal(missing.hits.length, 0, 'a store that has not loaded yet is not a crash');

    // Punctuation glued to a real word is still a real word.
    assert.deepEqual(tokenize('exam!'), ['exam']);
    assert.deepEqual(tokenize('  physics,  exam  '), ['physics', 'exam']);
    assert.deepEqual(tokenize('...'), []);
  }

  console.log('--- 2. CASE, ACCENTS AND ARABIC ALL FOLD ---');
  {
    const events = store(
      ev('a', 'Physics EXAM', TODAY),
      ev('b', 'Café résumé', TODAY),
      ev('c', 'صَلاة الفجر', TODAY),
      ev('d', 'اجتماع الجامعة', shift(TODAY, 2)),
      ev('e', 'Español', TODAY),
    );

    for (const q of ['exam', 'EXAM', 'ExAm', 'physics exam']) {
      assert.deepEqual(ids(run(q, { events }).hits), ['a'], `"${q}" finds the exam`);
    }

    for (const q of ['cafe', 'CAFÉ', 'resume', 'résumé', 'cafe resume']) {
      assert.deepEqual(ids(run(q, { events }).hits), ['b'], `"${q}" finds the café`);
    }
    assert.deepEqual(ids(run('espanol', { events }).hits), ['e'], 'ñ folds to n');

    // Arabic: harakat on the stored text, none in the query.
    assert.deepEqual(ids(run('صلاة', { events }).hits), ['c'], 'the harakat are ignored');
    assert.deepEqual(ids(run('صلاه', { events }).hits), ['c'], 'and so is ة versus ه');
    assert.deepEqual(ids(run('الفجر', { events }).hits), ['c']);
    // Alef forms unify, so a query typed without the hamza still lands.
    assert.deepEqual(ids(run('اجتماع', { events }).hits), ['d']);
    assert.deepEqual(ids(run('الجامعه', { events }).hits), ['d'], 'ta marbuta again');

    // Tatweel, which people type to stretch a word, is not a letter.
    const stretched = store(ev('t', 'مـــرحبا', TODAY));
    assert.deepEqual(ids(run('مرحبا', { events: stretched }).hits), ['t']);

    // Arabic-Indic digits are the same numbers.
    const numbered = store(ev('n', 'محاضرة ٣٠١', TODAY));
    assert.deepEqual(ids(run('301', { events: numbered }).hits), ['n']);

    // Folding never loses its grip on where a character came from.
    const folded = fold('Café');
    assert.equal(folded.text, 'cafe');
    assert.equal(folded.map.length, folded.text.length, 'one origin per folded character');
    assert.equal(folded.map[3], 3, 'the e still points at the é');
  }

  console.log('--- 3. WHAT BEATS WHAT ---');
  {
    // A title match outranks a note match even when the note is nearer in time.
    const events = store(
      ev('title-far', 'Chemistry', shift(TODAY, 300)),
      ev('note-today', 'Something else', TODAY, { notes: 'bring the chemistry book' }),
    );
    assert.deepEqual(ids(run('chemistry', { events }).hits), ['title-far', 'note-today'],
      'a title a year away still beats a note today');

    // A whole word beats a fragment inside a longer word.
    const words = store(
      ev('whole', 'Art class', TODAY),
      ev('fragment', 'Cartography', TODAY),
    );
    const w = run('art', { events: words });
    assert.deepEqual(ids(w.hits), ['whole', 'fragment']);
    assert.ok(w.hits[0].score > w.hits[1].score, 'and by a real margin, not a tiebreak');

    // The start of a word beats the middle of one.
    const starts = store(
      ev('prefix', 'Exam preparation', TODAY),
      ev('infix', 'Preexam nerves', TODAY),
    );
    assert.deepEqual(ids(run('exam', { events: starts }).hits), ['prefix', 'infix']);

    // Between two equal matches, the nearer one wins, and the future beats the
    // past at the same distance.
    const dates = store(
      ev('soon', 'Dentist', shift(TODAY, 2)),
      ev('far', 'Dentist', shift(TODAY, 300)),
      ev('past', 'Dentist', shift(TODAY, -2)),
    );
    const d = run('dentist', { events: dates });
    assert.deepEqual(ids(d.hits), ['soon', 'past', 'far'],
      'soonest first, then the recent past, then next year');

    // Two words narrow, they do not widen: an item with only one of them is out.
    const both = store(
      ev('both', 'Physics exam', TODAY),
      ev('one', 'Physics lab', TODAY),
    );
    assert.deepEqual(ids(run('physics exam', { events: both }).hits), ['both'],
      'every term has to match something');

    // But the terms may land in different fields.
    const split = store(
      ev('split', 'Exam', TODAY, { categoryId: 'uni', notes: 'room 204' }),
    );
    assert.equal(run('exam university', { events: split }).hits.length, 1,
      'one term in the title, one in the category name');
    assert.equal(run('exam 204', { events: split }).hits.length, 1,
      'one in the title, one in the notes');
  }

  console.log('--- 4. THE MATCH IS ACTUALLY POINTED AT ---');
  {
    const events = store(
      ev('a', 'Physics exam and maths exam', TODAY),
      ev('b', 'Café meeting', TODAY, { notes: 'The café on the corner, upstairs, by the window' }),
    );

    const a = run('exam', { events }).hits[0];
    assert.equal(a.titleRanges.length, 2, 'both occurrences are marked, not just the first');
    for (const r of a.titleRanges) {
      assert.equal(a.title.slice(r.start, r.end).toLowerCase(), 'exam',
        'and each range really covers the word');
    }

    // Folding shifts nothing: the range still lands on the accented original.
    const b = run('cafe', { events }).hits[0];
    assert.equal(b.title.slice(b.titleRanges[0].start, b.titleRanges[0].end), 'Café');

    // The note is cut down to a snippet, with the match still marked inside it.
    assert.ok(b.snippet && b.snippet.length < (b.notes ?? '').length + 4);
    assert.ok(b.snippetRanges.length >= 1, 'the snippet knows where its match is');
    const s = b.snippetRanges[0];
    assert.equal(b.snippet!.slice(s.start, s.end).toLowerCase(), 'café'.toLowerCase());

    // splitHighlight reassembles the original text exactly, always.
    const parts = splitHighlight(a.title, a.titleRanges);
    assert.equal(parts.map(p => p.text).join(''), a.title, 'nothing is lost or duplicated');
    assert.equal(parts.filter(p => p.hit).length, 2);

    // Degenerate ranges must not corrupt the text.
    assert.equal(splitHighlight('abc', []).map(p => p.text).join(''), 'abc');
    assert.equal(splitHighlight('', []).length, 0);
    assert.equal(
      splitHighlight('abc', [{ start: 0, end: 2 }, { start: 1, end: 3 }]).map(p => p.text).join(''),
      'abc', 'overlapping ranges merge rather than double-print');
    assert.equal(
      splitHighlight('abc', [{ start: 5, end: 9 }]).map(p => p.text).join(''),
      'abc', 'a range past the end is ignored');
  }

  console.log('--- 5. WHAT MUST NEVER APPEAR ---');
  {
    const events = store(
      ev('live', 'Exam', TODAY),
      ev('gone', 'Exam', TODAY, { deleted: true }),
      ['leaked::2026-08-31', { id: 'leaked::2026-08-31', content: 'Exam', weekKey: weekKeyOf(TODAY), dayIndex: 1 }],
    );
    // A junk record in the middle must not stop the scan.
    (events as Record<string, unknown>).junk = null;
    (events as Record<string, unknown>).junk2 = 'not an object' as unknown;

    const r = run('exam', { events });
    assert.deepEqual(ids(r.hits), ['live'],
      'a deleted item, a leaked occurrence record and two pieces of junk are all skipped');
  }

  console.log('--- 6. COMPLETION ---');
  {
    // An EVENT records completion per date whether it repeats or not; a one-off
    // TASK uses a plain boolean. Reading either one wrongly hides a finished
    // item among the outstanding ones.
    const events = store(
      ev('done-ev', 'Exam one', TODAY, { completedDates: [TODAY] }),
      ev('open-ev', 'Exam two', TODAY),
    );
    const tasks = store(
      task('done-task', 'Exam three', TODAY, { completed: true }),
      task('open-task', 'Exam four', TODAY),
    );

    const all = run('exam', { events, tasks });
    assert.equal(all.counts.total, 4);
    assert.equal(all.counts.done, 2, 'both kinds of completion are recognised');
    assert.equal(all.counts.open, 2);

    // A finished item is findable but never above an outstanding one it ties with.
    const doneHits = all.hits.filter(h => h.completed);
    const openHits = all.hits.filter(h => !h.completed);
    for (const d of doneHits) {
      for (const o of openHits) assert.ok(o.score > d.score, 'open outranks done');
    }
    for (const d of doneHits) assert.equal(d.bucket, 'done', 'and is grouped apart');

    assert.deepEqual(ids(run('exam', { events, tasks, done: 'open' }).hits).sort(),
      ['open-ev', 'open-task']);
    assert.deepEqual(ids(run('exam', { events, tasks, done: 'done' }).hits).sort(),
      ['done-ev', 'done-task']);

    // An event with a `completed` flag is NOT done: that flag is what the phone
    // used to write and the PC never read.
    const flagged = store(ev('flag', 'Exam five', TODAY, { completed: true }));
    assert.equal(run('exam', { events: flagged }).hits[0].completed, false);
  }

  console.log('--- 7. TASKS WITH NO DATE AT ALL ---');
  {
    const tasks = store(
      task('undated', 'Buy milk', null),
      task('dated', 'Buy bread', shift(TODAY, 1)),
      task('undated-done', 'Buy cheese', null, { completed: true }),
    );

    const r = run('buy', { tasks });
    assert.equal(r.counts.total, 3, 'an undated task is still findable');
    const u = r.hits.find(h => h.id === 'undated')!;
    assert.equal(u.date, null);
    assert.equal(u.bucket, 'undated');
    assert.equal(u.startMin, null, 'a task with no date can have no time either');

    // A time filter is a statement about dates, so it excludes what has none.
    const ranged = run('buy', { tasks, from: TODAY, to: shift(TODAY, 7) });
    assert.deepEqual(ids(ranged.hits), ['dated'],
      'an explicit range leaves the undated ones out rather than pinning them on top');

    // Which is not the same as them being unreachable: with no range they return.
    assert.equal(run('milk', { tasks }).hits.length, 1);
  }

  console.log('--- 8. REPEATS ARE BOUNDED, NOT FLATTENED ---');
  {
    const anchor = shift(TODAY, -400);
    const daily = store(ev('daily', 'Standup', anchor, {
      startTime: '09:00', endTime: '09:15',
      recur: { freq: 'daily', interval: 1 },
    }));

    const r = run('standup', { events: daily });
    assert.ok(r.hits.length <= 4, 'a never-ending daily repeat cannot flood the screen');
    assert.equal(r.matchedItems, 1, 'and it is still one stored item');

    // The occurrence that matters is there: today, or the next one.
    assert.ok(r.hits.some(h => h.date === TODAY), 'the next occurrence is shown');
    for (const h of r.hits) {
      assert.equal(h.repeating, true);
      assert.equal(h.masterId, 'daily');
      assert.equal(h.id, `daily::${h.date}`, 'occurrence ids are master::date');
      assert.ok(h.seriesCount > r.hits.length, 'and the row knows how many it stands for');
    }

    // At most one of them is in the past, so history never buries the future.
    assert.equal(r.hits.filter(h => h.date! < TODAY).length, 1,
      'exactly one backward glance');

    // maxPerSeries is honoured.
    const one = run('standup', { events: daily, maxPerSeries: 1 });
    assert.equal(one.hits.length, 1, 'a budget of one row is spent on the next one');
    assert.ok(one.hits[0].date! >= TODAY, 'forwards, never backwards');

    // A weekly repeat lands on its own weekday and nowhere else.
    const weekly = store(ev('weekly', 'Lecture', shift(TODAY, -14), {
      recur: { freq: 'weekly', interval: 1 },
    }));
    const wk = run('lecture', { events: weekly });
    const weekdays = new Set(wk.hits.map(h => parse(h.date!).getDay()));
    assert.equal(weekdays.size, 1, 'every occurrence is on the same weekday');

    // A series that ENDED still surfaces its last occurrence rather than vanishing.
    const finished = store(ev('over', 'Old habit', shift(TODAY, -60), {
      recur: { freq: 'daily', interval: 1, end: { until: shift(TODAY, -50) } },
    }));
    const done = run('habit', { events: finished });
    assert.equal(done.hits.length, 1, 'one row for a finished series');
    assert.equal(done.hits[0].date, shift(TODAY, -50), 'and it is the last one that happened');

    // A series entirely outside the window contributes nothing, which is the
    // whole point of having a window.
    const ancient = store(ev('ancient', 'Ancient ritual', shift(TODAY, -2000), {
      recur: { freq: 'daily', interval: 1, end: { until: shift(TODAY, -1900) } },
    }));
    assert.equal(run('ritual', { events: ancient }).hits.length, 0,
      'nothing from four years ago');
    // Unless you ask for it.
    assert.ok(run('ritual', { events: ancient, seriesPastDays: 2500 }).hits.length > 0,
      'a wider window reaches it');

    // The expanded dates are cached against the record, so the cache has to be
    // keyed on the day as well: the same planner asked on a different date must
    // give a different answer, or the app would show yesterday's "next one"
    // until it was restarted.
    const rolling = store(ev('roll', 'Daily habit', shift(TODAY, -10), {
      recur: { freq: 'daily', interval: 1 },
    }));
    const onMonday = searchPlanner({ query: 'habit', events: rolling, today: TODAY });
    const onFriday = searchPlanner({ query: 'habit', events: rolling, today: shift(TODAY, 4) });
    assert.ok(onMonday.hits.some(h => h.date === TODAY));
    assert.ok(onFriday.hits.some(h => h.date === shift(TODAY, 4)));
    assert.ok(!onFriday.hits.some(h => h.date === TODAY),
      'Monday is neither today nor the most recent past occurrence any more');
    // And back again, which is what proves the second answer did not evict the
    // first into something wrong.
    assert.deepEqual(
      ids(searchPlanner({ query: 'habit', events: rolling, today: TODAY }).hits),
      ids(onMonday.hits));

    // A one-off is never windowed: an appointment years out is exactly what this
    // screen exists to find.
    const distant = store(ev('distant', 'Passport renewal', shift(TODAY, 900)));
    assert.deepEqual(ids(run('passport', { events: distant }).hits), ['distant']);

    // Matching once versus matching every occurrence: a repeat and a one-off with
    // the same word both appear, and the repeat does not outnumber it out of view.
    const mixed = store(
      ev('rep', 'Gym session', shift(TODAY, -30), { recur: { freq: 'daily', interval: 1 } }),
      ev('once', 'Gym induction', shift(TODAY, 3)),
    );
    const m = run('gym', { events: mixed });
    assert.ok(m.hits.some(h => h.masterId === 'once'), 'the one-off is not drowned out');
    assert.equal(m.matchedItems, 2);
  }

  console.log('--- 9. CATEGORIES AND LISTS ---');
  {
    const events = store(
      ev('uni-1', 'Lecture', TODAY, { categoryId: 'uni' }),
      ev('uni-2', 'Seminar', shift(TODAY, 1), { categoryId: 'uni' }),
      ev('home', 'Dinner', TODAY, { categoryId: 'personal' }),
    );
    const tasks = store(
      task('shop', 'Milk', TODAY, { listId: 'shopping' }),
      task('plain', 'Email', TODAY),
    );

    // A category name matched by nothing in any title.
    const uni = run('university', { events, tasks });
    assert.deepEqual(ids(uni.hits).sort(), ['uni-1', 'uni-2'],
      'the category name finds its items');
    for (const h of uni.hits) assert.equal(h.field, 'category');
    assert.equal(uni.hits[0].categoryName, 'University Calendar');

    // A list name does the same for tasks.
    assert.deepEqual(ids(run('shopping', { events, tasks }).hits), ['shop']);

    // And the filters, which are a different mechanism from the text.
    assert.deepEqual(ids(run('e', { events, categoryId: 'personal' }).hits), ['home']);
    assert.deepEqual(ids(run('milk', { tasks, listId: 'shopping' }).hits), ['shop']);
    assert.equal(run('milk', { tasks, listId: 'general' }).hits.length, 0);
    // A task with no list belongs to General rather than to nowhere.
    assert.deepEqual(ids(run('email', { tasks, listId: 'general' }).hits), ['plain']);

    // Scope.
    assert.equal(run('e', { events, tasks, scope: 'events' }).counts.tasks, 0);
    assert.equal(run('e', { events, tasks, scope: 'tasks' }).counts.events, 0);
    const both = run('e', { events, tasks, scope: 'all' });
    assert.ok(both.counts.events > 0 && both.counts.tasks > 0);

    // A category the planner does not have simply matches nothing.
    assert.equal(run('lecture', { events, categoryId: 'nope' }).hits.length, 0);
  }

  console.log('--- 10. GROUPING AND COUNTS ---');
  {
    const events = store(
      ev('overdue', 'Report draft', shift(TODAY, -3)),
      ev('today', 'Report review', TODAY),
      ev('week', 'Report sign off', shift(TODAY, 4)),
      ev('later', 'Report archive', shift(TODAY, 60)),
      ev('past', 'Report kickoff', shift(TODAY, -200)),
      ev('done', 'Report notes', shift(TODAY, 1), { completedDates: [shift(TODAY, 1)] }),
    );
    const tasks = store(task('undated', 'Report ideas', null));

    const r = run('report', { events, tasks });
    assert.equal(r.counts.total, 7);
    assert.equal(r.counts.events, 6);
    assert.equal(r.counts.tasks, 1);
    assert.equal(r.counts.done, 1);
    assert.equal(r.counts.open, 6);

    const seen = r.groups.map(g => g.key);
    assert.deepEqual(seen, BUCKET_ORDER.filter(b => seen.includes(b)),
      'groups come out in the fixed order, never in whichever order they were found');
    assert.deepEqual(seen, ['overdue', 'today', 'week', 'later', 'undated', 'past', 'done']);
    for (const g of r.groups) {
      assert.ok(g.hits.length > 0, 'no empty section is ever emitted');
      assert.ok(g.label.length > 0);
      for (const h of g.hits) assert.equal(h.bucket, g.key);
    }
    // Every hit is in exactly one group, and the groups add up to the list.
    assert.equal(r.groups.reduce((n, g) => n + g.hits.length, 0), r.hits.length);

    // The limit cuts the list but never the truth.
    const cut = run('report', { events, tasks, limit: 2 });
    assert.equal(cut.hits.length, 2);
    assert.equal(cut.truncated, true);
    assert.equal(cut.counts.total, 7, 'the count still reports everything found');
    assert.equal(run('report', { events, tasks, limit: 999 }).truncated, false);
  }

  console.log('--- 11. THE ORDER IS TOTAL, AND THE SAME EVERY TIME ---');
  {
    // Two items with identical titles on the identical day. Nothing about them
    // differs except their ids, which is exactly the case where an unstable sort
    // shows itself.
    const events = store(
      ev('zzz', 'Meeting', TODAY),
      ev('aaa', 'Meeting', TODAY),
      ev('mmm', 'Meeting', TODAY),
    );
    const first = ids(run('meeting', { events }).hits);
    assert.deepEqual(first, ['aaa', 'mmm', 'zzz'], 'identical rows order by id');

    for (let i = 0; i < 20; i += 1) {
      assert.deepEqual(ids(run('meeting', { events }).hits), first,
        'and the same input gives the same order every single time');
    }

    // Insertion order of the store must not leak into the results.
    const reversed = store(
      ev('mmm', 'Meeting', TODAY),
      ev('aaa', 'Meeting', TODAY),
      ev('zzz', 'Meeting', TODAY),
    );
    assert.deepEqual(ids(run('meeting', { events: reversed }).hits), first);

    // No two distinct rows may ever compare equal, over a deliberately nasty
    // mixture: same title, same day, same time, repeats, tasks and events.
    const nasty = store(
      ev('e1', 'Thing', TODAY, { startTime: '09:00' }),
      ev('e2', 'Thing', TODAY, { startTime: '09:00' }),
      ev('e3', 'Thing', TODAY, { allDay: true }),
      ev('e4', 'Thing', shift(TODAY, -1), { recur: { freq: 'daily', interval: 1 } }),
      ev('e5', 'Thing', shift(TODAY, 1)),
    );
    const nastyTasks = store(
      task('t1', 'Thing', TODAY),
      task('t2', 'Thing', null),
      task('t3', 'Thing', null),
    );
    const big = run('thing', { events: nasty, tasks: nastyTasks });
    const order = ids(big.hits);
    assert.equal(new Set(order).size, order.length, 'every row is distinct');
    for (let i = 0; i < 10; i += 1) {
      assert.deepEqual(ids(run('thing', { events: nasty, tasks: nastyTasks }).hits), order);
    }
    // Scores never increase down the list.
    for (let i = 1; i < big.hits.length; i += 1) {
      assert.ok(big.hits[i - 1].score >= big.hits[i].score, 'sorted by score, descending');
    }
  }

  console.log('--- 12. QUERIES NOBODY MEANT TO TYPE ---');
  {
    const events = store(
      ev('a', 'Exam', TODAY),
      ev('b', 'Extra', TODAY),
      ev('c', 'X', TODAY),
    );

    // One character. Useful, not refused: it is what the user has typed so far.
    const one = run('e', { events });
    assert.deepEqual(ids(one.hits).sort(), ['a', 'b'], 'a single letter still searches');
    // 'x' is inside "Exam" and "Extra" too, so all three come back, but the
    // item that IS an x is unambiguously first.
    const x = run('x', { events });
    assert.equal(x.hits[0].id, 'c', 'an exact one-character title scores highest');
    assert.equal(x.hits.length, 3, 'and the fragments are still findable underneath it');

    // Longer than anything in the planner.
    const long = 'a'.repeat(500);
    assert.equal(run(long, { events }).hits.length, 0);
    assert.equal(run(`${long} ${long}`, { events }).hits.length, 0);

    // A query made entirely of things that fold away.
    assert.equal(run('ًٌٍَُِّْ', { events }).hits.length, 0,
      'a string of nothing but harakat asks for nothing');

    // Leading and trailing noise does not change the answer.
    assert.deepEqual(ids(run('  ...exam!!!  ', { events }).hits), ['a']);

    // An item with no title at all is labelled, not blank, and is still findable.
    const untitled = store(['u', { id: 'u', weekKey: weekKeyOf(TODAY), dayIndex: dayIndexOf(TODAY) }]);
    assert.deepEqual(titles(run('untitled', { events: untitled }).hits), ['Untitled']);

    // A record whose fields are the wrong types must not throw.
    const wrong = store(['w', {
      id: 'w', content: 42, title: null, notes: {}, weekKey: 12,
      startTime: 'nonsense', completedDates: 'not an array',
    } as unknown as Record<string, unknown>]);
    assert.doesNotThrow(() => run('exam', { events: wrong }));
    assert.equal(run('untitled', { events: wrong }).hits.length, 1,
      'a record with no usable date is treated as undated rather than dropped');
  }

  console.log('--- 13. SOMETHING TO SHOW BEFORE ANYTHING IS TYPED ---');
  {
    const events = store(
      ev('soon', 'Dentist', shift(TODAY, 1), { categoryId: 'personal', updatedAt: 100 }),
      ev('today', 'Lecture', TODAY, { categoryId: 'uni', updatedAt: 300 }),
      ev('far', 'Conference', shift(TODAY, 200), { categoryId: 'uni', updatedAt: 200 }),
      ev('gone', 'Deleted thing', TODAY, { deleted: true, updatedAt: 999 }),
      ev('past', 'Yesterday thing', shift(TODAY, -1), { updatedAt: 50 }),
      ev('finished', 'Ticked off', TODAY, { completedDates: [TODAY], updatedAt: 10 }),
    );
    const tasks = store(task('anytime', 'Someday idea', null, { updatedAt: 400 }));

    const p = searchPreview({ events, tasks, today: TODAY, categories: CATEGORIES, taskLists: LISTS });

    assert.deepEqual(titles(p.upcoming), ['Lecture', 'Dentist'],
      'what is coming, soonest first, and nothing already done or already past');
    assert.ok(!p.upcoming.some(h => h.title === 'Conference'), 'and nothing beyond the horizon');

    assert.equal(p.recent[0].title, 'Someday idea', 'most recently touched first');
    assert.ok(!p.recent.some(h => h.masterId === 'gone'), 'a deleted item is not "recent"');

    assert.deepEqual(p.activeCategoryIds, ['uni', 'personal'],
      'the categories worth offering as a filter, most used first');

    // Preview rows are the same shape as result rows, so one component draws both.
    for (const hit of [...p.upcoming, ...p.recent]) {
      assert.equal(typeof hit.id, 'string');
      assert.deepEqual(hit.titleRanges, [], 'with nothing highlighted, since nothing was typed');
      assert.ok(BUCKET_ORDER.includes(hit.bucket));
    }

    // An empty planner previews as empty rather than throwing.
    const none = searchPreview({ today: TODAY });
    assert.deepEqual(none.upcoming, []);
    assert.deepEqual(none.recent, []);
    assert.deepEqual(none.activeCategoryIds, []);
  }

  console.log('--- 14. FAST ENOUGH TO RUN ON EVERY KEYSTROKE ---');
  {
    // A planner far larger than the real one: four thousand items, a quarter of
    // them repeating, half of them carrying a paragraph of notes.
    const N = 4000;
    const words = ['physics', 'chemistry', 'lecture', 'seminar', 'dentist', 'gym',
      'shopping', 'اجتماع', 'محاضرة', 'report', 'review', 'standup'];
    const bigEvents: Record<string, Record<string, unknown>> = {};
    const bigTasks: Record<string, Record<string, unknown>> = {};

    for (let i = 0; i < N; i += 1) {
      const word = words[i % words.length];
      const date = shift(TODAY, (i % 700) - 200);
      const notes = i % 2 === 0
        ? `Context line ${i}. ${words[(i + 3) % words.length]} details, room ${i % 400}, with a longer paragraph of text so the folding has real work to do.`
        : undefined;
      const repeat = i % 4 === 0
        ? { recur: { freq: (i % 8 === 0 ? 'daily' : 'weekly') as 'daily' | 'weekly', interval: 1 } }
        : {};
      const extra: Record<string, unknown> = {
        startTime: '09:00', endTime: '10:00',
        categoryId: i % 3 === 0 ? 'uni' : 'personal',
        updatedAt: i,
        ...repeat,
      };
      if (notes) extra.notes = notes;

      if (i % 5 === 0) {
        const [id, rec] = task(`t${i}`, `${word} task ${i}`, i % 25 === 0 ? null : date, extra);
        bigTasks[id] = rec;
      } else {
        const [id, rec] = ev(`e${i}`, `${word} item ${i}`, date, extra);
        bigEvents[id] = rec;
      }
    }

    const queries = ['p', 'ph', 'phy', 'phys', 'physi', 'physic', 'physics', 'physics lecture',
      'محاضرة', 'report review', 'room 204', 'zzzzzz'];

    // Cold: nothing is folded yet, so this includes the whole planner's text.
    const coldStart = Date.now();
    const cold = searchPlanner({
      query: 'physics', events: bigEvents, tasks: bigTasks, today: TODAY,
      categories: CATEGORIES, taskLists: LISTS,
    });
    const coldMs = Date.now() - coldStart;
    assert.ok(cold.counts.total > 0, 'the synthetic planner really does match');

    // Warm: what every keystroke after the first actually costs.
    let worst = 0;
    let totalMs = 0;
    let runs = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      for (const q of queries) {
        const t0 = Date.now();
        searchPlanner({
          query: q, events: bigEvents, tasks: bigTasks, today: TODAY,
          categories: CATEGORIES, taskLists: LISTS,
        });
        const ms = Date.now() - t0;
        totalMs += ms;
        runs += 1;
        if (ms > worst) worst = ms;
      }
    }
    const avgMs = totalMs / runs;

    console.log(`      ${N} items, ${Object.keys(bigEvents).length} events + ${Object.keys(bigTasks).length} tasks`);
    console.log(`      cold (nothing cached): ${coldMs}ms`);
    console.log(`      warm: avg ${avgMs.toFixed(2)}ms over ${runs} queries, worst ${worst}ms`);

    // A frame is 16.7ms. The budget below is deliberately generous compared with
    // the numbers this actually prints, because the test has to keep passing on
    // a loaded CI box as well as on the machine it was written on.
    assert.ok(coldMs < 400, `cold search was ${coldMs}ms, which is too slow to type into`);
    assert.ok(avgMs < 16, `average keystroke cost ${avgMs.toFixed(2)}ms, over a frame`);
    assert.ok(worst < 60, `worst keystroke cost ${worst}ms`);

    // And the guard that makes it fast in the first place: a query that matches
    // nothing expands no recurrence at all.
    const nothing = searchPlanner({
      query: 'zzzzzz', events: bigEvents, tasks: bigTasks, today: TODAY,
    });
    assert.equal(nothing.matchedItems, 0, 'no item matched, so nothing was expanded');
    assert.equal(nothing.hits.length, 0);

    // A single letter is the widest query there is, and it is still bounded.
    const wide = searchPlanner({
      query: 'e', events: bigEvents, tasks: bigTasks, today: TODAY, limit: 100,
    });
    assert.equal(wide.hits.length, 100);
    assert.equal(wide.truncated, true);
    assert.ok(wide.matchedItems > 1000, 'and it still says how much it really found');

    // The work-saving cut has to be deterministic too. If the tail that gets
    // left undated were chosen differently each time, the widest queries would
    // be the ones that reshuffle, which is precisely where a user is most likely
    // to be watching the list settle.
    const again = searchPlanner({
      query: 'e', events: bigEvents, tasks: bigTasks, today: TODAY, limit: 100,
    });
    assert.deepEqual(ids(again.hits), ids(wide.hits));
    assert.equal(again.matchedItems, wide.matchedItems);
  }

  console.log('\nALL PASS (search: folding, ranking, repeats, grouping, total order, speed)');
}

main();
