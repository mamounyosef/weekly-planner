// Tests the task board's own sections: what a list is, what survives a round
// trip through the sync layer, and what happens to the tasks when one is
// deleted.
//
// WHY THIS FILE EXISTS
// These helpers had no tests at all while both the PC settings window and now
// the phone's Tasks screen were building list management on top of them. The
// dangerous ones are `coerceTaskLists`, which is the only thing standing
// between a half-written settings record and a task board with no pages, and
// `resolveListId`, which is the only reason deleting a list does not make every
// task filed under it invisible.
//
// Run with: npx tsx src/lib/taskLists.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_TASK_LISTS,
  GENERAL_LIST_ID,
  TASK_LIST_COLORS,
  coerceTaskLists,
  listIdOf,
  makeListId,
  moveList,
  nextListColor,
  resolveListId,
  type TaskList,
} from './taskLists';

const list = (id: string, name = id, color = '#3b82f6'): TaskList => ({ id, name, color });

function main() {
  console.log('--- 1. A TASK WITH NO LIST IS A GENERAL TASK ---');
  {
    // Every task that existed before lists did has no listId. It has to land
    // somewhere, or the feature arrives having hidden the whole todo list.
    assert.equal(listIdOf(undefined), GENERAL_LIST_ID);
    assert.equal(listIdOf(null), GENERAL_LIST_ID);
    assert.equal(listIdOf(''), GENERAL_LIST_ID, 'an empty string is not a list');
    assert.equal(listIdOf('work'), 'work');
  }

  console.log('--- 2. DELETING A LIST NEVER LOSES A TASK ---');
  {
    const lists = [list(GENERAL_LIST_ID, 'General'), list('work', 'Work')];

    assert.equal(resolveListId('work', lists), 'work');
    assert.equal(resolveListId(null, lists), GENERAL_LIST_ID);

    // The settings window can delete a list without touching the task store, so
    // a task can outlive the page it was filed on. It falls back rather than
    // vanishing onto a page nobody can open.
    assert.equal(resolveListId('errands', lists), GENERAL_LIST_ID, 'a deleted list falls back');

    // Even with General itself somehow missing, the answer is still an id.
    assert.equal(resolveListId('work', [list('work')]), 'work');
    assert.equal(resolveListId('gone', []), GENERAL_LIST_ID);
  }

  console.log('--- 3. TWO NEW LISTS NEVER LOOK THE SAME ---');
  {
    assert.equal(nextListColor([]), TASK_LIST_COLORS[0]);
    assert.equal(nextListColor([list('a', 'a', TASK_LIST_COLORS[0])]), TASK_LIST_COLORS[1]);

    // Case is not a difference a person can see, so it is not one here either.
    assert.equal(
      nextListColor([list('a', 'a', TASK_LIST_COLORS[0].toUpperCase())]),
      TASK_LIST_COLORS[1],
      'an upper case hex is the same colour',
    );

    // Adding lists one at a time walks the palette without repeating.
    {
      const grown: TaskList[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < TASK_LIST_COLORS.length; i += 1) {
        const colour = nextListColor(grown);
        assert.ok(!seen.has(colour), 'the palette is not repeated while it lasts');
        seen.add(colour);
        grown.push(list(`l${i}`, `l${i}`, colour));
      }
      // Past the end of the palette it wraps rather than returning nothing.
      const wrapped = nextListColor(grown);
      assert.ok(TASK_LIST_COLORS.includes(wrapped), 'still a real colour past the end');
    }
  }

  console.log('--- 4. REORDERING STOPS AT THE ENDS ---');
  {
    const lists = [list('a'), list('b'), list('c')];

    assert.deepEqual(moveList(lists, 'b', -1).map(l => l.id), ['b', 'a', 'c']);
    assert.deepEqual(moveList(lists, 'b', 1).map(l => l.id), ['a', 'c', 'b']);

    // The ends are walls, not wraps: a list dragged off the top would otherwise
    // reappear at the bottom, which reads as a bug every single time.
    assert.equal(moveList(lists, 'a', -1), lists, 'the first cannot move up');
    assert.equal(moveList(lists, 'c', 1), lists, 'the last cannot move down');
    assert.equal(moveList(lists, 'nope', 1), lists, 'an unknown id changes nothing');
    assert.equal(moveList([], 'a', 1).length, 0);

    // The input is never mutated. The array in the context is the same object
    // the merge layer holds; changing it in place would make the next diff
    // compare the new value against itself and drop the edit as "no change".
    const before = lists.map(l => l.id);
    moveList(lists, 'a', 1);
    assert.deepEqual(lists.map(l => l.id), before, 'the original is left alone');

    // Moving one out and back is the identity.
    assert.deepEqual(moveList(moveList(lists, 'a', 1), 'a', -1).map(l => l.id), before);
  }

  console.log('--- 5. THE BOARD ALWAYS HAS AT LEAST ONE PAGE ---');
  {
    // Nothing, rubbish, or an empty array all mean "this has never been set".
    for (const raw of [undefined, null, [], 'nonsense', 42, {}]) {
      const out = coerceTaskLists(raw);
      assert.deepEqual(out, DEFAULT_TASK_LISTS, `${JSON.stringify(raw)} gives the default`);
    }

    // And the default is handed out as a COPY, so a screen editing it cannot
    // rewrite the constant for everything else in the process.
    const a = coerceTaskLists(null);
    a[0].name = 'Renamed';
    assert.equal(DEFAULT_TASK_LISTS[0].name, 'General', 'the shared default is untouched');
    assert.equal(coerceTaskLists(null)[0].name, 'General');
  }

  console.log('--- 6. GENERAL IS STRUCTURAL, NOT OPTIONAL ---');
  {
    const out = coerceTaskLists([list('work', 'Work')]);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, GENERAL_LIST_ID, 'General is put back, at the front');
    assert.equal(out[1].id, 'work');

    // Already present, it is left exactly where the person put it.
    const kept = coerceTaskLists([list('work', 'Work'), list(GENERAL_LIST_ID, 'Everything else')]);
    assert.equal(kept.length, 2);
    assert.equal(kept[1].id, GENERAL_LIST_ID, 'its position is not forced');
    assert.equal(kept[1].name, 'Everything else', 'nor is its name');
  }

  console.log('--- 7. A HALF WRITTEN RECORD STILL OPENS ---');
  {
    const out = coerceTaskLists([
      { id: GENERAL_LIST_ID, name: 'General', color: '#3b82f6' },
      { id: '  work  ', name: '  Work  ', color: '  #22c55e  ' },
      { id: 'noname', color: '#f97316' },
      { id: 'blankname', name: '   ', color: '#f97316' },
      { id: 'badcolour', name: 'Bad colour', color: 'rebeccapurple' },
      { id: 'shortcolour', name: 'Short', color: '#fff' },
      { id: 'work', name: 'Duplicate work' },
      { id: '', name: 'No id' },
      { name: 'Missing id entirely' },
      null,
      undefined,
      'a string',
      7,
    ] as unknown[]);

    const ids = out.map(l => l.id);
    assert.deepEqual(ids, [GENERAL_LIST_ID, 'work', 'noname', 'blankname', 'badcolour', 'shortcolour']);

    assert.equal(out[1].id, 'work', 'ids are trimmed');
    assert.equal(out[1].name, 'Work', 'so are names');
    assert.equal(out[1].color, '#22c55e', 'and colours');

    assert.equal(out[2].name, 'Untitled list', 'a nameless list is still nameable later');
    assert.equal(out[3].name, 'Untitled list', 'whitespace is not a name');

    for (const l of out) {
      assert.ok(/^#[0-9a-fA-F]{6}$/.test(l.color), `${l.id} has a colour the grid can draw`);
      assert.equal(typeof l.name, 'string');
      assert.ok(l.name.length > 0, 'every page of the board has a label on its tab');
    }

    // A second list claiming an id already taken is dropped, not merged: two
    // pages with one id would make which tasks show depend on array order.
    assert.equal(ids.filter(id => id === 'work').length, 1, 'ids are unique');
  }

  console.log('--- 8. COERCING TWICE CHANGES NOTHING FURTHER ---');
  {
    // The settings record is coerced on every read on both machines, so a value
    // that shifts each time it is read is a value that syncs forever.
    const inputs: unknown[] = [
      null,
      [],
      [{ id: 'work', name: 'Work' }],
      [{ id: 'a', name: '', color: 'nope' }, { id: 'a', name: 'dupe' }, { id: 'b', name: 'B' }],
      [{ id: GENERAL_LIST_ID, name: 'General', color: '#123456' }],
    ];
    for (const raw of inputs) {
      const once = coerceTaskLists(raw);
      const twice = coerceTaskLists(once);
      assert.deepEqual(twice, once, `settled after one pass: ${JSON.stringify(raw)}`);
      // And through JSON, which is how it actually reaches the other machine.
      assert.deepEqual(coerceTaskLists(JSON.parse(JSON.stringify(once))), once);
    }
  }

  console.log('--- 9. A NEW ID IS READABLE, AND NEVER A COLLISION ---');
  {
    assert.match(makeListId('Work'), /^work-[a-z0-9]{4}$/);
    assert.match(makeListId('University Calendar'), /^university-calendar-[a-z0-9]{4}$/);

    // Nothing usable in the name still yields an id rather than an empty one.
    for (const name of ['', '   ', '!!!', '???', 'الصلاة']) {
      const id = makeListId(name);
      assert.match(id, /^list-[a-z0-9]{4}$/, `"${name}" still gets an id`);
    }

    // Two lists named the same can coexist, which is the whole point of the tail.
    const many = new Set(Array.from({ length: 400 }, () => makeListId('Work')));
    assert.ok(many.size > 380, 'ids for one name are spread, not shared');

    // A very long name does not produce a very long id.
    const long = makeListId('A'.repeat(200));
    assert.ok(long.length <= 24 + 5, 'the slug is capped');
    assert.match(long, /^a{24}-[a-z0-9]{4}$/);

    // Nothing generated here can ever be mistaken for General.
    for (let i = 0; i < 200; i += 1) {
      assert.notEqual(makeListId('General'), GENERAL_LIST_ID, 'a new list never becomes General');
    }

    // And every generated id survives the coercion it will be stored through.
    const made = makeListId('Errands');
    const out = coerceTaskLists([{ id: made, name: 'Errands', color: '#f97316' }]);
    assert.ok(out.some(l => l.id === made), 'a fresh id round trips');
  }

  console.log('--- 10. THE SETTINGS SCREEN SEQUENCE, END TO END ---');
  {
    // Add two lists, reorder them, rename one, delete one, exactly as the Tasks
    // settings screen does it, checking the tasks stay reachable throughout.
    let lists = coerceTaskLists(null);
    assert.equal(lists.length, 1);

    const workId = makeListId('Work');
    lists = [...lists, { id: workId, name: 'Work', color: nextListColor(lists) }];
    const studyId = makeListId('Study');
    lists = [...lists, { id: studyId, name: 'Study', color: nextListColor(lists) }];
    assert.equal(lists.length, 3);
    assert.notEqual(lists[1].color, lists[2].color);

    lists = moveList(lists, studyId, -1);
    assert.deepEqual(lists.map(l => l.id), [GENERAL_LIST_ID, studyId, workId]);

    lists = lists.map(l => (l.id === workId ? { ...l, name: 'Work and admin' } : l));
    assert.equal(lists.find(l => l.id === workId)?.name, 'Work and admin');

    // A task on each page, then Study is deleted.
    const tasks = [
      { id: 't1', listId: undefined as string | undefined },
      { id: 't2', listId: workId },
      { id: 't3', listId: studyId },
    ];
    lists = lists.filter(l => l.id !== studyId);
    const placed = tasks.map(t => resolveListId(t.listId, lists));
    assert.deepEqual(placed, [GENERAL_LIST_ID, workId, GENERAL_LIST_ID]);
    assert.equal(placed.length, tasks.length, 'no task was dropped on the floor');

    // And the whole thing still survives the trip to the other machine.
    assert.deepEqual(coerceTaskLists(JSON.parse(JSON.stringify(lists))), lists);
  }

  console.log('\nALL PASS (taskLists: pages of the board, and the tasks that outlive them)');
}

main();
