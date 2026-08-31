// Tests the task board: which section a task lands in, and in what order.
//
// THE ONES THAT MATTER
//  • The comparator must be a TOTAL order. A comparator that returns 0 for two
//    different rows lets the sort put them in either order, so the list redraws
//    in a different order after an unrelated edit and looks like it rearranged
//    itself. That is not a crash, which is exactly why nobody would find it.
//  • A subtask must never be lost. If a parent is filtered out, hidden by a list
//    or simply absent, its children must still be reachable rather than silently
//    dropped from every section.
//  • The phone and the PC must agree. Filtering goes through `matchesFilters`
//    from tasks.ts rather than a second copy, and this file asserts the two
//    still say the same thing.
//
// Run with: npx tsx src/lib/taskBoard.test.ts

import assert from 'node:assert/strict';
import {
  buildTaskRows,
  groupTasks,
  type Node,
  type Row,
  type SectionKey,
  type SortMode,
} from './taskBoard';
import { matchesFilters, type Task, type TaskData, type TaskFilter } from './tasks';
import { GENERAL_LIST_ID, type TaskList } from './taskLists';

const TODAY = '2026-08-31';

const day = (n: number, from = TODAY): string => {
  const d = new Date(`${from}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A task due on `date`, expressed the way the store actually holds one. */
function task(id: string, date: string | null, extra: Partial<Task> = {}): Task {
  const base: any = { id, title: id, ...extra };
  if (date !== null) {
    // weekKey is the Sunday of the week; dayIndex the offset into it.
    const d = new Date(`${date}T00:00:00`);
    const sunday = new Date(d);
    sunday.setDate(sunday.getDate() - sunday.getDay());
    base.weekKey = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    base.dayIndex = d.getDay();
  }
  return base as Task;
}

const store = (...items: Task[]): TaskData => {
  const out: TaskData = {} as TaskData;
  for (const t of items) (out as any)[t.id] = t;
  return out;
};

const LISTS: TaskList[] = [
  { id: GENERAL_LIST_ID, name: 'General', color: '#888888' },
  { id: 'work', name: 'Work', color: '#3b82f6' },
];

const SECTIONS: SectionKey[] = ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'General', 'Done'];

const group = (
  tasks: TaskData,
  opts: {
    activeListId?: string | null;
    filters?: TaskFilter[];
    sort?: SortMode;
    today?: string;
  } = {},
) => {
  const today = opts.today ?? TODAY;
  const rows = buildTaskRows(tasks, today);
  return groupTasks(
    rows, tasks, LISTS,
    opts.activeListId ?? null,
    opts.filters ?? [],
    today,
    opts.sort ?? 'datetime',
  );
};

/** Every row on the board, in the order the sections are drawn. */
const flatten = (out: Record<SectionKey, Node[]>): string[] =>
  SECTIONS.flatMap(k => out[k].map(n => n.row.occId));

/** Shuffle deterministically, so a failure can be reproduced. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function main() {
  console.log('--- 1. EVERY TASK LANDS IN EXACTLY ONE SECTION ---');
  {
    const tasks = store(
      task('overdue', day(-3)),
      task('today', TODAY),
      task('tomorrow', day(1)),
      task('soon', day(5)),
      task('undated', null),
      task('finished', day(-1), { completed: true, completedAt: 1 }),
    );
    const out = group(tasks);

    assert.deepEqual(out.Overdue.map(n => n.row.occId), ['overdue']);
    assert.deepEqual(out.Today.map(n => n.row.occId), ['today']);
    assert.deepEqual(out.Tomorrow.map(n => n.row.occId), ['tomorrow']);
    assert.deepEqual(out.Upcoming.map(n => n.row.occId), ['soon']);
    assert.deepEqual(out.General.map(n => n.row.occId), ['undated']);
    assert.deepEqual(out.Done.map(n => n.row.occId), ['finished']);

    // No task is in two places, and none has gone missing.
    const all = flatten(out);
    assert.equal(new Set(all).size, all.length, 'nothing appears twice');
    assert.equal(all.length, 6, 'nothing was dropped');
  }

  console.log('--- 2. A DELETED TASK IS GONE, EVERYWHERE ---');
  {
    const tasks = store(
      task('gone', TODAY, { deleted: true }),
      task('goneUndated', null, { deleted: true }),
      task('kept', TODAY),
    );
    assert.deepEqual(flatten(group(tasks)), ['kept']);

    // Even when it is the parent of something still alive: the child must not
    // vanish with it, or a subtask becomes unreachable and unfixable.
    const orphaned = store(
      task('deadParent', TODAY, { deleted: true }),
      task('child', TODAY, { parentId: 'deadParent' }),
    );
    assert.ok(flatten(group(orphaned)).includes('child'),
      'a child outlives its deleted parent');
  }

  console.log('--- 3. AN EMPTY BOARD IS AN EMPTY BOARD, NOT A CRASH ---');
  {
    for (const tasks of [store(), {} as TaskData]) {
      const out = group(tasks);
      for (const key of SECTIONS) assert.deepEqual(out[key], [], `${key} is empty`);
    }
    // And with no lists configured at all.
    const rows = buildTaskRows(store(task('a', TODAY)), TODAY);
    const out = groupTasks(rows, store(task('a', TODAY)), [], null, [], TODAY, 'datetime');
    assert.equal(out.Today.length, 1, 'a task survives having no lists to belong to');
  }

  console.log('--- 4. A TASK ON A LIST THAT NO LONGER EXISTS ---');
  {
    const tasks = store(
      task('orphan', TODAY, { listId: 'deleted-list' }),
      task('work', TODAY, { listId: 'work' }),
    );
    // Unfiltered, it is still shown: losing a list must never lose the tasks.
    assert.ok(flatten(group(tasks)).includes('orphan'));
    // And it falls back to General rather than disappearing when a list is open.
    assert.deepEqual(flatten(group(tasks, { activeListId: GENERAL_LIST_ID })), ['orphan']);
    assert.deepEqual(flatten(group(tasks, { activeListId: 'work' })), ['work']);
  }

  console.log('--- 5. SUBTASKS SIT UNDER THEIR PARENT, ONE LEVEL DEEP ---');
  {
    const tasks = store(
      task('parent', TODAY),
      task('kid1', TODAY, { parentId: 'parent', order: 2 }),
      task('kid2', TODAY, { parentId: 'parent', order: 1 }),
    );
    const out = group(tasks);
    assert.deepEqual(out.Today.map(n => n.row.occId), ['parent'],
      'only the parent is a row of its own');
    assert.deepEqual(out.Today[0].children.map(c => c.occId), ['kid2', 'kid1'],
      'children follow their manual order');

    // A grandchild is NOT nested twice. The model is one level; a deeper chain
    // must degrade to a root rather than silently vanish.
    const deep = store(
      task('p', TODAY),
      task('c', TODAY, { parentId: 'p' }),
      task('g', TODAY, { parentId: 'c' }),
    );
    const deepOut = group(deep);
    const seen = flatten(deepOut)
      .concat(deepOut.Today.flatMap(n => n.children.map(c => c.occId)));
    for (const id of ['p', 'c', 'g']) {
      assert.ok(seen.includes(id), `${id} is reachable somewhere`);
    }
  }

  console.log('--- 6. A PARENT THAT DOES NOT EXIST, AND ONE THAT IS ITSELF ---');
  {
    const missing = store(task('lonely', TODAY, { parentId: 'nobody' }));
    assert.deepEqual(flatten(group(missing)), ['lonely'],
      'a child of nothing is a root, not a hole');

    const selfRef = store(task('me', TODAY, { parentId: 'me' }));
    assert.deepEqual(flatten(group(selfRef)), ['me'], 'a task is not its own child');
  }

  console.log('--- 7. A CIRCLE OF PARENTS TERMINATES ---');
  {
    // Two tasks each claiming the other. This cannot be produced by the UI, but
    // a bad merge could write it, and it must not hang the phone.
    const two = store(
      task('a', TODAY, { parentId: 'b' }),
      task('b', TODAY, { parentId: 'a' }),
    );
    const out = group(two);
    const seen = flatten(out).concat(SECTIONS.flatMap(k => out[k].flatMap(n => n.children.map(c => c.occId))));
    for (const id of ['a', 'b']) assert.ok(seen.includes(id), `${id} survived the cycle`);

    // A three-way ring, likewise.
    const three = store(
      task('x', TODAY, { parentId: 'y' }),
      task('y', TODAY, { parentId: 'z' }),
      task('z', TODAY, { parentId: 'x' }),
    );
    const ring = group(three);
    const ringSeen = flatten(ring).concat(SECTIONS.flatMap(k => ring[k].flatMap(n => n.children.map(c => c.occId))));
    for (const id of ['x', 'y', 'z']) assert.ok(ringSeen.includes(id), `${id} survived the ring`);
  }

  console.log('--- 8. A COMPLETED PARENT WITH AN UNFINISHED CHILD ---');
  {
    const tasks = store(
      task('parent', TODAY, { completed: true, completedAt: 10 }),
      task('kid', TODAY, { parentId: 'parent' }),
    );
    const out = group(tasks);
    assert.deepEqual(out.Done.map(n => n.row.occId), ['parent']);
    // The child is still findable. Hiding an open task because its parent was
    // ticked is how a task is lost for good.
    const everywhere = flatten(out)
      .concat(SECTIONS.flatMap(k => out[k].flatMap(n => n.children.map(c => c.occId))));
    assert.ok(everywhere.includes('kid'), 'the open child is still on the board');
  }

  console.log('--- 9. A REPEAT IS ONE OPEN OCCURRENCE, NOT A YEAR OF THEM ---');
  {
    // The whole point of a repeating TASK, as against a repeating event: you owe
    // it once. Expanding it into 365 rows would bury every other task on the
    // board under one chore, so the board carries the next one still open plus
    // whatever has actually been ticked off.
    const daily = store(task('d', day(-2), { recur: { freq: 'daily', interval: 1 } as any }));
    const rows = buildTaskRows(daily, TODAY);
    assert.equal(rows.length, 1, 'exactly one open occurrence');
    assert.equal(rows[0].done, false);

    // It has an occurrence id of its own, not the master's, or ticking it would
    // tick the series for good.
    assert.notEqual(rows[0].occId, 'd', 'the row is an occurrence, not the master');
    assert.ok(rows[0].occId.startsWith('d'), 'and it names its master');

    // With a history, each ticked day is its own row and the open one is still
    // there alongside them.
    const withHistory = store(task('h', day(-3), {
      recur: { freq: 'daily', interval: 1 } as any,
      completedDates: [day(-3), day(-2), day(-1)],
    }));
    const hRows = buildTaskRows(withHistory, TODAY);
    assert.equal(new Set(hRows.map(r => r.occId)).size, hRows.length,
      'occurrence ids are distinct');
    assert.equal(hRows.filter(r => !r.done).length, 1, 'still exactly one open');
    assert.ok(hRows.filter(r => r.done).length >= 1, 'and the history is there');

    // Bounded at both ends: nothing reaches back or forward forever.
    for (const r of hRows) {
      assert.ok(r.due! >= day(-29), `does not reach back forever (${r.due})`);
      assert.ok(r.due! <= day(366), `does not reach forward forever (${r.due})`);
    }

    // Something ticked long ago drops off rather than accumulating for ever.
    const stale = store(task('s', day(-40), {
      recur: { freq: 'daily', interval: 1 } as any,
      completedDates: [day(-40), day(-30)],
    }));
    for (const r of buildTaskRows(stale, TODAY)) {
      assert.ok(!(r.done && r.due! < day(-7)), `${r.due} is too old to still be listed`);
    }
  }

  console.log('--- 10. A REPEAT TICKED ON ONE DAY IS NOT TICKED ON THE OTHERS ---');
  {
    const tasks = store(task('r', TODAY, {
      recur: { freq: 'daily', interval: 1 } as any,
      completedDates: [TODAY],
    }));
    const out = group(tasks);
    assert.equal(out.Today.length, 0, "today's occurrence is done");
    assert.equal(out.Done.length, 1, 'and it shows as done');
    assert.equal(out.Tomorrow.length, 1, "tomorrow's is untouched");
  }

  console.log('--- 11. FILTERS SAY EXACTLY WHAT tasks.ts SAYS ---');
  {
    const tasks = store(
      task('o', day(-2)),
      task('t', TODAY),
      task('u', day(4)),
      task('g', null),
      task('c', TODAY, { completed: true, completedAt: 1 }),
    );
    const every: TaskFilter[] = ['today', 'overdue', 'upcoming', 'general', 'completed'];

    // Every subset of the filters, checked against the shared predicate.
    for (let mask = 0; mask < (1 << every.length); mask += 1) {
      const filters = every.filter((_, i) => mask & (1 << i));
      const shown = new Set(flatten(group(tasks, { filters })));
      for (const t of Object.values(tasks)) {
        const due = (t as any).weekKey ? buildTaskRows(store(t), TODAY)[0]?.due ?? null : null;
        const expected = matchesFilters(t as Task, due, filters, TODAY);
        assert.equal(shown.has((t as Task).id), expected,
          `${(t as Task).id} with [${filters.join(',')}]`);
      }
    }

    // No filters means everything, which is not the same as an empty board.
    assert.equal(flatten(group(tasks, { filters: [] })).length, 5);
  }

  console.log('--- 12. THE ORDER IS TOTAL, AND THE SAME EVERY TIME ---');
  {
    // Deliberately degenerate: same title, same order, same due date, same
    // completion time. Only the id can separate them.
    const twins: Task[] = Array.from({ length: 8 }, (_, i) =>
      task(`twin${i}`, TODAY, { title: 'Same', order: 1 }));
    const done: Task[] = Array.from({ length: 4 }, (_, i) =>
      task(`done${i}`, TODAY, { title: 'Same', completed: true, completedAt: 5 }));

    const modes: SortMode[] = ['datetime', 'manual', 'title', 'title-desc'];
    for (const sort of modes) {
      const baseline = flatten(group(store(...twins, ...done), { sort }));
      for (let seed = 1; seed <= 12; seed += 1) {
        const mixed = store(...shuffled([...twins, ...done], seed));
        assert.deepEqual(flatten(group(mixed, { sort })), baseline,
          `${sort} is stable under shuffle ${seed}`);
      }
      assert.equal(new Set(baseline).size, baseline.length, `${sort} loses nothing`);
    }
  }

  console.log('--- 13. EACH SORT ACTUALLY SORTS ---');
  {
    const tasks = store(
      task('b', day(2), { title: 'Beta', order: 3 }),
      task('a', day(1), { title: 'Alpha', order: 2 }),
      task('c', day(3), { title: 'Gamma', order: 1 }),
    );
    const ids = (sort: SortMode) => group(tasks, { sort }).Upcoming
      .concat(group(tasks, { sort }).Tomorrow)
      .map(n => n.row.occId);

    const byDate = group(tasks, { sort: 'datetime' });
    assert.deepEqual(
      [...byDate.Tomorrow, ...byDate.Upcoming].map(n => n.row.occId),
      ['a', 'b', 'c'], 'by date');

    const byManual = group(tasks, { sort: 'manual' });
    assert.deepEqual(
      [...byManual.Tomorrow, ...byManual.Upcoming].map(n => n.row.occId).sort(),
      ['a', 'b', 'c'], 'manual keeps everything');
    assert.deepEqual(byManual.Upcoming.map(n => n.row.occId), ['c', 'b'],
      'manual order wins inside a section');

    const byTitle = group(tasks, { sort: 'title' });
    const byTitleDesc = group(tasks, { sort: 'title-desc' });
    assert.deepEqual(byTitle.Upcoming.map(n => n.row.occId), ['b', 'c']);
    assert.deepEqual(byTitleDesc.Upcoming.map(n => n.row.occId), ['c', 'b'],
      'descending is the reverse');
    void ids;
  }

  console.log('--- 14. A TASK WITH NOTHING IN IT ---');
  {
    const tasks = store(
      { id: 'blank', title: '' } as Task,
      { id: 'noTitle' } as any as Task,
      task('spaces', TODAY, { title: '   ' }),
    );
    const out = group(tasks);
    const all = flatten(out);
    for (const id of ['blank', 'noTitle', 'spaces']) {
      assert.ok(all.includes(id), `${id} is still shown`);
    }
    // And sorting by title does not throw on a missing one.
    assert.doesNotThrow(() => group(tasks, { sort: 'title' }));
  }

  console.log('--- 15. RUBBISH IN THE STORE IS SKIPPED, NOT FATAL ---');
  {
    const nasty: any = {
      good: task('good', TODAY),
      nullish: null,
      undef: undefined,
      str: 'not a task',
      num: 42,
      arr: [1, 2, 3],
    };
    assert.doesNotThrow(() => group(nasty as TaskData));
    assert.deepEqual(flatten(group(nasty as TaskData)), ['good']);
  }

  console.log('--- 16. DATES AT THE FAR ENDS OF PLAUSIBILITY ---');
  {
    const tasks = store(
      task('ancient', '1970-01-01'),
      task('distant', '2099-12-31'),
      task('leap', '2028-02-29'),
      task('newYearEve', '2026-12-31'),
    );
    assert.doesNotThrow(() => group(tasks));

    // THE LOOKBACK WINDOW, stated so a change to it fails here rather than in
    // someone's week. The board reaches 28 days back and a year forward, which
    // is exactly what the PC's own panel does. Anything older than that is not
    // shown on either machine: parity, deliberately, but worth knowing.
    const edge = store(
      task('justInside', day(-28)),
      task('justOutside', day(-29)),
      task('ancient', '1970-01-01'),
      task('farFuture', day(400)),
    );
    const shown = new Set(flatten(group(edge)));
    assert.ok(shown.has('justInside'), '28 days overdue is still listed');
    assert.ok(!shown.has('justOutside'), '29 days overdue is past the window');
    assert.ok(!shown.has('ancient'), 'and 1970 certainly is');
    assert.ok(!shown.has('farFuture'), 'a year and a bit ahead is past the window');

    // Around a month and a year boundary, tomorrow is still tomorrow.
    for (const today of ['2026-12-31', '2026-01-31', '2028-02-28']) {
      const one = store(task('t', day(1, today)));
      const res = group(one, { today });
      assert.equal(res.Tomorrow.length, 1, `tomorrow works from ${today}`);
      assert.equal(res.Upcoming.length, 0, `and is not also upcoming from ${today}`);
    }
  }

  console.log('--- 17. A LIST FILTER FOLLOWS THE PARENT, NOT THE CHILD ---');
  {
    // A subtask has no list of its own; it belongs wherever its parent does.
    // Resolving it independently would strand children in General while their
    // parent sat on Work.
    const tasks = store(
      task('parent', TODAY, { listId: 'work' }),
      task('kid', TODAY, { parentId: 'parent' }),
    );
    const work = group(tasks, { activeListId: 'work' });
    assert.deepEqual(work.Today.map(n => n.row.occId), ['parent']);
    assert.deepEqual(work.Today[0].children.map(c => c.occId), ['kid'],
      'the child came with its parent');
    assert.deepEqual(flatten(group(tasks, { activeListId: GENERAL_LIST_ID })), [],
      'and is not also on General');
  }

  console.log('--- 18. THE SAME INPUT ALWAYS GIVES THE SAME BOARD ---');
  {
    const tasks = store(
      task('a', TODAY), task('b', day(1)), task('c', day(-1)),
      task('d', null), task('e', TODAY, { completed: true, completedAt: 3 }),
      task('f', TODAY, { parentId: 'a' }),
    );
    const once = JSON.stringify(flatten(group(tasks)));
    for (let i = 0; i < 25; i += 1) {
      assert.equal(JSON.stringify(flatten(group(tasks))), once, `run ${i} matches`);
    }
  }

  console.log('\nALL PASS (taskBoard: sections, subtasks, cycles, filters, total order)');
}

main();
